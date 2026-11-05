import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  CONFIDENCE,
  acquisitionTax,
  ageFactor,
  brandTier,
  buildSubject,
  cleanTrades,
  comparableConfidence,
  estimateBestMargin,
  groupComplexes,
  leadBuilder,
  leaveOneOutError,
  lookupCandidates,
  restrictedType,
  spreadOf,
  stationFactor,
  weightedQuantile,
} from '../src/market-estimate.js';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const { lotto, market } = config;
const today = '2026-11-05';
const context = { market, lotto, today };
const { adjustment } = market;

const row = (extra = {}) => ({
  aptName: '비교단지',
  umd: '역삼동',
  jibun: '100',
  buildYear: 2026,
  amount: 84000,
  area: 84,
  floor: 10,
  dealingGbn: '중개거래',
  dealDate: '2026-10-15',
  aptSeq: '',
  ...extra,
});

// 만원/㎡ 단가가 unit인 거래 count건
const rows = (count, unit, extra = {}) => {
  const area = extra.area ?? 84;
  return Array.from({ length: count }, () => row({ amount: unit * area, ...extra }));
};

const subject = (extra = {}) => ({
  ...buildSubject({ name: '공고단지', builder: '', umd: '역삼동', jibun: '1', market }),
  ...extra,
});

const model = { houseType: '084A', area: 84, price: 80000 };

// 단지 키를 계산 코드에서 받아 위치 정보를 붙인다.
function locate(allRows, area, byName) {
  const locations = new Map();
  for (const complex of groupComplexes(allRows, area, context)) {
    locations.set(complex.key, byName[complex.aptName]);
  }
  return locations;
}

const estimate = (allRows, { locations = new Map(), locationOk = true, models = [model], subjectExtra = {}, presaleOk = true, overrides = market } = {}) => estimateBestMargin({
  models,
  rows: allRows,
  subject: subject(subjectExtra),
  locations,
  locationOk,
  presaleOk,
  lotto,
  market: overrides,
  today,
});

test('trade filter drops cancelled, 직거래, low floors, land lease and trades outside the window', () => {
  const kept = cleanTrades([
    row({ aptName: 'keep' }),
    row({ aptName: 'floor-3', floor: 3 }),
    row({ aptName: 'unknown-floor', floor: null }),
    row({ aptName: 'unknown-dealing', dealingGbn: '' }),
    row({ aptName: 'unknown-date', dealDate: null }),
    row({ aptName: 'cancelled', cancelled: true }),
    row({ aptName: 'direct', dealingGbn: '직거래' }),
    row({ aptName: 'floor-1', floor: 1 }),
    row({ aptName: 'floor-2', floor: 2 }),
    row({ aptName: 'basement', floor: -1 }),
    row({ aptName: 'lease', landLease: true }),
    row({ aptName: 'old', dealDate: '2026-03-31' }),
  ], context);
  assert.deepEqual(kept.map((item) => item.aptName), ['keep', 'floor-3', 'unknown-floor', 'unknown-dealing', 'unknown-date']);
});

test('outliers are removed within a complex, but only with enough samples', () => {
  const withOutlier = [...rows(4, 1000), row({ amount: 2000 * 84 })];
  const [complex] = groupComplexes(withOutlier, 84, context);
  assert.equal(complex.samples, 4);
  assert.equal(complex.unit, 1000);

  const few = groupComplexes([...rows(2, 1000), row({ amount: 2000 * 84 })], 84, context);
  assert.equal(few[0].samples, 3);
});

test('recent trades outweigh older ones inside a complex', () => {
  // 5월 거래의 가중치는 약 0.5다. 정렬하면 [1000(0.5), 2000(1)]이고 누적 0.75에 먼저 닿는 값은 2000이다.
  const recentHigh = [row({ amount: 1000 * 84, dealDate: '2026-05-05' }), row({ amount: 2000 * 84, dealDate: '2026-11-05' })];
  assert.equal(groupComplexes(recentHigh, 84, context)[0].unit, 2000);
  // 날짜를 바꾸면 결과도 바뀌어 최근 거래가 값을 정한다는 것을 확인한다.
  const recentLow = [row({ amount: 1000 * 84, dealDate: '2026-11-05' }), row({ amount: 2000 * 84, dealDate: '2026-05-05' })];
  assert.equal(groupComplexes(recentLow, 84, context)[0].unit, 1000);
});

