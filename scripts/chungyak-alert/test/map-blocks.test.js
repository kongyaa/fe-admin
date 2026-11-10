// 블록별 현황(src/pipeline/blocks.js) 검사: yaml blocks·분양 이력·연결 공고·보도 계획을 블록 줄로 합치는 규칙
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BLOCK_STATUS_ORDER, BLOCK_STATUSES, blockSummary, compareBlocks, nameHasBlock, noticeRowKey, publicBlockTotal, townBlocks,
} from '../src/pipeline/blocks.js';

const today = '2026-11-10';
const src = (name, date = null) => [{ title: `${name} 기사`, url: `https://example.com/${name}`, date }];
const entry = (block, extra = {}) => ({
  block, type: null, households: null, rental: false, status: '미정', statusDate: null, note: null, sources: src(block), ...extra,
});
const hist = (block, noticeDate, extra = {}) => ({
  block, stage: '본청약', type: null, title: null, households: null, noticeDate, rental: false, note: null, sources: src(`h-${block}`), ...extra,
});
const plan = (blocks, expected, extra = {}) => ({
  blocks, type: null, households: null, householdsByBlock: null, expected, from: null, to: null, rental: false, note: null,
  sources: src(`p-${blocks.join('')}`, '2025-12-13'), ...extra,
});
const notice = (name, announceDate, end, extra = {}) => ({
  key: name, name, announceDate, end, url: `https://www.applyhome.co.kr/${encodeURIComponent(name)}`, typeLabel: 'APT', ...extra,
});
const byBlock = (rows) => Object.fromEntries(rows.map((row) => [`${row.block}${row.rental ? '(임대)' : ''}`, row]));

test('yaml 상태 값과 화면 상태 순서', () => {
  assert.deepEqual(BLOCK_STATUSES, ['사업승인', '착공', '계획 보도', '미정']);
  assert.deepEqual(BLOCK_STATUS_ORDER, ['접수 중', '분양 끝남', '임대 공고', '다음 예정(보도)', '착공', '사업승인', '계획 보도', '미정']);
  // yaml 상태는 모두 화면 순서에 있다
  for (const status of BLOCK_STATUSES) assert.ok(BLOCK_STATUS_ORDER.includes(status), status);
});

