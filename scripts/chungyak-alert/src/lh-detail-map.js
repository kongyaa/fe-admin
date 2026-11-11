import { lhTypeClass } from './lh-scope.js';
import { lhDetailParams } from './sources/lh-detail.js';
import { normalizeDate, withOverall } from './util.js';

// LH 상세(lhLeaseNoticeDtlInfo1)와 공급(lhLeaseNoticeSplInfo1) 응답을 공고의 일정, 주택형, 주소로 바꾼다.
// 블록과 필드 이름은 2026-11 dry-run의 구조 로그로 확인했고, 값의 형식은 확인하지 못했다. 그래서 파서는 여러 형식을 받고,
// 읽지 못한 값은 null로 두고 lh_parse_failed:<필드>로 센다. 읽지 못하면 그 부분만 예전 동작(목록 API 값)으로 둔다.
// 각 블록에는 이름 끝에 Nm이 붙은 짝 블록(dsSbdNm 등)이 있는데, 열 이름표로 보고 읽지 않는다. 블록은 이름이 정확히 같은 것만 읽는다.

const present = (value) => value !== null && value !== undefined && String(value).trim() !== '';

// 이름이 name인 블록의 행. 응답 어디에 있든 처음 찾은 것을 쓴다. 객체 하나면 행 하나로 본다. 없으면 빈 배열이다.
export function findBlock(body, name) {
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item);
        if (found) return found;
      }
      return null;
    }
    if (!node || typeof node !== 'object') return null;
    if (Object.hasOwn(node, name)) {
      const value = node[name];
      if (Array.isArray(value)) return value.filter((row) => row && typeof row === 'object' && !Array.isArray(row));
      if (value && typeof value === 'object') return [value];
    }
    for (const value of Object.values(node)) {
      const found = walk(value);
      if (found) return found;
    }
    return null;
  };
  return walk(body) ?? [];
}

// 날짜. YYYY.MM.DD, YYYY-MM-DD, YYYY/MM/DD, YYYY년 MM월 DD일(월·일은 한 자리도 받음), YYYYMMDD(뒤에 시각 HHMM, HHMMSS가 붙어도 됨).
const FULL_DATE = /(?<!\d)(\d{4})\s*(?:[.\-/]|년)\s*(\d{1,2})\s*(?:[.\-/]|월)\s*(\d{1,2})(?!\d)|(?<!\d)(\d{4})(\d{2})(\d{2})(?=(?:\d{4}|\d{6})?(?!\d))/g;
// 끝 날짜의 연도를 생략한 범위(2026.12.01 ~ 12.03). 앞 날짜 뒤에 시각이 있어도 된다. 범위 구분은 ~, -, –다.
const SHORT_END = /^\s*(?:\d{1,2}:\d{2}(?::\d{2})?\s*)?(?:~|-|–)\s*(\d{1,2})\s*(?:[.\-/]|월)\s*(\d{1,2})(?!\d)/;

const isoOf = (year, month, day) => normalizeDate(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);

// 날짜 하나나 범위를 {start, end}로 읽는다. 날짜 하나면 start와 end가 같다. 셋 이상이면 가장 이른 날과 늦은 날이다.
// 날짜가 없거나 달력에 없는 날짜가 섞이면 null이다. 시각은 버린다.
export function parseLhDateRange(value) {
  if (!present(value) || typeof value === 'object') return null;
  const text = String(value);
  const dates = [];
  let lastEnd = 0;
  for (const match of text.matchAll(FULL_DATE)) {
    const iso = match[1] ? isoOf(match[1], match[2], match[3]) : isoOf(match[4], match[5], match[6]);
    if (!iso) return null;
    dates.push(iso);
    lastEnd = match.index + match[0].length;
  }
  if (dates.length === 0) return null;
  if (dates.length === 1) {
    const short = SHORT_END.exec(text.slice(lastEnd));
    if (short) {
      const year = Number(dates[0].slice(0, 4));
      let end = isoOf(year, short[1], short[2]);
      if (!end) return null;
      if (end < dates[0]) end = isoOf(year + 1, short[1], short[2]);
      if (!end) return null;
      dates.push(end);
    }
  }
  const sorted = [...dates].sort();
  return { start: sorted[0], end: sorted.at(-1) };
}