test('one big complex cannot dominate the estimate', () => {
  const allRows = [
    ...rows(50, 3000, { aptName: '대단지', jibun: '11' }),
    ...rows(2, 1000, { aptName: '소단지가', jibun: '2' }),
    ...rows(2, 1100, { aptName: '소단지나', jibun: '3' }),
  ];
  const result = estimate(allRows, { locationOk: false });
  // 거래를 그대로 모았다면 중위값은 3000이다. 단지 단위 중위값은 [1000, 1100, 3000]의 1100이다.
  assert.equal(result.estimate, 1100 * 84);
  assert.equal(result.basis.comparables.length, 3);
  assert.equal(result.basis.samples, 54);
});

test('grouping uses aptSeq when present and joins rows without it by lot', () => {
  const allRows = [
    row({ aptName: '단지(1차)', aptSeq: 'S1', jibun: '5' }),
    row({ aptName: '단지 1차', aptSeq: 'S1', jibun: '5' }),
    row({ aptName: '단지(1차)', aptSeq: '', jibun: '5', presale: true }),
    row({ aptName: '다른단지', aptSeq: '', jibun: '6' }),
    row({ aptName: '다른단지', aptSeq: '', jibun: '6' }),
  ];
  const complexes = groupComplexes(allRows, 84, context);
  assert.deepEqual(complexes.map((item) => [item.key.slice(0, 4), item.samples]), [['seq:', 3], ['lot:', 2]]);
});

test('same-complex trades, including presale, are used without adjustment', () => {
  const allRows = [
    ...rows(2, 1500, { aptName: '공고 단지', jibun: '9' }),
    ...rows(3, 1500, { aptName: '공고단지 아파트', jibun: '9', presale: true, buildYear: null }),
    ...rows(5, 900, { aptName: '래미안옆단지', jibun: '10' }),
  ];
  const result = estimate(allRows, { locationOk: false });
  assert.equal(result.estimate, 1500 * 84);
  assert.equal(result.basis.kind, 'same');
  assert.equal(result.basis.samples, 5);
  assert.equal(result.basis.presaleSamples, 3);
  assert.equal(result.confidence, CONFIDENCE.HIGH);
});

test('same-complex matches by lot in the same 법정동, and needs enough samples', () => {
  const byLot = estimate(rows(3, 1500, { aptName: '옛이름', jibun: '1' }), { locationOk: false });
  assert.equal(byLot.basis.kind, 'same');
  assert.equal(byLot.confidence, CONFIDENCE.MID);

  const otherDong = estimate(rows(5, 1500, { aptName: '공고단지', umd: '삼성동' }), { locationOk: false });
  assert.equal(otherDong.basis.kind, 'comparables');

  const tooFew = estimate(rows(2, 1500, { aptName: '공고단지' }), { locationOk: false });
  assert.equal(tooFew, null);

  // 짧은 이름의 부분 일치는 다른 단지를 같은 단지로 착각할 수 있어 쓰지 않는다.
  const shortName = estimate(rows(5, 1500, { aptName: '자이' }), { subjectExtra: { name: '반포자이 센트럴' }, locationOk: false });
  assert.equal(shortName.basis.kind, 'comparables');
});

test('station bands and factors', () => {
  const { station } = adjustment;
  const cases = [[0, 1.06], [300, 1.06], [301, 1.04], [500, 1.04], [501, 1.02], [800, 1.02], [801, 1], [1200, 1], [1201, 0.97], [null, 0.97]];
  for (const [distance, factor] of cases) assert.equal(stationFactor(distance, station), factor, String(distance));
});

