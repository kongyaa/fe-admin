// 일회성 시세 감사(버리는 브랜치용). 최근 청약 공고 전체에 대해 "시세가 틀리게 잡힐 수 있는" 경우를 읽기 전용으로 센다.
// 운영 코드(collectApplyhome, evaluateLotto, estimateBestMargin, gradeNotice)를 그대로 부르고 today만 asOf로 바꾼다.
// 프로필, Notion, 카카오, Gmail 클라이언트는 만들지 않는다. 아무것도 보내거나 쓰지 않는다. 공개 자료(공고, 국토부 실거래)의 건수·비율만 출력한다.
//
// 환경 변수: DATA_GO_KR_KEY(필수), AUDIT_AS_OF(YYYY-MM-DD), AUDIT_LOOKBACK(수집 기간 일수, 기본 90),
//   AUDIT_NAME(선택, 공고명 부분 문자열), AUDIT_MAX(선택, 대상 상한), AUDIT_WINDOWS=0이면 12·24개월 창을 읽지 않는다.
import { readFileSync } from 'node:fs';
import { ENDPOINTS, collectApplyhome, createModelLookup } from './src/sources/applyhome.js';
import { createMolitClient, createPresaleClient } from './src/sources/molit.js';
import { evaluateLotto } from './src/lotto.js';
import {
  buildSubject, cleanTrades, estimateBestMargin, groupComplexes, monthsBetween, parseLocality, readPresaleByCodes, readTradesFor,
  restrictedType, sameComplexRows, selectComparables, subjectLocality,
} from './src/market-estimate.js';
import { resolveAddress } from './src/sgg-codes.js';
import { gradeNotice } from './src/grade.js';
import { isRental } from './src/rental.js';
import { completeMonths, decodeServiceKey, defaultSleep, kstToday, maskServiceKey, normalizeDate, parseNumber, safeError } from './src/util.js';

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const env = process.env;
const log = (line = '') => console.log(line);

const asOf = env.AUDIT_AS_OF ?? '';
const nameContains = (env.AUDIT_NAME ?? '').trim();
const lookbackDays = Number(env.AUDIT_LOOKBACK) > 0 ? Number(env.AUDIT_LOOKBACK) : 90;
const maxTargets = Number(env.AUDIT_MAX) > 0 ? Number(env.AUDIT_MAX) : Infinity;
const readWindows = env.AUDIT_WINDOWS !== '0';
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(asOf))) {
  log('usage: AUDIT_AS_OF=YYYY-MM-DD node audit.js');
  process.exit(2);
}
const key = decodeServiceKey(env.DATA_GO_KR_KEY);
if (!key) {
  log('DATA_GO_KR_KEY missing');
  process.exit(2);
}
maskServiceKey(env.DATA_GO_KR_KEY, env);
maskServiceKey(key, env);

const { market, lotto } = config;
const ctx = { market, lotto, today: asOf };
const sleep = defaultSleep;
const norm = (text) => String(text ?? '').replace(/[\s\-_]/g, '').toLowerCase();

// ---- 분양권 전매 원본 행(입주권 포함). 파서가 입주권을 버리므로 응답을 따로 읽는다. 페이지 단위로 담아 재시도로 중복되지 않게 한다. ----
const silvPages = new Map(); // `${code}-${ym}` -> Map(page -> rows)
const ownerTally = new Map(); // 구분별 원본 건수(조회 기간 전체)
const fetchFn = async (url, init) => {
  const response = await globalThis.fetch(url, init);
  const text = String(url);
  if (text.includes('RTMSDataSvcSilvTrade') && response.ok) {
    try {
      const body = await response.clone().text();
      const params = new URL(text).searchParams;
      const id = `${params.get('LAWD_CD')}-${params.get('DEAL_YMD')}`;
      const page = params.get('pageNo') ?? '1';
      const rows = [];
      for (const [, block] of body.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const tag = (n) => new RegExp(`<${n}>([\\s\\S]*?)</${n}>`).exec(block)?.[1]?.trim() ?? '';
        const own = tag('ownershipGbn') || tag('구분') || '?';
        ownerTally.set(own, (ownerTally.get(own) ?? 0) + 1);
        const dealDate = normalizeDate(`${tag('dealYear')}-${tag('dealMonth').padStart(2, '0')}-${tag('dealDay').padStart(2, '0')}`);
        rows.push({
          aptName: tag('aptNm'), umd: tag('umdNm'), buildYear: null, amount: parseNumber(tag('dealAmount')), area: parseNumber(tag('excluUseAr')),
          floor: parseNumber(tag('floor')), dealingGbn: tag('dealingGbn'), dealDate, jibun: tag('jibun'), aptSeq: tag('aptSeq'),
          landLease: false, presale: true, ownership: own, cancelled: Boolean(tag('cdealType')),
        });
      }
      if (!silvPages.has(id)) silvPages.set(id, new Map());
      silvPages.get(id).set(page, rows);
    } catch { /* 진단용이라 실패해도 판정과 무관하다 */ }
  }
  return response;
};
const silvRowsOf = (code, ym) => [...(silvPages.get(`${code}-${ym}`)?.values() ?? [])].flat();
const isIpju = (row) => String(row.ownership ?? '').includes('입');

