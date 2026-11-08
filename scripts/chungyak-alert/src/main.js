import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { collectApplyhome, createModelLookup } from './sources/applyhome.js';
import { collectLh } from './sources/lh.js';
import { createAptInfoClient } from './sources/apt-info.js';
import { createMolitClient, createPresaleClient } from './sources/molit.js';
import { STATUS, evaluateLotto, keepPreviousLotto } from './lotto.js';
import { restrictedType } from './market-estimate.js';
import { computeSequenceNumbers, createNotionStore } from './notion-store.js';
import { buildErrorMail, buildUrgentMail, buildWeeklyMail, createGmailSender } from './notify-gmail.js';
import { buildKakaoText, linkFor, sendKakaoMemo } from './notify-kakao.js';
import { parseProfile } from './recommend.js';
import {
  decodeServiceKey,
  defaultSleep,
  kstToday,
  maskServiceKey,
  maskValue,
  safeError,
  safeHttpUrl,
  weekRange,
  weekdayOf,
} from './util.js';

const MODES = {
  normal: [],
  'dry-run': ['--dry-run'],
  'force-weekly': ['--force-weekly'],
  'test-send': ['--test-send'],
  'cleanup-ended': ['--cleanup-ended'],
};

// 잡 제한 시간은 15분이다.
const SEQUENCE_BUDGET_MS = 10 * 60 * 1000;

export const SOURCES = [
  '청약홈 분양정보 조회 서비스 (data.go.kr 15098547): 사용',
  '국토부 아파트 매매 실거래가 (data.go.kr 15126469): 시세 추정에 사용',
  '국토부 아파트 분양권전매 실거래가 (data.go.kr 15126471): 같은 단지 시세와 비교 단지에 사용',
  '국토부 공동주택 단지 목록 (data.go.kr 15057332)과 기본 정보 (15058453): 비교 단지의 지하철역 거리에 사용',
  'LH 임대공고 조회: 저장만 사용, 날짜가 없으면 알림 제외',
  'SH·GH 공고: v2 예정',
];

export function parseFlags(argv, env) {
  const mode = env.CHUNGYAK_MODE || 'normal';
  if (!Object.hasOwn(MODES, mode)) return null;
  const args = new Set([...argv, ...MODES[mode]]);
  const print = args.has('--print') && !env.GITHUB_ACTIONS;
  return {
    // --print는 조회 전용이다.
    dryRun: args.has('--dry-run') || print,
    print,
    forceWeekly: args.has('--force-weekly'),
    testSend: args.has('--test-send'),
    cleanupEnded: args.has('--cleanup-ended'),
  };
}

export function isActive(notice, today) {
  return !notice.overallEnd || notice.overallEnd >= today;
}

// Notion에 없는 공고 중 접수가 끝난 것은 저장하지 않는다. 날짜가 있으면 날짜를 우선한다.
export function isClosedNotice(notice, today) {
  if (notice.overallEnd) return notice.overallEnd < today;
  return notice.kind === 'lh' && /마감|종료/.test(notice.noticeStatus ?? '');
}

export function dedupeNotices(notices) {
  const seen = new Map();
  for (const notice of notices) if (!seen.has(notice.key)) seen.set(notice.key, notice);
  return [...seen.values()];
}

export function selectUrgent(records, today, alertRegions) {
  const selected = [];
  for (const record of records) {
    if (record.status !== STATUS.LOTTO) continue;
    if (!alertRegions.includes(record.notice.region)) continue;
    if (record.urgentDate === today) continue;
    const stage = record.notice.stages.find((item) => item.start === today);
    if (stage) selected.push({ ...record, stage });
  }
  return selected;
}

// buildProperties처럼 값이 없으면 저장된 값을 둔다. 체크와 발송일은 Notion 행의 값이다.
function overlayNotice(row, notice) {
  return {
    ...row,
    start: notice.overallStart || row.start,
    end: notice.overallEnd || row.end,
    name: notice.name || row.name,
    link: safeHttpUrl(notice.url) ?? row.link,
  };
}

