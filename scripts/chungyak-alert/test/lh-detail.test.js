import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { run } from '../src/main.js';
import { buildProperties } from '../src/notion-store.js';
import { normalizeLh } from '../src/sources/lh.js';
import {
  MAX_SCHEMA_LINE,
  collectSchema,
  createLhDetailClient,
  createSchema,
  formatSchemaLine,
  lhDetailParams,
  probeLhSchemas,
} from '../src/sources/lh-detail.js';

const fileConfig = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const noSleep = async () => {};
const SECRET = 'SECRET-DATA-KEY';

const CODES = { PAN_ID: '2026000123', SPL_INF_TP_CD: '050', CCR_CNNT_SYS_DS_CD: '03', UPP_AIS_TP_CD: '05', AIS_TP_CD: '' };

// 로그에 나오면 안 되는 값. 한글 이름, 주소, 금액, 전화번호, 날짜.
const SECRET_VALUES = ['마곡래미안테스트단지', '서울특별시 강서구 마곡동 123-45', '987654321', '02-5555-0199', '2026.12.24', '84.9876', '상가A동 101호', '임시접수처'];

const detailBody = () => [
  { dsSch: [{ PAN_ID: CODES.PAN_ID, SPL_INF_TP_CD: CODES.SPL_INF_TP_CD }] },
  {
    dsSbd: [
      { BZDT_NM: '마곡래미안테스트단지', LCT_ARA_ADR: '서울특별시 강서구 마곡동 123-45', HSH_CNT: 987654321 },
      { BZDT_NM: '마곡래미안테스트단지', LCT_ARA_DTL_ADR: '상가A동 101호', MIN_MAX_RSDN_DDO_AR: '84.9876' },
    ],
  },
  { dsCtrtPlc: [{ CTRT_PLC_ADR: '서울특별시 강서구 마곡동 123-45', CTRT_PLC_DTL_ADR: '임시접수처', SIL_OFC_TLNO: '02-5555-0199' }] },
  { dsSplScdl: [{ SBSC_ACP_ST_DT: '2026.12.24', PZWR_ANC_DT: '2026.12.24' }] },
];

const supplyBody = () => ({
  response: {
    header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' },
    body: {
      totalCount: 2,
      items: {
        item: [
          { HTY_NNA: '084.9876A', SPL_XPC_AMT: 987654321, '주택형': '마곡래미안테스트단지' },
          { HTY_NNA: '059A', RS_DTTM: '2026.12.24', '02-5555-0199': 'x', nested: { LGDN_DTL_ADR: '서울특별시 강서구 마곡동 123-45' } },
        ],
      },
    },
  },
});

function probeFetch({ detail = () => Response.json(detailBody()), supply = () => Response.json(supplyBody()) } = {}) {
  const calls = [];
  const fetch = async (url) => {
    const text = String(url);
    calls.push(text);
    if (text.includes('lhLeaseNoticeDtlInfo1')) return detail();
    if (text.includes('lhLeaseNoticeSplInfo1')) return supply();
    throw new Error(`unexpected ${text}`);
  };
  return { fetch, calls, detailCalls: () => calls.filter((url) => url.includes('Dtl')), supplyCalls: () => calls.filter((url) => url.includes('Spl')) };
}

const probeClient = (fake, { maxCalls = 10, soft = [] } = {}) => createLhDetailClient({
  fetch: fake.fetch,
  key: 'k',
  sleep: noSleep,
  limits: { maxCalls, timeoutMs: 1000 },
  onSoft: (kind) => soft.push(kind),
});

