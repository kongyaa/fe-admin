import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run, selectInterest } from '../src/main.js';
import { buildKakaoText } from '../src/notify-kakao.js';
import { buildProperties, createNotionStore, parseExistingPage } from '../src/notion-store.js';

// 22:30 UTC는 KST로 다음 날이라, 오늘은 THU다.
const THU_NOW = '2026-11-04T22:30:00Z';
const THU = '2026-11-05';
const MON_NOW = '2026-11-01T22:30:00Z';
const MON = '2026-11-02';
const SECRET = 'SECRET-DATA-KEY';
const FALLBACK_LINK = 'https://www.applyhome.co.kr';
const LINK = 'https://www.applyhome.co.kr/interest';

const collected = (extra = {}) => ({
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
  ...extra,
});

function apiFetch({ rows = [], fail = false } = {}) {
  return async (url) => {
    const text = String(url);
    if (fail) return new Response('', { status: 500 });
    if (text.includes('getRemndrLttotPblancDetail')) return Response.json({ totalCount: rows.length, data: rows });
    if (text.includes('api.odcloud.kr')) return Response.json({ totalCount: 0, data: [] });
    if (text.includes('apis.data.go.kr/1613000')) return new Response('<r><resultCode>000</resultCode><totalCount>0</totalCount></r>');
    return Response.json([{ dsList: [] }]);
  };
}

// parseExistingPage가 돌려주는 모양의 행
const row = (extra = {}) => ({
  id: 'page-secret-id',
  key: 'k-1',
  name: '관심 단지',
  link: LINK,
  interest: true,
  lotto: '아님',
  start: THU,
  end: '2026-11-07',
  urgentDate: null,
  sequence: null,
  ...extra,
});

const rowsMap = (...rows) => new Map(rows.map((item) => [item.key, item]));

function fakeStore(existing = new Map(), weekly = null) {
  const state = { upserts: [], stamps: [], weekly, archived: [], initArgs: [] };
  return {
    state,
    init: async (options) => { state.initArgs.push(options); },
    loadExisting: async () => existing,
    upsert: async (item) => {
      state.upserts.push(item.key);
      return `page-${item.key}`;
    },
    stampUrgent: async (id, date) => { state.stamps.push({ id, date }); },
    getWeeklyState: async () => state.weekly,
    setWeeklyState: async (monday) => { state.weekly = monday; },
    archivePage: async (id) => { state.archived.push(id); },
    checkSequenceProperty: () => {},
    setSequenceNumber: async () => {},
  };
}

function harness({ store = fakeStore(), rows = [], fetch, sendKakao, sendMail, nowIso = THU_NOW, env = {} } = {}) {
  const mails = [];
  const kakao = [];
  const logs = [];
  return {
    store,
    mails,
    kakao,
    logs,
    env: { DATA_GO_KR_KEY: SECRET, NOTION_KEY: 'n', CHUNGYAK_NOTION_PAGE_ID: 'p', ...env },
    deps: {
      fetch: fetch ?? apiFetch({ rows }),
      store,
      accessToken: 'token',
      sleep: async () => {},
      now: () => new Date(nowIso),
      log: (line) => logs.push(line),
      write: () => {},
      sendMail: sendMail ?? (async (mail) => { mails.push(mail); }),
      sendKakao: sendKakao ?? (async (message) => { kakao.push(message); }),
    },
  };
}

const summaryLine = (h) => h.logs.find((line) => line.startsWith('collected='));
const dryRunLine = (h) => h.logs.find((line) => line.startsWith('dry-run '));
const errorMail = (h) => h.mails.find((mail) => mail.subject.includes('배치 오류'));

// 실제 createNotionStore를 쓰기 위한 Notion 가짜. 긴급 알림 발송일 기록만 다음 조회에 반영한다.
const notionPage = ({ id = 'id-1', key = 'k-1', name = '관심 단지', interest = { checkbox: true }, start = THU, end = '2026-11-07', urgent = null } = {}) => ({
  id,
  properties: {
    주택명: { title: [{ plain_text: name }] },
    '고유 키': { rich_text: [{ plain_text: key }] },
    '공고 링크': { url: LINK },
    '접수 시작일': { date: start ? { start } : null },
    '접수 종료일': { date: end ? { start: end } : null },
    '긴급 알림 발송일': { date: urgent ? { start: urgent } : null },
    순번: { number: null },
    ...(interest ? { 관심: interest } : {}),
  },
});

