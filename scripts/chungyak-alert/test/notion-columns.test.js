import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from '../src/main.js';
import { createNotionStore, parseExistingPage } from '../src/notion-store.js';

const THU_NOW = '2026-11-04T22:30:00Z';
const THU = '2026-11-05';
const MON_NOW = '2026-11-01T22:30:00Z';

// 사용자가 지울 열이다. 배치는 이 이름을 어떤 요청에도 넣지 않는다.
const DROPPED = ['모집공고일', '순번'];

const page = (key, { start, end, extra = {} } = {}) => ({
  id: `id-${key}`,
  properties: {
    '고유 키': { rich_text: [{ plain_text: key }] },
    ...(start ? { '접수 시작일': { date: { start } } } : {}),
    ...(end ? { '접수 종료일': { date: { start: end } } } : {}),
    ...extra,
  },
});

const remainderRow = {
  HOUSE_MANAGE_NO: '7',
  PBLANC_NO: '7',
  HOUSE_NM: '무순위 단지',
  HOUSE_SECD: '04',
  SUBSCRPT_AREA_CODE_NM: '서울',
  HSSPLY_ADRES: '서울특별시 강남구 역삼동 1',
  RCRIT_PBLANC_DE: '2026-11-01',
  SUBSCRPT_RCEPT_BGNDE: THU,
  SUBSCRPT_RCEPT_ENDDE: THU,
  PBLANC_URL: 'https://www.applyhome.co.kr/a',
};

function apiFetch(rows) {
  return async (url) => {
    const text = String(url);
    if (text.includes('getRemndrLttotPblancDetail')) return Response.json({ totalCount: rows.length, data: rows });
    if (text.includes('api.odcloud.kr')) return Response.json({ totalCount: 0, data: [] });
    if (text.includes('apis.data.go.kr/1613000')) return new Response('<r><resultCode>000</resultCode><totalCount>0</totalCount></r>');
    return Response.json([{ dsList: [] }]);
  };
}

const MARKET_SCHEMA = { '안전 마진': { type: 'number', number: {} }, 마진율: { type: 'number', number: {} }, '시세 신뢰도': { type: 'select', select: {} }, '역 도보(분)': { type: 'number', number: {} }, '평균 분양가': { type: 'number', number: {} }, '추천 전형': { type: 'select', select: {} }, '추천 접수일': { type: 'date', date: {} } };

// 사용자가 모집공고일과 순번을 지운 뒤의 실제 DB 스키마
const WITHOUT_INTEREST = {
  ...MARKET_SCHEMA,
  주택명: { type: 'title', title: {} },
  '고유 키': { type: 'rich_text', rich_text: {} },
  유형: { type: 'select', select: {} },
  공급지역: { type: 'select', select: {} },
  주소: { type: 'rich_text', rich_text: {} },
  '접수 시작일': { type: 'date', date: {} },
  '접수 종료일': { type: 'date', date: {} },
  '특별공급 접수일': { type: 'date', date: {} },
  '1순위 접수일': { type: 'date', date: {} },
  '2순위 접수일': { type: 'date', date: {} },
  당첨자발표일: { type: 'date', date: {} },
  '최고 분양가': { type: 'number', number: {} },
  '추정 시세': { type: 'number', number: {} },
  '로또 여부': { type: 'select', select: {} },
  '판별 근거': { type: 'rich_text', rich_text: {} },
  '공고 링크': { type: 'url', url: {} },
  소스: { type: 'select', select: {} },
  '마지막 수집일': { type: 'date', date: {} },
  '긴급 알림 발송일': { type: 'date', date: {} },
};
const LIVE_SCHEMA = { ...WITHOUT_INTEREST, 관심: { type: 'checkbox', checkbox: {} } };

