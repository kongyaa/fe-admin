// 분양 예상 시기 규칙. 현재 단계의 날짜에서 몇 년 뒤인지로 거칠게 잡는다(설계 부록의 표).
// 날짜가 없으면 오늘을 기준으로 하고 근거 문구에 적는다.

const FAR_REDEVELOP = { far: '사업시행인가 전이라 36개월 밖으로 예상' };
const REDEVELOP_RULES = {
  구역지정: FAR_REDEVELOP,
  추진위: FAR_REDEVELOP,
  조합설립: FAR_REDEVELOP,
  건축심의: FAR_REDEVELOP,
  사업시행인가: { from: 36, to: 60 },
  관리처분인가: { from: 18, to: 36 },
  이주: { from: 6, to: 24 },
  착공: { from: 0, to: 12, note: '일반분양은 착공 전후가 많음' },
  // 공고가 이미 나온 단계는 공고 연결로 live가 된다. 연결이 안 됐으면 착공과 같게 본다.
  일반분양: { from: 0, to: 12, note: '일반분양 단계' },
};

export const WINDOW_RULES = {
  재개발: REDEVELOP_RULES,
  재건축: REDEVELOP_RULES,
  공공주택지구: {
    후보지: { far: '지구지정 전이라 36개월 밖으로 예상' },
    지구지정: { from: 36, to: 60 },
    지구계획승인: { from: 18, to: 36 },
    '부지조성 착공': { from: 12, to: 24, note: '블록별 순차 공고' },
    // 설계 표에 없는 확장 규칙이다. 단계 날짜가 아니라 오늘부터 잡는다.
    // 보도된 블록 계획(newtowns.yaml plans)이 있으면 그쪽을 먼저 쓴다(townPlanWindow).
    '블록별 분양': { from: 0, to: 24, fromToday: true, basis: '규칙: 오늘부터 0~2년' },
    준공: { done: '준공되어 남은 분양 없음으로 봄' },
  },
};

// 'YYYY-MM' 또는 'YYYY-MM-DD' -> 월 번호
function monthNumber(value) {
  const match = /^(\d{4})-(\d{2})/.exec(String(value ?? ''));
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return Number(match[1]) * 12 + (month - 1);
}

function monthString(number) {
  return `${Math.floor(number / 12)}-${String((number % 12) + 1).padStart(2, '0')}`;
}

export function toMonth(value) {
  const number = monthNumber(value);
  return number === null ? null : monthString(number);
}

export function addMonths(value, months) {
  const number = monthNumber(value);
  return number === null ? null : monthString(number + months);
}

// a에서 b까지 몇 달인지 (b가 앞이면 음수). 일은 보지 않는다.
export function monthsBetween(a, b) {
  const from = monthNumber(a);
  const to = monthNumber(b);
  return from === null || to === null ? null : to - from;
}

const years = (months) => String(months / 12);

// 이 단계에서 예상 시기가 지났으면 이미 분양했을 가능성이 크다(공고 연결이 안 됐을 뿐).
// 그 앞 단계(사업시행인가, 관리처분인가, 공공주택지구 단계)는 지연으로 본다.
export const LIKELY_SOLD_STAGES = ['이주', '착공', '일반분양'];

// 기간이 다 지났을 때의 상태: 단계에 따라 likely_sold 또는 overdue
export function passedStatus(stage) {
  return LIKELY_SOLD_STAGES.includes(stage) ? 'likely_sold' : 'overdue';
}

const PASSED_BASIS = {
  likely_sold: '예상 시기가 지났습니다. 이미 분양했을 가능성이 큽니다(공고 미확인)',
  overdue: '예상 시기가 지났습니다(지연 가능성)',
};

function withOverdue(result, today, stage) {
  if (monthsBetween(today, result.to) < 0) {
    const status = passedStatus(stage);
    return { ...result, status, basis: `${result.basis}. ${PASSED_BASIS[status]}` };
  }
  return { ...result, status: 'estimated' };
}

// 블록별 분양 중인 지구: 기간은 첫 청약이 아니라 다음 블록 예상이다(사이트 표시 이름).
export const BLOCK_STAGE = '블록별 분양';
export const NEXT_BLOCK_LABEL = '다음 블록 예상';