// 실행 시작 때 읽은 Notion 행에 이번 실행의 원본 값을 덮어 고른다. 지역과 로또 여부는 보지 않는다.
// handledKeys는 이번 실행에서 로또 알림 대상이 된 공고로, 하루 한 건만 보내기 위해 뺀다.
// 추천 접수일이 있으면 그날, 없으면 접수 시작일에 보낸다.
export function selectInterest(rows, today, handledKeys = new Set()) {
  return rows
    .filter((row) => row.interest && (row.recommendDate ?? row.start) === today && row.urgentDate !== today && !handledKeys.has(row.key))
    .map((row) => {
      const recommended = Boolean(row.recommendDate);
      const start = recommended ? row.recommendDate : row.start;
      const end = recommended ? row.recommendEnd : row.end;
      return {
        notice: { key: row.key, name: row.name || row.key, url: linkFor(row.link) },
        // 저장된 종료일이 시작일보다 이르면 지난 값이므로 표시하지 않는다.
        stage: { name: recommended && row.recommendTrack ? row.recommendTrack : '접수', start, end: end && end >= start ? end : null },
        recommended,
        pageId: row.id,
      };
    });
}

// 이번 실행에서 계산한 추천으로 관심 행을 덮는다. 프로필이 없으면 저장된 값을 그대로 둔다.
function overlayRecommendation(row, evaluation) {
  if (!evaluation || evaluation.recommendation === undefined) return row;
  const recommendation = evaluation.recommendation;
  return {
    ...row,
    recommendTrack: recommendation?.track ?? null,
    recommendDate: recommendation?.date ?? null,
    recommendEnd: recommendation?.end ?? null,
  };
}

export function shouldSendWeekly(today, lastMonday, force = false) {
  if (force) return true;
  const weekday = weekdayOf(today);
  return weekday >= 1 && weekday <= 3 && lastMonday !== weekRange(today).monday;
}

export function selectWeekly(records, monday, sunday, alertRegions) {
  const items = [];
  for (const record of records) {
    if (!alertRegions.includes(record.notice.region)) continue;
    const weekStages = record.notice.stages
      .filter((stage) => stage.start <= sunday && (stage.end ?? stage.start) >= monday)
      .sort((a, b) => a.start.localeCompare(b.start));
    if (weekStages.length > 0) items.push({ notice: record.notice, status: record.status, weekStages });
  }
  return items.sort((a, b) => a.weekStages[0].start.localeCompare(b.weekStages[0].start));
}

// 이번 실행에서 판정하지 않은 공고의 상태. 제한 유형은 이전 로또 기록을 되살리지 않는다.
function carriedStatus(notice, previous, config) {
  if (restrictedType(notice, config.market)) return STATUS.OUT_OF_SCOPE;
  return previous?.lotto ?? null;
}

const tagCounts = (stats) => Object.entries(stats).filter(([, value]) => typeof value === 'number').map(([name, value]) => `${name}=${value}`).join(' ');

// 국토부 법정동 이름의 형식별 행 수. 읍·면이 앞에 붙은 형식(umd_town)인지, 리만 있는 형식(umd_village)인지 실실행에서 확인한다.
const umdFormatCounts = (...all) => ['town', 'village', 'dong', 'other']
  .map((format) => `umd_${format}=${all.reduce((sum, stats) => sum + stats.umdFormats[format], 0)}`)
  .join(' ');

function readAccessToken(env) {
  const file = env.KAKAO_ACCESS_FILE;
  if (!file || !existsSync(file)) return null;
  return readFileSync(file, 'utf8').trim() || null;
}

function loadConfig() {
  return JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
}

async function runTestSend({ sendMail, sendKakao, today, log }) {
  const { monday, sunday } = weekRange(today);
  const sample = {
    name: '테스트 공고 (실제 공고 아님)',
    typeLabel: 'APT',
    region: '서울',
    url: 'https://www.applyhome.co.kr',
  };
  const stage = { name: '1순위 해당', start: today, end: today };
  let failed = false;
  try {
    await sendMail(buildWeeklyMail({
      items: [{ notice: sample, status: STATUS.LOTTO, weekStages: [stage] }],
      monday,
      sunday,
      testMark: true,
    }));
    log('test-send mail ok');
  } catch (error) {
    failed = true;
    log(`test-send mail failed: ${safeError(error)}`);
  }
  try {
    await sendKakao({
      text: buildKakaoText({ notice: sample, stage, reason: '[테스트] 발송 확인용' }),
      url: sample.url,
    });
    log('test-send kakao ok');
  } catch (error) {
    failed = true;
    log(`test-send kakao failed: ${safeError(error)}`);
  }
  return failed ? 1 : 0;
}

