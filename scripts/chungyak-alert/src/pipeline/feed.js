import { createHash } from 'node:crypto';
import { addDays, safeHttpUrl } from '../util.js';
import {
  PRE_SUBSCRIPTION, blockKey, compactName, isRentalNotice, onOrAfter,
} from './expected-window.js';

// 새 소식(feed)과 청약 달력(calendar)을 만든다. 모두 순수 함수이고 build-map이 공고 연결·블록별 현황 뒤에 부른다.
// 소식 구분: 공고(연결된 청약홈 공고), 접수(접수 중이거나 14일 안에 시작하는 공고), 뉴스(data/news.yaml),
// 일정(지구의 보도된 블록 계획과 공고로 덮이지 않은 분양 이력), 단계(이전 배포 대비 단계 변경).

export const FEED_KINDS = ['공고', '접수', '뉴스', '일정', '단계'];
// 여러 블록을 덮는 소식의 block 값은 블록 이름을 '·'로 잇는다('A9·A11')
export const BLOCK_JOIN = '·';
// 서울 사업 소식의 건수·기간 제한(공공주택지구 소식에는 적용하지 않는다)
export const FEED_MAX = 200;
export const FEED_DAYS = 400;
// 단계 소식: 이전 배포에서 이어 두는 기간(일)과 서울 사업 단계 소식의 최대 건수. 분기마다 서울 자료가 바뀌면 수십 건이 한꺼번에 생겨
// 다른 소식을 밀어내지 않게 FEED_MAX보다 먼저 자른다.
export const STAGE_CARRY_DAYS = 90;
export const STAGE_MAX = 50;
export const RECEPTION_SOON_DAYS = 14;
export const CALENDAR_DAYS = 45;
// 달력 라벨. 1순위 해당·경기·기타는 1순위로, 무순위·임의·재공급·일반공급 접수는 접수로 묶는다.
export const CALENDAR_LABELS = ['특별공급', '1순위', '2순위', '접수', '당첨자 발표'];
// 한 단계가 이 날 수보다 길면 달력에는 앞쪽만 찍는다(잘못된 기간이 달력을 덮지 않게)
const MAX_STAGE_DAYS = 31;
// 지역지. 소식과 출처에 지역지라고 표시한다.
export const LOCAL_OUTLETS = ['하남일보', '하남Times'];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value) => DAY.test(String(value ?? ''));

const KST_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

