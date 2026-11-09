import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectApplyhome } from '../sources/applyhome.js';
import { AppError, decodeServiceKey, kstToday, maskServiceKey, safeError, safeHttpUrl } from '../util.js';
import { BUCKETS, applyWindow, bucketOf } from './expected-window.js';
import { linkNotices } from './link-notices.js';
import { TOWN_STAGES, loadNewtowns } from './newtowns.js';
import { DATASET_URL, SEOUL_STAGES, collectSeoul, parseSeoulWorkbook } from './seoul-redevelop.js';

// 분양 예정 지도의 projects.json을 만든다. 서울 자료가 실패하면 멈추고(이전 배포 유지),
// 공고 연결은 실패해도 건너뛴다.

export const DEFAULT_NEWTOWNS = fileURLToPath(new URL('../../data/newtowns.yaml', import.meta.url));
const LOOKBACK_DAYS = 365;

// 공고 연결과 예상 시기 계산에만 쓰는 내부 값은 출력에서 뺀다.
function toPublic(project) {
  const { noticeMatch, expected, ...rest } = project;
  return {
    ...rest,
    sources: (rest.sources ?? []).flatMap((source) => {
      const url = safeHttpUrl(source.url);
      return url ? [{ ...source, url }] : [];
    }),
    notices: (rest.notices ?? []).map((notice) => ({ ...notice, url: safeHttpUrl(notice.url) })),
  };
}

async function collectNotices({ fetch, env, today, sleep }) {
  const key = decodeServiceKey(env.DATA_GO_KR_KEY);
  if (!key) return { notices: [], skipped: 'no_key', errors: [] };
  maskServiceKey(key, env);
  try {
    const result = await collectApplyhome({ fetch, key, today, lookbackDays: LOOKBACK_DAYS, sleep });
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
export function markAnnounced(project) {
  const notices = project.notices ?? [];
  if (project.region !== '서울' || project.live || notices.length === 0 || project.windowStatus === 'done') return project;
  const latest = notices.map((notice) => notice.announceDate).filter(Boolean).sort().at(-1);
  return {
    ...project,
    windowStatus: 'announced',
    windowBasis: latest ? `청약홈 공고가 이미 있었습니다(${latest})` : '청약홈 공고가 이미 있었습니다',
  };
}

function tally(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

export async function buildMap({
  fetch = globalThis.fetch,
  env = process.env,
  today = kstToday(),
  seoulFile = null,
  newtownsFile = DEFAULT_NEWTOWNS,
  readFile = (path) => readFileSync(path),
  loadTowns = loadNewtowns,
  sleep,
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
  const projects = linkedResult.projects.map(markAnnounced)
    .map((project) => toPublic({ ...project, bucket: bucketOf(project, today) }));

  return {
    generatedAt: today,
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
    },
    stages: { seoul: [...SEOUL_STAGES], town: [...TOWN_STAGES] },
    projects,
  };
}

export function summaryLines(data) {
  const { seoul, newtowns, notices } = data.sources;
  const noticePart = notices.skipped
    ? `notices skipped=${notices.skipped}`
    : `notices checked=${notices.checked} linked=${notices.linked}`;
  const skipped = Object.entries(seoul.skipped ?? {}).map(([reason, count]) => `${reason}:${count}`).join(',') || '0';
  const lines = [`map seoul=${seoul.count} skipped=${skipped} asOf=${seoul.asOf} towns=${newtowns.count} ${noticePart}`];
  if (newtowns.skipped) lines.push(`newtowns skipped=${newtowns.skipped}`);
  if (!notices.skipped && notices.errors.length > 0) lines.push(`notices errors=${notices.errors.join(',')}`);
  const buckets = tally(data.projects.map((project) => project.bucket));
  lines.push(`map buckets ${BUCKETS.map((bucket) => `${bucket}=${buckets[bucket] ?? 0}`).join(' ')}`);
  const stages = tally(data.projects.map((project) => project.stage));
  lines.push(`map stages ${Object.entries(stages).map(([stage, count]) => `${stage}=${count}`).join(' ')}`);
  return lines;
}

export function parseArgs(argv) {
  const args = { out: 'site/projects.json', seoulFile: null, newtownsFile: DEFAULT_NEWTOWNS };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--out' || flag === '--seoul-file' || flag === '--newtowns') {
      if (!value || value.startsWith('--')) throw new AppError('map_args');
      i += 1;
      if (flag === '--out') args.out = value;
      else if (flag === '--seoul-file') args.seoulFile = value;
      else args.newtownsFile = value;
    } else {
      throw new AppError('map_args');
    }
  }
  return args;
}

export async function run({ argv = [], env = process.env, fetch = globalThis.fetch, log = console.log, today } = {}) {
  try {
    const args = parseArgs(argv);
    const data = await buildMap({ fetch, env, today, seoulFile: args.seoulFile, newtownsFile: args.newtownsFile });
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
