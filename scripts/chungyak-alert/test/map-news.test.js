import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NEWS_ENDPOINTS, cleanTitle, collectNews, createNewsClient, dedupe, keepRecent, newsDate, newsQuery, newsTargets,
  normalizeItem, outletOf, relevant, zoneName,
} from '../src/pipeline/news.js';

const today = '2026-11-10';
const noSleep = async () => {};
const env = { NAVER_CLIENT_ID: 'test-id', NAVER_CLIENT_SECRET: 'test-secret' };

const seoul = (extra) => ({
  id: 'seoul-1441', name: '신영1', kind: '재개발', region: '서울', district: '종로구', stage: '착공', bucket: 'soon',
  window: { from: '2026-12', to: '2027-12' }, ...extra,
});
const town = (extra) => ({
  id: 'town-hanam-gyosan', name: '하남교산', kind: '공공주택지구', region: '경기', district: '하남시', stage: '블록별 분양',
  bucket: 'soon', noticeMatch: ['교산'], ...extra,
});
const raw = (extra) => ({
  title: '기사', originallink: 'https://www.newsis.com/view/1', link: 'https://n.news.naver.com/article/003/1',
  description: '요약은 저장하지 않는다', pubDate: 'Mon, 09 Nov 2026 09:30:00 +0900', ...extra,
});
const item = (extra) => ({ title: '기사', outlet: '뉴시스', date: '2026-11-09', url: 'https://www.newsis.com/view/1', ...extra });

// 호출을 기록하고 응답을 돌려주는 가짜 fetch. reply(url, init) -> Response
function fakeFetch(reply) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: new URL(url), headers: init?.headers ?? {} });
    return reply(new URL(url), init);
  };
  return { fetch, calls };
}

const okBody = (items) => ({ lastBuildDate: 'Tue, 10 Nov 2026 10:00:00 +0900', total: items.length, start: 1, display: items.length, items });

test('title cleaning strips tags and decodes entities', () => {
  assert.equal(cleanTitle('<b>신영1구역</b> &quot;재개발&quot; 착공 &amp; 분양'), '신영1구역 "재개발" 착공 & 분양');
  assert.equal(cleanTitle('하남 &lt;교산&gt; &#39;첫&#39; &#x27;본청약&#x27;  예정'), "하남 <교산> '첫' '본청약' 예정");
  assert.equal(cleanTitle('알 수 없는 &zzz; 엔티티'), '알 수 없는 &zzz; 엔티티');
  assert.equal(cleanTitle(null), '');
});

test('pubDate is read as a Korean date', () => {
  assert.equal(newsDate('Mon, 09 Nov 2026 09:30:00 +0900'), '2026-11-09');
  // 한국 자정 직후는 UTC로는 전날이지만 한국 날짜로 남긴다.
  assert.equal(newsDate('Tue, 10 Nov 2026 00:10:00 +0900'), '2026-11-10');
  assert.equal(newsDate('Mon, 09 Nov 2026 16:00:00 GMT'), '2026-11-10');
  assert.equal(newsDate('어제'), null);
  assert.equal(newsDate(''), null);
});

test('outlet comes from the original link host', () => {
  assert.equal(outletOf('https://www.newsis.com/view/1'), '뉴시스');
  assert.equal(outletOf('https://m.hankyung.com/article/1'), '한국경제');
  assert.equal(outletOf('https://biz.chosun.com/x'), '조선비즈');
  assert.equal(outletOf('https://www.chosun.com/x'), '조선일보');
  assert.equal(outletOf('https://www.smalltown-news.co.kr/a'), 'smalltown-news.co.kr');
  assert.equal(outletOf('not a url'), null);
});

test('normalizeItem keeps only title, outlet, date, url', () => {
  const result = normalizeItem(raw({ title: '<b>하남교산</b> 첫 본청약 &quot;임박&quot;' }));
  assert.deepEqual(result, { title: '하남교산 첫 본청약 "임박"', outlet: '뉴시스', date: '2026-11-09', url: 'https://www.newsis.com/view/1' });
  assert.equal('description' in result, false);
  // 원문이 http(s)가 아니면 네이버 링크
  const fallback = normalizeItem(raw({ originallink: 'javascript:alert(1)' }));
  assert.equal(fallback.url, 'https://n.news.naver.com/article/003/1');
  assert.equal(fallback.outlet, '네이버 뉴스');
  assert.equal(normalizeItem(raw({ originallink: '', link: '' })), null);
  assert.equal(normalizeItem(raw({ title: '<b></b>' })), null);
  assert.equal(normalizeItem(raw({ pubDate: 'x' })).date, null);
  assert.equal(normalizeItem(null), null);
});

