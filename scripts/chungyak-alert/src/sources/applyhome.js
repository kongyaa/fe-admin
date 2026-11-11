import {
  AppError,
  addDays,
  fetchWithRetry,
  normalizeDate,
  normalizeRegion,
  parseNumber,
  safeError,
  withOverall,
} from '../util.js';

const BASE_URL = 'https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1';
export const PER_PAGE = 500;
const MAX_PAGES = 200;

// 스웨거에 값의 접두어가 명시되어 있지 않다. odcloud 관례를 따른 값으로 실연동 때 확인한다.
const authorizationHeader = (key) => `Infuser ${key}`;

// 모집공고일 조건 형식은 스웨거의 엔드포인트별 설명을 따른다.
export const ENDPOINTS = [
  { op: 'getAPTLttotPblancDetail', mdlOp: 'getAPTLttotPblancMdl', kind: 'apt', dateFormat: 'dash' },
  { op: 'getRemndrLttotPblancDetail', mdlOp: 'getRemndrLttotPblancMdl', kind: 'remainder', dateFormat: 'dash' },
  { op: 'getOPTLttotPblancDetail', mdlOp: 'getOPTLttotPblancMdl', kind: 'arbitrary', dateFormat: 'compact' },
  { op: 'getUrbtyOfctlLttotPblancDetail', mdlOp: 'getUrbtyOfctlLttotPblancMdl', kind: 'urbty', dateFormat: 'dash' },
  { op: 'getPblPvtRentLttotPblancDetail', mdlOp: 'getPblPvtRentLttotPblancMdl', kind: 'pblrent', dateFormat: 'compact' },
];

const HOUSE_LABELS = {
  '01': 'APT',
  '04': '무순위',
  '06': '불법행위 재공급',
  '09': '민간사전청약',
  10: '신혼희망타운',
  '0201': '도시형생활주택',
  '0202': '오피스텔',
  '0203': '민간임대',
  '0204': '생활숙박시설',
  '0303': '공공지원민간임대',
};

const APT_STAGES = [
  ['특별공급', 'SPSPLY_RCEPT_BGNDE', 'SPSPLY_RCEPT_ENDDE'],
  ['1순위 해당', 'GNRL_RNK1_CRSPAREA_RCPTDE', 'GNRL_RNK1_CRSPAREA_ENDDE'],
  ['1순위 경기', 'GNRL_RNK1_ETC_GG_RCPTDE', 'GNRL_RNK1_ETC_GG_ENDDE'],
  ['1순위 기타', 'GNRL_RNK1_ETC_AREA_RCPTDE', 'GNRL_RNK1_ETC_AREA_ENDDE'],
  ['2순위 해당', 'GNRL_RNK2_CRSPAREA_RCPTDE', 'GNRL_RNK2_CRSPAREA_ENDDE'],
  ['2순위 경기', 'GNRL_RNK2_ETC_GG_RCPTDE', 'GNRL_RNK2_ETC_GG_ENDDE'],
  ['2순위 기타', 'GNRL_RNK2_ETC_AREA_RCPTDE', 'GNRL_RNK2_ETC_AREA_ENDDE'],
];

function stage(name, row, startField, endField) {
  const start = normalizeDate(row[startField]);
  return start ? { name, start, end: normalizeDate(row[endField]) } : null;
}

function buildStages(kind, row) {
  if (kind === 'apt') {
    const stages = APT_STAGES.map(([name, start, end]) => stage(name, row, start, end)).filter(Boolean);
    if (stages.length > 0) return stages;
    const overall = stage('접수', row, 'RCEPT_BGNDE', 'RCEPT_ENDDE');
    return overall ? [overall] : [];
  }
  const names = { remainder: row.HOUSE_SECD === '06' ? '재공급 접수' : '무순위 접수', arbitrary: '임의 접수' };
  const main = stage(names[kind] ?? '접수', row, 'SUBSCRPT_RCEPT_BGNDE', 'SUBSCRPT_RCEPT_ENDDE');
  const details = [
    stage('특별공급', row, 'SPSPLY_RCEPT_BGNDE', 'SPSPLY_RCEPT_ENDDE'),
    stage('일반공급', row, 'GNRL_RCEPT_BGNDE', 'GNRL_RCEPT_ENDDE'),
  ].filter((item) => item && !(main && item.start === main.start && item.end === main.end));
  return [main, ...details].filter(Boolean);
}

