import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dedupeNotices, parseFlags, run, selectUrgent, selectWeekly, shouldSendWeekly } from '../src/main.js';
import { refreshKakaoToken, runRefresh } from '../src/kakao-refresh.js';
import { buildErrorMail, buildWeeklyMail, createGmailSender } from '../src/notify-gmail.js';
import { buildKakaoText, sendKakaoMemo } from '../src/notify-kakao.js';
import { buildProperties, createNotionStore, parseExistingPage } from '../src/notion-store.js';

const THU = '2026-11-05';
const notice = (extra = {}) => ({
  key: '1-1',
  name: '테스트',
  region: '서울',
  typeLabel: 'APT',
  url: 'https://www.applyhome.co.kr/a',
  stages: [{ name: '1순위 해당', start: THU, end: THU }],
  ...extra,
});
const regions = ['서울', '경기', '인천'];

test('urgent selection needs lotto, alert region and a stage starting today', () => {
  const base = { notice: notice(), status: '로또', urgentDate: null, pageId: 'p' };
  assert.equal(selectUrgent([base], THU, regions).length, 1);
  assert.equal(selectUrgent([{ ...base, status: '아님' }], THU, regions).length, 0);
  assert.equal(selectUrgent([{ ...base, notice: notice({ region: '부산' }) }], THU, regions).length, 0);
  assert.equal(selectUrgent([base], '2026-11-06', regions).length, 0);
});

test('urgent selection skips a notice already sent today', () => {
  const base = { notice: notice(), status: '로또', pageId: 'p' };
  assert.equal(selectUrgent([{ ...base, urgentDate: THU }], THU, regions).length, 0);
  assert.equal(selectUrgent([{ ...base, urgentDate: '2026-11-04' }], THU, regions).length, 1);
});

test('weekly gate opens Monday to Wednesday until stamped', () => {
  assert.equal(shouldSendWeekly('2026-11-02', null), true);
  assert.equal(shouldSendWeekly('2026-11-03', '2026-10-26'), true);
  assert.equal(shouldSendWeekly('2026-11-04', '2026-10-26'), true);
  assert.equal(shouldSendWeekly('2026-11-05', '2026-10-26'), false);
  assert.equal(shouldSendWeekly('2026-11-01', null), false);
  assert.equal(shouldSendWeekly('2026-11-02', '2026-11-02'), false);
  assert.equal(shouldSendWeekly('2026-11-05', '2026-11-02', true), true);
});

test('weekly selection overlaps the week and sorts by first stage in it', () => {
  const stageNotice = (key, start, end, region = '서울') => ({
    notice: notice({ key, region, stages: [{ name: '접수', start, end }] }),
    status: null,
  });
  const items = selectWeekly([
    stageNotice('later', '2026-11-06', '2026-11-06'),
    stageNotice('spanning', '2026-10-30', '2026-11-02'),
    stageNotice('past', '2026-10-30', '2026-11-01'),
    stageNotice('next', '2026-11-09', '2026-11-10'),
    stageNotice('busan', '2026-11-03', '2026-11-03', '부산'),
  ], '2026-11-02', '2026-11-08', regions);
  assert.deepEqual(items.map((item) => item.notice.key), ['spanning', 'later']);
});

test('weekly mail escapes HTML, marks lotto, carries the disclaimer and drops bad links', () => {
  const mail = buildWeeklyMail({
    items: [{
      notice: notice({ name: '<script>x</script>', url: 'javascript:alert(1)' }),
      status: '로또',
      weekStages: [{ name: '접수', start: THU, end: THU }],
    }],
    monday: '2026-11-02',
    sunday: '2026-11-08',
  });
  assert.ok(!mail.html.includes('<script>'));
  assert.ok(mail.html.includes('&lt;script&gt;'));
  assert.ok(mail.html.includes('[로또]'));
  assert.ok(!mail.html.includes('javascript:'));
  assert.ok(mail.html.includes('추정치'));
});

test('Gmail transport is created with bounded timeouts', async () => {
  let options;
  const send = createGmailSender({
    user: 'u',
    password: 'p',
    to: 't',
    createTransport: (received) => {
      options = received;
      return { sendMail: async () => {} };
    },
  });
  await send({ subject: 's', text: 't', html: 'h' });
  assert.equal(options.connectionTimeout, 15000);
  assert.equal(options.greetingTimeout, 15000);
  assert.equal(options.socketTimeout, 60000);
  assert.equal(options.dnsTimeout, 10000);
});

