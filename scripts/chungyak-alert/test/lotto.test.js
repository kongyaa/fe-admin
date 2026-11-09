import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { STATUS, evaluateLotto, keepPreviousLotto, parseRemainderRound } from '../src/lotto.js';
import { estimateBestMargin } from '../src/market-estimate.js';
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

const evaluate = (notice, { models = [{ houseType: '084A', area: 84, price: 100000 }], data = [], overrides = {} } = {}) => evaluateLotto(notice, {
  config: { ...config, lotto: { ...config.lotto, ...overrides } },
  today,
  getModels: async () => models,
  getTrades: async () => data,
});

test('price rule: margin at or above 3억 is 로또', async () => {
  const result = await evaluate(apt(), { data: two(5, 2200) });
  assert.equal(result.status, STATUS.LOTTO);
  assert.equal(result.confidence, '중');
  assert.equal(result.estimate, 184800);
  // 보수 시세 184800(할인 0%). 184800 - 100000 - 옵션 1500 - 취득세 3300 (10억의 3.3%)
  assert.equal(result.margin, 80000);
  assert.ok(result.reason.includes('법정동'));
  assert.ok(result.reason.includes('안전 마진 8.0억'));
});

test('price rule: margin rate of 20% with a small margin is 로또', async () => {
  const result = await evaluate(apt(), {
    models: [{ houseType: '084A', area: 84, price: 30000 }],
    data: two(5, 600),
  });
  // 50400 - 30000 - 1500 - 330 = 18570, 분양가 대비 62%
  assert.equal(result.margin, 18570);
  assert.equal(result.status, STATUS.LOTTO);
  assert.equal(result.confidence, '중');
});

