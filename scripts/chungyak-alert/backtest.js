// 일회성 백테스트(버리는 브랜치용). 공고 하나를 "그날 배치가 돌았다면" 어떻게 판정했을지 본다.
// 운영 코드(collectApplyhome, evaluateLotto 등)를 그대로 부르고 today만 asOf로 바꾼다.
// 프로필, Notion, 카카오, Gmail 클라이언트는 만들지 않는다. 아무것도 보내거나 쓰지 않는다.
//
// 환경 변수: DATA_GO_KR_KEY(필수), BACKTEST_AS_OF(YYYY-MM-DD), BACKTEST_NAME(공고명 부분 문자열),
//   BACKTEST_LOOKBACK(선택, 수집 기간 일수. 기본은 config.lookbackDays), BACKTEST_LIST_ONLY=1(목록만 출력)
import { readFileSync } from 'node:fs';
import { ENDPOINTS, collectApplyhome, createModelLookup, fetchOdcloudAll } from './src/sources/applyhome.js';
import { createAptInfoClient } from './src/sources/apt-info.js';
import { createMolitClient, createPresaleClient } from './src/sources/molit.js';
import { averagePriceOf, evaluateLotto } from './src/lotto.js';
import {
  acquisitionTax, buildSubject, cleanTrades, estimateBestMargin, groupComplexes, localityConflict, monthsBetween,
  normalizeComplexName, parseLocality, readTradesFor, selectComparables, spreadOf, subjectLocality, weightedQuantile,
} from './src/market-estimate.js';
import { resolveAddress } from './src/sgg-codes.js';
import { isActive, selectUrgent } from './src/main.js';
import { isRental } from './src/rental.js';
import { formatModelPrices } from './src/price-facts.js';
import { completeMonths, decodeServiceKey, defaultSleep, kstToday, maskServiceKey, median, safeError } from './src/util.js';

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
// 매매 응답의 원본 건수와 취소 건수를 센다(파서가 취소 행을 조용히 버리는 양을 보려고). 응답은 그대로 돌려준다.
const rawTally = new Map();
const fetchFn = async (url, init) => {
  const response = await globalThis.fetch(url, init);
  const text = String(url);
  if (text.includes('RTMSDataSvcAptTrade') && response.ok) {
    try {
      const body = await response.clone().text();
      const params = new URL(text).searchParams;
      const id = `${params.get('LAWD_CD')}-${params.get('DEAL_YMD')}`;
      const cur = rawTally.get(id) ?? { items: 0, cancelled: 0, total: null };
      cur.items += [...body.matchAll(/<item>/g)].length;
      cur.cancelled += [...body.matchAll(/<cdealType>\s*[^<\s]/g)].length;
      // 원본 응답에 래미안·아이파크 또는 지번 20-4 항목이 있는지(파서가 버리는지 보려고) 항목을 그대로 모은다. 공개 실거래 자료다.
      for (const [, block] of body.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        if (/래미안|아이파크|<jibun>\s*20-4\s*<\/jibun>/.test(block)) (cur.raw ??= []).push(block.replace(/\s+/g, ' ').replace(/<(\w+)>([^<]*)<\/\1>/g, '$1=$2;').replace(/<[^>]+>/g, '').slice(0, 400));
      }
      cur.total = Number(/<totalCount>(\d+)<\/totalCount>/.exec(body)?.[1] ?? NaN);
      rawTally.set(id, cur);
    } catch { /* 진단용이라 실패해도 판정과 무관하다 */ }
  }
  return response;
};
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

const window = { saleMonths: new Set(), presaleMonths: new Set(), saleRows: 0, presaleRows: 0, minDeal: null, maxDeal: null, lawd: new Map() };
// 코드별 매매 행을 캐시한다. 평가가 끝난 뒤 같은 readTradesFor를 다시 불러 실제로 쓴 거래 수를 보되 네트워크는 다시 타지 않는다.
const tradeCache = new Map();
const track = (rows) => {
  for (const row of rows) {
    if (!row.dealDate) continue;
    if (!window.minDeal || row.dealDate < window.minDeal) window.minDeal = row.dealDate;
    if (!window.maxDeal || row.dealDate > window.maxDeal) window.maxDeal = row.dealDate;
  }
};
const getTrades = async (code, months) => {
  const cacheKey = `${code}|${months.join(',')}`;
  if (tradeCache.has(cacheKey)) return tradeCache.get(cacheKey);
  months.forEach((m) => window.saleMonths.add(m));
  const rows = await molit.getTrades(code, months);
  window.lawd.set(code, (window.lawd.get(code) ?? 0) + rows.length);
  window.saleRows += rows.length;
  track(rows);
  tradeCache.set(cacheKey, rows);
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
  const match = /보정 후 [\d.]+㎡ 기준[^:]*: (.*?); (?:보수 시세|하위 25% 시세)/.exec(reason ?? '');
  return match ? match[1] : null;
};
const grab = (reason, re) => re.exec(reason ?? '')?.[1] ?? null;

