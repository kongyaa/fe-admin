// LH 공고 중 분양이면서 대상 지역인 공고만 남긴다. 수집한 공고와 Notion에 저장된 행에 같은 규칙을 쓴다.
// 청약홈 공고는 보지 않는다. 규칙과 단어 목록은 config.json의 lh에 있다.
// LH 유형 값(UPP_AIS_TP_NM, AIS_TP_CD_NM)은 실응답으로 확인되지 않았다. 그래서 유형을 읽을 수 없으면 남긴다.

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

// 분양이 아니면 'type'을 돌려준다. 유형 값이 비어 있으면 이름의 제외 단어만 보고 남긴다.
export function lhTypeRule(item, lh) {
  const type = typeText(item);
  // 선택형, 분양전환, 매각은 유형이나 이름 어디에 있어도 뺀다.
  if (hasAny(type, lh.excludeKeywords) || hasAny(squash(item.name), lh.excludeKeywords)) return 'type';
  if (!type) return null;
  // 임대, 주거복지, 토지, 상가 등. 분양 단어보다 먼저 본다(`분양주택 분양전환`, `신혼희망타운 행복주택`).
  if (hasAny(type, lh.nonSaleTypes)) return 'type';
  if (hasAny(type, lh.saleTypes)) return null;
  return 'type';
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
