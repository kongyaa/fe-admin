import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NEWS_BUDGET_MS, NEWS_ENDPOINTS, NEWS_TIMEOUT_MS, cleanTitle, collectNews, createNewsClient, dedupe, keepRecent,
  namesOtherDistrict, newsDate, newsQuery, newsTargets, normalizeItem, normalizeNewsTitle, outletOf, relevant, seoulNewsName,
  shadowKeys, zoneName,
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
  // 원문이 http(s)가 아니면 네이버 링크. 언론사는 알 수 없어 null(사이트는 날짜만 보여 준다).
  const fallback = normalizeItem(raw({ originallink: 'javascript:alert(1)' }));
  assert.equal(fallback.url, 'https://n.news.naver.com/article/003/1');
  assert.equal(fallback.outlet, null);
  assert.equal(normalizeItem(raw({ originallink: '' })).outlet, null);
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

  // 제목이 다른 서울 구를 말하면 같은 이름이어도 다른 구역이다.
  assert.equal(relevant(item({ title: '성동구 신당1구역?' }), sindang), false);
  assert.equal(relevant(item({ title: '중구 신당1구역 이주' }), sindang), true);

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

// 남양주왕숙(왕숙1)과 남양주왕숙2는 다른 지구다. 가장 긴 지구 이름을 먼저 본다: '남양주왕숙2' 제목은 왕숙1 기사가 아니다.
const wangsuk = town({
  id: 'town-namyangju-wangsuk', name: '남양주왕숙', district: '남양주시', noticeMatch: ['왕숙A', '왕숙B', '왕숙S', '왕숙지구', '왕숙공공주택지구', '왕숙푸르지오', '왕숙한신더휴'],
});
const wangsuk2 = town({ id: 'town-namyangju-wangsuk2', name: '남양주왕숙2', district: '남양주시', noticeMatch: ['왕숙2', '왕숙아테라'] });

test('town relevance prefers the longest town name (남양주왕숙2 is not 남양주왕숙)', () => {
  const towns = [town(), wangsuk, wangsuk2, seoul()];
  assert.deepEqual(shadowKeys(wangsuk, towns), ['남양주왕숙2']);
  assert.deepEqual(shadowKeys(wangsuk2, towns), []);
  assert.deepEqual(shadowKeys(town(), towns), []);
  const one = { shadows: shadowKeys(wangsuk, towns) };
  const two = { shadows: shadowKeys(wangsuk2, towns) };
  const cases = [
    ['남양주왕숙2 A-3 본청약 경쟁률 126.8대 1', false, true],
    ['남양주 왕숙2 첫 공공분양 흥행', false, true],
    ['남양주왕숙 B-17 경쟁률 109.6대 1', true, false],
    ['남양주왕숙지구 A-1블록 본청약', true, false],
    // 두 지구를 함께 말하면 둘 다
    ['남양주왕숙·남양주왕숙2 착공식', true, true],
    ['남양주왕숙2·남양주왕숙 보상', true, true],
    ['하남교산 A2 입주', false, false],
  ];
  for (const [title, forOne, forTwo] of cases) {
    assert.equal(relevant(item({ title }), wangsuk, one), forOne, `왕숙1: ${title}`);
    assert.equal(relevant(item({ title }), wangsuk2, two), forTwo, `왕숙2: ${title}`);
  }
  // shadows 없이 부르면 예전처럼 이름만 본다
  assert.equal(relevant(item({ title: '남양주왕숙2 A-3 본청약' }), wangsuk), true);
});

test('collectNews gives a 남양주왕숙2 headline only to 남양주왕숙2', async () => {
  const both = [
    raw({ title: '남양주왕숙2 A-3 본청약 경쟁률', originallink: 'https://www.newsis.com/w2', pubDate: 'Mon, 09 Nov 2026 10:00:00 +0900' }),
    raw({ title: '남양주왕숙 B-17 본청약', originallink: 'https://www.newsis.com/w1', pubDate: 'Sun, 08 Nov 2026 10:00:00 +0900' }),
  ];
  const { fetch } = fakeFetch(() => Response.json(okBody(both)));
  const result = await collectNews({
    projects: [wangsuk, wangsuk2], client: createNewsClient({ fetch, env, sleep: noSleep }), today, sleep: noSleep,
  });
  assert.deepEqual(result.byId['town-namyangju-wangsuk'].map((x) => x.url), ['https://www.newsis.com/w1']);
  assert.deepEqual(result.byId['town-namyangju-wangsuk2'].map((x) => x.url), ['https://www.newsis.com/w2']);
});

