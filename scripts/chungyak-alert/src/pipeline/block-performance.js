import { readFileSync } from 'node:fs';
import {
  CONFIDENCE, buildSubject, cleanTrades, estimateBestMargin, restrictedType,
} from '../market-estimate.js';
import { resolveAddress } from '../sgg-codes.js';
import { createModelLookup } from '../sources/applyhome.js';
import { createMolitClient, createPresaleClient } from '../sources/molit.js';
import { completeMonths, safeError, safeHttpUrl } from '../util.js';
import { createCompetitionClient } from './applyhome-competition.js';
import {
  MAIN_SUBSCRIPTION, blockRowKey, blockRowNotices, noticeStage,
} from './blocks.js';
import {
  PRE_SUBSCRIPTION, blockKey, isBlockTown, isRentalNotice, onOrAfter, sourceOutlet,
} from './expected-window.js';

// 분양 예정 지도의 "분양 성과": 이미 공고가 난 블록(블록별 분양 지구의 분양 줄)의 분양가, 주변 시세 비교, 1순위 경쟁률.
// - 분양가: 청약홈 주택형(fetchModels)의 최고 분양가(만원)와 만원/전용㎡. 대표 주택형은 전용 84㎡ ±3 중 가장 가까운 것, 없으면 가장 넓은 것.
// - 주변 시세: 알림 배치와 같은 순수 함수(market-estimate.js)로 공고일 기준(공고 직전 완결 6개월 실거래)과 오늘 기준을 따로 계산한다.
//   값은 "같은 조건의 신축이면 얼마"인 신축 환산 추정이다. 이 블록은 전매제한·미입주라 자기 시세가 없다.
//   안전 마진(옵션·취득세 차감)이나 로또 판정은 쓰지 않고 할인율(1 − 분양가/추정 시세)만 낸다. 신뢰도 하나 추정 없음은 숫자를 숨긴다.
//   제한 유형(신혼희망타운, 나눔형, 토지임대부, 지분적립형)은 시세 차익을 그대로 갖지 못해 시세 비교를 하지 않는다.
// - 경쟁률: 청약홈 경쟁률 API(15098905), 없으면 newtowns.yaml 이력의 competition(보도 출처).
//   API 값은 주택형 공급세대수가 거주지역 행마다 같고 주택형 정보(fetchModels)의 세대수와 어긋나지 않을 때,
//   그리고 모든 주택형의 접수건수를 읽었을 때만 쓴다. 아니면 버리고 보도 값으로 넘어간다.
// 블록마다 따로 try/catch하고, 실패해도 지도 빌드는 계속한다.

export const REPRESENTATIVE_AREA = 84;
export const REPRESENTATIVE_TOLERANCE = 3;
export const MAX_COMPARABLE_NAMES = 5;
export const API_SOURCE = '청약홈';
export const REPORT_SOURCE = '보도';

export function loadConfig(read = (url) => readFileSync(url, 'utf8')) {
  return JSON.parse(read(new URL('../../config.json', import.meta.url)));
}

const round1 = (value) => Math.round(value * 10) / 10;

// 주택형 → 분양가 줄 { houseType, area(전용㎡), topPrice(최고 분양가, 만원), unitPrice(만원/전용㎡) }. 면적·가격이 없는 주택형은 뺀다. 면적순.
export function priceRows(models) {
  return (Array.isArray(models) ? models : [])
    .filter((model) => model && model.area > 0 && model.price > 0)
    .map((model) => ({
      houseType: String(model.houseType ?? '').trim() || '-',
      area: model.area,
      topPrice: model.price,
      unitPrice: round1(model.price / model.area),
    }))
    .sort((a, b) => a.area - b.area || a.houseType.localeCompare(b.houseType));
}

