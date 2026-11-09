import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addMonths, applyWindow, blockKey, bucketOf, expectedWindow, monthsBetween, planRange, sourceOutlet, toMonth, townPlanWindow,
} from '../src/pipeline/expected-window.js';

const today = '2026-11-10';
const win = (kind, stage, stageDates = {}, expected = null) => expectedWindow({ kind, stage, stageDates, today, expected });

test('month helpers', () => {
  assert.equal(toMonth('2026-05-31'), '2026-05');
  assert.equal(toMonth('2026-13'), null);
  assert.equal(addMonths('2026-05', 18), '2027-11');
  assert.equal(addMonths('2026-11-10', -11), '2025-12');
  assert.equal(monthsBetween('2026-11-10', '2027-11'), 12);
  assert.equal(monthsBetween('2026-11', '2026-01-31'), -10);
  assert.equal(monthsBetween('2026-11', '2026-11-30'), 0);
  assert.equal(monthsBetween('bad', '2026-11'), null);
});

test('재개발·재건축 window rules from the current stage date', () => {
  assert.deepEqual(win('재개발', '사업시행인가', { 사업시행인가: '2026-03-06' }), {
    from: '2029-03', to: '2031-03', basis: '사업시행인가(2026-03) 뒤 3~5년', rule: '재개발:사업시행인가', status: 'estimated',
  });
  assert.deepEqual(win('재건축', '관리처분인가', { 관리처분인가: '2026-05-20' }), {
    from: '2027-11', to: '2029-05', basis: '관리처분인가(2026-05) 뒤 1.5~3년', rule: '재건축:관리처분인가', status: 'estimated',
  });
  const move = win('재개발', '이주', { 이주: '2026-01-02' });
  assert.deepEqual([move.from, move.to, move.basis], ['2026-07', '2028-01', '이주(2026-01) 뒤 0.5~2년']);
  const build = win('재개발', '착공', { 착공: '2026-04-09' });
  assert.deepEqual([build.from, build.to, build.status], ['2026-04', '2027-04', 'estimated']);
  assert.equal(build.basis, '착공(2026-04) 뒤 0~1년, 일반분양은 착공 전후가 많음');
});

test('stages before 사업시행인가 have no window and are far', () => {
  for (const stage of ['구역지정', '추진위', '조합설립', '건축심의']) {
    assert.deepEqual(win('재건축', stage, { [stage]: '2026-01-01' }), {
      from: null, to: null, basis: '사업시행인가 전이라 36개월 밖으로 예상', rule: `재건축:${stage}`, status: 'far',
    });
  }
});

test('a missing stage date uses today and says so', () => {
  const result = win('재개발', '관리처분인가', { 사업시행인가: '2020-01-01' });
  assert.deepEqual([result.from, result.to, result.status], ['2028-05', '2029-11', 'estimated']);
  assert.equal(result.basis, '관리처분인가(날짜 없음, 오늘 기준) 뒤 1.5~3년');
});

test('a passed window at 착공·이주·일반분양 is likely_sold, one ending this month is not', () => {
  const old = win('재개발', '착공', { 착공: '2020-01-15' });
  assert.equal(old.status, 'likely_sold');
  assert.deepEqual([old.from, old.to], ['2020-01', '2021-01']);
  assert.equal(old.basis, '착공(2020-01) 뒤 0~1년, 일반분양은 착공 전후가 많음. 예상 시기가 지났습니다. 이미 분양했을 가능성이 큽니다(공고 미확인)');
  assert.equal(win('재개발', '착공', { 착공: '2025-11-30' }).status, 'estimated');
  assert.equal(win('재개발', '착공', { 착공: '2025-10-01' }).status, 'likely_sold');
  const moved = win('재건축', '이주', { 이주: '2024-01-01' });
  assert.equal(moved.status, 'likely_sold');
  assert.equal(moved.basis, '이주(2024-01) 뒤 0.5~2년. 예상 시기가 지났습니다. 이미 분양했을 가능성이 큽니다(공고 미확인)');
  assert.equal(win('재개발', '일반분양', { 일반분양: '2024-01-01' }).status, 'likely_sold');
});

test('a passed window before 이주 is overdue (지연 가능성)', () => {
  const disposal = win('재개발', '관리처분인가', { 관리처분인가: '2020-01-01' });
  assert.equal(disposal.status, 'overdue');
  assert.equal(disposal.basis, '관리처분인가(2020-01) 뒤 1.5~3년. 예상 시기가 지났습니다(지연 가능성)');
  assert.equal(win('재건축', '사업시행인가', { 사업시행인가: '2015-01-01' }).status, 'overdue');
  assert.equal(win('공공주택지구', '부지조성 착공', { '부지조성 착공': '2020-01' }).status, 'overdue');
});

