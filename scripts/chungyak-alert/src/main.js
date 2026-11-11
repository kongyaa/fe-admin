import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { collectApplyhome, createModelLookup } from './sources/applyhome.js';
import { collectLh } from './sources/lh.js';
import { createLhDetailClient } from './sources/lh-detail.js';
import { createShapeLog, enrichLhNotices, formatShapeLine } from './lh-detail-map.js';
import { createAptInfoClient } from './sources/apt-info.js';
import { createMolitClient, createPresaleClient } from './sources/molit.js';
import { STATUS, evaluateLotto, keepPreviousLotto } from './lotto.js';
import { restrictedType } from './market-estimate.js';
import { createFactLookup } from './price-facts.js';
import { selectStatusUpdates } from './reception.js';
import { createNotionStore } from './notion-store.js';
import { buildErrorMail, buildUrgentMail, buildWeeklyMail, createGmailSender } from './notify-gmail.js';
import { buildKakaoText, linkFor, sendKakaoMemo } from './notify-kakao.js';
import { parseProfile } from './recommend.js';
import { isRental } from './rental.js';
import { cleanupExceeded, cleanupLimits, emptyScopeCounts, splitDuplicates, splitTableScope, tableRegionsInvalid } from './table-scope.js';
import { formatLhTypes, isLhItem, isUnknownLhRegion, isUnknownLhType, lhRegionLogLabel, lhScopeRule, lhTypeLogLabel, lhTypeRule, storedLhScopeRule } from './lh-scope.js';
import {
  decodeServiceKey,
  defaultSleep,
  kstToday,
  maskServiceKey,
  maskLines,
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

export const SOURCES = [
  '청약홈 분양정보 조회 서비스 (data.go.kr 15098547): 사용',
  '국토부 아파트 매매 실거래가 (data.go.kr 15126469): 시세 추정에 사용',
  '국토부 아파트 분양권전매 실거래가 (data.go.kr 15126471): 같은 단지 시세와 비교 단지에 사용',
  '국토부 공동주택 단지 목록 (data.go.kr 15057332)과 기본 정보 (15058453): 비교 단지의 지하철역 거리에 사용',
  'LH 임대공고 조회: 분양 공고 중 서울과 지정 지구만 저장, 날짜가 없으면 알림 제외',
  'LH 분양임대공고별 상세정보·공급정보 조회: LH 분양 공고의 접수 일정, 주택형, 단지 주소와 로또 판별에 사용',
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

// LH 범위 밖 공고(분양이 아니거나 대상 지역 밖, src/lh-scope.js)를 가른다. 청약홈 공고는 그대로 둔다.
// 관심을 체크한 행이 있는 공고는 빼지 않고 보통 공고처럼 다룬다. 관심 여부는 실행 시작 때 읽은 값이다.
// 옮길 행은 이번 실행에 범위 밖으로 빠진 공고의 행과, 이번 실행에 수집되지 않았고 저장된 값으로 범위 밖인 행이다.
// 이번 실행에 수집되어 남은 공고의 행은 저장된 값으로 다시 판정하지 않는다(옮겼다가 다시 만들지 않게). 관심 행은 남기고 센다.
// saleRegions는 유형 규칙을 통과한 LH 공고의 공급지역별 건수다(지역 규칙 전, lh_sale_regions 로그).
export function splitLhScope(notices, rows, config) {
  const counts = { lh_out_of_scope_skipped: 0, lh_out_of_scope_type: 0, lh_out_of_scope_area: 0, lh_out_of_scope_archived: 0, lh_out_of_scope_kept_interest: 0, lh_type_unknown: 0, lh_region_unknown: 0 };
  const outKeys = new Set();
  const keptKeys = new Set();
  const kept = [];
  const saleRegions = new Map();
  for (const notice of notices) {
    if (isLhItem(notice) && !lhTypeRule(notice, config.lh ?? {})) {
      const label = lhRegionLogLabel(notice.region);
      saleRegions.set(label, (saleRegions.get(label) ?? 0) + 1);
    }
    // 모르는 유형과 빈 공급지역은 빼지 않는다. 건수만 남긴다.
    if (isUnknownLhType(notice, config)) counts.lh_type_unknown += 1;
    if (isUnknownLhRegion(notice, config)) counts.lh_region_unknown += 1;
    const reason = lhScopeRule(notice, config);
    if (reason) outKeys.add(notice.key);
    else keptKeys.add(notice.key);
    if (!reason || rows.get(notice.key)?.interest) {
      kept.push(notice);
      continue;
    }
    counts.lh_out_of_scope_skipped += 1;
    counts[`lh_out_of_scope_${reason}`] += 1;
  }
  const archiveRows = [];
  // 이 정리가 다룬 키(범위 밖 공고와 행). 뒤 단계(표 범위, src/table-scope.js)가 같은 행을 다시 세거나 옮기지 않게 알려 준다.
  const claimedKeys = new Set(outKeys);
  for (const row of rows.values()) {
    if (keptKeys.has(row.key)) continue;
    if (!outKeys.has(row.key) && !storedLhScopeRule(row, config)) continue;
    claimedKeys.add(row.key);
    if (row.interest) counts.lh_out_of_scope_kept_interest += 1;
    else archiveRows.push(row);
  }
  return { notices: kept, archiveRows, counts, saleRegions, claimedKeys };
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
    if (weekStages.length > 0) {
      items.push({
        notice: record.notice,
        status: record.status,
        weekStages,
        // 확인 필요 항목을 주간 메일에 적는 데 쓴다. 이번 실행에서 판정하지 않은 공고는 값이 없다.
        marginRate: record.marginRate ?? null,
        confidence: record.confidence ?? null,
        checkNote: record.checkNote ?? null,
      });
    }
  }
  return items.sort((a, b) => a.weekStages[0].start.localeCompare(b.weekStages[0].start));
}

// 이번 실행에서 판정하지 않은 공고의 상태. 제한 유형은 이전 로또 기록을 되살리지 않는다.
function carriedStatus(notice, previous, config) {
  if (restrictedType(notice, config.market)) return STATUS.OUT_OF_SCOPE;
  return previous?.lotto ?? null;
}

// 접수 상태 갱신의 기본 상한(config market.statusUpdateMax)과 멈추는 연속 실패 횟수.
const STATUS_UPDATE_MAX = 150;
const STATUS_FAIL_STREAK = 3;

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
  const done = [];
  for (const page of pages) {
    try {
      await store.archivePage(page.id);
      archived += 1;
      done.push(page.id);
    } catch (error) {
      failed += 1;
      onFailure(error);
    }
  }
  return { archived, failed, done };
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
  maskLines(env.CHUNGYAK_PROFILE, env, write);
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
  // LH 유형 값별 원본 행 수. 유형 값이 실응답으로 확인되지 않아 매 실행 로그로 본다.
  const lhTypeCounts = new Map();
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
        // LH 범위 기능이 꺼져 있으면 예전처럼 토지임대부도 토지 제외에 걸린다.
        keepKeywords: config.lh.filterSaleArea ? (config.lh.forceSaleKeywords ?? []) : [],
        sleep,
        onRow: (row) => {
          const label = lhTypeLogLabel(row);
          lhTypeCounts.set(label, (lhTypeCounts.get(label) ?? 0) + 1);
        },
      });
    } catch (error) {
      addError(safeError(error));
    }
  } else {
    addError('data_key_missing');
  }
  const collected = dedupeNotices([...applyhomeResult.notices, ...lhNotices]);
  // 임대 공고는 판별과 저장 전에 뺀다(config.excludeRental). 건수만 남긴다.
  const notices = collected.filter((notice) => !isRental(notice, config));
  const rentalSkipped = collected.length - notices.length;

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
  // 이미 저장된 임대 행은 이번 실행에서 다루지 않고 알림 뒤에 휴지통으로 옮긴다. 관심 체크도 예외가 아니다.
  // 이번 실행에 임대로 빠진 공고의 행은 저장된 유형과 관계없이 옮긴다.
  // 이번 실행에 수집되어 남은(임대가 아닌) 공고의 행은 저장된 값으로 다시 보지 않는다. 낡은 유형 때문에 옮겼다가 다시 만들지 않게 한다.
  // 저장된 행 수. 한 번에 옮길 행 수의 상한(비율)을 잴 때 쓴다.
  const storedTotal = (dryRunRows ?? existing).size;
  const rentalKeys = new Set(collected.filter((notice) => isRental(notice, config)).map((notice) => notice.key));
  const rentalKeptKeys = new Set(notices.map((notice) => notice.key));
  const rentalRows = [...(dryRunRows ?? existing).values()].filter((row) => rentalKeys.has(row.key) || (!rentalKeptKeys.has(row.key) && isRental(row, config)));
  for (const row of rentalRows) {
    existing.delete(row.key);
    dryRunRows?.delete(row.key);
  }
  // LH는 분양이면서 대상 지역인 공고만 남긴다(config.lh.filterSaleArea). 빠진 공고는 판별, 저장, 알림을 하지 않는다.
  // 범위 밖 행은 알림 뒤에 휴지통으로 옮긴다. 임대 정리와 달리 관심 체크 행은 남긴다.
  const lhScope = splitLhScope(notices, dryRunRows ?? existing, config);
  for (const row of lhScope.archiveRows) {
    existing.delete(row.key);
    dryRunRows?.delete(row.key);
  }
  // 오피스텔·도시형(config.excludeUrbty)과 수도권 밖 공고(config.tableRegions)를 판별 전에 뺀다(src/table-scope.js). 관심 체크 행은 남긴다.
  // 앞 단계가 다룬 행은 다시 세지 않고, 옮긴 행은 existing에서 빼 같은 행을 두 번 옮기지 않는다.
  // tableRegions에 시도 이름이 아닌 값이 있으면(오타로 서울까지 빠지는 일을 막으려고) 이 실행에서는 지역 범위를 끄고 오류 종류만 남긴다.
  const regionsInvalid = tableRegionsInvalid(config);
  if (regionsInvalid) addError('table_scope_config_invalid');
  const scopeConfig = regionsInvalid ? { ...config, tableRegions: undefined } : config;
  // 청약홈과 LH에 함께 올라온 같은 공고는 정보가 많은 쪽 하나만 남긴다. 진 공고는 판별, 저장, 알림을 하지 않는다.
  // LH 상세 조회 전에 하므로 상세 조회 상한 때문에 승자가 바뀌지 않는다. 범위 규칙이 관심으로 남긴 공고(표 범위, LH 범위)와
  // 관심 행이나 역 도보(분)이 있는 행의 쌍은 합치지 않는다.
  const scopeRows = dryRunRows ?? existing;
  const planScope = (scopeOptions) => {
    const table = splitTableScope(lhScope.notices, scopeRows, scopeOptions, lhScope.claimedKeys);
    const duplicates = splitDuplicates(table.notices, scopeRows, scopeOptions, { exemptKeys: new Set([...table.keptOutKeys, ...lhScope.claimedKeys]), today });
    return { table, duplicates };
  };
  let plan = planScope(scopeConfig);
  // 한 번에 옮길 행이 상한(cleanupMaxRows, 저장된 행 대비 cleanupMaxShare)을 넘으면 설정 오류일 수 있어 아무것도 옮기지 않는다.
  // 공고와 저장된 행이 어긋나지 않게 이 실행에서는 세 정리 모두 공고도 빼지 않는다. 관심 행은 옮길 행에 들어 있지 않다.
  // dry-run은 막지 않고 후보 건수와 막힐지 여부만 남긴다.
  const cleanupCandidates = plan.table.archiveRows.urbty.length + plan.table.archiveRows.region.length + plan.duplicates.archiveRows.length;
  const cleanupWouldBlock = cleanupExceeded(cleanupCandidates, storedTotal, config);
  if (cleanupWouldBlock && !flags.dryRun) {
    addError('table_cleanup_blocked');
    plan = planScope({ ...scopeConfig, tableRegions: undefined, excludeUrbty: false, dedupeAcrossSources: false });
  }
  const { table: tableScope, duplicates: duplicateScope } = plan;
  const urbtyRows = tableScope.archiveRows.urbty;
  const regionRows = tableScope.archiveRows.region;
  for (const row of [...urbtyRows, ...regionRows]) {
    existing.delete(row.key);
    dryRunRows?.delete(row.key);
  }
  const duplicateRows = duplicateScope.archiveRows;
  for (const row of duplicateRows) {
    existing.delete(row.key);
    dryRunRows?.delete(row.key);
  }
  // LH 상세·공급 API로 범위 안 LH 공고의 일정, 주택형, 단지 주소를 덮는다(src/lh-detail-map.js). 접수가 끝난 공고는 부르지 않는다.
  // API마다 실행당 lh.detailMaxCalls까지 부르고, 모든 모드에서 읽기만 한다. 실패와 읽지 못한 값은 soft로만 세고 그 공고는 예전 동작이다.
  const lhDetail = createLhDetailClient({
    fetch: fetchFn,
    key: dataKey,
    sleep,
    limits: { maxCalls: config.lh.detailMaxCalls ?? 0, timeoutMs: config.lh.detailTimeoutMs ?? 10000 },
    onSoft: addSoftError,
  });
  const lhShapes = createShapeLog(config.lh.labelLogWords);
  let scopedNotices = duplicateScope.notices;
  let lhDetailCounts = { lh_detail_ok: 0, lh_schedule_parsed: 0, lh_models_parsed: 0, lh_models_unattached: 0, lh_model_rows_merged: 0, lh_detail_capped: 0, lh_supply_capped: 0 };
  if (dataKey) {
    const enriched = await enrichLhNotices(duplicateScope.notices, {
      client: lhDetail,
      isTarget: (notice) => isLhItem(notice) && !lhScopeRule(notice, config) && !isClosedNotice(notice, today),
      lh: config.lh,
      onSoft: addSoftError,
      shapes: lhShapes,
    });
    scopedNotices = enriched.notices;
    lhDetailCounts = enriched.counts;
  }

  const counts = { evaluated: 0, created: 0, updated: 0, skipped: 0, urgent: 0, interest: 0, urgentMailFallback: 0, weekly: 0, archived: 0, lotto_demoted: 0, check_needed: 0, rental_skipped: rentalSkipped, rental_archived: 0, rental_archived_interest: 0, unapplicable_skipped: 0, unapplicable_region: 0, unapplicable_ended: 0, unapplicable_archived: 0, unapplicable_kept_interest: 0, ...lhScope.counts, ...lhDetailCounts, lh_evaluated: 0, lh_recommended: 0, reference_margin: 0, status_updated: 0, status_deferred: 0, ...emptyScopeCounts(), ...tableScope.counts, ...duplicateScope.counts };
  const records = [];
  // 신청할 수 없는 공고의 저장된 행. 알림 뒤에 휴지통으로 옮긴다. dry-run은 건수만 센다.
  const unapplicableRows = [];
  // --print에 표시를 붙여 보여 줄, 저장하지 않고 뺀 공고
  const unapplicableNotices = [];

  const molit = createMolitClient({ fetch: fetchFn, key: dataKey, sleep });
  const presale = createPresaleClient({ fetch: fetchFn, key: dataKey, sleep, now, budgetMs: config.market.presale.budgetMs, onSoft: addSoftError });
  const aptInfo = createAptInfoClient({ fetch: fetchFn, key: dataKey, sleep, now, limits: config.market.aptInfo, onSoft: addSoftError });
  const recommendCounts = { recommended: 0, none: 0 };
  const marketCounts = { complexOutliers: 0, stationUsed: 0, stationNoInput: 0, stationNoData: 0, 상: 0, 중: 0, 하: 0 };
  const stationCountNames = { used: 'stationUsed', noInput: 'stationNoInput', noData: 'stationNoData' };
  const getModels = createModelLookup({ fetch: fetchFn, key: dataKey, sleep });
  // 판정하지 않는 공고(대상 외 경로)의 분양가 조회. 판정용 getModels와 조회기를 따로 둔다. 추천 계산에 쓰이는 주택형이 달라지지 않게 하고,
  // 이 조회의 시간 초과나 네트워크 장애가 판정용 조회의 장애 상태(첫 장애 뒤 호출 중단)를 건드리지 않게 하려는 것이다.
  // 짧은 시간 제한(market.priceLookupTimeoutMs)에 재시도 없이 부르고, 실행당 market.priceLookupBudget건과 market.priceLookupBudgetMs까지만 부른다.
  // 넘으면 실행당 한 번만 건수로 남긴다. 저장된 행에 주택형별 분양가가 이미 있으면 부르지 않는다.
  const storedRow = (key) => existing.get(key) ?? dryRunRows?.get(key);
  const getFactModels = createFactLookup({
    getModels: createModelLookup({ fetch: fetchFn, key: dataKey, sleep, fetchOptions: { retries: 0, timeoutMs: config.market.priceLookupTimeoutMs ?? 5000 } }),
    budget: config.market.priceLookupBudget,
    budgetMs: config.market.priceLookupBudgetMs,
    now: () => now(),
    skip: (notice) => Boolean(storedRow(notice.key)?.modelPrices),
    onExceeded: () => addSoftErrorOnce('price_lookup_budget_exceeded'),
    onTimeExceeded: () => addSoftErrorOnce('price_lookup_time_exceeded'),
  });
  // 이번 실행에서 upsert한(dry-run이면 할) 공고의 키. 접수 상태는 buildProperties가 같이 쓰므로 따로 고치지 않는다.
  const upsertedKeys = new Set();
  const interestRows = new Map(dryRunRows ?? existing);
  // 주택형별 분양가가 아직 없는 공고를 먼저 돌아, 한도가 적은 뒤쪽 종류(임의공급, 오피스텔·도시형)가 굶지 않게 한다.
  // 기록(알림 순서)은 수집한 순서로 되돌린다.
  const collectedOrder = new Map(scopedNotices.map((notice, index) => [notice.key, index]));
  const factsFirst = [...scopedNotices].sort((a, b) => Number(Boolean(storedRow(a.key)?.modelPrices)) - Number(Boolean(storedRow(b.key)?.modelPrices)));
  for (const notice of factsFirst) {
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
          getFactModels,
          // 관심을 체크한 행은 신청할 수 없는 공고여도 저장하므로 분양가 사실도 조회한다.
          interest: Boolean((previous ?? dryRunRows?.get(notice.key))?.interest),
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
      // 시세로 로또·아님을 정한 LH 공고 수. 대상 외와 판별 불가(조회 실패, 추정 없음)는 세지 않는다. 이전 판별 유지 전 값으로 센다.
      if (isLhItem(notice) && [STATUS.LOTTO, STATUS.CHECK, STATUS.NOT].includes(evaluation.status)) counts.lh_evaluated += 1;
      // 추천한 LH 공고 수와 참고 마진(차익 공유 유형)을 적은 공고 수. 건수만 남긴다.
      if (isLhItem(notice) && evaluation.recommendation) counts.lh_recommended += 1;
      if (evaluation.referenceMargin) counts.reference_margin += 1;
      // dry-run도 읽어 둔 행의 이전 상태로 같은 보호를 적용해 일반 실행과 건수가 같게 한다.
      evaluation = keepPreviousLotto(evaluation, (previous ?? dryRunRows?.get(notice.key))?.lotto);
      counts.evaluated += 1;
      // 확인 필요로 정한 공고 수. 긴급 알림은 가지 않으니 건수로만 남긴다.
      if (evaluation.status === STATUS.CHECK) counts.check_needed += 1;
      if (evaluation.confidence) marketCounts[evaluation.confidence] += 1;
      if (evaluation.stationState) marketCounts[stationCountNames[evaluation.stationState]] += 1;
      if (evaluation.recommendation) recommendCounts.recommended += 1;
      else if (evaluation.recommendation === null) recommendCounts.none += 1;
      const interestRow = interestRows.get(notice.key);
      if (interestRow && !(interestRow.end && interestRow.end < today)) interestRows.set(notice.key, overlayRecommendation(interestRow, evaluation));
      marketCounts.complexOutliers += evaluation.complexOutliers ?? 0;
      // 계산 방식이 바뀌어 로또에서 빠진 공고가 몇 건인지 건수만 남긴다. dry-run은 읽어 둔 행으로 센다.
      const stored = previous ?? dryRunRows?.get(notice.key);
      if (stored?.lotto === STATUS.LOTTO && [STATUS.NOT, STATUS.CHECK, STATUS.OUT_OF_SCOPE].includes(evaluation.status)) counts.lotto_demoted += 1;
    }
    // 신청할 수 없는 공고(src/recommend.js의 unapplicableReason)는 저장하지 않고 로또·주간 알림에서도 뺀다. 건수와 사유 종류만 남긴다.
    // 관심을 체크한 행은 보통 공고처럼 갱신하고 로또·주간 알림도 그대로 둔다. 접수가 끝나면 주간 정리가 옮긴다.
    const unapplicable = evaluation?.unapplicable ?? null;
    if (unapplicable) {
      const stored = previous ?? dryRunRows?.get(notice.key);
      if (!stored?.interest) {
        counts.unapplicable_skipped += 1;
        counts[`unapplicable_${unapplicable}`] += 1;
        if (stored) unapplicableRows.push(stored);
        unapplicableNotices.push({ notice, status: evaluation.status, unapplicable });
        continue;
      }
      counts.unapplicable_kept_interest += 1;
    }
    const record = {
      notice,
      status: evaluation?.status ?? carriedStatus(notice, previous, config),
      reason: evaluation?.reason ?? null,
      // 카카오톡은 200자라 비교 단지 목록이 없는 짧은 근거를 쓴다. 메일 대체 발송도 같은 문구다.
      shortReason: evaluation?.shortReason ?? evaluation?.reason ?? null,
      urgentDate: previous?.urgentDate ?? null,
      pageId: previous?.id ?? null,
      marginRate: evaluation?.marginRate ?? null,
      confidence: evaluation?.confidence ?? null,
      checkNote: evaluation?.checkNote ?? null,
      // 관심 체크로 남긴 신청할 수 없는 공고. --print 표시에만 쓴다.
      unapplicable,
    };
    upsertedKeys.add(notice.key);
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
  records.sort((a, b) => collectedOrder.get(a.notice.key) - collectedOrder.get(b.notice.key));
  // 방어용이다. 접수 종료일이 지난 행은 판별 전에 건너뛰어 지금은 주간 정리 대상과 겹치지 않지만, 겹치더라도 두 번 옮기지 않게 뺀다.
  for (const row of unapplicableRows) {
    existing.delete(row.key);
    dryRunRows?.delete(row.key);
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

  // 이번 실행에서 휴지통으로 옮긴 행의 id. 접수 상태를 고치지 않는다.
  const archivedIds = new Set();
  // 주간 메일과 발송 기록이 끝난 실행에서만 정리한다. 긴급 알림 뒤에 두어 발송과 기록을 막지 않는다.
  if (weeklyDone) {
    const { ended } = splitEndedPages([...existing.values()], today);
    const { archived, failed, done } = await archivePages(store, ended, (error) => {
      addError('cleanup_failed');
      addError(safeError(error));
    });
    counts.archived = archived;
    done.forEach((id) => archivedIds.add(id));
    if (failed > 0) notionFailed = true;
  }

  // 저장된 임대 행을 휴지통으로 옮긴다. 일반 실행마다 하고, 알림 뒤라 실패해도 발송을 막지 않는다.
  if (store && rentalRows.length > 0) {
    for (const row of rentalRows) {
      try {
        await store.archivePage(row.id);
        counts.rental_archived += 1;
        if (row.interest) counts.rental_archived_interest += 1;
      } catch (error) {
        notionFailed = true;
        addError('rental_archive_failed');
        addError(safeError(error));
      }
    }
  }

  // LH 범위 밖(분양이 아니거나 대상 지역 밖) 행을 휴지통으로 옮긴다. 임대 행처럼 알림 뒤라 실패해도 발송을 막지 않는다.
  if (store) {
    for (const row of lhScope.archiveRows) {
      try {
        await store.archivePage(row.id);
        counts.lh_out_of_scope_archived += 1;
      } catch (error) {
        notionFailed = true;
        addError('lh_out_of_scope_archive_failed');
        addError(safeError(error));
      }
    }
  }

  // 오피스텔·도시형, 수도권 밖, 중복에서 진 공고의 저장된 행을 휴지통으로 옮긴다. 관심 체크 행은 위에서 남겼고, 한 행은 한 목록에만 있다.
  // 임대 행처럼 알림 뒤라 실패해도 발송을 막지 않는다. 오류에는 종류만 남긴다.
  if (store) {
    const scopeArchives = [
      [urbtyRows, 'urbty_archived', 'urbty_archive_failed'],
      [regionRows, 'region_scope_archived', 'region_scope_archive_failed'],
      [duplicateRows, 'duplicate_archived', 'duplicate_archive_failed'],
    ];
    for (const [rows, countName, failKind] of scopeArchives) {
      const { archived, failed, done } = await archivePages(store, rows, (error) => {
        addError(failKind);
        addError(safeError(error));
      });
      counts[countName] += archived;
      done.forEach((id) => archivedIds.add(id));
      if (failed > 0) notionFailed = true;
    }
  }

  // 신청할 수 없는 공고의 저장된 행을 휴지통으로 옮긴다. 이번 실행에 수집된 공고의 행만이고, 관심 체크 행은 위에서 남겼다.
  // 임대 행처럼 알림 뒤라 실패해도 발송을 막지 않는다.
  if (store) {
    for (const row of unapplicableRows) {
      try {
        await store.archivePage(row.id);
        counts.unapplicable_archived += 1;
      } catch (error) {
        notionFailed = true;
        addError('unapplicable_archive_failed');
        addError(safeError(error));
      }
    }
  }

  // 이번 실행에서 다시 판정하지 않은 저장된 행(접수가 끝나 건너뛴 행, 이번에 수집되지 않은 행)은 접수 상태만 고친다.
  // 저장된 날짜로 계산해 값이 다를 때만 그 속성 하나를 보낸다. 다른 열(로또 여부, 분양가, 마진)은 건드리지 않는다.
  // 알림 뒤에 하고, 실패해도 오류 메일 없이 건수만 남긴다. dry-run은 쓰지 않고 후보 수만 센다.
  // 이번 실행에 수집한 공고의 날짜가 저장된 날짜보다 최신이므로 그 공고는 수집한 날짜로 계산한다(정정으로 일정이 바뀐 공고를 마감으로 적지 않게).
  // 연속 3번 실패하면 멈추고, 실행당 market.statusUpdateMax(기본 150)건까지만 고친다. 나머지는 다음 실행에서 이어 간다.
  const collectedByKey = new Map(scopedNotices.map((notice) => [notice.key, notice]));
  const statusUpdates = selectStatusUpdates(
    [...(dryRunRows ?? existing).values()].filter((row) => !upsertedKeys.has(row.key) && !archivedIds.has(row.id)),
    today,
    (key) => collectedByKey.get(key) ?? null,
  );
  if (store) {
    const maxUpdates = Number.isInteger(config.market.statusUpdateMax) && config.market.statusUpdateMax >= 0 ? config.market.statusUpdateMax : STATUS_UPDATE_MAX;
    let attempts = 0;
    let streak = 0;
    for (const [index, { row, status }] of statusUpdates.entries()) {
      if (attempts >= maxUpdates || streak >= STATUS_FAIL_STREAK) {
        counts.status_deferred = statusUpdates.length - index;
        if (streak >= STATUS_FAIL_STREAK) addSoftErrorOnce('reception_status_breaker');
        break;
      }
      try {
        const written = await store.setReceptionStatus(row.id, status);
        if (written) {
          counts.status_updated += 1;
          attempts += 1;
        }
        streak = 0;
      } catch {
        addSoftError('reception_status_failed');
        attempts += 1;
        streak += 1;
      }
    }
  }

  if (flags.dryRun) {
    const lotto = records.filter((record) => record.status === STATUS.LOTTO).length;
    const checkNeeded = records.filter((record) => record.status === STATUS.CHECK).length;
    const urgent = selectUrgent(records, today, config.alertRegions);
    // Notion을 읽지 못한 dry-run은 후보를 알 수 없어 건수를 남기지 않는다.
    const interest = dryRunRows
      ? ` interest_candidates=${selectInterest([...interestRows.values()], today, new Set(urgent.map((record) => record.notice.key))).length}`
      : '';
    log(`dry-run lotto=${lotto} check_needed=${checkNeeded} urgent_candidates=${urgent.length}${interest}`);
    // 휴지통으로 옮길 저장된 임대 행 수. Notion을 읽지 못했으면 남기지 않는다.
    if (dryRunRows) log(`dry-run rental_archive_candidates=${rentalRows.length}`);
    // 휴지통으로 옮길 신청할 수 없는 공고의 행 수. 마찬가지로 Notion을 읽지 못했으면 남기지 않는다.
    if (dryRunRows) log(`dry-run unapplicable_archive_candidates=${unapplicableRows.length}`);
    // 휴지통으로 옮길 LH 범위 밖 행 수. 마찬가지로 Notion을 읽지 못했으면 남기지 않는다.
    if (dryRunRows) log(`dry-run lh_out_of_scope_archive_candidates=${lhScope.archiveRows.length}`);
    // 휴지통으로 옮길 오피스텔·도시형, 수도권 밖, 중복 행 수. 마찬가지로 Notion을 읽지 못했으면 남기지 않는다.
    if (dryRunRows) {
      log(`dry-run urbty_archive_candidates=${urbtyRows.length} region_scope_archive_candidates=${regionRows.length} duplicate_archive_candidates=${duplicateRows.length} duplicate_pairs_examined=${duplicateScope.counts.duplicate_pairs_examined}`);
      // 일반 실행이면 막힐지 여부(table_cleanup_blocked). 건수만 남긴다.
      const limits = cleanupLimits(config);
      log(`dry-run cleanup_candidates=${cleanupCandidates} stored_rows=${storedTotal} max_rows=${limits.maxRows} max_share=${limits.maxShare} would_block=${cleanupWouldBlock}`);
    }
    // 접수 상태를 고칠 저장된 행 수. 마찬가지로 Notion을 읽지 못했으면 남기지 않는다.
    if (dryRunRows) log(`dry-run status_update_candidates=${statusUpdates.length}`);
  }
  if (flags.print) {
    // 로컬 조회 전용이다(Actions에서는 꺼진다). 신청할 수 없는 공고도 표시를 붙여 보여 준다.
    for (const { notice, status, unapplicable } of [...records, ...unapplicableNotices]) {
      const mark = unapplicable ? ` (unapplicable:${unapplicable})` : '';
      log(`${status ?? '-'} | ${notice.region ?? '-'} | ${notice.typeLabel} | ${notice.name} | ${notice.overallStart ?? '-'} ~ ${notice.overallEnd ?? '-'}${mark}`);
    }
  }

  log(`collected=${collected.length} ${Object.entries(counts).map(([name, value]) => `${name}=${value}`).join(' ')}`);
  log(`errors=${[...errors].map(([kind, count]) => `${kind}:${count}`).join(',') || 'none'}`);
  log(`market apt_calls=${aptInfo.stats().calls} station_used=${marketCounts.stationUsed} station_no_input=${marketCounts.stationNoInput} station_no_data=${marketCounts.stationNoData} complex_outliers=${marketCounts.complexOutliers} confidence_high=${marketCounts.상} confidence_mid=${marketCounts.중} confidence_low=${marketCounts.하} ${umdFormatCounts(molit.stats(), presale.stats())} soft=${[...softErrors].map(([kind, count]) => `${kind}:${count}`).join(',') || 'none'}`);
  // 추천 기능 상태와 건수만 남긴다. 프로필 내용과 신청자 이름표는 남기지 않는다. v2는 신청자 수만 덧붙인다.
  const applicantCount = profile?.version === 2 ? ` version=2 applicants=${profile.applicants.length}` : '';
  log(`recommend profile=${profileStatus} recommended=${recommendCounts.recommended} none=${recommendCounts.none}${applicantCount}`);
  // LH 유형 값(`상위/세부`)별 건수. 분류 이름만 남기고 공고 이름은 남기지 않는다(src/lh-scope.js의 lhTypeLogLabel).
  log(`lh_types ${formatLhTypes(lhTypeCounts) || 'none'}`);
  // 유형 규칙을 통과한 LH 공고의 공급지역별 건수. 지역 값 형식을 확인하는 용도이고 지역 이름만 남긴다.
  log(`lh_sale_regions ${formatLhTypes(lhScope.saleRegions) || 'none'}`);
  // LH 상세·공급 값의 모양(숫자 9, 한글 가, 영문 a)과 접수 대상 이름별 건수. 값 자체는 남기지 않는다(src/lh-detail-map.js).
  log(formatShapeLine(lhShapes));
  // 응답의 블록과 필드 이름. 구조 확인이 끝나 기본으로 끈다(lh.schemaProbeLog).
  if (config.lh.schemaProbeLog) for (const line of lhDetail.schemaLines()) log(line);
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