// ---- 클라이언트. 첫 장애 뒤 막히는 래치가 감사를 망치지 않게 장애 때 새로 만든다(횟수는 센다). ----
const counters = new Map();
const bump = (name) => counters.set(name, (counters.get(name) ?? 0) + 1);
const mkMolit = () => createMolitClient({ fetch: fetchFn, key, sleep });
const mkPresale = () => createPresaleClient({ fetch: fetchFn, key, sleep, budgetMs: 8_000_000, onSoft: (kind) => bump(`soft:${kind}`) });
let molit = mkMolit();
let presale = mkPresale();
const tradeCache = new Map();
const quotaHit = { value: false };
const getTrades = async (code, months) => {
  const cacheKey = `${code}|${months.join(',')}`;
  if (tradeCache.has(cacheKey)) return tradeCache.get(cacheKey);
  let rows;
  try {
    rows = await molit.getTrades(code, months);
  } catch (error) {
    if (error?.kind === 'molit_timeout' || error?.kind === 'molit_network') {
      bump('molit_client_reset');
      molit = mkMolit();
      rows = await molit.getTrades(code, months);
    } else {
      if (/result_(22|20|30|31)/.test(String(error?.kind))) quotaHit.value = true;
      throw error;
    }
  }
  tradeCache.set(cacheKey, rows);
  return rows;
};
let presaleResets = 0;
const getPresale = async (code, months) => {
  let result = await presale.getTrades(code, months);
  if (!result.ok && presaleResets < 40) {
    presaleResets += 1;
    bump('presale_client_reset');
    presale = mkPresale();
    result = await presale.getTrades(code, months);
  }
  if (!result.ok) bump('presale_not_ok');
  return result;
};
const getModelsRaw = createModelLookup({ fetch: fetchFn, key, sleep });
const modelCache = new Map();
const getModels = async (notice) => {
  if (!modelCache.has(notice.key)) modelCache.set(notice.key, getModelsRaw(notice).then((m) => m, (e) => { modelCache.delete(notice.key); throw e; }));
  return modelCache.get(notice.key);
};

// ---- 보조 ----
function jibunInfo(address, umd, village) {
  const place = village ?? umd;
  if (!place) return { jibun: null, c1: false, c2: true, hasLot: false };
  const tokens = String(address ?? '').replace(/[(),]/g, ' ').trim().split(/\s+/);
  const index = tokens.indexOf(place);
  const next = index >= 0 ? tokens[index + 1] ?? '' : '';
  if (/^\d+(-\d+)?$/.test(next)) return { jibun: next, c1: false, c2: false, hasLot: true };
  const loose = /^\d+(-\d+)?/.test(next);
  return { jibun: null, c1: loose, c2: false, hasLot: loose };
}
const quantile = (values, q) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '-');
const eok = (m) => (Number.isFinite(m) ? `${(m / 10000).toFixed(1)}억` : '-');
const countTypes = (rows) => {
  const out = { sale: 0, presale: 0, ipju: 0 };
  for (const row of rows) {
    if (!row.presale) out.sale += 1;
    else if (isIpju(row)) out.ipju += 1;
    else out.presale += 1;
  }
  return out;
};
const totalOf = (c) => c.sale + c.presale + c.ipju;
const freshOf = (notice) => {
  const ym = String(notice.moveInYm ?? '');
  if (!/^\d{6}$/.test(ym)) return null;
  return monthsBetween(`${ym.slice(0, 4)}-${ym.slice(4)}-01`, asOf) <= 60;
};
const stageOf = (notice) => {
  if (notice.overallEnd && notice.overallEnd < asOf) return '마감';
  if (notice.overallStart && notice.overallStart > asOf) return '접수 전';
  return '접수 중';
};

