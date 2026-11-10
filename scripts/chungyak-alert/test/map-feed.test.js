import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DEFAULT_NEWS, DEFAULT_NEWTOWNS, buildMap, summaryLines } from '../src/pipeline/build-map.js';
import {
  CALENDAR_LABELS, FEED_MAX, NAVER_MAX, NAVER_PROVIDER, normalizeUrl, STAGE_CARRY_DAYS, STAGE_MAX, buildCalendar, buildFeed, carriedStageItems, changeItems, dropCoveredNaver, feedId,
  historyItems, isRentalItem, kstDateTime, naverBlock, naverItems, noticeBlock, noticeItems, parseBlock, planItems, receptionItem, stageLabel,
} from '../src/pipeline/feed.js';
import { noticeSummary } from '../src/pipeline/link-notices.js';
import { NEWS_ENDPOINTS } from '../src/pipeline/news.js';
import { normalizeDetail } from '../src/sources/applyhome.js';
import { seoulFixture } from './map-fixtures.js';

const today = '2026-11-10';
const noSleep = async () => {};

// 청약홈 APT 상세 행(실제 필드 이름). 구리갈매역세권 B-1블록 신안인스빌 디센트: 청약홈 2026-10-30 공고의 일정과 같다.
const B1_URL = 'https://www.applyhome.co.kr/ai/aia/selectAPTLttotPblancDetail.do?houseManageNo=2026000472&pblancNo=2026000472';
const B1_ROW = {
  HOUSE_MANAGE_NO: '2026000472',
  PBLANC_NO: '2026000472',
  HOUSE_SECD: '01',
  HOUSE_NM: '구리갈매역세권 B-1블록 신안인스빌 디센트',
  SUBSCRPT_AREA_CODE_NM: '경기',
  HSSPLY_ADRES: '경기도 구리시 갈매동 일원',
  RCRIT_PBLANC_DE: '2026-10-30',
  PRZWNER_PRESNATN_DE: '2026-11-17',
  PBLANC_URL: B1_URL,
  SPSPLY_RCEPT_BGNDE: '2026-11-09',
  SPSPLY_RCEPT_ENDDE: '2026-11-09',
  GNRL_RNK1_CRSPAREA_RCPTDE: '2026-11-10',
  GNRL_RNK1_CRSPAREA_ENDDE: '2026-11-10',
  GNRL_RNK1_ETC_GG_RCPTDE: '2026-11-10',
  GNRL_RNK1_ETC_GG_ENDDE: '2026-11-10',
  GNRL_RNK1_ETC_AREA_RCPTDE: '2026-11-10',
  GNRL_RNK1_ETC_AREA_ENDDE: '2026-11-10',
  GNRL_RNK2_CRSPAREA_RCPTDE: '2026-11-11',
  GNRL_RNK2_CRSPAREA_ENDDE: '2026-11-11',
  GNRL_RNK2_ETC_GG_RCPTDE: '2026-11-11',
  GNRL_RNK2_ETC_GG_ENDDE: '2026-11-11',
  GNRL_RNK2_ETC_AREA_RCPTDE: '2026-11-11',
  GNRL_RNK2_ETC_AREA_ENDDE: '2026-11-11',
};
// 임대 공고(이름에 행복주택). 일반 접수 단계 하나(사흘).
const HAPPY_ROW = {
  HOUSE_MANAGE_NO: '2026999001',
  PBLANC_NO: '2026999001',
  HOUSE_SECD: '01',
  HOUSE_NM: '구리갈매역세권 A-1블록 행복주택',
  SUBSCRPT_AREA_CODE_NM: '경기',
  HSSPLY_ADRES: '경기도 구리시 갈매동 일원',
  RCRIT_PBLANC_DE: '2026-10-27',
  PBLANC_URL: 'https://apply.lh.or.kr/',
  RCEPT_BGNDE: '2026-11-10',
  RCEPT_ENDDE: '2026-11-12',
};
const APT = { kind: 'apt', mdlOp: 'getAPTLttotPblancMdl' };
const b1 = noticeSummary(normalizeDetail(APT, B1_ROW));
const happy = noticeSummary(normalizeDetail(APT, HAPPY_ROW));

const galmae = (extra = {}) => ({
  id: 'town-guri-galmae-station',
  region: '경기',
  blocks: [
    { block: 'B-1', rental: false }, { block: 'A-1', rental: false }, { block: 'A-1', rental: true }, { block: 'A-4', rental: false }, { block: 'S-1', rental: false },
  ],
  history: [
    {
      block: 'A4', stage: '사전청약', type: '공공분양', noticeDate: '2023-09', rental: false, sources: [{ title: '서울시', url: 'https://news.seoul.go.kr/x', date: '2023-09-21' }],
    },
    {
      block: 'A-1', stage: '본청약', type: '행복주택', households: 609, noticeDate: '2026-10-27', rental: true, sources: [{ title: 'LH, 4분기 공공임대 (메트로신문)', url: 'https://www.metroseoul.co.kr/article/20261027500075', date: '2026-10-27' }],
    },
    {
      block: 'B-1', stage: '본청약', type: '민간분양', households: 213, noticeDate: '2026-10-30', rental: false, title: '구리갈매역세권 신안인스빌 디센트', sources: [{ title: '청약홈', url: B1_URL, date: '2026-10-30', outlet: '청약홈' }],
    },
  ],
  plans: [],
  notices: [b1, happy],
  ...extra,
});

