import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  CONFIDENCE,
  STATION,
  acquisitionTax,
  ageFactor,
  brandTier,
  buildSubject,
  cleanTrades,
  comparableConfidence,
  dropComplexOutliers,
  estimateBestMargin,
  groupComplexes,
  leadBuilder,
  leaveOneOutError,
  localityConflict,
  marginRateOf,
  meetsPriceRule,
  lookupCandidates,
  parseLocality,
  normalizeComplexName,
  matchApartment,
  parseWalkMinutes,
  restrictedType,
  safeDiscount,
  selectComparables,
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

// 단지 키를 계산 코드에서 받아 역 정보를 붙인다.
function walks(allRows, area, byName) {
  const stations = new Map();
  for (const complex of groupComplexes(allRows, area, context)) {
    if (byName[complex.aptName] !== undefined) stations.set(complex.key, { walkMinutes: byName[complex.aptName], walkBand: `${byName[complex.aptName]}분` });
  }
  return stations;
}

const estimate = (allRows, { stations = new Map(), models = [model], subjectExtra = {}, presaleOk = true, overrides = market } = {}) => estimateBestMargin({
  models,
  rows: allRows,
  subject: subject(subjectExtra),
  stations,
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
  const result = estimate(allRows);
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
  const result = estimate(allRows);
  assert.equal(result.estimate, 1500 * 84);
  assert.equal(result.basis.kind, 'same');
  assert.equal(result.basis.samples, 5);
  assert.equal(result.basis.presaleSamples, 3);
  assert.equal(result.confidence, CONFIDENCE.HIGH);
});

test('same-complex matches by lot in the same 법정동, and needs enough samples', () => {
  const byLot = estimate(rows(3, 1500, { aptName: '옛이름', jibun: '1' }));
  assert.equal(byLot.basis.kind, 'same');
  assert.equal(byLot.confidence, CONFIDENCE.MID);

  const otherDong = estimate(rows(5, 1500, { aptName: '공고단지', umd: '삼성동' }));
  assert.equal(otherDong.basis.kind, 'comparables');

  const tooFew = estimate(rows(2, 1500, { aptName: '공고단지' }));
  assert.equal(tooFew, null);

  // 짧은 이름의 부분 일치는 다른 단지를 같은 단지로 착각할 수 있어 쓰지 않는다.
  const shortName = estimate(rows(5, 1500, { aptName: '자이' }), { subjectExtra: { name: '반포자이 센트럴' } });
  assert.equal(shortName.basis.kind, 'comparables');
});

test('without a known 법정동 only an exact name counts as the same complex', () => {
  const noDong = { umd: null, jibun: null };
  const phase2 = estimate(rows(5, 1500, { aptName: '힐스테이트동탄' }), { subjectExtra: { ...noDong, name: '힐스테이트 동탄 2차' } });
  assert.equal(phase2.basis.kind, 'comparables');
  const longerRow = estimate(rows(5, 1500, { aptName: '힐스테이트 동탄 2차' }), { subjectExtra: { ...noDong, name: '힐스테이트동탄' } });
  assert.equal(longerRow.basis.kind, 'comparables');
  const distinct = estimate(rows(5, 1500, { aptName: '화성동탄 자연앤 푸른마을 2차' }), { subjectExtra: { ...noDong, name: '화성동탄 자연앤 푸른마을' } });
  assert.equal(distinct.basis.kind, 'comparables');
  const exact = estimate(rows(5, 1500, { aptName: '힐스테이트 동탄' }), { subjectExtra: { ...noDong, name: '힐스테이트동탄' } });
  assert.equal(exact.basis.kind, 'same');
});

test('a brand-only or brand-prefix name cannot match by substring', () => {
  const kind = (aptName, name) => estimate(rows(5, 1500, { aptName }), { subjectExtra: { name } }).basis.kind;
  assert.equal(kind('힐스테이트', '힐스테이트 수원'), 'comparables');
  assert.equal(kind('힐스테이트 광교', '힐스테이트'), 'comparables');
  assert.equal(kind('e편한세상', 'e편한세상 시흥'), 'comparables');
  assert.equal(kind('e편한세상 거모', 'e편한세상'), 'comparables');
  assert.equal(kind('힐스테이트1차', '힐스테이트1차 수원'), 'comparables');
  assert.equal(kind('e편한세상 시흥 2차', 'e편한세상 시흥'), 'comparables');
  // 브랜드 말고 고유한 이름이 충분하면 같은 법정동 안에서는 그대로 묶는다.
  assert.equal(kind('광교자연앤센트레빌 1단지', '광교 자연앤 센트레빌'), 'same');
  assert.equal(kind('힐스테이트 원베일리 2차', '힐스테이트 원베일리'), 'same');
});

test('station bands use walking minutes and walk bands parse to their upper bound', () => {
  const { station } = adjustment;
  const cases = [[0, 1.06], [5, 1.06], [6, 1.04], [10, 1.04], [11, 1.02], [15, 1.02], [16, 1], [20, 1], [21, 0.97], [60, 0.97]];
  for (const [minutes, factor] of cases) assert.equal(stationFactor(minutes, station), factor, String(minutes));

  const parsed = [['5분이내', 5], ['5~10분이내', 10], ['10~15분이내', 15], ['15~20분이내', 20], ['20분초과', 21], [' 5 ~ 10분이내 ', 10], ['7', 7], [7, 7], ['7분', 7]];
  for (const [text, minutes] of parsed) assert.equal(parseWalkMinutes(text), minutes, String(text));
  for (const text of ['', null, undefined, '정보없음', '도보10분', '-']) assert.equal(parseWalkMinutes(text), null, String(text));
  // 구간 값과 직접 입력한 분이 같은 표를 쓴다.
  assert.equal(stationFactor(parseWalkMinutes('5~10분이내'), station), stationFactor(7, station));
  assert.equal(stationFactor(parseWalkMinutes('20분초과'), station), station.otherFactor);
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
  assert.ok(Math.abs(ageFactor(10, age) - 0.95) < 1e-9);
  assert.ok(Math.abs(ageFactor(20, age) - 0.9) < 1e-9);
  assert.equal(ageFactor(60, age), ageFactor(20, age));
});

test('subject farther from a station and of a lower brand tier is valued below a 역세권 top-brand comparable', () => {
  const allRows = rows(5, 2000, { aptName: '래미안역세권', jibun: '50' });
  const stations = walks(allRows, 84, { 래미안역세권: 3 });
  const result = estimate(allRows, { stations, subjectExtra: { walkMinutes: 15, brandTier: 'other' } });
  // 2000 × 1.02 / (1.06 × 1.05) × 84 = 153962
  assert.equal(result.estimate, 153962);
  assert.ok(result.estimate < 2000 * 84);
  assert.equal(result.basis.stationState, STATION.USED);

  // 조건이 같으면 값이 그대로다.
  const plain = rows(5, 2000, { aptName: '무명단지', jibun: '51' });
  const same = estimate(plain, { stations: walks(plain, 84, { 무명단지: 15 }), subjectExtra: { walkMinutes: 15, brandTier: 'other' } });
  assert.equal(same.estimate, 2000 * 84);
});

