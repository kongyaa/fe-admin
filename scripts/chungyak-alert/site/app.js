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

// 정렬 순서이기도 하다: 공고 나옴 → 1년 안 → 3년 안 → 3년 뒤·미정 → 공고 있었음 → 예상 지남 → 분양했을 가능성 → 준공
// 파이프라인(src/pipeline/expected-window.js)의 BUCKETS와 같게 둔다.
export const BUCKET_ORDER = ['live', 'soon', 'mid', 'far', 'announced', 'overdue', 'likely_sold', 'done'];
export const BUCKET_INFO = {
  live: { label: '공고 나옴', cls: 'c-live' },
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
 * 예상 시기 구간: live(공고 나옴) | soon(12개월 안) | mid(36개월 안) | far(그 뒤·미정)
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
 * 필터에 맞는지. filters = { area, kind, stage('seoul:이주' 형식 또는 ''), when, district, q }
 * bucket 을 미리 계산해 두었으면 넘겨서 다시 계산하지 않는다.
 */
export function matchesFilters(project, filters, todayYm, bucket = bucketOf(project, todayYm)) {
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
    const hay = normalizeText([project.name, project.address, project.roadAddress].join(' '));
    if (!hay.includes(q)) return false;
  }
  return true;
}

/** 목록 순서: 구간(공고 나옴 먼저), 예상 시작 달, 이름 */
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

