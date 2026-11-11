import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { STATUS, evaluateLotto } from '../src/lotto.js';
import { run } from '../src/main.js';
import { buildProperties } from '../src/notion-store.js';
import { createFactLookup, formatModelPrices, minPriceOf, priceFactsOf, topPriceOf } from '../src/price-facts.js';
import { RECEPTION, receptionStatus, selectStatusUpdates } from '../src/reception.js';

// 분양가 사실(최저·최고·주택형별)과 접수 상태. 공고, 주택형, 거래는 모두 지어낸 값이다.
const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const today = '2026-11-05';
const THU_NOW = '2026-11-04T22:30:00Z';

const model = (area, price, households = null) => ({ houseType: `${String(area).padStart(3, '0')}A`, area, price, households });

// ---------- 접수 상태 ----------
test('접수 상태 is 접수 전 before the window, 접수 중 during it and 마감 after it', () => {
  assert.equal(receptionStatus('2026-11-06', '2026-11-10', today), RECEPTION.BEFORE);
  assert.equal(receptionStatus('2026-11-05', '2026-11-10', today), RECEPTION.OPEN);
  assert.equal(receptionStatus('2026-11-01', '2026-11-05', today), RECEPTION.OPEN);
  assert.equal(receptionStatus('2026-11-01', '2026-11-04', today), RECEPTION.CLOSED);
  assert.equal(receptionStatus('2026-10-01', '2026-10-05', today), '마감');
  // 하루짜리 접수
  assert.equal(receptionStatus('2026-11-05', '2026-11-05', today), RECEPTION.OPEN);
});

test('접수 상태 is empty when the dates cannot tell, never a wrong status', () => {
  assert.equal(receptionStatus(null, null, today), null);
  // 시작일이 없으면 모른다. 종료일이 지났어도 적지 않는다.
  assert.equal(receptionStatus(null, '2026-11-10', today), null);
  assert.equal(receptionStatus(null, '2026-10-01', today), null);
  // 종료일이 없으면 시작 전일 때만 접수 전이고, 시작 뒤에는 접수 중인지 마감인지 몰라 비운다.
  assert.equal(receptionStatus('2026-11-06', null, today), RECEPTION.BEFORE);
  assert.equal(receptionStatus('2026-11-05', null, today), null);
  assert.equal(receptionStatus('2026-10-01', null, today), null);
  assert.equal(receptionStatus('2026-10-01', '2026-10-05', null), null);
});

test('selectStatusUpdates lists only stored rows whose status differs and can be computed', () => {
  const rows = [
    { id: 'a', start: '2026-10-01', end: '2026-10-05', receptionStatus: '접수 중' },
    { id: 'b', start: '2026-10-01', end: '2026-10-05', receptionStatus: '마감' },
    { id: 'c', start: '2026-12-01', end: '2026-12-05', receptionStatus: null },
    { id: 'd', start: null, end: null, receptionStatus: '접수 중' },
    { id: 'e', start: '2026-10-01', end: null, receptionStatus: '접수 중' },
  ];
  assert.deepEqual(selectStatusUpdates(rows, today).map(({ row, status }) => [row.id, status]), [['a', '마감'], ['c', '접수 전']]);
});

// ---------- 분양가 사실 ----------
test('formatModelPrices lists 주택형 by area with 억 prices and households', () => {
  assert.equal(
    formatModelPrices([model(84.98, 78000, 80), model(59.98, 52000, 120)]),
    '59.98㎡ 5.2억(120세대) / 84.98㎡ 7.8억(80세대)',
  );
  assert.equal(formatModelPrices([model(59, 52500), model(74, 9500), model(84, 120000)]), '59㎡ 5.25억 / 74㎡ 9,500만 / 84㎡ 12억');
  // 가격이 없는 주택형은 적지 않고, 세대수 0은 적지 않는다.
  assert.equal(formatModelPrices([model(59, null), model(84, 70000, 0)]), '84㎡ 7억');
  assert.equal(formatModelPrices([model(null, 70000)]), '면적 미상 7억');
});