// ---- 진단(이 브랜치 전용). 운영 함수의 입력과 중간값을 그대로 찍는다. 공개 자료(공고, 국토부 실거래)만 출력한다. ----
const BRAND = config.market.adjustment.brand;
const eokText = (m) => (Number.isFinite(m) ? `${(m / 10000).toFixed(2)}억` : '-');
const distinctiveLen = (name) => {
  let rest = name;
  for (const keyword of [...BRAND.nameKeywords.top, ...BRAND.nameKeywords.mid]) rest = rest.replaceAll(normalizeComplexName(keyword), '');
  return rest.length;
};
const subjectJibunOf = (address, umd, village) => {
  const place = village ?? umd;
  if (!place) return null;
  const tokens = String(address ?? '').replace(/[(),]/g, ' ').trim().split(/\s+/);
  const next = tokens[tokens.indexOf(place) + 1] ?? '';
  return /^\d+(-\d+)?$/.test(next) ? next : null;
};
const finestOf = (p) => p.village ?? p.dong ?? p.town;
// sameComplexRows(src/market-estimate.js)의 행마다 판단을 그대로 풀어 쓴 것. 이유 문구를 함께 돌려준다.
function sameWhy(subject, row) {
  const place = subjectLocality(subject);
  const rowPlace = parseLocality(row.umd);
  if (localityConflict(place, rowPlace)) return { ok: false, why: `위치 충돌(공고 동=${place.dong ?? place.town ?? '-'} vs 행 umd=${row.umd})` };
  const sameFinest = !localityConflict(place, rowPlace) && Boolean(finestOf(place)) && finestOf(place) === finestOf(rowPlace);
  if (subject.jibun && row.jibun && subject.jibun === row.jibun && sameFinest) return { ok: true, why: `지번 일치(${row.jibun})` };
  const sharesPlace = (!rowPlace.town && !rowPlace.village && !rowPlace.dong) || ['town', 'village', 'dong'].some((part) => place[part] && place[part] === rowPlace[part]);
  const allowSubstring = Boolean(finestOf(place)) && sharesPlace;
  const left = normalizeComplexName(subject.name);
  const right = normalizeComplexName(row.aptName);
  if (!left || !right) return { ok: false, why: '이름 없음' };
  if (left === right) return { ok: true, why: `정규화 이름 동일(${left})` };
  if (!allowSubstring) return { ok: false, why: `이름 불일치(${left} vs ${right}), 부분 일치 불허(공고 동 ${place.dong ?? '-'}, 행 umd ${row.umd}, 지번 공고 ${subject.jibun ?? '-'} 행 ${row.jibun || '-'})` };
  const shorter = left.length < right.length ? left : right;
  const longer = shorter === left ? right : left;
  const lenOk = shorter.length >= config.market.sameComplex.minNameLength;
  const distOk = distinctiveLen(shorter) >= config.market.sameComplex.minDistinctiveLength;
  const inc = longer.includes(shorter);
  return { ok: lenOk && distOk && inc, why: `부분 일치 검사: 짧은쪽=${shorter}(길이 ${shorter.length}>=${config.market.sameComplex.minNameLength}:${lenOk}, 고유길이 ${distinctiveLen(shorter)}>=${config.market.sameComplex.minDistinctiveLength}:${distOk}) 포함=${inc}` };
}
const recency = (row, today) => 0.5 ** (Math.max(monthsBetween(row.dealDate, today), 0) / config.market.tradeFilter.recencyHalfLifeMonths);
// unitsOf와 같은 계산(㎡당 단가, 최근 거래 가중, 25% 이상치 제거). 제거된 행도 돌려준다.
function unitsDiag(rows, today) {
  const items = rows.map((row) => ({ value: row.amount / row.area, weight: row.dealDate ? recency(row, today) : 1, row }));
  const f = config.market.tradeFilter;
  if (items.length < f.outlierMinSamples) return { kept: items, dropped: [] };
  const mid = median(items.map((i) => i.value));
  const kept = items.filter((i) => Math.abs(i.value - mid) <= mid * f.outlierBand);
  return { kept, dropped: items.filter((i) => !kept.includes(i)) };
}
const rowText = (r) => `${r.dealDate} ${r.umd} ${r.aptName} jibun=${r.jibun || '-'} seq=${r.aptSeq || '-'} 전용${r.area}㎡ ${r.floor ?? '-'}층 ${r.amount}만 ${r.buildYear ?? '-'}년 ${r.dealingGbn || '-'}${r.presale ? ' [분양권]' : ''}`;

