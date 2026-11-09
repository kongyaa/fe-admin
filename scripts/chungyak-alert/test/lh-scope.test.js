import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalizeLh } from '../src/sources/lh.js';
import { ENDPOINTS, normalizeDetail } from '../src/sources/applyhome.js';
import { formatLhTypes, isLhItem, isUnknownLhType, lhAreaRule, lhScopeRule, lhTypeClass, lhTypeLogLabel, lhTypeRule, storedLhScopeRule } from '../src/lh-scope.js';
import { restrictedType } from '../src/market-estimate.js';
import { rentalRule } from '../src/rental.js';
import { splitLhScope } from '../src/main.js';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const lh = config.lh;
// 수집한 LH 공고 모양. 이름과 유형은 꾸며낸 값이다.
const lhNotice = (typeLabel, name, region = '서울', extra = {}) => ({ key: 'LH-1', kind: 'lh', source: 'LH', typeLabel, name, region, ...extra });

test('config carries the LH scope lists', () => {
  assert.equal(lh.filterSaleArea, true);
  assert.deepEqual(lh.targetRegions, ['서울']);
  assert.deepEqual(lh.targetAreas.map((area) => area.name), ['하남교산', '광명시흥', '구리갈매', '구리토평', '남양주왕숙']);
  for (const list of [lh.saleTypes, lh.nonSaleTypes, lh.excludeKeywords]) assert.ok(Array.isArray(list) && list.length > 0);
});

test('sale types are kept', () => {
  const kept = [
    ['분양주택 공공분양', 'A1블록 공공분양주택 입주자모집'],
    ['분양주택 공공분양', '뉴홈 일반형 공공분양'],
    ['분양주택 공공분양', '뉴홈 나눔형 공공분양'],
    ['공공분양', '나눔형 입주자모집'],
    ['분양주택 뉴홈', '일반형 입주자모집'],
    ['나눔형', '뉴홈 공고'],
    ['신혼희망타운 신혼희망타운', '신혼희망타운 분양형 입주자모집'],
    ['신혼희망타운', '신혼희망타운(공공분양)'],
    ['분양주택 공공분양', '공공분양주택 잔여세대 추가모집'],
    ['분양주택 공공분양', '공공분양 무순위 모집'],
    ['분양주택', '분양주택 추가 입주자모집'],
  ];
  for (const [type, name] of kept) assert.equal(lhTypeRule(lhNotice(type, name), lh), null, `${type} / ${name}`);
});

test('non-sale types are dropped as type', () => {
  const dropped = [
    // 선택형(임대 후 분양 선택)
    ['분양주택 공공분양', '뉴홈 선택형 입주자모집'],
    ['분양주택 선택형', '입주자모집'],
    ['공공분양', '뉴홈 선택 형'],
    // 분양전환 공공임대(10년/5년)
    ['임대주택 분양전환공공임대', '10년 공공임대 입주자모집'],
    ['분양주택 분양전환', '분양전환 공고'],
    ['', '5년 분양전환 공공임대'],
    // 토지, 상가, 일반매각, 주택매각
    ['토지', '공동주택용지 공급'],
    ['토지 일반매각', '용지 공급'],
    ['상가', '단지 내 상가 입찰'],
    ['분양주택', '주택 매각 공고'],
    ['', '일반매각 공고'],
    ['주택매각', '공고'],
    // 임대 유형
    ['임대주택 국민임대', '국민임대 입주자모집'],
    ['임대주택 행복주택', '행복주택 입주자모집'],
    ['임대주택 영구임대', '영구임대'],
    ['임대주택 공공임대', '공공임대'],
    ['신혼희망타운 행복주택', '신혼희망타운 임대형'],
    ['주거복지 매입임대', '매입임대'],
    ['주거복지 전세임대', '전세임대'],
    ['임대주택 장기전세', '장기전세'],
    ['주거복지', '주거복지 공고'],
  ];
  for (const [type, name] of dropped) assert.equal(lhTypeRule(lhNotice(type, name), lh), 'type', `${type} / ${name}`);
});

test('an unreadable type is kept and the area rule still applies', () => {
  for (const type of ['', null, undefined, 'LH', '  ']) {
    assert.equal(lhTypeRule(lhNotice(type, '입주자모집'), lh), null, String(type));
    assert.equal(lhScopeRule(lhNotice(type, '입주자모집', '서울'), config), null, String(type));
    assert.equal(lhScopeRule(lhNotice(type, '입주자모집', '부산'), config), 'area', String(type));
  }
});