test('Kakao text is at most 200 characters and keeps the disclaimer', () => {
  const text = buildKakaoText({
    notice: { name: '아주 긴 이름 '.repeat(50) },
    stage: { name: '1순위 해당', start: THU, end: '2026-11-06' },
    reason: '근거 '.repeat(200),
  });
  assert.ok(Array.from(text).length <= 200);
  assert.ok(text.includes('추정치'));
  assert.ok(text.includes('공고문'));
});

test('Kakao send posts the template and rejects a non-zero result', async () => {
  let captured;
  await sendKakaoMemo({
    token: 't',
    text: 'x'.repeat(500),
    url: 'https://www.applyhome.co.kr/a',
    fetch: async (url, init) => {
      captured = { url, init };
      return Response.json({ result_code: 0 });
    },
  });
  const template = JSON.parse(captured.init.body.get('template_object'));
  assert.equal(template.object_type, 'text');
  assert.equal(template.text.length, 200);
  assert.equal(template.link.web_url, 'https://www.applyhome.co.kr/a');
  assert.equal(template.button_title, '공고 보기');
  await assert.rejects(
    sendKakaoMemo({ token: 't', text: 'x', fetch: async () => Response.json({ result_code: 1 }) }),
    { kind: 'kakao_send_rejected' },
  );
  await assert.rejects(sendKakaoMemo({ token: null, text: 'x', fetch: async () => { throw new Error('no'); } }), { kind: 'kakao_token_missing' });
});

test('Kakao refresh reports rotation only when a new token is returned', async () => {
  const plain = await refreshKakaoToken({ restKey: 'r', refreshToken: 'old', fetch: async () => Response.json({ access_token: 'a' }) });
  assert.deepEqual(plain, { accessToken: 'a', rotatedRefreshToken: null });

  let form;
  const rotated = await refreshKakaoToken({
    restKey: 'r',
    clientSecret: 's',
    refreshToken: 'old',
    fetch: async (_url, init) => {
      form = init.body;
      return Response.json({ access_token: 'a', refresh_token: 'new' });
    },
  });
  assert.equal(rotated.rotatedRefreshToken, 'new');
  assert.equal(form.get('client_secret'), 's');
  assert.equal(form.get('grant_type'), 'refresh_token');
});

