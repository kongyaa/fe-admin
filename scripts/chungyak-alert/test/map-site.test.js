// 정적 사이트(site/app.js)의 순수 함수 검사. DOM 없이 import 되어야 한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const app = await import('../site/app.js');
const pipeline = await import('../src/pipeline/expected-window.js');
const {
  BUCKET_ORDER, BUCKET_INFO, bucketOf, compareProjects, dataFile, idFromHash, kstYmd, latestAnnounce, matchesFilters,
  monthsBetween, safeHttpUrl, shortDistrict, sortProjects, tileClass, tileStats, whenMatches, windowLabel, windowRange,
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
  assert.equal(matchesFilters(seoul, { ...ALL, area: '경기·인천' }, today), false);
  assert.equal(matchesFilters(town, { ...ALL, area: '경기·인천' }, today), true);
  // 지역 '경기·인천'은 인천 지구(인천계양)도 함께 본다
  const incheon = { ...town, region: '인천', district: '계양구', name: '인천계양' };
  assert.equal(matchesFilters(incheon, { ...ALL, area: '경기·인천' }, today), true);
  assert.equal(matchesFilters(incheon, { ...ALL, area: '서울' }, today), false);
  assert.equal(app.TOWN_AREA, '경기·인천');
  assert.equal(app.inArea(incheon, '인천'), true);
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

test('windowRange', () => {
  assert.equal(windowRange(win('2027-01', '2028-01')), '2027-01~2028-01');
  assert.equal(windowRange(win('2027-01', '2027-01')), '2027-01');
  assert.equal(windowRange({ window: { from: null, to: null } }), null);
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

test('tile map: per-구 counts (with 공고 중) and 3-step colour: 6+ hot, 1+ has', () => {
  const p = (district, bucket, region = '서울') => ({ district, region, bucket });
  const stats = tileStats([
    p('종로구', 'soon'), p('종로구', 'live'), p('종로구', 'soon'), p('종로구', 'mid'),
    p('중구', 'soon'), p('중구', 'far'),
    p('용산구', 'mid'), p('용산구', 'overdue'),
    p('도봉구', 'far'),
    p('하남시', 'soon', '경기'),
  ], (x) => x.bucket);
  assert.deepEqual(stats.get('종로구'), { n: 4, soon: 3, mid: 1, live: 1 });
  assert.equal(stats.has('하남시'), false);
  assert.equal(tileClass(stats.get('종로구')), 'has');
  assert.equal(tileClass({ n: 9, soon: 6, mid: 0 }), 'hot');
  assert.equal(tileClass({ n: 9, soon: 5, mid: 0 }), 'has');
  assert.equal(tileClass(stats.get('중구')), 'has');
  assert.equal(tileClass({ n: 2, soon: 2, mid: 0 }), 'has');
  assert.equal(tileClass(stats.get('용산구')), ''); // 3년 안만 있으면 1년 안 숫자(0)와 같은 색
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
  assert.deepEqual(stats.get('종로구'), { n: 3, soon: 1, mid: 0, live: 0 });
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

// --- 화면 다듬기: 검색·타일 숫자·필터·빈 결과·주소 해시·예상 범위 문구 ---

test('search covers 구 names (full and short) and subKind, not only name and address', () => {
  const p = { name: '개포주공5단지', district: '강남구', subKind: '아파트지구재건축', address: '개포동 187', roadAddress: null, ...win('2027-01') };
  assert.equal(app.searchText(p), '개포주공5단지개포동187강남구강남아파트지구재건축');
  for (const q of ['강남구', '강남', '강남 구', '개포', '아파트지구']) assert.equal(matchesFilters(p, { ...ALL, q }, today), true, q);
  assert.equal(matchesFilters(p, { ...ALL, q: '서초구' }, today), false);
  // 미리 계산한 검색 글자를 넘기면 그것으로 찾는다
  assert.equal(matchesFilters(p, { ...ALL, q: '강남' }, today, undefined, app.searchText(p)), true);
  assert.equal(matchesFilters(p, { ...ALL, q: '강남' }, today, undefined, 'other'), false);
  assert.equal(app.searchText({}), '');
  assert.equal(app.searchText(null), '');
});

test('tileCount: the big number is the 1년 안 count (same question as the colour), total is small', () => {
  const stats = tileStats([
    { region: '서울', district: '중구', b: 'soon' }, { region: '서울', district: '중구', b: 'live' },
    { region: '서울', district: '중구', b: 'far' }, { region: '서울', district: '중구', b: 'mid' },
  ], (p) => p.b);
  assert.deepEqual(app.tileCount(stats.get('중구')), { main: 2, total: 4 });
  assert.equal(tileClass(stats.get('중구')), 'has'); // 큰 숫자 2 → 1곳 이상 색
  assert.deepEqual(app.tileCount({ n: 36, soon: 12, mid: 3 }), { main: 12, total: 36 });
  assert.equal(tileClass({ n: 36, soon: 12, mid: 3 }), 'hot');
  assert.deepEqual(app.tileCount(undefined), { main: 0, total: 0 });
});

test('nextFilters: 지역 경기·인천 replaces the duplicate 유형 공공주택지구 and locks 유형', () => {
  assert.deepEqual(app.DEFAULT_FILTERS, ALL);
  const gyeonggi = app.nextFilters({ ...ALL, kind: '재개발', district: '종로구' }, 'area', '경기·인천');
  assert.deepEqual(gyeonggi, { ...ALL, area: '경기·인천' }); // 유형과 서울 구 선택은 풀린다
  assert.equal(app.kindLocked(gyeonggi), true);
  assert.equal(app.kindLocked({ ...ALL, area: '서울' }), false);
  assert.deepEqual(app.nextFilters(gyeonggi, 'kind', '재건축'), gyeonggi); // 잠겨 있으면 그대로
  assert.deepEqual(app.nextFilters(gyeonggi, 'district', '강남구'), { ...ALL, district: '강남구' }); // 서울 구를 고르면 지역 전체로
  assert.deepEqual(app.nextFilters({ ...ALL, district: '강남구' }, 'district', null), ALL);
  assert.deepEqual(app.nextFilters(ALL, 'q', '개포'), { ...ALL, q: '개포' });
  assert.deepEqual(app.nextFilters(undefined, 'when', '12'), { ...ALL, when: '12' });
  // 원래 필터는 바꾸지 않는다
  const before = { ...ALL };
  app.nextFilters(before, 'area', '경기·인천');
  assert.deepEqual(before, ALL);

  // 합친 뒤에도 결과 수가 같다: 예전 '유형 공공주택지구'와 '지역 경기 공공주택지구'는 같은 사업만 골랐다
  const list = [
    { region: '서울', kind: '재개발', district: '종로구', stage: '이주', ...win('2027-01') },
    { region: '서울', kind: '재건축', district: '강남구', stage: '착공', ...win('2028-01') },
    { region: '경기', kind: '공공주택지구', district: '하남시', stage: '블록별 분양', ...win('2026-12') },
    { region: '경기', kind: '공공주택지구', district: '구리시', stage: '지구지정', ...win('2029-01') },
    { region: '인천', kind: '공공주택지구', district: '계양구', stage: '블록별 분양', ...win('2027-01') },
  ];
  const ids = (f) => list.filter((p) => matchesFilters(p, f, today)).map((p) => p.district);
  for (const when of ['all', '12', '36']) {
    assert.deepEqual(ids({ ...ALL, when, area: '경기·인천' }), ids({ ...ALL, when, kind: '공공주택지구' }), when);
    assert.deepEqual(ids({ ...ALL, when, area: '경기·인천' }), ids({ ...ALL, when, area: '경기·인천', kind: '공공주택지구' }), when);
  }
});

test('filter summary counts only the controls inside the 필터 box', () => {
  assert.equal(app.activeFilterCount(ALL), 0);
  assert.equal(app.filterSummary(ALL), '필터');
  assert.equal(app.activeFilterCount({ ...ALL, district: '강남구' }), 0); // 구는 지도에서 고른다
  const many = { ...ALL, area: '서울', kind: '재건축', when: '12', stage: 'seoul:이주', q: '개포' };
  assert.equal(app.activeFilterCount(many), 5);
  assert.equal(app.filterSummary({ ...ALL, when: '36', q: '개포' }), '필터 (2개 적용)');
  assert.equal(app.filterSummary(undefined), '필터');
});

test('emptyState: one message with the active conditions and the right way out', () => {
  assert.deepEqual(app.emptyState({ ...ALL, q: '강남구' }), {
    title: '‘강남구’에 맞는 사업이 없습니다.', conditions: ['검색 ‘강남구’'], clearQuery: true, reset: false,
  });
  assert.deepEqual(app.emptyState({ ...ALL, area: '경기·인천', when: '12', stage: 'town:준공', district: null }), {
    title: '지금 조건에 맞는 사업이 없습니다.', conditions: ['경기·인천 공공주택지구', '1년 안', '단계 준공'], clearQuery: false, reset: true,
  });
  const both = app.emptyState({ ...ALL, area: '서울', kind: '재개발', when: '36', district: '중구', q: 'x' });
  assert.deepEqual(both.conditions, ['서울', '재개발', '3년 안', '중구', '검색 ‘x’']);
  assert.deepEqual([both.clearQuery, both.reset], [true, true]);
  assert.deepEqual(app.emptyState(ALL), { title: '표시할 사업이 없습니다.', conditions: [], clearQuery: false, reset: false });
});

test('parseHash / hashFor: detail and 구 selection round-trip; old #p= links still work', () => {
  assert.deepEqual(app.parseHash('#p=seoul-1441'), { id: 'seoul-1441', district: null, town: null, block: null });
  assert.deepEqual(app.parseHash('#gu=%EA%B0%95%EB%82%A8%EA%B5%AC'), { id: null, district: '강남구', town: null, block: null });
  assert.deepEqual(app.parseHash('#gu=%EA%B0%95%EB%82%A8%EA%B5%AC&p=seoul-1012'), { id: 'seoul-1012', district: '강남구', town: null, block: null });
  assert.deepEqual(app.parseHash('#p=%E0&gu=%EC%A4%91%EA%B5%AC'), { id: null, district: '중구', town: null, block: null }); // 깨진 값만 버린다
  assert.deepEqual(app.parseHash('#sources'), { id: null, district: null, town: null, block: null });
  assert.deepEqual(app.parseHash('#=x&p='), { id: null, district: null, town: null, block: null });
  assert.deepEqual(app.parseHash(undefined), { id: null, district: null, town: null, block: null });
  for (const s of [{ id: 'seoul-1441', district: null, town: null, block: null }, { id: null, district: '강남구', town: null, block: null }, { id: 'a&b=c', district: '중구', town: null, block: null }, { id: '예시', district: null, town: null, block: null }]) {
    assert.deepEqual(app.parseHash(app.hashFor(s)), s);
  }
  assert.equal(app.hashFor({ id: 'seoul-1441' }), '#p=seoul-1441');
  assert.equal(app.hashFor({ district: '중구', id: 'x' }), '#gu=%EC%A4%91%EA%B5%AC&p=x');
  assert.equal(app.hashFor({}), '');
  assert.equal(app.hashFor(), '');
  // 화면 상태 해시와 문서 안 이동(#sources, #list-title)을 가른다(뒤로 가기 처리)
  assert.equal(app.isStateHash(''), true);
  assert.equal(app.isStateHash('#'), true);
  assert.equal(app.isStateHash('#p=x'), true);
  assert.equal(app.isStateHash('#gu=%EC%A4%91%EA%B5%AC'), true);
  assert.equal(app.isStateHash('#sources'), false);
  assert.equal(app.isStateHash('#list-title'), false);
  assert.equal(idFromHash('#gu=%EC%A4%91%EA%B5%AC&p=seoul-1'), 'seoul-1');
});

test('windowRangeLabel: a 1년 안 range that already started reads 지금~end (presentation only)', () => {
  const started = win('2024-11', '2026-11');
  assert.equal(bucketOf(started, today), 'soon');
  assert.equal(app.windowRangeLabel(started, today), '지금~2026-11');
  assert.equal(windowLabel(started, today), '지금~2026-11');
  assert.equal(app.windowRangeLabel(win('2026-04', '2027-04'), today), '지금~2027-04');
  assert.deepEqual(started.window, { from: '2024-11', to: '2026-11' }); // 자료는 그대로
  assert.equal(windowRange(started), '2024-11~2026-11');
  // 이번 달 시작·앞으로의 범위는 그대로
  assert.equal(app.windowRangeLabel(win('2026-11', '2027-11'), today), '2026-11~2027-11');
  assert.equal(app.windowRangeLabel(win('2027-03'), today), '2027-03');
  // 지난 범위(예상 지남)와 공고 중은 원래 범위
  assert.equal(windowLabel(win('2024-01', '2025-01'), today), '2024-01~2025-01 (지남)');
  assert.equal(app.windowRangeLabel({ ...win('2026-04', '2027-04'), live: true }, today), '2026-04~2027-04');
  assert.equal(app.windowRangeLabel({ window: { from: null, to: null } }, today), null);
});

test('live projects say 공고 중 (open notice, may be before 접수 starts; block statuses keep the pipeline names); a chip colour never means two different states', () => {
  assert.equal(BUCKET_INFO.live.label, '공고 중');
  assert.equal(windowLabel({ live: true, window: null }, today), '공고 중');
  const projectClass = new Map(Object.values(BUCKET_INFO).map((info) => [info.cls, info.label]));
  // 사업 칩과 같은 클래스를 쓰는 블록 상태는 뜻이 같은 것뿐
  const shared = Object.entries(app.BLOCK_STATUS_CLASS).filter(([, cls]) => projectClass.has(cls)).map(([status, cls]) => [status, projectClass.get(cls)]);
  assert.deepEqual(shared, [['접수 중', '공고 중'], ['본청약 공고', '공고 있었음'], ['예정 지남(보도)', '예상 지남'], ['미정', '3년 뒤·미정']]);
  const blockClasses = Object.values(app.BLOCK_STATUS_CLASS);
  assert.equal(new Set(blockClasses).size, blockClasses.length);
  const css = readFileSync(new URL('../site/style.css', import.meta.url), 'utf8');
  for (const cls of blockClasses) assert.ok(css.includes(`.${cls} {`), cls);
});

test('index.html: merged 지역/유형 filters, collapsible filter box, skip link', () => {
  const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.equal(html.includes('data-filter="kind" data-value="공공주택지구"'), false);
  assert.ok(html.includes('data-filter="area" data-value="경기·인천" aria-pressed="false">경기·인천</button>'));
  for (const id of ['filters-box', 'filters-summary', 'kind-group', 'disclaimer', 'towns-title', 'list-title', 'feed-title', 'dash-tiles', 'gu-grid', 'watch-grid', 'region-panel', 'cal', 'agenda', 'refresh', 'refresh-text', 'mark-read', 'main-view', 'view']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes('href="#feed-title"'));
  assert.ok(html.includes('placeholder="구역명·구·동"'));
  // 잠긴 유형 버튼의 이유(aria-describedby 대상)
  assert.ok(html.includes('id="kind-locked-note"'));
});

test('auto folds: every <details class="fold auto"> ships open and is the initFolds list; other folds keep their summary on wide screens', () => {
  const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  const autos = [...html.matchAll(/<details\b[^>]*>/g)].map((m) => m[0]).filter((tag) => /class="[^"]*\bfold\b[^"]*\bauto\b/.test(tag));
  assert.deepEqual(autos.map((tag) => /id="([^"]+)"/.exec(tag)?.[1]).sort(), [...app.AUTO_FOLD_IDS].sort());
  // 스크립트가 없어도 넓은 화면에서 내용이 보이게 기본은 펼침
  for (const tag of autos) assert.match(tag, /\sopen[\s>]/, tag);
  // 넓은 화면에서 접기 제목을 숨기는 규칙은 auto 에만(블록 표 설명처럼 닫혀 있는 보통 접기는 제목으로 열 수 있어야 한다)
  const css = readFileSync(new URL('../site/style.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.fold.auto > summary { display: none; }'));
  assert.equal(/(^|[\s,}])\.fold > summary \{[^}]*display: none/.test(css), false);
  const js = readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
  assert.ok(js.includes("h('details', { class: 'fold note' }"), 'block table note is a normal fold');
});

test('edge cases: year boundary range, duplicate hash keys, district-only empty state', () => {
  // 시작 달이 지난해 12월, 오늘이 1월이어도 이미 시작된 범위
  assert.equal(app.windowRangeLabel(win('2025-12', '2026-06'), '2026-01'), '지금~2026-06');
  assert.equal(app.windowRangeLabel(win('2026-01', '2026-06'), '2026-01'), '2026-01~2026-06');
  // 같은 키가 두 번이면 뒤의 값
  assert.deepEqual(app.parseHash('#p=a&p=b'), { id: 'b', district: null, town: null, block: null });
  assert.deepEqual(app.parseHash('#gu=%EC%A4%91%EA%B5%AC&gu=%EA%B0%95%EB%82%A8%EA%B5%AC&p=x'), { id: 'x', district: '강남구', town: null, block: null });
  // 구만 골랐는데 결과가 없으면 초기화 버튼(구 선택도 푼다)
  assert.deepEqual(app.emptyState({ ...ALL, district: '중구' }), {
    title: '지금 조건에 맞는 사업이 없습니다.', conditions: ['중구'], clearQuery: false, reset: true,
  });
});

// --- 새 화면(요약판·새 소식·지구 화면) ------------------------------------------------

test('generatedAt: date-only and ISO with KST offset both read as Korea time', () => {
  assert.deepEqual(app.parseStamp('2026-11-10'), { date: '2026-11-10', time: null });
  assert.deepEqual(app.parseStamp('2026-11-10T07:30:00+09:00'), { date: '2026-11-10', time: '07:30' });
  assert.deepEqual(app.parseStamp('2026-11-09T22:30:00Z'), { date: '2026-11-10', time: '07:30' });
  assert.deepEqual(app.parseStamp('2026-11-10T19:05'), { date: '2026-11-10', time: '19:05' }); // 오프셋 없으면 한국 시간
  for (const bad of ['', null, undefined, '2026-11', 'yesterday', '2026-11-10 07:30']) assert.equal(app.parseStamp(bad), null, String(bad));
  assert.equal(app.stampLabel('2026-11-10T07:30:00+09:00'), '11-10 07:30');
  assert.equal(app.stampLabel('2026-11-10'), '2026-11-10');
  assert.equal(app.stampLabel(null), null);
  assert.equal(app.shortDate('2026-11-08', '2026-11-10'), '11.08');
  assert.equal(app.shortDate('2025-12-24', '2026-11-10'), '25.12.24');
  assert.equal(app.monthLabel('2026-06'), '2026년 6월');
  assert.equal(app.addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(app.weekdayOf('2026-11-10'), 2); // 화요일
});

test('seen storage: first visit marks only the last 7 days NEW, later visits mark ids not seen; blocked storage never throws', () => {
  const s = fakeStorage();
  assert.equal(app.readSeen(s), null);
  const first = app.visitBaseline(app.readSeen(s), '2026-11-10');
  assert.deepEqual(first, { ids: null, since: '2026-11-04', lastVisit: null });
  assert.equal(app.isNewItem({ id: 'a', date: '2026-11-04' }, first), true);
  assert.equal(app.isNewItem({ id: 'a', date: '2026-11-03' }, first), false);
  assert.equal(app.isNewItem({ id: 'a', date: '2026-11-17' }, first), true); // 곧 시작하는 접수
  assert.equal(app.writeSeen(s, { ids: ['a', 'b'], lastVisit: '2026-11-10T08:00:00.000Z' }), true);
  assert.equal(s.map.get(app.SEEN_KEY), '{"ids":["a","b"],"lastVisit":"2026-11-10T08:00:00.000Z"}');
  const next = app.visitBaseline(app.readSeen(s), '2026-11-12');
  assert.deepEqual([...next.ids], ['a', 'b']);
  assert.equal(next.lastVisit, '2026-11-10T08:00:00.000Z');
  assert.equal(app.isNewItem({ id: 'a', date: '2026-11-12' }, next), false);
  assert.equal(app.isNewItem({ id: 'c', date: '2020-01-01' }, next), true);
  assert.equal(app.isNewItem(null, next), false);
  // 깨진 값·막힌 저장소
  assert.equal(app.readSeen(fakeStorage({ [app.SEEN_KEY]: '{oops' })), null);
  assert.equal(app.readSeen(fakeStorage({ [app.SEEN_KEY]: '{"ids":"a"}' })), null);
  assert.deepEqual(app.readSeen(fakeStorage({ [app.SEEN_KEY]: '{"ids":["a",3,null,""]}' })), { ids: ['a'], lastVisit: null });
  assert.equal(app.readSeen(fakeStorage({}, { blocked: true })), null);
  assert.equal(app.writeSeen(fakeStorage({}, { blocked: true }), { ids: ['a'] }), false);
  assert.equal(app.writeSeen(null, { ids: ['a'] }), false);
  // 한 방문(탭) 동안의 기준은 sessionStorage 에 둔다
  const tab = fakeStorage();
  assert.equal(app.writeVisit(tab, next), true);
  assert.deepEqual([...app.readVisit(tab).ids], ['a', 'b']);
  app.writeVisit(tab, first);
  assert.deepEqual(app.readVisit(tab), { ids: null, since: '2026-11-04', lastVisit: null });
  assert.equal(app.readVisit(fakeStorage({ [app.VISIT_KEY]: '{"ids":null}' })), null);
  assert.equal(app.readVisit(fakeStorage({}, { blocked: true })), null);
});

const FEED = [
  { id: 'n1', date: '2026-11-08', kind: '뉴스', projectId: 'town-g', block: 'B-1', title: 'B-1 기사', source: { title: '스트레이트뉴스', url: 'https://example.com/1', date: '2026-11-08' } },
  { id: 'a1', date: '2026-11-10', kind: '접수', projectId: 'town-g', block: 'B-1', title: '1순위 접수 (2026-11-10 마감)', source: { title: '청약홈', url: 'https://www.applyhome.co.kr/x' } },
  { id: 'r1', date: '2026-10-27', kind: '뉴스', projectId: 'town-g', block: 'A-1', rental: true, title: 'A-1 행복주택', source: { title: '메트로신문', url: 'javascript:alert(1)' } },
  { id: 's1', date: '2025-08-05', kind: '뉴스', projectId: 'town-g', block: 'A-1', title: 'A-1 신혼희망타운', source: { title: 'LH, 갈매 공급 (한국경제)', url: 'https://www.hankyung.com/a' } },
  { id: 'p1', date: '2026-03-08', kind: '일정', projectId: 'town-h', block: 'A9·A11', title: 'A9·A11 하반기 (지역지)', source: { title: '하남일보', url: 'http://m.hanamilbo.net/x', local: true } },
  { id: 'w1', date: '2025-12-24', kind: '뉴스', projectId: 'town-g', block: null, title: 'GTX-B', source: { title: '뉴시스', url: 'https://www.newsis.com/x' } },
  { id: 'n1', date: '2026-11-09', kind: '뉴스', projectId: 'x', title: '같은 id 는 처음 것만' },
  { id: 'bad', date: '2026-11', kind: '뉴스', title: '날짜 형식 틀림' },
  { id: 'bad2', date: '2026-11-01', kind: '광고', title: '모르는 종류' },
  { id: 'bad3', date: '2026-11-01', kind: '뉴스', title: '  ' },
  null,
];

test('cleanFeed keeps valid items newest first, http(s) links only; filterFeed by kind, NEW, project, block', () => {
  const feed = app.cleanFeed(FEED);
  assert.deepEqual(feed.map((f) => f.id), ['a1', 'n1', 'r1', 'p1', 'w1', 's1']);
  assert.equal(feed.find((f) => f.id === 'r1').source.url, null);
  assert.equal(feed.find((f) => f.id === 'r1').rental, true);
  assert.equal(feed.find((f) => f.id === 'p1').source.local, true);
  assert.deepEqual(app.cleanFeed(undefined), []);
  const fresh = new Set(['a1', 'n1']);
  const isNew = (f) => fresh.has(f.id);
  assert.deepEqual(app.filterFeed(feed, { kind: '뉴스' }).map((f) => f.id), ['n1', 'r1', 'w1', 's1']);
  assert.deepEqual(app.filterFeed(feed, { onlyNew: true }, isNew).map((f) => f.id), ['a1', 'n1']);
  assert.deepEqual(app.filterFeed(feed, { kind: '접수', onlyNew: true }, isNew).map((f) => f.id), ['a1']);
  assert.deepEqual(app.filterFeed(feed, { projectId: 'town-h' }).map((f) => f.id), ['p1']);
  assert.deepEqual(app.filterFeed(feed, { block: 'B1' }).map((f) => f.id), ['a1', 'n1']); // 'B1' 과 'B-1' 은 같은 블록
  assert.deepEqual(app.filterFeed(feed, { block: 'A11' }).map((f) => f.id), ['p1']); // 'A9·A11' 은 두 블록
  assert.deepEqual(app.filterFeed(feed, { projectId: 'town-g', block: app.WHOLE_TOWN }).map((f) => f.id), ['w1']);
  assert.deepEqual(app.feedKindCounts(feed), { all: 6, 공고: 0, 접수: 1, 뉴스: 4, 일정: 1, 단계: 0 });
  assert.equal(app.kindBreakdown(feed.filter(isNew)), '접수 일정 1, 뉴스 1');
  assert.equal(app.kindBreakdown([]), '');
});

test('blocks with both sale and rental rows split the block filter by the item rental flag', () => {
  const rows = [{ block: 'A-1', rental: false }, { block: 'A-1', rental: true }, { block: 'B-1', rental: false }, { block: 'A-2', rental: true }];
  const split = app.splitBlocks(rows);
  assert.deepEqual([...split], ['A1']);
  assert.equal(app.blockSel(rows[0], split), 'A-1');
  assert.equal(app.blockSel(rows[1], split), 'A-1 임대');
  assert.equal(app.blockSel(rows[3], split), 'A-2'); // 임대 줄뿐이면 꼬리 없음
  const feed = app.cleanFeed(FEED);
  assert.deepEqual(app.filterFeed(feed, { block: 'A-1', split }).map((f) => f.id), ['s1']);
  assert.deepEqual(app.filterFeed(feed, { block: 'A-1 임대', split }).map((f) => f.id), ['r1']);
  assert.deepEqual(app.filterFeed(feed, { block: 'A-1' }).map((f) => f.id), ['r1', 's1']); // 나누지 않으면 둘 다
  assert.equal(app.sameBlock('A-1', 'A1'), true);
  assert.equal(app.sameBlock('A-1 임대', 'A-1'), false);
  assert.equal(app.sameBlock(null, ''), true);
  assert.equal(app.sameBlock(app.WHOLE_TOWN, 'A-1'), false);
  assert.deepEqual(app.feedBlocks({ block: 'A9·A11' }), ['A9', 'A11']);
  assert.deepEqual(app.feedBlocks({ block: null }), []);
});

test('feedSourceLabel: outlet, title in parentheses, short title, then host; never a non-http host', () => {
  assert.equal(app.feedSourceLabel({ title: '메트로신문', url: 'https://www.metroseoul.co.kr/a', date: '2026-11-03' }), '메트로신문 2026-11-03');
  assert.equal(app.feedSourceLabel({ title: 'LH, 4분기 전국 4663가구 공공임대 공급 (메트로신문)', url: 'https://x.kr', date: '2026-10-27' }), '메트로신문 2026-10-27');
  assert.equal(app.feedSourceLabel({ title: '아주 긴 제목이라 매체 이름을 알 수 없는 기사 제목입니다 정말로', url: 'https://www.newsis.com/view/1' }), 'newsis.com');
  assert.equal(app.feedSourceLabel({ title: '', url: 'javascript:alert(1)' }), '출처');
  assert.equal(app.feedSourceLabel({ title: '청약홈', url: 'https://www.applyhome.co.kr/', date: null }), '청약홈');
});

const galmae = {
  id: 'town-g', name: '구리갈매역세권', kind: '공공주택지구', stage: '블록별 분양', region: '경기', district: '구리시',
  window: { from: '2026-12', to: '2028-12' }, windowStatus: 'estimated', windowLabel: '다음 블록 예상', live: true,
  notices: [
    {
      name: '구리갈매역세권 B-1블록 신안인스빌 디센트', announceDate: '2026-10-30', end: '2026-11-11', typeLabel: 'APT',
      stages: [{ name: '특별공급', start: '2026-11-09', end: '2026-11-09' }, { name: '1순위 해당', start: '2026-11-10', end: '2026-11-10' }, { name: '2순위', start: '2026-11-11', end: '2026-11-11' }, { name: '당첨자 발표', start: '2026-11-17' }],
      winnerDate: '2026-11-17',
    },
    { name: '구리갈매역세권 A-4블록 6년 분양전환공공임대주택(본청약)', announceDate: '2025-12-29', end: '2026-01-16', stages: [] },
  ],
  blocks: [
    { block: 'B-1', type: '민간분양', households: 213, status: '접수 중', statusDate: '2026-11-11', timeline: [{ stage: '본청약', date: '2026-10-30' }, { stage: '접수 중', date: '2026-11-11' }] },
    { block: 'S-1', households: 734, status: '계획 보도', statusDate: '2026-05-06', timeline: [] },
    { block: 'B-2', type: '실버스테이', rental: true, status: '다음 예정(보도)', statusDate: '2025-05-04', plan: { expected: '2029-하반기', from: '2029-07', to: '2029-12', source: { url: 'https://news.mtn.co.kr/x', date: '2025-05-04' } } },
    { block: 'A-1', type: '신혼희망타운', status: '본청약 공고', statusDate: '2025-07-29', timeline: [{ stage: '사전청약', date: '2021-12-29' }, { stage: '본청약', date: '2025-07-29' }] },
  ],
};
const gyosan = {
  id: 'town-h', name: '하남교산', kind: '공공주택지구', stage: '블록별 분양', region: '경기', district: '하남시',
  window: { from: '2026-11', to: '2026-12' }, windowStatus: 'estimated', windowLabel: '다음 블록 예상', notices: [],
  blocks: [
    { block: 'A9', type: '공공분양', status: '다음 예정(보도)', statusDate: '2026-03-08', plan: { expected: '2026-하반기', from: '2026-07', to: '2026-12', source: { url: 'http://m.hanamilbo.net/x', date: '2026-03-08' } } },
    { block: 'A11', type: '공공분양', status: '다음 예정(보도)', statusDate: '2026-03-08', plan: { expected: '2026-하반기', from: '2026-07', to: '2026-12' } },
    { block: 'D2', type: '민간분양', status: '다음 예정(보도)', statusDate: '2025-12-13', plan: { expected: '2026-상반기', from: '2026-01', to: '2026-06' } },
    { block: 'A5', type: '나눔형 공공분양', status: '사업승인', statusDate: '2025-11-24', timeline: [{ stage: '사전청약', date: '2023-09-25' }] },
  ],
};

test('receivingNow: a notice is 접수 중 when today is inside a reception stage (not 당첨자 발표)', () => {
  assert.equal(app.noticeBlock('구리갈매역세권 B-1블록 신안인스빌 디센트'), 'B-1');
  assert.equal(app.noticeBlock('교산 푸르지오 더 퍼스트(하남교산 A-2BL)'), 'A-2');
  assert.equal(app.noticeBlock('중화역 라온프라이빗 센트로'), null);
  assert.equal(app.stageShort('1순위 해당'), '1순위');
  assert.equal(app.stageShort('2순위 기타지역'), '2순위');
  assert.deepEqual(app.receptionStages(galmae.notices[0]).map((s) => s.name), ['특별공급', '1순위 해당', '2순위']);
  const now = app.receivingNow([galmae, gyosan], '2026-11-10');
  assert.equal(now.length, 1);
  assert.deepEqual({ block: now[0].block, stage: now[0].stage, start: now[0].start, end: now[0].end, rental: now[0].rental, winnerDate: now[0].winnerDate },
    { block: 'B-1', stage: '1순위', start: '2026-11-10', end: '2026-11-11', rental: false, winnerDate: '2026-11-17' });
  assert.equal(app.receivingText(now[0]), '구리갈매역세권 B-1 1순위, 11-11 마감');
  assert.equal(app.receivingNow([galmae], '2026-11-08').length, 0); // 공고 중이지만 접수 전
  assert.equal(app.receivingNow([galmae], '2026-11-12').length, 0); // 접수 끝, 당첨자 발표 전
  assert.equal(app.isRentalNotice(galmae.notices[1]), true);
  assert.equal(app.isRentalNotice({ name: 'x', typeLabel: '민간임대' }), true);
});

test('dashboard: planned non-rental blocks and Seoul 1년 안 by 구', () => {
  const planned = app.plannedBlocks([galmae, gyosan], '2026-11-10');
  // D2 는 계획 기간이 지나 예정 지남, B-2 는 임대라 뺀다
  assert.deepEqual(planned.map((x) => `${x.project.name} ${x.block}`), ['구리갈매역세권 S-1', '하남교산 A9', '하남교산 A11']);
  assert.equal(app.plannedText(planned), '구리갈매역세권 S-1, 하남교산 A9·A11 (2026-하반기)');
  const seoul = [
    { id: '1', region: '서울', district: '중구', b: 'soon' }, { id: '2', region: '서울', district: '중구', b: 'live' },
    { id: '3', region: '서울', district: '송파구', b: 'soon' }, { id: '4', region: '서울', district: '강남구', b: 'mid' },
    { id: '5', region: '경기', district: '하남시', b: 'soon' },
  ];
  assert.deepEqual(app.seoulSoon(seoul, (p) => p.b), { total: 3, byDistrict: [['중구', 2], ['송파구', 1]] });
});

test('calendar: 21 days from today, today and weekends marked, tones, short labels and the text agenda', () => {
  const cal = app.cleanCalendar([
    { date: '2026-11-17', projectId: 'town-g', block: 'B-1', label: '당첨자 발표', title: 'B-1', rental: false, url: 'https://www.applyhome.co.kr/' },
    { date: '2026-11-10', projectId: 'town-g', block: 'B-1', label: '1순위', title: 'B-1', rental: false, url: 'javascript:x' },
    { date: '2026-11-10', projectId: 'town-g', block: 'A-1', label: '접수', title: 'A-1 행복주택', rental: true },
    { date: '2026-12-31', projectId: 'seoul-1', block: null, label: '1순위' },
    { date: 'soon', label: '1순위' },
  ]);
  assert.deepEqual(cal.map((e) => `${e.date} ${e.label}`), ['2026-11-10 1순위', '2026-11-10 접수', '2026-11-17 당첨자 발표', '2026-12-31 1순위']);
  assert.equal(cal[0].url, null);
  const days = app.calendarDays(cal, '2026-11-10');
  assert.equal(days.length, 21);
  assert.deepEqual([days[0].date, days[0].isToday, days[0].label, days[0].dow], ['2026-11-10', true, '11/10', 2]);
  assert.equal(days[20].date, '2026-11-30');
  assert.deepEqual(days.filter((d) => d.weekend).map((d) => d.date.slice(8)), ['14', '15', '21', '22', '28', '29']);
  assert.equal(days[1].label, '11');
  assert.equal(app.calendarDays([], '2026-11-25').find((d) => d.date === '2026-12-01').label, '12/1');
  assert.deepEqual(days[0].events.map(app.calendarTone), ['live', 'rent']);
  assert.equal(app.calendarTone(days[7].events[0]), 'win');
  const nameOf = (id) => ({ 'town-g': '구리갈매역세권' })[id] ?? null;
  assert.equal(app.calendarShort(days[7].events[0], nameOf), 'B-1 당첨');
  assert.equal(app.calendarShort({ projectId: 'town-g', label: '1순위' }, nameOf), '구리갈매역세권 1순위');
  assert.deepEqual(app.agendaItems(days, nameOf), [
    { date: '11/10', text: '구리갈매역세권 B-1 1순위, 구리갈매역세권 A-1 접수(임대)' },
    { date: '11/17', text: '구리갈매역세권 B-1 당첨자 발표' },
  ]);
});

test('town blocks: groups for the bar, small progress steps, and the headline', () => {
  const rows = app.blockRows(galmae, '2026-11-10');
  assert.deepEqual(rows.map((r) => [r.block, app.townGroupOf(r)]), [['B-1', 'live'], ['A-1', 'sold'], ['B-2', 'other'], ['S-1', 'plan']]);
  assert.deepEqual(app.townGroupCounts(rows).map((g) => `${g.label} ${g.n}`), ['분양 끝남 1', '접수 중 1', '다음 예정 1', '임대·기타 1']);
  assert.equal(app.townGroupOf({ status: '예정 지남(보도)' }), 'late');
  assert.equal(app.townGroupOf({ status: '사업승인' }), 'approved');
  assert.equal(app.townGroupOf({ status: '접수 중', rental: true }), 'live');
  assert.deepEqual(app.blockSteps(rows[0]), [{ label: '본청약', date: '2026-10-30', state: 'done' }, { label: '접수 중', date: '~11-11', state: 'now' }]);
  assert.deepEqual(app.blockSteps(rows[1]).map((s) => s.label), ['사전청약', '본청약']);
  assert.deepEqual(app.blockSteps(rows[3]), [{ label: '보도', date: '2026-05-06', state: 'done' }, { label: '공고', date: '미정', state: 'next' }]);
  const hRows = app.blockRows(gyosan, '2026-11-10');
  const a5 = hRows.find((r) => r.block === 'A5');
  assert.deepEqual(app.blockSteps(a5), [
    { label: '사전청약', date: '2023-09-25', state: 'done' }, { label: '사업승인', date: '2025-11-24', state: 'done' }, { label: '본청약', date: '미정', state: 'next' },
  ]);
  const d2 = hRows.find((r) => r.block === 'D2');
  assert.equal(d2.status, '예정 지남(보도)');
  assert.deepEqual(app.blockSteps(d2).at(-1), { label: '공고', date: '2026-상반기 예정', state: 'late' });
  assert.deepEqual(app.blockSteps(hRows.find((r) => r.block === 'A9')), [
    { label: '보도', date: '2026-03-08', state: 'done' }, { label: '공고', date: '2026-하반기 예정', state: 'next' },
  ]);
  // 지금 상태 한 줄: 접수 중 → 다음 일정 → 예상 시기
  assert.deepEqual(app.townHeadline(galmae, [], '2026-11-10', '2026-11'), { tone: 'live', label: '지금 접수 중', text: 'B-1 1순위 오늘, 당첨 발표 11-17' });
  const cal = [{ date: '2026-11-17', projectId: 'town-g', block: 'B-1', label: '당첨자 발표', rental: false }];
  assert.deepEqual(app.townHeadline(galmae, cal, '2026-11-13', '2026-11'), { tone: 'win', label: '다음 일정', text: 'B-1 당첨자 발표 11-17' });
  assert.deepEqual(app.townHeadline(gyosan, [], '2026-11-10', '2026-11'), { tone: 'plan', label: '다음 블록 예상', text: '2026-11~2026-12' });
});

test('deep links: #t=<town>&b=<block>, routes and links', () => {
  assert.deepEqual(app.parseHash('#t=town-g&b=B-1'), { id: null, district: null, town: 'town-g', block: 'B-1' });
  assert.deepEqual(app.parseHash('#b=B-1'), { id: null, district: null, town: null, block: null }); // 지구 없는 블록은 버린다
  assert.deepEqual(app.parseHash('#gu=%EC%A4%91%EA%B5%AC&t=town-g&b=A-1%20%EC%9E%84%EB%8C%80'), { id: null, district: '중구', town: 'town-g', block: 'A-1 임대' });
  assert.equal(app.hashFor({ town: 'town-g', block: 'B-1' }), '#t=town-g&b=B-1');
  assert.equal(app.hashFor({ block: 'B-1' }), '');
  const s = { id: null, district: '중구', town: 'town-g', block: app.WHOLE_TOWN };
  assert.deepEqual(app.parseHash(app.hashFor(s)), s);
  assert.equal(app.isStateHash('#t=town-g'), true);
  assert.equal(app.isStateHash('#feed-title'), false);
  const isTown = (id) => id === 'town-g';
  assert.deepEqual(app.routeOf(app.parseHash('#t=town-g&b=B-1'), isTown), { kind: 'town', id: 'town-g', block: 'B-1' });
  assert.deepEqual(app.routeOf(app.parseHash('#p=town-g'), isTown), { kind: 'town', id: 'town-g', block: null });
  assert.deepEqual(app.routeOf(app.parseHash('#t=town-topyeong'), isTown), { kind: 'project', id: 'town-topyeong' });
  assert.deepEqual(app.routeOf(app.parseHash('#gu=%EC%A4%91%EA%B5%AC&p=seoul-1'), isTown), { kind: 'project', id: 'seoul-1' });
  assert.deepEqual(app.routeOf(app.parseHash('#gu=%EC%A4%91%EA%B5%AC'), isTown), { kind: 'main' });
  assert.equal(app.linkFor(galmae, { block: 'B-1' }), '#t=town-g&b=B-1');
  assert.equal(app.linkFor({ id: 'seoul-1', kind: '재개발' }, { block: 'B-1', district: '중구' }), '#gu=%EC%A4%91%EA%B5%AC&p=seoul-1');
});

test('watchlist: untracked towns carry no project, tracked ones keep their id', () => {
  assert.deepEqual(app.cleanWatchlist([
    { name: '남양주왕숙', kind: '3기 신도시', region: '경기', tracked: false, projectId: 'x' },
    { name: '하남교산', kind: '3기 신도시', region: '경기', tracked: true, projectId: 'town-hanam-gyosan' },
    { name: ' ', tracked: true },
    'bad',
  ]), [
    { name: '남양주왕숙', kind: '3기 신도시', region: '경기', tracked: false, projectId: null },
    { name: '하남교산', kind: '3기 신도시', region: '경기', tracked: true, projectId: 'town-hanam-gyosan' },
  ]);
});

test('sample-projects.json follows the new data contract', () => {
  const sample = JSON.parse(readFileSync(new URL('../site/sample-projects.json', import.meta.url), 'utf8'));
  const st = app.parseStamp(sample.generatedAt);
  assert.ok(st?.time, 'generatedAt has a time');
  assert.match(sample.generatedAt, /\+09:00$/);
  const ids = new Set(sample.projects.map((p) => p.id));
  // 서울은 가짜 '예시' 이름만, 지구는 실제 세 곳
  for (const p of sample.projects.filter((x) => x.region === '서울')) assert.match(p.name, /^예시 /, p.name);
  assert.deepEqual(sample.projects.filter((x) => x.region !== '서울').map((p) => p.id).sort(), ['town-guri-galmae-station', 'town-guri-topyeong-hangang', 'town-hanam-gyosan']);
  for (const p of sample.projects) {
    for (const n of p.notices ?? []) {
      assert.ok(Array.isArray(n.stages), `${p.id} notice stages`);
      assert.ok(n.winnerDate === null || app.isYmd(n.winnerDate));
    }
  }
  const feed = app.cleanFeed(sample.feed);
  assert.equal(feed.length, sample.feed.length, 'every feed item is valid');
  for (const f of sample.feed) assert.ok(f.projectId === null || ids.has(f.projectId), f.id);
  assert.deepEqual(sample.feed.map((f) => f.date), [...sample.feed.map((f) => f.date)].sort().reverse(), 'newest first');
  const cal = app.cleanCalendar(sample.calendar);
  assert.equal(cal.length, sample.calendar.length);
  const last = app.addDays(st.date, 44);
  for (const e of sample.calendar) {
    assert.ok(e.date >= st.date && e.date <= last, e.date);
    assert.ok(['1순위', '2순위', '특별공급', '접수', '당첨자 발표'].includes(e.label), e.label);
  }
  assert.deepEqual(sample.calendar.map((e) => e.date), [...sample.calendar.map((e) => e.date)].sort());
  assert.ok(Array.isArray(sample.changes.items));
  const watch = app.cleanWatchlist(sample.watchlist);
  assert.equal(watch.length, 8);
  for (const w of watch.filter((x) => x.tracked)) assert.ok(ids.has(w.projectId), w.name);
  assert.ok(watch.some((w) => !w.tracked));
});

test('index.html: Google Fonts allowed by the CSP and nothing else external', () => {
  const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /style-src 'self' https:\/\/fonts\.googleapis\.com;/);
  assert.match(csp, /font-src https:\/\/fonts\.gstatic\.com;/);
  assert.match(csp, /script-src 'self';/);
  assert.ok(html.includes('family=IBM+Plex+Sans+KR:wght@400;500;700'));
  const css = readFileSync(new URL('../site/style.css', import.meta.url), 'utf8');
  for (const token of ['--sheet', '--paper', '--ink', '--muted', '--rule', '--grid', '--survey', '--survey-soft', '--bound', '--bound-soft', '--zone', '--zone-soft', '--green', '--green-soft']) {
    assert.ok(css.includes(`${token}: `), token);
  }
  // 앱 코드는 HTML 문자열을 넣지 않는다(textContent 만)
  assert.equal(/\.(innerHTML|outerHTML)\s*\+?=|insertAdjacentHTML\(|document\.write\(/.test(readFileSync(new URL('../site/app.js', import.meta.url), 'utf8')), false);
});

test('noticeBlock reads block names with the pipeline parseBlock rule', async () => {
  const { parseBlock } = await import('../src/pipeline/feed.js');
  const names = [
    '구리갈매역세권 B-1블록 신안인스빌 디센트', '하남교산 A2 푸르지오', 'A-4BL 공공분양', '교산 푸르지오 더 퍼스트(하남교산 A-2BL)',
    '구리갈매역세권 A-1블록 행복주택', '중화역 라온프라이빗 센트로', 'e편한세상 84A', 'S-1블록', '', null,
  ];
  for (const name of names) assert.equal(app.noticeBlock(name), parseBlock(name), String(name));
  assert.equal(app.noticeBlock('하남교산 A2 푸르지오'), 'A2');
  assert.equal(app.noticeBlock('A-4BL 공공분양'), 'A-4');
});

test('one rental rule: isRentalNotice matches the pipeline and saleHistory uses it', async () => {
  const pipe = await import('../src/pipeline/expected-window.js');
  const notices = [
    { name: '구리갈매역세권 A-1블록 행복주택', typeLabel: 'APT' },
    { name: '구리갈매역세권 A-4블록 6년 분양전환공공임대주택(본청약)', typeLabel: 'APT' },
    { name: '어떤 단지', typeLabel: '공공지원민간임대' },
    { name: '어떤 단지', typeLabel: '민간임대' },
    { name: '교산 푸르지오 더 퍼스트', typeLabel: 'APT' },
  ];
  for (const n of notices) assert.equal(app.isRentalNotice(n), pipe.isRentalNotice(n), n.name);
  const rows = app.saleHistory({ notices: notices.map((n, i) => ({ ...n, announceDate: `2026-0${i + 1}-01` })) });
  assert.deepEqual(rows.map((r) => r.rental), [false, true, true, true, true]);
});

test('footer says fonts come from Google Fonts and that reading marks stay in this browser', () => {
  const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('글꼴은 Google Fonts에서 불러옵니다.'));
  assert.ok(html.includes('읽은 소식 표시는 이 브라우저에만 남습니다'));
});

// --- 관련 소식 ---
const newsPipeline = await import('../src/pipeline/news.js');

test('ymdDaysBefore counts calendar days across months and years', () => {
  assert.equal(app.ymdDaysBefore('2026-11-10', 21), '2026-10-20');
  assert.equal(app.ymdDaysBefore('2026-01-05', 14), '2025-12-22');
  assert.equal(app.ymdDaysBefore('2026-03-01', 1), '2026-02-28');
  assert.equal(app.ymdDaysBefore('2026-11', 1), null);
  assert.equal(app.ymdDaysBefore(null, 1), null);
});

test('newsItems keeps safe, dated, recent items newest first, at most 5', () => {
  const day = '2026-11-10';
  const n = (extra) => ({ title: '하남교산 본청약', outlet: '뉴시스', date: '2026-11-09', url: 'https://www.newsis.com/1', ...extra });
  assert.deepEqual(app.newsItems({}, day), []);
  assert.deepEqual(app.newsItems({ news: 'x' }, day), []);
  assert.deepEqual(app.newsItems(null, day), []);
  const project = {
    news: [
      n({ url: 'https://a.com/old', date: '2026-10-19' }), // 22일 전: 숨김
      n({ url: 'https://a.com/edge', date: '2026-10-20' }), // 21일 전: 보임
      n({ url: 'javascript:alert(1)' }),
      n({ url: 'https://a.com/no-title', title: '  ' }),
      n({ url: 'https://a.com/no-date', date: null }),
      n({ url: 'https://a.com/future', date: '2026-11-11' }),
      n({ url: 'https://a.com/1', date: '2026-11-01', outlet: null }),
      n({ url: 'https://a.com/2', date: '2026-11-10' }),
      n({ url: 'https://a.com/3', date: '2026-11-05' }),
      n({ url: 'https://a.com/4', date: '2026-11-03' }),
      n({ url: 'https://a.com/5', date: '2026-11-02' }),
      null,
      ['https://a.com/array'],
    ],
  };
  const items = app.newsItems(project, day);
  assert.deepEqual(items.map((x) => x.url), ['https://a.com/2', 'https://a.com/3', 'https://a.com/4', 'https://a.com/5', 'https://a.com/1']);
  assert.equal(items.length, app.NEWS_LIMIT);
  assert.deepEqual(Object.keys(items[0]).sort(), ['date', 'outlet', 'title', 'url']);
  assert.equal(items.at(-1).outlet, null);
  assert.deepEqual(app.newsItems({ news: project.news.slice(0, 2) }, day).map((x) => x.url), ['https://a.com/edge']);
  assert.deepEqual(app.newsItems(project, ''), []);
});

test('news display limits match the pipeline and the note says 2 weeks', () => {
  assert.equal(app.NEWS_SHOW_DAYS, newsPipeline.NEWS_MAX_AGE_DAYS);
  assert.equal(newsPipeline.NEWS_PUBLISH_DAYS, 14);
  assert.match(app.NEWS_NOTE, /최근 2주/);
  assert.match(app.NEWS_NOTE, /출처: 각 언론사$/);
  assert.equal(app.NEWS_CREDIT, '검색: NAVER');
  assert.equal(app.newsMetaText({ outlet: '뉴시스', date: '2026-11-09' }), '뉴시스 · 2026-11-09');
  assert.equal(app.newsMetaText({ outlet: null, date: '2026-11-09' }), '2026-11-09');
  assert.equal(app.newsMetaText({}), '');
});

// --- 두 뉴스 출처(손으로 고른 기사 + 네이버 관련 소식) ------------------------------------

test('Naver feed items keep their provider, hide after 21 days, and count toward 소식 N with curated news', () => {
  const naver = (id, date, extra = {}) => ({
    id, date, kind: '뉴스', projectId: 'seoul-1', block: null, title: `기사 ${id}`, source: { title: '뉴시스', url: `https://www.newsis.com/${id}`, date, provider: 'naver' }, ...extra,
  });
  const feed = app.cleanFeed([
    naver('n-edge', '2026-10-20'), // 21일 전: 보임
    naver('n-old', '2026-10-19'), // 22일 전: 숨김
    naver('n-future', '2026-11-11'),
    naver('n-new', '2026-11-09'),
    naver('n-fake', '2026-11-09', { source: { title: 'x', url: 'https://a.com/1', provider: 'other' } }),
    {
      id: 'c1', date: '2025-01-01', kind: '뉴스', projectId: 'seoul-1', title: '오래된 우리 요약', source: { title: '스트레이트뉴스', url: 'https://a.com/c1' },
    },
    {
      id: 'g1', date: '2026-11-01', kind: '공고', projectId: 'seoul-1', title: '청약홈 공고: x', source: { title: '청약홈', url: 'https://a.com/g1' },
    },
  ]);
  assert.equal(app.NAVER_PROVIDER, 'naver');
  assert.equal(feed.find((f) => f.id === 'n-new').source.provider, 'naver');
  assert.equal(feed.find((f) => f.id === 'n-fake').source.provider, null);
  assert.equal(app.isNaverItem(feed.find((f) => f.id === 'n-new')), true);
  assert.equal(app.isNaverItem(feed.find((f) => f.id === 'c1')), false);
  const visible = app.visibleFeed(feed, '2026-11-10');
  // 네이버 기사만 기간으로 거른다. 손으로 고른 오래된 기사와 공고는 그대로
  assert.deepEqual(visible.map((f) => f.id), ['n-new', 'n-fake', 'g1', 'n-edge', 'c1']);
  assert.deepEqual(app.visibleFeed(feed, '').filter(app.isNaverItem), []);
  assert.deepEqual(app.visibleFeed(undefined, '2026-11-10'), []);
  assert.equal(app.projectNewsCount(visible, 'seoul-1'), 4);
  assert.equal(app.projectNewsCount(visible, 'seoul-2'), 0);
  assert.equal(app.projectNewsCount(null, 'seoul-1'), 0);
});

test('Naver items show outlet/date and the 검색: NAVER credit; footer says news titles come from Naver search with links to the original', () => {
  const js = readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
  assert.ok(js.includes("h('small', { class: 'news-credit' }, NEWS_CREDIT)"));
  assert.ok(js.includes('state.feed = visibleFeed(cleanFeed(data.feed), state.today);'));
  // 블록 카드 안에 분양 성과
  assert.ok(js.includes('r.performance ? performanceBox(r.block, r.performance) : null'));
  const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('"검색: NAVER" 표시 뉴스는 네이버 뉴스 검색으로 찾은 기사의 제목·언론사·날짜만 보여 주고 원문으로 연결'));
});

test('block card latest line never shows a Naver headline without attribution', () => {
  const naver = (date, title, outlet = '뉴시스') => ({ date, kind: '뉴스', title, source: { title: outlet, url: 'https://a.com/n', provider: 'naver' } });
  const own = (date, title) => ({ date, kind: '공고', title, source: { title: '청약홈', url: 'https://a.com/o', provider: null } });
  const today = '2026-11-10';
  assert.equal(app.blockLatestText([], today), '아직 모은 소식 없음');
  assert.equal(app.blockLatestText(undefined, today), '아직 모은 소식 없음');
  // 네이버가 더 최신이어도 네이버가 아닌 가장 최근 소식의 제목
  assert.equal(app.blockLatestText([naver('2026-11-09', '헤드라인'), own('2026-10-30', '청약홈 공고: B-1')], today),
    `최근 ${app.shortDate('2026-10-30', today)} 청약홈 공고: B-1`);
  // 네이버 기사뿐이면 제목 없이 언론사와 표시
  const onlyNaver = app.blockLatestText([naver('2026-11-09', '헤드라인')], today);
  assert.equal(onlyNaver, `최근 ${app.shortDate('2026-11-09', today)} 뉴시스 기사 (검색: NAVER)`);
  assert.ok(!onlyNaver.includes('헤드라인'));
  assert.equal(app.blockLatestText([naver('2026-11-09', '헤드라인', null)], today), `최근 ${app.shortDate('2026-11-09', today)} 기사 (검색: NAVER)`);
});

test('town header basis reads "다음 블록 예상 근거 · 규칙: …" without doubling the label', () => {
  const town = { windowLabel: '다음 블록 예상', windowBasis: '규칙: 접수 중인 공고(마감 2026-11-11) 뒤 0~2년' };
  assert.equal(app.windowBasisNote(town), '다음 블록 예상 근거 · 규칙: 접수 중인 공고(마감 2026-11-11) 뒤 0~2년');
  assert.equal(app.windowBasisNote({ windowBasis: '사업시행인가 뒤 2~4년' }), '예상 청약 근거 · 사업시행인가 뒤 2~4년');
  assert.equal(app.windowBasisNote({ windowBasis: ' ' }), null);
  assert.equal(app.windowBasisNote(null), null);
  const sample = JSON.parse(readFileSync(new URL('../site/sample-projects.json', import.meta.url), 'utf8'));
  for (const p of sample.projects) assert.ok(!String(p.windowBasis ?? '').startsWith(String(p.windowLabel ?? '-')), p.id);
});

test('sellingTowns: 블록별 분양 지구와 접수 중·14일 안 접수 공고가 있는 지구만, 접수 중 먼저 그다음 다음 블록 예상 순', () => {
  const day = '2026-11-11';
  const stage = (name, start, end = start) => ({ name, start, end });
  const town = (id, extra) => ({ id, name: id, kind: '공공주택지구', region: '경기', notices: [], ...extra });
  const gyosan = town('하남교산', { stage: '블록별 분양', ...win('2026-12') });
  const wangsuk = town('남양주왕숙', { stage: '블록별 분양', ...win('2026-11') });
  const gyeyang = town('인천계양', { region: '인천', stage: '블록별 분양', window: { from: null, to: null } });
  const galmae = town('구리갈매역세권', {
    stage: '블록별 분양', ...win('2027-03'),
    notices: [{ key: 'b1', name: '구리갈매역세권 신안인스빌 디센트', end: '2026-11-11', stages: [stage('특별공급', '2026-11-09'), stage('1순위', '2026-11-10'), stage('2순위', '2026-11-11')] }],
  });
  const topyeong = town('구리토평한강', { stage: '지구지정', ...win('2029-01') });
  // 지구계획승인 단계라도 접수 중인 공고가 이어져 있으면 넣는다
  const gm = town('광명시흥', {
    stage: '지구계획승인', ...win('2029-01'),
    notices: [{ key: 'g1', name: '광명시흥 S1-10BL', end: '2026-11-13', stages: [stage('1순위', '2026-11-11', '2026-11-12'), stage('당첨자 발표', '2026-11-20')] }],
  });
  // 접수가 15일 뒤에 시작하면 넣지 않는다(14일 안만)
  const later = town('먼곳', {
    stage: '지구계획승인', ...win('2029-01'),
    notices: [{ key: 'l1', name: '먼곳 A1', end: '2026-11-27', stages: [stage('1순위', '2026-11-26', '2026-11-27')] }],
  });
  // 14일 안에 접수가 시작하면 넣는다(접수 중은 아니라 예상 순서에 섞인다)
  const soon = town('곧', {
    stage: '지구지정', ...win('2028-01'),
    notices: [{ key: 's1', name: '곧 A1', end: '2026-11-25', stages: [stage('1순위', '2026-11-25')] }],
  });
  const seoul = { id: 's', name: '신영1', kind: '재개발', region: '서울', stage: '이주', notices: [] };
  const names = app.sellingTowns([topyeong, gyosan, seoul, later, gyeyang, gm, soon, wangsuk, galmae], day).map((p) => p.name);
  // 접수 중 두 곳(갈매 2027-03, 광명시흥 2029-01)은 예상 시기 순, 그 뒤는 예상 시기 순(없으면 맨 뒤)
  assert.deepEqual(names, ['구리갈매역세권', '광명시흥', '남양주왕숙', '하남교산', '곧', '인천계양']);
  assert.ok(!names.includes('구리토평한강'));
  assert.deepEqual(app.sellingTowns([topyeong, seoul], day), []);
  assert.deepEqual(app.sellingTowns(undefined, day), []);

  assert.equal(app.noticeReception(galmae.notices[0], day), 'open');
  assert.equal(app.noticeReception(galmae.notices[0], '2026-11-12'), null);
  assert.equal(app.noticeReception(soon.notices[0], day), 'soon');
  assert.equal(app.noticeReception(later.notices[0], day), null);
  // 접수 단계가 없으면 공고일~마감일
  assert.equal(app.noticeReception({ announceDate: '2026-11-01', end: '2026-11-12' }, day), 'open');
  assert.equal(app.noticeReception({ announceDate: '2026-11-01', end: '2026-11-10' }, day), null);
});

test('isTownView: 블록별 분양 지구와 출처 있는 블록이 있는 공공주택지구', () => {
  assert.equal(app.isTownView({ kind: '공공주택지구', stage: '블록별 분양', blocks: [] }), true);
  assert.equal(app.isTownView({ kind: '공공주택지구', stage: '지구계획승인', blocks: [{ block: 'S1-10' }] }), true);
  assert.equal(app.isTownView({ kind: '공공주택지구', stage: '지구지정', blocks: [] }), false);
  assert.equal(app.isTownView({ kind: '재개발', stage: '이주', blocks: [{ block: 'A1' }] }), false);
  assert.equal(app.isTownView(null), false);
});

test('index.html: 블록별로 분양 중인 신도시 section stays', () => {
  const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('<h2 id="towns-title" tabindex="-1">블록별로 분양 중인 신도시</h2>'));
  assert.ok(readFileSync(new URL('../site/app.js', import.meta.url), 'utf8').includes('지금 블록별로 분양 중인 신도시가 없습니다.'));
});

test('briefView: picks headline, bold spans, in-range footnotes and safe links; bad input is null', () => {
  const brief = {
    headline: ' 하남교산, 다음 차례는 A9·A11 공공분양 ',
    paras: [
      [{ t: '최근 본청약은 ' }, { t: 'A2', b: true }, { t: '입니다.' }, { t: '1', note: true }, { t: '9', note: true }, { t: '' }, 'x', null],
      [{ t: '2', note: true }], // 각주만 있는 문단은 버린다
      [{ t: '다음은 ' }, { t: 'A9', b: true }, { t: '2', note: true }],
    ],
    foot: [
      { label: '뉴시스 2025-05-09', url: 'https://mobile.newsis.com/view/1' },
      { label: '악성', url: 'javascript:alert(1)' },
      { label: '', url: 'https://x.example' },
    ],
    basis: '신도시 목록에 출처와 함께 적은 블록·계획·보도로 작성했습니다.',
  };
  const v = app.briefView(brief, '2026-11-11T07:30:00+09:00');
  assert.equal(v.eyebrow, '지역 브리핑 · 2026-11-11');
  assert.equal(v.headline, '하남교산, 다음 차례는 A9·A11 공공분양');
  assert.deepEqual(v.paras, [
    [{ text: '최근 본청약은 ', bold: false, note: false }, { text: 'A2', bold: true, note: false }, { text: '입니다.', bold: false, note: false }, { text: '1', bold: false, note: true }],
    [{ text: '다음은 ', bold: false, note: false }, { text: 'A9', bold: true, note: false }, { text: '2', bold: false, note: true }],
  ]);
  assert.deepEqual(v.foot, [{ n: 1, label: '뉴시스 2025-05-09', url: 'https://mobile.newsis.com/view/1' }, { n: 2, label: '악성', url: null }]);
  assert.equal(v.basis, '신도시 목록에 출처와 함께 적은 블록·계획·보도로 작성했습니다.');
  assert.equal(app.briefView({ ...brief, basis: 3 }, null).eyebrow, '지역 브리핑');
  assert.equal(app.briefView({ ...brief, basis: 3 }, null).basis, null);
  assert.equal(app.briefView(null, null), null);
  assert.equal(app.briefView({ headline: '  ' }, null), null);
  assert.deepEqual(app.briefView({ headline: '중구' }, '2026-11-11').paras, []);
});

test('app.js: watchlist cells select a town brief instead of navigating, and the brief uses textContent only', () => {
  const src = readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
  assert.ok(src.includes("'data-watch-town': w.name"));
  assert.ok(src.includes("h('article', { class: 'brief', 'aria-label': '지역 브리핑' }"));
  assert.ok(!/innerHTML\s*=/.test(src));
});

test('sellingTowns ignores rental notices (행복주택 등) for selling and for the open-first order', () => {
  const day = '2026-11-11';
  const rentOpen = { key: 'r', name: '구리갈매역세권 A-1BL 신혼희망타운 행복주택', typeLabel: 'APT', end: '2026-11-12', stages: [{ name: '접수', start: '2026-11-10', end: '2026-11-12' }] };
  const early = { id: 'e', name: '광명시흥', kind: '공공주택지구', stage: '지구계획승인', notices: [rentOpen], window: { from: '2029-01', to: '2029-12' } };
  const a = { id: 'a', name: '가', kind: '공공주택지구', stage: '블록별 분양', notices: [rentOpen], window: { from: '2027-03', to: '2027-03' } };
  const b = { id: 'b', name: '나', kind: '공공주택지구', stage: '블록별 분양', notices: [], window: { from: '2026-12', to: '2026-12' } };
  assert.deepEqual(app.sellingTowns([early, a, b], day).map((p) => p.id), ['b', 'a']);
});

// --- 머리말(시안 C) ---
test('nextCollection / stampLine: next of 07:00 and 19:00 KST', () => {
  const at = (iso) => new Date(iso);
  assert.deepEqual(app.nextCollection(at('2026-11-10T21:59:00Z')), { date: '2026-11-11', time: '07:00' }); // KST 11-11 06:59
  assert.deepEqual(app.nextCollection(at('2026-11-10T22:00:00Z')), { date: '2026-11-11', time: '19:00' }); // KST 07:00 정각이면 다음
  assert.deepEqual(app.nextCollection(at('2026-11-11T09:59:00Z')), { date: '2026-11-11', time: '19:00' }); // KST 18:59
  assert.deepEqual(app.nextCollection(at('2026-11-11T10:00:00Z')), { date: '2026-11-12', time: '07:00' }); // KST 19:00
  assert.deepEqual(app.nextCollection(at('2026-12-31T14:30:00Z')), { date: '2027-01-01', time: '07:00' }); // KST 23:30, 해 넘김
  assert.equal(app.stampLine('2026-11-11T07:02:10+09:00', at('2026-11-11T01:00:00Z')), '11-11 07:02 수집, 다음 19:00');
  assert.equal(app.stampLine('2026-11-10', at('2026-11-11T01:00:00Z')), '2026-11-10 수집, 다음 19:00');
  assert.equal(app.stampLine(null), '수집 시각 정보 없음');
});

test('unseenCount counts NEW items against the visit baseline', () => {
  const feed = [{ id: 'a', date: '2026-11-10' }, { id: 'b', date: '2026-11-09' }, { id: 'c', date: '2026-11-01' }];
  assert.equal(app.unseenCount(feed, { ids: new Set(['a']), since: null }), 2);
  assert.equal(app.unseenCount(feed, { ids: null, since: '2026-11-09' }), 2);
  assert.equal(app.unseenCount(feed, { ids: new Set(['a', 'b', 'c']) }), 0);
  assert.equal(app.unseenCount(undefined, { ids: new Set() }), 0);
});

const searchFixture = () => {
  const gyosan = {
    id: 'town-hanam-gyosan', name: '하남교산', kind: '공공주택지구', region: '경기', district: '하남시', stage: '블록별 분양',
    windowLabel: '다음 블록 예상', ...win('2026-11', '2026-12'),
    history: [{ block: 'A2', stage: '본청약', title: '교산 푸르지오 더 퍼스트', rental: false, noticeDate: '2025-03-31' }],
    blocks: [
      { block: 'A2', type: '공공분양', status: '본청약 공고', statusDate: '2025-03-31', sources: [] },
      { block: 'A20', type: '통합공공임대', rental: true, status: '다음 예정(보도)', sources: [] },
      { block: 'A9', type: '공공분양', status: '다음 예정(보도)', sources: [] },
    ],
  };
  const gyeyang = {
    id: 'town-incheon-gyeyang', name: '인천계양', kind: '공공주택지구', region: '인천', district: '계양구', stage: '블록별 분양', ...win('2027-01', '2027-06'),
    history: [], blocks: [{ block: 'A-2', type: '공공분양', status: '본청약 공고', statusDate: '2024-09-30', sources: [] }],
  };
  const topyeong = { id: 'town-topyeong', name: '구리토평한강', kind: '공공주택지구', region: '경기', district: '구리시', stage: '지구지정', ...win('2028-12', '2030-12'), blocks: [] };
  const seoul = [
    { id: 'seoul-1', name: '대치우성1차', kind: '재건축', region: '서울', district: '강남구', address: '대치동 63', stage: '사업시행인가', ...win('2026-09') },
    { id: 'seoul-2', name: '중화3', kind: '재개발', region: '서울', district: '중랑구', address: '중화동 4-30', stage: '착공', ...win('2026-01') },
    { id: 'seoul-3', name: '일원개포한신', kind: '재건축', region: '서울', district: '강남구', address: '일원동 615-1', stage: '이주', ...win('2026-04') },
  ];
  const feed = [
    { id: 'f1', kind: '뉴스', projectId: 'town-hanam-gyosan', block: 'A5', date: '2026-07-24', title: 'A5 사전청약 당첨자 대출 조건 갈등', source: { title: '서울신문', url: 'https://a.example/1', provider: null } },
    { id: 'f2', kind: '뉴스', projectId: 'town-hanam-gyosan', block: null, date: '2026-11-09', title: '하남교산 기사 헤드라인', source: { title: '뉴시스', url: 'https://a.example/2', provider: 'naver' } },
    { id: 'f3', kind: '공고', projectId: 'seoul-2', block: null, date: '2026-11-06', title: '청약홈 공고: 중화역 라온프라이빗 센트로', source: { title: '청약홈', url: 'https://a.example/3', provider: null } },
    { id: 'f4', kind: '단계', projectId: 'seoul-1', block: null, date: '2026-11-10', title: '단계 변경: 조합설립 → 사업시행인가', source: { title: '서울시', url: null, provider: null } },
  ];
  return { projects: [gyosan, gyeyang, topyeong, ...seoul], feed };
};

test('search: towns, blocks, Seoul projects and non-Naver news, grouped and capped', () => {
  const { projects, feed } = searchFixture();
  const index = app.buildSearchIndex(projects, feed, { today: '2026-11-11', todayYm: '2026-11' });
  const find = (q) => app.searchAll(index, q).map((e) => `${e.group}:${e.label}`);

  // '교산': 신도시 → 블록 → 소식 순. 네이버 기사는 넣지 않는다
  assert.deepEqual(find('교산'), [
    '신도시:하남교산', '블록:하남교산 A2 교산 푸르지오 더 퍼스트', '블록:하남교산 A9 공공분양', '블록:하남교산 A20 임대 통합공공임대',
    '소식:A5 사전청약 당첨자 대출 조건 갈등',
  ]);
  assert.deepEqual(find('헤드라인'), []);
  // 공백·대소문자 무시, 구 이름으로 서울 사업
  assert.deepEqual(find('강남'), ['사업:강남 대치우성1차', '사업:강남 일원개포한신']);
  // 이름에 '강남'이 든 다른 구 사업보다 강남구 사업이 먼저
  const withOther = app.buildSearchIndex([{ id: 'x', name: '강남원효성빌라', kind: '재건축', region: '서울', district: '서초구', stage: '조합설립', ...win('2030-01') }, ...projects], feed, { today: '2026-11-11', todayYm: '2026-11' });
  assert.deepEqual(app.searchAll(withOther, '강남').map((e) => e.label), ['강남 대치우성1차', '강남 일원개포한신', '서초 강남원효성빌라']);
  assert.deepEqual(find('강 남 구'), find('강남'));
  assert.deepEqual(find('일원동'), ['사업:강남 일원개포한신']);
  // 블록 이름: 'A2'와 'A-2'는 같고, 딱 맞는 블록이 'A20'보다 먼저
  assert.deepEqual(find('a2').slice(0, 3), ['블록:하남교산 A2 교산 푸르지오 더 퍼스트', '블록:인천계양 A-2 공공분양', '블록:하남교산 A20 임대 통합공공임대']);
  assert.deepEqual(find('A-2'), find('A2'));
  // 공고 소식도(사업 이름으로)
  assert.deepEqual(find('중화'), ['사업:중랑 중화3', '소식:청약홈 공고: 중화역 라온프라이빗 센트로']);
  // 단계 소식은 넣지 않는다
  assert.ok(!find('사업시행인가').some((x) => x.startsWith('소식:')));
  assert.deepEqual(find('   '), []);
  // 주소: 블록은 '&b=', 지구 화면이 아닌 지구는 '#p='
  const hits = app.searchAll(index, '교산');
  assert.equal(hits[0].href, '#t=town-hanam-gyosan');
  assert.equal(hits[1].href, '#t=town-hanam-gyosan&b=A2');
  assert.equal(hits.at(-1).href, '#t=town-hanam-gyosan&b=A5');
  assert.equal(app.searchAll(index, '토평')[0].href, '#p=town-topyeong');
  assert.equal(app.searchAll(index, '중화')[1].href, '#p=seoul-2');
  assert.match(hits[0].meta, /^다음 블록 예상 /);
});

test('search: at most 8 results, filling free slots group by group', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, name: `강남테스트${i}`, kind: '재건축', region: '서울', district: '강남구', stage: '이주', ...win('2027-01') }));
  const index = app.buildSearchIndex(many, [], { today: '2026-11-11', todayYm: '2026-11' });
  const hits = app.searchAll(index, '강남');
  assert.equal(hits.length, app.SEARCH_MAX);
  assert.ok(hits.every((e) => e.group === '사업'));
  assert.equal(app.searchAll(index, '강남', 3).length, 3);
  assert.equal(app.searchKey(' A-2 블록 '), 'a2블록');
  assert.equal(app.searchKey('세운3-8'), '세운3-8');
});

