import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  applyLhDetail,
  collectValueShapes,
  createShapeLog,
  findBlock,
  formatShapeLine,
  lhStageName,
  mapLhComplex,
  mapLhModels,
  mapLhSchedule,
  parseLhArea,
  parseLhCount,
  parseLhDateRange,
  parseLhPrice,
  shapeLabel,
  valueShape,
} from '../src/lh-detail-map.js';
import { STATUS, evaluateLotto, keepPreviousLotto } from '../src/lotto.js';
import { run } from '../src/main.js';
import { buildProperties } from '../src/notion-store.js';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const today = '2026-11-05';
const noSleep = async () => {};

test('date ranges accept dotted, dashed, compact and Korean dates, with times and range separators', () => {
  const cases = [
    ['2026.12.01', '2026-12-01', '2026-12-01'],
    ['2026-12-01', '2026-12-01', '2026-12-01'],
    ['20261201', '2026-12-01', '2026-12-01'],
    ['2026.12.1', '2026-12-01', '2026-12-01'],
    ['2026.12.01 10:00 ~ 2026.12.03 17:00', '2026-12-01', '2026-12-03'],
    ['2026.12.01~2026.12.03', '2026-12-01', '2026-12-03'],
    ['2026-12-01 - 2026-12-03', '2026-12-01', '2026-12-03'],
    ['2026-12-01-2026-12-03', '2026-12-01', '2026-12-03'],
    ['20261201-20261203', '2026-12-01', '2026-12-03'],
    ['202612011000~202612031700', '2026-12-01', '2026-12-03'],
    ['20261201100000', '2026-12-01', '2026-12-01'],
    ['2026-12-01T10:00:00', '2026-12-01', '2026-12-01'],
    ['2026년 12월 1일 ~ 2026년 12월 3일', '2026-12-01', '2026-12-03'],
    ['2026.12.01 ~ 12.03', '2026-12-01', '2026-12-03'],
    ['2026.12.30 10:00 ~ 01.02', '2026-12-30', '2027-01-02'],
    ['2026.12.03 ~ 2026.12.01', '2026-12-01', '2026-12-03'],
    ['2026.12.01 10:00 ~ 17:00', '2026-12-01', '2026-12-01'],
    [20261201, '2026-12-01', '2026-12-01'],
  ];
  for (const [value, start, end] of cases) assert.deepEqual(parseLhDateRange(value), { start, end }, String(value));
  for (const bad of [null, undefined, '', '  ', '미정', '12.01', '2026.13.01', '2026.02.30 ~ 2026.03.01', '2026.12.01 ~ 13.40', {}, [], '202612']) {
    assert.equal(parseLhDateRange(bad), null, String(bad));
  }
});

test('prices become 만원, areas ㎡ and counts integers; bad input is null', () => {
  assert.equal(parseLhPrice(534000000), 53400);
  assert.equal(parseLhPrice('534,000,000'), 53400);
  assert.equal(parseLhPrice('534,000,000원'), 53400);
  assert.equal(parseLhPrice('53,400'), 53400);
  assert.equal(parseLhPrice('53400만원'), 53400);
  assert.equal(parseLhPrice(' 53,400 '), 53400);
  // 1,000만 이상은 원으로 본다.
  assert.equal(parseLhPrice('10,000,000'), 1000);
  assert.equal(parseLhPrice('9,999,999'), 9999999);
  for (const bad of ['', null, '0', 0, -1, '5억', 'abc', '53,400㎡', '1~2', {}, Number.NaN]) assert.equal(parseLhPrice(bad), null, String(bad));

  assert.equal(parseLhArea('84.98'), 84.98);
  assert.equal(parseLhArea(59.9), 59.9);
  assert.equal(parseLhArea('84.98㎡'), 84.98);
  assert.equal(parseLhArea('84.98 m2'), 84.98);
  assert.equal(parseLhArea('1,234.5'), 1234.5);
  for (const bad of ['', '84A', '0', -3, '84.98원', '전용84']) assert.equal(parseLhArea(bad), null, String(bad));

  assert.equal(parseLhCount('120'), 120);
  assert.equal(parseLhCount(0), 0);
  assert.equal(parseLhCount('1,200세대'), 1200);
  for (const bad of ['1.5', '-1', '많음', '']) assert.equal(parseLhCount(bad), null, String(bad));
});

test('blocks are read by exact name, so the …Nm label twins are ignored', () => {
  const body = [{ dsSch: [{ PAN_ID: '1' }] }, { dsSplScdlNm: [{ ACP_DTTM: '접수기간' }] }, { dsSplScdl: [{ ACP_DTTM: '2026.12.01' }, 'x', null] }];
  assert.deepEqual(findBlock(body, 'dsSplScdl'), [{ ACP_DTTM: '2026.12.01' }]);
  assert.deepEqual(findBlock({ resHeader: { SS_CODE: 'Y' } }, 'resHeader'), [{ SS_CODE: 'Y' }]);
  assert.deepEqual(findBlock(body, 'dsList01'), []);
  assert.deepEqual(findBlock(null, 'dsList01'), []);
});

test('schedule rows map to applyhome stage names, unknown labels are kept and the latest winner date wins', () => {
  assert.equal(lhStageName('특별공급'), '특별공급');
  assert.equal(lhStageName('특별공급(신혼부부)'), '특별공급(신혼부부)');
  assert.equal(lhStageName('신혼부부'), '특별공급 신혼부부');
  assert.equal(lhStageName('다자녀가구'), '특별공급 다자녀가구');
  assert.equal(lhStageName('일반공급 1순위'), '1순위 일반공급');
  assert.equal(lhStageName('1순위 해당지역'), '1순위 해당지역');
  assert.equal(lhStageName('일반공급(1 순위)'), '1순위 일반공급');
  assert.equal(lhStageName('2순위'), '2순위');
  assert.equal(lhStageName('무순위'), '무순위');
  assert.equal(lhStageName('잔여세대'), '잔여세대');
  assert.equal(lhStageName('추가 모집'), '추가 모집');
  assert.equal(lhStageName('일반공급 추가접수'), '일반공급 추가접수');
  assert.equal(lhStageName('무순위 1순위'), '1순위 무순위');
  assert.equal(lhStageName('일반공급'), '1순위 일반공급');
  // 특별공급 유형 단어가 있는 일반공급은 그 유형의 특별공급이다. 앞부분 단어는 두 번 적지 않는다.
  assert.equal(lhStageName('신혼부부 일반공급'), '특별공급 신혼부부 일반공급');
  assert.equal(lhStageName('다자녀가구 특별공급'), '특별공급 다자녀가구');
  assert.equal(lhStageName('일반공급(1순위) 해당지역'), '1순위 일반공급 해당지역');
  assert.equal(lhStageName('신혼부부 1순위'), '1순위 신혼부부');
  assert.equal(lhStageName('(1순위)'), '1순위');
  assert.equal(lhStageName('Extra<b>'), '접수');
  assert.equal(lhStageName(null), '접수');

  const failed = [];
  const { stages, winnerDate } = mapLhSchedule([
    { HS_SBSC_ACP_TRG_CD_NM: '일반공급 1순위', ACP_DTTM: '2026.12.08 10:00 ~ 2026.12.09 17:00', PZWR_ANC_DT: '2026.12.20' },
    { HS_SBSC_ACP_TRG_CD_NM: '특별공급', ACP_DTTM: '2026.12.01 ~ 2026.12.03', PZWR_ANC_DT: '2026.12.20' },
    { HS_SBSC_ACP_TRG_CD_NM: '일반공급 2순위', ACP_DTTM: '20261210', PZWR_ANC_DT: '2026.12.27' },
    { HS_SBSC_ACP_TRG_CD_NM: '무순위 추가접수', ACP_DTTM: '2026.12.15' },
    { HS_SBSC_ACP_TRG_CD_NM: '예비입주자', ACP_DTTM: '추후 공지', PZWR_ANC_DT: '미정' },
    { HS_SBSC_ACP_TRG_CD_NM: '빈 일정', ACP_DTTM: '' },
  ], (field) => failed.push(field));
  assert.deepEqual(stages, [
    { name: '특별공급', start: '2026-12-01', end: '2026-12-03' },
    { name: '1순위 일반공급', start: '2026-12-08', end: '2026-12-09' },
    { name: '2순위 일반공급', start: '2026-12-10', end: '2026-12-10' },
    { name: '무순위 추가접수', start: '2026-12-15', end: '2026-12-15' },
  ]);
  assert.equal(winnerDate, '2026-12-27');
  assert.deepEqual(failed, ['ACP_DTTM', 'PZWR_ANC_DT']);
  assert.deepEqual(mapLhSchedule([]), { stages: [], winnerDate: null });
});