test('brand tiers come from the name first, then the lead builder, and unknown is neutral', () => {
  const { brand } = adjustment;
  assert.equal(brandTier({ name: '래미안 원베일리' }, brand), 'top');
  assert.equal(brandTier({ name: '힐스테이트 수원' }, brand), 'top');
  assert.equal(brandTier({ name: '광교 자연앤 센트레빌' }, brand), 'mid');
  assert.equal(brandTier({ name: '시흥 베르디움' }, brand), 'mid');
  assert.equal(brandTier({ name: '어딘가 빌라트' }, brand), 'other');
  assert.equal(brandTier({ name: '' }, brand), 'other');
  assert.equal(brand.factors.other, 1);
  assert.ok(brand.factors.top > brand.factors.mid && brand.factors.mid > brand.factors.other);

  assert.equal(brandTier({ name: '남양주 어딘가', builder: 'GS건설(주)' }, brand), 'top');
  assert.equal(brandTier({ name: '남양주 어딘가', builder: '호반건설' }, brand), 'mid');
  // 컨소시엄은 주간사를 본다.
  assert.equal(leadBuilder('무명건설(주), 현대건설(주)'), '무명건설(주)');
  assert.equal(brandTier({ name: '남양주 어딘가', builder: '무명건설(주), 현대건설(주)' }, brand), 'other');
  assert.equal(brandTier({ name: '남양주 어딘가', builder: '대우건설㈜·무명건설' }, brand), 'top');
  // 단지명의 브랜드가 시공사보다 먼저다.
  assert.equal(brandTier({ name: '래미안 어딘가', builder: '호반건설' }, brand), 'top');
});

test('age factor falls with age and is bounded', () => {
  const { age } = adjustment;
  assert.equal(ageFactor(0, age), 1);
  assert.equal(ageFactor(-1, age), 1);
  assert.ok(Math.abs(ageFactor(10, age) - 0.9) < 1e-9);
  assert.ok(Math.abs(ageFactor(20, age) - 0.8) < 1e-9);
  assert.equal(ageFactor(60, age), ageFactor(20, age));
});

test('subject farther from a station and of a lower brand tier is valued below a 역세권 top-brand comparable', () => {
  const allRows = rows(5, 2000, { aptName: '래미안역세권', jibun: '50' });
  const locations = locate(allRows, 84, { 래미안역세권: { distanceM: 300, stationM: 200 } });
  const result = estimate(allRows, { locations, subjectExtra: { stationM: 900, brandTier: 'other' } });
  // 2000 / (1.06 × 1.05) = 1796.945..., × 84 = 150943
  assert.equal(result.estimate, 150943);
  assert.ok(result.estimate < 2000 * 84);
  assert.equal(result.basis.stationUsed, true);

  // 아무 보정이 없으면 같은 값이 나온다.
  const plain = rows(5, 2000, { aptName: '무명단지', jibun: '51' });
  const same = estimate(plain, {
    locations: locate(plain, 84, { 무명단지: { distanceM: 300, stationM: 900 } }),
    subjectExtra: { stationM: 900, brandTier: 'other' },
  });
  assert.equal(same.estimate, 2000 * 84);
});

test('each adjustment moves the estimate the right way', () => {
  const run = (complex, location, subjectExtra) => {
    const allRows = rows(5, 2000, { jibun: '50', ...complex });
    return estimate(allRows, { locations: locate(allRows, 84, { [complex.aptName]: location }), subjectExtra }).estimate;
  };
  const base = 2000 * 84;
  // 비교 단지가 역에 더 가까우면 공고 단지 값이 내려가고, 더 멀면 올라간다.
  assert.ok(run({ aptName: '가단지' }, { distanceM: 100, stationM: 100 }, { stationM: 1000 }) < base);
  assert.ok(run({ aptName: '가단지' }, { distanceM: 100, stationM: 1000 }, { stationM: 100 }) > base);
  // 비교 단지의 브랜드가 더 높으면 내려가고, 공고 단지가 더 높으면 올라간다.
  assert.ok(run({ aptName: '래미안가' }, { distanceM: 100, stationM: 1000 }, { stationM: 1000 }) < base);
  assert.ok(run({ aptName: '가단지' }, { distanceM: 100, stationM: 1000 }, { stationM: 1000, brandTier: 'top' }) > base);
  // 낡은 비교 단지는 신축인 공고 단지 기준으로 올린다.
  assert.ok(run({ aptName: '가단지', buildYear: 2006 }, { distanceM: 100, stationM: 1000 }, { stationM: 1000 }) > base);
  assert.equal(run({ aptName: '가단지', buildYear: 2006 }, { distanceM: 100, stationM: 1000 }, { stationM: 1000 }), Math.round((2000 / 0.8) * 84));
  // 건축년도를 모르면 연식 보정을 하지 않고, 분양권만 있는 단지는 신축으로 본다.
  assert.equal(run({ aptName: '가단지', buildYear: null }, { distanceM: 100, stationM: 1000 }, { stationM: 1000 }), base);
  assert.equal(run({ aptName: '가단지', buildYear: null, presale: true }, { distanceM: 100, stationM: 1000 }, { stationM: 1000 }), base);
});

