// 청약 등급(로또청약, 고려, 안전마진 없음, 패스, 판정 보류). 외부 호출과 파일 입출력이 없는 순수 함수만 둔다.
// 내부 판정(STATUS, src/lotto.js)에서 파생하는 값이라 알림과 로또 판정은 이 값을 보지 않는다. 기준은 docs/SETUP.md의 9장을 참고한다.
import { STATUS } from './lotto.js';
import { CONFIDENCE, brandTier, restrictedType } from './market-estimate.js';

export const GRADE = {
  LOTTO: '로또청약',
  CONSIDER: '고려',
  NO_MARGIN: '안전마진 없음',
  PASS: '패스',
  HOLD: '판정 보류',
};

// 주간 메일 구역 순서. 패스는 싣지 않는다.
export const WEEKLY_GRADES = [GRADE.LOTTO, GRADE.CONSIDER, GRADE.NO_MARGIN, GRADE.HOLD];

// 등급별 Notion 선택지 색. 새로 만들거나 없는 선택지를 더할 때만 쓴다.
export const GRADE_COLORS = {
  [GRADE.LOTTO]: 'orange',
  [GRADE.CONSIDER]: 'green',
  [GRADE.NO_MARGIN]: 'yellow',
  [GRADE.PASS]: 'red',
  [GRADE.HOLD]: 'gray',
};

// 로그 건수의 이름. 건수만 남긴다.
export const GRADE_COUNT_NAMES = {
  [GRADE.LOTTO]: 'grade_lotto',
  [GRADE.CONSIDER]: 'grade_consider',
  [GRADE.NO_MARGIN]: 'grade_no_margin',
  [GRADE.PASS]: 'grade_pass',
  [GRADE.HOLD]: 'grade_hold',
};

// 기준에 공식 표준은 없다. config.json의 grade가 없거나 숫자가 아니면 이 값을 쓴다.
export const GRADE_DEFAULTS = {
  considerMinRate: -0.03,
  passMaxRate: -0.1,
  considerMinQuality: 2,
  stationMaxMinutes: 10,
  minUnits: 500,
  minTrades: 50,
};

export function gradeSettings(grade) {
  const given = grade !== null && typeof grade === 'object' && !Array.isArray(grade) ? grade : {};
  return Object.fromEntries(Object.entries(GRADE_DEFAULTS).map(([name, fallback]) => [name, Number.isFinite(given[name]) ? given[name] : fallback]));
}

// 저장된 Notion 값(옛 `로또 여부` 값 포함)을 내부 판정으로 읽는다. 알림과 이전 로또 유지가 이 값을 쓴다.
// 로또청약과 옛 값 로또는 로또다. 고려, 안전마진 없음, 패스는 로또가 아닌 아님으로 본다. 모르는 값은 null이다.
const STORED_STATUS = {
  로또청약: STATUS.LOTTO,
  로또: STATUS.LOTTO,
  고려: STATUS.NOT,
  '안전마진 없음': STATUS.NOT,
  패스: STATUS.NOT,
  '판정 보류': STATUS.UNDETERMINED,
  아님: STATUS.NOT,
  '확인 필요': STATUS.CHECK,
  '판별 불가': STATUS.UNDETERMINED,
  '대상 외': STATUS.OUT_OF_SCOPE,
};

export const statusFromStored = (name) => STORED_STATUS[name] ?? null;

// 저장된 값에서 읽는 등급. 옛 값은 알 수 있는 만큼만 옮긴다. 옛 아님은 어느 등급인지 몰라 null이다.
const STORED_GRADE = {
  로또청약: GRADE.LOTTO,
  로또: GRADE.LOTTO,
  고려: GRADE.CONSIDER,
  '안전마진 없음': GRADE.NO_MARGIN,
  패스: GRADE.PASS,
  '판정 보류': GRADE.HOLD,
  '확인 필요': GRADE.HOLD,
  '판별 불가': GRADE.HOLD,
  '대상 외': GRADE.HOLD,
};

export const gradeFromStored = (name) => STORED_GRADE[name] ?? null;

// 내부 판정만 있고 등급을 계산하지 않은 경우의 등급. 아님은 세 등급 중 어느 것인지 몰라 null이다.
const STATUS_GRADE = {
  [STATUS.LOTTO]: GRADE.LOTTO,
  [STATUS.CHECK]: GRADE.HOLD,
  [STATUS.UNDETERMINED]: GRADE.HOLD,
  [STATUS.OUT_OF_SCOPE]: GRADE.HOLD,
};

export const gradeFromStatus = (status) => STATUS_GRADE[status] ?? null;

const isNumber = Number.isFinite;

const ratePercent = (rate) => `${rate >= 0 ? '+' : ''}${(Math.round(rate * 1000) / 10).toFixed(1)}%`;

// 입지: 서울이거나 입력한 역 도보(분)가 기준 이하. 역 도보는 사용자가 Notion에 입력한 값이다.
function locationItem({ notice, walkMinutes }, settings) {
  const label = '입지';
  if (notice.region === '서울') return { label, ok: true, text: '서울' };
  if (!isNumber(walkMinutes)) return { label, ok: false, text: '자료 없음(역 도보 미입력)' };
  return { label, ok: walkMinutes <= settings.stationMaxMinutes, text: `역 도보 ${walkMinutes}분` };
}