test('index.html header C: logo mark, combobox search, bell, refresh, theme menu, nav, phone menu sheet', () => {
  const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('id="q" role="combobox" aria-expanded="false" aria-controls="search-results"'));
  assert.ok(html.includes('id="search-results" role="listbox"'));
  assert.ok(html.includes('id="bell" href="#feed-title" data-jump="feed-title"'));
  assert.ok(html.includes('id="theme-btn" aria-label="화면 테마" aria-haspopup="dialog" aria-expanded="false" aria-controls="theme"'));
  assert.ok(html.includes('id="menu-sheet" role="dialog" aria-modal="true"'));
  for (const label of ['한눈에', '새 소식', '지역 현황', '신도시 블록', '서울 정비사업', '청약 일정']) {
    assert.equal((html.match(new RegExp(`data-jump="[a-z-]+">${label}</a>`, 'g')) ?? []).length, 2, label); // 머리말 메뉴와 휴대폰 메뉴
  }
  for (const id of ['dashboard', 'feed-title', 'region-box', 'towns-title', 'seoul-title', 'cal-box']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes('id="nav-live"') && html.includes('class="brand-mark"'));
  // 예전 제목 줄은 없다
  assert.ok(!html.includes('class="top-main"') && !html.includes('class="sub"'));
});

