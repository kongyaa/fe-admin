import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { evaluateLotto } from '../src/lotto.js';
import { buildProperties, parseExistingPage } from '../src/notion-store.js';
import { ENDPOINTS, normalizeDetail } from '../src/sources/applyhome.js';
import { SPECIAL_TRACKS, parseProfile, pickSpecialTrack, recommendTrack, residenceCategory, unapplicableReason } from '../src/recommend.js';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const today = '2026-11-05';
// 테스트용 가짜 신청자 정보다. 실제 사용자 정보와 다르다.
const PROFILE = { residenceSido: '인천', residenceYears: 3, specialTracks: [...SPECIAL_TRACKS] };

const stages = (extra = []) => [
  { name: '특별공급', start: '2026-11-09', end: '2026-11-09' },
  { name: '1순위 해당', start: '2026-11-10', end: '2026-11-10' },
  { name: '1순위 경기', start: '2026-11-10', end: '2026-11-10' },
  { name: '1순위 기타', start: '2026-11-11', end: '2026-11-11' },
  ...extra,
];
const apt = (extra = {}) => ({ key: '1-1', kind: 'apt', houseSecd: '01', region: '인천', name: '공고단지', stages: stages(), flags: { priceCap: false, publicDistrict: false }, ...extra });
const model = (specials) => ({ houseType: '084A', area: 84, price: 100000, households: 100, specials });
const recommend = (notice, models, profile = PROFILE, on = today) => recommendTrack({ notice, models, profile, config, today: on });

test('the profile secret is parsed strictly and its absence turns the feature off', () => {
  assert.deepEqual(parseProfile(JSON.stringify(PROFILE)), { profile: PROFILE, status: 'ok' });
  assert.deepEqual(parseProfile('{"residenceSido":" 인천 ","residenceYears":0,"specialTracks":["신혼부부","신혼부부"]}').profile, { residenceSido: '인천', residenceYears: 0, specialTracks: ['신혼부부'] });
  assert.deepEqual(parseProfile('{"residenceSido":"인천","residenceYears":3}').profile.specialTracks, []);
  for (const text of [undefined, null, '', '  ']) assert.deepEqual(parseProfile(text), { profile: null, status: 'missing' });
  for (const text of ['{', '[]', 'null', '"서울"', '{"residenceSido":"","residenceYears":3}', '{"residenceSido":"인천"}', '{"residenceSido":"인천","residenceYears":-1}', '{"residenceSido":"인천","residenceYears":"3"}', '{"residenceSido":"인천","residenceYears":3,"specialTracks":["다자녀"]}', '{"residenceSido":"인천","residenceYears":3,"specialTracks":"신혼부부"}']) {
    assert.deepEqual(parseProfile(text), { profile: null, status: 'invalid' }, text);
  }
});

test('the special track with the most units wins, ties going 신생아, 신혼부부, 생애최초', () => {
  const tracks = PROFILE.specialTracks;
  assert.deepEqual(pickSpecialTrack([model({ 신생아: 10, 신혼부부: 30, 생애최초: 20 })], tracks), { track: '신혼부부', units: 30 });
  // 주택형마다 더한다.
  assert.deepEqual(pickSpecialTrack([model({ 신생아: 10, 신혼부부: 5, 생애최초: 0 }), model({ 신생아: 10, 신혼부부: 10, 생애최초: null })], tracks), { track: '신생아', units: 20 });
  assert.equal(pickSpecialTrack([model({ 신생아: 20, 신혼부부: 20, 생애최초: 20 })], tracks).track, '신생아');
  assert.equal(pickSpecialTrack([model({ 신생아: 0, 신혼부부: 20, 생애최초: 20 })], tracks).track, '신혼부부');
  // 프로필에 적힌 순서와 관계없이 같은 순서로 정한다.
  const reversed = ['생애최초', '신혼부부', '신생아'];
  assert.equal(pickSpecialTrack([model({ 신생아: 20, 신혼부부: 20, 생애최초: 20 })], reversed).track, '신생아');
  assert.equal(pickSpecialTrack([model({ 신생아: 0, 신혼부부: 20, 생애최초: 20 })], reversed).track, '신혼부부');
  // 프로필에 없는 전형은 세대가 많아도 고르지 않는다.
  assert.equal(pickSpecialTrack([model({ 신생아: 0, 신혼부부: 50, 생애최초: 5 })], ['생애최초']).track, '생애최초');
  assert.equal(pickSpecialTrack([model({ 신생아: 0, 신혼부부: 0, 생애최초: 0 })], tracks), null);
  assert.equal(pickSpecialTrack(null, tracks), null);
  assert.equal(pickSpecialTrack([model(undefined)], tracks), null);
});