test('the LH list parser keeps the five request codes raw on the notice and Notion does not write them', () => {
  const row = {
    PAN_ID: '2026000123',
    PAN_NM: '어느 공공분양',
    UPP_AIS_TP_NM: '분양주택',
    AIS_TP_CD_NM: '공공분양',
    CNP_CD_NM: '서울특별시',
    SPL_INF_TP_CD: '050',
    CCR_CNNT_SYS_DS_CD: '03',
    UPP_AIS_TP_CD: '05',
    AIS_TP_CD: 7,
  };
  const notice = normalizeLh(row, []);
  assert.deepEqual(notice.lhCodes, { PAN_ID: '2026000123', SPL_INF_TP_CD: '050', CCR_CNNT_SYS_DS_CD: '03', UPP_AIS_TP_CD: '05', AIS_TP_CD: 7 });
  // 없는 값은 null이고, PAN_ID가 행에 없으면 DTL_URL에서 읽은 값을 쓴다.
  const fromUrl = normalizeLh({ PAN_NM: 'a', DTL_URL: 'https://apply.lh.or.kr/?panId=0000060749' }, []);
  assert.deepEqual(fromUrl.lhCodes, { PAN_ID: '0000060749', SPL_INF_TP_CD: null, CCR_CNNT_SYS_DS_CD: null, UPP_AIS_TP_CD: null, AIS_TP_CD: null });

  const written = JSON.stringify(buildProperties({ ...notice, stages: [] }, null, '2026-11-05'));
  for (const value of ['050', 'SPL_INF_TP_CD', 'CCR_CNNT_SYS_DS_CD', 'UPP_AIS_TP_CD', 'AIS_TP_CD', 'lhCodes']) assert.ok(!written.includes(value), value);
});

test('request params use each API key name, need the four codes and send AIS_TP_CD only when set', () => {
  assert.deepEqual(lhDetailParams(CODES, 'k', 'serviceKey'), { serviceKey: 'k', SPL_INF_TP_CD: '050', CCR_CNNT_SYS_DS_CD: '03', PAN_ID: '2026000123', UPP_AIS_TP_CD: '05' });
  assert.equal(lhDetailParams({ ...CODES, AIS_TP_CD: '06' }, 'k', 'ServiceKey').AIS_TP_CD, '06');
  for (const field of ['PAN_ID', 'SPL_INF_TP_CD', 'CCR_CNNT_SYS_DS_CD', 'UPP_AIS_TP_CD']) {
    assert.equal(lhDetailParams({ ...CODES, [field]: ' ' }, 'k', 'serviceKey'), null, field);
    assert.equal(lhDetailParams({ ...CODES, [field]: null }, 'k', 'serviceKey'), null, field);
  }
  assert.equal(lhDetailParams(undefined, 'k', 'serviceKey'), null);
});

test('the client calls both APIs with the documented key names and skips notices without codes', async () => {
  const fake = probeFetch();
  const client = probeClient(fake);
  await probeLhSchemas([{ lhCodes: CODES }, { lhCodes: { ...CODES, PAN_ID: null } }, {}], client);
  const detail = new URL(fake.detailCalls()[0]).searchParams;
  const supply = new URL(fake.supplyCalls()[0]).searchParams;
  assert.equal(detail.get('serviceKey'), 'k');
  assert.equal(detail.get('ServiceKey'), null);
  assert.equal(supply.get('ServiceKey'), 'k');
  assert.equal(supply.get('serviceKey'), null);
  for (const params of [detail, supply]) {
    assert.equal(params.get('PAN_ID'), CODES.PAN_ID);
    assert.equal(params.get('SPL_INF_TP_CD'), '050');
    assert.equal(params.has('AIS_TP_CD'), false);
  }
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(client.stats().detail, { calls: 1, ok: 1, noCodes: 2, capped: 0, stopped: null });
});

test('the call cap is per API and per run, and reaching it is not a failure', async () => {
  const fake = probeFetch();
  const soft = [];
  const client = probeClient(fake, { maxCalls: 2, soft });
  await probeLhSchemas([1, 2, 3, 4].map(() => ({ lhCodes: CODES })), client);
  assert.equal(fake.detailCalls().length, 2);
  assert.equal(fake.supplyCalls().length, 2);
  assert.deepEqual(client.stats().detail, { calls: 2, ok: 2, noCodes: 0, capped: 2, stopped: null });
  assert.deepEqual(soft, []);

  const off = probeFetch();
  await probeLhSchemas([{ lhCodes: CODES }], probeClient(off, { maxCalls: 0 }));
  assert.equal(off.calls.length, 0);
});