test('a 서울 notice is kept without a district keyword', () => {
  assert.equal(lhScopeRule(lhNotice('분양주택 공공분양', '서울 어느 지구 공공분양'), config), null);
  // 공급지역 값은 normalizeRegion을 거친 값이다.
  const raw = normalizeLh({ PAN_ID: 's', PAN_NM: '어느 지구 공공분양', UPP_AIS_TP_NM: '분양주택', AIS_TP_CD_NM: '공공분양', CNP_CD_NM: '서울특별시 강서구', PAN_NT_ST_DT: '2026.11.01', CLSG_DT: '2026.11.20' }, lh.excludeTypeKeywords);
  assert.equal(raw.region, '서울');
  assert.equal(lhScopeRule(raw, config), null);
});

test('each district keyword keeps a 경기 notice, with spacing variants', () => {
  for (const area of lh.targetAreas) {
    for (const keyword of area.keywords) {
      assert.equal(lhAreaRule(lhNotice('분양주택 공공분양', `${keyword} A1블록 공공분양`, '경기'), lh), null, keyword);
    }
  }
  const spaced = ['하남 교산 A2', '하남교산지구', '광명 시흥 A1', '광명시흥 1블록', '구리 갈매 역세권', '갈매 역세권 A1', '구리 토평 A3', '토평지구', '남양주 왕숙 A5', '남양주왕숙2 A1', '하남  교산'];
  for (const name of spaced) assert.equal(lhScopeRule(lhNotice('분양주택 공공분양', `${name} 공공분양`, '경기'), config), null, name);
  const raw = normalizeLh({ PAN_ID: 'g', PAN_NM: '하남 교산 A1 공공분양', UPP_AIS_TP_NM: '분양주택', AIS_TP_CD_NM: '공공분양', CNP_CD_NM: '경기도 하남시', PAN_NT_ST_DT: '2026.11.01', CLSG_DT: '2026.11.20' }, lh.excludeTypeKeywords);
  assert.equal(raw.region, '경기');
  assert.equal(lhScopeRule(raw, config), null);
});

test('a 경기 notice outside the districts and other 시도 are dropped as area', () => {
  for (const name of ['고양창릉 A4 공공분양', '부천대장 A1 공공분양', '남양주 진접2 공공분양', '하남 감일 공공분양', '구리 인창 공공분양']) {
    assert.equal(lhScopeRule(lhNotice('분양주택 공공분양', name, '경기'), config), 'area', name);
  }
  for (const region of ['인천', '부산', '세종', '충남', null]) {
    assert.equal(lhScopeRule(lhNotice('분양주택 공공분양', '어느 지구 공공분양', region), config), 'area', String(region));
  }
  assert.equal(lhScopeRule(lhNotice('분양주택 공공분양', '인천계양 A2 공공분양', '인천'), config), 'area');
});

test('the type reason wins when both rules fail', () => {
  assert.equal(lhScopeRule(lhNotice('임대주택 국민임대', '고양창릉 국민임대', '경기'), config), 'type');
});

test('applyhome notices are not touched by the LH filter', () => {
  const detail = normalizeDetail(ENDPOINTS.find((item) => item.op === 'getAPTLttotPblancDetail'), { HOUSE_MANAGE_NO: '1', PBLANC_NO: '1', HOUSE_NM: '선택형 이름의 단지', HOUSE_SECD: '01', SUBSCRPT_AREA_CODE_NM: '부산' });
  assert.equal(isLhItem(detail), false);
  assert.equal(lhScopeRule(detail, config), null);
  assert.equal(storedLhScopeRule({ key: '1-1', source: '청약홈', typeLabel: 'APT', name: '부산 단지', region: '부산' }, config), null);
});

test('stored rows are judged on their stored type, name and region', () => {
  const row = (extra) => ({ id: 'p', key: 'LH-1', interest: false, typeLabel: '분양주택 공공분양', name: '어느 지구 공공분양', region: '서울', ...extra });
  assert.equal(storedLhScopeRule(row(), config), null);
  assert.equal(storedLhScopeRule(row({ region: '부산' }), config), 'area');
  assert.equal(storedLhScopeRule(row({ region: '경기', name: '하남 교산 공공분양' }), config), null);
  assert.equal(storedLhScopeRule(row({ typeLabel: '임대주택 행복주택' }), config), 'type');
  assert.equal(storedLhScopeRule(row({ name: '뉴홈 선택형' }), config), 'type');
  // 소스만 LH인 행도 LH로 본다.
  assert.equal(storedLhScopeRule(row({ key: 'x', source: 'LH', region: '부산' }), config), 'area');
  // 읽을 수 없는 행은 남긴다.
  assert.equal(storedLhScopeRule(row({ region: null }), config), null);
  assert.equal(storedLhScopeRule(row({ name: '' }), config), null);
  assert.equal(storedLhScopeRule(row({ name: 'LH-1', region: '부산' }), config), null);
  assert.equal(storedLhScopeRule(row({ typeLabel: null, region: '서울' }), config), null);
});