test('notice summaries keep stages and the winner date from the normalized notice', () => {
  assert.deepEqual(b1.stages.map((s) => [s.name, s.start, s.end]), [
    ['특별공급', '2026-11-09', '2026-11-09'],
    ['1순위 해당', '2026-11-10', '2026-11-10'], ['1순위 경기', '2026-11-10', '2026-11-10'], ['1순위 기타', '2026-11-10', '2026-11-10'],
    ['2순위 해당', '2026-11-11', '2026-11-11'], ['2순위 경기', '2026-11-11', '2026-11-11'], ['2순위 기타', '2026-11-11', '2026-11-11'],
  ]);
  assert.equal(b1.winnerDate, '2026-11-17');
  assert.equal(b1.end, '2026-11-11');
  assert.deepEqual(happy.stages, [{ name: '접수', start: '2026-11-10', end: '2026-11-12' }]);
  assert.equal(happy.winnerDate, null);
  assert.deepEqual(noticeSummary({ key: 'k', name: 'n', stages: [{ name: '1순위', start: '2026-01' }, null] }).stages, []);
});

test('kstDateTime and feedId', () => {
  assert.equal(kstDateTime(new Date('2026-11-09T22:30:05Z')), '2026-11-10T07:30:05+09:00');
  assert.equal(kstDateTime(new Date('2026-11-10T15:00:00Z')), '2026-11-11T00:00:00+09:00');
  const a = {
    kind: '뉴스', projectId: 'p', block: 'B-1', date: '2026-11-08', title: 't',
  };
  assert.match(feedId(a), /^[0-9a-f]{16}$/);
  assert.equal(feedId(a), feedId({ ...a }));
  assert.notEqual(feedId(a), feedId({ ...a, block: null }));
  assert.notEqual(feedId(a), feedId({ ...a, kind: '일정' }));
  assert.equal(feedId({ ...a, block: undefined }), feedId({ ...a, block: null }));
});

test('parseBlock reads block names from notice names', () => {
  assert.equal(parseBlock('구리갈매역세권 B-1블록 신안인스빌 디센트'), 'B-1');
  assert.equal(parseBlock('구리갈매역세권 A-4블록 공공분양주택(본청약)'), 'A-4');
  assert.equal(parseBlock('교산 푸르지오 더 퍼스트 2차 (A-9BL)'), 'A-9');
  assert.equal(parseBlock('하남교산 A2블록'), 'A2');
  assert.equal(parseBlock('S2 블록'), 'S2');
  assert.equal(parseBlock('교산 푸르지오 더 퍼스트(본청약)'), null);
  assert.equal(parseBlock('월계 중흥S-클래스 리비에르'), null);
  assert.equal(parseBlock('정동 롯데캐슬 136(오피스텔)'), null);
  assert.equal(parseBlock(null), null);
});

test('noticeBlock uses the town block names, then a history 단지 name; Seoul notices have no block', () => {
  const town = galmae();
  assert.equal(noticeBlock(b1, town), 'B-1');
  assert.equal(noticeBlock({ name: '구리갈매역세권 A1블록 신혼희망타운' }, town), 'A-1');
  assert.equal(noticeBlock({ name: '구리갈매역세권 신안인스빌 디센트 (무순위)' }, town), 'B-1');
  assert.equal(noticeBlock({ name: '구리갈매역세권 C-7블록' }, town), 'C-7');
  assert.equal(noticeBlock({ name: '다른 단지' }, town), null);
  assert.equal(noticeBlock({ name: 'A1블록' }, { region: '서울' }), null);
});

test('rental notices and calendar labels', () => {
  assert.equal(isRentalItem(happy), true);
  assert.equal(isRentalItem(b1), false);
  assert.equal(isRentalItem({ name: '구리갈매역세권 A-4블록 6년 분양전환공공임대주택(본청약)', typeLabel: 'APT' }), true);
  assert.equal(isRentalItem({ name: '어떤 단지', typeLabel: '공공지원민간임대' }), true);
  assert.deepEqual(['특별공급', '1순위 해당', '1순위 기타', '2순위 경기', '무순위 접수', '임의 접수', '일반공급', '접수'].map(stageLabel), [
    '특별공급', '1순위', '1순위', '2순위', '접수', '접수', '접수', '접수',
  ]);
  assert.deepEqual(CALENDAR_LABELS, ['특별공급', '1순위', '2순위', '접수', '당첨자 발표']);
});

test('receptionItem: title follows the stage of today (or the next one), date stays the 1순위 start', () => {
  // 구리갈매 B-1: 특별공급 11-09, 1순위 11-10, 2순위 11-11, 전체 마감 11-11
  assert.deepEqual(receptionItem(b1, '2026-10-27'), { date: '2026-11-10', title: '특별공급 접수, 전체 마감 2026-11-11' });
  assert.deepEqual(receptionItem(b1, '2026-11-09'), { date: '2026-11-10', title: '특별공급 접수, 전체 마감 2026-11-11' });
  assert.deepEqual(receptionItem(b1, today), { date: '2026-11-10', title: '1순위 접수, 전체 마감 2026-11-11' });
  assert.deepEqual(receptionItem(b1, '2026-11-11'), { date: '2026-11-10', title: '2순위 접수, 전체 마감 2026-11-11' });
  assert.equal(receptionItem(b1, '2026-11-12'), null);
  // 첫 단계(11-09) 14일 전부터
  assert.ok(receptionItem(b1, '2026-10-26'));
  assert.equal(receptionItem(b1, '2026-10-25'), null);
  assert.deepEqual(receptionItem(happy, today), { date: '2026-11-10', title: '청약 접수, 전체 마감 2026-11-12' });
  // 단계 사이 빈 날은 다음 단계, 단계가 다 지났는데 공고 마감이 남았으면 마지막 단계
  const gap = { end: '2026-11-20', stages: [{ name: '1순위 해당', start: '2026-11-05', end: '2026-11-05' }, { name: '2순위 해당', start: '2026-11-12', end: '2026-11-12' }] };
  assert.deepEqual(receptionItem(gap, today), { date: '2026-11-05', title: '2순위 접수, 전체 마감 2026-11-20' });
  assert.deepEqual(receptionItem(gap, '2026-11-15'), { date: '2026-11-05', title: '2순위 접수, 전체 마감 2026-11-20' });
  const soon = (startDay) => ({ end: null, stages: [{ name: '무순위 접수', start: startDay, end: startDay }] });
  assert.deepEqual(receptionItem(soon('2026-11-24'), today), { date: '2026-11-24', title: '무순위 접수, 전체 마감 2026-11-24' });
  assert.equal(receptionItem(soon('2026-11-25'), today), null);
  assert.equal(receptionItem({ end: '2026-11-20', stages: [] }, today), null);
});