test('live 신혼희망타운 labels fill 특별공급 접수일 with the earliest start', () => {
  const { stages } = mapLhSchedule([
    { HS_SBSC_ACP_TRG_CD_NM: '예비신혼부부', ACP_DTTM: '2026.12.03' },
    { HS_SBSC_ACP_TRG_CD_NM: '신혼부부', ACP_DTTM: '2026.12.02 ~ 2026.12.04' },
    { HS_SBSC_ACP_TRG_CD_NM: '한부모가족', ACP_DTTM: '2026.12.05' },
  ]);
  assert.deepEqual(stages.map((stage) => stage.name), ['특별공급 신혼부부', '특별공급 예비신혼부부', '특별공급 한부모가족']);
  const props = buildProperties({ key: 'LH-x', name: 'x', stages, overallStart: '2026-12-02', overallEnd: '2026-12-05' }, null, today);
  assert.equal(props['특별공급 접수일'].date.start, '2026-12-02');
  assert.equal(props['1순위 접수일'], undefined);
});

test('supply rows map to applyhome-shaped models and multi-complex notices keep the first complex', () => {
  const failed = [];
  const { models, merged } = mapLhModels([
    { BZDT_NM: '마곡 A1', HTY_NM: '059A', RSDN_DDO_AR: '59.98', SPL_AR: '80.12', SIL_AMT: '450,000,000', SIL_HSH_CNT: '120', TOT_HSH_CNT: '300' },
    { BZDT_NM: '마곡 A1', HTY_NM: '084A', RSDN_DDO_AR: 84.97, SPL_AR: '112.3', SIL_AMT: 62000, SIL_HSH_CNT: 80 },
    { BZDT_NM: '마곡 A1', HTY_NM: '084B', RSDN_DDO_AR: '정보없음', SPL_AR: '', SIL_AMT: '협의', SIL_HSH_CNT: '' },
  ], null, (field) => failed.push(field));
  assert.deepEqual(models, [
    { houseType: '059A', area: 59.98, supplyArea: 80.12, price: 45000, households: 120, specials: { 신생아: null, 신혼부부: null, 생애최초: null } },
    { houseType: '084A', area: 84.97, supplyArea: 112.3, price: 62000, households: 80, specials: { 신생아: null, 신혼부부: null, 생애최초: null } },
    { houseType: '084B', area: null, supplyArea: null, price: null, households: null, specials: { 신생아: null, 신혼부부: null, 생애최초: null } },
  ]);
  assert.deepEqual(failed, ['RSDN_DDO_AR', 'SIL_AMT']);
  assert.equal(merged, 0);

  const rows = [
    { BZDT_NM: '마곡 A1', HTY_NM: '059A', RSDN_DDO_AR: '59.9', SIL_AMT: '40000' },
    { BZDT_NM: '고덕 B2', HTY_NM: '084A', RSDN_DDO_AR: '84.9', SIL_AMT: '70000' },
  ];
  const types = (...args) => mapLhModels(...args).models.map((model) => model.houseType);
  assert.deepEqual(types(rows, '마곡A1'), ['059A']);
  assert.deepEqual(types(rows, '없는 단지'), ['059A', '084A']);
  assert.deepEqual(types(rows, null), ['059A', '084A']);

  assert.deepEqual(mapLhComplex([{ BZDT_NM: '빈 주소' }, { BZDT_NM: ' 마곡 A1 ', LCT_ARA_ADR: '서울특별시 강서구 마곡동', LCT_ARA_DTL_ADR: '123-45 일원' }]), { name: '마곡 A1', address: '서울특별시 강서구 마곡동 123-45 일원' });
  assert.equal(mapLhComplex([{ BZDT_NM: 'x' }]), null);
});

test('rows of the same 주택형 merge into one model with the top price and summed units', () => {
  const { models, merged } = mapLhModels([
    { HTY_NM: '084A', RSDN_DDO_AR: '84.1', SIL_AMT: '60,000', SIL_HSH_CNT: '10' },
    { HTY_NM: '084 A', RSDN_DDO_AR: '84.2', SIL_AMT: '64,000', SIL_HSH_CNT: '20' },
    { HTY_NM: '084A', RSDN_DDO_AR: '84.0', SIL_AMT: '협의', SIL_HSH_CNT: '5' },
    { HTY_NM: '059A', RSDN_DDO_AR: '59.9', SIL_AMT: '45000', SIL_HSH_CNT: '' },
    { HTY_NM: '059A', RSDN_DDO_AR: '59.9', SIL_AMT: '44000', SIL_HSH_CNT: '7' },
    // 이름 없는 주택형은 전용면적으로 묶는다.
    { HTY_NM: '', RSDN_DDO_AR: '74.5', SIL_AMT: '50000', SIL_HSH_CNT: '3' },
    { HTY_NM: ' ', RSDN_DDO_AR: '74.5', SIL_AMT: '51000', SIL_HSH_CNT: '4' },
    { RSDN_DDO_AR: '74.6', SIL_AMT: '52000', SIL_HSH_CNT: '1' },
  ]);
  assert.equal(merged, 4);
  assert.deepEqual(models.map((model) => [model.houseType, model.area, model.price, model.households]), [
    // 이름과 면적은 최고가 행의 값이다.
    ['084 A', 84.2, 64000, 35],
    ['059A', 59.9, 45000, null],
    ['', 74.5, 51000, 7],
    ['', 74.6, 52000, 1],
  ]);
});