const COMPLETE_SCHEMA = { 순번: { type: 'number', number: {} }, 관심: { type: 'checkbox', checkbox: {} } };

function notionFake({ pages = [], databaseProperties = COMPLETE_SCHEMA, children, intercept = () => null } = {}) {
  const calls = [];
  const state = { pages };
  const list = children ?? [
    { id: 'db', type: 'child_database', child_database: { title: '청약 정보' } },
    { id: 'src', type: 'child_page', child_page: { title: '청약 수집 소스' } },
  ];
  const fetch = async (url, init) => {
    const path = new URL(url).pathname.replace('/v1', '');
    const body = init.body ? JSON.parse(init.body) : null;
    const call = { method: init.method, path, body };
    calls.push(call);
    const replaced = intercept(call);
    if (replaced) return replaced;
    if (init.method === 'GET' && path.startsWith('/blocks/')) return Response.json({ results: list, has_more: false });
    if (init.method === 'GET' && path.startsWith('/databases/')) return Response.json({ id: 'db', properties: databaseProperties });
    if (path.endsWith('/query')) return Response.json({ results: state.pages, has_more: false });
    if (init.method === 'PATCH' && path.startsWith('/pages/')) {
      const target = state.pages.find((item) => `/pages/${item.id}` === path);
      if (target && body.properties?.['긴급 알림 발송일']) target.properties['긴급 알림 발송일'] = body.properties['긴급 알림 발송일'];
    }
    return Response.json({ id: 'db' });
  };
  return { calls, fetch, state };
}

function realStore(fake) {
  return createNotionStore({
    key: 'k',
    parentPageId: 'parent',
    config: { notion: { databaseTitle: '청약 정보', sourcesPageTitle: '청약 수집 소스' } },
    sources: [],
    fetch: fake.fetch,
    minIntervalMs: 0,
    sleep: async () => {},
  });
}

function notionHarness(fake, { rows = [], ...options } = {}) {
  const base = apiFetch({ rows });
  const h = harness({
    ...options,
    fetch: async (url, init) => (String(url).includes('api.notion.com') ? fake.fetch(url, init) : base(url)),
  });
  h.deps.store = undefined;
  return h;
}

const schemaPatches = (fake) => fake.calls.filter((call) => call.method === 'PATCH' && call.path.startsWith('/databases/'));
const notionWrites = (fake) => fake.calls.filter((call) => call.method === 'PATCH' || (call.method === 'POST' && !call.path.endsWith('/query')));

test('parseExistingPage reads the check, name and link', () => {
  const parsed = parseExistingPage(notionPage());
  assert.equal(parsed.interest, true);
  assert.equal(parsed.name, '관심 단지');
  assert.equal(parsed.link, LINK);
  assert.equal(parsed.start, THU);

  assert.equal(parseExistingPage(notionPage({ interest: { checkbox: false } })).interest, false);
  const bare = parseExistingPage({ id: 'p', properties: {} });
  assert.equal(bare.interest, false);
  assert.equal(bare.name, '');
  assert.equal(bare.link, null);
});

test('parseExistingPage does not treat a same-named property of another type as checked', () => {
  for (const interest of [{ rich_text: [{ plain_text: 'true' }] }, { select: { name: '관심' } }, { checkbox: 'true' }]) {
    assert.equal(parseExistingPage(notionPage({ interest })).interest, false);
  }
});

test('selectInterest needs a check, a start of today, no stamp today and no lotto attempt in this run', () => {
  assert.equal(selectInterest([row()], THU).length, 1);
  assert.equal(selectInterest([row({ interest: false })], THU).length, 0);
  assert.equal(selectInterest([row({ start: '2026-11-04' })], THU).length, 0);
  assert.equal(selectInterest([row({ start: '2026-11-06' })], THU).length, 0);
  assert.equal(selectInterest([row({ start: null })], THU).length, 0);
  assert.equal(selectInterest([row({ urgentDate: THU })], THU).length, 0);
  assert.equal(selectInterest([row({ urgentDate: '2026-11-04' })], THU).length, 1);
  assert.equal(selectInterest([row()], THU, new Set(['k-1'])).length, 0);
  assert.equal(selectInterest([row()], THU, new Set(['other'])).length, 1);
});

