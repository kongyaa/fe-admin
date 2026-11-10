import { safeHttpUrl } from '../util.js';
import {
  PRE_SUBSCRIPTION, blockKey, onOrAfter, reportDate, sourceOutlet, toMonth,
} from './expected-window.js';

// 블록별 현황: newtowns.yaml의 blocks(사업승인 등 블록 단위 사실)와 분양 이력(history), 연결된 청약홈 공고(notices),
// 보도된 다음 블록 계획(plans)을 블록마다 한 줄로 합친다. 같은 블록이라도 분양과 임대는 다른 줄이다
// (구리갈매역세권 A-1 신혼희망타운과 A-1 행복주택). 줄의 열쇠는 blockKey + rental.

// yaml blocks의 status 값. 비우면 '미정'.
export const BLOCK_STATUSES = ['사업승인', '착공', '계획 보도', '미정'];
export const UNDECIDED = '미정';

// 화면에 보이는 상태(정렬 순서이기도 하다). site/app.js의 BLOCK_STATUS_ORDER와 같게 둔다.
// 접수 중(연결된 공고 접수 중) > 분양 끝남(본청약 이력 또는 접수가 끝난 공고) > 임대 공고(임대 이력)
// > 다음 예정(보도)(아직 공고가 안 난 보도 계획) > yaml 상태(착공, 사업승인, 계획 보도) > 미정
export const BLOCK_STATUS_ORDER = ['접수 중', '분양 끝남', '임대 공고', '다음 예정(보도)', '착공', '사업승인', '계획 보도', UNDECIDED];
export const LIVE = '접수 중';
export const SOLD = '분양 끝남';
export const RENTAL_NOTICE = '임대 공고';
export const PLANNED = '다음 예정(보도)';
export const MAIN_SUBSCRIPTION = '본청약';

// 청약홈 공고 유형 중 임대와 사전청약. site/app.js의 RENTAL_NOTICE_TYPES·NOTICE_PRE_SUBSCRIPTION과 같은 값.
const RENTAL_NOTICE_TYPES = ['민간임대', '공공지원민간임대'];
const NOTICE_PRE_SUBSCRIPTION = '민간사전청약';

// 비교용 이름: 공백·가운뎃점과 글자-숫자 사이 '-'를 뺀다(site/app.js의 compactName과 같다)
const compactName = (value) => String(value ?? '').toUpperCase().replace(/[\s·]/g, '').replace(/(?<=[A-Z])-(?=\d)/g, '');

// 공고명에 블록 이름이 있는지. 'A2'는 '…(A-2BL)'에 맞고 'A20'·'BA2'·'A2-1'에는 맞지 않는다(site/app.js nameHasBlock과 같다)
export function nameHasBlock(name, block) {
  const key = blockKey(block);
  if (key.length < 2) return false;
  const hay = compactName(name);
  for (let i = hay.indexOf(key); i >= 0; i = hay.indexOf(key, i + 1)) {
    const after = hay.slice(i + key.length);
    if (!/[0-9A-Z]/.test(hay[i - 1] ?? '') && !/^-?\d/.test(after)) return true;
  }
  return false;
}

// 같은 공고일인지: 둘 다 일까지 있으면 같은 날, 하나라도 달까지만 있으면 같은 달(site/app.js sameNoticeDate와 같다)
function sameNoticeDate(a, b) {
  const x = String(a ?? '').trim();
  const y = String(b ?? '').trim();
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (day.test(x) && day.test(y)) return x === y;
  const month = toMonth(x);
  return Boolean(month) && month === toMonth(y);
}

const rowKey = (block, rental) => `${blockKey(block)}|${rental ? 'rental' : 'sale'}`;
const isRentalNotice = (notice) => RENTAL_NOTICE_TYPES.includes(notice?.typeLabel);
const noticeStage = (notice) => (notice?.typeLabel === NOTICE_PRE_SUBSCRIPTION ? PRE_SUBSCRIPTION : MAIN_SUBSCRIPTION);
const latest = (values) => values.filter(Boolean).sort().at(-1) ?? null;

function cleanSources(list) {
  return (list ?? []).flatMap((source) => {
    const url = safeHttpUrl(source?.url);
    if (!url) return [];
    return [{
      title: source.title ?? url, url, date: source.date ?? null, ...(source.outlet ? { outlet: source.outlet } : {}),
    }];
  });
}

function dedupeSources(list) {
  const seen = new Set();
  return list.filter((source) => (seen.has(source.url) ? false : seen.add(source.url)));
}