// 실응답 구조(2026-11 dry-run)를 본뜬 응답. 값은 지어낸 것이다.
const detailBody = (extra = {}) => [
  { dsSch: [{ PAN_ID: 'm1', SPL_INF_TP_CD: '050', CCR_CNNT_SYS_DS_CD: '03', UPP_AIS_TP_CD: '05', AIS_TP_CD: '05' }] },
  { resHeader: [{ RS_DTTM: '20261105073000', SS_CODE: 'Y' }] },
  { dsSbdNm: [{ BZDT_NM: '단지명', LCT_ARA_ADR: '소재지' }] },
  { dsSbd: [{ BZDT_NM: '마곡 A1블록', LCT_ARA_ADR: extra.address ?? '서울특별시 강서구 마곡동', LCT_ARA_DTL_ADR: '123-45 일원', MVIN_XPC_YM: '2029.03', SUM_TOT_HSH_CNT: '300' }] },
  { dsSplScdlNm: [{ HS_SBSC_ACP_TRG_CD_NM: '청약접수대상', ACP_DTTM: '접수일시' }] },
  {
    dsSplScdl: extra.schedule ?? [
      { HS_SBSC_ACP_TRG_CD_NM: '특별공급', ACP_DTTM: '2026.11.05 10:00 ~ 2026.11.06 17:00', PZWR_ANC_DT: '2026.11.20', CTRT_ST_DT: '2026.12.10' },
      { HS_SBSC_ACP_TRG_CD_NM: '일반공급 1순위', ACP_DTTM: '2026.11.09 10:00 ~ 2026.11.09 17:00', PZWR_ANC_DT: '2026.11.20', CTRT_ST_DT: '2026.12.10' },
      { HS_SBSC_ACP_TRG_CD_NM: '일반공급 2순위', ACP_DTTM: '2026.11.10 10:00 ~ 2026.11.10 17:00', PZWR_ANC_DT: '2026.11.27', CTRT_ST_DT: '2026.12.10' },
    ],
  },
  { dsCtrtPlc: [{ CTRT_PLC_ADR: '서울특별시 강서구 마곡동 999', CTRT_PLC_DTL_ADR: '견본주택' }] },
];
const supplyBody = (price = '1,000,000,000') => [
  { dsList01Nm: [{ HTY_NM: '주택형', SIL_AMT: '분양금액' }] },
  { dsList01: [{ BZDT_NM: '마곡 A1블록', HTY_NM: '084A', RSDN_DDO_AR: '84.0', SPL_AR: '112.5', SIL_AMT: price, SIL_HSH_CNT: '100', TOT_HSH_CNT: '300' }] },
];

const listNotice = (extra = {}) => ({
  key: 'LH-m1',
  source: 'LH',
  kind: 'lh',
  typeLabel: '분양주택 공공분양',
  name: '마곡 공공분양주택 입주자모집공고',
  region: '서울',
  address: '서울특별시 강서구',
  winnerDate: null,
  noticeStatus: '공고중',
  flags: {},
  stages: [{ name: '공고~마감', start: '2026-11-01', end: '2026-11-20' }],
  overallStart: '2026-11-01',
  overallEnd: '2026-11-20',
  ...extra,
});

test('applying the detail replaces stages, overall dates, winner date and address, and falls back piece by piece', () => {
  const failed = [];
  const { notice, scheduleParsed, modelsParsed } = applyLhDetail(listNotice(), { detail: detailBody(), supply: supplyBody() }, { lh: config.lh, onFail: (field) => failed.push(field) });
  assert.equal(scheduleParsed, true);
  assert.equal(modelsParsed, true);
  assert.deepEqual(notice.stages.map((stage) => stage.name), ['특별공급', '1순위 일반공급', '2순위 일반공급']);
  assert.equal(notice.overallStart, '2026-11-05');
  assert.equal(notice.overallEnd, '2026-11-10');
  assert.equal(notice.winnerDate, '2026-11-27');
  assert.equal(notice.address, '서울특별시 강서구 마곡동 123-45 일원');
  assert.equal(notice.flags.priceCap, true);
  assert.deepEqual(notice.models.map((model) => [model.houseType, model.area, model.price, model.households]), [['084A', 84, 100000, 100]]);
  assert.deepEqual(failed, []);
  // Notion 열이 청약홈과 같은 이름으로 채워진다.
  const props = buildProperties(notice, null, today);
  assert.equal(props['특별공급 접수일'].date.start, '2026-11-05');
  assert.equal(props['1순위 접수일'].date.start, '2026-11-09');
  assert.equal(props['2순위 접수일'].date.start, '2026-11-10');
  assert.equal(props['당첨자발표일'].date.start, '2026-11-27');
  assert.equal(props['접수 시작일'].date.start, '2026-11-05');
  assert.equal(props['접수 종료일'].date.start, '2026-11-10');

  // 일정을 하나도 읽지 못하면 예전 단계와 전체 날짜를 둔다.
  const unreadable = applyLhDetail(listNotice(), { detail: detailBody({ schedule: [{ HS_SBSC_ACP_TRG_CD_NM: '특별공급', ACP_DTTM: '추후 공지' }] }), supply: null }, { lh: config.lh });
  assert.equal(unreadable.scheduleParsed, false);
  assert.deepEqual(unreadable.notice.stages, listNotice().stages);
  assert.equal(unreadable.notice.overallStart, '2026-11-01');
  assert.equal(unreadable.notice.models, undefined);
  // 상세가 실패하면 주택형을 읽어도 단지 주소가 없어 판별에 쓰지 않는다.
  const supplyOnly = applyLhDetail(listNotice(), { detail: null, supply: supplyBody() }, { lh: config.lh });
  assert.equal(supplyOnly.modelsParsed, true);
  assert.equal(supplyOnly.notice.models, undefined);
  assert.equal(supplyOnly.notice.lhModelsUnattached, true);
  assert.equal(supplyOnly.modelsAttached, false);
  assert.equal(supplyOnly.notice.address, '서울특별시 강서구');
  // 모르는 유형은 분양가상한제로 보지 않는다.
  assert.equal(applyLhDetail(listNotice({ typeLabel: '공공주택 기타' }), { detail: detailBody() }, { lh: config.lh }).notice.flags.priceCap, false);
});

// 같은 단가의 비교 단지 두 곳, 각 5건. 신뢰도 중이다(src/lotto.js 테스트와 같은 구성).
const trades = (unit) => ['a1', 'a2'].flatMap((jibun) => Array.from({ length: 5 }, () => ({ amount: unit * 84, area: 84, umd: '마곡동', buildYear: 2026, jibun })));

const evaluateLh = (notice, data) => evaluateLotto(notice, {
  config,
  today,
  getModels: async () => { throw new Error('LH must not call getModels'); },
  getTrades: async () => data,
});

test('an LH sale notice with models and an address is priced with the priceCap trigger in both directions', async () => {
  const { notice } = applyLhDetail(listNotice(), { detail: detailBody(), supply: supplyBody() }, { lh: config.lh });
  const high = await evaluateLh(notice, trades(2200));
  assert.equal(high.status, STATUS.LOTTO);
  assert.equal(high.confidence, '중');
  assert.ok(high.reason.startsWith('LH 공공분양(분양가상한제); 안전 마진 8.0억'), high.reason);
  const low = await evaluateLh(notice, trades(1100));
  assert.equal(low.status, STATUS.NOT);
  assert.ok(low.margin < 0);
  assert.ok(low.reason.startsWith('LH 공공분양(분양가상한제) 해당이나 시세 대비 이점 없음'), low.reason);
  // 추정이 없으면 다른 분양가상한제 공고와 달리 로또가 아니라 판별 불가다(비교 단지 없는 신도시 블록).
  const none = await evaluateLh(notice, []);
  assert.equal(none.status, STATUS.UNDETERMINED);
  assert.equal(none.reason, 'LH 공공분양; 시세 추정 없음(실거래 표본 부족)');
  assert.equal(none.averagePrice, 100000);
  // 이전 로또는 유지된다.
  assert.equal(keepPreviousLotto(none, STATUS.LOTTO).status, STATUS.LOTTO);
  // 신뢰도 하 추정은 다른 조건형 공고처럼 양수 마진이어도 로또가 아니라 확인 필요다.
  const weak = await evaluateLh(notice, trades(2200).slice(0, 5));
  assert.equal(weak.confidence, '하');
  assert.equal(weak.status, STATUS.CHECK);
});

