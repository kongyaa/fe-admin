// 지역 브리핑(src/pipeline/briefs.js): 서울 구와 공공주택지구 브리핑의 문장 틀과 출처 번호
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NAVER_FOOT, SEOUL_BRIEF_BASIS, TOWN_BRIEF_BASIS, buildBriefs, districtBrief, districtStats, expectedLabel, josa, townBrief,
} from '../src/pipeline/briefs.js';

const today = '2026-11-10';
// 조각을 글로: 굵게는 **, 각주는 [n]
const textOf = (brief) => brief.paras.map((p) => p.map((s) => (s.note ? `[${s.t}]` : s.b ? `**${s.t}**` : s.t)).join(''));

let seq = 0;
const seoul = (district, extra) => {
  seq += 1;
  return {
    id: `seoul-${seq}`, name: `사업${seq}`, kind: '재개발', subKind: '주택정비형 재개발', region: '서울', district, stage: '조합설립',
    bucket: 'far', window: { from: '2030-01', to: '2031-01' }, households: null, notices: [], ...extra,
  };
};

const seoulProjects = () => [
  // 중랑구: 공고 중 1곳 + 초기 단계
  seoul('중랑구', {
    name: '중화3', stage: '착공', bucket: 'live', subKind: '도시정비형 재개발', households: 176, window: { from: '2025-12', to: '2026-12' },
    notices: [{ key: 'n1', name: '중화역 라온프라이빗 센트로', announceDate: '2026-11-06', url: 'https://www.applyhome.co.kr/1' }],
    news: [{ title: '중화3구역 일반분양 흥행', outlet: '뉴시스', date: '2026-11-08', url: 'https://www.newsis.com/x' }],
  }),
  seoul('중랑구', { stage: '추진위' }),
  seoul('중랑구', { stage: '구역지정' }),
  // 도봉구: 1년 안 0곳, 초기 단계만
  seoul('도봉구', { stage: '구역지정' }),
  seoul('도봉구', { stage: '조합설립' }),
  // 강남구: 1년 안 2곳 모두 재건축, 3년 안 1곳
  seoul('강남구', {
    name: '일원개포한신', kind: '재건축', subKind: '공동주택재건축', stage: '이주', bucket: 'soon', households: 498, window: { from: '2026-04', to: '2027-10' },
  }),
  seoul('강남구', {
    name: '대치우성1차', kind: '재건축', subKind: '공동주택재건축', stage: '사업시행인가', bucket: 'soon', households: 1332, window: { from: '2025-09', to: '2027-09' },
  }),
  seoul('강남구', { stage: '관리처분인가', bucket: 'mid', window: { from: '2028-01', to: '2029-01' } }),
  // 중구: 1년 안 6곳 중 4곳 도시정비형 → 서울에서 가장 많다
  ...[1, 2, 3, 4].map((i) => seoul('중구', {
    name: `세운${i}`, stage: '사업시행인가', bucket: 'soon', subKind: '도시정비형 재개발', window: { from: `2026-0${i}`, to: '2027-06' },
  })),
  ...[5, 6].map((i) => seoul('중구', { name: `신당${i}`, stage: '이주', bucket: 'soon', households: 1000 + i, window: { from: '2026-09', to: '2027-09' } })),
];

test('josa and labels', () => {
  assert.equal(josa('광명시흥', '은', '는'), '은');
  assert.equal(josa('하남교산', '은', '는'), '은');
  assert.equal(josa('구리갈매역세권', '은', '는'), '은');
  assert.equal(josa('부천대장', '은', '는'), '은');
  assert.equal(josa('남양주왕숙2', '은', '는'), '은'); // 숫자는 건너뛰고 '숙'을 본다
  assert.equal(josa('공공분양(지분적립형 284 포함)', '으로', '로'), '으로');
  assert.equal(josa('(1,115세대)', '으로', '로'), '로');
  assert.equal(josa('A9', '으로', '로'), '로');
  assert.equal(expectedLabel('2026-하반기'), '2026년 하반기');
  assert.equal(expectedLabel('2027-04'), '2027년 4월');
});