test('an APT notice with eligible special units recommends that special supply and mentions 일반 1순위', () => {
  // 특별공급 전형마다 짧은 이름이다.
  assert.equal(recommend(apt(), [model({ 신생아: 30 })]).track, '특별(신생아)');
  assert.equal(recommend(apt(), [model({ 생애최초: 30 })]).track, '특별(생애최초)');
  const result = recommend(apt(), [model({ 신생아: 10, 신혼부부: 30, 생애최초: 20 })]);
  assert.equal(result.track, '특별(신혼부부)');
  assert.equal(result.date, '2026-11-09');
  assert.equal(result.end, '2026-11-09');
  assert.equal(result.text, '추천: 신혼부부 특별공급 11/9 (30세대, 1순위 해당지역 11/10도 가능; 세대주·청약통장 요건 확인)');
  // 특별공급 접수일이 없으면 일반 1순위로 간다.
  const noSpecialStage = recommend(apt({ stages: stages().filter((stage) => stage.name !== '특별공급') }), [model({ 신혼부부: 30 })]);
  assert.equal(noSpecialStage.track, '1순위');
});

test('without eligible special units the 일반 1순위 date follows the residence category', () => {
  const none = [model({ 신생아: 0, 신혼부부: 0, 생애최초: 0 })];
  const seoul = recommend(apt(), none);
  assert.deepEqual([seoul.track, seoul.date], ['1순위', '2026-11-10']);
  assert.equal(seoul.text, '추천: 1순위 해당지역 11/10 (세대주·청약통장 요건 확인)');
  // 거주 기간이 짧으면 해당지역 대신 기타지역이다.
  const newcomer = recommend(apt(), none, { ...PROFILE, residenceYears: 1 });
  // 추천 전형 열은 거주 구분과 관계없이 1순위이고, 구분은 판별 근거의 추천 줄에만 적는다.
  assert.deepEqual([newcomer.track, newcomer.date, newcomer.text], ['1순위', '2026-11-11', '추천: 1순위 기타지역 11/11 (세대주·청약통장 요건 확인)']);
  // 인천 거주자의 경기·서울 공고는 기타지역이다.
  for (const region of ['경기', '서울']) {
    const other = recommend(apt({ region }), none);
    assert.deepEqual([other.track, other.date], ['1순위', '2026-11-11'], region);
    assert.ok(other.text.startsWith('추천: 1순위 기타지역 11/11'), other.text);
  }
  // 경기 거주자의 경기 공고는 같은 시·군인지 알 수 없어 기타경기로 보고 안내한다.
  const gyeonggi = recommend(apt({ region: '경기' }), none, { ...PROFILE, residenceSido: '경기' });
  assert.deepEqual([gyeonggi.track, gyeonggi.date], ['1순위', '2026-11-10']);
  assert.equal(gyeonggi.text, '추천: 1순위 기타경기 11/10 (세대주·청약통장 요건 확인, 같은 시·군 거주면 해당지역)');
  // 고른 구분의 접수일이 없으면 추천하지 않는다.
  assert.equal(recommend(apt({ stages: [{ name: '1순위 기타', start: '2026-11-11', end: null }] }), none), null);
  assert.equal(recommend(apt({ stages: [{ name: '접수', start: '2026-11-11', end: null }] }), none), null);
  assert.equal(residenceCategory({ region: '서울' }, { residenceSido: '서울', residenceYears: 2 }, config.recommendation), '해당지역');
});