test('the flag turns the LH filter off', () => {
  const off = { ...config, lh: { ...lh, filterSaleArea: false } };
  assert.equal(lhScopeRule(lhNotice('임대주택 국민임대', '공고', '부산'), off), null);
  assert.equal(storedLhScopeRule({ key: 'LH-1', typeLabel: '토지', name: '공고', region: '부산' }, off), null);
});

test('splitLhScope keeps checked rows and counts by reason', () => {
  const notices = [
    lhNotice('분양주택 공공분양', '서울 공공분양', '서울', { key: 'LH-in' }),
    lhNotice('분양주택 공공분양', '어느 공고', '부산', { key: 'LH-area' }),
    lhNotice('분양주택 공공분양', '뉴홈 선택형', '서울', { key: 'LH-type' }),
    lhNotice('분양주택 공공분양', '어느 공고', '부산', { key: 'LH-checked' }),
    // 모르는 유형은 남기고 센다. 서울이라 지역 규칙도 통과한다.
    lhNotice('기타', '어느 공고', '서울', { key: 'LH-unknown' }),
    { key: '1-1', kind: 'apt', source: '청약홈', typeLabel: 'APT', name: '단지', region: '부산' },
  ];
  const rows = new Map([
    ['LH-area', { id: 'a', key: 'LH-area', interest: false, name: '어느 공고', typeLabel: null, region: null }],
    ['LH-checked', { id: 'c', key: 'LH-checked', interest: true, name: '어느 공고', typeLabel: null, region: null }],
    ['LH-old', { id: 'o', key: 'LH-old', interest: false, name: '다른 공고', typeLabel: '분양주택 공공분양', region: '대구' }],
    ['LH-kept', { id: 'k', key: 'LH-kept', interest: true, name: '다른 공고', typeLabel: '토지', region: '서울' }],
    ['1-1', { id: 'x', key: '1-1', interest: false, name: '단지', typeLabel: 'APT', region: '부산' }],
  ]);
  const result = splitLhScope(notices, rows, config);
  assert.deepEqual(result.notices.map((item) => item.key), ['LH-in', 'LH-checked', 'LH-unknown', '1-1']);
  assert.deepEqual(result.archiveRows.map((row) => row.id), ['a', 'o']);
  assert.deepEqual(result.counts, { lh_out_of_scope_skipped: 2, lh_out_of_scope_type: 1, lh_out_of_scope_area: 1, lh_out_of_scope_archived: 0, lh_out_of_scope_kept_interest: 2, lh_type_unknown: 1 });
});

test('an unknown non-empty type is kept and counted, and the area rule still applies', () => {
  for (const type of ['기타', '공공주택', '분양 기타']) {
    assert.equal(lhTypeClass(lhNotice(type, '입주자모집'), lh), 'unknown', type);
    assert.equal(lhTypeRule(lhNotice(type, '입주자모집'), lh), null, type);
    assert.equal(isUnknownLhType(lhNotice(type, '입주자모집'), config), true, type);
    assert.equal(lhScopeRule(lhNotice(type, '입주자모집', '서울'), config), null, type);
    assert.equal(lhScopeRule(lhNotice(type, '입주자모집', '부산'), config), 'area', type);
    assert.equal(lhScopeRule(lhNotice(type, '하남교산 입주자모집', '경기'), config), null, type);
  }
  // 알려진 유형, 빈 유형, 청약홈 공고, 꺼진 기능은 세지 않는다.
  assert.equal(isUnknownLhType(lhNotice('분양주택 공공분양', '공고'), config), false);
  assert.equal(isUnknownLhType(lhNotice('임대주택 국민임대', '공고'), config), false);
  assert.equal(isUnknownLhType(lhNotice('LH', '공고'), config), false);
  assert.equal(isUnknownLhType({ key: '1-1', kind: 'apt', typeLabel: '기타', name: '단지' }, config), false);
  assert.equal(isUnknownLhType(lhNotice('기타', '공고'), { ...config, lh: { ...lh, filterSaleArea: false } }), false);
  // 저장된 행도 모르는 유형이면 지역만 본다.
  assert.equal(storedLhScopeRule({ key: 'LH-1', typeLabel: '기타', name: '공고', region: '서울' }, config), null);
  assert.equal(storedLhScopeRule({ key: 'LH-1', typeLabel: '기타', name: '공고', region: '부산' }, config), 'area');
});