test('formatModelPrices is empty without priced 주택형 and never exceeds the Notion limit', () => {
  for (const models of [[], null, undefined, [model(59, null), model(84, 0)]]) assert.equal(formatModelPrices(models), null);
  const many = Array.from({ length: 400 }, (_, index) => model(40 + index / 10, 50000 + index, 100));
  const text = formatModelPrices(many);
  assert.ok(text.length <= 2000, text.length);
  assert.match(text, /… 외 \d+개$/);
  // 자른 줄은 통째로 빠진다. 앞 줄은 그대로다.
  assert.ok(text.startsWith('40㎡ 5억(100세대) / 40.1㎡'));
  const shown = text.split(' / ').length - 1;
  assert.equal(Number(/외 (\d+)개$/.exec(text)[1]), 400 - shown);
  assert.ok(formatModelPrices(many, 50).length <= 50);
  assert.ok(formatModelPrices(many, 5).length <= 5);
  // 한도 안이면 자르지 않는다.
  assert.ok(!formatModelPrices(many.slice(0, 5)).includes('…'));
  // Notion에 보내는 문단도 2000자 이하다.
  const props = buildProperties({ key: 'k', name: 'n', stages: [] }, { status: '대상 외', modelPrices: text }, today);
  assert.ok(props['주택형별 분양가'].rich_text[0].text.content.length <= 2000);
});

test('최저 분양가 skips 주택형 without a price, and an empty list gives no facts', () => {
  const models = [model(59, null), model(84, 100000), model(74, 80000), model(49, 0)];
  assert.equal(minPriceOf(models), 80000);
  assert.equal(topPriceOf(models), 100000);
  assert.equal(minPriceOf([model(59, null)]), null);
  assert.equal(minPriceOf([]), null);
  assert.equal(minPriceOf(null), null);
  assert.equal(topPriceOf([]), null);
  assert.deepEqual(priceFactsOf([], () => null), { averagePrice: null, minPrice: null, modelPrices: null });
  assert.deepEqual(priceFactsOf([model(59, 40000), model(84, 60000)], () => 50000), { averagePrice: 50000, minPrice: 40000, modelPrices: '59㎡ 4억 / 84㎡ 6억' });
});

test('createFactLookup respects the budget, reports every overrun call and remembers notices', async () => {
  const asked = [];
  const exceeded = [];
  const lookup = createFactLookup({ getModels: async (notice) => { asked.push(notice.key); return [model(59, 40000)]; }, budget: 2, onExceeded: () => exceeded.push('x') });
  const notice = (key) => ({ key, mdlOp: 'getOPTLttotPblancMdl' });
  assert.deepEqual(await lookup(notice('a')), [model(59, 40000)]);
  await lookup(notice('b'));
  // 같은 공고는 다시 부르지 않고 한도에도 세지 않는다.
  await lookup(notice('a'));
  assert.equal(await lookup(notice('c')), null);
  assert.equal(await lookup(notice('d')), null);
  assert.deepEqual(asked, ['a', 'b']);
  assert.equal(exceeded.length, 2);
  // 조회할 곳이 없는 공고는 한도를 쓰지 않는다.
  assert.equal(await createFactLookup({ getModels: async () => [], budget: 1 })({ key: 'z' }), null);
  // 한도가 설정되지 않았거나 틀리면 기능을 끈다. 조회도 건수도 없다.
  for (const budget of [undefined, null, -1, 1.5, '5']) {
    const off = [];
    const disabled = createFactLookup({ getModels: async () => { off.push('call'); return []; }, budget, onExceeded: () => off.push('exceeded') });
    assert.equal(await disabled(notice('a')), null);
    assert.deepEqual(off, []);
  }
});

// ---------- 판정 ----------
const apt = (extra = {}) => ({
  key: '1-1',
  kind: 'apt',
  mdlOp: 'getAPTLttotPblancMdl',
  houseSecd: '01',
  region: '서울',
  name: '공고단지',
  typeLabel: 'APT',
  builder: '',
  address: '서울특별시 강남구 역삼동 1',
  flags: { priceCap: false, publicDistrict: false },
  stages: [{ name: '특별공급', start: today, end: today }],
  ...extra,
});

