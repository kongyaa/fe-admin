import {
  CONFIDENCE,
  STATION,
  badSharedGainConfig,
  buildSubject,
  cleanTrades,
  effectiveConfidence,
  estimateBestMargin,
  lookupCandidates,
  marginRateOf,
  matchApartment,
  meetsPriceRule,
  restrictedType,
  sharedGainOf,
  triggerMinRateOf,
} from './market-estimate.js';
import { hasLhModels } from './lh-detail-map.js';
import { lhTypeClass } from './lh-scope.js';
import { lhRecommendPending, recommendForProfile, unapplicableReason } from './recommend.js';
import { resolveAddress } from './sgg-codes.js';
import { AppError, completeMonths, safeError } from './util.js';

export const STATUS = {
  LOTTO: '로또',
  NOT: '아님',
  UNDETERMINED: '판별 불가',
  OUT_OF_SCOPE: '대상 외',
  // 조건에는 해당하나 시세 근거가 약해 로또라고 보기 어려운 경우. 긴급 알림은 보내지 않고 주간 메일과 표에서만 알린다.
  CHECK: '확인 필요',
};

const eok = (manwon) => {
  const text = (manwon / 10000).toFixed(1);
  return `${text === '-0.0' ? '0.0' : text}억`;
};

const percent = (ratio) => {
  const value = Math.round((ratio - 1) * 100);
  return `${value >= 0 ? '+' : ''}${value}%`;
};

// 조건형 로또 후보. key는 lotto.triggerPriceCheck의 키다.
function flagTrigger(notice, lotto) {
  const flag = (key, label) => ({ key, label });
  if (notice.kind === 'remainder') {
    if (notice.houseSecd === '04' && lotto.includeRemainder) return flag('remainder', '수도권 무순위·잔여세대');
    if (notice.houseSecd === '06' && lotto.includeResupply) return flag('resupply', '수도권 불법행위 재공급');
  }
  if (notice.kind === 'arbitrary' && lotto.includeArbitrary) return flag('arbitrary', '수도권 임의공급');
  if (notice.kind === 'apt') {
    if (lotto.includePriceCap && notice.flags.priceCap) return flag('priceCap', '분양가상한제 적용');
    if (lotto.includePublicDistrict && notice.flags.publicDistrict) return flag('publicDistrict', '공공주택지구');
  }
  // LH 공공분양은 분양가상한제 대상이다. flags.priceCap은 상세 정보를 덮을 때 분양 유형에만 켠다(src/lh-detail-map.js).
  if (notice.kind === 'lh' && lotto.includePriceCap && notice.flags?.priceCap) return flag('priceCap', 'LH 공공분양(분양가상한제)');
  return null;
}

// 무순위(houseSecd 04) 공고명의 차수. 청약홈 API에는 차수 필드가 없어 공고명(HOUSE_NM)에서만 읽는다.
// "무순위(사후)(14차)", "사후무순위 3차"처럼 무순위·사후·잔여 뒤의 숫자를 먼저 보고, 없으면 이름 끝 괄호의 차수를 본다.
// 청약홈 무순위 공고명은 차수를 이름 끝 괄호에 둔다. 확인한 사례는 둘이다: 공고문 파일명 "단지명(14차) 무순위
// 입주자모집공고문"과, 2차 단지가 없는 단일 단지의 무순위 공고명 "빌리브센트하이(2차)".
// 단지 차수를 "단지(3차)"처럼 괄호로 적은 이름은 차수로 잘못 읽는다. 단지 차수는 보통 괄호 없이 적어 null이다.
export function parseRemainderRound(name) {
  const text = String(name ?? '');
  const match = /(?:무순위|사후|잔여)\D{0,10}?(\d{1,3})\s*차/.exec(text) ?? /\((\d{1,3})\s*차\)\s*$/.exec(text);
  const round = match ? Number(match[1]) : null;
  return round > 0 ? round : null;
}

function stationText(basis) {
  if (basis.stationState === STATION.USED) return `역 도보 ${basis.walkMinutes}분(입력)`;
  if (basis.stationState === STATION.NO_DATA) {
    const why = basis.stationLookupFailed ? '역 정보 조회를 못 해' : '비교 단지 역 정보 부족으로';
    return `역 도보 ${basis.walkMinutes}분(입력), ${why} 역 보정 없음`;
  }
  return '역 도보 미입력, 역 보정 없음';
}

const areaText = (area) => String(Number(area.toFixed(1)));

const ageScope = (maxAge) => (maxAge === null ? '연식 무관' : `${maxAge}년 이내`);