test('the total adjustment is bounded', () => {
  const allRows = rows(5, 1000, { aptName: '나단지', buildYear: 1960, jibun: '50' });
  const locations = locate(allRows, 84, { 나단지: { distanceM: 100, stationM: 5000 } });
  const result = estimate(allRows, { locations, subjectExtra: { stationM: 100, brandTier: 'top' } });
  // 1.06 × 1.05 / (0.97 × 0.8)는 1.43이지만 상한 1.35에서 멈춘다.
  assert.equal(result.estimate, Math.round(1000 * 1.35 * 84));
});

test('comparables are chosen by distance within the limit and weighted toward the nearest', () => {
  const allRows = [
    ...rows(3, 1000, { aptName: '가단지', jibun: '1a' }),
    ...rows(3, 2000, { aptName: '나단지', jibun: '2a' }),
    ...rows(3, 3000, { aptName: '다단지', jibun: '3a' }),
    ...rows(3, 9000, { aptName: '먼단지', jibun: '4a' }),
  ];
  const station = 1000;
  const nearLow = locate(allRows, 84, {
    가단지: { distanceM: 0, stationM: station },
    나단지: { distanceM: 1000, stationM: station },
    다단지: { distanceM: 2000, stationM: station },
    먼단지: { distanceM: 2001, stationM: station },
  });
  const low = estimate(allRows, { locations: nearLow, subjectExtra: { stationM: station } });
  assert.equal(low.basis.comparables.length, 3);
  assert.ok(!low.basis.comparables.some((item) => item.name === '먼단지'));
  // 가중치 1, 1/2, 1/3의 합은 1.833이고 절반 0.917에 처음 닿는 값은 1000이다.
  assert.equal(low.estimate, 1000 * 84);

  const nearHigh = locate(allRows, 84, {
    가단지: { distanceM: 2000, stationM: station },
    나단지: { distanceM: 1000, stationM: station },
    다단지: { distanceM: 0, stationM: station },
    먼단지: { distanceM: 2001, stationM: station },
  });
  // 정렬하면 1000(1/3), 2000(1/2), 3000(1)이고 누적이 0.917에 닿는 값은 3000이다.
  assert.equal(estimate(allRows, { locations: nearHigh, subjectExtra: { stationM: station } }).estimate, 3000 * 84);

  const limited = { ...market, comparables: { ...market.comparables, maxComparables: 2 } };
  const two = estimateBestMargin({ models: [model], rows: allRows, subject: subject({ stationM: station }), locations: nearLow, locationOk: true, lotto, market: limited, today });
  assert.deepEqual(two.basis.comparables.map((item) => item.name), ['가단지', '나단지']);
});

test('too few samples within the distance falls back to the district scope at low confidence', () => {
  const allRows = [...rows(2, 1000, { aptName: '가단지', jibun: '1a' }), ...rows(5, 2000, { aptName: '나단지', jibun: '2a' })];
  const locations = locate(allRows, 84, { 가단지: { distanceM: 100, stationM: 100 }, 나단지: { distanceM: 9000, stationM: 100 } });
  const result = estimate(allRows, { locations, subjectExtra: { stationM: 100 } });
  assert.equal(result.basis.stationUsed, false);
  assert.equal(result.basis.scope, '법정동');
  assert.equal(result.confidence, CONFIDENCE.LOW);
});

test('weighted quantile and spread arithmetic', () => {
  const equal = (values) => values.map((value) => ({ value, weight: 1 }));
  assert.equal(weightedQuantile(equal([4, 1, 3, 2]), 0.25), 1);
  assert.equal(weightedQuantile(equal([4, 1, 3, 2]), 0.5), 2);
  assert.equal(weightedQuantile(equal([5]), 0.25), 5);
  assert.equal(weightedQuantile([], 0.5), null);
  assert.equal(weightedQuantile([{ value: 1, weight: 1 }, { value: 2, weight: 3 }], 0.25), 1);
  assert.equal(weightedQuantile([{ value: 1, weight: 1 }, { value: 2, weight: 3 }], 0.26), 2);
  // 단순 사분위: 0.25 → 100, 0.5 → 110, 0.75 → 120
  assert.ok(Math.abs(spreadOf([100, 110, 120, 130]) - 20 / 110) < 1e-9);
});

