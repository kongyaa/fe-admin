import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { STATUS, evaluateLotto, keepPreviousLotto } from '../src/lotto.js';
import { selectUrgent, selectWeekly } from '../src/main.js';
import { badSharedGainConfig, restrictedKeywords, sharedGainOf } from '../src/market-estimate.js';
import { buildWeeklyMail } from '../src/notify-gmail.js';
import { buildProperties } from '../src/notion-store.js';

// 차익 공유 유형(나눔형, 신혼희망타운)의 참고 마진. 공고와 거래는 모두 지어낸 값이다.
const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const today = '2026-11-05';

const apt = (extra = {}) => ({
  key: '1-1',
  kind: 'apt',
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

// 비교 단지 두 곳, 각 5건
const saleRows = (unit) => ['a1', 'a2'].flatMap((jibun) => Array.from({ length: 5 }, () => ({
  aptName: `비교${jibun}`,
  umd: '역삼동',
  jibun,
  buildYear: 2026,
  amount: unit * 84,
  area: 84,
  floor: 10,
  dealingGbn: '중개거래',
  dealDate: '2026-10-01',
})));

const evaluate = (notice, { trades = [], soft = [], errors = [], runConfig = config, models = [{ houseType: '084A', area: 84, price: 100000, households: 10 }] } = {}) => evaluateLotto(notice, {
  config: runConfig,
  today,
  getModels: async () => models,
  getTrades: async () => trades,
  onError: (kind) => errors.push(kind),
  onSoft: (kind) => soft.push(kind),
});

test('shared-gain types are found with the restrictedType keyword logic and 토지임대부·지분적립 never qualify', () => {
  const { market } = config;
  assert.deepEqual(market.sharedGain, { 나눔형: 0.7, 신혼희망: 1.0 });
  assert.deepEqual(sharedGainOf({ name: '뉴:홈 하남교산 나눔형' }, market), { type: '나눔형', factor: 0.7 });
  assert.deepEqual(sharedGainOf({ name: '공고', typeLabel: '분양주택 나눔 형' }, market), { type: '나눔형', factor: 0.7 });
  assert.deepEqual(sharedGainOf({ name: '하남교산 신혼희망타운' }, market), { type: '신혼희망', factor: 1 });
  assert.deepEqual(sharedGainOf({ name: '공고', houseSecd: '10' }, market), { type: '신혼희망', factor: 1 });
  // 둘 다면 계수가 작은 쪽이다.
  assert.deepEqual(sharedGainOf({ name: '신혼희망타운 나눔형' }, market), { type: '나눔형', factor: 0.7 });
  for (const notice of [{ name: '고덕강일 토지임대부' }, { name: '광교 지분적립형' }, { name: '나눔형', typeLabel: '분양주택 토지임대부' }, { name: '일반 공고' }]) {
    assert.equal(sharedGainOf(notice, market), null, notice.name);
  }
  assert.deepEqual(restrictedKeywords({ name: '나눔형', typeLabel: '분양주택 토지임대부' }, market), ['토지임대', '나눔형']);
  // 설정이 없거나 틀리면 쓰지 않는다.
  assert.equal(sharedGainOf({ name: '나눔형' }, { ...market, sharedGain: undefined }), null);
  assert.equal(sharedGainOf({ name: '나눔형' }, { ...market, sharedGain: { 나눔형: 1.5 } }), null);
  assert.equal(badSharedGainConfig(market), false);
  assert.equal(badSharedGainConfig({ sharedGain: undefined }), false);
  for (const bad of [[0.7], 'x', { 나눔형: 0 }, { 나눔형: '0.7' }, { 나눔형: 1.2 }]) assert.equal(badSharedGainConfig({ sharedGain: bad }), true, JSON.stringify(bad));
});

test('a positive 나눔형 margin is multiplied by 0.7, the rate follows, and the status stays 대상 외', async () => {
  const normal = await evaluate(apt(), { trades: saleRows(2200) });
  assert.ok(normal.margin > 0);
  for (const flags of [{ priceCap: false, publicDistrict: false }, { priceCap: true, publicDistrict: true }]) {
    const result = await evaluate(apt({ name: '하남교산 나눔형', flags }), { trades: saleRows(2200) });
    assert.equal(result.status, STATUS.OUT_OF_SCOPE);
    assert.equal(result.margin, Math.round(normal.margin * 0.7));
    assert.equal(result.marginRate, result.margin / normal.topPrice);
    assert.equal(result.estimate, normal.estimate);
    assert.equal(result.confidence, normal.confidence);
    assert.equal(result.topPrice, normal.topPrice);
    assert.equal(result.averagePrice, 100000);
    assert.equal(result.referenceMargin, true);
    assert.equal(result.clearMarket, undefined);
    assert.ok(result.reason.startsWith('참고 마진(차익 공유 유형, 내 몫 ×0.7) '), result.reason);
    // 머리말 뒤에는 보통 판별 근거(바꾸기 전 마진)가 온다.
    assert.ok(result.reason.endsWith(normal.reason), result.reason);
    // 로또 판별은 하지 않고 이전 로또도 되살리지 않는다.
    assert.equal(keepPreviousLotto(result, STATUS.LOTTO).status, STATUS.OUT_OF_SCOPE);
  }
});

test('a negative margin is stored unchanged and 신혼희망타운 uses ×1.0 with its loan note', async () => {
  const normalLow = await evaluate(apt(), { trades: saleRows(1100) });
  assert.ok(normalLow.margin < 0);
  const low = await evaluate(apt({ name: '하남교산 나눔형' }), { trades: saleRows(1100) });
  assert.equal(low.status, STATUS.OUT_OF_SCOPE);
  assert.equal(low.margin, normalLow.margin);
  assert.equal(low.marginRate, normalLow.marginRate);
  assert.equal(low.reason, `참고 마진(차익 공유 유형, 내 몫 ×0.7); ${normalLow.reason}`);

  const normal = await evaluate(apt(), { trades: saleRows(2200) });
  for (const notice of [apt({ name: '하남교산 신혼희망타운' }), apt({ houseSecd: '10' })]) {
    const result = await evaluate(notice, { trades: saleRows(2200) });
    assert.equal(result.status, STATUS.OUT_OF_SCOPE);
    assert.equal(result.margin, normal.margin);
    assert.equal(result.marginRate, normal.marginRate);
    assert.equal(result.reason, `참고 마진(신혼희망타운: 수익공유형 대출 조건 확인); ${normal.reason}`);
  }
});

test('토지임대부 and 지분적립형 keep empty margins, and missing data clears a reference margin', async () => {
  for (const name of ['고덕강일 토지임대부', '광교 지분적립형']) {
    const result = await evaluate(apt({ name }), { trades: saleRows(2200) });
    assert.equal(result.status, STATUS.OUT_OF_SCOPE);
    assert.equal(result.clearMarket, true);
    assert.equal(result.margin, null);
    assert.equal(result.estimate, null);
    assert.equal(result.confidence, null);
    assert.ok(result.reason.endsWith('은 로또 판별과 안전 마진 대상이 아님'), result.reason);
    const props = buildProperties(apt({ name }), result, today);
    assert.deepEqual([props['안전 마진'], props['마진율'], props['추정 시세'], props['시세 신뢰도']], [{ number: null }, { number: null }, { number: null }, { select: null }]);
  }
  const name = '하남교산 나눔형';
  const noSamples = await evaluate(apt({ name }), { trades: [] });
  assert.equal(noSamples.reason, '제한 유형(나눔형)은 로또 판별 대상이 아님; 참고 마진 없음(실거래 표본 부족)');
  assert.equal(noSamples.clearMarket, true);
  const noModels = await evaluate(apt({ name }), { trades: saleRows(2200), models: [] });
  assert.equal(noModels.reason, '제한 유형(나눔형)은 로또 판별 대상이 아님; 참고 마진 없음(주택형 정보 없음)');
  assert.equal(noModels.clearMarket, true);
  const noAddress = await evaluate(apt({ name, address: '어딘가', region: '서울' }), { trades: saleRows(2200) });
  assert.equal(noAddress.reason, '제한 유형(나눔형)은 로또 판별 대상이 아님; 참고 마진 없음(시군구 코드 미매핑)');
  assert.equal(noAddress.clearMarket, true);
  // 조회 실패는 저장된 값을 지우지 않는다.
  const errors = [];
  const tradeFailed = await evaluateLotto(apt({ name }), { config, today, getModels: async () => [{ houseType: '084A', area: 84, price: 100000 }], getTrades: async () => { throw new Error('down'); }, onError: (kind) => errors.push(kind) });
  assert.equal(tradeFailed.reason, '제한 유형(나눔형)은 로또 판별 대상이 아님; 참고 마진 없음(실거래 조회 실패)');
  assert.equal(tradeFailed.clearMarket, undefined);
  assert.equal(errors.length, 1);
  const soft = [];
  const modelFailed = await evaluateLotto(apt({ name }), { config, today, getModels: async () => { throw new Error('down'); }, getTrades: async () => saleRows(2200), onSoft: (kind) => soft.push(kind) });
  assert.equal(modelFailed.reason, '제한 유형(나눔형)은 로또 판별 대상이 아님; 참고 마진 없음(주택형 정보 조회 실패)');
  assert.equal(modelFailed.clearMarket, undefined);
  assert.deepEqual(soft, ['average_price_lookup_failed']);
  const props = buildProperties(apt({ name }), modelFailed, today);
  assert.equal(props['안전 마진'], undefined);
  // 틀린 설정은 예전처럼 비우고 soft로 한 번 알린다.
  const badSoft = [];
  const bad = await evaluate(apt({ name }), { trades: saleRows(2200), soft: badSoft, runConfig: { ...config, market: { ...config.market, sharedGain: { 나눔형: 7 } } } });
  assert.equal(bad.clearMarket, true);
  assert.deepEqual(badSoft, ['bad_shared_gain_config']);
});

test('a 대상 외 row with a reference margin is stored with its values but never becomes an urgent or weekly lotto item', async () => {
  const notice = apt({ name: '하남교산 나눔형', flags: { priceCap: true, publicDistrict: true } });
  const evaluation = await evaluate(notice, { trades: saleRows(2200) });
  const props = buildProperties(notice, evaluation, today);
  assert.equal(props['로또 여부'].select.name, '대상 외');
  assert.equal(props['안전 마진'].number, evaluation.margin);
  assert.equal(props['마진율'].number, evaluation.marginRate);
  assert.equal(props['시세 신뢰도'].select.name, evaluation.confidence);
  assert.equal(props['추정 시세'].number, evaluation.estimate);
  assert.equal(props['최고 분양가'].number, 100000);
  assert.equal(props['평균 분양가'].number, 100000);
  // 마진이 가격 기준(3억, 20%)을 넘어도 로또가 아니다.
  assert.ok(evaluation.margin >= config.lotto.minMarginManwon);
  const record = { notice, status: evaluation.status, reason: evaluation.reason, urgentDate: null, pageId: 'p' };
  assert.deepEqual(selectUrgent([record], today, config.alertRegions), []);
  const items = selectWeekly([record], '2026-11-02', '2026-11-08', config.alertRegions);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, STATUS.OUT_OF_SCOPE);
  const mail = buildWeeklyMail({ items, monday: '2026-11-02', sunday: '2026-11-08' });
  assert.ok(!mail.text.includes('[로또]') && !mail.html.includes('[로또]'));
});
