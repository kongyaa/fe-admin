import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { STATUS, estimateBestGain, evaluateLotto, keepPreviousLotto } from '../src/lotto.js';
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
  buildYear: 2022,
  ...extra,
}));

const evaluate = (notice, { models = [{ houseType: '084A', area: 84, price: 100000 }], data = [], overrides = {} } = {}) => evaluateLotto(notice, {
  config: { ...config, lotto: { ...config.lotto, ...overrides } },
  today,
  getModels: async () => models,
  getTrades: async () => data,
});

test('price rule: gain at or above 3억 is 로또', async () => {
  const result = await evaluate(apt(), { data: trades(5, 1600) });
  assert.equal(result.status, STATUS.LOTTO);
  assert.equal(result.estimate, 134400);
  assert.equal(result.gain, 34400);
  assert.ok(result.reason.includes('법정동'));
});

test('price rule: discount of 20% with a small gain is 로또', async () => {
  const result = await evaluate(apt(), {
    models: [{ houseType: '084A', area: 84, price: 30000 }],
    data: trades(5, 500),
  });
  assert.equal(result.gain, 12000);
  assert.equal(result.status, STATUS.LOTTO);
});

test('price rule: below both thresholds is 아님', async () => {
  const result = await evaluate(apt(), { data: trades(5, 1250) });
  assert.equal(result.status, STATUS.NOT);
  assert.equal(result.gain, 5000);
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

test('any qualifying model makes 로또 and the largest qualifying gain is recorded', async () => {
  const large = trades(5, 1000, { area: 120, amount: 120000 });
  const small = trades(5, 1000, { area: 59, amount: 59000 });
  const small2 = { houseType: '059B', area: 59, price: 45000 };
  const result = await evaluate(apt(), {
    models: [
      { houseType: '120A', area: 120, price: 100000 },
      { houseType: '059A', area: 59, price: 40000 },
      small2,
    ],
    data: [...large, ...small],
  });
  assert.equal(result.status, STATUS.LOTTO);
  assert.equal(result.topPrice, 40000);
  assert.equal(result.estimate, 59000);
  assert.equal(result.gain, 19000);
});

test('with no qualifying model the largest gain is recorded and the status is 아님', async () => {
  const result = await evaluate(apt(), {
    models: [
      { houseType: '120A', area: 120, price: 110000 },
      { houseType: '059A', area: 59, price: 55000 },
    ],
    data: [...trades(5, 1000, { area: 120, amount: 120000 }), ...trades(5, 1000, { area: 59, amount: 59000 })],
  });
  assert.equal(result.status, STATUS.NOT);
  assert.equal(result.gain, 10000);
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

test('scope prefers 법정동, falls back to 시군구, and prefers new builds when enough', () => {
  const lotto = config.lotto;
  const models = [{ houseType: '084A', area: 84, price: 100000 }];
  const dong = trades(5, 1000);
  const other = trades(5, 2000, { umd: '삼성동' });

  const first = estimateBestGain({ models, trades: [...dong, ...other], umd: '역삼동', lotto, today });
  assert.equal(first.scope, '법정동 신축');
  assert.equal(first.estimate, 84000);

  const widened = estimateBestGain({ models, trades: [...trades(2, 1000), ...other], umd: '역삼동', lotto, today });
  assert.ok(widened.scope.startsWith('시군구'));
  assert.equal(widened.samples, 7);

  const oldTrades = trades(5, 1000, { buildYear: 1990 });
  const mixedFew = estimateBestGain({ models, trades: [...oldTrades, ...trades(4, 3000)], umd: '역삼동', lotto, today });
  assert.equal(mixedFew.scope, '법정동');
  assert.equal(mixedFew.samples, 9);

  const mixedMany = estimateBestGain({ models, trades: [...oldTrades, ...trades(5, 3000)], umd: '역삼동', lotto, today });
  assert.equal(mixedMany.scope, '법정동 신축');
  assert.equal(mixedMany.estimate, 252000);
});

test('area tolerance filters trades and the largest gain model is kept', () => {
  const lotto = config.lotto;
  const far = trades(5, 3000, { area: 120, amount: 3000 * 120 });
  assert.equal(estimateBestGain({ models: [{ area: 84, price: 1 }], trades: far, umd: '역삼동', lotto, today }), null);

  const best = estimateBestGain({
    models: [
      { houseType: 'small', area: 84, price: 120000 },
      { houseType: 'cheap', area: 84, price: 90000 },
      { houseType: 'invalid', area: null, price: 1 },
    ],
    trades: trades(5, 1250),
    umd: '역삼동',
    lotto,
    today,
  });
  assert.equal(best.houseType, 'cheap');
  assert.equal(best.gain, 15000);
});

test('cancelled trades are excluded from the estimate', async () => {
  const row = (amount, cancelled) => `<item><dealAmount>${amount}</dealAmount><excluUseAr>84</excluUseAr><umdNm>역삼동</umdNm><buildYear>2022</buildYear><cdealType>${cancelled}</cdealType></item>`;
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