const saleRows = (unit) => ['a1', 'a2'].flatMap((jibun) => Array.from({ length: 5 }, () => ({
  aptName: `비교${jibun}`, umd: '역삼동', jibun, buildYear: 2026, amount: unit * 84, area: 84, floor: 10, dealingGbn: '중개거래', dealDate: '2026-10-01',
})));

const MODELS = [model(59, 60000, 30), model(84, 100000, 70)];

async function evaluate(notice, { trades = [], models = MODELS, factModels = MODELS, soft = [] } = {}) {
  const asked = { models: 0, facts: 0 };
  const evaluation = await evaluateLotto(notice, {
    config,
    today,
    getModels: async () => { asked.models += 1; return models; },
    getFactModels: factModels === false ? undefined : async () => {
      asked.facts += 1;
      if (factModels instanceof Error) throw factModels;
      return factModels;
    },
    getTrades: async () => trades,
    onSoft: (kind) => soft.push(kind),
  });
  return { evaluation, asked };
}

test('an evaluated notice gets the 판단 주택형 of the best model and the facts of all 주택형', async () => {
  // 거래는 84㎡만 있어 84㎡가 판단 주택형이다. 59㎡가 먼저 와도 면적은 고른 주택형의 값이다.
  const { evaluation, asked } = await evaluate(apt(), { trades: saleRows(2200) });
  assert.ok(evaluation.margin > 0);
  assert.equal(evaluation.judgedArea, 84);
  assert.equal(evaluation.topPrice, 100000);
  assert.equal(evaluation.minPrice, 60000);
  // (60000 × 30 + 100000 × 70) / 100
  assert.equal(evaluation.averagePrice, 88000);
  assert.equal(evaluation.modelPrices, '59㎡ 6억(30세대) / 84㎡ 10억(70세대)');
  // 판정 경로는 판정용 조회만 쓴다.
  assert.deepEqual(asked, { models: 1, facts: 0 });
  const props = buildProperties(apt(), evaluation, today);
  assert.deepEqual(props['판단 주택형(㎡)'], { number: 84 });
  assert.deepEqual(props['최저 분양가'], { number: 60000 });
});

test('without an evaluation 최고 분양가 is the highest of all 주택형 and 판단 주택형 stays empty', async () => {
  const { evaluation } = await evaluate(apt(), { trades: [] });
  assert.equal(evaluation.status, STATUS.UNDETERMINED);
  assert.equal(evaluation.margin, null);
  assert.equal(evaluation.topPrice, 100000);
  assert.equal(evaluation.minPrice, 60000);
  assert.equal(evaluation.judgedArea ?? null, null);
  const props = buildProperties(apt(), evaluation, today);
  assert.equal(Object.hasOwn(props, '판단 주택형(㎡)'), false);
  assert.deepEqual(props['최고 분양가'], { number: 100000 });
});

test('an unused kind (임의공급) gets the price facts but stays 대상 외 with no margin', async () => {
  const arbitrary = apt({ kind: 'arbitrary', mdlOp: 'getOPTLttotPblancMdl', typeLabel: '임의공급', houseSecd: '' });
  const { evaluation, asked } = await evaluate(arbitrary, { trades: saleRows(2200) });
  assert.equal(evaluation.status, STATUS.OUT_OF_SCOPE);
  assert.equal(evaluation.reason, '설정에서 제외된 유형');
  assert.deepEqual(
    { estimate: evaluation.estimate, margin: evaluation.margin, marginRate: evaluation.marginRate, confidence: evaluation.confidence },
    { estimate: null, margin: null, marginRate: null, confidence: null },
  );
  assert.equal(evaluation.topPrice, 100000);
  assert.equal(evaluation.minPrice, 60000);
  // (60000 × 30 + 100000 × 70) / 100
  assert.equal(evaluation.averagePrice, 88000);
  assert.equal(evaluation.modelPrices, '59㎡ 6억(30세대) / 84㎡ 10억(70세대)');
  assert.equal(evaluation.judgedArea ?? null, null);
  assert.deepEqual(asked, { models: 0, facts: 1 });
  const props = buildProperties(arbitrary, evaluation, today);
  assert.deepEqual(props['로또 여부'], { select: { name: '대상 외' } });
  for (const name of ['안전 마진', '마진율', '추정 시세', '시세 신뢰도', '판단 주택형(㎡)']) assert.equal(Object.hasOwn(props, name), false, name);
});

