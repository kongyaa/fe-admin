import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ENDPOINTS,
  PER_PAGE,
  collectApplyhome,
  createModelLookup,
  fetchOdcloudAll,
  normalizeDetail,
  normalizeModel,
  parseHouseType,
} from '../src/sources/applyhome.js';
import { collectLh, extractPanId, extractRows, normalizeLh } from '../src/sources/lh.js';
import { createMolitClient, fetchMonth, parseMolitXml } from '../src/sources/molit.js';
import { resolveAddress } from '../src/sgg-codes.js';

const noSleep = async () => {};
const endpoint = (kind) => ENDPOINTS.find((item) => item.kind === kind);

const fullPage = () => Array.from({ length: PER_PAGE }, () => ({}));

function odcloudPages(pages) {
  const requested = [];
  return {
    requested,
    fetch: async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      requested.push(page);
      return Response.json(pages[page - 1]);
    },
  };
}

test('odcloud pagination continues past the first page and sends the auth header', async () => {
  const headers = [];
  const pages = odcloudPages([
    { totalCount: PER_PAGE * 2 + 1, data: fullPage() },
    { totalCount: PER_PAGE * 2 + 1, data: fullPage() },
    { totalCount: PER_PAGE * 2 + 1, data: [{}] },
  ]);
  const rows = await fetchOdcloudAll({
    key: 'k',
    op: 'getAPTLttotPblancDetail',
    sleep: noSleep,
    fetch: (url, init) => {
      headers.push(init.headers.Authorization);
      return pages.fetch(url);
    },
  });
  assert.deepEqual(pages.requested, [1, 2, 3]);
  assert.equal(rows.length, PER_PAGE * 2 + 1);
  assert.ok(headers.every((value) => value.endsWith(' k')));
});

test('a server perPage cap does not truncate results', async () => {
  const capped = (count) => Array.from({ length: count }, () => ({}));
  for (const counts of [{ totalCount: 250 }, { totalCount: 99999, matchCount: 250 }]) {
    const pages = odcloudPages([
      { ...counts, data: capped(100) },
      { ...counts, data: capped(100) },
      { ...counts, data: capped(50) },
    ]);
    const rows = await fetchOdcloudAll({ key: 'k', op: 'x', sleep: noSleep, fetch: pages.fetch });
    assert.deepEqual(pages.requested, [1, 2, 3]);
    assert.equal(rows.length, 250);
  }
});

test('a short page with an oversized count costs one extra call and then stops', async () => {
  const pages = odcloudPages([{ totalCount: 99999, data: [{}] }, { totalCount: 99999, data: [] }]);
  const rows = await fetchOdcloudAll({ key: 'k', op: 'x', sleep: noSleep, fetch: pages.fetch });
  assert.deepEqual(pages.requested, [1, 2]);
  assert.equal(rows.length, 1);
});

test('a short page still stops when the response has no counts', async () => {
  const pages = odcloudPages([{ data: [{}] }]);
  await fetchOdcloudAll({ key: 'k', op: 'x', sleep: noSleep, fetch: pages.fetch });
  assert.deepEqual(pages.requested, [1]);
});

test('model lookup outage stops later lookups after a network failure or timeout', async () => {
  const notice = { mdlOp: 'getAPTLttotPblancMdl', houseManageNo: '1', pblancNo: '1' };
  for (const [failure, kind] of [
    [new TypeError('fetch failed'), 'applyhome_network'],
    [Object.assign(new Error('t'), { name: 'TimeoutError' }), 'applyhome_timeout'],
  ]) {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      throw failure;
    };
    const lookup = createModelLookup({ key: 'k', sleep: noSleep, fetch });
    await assert.rejects(lookup(notice), { kind });
    assert.equal(calls, 3);
    await assert.rejects(lookup(notice), { kind });
    assert.equal(calls, 3);

    // 다음 실행은 새 조회기로 다시 시도한다.
    const nextRun = createModelLookup({ key: 'k', sleep: noSleep, fetch });
    await assert.rejects(nextRun(notice), { kind });
    assert.equal(calls, 6);
  }
});

