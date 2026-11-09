import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { evaluateLotto } from '../src/lotto.js';
import { buildProperties } from '../src/notion-store.js';
import { buildKakaoText } from '../src/notify-kakao.js';
import { ENDPOINTS, normalizeDetail, supplySector } from '../src/sources/applyhome.js';
import {
  chooseApplicant,
  depositCheck,
  depositRequirement,
  estimatePoints,
  parseProfile,
  recommendForProfile,
  recommendLabel,
  recommendTrack,
  specialTrackValid,
  toProfile,
  unapplicableReason,
} from '../src/recommend.js';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const table = config.recommendation.privateDeposit;
const today = '2026-11-05';

// 테스트용 가짜 신청자 정보다. 이름표, 연도, 거주지, 예치금 모두 지어낸 값이다.
const A = {
  label: '신청자A',
  birthYear: 1990,
  residenceSido: '인천',
  residenceYears: 3,
  account: { joined: '2019-03', payments: 40, depositManwon: 350 },
  specialTracks: ['생애최초'],
};
const B = {
  label: '신청자B',
  birthYear: 1995,
  residenceSido: '인천',
  residenceYears: 3,
  account: { joined: null, payments: null, depositManwon: 200 },
  specialTracks: ['신생아', '생애최초'],
  pregnant: true,
  childBirths: [],
};
const HOUSEHOLD = { married: false, marriageRegistered: null };
const V2 = { applicants: [A, B], household: HOUSEHOLD };
const parse = (value) => parseProfile(typeof value === 'string' ? value : JSON.stringify(value));
const profileOf = (value) => parse(value).profile;
const v2With = (patchA = {}, patchB = {}, household = HOUSEHOLD) => profileOf({ applicants: [{ ...A, ...patchA }, { ...B, ...patchB }], household });

const stages = () => [
  { name: '특별공급', start: '2026-11-09', end: '2026-11-09' },
  { name: '1순위 해당', start: '2026-11-10', end: '2026-11-10' },
  { name: '1순위 경기', start: '2026-11-10', end: '2026-11-10' },
  { name: '1순위 기타', start: '2026-11-11', end: '2026-11-11' },
];
const apt = (extra = {}) => ({ key: '1-1', kind: 'apt', houseSecd: '01', sector: '민영', region: '인천', name: '공고단지', announceDate: '2026-11-02', stages: stages(), flags: { priceCap: false, publicDistrict: false }, ...extra });
const model = (specials, area = 84) => ({ houseType: '084A', area, price: 100000, households: 100, specials });
const UNITS = [model({ 신생아: 30, 신혼부부: 10, 생애최초: 20 })];
const recommend = (notice, models, profile, on = today) => recommendForProfile({ notice, models, profile, config, today: on });

// ---------- 파싱 ----------
test('a v2 profile is parsed into normalized applicants and household', () => {
  const { profile, status } = parse(V2);
  assert.equal(status, 'ok');
  assert.equal(profile.version, 2);
  assert.deepEqual(profile.household, HOUSEHOLD);
  // 생략한 임신·출산 값은 false와 빈 배열이다.
  assert.deepEqual(profile.applicants[0], { ...A, pregnant: false, childBirths: [] });
  assert.deepEqual(profile.applicants[1], B);
  // 이름표 앞뒤 공백을 지우고, 전형 중복을 없애고, 통장의 빠진 값은 null이다.
  const trimmed = profileOf({ applicants: [{ ...A, label: ' 신청자A ', specialTracks: ['생애최초', '생애최초'], account: {} }], household: { married: true, marriageRegistered: '2024-05-01' } });
  assert.equal(trimmed.applicants[0].label, '신청자A');
  assert.deepEqual(trimmed.applicants[0].specialTracks, ['생애최초']);
  assert.deepEqual(trimmed.applicants[0].account, { joined: null, payments: null, depositManwon: null });
  assert.deepEqual(trimmed.household, { married: true, marriageRegistered: '2024-05-01' });
  // 혼인했지만 신고일을 모르면 null이다.
  assert.deepEqual(profileOf({ applicants: [A], household: { married: true } }).household, { married: true, marriageRegistered: null });
});

