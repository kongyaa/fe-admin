// 정적 사이트(site/app.js)의 순수 함수 검사. DOM 없이 import 되어야 한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const app = await import('../site/app.js');
const {
  bucketOf, compareProjects, ganttBars, idFromHash, kstYmd, matchesFilters, monthsBetween, safeHttpUrl,
  shortDistrict, sortProjects, spanOf, tileClass, tileStats, whenMatches, windowLabel, windowRange,
} = app;

const today = '2026-11';
const win = (from, to = from) => ({ window: { from, to }, windowStatus: 'estimated' });
const ALL = { area: 'all', kind: 'all', stage: '', when: 'all', district: null, q: '' };

test('importing app.js in node has no side effects', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof app.bucketOf, 'function');
  assert.equal(app.PAGE_SIZE, 50);
});

test('kstYmd uses Korea time', () => {
  assert.equal(kstYmd(new Date('2026-11-30T14:59:00Z')), '2026-11-30');
  assert.equal(kstYmd(new Date('2026-11-30T15:00:00Z')), '2026-12-01');
  assert.equal(monthsBetween('2026-11', '2027-11-01'), 12);
});

test('bucketOf: live, done, overdue, far win over the window', () => {
  assert.equal(bucketOf({ ...win('2030-01'), live: true }, today), 'live');
  assert.equal(bucketOf({ live: true, windowStatus: 'far', window: { from: null, to: null } }, today), 'live');
  assert.equal(bucketOf({ windowStatus: 'done', window: { from: null, to: null } }, today), 'done');
  assert.equal(bucketOf({ windowStatus: 'overdue', window: { from: '2023-02', to: '2024-02' } }, today), 'overdue');
  assert.equal(bucketOf({ windowStatus: 'far', window: { from: null, to: null } }, today), 'far');
  assert.equal(bucketOf({}, today), 'far');
  // 상태가 없어도 범위 전체가 지났으면 예상 지남
  assert.equal(bucketOf(win('2024-01', '2025-01'), today), 'overdue');
});

test('bucketOf: 12- and 36-month boundaries from the current month', () => {
  assert.equal(bucketOf(win('2026-04', '2027-04'), today), 'soon'); // 이미 시작된 범위
  assert.equal(bucketOf(win('2026-11'), today), 'soon');
  assert.equal(bucketOf(win('2027-10'), today), 'soon'); // 11개월
  assert.equal(bucketOf(win('2027-11'), today), 'mid'); // 12개월
  assert.equal(bucketOf(win('2029-10'), today), 'mid'); // 35개월
  assert.equal(bucketOf(win('2029-11'), today), 'far'); // 36개월
});

test('whenMatches and windowLabel', () => {
  assert.equal(whenMatches('live', '12'), true);
  assert.equal(whenMatches('mid', '12'), false);
  assert.equal(whenMatches('mid', '36'), true);
  assert.equal(whenMatches('overdue', '36'), false);
  assert.equal(whenMatches('overdue', 'all'), true);
  assert.equal(windowLabel(win('2027-01', '2028-01'), today), '2027-01~2028-01');
  assert.equal(windowLabel({ windowStatus: 'far', window: { from: null, to: null } }, today), '3년 뒤·미정');
  assert.equal(windowLabel({ windowStatus: 'overdue', window: { from: '2023-02', to: '2024-02' } }, today), '2023-02~2024-02 (지남)');
  assert.equal(windowLabel({ windowStatus: 'done', window: { from: null, to: null } }, today), '준공');
});