test('selectInterest fills in the name, link and a single 접수 stage', () => {
  const [selected] = selectInterest([row()], THU);
  assert.deepEqual(selected.notice, { key: 'k-1', name: '관심 단지', url: LINK });
  assert.deepEqual(selected.stage, { name: '접수', start: THU, end: '2026-11-07' });
  assert.equal(selected.pageId, 'page-secret-id');

  const [noName] = selectInterest([row({ name: '' })], THU);
  assert.equal(noName.notice.name, 'k-1');
  for (const link of [null, 'javascript:alert(1)', 'ftp://x']) {
    assert.equal(selectInterest([row({ link })], THU)[0].notice.url, FALLBACK_LINK);
  }
  assert.equal(selectInterest([row({ end: null })], THU)[0].stage.end, null);
  assert.equal(selectInterest([row({ end: '2026-11-01' })], THU)[0].stage.end, null);
});

test('the Kakao prefix is an argument and lotto stays the default', () => {
  const stage = { name: '접수', start: THU, end: '2026-11-07' };
  const lotto = buildKakaoText({ notice: { name: '단지' }, stage: { name: '1순위', start: THU, end: THU } });
  assert.ok(lotto.startsWith('[로또 청약] 단지\n1순위 오늘 시작 2026-11-05\n'));

  const interest = buildKakaoText({ notice: { name: '단지' }, stage, prefix: '[관심 청약]' });
  assert.equal(interest, '[관심 청약] 단지\n접수 오늘 시작 2026-11-05~2026-11-07\n추정치이며 자격은 미판별. 공고문 확인 필수');
  const oneDay = buildKakaoText({ notice: { name: '단지' }, stage: { ...stage, end: null }, prefix: '[관심 청약]' });
  assert.ok(oneDay.includes('접수 오늘 시작 2026-11-05\n'));

  const long = buildKakaoText({ notice: { name: '긴 이름 '.repeat(100) }, stage, reason: '근거 '.repeat(200), prefix: '[관심 청약]' });
  assert.ok(Array.from(long).length <= 200);
  assert.ok(long.includes('공고문 확인 필수'));
});

test('a checked notice outside the alert regions alerts on its start date, whatever its lotto status', async () => {
  const store = fakeStore(rowsMap(row({ key: '7-7', lotto: '로또' })));
  const busan = collected({ SUBSCRPT_AREA_CODE_NM: '부산', HSSPLY_ADRES: '부산광역시 해운대구 우동 1' });
  const h = harness({ store, rows: [busan] });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.equal(h.kakao.length, 1);
  assert.ok(h.kakao[0].text.startsWith('[관심 청약] 관심 단지\n접수 오늘 시작 2026-11-05~2026-11-07\n'));
  assert.ok(h.kakao[0].text.includes('공고문 확인 필수'));
  assert.equal(h.kakao[0].url, LINK);
  assert.deepEqual(store.state.stamps, [{ id: 'page-secret-id', date: THU }]);
  assert.ok(summaryLine(h).includes(' interest=1 '));
  assert.ok(summaryLine(h).includes(' urgent=0 '));
  assert.equal(errorMail(h), undefined);
});

test('a checked non-lotto notice alerts too', async () => {
  const store = fakeStore(rowsMap(row({ lotto: '아님' }), row({ key: 'k-2', id: 'p2', lotto: null })));
  const h = harness({ store });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.equal(h.kakao.length, 2);
  assert.ok(summaryLine(h).includes(' interest=2 '));
});

test('an unchecked notice gets no interest alert', async () => {
  const store = fakeStore(rowsMap(row({ interest: false })));
  const h = harness({ store });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.equal(h.kakao.length, 0);
  assert.equal(store.state.stamps.length, 0);
  assert.ok(summaryLine(h).includes(' interest=0 '));
});

test('a checked notice whose start date is not today gets no alert', async () => {
  for (const start of ['2026-11-04', '2026-11-06', null]) {
    const store = fakeStore(rowsMap(row({ start })));
    const h = harness({ store });
    assert.equal(await run({ env: h.env, deps: h.deps }), 0);
    assert.equal(h.kakao.length, 0);
    assert.equal(store.state.stamps.length, 0);
  }
});

test('today is decided in KST', async () => {
  // 14:59 UTC는 KST로 23:59, 15:00 UTC는 KST로 다음 날이다.
  const before = harness({ store: fakeStore(rowsMap(row())), nowIso: '2026-11-04T14:59:00Z' });
  await run({ env: before.env, deps: before.deps });
  assert.equal(before.kakao.length, 0);
  const after = harness({ store: fakeStore(rowsMap(row())), nowIso: '2026-11-04T15:00:00Z' });
  await run({ env: after.env, deps: after.deps });
  assert.equal(after.kakao.length, 1);
});