// ---- 수집 ----
log(`audit asOf=${asOf} realToday(KST)=${kstToday()} lookbackDays=${lookbackDays} windows=${readWindows}`);
const collected = await collectApplyhome({ fetch: fetchFn, key, today: asOf, lookbackDays, sleep, endpoints: ENDPOINTS });
log(`collect errors=${collected.errors.join(',') || 'none'} failedAll=${collected.failedAll} raw=${collected.notices.length}`);
const announced = collected.notices.filter((notice) => !notice.announceDate || notice.announceDate <= asOf);
const inScope = announced.filter((n) => ['apt', 'remainder', 'arbitrary'].includes(n.kind) && config.alertRegions.includes(n.region) && !isRental(n, config));
const targets = inScope.filter((n) => !nameContains || norm(n.name).includes(norm(nameContains))).slice(0, maxTargets);
const kindCount = (list) => ['apt', 'remainder', 'arbitrary'].map((k) => `${k}=${list.filter((n) => n.kind === k).length}`).join(' ');
log(`announced<=asOf=${announced.length} inScope(수도권 apt/remainder/arbitrary, 임대 제외)=${inScope.length} [${kindCount(inScope)}] targets=${targets.length}`);
log(`stages: ${['접수 전', '접수 중', '마감'].map((s) => `${s}=${targets.filter((n) => stageOf(n) === s).length}`).join(' ')} moveInYm 있음=${targets.filter((n) => /^\d{6}$/.test(String(n.moveInYm ?? ''))).length}`);

const baseOpts = {
  config, today: asOf, getModels, getFactModels: undefined, interest: false, getTrades, getPresale, aptInfo: null, walkMinutes: null,
  onError: (kind) => bump(`error:${kind}`), onSoft: (kind) => bump(`soft:${kind}`), onSoftOnce: (kind) => bump(`softonce:${kind}`), profile: null,
};

