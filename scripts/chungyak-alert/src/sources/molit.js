import { AppError, fetchWithRetry, parseNumber } from '../util.js';

const URL_BASE = 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade';
const NUM_OF_ROWS = 1000;
const MAX_PAGES = 100;

function readTag(xml, name) {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  if (!match) return '';
  return match[1]
    .replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

// 태그명은 실응답으로 확인되지 않았다. 바뀌면 이 함수만 고친다.
export function parseMolitXml(xml) {
  const itemBlocks = [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  const rows = [];
  let cancelled = 0;
  for (const block of itemBlocks) {
    if (readTag(block, 'cdealType')) {
      cancelled += 1;
      continue;
    }
    const amount = parseNumber(readTag(block, 'dealAmount'));
    const area = parseNumber(readTag(block, 'excluUseAr'));
    if (!(amount > 0) || !(area > 0)) continue;
    rows.push({
      aptName: readTag(block, 'aptNm'),
      umd: readTag(block, 'umdNm'),
      buildYear: parseNumber(readTag(block, 'buildYear')),
      amount,
      area,
    });
  }
  return {
    resultCode: readTag(xml, 'resultCode'),
    totalCount: parseNumber(readTag(xml, 'totalCount')),
    itemCount: itemBlocks.length,
    cancelled,
    rows,
  };
}

export async function fetchMonth({ fetch, key, lawdCode, dealYm, sleep }) {
  const rows = [];
  let seen = 0;
  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo += 1) {
    const query = new URLSearchParams({
      serviceKey: key,
      LAWD_CD: lawdCode,
      DEAL_YMD: dealYm,
      numOfRows: String(NUM_OF_ROWS),
      pageNo: String(pageNo),
    });
    const response = await fetchWithRetry(fetch, `${URL_BASE}?${query}`, {}, { kind: 'molit', sleep });
    const parsed = parseMolitXml(await response.text());
    if (!parsed.resultCode) throw new AppError('molit_parse');
    if (!/^0+$/.test(parsed.resultCode)) {
      throw new AppError(`molit_result_${parsed.resultCode.replace(/\W/g, '').slice(0, 10)}`);
    }
    // 태그명이 달라 전부 버려지면 표본 부족으로 조용히 넘어가지 않게 오류로 올린다.
    if (parsed.itemCount > parsed.cancelled && parsed.rows.length === 0) {
      throw new AppError('molit_parse');
    }
    rows.push(...parsed.rows);
    seen += parsed.itemCount;
    if (parsed.itemCount === 0 || seen >= (parsed.totalCount ?? 0)) return rows;
  }
  throw new AppError('molit_page_limit');
}

export function createMolitClient({ fetch, key, sleep }) {
  const cache = new Map();
  // 응답 없는 API가 잡 제한 시간을 다 쓰지 않도록 첫 장애 뒤에는 호출하지 않는다.
  let outage = null;
  const month = (lawdCode, dealYm) => {
    if (outage) return Promise.reject(outage);
    const cacheKey = `${lawdCode}-${dealYm}`;
    if (!cache.has(cacheKey)) {
      cache.set(cacheKey, fetchMonth({ fetch, key, lawdCode, dealYm, sleep }).catch((error) => {
        if (error.kind === 'molit_timeout' || error.kind === 'molit_network') outage = error;
        throw error;
      }));
    }
    return cache.get(cacheKey);
  };
  return {
    async getTrades(lawdCode, months) {
      const results = [];
      for (const dealYm of months) results.push(...(await month(lawdCode, dealYm)));
      return results;
    },
  };
}