test('a candidate whose 접수 has ended is skipped, and nothing is recommended once all have ended', () => {
  const units = [model({ 신혼부부: 30 })];
  const notice = apt({ stages: [{ name: '특별공급', start: '2026-11-09', end: '2026-11-09' }, { name: '1순위 해당', start: '2026-11-10', end: '2026-11-10' }] });
  // 특별공급 당일에는 특별공급이고, 아직 열려 있는 일반 1순위를 함께 적는다.
  assert.equal(recommend(notice, units, PROFILE, '2026-11-09').text, '추천: 신혼부부 특별공급 11/9 (30세대, 1순위 해당지역 11/10도 가능; 세대주·청약통장 요건 확인)');
  // 다음 날에는 특별공급이 끝나 일반 1순위다.
  const next = recommend(notice, units, PROFILE, '2026-11-10');
  assert.deepEqual([next.track, next.date, next.end, next.text], ['1순위', '2026-11-10', '2026-11-10', '추천: 1순위 해당지역 11/10 (세대주·청약통장 요건 확인)']);
  assert.equal(recommend(notice, units, PROFILE, '2026-11-11'), null);
  // 여러 날 접수는 마감일까지, 마감일이 없으면 시작일까지 열려 있다.
  const multi = apt({ stages: [{ name: '특별공급', start: '2026-11-09', end: '2026-11-12' }, { name: '1순위 해당', start: '2026-11-13', end: null }] });
  assert.equal(recommend(multi, units, PROFILE, '2026-11-12').track, '특별(신혼부부)');
  assert.equal(recommend(multi, units, PROFILE, '2026-11-13').track, '1순위');
  assert.equal(recommend(multi, units, PROFILE, '2026-11-14'), null);
  // 일반 1순위가 이미 끝났으면 특별공급 근거에 '도 가능'을 적지 않는다.
  const generalFirst = apt({ stages: [{ name: '1순위 해당', start: '2026-11-10', end: '2026-11-10' }, { name: '특별공급', start: '2026-11-12', end: '2026-11-12' }] });
  assert.equal(recommend(generalFirst, units, PROFILE, '2026-11-11').text, '추천: 신혼부부 특별공급 11/12 (30세대; 세대주·청약통장 요건 확인)');
  // 마감일이 시작일보다 이르면 잘못된 자료라 시작일 하루 접수로 본다.
  const backwards = apt({ stages: [{ name: '특별공급', start: '2026-11-09', end: '2026-11-03' }, { name: '1순위 해당', start: '2026-11-10', end: '2026-11-10' }] });
  assert.equal(recommend(backwards, units, PROFILE, '2026-11-09').track, '특별(신혼부부)');
  assert.equal(recommend(backwards, units, PROFILE, '2026-11-10').track, '1순위');
  const backwardsOnly = apt({ kind: 'remainder', houseSecd: '04', stages: [{ name: '무순위 접수', start: '2026-11-12', end: '2026-11-01' }] });
  assert.equal(recommend(backwardsOnly, null, PROFILE, '2026-11-12').track, '무순위');
  assert.equal(recommend(backwardsOnly, null, PROFILE, '2026-11-13'), null);
  // 무순위도 접수가 끝나면 추천하지 않는다.
  const remainder = apt({ kind: 'remainder', houseSecd: '04', stages: [{ name: '무순위 접수', start: '2026-11-12', end: '2026-11-13' }] });
  assert.equal(recommend(remainder, null, PROFILE, '2026-11-13').track, '무순위');
  assert.equal(recommend(remainder, null, PROFILE, '2026-11-14'), null);
});

test('remainder, resupply and arbitrary notices recommend their own 접수일', () => {
  const stage = [{ name: '무순위 접수', start: '2026-11-12', end: '2026-11-13' }];
  assert.deepEqual(recommend(apt({ kind: 'remainder', houseSecd: '04', stages: stage }), null), { track: '무순위', date: '2026-11-12', end: '2026-11-13', text: '추천: 무순위 11/12' });
  // 열에는 짧은 이름, 판별 근거에는 원래 이름을 적는다.
  const resupply = recommend(apt({ kind: 'remainder', houseSecd: '06', stages: stage }), null);
  assert.deepEqual([resupply.track, resupply.text], ['재공급', '추천: 불법행위 재공급 11/12']);
  const arbitrary = recommend(apt({ kind: 'arbitrary', houseSecd: '', stages: stage }), null);
  assert.deepEqual([arbitrary.track, arbitrary.text], ['임의공급', '추천: 임의공급 11/12']);
  assert.equal(recommend(apt({ kind: 'remainder', houseSecd: '04', stages: [] }), null), null);
});

test('out-of-region, restricted, LH and other kinds get no recommendation, nor does a missing profile', () => {
  const units = [model({ 신혼부부: 30 })];
  assert.equal(recommend(apt({ region: '부산' }), units), null);
  assert.equal(recommend(apt({ region: null }), units), null);
  // 같은 시도 거주자라면 수도권 밖 공고도 추천한다.
  assert.equal(recommend(apt({ region: '부산' }), units, { ...PROFILE, residenceSido: '부산' }).track, '특별(신혼부부)');
  assert.equal(recommend(apt({ name: '하남교산 신혼희망타운' }), units), null);
  assert.equal(recommend(apt({ name: '고덕강일 3단지 토지임대부' }), units), null);
  for (const kind of ['lh', 'urbty', 'pblrent']) assert.equal(recommend(apt({ kind }), units), null, kind);
  assert.equal(recommendTrack({ notice: apt(), models: units, profile: null, config }), null);
});

