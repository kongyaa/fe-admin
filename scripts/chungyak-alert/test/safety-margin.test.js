import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { STATUS, averagePriceOf, evaluateLotto, keepPreviousLotto } from '../src/lotto.js';
import { run } from '../src/main.js';
import { buildKakaoText } from '../src/notify-kakao.js';
import { buildProperties, createNotionStore, parseExistingPage } from '../src/notion-store.js';
import { normalizeDetail, ENDPOINTS } from '../src/sources/applyhome.js';
import { createAptInfoClient } from '../src/sources/apt-info.js';
import { resolveAddress } from '../src/sgg-codes.js';
import { AppError } from '../src/util.js';
import { collectTagNames, createMolitClient, createPresaleClient, fetchMonth, fetchPresaleMonth, formatTagNames, parseMolitXml, parsePresaleXml } from '../src/sources/molit.js';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const today = '2026-11-05';
const THU = today;
const THU_NOW = '2026-11-04T22:30:00Z';
const noSleep = async () => {};
const KAKAO_SECRET = 'SECRET-KAKAO-KEY';
const DATA_SECRET = 'SECRET-DATA-KEY';

const xml = (items, code = '000') => `<response><header><resultCode>${code}</resultCode></header><body><items>${items
  .map((item) => `<item>${item}</item>`)
  .join('')}</items><totalCount>${items.length}</totalCount></body></response>`;

const tradeTags = ({ name = '비교단지', amount = '84,000', area = '84', floor = '10', umd = '역삼동', jibun = '100', build = '2026', dealing = '중개거래', extra = '' } = {}) => `<aptNm>${name}</aptNm><dealAmount>${amount}</dealAmount><excluUseAr>${area}</excluUseAr><floor>${floor}</floor><umdNm>${umd}</umdNm><jibun>${jibun}</jibun><buildYear>${build}</buildYear><dealingGbn>${dealing}</dealingGbn><dealYear>2026</dealYear><dealMonth>9</dealMonth><dealDay>3</dealDay>${extra}`;

test('MOLIT parsing reads the new tags and tolerates their absence', () => {
  const parsed = parseMolitXml(xml([
    tradeTags({ extra: '<aptSeq>11680-1</aptSeq><landLeaseholdGbn>N</landLeaseholdGbn>' }),
    '<dealAmount>1</dealAmount><excluUseAr>84</excluUseAr>',
  ]));
  assert.equal(parsed.rows.length, 2);
  const [row, bare] = parsed.rows;
  assert.equal(row.floor, 10);
  assert.equal(row.dealingGbn, '중개거래');
  assert.equal(row.dealDate, '2026-09-03');
  assert.equal(row.jibun, '100');
  assert.equal(row.aptSeq, '11680-1');
  assert.equal(row.landLease, false);
  assert.equal(bare.floor, null);
  assert.equal(bare.dealDate, null);
  assert.equal(bare.jibun, '');
  assert.equal(parseMolitXml(xml([tradeTags({ extra: '<landLeaseholdGbn>Y</landLeaseholdGbn>' })])).rows[0].landLease, true);
});

test('presale parsing excludes 입주권, marks rows and keeps the all-dropped guard', async () => {
  const parsed = parsePresaleXml(xml([
    tradeTags({ extra: '<ownershipGbn>분</ownershipGbn>' }),
    tradeTags({ name: '입주권단지', extra: '<ownershipGbn>입</ownershipGbn>' }),
    tradeTags({ name: '해제', extra: '<ownershipGbn>분</ownershipGbn><cdealType>O</cdealType>' }),
    tradeTags({ name: '구분없음' }),
  ]));
  assert.deepEqual(parsed.rows.map((row) => row.aptName), ['비교단지', '구분없음']);
  assert.ok(parsed.rows.every((row) => row.presale));
  assert.equal(parsed.excluded, 1);
  assert.equal(parsed.cancelled, 1);

  const month = (body) => fetchPresaleMonth({ key: 'k', lawdCode: '1', dealYm: '2', sleep: noSleep, fetch: async () => new Response(body) });
  await assert.rejects(month(xml(['<other>1</other>'])), { kind: 'presale_parse' });
  await assert.rejects(month('<OpenAPI_ServiceResponse/>'), { kind: 'presale_parse' });
  await assert.rejects(month(xml([], '30')), { kind: 'presale_result_30' });
  // 입주권만 있는 달은 태그 문제가 아니다.
  assert.deepEqual(await month(xml([tradeTags({ extra: '<ownershipGbn>입</ownershipGbn>' })])), []);
  // 매매 쪽 가드도 그대로다.
  await assert.rejects(fetchMonth({ key: 'k', lawdCode: '1', dealYm: '2', sleep: noSleep, fetch: async () => new Response(xml(['<other>1</other>'])) }), { kind: 'molit_parse' });
});

test('the presale client calls the presale endpoint and memoises months', async () => {
  const urls = [];
  const client = createPresaleClient({
    key: 'k',
    sleep: noSleep,
    budgetMs: 1000,
    fetch: async (url) => {
      urls.push(String(url));
      return new Response(xml([tradeTags()]));
    },
  });
  const first = await client.getTrades('11680', ['202610', '202609']);
  assert.equal(first.ok, true);
  assert.equal(first.rows.length, 2);
  await client.getTrades('11680', ['202610']);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.startsWith('https://apis.data.go.kr/1613000/RTMSDataSvcSilvTrade/getRTMSDataSvcSilvTrade?')));
  assert.equal(new URL(urls[0]).searchParams.get('LAWD_CD'), '11680');
  assert.equal(new URL(urls[0]).searchParams.get('DEAL_YMD'), '202610');
});

test('a failing presale API reports once, stops further calls and never throws', async () => {
  for (const [failure, kind, callsAfterFirst] of [
    [async () => new Response('', { status: 403 }), 'presale_http_403', 1],
    [async () => new Response('<OpenAPI_ServiceResponse/>'), 'presale_parse', 1],
    [async () => { throw new TypeError('fetch failed'); }, 'presale_network', 2],
  ]) {
    let calls = 0;
    const soft = [];
    const client = createPresaleClient({
      key: 'k',
      sleep: noSleep,
      budgetMs: 100000,
      onSoft: (item) => soft.push(item),
      fetch: async () => {
        calls += 1;
        return failure();
      },
    });
    assert.deepEqual(await client.getTrades('11680', ['202610', '202609']), { rows: [], ok: false });
    assert.equal(calls, callsAfterFirst);
    assert.deepEqual(await client.getTrades('11650', ['202610']), { rows: [], ok: false });
    assert.equal(calls, callsAfterFirst);
    assert.deepEqual(soft, [kind]);
  }
});

test('the presale client stops at its time budget', async () => {
  let current = 0;
  let calls = 0;
  const soft = [];
  const client = createPresaleClient({
    key: 'k',
    sleep: noSleep,
    budgetMs: 100,
    now: () => new Date(current),
    onSoft: (item) => soft.push(item),
    fetch: async () => {
      calls += 1;
      current += 100;
      return new Response(xml([]));
    },
  });
  assert.equal((await client.getTrades('11680', ['202610', '202609'])).ok, false);
  assert.equal(calls, 1);
  assert.deepEqual(soft, ['presale_budget']);
});

test('months already cached are served after the presale budget has passed', async () => {
  let current = 0;
  let calls = 0;
  const soft = [];
  const client = createPresaleClient({
    key: 'k',
    sleep: noSleep,
    budgetMs: 100,
    now: () => new Date(current),
    onSoft: (item) => soft.push(item),
    fetch: async () => {
      calls += 1;
      return new Response(xml([tradeTags()]));
    },
  });
  assert.equal((await client.getTrades('11680', ['202610'])).ok, true);
  current = 1000;
  const cached = await client.getTrades('11680', ['202610']);
  assert.equal(cached.ok, true);
  assert.equal(cached.rows.length, 1);
  assert.equal(calls, 1);
  assert.deepEqual(soft, []);
  // 캐시에 없는 달은 시간이 지났으므로 호출하지 않는다.
  assert.equal((await client.getTrades('11680', ['202609'])).ok, false);
  assert.equal(calls, 1);
  assert.deepEqual(soft, ['presale_budget']);
});

const listBody = (items, totalCount = items.length) => ({ header: { resultCode: '00', resultMsg: 'OK' }, body: { items, numOfRows: '1000', pageNo: '1', totalCount: String(totalCount) } });
const detailBody = (item) => ({ header: { resultCode: '00', resultMsg: 'OK' }, body: { item } });
const listItem = (kaptName, kaptCode = 'A1', as3 = '역삼동') => ({ bjdCode: '1168010100', kaptCode, kaptName, as1: '서울특별시', as2: '강남구', as3 });

function aptClient(handler, { limits = config.market.aptInfo, now } = {}) {
  const calls = [];
  const soft = [];
  const client = createAptInfoClient({
    key: 'k+/=',
    limits,
    sleep: noSleep,
    now,
    onSoft: (kind) => soft.push(kind),
    fetch: async (url) => {
      const parsed = new URL(url);
      calls.push({ path: parsed.pathname, params: Object.fromEntries(parsed.searchParams) });
      return handler(parsed);
    },
  });
  return { client, calls, soft };
}

test('the apartment client uses the operations and parameters in the official spec', async () => {
  const { client, calls, soft } = aptClient((url) => (url.pathname.endsWith('/getSigunguAptList4')
    ? Response.json(listBody([listItem('역삼푸른숲')]))
    : Response.json(detailBody({ kaptCode: 'A1', subwayLine: '2호선', subwayStation: '역삼', kaptdWtimesub: '5~10분이내' }))));
  assert.deepEqual(await client.getDirectory('11680'), [{ code: 'A1', name: '역삼푸른숲', dong: '역삼동', ri: '' }]);
  assert.deepEqual(await client.getStation('A1'), { walkMinutes: 10, walkBand: '5~10분이내' });
  assert.equal(calls[0].path, '/1613000/AptListService4/getSigunguAptList4');
  assert.deepEqual(calls[0].params, { serviceKey: 'k+/=', sigunguCode: '11680', pageNo: '1', numOfRows: '1000' });
  assert.equal(calls[1].path, '/1613000/AptBasisInfoServiceV5/getAphusDtlInfoV5');
  // 명세대로 상세 정보만 ServiceKey다.
  assert.deepEqual(calls[1].params, { ServiceKey: 'k+/=', kaptCode: 'A1' });
  assert.deepEqual(soft, []);
});

test('the apartment client reads wrapped envelopes, item lists and every page', async () => {
  const wrapped = aptClient(() => Response.json({ response: listBody({ item: [listItem('가단지', 'A1'), listItem('나단지', 'A2')] }, 2) }));
  assert.equal((await wrapped.client.getDirectory('1')).length, 2);
  const single = aptClient(() => Response.json({ response: listBody({ item: listItem('가단지') }, 1) }));
  assert.equal((await single.client.getDirectory('1')).length, 1);

  const pages = aptClient((url) => {
    const pageNo = Number(url.searchParams.get('pageNo'));
    return Response.json(listBody(pageNo === 1 ? Array.from({ length: 1000 }, (_, index) => listItem(`단지${index}`, `A${index}`)) : [listItem('마지막', 'Z')], 1001));
  });
  const all = await pages.client.getDirectory('1');
  assert.equal(all.length, 1001);
  assert.equal(pages.calls.length, 2);
  const empty = aptClient(() => Response.json(listBody('')));
  assert.deepEqual(await empty.client.getDirectory('1'), []);
});

test('the apartment client memoises by district and complex', async () => {
  const { client, calls } = aptClient((url) => (url.pathname.endsWith('/getSigunguAptList4')
    ? Response.json(listBody([listItem('가단지')]))
    : Response.json(detailBody({ kaptdWtimesub: '5분이내' }))));
  await client.getDirectory('1');
  await client.getDirectory('1');
  await client.getStation('A1');
  await client.getStation('A1');
  assert.equal(calls.length, 2);
  assert.equal(client.stats().calls, 2);
});

test('missing or unreadable station values are counted and treated as no value', async () => {
  const items = { A1: { kaptCode: 'A1', kaptdWtimesub: '' }, A2: { kaptCode: 'A2', kaptdWtimesub: null }, A3: { kaptCode: 'A3' }, A4: { kaptCode: 'A4', kaptdWtimesub: '역 앞' }, A5: null, A6: { kaptdWtimesub: '20분초과' } };
  const { client, soft } = aptClient((url) => Response.json(detailBody(items[url.searchParams.get('kaptCode')])));
  for (const code of ['A1', 'A2', 'A3', 'A4', 'A5']) assert.equal(await client.getStation(code), null, code);
  assert.deepEqual(await client.getStation('A6'), { walkMinutes: 21, walkBand: '20분초과' });
  assert.deepEqual(client.tags(), { listRows: 0, listNoCode: 0, listNoDong: 0, listNoTotal: 0, details: 6, noItem: 1, noData: 0, noField: 1, emptyWalk: 2, badWalk: 1 });
  assert.deepEqual(soft, []);
});

test('walk bands are counted without any complex details', async () => {
  const values = { A1: '5~10분이내', A2: '5~10분이내', A3: ' 20분초과 ', A4: '역삼역 앞 비밀단지', A5: '' };
  const { client } = aptClient((url) => {
    const code = url.searchParams.get('kaptCode');
    return Response.json(detailBody({ kaptCode: code, kaptName: `비밀${code}`, subwayStation: '비밀역', kaptdWtimesub: values[code] }));
  });
  assert.equal(client.bandCounts(), 'none');
  for (const code of Object.keys(values)) await client.getStation(code);
  // 읽지 못한 값은 그대로 남기지 않고 badWalk로만 센다.
  assert.equal(client.bandCounts(), '5~10분이내:2,20분초과:1');
  assert.equal(client.tags().badWalk, 1);
});

const noDataBody = { header: { resultCode: '03', resultMsg: 'NODATA_ERROR' }, body: {} };

