import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { mapLhSchedule } from '../src/lh-detail-map.js';
import { evaluateLotto, keepPreviousLotto } from '../src/lotto.js';
import { selectInterest } from '../src/main.js';
import { buildKakaoText } from '../src/notify-kakao.js';
import { buildProperties } from '../src/notion-store.js';
import { lhRecommendable, lhStageTracks, parseProfile, recommendForProfile, unapplicableReason } from '../src/recommend.js';

// LH 공공분양 추천. 신청자 정보와 공고는 모두 지어낸 값이다.
const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const today = '2026-11-05';

// 공급 일정의 접수 대상 이름으로 단계를 만든다(src/lh-detail-map.js의 lhStageName을 거친다).
const schedule = (rows) => mapLhSchedule(rows.map(([label, date]) => ({ HS_SBSC_ACP_TRG_CD_NM: label, ACP_DTTM: date }))).stages;
const SALE_ROWS = [
  ['신생아', '2026.11.09'],
  ['신혼부부', '2026.11.09'],
  ['생애최초', '2026.11.09'],
  ['다자녀가구', '2026.11.09'],
  ['노부모부양', '2026.11.09'],
  ['기관추천', '2026.11.09'],
  ['일반공급 1순위', '2026.11.11'],
  ['일반공급 2순위', '2026.11.12'],
];
const lh = (extra = {}) => ({
  key: 'LH-t1',
  source: 'LH',
  kind: 'lh',
  typeLabel: '분양주택 공공분양',
  name: '시험지구 공공분양주택 입주자모집공고',
  region: '서울',
  announceDate: '2026-11-01',
  lhDetailState: 'ok',
  flags: { priceCap: true },
  stages: schedule(SALE_ROWS),
  ...extra,
});
const v1 = (tracks, residenceSido = '인천') => parseProfile(JSON.stringify({ residenceSido, residenceYears: 3, specialTracks: tracks })).profile;
const applicant = (label, extra = {}) => ({ label, birthYear: 1992, residenceSido: '인천', residenceYears: 3, account: null, specialTracks: [], ...extra });
const v2 = (applicants, household = { married: false }) => parseProfile(JSON.stringify({ applicants, household })).profile;
const recommend = (notice, profile, on = today) => recommendForProfile({ notice, models: null, profile, config, today: on });

test('stage labels map to profile tracks; other special labels are never tracks', () => {
  assert.deepEqual(lhStageTracks('특별공급 신생아'), ['신생아']);
  assert.deepEqual(lhStageTracks('특별공급 신혼부부'), ['신혼부부']);
  assert.deepEqual(lhStageTracks('특별공급 예비신혼부부'), ['신혼부부']);
  assert.deepEqual(lhStageTracks('특별공급 생애최초'), ['생애최초']);
  assert.deepEqual(lhStageTracks('특별공급 노부모부양·생애최초'), ['생애최초']);
  for (const name of ['특별공급 다자녀가구', '특별공급 노부모부양', '특별공급 한부모가족', '특별공급 기관추천', '특별공급 청년', '특별공급']) {
    assert.deepEqual(lhStageTracks(name), [], name);
  }
});

test('a v1 profile gets the matching LH special stage with the income note and no unit count', () => {
  const result = recommend(lh(), v1(['신혼부부']));
  assert.equal(result.recommendation.track, '특별(신혼부부)');
  assert.equal(result.recommendation.date, '2026-11-09');
  assert.equal(result.text, '추천: 신혼부부 특별공급 11/9 (1순위 일반공급 11/11도 가능); 소득·자산 기준 확인');
  assert.equal(result.recommendation.text, result.text);
  assert.equal(recommend(lh(), v1(['생애최초'])).recommendation.track, '특별(생애최초)');
});

