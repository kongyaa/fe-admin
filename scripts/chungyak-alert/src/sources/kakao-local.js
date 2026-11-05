import { haversineMeters } from '../market-estimate.js';
import { AppError, defaultSleep, fetchWithRetry, parseNumber, safeError } from '../util.js';

const BASE_URL = 'https://dapi.kakao.com/v2/local/search';

const toCoord = (document) => {
  const x = parseNumber(document?.x);
  const y = parseNumber(document?.y);
  return x === null || y === null ? null : { x, y };
};

// 공고 주소의 꼬리 표현은 주소 검색이 찾지 못하게 만든다.
export function cleanAddress(address) {
  return String(address ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/외\s*\d+\s*필지/g, ' ')
    // 일원동 같은 동 이름은 지우지 않는다.
    .replace(/(일원|일대|번지)(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 호출 수와 시간을 제한하는 실행당 클라이언트. 운영 정책상 결과는 저장할 수 없으므로 이 객체의 메모리에만 두고,
// 같은 실행의 반복 조회만 줄인다. 첫 장애나 상한 도달 뒤에는 호출하지 않는다.
export function createKakaoLocalClient({ fetch, key, location, sleep = defaultSleep, now = () => new Date(), onError = () => {}, onSoft = () => {} }) {
  const memo = new Map();
  let calls = 0;
  let failure = null;
  let startedAt = null;
  let lastCall = 0;

  const stop = (kind, report) => {
    if (!failure) {
      failure = new AppError(kind);
      report(kind);
    }
    throw failure;
  };

  async function request(path, params) {
    if (failure) throw failure;
    if (!key) stop('kakao_local_key_missing', onError);
    if (calls >= location.maxCallsPerRun) stop('kakao_local_call_cap', onSoft);
    startedAt ??= now().getTime();
    if (now().getTime() - startedAt >= location.budgetMs) stop('kakao_local_budget', onSoft);
    const wait = lastCall + location.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    calls += 1;
    let response;
    try {
      response = await fetchWithRetry(
        fetch,
        `${BASE_URL}/${path}.json?${new URLSearchParams(params)}`,
        { headers: { Authorization: `KakaoAK ${key}` } },
        // 쿼터 초과는 잠시 기다려도 풀리지 않으므로 429도 재시도하지 않고 위치 장애로 본다.
        { kind: 'kakao_local', retries: 0, timeoutMs: location.timeoutMs, sleep },
      );
    } catch (error) {
      // 검색어 하나의 문제다. 다른 조회는 계속한다.
      if (error.kind === 'kakao_local_http_400') return [];
      stop(safeError(error), onError);
    }
    let body;
    try {
      body = await response.json();
    } catch {
      stop('kakao_local_parse', onError);
    }
    if (!Array.isArray(body?.documents)) stop('kakao_local_parse', onError);
    return body.documents;
  }

  const once = (cacheKey, task) => {
    if (!memo.has(cacheKey)) memo.set(cacheKey, task());
    return memo.get(cacheKey);
  };

  const searchAddress = (query) => once(`address:${query}`, async () => {
    const documents = await request('address', { query, size: '1' });
    return toCoord(documents[0]);
  });

  return {
    // 공고 단지 좌표. 주소로 못 찾으면 단지명으로 찾되, 같은 시군구의 결과만 받는다.
    async locateSubject({ address, name, areaText }) {
      const query = cleanAddress(address);
      const byAddress = query ? await searchAddress(query) : null;
      if (byAddress) return byAddress;
      const area = String(areaText ?? '').trim().split(/\s+/).at(-1);
      if (!name || !area) return null;
      return once(`keyword:${area} ${name}`, async () => {
        const documents = await request('keyword', { query: `${area} ${name}`, size: '5' });
        return toCoord(documents.find((document) => String(document.address_name ?? '').includes(area)));
      });
    },

    locateComplex: searchAddress,

    // 가장 가까운 지하철역까지의 직선거리(m). 반경 안에 역이 없으면 null이다.
    nearestStation(coord) {
      return once(`station:${coord.x},${coord.y}`, async () => {
        const documents = await request('category', {
          category_group_code: 'SW8',
          x: String(coord.x),
          y: String(coord.y),
          radius: String(location.stationRadiusM),
          sort: 'distance',
          size: '1',
        });
        const nearest = documents[0];
        if (!nearest) return null;
        const distance = parseNumber(nearest.distance);
        if (distance !== null) return distance;
        const stationCoord = toCoord(nearest);
        if (!stationCoord) stop('kakao_local_parse', onError);
        return haversineMeters(coord, stationCoord);
      });
    },

    stats: () => ({ calls }),
  };
}