// 대표 주택형: 전용 84㎡ ±3 안에서 가장 가까운 것(같으면 최고 분양가가 높은 것), 없으면 가장 넓은 것(같으면 높은 가격). 없으면 null.
export function pickRepresentative(prices) {
  const list = Array.isArray(prices) ? prices : [];
  if (list.length === 0) return null;
  const near = list.filter((p) => Math.abs(p.area - REPRESENTATIVE_AREA) <= REPRESENTATIVE_TOLERANCE);
  if (near.length) {
    return [...near].sort((a, b) => Math.abs(a.area - REPRESENTATIVE_AREA) - Math.abs(b.area - REPRESENTATIVE_AREA)
      || b.topPrice - a.topPrice)[0];
  }
  return [...list].sort((a, b) => b.area - a.area || b.topPrice - a.topPrice)[0];
}

// 할인율 = 1 − 분양가/추정 시세(소수 셋째 자리). 양수면 분양가가 추정보다 낮다. 값이 없으면 null.
export function discountRate(price, estimate) {
  if (!(price > 0) || !(estimate > 0)) return null;
  return Math.round((1 - price / estimate) * 1000) / 1000;
}

// completeMonths 결과(YYYYMM, 최신순) → '2024-09~2025-02'
export function monthsPeriod(months) {
  const sorted = [...(months ?? [])].sort();
  if (!sorted.length) return null;
  const ym = (value) => `${value.slice(0, 4)}-${value.slice(4, 6)}`;
  return `${ym(sorted[0])}~${ym(sorted.at(-1))}`;
}

const RESTRICTED_NAMES = {
  신혼희망: '신혼희망타운', 나눔형: '나눔형', 토지임대: '토지임대부', 지분적립: '지분적립형',
};

export function restrictedReason(keyword) {
  const name = RESTRICTED_NAMES[keyword] ?? keyword;
  return `${name}은 수익공유·전매 조건이 달라 시세 차익을 그대로 갖지 못해 주변 시세와 비교하지 않습니다`;
}

export const REASONS = {
  noNotice: '청약홈 공고 정보가 없어 조회하지 않았습니다',
  noKey: '청약홈 조회 키가 없어 조회하지 않았습니다',
  modelsFailed: '청약홈 주택형 조회에 실패했습니다',
  noPrices: '청약홈 주택형에 분양가가 없습니다',
  unmapped: '단지 주소의 시군구를 찾지 못했습니다',
  tradesFailed: '국토부 실거래 조회에 실패했습니다',
  noEstimate: '주변 비교 단지가 부족해 시세를 추정하지 않았습니다',
  lowConfidence: '추정 신뢰도가 하(비교 단지·표본 부족, 넓은 범위 등)라 숫자를 숨깁니다',
  // 경쟁률: 경우마다 사실대로
  competitionMissing: '청약홈 경쟁률 자료에 이 공고가 없습니다(LH 청약플러스 접수 공고는 빠질 수 있음)',
  competitionPending: '접수 중이라 아직 집계 전입니다',
  competitionBeforeReceipt: '접수 전이라 아직 집계 전입니다',
  competitionDisabled: '경쟁률 API를 쓸 수 없습니다',
  competitionUnavailable: '청약홈 경쟁률을 조회하지 못했습니다',
  competitionUnreadable: '청약홈 경쟁률 자료에서 1순위 값을 읽지 못했습니다',
  competitionPartial: '청약홈 경쟁률에서 일부 주택형을 읽지 못해 단지 경쟁률을 내지 않았습니다',
  competitionMismatch: '청약홈 경쟁률의 공급세대수가 주택형 정보와 맞지 않아 쓰지 않았습니다',
};

export const COMPETITION_MISMATCH = 'competition_households_mismatch';
export const COMPETITION_PARTIAL = 'competition_partial';

// 비교 범위 이름: 시군구는 시 이름(하남시), 법정동·리·읍면은 그 이름
function scopeLabel(scope, { district, umd, village }) {
  if (scope === '시군구') return district || '시군구';
  if (scope === '리') return village || '리';
  if ((scope === '법정동' || scope === '읍·면') && umd) return umd;
  return scope ?? null;
}

/**
 * 추정(estimateBestMargin의 주택형 하나 결과) → 화면용 시점 값. 신뢰도 하이거나 추정이 없으면 숫자 없이 reason만.
 * 안전 마진·보수 시세·옵션·취득세는 옮기지 않는다.
 */