test('several matching tracks follow 신생아, 신혼부부, 생애최초 like same-day special supplies', () => {
  const all = ['생애최초', '신혼부부', '신생아'];
  assert.equal(recommend(lh(), v1(all)).recommendation.track, '특별(신생아)');
  assert.equal(recommend(lh(), v1(['생애최초', '신혼부부'])).recommendation.track, '특별(신혼부부)');
  // 신생아 단계가 없으면 다음 전형이다.
  const noNewborn = lh({ stages: schedule(SALE_ROWS.filter(([label]) => label !== '신생아')) });
  assert.equal(recommend(noNewborn, v1(all)).recommendation.track, '특별(신혼부부)');
  // 신생아 접수가 끝났으면 열린 다음 전형이다.
  const newbornEnded = lh({ stages: schedule([['신생아', '2026.11.03'], ['신혼부부', '2026.11.09'], ['일반공급 1순위', '2026.11.11']]) });
  const later = recommend(newbornEnded, v1(all));
  assert.deepEqual([later.recommendation.track, later.recommendation.date], ['특별(신혼부부)', '2026-11-09']);
});

test('v2 applicants get labelled segments and the 신생아 applicant wins the same-day tie', () => {
  const profile = v2([applicant('신청자A', { specialTracks: ['생애최초'] }), applicant('신청자B', { specialTracks: ['신생아'], pregnant: true })]);
  const result = recommend(lh(), profile);
  assert.equal(result.recommendation.track, '신청자B 특별(신생아)');
  assert.equal(result.recommendation.date, '2026-11-09');
  assert.equal(result.text, '추천: 신청자A 생애최초 특별공급 11/9 (1순위 일반공급 11/11도 가능) / 신청자B 신생아 특별공급 11/9 (1순위 일반공급 11/11도 가능); 소득·자산 기준 확인');
  // 신혼부부 시점 요건의 확인 항목은 v2와 같다(공공분양은 미혼이어도 남기고 예비신혼부부 여부 확인).
  const engaged = recommend(lh(), v2([applicant('신청자A', { specialTracks: ['신혼부부'] })]));
  assert.equal(engaged.recommendation.track, '신청자A 특별(신혼부부)');
  assert.equal(engaged.text, '추천: 신청자A 신혼부부 특별공급 11/9 (1순위 일반공급 11/11도 가능); 확인: 신청자A 예비신혼부부 여부; 소득·자산 기준 확인');
});

test('a 신혼희망타운 with 신혼부부 stages recommends 특별(신혼부부) for 신생아 or 신혼부부 tracks', () => {
  const town = lh({
    typeLabel: '공공분양신혼희망 공공분양신혼희망',
    name: '시험지구 신혼희망타운 입주자모집공고',
    stages: schedule([['예비신혼부부', '2026.12.03'], ['신혼부부', '2026.12.02 ~ 2026.12.04'], ['한부모가족', '2026.12.05']]),
  });
  assert.equal(lhRecommendable(town, config), true);
  const newborn = recommend(town, v1(['신생아']));
  assert.deepEqual([newborn.recommendation.track, newborn.recommendation.date, newborn.recommendation.end], ['특별(신혼부부)', '2026-12-02', '2026-12-04']);
  assert.equal(newborn.text, '추천: 신혼부부 특별공급 12/2; 소득·자산 기준 확인');
  // 혼인하지 않은 세대는 예비신혼부부 단계, 혼인한 세대는 신혼부부 단계다.
  const single = recommend(town, v2([applicant('신청자A', { specialTracks: ['신혼부부'] })], { married: false }));
  assert.deepEqual([single.recommendation.track, single.recommendation.date], ['신청자A 특별(신혼부부)', '2026-12-03']);
  const married = recommend(town, v2([applicant('신청자A', { specialTracks: ['신혼부부'] })], { married: true, marriageRegistered: '2024-05-01' }));
  assert.deepEqual([married.recommendation.track, married.recommendation.date], ['신청자A 특별(신혼부부)', '2026-12-02']);
  // 생애최초만 있으면 신혼희망타운에서 고를 단계가 없다(한부모가족은 신청자 전형이 아니다).
  assert.deepEqual(recommend(town, v1(['생애최초'])), { recommendation: null, text: null });
  // 신혼희망타운이 아니면 신생아 전형으로 신혼부부 단계를 고르지 않는다.
  const plain = lh({ stages: schedule([['신혼부부', '2026.11.09']]) });
  assert.equal(recommend(plain, v1(['신생아'])).recommendation, null);
});

