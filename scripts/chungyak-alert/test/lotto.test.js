import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AppError } from '../src/util.js';
import { STATUS, badMarginConfig, badTriggerConfig, evaluateLotto, keepPreviousLotto, parseRemainderRound } from '../src/lotto.js';
import { acquisitionTax, estimateBestMargin } from '../src/market-estimate.js';
import { createMolitClient } from '../src/sources/molit.js';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const today = '2026-11-05';

const apt = (extra = {}) => ({
  key: '1-1',
  kind: 'apt',
  houseSecd: '01',
  region: '서울',
  address: '서울특별시 강남구 역삼동 1',
  flags: { priceCap: false, publicDistrict: false },
  stages: [],
  ...extra,
});

// 만원/㎡ 단가가 unit인 거래
const trades = (count, unit, extra = {}) => Array.from({ length: count }, () => ({
  amount: unit * 84,
  area: 84,
  umd: '역삼동',
  // 올해 입주 단지라 연식 보정이 없다.
  buildYear: 2026,
  ...extra,
}));

// 같은 단가의 단지 두 곳. 단지가 4곳 미만이라 오차를 재지 못해 할인하지 않지만, 단지 2곳, 표본 10건, 퍼짐 0이라 신뢰도는 중이다.
const two = (count, unit, extra = {}) => [...trades(count, unit, { ...extra, jibun: 'a1' }), ...trades(count, unit, { ...extra, jibun: 'a2' })];
// 분양가 10억 기준 단지 1곳(신뢰도 하)의 마진율: trades(5, 1100)은 -12.4%, trades(5, 1200)은 -4%다. 마진이 0 이하라 어떤 공고든 아님이다.

const evaluate = (notice, { models = [{ houseType: '084A', area: 84, price: 100000 }], data = [], overrides = {} } = {}) => evaluateLotto(notice, {
  config: { ...config, lotto: { ...config.lotto, ...overrides } },
  today,
  getModels: async () => models,
  getTrades: async () => data,
});

test('price rule: a margin of 1억 or more with a rate of 10% or more is 로또', async () => {
  const result = await evaluate(apt(), { data: two(5, 2200) });
  assert.equal(result.status, STATUS.LOTTO);
  assert.equal(result.confidence, '중');
  assert.equal(result.estimate, 184800);
  // 보수 시세 184800(할인 0%). 184800 - 100000 - 옵션 1500 - 취득세 3300 (10억의 3.3%)
  assert.equal(result.margin, 80000);
  assert.ok(result.reason.includes('법정동'));
  assert.ok(result.reason.includes('안전 마진 8.0억'));
});

test('price rule: a small price with a high margin rate and a margin over 1억 is 로또', async () => {
  const result = await evaluate(apt(), {
    models: [{ houseType: '084A', area: 84, price: 30000 }],
    data: two(5, 600),
  });
  // 50400 - 30000 - 1500 - 330 = 18570, 분양가 대비 62%
  assert.equal(result.margin, 18570);
  assert.equal(result.status, STATUS.LOTTO);
  assert.equal(result.confidence, '중');
});

test('price rule: a positive margin under the thresholds is 확인 필요, and a margin of 0 or less is 아님', async () => {
  const thin = await evaluate(apt(), { data: trades(5, 1250) });
  // 단지 1곳이라 할인하지 않는다. 105000 - 100000 - 1500 - 3300
  assert.equal(thin.margin, 200);
  assert.equal(thin.status, STATUS.CHECK);
  const loss = await evaluate(apt(), { data: trades(5, 1200) });
  assert.equal(loss.margin, -4000);
  assert.equal(loss.status, STATUS.NOT);
});

test('too few samples is 판별 불가', async () => {
  const result = await evaluate(apt(), { data: trades(4, 3000) });
  assert.equal(result.status, STATUS.UNDETERMINED);
  assert.equal(result.reason, '실거래 표본 부족');
});

test('unmapped district is 판별 불가 and regions outside the alert list are 대상 외', async () => {
  const unmapped = await evaluate(apt({ address: '서울특별시 서구 어딘가' }), { data: trades(5, 3000) });
  assert.equal(unmapped.status, STATUS.UNDETERMINED);
  assert.equal(unmapped.reason, '시군구 코드 미매핑');

  let called = false;
  const outside = await evaluateLotto(apt({ region: '부산' }), {
    config,
    today,
    getModels: async () => { called = true; return []; },
    getTrades: async () => [],
  });
  assert.equal(outside.status, STATUS.OUT_OF_SCOPE);
  assert.equal(called, false);
});

test('a flag trigger without a price check makes 로또 even when price says no, and records the price', async () => {
  // 불법행위 재공급(06)은 가격 확인을 끈 조건이다(lotto.triggerPriceCheck.resupply).
  const resupply = apt({ kind: 'remainder', houseSecd: '06' });
  const low = await evaluate(resupply, { data: trades(5, 1200) });
  assert.equal(low.status, STATUS.LOTTO);
  assert.equal(low.estimate, 100800);
  assert.ok(low.reason.includes('재공급'));
  // 100800 - 100000 - 1500 - 3300 = -4000(마진율 -4%). 시세를 보지 않아 마진이 음수여도 로또이고 근거에 함께 적는다.
  assert.equal(low.margin, -4000);
  assert.ok(low.reason.includes('안전 마진 -0.4억'));

  // 시세를 보는 무순위는 같은 추정이 아님이다.
  const checked = await evaluate(apt({ kind: 'remainder', houseSecd: '04' }), { data: trades(5, 1200) });
  assert.equal(checked.status, STATUS.NOT);

  const noData = await evaluate(apt({ kind: 'remainder', houseSecd: '06' }), { data: [] });
  assert.equal(noData.status, STATUS.LOTTO);
  assert.equal(noData.estimate, null);
  assert.equal(noData.topPrice, 100000);
});

test('a data failure keeps an unchecked trigger 로또, and makes a price-checked trigger 확인 필요', async () => {
  const run = async (houseSecd) => {
    const errors = [];
    const result = await evaluateLotto(apt({ kind: 'remainder', houseSecd }), {
      config,
      today,
      getModels: async () => { throw new Error('https://secret.test/?serviceKey=x'); },
      getTrades: async () => [],
      onError: (kind) => errors.push(kind),
    });
    return { result, errors };
  };
  const resupply = await run('06');
  assert.equal(resupply.result.status, STATUS.LOTTO);
  assert.deepEqual(resupply.errors, ['unexpected_error']);
  // 시세를 보는 조건은 추정이 없어 확인 필요다. 조회 실패로 모르는 것이라 keepPreviousLotto가 저장된 로또를 유지한다.
  const remainder = await run('04');
  assert.equal(remainder.result.status, STATUS.CHECK);
  assert.equal(remainder.result.lookupFailed, true);
  assert.deepEqual(remainder.errors, ['unexpected_error']);
});

test('config switches control each trigger', async () => {
  // 추정이 없으면 조건형 후보는 확인 필요, 조건 없는 공고는 판별 불가라 둘이 갈린다.
  const data = [];
  const off = await evaluate(apt({ kind: 'remainder', houseSecd: '04' }), { data, overrides: { includeRemainder: false } });
  assert.equal(off.status, STATUS.OUT_OF_SCOPE);

  const arbitrary = apt({ kind: 'arbitrary', houseSecd: '' });
  assert.equal((await evaluate(arbitrary, { data })).status, STATUS.OUT_OF_SCOPE);
  assert.equal((await evaluate(arbitrary, { data, overrides: { includeArbitrary: true } })).status, STATUS.CHECK);

  const allOff = { includePriceCap: false, includePublicDistrict: false };
  const capped = apt({ flags: { priceCap: true, publicDistrict: false } });
  const district = apt({ flags: { priceCap: false, publicDistrict: true } });
  assert.equal((await evaluate(capped, { data, overrides: allOff })).status, STATUS.UNDETERMINED);
  assert.equal((await evaluate(district, { data, overrides: allOff })).status, STATUS.UNDETERMINED);
  assert.equal((await evaluate(capped, { data, overrides: { includePublicDistrict: false } })).status, STATUS.CHECK);
  assert.equal((await evaluate(capped, { data, overrides: { includePriceCap: false } })).status, STATUS.UNDETERMINED);
  assert.equal((await evaluate(district, { data, overrides: { includePriceCap: false } })).status, STATUS.CHECK);
});

test('price cap and public district are judged as triggers by default', async () => {
  assert.equal(config.lotto.includePriceCap, true);
  assert.equal(config.lotto.includePublicDistrict, true);
  const firm = two(5, 2200);
  const capped = await evaluate(apt({ flags: { priceCap: true, publicDistrict: false } }), { data: firm });
  assert.equal(capped.status, STATUS.LOTTO);
  assert.equal(capped.estimate, 184800);
  assert.ok(capped.reason.startsWith('분양가상한제 적용; '));
  // 시세 추정이 없으면 로또가 아니라 확인 필요다.
  const district = await evaluate(apt({ flags: { priceCap: false, publicDistrict: true } }), { data: [] });
  assert.equal(district.status, STATUS.CHECK);
  const plain = await evaluate(apt(), { data: trades(5, 1200) });
  assert.equal(plain.status, STATUS.NOT);
});

test('any qualifying model makes 로또 and the largest qualifying margin is recorded', async () => {
  const large = two(5, 1000, { area: 120, amount: 120000 });
  const small = two(5, 1000, { area: 59, amount: 59000 });
  const small2 = { houseType: '059B', area: 59, price: 35000 };
  const result = await evaluate(apt(), {
    models: [
      { houseType: '120A', area: 120, price: 100000 },
      { houseType: '059A', area: 59, price: 30000 },
      small2,
    ],
    data: [...large, ...small],
  });
  assert.equal(result.status, STATUS.LOTTO);
  assert.equal(result.confidence, '중');
  assert.equal(result.topPrice, 30000);
  assert.equal(result.estimate, 59000);
  // 59000 - 30000 - 1500 - 330
  assert.equal(result.margin, 27170);
  assert.ok(result.reason.includes('059A'));
});

