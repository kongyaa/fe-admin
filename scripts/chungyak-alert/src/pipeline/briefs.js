import { safeHttpUrl } from '../util.js';
import { PLANNED, PLAN_PASSED } from './blocks.js';
import {
  PRE_SUBSCRIPTION, blockKey, nameHasBlock, sourceOutlet,
} from './expected-window.js';
import { SEOUL_DISTRICTS } from './news.js';
import { DATASET_URL, SEOUL_STAGES } from './seoul-redevelop.js';

// 지역 브리핑: 첫 화면 지역 현황에서 서울 구나 관심 지구(watchlist)를 고르면 사업 목록 위에 보이는 짧은 글.
// 순수 함수만 둔다. 문장은 정해진 틀에 자료의 숫자·이름만 넣어 만든다(평가·전망 문장을 새로 짓지 않는다).
// - 서울 구: 서울시 정비사업 자료(단계·예상 시기), 청약홈 연결 공고, 네이버 관련 소식으로 만든다.
//   네이버 기사는 약관상 제목을 바꿔 쓸 수 없어 '<사업> 관련 소식(<언론사>, <MM.DD>)'로만 적는다.
// - 공공주택지구: newtowns.yaml(분양 이력·계획·블록)과 news.yaml(손으로 고른 기사)의 출처 있는 사실만 쓰고,
//   문장마다 출처 번호(각주)를 단다. 추적하지 않는 지구(watchlist의 tracked: false)는 브리핑이 없다.
// 출력: { [구 이름 | 지구 사업 id]: { headline, paras: [[{ t, b?, note? }]], foot: [{ label, url }], basis } }
// - paras는 문단 목록, 문단은 조각 목록이다. b: 굵게, note: 각주 번호(t가 '1'처럼 foot의 번호).
// - foot의 url은 safeHttpUrl을 거친 http(s) 주소 또는 null.

export const SEOUL_BRIEF_BASIS = '자동 작성: 서울시 정비사업 자료와 청약홈·뉴스 수집 결과로 문장을 만듭니다. 평가나 전망은 넣지 않습니다.';
export const TOWN_BRIEF_BASIS = '신도시 목록에 출처와 함께 적은 블록·계획·보도로 작성했습니다. 위 숫자는 각 출처를 가리킵니다.';
export const NAVER_FOOT = '네이버 뉴스 검색 결과로 사업별 최근 기사의 언론사와 날짜만 사용';
export const APPLYHOME_URL = 'https://www.applyhome.co.kr/';

// 1년 안(공고 중 포함)과 3년 안 구간. expected-window.js의 BUCKETS 값이다.
const SOON_BUCKETS = ['live', 'soon'];
const LATE_FROM = SEOUL_STAGES.indexOf('관리처분인가');
const EARLY_TO = SEOUL_STAGES.indexOf('조합설립');
// 지구 브리핑의 지구 전체 기사 수(P3)
export const TOWN_ITEMS_MAX = 2;

const T = (t) => ({ t });
const B = (t) => ({ t, b: true });

// 마지막 한글 글자에 받침이 있으면 withFinal, 없으면 without. 끝의 괄호·숫자·기호는 건너뛴다('공공분양(지분적립형 284 포함)' -> '함').
// 한글이 없으면 without.
export function josa(word, withFinal, without) {
  const hangul = String(word ?? '').match(/[가-힣]/g);
  if (!hangul) return without;
  return (hangul.at(-1).charCodeAt(0) - 0xac00) % 28 ? withFinal : without;
}

// '2026-11-06' -> '11월 6일', '2026-03' -> '2026년 3월'
export function dayLabel(ymd) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(ymd ?? ''));
  return m ? `${Number(m[1])}월 ${Number(m[2])}일` : null;
}

export function monthLabel(value) {
  const m = /^(\d{4})-(\d{2})/.exec(String(value ?? ''));
  return m ? `${m[1]}년 ${Number(m[2])}월` : null;
}

