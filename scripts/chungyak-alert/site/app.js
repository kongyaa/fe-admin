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
    let end = null;
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
export const BLOCK_STATUS_ORDER = ['접수 중', '분양 끝남', '임대 공고', '다음 예정(보도)', '착공', '사업승인', '계획 보도', '미정'];
export const BLOCK_STATUS_CLASS = {
  '접수 중': 'c-live',
  '분양 끝남': 'c-sold',
  '임대 공고': 'c-rent',
  '다음 예정(보도)': 'c-mid',
  착공: 'c-ann',
  사업승인: 'c-appr',
  '계획 보도': 'c-pre',
  미정: 'c-far',
};
export const UNKNOWN_BLOCK_TYPE = '유형 미확인';
const BLOCK_LIVE = '접수 중';
const BLOCK_STAGES = [PRE_SUBSCRIPTION, '본청약', BLOCK_LIVE];

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
 * 오늘 기준 상태. 빌드 뒤에 접수 마감(statusDate)이 지났으면 '접수 중'을 분양 줄은 '분양 끝남', 임대 줄은 '임대 공고'로 바꾸고,
 * 날짜는 경과에서 가장 늦은 공고일로 둔다. 모르는 상태는 '미정'.
 */
export function blockStatusNow(row, today) {
  const status = BLOCK_STATUS_ORDER.includes(row?.status) ? row.status : '미정';
  const date = ymdOrNull(row?.statusDate);
  if (status !== BLOCK_LIVE || !date || !today || date >= today) return { status, date };
  const issued = (Array.isArray(row?.timeline) ? row.timeline : [])
    .filter((t) => t && t.stage !== BLOCK_LIVE && t.stage !== PRE_SUBSCRIPTION).map((t) => ymdOrNull(t.date)).filter(Boolean).sort();
  return { status: row.rental === true ? '임대 공고' : '분양 끝남', date: issued.at(-1) ?? null };
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
      timeline: entriesOf(b.timeline).filter((t) => BLOCK_STAGES.includes(t.stage) && ymdOrNull(t.date))
        .map((t) => ({ stage: t.stage, date: ymdOrNull(t.date) })),
      plan,
      note: textOrNull(b.note),
      sources: cleanLinks(b.sources),
    };
  }).sort((a, b) => BLOCK_STATUS_ORDER.indexOf(a.status) - BLOCK_STATUS_ORDER.indexOf(b.status)
    || naturalBlock(a.block, b.block) || Number(a.rental) - Number(b.rental));
}

/** 상태별 줄 수 [{ status, count }] (상태 순서, 0은 뺌) */
export function blockStatusCounts(rows) {
  return BLOCK_STATUS_ORDER.map((status) => ({ status, count: rows.filter((r) => r.status === status).length }))
    .filter((c) => c.count > 0);
}

/** '전체 39개 블록 중 16개 사업승인(2025-11, 시티뉴스)'. 전체 블록 수가 없으면 null */
export function blockTotalText(blockTotal) {
  const total = countOrNull(blockTotal?.total);
  if (!total) return null;
  const approved = countOrNull(blockTotal.approved);
  const src = cleanLinks(blockTotal.sources)[0] ?? null;
  const outlet = textOrNull(blockTotal.outlet) ?? (src ? sourceOutlet(src) : null);
  const basis = [toYm(blockTotal.date), outlet].filter(Boolean).join(', ');
  const head = approved !== null ? `전체 ${total}개 블록 중 ${approved}개 사업승인` : `전체 ${total}개 블록`;
  return basis ? `${head}(${basis})` : head;
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
          open ? h('span', { class: 'chip c-live' }, '접수 중') : null),
        r.title ? h('span', { class: 'sale-title' }, r.title) : null,
        r.sources.length
          ? h('span', { class: 'sale-src' }, '출처 ', r.sources.flatMap((src, i) => (i ? [' · ', sourceLink(src)] : [sourceLink(src)])))
          : null);
    })),
    rows.some((r) => r.stage === PRE_SUBSCRIPTION) ? h('p', { class: 'note' }, '사전청약은 본청약 전 예약이라 최근 분양에 세지 않습니다.') : null);
}

const joinLinks = (sources) => sources.flatMap((src, i) => (i ? [' · ', sourceLink(src)] : [sourceLink(src)]));

/**
 * 블록별 현황(블록별 분양 지구만): 상태별 개수, 지구 전체 블록 수(출처 있을 때), 블록 표.
 * 넓은 화면은 표, 좁은 화면(≤480px)은 CSS 로 줄마다 카드처럼 쌓는다(칸 이름은 data-label). 줄이 없으면 null.
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
          return h('tr', {},
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
        })))),
    h('p', { class: 'note' }, '출처로 확인한 블록만 보여 줍니다. 사업승인 날짜는 승인일을 모르면 보도일이고, 유형이 출처에 없으면 "유형 미확인"입니다. '
      + '분양과 임대가 함께 있는 블록은 줄을 나눕니다.'));
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
    fact(windowFactLabel(p), windowLabel(p, state.todayYm)),
  ];

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
    town ? blockSection(p) : null,
    town ? saleSection(p) : noticeBlock,
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
    const said = [range ? `${windowPrefix(p)} ${range}` : '', ...bars.filter((b) => b.kind === 'live').map((b) => `공고 나옴 ${b.label}`)].filter(Boolean).join(', ');
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

function init() {
  initTheme();
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