// ---- 1단계: 운영 평가 + 6개월 창 분석 ----
const recs = [];
let index = 0;
for (const notice of targets) {
  index += 1;
  const rec = { i: index, name: notice.name, kind: notice.kind, type: notice.typeLabel, region: notice.region, stage: stageOf(notice), moveIn: notice.moveInYm || null, fresh: freshOf(notice), address: notice.address };
  recs.push(rec);
  try {
    const addr = resolveAddress(notice.address, notice.region);
    rec.codes = addr.codes.length;
    rec.umd = addr.umd ?? null;
    const restricted = restrictedType(notice, market);
    let models = null;
    try { models = await getModels(notice); } catch (error) { rec.modelsError = safeError(error); }
    const evaluation = await evaluateLotto(notice, baseOpts);
    const grade = gradeNotice({ evaluation, notice, walkMinutes: null, config });
    Object.assign(rec, { status: evaluation.status, grade: grade.grade, gradeDetail: grade.detail?.split(',')[0], margin: evaluation.margin ?? null, rate: evaluation.marginRate ?? null, conf: evaluation.confidence ?? null, estimate: evaluation.estimate ?? null, price: evaluation.topPrice ?? null });
    if (restricted) { rec.skip = `제한 유형(${restricted})`; continue; }
    if (addr.codes.length === 0) { rec.skip = '시군구 코드 미매핑'; continue; }
    if (!models) { rec.skip = '주택형 없음'; continue; }
    const priced = models.filter((m) => m.area > 0 && m.price > 0);
    if (priced.length === 0) { rec.skip = '분양가 있는 주택형 없음'; continue; }

    const info = jibunInfo(notice.address, addr.umd, addr.village);
    rec.jibun = info.jibun; rec.c1 = info.c1; rec.c2 = info.c2;
    const months6 = completeMonths(asOf, lotto.tradeMonths);
    const read = await readTradesFor(getTrades, { codes: addr.codes, fallbackCode: addr.fallbackCode }, months6, { umd: addr.umd, village: addr.village });
    const pre6 = await readPresaleByCodes(getPresale, read.codes, months6);
    rec.readCodes = read.codes.length; rec.crossWard = read.crossWard; rec.tradeRows6 = read.rows.length; rec.presaleOk = pre6.ok;
    const rows = cleanTrades([...read.rows, ...pre6.rows], ctx);
    const subject = buildSubject({ name: notice.name, builder: notice.builder, umd: addr.umd, village: addr.village, jibun: info.jibun, walkMinutes: null, market });
    const place = subjectLocality(subject);
    const common = { rows, subject, stations: new Map(), stationLookupFailed: false, presaleOk: pre6.ok, crossWard: read.crossWard, preferConfident: true, lotto, market, today: asOf };
    const perModel = priced.map((model) => ({ model, cand: estimateBestMargin({ ...common, models: [model] }) }));
    const best = estimateBestMargin({ ...common, models: priced });
    rec._data = { notice, addr, read, subject, perModel, best, priced };
    if (best) {
      rec.own = { path: best.basis.kind, scope: best.basis.scope ?? null, maxAge: best.basis.maxAge ?? null, widened: best.basis.widened ?? null, townWide: best.basis.townWide ?? null, conf: best.confidence, margin: best.margin, rate: best.marginRate, area: best.area, houseType: best.houseType, estimate: best.estimate, price: best.price, samples: best.basis.samples ?? null, complexes: best.basis.comparables?.length ?? null };
      if (best.basis.kind === 'comparables') {
        const scoped = selectComparables(groupComplexes(rows, best.area, ctx), subject, ctx);
        const picked = scoped?.picked ?? [];
        const same = picked.filter((c) => { const o = parseLocality(c.umd); return place.dong ? o.dong === place.dong : place.town ? o.town === place.town : false; });
        rec.own.pickedN = picked.length;
        rec.own.sameDongShare = picked.length > 0 ? same.length / picked.length : null;
      }
      if (evaluation.margin != null && notice.kind !== 'arbitrary' && evaluation.margin !== best.margin) { rec.mismatch = true; bump('own_vs_prod_margin_mismatch'); }
    }
    rec.models = perModel.map((p) => ({ type: p.model.houseType, area: p.model.area, price: p.model.price, path: p.cand?.basis.kind ?? null, conf: p.cand?.confidence ?? null, rate: p.cand?.marginRate ?? null }));
    // 시군구 상위값 대비(상식 검사). 12개월 매매(분양권 제외) ㎡당 상위 10%. 신축(5년 이내) 거래가 20건 이상이면 그것을 기준으로 본다.
    // 12개월 창은 2단계에서 읽는다. 여기서는 6개월 매매만으로 임시 값을 둔다.
  } catch (error) {
    rec.error = safeError(error);
    bump('audit_error');
  }
  if (index % 10 === 0) log(`... ${index}/${targets.length} calls: trades=${tradeCache.size} soft/err=${[...counters].map(([k, c]) => `${k}:${c}`).join(',') || 'none'}`);
}

// ---- 2단계: 12·24개월 창(같은 단지 표본)과 상식 검사용 12개월 시군구 거래 ----
const WINDOWS = readWindows ? [6, 12, 24] : [6];
let windowErrors = 0;
for (const rec of recs) {
  const data = rec._data;
  if (!data) continue;
  try {
    const { subject, read, perModel, best } = data;
    const byWindow = {};
    for (const W of WINDOWS) {
      const months = completeMonths(asOf, W);
      const sale = [];
      const silv = [];
      for (const code of read.codes) {
        sale.push(...(await getTrades(code, months)));
        if (W > 6 || W === 6) await getPresale(code, months);
        for (const ym of months) silv.push(...silvRowsOf(code, ym).filter((r) => !r.cancelled && r.amount > 0 && r.area > 0));
      }
      const cleaned = cleanTrades([...sale, ...silv], { market, lotto: { ...lotto, tradeMonths: W }, today: asOf });
      byWindow[W] = { cleaned, sale };
    }
    rec.counts = perModel.map((p) => Object.fromEntries(WINDOWS.map((W) => [W, countTypes(sameComplexRows(byWindow[W].cleaned, subject, p.model.area, { market, lotto }))])));
    // 판단 주택형(best)의 표본
    const judged = best ? perModel.findIndex((p) => p.model.houseType === best.houseType && p.model.area === best.area) : -1;
    rec.judgedIdx = judged;
    // 상식 검사
    const ref = byWindow[12] ?? byWindow[6];
    const unitRows = ref.cleaned.filter((r) => !r.presale);
    const thisYear = Number(asOf.slice(0, 4));
    const newRows = unitRows.filter((r) => r.buildYear && r.buildYear >= thisYear - 5);
    const useNew = newRows.length >= 20;
    const p90 = quantile((useNew ? newRows : unitRows).map((r) => r.amount / r.area), 0.9);
    rec.p90 = p90 ? Math.round(p90) : null;
    rec.p90Basis = useNew ? `신축${newRows.length}` : `전체${unitRows.length}`;
    if (best && p90) rec.sanity = (best.estimate / best.area) / p90;
    if (best) rec.estOverPrice = best.estimate / best.price;
    if (best) {
      // 같은 시군구 12개월 분양권·입주권 거래(면적이 비슷한 것)의 ㎡당 중위가가 추정보다 얼마나 높은가. 3건 이상일 때만 본다.
      const preUnits = ref.cleaned.filter((r) => r.presale && Math.abs(r.area - best.area) <= lotto.areaToleranceM2).map((r) => r.amount / r.area);
      rec.presaleN = preUnits.length;
      if (preUnits.length >= 3) rec.hRatio = quantile(preUnits, 0.5) / (best.estimate / best.area);
    }
    delete data.windows;
  } catch (error) {
    windowErrors += 1;
    rec.windowError = safeError(error);
  }
}