test('접수 feed id ignores the title: the same notice keeps its id while the title moves to the next stage', () => {
  const on = (day) => noticeItems(galmae(), day).filter((i) => i.kind === '접수' && i.block === 'B-1')[0];
  const first = on(today);
  const next = on('2026-11-11');
  assert.equal(first.title, '1순위 접수, 전체 마감 2026-11-11');
  assert.equal(next.title, '2순위 접수, 전체 마감 2026-11-11');
  assert.equal(first.id, next.id);
  assert.equal(first.id, feedId({
    kind: '접수', projectId: 'town-guri-galmae-station', block: 'B-1', date: '2026-11-10', title: `접수:${b1.key}`,
  }));
  // 같은 날·같은 블록이어도 다른 공고면 id가 다르다
  const other = noticeItems(galmae({ notices: [b1, { ...b1, key: 'other', name: '구리갈매역세권 B-1블록 (무순위)' }] }), today).filter((i) => i.kind === '접수');
  assert.equal(new Set(other.map((i) => i.id)).size, 2);
});

test('buildCalendar: stage days and the winner date within 45 days, sorted', () => {
  const calendar = buildCalendar([galmae()], today);
  assert.deepEqual(calendar.map((e) => [e.date, e.label, e.block, e.rental]), [
    ['2026-11-10', '1순위', 'B-1', false],
    ['2026-11-10', '접수', 'A-1', true],
    ['2026-11-11', '2순위', 'B-1', false],
    ['2026-11-11', '접수', 'A-1', true],
    ['2026-11-12', '접수', 'A-1', true],
    ['2026-11-17', '당첨자 발표', 'B-1', false],
  ]);
  assert.deepEqual(calendar[0], {
    date: '2026-11-10', projectId: 'town-guri-galmae-station', block: 'B-1', label: '1순위', title: '구리갈매역세권 B-1블록 신안인스빌 디센트', rental: false, url: B1_URL,
  });
  // 특별공급(11-09)은 어제라 빠진다. 45일 창(오늘 포함)의 끝은 12-24
  assert.equal(buildCalendar([galmae()], '2026-11-09')[0].label, '특별공급');
  // 45일 창은 오늘 포함: 09-26이면 마지막 날이 11-09(특별공급만), 09-25면 11-08이라 하나도 없다
  assert.equal(buildCalendar([galmae()], '2026-10-05').length, 7);
  assert.deepEqual(buildCalendar([galmae()], '2026-09-26').map((e) => e.date), ['2026-11-09']);
  assert.deepEqual(buildCalendar([galmae()], '2026-09-25'), []);
  // 서울 사업 공고는 블록 없음, 주소가 이상하면 url null
  const seoul = {
    id: 'seoul-1673', region: '서울', notices: [{ name: '중화역 라온프라이빗 센트로', url: 'javascript:x', stages: [{ name: '1순위 해당', start: '2026-11-17', end: '2026-11-17' }], winnerDate: '2026-11-25' }],
  };
  assert.deepEqual(buildCalendar([seoul], today).map((e) => [e.date, e.label, e.block, e.url]), [
    ['2026-11-17', '1순위', null, null], ['2026-11-25', '당첨자 발표', null, null],
  ]);
});

test('notice feed items: 공고 for every linked notice and 접수 while reception is open', () => {
  const items = noticeItems(galmae(), today);
  assert.deepEqual(items.map((i) => [i.kind, i.date, i.block, i.rental, i.title]), [
    ['공고', '2026-10-30', 'B-1', false, '청약홈 공고: 구리갈매역세권 B-1블록 신안인스빌 디센트'],
    ['접수', '2026-11-10', 'B-1', false, '1순위 접수, 전체 마감 2026-11-11'],
    ['공고', '2026-10-27', 'A-1', true, '청약홈 공고: 구리갈매역세권 A-1블록 행복주택'],
    ['접수', '2026-11-10', 'A-1', true, '청약 접수, 전체 마감 2026-11-12'],
  ]);
  assert.deepEqual(items[0].source, {
    title: '청약홈', url: B1_URL, date: '2026-10-30', local: false,
  });
  assert.equal(items[0].id, feedId({
    kind: '공고', projectId: 'town-guri-galmae-station', block: 'B-1', date: '2026-10-30', title: items[0].title,
  }));
});

test('history feed items skip entries already covered by a notice and month-only dates', () => {
  assert.deepEqual(historyItems(galmae()), []);
  const withoutNotices = historyItems(galmae({ notices: [] }));
  assert.deepEqual(withoutNotices.map((i) => [i.kind, i.date, i.block, i.rental, i.title]), [
    ['일정', '2026-10-27', 'A-1', true, 'A-1 행복주택 입주자 모집 공고 (609세대)'],
    ['일정', '2026-10-30', 'B-1', false, 'B-1 민간분양 본청약 공고 (213세대)'],
  ]);
  // 분양 공고는 임대 이력을 덮지 않는다
  assert.equal(historyItems(galmae({ notices: [b1] })).length, 1);
});