// 계획 시기 표기: '2026-하반기' -> '2026년 하반기', '2026-11' -> '2026년 11월'
export function expectedLabel(expected) {
  const value = String(expected ?? '').trim();
  const half = /^(\d{4})-(상반기|하반기)$/.exec(value);
  if (half) return `${half[1]}년 ${half[2]}`;
  return monthLabel(value) ?? value;
}

const fmt = (n) => Number(n).toLocaleString('ko-KR');
const rateText = (rate) => `${Number(rate).toLocaleString('ko-KR', { maximumFractionDigits: 2 })} 대 1`;
// 문장 끝: 마침표가 없으면 붙인다
const sentence = (text) => {
  const value = String(text ?? '').trim();
  return /[.!?]$/.test(value) ? value : `${value}.`;
};

// --- 서울 구 ---------------------------------------------------------------------

const stageIndex = (project) => SEOUL_STAGES.indexOf(project.stage);
const byWindow = (a, b) => String(a.window?.from ?? '9999').localeCompare(String(b.window?.from ?? '9999'))
  || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ko');

// 구별 숫자: { t, s(1년 안), mid(1~3년 사이), late, early, rank, tied, live(공고 중 사업), soon(1년 안 사업, 예상 시기 순) }
// rank는 1년 안 사업 수가 더 많은 구의 수 + 1, tied는 1년 안 사업 수가 같은 다른 구가 있는지(공동 순위).
export function districtStats(projects) {
  const seoul = (projects ?? []).filter((p) => p?.region === '서울' && p.kind !== '공공주택지구');
  const stats = new Map();
  for (const district of SEOUL_DISTRICTS) {
    const all = seoul.filter((p) => p.district === district);
    const soon = all.filter((p) => SOON_BUCKETS.includes(p.bucket)).sort(byWindow);
    stats.set(district, {
      all,
      t: all.length,
      s: soon.length,
      mid: all.filter((p) => p.bucket === 'mid').length,
      late: all.filter((p) => stageIndex(p) >= LATE_FROM).length,
      early: all.filter((p) => stageIndex(p) >= 0 && stageIndex(p) <= EARLY_TO).length,
      live: all.filter((p) => p.bucket === 'live').sort(byWindow),
      soon,
    });
  }
  for (const st of stats.values()) {
    st.rank = 1 + [...stats.values()].filter((other) => other.s > st.s).length;
    st.tied = [...stats.values()].filter((other) => other.s === st.s).length > 1;
  }
  return stats;
}

// 구의 가장 최근 청약홈 공고 { project, notice }(공고일 순)
function latestNotice(all) {
  const rows = all.flatMap((p) => (p.notices ?? []).filter((n) => n?.name && /^\d{4}-\d{2}-\d{2}$/.test(String(n.announceDate ?? '')))
    .map((notice) => ({ project: p, notice })));
  return rows.sort((a, b) => b.notice.announceDate.localeCompare(a.notice.announceDate)
    || String(a.notice.key).localeCompare(String(b.notice.key)))[0] ?? null;
}

// 구의 가장 최근 네이버 관련 소식 { project, item }(사업의 news, 날짜 순)
function latestNaver(all) {
  const rows = all.flatMap((p) => (p.news ?? []).filter((item) => item?.date).map((item) => ({ project: p, item })));
  return rows.sort((a, b) => String(b.item.date).localeCompare(String(a.item.date))
    || String(a.project.name).localeCompare(String(b.project.name), 'ko'))[0] ?? null;
}

/**
 * 서울 구 하나의 브리핑. 사업이 없는 구는 null.
 * stats는 districtStats의 값, seoulAsOf는 서울 자료 기준 달, today는 수집일.
 * newsSearched: 네이버 검색이 성공한 사업 id(Set). null이면 이번 빌드에서 관련 소식을 모으지 않은 것이라 기사 문장과 각주를 빼고,
 * 이 구의 사업이 하나도 검색되지 않았으면 '모은 기사가 없다'고 말하지 않는다. 평가·전망 없이 수만 적는다.
 */
