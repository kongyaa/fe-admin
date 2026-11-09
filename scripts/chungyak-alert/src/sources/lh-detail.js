import { AppError, defaultSleep, fetchWithRetry, safeError } from '../util.js';

// LH 분양임대공고별 상세정보(접수처, 단지정보, 일정정보)와 공급정보(주택형, 필지, 상가호) 조회.
// 지금은 응답 구조를 배우는 읽기 전용 조사(probe)다. 결과는 저장, 알림, 판별 어디에도 쓰지 않고, 로그에는 필드 이름만 남긴다.
// 경로와 요청 변수는 공공데이터포털 화면에서 읽었고 실응답으로 확인하지 않았다.
// 키 이름은 명세대로 상세는 serviceKey, 공급은 ServiceKey다(공동주택 클라이언트도 API마다 명세의 이름을 쓴다).
export const LH_DETAIL_API = {
  kind: 'lh_detail',
  url: 'https://apis.data.go.kr/B552555/lhLeaseNoticeDtlInfo1/getLeaseNoticeDtlInfo1',
  keyParam: 'serviceKey',
};
export const LH_SUPPLY_API = {
  kind: 'lh_supply',
  url: 'https://apis.data.go.kr/B552555/lhLeaseNoticeSplInfo1/getLeaseNoticeSplInfo1',
  keyParam: 'ServiceKey',
};

// 필수 요청 값. AIS_TP_CD는 선택이라 값이 있을 때만 보낸다. 값은 목록 응답 행의 것(notice.lhCodes, src/sources/lh.js)이다.
const REQUIRED_CODES = ['SPL_INF_TP_CD', 'CCR_CNNT_SYS_DS_CD', 'PAN_ID', 'UPP_AIS_TP_CD'];
const present = (value) => value !== null && value !== undefined && String(value).trim() !== '';

// 요청 변수. 필수 값이 하나라도 없으면 null이다(호출하지 않는다).
export function lhDetailParams(codes, key, keyParam) {
  if (!codes || !REQUIRED_CODES.every((field) => present(codes[field]))) return null;
  const params = { [keyParam]: key };
  for (const field of REQUIRED_CODES) params[field] = String(codes[field]);
  if (present(codes.AIS_TP_CD)) params.AIS_TP_CD = String(codes.AIS_TP_CD);
  return params;
}

// 공개 로그에 남길 수 있는 이름. 영문자나 _로 시작하고 [A-Za-z0-9_]만 있는 40자 이하만 받는다.
// 숫자로 시작하거나 한글 등 다른 문자가 섞인 키는 값일 수 있어 통째로 버린다(글자만 지우면 값 일부가 남을 수 있다).
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
export const safeSchemaKey = (key) => (SAFE_KEY.test(String(key)) ? String(key) : null);

// 이름 없는 최상위 블록. `$` 같은 기호는 허용 문자가 아니라 쓰지 않는다.
const ROOT = '_root';

export const createSchema = () => ({ blocks: new Map(), dropped: 0 });

// 응답의 구조만 모은다. 블록은 배열이나 객체를 값으로 가진 키의 이름이고, 깊이와 위치가 달라도 이름이 같으면 합친다.
// rows는 그 블록에서 본 객체 수, fields는 문자열·숫자 등 단일 값을 가진 키 이름의 합집합이다. 값 자체는 읽지 않는다.
// 허용되지 않는 키는 건너뛰고(그 아래도 보지 않는다) dropped로 센다.
export function collectSchema(body, schema, name = ROOT) {
  if (Array.isArray(body)) {
    if (name !== ROOT) blockOf(schema, name);
    for (const item of body) collectSchema(item, schema, name);
    return schema;
  }
  if (!body || typeof body !== 'object') return schema;
  const block = blockOf(schema, name);
  block.rows += 1;
  for (const [key, value] of Object.entries(body)) {
    const safe = safeSchemaKey(key);
    if (!safe) {
      schema.dropped += 1;
      continue;
    }
    if (value && typeof value === 'object') collectSchema(value, schema, safe);
    else block.fields.add(safe);
  }
  return schema;
}

function blockOf(schema, name) {
  if (!schema.blocks.has(name)) schema.blocks.set(name, { rows: 0, fields: new Set() });
  return schema.blocks.get(name);
}

export const MAX_SCHEMA_LINE = 1500;

