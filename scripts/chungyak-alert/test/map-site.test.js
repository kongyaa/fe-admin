// 정적 사이트(site/app.js)의 순수 함수 검사. DOM 없이 import 되어야 한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const app = await import('../site/app.js');
const pipeline = await import('../src/pipeline/expected-window.js');
const {
  BUCKET_ORDER, BUCKET_INFO, bucketOf, compareProjects, dataFile, ganttBars, idFromHash, kstYmd, latestAnnounce, matchesFilters,
  monthsBetween, safeHttpUrl, shortDistrict, sortProjects, spanOf, tileClass, tileStats, whenMatches, windowLabel, windowRange,
  THEME_KEY, THEME_CHOICES, normalizeTheme, colorSchemeFor, readTheme, writeTheme, applyTheme, isThemeStorageKey,
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

test('bucketOf: likely_sold and announced', () => {
  assert.equal(bucketOf({ stage: '착공', windowStatus: 'likely_sold', window: { from: '2023-02', to: '2024-02' } }, today), 'likely_sold');
  assert.equal(bucketOf({ windowStatus: 'announced', window: { from: '2027-01', to: '2028-01' } }, today), 'announced');
  assert.equal(bucketOf({ windowStatus: 'announced', window: null, live: true }, today), 'live');
  // 상태가 estimated인데 범위가 다 지났으면 단계로 가른다
  assert.equal(bucketOf({ ...win('2024-01', '2025-01'), stage: '착공' }, today), 'likely_sold');
  assert.equal(bucketOf({ ...win('2024-01', '2025-01'), stage: '이주' }, today), 'likely_sold');
  assert.equal(bucketOf({ ...win('2024-01', '2025-01'), stage: '관리처분인가' }, today), 'overdue');
  assert.equal(BUCKET_INFO.likely_sold.label, '분양했을 가능성');
  assert.equal(BUCKET_INFO.announced.label, '공고 있었음');
});

test('likely_sold and announced: labels, filters, tile stats', () => {
  const sold = { stage: '착공', windowStatus: 'likely_sold', window: { from: '2023-02', to: '2024-02' } };
  const announced = {
    windowStatus: 'announced', window: null,
    notices: [{ announceDate: '2026-03-31' }, { announceDate: '2026-05-02' }, { announceDate: null }],
  };
  assert.equal(windowLabel(sold, today), '2023-02~2024-02 (지남, 분양했을 가능성)');
  assert.equal(windowLabel({ ...sold, window: null }, today), '분양했을 가능성');
  assert.equal(windowLabel(announced, today), '공고 있었음(2026-05)');
  assert.equal(windowLabel({ ...announced, notices: [] }, today), '공고 있었음');
  assert.equal(latestAnnounce(announced), '2026-05');
  for (const bucket of ['likely_sold', 'announced']) {
    assert.equal(whenMatches(bucket, '12'), false);
    assert.equal(whenMatches(bucket, '36'), false);
    assert.equal(whenMatches(bucket, 'all'), true);
  }
  assert.equal(matchesFilters(sold, { ...ALL, when: '36' }, today), false);
  assert.equal(matchesFilters(announced, { ...ALL, when: '12' }, today), false);
  const stats = tileStats([
    { region: '서울', district: '종로구', b: 'likely_sold' },
    { region: '서울', district: '종로구', b: 'announced' },
    { region: '서울', district: '종로구', b: 'soon' },
  ], (p) => p.b);
  assert.deepEqual(stats.get('종로구'), { n: 3, soon: 1, mid: 0 });
});

test('sort order puts announced after far, likely_sold after overdue', () => {
  assert.deepEqual(BUCKET_ORDER, ['live', 'soon', 'mid', 'far', 'announced', 'overdue', 'likely_sold', 'done']);
  const list = [
    { id: 'done', name: '가', windowStatus: 'done', window: null },
    { id: 'sold', name: '가', stage: '착공', windowStatus: 'likely_sold', window: { from: '2022-01', to: '2023-01' } },
    { id: 'overdue', name: '가', windowStatus: 'overdue', window: { from: '2022-01', to: '2023-01' } },
    { id: 'announced', name: '가', windowStatus: 'announced', window: null, notices: [{ announceDate: '2026-01-02' }] },
    { id: 'far', name: '가', windowStatus: 'far', window: null },
    { id: 'soon', name: '가', ...win('2027-01') },
  ];
  assert.deepEqual(sortProjects(list, today).map((p) => p.id), ['soon', 'far', 'announced', 'overdue', 'sold', 'done']);
});

test('?sample=1 loads the sample file', () => {
  assert.equal(dataFile('?sample=1'), 'sample-projects.json');
  assert.equal(dataFile('?x=2&sample=1'), 'sample-projects.json');
  assert.equal(dataFile(''), 'projects.json');
  assert.equal(dataFile('?sample=0'), 'projects.json');
  assert.equal(dataFile(undefined), 'projects.json');
});

test('sample-projects.json is valid and covers every bucket but done', () => {
  const sample = JSON.parse(readFileSync(new URL('../site/sample-projects.json', import.meta.url), 'utf8'));
  assert.equal(sample.sample, true);
  const buckets = new Set(sample.projects.map((p) => bucketOf(p, '2026-11')));
  for (const bucket of ['live', 'soon', 'mid', 'far', 'announced', 'overdue', 'likely_sold']) assert.ok(buckets.has(bucket), bucket);
  assert.equal(new Set(sample.projects.map((p) => p.id)).size, sample.projects.length);
});

// --- 화면 테마 ---------------------------------------------------------------

/** 가짜 localStorage. blocked 이면 모든 호출이 예외를 던진다(저장소 차단 흉내) */
function fakeStorage(initial = {}, { blocked = false } = {}) {
  const map = new Map(Object.entries(initial));
  const guard = () => {
    if (blocked) throw new Error('SecurityError');
  };
  return {
    map,
    getItem: (k) => (guard(), map.has(k) ? map.get(k) : null),
    setItem: (k, v) => (guard(), map.set(k, String(v)), undefined),
    removeItem: (k) => (guard(), map.delete(k), undefined),
  };
}

test('normalizeTheme: only exact light/dark are kept, anything else is system (same rule as theme-init.js)', () => {
  assert.deepEqual(THEME_CHOICES, ['system', 'light', 'dark']);
  assert.equal(normalizeTheme('light'), 'light');
  assert.equal(normalizeTheme('dark'), 'dark');
  for (const v of ['system', ' DARK ', 'Dark', 'light ', '', null, undefined, 'auto', 'blue', 1, {}]) {
    assert.equal(normalizeTheme(v), 'system', String(v));
  }
  // theme-init.js 도 같은 값만 고정한다
  assert.deepEqual(runThemeInit(fakeStorage({ [THEME_KEY]: ' DARK ' })), { theme: null, scheme: 'light dark' });
});

/** 가짜 DOM 요소: 속성만 흉내 낸다 */
function fakeEl(attrs = {}) {
  const map = new Map(Object.entries(attrs));
  return {
    map,
    getAttribute: (k) => (map.has(k) ? map.get(k) : null),
    setAttribute: (k, v) => map.set(k, String(v)),
    removeAttribute: (k) => map.delete(k),
  };
}

test('applyTheme: data-theme add/remove, color-scheme meta, aria-pressed sync', () => {
  const root = fakeEl();
  const meta = fakeEl({ content: 'light dark' });
  const buttons = THEME_CHOICES.map((choice) => fakeEl({ 'data-theme-choice': choice, 'aria-pressed': String(choice === 'system') }));
  const pressed = () => buttons.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-theme-choice'));

  assert.equal(applyTheme('dark', { root, meta, buttons }), 'dark');
  assert.equal(root.getAttribute('data-theme'), 'dark');
  assert.equal(meta.getAttribute('content'), 'dark');
  assert.deepEqual(pressed(), ['dark']);

  assert.equal(applyTheme('light', { root, meta, buttons }), 'light');
  assert.equal(root.getAttribute('data-theme'), 'light');
  assert.equal(meta.getAttribute('content'), 'light');
  assert.deepEqual(pressed(), ['light']);

  assert.equal(applyTheme('system', { root, meta, buttons }), 'system');
  assert.equal(root.map.has('data-theme'), false);
  assert.equal(meta.getAttribute('content'), 'light dark');
  assert.deepEqual(pressed(), ['system']);

  // 모르는 값은 시스템. 메타·버튼이 없어도 예외 없이 root 만 맞춘다
  root.setAttribute('data-theme', 'dark');
  assert.equal(applyTheme('blue', { root, meta: null }), 'system');
  assert.equal(root.map.has('data-theme'), false);
});

test('isThemeStorageKey: theme key or a full clear only', () => {
  assert.equal(isThemeStorageKey(THEME_KEY), true);
  assert.equal(isThemeStorageKey(null), true); // localStorage.clear()
  assert.equal(isThemeStorageKey('other-key'), false);
  assert.equal(isThemeStorageKey(undefined), false);
  assert.equal(isThemeStorageKey(''), false);
});

test('colorSchemeFor matches the color-scheme meta values', () => {
  assert.equal(colorSchemeFor('system'), 'light dark');
  assert.equal(colorSchemeFor('light'), 'light');
  assert.equal(colorSchemeFor('dark'), 'dark');
  assert.equal(colorSchemeFor('nonsense'), 'light dark');
});

test('readTheme / writeTheme: store light/dark, system removes the key, blocked storage never throws', () => {
  const s = fakeStorage();
  assert.equal(readTheme(s), 'system');
  assert.equal(writeTheme(s, 'dark'), true);
  assert.equal(s.map.get(THEME_KEY), 'dark');
  assert.equal(readTheme(s), 'dark');
  assert.equal(writeTheme(s, 'light'), true);
  assert.equal(readTheme(s), 'light');
  assert.equal(writeTheme(s, 'system'), true);
  assert.equal(s.map.has(THEME_KEY), false);
  assert.equal(readTheme(fakeStorage({ [THEME_KEY]: 'purple' })), 'system');
  const blocked = fakeStorage({ [THEME_KEY]: 'dark' }, { blocked: true });
  assert.equal(readTheme(blocked), 'system');
  assert.equal(writeTheme(blocked, 'dark'), false);
  assert.equal(readTheme(null), 'system');
  assert.equal(writeTheme(null, 'dark'), false);
});

/** theme-init.js 를 가짜 document·localStorage 위에서 실행하고 결과를 돌려준다 */
function runThemeInit(storage) {
  const attrs = new Map();
  const meta = { content: 'light dark', setAttribute: (k, v) => { if (k === 'content') meta.content = v; } };
  const document = {
    documentElement: { setAttribute: (k, v) => attrs.set(k, v) },
    querySelector: (sel) => (sel === 'meta[name="color-scheme"]' ? meta : null),
  };
  const window = {};
  Object.defineProperty(window, 'localStorage', {
    get() {
      if (storage === 'throw') throw new Error('SecurityError');
      return storage;
    },
  });
  vm.runInNewContext(readFileSync(new URL('../site/theme-init.js', import.meta.url), 'utf8'), { window, document });
  return { theme: attrs.get('data-theme') ?? null, scheme: meta.content };
}

test('theme-init.js applies a stored theme before paint and ignores bad or blocked storage', () => {
  assert.deepEqual(runThemeInit(fakeStorage({ [THEME_KEY]: 'dark' })), { theme: 'dark', scheme: 'dark' });
  assert.deepEqual(runThemeInit(fakeStorage({ [THEME_KEY]: 'light' })), { theme: 'light', scheme: 'light' });
  assert.deepEqual(runThemeInit(fakeStorage()), { theme: null, scheme: 'light dark' });
  assert.deepEqual(runThemeInit(fakeStorage({ [THEME_KEY]: 'system' })), { theme: null, scheme: 'light dark' });
  assert.deepEqual(runThemeInit(fakeStorage({ [THEME_KEY]: 'dark' }, { blocked: true })), { theme: null, scheme: 'light dark' });
  assert.deepEqual(runThemeInit('throw'), { theme: null, scheme: 'light dark' });
  // 키를 바꿀 때 두 파일을 같이 바꾸도록
  assert.ok(readFileSync(new URL('../site/theme-init.js', import.meta.url), 'utf8').includes(`'${THEME_KEY}'`));
});

test('index.html loads theme-init.js as a classic script before the stylesheet, with no inline script', () => {
  const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  const init = html.indexOf('<script src="theme-init.js"></script>');
  assert.ok(init > 0, 'theme-init.js script tag');
  assert.ok(init > html.indexOf('name="color-scheme"'), 'after the color-scheme meta (it updates it)');
  assert.ok(init < html.indexOf('href="style.css"'), 'before the stylesheet');
  assert.ok(init < html.indexOf('</head>'));
  assert.equal(/<script(?![^>]*\ssrc=)[^>]*>/.test(html), false, 'no inline <script>');
  assert.equal(/\sstyle=/.test(html), false, 'no inline style attribute');
  for (const choice of THEME_CHOICES) assert.ok(html.includes(`data-theme-choice="${choice}"`), choice);
  assert.ok(html.includes('aria-label="화면 테마"'));
});

// 파이프라인(만들 때 bucket 저장)과 사이트(볼 때 다시 계산)가 같은 구간을 내야 한다.
// 파이프라인 today는 'YYYY-MM-DD', 사이트는 'YYYY-MM'. 나머지 입력 모양은 같다.
test('pipeline bucketOf and site bucketOf agree', () => {
  const pipelineToday = '2026-11-10';
  const siteToday = pipelineToday.slice(0, 7);
  const est = (from, to, extra = {}) => ({ window: { from, to }, windowStatus: 'estimated', ...extra });
  const table = [
    [{ live: true, ...est('2030-01', '2031-01') }, 'live'],
    [{ live: true, window: null, windowStatus: 'done' }, 'live'],
    [{ live: true, window: null, windowStatus: 'announced' }, 'live'],
    [{ window: null, windowStatus: 'done' }, 'done'],
    [{ window: null, windowStatus: 'announced' }, 'announced'],
    [{ window: { from: '2027-01', to: '2028-01' }, windowStatus: 'announced' }, 'announced'],
    [{ stage: '착공', window: { from: '2023-02', to: '2024-02' }, windowStatus: 'likely_sold' }, 'likely_sold'],
    [{ stage: '관리처분인가', window: { from: '2020-01', to: '2021-06' }, windowStatus: 'overdue' }, 'overdue'],
    [{ window: null, windowStatus: 'far' }, 'far'],
    [{ window: null, windowStatus: 'unknown' }, 'far'],
    [{ window: null }, 'far'],
    [{}, 'far'],
    [est('2026-04', '2027-04'), 'soon'],
    [est('2026-11', '2026-11'), 'soon'],
    [est('2027-10', '2029-10'), 'soon'],
    [est('2027-11', '2029-11'), 'mid'],
    [est('2029-10', '2031-10'), 'mid'],
    [est('2029-11', '2031-11'), 'far'],
    [est('2025-01', '2026-10', { stage: '착공' }), 'likely_sold'],
    [est('2025-01', '2026-10', { stage: '이주' }), 'likely_sold'],
    [est('2025-01', '2026-10', { stage: '일반분양' }), 'likely_sold'],
    [est('2025-01', '2026-10', { stage: '관리처분인가' }), 'overdue'],
    [est('2025-01', '2026-10', { stage: '지구계획승인' }), 'overdue'],
    [est('2025-01', '2026-11', { stage: '착공' }), 'soon'],
  ];
  // 파이프라인이 실제로 만드는 값(applyWindow)도 표에 넣는다
  for (const [kind, stage, date] of [
    ['재개발', '착공', '2020-01-15'], ['재개발', '착공', '2026-04-09'], ['재건축', '이주', '2024-01-01'],
    ['재건축', '관리처분인가', '2020-01-01'], ['재개발', '사업시행인가', '2026-03-06'], ['재개발', '추진위', '2026-01-01'],
    ['공공주택지구', '지구지정', '2019-10'], ['공공주택지구', '블록별 분양', '2025-05'], ['공공주택지구', '준공', '2030-01'],
  ]) {
    table.push([pipeline.applyWindow({ kind, stage, stageDates: { [stage]: date } }, pipelineToday), null]);
  }
  for (const [project, expected] of table) {
    const fromPipeline = pipeline.bucketOf(project, pipelineToday);
    const fromSite = bucketOf(structuredClone(project), siteToday);
    assert.equal(fromSite, fromPipeline, JSON.stringify(project));
    if (expected) assert.equal(fromPipeline, expected, JSON.stringify(project));
  }
  assert.deepEqual(pipeline.BUCKETS, BUCKET_ORDER);
  assert.deepEqual(pipeline.LIKELY_SOLD_STAGES, app.LIKELY_SOLD_STAGES);
});

test('windowFactLabel and windowPrefix: 블록별 분양 towns say 다음 블록 예상', () => {
  assert.equal(app.windowFactLabel({ windowLabel: '다음 블록 예상' }), '다음 블록 예상');
  assert.equal(app.windowFactLabel({}), '예상 청약');
  assert.equal(app.windowFactLabel({ windowLabel: '  ' }), '예상 청약');
  assert.equal(app.windowFactLabel({ windowLabel: 3 }), '예상 청약');
  assert.equal(app.windowFactLabel(null), '예상 청약');
  assert.equal(app.windowPrefix({ windowLabel: '다음 블록 예상' }), '다음 블록 예상');
  assert.equal(app.windowPrefix({}), '예상');
});

test('blockKey matches the pipeline; nameHasBlock needs the whole block name', () => {
  for (const value of ['A-1', 'a1BL', 'A-2 블록', 'S2', 'B-1', 'A2-1', 'A-2-1BL', 'A21', '', null]) assert.equal(app.blockKey(value), pipeline.blockKey(value), String(value));
  assert.notEqual(app.blockKey('A2-1'), app.blockKey('A21'));
  assert.equal(app.nameHasBlock('하남교산 A-2-1BL', 'A2-1'), true);
  assert.equal(app.nameHasBlock('하남교산 A21블록', 'A2-1'), false);
  assert.equal(app.nameHasBlock('하남교산 A2-1BL', 'A2'), false);
  assert.equal(app.nameHasBlock('하남교산 A2-1BL', 'A21'), false);
  assert.equal(app.nameHasBlock('교산 푸르지오 더 퍼스트(하남교산 A-2BL)', 'A2'), true);
  assert.equal(app.nameHasBlock('하남교산 A2블록 공공분양', 'A-2'), true);
  assert.equal(app.nameHasBlock('하남교산 A20블록', 'A2'), false);
  assert.equal(app.nameHasBlock('하남교산 BA2', 'A2'), false);
  assert.equal(app.nameHasBlock('하남교산 A2', ''), false);
  assert.equal(app.nameHasBlock(null, 'A2'), false);
});

const A2 = {
  block: 'A2', stage: '본청약', type: '공공분양', title: '교산 푸르지오 더 퍼스트', households: 1115, noticeDate: '2025-03-31', rental: false,
  sources: [{ title: 'LH 공고 (LH청약플러스)', url: 'https://apply.lh.or.kr/a2', date: '2025-03-31' }, { title: '나쁜', url: 'javascript:alert(1)' }],
};
const PRE = { block: 'A2', stage: '사전청약', type: '공공분양', households: 1056, noticeDate: '2021-11-18', rental: false, sources: [] };
const RENT = { block: 'A20', stage: '본청약', type: '통합공공임대', households: 249, noticeDate: '2026-09-01', rental: true, sources: [] };
const notice = (name, announceDate, extra = {}) => ({ key: name, name, announceDate, end: null, url: 'https://www.applyhome.co.kr/n', typeLabel: 'APT', ...extra });

test('isSameSale: same notice date and the block or complex name in the notice name', () => {
  assert.equal(app.isSameSale(A2, notice('교산 푸르지오 더 퍼스트(하남교산 A-2BL)', '2025-03-31')), true);
  assert.equal(app.isSameSale(A2, notice('교산푸르지오더퍼스트', '2025-03-31')), true); // 단지 이름(공백 무시)
  assert.equal(app.isSameSale(A2, notice('하남교산 A2', '2025-04-01')), false); // 날짜가 다르면 다른 공고
  assert.equal(app.isSameSale(A2, notice('하남교산 A20', '2025-03-31')), false);
  assert.equal(app.isSameSale(A2, notice('하남 어딘가', '2025-03-31')), false); // 애매하면 따로 둔다
  assert.equal(app.isSameSale({ ...A2, noticeDate: '2025-03' }, notice('하남교산 A-2', '2025-03-31')), true); // 달까지만 있으면 같은 달
  assert.equal(app.isSameSale({ ...RENT, noticeDate: '2025-03-31' }, notice('하남교산 A20', '2025-03-31')), false); // 임대 이력은 맞추지 않음
  assert.equal(app.isSameSale(null, notice('x', '2025-03-31')), false);
});

test('saleHistory merges history and linked notices newest first without duplicates', () => {
  const project = {
    history: [PRE, A2, RENT, null, 'x'],
    notices: [
      notice('교산 푸르지오 더 퍼스트(하남교산 A-2BL)', '2025-03-31', { url: 'https://www.applyhome.co.kr/a2', end: '2025-05-09' }),
      notice('하남교산 D2 민간', '2026-11-02', { url: 'javascript:alert(1)', end: '2026-11-20', typeLabel: '민영' }),
    ],
  };
  const rows = app.saleHistory(project);
  assert.deepEqual(rows.map((r) => [r.date, r.block, r.from, r.rental]), [
    ['2026-11-02', null, 'notice', false], ['2026-09-01', 'A20', 'history', true], ['2025-03-31', 'A2', 'history', false], ['2021-11-18', 'A2', 'history', false],
  ]);
  const a2 = rows[2];
  // 같은 공고는 이력 줄에 청약홈 링크·마감일만 붙고, http(s)가 아닌 출처는 빠진다
  assert.deepEqual(a2.sources.map((s) => s.url), ['https://apply.lh.or.kr/a2', 'https://www.applyhome.co.kr/a2']);
  assert.equal(a2.sources[1].outlet, '청약홈');
  assert.equal(a2.end, '2025-05-09');
  assert.deepEqual([a2.title, a2.households, a2.type], ['교산 푸르지오 더 퍼스트', 1115, '공공분양']);
  // 이력에 없는 공고는 공고명이 제목, 안전하지 않은 주소면 링크 없음
  assert.deepEqual([rows[0].title, rows[0].type, rows[0].sources, rows[0].end], ['하남교산 D2 민간', '민영', [], '2026-11-20']);
  assert.deepEqual(app.saleHistory({}), []);
  assert.deepEqual(app.saleHistory({ history: 'nope', notices: 3 }), []);
  // 이어진 공고가 없어도 이력의 접수 마감(end)이 있으면 마감일로 쓴다(사이트가 오늘과 비교해 '접수 중' 표시)
  assert.equal(app.saleHistory({ history: [{ ...A2, end: '2025-04-30' }] })[0].end, '2025-04-30');
});

test('latestSale skips rentals and 사전청약, and counts linked notices', () => {
  assert.equal(app.latestSale({ history: [PRE, A2, RENT] }), '2025-03');
  assert.equal(app.latestSale({ history: [PRE] }), null);
  assert.equal(app.latestSale({ history: [RENT] }), null);
  assert.equal(app.latestSale({ history: [A2], notices: [notice('구리갈매역세권 신안인스빌 디센트', '2026-10-30')] }), '2026-10');
  assert.equal(app.latestSale({}), null);
});

test('linked rental and non-apartment notices show in the history but are not the latest sale', () => {
  const notices = [
    notice('갈매역세권 공공지원민간임대', '2026-10-20', { typeLabel: '공공지원민간임대' }),
    notice('갈매역세권 민간임대', '2026-10-21', { typeLabel: '민간임대' }),
    notice('갈매역세권 오피스텔', '2026-10-22', { typeLabel: '오피스텔' }),
    notice('갈매역세권 도시형', '2026-10-23', { typeLabel: '도시형생활주택' }),
    notice('갈매역세권 생숙', '2026-10-24', { typeLabel: '생활숙박시설' }),
    notice('갈매역세권 민간사전청약', '2026-10-25', { typeLabel: '민간사전청약' }),
  ];
  const rows = app.saleHistory({ history: [A2], notices });
  assert.deepEqual(rows.map((r) => [r.type, r.rental, r.stage]), [
    ['민간사전청약', false, '사전청약'], ['생활숙박시설', false, null], ['도시형생활주택', false, null], ['오피스텔', false, null],
    ['민간임대', true, null], ['공공지원민간임대', true, null], ['공공분양', false, '본청약'],
  ]);
  assert.equal(app.latestSale({ history: [A2], notices }), '2025-03');
  // 아파트 분양 공고(APT·무순위 등)는 센다
  assert.equal(app.latestSale({ history: [A2], notices: [...notices, notice('갈매역세권 무순위', '2026-09-01', { typeLabel: '무순위' })] }), '2026-09');
});

test('sourceOutlet matches the pipeline rule and never trusts a non-http url', () => {
  const cases = [
    { outlet: '청약홈', title: '분양정보 (번호)' },
    { title: '기사 (하남Times)', url: 'http://m.hanamtimes.com/a' },
    { title: '괄호 없음', url: 'https://www.huic.co.kr/a' },
    {},
  ];
  for (const source of cases) assert.equal(app.sourceOutlet(source), pipeline.sourceOutlet(source));
  assert.equal(app.sourceOutlet({ title: '괄호 없음', url: 'javascript:alert(1)' }), '출처');
});

// --- 블록별 현황 ---
const blocksPipeline = await import('../src/pipeline/blocks.js');

test('block status order and nameHasBlock match the pipeline', () => {
  assert.deepEqual(app.BLOCK_STATUS_ORDER, blocksPipeline.BLOCK_STATUS_ORDER);
  assert.deepEqual(app.REMAINDER_NOTICE_TYPES, blocksPipeline.REMAINDER_NOTICE_TYPES);
  for (const status of app.BLOCK_STATUS_ORDER) assert.ok(app.BLOCK_STATUS_CLASS[status], status);
  for (const [name, block] of [['하남교산 A-2BL', 'A2'], ['하남교산 A20', 'A2'], ['하남교산 A2-1', 'A2'], ['갈매 B-1블록', 'B-1']]) {
    assert.equal(app.nameHasBlock(name, block), blocksPipeline.nameHasBlock(name, block), name);
  }
});

test('isBlockTownProject: only 공공주택지구 at 블록별 분양', () => {
  assert.equal(app.isBlockTownProject({ kind: '공공주택지구', stage: '블록별 분양' }), true);
  assert.equal(app.isBlockTownProject({ kind: '공공주택지구', stage: '지구지정' }), false);
  assert.equal(app.isBlockTownProject({ kind: '재개발', stage: '블록별 분양' }), false);
  assert.equal(app.isBlockTownProject(null), false);
});

test('blockStatusNow: a 접수 중 row whose deadline passed after the build becomes 본청약 공고 or 임대 공고', () => {
  const live = { status: '접수 중', statusDate: '2026-11-11', timeline: [{ stage: '사전청약', date: '2021-01-01' }, { stage: '본청약', date: '2026-10-30' }, { stage: '접수 중', date: '2026-11-11' }] };
  assert.deepEqual(app.blockStatusNow(live, '2026-11-11'), { status: '접수 중', date: '2026-11-11' });
  assert.deepEqual(app.blockStatusNow(live, '2026-11-12'), { status: '본청약 공고', date: '2026-10-30' });
  assert.deepEqual(app.blockStatusNow({ ...live, rental: true }, '2026-11-12'), { status: '임대 공고', date: '2026-10-30' });
  assert.deepEqual(app.blockStatusNow({ status: '사업승인', statusDate: '2025-11' }, '2026-11-12'), { status: '사업승인', date: '2025-11' });
  assert.deepEqual(app.blockStatusNow({ status: '이상한 값', statusDate: '내일' }, '2026-11-12'), { status: '미정', date: null });
  // 빌드 뒤에 계획 기간이 지나면 '예정 지남(보도)'
  const planned = { status: '다음 예정(보도)', statusDate: '2026-03-08', plan: { expected: '2026-하반기', to: '2026-12' } };
  assert.deepEqual(app.blockStatusNow(planned, '2026-12-31'), { status: '다음 예정(보도)', date: '2026-03-08' });
  assert.deepEqual(app.blockStatusNow(planned, '2027-01-01'), { status: '예정 지남(보도)', date: '2026-03-08' });
  assert.deepEqual(app.blockStatusNow({ ...planned, plan: null }, '2027-01-01'), { status: '다음 예정(보도)', date: '2026-03-08' });
});

test('blockRows cleans rows, keeps only http(s) links and sorts by status then block name', () => {
  const rows = app.blockRows({
    blocks: [
      { block: 'S10', status: '사업승인', statusDate: '2025-11-24', households: 541, sources: [{ title: 'a', url: 'http://www.ctnews.co.kr/39834', date: '2025-11-24' }] },
      { block: 'A9', type: '공공분양', status: '다음 예정(보도)', statusDate: '2026-03-08', households: 244,
        plan: { expected: '2026-하반기', from: '2026-07', to: '2026-12', source: { title: 'x', outlet: '하남일보', url: 'javascript:alert(1)', date: '2026-03-08' } },
        sources: [{ title: '나쁨', url: 'javascript:alert(1)' }] },
      { block: 'S9', status: '사업승인', statusDate: '2025-11-24', note: '  메모 ' },
      { block: 'A-1', type: '행복주택', rental: true, status: '임대 공고', statusDate: '2026-10-27',
        timeline: [{ stage: '본청약', date: '2026-10-27' }, { stage: '무순위', date: '2026-10-28' }, { stage: '사전청약', date: '날짜 아님' }] },
      '문자열',
      null,
    ],
  }, '2026-11-10');
  assert.deepEqual(rows.map((r) => [r.block, r.status]), [['A-1', '임대 공고'], ['A9', '다음 예정(보도)'], ['S9', '사업승인'], ['S10', '사업승인']]);
  const [a1, a9, s9, s10] = rows;
  // 무순위 같은 유형 이름 단계는 남기고, 날짜가 아닌 줄은 뺀다
  assert.deepEqual(a1.timeline, [{ stage: '본청약', date: '2026-10-27' }, { stage: '무순위', date: '2026-10-28' }]);
  assert.equal(a1.rental, true);
  assert.deepEqual(a9.sources, []);
  assert.deepEqual(a9.plan, { expected: '2026-하반기', from: '2026-07', to: '2026-12', source: null });
  assert.deepEqual([s9.type, s9.households, s9.note, s9.date], [null, null, '메모', '2025-11-24']);
  assert.equal(s10.sources[0].url, 'http://www.ctnews.co.kr/39834');
  assert.deepEqual(app.blockStatusCounts(rows), [
    { status: '임대 공고', count: 1 }, { status: '다음 예정(보도)', count: 1 }, { status: '사업승인', count: 2 },
  ]);
  assert.deepEqual(app.blockRows({}, '2026-11-10'), []);
});

test('block labels: total, type, date, timeline and plan', () => {
  const total = { total: 39, approved: 16, date: '2025-11-24', outlet: '시티뉴스', sources: [{ title: 't', url: 'http://www.ctnews.co.kr/39834' }] };
  // 표의 사업승인 칩 수와 헷갈리지 않게 출처가 한 말로 적는다
  assert.equal(app.blockTotalText(total), '시티뉴스(2025-11): 39개 블록 중 16개 사업승인');
  assert.equal(app.blockTotalText({ total: 39 }), '출처: 전체 39개 블록');
  assert.equal(app.blockTotalText({ total: 39, sources: [{ title: '기사 (시티뉴스)', url: 'http://x.kr/1' }] }), '시티뉴스: 전체 39개 블록');
  assert.equal(app.blockTotalText(null), null);
  assert.equal(app.blockTotalText({ total: '39' }), null);
  assert.equal(app.blockTypeLabel({ type: '공공분양' }), '공공분양');
  assert.equal(app.blockTypeLabel({ type: ' ' }), '유형 미확인');
  assert.equal(app.blockDateLabel({ status: '접수 중', date: '2026-11-11' }), '마감 2026-11-11');
  assert.equal(app.blockDateLabel({ status: '사업승인', date: '2025-11-24' }), '2025-11-24');
  assert.equal(app.blockDateLabel({ status: '미정', date: null }), '');
  assert.equal(app.blockTimelineLabel({ stage: '사전청약', date: '2021-11-18' }), '사전청약 2021-11-18');
  assert.equal(app.blockTimelineLabel({ stage: '본청약', date: '2026-10-27' }, true), '공고 2026-10-27');
  assert.equal(app.blockTimelineLabel({ stage: '접수 중', date: '2026-11-11' }), '접수 중(마감 2026-11-11)');
  assert.equal(app.blockTimelineLabel({ stage: '무순위', date: '2026-01-10' }), '무순위 2026-01-10');
  const plan = { expected: '2026-하반기', from: '2026-07', to: '2026-12', source: { title: 'x', outlet: '하남일보', url: 'http://m.hanamilbo.net/1', date: '2026-03-08' } };
  assert.equal(app.blockPlanLabel(plan, '2026-11'), '2026-하반기 (하남일보 2026-03-08)');
  assert.equal(app.blockPlanLabel({ ...plan, expected: '2026-상반기', to: '2026-06' }, '2026-11'), '2026-상반기 (하남일보 2026-03-08) · 지남');
  assert.equal(app.blockPlanLabel({ expected: '2027-09', source: null }, '2026-11'), '2027-09');
  assert.equal(app.blockPlanLabel(null, '2026-11'), null);
});
