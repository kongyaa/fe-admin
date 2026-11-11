import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AppError } from '../src/util.js';
import { STATUS, badTriggerConfig, evaluateLotto, keepPreviousLotto, parseRemainderRound } from '../src/lotto.js';
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
// 분양가 10억 기준 단지 1곳(신뢰도 하)의 마진율: trades(5, 1100)은 -12.4%, trades(5, 1200)은 -4%다.
// 조건형 공고는 신뢰도 하 마진율이 lotto.lowConfidenceMinMarginRate(-5%) 이하면 아님이라, 하여도 로또인 경우는 1200을 쓴다.

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
  const low = await evaluate(remainder, { data: trades(5, 1200) });
  assert.equal(low.status, STATUS.LOTTO);
  assert.equal(low.estimate, 100800);
  assert.ok(low.reason.includes('무순위'));
  // 100800 - 100000 - 1500 - 3300 = -4000(마진율 -4%). 조건형 로또는 신뢰도 하 추정의 마진이 조금 음수여도 유지하고 근거에 함께 적는다.
  assert.equal(low.margin, -4000);
  assert.ok(low.reason.includes('안전 마진 -0.4억'));

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
  const data = trades(5, 1200);
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
  const data = trades(5, 1200);
  const capped = await evaluate(apt({ flags: { priceCap: true, publicDistrict: false } }), { data });
  assert.equal(capped.status, STATUS.LOTTO);
  assert.equal(capped.estimate, 100800);
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

test('trigger with a mildly negative 하 estimate or no estimate stays 로또', async () => {
  const weak = await evaluate(remainder(), { data: trades(5, 1200) });
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

  const weak = await evaluate(repeated, { data: trades(5, 1200) });
  assert.equal(weak.confidence, '하');
  assert.equal(weak.status, STATUS.NOT);
  assert.equal(weak.repeatedRound, 14);
  assert.ok(weak.reason.startsWith('수도권 무순위·잔여세대 14차 반복 공급; 안전 마진 -0.4억'), weak.reason);
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
  assert.equal((await evaluate(remainder('합성단지 무순위(2차)'), { data: trades(5, 1200) })).status, STATUS.LOTTO);
  assert.equal((await evaluate(repeated, { data: [], overrides: { remainderMaxRound: null } })).status, STATUS.LOTTO);
});

test('an unknown round keeps the 하 or no-estimate rule', async () => {
  for (const name of ['합성단지 무순위', '합성단지 14차', '', undefined]) {
    const weak = await evaluate(remainder(name), { data: trades(5, 1200) });
    assert.equal(weak.status, STATUS.LOTTO, String(name));
    assert.equal(weak.repeatedRound, undefined);
    assert.equal((await evaluate(remainder(name), { data: [] })).status, STATUS.LOTTO, String(name));
  }
});

test('a trailing (N차) is read as the round, and a low one keeps the outcome', async () => {
  // 청약홈 공고문 파일명처럼 키워드 없이 이름 끝 괄호에 차수가 있다.
  const repeated = await evaluate(remainder('합성단지(14차)'), { data: trades(5, 1200) });
  assert.equal(repeated.status, STATUS.NOT);
  assert.equal(repeated.repeatedRound, 14);
  assert.ok(repeated.reason.startsWith('수도권 무순위·잔여세대 14차 반복 공급; '));

  // 2차 무순위(실제 사례: 2차 단지가 없는 단일 단지의 "…(2차)")는 기준(3차) 미만이라 예전처럼 로또다.
  assert.equal(parseRemainderRound('합성단지(2차)'), 2);
  for (const data of [trades(5, 1200), []]) {
    const phase = await evaluate(remainder('합성단지(2차)'), { data });
    assert.equal(phase.status, STATUS.LOTTO);
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

  // 반복 공급. 84㎡ 중: 109200 - 104800 = 4400. 59㎡ 하: 59000 - 50000 - 1500 - 550 = 6950(가격 기준 미만).
  const gain = await evaluate(remainder('합성단지(14차)'), { models: mixedModels(50000), data: mixedData(1300) });
  assert.equal(gain.confidence, '중');
  assert.equal(gain.margin, 4400);
  assert.equal(gain.status, STATUS.LOTTO);
});

test('a repeated round with a 하 estimate that meets the price rule is 아님, not 로또 or 확인 필요', async () => {
  // 예전에는 가격 기준을 넘는 하 추정이 반복 공급이어도 로또였다. 이제 그 추정은 확인 필요가 되는데, 반복 공급이면 아님이 먼저다.
  const result = await evaluate(remainder('합성단지 무순위(사후)(14차)'), { data: trades(5, 2200) });
  assert.equal(result.confidence, '하');
  assert.equal(result.margin, 80000);
  assert.equal(result.status, STATUS.NOT);
  assert.equal(result.repeatedRound, 14);
  assert.ok(result.reason.startsWith('수도권 무순위·잔여세대 14차 반복 공급; 안전 마진 8.0억'), result.reason);
  // 같은 추정이 반복 공급이 아니면 확인 필요다.
  assert.equal((await evaluate(remainder('합성단지 무순위(사후)(2차)'), { data: trades(5, 2200) })).status, STATUS.CHECK);
});

// 59㎡는 단지 1곳(신뢰도 하): 88500 - 30000 - 1500 - 330 = 56670(가격 기준 넘음). 84㎡는 단지 2곳(신뢰도 중): -12400.
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

  // 신뢰도 중 이상이면서 기준을 넘는 주택형은 어느 쪽이든 먼저다.
  const qualifying = [...two(5, 2200), ...trades(5, 1500, { area: 59, amount: 88500, jibun: 'b1' })];
  assert.equal(best(richWeakModels, qualifying).houseType, '084A');
  assert.equal(best(richWeakModels, qualifying, { preferConfident: true }).houseType, '084A');
  // 신뢰도 중 이상 주택형이 없으면 전체에서 마진이 가장 큰 것이다.
  assert.equal(best(richWeakModels, trades(5, 1500, { area: 59, amount: 88500, jibun: 'b1' }), { preferConfident: true }).houseType, '059A');
});

