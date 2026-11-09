import { strFromU8, unzipSync } from 'fflate';
import { AppError, fetchWithRetry } from '../util.js';

// 서울 열린데이터광장 "서울시 정비사업 추진현황" (OA-22856). 이용허락범위 제한 없음, 분기 갱신, 키 불필요.
export const DATASET_URL = 'https://data.seoul.go.kr/dataList/OA-22856/F/1/datasetView.do';
export const DOWNLOAD_URL = 'https://datafile.seoul.go.kr/bigfile/iot/inf/nio_download.do?&useCache=false';
const INF_ID = 'OA-22856';
const DEFAULT_TITLE = '서울시 정비사업 추진현황';

// 지도 단계 표시 순서. 일반분양은 원자료에 없고 공고 연결로만 알 수 있다.
export const SEOUL_STAGES = ['구역지정', '추진위', '조합설립', '건축심의', '사업시행인가', '관리처분인가', '이주', '착공', '일반분양'];

// 원자료의 사업추진단계 값 -> 지도 단계
const STAGE_MAP = {
  구역지정: '구역지정',
  추진위: '추진위',
  조합설립: '조합설립',
  건축심의: '건축심의',
  사업시행: '사업시행인가',
  관리처분: '관리처분인가',
  착공: '착공',
};

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(value) {
  return String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

// "(26년 6월기준)" 또는 시트 이름의 "`26.6월말 기준" -> "2026-06"
export function parseAsOf(text) {
  const value = String(text ?? '');
  const match = /(\d{2})\s*년\s*(\d{1,2})\s*월\s*기준/.exec(value) ?? /(\d{2})\s*\.\s*(\d{1,2})\s*월/.exec(value);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return `20${match[1]}-${String(month).padStart(2, '0')}`;
}

// 데이터셋 페이지의 파일 목록. 같은 파일이 <span>과 <a> 두 번 나오므로 번호로 합친다.
export function parseFileList(html) {
  const files = new Map();
  for (const [tag] of String(html ?? '').matchAll(/<(?:span|a)\b[^>]*>/gi)) {
    const seq = /downloadFile\(\s*'(\d+)'\s*\)/.exec(tag)?.[1];
    const title = /\btitle="([^"]*)"/i.exec(tag)?.[1];
    if (!seq || title === undefined || files.has(seq)) continue;
    const decoded = decodeXml(title).trim();
    files.set(seq, { seq, title: decoded, asOf: parseAsOf(decoded) });
  }
  return [...files.values()];
}

// 목록 순서에 기대지 않고 기준월이 가장 늦은 파일을 고른다. 같으면 먼저 나온 파일.
export function pickLatestFile(files) {
  let latest = null;
  for (const file of files) {
    if (file.asOf && (!latest || file.asOf > latest.asOf)) latest = file;
  }
  if (!latest) throw new AppError('seoul_listing');
  return latest;
}

export function sourceTitle(asOf) {
  if (!asOf) return DEFAULT_TITLE;
  return `${DEFAULT_TITLE} (${asOf.slice(2, 4)}년 ${Number(asOf.slice(5, 7))}월기준)`;
}

// 엑셀 날짜 일련번호 -> YYYY-MM-DD. 1900 윤년 버그 때문에 25569가 1970-01-01이다.
export function excelSerialToDate(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const serial = Math.floor(Number(text));
  // 1950-01-01(18264) ~ 2099-12-31(73050) 밖은 날짜가 아닌 값으로 본다.
  if (serial < 18264 || serial > 73050) return null;
  return new Date((serial - 25569) * 86400000).toISOString().slice(0, 10);
}

// "AB12" -> 27 (0부터)
export function columnIndex(ref) {
  const letters = /^([A-Z]+)/.exec(String(ref ?? ''))?.[1];
  if (!letters) return -1;
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

export function textRuns(xml) {
  // 윗주(<rPh>)는 읽기 표기라 빼고, 서식 런(<r>)으로 나뉜 <t>는 이어 붙인다.
  // 빈 <t/>를 먼저 맞춰야 여는 태그로 읽혀 다음 런까지 삼키지 않는다.
  const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  return [...body.matchAll(/<t(?:\s[^>]*?)?\/>|<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1] ?? '')).join('');
}