/** 상세·목록에 보여줄 예상 청약 문구 */
export function windowLabel(project, todayYm) {
  const bucket = bucketOf(project, todayYm);
  const range = windowRange(project);
  if (bucket === 'done') return '준공';
  if (bucket === 'overdue') return range ? `${range} (지남)` : '예상 지남';
  if (bucket === 'likely_sold') return range ? `${range} (지남, 분양했을 가능성)` : '분양했을 가능성';
  if (bucket === 'announced') {
    const latest = latestAnnounce(project);
    return latest ? `공고 있었음(${latest})` : '공고 있었음';
  }
  if (bucket === 'live') return range ?? '공고 나옴';
  return range ?? '3년 뒤·미정';
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
 * 구별 집계: 서울 사업만, 구 이름 → { n: 전체, soon: 공고 나옴·1년 안, mid: 3년 안 }
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

/** 타일 색 3단계: 1년 안(공고 나옴 포함) 3곳 이상 → hot, 1~2곳이거나 3년 안이 있으면 → has, 그 밖 → '' */
export function tileClass(stat) {
  const soon = stat?.soon ?? 0;
  if (soon >= 3) return 'hot';
  if (soon >= 1 || (stat?.mid ?? 0) > 0) return 'has';
  return '';
}

/** '#p=<id>' 에서 id 를 꺼낸다 */
export function idFromHash(hash) {
  const m = /^#p=(.+)$/.exec(String(hash ?? ''));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
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

const DEFAULT_FILTERS = Object.freeze({ area: 'all', kind: 'all', stage: '', when: 'all', district: null, q: '' });

const state = {
  data: null,
  today: '',
  todayYm: '',
  projects: [], // 정렬된 전체 목록
  byId: new Map(),
  bucket: new Map(), // id → 구간
  stages: DEFAULT_STAGES,
  filters: { ...DEFAULT_FILTERS },
  base: [], // 구 선택을 뺀 필터 결과(타일·지구 목록용)
  visible: [], // 구 선택까지 적용한 결과(목록·타임라인용)
  shown: PAGE_SIZE,
  selected: null,
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
  status.replaceChildren(
    h('b', {}, `사업 목록(${dataFile(location.search)})을 불러오지 못했습니다.`),
    h('span', {}, ` 잠시 뒤 다시 시도해 주세요. (${kind})`),
    h('div', {}, retry),
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

  renderHeader();
  renderSources();
  buildStageSelect();
  $('sample-banner').hidden = data.sample !== true;
  $('app').hidden = false;
  applyFilters();

  const fromHash = idFromHash(location.hash);
  if (fromHash) select(fromHash, { fromHash: true, scroll: true });
  else if (state.visible[0]) select(state.visible[0].id, { fromHash: true });
  else renderDetail(null);
}

// --- 머리말·출처 ------------------------------------------------------------

function renderHeader() {
  const s = state.data.sources ?? {};
  const parts = [];
  if (s.seoul?.asOf) parts.push(`서울 정비사업 자료 ${s.seoul.asOf} 기준`);
  if (s.newtowns?.asOf) parts.push(`신도시 목록 ${s.newtowns.asOf} 확인`);
  if (state.data.generatedAt) parts.push(`생성 ${state.data.generatedAt}`);
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
      h('span', {}, '경기 공공주택지구: 저장소에서 직접 관리하는 목록'),
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
  state.base = state.projects.filter((p) => matchesFilters(p, rest, state.todayYm, state.bucket.get(p.id)));
  state.visible = district ? state.base.filter((p) => p.district === district) : state.base;
  if (!keepPage) state.shown = PAGE_SIZE;
  syncFilterControls();
  keepFocus($('tiles'), renderTiles);
  keepFocus($('towns'), renderTowns);
  keepFocus($('list'), renderList);
  keepFocus($('gantt'), renderGantt);
}

function syncFilterControls() {
  for (const btn of document.querySelectorAll('[data-filter]')) {
    btn.setAttribute('aria-pressed', String(state.filters[btn.dataset.filter] === btn.dataset.value));
  }
  $('f-stage').value = state.filters.stage;
  if ($('f-q').value !== state.filters.q) $('f-q').value = state.filters.q;
}

function setFilter(key, value) {
  state.filters[key] = value;
  // 경기만 보는데 서울 구를 고른 상태면 구 선택은 의미가 없다
  if (key === 'area' && value === '경기') state.filters.district = null;
  applyFilters();
}

function toggleDistrict(district) {
  const next = state.filters.district === district ? null : district;
  state.filters.district = next;
  if (next && state.filters.area === '경기') state.filters.area = 'all';
  applyFilters();
  announce(next ? `${shortDistrict(next)} 사업 ${state.visible.length}곳` : `구 선택 해제, ${state.visible.length}곳`);
}

// --- 타일 지도·지구 목록 -----------------------------------------------------

function renderTiles() {
  const stats = tileStats(state.base, (p) => state.bucket.get(p.id));
  $('tiles').replaceChildren(...TILE_LAYOUT.flat().map((district) => {
    if (!district) return h('span', { class: 'tile empty', 'aria-hidden': 'true' });
    const st = stats.get(district) ?? { n: 0, soon: 0, mid: 0 };
    const cls = ['tile', tileClass(st), st.n ? '' : 'zero'].filter(Boolean).join(' ');
    const label = `${district} ${st.n}곳${st.soon ? `, 1년 안 ${st.soon}곳` : ''}${st.mid ? `, 3년 안 ${st.mid}곳` : ''}`;
    return h('button', {
      type: 'button', class: cls, 'data-key': district, 'data-district': district,
      'aria-pressed': String(state.filters.district === district), 'aria-label': label, title: label,
    }, h('span', { class: 'tile-name' }, shortDistrict(district)), h('b', {}, String(st.n)));
  }));
}

function renderTowns() {
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
  const range = windowRange(p);
  return h('button', {
    type: 'button', class: 'item', 'data-key': p.id, 'data-select': p.id, 'aria-current': String(state.selected === p.id),
  },
  h('span', { class: 'item-name' }, p.name ?? ''),
  chip(state.bucket.get(p.id)),
  h('span', { class: 'meta' },
    h('span', {}, p.kind ?? ''),
    h('span', {}, p.region === '서울' ? shortDistrict(p.district) : placeLabel(p)),
    h('span', {}, p.stage ?? ''),
    range ? h('span', {}, `예상 ${range}`) : null));
}

function renderList() {
  const f = state.filters;
  const total = state.visible.length;
  const shown = state.visible.slice(0, state.shown);
  const areaLabel = f.area === '서울' ? '서울 사업' : f.area === '경기' ? '경기 공공주택지구' : '전체 사업';
  $('list-title').textContent = f.district ? `${f.district} 사업` : areaLabel;
  $('list-count').textContent = `${total.toLocaleString('ko-KR')}곳`;
  $('clear-district').hidden = !f.district;
  $('list').replaceChildren(...(total
    ? shown.map(listItem)
    : [h('p', { class: 'note' }, '조건에 맞는 사업이 없습니다. 필터를 줄여 보세요.')]));
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
    fact('일반분양 예상', fmtCount(p.generalSupply)),
    fact('예상 청약', windowLabel(p, state.todayYm)),
  ];

  const steps = h('ol', { class: 'steps', 'aria-label': '사업 단계' }, stages.map((name, i) => {
    const cls = i < idx ? 'done' : i === idx ? 'now' : '';
    const date = typeof dates[name] === 'string' ? dates[name] : null;
    return h('li', { class: cls || null, 'aria-current': i === idx ? 'step' : null },
      h('span', { class: 'visually-hidden' }, i < idx ? '지난 단계: ' : i === idx ? '현재 단계: ' : '남은 단계: '),
      name,
      date ? h('small', {}, date) : null);
  }));

  const notices = Array.isArray(p.notices) ? p.notices : [];
  const noticeBlock = notices.length
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
          open ? h('span', { class: 'chip c-live' }, '접수 중') : null);
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
      h('h2', { class: 'detail-name', tabindex: '-1', id: 'detail-title' }, p.name ?? ''),
      chip(bucket)),
    h('div', { class: 'facts' }, facts),
    h('div', { class: 'steps-wrap', tabindex: '0', 'aria-label': '사업 단계, 가로로 스크롤' }, steps),
    h('p', { class: 'why' }, h('b', {}, '예상 근거 '), p.windowBasis || '근거 정보 없음'),
    typeof p.notes === 'string' && p.notes.trim() ? h('details', { class: 'memo' }, h('summary', {}, '조사 메모'), h('p', {}, p.notes)) : null,
    noticeBlock,
    sourceBlock,
  ].filter(Boolean));
  // 단계가 많아 가로로 넘치면 현재 단계가 보이도록 스크롤
  const wrap = box.querySelector('.steps-wrap');
  const now = box.querySelector('.steps li.now');
  if (wrap && now && wrap.scrollWidth > wrap.clientWidth) {
    wrap.scrollLeft = Math.max(0, now.offsetLeft - (wrap.clientWidth - now.offsetWidth) / 2);
  }
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
  if (!fromHash) history.replaceState(null, '', `#p=${encodeURIComponent(id)}`);
  if (focus) announce(`${p.name} 상세`);
  if ((focus || scroll) && narrow.matches) {
    $('detail').scrollIntoView({ block: 'start' });
    $('detail-title').focus({ preventScroll: true });
  }
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
    const range = windowRange(p);
    const said = [range ? `예상 ${range}` : '', ...bars.filter((b) => b.kind === 'live').map((b) => `공고 나옴 ${b.label}`)].filter(Boolean).join(', ');
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
  const note = $('gantt-note');
  if (!total) note.textContent = '조건에 맞는 사업 중 앞으로 36개월 안에 예상되거나 공고가 난 곳이 없습니다.';
  else if (total > rows.length) note.textContent = `36개월 안에 걸친 ${total.toLocaleString('ko-KR')}곳 중 앞의 ${rows.length}곳만 그렸습니다. 나머지 ${(total - rows.length).toLocaleString('ko-KR')}곳은 필터를 좁히거나 목록에서 보세요.`;
  else note.textContent = `36개월 안에 걸친 ${total.toLocaleString('ko-KR')}곳`;
}