// 같은 단지 거래가 6개월 창에 없는 까닭을 보려고 더 긴 기간을 읽는다. 실행 한 번에 한 번만 한다.
let wideDone = false;
async function wideScan({ addr, asOf, notice, realRe }) {
  if (wideDone) return;
  wideDone = true;
  const code = addr.codes[0];
  const months = [];
  for (let y = 2019; y <= 2026; y += 1) for (let m = 1; m <= 12; m += 1) {
    const ym = `${y}${String(m).padStart(2, '0')}`;
    if (ym >= '202301' && ym <= '202611') months.push(ym);
  }
  const jibunText = (/\d+(?:-\d+)?(?=번지)/.exec(notice.address) ?? [null])[0];
  log('');
  log(`--- 진단: 넓은 기간 스캔(코드 ${code}, ${months[0]}~${months.at(-1)} ${months.length}개월) ---`);
  log(`공고 주소 "${notice.address}" 에서 번지 숫자=${jibunText ?? '-'} (운영 subjectJibun은 '번지'가 붙은 토큰을 지번으로 읽지 못해 null)`);
  const all = [];
  const perMonth = [];
  for (const ym of months) {
    try {
      const rows = await molit.getTrades(code, [ym]);
      all.push(...rows);
      const hit = rows.filter((r) => realRe.test(normalizeComplexName(r.aptName)) || (jibunText && r.umd === addr.umd && r.jibun === jibunText));
      perMonth.push(`${ym}:${rows.length}/${hit.length}`);
    } catch (error) {
      perMonth.push(`${ym}:ERR(${safeError(error)})`);
    }
  }
  log(`월별 송파구 행수/이름·지번 후보 행수: ${perMonth.join(' ')}`);
  log(`월별 원본 응답 item/취소(cdealType 값 있음)/totalCount: ${[...rawTally].sort().map(([id, t]) => `${id.slice(6)}=${t.items}/${t.cancelled}/${t.total}`).join(' ')}`);
  const rawHits = [...rawTally].filter(([, t]) => t.raw?.length);
  log(`원본 응답에서 '래미안'·'아이파크' 또는 지번 20-4를 담은 item이 있는 월 ${rawHits.length}개:`);
  for (const [id, t] of rawHits.sort()) for (const line of t.raw.slice(0, 12)) log(`  RAWITEM ${id} ${line}`);
  const groups = new Map();
  for (const r of all.filter((x) => realRe.test(normalizeComplexName(x.aptName)) || (jibunText && x.umd === addr.umd && x.jibun === jibunText))) {
    const k = `${r.umd}|${r.aptName}|${r.jibun}|${r.aptSeq}|${r.buildYear}`;
    const g = groups.get(k) ?? { n: 0, min: r.dealDate, max: r.dealDate, areas: new Map() };
    g.n += 1; g.min = r.dealDate < g.min ? r.dealDate : g.min; g.max = r.dealDate > g.max ? r.dealDate : g.max;
    g.areas.set(r.area, (g.areas.get(r.area) ?? 0) + 1);
    groups.set(k, g);
  }
  log(`넓은 기간 이름(/${realRe.source}/)·지번(${jibunText ?? '-'}) 후보 묶음 ${groups.size}개:`);
  for (const [k, g] of groups) log(`  ${k} 건수=${g.n} 거래일 ${g.min}~${g.max} 전용별=${[...g.areas].sort((a, b) => a[0] - b[0]).map(([a, n]) => `${a}:${n}`).join(' ')}`);
  const inUmd = new Map();
  for (const r of all.filter((x) => x.umd === addr.umd)) {
    const k = `${r.aptName}|${r.jibun}|${r.buildYear}`;
    const g = inUmd.get(k) ?? { n: 0, min: r.dealDate, max: r.dealDate };
    g.n += 1; g.min = r.dealDate < g.min ? r.dealDate : g.min; g.max = r.dealDate > g.max ? r.dealDate : g.max;
    inUmd.set(k, g);
  }
  log(`${addr.umd}의 단지(aptNm|jibun|건축년도) ${inUmd.size}종, 같은 기간 건수·거래일 범위:`);
  for (const [k, g] of [...inUmd].sort((a, b) => b[1].n - a[1].n)) log(`  ${k} ${g.n}건 ${g.min}~${g.max}`);
  // 건축년도가 최근인 큰 단지(신축)가 이름이 다르게 등록됐을 가능성: 송파구 건축년도 2024 이상 단지
  const fresh = new Map();
  for (const r of all.filter((x) => x.buildYear >= 2023)) {
    const k = `${r.umd}|${r.aptName}|${r.jibun}|${r.buildYear}`;
    const g = fresh.get(k) ?? { n: 0, min: r.dealDate, max: r.dealDate };
    g.n += 1; g.min = r.dealDate < g.min ? r.dealDate : g.min; g.max = r.dealDate > g.max ? r.dealDate : g.max;
    fresh.set(k, g);
  }
  log(`송파구 건축년도 2023 이상 단지 ${fresh.size}종:`);
  for (const [k, g] of [...fresh].sort((a, b) => b[1].n - a[1].n)) log(`  ${k} ${g.n}건 ${g.min}~${g.max}`);
  // 분양권 전매(입주 전·직후 거래가 여기에 잡힌다)
  try {
    const pm = months.filter((ym) => ym >= '202401');
    const pre = await presale.getTrades(code, pm);
    const pg = new Map();
    for (const r of pre.rows) {
      const k = `${r.umd}|${r.aptName}|${r.jibun}`;
      const g = pg.get(k) ?? { n: 0, min: r.dealDate, max: r.dealDate };
      g.n += 1; g.min = r.dealDate < g.min ? r.dealDate : g.min; g.max = r.dealDate > g.max ? r.dealDate : g.max;
      pg.set(k, g);
    }
    log(`분양권 전매 ${pm[0]}~${pm.at(-1)} 송파구 ok=${pre.ok} 행 ${pre.rows.length}건, 단지 ${pg.size}종:`);
    for (const [k, g] of [...pg].sort((a, b) => b[1].n - a[1].n).slice(0, 30)) log(`  ${k} ${g.n}건 ${g.min}~${g.max}`);
  } catch (error) { log(`분양권 스캔 실패: ${safeError(error)}`); }
}

