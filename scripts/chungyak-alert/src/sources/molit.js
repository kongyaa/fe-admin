import { AppError, defaultSleep, fetchWithRetry, normalizeDate, parseNumber, safeError } from '../util.js';

const URL_BASE = 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade';
const PRESALE_URL = 'https://apis.data.go.kr/1613000/RTMSDataSvcSilvTrade/getRTMSDataSvcSilvTrade';
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

function readDealDate(block) {
  const year = readTag(block, 'dealYear');
  const month = readTag(block, 'dealMonth');
  const day = readTag(block, 'dealDay');
  if (!year || !month || !day) return null;
  return normalizeDate(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
}

const MAX_TAG_NAMES = 80;
const MAX_TAG_NAMES_LENGTH = 800;

// 공개 로그용 진단이다. 값은 읽지 않고 항목의 태그 이름만 모은다. CDATA 안의 내용과 허용 문자 밖의 이름은 버린다.
export function collectTagNames(xml, names) {
  for (const [, block] of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const withoutCdata = block.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
    for (const [, name] of withoutCdata.matchAll(/<([A-Za-z0-9_]{1,40})>/g)) {
      if (names.size >= MAX_TAG_NAMES) return;
      names.add(name);
    }
  }
}

// 정렬해 이름 단위로 자른다. 잘리면 끝에 ...을 붙인다.
export function formatTagNames(names) {
  if (names.size === 0) return 'none';
  const sorted = [...names].sort();
  let text = '';
  for (const name of sorted) {
    const next = text ? `${text},${name}` : name;
    if (next.length > MAX_TAG_NAMES_LENGTH) return `${text},...`;
    text = next;
  }
  return text;
}

function parseItems(xml, isExcluded, extra) {
  const itemBlocks = [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  const rows = [];
  let cancelled = 0;
  let excluded = 0;
  for (const block of itemBlocks) {
    if (readTag(block, 'cdealType')) {
      cancelled += 1;
      continue;
    }
    if (isExcluded(block)) {
      excluded += 1;
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
      floor: parseNumber(readTag(block, 'floor')),
      dealingGbn: readTag(block, 'dealingGbn'),
      dealDate: readDealDate(block),
      jibun: readTag(block, 'jibun'),
      aptSeq: readTag(block, 'aptSeq'),
      landLease: readTag(block, 'landLeaseholdGbn') === 'Y',
      ...extra(block),
    });
  }
  return {
    resultCode: readTag(xml, 'resultCode'),
    totalCount: parseNumber(readTag(xml, 'totalCount')),
    itemCount: itemBlocks.length,
    cancelled,
    excluded,
    rows,
  };
}

// 태그명은 실응답으로 확인되지 않았다. 바뀌면 이 함수만 고친다.
export function parseMolitXml(xml) {
  return parseItems(xml, () => false, () => ({}));
}

const readOwnership = (block) => readTag(block, 'ownershipGbn') || readTag(block, '구분');

// 공개 화면에 응답 명세가 없어 구분 태그명은 추정이다. 값이 입주권이면 뺀다.
export function parsePresaleXml(xml) {
  return parseItems(
    xml,
    (block) => readOwnership(block).includes('입'),
    (block) => ({ presale: true, ownership: readOwnership(block) }),
  );
}

async function fetchPages({ fetch, key, lawdCode, dealYm, sleep, url, kind, retry = {}, parse, tagNames }) {
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
    const response = await fetchWithRetry(fetch, `${url}?${query}`, {}, { kind, sleep, ...retry });
    const body = await response.text();
    if (tagNames) collectTagNames(body, tagNames);
    const parsed = parse(body);
    if (!parsed.resultCode) throw new AppError(`${kind}_parse`);
    if (!/^0+$/.test(parsed.resultCode)) {
      throw new AppError(`${kind}_result_${parsed.resultCode.replace(/\W/g, '').slice(0, 10)}`);
    }
    // 태그명이 달라 전부 버려지면 표본 부족으로 조용히 넘어가지 않게 오류로 올린다.
    if (parsed.itemCount > parsed.cancelled + parsed.excluded && parsed.rows.length === 0) {
      throw new AppError(`${kind}_parse`);
    }
    rows.push(...parsed.rows);
    seen += parsed.itemCount;
    if (parsed.itemCount === 0 || seen >= (parsed.totalCount ?? 0)) return rows;
  }
  throw new AppError(`${kind}_page_limit`);
}