test('a 10-year-old top-brand complex 3 minutes from a station stays above a new unbranded subject 15 minutes out', () => {
  const allRows = rows(5, 2000, { aptName: '래미안역세권', jibun: '50', buildYear: 2016 });
  const stations = walks(allRows, 84, { 래미안역세권: 3 });
  const result = estimate(allRows, { stations, subjectExtra: { walkMinutes: 15, brandTier: 'other', ageYears: 0 } });
  // 2000 × 1.02 / (1.06 × 1.05 × 0.95) × 84 = 162066. 비교 단지 자체 단가보다 약 3.5% 낮다.
  assert.equal(result.estimate, 162066);
  assert.ok(result.estimate < 2000 * 84 * 0.97);
});

test('a subject in the neutral band is still adjusted against a comparable near a station', () => {
  const allRows = rows(5, 2000, { aptName: '가단지', jibun: '50' });
  const result = estimate(allRows, { stations: walks(allRows, 84, { 가단지: 3 }), subjectExtra: { walkMinutes: 20 } });
  // 공고 단지 계수가 정확히 1이어도 비교 단지 계수는 적용한다. 2000 / 1.06 × 84 = 158491
  assert.equal(result.estimate, 158491);
});

test('each adjustment moves the estimate the right way', () => {
  const run = (complex, walk, subjectExtra) => {
    const allRows = rows(5, 2000, { jibun: '50', ...complex });
    return estimate(allRows, { stations: walks(allRows, 84, { [complex.aptName]: walk }), subjectExtra }).estimate;
  };
  const base = 2000 * 84;
  // 비교 단지가 역에 더 가까우면 공고 단지 값이 내려가고, 더 멀면 올라간다.
  assert.ok(run({ aptName: '가단지' }, 3, { walkMinutes: 18 }) < base);
  assert.ok(run({ aptName: '가단지' }, 18, { walkMinutes: 3 }) > base);
  // 비교 단지의 브랜드가 더 높으면 내려가고, 공고 단지가 더 높으면 올라간다.
  assert.ok(run({ aptName: '래미안가' }, 18, { walkMinutes: 18 }) < base);
  assert.ok(run({ aptName: '가단지' }, 18, { walkMinutes: 18, brandTier: 'top' }) > base);
  // 낡은 비교 단지는 신축인 공고 단지 기준으로 올린다.
  assert.ok(run({ aptName: '가단지', buildYear: 2006 }, 18, { walkMinutes: 18 }) > base);
  assert.equal(run({ aptName: '가단지', buildYear: 2006 }, 18, { walkMinutes: 18 }), Math.round((2000 / 0.9) * 84));
  // 건축년도를 모르면 연식 보정을 하지 않고, 분양권만 있는 단지는 신축으로 본다.
  assert.equal(run({ aptName: '가단지', buildYear: null }, 18, { walkMinutes: 18 }), base);
  assert.equal(run({ aptName: '가단지', buildYear: null, presale: true }, 18, { walkMinutes: 18 }), base);
});

test('the total adjustment is bounded', () => {
  const allRows = rows(5, 1000, { aptName: '나단지', buildYear: 1960, jibun: '50' });
  const stations = walks(allRows, 84, { 나단지: 40 });
  const overrides = { ...market, adjustment: { ...adjustment, maxFactor: 1.2 } };
  const result = estimate(allRows, { stations, overrides, subjectExtra: { walkMinutes: 3, brandTier: 'top' } });
  // 1.06 × 1.05 / (0.97 × 0.9)는 1.275지만 상한으로 둔 1.2에서 멈춘다.
  assert.equal(result.estimate, Math.round(1000 * 1.2 * 84));
});

test('comparables come from the same 법정동, then the 시군구, ranked by samples with equal weights', () => {
  const allRows = [
    ...rows(3, 1000, { aptName: '가단지', jibun: '1a' }),
    ...rows(5, 2000, { aptName: '나단지', jibun: '2a' }),
    ...rows(4, 3000, { aptName: '다단지', jibun: '3a' }),
    ...rows(9, 9000, { aptName: '옆동단지', jibun: '4a', umd: '삼성동' }),
  ];
  const sameDong = estimate(allRows);
  assert.equal(sameDong.basis.scope, '법정동');
  assert.deepEqual(sameDong.basis.comparables.map((item) => item.name), ['나단지', '다단지', '가단지']);
  // 단지마다 같은 가중치라 중위값은 2000이다.
  assert.equal(sameDong.estimate, 2000 * 84);

  const widened = estimate([...rows(2, 1000, { aptName: '가단지', jibun: '1a' }), ...rows(9, 9000, { aptName: '옆동단지', jibun: '4a', umd: '삼성동' })]);
  assert.equal(widened.basis.scope, '시군구');
  assert.deepEqual(widened.basis.comparables.map((item) => item.name), ['옆동단지', '가단지']);

  const limited = { ...market, comparables: { ...market.comparables, maxComparables: 2 } };
  assert.deepEqual(estimate(allRows, { overrides: limited }).basis.comparables.map((item) => item.name), ['나단지', '다단지']);
});

test('no input means no station adjustment even with comparable values, and caps confidence at 중', () => {
  const allRows = ['가', '나', '다', '라'].flatMap((name, index) => rows(5, 1000, { aptName: `${name}단지`, jibun: `${index}a` }));
  const stations = walks(allRows, 84, { 가단지: 3, 나단지: 3, 다단지: 3, 라단지: 3 });
  const empty = estimate(allRows, { stations });
  assert.equal(empty.basis.stationState, STATION.NO_INPUT);
  assert.equal(empty.estimate, 1000 * 84);
  assert.equal(empty.confidence, CONFIDENCE.MID);
  const filled = estimate(allRows, { stations, subjectExtra: { walkMinutes: 3 } });
  assert.equal(filled.basis.stationState, STATION.USED);
  assert.equal(filled.confidence, CONFIDENCE.HIGH);
});

