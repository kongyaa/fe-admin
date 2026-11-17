// 일회성 백테스트(버리는 브랜치용). 공고 하나를 "그날 배치가 돌았다면" 어떻게 판정했을지 본다.
// 운영 코드(collectApplyhome, evaluateLotto 등)를 그대로 부르고 today만 asOf로 바꾼다.
// 프로필, Notion, 카카오, Gmail 클라이언트는 만들지 않는다. 아무것도 보내거나 쓰지 않는다.
//
// 환경 변수: DATA_GO_KR_KEY(필수), BACKTEST_AS_OF(YYYY-MM-DD), BACKTEST_NAME(공고명 부분 문자열),
//   BACKTEST_LOOKBACK(선택, 수집 기간 일수. 기본은 config.lookbackDays), BACKTEST_LIST_ONLY=1(목록만 출력)
import { readFileSync } from 'node:fs';
import { ENDPOINTS, collectApplyhome, createModelLookup } from './src/sources/applyhome.js';
import { createAptInfoClient } from './src/sources/apt-info.js';
import { createMolitClient, createPresaleClient } from './src/sources/molit.js';
import { evaluateLotto } from './src/lotto.js';
import { isActive, selectUrgent } from './src/main.js';
import { isRental } from './src/rental.js';
import { formatModelPrices } from './src/price-facts.js';
import { completeMonths, decodeServiceKey, defaultSleep, kstToday, maskServiceKey, safeError } from './src/util.js';

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const env = process.env;
const log = (line = '') => console.log(line);

const asOf = env.BACKTEST_AS_OF ?? '';
const nameContains = (env.BACKTEST_NAME ?? '').trim();
const listOnly = env.BACKTEST_LIST_ONLY === '1';
const lookbackDays = Number(env.BACKTEST_LOOKBACK) > 0 ? Number(env.BACKTEST_LOOKBACK) : config.lookbackDays;

if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(asOf)) || !nameContains) {
  log('usage: BACKTEST_AS_OF=YYYY-MM-DD BACKTEST_NAME=공고명 node backtest.js');
  process.exit(2);
}
const key = decodeServiceKey(env.DATA_GO_KR_KEY);
if (!key) {
  log('DATA_GO_KR_KEY missing');
  process.exit(2);
}
maskServiceKey(env.DATA_GO_KR_KEY, env);
maskServiceKey(key, env);

const sleep = defaultSleep;
const fetchFn = globalThis.fetch;
const norm = (text) => String(text ?? '').replace(/[\s\-_]/g, '').toLowerCase();

log(`backtest asOf=${asOf} realToday(KST)=${kstToday()} nameContains="${nameContains}" lookbackDays=${lookbackDays}`);

// run()과 같은 수집. today만 asOf다. 서버 필터는 모집공고일 하한만 걸어서 asOf 뒤에 공고된 건은 따로 뺀다.
const collected = await collectApplyhome({ fetch: fetchFn, key, today: asOf, lookbackDays, sleep, endpoints: ENDPOINTS });
log(`collect errors=${collected.errors.join(',') || 'none'} failedAll=${collected.failedAll} raw=${collected.notices.length}`);
const announced = collected.notices.filter((notice) => !notice.announceDate || notice.announceDate <= asOf);
log(`announced on/before asOf=${announced.length} (excluded ${collected.notices.length - announced.length} announced after asOf)`);
const matches = announced.filter((notice) => norm(notice.name).includes(norm(nameContains)));
log(`name matches=${matches.length}`);

const stageText = (stages) => stages.map((s) => `${s.name} ${s.start}${s.end && s.end !== s.start ? `~${s.end}` : ''}`).join(' | ');

if (listOnly) {
  for (const n of matches) log(`LIST ${n.kind} | ${n.typeLabel} | ${n.region} | ${n.name} | 공고일 ${n.announceDate} | 접수 ${n.overallStart}~${n.overallEnd} | key ${n.key} | ${n.address}`);
  process.exit(0);
}

// 시세 조회 기간을 증명하려고 실거래 조회를 감싼다. 판정 코드는 그대로다.
const molit = createMolitClient({ fetch: fetchFn, key, sleep });
const presale = createPresaleClient({ fetch: fetchFn, key, sleep, budgetMs: config.market.presale.budgetMs, onSoft: (kind) => log(`soft: ${kind}`) });
const aptInfo = createAptInfoClient({ fetch: fetchFn, key, sleep, limits: config.market.aptInfo, onSoft: (kind) => log(`soft: ${kind}`) });
const getModels = createModelLookup({ fetch: fetchFn, key, sleep });