export function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...String(xml).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)].map((m) => textRuns(m[1] ?? ''));
}

// 시트의 행을 { 행번호: [열별 문자열] }로 읽는다. 값이 없는 셀은 빈 문자열이다.
export function parseSheet(xml, sharedStrings = []) {
  const rows = new Map();
  const sheet = String(xml ?? '');
  for (const rowMatch of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNumber = Number(/\br="(\d+)"/.exec(rowMatch[1])?.[1]);
    if (!rowNumber) continue;
    const cells = [];
    for (const cellMatch of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const col = columnIndex(/\br="([A-Z]+)\d+"/.exec(attrs)?.[1]);
      if (col < 0) continue;
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      const inner = cellMatch[2] ?? '';
      let value = '';
      if (type === 'inlineStr') {
        value = textRuns(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '');
      } else {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (raw !== undefined) value = type === 's' ? sharedStrings[Number(raw)] ?? '' : decodeXml(raw);
      }
      cells[col] = value;
    }
    rows.set(rowNumber, Array.from(cells, (value) => value ?? ''));
  }
  const merges = [...sheet.matchAll(/<mergeCell\b[^>]*\bref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/g)].map((m) => ({
    c1: columnIndex(m[1]),
    r1: Number(m[2]),
    c2: columnIndex(m[3]),
    r2: Number(m[4]),
  }));
  return { rows, merges };
}

// 첫 번째 시트의 경로와 이름. workbook.xml과 관계 파일로 찾고, 없으면 sheet1.xml을 쓴다.
function firstSheet(files) {
  const workbook = files['xl/workbook.xml'] ? strFromU8(files['xl/workbook.xml']) : '';
  const sheetTag = /<sheet\b[^>]*>/.exec(workbook)?.[0] ?? '';
  const name = decodeXml(/\bname="([^"]*)"/.exec(sheetTag)?.[1] ?? '');
  const relId = /\br:id="([^"]+)"/.exec(sheetTag)?.[1];
  const rels = files['xl/_rels/workbook.xml.rels'] ? strFromU8(files['xl/_rels/workbook.xml.rels']) : '';
  let path = 'xl/worksheets/sheet1.xml';
  if (relId) {
    for (const [tag] of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      if (/\bId="([^"]+)"/.exec(tag)?.[1] !== relId) continue;
      const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
      if (target) path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    }
  }
  return { name, path };
}

export function readXlsx(bytes) {
  let files;
  try {
    files = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  } catch {
    throw new AppError('seoul_xlsx');
  }
  const sheet = firstSheet(files);
  const sheetXml = files[sheet.path] ?? files['xl/worksheets/sheet1.xml'];
  if (!sheetXml) throw new AppError('seoul_xlsx');
  const sharedStrings = files['xl/sharedStrings.xml'] ? parseSharedStrings(strFromU8(files['xl/sharedStrings.xml'])) : [];
  return { sheetName: sheet.name, ...parseSheet(strFromU8(sheetXml), sharedStrings) };
}

