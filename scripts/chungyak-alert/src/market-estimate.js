// 거래사례 비교 방식의 시세와 안전 마진 계산. 외부 호출과 파일 입출력이 없는 순수 함수만 둔다.
// 금액은 만원, 단가는 만원/㎡다. 계수의 의미는 docs/SETUP.md의 10장을 참고한다.
import { median } from './util.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS_PER_MONTH = 30.4375;
const EARTH_RADIUS_M = 6371000;
// 부동소수 누적 합이 경계값 바로 아래에 머무는 경우를 막는다.
const EPSILON = 1e-9;

export const CONFIDENCE = { HIGH: '상', MID: '중', LOW: '하' };

const compact = (value) => String(value ?? '').replace(/\s+/g, '').toLowerCase();

// 찾은 제한 유형의 키워드를 돌려준다. 띄어 쓴 공고명과 신혼희망타운 유형 코드도 잡는다.
export function restrictedType(notice, market) {
  const name = compact(notice.name);
  const keyword = market.restrictedNameKeywords.find((item) => name.includes(compact(item)));
  if (keyword) return keyword;
  return notice.houseSecd === '10' || compact(notice.typeLabel).includes('신혼희망') ? '신혼희망' : null;
}

export function monthsBetween(from, to) {
  return (Date.parse(to) - Date.parse(from)) / DAY_MS / DAYS_PER_MONTH;
}

// 값이 오름차순일 때 누적 가중치가 q에 처음 닿는 값. 표본 사이를 보간하지 않아 손으로 검산할 수 있다.
export function weightedQuantile(items, q) {
  const valid = items.filter((item) => Number.isFinite(item.value) && item.weight > 0);
  if (valid.length === 0) return null;
  const sorted = [...valid].sort((a, b) => a.value - b.value);
  const target = sorted.reduce((sum, item) => sum + item.weight, 0) * q;
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative + EPSILON >= target) return item.value;
  }
  return sorted.at(-1).value;
}

const quantile = (values, q) => weightedQuantile(values.map((value) => ({ value, weight: 1 })), q);

// 사분위 범위를 중위값으로 나눈 값. 표본이 하나면 0이다.
export function spreadOf(values) {
  const middle = quantile(values, 0.5);
  if (!(middle > 0)) return null;
  return (quantile(values, 0.75) - quantile(values, 0.25)) / middle;
}

