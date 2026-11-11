// Notion 표에 둘 공고의 범위를 정한다. 수집한 공고와 저장된 행에 같은 규칙을 쓴다. 값은 순수 함수로만 다룬다.
// - 오피스텔·도시형·생활숙박시설(urbty): config.excludeUrbty
// - 수도권 밖 공고: config.tableRegions (시도를 알 수 있을 때만)
// - 청약홈과 LH에 함께 올라온 같은 공고: config.dedupeAcrossSources
// 관심을 체크한 행은 어느 정리에서도 옮기지 않는다.
import { SIDO } from './recommend.js';

// 저장된 행에는 kind가 없어 유형 이름으로 정한다. 청약홈 urbty 엔드포인트가 주는 유형(src/sources/applyhome.js의 HOUSE_LABELS)이다.
const URBTY_LABELS = new Set(['도시형생활주택', '오피스텔', '생활숙박시설', '민간임대']);

// 사유별 로그 이름 접두어
const PREFIX = { urbty: 'urbty', region: 'region_scope' };

export const emptyScopeCounts = () => ({
  urbty_skipped: 0,
  urbty_archived: 0,
  urbty_kept_interest: 0,
  region_scope_skipped: 0,
  region_scope_archived: 0,
  region_scope_kept_interest: 0,
  duplicate_skipped: 0,
  duplicate_archived: 0,
  duplicate_kept_interest: 0,
  duplicate_pairs_examined: 0,
});

// tableRegions에 시도 이름이 아닌 값이 있으면 true. 오타로 서울을 빼고 모두 지우는 일을 막으려고 그 실행에서는 기능을 끈다.
export const tableRegionsInvalid = (config) => Array.isArray(config.tableRegions) && config.tableRegions.some((region) => !SIDO.includes(region));

// 한 번에 옮길 행의 상한. 배포 설정(cleanupMaxRows, cleanupMaxShare)이 없거나 잘못되면 기본값을 쓴다.
const DEFAULT_CLEANUP_MAX_ROWS = 25;
const DEFAULT_CLEANUP_MAX_SHARE = 0.5;
export function cleanupLimits(config) {
  const maxRows = Number.isInteger(config.cleanupMaxRows) && config.cleanupMaxRows >= 0 ? config.cleanupMaxRows : DEFAULT_CLEANUP_MAX_ROWS;
  const maxShare = typeof config.cleanupMaxShare === 'number' && config.cleanupMaxShare >= 0 && config.cleanupMaxShare <= 1 ? config.cleanupMaxShare : DEFAULT_CLEANUP_MAX_SHARE;
  return { maxRows, maxShare };
}

// 옮길 행 수가 상한을 넘는지. 저장된 행 수(storedTotal) 대비 비율도 본다. 관심 행은 옮길 행에 들어 있지 않다.
export function cleanupExceeded(total, storedTotal, config) {
  const { maxRows, maxShare } = cleanupLimits(config);
  return total > maxRows || (storedTotal > 0 && total / storedTotal > maxShare);
}

// 오피스텔·도시형·생활숙박시설이면 'urbty'. 수집한 공고는 kind로, 저장된 행은 유형 이름으로 본다. 꺼져 있으면 null이다.
export function urbtyRule(item, config) {
  if (!config.excludeUrbty) return null;
  if (item.kind) return item.kind === 'urbty' ? 'urbty' : null;
  return URBTY_LABELS.has(String(item.typeLabel ?? '').trim()) ? 'urbty' : null;
}

// 표에 둘 시도 목록. 키가 없거나 배열이 아니거나 비어 있으면 기능이 꺼진 것으로 보고 null이다.
export const tableRegions = (config) => (Array.isArray(config.tableRegions) && config.tableRegions.length > 0 ? config.tableRegions : null);

// 시도를 알고 표에 둘 시도가 아니면 'region'이다. 시도 이름이 아닌 값(빈 값, 주소 해석 실패, 전국 등)은 모르는 지역이라 남긴다.
export function regionRule(item, config) {
  const regions = tableRegions(config);
  if (!regions) return null;
  const region = String(item.region ?? '').trim();
  if (!SIDO.includes(region)) return null;
  return regions.includes(region) ? null : 'region';
}

const scopeReason = (item, config) => urbtyRule(item, config) ?? regionRule(item, config);