export function isBlockTown(kind, stage) {
  return kind === '공공주택지구' && stage === BLOCK_STAGE;
}

// 보도된 블록 계획 시기 -> 달 범위. 'YYYY-MM' 한 달, 'YYYY-상반기' 1~6월, 'YYYY-하반기' 7~12월. 형식이 아니면 null.
export function planRange(expected) {
  const raw = String(expected ?? '').trim();
  const half = /^(\d{4})-(상반기|하반기)$/.exec(raw);
  if (half) return half[2] === '상반기' ? { from: `${half[1]}-01`, to: `${half[1]}-06` } : { from: `${half[1]}-07`, to: `${half[1]}-12` };
  if (!/^\d{4}-\d{2}$/.test(raw)) return null;
  const month = toMonth(raw);
  return month ? { from: month, to: month } : null;
}

// 'A-1', 'A1BL', 'A1블록' -> 'A1' (출처마다 블록 표기가 달라 비교용으로만 쓴다). site/app.js의 blockKey와 같게 둔다.
// 글자와 숫자 사이의 '-'만 뺀다. 'A2-1'은 'A21'과 다른 블록이라 그대로 둔다.
export function blockKey(value) {
  return String(value ?? '').toUpperCase().replace(/\s+/g, '').replace(/(BL|블록)$/, '').replace(/(?<=[A-Z])-(?=\d)/g, '');
}

// 보도 기사·자료를 낸 곳: source.outlet, 없으면 제목 끝 괄호, 없으면 주소의 호스트. site/app.js의 sourceOutlet과 같게 둔다.
export function sourceOutlet(source) {
  if (source?.outlet) return String(source.outlet);
  const paren = /\(([^()]+)\)\s*$/.exec(String(source?.title ?? ''));
  if (paren) return paren[1].trim();
  try {
    return new URL(String(source?.url ?? '')).hostname.replace(/^(www|m)\./, '') || '출처';
  } catch {
    return '출처';
  }
}

const joinBlocks = (blocks) => blocks.join('·');

// 사전청약은 본청약 공고가 아니다. 분양 계획을 채우거나 최근 분양으로 세지 않는다(site/app.js와 같은 값).
export const PRE_SUBSCRIPTION = '사전청약';

// a가 b와 같거나 뒤인지. 둘 다 일까지 있으면 날짜로, 아니면 달로 비교한다. 어느 쪽이든 날짜가 아니면 null.
export function onOrAfter(a, b) {
  const day = /^\d{4}-\d{2}-\d{2}/;
  if (day.test(String(a ?? '')) && day.test(String(b ?? ''))) return String(a).slice(0, 10) >= String(b).slice(0, 10);
  const months = monthsBetween(b, a);
  return months === null ? null : months >= 0;
}

// 공식 자료(국토부·지자체 *.go.kr, LH·SH·GH, 청약홈) 주소. 이 밖의 출처만 있는 계획은 보도뿐인 계획이다.
const OFFICIAL_HOST = /(^|\.)(go\.kr|lh\.or\.kr|i-sh\.co\.kr|gh\.or\.kr|applyhome\.co\.kr)$/;

function isOfficialSource(source) {
  try {
    return OFFICIAL_HOST.test(new URL(String(source?.url ?? '')).hostname);
  } catch {
    return false;
  }
}

// 계획 보도일: 출처 중 가장 이른 날짜. 날짜 있는 출처가 없으면 null. 블록별 현황(blocks.js)도 쓴다.
export function reportDate(plan) {
  return (plan.sources ?? []).map((source) => source?.date).filter((date) => toMonth(date)).sort()[0] ?? null;
}

// 비교용 이름: 공백·가운뎃점과 글자-숫자 사이 '-'를 뺀다(site/app.js의 compactName과 같다)
export const compactName = (value) => String(value ?? '').toUpperCase().replace(/[\s·]/g, '').replace(/(?<=[A-Z])-(?=\d)/g, '');

// 공고명에 블록 이름이 있는지. 'A2'는 '…(A-2BL)'에 맞고 'A20'·'BA2'·'A2-1'에는 맞지 않는다(site/app.js nameHasBlock과 같다)
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

