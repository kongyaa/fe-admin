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

function flagTrigger(notice, lotto) {
  if (notice.kind === 'remainder') {
    if (notice.houseSecd === '04' && lotto.includeRemainder) return '수도권 무순위·잔여세대';
    if (notice.houseSecd === '06' && lotto.includeResupply) return '수도권 불법행위 재공급';
  }
  if (notice.kind === 'arbitrary' && lotto.includeArbitrary) return '수도권 임의공급';
  if (notice.kind === 'apt') {
    if (lotto.includePriceCap && notice.flags.priceCap) return '분양가상한제 적용';
    if (lotto.includePublicDistrict && notice.flags.publicDistrict) return '공공주택지구';
  }
  return null;
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
  if (!best.discountMeasured) return `보수 시세 ${eok(best.safeValue)}(비교 단지가 적어 추정 시세에서 상한 ${percentText} 차감)`;
  if (best.discountExceeded) return `보수 시세 ${eok(best.safeValue)}(검증 오차가 상한을 넘어 추정 시세에서 ${percentText}만 차감, 실제 위험은 더 큼)`;
  return `보수 시세 ${eok(best.safeValue)}(추정 시세에서 검증 오차 ${percentText} 차감)`;
}

// 카카오톡용 짧은 근거. 메시지 200자 안에 들도록 마진과 신뢰도만 적는다.
const shortPriceText = (best) => `안전 마진 ${eok(best.margin)}, 마진율 ${Math.round(best.marginRate * 100)}% (${best.houseType}, 신뢰도 ${best.confidence})`;

const priceText = (best) => `${shortPriceText(best)}; `
  + `${basisText(best.basis)}; ${safeText(best)}에서 분양가 ${eok(best.price)}, 옵션 ${best.optionCost}만 원, 취득세 ${best.tax}만 원 차감`;

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
export async function evaluateLotto(notice, { config, today, getModels, getTrades, getPresale, aptInfo, walkMinutes = null, onError = () => {}, onSoft = () => {} }) {
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
    return result(STATUS.OUT_OF_SCOPE, `제한 유형(${restricted})은 로또 판별과 안전 마진 대상이 아님`, { clearMarket: true });
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

  if (trigger) {
    return result(STATUS.LOTTO, best ? `${trigger}; ${priceText(best)}` : trigger, { ...price, shortReason: best ? `${trigger}; ${shortPriceText(best)}` : trigger });
  }
  if (!best) return result(STATUS.UNDETERMINED, undetermined, price);
  // 가격 기준만으로 로또가 되려면 신뢰도가 중 이상이어야 한다. 조건형 로또는 위에서 이미 정해졌다.
  if (meetsPriceRule(best, lotto) && best.confidence === CONFIDENCE.LOW) {
    const note = '가격 기준은 넘지만 추정 신뢰도가 하라 로또로 보지 않음';
    return result(STATUS.NOT, `${note}; ${priceText(best)}`, { ...price, shortReason: `${note}; ${shortPriceText(best)}` });
  }
  return result(meetsPriceRule(best, lotto) ? STATUS.LOTTO : STATUS.NOT, priceText(best), { ...price, shortReason: shortPriceText(best) });
}

// 이번 판정이 불가이거나, 신뢰도 하인 추정이 가격 기준만으로 로또를 빼려 하면 이전 로또를 유지한다.
// 약한 추정 하나로 알림이 조용히 사라지지 않게 하려는 것이다. 아님은 가격 기준에서만 나온다.
export function keepPreviousLotto(evaluation, previousStatus) {
  if (previousStatus !== STATUS.LOTTO) return evaluation;
  const weak = evaluation.status === STATUS.NOT && evaluation.confidence === CONFIDENCE.LOW;
  if (evaluation.status !== STATUS.UNDETERMINED && !weak) return evaluation;
  const label = weak ? '이전 판별 유지(이번 추정 신뢰도 하)' : '이전 판별 유지';
  return {
    ...evaluation,
    status: STATUS.LOTTO,
    reason: `${label} (이번 실행: ${evaluation.reason})`,
    shortReason: `${label} (이번 실행: ${evaluation.shortReason ?? evaluation.reason})`,
  };
}