// 오피스텔·도시형과 수도권 밖 공고를 가른다. 한 공고는 한 사유로만 세어(오피스텔 먼저) 두 번 세거나 두 번 옮기지 않는다.
// 관심을 체크한 행이 있는 공고는 빼지 않고 보통 공고처럼 다룬다. 관심 여부는 실행 시작 때 읽은 값이다.
// 옮길 행은 이번 실행에 빠진 공고의 행과, 이번 실행에 수집되지 않았고 저장된 값으로 범위 밖인 행이다.
// 이번 실행에 수집되어 남은 공고의 행은 저장된 값으로 다시 판정하지 않는다. 관심 행은 남기고 센다.
// claimedKeys는 앞 단계(LH 범위)가 이미 다룬 키로, 여기서는 세지도 옮기지도 않는다.
// keptOutKeys는 범위 밖이지만 관심으로 남긴 공고의 키다(중복 정리에서도 건드리지 않는다).
export function splitTableScope(notices, rows, config, claimedKeys = new Set()) {
  // 옮긴 수(_archived)는 알림 뒤에 main이 센다. 여기서는 빼거나 남긴 수만 센다.
  const counts = { urbty_skipped: 0, urbty_kept_interest: 0, region_scope_skipped: 0, region_scope_kept_interest: 0 };
  const outReasons = new Map();
  const keptKeys = new Set();
  const keptOutKeys = new Set();
  const kept = [];
  for (const notice of notices) {
    const reason = claimedKeys.has(notice.key) ? null : scopeReason(notice, config);
    if (!reason) {
      keptKeys.add(notice.key);
      kept.push(notice);
      continue;
    }
    outReasons.set(notice.key, reason);
    if (rows.get(notice.key)?.interest) {
      keptOutKeys.add(notice.key);
      kept.push(notice);
      continue;
    }
    counts[`${PREFIX[reason]}_skipped`] += 1;
  }
  const archiveRows = { urbty: [], region: [] };
  for (const row of rows.values()) {
    if (claimedKeys.has(row.key) || keptKeys.has(row.key)) continue;
    const reason = outReasons.get(row.key) ?? scopeReason(row, config);
    if (!reason) continue;
    if (row.interest) counts[`${PREFIX[reason]}_kept_interest`] += 1;
    else archiveRows[reason].push(row);
  }
  return { notices: kept, archiveRows, counts, keptOutKeys };
}

// ---------- 소스 사이 중복 ----------

const BRACKET_OPEN = /[[（［【〔]/g;
const BRACKET_CLOSE = /[\]）］】〕]/g;

// 이름 비교용. 괄호 모양(() [] 【】)을 하나로 맞추고 공백을 지우고 소문자로 바꾼다.
// 잔여세대, 공공분양, 지분적립형 같은 유형 단어는 지우지 않는다(다른 공고를 합치지 않기 위해서다).
export function normalizeName(name) {
  return String(name ?? '')
    .normalize('NFKC')
    .replace(BRACKET_OPEN, '(')
    .replace(BRACKET_CLOSE, ')')
    .replace(/[\s​-‍﻿]+/g, '')
    .toLowerCase();
}

// 시도 이름만 있는 주소(LH 목록의 CNP_CD_NM)는 주소로 치지 않는다.
const hasDetailedAddress = (notice) => String(notice.address ?? '').trim().split(/\s+/).filter(Boolean).length >= 2;

// 정보량 점수: 날짜가 있는 단계 수 + 가격이 있는 주택형 수 + 주소 여부(1). 높을수록 정보가 많다.
export function noticeScore(notice) {
  const stages = (notice.stages ?? []).filter((stage) => stage?.start).length;
  const models = (notice.models ?? []).filter((model) => model?.price > 0).length;
  return stages + models + (hasDetailedAddress(notice) ? 1 : 0);
}

const dayNumber = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

function windowOf(notice) {
  const start = notice.overallStart || notice.announceDate;
  if (!start) return null;
  return { start: dayNumber(start), end: dayNumber(notice.overallEnd && notice.overallEnd >= start ? notice.overallEnd : start) };
}

// 두 공고의 날짜 간격(일). 둘 다 모집공고일이 있으면 그 차이만 본다(접수 기간이 겹쳐도 공고일이 멀면 다른 공고다).
// 한쪽에 모집공고일이 없을 때만 접수 기간 사이의 간격(겹치면 0)을 쓴다. LH 목록의 기간은 공고일부터 마감일이다. 비교할 날짜가 없으면 Infinity다.
export function dateGap(a, b) {
  if (a.announceDate && b.announceDate) return Math.abs(dayNumber(a.announceDate) - dayNumber(b.announceDate));
  const wa = windowOf(a);
  const wb = windowOf(b);
  if (wa && wb) return Math.max(0, wa.start - wb.end, wb.start - wa.end);
  return Infinity;
}

// 접수가 끝난 공고. src/main.js의 isClosedNotice와 같은 기준이다(날짜가 있으면 날짜, 없으면 LH 상태). today가 없으면 따지지 않는다.
export function isClosed(notice, today) {
  if (!today) return false;
  if (notice.overallEnd) return notice.overallEnd < today;
  return notice.kind === 'lh' && /마감|종료/.test(notice.noticeStatus ?? '');
}

const DEFAULT_TOLERANCE_DAYS = 3;
const toleranceOf = (config) => (Number.isInteger(config.duplicateToleranceDays) && config.duplicateToleranceDays >= 0 ? config.duplicateToleranceDays : DEFAULT_TOLERANCE_DAYS);
export const dedupeEnabled = (config) => config.dedupeAcrossSources !== false;