export function districtBrief(district, stats, { seoulAsOf = null, today = null, newsSearched = null } = {}) {
  const st = stats.get(district);
  if (!st || st.t === 0) return null;
  const g = district;
  const firstNames = st.soon.slice(0, 2).map((p) => p.name);
  let headline;
  if (st.live.length) headline = `${g}, ${st.live[0].name} 청약 공고 중`;
  else if (st.s >= 6) {
    let place = st.rank === 1 ? '가장 많다' : `${st.rank}번째`;
    if (st.tied) place = st.rank === 1 ? '공동으로 가장 많다' : `공동 ${st.rank}번째`;
    headline = `${g}, 1년 안 청약 ${st.s}곳으로 서울에서 ${place}`;
  } else if (st.s > 0) headline = `${g}, 1년 안 청약 ${st.s}곳 ${firstNames[0]} 먼저`;
  else if (st.early > 0) headline = `${g}, 1년 안 청약 없이 초기 단계 ${st.early}곳`;
  else headline = `${g}, 1년 안 청약 예상 없음`;

  const p1 = [T(`${g} 정비사업 ${st.t}곳 중 청약 예상 시기는 1년 안 `), B(`${st.s}곳`), T(`, 1~3년 사이 ${st.mid}곳입니다. `)];
  const LATE = '관리처분인가 이후(이주·착공 포함)';
  const EARLY = '초기 단계(구역지정~조합설립)';
  if (st.late > 0 && st.early > 0) p1.push(T(`${LATE} ${st.late}곳, ${EARLY} ${st.early}곳입니다.`));
  else if (st.late > 0) p1.push(T(`${LATE} ${st.late}곳이고, ${EARLY} 사업은 없습니다.`));
  else if (st.early > 0) p1.push(T(`${LATE} 사업은 없고, ${EARLY} ${st.early}곳입니다.`));
  else p1.push(T(`${LATE} 사업과 ${EARLY} 사업은 없습니다.`));

  const p2 = [];
  if (st.s > 0) {
    const big = st.soon.filter((p) => Number.isFinite(p.households) && p.households > 0)
      .sort((a, b) => b.households - a.households || byWindow(a, b))[0];
    if (big) p2.push(T('1년 안 사업 중 계획 세대가 가장 큰 곳은 '), B(big.name), T(`(${fmt(big.households)}세대, ${big.stage})입니다. `));
    if (firstNames.length) p2.push(T('예상 시기가 가장 이른 곳은 '), B(firstNames.join(', ')), T('입니다. '));
    const dosi = st.soon.filter((p) => /도시정비형/.test(p.subKind ?? '')).length;
    const rebuild = st.soon.filter((p) => p.kind === '재건축').length;
    if (dosi > 0) p2.push(T(`1년 안 사업 ${st.s}곳 중 ${dosi}곳은 도시정비형(도심 업무지구형) 재개발입니다.`));
    else if (rebuild === st.s) p2.push(T('1년 안 사업은 모두 재건축입니다.'));
  }

  const p3 = [];
  const notice = latestNotice(st.all);
  if (notice) {
    p3.push(T('최근 청약홈 공고는 '), B(notice.notice.name), T(`(${notice.project.name}, ${dayLabel(notice.notice.announceDate)})였습니다. `));
  }
  const naver = newsSearched ? latestNaver(st.all) : null;
  if (naver) {
    const when = naver.item.date.slice(5).replace('-', '.');
    const meta = naver.item.outlet ? `${naver.item.outlet}, ${when}` : when;
    p3.push(T(`최근 2주 기사 중에는 ${naver.project.name} 관련 소식(${meta})이 가장 최근입니다.`));
  } else if (newsSearched && st.all.some((p) => newsSearched.has(p.id))) p3.push(T('최근 2주 사이 모은 기사는 없습니다.'));

  const collected = /^\d{4}-\d{2}-\d{2}$/.test(String(today ?? '')) ? ` (${today.slice(5)} 수집)` : '';
  return {
    headline,
    paras: [p1, p2, p3].filter((p) => p.length),
    foot: [
      { label: `서울시 정비사업 추진현황${seoulAsOf ? ` (${seoulAsOf} 기준)` : ''}`, url: DATASET_URL },
      { label: `청약홈 공고 연결${collected}`, url: APPLYHOME_URL },
      ...(newsSearched ? [{ label: NAVER_FOOT, url: null }] : []),
    ],
    basis: SEOUL_BRIEF_BASIS,
  };
}

