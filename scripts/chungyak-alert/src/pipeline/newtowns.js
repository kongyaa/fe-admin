import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { AppError, normalizeDate, safeHttpUrl } from '../util.js';
import { BLOCK_STATUSES, UNDECIDED } from './blocks.js';
import {
  PRE_SUBSCRIPTION, blockKey, onOrAfter, planRange,
} from './expected-window.js';

// data/newtowns.yaml(직접 관리하는 공공주택지구 목록)을 읽어 지도 사업 형태로 바꾼다.
export const TOWN_STAGES = ['후보지', '지구지정', '지구계획승인', '부지조성 착공', '블록별 분양', '준공'];

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const isEmpty = (value) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

function text(value) {
  if (isEmpty(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new AppError('newtowns_field');
  return String(value).trim();
}

// YAML 날짜는 YYYY-MM 또는 YYYY-MM-DD 문자열로 둔다. Date로 읽혀도 받아 준다.
export function townDate(value) {
  if (isEmpty(value)) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const raw = String(value).trim();
  const month = /^(\d{4})-(\d{2})$/.exec(raw);
  if (month) {
    const number = Number(month[2]);
    if (number >= 1 && number <= 12) return raw;
    throw new AppError('newtowns_date');
  }
  const day = normalizeDate(raw);
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return day;
  throw new AppError('newtowns_date');
}

function count(value) {
  if (isEmpty(value)) return null;
  const number = Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(number) || number < 0) throw new AppError('newtowns_field');
  return number > 0 ? number : null;
}

function list(value) {
  if (isEmpty(value)) return [];
  if (!Array.isArray(value)) throw new AppError('newtowns_field');
  return value;
}

// 블록 항목의 출처: 객체 하나 또는 목록. http(s) 주소가 하나도 없으면 newtowns_source로 멈춘다.
function entrySources(value) {
  const raw = Array.isArray(value) ? value : isEmpty(value) ? [] : [value];
  const sources = raw.flatMap((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new AppError('newtowns_field');
    const url = safeHttpUrl(source.url);
    if (!url) return [];
    const outlet = text(source.outlet);
    return [{ title: text(source.title) ?? url, url, date: townDate(source.date), ...(outlet ? { outlet } : {}) }];
  });
  if (sources.length === 0) throw new AppError('newtowns_source');
  return sources;
}

function flag(value) {
  if (isEmpty(value)) return false;
  if (typeof value !== 'boolean') throw new AppError('newtowns_field');
  return value;
}

function entryObject(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new AppError('newtowns_field');
  return entry;
}

function requiredDate(value) {
  const date = townDate(value);
  if (!date) throw new AppError('newtowns_field');
  return date;
}

// 분양 이력의 구분. 비우면 본청약(블록 입주자모집공고). 사전청약은 이력에만 보이고 계획·최근 분양에는 쓰지 않는다.
export const HISTORY_STAGES = ['본청약', PRE_SUBSCRIPTION];

// 이력의 접수 마감일(선택). 일까지 있는 YYYY-MM-DD만 받고(아니면 newtowns_date), 공고일보다 앞이면 newtowns_field.
function receiptEnd(value, noticeDate) {
  const end = townDate(value);
  if (!end) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new AppError('newtowns_date');
  if (onOrAfter(end, noticeDate) === false) throw new AppError('newtowns_field');
  return end;
}

// 경쟁률 비율(양수). 쉼표 문자열도 받는다. 형식이 틀리면 newtowns_field.
function ratio(value) {
  if (isEmpty(value)) return null;
  const number = Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(number) || number <= 0) throw new AppError('newtowns_field');
  return number;
}

/**
 * 보도로 확인한 경쟁률(선택, 본청약 분양 이력에만). 청약홈 경쟁률 API에 자료가 없을 때만 지도에 쓴다.
 * { rate, applicants, households, scope, source: { title, url, date } }
 * - rate가 없으면 applicants/households로 계산한다. 둘 다 없으면 newtowns_field.
 * - rate는 출처가 말한 범위(scope)의 경쟁률이다. 예전 이름 rank1Rate는 1순위로 읽힐 수 있어 받지 않는다(newtowns_field).
 * - scope는 출처가 말한 범위(예: 일반공급). 출처가 1순위라고 하지 않았으면 1순위라고 적지 않는다.
 * - source(http(s) 주소)가 없으면 newtowns_source. 사전청약·임대 이력에 적으면 newtowns_field.
 */