test('an out-of-region notice gets the price facts without reading models for the recommendation', async () => {
  const { evaluation, asked } = await evaluate(apt({ region: '부산', address: '부산광역시 해운대구 우동 1' }), { trades: saleRows(2200) });
  assert.equal(evaluation.status, STATUS.OUT_OF_SCOPE);
  assert.equal(evaluation.reason, '알림 지역이 아님');
  assert.equal(evaluation.margin, null);
  assert.equal(evaluation.minPrice, 60000);
  assert.equal(evaluation.topPrice, 100000);
  // 판정용 조회(추천 계산에 쓰인다)를 건드리지 않아 추천이 달라지지 않는다.
  assert.deepEqual(asked, { models: 0, facts: 1 });
});

test('a failed or missing fact lookup leaves the facts empty, counts once and keeps the status', async () => {
  const soft = [];
  const failed = await evaluate(apt({ region: '부산' }), { factModels: new Error('x'), soft });
  assert.equal(failed.evaluation.status, STATUS.OUT_OF_SCOPE);
  assert.equal(failed.evaluation.topPrice, null);
  assert.equal(failed.evaluation.minPrice, null);
  assert.equal(failed.evaluation.modelPrices, null);
  assert.deepEqual(soft, ['price_facts_lookup_failed']);
  // 조회 함수를 주지 않으면(예전 호출) 부르지 않는다.
  const none = await evaluate(apt({ region: '부산' }), { factModels: false });
  assert.equal(none.evaluation.minPrice, null);
  // 주택형이 비어 있어도 같다.
  const empty = await evaluate(apt({ region: '부산' }), { factModels: [] });
  assert.equal(empty.evaluation.modelPrices, null);
  assert.equal(empty.evaluation.topPrice, null);
});

test('a restricted type keeps clearing the market values, gets the price facts and clears 판단 주택형', async () => {
  const { evaluation } = await evaluate(apt({ name: '고덕 토지임대 단지' }));
  assert.equal(evaluation.status, STATUS.OUT_OF_SCOPE);
  assert.equal(evaluation.clearMarket, true);
  assert.equal(evaluation.minPrice, 60000);
  assert.equal(evaluation.topPrice, 100000);
  const props = buildProperties(apt(), evaluation, today);
  assert.deepEqual(props['추정 시세'], { number: null });
  assert.deepEqual(props['안전 마진'], { number: null });
  assert.deepEqual(props['판단 주택형(㎡)'], { number: null });
  assert.deepEqual(props['최저 분양가'], { number: 60000 });
  assert.equal(props['주택형별 분양가'].rich_text[0].text.content, '59㎡ 6억(30세대) / 84㎡ 10억(70세대)');
});

test('a shared-gain type keeps its 참고 마진 and also records 판단 주택형', async () => {
  const { evaluation } = await evaluate(apt({ name: '하남교산 나눔형' }), { trades: saleRows(2200) });
  assert.equal(evaluation.referenceMargin, true);
  assert.equal(evaluation.judgedArea, 84);
  assert.equal(evaluation.minPrice, 60000);
  assert.equal(evaluation.topPrice, 100000);
});

test('an LH notice without an evaluation shows the prices it already read, with no extra lookup', async () => {
  const lh = {
    key: 'LH-1', kind: 'lh', region: '서울', name: 'LH 공공분양', typeLabel: '분양주택', address: '', flags: { priceCap: true }, stages: [], lhDetailState: 'ok', models: [model(59, 45000, 10), model(74, 55000, 20)],
  };
  const { evaluation, asked } = await evaluate(lh);
  assert.equal(evaluation.status, STATUS.OUT_OF_SCOPE);
  assert.match(evaluation.reason, /LH 단지 주소 미매핑/);
  assert.equal(evaluation.minPrice, 45000);
  assert.equal(evaluation.topPrice, 55000);
  assert.equal(evaluation.modelPrices, '59㎡ 4.5억(10세대) / 74㎡ 5.5억(20세대)');
  assert.deepEqual(asked, { models: 0, facts: 0 });
  const noModels = await evaluate({ ...lh, models: undefined, lhDetailState: 'no_codes' });
  assert.equal(noModels.evaluation.minPrice, null);
});