// 저장된 접수 종료일이 오늘(KST) 이전인 페이지만 대상이다. 종료일이 없거나 오늘 이후면 남긴다.
function splitEndedPages(pages, today) {
  const ended = pages.filter((page) => page.end && page.end < today);
  return { ended, kept: pages.length - ended.length };
}

async function archivePages(store, pages, onFailure = () => {}) {
  let archived = 0;
  let failed = 0;
  for (const page of pages) {
    try {
      await store.archivePage(page.id);
      archived += 1;
    } catch (error) {
      failed += 1;
      onFailure(error);
    }
  }
  return { archived, failed };
}

// 번호가 바뀐 행만 고친다. 표시용 열이므로 첫 실패나 시간 초과에서 멈추고 다음 실행에 맡긴다.
async function applySequenceNumbers(store, { deadline, now, onFailure }) {
  let changed;
  try {
    store.checkSequenceProperty();
    changed = computeSequenceNumbers([...(await store.loadExisting()).values()])
      .filter((row) => row.sequence !== row.number);
  } catch (error) {
    onFailure(error);
    return { updated: 0, skipped: 0 };
  }
  let updated = 0;
  for (const row of changed) {
    if (now().getTime() >= deadline) return { updated, skipped: changed.length - updated };
    try {
      await store.setSequenceNumber(row.id, row.number);
      updated += 1;
    } catch (error) {
      onFailure(error);
      break;
    }
  }
  return { updated, skipped: 0 };
}

// 수동 전용 정리 모드.
async function runCleanupEnded({ store, today, dryRun, log }) {
  let pages;
  try {
    if (!store) throw new Error('store unavailable');
    await store.init({ createMissing: false });
    pages = [...(await store.loadExisting()).values()];
  } catch {
    log('cleanup archived=0 kept=0 failed=1');
    return 1;
  }
  const { ended, kept } = splitEndedPages(pages, today);
  if (dryRun) {
    log(`cleanup dry-run candidates=${ended.length} kept=${kept}`);
    return 0;
  }
  const { archived, failed } = await archivePages(store, ended);
  log(`cleanup archived=${archived} kept=${kept} failed=${failed}`);
  return failed > 0 ? 1 : 0;
}