// --- 공공주택지구 ---------------------------------------------------------------

// 각주 모음: 같은 주소는 같은 번호. add(source)는 번호 조각({ t: '1', note: true }) 또는 null(주소 없음)
function footnotes() {
  const foot = [];
  const add = (source) => {
    const url = safeHttpUrl(source?.url);
    if (!url) return null;
    let index = foot.findIndex((f) => f.url === url);
    if (index < 0) {
      const outlet = sourceOutlet(source);
      const local = /지역지/.test(`${outlet} ${source.title ?? ''}`) || source.local === true;
      const name = outlet.replace(/,?\s*지역지$/, '').trim() || '출처';
      foot.push({ label: [name, source.date ?? null].filter(Boolean).join(' ') + (local ? ' (지역지)' : ''), url });
      index = foot.length - 1;
    }
    return { t: String(index + 1), note: true };
  };
  return { foot, add };
}

const newestSource = (sources) => [...(sources ?? [])].filter((s) => safeHttpUrl(s?.url))
  .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))[0] ?? null;

// 기사 한 건 -> 출처 형태
const itemSource = (item) => ({ title: item.outlet, outlet: item.outlet, url: item.url, date: item.date, local: item.local });

// 지구 브리핑의 기사(news.yaml): 이 지구 것만, 최신순
const townItems = (curated, project) => (curated ?? []).filter((item) => item?.projectId === project.id)
  .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.url).localeCompare(String(b.url)));

const itemHasBlock = (item, block) => String(item.block ?? '').split('·').some((name) => blockKey(name) === blockKey(block));

// 지금 접수 중인 연결 공고 { block, winnerDate }(마지막 접수일이 이른 순). 접수 단계가 오늘에 걸쳐야 한다.
export function openReception(project, today) {
  const rows = [];
  for (const notice of project.notices ?? []) {
    const stages = (notice.stages ?? []).filter((s) => s?.start && !/당첨|발표|계약/.test(s.name ?? ''));
    const now = stages.find((s) => s.start <= today && today <= (s.end ?? s.start));
    if (!now) continue;
    const block = (project.blocks ?? []).find((row) => (row.sources ?? []).some((src) => src.url && src.url === notice.url))?.block ?? null;
    rows.push({ notice, block, end: stages.map((s) => s.end ?? s.start).sort().at(-1), winnerDate: notice.winnerDate ?? null });
  }
  return rows.sort((a, b) => a.end.localeCompare(b.end))[0] ?? null;
}

// 아직 공고가 나지 않은 계획(블록 줄이 다음 예정·예정 지남인 것), 임대 아닌 것.
// 기간이 남은 계획이 먼저(시작 달이 이른 순), 기간이 지난 계획(passed)은 뒤.
function pendingPlans(project, today) {
  const month = String(today ?? '').slice(0, 7);
  const waiting = new Set((project.blocks ?? []).filter((row) => !row.rental && [PLANNED, PLAN_PASSED].includes(row.status))
    .map((row) => blockKey(row.block)));
  return (project.plans ?? []).filter((plan) => !plan.rental && plan.blocks.some((block) => waiting.has(blockKey(block))))
    .map((plan) => ({ ...plan, passed: Boolean(month && plan.to && plan.to < month) }))
    .sort((a, b) => Number(a.passed) - Number(b.passed) || String(a.from).localeCompare(String(b.from)) || a.blocks[0].localeCompare(b.blocks[0]));
}

