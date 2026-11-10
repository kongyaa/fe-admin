import { AppError, addDays, defaultSleep, fetchWithRetry, kstToday, safeError, safeHttpUrl } from '../util.js';
import { compact, containsToken, zoneKey } from './link-notices.js';

// 분양 예정 지도 사업별 최근 뉴스. 네이버 뉴스 검색 API(공식)만 쓴다.
// 약관(2026-09 개정 보도 기준): 출처와 원문 링크 표시, 서버 보관 21일 이내, AI 학습·답변 생성·재판매 금지.
// 그래서 제목(태그·엔티티 제거), 언론사, 날짜(YYYY-MM-DD), 링크만 남기고 요약(description)과 본문은 저장하지 않는다.

export const NEWS_ENDPOINTS = {
  // 네이버 API 허브(NCP API Gateway)
  hub: {
    url: 'https://naverapihub.apigw.ntruss.com/search/v1/news',
    headers: (id, secret) => ({ 'X-NCP-APIGW-API-KEY-ID': id, 'X-NCP-APIGW-API-KEY': secret }),
  },
  // 예전 developers.naver.com 키
  legacy: {
    url: 'https://openapi.naver.com/v1/search/news.json',
    headers: (id, secret) => ({ 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret }),
  },
};

export const NEWS_MAX_AGE_DAYS = 21;

// 인증·한도 오류. 다음 사업도 같은 결과일 것이므로 바로 멈춘다(호출을 더 보내지 않는다).
export const NEWS_STOP_KINDS = ['news_http_401', 'news_http_403', 'news_http_429', 'news_no_key', 'news_endpoint'];

// 뉴스를 찾을 서울 사업의 구간(우선순위 순)
const SEOUL_NEWS_BUCKETS = ['live', 'soon', 'mid'];

// 공공주택지구는 모두, 서울 정비사업은 live > soon > mid 순, 같은 구간은 예상 시기 시작이 이른 순으로 maxSeoul개까지.
// projects에는 bucket이 붙어 있어야 한다(bucketOf 뒤, toPublic 전에 부른다).
export function newsTargets(projects, { maxSeoul = 150 } = {}) {
  const towns = projects.filter((project) => project.kind === '공공주택지구');
  const seoul = projects
    .filter((project) => project.region === '서울' && project.kind !== '공공주택지구' && SEOUL_NEWS_BUCKETS.includes(project.bucket))
    .map((project, index) => ({ project, index }))
    .sort((a, b) => SEOUL_NEWS_BUCKETS.indexOf(a.project.bucket) - SEOUL_NEWS_BUCKETS.indexOf(b.project.bucket)
      || String(a.project.window?.from ?? '9999').localeCompare(String(b.project.window?.from ?? '9999'))
      || a.index - b.index)
    .slice(0, Math.max(0, maxSeoul))
    .map(({ project }) => project);
  return [...towns, ...seoul];
}

// '종로구' -> '종로'. 줄이면 한 글자가 되는 '중구'는 그대로 둔다.
export function districtStem(district) {
  const value = compact(district);
  const stem = value.replace(/구$/, '');
  return stem.length >= 2 ? stem : value;
}

// 검색어용 구역명. 숫자로 끝나면 '구역'을 붙인다('신영1' -> '신영1구역', '수송1-2' -> '수송1-2구역').
// '반포미도2차', '개포주공5단지'처럼 단지 이름이거나 이미 '구역'이 있으면 그대로 둔다.
export function zoneName(name) {
  const value = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!value) return null;
  return /\d$/.test(value) && !/구역$/.test(value) ? `${value}구역` : value;
}

// 공공주택지구: 이름('하남교산'). 서울: '<구 줄임> <구역명> <재개발|재건축>' ('종로 신영1구역 재개발').
export function newsQuery(project) {
  const name = String(project?.name ?? '').trim();
  if (!name) return null;
  if (project.kind === '공공주택지구') return name;
  const parts = [project.district ? districtStem(project.district) : null, zoneName(name)];
  if (project.kind === '재개발' || project.kind === '재건축') parts.push(project.kind);
  return parts.filter(Boolean).join(' ');
}

const NAMED_ENTITIES = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ', middot: '·', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// 응답 제목의 <b> 같은 태그를 지우고 엔티티(&quot;, &amp; …)를 푼다. 공백은 하나로.
export function cleanTitle(value) {
  const stripped = String(value ?? '').replace(/<\/?[a-z][^>]*>/gi, '');
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}

// RFC 1123 날짜('Tue, 10 Nov 2026 09:30:00 +0900')를 한국 날짜 YYYY-MM-DD로. 읽지 못하면 null.
export function newsDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const time = Date.parse(text);
  return Number.isNaN(time) ? null : kstToday(new Date(time));
}