export async function run({ argv = [], env = process.env, deps = {} } = {}) {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? ((line) => console.log(line));
  const write = deps.write;
  const config = deps.config ?? loadConfig();
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const today = kstToday(startedAt);

  const flags = parseFlags(argv, env);
  if (!flags) {
    log('invalid mode');
    return 1;
  }

  if (flags.cleanupEnded) {
    if (env.GITHUB_EVENT_NAME === 'schedule') {
      log('cleanup refused on schedule');
      return 1;
    }
    const canCreate = env.NOTION_KEY && env.CHUNGYAK_NOTION_PAGE_ID;
    const store = deps.store ?? (canCreate
      ? createNotionStore({
        key: env.NOTION_KEY,
        parentPageId: env.CHUNGYAK_NOTION_PAGE_ID,
        config,
        sources: SOURCES,
        fetch: fetchFn,
        sleep,
      })
      : null);
    return runCleanupEnded({ store, today, dryRun: flags.dryRun, log });
  }

  const dataKey = decodeServiceKey(env.DATA_GO_KR_KEY);
  maskServiceKey(env.DATA_GO_KR_KEY, env, write);
  maskServiceKey(dataKey, env, write);
  const accessToken = deps.accessToken !== undefined ? deps.accessToken : readAccessToken(env);
  maskValue(accessToken, env, write);
  // 프로필은 공개 로그와 Notion 어디에도 적지 않는다.
  maskValue(env.CHUNGYAK_PROFILE, env, write);
  const { profile, status: profileStatus } = parseProfile(env.CHUNGYAK_PROFILE);

  const sendMail = deps.sendMail ?? createGmailSender({
    user: env.GMAIL_USER,
    password: env.GMAIL_APP_PASSWORD,
    to: env.MAIL_TO,
  });
  const sendKakao = deps.sendKakao ?? (({ text, url }) => sendKakaoMemo({ token: accessToken, text, url, fetch: fetchFn, sleep }));

  if (flags.testSend) return runTestSend({ sendMail, sendKakao, today, log });

  const errors = new Map();
  const addError = (kind) => errors.set(kind, (errors.get(kind) ?? 0) + 1);
  // 오류 메일 없이 로그에만 건수를 남기는 항목이다. 분양권·공동주택 API 미승인, 태그나 단지명 불일치 등이다.
  const softErrors = new Map();
  const addSoftError = (kind) => softErrors.set(kind, (softErrors.get(kind) ?? 0) + 1);
  // 같은 장애가 공고마다 반복되어도 한 번만 센다.
  const addSoftErrorOnce = (kind) => {
    if (!softErrors.has(kind)) addSoftError(kind);
  };
  let notionFailed = false;
  let applyhomeResult = { notices: [], errors: [], failedAll: true };
  let lhNotices = [];
  let urgentLost = false;

  if (dataKey) {
    applyhomeResult = await collectApplyhome({
      fetch: fetchFn,
      key: dataKey,
      today,
      lookbackDays: config.lookbackDays,
      sleep,
    });
    applyhomeResult.errors.forEach(addError);
    try {
      lhNotices = await collectLh({
        fetch: fetchFn,
        key: dataKey,
        today,
        lookbackDays: config.lookbackDays,
        lookaheadDays: config.lh.lookaheadDays,
        excludeKeywords: config.lh.excludeTypeKeywords,
        sleep,
      });
    } catch (error) {
      addError(safeError(error));
    }
  } else {
    addError('data_key_missing');
  }
  const notices = dedupeNotices([...applyhomeResult.notices, ...lhNotices]);

  if (!flags.dryRun && !accessToken) addError('kakao_access_token_missing');
  if (env.KAKAO_SECRET_WRITE_OUTCOME === 'failure') addError('kakao_secret_write_failed');

  let store = null;
  let existing = new Map();
  // dry-run은 관심 후보를 세려고 읽기만 한다. 저장과 판별이 일반 실행처럼 되지 않도록 existing과 store에 넣지 않는다.
  let dryRunRows = null;
  if (flags.dryRun) {
    if (deps.store || (env.NOTION_KEY && env.CHUNGYAK_NOTION_PAGE_ID)) {
      try {
        const reader = deps.store ?? createNotionStore({
          key: env.NOTION_KEY,
          parentPageId: env.CHUNGYAK_NOTION_PAGE_ID,
          config,
          sources: SOURCES,
          fetch: fetchFn,
          sleep,
        });
        await reader.init({ createMissing: false });
        dryRunRows = await reader.loadExisting();
      } catch (error) {
        addError(safeError(error));
      }
    }
  } else {
    try {
      if (!env.NOTION_KEY || !env.CHUNGYAK_NOTION_PAGE_ID) throw Object.assign(new Error(), { code: 'NOTION_ENV_MISSING' });
      store = deps.store ?? createNotionStore({
        key: env.NOTION_KEY,
        parentPageId: env.CHUNGYAK_NOTION_PAGE_ID,
        config,
        sources: SOURCES,
        fetch: fetchFn,
        sleep,
      });
      await store.init();
      store.schemaIssues?.().forEach(addError);
      existing = await store.loadExisting();
    } catch (error) {
      notionFailed = true;
      store = null;
      addError(safeError(error));
    }
  }

  const counts = { evaluated: 0, created: 0, updated: 0, skipped: 0, urgent: 0, interest: 0, urgentMailFallback: 0, weekly: 0, archived: 0, sequenced: 0, lotto_demoted: 0 };
  const records = [];

  const molit = createMolitClient({ fetch: fetchFn, key: dataKey, sleep });
  const presale = createPresaleClient({ fetch: fetchFn, key: dataKey, sleep, now, budgetMs: config.market.presale.budgetMs, onSoft: addSoftError });
  const aptInfo = createAptInfoClient({ fetch: fetchFn, key: dataKey, sleep, now, limits: config.market.aptInfo, onSoft: addSoftError });
  const recommendCounts = { recommended: 0, none: 0 };
  const marketCounts = { complexOutliers: 0, stationUsed: 0, stationNoInput: 0, stationNoData: 0, 상: 0, 중: 0, 하: 0 };
  const stationCountNames = { used: 'stationUsed', noInput: 'stationNoInput', noData: 'stationNoData' };
  const getModels = createModelLookup({ fetch: fetchFn, key: dataKey, sleep });
  const interestRows = new Map(dryRunRows ?? existing);
  for (const notice of notices) {
    // 저장 대상 행은 원본의 최신 값으로 판단한다. 저장이 실패해도 같다. 로또 알림과 같은 기준이고, 옮겨진 날짜로 잘못 보내거나 놓치지 않는다.
    // 접수가 끝나 갱신하지 않는 행은 읽은 그대로 둔다. 이번 실행에 새로 만든 행은 아직 체크될 수 없어 넣지 않는다.
    const row = interestRows.get(notice.key);
    if (row && !(row.end && row.end < today)) interestRows.set(notice.key, overlayNotice(row, notice));
    const previous = existing.get(notice.key);
    if (!previous && isClosedNotice(notice, today)) {
      counts.skipped += 1;
      continue;
    }
    if (previous?.end && previous.end < today) {
      counts.skipped += 1;
      records.push({ notice, status: carriedStatus(notice, previous, config), urgentDate: previous.urgentDate, pageId: previous.id });
      continue;
    }
    let evaluation = null;
    if (isActive(notice, today)) {
      try {
        evaluation = await evaluateLotto(notice, {
          config,
          today,
          getModels,
          getTrades: (code, months) => molit.getTrades(code, months),
          getPresale: (code, months) => presale.getTrades(code, months),
          aptInfo,
          // dry-run은 저장 대상에 넣지 않은 읽기 전용 행에서 입력을 읽는다.
          walkMinutes: (previous ?? dryRunRows?.get(notice.key))?.walkMinutes ?? null,
          onError: addError,
          onSoft: addSoftError,
          onSoftOnce: addSoftErrorOnce,
          profile,
        });
      } catch (error) {
        addError(safeError(error));
        evaluation = { status: STATUS.UNDETERMINED, reason: '판별 실패' };
      }
      // dry-run도 읽어 둔 행의 이전 상태로 같은 보호를 적용해 일반 실행과 건수가 같게 한다.
      evaluation = keepPreviousLotto(evaluation, (previous ?? dryRunRows?.get(notice.key))?.lotto);
      counts.evaluated += 1;
      if (evaluation.confidence) marketCounts[evaluation.confidence] += 1;
      if (evaluation.stationState) marketCounts[stationCountNames[evaluation.stationState]] += 1;
      if (evaluation.recommendation) recommendCounts.recommended += 1;
      else if (evaluation.recommendation === null) recommendCounts.none += 1;
      const interestRow = interestRows.get(notice.key);
      if (interestRow && !(interestRow.end && interestRow.end < today)) interestRows.set(notice.key, overlayRecommendation(interestRow, evaluation));
      marketCounts.complexOutliers += evaluation.complexOutliers ?? 0;
      // 계산 방식이 바뀌어 로또에서 빠진 공고가 몇 건인지 건수만 남긴다. dry-run은 읽어 둔 행으로 센다.
      const stored = previous ?? dryRunRows?.get(notice.key);
      if (stored?.lotto === STATUS.LOTTO && [STATUS.NOT, STATUS.OUT_OF_SCOPE].includes(evaluation.status)) counts.lotto_demoted += 1;
    }
    const record = {
      notice,
      status: evaluation?.status ?? carriedStatus(notice, previous, config),
      reason: evaluation?.reason ?? null,
      // 카카오톡은 200자라 비교 단지 목록이 없는 짧은 근거를 쓴다. 메일 대체 발송도 같은 문구다.
      shortReason: evaluation?.shortReason ?? evaluation?.reason ?? null,
      urgentDate: previous?.urgentDate ?? null,
      pageId: previous?.id ?? null,
    };
    if (store) {
      try {
        record.pageId = await store.upsert(notice, evaluation, previous, today);
        counts[previous ? 'updated' : 'created'] += 1;
      } catch (error) {
        notionFailed = true;
        record.pageId = previous?.id ?? null;
        addError(safeError(error));
      }
    }
    records.push(record);
  }

  // 주간 메일은 발송 기록이 필요해 Notion이 정상일 때만 보낸다.
  let weeklyDone = false;
  if (store) {
    weeklyDone = await sendWeekly({ records, store, sendMail, config, today, flags, applyhomeResult, addError, counts, markNotionFailed: () => { notionFailed = true; } });
  }

  if (!flags.dryRun) {
    const alertContext = {
      store,
      sendKakao,
      sendMail,
      today,
      addError,
      counts,
      markLost: () => { urgentLost = true; },
      markNotionFailed: () => { notionFailed = true; },
    };
    // 긴급 알림은 놓치는 쪽이 더 나쁘므로 기록할 곳이 없어도 보낸다. 다음 실행과 중복될 수 있다.
    const urgent = selectUrgent(records, today, config.alertRegions);
    for (const record of urgent) {
      const text = buildKakaoText({ notice: record.notice, stage: record.stage, reason: record.shortReason ?? record.reason });
      await deliverAlert(record, text, 'urgent', alertContext);
    }
    // 발송 실패가 실제로는 전달됐을 수 있어, 로또 쪽이 실패한 공고도 이번 실행에서 다시 보내지 않는다.
    const handledKeys = new Set(urgent.map((record) => record.notice.key));
    for (const record of selectInterest([...interestRows.values()], today, handledKeys)) {
      const text = buildKakaoText({ notice: record.notice, stage: record.stage, prefix: '[관심 청약]', verb: record.recommended ? '오늘 접수' : '오늘 시작' });
      await deliverAlert(record, text, 'interest', alertContext);
    }
  }

  // 주간 메일과 발송 기록이 끝난 실행에서만 정리한다. 긴급 알림 뒤에 두어 발송과 기록을 막지 않는다.
  if (weeklyDone) {
    const { ended } = splitEndedPages([...existing.values()], today);
    const { archived, failed } = await archivePages(store, ended, (error) => {
      addError('cleanup_failed');
      addError(safeError(error));
    });
    counts.archived = archived;
    if (failed > 0) notionFailed = true;
  }

  // 순번은 모든 쓰기가 끝난 뒤 다시 읽어 매긴다. dry-run은 store가 null이라 여기 오지 않는다.
  // 표시용 열이라 실패해도 오류 메일만 보내고 잡을 실패시키지 않는다.
  if (store && !notionFailed) {
    const { updated, skipped } = await applySequenceNumbers(store, {
      deadline: startedAt.getTime() + SEQUENCE_BUDGET_MS,
      now,
      onFailure: (error) => {
        addError('sequence_failed');
        addError(safeError(error));
      },
    });
    counts.sequenced = updated;
    if (skipped > 0) log(`sequence_skipped=${skipped}`);
  }

  if (flags.dryRun) {
    const lotto = records.filter((record) => record.status === STATUS.LOTTO).length;
    const urgent = selectUrgent(records, today, config.alertRegions);
    // Notion을 읽지 못한 dry-run은 후보를 알 수 없어 건수를 남기지 않는다.
    const interest = dryRunRows
      ? ` interest_candidates=${selectInterest([...interestRows.values()], today, new Set(urgent.map((record) => record.notice.key))).length}`
      : '';
    log(`dry-run lotto=${lotto} urgent_candidates=${urgent.length}${interest}`);
  }
  if (flags.print) {
    for (const { notice, status } of records) {
      log(`${status ?? '-'} | ${notice.region ?? '-'} | ${notice.typeLabel} | ${notice.name} | ${notice.overallStart ?? '-'} ~ ${notice.overallEnd ?? '-'}`);
    }
  }

  log(`collected=${notices.length} ${Object.entries(counts).map(([name, value]) => `${name}=${value}`).join(' ')}`);
  log(`errors=${[...errors].map(([kind, count]) => `${kind}:${count}`).join(',') || 'none'}`);
  log(`market apt_calls=${aptInfo.stats().calls} station_used=${marketCounts.stationUsed} station_no_input=${marketCounts.stationNoInput} station_no_data=${marketCounts.stationNoData} complex_outliers=${marketCounts.complexOutliers} confidence_high=${marketCounts.상} confidence_mid=${marketCounts.중} confidence_low=${marketCounts.하} ${umdFormatCounts(molit.stats(), presale.stats())} soft=${[...softErrors].map(([kind, count]) => `${kind}:${count}`).join(',') || 'none'}`);
  // 추천 기능 상태와 건수만 남긴다. 프로필 내용은 남기지 않는다.
  log(`recommend profile=${profileStatus} recommended=${recommendCounts.recommended} none=${recommendCounts.none}`);
  log(`trade_tags ${tagCounts(molit.stats())}`);
  log(`presale_tags ${tagCounts(presale.stats())}`);
  log(`sale_tag_names=${molit.tagNames()}`);
  log(`presale_tag_names=${presale.tagNames()}`);
  log(`apt_tags ${tagCounts(aptInfo.tags())} bands=${aptInfo.bandCounts()}`);

  let summaryFailed = false;
  if (errors.size > 0 && !flags.dryRun) {
    try {
      await sendMail(buildErrorMail(errors, today));
    } catch (error) {
      summaryFailed = true;
      log(`error summary mail failed: ${safeError(error)}`);
    }
  }

  const fail = notionFailed
    || applyhomeResult.failedAll
    || urgentLost
    || env.KAKAO_SECRET_WRITE_OUTCOME === 'failure'
    || summaryFailed;
  return fail ? 1 : 0;
}