// ---- 플래그 ----
const F_THRESHOLD = 0.7;
const minSamples = market.sameComplex.minSamples;
for (const rec of recs) {
  const flags = new Set();
  const data = rec._data;
  if (data && rec.counts) {
    const { perModel } = data;
    const c = (i, W) => rec.counts[i]?.[W] ?? { sale: 0, presale: 0, ipju: 0 };
    const idxs = perModel.map((_, i) => i);
    const sameUsed = perModel.some((p) => p.cand?.basis.kind === 'same');
    if (rec.fresh === true && !sameUsed) flags.add('A');
    if (idxs.some((i) => c(i, 6).sale + c(i, 6).presale === 0 && c(i, 6).ipju >= 1)) flags.add('B');
    if (rec.c1) flags.add('C');
    if (readWindows) {
      if (idxs.some((i) => totalOf(c(i, 6)) === 0 && (totalOf(c(i, 12)) > 0 || totalOf(c(i, 24)) > 0))) flags.add('D');
      if (idxs.some((i) => c(i, 6).sale + c(i, 6).presale < minSamples && (totalOf(c(i, 12)) >= minSamples || totalOf(c(i, 24)) >= minSamples))) flags.add('D2');
    }
    if (rec.own?.path === 'comparables') {
      if (rec.own.scope === '시군구') flags.add('E1');
      if (rec.own.maxAge !== market.comparables.preferMaxAgeYears) flags.add('E2');
    }
    if (Number.isFinite(rec.sanity) && rec.sanity < F_THRESHOLD) flags.add('F');
    if (Number.isFinite(rec.hRatio) && rec.hRatio >= 1.3) flags.add('H');
    if (perModel.some((p) => p.cand === null)) flags.add('G');
    if (!rec.own) flags.add('G0');
  }
  if (rec.c2) flags.add('C2');
  rec.flags = [...flags].sort();
}

// ---- 출력 ----
const compact = (rec) => {
  const { _data, address, ...rest } = rec;
  const j = rec.judgedIdx >= 0 ? rec.counts?.[rec.judgedIdx] : null;
  const fmt = (c) => (c ? `${c.sale}/${c.presale}/${c.ipju}` : '-');
  return JSON.stringify({
    ...rest,
    rate: Number.isFinite(rec.rate) ? Number(rec.rate.toFixed(3)) : rec.rate,
    sanity: Number.isFinite(rec.sanity) ? Number(rec.sanity.toFixed(2)) : null,
    estOverPrice: Number.isFinite(rec.estOverPrice) ? Number(rec.estOverPrice.toFixed(2)) : null,
    judged: j ? { w6: fmt(j[6]), w12: fmt(j[12]), w24: fmt(j[24]) } : null,
    counts: undefined,
    models: rec.models?.map((m) => `${m.area}㎡:${m.path ?? 'none'}/${m.conf ?? '-'}/${Number.isFinite(m.rate) ? m.rate.toFixed(2) : '-'}`),
    own: rec.own ? { ...rec.own, rate: Number.isFinite(rec.own.rate) ? Number(rec.own.rate.toFixed(3)) : null, sameDongShare: Number.isFinite(rec.own.sameDongShare) ? Number(rec.own.sameDongShare.toFixed(2)) : rec.own.sameDongShare } : undefined,
  });
};
log('');
log('===== PER NOTICE (counts 형식: 매매/분양권/입주권) =====');
for (const rec of recs) log(`AUDIT ${compact(rec)}`);