export function marketPoint(best, {
  asOf, months, price, area, place = {},
}) {
  const head = { asOf, period: monthsPeriod(months) };
  if (!best || !(best.estimate > 0)) return { ...head, estimate: null, reason: REASONS.noEstimate };
  if (best.confidence === CONFIDENCE.LOW) return { ...head, estimate: null, reason: REASONS.lowConfidence };
  const basis = best.basis ?? {};
  const same = basis.kind === 'same';
  const comparables = same ? [] : (basis.comparables ?? []);
  return {
    ...head,
    estimate: best.estimate,
    unit: round1(best.estimate / area),
    discountRate: discountRate(price, best.estimate),
    confidence: best.confidence,
    scope: same ? '같은 단지' : basis.scope ?? null,
    scopeLabel: same ? '같은 단지' : scopeLabel(basis.scope, place),
    comparables: comparables.map((item) => String(item.name ?? '').trim()).filter(Boolean).slice(0, MAX_COMPARABLE_NAMES),
    comparableCount: comparables.length,
    samples: basis.samples ?? null,
  };
}

/**
 * 경쟁률 API의 분모(주택형별 공급세대수)를 믿을 수 있는지 본다. 어긋난 주택형 목록(없으면 빈 배열).
 * - 한 주택형의 SUPLY_HSHLDCO가 거주지역 행마다 다르면(summary.conflicts) 어긋남
 * - 주택형 정보(models, 이미 조회한 것)가 있으면 같은 HOUSE_TY를 찾는다. 없으면 어긋남.
 *   주택형 정보의 households는 일반공급+특별공급 합계라, 경쟁률 쪽 일반공급 세대수(특별공급 잔여가 넘어와도)는
 *   이 값을 넘을 수 없다. 넘으면 어긋남. 같은 값이어야 한다고 보지는 않는다(특별공급이 있으면 늘 다르다).
 *   households를 모르는 주택형은 이 검사를 건너뛴다.
 * - models가 없으면(조회 실패) 거주지역 검사만 한다.
 */
export function competitionMismatches(summary, models) {
  if (!summary) return [];
  const bad = new Set(summary.conflicts ?? []);
  if (Array.isArray(models)) {
    const byType = new Map();
    for (const model of models) {
      const type = String(model?.houseType ?? '').trim();
      if (type && !byType.has(type)) byType.set(type, model);
    }
    for (const item of summary.byType) {
      const model = byType.get(item.houseType);
      if (!model) bad.add(item.houseType);
      else if (Number.isFinite(model.households) && item.households > model.households) bad.add(item.houseType);
    }
  }
  return [...bad].sort();
}

// 청약홈 경쟁률 요약 → 출력. 1순위 합계와 주택형별 값. 합계가 없으면(일부 주택형을 못 읽음) null.
export function apiCompetition(summary) {
  if (!summary || typeof summary.rate !== 'number') return null;
  return {
    source: API_SOURCE,
    scope: '1순위',
    rate: summary.rate,
    applicants: summary.applicants,
    households: summary.households,
    shortfall: summary.shortfall,
    byType: summary.byType.map(({
      houseType, households, applicants, rate, shortfall,
    }) => ({
      houseType, households, applicants, rate, shortfall,
    })),
    ref: null,
  };
}

// yaml 이력의 보도된 경쟁률 → 출력
export function reportedCompetition(entry) {
  if (!entry || !(entry.rate > 0)) return null;
  const url = safeHttpUrl(entry.source?.url);
  return {
    source: REPORT_SOURCE,
    scope: entry.scope ?? null,
    rate: entry.rate,
    applicants: entry.applicants ?? null,
    households: entry.households ?? null,
    shortfall: entry.applicants !== null && entry.applicants !== undefined && entry.households > 0
      ? entry.applicants < entry.households : null,
    byType: [],
    ref: url ? {
      title: entry.source.title ?? url, url, date: entry.source.date ?? null, outlet: sourceOutlet({ ...entry.source, url }),
    } : null,
  };
}