test('margin takes the lower quartile and subtracts price, option and acquisition tax', () => {
  const allRows = [
    ...rows(3, 1000, { aptName: '가단지', jibun: '1a', area: 100 }),
    ...rows(3, 1100, { aptName: '나단지', jibun: '2a', area: 100 }),
    ...rows(3, 1200, { aptName: '다단지', jibun: '3a', area: 100 }),
    ...rows(3, 1300, { aptName: '라단지', jibun: '4a', area: 100 }),
  ];
  const result = estimate(allRows, { locationOk: false, models: [{ houseType: '100A', area: 100, price: 80000 }] });
  assert.equal(result.estimate, 110000);
  assert.equal(result.safeValue, 100000);
  // 8억의 세율은 1% + 2% × (2/3) = 2.3333%, 교육세 포함 × 1.1. 80000 × 0.0256667 = 2053
  assert.equal(result.tax, 2053);
  assert.equal(result.optionCost, 1500);
  assert.equal(result.margin, 100000 - 80000 - 1500 - 2053);
  assert.ok(Math.abs(result.marginRate - 16447 / 100000) < 1e-9);
});

test('acquisition tax at each boundary includes the education tax', () => {
  const tax = market.acquisitionTax;
  assert.equal(acquisitionTax(30000, tax), 330);
  assert.equal(acquisitionTax(60000, tax), 660);
  assert.equal(acquisitionTax(60300, tax), Math.round(60300 * (0.01 + 0.02 * (300 / 30000)) * 1.1));
  // 7.5억은 구간의 가운데라 2%다.
  assert.equal(acquisitionTax(75000, tax), 1650);
  assert.equal(acquisitionTax(90000, tax), 2970);
  assert.equal(acquisitionTax(90001, tax), Math.round(90001 * 0.033));
  assert.equal(acquisitionTax(100000, tax), 3300);
});

test('confidence levels', () => {
  const good = { samples: 20, comparables: 4, spread: 0.15, looError: 0.1, locationUsed: true, presaleOk: true };
  const level = (extra) => comparableConfidence({ ...good, ...extra }, market.confidence);
  assert.equal(level({}), CONFIDENCE.HIGH);
  assert.equal(level({ samples: 19 }), CONFIDENCE.MID);
  assert.equal(level({ comparables: 3 }), CONFIDENCE.MID);
  assert.equal(level({ spread: 0.16 }), CONFIDENCE.MID);
  assert.equal(level({ looError: 0.11 }), CONFIDENCE.MID);
  // 검증할 수 없으면 상이 될 수 없다.
  assert.equal(level({ looError: null }), CONFIDENCE.MID);
  assert.equal(level({ samples: 4 }), CONFIDENCE.LOW);
  assert.equal(level({ comparables: 1 }), CONFIDENCE.LOW);
  assert.equal(level({ spread: 0.31 }), CONFIDENCE.LOW);
  assert.equal(level({ looError: 0.21 }), CONFIDENCE.LOW);
  // 위치 조회가 실패하면 표본과 무관하게 하다.
  assert.equal(level({ locationUsed: false }), CONFIDENCE.LOW);
  // 분양권 조회가 실패하면 한 단계 내린다.
  assert.equal(level({ presaleOk: false }), CONFIDENCE.MID);
  assert.equal(level({ samples: 19, presaleOk: false }), CONFIDENCE.LOW);
  assert.equal(level({ locationUsed: false, presaleOk: false }), CONFIDENCE.LOW);
});