test('model lookup HTTP errors do not trip the outage flag', async () => {
  const notice = { mdlOp: 'getAPTLttotPblancMdl', houseManageNo: '1', pblancNo: '1' };
  let calls = 0;
  const lookup = createModelLookup({
    key: 'k',
    sleep: noSleep,
    fetch: async () => {
      calls += 1;
      return calls === 1 ? new Response('', { status: 403 }) : Response.json({ totalCount: 1, data: [{ HOUSE_TY: '084A' }] });
    },
  });
  await assert.rejects(lookup(notice), { kind: 'applyhome_http_403' });
  assert.equal((await lookup(notice)).length, 1);
  assert.equal(calls, 2);
});

test('odcloud pagination prefers matchCount over totalCount', async () => {
  const pages = odcloudPages([{ totalCount: 99999, matchCount: PER_PAGE, data: fullPage() }]);
  await fetchOdcloudAll({ key: 'k', op: 'x', sleep: noSleep, fetch: pages.fetch });
  assert.deepEqual(pages.requested, [1]);
});

test('odcloud pagination falls back to totalCount and stops on an empty page', async () => {
  const exact = odcloudPages([{ totalCount: PER_PAGE, data: fullPage() }]);
  await fetchOdcloudAll({ key: 'k', op: 'x', sleep: noSleep, fetch: exact.fetch });
  assert.deepEqual(exact.requested, [1]);

  const empty = odcloudPages([{ totalCount: 99999, data: fullPage() }, { totalCount: 99999, data: [] }]);
  const rows = await fetchOdcloudAll({ key: 'k', op: 'x', sleep: noSleep, fetch: empty.fetch });
  assert.deepEqual(empty.requested, [1, 2]);
  assert.equal(rows.length, PER_PAGE);
});

test('key is not placed in the applyhome URL and each endpoint uses its date format', async () => {
  const urls = [];
  const result = await collectApplyhome({
    key: 'SECRET',
    today: '2026-11-05',
    lookbackDays: 5,
    sleep: noSleep,
    fetch: async (url) => {
      urls.push(url);
      return Response.json({ totalCount: 0, data: [] });
    },
  });
  assert.equal(result.notices.length, 0);
  assert.ok(urls.every((url) => !url.includes('SECRET')));
  const conditionOf = (op) => new URL(urls.find((url) => url.includes(op))).searchParams.get('cond[RCRIT_PBLANC_DE::GTE]');
  assert.equal(conditionOf('getAPTLttotPblancDetail'), '2026-10-31');
  assert.equal(conditionOf('getRemndrLttotPblancDetail'), '2026-10-31');
  assert.equal(conditionOf('getUrbtyOfctlLttotPblancDetail'), '2026-10-31');
  assert.equal(conditionOf('getOPTLttotPblancDetail'), '20261031');
  assert.equal(conditionOf('getPblPvtRentLttotPblancDetail'), '20261031');
});

test('collectApplyhome filters client-side and isolates endpoint failures', async () => {
  const result = await collectApplyhome({
    key: 'k',
    today: '2026-11-05',
    lookbackDays: 5,
    sleep: noSleep,
    fetch: async (url) => {
      if (url.includes('getOPT')) return new Response('', { status: 403 });
      if (url.includes('getAPT')) {
        return Response.json({
          totalCount: 2,
          data: [
            { HOUSE_MANAGE_NO: '1', PBLANC_NO: '1', RCRIT_PBLANC_DE: '2020-01-01' },
            { HOUSE_MANAGE_NO: '2', PBLANC_NO: '2', RCRIT_PBLANC_DE: '2026-11-01' },
          ],
        });
      }
      return Response.json({ totalCount: 0, data: [] });
    },
  });
  assert.deepEqual(result.notices.map((n) => n.key), ['2-2']);
  assert.deepEqual(result.errors, ['applyhome_http_403']);
  assert.equal(result.failedAll, false);
  assert.equal('endpointCount' in result, false);
});