test('with no qualifying model the largest margin is recorded and the status is 확인 필요', async () => {
  const result = await evaluate(apt(), {
    models: [
      { houseType: '120A', area: 120, price: 110000 },
      { houseType: '059A', area: 59, price: 55000 },
    ],
    data: [...trades(5, 1000, { area: 120, amount: 120000 }), ...trades(5, 1000, { area: 59, amount: 59000 })],
  });
  // 마진은 둘 다 양수이지만 1억에 못 미쳐 확인 필요다.
  assert.equal(result.status, STATUS.CHECK);
  // 120A: 120000 - 110000 - 1500 - 3630 = 4870, 059A: 59000 - 55000 - 1500 - 605 = 1895
  assert.equal(result.margin, 4870);
  assert.equal(result.estimate, 120000);
});

test('models are not fetched for types that do not use the price rule', async () => {
  let calls = 0;
  const run = (notice, overrides = {}) => evaluateLotto(notice, {
    config: { ...config, lotto: { ...config.lotto, ...overrides } },
    today,
    getModels: async () => { calls += 1; return []; },
    getTrades: async () => [],
  });
  for (const kind of ['urbty', 'pblrent', 'arbitrary']) {
    assert.equal((await run(apt({ kind, houseSecd: '' }))).status, STATUS.OUT_OF_SCOPE);
  }
  await run(apt({ kind: 'remainder', houseSecd: '04' }), { includeRemainder: false });
  assert.equal(calls, 0);
  await run(apt({ kind: 'remainder', houseSecd: '04' }));
  await run(apt());
  assert.equal(calls, 2);
});

test('non-APT types are 대상 외 and LH makes no calls', async () => {
  assert.equal((await evaluate(apt({ kind: 'urbty' }))).status, STATUS.OUT_OF_SCOPE);
  let called = false;
  const lh = await evaluateLotto(apt({ kind: 'lh' }), {
    config,
    today,
    getModels: async () => { called = true; return []; },
    getTrades: async () => [],
  });
  assert.equal(lh.status, STATUS.OUT_OF_SCOPE);
  assert.equal(called, false);
});

const market = config.market;
const subject = { umd: '역삼동', brandTier: 'other', ageYears: 0, walkMinutes: null, name: '' };
const best = (models, rows, extra = {}) => estimateBestMargin({ models, rows, subject, lotto: config.lotto, market, today, ...extra });

test('the comparable scope prefers 법정동 and falls back to 시군구', () => {
  const models = [{ houseType: '084A', area: 84, price: 100000 }];
  // 연식이 비슷한 단지를 고를 때는 단지가 2곳 이상이어야 한다.
  const dong = [...trades(5, 1000, { jibun: '1' }), ...trades(5, 1000, { jibun: '2' })];
  const other = trades(5, 2000, { umd: '삼성동' });

  const first = best(models, [...dong, ...other]);
  assert.equal(first.basis.scope, '법정동');
  assert.equal(first.estimate, 84000);

  const widened = best(models, [...trades(2, 1000), ...other]);
  assert.equal(widened.basis.scope, '시군구');
  assert.equal(widened.basis.samples, 7);
});

test('area tolerance filters trades and the largest margin model is kept', () => {
  const far = trades(5, 3000, { area: 120, amount: 3000 * 120 });
  assert.equal(best([{ area: 84, price: 1 }], far), null);

  const result = best([
    { houseType: 'small', area: 84, price: 120000 },
    { houseType: 'cheap', area: 84, price: 90000 },
    { houseType: 'invalid', area: null, price: 1 },
  ], trades(5, 1250));
  assert.equal(result.houseType, 'cheap');
  // 105000 - 90000 - 1500 - 2970
  assert.equal(result.margin, 10530);
});

test('cancelled trades are excluded from the estimate', async () => {
  const row = (amount, cancelled) => `<item><dealAmount>${amount}</dealAmount><excluUseAr>84</excluUseAr><umdNm>역삼동</umdNm><buildYear>2026</buildYear><cdealType>${cancelled}</cdealType></item>`;
  const items = [
    ...Array.from({ length: 5 }, () => row('84,000', '')),
    ...Array.from({ length: 6 }, () => row('999,000', 'O')),
  ];
  const client = createMolitClient({
    key: 'k',
    sleep: async () => {},
    fetch: async () => new Response(`<r><resultCode>000</resultCode><items>${items.join('')}</items><totalCount>${items.length}</totalCount></r>`),
  });
  const result = await evaluateLotto(apt(), {
    config,
    today,
    getModels: async () => [{ houseType: '084A', area: 84, price: 80000 }],
    getTrades: (code) => client.getTrades(code, ['202610']),
  });
  assert.equal(result.estimate, 84000);
  // 84000 - 80000 - 1500 - 2053 = 447. 양수이지만 1억에 못 미쳐 확인 필요다.
  assert.equal(result.margin, 447);
  assert.equal(result.status, STATUS.CHECK);
});

test('current month is never requested from MOLIT', async () => {
  const requested = [];
  await evaluateLotto(apt(), {
    config,
    today,
    getModels: async () => [{ houseType: '084A', area: 84, price: 80000 }],
    getTrades: async (code, months) => { requested.push(...months); return []; },
  });
  assert.equal(requested.length, config.lotto.tradeMonths);
  assert.ok(!requested.includes('202611'));
  assert.equal(requested[0], '202610');
});

test('MOLIT failure gives 판별 불가, and a previous 로또 is kept', async () => {
  const errors = [];
  const evaluation = await evaluateLotto(apt(), {
    config,
    today,
    getModels: async () => [{ houseType: '084A', area: 84, price: 80000 }],
    getTrades: async () => { throw new Error('x'); },
    onError: (kind) => errors.push(kind),
  });
  assert.equal(evaluation.status, STATUS.UNDETERMINED);
  assert.equal(errors.length, 1);
  assert.equal(keepPreviousLotto(evaluation, STATUS.LOTTO).status, STATUS.LOTTO);
  assert.equal(keepPreviousLotto(evaluation, STATUS.NOT).status, STATUS.UNDETERMINED);
  assert.equal(keepPreviousLotto({ status: STATUS.NOT }, STATUS.LOTTO).status, STATUS.NOT);
});

// 조건형 로또 후보의 가격 확인. 공고명과 거래는 모두 합성 값이다.
const remainder = (name = '합성단지 무순위') => apt({ kind: 'remainder', houseSecd: '04', name });
const capped = () => apt({ flags: { priceCap: true, publicDistrict: false } });
const resupplyNotice = (name = '합성단지 재공급') => apt({ kind: 'remainder', houseSecd: '06', name });

// 분양가 price(만원)에서 안전 마진이 margin(만원)이 되는 거래 금액(옵션과 취득세를 더한다). 단지 1곳이면 신뢰도 하, 2곳이면 중이다.
// 신뢰도 상은 공고 단지 자신의 거래 5건(공고 이름 '공고단지', 지번 1)으로 만든다(같은 단지 거래). 공고 이름이 같아야 한다.
const amountFor = (price, margin) => price + config.market.optionCostManwon + acquisitionTax(price, config.market.acquisitionTax) + margin;
const weakFor = (price, margin) => trades(5, 0, { amount: amountFor(price, margin) });
const confidentFor = (price, margin) => two(5, 0, { amount: amountFor(price, margin) });
const firmFor = (price, margin) => trades(5, 0, { aptName: '공고단지', jibun: '1', amount: amountFor(price, margin) });
const modelAt = (price) => [{ houseType: '084A', area: 84, price }];
// 신뢰도 하(단지 1곳) 추정의 마진율을 정해 둔 거래. 분양가 10억이라 마진 = amount - 104800, 마진율 = 마진 / 100000.
const weakAt = (marginManwon) => trades(5, 0, { amount: 104800 + marginManwon });

test('trigger with a confident estimate that meets 1억 and 10% is 로또 with the price text', async () => {
  // 126000 - 100000 - 1500 - 3300 = 21200(마진율 21%)
  for (const notice of [remainder(), capped()]) {
    const result = await evaluate(notice, { data: two(5, 1500) });
    assert.equal(result.confidence, '중');
    assert.equal(result.margin, 21200);
    assert.equal(result.status, STATUS.LOTTO);
    assert.ok(/^(수도권 무순위·잔여세대|분양가상한제 적용); 안전 마진 2\.1억/.test(result.reason), result.reason);
  }
});

test('trigger with a confident negative margin is 아님 with the no-advantage reason', async () => {
  const result = await evaluate(remainder(), { data: two(5, 1100) });
  assert.equal(result.confidence, '중');
  assert.equal(result.margin, -12400);
  assert.equal(result.status, STATUS.NOT);
  assert.ok(result.reason.startsWith('수도권 무순위·잔여세대 해당이나 시세 대비 이점 없음; 안전 마진 -1.2억'), result.reason);
  assert.ok(result.shortReason.startsWith('수도권 무순위·잔여세대 해당이나 시세 이점 없음; 안전 마진 -1.2억'), result.shortReason);
  assert.ok(!result.shortReason.includes('비교 단지'));

  const district = await evaluate(apt({ flags: { priceCap: false, publicDistrict: true } }), { data: two(5, 1100) });
  assert.equal(district.status, STATUS.NOT);
  assert.ok(district.reason.startsWith('공공주택지구 해당이나 시세 대비 이점 없음; '));
});

test('a trigger with a mildly negative 하 estimate is 아님, and with no estimate it is 확인 필요', async () => {
  // 예전에는 마진율 -5%~0의 신뢰도 하 추정과 추정 없는 조건형 공고를 놓치지 않으려고 로또로 두었다. 이제 그 완충은 없다.
  const weak = await evaluate(remainder(), { data: trades(5, 1200) });
  assert.equal(weak.confidence, '하');
  assert.equal(weak.marginRate, -0.04);
  assert.equal(weak.status, STATUS.NOT);
  assert.ok(weak.reason.startsWith('수도권 무순위·잔여세대 해당이나 시세 대비 이점 없음; 안전 마진 -0.4억'), weak.reason);

  const none = await evaluate(capped(), { data: [] });
  assert.equal(none.estimate, null);
  assert.equal(none.status, STATUS.CHECK);
  assert.equal(none.reason, '분양가상한제 적용 해당이나 시세 추정 없음(실거래 표본 부족)');
  assert.equal(none.shortReason, none.reason);
  assert.equal(none.checkNote, none.reason);
  assert.equal(none.topPrice, 100000);
  assert.equal(none.lookupFailed, undefined);
});