test('plan feed items: one per block, dated at the earliest report, local papers marked', () => {
  const town = galmae({
    plans: [{
      blocks: ['A9', 'A11'],
      type: '공공분양',
      expected: '2026-하반기',
      rental: false,
      sources: [
        { title: '로드맵 (하남일보, 지역지)', outlet: '하남일보', url: 'http://m.hanamilbo.net/news/articleView.html?idxno=11888', date: '2026-03-08' },
        { title: '분양 지도 (하남일보, 지역지)', outlet: '하남일보', url: 'http://m.hanamilbo.net/news/articleView.html?idxno=11572', date: '2025-11-23' },
      ],
    }, {
      blocks: ['B2'], type: '실버스테이 민간임대', expected: '2029-하반기', rental: true, sources: [{ title: '기사', url: 'https://news.mtn.co.kr/x', date: '2025-05-04' }],
    }, {
      blocks: ['Z1'], expected: '2027-01', sources: [{ title: '날짜 없음', url: 'https://a.example' }],
    }],
  });
  const items = planItems(town);
  assert.deepEqual(items.map((i) => [i.date, i.block, i.rental, i.title, i.source.local]), [
    // 여러 블록 계획은 한 건(block 'A9·A11')
    ['2025-11-23', 'A9·A11', false, 'A9·A11 공공분양 2026-하반기 공급 예정 보도 (지역지)', true],
    ['2025-05-04', 'B2', true, 'B2 실버스테이 민간임대 2029-하반기 공급 예정 보도', false],
  ]);
  assert.equal(items[0].source.url, 'http://m.hanamilbo.net/news/articleView.html?idxno=11572');
});

test('stage change items and carry-over from the previous feed', () => {
  const projects = [{ id: 'seoul-1', region: '서울' }, { id: 'seoul-2', region: '서울' }];
  const source = () => ({ title: '서울시 정비사업 추진현황', url: 'https://data.seoul.go.kr/x', date: null });
  const items = changeItems([{ projectId: 'seoul-1', from: '조합설립', to: '사업시행인가' }, { projectId: 'gone', from: 'a', to: 'b' }], projects, today, source);
  assert.deepEqual(items.map((i) => [i.kind, i.date, i.projectId, i.block, i.title, i.source.url]), [
    ['단계', today, 'seoul-1', null, '단계 변경: 조합설립 → 사업시행인가', 'https://data.seoul.go.kr/x'],
  ]);
  const carried = carriedStageItems([
    { ...items[0], date: '2026-11-03', id: 'forged' },
    { kind: '단계', projectId: 'gone', date: '2026-11-03', title: '단계 변경: a → b' },
    { kind: '단계', projectId: 'seoul-2', date: '2026-11-03', title: '<img onerror>' },
    { kind: '뉴스', projectId: 'seoul-2', date: '2026-11-03', title: '단계 변경: a → b' },
    { kind: '단계', projectId: 'seoul-2', date: '2026-12-01', title: '단계 변경: a → b' },
  ], projects, today);
  assert.equal(carried.length, 1);
  assert.equal(carried[0].date, '2026-11-03');
  assert.notEqual(carried[0].id, 'forged');
  assert.equal(carriedStageItems(null, projects, today).length, 0);
});

test('buildFeed: newest first; Seoul items limited to 400 days and 200 items, town items kept; only 접수 may be in the future', () => {
  const town = galmae({ kind: '공공주택지구' });
  const seoulProject = { id: 'seoul-1673', region: '서울', kind: '재개발' };
  const news = (date, n = 0, projectId = 'town-guri-galmae-station') => ({
    projectId, block: null, date, title: `기사 ${date} ${n}`, outlet: '매체', url: `https://a.example/${n}`, local: false, rental: false, kind: '뉴스',
  });
  const feed = buildFeed({
    projects: [town, seoulProject],
    news: [
      news('2025-10-06', 0, 'seoul-1673'), news('2025-10-05', 1, 'seoul-1673'), news('2021-01-04', 2),
      news('2026-11-11', 3), news('2026-11-08', 4), news('2026-11-08', 4),
    ],
    today,
  });
  assert.deepEqual(feed.map((i) => [i.date, i.kind, i.projectId]), [
    ['2026-11-10', '접수', 'town-guri-galmae-station'], ['2026-11-10', '접수', 'town-guri-galmae-station'],
    ['2026-11-08', '뉴스', 'town-guri-galmae-station'], ['2026-10-30', '공고', 'town-guri-galmae-station'],
    ['2026-10-27', '공고', 'town-guri-galmae-station'], ['2025-10-06', '뉴스', 'seoul-1673'], ['2021-01-04', '뉴스', 'town-guri-galmae-station'],
  ]);
  assert.ok(feed.every((i) => Object.keys(i).join() === 'id,date,kind,projectId,block,title,rental,source'));
  const many = (projectId) => Array.from({ length: 250 }, (_, i) => news('2026-11-01', i, projectId));
  assert.equal(buildFeed({ projects: [seoulProject], news: many('seoul-1673'), today }).length, FEED_MAX);
  assert.equal(buildFeed({ projects: [town], news: many('town-guri-galmae-station'), today }).filter((i) => i.kind === '뉴스').length, 250);
  const mixed = buildFeed({ projects: [town, seoulProject], news: [...many('seoul-1673'), ...many('town-guri-galmae-station')], today });
  assert.equal(mixed.filter((i) => i.projectId === 'seoul-1673').length, FEED_MAX);
  // 곧 시작하는 접수(오늘 뒤)는 맨 위
  const later = galmae({ notices: [{ ...b1, key: 'later', name: '구리갈매역세권 S-1블록', end: '2026-11-20', stages: [{ name: '1순위 해당', start: '2026-11-19', end: '2026-11-19' }] }] });
  assert.deepEqual(buildFeed({ projects: [later], today })[0].date, '2026-11-19');
});

