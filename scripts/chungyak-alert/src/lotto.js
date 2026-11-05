import {
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
import { completeMonths, safeError } from './util.js';

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
  if (basis.stationState === STATION.NO_DATA) return `역 도보 ${basis.walkMinutes}분(입력), 비교 단지 역 정보 부족으로 역 보정 없음`;
  return '역 도보 미입력, 역 보정 없음';
}

function basisText(basis) {
  if (basis.kind === 'same') {
    return `같은 단지 거래 ${basis.samples}건(분양권 ${basis.presaleSamples}건), 보정 없음`;
  }
  const names = basis.comparables
    .slice(0, 3)
    .map((item) => `${item.name || '이름 없음'}(${item.walkBand ? `${item.walkBand}, ` : ''}브랜드 ${percent(item.brandRatio)}, 연식 ${percent(item.ageRatio)})`)
    .join(', ');
  return `${stationText(basis)}; 비교 단지 ${basis.comparables.length}곳 표본 ${basis.samples}건(${basis.scope}): ${names}`;
}

const priceText = (best) => `안전 마진 ${eok(best.margin)}, 마진율 ${Math.round(best.marginRate * 100)}% (${best.houseType}, 신뢰도 ${best.confidence}); `
  + `${basisText(best.basis)}; 하위 25% 시세 ${eok(best.safeValue)}에서 분양가 ${eok(best.price)}, 옵션 ${best.optionCost}만 원, 취득세 ${best.tax}만 원 차감`;

const topPriceOf = (models) => {
  const prices = models.map((m) => m.price).filter((p) => p > 0);
  return prices.length > 0 ? Math.max(...prices) : null;
};

function subjectJibun(address, umd) {
  if (!umd) return null;
  const tokens = String(address ?? '').replace(/[(),]/g, ' ').trim().split(/\s+/);
  const next = tokens[tokens.indexOf(umd) + 1] ?? '';
  return /^\d+(-\d+)?$/.test(next) ? next : null;
}

// 공고 단지 입력이 있을 때만 비교 단지의 역 정보를 조회한다. 조회 실패는 클라이언트가 한 번만 로그에 남긴다.
async function resolveStations({ aptInfo, code, subject, models, rows, lotto, market, today, onSoft }) {
  const stations = new Map();
  if (!aptInfo || !Number.isFinite(subject.walkMinutes)) return stations;
  const candidates = lookupCandidates({ models, rows, subject, lotto, market, today });
  if (candidates.length === 0) return stations;
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
    return stations;
  } catch {
    return new Map();
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
    const { code, umd } = resolveAddress(notice.address, notice.region);
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
          jibun: subjectJibun(notice.address, umd),
          walkMinutes,
          market,
        });
        const stations = await resolveStations({ aptInfo, code, subject, models, rows, lotto, market, today, onSoft });
        best = estimateBestMargin({
          models,
          rows,
          subject,
          stations,
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
    }
    : { topPrice };

  if (trigger) {
    return result(STATUS.LOTTO, best ? `${trigger}; ${priceText(best)}` : trigger, price);
  }
  if (!best) return result(STATUS.UNDETERMINED, undetermined, price);
  return result(meetsPriceRule(best, lotto) ? STATUS.LOTTO : STATUS.NOT, priceText(best), price);
}

// 이번 판정이 불가여도 이미 로또로 기록된 공고는 로또를 유지한다.
export function keepPreviousLotto(evaluation, previousStatus) {
  if (evaluation.status === STATUS.UNDETERMINED && previousStatus === STATUS.LOTTO) {
    return { ...evaluation, status: STATUS.LOTTO, reason: `이전 판별 유지 (이번 실행: ${evaluation.reason})` };
  }
  return evaluation;
}