test('evaluation carries the recommendation in the stored reason only, never the profile', async () => {
  const evaluate = (profile) => evaluateLotto(apt({ address: '서울특별시 강남구 역삼동 1' }), {
    config,
    today,
    profile,
    getModels: async () => [model({ 신생아: 10, 신혼부부: 30, 생애최초: 20 })],
    getTrades: async () => [],
  });
  const withProfile = await evaluate(PROFILE);
  assert.equal(withProfile.recommendation.track, '특별(신혼부부)');
  assert.ok(withProfile.reason.endsWith('\n추천: 신혼부부 특별공급 11/9 (30세대, 1순위 해당지역 11/10도 가능; 세대주·청약통장 요건 확인)'), withProfile.reason);
  assert.ok(!JSON.stringify(withProfile).includes('residence'));
  const without = await evaluate(null);
  assert.equal(Object.hasOwn(without, 'recommendation'), false);
  assert.ok(!without.reason.includes('추천'));
  // 범위 밖이면 null로 지운다.
  const outside = await evaluateLotto(apt({ region: '부산' }), { config, today, profile: PROFILE, getModels: async () => [], getTrades: async () => [] });
  assert.equal(outside.recommendation, null);
  // 오늘 기준으로 접수가 끝난 단계는 추천하지 않는다.
  const later = await evaluateLotto(apt({ address: '서울특별시 강남구 역삼동 1' }), { config, today: '2026-11-10', profile: PROFILE, getModels: async () => [model({ 신혼부부: 30 })], getTrades: async () => [] });
  assert.equal(later.recommendation.track, '1순위');
});

test('a failed APT model lookup keeps the stored recommendation instead of recomputing it', async () => {
  const notice = apt({ address: '서울특별시 강남구 역삼동 1' });
  const errors = [];
  const evaluate = (getModels, kind = 'apt') => evaluateLotto({ ...notice, kind }, { config, today, profile: PROFILE, getModels, getTrades: async () => [], onError: (error) => errors.push(error) });
  const failed = await evaluate(async () => { throw new Error('applyhome down'); });
  assert.equal(Object.hasOwn(failed, 'recommendation'), false);
  // 저장된 추천 열은 그대로 두고, 판별 근거에는 이전 값을 유지했다고 적는다.
  assert.ok(failed.reason.endsWith('\n(추천: 조회 실패로 이전 값 유지)'), failed.reason);
  assert.ok(!failed.reason.includes('추천: 신혼부부'));
  assert.equal(errors.length, 1);
  const empty = await evaluate(async () => null);
  assert.equal(Object.hasOwn(empty, 'recommendation'), false);
  assert.ok(empty.reason.endsWith('(추천: 조회 실패로 이전 값 유지)'), empty.reason);
  // 프로필이 없으면 추천 문구를 붙이지 않는다.
  const off = await evaluateLotto(notice, { config, today, profile: null, getModels: async () => { throw new Error('down'); }, getTrades: async () => [] });
  assert.ok(!off.reason.includes('추천'), off.reason);
  // 조회가 되면 다시 계산한다. 무순위는 주택형 자료를 쓰지 않아 조회 실패와 관계없이 계산한다.
  assert.equal((await evaluate(async () => [model({ 신혼부부: 30 })])).recommendation.track, '특별(신혼부부)');
  const remainder = await evaluateLotto(apt({ kind: 'remainder', houseSecd: '04', stages: [{ name: '무순위 접수', start: '2026-11-12', end: null }] }), { config, today, profile: PROFILE, getModels: async () => { throw new Error('down'); }, getTrades: async () => [] });
  assert.equal(remainder.recommendation.track, '무순위');
});

test('추천 전형 and 추천 접수일 are written when on, cleared when there is no recommendation, untouched when off', () => {
  const notice = { key: '1-1', name: '공고단지', region: '인천', typeLabel: 'APT', stages: [] };
  const recommendation = { track: '특별(신혼부부)', date: '2026-11-09', end: '2026-11-10', text: '추천' };
  const on = buildProperties(notice, { status: '아님', recommendation }, today);
  assert.deepEqual(on['추천 전형'], { select: { name: '특별(신혼부부)' } });
  assert.deepEqual(on['추천 접수일'], { date: { start: '2026-11-09', end: '2026-11-10' } });
  const oneDay = buildProperties(notice, { status: '아님', recommendation: { ...recommendation, end: '2026-11-09' } }, today);
  assert.deepEqual(oneDay['추천 접수일'], { date: { start: '2026-11-09' } });
  const cleared = buildProperties(notice, { status: '대상 외', recommendation: null }, today);
  assert.deepEqual(cleared['추천 전형'], { select: null });
  assert.deepEqual(cleared['추천 접수일'], { date: null });
  for (const evaluation of [{ status: '아님' }, null]) {
    const off = buildProperties(notice, evaluation, today);
    assert.equal(Object.hasOwn(off, '추천 전형'), false);
    assert.equal(Object.hasOwn(off, '추천 접수일'), false);
  }
  const parsed = parseExistingPage({ id: 'p', properties: { '고유 키': { rich_text: [{ plain_text: 'k' }] }, '추천 전형': { select: { name: '특별(생애최초)' } }, '추천 접수일': { date: { start: '2026-11-09', end: '2026-11-10' } } } });
  assert.deepEqual([parsed.recommendTrack, parsed.recommendDate, parsed.recommendEnd], ['특별(생애최초)', '2026-11-09', '2026-11-10']);
});