test('a no-data result is that complex or district only and does not stop the client', async () => {
  const { client, calls, soft } = aptClient((url) => {
    if (url.pathname.endsWith('/getSigunguAptList4')) {
      return Response.json(url.searchParams.get('sigunguCode') === '99999' ? noDataBody : listBody([listItem('가단지')]));
    }
    const code = url.searchParams.get('kaptCode');
    if (code === 'NONE') return Response.json(noDataBody);
    if (code === 'EMPTY') return Response.json({ header: { resultCode: '00' }, body: {} });
    return Response.json(detailBody({ kaptdWtimesub: '5분이내' }));
  });
  assert.deepEqual(await client.getDirectory('99999'), []);
  assert.equal(await client.getStation('NONE'), null);
  assert.equal(await client.getStation('EMPTY'), null);
  assert.equal((await client.getDirectory('11680')).length, 1);
  assert.equal((await client.getStation('A1')).walkMinutes, 5);
  assert.equal(calls.length, 5);
  assert.deepEqual(soft, []);
  assert.equal(client.tags().noData, 2);
  assert.equal(client.tags().noItem, 1);
});

test('a later notice still gets values after a no-data complex', async () => {
  const soft = [];
  const client = createAptInfoClient({
    key: 'k',
    limits: config.market.aptInfo,
    sleep: noSleep,
    onSoft: (kind) => soft.push(kind),
    fetch: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/getSigunguAptList4')) return Response.json(listBody([listItem('역삼푸른숲', 'NONE'), listItem('역삼큰나무', 'A2')]));
      return Response.json(parsed.searchParams.get('kaptCode') === 'NONE' ? noDataBody : detailBody({ kaptdWtimesub: '5분이내' }));
    },
  });
  const first = await evaluate(apt(), { trades: saleRows(5, 1000, { aptName: '역삼푸른숲', jibun: '11' }), aptInfo: client, walkMinutes: 5 });
  assert.equal(first.stationState, 'noData');
  assert.ok(first.reason.includes('비교 단지 역 정보 부족으로'));
  const second = await evaluate(apt({ address: '서울특별시 강남구 역삼동 2' }), { trades: saleRows(5, 1000, { aptName: '역삼큰나무', jibun: '12' }), aptInfo: client, walkMinutes: 5 });
  assert.equal(second.stationState, 'used');
  assert.deepEqual(soft, []);
});

test('list paging reads by received rows, handles a missing totalCount and stops at the page limit', async () => {
  // 서버가 numOfRows를 줄여도 전체를 읽는다.
  const capped = aptClient((url) => {
    const pageNo = Number(url.searchParams.get('pageNo'));
    return Response.json(listBody(pageNo <= 3 ? [listItem(`단지${pageNo}`, `A${pageNo}`)] : [], 3));
  });
  assert.equal((await capped.client.getDirectory('1')).length, 3);
  assert.equal(capped.calls.length, 3);

  // 전체 건수가 없으면 첫 페이지에서 멈추지 않고 빈 페이지까지 읽고 건수를 남긴다.
  const noTotal = aptClient((url) => {
    const pageNo = Number(url.searchParams.get('pageNo'));
    return Response.json({ header: { resultCode: '00' }, body: { items: pageNo <= 2 ? [listItem(`단지${pageNo}`, `A${pageNo}`)] : [] } });
  });
  assert.equal((await noTotal.client.getDirectory('1')).length, 2);
  assert.equal(noTotal.calls.length, 3);
  assert.equal(noTotal.client.tags().listNoTotal, 3);
  assert.deepEqual(noTotal.soft, []);

  const endless = aptClient(() => Response.json(listBody([listItem('가단지')], 999999)));
  await assert.rejects(endless.client.getDirectory('1'), { kind: 'aptlist_page_limit' });
  assert.equal(endless.calls.length, 20);
  assert.deepEqual(endless.soft, ['aptlist_page_limit']);
  await assert.rejects(endless.client.getStation('A1'), { kind: 'aptlist_page_limit' });
  assert.equal(endless.calls.length, 20);
});

test('every apartment API failure is soft, reported once and stops further calls', async () => {
  for (const [handler, kind, attempts] of [
    [() => new Response('Forbidden', { status: 403 }), 'aptlist_http_403', 1],
    [() => new Response('', { status: 401 }), 'aptlist_http_401', 1],
    [() => new Response('', { status: 500 }), 'aptlist_http_500', 2],
    [() => { throw new TypeError('fetch failed'); }, 'aptlist_network', 2],
    [() => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }, 'aptlist_timeout', 2],
    [() => ({ ok: true, json: async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); } }), 'aptlist_timeout', 1],
    [() => new Response('<OpenAPI_ServiceResponse/>'), 'aptlist_parse', 1],
    [() => Response.json({ other: 1 }), 'aptlist_parse', 1],
    [() => Response.json({ header: { resultCode: '30' }, body: {} }), 'aptlist_result_30', 1],
    [() => Response.json({ header: { resultCode: '22' }, body: {} }), 'aptlist_result_22', 1],
    [() => Response.json(listBody([{ wrongTag: 1 }])), 'aptlist_parse', 1],
  ]) {
    const { client, calls, soft } = aptClient(handler);
    await assert.rejects(client.getDirectory('1'), { kind });
    await assert.rejects(client.getDirectory('2'), { kind });
    await assert.rejects(client.getStation('A1'), { kind });
    assert.equal(calls.length, attempts, kind);
    assert.deepEqual(soft, [kind]);
  }
  const detail = aptClient(() => new Response('', { status: 403 }));
  await assert.rejects(detail.client.getStation('A1'), { kind: 'aptinfo_http_403' });
});

test('one transient apartment API failure is retried', async () => {
  let count = 0;
  const { client, calls, soft } = aptClient(() => {
    count += 1;
    return count === 1 ? new Response('', { status: 503 }) : Response.json(detailBody({ kaptdWtimesub: '5분이내' }));
  });
  assert.equal((await client.getStation('A1')).walkMinutes, 5);
  assert.equal(calls.length, 2);
  assert.deepEqual(soft, []);
});

test('the apartment client stops at its call cap and time budget', async () => {
  const handler = () => Response.json(detailBody({ kaptdWtimesub: '5분이내' }));
  const capped = aptClient(handler, { limits: { ...config.market.aptInfo, maxCallsPerRun: 2 } });
  await capped.client.getStation('A1');
  await capped.client.getStation('A2');
  await assert.rejects(capped.client.getStation('A3'), { kind: 'apt_call_cap' });
  await assert.rejects(capped.client.getStation('A4'), { kind: 'apt_call_cap' });
  assert.equal(capped.calls.length, 2);
  assert.deepEqual(capped.soft, ['apt_call_cap']);

  let current = 0;
  const timed = aptClient(() => {
    current += 100;
    return handler();
  }, { limits: { ...config.market.aptInfo, budgetMs: 100 }, now: () => new Date(current) });
  await timed.client.getStation('A1');
  await assert.rejects(timed.client.getStation('A2'), { kind: 'apt_budget' });
  assert.equal(timed.calls.length, 1);
  assert.deepEqual(timed.soft, ['apt_budget']);
});

const apt = (extra = {}) => ({
  key: '1-1',
  kind: 'apt',
  houseSecd: '01',
  region: '서울',
  name: '공고단지',
  builder: '',
  address: '서울특별시 강남구 역삼동 1',
  flags: { priceCap: false, publicDistrict: false },
  stages: [],
  ...extra,
});

const saleRows = (count, unit, extra = {}) => Array.from({ length: count }, () => ({
  aptName: '비교단지',
  umd: '역삼동',
  jibun: '100',
  buildYear: 2026,
  amount: unit * 84,
  area: 84,
  floor: 10,
  dealingGbn: '중개거래',
  dealDate: '2026-10-01',
  ...extra,
}));

// 비교 단지 역 도보 3분(5분이내)을 돌려주는 공동주택 조회 가짜
const fakeAptInfo = (overrides = {}) => ({
  calls: [],
  async getDirectory() { return [{ code: 'A1', name: '래미안역세권', dong: '역삼동', ri: '' }]; },
  async getStation(code) {
    this.calls.push(code);
    return { walkMinutes: 5, walkBand: '5분이내' };
  },
  ...overrides,
});

const evaluate = (notice, { trades = [], presale, aptInfo, walkMinutes, soft = [], models = [{ houseType: '084A', area: 84, price: 100000 }], errors = [] } = {}) => evaluateLotto(notice, {
  config,
  today,
  getModels: async () => models,
  getTrades: async () => trades,
  getPresale: presale ? async () => presale : undefined,
  aptInfo,
  walkMinutes,
  onError: (kind) => errors.push(kind),
  onSoft: (kind) => soft.push(kind),
});

test('a subject value with a matched comparable band adjusts the estimate and shows both in the reason', async () => {
  const aptInfo = fakeAptInfo();
  const result = await evaluate(apt(), { trades: saleRows(5, 2000, { aptName: '래미안역세권' }), aptInfo, walkMinutes: 15 });
  // 2000 × 1.02 / (1.06 × 1.05) × 84 = 153962
  assert.equal(result.estimate, 153962);
  assert.equal(result.stationState, 'used');
  assert.deepEqual(aptInfo.calls, ['A1']);
  assert.ok(result.reason.includes('역 도보 15분(입력)'));
  assert.ok(result.reason.includes('래미안역세권 15.4억(5분이내, 브랜드 -5%, 연식 +0%)'));
});

test('no subject value makes no apartment calls, applies no station factor and caps confidence at 중', async () => {
  let called = 0;
  const aptInfo = fakeAptInfo({ async getDirectory() { called += 1; return []; } });
  const trades = ['가', '나', '다', '라'].flatMap((name, index) => saleRows(5, 2000, { aptName: `${name}단지`, jibun: `${index}a` }));
  for (const walkMinutes of [undefined, null]) {
    const result = await evaluate(apt(), { trades, aptInfo, walkMinutes });
    assert.equal(result.estimate, 2000 * 84);
    assert.equal(result.confidence, '중');
    assert.equal(result.stationState, 'noInput');
    assert.ok(result.reason.includes('역 도보 미입력, 역 보정 없음'));
  }
  assert.equal(called, 0);
});

test('apartment failures and name mismatches skip the station adjustment, lower confidence and still estimate', async () => {
  const trades = ['가', '나', '다', '라'].flatMap((name, index) => saleRows(5, 2000, { aptName: `${name}단지`, jibun: `${index}a` }));
  const direct = await evaluate(apt(), { trades, walkMinutes: 15 });
  assert.equal(direct.stationState, 'noData');
  const cases = [
    fakeAptInfo({ async getDirectory() { throw new AppError('aptlist_http_403'); } }),
    fakeAptInfo({ async getDirectory() { return [{ code: 'Z', name: '전혀다른이름', dong: '역삼동', ri: '' }]; } }),
    fakeAptInfo({
      async getDirectory() { return ['가', '나', '다', '라'].map((name) => ({ code: name, name: `${name}단지`, dong: '역삼동', ri: '' })); },
      async getStation() { throw new AppError('aptinfo_timeout'); },
    }),
    fakeAptInfo({
      async getDirectory() { return ['가', '나', '다', '라'].map((name) => ({ code: name, name: `${name}단지`, dong: '역삼동', ri: '' })); },
      async getStation() { return null; },
    }),
  ];
  const reasons = ['역 정보 조회를 못 해', '비교 단지 역 정보 부족으로', '역 정보 조회를 못 해', '비교 단지 역 정보 부족으로'];
  for (const [index, aptInfo] of cases.entries()) {
    const result = await evaluate(apt(), { trades, aptInfo, walkMinutes: 15 });
    assert.equal(result.estimate, 2000 * 84);
    assert.equal(result.stationState, 'noData');
    // 표본은 상 기준을 넘고, 값 부족으로 한 단계 내린다.
    assert.equal(result.confidence, '중');
    assert.ok(result.reason.includes(`역 도보 15분(입력), ${reasons[index]} 역 보정 없음`), result.reason);
  }
  // 조회가 중간에 멈추면 받아 둔 값도 쓰지 않는다. 일부만으로 보정하지 않으려는 것이다.
  const three = trades.filter((row) => row.aptName !== '라단지');
  let station = 0;
  const partial = await evaluate(apt(), {
    trades: three,
    walkMinutes: 15,
    aptInfo: fakeAptInfo({
      async getDirectory() { return ['가', '나', '다'].map((name) => ({ code: name, name: `${name}단지`, dong: '역삼동', ri: '' })); },
      async getStation() {
        station += 1;
        if (station === 3) throw new AppError('aptinfo_timeout');
        return { walkMinutes: 5, walkBand: '5분이내' };
      },
    }),
  });
  assert.equal(partial.stationState, 'noData');
  assert.equal(partial.estimate, 2000 * 84);

  const soft = [];
  await evaluate(apt(), { trades, aptInfo: cases[1], walkMinutes: 15, soft });
  assert.deepEqual(soft, Array(4).fill('apt_name_unmatched'));
});

test('a presale outage lowers confidence and keeps the estimate; presale rows can decide same-complex', async () => {
  const trades = saleRows(5, 2000, { aptName: '가단지' });
  const ok = await evaluate(apt(), { trades, presale: { rows: [], ok: true } });
  const failed = await evaluate(apt(), { trades, presale: { rows: [], ok: false } });
  assert.equal(failed.estimate, ok.estimate);
  assert.equal(failed.confidence, '하');

  const same = saleRows(5, 1200, { aptName: '공고단지', jibun: '1', presale: true, buildYear: null });
  const presale = await evaluate(apt(), { trades, presale: { rows: same, ok: true } });
  assert.equal(presale.estimate, 1200 * 84);
  assert.equal(presale.confidence, '상');
  assert.ok(presale.reason.includes('분양권 5건'));

  const rejected = await evaluateLotto(apt(), {
    config,
    today,
    getModels: async () => [{ houseType: '084A', area: 84, price: 100000 }],
    getTrades: async () => trades,
    getPresale: async () => { throw new Error('x'); },
  });
  assert.equal(rejected.estimate, ok.estimate);
});