test('an invalid v2 profile turns the feature off', () => {
  const invalid = [
    { applicants: [], household: HOUSEHOLD },
    { applicants: [A, B, { ...A, label: 'C' }, { ...A, label: 'D' }, { ...A, label: 'E' }], household: HOUSEHOLD },
    { applicants: A, household: HOUSEHOLD },
    { applicants: [{ ...A, label: '' }], household: HOUSEHOLD },
    { applicants: [{ ...A, label: '  ' }], household: HOUSEHOLD },
    { applicants: [{ ...A, label: '신청자ABCD' }], household: HOUSEHOLD },
    { applicants: [{ ...A, label: 3 }], household: HOUSEHOLD },
    { applicants: [A, { ...B, label: '신청자A' }], household: HOUSEHOLD },
    { applicants: [{ ...A, birthYear: '1990' }], household: HOUSEHOLD },
    { applicants: [{ ...A, birthYear: 1990.5 }], household: HOUSEHOLD },
    { applicants: [{ ...A, birthYear: undefined }], household: HOUSEHOLD },
    { applicants: [{ ...A, residenceSido: '' }], household: HOUSEHOLD },
    { applicants: [{ ...A, residenceYears: -1 }], household: HOUSEHOLD },
    { applicants: [{ ...A, account: undefined }], household: HOUSEHOLD },
    { applicants: [{ ...A, account: null }], household: HOUSEHOLD },
    { applicants: [{ ...A, account: { ...A.account, joined: '2019-3' } }], household: HOUSEHOLD },
    { applicants: [{ ...A, account: { ...A.account, joined: '2019-13' } }], household: HOUSEHOLD },
    { applicants: [{ ...A, account: { ...A.account, payments: -1 } }], household: HOUSEHOLD },
    { applicants: [{ ...A, account: { ...A.account, payments: 1.5 } }], household: HOUSEHOLD },
    { applicants: [{ ...A, account: { ...A.account, depositManwon: '350' } }], household: HOUSEHOLD },
    { applicants: [{ ...A, account: { ...A.account, deposit: 350 } }], household: HOUSEHOLD },
    { applicants: [{ ...A, specialTracks: ['다자녀'] }], household: HOUSEHOLD },
    { applicants: [{ ...B, pregnant: 'yes' }], household: HOUSEHOLD },
    { applicants: [{ ...B, childBirths: ['2025-13'] }], household: HOUSEHOLD },
    { applicants: [{ ...B, childBirths: '2025-01' }], household: HOUSEHOLD },
    // 오타 난 키는 조용히 무시하지 않는다.
    { applicants: [{ ...A, pregnent: true }], household: HOUSEHOLD },
    { applicants: [A], household: HOUSEHOLD, extra: 1 },
    { applicants: [A] },
    { applicants: [A], household: { married: 'no' } },
    { applicants: [A], household: { married: true, marriageRegistered: '2024-02-30' } },
    { applicants: [A], household: { married: true, marriageRegistered: '2024-02' } },
    { applicants: [A], household: { married: false, marriageRegistered: '2024-02-01' } },
  ];
  for (const value of invalid) assert.deepEqual(parse(value), { profile: null, status: 'invalid' }, JSON.stringify(value));
});