test('matchesFilters: region, kind, stage, district', () => {
  const seoul = { region: '서울', district: '종로구', kind: '재개발', stage: '이주', name: '신영1', address: '신영동158-2', ...win('2027-01') };
  const town = { region: '경기', district: '하남시', kind: '공공주택지구', stage: '지구지정', name: '하남교산', address: null, ...win('2029-01') };
  assert.equal(matchesFilters(seoul, ALL, today), true);
  assert.equal(matchesFilters(seoul, { ...ALL, area: '서울' }, today), true);
  assert.equal(matchesFilters(seoul, { ...ALL, area: '경기' }, today), false);
  assert.equal(matchesFilters(town, { ...ALL, area: '경기' }, today), true);
  assert.equal(matchesFilters(seoul, { ...ALL, kind: '재건축' }, today), false);
  assert.equal(matchesFilters(town, { ...ALL, kind: '공공주택지구' }, today), true);
  assert.equal(matchesFilters(seoul, { ...ALL, stage: 'seoul:이주' }, today), true);
  assert.equal(matchesFilters(seoul, { ...ALL, stage: 'seoul:착공' }, today), false);
  // 같은 이름의 단계라도 묶음(서울/신도시)이 다르면 맞지 않음
  assert.equal(matchesFilters(town, { ...ALL, stage: 'seoul:지구지정' }, today), false);
  assert.equal(matchesFilters(town, { ...ALL, stage: 'town:지구지정' }, today), true);
  assert.equal(matchesFilters(seoul, { ...ALL, district: '종로구' }, today), true);
  assert.equal(matchesFilters(seoul, { ...ALL, district: '중구' }, today), false);
});

test('matchesFilters: when filter keeps live, drops overdue and far', () => {
  const soon = win('2027-01');
  const mid = win('2028-06');
  const live = { ...win('2030-01'), live: true };
  const overdue = { windowStatus: 'overdue', window: { from: '2023-02', to: '2024-02' } };
  const far = { windowStatus: 'far', window: { from: null, to: null } };
  const pick = (when) => [soon, mid, live, overdue, far].map((p) => matchesFilters(p, { ...ALL, when }, today));
  assert.deepEqual(pick('12'), [true, false, true, false, false]);
  assert.deepEqual(pick('36'), [true, true, true, false, false]);
  assert.deepEqual(pick('all'), [true, true, true, true, true]);
});

test('matchesFilters: search ignores spaces and case, covers name and addresses', () => {
  const p = { name: '반포미도2차', address: '반포동 60-4', roadAddress: '신반포로 270', ...win('2027-01') };
  assert.equal(matchesFilters(p, { ...ALL, q: '반포 미도' }, today), true);
  assert.equal(matchesFilters(p, { ...ALL, q: '반포동60' }, today), true);
  assert.equal(matchesFilters(p, { ...ALL, q: '신반포로 270' }, today), true);
  assert.equal(matchesFilters({ name: 'ABC구역', ...win('2027-01') }, { ...ALL, q: 'abc' }, today), true);
  assert.equal(matchesFilters(p, { ...ALL, q: '잠실' }, today), false);
});

test('sortProjects: live, soon, mid, far, overdue, done; then window start; then name', () => {
  const list = [
    { id: 'done', name: '가', windowStatus: 'done', window: { from: null, to: null } },
    { id: 'overdue', name: '가', windowStatus: 'overdue', window: { from: '2022-01', to: '2023-01' } },
    { id: 'far-null', name: '가', windowStatus: 'far', window: { from: null, to: null } },
    { id: 'far-2030', name: '하', ...win('2030-01') },
    { id: 'mid', name: '가', ...win('2028-01') },
    { id: 'soon-b', name: '나', ...win('2027-03') },
    { id: 'soon-a', name: '가', ...win('2027-03') },
    { id: 'soon-early', name: '하', ...win('2026-05', '2027-05') },
    { id: 'live', name: '하', ...win('2029-01'), live: true },
  ];
  assert.deepEqual(sortProjects(list, today).map((p) => p.id),
    ['live', 'soon-early', 'soon-a', 'soon-b', 'mid', 'far-2030', 'far-null', 'overdue', 'done']);
  assert.equal(compareProjects(list[5], list[6], today) > 0, true);
  // 원래 배열은 그대로
  assert.equal(list[0].id, 'done');
});

test('safeHttpUrl allows only absolute http(s)', () => {
  assert.equal(safeHttpUrl('https://data.seoul.go.kr/x?a=1'), 'https://data.seoul.go.kr/x?a=1');
  assert.equal(safeHttpUrl(' http://example.com '), 'http://example.com/');
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpUrl('JaVaScRiPt:alert(1)'), null);
  assert.equal(safeHttpUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(safeHttpUrl('/relative/path'), null);
  assert.equal(safeHttpUrl('projects.json'), null);
  assert.equal(safeHttpUrl('//evil.example'), null);
  assert.equal(safeHttpUrl(null), null);
});