test('a presale outage lowers each confidence level by one', async () => {
  const trades = [
    ...saleRows(5, 2000, { aptName: '가단지', jibun: '11' }),
    ...saleRows(5, 2000, { aptName: '나단지', jibun: '12' }),
    ...saleRows(5, 2000, { aptName: '다단지', jibun: '13' }),
    ...saleRows(5, 2000, { aptName: '라단지', jibun: '14' }),
  ];
  assert.equal((await evaluate(apt(), { trades, presale: { rows: [], ok: true } })).confidence, '중');
  assert.equal((await evaluate(apt(), { trades, presale: { rows: [], ok: false } })).confidence, '하');
  const same = saleRows(5, 1200, { aptName: '공고단지', jibun: '1' });
  assert.equal((await evaluate(apt(), { trades: same, presale: { rows: [], ok: true } })).confidence, '상');
  assert.equal((await evaluate(apt(), { trades: same, presale: { rows: [], ok: false } })).confidence, '중');
});

test('a programming error in the station lookup is reported, not treated as an API failure', async () => {
  const errors = [];
  const soft = [];
  const result = await evaluate(apt(), {
    trades: saleRows(5, 2000, { aptName: '래미안역세권' }),
    walkMinutes: 15,
    errors,
    soft,
    aptInfo: fakeAptInfo({ async getStation() { throw new TypeError('x is not a function'); } }),
  });
  assert.deepEqual(errors, ['unexpected_error']);
  assert.deepEqual(soft, []);
  assert.equal(result.status, STATUS.UNDETERMINED);
  assert.equal(result.estimate, null);
});

test('disjoint house types each look up their own comparables, so neither loses coverage', async () => {
  const large = Array.from({ length: 8 }, (_, index) => saleRows(3, 1000, { aptName: `대형단지${index}호`, jibun: `L${index}`, area: 84, amount: 84000 })).flat();
  const small = Array.from({ length: 8 }, (_, index) => saleRows(2, 1000, { aptName: `소형단지${index}호`, jibun: `S${index}`, area: 59, amount: 59000 })).flat();
  const directory = [...large, ...small].map((row) => ({ code: row.jibun, name: row.aptName, dong: '역삼동', ri: '' }));
  const looked = new Set();
  const result = await evaluate(apt(), {
    trades: [...large, ...small],
    walkMinutes: 5,
    // 59㎡이 마진이 더 커서 판별에 쓰인다. 표본이 적어 묶음 상한이 있으면 값을 먼저 잃는 쪽이다.
    models: [{ houseType: '084A', area: 84, price: 90000 }, { houseType: '059A', area: 59, price: 30000 }],
    aptInfo: fakeAptInfo({
      async getDirectory() { return [...new Map(directory.map((item) => [item.code, item])).values()]; },
      async getStation(code) {
        looked.add(code);
        return { walkMinutes: 5, walkBand: '5분이내' };
      },
    }),
  });
  assert.equal(looked.size, 16);
  assert.ok(result.reason.includes('059A'));
  assert.equal(result.stationState, 'used');
});

test('same-complex models make no apartment calls even with a subject value', async () => {
  let called = 0;
  const aptInfo = fakeAptInfo({ async getDirectory() { called += 1; return []; } });
  const result = await evaluate(apt(), { trades: saleRows(5, 1500, { aptName: '공고단지', jibun: '1' }), aptInfo, walkMinutes: 15 });
  assert.equal(called, 0);
  assert.equal(result.stationState, null);
  assert.equal(result.estimate, 1500 * 84);
});

test('a real client with a small cap degrades later notices without further calls', async () => {
  const soft = [];
  const calls = [];
  const client = createAptInfoClient({
    key: 'k',
    limits: { ...config.market.aptInfo, maxCallsPerRun: 2 },
    sleep: noSleep,
    onSoft: (kind) => soft.push(kind),
    fetch: async (url) => {
      calls.push(String(url));
      return String(url).includes('getSigunguAptList4')
        ? Response.json(listBody([listItem('역삼푸른숲', 'A1'), listItem('역삼큰나무', 'A2')]))
        : Response.json(detailBody({ kaptdWtimesub: '5분이내' }));
    },
  });
  const first = await evaluate(apt(), { trades: saleRows(5, 1000, { aptName: '역삼푸른숲', jibun: '11' }), aptInfo: client, walkMinutes: 5 });
  assert.equal(first.stationState, 'used');
  assert.equal(calls.length, 2);
  const second = await evaluate(apt(), { trades: saleRows(5, 1000, { aptName: '역삼큰나무', jibun: '12' }), aptInfo: client, walkMinutes: 5 });
  assert.equal(second.stationState, 'noData');
  assert.equal(calls.length, 2);
  assert.deepEqual(soft, ['apt_call_cap']);
});

test('restricted types are 대상 외 with empty margin before triggers, reading only model rows for the average price', async () => {
  for (const name of ['고덕강일 3단지 토지임대부', '광교 자연앤 센트레빌 59㎡ 지분적립형', '하남교산 신혼희망타운']) {
    for (const flags of [{ priceCap: false, publicDistrict: false }, { priceCap: true, publicDistrict: true }]) {
      let models = 0;
      let lookups = 0;
      const result = await evaluateLotto(apt({ name, flags }), {
        config,
        today,
        getModels: async () => { models += 1; return [{ houseType: '059A', area: 59, price: 40000, households: 10 }]; },
        getTrades: async () => { lookups += 1; return []; },
        getPresale: async () => { lookups += 1; return { rows: [], ok: true }; },
      });
      assert.equal(result.status, STATUS.OUT_OF_SCOPE);
      assert.equal(result.clearMarket, true);
      assert.equal(result.margin, null);
      assert.equal(result.marginRate, null);
      assert.equal(result.estimate, null);
      // 평균 분양가만 쓰려고 주택형은 읽고, 실거래는 조회하지 않는다.
      assert.equal(models, 1);
      assert.equal(lookups, 0);
      assert.equal(result.averagePrice, 40000);
      assert.equal(keepPreviousLotto(result, STATUS.LOTTO).status, STATUS.OUT_OF_SCOPE);
    }
  }
  const remainder = await evaluate(apt({ kind: 'remainder', houseSecd: '04', name: '신혼희망타운 무순위' }));
  assert.equal(remainder.status, STATUS.OUT_OF_SCOPE);
});

test('lotto triggers are unchanged, and margin at or above thresholds with no trigger is 로또', async () => {
  assert.deepEqual(
    [config.lotto.includeRemainder, config.lotto.includeResupply, config.lotto.includeArbitrary, config.lotto.includePriceCap, config.lotto.includePublicDistrict],
    [true, true, false, true, true],
  );
  assert.equal(config.lotto.minMarginManwon, 30000);
  assert.equal(config.lotto.minMarginRate, 0.2);

  const low = saleRows(5, 1000);
  const triggers = [
    [apt({ kind: 'remainder', houseSecd: '04' }), '무순위'],
    [apt({ kind: 'remainder', houseSecd: '06' }), '불법행위 재공급'],
    [apt({ flags: { priceCap: true, publicDistrict: false } }), '분양가상한제'],
    [apt({ flags: { priceCap: false, publicDistrict: true } }), '공공주택지구'],
  ];
  for (const [notice, label] of triggers) {
    const result = await evaluate(notice, { trades: low });
    assert.equal(result.status, STATUS.LOTTO);
    assert.ok(result.reason.includes(label));
    assert.ok(result.margin < 0);
    assert.ok(result.reason.includes('안전 마진 -'), result.reason);
    assert.ok(result.reason.includes('084A'));
  }
  assert.equal((await evaluate(apt(), { trades: low })).status, STATUS.NOT);
  const high = await evaluate(apt(), { trades: ['1', '2', '3', '4'].flatMap((n) => saleRows(5, 2500, { aptName: `비교단지${n}`, jibun: `10${n}` })) });
  assert.equal(high.status, STATUS.LOTTO);
  assert.ok(!high.reason.includes('무순위'));
});

test('the reason leads with the margin so the Kakao text keeps it, with terms renamed', async () => {
  const result = await evaluate(apt({ flags: { priceCap: true, publicDistrict: false } }), { trades: saleRows(5, 1000, { aptName: '아주 긴 이름의 비교 단지 '.repeat(5) }) });
  const text = buildKakaoText({ notice: { name: '공고단지' }, stage: { name: '1순위 해당', start: THU, end: THU }, reason: result.reason });
  assert.ok(Array.from(text).length <= 200);
  assert.ok(text.includes('안전 마진'));
  assert.ok(text.includes('마진율'));
  assert.ok(text.includes('추정치'));
  assert.ok(!text.includes('차익'));
  assert.ok(!result.reason.includes('차익'));
});

test('a price-rule 로또 needs at least 중 confidence; triggers do not', async () => {
  const one = saleRows(5, 2500);
  const two = ['1', '2', '3', '4'].flatMap((n) => saleRows(5, 2500, { aptName: `비교단지${n}`, jibun: `10${n}` }));
  const weak = await evaluate(apt(), { trades: one });
  assert.equal(weak.confidence, '하');
  assert.ok(weak.margin >= config.lotto.minMarginManwon);
  assert.equal(weak.status, STATUS.NOT);
  assert.ok(weak.reason.startsWith('가격 기준은 넘지만 추정 신뢰도가 하라 로또로 보지 않음; 안전 마진'), weak.reason);
  assert.ok(weak.shortReason.startsWith('가격 기준은 넘지만 추정 신뢰도가 하라 로또로 보지 않음; 안전 마진'));
  const firm = await evaluate(apt(), { trades: two });
  assert.equal(firm.confidence, '중');
  assert.equal(firm.status, STATUS.LOTTO);
  const trigger = await evaluate(apt({ flags: { priceCap: true, publicDistrict: false } }), { trades: one });
  assert.equal(trigger.status, STATUS.LOTTO);
  assert.equal(trigger.confidence, '하');
  // 이미 로또였던 공고는 신뢰도 하인 결과로 빠지지 않는다.
  const kept = keepPreviousLotto(weak, STATUS.LOTTO);
  assert.equal(kept.status, STATUS.LOTTO);
  assert.ok(kept.reason.startsWith('이전 판별 유지(이번 추정 신뢰도 하) (이번 실행: 가격 기준은 넘지만'));
});

test('the reason says when the measured error exceeds the discount cap or could not be measured', async () => {
  const wide = [1000, 1600, 2200, 2800].flatMap((unit, index) => saleRows(4, unit, { aptName: `넓은${index}단지`, jibun: `w${index}` }));
  const over = await evaluate(apt(), { trades: wide });
  assert.ok(over.reason.includes('검증 오차가 상한 10%를 넘어 10%만 차감, 실제 위험은 더 큼'), over.reason);
  assert.ok(!over.reason.includes('20%'));
  assert.equal(over.confidence, '하');
  const few = await evaluate(apt(), { trades: [...saleRows(5, 2500), ...saleRows(5, 2500, { aptName: '비교단지2', jibun: '101' })] });
  assert.ok(few.reason.includes('비교 단지가 적어 오차를 재지 못해 차감 없음, 신뢰도 하'), few.reason);
  assert.equal(few.confidence, '하');
  assert.equal(few.estimate * 1, few.margin + 100000 + 1500 + 3300);
});

// 2026-11-08 실제 실행에서 빌리브센트하이(2차)가 자기 분양권 거래를 찾지 못하고 다산 신도시 단지로 계산됐다.
// 공고 주소의 법정동이 '화도읍'으로만 읽혀, 국토부의 '화도읍 마석우리'나 '마석우리'와 글자가 달라 모두 걸러졌다.
const BILLIVE = {
  key: 'billive', kind: 'remainder', houseSecd: '04', region: '경기', name: '빌리브센트하이(2차)', builder: '',
  address: '경기 남양주시 화도읍 마석우리 295-32', flags: { priceCap: false, publicDistrict: false }, stages: [],
};
const billivePresale = (umd) => [59000, 63000, 66000, 68000, 70000].map((amount) => ({
  aptName: '빌리브센트하이', umd, jibun: '295-32', amount, area: 84.97, floor: 10, dealingGbn: '중개거래', dealDate: '2026-09-15', presale: true, buildYear: null,
}));
const dasanTrades = ['다산롯데캐슬', '다산 이편한세상자이', '다산반도유보라'].flatMap((aptName, index) => Array.from({ length: 8 }, () => ({
  aptName, umd: '다산동', jibun: String(6000 + index), amount: 103000, area: 84.97, floor: 10, dealingGbn: '중개거래', dealDate: '2026-09-15', buildYear: 2019,
})));
const evaluateBillive = (presaleRows) => evaluateLotto(BILLIVE, {
  config,
  today,
  getModels: async () => [{ houseType: '084.9760B', area: 84.976, price: 67700 }],
  getTrades: async () => dasanTrades,
  getPresale: async () => ({ rows: presaleRows, ok: true }),
});

test('빌리브센트하이(2차) in 화도읍 마석우리 is valued from its own presale trades', async () => {
  for (const umd of ['화도읍 마석우리', '마석우리']) {
    const result = await evaluateBillive(billivePresale(umd));
    assert.ok(result.reason.includes('같은 단지 거래 5건(분양권 5건), 보정 없음'), `${umd}: ${result.reason}`);
    // 분양권 5.9~7.0억의 최근 거래 가중 중위값
    assert.ok(result.estimate >= 59000 && result.estimate <= 70000, String(result.estimate));
    assert.ok(!result.reason.includes('다산'));
  }
});

test('a 리 is read only directly after the 읍·면, never from a building name', () => {
  assert.equal(resolveAddress('경기 남양주시 오남읍 양지로 12 (오남센트럴밸리)', '경기').village, null);
  assert.equal(resolveAddress('경기 남양주시 화도읍 경춘로 1 (마석갤러리)', '경기').village, null);
  assert.equal(resolveAddress('경기 남양주시 오남읍 양지로 12 오남센트럴밸리', '경기').village, null);
  assert.equal(resolveAddress('경기 남양주시 화도읍 마석우리 295-32 (마석갤러리)', '경기').village, '마석우리');
});