test('a v1 profile keeps its recommendations and texts unchanged', () => {
  const flat = { residenceSido: '인천', residenceYears: 3, specialTracks: ['신생아', '신혼부부', '생애최초'] };
  const parsed = profileOf(flat);
  assert.deepEqual(toProfile(flat), parsed);
  // v1은 신혼부부·신생아 시점 요건, 예치금, 가점을 보지 않는다. 민영 공고에서도 예전과 같다.
  const notices = [
    apt(),
    apt({ sector: '국민' }),
    apt({ region: '경기' }),
    apt({ kind: 'remainder', houseSecd: '04', stages: [{ name: '무순위 접수', start: '2026-11-12', end: '2026-11-13' }] }),
  ];
  for (const notice of notices) {
    const models = [model({ 신생아: 10, 신혼부부: 30, 생애최초: 20 }, 120)];
    assert.deepEqual(recommendTrack({ notice, models, profile: parsed, config, today }), recommendTrack({ notice, models, profile: flat, config, today }));
  }
  const result = recommend(apt(), [model({ 신생아: 10, 신혼부부: 30, 생애최초: 20 }, 120)], parsed);
  assert.deepEqual(result.recommendation, {
    track: '특별(신혼부부)',
    date: '2026-11-09',
    end: '2026-11-09',
    text: '추천: 신혼부부 특별공급 11/9 (30세대, 1순위 해당지역 11/10도 가능; 세대주·청약통장 요건 확인)',
  });
  assert.equal(result.text, result.recommendation.text);
});

// ---------- 특별공급 시점 요건 ----------
test('신생아 is valid while pregnant or with a child born within 2 years of the 공고일', () => {
  const at = '2026-11-10';
  const valid = (patch) => specialTrackValid('신생아', { applicant: { ...B, ...patch }, household: HOUSEHOLD, at });
  assert.equal(valid({ pregnant: true, childBirths: [] }), true);
  assert.equal(valid({ pregnant: false, childBirths: [] }), false);
  // 출생 월이 공고월로부터 24개월 안이면 맞다.
  assert.equal(valid({ pregnant: false, childBirths: ['2024-11'] }), true);
  assert.equal(valid({ pregnant: false, childBirths: ['2026-11'] }), true);
  assert.equal(valid({ pregnant: false, childBirths: ['2024-10'] }), false);
  assert.equal(valid({ pregnant: false, childBirths: ['2020-01', '2025-06'] }), true);
  // 공고일 뒤에 태어날 자녀는 세지 않는다.
  assert.equal(valid({ pregnant: false, childBirths: ['2026-12'] }), false);
  // v1은 모르는 값이라 막지 않는다.
  assert.equal(valid({ pregnant: null, childBirths: null }), true);
});

test('신혼부부 needs a registered marriage within 7 years of the 공고일', () => {
  const at = '2026-11-10';
  const valid = (household) => specialTrackValid('신혼부부', { applicant: A, household, at });
  assert.equal(valid(HOUSEHOLD), false);
  assert.equal(valid({ married: true, marriageRegistered: null }), false);
  assert.equal(valid({ married: true, marriageRegistered: '2022-03-01' }), true);
  assert.equal(valid({ married: true, marriageRegistered: '2019-11-10' }), true);
  assert.equal(valid({ married: true, marriageRegistered: '2019-11-09' }), false);
  // 공고일 뒤 혼인신고는 아직 아니다.
  assert.equal(valid({ married: true, marriageRegistered: '2026-12-01' }), false);
  // v1은 혼인 여부를 몰라 예전처럼 적힌 대로 둔다.
  assert.equal(valid({ married: null, marriageRegistered: null }), true);
  // 생애최초는 그대로 둔다.
  assert.equal(specialTrackValid('생애최초', { applicant: A, household: HOUSEHOLD, at }), true);
});

test('special tracks are checked at the 모집공고일, or today when it is missing', () => {
  const units = [model({ 신생아: 30, 신혼부부: 40, 생애최초: 0 })];
  const notMarried = v2With({ specialTracks: ['신혼부부'] }, { specialTracks: ['신혼부부'] });
  // 신혼부부가 맞지 않으면 세대가 많아도 특별공급을 고르지 않고 1순위로 간다.
  assert.equal(recommend(apt(), units, notMarried).recommendation.track, '신청자A 1순위');
  const married = v2With({ specialTracks: ['신혼부부'] }, { specialTracks: [] }, { married: true, marriageRegistered: '2019-11-03' });
  // 공고일(11/2) 기준으로는 7년 안이다.
  assert.equal(recommend(apt(), units, married).recommendation.track, '신청자A 특별(신혼부부)');
  // 공고일이 없으면 실행일(11/5) 기준이라 7년이 지났다.
  assert.equal(recommend(apt({ announceDate: null }), units, married).recommendation.track, '신청자A 1순위');
  // 임신 중인 신청자는 신생아 특별공급이다.
  const newborn = v2With({ specialTracks: [] }, { account: { ...B.account, depositManwon: 300 } });
  assert.equal(recommend(apt(), units, newborn).recommendation.track, '신청자B 특별(신생아)');
  assert.equal(recommend(apt(), units, v2With({ specialTracks: [] }, { pregnant: false, account: { ...B.account, depositManwon: 300 } })).recommendation.track, '신청자A 1순위');
});

