import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectApplyhome } from '../sources/applyhome.js';
import {
  AppError, decodeServiceKey, kstToday, maskServiceKey, maskValue, safeError, safeHttpUrl,
} from '../util.js';
import { attachPerformance, buildPerformance, performanceTargets } from './block-performance.js';
import { blockSummary, publicBlockTotal, townBlocks } from './blocks.js';
import { buildBriefs } from './briefs.js';
import { buildCalendar, buildFeed, carriedStageItems, kstDateTime } from './feed.js';
import {
  BUCKETS, LIKELY_SOLD_STAGES, applyWindow, bucketOf, isBlockTown, onOrAfter,
} from './expected-window.js';
import { linkNotices } from './link-notices.js';
import { loadNews, resolveNews } from './curated-news.js';
import {
  NEWS_PUBLISH_DAYS, collectNews, createNewsClient, newsTargets,
} from './news.js';
import { TOWN_STAGES, loadNewtowns } from './newtowns.js';
import { DEFAULT_PREVIOUS_URL, buildChanges, loadPrevious } from './previous.js';
import { DATASET_URL, SEOUL_STAGES, collectSeoul, parseSeoulWorkbook } from './seoul-redevelop.js';

// 분양 예정 지도의 projects.json을 만든다. 서울 자료가 실패하면 멈추고(이전 배포 유지),
// 공고 연결은 실패해도 건너뛴다.

export const DEFAULT_NEWTOWNS = fileURLToPath(new URL('../../data/newtowns.yaml', import.meta.url));
export const DEFAULT_NEWS = fileURLToPath(new URL('../../data/news.yaml', import.meta.url));
// 공고 연결은 최근 3년. 공공주택지구는 블록 공고 간격이 1년을 넘기도 해서(하남교산 A2 2025-03) 1년으로는 빠진다.
// 서울 사업에 이어진 오래된 공고는 현재 단계 날짜 뒤의 공고일 때만 announced로 본다(markAnnounced).
// 사업시행인가 전 서울 사업에는 공고를 잇지 않는다(canLinkNotices).
export const NOTICE_LOOKBACK_DAYS = 1095;

function publicSources(sources) {
  return (sources ?? []).flatMap((source) => {
    const url = safeHttpUrl(source.url);
    return url ? [{ ...source, url }] : [];
  });
}

// 분양 이력 한 건의 출력 형태. 입주 예정·조사 메모 같은 나머지 값은 newtowns.yaml에만 둔다.
function publicHistory(entry) {
  return {
    block: entry.block,
    stage: entry.stage,
    type: entry.type,
    title: entry.title,
    households: entry.households,
    noticeDate: entry.noticeDate,
    end: entry.end ?? null,
    rental: entry.rental === true,
    sources: publicSources(entry.sources),
  };
}

// 공공주택지구의 블록별 현황. 공고 연결 뒤에 부른다(접수 중·끝난 공고가 블록 상태에 들어감). 서울 사업은 그대로.
export function withBlocks(project, today) {
  if (!Array.isArray(project.blockEntries)) return project;
  const blocks = townBlocks({
    entries: project.blockEntries,
    history: project.history,
    plans: project.plans,
    notices: project.notices,
    stageDate: project.stageDates?.[project.stage] ?? null,
    today,
  });
  return {
    ...project, blocks, blockSummary: blockSummary(blocks), blockTotal: publicBlockTotal(project.blockTotal),
  };
}