// 서울 구역명 -> 검색어와 제목 비교값(keys). link-notices.js의 zoneKey와 별개인 뉴스용 규칙이다.
test('Seoul news names: query and keys table', () => {
  const cases = [
    // [이름, 종류, 구, 검색어, keys, extras]
    ['신영1', '재개발', '종로구', '종로 신영1구역 재개발', ['신영1'], []],
    ['한남3', '재개발', '용산구', '용산 한남3구역 재개발', ['한남3'], []],
    ['한남3구역', '재개발', '용산구', '용산 한남3구역 재개발', ['한남3'], []],
    ['세운3-8,9,10', '재개발', '중구', '중구 세운3-8구역 재개발', ['세운3-8', '세운3-9', '세운3-10'], []],
    ['세운3-8, 9, 10구역', '재개발', '중구', '중구 세운3-8구역 재개발', ['세운3-8', '세운3-9', '세운3-10'], []],
    ['마포로1구역 제8지구', '재개발', '중구', '중구 마포로1구역 제8지구 재개발', ['마포로1구역제8지구'], []],
    ['반포주공1단지(1,2,4주구)', '재건축', '서초구', '서초 반포주공1단지 재건축', ['반포주공1단지'], ['124주구']],
    ['은마', '재건축', '강남구', '강남 은마아파트 재건축', ['은마아파트', '은마재건축'], []],
    ['수표', '재개발', '중구', '중구 수표 재개발', ['수표구역'], []],
    ['을지로3가', '재개발', '중구', '중구 을지로3가 재개발', ['을지로3가'], []],
    ['신반포4지구', '재건축', '서초구', '서초 신반포4지구 재건축', ['신반포4지구'], []],
    ['반포미도2차', '재건축', '서초구', '서초 반포미도2차 재건축', ['반포미도2차'], []],
  ];
  for (const [name, kind, district, query, keys, extras] of cases) {
    const project = seoul({ name, kind, district });
    assert.equal(newsQuery(project), query, name);
    assert.deepEqual(seoulNewsName(project).keys, keys, name);
    assert.deepEqual(seoulNewsName(project).extras, extras, name);
  }
  assert.equal(seoulNewsName(seoul({ name: '  ' })), null);
  assert.equal(seoulNewsName(seoul({ name: '(1,2주구)' })), null);
});