test('불법행위 재공급 stays 로또 with a confident negative margin unless its price check is turned on', async () => {
  const resupply = resupplyNotice('합성단지 재공급(14차)');
  assert.equal(config.lotto.triggerPriceCheck.resupply, false);
  const result = await evaluate(resupply, { data: two(5, 1100) });
  assert.equal(result.confidence, '중');
  assert.equal(result.margin, -12400);
  assert.equal(result.status, STATUS.LOTTO);
  assert.ok(result.reason.startsWith('수도권 불법행위 재공급; '));

  const checked = { triggerPriceCheck: { ...config.lotto.triggerPriceCheck, resupply: true } };
  assert.equal((await evaluate(resupply, { data: two(5, 1100), overrides: checked })).status, STATUS.NOT);
  // 반대로 끄면 시세와 무관하게 로또다. 추정이 없어도 마찬가지다.
  const unchecked = { triggerPriceCheck: { ...config.lotto.triggerPriceCheck, remainder: false } };
  assert.equal((await evaluate(remainder(), { data: two(5, 1100), overrides: unchecked })).status, STATUS.LOTTO);
  assert.equal((await evaluate(remainder(), { data: [], overrides: unchecked })).status, STATUS.LOTTO);
});

test('repeated 무순위 rounds only turn a would-be 확인 필요 into 아님, and keep a real 로또', async () => {
  assert.equal(config.lotto.remainderMaxRound, 3);
  const repeated = remainder('합성단지 무순위(사후)(14차)');

  // 하 추정의 양수 마진은 확인 필요가 될 것이 반복 공급이라 아님이다.
  const weak = await evaluate(repeated, { data: weakAt(10000) });
  assert.equal(weak.confidence, '하');
  assert.equal(weak.status, STATUS.NOT);
  assert.equal(weak.repeatedRound, 14);
  assert.ok(weak.reason.startsWith('수도권 무순위·잔여세대 14차 반복 공급; 안전 마진 1.0억'), weak.reason);
  assert.ok(weak.shortReason.startsWith('수도권 무순위·잔여세대 14차 반복 공급; 안전 마진'));

  // 추정이 없으면 확인 필요가 될 것이 반복 공급이라 아님이다(3차 이상의 추정 없음은 아님).
  const none = await evaluate(repeated, { data: [] });
  assert.equal(none.status, STATUS.NOT);
  assert.equal(none.reason, '수도권 무순위·잔여세대 14차 반복 공급; 시세 추정 없음(실거래 표본 부족)');
  assert.equal(none.shortReason, '수도권 무순위·잔여세대 14차 반복 공급; 시세 추정 없음');
  assert.equal(none.checkNote, undefined);

  // 로또 조건을 모두 넘으면 차수와 상관없이 로또다. 마진이 1억 미만이면 확인 필요가 될 것이라 아님이다.
  const rich = await evaluate(repeated, { data: two(5, 2200) });
  assert.equal(rich.confidence, '중');
  assert.equal(rich.margin, 80000);
  assert.equal(rich.status, STATUS.LOTTO);
  assert.equal((await evaluate(repeated, { data: two(5, 1300) })).status, STATUS.NOT);
  assert.equal((await evaluate(repeated, { data: two(5, 1100) })).status, STATUS.NOT);

  // 기준 차수(3차) 미만이거나 차수 규칙을 끄면 같은 추정이 확인 필요다.
  assert.equal((await evaluate(remainder('합성단지 무순위(2차)'), { data: [] })).status, STATUS.CHECK);
  assert.equal((await evaluate(repeated, { data: [], overrides: { remainderMaxRound: null } })).status, STATUS.CHECK);
});

test('an unknown round is not a repeated round: a 하 estimate or no estimate is 확인 필요', async () => {
  for (const name of ['합성단지 무순위', '합성단지 14차', '', undefined]) {
    const weak = await evaluate(remainder(name), { data: weakAt(10000) });
    assert.equal(weak.status, STATUS.CHECK, String(name));
    assert.equal(weak.repeatedRound, undefined);
    assert.equal((await evaluate(remainder(name), { data: [] })).status, STATUS.CHECK, String(name));
  }
});

test('a trailing (N차) is read as the round, and a low one is not a repeated round', async () => {
  // 청약홈 공고문 파일명처럼 키워드 없이 이름 끝 괄호에 차수가 있다.
  const repeated = await evaluate(remainder('합성단지(14차)'), { data: weakAt(10000) });
  assert.equal(repeated.status, STATUS.NOT);
  assert.equal(repeated.repeatedRound, 14);
  assert.ok(repeated.reason.startsWith('수도권 무순위·잔여세대 14차 반복 공급; '));

  // 2차 무순위(실제 사례: 2차 단지가 없는 단일 단지의 "…(2차)")는 기준(3차) 미만이라 확인 필요다.
  assert.equal(parseRemainderRound('합성단지(2차)'), 2);
  for (const data of [weakAt(10000), []]) {
    const phase = await evaluate(remainder('합성단지(2차)'), { data });
    assert.equal(phase.status, STATUS.CHECK);
    assert.equal(phase.repeatedRound, undefined);
  }
});

test('parseRemainderRound reads the round after 무순위, 사후 or 잔여, or in a trailing (N차)', () => {
  assert.equal(parseRemainderRound('합성단지 무순위(사후)(14차)'), 14);
  assert.equal(parseRemainderRound('합성단지 사후무순위 3차'), 3);
  assert.equal(parseRemainderRound('합성단지 무순위 14 차'), 14);
  assert.equal(parseRemainderRound('합성단지 잔여세대(5차)'), 5);
  assert.equal(parseRemainderRound('합성단지 2차 무순위(사후)(3차)'), 3);
  assert.equal(parseRemainderRound('합성 단지(14차)'), 14);
  assert.equal(parseRemainderRound('합성 단지 (14 차) '), 14);
  // 괄호 없는 단지 차수, 끝이 아닌 괄호 차수는 모른다.
  assert.equal(parseRemainderRound('합성단지 2차'), null);
  assert.equal(parseRemainderRound('합성단지(2차) 101동'), null);
  assert.equal(parseRemainderRound('합성단지(0차)'), null);
  assert.equal(parseRemainderRound('합성단지 2차 무순위(사후)'), null);
  assert.equal(parseRemainderRound('합성단지 무순위 2026년 1차'), null);
  assert.equal(parseRemainderRound('합성단지 무순위(0차)'), null);
  assert.equal(parseRemainderRound(''), null);
  assert.equal(parseRemainderRound(null), null);
  assert.equal(parseRemainderRound(undefined), null);
  // 리뷰에서 찔러 본 이름들
  assert.equal(parseRemainderRound('합성 e편한세상 3차'), null);
  assert.equal(parseRemainderRound('합성자이(3차) 무순위'), null);
  assert.equal(parseRemainderRound('합성 3차 무순위 (2차)'), 2);
  assert.equal(parseRemainderRound('합성(2차) 사후접수 5차'), 5);
  assert.equal(parseRemainderRound('합성 무순위 3차 (잔여 10세대)'), 3);
  assert.equal(parseRemainderRound('무순위(계약취소 3세대)'), null);
  assert.equal(parseRemainderRound('합성 1,2차 무순위'), null);
  assert.equal(parseRemainderRound('합성단지(3BL)'), null);
});

// 주택형 두 개: 84㎡는 단지 2곳(신뢰도 중), 59㎡는 단지 1곳(신뢰도 하).
const mixedModels = (price59) => [
  { houseType: '084A', area: 84, price: 100000 },
  { houseType: '059A', area: 59, price: price59 },
];
const mixedData = (unit84) => [...two(5, unit84), ...trades(5, 1000, { area: 59, amount: 59000, jibun: 'b1' })];

test('a 하 model with a larger margin cannot hide a confident model', async () => {
  // 84㎡ 중: 92400 - 100000 - 1500 - 3300 = -12400. 59㎡ 하: 59000 - 58000 - 1500 - 638 = -1138.
  const loss = await evaluate(remainder(), { models: mixedModels(58000), data: mixedData(1100) });
  assert.equal(loss.confidence, '중');
  assert.equal(loss.margin, -12400);
  assert.equal(loss.status, STATUS.NOT);

  // 84㎡ 중: 109200 - 100000 - 1500 - 3300 = 4400. 59㎡ 하: 59000 - 50000 - 1500 - 550 = 6950으로 더 크다. 중이 먼저라 확인 필요다.
  const gain = await evaluate(remainder(), { models: mixedModels(50000), data: mixedData(1300) });
  assert.equal(gain.confidence, '중');
  assert.equal(gain.margin, 4400);
  assert.equal(gain.status, STATUS.CHECK);

  // 84㎡ 중이 로또 조건을 넘으면 반복 공급이어도 로또다. 126000 - 100000 - 1500 - 3300 = 21200.
  const qualifying = await evaluate(remainder('합성단지(14차)'), { models: mixedModels(50000), data: mixedData(1500) });
  assert.equal(qualifying.confidence, '중');
  assert.equal(qualifying.margin, 21200);
  assert.equal(qualifying.status, STATUS.LOTTO);
});

test('a repeated round with a 하 estimate that has a big margin is 아님, not 로또 or 확인 필요', async () => {
  // 하 추정은 마진이 커도 로또가 아니라 확인 필요인데, 반복 공급이면 아님이 먼저다.
  const result = await evaluate(remainder('합성단지 무순위(사후)(14차)'), { data: trades(5, 2200) });
  assert.equal(result.confidence, '하');
  assert.equal(result.margin, 80000);
  assert.equal(result.status, STATUS.NOT);
  assert.equal(result.repeatedRound, 14);
  assert.ok(result.reason.startsWith('수도권 무순위·잔여세대 14차 반복 공급; 안전 마진 8.0억'), result.reason);
  // 같은 추정이 반복 공급이 아니면 확인 필요다.
  assert.equal((await evaluate(remainder('합성단지 무순위(사후)(2차)'), { data: trades(5, 2200) })).status, STATUS.CHECK);
});