function planBlocksText(plan) {
  const by = plan.householdsByBlock;
  if (by && plan.blocks.every((block) => Number.isFinite(by[block]))) return plan.blocks.map((block) => `${block}(${fmt(by[block])}세대)`).join('·');
  const joined = plan.blocks.join('·');
  return Number.isFinite(plan.households) ? `${joined}(${fmt(plan.households)}세대)` : joined;
}

// 가장 최근 본청약 묶음: 임대 아닌 분양 이력(오늘까지) 중 공고일이 가장 늦은 날의 이력 모두(같은 날 공고된 블록들). 없으면 []
export function latestMains(project, today) {
  const mains = (project.history ?? []).filter((e) => e.stage !== PRE_SUBSCRIPTION && !e.rental && String(e.noticeDate) <= String(today));
  const last = mains.map((e) => String(e.noticeDate)).sort().at(-1);
  return last ? mains.filter((e) => String(e.noticeDate) === last) : [];
}

// 이력 제목에 블록 이름이 이미 있는지('남양주왕숙2 A03'은 A-3, '카이브 유보라(AC4BL)'는 AC4). 블록 번호 앞자리 0은 무시한다.
export function titleHasBlock(title, block) {
  if (!title) return false;
  if (nameHasBlock(title, block)) return true;
  // 공백으로 떨어진 블록 표기('남양주왕숙2 A03')는 낱말 하나씩 본다
  const plain = (value) => blockKey(value).replace(/^([A-Z]+)0+(?=\d)/, '$1');
  const want = plain(block);
  return String(title).split(/[\s()[\],·/]+/).some((word) => /^[A-Za-z]{1,2}-?\d/.test(word) && plain(word) === want);
}

// 본청약 한 건의 괄호 설명: 제목에 블록 이름이 없으면 제목, 있으면 유형, 그리고 세대 수. '(교산 푸르지오 더 퍼스트, 1,115세대)'
function mainDetail(entry) {
  const what = entry.title && !titleHasBlock(entry.title, entry.block) ? entry.title : entry.type;
  const parts = [what, entry.households ? `${fmt(entry.households)}세대` : null].filter(Boolean);
  return parts.length ? `(${parts.join(', ')})` : '';
}

// 그 블록 줄의 경쟁률: 분양 성과(청약홈 API 또는 보도), 없으면 이력의 보도 경쟁률
function blockCompetition(project, entry) {
  const row = (project.blocks ?? []).find((r) => !r.rental && blockKey(r.block) === blockKey(entry.block));
  const perf = row?.performance?.competition;
  if (perf && Number.isFinite(perf.rate)) return { rate: perf.rate, scope: perf.scope ?? null, source: perf.ref ?? null };
  const reported = entry.competition;
  if (reported && Number.isFinite(reported.rate)) return { rate: reported.rate, scope: reported.scope ?? null, source: reported.source ?? null };
  return null;
}

const hasBlocks = (project) => (project.history ?? []).length > 0 || (project.plans ?? []).length > 0 || (project.blocks ?? []).length > 0;

// basis 문구에 적힌 날짜(YYYY-MM-DD)와 같은 날짜의 지구 출처
const basisSources = (project, basis) => {
  const dates = String(basis ?? '').match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  return (project.sources ?? []).filter((s) => dates.includes(s.date));
};

/**
 * 공공주택지구 하나의 브리핑. curated는 resolveNews 뒤의 기사 목록, today는 수집일.
 * - 블록이 있는 지구: 1문단 가장 최근 본청약(세대·경쟁률·같은 블록의 분양가 기사), 2문단 아직 공고 전인 계획과
 *   사전청약만 한 블록의 최근 기사, 3문단 지구 전체 기사(블록 없음) 최근 2건.
 * - 블록이 없는 지구: 지정·계획 세대, 보도된 일정(지구 전체 기사), 첫 청약 예상(보도된 계획 또는 규칙).
 */
