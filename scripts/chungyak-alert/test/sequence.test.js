import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from '../src/main.js';
import { computeSequenceNumbers, createNotionStore, parseExistingPage } from '../src/notion-store.js';

const THU_NOW = '2026-11-04T22:30:00Z';
const THU = '2026-11-05';
const MON_NOW = '2026-11-01T22:30:00Z';

const row = (key, start = null, sequence = null) => ({ id: `id-${key}`, key, start, sequence });

const page = (key, { start, end, sequence } = {}) => ({
  id: `id-${key}`,
  properties: {
    '고유 키': { rich_text: [{ plain_text: key }] },
    ...(start ? { '접수 시작일': { date: { start } } } : {}),
    ...(end ? { '접수 종료일': { date: { start: end } } } : {}),
    순번: { number: sequence ?? null },
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

// 페이지와 스키마 상태를 가진 Notion 가짜. intercept가 Response를 돌려주면 그 호출은 실패 등으로 대체된다.
function notionFake({
  pages = [],
  databaseProperties = { '안전 마진': { type: 'number', number: {} }, 마진율: { type: 'number', number: {} }, '시세 신뢰도': { type: 'select', select: {} }, 순번: { type: 'number', number: { format: 'number' } }, 관심: { type: 'checkbox', checkbox: {} } },
  children,
  queryLagsArchive = false,
  intercept = () => null,
} = {}) {
  const calls = [];
  const state = { pages: [...pages], databaseProperties: { ...databaseProperties }, created: 0 };
  const list = children ?? [
    { id: 'db', type: 'child_database', child_database: { title: '청약 정보' } },
    { id: 'src', type: 'child_page', child_page: { title: '청약 수집 소스' } },
  ];
  const fetch = async (url, init) => {
    const path = new URL(url).pathname.replace('/v1', '');
    const body = init.body ? JSON.parse(init.body) : null;
    const call = { method: init.method, path, body };
    calls.push(call);
    const replaced = intercept(call, calls);
    if (replaced) return replaced;
    if (init.method === 'GET' && path.startsWith('/blocks/')) return Response.json({ results: list, has_more: false });
    if (init.method === 'GET' && path.startsWith('/databases/')) return Response.json({ id: 'db', properties: state.databaseProperties });
    if (init.method === 'POST' && path === '/databases') return Response.json({ id: 'db' });
    if (init.method === 'PATCH' && path.startsWith('/databases/')) {
      for (const [name, value] of Object.entries(body.properties)) state.databaseProperties[name] = { type: 'number', ...value };
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
      const created = {
        id: `new-${state.created}`,
        properties: {
          ...(content ? { '고유 키': { rich_text: [{ plain_text: content }] } } : {}),
          ...(body.properties['접수 시작일'] ? { '접수 시작일': body.properties['접수 시작일'] } : {}),
        },
      };
      if (content) state.pages.push(created);
      return Response.json({ id: created.id });
    }
    if (init.method === 'PATCH' && path.startsWith('/pages/')) {
      const target = state.pages.find((item) => `/pages/${item.id}` === path);
      if (target && body.archived) target.archived = true;
      if (target && body.properties?.순번) target.properties.순번 = body.properties.순번;
      return Response.json({ id: 'ok' });
    }
    return Response.json({ id: 'ok' });
  };
  return { calls, fetch, state };
}

const MARKET_SCHEMA = { '안전 마진': { type: 'number', number: {} }, 마진율: { type: 'number', number: {} }, '시세 신뢰도': { type: 'select', select: {} } };

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

function harness(fake, { rows = [], nowIso = THU_NOW, sendKakao, env = {} } = {}) {
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
      sendKakao: sendKakao ?? (async (message) => { kakao.push(message); }),
    },
  };
}

const sequencePatches = (fake) => fake.calls
  .filter((call) => call.method === 'PATCH' && call.body?.properties?.순번 && call.path.startsWith('/pages/'))
  .map((call) => [call.path.replace('/pages/', ''), call.body.properties.순번.number]);
const writes = (fake) => fake.calls.filter((call) => call.method === 'PATCH' || (call.method === 'POST' && !call.path.endsWith('/query')));
const errorMail = (h) => h.mails.find((mail) => mail.subject.includes('배치 오류'));

test('numbering sorts by start date, puts undated rows last and breaks ties by key', () => {
  const rows = [
    row('z-undated'),
    row('b-tie', '2026-11-10'),
    row('late', '2026-12-01'),
    row('a-undated'),
    row('a-tie', '2026-11-10'),
    row('early', '2026-10-01'),
  ];
  const numbered = computeSequenceNumbers(rows);
  assert.deepEqual(
    numbered.map((item) => [item.key, item.number]),
    [['early', 1], ['a-tie', 2], ['b-tie', 3], ['late', 4], ['a-undated', 5], ['z-undated', 6]],
  );
});

test('numbering does not depend on input order and does not mutate its input', () => {
  const rows = [row('b', '2026-11-10'), row('a', '2026-11-10'), row('c')];
  const snapshot = structuredClone(rows);
  const forward = computeSequenceNumbers(rows).map((item) => item.key);
  const backward = computeSequenceNumbers([...rows].reverse()).map((item) => item.key);
  assert.deepEqual(forward, ['a', 'b', 'c']);
  assert.deepEqual(backward, forward);
  assert.deepEqual(rows, snapshot);
  assert.deepEqual(computeSequenceNumbers([]), []);
});

test('parseExistingPage returns the start date and the current sequence number', () => {
  const parsed = parseExistingPage(page('k', { start: '2026-11-10T09:00:00.000+09:00', sequence: 4 }));
  assert.equal(parsed.start, '2026-11-10');
  assert.equal(parsed.sequence, 4);
  const empty = parseExistingPage(page('k'));
  assert.equal(empty.start, null);
  assert.equal(empty.sequence, null);
});

test('init adds the property to an existing database only when it is missing', async () => {
  const missing = notionFake({ databaseProperties: { ...MARKET_SCHEMA, 주택명: { title: {} }, 관심: { type: 'checkbox', checkbox: {} } } });
  await realStore(missing).init();
  const added = missing.calls.filter((call) => call.method === 'PATCH');
  assert.deepEqual(added, [{
    method: 'PATCH',
    path: '/databases/db',
    body: { properties: { 순번: { number: { format: 'number' } } } },
  }]);

  const present = notionFake();
  await realStore(present).init();
  assert.ok(present.calls.some((call) => call.method === 'GET' && call.path === '/databases/db'));
  assert.equal(present.calls.filter((call) => call.method === 'PATCH').length, 0);
});

test('init with createMissing false neither reads nor changes the schema', async () => {
  const fake = notionFake({ databaseProperties: {} });
  await realStore(fake).init({ createMissing: false });
  assert.ok(!fake.calls.some((call) => call.path.startsWith('/databases')));
  assert.equal(writes(fake).length, 0);
});

test('a new database carries the property and is not patched', async () => {
  const fake = notionFake({ children: [] });
  await realStore(fake).init();
  const created = fake.calls.find((call) => call.path === '/databases');
  const keys = Object.keys(created.body.properties);
  assert.ok(keys.includes('순번'));
  assert.deepEqual(created.body.properties.순번, { number: { format: 'number' } });
  assert.ok(!fake.calls.some((call) => call.method === 'PATCH'));
});

test('a normal run PATCHes only rows whose number changed', async () => {
  const fake = notionFake({
    pages: [
      page('undated', { sequence: 3 }),
      page('first', { start: '2026-10-01', sequence: 1 }),
      page('second', { start: '2026-10-02', sequence: 9 }),
      page('new-row', { start: '2026-10-03' }),
    ],
  });
  const h = harness(fake);
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.deepEqual(sequencePatches(fake), [['id-second', 2], ['id-new-row', 3], ['id-undated', 4]]);
  assert.ok(h.logs.some((line) => line.includes('sequenced=3')));

  const before = fake.calls.length;
  const again = harness(fake);
  assert.equal(await run({ env: again.env, deps: again.deps }), 0);
  assert.deepEqual(sequencePatches({ calls: fake.calls.slice(before) }), []);
});

test('a row created in this run is numbered in the same run', async () => {
  const fake = notionFake({ pages: [page('later', { start: '2026-12-01', sequence: 1 })] });
  const h = harness(fake, { rows: [remainderRow] });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.deepEqual(sequencePatches(fake), [['new-1', 1], ['id-later', 2]]);
  assert.equal(h.kakao.length, 1);
});

test('the reload runs after upserts, alerts and archiving', async () => {
  const fake = notionFake({ pages: [page('ended', { end: '2026-11-01', sequence: 1 })] });
  const h = harness(fake, { nowIso: MON_NOW });
  await run({ env: h.env, deps: h.deps });
  const queries = fake.calls.flatMap((call, index) => (call.path.endsWith('/query') ? [index] : []));
  const archive = fake.calls.findIndex((call) => call.body?.archived === true);
  assert.equal(queries.length, 2);
  assert.ok(queries[0] < archive && archive < queries[1]);
});

for (const queryLagsArchive of [false, true]) {
  test(`pages archived earlier in the run do not count (query lag: ${queryLagsArchive})`, async () => {
    const fake = notionFake({
      queryLagsArchive,
      pages: [
        page('ended', { start: '2026-09-01', end: '2026-11-01', sequence: 1 }),
        page('keep-a', { start: '2026-10-01', end: '2026-12-01', sequence: 2 }),
        page('keep-b', { start: '2026-10-02', end: '2026-12-01', sequence: 3 }),
      ],
    });
    const h = harness(fake, { nowIso: MON_NOW });
    assert.equal(await run({ env: h.env, deps: h.deps }), 0);
    assert.ok(fake.calls.some((call) => call.path === '/pages/id-ended' && call.body?.archived === true));
    assert.deepEqual(sequencePatches(fake), [['id-keep-a', 1], ['id-keep-b', 2]]);
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
    const fake = notionFake({ databaseProperties: {}, pages: [page('a', { start: '2026-10-01', sequence: 5 })] });
    const h = harness(fake);
    await run({ argv, env: h.env, deps: h.deps });
    assert.deepEqual(writes(fake), []);
  });
}

test('force-weekly writes Notion rows, so it also renumbers', async () => {
  const fake = notionFake({ pages: [page('a', { start: '2026-10-01', end: '2026-12-01', sequence: 5 })] });
  const h = harness(fake, { env: { CHUNGYAK_MODE: 'force-weekly' } });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.deepEqual(sequencePatches(fake), [['id-a', 1]]);
});

test('cleanup-ended archives without renumbering or touching the schema', async () => {
  const fake = notionFake({
    databaseProperties: {},
    pages: [page('ended', { end: '2026-11-01' }), page('keep', { end: '2026-12-01', sequence: 9 })],
  });
  const h = harness(fake, { env: { CHUNGYAK_MODE: 'cleanup-ended' } });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.deepEqual(writes(fake).map((call) => call.path), ['/pages/id-ended']);
});

test('a failed row PATCH stops renumbering, reaches the error mail once and does not fail the job', async () => {
  const fake = notionFake({
    pages: [
      page('a', { start: '2026-10-01', sequence: 8 }),
      page('b', { start: '2026-10-02', sequence: 9 }),
    ],
    intercept: (call) => (call.path === '/pages/id-a' && call.body?.properties?.순번 ? new Response('body-with-secret', { status: 403 }) : null),
  });
  const h = harness(fake, { rows: [remainderRow] });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.equal(h.kakao.length, 1);
  assert.deepEqual(sequencePatches(fake), [['id-a', 1]]);
  const summary = errorMail(h);
  assert.ok(summary.text.includes('sequence_failed x1'));
  assert.ok(summary.text.includes('notion_http_403 x1'));
  const output = [...h.logs, summary.text].join('\n');
  for (const secret of ['id-a', 'id-b', 'SECRET', 'body-with-secret', 'api.notion.com']) assert.ok(!output.includes(secret), secret);
});

test('a failed reload reaches the error mail and does not fail the job', async () => {
  const fake = notionFake({
    pages: [page('a', { start: '2026-10-01', sequence: 8 })],
    intercept: (call, calls) => (call.path.endsWith('/query') && calls.filter((item) => item.path.endsWith('/query')).length === 2
      ? new Response('', { status: 400 })
      : null),
  });
  const h = harness(fake, { rows: [remainderRow] });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.equal(h.kakao.length, 1);
  assert.deepEqual(sequencePatches(fake), []);
  assert.ok(errorMail(h).text.includes('sequence_failed x1'));
});

test('an outage during renumbering costs one retry cycle, is reported once and does not fail the job', async () => {
  let stalled = 0;
  const fake = notionFake({
    pages: [page('a', { start: '2026-10-01' }), page('b', { start: '2026-10-02' })],
    intercept: (call) => {
      if (call.body?.properties?.순번) {
        stalled += 1;
        throw new TypeError('fetch failed https://api.notion.com');
      }
      return null;
    },
  });
  const h = harness(fake);
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.equal(stalled, 6);
  assert.ok(errorMail(h).text.includes('sequence_failed x1'));
  assert.ok(!errorMail(h).text.includes('api.notion.com'));
});

test('renumbering is skipped when Notion already failed in this run', async () => {
  const fake = notionFake({
    pages: [page('a', { start: '2026-10-01', sequence: 8 })],
    intercept: (call) => (call.method === 'POST' && call.path === '/pages' ? new Response('', { status: 403 }) : null),
  });
  const h = harness(fake, { rows: [remainderRow] });
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.equal(h.kakao.length, 1);
  assert.equal(fake.calls.filter((call) => call.path.endsWith('/query')).length, 1);
  assert.deepEqual(sequencePatches(fake), []);
  assert.ok(!errorMail(h).text.includes('sequence_failed'));
});

test('a failed schema change does not block upserts or alerts and surfaces as sequence_failed', async () => {
  const fake = notionFake({
    databaseProperties: {},
    pages: [page('a', { start: '2026-10-01' })],
    intercept: (call) => {
      if (call.method === 'PATCH' && call.path === '/databases/db') return new Response('', { status: 403 });
      if (call.method === 'PATCH' && call.body?.properties?.순번) return new Response('', { status: 400 });
      return null;
    },
  });
  const h = harness(fake, { rows: [remainderRow] });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.equal(fake.state.created, 1);
  assert.equal(h.kakao.length, 1);
  assert.ok(errorMail(h).text.includes('sequence_failed x1'));
});

test('a same-named property of another type is left alone and renumbering skips with one error', async () => {
  const fake = notionFake({
    databaseProperties: { ...MARKET_SCHEMA, 순번: { type: 'rich_text', rich_text: {} }, 관심: { type: 'checkbox', checkbox: {} } },
    pages: [page('a', { start: '2026-10-01' }), page('b', { start: '2026-10-02' })],
  });
  const h = harness(fake, { rows: [remainderRow] });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.ok(!fake.calls.some((call) => call.method === 'PATCH' && call.path.startsWith('/databases/')));
  assert.deepEqual(sequencePatches(fake), []);
  assert.equal(fake.state.created, 1);
  assert.equal(h.kakao.length, 1);
  const summary = errorMail(h);
  assert.ok(summary.text.includes('sequence_failed x1'));
  assert.ok(summary.text.includes('sequence_property_conflict x1'));
});

test('renumbering stops at the time budget without an error and the next run continues', async () => {
  let current = Date.parse(THU_NOW);
  const fake = notionFake({
    pages: [
      page('a', { start: '2026-10-01' }),
      page('b', { start: '2026-10-02' }),
      page('c', { start: '2026-10-03' }),
    ],
    intercept: (call) => {
      if (call.body?.properties?.순번) current += 10 * 60 * 1000;
      return null;
    },
  });
  const h = harness(fake);
  h.deps.now = () => new Date(current);
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.deepEqual(sequencePatches(fake), [['id-a', 1]]);
  assert.ok(h.logs.includes('sequence_skipped=2'));
  assert.ok(h.logs.some((line) => line.includes('sequenced=1')));
  assert.equal(errorMail(h), undefined);
  assert.ok(!h.logs.join('\n').includes('id-'));

  const before = fake.calls.length;
  const next = harness(fake);
  assert.equal(await run({ env: next.env, deps: next.deps }), 0);
  assert.deepEqual(sequencePatches({ calls: fake.calls.slice(before) }), [['id-b', 2], ['id-c', 3]]);
});

test('renumbering does not affect the exit code that cleanup failures still set', async () => {
  const fake = notionFake({
    pages: [page('ended', { end: '2026-11-01' })],
    intercept: (call) => (call.body?.archived ? new Response('', { status: 403 }) : null),
  });
  const h = harness(fake, { nowIso: MON_NOW });
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.ok(errorMail(h).text.includes('cleanup_failed x1'));
  assert.ok(!errorMail(h).text.includes('sequence_failed'));
});