test('APT normalization builds rank stages and flags', () => {
  const notice = normalizeDetail(endpoint('apt'), {
    HOUSE_MANAGE_NO: '2026000001',
    PBLANC_NO: '2026000001',
    HOUSE_NM: '테스트 아파트',
    HOUSE_SECD: '01',
    SUBSCRPT_AREA_CODE_NM: '서울',
    HSSPLY_ADRES: '서울특별시 강남구 역삼동 1',
    RCRIT_PBLANC_DE: '2026-11-01',
    SPSPLY_RCEPT_BGNDE: '2026-11-10',
    SPSPLY_RCEPT_ENDDE: '2026-11-10',
    GNRL_RNK1_CRSPAREA_RCPTDE: '2026-11-11',
    GNRL_RNK1_CRSPAREA_ENDDE: '2026-11-11',
    GNRL_RNK1_ETC_GG_RCPTDE: '2026-11-11',
    GNRL_RNK1_ETC_GG_ENDDE: '2026-11-11',
    GNRL_RNK2_CRSPAREA_RCPTDE: '2026-11-12',
    GNRL_RNK2_CRSPAREA_ENDDE: '2026-11-13',
    PARCPRC_ULS_AT: 'Y',
    PUBLIC_HOUSE_EARTH_AT: 'N',
  });
  assert.equal(notice.key, '2026000001-2026000001');
  assert.equal(notice.typeLabel, 'APT');
  assert.equal(notice.region, '서울');
  assert.deepEqual(notice.stages.map((s) => s.name), ['특별공급', '1순위 해당', '1순위 경기', '2순위 해당']);
  assert.equal(notice.overallStart, '2026-11-10');
  assert.equal(notice.overallEnd, '2026-11-13');
  assert.deepEqual(notice.flags, { priceCap: true, publicDistrict: false });
});

test('remainder normalization distinguishes 04 and 06 and keeps distinct stages', () => {
  const base = {
    HOUSE_MANAGE_NO: '1',
    PBLANC_NO: '2',
    SUBSCRPT_AREA_CODE_NM: '경기',
    SUBSCRPT_RCEPT_BGNDE: '2026-11-10',
    SUBSCRPT_RCEPT_ENDDE: '2026-11-11',
  };
  const remainder = normalizeDetail(endpoint('remainder'), {
    ...base,
    HOUSE_SECD: '04',
    SPSPLY_RCEPT_BGNDE: '2026-11-10',
    SPSPLY_RCEPT_ENDDE: '2026-11-10',
    GNRL_RCEPT_BGNDE: '2026-11-10',
    GNRL_RCEPT_ENDDE: '2026-11-11',
  });
  assert.equal(remainder.typeLabel, '무순위');
  assert.deepEqual(remainder.stages.map((s) => s.name), ['무순위 접수', '특별공급']);
  const resupply = normalizeDetail(endpoint('remainder'), { ...base, HOUSE_SECD: '06' });
  assert.equal(resupply.typeLabel, '불법행위 재공급');
  assert.equal(resupply.stages[0].name, '재공급 접수');
});

test('arbitrary, urbty and public rent normalize their own date and type fields', () => {
  const arbitrary = normalizeDetail(endpoint('arbitrary'), {
    HOUSE_MANAGE_NO: '1',
    PBLANC_NO: '1',
    HOUSE_SECD: '05',
    RCRIT_PBLANC_DE: '20261101',
    SUBSCRPT_RCEPT_BGNDE: '20261110',
    SUBSCRPT_RCEPT_ENDDE: '20261111',
  });
  assert.equal(arbitrary.typeLabel, '임의공급');
  assert.equal(arbitrary.announceDate, '2026-11-01');
  assert.deepEqual(arbitrary.stages, [{ name: '임의 접수', start: '2026-11-10', end: '2026-11-11' }]);

  const urbty = normalizeDetail(endpoint('urbty'), {
    HOUSE_MANAGE_NO: '1',
    PBLANC_NO: '2',
    HOUSE_SECD: '02',
    SEARCH_HOUSE_SECD: '0202',
    SUBSCRPT_RCEPT_BGNDE: '2026-11-10',
  });
  assert.equal(urbty.typeLabel, '오피스텔');
  assert.equal(urbty.stages[0].name, '접수');

  const rent = normalizeDetail(endpoint('pblrent'), {
    HOUSE_MANAGE_NO: '1',
    PBLANC_NO: '3',
    HOUSE_SECD: '03',
    SEARCH_HOUSE_SECD: '0303',
    RCRIT_PBLANC_DE: '20261101',
    SUBSCRPT_RCEPT_BGNDE: '20261110',
  });
  assert.equal(rent.typeLabel, '공공지원민간임대');
  assert.equal(rent.announceDate, '2026-11-01');
  assert.equal(rent.stages[0].start, '2026-11-10');
});

