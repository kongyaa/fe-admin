import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { STATUS, evaluateLotto, keepPreviousLotto } from '../src/lotto.js';
import { run } from '../src/main.js';
import { buildKakaoText } from '../src/notify-kakao.js';
import { buildProperties, createNotionStore } from '../src/notion-store.js';
import { normalizeDetail, ENDPOINTS } from '../src/sources/applyhome.js';
import { cleanAddress, createKakaoLocalClient } from '../src/sources/kakao-local.js';
import { createMolitClient, createPresaleClient, fetchMonth, fetchPresaleMonth, parseMolitXml, parsePresaleXml } from '../src/sources/molit.js';
import { resolveAddress } from '../src/sgg-codes.js';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const { location } = config.market;
const today = '2026-11-05';
const THU = today;
const THU_NOW = '2026-11-04T22:30:00Z';
const noSleep = async () => {};
const fastLocation = { ...location, minIntervalMs: 0 };
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

const kakaoResponse = (documents) => Response.json({ meta: { total_count: documents.length }, documents });

function kakaoClient(handler, { locationConfig = fastLocation, key = 'k', now } = {}) {
  const calls = [];
  const errors = [];
  const soft = [];
  const client = createKakaoLocalClient({
    key,
    location: locationConfig,
    sleep: noSleep,
    now,
    onError: (kind) => errors.push(kind),
    onSoft: (kind) => soft.push(kind),
    fetch: async (url, init) => {
      const parsed = new URL(url);
      calls.push({ path: parsed.pathname, params: Object.fromEntries(parsed.searchParams), headers: init.headers });
      return handler(parsed);
    },
  });
  return { client, calls, errors, soft };
}

test('Kakao requests use the documented endpoints, header and parameters', async () => {
  const { client, calls } = kakaoClient((url) => {
    if (url.pathname.endsWith('/address.json')) return kakaoResponse([{ x: '127.03', y: '37.5' }]);
    return kakaoResponse([{ x: '127.04', y: '37.5', distance: '250' }]);
  });
  const coord = await client.locateComplex('서울특별시 강남구 역삼동 100');
  assert.deepEqual(coord, { x: 127.03, y: 37.5 });
  assert.equal(await client.nearestStation(coord), 250);
  assert.equal(calls[0].path, '/v2/local/search/address.json');
  assert.equal(calls[0].params.query, '서울특별시 강남구 역삼동 100');
  assert.equal(calls[0].headers.Authorization, 'KakaoAK k');
  assert.equal(calls[1].path, '/v2/local/search/category.json');
  assert.deepEqual(calls[1].params, { category_group_code: 'SW8', x: '127.03', y: '37.5', radius: '1300', sort: 'distance', size: '1' });
});

test('Kakao station search handles none in range and a missing distance', async () => {
  const none = kakaoClient(() => kakaoResponse([]));
  assert.equal(await none.client.nearestStation({ x: 127, y: 37 }), null);
  assert.deepEqual(none.errors, []);

  // distance가 없으면 역 좌표로 계산한다. 위도 0.001도는 약 111m다.
  const computed = kakaoClient(() => kakaoResponse([{ x: '127', y: '37.001' }]));
  const meters = await computed.client.nearestStation({ x: 127, y: 37 });
  assert.ok(meters > 100 && meters < 120);

  const broken = kakaoClient(() => kakaoResponse([{ place_name: 'x' }]));
  await assert.rejects(broken.client.nearestStation({ x: 127, y: 37 }), { kind: 'kakao_local_parse' });
  assert.deepEqual(broken.errors, ['kakao_local_parse']);
});

test('the subject is located by address first', async () => {
  const byAddress = kakaoClient(() => kakaoResponse([{ x: '127', y: '37' }]));
  assert.deepEqual(await byAddress.client.locateSubject({ address: '서울특별시 강남구 역삼동 1 일원', name: 'A', areaText: '서울특별시 강남구' }), { x: 127, y: 37 });
  assert.equal(byAddress.calls[0].params.query, '서울특별시 강남구 역삼동 1');
  assert.equal(byAddress.calls.length, 1);
});