// 한 줄 로그. 블록과 필드는 이름순이다. 길면 이름 단위로 자르고 끝에 ...을 붙인다.
// 감싸기만 하는 최상위 블록(단일 값 필드 없음)은 적지 않는다.
export function formatSchemaLine(prefix, stats, schema, maxLength = MAX_SCHEMA_LINE) {
  const names = [...schema.blocks.keys()]
    .filter((name) => name !== ROOT || schema.blocks.get(name).fields.size > 0)
    .sort();
  const blocks = names.map((name) => `${name}:${schema.blocks.get(name).rows}`).join(',') || 'none';
  const fields = names
    .filter((name) => schema.blocks.get(name).fields.size > 0)
    .map((name) => `${name}[${[...schema.blocks.get(name).fields].sort().join(',')}]`)
    .join(',') || 'none';
  const line = `${prefix} calls=${stats.calls} ok=${stats.ok} no_codes=${stats.noCodes} capped=${stats.capped} stopped=${stats.stopped ?? 'none'} dropped_keys=${schema.dropped} blocks=${blocks} fields=${fields}`;
  if (line.length <= maxLength) return line;
  return `${line.slice(0, maxLength - 3).replace(/[A-Za-z0-9_]*$/, '')}...`;
}

// API 하나의 조사 클라이언트. 실행마다 하나다. 미승인이나 응답 형식 차이를 포함한 첫 실패는 오류 메일 없이 건수만 남기고(onSoft),
// 그 뒤에는 호출하지 않는다. limits.maxCalls에 닿으면 조용히 건너뛴다(조사 표본 상한이라 실패가 아니다).
function createProbe({ api, fetch, key, limits, sleep, onSoft }) {
  const schema = createSchema();
  const stats = { calls: 0, ok: 0, noCodes: 0, capped: 0, stopped: null };
  let failure = null;

  const stop = (kind) => {
    if (!failure) {
      failure = new AppError(kind);
      stats.stopped = kind;
      onSoft(kind);
    }
    throw failure;
  };

  async function request(codes) {
    if (failure) throw failure;
    const params = lhDetailParams(codes, key, api.keyParam);
    if (!params) {
      stats.noCodes += 1;
      return null;
    }
    if (stats.calls >= limits.maxCalls) {
      stats.capped += 1;
      return null;
    }
    stats.calls += 1;
    try {
      const response = await fetchWithRetry(
        fetch,
        `${api.url}?${new URLSearchParams(params)}`,
        {},
        { kind: api.kind, retries: 1, timeoutMs: limits.timeoutMs, sleep },
      );
      let body;
      try {
        body = await response.json();
      } catch (error) {
        throw new AppError(`${api.kind}_${error?.name === 'TimeoutError' ? 'timeout' : 'parse'}`);
      }
      collectSchema(body, schema);
      stats.ok += 1;
      return body;
    } catch (error) {
      return stop(safeError(error));
    }
  }

  return { request, line: (prefix) => formatSchemaLine(prefix, stats, schema), stats: () => ({ ...stats }) };
}

// 상세와 공급 조회. 두 API는 승인과 실패를 따로 본다.
export function createLhDetailClient({ fetch, key, limits, sleep = defaultSleep, onSoft = () => {} }) {
  const detail = createProbe({ api: LH_DETAIL_API, fetch, key, limits, sleep, onSoft });
  const supply = createProbe({ api: LH_SUPPLY_API, fetch, key, limits, sleep, onSoft });
  return {
    fetchLhDetail: (codes) => detail.request(codes),
    fetchLhSupply: (codes) => supply.request(codes),
    stats: () => ({ detail: detail.stats(), supply: supply.stats() }),
    // `lh_detail_schema ...`, `lh_supply_schema ...` 두 줄. 필드 이름과 건수만 있다.
    schemaLines: () => [detail.line('lh_detail_schema'), supply.line('lh_supply_schema')],
  };
}

// 공고마다 두 API를 한 번씩 부른다. 실패는 클라이언트가 이미 soft로 셌으므로 여기서는 삼킨다. 결과는 버린다.
export async function probeLhSchemas(notices, client) {
  for (const notice of notices) {
    for (const call of [client.fetchLhDetail, client.fetchLhSupply]) {
      try {
        await call(notice.lhCodes);
      } catch {
        // 첫 실패 뒤에는 호출하지 않는다.
      }
    }
  }
}