// 열은 머리글 글자로 찾는다. 열이 밀리면 잘못 읽지 않고 seoul_header로 멈춘다.
// all: 머리글(1~4행, 병합 셀 채움, 공백 제거)에 모두 들어 있어야 하는 글자.
export const COLUMN_SPECS = {
  code: ['CODE'],
  district: ['자치구'],
  name: ['구역명'],
  address: ['위치1'],
  roadAddress: ['위치2'],
  operator: ['공공/민간'],
  zoneType: ['일반/재촉'],
  subKind: ['사업유형'],
  stage: ['사업추진단계'],
  existingHouseholds: ['기존가구수'],
  zoneFirst: ['구역지정', '최초'],
  zoneLast: ['구역지정', '변경'],
  committee: ['추진위원회'],
  union: ['조합설립인가'],
  review: ['건축심의'],
  implementFirst: ['사업시행인가', '최초'],
  implementLast: ['사업시행인가', '변경'],
  disposalFirst: ['관리처분', '최초'],
  disposalLast: ['관리처분', '변경'],
  moveStart: ['이주시작일'],
  moveEnd: ['이주종료일'],
  construction: ['착공'],
  totalHouseholds: ['건립세대수', '총합계'],
  saleHouseholds: ['건립세대수', '분양'],
  rentalHouseholds: ['건립세대수', '임대'],
};

export const HEADER_ROWS = 4;

export function headerLabels(rows, merges, headerRows = HEADER_ROWS) {
  const grid = [];
  for (let r = 1; r <= headerRows; r += 1) grid[r] = [...(rows.get(r) ?? [])];
  // 병합 셀은 왼쪽 위 값만 있으므로 병합 범위 전체에 채운다.
  for (const merge of merges) {
    if (merge.r1 > headerRows) continue;
    const value = grid[merge.r1]?.[merge.c1] ?? '';
    for (let r = merge.r1; r <= Math.min(merge.r2, headerRows); r += 1) {
      for (let c = merge.c1; c <= merge.c2; c += 1) grid[r][c] = value;
    }
  }
  const width = Math.max(0, ...grid.slice(1).map((row) => row.length));
  const labels = [];
  for (let c = 0; c < width; c += 1) {
    const parts = [];
    for (let r = 1; r <= headerRows; r += 1) {
      const text = String(grid[r][c] ?? '').replace(/\s+/g, '');
      if (text && !parts.includes(text)) parts.push(text);
    }
    labels.push(parts.join('|'));
  }
  return labels;
}

export function resolveColumns(labels, specs = COLUMN_SPECS) {
  const columns = {};
  for (const [field, needles] of Object.entries(specs)) {
    const found = labels.flatMap((label, index) => (needles.every((needle) => label.includes(needle)) ? [index] : []));
    if (found.length !== 1) throw new AppError('seoul_header');
    columns[field] = found[0];
  }
  return columns;
}

function cellText(row, index) {
  const text = String(row[index] ?? '').trim();
  return text === '' || text === '-' ? null : text;
}

