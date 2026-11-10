// 분양 예정 지도 — 정적 사이트 스크립트 (프레임워크·빌드 단계 없음)
// projects.json 하나만 읽어 화면을 그린다. JSON 문자열은 모두 textContent 로 넣고 innerHTML 은 쓰지 않는다.
// 위쪽의 순수 함수는 export 해 두어 node --test 로 검사할 수 있다(DOM 이 없으면 화면 코드는 실행하지 않음).
// 화면: 첫 화면(요약판·새 소식·신도시·서울 요약·전체 사업), 지구 화면(#t=, 블록별 현황과 블록별 소식), 사업 화면(#p=).

export const PAGE_SIZE = 50;
export const FEED_PAGE = 30;

export const DEFAULT_STAGES = {
  seoul: ['구역지정', '추진위', '조합설립', '건축심의', '사업시행인가', '관리처분인가', '이주', '착공', '일반분양'],
  town: ['후보지', '지구지정', '지구계획승인', '부지조성 착공', '블록별 분양', '준공'],
};

// 정렬 순서이기도 하다: 공고 중 → 1년 안 → 3년 안 → 3년 뒤·미정 → 공고 있었음 → 예상 지남 → 분양했을 가능성 → 준공
// 파이프라인(src/pipeline/expected-window.js)의 BUCKETS와 같게 둔다.
export const BUCKET_ORDER = ['live', 'soon', 'mid', 'far', 'announced', 'overdue', 'likely_sold', 'done'];
export const BUCKET_INFO = {
  live: { label: '공고 중', cls: 'c-live' },
  soon: { label: '1년 안', cls: 'c-soon' },
  mid: { label: '3년 안', cls: 'c-mid' },
  far: { label: '3년 뒤·미정', cls: 'c-far' },
  announced: { label: '공고 있었음', cls: 'c-ann' },
  overdue: { label: '예상 지남', cls: 'c-over' },
  likely_sold: { label: '분양했을 가능성', cls: 'c-sold' },
  done: { label: '준공', cls: 'c-done' },
};

// 이 단계에서 예상 시기가 지났으면 지연이 아니라 이미 분양했을 가능성으로 본다(파이프라인과 같은 목록)
export const LIKELY_SOLD_STAGES = ['이주', '착공', '일반분양'];
const STATUS_BUCKETS = ['done', 'announced', 'likely_sold', 'overdue'];