// 연결된 공고가 어느 줄인지. 이력의 단지 이름(4글자 이상)이 공고명에 있으면 그 줄, 아니면 공고명에 블록 이름이 있는 줄.
// 분양 공고는 분양 줄, 임대 공고는 임대 줄에만 붙인다. 맞는 줄이 없으면 null(분양 이력 목록에는 그대로 보인다).
export function noticeRowKey(notice, rows) {
  const rental = isRentalNotice(notice);
  const candidates = rows.filter((row) => row.rental === rental);
  const name = compactName(notice?.name);
  const byTitle = candidates.find((row) => row.history.some((entry) => {
    const title = compactName(entry.title);
    return title.length >= 4 && name.includes(title);
  }));
  if (byTitle) return byTitle.key;
  const byBlock = candidates.find((row) => row.names.some((block) => nameHasBlock(notice?.name, block)));
  return byBlock ? byBlock.key : null;
}

// 계획이 그 줄에서 아직 공고 전인지. 같은 줄의 본청약 이력(오늘까지)이나 연결된 본청약 공고가 하한(계획 보도일,
// 없으면 지구의 블록별 분양 단계 날짜, 그것도 없으면 하한 없음)과 같거나 뒤면 공고가 난 것으로 본다(pendingPlans와 같은 규칙,
// 임대 계획은 임대 줄의 이력으로 본다).
function planPending(plan, row, { stageDate, today }) {
  const since = reportDate(plan) ?? (toMonth(stageDate) ? stageDate : null);
  const dates = [
    ...row.history.filter((entry) => entry.stage !== PRE_SUBSCRIPTION && (!today || onOrAfter(today, entry.noticeDate)))
      .map((entry) => entry.noticeDate),
    ...row.notices.filter((notice) => noticeStage(notice) !== PRE_SUBSCRIPTION).map((notice) => notice.announceDate),
  ].filter(Boolean);
  return !dates.some((date) => !since || onOrAfter(date, since));
}

function planHouseholdsFor(plan, block) {
  if (plan.householdsByBlock) {
    const hit = Object.entries(plan.householdsByBlock).find(([name]) => blockKey(name) === blockKey(block));
    return hit ? hit[1] : null;
  }
  return plan.blocks.length === 1 ? plan.households ?? null : null;
}