function cellCount(row, index) {
  const text = cellText(row, index);
  if (text === null) return null;
  const number = Number(text.replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
}

export function kindOf(subKind) {
  if (/재개발/.test(subKind ?? '')) return '재개발';
  if (/재건축/.test(subKind ?? '')) return '재건축';
  return null;
}

// 이주시작일이 자료 기준월(asOf, 'YYYY-MM')의 말일까지인지. 기준월을 모르면 날짜만 있으면 시작으로 본다.
export function moveStarted(moveStart, asOf) {
  if (!moveStart) return false;
  if (!asOf) return true;
  return String(moveStart).slice(0, 7) <= asOf;
}

// 원자료 한 행 -> 지도 사업. 코드나 구역명이 없는 행(빈 행, 합계 행)은 null.
// 단계 값을 모르면 { skipped: 'stage' }를 돌려 호출하는 쪽이 센다.
export function normalizeSeoulRow(row, columns, { asOf = null, title = sourceTitle(asOf) } = {}) {
  const code = cellText(row, columns.code);
  const name = cellText(row, columns.name);
  if (!code || !/^\d+$/.test(code) || !name) return null;
  const rawStage = cellText(row, columns.stage);
  let stage = STAGE_MAP[rawStage] ?? null;
  const subKind = cellText(row, columns.subKind);
  const kind = kindOf(subKind);
  if (!stage || !kind) return { skipped: stage ? 'kind' : 'stage' };
  const date = (index) => excelSerialToDate(row[index]);
  const stageDates = {
    구역지정: date(columns.zoneFirst) ?? date(columns.zoneLast),
    추진위: date(columns.committee),
    조합설립: date(columns.union),
    건축심의: date(columns.review),
    사업시행인가: date(columns.implementFirst) ?? date(columns.implementLast),
    관리처분인가: date(columns.disposalFirst) ?? date(columns.disposalLast),
    이주: date(columns.moveStart),
    착공: date(columns.construction),
  };
  // 관리처분인가 뒤 이주가 시작됐으면 현재 단계를 이주로 본다. 이주시작일이 자료 기준월 뒤면 아직 예정이다.
  if (stage === '관리처분인가' && moveStarted(stageDates.이주, asOf)) stage = '이주';
  // 건립세대 총합계가 0이면 계획이 정해지지 않은 것으로 본다.
  const total = cellCount(row, columns.totalHouseholds);
  const planned = total !== null && total > 0;
  return {
    id: `seoul-${code}`,
    name,
    kind,
    subKind,
    region: '서울',
    district: cellText(row, columns.district),
    address: cellText(row, columns.address),
    roadAddress: cellText(row, columns.roadAddress),
    operator: cellText(row, columns.operator),
    stage,
    stageIndex: SEOUL_STAGES.indexOf(stage),
    stageDates: Object.fromEntries(Object.entries(stageDates).filter(([, value]) => value)),
    households: planned ? total : null,
    // 분양 세대에는 조합원분이 포함된다. 일반분양 세대는 원자료로 알 수 없다.
    saleHouseholds: planned ? cellCount(row, columns.saleHouseholds) : null,
    rentalHouseholds: planned ? cellCount(row, columns.rentalHouseholds) : null,
    generalSupply: null,
    notices: [],
    live: false,
    sources: [{ title, url: DATASET_URL }],
    asOf,
  };
}

export function parseSeoulWorkbook(bytes, { asOf: givenAsOf = null, fileName = '' } = {}) {
  const { sheetName, rows, merges } = readXlsx(bytes);
  const columns = resolveColumns(headerLabels(rows, merges));
  const asOf = givenAsOf ?? parseAsOf(sheetName) ?? parseAsOf(fileName);
  const title = sourceTitle(asOf);
  const projects = [];
  const skipped = {};
  const seen = new Set();
  for (const [rowNumber, row] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    if (rowNumber <= HEADER_ROWS) continue;
    const project = normalizeSeoulRow(row, columns, { asOf, title });
    if (!project) continue;
    if (project.skipped) {
      skipped[project.skipped] = (skipped[project.skipped] ?? 0) + 1;
      continue;
    }
    if (seen.has(project.id)) {
      skipped.duplicate = (skipped.duplicate ?? 0) + 1;
      continue;
    }
    seen.add(project.id);
    projects.push(project);
  }
  if (projects.length === 0) throw new AppError('seoul_empty');
  return { asOf, title, projects, skipped };
}

export async function fetchSeoulListing({ fetch, sleep }) {
  const response = await fetchWithRetry(fetch, DATASET_URL, {}, { kind: 'seoul', sleep });
  return pickLatestFile(parseFileList(await response.text()));
}

export async function downloadSeoulFile({ fetch, seq, sleep }) {
  const body = new URLSearchParams({ infId: INF_ID, seqNo: '', seq: String(seq), infSeq: '2' }).toString();
  const response = await fetchWithRetry(
    fetch,
    DOWNLOAD_URL,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
    { kind: 'seoul', sleep },
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  // xlsx는 zip이라 PK로 시작한다. 오류 페이지가 200으로 올 때를 거른다.
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new AppError('seoul_download');
  return bytes;
}

export async function collectSeoul({ fetch, sleep }) {
  const file = await fetchSeoulListing({ fetch, sleep });
  const bytes = await downloadSeoulFile({ fetch, seq: file.seq, sleep });
  return parseSeoulWorkbook(bytes, { asOf: file.asOf, fileName: file.title });
}