test('too few comparable values skip the station adjustment for the whole estimate rather than mixing', () => {
  const allRows = ['가', '나', '다', '라', '마'].flatMap((name, index) => rows(5, 1000, { aptName: `${name}단지`, jibun: `${index}a` }));
  const twoOfFive = walks(allRows, 84, { 가단지: 3, 나단지: 3 });
  const skipped = estimate(allRows, { stations: twoOfFive, subjectExtra: { walkMinutes: 18 } });
  assert.equal(skipped.basis.stationState, STATION.NO_DATA);
  assert.equal(skipped.estimate, 1000 * 84);
  assert.ok(skipped.basis.comparables.every((item) => item.walkBand === null));
  assert.equal(skipped.confidence, CONFIDENCE.MID);

  // 기준을 넘으면 값이 있는 단지만 보정하고, 값이 없는 단지는 역 계수를 받지 않는다.
  const threeRows = ['가', '나', '다'].flatMap((name, index) => rows(5, 1000, { aptName: `${name}단지`, jibun: `${index}a` }));
  const twoOfThree = walks(threeRows, 84, { 가단지: 3, 나단지: 3 });
  const used = estimate(threeRows, { stations: twoOfThree, subjectExtra: { walkMinutes: 15 } });
  assert.equal(used.basis.stationState, STATION.USED);
  // [1000 × 1.02 / 1.06 두 곳, 1000]의 중위값 × 84 = 80830
  assert.equal(used.estimate, 80830);
  assert.deepEqual(used.basis.comparables.map((item) => item.walkBand), ['3분', '3분', null]);

  // 값이 없는 단지는 `그 밖` 구간으로 치지 않고 역 계수를 받지 않는다. 중위값이 그 단지의 1000 그대로다.
  const middle = [
    ...rows(5, 900, { aptName: '가단지', jibun: '1a' }),
    ...rows(5, 1100, { aptName: '나단지', jibun: '2a' }),
    ...rows(5, 1000, { aptName: '다단지', jibun: '3a' }),
  ];
  const unmatched = estimate(middle, { stations: walks(middle, 84, { 가단지: 3, 나단지: 3 }), subjectExtra: { walkMinutes: 3 } });
  assert.equal(unmatched.estimate, 1000 * 84);
});

test('widening to the 시군구 while the 법정동 had enough trades lowers confidence one level', () => {
  const pick = (allRows) => selectComparables(groupComplexes(allRows, 84, context), subject(), context);
  const youngElsewhere = [...rows(3, 1500, { aptName: '옆동가', umd: '삼성동', jibun: '8', buildYear: 2016 }), ...rows(3, 1600, { aptName: '옆동나', umd: '삼성동', jibun: '9', buildYear: 2018 })];
  const oldHere = [...rows(6, 500, { aptName: '구축가', jibun: '3', buildYear: 1995 })];
  const penalised = pick([...youngElsewhere, ...oldHere]);
  assert.equal(penalised.scope, '시군구');
  assert.equal(penalised.scopePenalty, true);
  const thinHere = pick([...youngElsewhere, ...rows(3, 500, { aptName: '구축가', jibun: '3', buildYear: 1995 })]);
  assert.equal(thinHere.scope, '시군구');
  assert.equal(thinHere.scopePenalty, false);

  const level = (scopePenalty) => comparableConfidence({ samples: 20, comparables: 4, spread: 0.1, looError: 0.05, stationState: STATION.USED, presaleOk: true, scopePenalty }, market.confidence);
  assert.equal(level(false), CONFIDENCE.HIGH);
  assert.equal(level(true), CONFIDENCE.MID);

  // 다른 동 신축 2곳, 표본 6건이면 보통 중이지만 이 경우 하다.
  const result = estimate([...youngElsewhere, ...oldHere].map((row) => ({ ...row })), { models: [{ houseType: '084A', area: 84, price: 80000 }] });
  assert.equal(result.basis.scope, '시군구');
  assert.equal(result.confidence, CONFIDENCE.LOW);
});

test('읍·면·리 and 동 names are parsed and compared by their parts', () => {
  assert.deepEqual(parseLocality('화도읍 마석우리'), { town: '화도읍', village: '마석우리', dong: null });
  assert.deepEqual(parseLocality('마석우리'), { town: null, village: '마석우리', dong: null });
  assert.deepEqual(parseLocality('다산동'), { town: null, village: null, dong: '다산동' });
  assert.deepEqual(parseLocality('청평면'), { town: '청평면', village: null, dong: null });
  const subjectPlace = { town: '화도읍', village: '마석우리', dong: null };
  assert.equal(localityConflict(subjectPlace, parseLocality('화도읍 마석우리')), false);
  assert.equal(localityConflict(subjectPlace, parseLocality('마석우리')), false);
  assert.equal(localityConflict(subjectPlace, parseLocality('화도읍')), false);
  assert.equal(localityConflict(subjectPlace, parseLocality('')), false);
  assert.equal(localityConflict(subjectPlace, parseLocality('화도읍 가곡리')), true);
  assert.equal(localityConflict(subjectPlace, parseLocality('오남읍 양지리')), true);
  assert.equal(localityConflict(subjectPlace, parseLocality('다산동')), true);
  assert.equal(localityConflict({ town: null, village: null, dong: '역삼동' }, parseLocality('삼성동')), true);
});

const namyangju = (umd, village) => ({ umd, village });

test('읍·면 subjects look in the same 리, then the same 읍·면, before the whole 시군구', () => {
  const pick = (allRows, place) => selectComparables(groupComplexes(allRows, 84, context), subject(place), context);
  const dasan = ['다산가', '다산나', '다산다'].flatMap((name, index) => rows(20, 1230, { aptName: name, umd: '다산동', jibun: `d${index}`, buildYear: 2019 }));
  const oNamVillage = [...rows(3, 700, { aptName: '오남가', umd: '오남읍 양지리', jibun: 'o1', buildYear: 2016 }), ...rows(3, 720, { aptName: '오남나', umd: '오남읍 양지리', jibun: 'o2', buildYear: 2018 })];
  const village = pick([...dasan, ...oNamVillage], namyangju('오남읍', '양지리'));
  assert.equal(village.scope, '리');
  assert.equal(village.townWide, false);
  assert.ok(village.picked.every((item) => item.umd.startsWith('오남읍')));

  const oNamTown = [...rows(3, 700, { aptName: '오남가', umd: '오남읍 오남리', jibun: 'o1', buildYear: 2016 }), ...rows(3, 720, { aptName: '오남나', umd: '오남읍 신정리', jibun: 'o2', buildYear: 2018 })];
  const town = pick([...dasan, ...oNamTown], namyangju('오남읍', '양지리'));
  assert.equal(town.scope, '읍·면');
  assert.equal(town.townWide, false);

  const none = pick(dasan, namyangju('오남읍', '양지리'));
  assert.equal(none.scope, '시군구');
  assert.equal(none.townWide, true);
  // 동 주소는 예전처럼 법정동, 시군구 순이고 시군구여도 하로 묶지 않는다.
  const dong = pick(dasan, namyangju('별내동', null));
  assert.equal(dong.scope, '시군구');
  assert.equal(dong.townWide, false);
});