const keywordClient = (documents) => kakaoClient((url) => (url.pathname.endsWith('/keyword.json') ? kakaoResponse(documents) : kakaoResponse([])));
const locateByName = (client, name = '역삼 푸른숲 단지') => client.locateSubject({ address: '서울특별시 강남구 A-3블록', name, areaText: '서울특별시 강남구' });
const place = (placeName, x = '127', addressName = '서울 강남구 역삼동 1') => ({ x, y: '37', place_name: placeName, address_name: addressName });

test('the keyword fallback takes a place in the district whose name contains the subject name', async () => {
  const found = keywordClient([place('역삼푸른숲 아파트', '1', '부산 강서구 어딘가'), place('역삼 푸른숲 아파트 101동')]);
  assert.deepEqual(await locateByName(found.client), { x: 127, y: 37, viaKeyword: true });
  assert.equal(found.calls[1].params.query, '강남구 역삼 푸른숲 단지');
  assert.equal(await locateByName(keywordClient([place('역삼푸른숲', '1', '부산 해운대구 어딘가')]).client), null);
});

test('the keyword fallback rejects sales facilities and other complexes', async () => {
  for (const name of ['역삼푸른숲 견본주택', '역삼푸른숲 모델하우스', '역삼푸른숲 분양사무소', '역삼푸른숲 홍보관', '역삼 옛푸른 아파트', '푸른숲']) {
    assert.equal(await locateByName(keywordClient([place(name)]).client), null, name);
  }
  // 앞의 결과가 분양 시설이어도 뒤의 단지를 찾는다.
  const skipped = keywordClient([place('역삼푸른숲 견본주택', '1'), place('역삼푸른숲')]);
  assert.deepEqual(await locateByName(skipped.client), { x: 127, y: 37, viaKeyword: true });
  // 이름이 비면 검색하지 않는다.
  const blank = keywordClient([place('아무 단지')]);
  assert.equal(await locateByName(blank.client, ''), null);
  assert.equal(blank.calls.length, 1);
});

test('a keyword-located subject caps a comparable estimate at 중 and leaves no trace in the result', async () => {
  const trades = ['11', '12', '13', '14'].map((jibun, index) => saleRows(5, 2000, { aptName: `단지${'가나다라'[index]}`, jibun })).flat();
  const byAddress = await evaluate(apt(), { trades, locator: fakeLocator() });
  assert.equal(byAddress.confidence, '상');
  const byKeyword = await evaluate(apt(), {
    trades,
    locator: fakeLocator({ async locateSubject() { return { x: 127, y: 37.5, viaKeyword: true }; } }),
  });
  assert.equal(byKeyword.confidence, '중');
  assert.equal(byKeyword.estimate, byAddress.estimate);
  assert.ok(!JSON.stringify(byKeyword).includes('viaKeyword'));
});

test('address cleaning keeps 동 names that contain the removed words', () => {
  assert.equal(cleanAddress('서울특별시 강남구 일원동 1'), '서울특별시 강남구 일원동 1');
  assert.equal(cleanAddress('경기도 시흥시 거모동 1234 일원'), '경기도 시흥시 거모동 1234');
  assert.equal(cleanAddress('경기도 시흥시 거모동 1234번지 외 3필지 (A블록)'), '경기도 시흥시 거모동 1234');
  assert.equal(resolveAddress('경기도 시흥시 거모동 1234').areaText, '경기도 시흥시');
  assert.equal(resolveAddress('경기도 수원시 영통구 이의동 1').areaText, '경기도 수원시 영통구');
  assert.equal(resolveAddress('강남구 역삼동 1', '서울').areaText, '서울 강남구');
  assert.equal(resolveAddress('부산광역시 해운대구 우동').areaText, null);
});

test('Kakao results are memoised, so repeat lookups make no calls', async () => {
  const { client, calls } = kakaoClient(() => kakaoResponse([{ x: '127', y: '37', distance: '100' }]));
  await client.locateComplex('q');
  await client.locateComplex('q');
  await client.nearestStation({ x: 127, y: 37 });
  await client.nearestStation({ x: 127, y: 37 });
  assert.equal(calls.length, 2);
  assert.equal(client.stats().calls, 2);
});