// ---------- 예치금 ----------
test('the 민영 deposit requirement follows the applicant residence and the area band', () => {
  assert.deepEqual([84.98, 85, 102, 135, 135.1].map((area) => depositRequirement('서울', area, table)), [300, 300, 600, 1000, 1500]);
  assert.deepEqual([84, 100, 120, 200].map((area) => depositRequirement('부산', area, table)), [300, 600, 1000, 1500]);
  for (const sido of ['대구', '인천', '광주', '대전', '울산']) {
    assert.deepEqual([84, 100, 120, 200].map((area) => depositRequirement(sido, area, table)), [250, 400, 700, 1000], sido);
  }
  for (const sido of ['경기', '세종', '제주', '강원', '인천광역시']) {
    assert.deepEqual([84, 100, 120, 200].map((area) => depositRequirement(sido, area, table)), [200, 300, 400, 500], sido);
  }
});

test('the deposit check finds a shortfall and never blocks on unknown values', () => {
  const applicant = profileOf(V2).applicants[1];
  const check = (notice, models, patch = {}) => depositCheck({ notice, models, applicant: { ...applicant, ...patch }, config });
  // 인천 거주, 가장 작은 주택형 84㎡ → 250만. 200만이면 50만 부족이다.
  assert.deepEqual(check(apt(), [model({}, 110), model({}, 84)]), { short: 50, check: null });
  assert.deepEqual(check(apt(), [model({}, 84)], { account: { ...applicant.account, depositManwon: 190 } }), { short: 60, check: null });
  assert.deepEqual(check(apt(), [model({}, 84)], { account: { ...applicant.account, depositManwon: 250 } }), { short: null, check: null });
  // 경기 거주라면 200만으로 된다.
  assert.deepEqual(check(apt(), [model({}, 84)], { residenceSido: '경기' }), { short: null, check: null });
  // 면적을 모르면 막지 않고 확인을 안내한다. 하나라도 비면 모른다고 본다.
  for (const models of [null, [], [model({}, null)], [model({}, 120), model({}, null)]]) {
    assert.deepEqual(check(apt(), models), { short: null, check: '예치금(면적 미상)' }, JSON.stringify(models));
  }
  assert.deepEqual(check(apt(), [model({}, 84)], { account: { ...applicant.account, depositManwon: null } }), { short: null, check: '예치금' });
  // 국민, 구분 모름, APT가 아닌 공고, v1 신청자는 보지 않는다.
  assert.deepEqual(check(apt({ sector: '국민' }), [model({}, 84)]), { short: null, check: null });
  assert.deepEqual(check(apt({ sector: null }), [model({}, 84)]), { short: null, check: null });
  assert.deepEqual(check(apt({ kind: 'remainder' }), [model({}, 84)]), { short: null, check: null });
  assert.deepEqual(check(apt(), [model({}, 84)], { account: null }), { short: null, check: null });
});