test('Seoul relevance table (positives and negatives)', () => {
  const at = (name, kind, district) => seoul({ name, kind, district });
  const cases = [
    // [사업, 제목, 남기는지]
    [at('세운3-8,9,10', '재개발', '중구'), '세운3-8구역 재개발 분양 일정', true],
    [at('세운3-8,9,10', '재개발', '중구'), '세운 3-10구역 착공', true],
    [at('세운3-8,9,10', '재개발', '중구'), '세운3-8·9·10구역 통합 개발', true],
    [at('세운3-8,9,10', '재개발', '중구'), '세운3-1구역 시공사 선정', false],
    [at('세운3-8,9,10', '재개발', '중구'), '세운3-80 상가', false],
    [at('세운3-8,9,10', '재개발', '중구'), '세운3구역 재개발', false],
    [at('마포로1구역 제8지구', '재개발', '중구'), '마포로1구역 제8지구 재개발 착공', true],
    [at('마포로1구역 제8지구', '재개발', '중구'), '마포로1구역 제10지구 정비계획', false],
    [at('반포주공1단지(1,2,4주구)', '재건축', '서초구'), '반포주공1단지 1·2·4주구 재건축 이주', true],
    [at('반포주공1단지(1,2,4주구)', '재건축', '서초구'), '반포주공1단지 1·2·4주구 공사비 협상', true], // 괄호 안이 문맥
    [at('반포주공1단지(1,2,4주구)', '재건축', '서초구'), '반포주공1단지 매매가 신고가', false],
    [at('은마', '재건축', '강남구'), '은마아파트 49층 재건축 확정', true],
    [at('은마', '재건축', '강남구'), '은마 재건축 조합 설립', true],
    [at('은마', '재건축', '강남구'), '대치 은마아파트 상가 화재', false],
    [at('은마', '재건축', '강남구'), '은마 프로젝트 공개', false],
    [at('을지로3가', '재개발', '중구'), '을지로3가역 상권 살아난다', false],
    [at('을지로3가', '재개발', '중구'), '을지로3가 구역 재개발 사업시행인가', true],
    [at('한남3', '재개발', '용산구'), '한남뉴타운 3구역 이주 마무리', true],
    [at('한남3', '재개발', '용산구'), '한남재정비촉진지구 3구역 관리처분', true],
    [at('한남3', '재개발', '용산구'), '한남3구역 현대건설', true], // 숫자로 끝나는 key는 문맥 없이도
    [at('한남3', '재개발', '용산구'), '한남뉴타운 4구역 시공사', false],
    [at('한남3', '재개발', '용산구'), '한남30 빌딩', false],
    [at('신영1', '재개발', '종로구'), '종로구 신영1구역 분양', true],
    [at('신영1', '재개발', '종로구'), '마포구 신영1구역 재개발', false],
    [at('신길2', '재개발', '영등포구'), '신길뉴타운 2구역 관리처분', true],
    [at('신길2', '재개발', '영등포구'), '신길2차 아파트 리모델링', false],
    [at('신당1', '재개발', '중구'), '신당10구역 시공사 선정', false],
    [at('신당1', '재개발', '중구'), '서울 성동구·중구 재개발 신당1구역 포함', true], // 사업의 구도 있으면 남긴다
    [at('신반포4지구', '재건축', '서초구'), '신반포4지구 재건축 분양 일정', true],
    [at('신반포4지구', '재건축', '서초구'), '신반포4지구 상가 화재', false],
    [at('반포미도2차', '재건축', '서초구'), '반포 미도2차 재건축 속도', true],
    [at('반포미도2차', '재건축', '서초구'), '반포미도2차 매매 거래', false],
    [at('반포미도2차', '재건축', '서초구'), '반포미도1차 재건축', false],
  ];
  for (const [project, title, expected] of cases) {
    assert.equal(relevant(item({ title }), project), expected, `${project.name}: ${title}`);
  }
});

test('title normalisation and other-district check', () => {
  assert.equal(normalizeNewsTitle('한남뉴타운 3구역'), '한남3구역');
  assert.equal(normalizeNewsTitle('노량진 재정비촉진구역 8구역'), '노량진8구역');
  assert.equal(normalizeNewsTitle('한남 재정비촉진지구 3구역'), '한남3구역');
  assert.equal(namesOtherDistrict('성동구 신당1구역', '중구'), true);
  assert.equal(namesOtherDistrict('중구 신당1구역', '중구'), false);
  assert.equal(namesOtherDistrict('성동구·중구 재개발', '중구'), false);
  assert.equal(namesOtherDistrict('[동대문구] 청량리 재개발', '중구'), true);
  // 낱말 중간의 '중구'(집중구역)는 구가 아니다.
  assert.equal(namesOtherDistrict('정비 집중구역 지정', '종로구'), false);
  assert.equal(namesOtherDistrict('신영1구역 착공', '종로구'), false);
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

// --- 시간 한도: 네이버가 느리거나 막혀도 지도 빌드(작업 15분)를 넘기지 않는다 ---

const timeoutError = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });

test('client aborts a slow call after timeoutMs (default 10s) and retries once', async () => {
  assert.equal(NEWS_TIMEOUT_MS, 10000);
  const signals = [];
  const hanging = async (url, init) => {
    signals.push(init.signal);
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  };
  await assert.rejects(createNewsClient({ fetch: hanging, env, sleep: noSleep, timeoutMs: 20 }).search('하남교산'), { kind: 'news_timeout' });
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal instanceof AbortSignal && signal.aborted));
});

