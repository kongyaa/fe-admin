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
    '블록별 분양': { from: 0, to: 24, fromToday: true, basis: '다음 블록 예상(규칙): 오늘부터 0~2년' },
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
export function blockKey(value) {
  return String(value ?? '').toUpperCase().replace(/\s+|-|BL$|블록$/g, '');
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

// 분양 계획(임대 제외)에서 아직 공고가 안 난 블록만 남긴다. 계획 보도일(가장 이른 출처 날짜, 없으면 계획 시작 달) 이후의
// 분양 이력(임대·사전청약 제외)에 같은 블록이 있으면 그 블록은 공고가 난 것으로 본다.
function pendingPlans(plans, history) {
  const announced = (history ?? []).filter((entry) => entry && !entry.rental && entry.stage !== PRE_SUBSCRIPTION && entry.noticeDate);
  return (plans ?? []).flatMap((plan) => {
    if (!plan || plan.rental) return [];
    const range = planRange(plan.expected);
    if (!range) return [];
    const since = (plan.sources ?? []).map((source) => toMonth(source?.date)).filter(Boolean).sort()[0] ?? range.from;
    const blocks = (plan.blocks ?? []).filter((block) => !announced.some(
      (entry) => blockKey(entry.block) === blockKey(block) && monthsBetween(since, entry.noticeDate) >= 0,
    ));
    return blocks.length ? [{ ...plan, ...range, blocks }] : [];
  });
}

// 블록별 분양 지구의 다음 블록 예상.
// 1) 아직 안 끝난 분양 계획이 있으면 가장 이른 계획(같은 기간이면 블록을 합침) -> town-plan
// 2) 계획은 있는데 모두 지났고 공고도 없으면 오늘부터 12개월 -> town-plan-late
// 3) 계획이 없으면 null(확장 규칙으로)
export function townPlanWindow({ plans = [], history = [], today }) {
  const pending = pendingPlans(plans, history);
  if (pending.length === 0) return null;
  const now = toMonth(today);
  const upcoming = pending.filter((plan) => monthsBetween(now, plan.to) >= 0)
    .sort((a, b) => monthsBetween(b.from, a.from) || monthsBetween(b.to, a.to));
  if (upcoming.length > 0) {
    const [first] = upcoming;
    const same = upcoming.filter((plan) => plan.from === first.from && plan.to === first.to);
    const source = first.sources?.[0];
    const said = [sourceOutlet(source), source?.date || '날짜 없음'].join(' ');
    return {
      from: first.from,
      to: first.to,
      basis: `보도된 다음 블록 계획: ${joinBlocks(same.flatMap((plan) => plan.blocks))} ${first.expected} (${said})`,
      rule: 'town-plan',
      status: 'estimated',
    };
  }
  // 가장 늦게 끝난 계획의 시기를 근거에 적는다
  const latest = [...pending].sort((a, b) => monthsBetween(b.to, a.to)).at(-1);
  return {
    from: now,
    to: addMonths(now, 12),
    basis: `보도된 일정(${latest.expected})이 지났지만 공고는 아직 없습니다. 남은 블록 순차 공고`,
    rule: 'town-plan-late',
    status: 'estimated',
  };
}

// expected: 보도 등으로 알려진 계획 { from, to, basis }. 있으면 규칙보다 우선한다.
// plans·history: 블록별 분양 지구의 블록 계획과 분양 이력(newtowns.yaml). 블록별 분양 단계에서만 본다.
export function expectedWindow({ kind, stage, stageDates = {}, today, expected = null, plans = [], history = [] }) {
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
    const planned = townPlanWindow({ plans, history, today });
    if (planned) return planned;
  }
  if (!rule) return { from: null, to: null, basis: '단계 정보가 없어 예상하지 않음', rule: 'unknown', status: 'unknown' };
  if (rule.far) return { from: null, to: null, basis: rule.far, rule: `${kind}:${stage}`, status: 'far' };
  const span = `${years(rule.from)}~${years(rule.to)}년`;
  const note = rule.note ? `, ${rule.note}` : '';
  if (rule.fromToday) {
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
export function applyWindow(project, today) {
  const result = expectedWindow({
    kind: project.kind,
    stage: project.stage,
    stageDates: project.stageDates,
    today,
    expected: project.expected,
    plans: project.plans,
    history: project.history,
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