/** 한국 시간 기준 오늘 날짜 'YYYY-MM-DD' */
export function kstYmd(date = new Date()) {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 'YYYY-MM', 'YYYY-MM-DD' 등에서 'YYYY-MM' 만 뽑는다. 형식이 아니면 null */
export function toYm(value) {
  const m = /^(\d{4})-(\d{1,2})(?!\d)/.exec(String(value ?? '').trim());
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${m[1]}-${String(month).padStart(2, '0')}`;
}

/** a 에서 b 까지 몇 달인지(b - a). 둘 중 하나라도 날짜가 아니면 null */
export function monthsBetween(a, b) {
  const x = toYm(a);
  const y = toYm(b);
  if (!x || !y) return null;
  return (Number(y.slice(0, 4)) - Number(x.slice(0, 4))) * 12 + (Number(y.slice(5, 7)) - Number(x.slice(5, 7)));
}

/**
 * 예상 시기 구간: live(공고 중: 마감 전 공고 연결) | soon(12개월 안) | mid(36개월 안) | far(그 뒤·미정)
 * | announced(지난 공고만 연결) | overdue(예상 지남) | likely_sold(분양했을 가능성) | done(준공)
 * todayYm 은 'YYYY-MM' (한국 시간 기준 이번 달)
 */
export function bucketOf(project, todayYm) {
  if (project?.live) return 'live';
  const status = project?.windowStatus;
  if (STATUS_BUCKETS.includes(status)) return status;
  const from = toYm(project?.window?.from);
  if (status === 'far' || !from) return 'far';
  const to = toYm(project?.window?.to) ?? from;
  // 만든 뒤 시간이 지나 범위가 다 지났으면 단계로 가른다
  if (monthsBetween(todayYm, to) < 0) return LIKELY_SOLD_STAGES.includes(project?.stage) ? 'likely_sold' : 'overdue';
  const months = monthsBetween(todayYm, from);
  if (months < 12) return 'soon';
  if (months < 36) return 'mid';
  return 'far';
}

/** 예상 시기 필터('all' | '12' | '36')에 구간이 맞는지 */
export function whenMatches(bucket, when) {
  if (when === '12') return bucket === 'live' || bucket === 'soon';
  if (when === '36') return bucket === 'live' || bucket === 'soon' || bucket === 'mid';
  return true;
}

/** '종로구' → '종로', '하남시' → '하남'. '중구'처럼 두 글자면 그대로 */
export function shortDistrict(district) {
  const s = String(district ?? '');
  return s.length > 2 && /[구시군]$/.test(s) ? s.slice(0, -1) : s;
}

/** 단계 목록 묶음: 공공주택지구는 town, 나머지(재개발·재건축)는 seoul */
export function stageGroup(project) {
  return project?.kind === '공공주택지구' ? 'town' : 'seoul';
}

/** 검색용 정규화: 소문자, 공백 제거 */
export function normalizeText(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, '');
}

/**
 * 검색 대상 글자(정규화한 값): 이름·주소·도로명주소에 구 이름('강남구'와 '강남')과 세부 유형까지.
 * 주소가 '일원동615-1'처럼 구 없이 오므로 구 이름을 따로 넣는다.
 */
export function searchText(project) {
  const p = project ?? {};
  return normalizeText([p.name, p.address, p.roadAddress, p.district, shortDistrict(p.district), p.subKind].filter(Boolean).join(' '));
}

/**
 * 필터에 맞는지. filters = { area, kind, stage('seoul:이주' 형식 또는 ''), when, district, q }
 * bucket·검색 글자(searchText)를 미리 계산해 두었으면 넘겨서 다시 계산하지 않는다.
 */
export function matchesFilters(project, filters, todayYm, bucket = bucketOf(project, todayYm), hay = null) {
  const f = filters ?? {};
  if (f.area && f.area !== 'all' && project.region !== f.area) return false;
  if (f.kind && f.kind !== 'all' && project.kind !== f.kind) return false;
  if (f.district && project.district !== f.district) return false;
  if (f.stage) {
    const cut = f.stage.indexOf(':');
    if (stageGroup(project) !== f.stage.slice(0, cut) || project.stage !== f.stage.slice(cut + 1)) return false;
  }
  if (!whenMatches(bucket, f.when)) return false;
  if (f.q) {
    const q = normalizeText(f.q);
    if (!(hay ?? searchText(project)).includes(q)) return false;
  }
  return true;
}

export const DEFAULT_FILTERS = Object.freeze({ area: 'all', kind: 'all', stage: '', when: 'all', district: null, q: '' });
// 폭에 따라 저절로 접고 펴는 <details class="fold auto"> 의 id(index.html). 휴대폰 폭에서만 접는다(initFolds)
export const AUTO_FOLD_IDS = Object.freeze(['disclaimer', 'filters-box']);
// 경기는 공공주택지구뿐이라 지역이 경기면 유형(재개발·재건축) 필터는 쓸 수 없다
export const TOWN_AREA = '경기';

/** 유형 필터를 쓸 수 없는지(지역이 경기) */
export function kindLocked(filters) {
  return filters?.area === TOWN_AREA;
}

/**
 * 필터 하나를 바꾼 새 필터. 지역을 경기로 바꾸면 서울 구 선택과 유형을 풀고,
 * 경기만 보는 중에 서울 구를 고르면 지역을 전체로 되돌린다. 유형이 잠겨 있으면 유형은 바꾸지 않는다.
 */
export function nextFilters(filters, key, value) {
  const next = { ...DEFAULT_FILTERS, ...filters };
  if (key === 'kind' && kindLocked(next)) return next;
  next[key] = value;
  if (key === 'area' && value === TOWN_AREA) {
    next.district = null;
    next.kind = 'all';
  }
  if (key === 'district' && value && next.area === TOWN_AREA) next.area = 'all';
  return next;
}

const stageName = (stage) => String(stage ?? '').slice(String(stage ?? '').indexOf(':') + 1);

/** 필터 상자 안의 조건(지역·유형·시기·단계·검색어) 중 기본값이 아닌 수. 구 선택은 지도에서 하므로 세지 않는다 */
export function activeFilterCount(filters) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  return [f.area !== 'all', f.kind !== 'all', f.when !== 'all', Boolean(f.stage), Boolean(f.q)].filter(Boolean).length;
}

/** 좁은 화면에서 접힌 필터 상자의 제목 */
export function filterSummary(filters) {
  const n = activeFilterCount(filters);
  return n ? `필터 (${n}개 적용)` : '필터';
}

/** 지금 걸린 조건을 사람이 읽는 말로: ['서울', '1년 안', '단계 이주', '강남구', '검색 ‘개포’'] */
export function filterConditions(filters) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  const out = [];
  if (f.area !== 'all') out.push(f.area === TOWN_AREA ? '경기 공공주택지구' : f.area);
  if (f.kind !== 'all') out.push(f.kind);
  if (f.when === '12') out.push('1년 안');
  else if (f.when === '36') out.push('3년 안');
  if (f.stage) out.push(`단계 ${stageName(f.stage)}`);
  if (f.district) out.push(f.district);
  if (f.q) out.push(`검색 ‘${f.q}’`);
  return out;
}

/**
 * 결과가 없을 때 한 곳에만 보여 줄 안내: { title, conditions, clearQuery(검색어 지우기 버튼), reset(필터 초기화 버튼) }.
 * 검색어만 걸려 있으면 초기화 버튼 없이 검색어 지우기만 둔다.
 */
export function emptyState(filters) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  const conditions = filterConditions(f);
  const others = conditions.length - (f.q ? 1 : 0);
  let title = '표시할 사업이 없습니다.';
  if (f.q) title = `‘${f.q}’에 맞는 사업이 없습니다.`;
  else if (conditions.length) title = '지금 조건에 맞는 사업이 없습니다.';
  return { title, conditions, clearQuery: Boolean(f.q), reset: others > 0 };
}

/** 목록 순서: 구간(공고 중 먼저), 예상 시작 달, 이름 */
export function compareProjects(a, b, todayYm) {
  const ra = BUCKET_ORDER.indexOf(bucketOf(a, todayYm));
  const rb = BUCKET_ORDER.indexOf(bucketOf(b, todayYm));
  if (ra !== rb) return ra - rb;
  const fa = toYm(a.window?.from);
  const fb = toYm(b.window?.from);
  if (fa !== fb) {
    if (!fa) return 1;
    if (!fb) return -1;
    return fa < fb ? -1 : 1;
  }
  return String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ko');
}

export function sortProjects(projects, todayYm) {
  return [...projects].sort((a, b) => compareProjects(a, b, todayYm));
}

/** http(s) 주소만 통과시킨다. 그 밖(javascript:, data: 등)은 null */
export function safeHttpUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** 'YYYY-MM~YYYY-MM' (같으면 한 번만). 예상 범위가 없으면 null */
export function windowRange(project) {
  const from = toYm(project?.window?.from);
  if (!from) return null;
  const to = toYm(project?.window?.to) ?? from;
  return from === to ? from : `${from}~${to}`;
}

/** 연결된 공고 중 가장 늦은 공고일의 'YYYY-MM'. 없으면 null */
export function latestAnnounce(project) {
  const months = (Array.isArray(project?.notices) ? project.notices : []).map((n) => toYm(n?.announceDate)).filter(Boolean);
  return months.length ? months.sort().at(-1) : null;
}

/** 읽을 자료 파일: 주소에 ?sample=1 이 있으면 예시 자료, 아니면 projects.json */
export function dataFile(search) {
  return new URLSearchParams(String(search ?? '')).get('sample') === '1' ? 'sample-projects.json' : 'projects.json';
}

/**
 * 목록·상세·타임라인에 보여 줄 예상 범위. 1년 안·3년 안인데 시작 달이 이번 달보다 앞이면(이미 시작된 범위)
 * 지난 시작 달 대신 '지금~끝 달'로 보여 준다(자료는 그대로, 보이는 말만). 범위가 없으면 null
 */
export function windowRangeLabel(project, todayYm) {
  const range = windowRange(project);
  if (!range) return null;
  const bucket = bucketOf(project, todayYm);
  const from = toYm(project.window.from);
  const now = toYm(todayYm);
  if ((bucket === 'soon' || bucket === 'mid') && now && from < now) return `지금~${toYm(project.window.to) ?? from}`;
  return range;
}

/** 상세·목록에 보여줄 예상 청약 문구 */
export function windowLabel(project, todayYm) {
  const bucket = bucketOf(project, todayYm);
  const range = windowRangeLabel(project, todayYm);
  if (bucket === 'done') return '준공';
  if (bucket === 'overdue') return range ? `${range} (지남)` : '예상 지남';
  if (bucket === 'likely_sold') return range ? `${range} (지남, 분양했을 가능성)` : '분양했을 가능성';
  if (bucket === 'announced') {
    const latest = latestAnnounce(project);
    return latest ? `공고 있었음(${latest})` : '공고 있었음';
  }
  if (bucket === 'live') return range ?? '공고 중';
  return range ?? '3년 뒤·미정';
}

// --- 블록별 분양 지구 ---------------------------------------------------------

export const DEFAULT_WINDOW_LABEL = '예상 청약';
// 사전청약은 본청약 전 예약이라 최근 분양에 세지 않는다(파이프라인 PRE_SUBSCRIPTION 과 같은 값)
export const PRE_SUBSCRIPTION = '사전청약';

/** 예상 기간의 이름. 블록별 분양 지구는 projects.json 의 windowLabel('다음 블록 예상'), 그 밖은 '예상 청약' */
export function windowFactLabel(project) {
  const label = typeof project?.windowLabel === 'string' ? project.windowLabel.trim() : '';
  return label || DEFAULT_WINDOW_LABEL;
}

/** 목록·타임라인의 짧은 접두어: 기본은 '예상', 블록별 분양 지구는 '다음 블록 예상' */
export function windowPrefix(project) {
  const label = windowFactLabel(project);
  return label === DEFAULT_WINDOW_LABEL ? '예상' : label;
}

const entriesOf = (list) => (Array.isArray(list) ? list : []).filter((e) => e && typeof e === 'object' && !Array.isArray(e));

/** 'A-1', 'A1BL', 'A1블록' → 'A1' (비교용). 글자와 숫자 사이 '-'만 빼서 'A2-1'과 'A21'은 다르게 둔다. 파이프라인 blockKey 와 같게 둔다 */
export function blockKey(value) {
  return String(value ?? '').toUpperCase().replace(/\s+/g, '').replace(/(BL|블록)$/, '').replace(/(?<=[A-Z])-(?=\d)/g, '');
}

/** 출처를 낸 곳: outlet, 없으면 제목 끝 괄호, 없으면 주소의 호스트(파이프라인 sourceOutlet 과 같은 규칙) */
export function sourceOutlet(source) {
  if (source?.outlet) return String(source.outlet);
  const paren = /\(([^()]+)\)\s*$/.exec(String(source?.title ?? ''));
  if (paren) return paren[1].trim();
  const url = safeHttpUrl(source?.url);
  return url ? new URL(url).hostname.replace(/^(www|m)\./, '') : '출처';
}

// --- 관련 소식(네이버 뉴스 검색) ---
export const NEWS_LIMIT = 5;
// 파이프라인은 빌드 날 기준 14일 안의 기사만 싣는다(src/pipeline/news.js NEWS_PUBLISH_DAYS).
// 빌드가 멈춰 예전 배포가 오래 남더라도 약관의 보관 한도(21일)가 지난 기사는 화면에 보이지 않게 한 번 더 거른다.
export const NEWS_SHOW_DAYS = 21;
export const NEWS_NOTE = '네이버 뉴스 검색 결과에서 제목에 사업명이 들어간 최근 2주 기사만 보여 줍니다. 출처: 각 언론사';
export const NEWS_CREDIT = '검색: NAVER';

/** 'YYYY-MM-DD' 에서 days 일 전 날짜. 형식이 아니면 null */
export function ymdDaysBefore(ymd, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? '').trim());
  if (!m) return null;
  const time = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - days * 24 * 60 * 60 * 1000;
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
}

/**
 * 사업의 관련 소식: [{ title, outlet, date, url }] 최신순 NEWS_LIMIT 건.
 * 제목이 있고 주소가 http(s)인 것만, 날짜가 today 기준 NEWS_SHOW_DAYS 일 안(그날 포함, 미래 제외)인 것만 남긴다.
 * news 가 없거나 배열이 아니면 빈 배열
 */
export function newsItems(project, today) {
  const cutoff = ymdDaysBefore(today, NEWS_SHOW_DAYS);
  if (!cutoff) return [];
  return entriesOf(project?.news).flatMap((n) => {
    const title = textOrNull(n.title);
    const url = safeHttpUrl(n.url);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(n.date ?? '')) ? n.date : null;
    if (!title || !url || !date || date < cutoff || date > today) return [];
    return [{ title, outlet: textOrNull(n.outlet), date, url }];
  }).sort((a, b) => b.date.localeCompare(a.date)).slice(0, NEWS_LIMIT);
}

/** 관련 소식 한 줄의 덧말: '언론사 · 날짜'(없는 값은 뺀다) */
export function newsMetaText(item) {
  return [item?.outlet, item?.date].filter(Boolean).join(' · ');
}

// 비교용 이름: 공백·가운뎃점과 글자-숫자 사이 '-'를 뺀다(blockKey 와 같은 '-' 규칙)
const compactName = (value) => String(value ?? '').toUpperCase().replace(/[\s·]/g, '').replace(/(?<=[A-Z])-(?=\d)/g, '');

/** 공고명에 블록 이름이 있는지. 'A2'는 '…(A-2BL)'에 맞고 'A20'·'BA2'·'A2-1'에는 맞지 않는다 */
export function nameHasBlock(name, block) {
  const key = blockKey(block);
  if (key.length < 2) return false;
  const hay = compactName(name);
  for (let i = hay.indexOf(key); i >= 0; i = hay.indexOf(key, i + 1)) {
    const after = hay.slice(i + key.length);
    if (!/[0-9A-Z]/.test(hay[i - 1] ?? '') && !/^-?\d/.test(after)) return true;
  }
  return false;
}

// 연결된 청약홈 공고 중 임대(typeLabel)와 아파트 분양이 아닌 유형. 분양 이력에는 보이지만 최근 분양에는 세지 않는다.
export const RENTAL_NOTICE_TYPES = ['민간임대', '공공지원민간임대'];

/**
 * 임대 공고인지(사이트 어디서나 이 규칙 하나): 청약홈 임대 유형이거나, 유형·공고명에 '임대'·'행복주택'이 있는 공고.
 * 파이프라인 expected-window.js isRentalNotice 와 같은 규칙
 */
export function isRentalNotice(notice) {
  return RENTAL_NOTICE_TYPES.includes(notice?.typeLabel) || /임대|행복주택/.test(`${notice?.typeLabel ?? ''} ${notice?.name ?? ''}`);
}
export const NON_APT_NOTICE_TYPES = ['도시형생활주택', '오피스텔', '생활숙박시설'];
const NOTICE_PRE_SUBSCRIPTION = '민간사전청약';

/** 같은 공고일인지: 둘 다 일까지 있으면 같은 날, 하나라도 달까지만 있으면 같은 달 */
function sameNoticeDate(a, b) {
  const x = String(a ?? '').trim();
  const y = String(b ?? '').trim();
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (day.test(x) && day.test(y)) return x === y;
  const month = toYm(x);
  return Boolean(month) && month === toYm(y);
}

/**
 * 연결된 청약홈 공고가 yaml 분양 이력의 그 공고인지(중복 판단). 공고일이 같고, 공고명에 블록 이름이나 단지 이름(4글자 이상)이
 * 있을 때만 같다고 본다. 임대 이력은 청약홈 분양 공고와 맞추지 않는다. 애매하면 다른 공고로 두어 둘 다 보인다.
 */
export function isSameSale(entry, notice) {
  if (!entry || !notice || entry.rental === true) return false;
  if (!sameNoticeDate(entry.noticeDate, notice.announceDate)) return false;
  const title = compactName(entry.title);
  return nameHasBlock(notice.name, entry.block) || (title.length >= 4 && compactName(notice.name).includes(title));
}

const countOrNull = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);

/**
 * 상세의 분양 이력: yaml 분양 이력(history)과 연결된 청약홈 공고(notices)를 합쳐 최근 공고 먼저(같은 날이면 이력 먼저).
 * 이력과 같은 공고는 따로 줄을 만들지 않고 그 이력 줄에 청약홈 링크와 마감일을 붙인다.
 * 줄: { date, block, stage, type, title, households, rental, sources: [{ title, url, date, outlet? }], end, from: 'history' | 'notice' }
 */
export function saleHistory(project) {
  const notices = entriesOf(project?.notices);
  const used = new Set();
  const rows = entriesOf(project?.history).map((e) => {
    const sources = entriesOf(e.sources).flatMap((src) => {
      const url = safeHttpUrl(src.url);
      return url ? [{ ...src, url }] : [];
    });
    // 접수 마감: 이력의 end(yaml), 같은 공고로 이어진 청약홈 공고가 있으면 그 마감
    let end = typeof e.end === 'string' && e.end.trim() ? e.end.trim() : null;
    notices.forEach((n, i) => {
      if (used.has(i) || !isSameSale(e, n)) return;
      used.add(i);
      end = n.end ?? end;
      const url = safeHttpUrl(n.url);
      if (url && !sources.some((src) => src.url === url)) sources.push({ title: n.name || '청약홈 공고', url, date: n.announceDate ?? null, outlet: '청약홈' });
    });
    return {
      date: e.noticeDate ?? null, block: e.block ?? null, stage: e.stage ?? null, type: e.type ?? null, title: e.title ?? null,
      households: countOrNull(e.households), rental: e.rental === true, sources, end, from: 'history',
    };
  });
  notices.forEach((n, i) => {
    if (used.has(i)) return;
    const url = safeHttpUrl(n.url);
    const type = n.typeLabel ?? null;
    rows.push({
      date: n.announceDate ?? null,
      block: null,
      stage: type === NOTICE_PRE_SUBSCRIPTION ? PRE_SUBSCRIPTION : null,
      type,
      title: n.name ?? null,
      households: null,
      rental: isRentalNotice(n),
      sources: url ? [{ title: n.name || '청약홈 공고', url, date: n.announceDate ?? null, outlet: '청약홈' }] : [],
      end: n.end ?? null,
      from: 'notice',
    });
  });
  return rows.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
}

/**
 * 최근 분양 'YYYY-MM': 분양 이력과 연결된 공고 중 가장 늦은 공고일. 없으면 null.
 * 임대(이력의 rental, 청약홈 민간임대·공공지원민간임대), 사전청약, 아파트가 아닌 공고(도시형생활주택·오피스텔·생활숙박시설)는 세지 않는다.
 */
export function latestSale(project) {
  const months = saleHistory(project)
    .filter((r) => !r.rental && r.stage !== PRE_SUBSCRIPTION && !(r.from === 'notice' && NON_APT_NOTICE_TYPES.includes(r.type)))
    .map((r) => toYm(r.date)).filter(Boolean);
  return months.length ? months.sort().at(-1) : null;
}

// --- 블록별 현황 ---------------------------------------------------------------

// 블록 상태(정렬 순서). 파이프라인(src/pipeline/blocks.js)의 BLOCK_STATUS_ORDER와 같게 둔다.
export const BLOCK_STATUS_ORDER = [
  '접수 중', '본청약 공고', '임대 공고', '다음 예정(보도)', '예정 지남(보도)', '착공', '사업승인', '계획 보도', '미정',
];
// 칩 색: 사업 목록의 칩(BUCKET_INFO)과 뜻이 같은 상태만 같은 클래스를 쓰고(공고 중·지난 공고·지남·미정),
// 나머지는 블록 전용 클래스(b-*)를 써서 한 색이 두 가지 뜻이 되지 않게 한다.
export const BLOCK_STATUS_CLASS = {
  '접수 중': 'c-live',
  '본청약 공고': 'c-ann',
  '임대 공고': 'c-rent',
  '다음 예정(보도)': 'b-plan',
  '예정 지남(보도)': 'c-over',
  착공: 'b-build',
  사업승인: 'b-appr',
  '계획 보도': 'b-report',
  미정: 'c-far',
};
export const UNKNOWN_BLOCK_TYPE = '유형 미확인';
const BLOCK_LIVE = '접수 중';
const BLOCK_PLANNED = '다음 예정(보도)';
const BLOCK_PLAN_PASSED = '예정 지남(보도)';
// 경과에 유형 이름 그대로 나오는 공고(파이프라인 REMAINDER_NOTICE_TYPES 와 같다). 이름에 '잔여'가 있는 유형도 받는다.
export const REMAINDER_NOTICE_TYPES = ['무순위', '임의공급', '불법행위 재공급'];
const BLOCK_STAGES = [PRE_SUBSCRIPTION, '본청약', BLOCK_LIVE];
const isBlockStage = (stage) => typeof stage === 'string'
  && (BLOCK_STAGES.includes(stage) || REMAINDER_NOTICE_TYPES.includes(stage) || stage.includes('잔여'));

/** 블록별 현황을 보여 줄 사업: 블록별 분양 단계의 공공주택지구 */
export function isBlockTownProject(project) {
  return project?.kind === '공공주택지구' && project?.stage === '블록별 분양';
}

const textOrNull = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const ymdOrNull = (value) => (toYm(value) ? String(value).trim() : null);

function cleanLinks(list) {
  return entriesOf(list).flatMap((src) => {
    const url = safeHttpUrl(src.url);
    return url ? [{ ...src, url }] : [];
  });
}

/**
 * 오늘 기준 상태. 빌드 뒤에 접수 마감(statusDate)이 지났으면 '접수 중'을 분양 줄은 '본청약 공고', 임대 줄은 '임대 공고'로 바꾸고,
 * 날짜는 경과에서 가장 늦은 공고일로 둔다. 빌드 뒤에 계획 기간(plan.to)이 지났으면 '다음 예정(보도)'를 '예정 지남(보도)'로 바꾼다.
 * 모르는 상태는 '미정'.
 */
export function blockStatusNow(row, today) {
  const status = BLOCK_STATUS_ORDER.includes(row?.status) ? row.status : '미정';
  const date = ymdOrNull(row?.statusDate);
  if (status === BLOCK_PLANNED) {
    const to = toYm(row?.plan?.to);
    const passed = to && toYm(today) && monthsBetween(toYm(today), to) < 0;
    return { status: passed ? BLOCK_PLAN_PASSED : status, date };
  }
  if (status !== BLOCK_LIVE || !date || !today || date >= today) return { status, date };
  const issued = (Array.isArray(row?.timeline) ? row.timeline : [])
    .filter((t) => t && t.stage !== BLOCK_LIVE && t.stage !== PRE_SUBSCRIPTION).map((t) => ymdOrNull(t.date)).filter(Boolean).sort();
  return { status: row.rental === true ? '임대 공고' : '본청약 공고', date: issued.at(-1) ?? null };
}

const naturalBlock = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'ko', { numeric: true });

/**
 * 상세의 블록별 현황 줄: projects.json 의 blocks 를 오늘 기준 상태로 다시 보고, 상태 순서 → 블록 이름(숫자 크기순) → 분양 먼저로 정렬.
 * 줄: { block, type, households, rental, status, date, timeline: [{ stage, date }], plan: { expected, from, to, source } | null, note, sources }
 */
export function blockRows(project, today) {
  return entriesOf(project?.blocks).map((b) => {
    const { status, date } = blockStatusNow(b, today);
    const plan = b.plan && typeof b.plan === 'object' && textOrNull(b.plan.expected)
      ? {
        expected: b.plan.expected.trim(),
        from: toYm(b.plan.from),
        to: toYm(b.plan.to),
        source: cleanLinks([b.plan.source])[0] ?? null,
      }
      : null;
    return {
      block: textOrNull(b.block) ?? '-',
      type: textOrNull(b.type),
      households: countOrNull(b.households),
      rental: b.rental === true,
      status,
      date,
      timeline: entriesOf(b.timeline).filter((t) => isBlockStage(t.stage) && ymdOrNull(t.date))
        .map((t) => ({ stage: t.stage, date: ymdOrNull(t.date) })),
      plan,
      note: textOrNull(b.note),
      sources: cleanLinks(b.sources),
      // 분양 성과(공고 난 분양 줄만, 없으면 null). 임대 줄에는 보이지 않는다.
      performance: b.rental === true ? null : cleanPerformance(b.performance),
    };
  }).sort((a, b) => BLOCK_STATUS_ORDER.indexOf(a.status) - BLOCK_STATUS_ORDER.indexOf(b.status)
    || naturalBlock(a.block, b.block) || Number(a.rental) - Number(b.rental));
}

/** 상태별 줄 수 [{ status, count }] (상태 순서, 0은 뺌) */
export function blockStatusCounts(rows) {
  return BLOCK_STATUS_ORDER.map((status) => ({ status, count: rows.filter((r) => r.status === status).length }))
    .filter((c) => c.count > 0);
}

/**
 * 지구 전체 블록 수 문구: 출처가 한 말임을 앞에 밝힌다 '시티뉴스(2025-11): 39개 블록 중 16개 사업승인'.
 * 표의 '사업승인' 칩 수(출처로 확인해 넣은 줄, 공고가 난 블록은 다른 상태)와 같은 집합이 아니다. 전체 블록 수가 없으면 null
 */
export function blockTotalText(blockTotal) {
  const total = countOrNull(blockTotal?.total);
  if (!total) return null;
  const approved = countOrNull(blockTotal.approved);
  const src = cleanLinks(blockTotal.sources)[0] ?? null;
  const outlet = textOrNull(blockTotal.outlet) ?? (src ? sourceOutlet(src) : null) ?? '출처';
  const month = toYm(blockTotal.date);
  const said = approved !== null ? `${total}개 블록 중 ${approved}개 사업승인` : `전체 ${total}개 블록`;
  return `${outlet}${month ? `(${month})` : ''}: ${said}`;
}

/** 유형 칸: 유형, 없으면 '유형 미확인' */
export function blockTypeLabel(row) {
  return textOrNull(row?.type) ?? UNKNOWN_BLOCK_TYPE;
}

/** 상태 옆 날짜 문구: 접수 중은 '마감 날짜', 그 밖은 날짜. 없으면 '' */
export function blockDateLabel(row) {
  if (!row?.date) return '';
  return row.status === BLOCK_LIVE ? `마감 ${row.date}` : row.date;
}

/** 경과 한 줄: '사전청약 2021-11-18', 임대 줄의 본청약은 '공고 2026-10-27', 접수 중은 '접수 중(마감 2026-11-11)' */
export function blockTimelineLabel(item, rental = false) {
  if (item?.stage === BLOCK_LIVE) return `접수 중(마감 ${item.date})`;
  const stage = rental && item?.stage === '본청약' ? '공고' : item?.stage;
  return `${stage} ${item?.date ?? ''}`.trim();
}

/** 다음 예정 문구: '2026-하반기 (하남일보 2026-03-08)', 기간 끝이 이번 달보다 앞이면 끝에 ' · 지남' */
export function blockPlanLabel(plan, todayYm) {
  if (!plan?.expected) return null;
  const src = plan.source ? `${sourceOutlet(plan.source)}${plan.source.date ? ` ${plan.source.date}` : ''}` : null;
  const passed = plan.to && todayYm && monthsBetween(todayYm, plan.to) < 0;
  return `${plan.expected}${src ? ` (${src})` : ''}${passed ? ' · 지남' : ''}`;
}

// --- 분양 성과(공고 난 블록의 분양가·경쟁률·주변 시세 비교) ------------------------

/** 시세 숫자를 하나라도 보일 때 붙이는 안내 */
export const MARKET_CAVEAT = '주변 단지 실거래로 추정한 값이며 이 단지의 시세가 아닙니다 (전매제한·미입주)';
/** 공고 당시 값은 오늘 받은 실거래(늦은 신고·취소 반영)로 다시 계산한 것이라는 표시 */
export const AT_NOTICE_NOTE = '(현재 집계 기준)';
/** 청약홈 경쟁률 API 값의 안내(실시간 집계) */
export const LIVE_COMPETITION_NOTE = '청약홈 실시간 집계, 최종 발표와 다를 수 있음';

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const positive = (n) => finite(n) && n > 0;

/** 만원 → '6억 4,000만 원', '9,800만 원', '6억 원' */
export function fmtManwon(value) {
  if (!positive(value)) return '-';
  const n = Math.round(value);
  const eok = Math.floor(n / 10000);
  const rest = n % 10000;
  if (!eok) return `${rest.toLocaleString('ko-KR')}만 원`;
  return rest ? `${eok}억 ${rest.toLocaleString('ko-KR')}만 원` : `${eok}억 원`;
}

/** 할인율 → '29% 낮음', '-0.12' → '12% 높음', 반올림해 0이면 '비슷함'. 값이 없으면 null */
export function discountLabel(rate) {
  if (!finite(rate)) return null;
  const pct = Math.round(Math.abs(rate) * 100);
  if (pct === 0) return '비슷함';
  return `${pct}% ${rate > 0 ? '낮음' : '높음'}`;
}

const areaLabel = (area) => `${Number(area.toFixed(2))}㎡`;

function cleanPoint(point) {
  if (!point || typeof point !== 'object') return null;
  const head = { asOf: ymdOrNull(point.asOf), period: textOrNull(point.period) };
  if (!positive(point.estimate)) return { ...head, shown: false, reason: textOrNull(point.reason) ?? '추정하지 않았습니다' };
  return {
    ...head,
    shown: true,
    estimate: point.estimate,
    unit: positive(point.unit) ? point.unit : null,
    discountRate: finite(point.discountRate) ? point.discountRate : null,
    confidence: textOrNull(point.confidence),
    scopeLabel: textOrNull(point.scopeLabel) ?? textOrNull(point.scope),
    same: point.scope === '같은 단지',
    comparables: (Array.isArray(point.comparables) ? point.comparables : []).map(textOrNull).filter(Boolean).slice(0, 5),
    comparableCount: countOrNull(point.comparableCount),
    samples: countOrNull(point.samples),
  };
}

function cleanCompetition(c) {
  if (!c || typeof c !== 'object' || !positive(c.rate)) return null;
  const ref = c.ref ? cleanLinks([c.ref])[0] ?? null : null;
  return {
    api: c.source === '청약홈',
    scope: textOrNull(c.scope),
    rate: c.rate,
    applicants: countOrNull(c.applicants),
    households: countOrNull(c.households),
    shortfall: c.shortfall === true,
    ref,
  };
}

/**
 * projects.json 의 블록 줄 performance 를 화면용으로 정리한다. 모양이 틀리면 null.
 * { name, noticeDate, noticeUrl, representative, typeCount, pricesReason, atNotice, now, marketReason, competition, competitionReason }
 */
export function cleanPerformance(perf) {
  if (!perf || typeof perf !== 'object' || Array.isArray(perf)) return null;
  const rep = perf.representative;
  const representative = rep && positive(rep.area) && positive(rep.topPrice)
    ? {
      houseType: textOrNull(rep.houseType), area: rep.area, topPrice: rep.topPrice, unitPrice: positive(rep.unitPrice) ? rep.unitPrice : null,
    }
    : null;
  const market = perf.market && typeof perf.market === 'object' ? perf.market : null;
  return {
    name: textOrNull(perf.name),
    noticeDate: ymdOrNull(perf.noticeDate),
    noticeUrl: safeHttpUrl(perf.noticeUrl),
    representative,
    typeCount: Array.isArray(perf.prices) ? perf.prices.length : 0,
    pricesReason: textOrNull(perf.pricesReason),
    atNotice: cleanPoint(market?.atNotice),
    now: cleanPoint(market?.now),
    marketReason: textOrNull(perf.marketReason),
    competition: cleanCompetition(perf.competition),
    competitionReason: textOrNull(perf.competitionReason),
  };
}

/** 대표 주택형 분양가: '84.98㎡(084.9800A) 최고 6억 4,000만 원 · 전용㎡당 753만 원' */
export function performancePriceText(rep) {
  if (!rep) return null;
  const type = rep.houseType && rep.houseType !== '-' ? `(${rep.houseType})` : '';
  const unit = rep.unitPrice ? ` · 전용㎡당 ${Math.round(rep.unitPrice).toLocaleString('ko-KR')}만 원` : '';
  return `대표 ${areaLabel(rep.area)}${type} 최고 ${fmtManwon(rep.topPrice)}${unit}`;
}

/** 경쟁률: '1순위 263.3:1 (접수 52,920건 / 201가구)', 보도는 출처 범위 그대로 '일반공급 263.3:1 (52,920명 / 201가구)' */
export function competitionText(c) {
  if (!c) return null;
  const scope = c.scope ?? (c.api ? '1순위' : '');
  const rate = `${Number(c.rate.toFixed(1)).toLocaleString('ko-KR')}:1`;
  const count = c.applicants !== null && c.households !== null
    ? ` (${c.api ? '접수 ' : ''}${c.applicants.toLocaleString('ko-KR')}${c.api ? '건' : '명'} / ${c.households.toLocaleString('ko-KR')}가구)`
    : '';
  return `${scope ? `${scope} ` : ''}${rate}${count}${c.shortfall ? ' · 미달' : ''}`;
}

/**
 * 시세 비교 한 줄. label 은 '공고 당시' 또는 '현재 기준'.
 * '공고 당시 주변 신축 환산 시세 대비 29% 낮음 (신뢰도 중, 하남시 비교 3개 단지: A·B·C, 실거래 41건, 2024-09~2025-02)'
 * 숨긴 값은 '공고 당시: 사유'
 */
export function marketPointText(point, label) {
  if (!point) return null;
  if (!point.shown) return `${label}: ${point.reason}${point.period ? ` (${point.period})` : ''}`;
  const diff = discountLabel(point.discountRate);
  const head = `${label} 주변 신축 환산 시세${point.estimate ? ` ${fmtManwon(point.estimate)}` : ''}${diff ? ` 대비 분양가 ${diff}` : ''}`;
  const total = Math.max(point.comparableCount ?? 0, point.comparables.length);
  const more = total > point.comparables.length && point.comparables.length ? ` 외 ${total - point.comparables.length}곳` : '';
  const where = point.same
    ? '같은 단지 거래'
    : `${point.scopeLabel ? `${point.scopeLabel} ` : ''}비교 ${total}개 단지${point.comparables.length ? `: ${point.comparables.join('·')}${more}` : ''}`;
  const parts = [
    point.confidence ? `신뢰도 ${point.confidence}` : null,
    where,
    point.samples !== null ? `실거래 ${point.samples.toLocaleString('ko-KR')}건` : null,
    point.period,
  ].filter(Boolean);
  return `${head} (${parts.join(', ')})`;
}

/**
 * 주변 시세 비교 칸: 공고 당시·현재 기준 줄과 안내. 공고 당시 숫자 줄에는 AT_NOTICE_NOTE 를 붙인다.
 * 안내(MARKET_CAVEAT)는 숫자를 보인 줄이 하나라도 있을 때만(사유만 있으면 null).
 * { points: [{ shown, text }], caveat }
 */
export function marketLines(perf) {
  const points = [];
  if (perf?.atNotice) {
    const text = marketPointText(perf.atNotice, '공고 당시');
    points.push({ shown: perf.atNotice.shown, text: perf.atNotice.shown ? `${text} ${AT_NOTICE_NOTE}` : text });
  }
  if (perf?.now) points.push({ shown: perf.now.shown, text: marketPointText(perf.now, '현재 기준') });
  return { points, caveat: points.some((p) => p.shown) ? MARKET_CAVEAT : null };
}

/**
 * 구별 집계: 서울 사업만, 구 이름 → { n: 전체, soon: 공고 중·1년 안, mid: 3년 안, live: 공고 중 }
 * bucketFn(project) 로 구간을 받는다(화면에서는 미리 계산한 값을 넘김).
 */
export function tileStats(projects, bucketFn) {
  const stats = new Map();
  for (const p of projects) {
    if (p?.region !== '서울') continue;
    const s = stats.get(p.district) ?? { n: 0, soon: 0, mid: 0, live: 0 };
    const b = bucketFn(p);
    s.n += 1;
    if (b === 'live' || b === 'soon') s.soon += 1;
    else if (b === 'mid') s.mid += 1;
    if (b === 'live') s.live += 1;
    stats.set(p.district, s);
  }
  return stats;
}

// 구 칸의 큰 숫자(1년 안) 색: 이만큼 이상이면 경계선 빨강(hot)
export const HOT_SOON = 6;

/** 구 칸 색 3단계: 1년 안(공고 중 포함) 6곳 이상 → hot, 1곳 이상 → has, 없으면 '' */
export function tileClass(stat) {
  const soon = stat?.soon ?? 0;
  if (soon >= HOT_SOON) return 'hot';
  if (soon >= 1) return 'has';
  return '';
}

/**
 * 타일에 쓰는 숫자: 크게 보일 main 은 1년 안(공고 중 포함) 수로 색(tileClass)과 같은 질문에 답하고,
 * total 은 그 구의 전체 사업 수(작게 '/36').
 */
export function tileCount(stat) {
  return { main: stat?.soon ?? 0, total: stat?.n ?? 0 };
}

/**
 * 주소 해시에서 화면 상태를 꺼낸다: '#p=<id>'(사업 화면), '#gu=<구>'(구 선택), '#t=<지구 id>&b=<블록>'(지구 화면과 블록 거르기).
 * 함께 쓸 수 있다('#gu=<구>&p=<id>'). 값은 decodeURIComponent 로 풀고, 깨졌거나 빈 값은 null. 모르는 해시('#sources' 등)면 모두 null.
 * 같은 키가 두 번 나오면 뒤의 값을 쓴다('#p=a&p=b' → 'b'). 블록(b)은 지구(t)가 있을 때만 뜻이 있다.
 */
export function parseHash(hash) {
  const out = { id: null, district: null, town: null, block: null };
  const keys = { p: 'id', gu: 'district', t: 'town', b: 'block' };
  for (const part of String(hash ?? '').replace(/^#/, '').split('&')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    let value;
    try {
      value = decodeURIComponent(part.slice(eq + 1));
    } catch {
      continue;
    }
    const key = keys[part.slice(0, eq)];
    if (value && key) out[key] = value;
  }
  if (!out.town) out.block = null;
  return out;
}

/** parseHash 의 반대: { id, district, town, block } → '#gu=…&p=…&t=…&b=…'. 아무것도 없으면 '' */
export function hashFor({ id = null, district = null, town = null, block = null } = {}) {
  const parts = [];
  if (district) parts.push(`gu=${encodeURIComponent(district)}`);
  if (id) parts.push(`p=${encodeURIComponent(id)}`);
  if (town) parts.push(`t=${encodeURIComponent(town)}`);
  if (town && block) parts.push(`b=${encodeURIComponent(block)}`);
  return parts.length ? `#${parts.join('&')}` : '';
}

/** 화면 상태를 담은 해시인지('#p=…'·'#gu=…'·'#t=…'). 빈 해시도 상태(첫 화면)로 본다. '#sources' 같은 문서 안 이동은 false */
export function isStateHash(hash) {
  const h = String(hash ?? '');
  if (h === '' || h === '#') return true;
  const { id, district, town } = parseHash(h);
  return Boolean(id || district || town);
}

/** '#p=<id>' 에서 id 를 꺼낸다 */
export function idFromHash(hash) {
  return parseHash(hash).id;
}

// --- 화면 테마: 시스템(기기 설정, 기본) · 라이트 · 다크 -----------------------
// 키는 site/theme-init.js 와 같게 둔다(그쪽은 처음 그리기 전에 같은 값을 읽는다).
export const THEME_KEY = 'bunyang-map-theme';
export const THEME_CHOICES = ['system', 'light', 'dark'];

/** 저장값·버튼값을 'light' | 'dark' | 'system' 으로. 정확히 'light'·'dark' 만 고정하고 나머지는 시스템(theme-init.js 와 같은 규칙) */
export function normalizeTheme(value) {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** <meta name="color-scheme"> 값: 시스템이면 'light dark', 고정이면 그 하나 */
export function colorSchemeFor(theme) {
  const t = normalizeTheme(theme);
  return t === 'system' ? 'light dark' : t;
}

/** 저장된 테마. 저장소가 없거나 막혀 있으면(예외) 시스템 */
export function readTheme(storage) {
  try {
    return normalizeTheme(storage?.getItem(THEME_KEY));
  } catch {
    return 'system';
  }
}

/** 테마 저장. 시스템이면 저장값을 지운다. 저장소가 없거나 막혀 있으면 false */
export function writeTheme(storage, theme) {
  const t = normalizeTheme(theme);
  try {
    if (!storage) return false;
    if (t === 'system') storage.removeItem(THEME_KEY);
    else storage.setItem(THEME_KEY, t);
    return true;
  } catch {
    return false;
  }
}

/** storage 이벤트가 테마와 관련 있는지: 테마 키가 바뀌었거나 저장소 전체가 지워졌을 때(key 가 null) */
export function isThemeStorageKey(key) {
  return key === THEME_KEY || key === null;
}

/**
 * data-theme·color-scheme 메타·버튼 눌림 상태를 테마에 맞춘다. 시스템이면 data-theme 를 뗀다.
 * DOM 은 인자로 받는다({ root, meta, buttons }) — node 에서 가짜 객체로 검사하려고. 적용한 테마를 돌려준다.
 */
export function applyTheme(theme, { root, meta, buttons = [] }) {
  const t = normalizeTheme(theme);
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
  meta?.setAttribute('content', colorSchemeFor(t));
  for (const btn of buttons) {
    btn.setAttribute('aria-pressed', String(btn.getAttribute('data-theme-choice') === t));
  }
  return t;
}


// --- 날짜·수집 시각 -----------------------------------------------------------

const YMD = /^\d{4}-\d{2}-\d{2}$/;
/** 'YYYY-MM-DD' 꼴인지 */
export const isYmd = (value) => typeof value === 'string' && YMD.test(value);

/** 'YYYY-MM-DD' 에 n 일을 더한다 */
export function addDays(ymd, n) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 요일: 0(일)~6(토) */
export function weekdayOf(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const DOW_LABEL = ['일', '월', '화', '수', '목', '금', '토'];

/**
 * generatedAt 같은 시각 값: 'YYYY-MM-DD'(예전 자료) 또는 ISO 시각('2026-11-10T07:30:00+09:00').
 * 한국 시간으로 { date, time('HH:MM' | null) }. 오프셋이 없는 시각은 한국 시간으로 본다. 형식이 아니면 null
 */
export function parseStamp(value) {
  const s = String(value ?? '').trim();
  if (YMD.test(s)) return { date: s, time: null };
  const m = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (!m) return null;
  const ms = Date.parse(m[1] ? s : `${s}+09:00`);
  if (Number.isNaN(ms)) return null;
  const kst = new Date(ms + 9 * 60 * 60 * 1000).toISOString();
  return { date: kst.slice(0, 10), time: kst.slice(11, 16) };
}

/** 머리말의 수집 시각: '11-10 07:30'(시각이 있으면), '2026-11-10'(날짜만). 모르면 null */
export function stampLabel(value) {
  const st = parseStamp(value);
  if (!st) return null;
  return st.time ? `${st.date.slice(5)} ${st.time}` : st.date;
}

/** 목록 날짜: 오늘과 같은 해면 '11.08', 아니면 '25.12.24' */
export function shortDate(ymd, today) {
  if (!isYmd(ymd)) return String(ymd ?? '');
  return ymd.slice(0, 4) === String(today ?? '').slice(0, 4) ? ymd.slice(5).replace('-', '.') : ymd.slice(2).replace(/-/g, '.');
}

/** '2026-06' → '2026년 6월', 'YYYY-MM-DD' 는 그대로. 아니면 null */
export function monthLabel(value) {
  const s = String(value ?? '').trim();
  if (/^\d{4}-\d{2}$/.test(s)) return `${s.slice(0, 4)}년 ${Number(s.slice(5))}월`;
  return s || null;
}

// --- 읽음 기록(새 소식 표시) ---------------------------------------------------
// localStorage 'bunyang-map-seen': { ids: 지난번에 보여 준 소식 id, lastVisit: ISO 시각 }.
// 한 번의 방문(탭) 동안은 sessionStorage 에 그 방문의 기준을 두어, 새로 고쳐도 NEW 표시가 그대로 남게 한다.

export const SEEN_KEY = 'bunyang-map-seen';
export const VISIT_KEY = 'bunyang-map-visit';
export const FIRST_VISIT_DAYS = 7;

const stringIds = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x) : []);

/** 저장된 읽음 기록 { ids, lastVisit }. 없거나 깨졌거나 저장소가 막혀 있으면 null */
export function readSeen(storage, key = SEEN_KEY) {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || !Array.isArray(v.ids)) return null;
    return { ids: stringIds(v.ids), lastVisit: typeof v.lastVisit === 'string' ? v.lastVisit : null };
  } catch {
    return null;
  }
}

