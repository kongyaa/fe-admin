import {
  buildSubject,
  cleanTrades,
  estimateBestMargin,
  haversineMeters,
  lookupCandidates,
  meetsPriceRule,
  restrictedType,
  stationLookupKeys,
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

// 판별 근거는 Notion에 저장되므로 카카오 응답에서 나온 값(역 거리, 역 계수, 단지 거리)은 넣지 않는다.
// 카카오 운영 정책이 응답을 가공한 값의 저장도 허용하지 않기 때문이다. docs/sources.md 참고.
function basisText(basis) {
  if (basis.kind === 'same') {
    return `같은 단지 거래 ${basis.samples}건(분양권 ${basis.presaleSamples}건), 보정 없음`;
  }
  const names = basis.comparables
    .slice(0, 3)
    .map((item) => `${item.name || '이름 없음'}(브랜드 ${percent(item.brandRatio)}, 연식 ${percent(item.ageRatio)})`)
    .join(', ');
  const scope = basis.stationUsed ? '역세권 보정 포함' : `${basis.scope} 기준, 위치 보정 없음`;
  return `비교 단지 ${basis.comparables.length}곳 표본 ${basis.samples}건, ${scope}: ${names}`;
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

// 좌표는 이 함수 안에서만 쓰고 돌려주지 않는다. 호출 실패는 클라이언트가 한 번만 알리고, 여기서는 위치 보정을 건너뛴다.
async function resolveLocations({ locator, notice, subject, areaText, models, rows, lotto, market, today }) {
  if (!locator) return { locationOk: false, locations: new Map() };
  const candidates = lookupCandidates({ models, rows, subject, lotto, market, today });
  if (candidates.length === 0) return { locationOk: false, locations: new Map() };
  try {
    const origin = await locator.locateSubject({ address: notice.address, name: notice.name, areaText });
    if (!origin) return { locationOk: false, locations: new Map() };
    const locations = new Map();
    for (const complex of candidates) {
      const coord = await locator.locateComplex(`${areaText} ${complex.umd ?? ''} ${complex.jibun}`.replace(/\s+/g, ' ').trim());
      if (coord) locations.set(complex.key, { coord, distanceM: haversineMeters(origin, coord) });
    }
    subject.stationM = await locator.nearestStation(origin);
    for (const key of stationLookupKeys({ models, rows, locations, lotto, market, today })) {
      const location = locations.get(key);
      location.stationM = await locator.nearestStation(location.coord);
    }
    return { locationOk: true, locations, keywordLocated: Boolean(origin.viaKeyword) };
  } catch {
    subject.stationM = null;
    return { locationOk: false, locations: new Map() };
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

// getModels/getTrades 실패는 판정을 막지 않고 onError로 모은다. getPresale과 locator는 실패해도 신뢰도만 낮춘다.
export async function evaluateLotto(notice, { config, today, getModels, getTrades, getPresale, locator, onError = () => {} }) {
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
  let locationOk = false;
  let undetermined = models ? null : '주택형 정보 조회 실패';
  if (models) {
    const { code, umd, areaText } = resolveAddress(notice.address, notice.region);
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
          market,
        });
        const location = await resolveLocations({ locator, notice, subject, areaText, models, rows, lotto, market, today });
        locationOk = location.locationOk;
        best = estimateBestMargin({
          models,
          rows,
          subject,
          locations: location.locations,
          locationOk,
          presaleOk: presale.ok,
          keywordLocated: location.keywordLocated,
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
      // 비교 단지로 계산했지만 위치 보정을 쓰지 못한 경우다. 건수만 센다.
      locationFallback: best.basis.kind === 'comparables' && !best.basis.stationUsed,
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