test('status rules: 접수 중 > 분양 끝남 > 임대 공고 > 다음 예정(보도) > yaml 상태 > 미정', () => {
  const rows = townBlocks({
    entries: [
      entry('A1', { status: '사업승인', statusDate: '2025-11-24', type: '공공분양', households: 700 }),
      entry('A2', { status: '사업승인', statusDate: '2025-11-24', households: 1115 }),
      entry('A3', { status: '착공', statusDate: '2026-02' }),
      entry('A4', { status: '사업승인', statusDate: '2025-11-24' }),
      entry('A5', { status: '사업승인', statusDate: '2025-11-24', households: 492, type: '나눔형 공공분양' }),
      entry('A6'),
      entry('A7', { rental: true, status: '사업승인', statusDate: '2026-04-23' }),
    ],
    history: [
      hist('A2', '2021-11-18', { stage: '사전청약', households: 1056 }),
      hist('A2', '2025-03-31', { type: '공공분양', households: 1115, title: '교산 푸르지오 더 퍼스트' }),
      hist('A5', '2023-09-25', { stage: '사전청약', households: 452 }),
      hist('A7', '2026-10-27', { rental: true, type: '행복주택' }),
      // 오늘 뒤 날짜의 이력은 아직 난 공고가 아니다
      hist('A8', '2026-12-01'),
    ],
    plans: [plan(['A4', 'A9'], '2026-하반기', { from: '2026-07', to: '2026-12', householdsByBlock: { A4: 10, A9: 244 } })],
    notices: [notice('하남교산 A-1BL 공공분양', '2026-11-01', '2026-11-20')],
    stageDate: '2025-03-31',
    today,
  });
  const by = byBlock(rows);
  assert.deepEqual([by.A1.status, by.A1.statusDate], ['접수 중', '2026-11-20']);
  assert.deepEqual(by.A1.timeline, [{ stage: '본청약', date: '2026-11-01' }, { stage: '접수 중', date: '2026-11-20' }]);
  assert.ok(by.A1.sources.some((s) => s.outlet === '청약홈'));
  // 본청약 이력이 yaml 상태보다 앞서고, 사전청약은 경과에만 보인다
  assert.deepEqual([by.A2.status, by.A2.statusDate, by.A2.households, by.A2.type], ['분양 끝남', '2025-03-31', 1115, '공공분양']);
  assert.deepEqual(by.A2.timeline, [{ stage: '사전청약', date: '2021-11-18' }, { stage: '본청약', date: '2025-03-31' }]);
  assert.deepEqual([by.A3.status, by.A3.statusDate], ['착공', '2026-02']);
  // 보도 계획이 yaml 상태보다 앞선다. 세대 수는 yaml이 없으면 계획의 블록별 값
  assert.deepEqual([by.A4.status, by.A4.statusDate, by.A4.households], ['다음 예정(보도)', '2025-12-13', 10]);
  assert.deepEqual(by.A4.plan, {
    expected: '2026-하반기', from: '2026-07', to: '2026-12', source: { title: 'p-A4A9 기사', url: 'https://example.com/p-A4A9', date: '2025-12-13' },
  });
  assert.deepEqual([by.A9.status, by.A9.households, by.A9.block], ['다음 예정(보도)', 244, 'A9']);
  assert.deepEqual([by.A5.status, by.A5.households, by.A5.type], ['사업승인', 492, '나눔형 공공분양']);
  assert.deepEqual(by.A5.timeline, [{ stage: '사전청약', date: '2023-09-25' }]);
  assert.deepEqual([by.A6.status, by.A6.statusDate, by.A6.plan], ['미정', null, null]);
  assert.deepEqual([by['A7(임대)'].status, by['A7(임대)'].statusDate, by['A7(임대)'].type], ['임대 공고', '2026-10-27', '행복주택']);
  // 이력만 있는 블록도 줄이 된다(오늘 뒤 공고라 상태는 미정)
  assert.deepEqual([by.A8.status, by.A8.timeline], ['미정', [{ stage: '본청약', date: '2026-12-01' }]]);
  // 정렬: 상태 순서, 같으면 블록 이름(숫자 크기순)
  assert.deepEqual(rows.map((row) => row.block), ['A1', 'A2', 'A7', 'A4', 'A9', 'A3', 'A5', 'A6', 'A8']);
  assert.deepEqual(blockSummary(rows), { '접수 중': 1, '분양 끝남': 1, '임대 공고': 1, '다음 예정(보도)': 2, 착공: 1, 사업승인: 1, 미정: 2 });
});

test('the same block splits into a sale row and a rental row', () => {
  const rows = townBlocks({
    history: [
      hist('A1', '2021-12-29', { stage: '사전청약', type: '신혼희망타운', households: 1125 }),
      hist('A-1', '2025-07-29', { type: '신혼희망타운', households: 1182 }),
      hist('A-1', '2026-10-27', { rental: true, type: '행복주택', households: 609 }),
    ],
    today,
  });
  assert.deepEqual(rows.map((row) => [row.block, row.rental, row.status, row.households, row.type]), [
    ['A-1', false, '분양 끝남', 1182, '신혼희망타운'],
    ['A-1', true, '임대 공고', 609, '행복주택'],
  ]);
  assert.deepEqual(rows[0].timeline.map((t) => t.stage), ['사전청약', '본청약']);
});