// 경쟁률 고르기: 청약홈 API 값이 있으면 그것, 없으면 보도 값. 둘 다 없으면 null.
export function chooseCompetition(api, reported) {
  return apiCompetition(api) ?? reportedCompetition(reported);
}

/**
 * 블록별 분양 지구의 분양 성과 대상. 분양 줄(임대 아님)마다:
 * - 그 줄에 이어진 청약홈 APT 공고(townBlocks와 같은 규칙, 민간사전청약·무순위 등 제외) 중 가장 늦은 것
 * - 같은 블록의 본청약 분양 이력(오늘까지) 중 가장 늦은 것(보도된 경쟁률 competition을 쓴다)
 * 둘 다 없거나, 공고가 없고 이력에 경쟁률도 없으면 대상이 아니다.
 * fullByKey: 공고 key → 수집한 원래 공고(주소·주택형 조회 정보가 있음). 사업의 notices는 요약이라 이것으로 찾는다.
 */
export function performanceTargets(project, { fullByKey = new Map(), today }) {
  if (!isBlockTown(project?.kind, project?.stage) || !Array.isArray(project.blocks)) return [];
  const rowNotices = blockRowNotices({
    entries: project.blockEntries ?? [], history: project.history ?? [], plans: project.plans ?? [], notices: project.notices ?? [],
  });
  const targets = [];
  for (const row of project.blocks) {
    if (row.rental) continue;
    const key = blockRowKey(row.block, false);
    const notice = (rowNotices.get(key) ?? [])
      .filter((summary) => !isRentalNotice(summary) && noticeStage(summary) === MAIN_SUBSCRIPTION)
      .map((summary) => fullByKey.get(summary.key))
      .filter((full) => full && full.kind === 'apt' && full.houseSecd !== '09')
      .sort((a, b) => String(b.announceDate ?? '').localeCompare(String(a.announceDate ?? '')))[0] ?? null;
    const history = (project.history ?? [])
      .filter((entry) => !entry.rental && entry.stage !== PRE_SUBSCRIPTION && blockKey(entry.block) === blockKey(row.block)
        && onOrAfter(today, entry.noticeDate) !== false)
      .sort((a, b) => String(b.noticeDate).localeCompare(String(a.noticeDate)))[0] ?? null;
    if (!notice && !history?.competition) continue;
    targets.push({
      id: `${project.id}|${key}`, district: project.district ?? null, block: row.block, rowType: row.type ?? null, notice, history,
    });
  }
  return targets;
}

// 공고·줄 유형·이력 유형을 함께 보고 제한 유형 키워드를 찾는다(신혼희망타운은 청약홈 유형 코드 10으로도 잡힌다).
function restrictedOf(target, market) {
  const types = [target.notice?.typeLabel, target.rowType, target.history?.type].filter(Boolean).join(' ');
  return restrictedType({
    name: target.notice?.name ?? target.history?.title ?? '', typeLabel: types, houseSecd: target.notice?.houseSecd ?? null,
  }, market);
}

const DISABLED = /^competition_http_(401|403)$/;

/**
 * 경쟁률 API에 쓸 값이 없을 때의 사유(공고가 있을 때). 경우마다 사실대로:
 * - 경쟁률 클라이언트 없음, 시간 초과·네트워크·5xx 등 → 조회 실패
 * - 401·403(이번 실행에서 막힌 뒤 건너뛴 블록 포함) → API를 쓸 수 없음
 * - 접수 시작 전(overallStart > 오늘) → 접수 전, 접수 마감 전(overallEnd ≥ 오늘) → 접수 중이라 집계 전
 * - 행은 받았는데 1순위 값을 못 읽음 → 읽지 못함
 * - 접수가 끝났는데(또는 접수일을 모름) 행이 없음 → 청약홈 경쟁률 자료에 이 공고가 없음
 */
export function competitionMissingReason(got, notice, today) {
  if (!got) return REASONS.competitionUnavailable;
  if (DISABLED.test(got.error ?? '') || got.skipped === 'competition_unauthorized') return REASONS.competitionDisabled;
  if (got.error || got.skipped) return REASONS.competitionUnavailable;
  if (notice?.overallStart && today < notice.overallStart) return REASONS.competitionBeforeReceipt;
  if (notice?.overallEnd && notice.overallEnd >= today) return REASONS.competitionPending;
  if (got.rows > 0) return REASONS.competitionUnreadable;
  return REASONS.competitionMissing;
}