test('buildFeed drops a history/plan 일정 item when a news.yaml item of the same project and block cites the same article', () => {
  const town = galmae({ kind: '공공주택지구', notices: [] });
  const metro = 'https://www.metroseoul.co.kr/article/20261027500075';
  const article = (block) => ({
    projectId: town.id, block, date: '2026-10-27', title: `행복주택 접수 ${block}`, outlet: '메트로신문', url: metro, local: false, rental: true, kind: '뉴스',
  });
  const titles = (news) => buildFeed({ projects: [town], news, today }).map((i) => `${i.kind} ${i.block} ${i.title}`);
  assert.ok(titles([]).includes('일정 A-1 A-1 행복주택 입주자 모집 공고 (609세대)'));
  // 같은 블록·같은 주소: 기사만 남는다
  assert.deepEqual(titles([article('A-1')]).filter((t) => t.includes('A-1')), ['뉴스 A-1 행복주택 접수 A-1']);
  // 다른 블록이면 둘 다 남는다
  assert.equal(titles([article('B-1')]).filter((t) => t.startsWith('일정 A-1')).length, 1);
});

test('Seoul 단계 items are capped at 50 before the 200-item Seoul cap, so notices survive a mass stage change', () => {
  const projects = Array.from({ length: 300 }, (_, i) => ({
    id: `seoul-${1000 + i}`,
    region: '서울',
    kind: '재개발',
    notices: i < 50 ? [{
      key: `n${i}`, name: `단지 ${i}`, announceDate: '2026-09-01', end: '2026-09-15', url: 'https://www.applyhome.co.kr/x', typeLabel: 'APT', stages: [],
    }] : [],
  }));
  const changes = projects.map((project) => ({ projectId: project.id, from: '조합설립', to: '사업시행인가' }));
  const feed = buildFeed({ projects, changes, today });
  const count = (kind) => feed.filter((i) => i.kind === kind).length;
  assert.equal(STAGE_MAX, 50);
  assert.equal(count('단계'), STAGE_MAX);
  assert.equal(count('공고'), 50);
  assert.equal(feed.length, 100);
  // 공공주택지구 단계 소식은 이 제한을 받지 않는다
  const town = { id: 'town-x', region: '경기', kind: '공공주택지구' };
  const withTown = buildFeed({ projects: [...projects, town], changes: [...changes, { projectId: 'town-x', from: '지구지정', to: '지구계획승인' }], today });
  assert.equal(withTown.filter((i) => i.kind === '단계').length, STAGE_MAX + 1);
});

test('carried 단계 items are kept for 90 days', () => {
  const projects = [{ id: 'seoul-1', region: '서울' }];
  const entry = (date) => ({ kind: '단계', projectId: 'seoul-1', date, title: `단계 변경: ${date}` });
  assert.equal(STAGE_CARRY_DAYS, 90);
  const carried = carriedStageItems([entry('2026-08-12'), entry('2026-08-11'), entry('2026-11-09')], projects, today);
  assert.deepEqual(carried.map((i) => i.date), ['2026-08-12', '2026-11-09']);
});

// --- 네이버 관련 소식(project.news) -> 뉴스 소식 ---

test('naverBlock: a block only when the title clearly names a block of the town', () => {
  const town = galmae();
  assert.equal(naverBlock('구리갈매역세권 B-1블록 신안인스빌 디센트 특별공급', town), 'B-1');
  assert.equal(naverBlock('구리갈매역세권 A4 공공분양 본청약', town), 'A-4');
  // 지구에 없는 블록, 블록 이름이 없는 제목은 지구 전체
  assert.equal(naverBlock('구리갈매역세권 C-9블록 소문', town), null);
  assert.equal(naverBlock('구리갈매역세권 교통 대책 발표', town), null);
  // 서울 사업은 블록이 없다
  assert.equal(naverBlock('신영1구역 B-1 이주', { id: 'seoul-1', region: '서울', blocks: [{ block: 'B-1' }] }), null);
});

test('naverItems keeps only this build\'s items inside the 14-day publish window, marked as naver', () => {
  assert.equal(NAVER_PROVIDER, 'naver');
  const town = galmae({
    news: [
      { title: '구리갈매역세권 B-1블록 신안인스빌 디센트 9일 특별공급', outlet: '뉴시스', date: '2026-11-09', url: 'https://www.newsis.com/1' },
      { title: '구리갈매역세권 교통 대책', outlet: null, date: '2026-10-27', url: 'https://n.news.naver.com/2' }, // 14일 전: 남김
      { title: '구리갈매역세권 옛 기사', outlet: '연합뉴스', date: '2026-10-26', url: 'https://www.yna.co.kr/3' }, // 15일 전: 뺌
      { title: '구리갈매역세권 미래 기사', outlet: '연합뉴스', date: '2026-11-11', url: 'https://www.yna.co.kr/4' },
      { title: '주소 없음', outlet: '연합뉴스', date: '2026-11-09', url: 'javascript:alert(1)' },
      { title: '  ', outlet: '연합뉴스', date: '2026-11-09', url: 'https://www.yna.co.kr/5' },
      { title: '날짜 없음', outlet: '연합뉴스', date: null, url: 'https://www.yna.co.kr/6' },
    ],
  });
  const items = naverItems(town, today);
  assert.deepEqual(items.map((i) => [i.kind, i.date, i.block, i.title, i.source.title, i.source.provider, i.source.local]), [
    ['뉴스', '2026-11-09', 'B-1', '구리갈매역세권 B-1블록 신안인스빌 디센트 9일 특별공급', '뉴시스', 'naver', false],
    ['뉴스', '2026-10-27', null, '구리갈매역세권 교통 대책', '', 'naver', false],
  ]);
  assert.equal(items[0].id, feedId({
    kind: '뉴스', projectId: town.id, block: 'B-1', date: '2026-11-09', title: items[0].title,
  }));
  assert.deepEqual(naverItems(galmae(), today), []);
  assert.deepEqual(naverItems(galmae({ news: 'x' }), today), []);
});