test('collectNews stops after 2 consecutive timeouts', async () => {
  const { fetch, calls } = fakeFetch(() => { throw timeoutError(); });
  const result = await collectNews({
    projects: [town(), seoul(), seoul({ id: 'seoul-2', name: '신당1' }), seoul({ id: 'seoul-3', name: '한남3' })],
    client: createNewsClient({ fetch, env, sleep: noSleep }),
    today,
    sleep: noSleep,
  });
  assert.equal(result.stopped, 'news_timeout');
  assert.equal(result.checked, 2);
  assert.deepEqual(result.errors, ['news_timeout']);
  assert.equal(result.failed, 2);
  // 사업마다 한 번 재시도: 2사업 x 2번
  assert.equal(calls.length, 4);
  assert.deepEqual(result.byId, {});
});

test('collectNews network streak resets on success; network errors count too', async () => {
  // 시간 초과, 성공, 네트워크 오류, 성공: 연달아 2번이 아니므로 끝까지 간다.
  const plan = { 하남교산: 'timeout', '종로 신영1구역 재개발': 'ok', '중구 신당1구역 재개발': 'network', '용산 한남3구역 재개발': 'ok' };
  const { fetch } = fakeFetch((url) => {
    const step = plan[url.searchParams.get('query')];
    if (step === 'timeout') throw timeoutError();
    if (step === 'network') throw new TypeError('fetch failed');
    return Response.json(okBody([raw({ title: '한남3구역 관리처분 인가', originallink: 'https://www.yna.co.kr/h3' })]));
  });
  const projects = [town(), seoul(), seoul({ id: 'seoul-2', name: '신당1', district: '중구' }), seoul({ id: 'seoul-3', name: '한남3', district: '용산구' })];
  const result = await collectNews({ projects, client: createNewsClient({ fetch, env, sleep: noSleep }), today, sleep: noSleep });
  assert.equal(result.stopped, null);
  assert.equal(result.checked, 4);
  assert.deepEqual(result.errors, ['news_timeout', 'news_network']);
  assert.deepEqual(Object.keys(result.byId), ['seoul-3']);

  // 네트워크 오류 2번 연달아면 news_network로 멈춘다.
  const down = fakeFetch(() => { throw new TypeError('fetch failed'); });
  const stopped = await collectNews({ projects, client: createNewsClient({ fetch: down.fetch, env, sleep: noSleep }), today, sleep: noSleep });
  assert.equal(stopped.stopped, 'news_network');
  assert.equal(stopped.checked, 2);
});

test('collectNews stops at the time budget and keeps what it collected', async () => {
  assert.equal(NEWS_BUDGET_MS, 480000);
  let clock = 0;
  // 호출마다 170초가 걸리는 것처럼 시계를 민다.
  const { fetch, calls } = fakeFetch(() => {
    clock += 170000;
    return Response.json(okBody([raw({ title: '하남교산 본청약' }), raw({ title: '신영1구역 착공', originallink: 'https://www.yna.co.kr/s1' })]));
  });
  const projects = [town(), seoul(), seoul({ id: 'seoul-2', name: '신당1', district: '중구' }), seoul({ id: 'seoul-3', name: '한남3', district: '용산구' })];
  const result = await collectNews({
    projects, client: createNewsClient({ fetch, env, sleep: noSleep }), today, sleep: noSleep, now: () => clock,
  });
  // 0초, 170초, 340초에 검색하고 510초(8분 넘음)에 멈춘다.
  assert.equal(result.stopped, 'news_budget');
  assert.equal(result.checked, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(Object.keys(result.byId).sort(), ['seoul-1441', 'town-hanam-gyosan']);
  assert.deepEqual(result.errors, []);

  // budgetMs로 줄일 수 있다.
  clock = 0;
  const short = await collectNews({
    projects, client: createNewsClient({ fetch, env, sleep: noSleep }), today, sleep: noSleep, now: () => clock, budgetMs: 60000,
  });
  assert.equal(short.stopped, 'news_budget');
  assert.equal(short.checked, 1);
});