test('a same-run lotto alert for the same notice wins and only one message goes out', async () => {
  const store = fakeStore(rowsMap(row({ key: '7-7', lotto: '로또', end: THU })));
  const h = harness({ store, rows: [collected()] });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.equal(h.kakao.length, 1);
  assert.ok(h.kakao[0].text.startsWith('[로또 청약] '));
  assert.equal(store.state.stamps.length, 1);
  assert.ok(summaryLine(h).includes(' urgent=1 '));
  assert.ok(summaryLine(h).includes(' interest=0 '));
});

test('a lotto stamp failure in the same run does not cause a second message', async () => {
  const base = fakeStore(rowsMap(row({ key: '7-7', lotto: '로또', end: THU })));
  const store = { ...base, stampUrgent: async () => { throw new Error('x'); } };
  const h = harness({ store, rows: [collected()] });
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.equal(h.kakao.length, 1);
  assert.ok(errorMail(h).text.includes('urgent_sent_without_stamp x1'));
});

test('a lost lotto alert is not retried as an interest alert in the same run', async () => {
  let attempts = 0;
  const store = fakeStore(rowsMap(row({ key: '7-7', lotto: '로또', end: THU })));
  const mails = [];
  const h = harness({
    store,
    rows: [collected()],
    sendKakao: async () => {
      attempts += 1;
      throw new Error('x');
    },
    sendMail: async (mail) => {
      if (mail.subject.startsWith('[청약 긴급]')) throw new Error('x');
      mails.push(mail);
    },
  });
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.equal(attempts, 1);
  assert.equal(store.state.stamps.length, 0);
  assert.ok(mails.some((mail) => mail.text.includes('urgent_lost x1')));
});

test('a lotto alert for one notice and an interest alert for another both go out', async () => {
  const store = fakeStore(rowsMap(row()));
  const h = harness({ store, rows: [collected()] });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.deepEqual(h.kakao.map((message) => message.text.slice(0, 7)), ['[로또 청약]', '[관심 청약]']);
  assert.deepEqual(store.state.stamps.map((stamp) => stamp.id), ['page-7-7', 'page-secret-id']);
});

test('a notice already stamped today gets nothing, an older stamp does not block', async () => {
  const stamped = fakeStore(rowsMap(row({ urgentDate: THU })));
  const h = harness({ store: stamped });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.equal(h.kakao.length, 0);
  assert.equal(stamped.state.stamps.length, 0);

  const older = fakeStore(rowsMap(row({ urgentDate: '2026-11-04' })));
  const again = harness({ store: older });
  await run({ env: again.env, deps: again.deps });
  assert.equal(again.kakao.length, 1);
});

test('the second daily run sends nothing after the first stamped the page', async () => {
  const fake = notionFake({ pages: [notionPage()] });
  const first = notionHarness(fake);
  assert.equal(await run({ env: first.env, deps: first.deps }), 0);
  assert.equal(first.kakao.length, 1);
  assert.equal(fake.state.pages[0].properties['긴급 알림 발송일'].date.start, THU);

  const second = notionHarness(fake, { nowIso: '2026-11-05T01:00:00Z' });
  assert.equal(await run({ env: second.env, deps: second.deps }), 0);
  assert.equal(second.kakao.length, 0);
});

test('an interest alert sent earlier today also stops a later lotto alert', async () => {
  const store = fakeStore(rowsMap(row({ key: '7-7', urgentDate: THU, lotto: '아님', end: THU })));
  const h = harness({ store, rows: [collected()] });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.equal(h.kakao.length, 0);
});

test('the alert still goes when every source fails', async () => {
  const store = fakeStore(rowsMap(row()));
  const h = harness({ store, fetch: apiFetch({ fail: true }) });
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.equal(h.kakao.length, 1);
  assert.ok(h.kakao[0].text.startsWith('[관심 청약]'));
  assert.equal(store.state.stamps.length, 1);
  assert.ok(errorMail(h).text.includes('applyhome_http_500'));
});