test('without a matching special track an open 1순위 stage is recommended with the saving-amount note', () => {
  const none = recommend(lh(), v1([]));
  assert.deepEqual([none.recommendation.track, none.recommendation.date], ['1순위', '2026-11-11']);
  assert.equal(none.text, '추천: 1순위 일반공급 11/11; 소득·자산 기준 확인; 공공분양 일반공급은 납입 인정 금액 순');
  // 특별공급 접수가 끝났으면 1순위로 간다.
  assert.equal(recommend(lh(), v1(['신혼부부']), '2026-11-10').recommendation.track, '1순위');
  // 이름에 거주 구분이 있으면 신청자와 어긋나는 1순위 단계는 고르지 않는다(인천 거주자의 서울 공고는 기타지역).
  const split = lh({ stages: schedule([['일반공급 1순위 해당지역', '2026.11.11'], ['일반공급 1순위 기타지역', '2026.11.12']]) });
  assert.equal(recommend(split, v1([])).recommendation.date, '2026-11-12');
  assert.equal(recommend(split, v1([], '서울')).recommendation.date, '2026-11-11');
  // v2는 1순위 조각이 하나라도 있으면 납입 인정 금액 순을 적는다.
  const mixed = recommend(lh(), v2([applicant('신청자A'), applicant('신청자B', { specialTracks: ['생애최초'] })]));
  assert.equal(mixed.recommendation.track, '신청자B 특별(생애최초)');
  assert.ok(mixed.text.endsWith('; 소득·자산 기준 확인; 공공분양 일반공급은 납입 인정 금액 순'), mixed.text);
});

test('무순위 stages are recommended as 무순위, 잔여 and 추가 stages under their own label', () => {
  for (const [label, track] of [['무순위', '무순위'], ['무순위 추가접수', '무순위'], ['잔여세대', '잔여세대'], ['추가모집', '추가모집'], ['일반공급 추가접수', '일반공급 추가접수']]) {
    const result = recommend(lh({ stages: schedule([[label, '2026.11.12']]) }), v1(['신혼부부']));
    assert.equal(result.recommendation.track, track, label);
    assert.equal(result.text, `추천: ${track} 11/12; 소득·자산 기준 확인`, label);
  }
  const v2Result = recommend(lh({ stages: schedule([['잔여세대', '2026.11.12']]) }), v2([applicant('신청자A'), applicant('신청자B')]));
  assert.equal(v2Result.recommendation.track, '신청자A 잔여세대');
  assert.equal(v2Result.text, '추천: 신청자A·신청자B 잔여세대 11/12; 소득·자산 기준 확인');
  // 끝났으면 추천하지 않는다.
  assert.equal(recommend(lh({ stages: schedule([['잔여세대', '2026.11.03']]) }), v1([])).recommendation, null);
});