// 공고 연결과 예상 시기 계산에만 쓰는 내부 값(noticeMatch, expected, plans, blockEntries)은 출력에서 뺀다.
// 공공주택지구는 history(분양 이력)와 blocks(블록별 현황)를 늘 배열로 내보낸다.
// news(관련 소식)는 기사가 있는 사업에만 있고, 약관상 저장해도 되는 네 값(제목·언론사·날짜·링크)만 남긴다.
function toPublic(project) {
  const {
    noticeMatch, expected, plans, history, blockEntries, news, ...rest
  } = project;
  const publicNews = (news ?? []).flatMap(({ title, outlet, date, url }) => {
    const safe = safeHttpUrl(url);
    return title && safe ? [{ title, outlet: outlet ?? null, date: date ?? null, url: safe }] : [];
  });
  return {
    ...rest,
    ...(Array.isArray(history) ? { history: history.map(publicHistory) } : {}),
    ...(publicNews.length ? { news: publicNews } : {}),
    sources: publicSources(rest.sources),
    notices: (rest.notices ?? []).map((notice) => ({ ...notice, url: safeHttpUrl(notice.url) })),
  };
}

// 분양 성과(블록별 분양 지구의 공고 난 블록): 분양가, 주변 시세 비교, 경쟁률. 공고 연결·블록별 현황 뒤에 부른다.
// 어떤 실패도 지도 빌드를 멈추지 않는다(블록마다 따로 처리하고, 남은 예외는 performance_failed로 센다).
async function collectPerformance(projects, {
  fetch, env, today, sleep, fullNotices, performance, config,
}) {
  const empty = (errors, skipped = null) => ({
    results: new Map(),
    stats: {
      blocks: 0, priced: 0, estimated: 0, competition: 0, calls: 0, errors, skipped,
    },
  });
  try {
    const key = decodeServiceKey(env.DATA_GO_KR_KEY) || null;
    const fullByKey = new Map(fullNotices.map((notice) => [notice.key, notice]));
    const targets = projects.flatMap((project) => performanceTargets(project, { fullByKey, today }));
    if (targets.length === 0) return empty([], key ? null : 'no_key');
    return await performance(targets, {
      fetch, key, today, sleep, ...(config ? { config } : {}),
    });
  } catch {
    return empty(['performance_failed']);
  }
}

// 관련 소식(네이버 뉴스 검색). 구간(bucket)과 noticeMatch가 필요해 bucketOf 뒤, toPublic 전에 부른다.
// 기사는 오늘 기준 14일(NEWS_PUBLISH_DAYS)까지만 싣는다. 지도는 하루 두 번 다시 만들지만 다음 빌드까지 남는 기간을
// 넉넉히 7일(MAP_REBUILD_DAYS)로 잡아 14 + 7 = 21일, 약관의 서버 보관 한도(21일) 안에 든다. 새 소식(feed)의 네이버 기사도
// 이번 빌드의 news에서만 만든다(이전 배포에서 잇지 않는다).
// 키가 없으면 skipped=no_key. 어떤 실패도 지도 빌드를 멈추지 않는다(사업별 실패는 collectNews가, 남은 예외는 여기서 kind로 센다).
// stats.projects는 검색 대상 사업 수(newsTargets), checked는 실제로 검색한 수(멈추면 더 적다), matched는 기사가 남은 수.
async function collectMapNews(projects, {
  fetch, env, today, sleep, news,
}) {
  const empty = (extra) => ({
    byId: {},
    searched: null,
    stats: {
      checked: 0, matched: 0, projects: 0, skipped: null, errors: [], stopped: null, ...extra,
    },
  });
  try {
    const id = String(env.NAVER_CLIENT_ID ?? '').trim();
    const secret = String(env.NAVER_CLIENT_SECRET ?? '').trim();
    if (!id || !secret) return empty({ skipped: 'no_key' });
    maskValue(id, env);
    maskValue(secret, env);
    const targets = newsTargets(projects);
    const result = await news({
      projects: targets,
      client: createNewsClient({ fetch, env, sleep }),
      today,
      maxAgeDays: NEWS_PUBLISH_DAYS,
      sleep,
    });
    return {
      byId: result.byId ?? {},
      // 검색이 성공한 사업 id(지역 브리핑용, 출력에는 싣지 않는다). 수집 함수가 주지 않으면 null(모름)
      searched: Array.isArray(result.searched) && result.searched.length ? new Set(result.searched) : null,
      stats: {
        checked: result.checked ?? 0,
        matched: result.matched ?? 0,
        projects: targets.length,
        skipped: null,
        errors: [...new Set(result.errors ?? [])],
        stopped: result.stopped ?? null,
      },
    };
  } catch (error) {
    return empty({ errors: [error instanceof AppError ? error.kind : 'news_failed'] });
  }
}