test('a non-trigger APT keeps the old selection, so a stored 로또 is kept by the 하 guard', async () => {
  const result = await evaluate(apt(), { models: richWeakModels, data: richWeakData });
  assert.equal(result.confidence, '하');
  assert.equal(result.margin, 56670);
  assert.equal(result.status, STATUS.NOT);
  assert.ok(result.reason.startsWith('가격 기준은 넘지만 추정 신뢰도가 하라 로또로 보지 않음'));
  assert.equal(keepPreviousLotto(result, STATUS.LOTTO).status, STATUS.LOTTO);
});

test('a trigger with a 하 type meeting the rule and a 중 type with a loss is 아님', async () => {
  const result = await evaluate(remainder(), { models: richWeakModels, data: richWeakData });
  assert.equal(result.confidence, '중');
  assert.equal(result.margin, -12400);
  assert.equal(result.status, STATUS.NOT);
  assert.ok(result.reason.startsWith('수도권 무순위·잔여세대 해당이나 시세 대비 이점 없음; '));
  assert.equal(keepPreviousLotto(result, STATUS.LOTTO).status, STATUS.NOT);
  // 가격 확인을 끈 조건은 예전 순서와 예전 판정이다.
  const unchecked = { triggerPriceCheck: { ...config.lotto.triggerPriceCheck, remainder: false } };
  const old = await evaluate(remainder(), { models: richWeakModels, data: richWeakData, overrides: unchecked });
  assert.equal(old.status, STATUS.LOTTO);
  assert.equal(old.margin, 56670);
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
  for (const remainderMaxRound of [0, -1, 2.5, '3']) {
    const { result, soft } = await run(repeated, [], { remainderMaxRound });
    assert.equal(result.status, STATUS.LOTTO, String(remainderMaxRound));
    assert.deepEqual(soft, ['bad_trigger_config'], String(remainderMaxRound));
  }
  for (const triggerPriceCheck of [true, 'remainder', ['remainder'], null]) {
    const { result, soft } = await run(remainder(), two(5, 1100), { triggerPriceCheck });
    assert.equal(result.status, STATUS.LOTTO, JSON.stringify(triggerPriceCheck));
    assert.deepEqual(soft, ['bad_trigger_config'], JSON.stringify(triggerPriceCheck));
  }
  // 끄는 값(null)과 true가 아닌 키 값은 형식 오류가 아니다. 빠진 설정도 오류가 아니다.
  const { lotto } = config;
  const { triggerPriceCheck: _checks, remainderMaxRound: _round, ...withoutKeys } = lotto;
  // null은 반복 공급 규칙만 끈다(추정이 없는 14차가 로또). 'yes'는 가격 확인을 끈다(중 음수 마진도 로또).
  for (const [overrides, data] of [[{ remainderMaxRound: null }, []], [{ triggerPriceCheck: { remainder: 'yes' } }, two(5, 1100)]]) {
    const { result, soft } = await run(repeated, data, overrides);
    assert.equal(result.status, STATUS.LOTTO, JSON.stringify(overrides));
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

test('a previous 로또 is dropped by a confident no-advantage or a repeated round', async () => {
  const confident = await evaluate(remainder(), { data: two(5, 1100) });
  assert.equal(keepPreviousLotto(confident, STATUS.LOTTO).status, STATUS.NOT);

  // 반복 공급의 아님은 신뢰도 하 추정이 있어도 이전 로또를 유지하지 않는다. 추정이 없을 때와 같다.
  const weakRound = await evaluate(remainder('합성단지 무순위(사후)(14차)'), { data: trades(5, 1200) });
  assert.equal(weakRound.confidence, '하');
  assert.equal(keepPreviousLotto(weakRound, STATUS.LOTTO).status, STATUS.NOT);
  const noneRound = await evaluate(remainder('합성단지 무순위(사후)(14차)'), { data: [] });
  assert.equal(keepPreviousLotto(noneRound, STATUS.LOTTO).status, STATUS.NOT);

  // 가격 기준만 보는 공고의 신뢰도 하 아님은 예전처럼 이전 로또를 유지한다.
  const weakPlain = await evaluate(apt(), { data: trades(5, 1100) });
  assert.equal(weakPlain.status, STATUS.NOT);
  assert.equal(keepPreviousLotto(weakPlain, STATUS.LOTTO).status, STATUS.LOTTO);
});

// 신뢰도 하(단지 1곳) 추정의 마진율을 정해 둔 거래. 분양가 10억이라 마진 = amount - 104800, 마진율 = 마진 / 100000.
const weakAt = (marginManwon) => trades(5, 0, { amount: 104800 + marginManwon });

test('a trigger with a 하 estimate at or below the margin-rate floor is 아님', async () => {
  assert.equal(config.lotto.lowConfidenceMinMarginRate, -0.05);
  for (const notice of [remainder(), capped(), apt({ flags: { priceCap: false, publicDistrict: true } })]) {
    const result = await evaluate(notice, { data: weakAt(-13000) });
    assert.equal(result.confidence, '하');
    assert.equal(result.marginRate, -0.13);
    assert.equal(result.status, STATUS.NOT);
    assert.equal(result.lowConfidenceNegative, true);
    assert.equal(result.repeatedRound, undefined);
    assert.ok(/^(수도권 무순위·잔여세대|분양가상한제 적용|공공주택지구) 해당이나 시세 대비 이점 없음\(신뢰도 하, 마진율 ≤ -5%\); 안전 마진 -1\.3억/.test(result.reason), result.reason);
    assert.ok(/ 해당이나 시세 이점 없음\(신뢰도 하, 마진율 ≤ -5%\); 안전 마진 -1\.3억, 마진율 -13%\(분양가 대비\) \(084A, 신뢰도 하\)$/.test(result.shortReason), result.shortReason);
  }

  // 경계(-5%)는 포함한다.
  const edge = await evaluate(remainder(), { data: weakAt(-5000) });
  assert.equal(edge.marginRate, -0.05);
  assert.equal(edge.status, STATUS.NOT);
  assert.equal(edge.lowConfidenceNegative, true);

  // 기준보다 덜 음수이거나 0이면 예전처럼 놓치지 않게 로또다. 양수는 확인 필요다(아래 테스트).
  for (const margin of [-2900, 0]) {
    const result = await evaluate(remainder(), { data: weakAt(margin) });
    assert.equal(result.confidence, '하');
    assert.equal(result.status, STATUS.LOTTO, String(margin));
    assert.equal(result.lowConfidenceNegative, undefined);
    assert.ok(result.reason.startsWith('수도권 무순위·잔여세대; 안전 마진'), result.reason);
  }
});

test('the 하 margin-rate floor skips 불법행위 재공급, unchecked triggers and plain notices', async () => {
  const resupply = await evaluate(apt({ kind: 'remainder', houseSecd: '06' }), { data: weakAt(-13000) });
  assert.equal(resupply.confidence, '하');
  assert.equal(resupply.status, STATUS.LOTTO);
  assert.equal(resupply.lowConfidenceNegative, undefined);
  assert.ok(resupply.reason.startsWith('수도권 불법행위 재공급; '));

  const unchecked = { triggerPriceCheck: { ...config.lotto.triggerPriceCheck, remainder: false } };
  assert.equal((await evaluate(remainder(), { data: weakAt(-13000), overrides: unchecked })).status, STATUS.LOTTO);

  // 조건 없는 공고는 예전과 같은 아님이고 플래그가 없어 이전 로또를 유지한다.
  const plain = await evaluate(apt(), { data: weakAt(-13000) });
  assert.equal(plain.status, STATUS.NOT);
  assert.equal(plain.lowConfidenceNegative, undefined);
  assert.equal(keepPreviousLotto(plain, STATUS.LOTTO).status, STATUS.LOTTO);
});

test('the 하 margin-rate floor comes before the repeated-round rule', async () => {
  // 가격 기준을 넘는 하 추정도 이제 로또가 아니라 확인 필요다(마진이 양수인 하 추정).
  const rich = await evaluate(remainder(), { data: trades(5, 2200) });
  assert.equal(rich.confidence, '하');
  assert.equal(rich.status, STATUS.CHECK);

  // 반복 공급은 마진율이 기준보다 덜 음수여도 차수 규칙으로 아님이다.
  const repeated = remainder('합성단지 무순위(사후)(14차)');
  const mild = await evaluate(repeated, { data: weakAt(-2000) });
  assert.equal(mild.marginRate, -0.02);
  assert.equal(mild.status, STATUS.NOT);
  assert.equal(mild.repeatedRound, 14);
  assert.equal(mild.lowConfidenceNegative, undefined);
  assert.ok(mild.reason.startsWith('수도권 무순위·잔여세대 14차 반복 공급; '), mild.reason);

  // 뚜렷한 음수면 마진율 규칙이 먼저라 차수 대신 마진율로 아님이다.
  const clear = await evaluate(repeated, { data: weakAt(-13000) });
  assert.equal(clear.status, STATUS.NOT);
  assert.equal(clear.lowConfidenceNegative, true);
  assert.equal(clear.repeatedRound, undefined);
});

test('a previous 로또 is dropped by a clearly negative 하 trigger estimate', async () => {
  const result = await evaluate(remainder(), { data: weakAt(-13000) });
  assert.equal(result.lowConfidenceNegative, true);
  const kept = keepPreviousLotto(result, STATUS.LOTTO);
  assert.equal(kept.status, STATUS.NOT);
  assert.equal(kept.reason, result.reason);
  assert.equal(keepPreviousLotto({ status: STATUS.NOT, confidence: '하', lowConfidenceNegative: true }, STATUS.LOTTO).status, STATUS.NOT);
  // 플래그가 없는 하 아님은 예전처럼 유지한다.
  assert.equal(keepPreviousLotto({ status: STATUS.NOT, confidence: '하', reason: 'x' }, STATUS.LOTTO).status, STATUS.LOTTO);
});

test('the 하 margin-rate floor is off when missing or null, and a bad value is off and reported', async () => {
  const run = async (overrides, lotto = { ...config.lotto, ...overrides }) => {
    const soft = [];
    const result = await evaluateLotto(remainder(), {
      config: { ...config, lotto },
      today,
      getModels: async () => [{ houseType: '084A', area: 84, price: 100000 }],
      getTrades: async () => weakAt(-13000),
      onSoftOnce: (kind) => soft.push(kind),
    });
    return { result, soft };
  };
  const { lowConfidenceMinMarginRate: _floor, ...withoutFloor } = config.lotto;
  for (const [label, outcome] of [['null', await run({ lowConfidenceMinMarginRate: null })], ['missing', await run({}, withoutFloor)]]) {
    assert.equal(outcome.result.status, STATUS.LOTTO, label);
    assert.equal(outcome.result.lowConfidenceNegative, undefined, label);
    assert.deepEqual(outcome.soft, [], label);
    assert.equal(badTriggerConfig(label === 'null' ? { lowConfidenceMinMarginRate: null } : withoutFloor), false, label);
  }
  for (const value of [0.1, '-0.05', true, Number.NaN, Number.NEGATIVE_INFINITY, [-0.05], {}]) {
    const { result, soft } = await run({ lowConfidenceMinMarginRate: value });
    assert.equal(result.status, STATUS.LOTTO, String(value));
    assert.deepEqual(soft, ['bad_trigger_config'], String(value));
    assert.equal(badTriggerConfig({ lowConfidenceMinMarginRate: value }), true, String(value));
  }
  // 0 이하의 수는 쓸 수 있다. 0이면 하 추정의 모든 음수 마진이 아님이다.
  assert.equal(badTriggerConfig({ lowConfidenceMinMarginRate: 0 }), false);
  assert.equal(badTriggerConfig(config.lotto), false);
  const zero = await evaluate(remainder(), { data: weakAt(-1000), overrides: { lowConfidenceMinMarginRate: 0 } });
  assert.equal(zero.status, STATUS.NOT);
  assert.ok(zero.reason.includes('(신뢰도 하, 마진율 ≤ 0%)'), zero.reason);
  // 설정의 비율이 근거에 그대로 적힌다.
  const looser = await evaluate(remainder(), { data: weakAt(-13000), overrides: { lowConfidenceMinMarginRate: -0.125 } });
  assert.equal(looser.status, STATUS.NOT);
  assert.ok(looser.reason.includes('(신뢰도 하, 마진율 ≤ -12.5%)'), looser.reason);
});

// 주택형이 모두 신뢰도 하(각각 단지 1곳)인 조건형 공고. 059A는 5억, 084A는 15억이다.
// 059A: 마진 = amount - 50000 - 1500 - 550, 084A: 마진 = amount - 150000 - 1500 - 4950.
const weakPair = (amount59, amount84) => [
  ...trades(5, 0, { area: 59, amount: amount59, jibun: 'b1' }),
  ...trades(5, 0, { area: 84, amount: amount84, jibun: 'a1' }),
];
const pairModels = [{ houseType: '059A', area: 59, price: 50000 }, { houseType: '084A', area: 84, price: 150000 }];

test('with only 하 types a price-checked trigger looks at the best margin rate, not the largest margin', async () => {
  // 059A -3020(-6.04%), 084A -4500(-3%). 금액은 059A가 크지만 마진율은 084A가 높다.
  const mild = await evaluate(remainder(), { models: pairModels, data: weakPair(49030, 151950) });
  assert.equal(mild.confidence, '하');
  assert.equal(mild.margin, -4500);
  assert.equal(mild.marginRate, -0.03);
  assert.ok(mild.reason.includes('(084A, 신뢰도 하)'), mild.reason);
  assert.equal(mild.status, STATUS.LOTTO);

  // 둘 다 -5% 이하면 아님이다. 084A -9000(-6%).
  const clear = await evaluate(remainder(), { models: pairModels, data: weakPair(49030, 147450) });
  assert.equal(clear.marginRate, -0.06);
  assert.equal(clear.status, STATUS.NOT);
  assert.equal(clear.lowConfidenceNegative, true);

  // 조건 없는 공고는 예전처럼 마진 금액이 큰 059A다.
  const plain = await evaluate(apt(), { models: pairModels, data: weakPair(49030, 151950) });
  assert.equal(plain.margin, -3020);
  assert.ok(plain.reason.includes('(059A, 신뢰도 하)'), plain.reason);
});

test('estimateBestMargin breaks an all-하 tie by margin rate only when asked, after the price rule', () => {
  const data = weakPair(49030, 151950);
  assert.equal(best(pairModels, data).houseType, '059A');
  const preferred = best(pairModels, data, { preferConfident: true });
  assert.equal(preferred.houseType, '084A');
  assert.equal(preferred.confidence, '하');

  // 가격 기준을 넘는 하 주택형이 마진율이 더 높은 다른 하 주택형보다 먼저다.
  // 084A(20억): 240000 - 200000 - 1500 - 6600 = 31900(3억 넘음, 마진율 약 16%). 059A(3억): 36800 - 30000 - 1500 - 330 = 4970(약 16.6%).
  const richModels = [{ houseType: '059A', area: 59, price: 30000 }, { houseType: '084A', area: 84, price: 200000 }];
  const richData = [
    ...trades(5, 0, { area: 59, amount: 36800, jibun: 'b1' }),
    ...trades(5, 0, { area: 84, amount: 240000, jibun: 'a1' }),
  ];
  const rich = best(richModels, richData, { preferConfident: true });
  assert.equal(rich.houseType, '084A');
  assert.equal(rich.margin, 31900);
  // 059A의 마진율이 더 높아도 가격 기준을 넘는 084A가 먼저다.
  assert.ok(rich.marginRate < 4970 / 30000);
});

test('a repeated round still picks the 하 type that meets the price rule, and the result is 아님', async () => {
  const richModels = [{ houseType: '059A', area: 59, price: 30000 }, { houseType: '084A', area: 84, price: 200000 }];
  const richData = [
    ...trades(5, 0, { area: 59, amount: 36800, jibun: 'b1' }),
    ...trades(5, 0, { area: 84, amount: 240000, jibun: 'a1' }),
  ];
  const result = await evaluate(remainder('합성단지 무순위(사후)(14차)'), { models: richModels, data: richData });
  assert.equal(result.confidence, '하');
  assert.equal(result.margin, 31900);
  // 주택형 선택은 그대로다. 상태는 하 추정이라 확인 필요가 될 것을 반복 공급이 아님으로 만든다.
  assert.equal(result.status, STATUS.NOT);
  assert.equal(result.repeatedRound, 14);
});

// ---- 확인 필요(STATUS.CHECK): 조건에는 해당하나 시세 근거가 약한 조건형 후보 ----

// 신뢰도 중(단지 2곳) 추정의 안전 마진을 정해 둔 거래. 분양가 10억이라 마진 = amount - 104800, 마진율 = 마진 / 100000.
const confidentAt = (marginManwon) => two(5, 0, { amount: 104800 + marginManwon });
const district = () => apt({ flags: { priceCap: false, publicDistrict: true } });

// 읍·면 주소인데 같은 읍·면 단지가 없어 시군구(다산동 단지 4곳)로 넓힌 추정. 신뢰도 하이고 마진율은 +27.5%다.
const namyangju = () => apt({ kind: 'remainder', houseSecd: '04', name: '합성단지 무순위', region: '경기', address: '경기도 남양주시 오남읍 양지리 1' });
const widenedData = () => ['d1', 'd2', 'd3', 'd4'].flatMap((jibun) => trades(5, 0, { umd: '다산동', jibun, amount: 132300 }));

test('config has the minimum trigger margin rate of 3%', () => {
  assert.equal(config.lotto.triggerMinMarginRate, 0.03);
  assert.equal(STATUS.CHECK, '확인 필요');
  assert.equal(badTriggerConfig(config.lotto), false);
});

test('a confident trigger with a margin rate under 3% is 확인 필요, at or above is 로또', async () => {
  // 신뢰도 중, 마진 +700만원(분양가 10억의 +0.7%)은 추정 오차 안이다.
  for (const notice of [remainder(), capped(), district()]) {
    const thin = await evaluate(notice, { data: confidentAt(700) });
    assert.equal(thin.confidence, '중');
    assert.equal(thin.margin, 700);
    assert.equal(thin.marginRate, 0.007);
    assert.equal(thin.status, STATUS.CHECK);
    assert.ok(/^(수도권 무순위·잔여세대|분양가상한제 적용|공공주택지구) 해당이나 마진이 근소함\(마진율 0\.7% < 3%\); 안전 마진 0\.1억, 마진율 1%\(분양가 대비\) \(084A, 신뢰도 중\); /.test(thin.reason), thin.reason);
    assert.ok(thin.shortReason.endsWith('(마진율 0.7% < 3%); 안전 마진 0.1억, 마진율 1%(분양가 대비) (084A, 신뢰도 중)'), thin.shortReason);
    assert.ok(/^(수도권 무순위·잔여세대|분양가상한제 적용|공공주택지구) 해당이나 마진이 근소함\(최소 3% 미만\)$/.test(thin.checkNote), thin.checkNote);
  }
  // 마진이 정확히 0이어도 확인 필요다(0 이상이고 3% 미만).
  assert.equal((await evaluate(remainder(), { data: confidentAt(0) })).status, STATUS.CHECK);
  assert.equal((await evaluate(remainder(), { data: confidentAt(2999) })).status, STATUS.CHECK);
  // 경계(3%)는 로또다. 그 위도 로또다.
  const edge = await evaluate(remainder(), { data: confidentAt(3000) });
  assert.equal(edge.marginRate, 0.03);
  assert.equal(edge.status, STATUS.LOTTO);
  assert.equal(edge.checkNote, undefined);
  assert.equal((await evaluate(remainder(), { data: confidentAt(3001) })).status, STATUS.LOTTO);
  assert.equal((await evaluate(remainder(), { data: confidentAt(5000) })).status, STATUS.LOTTO);
  // 음수 마진은 그대로 아님이다.
  const negative = await evaluate(remainder(), { data: confidentAt(-100) });
  assert.equal(negative.status, STATUS.NOT);
  assert.ok(negative.reason.startsWith('수도권 무순위·잔여세대 해당이나 시세 대비 이점 없음; '), negative.reason);
  assert.equal(negative.lowConfidenceNegative, undefined);
});

test('a 하 trigger estimate with a positive margin is 확인 필요, even when it meets the price rule', async () => {
  // 마진율 +10%: 가격 기준(3억, 20%) 미만이다.
  const mild = await evaluate(remainder(), { data: weakAt(10000) });
  assert.equal(mild.confidence, '하');
  assert.equal(mild.marginRate, 0.1);
  assert.equal(mild.status, STATUS.CHECK);
  assert.ok(mild.reason.startsWith('수도권 무순위·잔여세대 해당이나 시세 근거가 약함(신뢰도 하); 안전 마진 1.0억'), mild.reason);
  assert.ok(mild.shortReason.endsWith('시세 근거가 약함(신뢰도 하); 안전 마진 1.0억, 마진율 10%(분양가 대비) (084A, 신뢰도 하)'), mild.shortReason);
  assert.equal(mild.checkNote, '수도권 무순위·잔여세대 해당이나 시세 근거가 약함');
  // 가격 기준을 넘어도(마진율 +27.5%는 20% 이상) 확인 필요다. 비교 범위를 넓히지 않았으면 범위 말은 없다.
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

test('the other 하 rules are unchanged: a mild negative is 로또, a clear negative is 아님, no estimate is 로또', async () => {
  // 마진율 -2%: 놓치지 않게 로또다. 반복 공급이면 차수 규칙으로 아님이다.
  const mild = await evaluate(remainder(), { data: weakAt(-2000) });
  assert.equal(mild.confidence, '하');
  assert.equal(mild.marginRate, -0.02);
  assert.equal(mild.status, STATUS.LOTTO);
  assert.equal((await evaluate(remainder('합성단지 무순위(사후)(14차)'), { data: weakAt(-2000) })).status, STATUS.NOT);
  // 마진율 -5% 이하는 아님이다.
  const clear = await evaluate(remainder(), { data: weakAt(-5000) });
  assert.equal(clear.status, STATUS.NOT);
  assert.equal(clear.lowConfidenceNegative, true);
  // 추정이 없으면 로또, 반복 공급이면 아님이다.
  assert.equal((await evaluate(remainder(), { data: [] })).status, STATUS.LOTTO);
  assert.equal((await evaluate(remainder('합성단지 무순위(사후)(14차)'), { data: [] })).status, STATUS.NOT);
});

test('불법행위 재공급 stays 로또 whatever the evidence, because its price check is off', async () => {
  const resupply = apt({ kind: 'remainder', houseSecd: '06', name: '합성단지 재공급' });
  for (const data of [confidentAt(700), weakAt(27500), weakAt(10000), []]) {
    const result = await evaluate(resupply, { data });
    assert.equal(result.status, STATUS.LOTTO);
    assert.equal(result.checkNote, undefined);
  }
  // 가격 확인을 켜면 다른 조건형 공고처럼 확인 필요가 된다.
  const checked = { triggerPriceCheck: { ...config.lotto.triggerPriceCheck, resupply: true } };
  assert.equal((await evaluate(resupply, { data: confidentAt(700), overrides: checked })).status, STATUS.CHECK);
  // 무순위의 가격 확인을 끄면 확인 필요 규칙도 꺼져 예전처럼 로또다.
  const unchecked = { triggerPriceCheck: { ...config.lotto.triggerPriceCheck, remainder: false } };
  for (const data of [confidentAt(700), weakAt(27500)]) assert.equal((await evaluate(remainder(), { data, overrides: unchecked })).status, STATUS.LOTTO);
});

test('a repeated round beats 확인 필요: the candidate becomes 아님, and only a firm margin keeps 로또', async () => {
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

  // 신뢰도 중 이상에서 마진율이 3% 이상이면 차수와 상관없이 로또다(예전 동작).
  assert.equal((await evaluate(repeated, { data: confidentAt(5000) })).status, STATUS.LOTTO);
  // 기준 차수 미만(2차)이면 같은 추정이 확인 필요다.
  const second = remainder('합성단지 무순위(사후)(2차)');
  assert.equal((await evaluate(second, { data: confidentAt(700) })).status, STATUS.CHECK);
  assert.equal((await evaluate(second, { data: weakAt(10000) })).status, STATUS.CHECK);
  // 차수 규칙을 끄면 반복 공급도 확인 필요다.
  assert.equal((await evaluate(repeated, { data: confidentAt(700), overrides: { remainderMaxRound: null } })).status, STATUS.CHECK);
});

test('triggerMinMarginRate null or missing keeps the old zero-margin rule, and a bad value is off and reported', async () => {
  const run = async (overrides, lotto = { ...config.lotto, ...overrides }) => {
    const soft = [];
    const result = await evaluateLotto(remainder(), {
      config: { ...config, lotto },
      today,
      getModels: async () => [{ houseType: '084A', area: 84, price: 100000 }],
      getTrades: async () => confidentAt(700),
      onSoftOnce: (kind) => soft.push(kind),
    });
    return { result, soft };
  };
  const { triggerMinMarginRate: _min, ...withoutMin } = config.lotto;
  for (const [label, outcome] of [['null', await run({ triggerMinMarginRate: null })], ['missing', await run({}, withoutMin)]]) {
    assert.equal(outcome.result.status, STATUS.LOTTO, label);
    assert.deepEqual(outcome.soft, [], label);
  }
  assert.equal(badTriggerConfig({ triggerMinMarginRate: null }), false);
  assert.equal(badTriggerConfig(withoutMin), false);
  for (const value of [-0.01, '0.03', true, Number.NaN, Number.POSITIVE_INFINITY, [0.03], {}]) {
    const { result, soft } = await run({ triggerMinMarginRate: value });
    assert.equal(result.status, STATUS.LOTTO, String(value));
    assert.deepEqual(soft, ['bad_trigger_config'], String(value));
    assert.equal(badTriggerConfig({ triggerMinMarginRate: value }), true, String(value));
  }
  // 0은 쓸 수 있는 값이다. 최소 마진율이 0이면 마진이 0 이상인 추정은 모두 로또다.
  assert.equal(badTriggerConfig({ triggerMinMarginRate: 0 }), false);
  assert.equal((await run({ triggerMinMarginRate: 0 })).result.status, STATUS.LOTTO);
  // 값을 키우면 근거에 그 비율이 적힌다.
  const strict = await evaluate(remainder(), { data: confidentAt(5000), overrides: { triggerMinMarginRate: 0.075 } });
  assert.equal(strict.status, STATUS.CHECK);
  assert.ok(strict.reason.includes('(마진율 5% < 7.5%)'), strict.reason);
  // 신뢰도 하의 양수 마진 규칙은 이 설정과 상관없이 켜져 있다.
  const weakOff = await evaluate(remainder(), { data: weakAt(10000), overrides: { triggerMinMarginRate: null } });
  assert.equal(weakOff.status, STATUS.CHECK);
});

test('a previous 로또 that becomes 확인 필요 is demoted, not kept', async () => {
  const thin = await evaluate(remainder(), { data: confidentAt(700) });
  assert.equal(thin.status, STATUS.CHECK);
  assert.equal(keepPreviousLotto(thin, STATUS.LOTTO).status, STATUS.CHECK);
  assert.equal(keepPreviousLotto(thin, STATUS.LOTTO).reason, thin.reason);
  const weak = await evaluate(remainder(), { data: weakAt(10000) });
  assert.equal(weak.confidence, '하');
  assert.equal(keepPreviousLotto(weak, STATUS.LOTTO).status, STATUS.CHECK);
  assert.equal(keepPreviousLotto(thin, STATUS.CHECK).status, STATUS.CHECK);
  // 직접 만든 값으로도 같다. 신뢰도 하의 확인 필요도 유지 대상이 아니다.
  assert.equal(keepPreviousLotto({ status: STATUS.CHECK, confidence: '하', reason: 'x' }, STATUS.LOTTO).status, STATUS.CHECK);
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
// 공동주민 목록 조회가 AppError로 실패하면 역 정보가 없는 것으로 본다(src/lotto.js의 resolveStations).
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
  // 같은 날 다른 조건형 공고도 같다.
  for (const notice of [capped(), district()]) assert.equal((await evaluateWith(notice, { data: confidentAt(15000), presale: presaleDown })).status, STATUS.LOTTO);

  // 중 기준으로 보면 마진이 근소하거나 음수인 공고는 조회 실패와 상관없이 같은 판정이다.
  assert.equal((await evaluateWith(remainder(), { data: confidentAt(700), presale: presaleDown })).status, STATUS.CHECK);
  const negative = await evaluateWith(remainder(), { data: confidentAt(-3000), presale: presaleDown });
  assert.equal(negative.status, STATUS.NOT);
  assert.equal(negative.lowConfidenceNegative, undefined);
  // 반복 공급의 중 기준 로또(마진율 3% 이상)도 그대로다.
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
  // 역 정보 조회가 실패한 날에도 근소한 마진은 확인 필요다.
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

test('the 근소함 reason floors the rate to one decimal so a rate under the minimum never reads as equal to it', async () => {
  // 마진 +2960만원 = 2.96%
  const near = await evaluate(remainder(), { data: confidentAt(2960) });
  assert.equal(near.status, STATUS.CHECK);
  assert.ok(near.reason.startsWith('수도권 무순위·잔여세대 해당이나 마진이 근소함(마진율 2.9% < 3%); '), near.reason);
});

test('with only 중 types a price-checked trigger prefers the type whose margin rate reaches the minimum', async () => {
  // 084A(10억): 마진 2500만원(2.5%). 059A(5억): 마진 1950만원(3.9%). 금액은 084A가 크지만 3%를 넘는 것은 059A뿐이다.
  const models = [{ houseType: '084A', area: 84, price: 100000 }, { houseType: '059A', area: 59, price: 50000 }];
  const data = [...two(5, 0, { area: 84, amount: 107300 }), ...two(5, 0, { area: 59, amount: 54000 })];
  const picked = await evaluate(remainder(), { models, data });
  assert.equal(picked.confidence, '중');
  assert.ok(picked.reason.includes('(059A, 신뢰도 중)'), picked.reason);
  assert.ok(Math.abs(picked.marginRate - 0.039) < 1e-9, String(picked.marginRate));
  assert.equal(picked.status, STATUS.LOTTO);
  // 조건 없는 공고는 예전처럼 마진 금액이 큰 084A다.
  const plain = await evaluate(apt(), { models, data });
  assert.ok(plain.reason.includes('(084A, 신뢰도 중)'), plain.reason);
  // 최소 마진율을 끄면 마진 금액이 큰 084A를 고르고 로또다.
  const off = await evaluate(remainder(), { models, data, overrides: { triggerMinMarginRate: null } });
  assert.ok(off.reason.includes('(084A, 신뢰도 중)'), off.reason);
  // 3%를 넘는 주택형이 없으면 마진 금액이 큰 084A이고 확인 필요다.
  const none = await evaluate(remainder(), { models, data: [...two(5, 0, { area: 84, amount: 107300 }), ...two(5, 0, { area: 59, amount: 53000 })] });
  assert.ok(none.reason.includes('(084A, 신뢰도 중)'), none.reason);
  assert.equal(none.status, STATUS.CHECK);
});