export function competitionEntry(raw) {
  if (isEmpty(raw)) return null;
  const entry = entryObject(raw);
  if ('rank1Rate' in entry) throw new AppError('newtowns_field');
  const applicants = count(entry.applicants);
  const households = count(entry.households);
  let rate = ratio(entry.rate);
  if (rate === null && applicants !== null && households !== null) rate = Math.round((applicants / households) * 100) / 100;
  if (rate === null) throw new AppError('newtowns_field');
  return {
    rate, applicants, households, scope: text(entry.scope), source: entrySources(entry.source)[0],
  };
}

// 분양 이력 한 건(사전청약·본청약). end는 접수 마감일(선택, 블록 상태 '접수 중'에 쓴다). 모르는 키는 무시한다.
// competition(보도된 경쟁률)은 본청약 분양 이력에만 적는다.
function noticeEntry(raw) {
  const entry = entryObject(raw);
  const block = text(entry.block);
  if (!block) throw new AppError('newtowns_field');
  const stage = text(entry.stage) ?? HISTORY_STAGES[0];
  if (!HISTORY_STAGES.includes(stage)) throw new AppError('newtowns_field');
  const moveIn = townDate(entry.moveIn);
  const noticeDate = requiredDate(entry.noticeDate);
  const rental = flag(entry.rental);
  const competition = competitionEntry(entry.competition);
  if (competition && (rental || stage !== HISTORY_STAGES[0])) throw new AppError('newtowns_field');
  return {
    block,
    stage,
    type: text(entry.type),
    title: text(entry.title),
    households: count(entry.households),
    noticeDate,
    end: receiptEnd(entry.end, noticeDate),
    ...(moveIn ? { moveIn } : {}),
    rental,
    note: text(entry.note),
    sources: entrySources(entry.source),
    ...(competition ? { competition } : {}),
  };
}

// 세대 수: 숫자 하나 또는 블록별 { A9: 244, A11: 511 }. 블록별이면 모두 알 때만 합계를 낸다.
function planHouseholds(value) {
  if (isEmpty(value) || typeof value !== 'object') return { households: count(value), householdsByBlock: null };
  if (Array.isArray(value)) throw new AppError('newtowns_field');
  const byBlock = Object.fromEntries(Object.entries(value).map(([block, n]) => [block, count(n)]));
  const numbers = Object.values(byBlock);
  const known = numbers.length > 0 && numbers.every((n) => n !== null);
  return { households: known ? numbers.reduce((sum, n) => sum + n, 0) : null, householdsByBlock: byBlock };
}

// 보도된 다음 블록 계획 한 건. expected는 YYYY-MM, YYYY-상반기, YYYY-하반기. from·to(달 범위)를 붙인다.
function planEntry(raw) {
  const entry = entryObject(raw);
  const blocks = (typeof entry.blocks === 'string' ? [entry.blocks] : list(entry.blocks)).map(text).filter(Boolean);
  if (blocks.length === 0) throw new AppError('newtowns_field');
  const expected = text(entry.expected);
  if (!expected) throw new AppError('newtowns_field');
  const range = planRange(expected);
  if (!range) throw new AppError('newtowns_date');
  return {
    blocks,
    type: text(entry.type),
    ...planHouseholds(entry.households),
    expected,
    ...range,
    rental: flag(entry.rental),
    note: text(entry.note),
    sources: entrySources(entry.source),
  };
}

