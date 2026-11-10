// 지역 브리핑(src/pipeline/briefs.js): 서울 구와 공공주택지구 브리핑의 문장 틀과 출처 번호
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NAVER_FOOT, SEOUL_BRIEF_BASIS, TOWN_BRIEF_BASIS, buildBriefs, districtBrief, districtStats, expectedLabel, josa, latestMains, titleHasBlock,
  townBrief, windowRangeText,
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
  assert.deepEqual(['t', 's', 'mid', 'late', 'early', 'rank', 'tied'].map((k) => stats.get('중구')[k]), [6, 6, 0, 2, 0, 1, false]);
  assert.deepEqual(['t', 's', 'mid', 'late', 'early', 'rank', 'tied'].map((k) => stats.get('강남구')[k]), [3, 2, 1, 2, 0, 2, false]);
  assert.equal(stats.get('중랑구').rank, 3);
  assert.equal(stats.get('도봉구').rank, 4);
  assert.equal(stats.get('종로구').rank, 4); // 0곳끼리는 같은 순위
  assert.equal(stats.get('종로구').tied, true);
  assert.equal(stats.get('종로구').t, 0);
});

// 네이버 검색이 성공한 사업 id(관련 소식을 모은 빌드)
const searchedAll = (projects) => new Set(projects.map((p) => p.id));