test('a failed or capped LH lookup is 판별 불가, missing data stays 대상 외', async () => {
  const pending = [
    ['failed', 'LH 상세 조회 실패'],
    ['capped', 'LH 상세 조회 한도 초과'],
    ['supply_failed', 'LH 공급 정보 조회 실패'],
  ];
  for (const [state, reason] of pending) {
    const result = await evaluateLh(listNotice({ lhDetailState: state }), trades(2200));
    assert.equal(result.status, STATUS.UNDETERMINED, state);
    assert.equal(result.reason, reason + ' (공고중)', state);
  }
  const missing = [
    [{ lhDetailState: 'no_codes' }, 'LH 상세 정보 없음'],
    [{ lhDetailState: 'ok' }, 'LH 공급 정보 없음'],
    [{ lhDetailState: 'ok', lhModelsUnattached: true }, 'LH 단지 주소 미매핑'],
  ];
  for (const [extra, reason] of missing) {
    const result = await evaluateLh(listNotice(extra), trades(2200));
    assert.equal(result.status, STATUS.OUT_OF_SCOPE, reason);
    assert.equal(result.reason, reason + ' (공고중)', reason);
  }
  // 제한 유형은 조회가 실패해도 대상 외다.
  assert.equal((await evaluateLh(listNotice({ name: '마곡 나눔형', lhDetailState: 'failed' }), [])).status, STATUS.OUT_OF_SCOPE);
});

test('LH notices without detail data, without a mapped address or of restricted types stay 대상 외', async () => {
  const noDetail = await evaluateLh(listNotice(), trades(2200));
  assert.equal(noDetail.status, STATUS.OUT_OF_SCOPE);
  assert.equal(noDetail.reason, 'LH 상세 정보 없음 (공고중)');

  const unmapped = applyLhDetail(listNotice(), { detail: detailBody({ address: '어딘가 모르는 곳' }), supply: supplyBody() }, { lh: config.lh }).notice;
  const unmappedResult = await evaluateLh({ ...unmapped, region: '서울' }, trades(2200));
  assert.equal(unmappedResult.status, STATUS.OUT_OF_SCOPE);
  assert.equal(unmappedResult.reason, 'LH 단지 주소 미매핑 (공고중)');

  // 토지임대부와 지분적립형은 예전처럼 마진을 비운다. 나눔형과 신혼희망타운은 참고 마진을 적는다(아래 테스트).
  for (const [extra, keyword] of [
    [{ typeLabel: '분양주택 토지임대부' }, '토지임대'],
    [{ name: '마곡 지분적립형 분양주택' }, '지분적립'],
    // 나눔형이어도 토지임대부가 섞이면 비운다. 근거의 이름은 restrictedType이 처음 찾은 것(이름 먼저)이다.
    [{ name: '마곡 나눔형 입주자모집공고', typeLabel: '분양주택 토지임대부' }, '나눔형'],
  ]) {
    const { notice } = applyLhDetail(listNotice(extra), { detail: detailBody(), supply: supplyBody() }, { lh: config.lh });
    const result = await evaluateLh(notice, trades(2200));
    assert.equal(result.status, STATUS.OUT_OF_SCOPE, keyword);
    assert.equal(result.reason, `제한 유형(${keyword})은 로또 판별과 안전 마진 대상이 아님`, keyword);
    assert.equal(result.clearMarket, true);
    assert.equal(result.margin, null);
    assert.equal(result.averagePrice, 100000);
  }
});

test('LH 나눔형 and 신혼희망타운 notices get a reference margin and stay 대상 외', async () => {
  for (const [extra, head, margin] of [
    [{ name: '뉴:홈 마곡 나눔형 입주자모집공고' }, '참고 마진(차익 공유 유형, 내 몫 ×0.7) 5.6억, 마진율 56%; (조정 전) 안전 마진 8.0억', 56000],
    [{ typeLabel: '분양주택 나눔형' }, '참고 마진(차익 공유 유형, 내 몫 ×0.7) 5.6억, 마진율 56%; (조정 전) 안전 마진 8.0억', 56000],
    [{ typeLabel: '공공분양신혼희망 공공분양신혼희망' }, '참고 마진(신혼희망타운: 수익공유형 대출 조건 확인); 안전 마진 8.0억', 80000],
  ]) {
    const { notice } = applyLhDetail(listNotice(extra), { detail: detailBody(), supply: supplyBody() }, { lh: config.lh });
    const result = await evaluateLh(notice, trades(2200));
    assert.equal(result.status, STATUS.OUT_OF_SCOPE, head);
    assert.ok(result.reason.startsWith(head), result.reason);
    assert.equal(result.margin, margin);
    assert.equal(result.marginRate, margin / 100000);
    assert.equal(result.confidence, '중');
    assert.equal(result.topPrice, 100000);
    assert.equal(result.averagePrice, 100000);
    assert.equal(result.clearMarket, undefined);
    assert.equal(result.referenceMargin, true);
    // 이전 로또를 되살리지 않는다.
    assert.equal(keepPreviousLotto(result, STATUS.LOTTO).status, STATUS.OUT_OF_SCOPE);
  }
  // 조회 실패·상한은 이번에는 모르는 것이라 저장된 값을 지우지 않는다. 자료가 없으면 예전처럼 지운다.
  const failed = await evaluateLh(listNotice({ name: '마곡 나눔형', lhDetailState: 'failed' }), trades(2200));
  assert.equal(failed.status, STATUS.OUT_OF_SCOPE);
  assert.equal(failed.reason, '제한 유형(나눔형)은 로또 판별 대상이 아님; 참고 마진 없음(LH 상세 조회 실패)');
  assert.equal(failed.clearMarket, undefined);
  // 이번에 모르는 것이어도 대상 외라 저장된 로또를 되살리지 않는다.
  assert.equal(keepPreviousLotto(failed, STATUS.LOTTO).status, STATUS.OUT_OF_SCOPE);
  // 분양 유형이 아닌 LH 공고는 시세를 보지 않는다.
  const rental = applyLhDetail(listNotice({ name: '마곡 나눔형', typeLabel: '임대주택 국민임대' }), { detail: detailBody(), supply: supplyBody() }, { lh: config.lh }).notice;
  const rentalResult = await evaluateLh(rental, trades(2200));
  assert.equal(rentalResult.reason, '제한 유형(나눔형)은 로또 판별 대상이 아님; 참고 마진 없음(판별 대상 유형이 아님)');
  assert.equal(rentalResult.margin, null);
  const noData = await evaluateLh(listNotice({ name: '마곡 나눔형', lhDetailState: 'ok' }), trades(2200));
  assert.equal(noData.reason, '제한 유형(나눔형)은 로또 판별 대상이 아님; 참고 마진 없음(LH 공급 정보 없음)');
  assert.equal(noData.clearMarket, true);
  const unmapped = applyLhDetail(listNotice({ name: '마곡 나눔형' }), { detail: detailBody({ address: '어딘가 모르는 곳' }), supply: supplyBody() }, { lh: config.lh }).notice;
  const unmappedResult = await evaluateLh({ ...unmapped, region: '서울' }, trades(2200));
  assert.equal(unmappedResult.reason, '제한 유형(나눔형)은 로또 판별 대상이 아님; 참고 마진 없음(LH 단지 주소 미매핑)');
  assert.equal(unmappedResult.clearMarket, true);
  const { notice } = applyLhDetail(listNotice({ name: '마곡 나눔형' }), { detail: detailBody(), supply: supplyBody() }, { lh: config.lh });
  const noSamples = await evaluateLh(notice, []);
  assert.equal(noSamples.reason, '제한 유형(나눔형)은 로또 판별 대상이 아님; 참고 마진 없음(실거래 표본 부족)');
  assert.equal(noSamples.clearMarket, true);
  assert.equal(noSamples.margin, null);
  assert.equal(noSamples.averagePrice, 100000);
});

