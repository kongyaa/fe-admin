import { AppError, fetchWithRetry, parseNumber, safeError } from '../util.js';

// 청약홈 청약접수 경쟁률 조회 서비스(data.go.kr 15098905)의 APT 경쟁률(getAPTLttotPblancCmpet).
// 분양정보(15098547)와 같은 odcloud 서비스라 인증(Authorization 헤더)과 페이지 처리가 같다.
// applyhome.js의 fetchOdcloudAll은 기본 주소가 고정이라 여기 같은 루프를 둔다.
// 은행 시스템 자료를 실시간으로 내주므로 청약홈의 최종 발표 수치와 다를 수 있다.

export const COMPETITION_BASE_URL = 'https://api.odcloud.kr/api/ApplyhomeInfoCmpetRtSvc/v1';
export const COMPETITION_OP = 'getAPTLttotPblancCmpet';
const PER_PAGE = 500;
const MAX_PAGES = 20;

const authorizationHeader = (key) => `Infuser ${key}`;

export async function fetchCompetitionRows({
  fetch, key, houseManageNo, pblancNo, sleep, baseUrl = COMPETITION_BASE_URL,
}) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      page: String(page),
      perPage: String(PER_PAGE),
      returnType: 'JSON',
      'cond[HOUSE_MANAGE_NO::EQ]': String(houseManageNo),
      'cond[PBLANC_NO::EQ]': String(pblancNo),
    });
    const response = await fetchWithRetry(
      fetch,
      `${baseUrl}/${COMPETITION_OP}?${query}`,
      { headers: { Authorization: authorizationHeader(key), Accept: 'application/json' } },
      { kind: 'competition', sleep },
    );
    let body;
    try {
      body = await response.json();
    } catch {
      throw new AppError('competition_parse');
    }
    if (!Array.isArray(body?.data)) throw new AppError('competition_parse');
    rows.push(...body.data);
    const target = Number(body.matchCount ?? body.totalCount);
    if (body.data.length === 0 || rows.length >= target) return rows;
    if (Number.isNaN(target) && body.data.length < PER_PAGE) return rows;
  }
  throw new AppError('competition_page_limit');
}

// 경쟁률 문자열을 숫자로. '263.3', '1,234.56', '263.3:1'은 숫자, '미달', '-', '(△3)', 빈칸은 null.
// 계산은 접수건수/공급세대수로 다시 하므로 이 값은 접수건수를 읽지 못할 때만 쓴다.
export function parseRate(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const text = String(value).replace(/\s+/g, '');
  if (!text || text.includes('미달') || text.includes('△') || /^[-–—]+$/.test(text)) return null;
  const match = /^(\d[\d,]*(?:\.\d+)?)(?::1|대1)?$/.exec(text);
  if (!match) return null;
  const number = parseNumber(match[1]);
  return number !== null && number >= 0 ? number : null;
}

// 접수건수. 숫자·쉼표 문자열만 받는다('미달' 같은 글자는 null).
function count(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, '');
  if (!/^\d[\d,]*$/.test(text)) return null;
  return parseNumber(text);
}

const isRank1 = (row) => Number(String(row?.SUBSCRPT_RANK_CODE ?? '').trim()) === 1;
const round2 = (value) => Math.round(value * 100) / 100;

/**
 * 경쟁률 행을 주택형별 1순위 경쟁률과 단지 합계로 정리한다(순수 함수).
 * - 주택형별 1순위 접수건수 = SUBSCRPT_RANK_CODE가 1인 행의 REQ_CNT를 모든 거주지역(RESIDE_SECD)에 걸쳐 더한 값
 * - 공급세대수 SUPLY_HSHLDCO는 거주지역 행마다 같은 값이 되풀이된다고 보고 그 주택형의 가장 큰 값 하나만 쓴다
 * - 접수건수를 하나도 읽지 못한 주택형은, 1순위 행이 하나뿐이고 CMPET_RATE가 숫자일 때만 그 값으로 접수건수를 거꾸로 잡는다
 * - shortfall: 접수건수 < 공급세대수(1순위 미달)
 * 1순위 행이 없거나 공급세대수를 아는 주택형이 없으면 null(자료 없음).
 */
export function summarizeCompetition(rows) {
  const types = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object' || !isRank1(row)) continue;
    const houseType = String(row.HOUSE_TY ?? row.MODEL_NO ?? '').trim() || '-';
    if (!types.has(houseType)) types.set(houseType, { houseType, households: null, applicants: null, rows: [] });
    const item = types.get(houseType);
    const households = count(row.SUPLY_HSHLDCO);
    if (households !== null) item.households = Math.max(item.households ?? 0, households);
    const applicants = count(row.REQ_CNT);
    if (applicants !== null) item.applicants = (item.applicants ?? 0) + applicants;
    item.rows.push(row);
  }
  const byType = [];
  for (const item of types.values()) {
    if (!(item.households > 0)) continue;
    let { applicants } = item;
    if (applicants === null && item.rows.length === 1) {
      const rate = parseRate(item.rows[0].CMPET_RATE);
      if (rate !== null) applicants = Math.round(rate * item.households);
    }
    if (applicants === null) continue;
    byType.push({
      houseType: item.houseType,
      households: item.households,
      applicants,
      rate: round2(applicants / item.households),
      shortfall: applicants < item.households,
    });
  }
  if (byType.length === 0) return null;
  byType.sort((a, b) => a.houseType.localeCompare(b.houseType));
  const households = byType.reduce((sum, item) => sum + item.households, 0);
  const applicants = byType.reduce((sum, item) => sum + item.applicants, 0);
  return {
    households, applicants, rate: round2(applicants / households), shortfall: applicants < households, byType,
  };
}

/**
 * 실행마다 하나. get(notice)는 { result, error }를 돌려주고 던지지 않는다.
 * 401·403이면 활용신청 승인 전으로 보고 이번 실행에서는 더 부르지 않는다(남은 블록은 competition_disabled).
 * 시간 초과·네트워크 실패 뒤에도 잡 시간을 아끼려고 더 부르지 않는다.
 */
export function createCompetitionClient({ fetch, key, sleep, baseUrl }) {
  let stopped = null;
  return {
    async get({ houseManageNo, pblancNo }) {
      if (stopped) return { result: null, error: null, skipped: stopped };
      try {
        const rows = await fetchCompetitionRows({
          fetch, key, houseManageNo, pblancNo, sleep, baseUrl,
        });
        return { result: summarizeCompetition(rows), error: null };
      } catch (error) {
        const kind = safeError(error);
        if (/^competition_http_(401|403)$/.test(kind)) stopped = 'competition_unauthorized';
        if (kind === 'competition_timeout' || kind === 'competition_network') stopped = kind;
        return { result: null, error: kind };
      }
    },
    stopped: () => stopped,
  };
}