test('price rule: below both thresholds is 아님', async () => {
  const result = await evaluate(apt(), { data: trades(5, 1250) });
  assert.equal(result.status, STATUS.NOT);
  // 단지 1곳이라 할인하지 않는다. 105000 - 100000 - 1500 - 3300
  assert.equal(result.margin, 200);
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

test('flag trigger makes 로또 even when price says no, and records the price', async () => {
  const remainder = apt({ kind: 'remainder', houseSecd: '04' });
  const low = await evaluate(remainder, { data: trades(5, 1100) });
  assert.equal(low.status, STATUS.LOTTO);
  assert.equal(low.estimate, 92400);
  assert.ok(low.reason.includes('무순위'));
  // 92400 - 100000 - 1500 - 3300 = -12400. 조건형 로또는 마진이 음수여도 유지하고 근거에 함께 적는다.
  assert.equal(low.margin, -12400);
  assert.ok(low.reason.includes('안전 마진 -1.2억'));

  const noData = await evaluate(apt({ kind: 'remainder', houseSecd: '06' }), { data: [] });
  assert.equal(noData.status, STATUS.LOTTO);
  assert.equal(noData.estimate, null);
  assert.equal(noData.topPrice, 100000);
});

test('flag trigger survives data failures', async () => {
  const errors = [];
  const result = await evaluateLotto(apt({ kind: 'remainder', houseSecd: '04' }), {
    config,
    today,
    getModels: async () => { throw new Error('https://secret.test/?serviceKey=x'); },
    getTrades: async () => [],
    onError: (kind) => errors.push(kind),
  });
  assert.equal(result.status, STATUS.LOTTO);
  assert.deepEqual(errors, ['unexpected_error']);
});

test('config switches control each trigger', async () => {
  const data = trades(5, 1100);
  const off = await evaluate(apt({ kind: 'remainder', houseSecd: '04' }), { data, overrides: { includeRemainder: false } });
  assert.equal(off.status, STATUS.OUT_OF_SCOPE);

  const arbitrary = apt({ kind: 'arbitrary', houseSecd: '' });
  assert.equal((await evaluate(arbitrary, { data })).status, STATUS.OUT_OF_SCOPE);
  assert.equal((await evaluate(arbitrary, { data, overrides: { includeArbitrary: true } })).status, STATUS.LOTTO);

  const allOff = { includePriceCap: false, includePublicDistrict: false };
  const capped = apt({ flags: { priceCap: true, publicDistrict: false } });
  const district = apt({ flags: { priceCap: false, publicDistrict: true } });
  assert.equal((await evaluate(capped, { data, overrides: allOff })).status, STATUS.NOT);
  assert.equal((await evaluate(district, { data, overrides: allOff })).status, STATUS.NOT);
  assert.equal((await evaluate(capped, { data, overrides: { includePublicDistrict: false } })).status, STATUS.LOTTO);
  assert.equal((await evaluate(capped, { data, overrides: { includePriceCap: false } })).status, STATUS.NOT);
  assert.equal((await evaluate(district, { data, overrides: { includePriceCap: false } })).status, STATUS.LOTTO);
});

test('price cap and public district trigger 로또 by default', async () => {
  assert.equal(config.lotto.includePriceCap, true);
  assert.equal(config.lotto.includePublicDistrict, true);
  const data = trades(5, 1100);
  const capped = await evaluate(apt({ flags: { priceCap: true, publicDistrict: false } }), { data });
  assert.equal(capped.status, STATUS.LOTTO);
  assert.equal(capped.estimate, 92400);
  const district = await evaluate(apt({ flags: { priceCap: false, publicDistrict: true } }), { data: [] });
  assert.equal(district.status, STATUS.LOTTO);
  const plain = await evaluate(apt(), { data });
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

test('with no qualifying model the largest margin is recorded and the status is 아님', async () => {
  const result = await evaluate(apt(), {
    models: [
      { houseType: '120A', area: 120, price: 110000 },
      { houseType: '059A', area: 59, price: 55000 },
    ],
    data: [...trades(5, 1000, { area: 120, amount: 120000 }), ...trades(5, 1000, { area: 59, amount: 59000 })],
  });
  assert.equal(result.status, STATUS.NOT);
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
const best = (models, rows) => estimateBestMargin({ models, rows, subject, lotto: config.lotto, market, today });

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
  assert.equal(result.status, STATUS.NOT);
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

test('trigger with a confident non-negative margin is 로또 with the price text', async () => {
  // 109200 - 100000 - 1500 - 3300 = 4400. 가격 기준(3억, 20%)에는 못 미치지만 마진이 0 이상이다.
  for (const notice of [remainder(), capped()]) {
    const result = await evaluate(notice, { data: two(5, 1300) });
    assert.equal(result.confidence, '중');
    assert.equal(result.margin, 4400);
    assert.equal(result.status, STATUS.LOTTO);
    assert.ok(/^(수도권 무순위·잔여세대|분양가상한제 적용); 안전 마진 0\.4억/.test(result.reason), result.reason);
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

test('trigger with a 하 estimate or no estimate stays 로또', async () => {
  const weak = await evaluate(remainder(), { data: trades(5, 1100) });
  assert.equal(weak.confidence, '하');
  assert.ok(weak.margin < 0);
  assert.equal(weak.status, STATUS.LOTTO);
  assert.ok(weak.reason.startsWith('수도권 무순위·잔여세대; 안전 마진'));

  const none = await evaluate(capped(), { data: [] });
  assert.equal(none.estimate, null);
  assert.equal(none.status, STATUS.LOTTO);
  assert.equal(none.reason, '분양가상한제 적용');
});

test('불법행위 재공급 stays 로또 with a confident negative margin unless its price check is turned on', async () => {
  const resupply = apt({ kind: 'remainder', houseSecd: '06', name: '합성단지 재공급(14차)' });
  assert.equal(config.lotto.triggerPriceCheck.resupply, false);
  const result = await evaluate(resupply, { data: two(5, 1100) });
  assert.equal(result.confidence, '중');
  assert.equal(result.margin, -12400);
  assert.equal(result.status, STATUS.LOTTO);
  assert.ok(result.reason.startsWith('수도권 불법행위 재공급; '));

  const checked = { triggerPriceCheck: { ...config.lotto.triggerPriceCheck, resupply: true } };
  assert.equal((await evaluate(resupply, { data: two(5, 1100), overrides: checked })).status, STATUS.NOT);
  // 반대로 끄면 예전처럼 시세와 무관하게 로또다.
  const unchecked = { triggerPriceCheck: { ...config.lotto.triggerPriceCheck, remainder: false } };
  assert.equal((await evaluate(remainder(), { data: two(5, 1100), overrides: unchecked })).status, STATUS.LOTTO);
});

test('repeated 무순위 rounds need a confident estimate', async () => {
  assert.equal(config.lotto.remainderMaxRound, 3);
  const repeated = remainder('합성단지 무순위(사후)(14차)');

  const weak = await evaluate(repeated, { data: trades(5, 1100) });
  assert.equal(weak.confidence, '하');
  assert.equal(weak.status, STATUS.NOT);
  assert.equal(weak.repeatedRound, 14);
  assert.ok(weak.reason.startsWith('수도권 무순위·잔여세대 14차 반복 공급; 안전 마진 -1.2억'), weak.reason);
  assert.ok(weak.shortReason.startsWith('수도권 무순위·잔여세대 14차 반복 공급; 안전 마진'));

  const none = await evaluate(repeated, { data: [] });
  assert.equal(none.status, STATUS.NOT);
  assert.equal(none.reason, '수도권 무순위·잔여세대 14차 반복 공급; 시세 추정 없음(실거래 표본 부족)');
  assert.equal(none.shortReason, '수도권 무순위·잔여세대 14차 반복 공급; 시세 추정 없음');

  // 가격 기준을 넘으면 그대로 로또다. 신뢰할 수 있는 양수 마진도 로또다.
  const rich = await evaluate(repeated, { data: two(5, 2200) });
  assert.equal(rich.confidence, '중');
  assert.equal(rich.margin, 80000);
  assert.equal(rich.status, STATUS.LOTTO);
  assert.equal((await evaluate(repeated, { data: two(5, 1300) })).status, STATUS.LOTTO);
  assert.equal((await evaluate(repeated, { data: two(5, 1100) })).status, STATUS.NOT);

  // 기준 차수 미만이거나 끄면 신뢰도 하에서도 로또다.
  assert.equal((await evaluate(remainder('합성단지 무순위(2차)'), { data: trades(5, 1100) })).status, STATUS.LOTTO);
  assert.equal((await evaluate(repeated, { data: [], overrides: { remainderMaxRound: null } })).status, STATUS.LOTTO);
});

test('an unknown round keeps the 하 or no-estimate rule', async () => {
  for (const name of ['합성단지 무순위', '합성단지(14차)', '', undefined]) {
    const weak = await evaluate(remainder(name), { data: trades(5, 1100) });
    assert.equal(weak.status, STATUS.LOTTO, String(name));
    assert.equal(weak.repeatedRound, undefined);
    assert.equal((await evaluate(remainder(name), { data: [] })).status, STATUS.LOTTO, String(name));
  }
});

test('parseRemainderRound reads the round only after 무순위, 사후 or 잔여', () => {
  assert.equal(parseRemainderRound('합성단지 무순위(사후)(14차)'), 14);
  assert.equal(parseRemainderRound('합성단지 사후무순위 3차'), 3);
  assert.equal(parseRemainderRound('합성단지 무순위 14 차'), 14);
  assert.equal(parseRemainderRound('합성단지 잔여세대(5차)'), 5);
  assert.equal(parseRemainderRound('합성단지 2차 무순위(사후)(3차)'), 3);
  // 키워드 없는 차수는 단지 차수일 수 있어 모른다.
  assert.equal(parseRemainderRound('합성단지(2차)'), null);
  assert.equal(parseRemainderRound('합성단지 2차 무순위(사후)'), null);
  assert.equal(parseRemainderRound('합성단지 무순위 2026년 1차'), null);
  assert.equal(parseRemainderRound('합성단지 무순위(0차)'), null);
  assert.equal(parseRemainderRound(''), null);
  assert.equal(parseRemainderRound(null), null);
  assert.equal(parseRemainderRound(undefined), null);
});

test('a previous 로또 is dropped by a confident no-advantage or a repeated round', async () => {
  const confident = await evaluate(remainder(), { data: two(5, 1100) });
  assert.equal(keepPreviousLotto(confident, STATUS.LOTTO).status, STATUS.NOT);

  // 반복 공급의 아님은 신뢰도 하 추정이 있어도 이전 로또를 유지하지 않는다. 추정이 없을 때와 같다.
  const weakRound = await evaluate(remainder('합성단지 무순위(사후)(14차)'), { data: trades(5, 1100) });
  assert.equal(weakRound.confidence, '하');
  assert.equal(keepPreviousLotto(weakRound, STATUS.LOTTO).status, STATUS.NOT);
  const noneRound = await evaluate(remainder('합성단지 무순위(사후)(14차)'), { data: [] });
  assert.equal(keepPreviousLotto(noneRound, STATUS.LOTTO).status, STATUS.NOT);

  // 가격 기준만 보는 공고의 신뢰도 하 아님은 예전처럼 이전 로또를 유지한다.
  const weakPlain = await evaluate(apt(), { data: trades(5, 1100) });
  assert.equal(weakPlain.status, STATUS.NOT);
  assert.equal(keepPreviousLotto(weakPlain, STATUS.LOTTO).status, STATUS.LOTTO);
});