test('a 읍·면 subject valued from the whole 시군구 is 하 and its reason says so', () => {
  const dasan = ['다산가', '다산나', '다산다', '다산라'].flatMap((name, index) => rows(20, 1230, { aptName: name, umd: '다산동', jibun: `d${index}`, buildYear: 2019 }));
  const result = estimate(dasan, { subjectExtra: namyangju('오남읍', '양지리') });
  assert.equal(result.basis.townWide, true);
  assert.equal(result.confidence, CONFIDENCE.LOW);
  // 같은 단지 4곳, 표본 80건이면 동 주소에서는 역 도보 입력이 없어 중이다.
  assert.equal(estimate(dasan, { subjectExtra: namyangju('별내동', null) }).confidence, CONFIDENCE.MID);
});

test('a 리-less 읍·면 subject does not take a bare 리 row from elsewhere by partial name', () => {
  const place = { umd: '오남읍', village: null, jibun: null, name: '더샵퍼스트시티 오남' };
  const kind = (umd, aptName = '더샵퍼스트시티') => estimate(rows(5, 1500, { aptName, umd, jibun: '9' }), { subjectExtra: place }).basis.kind;
  // 리만 적힌 마석우리는 화도읍이라 오남읍 공고와 이름 일부가 같아도 다른 단지다.
  assert.equal(kind('마석우리'), 'comparables');
  // 같은 읍이거나 지역이 비어 있으면 예전처럼 포함 관계를 쓴다.
  assert.equal(kind('오남읍 양지리'), 'same');
  assert.equal(kind(''), 'same');
  // 이름이 정확히 같으면 리만 있어도 같은 단지로 본다.
  assert.equal(kind('마석우리', '더샵퍼스트시티 오남'), 'same');
  // 동 주소는 같은 동이나 빈 지역이면 포함 관계를 쓴다.
  const dong = (umd) => estimate(rows(5, 1500, { aptName: '광교자연앤센트레빌 1단지', umd, jibun: '9' }), { subjectExtra: { name: '광교 자연앤 센트레빌', umd: '역삼동' } }).basis.kind;
  assert.equal(dong('역삼동'), 'same');
  assert.equal(dong(''), 'same');
});

test('brand spellings are only replaced at a word start, not inside other words', () => {
  assert.equal(normalizeComplexName('BUS클래스'), 'bus클래스');
  assert.equal(normalizeComplexName('SKIPARK'), 'skipark');
  assert.equal(normalizeComplexName('TASK뷰'), 'task뷰');
  assert.equal(normalizeComplexName('NICE편한세상'), 'nice편한세상');
  assert.equal(normalizeComplexName('광교 S클래스'), '광교에스클래스');
  assert.equal(normalizeComplexName('SK뷰 수원'), '에스케이뷰수원');
  assert.equal(normalizeComplexName('광교I-PARK'), '광교아이파크');
});

test('romanised and Korean brand spellings of one complex are grouped together', () => {
  const pairs = [['광교중흥S클래스', '광교중흥에스클래스'], ['시흥e편한세상', '시흥이편한세상'], ['수원SK뷰', '수원에스케이뷰'], ['광교 I-PARK', '광교아이파크'], ['동탄 HILLSTATE', '동탄힐스테이트'], ['송도 The Sharp', '송도더샵']];
  for (const [roman, korean] of pairs) {
    const complexes = groupComplexes([...rows(3, 1500, { aptName: roman, jibun: '7' }), ...rows(3, 1500, { aptName: korean, jibun: '7' })], 84, context);
    assert.equal(complexes.length, 1, roman);
    assert.equal(complexes[0].samples, 6, roman);
  }
  assert.equal(brandTier({ name: '광교중흥S클래스' }, adjustment.brand), brandTier({ name: '광교중흥에스클래스' }, adjustment.brand));
});

test('comparables close in age are preferred, widening in steps and lowering confidence', () => {
  const pick = (allRows, extra = {}) => selectComparables(groupComplexes(allRows, 84, context), subject(extra), context);
  const young = [...rows(5, 1500, { aptName: '신축가', jibun: '1', buildYear: 2016 }), ...rows(5, 1600, { aptName: '신축나', jibun: '2', buildYear: 2012 })];
  const old = [...rows(40, 500, { aptName: '구축가', jibun: '3', buildYear: 1995 }), ...rows(30, 550, { aptName: '구축나', jibun: '4', buildYear: 1992 })];
  const preferred = pick([...young, ...old]);
  assert.equal(preferred.ageStep, 0);
  assert.equal(preferred.maxAge, 15);
  assert.equal(preferred.scope, '법정동');
  assert.deepEqual(preferred.picked.map((item) => item.aptName).sort(), ['신축가', '신축나']);

  // 같은 법정동에 신축이 하나뿐이면 시군구의 신축을 먼저 본다.
  const elsewhere = [...rows(5, 1500, { aptName: '신축가', jibun: '1', buildYear: 2016 }), ...rows(5, 1600, { aptName: '옆동신축', umd: '삼성동', jibun: '9', buildYear: 2018 }), ...old];
  const district = pick(elsewhere);
  assert.equal(district.scope, '시군구');
  assert.equal(district.ageStep, 0);

  const middleAged = [...rows(5, 1000, { aptName: '중년가', jibun: '5', buildYear: 2004 }), ...rows(5, 1000, { aptName: '중년나', jibun: '6', buildYear: 2003 }), ...old];
  assert.equal(pick(middleAged).ageStep, 1);
  assert.equal(pick(middleAged).maxAge, 25);
  const onlyOld = pick(old);
  assert.equal(onlyOld.ageStep, 2);
  assert.equal(onlyOld.maxAge, null);

  const level = (ageStep) => comparableConfidence({ samples: 20, comparables: 4, spread: 0.1, looError: 0.05, stationState: STATION.USED, presaleOk: true, ageStep, lastAgeStep: 2 }, market.confidence);
  assert.equal(level(0), CONFIDENCE.HIGH);
  assert.equal(level(1), CONFIDENCE.MID);
  assert.equal(level(2), CONFIDENCE.LOW);
});

