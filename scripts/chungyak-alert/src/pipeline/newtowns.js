import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { AppError, normalizeDate, safeHttpUrl } from '../util.js';

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
  return { asOf: townDate(doc.asOf), towns };
}

// 지도 사업 형태. noticeMatch와 expected는 공고 연결·예상 시기 계산에만 쓰고 출력 전에 뺀다.
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
  };
}

// 파일이 없으면 null. 형식 오류는 AppError로 멈춘다(손으로 고치는 파일이라 PR 실행에서 드러나게).
export function loadNewtowns(path, { exists = existsSync, read = (p) => readFileSync(p, 'utf8') } = {}) {
  if (!exists(path)) return null;
  const { asOf, towns } = parseNewtowns(read(path));
  return { asOf, projects: towns.map((town) => townToProject(town, asOf)) };
}
