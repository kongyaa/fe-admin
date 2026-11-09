import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

function apiFetch(rows, { lhRows = [], pblrentRows = [] } = {}) {
  return async (url) => {
    const text = String(url);
    if (text.includes('getRemndrLttotPblancDetail')) return Response.json({ totalCount: rows.length, data: rows });
    if (text.includes('getPblPvtRentLttotPblancDetail')) return Response.json({ totalCount: pblrentRows.length, data: pblrentRows });
    if (text.includes('api.odcloud.kr')) return Response.json({ totalCount: 0, data: [] });
    if (text.includes('apis.data.go.kr/1613000')) return new Response('<r><resultCode>000</resultCode><totalCount>0</totalCount></r>');
    return Response.json([{ dsList: lhRows.map((row) => ({ ...row, ALL_CNT: lhRows.length })) }]);
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

function harness(fake, { rows = [], lhRows, pblrentRows, nowIso = THU_NOW, env = {}, config } = {}) {
  const base = apiFetch(rows, { lhRows, pblrentRows });
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
      ...(config ? { config } : {}),
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


// ---------- 임대 제외 ----------
const lhRow = (id, upper, detail, name) => ({
  PAN_ID: id, PAN_NM: name, UPP_AIS_TP_NM: upper, AIS_TP_CD_NM: detail, CNP_CD_NM: '서울특별시', PAN_NT_ST_DT: '2026.11.01', CLSG_DT: '2026.11.20', DTL_URL: 'https://apply.lh.or.kr/x',
});
const pblrentRow = {
  HOUSE_MANAGE_NO: '9', PBLANC_NO: '9', HOUSE_NM: '민간임대 단지', HOUSE_SECD: '0303', SUBSCRPT_AREA_CODE_NM: '서울', HSSPLY_ADRES: '서울특별시 강남구 역삼동 9',
  RCRIT_PBLANC_DE: '20261101', SUBSCRPT_RCEPT_BGNDE: '20261105', SUBSCRPT_RCEPT_ENDDE: '20261105', PBLANC_URL: 'https://www.applyhome.co.kr/r',
};
const stored = (key, typeLabel, name, { start = '2026-11-10', end = '2026-12-01', interest = false } = {}) => page(key, {
  start,
  end,
  extra: { 유형: { select: typeLabel ? { name: typeLabel } : null }, 주택명: { title: [{ plain_text: name }] }, 관심: { checkbox: interest } },
});
const rentalWorld = (extra = {}) => notionFake({
  pages: [
    // 이번에 수집되지 않은 임대 행
    stored('LH-old', '임대주택 행복주택', '행복주택 단지'),
    // 이번에 공공지원민간임대로 수집된 행. 관심을 체크했고 오늘 접수라 그대로 두면 관심 알림이 간다.
    stored('9-9', '공공지원민간임대', '민간임대 단지', { start: THU, end: THU, interest: true }),
    // 저장된 유형은 정할 수 없지만 이번 실행에서 임대로 빠진 LH 공고
    stored('LH-r1', null, '공고'),
    // 이름에 임대 단어가 있는 분양 행은 남는다.
    stored('sale', 'APT', '공공임대 부지 민영 단지'),
    stored('7-7', '무순위', '무순위 단지', { start: THU, end: THU }),
  ],
  ...extra,
});
const rentalSources = {
  rows: [remainderRow],
  lhRows: [lhRow('r1', '임대주택', '국민임대', '공고'), lhRow('s1', '분양주택', '공공분양', '국민임대 단지 옆 공공분양')],
  pblrentRows: [pblrentRow],
};
const archivedIds = (fake) => fake.calls.filter((call) => call.method === 'PATCH' && call.body?.archived === true).map((call) => call.path.replace('/pages/', '')).sort();
const rowWrites = (fake) => fake.calls.filter((call) => (call.method === 'POST' && call.path === '/pages') || (call.method === 'PATCH' && call.path.startsWith('/pages/') && call.body?.properties));
const writtenKeys = (fake) => rowWrites(fake).map((call) => (call.method === 'POST' ? call.body.properties['고유 키'].rich_text[0].text.content : call.path.replace('/pages/id-', '')));
const summary = (h) => h.logs.find((line) => line.startsWith('collected='));

test('rental notices are skipped before evaluation and stored rental rows go to the trash after the alerts', async () => {
  const fake = rentalWorld();
  const h = harness(fake, rentalSources);
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.ok(summary(h).includes(' rental_skipped=2 '), summary(h));
  assert.ok(summary(h).includes(' rental_archived=3 rental_archived_interest=1'), summary(h));
  assert.deepEqual(archivedIds(fake), ['id-9-9', 'id-LH-old', 'id-LH-r1']);
  // 임대 공고는 저장하지 않고, 분양 공고(이름에 임대 단어가 있어도)는 저장한다.
  const keys = writtenKeys(fake);
  for (const key of ['LH-r1', '9-9', 'LH-old']) assert.ok(!keys.includes(key), key);
  for (const key of ['LH-s1', '7-7']) assert.ok(keys.includes(key), key);
  assert.ok(!archivedIds(fake).includes('id-sale'));
  // 관심 체크된 임대 행으로는 알림을 보내지 않는다. 무순위 로또 알림 한 건만 간다.
  assert.deepEqual(h.kakao.map((message) => message.text.slice(0, 7)), ['[로또 청약]']);
  // 휴지통 이동은 알림과 발송 기록 뒤다.
  const lastRowWrite = fake.calls.lastIndexOf(rowWrites(fake).at(-1));
  const firstArchive = fake.calls.findIndex((call) => call.body?.archived === true);
  assert.ok(lastRowWrite < firstArchive);
  assert.equal(errorMail(h), undefined);
  assert.ok(!h.logs.join('\n').includes('id-'));
});

test('dry-run counts rental candidates without any write', async () => {
  const fake = rentalWorld();
  const h = harness(fake, { ...rentalSources });
  await run({ argv: ['--dry-run'], env: h.env, deps: h.deps });
  assert.deepEqual(writes(fake), []);
  assert.ok(h.logs.includes('dry-run rental_archive_candidates=3'), h.logs.join('|'));
  assert.ok(summary(h).includes(' rental_skipped=2 '));
  assert.ok(summary(h).includes(' rental_archived=0 rental_archived_interest=0'));
  assert.equal(h.kakao.length, 0);
});

test('a failed rental archive reaches the error mail after the alerts and the rest are still moved', async () => {
  const fake = rentalWorld({ intercept: (call) => (call.path === '/pages/id-LH-old' && call.body?.archived ? new Response('body-secret', { status: 403 }) : null) });
  const h = harness(fake, rentalSources);
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.equal(h.kakao.length, 1);
  assert.ok(summary(h).includes(' rental_archived=2 rental_archived_interest=1'), summary(h));
  const mail = errorMail(h);
  assert.ok(mail.text.includes('rental_archive_failed x1'));
  assert.ok(mail.text.includes('notion_http_403 x1'));
  assert.ok(!mail.text.includes('body-secret') && !mail.text.includes('id-LH-old'));
});

test('a collected, kept notice is updated in place even when its stored type looks like a rental', async () => {
  // 저장된 유형은 예전 값(임대)이지만 이번 실행에 분양으로 수집되었다. 청약홈 행도 같다.
  const fake = notionFake({
    pages: [
      storedLh('LH-s1', '임대주택 국민임대', '예전 이름', { region: '서울' }),
      stored('7-7', '공공지원민간임대', '무순위 단지', { start: THU, end: THU }),
      // 수집되지 않은 임대 행은 그대로 옮긴다.
      stored('LH-old', '임대주택 행복주택', '행복주택 단지'),
    ],
  });
  const h = harness(fake, { rows: [remainderRow], lhRows: [lhRow('s1', '분양주택', '공공분양', '서울 공공분양')] });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.deepEqual(archivedIds(fake), ['id-LH-old']);
  for (const id of ['id-LH-s1', 'id-7-7']) assert.ok(rowWrites(fake).some((call) => call.method === 'PATCH' && call.path === `/pages/${id}`), id);
  assert.equal(fake.state.created, 0);
  assert.ok(summary(h).includes(' rental_archived=1 '), summary(h));

  // dry-run 후보 수도 같다.
  const dry = harness(notionFake({ pages: [storedLh('LH-s1', '임대주택 국민임대', '예전 이름', { region: '서울' }), stored('LH-old', '임대주택 행복주택', '행복주택 단지')] }), { rows: [remainderRow], lhRows: [lhRow('s1', '분양주택', '공공분양', '서울 공공분양')] });
  await run({ argv: ['--dry-run'], env: dry.env, deps: dry.deps });
  assert.ok(dry.logs.includes('dry-run rental_archive_candidates=1'), dry.logs.join('|'));
});

test('with excludeRental off rental notices are stored as before and nothing is archived', async () => {
  const fileConfig = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const fake = rentalWorld();
  // LH 범위 필터도 임대 LH 공고를 빼므로 함께 끈다. 켜 둔 경우는 아래 LH 범위 테스트가 본다.
  const h = harness(fake, { ...rentalSources, config: { ...fileConfig, excludeRental: false, lh: { ...fileConfig.lh, filterSaleArea: false } } });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.deepEqual(archivedIds(fake), []);
  for (const key of ['LH-r1', '9-9', 'LH-s1', '7-7']) assert.ok(writtenKeys(fake).includes(key), key);
  assert.ok(summary(h).includes(' rental_skipped=0 '));
});

// ---------- LH 범위(분양, 대상 지역) ----------
const fileConfig = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const lhSaleRow = (id, name, cnp = '서울특별시', upper = '분양주택', detail = '공공분양') => ({ ...lhRow(id, upper, detail, name), CNP_CD_NM: cnp });
const storedLh = (key, typeLabel, name, { region = null, interest = false, start = '2026-11-10', end = '2026-12-01', source = 'LH' } = {}) => page(key, {
  start,
  end,
  extra: {
    유형: { select: typeLabel ? { name: typeLabel } : null },
    주택명: { title: [{ plain_text: name }] },
    공급지역: { select: region ? { name: region } : null },
    소스: { select: source ? { name: source } : null },
    관심: { checkbox: interest },
  },
});
// 로그와 오류 메일에 나오면 안 되는 공고 이름
const LH_NAMES = ['하남 교산', '고양창릉', '부산 공공분양', '선택형', '부산 관심', '광주 공공분양', '어느 공고'];
const busanRemainder = { ...remainderRow, HOUSE_MANAGE_NO: '8', PBLANC_NO: '8', HOUSE_NM: '부산 무순위 단지', SUBSCRPT_AREA_CODE_NM: '부산', HSSPLY_ADRES: '부산광역시 해운대구 우동 1' };
const lhWorld = (extra = {}) => notionFake({
  pages: [
    // 수집되지 않았고 저장된 값으로 지역 밖인 행 → 옮긴다.
    storedLh('LH-busan', '분양주택 공공분양', '부산 공공분양 단지', { region: '부산' }),
    // 이번 실행에 지역 밖으로 빠진 공고의 행. 저장된 값은 읽을 수 없어도 옮긴다.
    storedLh('LH-goyang', null, '고양창릉 A4 공공분양'),
    // 지역 밖이지만 관심을 체크한 행 → 남기고 센다.
    storedLh('LH-keep', '분양주택 공공분양', '부산 관심 단지', { region: '부산', interest: true }),
    // 이번에 선택형으로 빠질 공고지만 관심을 체크했다 → 보통 공고처럼 갱신한다.
    storedLh('LH-select', '분양주택 공공분양', '뉴홈 선택형 공고', { region: '서울', interest: true }),
    // 공급지역이 없어 지역을 판정할 수 없는 행 → 남긴다.
    storedLh('LH-noregion', '분양주택 공공분양', '어느 공고'),
    // 이름이 없어 키로 저장된 행 → 남긴다.
    storedLh('LH-nameless', null, 'LH-nameless', { region: '광주' }),
    // 범위 안 행
    storedLh('LH-seoul', '분양주택 공공분양', '서울 공공분양', { region: '서울' }),
    // 청약홈 행은 지역과 관계없이 건드리지 않는다.
    storedLh('5-5', 'APT', '광주 공공분양 단지', { region: '광주', source: '청약홈' }),
  ],
  ...extra,
});
const lhSources = {
  rows: [remainderRow, busanRemainder],
  lhRows: [
    lhSaleRow('seoul', '서울 공공분양'),
    lhSaleRow('gyosan', '하남 교산 A1 공공분양', '경기도'),
    lhSaleRow('goyang', '고양창릉 A4 공공분양', '경기도'),
    lhSaleRow('busan2', '부산 공공분양 2단지', '부산광역시'),
    lhSaleRow('select', '뉴홈 선택형 공고'),
    lhSaleRow('select2', '뉴홈 선택형 공고 2'),
    // 유형을 읽을 수 없는 서울 공고는 남긴다.
    lhSaleRow('blank', '유형 없는 공고', '서울특별시', '', ''),
  ],
};

test('out-of-scope LH notices are skipped and their stored rows go to the trash after the alerts', async () => {
  const fake = lhWorld();
  const h = harness(fake, lhSources);
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.ok(summary(h).includes(' lh_out_of_scope_skipped=3 lh_out_of_scope_type=1 lh_out_of_scope_area=2 lh_out_of_scope_archived=2 lh_out_of_scope_kept_interest=2'), summary(h));
  assert.deepEqual(archivedIds(fake), ['id-LH-busan', 'id-LH-goyang']);
  const keys = writtenKeys(fake);
  for (const key of ['LH-seoul', 'LH-gyosan', 'LH-blank', 'LH-select', '7-7', '8-8']) assert.ok(keys.includes(key), key);
  for (const key of ['LH-goyang', 'LH-busan2', 'LH-select2', 'LH-busan', 'LH-keep', 'LH-noregion', 'LH-nameless', '5-5']) assert.ok(!keys.includes(key), key);
  // 범위 밖 공고로는 알림을 보내지 않는다. 서울 무순위 로또 알림 한 건만 간다.
  assert.deepEqual(h.kakao.map((message) => message.text.slice(0, 7)), ['[로또 청약]']);
  const lastRowWrite = fake.calls.lastIndexOf(rowWrites(fake).at(-1));
  const firstArchive = fake.calls.findIndex((call) => call.body?.archived === true);
  assert.ok(lastRowWrite < firstArchive);
  assert.equal(errorMail(h), undefined);
  const logs = h.logs.join('\n');
  for (const name of LH_NAMES) assert.ok(!logs.includes(name), name);
  assert.ok(!logs.includes('id-'));
});

test('dry-run counts LH out-of-scope candidates without any write or message', async () => {
  const fake = lhWorld();
  const h = harness(fake, lhSources);
  assert.equal(await run({ argv: ['--dry-run'], env: h.env, deps: h.deps }), 0);
  assert.deepEqual(writes(fake), []);
  assert.equal(h.kakao.length, 0);
  assert.equal(h.mails.length, 0);
  assert.ok(h.logs.includes('dry-run lh_out_of_scope_archive_candidates=2'), h.logs.join('|'));
  assert.ok(summary(h).includes(' lh_out_of_scope_skipped=3 lh_out_of_scope_type=1 lh_out_of_scope_area=2 lh_out_of_scope_archived=0 lh_out_of_scope_kept_interest=2'), summary(h));
  const logs = h.logs.join('\n');
  for (const name of LH_NAMES) assert.ok(!logs.includes(name), name);
});

test('a failed LH archive reaches the error mail after the alerts and the rest are still moved', async () => {
  const fake = lhWorld({ intercept: (call) => (call.path === '/pages/id-LH-busan' && call.body?.archived ? new Response('body-secret', { status: 403 }) : null) });
  const h = harness(fake, lhSources);
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  // 알림은 이미 나갔다.
  assert.deepEqual(h.kakao.map((message) => message.text.slice(0, 7)), ['[로또 청약]']);
  assert.ok(summary(h).includes(' lh_out_of_scope_archived=1 '), summary(h));
  assert.deepEqual(archivedIds(fake), ['id-LH-busan', 'id-LH-goyang']);
  const mail = errorMail(h);
  assert.ok(mail.text.includes('lh_out_of_scope_archive_failed x1'));
  assert.ok(!mail.text.includes('body-secret') && !mail.text.includes('id-LH-busan'));
  for (const name of LH_NAMES) assert.ok(!mail.text.includes(name) && !h.logs.join('\n').includes(name), name);
});

test('with excludeRental off the LH filter still drops LH rental notices and rows', async () => {
  const fake = rentalWorld();
  const h = harness(fake, { ...rentalSources, config: { ...fileConfig, excludeRental: false } });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  // 임대 LH 공고(LH-r1)는 유형으로 빠지고, 저장된 임대 LH 행(LH-old, LH-r1)은 옮긴다. 청약홈 임대는 저장한다.
  assert.deepEqual(archivedIds(fake), ['id-LH-old', 'id-LH-r1']);
  for (const key of ['9-9', 'LH-s1', '7-7']) assert.ok(writtenKeys(fake).includes(key), key);
  assert.ok(!writtenKeys(fake).includes('LH-r1'));
  assert.ok(summary(h).includes(' lh_out_of_scope_skipped=1 lh_out_of_scope_type=1 lh_out_of_scope_area=0 lh_out_of_scope_archived=2 '), summary(h));
});

test('every run logs the LH type labels by count, without notice names', async () => {
  for (const argv of [[], ['--dry-run']]) {
    const fake = lhWorld();
    const h = harness(fake, lhSources);
    await run({ argv, env: h.env, deps: h.deps });
    const line = h.logs.find((item) => item.startsWith('lh_types '));
    assert.equal(line, 'lh_types 분양주택/공공분양=6,-/-=1', argv.join(' '));
    const names = lhSources.lhRows.map((row) => row.PAN_NM);
    for (const name of names) assert.ok(!line.includes(name), name);
    // 유형 규칙을 통과한 공고(선택형 둘 제외)의 공급지역별 건수
    const regionLine = h.logs.find((item) => item.startsWith('lh_sale_regions '));
    assert.equal(regionLine, 'lh_sale_regions 경기=2,서울=2,부산=1', argv.join(' '));
    for (const name of names) assert.ok(!regionLine.includes(name), name);
    for (const name of [...names, ...LH_NAMES]) assert.ok(!h.logs.join('\n').includes(name), name);
  }
  // LH 조회가 없으면 none이다.
  const empty = harness(notionFake(), { rows: [remainderRow] });
  await run({ env: empty.env, deps: empty.deps });
  assert.ok(empty.logs.includes('lh_types none'), empty.logs.join('|'));
  assert.ok(empty.logs.includes('lh_sale_regions none'), empty.logs.join('|'));
});

test('unknown LH types and 토지임대부 sales are stored; unknown types are counted', async () => {
  const fake = notionFake();
  const h = harness(fake, {
    rows: [remainderRow],
    lhRows: [
      lhSaleRow('unknown', '어느 공고', '서울특별시', '공공주택', '기타'),
      lhSaleRow('unknown-busan', '어느 공고', '부산광역시', '공공주택', '기타'),
      lhSaleRow('land', '어느 공고', '서울특별시', '분양주택', '토지임대부'),
      lhSaleRow('land-name', '토지임대부 분양주택', '서울특별시'),
      // 유형이 토지인 행은 이름에 토지임대부가 있어도 수집 단계에서 빠진다.
      lhSaleRow('land-plot', '토지임대부 분양주택 용지 공급', '서울특별시', '토지', '공동주택용지'),
      // 공급지역이 빈 분양 공고는 남기고 센다.
      lhSaleRow('noregion', '어느 공고', ''),
    ],
  });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  const keys = writtenKeys(fake);
  for (const key of ['LH-unknown', 'LH-land', 'LH-land-name', 'LH-noregion']) assert.ok(keys.includes(key), key);
  for (const key of ['LH-unknown-busan', 'LH-land-plot']) assert.ok(!keys.includes(key), key);
  assert.ok(summary(h).includes(' rental_skipped=0 '), summary(h));
  assert.ok(summary(h).includes(' lh_out_of_scope_skipped=1 lh_out_of_scope_type=0 lh_out_of_scope_area=1 '), summary(h));
  assert.ok(summary(h).includes(' lh_type_unknown=2 lh_region_unknown=1'), summary(h));
  assert.ok(h.logs.includes('lh_types 공공주택/기타=2,분양주택/공공분양=2,분양주택/토지임대부=1,토지/공동주택용지=1'), h.logs.join('|'));
  assert.ok(h.logs.includes('lh_sale_regions 서울=3,-=1,부산=1'), h.logs.join('|'));
});

test('with the LH filter off 토지임대부 types fall back to the old 토지 exclusion at collection', async () => {
  const fake = notionFake();
  const h = harness(fake, {
    rows: [remainderRow],
    lhRows: [lhSaleRow('land', '어느 공고', '서울특별시', '분양주택', '토지임대부'), lhSaleRow('busan', '어느 공고', '부산광역시')],
    config: { ...fileConfig, lh: { ...fileConfig.lh, filterSaleArea: false } },
  });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.ok(!writtenKeys(fake).includes('LH-land'));
  assert.ok(writtenKeys(fake).includes('LH-busan'));
});

test('an LH rental with a 토지임대부 name is dropped by the LH filter when excludeRental is off', async () => {
  const fake = notionFake();
  const h = harness(fake, {
    rows: [remainderRow],
    lhRows: [lhSaleRow('rent', '토지임대부 분양주택 인근 국민임대', '서울특별시', '임대주택', '국민임대')],
    config: { ...fileConfig, excludeRental: false },
  });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.ok(!writtenKeys(fake).includes('LH-rent'));
  assert.ok(summary(h).includes(' rental_skipped=0 '), summary(h));
  assert.ok(summary(h).includes(' lh_out_of_scope_skipped=1 lh_out_of_scope_type=1 '), summary(h));
  // 분양이 아니라 지역 건수에 들어가지 않는다.
  assert.ok(h.logs.includes('lh_sale_regions none'), h.logs.join('|'));
});

test('a collected, kept LH notice is updated in place even when its stored values look out of scope', async () => {
  // 저장된 값만 보면 지역 밖(부산)이고 이름에 선택형이 있다. 임대 정리는 저장된 유형을 보므로 임대 아닌 유형으로 둔다.
  const fake = notionFake({ pages: [storedLh('LH-seoul', '분양주택 공공분양', '예전 뉴홈 선택형 이름', { region: '부산' })] });
  const h = harness(fake, { rows: [remainderRow], lhRows: [lhSaleRow('seoul', '서울 공공분양')] });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.deepEqual(archivedIds(fake), []);
  // 새로 만들지 않고 저장된 행을 갱신한다.
  assert.ok(rowWrites(fake).some((call) => call.method === 'PATCH' && call.path === '/pages/id-LH-seoul'));
  assert.equal(fake.state.created, 1);
  assert.ok(summary(h).includes(' lh_out_of_scope_archived=0 '), summary(h));
  assert.ok(summary(h).includes(' rental_archived=0 '), summary(h));
});

test('with the LH filter off nothing is skipped or archived for scope', async () => {
  const fake = lhWorld();
  const h = harness(fake, { ...lhSources, config: { ...fileConfig, lh: { ...fileConfig.lh, filterSaleArea: false } } });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.deepEqual(archivedIds(fake), []);
  for (const key of ['LH-goyang', 'LH-busan2', 'LH-select2']) assert.ok(writtenKeys(fake).includes(key), key);
  assert.ok(summary(h).includes(' lh_out_of_scope_skipped=0 '), summary(h));
});