// 페이지와 스키마 상태를 가진 Notion 가짜. strict이면 실제 Notion처럼 DB에 없는 속성을 쓰는 요청을 400으로 거절한다.
function notionFake({ pages = [], databaseProperties = LIVE_SCHEMA, children, queryLagsArchive = false, strict = false, intercept = () => null } = {}) {
  const calls = [];
  const rejected = [];
  const state = { pages: [...pages], databaseProperties: { ...databaseProperties }, created: 0 };
  const list = children ?? [
    { id: 'db', type: 'child_database', child_database: { title: '청약 정보' } },
    { id: 'src', type: 'child_page', child_page: { title: '청약 수집 소스' } },
  ];
  // 상태 페이지 제목(title)은 DB 행이 아니라 따로 둔다.
  const unknownProperties = (properties) => Object.keys(properties ?? {}).filter((name) => name !== 'title' && !state.databaseProperties[name]);
  const fetch = async (url, init) => {
    const path = new URL(url).pathname.replace('/v1', '');
    const body = init.body ? JSON.parse(init.body) : null;
    const call = { method: init.method, path, body };
    calls.push(call);
    const replaced = intercept(call, calls);
    if (replaced) return replaced;
    const rowWrite = (init.method === 'POST' && path === '/pages' && body.parent?.database_id) || (init.method === 'PATCH' && path.startsWith('/pages/'));
    if (strict && rowWrite && unknownProperties(body.properties).length > 0) {
      rejected.push(call);
      return Response.json({ object: 'error', code: 'validation_error' }, { status: 400 });
    }
    if (init.method === 'GET' && path.startsWith('/blocks/')) return Response.json({ results: list, has_more: false });
    if (init.method === 'GET' && path.startsWith('/databases/')) return Response.json({ id: 'db', properties: state.databaseProperties });
    if (init.method === 'POST' && path === '/databases') return Response.json({ id: 'db' });
    if (init.method === 'PATCH' && path.startsWith('/databases/')) {
      for (const [name, value] of Object.entries(body.properties)) state.databaseProperties[name] = { type: Object.keys(value)[0], ...value };
      return Response.json({ id: 'db' });
    }
    if (path.endsWith('/query')) {
      // 실제 Notion처럼 archived 표시 없이 목록에 잠시 남는 경우도 재현한다.
      const results = state.pages
        .filter((item) => queryLagsArchive || !item.archived)
        .map(({ archived, ...item }) => (queryLagsArchive ? item : { ...item, archived: false }));
      return Response.json({ results, has_more: false });
    }
    if (init.method === 'POST' && path === '/pages') {
      state.created += 1;
      const content = body.properties['고유 키']?.rich_text?.[0]?.text?.content;
      const created = { id: `new-${state.created}`, properties: content ? { '고유 키': { rich_text: [{ plain_text: content }] } } : {} };
      if (content) state.pages.push(created);
      return Response.json({ id: created.id });
    }
    if (init.method === 'PATCH' && path.startsWith('/pages/')) {
      const target = state.pages.find((item) => `/pages/${item.id}` === path);
      if (target && body.archived) target.archived = true;
      return Response.json({ id: 'ok' });
    }
    return Response.json({ id: 'ok' });
  };
  return { calls, fetch, state, rejected };
}

const NOTION_CONFIG = { notion: { databaseTitle: '청약 정보', sourcesPageTitle: '청약 수집 소스' } };

function realStore(fake) {
  return createNotionStore({
    key: 'k',
    parentPageId: 'parent',
    config: NOTION_CONFIG,
    sources: [],
    fetch: fake.fetch,
    minIntervalMs: 0,
    sleep: async () => {},
  });
}

function harness(fake, { rows = [], nowIso = THU_NOW, env = {} } = {}) {
  const base = apiFetch(rows);
  const mails = [];
  const kakao = [];
  const logs = [];
  return {
    mails,
    kakao,
    logs,
    env: { DATA_GO_KR_KEY: 'SECRET-DATA-KEY', NOTION_KEY: 'SECRET-NOTION', CHUNGYAK_NOTION_PAGE_ID: 'parent', ...env },
    deps: {
      fetch: async (url, init) => (String(url).includes('api.notion.com') ? fake.fetch(url, init) : base(url)),
      accessToken: 'token',
      sleep: async () => {},
      now: () => new Date(nowIso),
      log: (line) => logs.push(line),
      write: () => {},
      sendMail: async (mail) => { mails.push(mail); },
      sendKakao: async (message) => { kakao.push(message); },
    },
  };
}

const writes = (fake) => fake.calls.filter((call) => call.method === 'PATCH' || (call.method === 'POST' && !call.path.endsWith('/query')));
const errorMail = (h) => h.mails.find((mail) => mail.subject.includes('배치 오류'));
const mentionsDropped = (fake) => fake.calls.filter((call) => DROPPED.some((name) => decodeURIComponent(call.path).includes(name) || JSON.stringify(call.body ?? {}).includes(name)));

test('a full run against a live database without 모집공고일 and 순번 never references them and gets no 400', async () => {
  for (const [label, options] of [
    // 새 공고를 만들고, 저장된 행을 갱신하고, 로또 알림 발송일을 찍는다.
    ['thursday', { rows: [remainderRow] }],
    // 주간 메일과 접수가 끝난 행 정리가 함께 도는 월요일 실행
    ['monday', { rows: [remainderRow], nowIso: MON_NOW }],
    ['force-weekly', { rows: [remainderRow], env: { CHUNGYAK_MODE: 'force-weekly' } }],
  ]) {
    const fake = notionFake({
      strict: true,
      pages: [page('7-7', { start: THU, end: THU }), page('kept', { start: '2026-11-10', end: '2026-12-01' }), page('ended', { start: '2026-09-01', end: '2026-10-01' })],
    });
    const h = harness(fake, options);
    assert.equal(await run({ env: h.env, deps: h.deps }), 0, label);
    assert.deepEqual(mentionsDropped(fake), [], label);
    assert.deepEqual(fake.rejected, [], label);
    assert.equal(errorMail(h), undefined, label);
    // 스키마에 두 열을 다시 추가하지 않는다.
    for (const name of DROPPED) assert.equal(Object.hasOwn(fake.state.databaseProperties, name), false, `${label} ${name}`);
    // 행 쓰기는 실제로 일어났다.
    assert.ok(fake.calls.some((call) => call.method === 'PATCH' && call.path === '/pages/id-7-7' && call.body.properties), label);
    assert.ok(!h.logs.some((line) => line.includes('sequence')), label);
  }
});