// 서로 다른 소스의 같은 공고인지. 시도가 같고, 정규화한 이름이 같고, 날짜가 허용 간격 안이어야 한다.
// 같은 소스 안의 공고는 합치지 않는다. 시도나 이름을 모르면 합치지 않는다.
// today가 있으면 접수가 끝난 공고와 진행 중인 공고는 짝짓지 않는다(진행 중인 쪽이 표에서 사라지는 일을 막는다).
export function isDuplicate(a, b, toleranceDays = DEFAULT_TOLERANCE_DAYS, today = null) {
  if (!a.source || a.source === b.source) return false;
  if (!a.region || a.region !== b.region) return false;
  const name = normalizeName(a.name);
  if (!name || name !== normalizeName(b.name)) return false;
  if (isClosed(a, today) !== isClosed(b, today)) return false;
  return dateGap(a, b) <= toleranceDays;
}

// 남길 공고. 진행 중인 쪽, 점수가 높은 쪽, 같으면 청약홈, 그래도 같으면 키가 앞선 쪽이다. 입력 순서와 관계없이 같은 결과를 낸다.
export function pickWinner(a, b, today = null) {
  if (isClosed(a, today) !== isClosed(b, today)) return isClosed(a, today) ? b : a;
  const diff = noticeScore(a) - noticeScore(b);
  if (diff !== 0) return diff > 0 ? a : b;
  if ((a.source === '청약홈') !== (b.source === '청약홈')) return a.source === '청약홈' ? a : b;
  return String(a.key) <= String(b.key) ? a : b;
}

// 소스 사이의 중복을 하나로 합친다. exemptKeys의 공고는 비교하지 않는다.
// 한 공고는 한 쌍에만 들어간다(간격이 가까운 쌍, 키 순으로 짝짓는다). 돌려주는 공고는 입력 순서를 지킨다.
// 손으로 고른 행. 관심을 체크했거나 역 도보(분)을 입력한 행은 사용자가 만진 행이라 합치지 않는다.
const touchedByUser = (row) => Boolean(row) && (row.interest === true || Number.isFinite(row.walkMinutes));

// 규칙에 맞는 쌍은 모두 센다(examined). 그중 다음 쌍은 합치지 않고 둘 다 보통 공고로 둔다.
// - exemptKeys의 공고가 든 쌍(범위 규칙이 관심으로 남긴 공고)
// - 저장된 행이 관심이거나 역 도보(분)이 입력된 쌍(어느 한쪽이라도). touched로 센다.
export function dedupeAcrossSources(notices, config, { exemptKeys = new Set(), rows = new Map(), today = null } = {}) {
  if (!dedupeEnabled(config)) return { notices, duplicates: [], examined: 0, touched: 0 };
  const tolerance = toleranceOf(config);
  const pairs = [];
  for (let i = 0; i < notices.length; i += 1) {
    for (let j = i + 1; j < notices.length; j += 1) {
      if (!isDuplicate(notices[i], notices[j], tolerance, today)) continue;
      const [first, second] = String(notices[i].key) <= String(notices[j].key) ? [notices[i], notices[j]] : [notices[j], notices[i]];
      pairs.push({ first, second, gap: dateGap(first, second) });
    }
  }
  pairs.sort((x, y) => x.gap - y.gap || String(x.first.key).localeCompare(String(y.first.key)) || String(x.second.key).localeCompare(String(y.second.key)));
  const used = new Set();
  const losers = new Set();
  const duplicates = [];
  let touched = 0;
  for (const { first, second } of pairs) {
    if (exemptKeys.has(first.key) || exemptKeys.has(second.key)) continue;
    if (touchedByUser(rows.get(first.key)) || touchedByUser(rows.get(second.key))) {
      touched += 1;
      continue;
    }
    if (used.has(first.key) || used.has(second.key)) continue;
    used.add(first.key);
    used.add(second.key);
    const winner = pickWinner(first, second, today);
    const loser = winner === first ? second : first;
    losers.add(loser.key);
    duplicates.push({ winner, loser });
  }
  return { notices: notices.filter((notice) => !losers.has(notice.key)), duplicates, examined: pairs.length, touched };
}

// 중복에서 진 공고의 저장된 행을 가른다. 진 공고는 이번 실행에서 다루지 않는다.
// 관심 행이나 역 도보(분)이 있는 행의 쌍은 합치지 않으므로(그 쌍 수를 duplicate_kept_interest로 센다) 옮길 행에는 그런 행이 없다.
export function splitDuplicates(notices, rows, config, { exemptKeys = new Set(), today = null } = {}) {
  const { notices: kept, duplicates, examined, touched } = dedupeAcrossSources(notices, config, { exemptKeys, rows, today });
  const counts = { duplicate_skipped: duplicates.length, duplicate_kept_interest: touched, duplicate_pairs_examined: examined };
  const archiveRows = duplicates.map(({ loser }) => rows.get(loser.key)).filter(Boolean);
  return { notices: kept, archiveRows, counts, duplicates };
}