/** 읽음 기록 저장 { ids, lastVisit }. 저장소가 없거나 막혀 있으면 false */
export function writeSeen(storage, record, key = SEEN_KEY) {
  try {
    if (!storage) return false;
    storage.setItem(key, JSON.stringify({ ids: stringIds([...(record?.ids ?? [])]), lastVisit: record?.lastVisit ?? null }));
    return true;
  } catch {
    return false;
  }
}

/**
 * 이번 방문의 기준 { ids: Set | null, since, lastVisit }. 지난 기록이 있으면 그 id 밖의 소식이 NEW,
 * 처음 방문이면(기록 없음) 최근 7일(오늘 포함) 소식만 NEW.
 */
export function visitBaseline(stored, today) {
  if (stored && Array.isArray(stored.ids)) return { ids: new Set(stored.ids), since: null, lastVisit: stored.lastVisit ?? null };
  return { ids: null, since: addDays(today, -(FIRST_VISIT_DAYS - 1)), lastVisit: null };
}

/** 이번 방문 기준 읽기(sessionStorage). 없거나 깨졌으면 null */
export function readVisit(storage, key = VISIT_KEY) {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    if (Array.isArray(v.ids)) return { ids: new Set(stringIds(v.ids)), since: null, lastVisit: typeof v.lastVisit === 'string' ? v.lastVisit : null };
    if (v.ids === null && isYmd(v.since)) return { ids: null, since: v.since, lastVisit: null };
    return null;
  } catch {
    return null;
  }
}

/** 이번 방문 기준 저장. 막혀 있으면 false */
export function writeVisit(storage, baseline, key = VISIT_KEY) {
  try {
    if (!storage) return false;
    storage.setItem(key, JSON.stringify({
      ids: baseline?.ids ? [...baseline.ids] : null, since: baseline?.since ?? null, lastVisit: baseline?.lastVisit ?? null,
    }));
    return true;
  } catch {
    return false;
  }
}

/** 새 소식(NEW)인지: 기준 id 에 없으면 NEW. 처음 방문(ids 없음)이면 since 이후 날짜만 */
export function isNewItem(item, baseline) {
  if (!item || !baseline) return false;
  if (baseline.ids) return !baseline.ids.has(item.id);
  return isYmd(item.date) && Boolean(baseline.since) && item.date >= baseline.since;
}

// --- 새 소식(feed) ------------------------------------------------------------

export const FEED_KINDS = ['공고', '접수', '뉴스', '일정', '단계'];
export const FEED_KIND_LABEL = { all: '전체', 공고: '청약 공고', 접수: '접수 일정', 뉴스: '뉴스', 일정: '일정 보도', 단계: '단계 변경' };
export const FEED_KIND_CLASS = { 공고: 'k-notice', 접수: 'k-apply', 뉴스: 'k-news', 일정: 'k-plan', 단계: 'k-stage' };
// 블록 없이 지구 전체에 걸린 소식을 고르는 값('#t=…&b=지구전체')
export const WHOLE_TOWN = '지구전체';

/**
 * projects.json 의 feed 를 화면용으로: id·날짜·종류·제목이 맞는 항목만(같은 id 는 처음 것만), 출처 주소는 http(s)만.
 * 최근 날짜 먼저, 같은 날은 원래 순서.
 */
export function cleanFeed(list) {
  const seen = new Set();
  return entriesOf(list).flatMap((f, i) => {
    const id = typeof f.id === 'string' || typeof f.id === 'number' ? String(f.id) : '';
    const title = textOrNull(f.title);
    if (!id || seen.has(id) || !isYmd(f.date) || !FEED_KINDS.includes(f.kind) || !title) return [];
    seen.add(id);
    const src = f.source && typeof f.source === 'object' ? f.source : {};
    return [{
      id, date: f.date, kind: f.kind, title, i,
      projectId: f.projectId === null || f.projectId === undefined ? null : String(f.projectId),
      block: textOrNull(f.block),
      rental: f.rental === true,
      source: {
        title: textOrNull(src.title),
        url: safeHttpUrl(src.url),
        date: textOrNull(src.date),
        outlet: textOrNull(src.outlet),
        local: src.local === true,
        provider: src.provider === NAVER_PROVIDER ? NAVER_PROVIDER : null,
      },
    }];
  }).sort((a, b) => b.date.localeCompare(a.date) || a.i - b.i).map(({ i, ...f }) => f);
}

// 네이버 뉴스 검색으로 찾은 관련 소식의 source.provider(파이프라인 feed.js NAVER_PROVIDER)
export const NAVER_PROVIDER = 'naver';

/** 네이버 관련 소식인지(제목은 언론사 제목 그대로, 출처에 '검색: NAVER' 표시) */
export const isNaverItem = (item) => item?.source?.provider === NAVER_PROVIDER;

/**
 * 화면에 보일 소식: 네이버 관련 소식은 today 기준 NEWS_SHOW_DAYS(21)일 안(그날 포함, 미래 제외)만 남긴다.
 * 파이프라인은 14일 안의 기사만 싣지만, 빌드가 멈춰 예전 배포가 오래 남아도 약관의 보관 한도가 지난 기사는 숨긴다(newsItems 와 같은 기준).
 * 그 밖의 소식(공고·일정·손으로 고른 기사 등)은 그대로.
 */
export function visibleFeed(feed, today) {
  const cutoff = ymdDaysBefore(today, NEWS_SHOW_DAYS);
  return (Array.isArray(feed) ? feed : []).filter((f) => !isNaverItem(f) || (cutoff !== null && f.date >= cutoff && f.date <= today));
}

/**
 * 블록 카드 아래 '최근 …' 줄. items 는 그 블록 소식(최신순). 네이버 기사 제목은 출처 표시 없이 보이지 않도록
 * 네이버가 아닌 가장 최근 소식의 제목을 쓰고, 네이버 기사뿐이면 제목 없이 '최근 11.10 뉴시스 기사 (검색: NAVER)'.
 */
export function blockLatestText(items, today) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '아직 모은 소식 없음';
  const own = list.find((f) => !isNaverItem(f));
  if (own) return `최근 ${shortDate(own.date, today)} ${own.title}`;
  const first = list[0];
  const outlet = textOrNull(first.source?.title);
  return `최근 ${shortDate(first.date, today)} ${outlet ? `${outlet} ` : ''}기사 (${NEWS_CREDIT})`;
}

/** 지구 화면 머리의 예상 근거 한 줄: '다음 블록 예상 근거 · 규칙: 오늘부터 0~2년'. 근거가 없으면 null */
export function windowBasisNote(project) {
  const basis = textOrNull(project?.windowBasis);
  return basis ? `${windowFactLabel(project)} 근거 · ${basis}` : null;
}

/** 사업 목록의 '소식 N': 그 사업의 뉴스 소식 수(손으로 고른 기사와 네이버 관련 소식, visibleFeed 뒤의 feed) */
export function projectNewsCount(feed, projectId) {
  return (Array.isArray(feed) ? feed : []).filter((f) => f.kind === '뉴스' && f.projectId === projectId).length;
}

/** 소식의 블록(비교용 key): 'A9·A11' → ['A9', 'A11'], 블록이 없으면 [] */
export function feedBlocks(item) {
  return String(item?.block ?? '').split(/[·,/]/).map((b) => blockKey(b)).filter(Boolean);
}

// 같은 블록 이름에 분양 줄과 임대 줄이 함께 있을 때 임대 쪽 선택 값의 꼬리('A-1 임대')
export const RENTAL_SUFFIX = ' 임대';