// 카카오로 보내고, 실패하면 메일로 대신 보낸 뒤 발송일을 기록한다. 로또와 관심 알림이 함께 쓴다.
async function deliverAlert({ notice, pageId, reason }, text, countName, { store, sendKakao, sendMail, today, addError, counts, markLost, markNotionFailed }) {
  let sent = false;
  try {
    await sendKakao({ text, url: notice.url });
    sent = true;
    counts[countName] += 1;
  } catch (error) {
    addError(safeError(error));
    try {
      // 메일은 길이 제한이 없어 비교 단지 목록이 있는 전체 근거를 함께 보낸다.
      await sendMail(buildUrgentMail({ notice, text, url: notice.url, reason }));
      sent = true;
      counts[countName] += 1;
      counts.urgentMailFallback += 1;
    } catch (mailError) {
      addError(safeError(mailError));
    }
  }
  if (!sent) {
    markLost();
    addError('urgent_lost');
  } else if (store && pageId) {
    try {
      await store.stampUrgent(pageId, today);
    } catch (error) {
      markNotionFailed();
      addError(safeError(error));
      addError('urgent_sent_without_stamp');
    }
  } else {
    addError('urgent_sent_without_stamp');
  }
}

async function sendWeekly({ records, store, sendMail, config, today, flags, applyhomeResult, addError, counts, markNotionFailed }) {
  let lastMonday;
  try {
    lastMonday = await store.getWeeklyState();
  } catch (error) {
    markNotionFailed();
    addError(safeError(error));
    return false;
  }
  if (!shouldSendWeekly(today, lastMonday, flags.forceWeekly)) return false;
  // 청약홈이 일부라도 실패하면 수요일 또는 강제 실행 전까지 다음 실행으로 미룬다.
  const partial = applyhomeResult.errors.length > 0;
  if (applyhomeResult.failedAll || (partial && weekdayOf(today) !== 3 && !flags.forceWeekly)) {
    addError('weekly_deferred');
    return false;
  }
  const { monday, sunday } = weekRange(today);
  const items = selectWeekly(records, monday, sunday, config.alertRegions);
  const warning = partial ? '일부 청약홈 조회가 실패해 누락이 있을 수 있습니다.' : null;
  try {
    await sendMail(buildWeeklyMail({ items, monday, sunday, warning }));
    counts.weekly += 1;
  } catch (error) {
    addError(safeError(error));
    return false;
  }
  try {
    await store.setWeeklyState(monday);
  } catch (error) {
    markNotionFailed();
    addError(safeError(error));
    return false;
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ argv: process.argv.slice(2) }).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.log(`fatal: ${safeError(error)}`);
      process.exitCode = 1;
    },
  );
}