export function haversineMeters(a, b) {
  const rad = (degree) => (degree * Math.PI) / 180;
  const dLat = rad(b.y - a.y);
  const dLon = rad(b.x - a.x);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.y)) * Math.cos(rad(b.y)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

// 1주택 유상취득, 감면 없음을 가정한다. 6억 원과 9억 원 사이는 세율이 직선으로 오른다.
export function acquisitionTax(price, tax) {
  let rate;
  if (price <= tax.lowPriceManwon) rate = tax.lowRate;
  else if (price >= tax.highPriceManwon) rate = tax.highRate;
  else {
    const position = (price - tax.lowPriceManwon) / (tax.highPriceManwon - tax.lowPriceManwon);
    rate = tax.lowRate + (tax.highRate - tax.lowRate) * position;
  }
  return Math.round(price * rate * (1 + tax.educationRatio));
}

export function stationFactor(distanceM, station) {
  if (!Number.isFinite(distanceM)) return station.otherFactor;
  return station.bands.find((band) => distanceM <= band.maxM)?.factor ?? station.otherFactor;
}

const tierOf = (text, tiers) => {
  const normalized = compact(text);
  if (!normalized) return null;
  return ['top', 'mid'].find((tier) => tiers[tier].some((keyword) => normalized.includes(compact(keyword)))) ?? null;
};

// 컨소시엄은 첫 번째로 적힌 회사를 주간사로 본다.
export function leadBuilder(builder) {
  return String(builder ?? '').split(/[,/&+·、]|\s및\s/).map((part) => part.trim()).find(Boolean) ?? '';
}

// 단지명의 브랜드를 먼저 보고, 없으면 시공사(주간사)를 본다. 모르면 중립 계수를 쓰는 other다.
export function brandTier({ name, builder }, brand) {
  return tierOf(name, brand.nameKeywords) ?? tierOf(leadBuilder(builder), brand.builderKeywords) ?? 'other';
}

export function ageFactor(ageYears, age) {
  const years = Math.min(Math.max(ageYears, 0), age.maxYears);
  return 1 - age.ratePerYear * years;
}

export const normalizeComplexName = (name) => compact(name)
  .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
  .replace(/[^0-9a-z가-힣]/g, '')
  .replace(/(아파트|단지)+$/, '');

const lotKey = (row) => `${row.umd ?? ''}|${row.jibun ?? ''}|${normalizeComplexName(row.aptName)}`;

// 매매 자료에 단지 일련번호가 없을 수 있어 그때는 법정동, 지번, 단지명으로 묶는다.
// 같은 단지의 분양권 행처럼 일련번호가 없는 행은 같은 위치의 일련번호를 따른다.
function complexKeyFn(rows) {
  const seqByLot = new Map();
  for (const row of rows) if (row.aptSeq) seqByLot.set(lotKey(row), row.aptSeq);
  return (row) => {
    const seq = row.aptSeq || seqByLot.get(lotKey(row));
    return seq ? `seq:${seq}` : `lot:${lotKey(row)}`;
  };
}

// 취소 거래, 직거래, 저층, 토지임대부, 조회 기간 밖 거래를 뺀다. 값이 없는 항목은 거르는 근거로 쓰지 않는다.
export function cleanTrades(rows, { market, lotto, today }) {
  const filter = market.tradeFilter;
  return rows.filter((row) => {
    if (row.cancelled || row.landLease) return false;
    if (String(row.dealingGbn ?? '').includes('직거래')) return false;
    if (Number.isFinite(row.floor) && row.floor <= filter.lowFloorMax) return false;
    if (row.dealDate && monthsBetween(row.dealDate, today) > lotto.tradeMonths + 1) return false;
    return row.amount > 0 && row.area > 0;
  });
}

function recencyWeight(row, { market, lotto, today }) {
  const months = row.dealDate ? Math.max(monthsBetween(row.dealDate, today), 0) : lotto.tradeMonths;
  return 0.5 ** (months / market.tradeFilter.recencyHalfLifeMonths);
}

const withoutOutliers = (units, filter) => {
  if (units.length < filter.outlierMinSamples) return units;
  const middle = median(units.map((item) => item.value));
  return units.filter((item) => Math.abs(item.value - middle) <= middle * filter.outlierBand);
};

function unitsOf(rows, context) {
  const items = rows.map((row) => ({ value: row.amount / row.area, weight: recencyWeight(row, context), row }));
  return withoutOutliers(items, context.market.tradeFilter);
}

const nearArea = (rows, area, lotto) => rows.filter((row) => Math.abs(row.area - area) <= lotto.areaToleranceM2);

// 면적이 비슷한 거래를 단지 단위로 묶는다. 단지마다 값 하나만 남겨 큰 단지가 결과를 좌우하지 못하게 한다.
export function groupComplexes(rows, area, context) {
  const { market, lotto, today } = context;
  const keyOf = complexKeyFn(rows);
  const groups = new Map();
  for (const row of nearArea(rows, area, lotto)) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const thisYear = Number(today.slice(0, 4));
  const complexes = [];
  for (const [key, group] of groups) {
    const kept = unitsOf(group, context);
    if (kept.length === 0 || kept.length < market.comparables.minComplexSamples) continue;
    const first = kept[0].row;
    const buildYears = group.map((row) => row.buildYear).filter(Boolean);
    const presaleOnly = group.every((row) => row.presale);
    complexes.push({
      key,
      aptName: first.aptName ?? '',
      umd: first.umd ?? null,
      jibun: group.find((row) => row.jibun)?.jibun ?? null,
      // 분양권만 있는 단지는 입주 전이라 신축으로 본다. 건축년도를 모르면 연식 보정을 하지 않는다.
      ageYears: buildYears.length > 0 ? thisYear - Math.max(...buildYears) : presaleOnly ? 0 : null,
      brandTier: brandTier({ name: first.aptName }, market.adjustment.brand),
      samples: kept.length,
      unit: weightedQuantile(kept, 0.5),
    });
  }
  return complexes;
}

// 브랜드를 뺀 고유 부분의 길이. 브랜드만 같은 단지를 부분 일치로 묶지 않으려고 쓴다.
function distinctiveLength(name, brand) {
  let rest = name;
  for (const keyword of [...brand.nameKeywords.top, ...brand.nameKeywords.mid]) {
    rest = rest.replaceAll(normalizeComplexName(keyword), '');
  }
  return rest.length;
}

const sameName = (a, b, { allowSubstring, minLength, minDistinctive, brand }) => {
  const left = normalizeComplexName(a);
  const right = normalizeComplexName(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (!allowSubstring) return false;
  const shorter = left.length < right.length ? left : right;
  const longer = shorter === left ? right : left;
  return shorter.length >= minLength && distinctiveLength(shorter, brand) >= minDistinctive && longer.includes(shorter);
};

// 공고 단지의 거래를 찾는다. 이름이 같거나, 같은 법정동의 같은 지번이면 같은 단지로 본다.
// 법정동을 모르면 시군구 전체와 비교하게 되므로 부분 일치를 인정하지 않는다.
function sameComplexRows(rows, subject, area, { market, lotto }) {
  const nameRule = {
    allowSubstring: Boolean(subject.umd),
    minLength: market.sameComplex.minNameLength,
    minDistinctive: market.sameComplex.minDistinctiveLength,
    brand: market.adjustment.brand,
  };
  return nearArea(rows, area, lotto).filter((row) => {
    if (subject.umd && row.umd && subject.umd !== row.umd) return false;
    if (subject.jibun && row.jibun && subject.jibun === row.jibun && subject.umd && subject.umd === row.umd) return true;
    return sameName(subject.name, row.aptName, nameRule);
  });
}

function candidateTotals(model, market, unitMiddle, unitLow) {
  const estimate = Math.round(unitMiddle * model.area);
  const safeValue = Math.round(unitLow * model.area);
  const optionCost = market.optionCostManwon;
  const tax = acquisitionTax(model.price, market.acquisitionTax);
  const margin = safeValue - model.price - optionCost - tax;
  return {
    houseType: model.houseType,
    price: model.price,
    estimate,
    safeValue,
    optionCost,
    tax,
    margin,
    marginRate: margin / safeValue,
  };
}

const lowerOneLevel = (level) => (level === CONFIDENCE.HIGH ? CONFIDENCE.MID : CONFIDENCE.LOW);

export function comparableConfidence({ samples, comparables, spread, looError, locationUsed, presaleOk, keywordLocated = false }, confidence) {
  const { high, mid } = confidence;
  let level = CONFIDENCE.LOW;
  if (locationUsed) {
    if (samples >= high.samples && comparables >= high.comparables && spread <= high.spread && looError !== null && looError <= high.looError) {
      level = CONFIDENCE.HIGH;
    } else if (samples >= mid.samples && comparables >= mid.comparables && spread <= mid.spread && (looError === null || looError <= mid.looError)) {
      level = CONFIDENCE.MID;
    }
  }
  // 단지명 검색으로 찾은 위치는 주소 검색보다 믿기 어렵다.
  if (keywordLocated && level === CONFIDENCE.HIGH) level = CONFIDENCE.MID;
  return presaleOk ? level : lowerOneLevel(level);
}

function estimateFromSameComplex(model, rows, { market, presaleOk }, context) {
  const kept = unitsOf(rows, context);
  if (kept.length < market.sameComplex.minSamples) return null;
  const spread = spreadOf(kept.map((item) => item.value));
  const { highSamples, highSpread } = market.sameComplex;
  const level = kept.length >= highSamples && spread <= highSpread ? CONFIDENCE.HIGH : CONFIDENCE.MID;
  return {
    ...candidateTotals(model, market, weightedQuantile(kept, 0.5), weightedQuantile(kept, 0.25)),
    confidence: presaleOk ? level : lowerOneLevel(level),
    basis: {
      kind: 'same',
      samples: kept.length,
      presaleSamples: kept.filter((item) => item.row.presale).length,
    },
  };
}

// 단지의 조건 계수. subjectAge는 건축년도를 모르는 단지가 공고 단지와 같은 연식으로 계산되게 한다.
function conditionFactors(complex, adjustment, { useStation, subjectAge }) {
  return {
    station: useStation ? stationFactor(complex.stationM, adjustment.station) : 1,
    brand: adjustment.brand.factors[complex.brandTier] ?? adjustment.brand.factors.other,
    age: ageFactor(complex.ageYears ?? subjectAge, adjustment.age),
  };
}

const factorProduct = ({ station, brand, age }) => station * brand * age;

const boundFactor = (factor, adjustment) => Math.min(Math.max(factor, adjustment.minFactor), adjustment.maxFactor);

// 나머지 단지로 각 단지의 값을 맞혀 본 상대 오차의 중위값. 단지가 3곳 미만이면 검증할 수 없어 null이다.
export function leaveOneOutError(complexes, adjustment, options) {
  if (complexes.length < 3) return null;
  const errors = complexes.map((target) => {
    const targetFactor = factorProduct(conditionFactors(target, adjustment, options));
    const predictions = complexes
      .filter((other) => other !== target)
      .map((other) => {
        const otherFactor = factorProduct(conditionFactors(other, adjustment, options));
        return other.unit * boundFactor(targetFactor / otherFactor, adjustment);
      });
    return Math.abs(median(predictions) - target.unit) / target.unit;
  });
  return median(errors);
}

// 가까운 순으로 고른다. 비교 범위 안 표본이 부족하면 null이고, 호출한 쪽이 위치 없는 범위로 넓힌다.
function nearbyComparables(complexes, locations, { market, lotto }) {
  const located = complexes
    .map((complex) => ({ ...complex, ...locations.get(complex.key) }))
    .filter((complex) => complex.distanceM <= market.comparables.maxDistanceM)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, market.comparables.maxComparables);
  const samples = located.reduce((sum, complex) => sum + complex.samples, 0);
  return samples >= lotto.minSamples ? located : null;
}

function scopedComparables(complexes, subject, { market, lotto }) {
  const total = (list) => list.reduce((sum, complex) => sum + complex.samples, 0);
  const sameDong = subject.umd ? complexes.filter((complex) => complex.umd === subject.umd) : [];
  let scope;
  let pool;
  if (total(sameDong) >= lotto.minSamples) {
    scope = '법정동';
    pool = sameDong;
  } else if (total(complexes) >= lotto.minSamples) {
    scope = '시군구';
    pool = complexes;
  } else {
    return null;
  }
  const picked = [...pool].sort((a, b) => b.samples - a.samples).slice(0, market.comparables.maxComparables);
  return { scope, picked };
}

function estimateFromComparables(model, rows, subject, inputs, context) {
  const { market } = context;
  const complexes = groupComplexes(rows, model.area, context);
  const near = inputs.locationOk ? nearbyComparables(complexes, inputs.locations, context) : null;
  const scoped = near ? null : scopedComparables(complexes, subject, context);
  if (!near && !scoped) return null;
  const picked = near ?? scoped.picked;
  const useStation = Boolean(near);
  const { adjustment, comparables: comparableConfig } = market;
  const options = { useStation, subjectAge: subject.ageYears };
  const subjectFactors = conditionFactors(subject, adjustment, options);
  const adjusted = picked.map((complex) => {
    const factors = conditionFactors(complex, adjustment, options);
    const ratio = boundFactor(factorProduct(subjectFactors) / factorProduct(factors), adjustment);
    return {
      ...complex,
      adjustedUnit: complex.unit * ratio,
      // 근거에 쓰는 값이다. 카카오 응답에서 나온 역 계수는 넣지 않는다.
      brandRatio: subjectFactors.brand / factors.brand,
      ageRatio: subjectFactors.age / factors.age,
    };
  });
  const weighted = adjusted.map((complex) => ({
    value: complex.adjustedUnit,
    weight: useStation ? 1 / (1 + complex.distanceM / comparableConfig.distanceDecayM) : 1,
  }));
  const samples = adjusted.reduce((sum, complex) => sum + complex.samples, 0);
  const totals = candidateTotals(model, market, weightedQuantile(weighted, 0.5), weightedQuantile(weighted, 0.25));
  const spread = spreadOf(adjusted.map((complex) => complex.adjustedUnit));
  const looError = leaveOneOutError(picked, adjustment, options);
  return {
    ...totals,
    confidence: comparableConfidence({
      samples,
      comparables: adjusted.length,
      spread,
      looError,
      locationUsed: useStation,
      presaleOk: inputs.presaleOk,
      keywordLocated: inputs.keywordLocated,
    }, market.confidence),
    basis: {
      kind: 'comparables',
      scope: near ? null : scoped.scope,
      stationUsed: useStation,
      samples,
      comparables: adjusted.map((complex) => ({
        name: complex.aptName,
        samples: complex.samples,
        brandRatio: complex.brandRatio,
        ageRatio: complex.ageRatio,
      })),
    },
  };
}

// 위치를 조회할 단지 목록. 같은 단지 거래로 값이 정해지는 주택형은 조회가 필요 없다.
export function lookupCandidates({ models, rows, subject, lotto, market, today }) {
  const context = { market, lotto, today };
  const seen = new Map();
  for (const model of models) {
    if (!(model.area > 0) || !(model.price > 0)) continue;
    const same = sameComplexRows(rows, subject, model.area, context);
    if (unitsOf(same, context).length >= market.sameComplex.minSamples) continue;
    for (const complex of groupComplexes(rows, model.area, context)) {
      const known = seen.get(complex.key);
      if (!known || complex.samples > known.samples) seen.set(complex.key, complex);
    }
  }
  return [...seen.values()]
    .filter((complex) => complex.jibun)
    .sort((a, b) => Number(b.umd === subject.umd) - Number(a.umd === subject.umd) || b.samples - a.samples)
    .slice(0, market.comparables.maxLookupsPerNotice);
}

// 역 거리를 조회할 단지. 주택형별로 실제로 쓰일 가까운 단지만 고른다.
export function stationLookupKeys({ models, rows, locations, lotto, market, today }) {
  const context = { market, lotto, today };
  const keys = new Set();
  for (const model of models) {
    if (!(model.area > 0) || !(model.price > 0)) continue;
    const near = nearbyComparables(groupComplexes(rows, model.area, context), locations, context);
    for (const complex of near ?? []) keys.add(complex.key);
  }
  return keys;
}

export function buildSubject({ name, builder, umd, jibun, market }) {
  return {
    name,
    builder,
    umd: umd ?? null,
    jibun: jibun ?? null,
    brandTier: brandTier({ name, builder }, market.adjustment.brand),
    // 공고 단지는 입주 전이므로 신축으로 본다.
    ageYears: 0,
    stationM: null,
  };
}

export const meetsPriceRule = (candidate, lotto) => candidate.margin >= lotto.minMarginManwon || candidate.marginRate >= lotto.minMarginRate;

// 기준을 넘는 주택형 중 마진이 가장 큰 것을, 없으면 전체에서 마진이 가장 큰 것을 돌려준다.
export function estimateBestMargin({ models, rows, subject, locations = new Map(), locationOk = false, presaleOk = true, keywordLocated = false, lotto, market, today }) {
  const context = { market, lotto, today };
  const inputs = { locations, locationOk, presaleOk, keywordLocated };
  let best = null;
  let bestQualifying = null;
  for (const model of models) {
    if (!(model.area > 0) || !(model.price > 0)) continue;
    const same = sameComplexRows(rows, subject, model.area, context);
    const candidate = estimateFromSameComplex(model, same, { market, presaleOk }, context)
      ?? estimateFromComparables(model, rows, subject, inputs, context);
    if (!candidate) continue;
    if (!best || candidate.margin > best.margin) best = candidate;
    if (meetsPriceRule(candidate, lotto) && (!bestQualifying || candidate.margin > bestQualifying.margin)) {
      bestQualifying = candidate;
    }
  }
  return bestQualifying ?? best;
}