/**
 * 경쟁률 고르기와 사유. 청약홈 API 값은 단지 합계가 있고(일부 주택형 누락이면 competition_partial)
 * 공급세대수 검사(competitionMismatches)를 지나야 쓴다(어긋나면 competition_households_mismatch).
 * 못 쓰면 보도 값, 그것도 없으면 사유.
 */
function decideCompetition({
  notice, got, models, reported, missing, today, errors,
}) {
  let summary = got?.result ?? null;
  let rejected = null;
  if (summary && typeof summary.rate !== 'number') {
    errors.push(COMPETITION_PARTIAL);
    rejected = REASONS.competitionPartial;
    summary = null;
  } else if (summary && competitionMismatches(summary, models).length) {
    errors.push(COMPETITION_MISMATCH);
    rejected = REASONS.competitionMismatch;
    summary = null;
  }
  const competition = chooseCompetition(summary, reported);
  if (competition) return { competition, reason: null };
  if (!notice) return { competition: null, reason: missing };
  return { competition: null, reason: rejected ?? competitionMissingReason(got, notice, today) };
}

/**
 * 블록 하나의 분양 성과. 외부 호출은 deps(getModels, molit, presale, competition)로만 한다. 실패는 errors에 종류만 넣는다.
 */
export async function blockPerformance(target, {
  config, today, getModels, molit, presale, competition, hasKey = true, errors = [],
}) {
  const { lotto, market } = config;
  const { notice, history } = target;
  const result = {
    noticeKey: notice?.key ?? null,
    name: notice?.name || history?.title || null,
    noticeDate: notice?.announceDate ?? history?.noticeDate ?? null,
    noticeUrl: safeHttpUrl(notice?.url),
    prices: [],
    representative: null,
    pricesReason: null,
    market: null,
    marketReason: null,
    competition: null,
    competitionReason: null,
  };
  const missing = hasKey ? REASONS.noNotice : REASONS.noKey;

  // 경쟁률 조회
  let got = null;
  if (notice && competition) {
    got = await competition.get(notice);
    if (got.error) errors.push(got.error);
  }

  // 분양가(주택형). 경쟁률 분모 검사에도 쓴다.
  let models = null;
  if (notice) {
    try {
      models = await getModels(notice);
    } catch (error) {
      errors.push(safeError(error));
    }
  }

  const chosen = decideCompetition({
    notice, got, models: Array.isArray(models) ? models : null, reported: history?.competition ?? null, missing, today, errors,
  });
  result.competition = chosen.competition;
  result.competitionReason = chosen.reason;

  if (!notice) {
    result.pricesReason = missing;
    result.marketReason = missing;
    return result;
  }
  if (!models) {
    result.pricesReason = REASONS.modelsFailed;
    result.marketReason = REASONS.modelsFailed;
    return result;
  }
  result.prices = priceRows(models);
  result.representative = pickRepresentative(result.prices);
  if (!result.representative) {
    result.pricesReason = REASONS.noPrices;
    result.marketReason = REASONS.noPrices;
    return result;
  }

  // 주변 시세
  const restricted = restrictedOf(target, market);
  if (restricted) {
    result.marketReason = restrictedReason(restricted);
    return result;
  }
  const { code, umd, village } = resolveAddress(notice.address, notice.region);
  if (!code) {
    result.marketReason = REASONS.unmapped;
    return result;
  }
  const rep = result.representative;
  const model = { houseType: rep.houseType, area: rep.area, price: rep.topPrice };
  const subject = buildSubject({
    name: notice.name, builder: notice.builder, umd, village, jibun: null, walkMinutes: null, market,
  });
  const place = { district: target.district, umd, village };
  const at = async (asOf) => {
    const months = completeMonths(asOf, lotto.tradeMonths);
    try {
      const trades = await molit.getTrades(code, months);
      const pre = presale ? await presale.getTrades(code, months) : { rows: [], ok: false };
      const rows = cleanTrades([...trades, ...pre.rows], { market, lotto, today: asOf });
      const best = estimateBestMargin({
        models: [model], rows, subject, presaleOk: pre.ok, lotto, market, today: asOf,
      });
      return marketPoint(best, {
        asOf, months, price: rep.topPrice, area: rep.area, place,
      });
    } catch (error) {
      errors.push(safeError(error));
      return { asOf, period: monthsPeriod(months), estimate: null, reason: REASONS.tradesFailed };
    }
  };
  const noticeAsOf = result.noticeDate && /^\d{4}-\d{2}-\d{2}$/.test(result.noticeDate) ? result.noticeDate : null;
  result.market = {
    atNotice: noticeAsOf ? await at(noticeAsOf) : null,
    now: await at(today),
  };
  return result;
}