test('HOUSE_TY and model fields parse into area and price', () => {
  assert.equal(parseHouseType('084.9810A'), 84.981);
  assert.equal(parseHouseType('059T'), 59);
  assert.equal(parseHouseType('타입A'), null);
  assert.deepEqual(normalizeModel({ HOUSE_TY: '084.9810A', LTTOT_TOP_AMOUNT: '120,000' }), {
    houseType: '084.9810A',
    area: 84.981,
    price: 120000,
    households: null,
  });
  // 공급 세대수는 일반공급과 특별공급의 합이다.
  assert.equal(normalizeModel({ HOUSE_TY: '084A', SUPLY_HSHLDCO: '120', SPSPLY_HSHLDCO: '80' }).households, 200);
  assert.equal(normalizeModel({ HOUSE_TY: '084A', SUPLY_HSHLDCO: '12' }).households, 12);
  assert.equal(normalizeModel({ GP: '1군', TP: 'A', SUPLY_HSHLDCO: '30' }).households, 30);
  const urbty = normalizeModel({ GP: '1군', TP: 'A', EXCLUSE_AR: '29.5', SUPLY_AMOUNT: '30000' });
  assert.equal(urbty.area, 29.5);
  assert.equal(urbty.price, 30000);
});

const molitXml = (items, total, code = '000') => `<response><header><resultCode>${code}</resultCode></header><body><items>${items
  .map((inner) => `<item>${inner}</item>`)
  .join('')}</items><totalCount>${total}</totalCount></body></response>`;

const trade = (amount, extra = '') => `<aptNm>A</aptNm><dealAmount> ${amount}</dealAmount><excluUseAr>84.9</excluUseAr><umdNm>역삼동</umdNm><buildYear>2020</buildYear>${extra}`;

test('MOLIT parsing strips commas and skips cancelled rows', () => {
  const parsed = parseMolitXml(molitXml([
    trade('120,000', '<cdealType></cdealType>'),
    trade('130,000', '<cdealType>O</cdealType>'),
    trade('140,000', '<cdealType> </cdealType>'),
  ], 3));
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].amount, 120000);
  assert.equal(parsed.cancelled, 1);
});

test('MOLIT pagination continues past the first page to totalCount', async () => {
  const pages = [];
  const rows = await fetchMonth({
    key: 'k',
    lawdCode: '11680',
    dealYm: '202610',
    sleep: noSleep,
    fetch: async (url) => {
      const page = Number(new URL(url).searchParams.get('pageNo'));
      pages.push(page);
      return new Response(molitXml([trade('100,000')], 2));
    },
  });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(rows.length, 2);
});

test('MOLIT errors on a bad resultCode or unreadable tags', async () => {
  const run = (xml) => fetchMonth({ key: 'k', lawdCode: '1', dealYm: '2', sleep: noSleep, fetch: async () => new Response(xml) });
  await assert.rejects(run(molitXml([], 0, '30')), { kind: 'molit_result_30' });
  await assert.rejects(run('<OpenAPI_ServiceResponse/>'), { kind: 'molit_parse' });
  await assert.rejects(run(molitXml(['<other>1</other>'], 1)), { kind: 'molit_parse' });
});

test('MOLIT outage stops all later calls after the first network failure or timeout', async () => {
  for (const [failure, kind] of [
    [new TypeError('fetch failed'), 'molit_network'],
    [Object.assign(new Error('t'), { name: 'TimeoutError' }), 'molit_timeout'],
  ]) {
    let calls = 0;
    const client = createMolitClient({
      key: 'k',
      sleep: noSleep,
      fetch: async () => {
        calls += 1;
        throw failure;
      },
    });
    await assert.rejects(client.getTrades('11680', ['202610', '202609']), { kind });
    const afterFirst = calls;
    assert.equal(afterFirst, 3);
    await assert.rejects(client.getTrades('11650', ['202610']), { kind });
    await assert.rejects(client.getTrades('11680', ['202608']), { kind });
    assert.equal(calls, afterFirst);
  }
});

test('MOLIT HTTP and result errors do not trip the outage flag', async () => {
  let calls = 0;
  const client = createMolitClient({
    key: 'k',
    sleep: noSleep,
    fetch: async () => {
      calls += 1;
      return new Response('', { status: 403 });
    },
  });
  await assert.rejects(client.getTrades('11680', ['202610']), { kind: 'molit_http_403' });
  await assert.rejects(client.getTrades('11650', ['202610']), { kind: 'molit_http_403' });
  assert.equal(calls, 2);
});