// 청약홈 공고 유형 중 임대와 사전청약. site/app.js의 RENTAL_NOTICE_TYPES·NOTICE_PRE_SUBSCRIPTION과 같은 값.
export const RENTAL_NOTICE_TYPES = ['민간임대', '공공지원민간임대'];
export const NOTICE_PRE_SUBSCRIPTION = '민간사전청약';
// 임대 공고: 청약홈 임대 유형이거나, 유형·공고명에 '임대'·'행복주택'이 있는 공고('A-1블록 행복주택', 'A-4블록 6년 분양전환공공임대주택').
// 블록별 현황에서 임대 공고는 그 블록의 임대 줄에만, 분양 공고는 분양 줄에만 붙는다. site/app.js isRentalNotice와 같은 규칙.
export const isRentalNotice = (notice) => RENTAL_NOTICE_TYPES.includes(notice?.typeLabel)
  || /임대|행복주택/.test(`${notice?.typeLabel ?? ''} ${notice?.name ?? ''}`);

// 계획의 하한: 계획 보도일, 출처에 날짜가 없으면 지구의 블록별 분양 단계 날짜(stageDate), 그것도 없으면 null(하한 없음)
export function planSince(plan, stageDate = null) {
  return reportDate(plan) ?? (toMonth(stageDate) ? stageDate : null);
}

/**
 * 계획의 블록 하나가 공고가 났는지. 다음 블록 예상(pendingPlans)과 블록별 현황(blocks.js)이 같이 쓰는 규칙이다.
 * 아래 중 하나의 날짜가 하한(since, null이면 하한 없음)과 같거나 뒤면 공고가 난 것으로 본다.
 * - 같은 블록(blockKey)의 본청약 이력(사전청약 제외). 오늘 뒤 날짜의 이력은 아직 난 공고가 아니라 보지 않는다.
 * - 공고명에 그 블록 이름이 있는(nameHasBlock) 연결된 청약홈 공고(민간사전청약 제외).
 * 분양 계획(rental false)은 분양 이력·임대가 아닌 공고만, 임대 계획은 임대 이력·임대 공고(민간임대·공공지원민간임대)만 본다.
 * 계획 시기보다 이른 공고도 계획을 채운다(앞당겨 공고한 경우).
 */
export function blockAnnounced(block, {
  history = [], notices = [], since = null, today = null, rental = false,
} = {}) {
  const fromSince = (date) => Boolean(date) && (!since || onOrAfter(date, since) === true);
  const byHistory = (history ?? []).some((entry) => entry && (entry.rental === true) === rental && entry.stage !== PRE_SUBSCRIPTION
    && blockKey(entry.block) === blockKey(block) && (!today || onOrAfter(today, entry.noticeDate) === true) && fromSince(entry.noticeDate));
  if (byHistory) return true;
  return (notices ?? []).some((notice) => notice && isRentalNotice(notice) === rental && notice.typeLabel !== NOTICE_PRE_SUBSCRIPTION
    && nameHasBlock(notice.name, block) && fromSince(notice.announceDate));
}

// 분양 계획(임대 제외)에서 아직 공고가 안 난 블록만 남긴다. 공고가 났는지는 blockAnnounced(이력과 연결된 청약홈 공고).
// 하한은 계획 보도일, 출처에 날짜가 없으면 지구의 블록별 분양 단계 날짜(stageDate), 그것도 없으면 하한 없음(planSince).
// 남은 계획에는 달 범위(from·to)와 보도일(reportedAt, 날짜 있는 출처가 없으면 null)을 붙인다.
export function pendingPlans(plans, history, { stageDate = null, today = null, notices = [] } = {}) {
  return (plans ?? []).flatMap((plan) => {
    if (!plan || plan.rental) return [];
    const range = planRange(plan.expected);
    if (!range) return [];
    const reportedAt = reportDate(plan);
    const since = planSince(plan, stageDate);
    const blocks = (plan.blocks ?? []).filter((block) => !blockAnnounced(block, {
      history, notices, since, today, rental: false,
    }));
    return blocks.length ? [{ ...plan, ...range, blocks, reportedAt }] : [];
  });
}