// 판별 근거에는 쓴 비교 단지를 모두 적는다. 단지명은 국토부 공개 자료다. Notion 한도 2000자 안에 든다.
function basisText(basis) {
  if (basis.kind === 'same') {
    return `같은 단지 거래 ${basis.samples}건(분양권 ${basis.presaleSamples}건), 보정 없음`;
  }
  const names = basis.comparables
    .map((item) => `${item.name || '이름 없음'} ${eok(item.reference)}(${item.walkBand ? `${item.walkBand}, ` : ''}브랜드 ${percent(item.brandRatio)}, 연식 ${percent(item.ageRatio)})`)
    .join(', ');
  const outliers = basis.outliers > 0 ? `, 이상치 ${basis.outliers}곳 제외` : '';
  const scope = basis.townWide ? '시군구, 같은 읍·면 단지를 찾지 못해 신뢰도 하' : basis.scope;
  return `${stationText(basis)}; 비교 단지 ${basis.comparables.length}곳 표본 ${basis.samples}건(${scope}, ${ageScope(basis.maxAge)}${outliers}), 보정 후 ${areaText(basis.area)}㎡ 기준: ${names}`;
}

function safeText(best) {
  if (best.basis.kind === 'same') return `하위 25% 시세 ${eok(best.safeValue)}`;
  const percentText = `${Math.round(best.discount * 100)}%`;
  if (!best.discountMeasured) return `보수 시세 ${eok(best.safeValue)}(비교 단지가 적어 오차를 재지 못해 차감 없음)`;
  if (best.discountExceeded) return `보수 시세 ${eok(best.safeValue)}(검증 오차가 상한 ${percentText}를 넘어 ${percentText}만 차감, 실제 위험은 더 큼)`;
  return `보수 시세 ${eok(best.safeValue)}(추정 시세에서 검증 오차 ${percentText} 차감)`;
}

// 카카오톡용 짧은 근거. 메시지 200자 안에 들도록 마진과 신뢰도만 적는다.
const rateText = (rate) => (Number.isFinite(rate) ? `${Math.round(rate * 100)}%(분양가 대비)` : '없음');
const shortPriceText = (best) => `안전 마진 ${eok(best.margin)}, 마진율 ${rateText(best.marginRate)} (${best.houseType}, 신뢰도 ${best.confidence})`;

const priceText = (best) => `${shortPriceText(best)}; `
  + `${basisText(best.basis)}; ${safeText(best)}에서 분양가 ${eok(best.price)}, 옵션 ${best.optionCost}만 원, 취득세 ${best.tax}만 원 차감`;

// 주택형별 최고 분양가를 공급 세대수로 가중 평균한다(만원). 0세대인 주택형은 가중치 0이다.
// 세대수를 모르는 주택형이 하나라도 있거나 세대수 합이 0이면 단순 평균이다.
export function averagePriceOf(models) {
  const priced = (models ?? []).filter((model) => model.price > 0);
  if (priced.length === 0) return null;
  const known = priced.every((model) => Number.isFinite(model.households) && model.households >= 0);
  const households = known ? priced.reduce((sum, model) => sum + model.households, 0) : 0;
  const weightOf = (model) => (households > 0 ? model.households : 1);
  const total = priced.reduce((sum, model) => sum + weightOf(model), 0);
  return Math.round(priced.reduce((sum, model) => sum + model.price * weightOf(model), 0) / total);
}

const topPriceOf = (models) => {
  const prices = models.map((m) => m.price).filter((p) => p > 0);
  return prices.length > 0 ? Math.max(...prices) : null;
};

// 지번은 가장 작은 지역 단위(리가 있으면 리, 없으면 동·읍·면) 바로 뒤의 숫자다.
function subjectJibun(address, umd, village) {
  const place = village ?? umd;
  if (!place) return null;
  const tokens = String(address ?? '').replace(/[(),]/g, ' ').trim().split(/\s+/);
  const next = tokens[tokens.indexOf(place) + 1] ?? '';
  return /^\d+(-\d+)?$/.test(next) ? next : null;
}