// ---------- buildProperties ----------
test('buildProperties writes 접수 상태 from the notice dates, falls back to the stored dates and omits it when unknown', () => {
  const notice = { key: 'k', name: 'n', stages: [], overallStart: '2026-11-10', overallEnd: '2026-11-12' };
  assert.deepEqual(buildProperties(notice, null, today)['접수 상태'], { select: { name: '접수 전' } });
  assert.deepEqual(buildProperties({ ...notice, overallStart: '2026-11-01', overallEnd: '2026-11-04' }, null, today)['접수 상태'], { select: { name: '마감' } });
  // 공고에 날짜가 없으면 저장된 날짜를 쓴다(날짜 열은 값이 없으면 저장된 값을 둔다).
  const bare = { key: 'k', name: 'n', stages: [] };
  assert.deepEqual(buildProperties(bare, null, today, undefined, { start: '2026-11-01', end: '2026-11-30' })['접수 상태'], { select: { name: '접수 중' } });
  assert.equal(Object.hasOwn(buildProperties(bare, null, today), '접수 상태'), false);
  assert.equal(Object.hasOwn(buildProperties(bare, null, today, undefined, { start: null, end: '2026-11-30' }), '접수 상태'), false);
  // 열을 쓸 수 없으면 보내지 않는다.
  const columns = { margin: null, marginRate: null, confidence: null, averagePrice: null, recommendTrack: null, recommendDate: null, minPrice: null, modelPrices: null, judgedArea: null, receptionStatus: null };
  const props = buildProperties(notice, { status: '대상 외', minPrice: 1, modelPrices: 'x', judgedArea: 84 }, today, columns);
  for (const name of ['접수 상태', '최저 분양가', '주택형별 분양가', '판단 주택형(㎡)']) assert.equal(Object.hasOwn(props, name), false, name);
});

// ---------- 실행 ----------
const optRow = (id, region = '서울') => ({
  HOUSE_MANAGE_NO: String(id),
  PBLANC_NO: '1',
  HOUSE_NM: `임의 단지 ${id}`,
  HOUSE_SECD: '03',
  SUBSCRPT_AREA_CODE_NM: region,
  HSSPLY_ADRES: `${region === '서울' ? '서울특별시 강남구 역삼동' : '부산광역시 해운대구 우동'} ${id}`,
  RCRIT_PBLANC_DE: '20261101',
  SUBSCRPT_RCEPT_BGNDE: '20261110',
  SUBSCRPT_RCEPT_ENDDE: '20261112',
  PBLANC_URL: 'https://www.applyhome.co.kr/o',
});

function world({ arbitrary = [], apts = [], modelStatus = 200 } = {}) {
  const calls = { models: [] };
  const fetch = async (url) => {
    const text = String(url);
    if (text.includes('getOPTLttotPblancDetail')) return Response.json({ totalCount: arbitrary.length, data: arbitrary });
    if (text.includes('getAPTLttotPblancDetail')) return Response.json({ totalCount: apts.length, data: apts });
    if (text.includes('Mdl')) {
      calls.models.push(new URL(text).pathname.split('/').pop());
      if (modelStatus !== 200) return new Response('x', { status: modelStatus });
      return Response.json({
        totalCount: 2,
        data: [
          { HOUSE_TY: '059.9800A', LTTOT_TOP_AMOUNT: '52,000', SUPLY_HSHLDCO: '30' },
          { HOUSE_TY: '084.9800A', LTTOT_TOP_AMOUNT: '78,000', SUPLY_HSHLDCO: '20' },
        ],
      });
    }
    if (text.includes('api.odcloud.kr')) return Response.json({ totalCount: 0, data: [] });
    if (text.includes('apis.data.go.kr/1613000')) return new Response('<r><resultCode>000</resultCode><totalCount>0</totalCount></r>');
    return Response.json([{ dsList: [] }]);
  };
  return { fetch, calls };
}