// 근거 끝에 붙이는 확인 정도. 공식 자료 없이 보도뿐인 계획이면 계획의 note, 없으면 '공고 미확인'.
function pressSuffix(plans) {
  if (plans.some((plan) => (plan.sources ?? []).some(isOfficialSource))) return '';
  const notes = [...new Set(plans.map((plan) => plan.note).filter(Boolean))];
  return `. ${notes.length ? notes.join('. ') : '공고 미확인'}`;
}

// 블록별 분양 지구의 다음 블록 예상. 출처에 날짜가 없는 계획은 기간에 쓰지 않는다(근거로 적을 보도일이 없음).
// 1) 아직 안 끝난 분양 계획이 있으면 가장 이른 계획(같은 기간이면 블록을 합침) -> town-plan.
//    보이는 기간 시작은 이번 달보다 앞서지 않게 자른다(지난 달을 예상으로 보여 주지 않음).
// 2) 계획은 있는데 모두 지났고 공고도 없으면 오늘부터 12개월 -> town-plan-late
// 3) 쓸 계획이 없으면 null(확장 규칙으로)
export function townPlanWindow({
  plans = [], history = [], notices = [], today, stageDate = null,
}) {
  const pending = pendingPlans(plans, history, { stageDate, today, notices }).filter((plan) => plan.reportedAt);
  if (pending.length === 0) return null;
  const now = toMonth(today);
  const upcoming = pending.filter((plan) => monthsBetween(now, plan.to) >= 0)
    .sort((a, b) => monthsBetween(b.from, a.from) || monthsBetween(b.to, a.to));
  if (upcoming.length > 0) {
    const [first] = upcoming;
    const same = upcoming.filter((plan) => plan.from === first.from && plan.to === first.to);
    // 근거에는 날짜 있는 첫 번째 출처를 적는다
    const source = (first.sources ?? []).find((item) => toMonth(item?.date));
    const said = `${sourceOutlet(source)} ${source.date}`;
    return {
      from: monthsBetween(now, first.from) > 0 ? first.from : now,
      to: first.to,
      basis: `보도된 다음 블록 계획: ${joinBlocks(same.flatMap((plan) => plan.blocks))} ${first.expected} (${said})${pressSuffix(same)}`,
      rule: 'town-plan',
      status: 'estimated',
    };
  }
  // 지난 계획의 블록과 시기를 기간 순으로 근거에 적는다
  const passed = [...pending].sort((a, b) => monthsBetween(b.from, a.from) || monthsBetween(b.to, a.to))
    .map((plan) => `${joinBlocks(plan.blocks)} ${plan.expected}`).join(', ');
  return {
    from: now,
    to: addMonths(now, 12),
    basis: `보도된 일정(${passed})이 지났지만 공고는 아직 없습니다. 남은 블록 순차 공고`,
    rule: 'town-plan-late',
    status: 'estimated',
  };
}