test('the workflow passes the profile secret only to the batch step', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/chungyak-alert.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const batch = workflow.slice(workflow.indexOf('- name: Run batch'), workflow.indexOf('- name: Remove token files'));
  assert.ok(batch.includes('CHUNGYAK_PROFILE: ${{ secrets.CHUNGYAK_PROFILE }}'));
  assert.equal(workflow.split('CHUNGYAK_PROFILE').length - 1, 2);
});

// ---------- 신청할 수 없는 공고 ----------
const ZERO_UNITS = [model({ 신생아: 0, 신혼부부: 0, 생애최초: 0 })];
const unapplicable = (notice, models = ZERO_UNITS, profile = PROFILE, on = today) => unapplicableReason({ notice, models, profile, config, today: on });
// 특별공급 11/1, 1순위 11/2~11/3, 2순위 11/5~11/6인 공고. today(11/5)에는 1순위까지 끝났다.
const ended = () => [
  { name: '특별공급', start: '2026-11-01', end: '2026-11-01' },
  { name: '1순위 해당', start: '2026-11-02', end: '2026-11-02' },
  { name: '1순위 경기', start: '2026-11-02', end: '2026-11-02' },
  { name: '1순위 기타', start: '2026-11-03', end: '2026-11-03' },
  { name: '2순위 해당', start: '2026-11-05', end: '2026-11-06' },
];
// 한 단계만 날짜를 바꾼다.
const moved = (name, patch) => ended().map((stage) => (stage.name === name ? { ...stage, ...patch } : stage));
const TODAY_ONLY = { start: today, end: today };

test('only a 수도권 resident\'s APT notice outside 수도권 and 세종 is dropped for its region', () => {
  const as = (residenceSido) => ({ ...PROFILE, residenceSido });
  assert.equal(unapplicable(apt({ region: '부산' })), 'region');
  assert.equal(unapplicable(apt({ region: '부산' }), ZERO_UNITS, as('서울')), 'region');
  assert.equal(unapplicable(apt({ region: '제주' }), ZERO_UNITS, as('경기')), 'region');
  // 접수가 끝났어도 사유는 지역이다.
  assert.equal(unapplicable(apt({ region: '부산', stages: ended() }), ZERO_UNITS, as('서울')), 'region');
  // 수도권 공고는 수도권 거주자에게 열려 있다.
  for (const region of ['서울', '경기', '인천']) assert.equal(unapplicable(apt({ region })), null, region);
  // 무순위는 정해진 거주 요건이 없고 임의공급은 거주 요건이 없어 지역으로 빼지 않는다.
  const remainder = (region, stages = [{ name: '무순위 접수', start: '2026-11-12', end: '2026-11-12' }]) => apt({ kind: 'remainder', houseSecd: '04', region, stages });
  assert.equal(unapplicable(remainder('대구'), null, as('서울')), null);
  assert.equal(unapplicable(apt({ kind: 'arbitrary', houseSecd: '', region: '대구', stages: [{ name: '임의 접수', start: '2026-11-12', end: '2026-11-12' }] }), null, as('서울')), null);
  // 접수가 끝난 지역 밖 무순위도 지역 대상인지 확실하지 않아 남긴다. 접수 종료 정리가 옮긴다.
  assert.equal(unapplicable(remainder('대구', [{ name: '무순위 접수', start: '2026-11-03', end: '2026-11-04' }]), null, as('서울')), null);
  // 수도권 밖 거주자는 기타지역이 광역 권역을 따라 달라 지역으로 빼지 않는다.
  assert.equal(unapplicable(apt({ region: '부산' }), ZERO_UNITS, as('울산')), null);
  assert.equal(unapplicable(apt({ region: '부산' }), ZERO_UNITS, as('경북')), null);
  assert.equal(unapplicable(apt({ region: '부산', stages: ended() }), ZERO_UNITS, as('울산')), null);
  assert.equal(unapplicable(apt({ region: '서울' }), ZERO_UNITS, as('부산')), null);
  // 같은 시도 공고는 접수가 끝나면 뺀다.
  assert.equal(unapplicable(apt({ region: '부산' }), ZERO_UNITS, as('부산')), null);
  assert.equal(unapplicable(apt({ region: '부산', stages: ended() }), ZERO_UNITS, as('부산')), 'ended');
  // 세종 공고는 어느 시도 거주자든 대상이다.
  for (const residenceSido of ['인천', '부산', '세종']) assert.equal(unapplicable(apt({ region: '세종' }), ZERO_UNITS, as(residenceSido)), null, residenceSido);
});

