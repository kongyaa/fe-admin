// 임대 공고를 가린다. 수집한 공고와 Notion에 저장된 행에 같은 규칙을 쓴다.
// 소스의 유형 값을 먼저 보고, 유형으로 정할 수 없을 때만 공고 이름을 본다. 분양 유형은 이름에 임대 단어가 있어도 남긴다.

// 청약홈 분양 유형(src/sources/applyhome.js의 라벨). 이 유형은 이름을 보지 않는다.
const APPLYHOME_SALE_LABELS = new Set([
  'APT', '무순위', '불법행위 재공급', '임의공급', '민간사전청약', '신혼희망타운', '도시형생활주택', '오피스텔', '생활숙박시설',
]);
// LH 등에서 분양을 뜻하는 유형 단어. 임대 단어가 없고 이 단어가 있으면 이름을 보지 않고 남긴다.
const SALE_TYPE_WORDS = ['분양주택', '공공분양', '민간분양', '신혼희망타운'];

// 임대로 본 근거를 돌려준다. 임대가 아니거나 기능이 꺼져 있으면 null이다.
// item은 { kind, typeLabel, name }이다. 저장된 행에는 kind가 없어 유형 값으로 정한다.
export function rentalRule(item, config) {
  if (!config.excludeRental) return null;
  const keywords = config.rentalKeywords ?? [];
  const label = String(item.typeLabel ?? '').trim();
  // 청약홈 공공지원민간임대 엔드포인트
  if (item.kind === 'pblrent') return 'kind';
  // LH 상위 유형(UPP_AIS_TP_NM)이 임대주택인 공고. typeLabel은 '상위 유형 세부 유형'이다.
  if (label.startsWith('임대주택')) return 'lh_upper_type';
  // 유형 값에 임대 단어가 있다(국민임대, 행복주택, 민간임대, 공공지원민간임대, 분양전환 등).
  if (keywords.some((word) => label.includes(word))) return 'type_keyword';
  if (APPLYHOME_SALE_LABELS.has(label)) return null;
  if (SALE_TYPE_WORDS.some((word) => label.includes(word))) return null;
  // 유형으로 정할 수 없을 때만 이름을 본다.
  if (keywords.some((word) => String(item.name ?? '').includes(word))) return 'name_keyword';
  return null;
}

export const isRental = (item, config) => rentalRule(item, config) !== null;
