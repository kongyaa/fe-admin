// 거래사례 비교 방식의 시세와 안전 마진 계산. 외부 호출과 파일 입출력이 없는 순수 함수만 둔다.
// 금액은 만원, 단가는 만원/㎡다. 계수의 의미는 docs/SETUP.md의 10장을 참고한다.
import { median } from './util.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS_PER_MONTH = 30.4375;
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

export function stationFactor(minutes, station) {
  if (!Number.isFinite(minutes)) return station.otherFactor;
  return station.bands.find((band) => minutes <= band.maxMinutes)?.factor ?? station.otherFactor;
}

// 공동주택 상세 정보의 지하철역 거리를 분으로 바꾼다. 구간 값은 윗값으로, `20분초과`는 21로 본다. 읽지 못하면 null이다.
export function parseWalkMinutes(value) {
  const text = compact(value);
  const range = /^\d+~(\d+)분?(이내|이하|미만)?$/.exec(text);
  if (range) return Number(range[1]);
  const within = /^(\d+)분?(이내|이하|미만)?$/.exec(text);
  if (within) return Number(within[1]);
  const over = /^(\d+)분?초과$/.exec(text);
  return over ? Number(over[1]) + 1 : null;
}

// 단지명과 같은 정규화를 써서 S클래스와 에스클래스처럼 표기만 다른 브랜드를 같게 본다.
const tierOf = (text, tiers) => {
  const normalized = normalizeComplexName(text);
  if (!normalized) return null;
  return ['top', 'mid'].find((tier) => tiers[tier].some((keyword) => normalized.includes(normalizeComplexName(keyword)))) ?? null;
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

// 같은 단지가 영문과 한글 브랜드 표기로 섞여 두 단지로 세지지 않게 한글 표기로 맞춘다.
// 앞이 영문자이면 다른 낱말의 일부(BUS클래스, SKIPARK)이므로 바꾸지 않는다.
const BRAND_SPELLINGS = [
  [/(^|[^a-z])s클래스/g, '$1에스클래스'],
  [/(^|[^a-z])e편한세상/g, '$1이편한세상'],
  [/(^|[^a-z])sk뷰/g, '$1에스케이뷰'],
  [/(^|[^a-z])skview/g, '$1에스케이뷰'],
  [/(^|[^a-z])ipark/g, '$1아이파크'],
  [/(^|[^a-z])hillstate/g, '$1힐스테이트'],
  [/(^|[^a-z])thesharp/g, '$1더샵'],
];

export const normalizeComplexName = (name) => BRAND_SPELLINGS.reduce(
  (text, [pattern, korean]) => text.replace(pattern, korean),
  compact(name)
    .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
    .replace(/[^0-9a-z가-힣]/g, ''),
).replace(/(아파트|단지)+$/, '');

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
// 국토부 법정동 이름(umdNm)은 '역삼동', '화도읍 마석우리', '마석우리'처럼 올 수 있다. 실응답의 형식은 확인하지 못해 모두 받는다.
export function parseLocality(text) {
  const tokens = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  return {
    town: tokens.find((token) => /(읍|면)$/.test(token)) ?? null,
    village: tokens.find((token) => /리$/.test(token)) ?? null,
    dong: tokens.find((token) => /(동|가)$/.test(token)) ?? null,
  };
}

// 공고 단지의 위치. umd가 읍·면이면 village(리)를 함께 쓴다. 테스트가 umd를 바꿔 넣을 수 있어 매번 계산한다.
export function subjectLocality(subject) {
  const umd = subject.umd ?? '';
  return {
    town: /(읍|면)$/.test(umd) ? umd : null,
    village: subject.village ?? null,
    dong: /(동|가)$/.test(umd) ? umd : null,
  };
}

const localityKind = (place) => (place.dong ? 'dong' : place.town || place.village ? 'town' : null);
const finestPlace = (place) => place.village ?? place.dong ?? place.town;

// 두 위치가 서로 다른 곳임이 확실한지 본다. 한쪽에 없는 단위는 판단에 쓰지 않는다.
export function localityConflict(a, b) {
  const kindA = localityKind(a);
  const kindB = localityKind(b);
  if (kindA && kindB && kindA !== kindB) return true;
  return ['town', 'village', 'dong'].some((part) => a[part] && b[part] && a[part] !== b[part]);
}

const sameFinestPlace = (a, b) => !localityConflict(a, b) && Boolean(finestPlace(a)) && finestPlace(a) === finestPlace(b);

// 거래 행이 공고 단지와 같은 읍·면·리·동을 가리키는지. 지역이 비어 있으면 모르는 것이므로 받는다.
// 리만 있는 행은 어느 읍·면인지 몰라 공고 단지의 리와 같을 때만 받는다.
const sharesPlace = (place, rowPlace) => {
  if (!rowPlace.town && !rowPlace.village && !rowPlace.dong) return true;
  return ['town', 'village', 'dong'].some((part) => place[part] && place[part] === rowPlace[part]);
};

// 공개 로그 진단용. 국토부 법정동 이름의 형식만 센다.
export function localityFormat(text) {
  const place = parseLocality(text);
  if (place.town) return 'town';
  if (place.village) return 'village';
  if (place.dong) return 'dong';
  return 'other';
}

function sameComplexRows(rows, subject, area, { market, lotto }) {
  const place = subjectLocality(subject);
  const nameRule = {
    minLength: market.sameComplex.minNameLength,
    minDistinctive: market.sameComplex.minDistinctiveLength,
    brand: market.adjustment.brand,
  };
  return nearArea(rows, area, lotto).filter((row) => {
    const rowPlace = parseLocality(row.umd);
    if (localityConflict(place, rowPlace)) return false;
    if (subject.jibun && row.jibun && subject.jibun === row.jibun && sameFinestPlace(place, rowPlace)) return true;
    // 포함 관계는 같은 곳임을 아는 행에만 쓴다. 다른 읍의 리만 적힌 행이 이름 일부로 묶이지 않게 한다.
    const allowSubstring = Boolean(finestPlace(place)) && sharesPlace(place, rowPlace);
    return sameName(subject.name, row.aptName, { ...nameRule, allowSubstring });
  });
}

// 보수 시세에 쓰는 할인율. 단지가 minComplexesForLoo(4곳) 이상이면 서로를 맞혀 본 오차와 퍼짐(사분위 범위/중위값)의 절반 중
// 큰 값을 쓴다. 오차의 중위값은 다수가 서로 같으면 소수의 큰 차이를 보지 못해 퍼짐으로 보완한다.
// 단지가 적으면 둘 다 믿기 어려워 상한을 쓴다. 이상치를 뺀 경우에는 하한을 올린다. exceeded는 계산값이 상한을 넘었다는 뜻이다.
export function safeDiscount({ looError, spread, comparables, outliers = 0 }, safe) {
  if (comparables < safe.minComplexesForLoo || looError === null || !Number.isFinite(looError)) {
    return { discount: safe.maxDiscount, measured: false, exceeded: false };
  }
  const raw = Math.max(looError, Number.isFinite(spread) ? spread / 2 : 0);
  const floor = outliers > 0 ? safe.minDiscountWithOutliers : safe.minDiscount;
  return { discount: Math.min(Math.max(raw, floor), safe.maxDiscount), measured: true, exceeded: raw > safe.maxDiscount, raw };
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

// 역 보정 상태. used: 적용, noInput: 공고 단지 입력 없음, noData: 입력은 있지만 비교 단지 값이 부족함
export const STATION = { USED: 'used', NO_INPUT: 'noInput', NO_DATA: 'noData' };

export function comparableConfidence({ samples, comparables, spread, looError, stationState, presaleOk, ageStep = 0, lastAgeStep = 0, scopePenalty = false, lastStepMinComplexes = Infinity, forceLow = false }, confidence) {
  const { high, mid } = confidence;
  let level = CONFIDENCE.LOW;
  if (samples >= high.samples && comparables >= high.comparables && spread <= high.spread && looError !== null && looError <= high.looError) {
    level = CONFIDENCE.HIGH;
  } else if (samples >= mid.samples && comparables >= mid.comparables && spread <= mid.spread && (looError === null || looError <= mid.looError)) {
    level = CONFIDENCE.MID;
  }
  if (stationState === STATION.NO_INPUT && level === CONFIDENCE.HIGH) level = CONFIDENCE.MID;
  if (stationState === STATION.NO_DATA) level = lowerOneLevel(level);
  // 연식이 비슷한 단지가 부족해 넓혔으면 한 단계 내린다. 연식을 보지 않고 골랐으면 중까지만 오르고,
  // 단지가 lastStepMinComplexes(4곳) 미만이거나 서로 맞혀 볼 수 없거나 중 기준에 못 미치면 하다.
  // 신축 공고 단지를 구축으로 재면 시세가 낮게 잡히므로, 그래도 기준을 넘는 마진은 오히려 작게 잡힌 쪽이다.
  if (ageStep > 0 && ageStep < lastAgeStep) level = lowerOneLevel(level);
  if (ageStep > 0 && ageStep >= lastAgeStep) {
    const agreed = comparables >= lastStepMinComplexes && looError !== null && level !== CONFIDENCE.LOW;
    level = agreed ? CONFIDENCE.MID : CONFIDENCE.LOW;
  }
  // 같은 법정동에 거래가 충분했는데 연식 때문에 시군구로 넓혔으면 위치가 다른 만큼 한 단계 내린다.
  if (scopePenalty) level = lowerOneLevel(level);
  // 읍·면 공고 단지를 시군구 전체 단지로 쟀으면 다른 시장일 수 있어 하다.
  if (forceLow) level = CONFIDENCE.LOW;
  return presaleOk ? level : lowerOneLevel(level);
}

function estimateFromSameComplex(model, rows, { market, presaleOk }, context) {
  const kept = unitsOf(rows, context);
  if (kept.length < market.sameComplex.minSamples) return null;
  const spread = spreadOf(kept.map((item) => item.value));
  const { highSamples, highSpread } = market.sameComplex;
  const level = kept.length >= highSamples && spread <= highSpread ? CONFIDENCE.HIGH : CONFIDENCE.MID;
  // 분양권 조회가 실패해도 매매 거래만으로 같은 단지 기준을 채우면 중 아래로 내리지 않는다.
  const saleOnly = kept.filter((item) => !item.row.presale).length;
  let confidence = level;
  if (!presaleOk) confidence = saleOnly >= market.sameComplex.minSamples ? CONFIDENCE.MID : lowerOneLevel(level);
  return {
    ...candidateTotals(model, market, weightedQuantile(kept, 0.5), weightedQuantile(kept, 0.25)),
    confidence,
    basis: {
      kind: 'same',
      samples: kept.length,
      presaleSamples: kept.filter((item) => item.row.presale).length,
    },
  };
}

const hasWalk = (complex) => Number.isFinite(complex.walkMinutes);

// 단지의 조건 계수. 값을 모르는 항목은 공고 단지와 같게 두어 그 항목의 보정이 생기지 않게 한다.
function conditionFactors(complex, adjustment, { useStation, subjectStation, subjectAge }) {
  return {
    station: useStation && hasWalk(complex) ? stationFactor(complex.walkMinutes, adjustment.station) : subjectStation,
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

// 연식이 공고 단지와 가까운 단지를 먼저 고른다. 같은 법정동에 낡고 거래가 많은 단지가 섞여 있어도 신축 비교 단지가
// 밀려나지 않게 하려는 것이다. 연식 단계마다 법정동, 시군구 순으로 보고, 표본과 단지 수가 모자라면 단계를 넓힌다.
// 마지막 단계(null)는 연식을 보지 않으며 예전처럼 표본 수만 본다.
export function selectComparables(complexes, subject, { market, lotto }) {
  const { preferMaxAgeYears, ageWidenSteps, minComplexes, maxComparables } = market.comparables;
  const steps = [preferMaxAgeYears, ...ageWidenSteps];
  const total = (list) => list.reduce((sum, complex) => sum + complex.samples, 0);
  const place = subjectLocality(subject);
  const within = (test) => complexes.filter((complex) => {
    const other = parseLocality(complex.umd);
    return !localityConflict(place, other) && test(other);
  });
  // 동 주소는 법정동, 시군구 순이다. 읍·면 주소는 리, 같은 읍·면, 시군구 순이다. 큰 시군구 안의 다른 생활권을 먼저 쓰지 않게 한다.
  const scopes = place.town
    ? [
      ...(place.village ? [['리', within((other) => other.village === place.village)]] : []),
      // 같은 읍·면 안의 다른 리는 다른 곳이 아니라 넓힌 범위다. 리가 달라도 받는다.
      ['읍·면', complexes.filter((complex) => parseLocality(complex.umd).town === place.town)],
      ['시군구', complexes],
    ]
    : [['법정동', place.dong ? within((other) => other.dong === place.dong) : []], ['시군구', complexes]];
  const firstPool = scopes[0][1];
  for (const [ageStep, maxAge] of steps.entries()) {
    const anyAge = maxAge === null;
    for (const [scope, pool] of scopes) {
      const eligible = anyAge
        ? pool
        : pool.filter((complex) => complex.ageYears !== null && Math.abs(complex.ageYears - subject.ageYears) <= maxAge);
      if (total(eligible) < lotto.minSamples) continue;
      if (!anyAge && eligible.length < minComplexes) continue;
      const picked = [...eligible].sort((a, b) => b.samples - a.samples).slice(0, maxComparables);
      // 가장 좁은 범위에 거래가 충분했는데 연식 때문에 넓혔으면 한 단계 내린다.
      const scopePenalty = scope !== scopes[0][0] && total(firstPool) >= lotto.minSamples;
      const townWide = Boolean(place.town) && scope === '시군구';
      return { scope, picked, ageStep, lastAgeStep: steps.length - 1, maxAge, scopePenalty, townWide };
    }
  }
  return null;
}

// 보정 뒤 단지들의 중위값에서 크게 벗어난 단지를 뺀다. 짝수 개면 가운데 두 값의 평균을 중심으로 쓴다.
// 벗어난 단지가 outlierMaxShare(25%)를 넘으면 이상치가 아니라 시세가 둘로 갈린 것이므로 빼지 않는다.
// 빼고도 outlierMinRemaining(4곳) 이상 남을 때만 뺀다.
export function dropComplexOutliers(adjusted, comparables) {
  const middle = median(adjusted.map((complex) => complex.adjustedUnit));
  const kept = adjusted.filter((complex) => complex.adjustedUnit >= middle * comparables.outlierLow && complex.adjustedUnit <= middle * comparables.outlierHigh);
  const removed = adjusted.length - kept.length;
  if (removed === 0 || removed > Math.floor(adjusted.length * comparables.outlierMaxShare)) return adjusted;
  return kept.length >= comparables.outlierMinRemaining ? kept : adjusted;
}

function estimateFromComparables(model, rows, subject, inputs, context) {
  const { market } = context;
  const scoped = selectComparables(groupComplexes(rows, model.area, context), subject, context);
  if (!scoped) return null;
  const picked = scoped.picked.map((complex) => ({ ...complex, ...inputs.stations.get(complex.key) }));
  const { adjustment } = market;
  const coverage = picked.filter(hasWalk).length / picked.length;
  // 값이 있는 단지만 보정하고 나머지는 그대로 두면 섞이므로, 값이 적으면 전체에서 역 보정을 뺀다.
  let stationState = STATION.USED;
  if (!hasWalk(subject)) stationState = STATION.NO_INPUT;
  else if (coverage < market.comparables.minStationShare) stationState = STATION.NO_DATA;
  const useStation = stationState === STATION.USED;
  const options = { useStation, subjectStation: useStation ? stationFactor(subject.walkMinutes, adjustment.station) : 1, subjectAge: subject.ageYears };
  const subjectFactors = conditionFactors(subject, adjustment, options);
  const all = picked.map((complex) => {
    const factors = conditionFactors(complex, adjustment, options);
    const ratio = boundFactor(factorProduct(subjectFactors) / factorProduct(factors), adjustment);
    return {
      ...complex,
      adjustedUnit: complex.unit * ratio,
      brandRatio: subjectFactors.brand / factors.brand,
      ageRatio: subjectFactors.age / factors.age,
    };
  });
  const adjusted = dropComplexOutliers(all, market.comparables);
  const outliers = all.length - adjusted.length;
  // 신뢰도와 할인율은 이상치를 빼기 전 전체로 계산한다. 뺀 뒤의 단지만 보면 남은 단지끼리 서로를 확인하는 셈이 된다.
  const allValues = all.map((complex) => complex.adjustedUnit);
  const looError = leaveOneOutError(all, adjustment, options);
  const spread = spreadOf(allValues);
  const safe = safeDiscount({ looError, spread, comparables: all.length, outliers }, market.safeValue);
  const equal = adjusted.map((complex) => ({ value: complex.adjustedUnit, weight: 1 }));
  // 표본과 단지 수는 실제로 쓴 단지만 센다. 빠진 단지로 신뢰도를 올리지 않는다.
  const samples = adjusted.reduce((sum, complex) => sum + complex.samples, 0);
  const middle = weightedQuantile(equal, 0.5);
  const totals = candidateTotals(model, market, middle, middle * (1 - safe.discount));
  return {
    ...totals,
    discount: safe.discount,
    discountMeasured: safe.measured,
    discountExceeded: safe.exceeded,
    outliers,
    confidence: comparableConfidence({
      samples,
      comparables: adjusted.length,
      spread,
      looError,
      stationState,
      presaleOk: inputs.presaleOk,
      ageStep: scoped.ageStep,
      lastAgeStep: scoped.lastAgeStep,
      scopePenalty: scoped.scopePenalty,
      lastStepMinComplexes: market.safeValue.minComplexesForLoo,
      forceLow: scoped.townWide,
    }, market.confidence),
    basis: {
      kind: 'comparables',
      scope: scoped.scope,
      maxAge: scoped.maxAge,
      townWide: scoped.townWide,
      // 근거의 금액은 공고 주택형 면적 기준이다. 작은 주택형의 ㎡당 가격을 84㎡로 늘리면 실제보다 비싸 보인다.
      area: model.area,
      outliers,
      stationState,
      walkMinutes: subject.walkMinutes,
      stationLookupFailed: inputs.stationLookupFailed,
      samples,
      comparables: adjusted.map((complex) => ({
        name: complex.aptName,
        samples: complex.samples,
        brandRatio: complex.brandRatio,
        ageRatio: complex.ageRatio,
        // 근거 표시용 84㎡ 환산 보정 단가(만원)
        reference: Math.round(complex.adjustedUnit * model.area),
        walkBand: useStation ? complex.walkBand ?? null : null,
      })),
    },
  };
}

// 공동주택 목록에서 비교 단지를 찾는다. 같은 법정동은 이름이 같거나 고유한 이름을 포함할 때,
// 시군구 전체는 이름이 같을 때만 받는다. 브랜드만 있는 이름은 받지 않고, 후보가 여럿이면 고르지 않는다.
export function matchApartment(complex, directory, market) {
  const name = normalizeComplexName(complex.aptName);
  const brand = market.adjustment.brand;
  if (!name || distinctiveLength(name, brand) === 0) return null;
  const target = compact(complex.umd);
  const inDong = directory.filter((entry) => {
    const dong = compact(entry.dong);
    return Boolean(target) && (dong === target || compact(entry.ri) === target || `${dong}${compact(entry.ri)}` === target);
  });
  const named = (list, allowSubstring) => list.filter((entry) => sameName(complex.aptName, entry.name, {
    allowSubstring,
    minLength: market.sameComplex.minNameLength,
    minDistinctive: market.sameComplex.minDistinctiveLength,
    brand,
  }));
  const exactInDong = named(inDong, false);
  const hits = exactInDong.length > 0 ? exactInDong : named(inDong, true);
  const found = hits.length > 0 ? hits : named(directory, false);
  return found.length === 1 ? found[0] : null;
}

// 역 정보를 조회할 단지 목록. 실제 비교에 쓸 단지만 고르고, 같은 단지 거래로 값이 정해지는 주택형은 뺀다.
export function lookupCandidates({ models, rows, subject, lotto, market, today }) {
  const context = { market, lotto, today };
  const seen = new Map();
  for (const model of models) {
    if (!(model.area > 0) || !(model.price > 0)) continue;
    const same = sameComplexRows(rows, subject, model.area, context);
    if (unitsOf(same, context).length >= market.sameComplex.minSamples) continue;
    const scoped = selectComparables(groupComplexes(rows, model.area, context), subject, context);
    for (const complex of scoped?.picked ?? []) {
      const known = seen.get(complex.key);
      if (!known || complex.samples > known.samples) seen.set(complex.key, complex);
    }
  }
  // 주택형마다 쓸 단지를 모두 조회한다. 여기서 줄이면 한 주택형만 값이 모자랄 수 있어 상한은 실행당 호출 수로 둔다.
  return [...seen.values()].sort((a, b) => b.samples - a.samples);
}

export function buildSubject({ name, builder, umd, village = null, jibun, walkMinutes = null, market }) {
  return {
    name,
    builder,
    umd: umd ?? null,
    village,
    jibun: jibun ?? null,
    brandTier: brandTier({ name, builder }, market.adjustment.brand),
    // 공고 단지는 입주 전이므로 신축으로 본다.
    ageYears: 0,
    // 사용자가 Notion에 입력한 값이다.
    walkMinutes,
  };
}

export const meetsPriceRule = (candidate, lotto) => candidate.margin >= lotto.minMarginManwon || candidate.marginRate >= lotto.minMarginRate;

// 가격 기준으로 로또가 되려면 신뢰도가 중 이상이어야 한다. 주택형을 고를 때도 같은 조건을 써서
// 신뢰도 하인 주택형의 큰 마진이 기준을 넘는 다른 주택형을 가리지 않게 한다.
export const qualifiesByPrice = (candidate, lotto) => meetsPriceRule(candidate, lotto) && candidate.confidence !== CONFIDENCE.LOW;

// 기준을 넘는 주택형 중 마진이 가장 큰 것을, 없으면 전체에서 마진이 가장 큰 것을 돌려준다.
export function estimateBestMargin({ models, rows, subject, stations = new Map(), stationLookupFailed = false, presaleOk = true, lotto, market, today }) {
  const context = { market, lotto, today };
  const inputs = { stations, stationLookupFailed, presaleOk };
  let best = null;
  let bestQualifying = null;
  for (const model of models) {
    if (!(model.area > 0) || !(model.price > 0)) continue;
    const same = sameComplexRows(rows, subject, model.area, context);
    const candidate = estimateFromSameComplex(model, same, { market, presaleOk }, context)
      ?? estimateFromComparables(model, rows, subject, inputs, context);
    if (!candidate) continue;
    if (!best || candidate.margin > best.margin) best = candidate;
    if (qualifiesByPrice(candidate, lotto) && (!bestQualifying || candidate.margin > bestQualifying.margin)) {
      bestQualifying = candidate;
    }
  }
  return bestQualifying ?? best;
}