const SECRET_VALUES = ['마곡 A1블록', '서울특별시 강서구 마곡동', '123-45', '1,000,000,000', '1000000000', '견본주택', '2026.11.05', '84.0', '112.5', '2029.03'];

test('value shapes mask digits, Hangul and letters and keep only cleaned stage labels', () => {
  assert.equal(valueShape('2026.11.05 10:00 ~ 2026.11.06 17:00'), '9999.99.99 99:99 ~ 9999.99.99 99:99');
  assert.equal(valueShape('1,000,000,000원'), '9,999,999,999가');
  assert.equal(valueShape(84.97), 'N99.99');
  assert.equal(valueShape('84.97㎡'), '99.99㎡');
  assert.equal(valueShape('Abc\t12\n가나'), 'aaa 99 가가');
  assert.equal(valueShape('漢字ㄱ'), '***');
  assert.equal(valueShape(''), 'EMPTY');
  assert.equal(valueShape(null), 'NULL');
  assert.equal(valueShape(true), 'OTHER');
  assert.equal(valueShape('1'.repeat(60)).length, 40);

  const log = createShapeLog(config.lh.labelLogWords);
  collectValueShapes({ detail: detailBody(), supply: supplyBody() }, log);
  collectValueShapes({ detail: detailBody({ schedule: [{ HS_SBSC_ACP_TRG_CD_NM: '<script>특별공급 A-1 서울특별시 강서구 마곡동 123</script>', ACP_DTTM: '20261105' }] }), supply: supplyBody(1000000000) }, log);
  const line = formatShapeLine(log);
  assert.equal(line, 'lh_value_shapes '
    + 'ACP_DTTM=[9999.99.99 99:99 ~ 9999.99.99 99:99]x3,[99999999]x1 '
    + 'PZWR_ANC_DT=[9999.99.99]x3 CTRT_ST_DT=[9999.99.99]x3 '
    + 'SIL_AMT=[9,999,999,999]x1,[N9999999999]x1 RSDN_DDO_AR=[99.9]x2 SPL_AR=[999.9]x2 MVIN_XPC_YM=[9999.99]x2 '
    + 'HS_SBSC_ACP_TRG_CD_NM=[(기타)]x1,[일반공급 1순위]x1,[일반공급 2순위]x1,[특별공급]x1');
  for (const value of SECRET_VALUES) assert.ok(!line.includes(value), value);
  assert.equal(formatShapeLine(createShapeLog()), 'lh_value_shapes ACP_DTTM=none PZWR_ANC_DT=none CTRT_ST_DT=none SIL_AMT=none RSDN_DDO_AR=none SPL_AR=none MVIN_XPC_YM=none HS_SBSC_ACP_TRG_CD_NM=none');
  // 이름은 모든 단어가 허용 단어(config.json의 lh.labelLogWords)일 때만 남긴다. 그 밖은 (기타)다.
  const words = new Set(config.lh.labelLogWords);
  const labels = [
    ['마곡 A1블록 신혼부부', '(기타)'],
    ['강서구 마곡동 특별공급', '(기타)'],
    ['특별공급 문의 0215000000', '(기타)'],
    ['서울특별시', '(기타)'],
    ['신혼부부 12', '(기타)'],
    ['특별공급 래미안', '(기타)'],
    ['신혼부부', '신혼부부'],
    ['예비신혼부부', '예비신혼부부'],
    ['한부모가족', '한부모가족'],
    ['다자녀가구 특별공급', '다자녀가구 특별공급'],
    ['일반공급(1순위) 해당지역', '일반공급(1순위) 해당지역'],
    ['노부모부양·생애최초', '노부모부양·생애최초'],
    ['', '-'],
    ['<b>', '-'],
  ];
  for (const [label, shown] of labels) assert.equal(shapeLabel(label, words), shown, label);
  assert.equal(shapeLabel('신혼부부'), '(기타)');
  // 이름은 많은 순 20개까지다.
  const many = createShapeLog(Array.from({ length: 30 }, (_, index) => '공급' + index));
  collectValueShapes({ detail: detailBody({ schedule: Array.from({ length: 30 }, (_, index) => ({ HS_SBSC_ACP_TRG_CD_NM: `공급${index}` })) }) }, many);
  assert.equal(formatShapeLine(many).split('HS_SBSC_ACP_TRG_CD_NM=')[1].split(',').length, 20);
});

// run() 통합. 청약홈은 비어 있고 LH 목록에 서울 공공분양 공고 하나가 있다.
const lhListRow = (extra = {}) => ({
  PAN_ID: 'm1',
  PAN_NM: '마곡 공공분양주택 입주자모집공고',
  UPP_AIS_TP_NM: '분양주택',
  AIS_TP_CD_NM: '공공분양',
  CNP_CD_NM: '서울특별시 강서구',
  PAN_NT_ST_DT: '2026.11.01',
  CLSG_DT: '2026.11.20',
  PAN_SS: '공고중',
  SPL_INF_TP_CD: '050',
  CCR_CNNT_SYS_DS_CD: '03',
  UPP_AIS_TP_CD: '05',
  AIS_TP_CD: '05',
  ...extra,
});

const xml = (items) => `<response><header><resultCode>000</resultCode></header><body><items>${items.map((item) => `<item>${item}</item>`).join('')}</items><totalCount>${items.length}</totalCount></body></response>`;
const tradeXml = (unit, jibuns = ['a1', 'a2']) => xml(jibuns.flatMap((jibun) => Array.from({ length: 5 }, () => `<aptNm>비교${jibun}</aptNm><dealAmount>${(unit * 84).toLocaleString('en-US')}</dealAmount><excluUseAr>84</excluUseAr><floor>10</floor><umdNm>마곡동</umdNm><jibun>${jibun}</jibun><buildYear>2026</buildYear><dealingGbn>중개거래</dealingGbn><dealYear>2026</dealYear><dealMonth>9</dealMonth><dealDay>3</dealDay>`)));