function selParts(value) {
  const s = String(value ?? '');
  const rental = s.endsWith(RENTAL_SUFFIX);
  return { key: blockKey(rental ? s.slice(0, -RENTAL_SUFFIX.length) : s), rental };
}

/** 분양 줄과 임대 줄이 함께 있는 블록 key 들(예: 구리갈매역세권 A-1 신혼희망타운·행복주택) */
export function splitBlocks(rows) {
  const kinds = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const key = blockKey(r.block);
    kinds.set(key, (kinds.get(key) ?? 0) | (r.rental ? 2 : 1));
  }
  return new Set([...kinds].filter(([, v]) => v === 3).map(([k]) => k));
}

/** 블록 줄의 거르기 값: 보통은 블록 이름, 분양·임대가 함께 있는 블록의 임대 줄이면 'A-1 임대' */
export function blockSel(row, split = new Set()) {
  return row?.rental && split.has(blockKey(row.block)) ? `${row.block}${RENTAL_SUFFIX}` : String(row?.block ?? '');
}

/** 같은 블록 선택인지('지구전체'는 글자 그대로, 블록은 blockKey 와 임대 꼬리로) */
export function sameBlock(a, b) {
  if (!a || !b) return !a && !b;
  if (a === WHOLE_TOWN || b === WHOLE_TOWN) return a === b;
  const x = selParts(a);
  const y = selParts(b);
  return x.key === y.key && x.rental === y.rental;
}

/**
 * 블록 거르기에 맞는지: block 이 없으면 모두, '지구전체'면 블록 없는 소식만, 그 밖은 그 블록이 들어 있는 소식.
 * 분양·임대가 함께 있는 블록(split)이면 소식의 rental 로 한쪽만 고른다('A-1' 은 분양, 'A-1 임대' 는 임대).
 */
export function inBlock(item, block, split = null) {
  if (!block) return true;
  const blocks = feedBlocks(item);
  if (block === WHOLE_TOWN) return blocks.length === 0;
  const { key, rental } = selParts(block);
  if (!blocks.includes(key)) return false;
  return !split?.has(key) || (item?.rental === true) === rental;
}

/** 소식 거르기 { kind: 'all' | 종류, onlyNew, projectId, block, split }. NEW 판단은 isNew(item) */
export function filterFeed(feed, filter = {}, isNew = () => false) {
  const { kind = 'all', onlyNew = false, projectId = null, block = null, split = null } = filter ?? {};
  return (Array.isArray(feed) ? feed : []).filter((f) => (kind === 'all' || f.kind === kind)
    && (!onlyNew || isNew(f)) && (!projectId || f.projectId === projectId) && inBlock(f, block, split));
}

/** 종류별 개수 { all, 공고, 접수, 뉴스, 일정, 단계 } */
export function feedKindCounts(feed) {
  const out = { all: 0, ...Object.fromEntries(FEED_KINDS.map((k) => [k, 0])) };
  for (const f of Array.isArray(feed) ? feed : []) {
    out.all += 1;
    if (f.kind in out) out[f.kind] += 1;
  }
  return out;
}

/** 종류별 개수 글자: '청약 공고 1, 접수 일정 2, 뉴스 1' (0 은 뺌) */
export function kindBreakdown(items) {
  const c = feedKindCounts(items);
  return FEED_KINDS.filter((k) => c[k]).map((k) => `${FEED_KIND_LABEL[k]} ${c[k]}`).join(', ');
}

/** 출처 글자 '메트로신문 2026-11-03'. 낸 곳: outlet → 제목 끝 괄호 → 짧은 제목(20자까지) → 주소 호스트 */
export function feedSourceLabel(source) {
  const title = textOrNull(source?.title);
  const url = safeHttpUrl(source?.url);
  const outlet = textOrNull(source?.outlet)
    ?? (/\(([^()]+)\)\s*$/.exec(title ?? '')?.[1]?.trim() || null)
    ?? (title && title.length <= 20 ? title : null)
    ?? (url ? new URL(url).hostname.replace(/^(www|m)\./, '') : '출처');
  const date = textOrNull(source?.date);
  return date && !outlet.includes(date) ? `${outlet} ${date}` : outlet;
}

// --- 공고 단계·접수 중 ---------------------------------------------------------

/**
 * 공고명에서 블록 이름: '구리갈매역세권 B-1블록 …' → 'B-1', '(A-2BL)' → 'A-2', '하남교산 A2 푸르지오' → 'A2'. 없으면 null.
 * 영문 1~2자 + 숫자(가운데 '-' 허용) 뒤가 BL·블록·영숫자 아닌 글자·끝일 때만(파이프라인 feed.js parseBlock 과 같은 규칙)
 */
export function noticeBlock(name) {
  const value = String(name ?? '').toUpperCase().replace(/\s+/g, ' ');
  const m = /(?<![0-9A-Z-])([A-Z]{1,2}-?\d{1,3}(?:-\d+)?)(?=BL|블록|[^0-9A-Z-]|$)/.exec(value);
  return m ? m[1] : null;
}

const isAfterStage = (name) => /당첨|발표|계약/.test(String(name ?? ''));

/** '1순위 해당' → '1순위', '1순위 경기' → '1순위', '2순위 기타지역' → '2순위' (짧은 단계 이름) */
export function stageShort(name) {
  return String(name ?? '').replace(/\s*(해당|기타|경기|서울|인천)(지역)?\s*$/, '').trim();
}

/** 공고의 접수 단계(당첨자 발표·계약 빼고) [{ name, start, end }]. 시작일이 날짜인 것만, 시작 순 */
export function receptionStages(notice) {
  return entriesOf(notice?.stages)
    .filter((s) => textOrNull(s.name) && !isAfterStage(s.name) && isYmd(s.start))
    .map((s) => ({ name: s.name.trim(), start: s.start, end: isYmd(s.end) && s.end >= s.start ? s.end : s.start }))
    .sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * 오늘 접수 중인 공고: 접수 단계 하나가 오늘에 걸치면.
 * [{ project, notice, block, stage(지금 단계), start, end(마지막 접수일), rental, winnerDate }] 마지막 접수일 빠른 순
 */
export function receivingNow(projects, today) {
  const out = [];
  for (const p of Array.isArray(projects) ? projects : []) {
    for (const n of entriesOf(p?.notices)) {
      const stages = receptionStages(n);
      const now = stages.find((s) => s.start <= today && today <= s.end);
      if (!now) continue;
      out.push({
        project: p, notice: n, block: noticeBlock(n.name), stage: stageShort(now.name), start: now.start,
        end: stages.map((s) => s.end).sort().at(-1), rental: isRentalNotice(n), winnerDate: isYmd(n.winnerDate) ? n.winnerDate : null,
      });
    }
  }
  return out.sort((a, b) => a.end.localeCompare(b.end));
}

/** 접수 중 한 줄: '구리갈매역세권 B-1 1순위, 11-11 마감' (임대면 끝에 '(임대)') */
export function receivingText(r, name = r?.project?.name) {
  const who = [name, r?.block].filter(Boolean).join(' ');
  return `${who} ${r?.stage ?? '접수'}, ${String(r?.end ?? '').slice(5)} 마감${r?.rental ? ' (임대)' : ''}`;
}

// --- 요약판 --------------------------------------------------------------------

const PLANNED_STATUSES = ['다음 예정(보도)', '계획 보도'];

/** 다음 예정 블록(보도): 블록별 분양 지구의 임대가 아닌 '다음 예정(보도)'·'계획 보도' 줄 [{ project, block, expected }] */
export function plannedBlocks(projects, today) {
  return (Array.isArray(projects) ? projects : []).filter(isBlockTownProject).flatMap((p) => blockRows(p, today)
    .filter((r) => !r.rental && PLANNED_STATUSES.includes(r.status))
    .map((r) => ({ project: p, block: r.block, expected: r.plan?.expected ?? null })));
}

/** '하남교산 A9·A11 (2026-하반기), 구리갈매역세권 S-1' — 지구별로 묶고, 예정 시기가 모두 같으면 괄호로 */
export function plannedText(list) {
  const groups = new Map();
  for (const x of Array.isArray(list) ? list : []) {
    const key = x.project?.id ?? x.project?.name;
    const g = groups.get(key) ?? { name: x.project?.name ?? '', blocks: [], expected: new Set() };
    g.blocks.push(x.block);
    g.expected.add(x.expected ?? '');
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => {
    const [only] = g.expected;
    return `${g.name} ${g.blocks.join('·')}${g.expected.size === 1 && only ? ` (${only})` : ''}`;
  }).join(', ');
}

/** 서울 1년 안(공고 중 포함) 사업 수와 구별 수(많은 순) { total, byDistrict: [[구, n], …] } */
export function seoulSoon(projects, bucketFn) {
  const by = new Map();
  let total = 0;
  for (const p of Array.isArray(projects) ? projects : []) {
    if (p?.region !== '서울') continue;
    const b = bucketFn(p);
    if (b !== 'live' && b !== 'soon') continue;
    total += 1;
    by.set(p.district, (by.get(p.district) ?? 0) + 1);
  }
  return { total, byDistrict: [...by].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'ko')) };
}

// --- 청약 일정(달력) ------------------------------------------------------------

export const CALENDAR_DAYS = 21;
export const WINNER_LABEL = '당첨자 발표';

/** 일정 색: 당첨자 발표 → win(파랑), 임대 → rent(점선), 그 밖 접수 → live(초록) */
export function calendarTone(event) {
  if (event?.label === WINNER_LABEL) return 'win';
  return event?.rental === true ? 'rent' : 'live';
}

/** projects.json 의 calendar 를 화면용으로: 날짜·이름이 맞는 것만, 날짜 순 */
export function cleanCalendar(list) {
  return entriesOf(list).filter((e) => isYmd(e.date) && textOrNull(e.label)).map((e, i) => ({
    date: e.date, label: e.label.trim(), i,
    projectId: e.projectId === null || e.projectId === undefined ? null : String(e.projectId),
    block: textOrNull(e.block), title: textOrNull(e.title), rental: e.rental === true, url: safeHttpUrl(e.url),
  })).sort((a, b) => a.date.localeCompare(b.date) || a.i - b.i).map(({ i, ...e }) => e);
}

/**
 * 오늘부터 n 일 칸: [{ date, dow, isToday, weekend, label('11/10' — 첫날과 1일만 달 표시), events }]
 */
export function calendarDays(calendar, today, n = CALENDAR_DAYS) {
  const byDate = new Map();
  for (const e of Array.isArray(calendar) ? calendar : []) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  return Array.from({ length: n }, (_, i) => {
    const date = addDays(today, i);
    const dow = weekdayOf(date);
    const month = Number(date.slice(5, 7));
    const day = Number(date.slice(8, 10));
    return { date, dow, isToday: i === 0, weekend: dow === 0 || dow === 6, label: i === 0 || day === 1 ? `${month}/${day}` : String(day), events: byDate.get(date) ?? [] };
  });
}

/** 달력 칸 안의 짧은 글자: 'B-1 1순위', 블록이 없으면 사업 이름, 당첨자 발표는 '당첨' */
export function calendarShort(event, nameOf = () => '') {
  const label = event?.label === WINNER_LABEL ? '당첨' : stageShort(event?.label);
  return `${event?.block ?? nameOf(event?.projectId) ?? ''} ${label}`.trim();
}

/** 화면 읽기용 일정 글: 일정이 있는 날만 [{ date: '11/10', text: '구리갈매역세권 B-1 1순위, …' }] */
export function agendaItems(days, nameOf = () => '') {
  return (Array.isArray(days) ? days : []).filter((d) => d.events.length).map((d) => ({
    date: `${Number(d.date.slice(5, 7))}/${Number(d.date.slice(8, 10))}`,
    text: d.events.map((e) => `${[nameOf(e.projectId), e.block, e.label].filter(Boolean).join(' ')}${e.rental ? '(임대)' : ''}`).join(', '),
  }));
}

// --- 지구(블록별 분양) -----------------------------------------------------------

// 지구 카드·지구 화면의 블록 묶음(막대와 개수). 순서는 막대 순서
export const TOWN_GROUPS = [
  { key: 'sold', label: '분양 끝남' },
  { key: 'live', label: '접수 중' },
  { key: 'plan', label: '다음 예정' },
  { key: 'late', label: '예정 지남' },
  { key: 'approved', label: '사업승인·착공' },
  { key: 'other', label: '임대·기타' },
];

/** 블록 줄(blockRows)의 묶음 key. 접수 중은 임대여도 접수 중, 그 밖의 임대 줄은 임대·기타 */
export function townGroupOf(row) {
  const s = row?.status;
  if (s === BLOCK_LIVE) return 'live';
  if (row?.rental === true) return 'other';
  if (s === '본청약 공고') return 'sold';
  if (PLANNED_STATUSES.includes(s)) return 'plan';
  if (s === BLOCK_PLAN_PASSED) return 'late';
  if (s === '사업승인' || s === '착공') return 'approved';
  return 'other';
}

/** 묶음별 줄 수 [{ key, label, n }] (0 은 뺌) */
export function townGroupCounts(rows) {
  return TOWN_GROUPS.map((g) => ({ ...g, n: (Array.isArray(rows) ? rows : []).filter((r) => townGroupOf(r) === g.key).length }))
    .filter((g) => g.n > 0);
}

/**
 * 블록 카드의 작은 진행 단계 [{ label, date, state: 'done' | 'now' | 'next' | 'late' }]:
 * 경과(사전청약·본청약·접수 중) → 사업승인·착공·보도 → 아직 공고가 없으면 다음 단계(예정 시기 또는 '미정').
 */
export function blockSteps(row) {
  const r = row ?? {};
  const steps = (Array.isArray(r.timeline) ? r.timeline : []).map((t) => (t.stage === BLOCK_LIVE
    ? { label: '접수 중', date: `~${String(t.date).slice(5)}`, state: 'now' }
    : { label: r.rental && t.stage === '본청약' ? '공고' : t.stage, date: t.date, state: 'done' }));
  const s = r.status;
  if ((s === '사업승인' || s === '착공') && r.date) steps.push({ label: s, date: r.date, state: 'done' });
  if (r.plan) steps.push({ label: '보도', date: r.plan.source?.date ?? r.date ?? '', state: 'done' });
  else if (s === '계획 보도' && r.date) steps.push({ label: '보도', date: r.date, state: 'done' });
  if (![BLOCK_LIVE, '본청약 공고', '임대 공고'].includes(s)) {
    const pre = steps.some((x) => x.label === PRE_SUBSCRIPTION);
    steps.push({
      label: pre ? '본청약' : '공고',
      date: r.plan?.expected ? `${r.plan.expected} 예정` : '미정',
      state: s === BLOCK_PLAN_PASSED ? 'late' : 'next',
    });
  }
  return steps;
}

/** 블록별 분양 지구로 보여 줄 사업인지(지구 화면) */
export const isTownView = (project) => isBlockTownProject(project);

/**
 * 지구의 지금 상태 한 줄 { tone: 'live' | 'win' | 'plan' | 'muted', label, text }.
 * 접수 중이면 '지금 접수 중'·'B-1 1순위 오늘, 당첨 발표 11-17', 아니면 앞으로 잡힌 일정, 아니면 예상 시기.
 */
export function townHeadline(project, calendar, today, todayYm) {
  const live = receivingNow([project], today)[0];
  if (live) {
    const what = [live.block, live.stage].filter(Boolean).join(' ');
    const when = live.start === today ? '오늘' : '접수 중';
    const tail = live.winnerDate ? `당첨 발표 ${live.winnerDate.slice(5)}` : `${live.end.slice(5)} 마감`;
    return { tone: 'live', label: '지금 접수 중', text: `${what} ${when}, ${tail}${live.rental ? ' (임대)' : ''}` };
  }
  const next = (Array.isArray(calendar) ? calendar : []).find((e) => e.projectId === project?.id && e.date >= today);
  if (next) {
    return { tone: next.label === WINNER_LABEL ? 'win' : 'live', label: '다음 일정', text: `${[next.block, next.label].filter(Boolean).join(' ')} ${next.date.slice(5)}${next.rental ? ' (임대)' : ''}` };
  }
  const bucket = bucketOf(project, todayYm);
  return { tone: ['soon', 'mid', 'live'].includes(bucket) ? 'plan' : 'muted', label: windowFactLabel(project), text: windowLabel(project, todayYm) };
}

/** 관심 지구 목록(watchlist): 이름이 있는 것만 { name, kind, region, tracked, projectId } */
export function cleanWatchlist(list) {
  return entriesOf(list).filter((w) => textOrNull(w.name)).map((w) => ({
    name: w.name.trim(), kind: textOrNull(w.kind) ?? '', region: textOrNull(w.region) ?? '',
    tracked: w.tracked === true, projectId: w.tracked === true && w.projectId !== null && w.projectId !== undefined ? String(w.projectId) : null,
  }));
}

/** 사업 화면·지구 화면 주소: 블록별 분양 지구는 '#t=…'(블록이 있으면 '&b=…'), 그 밖은 '#p=…'. district 는 첫 화면의 구 선택 */
export function linkFor(project, { block = null, district = null } = {}) {
  if (!project) return hashFor({ district });
  return isTownView(project) ? hashFor({ district, town: project.id, block }) : hashFor({ district, id: project.id });
}

/**
 * 해시 → 화면 { kind: 'main' } | { kind: 'town', id, block } | { kind: 'project', id }.
 * isTown(id) 가 참인 사업은 '#p=' 로 와도 지구 화면, 블록별 분양이 아닌 '#t=' 는 사업 화면.
 */
export function routeOf(parsed, isTown = () => false) {
  const p = parsed ?? {};
  if (p.town) return isTown(p.town) ? { kind: 'town', id: p.town, block: p.block ?? null } : { kind: 'project', id: p.town };
  if (p.id) return isTown(p.id) ? { kind: 'town', id: p.id, block: null } : { kind: 'project', id: p.id };
  return { kind: 'main' };
}

// ---------------------------------------------------------------------------
// 화면
// ---------------------------------------------------------------------------

// 서울 25개 구(대략 북→남, 서→동 순서)
const SEOUL_ORDER = [
  '강북구', '도봉구', '은평구', '종로구', '성북구', '노원구', '강서구', '마포구', '서대문구', '중구', '동대문구', '중랑구',
  '양천구', '영등포구', '용산구', '성동구', '광진구', '강동구', '구로구', '동작구', '서초구', '강남구', '송파구', '금천구', '관악구',
];
const SEOUL_DISTRICTS = new Set(SEOUL_ORDER);
const SOON_LIST_MAX = 8;
const GU_CHIPS_MAX = 12;
const REGION_LIST_MAX = 24;
// 이 단계부터는 분양에 가까운 단계로 막대를 칠한다(서울 단계 막대)
const NEAR_SALE_STAGE = '관리처분인가';