test('Kakao quota, auth and malformed failures stop after one attempt and reach the error mail', async () => {
  for (const [handler, kind] of [
    [() => new Response('', { status: 429 }), 'kakao_local_http_429'],
    [() => new Response('', { status: 401 }), 'kakao_local_http_401'],
    [() => new Response('', { status: 403 }), 'kakao_local_http_403'],
    [() => new Response('not json'), 'kakao_local_parse'],
    [() => Response.json({ meta: {} }), 'kakao_local_parse'],
  ]) {
    const { client, calls, errors, soft } = kakaoClient(handler);
    await assert.rejects(client.locateComplex('a'), { kind });
    await assert.rejects(client.locateComplex('b'), { kind });
    await assert.rejects(client.nearestStation({ x: 1, y: 2 }), { kind });
    assert.equal(calls.length, 1, kind);
    assert.deepEqual(errors, [kind]);
    assert.deepEqual(soft, []);
  }
});

const transientFailures = [
  [() => new Response('', { status: 500 }), 'kakao_local_http_500'],
  [() => new Response('', { status: 503 }), 'kakao_local_http_503'],
  [() => { throw new TypeError('fetch failed'); }, 'kakao_local_network'],
  [() => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }, 'kakao_local_timeout'],
  [() => ({ ok: true, json: async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); } }), 'kakao_local_timeout'],
];

test('one transient Kakao failure is retried and the run continues', async () => {
  for (const [handler, kind] of transientFailures) {
    let count = 0;
    const { client, calls, errors, soft } = kakaoClient((url) => {
      count += 1;
      return count === 1 ? handler(url) : kakaoResponse([{ x: '127', y: '37' }]);
    });
    assert.deepEqual(await client.locateComplex('a'), { x: 127, y: 37 }, kind);
    assert.deepEqual(await client.locateComplex('b'), { x: 127, y: 37 }, kind);
    assert.equal(calls.length, 3, kind);
    assert.deepEqual(errors, []);
    assert.deepEqual(soft, []);
    assert.equal(client.stats().calls, 3);
  }
});

test('a transient Kakao failure that remains after the retry is soft and stops further calls', async () => {
  for (const [handler, kind] of transientFailures) {
    const { client, calls, errors, soft } = kakaoClient(handler);
    await assert.rejects(client.locateComplex('a'), { kind });
    await assert.rejects(client.locateComplex('b'), { kind });
    assert.equal(calls.length, 2, kind);
    assert.deepEqual(errors, []);
    assert.deepEqual(soft, [kind]);
  }
});

test('the retry does not go past the call cap', async () => {
  const { client, calls, soft } = kakaoClient(() => new Response('', { status: 500 }), {
    locationConfig: { ...fastLocation, maxCallsPerRun: 1 },
  });
  await assert.rejects(client.locateComplex('a'), { kind: 'kakao_local_http_500' });
  assert.equal(calls.length, 1);
  assert.deepEqual(soft, ['kakao_local_http_500']);
});

test('a Kakao 400 is one bad query and does not stop other lookups', async () => {
  let count = 0;
  const { client, errors } = kakaoClient(() => {
    count += 1;
    return count === 1 ? new Response('', { status: 400 }) : kakaoResponse([{ x: '127', y: '37' }]);
  });
  assert.equal(await client.locateComplex('bad'), null);
  assert.deepEqual(await client.locateComplex('good'), { x: 127, y: 37 });
  assert.deepEqual(errors, []);
});

test('the Kakao call cap stops calls without an error mail', async () => {
  const { client, calls, soft, errors } = kakaoClient(() => kakaoResponse([{ x: '127', y: '37' }]), {
    locationConfig: { ...fastLocation, maxCallsPerRun: 2 },
  });
  await client.locateComplex('a');
  await client.locateComplex('b');
  await assert.rejects(client.locateComplex('c'), { kind: 'kakao_local_call_cap' });
  await assert.rejects(client.locateComplex('d'), { kind: 'kakao_local_call_cap' });
  assert.equal(calls.length, 2);
  assert.deepEqual(soft, ['kakao_local_call_cap']);
  assert.deepEqual(errors, []);
});

