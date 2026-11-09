import { AppError, addDays, fetchWithRetry, normalizeDate, normalizeRegion, withOverall } from '../util.js';

// 경로와 응답 구조는 실응답으로 확인되지 않았다. 구조가 다르면 lh_parse로 실패한다.
const URL_BASE = 'https://apis.data.go.kr/B552555/lhLeaseNoticeInfo1/lhLeaseNoticeInfo1';
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

export function extractRows(body) {
  const walk = (node) => {
    if (Array.isArray(node)) {
      if (node.some((item) => item && typeof item === 'object' && 'PAN_NM' in item)) return node;
      for (const item of node) {
        const found = walk(item);
        if (found) return found;
      }
      return null;
    }
    if (node && typeof node === 'object') {
      if (Array.isArray(node.dsList)) return node.dsList;
      for (const value of Object.values(node)) {
        const found = walk(value);
        if (found) return found;
      }
    }
    return null;
  };
  const rows = walk(body);
  if (!rows) throw new AppError('lh_parse');
  return rows;
}

export function extractPanId(row) {
  if (row.PAN_ID) return String(row.PAN_ID);
  let url = String(row.DTL_URL ?? '');
  try {
    url = decodeURIComponent(url);
  } catch {
    // 인코딩이 깨진 URL은 원문에서 찾는다.
  }
  return /(?:PAN_ID|panId)["']?\s*[:=]\s*["']?([\w-]+)/.exec(url)?.[1] ?? null;
}

// keepKeywords(토지임대부 등)가 유형이나 이름에 있으면 excludeKeywords(토지, 상가)로 빼지 않는다.
export function normalizeLh(row, excludeKeywords, keepKeywords = []) {
  const type = `${row.UPP_AIS_TP_NM ?? ''} ${row.AIS_TP_CD_NM ?? ''}`;
  const squashed = `${type} ${row.PAN_NM ?? ''}`.replace(/\s+/g, '');
  const keep = keepKeywords.some((word) => word && squashed.includes(word.replace(/\s+/g, '')));
  if (!keep && excludeKeywords.some((word) => type.includes(word))) return null;
  const panId = extractPanId(row);
  if (!panId) return null;
  const start = normalizeDate(row.PAN_NT_ST_DT ?? row.PAN_DT);
  const end = normalizeDate(row.CLSG_DT);
  return withOverall({
    key: `LH-${panId}`,
    source: 'LH',
    kind: 'lh',
    typeLabel: [row.UPP_AIS_TP_NM, row.AIS_TP_CD_NM].filter(Boolean).join(' ') || 'LH',
    name: row.PAN_NM ?? '',
    region: normalizeRegion(row.CNP_CD_NM),
    address: row.CNP_CD_NM ?? '',
    announceDate: start,
    winnerDate: null,
    url: row.DTL_URL ?? null,
    noticeStatus: row.PAN_SS ?? null,
    flags: {},
    // 날짜가 없으면 단계를 만들지 않아 알림 대상에서 빠진다.
    stages: start && end ? [{ name: '공고~마감', start, end }] : [],
  });
}

// onRow는 거르기 전의 원본 행마다 불린다. 유형 값 건수 로그(lh_types)에 쓴다.
export async function collectLh({ fetch, key, today, lookbackDays, lookaheadDays, excludeKeywords, keepKeywords = [], sleep, onRow = () => {} }) {
  const dotted = (date) => date.replace(/-/g, '.');
  const notices = [];
  let seen = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      ServiceKey: key,
      PG_SZ: String(PAGE_SIZE),
      PAGE: String(page),
      PAN_NT_ST_DT: dotted(addDays(today, -lookbackDays)),
      CLSG_DT: dotted(addDays(today, lookaheadDays)),
    });
    const response = await fetchWithRetry(fetch, `${URL_BASE}?${query}`, {}, { kind: 'lh', sleep });
    let body;
    try {
      body = await response.json();
    } catch {
      throw new AppError('lh_parse');
    }
    const rows = extractRows(body);
    for (const row of rows) {
      onRow(row);
      const notice = normalizeLh(row, excludeKeywords, keepKeywords);
      if (notice) notices.push(notice);
    }
    seen += rows.length;
    const total = Number(rows[0]?.ALL_CNT);
    if (rows.length === 0 || !(total > seen)) return notices;
  }
  throw new AppError('lh_page_limit');
}