const state = {
  data: null,
  today: '',
  todayYm: '',
  projects: [], // 정렬된 전체 목록
  byId: new Map(),
  bucket: new Map(), // id → 구간
  hay: new Map(), // id → 검색 글자(searchText)
  stages: DEFAULT_STAGES,
  filters: { ...DEFAULT_FILTERS },
  base: [], // 구 선택을 뺀 필터 결과
  visible: [], // 구 선택까지 적용한 결과(전체 사업 목록)
  shown: PAGE_SIZE,
  feed: [],
  hasFeed: false,
  calendar: [],
  watch: [],
  baseline: { ids: null, since: null, lastVisit: null },
  feedFilter: { kind: 'all', onlyNew: false },
  feedShown: FEED_PAGE,
  soonGu: null,
  route: null,
  townBlock: null,
  quietPop: false, // toggleDistrict 가 부른 history.back() 의 popstate 인지
  refreshing: false,
};

const $ = (id) => document.getElementById(id);
const bucketFn = (p) => state.bucket.get(p.id);
const isNew = (item) => isNewItem(item, state.baseline);
const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** 안전한 DOM 생성기: 문자열 자식은 텍스트 노드, href 는 http(s) 또는 우리가 만든 '#…' 해시만 */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style') Object.assign(el.style, value); // CSSOM 은 CSP style-src 'self' 에 막히지 않음
    else if (key === 'href') {
      const url = String(value).startsWith('#') ? String(value) : safeHttpUrl(value);
      if (url) el.setAttribute('href', url);
    } else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_BACK = ['M10 3 5 8l5 5'];