test('the market line counts how MOLIT writes 법정동 names, without the names', async () => {
  const trades = [
    tradeTags({ name: '가단지', umd: '화도읍 마석우리', jibun: '1', amount: '84,000' }),
    tradeTags({ name: '나단지', umd: '마석우리', jibun: '2', amount: '84,000' }),
    tradeTags({ name: '다단지', umd: '역삼동', jibun: '3', amount: '84,000' }),
    tradeTags({ name: '라단지', umd: '', jibun: '4', amount: '84,000' }),
  ];
  // 분양권 행도 센다.
  const presale = (url) => new Response(xml(url.searchParams.get('DEAL_YMD') === '202610' ? [tradeTags({ name: '분양권단지', umd: '화도읍 마석우리', jibun: '9', extra: '<ownershipGbn>분</ownershipGbn>' })] : []));
  const h = harness({ fetch: worldFetch({ trades, presale }).fetch });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.ok(marketLine(h).includes(' umd_town=6 umd_village=5 umd_dong=5 umd_other=5 '), marketLine(h));
  assert.ok(!marketLine(h).includes('마석우리'));
});

test('읍·면 addresses keep their 리 for the subject and its lot number', () => {
  assert.deepEqual(resolveAddress('경기 남양주시 화도읍 마석우리 295-32', '경기'), { region: '경기', code: '41360', umd: '화도읍', village: '마석우리' });
  assert.deepEqual(resolveAddress('경기도 가평군 청평면 청평리 1', '경기'), { region: '경기', code: '41820', umd: '청평면', village: '청평리' });
  assert.deepEqual(resolveAddress('경기도 남양주시 오남읍 양지로 12', '경기'), { region: '경기', code: '41360', umd: '오남읍', village: null });
  assert.deepEqual(resolveAddress('서울특별시 강남구 역삼동 1'), { region: '서울', code: '11680', umd: '역삼동', village: null });
});

test('a same-lot presale row in the same 리 counts as the same complex even under another name', async () => {
  const sameLot = await evaluateBillive(billivePresale('화도읍 마석우리').map((row) => ({ ...row, aptName: '마석 신축 분양권' })));
  assert.ok(sameLot.reason.includes('같은 단지 거래 5건'), sameLot.reason);
  // 같은 지번이라도 다른 리면 같은 단지가 아니다.
  const other = await evaluateBillive(billivePresale('화도읍 가곡리').map((row) => ({ ...row, aptName: '마석 신축 분양권' })));
  assert.ok(!other.reason.includes('같은 단지 거래'), other.reason);
  // 지역을 모르는 행이나 읍만 있는 행은 지번이 같아도 같은 단지로 보지 않는다.
  for (const umd of ['', '화도읍']) {
    const unknown = await evaluateBillive(billivePresale(umd).map((row) => ({ ...row, aptName: '마석 신축 분양권' })));
    assert.ok(!unknown.reason.includes('같은 단지 거래'), `${umd}: ${unknown.reason}`);
  }
});

test('오남읍 valued only from other parts of 남양주시 is 하 and the reason says why', async () => {
  const notice = { ...BILLIVE, key: 'onam', name: '오남역 서희스타힐스', address: '경기 남양주시 오남읍 양지리 1' };
  const result = await evaluateLotto(notice, {
    config,
    today,
    getModels: async () => [{ houseType: '084.9000A', area: 84.97, price: 50000 }],
    getTrades: async () => dasanTrades,
    getPresale: async () => ({ rows: [], ok: true }),
  });
  assert.equal(result.confidence, '하');
  assert.ok(result.reason.includes('(시군구, 같은 읍·면 단지를 찾지 못해 신뢰도 하,'), result.reason);
});

test('a small house type shows comparables at its own area, not scaled to 84㎡', async () => {
  const small = [...saleRows(5, 3000, { aptName: '사가정센트럴아이파크', jibun: '41', area: 59, amount: 177000 }), ...saleRows(5, 3000, { aptName: '면목동신축', jibun: '42', area: 59, amount: 177000 })];
  const result = await evaluate(apt(), { trades: small, models: [{ houseType: '058.9900A', area: 58.99, price: 90000 }] });
  // 59㎡ 단가 3000만 원을 브랜드 보정(÷1.05)해 58.99㎡로 곱하면 16.9억이다. 84㎡로 늘렸다면 24.0억으로 보였다.
  assert.ok(result.reason.includes('보정 후 59㎡ 기준: 사가정센트럴아이파크 16.9억'), result.reason);
  assert.ok(!result.reason.includes('24.0억'));
});

test('the average price is weighted by supply households, or a simple mean when a count is missing', () => {
  const model = (price, households) => ({ houseType: 'x', area: 84, price, households });
  // (50000 × 100 + 70000 × 300) / 400 = 65000
  assert.equal(averagePriceOf([model(50000, 100), model(70000, 300)]), 65000);
  // 세대수를 모르는 주택형이 있으면 단순 평균
  assert.equal(averagePriceOf([model(50000, 100), model(70000, null)]), 60000);
  // 0세대인 주택형은 가중치가 0이다: [059A 0세대 4.0억, 084A 300세대 7.0억] → 7.0억
  assert.equal(averagePriceOf([{ ...model(40000, 0), houseType: '059A' }, { ...model(70000, 300), houseType: '084A' }]), 70000);
  // 세대수 합이 0이면 단순 평균
  assert.equal(averagePriceOf([model(40000, 0), model(70000, 0)]), 55000);
  // 가격이 없는 주택형은 뺀다.
  assert.equal(averagePriceOf([model(50000, 100), model(null, 900), model(0, 900)]), 50000);
  assert.equal(averagePriceOf([]), null);
  assert.equal(averagePriceOf(null), null);
  assert.equal(averagePriceOf([model(null, 10)]), null);
  assert.equal(averagePriceOf([model(50001, 1), model(50002, 2)]), 50002);
});

test('a failed model lookup on a restricted notice is soft, not an error', async () => {
  const errors = [];
  const soft = [];
  const once = [];
  const result = await evaluateLotto(apt({ name: '하남교산 신혼희망타운' }), {
    config,
    today,
    getModels: async () => { throw new TypeError('fetch failed'); },
    getTrades: async () => [],
    onError: (kind) => errors.push(kind),
    onSoft: (kind) => soft.push(kind),
    onSoftOnce: (kind) => once.push(kind),
  });
  assert.equal(result.status, STATUS.OUT_OF_SCOPE);
  assert.equal(result.averagePrice, null);
  assert.deepEqual(errors, []);
  assert.deepEqual(soft, []);
  assert.deepEqual(once, ['average_price_lookup_failed']);
});

test('a model outage across restricted notices is logged once per run and sends no error mail', async () => {
  const rows = ['하남교산 신혼희망타운', '고덕강일 3단지 토지임대부', '광교 지분적립형'].map((name, index) => aptRow({ HOUSE_MANAGE_NO: String(20 + index), HOUSE_NM: name }));
  const base = worldFetch({ rows });
  let modelCalls = 0;
  const fetch = async (url) => {
    if (String(url).includes('getAPTLttotPblancMdl')) {
      modelCalls += 1;
      throw new TypeError('fetch failed');
    }
    return base.fetch(url);
  };
  const h = harness({ fetch });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  // 첫 공고에서 재시도 한 주기 뒤 장애로 보고 이후 공고는 호출하지 않는다.
  assert.equal(modelCalls, 3);
  assert.equal(errorMail(h), undefined);
  assert.ok(marketLine(h).endsWith('soft=average_price_lookup_failed:1'), marketLine(h));
  assert.equal(h.store.state.upserts.length, 3);
  assert.ok(h.store.state.upserts.every((item) => !Object.hasOwn(item.properties, '평균 분양가')));
});

test('the average price is recorded for triggered, priced and undetermined notices alike', async () => {
  const models = [{ houseType: '059A', area: 59, price: 40000, households: 100 }, { houseType: '084A', area: 84, price: 60000, households: 300 }];
  const triggered = await evaluate(apt({ flags: { priceCap: true, publicDistrict: false } }), { models, trades: saleRows(5, 1000) });
  assert.equal(triggered.status, STATUS.LOTTO);
  assert.equal(triggered.averagePrice, 55000);
  const priced = await evaluate(apt(), { models, trades: saleRows(5, 1000) });
  assert.equal(priced.averagePrice, 55000);
  const undetermined = await evaluate(apt(), { models, trades: [] });
  assert.equal(undetermined.status, STATUS.UNDETERMINED);
  assert.equal(undetermined.averagePrice, 55000);
  const failed = await evaluateLotto(apt(), { config, today, getModels: async () => { throw new Error('x'); }, getTrades: async () => [] });
  assert.equal(failed.averagePrice, null);
});

test('평균 분양가 is written for every row that has it, kept on restricted rows, and never written empty', () => {
  const props = buildProperties(notice(), { status: '아님', averagePrice: 55000 }, THU);
  assert.deepEqual(props['평균 분양가'], { number: 55000 });
  // 제한 유형도 공고의 사실이라 지우지 않는다.
  const restricted = buildProperties(notice(), { status: '대상 외', clearMarket: true, averagePrice: 40000 }, THU);
  assert.deepEqual(restricted['평균 분양가'], { number: 40000 });
  assert.deepEqual(restricted['안전 마진'], { number: null });
  // 값이 없으면 보내지 않아 저장된 값이 남는다.
  for (const evaluation of [{ status: '판별 불가' }, { status: '대상 외', clearMarket: true }, null]) {
    assert.equal(Object.hasOwn(buildProperties(notice(), evaluation, THU), '평균 분양가'), false);
  }
});

// 2026-11-08 실제 행: 의정부역 펠리스타워 양우내안애 59.98㎡, 최고 분양가 6.37억, 추정 시세 4.86억.
// 보수 시세 대비로는 -70%였고, 할인 20%로 분양가 대비 -43%였다. 단지 1곳이라 오차를 재지 못해 이제는 할인하지 않아 -27%다.
test('the margin rate is shown against the price (의정부 59.98㎡ example)', async () => {
  const notice = apt({ name: '의정부역 펠리스타워 양우내안애', address: '경기 의정부시 의정부동 1', region: '경기' });
  const trades = saleRows(5, 48600 / 59.98, { aptName: '의정부비교', umd: '의정부동', jibun: '9', area: 59.98, amount: 48600 });
  const result = await evaluate(notice, { trades, models: [{ houseType: '059.9800A', area: 59.98, price: 63700 }] });
  assert.equal(result.estimate, 48600);
  // 보수 시세 48600 × 0.8 = 38880, 취득세 874만, 마진 38880 - 63700 - 1500 - 874 = -27194
  // 보수 시세 48600(할인 없음), 취득세 874만, 마진 48600 - 63700 - 1500 - 874 = -17474
  assert.equal(result.margin, -17474);
  assert.ok(Math.abs(result.marginRate - -17474 / 63700) < 1e-12);
  assert.ok(result.reason.includes('마진율 -27%(분양가 대비)'), result.reason);
  assert.ok(result.shortReason.includes('마진율 -27%(분양가 대비)'));
  assert.equal(result.confidence, '하');
  assert.ok(!result.reason.includes('-70%'));
});

test('a margin that is 20% of the price passes the rate rule even below 20% of the safety value', async () => {
  // 같은 값의 단지 4곳이라 오차 0, 할인 0%. 보수 시세 80000, 마진 80000 - 63700 - 1500 - 874 = 13926.
  // 분양가 대비 21.9%라 기준을 넘는다. 보수 시세 대비라면 17.4%였다.
  const trades = ['a1', 'a2', 'a3', 'a4'].flatMap((jibun) => saleRows(5, 80000 / 59.98, { aptName: `비교${jibun}`, jibun, area: 59.98, amount: 80000 }));
  const result = await evaluate(apt(), { trades, models: [{ houseType: '059.9800A', area: 59.98, price: 63700 }] });
  assert.equal(result.margin, 13926);
  assert.equal(result.confidence, '중');
  assert.equal(result.status, STATUS.LOTTO);
  assert.ok(result.reason.includes('마진율 22%(분양가 대비)'), result.reason);
});

test('the Applyhome constructor field becomes the subject builder', () => {
  const endpoint = ENDPOINTS.find((item) => item.kind === 'apt');
  const notice = normalizeDetail(endpoint, { HOUSE_MANAGE_NO: '1', PBLANC_NO: '1', CNSTRCT_ENTRPS_NM: 'GS건설(주)', BSNS_MBY_NM: '시행사' });
  assert.equal(notice.builder, 'GS건설(주)');
  assert.equal(normalizeDetail(endpoint, { HOUSE_MANAGE_NO: '1', PBLANC_NO: '1' }).builder, '');
});

// buildProperties와 스키마 변경

const OLD = { '예상 차익': { type: 'number', number: {} }, 차익률: { type: 'number', number: {} } };
const NEW = { '안전 마진': { type: 'number', number: {} }, 마진율: { type: 'number', number: {} } };
const CONFIDENCE_PROP = { '시세 신뢰도': { type: 'select', select: {} } };
const WALK = { '역 도보(분)': { type: 'number', number: {} } };
const AVERAGE = { '평균 분양가': { type: 'number', number: {} } };
const RECOMMEND = { '추천 전형': { type: 'select', select: {} }, '추천 접수일': { type: 'date', date: {} } };
const OTHERS = { ...WALK, ...AVERAGE, ...RECOMMEND, 순번: { type: 'number', number: {} }, 관심: { type: 'checkbox', checkbox: {} } };

const notice = (extra = {}) => ({ key: '1-1', name: '테스트', region: '서울', typeLabel: 'APT', source: '청약홈', url: 'https://www.applyhome.co.kr/a', stages: [], ...extra });

test('buildProperties uses the new names and omits empty values', () => {
  const props = buildProperties(notice(), { status: '아님', estimate: 100, margin: -5, marginRate: -0.05, confidence: '중', stationState: 'used' }, THU);
  assert.deepEqual(props['안전 마진'], { number: -5 });
  assert.deepEqual(props['마진율'], { number: -0.05 });
  assert.deepEqual(props['시세 신뢰도'], { select: { name: '중' } });
  assert.equal(props['예상 차익'], undefined);
  assert.equal(props['차익률'], undefined);
  assert.ok(!Object.keys(props).some((name) => name === 'null' || name === 'stationState'));

  const empty = buildProperties(notice(), { status: '판별 불가' }, THU);
  assert.equal(Object.hasOwn(empty, '안전 마진'), false);
  assert.equal(Object.hasOwn(empty, '시세 신뢰도'), false);
});