// 59㎡는 단지 1곳(신뢰도 하): 88500 - 30000 - 1500 - 330 = 56670(마진은 크다). 84㎡는 단지 2곳(신뢰도 중): -12400.
const richWeakModels = mixedModels(30000);
const richWeakData = [...two(5, 1100), ...trades(5, 1500, { area: 59, amount: 88500, jibun: 'b1' })];

test('estimateBestMargin puts the confident model before the largest margin only when asked', () => {
  const plain = best(richWeakModels, richWeakData);
  assert.equal(plain.houseType, '059A');
  assert.equal(plain.confidence, '하');
  assert.equal(plain.margin, 56670);

  const preferred = best(richWeakModels, richWeakData, { preferConfident: true });
  assert.equal(preferred.houseType, '084A');
  assert.equal(preferred.confidence, '중');
  assert.equal(preferred.margin, -12400);

  // 신뢰도 중 이상이면서 로또 조건을 넘는 주택형은 어느 쪽이든 먼저다.
  const qualifying = [...two(5, 2200), ...trades(5, 1500, { area: 59, amount: 88500, jibun: 'b1' })];
  assert.equal(best(richWeakModels, qualifying).houseType, '084A');
  assert.equal(best(richWeakModels, qualifying, { preferConfident: true }).houseType, '084A');
  // 신뢰도 중 이상 주택형이 없으면 전체에서 마진이 가장 큰 것이다.
  assert.equal(best(richWeakModels, trades(5, 1500, { area: 59, amount: 88500, jibun: 'b1' }), { preferConfident: true }).houseType, '059A');
});

test('a non-trigger APT picks the same type as a trigger, and a weak estimate no longer keeps a stored 로또', async () => {
  // 신뢰도 중 주택형(마진 -12400)이 신뢰도 하 주택형(마진 56670)보다 먼저다. 조건형 공고와 같은 선택이다.
  const result = await evaluate(apt(), { models: richWeakModels, data: richWeakData });
  assert.equal(result.confidence, '중');
  assert.equal(result.margin, -12400);
  assert.equal(result.status, STATUS.NOT);
  assert.equal(keepPreviousLotto(result, STATUS.LOTTO).status, STATUS.NOT);

  // 신뢰도 하 추정만 있으면 마진이 커도 확인 필요이고, 저장된 로또는 유지하지 않는다.
  const weak = await evaluate(apt(), { data: trades(5, 2200) });
  assert.equal(weak.confidence, '하');
  assert.equal(weak.margin, 80000);
  assert.equal(weak.status, STATUS.CHECK);
  assert.ok(weak.reason.startsWith('시세 근거가 약함(신뢰도 하); 안전 마진 8.0억'), weak.reason);
  assert.equal(weak.checkNote, '시세 근거가 약함');
  assert.equal(keepPreviousLotto(weak, STATUS.LOTTO).status, STATUS.CHECK);
});

test('a trigger with a 하 type that has a big margin and a 중 type with a loss is 아님', async () => {
  const result = await evaluate(remainder(), { models: richWeakModels, data: richWeakData });
  assert.equal(result.confidence, '중');
  assert.equal(result.margin, -12400);
  assert.equal(result.status, STATUS.NOT);
  assert.ok(result.reason.startsWith('수도권 무순위·잔여세대 해당이나 시세 대비 이점 없음; '));
  assert.equal(keepPreviousLotto(result, STATUS.LOTTO).status, STATUS.NOT);
  // 가격 확인을 끈 조건은 시세와 무관하게 로또다. 주택형 선택은 같다.
  const unchecked = { triggerPriceCheck: { ...config.lotto.triggerPriceCheck, remainder: false } };
  const off = await evaluate(remainder(), { models: richWeakModels, data: richWeakData, overrides: unchecked });
  assert.equal(off.status, STATUS.LOTTO);
  assert.equal(off.margin, -12400);
});

test('bad trigger config falls back to the old behaviour and is reported once', async () => {
  const run = async (notice, data, overrides) => {
    const soft = [];
    const result = await evaluateLotto(notice, {
      config: { ...config, lotto: { ...config.lotto, ...overrides } },
      today,
      getModels: async () => [{ houseType: '084A', area: 84, price: 100000 }],
      getTrades: async () => data,
      onSoftOnce: (kind) => soft.push(kind),
    });
    return { result, soft };
  };
  const repeated = remainder('합성단지(14차)');
  // 차수 규칙이 꺼져 14차 추정 없음이 아님이 아니라 확인 필요다.
  for (const remainderMaxRound of [0, -1, 2.5, '3']) {
    const { result, soft } = await run(repeated, [], { remainderMaxRound });
    assert.equal(result.status, STATUS.CHECK, String(remainderMaxRound));
    assert.deepEqual(soft, ['bad_trigger_config'], String(remainderMaxRound));
  }
  // 가격 확인이 꺼져 시세와 무관하게 로또다.
  for (const triggerPriceCheck of [true, 'remainder', ['remainder'], null]) {
    const { result, soft } = await run(remainder(), two(5, 1100), { triggerPriceCheck });
    assert.equal(result.status, STATUS.LOTTO, JSON.stringify(triggerPriceCheck));
    assert.deepEqual(soft, ['bad_trigger_config'], JSON.stringify(triggerPriceCheck));
  }
  // 끄는 값(null)과 true가 아닌 키 값은 형식 오류가 아니다. 빠진 설정도 오류가 아니다.
  const { lotto } = config;
  const { triggerPriceCheck: _checks, remainderMaxRound: _round, ...withoutKeys } = lotto;
  // null은 반복 공급 규칙만 끈다(추정이 없는 14차가 확인 필요). 'yes'는 가격 확인을 끈다(중 음수 마진도 로또).
  for (const [overrides, data, expected] of [[{ remainderMaxRound: null }, [], STATUS.CHECK], [{ triggerPriceCheck: { remainder: 'yes' } }, two(5, 1100), STATUS.LOTTO]]) {
    const { result, soft } = await run(repeated, data, overrides);
    assert.equal(result.status, expected, JSON.stringify(overrides));
    assert.deepEqual(soft, []);
  }
  const missing = await evaluateLotto(remainder(), {
    config: { ...config, lotto: withoutKeys },
    today,
    getModels: async () => [{ houseType: '084A', area: 84, price: 100000 }],
    getTrades: async () => two(5, 1100),
    onSoftOnce: () => assert.fail('missing keys are not a config error'),
  });
  assert.equal(missing.status, STATUS.LOTTO);
  // 기본 설정은 오류가 아니다.
  assert.deepEqual((await run(repeated, [], {})).soft, []);
});

test('a missing or non-numeric margin threshold makes no notice 로또 and is reported once', async () => {
  const run = async (overrides) => {
    const soft = [];
    const result = await evaluateLotto(apt(), {
      config: { ...config, lotto: { ...config.lotto, ...overrides } },
      today,
      getModels: async () => modelAt(100000),
      getTrades: async () => two(5, 2200),
      onSoftOnce: (kind) => soft.push(kind),
    });
    return { result, soft };
  };
  assert.deepEqual((await run({})).soft, []);
  // 숫자가 아닌 기준은 문자열 "10000"처럼 비교로는 통과할 값이어도 쓰지 않는다.
  for (const overrides of [{ minMarginManwon: undefined }, { minMarginManwon: '10000' }, { minMarginRate: null }, { minMarginRate: Number.NaN }]) {
    const { result, soft } = await run(overrides);
    assert.deepEqual(soft, ['bad_margin_config'], JSON.stringify(overrides));
    assert.notEqual(result.status, STATUS.LOTTO, JSON.stringify(overrides));
  }
  assert.equal(badMarginConfig(config.lotto), false);
  assert.equal(badMarginConfig({ minMarginManwon: 0, minMarginRate: 0 }), false);
  assert.equal(badMarginConfig({}), true);
});

test('the removed margin settings are gone from the config and no longer validated', () => {
  assert.equal(config.lotto.minMarginManwon, 10000);
  assert.equal(config.lotto.minMarginRate, 0.1);
  assert.equal('lowConfidenceMinMarginRate' in config.lotto, false);
  assert.equal('triggerMinMarginRate' in config.lotto, false);
  assert.equal(STATUS.CHECK, '확인 필요');
  assert.equal(badTriggerConfig(config.lotto), false);
  // 예전 키는 있어도 아무 일도 하지 않는다.
  assert.equal(badTriggerConfig({ ...config.lotto, lowConfidenceMinMarginRate: 'x', triggerMinMarginRate: 'x' }), false);
});

test('a previous 로또 is dropped by a confident no-advantage, a repeated round or a 하 estimate', async () => {
  const confident = await evaluate(remainder(), { data: two(5, 1100) });
  assert.equal(keepPreviousLotto(confident, STATUS.LOTTO).status, STATUS.NOT);

  // 반복 공급의 아님은 신뢰도 하 추정이 있어도 이전 로또를 유지하지 않는다. 추정이 없을 때와 같다.
  const weakRound = await evaluate(remainder('합성단지 무순위(사후)(14차)'), { data: weakAt(10000) });
  assert.equal(weakRound.confidence, '하');
  assert.equal(keepPreviousLotto(weakRound, STATUS.LOTTO).status, STATUS.NOT);
  const noneRound = await evaluate(remainder('합성단지 무순위(사후)(14차)'), { data: [] });
  assert.equal(keepPreviousLotto(noneRound, STATUS.LOTTO).status, STATUS.NOT);

  // 신뢰도 하 아님도 이제 이전 로또를 유지하지 않는다. 조건 없는 공고도 같다.
  const weakPlain = await evaluate(apt(), { data: trades(5, 1100) });
  assert.equal(weakPlain.status, STATUS.NOT);
  assert.equal(weakPlain.confidence, '하');
  assert.equal(keepPreviousLotto(weakPlain, STATUS.LOTTO).status, STATUS.NOT);
});