test('the alert still goes without a data key and when the source no longer returns the notice', async () => {
  const noKey = harness({ store: fakeStore(rowsMap(row())), env: { DATA_GO_KR_KEY: '' } });
  await run({ env: noKey.env, deps: noKey.deps });
  assert.equal(noKey.kakao.length, 1);

  const gone = harness({ store: fakeStore(rowsMap(row())), rows: [] });
  assert.equal(await run({ env: gone.env, deps: gone.deps }), 0);
  assert.equal(gone.kakao.length, 1);
});

test('a row without a usable link and name falls back in Kakao and in mail', async () => {
  const h = harness({ store: fakeStore(rowsMap(row({ link: 'javascript:alert(1)', name: '' }))) });
  await run({ env: h.env, deps: h.deps });
  assert.equal(h.kakao[0].url, FALLBACK_LINK);
  assert.ok(h.kakao[0].text.startsWith('[관심 청약] k-1\n'));

  const viaMail = harness({
    store: fakeStore(rowsMap(row({ link: null }))),
    sendKakao: async () => { throw new Error('x'); },
  });
  await run({ env: viaMail.env, deps: viaMail.deps });
  const urgent = viaMail.mails.find((mail) => mail.subject.startsWith('[청약 긴급]'));
  assert.ok(urgent.text.includes(FALLBACK_LINK));
});

test('Kakao failure falls back to mail and still stamps', async () => {
  const store = fakeStore(rowsMap(row()));
  const h = harness({ store, sendKakao: async () => { throw new Error('https://kapi.kakao.com secret'); } });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  const urgent = h.mails.find((mail) => mail.subject.startsWith('[청약 긴급]'));
  assert.ok(urgent.subject.includes('관심 단지'));
  assert.ok(urgent.text.startsWith('[관심 청약] 관심 단지'));
  assert.ok(urgent.text.includes(LINK));
  assert.deepEqual(store.state.stamps, [{ id: 'page-secret-id', date: THU }]);
  assert.ok(summaryLine(h).includes(' interest=1 '));
  assert.ok(summaryLine(h).includes(' urgentMailFallback=1 '));
  assert.ok(!errorMail(h).text.includes('kakao.com'));
});

test('a lost interest alert fails the job like a lost lotto alert and leaves no stamp', async () => {
  const mails = [];
  const store = fakeStore(rowsMap(row()));
  const h = harness({
    store,
    sendKakao: async () => { throw new Error('x'); },
    sendMail: async (mail) => {
      if (mail.subject.startsWith('[청약 긴급]')) throw new Error('x');
      mails.push(mail);
    },
  });
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.equal(store.state.stamps.length, 0);
  assert.ok(mails.some((mail) => mail.text.includes('urgent_lost x1')));
  assert.ok(summaryLine(h).includes(' interest=0 '));
});

test('a failed stamp is reported as sent without a stamp and fails the job', async () => {
  const store = { ...fakeStore(rowsMap(row())), stampUrgent: async () => { throw new Error('https://api.notion.com'); } };
  const h = harness({ store });
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.equal(h.kakao.length, 1);
  assert.ok(errorMail(h).text.includes('urgent_sent_without_stamp x1'));
  assert.ok(!errorMail(h).text.includes('api.notion.com'));
});

test('a Notion outage while stamping keeps the alert and reports it', async () => {
  const fake = notionFake({
    pages: [notionPage()],
    intercept: (call) => {
      if (call.method === 'PATCH' && call.body?.properties?.['긴급 알림 발송일']) throw new TypeError('fetch failed');
      return null;
    },
  });
  const h = notionHarness(fake);
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.equal(h.kakao.length, 1);
  assert.ok(errorMail(h).text.includes('urgent_sent_without_stamp x1'));
  assert.ok(errorMail(h).text.includes('notion_network'));
});

test('no interest alert can be decided when Notion cannot be read, and the failure is reported', async () => {
  const store = { ...fakeStore(rowsMap(row())), init: async () => { throw Object.assign(new Error('x'), { code: 'NOTION_DOWN' }); } };
  const h = harness({ store });
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.equal(h.kakao.length, 0);
  assert.ok(errorMail(h).text.includes('error_NOTION_DOWN'));
});

