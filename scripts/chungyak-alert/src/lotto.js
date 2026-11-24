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
  qualifiesAsLotto,
  readPresaleByCodes,
  readTradesFor,
  restrictedType,
  sharedGainOf,
  validMarginConfig,
} from './market-estimate.js';
import { hasLhModels } from './lh-detail-map.js';
import { lhTypeClass } from './lh-scope.js';
import { priceFactsOf, topPriceOf } from './price-facts.js';
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
  const wards = basis.crossWard ? '; 구 없는 주소라 어느 구에서도 공고 법정동 거래를 찾지 못해 모든 구를 합쳐 신뢰도 한 단계 낮춤' : '';
  return `${stationText(basis)}; 비교 단지 ${basis.comparables.length}곳 표본 ${basis.samples}건(${scope}, ${ageScope(basis.maxAge)}${outliers}), 보정 후 ${areaText(basis.area)}㎡ 기준${wards}: ${names}`;
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

// 평균·최저 분양가와 주택형별 문구. 공고가 주는 사실이라 판정과 무관하게 적는다(src/price-facts.js).
const priceFacts = (models) => priceFactsOf(models, averagePriceOf);

// 판정하지 않는 공고(대상 외 경로와 조기 반환)의 분양가 사실. 최고 분양가는 모든 주택형의 최고 분양가 중 가장 큰 값이다.
// 마진, 추정 시세, 시세 신뢰도, 판단 주택형은 두지 않는다.
const factFields = (models) => ({ topPrice: topPriceOf(models), ...priceFacts(models) });

