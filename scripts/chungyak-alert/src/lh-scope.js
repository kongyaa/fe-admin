// LH 공고 중 분양이면서 대상 지역인 공고만 남긴다. 수집한 공고와 Notion에 저장된 행에 같은 규칙을 쓴다.
// 청약홈 공고는 보지 않는다. 규칙과 단어 목록은 config.json의 lh에 있다.
// LH 유형 값(UPP_AIS_TP_NM, AIS_TP_CD_NM)은 실응답으로 확인되지 않았다. 그래서 유형이 비었거나 모르는 값이면 남긴다.

// 공백을 지워 `하남 교산`과 `하남교산`을 같게 본다.
const squash = (value) => String(value ?? '').replace(/\s+/g, '');
const hasAny = (text, words) => (words ?? []).some((word) => squash(word) && text.includes(squash(word)));

// LH 공고나 LH 행인지. 키는 src/sources/lh.js가 `LH-`로 만든다.
export function isLhItem(item) {
  return item.kind === 'lh' || item.source === 'LH' || String(item.key ?? '').startsWith('LH-');
}

// 유형 값. 수집한 공고는 상위 유형과 세부 유형을 이어 적고, 둘 다 없으면 `LH`라서 빈 값으로 본다.
function typeText(item) {
  const label = squash(item.typeLabel);
  return label === 'LH' ? '' : label;
}

// 유형 판정: 'drop'(분양 아님), 'sale', 'empty'(유형 없음), 'unknown'(모르는 유형). drop만 뺀다.
export function lhTypeClass(item, lh) {
  const type = typeText(item);
  const name = squash(item.name);
  // 선택형, 분양전환, 매각은 유형이나 이름 어디에 있어도 뺀다.
  if (hasAny(type, lh.excludeKeywords) || hasAny(name, lh.excludeKeywords)) return 'drop';
  // 토지임대부 분양은 분양이다. `토지`, `임대` 단어보다 먼저 본다. 제한 유형이라 판별은 `대상 외`가 된다.
  if (hasAny(type, lh.forceSaleKeywords) || hasAny(name, lh.forceSaleKeywords)) return 'sale';
  if (!type) return 'empty';
  // 임대, 주거복지, 토지, 상가 등. 분양 단어보다 먼저 본다(`분양주택 분양전환`, `신혼희망타운 행복주택`).
  if (hasAny(type, lh.nonSaleTypes)) return 'drop';
  if (hasAny(type, lh.saleTypes)) return 'sale';
  return 'unknown';
}

// 분양이 아니면 'type'을 돌려준다.
export function lhTypeRule(item, lh) {
  return lhTypeClass(item, lh) === 'drop' ? 'type' : null;
}

// 대상 지역이 아니면 'area'를 돌려준다. 시도(lh.targetRegions)이거나 이름에 지구 단어(lh.targetAreas)가 있으면 남긴다.
export function lhAreaRule(item, lh) {
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

// 수집한 LH 공고의 유형이 모르는 값인지. 건수(lh_type_unknown)만 센다.
export function isUnknownLhType(item, config) {
  const lh = config.lh ?? {};
  return Boolean(lh.filterSaleArea) && isLhItem(item) && lhTypeClass(item, lh) === 'unknown';
}

// 저장된 행의 판정. 행에는 유형, 주택명, 공급지역만 있다.
// 공급지역이 없으면 지역을 판정할 수 없어 지역으로는 빼지 않는다. 이름(제목)이 없는 행은 아무것도 판정하지 않는다.
export function storedLhScopeRule(row, config) {
  const lh = config.lh ?? {};
  if (!lh.filterSaleArea || !isLhItem(row)) return null;
  // 제목이 비었거나 키 그대로면(이름 없이 저장된 공고) 읽을 수 없는 행으로 보고 남긴다.
  if (!squash(row.name) || row.name === row.key) return null;
  const type = lhTypeRule(row, lh);
  if (type) return type;
  if (!row.region) return null;
  return lhAreaRule(row, lh);
}

// 공개 로그용 유형 이름. 한글, 영문, 숫자, `/`, `·`만 남기고 20자에서 자른다. 공고 이름은 쓰지 않는다.
const cleanTypePart = (value) => String(value ?? '').replace(/[^가-힣A-Za-z0-9/·]/g, '').slice(0, 20);

// 원본 행의 유형 이름(`상위/세부`). 빈 값은 `-`로 적는다.
export function lhTypeLogLabel(row) {
  return `${cleanTypePart(row.UPP_AIS_TP_NM) || '-'}/${cleanTypePart(row.AIS_TP_CD_NM) || '-'}`;
}

// `lh_types` 로그 값. 건수가 많은 순(같으면 이름순)으로 최대 limit개를 `이름=건수`로 잇는다.
export function formatLhTypes(counts, limit = 30) {
  return [...counts]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, limit)
    .map(([label, count]) => `${label}=${count}`)
    .join(',');
}