async function diagnose({ notice, models, addr, asOf, getTrades, getPresale, evaluation }) {
  const realRe = new RegExp(env.BACKTEST_REAL ?? '래미안아이파크');
  log('');
  log('--- 진단: 거래 조회와 필터 ---');
  const months = completeMonths(asOf, config.lotto.tradeMonths);
  const read = await readTradesFor(getTrades, { codes: addr.codes, fallbackCode: addr.fallbackCode }, months, { umd: addr.umd, village: addr.village });
  const trades = read.rows;
  log(`월별 원본(응답 item 수 / 취소(cdealType) / totalCount) 코드 ${read.codes.join(',')}: ${months.map((m) => { const t = rawTally.get(`${read.codes[0]}-${m}`); return `${m}=${t ? `${t.items}/${t.cancelled}/${t.total}` : '-'}`; }).join(' ')}`);
  log(`MOLIT 매매 파싱 행(취소 제외) = ${trades.length}건 (코드 ${read.codes.join(',')}, 월 ${months.join(',')})`);
  const presaleRead = await getPresale(read.codes[0], months);
  log(`분양권 전매 행 = ${presaleRead.rows.length}건 ok=${presaleRead.ok}`);
  const allRaw = [...trades, ...presaleRead.rows];
  // 판정과 같은 순서의 cleanTrades 필터를 단계별로 센다.
  const filter = config.market.tradeFilter;
  const steps = [];
  let cur = allRaw;
  const step = (name, test) => { const next = cur.filter(test); steps.push(`${name}: -${cur.length - next.length} -> ${next.length}`); cur = next; };
  steps.push(`시작(매매 ${trades.length} + 분양권 ${presaleRead.rows.length}) = ${allRaw.length}`);
  step('취소·토지임대부 제외', (r) => !(r.cancelled || r.landLease));
  step('직거래 제외', (r) => !String(r.dealingGbn ?? '').includes('직거래'));
  step(`저층(<=${filter.lowFloorMax}층) 제외`, (r) => !(Number.isFinite(r.floor) && r.floor <= filter.lowFloorMax));
  step(`조회 기간 밖(>${config.lotto.tradeMonths + 1}개월) 제외`, (r) => !(r.dealDate && monthsBetween(r.dealDate, asOf) > config.lotto.tradeMonths + 1));
  step('금액·면적 무효 제외', (r) => r.amount > 0 && r.area > 0);
  log(`필터 단계: ${steps.join(' | ')}`);
  const rows = cleanTrades(allRaw, { market: config.market, lotto: config.lotto, today: asOf });
  log(`cleanTrades 결과 = ${rows.length}건 (단계 재현과 ${rows.length === cur.length ? '일치' : '불일치!'})`);

  const jibun = subjectJibunOf(notice.address, addr.umd, addr.village);
  const subject = buildSubject({ name: notice.name, builder: notice.builder, umd: addr.umd, village: addr.village, jibun, walkMinutes: null, market: config.market });
  log(`subject: name="${notice.name}" 정규화="${normalizeComplexName(notice.name)}" (길이 ${normalizeComplexName(notice.name).length}, 고유길이 ${distinctiveLen(normalizeComplexName(notice.name))}) umd=${subject.umd} jibun=${subject.jibun ?? '-'} brandTier=${subject.brandTier} ageYears=${subject.ageYears}`);
  log(`임계: sameComplex.minNameLength=${config.market.sameComplex.minNameLength} minDistinctiveLength=${config.market.sameComplex.minDistinctiveLength} minSamples=${config.market.sameComplex.minSamples} highSamples=${config.market.sameComplex.highSamples} highSpread=${config.market.sameComplex.highSpread} areaToleranceM2=${config.lotto.areaToleranceM2} outlierBand=${filter.outlierBand}`);

  // 같은 단지로 보이는 후보 묶음(이름에 realRe, 또는 공고 지번과 같은 지번)을 전체 거래(필터 전)에서 센다.
  const looksReal = (r) => realRe.test(normalizeComplexName(r.aptName)) || (jibun && r.jibun === jibun && r.umd === addr.umd);
  const groupsRaw = new Map();
  for (const r of allRaw.filter(looksReal)) {
    const k = `${r.umd}|${r.aptName}|${r.jibun}|${r.aptSeq}|${r.buildYear}`;
    const g = groupsRaw.get(k) ?? { n: 0, areas: new Map() };
    g.n += 1;
    g.areas.set(r.area, (g.areas.get(r.area) ?? 0) + 1);
    groupsRaw.set(k, g);
  }
  log(`필터 전 전체 ${allRaw.length}건 중 이름에 /${realRe.source}/ 포함 또는 공고 지번(${jibun ?? '-'}) 일치 후보 묶음 ${groupsRaw.size}개:`);
  for (const [k, g] of groupsRaw) log(`  [umd|aptNm|jibun|aptSeq|건축년도] ${k} 건수=${g.n} 전용별 건수=${[...g.areas].sort((a, b) => a[0] - b[0]).map(([a, n]) => `${a}:${n}`).join(' ')}`);
  const umdCounts = new Map();
  for (const r of trades) umdCounts.set(r.umd, (umdCounts.get(r.umd) ?? 0) + 1);
  log(`송파구 매매 행의 법정동(umdNm) 분포: ${[...umdCounts].sort((a, b) => b[1] - a[1]).map(([u, n]) => `${u}=${n}`).join(' ')}`);
  const nearDistinctNames = new Set(trades.filter((r) => /잠실|래미안|아이파크/.test(r.aptName)).map((r) => `${r.umd}|${r.aptName}|${r.jibun}`));
  log(`aptNm에 잠실·래미안·아이파크가 들어간 (umd|aptNm|jibun) 종류 ${nearDistinctNames.size}개: ${[...nearDistinctNames].sort().join(' ; ')}`);

  await wideScan({ addr, asOf, notice, realRe });
  const ctx = { market: config.market, lotto: config.lotto, today: asOf };
  const priced = models.filter((m) => m.area > 0 && m.price > 0);
  for (const model of priced) {
    log('');
    log(`#### 주택형 ${model.houseType} 전용 ${model.area}㎡ 최고 분양가 ${model.price}만원(${eokText(model.price)}) 세대 ${model.households ?? '-'}`);
    const near = rows.filter((r) => Math.abs(r.area - model.area) <= config.lotto.areaToleranceM2);
    log(`  면적 허용오차 ±${config.lotto.areaToleranceM2}㎡ 안 거래(필터 후) = ${near.length}건 / 필터 후 전체 ${rows.length}건`);
    // 같은 단지 경로: sameComplexRows와 같은 판단을 행마다 한다. 묶음별로 요약한다.
    const verdict = new Map();
    for (const r of near) {
      const v = sameWhy(subject, r);
      const k = `${r.umd}|${r.aptName}|${r.jibun || '-'}`;
      const e = verdict.get(k) ?? { ok: v.ok, why: v.why, n: 0 };
      e.n += 1;
      verdict.set(k, e);
    }
    const accepted = near.filter((r) => sameWhy(subject, r).ok);
    log(`  같은 단지로 받은 행 = ${accepted.length}건`);
    const interesting = [...verdict].filter(([k, v]) => v.ok || realRe.test(normalizeComplexName(k.split('|')[1])) || /잠실/.test(k));
    for (const [k, v] of interesting) log(`   ${v.ok ? '받음' : '거절'} [${k}] ${v.n}건: ${v.why}`);
    // 면적 허용오차에 걸려 빠진 같은 단지 후보(필터 후, 허용오차 밖)
    const lookReal = rows.filter(looksReal);
    const outOfTol = lookReal.filter((r) => Math.abs(r.area - model.area) > config.lotto.areaToleranceM2);
    log(`  이름·지번이 같은 단지 후보 중 필터 후 총 ${lookReal.length}건, 이 주택형 면적 허용오차 밖 ${outOfTol.length}건. 허용오차 밖 면적 분포: ${[...outOfTol.reduce((m, r) => m.set(r.area, (m.get(r.area) ?? 0) + 1), new Map())].sort((a, b) => a[0] - b[0]).map(([a, n]) => `${a}:${n}`).join(' ') || '-'}`);
    const sameUnits = unitsDiag(accepted, asOf);
    const need = config.market.sameComplex.minSamples;
    const spread = sameUnits.kept.length > 0 ? spreadOf(sameUnits.kept.map((i) => i.value)) : null;
    log(`  같은 단지 경로: 받은 ${accepted.length}건 -> 이상치(중위 ±${filter.outlierBand * 100}%) 제거 ${sameUnits.dropped.length}건 -> 사용 ${sameUnits.kept.length}건, 최소 ${need}건 필요 => ${sameUnits.kept.length >= need ? '채택' : '불채택'} spread=${spread === null ? '-' : spread.toFixed(3)}`);
    if (sameUnits.kept.length >= need) {
      const est = Math.round(weightedQuantile(sameUnits.kept, 0.5) * model.area);
      const low = Math.round(weightedQuantile(sameUnits.kept, 0.25) * model.area);
      log(`  같은 단지 경로 값: 추정 ${est}만 하위25% ${low}만 마진(옵션 ${config.market.optionCostManwon}, 취득세 ${acquisitionTax(model.price, config.market.acquisitionTax)}) = ${low - model.price - config.market.optionCostManwon - acquisitionTax(model.price, config.market.acquisitionTax)}만`);
    }
    for (const r of accepted.slice(0, 12)) log(`    받은 거래: ${rowText(r)}`);
    for (const i of sameUnits.dropped) log(`    이상치로 제거: ${rowText(i.row)} 단가 ${i.value.toFixed(1)}만/㎡`);
    // 비교 단지 경로
    const groups = groupComplexes(rows, model.area, ctx);
    const scoped = selectComparables(groups, subject, ctx);
    log(`  비교 단지 묶음 ${groups.length}개(면적 허용오차 안, 단지당 표본 >= ${config.market.comparables.minComplexSamples}). selectComparables: ${scoped ? `범위=${scoped.scope} 연식단계=${scoped.ageStep} maxAge=${scoped.maxAge} scopePenalty=${scoped.scopePenalty} townWide=${scoped.townWide} 고른 ${scoped.picked.length}곳` : '없음'}`);
    const showGroup = (g, mark) => log(`    ${mark} ${g.aptName} | ${g.umd} | 지번 ${g.jibun ?? '-'} | 연식 ${g.ageYears ?? '-'}년 | 브랜드 ${g.brandTier} | 표본 ${g.samples} | 단지 중위 ${g.unit.toFixed(1)}만/㎡ => ${Math.round(g.unit * model.area)}만(${eokText(g.unit * model.area)}) 이 주택형 면적 기준`);
    for (const g of [...groups].sort((a, b) => b.samples - a.samples).slice(0, 25)) showGroup(g, scoped?.picked.includes(g) ? '[채택]' : '[후보]');
    // 이 주택형만 단독으로 estimateBestMargin을 돌려 후보를 본다(preferConfident=true, 운영과 같다).
    const cand = estimateBestMargin({ models: [model], rows, subject, stations: new Map(), stationLookupFailed: false, presaleOk: presaleRead.ok, crossWard: read.crossWard, preferConfident: true, lotto: config.lotto, market: config.market, today: asOf });
    if (!cand) log('  estimateBestMargin(이 주택형만) = null');
    else {
      log(`  estimateBestMargin(이 주택형만): 경로=${cand.basis.kind} 추정 ${cand.estimate}만 보수 ${cand.safeValue}만 분양가 ${cand.price}만 취득세 ${cand.tax}만 옵션 ${cand.optionCost}만 => 안전 마진 ${cand.margin}만 마진율 ${(cand.marginRate * 100).toFixed(1)}% 신뢰도 ${cand.confidence}${cand.confidenceBeforeLookupFailure ? `(조회실패 전 ${cand.confidenceBeforeLookupFailure})` : ''}`);
      if (cand.basis.kind === 'comparables') {
        log(`    할인율 ${(cand.discount * 100).toFixed(1)}% 측정=${cand.discountMeasured} 초과=${cand.discountExceeded} 단지 이상치 제외 ${cand.outliers}곳 범위=${cand.basis.scope} 표본 ${cand.basis.samples}건`);
        for (const c of cand.basis.comparables) log(`    비교 단지 ${c.name} 표본 ${c.samples} 보정 후 ${c.reference}만(${eokText(c.reference)}) 브랜드 ${(c.brandRatio * 100 - 100).toFixed(1)}% 연식 ${(c.ageRatio * 100 - 100).toFixed(1)}%`);
      }
    }
    // 대조: 실제 단지라고 보이는 거래만으로 계산했다면(이름·지번 후보, 같은 면적 허용오차 안)
    const real = near.filter(looksReal);
    const realUnits = unitsDiag(real, asOf);
    if (realUnits.kept.length > 0) {
      const est = Math.round(weightedQuantile(realUnits.kept, 0.5) * model.area);
      const low = Math.round(weightedQuantile(realUnits.kept, 0.25) * model.area);
      const tax = acquisitionTax(model.price, config.market.acquisitionTax);
      log(`  [대조] 이름·지번 후보(${real.length}건, 이상치 제거 후 ${realUnits.kept.length}건) 기준: 추정 ${est}만(${eokText(est)}) 하위25% ${low}만 취득세 ${tax}만 => 마진 ${low - model.price - config.market.optionCostManwon - tax}만 (마진율 ${(((low - model.price - config.market.optionCostManwon - tax) / model.price) * 100).toFixed(1)}%)`);
      for (const r of real.sort((a, b) => (b.dealDate > a.dealDate ? 1 : -1)).slice(0, 15)) log(`    ${rowText(r)}`);
    } else log('  [대조] 이 면적 허용오차 안에 이름·지번 후보 거래가 없다');
  }
  // 모든 주택형을 함께 넣은 운영 호출. 평가 결과와 같아야 한다.
  const all = estimateBestMargin({ models, rows, subject, stations: new Map(), stationLookupFailed: false, presaleOk: presaleRead.ok, crossWard: read.crossWard, preferConfident: true, lotto: config.lotto, market: config.market, today: asOf });
  log('');
  log(`전체 주택형으로 estimateBestMargin: ${all ? `${all.houseType} 전용 ${all.area} 분양가 ${all.price} 추정 ${all.estimate} 마진 ${all.margin} 신뢰도 ${all.confidence} 경로 ${all.basis.kind}` : 'null'} | evaluateLotto: 판단 주택형 전용 ${evaluation.judgedArea} 마진 ${evaluation.margin} 추정 ${evaluation.estimate}`);
}

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

  const addr = resolveAddress(notice.address, notice.region);
  log(`resolveAddress: region=${addr.region} codes=${addr.codes.join(',') || '-'} fallbackCode=${addr.fallbackCode ?? '-'} umd=${addr.umd ?? '-'} village=${addr.village ?? '-'}`);

  let models = null;
  try {
    models = await getModels(notice);
    log('주택형별 분양가(청약홈 getAPTLttotPblancMdl, 최고분양가):');
    for (const m of models) log(`  ${m.houseType} | 전용 ${m.area}㎡ | ${m.price}만원 | ${m.households ?? '-'}세대`);
    log(`  요약: ${formatModelPrices(models)}`);
    log(`  averagePrice(세대수 가중, Notion 평균 분양가에 쓰는 값)=${averagePriceOf(models)}만원`);
    // 청약홈 주택형 원본 행. 면적 필드를 정확히 보려고 모든 필드를 찍는다(공개 공고 자료).
    try {
      const rawRows = await fetchOdcloudAll({
        fetch: fetchFn, key, op: notice.mdlOp, sleep,
        params: { 'cond[HOUSE_MANAGE_NO::EQ]': notice.houseManageNo, 'cond[PBLANC_NO::EQ]': notice.pblancNo },
      });
      log(`  청약홈 주택형 원본 행 ${rawRows.length}건(${notice.mdlOp}):`);
      for (const row of rawRows) log(`    RAW ${JSON.stringify(row)}`);
    } catch (error) {
      log(`  원본 주택형 조회 실패: ${safeError(error)}`);
    }
  } catch (error) {
    log(`주택형 조회 실패: ${safeError(error)}`);
  }

  if (!isActive(notice, asOf)) log('NOTE: 배치는 접수가 끝난 공고를 판별하지 않는다(isActive=false). 그래도 평가는 실행한다.');
  if (isRental(notice, config)) log('NOTE: 배치는 임대 공고를 판별 전에 뺀다. 그래도 평가는 실행한다.');

  window.saleMonths.clear();
  window.presaleMonths.clear();
  Object.assign(window, { saleRows: 0, presaleRows: 0, minDeal: null, maxDeal: null });
  window.lawd.clear();
  tradeCache.clear();

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
  log(`실제 조회한 매매 월: ${[...window.saleMonths].sort().join(',') || '-'} 행 ${window.saleRows}`);
  log(`시군구 코드별 조회 행(매매): ${[...window.lawd].map(([code, n]) => `${code}=${n}`).join(' ') || '-'}`);
  {
    // 평가가 쓴 것과 같은 함수·같은 입력으로 실제로 쓴 거래를 다시 읽는다(캐시라 네트워크 호출 없음).
    const read = await readTradesFor(getTrades, { codes: addr.codes, fallbackCode: addr.fallbackCode }, months, { umd: addr.umd, village: addr.village });
    const usedFallback = Boolean(addr.fallbackCode) && read.codes.length === 1 && read.codes[0] === addr.fallbackCode && !addr.codes.includes(addr.fallbackCode);
    log(`readTradesFor: 쓴 코드=${read.codes.join(',') || '-'} 거래 ${read.rows.length}건 crossWard=${read.crossWard} 구 코드 대신 시 코드(fallback) 사용=${usedFallback}`);
  }
  log(`실제 조회한 분양권전매 월: ${[...window.presaleMonths].sort().join(',') || '-'} 행 ${window.presaleRows}`);
  log(`조회된 거래일 범위: ${window.minDeal ?? '-'} ~ ${window.maxDeal ?? '-'}`);
  log(`cleanTrades 유지 기준: 거래월과 asOf의 차이 <= tradeMonths+1 (config), 연식은 asOf의 연도 기준`);

  if (models) {
    try {
      await diagnose({ notice, models, addr, asOf, getTrades, getPresale, evaluation });
    } catch (error) {
      log(`diagnose threw: ${safeError(error)} ${error?.stack?.split('\n').slice(0, 3).join(' / ')}`);
    }
  }

  // 배치의 긴급 알림 선택 로직. 배치는 접수 단계 시작일 당일(KST)에 로또만 보낸다.
  const record = { notice, status: evaluation.status, shortReason: evaluation.shortReason ?? evaluation.reason, reason: evaluation.reason, urgentDate: null };
  const urgent = selectUrgent([record], asOf, config.alertRegions, { requireTrack: false });
  log('');
  log(`--- 긴급 알림 판단(selectUrgent requireTrack=false, today=${asOf}) ---`);
  log(`이 날짜에 접수 단계가 시작하는가: ${notice.stages.some((s) => s.start === asOf)} | 상태=로또: ${evaluation.status === '로또'} | 긴급 알림 대상: ${urgent.length > 0}`);
  if (urgent.length > 0) log(`발송됐다면 단계: ${urgent[0].stage.name}`);
}

log('');
log(`errors=${[...errors].map(([k, c]) => `${k}:${c}`).join(',') || 'none'} soft=${[...softs].map(([k, c]) => `${k}:${c}`).join(',') || 'none'}`);
log(`molit sale rows total=${molit.stats().rows} presale rows total=${presale.stats().rows} apt_calls=${aptInfo.stats().calls}`);
process.exitCode = exitCode;