/** 선 아이콘(16px, 글자색) */
function icon(paths) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({ 'aria-hidden': 'true', viewBox: '0 0 16 16', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8' })) svg.setAttribute(k, v);
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** 외부 링크. 주소가 http(s)가 아니면 링크 없이 글자만 */
function extLink(url, text, props = {}) {
  const safe = safeHttpUrl(url);
  if (!safe) return h('span', {}, text);
  return h('a', { ...props, href: safe, target: '_blank', rel: 'noopener noreferrer' }, text);
}

function chip(bucket) {
  const info = BUCKET_INFO[bucket] ?? BUCKET_INFO.far;
  return h('span', { class: `chip ${info.cls}` }, info.label);
}

function fmtCount(n) {
  return typeof n === 'number' && Number.isFinite(n) ? `${n.toLocaleString('ko-KR')}세대` : '미정';
}

function placeLabel(p) {
  return [p.region, p.district].filter(Boolean).join(' ');
}

/** 소식·일정에 붙는 사업 이름: 서울은 '중랑구 중화3', 지구는 이름 */
function projectLabel(p) {
  if (!p) return null;
  return p.region === '서울' && p.district ? `${p.district} ${p.name ?? ''}` : (p.name ?? '');
}

const nameOf = (id) => state.byId.get(id)?.name ?? null;

function stagesOf(p) {
  const list = state.stages[stageGroup(p)];
  return Array.isArray(list) && list.length ? list : DEFAULT_STAGES[stageGroup(p)];
}

function announce(text) {
  $('announce').textContent = '';
  // 같은 글을 다시 알려도 읽히도록 한 박자 뒤에 넣는다(requestAnimationFrame 은 뒤에 있는 탭에서 멈추므로 setTimeout)
  setTimeout(() => { $('announce').textContent = text; }, 50);
}

/** 다시 그린 뒤에도 키보드 포커스가 같은 항목에 남도록 */
function keepFocus(container, render) {
  const active = document.activeElement;
  const key = active && container.contains(active) ? active.getAttribute('data-key') : null;
  render();
  if (key) {
    for (const el of container.querySelectorAll('[data-key]')) {
      if (el.getAttribute('data-key') === key) {
        el.focus();
        break;
      }
    }
  }
}

/** 제목으로 화면을 옮기고 포커스(키보드·화면 읽기용) */
function jumpTo(id) {
  const el = $(id);
  if (!el) return;
  el.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
  el.focus({ preventScroll: true });
}

/** window.localStorage·sessionStorage 는 접근만으로도 예외가 날 수 있다(저장소 차단) */
function storageOf(kind) {
  try {
    return window[kind];
  } catch {
    return null;
  }
}

// --- 불러오기·새로고침 ---------------------------------------------------------

async function fetchData(bust) {
  const file = dataFile(location.search);
  const res = await fetch(bust ? `${file}?ts=${Date.now()}` : file, { cache: bust ? 'no-store' : 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('JSON 형식 오류');
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.projects)) throw new Error('projects 항목 없음');
  return data;
}

async function load() {
  const status = $('status');
  status.className = 'status';
  status.setAttribute('role', 'status');
  status.replaceChildren('사업 목록을 불러오는 중…');
  status.hidden = false;
  try {
    start(await fetchData(false));
    status.hidden = true;
  } catch (err) {
    showError(err instanceof Error && err.message.length < 60 ? err.message : '네트워크 오류');
  }
}

function showError(kind) {
  const status = $('status');
  status.className = 'status error';
  status.setAttribute('role', 'alert');
  const retry = h('button', { type: 'button', class: 'btn' }, '다시 시도');
  retry.addEventListener('click', load);
  // 파일 이름·HTTP 코드는 화면 첫 줄에 두지 않고 접힌 '자세한 오류'와 콘솔에만 남긴다
  const detail = `${dataFile(location.search)} · ${kind}`;
  console.warn(`사업 목록을 불러오지 못함: ${detail}`);
  status.replaceChildren(
    h('b', {}, '사업 목록을 불러오지 못했습니다.'),
    h('span', {}, '연결을 확인하고 다시 시도해 주세요.'),
    h('div', {}, retry),
    h('details', { class: 'err-detail' }, h('summary', {}, '자세한 오류'), h('p', {}, detail)),
  );
  $('app').hidden = true;
  $('refresh-text').textContent = '자료를 불러오지 못했습니다.';
}

/** 새로고침: 자료를 다시 받아 수집 시각이 바뀌었으면 다시 그리고, 새로 생긴 소식 수를 알린다 */
async function refresh() {
  if (state.refreshing) return;
  if (!state.data) {
    load();
    return;
  }
  const btn = $('refresh');
  state.refreshing = true;
  btn.setAttribute('aria-busy', 'true');
  btn.classList.add('spinning');
  $('refresh-text').textContent = '새 소식을 확인하는 중…';
  let message;
  try {
    const data = await fetchData(true);
    const before = state.data.generatedAt;
    if (data.generatedAt !== before) {
      const oldIds = new Set(state.feed.map((f) => f.id));
      start(data, { refreshed: true });
      const n = state.feed.filter((f) => !oldIds.has(f.id)).length;
      message = n ? `새 소식 ${n}건을 받았습니다 (${stampLabel(data.generatedAt) ?? '수집 시각 모름'} 수집분)`
        : `새 자료를 받았지만 새 소식은 없습니다 (${stampLabel(data.generatedAt) ?? '수집 시각 모름'} 수집분)`;
    } else {
      message = `새로 받은 소식은 없습니다 (${stampLabel(before) ?? '수집 시각 모름'} 수집분)`;
    }
  } catch {
    message = '새 소식을 받지 못했습니다. 연결을 확인하고 다시 눌러 주세요.';
  } finally {
    state.refreshing = false;
    btn.removeAttribute('aria-busy');
    btn.classList.remove('spinning');
  }
  $('refresh-text').textContent = message;
}

/** 이번 방문의 NEW 기준: 같은 탭에서 이미 정했으면 그대로, 아니면 지난 기록으로 정하고 탭에 둔다 */
function loadBaseline() {
  const session = storageOf('sessionStorage');
  const visit = readVisit(session);
  if (visit) return visit;
  const baseline = visitBaseline(readSeen(storageOf('localStorage')), state.today);
  writeVisit(session, baseline);
  return baseline;
}

function start(data, { refreshed = false } = {}) {
  state.data = data;
  state.today = kstYmd();
  state.todayYm = state.today.slice(0, 7);
  state.stages = {
    seoul: Array.isArray(data.stages?.seoul) && data.stages.seoul.length ? data.stages.seoul : DEFAULT_STAGES.seoul,
    town: Array.isArray(data.stages?.town) && data.stages.town.length ? data.stages.town : DEFAULT_STAGES.town,
  };
  const valid = data.projects.filter((p) => p && typeof p === 'object' && p.id !== undefined && p.id !== null);
  for (const p of valid) p.id = String(p.id);
  state.projects = sortProjects(valid, state.todayYm);
  state.byId = new Map(state.projects.map((p) => [p.id, p]));
  state.bucket = new Map(state.projects.map((p) => [p.id, bucketOf(p, state.todayYm)]));
  state.hay = new Map(state.projects.map((p) => [p.id, searchText(p)]));
  state.hasFeed = Array.isArray(data.feed);
  state.feed = visibleFeed(cleanFeed(data.feed), state.today);
  state.calendar = cleanCalendar(data.calendar);
  state.watch = cleanWatchlist(data.watchlist);
  if (!refreshed) state.baseline = loadBaseline();
  // 이번에 보여 준 소식은 다음 방문 때 NEW 가 아니다
  writeSeen(storageOf('localStorage'), { ids: state.feed.map((f) => f.id), lastVisit: new Date().toISOString() });

  renderMeta();
  renderSources();
  buildStageSelect();
  $('sample-banner').hidden = data.sample !== true;
  $('app').hidden = false;

  if (!refreshed) {
    // '#gu=<구>' 링크로 들어오면 그 구를 펼친다
    const { district } = parseHash(location.hash);
    if (district && SEOUL_DISTRICTS.has(district)) state.filters = nextFilters(state.filters, 'district', district);
  }
  renderMain();
  applyFilters();
  route(refreshed ? { rerender: true } : { fresh: true });
}

function renderMeta() {
  const when = stampLabel(state.data.generatedAt);
  const last = parseStamp(state.baseline.lastVisit);
  $('refresh-text').textContent = [
    when ? `마지막 수집 ${when}` : '수집 시각 정보 없음',
    last ? `지난 방문 ${last.date.slice(5)}` : null,
  ].filter(Boolean).join(', ');
}

function renderSources() {
  const s = state.data.sources ?? {};
  const items = [];
  if (s.seoul) {
    items.push(h('li', {},
      extLink(s.seoul.url, s.seoul.title || '서울 열린데이터광장 정비사업 추진현황'),
      h('span', { class: 'muted' }, ` · ${s.seoul.asOf ?? '-'} 기준`, typeof s.seoul.count === 'number' ? ` · ${s.seoul.count.toLocaleString('ko-KR')}곳` : '')));
  }
  const townSources = new Map();
  for (const p of state.projects) {
    if (stageGroup(p) !== 'town' || !Array.isArray(p.sources)) continue;
    for (const src of p.sources) {
      const url = safeHttpUrl(src?.url);
      if (url && !townSources.has(url)) townSources.set(url, src);
    }
  }
  if (s.newtowns || townSources.size) {
    items.push(h('li', {},
      h('span', {}, '경기 공공주택지구: 보도·지자체 자료로 정리한 목록'),
      h('span', { class: 'muted' }, s.newtowns?.asOf ? ` · ${s.newtowns.asOf} 확인` : '', typeof s.newtowns?.count === 'number' ? ` · ${s.newtowns.count}곳` : ''),
      townSources.size
        ? h('ul', {}, [...townSources.values()].map((src) => h('li', {}, extLink(src.url, src.title || src.url), src.date ? h('span', { class: 'muted' }, ` · ${src.date}`) : null)))
        : null));
  }
  const curated = s.curatedNews;
  if (curated && !curated.skipped && Number(curated.count) > 0) {
    items.push(h('li', {},
      h('span', {}, '뉴스: 보도 기사를 읽고 한 줄로 요약해 정리한 목록(원문 링크)'),
      h('span', { class: 'muted' }, curated.asOf ? ` · ${curated.asOf} 확인` : '', ` · ${Number(curated.count).toLocaleString('ko-KR')}건`)));
  }
  const naver = s.news;
  if (naver && !naver.skipped) {
    items.push(h('li', {},
      extLink('https://search.naver.com/', '네이버 뉴스 검색'),
      h('span', { class: 'muted' }, ` · 관련 소식: 제목에 사업명이 들어간 최근 2주 기사의 제목·언론사·날짜·링크만 보여 줍니다`,
        typeof naver.matched === 'number' ? ` · 이번 생성에서 ${naver.matched.toLocaleString('ko-KR')}곳` : '')));
  }
  const n = s.notices;
  items.push(h('li', {},
    extLink('https://www.applyhome.co.kr/', '청약홈 분양정보'),
    h('span', { class: 'muted' }, n?.skipped
      ? ` · 이번 생성에서는 공고 연결을 건너뜀(${n.skipped})`
      : n ? ` · 최근 공고 ${Number(n.checked ?? 0).toLocaleString('ko-KR')}건 확인, ${Number(n.linked ?? 0).toLocaleString('ko-KR')}곳 연결` : '')));
  $('source-list').replaceChildren(...items);
}

function buildStageSelect() {
  const select = $('f-stage');
  const groups = [
    ['seoul', '서울 재개발·재건축'],
    ['town', '경기 공공주택지구'],
  ];
  select.replaceChildren(
    h('option', { value: '' }, '모든 단계'),
    ...groups.map(([key, label]) => h('optgroup', { label }, state.stages[key].map((name) => h('option', { value: `${key}:${name}` }, name)))),
  );
}

// --- 첫 화면 ----------------------------------------------------------------

function renderMain() {
  keepFocus($('dash-tiles'), renderTiles);
  keepFocus($('region-box'), renderRegion);
  renderCalendar();
  keepFocus($('feed'), renderFeed);
  keepFocus($('town-cards'), renderTownCards);
  keepFocus($('seoul-sec'), renderSeoul);
}

function renderTiles() {
  const live = receivingNow(state.projects, state.today);
  const fresh = state.feed.filter(isNew);
  const planned = plannedBlocks(state.projects, state.today);
  const soon = seoulSoon(state.projects, bucketFn);
  const f = state.feedFilter;
  const tiles = [
    {
      key: 'live', label: '지금 접수 중', num: live.length, unit: '곳', on: f.kind === '접수' && !f.onlyNew,
      detail: live.length ? live.map((r) => receivingText(r)).join(', ') : '오늘 접수하는 공고가 없습니다',
    },
    {
      key: 'new', label: state.baseline.ids ? '지난 방문 뒤 새 소식' : '최근 7일 새 소식', num: fresh.length, unit: '건', on: f.onlyNew,
      detail: fresh.length ? kindBreakdown(fresh) : '새로 들어온 소식이 없습니다',
    },
    {
      key: 'plan', label: '다음 예정 블록 (보도)', num: planned.length, unit: '곳', on: f.kind === '일정' && !f.onlyNew,
      detail: planned.length ? `${plannedText(planned)}. 보도만 있고 공고 전` : '보도된 다음 블록이 없습니다',
    },
    {
      key: 'soon', label: '1년 안 청약 예상', num: soon.total, unit: '곳', on: null,
      detail: soon.byDistrict.length
        ? `서울 재개발·재건축. ${soon.byDistrict.slice(0, 3).map(([d, n]) => `${shortDistrict(d)} ${n}`).join(', ')} 순`
        : '서울 재개발·재건축 중 1년 안 예상이 없습니다',
    },
  ];
  $('dash-tiles').replaceChildren(...tiles.map((t) => h('button', {
    type: 'button', class: `dtile t-${t.key}`, 'data-tile': t.key, 'data-key': `tile:${t.key}`,
    'aria-pressed': t.on === null ? null : String(t.on),
  },
  h('span', { class: 'dtile-label' }, t.label),
  h('span', { class: 'dtile-num' }, h('b', {}, t.num.toLocaleString('ko-KR')), h('span', {}, t.unit)),
  h('span', { class: 'dtile-detail' }, t.detail),
  t.on === null ? h('span', { class: 'dtile-go' }, '서울 목록 보기') : null)));
}

function pickTile(key) {
  const f = state.feedFilter;
  if (key === 'soon') {
    state.soonGu = null;
    keepFocus($('seoul-sec'), renderSeoul);
    jumpTo('seoul-title');
    return;
  }
  let on;
  if (key === 'new') {
    on = !f.onlyNew;
    state.feedFilter = { kind: 'all', onlyNew: on };
  } else {
    const kind = key === 'live' ? '접수' : '일정';
    on = !(f.kind === kind && !f.onlyNew);
    state.feedFilter = { kind: on ? kind : 'all', onlyNew: false };
  }
  state.feedShown = FEED_PAGE;
  keepFocus($('dash-tiles'), renderTiles);
  renderFeed();
  const n = filterFeed(state.feed, state.feedFilter, isNew).length;
  announce(on ? `새 소식 중 ${feedFilterName()} ${n}건` : `새 소식 전체 ${n}건`);
  if (on) jumpTo('feed-title');
}

function feedFilterName() {
  const f = state.feedFilter;
  return f.onlyNew ? '새 소식' : FEED_KIND_LABEL[f.kind] ?? '전체';
}

/** 지역 현황: 서울 25개 구 칸, 관심 지구 칸, 고른 구의 사업 목록 */
function renderRegion() {
  const stats = tileStats(state.projects, bucketFn);
  const freshProjects = new Set(state.feed.filter(isNew).map((f) => f.projectId));
  const newDistricts = new Set([...freshProjects].map((id) => state.byId.get(id)).filter((p) => p?.region === '서울').map((p) => p.district));
  $('gu-grid').replaceChildren(...SEOUL_ORDER.map((district) => {
    const st = stats.get(district) ?? { n: 0, soon: 0, mid: 0, live: 0 };
    const { main, total } = tileCount(st);
    const fresh = newDistricts.has(district);
    const label = `${district} 1년 안 ${main}곳, 전체 ${total}곳${st.live ? `, 공고 중 ${st.live}곳` : ''}${fresh ? ', 새 소식 있음' : ''}`;
    return h('button', {
      type: 'button', class: ['gu-cell', tileClass(st), total ? '' : 'zero'].filter(Boolean).join(' '),
      'data-district': district, 'data-key': `gu:${district}`, 'aria-pressed': String(state.filters.district === district), 'aria-label': label,
    },
    h('span', { class: 'gu-top' }, h('span', { class: 'gu-name' }, shortDistrict(district)), fresh ? h('span', { class: 'new-tag' }, 'NEW') : null),
    h('span', { class: 'gu-num' }, h('b', {}, String(main)), h('small', {}, `/${total}`)),
    h('span', { class: 'gu-bar', 'aria-hidden': 'true' }, h('span', { style: { width: `${total ? Math.round((main / total) * 100) : 0}%` } })),
    st.live ? h('span', { class: 'gu-live' }, '공고 중') : null);
  }));

  const watch = state.watch.length ? state.watch : state.projects.filter((p) => p.region !== '서울')
    .map((p) => ({ name: p.name, kind: p.subKind ?? p.kind ?? '', region: p.district ?? '', tracked: true, projectId: p.id }));
  $('watch-grid').replaceChildren(...watch.map((w) => {
    const p = w.tracked && w.projectId ? state.byId.get(w.projectId) : null;
    if (!p) {
      return h('div', { class: 'watch-cell untracked', role: 'listitem' },
        h('span', { class: 'watch-name' }, w.name),
        h('span', { class: 'watch-kind' }, [w.kind, w.region].filter(Boolean).join(', ')),
        h('span', { class: 'watch-state' }, w.tracked ? '자료 없음' : '아직 추적하지 않음'));
    }
    const head = townHeadline(p, state.calendar, state.today, state.todayYm);
    const fresh = freshProjects.has(p.id);
    return h('div', { role: 'listitem' }, h('a', {
      class: 'watch-cell', href: linkFor(p, { district: state.filters.district }), 'data-nav': '', 'data-key': `w:${p.id}`, 'data-back': '첫 화면으로',
    },
    h('span', { class: 'watch-top' }, h('span', { class: 'watch-name' }, w.name), fresh ? h('span', { class: 'new-tag' }, 'NEW') : null),
    h('span', { class: 'watch-kind' }, [w.kind, w.region].filter(Boolean).join(', ')),
    h('span', { class: `watch-state tone-${head.tone}` }, head.tone === 'live' && head.label === '지금 접수 중' ? `접수 중: ${head.text}` : `${head.label} ${head.text}`)));
  }));
  renderRegionPanel();
}

function renderRegionPanel() {
  const panel = $('region-panel');
  const district = state.filters.district;
  if (!district) {
    panel.hidden = true;
    panel.replaceChildren();
    return;
  }
  const all = state.projects.filter((p) => p.district === district && p.region === '서울');
  const soon = all.filter((p) => ['live', 'soon'].includes(state.bucket.get(p.id))).length;
  const shown = all.slice(0, REGION_LIST_MAX);
  panel.hidden = false;
  panel.replaceChildren(...[
    h('div', { class: 'rp-head' },
      h('h3', { id: 'rp-title', tabindex: '-1' }, `${district} 정비사업 ${all.length}곳 중 1년 안 ${soon}곳`),
      h('button', { type: 'button', class: 'linkish', 'data-close-region': '', 'data-key': 'rp-close' }, '닫기')),
    h('p', { class: 'note' }, all.length
      ? '예상 시기가 빠른 순입니다. 누르면 사업 화면으로 갑니다.'
      : '이 구에는 지금 자료에 잡힌 정비사업이 없습니다.'),
    all.length ? h('ul', { class: 'rp-list' }, shown.map((p) => {
      const bucket = state.bucket.get(p.id);
      return h('li', {}, h('a', {
        class: 'rp-item', href: linkFor(p, { district }), 'data-nav': '', 'data-key': `rp:${p.id}`, 'data-back': `${district} 사업 목록으로`,
      },
      h('span', { class: 'rp-name' }, p.name ?? ''),
      h('span', { class: `rp-when when-${bucket}` }, bucket === 'live' ? '공고 중' : windowLabel(p, state.todayYm)),
      h('span', { class: 'rp-meta' }, [p.kind, p.stage].filter(Boolean).join(', '))));
    })) : null,
    all.length > shown.length
      ? h('button', { type: 'button', class: 'btn ghost', 'data-show-list': '' }, `${shortDistrict(district)} 사업 ${all.length}곳 모두 목록에서 보기`)
      : null,
  ].filter(Boolean));
}

function renderCalendar() {
  const days = calendarDays(state.calendar, state.today);
  const name = (id) => nameOf(id);
  $('cal').replaceChildren(...days.map((d) => h('li', {
    class: ['cal-day', d.isToday ? 'today' : '', d.weekend ? 'weekend' : '', d.dow === 0 ? 'sun' : ''].filter(Boolean).join(' '),
  },
  h('span', { class: 'cal-num' }, d.label),
  h('span', { class: 'cal-dow' }, d.isToday ? '오늘' : DOW_LABEL[d.dow]),
  d.events.map((e) => h('span', {
    class: `cal-ev ev-${calendarTone(e)}`, title: [nameOf(e.projectId), e.block, e.label, e.title].filter(Boolean).join(' '),
  }, calendarShort(e, name))))));
  const agenda = agendaItems(days, name);
  $('agenda').replaceChildren(...(agenda.length
    ? agenda.map((a) => h('li', {}, h('b', {}, a.date), ` ${a.text}`))
    : [h('li', { class: 'muted' }, '앞으로 3주 안에 잡힌 청약 일정이 없습니다.')]));
}

// --- 새 소식 -------------------------------------------------------------------

function renderFeed() {
  const f = state.feedFilter;
  const counts = feedKindCounts(state.feed);
  const freshN = state.feed.filter(isNew).length;
  const badge = $('new-badge');
  badge.hidden = freshN === 0;
  badge.textContent = `${freshN}건`;
  $('mark-read').hidden = freshN === 0;

  $('feed-kinds').replaceChildren(
    ...['all', ...FEED_KINDS].map((k) => h('button', {
      type: 'button', class: 'fchip', 'data-kind': k, 'data-key': `kind:${k}`, 'aria-pressed': String(f.kind === k && !f.onlyNew),
    }, FEED_KIND_LABEL[k], h('span', { class: 'fchip-n' }, String(counts[k])))),
    h('button', {
      type: 'button', class: 'fchip only-new', 'data-only-new': '', 'data-key': 'only-new', 'aria-pressed': String(f.onlyNew),
    }, '새 소식만', h('span', { class: 'fchip-n' }, String(freshN))),
  );

  const list = filterFeed(state.feed, f, isNew);
  const shown = list.slice(0, state.feedShown);
  const box = $('feed-list');
  if (!state.feed.length) {
    box.replaceChildren(h('li', { class: 'feed-empty' }, state.hasFeed
      ? '최근 400일 안에 모은 소식이 없습니다.'
      : '이 자료에는 새 소식 목록이 없습니다. 자료를 새로 만들면 나타납니다.'));
  } else if (!list.length) {
    box.replaceChildren(h('li', { class: 'feed-empty' },
      h('p', {}, f.onlyNew ? '지난 방문 뒤 새로 들어온 소식이 없습니다.' : `${FEED_KIND_LABEL[f.kind]} 소식이 없습니다.`),
      h('button', { type: 'button', class: 'btn', 'data-feed-reset': '' }, '모든 소식 보기')));
  } else {
    box.replaceChildren(...shown.map(feedRow));
  }
  const more = $('feed-more');
  const rest = list.length - shown.length;
  more.hidden = rest <= 0;
  more.textContent = `더 보기 (${Math.min(FEED_PAGE, rest)}건 더 · ${shown.length}/${list.length})`;
}

/** 새 소식 한 줄: 날짜·종류 | NEW·사업·블록, 요약, 출처 */
function feedRow(f) {
  const p = state.byId.get(f.projectId);
  const fresh = isNew(f);
  return h('li', { class: `frow${fresh ? ' is-new' : ''}` },
    h('div', { class: 'frow-when' },
      h('span', { class: 'frow-date' }, shortDate(f.date, state.today)),
      h('span', { class: `ktag ${FEED_KIND_CLASS[f.kind]}` }, f.kind)),
    h('div', { class: 'frow-body' },
      h('span', { class: 'frow-meta' },
        fresh ? h('span', { class: 'new-tag' }, 'NEW') : null,
        p ? h('a', {
          class: 'frow-proj', href: linkFor(p, { block: itemBlockSel(f, p), district: state.filters.district }), 'data-nav': '', 'data-key': `f:${f.id}`, 'data-back': '새 소식으로',
        }, projectLabel(p)) : null,
        f.block ? h('span', { class: 'btag' }, f.block) : null,
        f.rental ? h('span', { class: 'rent-tag' }, '임대') : null),
      h('span', { class: 'frow-title' }, f.title),
      sourceLine(f, 'frow-src')));
}

/** 소식의 출처 줄: '메트로신문 2026-11-03'(링크), 지역지면 꼬리표. 네이버 관련 소식은 '언론사 · 날짜'(원문 링크)와 '검색: NAVER' */
function sourceLine(f, cls) {
  if (isNaverItem(f)) {
    return h('span', { class: cls },
      extLink(f.source.url, newsMetaText({ outlet: f.source.title, date: f.source.date ?? f.date }) || '원문'),
      ' ', h('small', { class: 'news-credit' }, NEWS_CREDIT));
  }
  if (!f.source.url && !f.source.title) return null;
  const local = f.source.local && !/지역지/.test(`${f.source.title ?? ''} ${f.title}`);
  return h('span', { class: cls }, extLink(f.source.url, feedSourceLabel(f.source)), local ? h('span', { class: 'local-tag' }, '지역지') : null);
}

/** 소식에서 지구 화면으로 갈 때 고를 블록(첫 블록, 분양·임대가 함께 있는 블록이면 rental 로) */
function itemBlockSel(f, p) {
  const first = f.block ? f.block.split(/[·,/]/)[0].trim() : null;
  if (!first || !isTownView(p)) return null;
  return f.rental && splitBlocks(blockRows(p, state.today)).has(blockKey(first)) ? `${first}${RENTAL_SUFFIX}` : first;
}

/** 지구·사업 화면의 소식 줄(세로 선 위 점) */
function timelineItem(f, { showBlock = true } = {}) {
  const fresh = isNew(f);
  return h('li', { class: `tl-item${fresh ? ' is-new' : ''}` },
    h('span', { class: 'tl-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'tl-meta' },
      fresh ? h('span', { class: 'new-tag' }, 'NEW') : null,
      h('b', {}, f.date.slice(2).replace(/-/g, '.')),
      h('span', { class: `ktag ${FEED_KIND_CLASS[f.kind]}` }, f.kind),
      showBlock && f.block ? h('span', { class: 'btag' }, f.block) : null,
      f.rental ? h('span', { class: 'rent-tag' }, '임대') : null),
    h('span', { class: 'tl-title' }, f.title),
    sourceLine(f, 'tl-src'));
}

function markAllRead() {
  state.baseline = { ids: new Set(state.feed.map((f) => f.id)), since: null, lastVisit: state.baseline.lastVisit };
  writeVisit(storageOf('sessionStorage'), state.baseline);
  if (state.feedFilter.onlyNew) state.feedFilter = { kind: 'all', onlyNew: false };
  renderMain();
  if (state.route?.kind !== 'main') route({ rerender: true });
  $('feed-title').focus();
  announce('모든 소식을 읽음으로 표시했습니다');
}

function renderTownCards() {
  const towns = state.projects.filter((p) => p.region !== '서울' && p.kind === '공공주택지구')
    .sort((a, b) => Number(isTownView(b)) - Number(isTownView(a)));
  if (!towns.length) {
    $('town-cards').replaceChildren(h('p', { class: 'note' }, '이 자료에는 신도시·공공주택지구가 없습니다.'));
    return;
  }
  $('town-cards').replaceChildren(...towns.map((p) => {
    const rows = isTownView(p) ? blockRows(p, state.today) : [];
    const groups = townGroupCounts(rows);
    const blocks = new Set(rows.map((r) => blockKey(r.block))).size;
    const freshN = state.feed.filter((f) => f.projectId === p.id && isNew(f)).length;
    const head = townHeadline(p, state.calendar, state.today, state.todayYm);
    const meta = [placeLabel(p), typeof p.households === 'number' ? fmtCount(p.households) : null,
      blocks ? `출처가 있는 블록 ${blocks}곳` : `${p.stage ?? ''} 단계`].filter(Boolean).join(', ');
    return h('a', { class: 'tcard', href: linkFor(p, { district: state.filters.district }), 'data-nav': '', 'data-key': `tc:${p.id}`, 'data-back': '첫 화면으로' },
      h('span', { class: 'tcard-top' }, h('span', { class: 'tcard-name' }, p.name ?? ''), freshN ? h('span', { class: 'new-pill' }, `새 소식 ${freshN}`) : null),
      h('span', { class: 'tcard-meta' }, meta),
      groups.length
        ? [
          h('span', { class: 'segbar', 'aria-hidden': 'true' }, groups.map((g) => h('span', { class: `segpart g-${g.key}`, style: { flexGrow: String(g.n) } }))),
          h('span', { class: 'seglegend' }, groups.map((g) => h('span', {}, h('span', { class: `key g-${g.key}`, 'aria-hidden': 'true' }), `${g.label} ${g.n}`))),
        ]
        : h('span', { class: 'seglegend muted' }, isTownView(p) ? '출처가 있는 블록 정보가 아직 없습니다' : '블록 정보 없음 (블록은 지구계획 승인 뒤 정해짐)'),
      h('span', { class: `tcard-next tone-${head.tone}` }, `${head.label} ${head.text}`));
  }));
}

// --- 서울 요약 -----------------------------------------------------------------

function renderSeoul() {
  const seoul = state.projects.filter((p) => p.region === '서울');
  const src = state.data.sources?.seoul;
  $('seoul-title').textContent = `서울 재개발·재건축 ${seoul.length.toLocaleString('ko-KR')}곳`;
  $('seoul-asof').textContent = src?.asOf ? `서울시 정비사업 추진현황 ${monthLabel(src.asOf)} 기준 (분기마다 갱신)` : '서울시 정비사업 추진현황';

  const stages = state.stages.seoul;
  const counts = stages.map((name) => ({ name, n: seoul.filter((p) => p.stage === name).length }));
  const max = Math.max(1, ...counts.map((c) => c.n));
  const near = stages.indexOf(NEAR_SALE_STAGE);
  const pipe = $('pipe');
  pipe.setAttribute('aria-label', `단계별 사업 수: ${counts.map((c) => `${c.name} ${c.n}곳`).join(', ')}`);
  pipe.replaceChildren(...counts.map((c, i) => h('div', { class: 'pipe-col' },
    h('div', { class: 'pipe-box' }, h('span', { class: `pipe-bar${near >= 0 && i >= near ? ' near' : ''}`, style: { height: `${Math.round((c.n / max) * 100)}%` } })),
    h('span', { class: 'pipe-n' }, String(c.n)),
    h('span', { class: 'pipe-name' }, c.name))));

  const soonAll = seoul.filter((p) => ['live', 'soon'].includes(state.bucket.get(p.id)));
  const gu = state.soonGu;
  const soon = gu ? soonAll.filter((p) => p.district === gu) : soonAll;
  $('soon-title').textContent = `1년 안에 청약이 예상되는 사업 ${soonAll.length}곳${gu ? ` 중 ${gu} ${soon.length}곳` : ''}`;
  $('soon-list').replaceChildren(...(soon.length ? soon.slice(0, SOON_LIST_MAX).map((p) => {
    const bucket = state.bucket.get(p.id);
    return h('li', {}, h('a', { class: 'soon-item', href: linkFor(p, { district: state.filters.district }), 'data-nav': '', 'data-key': `soon:${p.id}`, 'data-back': '서울 목록으로' },
      h('span', { class: 'soon-name' }, p.name ?? ''),
      h('span', { class: `soon-when when-${bucket}` }, bucket === 'live' ? '공고 중' : (windowRangeLabel(p, state.todayYm) ?? '')),
      h('span', { class: 'soon-meta' }, [p.district, p.kind].filter(Boolean).join(' ') + (p.stage ? `, ${p.stage}` : '')),
      p.windowBasis ? h('span', { class: 'soon-basis' }, p.windowBasis) : null));
  }) : [h('li', { class: 'note' }, '1년 안에 청약이 예상되는 사업이 없습니다.')]));
  const moreSoon = $('soon-all');
  moreSoon.hidden = soon.length <= SOON_LIST_MAX;
  moreSoon.textContent = `${gu ? `${gu} ` : ''}1년 안 사업 ${soon.length}곳 모두 목록에서 보기`;

  const top = seoulSoon(state.projects, bucketFn).byDistrict.slice(0, GU_CHIPS_MAX);
  $('gu-chips').replaceChildren(...top.map(([d, n]) => h('button', {
    type: 'button', class: 'fchip', 'data-soon-gu': d, 'data-key': `sg:${d}`, 'aria-pressed': String(gu === d),
  }, d, ' ', h('b', {}, String(n)))));
}

function pickSoonGu(district) {
  state.soonGu = state.soonGu === district ? null : district;
  keepFocus($('seoul-sec'), renderSeoul);
  announce($('soon-title').textContent);
}

/** '모두 목록에서 보기': 전체 사업 목록을 서울·1년 안(골랐으면 그 구)으로 좁혀 보여 준다 */
function showSoonInList() {
  let f = nextFilters(DEFAULT_FILTERS, 'area', '서울');
  f = nextFilters(f, 'when', '12');
  state.filters = { ...f, district: state.soonGu ?? null };
  applyFilters();
  writeMainHash();
  jumpTo('list-title');
}

// --- 전체 사업 목록(필터) ---------------------------------------------------------

function applyFilters({ keepPage = false } = {}) {
  const { district, ...rest } = state.filters;
  state.base = state.projects.filter((p) => matchesFilters(p, rest, state.todayYm, state.bucket.get(p.id), state.hay.get(p.id)));
  state.visible = district ? state.base.filter((p) => p.district === district) : state.base;
  if (!keepPage) state.shown = PAGE_SIZE;
  syncFilterControls();
  keepFocus($('list'), renderList);
  keepFocus($('region-box'), renderRegion);
}

function syncFilterControls() {
  for (const btn of document.querySelectorAll('[data-filter]')) {
    btn.setAttribute('aria-pressed', String(state.filters[btn.dataset.filter] === btn.dataset.value));
  }
  // 경기는 공공주택지구뿐이라 유형(재개발·재건축)을 고를 수 없다
  const locked = kindLocked(state.filters);
  // disabled 대신 aria-disabled: 포커스가 남고 화면 읽기 프로그램이 이유(kind-locked-note)를 읽는다. 누르면 nextFilters 가 무시한다
  for (const btn of document.querySelectorAll('[data-filter="kind"]')) {
    if (locked) {
      btn.setAttribute('aria-disabled', 'true');
      btn.setAttribute('aria-describedby', 'kind-locked-note');
    } else {
      btn.removeAttribute('aria-disabled');
      btn.removeAttribute('aria-describedby');
    }
  }
  $('f-stage').value = state.filters.stage;
  if ($('f-q').value !== state.filters.q) $('f-q').value = state.filters.q;
  $('filters-summary').textContent = filterSummary(state.filters);
}

function setFilter(key, value) {
  state.filters = nextFilters(state.filters, key, value);
  applyFilters();
  writeMainHash();
}

function resetFilters() {
  state.filters = { ...DEFAULT_FILTERS };
  applyFilters();
  writeMainHash();
  announce(`필터 초기화, ${state.visible.length}곳`);
}

function clearQuery() {
  state.filters = nextFilters(state.filters, 'q', '');
  applyFilters();
  $('list-title').focus({ preventScroll: true });
  announce(`검색어를 지웠습니다, ${state.visible.length}곳`);
}

function listItem(p) {
  const range = windowRangeLabel(p, state.todayYm);
  const sold = stageGroup(p) === 'town' ? latestSale(p) : null;
  const news = projectNewsCount(state.feed, p.id);
  return h('a', {
    class: 'item', href: linkFor(p, { district: state.filters.district }), 'data-nav': '', 'data-key': `li:${p.id}`, 'data-back': '사업 목록으로',
  },
  h('span', { class: 'item-name' }, p.name ?? ''),
  chip(state.bucket.get(p.id)),
  h('span', { class: 'meta' },
    h('span', {}, p.kind ?? ''),
    h('span', {}, p.region === '서울' ? shortDistrict(p.district) : placeLabel(p)),
    h('span', {}, p.stage ?? ''),
    range ? h('span', {}, `${windowPrefix(p)} ${range}`) : null,
    sold ? h('span', {}, `최근 분양 ${sold}`) : null,
    news ? h('span', {}, `소식 ${news}`) : null));
}

/** 결과가 없을 때의 안내 하나: 걸린 조건과 되돌릴 버튼 */
function emptyBlock() {
  const e = emptyState(state.filters);
  return h('div', { class: 'no-results' },
    h('p', { class: 'no-results-title' }, e.title),
    e.conditions.length ? h('p', { class: 'note' }, `걸린 조건: ${e.conditions.join(' · ')}`) : null,
    e.clearQuery || e.reset
      ? h('div', { class: 'no-results-actions' },
        e.clearQuery ? h('button', { type: 'button', class: 'btn', 'data-empty': 'clear-q' }, '검색어 지우기') : null,
        e.reset ? h('button', { type: 'button', class: e.clearQuery ? 'btn ghost' : 'btn', 'data-empty': 'reset' }, '필터 초기화') : null)
      : null);
}

function renderList() {
  const f = state.filters;
  const total = state.visible.length;
  const shown = state.visible.slice(0, state.shown);
  const areaLabel = f.area === '서울' ? '서울 사업' : f.area === TOWN_AREA ? '경기 공공주택지구' : '전체 사업';
  $('list-title').textContent = f.district ? `${f.district} 사업` : areaLabel;
  $('list-count').textContent = `${total.toLocaleString('ko-KR')}곳`;
  $('clear-district').hidden = !f.district;
  $('list').replaceChildren(...(total ? shown.map(listItem) : [emptyBlock()]));
  const more = $('more');
  const rest = total - shown.length;
  more.hidden = rest <= 0;
  more.textContent = `더 보기 (${Math.min(PAGE_SIZE, rest)}곳 더 · ${shown.length}/${total})`;
}

function showMore() {
  const first = state.shown;
  state.shown += PAGE_SIZE;
  renderList();
  const el = $('list').children[first];
  if (el) el.focus();
  else $('list-title').focus?.();
}

function showMoreFeed() {
  const first = state.feedShown;
  state.feedShown += FEED_PAGE;
  renderFeed();
  const link = $('feed-list').children[first]?.querySelector('a, button');
  if (link) link.focus();
}

// --- 주소 기록(뒤로 가기)과 화면 바꾸기 --------------------------------------------

/** 첫 화면 상태(구 선택)를 주소에 바꿔 쓴다(기록을 늘리지 않음) */
function writeMainHash() {
  if (state.route?.kind !== 'main') return;
  const hash = hashFor({ district: state.filters.district });
  if (hash === location.hash || (!hash && !location.hash)) return;
  history.replaceState(history.state, '', hash || `${location.pathname}${location.search}`);
}

/**
 * 사업·지구 화면으로 간다: 지금 기록에 돌아올 자리(data-key)를 남기고 새 기록을 쌓는다.
 * 휴대폰 뒤로 가기·'← …으로'가 사이트를 떠나지 않고 누른 자리로 돌아온다.
 */
function openLink(href, { key = null, back = null } = {}) {
  // 첫 화면에서 펼친 구는 돌아올 때 그대로 펼쳐 두도록 주소에 함께 담는다
  const parsed = { ...parseHash(href), district: state.filters.district };
  if (state.route?.kind === 'main') history.replaceState({ ...(history.state ?? {}), returnKey: key }, '');
  history.pushState({ pushed: 'view', back: back ?? '첫 화면으로' }, '', hashFor(parsed) || `${location.pathname}${location.search}`);
  route();
}

/** '← …으로': 우리가 쌓은 기록이면 브라우저 뒤로 가기와 같게, 아니면(링크로 바로 들어옴) 첫 화면으로 바꿔 쓴다 */
function leaveView() {
  if (history.state?.pushed === 'view') {
    history.back();
    return;
  }
  history.replaceState(null, '', hashFor({ district: state.filters.district }) || `${location.pathname}${location.search}`);
  route();
}

/** 지금 주소에 맞는 화면을 그린다. 같은 화면이면 다시 그리지 않는다(rerender 면 다시) */
function route({ fresh = false, rerender = false } = {}) {
  const parsed = parseHash(location.hash);
  const r = routeOf(parsed, (id) => isTownView(state.byId.get(id)));
  const prev = state.route;
  state.route = r;
  const view = $('view');
  if (r.kind === 'main') {
    view.hidden = true;
    view.replaceChildren();
    $('main-view').hidden = false;
    document.title = '분양 예정 지도';
    if (prev && prev.kind !== 'main') restoreReturn();
    return;
  }
  const same = prev && prev.kind === r.kind && prev.id === r.id && !rerender;
  $('main-view').hidden = true;
  view.hidden = false;
  if (same && r.kind === 'town') {
    if (!sameBlock(state.townBlock, r.block)) {
      state.townBlock = r.block;
      keepFocus(view, () => { renderTownBlocks(); renderTownNews(); });
    }
    return;
  }
  if (same) return;
  if (r.kind === 'town') renderTownView(r.id, r.block);
  else renderProjectView(r.id);
  const p = state.byId.get(r.id);
  document.title = p ? `${p.name} · 분양 예정 지도` : '분양 예정 지도';
  if (rerender) return;
  window.scrollTo(0, 0);
  // 새 화면의 제목으로 포커스를 옮긴다(화면 읽기 프로그램이 새 화면을 읽게). 링크로 처음 들어왔을 때는 그대로 둔다
  if (!fresh) $('view-title')?.focus({ preventScroll: true });
}

/** 첫 화면으로 돌아오면 누른 자리로 스크롤하고 포커스 */
function restoreReturn() {
  const key = history.state?.returnKey ?? null;
  const el = key ? [...$('main-view').querySelectorAll('[data-key]')].find((x) => x.getAttribute('data-key') === key) : null;
  if (el) {
    el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
  } else {
    window.scrollTo(0, 0);
  }
}

/** 뒤로·앞으로 가기(popstate)와 주소창에서 해시를 바꾼 경우(hashchange). 둘 다 와도 한 번만 바꾼다 */
function syncFromHash() {
  if (!state.data || !isStateHash(location.hash)) return; // '#sources' 같은 문서 안 이동은 그대로 둔다
  const { district } = parseHash(location.hash);
  const gu = district && SEOUL_DISTRICTS.has(district) ? district : null;
  const quiet = state.quietPop;
  state.quietPop = false;
  const wasMain = state.route?.kind === 'main';
  if (gu !== state.filters.district) {
    state.filters = nextFilters(state.filters, 'district', gu);
    applyFilters();
    // 첫 화면에서 구 선택만 바뀌었으면(휴대폰 뒤로 가기) 지역 현황으로
    if (wasMain && !quiet && parseHash(location.hash).id === null && !parseHash(location.hash).town) {
      $('region-box').scrollIntoView({ block: 'start' });
    }
  }
  route();
}

/**
 * 구 칸을 누르면 그 구의 사업 목록을 펼친다(다시 누르면 접음). 좁은 화면에서는 펼칠 때 기록을 하나 남겨
 * 뒤로 가기가 목록을 접게 하고, 그 기록에서 접으면 기록을 하나 되돌린다(켜고 끄기를 반복해도 기록이 쌓이지 않게).
 */
function toggleDistrict(district) {
  const next = state.filters.district === district ? null : district;
  state.filters = nextFilters(state.filters, 'district', next);
  applyFilters();
  const phone = narrow.matches;
  const url = hashFor({ district: next }) || `${location.pathname}${location.search}`;
  if (phone && !next && history.state?.pushed === 'district') {
    state.quietPop = true;
    history.back();
  } else if (phone && next && history.state?.pushed !== 'district') {
    history.pushState({ pushed: 'district' }, '', url);
  } else {
    history.replaceState(history.state, '', url);
  }
  if (next && phone) {
    $('region-panel').scrollIntoView({ block: 'start' });
    $('rp-title')?.focus({ preventScroll: true });
  }
  const n = state.projects.filter((p) => p.district === next).length;
  announce(next ? `${next} 사업 ${n}곳을 펼쳤습니다` : '구 목록을 닫았습니다');
}

const narrow = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 820px)') : { matches: false };

// --- 화면 공통 조각 ---------------------------------------------------------------

function backLink() {
  const label = history.state?.pushed === 'view' && typeof history.state.back === 'string' ? history.state.back : '첫 화면으로';
  return h('a', { class: 'back', href: hashFor({ district: state.filters.district }) || '#', 'data-leave': '' }, icon(ICON_BACK), label);
}

function sourceLink(src) {
  const label = `${sourceOutlet(src)}${src?.date ? ` ${src.date}` : ''}`;
  const url = safeHttpUrl(src?.url);
  return url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', title: src.title || null }, label) : h('span', {}, label);
}

const joinLinks = (sources) => sources.flatMap((src, i) => (i ? [' · ', sourceLink(src)] : [sourceLink(src)]));

/** 지구·사업 화면을 바꿔 그린다(없는 조각 null 은 뺀다) */
function setView(...nodes) {
  $('view').replaceChildren(...nodes.filter(Boolean));
}

/**
 * 블록 카드 안의 분양 성과: 대표 주택형 분양가, 경쟁률(출처), 주변 시세 비교(공고 당시·현재 기준)와 안내.
 * 숫자를 숨긴 항목은 사유를 보인다. 모든 글자는 텍스트 노드, 주소는 safeHttpUrl 을 거친다(h).
 */
function performanceBox(block, perf) {
  const muted = (text) => h('span', { class: 'muted' }, text);
  const price = performancePriceText(perf.representative);
  const comp = competitionText(perf.competition);
  const c = perf.competition;
  const compSource = !c ? null
    : c.api ? muted(` · ${LIVE_COMPETITION_NOTE}`)
      : [' · ', c.ref ? sourceLink(c.ref) : muted('보도')];
  const market = marketLines(perf);
  const points = market.points.map((pt) => h('li', { class: pt.shown ? null : 'muted' }, pt.text));
  const head = [perf.noticeDate ? `공고 ${perf.noticeDate}` : null, perf.name].filter(Boolean).join(' · ');
  return h('div', { class: 'perf', role: 'group', 'aria-label': `${block} 분양 성과` },
    h('p', { class: 'perf-head' },
      h('b', {}, '분양 성과'),
      head ? [' ', muted(head)] : null,
      perf.noticeUrl ? [' ', h('a', { href: perf.noticeUrl, target: '_blank', rel: 'noopener noreferrer' }, '청약홈 공고')] : null),
    h('dl', { class: 'perf-list' },
      h('dt', {}, '분양가'),
      h('dd', {}, price
        ? [price, perf.typeCount > 1 ? muted(` · 주택형 ${perf.typeCount}개 중`) : null]
        : muted(perf.pricesReason ?? '분양가 정보 없음')),
      h('dt', {}, '경쟁률'),
      h('dd', {}, comp ? [comp, compSource] : muted(perf.competitionReason ?? '경쟁률 정보 없음')),
      h('dt', {}, '주변 시세 비교'),
      h('dd', {},
        points.length ? h('ul', { class: 'perf-points' }, points) : muted(perf.marketReason ?? '시세 비교 없음'),
        market.caveat ? h('small', { class: 'perf-caveat' }, market.caveat) : null)));
}

function renderMissing(id) {
  setView(
    backLink(),
    h('header', { class: 'vhead' }, h('div', { class: 'vhead-main' },
      h('h2', { class: 'vtitle', tabindex: '-1', id: 'view-title' }, '사업을 찾지 못했습니다'),
      h('p', { class: 'note' }, `링크의 사업(${id})이 이번 자료에 없습니다. 구역 정리나 이름 변경으로 빠졌을 수 있습니다.`))));
}

// --- 지구 화면 --------------------------------------------------------------------

function renderTownView(id, block) {
  const p = state.byId.get(id);
  if (!p) {
    renderMissing(id);
    return;
  }
  state.townBlock = block ?? null;
  const rows = blockRows(p, state.today);
  const head = townHeadline(p, state.calendar, state.today, state.todayYm);
  const totalText = blockTotalText(p.blockTotal);
  const totalSrc = cleanLinks(p.blockTotal?.sources)[0] ?? null;
  const groups = townGroupCounts(rows);
  const blocks = new Set(rows.map((r) => blockKey(r.block))).size;
  setView(
    backLink(),
    h('header', { class: 'vhead' },
      h('div', { class: 'vhead-main' },
        h('p', { class: 'vmeta' }, [`${placeLabel(p)} ${p.subKind ?? p.kind ?? ''}`.trim(), typeof p.households === 'number' ? `계획 ${fmtCount(p.households)}` : null, p.stage ? `${p.stage} 단계` : null].filter(Boolean).join(', ')),
        h('h2', { class: 'vtitle', tabindex: '-1', id: 'view-title' }, p.name ?? ''),
        totalText ? h('p', { class: 'note' }, totalSrc ? extLink(totalSrc.url, totalText) : totalText) : null),
      h('div', { class: `vstatus tone-${head.tone}` },
        h('span', { class: 'vstatus-label' }, head.label),
        h('span', { class: 'vstatus-main' }, head.text),
        windowBasisNote(p) ? h('span', { class: 'vstatus-note' }, windowBasisNote(p)) : null)),
    groups.length ? h('ul', { class: 'gcounts', 'aria-label': '묶음별 블록 수' }, groups.map((g) => h('li', { class: `gc g-${g.key}` },
      h('b', {}, String(g.n)), h('span', {}, g.label)))) : null,
    h('div', { class: 'town-cols' },
      h('section', { class: 'blocks-sec', 'aria-labelledby': 'blk-title' },
        h('div', { class: 'sec-head' },
          h('h3', { id: 'blk-title' }, rows.length ? `블록 ${blocks}곳` : '블록'),
          rows.length ? h('p', { class: 'note' }, '블록을 누르면 그 블록 소식만 보입니다') : null),
        h('ul', { class: 'bgrid', id: 'bgrid' }),
        rows.length
          ? h('details', { class: 'fold note' },
            h('summary', {}, '출처로 확인한 블록만 보여 줍니다. ', h('span', { class: 'fold-more' }, '자세히')),
            h('p', {}, '사업승인 날짜는 승인일을 모르면 보도일이고, 유형이 출처에 없으면 "유형 미확인"입니다. '
              + '분양과 임대가 함께 있는 블록은 카드를 나누지만 소식은 블록 이름으로 묶습니다.'
              + (rows.some((r) => r.performance)
                ? ' 분양 성과의 시세 비교는 주변 단지 실거래로 추정한 신축 환산 값이며, 신뢰도가 낮거나 차익 공유 유형이면 숫자를 보이지 않습니다.'
                : '')
              + (totalText ? ' 위 전체 블록 수 문구는 그 출처가 보도한 수치라 카드 수와 같은 기준이 아닙니다.' : '')))
          : null),
      h('section', { class: 'tnews', 'aria-labelledby': 'tnews-title' },
        h('div', { class: 'sec-head' }, h('h3', { id: 'tnews-title', tabindex: '-1' }), h('span', { id: 'tnews-reset' })),
        h('div', { class: 'chips', id: 'tnews-chips', role: 'group', 'aria-label': '블록으로 소식 거르기' }),
        h('ol', { class: 'tline', id: 'tnews-list' }),
        h('p', { class: 'note' }, '소식은 하루 두 번 모읍니다. 뉴스 제목은 기사 내용을 요약한 것이고, 원문은 링크로 봅니다. ',
          '"검색: NAVER" 표시 기사는 언론사 제목 그대로이며 제목에서 블록 이름을 읽지 못하면 지구 전체로 묶습니다.'))),
    typeof p.notes === 'string' && p.notes.trim() ? h('details', { class: 'memo' }, h('summary', {}, '조사 메모'), h('p', {}, p.notes)) : null,
  );
  renderTownBlocks();
  renderTownNews();
}

function townProject() {
  return state.route?.kind === 'town' ? state.byId.get(state.route.id) : null;
}

function renderTownBlocks() {
  const p = townProject();
  const grid = $('bgrid');
  if (!p || !grid) return;
  const rows = blockRows(p, state.today);
  const split = splitBlocks(rows);
  const items = state.feed.filter((f) => f.projectId === p.id);
  if (!rows.length) {
    grid.replaceChildren(h('li', { class: 'note' }, '출처가 있는 블록 정보가 아직 없습니다.'));
    return;
  }
  grid.replaceChildren(...rows.map((r, i) => {
    const group = townGroupOf(r);
    const sel = blockSel(r, split);
    const mine = items.filter((f) => inBlock(f, sel, split));
    const freshN = mine.filter(isNew).length;
    const on = sameBlock(state.townBlock, sel);
    const what = [r.households !== null ? fmtCount(r.households) : null, r.rental ? '임대' : null, blockDateLabel(r) || null].filter(Boolean).join(', ');
    return h('li', { class: `bcard g-${group}${r.rental ? ' is-rent' : ''}${on ? ' is-on' : ''}` },
      h('button', {
        type: 'button', class: 'bcard-hit', 'data-block': sel, 'data-key': `b:${sel}#${i}`, 'aria-pressed': String(on),
      },
      h('span', { class: 'bcard-top' },
        h('span', { class: 'badge' }, r.block),
        h('span', { class: 'bcard-chips' }, h('span', { class: `chip ${BLOCK_STATUS_CLASS[r.status]}` }, r.status), r.rental ? h('span', { class: 'chip c-rent' }, '임대') : null)),
      h('span', { class: `bcard-title${r.type ? '' : ' muted'}` }, blockTypeLabel(r))),
      what ? h('p', { class: 'bcard-meta' }, what) : null,
      h('ol', { class: 'bsteps', 'aria-label': `${r.block} 진행` }, blockSteps(r).map((s) => h('li', { class: `st-${s.state}` },
        h('span', { class: 'visually-hidden' }, s.state === 'done' ? '지난 단계: ' : s.state === 'now' ? '지금: ' : '다음: '),
        s.label, s.date ? h('small', {}, s.date) : null))),
      r.performance ? performanceBox(r.block, r.performance) : null,
      r.note ? h('p', { class: 'bcard-note' }, r.note) : null,
      r.sources.length ? h('p', { class: 'bcard-src' }, '출처 ', joinLinks(r.sources)) : null,
      h('p', { class: 'bcard-foot' },
        h('span', { class: 'bcard-latest' }, blockLatestText(mine, state.today)),
        freshN ? h('span', { class: 'new-pill' }, `새 소식 ${freshN}`) : mine.length ? h('span', { class: 'muted' }, `소식 ${mine.length}`) : null));
  }));
}

function townNewsTitle(block, n) {
  if (block === WHOLE_TOWN) return `지구 전체 소식 ${n}건`;
  if (block) return `${block} 블록 소식 ${n}건`;
  return `지구 소식 ${n}건`;
}

function renderTownNews() {
  const p = townProject();
  if (!p || !$('tnews-list')) return;
  const sel = state.townBlock;
  const rows = blockRows(p, state.today);
  const split = splitBlocks(rows);
  const items = state.feed.filter((f) => f.projectId === p.id);
  const shown = items.filter((f) => inBlock(f, sel, split));
  $('tnews-title').textContent = townNewsTitle(sel, shown.length);
  $('tnews-reset').replaceChildren(sel ? h('button', { type: 'button', class: 'linkish', 'data-block': '', 'data-key': 'tn-reset' }, '모든 소식 보기') : '');
  const names = [];
  for (const r of rows) {
    const value = blockSel(r, split);
    if (!names.some((x) => sameBlock(x, value))) names.push(value);
  }
  for (const f of items) {
    for (const part of String(f.block ?? '').split(/[·,/]/).map((x) => x.trim()).filter(Boolean)) {
      const value = f.rental && split.has(blockKey(part)) ? `${part}${RENTAL_SUFFIX}` : part;
      if (!names.some((x) => sameBlock(x, value))) names.push(value);
    }
  }
  const chipFor = (value, label, n) => h('button', {
    type: 'button', class: 'fchip', 'data-block': value, 'data-key': `tc-chip:${value}`, 'aria-pressed': String(sameBlock(sel, value || null)),
  }, label, h('span', { class: 'fchip-n' }, String(n)));
  const whole = items.filter((f) => inBlock(f, WHOLE_TOWN)).length;
  $('tnews-chips').replaceChildren(...[
    chipFor('', '전체', items.length),
    ...[...names].sort(naturalBlock).map((b) => [b, items.filter((f) => inBlock(f, b, split)).length]).filter(([b, n]) => n > 0 || sameBlock(sel, b)).map(([b, n]) => chipFor(b, b, n)),
    whole || sel === WHOLE_TOWN ? chipFor(WHOLE_TOWN, '지구 전체', whole) : null,
  ].filter(Boolean));
  const empty = sel && sel !== WHOLE_TOWN ? (() => {
    const row = rows.find((r) => sameBlock(blockSel(r, split), sel));
    return h('li', { class: 'tl-empty' }, '이 블록으로 모은 소식이 아직 없습니다.', row?.sources.length ? [' 출처: ', joinLinks(row.sources)] : null);
  })() : h('li', { class: 'tl-empty' }, '이 지구로 모은 소식이 아직 없습니다.');
  $('tnews-list').replaceChildren(...(shown.length ? shown.map((f) => timelineItem(f, { showBlock: !sel || sel === WHOLE_TOWN })) : [empty]));
}

/** 블록 카드·칩: 같은 블록을 다시 누르면 지구 소식 전체로 */
function pickBlock(block, { fromCard = false } = {}) {
  const r = state.route;
  if (r?.kind !== 'town') return;
  const next = block && !sameBlock(state.townBlock, block) ? block : null;
  state.townBlock = next;
  state.route = { ...r, block: next };
  history.replaceState(history.state, '', hashFor({ district: state.filters.district, town: r.id, block: next }));
  keepFocus($('view'), () => {
    renderTownBlocks();
    renderTownNews();
  });
  announce($('tnews-title').textContent);
  // 휴대폰에서는 소식이 카드 아래에 있어 카드를 누르면 소식으로 내려간다
  if (fromCard && next && narrow.matches) $('tnews-title').scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
}

// --- 사업 화면 --------------------------------------------------------------------

function fact(label, value, { extra = null, muted = false } = {}) {
  return h('div', { class: 'fact' }, h('small', {}, label), h('b', { class: muted ? 'muted' : null }, value), extra ? h('span', { class: 'fact-extra' }, extra) : null);
}

/** 접수 단계와 당첨자 발표를 한 줄로: '특별공급 11-09 · 1순위 11-10 · 당첨자 발표 11-17' */
function noticeSchedule(n) {
  // '1순위 해당'·'1순위 기타'처럼 짧은 이름이 같은 단계는 한 칸으로(첫날~끝날)
  const merged = [];
  for (const s of receptionStages(n)) {
    const name = stageShort(s.name);
    const last = merged.at(-1);
    if (last && last.name === name) last.end = s.end > last.end ? s.end : last.end;
    else merged.push({ name, start: s.start, end: s.end });
  }
  const parts = merged.map((s) => `${s.name} ${s.start.slice(5)}${s.end !== s.start ? `~${s.end.slice(5)}` : ''}`);
  if (isYmd(n?.winnerDate)) parts.push(`${WINNER_LABEL} ${n.winnerDate.slice(5)}`);
  return parts.join(' · ');
}

function renderProjectView(id) {
  const p = state.byId.get(id);
  if (!p) {
    renderMissing(id);
    return;
  }
  const bucket = state.bucket.get(p.id);
  const stages = stagesOf(p);
  let idx = Number.isInteger(p.stageIndex) ? p.stageIndex : stages.indexOf(p.stage);
  if (idx < 0 || idx >= stages.length) idx = stages.indexOf(p.stage);
  const dates = p.stageDates && typeof p.stageDates === 'object' ? p.stageDates : {};
  const seoul = p.region === '서울';
  const notices = entriesOf(p.notices);
  const open = notices.filter((n) => isYmd(n.end) && n.end >= state.today);
  const kindText = p.subKind && p.subKind !== p.kind ? `${p.kind ?? ''} (${p.subKind})` : (p.kind ?? '');

  const status = p.live && open.length
    ? h('div', { class: 'vstatus tone-live' },
      h('span', { class: 'chip c-live' }, '공고 중'),
      h('span', { class: 'vstatus-main' }, `청약홈 공고 ${open[0].announceDate ?? ''}`.trim()))
    : h('div', { class: `vstatus tone-${['live', 'soon', 'mid'].includes(bucket) ? 'plan' : 'muted'}` },
      h('span', { class: 'vstatus-label' }, windowFactLabel(p)),
      h('span', { class: 'vstatus-main' }, windowLabel(p, state.todayYm)),
      chip(bucket));

  const noticeBox = open.length ? h('section', { class: 'notice-box', 'aria-labelledby': 'pj-notice' },
    h('h3', { id: 'pj-notice', class: 'visually-hidden' }, '접수 중이거나 곧 접수하는 공고'),
    open.map((n) => h('div', { class: 'notice-row' },
      h('div', { class: 'notice-text' },
        h('p', { class: 'notice-name' }, n.name || '청약 공고'),
        h('p', {}, seoul ? '이 구역의 일반분양 공고가 청약홈에 나왔습니다. 접수일과 분양가는 공고문에서 확인하세요.' : '청약홈에 공고가 나왔습니다. 접수일과 분양가는 공고문에서 확인하세요.'),
        noticeSchedule(n) ? h('p', { class: 'notice-sched' }, noticeSchedule(n)) : h('p', { class: 'notice-sched' }, `공고 ${n.announceDate ?? '-'}, 마감 ${n.end}`)),
      extLink(n.url, '청약홈 공고 보기', { class: 'btn-solid' })))) : null;

  const facts = [
    fact('총 세대', fmtCount(p.households)),
    seoul ? fact('분양 세대 (조합원 포함)', fmtCount(p.saleHouseholds)) : null,
    seoul && typeof p.rentalHouseholds === 'number' ? fact('임대', fmtCount(p.rentalHouseholds)) : null,
    typeof p.generalSupply === 'number' ? fact('일반분양', fmtCount(p.generalSupply))
      : open.length ? fact('일반분양', '공고문 확인', { muted: true }) : null,
  ].filter(Boolean);

  const last = stages.length - 1;
  const noticeOnLast = p.live && open.length && idx < last && stages[last] === '일반분양';
  const steps = h('ol', { class: 'steps', 'aria-label': '사업 단계' }, stages.map((name, i) => {
    const cls = i < idx ? 'done' : i === idx ? 'now' : noticeOnLast && i === last ? 'notice' : '';
    const date = typeof dates[name] === 'string' ? dates[name] : null;
    return h('li', { class: cls || null, 'aria-current': i === idx ? 'step' : null },
      h('span', { class: 'visually-hidden' }, i < idx ? '지난 단계: ' : i === idx ? '현재 단계: ' : '남은 단계: '),
      name,
      date ? h('small', {}, date) : i <= idx ? h('small', {}, '자료 없음') : cls === 'notice' ? h('small', {}, `공고 ${open[0].announceDate ?? ''}`) : null);
  }));

  const news = state.feed.filter((f) => f.projectId === p.id);
  const sources = entriesOf(p.sources);

  setView(
    backLink(),
    h('header', { class: 'vhead' },
      h('div', { class: 'vhead-main' },
        h('p', { class: 'vmeta' }, `${placeLabel(p)} ${kindText}`.trim()),
        h('h2', { class: 'vtitle', tabindex: '-1', id: 'view-title' }, p.name ?? ''),
        p.address || p.roadAddress
          ? h('p', { class: 'vmeta' }, p.address && p.roadAddress && p.roadAddress !== p.address ? `${p.address} (${p.roadAddress})` : (p.address || p.roadAddress))
          : null),
      status),
    noticeBox,
    h('div', { class: 'facts' }, facts),
    h('section', { class: 'steps-sec', 'aria-labelledby': 'pj-steps' },
      h('h3', { id: 'pj-steps' }, '사업 단계'),
      h('div', { class: 'steps-wrap', tabindex: '0', 'aria-label': '사업 단계, 가로로 스크롤' }, steps),
      h('p', { class: 'why' }, h('b', {}, '예상 근거 '), p.windowBasis || '근거 정보 없음')),
    h('div', { class: 'pj-cols' },
      h('section', { class: 'pj-news', 'aria-labelledby': 'pj-news' },
        h('h3', { id: 'pj-news' }, `이 사업 소식${news.length ? ` ${news.length}건` : ''}`),
        news.length ? h('ol', { class: 'tline' }, news.map((f) => timelineItem(f))) : null,
        h('p', { class: 'note' }, news.length
          ? '청약홈 공고, 단계 변경, 모은 기사를 날짜 순으로 보여 줍니다.'
          : '이 사업으로 모은 소식이 아직 없습니다. 청약홈 공고나 단계 변경이 생기면 여기에 쌓입니다.'),
        news.some(isNaverItem) ? h('p', { class: 'note news-note' }, NEWS_NOTE, ' ', h('small', { class: 'news-credit' }, NEWS_CREDIT)) : null),
      h('aside', { class: 'pj-src', 'aria-labelledby': 'pj-src' },
        h('h3', { id: 'pj-src' }, '출처와 기준일'),
        h('ul', {},
          sources.map((src) => h('li', {}, extLink(src.url, src.title || '출처'), h('span', { class: 'muted' }, ` · 기준일 ${src.date || p.asOf || '-'}`))),
          notices.map((n) => h('li', {}, extLink(n.url, n.name || '청약 공고'),
            h('span', { class: 'muted' }, [n.typeLabel, n.announceDate ? `공고 ${n.announceDate}` : null, n.end ? `마감 ${n.end}` : null].filter(Boolean).map((x) => ` · ${x}`).join('')))),
          notices.length ? null : h('li', {}, extLink('https://www.applyhome.co.kr/', '청약홈 분양정보'))),
        h('p', { class: 'note' }, '예상 시기는 단계와 인가일로 계산한 추정입니다.'))),
    typeof p.notes === 'string' && p.notes.trim() ? h('details', { class: 'memo' }, h('summary', {}, '조사 메모'), h('p', {}, p.notes)) : null,
  );
  // 단계가 많아 가로로 넘치면 현재 단계가 보이도록 스크롤, 넘칠 때만 양 끝을 흐리게(style.css .scrolls)
  const wrap = $('view').querySelector('.steps-wrap');
  const now = $('view').querySelector('.steps li.now');
  if (wrap && now && wrap.scrollWidth > wrap.clientWidth) wrap.scrollLeft = Math.max(0, now.offsetLeft - (wrap.clientWidth - now.offsetWidth) / 2);
  stepsObserver?.disconnect();
  if (wrap && typeof ResizeObserver === 'function') {
    stepsObserver = new ResizeObserver(() => wrap.classList.toggle('scrolls', wrap.scrollWidth > wrap.clientWidth + 1));
    stepsObserver.observe(wrap);
  }
}

let stepsObserver = null;

// --- 화면 테마 ---------------------------------------------------------------

function themeDom() {
  return {
    root: document.documentElement,
    meta: document.querySelector('meta[name="color-scheme"]'),
    buttons: document.querySelectorAll('[data-theme-choice]'),
  };
}

let switchToken = 0;

/**
 * 처음 이후에 테마를 바꿀 때. 배경색만 전환 효과가 있어서 그대로 바꾸면 잠깐 글자색과 배경색이 어긋난다(어두운 글자에 어두운 배경).
 * 실제로 바뀔 때만 html.theme-switching 으로 전환 효과를 끄고, 두 프레임 뒤에 되돌린다.
 */
function switchTheme(theme) {
  const dom = themeDom();
  const t = normalizeTheme(theme);
  if (normalizeTheme(dom.root.getAttribute('data-theme')) !== t) {
    const token = ++switchToken;
    dom.root.classList.add('theme-switching');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (token === switchToken) dom.root.classList.remove('theme-switching');
    }));
  }
  return applyTheme(t, dom);
}

