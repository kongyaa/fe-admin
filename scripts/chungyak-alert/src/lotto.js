import { resolveAddress } from './sgg-codes.js';
import { completeMonths, median, safeError } from './util.js';

export const STATUS = {
  LOTTO: '로또',
  NOT: '아님',
  UNDETERMINED: '판별 불가',
  OUT_OF_SCOPE: '대상 외',
};

const eok = (manwon) => `${(manwon / 10000).toFixed(1)}억`;

const meetsPriceRule = (candidate, lotto) => candidate.gain >= lotto.minGainManwon || candidate.rate >= lotto.minDiscountRate;

// 기준을 넘는 주택형 중 차익이 가장 큰 것을, 없으면 전체에서 차익이 가장 큰 것을 돌려준다.
export function estimateBestGain({ models, trades, umd, lotto, today }) {
  const thisYear = Number(today.slice(0, 4));
  let best = null;
  let bestQualifying = null;
  for (const model of models) {
    if (!(model.area > 0) || !(model.price > 0)) continue;
    const near = trades.filter((t) => Math.abs(t.area - model.area) <= lotto.areaToleranceM2);
    const sameDong = umd ? near.filter((t) => t.umd === umd) : [];
    let scope;
    let pool;
    if (sameDong.length >= lotto.minSamples) {
      scope = '법정동';
      pool = sameDong;
    } else if (near.length >= lotto.minSamples) {
      scope = '시군구';
      pool = near;
    } else {
      continue;
    }
    const recent = pool.filter((t) => t.buildYear && thisYear - t.buildYear <= lotto.newBuildYears);
    if (recent.length >= lotto.minSamples) {
      pool = recent;
      scope = `${scope} 신축`;
    }
    const estimate = Math.round(median(pool.map((t) => t.amount / t.area)) * model.area);
    const gain = estimate - model.price;
    const candidate = {
      houseType: model.houseType,
      price: model.price,
      estimate,
      gain,
      rate: gain / estimate,
      scope,
      samples: pool.length,
    };
    if (!best || gain > best.gain) best = candidate;
    if (meetsPriceRule(candidate, lotto) && (!bestQualifying || gain > bestQualifying.gain)) {
      bestQualifying = candidate;
    }
  }
  return bestQualifying ?? best;
}

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

const priceText = (best) => `예상 차익 ${eok(best.gain)}, 시세 대비 ${Math.round(best.rate * 100)}% (${best.scope} 표본 ${best.samples}건)`;

const topPriceOf = (models) => {
  const prices = models.map((m) => m.price).filter((p) => p > 0);
  return prices.length > 0 ? Math.max(...prices) : null;
};

// getModels/getTrades 실패는 판정을 막지 않고 onError로 모은다.
export async function evaluateLotto(notice, { config, today, getModels, getTrades, onError = () => {} }) {
  const lotto = config.lotto;
  const result = (status, reason, extra = {}) => ({
    status, reason, topPrice: null, estimate: null, gain: null, rate: null, ...extra,
  });

  if (!config.alertRegions.includes(notice.region)) {
    return result(STATUS.OUT_OF_SCOPE, '알림 지역이 아님');
  }
  if (notice.kind === 'lh') {
    return result(STATUS.OUT_OF_SCOPE, `LH 공고는 판별 대상이 아님${notice.noticeStatus ? ` (${notice.noticeStatus})` : ''}`);
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
        const trades = await getTrades(code, completeMonths(today, lotto.tradeMonths));
        best = estimateBestGain({ models, trades, umd, lotto, today });
        if (!best) undetermined = '실거래 표본 부족';
      } catch (error) {
        onError(safeError(error));
        undetermined = '실거래 조회 실패';
      }
    }
  }

  const price = best
    ? { topPrice: best.price, estimate: best.estimate, gain: best.gain, rate: best.rate }
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