// 블록 한 건(사업승인·착공 같은 블록 단위 사실). status는 BLOCK_STATUSES 중 하나(비우면 미정), statusDate는 그 상태를 확인한 날
// (사업승인일 등을 모르면 출처 보도일). 출처(sources, source도 받음)는 http(s) 주소가 하나 이상 있어야 한다.
function blockEntry(raw) {
  const entry = entryObject(raw);
  const block = text(entry.block);
  if (!block) throw new AppError('newtowns_field');
  const status = text(entry.status) ?? UNDECIDED;
  if (!BLOCK_STATUSES.includes(status)) throw new AppError('newtowns_field');
  return {
    block,
    type: text(entry.type),
    households: count(entry.households),
    rental: flag(entry.rental),
    status,
    statusDate: townDate(entry.statusDate),
    note: text(entry.note),
    sources: entrySources(entry.sources ?? entry.source),
  };
}

// 같은 블록(blockKey)의 분양 줄이나 임대 줄이 두 번 적히면 멈춘다(화면 줄이 겹침)
function uniqueBlocks(entries) {
  const keys = new Set();
  for (const entry of entries) {
    const key = `${blockKey(entry.block)}|${entry.rental}`;
    if (keys.has(key)) throw new AppError('newtowns_duplicate');
    keys.add(key);
  }
  return entries;
}

// 지구 전체 블록 수(선택): { total, approved, date, source }. total은 양의 정수, approved는 total 이하의 정수.
function blockTotalEntry(raw) {
  if (isEmpty(raw)) return null;
  const entry = entryObject(raw);
  const total = count(entry.total);
  const approved = count(entry.approved);
  if (!Number.isInteger(total) || (approved !== null && (!Number.isInteger(approved) || approved > total))) {
    throw new AppError('newtowns_field');
  }
  return { total, approved, date: townDate(entry.date), sources: entrySources(entry.sources ?? entry.source) };
}