test('a 1순위 stage restricted to a special type is never the general fallback', () => {
  // 신혼희망타운의 1순위·2순위 신혼부부 단계는 생애최초만 있는 신청자의 1순위가 아니다.
  const town = lh({
    typeLabel: '공공분양신혼희망 공공분양신혼희망',
    stages: schedule([['신혼부부 1순위', '2026.11.09'], ['신혼부부 2순위', '2026.11.10']]),
  });
  assert.deepEqual(town.stages.map((stage) => stage.name), ['1순위 신혼부부', '2순위 신혼부부']);
  assert.deepEqual(recommend(town, v1(['생애최초'])), { recommendation: null, text: null });
  // 신혼부부 전형이면 그 1순위 단계가 신혼부부 단계이고, 같은 단계를 `…도 가능`으로 다시 적지 않는다.
  const newlywed = recommend(town, v1(['신혼부부']));
  assert.equal(newlywed.recommendation.track, '특별(신혼부부)');
  assert.equal(newlywed.text, '추천: 신혼부부 특별공급 11/9; 소득·자산 기준 확인');

  // 공공분양의 신혼부부 우선·일반공급은 특별공급이고, 전형이 없는 신청자는 진짜 일반공급 1순위 날짜다.
  const sale = lh({ stages: schedule([['신혼부부 우선공급', '2026.11.09'], ['신혼부부 일반공급', '2026.11.10'], ['일반공급 1순위', '2026.11.12']]) });
  assert.deepEqual(sale.stages.map((stage) => stage.name), ['특별공급 신혼부부 우선공급', '특별공급 신혼부부 일반공급', '1순위 일반공급']);
  const general = recommend(sale, v1([]));
  assert.deepEqual([general.recommendation.track, general.recommendation.date], ['1순위', '2026-11-12']);
  const special = recommend(sale, v1(['신혼부부']));
  assert.equal(special.text, '추천: 신혼부부 특별공급 11/9 (1순위 일반공급 11/12도 가능); 소득·자산 기준 확인');
});

test('a combined 해당지역·기타지역 1순위 stage is open to every residence', () => {
  const combined = lh({ stages: schedule([['일반공급 1순위 해당지역·기타지역', '2026.11.11']]) });
  assert.equal(recommend(combined, v1([])).recommendation.date, '2026-11-11');
  assert.equal(recommend(combined, v1([], '서울')).recommendation.date, '2026-11-11');
});

test('a 신생아 track is not mapped to 신혼부부 stages when the 신혼부부 track fails its timing check', () => {
  const town = lh({
    typeLabel: '공공분양신혼희망 공공분양신혼희망',
    stages: schedule([['신혼부부', '2026.11.09'], ['예비신혼부부', '2026.11.10']]),
  });
  // 혼인 7년이 지나 신혼부부 전형은 빠지고, 임신 중이라 신생아 전형은 남는다.
  const old = v2([applicant('신청자A', { specialTracks: ['신혼부부', '신생아'], pregnant: true })], { married: true, marriageRegistered: '2018-01-01' });
  assert.deepEqual(recommend(town, old), { recommendation: null, text: null });
  // 신혼부부 전형이 없으면 신생아 전형으로 고른다.
  const newborn = v2([applicant('신청자A', { specialTracks: ['신생아'], pregnant: true })], { married: true, marriageRegistered: '2018-01-01' });
  assert.equal(recommend(town, newborn).recommendation.track, '신청자A 특별(신혼부부)');
});

test('the interest alert shows the LH v2 recommendation and the short reason never carries it', async () => {
  const profile = v2([applicant('신청자A'), applicant('신청자B', { specialTracks: ['생애최초'] })]);
  const evaluation = await evaluateLotto(lh({ stages: schedule([['잔여세대', today]]) }), { config, today, profile, getModels: async () => null, getTrades: async () => [] });
  assert.equal(evaluation.recommendation.track, '신청자A 잔여세대');
  const row = { id: 'p', key: 'LH-t1', name: '시험지구', interest: true, start: '2026-11-01', end: '2026-11-20', urgentDate: null, link: null, recommendTrack: evaluation.recommendation.track, recommendDate: evaluation.recommendation.date, recommendEnd: null };
  const [item] = selectInterest([row], today);
  assert.equal(item.stage.name, '신청자A 잔여세대');
  assert.ok(buildKakaoText({ notice: item.notice, stage: item.stage, prefix: '[관심 청약]', verb: '오늘 접수' }).includes('신청자A 잔여세대'));

  // 판별 불가로 이전 로또를 유지해도 카카오톡 짧은 근거에는 추천 문구와 이름표가 없다.
  const sale = lh({ address: '서울특별시 강서구 마곡동', models: [{ houseType: '084A', area: 84, price: 100000, households: 10 }], stages: schedule([['생애최초', today]]) });
  const undetermined = await evaluateLotto(sale, { config, today, profile, getModels: async () => null, getTrades: async () => [] });
  assert.equal(undetermined.status, '판별 불가');
  assert.ok(undetermined.reason.includes('신청자B'), undetermined.reason);
  const kept = keepPreviousLotto(undetermined, '로또');
  assert.equal(kept.status, '로또');
  assert.ok(!kept.shortReason.includes('신청자') && !kept.shortReason.includes('추천'), kept.shortReason);
  const text = buildKakaoText({ notice: { name: '시험지구', url: null }, stage: sale.stages[0], reason: kept.shortReason });
  assert.ok(!text.includes('신청자'), text);
});