// 숫자 하나. 쉼표와 공백을 지우고 끝의 단위(원, 만원, ㎡, m2, m², 세대, 호)를 떼고 읽는다. 단위도 돌려준다.
function readNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? { number: value, unit: '' } : null;
  if (!present(value) || typeof value === 'object') return null;
  const match = /^([+-]?\d+(?:\.\d+)?)(만원|원|㎡|m2|m²|세대|호)?$/.exec(String(value).replace(/[,\s]/g, ''));
  return match ? { number: Number(match[1]), unit: match[2] ?? '' } : null;
}

// 공급금액(SIL_AMT). 배치의 가격 단위는 만원이다(청약홈 LTTOT_TOP_AMOUNT, 국토부 거래금액과 같다).
// 단위가 적혀 있으면 따르고, 없으면 1,000만 이상은 원으로 보고 만원으로 바꾼다(가정: 1,000만 원 미만 분양가는 없다). 0 이하는 null이다.
export function parseLhPrice(value) {
  const read = readNumber(value);
  if (!read || !(read.number > 0) || !['', '원', '만원'].includes(read.unit)) return null;
  const won = read.unit === '원' || (read.unit === '' && read.number >= 1e7);
  return won ? Math.round(read.number / 10000) : read.number;
}

// 면적(RSDN_DDO_AR 주거전용, SPL_AR 공급). ㎡ 숫자다. 0 이하는 null이다.
export function parseLhArea(value) {
  const read = readNumber(value);
  if (!read || !(read.number > 0) || !['', '㎡', 'm2', 'm²'].includes(read.unit)) return null;
  return read.number;
}

// 세대수(SIL_HSH_CNT). 0 이상의 정수다.
export function parseLhCount(value) {
  const read = readNumber(value);
  if (!read || !Number.isInteger(read.number) || read.number < 0 || !['', '세대', '호'].includes(read.unit)) return null;
  return read.number;
}

// 값이 있는데 읽지 못하면 onFail(필드)를 부른다. 빈 값은 실패가 아니다.
function parseField(row, field, parser, onFail) {
  const value = row?.[field];
  if (!present(value)) return null;
  const parsed = parser(value);
  if (parsed === null) onFail(field);
  return parsed;
}

const squash = (value) => String(value ?? '').replace(/\s+/g, '');