const byNoticeDate =(a, b) => a.noticeDate.localeCompare(b.noticeDate) || a.block.localeCompare(b.block);
const byPlanRange = (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.blocks[0].localeCompare(b.blocks[0]);

// '하남' -> '하남시'. 이미 시·군·구로 끝나면 그대로 둔다.
export function townDistrict(value) {
  const name = text(value);
  if (!name) return null;
  return /[시군구]$/.test(name) ? name : `${name}시`;
}

export function validateTown(town) {
  if (!town || typeof town !== 'object' || Array.isArray(town)) throw new AppError('newtowns_shape');
  const id = text(town.id);
  const name = text(town.name);
  if (!id || !ID_PATTERN.test(id) || !name) throw new AppError('newtowns_field');
  const stage = text(town.stage);
  if (!TOWN_STAGES.includes(stage)) throw new AppError('newtowns_stage');
  const stageDates = {};
  const rawDates = town.stageDates ?? {};
  if (typeof rawDates !== 'object' || Array.isArray(rawDates)) throw new AppError('newtowns_field');
  for (const [key, value] of Object.entries(rawDates)) {
    if (!TOWN_STAGES.includes(key)) throw new AppError('newtowns_stage');
    const date = townDate(value);
    if (date) stageDates[key] = date;
  }
  let expected = null;
  if (!isEmpty(town.expected)) {
    if (typeof town.expected !== 'object') throw new AppError('newtowns_field');
    const from = townDate(town.expected.from);
    const to = townDate(town.expected.to);
    if (from && to) {
      if (from.slice(0, 7) > to.slice(0, 7)) throw new AppError('newtowns_date');
      expected = { from: from.slice(0, 7), to: to.slice(0, 7), basis: text(town.expected.basis) };
    }
  }
  // 예전 키 preSubscriptions는 history의 stage: 사전청약으로 옮겼다. 조용히 빠지지 않게 멈춘다.
  if (!isEmpty(town.preSubscriptions)) throw new AppError('newtowns_field');
  const sources = list(town.sources).flatMap((source) => {
    const url = safeHttpUrl(source?.url);
    if (!url) return [];
    return [{ title: text(source.title) ?? url, url, date: townDate(source.date) }];
  });
  return {
    id,
    name,
    region: text(town.region) ?? '경기',
    district: townDistrict(town.district),
    kind: text(town.kind) ?? '공공주택지구',
    stage,
    stageDates,
    households: count(town.households),
    noticeMatch: list(town.noticeMatch).map(text).filter(Boolean),
    expected,
    notes: text(town.notes),
    sources,
    history: list(town.history).map(noticeEntry).sort(byNoticeDate),
    plans: list(town.plans).map(planEntry).sort(byPlanRange),
    blocks: uniqueBlocks(list(town.blocks).map(blockEntry)),
    blockTotal: blockTotalEntry(town.blockTotal),
  };
}

// 지역 현황 칸에 보이는 지구 목록(watchlist)의 구분. 화면이 이 값으로 칸을 묶는다.
export const WATCH_KINDS = ['3기 신도시', '공공주택지구'];

// watchlist 한 건: { name, kind, region, town }. town은 위 towns의 id(추적 중)이고, 비우면 아직 추적하지 않는 지구다.
// 추적하지 않는 지구에는 이름·구분·지역 말고는 아무 사실도 싣지 않는다(화면은 '아직 추적하지 않음').
// towns에 없는 town id는 newtowns_watchlist로 멈춘다.
export function watchEntry(raw, townIds) {
  const entry = entryObject(raw);
  const name = text(entry.name);
  const kind = text(entry.kind);
  if (!name || !WATCH_KINDS.includes(kind)) throw new AppError('newtowns_field');
  const town = text(entry.town);
  if (town && !townIds.has(town)) throw new AppError('newtowns_watchlist');
  return {
    name, kind, region: text(entry.region) ?? '경기', tracked: Boolean(town), projectId: town ? `town-${town}` : null,
  };
}

export function parseNewtowns(source) {
  let doc;
  try {
    doc = parse(String(source ?? ''));
  } catch {
    throw new AppError('newtowns_yaml');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new AppError('newtowns_shape');
  const towns = list(doc.towns).map(validateTown);
  const ids = new Set();
  for (const town of towns) {
    if (ids.has(town.id)) throw new AppError('newtowns_duplicate');
    ids.add(town.id);
  }
  const watchlist = list(doc.watchlist).map((entry) => watchEntry(entry, ids));
  if (new Set(watchlist.map((entry) => entry.name)).size !== watchlist.length) throw new AppError('newtowns_duplicate');
  return { asOf: townDate(doc.asOf), towns, watchlist };
}

// 지도 사업 형태. noticeMatch, expected, plans는 공고 연결·예상 시기 계산에만 쓰고 출력 전에 뺀다.
// history(분양 이력, 날짜순)는 build-map의 toPublic이 출력 형태로 줄여 내보낸다.
// blockEntries(yaml blocks)와 blockTotal은 build-map이 공고 연결 뒤 블록별 현황(blocks, blockSummary, blockTotal)으로 바꾼다.
export function townToProject(town, asOf) {
  return {
    id: `town-${town.id}`,
    name: town.name,
    kind: '공공주택지구',
    subKind: town.kind,
    region: town.region,
    district: town.district,
    address: null,
    roadAddress: null,
    operator: '공공',
    stage: town.stage,
    stageIndex: TOWN_STAGES.indexOf(town.stage),
    stageDates: town.stageDates,
    households: town.households,
    saleHouseholds: null,
    rentalHouseholds: null,
    generalSupply: null,
    notes: town.notes,
    notices: [],
    live: false,
    sources: town.sources.map(({ title, url, date }) => ({ title, url, date })),
    asOf,
    noticeMatch: town.noticeMatch,
    expected: town.expected,
    history: town.history ?? [],
    plans: town.plans ?? [],
    blockEntries: town.blocks ?? [],
    blockTotal: town.blockTotal ?? null,
  };
}

// 파일이 없으면 null. 형식 오류는 AppError로 멈춘다(손으로 고치는 파일이라 PR 실행에서 드러나게).
export function loadNewtowns(path, { exists = existsSync, read = (p) => readFileSync(p, 'utf8') } = {}) {
  if (!exists(path)) return null;
  const { asOf, towns, watchlist } = parseNewtowns(read(path));
  return { asOf, projects: towns.map((town) => townToProject(town, asOf)), watchlist };
}
