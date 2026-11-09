// LH 공고 중 분양이면서 대상 지역인 공고만 남긴다. 수집한 공고와 Notion에 저장된 행에 같은 규칙을 쓴다.
// 청약홈 공고는 보지 않는다. 규칙과 단어 목록은 config.json의 lh에 있다.
// 유형이나 지역을 읽을 수 없으면(빈 값, 모르는 유형) 빼지 않고 남긴다.

// 공백을 지워 `하남 교산`과 `하남교산`을 같게 본다.
const squash = (value) => String(value ?? '').replace(/\s+/g, '');
const hasWord = (text, word) => Boolean(squash(word)) && text.includes(squash(word));
const hasAny = (text, words) => (words ?? []).some((word) => hasWord(text, word));
const stripAll = (text, words) => (words ?? []).reduce((rest, word) => (squash(word) ? rest.split(squash(word)).join(' ') : rest), text);

// LH 공고나 LH 행인지. 키는 src/sources/lh.js가 `LH-`로 만든다.
export function isLhItem(item) {
  return item.kind === 'lh' || item.source === 'LH' || String(item.key ?? '').startsWith('LH-');
}

// 유형 값. 수집한 공고는 상위 유형과 세부 유형을 이어 적고, 둘 다 없으면 `LH`라서 빈 값으로 본다.
function typeText(item) {
  const label = squash(item.typeLabel);
  return label === 'LH' ? '' : label;
}

// 이름의 제외 단어. lh.nameExcludeUnless에 적힌 단어(선택형 → 나눔형, 일반형)가 이름에 함께 있으면 제외하지 않는다.
// `뉴:홈 공공분양주택 입주자모집공고(나눔형·선택형)`처럼 분양과 선택형을 함께 모집하는 공고를 남기려는 것이다.
function nameExcluded(name, lh) {
  return (lh.excludeKeywords ?? []).some((word) => hasWord(name, word) && !hasAny(name, lh.nameExcludeUnless?.[word]));
}

// 유형 판정: 'drop'(분양 아님), 'sale', 'empty'(유형 없음), 'unknown'(모르는 유형). drop만 뺀다.
export function lhTypeClass(item, lh) {
  const type = typeText(item);
  // 선택형, 분양전환, 매각, 용지는 유형에 있으면 뺀다. 이름에 있으면 위의 예외를 본다.
  if (hasAny(type, lh.excludeKeywords) || nameExcluded(squash(item.name), lh)) return 'drop';
  if (!type) return 'empty';
  // 토지임대부처럼 임대·토지 단어가 들어 있어도 분양인 말은 지우고 나머지 유형을 본다(`임대주택 토지임대부`는 뺀다).
  const rest = stripAll(type, lh.forceSaleKeywords);
  // 임대, 주거복지, 토지, 상가 등. 분양 단어보다 먼저 본다(`분양주택 분양전환`, `신혼희망타운 행복주택`).
  if (hasAny(rest, lh.nonSaleTypes)) return 'drop';
  if (rest !== type || hasAny(rest, lh.saleTypes)) return 'sale';
  return 'unknown';
}

// 분양이 아니면 'type'을 돌려준다.
export function lhTypeRule(item, lh) {
  return lhTypeClass(item, lh) === 'drop' ? 'type' : null;
}

// 대상 지역이 아니면 'area'를 돌려준다. 시도(lh.targetRegions)이거나 이름에 지구 단어(lh.targetAreas)가 있으면 남긴다.
// 공급지역이 비었으면 판정할 수 없어 남긴다(lh_region_unknown으로 센다).
export function lhAreaRule(item, lh) {
  if (!item.region) return null;
  if ((lh.targetRegions ?? []).includes(item.region)) return null;
  const name = squash(item.name);
  if ((lh.targetAreas ?? []).some((area) => hasAny(name, area.keywords))) return null;
  return 'area';
}

// 수집한 공고의 판정. 범위 밖이면 사유('type' 또는 'area'), 남기면 null이다. LH가 아니거나 기능이 꺼져 있으면 null이다.
export function lhScopeRule(item, config) {
  const lh = config.lh ?? {};
  if (!lh.filterSaleArea || !isLhItem(item)) return null;
  return lhTypeRule(item, lh) ?? lhAreaRule(item, lh);
}

// 건수만 세는 진단 값. 기능이 켜진 LH 공고 중 유형이 모르는 값인지, 분양으로 남았는데 공급지역이 비었는지.
export function isUnknownLhType(item, config) {
  const lh = config.lh ?? {};
  return Boolean(lh.filterSaleArea) && isLhItem(item) && lhTypeClass(item, lh) === 'unknown';
}

export function isUnknownLhRegion(item, config) {
  const lh = config.lh ?? {};
  return Boolean(lh.filterSaleArea) && isLhItem(item) && !lhTypeRule(item, lh) && !item.region;
}

// 저장된 행의 판정. 행에는 유형, 주택명, 공급지역만 있다. 공급지역이 없으면 지역으로는 빼지 않는다.
export function storedLhScopeRule(row, config) {
  const lh = config.lh ?? {};
  if (!lh.filterSaleArea || !isLhItem(row)) return null;
  // 제목이 비었거나 키 그대로면(이름 없이 저장된 공고) 읽을 수 없는 행으로 보고 남긴다.
  if (!squash(row.name) || row.name === row.key) return null;
  return lhTypeRule(row, lh) ?? lhAreaRule(row, lh);
}

// 공개 로그용 분류 이름. 한글, 영문, 숫자, `/`, `·`만 남기고 20자에서 자른다. 공고 이름은 쓰지 않는다.
export const cleanLogPart = (value) => String(value ?? '').replace(/[^가-힣A-Za-z0-9/·]/g, '').slice(0, 20);

// 원본 행의 유형 이름(`상위/세부`). 빈 값은 `-`로 적는다.
export function lhTypeLogLabel(row) {
  return `${cleanLogPart(row.UPP_AIS_TP_NM) || '-'}/${cleanLogPart(row.AIS_TP_CD_NM) || '-'}`;
}

// `lh_sale_regions` 로그의 지역 이름. 빈 값은 `-`로 적는다.
export const lhRegionLogLabel = (region) => cleanLogPart(region) || '-';

// `lh_types`, `lh_sale_regions` 로그 값. 건수가 많은 순(같으면 이름순)으로 최대 limit개를 `이름=건수`로 잇는다.
export function formatLhTypes(counts, limit = 30) {
  return [...counts]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, limit)
    .map(([label, count]) => `${label}=${count}`)
    .join(',');
}