// expected: 보도 등으로 알려진 계획 { from, to, basis }. 있으면 규칙보다 우선한다.
// plans·history: 블록별 분양 지구의 블록 계획과 분양 이력(newtowns.yaml). 블록별 분양 단계에서만 본다.
// notices: 이 사업에 이어진 청약홈 공고. 공고명에 계획 블록 이름이 있으면 그 블록은 공고가 난 것으로 본다(blockAnnounced).
// liveEnd: 블록별 분양 지구에 이어진 접수 중 공고의 마감일. 있으면 확장 규칙 기간을 마감 다음 달부터 잡는다.
export function expectedWindow({
  kind, stage, stageDates = {}, today, expected = null, plans = [], history = [], notices = [], liveEnd = null,
}) {
  const rule = WINDOW_RULES[kind]?.[stage];
  if (rule?.done) return { from: null, to: null, basis: rule.done, rule: `${kind}:${stage}`, status: 'done' };
  if (expected?.from && expected?.to) {
    const from = toMonth(expected.from);
    const to = toMonth(expected.to);
    if (from && to) {
      const basis = expected.basis ? `알려진 계획: ${expected.basis}` : '알려진 계획';
      return withOverdue({ from, to, basis, rule: 'reported' }, today, stage);
    }
  }
  if (isBlockTown(kind, stage)) {
    const planned = townPlanWindow({
      plans, history, notices, today, stageDate: stageDates?.[stage] ?? null,
    });
    if (planned) return planned;
  }
  if (!rule) return { from: null, to: null, basis: '단계 정보가 없어 예상하지 않음', rule: 'unknown', status: 'unknown' };
  if (rule.far) return { from: null, to: null, basis: rule.far, rule: `${kind}:${stage}`, status: 'far' };
  const span = `${years(rule.from)}~${years(rule.to)}년`;
  const note = rule.note ? `, ${rule.note}` : '';
  if (rule.fromToday) {
    // 접수 중인 공고가 있으면 다음 블록은 그 뒤다. 마감 달 다음 달부터 잡는다.
    if (isBlockTown(kind, stage) && toMonth(liveEnd) && monthsBetween(today, liveEnd) >= 0) {
      const start = addMonths(liveEnd, 1);
      return withOverdue({
        from: start,
        to: addMonths(start, rule.to),
        basis: `규칙: 접수 중인 공고(마감 ${liveEnd}) 뒤 ${span}`,
        rule: `${kind}:${stage}`,
      }, today, stage);
    }
    return withOverdue({
      from: toMonth(today),
      to: addMonths(today, rule.to),
      basis: rule.basis ?? `${stage} 중: 오늘부터 ${span}${note}`,
      rule: `${kind}:${stage}`,
    }, today, stage);
  }
  const stageDate = toMonth(stageDates?.[stage]);
  const base = stageDate ?? toMonth(today);
  const label = stageDate ? `${stage}(${stageDate})` : `${stage}(날짜 없음, 오늘 기준)`;
  return withOverdue({
    from: addMonths(base, rule.from),
    to: addMonths(base, rule.to),
    basis: `${label} 뒤 ${span}${note}`,
    rule: `${kind}:${stage}`,
  }, today, stage);
}

// 사업에 예상 시기를 붙인다. window는 기간이 있을 때만 { from, to }.
// 블록별 분양 지구는 windowLabel '다음 블록 예상', 그 밖은 null(사이트에서 '예상 청약').
// project.notices: 연결된 청약홈 공고(공고 연결 뒤에만 있다). liveEnd: 접수 중인 공고 마감일.
// build-map은 공고 연결 뒤 블록별 분양 지구에 다시 부른다(이어진 공고가 계획 블록을 채우고, 접수 중이면 liveEnd도 넘긴다).
export function applyWindow(project, today, { liveEnd = null } = {}) {
  const result = expectedWindow({
    kind: project.kind,
    stage: project.stage,
    stageDates: project.stageDates,
    today,
    expected: project.expected,
    plans: project.plans,
    history: project.history,
    notices: project.notices,
    liveEnd,
  });
  return {
    ...project,
    window: result.from ? { from: result.from, to: result.to } : null,
    windowBasis: result.basis,
    windowStatus: result.status,
    windowRule: result.rule,
    windowLabel: isBlockTown(project.kind, project.stage) ? NEXT_BLOCK_LABEL : null,
  };
}

// 정렬 순서이기도 하다. site/app.js의 BUCKET_ORDER와 같게 둔다.
export const BUCKETS = ['live', 'soon', 'mid', 'far', 'announced', 'overdue', 'likely_sold', 'done'];

// 상태가 곧 구간인 값
const STATUS_BUCKETS = ['done', 'announced', 'likely_sold', 'overdue'];

// live(접수 중인 공고 연결) > done·announced(지난 공고만 연결)·likely_sold·overdue(상태 그대로)
// > 기간 없음 far > 기간이 다 지났으면 단계로 likely_sold 또는 overdue(만든 뒤 시간이 지난 자료 대비)
// > 시작까지 12개월 미만 soon, 36개월 미만 mid, 나머지 far
export function bucketOf(project, today) {
  if (project.live) return 'live';
  const status = project.windowStatus;
  if (STATUS_BUCKETS.includes(status)) return status;
  const from = project.window?.from ?? null;
  const months = from && status !== 'far' ? monthsBetween(today, from) : null;
  if (months === null) return 'far';
  if (monthsBetween(today, project.window.to ?? from) < 0) return passedStatus(project.stage);
  if (months < 12) return 'soon';
  if (months < 36) return 'mid';
  return 'far';
}