test('a 하 estimate with a margin of 0 or less is 아님 for every trigger, whatever the rate', async () => {
  for (const notice of [remainder(), capped(), apt({ flags: { priceCap: false, publicDistrict: true } }), apt()]) {
    for (const margin of [-13000, -5000, -3000, -1, 0]) {
      const result = await evaluate(notice, { data: weakAt(margin) });
      assert.equal(result.confidence, '하');
      assert.equal(result.margin, margin);
      assert.equal(result.status, STATUS.NOT, `${margin}`);
      assert.equal(result.checkNote, undefined);
    }
  }
  const result = await evaluate(remainder(), { data: weakAt(-13000) });
  assert.equal(result.marginRate, -0.13);
  assert.ok(result.reason.startsWith('수도권 무순위·잔여세대 해당이나 시세 대비 이점 없음; 안전 마진 -1.3억'), result.reason);
});

test('a previous 로또 is dropped by a 하 trigger estimate, and the 아님 carries no stale flags', async () => {
  const result = await evaluate(remainder(), { data: weakAt(-13000) });
  const kept = keepPreviousLotto(result, STATUS.LOTTO);
  assert.equal(kept.status, STATUS.NOT);
  assert.equal(kept.reason, result.reason);
  // 하 신뢰도의 아님·확인 필요는 직접 만든 값으로도 유지 대상이 아니다.
  assert.equal(keepPreviousLotto({ status: STATUS.NOT, confidence: '하', reason: 'x' }, STATUS.LOTTO).status, STATUS.NOT);
  assert.equal(keepPreviousLotto({ status: STATUS.CHECK, confidence: '하', reason: 'x' }, STATUS.LOTTO).status, STATUS.CHECK);
});

// 주택형이 모두 신뢰도 하(각각 단지 1곳)인 조건형 공고. 059A는 5억, 084A는 15억이다.
// 059A: 마진 = amount - 50000 - 1500 - 550, 084A: 마진 = amount - 150000 - 1500 - 4950.
const weakPair = (amount59, amount84) => [
  ...trades(5, 0, { area: 59, amount: amount59, jibun: 'b1' }),
  ...trades(5, 0, { area: 84, amount: amount84, jibun: 'a1' }),
];
const pairModels = [{ houseType: '059A', area: 59, price: 50000 }, { houseType: '084A', area: 84, price: 150000 }];

test('with only 하 types every kind of notice looks at the largest margin', async () => {
  // 059A -3020(-6.04%), 084A -4500(-3%). 조건형이든 아니든 마진 금액이 큰 059A다.
  for (const notice of [remainder(), apt()]) {
    const result = await evaluate(notice, { models: pairModels, data: weakPair(49030, 151950) });
    assert.equal(result.confidence, '하');
    assert.equal(result.margin, -3020);
    assert.ok(result.reason.includes('(059A, 신뢰도 하)'), result.reason);
    assert.equal(result.status, STATUS.NOT);
  }
});

test('estimateBestMargin without a confident or qualifying type returns the largest margin', () => {
  const data = weakPair(49030, 151950);
  assert.equal(best(pairModels, data).houseType, '059A');
  assert.equal(best(pairModels, data, { preferConfident: true }).houseType, '059A');

  // 신뢰도 하는 마진이 아무리 커도 로또 조건을 넘지 못한다. 마진 금액이 큰 084A(3억 넘음)가 그대로 고른다.
  // 084A(20억): 240000 - 200000 - 1500 - 6600 = 31900. 059A(3억): 36800 - 30000 - 1500 - 330 = 4970.
  const richModels = [{ houseType: '059A', area: 59, price: 30000 }, { houseType: '084A', area: 84, price: 200000 }];
  const richData = [
    ...trades(5, 0, { area: 59, amount: 36800, jibun: 'b1' }),
    ...trades(5, 0, { area: 84, amount: 240000, jibun: 'a1' }),
  ];
  const rich = best(richModels, richData, { preferConfident: true });
  assert.equal(rich.houseType, '084A');
  assert.equal(rich.margin, 31900);
  assert.equal(rich.confidence, '하');
});

test('a repeated round with only 하 types is 아님, whatever the largest margin', async () => {
  const richModels = [{ houseType: '059A', area: 59, price: 30000 }, { houseType: '084A', area: 84, price: 200000 }];
  const richData = [
    ...trades(5, 0, { area: 59, amount: 36800, jibun: 'b1' }),
    ...trades(5, 0, { area: 84, amount: 240000, jibun: 'a1' }),
  ];
  const result = await evaluate(remainder('합성단지 무순위(사후)(14차)'), { models: richModels, data: richData });
  assert.equal(result.confidence, '하');
  assert.equal(result.margin, 31900);
  // 하 추정이라 확인 필요가 될 것을 반복 공급이 아님으로 만든다.
  assert.equal(result.status, STATUS.NOT);
  assert.equal(result.repeatedRound, 14);
});

// ---- 확인 필요(STATUS.CHECK): 마진은 양수인데 로또 조건에 못 미친 공고, 시세 추정이 없는 조건형 후보 ----

// 신뢰도 중(단지 2곳) 추정의 안전 마진을 정해 둔 거래. 분양가 10억이라 마진 = amount - 104800, 마진율 = 마진 / 100000.
const confidentAt = (marginManwon) => two(5, 0, { amount: 104800 + marginManwon });
const district = () => apt({ flags: { priceCap: false, publicDistrict: true } });

// 읍·면 주소인데 같은 읍·면 단지가 없어 시군구(다산동 단지 4곳)로 넓힌 추정. 신뢰도 하이고 마진율은 +27.5%다.
const namyangju = () => apt({ kind: 'remainder', houseSecd: '04', name: '합성단지 무순위', region: '경기', address: '경기도 남양주시 오남읍 양지리 1' });
const widenedData = () => ['d1', 'd2', 'd3', 'd4'].flatMap((jibun) => trades(5, 0, { umd: '다산동', jibun, amount: 132300 }));

test('a confident estimate under 1억 or 10% is 확인 필요 with the reason, at the thresholds it is 로또', async () => {
  // 신뢰도 중, 마진 +700만원(분양가 10억의 +0.7%)
  for (const notice of [remainder(), capped(), district()]) {
    const thin = await evaluate(notice, { data: confidentAt(700) });
    assert.equal(thin.confidence, '중');
    assert.equal(thin.margin, 700);
    assert.equal(thin.marginRate, 0.007);
    assert.equal(thin.status, STATUS.CHECK);
    assert.ok(/^(수도권 무순위·잔여세대|분양가상한제 적용|공공주택지구) 해당이나 마진이 기준에 못 미침\(안전 마진 700만 원 < 10000만 원, 마진율 0\.7% < 10%\); 안전 마진 0\.1억, 마진율 1%\(분양가 대비\) \(084A, 신뢰도 중\); /.test(thin.reason), thin.reason);
    assert.ok(thin.shortReason.endsWith('(안전 마진 700만 원 < 10000만 원, 마진율 0.7% < 10%); 안전 마진 0.1억, 마진율 1%(분양가 대비) (084A, 신뢰도 중)'), thin.shortReason);
    assert.ok(/^(수도권 무순위·잔여세대|분양가상한제 적용|공공주택지구) 해당이나 마진이 기준에 못 미침\(안전 마진 1\.0억 미만 또는 마진율 10% 미만\)$/.test(thin.checkNote), thin.checkNote);
  }
  // 마진이 정확히 0이면 아님이다(0 이하).
  assert.equal((await evaluate(remainder(), { data: confidentAt(0) })).status, STATUS.NOT);
  assert.equal((await evaluate(remainder(), { data: confidentAt(9999) })).status, STATUS.CHECK);
  // 경계(1억, 10%)는 로또다. 그 위도 로또다.
  const edge = await evaluate(remainder(), { data: confidentAt(10000) });
  assert.equal(edge.marginRate, 0.1);
  assert.equal(edge.status, STATUS.LOTTO);
  assert.equal(edge.checkNote, undefined);
  assert.equal((await evaluate(remainder(), { data: confidentAt(10001) })).status, STATUS.LOTTO);
  assert.equal((await evaluate(remainder(), { data: confidentAt(50000) })).status, STATUS.LOTTO);
  // 음수 마진은 아님이다.
  const negative = await evaluate(remainder(), { data: confidentAt(-100) });
  assert.equal(negative.status, STATUS.NOT);
  assert.ok(negative.reason.startsWith('수도권 무순위·잔여세대 해당이나 시세 대비 이점 없음; '), negative.reason);
});

test('the margin amount and the margin rate are both needed (AND), each on its own side of the boundary', async () => {
  // 분양가 5억: 마진 9999만원은 마진율 20%이지만 1억 미만이다.
  const smallPrice = await evaluate(remainder(), { models: modelAt(50000), data: confidentFor(50000, 9999) });
  assert.equal(smallPrice.confidence, '중');
  assert.equal(smallPrice.margin, 9999);
  assert.ok(smallPrice.marginRate > 0.19);
  assert.equal(smallPrice.status, STATUS.CHECK);
  assert.ok(smallPrice.reason.includes('(안전 마진 9999만 원 < 10000만 원)'), smallPrice.reason);
  assert.ok(smallPrice.checkNote.endsWith('마진이 기준에 못 미침(안전 마진 1.0억 미만)'), smallPrice.checkNote);
  assert.equal((await evaluate(remainder(), { models: modelAt(50000), data: confidentFor(50000, 10000) })).status, STATUS.LOTTO);

  // 분양가 20억: 마진 19999만원은 1억을 크게 넘지만 마진율이 10% 미만(9.9995%)이다.
  const bigPrice = await evaluate(remainder(), { models: modelAt(200000), data: confidentFor(200000, 19999) });
  assert.equal(bigPrice.margin, 19999);
  assert.ok(bigPrice.marginRate < 0.1);
  assert.equal(bigPrice.status, STATUS.CHECK);
  assert.ok(bigPrice.checkNote.endsWith('마진이 기준에 못 미침(마진율 10% 미만)'), bigPrice.checkNote);
  assert.equal((await evaluate(remainder(), { models: modelAt(200000), data: confidentFor(200000, 20000) })).status, STATUS.LOTTO);
  // 3억 이상 마진은 예전에 마진율과 상관없이 로또였지만 이제 10% 미만이면 확인 필요다. 분양가 40억에 마진 3.2억은 8%다.
  const huge = await evaluate(remainder(), { models: modelAt(400000), data: confidentFor(400000, 32000) });
  assert.equal(huge.margin, 32000);
  assert.equal(huge.marginRate, 0.08);
  assert.equal(huge.status, STATUS.CHECK);
});