test('leave-one-out error is computed by hand and uses the adjustments', () => {
  const options = { useStation: true, subjectAge: 0 };
  const complex = (unit, extra = {}) => ({ unit, brandTier: 'other', ageYears: 0, stationM: 1000, ...extra });
  assert.equal(leaveOneOutError([complex(1000), complex(1000)], adjustment, options), null);
  // 오차: (1000→1150) 0.15, (1000→1150) 0.15, (1300→1000) 0.2308. 중위값은 0.15다.
  const plain = leaveOneOutError([complex(1000), complex(1000), complex(1300)], adjustment, options);
  assert.ok(Math.abs(plain - 0.15) < 1e-9);
  // 브랜드 차이가 가격 차이를 설명하면 오차가 사라진다.
  const explained = leaveOneOutError([complex(1000), complex(1000), complex(1050, { brandTier: 'top' })], adjustment, options);
  assert.ok(explained < 1e-9);
  const unexplained = leaveOneOutError([complex(1000), complex(1000), complex(1050)], adjustment, options);
  assert.ok(unexplained > 0.01);
});

test('confidence flows through the estimate: presale failure lowers it, and same-complex stays above comparables', () => {
  const allRows = [
    ...rows(5, 1000, { aptName: '가단지', jibun: '1a' }),
    ...rows(5, 1000, { aptName: '나단지', jibun: '2a' }),
    ...rows(5, 1000, { aptName: '다단지', jibun: '3a' }),
    ...rows(5, 1000, { aptName: '라단지', jibun: '4a' }),
  ];
  const located = (name) => ({ [name]: { distanceM: 100, stationM: 1000 } });
  const locations = locate(allRows, 84, { ...located('가단지'), ...located('나단지'), ...located('다단지'), ...located('라단지') });
  const subjectExtra = { stationM: 1000 };
  assert.equal(estimate(allRows, { locations, subjectExtra }).confidence, CONFIDENCE.HIGH);
  assert.equal(estimate(allRows, { locations, subjectExtra, presaleOk: false }).confidence, CONFIDENCE.MID);
  assert.equal(estimate(allRows, { locationOk: false, subjectExtra }).confidence, CONFIDENCE.LOW);

  const same = rows(5, 1500, { aptName: '공고단지', jibun: '9' });
  assert.equal(estimate(same, { presaleOk: false, locationOk: false }).confidence, CONFIDENCE.MID);
});

test('location candidates prefer the same 법정동 and are capped, and same-complex models need no lookup', () => {
  const others = Array.from({ length: 30 }, (_, index) => rows(2, 1000, { aptName: `단지${index}`, umd: '삼성동', jibun: String(100 + index) })).flat();
  const allRows = [...others, ...rows(2, 1000, { aptName: '같은동', jibun: '7' })];
  const candidates = lookupCandidates({ models: [model], rows: allRows, subject: subject(), lotto, market, today });
  assert.equal(candidates.length, market.comparables.maxLookupsPerNotice);
  assert.equal(candidates[0].aptName, '같은동');

  const noJibun = lookupCandidates({ models: [model], rows: rows(5, 1000, { aptName: '지번없음', jibun: '' }), subject: subject(), lotto, market, today });
  assert.deepEqual(noJibun, []);

  const sameRows = [...allRows, ...rows(5, 1500, { aptName: '공고단지', jibun: '9' })];
  assert.deepEqual(lookupCandidates({ models: [model], rows: sameRows, subject: subject(), lotto, market, today }), []);
});

test('restricted types are found across spacing and the source type label', () => {
  const find = (notice) => restrictedType(notice, market);
  assert.equal(find({ name: '고덕강일 3단지 토지임대부' }), '토지임대');
  assert.equal(find({ name: '고덕강일 토지 임대부 주택' }), '토지임대');
  assert.equal(find({ name: '광교 자연앤 센트레빌 59㎡ 지분적립형' }), '지분적립');
  assert.equal(find({ name: '광교 지분 적립형 분양주택' }), '지분적립');
  assert.equal(find({ name: '하남교산 신혼희망타운' }), '신혼희망');
  assert.equal(find({ name: '하남교산 신혼 희망 타운' }), '신혼희망');
  assert.equal(find({ name: '하남교산 A1블록', houseSecd: '10' }), '신혼희망');
  assert.equal(find({ name: '하남교산 A1블록', typeLabel: '신혼희망타운' }), '신혼희망');
  assert.equal(find({ name: '광교 자연앤 센트레빌' }), null);
  assert.equal(find({ name: '일반 단지', houseSecd: '01', typeLabel: 'APT' }), null);
  assert.equal(find({}), null);
});