test('keepRecent keeps 21 days including the boundary day', () => {
  const items = [
    item({ url: 'a', date: '2026-11-10' }),
    item({ url: 'b', date: '2026-10-20' }), // 21일 전: 남김
    item({ url: 'c', date: '2026-10-19' }), // 22일 전: 뺌
    item({ url: 'd', date: null }),
    item({ url: 'e', date: '2026-11-11' }), // 미래 날짜: 뺌
  ];
  assert.deepEqual(keepRecent(items, today).map((x) => x.url), ['a', 'b']);
  assert.deepEqual(keepRecent(items, today, 7).map((x) => x.url), ['a']);
});

test('dedupe drops the same url or the same title', () => {
  const items = [
    item({ url: 'https://a.com/1', title: '신영1구역 "재개발" 착공' }),
    item({ url: 'https://a.com/1', title: '다른 제목' }),
    item({ url: 'https://b.com/2', title: '신영1구역 재개발 착공' }),
    item({ url: 'https://c.com/3', title: '신영1구역 일반분양 일정' }),
  ];
  assert.deepEqual(dedupe(items).map((x) => x.url), ['https://a.com/1', 'https://c.com/3']);
});

test('news query for towns and Seoul zones', () => {
  assert.equal(newsQuery(town()), '하남교산');
  assert.equal(newsQuery(seoul()), '종로 신영1구역 재개발');
  assert.equal(newsQuery(seoul({ name: '반포미도2차', district: '서초구', kind: '재건축' })), '서초 반포미도2차 재건축');
  assert.equal(newsQuery(seoul({ name: '한남3구역', district: '용산구' })), '용산 한남3구역 재개발');
  assert.equal(newsQuery(seoul({ name: '신당10', district: '중구' })), '중구 신당10구역 재개발');
  assert.equal(newsQuery(seoul({ name: '' })), null);
  assert.equal(zoneName('수송1-2'), '수송1-2구역');
  assert.equal(zoneName('개포주공5단지'), '개포주공5단지');
});

test('relevance for Seoul zones guards digit endings', () => {
  const sinyeong = seoul();
  assert.equal(relevant(item({ title: '신영1구역 재개발 착공' }), sinyeong), true);
  assert.equal(relevant(item({ title: '종로 신영 1구역 분양 임박' }), sinyeong), true);
  assert.equal(relevant(item({ title: '<b>신영1</b> 재개발' }), sinyeong), true);
  assert.equal(relevant(item({ title: '신영동 주택 시장' }), sinyeong), false);

  const singil = seoul({ name: '신길2', district: '영등포구' });
  assert.equal(relevant(item({ title: '신길2구역 관리처분' }), singil), true);
  assert.equal(relevant(item({ title: '신길2차 아파트 리모델링' }), singil), false);
  assert.equal(relevant(item({ title: '신길2동 주민센터' }), singil), false);

  const sindang = seoul({ name: '신당1', district: '중구' });
  assert.equal(relevant(item({ title: '신당10구역 시공사 선정' }), sindang), false);
  assert.equal(relevant(item({ title: '신당1구역 이주 시작' }), sindang), true);

  // 서울 기사 제목에는 구가 거의 없으므로 구는 보지 않는다.
  assert.equal(relevant(item({ title: '성동구 신당1구역?' }), sindang), true);

  const mido = seoul({ name: '반포미도2차', district: '서초구', kind: '재건축' });
  assert.equal(relevant(item({ title: '반포 미도2차 재건축 속도' }), mido), true);
  assert.equal(relevant(item({ title: '반포미도1차 재건축' }), mido), false);

  // 짧은 이름은 '<이름>구역'만
  const short = seoul({ name: '수표', district: '중구' });
  assert.equal(relevant(item({ title: '수표구역 정비' }), short), true);
  assert.equal(relevant(item({ title: '수표 도시정비형' }), short), false);
});

test('relevance for towns uses name or noticeMatch', () => {
  assert.equal(relevant(item({ title: '하남교산 본청약 일정' }), town()), true);
  assert.equal(relevant(item({ title: '교산 푸르지오 더 퍼스트 견본주택' }), town()), true);
  assert.equal(relevant(item({ title: '하남 감일 분양' }), town()), false);
  const topyeong = town({ id: 'town-guri', name: '구리토평한강', noticeMatch: ['토평한강', '토평2'] });
  assert.equal(relevant(item({ title: '구리 토평2지구 보상' }), topyeong), true);
  assert.equal(relevant(item({ title: '토평20단지' }), topyeong), false);
  assert.equal(relevant(item({ title: '하남교산 소식' }), town({ noticeMatch: undefined })), true);
});

