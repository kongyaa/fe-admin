import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { collectApplyhome, createModelLookup } from './sources/applyhome.js';
import { collectLh } from './sources/lh.js';
import { createMolitClient } from './sources/molit.js';
import { STATUS, evaluateLotto, keepPreviousLotto } from './lotto.js';
import { createNotionStore } from './notion-store.js';
import { buildErrorMail, buildUrgentMail, buildWeeklyMail, createGmailSender } from './notify-gmail.js';
import { buildKakaoText, sendKakaoMemo } from './notify-kakao.js';
import {
  decodeServiceKey,
  defaultSleep,
  kstToday,
  maskServiceKey,
  maskValue,
  safeError,
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

// 수동 전용. 저장된 접수 종료일이 오늘(KST) 이전인 페이지만 Notion 휴지통으로 옮긴다.
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
  const counts = { archived: 0, kept: 0, failed: 0 };
  const ended = [];
  for (const page of pages) {
    if (page.end && page.end < today) ended.push(page);
    else counts.kept += 1;
  }
  if (dryRun) {
    log(`cleanup dry-run candidates=${ended.length} kept=${counts.kept}`);
    return 0;
  }
  for (const page of ended) {
    try {
      await store.archivePage(page.id);
      counts.archived += 1;
    } catch {
      counts.failed += 1;
    }
  }
  log(`cleanup archived=${counts.archived} kept=${counts.kept} failed=${counts.failed}`);
  return counts.failed > 0 ? 1 : 0;
}

export async function run({ argv = [], env = process.env, deps = {} } = {}) {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? ((line) => console.log(line));
  const write = deps.write;
  const config = deps.config ?? loadConfig();
  const today = kstToday(deps.now ? deps.now() : new Date());

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

  const sendMail = deps.sendMail ?? createGmailSender({
    user: env.GMAIL_USER,
    password: env.GMAIL_APP_PASSWORD,
    to: env.MAIL_TO,
  });
  const sendKakao = deps.sendKakao ?? (({ text, url }) => sendKakaoMemo({ token: accessToken, text, url, fetch: fetchFn, sleep }));

  if (flags.testSend) return runTestSend({ sendMail, sendKakao, today, log });

  const errors = new Map();
  const addError = (kind) => errors.set(kind, (errors.get(kind) ?? 0) + 1);
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
  if (!flags.dryRun) {
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
      existing = await store.loadExisting();
    } catch (error) {
      notionFailed = true;
      store = null;
      addError(safeError(error));
    }
  }

  const counts = { evaluated: 0, created: 0, updated: 0, skipped: 0, urgent: 0, urgentMailFallback: 0, weekly: 0 };
  const records = [];

  const molit = createMolitClient({ fetch: fetchFn, key: dataKey, sleep });
  const getModels = createModelLookup({ fetch: fetchFn, key: dataKey, sleep });
  for (const notice of notices) {
    const previous = existing.get(notice.key);
    if (!previous && isClosedNotice(notice, today)) {
      counts.skipped += 1;
      continue;
    }
    if (previous?.end && previous.end < today) {
      counts.skipped += 1;
      records.push({ notice, status: previous.lotto, urgentDate: previous.urgentDate, pageId: previous.id });
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
          onError: addError,
        });
      } catch (error) {
        addError(safeError(error));
        evaluation = { status: STATUS.UNDETERMINED, reason: '판별 실패' };
      }
      evaluation = keepPreviousLotto(evaluation, previous?.lotto);
      counts.evaluated += 1;
    }
    const record = {
      notice,
      status: evaluation?.status ?? previous?.lotto ?? null,
      reason: evaluation?.reason ?? null,
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
  if (store) {
    await sendWeekly({ records, store, sendMail, config, today, flags, applyhomeResult, addError, counts, markNotionFailed: () => { notionFailed = true; } });
  }

  if (!flags.dryRun) {
    // 긴급 알림은 놓치는 쪽이 더 나쁘므로 기록할 곳이 없어도 보낸다. 다음 실행과 중복될 수 있다.
    for (const record of selectUrgent(records, today, config.alertRegions)) {
      const text = buildKakaoText({ notice: record.notice, stage: record.stage, reason: record.reason });
      let sent = false;
      try {
        await sendKakao({ text, url: record.notice.url });
        sent = true;
        counts.urgent += 1;
      } catch (error) {
        addError(safeError(error));
        try {
          await sendMail(buildUrgentMail({ notice: record.notice, text, url: record.notice.url }));
          sent = true;
          counts.urgent += 1;
          counts.urgentMailFallback += 1;
        } catch (mailError) {
          addError(safeError(mailError));
        }
      }
      if (!sent) {
        urgentLost = true;
        addError('urgent_lost');
      } else if (store && record.pageId) {
        try {
          await store.stampUrgent(record.pageId, today);
        } catch (error) {
          notionFailed = true;
          addError(safeError(error));
          addError('urgent_sent_without_stamp');
        }
      } else {
        addError('urgent_sent_without_stamp');
      }
    }
  }

  if (flags.dryRun) {
    const lotto = records.filter((record) => record.status === STATUS.LOTTO).length;
    const urgent = selectUrgent(records, today, config.alertRegions).length;
    log(`dry-run lotto=${lotto} urgent_candidates=${urgent}`);
  }
  if (flags.print) {
    for (const { notice, status } of records) {
      log(`${status ?? '-'} | ${notice.region ?? '-'} | ${notice.typeLabel} | ${notice.name} | ${notice.overallStart ?? '-'} ~ ${notice.overallEnd ?? '-'}`);
    }
  }

  log(`collected=${notices.length} ${Object.entries(counts).map(([name, value]) => `${name}=${value}`).join(' ')}`);
  log(`errors=${[...errors].map(([kind, count]) => `${kind}:${count}`).join(',') || 'none'}`);

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

async function sendWeekly({ records, store, sendMail, config, today, flags, applyhomeResult, addError, counts, markNotionFailed }) {
  let lastMonday;
  try {
    lastMonday = await store.getWeeklyState();
  } catch (error) {
    markNotionFailed();
    addError(safeError(error));
    return;
  }
  if (!shouldSendWeekly(today, lastMonday, flags.forceWeekly)) return;
  // 청약홈이 일부라도 실패하면 수요일 또는 강제 실행 전까지 다음 실행으로 미룬다.
  const partial = applyhomeResult.errors.length > 0;
  if (applyhomeResult.failedAll || (partial && weekdayOf(today) !== 3 && !flags.forceWeekly)) {
    addError('weekly_deferred');
    return;
  }
  const { monday, sunday } = weekRange(today);
  const items = selectWeekly(records, monday, sunday, config.alertRegions);
  const warning = partial ? '일부 청약홈 조회가 실패해 누락이 있을 수 있습니다.' : null;
  try {
    await sendMail(buildWeeklyMail({ items, monday, sunday, warning }));
    counts.weekly += 1;
  } catch (error) {
    addError(safeError(error));
    return;
  }
  try {
    await store.setWeeklyState(monday);
  } catch (error) {
    markNotionFailed();
    addError(safeError(error));
  }
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