test('a plan is pending until a notice for that row on or after the report date', () => {
  const base = { plans: [plan(['A9'], '2026-하반기'), plan(['S2'], '2026-하반기', { rental: true })], today };
  assert.equal(byBlock(townBlocks(base)).A9.status, '다음 예정(보도)');
  assert.equal(byBlock(townBlocks(base))['S2(임대)'].status, '다음 예정(보도)');
  // 보도일(2025-12-13)보다 이른 공고는 계획을 채우지 않는다. 상태는 그래도 분양 끝남(공고가 있었음)
  const early = byBlock(townBlocks({ ...base, history: [hist('A9', '2025-06-01')] })).A9;
  assert.deepEqual([early.status, early.plan?.expected], ['분양 끝남', '2026-하반기']);
  // 보도 뒤 공고는 계획을 채운다
  const after = byBlock(townBlocks({ ...base, history: [hist('A9', '2026-09-01')] })).A9;
  assert.deepEqual([after.status, after.plan], ['분양 끝남', null]);
  // 임대 계획은 임대 이력이 채운다(분양 이력은 안 채움)
  const rental = byBlock(townBlocks({ ...base, history: [hist('S2', '2026-09-01'), hist('S2', '2026-09-02', { rental: true })] }));
  assert.deepEqual([rental['S2(임대)'].status, rental['S2(임대)'].plan], ['임대 공고', null]);
  assert.equal(rental.S2.status, '분양 끝남');
  // 사전청약은 계획을 채우지 않는다
  const pre = byBlock(townBlocks({ ...base, history: [hist('A9', '2026-09-01', { stage: '사전청약' })] })).A9;
  assert.deepEqual([pre.status, pre.plan?.expected], ['다음 예정(보도)', '2026-하반기']);
  // 연결된 공고도 계획을 채운다
  const linked = byBlock(townBlocks({ ...base, notices: [notice('하남교산 A9블록', '2026-11-01', '2026-11-05')] })).A9;
  assert.deepEqual([linked.status, linked.statusDate, linked.plan], ['분양 끝남', '2026-11-01', null]);
  // 출처에 날짜가 없으면 단계 날짜가 하한, 그것도 없으면 하한 없음
  const undated = plan(['A9'], '2027-09', { sources: [{ title: '일정표', url: 'https://example.com/x', date: null }] });
  const bounded = byBlock(townBlocks({ plans: [undated], history: [hist('A9', '2025-01-01')], stageDate: '2025-03-31', today })).A9;
  assert.deepEqual([bounded.plan?.expected, bounded.plan?.source?.date], ['2027-09', null]);
  assert.equal(byBlock(townBlocks({ plans: [undated], history: [hist('A9', '2025-01-01')], today })).A9.plan, null);
});

test('the plan shows its most recent report, and the status date is that report', () => {
  const sources = [
    { title: '옛 기사', url: 'https://example.com/old', date: '2025-11-23' },
    { title: '새 기사', url: 'https://example.com/new', date: '2026-03-08', outlet: '하남일보' },
    { title: '날짜 없음', url: 'https://example.com/none' },
  ];
  const [row] = townBlocks({ plans: [plan(['A11'], '2026-하반기', { sources, households: 511 })], today });
  assert.deepEqual([row.status, row.statusDate, row.households], ['다음 예정(보도)', '2026-03-08', 511]);
  assert.equal(row.plan.source.url, 'https://example.com/new');
  // 출처는 중복 없이 모두
  assert.deepEqual(row.sources.map((s) => s.url), sources.map((s) => s.url));
});