const analyzed = recs.filter((r) => r._data && r.counts);
const skipped = recs.filter((r) => r.skip);
log('');
log('===== SUMMARY =====');
log(`targets=${recs.length} analyzed=${analyzed.length} skipped=${skipped.length} [${[...skipped.reduce((m, r) => m.set(r.skip.replace(/\(.*\)/, ''), (m.get(r.skip.replace(/\(.*\)/, '')) ?? 0) + 1), new Map())].map(([k, n]) => `${k}:${n}`).join(', ')}] audit_errors=${recs.filter((r) => r.error).length} windowErrors=${windowErrors} quota=${quotaHit.value}`);
log(`counters: ${[...counters].map(([k, c]) => `${k}:${c}`).join(', ') || 'none'}`);
log(`분양권 전매 원본 구분별 건수(조회한 모든 월): ${[...ownerTally].map(([k, n]) => `${k}:${n}`).join(' ')}`);
log(`own vs production margin mismatches (apt/remainder): ${recs.filter((r) => r.mismatch).length}`);

const table = (title, rowsList, keyFn) => {
  const m = new Map();
  for (const r of rowsList) { const k = keyFn(r); m.set(k, (m.get(k) ?? 0) + 1); }
  log(`${title}: ${[...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(' | ')}`);
};
table('등급 분포(전체 대상)', recs, (r) => r.grade ?? '-');
table('등급 분포(분석 가능)', analyzed, (r) => r.grade ?? '-');
table('판정 보류 사유', recs.filter((r) => r.grade === '판정 보류'), (r) => r.gradeDetail ?? '-');
table('접수 상태', recs, (r) => r.stage);
table('같은 단지 경로 사용(best)', analyzed, (r) => r.own?.path ?? 'none');
table('비교 단지 범위(best)', analyzed.filter((r) => r.own?.path === 'comparables'), (r) => `${r.own.scope}/age${r.own.maxAge ?? 'any'}`);

const FLAGS = ['A', 'B', 'C', 'C2', 'D', 'D2', 'E1', 'E2', 'F', 'G', 'G0', 'H'];
log('');
log(`플래그별 건수(분석 가능 ${analyzed.length}건 기준, 겹침 포함). A=같은 단지 0건+신축/입주예정(주택형 전부 비교 단지 경로), B=입주권만 있고 매매·분양권 0(6개월), C=번지 지번 파싱 실패, C2=법정동 파싱 실패, D=6개월 0건인데 12/24개월에 있음(모든 유형), D2=6개월 매매+분양권 3건 미만인데 12/24개월에 3건 이상, E1=비교 범위 시군구, E2=연식 단계 15년 초과, F=추정 ㎡당가가 시군구 상위10% ${F_THRESHOLD * 100}% 미만, G=표본 없는 주택형 존재, G0=추정 없음, H=같은 시군구 12개월 분양권·입주권 ㎡당 중위가(3건 이상)가 추정의 1.3배 이상`);
for (const f of FLAGS) log(`  ${f}: ${analyzed.filter((r) => r.flags.includes(f)).length}`);
log(`  어떤 플래그든(A,B,C,D,E1,E2,F,G,H): ${analyzed.filter((r) => r.flags.some((f) => ['A', 'B', 'C', 'D', 'E1', 'E2', 'F', 'G', 'H'].includes(f))).length}`);
log(`  신축 판단 불가(moveInYm 없음): ${analyzed.filter((r) => r.fresh === null).length} / 신축=${analyzed.filter((r) => r.fresh === true).length} / 구축=${analyzed.filter((r) => r.fresh === false).length}`);
const combo = new Map();
for (const r of analyzed) { const k = r.flags.join('+') || '(없음)'; combo.set(k, (combo.get(k) ?? 0) + 1); }
log(`플래그 조합: ${[...combo].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(' | ')}`);
log('플래그 × 등급:');
for (const f of FLAGS) {
  const sub = analyzed.filter((r) => r.flags.includes(f));
  if (sub.length === 0) continue;
  const m = new Map();
  for (const r of sub) m.set(r.grade ?? '-', (m.get(r.grade ?? '-') ?? 0) + 1);
  log(`  ${f}: ${[...m].map(([k, n]) => `${k}=${n}`).join(' ')}`);
}
const dist = (name, values, edges) => {
  const v = values.filter(Number.isFinite);
  const m = new Map();
  for (const x of v) { const e = edges.find((b) => x < b) ?? Infinity; m.set(e, (m.get(e) ?? 0) + 1); }
  log(`${name}(n=${v.length}): ${edges.concat([Infinity]).map((e) => `<${e === Infinity ? '∞' : e}:${m.get(e) ?? 0}`).join(' ')}`);
};
dist('상식 검사 sanity(추정 ㎡당가/시군구 상위10%)', analyzed.map((r) => r.sanity), [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2]);
dist('추정/분양가', analyzed.map((r) => r.estOverPrice), [0.9, 1.0, 1.05, 1.1, 1.2, 1.5, 2.0]);
const estimateRows = analyzed.filter((r) => r.own);
log(`best 신뢰도 분포: ${['상', '중', '하'].map((c) => `${c}=${estimateRows.filter((r) => r.own.conf === c).length}`).join(' ')}`);
log(`sameDongShare(비교 단지 경로, 고른 단지 중 공고 동/읍면 소속 비율) 분포: ${[0, 0.01, 0.34, 0.67, 1.0001].map((e, i, a) => (i < a.length - 1 ? `${e}~${a[i + 1]}:${estimateRows.filter((r) => r.own.path === 'comparables' && Number.isFinite(r.own.sameDongShare) && r.own.sameDongShare >= e && r.own.sameDongShare < a[i + 1]).length}` : null)).filter(Boolean).join(' ')}`);