// --- 이벤트 -----------------------------------------------------------------

function init() {
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (!btn || !state.data) return;
    if (btn.hasAttribute('data-filter')) setFilter(btn.dataset.filter, btn.dataset.value);
    else if (btn.hasAttribute('data-district')) toggleDistrict(btn.dataset.district);
    else if (btn.hasAttribute('data-select')) select(btn.getAttribute('data-select'), { focus: true });
    else if (btn.hasAttribute('data-back')) backToList();
    else if (btn.id === 'more') showMore();
    else if (btn.id === 'clear-district') toggleDistrict(state.filters.district);
    else if (btn.id === 'f-reset') {
      state.filters = { ...DEFAULT_FILTERS };
      applyFilters();
      announce(`필터 초기화, ${state.visible.length}곳`);
    }
  });
  $('f-stage').addEventListener('change', (e) => setFilter('stage', e.target.value));
  let timer = 0;
  $('f-q').addEventListener('input', (e) => {
    clearTimeout(timer);
    const value = e.target.value;
    timer = setTimeout(() => {
      state.filters.q = value.trim();
      applyFilters();
      announce(`검색 결과 ${state.visible.length}곳`);
    }, 150);
  });
  window.addEventListener('hashchange', () => {
    const id = idFromHash(location.hash);
    if (id && state.data && id !== state.selected) select(id, { fromHash: true, scroll: true });
  });
  load();
}

if (typeof document !== 'undefined') init();