test('targets: all towns, Seoul live > soon > mid by window start, capped', () => {
  const projects = [
    seoul({ id: 's-mid', bucket: 'mid', window: { from: '2028-01' } }),
    seoul({ id: 's-soon-late', bucket: 'soon', window: { from: '2027-06' } }),
    seoul({ id: 's-far', bucket: 'far' }),
    town({ id: 't-1', bucket: 'far' }),
    seoul({ id: 's-live', bucket: 'live', window: null }),
    seoul({ id: 's-soon-early', bucket: 'soon', window: { from: '2026-12' } }),
    seoul({ id: 's-done', bucket: 'likely_sold' }),
    town({ id: 't-2', bucket: 'done' }),
  ];
  assert.deepEqual(newsTargets(projects).map((p) => p.id), ['t-1', 't-2', 's-live', 's-soon-early', 's-soon-late', 's-mid']);
  assert.deepEqual(newsTargets(projects, { maxSeoul: 2 }).map((p) => p.id), ['t-1', 't-2', 's-live', 's-soon-early']);
  assert.deepEqual(newsTargets(projects, { maxSeoul: 0 }).map((p) => p.id), ['t-1', 't-2']);
});

test('hub client sends NCP headers and query params', async () => {
  const { fetch, calls } = fakeFetch(() => Response.json(okBody([raw()])));
  const client = createNewsClient({ fetch, env, sleep: noSleep });
  assert.equal(client.endpoint, 'hub');
  const result = await client.search('종로 신영1구역 재개발', { display: 30 });
  assert.equal(result.items.length, 1);
  const [{ url, headers }] = calls;
  assert.equal(`${url.origin}${url.pathname}`, NEWS_ENDPOINTS.hub.url);
  assert.equal(url.searchParams.get('query'), '종로 신영1구역 재개발');
  assert.match(url.search, /query=%EC%A2%85%EB%A1%9C/); // UTF-8 인코딩
  assert.equal(url.searchParams.get('display'), '30');
  assert.equal(url.searchParams.get('start'), '1');
  assert.equal(url.searchParams.get('sort'), 'date');
  assert.equal(headers['X-NCP-APIGW-API-KEY-ID'], 'test-id');
  assert.equal(headers['X-NCP-APIGW-API-KEY'], 'test-secret');
  assert.equal(headers['X-Naver-Client-Id'], undefined);
  // 키는 주소에 들어가지 않는다.
  assert.doesNotMatch(url.href, /test-id|test-secret/);
});

test('legacy client by option or env, display clamped', async () => {
  const { fetch, calls } = fakeFetch(() => Response.json(okBody([])));
  await createNewsClient({ fetch, env, sleep: noSleep, endpoint: 'legacy' }).search('하남교산', { display: 500, sort: 'sim' });
  await createNewsClient({ fetch, env: { ...env, NAVER_NEWS_ENDPOINT: 'LEGACY' }, sleep: noSleep }).search('하남교산', { display: 0 });
  for (const { url, headers } of calls) {
    assert.equal(`${url.origin}${url.pathname}`, NEWS_ENDPOINTS.legacy.url);
    assert.equal(headers['X-Naver-Client-Id'], 'test-id');
    assert.equal(headers['X-Naver-Client-Secret'], 'test-secret');
    assert.equal(headers['X-NCP-APIGW-API-KEY-ID'], undefined);
  }
  assert.equal(calls[0].url.searchParams.get('display'), '100');
  assert.equal(calls[0].url.searchParams.get('sort'), 'sim');
  assert.equal(calls[1].url.searchParams.get('display'), '1');
});

test('client errors: no key, bad endpoint, http status, parse', async () => {
  const { fetch, calls } = fakeFetch(() => Response.json(okBody([])));
  await assert.rejects(createNewsClient({ fetch, env: {}, sleep: noSleep }).search('x'), { kind: 'news_no_key' });
  await assert.rejects(createNewsClient({ fetch, env: { NAVER_CLIENT_ID: 'a' }, sleep: noSleep }).search('x'), { kind: 'news_no_key' });
  await assert.rejects(createNewsClient({ fetch, env, sleep: noSleep, endpoint: 'other' }).search('x'), { kind: 'news_endpoint' });
  assert.equal(calls.length, 0);

  const denied = fakeFetch(() => new Response('{"errorCode":"024"}', { status: 401 }));
  await assert.rejects(createNewsClient({ fetch: denied.fetch, env, sleep: noSleep }).search('x'), { kind: 'news_http_401' });
  assert.equal(denied.calls.length, 1);

  const html = fakeFetch(() => new Response('<html>점검</html>', { status: 200 }));
  await assert.rejects(createNewsClient({ fetch: html.fetch, env, sleep: noSleep }).search('x'), { kind: 'news_parse' });
  const noItems = fakeFetch(() => Response.json({ total: 0 }));
  await assert.rejects(createNewsClient({ fetch: noItems.fetch, env, sleep: noSleep }).search('x'), { kind: 'news_parse' });
});