test('restricted evaluations send explicit nulls that clear stored values', () => {
  const props = buildProperties(notice(), { status: '대상 외', reason: 'r', topPrice: null, estimate: null, margin: null, marginRate: null, clearMarket: true }, THU);
  assert.deepEqual(props['추정 시세'], { number: null });
  assert.deepEqual(props['안전 마진'], { number: null });
  assert.deepEqual(props['마진율'], { number: null });
  assert.deepEqual(props['시세 신뢰도'], { select: null });
  // 분양가는 공고의 사실이라 지우지 않는다.
  assert.equal(Object.hasOwn(props, '최고 분양가'), false);

  const old = buildProperties(notice(), { status: '대상 외', clearMarket: true }, THU, { margin: '예상 차익', marginRate: '차익률', confidence: null });
  assert.deepEqual(old['예상 차익'], { number: null });
  assert.deepEqual(old['차익률'], { number: null });
  assert.equal(Object.hasOwn(old, '안전 마진'), false);
  assert.equal(Object.hasOwn(old, 'null'), false);
});

function schemaFake(initial, { intercept = () => null, children } = {}) {
  const calls = [];
  const state = { properties: { ...initial }, values: {} };
  const list = children ?? [
    { id: 'db', type: 'child_database', child_database: { title: '청약 정보' } },
    { id: 'src', type: 'child_page', child_page: { title: '청약 수집 소스' } },
  ];
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname.replace('/v1', '');
    const body = init.body ? JSON.parse(init.body) : null;
    const call = { method: init.method, path, body };
    calls.push(call);
    const replaced = intercept(call);
    if (replaced) return replaced;
    if (init.method === 'GET' && path.startsWith('/blocks/')) return Response.json({ results: list, has_more: false });
    if (init.method === 'GET' && path === '/databases/db') return Response.json({ id: 'db', properties: state.properties });
    if (init.method === 'PATCH' && path === '/databases/db') {
      for (const [name, change] of Object.entries(body.properties)) {
        if (change.name) {
          // 실제 Notion처럼 이름이 겹치면 거절한다.
          if (state.properties[change.name]) return new Response('', { status: 400 });
          state.properties[change.name] = state.properties[name];
          delete state.properties[name];
        } else {
          state.properties[name] = { type: Object.keys(change)[0], ...change };
        }
      }
      return Response.json({ id: 'db' });
    }
    if (path === '/databases') return Response.json({ id: 'db' });
    if (path.endsWith('/query')) return Response.json({ has_more: false, results: [] });
    // 없는 속성으로 쓰면 실제 Notion처럼 400이다.
    if (body?.properties && (path === '/pages' || path.startsWith('/pages/')) && body.parent?.database_id !== undefined) {
      for (const name of Object.keys(body.properties)) {
        if (!state.properties[name] && (name === '안전 마진' || name === '마진율' || name === '예상 차익' || name === '차익률' || name === '시세 신뢰도')) {
          return new Response('', { status: 400 });
        }
      }
    }
    return Response.json({ id: 'page' });
  };
  return { calls, fetch, state };
}

const NOTION_CONFIG = { notion: { databaseTitle: '청약 정보', sourcesPageTitle: '청약 수집 소스' } };
const realStore = (fake) => createNotionStore({ key: 'k', parentPageId: 'parent', config: NOTION_CONFIG, sources: [], fetch: fake.fetch, minIntervalMs: 0, sleep: noSleep });
const schemaPatches = (fake) => fake.calls.filter((call) => call.method === 'PATCH' && call.path === '/databases/db').map((call) => call.body.properties);
const rowWrite = (fake) => fake.calls.find((call) => call.method === 'POST' && call.path === '/pages');
const evaluation = { status: '아님', reason: 'r', estimate: 1, margin: 2, marginRate: 0.1, confidence: '중' };

test('rename: old names only are renamed by name, and the row then writes under the new name', async () => {
  const fake = schemaFake({ ...OLD, ...CONFIDENCE_PROP, ...OTHERS });
  const store = realStore(fake);
  await store.init();
  assert.deepEqual(schemaPatches(fake), [{ '예상 차익': { name: '안전 마진' } }, { 차익률: { name: '마진율' } }]);
  await store.upsert(notice(), evaluation, undefined, THU);
  assert.deepEqual(rowWrite(fake).body.properties['안전 마진'], { number: 2 });
  assert.deepEqual(store.schemaIssues(), []);
});

test('rename: a second run does nothing', async () => {
  const fake = schemaFake({ ...OLD, ...CONFIDENCE_PROP, ...OTHERS });
  await realStore(fake).init();
  const before = schemaPatches(fake).length;
  await realStore(fake).init();
  assert.equal(schemaPatches(fake).length, before);
});

test('rename: new names only, nothing to do', async () => {
  const fake = schemaFake({ ...NEW, ...CONFIDENCE_PROP, ...OTHERS });
  await realStore(fake).init();
  assert.deepEqual(schemaPatches(fake), []);
});

test('rename: both names present never renames onto the existing one and writes to the new', async () => {
  const fake = schemaFake({ ...OLD, ...NEW, ...CONFIDENCE_PROP, ...OTHERS });
  const store = realStore(fake);
  await store.init();
  assert.deepEqual(schemaPatches(fake), []);
  await store.upsert(notice(), evaluation, undefined, THU);
  const written = rowWrite(fake).body.properties;
  assert.deepEqual(written['안전 마진'], { number: 2 });
  assert.equal(Object.hasOwn(written, '예상 차익'), false);
});

test('rename: neither name present adds the new ones', async () => {
  const fake = schemaFake({ ...CONFIDENCE_PROP, ...OTHERS });
  await realStore(fake).init();
  assert.deepEqual(schemaPatches(fake), [
    { '안전 마진': { number: { format: 'number' } } },
    { 마진율: { number: { format: 'percent' } } },
  ]);
});

test('rename: only runs when createMissing is true', async () => {
  const fake = schemaFake({ ...OLD, ...OTHERS });
  await realStore(fake).init({ createMissing: false });
  assert.deepEqual(schemaPatches(fake), []);
  assert.ok(!fake.calls.some((call) => call.method === 'GET' && call.path === '/databases/db'));
});

test('rename: a new database carries the new names and is not patched', async () => {
  const fake = schemaFake({}, { children: [] });
  await realStore(fake).init();
  const created = fake.calls.find((call) => call.path === '/databases').body.properties;
  assert.deepEqual(created['안전 마진'], { number: { format: 'number' } });
  assert.deepEqual(created['마진율'], { number: { format: 'percent' } });
  assert.deepEqual(created['시세 신뢰도'], { select: { options: [{ name: '상' }, { name: '중' }, { name: '하' }] } });
  assert.equal(Object.hasOwn(created, '예상 차익'), false);
  assert.equal(Object.hasOwn(created, '차익률'), false);
  assert.deepEqual(schemaPatches(fake), []);
});

test('rename failure: writes keep going under the old names, and the issue is reported once', async () => {
  const fake = schemaFake({ ...OLD, ...CONFIDENCE_PROP, ...OTHERS }, {
    intercept: (call) => (call.method === 'PATCH' && call.path === '/databases/db' ? new Response('body-secret', { status: 403 }) : null),
  });
  const store = realStore(fake);
  await store.init();
  assert.deepEqual(store.schemaIssues(), ['notion_rename_failed', 'notion_rename_failed']);
  await store.upsert(notice(), evaluation, undefined, THU);
  const written = rowWrite(fake).body.properties;
  assert.deepEqual(written['예상 차익'], { number: 2 });
  assert.deepEqual(written['차익률'], { number: 0.1 });
  assert.equal(Object.hasOwn(written, '안전 마진'), false);
});

test('rename failure on one property keeps each on the name that exists', async () => {
  const fake = schemaFake({ ...OLD, ...CONFIDENCE_PROP, ...OTHERS }, {
    intercept: (call) => (call.method === 'PATCH' && call.path === '/databases/db' && call.body.properties.차익률 ? new Response('', { status: 400 }) : null),
  });
  const store = realStore(fake);
  await store.init();
  await store.upsert(notice(), evaluation, undefined, THU);
  const written = rowWrite(fake).body.properties;
  assert.deepEqual(written['안전 마진'], { number: 2 });
  assert.deepEqual(written['차익률'], { number: 0.1 });
});

test('a failed schema read omits only the renamed columns, so other values are still written', async () => {
  const fake = schemaFake({ ...OLD, ...OTHERS }, {
    intercept: (call) => (call.method === 'GET' && call.path === '/databases/db' ? new Response('', { status: 403 }) : null),
  });
  const store = realStore(fake);
  await store.init();
  assert.deepEqual(store.schemaIssues(), ['notion_schema_read_failed']);
  await store.upsert(notice(), evaluation, undefined, THU);
  const written = rowWrite(fake).body.properties;
  for (const name of ['안전 마진', '마진율', '예상 차익', '차익률', '시세 신뢰도']) assert.equal(Object.hasOwn(written, name), false, name);
  assert.deepEqual(written['추정 시세'], { number: 1 });
});

test('a new name of another type is left alone, and the old column keeps receiving values', async () => {
  const fake = schemaFake({ '안전 마진': { type: 'rich_text', rich_text: {} }, '예상 차익': OLD['예상 차익'], 마진율: NEW.마진율, ...CONFIDENCE_PROP, ...OTHERS });
  const store = realStore(fake);
  await store.init();
  assert.deepEqual(schemaPatches(fake), []);
  await store.upsert(notice(), evaluation, undefined, THU);
  const written = rowWrite(fake).body.properties;
  assert.deepEqual(written['예상 차익'], { number: 2 });
  assert.equal(Object.hasOwn(written, '안전 마진'), false);
});

test('역 도보(분) is added only if missing, read from the row and never written', async () => {
  const { 순번, 관심 } = OTHERS;
  const others = { ...NEW, ...CONFIDENCE_PROP, ...AVERAGE, ...RECOMMEND, 순번, 관심 };
  const missing = schemaFake(others);
  await realStore(missing).init();
  assert.deepEqual(schemaPatches(missing), [{ '역 도보(분)': { number: { format: 'number' } } }]);

  const present = schemaFake({ ...others, ...WALK });
  await realStore(present).init();
  assert.deepEqual(schemaPatches(present), []);

  // 다른 타입이면 건드리지 않고 빈 값으로 본다.
  const conflict = schemaFake({ ...others, '역 도보(분)': { type: 'rich_text', rich_text: {} } });
  await realStore(conflict).init();
  assert.deepEqual(schemaPatches(conflict), []);
  const row = (property) => parseExistingPage({ id: 'p', properties: { '고유 키': { rich_text: [{ plain_text: 'k' }] }, '역 도보(분)': property } }).walkMinutes;
  assert.equal(row({ type: 'rich_text', rich_text: [{ plain_text: '7' }] }), null);
  assert.equal(row({ type: 'number', number: 7 }), 7);
  assert.equal(row({ type: 'number', number: 0 }), 0);
  assert.equal(row({ type: 'number', number: null }), null);
  assert.equal(row({ type: 'number', number: -1 }), null);
  assert.equal(row(undefined), null);

  const created = schemaFake({}, { children: [] });
  await realStore(created).init();
  assert.deepEqual(created.calls.find((call) => call.path === '/databases').body.properties['역 도보(분)'], { number: { format: 'number' } });

  const props = buildProperties(notice(), { ...evaluation, walkMinutes: 7 }, THU);
  assert.equal(Object.hasOwn(props, '역 도보(분)'), false);

  const failed = schemaFake(others, {
    intercept: (call) => (call.method === 'PATCH' && call.path === '/databases/db' ? new Response('', { status: 403 }) : null),
  });
  const store = realStore(failed);
  await store.init();
  assert.deepEqual(store.schemaIssues(), ['notion_property_add_failed']);
});

test('평균 분양가 is added only if missing, created with new databases, and a wrong type is left alone and not written', async () => {
  const { 순번, 관심 } = OTHERS;
  const base = { ...NEW, ...CONFIDENCE_PROP, ...WALK, ...RECOMMEND, 순번, 관심 };
  const missing = schemaFake(base);
  await realStore(missing).init();
  assert.deepEqual(schemaPatches(missing), [{ '평균 분양가': { number: { format: 'number' } } }]);

  const present = schemaFake({ ...base, ...AVERAGE });
  const presentStore = realStore(present);
  await presentStore.init();
  assert.deepEqual(schemaPatches(present), []);
  await presentStore.upsert(notice(), { ...evaluation, averagePrice: 55000 }, undefined, THU);
  assert.deepEqual(rowWrite(present).body.properties['평균 분양가'], { number: 55000 });

  const conflict = schemaFake({ ...base, '평균 분양가': { type: 'rich_text', rich_text: {} } });
  const conflictStore = realStore(conflict);
  await conflictStore.init();
  assert.deepEqual(schemaPatches(conflict), []);
  await conflictStore.upsert(notice(), { ...evaluation, averagePrice: 55000 }, undefined, THU);
  assert.equal(Object.hasOwn(rowWrite(conflict).body.properties, '평균 분양가'), false);

  const failed = schemaFake(base, {
    intercept: (call) => (call.method === 'PATCH' && call.path === '/databases/db' ? new Response('', { status: 403 }) : null),
  });
  const failedStore = realStore(failed);
  await failedStore.init();
  assert.deepEqual(failedStore.schemaIssues(), ['notion_property_add_failed']);
  await failedStore.upsert(notice(), { ...evaluation, averagePrice: 55000 }, undefined, THU);
  assert.equal(Object.hasOwn(rowWrite(failed).body.properties, '평균 분양가'), false);

  const created = schemaFake({}, { children: [] });
  await realStore(created).init();
  assert.deepEqual(created.calls.find((call) => call.path === '/databases').body.properties['평균 분양가'], { number: { format: 'number' } });
});

test('a full run stores the supply-weighted 평균 분양가 from the model rows', async () => {
  const base = worldFetch();
  const fetch = async (url) => (String(url).includes('getAPTLttotPblancMdl')
    ? Response.json({ totalCount: 2, data: [
      { HOUSE_TY: '059.0000A', LTTOT_TOP_AMOUNT: '40,000', SUPLY_HSHLDCO: '60', SPSPLY_HSHLDCO: '40' },
      { HOUSE_TY: '084.0000A', LTTOT_TOP_AMOUNT: '60,000', SUPLY_HSHLDCO: '200', SPSPLY_HSHLDCO: '100' },
    ] })
    : base.fetch(url));
  const h = harness({ fetch });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  // (40000 × 100 + 60000 × 300) / 400 = 55000
  assert.deepEqual(h.store.state.upserts[0].properties['평균 분양가'], { number: 55000 });
  assert.deepEqual(h.store.state.upserts[0].properties['최고 분양가'], { number: 60000 });
});