export function fetchMonth(options) {
  return fetchPages({ ...options, url: URL_BASE, kind: 'molit', parse: parseMolitXml });
}

export function fetchPresaleMonth(options) {
  return fetchPages({
    ...options,
    url: PRESALE_URL,
    kind: 'presale',
    retry: { retries: 1, timeoutMs: 10000 },
    parse: parsePresaleXml,
  });
}

// 새 태그가 실응답에 있는지 공개 로그의 건수만으로 확인하려고 빠진 값을 센다.
function tallyTags(stats, rows) {
  stats.rows += rows.length;
  for (const row of rows) {
    if (row.floor === null) stats.noFloor += 1;
    if (!row.dealDate) stats.noDate += 1;
    if (!row.dealingGbn) stats.noDealing += 1;
    if (!row.jibun) stats.noJibun += 1;
    if (!row.aptSeq) stats.noSeq += 1;
    if (row.presale && !row.ownership) stats.noOwnership += 1;
  }
}

const emptyStats = () => ({ rows: 0, noFloor: 0, noDate: 0, noDealing: 0, noJibun: 0, noSeq: 0, noOwnership: 0 });

export function createMolitClient({ fetch, key, sleep }) {
  const cache = new Map();
  const stats = emptyStats();
  const tagNames = new Set();
  // 응답 없는 API가 잡 제한 시간을 다 쓰지 않도록 첫 장애 뒤에는 호출하지 않는다.
  let outage = null;
  const month = (lawdCode, dealYm) => {
    if (outage) return Promise.reject(outage);
    const cacheKey = `${lawdCode}-${dealYm}`;
    if (!cache.has(cacheKey)) {
      cache.set(cacheKey, fetchMonth({ fetch, key, lawdCode, dealYm, sleep, tagNames }).then(
        (rows) => {
          tallyTags(stats, rows);
          return rows;
        },
        (error) => {
          if (error.kind === 'molit_timeout' || error.kind === 'molit_network') outage = error;
          throw error;
        },
      ));
    }
    return cache.get(cacheKey);
  };
  return {
    async getTrades(lawdCode, months) {
      const results = [];
      for (const dealYm of months) results.push(...(await month(lawdCode, dealYm)));
      return results;
    },
    stats: () => stats,
    tagNames: () => formatTagNames(tagNames),
  };
}

// 활용신청 승인 전이거나 실패해도 오류 메일로 보내지 않는다. 신뢰도만 낮추고 첫 실패 뒤에는 호출하지 않는다.
export function createPresaleClient({ fetch, key, sleep = defaultSleep, now = () => new Date(), budgetMs, onSoft = () => {} }) {
  const cache = new Map();
  const stats = emptyStats();
  const tagNames = new Set();
  let failed = false;
  let startedAt = null;
  const fail = (kind) => {
    if (!failed) {
      failed = true;
      onSoft(kind);
    }
    return { rows: [], ok: false };
  };
  return {
    async getTrades(lawdCode, months) {
      if (failed) return { rows: [], ok: false };
      startedAt ??= now().getTime();
      const rows = [];
      try {
        for (const dealYm of months) {
          const cacheKey = `${lawdCode}-${dealYm}`;
          if (!cache.has(cacheKey)) {
            if (now().getTime() - startedAt >= budgetMs) return fail('presale_budget');
            const monthRows = await fetchPresaleMonth({ fetch, key, lawdCode, dealYm, sleep, tagNames });
            tallyTags(stats, monthRows);
            cache.set(cacheKey, monthRows);
          }
          rows.push(...cache.get(cacheKey));
        }
      } catch (error) {
        return fail(safeError(error));
      }
      return { rows, ok: true };
    },
    stats: () => stats,
    tagNames: () => formatTagNames(tagNames),
  };
}