// 공고 단지 입력이 있을 때만 비교 단지의 역 정보를 조회한다. 조회 실패는 클라이언트가 한 번만 로그에 남긴다.
// 코드 오류는 조회 실패로 숨기지 않고 호출한 쪽의 오류 처리로 올린다.
async function resolveStations({ aptInfo, code, subject, models, rows, lotto, market, today, onSoft }) {
  const stations = new Map();
  if (!aptInfo || !Number.isFinite(subject.walkMinutes)) return { stations, failed: false };
  const candidates = lookupCandidates({ models, rows, subject, lotto, market, today });
  if (candidates.length === 0) return { stations, failed: false };
  try {
    const directory = await aptInfo.getDirectory(code);
    for (const complex of candidates) {
      const apartment = matchApartment(complex, directory, market);
      if (!apartment) {
        onSoft('apt_name_unmatched');
        continue;
      }
      const station = await aptInfo.getStation(apartment.code);
      if (station) stations.set(complex.key, station);
    }
    return { stations, failed: false };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { stations: new Map(), failed: true };
  }
}

async function readPresale(getPresale, code, months) {
  if (!getPresale) return { rows: [], ok: true };
  try {
    return await getPresale(code, months);
  } catch {
    return { rows: [], ok: false };
  }
}

// getModels/getTrades 실패는 판정을 막지 않고 onError로 모은다. getPresale과 aptInfo는 실패해도 신뢰도만 낮춘다.
// 판정에 추천 전형을 붙인다. 프로필이 없으면 recommendation 필드를 두지 않아 Notion의 추천 열을 건드리지 않는다.
// 추천 문구는 저장되는 판별 근거에만 붙이고, 카카오톡의 짧은 근거에는 넣지 않는다. 프로필 내용은 어디에도 적지 않는다.
// 프로필이 있으면 신청할 수 없는 공고인지(unapplicable: null, 'region', 'ended')도 붙인다. 주택형 조회가 실패하면 자료를 모르는 것으로 본다.
export async function evaluateLotto(notice, options) {
  let models = null;
  let modelsFailed = false;
  // LH 주택형은 조회하지 않고 상세 정보를 덮을 때 읽어 둔 값(notice.models)을 쓴다. 없으면 null이다.
  const source = notice.kind === 'lh' ? async () => notice.models ?? null : options.getModels;
  const getModels = async (target) => {
    try {
      models = await source(target);
    } catch (error) {
      modelsFailed = true;
      throw error;
    }
    if (!models) modelsFailed = true;
    return models;
  };
  const priced = await evaluatePrice(notice, { ...options, getModels });
  if (!options.profile) return priced;
  const unapplicable = unapplicableReason({ notice, models: modelsFailed ? null : models, profile: options.profile, config: options.config, today: options.today });
  // 추천 문구(v2 이름표 포함)는 판별 근거에만 붙인다. 카카오톡·긴급 알림의 짧은 근거는 붙이기 전 값으로 고정한다.
  const evaluation = { ...priced, unapplicable, shortReason: priced.shortReason ?? priced.reason };
  // APT 주택형 조회가 실패하면 특별공급 세대를 몰라 저장된 추천을 그대로 둔다. 실행마다 추천이 바뀌지 않게 한다.
  if (notice.kind === 'apt' && modelsFailed) {
    const kept = '(추천: 조회 실패로 이전 값 유지)';
    return { ...evaluation, reason: evaluation.reason ? `${evaluation.reason}\n${kept}` : kept };
  }
  // LH 상세·공급 조회가 실패했거나 상한에 걸리면 단계를 몰라 저장된 추천을 그대로 둔다. 실행마다 추천이 바뀌지 않게 한다.
  if (lhRecommendPending(notice, options.config)) {
    const kept = '(추천: 조회 실패로 이전 값 유지)';
    return { ...evaluation, reason: evaluation.reason ? `${evaluation.reason}\n${kept}` : kept };
  }
  // 추천이 없어도 v2 신청자 정보의 예치금 부족처럼 남길 말이 있으면 판별 근거에 붙인다.
  const { recommendation, text } = recommendForProfile({ notice, models, profile: options.profile, config: options.config, today: options.today });
  if (!text) return { ...evaluation, recommendation };
  return { ...evaluation, recommendation, reason: evaluation.reason ? `${evaluation.reason}\n${text}` : text };
}