test('추천 전형 and 추천 접수일 are added only if missing, and other types are left alone', async () => {
  const { 순번, 관심 } = OTHERS;
  const base = { ...NEW, ...CONFIDENCE_PROP, ...WALK, ...AVERAGE, 순번, 관심 };
  const missing = schemaFake(base);
  await realStore(missing).init();
  assert.deepEqual(schemaPatches(missing), [{ '추천 전형': { select: {} } }, { '추천 접수일': { date: {} } }]);
  const present = schemaFake({ ...base, ...RECOMMEND });
  await realStore(present).init();
  assert.deepEqual(schemaPatches(present), []);
  const conflict = schemaFake({ ...base, '추천 전형': { type: 'rich_text', rich_text: {} }, '추천 접수일': { type: 'number', number: {} } });
  const store = realStore(conflict);
  await store.init();
  assert.deepEqual(schemaPatches(conflict), []);
  await store.upsert(notice(), { ...evaluation, recommendation: { track: '무순위', date: THU, end: null } }, undefined, THU);
  const written = rowWrite(conflict).body.properties;
  assert.equal(Object.hasOwn(written, '추천 전형'), false);
  assert.equal(Object.hasOwn(written, '추천 접수일'), false);
});

test('시세 신뢰도 is added only if missing, and another type is left alone', async () => {
  const missing = schemaFake({ ...NEW, ...OTHERS });
  await realStore(missing).init();
  assert.deepEqual(schemaPatches(missing), [{ '시세 신뢰도': { select: { options: [{ name: '상' }, { name: '중' }, { name: '하' }] } } }]);

  const present = schemaFake({ ...NEW, ...CONFIDENCE_PROP, ...OTHERS });
  await realStore(present).init();
  assert.deepEqual(schemaPatches(present), []);

  const conflict = schemaFake({ ...NEW, '시세 신뢰도': { type: 'rich_text', rich_text: {} }, ...OTHERS });
  const store = realStore(conflict);
  await store.init();
  assert.deepEqual(schemaPatches(conflict), []);
  await store.upsert(notice(), evaluation, undefined, THU);
  assert.equal(Object.hasOwn(rowWrite(conflict).body.properties, '시세 신뢰도'), false);

  const failed = schemaFake({ ...NEW, ...OTHERS }, {
    intercept: (call) => (call.method === 'PATCH' && call.path === '/databases/db' ? new Response('', { status: 403 }) : null),
  });
  const failing = realStore(failed);
  await failing.init();
  await failing.upsert(notice(), evaluation, undefined, THU);
  assert.equal(Object.hasOwn(rowWrite(failed).body.properties, '시세 신뢰도'), false);
});

// run() 통합

const aptRow = (extra = {}) => ({
  HOUSE_MANAGE_NO: '7',
  PBLANC_NO: '7',
  HOUSE_NM: '비밀공고단지',
  HOUSE_SECD: '01',
  CNSTRCT_ENTRPS_NM: '무명건설',
  SUBSCRPT_AREA_CODE_NM: '서울',
  HSSPLY_ADRES: '서울특별시 강남구 역삼동 1',
  RCRIT_PBLANC_DE: '2026-11-01',
  SPSPLY_RCEPT_BGNDE: THU,
  SPSPLY_RCEPT_ENDDE: THU,
  PBLANC_URL: 'https://www.applyhome.co.kr/a',
  ...extra,
});

function worldFetch({ rows = [aptRow()], apt: aptHandler, presale, trades = ['', '2', '3', '4'].map((n, index) => tradeTags({ name: `래미안비밀${n}`, jibun: String(100 + index * 2), amount: '210,000' })) } = {}) {
  const calls = { kakao: [], presale: [], molit: [], apt: [] };
  const fetch = async (url) => {
    const text = String(url);
    const parsed = new URL(text);
    if (text.includes('dapi.kakao.com')) calls.kakao.push(text);
    if (text.includes('AptListService4') || text.includes('AptBasisInfoServiceV5')) {
      calls.apt.push(text);
      if (aptHandler) return aptHandler(parsed);
      return text.includes('AptListService4')
        ? Response.json(listBody([listItem('래미안비밀'), listItem('래미안비밀2', 'A2'), listItem('래미안비밀3', 'A3'), listItem('래미안비밀4', 'A4')]))
        : Response.json(detailBody({ kaptCode: 'A1', subwayLine: '2호선', subwayStation: '역삼', kaptdWtimesub: '5분이내' }));
    }
    if (text.includes('RTMSDataSvcSilvTrade')) {
      calls.presale.push(text);
      return presale ? presale(parsed) : new Response(xml([]));
    }
    if (text.includes('RTMSDataSvcAptTrade')) {
      calls.molit.push(text);
      return new Response(xml(parsed.searchParams.get('DEAL_YMD') === '202610' ? Array(5).fill(trades).flat() : []));
    }
    if (text.includes('getAPTLttotPblancDetail')) return Response.json({ totalCount: rows.length, data: rows });
    if (text.includes('getAPTLttotPblancMdl')) return Response.json({ totalCount: 1, data: [{ HOUSE_TY: '084.0000A', LTTOT_TOP_AMOUNT: '100,000' }] });
    if (text.includes('api.odcloud.kr')) return Response.json({ totalCount: 0, data: [] });
    return Response.json([{ dsList: [] }]);
  };
  return { calls, fetch };
}

function fakeStore(existing = new Map()) {
  const state = { upserts: [], stamps: [] };
  return {
    state,
    init: async () => {},
    loadExisting: async () => existing,
    upsert: async (item, value, previous, day) => {
      state.upserts.push({ key: item.key, evaluation: value, properties: buildProperties(item, value, day) });
      return `page-${item.key}`;
    },
    stampUrgent: async (id, date) => state.stamps.push({ id, date }),
    getWeeklyState: async () => '2026-11-02',
    setWeeklyState: async () => {},
    archivePage: async () => {},
    checkSequenceProperty: () => {},
    setSequenceNumber: async () => {},
  };
}

function harness({ store = fakeStore(), fetch, env = {}, argv } = {}) {
  const mails = [];
  const kakao = [];
  const logs = [];
  const written = [];
  return {
    store,
    mails,
    kakao,
    logs,
    written,
    argv,
    env: { DATA_GO_KR_KEY: DATA_SECRET, NOTION_KEY: 'n', CHUNGYAK_NOTION_PAGE_ID: 'p', KAKAO_REST_KEY: KAKAO_SECRET, ...env },
    deps: {
      fetch,
      store,
      accessToken: 'token',
      sleep: noSleep,
      now: () => new Date(THU_NOW),
      log: (line) => logs.push(line),
      write: (line) => written.push(line),
      sendMail: async (mail) => { mails.push(mail); },
      sendKakao: async (message) => { kakao.push(message); },
    },
  };
}

const marketLine = (h) => h.logs.find((line) => line.startsWith('market '));
const errorMail = (h) => h.mails.find((mail) => mail.subject.includes('배치 오류'));

const withWalk = (walkMinutes) => new Map([['7-7', { id: 'x', key: '7-7', lotto: null, urgentDate: null, end: THU, walkMinutes }]]);

test('a normal run reads the manual value, looks up comparables, stores the margin and keeps details out of the logs', async () => {
  const world = worldFetch();
  const h = harness({ store: fakeStore(withWalk(15)), fetch: world.fetch, env: { GITHUB_ACTIONS: 'true' } });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  const [{ evaluation: value, properties }] = h.store.state.upserts;
  // 비교 단지 210000 / 84 = 2500, × 1.02 / (1.06 × 1.05) × 84
  assert.equal(value.estimate, 192453);
  assert.equal(value.status, STATUS.LOTTO);
  assert.equal(properties['안전 마진'].number, value.margin);
  assert.equal(properties['시세 신뢰도'].select.name, value.confidence);
  const reason = properties['판별 근거'].rich_text[0].text.content;
  assert.ok(reason.includes('래미안비밀 19.2억(5분이내, 브랜드'), reason);
  assert.ok(reason.includes('역 도보 15분(입력)'));
  assert.equal(Object.hasOwn(properties, '역 도보(분)'), false);
  // 목록 1회, 상세 4회
  assert.equal(world.calls.apt.length, 5);
  assert.ok(h.logs.includes('market apt_calls=5 station_used=1 station_no_input=0 station_no_data=0 complex_outliers=0 confidence_high=1 confidence_mid=0 confidence_low=0 umd_town=0 umd_village=0 umd_dong=20 umd_other=0 soft=none'));
  assert.ok(h.logs.includes('apt_tags listRows=4 listNoCode=0 listNoDong=0 listNoTotal=0 details=4 noItem=0 noData=0 noField=0 emptyWalk=0 badWalk=0 bands=5분이내:4'));
  assert.ok(h.logs.some((line) => line.startsWith('trade_tags rows=20 noFloor=0 noDate=0 noDealing=0 noJibun=0 noSeq=20')));
  assert.ok(h.written.includes(`::add-mask::${DATA_SECRET}`));

  for (const secret of [KAKAO_SECRET, DATA_SECRET, 'apis.data.go.kr', '비밀공고단지', '래미안비밀', '역삼동', '7-7', 'A1']) {
    assert.ok(!h.logs.join('\n').includes(secret), secret);
  }
  assert.ok(!JSON.stringify(h.mails).includes(DATA_SECRET));
});

test('a full run sends nothing to the Kakao Local API and does not use its key', async () => {
  const world = worldFetch();
  const h = harness({ store: fakeStore(withWalk(15)), fetch: world.fetch, env: { GITHUB_ACTIONS: 'true' } });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.ok(world.calls.apt.length > 0);
  assert.deepEqual(world.calls.kakao, []);
  assert.ok(!h.written.some((line) => line.includes(KAKAO_SECRET)));
  assert.equal(Object.hasOwn(config.market, 'location'), false);
});

test('changing the manual value between runs changes the estimate', async () => {
  const runWith = async (walkMinutes) => {
    const h = harness({ store: fakeStore(withWalk(walkMinutes)), fetch: worldFetch().fetch });
    assert.equal(await run({ env: h.env, deps: h.deps }), 0);
    return h.store.state.upserts[0];
  };
  // 비교 단지는 5분이내(1.06), 상위 브랜드(1.05). 입력 15분: 2000 × 1.02 / 1.113 × 84
  assert.equal((await runWith(15)).evaluation.estimate, 192453);
  // 입력 5분: 역 차이가 없어 2500 / 1.05 × 84
  assert.equal((await runWith(5)).evaluation.estimate, 200000);
  // 입력을 지우면 역 보정이 빠진다. 값은 같아도 근거가 달라진다.
  const cleared = await runWith(null);
  assert.equal(cleared.evaluation.estimate, 200000);
  assert.equal(cleared.evaluation.stationState, 'noInput');
});

test('a row without the manual value makes no apartment calls and caps confidence', async () => {
  const world = worldFetch();
  const h = harness({ store: fakeStore(withWalk(null)), fetch: world.fetch });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.equal(world.calls.apt.length, 0);
  assert.ok(h.logs.includes('market apt_calls=0 station_used=0 station_no_input=1 station_no_data=0 complex_outliers=0 confidence_high=0 confidence_mid=1 confidence_low=0 umd_town=0 umd_village=0 umd_dong=20 umd_other=0 soft=none'));
  // 2500 / 1.05 × 84. 역 보정 없이 브랜드만 보정한다.
  assert.equal(h.store.state.upserts[0].evaluation.estimate, 200000);
});

test('apartment API failures in a full run stay out of the error mail and stop after one attempt cycle', async () => {
  for (const [response, kind, attempts] of [
    [() => new Response('Forbidden', { status: 403 }), 'aptlist_http_403', 1],
    [() => new Response('', { status: 503 }), 'aptlist_http_503', 2],
    [() => new Response('<OpenAPI_ServiceResponse/>'), 'aptlist_parse', 1],
  ]) {
    const rows = [aptRow(), aptRow({ HOUSE_MANAGE_NO: '8', HSSPLY_ADRES: '서울특별시 강남구 역삼동 2' })];
    const world = worldFetch({ rows, apt: response });
    const stored = new Map([...withWalk(15), ['8-7', { id: 'y', key: '8-7', lotto: null, urgentDate: null, end: THU, walkMinutes: 15 }]]);
    const h = harness({ store: fakeStore(stored), fetch: world.fetch });
    assert.equal(await run({ env: h.env, deps: h.deps }), 0);
    assert.equal(errorMail(h), undefined, kind);
    assert.equal(world.calls.apt.length, attempts, kind);
    assert.ok(marketLine(h).includes('station_no_data=2'), kind);
    assert.ok(marketLine(h).endsWith(`soft=${kind}:1`), kind);
    assert.ok(h.store.state.upserts.every((item) => item.evaluation.estimate > 0));
  }
});

test('a name mismatch in a full run is soft and counted', async () => {
  const world = worldFetch({ apt: () => Response.json(listBody([listItem('전혀다른이름')])) });
  const h = harness({ store: fakeStore(withWalk(15)), fetch: world.fetch });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.equal(errorMail(h), undefined);
  // 기본 실거래의 비교 단지 4곳이 모두 목록에 없다.
  assert.ok(marketLine(h).endsWith('soft=apt_name_unmatched:4'));
  assert.equal(world.calls.apt.length, 1);
});

const summaryLine = (h) => h.logs.find((line) => line.startsWith('collected='));