// 민영·국민 구분. 스웨거상 APT 상세의 HOUSE_DTL_SECD(주택상세구분코드)와 HOUSE_DTL_SECD_NM(코드명)이다.
// 스웨거에는 코드 값이 없다. 이름에 '민영'·'국민'이 있으면 그것을 쓰고, 이름이 없으면 01=민영, 03=국민으로 본다(가정).
// 그 밖의 값이나 필드가 없으면 null(모름)이고, 모르면 예치금으로 막지 않는다.
export function supplySector(row) {
  const name = String(row.HOUSE_DTL_SECD_NM ?? '');
  if (name.includes('민영')) return '민영';
  if (name.includes('국민')) return '국민';
  if (name.trim() !== '') return null;
  const code = String(row.HOUSE_DTL_SECD ?? '').trim();
  if (code === '01') return '민영';
  if (code === '03') return '국민';
  return null;
}

export function normalizeDetail(endpoint, row) {
  if (!row.HOUSE_MANAGE_NO || !row.PBLANC_NO) return null;
  const secd = String(row.SEARCH_HOUSE_SECD ?? row.HOUSE_SECD ?? '');
  const typeLabel = endpoint.kind === 'arbitrary'
    ? '임의공급'
    : HOUSE_LABELS[secd] ?? row.HOUSE_SECD_NM ?? '기타';
  return withOverall({
    key: `${row.HOUSE_MANAGE_NO}-${row.PBLANC_NO}`,
    source: '청약홈',
    kind: endpoint.kind,
    mdlOp: endpoint.mdlOp,
    houseSecd: secd,
    sector: supplySector(row),
    houseManageNo: String(row.HOUSE_MANAGE_NO),
    pblancNo: String(row.PBLANC_NO),
    typeLabel,
    name: row.HOUSE_NM ?? '',
    // 건설업체명(시공사). 스웨거상 APT 상세에만 있다. 다른 유형은 단지명으로 브랜드를 본다.
    builder: row.CNSTRCT_ENTRPS_NM ?? '',
    region: normalizeRegion(row.SUBSCRPT_AREA_CODE_NM ?? row.HSSPLY_ADRES),
    address: row.HSSPLY_ADRES ?? '',
    announceDate: normalizeDate(row.RCRIT_PBLANC_DE),
    winnerDate: normalizeDate(row.PRZWNER_PRESNATN_DE),
    url: row.PBLANC_URL ?? null,
    flags: {
      priceCap: row.PARCPRC_ULS_AT === 'Y',
      publicDistrict: row.PUBLIC_HOUSE_EARTH_AT === 'Y',
    },
    stages: buildStages(endpoint.kind, row),
  });
}

// "084.9810A" -> 84.981. 앞의 숫자가 전용면적이다.
export function parseHouseType(houseType) {
  const match = /^\s*(\d+(?:\.\d+)?)/.exec(String(houseType ?? ''));
  return match ? Number(match[1]) : null;
}

// 공급 세대수는 스웨거상 SUPLY_HSHLDCO(APT·잔여세대는 일반공급, 그 밖은 전체)와 SPSPLY_HSHLDCO(특별공급)다.
// 둘 다 없으면 null이다.
function households(row) {
  const general = parseNumber(row.SUPLY_HSHLDCO);
  const special = parseNumber(row.SPSPLY_HSHLDCO);
  if (general === null && special === null) return null;
  return (general ?? 0) + (special ?? 0);
}

export function normalizeModel(row) {
  return {
    houseType: row.HOUSE_TY ?? [row.GP, row.TP].filter(Boolean).join(' '),
    area: parseNumber(row.EXCLUSE_AR) ?? parseHouseType(row.HOUSE_TY),
    price: parseNumber(row.LTTOT_TOP_AMOUNT) ?? parseNumber(row.SUPLY_AMOUNT),
    households: households(row),
    // 특별공급 유형별 세대수. 스웨거상 APT 주택형에만 있다(신생아 NWBB, 신혼부부 NWWDS, 생애최초 LFE_FRST).
    specials: {
      신생아: parseNumber(row.NWBB_HSHLDCO),
      신혼부부: parseNumber(row.NWWDS_HSHLDCO),
      생애최초: parseNumber(row.LFE_FRST_HSHLDCO),
    },
  };
}