test('토지임대부 분양 is a sale before the non-sale words, and the rental filter keeps it', () => {
  const cases = [
    ['분양주택 토지임대부', '공공분양 입주자모집'],
    ['토지임대부', '입주자모집'],
    ['토지', '토지임대부 분양주택 입주자모집'],
    ['분양주택 공공분양', '토지 임대부 분양주택'],
    ['', '토지임대부 분양주택'],
  ];
  for (const [type, name] of cases) {
    const item = lhNotice(type, name);
    assert.equal(lhTypeClass(item, lh), 'sale', `${type} / ${name}`);
    assert.equal(lhScopeRule(item, config), null, `${type} / ${name}`);
    assert.equal(lhScopeRule({ ...item, region: '부산' }, config), 'area', `${type} / ${name}`);
  }
  // 임대 필터가 먼저 돌므로 거기서도 빠지면 안 된다.
  for (const [type, name] of [['분양주택 토지임대부', '공고'], ['토지임대부', '공고'], ['분양주택 공공분양', '토지임대부 분양주택']]) {
    assert.equal(rentalRule({ kind: 'lh', typeLabel: type, name }, config), null, `${type} / ${name}`);
  }
  // 예외 말을 지워도 남는 임대 단어는 그대로 본다.
  assert.equal(rentalRule({ kind: 'lh', typeLabel: '토지임대부 국민임대', name: '공고' }, config), 'type_keyword');
  assert.equal(rentalRule({ kind: 'lh', typeLabel: 'LH', name: '토지임대부 옆 영구임대' }, config), 'name_keyword');
  // 수집 단계의 토지·상가 제외(lh.excludeTypeKeywords)도 토지임대부는 빼지 않는다.
  const raw = (upper, detail, name) => normalizeLh({ PAN_ID: 'l', PAN_NM: name, UPP_AIS_TP_NM: upper, AIS_TP_CD_NM: detail, CNP_CD_NM: '서울특별시' }, lh.excludeTypeKeywords, lh.forceSaleKeywords);
  assert.notEqual(raw('분양주택', '토지임대부', '공고'), null);
  assert.notEqual(raw('토지', '토지임대부', '공고'), null);
  assert.notEqual(raw('토지', '', '토지 임대부 분양주택'), null);
  assert.equal(raw('토지', '공동주택용지', '용지 공급'), null);
  assert.equal(raw('상가', '단지내상가', '상가 입찰'), null);
  // 제외 단어는 여전히 먼저다.
  assert.equal(lhTypeRule(lhNotice('분양주택 토지임대부', '뉴홈 선택형'), lh), 'type');
  // 판별은 제한 유형(대상 외)이 된다. LH 공고는 원래 판별 대상이 아니고, 이름으로 제한 유형이 잡힌다.
  assert.equal(restrictedType({ name: '토지임대부 분양주택', typeLabel: '분양주택 공공분양' }, config.market), '토지임대');
});

test('lh_types labels keep only category characters and never the notice name', () => {
  assert.equal(lhTypeLogLabel({ UPP_AIS_TP_NM: '분양주택', AIS_TP_CD_NM: '공공분양', PAN_NM: '비밀 단지 공고' }), '분양주택/공공분양');
  assert.equal(lhTypeLogLabel({ PAN_NM: '이름만 있는 공고' }), '-/-');
  assert.equal(lhTypeLogLabel({ UPP_AIS_TP_NM: ' 임대 주택 ', AIS_TP_CD_NM: '국민임대(50년)' }), '임대주택/국민임대50년');
  assert.equal(lhTypeLogLabel({ UPP_AIS_TP_NM: '분양주택<script>', AIS_TP_CD_NM: 'a=b,c;d"e\n·10/5' }), '분양주택script/abcde·10/5');
  assert.equal(lhTypeLogLabel({ UPP_AIS_TP_NM: '가'.repeat(50), AIS_TP_CD_NM: null }), `${'가'.repeat(20)}/-`);
});

test('lh_types is sorted by count, then label, and capped', () => {
  const counts = new Map([['b/x', 2], ['a/x', 2], ['c/x', 5], ['d/x', 1]]);
  assert.equal(formatLhTypes(counts), 'c/x=5,a/x=2,b/x=2,d/x=1');
  assert.equal(formatLhTypes(counts, 2), 'c/x=5,a/x=2');
  const many = new Map(Array.from({ length: 40 }, (_, index) => [`t${String(index).padStart(2, '0')}/-`, 40 - index]));
  assert.equal(formatLhTypes(many).split(',').length, 30);
  assert.equal(formatLhTypes(new Map()), '');
});