test('lotto_demoted counts rows that were 로또 and now compute 아님 or 대상 외, and only those', async () => {
  const wasLotto = (extra = {}) => new Map([['7-7', { id: 'x', key: '7-7', lotto: '로또', urgentDate: null, end: THU, ...extra }]]);
  // 단지 2곳이라 신뢰도가 중이다. 신뢰도 하인 추정은 이전 로또를 유지하므로 빠진 것으로 세지 않는다.
  const lowPrice = ['가', '나', '다', '라'].map((name, index) => tradeTags({ name: `${name}단지`, jibun: String(100 + index), amount: '84,000' }));
  const highPrice = [tradeTags({ name: '가단지', jibun: '100', amount: '300,000' })];
  const count = async ({ store, trades, rows, kakaoSent = 0, argv }) => {
    const world = worldFetch({ trades, rows });
    const h = harness({ store, fetch: world.fetch });
    await run({ argv, env: h.env, deps: h.deps });
    assert.equal(h.kakao.length, kakaoSent);
    assert.ok(!h.logs.join('\n').includes('비밀공고단지'));
    return summaryLine(h);
  };
  assert.ok((await count({ store: fakeStore(wasLotto()), trades: lowPrice })).includes('lotto_demoted=1'));
  assert.ok((await count({ store: fakeStore(wasLotto()), rows: [aptRow({ HOUSE_NM: '토지임대부 단지' })] })).includes('lotto_demoted=1'));
  assert.ok((await count({ store: fakeStore(wasLotto()), trades: highPrice, kakaoSent: 1 })).includes('lotto_demoted=0'));
  assert.ok((await count({ store: fakeStore(wasLotto({ lotto: '아님' })), trades: lowPrice })).includes('lotto_demoted=0'));
  assert.ok((await count({ store: fakeStore(), trades: lowPrice })).includes('lotto_demoted=0'));
  // 판별 불가로 이전 로또를 유지한 공고는 빠진 것이 아니다.
  assert.ok((await count({ store: fakeStore(wasLotto()), trades: [], kakaoSent: 1 })).includes('lotto_demoted=0'));
  // dry-run은 저장 없이 읽어 둔 행으로 센다.
  assert.ok((await count({ store: fakeStore(wasLotto()), trades: lowPrice, argv: ['--dry-run'] })).includes('lotto_demoted=1'));
});

test('a weak estimate cannot quietly drop a previous 로또, while a 중 estimate can', async () => {
  const wasLotto = new Map([['7-7', { id: 'x', key: '7-7', lotto: '로또', urgentDate: null, end: THU }]]);
  const oneComplex = [tradeTags({ name: '가단지', jibun: '100', amount: '84,000' })];
  const weak = harness({ store: fakeStore(wasLotto), fetch: worldFetch({ trades: oneComplex }).fetch });
  assert.equal(await run({ env: weak.env, deps: weak.deps }), 0);
  const kept = weak.store.state.upserts[0].evaluation;
  assert.equal(kept.status, '로또');
  assert.equal(kept.confidence, '하');
  assert.ok(kept.reason.startsWith('이전 판별 유지(이번 추정 신뢰도 하) (이번 실행: 안전 마진'), kept.reason);
  assert.equal(weak.kakao.length, 1);
  assert.ok(summaryLine(weak).includes('lotto_demoted=0'));
  // 카카오톡에는 비교 단지 목록이 없는 짧은 근거가 간다.
  assert.ok(weak.kakao[0].text.includes('이전 판별 유지(이번 추정 신뢰도 하)'));
  assert.ok(!weak.kakao[0].text.includes('가단지'));

  // 이전 기록이 로또가 아니면 그대로 아님이다.
  const notBefore = harness({ store: fakeStore(new Map([['7-7', { ...wasLotto.get('7-7'), lotto: '아님' }]])), fetch: worldFetch({ trades: oneComplex }).fetch });
  await run({ env: notBefore.env, deps: notBefore.deps });
  assert.equal(notBefore.store.state.upserts[0].evaluation.status, '아님');

  // 신뢰도 중이면 가격 기준대로 아님이 된다.
  const twoComplexes = [...oneComplex, ...['나', '다', '라'].map((name, index) => tradeTags({ name: `${name}단지`, jibun: String(101 + index), amount: '84,000' }))];
  const firm = harness({ store: fakeStore(wasLotto), fetch: worldFetch({ trades: twoComplexes }).fetch });
  await run({ env: firm.env, deps: firm.deps });
  assert.equal(firm.store.state.upserts[0].evaluation.status, '아님');
  assert.equal(firm.store.state.upserts[0].evaluation.confidence, '중');
});

test('complexes dropped as outliers are counted in the market log line', async () => {
  const trades = ['가', '나', '다', '라'].map((name, index) => tradeTags({ name: `${name}신도시`, jibun: String(300 + index), amount: '200,000' }));
  trades.push(tradeTags({ name: '싼단지', jibun: '399', amount: '100,000' }));
  const h = harness({ fetch: worldFetch({ trades }).fetch });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.ok(marketLine(h).includes(' complex_outliers=1 '), marketLine(h));
  assert.ok(!marketLine(h).includes('싼단지'));
  assert.ok(h.store.state.upserts[0].evaluation.reason.includes('이상치 1곳 제외'));
});

test('a notice with a 하 large type and a 중 small type that qualifies is 로또', async () => {
  const large = saleRows(5, 3000, { aptName: '대형가', jibun: 'L1' });
  const small = ['S1', 'S2', 'S3', 'S4'].flatMap((jibun) => saleRows(5, 1000, { aptName: `소형${jibun}`, jibun, area: 59, amount: 59000 }));
  const result = await evaluate(apt(), {
    trades: [...large, ...small],
    models: [{ houseType: '084A', area: 84, price: 100000 }, { houseType: '059A', area: 59, price: 30000 }],
  });
  assert.equal(result.status, STATUS.LOTTO);
  assert.ok(result.reason.startsWith('안전 마진'), result.reason);
  assert.ok(result.reason.includes('059A'));
  // 아무 주택형도 기준을 넘지 못하면 하인 주택형의 안내가 그대로 나온다.
  const none = await evaluate(apt(), { trades: large, models: [{ houseType: '084A', area: 84, price: 100000 }] });
  assert.equal(none.status, STATUS.NOT);
  assert.ok(none.reason.startsWith('가격 기준은 넘지만 추정 신뢰도가 하라 로또로 보지 않음'));
});

test('a weak estimate does not create a price-rule 로또 for a new row in a full run', async () => {
  const oneComplex = [tradeTags({ name: '가단지', jibun: '100', amount: '300,000' })];
  const h = harness({ fetch: worldFetch({ trades: oneComplex }).fetch });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  const value = h.store.state.upserts[0].evaluation;
  assert.equal(value.status, '아님');
  assert.equal(value.confidence, '하');
  assert.equal(h.kakao.length, 0);
});

test('dry-run applies the same previous-로또 protection as a normal run', async () => {
  const oneComplex = [tradeTags({ name: '가단지', jibun: '100', amount: '84,000' })];
  const stored = { id: 'stored', properties: { '고유 키': { rich_text: [{ plain_text: '7-7' }] }, '로또 여부': { select: { name: '로또' } }, '접수 종료일': { date: { start: THU } } } };
  const fake = schemaFake({ ...NEW, ...CONFIDENCE_PROP, ...OTHERS });
  const base = worldFetch({ trades: oneComplex });
  const fetch = async (url, init = {}) => {
    if (!String(url).includes('api.notion.com')) return base.fetch(url);
    if (String(url).endsWith('/query')) return Response.json({ has_more: false, results: [stored] });
    return fake.fetch(url, init);
  };
  const dry = harness({ store: null, fetch });
  dry.deps.store = undefined;
  assert.equal(await run({ argv: ['--dry-run'], env: dry.env, deps: dry.deps }), 0);
  assert.ok(dry.logs.some((line) => line.startsWith('dry-run lotto=1 ')), dry.logs.join(' | '));
  assert.ok(summaryLine(dry).includes('lotto_demoted=0'));

  const normal = harness({ store: fakeStore(new Map([['7-7', { id: 'x', key: '7-7', lotto: '로또', urgentDate: null, end: THU }]])), fetch: worldFetch({ trades: oneComplex }).fetch });
  await run({ env: normal.env, deps: normal.deps });
  assert.equal(normal.store.state.upserts[0].evaluation.status, '로또');
  assert.ok(summaryLine(normal).includes('lotto_demoted=0'));
});

test('the urgent mail fallback carries the full reason, while Kakao gets the short one', async () => {
  const kakaoTexts = [];
  const h = harness({ fetch: worldFetch().fetch });
  h.deps.sendKakao = async ({ text }) => {
    kakaoTexts.push(text);
    throw new Error('kakao down');
  };
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  const urgent = h.mails.find((mail) => mail.subject.startsWith('[청약 긴급]'));
  assert.ok(urgent);
  assert.ok(!kakaoTexts[0].includes('래미안비밀'));
  assert.ok(urgent.text.includes('판별 근거: 안전 마진'));
  assert.ok(urgent.text.includes('래미안비밀'));
  assert.ok(urgent.html.includes('판별 근거: 안전 마진'));
});

