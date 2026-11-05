import { parseWalkMinutes } from '../market-estimate.js';
import { AppError, defaultSleep, fetchWithRetry, parseNumber, safeError } from '../util.js';

// data.go.kr 15057332, 15058453 페이지의 스웨거에서 확인한 경로다. 상세 정보만 키 이름이 ServiceKey다.
const LIST_URL = 'https://apis.data.go.kr/1613000/AptListService4/getSigunguAptList4';
const DETAIL_URL = 'https://apis.data.go.kr/1613000/AptBasisInfoServiceV5/getAphusDtlInfoV5';
const NUM_OF_ROWS = 1000;
const MAX_PAGES = 20;

// 공공데이터포털 공통 코드의 데이터 없음. 스웨거에는 00만 적혀 있다. 그 단지나 시군구만 값이 없는 것이므로 멈추지 않는다.
const isNoData = (code) => /^0*3$/.test(String(code));

// 스웨거는 header, body를 최상위로 적었지만 다른 data.go.kr 응답처럼 response로 감쌀 수 있어 둘 다 받는다.
function readRoot(body, kind) {
  const root = body?.response ?? body;
  const code = root?.header?.resultCode;
  if (code === undefined || code === null || code === '') throw new AppError(`${kind}_parse`);
  if (isNoData(code)) return { ...root, noData: true };
  if (!/^0+$/.test(String(code))) throw new AppError(`${kind}_result_${String(code).replace(/\W/g, '').slice(0, 10)}`);
  return root;
}

function readItems(root) {
  const raw = root.body?.items;
  const list = raw?.item ?? raw;
  if (Array.isArray(list)) return list;
  return list && typeof list === 'object' ? [list] : [];
}

// 공동주택 조회 클라이언트. 실행마다 하나다. 미승인이나 응답 형식 차이를 포함한 모든 실패는 오류 메일 없이
// 건수만 남기고, 첫 실패 뒤에는 호출하지 않는다. 데이터 없음은 실패가 아니라 그 대상의 값이 없는 것이다. 결과는 같은 실행의 반복 호출을 줄이려고 메모리에 둔다.
export function createAptInfoClient({ fetch, key, limits, sleep = defaultSleep, now = () => new Date(), onSoft = () => {} }) {
  const directories = new Map();
  const stations = new Map();
  const tags = { listRows: 0, listNoCode: 0, listNoDong: 0, listNoTotal: 0, details: 0, noItem: 0, noData: 0, noField: 0, emptyWalk: 0, badWalk: 0 };
  const bands = new Map();
  let calls = 0;
  let failure = null;
  let startedAt = null;

  const stop = (kind) => {
    if (!failure) {
      failure = new AppError(kind);
      onSoft(kind);
    }
    throw failure;
  };

  async function requestJson(url, params, kind) {
    if (failure) throw failure;
    if (calls >= limits.maxCallsPerRun) stop('apt_call_cap');
    startedAt ??= now().getTime();
    if (now().getTime() - startedAt >= limits.budgetMs) stop('apt_budget');
    calls += 1;
    try {
      const response = await fetchWithRetry(
        fetch,
        `${url}?${new URLSearchParams(params)}`,
        {},
        { kind, retries: 1, timeoutMs: limits.timeoutMs, sleep },
      );
      let body;
      try {
        body = await response.json();
      } catch (error) {
        throw new AppError(`${kind}_${error?.name === 'TimeoutError' ? 'timeout' : 'parse'}`);
      }
      return readRoot(body, kind);
    } catch (error) {
      return stop(safeError(error));
    }
  }

  async function fetchDirectory(sigunguCode) {
    const entries = [];
    let seen = 0;
    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo += 1) {
      const root = await requestJson(LIST_URL, {
        serviceKey: key,
        sigunguCode,
        pageNo: String(pageNo),
        numOfRows: String(NUM_OF_ROWS),
      }, 'aptlist');
      if (root.noData) {
        tags.noData += 1;
        return entries;
      }
      const items = readItems(root);
      const usable = items.filter((item) => item?.kaptCode && item?.kaptName);
      tags.listRows += items.length;
      tags.listNoCode += items.length - usable.length;
      tags.listNoDong += usable.filter((item) => !item.as3).length;
      // 태그명이 달라 전부 버려지면 단지명 불일치로 조용히 넘어가지 않게 드러낸다.
      if (items.length > 0 && usable.length === 0) stop('aptlist_parse');
      entries.push(...usable.map((item) => ({ code: String(item.kaptCode), name: item.kaptName, dong: item.as3 ?? '', ri: item.as4 ?? '' })));
      seen += items.length;
      // 서버가 numOfRows를 더 작게 제한할 수 있어 받은 건수로 판단한다. 전체 건수가 없으면 빈 페이지까지 읽는다.
      const total = parseNumber(root.body?.totalCount);
      if (total === null) tags.listNoTotal += 1;
      if (items.length === 0 || (total !== null && seen >= total)) return entries;
    }
    return stop('aptlist_page_limit');
  }

  async function fetchStation(kaptCode) {
    const root = await requestJson(DETAIL_URL, { ServiceKey: key, kaptCode }, 'aptinfo');
    const item = root.body?.item;
    tags.details += 1;
    if (root.noData) {
      tags.noData += 1;
      return null;
    }
    if (!item || typeof item !== 'object') {
      tags.noItem += 1;
      return null;
    }
    if (!Object.hasOwn(item, 'kaptdWtimesub')) {
      tags.noField += 1;
      return null;
    }
    const band = String(item.kaptdWtimesub ?? '').trim();
    if (!band) {
      tags.emptyWalk += 1;
      return null;
    }
    const walkMinutes = parseWalkMinutes(band);
    if (walkMinutes === null) {
      tags.badWalk += 1;
      return null;
    }
    // 읽을 수 있는 구간 값만 로그에 남긴다. 숫자와 분, 이내 같은 표현뿐이고 단지 정보는 없다.
    const bandKey = band.replace(/\s+/g, '');
    bands.set(bandKey, (bands.get(bandKey) ?? 0) + 1);
    return { walkMinutes, walkBand: band };
  }

  const once = (memo, cacheKey, task) => {
    if (!memo.has(cacheKey)) memo.set(cacheKey, task());
    return memo.get(cacheKey);
  };

  return {
    getDirectory: (sigunguCode) => once(directories, sigunguCode, () => fetchDirectory(sigunguCode)),
    getStation: (kaptCode) => once(stations, kaptCode, () => fetchStation(kaptCode)),
    stats: () => ({ calls }),
    tags: () => tags,
    bandCounts: () => [...bands].map(([band, count]) => `${band}:${count}`).join(',') || 'none',
  };
}