test('an applicant short of the deposit gets no 민영 track and the reason says by how much', () => {
  const short = v2With({}, { account: { ...B.account, depositManwon: 190 } });
  const result = recommend(apt(), UNITS, short);
  // 신청자B는 신생아 특별공급이 맞지만 예치금이 모자라 신청자A의 생애최초가 추천된다.
  assert.equal(result.recommendation.track, '신청자A 특별(생애최초)');
  assert.equal(result.text, '추천: 신청자A 생애최초 특별공급 11/9 (20세대, 1순위 해당지역 11/10도 가능, 가점 약 28점); 신청자B 예치금 60만 부족; 세대주·청약통장 요건 확인; 가점은 추정');
  // 둘 다 모자라면 추천은 비우고 부족액만 적는다.
  const both = v2With({ account: { ...A.account, depositManwon: 100 } }, { account: { ...B.account, depositManwon: 190 } });
  assert.deepEqual(recommend(apt(), UNITS, both), { recommendation: null, text: '추천 없음; 신청자A 예치금 150만 부족; 신청자B 예치금 60만 부족' });
  // 국민 공고는 예치금을 보지 않아 둘 다 특별공급이고, 같은 날이라 신청자 순서다.
  const national = recommend(apt({ sector: '국민' }), UNITS, both);
  assert.equal(national.recommendation.track, '신청자A 특별(생애최초)');
  assert.ok(national.text.startsWith('추천: 신청자A 생애최초 특별공급 11/9 (20세대, 1순위 해당지역 11/10도 가능) / 신청자B 신생아 특별공급 11/9 (30세대, 1순위 해당지역 11/10도 가능)'), national.text);
});

test('unknown account values add a 확인 note instead of blocking', () => {
  const unknown = v2With({ account: { joined: null, payments: null, depositManwon: null } }, { account: { ...B.account, depositManwon: 300 } });
  const result = recommend(apt(), null, unknown);
  // 주택형 자료가 없으면 특별공급 세대를 몰라 1순위다. 면적을 몰라 예치금도 막지 않는다.
  assert.equal(result.recommendation.track, '신청자A 1순위');
  assert.ok(result.text.includes('확인: 신청자A 통장 가입일·예치금, 신청자B 통장 가입일·예치금(면적 미상)'), result.text);
  // 국민 공고는 납입횟수를 묻는다.
  const national = recommend(apt({ sector: '국민' }), UNITS, unknown);
  assert.ok(national.text.includes('확인: 신청자A 통장 가입일·납입횟수, 신청자B 통장 가입일·납입횟수'), national.text);
  // 국민 공고에는 가점을 적지 않는다.
  assert.ok(!national.text.includes('가점'), national.text);
});

// ---------- 민영·국민 ----------
test('민영 and 국민 come from HOUSE_DTL_SECD_NM, then HOUSE_DTL_SECD', () => {
  assert.equal(supplySector({ HOUSE_DTL_SECD: '01', HOUSE_DTL_SECD_NM: '민영' }), '민영');
  assert.equal(supplySector({ HOUSE_DTL_SECD: '03', HOUSE_DTL_SECD_NM: '국민' }), '국민');
  assert.equal(supplySector({ HOUSE_DTL_SECD_NM: '민영주택' }), '민영');
  // 이름이 있으면 이름을 믿는다.
  assert.equal(supplySector({ HOUSE_DTL_SECD: '01', HOUSE_DTL_SECD_NM: '국민' }), '국민');
  assert.equal(supplySector({ HOUSE_DTL_SECD: '01', HOUSE_DTL_SECD_NM: '기타' }), null);
  assert.equal(supplySector({ HOUSE_DTL_SECD: '01' }), '민영');
  assert.equal(supplySector({ HOUSE_DTL_SECD: '03' }), '국민');
  assert.equal(supplySector({ HOUSE_DTL_SECD: '02' }), null);
  assert.equal(supplySector({}), null);
  const detail = normalizeDetail(ENDPOINTS[0], { HOUSE_MANAGE_NO: '1', PBLANC_NO: '1', HOUSE_DTL_SECD: '01', HOUSE_DTL_SECD_NM: '민영' });
  assert.equal(detail.sector, '민영');
  assert.equal(normalizeDetail(ENDPOINTS[0], { HOUSE_MANAGE_NO: '1', PBLANC_NO: '1' }).sector, null);
});