// 수집 시각: '2026-11-10T07:30:00+09:00'
export function kstDateTime(now = new Date()) {
  const p = Object.fromEntries(KST_PARTS.formatToParts(now).map((part) => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+09:00`;
}

// 빌드마다 같은 값이 나오는 소식 id(구분·사업·블록·날짜·제목의 해시). 화면이 읽은 소식을 기억하는 데 쓴다.
export function feedId({
  kind, projectId, block = null, date, title,
}) {
  return createHash('sha256').update(JSON.stringify([kind, projectId, block ?? null, date, title])).digest('hex').slice(0, 16);
}

// 공고명에서 블록 이름을 읽는다: '구리갈매역세권 B-1블록 …' -> 'B-1', '교산 … (A-2BL)' -> 'A-2', 'A4블록' -> 'A4'.
// 영문 1~2자 + 숫자(가운데 '-' 허용) 뒤가 BL·블록·영숫자 아닌 글자·끝일 때만. 없으면 null.
export function parseBlock(name) {
  const value = String(name ?? '').toUpperCase().replace(/\s+/g, ' ');
  const match = /(?<![0-9A-Z-])([A-Z]{1,2}-?\d{1,3}(?:-\d+)?)(?=BL|블록|[^0-9A-Z-]|$)/.exec(value);
  return match ? match[1] : null;
}

// 지구 블록 표기로 맞춘다(블록별 현황 줄 이름). 맞는 줄이 없으면 그대로.
function townBlockName(block, project) {
  const key = blockKey(block);
  const row = (project.blocks ?? []).find((item) => blockKey(item.block) === key);
  return row ? row.block : block;
}

// 공공주택지구 공고의 블록: 공고명의 블록 이름, 없으면 분양 이력의 단지 이름(4글자 이상)이 공고명에 있는 이력의 블록.
// 서울 사업과 못 찾은 공고는 null.
export function noticeBlock(notice, project) {
  if (project.region === '서울') return null;
  const parsed = parseBlock(notice?.name);
  if (parsed) return townBlockName(parsed, project);
  const name = compactName(notice?.name);
  const entry = (project.history ?? []).find((item) => {
    const title = compactName(item.title);
    return title.length >= 4 && name.includes(title);
  });
  return entry ? townBlockName(entry.block, project) : null;
}

// 임대 공고: 청약홈 임대 유형(민간임대 등), 유형이나 공고명에 '임대'·'행복주택'이 있는 공고
export function isRentalItem(notice) {
  return isRentalNotice(notice);
}

// 단계 이름 -> 달력 라벨
export function stageLabel(name) {
  const value = String(name ?? '');
  if (value.startsWith('특별공급')) return '특별공급';
  if (value.startsWith('1순위')) return '1순위';
  if (value.startsWith('2순위')) return '2순위';
  return '접수';
}

// 단계가 걸친 날짜들(끝이 없으면 시작일 하루)
function stageDays(stage) {
  const days = [];
  const end = isDay(stage.end) && stage.end >= stage.start ? stage.end : stage.start;
  for (let day = stage.start; day <= end && days.length < MAX_STAGE_DAYS; day = addDays(day, 1)) days.push(day);
  return days;
}

const validStages = (notice) => (notice?.stages ?? []).filter((stage) => stage && isDay(stage.start));

// 공고의 접수 기간(모든 단계의 첫 시작 ~ 공고 마감, 마감이 없으면 단계의 마지막 날)
function receptionRange(notice) {
  const stages = validStages(notice);
  if (stages.length === 0) return null;
  const start = stages.map((stage) => stage.start).sort()[0];
  const ends = stages.map((stage) => (isDay(stage.end) ? stage.end : stage.start)).sort();
  const end = isDay(notice.end) ? notice.end : ends.at(-1);
  return { start, end };
}

const stageEnd = (stage) => (isDay(stage.end) && stage.end >= stage.start ? stage.end : stage.start);

// 단계 묶음의 이름: 특별공급·1순위·2순위, 그 밖은 단계 이름에서 '접수'를 뺀 것('무순위 접수' -> '무순위'), 비면 '청약'
function groupName(label, stage) {
  if (label !== '접수') return label;
  return String(stage.name).replace(/\s*접수$/, '') || '청약';
}

// 라벨(특별공급·1순위·2순위·접수)별 단계 묶음 { label, name, start, end }, 시작순
function stageGroups(stages) {
  const groups = new Map();
  for (const stage of [...stages].sort((a, b) => a.start.localeCompare(b.start))) {
    const label = stageLabel(stage.name);
    const group = groups.get(label);
    if (!group) groups.set(label, { label, name: groupName(label, stage), start: stage.start, end: stageEnd(stage) });
    else if (stageEnd(stage) > group.end) group.end = stageEnd(stage);
  }
  return [...groups.values()].sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * 접수 소식 한 건: 접수 중(첫 단계 시작 <= 오늘 <= 마감)이거나 14일 안에 시작하는 공고만.
 * 날짜는 1순위 시작일(1순위가 없으면 첫 '접수' 단계, 그것도 없으면 첫 단계)로 빌드마다 같다.
 * 제목은 오늘이 든 단계, 없으면 다음 단계(모두 지났으면 마지막 단계): '<단계> 접수, 전체 마감 <공고 마감일>'.
 * 제목이 날마다 바뀌므로 접수 소식의 id는 제목 대신 공고 key로 만든다(noticeItems).
 */
export function receptionItem(notice, today) {
  const range = receptionRange(notice);
  if (!range || range.end < today || range.start > addDays(today, RECEPTION_SOON_DAYS)) return null;
  const groups = stageGroups(validStages(notice));
  const main = groups.find((group) => group.label === '1순위') ?? groups.find((group) => group.label === '접수') ?? groups[0];
  const current = groups.find((group) => group.start <= today && today <= group.end)
    ?? groups.find((group) => group.start > today) ?? groups.at(-1);
  return { date: main.start, title: `${current.name} 접수, 전체 마감 ${range.end}` };
}

// 사업 하나의 달력 일정(연결된 공고의 단계별 날짜와 당첨자 발표일). 기간 거르기는 buildCalendar가 한다.
export function noticeEvents(project) {
  return (project.notices ?? []).flatMap((notice) => {
    const base = {
      projectId: project.id,
      block: noticeBlock(notice, project),
      title: notice.name ?? '',
      rental: isRentalItem(notice),
      url: safeHttpUrl(notice.url),
    };
    const seen = new Set();
    const events = [];
    for (const stage of validStages(notice)) {
      const label = stageLabel(stage.name);
      for (const date of stageDays(stage)) {
        const key = `${date}|${label}`;
        if (!seen.has(key)) {
          seen.add(key);
          events.push({ date, ...base, label });
        }
      }
    }
    if (isDay(notice.winnerDate)) events.push({ date: notice.winnerDate, ...base, label: '당첨자 발표' });
    return events.map(({
      date, projectId, block, label, title, rental, url,
    }) => ({
      date, projectId, block, label, title, rental, url,
    }));
  });
}

const byCalendar = (a, b) => a.date.localeCompare(b.date)
  || CALENDAR_LABELS.indexOf(a.label) - CALENDAR_LABELS.indexOf(b.label)
  || a.projectId.localeCompare(b.projectId)
  || a.title.localeCompare(b.title);

// 오늘부터 days일(오늘 포함) 안의 일정, 날짜순
export function buildCalendar(projects, today, { days = CALENDAR_DAYS } = {}) {
  const last = addDays(today, days - 1);
  return projects.flatMap(noticeEvents).filter((event) => event.date >= today && event.date <= last).sort(byCalendar);
}

function isLocalSource(source) {
  const outlet = String(source?.outlet ?? '');
  return LOCAL_OUTLETS.includes(outlet) || String(source?.title ?? '').includes('지역지');
}

function feedSource(source) {
  return {
    title: String(source?.title ?? ''),
    url: safeHttpUrl(source?.url),
    date: isDay(source?.date) ? source.date : null,
    local: isLocalSource(source),
  };
}

// idTitle: id에 제목 대신 쓸 값(제목이 날마다 바뀌는 접수 소식)
function item({
  kind, date, projectId, block = null, title, source, rental = false, idTitle = title,
}) {
  return {
    id: feedId({
      kind, projectId, block, date, title: idTitle,
    }),
    date,
    kind,
    projectId,
    block: block ?? null,
    title,
    rental: Boolean(rental),
    source,
  };
}

// 공고·접수 소식
export function noticeItems(project, today) {
  return (project.notices ?? []).flatMap((notice) => {
    const block = noticeBlock(notice, project);
    const rental = isRentalItem(notice);
    const source = {
      title: '청약홈', url: safeHttpUrl(notice.url), date: isDay(notice.announceDate) ? notice.announceDate : null, local: false,
    };
    const items = [];
    if (isDay(notice.announceDate)) {
      items.push(item({
        kind: '공고', date: notice.announceDate, projectId: project.id, block, title: `청약홈 공고: ${notice.name}`, source, rental,
      }));
    }
    const reception = receptionItem(notice, today);
    if (reception) {
      items.push(item({
        kind: '접수',
        date: reception.date,
        projectId: project.id,
        block,
        title: reception.title,
        source,
        rental,
        idTitle: `접수:${notice.key ?? notice.name ?? ''}`,
      }));
    }
    return items;
  });
}

// 계획 출처 중 날짜가 가장 이른 것(보도된 날). 날짜 있는 출처가 없으면 null.
function earliestSource(sources) {
  return (sources ?? []).filter((source) => isDay(source?.date) && safeHttpUrl(source?.url))
    .sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;
}

// 보도된 블록 계획 -> 일정 소식(계획 하나에 한 건, 여러 블록이면 block 'A9·A11', 날짜는 가장 이른 보도일). 지역지 보도는 제목에 '(지역지)'.
export function planItems(project) {
  return (project.plans ?? []).flatMap((plan) => {
    const source = earliestSource(plan.sources);
    if (!source) return [];
    const local = isLocalSource(source);
    // 제목의 블록 이름도 지구 화면 표기로('B2' -> 'B-2')
    const blocks = (plan.blocks ?? []).map((block) => townBlockName(block, project));
    const words = [blocks.join(BLOCK_JOIN), plan.type, plan.expected, '공급 예정 보도'].filter(Boolean).join(' ');
    const title = local ? `${words} (지역지)` : words;
    // 여러 블록 계획도 소식은 한 건(block = 'A9·A11'). 화면은 '·'로 나눠 블록마다 거른다.
    return blocks.length ? [item({
      kind: '일정', date: source.date, projectId: project.id, block: blocks.join(BLOCK_JOIN), title, source: feedSource(source), rental: plan.rental,
    })] : [];
  });
}

// 같은 공고인지: 같은 블록·같은 분양/임대이고 공고일이 같다(한쪽이 달까지만 있으면 같은 달)
function coveredByNotice(entry, project) {
  const key = blockKey(entry.block);
  return (project.notices ?? []).some((notice) => {
    const block = noticeBlock(notice, project);
    if (!block || blockKey(block) !== key || isRentalItem(notice) !== (entry.rental === true)) return false;
    if (isDay(entry.noticeDate) && isDay(notice.announceDate)) return entry.noticeDate === notice.announceDate;
    return onOrAfter(entry.noticeDate, notice.announceDate) === true && onOrAfter(notice.announceDate, entry.noticeDate) === true;
  });
}

// 분양 이력 -> 일정 소식. 연결된 청약홈 공고가 이미 있는 이력과 날짜가 달까지만 있는 이력은 뺀다.
export function historyItems(project) {
  return (project.history ?? []).flatMap((entry) => {
    if (!isDay(entry.noticeDate) || coveredByNotice(entry, project)) return [];
    const source = (entry.sources ?? []).find((src) => safeHttpUrl(src?.url));
    if (!source) return [];
    let stage = '본청약';
    if (entry.stage === PRE_SUBSCRIPTION) stage = PRE_SUBSCRIPTION;
    else if (entry.rental) stage = '입주자 모집';
    const households = Number.isFinite(entry.households) ? ` (${entry.households.toLocaleString('ko-KR')}세대)` : '';
    const block = townBlockName(entry.block, project);
    const title = `${[block, entry.type, stage].filter(Boolean).join(' ')} 공고${households}`;
    return [item({
      kind: '일정', date: entry.noticeDate, projectId: project.id, block, title, source: feedSource(source), rental: entry.rental,
    })];
  });
}

// news.yaml 기사(resolveNews 뒤) -> 뉴스(또는 일정) 소식. 출처 제목은 매체 이름.
export function newsItems(news) {
  return (news ?? []).map((entry) => item({
    kind: entry.kind ?? '뉴스',
    date: entry.date,
    projectId: entry.projectId,
    block: entry.block,
    title: entry.title,
    rental: entry.rental,
    source: {
      title: entry.outlet, url: safeHttpUrl(entry.url), date: entry.date, local: entry.local === true || LOCAL_OUTLETS.includes(entry.outlet),
    },
  }));
}

// 단계 변경 -> 단계 소식(오늘 날짜). 출처는 sourceFor(project)가 준다(서울 사업은 서울시 정비사업 자료).
export function changeItems(changes, projects, today, sourceFor = () => null) {
  const byId = new Map(projects.map((project) => [project.id, project]));
  return (changes ?? []).flatMap((change) => {
    const project = byId.get(change.projectId);
    if (!project) return [];
    const source = sourceFor(project);
    return [item({
      kind: '단계',
      date: today,
      projectId: project.id,
      title: `단계 변경: ${change.from} → ${change.to}`,
      source: source ? feedSource(source) : {
        title: '', url: null, date: null, local: false,
      },
    })];
  });
}

// 이전 배포의 단계 소식을 이어 둔다(단계 변경은 그 빌드에서만 보이므로). 최근 90일, 지금도 있는 사업의 것만, 필드는 다시 검사한다.
export function carriedStageItems(previousFeed, projects, today) {
  const ids = new Set(projects.map((project) => project.id));
  const from = addDays(today, -STAGE_CARRY_DAYS);
  return (Array.isArray(previousFeed) ? previousFeed : []).flatMap((entry) => {
    if (entry?.kind !== '단계' || !ids.has(entry.projectId) || !isDay(entry.date) || entry.date > today || entry.date < from) return [];
    const title = String(entry.title ?? '');
    if (!title.startsWith('단계 변경: ')) return [];
    return [item({
      kind: '단계', date: entry.date, projectId: entry.projectId, title, source: feedSource(entry.source),
    })];
  });
}

const KIND_ORDER = ['단계', '접수', '공고', '뉴스', '일정'];

const byFeed = (a, b) => b.date.localeCompare(a.date)
  || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
  || a.projectId.localeCompare(b.projectId)
  || a.title.localeCompare(b.title)
  || a.id.localeCompare(b.id);

// 같은 기사를 두 번 보이지 않게: 지구의 일정 소식(이력·계획)이 같은 사업·블록의 news.yaml 기사와 같은 주소를 출처로 쓰면
// 일정 소식을 뺀다(우리가 쓴 기사 요약이 더 많은 사실을 담는다). 날짜는 보지 않는다(이력은 공고일, 기사는 보도일이라 하루 다를 수 있다).
const sourceKey = (entry) => `${entry.projectId}|${blockKey(entry.block)}|${entry.source?.url ?? ''}`;

// items의 news.yaml 기사에는 fromNews: true가 붙어 있다
export function dropCoveredSchedules(items) {
  const cited = new Set(items.filter((entry) => entry.fromNews).map(sourceKey));
  return items.filter((entry) => entry.kind !== '일정' || entry.fromNews || !entry.source?.url || !cited.has(sourceKey(entry)));
}

/**
 * 새 소식. 최신순. 오늘 뒤 날짜는 접수 소식만(곧 시작하는 접수).
 * 서울 사업 소식은 최근 400일(오늘 포함), 최대 200건(그중 단계 소식은 최신 50건까지). 공공주택지구 소식은 블록별 경과를 지구 화면에 다 보이도록 날짜·건수 제한 없이 둔다(지구는 몇 곳뿐).
 * 같은 id는 한 번만, 기사와 같은 출처를 쓰는 일정 소식은 뺀다(dropCoveredSchedules).
 * projects는 공고 연결·블록별 현황 뒤의 내부 사업(계획·이력 출처가 남아 있는 것).
 */
export function buildFeed({
  projects, news = [], changes = [], carried = [], today, sourceFor,
}) {
  const from = addDays(today, -FEED_DAYS);
  const towns = new Set(projects.filter((project) => project.kind === '공공주택지구').map((project) => project.id));
  const all = [
    ...changeItems(changes, projects, today, sourceFor),
    ...carried,
    ...projects.flatMap((project) => [...noticeItems(project, today), ...planItems(project), ...historyItems(project)]),
    ...newsItems(news).map((entry) => ({ ...entry, fromNews: true })),
  ];
  const seen = new Set();
  let seoulStages = 0;
  let seoul = 0;
  return dropCoveredSchedules(all)
    .map(({ fromNews, ...entry }) => entry)
    .filter((entry) => (entry.date <= today || entry.kind === '접수') && (towns.has(entry.projectId) || entry.date >= from))
    .filter((entry) => (seen.has(entry.id) ? false : seen.add(entry.id)))
    .sort(byFeed)
    // 서울 단계 소식은 최신 50건까지 먼저 자르고, 남은 서울 소식 전체를 200건으로 자른다
    .filter((entry) => towns.has(entry.projectId) || entry.kind !== '단계' || (seoulStages += 1) <= STAGE_MAX)
    .filter((entry) => towns.has(entry.projectId) || (seoul += 1) <= FEED_MAX);
}