function runHarness({ unit = 2200, jibuns, rows = [lhListRow()], detail = () => Response.json(detailBody()), supply = () => Response.json(supplyBody()), existing = new Map(), runConfig = config } = {}) {
  const calls = [];
  const fetch = async (url) => {
    const text = String(url);
    calls.push(text);
    if (text.includes('lhLeaseNoticeDtlInfo1')) return detail(text);
    if (text.includes('lhLeaseNoticeSplInfo1')) return supply(text);
    if (text.includes('lhLeaseNoticeInfo1')) return Response.json([{ dsSch: [{}] }, { dsList: rows.map((row) => ({ ...row, ALL_CNT: rows.length })) }]);
    if (text.includes('RTMSDataSvcAptTrade')) return new Response(tradeXml(unit, jibuns));
    if (text.includes('apis.data.go.kr/1613000')) return new Response(xml([]));
    return Response.json({ totalCount: 0, data: [] });
  };
  const state = { upserts: [], stamps: [] };
  const logs = [];
  const mails = [];
  const kakao = [];
  const store = {
    init: async () => {},
    loadExisting: async () => existing,
    upsert: async (notice, evaluation) => {
      state.upserts.push({ notice, evaluation, properties: buildProperties(notice, evaluation, today) });
      return `page-${notice.key}`;
    },
    stampUrgent: async (id, date) => state.stamps.push({ id, date }),
    getWeeklyState: async () => '2026-11-02',
    setWeeklyState: async () => {},
    archivePage: async () => {},
  };
  const deps = {
    fetch,
    store,
    config: runConfig,
    accessToken: 'token',
    sleep: noSleep,
    now: () => new Date('2026-11-04T22:30:00Z'),
    log: (line) => logs.push(line),
    write: () => {},
    sendMail: async (mail) => { mails.push(mail); },
    sendKakao: async (message) => { kakao.push(message); },
  };
  const env = { DATA_GO_KR_KEY: 'SECRET-DATA-KEY', NOTION_KEY: 'n', CHUNGYAK_NOTION_PAGE_ID: 'p' };
  return { deps, env, logs, mails, kakao, state, calls };
}

const lineOf = (h, prefix) => h.logs.find((line) => line.startsWith(`${prefix} `) || line.startsWith(`${prefix}=`));
const summaryOf = (h) => h.logs.find((line) => line.startsWith('collected='));

test('a full run gives an LH sale notice stages, models, an address and a priced lotto status', async () => {
  const high = runHarness({ unit: 2200 });
  assert.equal(await run({ env: high.env, deps: high.deps }), 0);
  const [{ notice, evaluation, properties }] = high.state.upserts;
  assert.deepEqual(notice.stages.map((stage) => [stage.name, stage.start, stage.end]), [['특별공급', '2026-11-05', '2026-11-06'], ['1순위 일반공급', '2026-11-09', '2026-11-09'], ['2순위 일반공급', '2026-11-10', '2026-11-10']]);
  assert.equal(notice.address, '서울특별시 강서구 마곡동 123-45 일원');
  assert.equal(notice.models.length, 1);
  assert.equal(evaluation.status, STATUS.LOTTO);
  assert.equal(evaluation.confidence, '중');
  assert.equal(properties['로또 여부'].select.name, '로또');
  assert.equal(properties['주소'].rich_text[0].text.content, '서울특별시 강서구 마곡동 123-45 일원');
  assert.equal(properties['특별공급 접수일'].date.start, '2026-11-05');
  // 특별공급 접수가 오늘이라 로또 알림이 간다.
  assert.equal(high.kakao.length, 1);
  assert.ok(summaryOf(high).includes(' lh_detail_ok=1 lh_schedule_parsed=1 lh_models_parsed=1 lh_models_unattached=0 lh_model_rows_merged=0 lh_detail_capped=0 lh_supply_capped=0 lh_evaluated=1'), summaryOf(high));
  assert.ok(high.logs.includes('errors=none'), high.logs.join('|'));
  assert.ok(lineOf(high, 'market').endsWith(' soft=none'), lineOf(high, 'market'));
  // 구조 로그는 기본으로 꺼져 있다.
  assert.equal(lineOf(high, 'lh_detail_schema'), undefined);
  assert.ok(lineOf(high, 'lh_value_shapes').includes(' SIL_AMT=[9,999,999,999]x1 '));

  const low = runHarness({ unit: 1100 });
  assert.equal(await run({ env: low.env, deps: low.deps }), 0);
  assert.equal(low.state.upserts[0].evaluation.status, STATUS.NOT);
  assert.ok(low.state.upserts[0].evaluation.margin < 0);
  assert.equal(low.kakao.length, 0);
  assert.ok(summaryOf(low).includes(' lh_evaluated=1'), summaryOf(low));

  for (const h of [high, low]) {
    const all = h.logs.join('\n');
    for (const value of [...SECRET_VALUES, '마곡 공공분양주택', 'SECRET-DATA-KEY']) assert.ok(!all.includes(value), value);
  }
});

test('나눔형 and 신혼희망 LH notices are 대상 외 with a reference margin in a full run, without alerts', async () => {
  const h = runHarness({
    rows: [
      lhListRow({ PAN_ID: 'n1', PAN_NM: '뉴:홈 마곡 나눔형 입주자모집공고' }),
      lhListRow({ PAN_ID: 's1', PAN_NM: '마곡 신혼희망타운 입주자모집공고', UPP_AIS_TP_NM: '공공분양신혼희망', AIS_TP_CD_NM: '공공분양신혼희망' }),
    ],
  });
  // 목요일이라 주간 메일은 강제로 보낸다.
  assert.equal(await run({ argv: ['--force-weekly'], env: h.env, deps: h.deps }), 0);
  assert.deepEqual(h.state.upserts.map((item) => [item.notice.key, item.evaluation.status]), [['LH-n1', STATUS.OUT_OF_SCOPE], ['LH-s1', STATUS.OUT_OF_SCOPE]]);
  const [shared, newlywed] = h.state.upserts;
  assert.ok(shared.evaluation.reason.startsWith('참고 마진(차익 공유 유형, 내 몫 ×0.7) 5.6억, 마진율 56%; (조정 전) 안전 마진 8.0억'), shared.evaluation.reason);
  assert.ok(newlywed.evaluation.reason.startsWith('참고 마진(신혼희망타운: 수익공유형 대출 조건 확인); 안전 마진 8.0억'), newlywed.evaluation.reason);
  // Notion 열: 대상 외, 참고 마진, 마진율, 신뢰도, 추정 시세, 분양가가 채워진다.
  assert.equal(shared.properties['로또 여부'].select.name, '대상 외');
  assert.equal(shared.properties['안전 마진'].number, 56000);
  assert.equal(shared.properties['마진율'].number, 0.56);
  assert.equal(shared.properties['시세 신뢰도'].select.name, '중');
  assert.ok(shared.properties['추정 시세'].number > 0);
  assert.equal(shared.properties['최고 분양가'].number, 100000);
  assert.equal(shared.properties['평균 분양가'].number, 100000);
  assert.equal(newlywed.properties['안전 마진'].number, 80000);
  // 일정은 덮는다. 특별공급 접수가 오늘이어도 로또가 아니라 알림이 없다.
  assert.ok(h.state.upserts.every((item) => item.notice.stages[0].name === '특별공급' && item.notice.stages[0].start === today));
  assert.equal(h.kakao.length, 0);
  assert.equal(h.state.stamps.length, 0);
  // 주간 메일에는 나오지만 로또 표시는 없다.
  const weekly = h.mails.find((mail) => mail.subject.includes('금주 일정'));
  assert.ok(weekly, h.mails.map((mail) => mail.subject).join('|'));
  assert.ok(!weekly.text.includes('[로또]') && !weekly.html.includes('[로또]'), weekly.text);
  assert.ok(summaryOf(h).includes(' lh_detail_ok=2 lh_schedule_parsed=2 lh_models_parsed=2 lh_models_unattached=0 lh_model_rows_merged=0 lh_detail_capped=0 lh_supply_capped=0 lh_evaluated=0 lh_recommended=0 reference_margin=2'), summaryOf(h));
  assert.ok(summaryOf(h).includes(' urgent=0 '), summaryOf(h));
});