test('the first hard failure stops that API only and is counted once as soft', async () => {
  for (const [label, detail, kind, attempts] of [
    ['http', () => new Response('denied body', { status: 403 }), 'lh_detail_http_403', 1],
    ['server', () => new Response('', { status: 500 }), 'lh_detail_http_500', 2],
    ['xml error', () => new Response('<OpenAPI_ServiceResponse><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg></OpenAPI_ServiceResponse>'), 'lh_detail_parse', 1],
    ['network', () => { throw new TypeError('fetch failed'); }, 'lh_detail_network', 2],
  ]) {
    const fake = probeFetch({ detail });
    const soft = [];
    const client = probeClient(fake, { soft });
    await probeLhSchemas([1, 2, 3].map(() => ({ lhCodes: CODES })), client);
    assert.equal(fake.detailCalls().length, attempts, label);
    assert.equal(fake.supplyCalls().length, 3, label);
    assert.deepEqual(soft, [kind], label);
    assert.equal(client.stats().detail.stopped, kind, label);
    await assert.rejects(client.fetchLhDetail(CODES), { kind }, label);
    assert.equal(fake.detailCalls().length, attempts, label);
    assert.ok(client.schemaLines()[0].startsWith(`lh_detail_schema calls=1 ok=0 no_codes=0 capped=0 stopped=${kind} dropped_keys=0 blocks=none fields=none`), label);
  }
});

test('schema extraction merges nested blocks by name and keeps scalar keys only', () => {
  const schema = createSchema();
  collectSchema(detailBody(), schema);
  collectSchema([{ dsSbd: [] }, { dsSbd: [{ BZDT_NM: 'b', EXTRA_YN: 'Y' }] }], schema);
  collectSchema(supplyBody(), schema);
  // 최상위가 바로 행 배열인 응답
  collectSchema([{ PAN_ID: '1' }], schema);
  const blocks = Object.fromEntries([...schema.blocks].map(([name, block]) => [name, { rows: block.rows, fields: [...block.fields].sort() }]));
  assert.deepEqual(blocks.dsSbd, { rows: 3, fields: ['BZDT_NM', 'EXTRA_YN', 'HSH_CNT', 'LCT_ARA_ADR', 'LCT_ARA_DTL_ADR', 'MIN_MAX_RSDN_DDO_AR'] });
  assert.deepEqual(blocks.item, { rows: 2, fields: ['HTY_NNA', 'RS_DTTM', 'SPL_XPC_AMT'] });
  assert.deepEqual(blocks.nested, { rows: 1, fields: ['LGDN_DTL_ADR'] });
  assert.deepEqual(blocks.response, { rows: 1, fields: [] });
  assert.deepEqual(blocks.header, { rows: 1, fields: ['resultCode', 'resultMsg'] });
  assert.deepEqual(blocks.body, { rows: 1, fields: ['totalCount'] });
  assert.deepEqual(blocks._root, { rows: 8, fields: ['PAN_ID'] });
  // 한글 키와 숫자로 시작하는 키는 버리고 센다.
  assert.equal(schema.dropped, 2);

  const line = formatSchemaLine('lh_detail_schema', { calls: 4, ok: 4, noCodes: 0, capped: 0, stopped: null }, schema);
  assert.equal(line, 'lh_detail_schema calls=4 ok=4 no_codes=0 capped=0 stopped=none dropped_keys=2 '
    + 'blocks=_root:8,body:1,dsCtrtPlc:1,dsSbd:3,dsSch:1,dsSplScdl:1,header:1,item:2,items:1,nested:1,response:1 '
    + 'fields=_root[PAN_ID],body[totalCount],dsCtrtPlc[CTRT_PLC_ADR,CTRT_PLC_DTL_ADR,SIL_OFC_TLNO],'
    + 'dsSbd[BZDT_NM,EXTRA_YN,HSH_CNT,LCT_ARA_ADR,LCT_ARA_DTL_ADR,MIN_MAX_RSDN_DDO_AR],dsSch[PAN_ID,SPL_INF_TP_CD],'
    + 'dsSplScdl[PZWR_ANC_DT,SBSC_ACP_ST_DT],header[resultCode,resultMsg],item[HTY_NNA,RS_DTTM,SPL_XPC_AMT],nested[LGDN_DTL_ADR]');
  // 감싸기만 하는 최상위 블록은 적지 않는다.
  const wrapped = createSchema();
  collectSchema([{ dsList: [{ A: 1 }] }], wrapped);
  assert.ok(formatSchemaLine('x', { calls: 1, ok: 1, noCodes: 0, capped: 0, stopped: null }, wrapped).endsWith(' blocks=dsList:1 fields=dsList[A]'));
});