test('district stats: counts, late/early stages and shared ranks', () => {
  const stats = districtStats(seoulProjects());
  assert.deepEqual(['t', 's', 'mid', 'late', 'early', 'rank'].map((k) => stats.get('중구')[k]), [6, 6, 0, 2, 0, 1]);
  assert.deepEqual(['t', 's', 'mid', 'late', 'early', 'rank'].map((k) => stats.get('강남구')[k]), [3, 2, 1, 2, 0, 2]);
  assert.equal(stats.get('중랑구').rank, 3);
  assert.equal(stats.get('도봉구').rank, 4);
  assert.equal(stats.get('종로구').rank, 4); // 0곳끼리는 같은 순위
  assert.equal(stats.get('종로구').t, 0);
});

test('district brief: a 구 with a 공고 중 project, latest notice and a Naver item (never its title)', () => {
  const stats = districtStats(seoulProjects());
  const brief = districtBrief('중랑구', stats, { seoulAsOf: '2026-06', today });
  assert.equal(brief.headline, '중랑구, 중화3 청약 공고 중');
  const [p1, p2, p3] = textOf(brief);
  assert.equal(p1, '중랑구는 정비사업 3곳 가운데 **1곳**이 1년 안, 0곳이 3년 안에 청약이 예상됩니다. '
    + '1곳이 관리처분인가 이후(이주·착공 포함) 단계여서 아직은 초기 단계(2곳)가 더 많아 대부분은 몇 년 뒤의 일입니다.');
  assert.equal(p2, '1년 안 사업 중 계획 세대가 가장 큰 곳은 **중화3**(176세대, 착공)입니다. 예상 시기가 가장 이른 곳은 **중화3**입니다. '
    + '다만 1년 안 사업 1곳 중 1곳은 도심 업무지구형(도시정비형) 재개발이라 주택 수가 적거나 정해지지 않은 곳이 많습니다.');
  assert.equal(p3, '최근 청약홈 공고는 **중화역 라온프라이빗 센트로**(중화3, 11월 6일)였습니다. 최근 2주 기사 중에는 중화3 관련 소식(뉴시스, 11.08)이 가장 최근입니다.');
  assert.ok(!JSON.stringify(brief).includes('흥행')); // 네이버 제목은 옮기지 않는다
  assert.deepEqual(brief.foot.map((f) => f.label), ['서울시 정비사업 추진현황 (2026-06 기준)', '청약홈 공고 연결 (11-10 수집)', NAVER_FOOT]);
  assert.equal(brief.foot[2].url, null);
  assert.ok(brief.foot.slice(0, 2).every((f) => /^https:\/\//.test(f.url)));
  assert.equal(brief.basis, SEOUL_BRIEF_BASIS);
});

test('district brief: a 구 with no project within a year', () => {
  const brief = districtBrief('도봉구', districtStats(seoulProjects()), { seoulAsOf: '2026-06', today });
  assert.equal(brief.headline, '도봉구, 1년 안 청약 없이 초기 단계 2곳');
  assert.deepEqual(textOf(brief), [
    '도봉구는 정비사업 2곳 가운데 **0곳**이 1년 안, 0곳이 3년 안에 청약이 예상됩니다. 0곳이 관리처분인가 이후(이주·착공 포함) 단계여서 아직은 초기 단계(2곳)가 더 많아 대부분은 몇 년 뒤의 일입니다.',
    '당장 청약을 기대할 사업은 없고, 3년 안 예상도 없습니다.',
    '최근 2주 사이 모은 기사는 없습니다.',
  ]);
});

test('district brief: all-재건축 구 and the busiest 구', () => {
  const stats = districtStats(seoulProjects());
  const gangnam = districtBrief('강남구', stats, { today });
  assert.equal(gangnam.headline, '강남구, 1년 안 청약 2곳 대치우성1차 먼저');
  assert.equal(textOf(gangnam)[1], '1년 안 사업 중 계획 세대가 가장 큰 곳은 **대치우성1차**(1,332세대, 사업시행인가)입니다. '
    + '예상 시기가 가장 이른 곳은 **대치우성1차, 일원개포한신**입니다. 1년 안 사업은 모두 재건축입니다.');
  assert.match(textOf(gangnam)[0], /2곳이 관리처분인가 이후\(이주·착공 포함\) 단계여서 공급이 가까운 사업이 많은 편입니다\.$/);
  assert.equal(gangnam.foot[0].label, '서울시 정비사업 추진현황');

  const jung = districtBrief('중구', stats, { today });
  assert.equal(jung.headline, '중구, 1년 안 청약 6곳으로 서울에서 가장 많다');
  assert.match(textOf(jung)[1], /다만 1년 안 사업 6곳 중 4곳은 도심 업무지구형\(도시정비형\) 재개발/);
  // 사업이 없는 구는 브리핑이 없다
  assert.equal(districtBrief('종로구', stats, { today }), null);
});

// 공공주택지구(빌드 내부 형태: history·plans는 newtowns.js, blocks는 townBlocks 뒤의 줄)
const src = (outlet, date, n = 1) => ({ title: `기사 (${outlet})`, url: `https://news.example.com/${outlet}/${date}/${n}`, date });
const gyosan = () => ({
  id: 'town-hanam-gyosan', name: '하남교산', kind: '공공주택지구', region: '경기', district: '하남시', stage: '블록별 분양',
  stageDates: { 지구지정: '2019-10-15' }, households: 36697, window: { from: '2026-07', to: '2026-12' }, notices: [], sources: [],
  history: [
    { block: 'A2', stage: '사전청약', type: '공공분양', noticeDate: '2021-11-18', rental: false, sources: [src('뉴데일리', '2021-11-17')] },
    { block: 'A5', stage: '사전청약', type: '나눔형 공공분양', noticeDate: '2023-09-25', rental: false, sources: [src('메트로신문', '2023-09-20')] },
    {
      block: 'A2', stage: '본청약', type: '공공분양', title: '교산 푸르지오 더 퍼스트', households: 1115, noticeDate: '2025-03-31', rental: false,
      sources: [src('뉴시스', '2025-03-31')],
      competition: { rate: 263.3, scope: '일반공급', source: src('뉴시스', '2025-05-09') },
    },
  ],
  plans: [
    {
      blocks: ['D2', 'D5'], type: '민간분양', expected: '2026-상반기', from: '2026-01', to: '2026-06', rental: false, households: null, householdsByBlock: null,
      sources: [{ title: '기사 (하남Times, 지역지)', url: 'http://m.hanamtimes.com/1', date: '2025-12-13' }],
    },
    {
      blocks: ['A9', 'A11'], type: '공공분양', expected: '2026-하반기', from: '2026-07', to: '2026-12', rental: false, households: 755,
      householdsByBlock: { A9: 244, A11: 511 }, sources: [{ title: '기사 (하남일보, 지역지)', url: 'http://m.hanamilbo.net/1', date: '2026-03-08' }],
    },
    {
      blocks: ['A20'], type: '통합공공임대', expected: '2026-하반기', from: '2026-07', to: '2026-12', rental: true, households: 249,
      sources: [src('하남Times', '2025-12-13', 2)],
    },
  ],
  blocks: [
    { block: 'A2', rental: false, status: '본청약 공고', sources: [] },
    { block: 'A5', rental: false, status: '사업승인', sources: [] },
    { block: 'A9', rental: false, status: '다음 예정(보도)', sources: [] },
    { block: 'A11', rental: false, status: '다음 예정(보도)', sources: [] },
    { block: 'D2', rental: false, status: '예정 지남(보도)', sources: [] },
    { block: 'D5', rental: false, status: '예정 지남(보도)', sources: [] },
    { block: 'A20', rental: true, status: '다음 예정(보도)', sources: [] },
  ],
});
const item = (block, date, title, outlet = '뉴시스', extra = {}) => ({
  projectId: 'town-hanam-gyosan', block, date, title, outlet, url: `https://news.example.com/item/${date}/${outlet}`, local: false, rental: false, kind: '뉴스', ...extra,
});
const gyosanItems = () => [
  item('A2', '2025-03-31', 'A2 교산 푸르지오 더 퍼스트 본청약 분양가, 사전청약 추정가보다 약 17% 올라', '뉴시스'),
  item('A5', '2026-07-24', 'A5 사전청약 당첨자 대출 조건 갈등: 본청약 공고는 아직', '서울신문'),
  item(null, '2026-10-27', '송파하남선 착공 2027년·개통 2032년 목표', '머니투데이방송'),
  item(null, '2026-08-12', '하남시의회, 송파하남선 조속 추진 촉구', '서울신문'),
  item(null, '2026-08-04', '교산3고 중앙투자심사 통과', '한국교육신문'),
];

test('town brief with history and plans: latest 본청약, pending plans, 사전청약-only block, district items, numbered sources', () => {
  const brief = townBrief(gyosan(), { curated: gyosanItems(), today });
  assert.equal(brief.headline, '하남교산, 다음 차례는 A9·A11 공공분양');
  const [p1, p2, p3] = textOf(brief);
  assert.equal(p1, '하남교산의 가장 최근 본청약은 **A2 교산 푸르지오 더 퍼스트**(1,115세대)로 2025년 3월 공고됐습니다.[1] '
    + '일반공급 경쟁률은 263.3 대 1이었습니다.[2] A2 교산 푸르지오 더 퍼스트 본청약 분양가, 사전청약 추정가보다 약 17% 올라.[3]');
  // 기간이 남은 계획이 먼저, 지난 계획(D2·D5)은 뒤에 '시기가 지났다'로. 임대 계획(A20)은 넣지 않는다
  assert.equal(p2, '다음은 **A9(244세대)·A11(511세대)** 공공분양으로, 2026년 하반기 공급 예정이라는 지역지 보도가 있습니다.[4] '
    + '그다음은 **D2·D5** 민간분양으로, 2026년 상반기 공급 예정이라는 지역지 보도가 있었지만 그 시기가 지났습니다.[5] '
    + '11월 10일까지 공고는 확인되지 않았습니다. 사전청약만 한 **A5 나눔형 공공분양** 관련 최근 보도: A5 사전청약 당첨자 대출 조건 갈등: 본청약 공고는 아직.[6]');
  // 지구 전체 기사는 최근 2건만
  assert.equal(p3, '송파하남선 착공 2027년·개통 2032년 목표.[7] 하남시의회, 송파하남선 조속 추진 촉구.[8]');
  assert.deepEqual(brief.foot.map((f) => f.label), [
    '뉴시스 2025-03-31', '뉴시스 2025-05-09', '뉴시스 2025-03-31', '하남일보 2026-03-08 (지역지)', '하남Times 2025-12-13 (지역지)',
    '서울신문 2026-07-24', '머니투데이방송 2026-10-27', '서울신문 2026-08-12',
  ]);
  assert.ok(brief.foot.every((f) => /^https?:\/\//.test(f.url)));
  assert.equal(brief.basis, TOWN_BRIEF_BASIS);
  // 각주 번호는 모두 foot 안
  const notes = brief.paras.flat().filter((s) => s.note).map((s) => Number(s.t));
  assert.ok(notes.every((n) => n >= 1 && n <= brief.foot.length));
});

test('town brief: open reception makes the headline the winner date; same source keeps one number', () => {
  const town = gyosan();
  town.history.push({
    block: 'B-1', stage: '본청약', type: '민간분양', title: '신안인스빌 디센트', households: 213, noticeDate: '2026-10-30', end: '2026-11-11', rental: false,
    sources: [{ title: '청약홈 분양정보', outlet: '청약홈', url: 'https://www.applyhome.co.kr/b1', date: '2026-10-30' }],
  });
  town.notices = [{
    key: 'b1', name: '구리갈매역세권 신안인스빌 디센트', announceDate: '2026-10-30', url: 'https://www.applyhome.co.kr/b1', winnerDate: '2026-11-17',
    stages: [{ name: '1순위', start: '2026-11-10', end: '2026-11-10' }, { name: '2순위', start: '2026-11-11', end: '2026-11-11' }],
  }];
  town.blocks.push({ block: 'B-1', rental: false, status: '접수 중', sources: [{ title: '청약홈', url: 'https://www.applyhome.co.kr/b1' }] });
  const brief = townBrief(town, { curated: [], today });
  assert.equal(brief.headline, '하남교산, B-1 당첨 발표는 11월 17일');
  assert.equal(textOf(brief)[0], '하남교산의 가장 최근 본청약은 **B-1 신안인스빌 디센트**(213세대)로 2026년 10월 공고됐습니다.[1] 지금 청약 접수 중이고, 당첨자 발표는 11월 17일입니다.[1]');
  assert.equal(brief.foot[0].label, '청약홈 2026-10-30');
});

test('town brief without blocks: the short 2-paragraph form', () => {
  const topyeong = {
    id: 'town-guri-topyeong-hangang', name: '구리토평한강', kind: '공공주택지구', region: '경기', district: '구리시', stage: '지구지정',
    stageDates: { 후보지: '2023-11-15', 지구지정: '2025-12-31' }, households: 22000, window: { from: '2028-12', to: '2030-12' },
    history: [], plans: [], blocks: [], notices: [],
    sources: [
      { title: '명칭 (헤럴드경제)', url: 'https://www.heraldk.com/1', date: '2025-08-04' },
      { title: '계획 승인 (한국경제)', url: 'https://www.hankyung.com/1', date: '2025-12-31' },
    ],
  };
  const brief = townBrief(topyeong, { curated: [], today });
  assert.equal(brief.headline, '구리토평한강, 블록이 정해지기 전 단계');
  assert.deepEqual(textOf(brief), [
    '2025년 12월 공공주택지구로 지정됐고, 약 22,000세대가 계획돼 있습니다.[1] 지금은 지구지정 단계입니다.',
    '아직 블록이 정해지지 않아 첫 청약 시기는 규칙상 2028년 12월에서 2030년 12월 사이로 추정합니다.',
  ]);
  assert.deepEqual(brief.foot, [{ label: '한국경제 2025-12-31', url: 'https://www.hankyung.com/1' }]);

  // 보도된 지구 계획(expected)이 있으면 그 날짜의 출처를 단다
  const withPlan = {
    ...topyeong, expected: { from: '2029-01', to: '2029-12', basis: '국토부 발표(2025-12-31) 보도' }, window: { from: '2029-01', to: '2029-12' },
  };
  assert.equal(textOf(townBrief(withPlan, { today }))[1], '아직 블록이 정해지지 않아 첫 분양은 2029년 1월에서 2029년 12월 사이 목표라는 발표·보도가 있습니다.[1]');
});

test('buildBriefs: every 구 with projects and tracked towns only', () => {
  const town = gyosan();
  const untracked = { ...gyosan(), id: 'town-other', name: '다른지구' };
  const briefs = buildBriefs({
    projects: [...seoulProjects(), town, untracked],
    watchlist: [
      { name: '하남교산', tracked: true, projectId: 'town-hanam-gyosan' },
      { name: '다른지구', tracked: false, projectId: null },
      { name: '없는지구', tracked: true, projectId: 'town-missing' },
    ],
    curated: gyosanItems(),
    today,
    seoulAsOf: '2026-06',
  });
  assert.deepEqual(Object.keys(briefs).sort(), ['강남구', '도봉구', '중구', '중랑구', 'town-hanam-gyosan'].sort());
  assert.equal(briefs['town-other'], undefined);
  for (const brief of Object.values(briefs)) {
    assert.ok(brief.headline && Array.isArray(brief.paras) && brief.paras.length >= 2 && brief.basis);
    assert.ok(brief.paras.every((p) => p.every((s) => typeof s.t === 'string' && s.t.length > 0)));
    assert.ok(brief.foot.every((f) => f.url === null || /^https?:\/\//.test(f.url)));
  }
});