function fakeStore(existing = new Map()) {
  const state = { upserts: [], statuses: [] };
  return {
    state,
    init: async () => {},
    loadExisting: async () => existing,
    upsert: async (notice, evaluation, previous, day) => {
      state.upserts.push({ key: notice.key, properties: buildProperties(notice, evaluation, day, undefined, previous) });
      return `page-${notice.key}`;
    },
    setReceptionStatus: async (id, status) => {
      state.statuses.push({ id, status });
      return true;
    },
    stampUrgent: async () => {},
    getWeeklyState: async () => '2026-11-02',
    setWeeklyState: async () => {},
    archivePage: async () => {},
  };
}

async function runWith(data, { store = fakeStore(), runConfig = config, argv = [] } = {}) {
  const logs = [];
  const mails = [];
  const w = world(data);
  const code = await run({
    argv,
    env: { DATA_GO_KR_KEY: 'SECRET-DATA-KEY', NOTION_KEY: 'n', CHUNGYAK_NOTION_PAGE_ID: 'p' },
    deps: {
      fetch: w.fetch,
      store,
      config: runConfig,
      accessToken: 'token',
      sleep: async () => {},
      now: () => new Date(THU_NOW),
      log: (line) => logs.push(line),
      write: () => {},
      sendMail: async (mail) => { mails.push(mail); },
      sendKakao: async () => {},
    },
  });
  return { code, logs, mails, store, calls: w.calls };
}

const marketLine = (result) => result.logs.find((line) => line.startsWith('market '));
const summaryLine = (result) => result.logs.find((line) => line.startsWith('collected='));

test('a run fills the price facts for 임의공급 and out-of-region notices while their status stays 대상 외', async () => {
  const { code, store, mails, calls } = await runWith({ arbitrary: [optRow(11)], apts: [{ ...optRow(12, '부산'), HOUSE_SECD: '01', RCEPT_BGNDE: '2026-11-10', RCEPT_ENDDE: '2026-11-12' }] });
  assert.equal(code, 0);
  assert.equal(mails.length, 0);
  assert.equal(store.state.upserts.length, 2);
  for (const { properties } of store.state.upserts) {
    assert.deepEqual(properties['로또 여부'], { select: { name: '대상 외' } });
    assert.deepEqual(properties['최저 분양가'], { number: 52000 });
    assert.deepEqual(properties['최고 분양가'], { number: 78000 });
    assert.deepEqual(properties['평균 분양가'], { number: 62400 });
    assert.equal(properties['주택형별 분양가'].rich_text[0].text.content, '59.98㎡ 5.2억(30세대) / 84.98㎡ 7.8억(20세대)');
    for (const name of ['안전 마진', '마진율', '추정 시세', '시세 신뢰도', '판단 주택형(㎡)']) assert.equal(Object.hasOwn(properties, name), false, name);
    assert.deepEqual(properties['접수 상태'], { select: { name: '접수 전' } });
  }
  assert.deepEqual(calls.models.sort(), ['getAPTLttotPblancMdl', 'getOPTLttotPblancMdl']);
});

test('the extra lookups stop at market.priceLookupBudget and the overrun is counted once', async () => {
  const arbitrary = [21, 22, 23, 24].map((id) => optRow(id));
  const budgeted = { ...config, market: { ...config.market, priceLookupBudget: 2 } };
  const result = await runWith({ arbitrary }, { runConfig: budgeted });
  assert.equal(result.code, 0);
  assert.equal(result.mails.length, 0);
  assert.equal(result.calls.models.length, 2);
  assert.equal(result.store.state.upserts.filter(({ properties }) => properties['최저 분양가']).length, 2);
  // 한도를 넘은 공고도 저장하고 상태는 그대로 대상 외이며, 분양가 열만 비어 있다.
  assert.equal(result.store.state.upserts.length, 4);
  assert.ok(result.store.state.upserts.every(({ properties }) => properties['로또 여부'].select.name === '대상 외'));
  assert.match(marketLine(result), /price_lookup_budget_exceeded:1/);
  assert.ok(!result.logs.join('\n').includes('임의 단지'));
  // 한도 0은 조회하지 않고, 설정이 없으면 기능을 끈다(조회도 건수도 없다).
  const zero = await runWith({ arbitrary }, { runConfig: { ...config, market: { ...config.market, priceLookupBudget: 0 } } });
  assert.equal(zero.calls.models.length, 0);
  const { priceLookupBudget, ...marketWithout } = config.market;
  assert.equal(typeof priceLookupBudget, 'number');
  const off = await runWith({ arbitrary }, { runConfig: { ...config, market: marketWithout } });
  assert.equal(off.calls.models.length, 0);
  assert.ok(!marketLine(off).includes('price_lookup_budget_exceeded'));
});