// 원문 주소의 호스트 -> 언론사 이름. 하위 도메인까지 맞춰 보고, 더 긴(구체적인) 도메인을 먼저 본다.
export const KNOWN_OUTLETS = {
  'yna.co.kr': '연합뉴스',
  'newsis.com': '뉴시스',
  'news1.kr': '뉴스1',
  'chosun.com': '조선일보',
  'biz.chosun.com': '조선비즈',
  'joongang.co.kr': '중앙일보',
  'donga.com': '동아일보',
  'hani.co.kr': '한겨레',
  'khan.co.kr': '경향신문',
  'hankookilbo.com': '한국일보',
  'seoul.co.kr': '서울신문',
  'kmib.co.kr': '국민일보',
  'segye.com': '세계일보',
  'munhwa.com': '문화일보',
  'hankyung.com': '한국경제',
  'mk.co.kr': '매일경제',
  'mt.co.kr': '머니투데이',
  'news.mtn.co.kr': '머니투데이방송',
  'edaily.co.kr': '이데일리',
  'sedaily.com': '서울경제',
  'fnnews.com': '파이낸셜뉴스',
  'asiae.co.kr': '아시아경제',
  'heraldcorp.com': '헤럴드경제',
  'etoday.co.kr': '이투데이',
  'ajunews.com': '아주경제',
  'dt.co.kr': '디지털타임스',
  'newspim.com': '뉴스핌',
  'dailian.co.kr': '데일리안',
  'newdaily.co.kr': '뉴데일리',
  'bizwatch.co.kr': '비즈워치',
  'dnews.co.kr': '대한경제',
  'nocutnews.co.kr': '노컷뉴스',
  'kbs.co.kr': 'KBS',
  'imbc.com': 'MBC',
  'sbs.co.kr': 'SBS',
  'ytn.co.kr': 'YTN',
  'jtbc.co.kr': 'JTBC',
  'mbn.co.kr': 'MBN',
  'kyeongin.com': '경인일보',
  'kyeonggi.com': '경기일보',
  'joongboo.com': '중부일보',
  'housingherald.co.kr': '하우징헤럴드',
  'news.naver.com': '네이버 뉴스',
};

const OUTLET_DOMAINS = Object.keys(KNOWN_OUTLETS).sort((a, b) => b.length - a.length);

// 알려진 언론사면 이름, 아니면 'www.'·'m.'을 뗀 호스트 이름
export function outletOf(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const domain = OUTLET_DOMAINS.find((known) => host === known || host.endsWith(`.${known}`));
  if (domain) return KNOWN_OUTLETS[domain];
  return host.replace(/^(www|m|mobile)\./, '') || null;
}

// 응답 항목 하나를 저장 형태로. 저장하는 값은 제목, 언론사, 날짜, 링크뿐이다(description은 버린다).
// 링크는 원문(originallink)이 http(s)면 원문, 아니면 네이버 뉴스 링크(link). 제목이나 링크가 없으면 null.
export function normalizeItem(item) {
  if (!item || typeof item !== 'object') return null;
  const title = cleanTitle(item.title);
  const original = safeHttpUrl(item.originallink);
  const url = original ?? safeHttpUrl(item.link);
  if (!title || !url) return null;
  return { title, outlet: outletOf(url), date: newsDate(item.pubDate), url };
}

// 서울: 구역명에서 '구역'과 공백을 뺀 값('신영1'). 3글자 미만이면 오탐이 많아 '<이름>구역'으로만 찾는다('명동' -> '명동구역').
function seoulKeys(project) {
  const key = zoneKey(project.name);
  if (key) return [key];
  const name = compact(project.name).replace(/구역$/, '');
  return name ? [`${name}구역`] : [];
}

function townKeys(project) {
  return [project.name, ...(project.noticeMatch ?? [])].map(compact).filter((key) => key.length >= 2);
}

// 제목(공백 제거)에 사업 이름이 있어야 남긴다. 숫자로 끝나는 이름 뒤에 숫자·차·단지·동·가가 이어지면 다른 것으로 본다
// (신당1 ≠ 신당10, 신길2 ≠ 신길2차). 서울은 제목에 구가 거의 없어 구는 보지 않는다.
export function relevant(item, project) {
  const title = compact(cleanTitle(item?.title));
  if (!title || !project) return false;
  const keys = project.kind === '공공주택지구' ? townKeys(project) : seoulKeys(project);
  return keys.some((key) => containsToken(title, key));
}