test('schema lines are capped at a name boundary', () => {
  const schema = createSchema();
  const row = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`FIELD_NAME_${String(index).padStart(3, '0')}`, 1]));
  collectSchema({ dsList: [row] }, schema);
  const line = formatSchemaLine('lh_supply_schema', { calls: 1, ok: 1, noCodes: 0, capped: 0, stopped: null }, schema);
  assert.ok(line.length <= MAX_SCHEMA_LINE, String(line.length));
  assert.ok(line.endsWith(',...'), line.slice(-30));
  assert.match(line.slice(0, -3), /,FIELD_NAME_\d{3},$/);
});

// run() 통합. 청약홈은 비어 있고 LH 목록에 서울 분양 공고 하나와 범위 밖 공고(부산, 토지)가 있다.
const lhListRow = (id, extra = {}) => ({
  PAN_ID: id,
  PAN_NM: '마곡래미안테스트단지 공공분양 입주자모집공고',
  UPP_AIS_TP_NM: '분양주택',
  AIS_TP_CD_NM: '공공분양',
  CNP_CD_NM: '서울특별시 강서구',
  PAN_NT_ST_DT: '2026.11.01',
  CLSG_DT: '2026.11.20',
  PAN_SS: '공고중',
  SPL_INF_TP_CD: '050',
  CCR_CNNT_SYS_DS_CD: '03',
  UPP_AIS_TP_CD: '05',
  AIS_TP_CD: '05',
  ...extra,
});

function runFetch(options) {
  const probe = probeFetch(options);
  const rows = [lhListRow('seoul'), lhListRow('busan', { CNP_CD_NM: '부산광역시' }), lhListRow('land', { UPP_AIS_TP_NM: '토지', AIS_TP_CD_NM: '공동주택용지' })];
  const fetch = async (url) => {
    const text = String(url);
    if (text.includes('lhLeaseNoticeDtlInfo1') || text.includes('lhLeaseNoticeSplInfo1')) return probe.fetch(url);
    if (text.includes('lhLeaseNoticeInfo1')) return Response.json([{ dsSch: [{}] }, { dsList: rows.map((row) => ({ ...row, ALL_CNT: rows.length })) }]);
    if (text.includes('api.odcloud.kr')) return Response.json({ totalCount: 0, data: [] });
    if (text.includes('apis.data.go.kr/1613000')) return new Response('<r><resultCode>000</resultCode><totalCount>0</totalCount></r>');
    return Response.json({ totalCount: 0, data: [] });
  };
  return { fetch, probe };
}

function runHarness(options) {
  const { fetch, probe } = runFetch(options);
  const state = { upserts: [], archived: [] };
  const logs = [];
  const mails = [];
  const store = {
    init: async () => {},
    loadExisting: async () => new Map(),
    upsert: async (item, evaluation) => {
      state.upserts.push({ key: item.key, status: evaluation?.status ?? null });
      return `page-${item.key}`;
    },
    stampUrgent: async () => {},
    getWeeklyState: async () => '2026-11-02',
    setWeeklyState: async () => {},
    archivePage: async (id) => { state.archived.push(id); },
  };
  const deps = {
    fetch,
    store,
    config: fileConfig,
    accessToken: 'token',
    sleep: noSleep,
    now: () => new Date('2026-11-04T22:30:00Z'),
    log: (line) => logs.push(line),
    write: () => {},
    sendMail: async (mail) => { mails.push(mail); },
    sendKakao: async () => {},
  };
  const env = { DATA_GO_KR_KEY: SECRET, NOTION_KEY: 'n', CHUNGYAK_NOTION_PAGE_ID: 'p' };
  return { deps, env, logs, mails, state, probe };
}