test('every row of the outcome table, for a trigger candidate and for a plain 분양 notice', async () => {
  // [설명, 분양가, 거래 만드는 함수, 마진, 조건형 후보 결과, 일반 공고 결과]
  const rows = [
    ['중 exactly at 1억 and 10%', 100000, confidentFor, 10000, STATUS.LOTTO, STATUS.LOTTO],
    ['중 just below both', 100000, confidentFor, 9999, STATUS.CHECK, STATUS.CHECK],
    ['중 just below the amount only', 50000, confidentFor, 9999, STATUS.CHECK, STATUS.CHECK],
    ['중 just below the rate only', 200000, confidentFor, 19999, STATUS.CHECK, STATUS.CHECK],
    ['중 at the amount and rate on a bigger price', 200000, confidentFor, 20000, STATUS.LOTTO, STATUS.LOTTO],
    ['상 at the thresholds', 100000, firmFor, 10000, STATUS.LOTTO, STATUS.LOTTO],
    ['상 with 4% (about 2,800만원)', 70000, firmFor, 2800, STATUS.CHECK, STATUS.CHECK],
    ['하 with a large positive margin', 100000, weakFor, 30000, STATUS.CHECK, STATUS.CHECK],
    ['하 with 27%', 100000, weakFor, 27000, STATUS.CHECK, STATUS.CHECK],
    ['하 with -3%', 100000, weakFor, -3000, STATUS.NOT, STATUS.NOT],
    ['하 with 0', 100000, weakFor, 0, STATUS.NOT, STATUS.NOT],
    ['중 with 0', 100000, confidentFor, 0, STATUS.NOT, STATUS.NOT],
    ['중 with a loss', 100000, confidentFor, -1, STATUS.NOT, STATUS.NOT],
    ['상 with a loss', 100000, firmFor, -5000, STATUS.NOT, STATUS.NOT],
  ];
  for (const [label, price, make, margin, trigger, plain] of rows) {
    const data = make(price, margin);
    const models = modelAt(price);
    const triggered = await evaluate(remainder('공고단지'), { models, data });
    assert.equal(triggered.margin, margin, label);
    assert.equal(triggered.status, trigger, `trigger: ${label}`);
    const notice = await evaluate(apt({ name: '공고단지' }), { models, data });
    assert.equal(notice.status, plain, `plain: ${label}`);
    // 확인 필요만 주간 메일용 사유를 가진다.
    assert.equal(triggered.checkNote !== undefined, trigger === STATUS.CHECK, label);
    assert.equal(notice.checkNote !== undefined, plain === STATUS.CHECK, label);
  }
  // 신뢰도는 상, 중, 하가 그대로 나온다.
  assert.equal((await evaluate(apt({ name: '공고단지' }), { models: modelAt(100000), data: firmFor(100000, 10000) })).confidence, '상');
  assert.equal((await evaluate(apt(), { models: modelAt(100000), data: confidentFor(100000, 10000) })).confidence, '중');
  assert.equal((await evaluate(apt(), { models: modelAt(100000), data: weakFor(100000, 10000) })).confidence, '하');
});

test('no estimate: a price-checked trigger is 확인 필요, a plain notice is 판별 불가, 불법행위 재공급 is 로또', async () => {
  for (const data of [[], trades(4, 3000)]) {
    for (const notice of [remainder(), capped(), district(), apt({ kind: 'arbitrary', houseSecd: '' })]) {
      const overrides = notice.kind === 'arbitrary' ? { includeArbitrary: true } : {};
      const result = await evaluate(notice, { data, overrides });
      assert.equal(result.status, STATUS.CHECK);
      assert.equal(result.estimate, null);
      assert.equal(result.margin, null);
      assert.ok(result.checkNote.includes('시세 추정 없음(실거래 표본 부족)'), result.checkNote);
      assert.ok(!result.reason.includes('로또'), result.reason);
    }
    assert.equal((await evaluate(apt(), { data })).status, STATUS.UNDETERMINED);
    assert.equal((await evaluate(resupplyNotice(), { data })).status, STATUS.LOTTO);
  }
  // 시군구 코드를 찾지 못한 주소도 추정이 없는 것이다.
  const unmapped = await evaluate(apt({ kind: 'remainder', houseSecd: '04', address: '서울특별시 서구 어딘가' }), { data: trades(5, 3000) });
  assert.equal(unmapped.status, STATUS.CHECK);
  assert.ok(unmapped.reason.endsWith('시세 추정 없음(시군구 코드 미매핑)'), unmapped.reason);
});

test('a genuine lotto (중, 2.16억, 37.8%, comparables from the whole 시군구) stays 로또', async () => {
  // 하남 교산 A-2 사후 검증 사례를 합성 값으로 옮겼다. 교산동에는 거래가 없어 하남시 전체 단지로 쟀지만 신뢰도는 중이다.
  const price = 57100;
  const data = [...trades(5, 0, { umd: '풍산동', jibun: 'h1', amount: amountFor(price, 21600) }), ...trades(5, 0, { umd: '망월동', jibun: 'h2', amount: amountFor(price, 21600) })];
  const home = apt({ region: '경기', address: '경기도 하남시 교산동 1', flags: { priceCap: true, publicDistrict: true } });
  for (const notice of [home, apt({ ...home, flags: { priceCap: false, publicDistrict: false } })]) {
    const result = await evaluate(notice, { models: modelAt(price), data });
    assert.equal(result.confidence, '중');
    assert.equal(result.margin, 21600);
    assert.ok(Math.abs(result.marginRate - 0.378) < 0.001, String(result.marginRate));
    assert.equal(result.status, STATUS.LOTTO);
    assert.ok(result.reason.includes('시군구'), result.reason);
    assert.ok(!result.reason.includes('비교 범위 확대(시군구)') || result.status === STATUS.LOTTO);
  }
});

test('a false positive (하, +27%, widened scope) is 확인 필요, not 로또', async () => {
  const town = await evaluate(namyangju(), { data: widenedData() });
  assert.equal(town.confidence, '하');
  assert.equal(town.marginRate, 0.275);
  assert.equal(town.status, STATUS.CHECK);
  assert.ok(town.reason.includes('비교 범위 확대(같은 읍·면 단지 없어 시군구)'), town.reason);
  // 조건 없는 공고도 같다.
  const plain = await evaluate(apt({ ...namyangju(), kind: 'apt', houseSecd: '01' }), { data: widenedData() });
  assert.equal(plain.confidence, '하');
  assert.equal(plain.status, STATUS.CHECK);
  assert.equal(keepPreviousLotto(plain, STATUS.LOTTO).status, STATUS.CHECK);
});

test('a 하 trigger estimate with a positive margin is 확인 필요, even with a large margin rate', async () => {
  // 마진율 +10%, 하
  const mild = await evaluate(remainder(), { data: weakAt(10000) });
  assert.equal(mild.confidence, '하');
  assert.equal(mild.marginRate, 0.1);
  assert.equal(mild.status, STATUS.CHECK);
  assert.ok(mild.reason.startsWith('수도권 무순위·잔여세대 해당이나 시세 근거가 약함(신뢰도 하); 안전 마진 1.0억'), mild.reason);
  assert.ok(mild.shortReason.endsWith('시세 근거가 약함(신뢰도 하); 안전 마진 1.0억, 마진율 10%(분양가 대비) (084A, 신뢰도 하)'), mild.shortReason);
  assert.equal(mild.checkNote, '수도권 무순위·잔여세대 해당이나 시세 근거가 약함');
  // 마진율 +27.5%도 확인 필요다. 비교 범위를 넓히지 않았으면 범위 말은 없다.
  const rich = await evaluate(remainder(), { data: weakAt(27500) });
  assert.equal(rich.status, STATUS.CHECK);
  assert.ok(!rich.reason.includes('비교 범위 확대'), rich.reason);
  // 마진이 0을 넘으면 아주 작아도 확인 필요다. 신뢰도 하 추정은 근거 자체가 약하다.
  assert.equal((await evaluate(remainder(), { data: weakAt(1) })).status, STATUS.CHECK);
  // 다른 조건형 공고도 같다.
  for (const notice of [capped(), district()]) assert.equal((await evaluate(notice, { data: weakAt(10000) })).status, STATUS.CHECK);
});

test('a 하 estimate from a widened scope says so in the reason (읍·면 example)', async () => {
  const town = await evaluate(namyangju(), { data: widenedData() });
  assert.equal(town.confidence, '하');
  assert.equal(town.marginRate, 0.275);
  assert.equal(town.status, STATUS.CHECK);
  assert.ok(town.reason.startsWith('수도권 무순위·잔여세대 해당이나 시세 근거가 약함(신뢰도 하, 비교 범위 확대(같은 읍·면 단지 없어 시군구)); 안전 마진 2.8억'), town.reason);
  assert.equal(town.checkNote, '수도권 무순위·잔여세대 해당이나 시세 근거가 약함(비교 범위 확대(같은 읍·면 단지 없어 시군구))');
  // 근거 문구에 기존 읍·면 설명도 그대로 있다.
  assert.ok(town.reason.includes('같은 읍·면 단지를 찾지 못해 신뢰도 하'));

  // 동 주소가 같은 법정동 거래가 없어 시군구로 넓힌 경우도 범위를 적는다.
  const dong = await evaluate(remainder(), { data: trades(5, 0, { umd: '삼성동', amount: 132300 }) });
  assert.equal(dong.confidence, '하');
  assert.equal(dong.status, STATUS.CHECK);
  assert.ok(dong.reason.startsWith('수도권 무순위·잔여세대 해당이나 시세 근거가 약함(신뢰도 하, 비교 범위 확대(시군구)); '), dong.reason);
});