test('공공주택지구 window rules', () => {
  const designated = win('공공주택지구', '지구지정', { 지구지정: '2025-12-31' });
  assert.deepEqual([designated.from, designated.to, designated.basis], ['2028-12', '2030-12', '지구지정(2025-12) 뒤 3~5년']);
  assert.equal(win('공공주택지구', '지구지정', { 지구지정: '2019-10' }).status, 'overdue');
  const approved = win('공공주택지구', '지구계획승인', { 지구계획승인: '2025-06' });
  assert.deepEqual([approved.from, approved.to], ['2026-12', '2028-06']);
  const site = win('공공주택지구', '부지조성 착공', { '부지조성 착공': '2026-01' });
  assert.deepEqual([site.from, site.to], ['2027-01', '2028-01']);
  assert.equal(site.basis, '부지조성 착공(2026-01) 뒤 1~2년, 블록별 순차 공고');
  const blocks = win('공공주택지구', '블록별 분양', { '블록별 분양': '2020-03' });
  assert.deepEqual([blocks.from, blocks.to, blocks.status], ['2026-11', '2028-11', 'estimated']);
  assert.equal(blocks.basis, '다음 블록 예상(규칙): 오늘부터 0~2년');
  assert.equal(win('공공주택지구', '후보지').status, 'far');
  assert.deepEqual(win('공공주택지구', '준공', { 준공: '2030-01' }), {
    from: null, to: null, basis: '준공되어 남은 분양 없음으로 봄', rule: '공공주택지구:준공', status: 'done',
  });
});

test('a reported plan overrides the rule', () => {
  const reported = win('공공주택지구', '지구지정', { 지구지정: '2019-10' }, { from: '2029-06', to: '2031-06', basis: '국토부 발표' });
  assert.deepEqual(reported, { from: '2029-06', to: '2031-06', basis: '알려진 계획: 국토부 발표', rule: 'reported', status: 'estimated' });
  const late = win('공공주택지구', '후보지', {}, { from: '2024-01', to: '2025-06' });
  assert.equal(late.status, 'overdue');
  assert.equal(late.basis, '알려진 계획. 예상 시기가 지났습니다(지연 가능성)');
});

test('unknown kind or stage has no window', () => {
  assert.equal(win('재개발', '일반분양 완료').status, 'unknown');
  assert.equal(win(null, '착공').status, 'unknown');
});

test('applyWindow attaches window fields', () => {
  const project = applyWindow({ kind: '재개발', stage: '착공', stageDates: { 착공: '2026-04-09' } }, today);
  assert.deepEqual(project.window, { from: '2026-04', to: '2027-04' });
  assert.equal(project.windowStatus, 'estimated');
  assert.equal(project.windowRule, '재개발:착공');
  const far = applyWindow({ kind: '재개발', stage: '추진위', stageDates: {} }, today);
  assert.equal(far.window, null);
  assert.equal(far.windowStatus, 'far');
});

test('bucket boundaries at 12 and 36 months', () => {
  const at = (from, extra = {}) => bucketOf({ window: { from, to: '2035-01' }, windowStatus: 'estimated', ...extra }, today);
  assert.equal(at('2026-07'), 'soon');
  assert.equal(at('2026-11'), 'soon');
  assert.equal(at('2027-10'), 'soon');
  assert.equal(at('2027-11'), 'mid');
  assert.equal(at('2029-10'), 'mid');
  assert.equal(at('2029-11'), 'far');
  assert.equal(bucketOf({ window: null, windowStatus: 'far' }, today), 'far');
  assert.equal(bucketOf({ window: null, windowStatus: 'unknown' }, today), 'far');
  assert.equal(bucketOf({ window: null, windowStatus: 'done' }, today), 'done');
  assert.equal(at('2020-01', { windowStatus: 'overdue' }), 'overdue');
  assert.equal(bucketOf({ window: { from: '2020-01', to: '2021-01' }, windowStatus: 'likely_sold' }, today), 'likely_sold');
  assert.equal(bucketOf({ window: null, windowStatus: 'announced' }, today), 'announced');
  assert.equal(bucketOf({ window: { from: '2027-01', to: '2028-01' }, windowStatus: 'announced' }, today), 'announced');
});