test('buildFeed merges curated and Naver news, drops a Naver item whose URL a curated item of the same project already cites', () => {
  const straight = 'https://www.straightnews.co.kr/news/articleView.html?idxno=314854';
  const town = galmae({
    notices: [],
    news: [
      { title: '구리갈매역세권 B-1 분양가 비교', outlet: '스트레이트뉴스', date: '2026-11-08', url: straight },
      { title: '구리갈매역세권 교통 대책', outlet: '뉴시스', date: '2026-11-09', url: 'https://www.newsis.com/9' },
    ],
  });
  const curated = [{
    projectId: town.id, block: 'B-1', date: '2026-11-08', title: 'B-1 분양가와 주변 시세 비교 (우리 요약)', outlet: '스트레이트뉴스', url: straight, local: false, rental: false, kind: '뉴스',
  }];
  const news = buildFeed({ projects: [town], news: curated, today }).filter((i) => i.kind === '뉴스');
  assert.deepEqual(news.map((i) => [i.title, i.source.provider ?? null]), [
    ['구리갈매역세권 교통 대책', 'naver'],
    ['B-1 분양가와 주변 시세 비교 (우리 요약)', null],
  ]);
  // 다른 사업의 같은 주소는 그대로 둔다(그 사업 화면에서도 보여야 한다)
  const other = { id: 'town-other', region: '경기', kind: '공공주택지구', news: [{ title: '다른 지구 기사', outlet: 'x', date: '2026-11-08', url: straight }] };
  assert.equal(buildFeed({ projects: [town, other], news: curated, today }).filter((i) => i.projectId === 'town-other').length, 1);
  // dropCoveredNaver만: 네이버가 아닌 소식은 건드리지 않는다
  const plain = { projectId: 'p', kind: '뉴스', source: { url: 'https://a.com/1' } };
  const naver = { projectId: 'p', kind: '뉴스', source: { url: 'https://a.com/1', provider: 'naver' } };
  assert.deepEqual(dropCoveredNaver([plain, naver]), [plain]);
  assert.deepEqual(dropCoveredNaver([naver]), [naver]);
});

test('Naver items are never carried from the previous feed', () => {
  const projects = [{ id: 'seoul-1', region: '서울' }];
  const old = {
    kind: '뉴스', projectId: 'seoul-1', date: '2026-11-01', title: '단계 변경: 아님', source: { title: '뉴시스', url: 'https://www.newsis.com/1', provider: 'naver' },
  };
  assert.deepEqual(carriedStageItems([old], projects, today), []);
});