test('a full run recommends an LH track per applicant, writes the Notion columns and logs counts only', async () => {
  // 가짜 신청자 정보다. 이름표는 로그에 나오면 안 된다.
  const profile = {
    applicants: [
      { label: '갑돌', birthYear: 1991, residenceSido: '인천', residenceYears: 4, account: null, specialTracks: ['생애최초'] },
      { label: '을순', birthYear: 1993, residenceSido: '경기', residenceYears: 1, account: null, specialTracks: ['신혼부부'] },
    ],
    household: { married: true, marriageRegistered: '2025-03-01' },
  };
  const h = runHarness({
    rows: [
      lhListRow(),
      lhListRow({ PAN_ID: 's1', PAN_NM: '마곡 신혼희망타운 입주자모집공고', UPP_AIS_TP_NM: '공공분양신혼희망', AIS_TP_CD_NM: '공공분양신혼희망' }),
    ],
    detail: (url) => Response.json(detailBody({ schedule: new URL(url).searchParams.get('PAN_ID') === 's1'
      ? [
        { HS_SBSC_ACP_TRG_CD_NM: '신혼부부', ACP_DTTM: '2026.11.09 ~ 2026.11.10' },
        { HS_SBSC_ACP_TRG_CD_NM: '예비신혼부부', ACP_DTTM: '2026.11.11' },
        { HS_SBSC_ACP_TRG_CD_NM: '한부모가족', ACP_DTTM: '2026.11.12' },
      ]
      : [
        { HS_SBSC_ACP_TRG_CD_NM: '생애최초', ACP_DTTM: '2026.11.06' },
        { HS_SBSC_ACP_TRG_CD_NM: '신혼부부', ACP_DTTM: '2026.11.06' },
        { HS_SBSC_ACP_TRG_CD_NM: '다자녀가구', ACP_DTTM: '2026.11.06' },
        { HS_SBSC_ACP_TRG_CD_NM: '일반공급 1순위', ACP_DTTM: '2026.11.09' },
      ] })),
  });
  h.env.CHUNGYAK_PROFILE = JSON.stringify(profile);
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  const byKey = Object.fromEntries(h.state.upserts.map((item) => [item.notice.key, item]));
  const sale = byKey['LH-m1'];
  // 같은 날 특별공급은 신혼부부가 생애최초보다 먼저다.
  assert.equal(sale.properties['추천 전형'].select.name, '을순 특별(신혼부부)');
  assert.deepEqual(sale.properties['추천 접수일'].date, { start: '2026-11-06' });
  assert.ok(sale.evaluation.reason.endsWith('\n추천: 갑돌 생애최초 특별공급 11/6 (1순위 일반공급 11/9도 가능) / 을순 신혼부부 특별공급 11/6 (1순위 일반공급 11/9도 가능); 소득·자산 기준 확인'), sale.evaluation.reason);
  assert.equal(sale.evaluation.status, STATUS.LOTTO);
  const town = byKey['LH-s1'];
  assert.equal(town.properties['로또 여부'].select.name, '대상 외');
  assert.equal(town.properties['안전 마진'].number, 80000);
  assert.equal(town.properties['추천 전형'].select.name, '을순 특별(신혼부부)');
  assert.deepEqual(town.properties['추천 접수일'].date, { start: '2026-11-09', end: '2026-11-10' });
  assert.ok(summaryOf(h).includes(' lh_evaluated=1 lh_recommended=2 reference_margin=1'), summaryOf(h));
  assert.ok(h.logs.includes('recommend profile=ok recommended=2 none=0 version=2 applicants=2'), h.logs.join('\n'));
  const all = h.logs.join('\n');
  for (const value of ['갑돌', '을순', '1991', '2025-03-01', '마곡 공공분양주택', '마곡 신혼희망타운', 'SECRET-DATA-KEY']) assert.ok(!all.includes(value), value);
  // 신청자 정보 없이 돌리면 추천 열을 건드리지 않는다.
  const plain = runHarness();
  assert.equal(await run({ env: plain.env, deps: plain.deps }), 0);
  assert.equal(plain.state.upserts[0].properties['추천 전형'], undefined);
  assert.ok(summaryOf(plain).includes(' lh_recommended=0 '), summaryOf(plain));
});

test('detail or supply failures fall back to the old LH behaviour without an error mail', async () => {
  const failed = runHarness({ detail: () => new Response('denied 마곡 A1블록', { status: 403 }) });
  assert.equal(await run({ env: failed.env, deps: failed.deps }), 0);
  const [{ notice, evaluation }] = failed.state.upserts;
  assert.deepEqual(notice.stages, [{ name: '공고~마감', start: '2026-11-01', end: '2026-11-20' }]);
  assert.equal(notice.address, '서울특별시 강서구');
  assert.equal(notice.models, undefined);
  assert.equal(evaluation.status, STATUS.UNDETERMINED);
  assert.equal(evaluation.reason, 'LH 상세 조회 실패 (공고중)');
  assert.equal(failed.kakao.length, 0);
  assert.ok(!failed.mails.some((mail) => mail.subject.includes('배치 오류')));
  assert.ok(failed.logs.includes('errors=none'), failed.logs.join('|'));
  assert.ok(lineOf(failed, 'market').endsWith(' soft=lh_detail_http_403:1'), lineOf(failed, 'market'));
  assert.ok(summaryOf(failed).includes(' lh_detail_ok=0 lh_schedule_parsed=0 lh_models_parsed=0 '), summaryOf(failed));
  assert.ok(!failed.calls.some((url) => url.includes('lhLeaseNoticeSplInfo1')));

  // 공급 실패: 일정과 주소는 덮고 판별은 하지 않는다. 읽지 못한 값은 lh_parse_failed로 센다.
  const partial = runHarness({
    detail: () => Response.json(detailBody({ schedule: [
      { HS_SBSC_ACP_TRG_CD_NM: '특별공급', ACP_DTTM: '2026.11.05 ~ 2026.11.06', PZWR_ANC_DT: '추후 공지' },
      { HS_SBSC_ACP_TRG_CD_NM: '일반공급', ACP_DTTM: '미정' },
    ] })),
    supply: () => new Response('<OpenAPI_ServiceResponse/>'),
  });
  assert.equal(await run({ argv: ['--dry-run'], env: partial.env, deps: partial.deps }), 0);
  assert.ok(lineOf(partial, 'market').endsWith(' soft=lh_supply_parse:1,lh_parse_failed:PZWR_ANC_DT:1,lh_parse_failed:ACP_DTTM:1'), lineOf(partial, 'market'));
  assert.ok(summaryOf(partial).includes(' lh_detail_ok=1 lh_schedule_parsed=1 lh_models_parsed=0 '), summaryOf(partial));
  assert.equal(partial.mails.length, 0);
  assert.ok(!partial.logs.join('\n').includes('마곡'));

  // 접수가 끝난 공고는 부르지 않는다.
  const closed = runHarness({ rows: [lhListRow({ PAN_NT_ST_DT: '2026.10.01', CLSG_DT: '2026.10.20' })] });
  await run({ env: closed.env, deps: closed.deps });
  assert.ok(!closed.calls.some((url) => url.includes('lhLeaseNoticeDtlInfo1') || url.includes('lhLeaseNoticeSplInfo1')));
});