test('the Kakao time budget stops calls without an error mail', async () => {
  let current = 0;
  const { client, calls, soft } = kakaoClient(() => {
    current += 100;
    return kakaoResponse([{ x: '127', y: '37' }]);
  }, { locationConfig: { ...fastLocation, budgetMs: 100 }, now: () => new Date(current) });
  await client.locateComplex('a');
  await assert.rejects(client.locateComplex('b'), { kind: 'kakao_local_budget' });
  assert.equal(calls.length, 1);
  assert.deepEqual(soft, ['kakao_local_budget']);
});

test('a missing Kakao key makes no call and reports once', async () => {
  const { client, calls, errors } = kakaoClient(() => kakaoResponse([]), { key: '' });
  await assert.rejects(client.locateComplex('a'), { kind: 'kakao_local_key_missing' });
  await assert.rejects(client.locateComplex('b'), { kind: 'kakao_local_key_missing' });
  assert.equal(calls.length, 0);
  assert.deepEqual(errors, ['kakao_local_key_missing']);
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

// 공고 단지 역 900m, 비교 단지 역 200m, 거리 약 300m인 위치 조회 가짜
const fakeLocator = (overrides = {}) => ({
  calls: [],
  async locateSubject() { return { x: 127, y: 37.5 }; },
  async locateComplex(query) {
    this.calls.push(query);
    return { x: 127, y: 37.5027 };
  },
  async nearestStation(coord) { return coord.y === 37.5 ? 900 : 200; },
  ...overrides,
});

const evaluate = (notice, { trades = [], presale, locator, models = [{ houseType: '084A', area: 84, price: 100000 }], errors = [] } = {}) => evaluateLotto(notice, {
  config,
  today,
  getModels: async () => models,
  getTrades: async () => trades,
  getPresale: presale ? async () => presale : undefined,
  locator,
  onError: (kind) => errors.push(kind),
});

test('a located comparable is adjusted and the reason names it without any Kakao-derived value', async () => {
  const locator = fakeLocator();
  const result = await evaluate(apt(), { trades: saleRows(5, 2000, { aptName: '래미안역세권' }), locator });
  // 2000 / (1.06 × 1.05) × 84 = 150943
  assert.equal(result.estimate, 150943);
  assert.equal(locator.calls[0], '서울특별시 강남구 역삼동 100');
  assert.ok(result.reason.includes('래미안역세권'));
  assert.ok(result.reason.includes('브랜드 -5%'));
  assert.ok(result.reason.includes('역세권 보정 포함'));
  // 운영 정책상 역 거리, 역 계수, 단지 거리, 좌표는 저장되는 값에 넣지 않는다.
  const stored = JSON.stringify(result);
  for (const forbidden of ['900', '200m', '500m', '1.06', '127', '37.5', 'stationM', 'distanceM', 'coord']) {
    assert.ok(!stored.includes(forbidden), forbidden);
  }
  assert.equal(result.locationFallback, false);
});

test('a lookup failure skips the location adjustment, still estimates and sets confidence to 하', async () => {
  const failing = [
    fakeLocator({ async locateSubject() { throw new Error('quota'); } }),
    fakeLocator({ async locateComplex() { throw new Error('quota'); } }),
    fakeLocator({ async nearestStation() { throw new Error('quota'); } }),
    fakeLocator({ async locateSubject() { return null; } }),
    undefined,
  ];
  for (const locator of failing) {
    const result = await evaluate(apt(), { trades: saleRows(5, 2000, { aptName: '래미안역세권' }), locator });
    // 브랜드 보정은 남고 역 보정만 빠진다. 2000 / 1.05 × 84 = 160000
    assert.equal(result.estimate, 160000);
    assert.equal(result.confidence, '하');
    assert.equal(result.locationFallback, true);
    assert.ok(result.reason.includes('위치 보정 없음'));
  }
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
  ];
  const locator = fakeLocator();
  assert.equal((await evaluate(apt(), { trades, locator, presale: { rows: [], ok: true } })).confidence, '중');
  assert.equal((await evaluate(apt(), { trades, locator, presale: { rows: [], ok: false } })).confidence, '하');
  const same = saleRows(5, 1200, { aptName: '공고단지', jibun: '1' });
  assert.equal((await evaluate(apt(), { trades: same, presale: { rows: [], ok: true } })).confidence, '상');
  assert.equal((await evaluate(apt(), { trades: same, presale: { rows: [], ok: false } })).confidence, '중');
});

test('same-complex models make no location calls', async () => {
  let located = 0;
  const locator = fakeLocator({ async locateSubject() { located += 1; return null; } });
  const result = await evaluate(apt(), { trades: saleRows(5, 1500, { aptName: '공고단지', jibun: '1' }), locator });
  assert.equal(located, 0);
  assert.equal(result.locationFallback, false);
  assert.equal(result.estimate, 1500 * 84);
});

test('a real client with a small cap degrades to 하 for later notices without further calls', async () => {
  const calls = [];
  const soft = [];
  const client = createKakaoLocalClient({
    key: 'k',
    location: { ...fastLocation, maxCallsPerRun: 3 },
    sleep: noSleep,
    onSoft: (kind) => soft.push(kind),
    fetch: async (url) => {
      calls.push(String(url));
      if (String(url).includes('category.json')) return kakaoResponse([{ distance: '100', x: '127', y: '37.5' }]);
      return kakaoResponse([{ x: '127', y: '37.5' }]);
    },
  });
  const trades = saleRows(5, 1000, { aptName: '가단지' });
  const first = await evaluate(apt(), { trades, locator: client });
  assert.equal(first.locationFallback, false);
  assert.equal(calls.length, 3);
  const second = await evaluate(apt({ address: '서울특별시 강남구 역삼동 2', name: '다른공고' }), { trades: saleRows(5, 1000, { aptName: '나단지', jibun: '200' }), locator: client });
  assert.equal(second.locationFallback, true);
  assert.equal(second.confidence, '하');
  assert.equal(calls.length, 3);
  assert.deepEqual(soft, ['kakao_local_call_cap']);
});

test('restricted types are 대상 외 with empty margin, before triggers and before any lookup', async () => {
  for (const name of ['고덕강일 3단지 토지임대부', '광교 자연앤 센트레빌 59㎡ 지분적립형', '하남교산 신혼희망타운']) {
    for (const flags of [{ priceCap: false, publicDistrict: false }, { priceCap: true, publicDistrict: true }]) {
      let called = 0;
      const result = await evaluateLotto(apt({ name, flags }), {
        config,
        today,
        getModels: async () => { called += 1; return []; },
        getTrades: async () => { called += 1; return []; },
        getPresale: async () => { called += 1; return { rows: [], ok: true }; },
      });
      assert.equal(result.status, STATUS.OUT_OF_SCOPE);
      assert.equal(result.clearMarket, true);
      assert.equal(result.margin, null);
      assert.equal(result.marginRate, null);
      assert.equal(result.estimate, null);
      assert.equal(called, 0);
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
  const high = await evaluate(apt(), { trades: saleRows(5, 1800) });
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
const OTHERS = { 순번: { type: 'number', number: {} }, 관심: { type: 'checkbox', checkbox: {} } };

const notice = (extra = {}) => ({ key: '1-1', name: '테스트', region: '서울', typeLabel: 'APT', source: '청약홈', url: 'https://www.applyhome.co.kr/a', stages: [], ...extra });

test('buildProperties uses the new names and omits empty values', () => {
  const props = buildProperties(notice(), { status: '아님', estimate: 100, margin: -5, marginRate: -0.05, confidence: '중', locationFallback: true }, THU);
  assert.deepEqual(props['안전 마진'], { number: -5 });
  assert.deepEqual(props['마진율'], { number: -0.05 });
  assert.deepEqual(props['시세 신뢰도'], { select: { name: '중' } });
  assert.equal(props['예상 차익'], undefined);
  assert.equal(props['차익률'], undefined);
  assert.ok(!Object.keys(props).some((name) => name === 'null' || name === 'locationFallback'));

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

function worldFetch({ rows = [aptRow()], kakao, presale, trades = [tradeTags({ name: '래미안비밀', jibun: '100', amount: '168,000' })] } = {}) {
  const calls = { kakao: [], presale: [], molit: [] };
  const fetch = async (url) => {
    const text = String(url);
    const parsed = new URL(text);
    if (text.includes('dapi.kakao.com')) {
      calls.kakao.push(text);
      if (kakao) return kakao(parsed);
      if (parsed.pathname.endsWith('/category.json')) return kakaoResponse([{ distance: parsed.searchParams.get('x') === '127' ? '900' : '200', x: '127', y: '37.5' }]);
      return kakaoResponse([{ x: parsed.searchParams.get('query').endsWith('100') ? '127.002' : '127', y: '37.5' }]);
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
      config: { ...config, market: { ...config.market, location: { ...location, minIntervalMs: 0 } } },
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

test('a normal run looks up locations, stores the margin and keeps secrets and details out of the logs', async () => {
  const world = worldFetch();
  const h = harness({ fetch: world.fetch, env: { GITHUB_ACTIONS: 'true' } });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  const [{ evaluation: value, properties }] = h.store.state.upserts;
  // 비교 단지 168000 / 84 = 2000, ÷ (1.06 × 1.05) × 84
  assert.equal(value.estimate, 150943);
  assert.equal(value.status, STATUS.LOTTO);
  assert.equal(properties['안전 마진'].number, value.margin);
  assert.equal(properties['시세 신뢰도'].select.name, value.confidence);
  assert.ok(properties['판별 근거'].rich_text[0].text.content.includes('래미안비밀'));
  // 주소 2회, 역 2회
  assert.equal(world.calls.kakao.length, 4);
  assert.ok(h.logs.includes('market location_calls=4 location_fallback=0 confidence_high=0 confidence_mid=0 confidence_low=1 soft=none'));
  assert.ok(h.logs.some((line) => line.startsWith('trade_tags rows=5 noFloor=0 noDate=0 noDealing=0 noJibun=0 noSeq=5')));
  assert.ok(h.written.includes(`::add-mask::${KAKAO_SECRET}`));
  assert.ok(h.written.includes(`::add-mask::${DATA_SECRET}`));

  const output = JSON.stringify([h.logs, h.mails]);
  for (const secret of [KAKAO_SECRET, DATA_SECRET, 'dapi.kakao.com', '비밀공고단지', '래미안비밀', '역삼동', '7-7']) {
    assert.ok(!h.logs.join('\n').includes(secret), secret);
  }
  assert.ok(!output.includes(KAKAO_SECRET));
  assert.ok(!output.includes(DATA_SECRET));

  // Notion에 쓰는 값에 좌표와 역 거리, 카카오 응답이 없다.
  const stored = JSON.stringify(properties);
  for (const forbidden of ['127.002', '37.5', '900', 'documents', 'category']) assert.ok(!stored.includes(forbidden), forbidden);
});

test('a Kakao 429 stops location calls, mails its kind once and the job still succeeds at low confidence', async () => {
  const rows = [aptRow(), aptRow({ HOUSE_MANAGE_NO: '8', HSSPLY_ADRES: '서울특별시 강남구 역삼동 2' })];
  const world = worldFetch({ rows, kakao: () => new Response(`denied ${KAKAO_SECRET}`, { status: 429 }) });
  const h = harness({ fetch: world.fetch });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.equal(world.calls.kakao.length, 1);
  assert.ok(h.store.state.upserts.every((item) => item.evaluation.confidence === '하' && item.evaluation.estimate > 0));
  assert.ok(errorMail(h).text.includes('kakao_local_http_429 x1'));
  assert.ok(!JSON.stringify([h.logs, h.mails]).includes(KAKAO_SECRET));
});

test('a missing Kakao key still estimates at low confidence', async () => {
  const world = worldFetch();
  const h = harness({ fetch: world.fetch, env: { KAKAO_REST_KEY: '' } });
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.equal(world.calls.kakao.length, 0);
  assert.equal(h.store.state.upserts[0].evaluation.confidence, '하');
  assert.ok(errorMail(h).text.includes('kakao_local_key_missing x1'));
});

test('location can be switched off in config with no calls and no error', async () => {
  const world = worldFetch();
  const h = harness({ fetch: world.fetch });
  h.deps.config = { ...config, market: { ...config.market, location: { ...location, enabled: false } } };
  assert.equal(await run({ env: h.env, deps: h.deps }), 0);
  assert.equal(world.calls.kakao.length, 0);
  assert.equal(h.store.state.upserts[0].evaluation.confidence, '하');
  assert.equal(errorMail(h), undefined);
});

test('a remaining Kakao 5xx in a full run is log-only, while 401 reaches the error mail', async () => {
  const server = worldFetch({ kakao: () => new Response('', { status: 503 }) });
  const soft = harness({ fetch: server.fetch });
  assert.equal(await run({ env: soft.env, deps: soft.deps }), 0);
  assert.equal(server.calls.kakao.length, 2);
  assert.equal(errorMail(soft), undefined);
  assert.ok(marketLine(soft).endsWith('soft=kakao_local_http_503:1'));
  assert.equal(soft.store.state.upserts[0].evaluation.confidence, '하');

  const denied = worldFetch({ kakao: () => new Response('', { status: 401 }) });
  const hard = harness({ fetch: denied.fetch });
  assert.equal(await run({ env: hard.env, deps: hard.deps }), 0);
  assert.equal(denied.calls.kakao.length, 1);
  assert.ok(errorMail(hard).text.includes('kakao_local_http_401 x1'));
});

const summaryLine = (h) => h.logs.find((line) => line.startsWith('collected='));

test('lotto_demoted counts rows that were 로또 and now compute 아님 or 대상 외, and only those', async () => {
  const wasLotto = (extra = {}) => new Map([['7-7', { id: 'x', key: '7-7', lotto: '로또', urgentDate: null, end: THU, ...extra }]]);
  const lowPrice = [tradeTags({ name: '가단지', jibun: '100', amount: '84,000' })];
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
  assert.equal(base.calls.kakao.length, 0);
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

test('dry-run stays write-free while reading market data', async () => {
  const fake = schemaFake({ ...OLD, ...OTHERS });
  const base = worldFetch();
  const h = harness({
    store: null,
    fetch: async (url, init) => (String(url).includes('api.notion.com') ? fake.fetch(url, init) : base.fetch(url)),
  });
  h.deps.store = undefined;
  assert.equal(await run({ argv: ['--dry-run'], env: h.env, deps: h.deps }), 0);
  assert.deepEqual(fake.calls.filter((call) => call.method === 'PATCH' || (call.method === 'POST' && !call.path.endsWith('/query'))), []);
  assert.equal(h.mails.length, 0);
  assert.equal(h.kakao.length, 0);
  assert.equal(base.calls.kakao.length, 4);
});

test('the molit client reports tag tallies without names', async () => {
  const client = createMolitClient({ key: 'k', sleep: noSleep, fetch: async () => new Response(xml(['<dealAmount>1</dealAmount><excluUseAr>84</excluUseAr>', tradeTags()])) });
  await client.getTrades('11680', ['202610']);
  assert.deepEqual(client.stats(), { rows: 2, noFloor: 1, noDate: 1, noDealing: 1, noJibun: 1, noSeq: 2, noOwnership: 0 });
});

test('the workflow passes the Kakao key to the batch step', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/chungyak-alert.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const batch = workflow.slice(workflow.indexOf('- name: Run batch'), workflow.indexOf('- name: Remove token files'));
  assert.ok(batch.includes('KAKAO_REST_KEY: ${{ secrets.KAKAO_REST_KEY }}'));
});

test('config has every coefficient and SETUP says they are judgement starting values', () => {
  const setup = readFileSync(new URL('../docs/SETUP.md', import.meta.url), 'utf8');
  assert.ok(setup.includes('판단이 들어간 시작값'));
  assert.ok(config.market.location.maxCallsPerRun > 0);
  assert.equal(config.market.comparables.maxDistanceM, 2000);
  assert.equal(config.market.optionCostManwon, 1500);
});