test('runRefresh masks tokens and writes the rotated file only when rotated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chungyak-'));
  try {
    const env = { GITHUB_ACTIONS: 'true', RUNNER_TEMP: dir, KAKAO_REST_KEY: 'r', KAKAO_REFRESH_TOKEN: 'old' };
    const lines = [];
    await runRefresh({ env, write: (line) => lines.push(line), fetch: async () => Response.json({ access_token: 'acc' }) });
    assert.equal(readFileSync(join(dir, 'kakao_access'), 'utf8'), 'acc');
    assert.equal(existsSync(join(dir, 'kakao_refresh')), false);
    assert.deepEqual(lines, ['::add-mask::acc']);

    await runRefresh({ env, write: (line) => lines.push(line), fetch: async () => Response.json({ access_token: 'acc', refresh_token: 'new' }) });
    assert.equal(readFileSync(join(dir, 'kakao_refresh'), 'utf8'), 'new');
    assert.ok(lines.includes('::add-mask::new'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('modes come from env, invalid mode rejected, --print is ignored in CI', () => {
  assert.equal(parseFlags([], { CHUNGYAK_MODE: 'dry-run' }).dryRun, true);
  assert.equal(parseFlags([], { CHUNGYAK_MODE: 'force-weekly' }).forceWeekly, true);
  assert.equal(parseFlags([], { CHUNGYAK_MODE: '' }).dryRun, false);
  assert.equal(parseFlags([], { CHUNGYAK_MODE: 'evil; rm -rf' }), null);
  assert.equal(parseFlags([], { CHUNGYAK_MODE: 'constructor' }), null);
  assert.equal(parseFlags(['--print'], {}).dryRun, true);
  assert.equal(parseFlags(['--print'], { GITHUB_ACTIONS: 'true' }).print, false);
});

test('dedupe keeps one notice per key', () => {
  assert.equal(dedupeNotices([notice(), notice(), notice({ key: '2' })]).length, 2);
});

test('error mail escapes kinds and Notion properties skip empty values', () => {
  const mail = buildErrorMail(new Map([['<x>', 2]]), THU);
  assert.ok(mail.html.includes('&lt;x&gt; x2'));

  const props = buildProperties(notice({ overallStart: THU, overallEnd: THU, url: 'ftp://x' }), null, THU);
  assert.equal(props['로또 여부'], undefined);
  assert.equal(props['공고 링크'], undefined);
  assert.equal(props['긴급 알림 발송일'], undefined);
  assert.deepEqual(props['1순위 접수일'], { date: { start: THU } });
  assert.deepEqual(props['마지막 수집일'], { date: { start: THU } });

  const select = buildProperties(notice({ typeLabel: 'a,b' }), { status: '로또', rate: 0.25 }, THU);
  assert.equal(select['유형'].select.name, 'a b');
  assert.equal(select['차익률'].number, 0.25);

  const parsed = parseExistingPage({
    id: 'p',
    properties: {
      '고유 키': { rich_text: [{ plain_text: '1-1' }] },
      '로또 여부': { select: { name: '로또' } },
      '긴급 알림 발송일': { date: { start: THU } },
      '접수 종료일': { date: null },
    },
  });
  assert.deepEqual(parsed, { id: 'p', key: '1-1', lotto: '로또', urgentDate: THU, end: null });
});

function notionFake(children = []) {
  const calls = [];
  const fetch = async (url, init) => {
    const path = new URL(url).pathname.replace('/v1', '');
    calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    if (init.method === 'GET') return Response.json({ results: children, has_more: false });
    if (path === '/databases') return Response.json({ id: 'db' });
    if (path.endsWith('/query')) return Response.json({ results: [], has_more: false });
    return Response.json({ id: 'new-page' });
  };
  return { calls, fetch };
}

const notionConfig = { notion: { databaseTitle: '청약 정보', sourcesPageTitle: '소스' } };

test('Notion store creates the database and sources page once', async () => {
  const fresh = notionFake();
  const store = createNotionStore({ key: 'k', parentPageId: 'parent', config: notionConfig, sources: ['a'], fetch: fresh.fetch, minIntervalMs: 0 });
  await store.init();
  assert.ok(fresh.calls.some((call) => call.path === '/databases'));
  assert.ok(fresh.calls.some((call) => call.path === '/pages' && call.body.children?.length === 1));
  assert.equal(fresh.calls[0].headers['Notion-Version'], '2022-06-28');

  const ready = notionFake([
    { id: 'db1', type: 'child_database', child_database: { title: '청약 정보' } },
    { id: 's1', type: 'child_page', child_page: { title: '소스' } },
  ]);
  const again = createNotionStore({ key: 'k', parentPageId: 'parent', config: notionConfig, sources: ['a'], fetch: ready.fetch, minIntervalMs: 0 });
  await again.init();
  assert.ok(!ready.calls.some((call) => call.method === 'POST'));
});

test('weekly state reads the Monday from the title and updates it in place', async () => {
  const fake = notionFake([
    { id: 'db1', type: 'child_database', child_database: { title: '청약 정보' } },
    { id: 's1', type: 'child_page', child_page: { title: '소스' } },
    { id: 'st', type: 'child_page', child_page: { title: '청약 배치 상태 2026-10-26' } },
  ]);
  const store = createNotionStore({ key: 'k', parentPageId: 'parent', config: notionConfig, sources: [], fetch: fake.fetch, minIntervalMs: 0 });
  await store.init();
  assert.equal(await store.getWeeklyState(), '2026-10-26');
  await store.setWeeklyState('2026-11-02');
  assert.equal(await store.getWeeklyState(), '2026-11-02');
  assert.ok(fake.calls.some((call) => call.method === 'PATCH' && call.path === '/pages/st'));
});

const readyChildren = [
  { id: 'db1', type: 'child_database', child_database: { title: '청약 정보' } },
  { id: 's1', type: 'child_page', child_page: { title: '소스' } },
];

test('Notion store HTTP errors do not trip the outage guard', async () => {
  let posts = 0;
  const fake = notionFake(readyChildren);
  const store = createNotionStore({
    key: 'k',
    parentPageId: 'parent',
    config: notionConfig,
    sources: [],
    minIntervalMs: 0,
    sleep: async () => {},
    fetch: async (url, init) => {
      if (init.method === 'POST' && new URL(url).pathname === '/v1/pages') {
        posts += 1;
        return new Response('', { status: 403 });
      }
      return fake.fetch(url, init);
    },
  });
  await store.init();
  const item = notice({ overallStart: THU, overallEnd: THU });
  await assert.rejects(store.upsert(item, null, undefined, THU), { kind: 'notion_http_403' });
  await assert.rejects(store.upsert(item, null, undefined, THU), { kind: 'notion_http_403' });
  assert.equal(posts, 2);
  assert.equal(await store.getWeeklyState(), null);
});

test('Notion outage state belongs to one store, and a stalled response body trips it', async () => {
  const fake = notionFake(readyChildren);
  let calls = 0;
  const options = {
    key: 'k',
    parentPageId: 'parent',
    config: notionConfig,
    sources: [],
    minIntervalMs: 0,
    sleep: async () => {},
    fetch: async (url, init) => {
      if (init.method === 'PATCH') {
        calls += 1;
        return { ok: true, json: async () => { throw Object.assign(new Error('https://api.notion.com'), { name: 'TimeoutError' }); } };
      }
      return fake.fetch(url, init);
    },
  };
  const store = createNotionStore(options);
  await store.init();
  await assert.rejects(store.stampUrgent('p', THU), { kind: 'notion_timeout' });
  assert.equal(calls, 1);
  await assert.rejects(store.stampUrgent('p', THU), { kind: 'notion_timeout' });
  await assert.rejects(store.setWeeklyState('2026-11-02'), { kind: 'notion_timeout' });
  await assert.rejects(store.getWeeklyState(), { kind: 'notion_timeout' });
  assert.equal(calls, 1);

  const nextRun = createNotionStore(options);
  await nextRun.init();
  await assert.rejects(nextRun.stampUrgent('p', THU), { kind: 'notion_timeout' });
  assert.equal(calls, 2);
});

// run() 통합 테스트용 가짜
const SECRET = 'SECRET-DATA-KEY';
const remainderRow = (start, extra = {}) => ({
  HOUSE_MANAGE_NO: '7',
  PBLANC_NO: '7',
  HOUSE_NM: '무순위 단지',
  HOUSE_SECD: '04',
  SUBSCRPT_AREA_CODE_NM: '서울',
  HSSPLY_ADRES: '서울특별시 강남구 역삼동 1',
  RCRIT_PBLANC_DE: '2026-11-01',
  SUBSCRPT_RCEPT_BGNDE: start,
  SUBSCRPT_RCEPT_ENDDE: start,
  PBLANC_URL: 'https://www.applyhome.co.kr/a',
  ...extra,
});

function apiFetch({ rows = [remainderRow(THU)], fail = false } = {}) {
  return async (url) => {
    const text = String(url);
    if (fail) return new Response(`denied ${text}`, { status: 500 });
    if (text.includes('getRemndrLttotPblancDetail')) return Response.json({ totalCount: rows.length, data: rows });
    if (text.includes('api.odcloud.kr')) return Response.json({ totalCount: 0, data: [] });
    if (text.includes('apis.data.go.kr/1613000')) return new Response('<r><resultCode>000</resultCode><totalCount>0</totalCount></r>');
    return Response.json([{ dsList: [] }]);
  };
}

function fakeStore(existing = new Map(), weekly = null) {
  const state = { upserts: [], stamps: [], weekly };
  return {
    state,
    init: async () => {},
    loadExisting: async () => existing,
    upsert: async (item, evaluation) => {
      state.upserts.push({ key: item.key, evaluation });
      return `page-${item.key}`;
    },
    stampUrgent: async (id, date) => state.stamps.push({ id, date }),
    getWeeklyState: async () => state.weekly,
    setWeeklyState: async (monday) => { state.weekly = monday; },
  };
}

function harness({ store = fakeStore(), fetch = apiFetch(), sendKakao, sendMail, nowIso = '2026-11-04T22:30:00Z', accessToken = 'token', env = {} } = {}) {
  const mails = [];
  const kakao = [];
  const logs = [];
  const deps = {
    fetch,
    store,
    accessToken,
    sleep: async () => {},
    now: () => new Date(nowIso),
    log: (line) => logs.push(line),
    write: () => {},
    sendMail: sendMail ?? (async (mail) => { mails.push(mail); }),
    sendKakao: sendKakao ?? (async (message) => { kakao.push(message); }),
  };
  const fullEnv = { DATA_GO_KR_KEY: SECRET, NOTION_KEY: 'n', CHUNGYAK_NOTION_PAGE_ID: 'p', ...env };
  return { deps, env: fullEnv, mails, kakao, logs, store };
}

test('run sends one Kakao and stamps; a same-day rerun does not resend', async () => {
  const h = harness();
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.equal(h.kakao.length, 1);
  assert.ok(Array.from(h.kakao[0].text).length <= 200);
  assert.deepEqual(h.store.state.stamps, [{ id: 'page-7-7', date: THU }]);

  const stamped = new Map([['7-7', { id: 'page-7-7', key: '7-7', lotto: '로또', urgentDate: THU, end: THU }]]);
  const rerun = harness({ store: fakeStore(stamped) });
  assert.equal(await run({ env: rerun.env, deps: rerun.deps }), 0);
  assert.equal(rerun.kakao.length, 0);
  assert.equal(rerun.store.state.stamps.length, 0);
});

test('Kakao failure falls back to mail with the same content and still stamps', async () => {
  const h = harness({ sendKakao: async () => { throw new Error('https://kapi.kakao.com secret'); } });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  const urgent = h.mails.find((mail) => mail.subject.startsWith('[청약 긴급]'));
  assert.ok(urgent);
  assert.ok(urgent.text.includes('무순위 단지'));
  assert.equal(h.store.state.stamps.length, 1);
  const summary = h.mails.find((mail) => mail.subject.includes('배치 오류'));
  assert.ok(summary.text.includes('unexpected_error'));
  assert.ok(!summary.text.includes('kakao.com'));
});

test('no stamp when both channels fail, and the job fails', async () => {
  const mails = [];
  const h = harness({
    sendKakao: async () => { throw new Error('x'); },
    sendMail: async (mail) => {
      if (mail.subject.startsWith('[청약 긴급]')) throw new Error('x');
      mails.push(mail);
    },
  });
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.equal(h.store.state.stamps.length, 0);
  const summary = mails.find((mail) => mail.subject.includes('배치 오류'));
  assert.ok(summary.text.includes('urgent_lost'));
});

test('a stalled MOLIT API costs one retry cycle and flag notices still alert as 로또', async () => {
  const rows = [
    remainderRow(THU),
    remainderRow(THU, { HOUSE_MANAGE_NO: '8', HSSPLY_ADRES: '서울특별시 서초구 반포동 1' }),
  ];
  const base = apiFetch({ rows });
  let molitCalls = 0;
  const h = harness({
    fetch: async (url) => {
      if (String(url).includes('1613000')) {
        molitCalls += 1;
        throw new TypeError('fetch failed');
      }
      if (String(url).includes('getRemndrLttotPblancMdl')) {
        return Response.json({ totalCount: 1, data: [{ HOUSE_TY: '084A', LTTOT_TOP_AMOUNT: '100,000' }] });
      }
      return base(url);
    },
  });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.equal(molitCalls, 3);
  assert.equal(h.kakao.length, 2);
  assert.ok(h.store.state.upserts.every((item) => item.evaluation.status === '로또'));
  assert.ok(h.mails.some((mail) => mail.text.includes('molit_network')));
});

test('a stalled model endpoint costs one retry cycle and flag notices still alert as 로또', async () => {
  const rows = [
    remainderRow(THU),
    remainderRow(THU, { HOUSE_MANAGE_NO: '8', HSSPLY_ADRES: '서울특별시 서초구 반포동 1' }),
  ];
  const base = apiFetch({ rows });
  let modelCalls = 0;
  const h = harness({
    fetch: async (url) => {
      if (String(url).includes('getRemndrLttotPblancMdl')) {
        modelCalls += 1;
        throw new TypeError('fetch failed');
      }
      return base(url);
    },
  });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.equal(modelCalls, 3);
  assert.equal(h.kakao.length, 2);
  assert.ok(h.store.state.upserts.every((item) => item.evaluation.status === '로또'));
  assert.ok(h.mails.some((mail) => mail.text.includes('applyhome_network x2')));
});

test('Applyhome failing fully exits 1 even when LH succeeds', async () => {
  const h = harness({
    fetch: async (url) => (String(url).includes('odcloud')
      ? new Response('', { status: 500 })
      : Response.json([{ dsList: [] }])),
  });
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
});

test('weekly mail is sent on Monday and stamped, then skipped once stamped', async () => {
  const monday = '2026-11-01T22:30:00Z';
  const rows = [remainderRow('2026-11-05')];
  const h = harness({ nowIso: monday, fetch: apiFetch({ rows }) });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  const weekly = h.mails.filter((mail) => mail.subject.includes('금주 일정'));
  assert.equal(weekly.length, 1);
  assert.ok(weekly[0].html.includes('[로또]'));
  assert.equal(h.store.state.weekly, '2026-11-02');

  const again = harness({ nowIso: monday, fetch: apiFetch({ rows }), store: fakeStore(new Map(), '2026-11-02') });
  await run({ env: again.env, deps: again.deps });
  assert.equal(again.mails.filter((mail) => mail.subject.includes('금주 일정')).length, 0);
});

test('weekly stamp is not written when the mail fails', async () => {
  const store = fakeStore();
  const h = harness({ store, nowIso: '2026-11-01T22:30:00Z', sendMail: async () => { throw new Error('x'); } });
  await run({ env: h.env, deps: h.deps });
  assert.equal(store.state.weekly, null);
});

test('force-weekly bypasses the weekday gate', async () => {
  const h = harness();
  await run({ argv: ['--force-weekly'], env: h.env, deps: h.deps });
  assert.equal(h.mails.filter((mail) => mail.subject.includes('금주 일정')).length, 1);
});

test('all sources failing does not send a weekly mail, mails a clean summary and exits 1', async () => {
  const h = harness({ nowIso: '2026-11-01T22:30:00Z', fetch: apiFetch({ fail: true }) });
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.equal(h.mails.filter((mail) => mail.subject.includes('금주 일정')).length, 0);
  assert.equal(h.store.state.weekly, null);
  const combined = JSON.stringify([h.mails, h.logs]);
  assert.ok(combined.includes('applyhome_http_500'));
  assert.ok(!combined.includes(SECRET));
  assert.ok(!combined.includes('odcloud'));
  assert.ok(!combined.includes('data.go.kr'));
});

test('a single source failure does not block the others or fail the job', async () => {
  const base = apiFetch();
  const h = harness({
    fetch: async (url) => (String(url).includes('B552555') ? new Response('', { status: 500 }) : base(url)),
  });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.equal(h.kakao.length, 1);
  assert.ok(h.mails.some((mail) => mail.text.includes('lh_http_500')));
});

const stalledNotionRows = [
  remainderRow(THU),
  remainderRow(THU, { HOUSE_MANAGE_NO: '8', HSSPLY_ADRES: '서울특별시 서초구 반포동 1' }),
];

// 실제 createNotionStore를 쓰고 Notion 호출만 가짜로 돌린다. stall이 true를 돌려주는 호출부터 멈춘다.
function stalledNotionHarness({ rows = stalledNotionRows, pages = [], stall, failure = new TypeError('fetch failed'), nowIso } = {}) {
  const base = apiFetch({ rows });
  const notionCalls = [];
  const fetch = async (url, init) => {
    if (!String(url).includes('api.notion.com')) return base(url);
    const path = new URL(url).pathname.replace('/v1', '');
    notionCalls.push(`${init.method} ${path}`);
    if (stall(init.method, path)) throw failure;
    if (init.method === 'GET') {
      return Response.json({
        has_more: false,
        results: [
          { id: 'db', type: 'child_database', child_database: { title: '청약 정보' } },
          { id: 'src', type: 'child_page', child_page: { title: '청약 수집 소스' } },
        ],
      });
    }
    if (path.endsWith('/query')) return Response.json({ has_more: false, results: pages });
    return Response.json({ id: 'page' });
  };
  const h = harness({ fetch, nowIso });
  h.deps.store = undefined;
  return { ...h, notionCalls };
}

const existingPage = (id, key) => ({
  id,
  properties: {
    '고유 키': { rich_text: [{ plain_text: key }] },
    '접수 종료일': { date: { start: THU } },
  },
});

test('Notion stalling on new-page upserts stops Notion calls and both urgent alerts still go out', async () => {
  const h = stalledNotionHarness({ stall: (method, path) => method === 'POST' && path === '/pages' });
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.equal(h.kakao.length, 2);
  assert.deepEqual(h.notionCalls.filter((call) => call === 'POST /pages'), ['POST /pages']);
  const summary = h.mails.find((mail) => mail.subject.includes('배치 오류'));
  assert.ok(summary.text.includes('notion_network'));
  assert.ok(summary.text.includes('urgent_sent_without_stamp x2'));
  assert.ok(!summary.text.includes('api.notion.com'));
});

test('Notion stalling on existing pages costs one retry cycle, then no stamps are attempted', async () => {
  const h = stalledNotionHarness({
    pages: [existingPage('p7', '7-7'), existingPage('p8', '8-7')],
    stall: (method) => method === 'PATCH',
  });
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.equal(h.kakao.length, 2);
  assert.equal(h.notionCalls.filter((call) => call.startsWith('PATCH')).length, 6);
  assert.ok(h.mails.some((mail) => mail.text.includes('urgent_sent_without_stamp x2')));
});

test('Notion timeouts trip the guard the same way', async () => {
  const h = stalledNotionHarness({
    failure: Object.assign(new Error('t'), { name: 'TimeoutError' }),
    stall: (method, path) => method === 'POST' && path === '/pages',
  });
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.equal(h.kakao.length, 2);
  assert.equal(h.notionCalls.filter((call) => call === 'POST /pages').length, 1);
  assert.ok(h.mails.some((mail) => mail.text.includes('notion_timeout')));
});

test('a Notion stall during upserts blocks the weekly mail and its stamp', async () => {
  const rows = [remainderRow('2026-11-02')];
  const h = stalledNotionHarness({
    rows,
    nowIso: '2026-11-01T22:30:00Z',
    stall: (method, path) => method === 'POST' && path === '/pages',
  });
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.equal(h.mails.filter((mail) => mail.subject.includes('금주 일정')).length, 0);
  assert.equal(h.kakao.length, 1);
  assert.equal(h.notionCalls.filter((call) => call === 'POST /pages').length, 1);
});

test('a Notion stall during init uses the no-store path and still alerts', async () => {
  const h = stalledNotionHarness({ stall: (method) => method === 'GET' });
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.equal(h.kakao.length, 2);
  assert.equal(h.notionCalls.length, 6);
});

test('a failed stamp on a sent alert is reported as sent without a stamp', async () => {
  const previous = new Map([['7-7', { id: 'p', key: '7-7', lotto: null, urgentDate: null, end: THU }]]);
  const store = { ...fakeStore(previous), stampUrgent: async () => { throw new Error('x'); } };
  const h = harness({ store });
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.equal(h.kakao.length, 1);
  assert.ok(h.mails.some((mail) => mail.text.includes('urgent_sent_without_stamp')));
});

const brokenNotionStore = () => ({
  ...fakeStore(),
  init: async () => { throw Object.assign(new Error('https://api.notion.com'), { code: 'NOTION_DOWN' }); },
});

test('Notion read failure still sends urgent alerts, without a stamp, and exits 1', async () => {
  const store = brokenNotionStore();
  const h = harness({ store });
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.equal(h.kakao.length, 1);
  assert.equal(store.state.stamps.length, 0);
  assert.equal(store.state.upserts.length, 0);
  const summary = h.mails.find((mail) => mail.subject.includes('배치 오류'));
  assert.ok(summary.text.includes('urgent_sent_without_stamp'));
  assert.ok(summary.text.includes('error_NOTION_DOWN'));
});

test('Notion read failure uses the mail fallback when Kakao fails', async () => {
  const h = harness({ store: brokenNotionStore(), sendKakao: async () => { throw new Error('x'); } });
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.ok(h.mails.some((mail) => mail.subject.startsWith('[청약 긴급]')));
});

test('Notion read failure does not send the weekly mail', async () => {
  const store = brokenNotionStore();
  const h = harness({ store, nowIso: '2026-11-01T22:30:00Z', fetch: apiFetch({ rows: [remainderRow('2026-11-05')] }) });
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.equal(h.mails.filter((mail) => mail.subject.includes('금주 일정')).length, 0);
  assert.equal(store.state.weekly, null);
});

test('upsert failure on a new notice still alerts, skips the stamp and exits 1', async () => {
  const store = { ...fakeStore(), upsert: async () => { throw new Error('x'); } };
  const h = harness({ store });
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.equal(h.kakao.length, 1);
  assert.equal(store.state.stamps.length, 0);
  assert.ok(h.mails.some((mail) => mail.text.includes('urgent_sent_without_stamp')));
});

test('upsert failure on an existing page still stamps that page', async () => {
  const previous = new Map([['7-7', { id: 'old-page', key: '7-7', lotto: null, urgentDate: null, end: THU }]]);
  const base = fakeStore(previous);
  const store = { ...base, upsert: async () => { throw new Error('x'); } };
  const h = harness({ store });
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.deepEqual(base.state.stamps, [{ id: 'old-page', date: THU }]);
});

test('KAKAO_SECRET_WRITE_OUTCOME failure is mailed and exits 1', async () => {
  const h = harness({ env: { KAKAO_SECRET_WRITE_OUTCOME: 'failure' } });
  assert.equal(await run({ env: h.env, deps: h.deps }), 1);
  assert.ok(h.mails.some((mail) => mail.text.includes('kakao_secret_write_failed')));
  const ok = harness({ env: { KAKAO_SECRET_WRITE_OUTCOME: 'success' } });
  assert.equal(await run({ env: ok.env, deps: ok.deps }), 0);
});

test('a missing Kakao token is reported and the urgent alert goes by mail', async () => {
  const h = harness({
    accessToken: null,
    sendKakao: async ({ text }) => {
      await sendKakaoMemo({ token: null, text, fetch: async () => { throw new Error('no'); } });
    },
  });
  await run({ env: h.env, deps: h.deps });
  assert.ok(h.mails.some((mail) => mail.subject.startsWith('[청약 긴급]')));
  assert.ok(h.mails.some((mail) => mail.text.includes('kakao_access_token_missing')));
});

test('past notices are stored unevaluated; ended existing pages are not rewritten', async () => {
  const rows = [remainderRow('2026-11-01')];
  const fresh = harness({ fetch: apiFetch({ rows }) });
  await run({ env: fresh.env, deps: fresh.deps });
  assert.equal(fresh.store.state.upserts.length, 1);
  assert.equal(fresh.store.state.upserts[0].evaluation, null);

  const ended = new Map([['7-7', { id: 'x', key: '7-7', lotto: '로또', urgentDate: null, end: '2026-11-01' }]]);
  const old = harness({ fetch: apiFetch({ rows }), store: fakeStore(ended) });
  await run({ env: old.env, deps: old.deps });
  assert.equal(old.store.state.upserts.length, 0);
});

test('undetermined evaluation keeps an existing 로또 and alerts', async () => {
  const row = remainderRow(THU, { HOUSE_SECD: '01', SPSPLY_RCEPT_BGNDE: THU, SPSPLY_RCEPT_ENDDE: THU });
  const fetchApt = async (url) => {
    const text = String(url);
    if (text.includes('getAPTLttotPblancDetail')) return Response.json({ totalCount: 1, data: [row] });
    if (text.includes('getAPTLttotPblancMdl')) return Response.json({ totalCount: 1, data: [{ HOUSE_TY: '084A', LTTOT_TOP_AMOUNT: '100,000' }] });
    if (text.includes('api.odcloud.kr')) return Response.json({ totalCount: 0, data: [] });
    if (text.includes('1613000')) return new Response('', { status: 500 });
    return Response.json([{ dsList: [] }]);
  };
  const previous = new Map([['7-7', { id: 'x', key: '7-7', lotto: '로또', urgentDate: null, end: THU }]]);
  const h = harness({ fetch: fetchApt, store: fakeStore(previous) });
  await run({ env: h.env, deps: h.deps });
  assert.equal(h.store.state.upserts[0].evaluation.status, '로또');
  assert.equal(h.kakao.length, 1);
  assert.ok(h.mails.some((mail) => mail.text.includes('molit_http_500')));
});

test('dry-run writes and sends nothing and needs only the data key', async () => {
  const h = harness({ store: null, accessToken: null });
  h.deps.store = undefined;
  const code = await run({ argv: ['--dry-run'], env: { DATA_GO_KR_KEY: SECRET }, deps: h.deps });
  assert.equal(code, 0);
  assert.equal(h.mails.length, 0);
  assert.equal(h.kakao.length, 0);
  assert.ok(h.logs.some((line) => line.includes('urgent_candidates=1')));
  assert.ok(!h.logs.some((line) => line.includes('무순위 단지')));
});

test('--print lists notices without writing', async () => {
  const h = harness();
  await run({ argv: ['--print'], env: { DATA_GO_KR_KEY: SECRET }, deps: h.deps });
  assert.ok(h.logs.some((line) => line.includes('무순위 단지')));
  assert.equal(h.store.state.upserts.length, 0);
});

test('test-send sends one marked mail and one Kakao with no Notion use', async () => {
  const store = { init: async () => { throw new Error('must not be called'); } };
  const h = harness({ store });
  assert.equal(await run({ argv: ['--test-send'], env: {}, deps: h.deps }), 0);
  assert.equal(h.mails.length, 1);
  assert.ok(h.mails[0].subject.includes('[테스트]'));
  assert.equal(h.kakao.length, 1);
});

test('invalid mode exits 1 before doing anything', async () => {
  const h = harness();
  assert.equal(await run({ env: { CHUNGYAK_MODE: 'nope' }, deps: h.deps }), 1);
  assert.equal(h.kakao.length, 0);
});