// 규모·환금성: 총 세대수와 시세 추정에 쓴 거래 건수가 모두 기준 이상이어야 한다.
function scaleItem({ evaluation, notice }, settings) {
  const label = '규모·환금성';
  const units = isNumber(notice.totalUnits) ? notice.totalUnits : null;
  const trades = isNumber(evaluation.tradeSamples) ? evaluation.tradeSamples : null;
  const unitsOk = units !== null && units >= settings.minUnits;
  const tradesOk = trades !== null && trades >= settings.minTrades;
  const ok = unitsOk && tradesOk;
  const unitsText = units === null ? '세대수 자료 없음' : `세대수 ${units}`;
  const tradesText = trades === null ? '거래 자료 없음' : `거래 ${trades}건`;
  if (ok) return { label, ok, text: `${unitsText}, ${tradesText}` };
  const failed = [unitsOk ? null : unitsText, tradesOk ? null : tradesText].filter(Boolean);
  return { label, ok, text: failed.join(', ') };
}

// 브랜드: 단지명과 시공사로 본 등급이 상위나 중위. 기존 시세 보정과 같은 분류(brandTier)다.
function brandItem({ notice }, config) {
  const label = '브랜드';
  if (!notice.name && !notice.builder) return { label, ok: false, text: '자료 없음' };
  const tier = brandTier({ name: notice.name, builder: notice.builder }, config.market.adjustment.brand);
  return { label, ok: tier === 'top' || tier === 'mid', text: '' };
}

// 품질 점수(0~3). 자료가 없는 항목은 0점이고 근거에 자료 없음으로 적는다.
export function qualityOf(input, config) {
  const settings = gradeSettings(config.grade);
  const items = [locationItem(input, settings), scaleItem(input, settings), brandItem(input, config)];
  return { score: items.filter((item) => item.ok).length, items };
}

const itemText = (item) => `${item.label} ${item.ok ? '✓' : '✗'}${item.text ? ` ${item.text}` : ''}`;

// 증거가 약해 등급을 정하지 않는 까닭. 없으면 null이다. 약한 근거로 패스, 안전마진 없음, 고려를 내지 않는다.
function holdReason({ evaluation, notice }, config) {
  const restricted = restrictedType(notice, config.market);
  if (restricted) return `제한 유형(${restricted})`;
  if (evaluation.status === STATUS.UNDETERMINED) return '판별 불가';
  if (evaluation.status === STATUS.OUT_OF_SCOPE) return '대상 외';
  if (!isNumber(evaluation.margin)) return '시세 추정 없음';
  if (evaluation.confidence !== CONFIDENCE.MID && evaluation.confidence !== CONFIDENCE.HIGH) return `시세 신뢰도 ${evaluation.confidence ?? '없음'}`;
  if (!isNumber(evaluation.marginRate)) return '마진율 없음';
  return null;
}

// 등급을 정한다. 결과는 { grade, detail, line }이다. detail은 근거 요약(주간 메일에 쓴다), line은 판별 근거 끝에 붙일 한 줄이다.
// 품질을 쟀으면 quality도 있다.
// 입력: evaluation(status, margin, marginRate, confidence, tradeSamples), notice(region, totalUnits, builder, name, houseSecd, typeLabel),
// walkMinutes(저장된 역 도보 분), config(grade, market). 로또의 마진 기준은 쓰지 않는다. 로또는 이미 정한 status다.
// 로또청약은 정확히 STATUS.LOTTO다. 안전 마진과 마진율 기준은 판정(src/lotto.js)이 이미 적용했다.
export function gradeNotice({ evaluation, notice, walkMinutes = null, config }) {
  const result = (grade, detail, extra = {}) => ({ grade, detail, line: `등급: ${grade}${detail ? ` (${detail})` : ''}`, ...extra });
  if (evaluation.status === STATUS.LOTTO) return result(GRADE.LOTTO, isNumber(evaluation.marginRate) ? `마진율 ${ratePercent(evaluation.marginRate)}` : '');
  const why = holdReason({ evaluation, notice }, config);
  if (why) return result(GRADE.HOLD, why);

  const settings = gradeSettings(config.grade);
  const quality = qualityOf({ evaluation, notice, walkMinutes }, config);
  const rate = evaluation.marginRate;
  let grade;
  if (rate >= settings.considerMinRate) grade = quality.score >= settings.considerMinQuality ? GRADE.CONSIDER : GRADE.NO_MARGIN;
  else if (rate >= settings.passMaxRate) grade = quality.score === 0 ? GRADE.PASS : GRADE.NO_MARGIN;
  else grade = GRADE.PASS;
  return result(grade, `마진율 ${ratePercent(rate)}, ${quality.items.map(itemText).join(', ')}`, { quality });
}

// Notion 글 한도(2000자) 안에서 판별 근거 끝에 등급 줄을 붙인다. 넘치면 앞의 근거를 줄여 등급 줄이 잘리지 않게 한다.
export function appendGradeLine(reason, line, limit = 2000) {
  if (!reason) return line;
  const room = limit - line.length - 1;
  const head = reason.length > room ? `${reason.slice(0, Math.max(room - 1, 0))}…` : reason;
  return `${head}\n${line}`;
}