test('upserts never touch the check', async () => {
  const props = buildProperties(
    { key: 'k', name: 'n', typeLabel: 'APT', stages: [], overallStart: THU, overallEnd: THU, url: LINK },
    { status: '로또' },
    THU,
  );
  assert.equal(Object.hasOwn(props, '관심'), false);

  const fake = notionFake({ pages: [notionPage({ key: '7-7', end: THU })] });
  const h = notionHarness(fake, { rows: [collected(), collected({ HOUSE_MANAGE_NO: '9' })] });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  const upserts = fake.calls.filter((call) => call.body?.properties?.['고유 키']);
  assert.equal(upserts.length, 2);
  assert.ok(upserts.some((call) => call.method === 'PATCH'));
  assert.ok(upserts.some((call) => call.method === 'POST'));
  const pageWrites = notionWrites(fake).filter((call) => call.path.startsWith('/pages'));
  assert.ok(pageWrites.length > 2);
  assert.ok(pageWrites.every((call) => !Object.hasOwn(call.body.properties ?? {}, '관심')));
});

test('init adds the property only when it is missing', async () => {
  const missing = notionFake({ databaseProperties: { 순번: { type: 'number', number: {} } } });
  await realStore(missing).init();
  assert.deepEqual(schemaPatches(missing), [{
    method: 'PATCH',
    path: '/databases/db',
    body: { properties: { 관심: { checkbox: {} } } },
  }]);

  const present = notionFake();
  await realStore(present).init();
  assert.deepEqual(schemaPatches(present), []);
});

test('a same-named property of another type is left alone and nothing is alerted from it', async () => {
  const fake = notionFake({
    databaseProperties: { 순번: { type: 'number', number: {} }, 관심: { type: 'rich_text', rich_text: {} } },
    pages: [notionPage({ interest: { type: 'rich_text', rich_text: [{ plain_text: '체크' }] } })],
  });
  const h = notionHarness(fake, { rows: [collected()] });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.deepEqual(schemaPatches(fake), []);
  assert.equal(h.kakao.length, 1);
  assert.ok(h.kakao[0].text.startsWith('[로또 청약]'));
  assert.ok(summaryLine(h).includes(' created=1 '));
});

for (const [label, method, path] of [
  ['adding the property', 'PATCH', '/databases/db'],
  ['reading the schema', 'GET', '/databases/db'],
]) {
  test(`a failure while ${label} does not stop collection or alerts`, async () => {
    const fake = notionFake({
      databaseProperties: { 순번: { type: 'number', number: {} } },
      pages: [notionPage()],
      intercept: (call) => (call.method === method && call.path === path ? new Response('', { status: 403 }) : null),
    });
    const h = notionHarness(fake, { rows: [collected()] });
    assert.equal(await run({ env: h.env, deps: h.deps }), 0);
    assert.ok(summaryLine(h).includes(' created=1 '));
    assert.deepEqual(h.kakao.map((message) => message.text.slice(0, 7)), ['[로또 청약]', '[관심 청약]']);
  });
}

test('a new database carries the property as its last column', async () => {
  const fake = notionFake({ children: [] });
  await realStore(fake).init();
  const created = fake.calls.find((call) => call.path === '/databases');
  assert.equal(Object.keys(created.body.properties).at(-1), '관심');
  assert.deepEqual(created.body.properties.관심, { checkbox: {} });
  assert.deepEqual(schemaPatches(fake), []);
});

test('dry-run sends and writes nothing and logs only a candidate count', async () => {
  const fake = notionFake({
    databaseProperties: {},
    pages: [
      notionPage({ id: 'secret-a', key: 'k-a', name: '비밀 단지 A' }),
      notionPage({ id: 'secret-b', key: 'k-b', name: '비밀 단지 B' }),
      notionPage({ id: 'secret-c', key: 'k-c', interest: { checkbox: false } }),
      notionPage({ id: 'secret-d', key: 'k-d', urgent: THU }),
    ],
  });
  const h = notionHarness(fake);
  assert.equal(await run({ argv: ['--dry-run'], env: h.env, deps: h.deps }), 0);
  assert.equal(h.kakao.length, 0);
  assert.equal(h.mails.length, 0);
  assert.deepEqual(notionWrites(fake), []);
  assert.ok(dryRunLine(h).endsWith(' interest_candidates=2'));
  assert.ok(summaryLine(h).includes(' interest=0 '));
  const output = h.logs.join('\n');
  for (const secret of ['비밀 단지', 'secret-a', LINK]) assert.ok(!output.includes(secret), secret);
});