test('district brief: a 구 with a 공고 중 project, latest notice and a Naver item (never its title)', () => {
  const projects = seoulProjects();
  const stats = districtStats(projects);
  const brief = districtBrief('중랑구', stats, { seoulAsOf: '2026-06', today, newsSearched: searchedAll(projects) });
  assert.equal(brief.headline, '중랑구, 중화3 청약 공고 중');
  const [p1, p2, p3] = textOf(brief);
  // 1년 안과 1~3년 사이를 나눠 적고, 단계는 수만 적는다(평가·전망 없음)
  assert.equal(p1, '중랑구 정비사업 3곳 중 청약 예상 시기는 1년 안 **1곳**, 1~3년 사이 0곳입니다. '
    + '관리처분인가 이후(이주·착공 포함) 1곳, 초기 단계(구역지정~조합설립) 2곳입니다.');
  assert.equal(p2, '1년 안 사업 중 계획 세대가 가장 큰 곳은 **중화3**(176세대, 착공)입니다. 예상 시기가 가장 이른 곳은 **중화3**입니다. '
    + '1년 안 사업 1곳 중 1곳은 도시정비형(도심 업무지구형) 재개발입니다.');
  assert.equal(p3, '최근 청약홈 공고는 **중화역 라온프라이빗 센트로**(중화3, 11월 6일)였습니다. 최근 2주 기사 중에는 중화3 관련 소식(뉴시스, 11.08)이 가장 최근입니다.');
  assert.ok(!JSON.stringify(brief).includes('흥행')); // 네이버 제목은 옮기지 않는다
  assert.deepEqual(brief.foot.map((f) => f.label), ['서울시 정비사업 추진현황 (2026-06 기준)', '청약홈 공고 연결 (11-10 수집)', NAVER_FOOT]);
  assert.equal(NAVER_FOOT, '네이버 뉴스 검색 결과로 사업별 최근 기사의 언론사와 날짜만 사용');
  assert.equal(brief.foot[2].url, null);
  assert.ok(brief.foot.slice(0, 2).every((f) => /^https:\/\//.test(f.url)));
  assert.equal(brief.basis, SEOUL_BRIEF_BASIS);
  for (const banned of ['편입니다', '몇 년 뒤', '적거나', '기대할']) assert.ok(!JSON.stringify(brief).includes(banned), banned);
});

test('district brief: a 구 with no project within a year', () => {
  const projects = seoulProjects();
  const brief = districtBrief('도봉구', districtStats(projects), { seoulAsOf: '2026-06', today, newsSearched: searchedAll(projects) });
  assert.equal(brief.headline, '도봉구, 1년 안 청약 없이 초기 단계 2곳');
  assert.deepEqual(textOf(brief), [
    '도봉구 정비사업 2곳 중 청약 예상 시기는 1년 안 **0곳**, 1~3년 사이 0곳입니다. 관리처분인가 이후(이주·착공 포함) 사업은 없고, 초기 단계(구역지정~조합설립) 2곳입니다.',
    '최근 2주 사이 모은 기사는 없습니다.',
  ]);
});

test('district brief: says nothing about articles unless Naver search ran for that 구', () => {
  const projects = seoulProjects();
  const stats = districtStats(projects);
  // 관련 소식을 모으지 않은 빌드(키 없음 등): 기사 문장과 네이버 각주를 뺀다
  const none = districtBrief('도봉구', stats, { today, newsSearched: null });
  assert.equal(textOf(none).length, 1);
  assert.ok(!JSON.stringify(none).includes('기사'));
  assert.deepEqual(none.foot.map((f) => f.label), ['서울시 정비사업 추진현황', '청약홈 공고 연결 (11-10 수집)']);
  // 모았지만 이 구의 사업은 하나도 검색하지 않았다(검색 대상 밖·중간에 멈춤): '없다'고 말하지 않는다
  const other = districtBrief('도봉구', stats, { today, newsSearched: new Set(['seoul-1']) });
  assert.ok(!textOf(other).join('').includes('모은 기사는 없습니다'));
  // 모으지 않았으면 사업에 남은 기사가 있어도 쓰지 않는다
  assert.ok(!textOf(districtBrief('중랑구', stats, { today, newsSearched: null })).join('').includes('관련 소식'));
});

test('district brief: all-재건축 구, the busiest 구 and shared ranks', () => {
  const projects = seoulProjects();
  const stats = districtStats(projects);
  const gangnam = districtBrief('강남구', stats, { today });
  assert.equal(gangnam.headline, '강남구, 1년 안 청약 2곳 대치우성1차 먼저');
  assert.equal(textOf(gangnam)[1], '1년 안 사업 중 계획 세대가 가장 큰 곳은 **대치우성1차**(1,332세대, 사업시행인가)입니다. '
    + '예상 시기가 가장 이른 곳은 **대치우성1차, 일원개포한신**입니다. 1년 안 사업은 모두 재건축입니다.');
  assert.equal(textOf(gangnam)[0], '강남구 정비사업 3곳 중 청약 예상 시기는 1년 안 **2곳**, 1~3년 사이 1곳입니다. '
    + '관리처분인가 이후(이주·착공 포함) 2곳이고, 초기 단계(구역지정~조합설립) 사업은 없습니다.');
  assert.equal(gangnam.foot[0].label, '서울시 정비사업 추진현황');

  const jung = districtBrief('중구', stats, { today });
  assert.equal(jung.headline, '중구, 1년 안 청약 6곳으로 서울에서 가장 많다');
  assert.match(textOf(jung)[1], /1년 안 사업 6곳 중 4곳은 도시정비형\(도심 업무지구형\) 재개발입니다\.$/);
  // 사업이 없는 구는 브리핑이 없다
  assert.equal(districtBrief('종로구', stats, { today }), null);

  // 1년 안 수가 같은 구가 있으면 '공동'
  const more = [...projects, ...[1, 2, 3, 4, 5, 6].map((i) => seoul('마포구', { name: `마포${i}`, bucket: 'soon', window: { from: '2026-12', to: '2027-12' } }))];
  const tiedStats = districtStats(more);
  assert.equal(districtBrief('중구', tiedStats, { today }).headline, '중구, 1년 안 청약 6곳으로 서울에서 공동으로 가장 많다');
  const third = [...more, ...[1, 2, 3, 4, 5, 6, 7].map((i) => seoul('송파구', { name: `송파${i}`, bucket: 'soon' }))];
  assert.equal(districtBrief('마포구', districtStats(third), { today }).headline, '마포구, 1년 안 청약 6곳으로 서울에서 공동 2번째');
  // 관리처분인가 이후·초기 단계가 모두 0곳이면 둘 다 없다고 적는다
  const mid = districtBrief('광진구', districtStats([seoul('광진구', { stage: '건축심의' })]), { today });
  assert.equal(textOf(mid)[0], '광진구 정비사업 1곳 중 청약 예상 시기는 1년 안 **0곳**, 1~3년 사이 0곳입니다. '
    + '관리처분인가 이후(이주·착공 포함) 사업과 초기 단계(구역지정~조합설립) 사업은 없습니다.');
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
  assert.equal(p1, '하남교산의 가장 최근 본청약은 **A2**(교산 푸르지오 더 퍼스트, 1,115세대)로 2025년 3월 공고됐습니다.[1] '
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
  assert.equal(textOf(brief)[0], '하남교산의 가장 최근 본청약은 **B-1**(신안인스빌 디센트, 213세대)로 2026년 10월 공고됐습니다.[1] 지금 청약 접수 중이고, 당첨자 발표는 11월 17일입니다.[1]');
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
  assert.equal(textOf(townBrief(withPlan, { today }))[1], '아직 블록이 정해지지 않아 첫 분양은 2029년 목표라는 발표·보도가 있습니다.[1]');
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
    assert.ok(brief.headline && Array.isArray(brief.paras) && brief.paras.length >= 1 && brief.basis);
    assert.ok(brief.paras.every((p) => p.every((s) => typeof s.t === 'string' && s.t.length > 0)));
    assert.ok(brief.foot.every((f) => f.url === null || /^https?:\/\//.test(f.url)));
  }
});

test('town brief: same-day 본청약 blocks are listed together with per-block competition; titles that repeat the block are dropped', () => {
  const lh = (n) => ({ title: 'LH청약플러스', outlet: 'LH청약플러스', url: `https://apply.lh.or.kr/${n}`, date: '2025-11-27' });
  const report = { title: '경쟁률 (뉴시스)', url: 'https://www.newsis.com/b17', date: '2025-12-14' };
  const wangsuk = {
    id: 'town-namyangju-wangsuk', name: '남양주왕숙', kind: '공공주택지구', stage: '블록별 분양', window: { from: '2026-11', to: '2026-11' }, notices: [], sources: [],
    history: [
      { block: 'A-1', stage: '본청약', type: '공공분양', title: '남양주왕숙 A-01', households: 629, noticeDate: '2025-07-24', rental: false, sources: [lh('a1')] },
      {
        block: 'B-17', stage: '본청약', type: '공공분양', households: 491, noticeDate: '2025-11-27', rental: false, sources: [lh('b17')],
        competition: { rate: 109.6, scope: '일반공급', source: report },
      },
      {
        block: 'A-24', stage: '본청약', type: '신혼희망타운', households: 390, noticeDate: '2025-11-27', rental: false, sources: [lh('a24')],
        competition: { rate: 24.9, scope: '일반공급', source: report },
      },
    ],
    plans: [],
    blocks: [],
  };
  assert.deepEqual(latestMains(wangsuk, today).map((e) => e.block), ['B-17', 'A-24']);
  const brief = townBrief(wangsuk, { today });
  assert.equal(brief.headline, '남양주왕숙, 최근 본청약은 B-17·A-24');
  assert.equal(textOf(brief)[0], '남양주왕숙의 가장 최근 본청약은 **B-17**(공공분양, 491세대)·**A-24**(신혼희망타운, 390세대)로 2025년 11월 공고됐습니다.[1][2] '
    + '일반공급 경쟁률은 B-17 109.6 대 1, A-24 24.9 대 1이었습니다.[3]');

  // 제목에 블록 이름이 이미 있으면(A03 = A-3) 제목 대신 유형
  assert.equal(titleHasBlock('남양주왕숙2 A03', 'A-3'), true);
  assert.equal(titleHasBlock('계양신도시 카이브 유보라(AC4BL)', 'AC4'), true);
  assert.equal(titleHasBlock('교산 푸르지오 더 퍼스트', 'A2'), false);
  assert.equal(titleHasBlock('남양주왕숙2 A-13', 'A-3'), false);
  const w2 = { ...wangsuk, history: [{ block: 'A-3', stage: '본청약', type: '공공분양', title: '남양주왕숙2 A03', households: 686, noticeDate: '2026-04-30', rental: false, sources: [lh('w2')] }] };
  assert.equal(textOf(townBrief(w2, { today }))[0], '남양주왕숙의 가장 최근 본청약은 **A-3**(공공분양, 686세대)로 2026년 4월 공고됐습니다.[1]');
});

test('town brief: a 분양가 item already cited as the competition source is not repeated', () => {
  const etoday = { title: '카이브 유보라 (이투데이)', url: 'https://www.etoday.co.kr/news/view/2644642', date: '2026-11-05' };
  const town = {
    id: 'town-incheon-gyeyang', name: '인천계양', kind: '공공주택지구', stage: '블록별 분양', window: { from: '2027-01', to: '2027-06' }, notices: [], sources: [], plans: [], blocks: [],
    history: [{
      block: 'AC4', stage: '본청약', type: '민간분양', title: '계양신도시 카이브 유보라(AC4BL)', households: 496, noticeDate: '2026-10-23', rental: false,
      sources: [{ title: '청약홈', outlet: '청약홈', url: 'https://www.applyhome.co.kr/ac4', date: '2026-10-23' }],
      competition: { rate: 0.97, scope: '1·2순위', source: etoday },
    }],
  };
  const items = [{
    projectId: 'town-incheon-gyeyang', block: 'AC3·AC4', date: '2026-11-05', title: '카이브 유보라 1·2순위 0.92대 1·0.97대 1, 84㎡ 최고 분양가 8억2600만 원',
    outlet: '이투데이', url: etoday.url, local: false, rental: false, kind: '뉴스',
  }];
  const p1 = textOf(townBrief(town, { curated: items, today }))[0];
  assert.equal(p1, '인천계양의 가장 최근 본청약은 **AC4**(민간분양, 496세대)로 2026년 10월 공고됐습니다.[1] 1·2순위 경쟁률은 0.97 대 1이었습니다.[2]');
  // 경쟁률 출처가 다르면 분양가 기사를 붙인다
  town.history[0].competition.source = { ...etoday, url: 'https://www.etoday.co.kr/other' };
  assert.match(textOf(townBrief(town, { curated: items, today }))[0], /최고 분양가 8억2600만 원\.\[3\]$/);
});

test('window range text: a whole calendar year reads as the year', () => {
  assert.equal(windowRangeText('2029-01', '2029-12'), '2029년');
  assert.equal(windowRangeText('2028-12', '2030-12'), '2028년 12월에서 2030년 12월 사이');
  assert.equal(windowRangeText('2026-11', '2026-11'), '2026년 11월');
  assert.equal(windowRangeText('2029-01', '2030-12'), '2029년 1월에서 2030년 12월 사이');
});
