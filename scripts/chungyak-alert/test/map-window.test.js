import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addMonths, applyWindow, bucketOf, expectedWindow, monthsBetween, toMonth } from '../src/pipeline/expected-window.js';

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

test('a window that ended before this month is overdue, one ending this month is not', () => {
  const old = win('재개발', '착공', { 착공: '2020-01-15' });
  assert.equal(old.status, 'overdue');
  assert.deepEqual([old.from, old.to], ['2020-01', '2021-01']);
  assert.equal(old.basis, '착공(2020-01) 뒤 0~1년, 일반분양은 착공 전후가 많음. 예상 시기가 지났습니다(지연 가능성)');
  assert.equal(win('재개발', '착공', { 착공: '2025-11-30' }).status, 'estimated');
  assert.equal(win('재개발', '착공', { 착공: '2025-10-01' }).status, 'overdue');
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
  assert.match(blocks.basis, /남은 블록 순차 공고\(확장 규칙\)/);
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
});

test('live wins over every other bucket', () => {
  assert.equal(bucketOf({ live: true, window: { from: '2020-01', to: '2021-01' }, windowStatus: 'overdue' }, today), 'live');
  assert.equal(bucketOf({ live: true, window: null, windowStatus: 'far' }, today), 'live');
  assert.equal(bucketOf({ live: true, window: null, windowStatus: 'done' }, today), 'live');
});