// 통합: 실제 newtowns.yaml·news.yaml과 실제 꼴의 청약홈 응답(구리갈매 B-1, A-1 행복주택)으로 빌드한다.
const dir = mkdtempSync(join(tmpdir(), 'chungyak-feed-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const seoulFile = join(dir, 'seoul.xlsx');
writeFileSync(seoulFile, seoulFixture());

function applyhomeFetch() {
  return async (url) => {
    const op = new URL(url).pathname.split('/').at(-1);
    if (op !== 'getAPTLttotPblancDetail') return Response.json({ totalCount: 0, data: [] });
    return Response.json({ totalCount: 2, data: [B1_ROW, HAPPY_ROW] });
  };
}

test('buildMap with real data files fills notices stages, calendar, feed, news, watchlist and changes', async () => {
  const previousFile = join(dir, 'previous.json');
  writeFileSync(previousFile, JSON.stringify({
    generatedAt: '2026-11-09T19:00:00+09:00',
    projects: [{ id: 'town-guri-galmae-station', stage: '부지조성 착공' }, { id: 'town-hanam-gyosan', stage: '블록별 분양' }],
    feed: [{
      kind: '단계', projectId: 'town-hanam-gyosan', date: '2026-11-03', title: '단계 변경: 부지조성 착공 → 블록별 분양', source: { title: 'x', url: 'javascript:alert(1)' },
    }],
  }));
  const data = await buildMap({
    fetch: applyhomeFetch(),
    env: { DATA_GO_KR_KEY: 'k' },
    now: new Date('2026-11-09T22:30:00Z'),
    today,
    seoulFile,
    newtownsFile: DEFAULT_NEWTOWNS,
    newsFile: DEFAULT_NEWS,
    previous: { file: previousFile },
    sleep: noSleep,
  });
  assert.equal(data.generatedAt, '2026-11-10T07:30:00+09:00');
  const galmaeOut = data.projects.find((p) => p.id === 'town-guri-galmae-station');
  const notice = galmaeOut.notices.find((n) => n.key === '2026000472-2026000472');
  assert.equal(notice.winnerDate, '2026-11-17');
  assert.deepEqual(notice.stages[0], { name: '특별공급', start: '2026-11-09', end: '2026-11-09' });

  assert.deepEqual(data.calendar.map((e) => [e.date, e.label, e.block, e.rental]), [
    ['2026-11-10', '1순위', 'B-1', false],
    ['2026-11-10', '접수', 'A-1', true],
    ['2026-11-11', '2순위', 'B-1', false],
    ['2026-11-11', '접수', 'A-1', true],
    ['2026-11-12', '접수', 'A-1', true],
    ['2026-11-17', '당첨자 발표', 'B-1', false],
  ]);

  const kinds = (kind) => data.feed.filter((i) => i.kind === kind);
  assert.deepEqual(kinds('접수').map((i) => [i.block, i.title]), [['B-1', '1순위 접수, 전체 마감 2026-11-11'], ['A-1', '청약 접수, 전체 마감 2026-11-12']]);
  assert.deepEqual(kinds('공고').map((i) => i.block).sort(), ['A-1', 'B-1']);
  // B-1·A-1 행복주택 본청약 이력은 공고로 덮인다. 오래된 지구 이력(A-1 사전청약 2021-12)은 남는다. 교산 계획(지역지)은 일정으로 남는다
  const galmaeSchedules = kinds('일정').filter((i) => i.projectId === 'town-guri-galmae-station');
  assert.ok(!galmaeSchedules.some((i) => i.block === 'B-1' || (i.block === 'A-1' && i.rental)));
  assert.ok(galmaeSchedules.some((i) => i.block === 'A-1' && i.date === '2021-12-29' && i.title.includes('사전청약')));
  assert.ok(data.feed.some((i) => i.projectId === 'town-hanam-gyosan' && i.block === 'A2' && i.date === '2025-05-09'));
  assert.ok(kinds('일정').some((i) => i.projectId === 'town-hanam-gyosan' && i.block === 'A9·A11' && i.title.endsWith('(지역지)')));
  // 여러 블록 소식은 한 건씩만: 같은 제목·날짜가 두 번 나오지 않는다
  const titleDates = data.feed.map((i) => `${i.projectId}|${i.date}|${i.title}`);
  assert.equal(new Set(titleDates).size, titleDates.length);
  // 단계: 이번 변경(갈매 부지조성 착공 → 블록별 분양)과 이어 온 교산 변경
  assert.deepEqual(data.changes, {
    since: '2026-11-09T19:00:00+09:00', items: [{ projectId: 'town-guri-galmae-station', from: '부지조성 착공', to: '블록별 분양' }],
  });
  assert.deepEqual(kinds('단계').map((i) => [i.date, i.projectId, i.source.url]), [
    [today, 'town-guri-galmae-station', 'https://www.metroseoul.co.kr/article/20261103500089'],
    ['2026-11-03', 'town-hanam-gyosan', null],
  ]);
  const b1News = kinds('뉴스').filter((i) => i.block === 'B-1');
  assert.ok(b1News.some((i) => i.source.url === 'https://www.straightnews.co.kr/news/articleView.html?idxno=314854' && i.date === '2026-11-08'));
  assert.ok(data.feed.every((i, idx) => idx === 0 || data.feed[idx - 1].date >= i.date));
  assert.ok(data.feed.every((i) => i.source.url === null || /^https?:\/\//.test(i.source.url)));
  assert.equal(new Set(data.feed.map((i) => i.id)).size, data.feed.length);

  assert.equal(data.watchlist.length, 9);
  assert.ok(data.watchlist.every((w) => w.tracked));
  assert.deepEqual(data.sources.curatedNews, {
    asOf: '2026-11-11', count: data.sources.curatedNews.count, skipped: null, unmatched: 0,
  });
  assert.ok(data.sources.curatedNews.count > 0);
  assert.equal(data.sources.previous.skipped, null);
  const [line] = summaryLines(data);
  assert.match(line, / feed=\d+ calendar=6 changes=1 curated=\d+$/);
  assert.ok(!line.includes('http'));
});

test('buildMap without a previous source or news file still builds', async () => {
  const data = await buildMap({
    fetch: applyhomeFetch(), env: { DATA_GO_KR_KEY: 'k' }, today, seoulFile, newtownsFile: DEFAULT_NEWTOWNS, newsFile: join(dir, 'none.yaml'), sleep: noSleep,
  });
  assert.deepEqual(data.changes, { since: null, items: [] });
  assert.equal(data.sources.previous.skipped, 'no_previous');
  assert.equal(data.sources.curatedNews.skipped, 'news_missing');
  assert.match(summaryLines(data)[0], / changes=skipped:no_previous curated=skipped:news_missing$/);
});

test('buildMap feed carries both curated news and this build\'s Naver news; logs both counts', async () => {
  const straight = 'https://www.straightnews.co.kr/news/articleView.html?idxno=314854';
  const raw = (title, pubDate, url) => ({
    title, originallink: url, link: 'https://n.news.naver.com/article/003/1', description: '요약은 저장하지 않는다', pubDate,
  });
  const base = applyhomeFetch();
  const queries = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    if (`${u.origin}${u.pathname}` !== NEWS_ENDPOINTS.hub.url) return base(url, init);
    const query = u.searchParams.get('query');
    queries.push(query);
    const items = query === '구리갈매역세권' ? [
      raw('<b>구리갈매역세권</b> B-1블록 신안인스빌 디센트 9일 특별공급', 'Mon, 09 Nov 2026 10:00:00 +0900', 'https://www.newsis.com/view/1'),
      raw('구리갈매역세권 분양가 비교', 'Sun, 08 Nov 2026 10:00:00 +0900', straight), // news.yaml과 같은 주소: 뺌
      raw('구리갈매역세권 교통 대책', 'Mon, 26 Oct 2026 10:00:00 +0900', 'https://www.yna.co.kr/old'), // 15일 전: 수집에서 뺌
    ] : [];
    return Response.json({ total: items.length, start: 1, display: items.length, items });
  };
  const data = await buildMap({
    fetch,
    env: { DATA_GO_KR_KEY: 'k', NAVER_CLIENT_ID: 'test-id', NAVER_CLIENT_SECRET: 'test-secret' },
    today,
    seoulFile,
    newtownsFile: DEFAULT_NEWTOWNS,
    newsFile: DEFAULT_NEWS,
    sleep: noSleep,
  });
  assert.ok(queries.includes('구리갈매역세권'));
  const galmaeNews = data.feed.filter((i) => i.kind === '뉴스' && i.projectId === 'town-guri-galmae-station');
  const naver = galmaeNews.filter((i) => i.source.provider === 'naver');
  assert.deepEqual(naver.map((i) => [i.date, i.block, i.title, i.source.title, i.source.url]), [
    ['2026-11-09', 'B-1', '구리갈매역세권 B-1블록 신안인스빌 디센트 9일 특별공급', '뉴시스', 'https://www.newsis.com/view/1'],
  ]);
  // 손으로 고른 기사(우리 요약)는 그대로 있고, 같은 주소의 네이버 기사는 없다
  assert.equal(galmaeNews.filter((i) => i.source.url === straight).length, 1);
  assert.equal(galmaeNews.find((i) => i.source.url === straight).source.provider, undefined);
  // 사업의 news(관련 소식)는 #24 형태 그대로
  assert.deepEqual(data.projects.find((p) => p.id === 'town-guri-galmae-station').news.map((n) => n.url), ['https://www.newsis.com/view/1', straight]);
  assert.equal(JSON.stringify(data).includes('요약은 저장하지 않는다'), false);
  assert.ok(data.sources.curatedNews.count > 0);
  assert.equal(data.sources.news.matched, 1);
  const lines = summaryLines(data);
  assert.match(lines[0], / curated=\d+$/);
  assert.ok(lines.some((line) => /^map news checked=\d+ matched=1 projects=\d+ errors=0 stopped=none$/.test(line)));
  assert.ok(lines.every((line) => !line.includes('http') && !line.includes('test-id')));
});

test('Naver items are capped at 40 (newest first) before the Seoul cap and do not count toward it', () => {
  assert.equal(NAVER_MAX, 40);
  const naverProjects = Array.from({ length: 120 }, (_, i) => ({
    id: `seoul-${5000 + i}`,
    region: '서울',
    kind: '재개발',
    news: [{ title: `기사 ${i}`, outlet: '뉴시스', date: i < 60 ? '2026-11-09' : '2026-11-01', url: `https://www.newsis.com/${i}` }],
  }));
  const noticeProjects = Array.from({ length: 50 }, (_, i) => ({
    id: `seoul-${1000 + i}`,
    region: '서울',
    kind: '재개발',
    notices: [{
      key: `n${i}`, name: `단지 ${i}`, announceDate: '2026-09-01', end: '2026-09-15', url: 'https://www.applyhome.co.kr/x', typeLabel: 'APT', stages: [],
    }],
  }));
  const feed = buildFeed({ projects: [...naverProjects, ...noticeProjects], today });
  const naver = feed.filter((i) => i.source.provider === 'naver');
  assert.equal(naver.length, NAVER_MAX);
  // 최신순: 11-09 기사 60건 중 40건만
  assert.ok(naver.every((i) => i.date === '2026-11-09'));
  assert.equal(feed.filter((i) => i.kind === '공고').length, 50);
  // 서울 200건에 네이버는 세지 않는다: 공고 200건 + 네이버 40건
  const many = Array.from({ length: 250 }, (_, i) => ({
    id: `seoul-${7000 + i}`, region: '서울', kind: '재개발', notices: [{ key: `m${i}`, name: `단지 ${i}`, announceDate: '2026-09-01', end: '2026-09-15', url: 'https://www.applyhome.co.kr/x', typeLabel: 'APT', stages: [] }],
  }));
  const capped = buildFeed({ projects: [...naverProjects, ...many], today });
  assert.equal(capped.filter((i) => i.kind === '공고').length, FEED_MAX);
  assert.equal(capped.filter((i) => i.source.provider === 'naver').length, NAVER_MAX);
});

test('normalizeUrl matches m./www./tracking variants but keeps article ids in the query', () => {
  const base = 'straightnews.co.kr/news/articleView.html?idxno=314854';
  for (const url of [
    'https://www.straightnews.co.kr/news/articleView.html?idxno=314854',
    'http://m.straightnews.co.kr/news/articleView.html?idxno=314854&utm_source=naver&utm_medium=news',
    'https://WWW.StraightNews.co.kr/news/articleView.html?idxno=314854#comments',
    'https://mobile.straightnews.co.kr/news/articleView.html?fbclid=abc&idxno=314854',
  ]) assert.equal(normalizeUrl(url), base, url);
  assert.notEqual(normalizeUrl('https://www.straightnews.co.kr/news/articleView.html?idxno=314855'), base);
  assert.equal(normalizeUrl('https://www.newsis.com/view/1/'), 'newsis.com/view/1');
  assert.equal(normalizeUrl('not a url'), 'not a url');
  // dropCoveredNaver가 이 비교값을 쓴다
  const curated = { projectId: 'p', kind: '뉴스', source: { url: 'https://www.straightnews.co.kr/news/articleView.html?idxno=314854' } };
  const naver = { projectId: 'p', kind: '뉴스', source: { url: 'https://m.straightnews.co.kr/news/articleView.html?idxno=314854&utm_source=naver', provider: 'naver' } };
  const other = { projectId: 'p', kind: '뉴스', source: { url: 'https://m.straightnews.co.kr/news/articleView.html?idxno=314855', provider: 'naver' } };
  assert.deepEqual(dropCoveredNaver([curated, naver, other]), [curated, other]);
});