test('LH finds rows in the envelope, extracts PAN_ID and drops land types', () => {
  const row = {
    PAN_NM: '공고',
    UPP_AIS_TP_NM: '임대주택',
    AIS_TP_CD_NM: '행복주택',
    CNP_CD_NM: '서울특별시',
    PAN_SS: '공고중',
    ALL_CNT: 1,
    DTL_URL: 'https://apply.lh.or.kr/LH/index.html?gv_param=CCR_CNNT_SYS_DS_CD:03,PAN_ID:0000060749,X:1',
  };
  assert.equal(extractRows([{ dsSch: [{}] }, { dsList: [row] }])[0], row);
  assert.throws(() => extractRows({ message: 'x' }), { kind: 'lh_parse' });
  assert.equal(extractPanId(row), '0000060749');

  const notice = normalizeLh(row, ['토지', '상가']);
  assert.equal(notice.key, 'LH-0000060749');
  assert.equal(notice.region, '서울');
  assert.deepEqual(notice.stages, []);
  assert.equal(normalizeLh({ ...row, UPP_AIS_TP_NM: '토지' }, ['토지', '상가']), null);
  assert.equal(normalizeLh({ ...row, AIS_TP_CD_NM: '상가' }, ['토지', '상가']), null);

  const dated = normalizeLh({ ...row, PAN_NT_ST_DT: '2026.11.01', CLSG_DT: '2026.11.20' }, []);
  assert.deepEqual(dated.stages, [{ name: '공고~마감', start: '2026-11-01', end: '2026-11-20' }]);
});

test('LH pagination follows ALL_CNT', async () => {
  const pages = [];
  const row = { PAN_NM: 'a', ALL_CNT: 2, DTL_URL: 'https://x.test/?panId=1' };
  const notices = await collectLh({
    key: 'k',
    today: '2026-11-05',
    lookbackDays: 1,
    lookaheadDays: 1,
    excludeKeywords: [],
    sleep: noSleep,
    fetch: async (url) => {
      pages.push(new URL(url).searchParams.get('PAGE'));
      return Response.json([{ dsList: [row] }]);
    },
  });
  assert.deepEqual(pages, ['1', '2']);
  assert.equal(notices.length, 2);
});

test('SGG mapping is token exact', () => {
  assert.equal(resolveAddress('인천광역시 서구 청라동 1').code, '28260');
  assert.equal(resolveAddress('서울특별시 강서구 마곡동 1').code, '11500');
  assert.equal(resolveAddress('서울특별시 서해구 어딘가').code, null);
  assert.equal(resolveAddress('서울특별시 서구 어딘가').code, null);
  assert.equal(resolveAddress('인천광역시 강서구 어딘가').code, null);
});

test('SGG mapping covers the 2026 인천 and 화성 districts with official codes', () => {
  const expected = {
    '인천광역시 제물포구 만석동 1': '28125',
    '인천광역시 영종구 운서동 1': '28155',
    '인천광역시 서해구 청라동 1': '28275',
    '인천광역시 검단구 당하동 1': '28290',
    '경기도 화성시 만세구 향남읍 1': '41591',
    '경기도 화성시 효행구 봉담읍 1': '41593',
    '경기도 화성시 병점구 병점동 1': '41595',
    '경기도 화성시 동탄구 영천동 1': '41597',
  };
  for (const [address, code] of Object.entries(expected)) {
    assert.equal(resolveAddress(address).code, code, address);
  }
  assert.equal(resolveAddress('경기도 화성시 동탄구 영천동 1').umd, '영천동');
});

test('SGG mapping covers city-with-gu keys and leaves unknown districts unmapped', () => {
  const yeongtong = resolveAddress('경기도 수원시 영통구 망포동 1');
  assert.equal(yeongtong.code, '41117');
  assert.equal(yeongtong.umd, '망포동');
  assert.equal(resolveAddress('경기도 수원시 없는구 망포동').code, null);
  assert.equal(resolveAddress('경기도 화성시 봉담읍 1').code, '41590');
  assert.equal(resolveAddress('경기도 화성시 새로운구 1').code, null);
  assert.equal(resolveAddress('강남구 역삼동 1', '서울').code, '11680');
  assert.equal(resolveAddress('부산광역시 해운대구 우동').code, null);
});