test('불법행위 재공급 stays 로또 whatever the evidence, because its price check is off', async () => {
  const resupply = resupplyNotice();
  for (const data of [confidentAt(700), weakAt(27500), weakAt(10000), weakAt(-13000), []]) {
    const result = await evaluate(resupply, { data });
    assert.equal(result.status, STATUS.LOTTO);
    assert.equal(result.checkNote, undefined);
  }
  // 가격 확인을 켜면 다른 조건형 공고처럼 확인 필요가 된다.
  const checked = { triggerPriceCheck: { ...config.lotto.triggerPriceCheck, resupply: true } };
  assert.equal((await evaluate(resupply, { data: confidentAt(700), overrides: checked })).status, STATUS.CHECK);
  assert.equal((await evaluate(resupply, { data: [], overrides: checked })).status, STATUS.CHECK);
  // 무순위의 가격 확인을 끄면 확인 필요 규칙도 꺼져 시세와 무관하게 로또다.
  const unchecked = { triggerPriceCheck: { ...config.lotto.triggerPriceCheck, remainder: false } };
  for (const data of [confidentAt(700), weakAt(27500), []]) assert.equal((await evaluate(remainder(), { data, overrides: unchecked })).status, STATUS.LOTTO);
});

test('a repeated round beats 확인 필요: the candidate becomes 아님, and only a real 로또 stays 로또', async () => {
  const repeated = remainder('합성단지 무순위(사후)(14차)');
  const thin = await evaluate(repeated, { data: confidentAt(700) });
  assert.equal(thin.confidence, '중');
  assert.equal(thin.status, STATUS.NOT);
  assert.equal(thin.repeatedRound, 14);
  assert.equal(thin.checkNote, undefined);
  assert.ok(thin.reason.startsWith('수도권 무순위·잔여세대 14차 반복 공급; 안전 마진 0.1억'), thin.reason);

  const weak = await evaluate(repeated, { data: weakAt(10000) });
  assert.equal(weak.confidence, '하');
  assert.equal(weak.status, STATUS.NOT);
  assert.equal(weak.repeatedRound, 14);

  // 신뢰도 중 이상이고 1억과 10%를 넘으면 차수와 상관없이 로또다.
  assert.equal((await evaluate(repeated, { data: confidentAt(15000) })).status, STATUS.LOTTO);
  // 기준 차수 미만(2차)이면 같은 추정이 확인 필요다.
  const second = remainder('합성단지 무순위(사후)(2차)');
  assert.equal((await evaluate(second, { data: confidentAt(700) })).status, STATUS.CHECK);
  assert.equal((await evaluate(second, { data: weakAt(10000) })).status, STATUS.CHECK);
  // 차수 규칙을 끄면 반복 공급도 확인 필요다.
  assert.equal((await evaluate(repeated, { data: confidentAt(700), overrides: { remainderMaxRound: null } })).status, STATUS.CHECK);
});

test('a previous 로또 that becomes 확인 필요 or 아님 is demoted, only 판별 불가 and lookup failures are kept', async () => {
  const thin = await evaluate(remainder(), { data: confidentAt(700) });
  assert.equal(thin.status, STATUS.CHECK);
  assert.equal(keepPreviousLotto(thin, STATUS.LOTTO).status, STATUS.CHECK);
  assert.equal(keepPreviousLotto(thin, STATUS.LOTTO).reason, thin.reason);
  const weak = await evaluate(remainder(), { data: weakAt(10000) });
  assert.equal(weak.confidence, '하');
  assert.equal(keepPreviousLotto(weak, STATUS.LOTTO).status, STATUS.CHECK);
  assert.equal(keepPreviousLotto(thin, STATUS.CHECK).status, STATUS.CHECK);
  // 하 → 아님도 같다(예전의 신뢰도 하 보호는 없다).
  const lost = await evaluate(remainder(), { data: weakAt(-3000) });
  assert.equal(lost.status, STATUS.NOT);
  assert.equal(keepPreviousLotto(lost, STATUS.LOTTO).status, STATUS.NOT);
  // 자료가 없어 추정이 없는 확인 필요도 시세로 정한 판정이라 유지하지 않는다.
  const none = await evaluate(remainder(), { data: [] });
  assert.equal(none.status, STATUS.CHECK);
  assert.equal(keepPreviousLotto(none, STATUS.LOTTO).status, STATUS.CHECK);
  // 직접 만든 값으로도 같다.
  assert.equal(keepPreviousLotto({ status: STATUS.CHECK, confidence: '하', reason: 'x' }, STATUS.LOTTO).status, STATUS.CHECK);

  // 판별 불가는 유지한다. 시세 조회 실패로 추정을 모르는 조건형 후보의 확인 필요도 유지한다.
  const undetermined = await evaluate(apt(), { data: [] });
  assert.equal(undetermined.status, STATUS.UNDETERMINED);
  const keptUndetermined = keepPreviousLotto(undetermined, STATUS.LOTTO);
  assert.equal(keptUndetermined.status, STATUS.LOTTO);
  assert.ok(keptUndetermined.reason.startsWith('이전 판별 유지 (이번 실행: '), keptUndetermined.reason);
  const failed = await evaluateLotto(remainder(), {
    config,
    today,
    getModels: async () => modelAt(100000),
    getTrades: async () => { throw new Error('x'); },
    onError: () => {},
  });
  assert.equal(failed.status, STATUS.CHECK);
  assert.equal(failed.lookupFailed, true);
  assert.equal(keepPreviousLotto(failed, STATUS.LOTTO).status, STATUS.LOTTO);
  assert.equal(keepPreviousLotto(failed, STATUS.NOT).status, STATUS.CHECK);
  assert.equal(keepPreviousLotto(failed, null).status, STATUS.CHECK);
  // 반복 공급의 조회 실패는 아님이라 유지하지 않는다.
  const failedRound = await evaluateLotto(remainder('합성단지(14차)'), {
    config,
    today,
    getModels: async () => modelAt(100000),
    getTrades: async () => { throw new Error('x'); },
    onError: () => {},
  });
  assert.equal(failedRound.status, STATUS.NOT);
  assert.equal(keepPreviousLotto(failedRound, STATUS.LOTTO).status, STATUS.NOT);
});

test('an empty trade lookup is counted softly, and only when the lookup returned no rows', async () => {
  const run = async (data, notice = apt()) => {
    const soft = [];
    const result = await evaluateLotto(notice, {
      config,
      today,
      getModels: async () => modelAt(100000),
      getTrades: async () => data,
      onSoft: (kind) => soft.push(kind),
    });
    return { result, soft };
  };
  assert.deepEqual((await run([])).soft, ['trade_lookup_empty']);
  assert.deepEqual((await run([], remainder())).soft, ['trade_lookup_empty']);
  // 표본이 모자라도 거래가 있으면 세지 않는다.
  assert.deepEqual((await run(trades(2, 1000))).soft, []);
  assert.deepEqual((await run(trades(5, 1000))).soft, []);
  // 지역 밖 공고와 시군구 코드를 찾지 못한 공고는 조회하지 않아 세지 않는다.
  assert.deepEqual((await run([], apt({ address: '서울특별시 서구 어딘가' }))).soft, []);
  assert.deepEqual((await run([], apt({ region: '부산' }))).soft, []);
});

// ---- 조회 실패로 낮아진 신뢰도는 판정을 바꾸지 않는다 ----

// 분양권 조회가 실패하거나 역 정보 조회가 실패한 실행. 신뢰도 중 추정이 하로 내려간다.
const evaluateWith = (notice, { data, models = [{ houseType: '084A', area: 84, price: 100000 }], presale, aptInfo, walkMinutes = null, overrides = {} }) => evaluateLotto(notice, {
  config: { ...config, lotto: { ...config.lotto, ...overrides } },
  today,
  getModels: async () => models,
  getTrades: async () => data,
  getPresale: presale,
  aptInfo,
  walkMinutes,
});
const presaleDown = async () => { throw new Error('presale down'); };
// 공동주택 목록 조회가 AppError로 실패하면 역 정보가 없는 것으로 본다(src/lotto.js의 resolveStations).
const aptInfoDown = { getDirectory: async () => { throw new AppError('apt_info_down'); }, getStation: async () => null };

test('a presale lookup failure lowers the shown confidence but not the decision of a 중 trigger 로또', async () => {
  const ok = await evaluateWith(remainder(), { data: confidentAt(15000), presale: async () => ({ rows: [], ok: true }) });
  assert.equal(ok.confidence, '중');
  assert.equal(ok.status, STATUS.LOTTO);

  const down = await evaluateWith(remainder(), { data: confidentAt(15000), presale: presaleDown });
  assert.equal(down.confidence, '하');
  assert.equal(down.marginRate, 0.15);
  assert.equal(down.status, STATUS.LOTTO);
  assert.ok(down.reason.endsWith('; 분양권·역 정보 조회 실패로 신뢰도를 하로 낮췄으나 중 기준으로 판정'), down.reason);
  assert.ok(!down.shortReason.includes('조회 실패'));
  // 새 공고도, 저장된 로또도 같다. 저장된 로또는 유지가 아니라 이번 판정 그대로 로또다.
  assert.equal(keepPreviousLotto(down, STATUS.LOTTO).status, STATUS.LOTTO);
  assert.equal(keepPreviousLotto(down, STATUS.LOTTO).reason, down.reason);
  assert.equal(keepPreviousLotto(down, STATUS.NOT).status, STATUS.LOTTO);
  // 같은 날 다른 조건형 공고와 조건 없는 공고도 같다.
  for (const notice of [capped(), district(), apt()]) assert.equal((await evaluateWith(notice, { data: confidentAt(15000), presale: presaleDown })).status, STATUS.LOTTO);

  // 중 기준으로 보면 마진이 모자라거나 음수인 공고는 조회 실패와 상관없이 같은 판정이다.
  assert.equal((await evaluateWith(remainder(), { data: confidentAt(700), presale: presaleDown })).status, STATUS.CHECK);
  const negative = await evaluateWith(remainder(), { data: confidentAt(-3000), presale: presaleDown });
  assert.equal(negative.status, STATUS.NOT);
  // 반복 공급의 중 기준 로또(1억과 10% 이상)도 그대로다.
  assert.equal((await evaluateWith(remainder('합성단지 무순위(사후)(14차)'), { data: confidentAt(15000), presale: presaleDown })).status, STATUS.LOTTO);
});