test('세종 notices recommend 1순위 기타지역 to other regions and 해당지역 to 세종 residents', () => {
  const sejong = apt({ region: '세종' });
  // 다른 시도 거주자는 applyhome.js의 GNRL_RNK1_ETC_AREA(1순위 기타) 날짜다.
  assert.equal(residenceCategory(sejong, PROFILE, config.recommendation), '기타지역');
  const other = recommend(sejong, ZERO_UNITS, { ...PROFILE, residenceSido: '부산' });
  assert.deepEqual([other.track, other.date, other.text], ['1순위', '2026-11-11', '추천: 1순위 기타지역 11/11 (세대주·청약통장 요건 확인)']);
  assert.equal(recommend(sejong, [model({ 신혼부부: 30 })]).track, '특별(신혼부부)');
  const resident = recommend(sejong, ZERO_UNITS, { ...PROFILE, residenceSido: '세종' });
  assert.deepEqual([resident.date, resident.text], ['2026-11-10', '추천: 1순위 해당지역 11/10 (세대주·청약통장 요건 확인)']);
  // 기타지역 접수일이 없으면 추천하지 않고 빼지도 않는다.
  const noOther = apt({ region: '세종', stages: [{ name: '1순위 해당', start: '2026-11-01', end: '2026-11-01' }] });
  assert.equal(recommend(noOther, ZERO_UNITS), null);
  assert.equal(unapplicable(noOther), null);
  // 1순위 기타가 끝났으면 다른 공고처럼 뺀다.
  assert.equal(unapplicable(apt({ region: '세종', stages: ended() })), 'ended');
});

test('a region it cannot be sure of never drops a notice', () => {
  // 시도를 모르거나 짧은 이름이 아닌 값(주소에서 온 값, 형식이 다른 프로필)은 빼지 않는다.
  for (const region of [null, undefined, '', '세종시', '전라남']) assert.equal(unapplicable(apt({ region })), null, String(region));
  for (const residenceSido of ['인천광역시', '서울특별시', 'Incheon']) assert.equal(unapplicable(apt({ region: '부산' }), ZERO_UNITS, { ...PROFILE, residenceSido }), null, residenceSido);
});

test('restricted types, LH and other kinds, and a missing profile are never dropped', () => {
  for (const name of ['하남교산 신혼희망타운', '고덕강일 3단지 토지임대부', '지분적립형 단지']) {
    assert.equal(unapplicable(apt({ name, region: '부산' })), null, name);
    assert.equal(unapplicable(apt({ name, stages: ended() })), null, name);
  }
  assert.equal(unapplicable(apt({ houseSecd: '10', region: '부산' })), null);
  for (const kind of ['lh', 'urbty', 'pblrent']) {
    assert.equal(unapplicable(apt({ kind, region: '부산' })), null, kind);
    assert.equal(unapplicable(apt({ kind, stages: ended() })), null, kind);
  }
  for (const profile of [null, undefined]) {
    assert.equal(unapplicableReason({ notice: apt({ region: '부산' }), models: ZERO_UNITS, profile, config, today }), null);
    assert.equal(unapplicableReason({ notice: apt({ stages: ended() }), models: ZERO_UNITS, profile, config, today }), null);
  }
});