const GWANGGYO = [
  // 같은 법정동의 1990년대 단지. 싸고 거래가 많다. 금액은 84㎡ 기준(만원)
  ['원천주공', 1992, 45000, 40], ['원천삼성', 1995, 52000, 35], ['원천동신', 1997, 60000, 30], ['원천한국', 1994, 55000, 25],
  // 같은 법정동의 광교 신도시 단지
  ['광교호반베르디움', 2012, 132000, 8], ['광교중흥에스클래스', 2019, 180000, 6], ['광교아이파크', 2018, 150000, 5],
  ['힐스테이트광교', 2019, 190000, 4], ['영흥숲푸르지오파크비엔', 2020, 89000, 6],
];
const gwanggyoRows = (list) => list.flatMap(([aptName, buildYear, amount, count], index) => rows(count, amount / 84.6, { aptName, buildYear, umd: '원천동', jibun: String(100 + index), area: 84.6 }));
// 이 커밋의 계산으로 낸 값이다. 추정 시세 15.2억, 보수 시세 12.1억(검증 오차가 상한 20%를 넘어 20% 차감), 안전 마진 2.3억.
// 신도시 단지끼리도 13억~19억으로 퍼져 서로를 맞힌 오차가 커서 신뢰도는 하다.
// 마진율은 분양가 대비 22999 / 93860 = 24.5%다. 보수 시세 대비였을 때는 18.9%였다.
// 할인율 상한 10%(2026-11-08 변경): 보수 시세 151820 × 0.9 = 136638, 안전 마진 3.8억, 마진율 40.7%. 상한 20%일 때는 121456, 2.3억, 24.5%였다.
const GWANGGYO_EXPECTED = { estimate: 151820, safeValue: 136638, margin: 38181, marginRate: 38181 / 93860, confidence: CONFIDENCE.LOW };
const gwanggyoModel = { houseType: '084.6192C', area: 84.6192, price: 93860 };
const gwanggyo = (list) => estimateBestMargin({
  models: [gwanggyoModel],
  rows: gwanggyoRows(list),
  subject: buildSubject({ name: '광교 자연앤 센트레빌(A17BL) 공공분양주택', builder: '', umd: '원천동', jibun: null, market }),
  lotto,
  market,
  today,
});

test('regression: a new-town subject is valued from new-town complexes, not the old cheap ones in the same 법정동', () => {
  const result = gwanggyo(GWANGGYO);
  assert.equal(result.basis.maxAge, 15);
  assert.equal(result.basis.scope, '법정동');
  const names = result.basis.comparables.map((item) => item.name);
  assert.ok(!names.some((name) => name.startsWith('원천')), names.join(','));
  // 영흥숲푸르지오파크비엔은 보정 뒤에도 중위값의 0.7배 아래라 이상치로 빠진다.
  assert.equal(result.outliers, 1);
  assert.ok(!names.includes('영흥숲푸르지오파크비엔'));
  // 추정 시세는 신도시 단지 범위(13억~19억) 안이고 안전 마진은 양수다.
  assert.ok(result.estimate >= 130000 && result.estimate <= 190000, String(result.estimate));
  assert.ok(result.margin > 0, String(result.margin));
  assert.equal(result.estimate, GWANGGYO_EXPECTED.estimate);
  assert.equal(result.safeValue, GWANGGYO_EXPECTED.safeValue);
  assert.equal(result.margin, GWANGGYO_EXPECTED.margin);
  assert.ok(Math.abs(result.marginRate - GWANGGYO_EXPECTED.marginRate) < 1e-12);
  assert.equal(result.confidence, GWANGGYO_EXPECTED.confidence);
  // 근거의 금액은 공고 주택형 면적(84.6192㎡) 기준 보정 금액이다.
  assert.equal(result.basis.area, 84.6192);
  assert.deepEqual(result.basis.comparables.map((item) => [item.name, item.reference]), [
    ['광교호반베르디움', 141968], ['광교중흥에스클래스', 186571], ['광교아이파크', 151820], ['힐스테이트광교', 191309],
  ]);
});

test('regression: with only old complexes the estimate falls back to them at no more than 중', () => {
  // 구축 4곳이 서로 잘 맞아 중이다. 신축 공고 단지를 구축으로 재면 시세가 낮게 잡혀 마진은 작게 나오는 쪽이다.
  const result = gwanggyo(GWANGGYO.filter(([name]) => name.startsWith('원천')));
  assert.equal(result.basis.maxAge, null);
  assert.equal(result.confidence, CONFIDENCE.MID);
  assert.ok(result.margin < 0);
  // 3곳뿐이면 하다.
  const three = gwanggyo(GWANGGYO.filter(([name]) => name.startsWith('원천')).slice(0, 3));
  assert.equal(three.basis.maxAge, null);
  assert.equal(three.confidence, CONFIDENCE.LOW);
});

test('the 연식 무관 step caps at 중 only with enough agreeing complexes', () => {
  const base = { samples: 20, comparables: 4, spread: 0.1, looError: 0.05, stationState: STATION.USED, presaleOk: true, ageStep: 2, lastAgeStep: 2, lastStepMinComplexes: 4 };
  const level = (extra) => comparableConfidence({ ...base, ...extra }, market.confidence);
  assert.equal(level({}), CONFIDENCE.MID);
  assert.equal(level({ comparables: 3 }), CONFIDENCE.LOW);
  assert.equal(level({ looError: null }), CONFIDENCE.LOW);
  assert.equal(level({ spread: 0.31 }), CONFIDENCE.LOW);
  assert.equal(level({ looError: 0.21 }), CONFIDENCE.LOW);
  // 다른 감점은 그대로 적용된다.
  assert.equal(level({ presaleOk: false }), CONFIDENCE.LOW);
  assert.equal(level({ scopePenalty: true }), CONFIDENCE.LOW);
});