// 공개 로그와 단계 이름에 쓰는 분류 이름. 한글, 숫자, `·`, 괄호, `/`, 공백만 남기고 20자에서 자른다.
export const cleanLhLabel = (value) => String(value ?? '').replace(/[^가-힣0-9·()/ ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);

// 청약 접수 대상(HS_SBSC_ACP_TRG_CD_NM)을 청약홈과 같은 앞부분을 가진 단계 이름으로 바꾼다. Notion의 특별공급 접수일, 1순위 접수일,
// 2순위 접수일 열이 이 앞부분으로 채워지고, 같은 앞부분이 여럿이면 가장 이른 시작일이 쓰인다(notion-store의 buildProperties).
// 1순위·2순위가 있으면 그 순위, 무순위·잔여·추가는 이름 그대로, 순위 없는 일반공급은 1순위, 그 밖의 이름(신혼부부, 다자녀, 생애최초 등 특별공급 유형)은 특별공급이다.
// 특별공급 유형 단어(LH_SPECIAL_WORDS)가 있는 일반공급(`신혼부부 일반공급`)은 그 유형만의 접수라 1순위가 아니라 특별공급이다.
// 이름은 버리지 않고 앞부분 뒤에 붙인다(`특별공급 신혼부부`). 이미 그 앞부분으로 시작하면 그대로 두고, 앞부분 단어가 이름 중간에 있으면
// 그 단어(괄호 포함)를 빼고 앞에 둔다(`일반공급 1순위` → `1순위 일반공급`). 이름이 없으면 `접수`다.
export function lhStageName(label) {
  const name = cleanLhLabel(label);
  if (!name) return '접수';
  const text = squash(name);
  const prefixed = (prefix) => {
    if (text.startsWith(prefix)) return name;
    const word = new RegExp(`\\(?${[...prefix].join('\\s*')}\\)?`, 'g');
    const rest = name.replace(word, ' ').replace(/\s+/g, ' ').trim();
    return rest ? `${prefix} ${rest}` : prefix;
  };
  if (text.includes('1순위')) return prefixed('1순위');
  if (text.includes('2순위')) return prefixed('2순위');
  // 무순위·잔여·추가 접수는 특별공급이 아니라 이름 그대로 단계로 둔다(Notion 순위 열에 넣지 않는다).
  if (['무순위', '잔여', '추가'].some((word) => text.includes(word))) return name;
  if (text.includes('일반') && !hasLhSpecialWord(text)) return prefixed('1순위');
  return prefixed('특별공급');
}

// 특별공급 유형을 가리키는 단어. 이 단어가 있는 단계는 일반공급 1순위가 아니다(src/recommend.js의 LH 1순위 추천도 쓴다).
export const LH_SPECIAL_WORDS = ['신생아', '신혼', '생애최초', '다자녀', '노부모', '한부모', '기관추천', '청년'];
export const hasLhSpecialWord = (value) => LH_SPECIAL_WORDS.some((word) => squash(value).includes(word));

// 공급 일정(dsSplScdl) → 단계와 당첨자 발표일. 단계는 접수 기간(ACP_DTTM)이 있는 행마다 하나이고 시작일 순이다.
// 당첨자 발표일은 행마다의 PZWR_ANC_DT 중 가장 늦은 날이다.
export function mapLhSchedule(rows, onFail = () => {}) {
  const stages = [];
  const winners = [];
  for (const row of rows ?? []) {
    const range = parseField(row, 'ACP_DTTM', parseLhDateRange, onFail);
    if (range) stages.push({ name: lhStageName(row.HS_SBSC_ACP_TRG_CD_NM), start: range.start, end: range.end });
    const winner = parseField(row, 'PZWR_ANC_DT', parseLhDateRange, onFail);
    if (winner) winners.push(winner.start);
  }
  stages.sort((a, b) => a.start.localeCompare(b.start));
  return { stages, winnerDate: winners.sort().at(-1) ?? null };
}

// 단지 정보(dsSbd)의 첫 단지. 주소는 소재지(LCT_ARA_ADR)와 상세(LCT_ARA_DTL_ADR)를 잇는다. 주소가 없으면 null이다.
export function mapLhComplex(rows) {
  const row = (rows ?? []).find((item) => present(item.LCT_ARA_ADR));
  if (!row) return null;
  const address = [row.LCT_ARA_ADR, row.LCT_ARA_DTL_ADR].filter(present).map((part) => String(part).trim()).join(' ');
  return { name: present(row.BZDT_NM) ? String(row.BZDT_NM).trim() : null, address };
}

// 판별에 쓸 수 있는 주택형(면적과 가격이 있음)이 하나라도 있는지.
export const hasLhModels = (models) => Array.isArray(models) && models.some((model) => model.area > 0 && model.price > 0);

// 같은 주택형의 행을 하나로 합친다. 가격은 가장 높은 값(청약홈 LTTOT_TOP_AMOUNT처럼 최고 분양가)이고, 면적은 그 행의 값이다.
// 세대수는 더한다. 하나라도 모르면 합계도 모른다(null).
function mergeModels(items) {
  const priceOf = (item) => (item.price > 0 ? item.price : -Infinity);
  const top = items.reduce((best, item) => (priceOf(item) > priceOf(best) ? item : best));
  const known = items.every((item) => Number.isFinite(item.households));
  return {
    houseType: top.houseType,
    area: top.area,
    supplyArea: top.supplyArea,
    price: top.price,
    households: known ? items.reduce((sum, item) => sum + item.households, 0) : null,
    specials: { 신생아: null, 신혼부부: null, 생애최초: null },
  };
}

// 공급 정보(dsList01) → 청약홈 주택형과 같은 모양(src/sources/applyhome.js의 normalizeModel).
// 공고에 단지가 여럿이면(BZDT_NM이 둘 이상) 주소를 읽은 첫 단지의 주택형만 쓴다. 그 단지 이름과 맞는 행이 없으면 모두 쓴다.
// 주택형(HTY_NM, 공백 무시)마다 하나로 합친다(mergeModels). 주택형 이름이 없으면 전용면적 값으로 묶는다. merged는 합쳐서 줄어든 행 수다.
// 특별공급 유형별 세대수는 자료에 없어 null이다(LH는 추천을 계산하지 않는다).
export function mapLhModels(rows, complexName = null, onFail = () => {}) {
  const list = rows ?? [];
  const names = new Set(list.map((row) => squash(row.BZDT_NM)).filter(Boolean));
  const own = complexName && names.size > 1 ? list.filter((row) => squash(row.BZDT_NM) === squash(complexName)) : [];
  const selected = own.length > 0 ? own : list;
  const groups = new Map();
  for (const row of selected) {
    const key = squash(row.HTY_NM) || `area:${squash(row.RSDN_DDO_AR)}`;
    const model = {
      houseType: present(row.HTY_NM) ? String(row.HTY_NM).trim() : '',
      area: parseField(row, 'RSDN_DDO_AR', parseLhArea, onFail),
      supplyArea: parseField(row, 'SPL_AR', parseLhArea, onFail),
      price: parseField(row, 'SIL_AMT', parseLhPrice, onFail),
      households: parseField(row, 'SIL_HSH_CNT', parseLhCount, onFail),
    };
    if (groups.has(key)) groups.get(key).push(model);
    else groups.set(key, [model]);
  }
  return { models: [...groups.values()].map(mergeModels), merged: selected.length - groups.size };
}

// 공고에 상세·공급 응답을 덮는다. 응답이 없거나 읽지 못한 부분은 목록 API 값(예전 동작)을 둔다.
// - 단계: 일정을 하나라도 읽으면 바꾸고 전체 시작·종료일을 단계의 가장 이른 날과 늦은 날로 다시 계산한다.
// - 당첨자 발표일, 주소: 읽었을 때만 바꾼다.
// - 주택형: 판별에 쓸 수 있는 주택형이 있고 단지 주소도 읽었을 때만 models에 둔다(src/lotto.js가 읽는다). 주소가 없어
//   붙이지 않으면 lhModelsUnattached를 켠다(판별 근거 `LH 단지 주소 미매핑`). Notion에는 쓰지 않는다.
// - 분양가상한제: 분양 유형(lhTypeClass가 sale)인 LH 공공분양은 분양가상한제 대상으로 보고 flags.priceCap을 켠다.
export function applyLhDetail(notice, { detail = null, supply = null }, { lh = {}, onFail = () => {} } = {}) {
  const schedule = detail ? mapLhSchedule(findBlock(detail, 'dsSplScdl'), onFail) : { stages: [], winnerDate: null };
  const complex = detail ? mapLhComplex(findBlock(detail, 'dsSbd')) : null;
  const mapped = supply ? mapLhModels(findBlock(supply, 'dsList01'), complex?.name, onFail) : { models: null, merged: 0 };
  const scheduleParsed = schedule.stages.length > 0;
  const modelsParsed = hasLhModels(mapped.models);
  const modelsAttached = modelsParsed && Boolean(complex);
  const next = {
    ...notice,
    address: complex?.address || notice.address,
    winnerDate: schedule.winnerDate ?? notice.winnerDate ?? null,
    stages: scheduleParsed ? schedule.stages : notice.stages,
    flags: { ...notice.flags, priceCap: lhTypeClass(notice, lh) === 'sale' },
  };
  // 상세 일정을 읽었으면 시작일은 접수 시작일이다. 목록의 공고일~마감일 대체가 아니다.
  if (scheduleParsed) delete next.windowFromList;
  if (modelsAttached) next.models = mapped.models;
  else if (modelsParsed) next.lhModelsUnattached = true;
  return { notice: withOverall(next), scheduleParsed, modelsParsed, modelsAttached, merged: mapped.merged };
}

// 공개 로그용 값 모양. 숫자는 9, 한글 음절은 가, 영문자는 a로 바꾸고 ASCII 문장부호와 공백(하나로 줄임), ㎡, ·은 둔다.
// 그 밖의 글자는 *이다. 40자에서 자른다. JSON 숫자는 앞에 N을 붙이고, 빈 문자열은 EMPTY, null은 NULL이다.
// 대문자는 모양에 나오지 않아 이 표시와 섞이지 않는다.
export function valueShape(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return `N${maskText(String(value))}`.slice(0, 40);
  if (typeof value !== 'string') return 'OTHER';
  if (value === '') return 'EMPTY';
  return maskText(value).slice(0, 40);
}

function maskText(text) {
  return [...text.replace(/\s+/g, ' ')].map((char) => {
    if (/[0-9]/.test(char)) return '9';
    if (/[가-힣]/.test(char)) return '가';
    if (/[A-Za-z]/.test(char)) return 'a';
    if (/[ !-/:-@[-`{-~㎡·]/.test(char)) return char;
    return '*';
  }).join('');
}

// 모양을 남길 필드와 그 블록. 접수 대상 이름(HS_SBSC_ACP_TRG_CD_NM)은 모양이 아니라 정리한 이름을 남긴다.
export const SHAPE_FIELDS = [
  ['ACP_DTTM', 'detail', 'dsSplScdl'],
  ['PZWR_ANC_DT', 'detail', 'dsSplScdl'],
  ['CTRT_ST_DT', 'detail', 'dsSplScdl'],
  ['SIL_AMT', 'supply', 'dsList01'],
  ['RSDN_DDO_AR', 'supply', 'dsList01'],
  ['SPL_AR', 'supply', 'dsList01'],
  ['MVIN_XPC_YM', 'detail', 'dsSbd'],
];
const LABEL_FIELD = 'HS_SBSC_ACP_TRG_CD_NM';
const SHAPES_PER_FIELD = 5;
const LABELS_MAX = 20;
export const MAX_SHAPE_LINE = 2000;

// labelWords는 로그에 그대로 남겨도 되는 접수 대상 단어(config.json의 lh.labelLogWords)다.
export const createShapeLog = (labelWords = []) => ({
  shapes: new Map(SHAPE_FIELDS.map(([field]) => [field, new Map()])),
  labels: new Map(),
  labelWords: new Set(labelWords),
});

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

// 공개 로그용 접수 대상 이름. 정리한 이름(cleanLhLabel)을 공백, 괄호, `/`, `·`로 나눈 단어가 모두 허용 단어일 때만 남긴다.
// 그 밖에는 값(단지명, 주소, 금액)이 섞였을 수 있어 `(기타)`로 센다. 빈 이름은 `-`다.
export function shapeLabel(value, labelWords = new Set()) {
  const label = cleanLhLabel(value);
  if (!label) return '-';
  const words = label.split(/[\s()/·]+/).filter(Boolean);
  return words.length > 0 && words.every((word) => labelWords.has(word)) ? label : '(기타)';
}

// 응답 하나의 값 모양과 접수 대상 이름을 센다. 없는 필드는 세지 않는다.
export function collectValueShapes({ detail = null, supply = null }, log) {
  const bodies = { detail, supply };
  for (const [field, source, block] of SHAPE_FIELDS) {
    if (!bodies[source]) continue;
    for (const row of findBlock(bodies[source], block)) {
      if (Object.hasOwn(row, field)) bump(log.shapes.get(field), valueShape(row[field]));
    }
  }
  if (detail) {
    for (const row of findBlock(detail, 'dsSplScdl')) {
      if (Object.hasOwn(row, LABEL_FIELD)) bump(log.labels, shapeLabel(row[LABEL_FIELD], log.labelWords));
    }
  }
  return log;
}

const topEntries = (map, limit) => [...map]
  .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
  .slice(0, limit)
  .map(([key, count]) => `[${key}]x${count}`)
  .join(',') || 'none';

// `lh_value_shapes FIELD=[모양]x건수,... HS_SBSC_ACP_TRG_CD_NM=[이름]x건수,...` 한 줄. 필드마다 많은 순 5개, 이름은 20개.
export function formatShapeLine(log, maxLength = MAX_SHAPE_LINE) {
  const parts = SHAPE_FIELDS.map(([field]) => `${field}=${topEntries(log.shapes.get(field), SHAPES_PER_FIELD)}`);
  parts.push(`${LABEL_FIELD}=${topEntries(log.labels, LABELS_MAX)}`);
  const line = `lh_value_shapes ${parts.join(' ')}`;
  return line.length <= maxLength ? line : `${line.slice(0, maxLength - 3)}...`;
}

// 클라이언트 호출 결과. 응답, 상한(null), 실패(던짐)를 가른다. 실패는 클라이언트가 soft로 이미 셌다.
async function callProbe(call, codes) {
  try {
    const body = await call(codes);
    return body ? { body } : { capped: true };
  } catch {
    return { failed: true };
  }
}

// 범위 안 LH 공고(isTarget)마다 상세와 공급을 부르고 덮는다. 상한이 고르게 걸리도록 고유 키 순서로 부르고, 결과는 원래 순서로 돌려준다.
// 공고의 lhDetailState는 조회 상태다: ok, failed(상세 실패), capped(상한), supply_failed(공급 실패), no_codes(요청 코드 없음).
// 상세가 실패하거나 상한이면 공급은 부르지 않는다(단지 주소가 없어 주택형을 판별에 쓰지 못한다). 그 공고는 예전 동작이다.
// 건수: lh_detail_ok(상세 응답), lh_schedule_parsed(단계를 바꿈), lh_models_parsed(주택형을 붙임), lh_models_unattached(읽었지만
// 단지 주소가 없어 붙이지 않음), lh_model_rows_merged(같은 주택형이라 합친 행), lh_detail_capped, lh_supply_capped(상한으로 못 부른 공고).
export async function enrichLhNotices(notices, { client, isTarget, lh, onSoft = () => {}, shapes = createShapeLog(lh?.labelLogWords) }) {
  const counts = {
    lh_detail_ok: 0,
    lh_schedule_parsed: 0,
    lh_models_parsed: 0,
    lh_models_unattached: 0,
    lh_model_rows_merged: 0,
    lh_detail_capped: 0,
    lh_supply_capped: 0,
  };
  const targets = notices.filter(isTarget).sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const replaced = new Map();
  for (const notice of targets) {
    const done = (state, next = notice) => replaced.set(notice.key, { ...next, lhDetailState: state });
    if (!lhDetailParams(notice.lhCodes, '', 'key')) {
      done('no_codes');
      continue;
    }
    const detail = await callProbe(client.fetchLhDetail, notice.lhCodes);
    if (detail.failed) {
      done('failed');
      continue;
    }
    if (detail.capped) {
      counts.lh_detail_capped += 1;
      done('capped');
      continue;
    }
    counts.lh_detail_ok += 1;
    const supply = await callProbe(client.fetchLhSupply, notice.lhCodes);
    if (supply.capped) counts.lh_supply_capped += 1;
    collectValueShapes({ detail: detail.body, supply: supply.body ?? null }, shapes);
    const applied = applyLhDetail(notice, { detail: detail.body, supply: supply.body ?? null }, { lh, onFail: (field) => onSoft(`lh_parse_failed:${field}`) });
    if (applied.scheduleParsed) counts.lh_schedule_parsed += 1;
    if (applied.modelsAttached) counts.lh_models_parsed += 1;
    else if (applied.modelsParsed) counts.lh_models_unattached += 1;
    counts.lh_model_rows_merged += applied.merged;
    done(supply.failed ? 'supply_failed' : supply.capped ? 'capped' : 'ok', applied.notice);
  }
  return { notices: notices.map((notice) => replaced.get(notice.key) ?? notice), counts, shapes };
}