test('a window that passed after the build is split by stage', () => {
  const passed = (stage) => bucketOf({ stage, window: { from: '2025-01', to: '2026-10' }, windowStatus: 'estimated' }, today);
  assert.equal(passed('착공'), 'likely_sold');
  assert.equal(passed('이주'), 'likely_sold');
  assert.equal(passed('관리처분인가'), 'overdue');
  assert.equal(passed('지구계획승인'), 'overdue');
});

test('live wins over every other bucket', () => {
  assert.equal(bucketOf({ live: true, window: { from: '2020-01', to: '2021-01' }, windowStatus: 'overdue' }, today), 'live');
  assert.equal(bucketOf({ live: true, window: null, windowStatus: 'far' }, today), 'live');
  assert.equal(bucketOf({ live: true, window: null, windowStatus: 'done' }, today), 'live');
});

test('planRange: half years and single months', () => {
  assert.deepEqual(planRange('2026-상반기'), { from: '2026-01', to: '2026-06' });
  assert.deepEqual(planRange('2026-하반기'), { from: '2026-07', to: '2026-12' });
  assert.deepEqual(planRange('2027-09'), { from: '2027-09', to: '2027-09' });
  for (const bad of ['2027-13', '2027-00', '2027', '2027-3분기', '2027-09-01', '', null]) assert.equal(planRange(bad), null, String(bad));
});

test('blockKey and sourceOutlet', () => {
  assert.equal(blockKey('A-1'), 'A1');
  assert.equal(blockKey('a1BL'), 'A1');
  assert.equal(blockKey('A-2 블록'), 'A2');
  assert.equal(sourceOutlet({ outlet: '청약홈', title: '분양정보 (번호 1)' }), '청약홈');
  assert.equal(sourceOutlet({ title: '기사 제목 (하남Times)' }), '하남Times');
  assert.equal(sourceOutlet({ title: '괄호 없음', url: 'https://www.huic.co.kr/a' }), 'huic.co.kr');
  assert.equal(sourceOutlet({}), '출처');
});

const src = (date, title = '기사 (하남Times)') => [{ title, url: 'https://example.com', date }];
const plan = (blocks, expected, extra = {}) => ({ blocks, expected, sources: src('2025-12-13'), ...extra });
const PLANS = [
  plan(['D2', 'D5'], '2026-상반기'),
  plan(['A9', 'A11'], '2026-하반기'),
  plan(['A20'], '2026-하반기', { rental: true }),
  plan(['A5'], '2027-09', { sources: [{ title: '일정표', outlet: '하남도시공사', url: 'https://example.com', date: null }] }),
];

test('블록별 분양: the earliest unfinished non-rental plan is the next block', () => {
  const result = win('공공주택지구', '블록별 분양', {}, null);
  assert.equal(result.rule, '공공주택지구:블록별 분양'); // 계획이 없으면 확장 규칙
  const planned = expectedWindow({ kind: '공공주택지구', stage: '블록별 분양', today, plans: PLANS });
  assert.deepEqual(planned, {
    from: '2026-07', to: '2026-12', basis: '보도된 다음 블록 계획: A9·A11 2026-하반기 (하남Times 2025-12-13)', rule: 'town-plan', status: 'estimated',
  });
  // 같은 기간의 분양 계획은 블록을 합친다(임대 A20은 빠짐)
  const merged = townPlanWindow({ plans: [...PLANS, plan(['B3'], '2026-하반기')], today });
  assert.match(merged.basis, /A9·A11·B3 2026-하반기/);
  // 2027년이 되면 A5(2027-09), 날짜 없는 출처는 '날짜 없음'
  const next = townPlanWindow({ plans: PLANS, today: '2027-01-05' });
  assert.deepEqual([next.from, next.to, next.basis], ['2027-09', '2027-09', '보도된 다음 블록 계획: A5 2027-09 (하남도시공사 날짜 없음)']);
});

test('블록별 분양: plans that all passed without a notice give today ~ +12 months', () => {
  const late = expectedWindow({ kind: '공공주택지구', stage: '블록별 분양', today: '2027-10-01', plans: PLANS });
  assert.deepEqual(late, {
    from: '2027-10', to: '2028-10', basis: '보도된 일정(2027-09)이 지났지만 공고는 아직 없습니다. 남은 블록 순차 공고', rule: 'town-plan-late', status: 'estimated',
  });
});

