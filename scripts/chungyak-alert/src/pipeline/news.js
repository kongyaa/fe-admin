import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { AppError, normalizeDate, safeHttpUrl } from '../util.js';
import { blockKey } from './expected-window.js';

// data/news.yaml(손으로 관리하는 기사 목록)을 읽는다. 기사마다 지구(또는 서울 사업)와 블록(선택), 날짜, 우리가 쓴 한 줄 요약,
// 매체, 주소가 있다. 제목은 기사 제목이 아니라 요약이고, 사실은 기사에 적힌 것만 쓴다.
// 형식 오류는 newtowns.yaml처럼 AppError로 멈춘다(손으로 고치는 파일이라 PR 실행에서 드러나게).

// news.yaml 항목의 소식 구분. 비우면 뉴스. 공급 계획 보도처럼 일정을 알리는 기사는 일정으로 적을 수 있다.
export const NEWS_KINDS = ['뉴스', '일정'];

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SEOUL_ID = /^seoul-\d+$/;

const isEmpty = (value) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

function text(value) {
  if (isEmpty(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new AppError('news_field');
  return String(value).trim();
}

function flag(value) {
  if (isEmpty(value)) return false;
  if (typeof value !== 'boolean') throw new AppError('news_field');
  return value;
}

// 기사 날짜는 YYYY-MM-DD만 받는다(소식 목록은 일 단위로 줄을 세운다). Date로 읽혀도 받아 준다.
export function newsDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const raw = String(value ?? '').trim();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? normalizeDate(raw) : null;
  if (!day) throw new AppError('news_date');
  return day;
}

// news.yaml의 town 값 -> 사업 id. 서울 사업은 'seoul-1673'처럼 사업 id 그대로, 공공주택지구는 newtowns.yaml의 id('town-'를 붙인다).
export function newsProjectId(town) {
  return SEOUL_ID.test(town) ? town : `town-${town}`;
}

// 기사 한 건. 모르는 키는 무시한다.
export function newsEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('news_field');
  const town = text(raw.town);
  if (!town || !ID_PATTERN.test(town)) throw new AppError('news_field');
  const title = text(raw.title);
  const outlet = text(raw.outlet);
  if (!title || !outlet) throw new AppError('news_field');
  const url = safeHttpUrl(raw.url);
  if (!url) throw new AppError('news_url');
  const kind = text(raw.kind) ?? NEWS_KINDS[0];
  if (!NEWS_KINDS.includes(kind)) throw new AppError('news_field');
  return {
    town,
    projectId: newsProjectId(town),
    block: text(raw.block),
    date: newsDate(raw.date),
    title,
    outlet,
    url,
    local: flag(raw.local),
    rental: flag(raw.rental),
    kind,
  };
}

export function parseNews(source) {
  let doc;
  try {
    doc = parse(String(source ?? ''));
  } catch {
    throw new AppError('news_yaml');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new AppError('news_shape');
  if (!isEmpty(doc.items) && !Array.isArray(doc.items)) throw new AppError('news_shape');
  const items = (doc.items ?? []).map(newsEntry);
  const keys = new Set();
  for (const item of items) {
    const key = `${item.projectId}|${blockKey(item.block)}|${item.url}`;
    if (keys.has(key)) throw new AppError('news_duplicate');
    keys.add(key);
  }
  const asOf = isEmpty(doc.asOf) ? null : newsDate(doc.asOf);
  return { asOf, items };
}

// 사업에 있는 블록 이름: 블록별 현황(blocks), 없으면 yaml blocks·분양 이력·계획의 블록. blockKey로 비교한다.
function projectBlockNames(project) {
  const names = [
    ...(project.blocks ?? []).map((row) => row.block),
    ...(project.blockEntries ?? []).map((entry) => entry.block),
    ...(project.history ?? []).map((entry) => entry.block),
    ...(project.plans ?? []).flatMap((plan) => plan.blocks ?? []),
  ].filter(Boolean);
  return names;
}

// 'A9·A11' -> ['A9', 'A11'] (빈 칸은 뺀다)
export function splitBlocks(block) {
  return String(block ?? '').split('·').map((name) => name.trim()).filter(Boolean);
}

// 블록 이름을 그 지구의 화면 표기(블록별 현황 줄 이름)로 맞춘다. 없는 블록이면 null.
export function canonicalBlock(block, project) {
  const key = blockKey(block);
  if (!key) return null;
  return projectBlockNames(project).find((name) => blockKey(name) === key) ?? null;
}

/**
 * 기사를 사업에 잇는다(공고 연결·블록별 현황 뒤의 사업 목록).
 * - 공공주택지구 id가 사업 목록에 없으면 news_town으로 멈춘다(오타).
 * - 서울 사업 id가 없으면(서울 자료에서 사업이 빠짐) 그 기사만 건너뛰고 센다. 서울 자료는 우리가 고치는 파일이 아니라서다.
 * - 블록을 적었으면 그 지구의 블록(blocks·이력·계획)에 있어야 한다. 없거나 서울 사업이면 news_block.
 * 블록은 지구 화면의 표기로 바꾼다('A1' -> 'A-1').
 */
export function resolveNews(items, projects) {
  const byId = new Map(projects.map((project) => [project.id, project]));
  let skipped = 0;
  const resolved = items.flatMap((item) => {
    const project = byId.get(item.projectId);
    if (!project) {
      if (SEOUL_ID.test(item.projectId)) {
        skipped += 1;
        return [];
      }
      throw new AppError('news_town');
    }
    if (!item.block) return [{ ...item, block: null }];
    // 여러 블록 기사는 'A9·A11'처럼 '·'로 잇는다. 모든 블록이 그 지구에 있어야 한다.
    const parts = project.region === '서울' ? [null] : splitBlocks(item.block).map((name) => canonicalBlock(name, project));
    if (parts.length === 0 || parts.some((name) => !name)) throw new AppError('news_block');
    const block = parts.join('·');
    return [{ ...item, block }];
  });
  return { items: resolved, skipped };
}

// 파일이 없으면 null
export function loadNews(path, { exists = existsSync, read = (p) => readFileSync(p, 'utf8') } = {}) {
  if (!exists(path)) return null;
  return parseNews(read(path));
}