test('collectNews filters, trims and isolates failures', async () => {
  const sindang = seoul({ id: 'seoul-sindang1', name: '신당1', district: '중구' });
  const broken = seoul({ id: 'seoul-broken', name: '신길2', district: '영등포구' });
  const replies = {
    하남교산: [
      raw({ title: '<b>하남교산</b> A3블록 &quot;본청약&quot;', originallink: 'https://www.hankyung.com/1', pubDate: 'Sun, 08 Nov 2026 10:00:00 +0900' }),
      raw({ title: '하남교산 A3블록 "본청약"', originallink: 'https://www.mk.co.kr/2', pubDate: 'Sun, 08 Nov 2026 09:00:00 +0900' }),
      raw({ title: '교산 푸르지오 입주', originallink: 'https://www.newsis.com/3', pubDate: 'Mon, 19 Oct 2026 10:00:00 +0900' }),
      raw({ title: '감일지구 소식', originallink: 'https://www.newsis.com/4' }),
    ],
    '중구 신당1구역 재개발': [
      raw({ title: '신당10구역 시공사', originallink: 'https://www.yna.co.kr/1' }),
    ],
  };
  const sleeps = [];
  const { fetch, calls } = fakeFetch((url) => {
    const query = url.searchParams.get('query');
    if (query.includes('신길2')) return new Response('', { status: 500 });
    return Response.json(okBody(replies[query] ?? []));
  });
  const client = createNewsClient({ fetch, env, sleep: noSleep });
  const result = await collectNews({
    projects: [town(), broken, sindang, { id: 'x', name: '' }],
    client,
    today,
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.deepEqual(result.byId, {
    'town-hanam-gyosan': [{ title: '하남교산 A3블록 "본청약"', outlet: '한국경제', date: '2026-11-08', url: 'https://www.hankyung.com/1' }],
  });
  assert.equal(result.checked, 3);
  assert.equal(result.matched, 1);
  assert.deepEqual(result.errors, ['news_http_500']);
  assert.equal(result.stopped, null);
  // 500은 한 번 재시도한다. 사업 사이에만 쉰다.
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [200, 200]);
});

test('collectNews caps items per project, newest first', async () => {
  const items = Array.from({ length: 8 }, (_, i) => raw({
    title: `하남교산 소식 ${i}`, originallink: `https://www.newsis.com/${i}`, pubDate: `Sun, 0${i + 1} Nov 2026 10:00:00 +0900`,
  }));
  const { fetch } = fakeFetch(() => Response.json(okBody(items)));
  const result = await collectNews({ projects: [town()], client: createNewsClient({ fetch, env, sleep: noSleep }), today, limitPerProject: 3, sleep: noSleep });
  assert.deepEqual(result.byId['town-hanam-gyosan'].map((x) => x.date), ['2026-11-08', '2026-11-07', '2026-11-06']);
});

test('collectNews stops on quota or auth errors', async () => {
  for (const status of [401, 403, 429]) {
    const { fetch, calls } = fakeFetch(() => new Response('', { status }));
    const result = await collectNews({
      projects: [town(), seoul(), seoul({ id: 'seoul-2', name: '신당1' })],
      client: createNewsClient({ fetch, env, sleep: noSleep }),
      today,
      sleep: noSleep,
    });
    assert.equal(result.stopped, `news_http_${status}`);
    assert.deepEqual(result.errors, [`news_http_${status}`]);
    assert.equal(result.checked, 1);
    // 429만 한 번 재시도한다.
    assert.equal(calls.length, status === 429 ? 2 : 1);
  }
});

test('collectNews without keys makes no calls', async () => {
  const { fetch, calls } = fakeFetch(() => Response.json(okBody([])));
  const result = await collectNews({ projects: [town(), seoul()], client: createNewsClient({ fetch, env: {}, sleep: noSleep }), today, sleep: noSleep });
  assert.equal(result.stopped, 'news_no_key');
  assert.deepEqual(result.byId, {});
  assert.equal(calls.length, 0);
});