// 비교용 제목: 공백·따옴표·문장부호를 빼고 소문자로
function titleKey(title) {
  return String(title ?? '').toLowerCase().replace(/[\s"'“”‘’`.,·…!?:;~\-–—[\](){}<>『』「」【】]/g, '');
}

// 같은 링크이거나 같은 제목이면 처음 것만 남긴다(응답 순서 = 최신순).
export function dedupe(items) {
  const urls = new Set();
  const titles = new Set();
  const result = [];
  for (const item of items) {
    const key = titleKey(item.title);
    if (urls.has(item.url) || (key && titles.has(key))) continue;
    urls.add(item.url);
    if (key) titles.add(key);
    result.push(item);
  }
  return result;
}

// today에서 days일 전(그날 포함)부터 today까지의 기사만. 날짜를 모르면 보관 기간을 지킬 수 없어 뺀다.
export function keepRecent(items, today, days = NEWS_MAX_AGE_DAYS) {
  const cutoff = addDays(today, -days);
  return items.filter((item) => item.date && item.date >= cutoff && item.date <= today);
}

// API 범위(display 1~100, start 1~1000)로 자른다. 숫자가 아니면 기본값.
function clampInt(value, min, max, fallback) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

// 네이버 뉴스 검색 클라이언트. 키는 헤더로만 보내고 로그를 남기지 않는다. 오류는 고정 kind뿐이다.
// endpoint: 'hub'(기본) | 'legacy'. 없으면 env.NAVER_NEWS_ENDPOINT.
export function createNewsClient({ fetch = globalThis.fetch, env = process.env, sleep = defaultSleep, endpoint } = {}) {
  const id = String(env.NAVER_CLIENT_ID ?? '').trim();
  const secret = String(env.NAVER_CLIENT_SECRET ?? '').trim();
  const name = String(endpoint ?? env.NAVER_NEWS_ENDPOINT ?? '').trim().toLowerCase() || 'hub';
  const target = Object.hasOwn(NEWS_ENDPOINTS, name) ? NEWS_ENDPOINTS[name] : null;

  async function search(query, { display = 20, sort = 'date', start = 1 } = {}) {
    if (!target) throw new AppError('news_endpoint');
    if (!id || !secret) throw new AppError('news_no_key');
    const params = new URLSearchParams({
      query: String(query ?? ''),
      display: String(clampInt(display, 1, 100, 20)),
      start: String(clampInt(start, 1, 1000, 1)),
      sort: sort === 'sim' ? 'sim' : 'date',
    });
    const response = await fetchWithRetry(fetch, `${target.url}?${params}`, {
      headers: { ...target.headers(id, secret), Accept: 'application/json' },
    }, { kind: 'news', retries: 1, sleep });
    let body;
    try {
      body = await response.json();
    } catch {
      throw new AppError('news_parse');
    }
    if (!body || typeof body !== 'object' || !Array.isArray(body.items)) throw new AppError('news_parse');
    return { total: Number(body.total) || 0, items: body.items };
  }

  return { endpoint: name, search };
}

const newestFirst = (a, b) => b.date.localeCompare(a.date);

// 사업마다 한 번씩 차례로 검색한다. projects는 newsTargets()의 결과를 넘긴다.
// byId: { [사업 id]: [{ title, outlet, date, url }] } (기사가 있는 사업만). checked: 검색한 사업 수, matched: 기사가 남은 사업 수.
// 사업 하나의 실패는 errors에 kind만 남기고 넘어간다. 인증·한도 오류(NEWS_STOP_KINDS)면 stopped에 kind를 두고 멈춘다.
export async function collectNews({
  projects,
  client,
  today,
  limitPerProject = 5,
  display = 20,
  delayMs = 200,
  sleep = defaultSleep,
}) {
  const byId = {};
  const errors = [];
  let checked = 0;
  let matched = 0;
  let stopped = null;
  for (const project of projects ?? []) {
    const query = newsQuery(project);
    if (!project?.id || !query) continue;
    if (checked > 0) await sleep(delayMs);
    checked += 1;
    let items;
    try {
      ({ items } = await client.search(query, { display, sort: 'date' }));
    } catch (error) {
      const kind = safeError(error);
      errors.push(kind);
      if (NEWS_STOP_KINDS.includes(kind)) {
        stopped = kind;
        break;
      }
      continue;
    }
    const kept = dedupe(keepRecent(
      items.map(normalizeItem).filter((item) => item && relevant(item, project)),
      today,
    )).sort(newestFirst).slice(0, limitPerProject);
    if (kept.length === 0) continue;
    byId[project.id] = kept;
    matched += 1;
  }
  return { byId, checked, matched, errors: [...new Set(errors)], failed: errors.length, stopped };
}