test('dry-run does not create a missing database and logs no candidate count', async () => {
  const fake = notionFake({ children: [] });
  const h = notionHarness(fake);
  assert.equal(await run({ argv: ['--dry-run'], env: h.env, deps: h.deps }), 0);
  assert.deepEqual(notionWrites(fake), []);
  assert.ok(!dryRunLine(h).includes('interest_candidates'));
  assert.ok(h.logs.includes('errors=notion_database_missing:1'));
});

test('dry-run without Notion settings makes no Notion call and logs no candidate count', async () => {
  const fake = notionFake({ pages: [notionPage()] });
  const h = notionHarness(fake);
  assert.equal(await run({ argv: ['--dry-run'], env: { DATA_GO_KR_KEY: SECRET }, deps: h.deps }), 0);
  assert.equal(fake.calls.length, 0);
  assert.ok(!dryRunLine(h).includes('interest_candidates'));
});

test('a Notion read failure in dry-run does not change the exit code', async () => {
  const fake = notionFake({ intercept: (call) => (call.path.endsWith('/query') ? new Response('', { status: 400 }) : null) });
  const h = notionHarness(fake);
  assert.equal(await run({ argv: ['--dry-run'], env: h.env, deps: h.deps }), 0);
  assert.ok(!dryRunLine(h).includes('interest_candidates'));
  assert.equal(h.mails.length, 0);
});

test('dry-run reads through a store without its schema changes and leaves the rest of the run as before', async () => {
  // 저장된 종료일이 지난 행을 existing으로 쓰면 이 공고는 skipped가 된다.
  const store = fakeStore(rowsMap(row({ key: '7-7', end: '2026-11-01' }), row()));
  const h = harness({ store, rows: [collected()] });
  assert.equal(await run({ argv: ['--dry-run'], env: h.env, deps: h.deps }), 0);
  assert.deepEqual(store.state.initArgs, [{ createMissing: false }]);
  assert.deepEqual(store.state.upserts, []);
  assert.deepEqual(store.state.stamps, []);
  assert.equal(h.kakao.length, 0);
  assert.ok(summaryLine(h).includes(' skipped=0 '));
  assert.ok(summaryLine(h).includes(' evaluated=1 '));
  // 7-7은 로또 알림 대상이라 관심 후보에서 빠진다.
  assert.ok(dryRunLine(h).endsWith(' urgent_candidates=1 interest_candidates=1'));
});

test('test-send sends no interest alert and does not read Notion', async () => {
  const store = { ...fakeStore(rowsMap(row())), init: async () => { throw new Error('must not be called'); } };
  const h = harness({ store });
  assert.equal(await run({ env: { CHUNGYAK_MODE: 'test-send' }, deps: h.deps }), 0);
  assert.equal(h.kakao.length, 1);
  assert.ok(h.kakao[0].text.startsWith('[로또 청약]'));
});

test('cleanup-ended sends no interest alert', async () => {
  const store = fakeStore(rowsMap(row()));
  const h = harness({ store });
  assert.equal(await run({ env: { ...h.env, CHUNGYAK_MODE: 'cleanup-ended' }, deps: h.deps }), 0);
  assert.equal(h.kakao.length, 0);
  assert.equal(h.mails.length, 0);
  assert.deepEqual(store.state.stamps, []);
});

test('logs stay count-only on a sending run', async () => {
  const store = fakeStore(rowsMap(row({ name: '비밀 단지', id: 'secret-id' })));
  const h = harness({ store, sendKakao: async () => { throw new Error('x'); } });
  await run({ env: h.env, deps: h.deps });
  const output = h.logs.join('\n');
  for (const secret of ['비밀 단지', 'secret-id', LINK, 'k-1', SECRET, 'token']) assert.ok(!output.includes(secret), secret);
});

test('on a run that archives, the alert and its stamp come first and a stale end date is not shown', async () => {
  const events = [];
  const stale = row({ id: 'stale', start: MON, end: '2026-11-01' });
  const base = fakeStore(rowsMap(stale));
  const store = {
    ...base,
    setWeeklyState: async () => { events.push('state'); },
    stampUrgent: async () => { events.push('stamp'); },
    archivePage: async () => { events.push('archive'); },
  };
  const h = harness({
    store,
    nowIso: MON_NOW,
    sendMail: async () => { events.push('mail'); },
    sendKakao: async ({ text }) => {
      events.push('kakao');
      assert.ok(text.includes(`접수 오늘 시작 ${MON}\n`));
    },
  });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.deepEqual(events, ['mail', 'state', 'kakao', 'stamp', 'archive']);
});