// 계획 출력: 기간 이름(expected)과 달 범위, 근거 출처(가장 최근 보도, 날짜 있는 출처가 없으면 첫 번째)
function publicPlan(plan) {
  const sources = cleanSources(plan.sources);
  const dated = sources.filter((item) => toMonth(item.date)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const source = dated[0] ?? sources[0] ?? null;
  return {
    expected: plan.expected, from: plan.from ?? null, to: plan.to ?? null, source,
  };
}

// 이력·공고로 정하는 상태. 없으면 null(계획·yaml 상태로 넘어감).
function noticeStatus(row, today) {
  const live = row.notices.filter((notice) => notice.end && notice.end >= today);
  if (live.length) return { status: LIVE, statusDate: latest(live.map((notice) => notice.end)) };
  const issued = [
    ...row.history.filter((entry) => entry.stage !== PRE_SUBSCRIPTION && onOrAfter(today, entry.noticeDate) !== false)
      .map((entry) => entry.noticeDate),
    ...row.notices.filter((notice) => noticeStage(notice) !== PRE_SUBSCRIPTION).map((notice) => notice.announceDate),
  ];
  if (!issued.length) return null;
  return { status: row.rental ? RENTAL_NOTICE : SOLD, statusDate: latest(issued) };
}

// 경과: 이력(사전청약·본청약)과 이력에 없는 연결 공고, 접수 중인 공고는 '접수 중'(날짜는 마감일). 날짜순.
function timelineOf(row, today) {
  const items = row.history.map((entry) => ({ stage: entry.stage, date: entry.noticeDate }));
  for (const notice of row.notices) {
    const stage = noticeStage(notice);
    const duplicate = row.history.some((entry) => entry.stage === stage && sameNoticeDate(entry.noticeDate, notice.announceDate));
    if (!duplicate && notice.announceDate) items.push({ stage, date: notice.announceDate });
    if (notice.end && notice.end >= today) items.push({ stage: LIVE, date: notice.end });
  }
  return items.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

const naturalBlock = (a, b) => String(a).localeCompare(String(b), 'ko', { numeric: true });

// 화면 정렬: 상태 순서, 같으면 블록 이름(숫자는 크기순), 같으면 분양 줄 먼저
export function compareBlocks(a, b) {
  return BLOCK_STATUS_ORDER.indexOf(a.status) - BLOCK_STATUS_ORDER.indexOf(b.status)
    || naturalBlock(a.block, b.block)
    || Number(a.rental) - Number(b.rental);
}

// 줄을 모은다: yaml blocks, 분양 이력, 계획의 블록. 이력·계획만 있는 블록도 줄이 된다.
function collectRows({ entries, history, plans }) {
  const rows = new Map();
  const rowFor = (block, rental) => {
    const key = rowKey(block, rental);
    if (!rows.has(key)) {
      rows.set(key, {
        key, rental: Boolean(rental), entry: null, history: [], notices: [], plans: [], names: [],
      });
    }
    const row = rows.get(key);
    if (!row.names.includes(block)) row.names.push(block);
    return row;
  };
  for (const entry of entries) rowFor(entry.block, entry.rental).entry = entry;
  for (const entry of history) rowFor(entry.block, entry.rental).history.push(entry);
  for (const plan of plans) for (const block of plan.blocks) rowFor(block, plan.rental).plans.push({ plan, block });
  return [...rows.values()];
}

/**
 * 블록별 현황 줄. 상태 규칙(앞이 먼저):
 * 1) 접수 중: 이 줄에 이어진 청약홈 공고의 접수가 오늘 이후까지(statusDate = 마감일)
 * 2) 분양 끝남(분양 줄)·임대 공고(임대 줄): 본청약 이력(오늘까지) 또는 접수가 끝난 연결 공고(statusDate = 가장 늦은 공고일)
 * 3) 다음 예정(보도): 아직 공고가 안 난 보도 계획(statusDate = 그 계획의 가장 최근 보도일, plan.source와 같은 출처)
 * 4) yaml status(착공·사업승인·계획 보도, statusDate = yaml statusDate)
 * 5) 미정
 * 사전청약은 상태를 바꾸지 않고 경과(timeline)에만 보인다.
 */
export function townBlocks({
  entries = [], history = [], plans = [], notices = [], stageDate = null, today,
}) {
  const rows = collectRows({ entries, history, plans });
  for (const notice of notices ?? []) {
    const key = noticeRowKey(notice, rows);
    if (key) rows.find((row) => row.key === key).notices.push(notice);
  }
  return rows.map((row) => {
    const pending = row.plans.filter(({ plan }) => planPending(plan, row, { stageDate, today }));
    const [next] = pending;
    const main = [...row.history].reverse().find((entry) => entry.stage !== PRE_SUBSCRIPTION) ?? row.history.at(-1) ?? null;
    const fromNotice = noticeStatus(row, today);
    let status;
    if (fromNotice) status = fromNotice;
    else if (next) status = { status: PLANNED, statusDate: publicPlan(next.plan).source?.date ?? null };
    else status = { status: row.entry?.status ?? UNDECIDED, statusDate: row.entry?.statusDate ?? null };
    const planInfo = row.plans[0] ?? null;
    const households = row.entry?.households ?? main?.households
      ?? row.plans.map(({ plan, block }) => planHouseholdsFor(plan, block)).find((n) => n !== null) ?? null;
    return {
      block: row.entry?.block ?? main?.block ?? row.names[0],
      type: row.entry?.type ?? main?.type ?? planInfo?.plan.type ?? null,
      households,
      rental: row.rental,
      status: status.status,
      statusDate: status.statusDate ?? null,
      timeline: timelineOf(row, today),
      plan: next ? publicPlan(next.plan) : null,
      note: row.entry?.note ?? null,
      sources: dedupeSources([
        ...cleanSources(row.entry?.sources),
        ...row.history.flatMap((entry) => cleanSources(entry.sources)),
        ...cleanSources(row.notices.map((notice) => ({
          title: notice.name || '청약홈 공고', url: notice.url, date: notice.announceDate ?? null, outlet: '청약홈',
        }))),
        ...row.plans.flatMap(({ plan }) => cleanSources(plan.sources)),
      ]),
    };
  }).sort(compareBlocks);
}

// 상태별 줄 수(상태 순서, 0은 뺀다)
export function blockSummary(blocks) {
  const counts = {};
  for (const status of BLOCK_STATUS_ORDER) {
    const n = blocks.filter((block) => block.status === status).length;
    if (n) counts[status] = n;
  }
  return counts;
}

// 지구 전체 블록 수(출처가 있을 때만). { total, approved, date, outlet, sources }
export function publicBlockTotal(blockTotal) {
  if (!blockTotal) return null;
  const sources = cleanSources(blockTotal.sources);
  return {
    total: blockTotal.total,
    approved: blockTotal.approved ?? null,
    date: blockTotal.date ?? null,
    outlet: sources.length ? sourceOutlet(sources[0]) : null,
    sources,
  };
}