test('a stored 로또 LH row keeps 로또 when the detail lookup fails', async () => {
  const existing = new Map([['LH-m1', { id: 'page-LH-m1', key: 'LH-m1', lotto: STATUS.LOTTO, urgentDate: null, end: '2026-11-20', name: '마곡 공공분양주택 입주자모집공고' }]]);
  const h = runHarness({ existing, detail: () => new Response('', { status: 500 }) });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  const [{ evaluation }] = h.state.upserts;
  assert.equal(evaluation.status, STATUS.LOTTO);
  assert.ok(evaluation.reason.startsWith('이전 판별 유지 (이번 실행: LH 상세 조회 실패'), evaluation.reason);
  assert.ok(summaryOf(h).includes(' lotto_demoted=0 '), summaryOf(h));
  assert.ok(summaryOf(h).includes(' lh_evaluated=0'), summaryOf(h));
  assert.ok(!h.mails.some((mail) => mail.subject.includes('배치 오류')));
});

test('the call cap applies in key order and capped notices are 판별 불가', async () => {
  const capConfig = { ...config, lh: { ...config.lh, detailMaxCalls: 1 } };
  // 목록 순서(c, a, b)와 다르게 고유 키 순서(LH-a, LH-b, LH-c)로 부른다.
  const rows = ['c', 'a', 'b'].map((id) => lhListRow({ PAN_ID: id }));
  const h = runHarness({ rows, runConfig: capConfig });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  const detailIds = h.calls.filter((url) => url.includes('lhLeaseNoticeDtlInfo1')).map((url) => new URL(url).searchParams.get('PAN_ID'));
  assert.deepEqual(detailIds, ['a']);
  assert.ok(summaryOf(h).includes(' lh_detail_ok=1 lh_schedule_parsed=1 lh_models_parsed=1 lh_models_unattached=0 lh_model_rows_merged=0 lh_detail_capped=2 lh_supply_capped=0 lh_evaluated=1'), summaryOf(h));
  const byKey = Object.fromEntries(h.state.upserts.map((item) => [item.notice.key, item]));
  assert.equal(byKey['LH-a'].evaluation.status, STATUS.LOTTO);
  for (const key of ['LH-b', 'LH-c']) {
    assert.equal(byKey[key].notice.lhDetailState, 'capped', key);
    assert.equal(byKey[key].evaluation.status, STATUS.UNDETERMINED, key);
    assert.equal(byKey[key].evaluation.reason, 'LH 상세 조회 한도 초과 (공고중)', key);
    // 예전 동작: 목록의 공고일~마감일 단계
    assert.equal(byKey[key].notice.stages[0].name, '공고~마감', key);
  }
  // 저장 순서는 목록 순서 그대로다.
  assert.deepEqual(h.state.upserts.map((item) => item.notice.key), ['LH-c', 'LH-a', 'LH-b']);
  assert.ok(lineOf(h, 'market').endsWith(' soft=none'), lineOf(h, 'market'));
});

test('malformed values in all four parsers only add lh_parse_failed soft kinds', async () => {
  const h = runHarness({
    detail: () => Response.json(detailBody({ schedule: [
      { HS_SBSC_ACP_TRG_CD_NM: '특별공급', ACP_DTTM: '2026.13.45', PZWR_ANC_DT: '발표 예정' },
      // YYYYMMDDHH는 받지 않는다.
      { HS_SBSC_ACP_TRG_CD_NM: '1순위', ACP_DTTM: '2026120110' },
    ] })),
    supply: () => Response.json([{ dsList01: [{ BZDT_NM: '마곡 A1블록', HTY_NM: '084A', RSDN_DDO_AR: '84A', SPL_AR: '넓음', SIL_AMT: '5억', SIL_HSH_CNT: '1.5' }] }]),
  });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  const soft = lineOf(h, 'market').split(' soft=')[1].split(',');
  assert.deepEqual(soft.sort(), [
    'lh_parse_failed:ACP_DTTM:2',
    'lh_parse_failed:PZWR_ANC_DT:1',
    'lh_parse_failed:RSDN_DDO_AR:1',
    'lh_parse_failed:SIL_AMT:1',
    'lh_parse_failed:SIL_HSH_CNT:1',
    'lh_parse_failed:SPL_AR:1',
  ]);
  assert.ok(h.logs.includes('errors=none'));
  // 읽지 못해 예전 동작이다: 단계는 목록 값이고 주택형이 없다.
  const [{ notice, evaluation }] = h.state.upserts;
  assert.equal(notice.stages[0].name, '공고~마감');
  assert.equal(evaluation.reason, 'LH 공급 정보 없음 (공고중)');
});

test('a full run drops a stored 로또 when a 하 estimate is clearly negative', async () => {
  // 비교 단지 1곳(신뢰도 하), 마진율이 lotto.lowConfidenceMinMarginRate(-5%)보다 낮다.
  const existing = () => new Map([['LH-m1', { id: 'page-LH-m1', key: 'LH-m1', lotto: STATUS.LOTTO, urgentDate: null, end: '2026-11-20', name: '마곡 공공분양주택 입주자모집공고' }]]);
  const h = runHarness({ unit: 1100, jibuns: ['a1'], existing: existing() });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  const [{ evaluation, properties }] = h.state.upserts;
  assert.equal(evaluation.confidence, '하');
  assert.ok(evaluation.marginRate <= -0.05, String(evaluation.marginRate));
  assert.equal(evaluation.status, STATUS.NOT);
  assert.equal(evaluation.lowConfidenceNegative, true);
  assert.ok(evaluation.reason.startsWith('LH 공공분양(분양가상한제) 해당이나 시세 대비 이점 없음(신뢰도 하, 마진율 ≤ -5%); '), evaluation.reason);
  assert.equal(properties['로또 여부'].select.name, STATUS.NOT);
  assert.equal(h.kakao.length, 0);
  assert.ok(summaryOf(h).includes(' lotto_demoted=1 '), summaryOf(h));
  assert.ok(lineOf(h, 'market').endsWith(' soft=none'), lineOf(h, 'market'));

  // 규칙을 끄면(null) 예전처럼 놓치지 않게 로또다.
  const off = runHarness({ unit: 1100, jibuns: ['a1'], existing: existing(), runConfig: { ...config, lotto: { ...config.lotto, lowConfidenceMinMarginRate: null } } });
  assert.equal(await run({ env: off.env, deps: off.deps }), 0);
  assert.equal(off.state.upserts[0].evaluation.status, STATUS.LOTTO);
  assert.ok(summaryOf(off).includes(' lotto_demoted=0 '), summaryOf(off));
});