test('블록별 분양: blocks already in the history after the report are not pending', () => {
  const history = [
    { block: 'A-9', noticeDate: '2026-09-30', rental: false },
    { block: 'A11', noticeDate: '2026-10', rental: false },
    { block: 'A5', noticeDate: '2023-09-25', rental: false }, // 보도 전 공고는 계획을 채우지 않음
    { block: 'D2', noticeDate: '2026-02-01', rental: true }, // 임대 공고는 분양 계획을 채우지 않음
  ];
  const result = townPlanWindow({ plans: PLANS, history, today });
  assert.equal(result.basis, '보도된 다음 블록 계획: A5 2027-09 (하남도시공사 날짜 없음)');
  // 남은 블록만 근거에 적는다
  const partial = townPlanWindow({ plans: PLANS, history: history.slice(0, 1), today });
  assert.match(partial.basis, /계획: A11 2026-하반기/);
  // 모든 분양 계획이 공고로 채워졌으면 확장 규칙
  const done = expectedWindow({
    kind: '공공주택지구', stage: '블록별 분양', today, plans: [plan(['A9'], '2026-하반기')], history: history.slice(0, 1),
  });
  assert.equal(done.rule, '공공주택지구:블록별 분양');
  assert.equal(done.basis, '다음 블록 예상(규칙): 오늘부터 0~2년');
});

test('블록별 분양: rental-only plans fall back to the rule, other stages ignore plans', () => {
  const rental = expectedWindow({ kind: '공공주택지구', stage: '블록별 분양', today, plans: [plan(['B2'], '2029-하반기', { rental: true })] });
  assert.deepEqual([rental.from, rental.to, rental.rule], ['2026-11', '2028-11', '공공주택지구:블록별 분양']);
  const site = expectedWindow({ kind: '공공주택지구', stage: '부지조성 착공', stageDates: { '부지조성 착공': '2026-01' }, today, plans: PLANS });
  assert.equal(site.rule, '공공주택지구:부지조성 착공');
  // 보도된 지구 계획(expected)은 블록 계획보다 먼저
  const reported = expectedWindow({ kind: '공공주택지구', stage: '블록별 분양', today, plans: PLANS, expected: { from: '2027-01', to: '2027-06' } });
  assert.equal(reported.rule, 'reported');
});

test('applyWindow labels 블록별 분양 towns as the next block', () => {
  const town = applyWindow({ kind: '공공주택지구', stage: '블록별 분양', stageDates: {}, plans: PLANS, history: [] }, today);
  assert.equal(town.windowLabel, '다음 블록 예상');
  assert.deepEqual(town.window, { from: '2026-07', to: '2026-12' });
  assert.equal(town.windowRule, 'town-plan');
  assert.equal(bucketOf(town, today), 'soon');
  const other = applyWindow({ kind: '공공주택지구', stage: '지구지정', stageDates: { 지구지정: '2025-12' } }, today);
  assert.equal(other.windowLabel, null);
  const seoul = applyWindow({ kind: '재개발', stage: '착공', stageDates: { 착공: '2026-04-09' } }, today);
  assert.equal(seoul.windowLabel, null);
});

test('블록별 분양: a 사전청약 entry never announces a planned block', () => {
  const plans = [plan(['A5'], '2027-09')];
  const pre = [{ block: 'A5', stage: '사전청약', noticeDate: '2026-01-10', rental: false }];
  assert.equal(townPlanWindow({ plans, history: pre, today }).rule, 'town-plan');
  const main = [{ block: 'A-5', stage: '본청약', noticeDate: '2026-01-10', rental: false }];
  assert.equal(townPlanWindow({ plans, history: main, today }), null);
});

test('블록별 분양: the plan report month is the earliest source date', () => {
  const sources = [{ title: '새 기사 (하남일보)', url: 'https://example.com/n', date: '2026-03-08' }, { title: '첫 기사', url: 'https://example.com/o', date: '2025-11-23' }];
  const plans = [{ blocks: ['A9'], expected: '2026-하반기', sources }];
  // 2025-12 공고는 첫 보도(2025-11) 뒤라 계획을 채운다
  assert.equal(townPlanWindow({ plans, history: [{ block: 'A9', noticeDate: '2025-12-01' }], today }), null);
  // 근거는 첫 번째 출처를 적는다
  assert.equal(townPlanWindow({ plans, today }).basis, '보도된 다음 블록 계획: A9 2026-하반기 (하남일보 2026-03-08)');
});