const counted = (fetch, counter) => (...args) => {
  counter.calls += 1;
  return fetch(...args);
};

/**
 * 대상 블록들의 분양 성과. 결과는 { results: Map<target.id, performance>, stats }.
 * stats = { blocks, priced, estimated, competition, calls, errors(종류, 중복 없음), skipped }
 * - key가 없으면 청약홈·국토부를 부르지 않고 보도된 경쟁률만 쓴다(skipped: 'no_key').
 * - 국토부 매매·분양권은 실행에 클라이언트 하나씩이라 같은 시군구·달은 한 번만 부른다. calls는 실제 HTTP 요청 수(재시도 포함).
 */
export async function buildPerformance(targets, {
  fetch = globalThis.fetch, key = null, today, config = loadConfig(), sleep, clients = null,
}) {
  const counter = { calls: 0 };
  const errors = [];
  const results = new Map();
  const hasKey = Boolean(key);
  let deps = { getModels: null, molit: null, presale: null, competition: null };
  if (hasKey && targets.some((target) => target.notice)) {
    const f = counted(fetch, counter);
    deps = clients ?? {
      // 첫 시간 초과·네트워크 실패 뒤에는 남은 블록의 주택형을 부르지 않는다(잡 시간 보호)
      getModels: createModelLookup({ fetch: f, key, sleep }),
      molit: createMolitClient({ fetch: f, key, sleep }),
      presale: createPresaleClient({
        fetch: f, key, sleep, budgetMs: config.market?.presale?.budgetMs ?? 120000, onSoft: (kind) => errors.push(kind),
      }),
      competition: createCompetitionClient({ fetch: f, key, sleep }),
    };
  }
  for (const target of targets) {
    try {
      // 키가 없으면 공고가 있어도 조회하지 않는다(보도된 경쟁률만)
      const input = hasKey ? target : { ...target, notice: null };
      results.set(target.id, await blockPerformance(input, {
        config, today, ...deps, hasKey, errors,
      }));
    } catch (error) {
      errors.push(safeError(error) === 'unexpected_error' ? 'performance_unexpected' : safeError(error));
    }
  }
  const values = [...results.values()];
  const shown = (point) => Boolean(point && point.estimate > 0);
  return {
    results,
    stats: {
      blocks: values.length,
      priced: values.filter((perf) => perf.representative).length,
      estimated: values.filter((perf) => shown(perf.market?.atNotice) || shown(perf.market?.now)).length,
      competition: values.filter((perf) => perf.competition).length,
      calls: counter.calls,
      errors: [...new Set(errors)],
      skipped: hasKey ? null : 'no_key',
    },
  };
}

// 블록별 현황 줄에 분양 성과를 붙인다(줄 열쇠로 찾음). 성과가 없는 줄은 그대로.
export function attachPerformance(project, results) {
  if (!Array.isArray(project?.blocks) || !results?.size) return project;
  let changed = false;
  const blocks = project.blocks.map((row) => {
    const perf = results.get(`${project.id}|${blockRowKey(row.block, row.rental)}`);
    if (!perf) return row;
    changed = true;
    return { ...row, performance: perf };
  });
  return changed ? { ...project, blocks } : project;
}