test('an APT notice is dropped once its 1순위 for the residence category and any needed special supply have ended', () => {
  // 2순위가 열려 있어도 1순위와 특별공급이 끝났으면 뺀다.
  assert.equal(unapplicable(apt({ stages: ended() })), 'ended');
  assert.equal(unapplicable(apt({ stages: ended() }), [model({ 신혼부부: 30 })]), 'ended');
  // 아직 열려 있는 전형이 있으면 남긴다.
  assert.equal(unapplicable(apt({ stages: ended() }), ZERO_UNITS, PROFILE, '2026-11-02'), null);
  assert.equal(unapplicable(apt()), null);
  // 다른 시도 거주자는 거주 구분(기타지역)의 1순위만 본다.
  const lateLocal = moved('1순위 해당', TODAY_ONLY);
  assert.equal(unapplicable(apt({ region: '서울', stages: lateLocal })), 'ended');
  assert.equal(unapplicable(apt({ region: '서울', stages: moved('1순위 기타', TODAY_ONLY) })), null);
  // 같은 시도 거주자는 실제 거주 기간 요건이 공고마다 달라, 1순위 단계가 하나라도 열려 있으면 남긴다.
  const lateOther = moved('1순위 기타', TODAY_ONLY);
  assert.equal(unapplicable(apt({ stages: lateOther })), null);
  assert.equal(unapplicable(apt({ stages: lateOther }), ZERO_UNITS, { ...PROFILE, residenceYears: 1 }), null);
  assert.equal(unapplicable(apt({ stages: lateLocal }), ZERO_UNITS, { ...PROFILE, residenceYears: 1 }), null);
  // 세대가 있는 전형의 특별공급이 열려 있으면 남기고, 프로필의 전형에 세대가 없으면 특별공급은 보지 않는다.
  const lateSpecial = moved('특별공급', TODAY_ONLY);
  assert.equal(unapplicable(apt({ stages: lateSpecial }), [model({ 신생아: 0, 신혼부부: 0, 생애최초: 5 })]), null);
  assert.equal(unapplicable(apt({ stages: lateSpecial })), 'ended');
  assert.equal(unapplicable(apt({ stages: lateSpecial }), [model({ 신생아: 0, 신혼부부: 0, 생애최초: 5 })], { ...PROFILE, specialTracks: [] }), 'ended');
  assert.equal(unapplicable(apt({ stages: lateSpecial }), [model({ 신생아: 0, 신혼부부: 0, 생애최초: 5 })], { ...PROFILE, specialTracks: ['신혼부부'] }), 'ended');
});

test('special units that cannot be known are treated as present', () => {
  const lateSpecial = moved('특별공급', TODAY_ONLY);
  // 주택형 조회가 실패했거나(null) 자료가 없거나, 세대 값이 하나라도 비어 있으면 특별공급이 끝나야 뺀다.
  for (const models of [null, [], [model(undefined)], [model({ 신생아: 0, 신혼부부: 0, 생애최초: null })], [model({ 신생아: 0, 신혼부부: 0, 생애최초: 0 }), model({})]]) {
    assert.equal(unapplicable(apt({ stages: lateSpecial }), models), null, JSON.stringify(models));
    assert.equal(unapplicable(apt({ stages: ended() }), models), 'ended', JSON.stringify(models));
  }
});

test('a missing stage or a stage without dates never drops a notice', () => {
  const units = [model({ 신혼부부: 30 })];
  const without = (name) => ended().filter((stage) => stage.name !== name);
  // 거주 구분의 1순위 단계가 없다.
  assert.equal(unapplicable(apt({ stages: without('1순위 해당') })), null);
  assert.equal(unapplicable(apt({ stages: without('1순위 기타') }), ZERO_UNITS, { ...PROFILE, residenceYears: 0 }), null);
  // 세대가 있거나 모르는 특별공급의 단계가 없다.
  assert.equal(unapplicable(apt({ stages: without('특별공급') }), units), null);
  assert.equal(unapplicable(apt({ stages: without('특별공급') }), null), null);
  // 세대가 없다고 알면 특별공급 단계가 없어도 된다.
  assert.equal(unapplicable(apt({ stages: without('특별공급') })), 'ended');
  // 단계가 하나도 없거나 전체 접수일만 있다.
  assert.equal(unapplicable(apt({ stages: [] })), null);
  assert.equal(unapplicable(apt({ stages: [{ name: '접수', start: '2026-11-01', end: '2026-11-02' }] })), null);
  // 시작일이나 마감일이 없거나 마감일이 시작일보다 이르면(잘못된 자료) 끝났다고 보지 않는다.
  for (const patch of [{ start: null }, { start: '' }, { end: null }, { end: '' }, { end: '2026-10-30' }]) {
    assert.equal(unapplicable(apt({ stages: moved('1순위 해당', patch) })), null, JSON.stringify(patch));
    assert.equal(unapplicable(apt({ stages: moved('특별공급', patch) }), units), null, JSON.stringify(patch));
  }
});

test('a 경기 resident keeps a 경기 notice while any of its 1순위 stages is still open', () => {
  const gyeonggi = { ...PROFILE, residenceSido: '경기' };
  assert.equal(unapplicable(apt({ region: '경기', stages: ended() }), ZERO_UNITS, gyeonggi), 'ended');
  assert.equal(unapplicable(apt({ region: '경기', stages: moved('1순위 해당', TODAY_ONLY) }), ZERO_UNITS, gyeonggi), null);
  assert.equal(unapplicable(apt({ region: '경기', stages: moved('1순위 경기', TODAY_ONLY) }), ZERO_UNITS, gyeonggi), null);
  assert.equal(unapplicable(apt({ region: '경기', stages: moved('1순위 기타', TODAY_ONLY) }), ZERO_UNITS, gyeonggi), null);
  // 서울·인천 거주자의 경기 공고는 기타지역만 본다.
  assert.equal(unapplicable(apt({ region: '경기', stages: moved('1순위 해당', TODAY_ONLY) })), 'ended');
});