test('the shipped config sets a positive lookup budget', () => {
  assert.ok(Number.isInteger(config.market.priceLookupBudget) && config.market.priceLookupBudget > 0);
});

test('a failed price lookup is a soft count: no error mail, status unchanged', async () => {
  const result = await (async () => {
    const w = world({ arbitrary: [optRow(31)], modelStatus: 403 });
    const logs = [];
    const mails = [];
    const store = fakeStore();
    const code = await run({
      env: { DATA_GO_KR_KEY: 'SECRET-DATA-KEY', NOTION_KEY: 'n', CHUNGYAK_NOTION_PAGE_ID: 'p' },
      deps: {
        fetch: w.fetch,
        store,
        config,
        accessToken: 'token',
        sleep: async () => {},
        now: () => new Date(THU_NOW),
        log: (line) => logs.push(line),
        write: () => {},
        sendMail: async (mail) => { mails.push(mail); },
        sendKakao: async () => {},
      },
    });
    return { code, logs, mails, store };
  })();
  assert.equal(result.code, 0);
  assert.equal(result.mails.length, 0);
  assert.match(marketLine(result), /price_facts_lookup_failed:1/);
  assert.deepEqual(result.store.state.upserts[0].properties['로또 여부'], { select: { name: '대상 외' } });
  assert.equal(Object.hasOwn(result.store.state.upserts[0].properties, '최저 분양가'), false);
});

test('stored rows that were not re-evaluated get only their 접수 상태 refreshed, and dry-run only counts them', async () => {
  const row = (id, start, end, receptionStatus) => [id, { id: `id-${id}`, key: id, lotto: '로또', urgentDate: null, start, end, interest: false, name: id, receptionStatus }];
  const stored = () => new Map([
    row('ended', '2026-09-01', '2026-10-01', '접수 중'),
    row('same', '2026-09-01', '2026-10-01', '마감'),
    row('future', '2026-12-01', '2026-12-05', null),
    row('undated', null, null, null),
  ]);
  const normal = await runWith({}, { store: fakeStore(stored()) });
  assert.equal(normal.code, 0);
  assert.deepEqual(normal.store.state.statuses, [{ id: 'id-ended', status: '마감' }, { id: 'id-future', status: '접수 전' }]);
  assert.match(summaryLine(normal), / status_updated=2( |$)/);

  const dry = await runWith({}, { store: fakeStore(stored()), argv: ['--dry-run'] });
  assert.deepEqual(dry.store.state.statuses, []);
  assert.ok(dry.logs.includes('dry-run status_update_candidates=2'), dry.logs.join('|'));
  assert.match(summaryLine(dry), / status_updated=0( |$)/);
});

test('a failed status update is soft: the run still stores notices, sends no error mail and exits 0', async () => {
  const store = fakeStore(new Map([['ended', { id: 'id-ended', key: 'ended', lotto: '로또', start: '2026-09-01', end: '2026-10-01', receptionStatus: null, interest: false, name: 'x' }]]));
  store.setReceptionStatus = async () => { throw new Error('https://api.notion.com/secret'); };
  const result = await runWith({ arbitrary: [optRow(41)] }, { store });
  assert.equal(result.code, 0);
  assert.equal(result.mails.length, 0);
  assert.equal(result.store.state.upserts.length, 1);
  assert.match(marketLine(result), /reception_status_failed:1/);
  assert.match(summaryLine(result), / status_updated=0( |$)/);
  assert.ok(!result.logs.join('\n').includes('secret'));
});