test('parseExistingPage returns the start date and nothing from the dropped columns', () => {
  const stored = page('k', { start: '2026-11-10T09:00:00.000+09:00', extra: { 순번: { number: 4 }, 모집공고일: { date: { start: '2026-11-01' } } } });
  const parsed = parseExistingPage(stored);
  assert.equal(parsed.start, '2026-11-10');
  assert.equal(Object.hasOwn(parsed, 'sequence'), false);
  assert.ok(!JSON.stringify(parsed).includes('2026-11-01'));
  assert.equal(parseExistingPage(page('k')).start, null);
});

test('init leaves an existing database without 모집공고일 and 순번 as it is', async () => {
  const fake = notionFake();
  await realStore(fake).init();
  assert.ok(fake.calls.some((call) => call.method === 'GET' && call.path === '/databases/db'));
  assert.equal(fake.calls.filter((call) => call.method === 'PATCH').length, 0);
  // 다른 열이 빠져 있으면 그 열만 추가한다.
  const missing = notionFake({ databaseProperties: WITHOUT_INTEREST });
  await realStore(missing).init();
  assert.deepEqual(missing.calls.filter((call) => call.method === 'PATCH').map((call) => Object.keys(call.body.properties)), [['관심']]);
});

test('init with createMissing false neither reads nor changes the schema', async () => {
  const fake = notionFake({ databaseProperties: {} });
  await realStore(fake).init({ createMissing: false });
  assert.ok(!fake.calls.some((call) => call.path.startsWith('/databases')));
  assert.equal(writes(fake).length, 0);
});

test('a new database does not get 모집공고일 or 순번', async () => {
  const fake = notionFake({ children: [] });
  await realStore(fake).init();
  const created = fake.calls.find((call) => call.path === '/databases');
  const keys = Object.keys(created.body.properties);
  for (const name of DROPPED) assert.ok(!keys.includes(name), name);
  for (const name of ['접수 시작일', '접수 종료일', '관심']) assert.ok(keys.includes(name), name);
  assert.ok(!fake.calls.some((call) => call.method === 'PATCH'));
});

test('a normal run reads the rows once, with no reload after writing', async () => {
  const fake = notionFake({ pages: [page('ended', { end: '2026-11-01' })] });
  const h = harness(fake, { nowIso: MON_NOW });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.equal(fake.calls.filter((call) => call.path.endsWith('/query')).length, 1);
  assert.ok(fake.calls.some((call) => call.path === '/pages/id-ended' && call.body?.archived === true));
});

for (const queryLagsArchive of [false, true]) {
  test(`a page archived in the run is not written again (query lag: ${queryLagsArchive})`, async () => {
    const fake = notionFake({
      queryLagsArchive,
      pages: [page('ended', { start: '2026-09-01', end: '2026-11-01' }), page('keep', { start: '2026-10-01', end: '2026-12-01' })],
    });
    const h = harness(fake, { nowIso: MON_NOW });
    assert.equal(await run({ env: h.env, deps: h.deps }), 0);
    assert.deepEqual(fake.calls.filter((call) => call.path === '/pages/id-ended').map((call) => call.body), [{ archived: true }]);
  });
}

test('loadExisting skips rows Notion marks as archived or in trash', async () => {
  const fake = notionFake({
    intercept: (call) => (call.path.endsWith('/query')
      ? Response.json({
        has_more: false,
        results: [
          { ...page('live') },
          { ...page('archived'), archived: true },
          { ...page('trash'), in_trash: true },
        ],
      })
      : null),
  });
  const store = realStore(fake);
  await store.init();
  assert.deepEqual([...(await store.loadExisting()).keys()], ['live']);
});

for (const [label, argv] of [['dry-run', ['--dry-run']], ['print', ['--print']], ['test-send', ['--test-send']]]) {
  test(`${label} makes no Notion writes`, async () => {
    const fake = notionFake({ databaseProperties: {}, pages: [page('a', { start: '2026-10-01' })] });
    const h = harness(fake);
    await run({ argv, env: h.env, deps: h.deps });
    assert.deepEqual(writes(fake), []);
  });
}

test('cleanup-ended archives without touching the schema', async () => {
  const fake = notionFake({
    databaseProperties: {},
    pages: [page('ended', { end: '2026-11-01' }), page('keep', { end: '2026-12-01' })],
  });
  const h = harness(fake, { env: { CHUNGYAK_MODE: 'cleanup-ended' } });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.deepEqual(writes(fake).map((call) => call.path), ['/pages/id-ended']);
});

test('a cleanup failure still sets the exit code', async () => {
  const fake = notionFake({
    pages: [page('ended', { end: '2026-11-01' })],
    intercept: (call) => (call.body?.archived ? new Response('', { status: 403 }) : null),
  });
  const h = harness(fake, { nowIso: MON_NOW });
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.ok(errorMail(h).text.includes('cleanup_failed x1'));
});