let storageWarned = false;

function initTheme() {
  // theme-init.js 가 먼저 붙인 값과 같지만, 버튼 상태까지 맞추려고 한 번 더 적용한다(처음에는 전환 효과를 끄지 않음)
  applyTheme(readTheme(storageOf('localStorage')), themeDom());
  // 자료를 못 불러와도 테마는 바꿀 수 있어야 하므로 아래 공통 click 처리와 따로 둔다
  $('theme').addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-theme-choice]') : null;
    if (!btn) return;
    const saved = writeTheme(storageOf('localStorage'), switchTheme(btn.getAttribute('data-theme-choice')));
    if (!saved && !storageWarned) {
      storageWarned = true;
      announce('이 브라우저에는 테마 선택이 저장되지 않습니다');
    }
  });
  // 다른 탭에서 바꾸면 따라간다
  window.addEventListener('storage', (e) => {
    if (isThemeStorageKey(e.key)) switchTheme(readTheme(storageOf('localStorage')));
  });
}

// --- 이벤트 -----------------------------------------------------------------

/**
 * 휴대폰 폭(≤520px)에서는 필터와 안내문을 접어 첫 화면을 짧게 하고, 그보다 넓으면 펼쳐 둔다
 * (index.html 은 open 으로 두어 스크립트가 없어도 펼쳐져 있고, 넓은 화면에서는 CSS 가 .fold.auto 의 접기 제목을 숨긴다).
 */