// ---------- 신청자 고르기 ----------
test('the notice recommendation takes the earliest date, then a special track, then applicant order', () => {
  const result = (index, date, kind) => ({ index, candidate: { kind, date } });
  assert.equal(chooseApplicant([result(0, '2026-11-10', 'general'), result(1, '2026-11-09', 'special')]).index, 1);
  assert.equal(chooseApplicant([result(0, '2026-11-09', 'general'), result(1, '2026-11-10', 'special')]).index, 0);
  assert.equal(chooseApplicant([result(0, '2026-11-09', 'general'), result(1, '2026-11-09', 'special')]).index, 1);
  assert.equal(chooseApplicant([result(0, '2026-11-09', 'special'), result(1, '2026-11-09', 'special')]).index, 0);
  assert.equal(chooseApplicant([result(0, '2026-11-09', 'remainder'), result(1, '2026-11-09', 'remainder')]).index, 0);
  assert.equal(chooseApplicant([]), null);

  // 신청자A는 맞는 특별공급이 없어 1순위 11/10, 신청자B는 신생아 특별공급 11/9라 B가 먼저다.
  const profile = v2With({ specialTracks: ['신혼부부'] }, { account: { ...B.account, depositManwon: 300 } });
  const picked = recommend(apt(), UNITS, profile);
  assert.deepEqual([picked.recommendation.track, picked.recommendation.date, picked.recommendation.end], ['신청자B 특별(신생아)', '2026-11-09', '2026-11-09']);
  assert.equal(picked.text, '추천: 신청자A 1순위 해당지역 11/10 (가점 약 28점) / 신청자B 신생아 특별공급 11/9 (30세대, 1순위 해당지역 11/10도 가능, 가점 약 9점(통장 제외)); 확인: 신청자B 통장 가입일; 세대주·청약통장 요건 확인; 가점은 추정');
  // 특별공급이 끝난 다음 날에는 둘 다 1순위라 신청자 순서다.
  assert.equal(recommend(apt(), UNITS, profile, '2026-11-10').recommendation.track, '신청자A 1순위');
  // 같은 날 특별공급끼리는 신청자 순서다.
  const both = v2With({}, { account: { ...B.account, depositManwon: 300 } });
  assert.equal(recommend(apt(), UNITS, both).recommendation.track, '신청자A 특별(생애최초)');
  // 신청자마다 거주지가 달라 접수일이 다르면 이른 쪽이다. 경기 거주 신청자A의 인천 공고는 기타지역(11/11)이다.
  const apart = v2With({ residenceSido: '경기', specialTracks: [] }, { specialTracks: [], account: { ...B.account, depositManwon: 300 } });
  assert.equal(recommend(apt(), UNITS, apart).recommendation.track, '신청자B 1순위');
});

test('a remainder notice lists all applicants once with their shared track', () => {
  const remainder = apt({ kind: 'remainder', houseSecd: '04', stages: [{ name: '무순위 접수', start: '2026-11-12', end: '2026-11-13' }] });
  const result = recommend(remainder, null, profileOf(V2));
  assert.deepEqual(result.recommendation, { track: '신청자A 무순위', date: '2026-11-12', end: '2026-11-13', text: '추천: 신청자A·신청자B 무순위 11/12' });
  // 지역 대상이 아닌 신청자는 빠진다.
  const other = recommend(apt({ region: '부산' }), UNITS, v2With({ residenceSido: '부산', account: { ...A.account, depositManwon: 600 } }));
  assert.equal(other.recommendation.track, '신청자A 특별(생애최초)');
  assert.ok(!other.text.includes('신청자B'), other.text);
  // 아무도 대상이 아니면 추천도 글도 없다.
  assert.deepEqual(recommend(apt({ region: '부산' }), UNITS, profileOf(V2)), { recommendation: null, text: null });
});