test('linked notices attach by complex name or block name, sale to sale rows and rental to rental rows', () => {
  const history = [
    hist('B-1', '2026-10-30', { title: '구리갈매역세권 신안인스빌 디센트', type: '민간분양' }),
    hist('A-1', '2026-10-27', { rental: true }),
  ];
  const rows = townBlocks({
    history,
    entries: [entry('A-2', { rental: true, status: '미정' })],
    notices: [
      notice('구리갈매역세권 신안인스빌 디센트', '2026-10-30', '2026-11-11'),
      notice('구리갈매역세권 A-2BL 민간임대', '2026-11-01', '2026-11-30', { typeLabel: '공공지원민간임대' }),
      // 맞는 줄이 없는 공고는 블록 줄에 붙지 않는다
      notice('구리갈매역세권 오피스텔', '2026-09-01', '2026-09-03', { typeLabel: '오피스텔' }),
    ],
    today,
  });
  const by = byBlock(rows);
  assert.deepEqual([by['B-1'].status, by['B-1'].statusDate], ['접수 중', '2026-11-11']);
  // 이력과 같은 날 공고는 경과에 두 번 넣지 않는다
  assert.deepEqual(by['B-1'].timeline, [{ stage: '본청약', date: '2026-10-30' }, { stage: '접수 중', date: '2026-11-11' }]);
  assert.deepEqual([by['A-2(임대)'].status, by['A-2(임대)'].statusDate], ['접수 중', '2026-11-30']);
  assert.equal(rows.length, 3);
  // 마감이 지난 임대 공고는 임대 공고
  const ended = byBlock(townBlocks({
    entries: [entry('A-2', { rental: true })],
    notices: [notice('갈매역세권 A-2BL', '2026-10-01', '2026-10-05', { typeLabel: '민간임대' })],
    today,
  }));
  assert.deepEqual([ended['A-2(임대)'].status, ended['A-2(임대)'].statusDate], ['임대 공고', '2026-10-01']);
  // 민간사전청약 공고는 경과에 사전청약으로만
  const pre = byBlock(townBlocks({
    entries: [entry('A3')],
    notices: [notice('교산 A3 민간사전청약', '2026-01-01', '2026-01-05', { typeLabel: '민간사전청약' })],
    today,
  }));
  assert.deepEqual([pre.A3.status, pre.A3.timeline], ['미정', [{ stage: '사전청약', date: '2026-01-01' }]]);
});

test('noticeRowKey and nameHasBlock', () => {
  const rows = [
    { key: 'A2|sale', rental: false, names: ['A2'], history: [] },
    { key: 'A20|sale', rental: false, names: ['A20'], history: [] },
  ];
  assert.equal(noticeRowKey({ name: '교산 푸르지오(하남교산 A-2BL)' }, rows), 'A2|sale');
  assert.equal(noticeRowKey({ name: '하남교산 A20블록' }, rows), 'A20|sale');
  assert.equal(noticeRowKey({ name: '하남교산 A2-1' }, rows), null);
  assert.equal(noticeRowKey({ name: '하남교산 A-2BL', typeLabel: '민간임대' }, rows), null);
  assert.equal(nameHasBlock('하남교산 A-2BL', 'A2'), true);
  assert.equal(nameHasBlock('하남교산 BA2', 'A2'), false);
});

test('compareBlocks sorts by status, then natural block name, then sale first', () => {
  const rows = [
    { block: 'S10', status: '사업승인', rental: false },
    { block: 'A1', status: '분양 끝남', rental: true },
    { block: 'S9', status: '사업승인', rental: false },
    { block: 'A1', status: '분양 끝남', rental: false },
  ].sort(compareBlocks);
  assert.deepEqual(rows.map((r) => `${r.block}${r.rental ? 'R' : ''}`), ['A1', 'A1R', 'S9', 'S10']);
});

test('publicBlockTotal keeps only http(s) sources and names the outlet', () => {
  assert.equal(publicBlockTotal(null), null);
  assert.deepEqual(publicBlockTotal({
    total: 39, approved: 16, date: '2025-11-24',
    sources: [{ title: '기사 (시티뉴스)', url: 'http://www.ctnews.co.kr/39834', date: '2025-11-24' }, { title: 'x', url: 'javascript:1' }],
  }), {
    total: 39, approved: 16, date: '2025-11-24', outlet: '시티뉴스',
    sources: [{ title: '기사 (시티뉴스)', url: 'http://www.ctnews.co.kr/39834', date: '2025-11-24' }],
  });
});