async function collectNotices({ fetch, env, today, sleep }) {
  const key = decodeServiceKey(env.DATA_GO_KR_KEY);
  if (!key) return { notices: [], skipped: 'no_key', errors: [] };
  maskServiceKey(key, env);
  try {
    const result = await collectApplyhome({ fetch, key, today, lookbackDays: NOTICE_LOOKBACK_DAYS, sleep });
    if (result.failedAll) return { notices: [], skipped: result.errors[0] ?? 'applyhome_failed', errors: result.errors };
    return { notices: result.notices, skipped: null, errors: result.errors };
  } catch (error) {
    return { notices: [], skipped: safeError(error), errors: [] };
  }
}

// 단계·유형 값을 몰라 건너뛴 행이 이 비율을 넘으면 원자료 값이 바뀐 것으로 보고 멈춘다.
export const MAX_VALUE_SKIP_RATIO = 0.05;

// 서울 자료에서 건너뛴 행 검사. 데이터 행 = 읽은 사업 + 건너뛴 행(중복 포함).
export function checkSeoulValues({ projects, skipped = {} }) {
  const valueSkips = (skipped.stage ?? 0) + (skipped.kind ?? 0);
  const rows = projects.length + Object.values(skipped).reduce((sum, count) => sum + count, 0);
  if (rows > 0 && valueSkips / rows > MAX_VALUE_SKIP_RATIO) throw new AppError('seoul_values');
}

// 공고는 연결됐지만 모두 접수가 끝났으면 announced. 기간은 그대로 두고 근거만 바꾼다.
// 서울 정비사업만 바꾼다. 공공주택지구는 블록별로 여러 번 공고하므로 지난 블록 공고가 있어도
// 규칙·보도 기간을 그대로 둔다. 준공(done)도 그대로 둔다.
// 3년 조회라 같은 지번의 예전 사업 공고가 이어질 수 있다. 단계가 이주·착공·일반분양이거나, 가장 늦은 공고일이
// 현재 단계 날짜와 같거나 뒤일 때만 announced로 본다. 아니면 공고는 목록에 두고 기간·상태는 그대로다.
// 사업시행인가 전 서울 사업은 공고 연결 단계에서 공고가 붙지 않아(canLinkNotices) 여기 오지 않는다.
export function markAnnounced(project) {
  const notices = project.notices ?? [];
  if (project.region !== '서울' || project.live || notices.length === 0 || project.windowStatus === 'done') return project;
  const latest = notices.map((notice) => notice.announceDate).filter(Boolean).sort().at(-1);
  const current = LIKELY_SOLD_STAGES.includes(project.stage)
    || onOrAfter(latest, project.stageDates?.[project.stage]) === true;
  if (!current) return project;
  return {
    ...project,
    windowStatus: 'announced',
    windowBasis: latest ? `청약홈 공고가 이미 있었습니다(${latest})` : '청약홈 공고가 이미 있었습니다',
  };
}

// 공고 연결 뒤 블록별 분양 지구의 다음 블록 예상을 다시 잡는다.
// - 이어진 공고의 공고명에 계획 블록 이름이 있으면 그 블록은 공고가 난 것으로 보고 계획 근거에서 뺀다(blockAnnounced).
// - 접수 중인 공고가 있으면 구간은 live로 두고(bucketOf), 규칙으로 잡는 다음 블록 기간은 그 공고 마감 달 다음 달부터 잡는다.
// 지구 계획(expected)으로 잡은 기간은 그대로다.
export function nextBlockAfterLink(project, today) {
  const notices = project.notices ?? [];
  if (notices.length === 0 || !isBlockTown(project.kind, project.stage)) return project;
  const liveEnd = project.live
    ? notices.map((notice) => notice.end).filter((end) => end && end >= today).sort().at(-1) ?? null
    : null;
  return applyWindow(project, today, { liveEnd });
}