test('apartment matching is conservative', () => {
  const entry = (name, dong = '역삼동', ri = '', code = name) => ({ code, name, dong, ri });
  const match = (aptName, directory, umd = '역삼동') => matchApartment({ aptName, umd }, directory, market)?.code ?? null;
  // 같은 법정동: 정규화한 이름이 같거나 고유한 이름을 포함한다.
  assert.equal(match('역삼 푸른숲 아파트', [entry('역삼푸른숲')]), '역삼푸른숲');
  assert.equal(match('광교자연앤센트레빌 1단지', [entry('광교자연앤센트레빌')]), '광교자연앤센트레빌');
  assert.equal(match('상리푸른숲', [entry('상리푸른숲', '봉담읍', '상리')], '상리'), '상리푸른숲');
  assert.equal(match('상리푸른숲2차', [entry('상리푸른숲', '봉담읍', '상리')], '봉담읍 상리'), '상리푸른숲');
  // 다른 법정동: 이름이 정확히 같을 때만 받는다.
  assert.equal(match('역삼푸른숲', [entry('역삼푸른숲', '도곡동')]), '역삼푸른숲');
  assert.equal(match('역삼푸른숲2차', [entry('역삼푸른숲', '도곡동')]), null);
  // 정확히 같은 이름이 포함 관계보다 먼저다.
  assert.equal(match('역삼푸른숲', [entry('역삼푸른숲 2차'), entry('역삼푸른숲')]), '역삼푸른숲');
  // 후보가 여럿이면 고르지 않는다.
  assert.equal(match('역삼푸른숲', [entry('역삼푸른숲', '역삼동', '', 'A'), entry('역삼푸른숲', '역삼동', '', 'B')]), null);
  assert.equal(match('역삼푸른숲', [entry('역삼푸른숲', '도곡동', '', 'A'), entry('역삼푸른숲', '개포동', '', 'B')]), null);
  assert.equal(match('광교자연앤', [entry('광교자연앤 1차'), entry('광교자연앤 2차')]), null);
  // 브랜드만 있는 이름은 같아도, 포함해도 받지 않는다.
  assert.equal(match('힐스테이트', [entry('힐스테이트')]), null);
  assert.equal(match('e편한세상', [entry('e편한세상')]), null);
  assert.equal(match('힐스테이트 수원', [entry('힐스테이트')]), null);
  assert.equal(match('힐스테이트', [entry('힐스테이트 수원')]), null);
  assert.equal(match('힐스테이트동탄', [entry('힐스테이트동탄 2차')]), null);
  assert.equal(match('없는단지', [entry('역삼푸른숲')]), null);
  assert.equal(match('', [entry('역삼푸른숲')]), null);
  assert.equal(match('역삼푸른숲', []), null);
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

test('margin takes the estimate less the leave-one-out error and subtracts price, option and acquisition tax', () => {
  const allRows = [
    ...rows(3, 1000, { aptName: '가단지', jibun: '1a', area: 100 }),
    ...rows(3, 1100, { aptName: '나단지', jibun: '2a', area: 100 }),
    ...rows(3, 1200, { aptName: '다단지', jibun: '3a', area: 100 }),
    ...rows(3, 1300, { aptName: '라단지', jibun: '4a', area: 100 }),
  ];
  const result = estimate(allRows, { models: [{ houseType: '100A', area: 100, price: 80000 }] });
  // 단지 4곳의 중위값(누적 가중치가 절반에 처음 닿는 값)은 1100이다.
  assert.equal(result.estimate, 110000);
  // 서로 맞힌 오차: 1000→1200 0.2, 1100→1200 0.0909, 1200→1100 0.0833, 1300→1100 0.1538. 중위값 0.1224
  const expectedDiscount = ((100 / 1100) + (200 / 1300)) / 2;
  // 측정한 오차 12.2%가 상한 10%를 넘어 10%만 뺀다.
  assert.ok(expectedDiscount > 0.1);
  assert.equal(result.discount, 0.1);
  assert.equal(result.discountExceeded, true);
  assert.equal(result.safeValue, 99000);
  // 8억의 세율은 1% + 2% × (2/3) = 2.3333%, 교육세 포함 × 1.1. 80000 × 0.0256667 = 2053
  assert.equal(result.tax, 2053);
  assert.equal(result.optionCost, 1500);
  assert.equal(result.margin, 99000 - 80000 - 1500 - 2053);
  // 마진율은 분양가 대비다.
  assert.ok(Math.abs(result.marginRate - 15447 / 80000) < 1e-9);
});

test('the margin rate is the margin over the price, and missing or zero prices give no rate', () => {
  assert.equal(marginRateOf(-27194, 63700), -27194 / 63700);
  for (const price of [0, -1, null, undefined, Number.NaN]) assert.equal(marginRateOf(1000, price), null, String(price));
  assert.equal(marginRateOf(Number.NaN, 63700), null);
  // 비율이 없으면 3억 원 기준만 본다.
  assert.equal(meetsPriceRule({ margin: 30000, marginRate: null }, lotto), true);
  assert.equal(meetsPriceRule({ margin: 29999, marginRate: null }, lotto), false);
  for (const marginRate of [undefined, Number.NaN]) assert.equal(meetsPriceRule({ margin: 1, marginRate }, lotto), false, String(marginRate));
  assert.equal(meetsPriceRule({ margin: 1, marginRate: 0.2 }, lotto), true);
  assert.equal(meetsPriceRule({ margin: 1, marginRate: 0.1999 }, lotto), false);
});

test('the safety discount is only the measured error, capped at 10%, and nothing when it cannot be measured', () => {
  const safe = market.safeValue;
  assert.equal(safe.maxDiscount, 0.1);
  const discount = (input) => safeDiscount({ spread: 0, comparables: 4, ...input }, safe);
  assert.deepEqual(discount({ looError: null }), { discount: 0, measured: false, exceeded: false });
  // 단지 3곳은 오차를 믿기에 적어 할인하지 않는다.
  assert.equal(discount({ looError: 0.05, comparables: 3 }).discount, 0);
  assert.equal(discount({ looError: 0.05, comparables: 3 }).measured, false);
  // 하한은 없다.
  assert.equal(discount({ looError: 0 }).discount, 0);
  assert.equal(discount({ looError: 0.07 }).discount, 0.07);
  // 오차 중위값보다 퍼짐의 절반이 크면 그 값을 쓴다.
  assert.equal(discount({ looError: 0.02, spread: 0.16 }).discount, 0.08);
  const over = discount({ looError: 0.35 });
  assert.equal(over.discount, 0.1);
  assert.equal(over.exceeded, true);
  assert.equal(discount({ looError: 0.1 }).exceeded, false);
});

test('two or three agreeing complexes get no discount, and confidence follows the usual 중 rules', () => {
  const allRows = ['가', '나', '다'].flatMap((name, index) => rows(5, 1500, { aptName: `${name}단지`, jibun: `${index}a` }));
  const result = estimate(allRows, { models: [{ houseType: '084A', area: 84, price: 80000 }] });
  assert.equal(result.discount, 0);
  assert.equal(result.discountMeasured, false);
  assert.equal(result.safeValue, result.estimate);
  // 오차를 재지 못한 것만으로 하가 되지 않는다. 2~3곳이 서로 같으면 중이다.
  assert.equal(result.confidence, CONFIDENCE.MID);
  const pair = estimate(allRows.filter((row) => row.aptName !== '다단지'), { models: [{ houseType: '084A', area: 84, price: 80000 }] });
  assert.equal(pair.discountMeasured, false);
  assert.equal(pair.confidence, CONFIDENCE.MID);
  // 퍼짐이 중 기준(30%)을 넘으면 그대로 하다.
  const apart = ['가', '나'].flatMap((name, index) => rows(5, index === 0 ? 1000 : 1600, { aptName: `${name}단지`, jibun: `${index}a` }));
  const wide = estimate(apart, { models: [{ houseType: '084A', area: 84, price: 80000 }] });
  assert.equal(wide.discountMeasured, false);
  assert.equal(wide.confidence, CONFIDENCE.LOW);
  // 측정한 오차가 상한을 넘으면 여전히 하다.
  assert.equal(comparableConfidence({ samples: 40, comparables: 6, spread: 0.1, looError: 0.05, stationState: STATION.USED, presaleOk: true, discountExceeded: true }, config.market.confidence), CONFIDENCE.LOW);
  assert.equal(comparableConfidence({ samples: 40, comparables: 6, spread: 0.1, looError: 0.05, stationState: STATION.USED, presaleOk: true }, config.market.confidence), CONFIDENCE.HIGH);
});

test('two cheap complexes among eight do not drag the safety value down', () => {
  const names = ['가', '나', '다', '라', '마', '바', '사', '아'];
  const units = [1500, 1500, 1500, 1500, 1500, 1500, 1100, 1100];
  const allRows = names.flatMap((name, index) => rows(3, units[index], { aptName: `${name}단지`, jibun: `${index}a` }));
  const result = estimate(allRows, { models: [{ houseType: '084A', area: 84, price: 80000 }] });
  // 1100은 중위값 1500의 0.73배라 이상치가 아니다. 예전 하위 25%(8곳 중 2번째)라면 1100 × 84 = 92400이었다.
  assert.equal(result.outliers, 0);
  assert.equal(result.estimate, 1500 * 84);
  // 6곳은 서로를 정확히 맞혀 오차 중위값이 0이지만, 퍼짐 (1500 - 1100) / 1500의 절반 13.3%는 상한 10%를 넘는다.
  assert.equal(result.discount, 0.1);
  assert.equal(result.discountExceeded, true);
  assert.equal(result.safeValue, Math.round(1500 * 0.9 * 84));
  assert.ok(result.safeValue > 92400);
  // 퍼짐 26.7%는 중 기준(30%) 안이지만 할인 상한을 넘어 하다.
  assert.equal(result.confidence, CONFIDENCE.LOW);
});

test('confidence and discount are measured on all complexes, with no floor after a removal', () => {
  const units = [1000, 1500, 1550, 1600, 1650, 1700, 1750, 1800];
  const allRows = units.flatMap((unit, index) => rows(3, unit, { aptName: `${'가나다라마바사아'[index]}단지`, jibun: `${index}a` }));
  const result = estimate(allRows, { models: [{ houseType: '084A', area: 84, price: 80000 }] });
  // 중심은 가운데 둘(1600, 1650)의 평균 1625이고, 1000은 그 0.7배인 1137.5 아래라 빠진다.
  assert.equal(result.outliers, 1);
  assert.ok(!result.basis.comparables.some((item) => item.name === '가단지'));
  // 퍼짐(8곳 전체, 1500~1700)의 절반 6.25%가 오차 중위값보다 커서 그대로 쓴다. 이상치를 뺐다고 하한을 두지 않는다.
  // 이상치를 뺐다고 하한(예전 10%)을 두지 않고 측정값을 그대로 쓴다.
  assert.ok(result.discount > 0 && result.discount < 0.1, String(result.discount));
  assert.equal(result.discountExceeded, false);
  assert.equal(result.discountMeasured, true);
  // 표본은 실제로 쓴 7곳만 센다.
  assert.equal(result.basis.samples, 21);
});

test('removed complexes still count against confidence and the discount', () => {
  const units = [900, 950, 1500, 1510, 1520, 1530, 1540, 1550];
  const allRows = units.flatMap((unit, index) => rows(4, unit, { aptName: `${'가나다라마바사아'[index]}단지`, jibun: `${index}a` }));
  const result = estimate(allRows, { models: [{ houseType: '084A', area: 84, price: 80000 }] });
  // 중심 1515의 0.7배 아래인 900, 950이 빠지고 6곳이 남는다. 남은 6곳끼리는 거의 같아 상으로 보일 수 있다.
  assert.equal(result.outliers, 2);
  // 퍼짐은 8곳 전체로 계산한다: (1530 - 950) / 1510 = 0.384. 0.3을 넘어 하고, 절반 19.2%는 상한 10%를 넘는다.
  assert.equal(result.confidence, CONFIDENCE.LOW);
  assert.equal(result.discount, 0.1);
  assert.equal(result.discountExceeded, true);
});

for (const [label, cheap, pricey] of [['four and four', 4, 4], ['three cheap and five pricey', 3, 5]]) {
  test(`a bimodal split (${label}) is not treated as outliers and cannot look confident`, () => {
    const allRows = [
      ...Array.from({ length: cheap }, (_, index) => rows(4, 90000 / 84, { aptName: `싼단지${index}호`, jibun: `c${index}` })).flat(),
      ...Array.from({ length: pricey }, (_, index) => rows(4, 170000 / 84, { aptName: `비싼단지${index}호`, jibun: `p${index}` })).flat(),
    ];
    const result = estimate(allRows, { models: [{ houseType: '084A', area: 84, price: 80000 }] });
    assert.equal(result.outliers, 0);
    assert.equal(result.basis.comparables.length, 8);
    assert.equal(result.confidence, CONFIDENCE.LOW);
    assert.equal(result.discount, market.safeValue.maxDiscount);
  });
}

test('complexes far from the median after adjustment are dropped only when few and enough remain', () => {
  const complex = (adjustedUnit) => ({ adjustedUnit });
  const { comparables } = market;
  const loose = { ...comparables, outlierMinRemaining: 1, outlierMaxShare: 1 };
  const values = (list, rule) => dropComplexOutliers(list.map(complex), rule).map((item) => item.adjustedUnit);
  // 짝수 개면 가운데 둘의 평균(1080과 1500의 평균 1290)이 중심이다. 아래쪽 가운데 값 1080을 중심으로 쓰면 1520, 1540도 빠진다.
  assert.deepEqual(values([700, 1000, 1080, 1500, 1520, 1540], loose), [1000, 1080, 1500, 1520, 1540]);
  // 8곳이면 2곳까지만 뺀다. 3곳이 벗어나면 시세가 갈린 것으로 보고 빼지 않는다.
  assert.deepEqual(values([1000, 1010, 1500, 1520, 1540, 1560, 1580, 1600], comparables), [1500, 1520, 1540, 1560, 1580, 1600]);
  assert.equal(values([1000, 1010, 1020, 1520, 1540, 1560, 1580, 1600], comparables).length, 8);
  // 위쪽도 같다. 중심 1570의 1.4배 2198 위인 두 곳이 빠진다.
  assert.deepEqual(values([1500, 1520, 1540, 1560, 1580, 1600, 2300, 2400], comparables), [1500, 1520, 1540, 1560, 1580, 1600]);
  // 빼고 남는 단지가 4곳보다 적으면 빼지 않는다.
  assert.equal(values([1000, 1500, 1550, 1600], { ...comparables, outlierMaxShare: 1 }).length, 4);
  assert.deepEqual(values([1000, 1500, 1550, 1600], { ...comparables, outlierMaxShare: 1, outlierMinRemaining: 3 }), [1500, 1550, 1600]);
  assert.equal(values([1400, 1500, 1550, 1600], comparables).length, 4);

  const allRows = [
    ...rows(3, 900, { aptName: '싼단지', jibun: '0a' }),
    ...['가', '나', '다', '라'].flatMap((name, index) => rows(3, 1500 + index * 10, { aptName: `${name}단지`, jibun: `${index + 1}a` })),
  ];
  const result = estimate(allRows, { models: [{ houseType: '084A', area: 84, price: 80000 }] });
  assert.equal(result.outliers, 1);
  assert.ok(!result.basis.comparables.some((item) => item.name === '싼단지'));
  assert.equal(result.basis.outliers, 1);
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
  const good = { samples: 20, comparables: 4, spread: 0.15, looError: 0.1, stationState: STATION.USED, presaleOk: true };
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
  // 입력이 없으면 중까지만 오르고, 더 낮은 등급은 그대로다.
  assert.equal(level({ stationState: STATION.NO_INPUT }), CONFIDENCE.MID);
  assert.equal(level({ stationState: STATION.NO_INPUT, samples: 4 }), CONFIDENCE.LOW);
  assert.equal(level({ stationState: STATION.NO_INPUT, samples: 19 }), CONFIDENCE.MID);
  // 입력은 있지만 비교 단지 값이 부족하면 한 단계 내린다.
  assert.equal(level({ stationState: STATION.NO_DATA }), CONFIDENCE.MID);
  assert.equal(level({ stationState: STATION.NO_DATA, samples: 19 }), CONFIDENCE.LOW);
  assert.equal(level({ stationState: STATION.NO_DATA, presaleOk: false }), CONFIDENCE.LOW);
  // 분양권 조회가 실패하면 한 단계 내린다.
  assert.equal(level({ presaleOk: false }), CONFIDENCE.MID);
  assert.equal(level({ samples: 19, presaleOk: false }), CONFIDENCE.LOW);
});

test('leave-one-out error is computed by hand and uses the adjustments', () => {
  const options = { useStation: true, subjectStation: 1.02, subjectAge: 0 };
  const complex = (unit, extra = {}) => ({ unit, brandTier: 'other', ageYears: 0, walkMinutes: 12, ...extra });
  assert.equal(leaveOneOutError([complex(1000), complex(1000)], adjustment, options), null);
  // 오차: (1000→1150) 0.15, (1000→1150) 0.15, (1300→1000) 0.2308. 중위값은 0.15다.
  const plain = leaveOneOutError([complex(1000), complex(1000), complex(1300)], adjustment, options);
  assert.ok(Math.abs(plain - 0.15) < 1e-9);
  // 브랜드 차이가 가격 차이를 설명하면 오차가 사라진다.
  const explained = leaveOneOutError([complex(1000), complex(1000), complex(1050, { brandTier: 'top' })], adjustment, options);
  assert.ok(explained < 1e-9);
  const unexplained = leaveOneOutError([complex(1000), complex(1000), complex(1050)], adjustment, options);
  assert.ok(unexplained > 0.01);
  // 역 차이가 가격 차이를 설명해도 사라진다.
  const near = leaveOneOutError([complex(1000), complex(1000), complex(1000 * (1.06 / 1.02), { walkMinutes: 3 })], adjustment, options);
  assert.ok(near < 1e-9);
});

test('confidence flows through the estimate: presale failure lowers it, and same-complex stays above comparables', () => {
  const allRows = ['가', '나', '다', '라'].flatMap((name, index) => rows(5, 1000, { aptName: `${name}단지`, jibun: `${index}a` }));
  const stations = walks(allRows, 84, { 가단지: 12, 나단지: 12, 다단지: 12, 라단지: 12 });
  const subjectExtra = { walkMinutes: 12 };
  assert.equal(estimate(allRows, { stations, subjectExtra }).confidence, CONFIDENCE.HIGH);
  assert.equal(estimate(allRows, { stations, subjectExtra, presaleOk: false }).confidence, CONFIDENCE.MID);
  assert.equal(estimate(allRows, { subjectExtra }).confidence, CONFIDENCE.MID);
  assert.equal(estimate(allRows, { subjectExtra, presaleOk: false }).confidence, CONFIDENCE.LOW);

  const same = rows(5, 1500, { aptName: '공고단지', jibun: '9' });
  assert.equal(estimate(same).confidence, CONFIDENCE.HIGH);
  assert.equal(estimate(same, { presaleOk: false }).confidence, CONFIDENCE.MID);
});

test('a presale failure keeps a same-complex estimate at 중 when sale trades alone meet the rule', () => {
  // 매매 3건이면 기준(3건)을 채워 중이다. 예전에는 한 단계 내려 하였다.
  const saleOnly = rows(3, 1500, { aptName: '공고단지', jibun: '9' });
  assert.equal(estimate(saleOnly).confidence, CONFIDENCE.MID);
  assert.equal(estimate(saleOnly, { presaleOk: false }).confidence, CONFIDENCE.MID);
  // 매매가 기준에 못 미치면 한 단계 내린다.
  const mixed = [...rows(1, 1500, { aptName: '공고단지', jibun: '9' }), ...rows(2, 1500, { aptName: '공고단지', jibun: '9', presale: true, buildYear: null })];
  assert.equal(estimate(mixed, { presaleOk: false }).confidence, CONFIDENCE.LOW);
});

test('a 하 house type with a bigger margin does not hide a 중 house type that qualifies', () => {
  // 84㎡은 단지 1곳뿐이라 하, 59㎡은 같은 값의 단지 4곳이라 중이다.
  const large = rows(5, 3000, { aptName: '대형가', jibun: 'L1' });
  const small = ['S1', 'S2', 'S3', 'S4'].flatMap((jibun) => rows(5, 1000, { aptName: `소형${jibun}`, jibun, area: 59 }));
  const result = estimate([...large, ...small], {
    models: [{ houseType: '084A', area: 84, price: 100000 }, { houseType: '059A', area: 59, price: 30000 }],
  });
  assert.equal(result.houseType, '059A');
  assert.equal(result.confidence, CONFIDENCE.MID);
  // 84㎡ 단독이면 마진은 더 크지만 하다.
  const largeOnly = estimate(large, { models: [{ houseType: '084A', area: 84, price: 100000 }] });
  assert.equal(largeOnly.confidence, CONFIDENCE.LOW);
  assert.ok(largeOnly.margin > result.margin);
});

test('lookup candidates are the comparables each model will use, and same-complex models need none', () => {
  const others = Array.from({ length: 30 }, (_, index) => rows(2, 1000, { aptName: `단지${index}`, umd: '삼성동', jibun: String(100 + index) })).flat();
  const big = rows(3, 1000, { aptName: '많은단지', umd: '삼성동', jibun: '900' });
  const oneModel = lookupCandidates({ models: [model], rows: [...others, ...big], subject: subject(), lotto, market, today });
  assert.equal(oneModel.length, market.comparables.maxComparables);
  assert.equal(oneModel[0].aptName, '많은단지');

  const small = Array.from({ length: 30 }, (_, index) => rows(2, 1000, { aptName: `소형${index}`, umd: '삼성동', jibun: String(300 + index), area: 59 })).flat();
  const twoModels = lookupCandidates({ models: [model, { houseType: '059A', area: 59, price: 50000 }], rows: [...others, ...small], subject: subject(), lotto, market, today });
  assert.equal(twoModels.length, market.comparables.maxComparables * 2);

  const sameRows = [...others, ...rows(5, 1500, { aptName: '공고단지', jibun: '9' })];
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