test('the 추천 전형 select is short: no label in v1, label and track in v2', () => {
  assert.equal(recommendLabel('', '특별(신혼부부)'), '특별(신혼부부)');
  assert.equal(recommendLabel('신청자B', '특별(신생아)'), '신청자B 특별(신생아)');
  const notice = { key: '1-1', name: '공고단지', region: '인천', typeLabel: 'APT', stages: [] };
  const write = (track) => buildProperties(notice, { status: '아님', recommendation: { track, date: '2026-11-09', end: null, text: '' } }, today)['추천 전형'];
  assert.deepEqual(write('특별(신혼부부)'), { select: { name: '특별(신혼부부)' } });
  assert.deepEqual(write('신청자B 특별(신생아)'), { select: { name: '신청자B 특별(신생아)' } });
  // 쉼표는 selectProp이 지운다.
  assert.deepEqual(write(recommendLabel('A,B', '1순위')), { select: { name: 'A B 1순위' } });
});

test('the interest alert shows the labelled track in full', () => {
  const text = buildKakaoText({ notice: { name: '공고단지' }, stage: { name: '신청자B 특별(신혼부부)', start: '2026-11-09', end: null }, prefix: '[관심 청약]', verb: '오늘 접수' });
  assert.ok(text.includes('\n신청자B 특별(신혼부부) 오늘 접수 2026-11-09'), text);
  // 예전 짧은 이름도 그대로다.
  const v1 = buildKakaoText({ notice: { name: '공고단지' }, stage: { name: '특별(신혼부부)', start: '2026-11-09', end: null }, prefix: '[관심 청약]', verb: '오늘 접수' });
  assert.ok(v1.includes('\n특별(신혼부부) 오늘 접수 2026-11-09'), v1);
});

// ---------- 가점 ----------
test('estimatePoints follows the 무주택, 부양가족 and 통장 rules', () => {
  const at = '2026-11-10';
  const points = (applicant, household = HOUSEHOLD) => estimatePoints({ applicant: { ...A, specialTracks: [], pregnant: false, childBirths: [], ...applicant }, household, at });
  // 미혼이고 30세 전이면 무주택 0점, 부양가족 없음 5점.
  assert.deepEqual(points({ birthYear: 2000, account: { ...A.account, joined: null } }), { total: 5, homeless: 0, dependents: 5, account: null });
  // 1990년생은 2020-01-01부터 6년: 2 + 12 = 14점. 통장 2019-03부터 7년 8개월: 2 + 7 = 9점.
  assert.deepEqual(points({}), { total: 28, homeless: 14, dependents: 5, account: 9 });
  // 30세가 되는 해는 1년 미만 2점이다.
  assert.equal(points({ birthYear: 1996 }).homeless, 2);
  // 30세 전에 혼인신고를 했으면 신고일부터 센다. 배우자는 부양가족이다.
  const early = points({ birthYear: 2000 }, { married: true, marriageRegistered: '2024-05-01' });
  assert.deepEqual([early.homeless, early.dependents], [6, 10]);
  // 30세 뒤 혼인신고는 30세부터 센다.
  assert.equal(points({ birthYear: 1990 }, { married: true, marriageRegistered: '2025-05-01' }).homeless, 14);
  // 공고일 뒤 혼인신고는 아직 세지 않는다.
  assert.deepEqual([points({ birthYear: 2000 }, { married: true, marriageRegistered: '2026-12-01' }).homeless, points({ birthYear: 2000 }, { married: true, marriageRegistered: '2026-12-01' }).dependents], [0, 5]);
  // 상한: 무주택 32, 부양가족 35, 통장 17.
  assert.equal(points({ birthYear: 1970 }).homeless, 32);
  assert.equal(points({ childBirths: ['2015-01', '2016-01', '2017-01', '2018-01', '2019-01', '2020-01', '2021-01'] }).dependents, 35);
  assert.equal(points({ account: { ...A.account, joined: '2000-01' } }).account, 17);
  // 태아와 공고일 뒤 출생은 세지 않는다.
  assert.equal(points({ pregnant: true, childBirths: ['2026-12'] }).dependents, 5);
  assert.equal(points({ childBirths: ['2025-02'] }).dependents, 10);
  // 통장 가입 기간 구간
  assert.deepEqual(['2026-06', '2026-05', '2025-12', '2025-11', '2024-11'].map((joined) => points({ account: { ...A.account, joined } }).account), [1, 2, 2, 3, 4]);
  // 가입 월을 모르면 통장 점수를 빼고 합한다.
  assert.deepEqual(points({ account: { ...A.account, joined: null } }), { total: 19, homeless: 14, dependents: 5, account: null });
  // 출생 연도가 없으면(v1) 추정하지 않는다.
  assert.equal(estimatePoints({ applicant: toProfile({ residenceSido: '인천', residenceYears: 3 }).applicants[0], household: { married: null, marriageRegistered: null }, at }), null);
});