test('out-of-region applicants, failed detail lookups and non-sale LH notices get no recommendation', () => {
  const none = { recommendation: null, text: null };
  assert.deepEqual(recommend(lh(), v1(['신혼부부'], '부산')), none);
  assert.deepEqual(recommend(lh({ region: '부산' }), v1(['신혼부부'])), none);
  for (const state of ['failed', 'capped', 'supply_failed', 'no_codes', undefined]) {
    assert.deepEqual(recommend(lh({ lhDetailState: state }), v1(['신혼부부'])), none, String(state));
  }
  assert.deepEqual(recommend(lh({ stages: [] }), v1(['신혼부부'])), none);
  assert.deepEqual(recommend(lh({ typeLabel: '임대주택 국민임대' }), v1(['신혼부부'])), none);
  assert.deepEqual(recommend(lh({ typeLabel: '공공주택 기타' }), v1(['신혼부부'])), none);
  // 2순위만 열려 있으면 추천하지 않는다.
  assert.deepEqual(recommend(lh(), v1(['신혼부부']), '2026-11-12'), none);
  // 나눔형도 접수 단계는 같아 추천한다.
  assert.equal(recommend(lh({ typeLabel: '분양주택 나눔형' }), v1(['신혼부부'])).recommendation.track, '특별(신혼부부)');
});

test('LH notices are never dropped as unapplicable', () => {
  const profile = v1(['신혼부부'], '부산');
  for (const notice of [lh(), lh({ stages: schedule([['신혼부부', '2026.10.01']]) }), lh({ region: '부산' })]) {
    assert.equal(unapplicableReason({ notice, models: null, profile, config, today }), null);
  }
});

test('evaluateLotto attaches the LH recommendation and keeps the stored one when the lookup failed', async () => {
  const options = { config, today, profile: v1(['신혼부부']), getModels: async () => { throw new Error('LH must not call getModels'); }, getTrades: async () => [] };
  const ok = await evaluateLotto(lh({ address: '서울특별시 강서구' }), options);
  assert.equal(ok.recommendation.track, '특별(신혼부부)');
  assert.equal(ok.unapplicable, null);
  assert.ok(ok.reason.endsWith('\n추천: 신혼부부 특별공급 11/9 (1순위 일반공급 11/11도 가능); 소득·자산 기준 확인'), ok.reason);
  const props = buildProperties(lh(), ok, today);
  assert.equal(props['추천 전형'].select.name, '특별(신혼부부)');
  assert.deepEqual(props['추천 접수일'].date, { start: '2026-11-09' });

  for (const state of ['failed', 'capped', 'supply_failed']) {
    const kept = await evaluateLotto(lh({ lhDetailState: state }), options);
    assert.equal(kept.recommendation, undefined, state);
    assert.ok(kept.reason.endsWith('\n(추천: 조회 실패로 이전 값 유지)'), kept.reason);
    const keptProps = buildProperties(lh(), kept, today);
    assert.equal(keptProps['추천 전형'], undefined);
    assert.equal(keptProps['추천 접수일'], undefined);
  }
  // 요청 코드가 없는 공고는 예전처럼 추천을 비운다.
  const noCodes = await evaluateLotto(lh({ lhDetailState: 'no_codes' }), options);
  assert.equal(noCodes.recommendation, null);
});