test('the reason lists every comparable within the Notion limit and Kakao gets the short form', async () => {
  const many = Array.from({ length: 8 }, (_, index) => tradeTags({ name: `아주 긴 이름의 비교 단지 ${'가나다라마바사아'[index]}`.repeat(3), jibun: String(200 + index), amount: '200,000' }));
  const world = worldFetch({ trades: many, rows: [aptRow({ PARCPRC_ULS_AT: 'Y' })] });
  const h = harness({ fetch: world.fetch });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  const [{ evaluation: value, properties }] = h.store.state.upserts;
  const reason = properties['판별 근거'].rich_text[0].text.content;
  assert.ok(reason.length <= 2000);
  assert.equal(value.reason.length, reason.length);
  for (const letter of '가나다라마바사아') assert.ok(reason.includes(`비교 단지 ${letter}`), letter);
  assert.ok(reason.includes('보정 후 84㎡ 기준'));
  assert.ok(/아주 긴 이름의 비교 단지 가.* \d+\.\d억\(브랜드/.test(reason));
  assert.equal(h.kakao.length, 1);
  const text = h.kakao[0].text;
  assert.ok(Array.from(text).length <= 200);
  assert.ok(text.includes('분양가상한제 적용; 안전 마진'));
  assert.ok(!text.includes('비교 단지'));
});

test('a presale API not yet approved sends no error mail and logs a count-only kind', async () => {
  const world = worldFetch({ presale: () => new Response('Forbidden', { status: 403 }) });
  const h = harness({ fetch: world.fetch });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.equal(errorMail(h), undefined);
  assert.equal(world.calls.presale.length, 1);
  assert.ok(marketLine(h).endsWith('soft=presale_http_403:1'));
});

test('presale tag problems are also soft', async () => {
  const world = worldFetch({ presale: () => new Response(xml(['<unknown>1</unknown>'])) });
  const h = harness({ fetch: world.fetch });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.equal(errorMail(h), undefined);
  assert.ok(marketLine(h).endsWith('soft=presale_parse:1'));
});

test('a restricted notice clears stored values through the real store and sends no alert', async () => {
  const fake = schemaFake({ ...NEW, ...CONFIDENCE_PROP, ...OTHERS });
  const row = aptRow({ HOUSE_NM: '고덕강일 3단지 토지임대부', PARCPRC_ULS_AT: 'Y' });
  const stored = { id: 'stored', properties: { '고유 키': { rich_text: [{ plain_text: '7-7' }] }, '로또 여부': { select: { name: '로또' } }, '접수 종료일': { date: { start: THU } } } };
  const base = worldFetch({ rows: [row] });
  const fetch = async (url, init = {}) => {
    if (!String(url).includes('api.notion.com')) return base.fetch(url);
    if (String(url).endsWith('/query')) {
      fake.calls.push({ method: 'POST', path: '/query' });
      return Response.json({ has_more: false, results: [stored] });
    }
    return fake.fetch(url, init);
  };
  const h = harness({ store: null, fetch });
  h.deps.store = undefined;
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  const patch = fake.calls.find((call) => call.method === 'PATCH' && call.path === '/pages/stored');
  assert.deepEqual(patch.body.properties['로또 여부'], { select: { name: '대상 외' } });
  assert.deepEqual(patch.body.properties['추정 시세'], { number: null });
  assert.deepEqual(patch.body.properties['안전 마진'], { number: null });
  assert.deepEqual(patch.body.properties['마진율'], { number: null });
  assert.deepEqual(patch.body.properties['시세 신뢰도'], { select: null });
  assert.equal(h.kakao.length, 0);
  assert.equal(base.calls.apt.length, 0);
  assert.equal(base.calls.molit.length, 0);
});

test('a restricted notice does not get back a previous 로또 in any path', async () => {
  const name = '하남교산 신혼희망타운';
  // 평가된 경로
  const active = new Map([['7-7', { id: 'x', key: '7-7', lotto: '로또', urgentDate: null, end: THU }]]);
  const one = harness({ store: fakeStore(active), fetch: worldFetch({ rows: [aptRow({ HOUSE_NM: name })] }).fetch });
  await run({ env: one.env, deps: one.deps });
  assert.equal(one.store.state.upserts[0].evaluation.status, '대상 외');
  assert.equal(one.kakao.length, 0);
  // 저장된 종료일이 지나 판정 없이 지나가는 경로
  const ended = new Map([['7-7', { id: 'x', key: '7-7', lotto: '로또', urgentDate: null, end: '2026-11-01' }]]);
  const two = harness({ store: fakeStore(ended), fetch: worldFetch({ rows: [aptRow({ HOUSE_NM: name })] }).fetch });
  await run({ env: two.env, deps: two.deps });
  assert.equal(two.store.state.upserts.length, 0);
  assert.equal(two.kakao.length, 0);
  // 일반 공고는 같은 경로에서 그대로 알림이 간다.
  const three = harness({ store: fakeStore(ended), fetch: worldFetch({ rows: [aptRow()] }).fetch });
  await run({ env: three.env, deps: three.deps });
  assert.equal(three.kakao.length, 1);
});

test('rename failure in a full run keeps upserts and alerts going and reaches the error mail', async () => {
  const fake = schemaFake({ ...OLD, ...CONFIDENCE_PROP, ...OTHERS }, {
    intercept: (call) => (call.method === 'PATCH' && call.path === '/databases/db' ? new Response('', { status: 403 }) : null),
  });
  const base = worldFetch();
  const h = harness({
    store: null,
    fetch: async (url, init) => (String(url).includes('api.notion.com') ? fake.fetch(url, init) : base.fetch(url)),
  });
  h.deps.store = undefined;
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.equal(h.kakao.length, 1);
  const written = rowWrite(fake).body.properties;
  assert.ok(Number.isFinite(written['예상 차익'].number));
  assert.ok(errorMail(h).text.includes('notion_rename_failed x2'));
});

test('dry-run stays write-free while reading the manual value and market data', async () => {
  const fake = schemaFake({ ...OLD, ...OTHERS });
  const base = worldFetch();
  const stored = { id: 'stored', properties: { '고유 키': { rich_text: [{ plain_text: '7-7' }] }, '접수 종료일': { date: { start: THU } }, '역 도보(분)': { number: 15 } } };
  const h = harness({
    store: null,
    fetch: async (url, init = {}) => {
      if (!String(url).includes('api.notion.com')) return base.fetch(url);
      if (String(url).endsWith('/query')) return Response.json({ has_more: false, results: [stored] });
      return fake.fetch(url, init);
    },
  });
  h.deps.store = undefined;
  assert.equal(await run({ argv: ['--dry-run'], env: h.env, deps: h.deps }), 0);
  assert.deepEqual(fake.calls.filter((call) => call.method === 'PATCH' || (call.method === 'POST' && !call.path.endsWith('/query'))), []);
  assert.equal(h.mails.length, 0);
  assert.equal(h.kakao.length, 0);
  assert.equal(base.calls.apt.length, 5);
  assert.ok(marketLine(h).includes('station_used=1'));
});

test('tag name diagnostics keep only safe names and never values', () => {
  const names = new Set();
  collectTagNames(`<r><resultCode>000</resultCode><secretOutside>x</secretOutside><items>
    <item><aptNm>비밀단지</aptNm><dealAmount>84,000</dealAmount><ownershipGbn><![CDATA[<cdataValue>입]]></ownershipGbn><구분>입</구분><bad-name>x</bad-name><attr a="b">y</attr></item>
    <item><aptNm>다른단지</aptNm><floor>10</floor><note>&lt;escaped&gt;</note></item>
  </items></r>`, names);
  assert.deepEqual([...names].sort(), ['aptNm', 'dealAmount', 'floor', 'note', 'ownershipGbn']);
  assert.equal(formatTagNames(names), 'aptNm,dealAmount,floor,note,ownershipGbn');
  assert.equal(formatTagNames(new Set()), 'none');

  const many = new Set();
  const items = Array.from({ length: 200 }, (_, index) => `<name_${String(index).padStart(3, '0')}_${'x'.repeat(30)}>1</name_${String(index).padStart(3, '0')}_${'x'.repeat(30)}>`).join('');
  collectTagNames(`<item>${items}</item>`, many);
  assert.equal(many.size, 80);
  const capped = formatTagNames(many);
  assert.ok(capped.length <= 804);
  assert.ok(capped.endsWith(',...'));
  assert.match(capped, /^[A-Za-z0-9_,.]+$/);
});

test('a full run logs tag names once for each API, without values', async () => {
  const VALUES = ['비밀단지', 'VALUE-BUILD-2026', '래미안', '777,000', '역삼동'];
  const saleItem = `<aptNm>${VALUES[0]}</aptNm><dealAmount>${VALUES[3]}</dealAmount><excluUseAr>84</excluUseAr><floor>10</floor><umdNm>${VALUES[4]}</umdNm><jibun>100</jibun><buildYear>2026</buildYear><dealingGbn>${VALUES[1]}</dealingGbn><dealYear>2026</dealYear><dealMonth>9</dealMonth><dealDay>3</dealDay>`;
  const presaleItem = `<aptNm>${VALUES[2]}</aptNm><dealAmount>${VALUES[3]}</dealAmount><excluUseAr>84</excluUseAr><floor>10</floor><umdNm>${VALUES[4]}</umdNm><jibun>9</jibun><dealYear>2026</dealYear><dealMonth>9</dealMonth><dealDay>3</dealDay><newPresaleTag><![CDATA[<cdataValue>${VALUES[0]}]]></newPresaleTag><한글태그>${VALUES[1]}</한글태그>`;
  const world = worldFetch({
    trades: [saleItem],
    presale: (url) => new Response(xml(url.searchParams.get('DEAL_YMD') === '202610' ? [presaleItem] : [])),
  });
  const h = harness({ fetch: world.fetch });
  assert.equal(await run({ argv: ['--dry-run'], env: h.env, deps: h.deps }), 0);
  const line = (prefix) => h.logs.filter((item) => item.startsWith(prefix));
  assert.deepEqual(line('sale_tag_names='), ['sale_tag_names=aptNm,buildYear,dealAmount,dealDay,dealMonth,dealYear,dealingGbn,excluUseAr,floor,jibun,umdNm']);
  assert.deepEqual(line('presale_tag_names='), ['presale_tag_names=aptNm,dealAmount,dealDay,dealMonth,dealYear,excluUseAr,floor,jibun,newPresaleTag,umdNm']);
  const output = h.logs.join('\n');
  for (const value of [...VALUES, 'cdataValue', '한글태그']) assert.ok(!output.includes(value), value);
});

test('tag name lines say none when an API returned no items', async () => {
  const h = harness({ fetch: worldFetch({ rows: [] }).fetch });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.ok(h.logs.includes('sale_tag_names=none'));
  assert.ok(h.logs.includes('presale_tag_names=none'));
});

// 추천 전형 실행 테스트: 특별공급 THU, 1순위 해당지역 11/6, 기타지역 11/7인 서울 APT. 실거래가 낮아 로또 알림은 없다.
// 테스트용 가짜 신청자 정보다. 인천 거주자라 서울 공고의 일반 1순위는 기타지역이다.
const PROFILE_JSON = '{"residenceSido":"인천","residenceYears":3,"specialTracks":["생애최초"]}';
const lowTrades = ['가', '나', '다', '라'].map((name, index) => tradeTags({ name: `${name}단지`, jibun: String(100 + index), amount: '84,000' }));
function recommendWorld({ specials = { NWWDS_HSHLDCO: '30', NWBB_HSHLDCO: '10', LFE_FRST_HSHLDCO: '20' } } = {}) {
  const row = aptRow({ GNRL_RNK1_CRSPAREA_RCPTDE: '2026-11-06', GNRL_RNK1_CRSPAREA_ENDDE: '2026-11-06', GNRL_RNK1_ETC_AREA_RCPTDE: '2026-11-07', GNRL_RNK1_ETC_AREA_ENDDE: '2026-11-07' });
  const base = worldFetch({ rows: [row], trades: lowTrades });
  return async (url) => (String(url).includes('getAPTLttotPblancMdl')
    ? Response.json({ totalCount: 1, data: [{ HOUSE_TY: '084.0000A', LTTOT_TOP_AMOUNT: '100,000', SUPLY_HSHLDCO: '40', SPSPLY_HSHLDCO: '60', ...specials }] })
    : base.fetch(url));
}

test('a run with a profile stores the recommended track and date and never the profile', async () => {
  const h = harness({ fetch: recommendWorld(), env: { CHUNGYAK_PROFILE: PROFILE_JSON, GITHUB_ACTIONS: 'true' } });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  const [{ properties, evaluation: value }] = h.store.state.upserts;
  assert.deepEqual(properties['추천 전형'], { select: { name: '생애최초 특별공급' } });
  assert.deepEqual(properties['추천 접수일'], { date: { start: THU } });
  assert.ok(properties['판별 근거'].rich_text[0].text.content.includes('\n추천: 생애최초 특별공급 11/5 (20세대, 1순위 기타지역 11/7도 가능; 세대주·청약통장 요건 확인)'));
  assert.equal(value.status, '아님');
  assert.ok(h.logs.includes('recommend profile=ok recommended=1 none=0'));
  assert.ok(h.written.includes(`::add-mask::${PROFILE_JSON}`));
  const everything = JSON.stringify([h.logs, h.mails, h.store.state.upserts.map((item) => item.properties)]);
  for (const secret of [PROFILE_JSON, 'residenceSido', 'residenceYears', 'specialTracks']) assert.ok(!everything.includes(secret), secret);
});

test('a missing or invalid profile turns the feature off without an error mail or Notion writes', async () => {
  for (const [value, status] of [[undefined, 'missing'], ['{bad', 'invalid'], ['{"residenceSido":"인천","residenceYears":3,"specialTracks":["다자녀"]}', 'invalid']]) {
    const env = value === undefined ? {} : { CHUNGYAK_PROFILE: value };
    const h = harness({ fetch: recommendWorld(), env });
    assert.equal(await run({ env: h.env, deps: h.deps }), 0);
    assert.ok(h.logs.includes(`recommend profile=${status} recommended=0 none=0`), status);
    assert.equal(errorMail(h), undefined, status);
    const [{ properties }] = h.store.state.upserts;
    assert.equal(Object.hasOwn(properties, '추천 전형'), false);
    assert.equal(Object.hasOwn(properties, '추천 접수일'), false);
    assert.ok(!properties['판별 근거'].rich_text[0].text.content.includes('추천:'));
  }
});

test('a notice with no recommendation clears the stored columns when the profile is on', async () => {
  const h = harness({ fetch: recommendWorld({ specials: {} }), env: { CHUNGYAK_PROFILE: '{"residenceSido":"인천","residenceYears":3,"specialTracks":[]}' } });
  // 일반 1순위 기타지역(11/7)은 있으므로 그 날짜가 추천이다.
  await run({ env: h.env, deps: h.deps });
  assert.deepEqual(h.store.state.upserts[0].properties['추천 접수일'], { date: { start: '2026-11-07' } });
  const outside = harness({ fetch: recommendWorld(), env: { CHUNGYAK_PROFILE: '{"residenceSido":"부산","residenceYears":5}' } });
  await run({ env: outside.env, deps: outside.deps });
  assert.deepEqual(outside.store.state.upserts[0].properties['추천 전형'], { select: null });
  assert.deepEqual(outside.store.state.upserts[0].properties['추천 접수일'], { date: null });
  assert.ok(outside.logs.includes('recommend profile=ok recommended=0 none=1'));
});

const interestRow = (extra = {}) => new Map([['7-7', {
  id: 'p7', key: '7-7', name: '관심단지', link: 'https://www.applyhome.co.kr/a', interest: true, lotto: '아님', urgentDate: null,
  start: '2026-11-10', end: '2026-11-20', recommendTrack: null, recommendDate: null, recommendEnd: null, ...extra,
}]]);

test('interest alerts go out on the freshly computed recommended date, overlaying a stale stored one', async () => {
  const stale = interestRow({ recommendTrack: '신혼부부 특별공급', recommendDate: '2026-11-04' });
  const h = harness({ store: fakeStore(stale), fetch: recommendWorld(), env: { CHUNGYAK_PROFILE: PROFILE_JSON } });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.equal(h.kakao.length, 1);
  assert.ok(h.kakao[0].text.startsWith('[관심 청약] '), h.kakao[0].text);
  assert.ok(h.kakao[0].text.includes('생애최초 특별공급 오늘 접수 2026-11-05'), h.kakao[0].text);
  assert.deepEqual(h.store.state.stamps, [{ id: 'p7', date: THU }]);
});

test('without a profile the stored recommended date is used, and without one the start date', async () => {
  const stored = interestRow({ recommendTrack: '생애최초 특별공급', recommendDate: THU, recommendEnd: '2026-11-06' });
  const h = harness({ store: fakeStore(stored), fetch: recommendWorld() });
  await run({ env: h.env, deps: h.deps });
  assert.equal(h.kakao.length, 1);
  assert.ok(h.kakao[0].text.includes('생애최초 특별공급 오늘 접수 2026-11-05~2026-11-06'), h.kakao[0].text);

  // 저장된 추천일이 다른 날이면 접수 시작일이 오늘이어도 보내지 않는다.
  const other = harness({ store: fakeStore(interestRow({ start: THU, recommendTrack: '생애최초 특별공급', recommendDate: '2026-11-09' })), fetch: recommendWorld() });
  await run({ env: other.env, deps: other.deps });
  assert.equal(other.kakao.length, 0);

  // 추천이 없으면 예전처럼 접수 시작일에 보낸다.
  const plain = harness({ store: fakeStore(interestRow({ start: THU })), fetch: recommendWorld() });
  await run({ env: plain.env, deps: plain.deps });
  assert.equal(plain.kakao.length, 1);
  assert.ok(plain.kakao[0].text.includes('접수 오늘 시작'), plain.kakao[0].text);
});

test('the molit client reports tag tallies without names', async () => {
  const client = createMolitClient({ key: 'k', sleep: noSleep, fetch: async () => new Response(xml(['<dealAmount>1</dealAmount><excluUseAr>84</excluUseAr>', tradeTags()])) });
  await client.getTrades('11680', ['202610']);
  assert.deepEqual(client.stats(), { rows: 2, noFloor: 1, noDate: 1, noDealing: 1, noJibun: 1, noSeq: 2, noOwnership: 0, umdFormats: { town: 0, village: 0, dong: 1, other: 1 } });
});

test('the workflow keeps the Kakao key only for the token refresh step', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/chungyak-alert.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const batch = workflow.slice(workflow.indexOf('- name: Run batch'), workflow.indexOf('- name: Remove token files'));
  assert.ok(!batch.includes('KAKAO_REST_KEY'));
  const refresh = workflow.slice(workflow.indexOf('- name: Refresh Kakao token'), workflow.indexOf('- name: Save rotated Kakao token'));
  assert.ok(refresh.includes('KAKAO_REST_KEY: ${{ secrets.KAKAO_REST_KEY }}'));
});

test('config has every coefficient and SETUP says they are judgement starting values', () => {
  const setup = readFileSync(new URL('../docs/SETUP.md', import.meta.url), 'utf8');
  assert.ok(setup.includes('판단이 들어간 시작값'));
  assert.ok(config.market.aptInfo.maxCallsPerRun > 0);
  assert.ok(config.market.comparables.minStationShare > 0);
  assert.ok(config.market.adjustment.station.bands.every((band) => band.maxMinutes > 0));
  assert.equal(config.market.optionCostManwon, 1500);
});