// ---------- 신청할 수 없는 공고 ----------
test('a notice is unapplicable only when it is unapplicable for every applicant', () => {
  const ended = [
    { name: '특별공급', start: '2026-11-01', end: '2026-11-01' },
    { name: '1순위 해당', start: '2026-11-02', end: '2026-11-02' },
    { name: '1순위 경기', start: '2026-11-02', end: '2026-11-02' },
    { name: '1순위 기타', start: '2026-11-03', end: '2026-11-03' },
  ];
  const zero = [model({ 신생아: 0, 신혼부부: 0, 생애최초: 0 })];
  const check = (notice, profile) => unapplicableReason({ notice, models: zero, profile, config, today });
  const incheonBoth = profileOf(V2);
  const mixed = v2With({}, { residenceSido: '부산' });
  // 둘 다 인천이면 부산 공고는 지역으로 뺀다.
  assert.equal(check(apt({ region: '부산' }), incheonBoth), 'region');
  // 부산 거주 신청자가 있으면 남긴다.
  assert.equal(check(apt({ region: '부산' }), mixed), null);
  // 한 명은 지역, 한 명은 접수 종료면 'ended'다.
  assert.equal(check(apt({ region: '부산', stages: ended }), mixed), 'ended');
  assert.equal(check(apt({ stages: ended }), incheonBoth), 'ended');
  // 한 명이라도 아직 열려 있으면 남긴다. 서울 공고의 1순위 해당(11/5)은 서울 거주 신청자만 본다.
  const late = ended.map((stage) => (stage.name === '1순위 해당' ? { ...stage, start: today, end: today } : stage));
  assert.equal(check(apt({ region: '서울', stages: late }), incheonBoth), 'ended');
  assert.equal(check(apt({ region: '서울', stages: late }), v2With({}, { residenceSido: '서울' })), null);
  // 예치금 부족으로는 빼지 않는다.
  assert.equal(check(apt(), v2With({ account: { ...A.account, depositManwon: 0 } }, { account: { ...B.account, depositManwon: 0 } })), null);
  // 제한 유형, LH는 그대로 빼지 않는다.
  assert.equal(check(apt({ region: '부산', name: '하남교산 신혼희망타운' }), incheonBoth), null);
  assert.equal(check(apt({ region: '부산', kind: 'lh' }), incheonBoth), null);
});

test('evaluation stores the v2 recommendation and a shortfall-only note', async () => {
  const evaluate = (profile) => evaluateLotto(apt({ address: '인천광역시 연수구 송도동 1' }), { config, today, profile, getModels: async () => UNITS, getTrades: async () => [] });
  const short = await evaluate(v2With({ account: { ...A.account, depositManwon: 100 } }, { account: { ...B.account, depositManwon: 190 } }));
  assert.equal(short.recommendation, null);
  assert.ok(short.reason.endsWith('\n추천 없음; 신청자A 예치금 150만 부족; 신청자B 예치금 60만 부족'), short.reason);
  const ok = await evaluate(profileOf(V2));
  assert.equal(ok.recommendation.track, '신청자A 특별(생애최초)');
  assert.ok(ok.reason.includes('\n추천: 신청자A 생애최초 특별공급 11/9'), ok.reason);
});