test('remainder, resupply and arbitrary notices are dropped once their 접수 has ended', () => {
  const notice = (stages, extra = {}) => apt({ kind: 'remainder', houseSecd: '04', stages, ...extra });
  const main = { name: '무순위 접수', start: '2026-11-03', end: '2026-11-04' };
  assert.equal(unapplicable(notice([main]), null), 'ended');
  assert.equal(unapplicable(notice([{ ...main, name: '재공급 접수' }], { houseSecd: '06' }), null), 'ended');
  assert.equal(unapplicable(notice([{ ...main, name: '임의 접수' }], { kind: 'arbitrary', houseSecd: '' }), null), 'ended');
  assert.equal(unapplicable(notice([main]), null, PROFILE, '2026-11-04'), null);
  // 다른 단계가 아직 열려 있으면 남긴다.
  assert.equal(unapplicable(notice([main, { name: '일반공급', start: today, end: today }]), null), null);
  // 단계가 없거나 마감일이 없거나 어긋나면 남긴다.
  assert.equal(unapplicable(notice([]), null), null);
  assert.equal(unapplicable(notice([{ ...main, end: null }]), null), null);
  assert.equal(unapplicable(notice([{ ...main, end: '2026-11-01' }]), null), null);
});

test('a remainder notice without its main 접수 stage is kept even when its detail stages have ended', () => {
  // 청약홈 상세에 SUBSCRPT_RCEPT 접수일이 없고 특별공급·일반공급 접수일만 있는 공고. 어느 단계가 본 접수인지 몰라 빼지 않는다.
  const detail = (op, extra) => normalizeDetail(ENDPOINTS.find((item) => item.op === op), {
    HOUSE_MANAGE_NO: '1', PBLANC_NO: '1', HOUSE_NM: '단지', SUBSCRPT_AREA_CODE_NM: '인천', HSSPLY_ADRES: '인천광역시 연수구 송도동 1',
    SPSPLY_RCEPT_BGNDE: '2026-11-01', SPSPLY_RCEPT_ENDDE: '2026-11-01', GNRL_RCEPT_BGNDE: '2026-11-02', GNRL_RCEPT_ENDDE: '2026-11-03', ...extra,
  });
  const remainder = detail('getRemndrLttotPblancDetail', { HOUSE_SECD: '04' });
  assert.deepEqual(remainder.stages.map((stage) => stage.name), ['특별공급', '일반공급']);
  assert.equal(unapplicable(remainder, null), null);
  assert.equal(unapplicable(detail('getOPTLttotPblancDetail', {}), null), null);
  // 본 접수일이 있으면 그 단계로 판단한다.
  const withMain = detail('getRemndrLttotPblancDetail', { HOUSE_SECD: '04', SUBSCRPT_RCEPT_BGNDE: '2026-11-01', SUBSCRPT_RCEPT_ENDDE: '2026-11-03' });
  assert.equal(withMain.stages[0].name, '무순위 접수');
  assert.equal(unapplicable(withMain, null), 'ended');
});

test('evaluation carries the unapplicable reason only with a profile, and a failed model lookup counts as unknown units', async () => {
  const notice = apt({ address: '서울특별시 강남구 역삼동 1' });
  const evaluate = (target, profile, getModels = async () => ZERO_UNITS) => evaluateLotto(target, { config, today, profile, getModels, getTrades: async () => [] });
  assert.equal((await evaluate(notice, PROFILE)).unapplicable, null);
  assert.equal((await evaluate({ ...notice, stages: ended() }, PROFILE)).unapplicable, 'ended');
  assert.equal((await evaluate(apt({ region: '부산' }), PROFILE)).unapplicable, 'region');
  assert.equal(Object.hasOwn(await evaluate({ ...notice, stages: ended() }, null), 'unapplicable'), false);
  // 특별공급이 열려 있는데 주택형 조회가 실패하면 세대를 몰라 남긴다.
  const lateSpecial = { ...notice, stages: moved('특별공급', TODAY_ONLY) };
  assert.equal((await evaluate(lateSpecial, PROFILE)).unapplicable, 'ended');
  assert.equal((await evaluate(lateSpecial, PROFILE, async () => { throw new Error('down'); })).unapplicable, null);
  assert.equal((await evaluate(lateSpecial, PROFILE, async () => null)).unapplicable, null);
});