log('');
log('===== 의심 공고(플래그 가중 점수순) =====');
const weight = { A: 3, B: 4, C: 1, D: 3, D2: 1, E1: 2, E2: 1, F: 2, G: 1, G0: 1, H: 2 };
const scored = analyzed.map((r) => ({ r, score: r.flags.reduce((s, f) => s + (weight[f] ?? 0), 0) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.r.i - b.r.i);
for (const { r, score } of scored.slice(0, 45)) {
  const c = r.judgedIdx >= 0 ? r.counts?.[r.judgedIdx] : null;
  const f = (x) => (x ? `${x.sale}/${x.presale}/${x.ipju}` : '-');
  log(`SUSPECT s=${score} [${r.flags.join(',')}] ${r.kind} ${r.type} | ${r.region} | ${r.name} | ${r.stage} | 등급 ${r.grade}${r.gradeDetail ? `(${r.gradeDetail})` : ''} | 마진율 ${pct(r.rate)} 신뢰 ${r.conf ?? '-'} 경로 ${r.own?.path ?? '-'}${r.own?.scope ? `/${r.own.scope}` : ''} | 같은 단지 6/12/24 ${c ? `${f(c[6])}  ${f(c[12])}  ${f(c[24])}` : '-'} | 추정 ${eok(r.estimate)} 분양가 ${eok(r.price)} sanity ${Number.isFinite(r.sanity) ? r.sanity.toFixed(2) : '-'} 분양권·입주권/추정 ${Number.isFinite(r.hRatio) ? r.hRatio.toFixed(2) : '-'}(n=${r.presaleN ?? 0})`);
}
log('');
log('===== 검증: 잠실 래미안아이파크 =====');
for (const r of recs.filter((x) => norm(x.name).includes(norm('래미안아이파크')))) {
  log(`JAMSIL ${r.name} | ${r.type} | ${r.address} | 플래그 [${r.flags?.join(',') ?? '-'}] | 등급 ${r.grade} 마진율 ${pct(r.rate)} 신뢰 ${r.conf} | counts(주택형별 6/12/24, 매매/분양권/입주권) ${(r.counts ?? []).map((c, i) => `${r.models?.[i]?.area}㎡:${WINDOWS.map((W) => `${c[W].sale}/${c[W].presale}/${c[W].ipju}`).join('  ')}`).join(' ; ')} | jibun=${r.jibun ?? '-'} c1=${r.c1} fresh=${r.fresh} moveIn=${r.moveIn ?? '-'}`);
}
log(`errors=${[...counters].filter(([k]) => k.startsWith('error:')).map(([k, c]) => `${k}:${c}`).join(',') || 'none'}`);