// LH 상세·공급 조회 상태별 판별 불가 사유.
const LH_PENDING_REASONS = {
  failed: 'LH 상세 조회 실패',
  capped: 'LH 상세 조회 한도 초과',
  supply_failed: 'LH 공급 정보 조회 실패',
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// lotto.triggerPriceCheck가 일반 객체가 아니면 없는 것(예전 동작)으로 보고, true인 조건만 가격을 확인한다.
const priceCheckOn = (lotto, key) => isPlainObject(lotto.triggerPriceCheck) && lotto.triggerPriceCheck[key] === true;

// remainderMaxRound가 양의 정수일 때만 반복 공급 규칙을 쓴다. null이면 끈다.
const maxRoundOf = (lotto) => (Number.isInteger(lotto.remainderMaxRound) && lotto.remainderMaxRound > 0 ? lotto.remainderMaxRound : null);

// lowConfidenceMinMarginRate가 0 이하의 유한한 수일 때만 신뢰도 하 음수 마진 규칙을 쓴다. 없거나 null이면 끈다.
const lowMinRateOf = (lotto) => {
  const rate = lotto.lowConfidenceMinMarginRate;
  return typeof rate === 'number' && Number.isFinite(rate) && rate <= 0 ? rate : null;
};

// 판별 근거용 비율 표기. -0.05 → "-5%", -0.025 → "-2.5%".
const ratePercent = (rate) => `${Math.round(rate * 1000) / 10}%`;

// 기준 미만임을 보이는 비율 표기. 소수 첫째 자리까지 내림해 2.96%가 "3% < 3%"로 찍히지 않게 한다.
const floorPercent = (rate) => `${Math.floor(rate * 1000 + 1e-9) / 10}%`;

// 있는데 형식이 틀린 조건형 설정. 예전 동작으로 돌아가므로 로그의 soft=bad_trigger_config로 알린다.
export function badTriggerConfig(lotto) {
  const checks = lotto.triggerPriceCheck;
  const maxRound = lotto.remainderMaxRound;
  const lowMinRate = lotto.lowConfidenceMinMarginRate;
  const triggerMinRate = lotto.triggerMinMarginRate;
  return (checks !== undefined && !isPlainObject(checks))
    || (maxRound !== undefined && maxRound !== null && maxRoundOf(lotto) === null)
    || (lowMinRate !== undefined && lowMinRate !== null && lowMinRateOf(lotto) === null)
    || (triggerMinRate !== undefined && triggerMinRate !== null && triggerMinRateOf(lotto) === null);
}

// 비교 범위를 넓혀 쓴 추정이면 판별 근거에 덧붙일 말. 읍·면 주소가 같은 읍·면 단지를 못 찾아 시군구로 넓힌 경우가 가장 위험하다.
// 더 좁은 범위를 실제로 볼 수 있었을 때만 적는다(basis.widened).
function scopeNote(basis) {
  if (basis.kind !== 'comparables' || !basis.widened) return null;
  return basis.townWide ? '비교 범위 확대(같은 읍·면 단지 없어 시군구)' : `비교 범위 확대(${basis.scope})`;
}

// 조건형 로또 후보의 최종 판정. lotto.triggerPriceCheck에서 켠 조건만 시세를 본다.
// 시세 근거가 로또라고 말하기에 약하면 아님이 아니라 확인 필요다(STATUS.CHECK). 긴급 알림은 보내지 않는다.
// 1) 신뢰도 중 이상 추정: 마진이 음수면 아님. 마진율이 triggerMinMarginRate(3%) 미만이면 추정 오차 안이라 확인 필요, 이상이면 로또다.
// 2) 신뢰도 하 추정: 마진율이 lowConfidenceMinMarginRate(-5%) 이하로 뚜렷한 음수면 아님(lowConfidenceNegative).
//    마진이 양수면 가격 기준과 상관없이 확인 필요다. 신뢰도 하 추정은 비교 범위가 넓어 과대 추정일 수 있어
//    양수 마진만으로 로또라 하면 안 된다. 마진율이 -5%와 0 사이면 놓치지 않게 로또로 둔다.
// 3) 추정이 없으면 놓치지 않게 로또로 둔다.
// 4) 무순위가 remainderMaxRound차 이상이면 확인 필요가 될 공고도, 추정이 없거나 약한 공고도 아님이다(repeatedRound).
//    신뢰도 중 이상에서 마진율이 기준을 넘는 로또만 차수와 상관없이 로또로 둔다.
// 신뢰도는 분양권·역 정보 조회 실패로만 내려갔으면 내려가기 전 값으로 본다(effectiveConfidence). 조회 한 번 실패로
// 중 신뢰도의 로또가 확인 필요가 되어 알림이 사라지지 않게 한다. 표시하는 신뢰도는 하 그대로다.
function decideTrigger(trigger, { notice, best, undetermined, lotto }) {
  const { key, label } = trigger;
  const candidate = {
    status: STATUS.LOTTO,
    reason: best ? `${label}; ${priceText(best)}` : label,
    shortReason: best ? `${label}; ${shortPriceText(best)}` : label,
  };
  if (!priceCheckOn(lotto, key)) return candidate;
  const round = key === 'remainder' ? parseRemainderRound(notice.name) : null;
  const maxRound = maxRoundOf(lotto);
  const repeated = round !== null && maxRound !== null && round >= maxRound;
  const repeatedResult = () => {
    const head = `${label} ${round}차 반복 공급`;
    return {
      status: STATUS.NOT,
      reason: `${head}; ${best ? priceText(best) : `시세 추정 없음(${undetermined})`}`,
      shortReason: `${head}; ${best ? shortPriceText(best) : '시세 추정 없음'}`,
      repeatedRound: round,
    };
  };
  // 반복 공급이면 확인 필요 대신 아님이다. 같은 공고가 계속 나오는 무순위를 근거가 약한 채로 알리지 않는다.
  // checkNote는 주간 메일의 확인 필요 항목에 쓰는 짧은 사유다. 마진과 신뢰도는 메일에서 따로 적는다.
  const checkResult = (head, note) => (repeated ? repeatedResult() : {
    status: STATUS.CHECK,
    reason: `${head}; ${priceText(best)}`,
    shortReason: `${head}; ${shortPriceText(best)}`,
    checkNote: note,
  });
  const level = best ? effectiveConfidence(best) : null;
  // 조회 실패로 낮아진 신뢰도를 되돌려 판정했으면 판별 근거 끝에 밝힌다.
  const lookupNote = best && level !== best.confidence ? `; 분양권·역 정보 조회 실패로 신뢰도를 ${best.confidence}로 낮췄으나 ${level} 기준으로 판정` : '';
  if (best && level !== CONFIDENCE.LOW) {
    if (best.margin < 0) {
      return {
        status: STATUS.NOT,
        reason: `${label} 해당이나 시세 대비 이점 없음; ${priceText(best)}${lookupNote}`,
        shortReason: `${label} 해당이나 시세 이점 없음; ${shortPriceText(best)}`,
      };
    }
    const minRate = triggerMinRateOf(lotto);
    if (minRate !== null && Number.isFinite(best.marginRate) && best.marginRate < minRate) {
      const result = checkResult(
        `${label} 해당이나 마진이 근소함(마진율 ${floorPercent(best.marginRate)} < ${ratePercent(minRate)})`,
        `${label} 해당이나 마진이 근소함(최소 ${ratePercent(minRate)} 미만)`,
      );
      return result.status === STATUS.CHECK ? { ...result, reason: `${result.reason}${lookupNote}` } : result;
    }
    return lookupNote ? { ...candidate, reason: `${candidate.reason}${lookupNote}` } : candidate;
  }
  if (best) {
    const lowMinRate = lowMinRateOf(lotto);
    if (lowMinRate !== null && Number.isFinite(best.marginRate) && best.marginRate <= lowMinRate) {
      const head = `${label} 해당이나 시세 대비 이점 없음(신뢰도 하, 마진율 ≤ ${ratePercent(lowMinRate)})`;
      const shortHead = `${label} 해당이나 시세 이점 없음(신뢰도 하, 마진율 ≤ ${ratePercent(lowMinRate)})`;
      return {
        status: STATUS.NOT,
        reason: `${head}; ${priceText(best)}`,
        shortReason: `${shortHead}; ${shortPriceText(best)}`,
        lowConfidenceNegative: true,
      };
    }
    if (best.margin > 0) {
      const scope = scopeNote(best.basis);
      return checkResult(
        `${label} 해당이나 시세 근거가 약함(신뢰도 하${scope ? `, ${scope}` : ''})`,
        `${label} 해당이나 시세 근거가 약함${scope ? `(${scope})` : ''}`,
      );
    }
  }
  if (repeated) return repeatedResult();
  return candidate;
}

// 주택형과 실거래로 공고의 가장 나은 주택형 추정을 구한다. 결과는 { best, undetermined, failed, unmapped }다.
// 추정이 없으면 best가 null이고 undetermined에 까닭이 있다. failed는 실거래 조회가 실패해 이번에는 모르는 경우,
// unmapped는 단지 주소의 시군구 코드를 찾지 못한 경우다.
async function estimateNotice(notice, models, { config, today, getTrades, getPresale, aptInfo, walkMinutes, preferConfident, onError, onSoft }) {
  const { lotto, market } = config;
  const { code, umd, village } = resolveAddress(notice.address, notice.region);
  if (!code) return { best: null, undetermined: '시군구 코드 미매핑', unmapped: true };
  try {
    const months = completeMonths(today, lotto.tradeMonths);
    const trades = await getTrades(code, months);
    const presale = await readPresale(getPresale, code, months);
    const rows = cleanTrades([...trades, ...presale.rows], { market, lotto, today });
    const subject = buildSubject({
      name: notice.name,
      builder: notice.builder,
      umd,
      village,
      jibun: subjectJibun(notice.address, umd, village),
      walkMinutes,
      market,
    });
    const lookup = await resolveStations({ aptInfo, code, subject, models, rows, lotto, market, today, onSoft });
    const best = estimateBestMargin({
      models,
      rows,
      subject,
      stations: lookup.stations,
      stationLookupFailed: lookup.failed,
      presaleOk: presale.ok,
      preferConfident,
      lotto,
      market,
      today,
    });
    return { best, undetermined: best ? null : '실거래 표본 부족' };
  } catch (error) {
    onError(safeError(error));
    return { best: null, undetermined: '실거래 조회 실패', failed: true };
  }
}

// 추정을 Notion 열 값으로 옮긴다.
const priceFields = (best) => ({
  topPrice: best.price,
  estimate: best.estimate,
  margin: best.margin,
  marginRate: best.marginRate,
  confidence: best.confidence,
  // 건수만 센다. 같은 단지 거래로 계산하면 역 보정이 필요 없어 비어 있다.
  stationState: best.basis.stationState ?? null,
  complexOutliers: best.outliers ?? 0,
});

// 참고 마진의 판별 근거 머리말. 신혼희망타운은 수익공유형 대출을 받을 때 차익을 나누므로 대출 조건 확인을 적는다.
const sharedGainHead = ({ type, factor }) => (type === '신혼희망'
  ? '참고 마진(신혼희망타운: 수익공유형 대출 조건 확인)'
  : `참고 마진(차익 공유 유형, 내 몫 ×${factor})`);

// 차익을 나누는 제한 유형(나눔형, 신혼희망타운)의 참고 마진. 로또 판별은 하지 않아 상태는 늘 대상 외이고 알림 대상이 아니다.
// 보통 공고처럼 추정한 뒤 안전 마진이 양수일 때만 내 몫(market.sharedGain 계수)을 곱한다. 음수 마진은 그대로 둔다.
// 마진율은 바꾼 마진을 최고 분양가로 나눈 값이다. 추정 시세, 시세 신뢰도, 분양가는 보통 공고와 같다.
// 자료가 없으면(주택형, 단지 주소, 실거래 표본) 예전처럼 저장된 추정 값을 지우고(clearMarket) 까닭을 적는다.
// 조회가 실패하면(LH 상세 조회 실패·상한, 주택형·실거래 조회 실패) 이번에는 모르는 것이라 저장된 값을 지우지 않는다.
async function evaluateSharedGain(notice, shared, { config, today, getModels, getTrades, getPresale, aptInfo, walkMinutes, onError, onSoft, onSoftOnce }) {
  const none = (why, { clear = true, averagePrice = null } = {}) => ({
    status: STATUS.OUT_OF_SCOPE,
    reason: `제한 유형(${shared.type})은 로또 판별 대상이 아님; 참고 마진 없음(${why})`,
    topPrice: null,
    estimate: null,
    margin: null,
    marginRate: null,
    confidence: null,
    averagePrice,
    ...(clear ? { clearMarket: true } : {}),
  });
  if (notice.kind === 'lh') {
    // LH는 분양 유형(공공분양)만 시세를 본다. 보통 LH 판별과 같다(flags.priceCap은 분양 유형에만 켠다).
    if (!notice.flags?.priceCap && lhTypeClass(notice, config.lh ?? {}) !== 'sale') return none('판별 대상 유형이 아님');
    const pending = LH_PENDING_REASONS[notice.lhDetailState];
    if (pending) return none(pending, { clear: false });
    if (!hasLhModels(notice.models)) {
      if (notice.lhDetailState !== 'ok') return none('LH 상세 정보 없음');
      return none(notice.lhModelsUnattached ? 'LH 단지 주소 미매핑' : 'LH 공급 정보 없음');
    }
  }
  let models = null;
  try {
    models = await getModels(notice);
  } catch {
    // 예전 제한 유형처럼 오류 메일 없이 실행당 한 번만 건수로 남긴다.
    onSoftOnce('average_price_lookup_failed');
  }
  if (!models) return none('주택형 정보 조회 실패', { clear: false });
  const averagePrice = averagePriceOf(models);
  if (!models.some((model) => model.area > 0 && model.price > 0)) return none('주택형 정보 없음', { averagePrice });
  const { best, undetermined, failed, unmapped } = await estimateNotice(notice, models, { config, today, getTrades, getPresale, aptInfo, walkMinutes, preferConfident: false, onError, onSoft });
  if (!best) {
    const why = unmapped && notice.kind === 'lh' ? 'LH 단지 주소 미매핑' : undetermined;
    return none(why, { clear: !failed, averagePrice });
  }
  const margin = best.margin > 0 ? Math.round(best.margin * shared.factor) : best.margin;
  const marginRate = marginRateOf(margin, best.price);
  // 마진을 바꿨으면 머리말에 바꾼 마진과 마진율을 적고, 뒤의 보통 근거는 바꾸기 전 값이라 (조정 전)을 붙인다.
  const adjusted = margin !== best.margin;
  const head = adjusted ? `${sharedGainHead(shared)} ${eok(margin)}, 마진율 ${Number.isFinite(marginRate) ? `${Math.round(marginRate * 100)}%` : '없음'}` : sharedGainHead(shared);
  return {
    status: STATUS.OUT_OF_SCOPE,
    reason: `${head}; ${adjusted ? '(조정 전) ' : ''}${priceText(best)}`,
    ...priceFields(best),
    margin,
    marginRate,
    averagePrice,
    referenceMargin: true,
  };
}

async function evaluatePrice(notice, { config, today, getModels, getTrades, getPresale, aptInfo, walkMinutes = null, onError = () => {}, onSoft = () => {}, onSoftOnce = onSoft }) {
  const { lotto, market } = config;
  const result = (status, reason, extra = {}) => ({
    status, reason, topPrice: null, estimate: null, margin: null, marginRate: null, confidence: null, ...extra,
  });

  if (!config.alertRegions.includes(notice.region)) {
    return result(STATUS.OUT_OF_SCOPE, '알림 지역이 아님');
  }
  // 판정 조건보다 먼저 본다. 저장된 추정 값이 남지 않도록 clearMarket으로 지우게 한다.
  const restricted = restrictedType(notice, market);
  if (badSharedGainConfig(market)) onSoftOnce('bad_shared_gain_config');
  // 차익을 나누는 제한 유형(나눔형, 신혼희망타운)은 대상 외로 두되 참고 마진을 적는다. 토지임대부, 지분적립형은 아래처럼 비운다.
  const shared = restricted ? sharedGainOf(notice, market) : null;
  if (shared) return evaluateSharedGain(notice, shared, { config, today, getModels, getTrades, getPresale, aptInfo, walkMinutes, onError, onSoft, onSoftOnce });
  if (restricted) {
    // 평균 분양가는 공고의 사실이라 제한 유형에도 적는다. 실거래는 조회하지 않는다.
    // 표시용 값이라 실패해도 오류 메일 없이 실행당 한 번만 건수로 남긴다.
    let restrictedModels = null;
    try {
      restrictedModels = await getModels(notice);
    } catch {
      onSoftOnce('average_price_lookup_failed');
    }
    return result(STATUS.OUT_OF_SCOPE, `제한 유형(${restricted})은 로또 판별과 안전 마진 대상이 아님`, {
      clearMarket: true,
      averagePrice: averagePriceOf(restrictedModels),
    });
  }

  // LH 공고는 상세·공급 정보로 주택형과 단지 주소를 읽었을 때만 판별한다(조회 상태는 src/lh-detail-map.js의 lhDetailState).
  // 조회가 실패했거나 상한에 걸리면 이번에는 모르는 것이라 판별 불가로 두어 저장된 로또를 유지한다(keepPreviousLotto).
  // 자료가 없거나(요청 코드 없음, 쓸 수 있는 주택형 없음) 단지 주소를 찾지 못하면 예전처럼 대상 외다.
  if (notice.kind === 'lh') {
    const status = notice.noticeStatus ? ` (${notice.noticeStatus})` : '';
    const pending = LH_PENDING_REASONS[notice.lhDetailState];
    if (pending) return result(STATUS.UNDETERMINED, `${pending}${status}`);
    if (!hasLhModels(notice.models)) {
      if (notice.lhDetailState !== 'ok') return result(STATUS.OUT_OF_SCOPE, `LH 상세 정보 없음${status}`);
      return result(STATUS.OUT_OF_SCOPE, `${notice.lhModelsUnattached ? 'LH 단지 주소 미매핑' : 'LH 공급 정보 없음'}${status}`);
    }
    if (!resolveAddress(notice.address, notice.region).code) return result(STATUS.OUT_OF_SCOPE, `LH 단지 주소 미매핑${status}`);
  }

  const trigger = flagTrigger(notice, lotto);
  const usesPrice = notice.kind === 'apt' || Boolean(trigger);
  if (badTriggerConfig(lotto)) onSoftOnce('bad_trigger_config');

  if (!usesPrice) {
    const label = notice.kind === 'remainder' || notice.kind === 'arbitrary' ? '설정에서 제외된 유형' : '판별 대상 유형이 아님';
    return result(STATUS.OUT_OF_SCOPE, label);
  }

  let models = null;
  try {
    models = await getModels(notice);
  } catch (error) {
    onError(safeError(error));
  }
  const topPrice = models ? topPriceOf(models) : null;
  const averagePrice = averagePriceOf(models);

  let best = null;
  let undetermined = models ? null : '주택형 정보 조회 실패';
  if (models) {
    // 가격을 확인하는 조건형 후보만 신뢰도 중 이상 주택형을 먼저 본다. 조건 없는 공고는 예전 순서다.
    const preferConfident = Boolean(trigger) && priceCheckOn(lotto, trigger.key);
    ({ best, undetermined } = await estimateNotice(notice, models, { config, today, getTrades, getPresale, aptInfo, walkMinutes, preferConfident, onError, onSoft }));
  }

  const price = best ? priceFields(best) : { topPrice };
  price.averagePrice = averagePrice;

  // LH는 비교 단지가 없는 신도시 블록이 많아, 추정이 없으면 다른 분양가상한제 공고와 달리 로또로 두지 않고 판별 불가다.
  // 신뢰도 하 추정은 다른 조건형 공고와 같다.
  if (notice.kind === 'lh' && !best) return result(STATUS.UNDETERMINED, `LH 공공분양; 시세 추정 없음(${undetermined})`, price);
  if (trigger) {
    const { status, reason, ...extra } = decideTrigger(trigger, { notice, best, undetermined, lotto });
    return result(status, reason, { ...price, ...extra });
  }
  if (!best) return result(STATUS.UNDETERMINED, undetermined, price);
  // 가격 기준만으로 로또가 되려면 신뢰도가 중 이상이어야 한다. 조건형 로또 후보는 위에서 이미 정해졌다.
  if (meetsPriceRule(best, lotto) && best.confidence === CONFIDENCE.LOW) {
    const note = '가격 기준은 넘지만 추정 신뢰도가 하라 로또로 보지 않음';
    return result(STATUS.NOT, `${note}; ${priceText(best)}`, { ...price, shortReason: `${note}; ${shortPriceText(best)}` });
  }
  return result(meetsPriceRule(best, lotto) ? STATUS.LOTTO : STATUS.NOT, priceText(best), { ...price, shortReason: shortPriceText(best) });
}

// 이번 판정이 불가이거나, 신뢰도 하인 추정이 가격 기준만으로 로또를 빼려 하면 이전 로또를 유지한다.
// 약한 추정 하나로 알림이 조용히 사라지지 않게 하려는 것이다.
// 신뢰도 중 이상 추정으로 아님이 된 조건형 공고는 그대로 뺀다. 무순위 반복 공급으로 아님이 된 공고도
// 추정이 아니라 차수로 정한 것이라 유지하지 않는다(추정이 없을 때와 똑같이 뺀다). 확인 필요가 될 반복 공급도 같다.
// 조건형 공고가 신뢰도 하 추정의 뚜렷한 음수 마진율(lowConfidenceNegative)로 아님이 된 것도 사용자 결정으로
// 유지하지 않고 뺀다.
// 확인 필요(STATUS.CHECK)도 시세로 정한 판정이라 유지하지 않는다. 유지하면 근거가 약한 로또가 계속 알림으로 나간다.
export function keepPreviousLotto(evaluation, previousStatus) {
  if (previousStatus !== STATUS.LOTTO) return evaluation;
  const weak = evaluation.status === STATUS.NOT && evaluation.confidence === CONFIDENCE.LOW
    && !evaluation.repeatedRound && !evaluation.lowConfidenceNegative;
  if (evaluation.status !== STATUS.UNDETERMINED && !weak) return evaluation;
  const label = weak ? '이전 판별 유지(이번 추정 신뢰도 하)' : '이전 판별 유지';
  return {
    ...evaluation,
    status: STATUS.LOTTO,
    reason: `${label} (이번 실행: ${evaluation.reason})`,
    shortReason: `${label} (이번 실행: ${evaluation.shortReason ?? evaluation.reason})`,
  };
}
