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
    '블록별 분양': { from: 0, to: 24, fromToday: true, note: '남은 블록 순차 공고(확장 규칙)' },
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

function withOverdue(result, today) {
  if (monthsBetween(today, result.to) < 0) {
    return { ...result, status: 'overdue', basis: `${result.basis}. 예상 시기가 지났습니다(지연 가능성)` };
  }
  return { ...result, status: 'estimated' };
}

// expected: 보도 등으로 알려진 계획 { from, to, basis }. 있으면 규칙보다 우선한다.
export function expectedWindow({ kind, stage, stageDates = {}, today, expected = null }) {
  const rule = WINDOW_RULES[kind]?.[stage];
  if (rule?.done) return { from: null, to: null, basis: rule.done, rule: `${kind}:${stage}`, status: 'done' };
  if (expected?.from && expected?.to) {
    const from = toMonth(expected.from);
    const to = toMonth(expected.to);
    if (from && to) {
      const basis = expected.basis ? `알려진 계획: ${expected.basis}` : '알려진 계획';
      return withOverdue({ from, to, basis, rule: 'reported' }, today);
    }
  }
  if (!rule) return { from: null, to: null, basis: '단계 정보가 없어 예상하지 않음', rule: 'unknown', status: 'unknown' };
  if (rule.far) return { from: null, to: null, basis: rule.far, rule: `${kind}:${stage}`, status: 'far' };
  const span = `${years(rule.from)}~${years(rule.to)}년`;
  const note = rule.note ? `, ${rule.note}` : '';
  if (rule.fromToday) {
    return withOverdue({
      from: toMonth(today),
      to: addMonths(today, rule.to),
      basis: `${stage} 중: 오늘부터 ${span}${note}`,
      rule: `${kind}:${stage}`,
    }, today);
  }
  const stageDate = toMonth(stageDates?.[stage]);
  const base = stageDate ?? toMonth(today);
  const label = stageDate ? `${stage}(${stageDate})` : `${stage}(날짜 없음, 오늘 기준)`;
  return withOverdue({
    from: addMonths(base, rule.from),
    to: addMonths(base, rule.to),
    basis: `${label} 뒤 ${span}${note}`,
    rule: `${kind}:${stage}`,
  }, today);
}

// 사업에 예상 시기를 붙인다. window는 기간이 있을 때만 { from, to }.
export function applyWindow(project, today) {
  const result = expectedWindow({
    kind: project.kind,
    stage: project.stage,
    stageDates: project.stageDates,
    today,
    expected: project.expected,
  });
  return {
    ...project,
    window: result.from ? { from: result.from, to: result.to } : null,
    windowBasis: result.basis,
    windowStatus: result.status,
    windowRule: result.rule,
  };
}

export const BUCKETS = ['live', 'soon', 'mid', 'far', 'overdue', 'done'];

// live(공고 연결) > done > overdue > far(기간 없음 포함) > 시작까지 12개월 미만 soon, 36개월 미만 mid
export function bucketOf(project, today) {
  if (project.live) return 'live';
  if (project.windowStatus === 'done') return 'done';
  if (project.windowStatus === 'overdue') return 'overdue';
  const months = project.window?.from ? monthsBetween(today, project.window.from) : null;
  if (months === null) return 'far';
  if (months < 12) return 'soon';
  if (months < 36) return 'mid';
  return 'far';
}