// --- 검토 반영(머리말·검색) ---
test('isComposingKey: IME composition keys are ignored by the search shortcuts', () => {
  assert.equal(app.isComposingKey({ key: 'Enter', isComposing: true }), true);
  assert.equal(app.isComposingKey({ key: 'Process', keyCode: 229 }), true);
  assert.equal(app.isComposingKey({ key: 'Enter', isComposing: false, keyCode: 13 }), false);
  assert.equal(app.isComposingKey(undefined), false);
  assert.ok(app.SEARCH_ANNOUNCE_MS >= 300);
  const js = readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
  // 검색창 keydown 의 첫 줄이 조합 중 키를 거른다
  assert.match(js, /input\.addEventListener\('keydown', \(e\) => \{\s*\/\/[^\n]*\n\s*if \(isComposingKey\(e\)\) return;/);
});

test('titleHasBlock (site) and search block labels never repeat the block or town name', () => {
  assert.equal(app.titleHasBlock('남양주왕숙 A-01', 'A-1'), true);
  assert.equal(app.titleHasBlock('남양주왕숙2 A03', 'A-3'), true);
  assert.equal(app.titleHasBlock('계양신도시 카이브 유보라(AC4BL)', 'AC4'), true);
  assert.equal(app.titleHasBlock('교산 푸르지오 더 퍼스트', 'A2'), false);
  assert.equal(app.titleHasBlock('남양주왕숙2 A-13', 'A-3'), false);
  const town = {
    id: 'town-w', name: '남양주왕숙', kind: '공공주택지구', region: '경기', district: '남양주시', stage: '블록별 분양', ...win('2026-11'),
    history: [
      { block: 'A-1', stage: '본청약', title: '남양주왕숙 A-01', rental: false, noticeDate: '2025-07-24' },
      { block: 'B-1', stage: '본청약', title: '왕숙 푸르지오 더 퍼스트 1단지', rental: false, noticeDate: '2025-07-29' },
      { block: 'B-17', stage: '본청약', title: '남양주왕숙 B-17블록 공공분양', rental: false, noticeDate: '2025-11-27' },
    ],
    blocks: [
      { block: 'A-1', type: '공공분양', status: '본청약 공고', sources: [] },
      { block: 'B-1', type: '민간참여 공공분양', status: '본청약 공고', sources: [] },
      { block: 'B-17', type: '공공분양', status: '본청약 공고', sources: [] },
    ],
  };
  const labels = app.buildSearchIndex([town], [], { today: '2026-11-11', todayYm: '2026-11' }).filter((e) => e.group === '블록').map((e) => e.label);
  assert.deepEqual(labels.sort(), ['남양주왕숙 A-1 공공분양', '남양주왕숙 B-1 왕숙 푸르지오 더 퍼스트 1단지', '남양주왕숙 B-17 공공분양'].sort());
});

test('searchAll keeps a slot for every group with hits, within SEARCH_MAX (구, A-1)', () => {
  const town = (id, name, district, blocks) => ({
    id, name, kind: '공공주택지구', region: '경기', district, stage: '블록별 분양', ...win('2026-12'), history: [],
    blocks: blocks.map((block) => ({ block, type: '공공분양', status: '본청약 공고', sources: [] })),
  });
  const projects = [
    town('t1', '구리갈매역세권', '구리시', ['A-1', 'A-2', 'A-3', 'A-4', 'B-1', 'S-1']),
    town('t2', '구리토평한강', '구리시', []),
    town('t3', '남양주왕숙', '남양주시', ['A-1', 'A-2']),
    ...Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, name: `구역${i}`, kind: '재개발', region: '서울', district: '종로구', stage: '조합설립', ...win('2030-01') })),
  ];
  const feed = [
    { id: 'f1', kind: '뉴스', projectId: 't1', block: 'A-1', date: '2026-10-01', title: 'A-1 행복주택 공급 계획에 포함됐습니다.', source: { provider: null } },
    { id: 'f2', kind: '공고', projectId: 's1', block: null, date: '2026-10-02', title: '청약홈 공고: 구역1 단지', source: { provider: null } },
  ];
  const index = app.buildSearchIndex(projects, feed, { today: '2026-11-11', todayYm: '2026-11' });
  const groupsOf = (hits) => [...new Set(hits.map((e) => e.group))];
  const gu = app.searchAll(index, '구');
  assert.equal(gu.length, app.SEARCH_MAX);
  assert.deepEqual(groupsOf(gu), ['신도시', '블록', '사업', '소식']); // 뒤 묶음도 자리를 잃지 않는다
  // 묶음 순서대로 나온다
  const order = gu.map((e) => app.SEARCH_GROUPS.findIndex(([g]) => g === e.group));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  const a1 = app.searchAll(index, 'A-1');
  assert.ok(a1.length <= app.SEARCH_MAX);
  assert.deepEqual(groupsOf(a1), ['블록', '소식']);
  assert.deepEqual(a1.filter((e) => e.group === '블록').slice(0, 2).map((e) => e.label), ['구리갈매역세권 A-1 공공분양', '남양주왕숙 A-1 공공분양']);
  assert.deepEqual(app.searchAll(index, '구', 2).map((e) => e.group), ['신도시', '블록']);
});