const lineOf = (h, prefix) => h.logs.find((line) => line.startsWith(`${prefix} `));

test('every mode probes in-scope LH notices and logs field names but never values', async () => {
  for (const argv of [[], ['--dry-run']]) {
    const h = runHarness();
    assert.equal(await run({ argv, env: h.env, deps: h.deps }), 0, argv.join(' '));
    // 범위 안 서울 공고 하나만 부른다(부산은 지역, 토지는 수집 단계에서 빠진다).
    assert.equal(h.probe.detailCalls().length, 1, argv.join(' '));
    assert.equal(h.probe.supplyCalls().length, 1, argv.join(' '));
    assert.equal(new URL(h.probe.detailCalls()[0]).searchParams.get('PAN_ID'), 'seoul');
    assert.equal(lineOf(h, 'lh_detail_schema'), 'lh_detail_schema calls=1 ok=1 no_codes=0 capped=0 stopped=none dropped_keys=0 '
      + 'blocks=dsCtrtPlc:1,dsSbd:2,dsSch:1,dsSplScdl:1 '
      + 'fields=dsCtrtPlc[CTRT_PLC_ADR,CTRT_PLC_DTL_ADR,SIL_OFC_TLNO],dsSbd[BZDT_NM,HSH_CNT,LCT_ARA_ADR,LCT_ARA_DTL_ADR,MIN_MAX_RSDN_DDO_AR],'
      + 'dsSch[PAN_ID,SPL_INF_TP_CD],dsSplScdl[PZWR_ANC_DT,SBSC_ACP_ST_DT]');
    assert.equal(lineOf(h, 'lh_supply_schema'), 'lh_supply_schema calls=1 ok=1 no_codes=0 capped=0 stopped=none dropped_keys=2 '
      + 'blocks=body:1,header:1,item:2,items:1,nested:1,response:1 '
      + 'fields=body[totalCount],header[resultCode,resultMsg],item[HTY_NNA,RS_DTTM,SPL_XPC_AMT],nested[LGDN_DTL_ADR]');
    const all = h.logs.join('\n');
    for (const value of [...SECRET_VALUES, '주택형', 'NORMAL SERVICE', SECRET, CODES.PAN_ID]) assert.ok(!all.includes(value), `${argv.join(' ')} ${value}`);
    assert.ok(h.logs.includes('errors=none'), h.logs.join('|'));
    assert.ok(lineOf(h, 'market').endsWith(' soft=none'));
  }
});

test('LH detail failures stay soft and change no writes, statuses or mails', async () => {
  const ok = runHarness();
  assert.equal(await run({ env: ok.env, deps: ok.deps }), 0);
  const failed = runHarness({
    detail: () => new Response('denied 마곡래미안테스트단지', { status: 403 }),
    supply: () => new Response('<OpenAPI_ServiceResponse/>'),
  });
  assert.equal(await run({ env: failed.env, deps: failed.deps }), 0);
  assert.deepEqual(failed.state, ok.state);
  assert.deepEqual(failed.mails.map((mail) => mail.subject), ok.mails.map((mail) => mail.subject));
  assert.ok(!failed.mails.some((mail) => mail.subject.includes('배치 오류')));
  assert.ok(failed.logs.includes('errors=none'), failed.logs.join('|'));
  assert.ok(lineOf(failed, 'market').endsWith(' soft=lh_detail_http_403:1,lh_supply_parse:1'), lineOf(failed, 'market'));
  assert.ok(lineOf(failed, 'lh_detail_schema').includes(' stopped=lh_detail_http_403 '));
  assert.ok(!failed.logs.join('\n').includes('마곡래미안테스트단지'));

  // 키가 없으면 부르지 않는다.
  const noKey = runHarness();
  noKey.env.DATA_GO_KR_KEY = '';
  await run({ argv: ['--dry-run'], env: noKey.env, deps: noKey.deps });
  assert.equal(noKey.probe.calls.length, 0);
  assert.ok(lineOf(noKey, 'lh_detail_schema').startsWith('lh_detail_schema calls=0 ok=0 '));
});