// fetchOptions는 fetchWithRetry의 옵션(retries, timeoutMs 등)을 덮는다. 판정과 무관한 조회에서 짧은 시간 제한과 재시도 없음을 쓴다.
export async function fetchOdcloudAll({ fetch, key, op, params = {}, sleep, fetchOptions = {} }) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      page: String(page),
      perPage: String(PER_PAGE),
      returnType: 'JSON',
      ...params,
    });
    const response = await fetchWithRetry(
      fetch,
      `${BASE_URL}/${op}?${query}`,
      { headers: { Authorization: authorizationHeader(key), Accept: 'application/json' } },
      { kind: 'applyhome', sleep, ...fetchOptions },
    );
    let body;
    try {
      body = await response.json();
    } catch {
      throw new AppError('applyhome_parse');
    }
    if (!Array.isArray(body?.data)) throw new AppError('applyhome_parse');
    rows.push(...body.data);
    // 서버가 perPage를 더 작게 제한할 수 있어, 건수를 알면 짧은 페이지로 멈추지 않는다.
    const target = Number(body.matchCount ?? body.totalCount);
    if (body.data.length === 0 || rows.length >= target) return rows;
    if (Number.isNaN(target) && body.data.length < PER_PAGE) return rows;
  }
  throw new AppError('applyhome_page_limit');
}

export async function collectApplyhome({ fetch, key, today, lookbackDays, sleep, endpoints = ENDPOINTS }) {
  const from = addDays(today, -lookbackDays);
  const notices = [];
  const errors = [];
  for (const endpoint of endpoints) {
    try {
      const value = endpoint.dateFormat === 'compact' ? from.replace(/-/g, '') : from;
      const rows = await fetchOdcloudAll({
        fetch,
        key,
        op: endpoint.op,
        params: { 'cond[RCRIT_PBLANC_DE::GTE]': value },
        sleep,
      });
      for (const row of rows) {
        const notice = normalizeDetail(endpoint, row);
        // 서버 필터 형식이 어긋나도 결과가 같도록 클라이언트에서도 거른다.
        if (notice && (!notice.announceDate || notice.announceDate >= from)) notices.push(notice);
      }
    } catch (error) {
      errors.push(safeError(error));
    }
  }
  return { notices, errors, failedAll: errors.length === endpoints.length };
}

// 주택형 행의 공고 관리번호가 있으면 요청한 공고의 것이어야 한다. 서버 필터가 어긋나도 다른 공고의 주택형이 섞이지 않게 한다.
// 번호 필드가 없는 행은 그대로 둔다.
const sameNumber = (a, b) => String(a).trim() === String(b).trim() || (Number.isFinite(Number(a)) && Number(a) === Number(b));
const ownModel = (notice) => (row) => row.HOUSE_MANAGE_NO === undefined || row.HOUSE_MANAGE_NO === null || sameNumber(row.HOUSE_MANAGE_NO, notice.houseManageNo);

export async function fetchModels(notice, { fetch, key, sleep, fetchOptions }) {
  const rows = await fetchOdcloudAll({
    fetch,
    key,
    op: notice.mdlOp,
    params: {
      'cond[HOUSE_MANAGE_NO::EQ]': notice.houseManageNo,
      'cond[PBLANC_NO::EQ]': notice.pblancNo,
    },
    sleep,
    fetchOptions,
  });
  return rows.filter(ownModel(notice)).map(normalizeModel);
}

// 실행마다 하나씩 만든다. 첫 시간 초과나 네트워크 실패 뒤에는 잡 제한 시간을 아끼려고 호출하지 않는다.
// fetchOptions는 이 조회기의 모든 호출에 쓴다. 판정용과 분양가 사실용은 조회기를 따로 만들어 장애 상태를 나눈다.
export function createModelLookup({ fetch, key, sleep, fetchOptions }) {
  let outage = null;
  return async (notice) => {
    if (outage) throw outage;
    try {
      return await fetchModels(notice, { fetch, key, sleep, fetchOptions });
    } catch (error) {
      if (error.kind === 'applyhome_timeout' || error.kind === 'applyhome_network') outage = error;
      throw error;
    }
  };
}
