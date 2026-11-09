import {
  CONFIDENCE,
  STATION,
  buildSubject,
  cleanTrades,
  estimateBestMargin,
  lookupCandidates,
  matchApartment,
  meetsPriceRule,
  restrictedType,
} from './market-estimate.js';
import { recommendTrack, unapplicableReason } from './recommend.js';
import { resolveAddress } from './sgg-codes.js';
import { AppError, completeMonths, safeError } from './util.js';

export const STATUS = {
  LOTTO: '로또',
  NOT: '아님',
  UNDETERMINED: '판별 불가',
  OUT_OF_SCOPE: '대상 외',
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
  const getModels = async (target) => {
    try {
      models = await options.getModels(target);
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
  const evaluation = { ...priced, unapplicable };
  // APT 주택형 조회가 실패하면 특별공급 세대를 몰라 저장된 추천을 그대로 둔다. 실행마다 추천이 바뀌지 않게 한다.
  if (notice.kind === 'apt' && modelsFailed) {
    const kept = '(추천: 조회 실패로 이전 값 유지)';
    return { ...evaluation, reason: evaluation.reason ? `${evaluation.reason}\n${kept}` : kept };
  }
  const recommendation = recommendTrack({ notice, models, profile: options.profile, config: options.config, today: options.today });
  if (!recommendation) return { ...evaluation, recommendation: null };
  return { ...evaluation, recommendation, reason: evaluation.reason ? `${evaluation.reason}\n${recommendation.text}` : recommendation.text };
}

// lotto.triggerPriceCheck가 일반 객체가 아니면 없는 것(예전 동작)으로 보고, true인 조건만 가격을 확인한다.
const priceCheckOn = (lotto, key) => {
  const checks = lotto.triggerPriceCheck;
  const plain = checks !== null && typeof checks === 'object' && !Array.isArray(checks);
  return plain && checks[key] === true;
};

// remainderMaxRound가 0보다 큰 수일 때만 반복 공급 규칙을 쓴다. 0이나 null이면 끈다.
const maxRoundOf = (lotto) => (Number.isFinite(lotto.remainderMaxRound) && lotto.remainderMaxRound > 0 ? lotto.remainderMaxRound : null);

// 조건형 로또 후보의 최종 판정. lotto.triggerPriceCheck에서 켠 조건만 시세를 본다.
// 신뢰도 중 이상 추정이 있으면 안전 마진 부호로 정한다(가격 기준을 넘으면 마진이 양수라 로또다).
// 추정이 없거나 신뢰도 하이면 놓치지 않게 로또로 둔다. 무순위가 remainderMaxRound차 이상이면 아님이지만,
// 신뢰도 하 추정이라도 가격 기준을 넘으면 놓치지 않게 로또다.
function decideTrigger(trigger, { notice, best, undetermined, lotto }) {
  const { key, label } = trigger;
  const candidate = {
    status: STATUS.LOTTO,
    reason: best ? `${label}; ${priceText(best)}` : label,
    shortReason: best ? `${label}; ${shortPriceText(best)}` : label,
  };
  if (!priceCheckOn(lotto, key)) return candidate;
  if (best && best.confidence !== CONFIDENCE.LOW) {
    if (best.margin >= 0) return candidate;
    return {
      status: STATUS.NOT,
      reason: `${label} 해당이나 시세 대비 이점 없음; ${priceText(best)}`,
      shortReason: `${label} 해당이나 시세 이점 없음; ${shortPriceText(best)}`,
    };
  }
  if (best && meetsPriceRule(best, lotto)) return candidate;
  const round = key === 'remainder' ? parseRemainderRound(notice.name) : null;
  const maxRound = maxRoundOf(lotto);
  if (round !== null && maxRound !== null && round >= maxRound) {
    const head = `${label} ${round}차 반복 공급`;
    return {
      status: STATUS.NOT,
      reason: `${head}; ${best ? priceText(best) : `시세 추정 없음(${undetermined})`}`,
      shortReason: `${head}; ${best ? shortPriceText(best) : '시세 추정 없음'}`,
      repeatedRound: round,
    };
  }
  return candidate;
}

async function evaluatePrice(notice, { config, today, getModels, getTrades, getPresale, aptInfo, walkMinutes = null, onError = () => {}, onSoft = () => {}, onSoftOnce = onSoft }) {
  const { lotto, market } = config;
  const result = (status, reason, extra = {}) => ({
    status, reason, topPrice: null, estimate: null, margin: null, marginRate: null, confidence: null, ...extra,
  });

  if (!config.alertRegions.includes(notice.region)) {
    return result(STATUS.OUT_OF_SCOPE, '알림 지역이 아님');
  }
  if (notice.kind === 'lh') {
    return result(STATUS.OUT_OF_SCOPE, `LH 공고는 판별 대상이 아님${notice.noticeStatus ? ` (${notice.noticeStatus})` : ''}`);
  }

  // 판정 조건보다 먼저 본다. 저장된 추정 값이 남지 않도록 clearMarket으로 지우게 한다.
  const restricted = restrictedType(notice, market);
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

  const trigger = flagTrigger(notice, lotto);
  const usesPrice = notice.kind === 'apt' || Boolean(trigger);

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
    const { code, umd, village } = resolveAddress(notice.address, notice.region);
    if (!code) {
      undetermined = '시군구 코드 미매핑';
    } else {
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
        best = estimateBestMargin({
          models,
          rows,
          subject,
          stations: lookup.stations,
          stationLookupFailed: lookup.failed,
          presaleOk: presale.ok,
          lotto,
          market,
          today,
        });
        if (!best) undetermined = '실거래 표본 부족';
      } catch (error) {
        onError(safeError(error));
        undetermined = '실거래 조회 실패';
      }
    }
  }

  const price = best
    ? {
      topPrice: best.price,
      estimate: best.estimate,
      margin: best.margin,
      marginRate: best.marginRate,
      confidence: best.confidence,
      // 건수만 센다. 같은 단지 거래로 계산하면 역 보정이 필요 없어 비어 있다.
      stationState: best.basis.stationState ?? null,
      complexOutliers: best.outliers ?? 0,
    }
    : { topPrice };
  price.averagePrice = averagePrice;

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
// 추정이 아니라 차수로 정한 것이라 유지하지 않는다(추정이 없을 때와 똑같이 뺀다). 반복 공급이라도
// 가격 기준을 넘는 추정은 신뢰도 하여도 로또라 여기까지 오지 않는다.
export function keepPreviousLotto(evaluation, previousStatus) {
  if (previousStatus !== STATUS.LOTTO) return evaluation;
  const weak = evaluation.status === STATUS.NOT && evaluation.confidence === CONFIDENCE.LOW && !evaluation.repeatedRound;
  if (evaluation.status !== STATUS.UNDETERMINED && !weak) return evaluation;
  const label = weak ? '이전 판별 유지(이번 추정 신뢰도 하)' : '이전 판별 유지';
  return {
    ...evaluation,
    status: STATUS.LOTTO,
    reason: `${label} (이번 실행: ${evaluation.reason})`,
    shortReason: `${label} (이번 실행: ${evaluation.shortReason ?? evaluation.reason})`,
  };
}
