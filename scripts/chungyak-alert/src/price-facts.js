// 주택형 분양가 사실(최저·최고·주택형별 문구). 판정과 무관하게 공고가 주는 값만 쓴다.
const RICH_TEXT_LIMIT = 2000;

const priceOf = (model) => (model?.price > 0 ? model.price : null);

// 가격이 있는 주택형의 최고 분양가 중 가장 큰 값(만원). 없으면 null.
export function topPriceOf(models) {
  const prices = (models ?? []).map(priceOf).filter((price) => price !== null);
  return prices.length > 0 ? Math.max(...prices) : null;
}

// 가격이 있는 주택형의 분양가 중 가장 작은 값(만원). 청약홈 주택형은 최고 분양가(LTTOT_TOP_AMOUNT) 하나만 주므로
// 실제로는 주택형별 최고 분양가 중 가장 낮은 값이다. 가격이 없는 주택형은 건너뛰고, 하나도 없으면 null.
export function minPriceOf(models) {
  const prices = (models ?? []).map(priceOf).filter((price) => price !== null);
  return prices.length > 0 ? Math.min(...prices) : null;
}

// 만원 → 억. 소수 둘째 자리까지, 끝의 0은 지운다. 1억 미만은 만원으로 적는다.
export function formatPrice(manwon) {
  if (manwon < 10000) return `${manwon.toLocaleString('en-US')}만`;
  return `${Number((manwon / 10000).toFixed(2))}억`;
}

const formatArea = (area) => (area > 0 ? `${Number(area.toFixed(2))}㎡` : '면적 미상');

// "59.98㎡ 5.2억(120세대) / 84.98㎡ 7.8억(80세대)". 가격이 있는 주택형만 면적순으로 적고, 하나도 없으면 null이다.
// 길이가 limit(Notion 문단 한도 2000자)를 넘으면 줄을 통째로 자르고 끝에 `… 외 N개`를 붙인다. 결과는 늘 limit 이하다.
export function formatModelPrices(models, limit = RICH_TEXT_LIMIT) {
  const lines = (models ?? [])
    .filter((model) => priceOf(model) !== null)
    .sort((a, b) => (a.area ?? Infinity) - (b.area ?? Infinity) || a.price - b.price)
    .map((model) => {
      const households = Number.isFinite(model.households) && model.households > 0 ? `(${model.households}세대)` : '';
      return `${formatArea(model.area)} ${formatPrice(model.price)}${households}`;
    });
  if (lines.length === 0) return null;
  const separator = ' / ';
  const whole = lines.join(separator);
  if (whole.length <= limit) return whole;
  for (let count = lines.length - 1; count >= 0; count -= 1) {
    const tail = `${count > 0 ? separator : ''}… 외 ${lines.length - count}개`;
    const head = lines.slice(0, count).join(separator);
    if (head.length + tail.length <= limit) return `${head}${tail}`;
  }
  return `… 외 ${lines.length}개`.slice(0, limit);
}

// 평균·최저·주택형별 문구. 주택형이 없으면 모두 null이다. averagePrice는 호출하는 쪽이 넘긴 계산을 쓴다.
export function priceFactsOf(models, averagePriceOf) {
  return {
    averagePrice: averagePriceOf(models),
    minPrice: minPriceOf(models),
    modelPrices: formatModelPrices(models),
  };
}

// 판정에 쓰지 않는 분양가 조회용 주택형 조회. 실행당 budget건과 첫 조회부터 budgetMs까지만 부르고(공고 하나는 한 번),
// 넘으면 onExceeded(건수)나 onTimeExceeded(시간)를 부르고 null을 돌려준다.
// skip(notice)가 true인 공고(이미 분양가를 채운 저장된 행)는 부르지 않고 한도에도 세지 않는다.
// budget이 0 이상의 정수가 아니면 기능을 끈 것으로 보고 조회도 건수도 남기지 않는다. budgetMs가 없으면 시간은 제한하지 않는다.
export function createFactLookup({ getModels, budget, budgetMs = null, now = () => new Date(), skip = () => false, onExceeded = () => {}, onTimeExceeded = () => {} }) {
  if (!Number.isInteger(budget) || budget < 0) return async () => null;
  const cache = new Map();
  let used = 0;
  let startedAt = null;
  return async (notice) => {
    if (cache.has(notice.key)) return cache.get(notice.key);
    if (!notice.mdlOp || skip(notice)) return null;
    startedAt ??= now().getTime();
    if (Number.isFinite(budgetMs) && now().getTime() - startedAt > budgetMs) {
      onTimeExceeded();
      return null;
    }
    if (used >= budget) {
      onExceeded();
      return null;
    }
    used += 1;
    const models = await getModels(notice);
    cache.set(notice.key, models);
    return models;
  };
}