test('windowRange and ganttBars clip to the 36-month range', () => {
  assert.equal(windowRange(win('2027-01', '2028-01')), '2027-01~2028-01');
  assert.equal(windowRange(win('2027-01', '2027-01')), '2027-01');
  assert.equal(windowRange({ window: { from: null, to: null } }), null);

  assert.deepEqual(ganttBars(win('2026-04', '2027-04'), today), [{ kind: 'est', start: 0, end: 6, cutStart: true, cutEnd: false }]);
  assert.deepEqual(ganttBars(win('2029-06', '2031-06'), today), [{ kind: 'est', start: 31, end: 36, cutStart: false, cutEnd: true }]);
  assert.deepEqual(ganttBars(win('2027-01', '2027-12'), today), [{ kind: 'est', start: 2, end: 14, cutStart: false, cutEnd: false }]);
  assert.deepEqual(ganttBars(win('2023-01', '2024-01'), today), []); // 다 지난 범위
  assert.deepEqual(ganttBars(win('2029-11', '2031-01'), today), []); // 36개월 뒤 시작
  assert.deepEqual(ganttBars({ window: { from: null, to: null } }, today), []);
  assert.equal(spanOf('2029-10', '2029-10', today).end, 36);
  assert.equal(spanOf('2029-11', '2029-11', today), null);

  // 공고 나옴: 예상 범위(빗금)와 공고 기간(초록)을 함께
  const live = { ...win('2026-11', '2028-11'), live: true, notices: [{ announceDate: '2026-11-05', end: '2026-11-25' }] };
  assert.deepEqual(ganttBars(live, today).map((b) => [b.kind, b.start, b.end]), [['est', 0, 25], ['live', 0, 1]]);
  // 예상 범위 없이 공고만 있어도 그린다
  const onlyNotice = { window: { from: null, to: null }, live: true, notices: [{ announceDate: '2026-12-01', end: '2027-01-10' }] };
  assert.deepEqual(ganttBars(onlyNotice, today).map((b) => [b.kind, b.start, b.end]), [['live', 1, 3]]);
});

test('idFromHash reads #p=<id> only', () => {
  assert.equal(idFromHash('#p=seoul-1441'), 'seoul-1441');
  assert.equal(idFromHash('#p=town-hanam-gyosan'), 'town-hanam-gyosan');
  assert.equal(idFromHash('#p=%EC%98%88%EC%8B%9C'), '예시');
  assert.equal(idFromHash('#p=%E0'), null); // 깨진 인코딩
  assert.equal(idFromHash('#sources'), null);
  assert.equal(idFromHash('#p='), null);
  assert.equal(idFromHash(''), null);
});

test('tile map: per-구 counts and 3-step colour', () => {
  const p = (district, bucket, region = '서울') => ({ district, region, bucket });
  const stats = tileStats([
    p('종로구', 'soon'), p('종로구', 'live'), p('종로구', 'soon'), p('종로구', 'mid'),
    p('중구', 'soon'), p('중구', 'far'),
    p('용산구', 'mid'), p('용산구', 'overdue'),
    p('도봉구', 'far'),
    p('하남시', 'soon', '경기'),
  ], (x) => x.bucket);
  assert.deepEqual(stats.get('종로구'), { n: 4, soon: 3, mid: 1 });
  assert.equal(stats.has('하남시'), false);
  assert.equal(tileClass(stats.get('종로구')), 'hot');
  assert.equal(tileClass(stats.get('중구')), 'has');
  assert.equal(tileClass({ n: 2, soon: 2, mid: 0 }), 'has');
  assert.equal(tileClass(stats.get('용산구')), 'has');
  assert.equal(tileClass(stats.get('도봉구')), '');
  assert.equal(tileClass(undefined), '');
  assert.equal(shortDistrict('종로구'), '종로');
  assert.equal(shortDistrict('중구'), '중구');
  assert.equal(shortDistrict('하남시'), '하남');
});