const window = { saleMonths: new Set(), presaleMonths: new Set(), saleRows: 0, presaleRows: 0, minDeal: null, maxDeal: null, lawd: new Set() };
const track = (rows) => {
  for (const row of rows) {
    if (!row.dealDate) continue;
    if (!window.minDeal || row.dealDate < window.minDeal) window.minDeal = row.dealDate;
    if (!window.maxDeal || row.dealDate > window.maxDeal) window.maxDeal = row.dealDate;
  }
};
const getTrades = async (code, months) => {
  window.lawd.add(code);
  months.forEach((m) => window.saleMonths.add(m));
  const rows = await molit.getTrades(code, months);
  window.saleRows += rows.length;
  track(rows);
  return rows;
};
const getPresale = async (code, months) => {
  months.forEach((m) => window.presaleMonths.add(m));
  const result = await presale.getTrades(code, months);
  window.presaleRows += result.rows.length;
  track(result.rows);
  return result;
};

const errors = new Map();
const softs = new Map();
const bump = (map) => (kind) => map.set(kind, (map.get(kind) ?? 0) + 1);

const comparablesOf = (reason) => {
  const match = /보정 후 [\d.]+㎡ 기준: (.*?); (?:보수 시세|하위 25% 시세)/.exec(reason ?? '');
  return match ? match[1] : null;
};
const grab = (reason, re) => re.exec(reason ?? '')?.[1] ?? null;