function tally(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

// 수집 시각(KST, 초까지). today를 따로 주면(테스트·재현) 그날 00:00으로 둔다.
export function generatedAtFor(now, today) {
  return kstToday(now) === today ? kstDateTime(now) : `${today}T00:00:00+09:00`;
}

// 손으로 고른 기사(data/news.yaml, curated-news.js): 파일이 없거나 newtowns.yaml이 없으면(지구 기사를 이을 곳이 없음) 건너뛴다.
// 형식 오류·없는 지구·없는 블록은 멈춘다. 네이버 관련 소식(collectMapNews)과는 따로다.
function collectCuratedNews({ newsFile, loadNewsFile, towns, projects }) {
  if (!newsFile) return { items: [], asOf: null, skipped: 'no_news', unmatched: 0 };
  const news = loadNewsFile(newsFile);
  if (!news) return { items: [], asOf: null, skipped: 'news_missing', unmatched: 0 };
  if (!towns) return { items: [], asOf: news.asOf, skipped: 'newtowns_missing', unmatched: 0 };
  const resolved = resolveNews(news.items, projects);
  return {
    items: resolved.items, asOf: news.asOf, skipped: null, unmatched: resolved.skipped,
  };
}

// 단계 소식의 출처: 서울 사업은 서울시 정비사업 자료, 공공주택지구는 날짜가 가장 늦은 지구 출처
function stageSourceFor(seoul) {
  return (project) => {
    if (project.region === '서울') return { title: seoul.title ?? '서울시 정비사업 추진현황', url: DATASET_URL, date: null };
    return [...(project.sources ?? [])].filter((source) => source?.date).sort((a, b) => String(b.date).localeCompare(String(a.date)))[0]
      ?? project.sources?.[0] ?? null;
  };
}

/**
 * previous: 이전 배포 자료를 어디서 읽을지. { url } 또는 { file }, null이면 읽지 않는다(changes 없음, skipped no_previous).
 * CLI(run)는 기본으로 배포된 주소(MAP_PREVIOUS_URL로 바꿈)를 쓴다.
 */
export async function buildMap({
  fetch = globalThis.fetch,
  env = process.env,
  now = new Date(),
  today = kstToday(now),
  seoulFile = null,
  newtownsFile = DEFAULT_NEWTOWNS,
  // 손으로 고른 기사 파일(data/news.yaml). news는 네이버 관련 소식 수집 함수(테스트에서 바꿔 끼운다)
  newsFile = DEFAULT_NEWS,
  previous = null,
  readFile = (path) => readFileSync(path),
  loadTowns = loadNewtowns,
  loadNewsFile = loadNews,
  sleep,
  performance = buildPerformance,
  news = collectNews,
  config = null,
} = {}) {
  const seoul = seoulFile
    ? parseSeoulWorkbook(readFile(seoulFile), { fileName: basename(seoulFile) })
    : await collectSeoul({ fetch, sleep });
  checkSeoulValues(seoul);
  const towns = loadTowns(newtownsFile);

  const notices = await collectNotices({ fetch, env, today, sleep });
  const base = [...seoul.projects, ...(towns?.projects ?? [])].map((project) => applyWindow(project, today));
  const linkedResult = notices.skipped
    ? { projects: base, linked: 0, checked: 0 }
    : linkNotices(base, notices.notices, today);
  // 내부 사업(계획·이력 출처가 남아 있음). 소식은 이것으로 만들고, 출력은 toPublic으로 줄인다.
  const staged = linkedResult.projects.map((project) => markAnnounced(nextBlockAfterLink(project, today)))
    .map((project) => ({ ...withBlocks(project, today), bucket: bucketOf(project, today) }));

  // 손으로 고른 기사(data/news.yaml)는 형식 오류면 멈추므로 API 호출(분양 성과·관련 소식) 전에 읽는다
  const curated = collectCuratedNews({
    newsFile, loadNewsFile, towns, projects: staged,
  });
  const perf = await collectPerformance(staged, {
    fetch, env, today, sleep, fullNotices: notices.notices, performance, config,
  });
  const newsResult = await collectMapNews(staged, {
    fetch, env, today, sleep, news,
  });
  // 분양 성과(블록 줄)와 관련 소식(네이버, 이번 빌드에서 받은 것만)을 붙인 내부 사업
  const internal = staged.map((project) => {
    const withPerf = attachPerformance(project, perf.results);
    const items = newsResult.byId[project.id];
    return Array.isArray(items) && items.length ? { ...withPerf, news: items } : withPerf;
  });

  const prev = await loadPrevious({
    fetch, ...(previous ?? {}), readFile, sleep,
  });
  // 이전 배포를 못 읽으면 changes는 since: null, items: [](buildChanges), 이어 오던 단계 소식도 없다
  const changes = buildChanges(prev.data, internal);
  // 새 소식의 뉴스: news.yaml 기사(계속 둔다)와 네이버 관련 소식(internal의 news, 이번 빌드의 14일 안 기사만. 이전 배포에서 잇지 않는다)
  const feed = buildFeed({
    projects: internal,
    news: curated.items,
    changes: changes.items,
    carried: carriedStageItems(prev.data?.feed, internal, today),
    today,
    sourceFor: stageSourceFor(seoul),
  });
  // 지역 브리핑(서울 구·추적 중인 지구). 내부 사업(계획·이력 출처, 관련 소식)과 손으로 고른 기사로 만든다
  const briefs = buildBriefs({
    projects: internal, watchlist: towns?.watchlist ?? [], curated: curated.items, today, seoulAsOf: seoul.asOf, newsSearched: newsResult.searched,
  });
  const projects = internal.map(toPublic);

  return {
    generatedAt: generatedAtFor(now, today),
    sources: {
      seoul: {
        asOf: seoul.asOf, title: seoul.title, url: DATASET_URL, count: seoul.projects.length, skipped: { ...seoul.skipped },
      },
      newtowns: towns
        ? { asOf: towns.asOf, count: towns.projects.length, skipped: null }
        : { asOf: null, count: 0, skipped: 'newtowns_missing' },
      notices: {
        linked: linkedResult.linked,
        checked: linkedResult.checked,
        skipped: notices.skipped,
        errors: [...new Set(notices.errors)],
      },
      performance: { ...perf.stats },
      // 관련 소식(네이버 뉴스 검색) 수집 결과
      news: { ...newsResult.stats },
      // 손으로 고른 기사(data/news.yaml)
      curatedNews: {
        asOf: curated.asOf, count: curated.items.length, skipped: curated.skipped, unmatched: curated.unmatched,
      },
      previous: { skipped: prev.skipped },
    },
    stages: { seoul: [...SEOUL_STAGES], town: [...TOWN_STAGES] },
    watchlist: towns?.watchlist ?? [],
    calendar: buildCalendar(internal, today),
    feed,
    changes,
    briefs,
    projects,
  };
}

// 분양 성과 한 줄(건수만). 키가 없으면 끝에 skipped=no_key.
export function performanceLine(stats) {
  const errors = Array.isArray(stats.errors) ? stats.errors.length : 0;
  return `map performance blocks=${stats.blocks} priced=${stats.priced} estimated=${stats.estimated} `
    + `competition=${stats.competition} calls=${stats.calls} errors=${errors}${stats.skipped ? ` skipped=${stats.skipped}` : ''}`;
}

// 관련 소식 한 줄(건수와 오류 종류만). 키가 없으면 skipped=no_key. 오류가 있으면 끝에 종류(kinds=…)를 붙인다.
export function newsLine(stats) {
  if (stats.skipped) return `map news skipped=${stats.skipped}`;
  const errors = Array.isArray(stats.errors) ? stats.errors : [];
  return `map news checked=${stats.checked} matched=${stats.matched} projects=${stats.projects} `
    + `errors=${errors.length} stopped=${stats.stopped ?? 'none'}${errors.length ? ` kinds=${errors.join(',')}` : ''}`;
}

export function summaryLines(data) {
  const { seoul, newtowns, notices } = data.sources;
  const noticePart = notices.skipped
    ? `notices skipped=${notices.skipped}`
    : `notices checked=${notices.checked} linked=${notices.linked}`;
  const skipped = Object.entries(seoul.skipped ?? {}).map(([reason, count]) => `${reason}:${count}`).join(',') || '0';
  const previousSkipped = data.sources.previous?.skipped;
  const changesPart = previousSkipped ? `skipped:${previousSkipped}` : String(data.changes?.items.length ?? 0);
  const curated = data.sources.curatedNews;
  const curatedPart = curated?.skipped ? `skipped:${curated.skipped}` : String(curated?.count ?? 0);
  const lines = [`map seoul=${seoul.count} skipped=${skipped} asOf=${seoul.asOf} towns=${newtowns.count} ${noticePart}`
    + ` feed=${data.feed?.length ?? 0} calendar=${data.calendar?.length ?? 0} changes=${changesPart} curated=${curatedPart}`];
  if (newtowns.skipped) lines.push(`newtowns skipped=${newtowns.skipped}`);
  // 이전 배포를 못 읽은 종류(no_previous는 비교를 하지 않은 경우라 남기지 않는다)
  if (previousSkipped && previousSkipped !== 'no_previous') lines.push(`previous skipped=${previousSkipped}`);
  if (curated?.unmatched) lines.push(`curated unmatched=${curated.unmatched}`);
  if (!notices.skipped && notices.errors.length > 0) lines.push(`notices errors=${notices.errors.join(',')}`);
  const buckets = tally(data.projects.map((project) => project.bucket));
  lines.push(`map buckets ${BUCKETS.map((bucket) => `${bucket}=${buckets[bucket] ?? 0}`).join(' ')}`);
  const stages = tally(data.projects.map((project) => project.stage));
  lines.push(`map stages ${Object.entries(stages).map(([stage, count]) => `${stage}=${count}`).join(' ')}`);
  if (data.sources.news) lines.push(newsLine(data.sources.news));
  if (data.sources.performance) lines.push(performanceLine(data.sources.performance));
  return lines;
}

export function parseArgs(argv) {
  const args = {
    out: 'site/projects.json', seoulFile: null, newtownsFile: DEFAULT_NEWTOWNS, newsFile: DEFAULT_NEWS, previousFile: null,
  };
  const keys = {
    '--out': 'out', '--seoul-file': 'seoulFile', '--newtowns': 'newtownsFile', '--news': 'newsFile', '--previous': 'previousFile',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (Object.hasOwn(keys, flag)) {
      if (!value || value.startsWith('--')) throw new AppError('map_args');
      i += 1;
      args[keys[flag]] = value;
    } else {
      throw new AppError('map_args');
    }
  }
  return args;
}

// 이전 배포 자료: --previous 파일, 없으면 MAP_PREVIOUS_URL, 없으면 배포된 주소
export function previousSource(args, env) {
  if (args.previousFile) return { file: args.previousFile };
  return { url: env.MAP_PREVIOUS_URL || DEFAULT_PREVIOUS_URL };
}

export async function run({
  argv = [], env = process.env, fetch = globalThis.fetch, log = console.log, today, now,
} = {}) {
  try {
    const args = parseArgs(argv);
    const data = await buildMap({
      fetch,
      env,
      ...(now ? { now } : {}),
      ...(today ? { today } : {}),
      seoulFile: args.seoulFile,
      newtownsFile: args.newtownsFile,
      newsFile: args.newsFile,
      previous: previousSource(args, env),
    });
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(data)}\n`);
    for (const line of summaryLines(data)) log(line);
    return 0;
  } catch (error) {
    log(`map failed=${safeError(error)}`);
    return 1;
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