test('liveProjectCount counts distinct projects (tile and header agree)', () => {
  const day = '2026-11-11';
  const n = (key, start, end = start) => ({ key, name: key, stages: [{ name: '1순위', start, end }] });
  const projects = [
    { id: 'a', name: '가', notices: [n('a1', '2026-11-10', '2026-11-12'), n('a2', '2026-11-11')] },
    { id: 'b', name: '나', notices: [n('b1', '2026-11-11')] },
    { id: 'c', name: '다', notices: [n('c1', '2026-11-20')] },
  ];
  assert.equal(app.receivingNow(projects, day).length, 3);
  assert.equal(app.liveProjectCount(projects, day), 2);
  const js = readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
  assert.ok(js.includes("num: liveCount, unit: '곳'"));
  assert.ok(js.includes('const live = liveProjectCount(state.projects, state.today);'));
});

test('header: overlay/sheet push a history entry and close on back; theme popup is a dialog; nav anchors work without data', () => {
  const js = readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
  assert.ok(js.includes("pushOverlay('search')") && js.includes("pushOverlay('sheet')"));
  // syncFromHash 가 두 화면을 닫는다
  assert.match(js, /function syncFromHash\(\) \{[\s\S]{0,300}closeSearch\(\{ blur: true \}\);\s*closeSheet\(\{ restore: false \}\);/);
  // 자료가 없으면 기본 링크 이동(preventDefault 전에 state.data 확인)
  assert.match(js, /if \(!target \|\| !state\.data \|\| e\.button !== 0/);
  assert.ok(js.includes("setAttribute('inert', '')") && js.includes("box.setAttribute('aria-modal', 'true')"));
  const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('id="theme" role="dialog" aria-label="화면 테마"'));
  const css = readFileSync(new URL('../site/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.linkish, \.top-nav a, \.theme-menu button \{ min-height: 44px; \}/);
});