export function townBrief(project, { curated = [], today } = {}) {
  const { foot, add } = footnotes();
  const name = project.name;
  const items = townItems(curated, project);
  const wholeItems = items.filter((item) => !item.block);
  const open = openReception(project, today);
  const plans = pendingPlans(project, today);
  const mains = latestMains(project, today);
  const main = mains[0] ?? null;
  const paras = [];

  if (!hasBlocks(project)) {
    const p1 = [];
    const designated = project.stageDates?.지구지정;
    if (designated) {
      p1.push(T(`${monthLabel(designated)} 공공주택지구로 지정됐고`));
      p1.push(T(Number.isFinite(project.households) ? `, 약 ${fmt(project.households)}세대가 계획돼 있습니다.` : '.'));
      const same = (project.sources ?? []).find((s) => s.date === designated) ?? (project.sources ?? []).find((s) => String(s.date ?? '') > designated);
      const note = add(same);
      if (note) p1.push(note);
    } else if (Number.isFinite(project.households)) {
      p1.push(T(`약 ${fmt(project.households)}세대가 계획돼 있습니다. `));
    }
    p1.push(T(` 지금은 ${project.stage} 단계입니다.`));
    for (const item of wholeItems.slice(0, TOWN_ITEMS_MAX)) {
      const note = add(itemSource(item));
      p1.push(T(` ${sentence(item.title)}`));
      if (note) p1.push(note);
    }
    paras.push(p1);
    paras.push(firstSaleParagraph(project, add, '아직 블록이 정해지지 않아 '));
    return {
      headline: `${name}, 블록이 정해지기 전 단계`, paras, foot, basis: TOWN_BRIEF_BASIS,
    };
  }

  // 1문단: 가장 최근 본청약
  const p1 = [];
  if (main) {
    // 같은 날 공고된 블록은 함께: 'B-17(공공분양, 491세대)·A-24(신혼희망타운, 390세대)로 2025년 11월 공고됐습니다.'
    p1.push(T(`${name}의 가장 최근 본청약은 `));
    mains.forEach((entry, i) => {
      if (i > 0) p1.push(T('·'));
      p1.push(B(entry.block));
      const detail = mainDetail(entry);
      if (detail) p1.push(T(detail));
    });
    const last = mains.at(-1);
    p1.push(T(`${josa(mainDetail(last) ? '대' : last.block, '으로', '로')} ${monthLabel(main.noticeDate)} 공고됐습니다.`));
    const noted = new Set();
    for (const entry of mains) {
      const note = add(newestSource(entry.sources) ?? entry.sources?.[0]);
      if (note && !noted.has(note.t)) {
        noted.add(note.t);
        p1.push(note);
      }
    }
    // 블록별 경쟁률(있는 블록만). 범위(scope)가 모두 같으면 앞에 한 번만 적는다
    const cited = new Set();
    const comps = mains.map((entry) => ({ entry, comp: blockCompetition(project, entry) })).filter((x) => x.comp);
    if (comps.length) {
      const scopes = [...new Set(comps.map((x) => x.comp.scope ?? ''))];
      const shared = scopes.length === 1 && scopes[0] ? scopes[0] : null;
      p1.push(T(` ${shared ? `${shared} ` : ''}경쟁률은 `));
      const notes = [];
      p1.push(T(`${comps.map(({ entry, comp }) => {
        const who = mains.length > 1 ? `${entry.block} ` : '';
        const scope = !shared && comp.scope ? `${comp.scope} ` : '';
        return `${who}${scope}${rateText(comp.rate)}`;
      }).join(', ')}이었습니다.`));
      for (const { comp } of comps) {
        const url = safeHttpUrl(comp.source?.url);
        if (url) cited.add(url);
        const n = add(comp.source);
        if (n && !notes.some((x) => x.t === n.t)) notes.push(n);
      }
      p1.push(...notes);
    }
    if (open && mains.some((entry) => blockKey(open.block ?? '') === blockKey(entry.block))) {
      p1.push(T(open.winnerDate ? ` 지금 청약 접수 중이고, 당첨자 발표는 ${dayLabel(open.winnerDate)}입니다.` : ' 지금 청약 접수 중입니다.'));
      const n = add({ title: '청약홈', outlet: '청약홈', url: open.notice.url, date: open.notice.announceDate ?? null });
      if (n) p1.push(n);
    }
    // 같은 블록의 분양가 기사. 이 문단에서 경쟁률 출처로 이미 단 기사면 다시 옮기지 않는다
    const price = items.find((item) => item.block && mains.some((entry) => itemHasBlock(item, entry.block)) && /분양가/.test(item.title)
      && !cited.has(safeHttpUrl(item.url)));
    if (price) {
      p1.push(T(` ${sentence(price.title)}`));
      const n = add(itemSource(price));
      if (n) p1.push(n);
    }
  } else {
    const blocks = (project.blocks ?? []).map((row) => row.block);
    p1.push(T(`${name}${josa(name, '은', '는')} 아직 본청약 공고가 없습니다.`));
    if (blocks.length) p1.push(T(` 출처로 확인한 블록은 ${blocks.length}곳(${blocks.join('·')})입니다.`));
    for (const row of (project.blocks ?? []).slice(0, 1)) {
      const n = add(newestSource(row.sources));
      if (n) p1.push(n);
    }
  }
  paras.push(p1);

  // 2문단: 다음 계획(공고 전)과 사전청약만 한 블록의 최근 기사
  const p2 = [];
  const next = plans.slice(0, 2);
  next.forEach((plan, i) => {
    const source = newestSource(plan.sources);
    const local = /지역지/.test(`${sourceOutlet(source ?? {})} ${source?.title ?? ''}`);
    p2.push(T(i === 0 ? '다음은 ' : ' 그다음은 '), B(planBlocksText(plan)));
    const reported = `${expectedLabel(plan.expected)} 공급 예정이라는 ${local ? '지역지 ' : ''}보도`;
    p2.push(T(`${plan.type ? ` ${plan.type}` : ''}${josa(plan.type ?? planBlocksText(plan), '으로', '로')}, ${plan.passed ? `${reported}가 있었지만 그 시기가 지났습니다.` : `${reported}가 있습니다.`}`));
    const n = add(source);
    if (n) p2.push(n);
  });
  if (next.length) p2.push(T(` ${dayLabel(today)}까지 공고는 확인되지 않았습니다.`));
  const preOnly = new Map();
  for (const entry of project.history ?? []) {
    const key = blockKey(entry.block);
    if (entry.rental) continue;
    if (!preOnly.has(key)) preOnly.set(key, { block: entry.block, type: entry.type, pre: true });
    if (entry.stage !== PRE_SUBSCRIPTION) preOnly.get(key).pre = false;
  }
  const planned = new Set(next.flatMap((plan) => plan.blocks.map(blockKey)));
  const preItems = [...preOnly.values()].filter((row) => row.pre && !planned.has(blockKey(row.block)))
    .map((row) => ({ row, item: items.find((item) => !item.rental && item.block && itemHasBlock(item, row.block)) }))
    .filter((x) => x.item)
    .sort((a, b) => String(b.item.date).localeCompare(String(a.item.date)))
    .slice(0, 1);
  for (const { row, item } of preItems) {
    p2.push(T(`${p2.length ? ' ' : ''}사전청약만 한 `), B([row.block, row.type].filter(Boolean).join(' ')));
    p2.push(T(` 관련 최근 보도: ${sentence(item.title)}`));
    const n = add(itemSource(item));
    if (n) p2.push(n);
  }
  if (!next.length) {
    const reported = (project.blocks ?? []).filter((row) => !row.rental && row.status === '계획 보도').slice(0, 1);
    for (const row of reported) {
      p2.push(T(`${p2.length ? ' ' : ''}다음 공급 후보로는 `), B(row.block));
      p2.push(T(`${row.households ? `(${fmt(row.households)}세대)` : ''}${row.type ? ` ${row.type}` : ''} 공급 계획 보도가 있습니다${row.type ? '' : '(공급 유형 미확인)'}.`));
      const n = add(newestSource(row.sources));
      if (n) p2.push(n);
    }
  }
  if (!p2.length) p2.push(...firstSaleParagraph(project, add, main ? '다음 블록 계획 보도는 아직 없고, ' : ''));
  paras.push(p2);

  // 3문단: 지구 전체 기사 최근 2건
  const p3 = [];
  for (const item of wholeItems.slice(0, TOWN_ITEMS_MAX)) {
    const n = add(itemSource(item));
    p3.push(T(`${p3.length ? ' ' : ''}${sentence(item.title)}`));
    if (n) p3.push(n);
  }
  if (p3.length) paras.push(p3);

  let headline;
  if (open?.block && open.winnerDate) headline = `${name}, ${open.block} 당첨 발표는 ${dayLabel(open.winnerDate)}`;
  else if (open) headline = `${name}, ${open.block ? `${open.block} ` : ''}청약 접수 중`;
  else if (next.length) headline = `${name}, 다음 차례는 ${next[0].blocks.join('·')}${next[0].type ? ` ${next[0].type}` : ''}`;
  else if (main) headline = `${name}, 최근 본청약은 ${mains.map((entry) => entry.block).join('·')}`;
  else headline = `${name}, 본청약 전 단계`;
  return {
    headline, paras, foot, basis: TOWN_BRIEF_BASIS,
  };
}