// 판정과 무관한 분양가 조회. LH는 상세 정보를 덮을 때 읽어 둔 주택형을 쓰고 새로 부르지 않는다.
// 청약홈은 options.getFactModels(실행당 조회 한도가 있다, src/price-facts.js)로 부른다. 없으면 부르지 않는다.
// 표시용 값이라 실패해도 오류 메일 없이 실행당 한 번만 건수로 남기고 비워 둔다.
async function lookupFactModels(notice, { getFactModels, onSoftOnce }) {
  if (notice.kind === 'lh') return notice.models ?? null;
  if (!getFactModels) return null;
  try {
    return await getFactModels(notice);
  } catch {
    onSoftOnce('price_facts_lookup_failed');
    return null;
  }
}

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
async function resolveStations({ aptInfo, codes, subject, models, rows, lotto, market, today, onSoft }) {
  const stations = new Map();
  if (!aptInfo || !Number.isFinite(subject.walkMinutes)) return { stations, failed: false };
  const candidates = lookupCandidates({ models, rows, subject, lotto, market, today });
  if (candidates.length === 0) return { stations, failed: false };
  try {
    // 구가 없는 주소의 시는 구 코드마다 단지 목록을 받아 합친다.
    const directory = [];
    for (const code of codes) directory.push(...(await aptInfo.getDirectory(code)));
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
  // 분양가 사실 조회는 신청할 수 없어 저장하지 않을 공고에는 하지 않는다(관심 체크 행은 예외). 이 경로에서는 판정용 주택형을 읽지 않았으므로
  // 주택형을 모르는 것으로 본 판단과 아래의 unapplicable이 같다.
  const getFactModels = options.getFactModels && options.profile
    ? async (target) => {
      const dropped = unapplicableReason({ notice: target, models: null, profile: options.profile, config: options.config, today: options.today });
      return dropped && !options.interest ? null : options.getFactModels(target);
    }
    : options.getFactModels;
  const priced = await evaluatePrice(notice, { ...options, getModels, getFactModels });
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
  // trackUnknown은 추천이 없는 까닭이 확인된 것이 아니라 단계 자료가 없어서일 때다(src/recommend.js). 긴급 알림을 막지 않는 데 쓴다.
  const { recommendation, text, trackUnknown } = recommendForProfile({ notice, models, profile: options.profile, config: options.config, today: options.today });
  if (!text) return { ...evaluation, recommendation, ...(trackUnknown ? { trackUnknown } : {}) };
  return { ...evaluation, recommendation, ...(trackUnknown ? { trackUnknown } : {}), reason: evaluation.reason ? `${evaluation.reason}\n${text}` : text };
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

// 판별 근거용 비율 표기. 0.1 → "10%", -0.025 → "-2.5%".
const ratePercent = (rate) => `${Math.round(rate * 1000) / 10}%`;

// 기준 미만임을 보이는 비율 표기. 소수 첫째 자리까지 내림해 9.96%가 "10% < 10%"로 찍히지 않게 한다.
const floorPercent = (rate) => `${Math.floor(rate * 1000 + 1e-9) / 10}%`;

// 있는데 형식이 틀린 조건형 설정. 예전 동작으로 돌아가므로 로그의 soft=bad_trigger_config로 알린다.
export function badTriggerConfig(lotto) {
  const checks = lotto.triggerPriceCheck;
  const maxRound = lotto.remainderMaxRound;
  return (checks !== undefined && !isPlainObject(checks))
    || (maxRound !== undefined && maxRound !== null && maxRoundOf(lotto) === null);
}

// 로또 마진 기준(lotto.minMarginManwon 0 이상, lotto.minMarginRate 0 이상 1 미만)이 틀리면 어떤 공고도 로또가 될 수 없다. 로그의 soft=bad_margin_config로 알린다.
// 10%를 10으로 적은 것처럼 단위가 틀린 값도 여기에 걸린다.
export const badMarginConfig = (lotto) => !validMarginConfig(lotto);

// 비교 범위를 넓혀 쓴 추정이면 판별 근거에 덧붙일 말. 읍·면 주소가 같은 읍·면 단지를 못 찾아 시군구로 넓힌 경우가 가장 위험하다.
// 더 좁은 범위를 실제로 볼 수 있었을 때만 적는다(basis.widened).
// 구 없는 주소를 구 전체 거래로 쟀으면(basis.crossWard) 그 말도 적는다.
function scopeNote(basis) {
  if (basis.kind !== 'comparables') return null;
  const notes = [];
  if (basis.widened) notes.push(basis.townWide ? '비교 범위 확대(같은 읍·면 단지 없어 시군구)' : `비교 범위 확대(${basis.scope})`);
  if (basis.crossWard) notes.push('구 없는 주소라 구 전체 합산');
  return notes.length > 0 ? notes.join(', ') : null;
}

// 시세 추정의 등급. 마진이 0 이하면 아님, 로또 조건(신뢰도 중 이상, 안전 마진, 마진율)을 모두 넘으면 로또,
// 마진은 양수인데 하나라도 못 넘으면 확인 필요다.
const gradeOf = (best, lotto) => {
  if (!(best.margin > 0)) return 'not';
  return qualifiesAsLotto(best, lotto) ? 'lotto' : 'check';
};

// 로또 조건 중 넘지 못한 마진 기준. 근거에는 실제 값을, 주간 메일용 사유에는 기준만 적는다. 마진율을 모르면 마진율 기준도 못 넘은 것이다.
function missedMargins(best, lotto) {
  // 기준 설정이 틀렸으면 값을 찍지 않는다(NaN이 근거에 나오지 않게).
  if (!validMarginConfig(lotto)) return [{ actual: '로또 기준 설정 오류', bound: '로또 기준 설정 오류' }];
  const missed = [];
  if (!(best.margin >= lotto.minMarginManwon)) {
    // 실제 값은 만 원 단위로 적는다. 억 단위로 줄이면 9,999만 원이 "1.0억 < 1.0억"으로 읽힌다.
    missed.push({ actual: `안전 마진 ${best.margin}만 원 < ${lotto.minMarginManwon}만 원`, bound: `안전 마진 ${eok(lotto.minMarginManwon)} 미만` });
  }
  if (!(Number.isFinite(best.marginRate) && best.marginRate >= lotto.minMarginRate)) {
    const actual = Number.isFinite(best.marginRate) ? `마진율 ${floorPercent(best.marginRate)} < ${ratePercent(lotto.minMarginRate)}` : '마진율 없음';
    missed.push({ actual, bound: `마진율 ${ratePercent(lotto.minMarginRate)} 미만` });
  }
  return missed;
}

// 확인 필요인 까닭. 신뢰도가 하(조회 실패로만 내려간 값은 되돌려 본다)이면 시세 근거가 약하다는 것을, 아니면 넘지 못한 마진 기준을 적는다.
// note는 주간 메일의 확인 필요 항목에 쓰는 짧은 사유다. 마진과 신뢰도는 메일에서 따로 적는다.
function checkCause(best, lotto) {
  if (effectiveConfidence(best) === CONFIDENCE.LOW) {
    const scope = scopeNote(best.basis);
    return { reason: `시세 근거가 약함(신뢰도 하${scope ? `, ${scope}` : ''})`, note: `시세 근거가 약함${scope ? `(${scope})` : ''}` };
  }
  const missed = missedMargins(best, lotto);
  return {
    reason: `마진이 기준에 못 미침(${missed.map((item) => item.actual).join(', ')})`,
    note: `마진이 기준에 못 미침(${missed.map((item) => item.bound).join(' 또는 ')})`,
  };
}

// 조회 실패로 낮아진 신뢰도를 되돌려 판정했으면 판별 근거 끝에 밝힐 말.
function lookupNoteOf(best) {
  const level = effectiveConfidence(best);
  return level !== best.confidence ? `; 분양권·역 정보 조회 실패로 신뢰도를 ${best.confidence}로 낮췄으나 ${level} 기준으로 판정` : '';
}

// 조건형 로또 후보의 최종 판정. lotto.triggerPriceCheck에서 켠 조건만 시세를 본다. 기본 설정은 불법행위 재공급을 포함해 모두 켜 예외가 없다. 설정으로 끈 조건만 늘 로또다.
// 시세를 보는 조건은 일반 공고와 같은 기준(gradeOf)으로 가른다.
// 1) 추정이 있고 안전 마진이 0 이하면 신뢰도와 상관없이 아님.
// 2) 신뢰도 중 이상이고 안전 마진 lotto.minMarginManwon 이상, 마진율 lotto.minMarginRate 이상이면 로또.
// 3) 마진은 양수인데 신뢰도가 하이거나 마진 기준 중 하나라도 못 넘으면 확인 필요(STATUS.CHECK). 긴급 알림은 보내지 않는다.
// 4) 추정이 없으면 확인 필요다. 시세를 모르는 채로 로또라고 알리지 않는다.
// 5) 무순위(재공급에는 차수가 없다)가 remainderMaxRound차 이상이면 확인 필요가 될 공고도, 추정이 없는 공고도 아님이다(repeatedRound).
//    로또 조건을 모두 넘는 공고만 차수와 상관없이 로또로 둔다.
// 신뢰도는 분양권·역 정보 조회 실패로만 내려갔으면 내려가기 전 값으로 본다(effectiveConfidence). 조회 한 번 실패로
// 중 신뢰도의 로또가 확인 필요가 되어 알림이 사라지지 않게 한다. 표시하는 신뢰도는 하 그대로다.
function decideTrigger(trigger, { notice, best, undetermined, lookupFailed = false, lotto }) {
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
  const checkResult = (head, note, lookupNote = '') => (repeated ? repeatedResult() : {
    status: STATUS.CHECK,
    reason: `${best ? `${head}; ${priceText(best)}` : head}${lookupNote}`,
    shortReason: best ? `${head}; ${shortPriceText(best)}` : head,
    checkNote: note,
  });
  if (!best) {
    const head = `${label} 해당이나 시세 추정 없음(${undetermined})`;
    // 시세 조회 실패로 모르는 것이면 반복 공급보다 먼저 확인 필요로 두고, keepPreviousLotto가 저장된 로또를 유지한다.
    // 일시적인 조회 실패가 3차 이상 무순위의 로또를 아님으로 내리지 않게 한다.
    if (lookupFailed) return { status: STATUS.CHECK, reason: head, shortReason: head, checkNote: head, lookupFailed: true };
    return checkResult(head, head);
  }
  const lookupNote = lookupNoteOf(best);
  const grade = gradeOf(best, lotto);
  if (grade === 'not') {
    return {
      status: STATUS.NOT,
      reason: `${label} 해당이나 시세 대비 이점 없음; ${priceText(best)}${lookupNote}`,
      shortReason: `${label} 해당이나 시세 이점 없음; ${shortPriceText(best)}`,
    };
  }
  if (grade === 'lotto') return lookupNote ? { ...candidate, reason: `${candidate.reason}${lookupNote}` } : candidate;
  const cause = checkCause(best, lotto);
  return checkResult(`${label} 해당이나 ${cause.reason}`, `${label} 해당이나 ${cause.note}`, lookupNote);
}

// 조건 없는 APT의 판정. 조건형 공고와 같은 등급 기준(gradeOf)을 쓴다. 추정이 없는 경우는 부르는 쪽이 판별 불가로 정한다.
function decideByMargin(best, lotto) {
  const reason = `${priceText(best)}${lookupNoteOf(best)}`;
  const shortReason = shortPriceText(best);
  const grade = gradeOf(best, lotto);
  if (grade === 'lotto') return { status: STATUS.LOTTO, reason, shortReason };
  if (grade === 'not') return { status: STATUS.NOT, reason, shortReason };
  const cause = checkCause(best, lotto);
  return { status: STATUS.CHECK, reason: `${cause.reason}; ${reason}`, shortReason: `${cause.reason}; ${shortReason}`, checkNote: cause.note };
}

// 추정이 없으면 best가 null이고 undetermined에 까닭이 있다. failed는 실거래 조회가 실패해 이번에는 모르는 경우,
// unmapped는 단지 주소의 시군구 코드를 찾지 못한 경우다.
async function estimateNotice(notice, models, { config, today, getTrades, getPresale, aptInfo, walkMinutes, preferConfident, onError, onSoft }) {
  const { lotto, market } = config;
  const { codes, fallbackCode, umd, village } = resolveAddress(notice.address, notice.region);
  if (codes.length === 0) return { best: null, undetermined: '시군구 코드 미매핑', unmapped: true };
  try {
    const months = completeMonths(today, lotto.tradeMonths);
    // 구로 나뉜 시의 주소에 구가 없으면 코드가 여럿이라 구마다 조회한다(src/sgg-codes.js). 공고 법정동이 나오는 구의 거래만 쓰고,
    // 구 코드가 모두 비면 구 없는 시 코드로 한 번 더 조회한다(readTradesFor).
    const read = await readTradesFor(getTrades, { codes, fallbackCode }, months, { umd, village });
    const trades = read.rows;
    // 지역 안 공고의 실거래가 한 건도 없으면(대체 코드도 비면) 코드 문제일 수 있다. 판정은 그대로 두고 건수만 센다.
    if (trades.length === 0) onSoft('trade_lookup_empty');
    const presale = await readPresaleByCodes(getPresale, read.codes, months);
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
    const lookup = await resolveStations({ aptInfo, codes: read.codes, subject, models, rows, lotto, market, today, onSoft });
    const best = estimateBestMargin({
      models,
      rows,
      subject,
      stations: lookup.stations,
      stationLookupFailed: lookup.failed,
      presaleOk: presale.ok,
      crossWard: read.crossWard,
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
  // 안전 마진과 최고 분양가를 정한 주택형의 전용면적(㎡)
  judgedArea: Number.isFinite(best.area) ? Math.round(best.area * 100) / 100 : null,
  estimate: best.estimate,
  margin: best.margin,
  marginRate: best.marginRate,
  confidence: best.confidence,
  // 판정에 쓴 신뢰도. 분양권·역 정보 조회 실패로만 내려간 값은 내려가기 전 값이다(effectiveConfidence). 표시하는 confidence는 그대로다.
  effectiveConfidence: effectiveConfidence(best),
  // 건수만 센다. 같은 단지 거래로 계산하면 역 보정이 필요 없어 비어 있다.
  stationState: best.basis.stationState ?? null,
  complexOutliers: best.outliers ?? 0,
  // 시세 추정에 쓴 거래 건수(같은 단지 거래 또는 비교 단지 표본). 청약 등급의 환금성에 쓴다(src/grade.js).
  tradeSamples: best.basis.samples ?? null,
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
  const none = (why, { clear = true, models = null } = {}) => ({
    status: STATUS.OUT_OF_SCOPE,
    reason: `제한 유형(${shared.type})은 로또 판별 대상이 아님; 참고 마진 없음(${why})`,
    topPrice: null,
    estimate: null,
    margin: null,
    marginRate: null,
    confidence: null,
    ...factFields(models),
    ...(clear ? { clearMarket: true } : {}),
  });
  if (notice.kind === 'lh') {
    // LH는 분양 유형(공공분양)만 시세를 본다. 보통 LH 판별과 같다(flags.priceCap은 분양 유형에만 켠다).
    if (!notice.flags?.priceCap && lhTypeClass(notice, config.lh ?? {}) !== 'sale') return none('판별 대상 유형이 아님');
    const pending = LH_PENDING_REASONS[notice.lhDetailState];
    if (pending) return none(pending, { clear: false, models: notice.models });
    if (!hasLhModels(notice.models)) {
      if (notice.lhDetailState !== 'ok') return none('LH 상세 정보 없음', { models: notice.models });
      return none(notice.lhModelsUnattached ? 'LH 단지 주소 미매핑' : 'LH 공급 정보 없음', { models: notice.models });
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
  if (!models.some((model) => model.area > 0 && model.price > 0)) return none('주택형 정보 없음', { models });
  const { best, undetermined, failed, unmapped } = await estimateNotice(notice, models, { config, today, getTrades, getPresale, aptInfo, walkMinutes, preferConfident: false, onError, onSoft });
  if (!best) {
    const why = unmapped && notice.kind === 'lh' ? 'LH 단지 주소 미매핑' : undetermined;
    return none(why, { clear: !failed, models });
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
    ...priceFacts(models),
    referenceMargin: true,
  };
}

async function evaluatePrice(notice, { config, today, getModels, getFactModels, getTrades, getPresale, aptInfo, walkMinutes = null, onError = () => {}, onSoft = () => {}, onSoftOnce = onSoft }) {
  const { lotto, market } = config;
  const result = (status, reason, extra = {}) => ({
    status, reason, topPrice: null, estimate: null, margin: null, marginRate: null, confidence: null, ...extra,
  });

  // 대상 외 경로의 분양가는 공고의 사실이라 적는다. 판정, 마진, 추정 시세는 건드리지 않는다.
  const facts = async () => factFields(await lookupFactModels(notice, { getFactModels, onSoftOnce }));

  if (!config.alertRegions.includes(notice.region)) {
    return result(STATUS.OUT_OF_SCOPE, '알림 지역이 아님', await facts());
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
      ...factFields(restrictedModels),
    });
  }

  // LH 공고는 상세·공급 정보로 주택형과 단지 주소를 읽었을 때만 판별한다(조회 상태는 src/lh-detail-map.js의 lhDetailState).
  // 조회가 실패했거나 상한에 걸리면 이번에는 모르는 것이라 판별 불가로 두어 저장된 로또를 유지한다(keepPreviousLotto).
  // 자료가 없거나(요청 코드 없음, 쓸 수 있는 주택형 없음) 단지 주소를 찾지 못하면 예전처럼 대상 외다.
  if (notice.kind === 'lh') {
    const status = notice.noticeStatus ? ` (${notice.noticeStatus})` : '';
    const lhFacts = factFields(notice.models);
    const pending = LH_PENDING_REASONS[notice.lhDetailState];
    // 상세·공급 조회 실패와 상한은 이번에 모르는 것이라 저장된 로또를 유지한다(lookupFailed).
    if (pending) return result(STATUS.UNDETERMINED, `${pending}${status}`, { ...lhFacts, lookupFailed: true });
    if (!hasLhModels(notice.models)) {
      if (notice.lhDetailState !== 'ok') return result(STATUS.OUT_OF_SCOPE, `LH 상세 정보 없음${status}`, lhFacts);
      return result(STATUS.OUT_OF_SCOPE, `${notice.lhModelsUnattached ? 'LH 단지 주소 미매핑' : 'LH 공급 정보 없음'}${status}`, lhFacts);
    }
    if (resolveAddress(notice.address, notice.region).codes.length === 0) return result(STATUS.OUT_OF_SCOPE, `LH 단지 주소 미매핑${status}`, lhFacts);
  }

  const trigger = flagTrigger(notice, lotto);
  const usesPrice = notice.kind === 'apt' || Boolean(trigger);
  if (badTriggerConfig(lotto)) onSoftOnce('bad_trigger_config');
  if (badMarginConfig(lotto)) onSoftOnce('bad_margin_config');

  if (!usesPrice) {
    const label = notice.kind === 'remainder' || notice.kind === 'arbitrary' ? '설정에서 제외된 유형' : '판별 대상 유형이 아님';
    return result(STATUS.OUT_OF_SCOPE, label, await facts());
  }

  let models = null;
  // 주택형이나 실거래 조회가 예외로 실패해 이번에는 추정을 모르는 경우. 자료가 없어서 추정이 없는 경우(주택형이 null로 옴, 표본 부족, 미매핑)와 구별한다.
  let lookupFailed = false;
  try {
    models = await getModels(notice);
  } catch (error) {
    lookupFailed = true;
    onError(safeError(error));
  }
  const topPrice = topPriceOf(models);

  let best = null;
  let undetermined = models ? null : '주택형 정보 조회 실패';
  if (models) {
    // 신뢰도 중 이상 주택형을 먼저 본다. 조건형이든 일반 공고든 같은 기준이다.
    const estimated = await estimateNotice(notice, models, { config, today, getTrades, getPresale, aptInfo, walkMinutes, preferConfident: true, onError, onSoft });
    ({ best, undetermined } = estimated);
    lookupFailed = Boolean(estimated.failed);
  }

  const price = { ...(best ? priceFields(best) : { topPrice }), ...priceFacts(models) };

  // LH는 비교 단지가 없는 신도시 블록이 많아, 추정이 없으면 다른 분양가상한제 공고와 달리 확인 필요가 아니라 판별 불가다.
  // 추정이 있으면 다른 조건형 공고와 같은 기준이다.
  if (notice.kind === 'lh' && !best) return result(STATUS.UNDETERMINED, `LH 공공분양; 시세 추정 없음(${undetermined})`, { ...price, ...(lookupFailed ? { lookupFailed: true } : {}) });
  if (trigger) {
    const { status, reason, ...extra } = decideTrigger(trigger, { notice, best, undetermined, lookupFailed, lotto });
    return result(status, reason, { ...price, ...extra });
  }
  if (!best) return result(STATUS.UNDETERMINED, undetermined, { ...price, ...(lookupFailed ? { lookupFailed: true } : {}) });
  const { status, reason, ...extra } = decideByMargin(best, lotto);
  return result(status, reason, { ...price, ...extra });
}

// 이번 판정이 조회 실패로 모르는 것(lookupFailed)이면 이전 로또를 유지한다. 조회 실패 하나로 알림이 조용히 사라지지 않게 하려는 것이다.
// 판별 불가이거나 시세 조회 실패로 추정을 못 구한 조건형 공고의 확인 필요가 여기에 든다. 조건 없는 공고와 LH도 같다.
// 자료가 없어서 모르는 경우(실거래 표본 부족, 시군구 코드 미매핑, 주택형 없음)는 실패가 아니라 유지하지 않는다. 아니면 로또가 영영 남는다.
// 시세로 정한 판정은 유지하지 않는다. 신뢰도 하 추정이 만든 아님·확인 필요, 신뢰도 중 이상 추정의 아님·확인 필요,
// 무순위 반복 공급으로 정한 아님이 모두 그렇다. 약한 추정이 이전 로또를 붙들어 로또가 아닌 공고에 긴급 알림이 가던 것을 없앤다.
export function keepPreviousLotto(evaluation, previousStatus) {
  if (previousStatus !== STATUS.LOTTO) return evaluation;
  const unknown = evaluation.lookupFailed === true && (evaluation.status === STATUS.UNDETERMINED || evaluation.status === STATUS.CHECK);
  if (!unknown) return evaluation;
  const label = '이전 판별 유지';
  return {
    ...evaluation,
    status: STATUS.LOTTO,
    reason: `${label} (이번 실행: ${evaluation.reason})`,
    shortReason: `${label} (이번 실행: ${evaluation.shortReason ?? evaluation.reason})`,
  };
}