test('a station lookup failure lowers the shown confidence but not the decision of a 중 trigger 로또', async () => {
  const run = (data, extra = {}) => evaluateWith(remainder(), { data, aptInfo: aptInfoDown, walkMinutes: 5, ...extra });
  const down = await run(confidentAt(15000));
  assert.equal(down.stationState, 'noData');
  assert.equal(down.confidence, '하');
  assert.equal(down.status, STATUS.LOTTO);
  assert.ok(down.reason.endsWith('; 분양권·역 정보 조회 실패로 신뢰도를 하로 낮췄으나 중 기준으로 판정'), down.reason);
  assert.equal(keepPreviousLotto(down, STATUS.LOTTO).status, STATUS.LOTTO);
  // 역 정보 조회가 실패한 날에도 마진이 모자라면 확인 필요다.
  assert.equal((await run(confidentAt(700))).status, STATUS.CHECK);
  // 조회에 실패한 것이 아니라 비교 단지에 역 정보가 없는 경우(실패 아님)는 자료 문제라 신뢰도 하로 본다.
  const noStation = await evaluateWith(remainder(), { data: confidentAt(15000), aptInfo: { getDirectory: async () => [], getStation: async () => null }, walkMinutes: 5 });
  assert.equal(noStation.confidence, '하');
  assert.equal(noStation.status, STATUS.CHECK);
});

test('a lookup failure does not rescue a 하 estimate that is 하 for data reasons', async () => {
  // 읍·면 단지를 못 찾아 시군구로 넓힌 추정은 조회와 상관없이 하다.
  const town = await evaluateWith(namyangju(), { data: widenedData(), presale: presaleDown });
  assert.equal(town.confidence, '하');
  assert.equal(town.status, STATUS.CHECK);
  assert.ok(!town.reason.includes('조회 실패'));
  // 비교 단지 1곳(표본이 모자란 하)도 그대로 확인 필요다.
  const one = await evaluateWith(remainder(), { data: weakAt(10000), presale: presaleDown });
  assert.equal(one.confidence, '하');
  assert.equal(one.status, STATUS.CHECK);
});

test('a 하 estimate without a parsable 법정동 is not described as a widened scope', async () => {
  // 동을 읽지 못한 주소는 처음부터 시군구로 본다. 더 좁은 범위를 보지 않았으니 범위를 넓혔다고 쓰지 않는다.
  const noDong = await evaluate(apt({ kind: 'remainder', houseSecd: '04', name: '합성단지 무순위', address: '서울특별시 강남구 1' }), { data: trades(5, 0, { umd: '삼성동', amount: 132300 }) });
  assert.equal(noDong.confidence, '하');
  assert.equal(noDong.status, STATUS.CHECK);
  assert.ok(noDong.reason.startsWith('수도권 무순위·잔여세대 해당이나 시세 근거가 약함(신뢰도 하); '), noDong.reason);
  assert.equal(noDong.checkNote, '수도권 무순위·잔여세대 해당이나 시세 근거가 약함');
  // 법정동을 읽었는데 그 동에 거래가 없어 넓힌 경우는 그대로 적는다.
  const dong = await evaluate(remainder(), { data: trades(5, 0, { umd: '삼성동', amount: 132300 }) });
  assert.ok(dong.reason.includes('비교 범위 확대(시군구)'), dong.reason);
});

test('the shortfall reason floors the rate to one decimal so a rate under the minimum never reads as equal to it', async () => {
  // 분양가 20억, 마진 19960만원 = 9.98%. 마진은 1억을 넘으니 마진율만 못 넘는다.
  const near = await evaluate(remainder(), { models: modelAt(200000), data: confidentFor(200000, 19960) });
  assert.equal(near.status, STATUS.CHECK);
  assert.ok(near.reason.startsWith('수도권 무순위·잔여세대 해당이나 마진이 기준에 못 미침(마진율 9.9% < 10%); '), near.reason);
});

test('with only 중 types the type that meets 1억 and 10% is picked even when another type has a larger margin', async () => {
  // 084A(30억): 마진 28000만원(9.3%)은 크지만 마진율이 10% 미만이다. 059A(5억): 마진 10500만원(21%)은 둘 다 넘는다.
  const models = [{ houseType: '084A', area: 84, price: 300000 }, { houseType: '059A', area: 59, price: 50000 }];
  const data = [...two(5, 0, { area: 84, amount: amountFor(300000, 28000) }), ...two(5, 0, { area: 59, amount: amountFor(50000, 10500) })];
  for (const notice of [remainder(), apt()]) {
    const picked = await evaluate(notice, { models, data });
    assert.equal(picked.confidence, '중');
    assert.ok(picked.reason.includes('(059A, 신뢰도 중)'), picked.reason);
    assert.equal(picked.margin, 10500);
    assert.equal(picked.status, STATUS.LOTTO);
  }
  // 기준을 넘는 주택형이 없으면 마진 금액이 큰 084A이고 확인 필요다.
  const none = await evaluate(remainder(), { models, data: [...two(5, 0, { area: 84, amount: amountFor(300000, 28000) }), ...two(5, 0, { area: 59, amount: amountFor(50000, 9000) })] });
  assert.ok(none.reason.includes('(084A, 신뢰도 중)'), none.reason);
  assert.equal(none.status, STATUS.CHECK);
});

// ---- 구로 나뉜 시의 주소: 구 코드마다 조회해 합친다 ----

const bucheon = (extra = {}) => apt({ region: '경기', address: '경기도 부천시 대장동 일원', flags: { priceCap: true, publicDistrict: false }, ...extra });

test('a 부천 address without a 구 asks for each 구 code and merges the trades into one estimate', async () => {
  const asked = [];
  // 거래가 구마다 흩어져 있다. 한 코드만 보면 단지 1곳(신뢰도 하)이지만 합치면 단지 2곳(신뢰도 중)이다.
  const byCode = {
    41192: trades(5, 2200, { umd: '대장동', jibun: 'b1' }),
    41194: trades(5, 2200, { umd: '대장동', jibun: 'b2' }),
    41196: [],
  };
  const result = await evaluateLotto(bucheon(), {
    config,
    today,
    getModels: async () => modelAt(100000),
    getTrades: async (code, months) => { asked.push(code); assert.equal(months.length, config.lotto.tradeMonths); return byCode[code]; },
  });
  // 구 없는 시 코드(41190)는 부르지 않는다.
  assert.deepEqual([...new Set(asked)], ['41192', '41194', '41196']);
  assert.equal(result.confidence, '중');
  assert.equal(result.estimate, 184800);
  assert.equal(result.status, STATUS.LOTTO);
  assert.ok(result.reason.includes('법정동'), result.reason);
});

test('a 구 address asks for one code, and a failing 구 code makes the whole lookup a failure', async () => {
  const asked = [];
  await evaluateLotto(bucheon({ address: '경기도 부천시 원미구 중동 1' }), {
    config,
    today,
    getModels: async () => modelAt(100000),
    getTrades: async (code) => { asked.push(code); return []; },
  });
  assert.deepEqual([...new Set(asked)], ['41192']);

  const errors = [];
  const failed = await evaluateLotto(bucheon(), {
    config,
    today,
    getModels: async () => modelAt(100000),
    getTrades: async (code) => { if (code === '41194') throw new Error('x'); return trades(5, 2200, { umd: '대장동' }); },
    onError: (kind) => errors.push(kind),
  });
  assert.equal(errors.length, 1);
  assert.equal(failed.status, STATUS.CHECK);
  assert.equal(failed.lookupFailed, true);
  assert.ok(failed.reason.includes('실거래 조회 실패'), failed.reason);
  // 이 경우 저장된 로또는 유지한다.
  assert.equal(keepPreviousLotto(failed, STATUS.LOTTO).status, STATUS.LOTTO);
});

test('presale rows and the 단지 목록 of every 구 code are read for a 부천 address', async () => {
  const presaleAsked = [];
  const directoryAsked = [];
  const result = await evaluateLotto(bucheon(), {
    config,
    today,
    getModels: async () => modelAt(100000),
    getTrades: async () => two(5, 2200, { umd: '대장동' }),
    getPresale: async (code) => { presaleAsked.push(code); return { rows: [], ok: true }; },
    aptInfo: {
      getDirectory: async (code) => { directoryAsked.push(code); return []; },
      getStation: async () => null,
    },
    walkMinutes: 5,
  });
  assert.deepEqual([...new Set(presaleAsked)], ['41192', '41194', '41196']);
  assert.deepEqual(directoryAsked, ['41192', '41194', '41196']);
  // 비교 단지에 역 정보가 없어 신뢰도 하(자료 문제)이므로 확인 필요다. 조회한 구 코드를 확인하는 것이 이 테스트의 요점이다.
  assert.equal(result.status, STATUS.CHECK);
  // 한 구의 분양권 조회가 실패하면 신뢰도만 낮추고 추정은 한다. 조회 실패라 판정은 중 기준 그대로다.
  const down = await evaluateLotto(bucheon(), {
    config,
    today,
    getModels: async () => modelAt(100000),
    getTrades: async () => two(5, 2200, { umd: '대장동' }),
    getPresale: async (code) => { if (code === '41194') throw new Error('x'); return { rows: [], ok: true }; },
  });
  assert.equal(down.confidence, '하');
  assert.equal(down.status, STATUS.LOTTO);
});