let exitCode = 0;
for (const notice of matches) {
  log('');
  log('='.repeat(100));
  log(`공고명: ${notice.name}`);
  log(`지역: ${notice.region} | 주소: ${notice.address} | 유형: ${notice.typeLabel} (kind=${notice.kind}, houseSecd=${notice.houseSecd}, sector=${notice.sector}) | 시공사: ${notice.builder || '-'}`);
  log(`모집공고일: ${notice.announceDate} | 당첨자발표: ${notice.winnerDate ?? '-'} | 전체 접수: ${notice.overallStart}~${notice.overallEnd}`);
  log(`접수 단계: ${stageText(notice.stages)}`);
  log(`flags: priceCap=${notice.flags.priceCap} publicDistrict=${notice.flags.publicDistrict}`);
  log(`key=${notice.key} url=${notice.url ?? '-'}`);
  log(`filters: isRental=${isRental(notice, config)} isActive(asOf)=${isActive(notice, asOf)} inAlertRegions=${config.alertRegions.includes(notice.region)}`);

  let models = null;
  try {
    models = await getModels(notice);
    log('주택형별 분양가(청약홈 getAPTLttotPblancMdl, 최고분양가):');
    for (const m of models) log(`  ${m.houseType} | 전용 ${m.area}㎡ | ${m.price}만원 | ${m.households ?? '-'}세대`);
    log(`  요약: ${formatModelPrices(models)}`);
  } catch (error) {
    log(`주택형 조회 실패: ${safeError(error)}`);
  }

  if (!isActive(notice, asOf)) log('NOTE: 배치는 접수가 끝난 공고를 판별하지 않는다(isActive=false). 그래도 평가는 실행한다.');
  if (isRental(notice, config)) log('NOTE: 배치는 임대 공고를 판별 전에 뺀다. 그래도 평가는 실행한다.');

  window.saleMonths.clear();
  window.presaleMonths.clear();
  Object.assign(window, { saleRows: 0, presaleRows: 0, minDeal: null, maxDeal: null });
  window.lawd.clear();

  // run()의 evaluateLotto 호출과 같다. profile은 없고, walkMinutes도 없다(저장된 행이 없는 새 공고).
  let evaluation;
  try {
    evaluation = await evaluateLotto(notice, {
      config,
      today: asOf,
      getModels,
      getFactModels: undefined,
      interest: false,
      getTrades,
      getPresale,
      aptInfo,
      walkMinutes: null,
      onError: bump(errors),
      onSoft: bump(softs),
      onSoftOnce: (kind) => { if (!softs.has(kind)) bump(softs)(kind); },
      profile: null,
    });
  } catch (error) {
    log(`evaluateLotto threw: ${safeError(error)}`);
    exitCode = 1;
    continue;
  }

  const reason = evaluation.reason ?? '';
  log('');
  log(`--- 평가 (today=${asOf}) ---`);
  log(`판별: ${evaluation.status}`);
  log(`판별 근거: ${reason}`);
  log(`안전 마진(만원): ${evaluation.margin ?? '-'}`);
  log(`마진율: ${Number.isFinite(evaluation.marginRate) ? `${(evaluation.marginRate * 100).toFixed(1)}%` : '-'}`);
  log(`추정 시세(만원): ${evaluation.estimate ?? '-'}`);
  log(`보수 시세(근거 문구에서 읽음): ${grab(reason, /((?:보수 시세|하위 25% 시세) [\d.-]+억)/) ?? '-'}`);
  log(`시세 신뢰도: ${evaluation.confidence ?? '-'}`);
  log(`판단 주택형: 전용 ${evaluation.judgedArea ?? '-'}㎡ (최고 분양가 ${evaluation.topPrice ?? '-'}만원)`);
  log(`추정에 쓴 표본(근거 문구에서 읽음): ${grab(reason, /표본 (\d+)건/) ?? grab(reason, /같은 단지 거래 (\d+)건/) ?? '-'}건`);
  log(`비교 단지와 보정 후 가격(근거 문구에서 읽음): ${comparablesOf(reason) ?? '-'}`);
  log(`stationState=${evaluation.stationState ?? '-'} complexOutliers=${evaluation.complexOutliers ?? 0}`);
  const extras = Object.keys(evaluation).filter((k) => !['status', 'reason', 'topPrice', 'estimate', 'margin', 'marginRate', 'confidence', 'judgedArea', 'stationState', 'complexOutliers', 'shortReason', 'averagePrice', 'minPrice', 'modelPrices'].includes(k));
  if (extras.length) log(`기타 필드: ${extras.map((k) => `${k}=${JSON.stringify(evaluation[k])}`).join(' ')}`);
  log(`shortReason(카카오 문구용): ${evaluation.shortReason ?? '-'}`);

  const months = completeMonths(asOf, config.lotto.tradeMonths);
  log('');
  log('--- 거래 조회 기간 ---');
  log(`asOf=${asOf}, lotto.tradeMonths=${config.lotto.tradeMonths}, completeMonths(asOf)=${months.join(',')} (asOf가 속한 달은 제외)`);
  log(`실제 조회한 매매 월: ${[...window.saleMonths].sort().join(',') || '-'} (시군구 ${[...window.lawd].join(',') || '-'}) 행 ${window.saleRows}`);
  log(`실제 조회한 분양권전매 월: ${[...window.presaleMonths].sort().join(',') || '-'} 행 ${window.presaleRows}`);
  log(`조회된 거래일 범위: ${window.minDeal ?? '-'} ~ ${window.maxDeal ?? '-'}`);
  log(`cleanTrades 유지 기준: 거래월과 asOf의 차이 <= tradeMonths+1 (config), 연식은 asOf의 연도 기준`);

  // 배치의 긴급 알림 선택 로직. 배치는 접수 단계 시작일 당일(KST)에 로또만 보낸다.
  const record = { notice, status: evaluation.status, shortReason: evaluation.shortReason ?? evaluation.reason, reason: evaluation.reason, urgentDate: null };
  const urgent = selectUrgent([record], asOf, config.alertRegions);
  log('');
  log(`--- 긴급 알림 판단(selectUrgent, today=${asOf}) ---`);
  log(`이 날짜에 접수 단계가 시작하는가: ${notice.stages.some((s) => s.start === asOf)} | 상태=로또: ${evaluation.status === '로또'} | 긴급 알림 대상: ${urgent.length > 0}`);
  if (urgent.length > 0) log(`발송됐다면 단계: ${urgent[0].stage.name}`);
}

log('');
log(`errors=${[...errors].map(([k, c]) => `${k}:${c}`).join(',') || 'none'} soft=${[...softs].map(([k, c]) => `${k}:${c}`).join(',') || 'none'}`);
log(`molit sale rows total=${molit.stats().rows} presale rows total=${presale.stats().rows} apt_calls=${aptInfo.stats().calls}`);
process.exitCode = exitCode;