// 기간 표기: 한 해의 1~12월이면 '2029년'(출처가 해 단위로 말한 경우), 같은 달이면 그 달, 아니면 'A에서 B 사이'
export function windowRangeText(from, to = from) {
  const year = /^(\d{4})-01$/.exec(String(from ?? ''));
  if (year && to === `${year[1]}-12`) return `${year[1]}년`;
  return from === to ? monthLabel(from) : `${monthLabel(from)}에서 ${monthLabel(to)} 사이`;
}

// 첫 청약(또는 다음 블록) 시기 문장: 보도된 지구 계획(expected)이면 그 출처, 아니면 규칙으로 잡은 기간
function firstSaleParagraph(project, add, lead) {
  const from = project.window?.from;
  const to = project.window?.to ?? from;
  if (!from) return [T(`${lead}예상 시기는 아직 정하지 못했습니다.`)];
  const range = windowRangeText(from, to);
  if (project.expected?.basis) {
    const segs = [T(`${lead}첫 분양은 ${range} 목표라는 발표·보도가 있습니다.`)];
    for (const source of basisSources(project, project.expected.basis)) {
      const n = add(source);
      if (n) segs.push(n);
    }
    return segs;
  }
  return [T(`${lead}${project.kind === '공공주택지구' && project.stage === '블록별 분양' ? '다음 블록' : '첫 청약'} 시기는 규칙상 ${range}로 추정합니다.`)];
}

/**
 * 모든 브리핑. projects는 공고 연결·블록별 현황·관련 소식 뒤의 내부 사업(bucket, notices, news, history, plans, blocks가 있음).
 * watchlist에서 추적 중인 지구만 지구 브리핑을 만든다.
 */
export function buildBriefs({
  projects = [], watchlist = [], curated = [], today, seoulAsOf = null, newsSearched = null,
} = {}) {
  const out = {};
  const stats = districtStats(projects);
  for (const district of SEOUL_DISTRICTS) {
    const brief = districtBrief(district, stats, { seoulAsOf, today, newsSearched });
    if (brief) out[district] = brief;
  }
  const byId = new Map(projects.map((p) => [p.id, p]));
  for (const watch of watchlist ?? []) {
    if (!watch?.tracked || !watch.projectId) continue;
    const project = byId.get(watch.projectId);
    if (!project || project.kind !== '공공주택지구' || out[project.id]) continue;
    out[project.id] = townBrief(project, { curated, today });
  }
  return out;
}

