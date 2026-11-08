import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { evaluateLotto } from '../src/lotto.js';
import { buildProperties, parseExistingPage } from '../src/notion-store.js';
import { SPECIAL_TRACKS, parseProfile, pickSpecialTrack, recommendTrack, residenceCategory } from '../src/recommend.js';

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
  const result = recommend(apt(), [model({ 신생아: 10, 신혼부부: 30, 생애최초: 20 })]);
  assert.equal(result.track, '신혼부부 특별공급');
  assert.equal(result.date, '2026-11-09');
  assert.equal(result.end, '2026-11-09');
  assert.equal(result.text, '추천: 신혼부부 특별공급 11/9 (30세대, 1순위 해당지역 11/10도 가능; 세대주·청약통장 요건 확인)');
  // 특별공급 접수일이 없으면 일반 1순위로 간다.
  const noSpecialStage = recommend(apt({ stages: stages().filter((stage) => stage.name !== '특별공급') }), [model({ 신혼부부: 30 })]);
  assert.equal(noSpecialStage.track, '1순위 해당지역');
});

test('without eligible special units the 일반 1순위 date follows the residence category', () => {
  const none = [model({ 신생아: 0, 신혼부부: 0, 생애최초: 0 })];
  const seoul = recommend(apt(), none);
  assert.deepEqual([seoul.track, seoul.date], ['1순위 해당지역', '2026-11-10']);
  assert.equal(seoul.text, '추천: 1순위 해당지역 11/10 (세대주·청약통장 요건 확인)');
  // 거주 기간이 짧으면 해당지역 대신 기타지역이다.
  const newcomer = recommend(apt(), none, { ...PROFILE, residenceYears: 1 });
  assert.deepEqual([newcomer.track, newcomer.date], ['1순위 기타지역', '2026-11-11']);
  // 인천 거주자의 경기·서울 공고는 기타지역이다.
  assert.equal(recommend(apt({ region: '경기' }), none).track, '1순위 기타지역');
  assert.equal(recommend(apt({ region: '서울' }), null).track, '1순위 기타지역');
  // 경기 거주자의 경기 공고는 같은 시·군인지 알 수 없어 기타경기로 보고 안내한다.
  const gyeonggi = recommend(apt({ region: '경기' }), none, { ...PROFILE, residenceSido: '경기' });
  assert.equal(gyeonggi.track, '1순위 기타경기');
  assert.ok(gyeonggi.text.includes('같은 시·군 거주면 해당지역'));
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
  assert.deepEqual([next.track, next.date, next.end, next.text], ['1순위 해당지역', '2026-11-10', '2026-11-10', '추천: 1순위 해당지역 11/10 (세대주·청약통장 요건 확인)']);
  assert.equal(recommend(notice, units, PROFILE, '2026-11-11'), null);
  // 여러 날 접수는 마감일까지, 마감일이 없으면 시작일까지 열려 있다.
  const multi = apt({ stages: [{ name: '특별공급', start: '2026-11-09', end: '2026-11-12' }, { name: '1순위 해당', start: '2026-11-13', end: null }] });
  assert.equal(recommend(multi, units, PROFILE, '2026-11-12').track, '신혼부부 특별공급');
  assert.equal(recommend(multi, units, PROFILE, '2026-11-13').track, '1순위 해당지역');
  assert.equal(recommend(multi, units, PROFILE, '2026-11-14'), null);
  // 일반 1순위가 이미 끝났으면 특별공급 근거에 '도 가능'을 적지 않는다.
  const generalFirst = apt({ stages: [{ name: '1순위 해당', start: '2026-11-10', end: '2026-11-10' }, { name: '특별공급', start: '2026-11-12', end: '2026-11-12' }] });
  assert.equal(recommend(generalFirst, units, PROFILE, '2026-11-11').text, '추천: 신혼부부 특별공급 11/12 (30세대; 세대주·청약통장 요건 확인)');
  // 마감일이 시작일보다 이르면 잘못된 자료라 시작일 하루 접수로 본다.
  const backwards = apt({ stages: [{ name: '특별공급', start: '2026-11-09', end: '2026-11-03' }, { name: '1순위 해당', start: '2026-11-10', end: '2026-11-10' }] });
  assert.equal(recommend(backwards, units, PROFILE, '2026-11-09').track, '신혼부부 특별공급');
  assert.equal(recommend(backwards, units, PROFILE, '2026-11-10').track, '1순위 해당지역');
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
  assert.equal(recommend(apt({ kind: 'remainder', houseSecd: '06', stages: stage }), null).track, '불법행위 재공급');
  assert.equal(recommend(apt({ kind: 'arbitrary', houseSecd: '', stages: stage }), null).track, '임의공급');
  assert.equal(recommend(apt({ kind: 'remainder', houseSecd: '04', stages: [] }), null), null);
});

test('out-of-region, restricted, LH and other kinds get no recommendation, nor does a missing profile', () => {
  const units = [model({ 신혼부부: 30 })];
  assert.equal(recommend(apt({ region: '부산' }), units), null);
  assert.equal(recommend(apt({ region: null }), units), null);
  // 같은 시도 거주자라면 수도권 밖 공고도 추천한다.
  assert.equal(recommend(apt({ region: '부산' }), units, { ...PROFILE, residenceSido: '부산' }).track, '신혼부부 특별공급');
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
  assert.equal(withProfile.recommendation.track, '신혼부부 특별공급');
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
  assert.equal(later.recommendation.track, '1순위 해당지역');
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
  assert.equal((await evaluate(async () => [model({ 신혼부부: 30 })])).recommendation.track, '신혼부부 특별공급');
  const remainder = await evaluateLotto(apt({ kind: 'remainder', houseSecd: '04', stages: [{ name: '무순위 접수', start: '2026-11-12', end: null }] }), { config, today, profile: PROFILE, getModels: async () => { throw new Error('down'); }, getTrades: async () => [] });
  assert.equal(remainder.recommendation.track, '무순위');
});

test('추천 전형 and 추천 접수일 are written when on, cleared when there is no recommendation, untouched when off', () => {
  const notice = { key: '1-1', name: '공고단지', region: '인천', typeLabel: 'APT', stages: [] };
  const recommendation = { track: '신혼부부 특별공급', date: '2026-11-09', end: '2026-11-10', text: '추천' };
  const on = buildProperties(notice, { status: '아님', recommendation }, today);
  assert.deepEqual(on['추천 전형'], { select: { name: '신혼부부 특별공급' } });
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
  const parsed = parseExistingPage({ id: 'p', properties: { '고유 키': { rich_text: [{ plain_text: 'k' }] }, '추천 전형': { select: { name: '생애최초 특별공급' } }, '추천 접수일': { date: { start: '2026-11-09', end: '2026-11-10' } } } });
  assert.deepEqual([parsed.recommendTrack, parsed.recommendDate, parsed.recommendEnd], ['생애최초 특별공급', '2026-11-09', '2026-11-10']);
});

test('the workflow passes the profile secret only to the batch step', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/chungyak-alert.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const batch = workflow.slice(workflow.indexOf('- name: Run batch'), workflow.indexOf('- name: Remove token files'));
  assert.ok(batch.includes('CHUNGYAK_PROFILE: ${{ secrets.CHUNGYAK_PROFILE }}'));
  assert.equal(workflow.split('CHUNGYAK_PROFILE').length - 1, 2);
});