function initFolds() {
  const phone = window.matchMedia('(max-width: 520px)');
  const folds = AUTO_FOLD_IDS.map((id) => $(id));
  const sync = () => {
    for (const el of folds) el.open = !phone.matches;
  };
  sync();
  phone.addEventListener('change', sync);
}

function onClick(e) {
  const target = e.target instanceof Element ? e.target : null;
  if (!target || !state.data) return;
  // 사이트 안 이동 링크: 새 탭·새 창(수정 키, 가운데 버튼)은 브라우저에 맡긴다
  const link = target.closest('a[data-nav], a[data-leave]');
  if (link) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (link.hasAttribute('data-leave')) leaveView();
    else openLink(link.getAttribute('href'), { key: link.getAttribute('data-key'), back: link.getAttribute('data-back') });
    return;
  }
  const btn = target.closest('button');
  if (!btn) return;
  const d = btn.dataset;
  if (btn.getAttribute('aria-disabled') === 'true' && btn.hasAttribute('data-filter')) announce($('kind-locked-note').textContent); // 잠긴 유형 버튼
  else if (btn.hasAttribute('data-filter')) setFilter(d.filter, d.value);
  else if (btn.hasAttribute('data-district')) toggleDistrict(d.district);
  else if (btn.hasAttribute('data-close-region')) toggleDistrict(state.filters.district);
  else if (btn.hasAttribute('data-show-list')) jumpTo('list-title');
  else if (btn.hasAttribute('data-tile')) pickTile(d.tile);
  else if (btn.hasAttribute('data-kind')) {
    state.feedFilter = { kind: d.kind, onlyNew: false };
    state.feedShown = FEED_PAGE;
    keepFocus($('dash-tiles'), renderTiles);
    keepFocus($('feed'), renderFeed);
    announce(`${FEED_KIND_LABEL[d.kind]} 소식 ${filterFeed(state.feed, state.feedFilter, isNew).length}건`);
  } else if (btn.hasAttribute('data-only-new')) {
    state.feedFilter = { kind: 'all', onlyNew: !state.feedFilter.onlyNew };
    state.feedShown = FEED_PAGE;
    keepFocus($('dash-tiles'), renderTiles);
    keepFocus($('feed'), renderFeed);
    announce(`${state.feedFilter.onlyNew ? '새 소식' : '모든 소식'} ${filterFeed(state.feed, state.feedFilter, isNew).length}건`);
  }
  else if (btn.hasAttribute('data-feed-reset')) {
    state.feedFilter = { kind: 'all', onlyNew: false };
    keepFocus($('dash-tiles'), renderTiles);
    renderFeed();
    $('feed-title').focus();
  } else if (btn.hasAttribute('data-soon-gu')) pickSoonGu(d.soonGu);
  else if (btn.hasAttribute('data-block')) pickBlock(d.block || null, { fromCard: btn.classList.contains('bcard-hit') });
  else if (btn.id === 'mark-read') markAllRead();
  else if (btn.id === 'feed-more') showMoreFeed();
  else if (btn.id === 'soon-all') showSoonInList();
  else if (btn.dataset.empty === 'clear-q') clearQuery();
  else if (btn.dataset.empty === 'reset' || btn.id === 'f-reset') resetFilters();
  else if (btn.id === 'more') showMore();
  else if (btn.id === 'clear-district') toggleDistrict(state.filters.district);
}

function init() {
  initTheme();
  initFolds();
  $('refresh').addEventListener('click', refresh);
  document.addEventListener('click', onClick);
  $('f-stage').addEventListener('change', (e) => setFilter('stage', e.target.value));
  let timer = 0;
  $('f-q').addEventListener('input', (e) => {
    clearTimeout(timer);
    const value = e.target.value;
    timer = setTimeout(() => {
      state.filters = nextFilters(state.filters, 'q', value.trim());
      applyFilters();
      announce(`검색 결과 ${state.visible.length}곳`);
    }, 150);
  });
  // 뒤로·앞으로 가기(popstate)와 주소창에서 해시를 바꾼 경우(hashchange). 둘 다 와도 syncFromHash 는 한 번만 바꾼다
  window.addEventListener('popstate', syncFromHash);
  window.addEventListener('hashchange', syncFromHash);
  load();
}

if (typeof document !== 'undefined') init();
