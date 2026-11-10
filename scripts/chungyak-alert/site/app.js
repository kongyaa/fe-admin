// 분양 예정 지도 — 정적 사이트 스크립트 (프레임워크·빌드 단계 없음)
// projects.json 하나만 읽어 화면을 그린다. JSON 문자열은 모두 textContent 로 넣고 innerHTML 은 쓰지 않는다.
// 위쪽의 순수 함수는 export 해 두어 node --test 로 검사할 수 있다(DOM 이 없으면 화면 코드는 실행하지 않음).

export const PAGE_SIZE = 50;
export const GANTT_MONTHS = 36;
export const GANTT_MAX_ROWS = 40;

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

/** 'YYYY-MM' 에 n 달을 더한다 */
export function addMonths(ym, n) {
  const x = toYm(ym);
  if (!x) return null;
  const total = Number(x.slice(0, 4)) * 12 + Number(x.slice(5, 7)) - 1 + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
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
      rental: RENTAL_NOTICE_TYPES.includes(type),
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

/** from~to(달)가 startYm 부터 months 칸 안에서 차지하는 칸. 걸치지 않으면 null */
export function spanOf(fromValue, toValue, startYm, months = GANTT_MONTHS) {
  const from = toYm(fromValue);
  if (!from) return null;
  const to = toYm(toValue) ?? from;
  const s = monthsBetween(startYm, from);
  const e = monthsBetween(startYm, to) + 1;
  if (e <= 0 || s >= months || e <= s) return null;
  return { start: Math.max(0, s), end: Math.min(months, e), cutStart: s < 0, cutEnd: e > months };
}

/**
 * 타임라인 막대들: 예상 범위(est, 빗금)와 연결된 공고 기간(live, 초록).
 * 36개월 안에 걸치는 막대가 없으면 빈 배열.
 */
export function ganttBars(project, startYm, months = GANTT_MONTHS) {
  const bars = [];
  const est = spanOf(project?.window?.from, project?.window?.to, startYm, months);
  if (est) bars.push({ kind: 'est', ...est });
  if (project?.live && Array.isArray(project.notices)) {
    for (const n of project.notices) {
      const span = spanOf(n?.announceDate, n?.end ?? n?.announceDate, startYm, months);
      if (span) bars.push({ kind: 'live', ...span, label: `${toYm(n.announceDate)} 공고` });
    }
  }
  return bars;
}

/** 오늘이 이번 달 안에서 어디쯤인지(0~1) */
export function dayFraction(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return (d - 1) / days;
}

/**
 * 구별 집계: 서울 사업만, 구 이름 → { n: 전체, soon: 공고 중·1년 안, mid: 3년 안 }
 * bucketFn(project) 로 구간을 받는다(화면에서는 미리 계산한 값을 넘김).
 */
export function tileStats(projects, bucketFn) {
  const stats = new Map();
  for (const p of projects) {
    if (p?.region !== '서울') continue;
    const s = stats.get(p.district) ?? { n: 0, soon: 0, mid: 0 };
    const b = bucketFn(p);
    s.n += 1;
    if (b === 'live' || b === 'soon') s.soon += 1;
    else if (b === 'mid') s.mid += 1;
    stats.set(p.district, s);
  }
  return stats;
}

/** 타일 색 3단계: 1년 안(공고 중 포함) 3곳 이상 → hot, 1~2곳이거나 3년 안이 있으면 → has, 그 밖 → '' */
export function tileClass(stat) {
  const soon = stat?.soon ?? 0;
  if (soon >= 3) return 'hot';
  if (soon >= 1 || (stat?.mid ?? 0) > 0) return 'has';
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
 * 주소 해시에서 화면 상태를 꺼낸다: '#p=<id>'(상세), '#gu=<구>'(구 선택), 둘 다면 '#gu=<구>&p=<id>'.
 * 값은 decodeURIComponent 로 풀고, 깨졌거나 빈 값은 null. 모르는 해시('#sources' 등)면 둘 다 null.
 * 같은 키가 두 번 나오면 뒤의 값을 쓴다('#p=a&p=b' → 'b').
 */
export function parseHash(hash) {
  const out = { id: null, district: null };
  for (const part of String(hash ?? '').replace(/^#/, '').split('&')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    let value;
    try {
      value = decodeURIComponent(part.slice(eq + 1));
    } catch {
      continue;
    }
    if (!value) continue;
    const key = part.slice(0, eq);
    if (key === 'p') out.id = value;
    else if (key === 'gu') out.district = value;
  }
  return out;
}

/** parseHash 의 반대: { id, district } → '#gu=…&p=…'. 둘 다 없으면 '' */
export function hashFor({ id = null, district = null } = {}) {
  const parts = [];
  if (district) parts.push(`gu=${encodeURIComponent(district)}`);
  if (id) parts.push(`p=${encodeURIComponent(id)}`);
  return parts.length ? `#${parts.join('&')}` : '';
}

/** 화면 상태를 담은 해시인지('#p=…'·'#gu=…'). 빈 해시도 상태(목록)로 본다. '#sources' 같은 문서 안 이동은 false */
export function isStateHash(hash) {
  const h = String(hash ?? '');
  if (h === '' || h === '#') return true;
  const { id, district } = parseHash(h);
  return Boolean(id || district);
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

// ---------------------------------------------------------------------------
// 화면
// ---------------------------------------------------------------------------

const TILE_LAYOUT = [
  [null, null, null, null, '강북구', '도봉구'],
  [null, null, '은평구', '종로구', '성북구', '노원구'],
  ['강서구', '마포구', '서대문구', '중구', '동대문구', '중랑구'],
  ['양천구', '영등포구', '용산구', '성동구', '광진구', '강동구'],
  ['구로구', '동작구', '서초구', '강남구', '송파구', null],
  ['금천구', '관악구', null, null, null, null],
];
const SEOUL_DISTRICTS = new Set(TILE_LAYOUT.flat().filter(Boolean));

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
  base: [], // 구 선택을 뺀 필터 결과(타일·지구 목록용)
  visibleIds: new Set(),
  visible: [], // 구 선택까지 적용한 결과(목록·타임라인용)
  shown: PAGE_SIZE,
  selected: null,
  quietPop: false, // toggleDistrict 가 부른 history.back() 의 popstate 인지
  hashId: null, // 주소 해시에 들어 있는 상세 id(좁은 화면에서는 '상세를 보는 중'이라는 뜻)
};

const $ = (id) => document.getElementById(id);

/** 안전한 DOM 생성기: 문자열 자식은 텍스트 노드, href 는 http(s)만 */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style') Object.assign(el.style, value); // CSSOM 은 CSP style-src 'self' 에 막히지 않음
    else if (key === 'href') {
      const url = safeHttpUrl(value);
      if (url) el.setAttribute('href', url);
    } else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

/** 외부 링크. 주소가 http(s)가 아니면 링크 없이 글자만 */
function extLink(url, text) {
  const safe = safeHttpUrl(url);
  if (!safe) return h('span', {}, text);
  return h('a', { href: safe, target: '_blank', rel: 'noopener noreferrer' }, text);
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

function stagesOf(p) {
  const list = state.stages[stageGroup(p)];
  return Array.isArray(list) && list.length ? list : DEFAULT_STAGES[stageGroup(p)];
}

function announce(text) {
  $('announce').textContent = text;
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

// --- 불러오기 ---------------------------------------------------------------

async function load() {
  const status = $('status');
  status.className = 'status';
  status.replaceChildren('사업 목록을 불러오는 중…');
  status.hidden = false;
  try {
    const res = await fetch(dataFile(location.search), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error('JSON 형식 오류');
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.projects)) throw new Error('projects 항목 없음');
    start(data);
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
  retry.addEventListener('click', () => {
    status.setAttribute('role', 'status');
    load();
  });
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
  $('asof').textContent = '기준일 정보를 불러오지 못했습니다.';
}

function start(data) {
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

  renderHeader();
  renderSources();
  buildStageSelect();
  $('sample-banner').hidden = data.sample !== true;
  $('app').hidden = false;

  // '#p=<id>'(상세)·'#gu=<구>'(구 선택) 링크로 들어오면 그 상태로 연다
  const fromHash = parseHash(location.hash);
  if (fromHash.district && SEOUL_DISTRICTS.has(fromHash.district)) state.filters = nextFilters(state.filters, 'district', fromHash.district);
  applyFilters();

  if (fromHash.id) {
    state.hashId = fromHash.id;
    select(fromHash.id, { fromHash: true, scroll: true });
  } else if (state.visible[0]) select(state.visible[0].id, { fromHash: true });
  else renderDetail(null);
}

// --- 머리말·출처 ------------------------------------------------------------

function renderHeader() {
  const s = state.data.sources ?? {};
  const parts = [];
  if (s.seoul?.asOf) parts.push(`서울 정비사업 자료 ${s.seoul.asOf} 기준`);
  if (s.newtowns?.asOf) parts.push(`신도시 목록 ${s.newtowns.asOf} 확인`);
  if (state.data.generatedAt) parts.push(`업데이트 ${state.data.generatedAt}`);
  $('asof').textContent = parts.length ? parts.join(' · ') : '기준일 정보 없음';
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

// --- 필터 -------------------------------------------------------------------

function applyFilters({ keepPage = false } = {}) {
  const { district, ...rest } = state.filters;
  state.base = state.projects.filter((p) => matchesFilters(p, rest, state.todayYm, state.bucket.get(p.id), state.hay.get(p.id)));
  state.visible = district ? state.base.filter((p) => p.district === district) : state.base;
  state.visibleIds = new Set(state.visible.map((p) => p.id));
  if (!keepPage) state.shown = PAGE_SIZE;
  syncFilterControls();
  keepFocus($('tiles'), renderTiles);
  keepFocus($('towns'), renderTowns);
  keepFocus($('list'), renderList);
  keepFocus($('gantt'), renderGantt);
  syncStale();
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
  writeHash();
}

function resetFilters() {
  state.filters = { ...DEFAULT_FILTERS };
  applyFilters();
  writeHash();
  announce(`필터 초기화, ${state.visible.length}곳`);
}

function clearQuery() {
  state.filters = nextFilters(state.filters, 'q', '');
  applyFilters();
  $('list-title').focus({ preventScroll: true });
  announce(`검색어를 지웠습니다, ${state.visible.length}곳`);
}

function toggleDistrict(district) {
  const next = state.filters.district === district ? null : district;
  state.filters = nextFilters(state.filters, 'district', next);
  applyFilters();
  // 좁은 화면: 구를 고르면 기록을 하나 남기고(뒤로 가기 → 지도) 바로 그 구 목록으로 내려간다.
  // 그 기록에서 다시 풀면 기록을 하나 되돌린다(켜기·끄기·켜기를 반복해도 같은 기록이 쌓이지 않게). 화면은 이미 바꿨으니 popstate 는 조용히
  const phone = narrow.matches;
  if (phone && !next && history.state?.pushed === 'district') {
    state.quietPop = true;
    history.back();
  } else {
    writeHash({ id: phone ? null : state.hashId, push: phone && next ? 'district' : null });
  }
  if (phone && next) {
    $('list-title').scrollIntoView({ block: 'start' });
    $('list-title').focus({ preventScroll: true });
  }
  announce(next ? `${shortDistrict(next)} 사업 ${state.visible.length}곳` : `구 선택 해제, ${state.visible.length}곳`);
}

// --- 주소 기록(뒤로 가기) -----------------------------------------------------

/**
 * 지금 상태(상세 id·구 선택)를 주소 해시에 쓴다. push 를 주면 새 기록을 남겨 휴대폰 뒤로 가기가 앞 화면(목록·지도)으로
 * 돌아오게 하고, 아니면 지금 기록을 바꿔 쓴다(넓은 화면, 처음 자동 선택, 필터 변경).
 */
function writeHash({ id = state.hashId, push = null } = {}) {
  const hash = hashFor({ id, district: state.filters.district });
  state.hashId = id ?? null;
  if (hash === location.hash || (!hash && !location.hash)) return;
  const url = hash || `${location.pathname}${location.search}`;
  if (push) history.pushState({ pushed: push }, '', url);
  else history.replaceState(history.state, '', url);
}

/** 뒤로·앞으로 가기나 주소를 바꿨을 때 해시를 화면에 맞춘다. 같은 상태면 아무것도 하지 않는다(두 번 불려도 됨) */
function syncFromHash() {
  if (!state.data || !isStateHash(location.hash)) return; // '#sources' 같은 문서 안 이동은 그대로 둔다
  const { id, district } = parseHash(location.hash);
  const gu = district && SEOUL_DISTRICTS.has(district) ? district : null;
  const prevId = state.hashId;
  state.hashId = id;
  // 우리가 부른 history.back()(toggleDistrict)이면 화면은 이미 맞췄으니 스크롤·포커스를 옮기지 않는다
  const phone = narrow.matches && !state.quietPop;
  state.quietPop = false;
  if (gu !== state.filters.district) {
    state.filters = nextFilters(state.filters, 'district', gu);
    applyFilters();
    if (!id && !prevId && phone) {
      // 구 목록으로 돌아오면 구를 눌렀을 때(toggleDistrict)처럼 목록 제목으로, 구 선택이 풀리면 지도로
      const target = $(gu ? 'list-title' : 'browse');
      target.scrollIntoView({ block: 'start' });
      if (gu) target.focus({ preventScroll: true });
    }
  }
  if (id) {
    if (id !== state.selected) select(id, { fromHash: true, scroll: phone });
    else if (id !== prevId && phone) showDetail();
  } else if (prevId && phone) {
    backToList();
  }
}

// --- 타일 지도·지구 목록 -----------------------------------------------------

function renderTiles() {
  const stats = tileStats(state.base, (p) => state.bucket.get(p.id));
  $('tiles').replaceChildren(...TILE_LAYOUT.flat().map((district) => {
    if (!district) return h('span', { class: 'tile empty', 'aria-hidden': 'true' });
    const st = stats.get(district) ?? { n: 0, soon: 0, mid: 0 };
    const cls = ['tile', tileClass(st), st.n ? '' : 'zero'].filter(Boolean).join(' ');
    const label = `${district} ${st.n}곳${st.soon ? `, 1년 안 ${st.soon}곳` : ''}${st.mid ? `, 3년 안 ${st.mid}곳` : ''}`;
    const { main, total } = tileCount(st);
    return h('button', {
      type: 'button', class: cls, 'data-key': district, 'data-district': district,
      'aria-pressed': String(state.filters.district === district), 'aria-label': label, title: label,
    },
    h('span', { class: 'tile-name' }, shortDistrict(district)),
    h('span', { class: 'tile-num' }, h('b', {}, String(main)), total ? h('small', {}, `/${total}`) : null));
  }));
}

function renderTowns() {
  // 결과가 아예 없으면 안내는 목록 한 곳에만 둔다(지구 제목도 숨김)
  const none = state.base.length === 0;
  $('towns-title').hidden = none;
  $('towns').hidden = none;
  const towns = state.base.filter((p) => p.region !== '서울');
  if (!towns.length) {
    $('towns').replaceChildren(h('p', { class: 'note' }, '조건에 맞는 지구가 없습니다.'));
    return;
  }
  $('towns').replaceChildren(...towns.map((p) => h('button', {
    type: 'button', class: 'town', 'data-key': p.id, 'data-select': p.id, 'aria-current': String(state.selected === p.id),
  },
  h('span', { class: 'town-name' }, p.name ?? '', h('small', {}, ` ${shortDistrict(p.district)} · ${p.stage ?? ''}`)),
  chip(state.bucket.get(p.id)))));
}

// --- 목록 -------------------------------------------------------------------

function listItem(p) {
  const range = windowRangeLabel(p, state.todayYm);
  const sold = stageGroup(p) === 'town' ? latestSale(p) : null;
  return h('button', {
    type: 'button', class: 'item', 'data-key': p.id, 'data-select': p.id, 'aria-current': String(state.selected === p.id),
  },
  h('span', { class: 'item-name' }, p.name ?? ''),
  chip(state.bucket.get(p.id)),
  h('span', { class: 'meta' },
    h('span', {}, p.kind ?? ''),
    h('span', {}, p.region === '서울' ? shortDistrict(p.district) : placeLabel(p)),
    h('span', {}, p.stage ?? ''),
    range ? h('span', {}, `${windowPrefix(p)} ${range}`) : null,
    sold ? h('span', {}, `최근 분양 ${sold}`) : null));
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

// --- 상세 -------------------------------------------------------------------

function fact(label, value, extra) {
  return h('div', { class: 'fact' }, h('small', {}, label), h('b', {}, value), extra ? h('span', { class: 'fact-extra' }, extra) : null);
}

/** 출처 링크: '낸 곳 날짜'만 짧게 보이고 전체 제목은 title 로 */
function sourceLink(src) {
  const label = `${sourceOutlet(src)}${src?.date ? ` ${src.date}` : ''}`;
  const url = safeHttpUrl(src?.url);
  return url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', title: src.title || null }, label) : h('span', {}, label);
}

/** 분양 이력(사전청약·본청약·연결된 청약홈 공고), 최근 공고 먼저. 없으면 null */
function saleSection(p) {
  const rows = saleHistory(p);
  if (!rows.length) return null;
  return h('div', { class: 'sales' },
    h('h3', {}, '분양 이력'),
    h('ul', {}, rows.map((r) => {
      const open = r.end && String(r.end) >= state.today;
      const what = [r.type, r.households !== null ? fmtCount(r.households) : null].filter(Boolean).join(' · ');
      return h('li', { class: r.stage === PRE_SUBSCRIPTION ? 'pre' : null },
        h('span', { class: 'sale-head' },
          h('span', { class: 'sale-date' }, r.date || '날짜 없음'),
          r.block ? h('b', {}, r.block) : null,
          what ? h('span', {}, what) : null,
          r.stage === PRE_SUBSCRIPTION ? h('span', { class: 'chip c-pre' }, '사전청약') : null,
          r.rental ? h('span', { class: 'chip c-rent' }, '임대') : null,
          open ? h('span', { class: 'chip c-live' }, '공고 중') : null),
        r.title ? h('span', { class: 'sale-title' }, r.title) : null,
        r.sources.length
          ? h('span', { class: 'sale-src' }, '출처 ', r.sources.flatMap((src, i) => (i ? [' · ', sourceLink(src)] : [sourceLink(src)])))
          : null);
    })),
    rows.some((r) => r.stage === PRE_SUBSCRIPTION) ? h('p', { class: 'note' }, '사전청약은 본청약 전 예약이라 최근 분양에 세지 않습니다.') : null);
}

const joinLinks = (sources) => sources.flatMap((src, i) => (i ? [' · ', sourceLink(src)] : [sourceLink(src)]));

/**
 * 블록 줄 아래의 분양 성과: 대표 주택형 분양가, 경쟁률(출처), 주변 시세 비교(공고 당시·현재 기준)와 안내.
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
  const points = market.points.map((p) => h('li', { class: p.shown ? null : 'muted' }, p.text));
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

/**
 * 블록별 현황(블록별 분양 지구만): 상태별 개수, 지구 전체 블록 수(출처 있을 때), 블록 표.
 * 상세 칸이 넓으면 표, 좁으면(컨테이너 쿼리, style.css) 줄마다 카드처럼 쌓는다(칸 이름은 data-label). 줄이 없으면 null.
 */
function blockSection(p) {
  if (!isBlockTownProject(p)) return null;
  const rows = blockRows(p, state.today);
  if (!rows.length) return null;
  const totalText = blockTotalText(p.blockTotal);
  const totalSrc = cleanLinks(p.blockTotal?.sources)[0] ?? null;
  // 칸 내용은 div 하나로 감싼다(좁은 화면에서 칸 이름 옆 한 칸에 모이게)
  const cell = (label, ...children) => h('td', { 'data-label': label }, h('div', {}, ...children));
  return h('div', { class: 'blocks' },
    h('h3', { id: 'blocks-title' }, '블록별 현황'),
    h('ul', { class: 'block-counts', 'aria-label': '상태별 블록 수' }, blockStatusCounts(rows).map((c) => h('li', {},
      h('span', { class: `chip ${BLOCK_STATUS_CLASS[c.status]}` }, c.status), h('b', {}, String(c.count))))),
    totalText
      ? h('p', { class: 'block-total' }, totalSrc
        ? h('a', { href: totalSrc.url, target: '_blank', rel: 'noopener noreferrer', title: totalSrc.title || null }, totalText)
        : totalText)
      : null,
    h('div', { class: 'block-table-wrap' },
      h('table', { class: 'block-table', 'aria-labelledby': 'blocks-title' },
        h('thead', {}, h('tr', {}, ['블록', '유형', '세대', '상태', '경과·다음 예정', '출처'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', {}, rows.map((r) => {
          const plan = blockPlanLabel(r.plan, state.todayYm);
          const date = blockDateLabel(r);
          const flow = [
            ...r.timeline.map((t) => h('li', { class: t.stage === PRE_SUBSCRIPTION ? 'pre' : null }, blockTimelineLabel(t, r.rental))),
            plan ? h('li', { class: 'plan' }, `다음 예정 ${plan}`) : null,
          ].filter(Boolean);
          const main = h('tr', { class: r.performance ? 'has-perf' : null },
            h('th', { scope: 'row', 'data-label': '블록' }, r.block),
            cell('유형',
              h('span', { class: r.type ? null : 'muted' }, blockTypeLabel(r)),
              r.rental ? [' ', h('span', { class: 'chip c-rent' }, '임대')] : null),
            cell('세대', r.households !== null ? fmtCount(r.households) : '-'),
            cell('상태',
              h('span', { class: `chip ${BLOCK_STATUS_CLASS[r.status]}` }, r.status),
              date ? h('small', { class: 'block-date' }, date) : null),
            cell('경과·다음 예정',
              flow.length ? h('ul', { class: 'block-flow' }, flow) : r.note ? null : h('span', { class: 'muted' }, '-'),
              r.note ? h('small', { class: 'block-note' }, r.note) : null),
            cell('출처', r.sources.length ? h('span', { class: 'block-src' }, joinLinks(r.sources)) : '-'));
          return r.performance
            ? [main, h('tr', { class: 'block-perf-row' }, h('td', { colspan: '6', 'data-label': '분양 성과' }, performanceBox(r.block, r.performance)))]
            : main;
        })))),
    // 표 읽는 법은 한 줄만 보이고 나머지는 '자세히'로 접는다(문구는 그대로)
    h('details', { class: 'fold note' },
      h('summary', {}, '출처로 확인한 블록만 보여 줍니다. ', h('span', { class: 'fold-more' }, '자세히')),
      h('p', {}, '사업승인 날짜는 승인일을 모르면 보도일이고, 유형이 출처에 없으면 "유형 미확인"입니다. '
        + '분양과 임대가 함께 있는 블록은 줄을 나눕니다.'
        + (rows.some((r) => r.performance)
          ? ' 분양 성과의 시세 비교는 주변 단지 실거래로 추정한 신축 환산 값이며, 신뢰도가 낮거나 차익 공유 유형이면 숫자를 보이지 않습니다.'
          : '')
        + (totalText ? ' 위 전체 블록 수 문구는 그 출처가 보도한 수치라 표의 상태별 줄 수와 같은 기준이 아닙니다.' : ''))));
}

function renderDetail(p, missingId) {
  const box = $('detail');
  if (!p) {
    box.replaceChildren(
      h('h2', { class: 'detail-name', tabindex: '-1', id: 'detail-title' }, missingId ? '사업을 찾지 못했습니다' : '사업을 고르세요'),
      h('p', { class: 'note' }, missingId
        ? `링크의 사업(${missingId})이 이번 목록에 없습니다. 구역 정리나 이름 변경으로 빠졌을 수 있습니다.`
        : '목록이나 지도에서 사업을 고르면 단계와 예상 청약 시기를 보여줍니다.'),
    );
    return;
  }
  const bucket = state.bucket.get(p.id);
  const stages = stagesOf(p);
  let idx = Number.isInteger(p.stageIndex) ? p.stageIndex : stages.indexOf(p.stage);
  if (idx < 0 || idx >= stages.length) idx = stages.indexOf(p.stage);
  const dates = p.stageDates && typeof p.stageDates === 'object' ? p.stageDates : {};
  const seoul = p.region === '서울';
  const kindText = p.subKind && p.subKind !== p.kind ? `${p.kind ?? ''} · ${p.subKind}` : (p.kind ?? '');

  const facts = [
    fact('유형', kindText || '-'),
    fact('지역', placeLabel(p) || '-'),
    fact('주소', p.address || p.roadAddress || '-', p.address && p.roadAddress && p.roadAddress !== p.address ? p.roadAddress : null),
    fact('총 세대', fmtCount(p.households)),
    seoul ? fact('분양 세대(조합원 포함)', fmtCount(p.saleHouseholds)) : null,
    seoul && typeof p.rentalHouseholds === 'number' ? fact('임대', fmtCount(p.rentalHouseholds)) : null,
    // 일반분양 수는 자료에 있을 때만(없으면 '미정' 칸을 만들지 않는다)
    typeof p.generalSupply === 'number' ? fact('일반분양 예상', fmtCount(p.generalSupply)) : null,
  ];

  // 사람들이 찾아오는 답(예상 청약 시기)을 제목 바로 아래에 크게. 이미 시작된 범위면 원래 추정 범위를 작게 덧붙인다
  const range = windowRange(p);
  const answer = h('div', { class: 'answer' },
    h('small', { class: 'answer-label' }, windowFactLabel(p)),
    h('p', { class: 'answer-line' }, h('b', {}, windowLabel(p, state.todayYm)), chip(bucket)),
    range && windowRangeLabel(p, state.todayYm) !== range ? h('small', { class: 'answer-extra' }, `추정 범위 ${range}`) : null);

  const steps = h('ol', { class: 'steps', 'aria-label': '사업 단계' }, stages.map((name, i) => {
    const cls = i < idx ? 'done' : i === idx ? 'now' : '';
    const date = typeof dates[name] === 'string' ? dates[name] : null;
    return h('li', { class: cls || null, 'aria-current': i === idx ? 'step' : null },
      h('span', { class: 'visually-hidden' }, i < idx ? '지난 단계: ' : i === idx ? '현재 단계: ' : '남은 단계: '),
      name,
      date ? h('small', {}, date) : null);
  }));

  // 공공주택지구는 연결된 공고를 분양 이력에 합쳐 보여 준다(saleSection)
  const town = stageGroup(p) === 'town';
  const notices = Array.isArray(p.notices) ? p.notices : [];
  const noticeBlock = !town && notices.length
    ? h('div', { class: 'notices' },
      h('h3', {}, '연결된 청약 공고'),
      h('ul', {}, notices.map((n) => {
        const open = n?.end && String(n.end) >= state.today;
        return h('li', {},
          extLink(n?.url, n?.name || '청약 공고'),
          h('span', { class: 'muted' },
            n?.typeLabel ? ` · ${n.typeLabel}` : '',
            n?.announceDate ? ` · 공고 ${n.announceDate}` : '',
            n?.end ? ` · 마감 ${n.end}` : ''),
          open ? h('span', { class: 'chip c-live' }, '공고 중') : null);
      })))
    : null;

  const sources = Array.isArray(p.sources) ? p.sources : [];
  const sourceBlock = h('div', { class: 'detail-sources' },
    h('h3', {}, '출처'),
    sources.length
      ? h('ul', {}, sources.map((src) => h('li', {},
        extLink(src?.url, src?.title || '출처'),
        h('span', { class: 'muted' }, ` · 기준일 ${src?.date || p.asOf || '-'}`))))
      : h('p', { class: 'note' }, `기준일 ${p.asOf || '-'}`));

  const back = h('button', { type: 'button', class: 'linkish back', 'data-back': '' }, '← 목록으로');

  box.replaceChildren(...[
    back,
    h('div', { class: 'detail-head' },
      h('h2', { class: 'detail-name', tabindex: '-1', id: 'detail-title' }, p.name ?? '')),
    // 필터를 바꿔 목록에서 빠진 사업이면 알려 준다(syncStale)
    h('p', { class: 'stale-note', id: 'stale-note', hidden: true }, '지금 목록에는 없는 사업입니다. 필터나 구 선택을 바꾸면 다시 보입니다.'),
    answer,
    h('p', { class: 'why' }, h('b', {}, '예상 근거 '), p.windowBasis || '근거 정보 없음'),
    h('div', { class: 'facts' }, facts),
    h('div', { class: 'steps-wrap', tabindex: '0', 'aria-label': '사업 단계, 가로로 스크롤' }, steps),
    typeof p.notes === 'string' && p.notes.trim() ? h('details', { class: 'memo' }, h('summary', {}, '조사 메모'), h('p', {}, p.notes)) : null,
    town ? blockSection(p) : null,
    town ? saleSection(p) : noticeBlock,
    sourceBlock,
  ].filter(Boolean));
  syncStale();
  // 단계가 많아 가로로 넘치면 현재 단계가 보이도록 스크롤
  const wrap = box.querySelector('.steps-wrap');
  const now = box.querySelector('.steps li.now');
  if (wrap && now && wrap.scrollWidth > wrap.clientWidth) {
    wrap.scrollLeft = Math.max(0, now.offsetLeft - (wrap.clientWidth - now.offsetWidth) / 2);
  }
  // 가로로 넘칠 때만 양 끝을 흐리게(style.css .scrolls). 화면 폭이 바뀌어도 맞춘다
  stepsObserver?.disconnect();
  if (wrap && typeof ResizeObserver === 'function') {
    stepsObserver = new ResizeObserver(() => wrap.classList.toggle('scrolls', wrap.scrollWidth > wrap.clientWidth + 1));
    stepsObserver.observe(wrap);
  }
}

let stepsObserver = null;

/** 보고 있는 사업이 지금 목록(필터와 구 선택을 모두 적용한 결과)에 없으면 상세에 알림을 띄운다 */
function syncStale() {
  const note = document.getElementById('stale-note');
  if (note) note.hidden = !state.selected || state.visibleIds.has(state.selected);
}

const narrow = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 820px)') : { matches: false };

function select(id, { fromHash = false, focus = false, scroll = false } = {}) {
  const p = state.byId.get(id);
  if (!p) {
    state.selected = null;
    renderDetail(null, id);
    return;
  }
  state.selected = id;
  for (const el of document.querySelectorAll('[data-select]')) {
    el.setAttribute('aria-current', String(el.getAttribute('data-select') === id));
  }
  renderDetail(p);
  // 좁은 화면에서 사업을 고르면 새 기록을 남긴다: 휴대폰 뒤로 가기가 사이트를 떠나지 않고 목록으로 돌아오게.
  // 넓은 화면(목록과 상세가 함께 보임)과 처음 자동 선택은 기록을 늘리지 않고 바꿔 쓴다.
  if (!fromHash) writeHash({ id, push: narrow.matches && state.hashId !== id ? 'detail' : null });
  if (focus) announce(`${p.name} 상세`);
  if ((focus || scroll) && narrow.matches) showDetail();
}

function showDetail() {
  $('detail').scrollIntoView({ block: 'start' });
  $('detail-title').focus({ preventScroll: true });
}

/** 상세의 '← 목록으로': 우리가 남긴 기록이면 브라우저 뒤로 가기와 같게(popstate 가 목록으로), 아니면 해시만 지우고 목록으로 */
function leaveDetail() {
  if (history.state?.pushed === 'detail' && state.hashId) {
    history.back();
    return;
  }
  writeHash({ id: null });
  backToList();
}

function backToList() {
  const id = state.selected;
  const target = [...$('list').querySelectorAll('[data-select]')].find((el) => el.getAttribute('data-select') === id)
    ?? [...$('towns').querySelectorAll('[data-select]')].find((el) => el.getAttribute('data-select') === id);
  if (target) {
    target.scrollIntoView({ block: 'center' });
    target.focus({ preventScroll: true });
  } else {
    $('browse').scrollIntoView({ block: 'start' });
  }
}

// --- 타임라인 ---------------------------------------------------------------

function renderGantt() {
  const startYm = state.todayYm;
  const rows = [];
  let total = 0;
  for (const p of state.visible) {
    const bars = ganttBars(p, startYm);
    if (!bars.length) continue;
    total += 1;
    if (rows.length < GANTT_MAX_ROWS) rows.push([p, bars]);
  }
  // 위 줄은 연도(칸을 묶어서), 아래 줄은 분기 첫 달과 시작 달
  const years = [];
  for (let i = 0; i < GANTT_MONTHS; i += 1) {
    const y = addMonths(startYm, i).slice(0, 4);
    if (years.length && years[years.length - 1].y === y) years[years.length - 1].n += 1;
    else years.push({ y, i, n: 1 });
  }
  const axis = h('div', { class: 'g-axis', 'aria-hidden': 'true' },
    years.map(({ y, i, n }) => h('span', { class: 'g-year', style: { gridColumn: `${i + 1} / span ${n}` } }, n >= 3 ? `${y}년` : `'${y.slice(2)}`)),
    Array.from({ length: GANTT_MONTHS }, (_, i) => {
      const month = Number(addMonths(startYm, i).slice(5, 7));
      return h('span', { class: month === 1 ? 'g-month jan' : 'g-month', style: { gridColumn: String(i + 1), gridRow: '2' } },
        i === 0 || month % 3 === 1 ? String(month) : '');
    }));
  const nowLeft = `${(dayFraction(state.today) / GANTT_MONTHS) * 100}%`;
  const pct = (n) => `${(n / GANTT_MONTHS) * 100}%`;
  const cells = [h('div', { class: 'g-corner' }), axis];
  for (const [p, bars] of rows) {
    const range = windowRangeLabel(p, state.todayYm);
    const said = [range ? `${windowPrefix(p)} ${range}` : '', ...bars.filter((b) => b.kind === 'live').map((b) => `공고 중 ${b.label}`)].filter(Boolean).join(', ');
    cells.push(
      h('button', {
        type: 'button', class: 'g-label', 'data-key': p.id, 'data-select': p.id, 'aria-current': String(state.selected === p.id), title: p.name ?? '',
      }, h('span', { class: 'g-name' }, p.name ?? ''), h('small', {}, shortDistrict(p.district))),
      h('div', { class: 'g-row', title: `${p.name ?? ''}: ${said}` },
        bars.map((b) => h('span', {
          class: ['g-bar', b.kind, b.cutStart ? 'cut-s' : '', b.cutEnd ? 'cut-e' : ''].filter(Boolean).join(' '),
          style: { left: pct(b.start), width: `max(6px, ${pct(b.end - b.start)})` },
        })),
        h('span', { class: 'visually-hidden' }, said),
        h('span', { class: 'g-now', style: { left: nowLeft }, 'aria-hidden': 'true' })),
    );
  }
  $('gantt').replaceChildren(...cells);
  // 목록이 비었으면 안내는 목록에만 두고 타임라인 칸은 숨긴다
  $('gantt-panel').hidden = state.visible.length === 0;
  const note = $('gantt-note');
  if (!total) note.textContent = '조건에 맞는 사업 중 앞으로 36개월 안에 예상되거나 공고가 난 곳이 없습니다.';
  else if (total > rows.length) note.textContent = `36개월 안에 걸친 ${total.toLocaleString('ko-KR')}곳 중 앞의 ${rows.length}곳만 그렸습니다. 나머지 ${(total - rows.length).toLocaleString('ko-KR')}곳은 필터를 좁히거나 목록에서 보세요.`;
  else note.textContent = `36개월 안에 걸친 ${total.toLocaleString('ko-KR')}곳`;
}

// --- 화면 테마 ---------------------------------------------------------------

/** window.localStorage 는 접근만으로도 예외가 날 수 있다(저장소 차단) */
function themeStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

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
  applyTheme(readTheme(themeStorage()), themeDom());
  // 자료를 못 불러와도 테마는 바꿀 수 있어야 하므로 아래 공통 click 처리와 따로 둔다
  $('theme').addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-theme-choice]') : null;
    if (!btn) return;
    const saved = writeTheme(themeStorage(), switchTheme(btn.getAttribute('data-theme-choice')));
    if (!saved && !storageWarned) {
      storageWarned = true;
      announce('이 브라우저에는 테마 선택이 저장되지 않습니다');
    }
  });
  // 다른 탭에서 바꾸면 따라간다
  window.addEventListener('storage', (e) => {
    if (isThemeStorageKey(e.key)) switchTheme(readTheme(themeStorage()));
  });
}

// --- 이벤트 -----------------------------------------------------------------

/**
 * 휴대폰 폭(≤520px)에서는 필터와 안내문을 접어 첫 화면에 지도가 보이게 하고, 그보다 넓으면 펼쳐 둔다
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

function init() {
  initTheme();
  initFolds();
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (!btn || !state.data) return;
    if (btn.getAttribute('aria-disabled') === 'true') announce($('kind-locked-note').textContent); // 잠긴 유형 버튼
    else if (btn.hasAttribute('data-filter')) setFilter(btn.dataset.filter, btn.dataset.value);
    else if (btn.hasAttribute('data-district')) toggleDistrict(btn.dataset.district);
    else if (btn.hasAttribute('data-select')) select(btn.getAttribute('data-select'), { focus: true });
    else if (btn.hasAttribute('data-back')) leaveDetail();
    else if (btn.dataset.empty === 'clear-q') clearQuery();
    else if (btn.dataset.empty === 'reset' || btn.id === 'f-reset') resetFilters();
    else if (btn.id === 'more') showMore();
    else if (btn.id === 'clear-district') toggleDistrict(state.filters.district);
  });
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
