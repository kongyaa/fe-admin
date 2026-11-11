import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  dateGap,
  dedupeAcrossSources,
  isDuplicate,
  noticeScore,
  normalizeName,
  pickWinner,
  regionRule,
  splitDuplicates,
  splitTableScope,
  tableRegions,
  urbtyRule,
} from '../src/table-scope.js';

// 모두 만든 값이다. 실제 공고 이름과 번호가 아니다.
const base = { tableRegions: ['서울', '경기', '인천', '세종'], excludeUrbty: true };
const applyhome = (extra = {}) => ({
  key: '100-1',
  source: '청약홈',
  kind: 'remainder',
  typeLabel: '무순위',
  name: '가나지구 A-2블록 신혼희망타운(공공분양) 잔여세대 추가입주자모집공고',
  region: '서울',
  address: '서울특별시 강남구 가나동 1',
  announceDate: '2026-11-01',
  stages: [{ name: '무순위 접수', start: '2026-11-10', end: '2026-11-12' }],
  overallStart: '2026-11-10',
  overallEnd: '2026-11-12',
  ...extra,
});
const lh = (extra = {}) => ({
  key: 'LH-0001',
  source: 'LH',
  kind: 'lh',
  typeLabel: '분양주택 공공분양',
  name: '가나지구 A-2블록 신혼희망타운[공공분양] 잔여세대 추가입주자모집공고',
  region: '서울',
  address: '서울특별시',
  announceDate: '2026-11-02',
  stages: [{ name: '공고~마감', start: '2026-11-02', end: '2026-11-20' }],
  overallStart: '2026-11-02',
  overallEnd: '2026-11-20',
  windowFromList: true,
  ...extra,
});
const row = (key, extra = {}) => ({ id: `id-${key}`, key, name: '이름', typeLabel: '무순위', region: '서울', source: '청약홈', interest: false, ...extra });
const rowsOf = (...items) => new Map(items.map((item) => [item.key, item]));

test('normalizeName unifies bracket styles, whitespace and case but keeps type words', () => {
  assert.equal(normalizeName('A-2블록 신혼희망타운(공공분양) 잔여세대'), normalizeName('A-2블록 신혼희망타운[공공분양]  잔여세대'));
  assert.equal(normalizeName('단지【공공분양】'), normalizeName('단지（공공분양）'));
  assert.equal(normalizeName('Park 단지 (B1)'), normalizeName('park단지[b1]'));
  // 유형 단어는 남긴다.
  assert.notEqual(normalizeName('단지 잔여세대'), normalizeName('단지'));
  assert.notEqual(normalizeName('단지(A17BL) 공공분양주택'), normalizeName('단지(A17BL) 지분적립형 분양주택'));
  assert.equal(normalizeName(null), '');
});

test('a bracket-style variant from the other source is a duplicate', () => {
  assert.equal(isDuplicate(applyhome(), lh()), true);
  assert.equal(isDuplicate(lh(), applyhome()), true);
});

test('the same complex with a different 유형 word is NOT a duplicate', () => {
  const a = applyhome({ name: '다라지구 단지(A17BL) 공공분양주택' });
  const b = lh({ name: '다라지구 단지(A17BL) 지분적립형 분양주택' });
  assert.equal(isDuplicate(a, b), false);
  const same = lh({ name: '다라지구 단지[A17BL] 공공분양주택' });
  assert.equal(isDuplicate(a, same), true);
  // 잔여세대 공고와 본청약 공고도 이름이 다르면 합치지 않는다.
  assert.equal(isDuplicate(applyhome({ name: '단지 A-2블록 신혼희망타운' }), lh({ name: '단지 A-2블록 신혼희망타운 잔여세대' })), false);
});

test('a different region is NOT a duplicate, and unknown regions are not matched', () => {
  assert.equal(isDuplicate(applyhome(), lh({ region: '경기' })), false);
  assert.equal(isDuplicate(applyhome({ region: null }), lh({ region: null })), false);
});

test('dates too far apart are NOT a duplicate; close announce dates or overlapping windows are', () => {
  const far = lh({ announceDate: '2026-12-20', overallStart: '2026-12-20', overallEnd: '2027-01-10', stages: [{ name: '공고~마감', start: '2026-12-20', end: '2027-01-10' }] });
  assert.equal(isDuplicate(applyhome(), far), false);
  // 모집공고일이 3일 차이면 같은 공고, 4일이면 접수 기간이 겹치지 않는 한 다르다.
  const noWindow = (extra) => ({ announceDate: null, stages: [], overallStart: null, overallEnd: null, ...extra });
  assert.equal(isDuplicate(applyhome({ ...noWindow({ announceDate: '2026-11-01' }) }), lh({ ...noWindow({ announceDate: '2026-11-04' }) })), true);
  assert.equal(isDuplicate(applyhome({ ...noWindow({ announceDate: '2026-11-01' }) }), lh({ ...noWindow({ announceDate: '2026-11-05' }) })), false);
  // 모집공고일이 멀어도 접수 기간이 겹치면(LH 목록은 공고일부터 마감일까지) 같은 공고다.
  assert.equal(isDuplicate(applyhome({ announceDate: '2026-10-01' }), lh({ announceDate: '2026-11-02' })), true);
  // 접수 기간 사이가 3일 안이면 같고, 그보다 멀면 다르다.
  const window = (start, end) => ({ announceDate: null, overallStart: start, overallEnd: end, stages: [{ name: '접수', start, end }] });
  assert.equal(isDuplicate(applyhome(window('2026-11-01', '2026-11-03')), lh(window('2026-11-06', '2026-11-08'))), true);
  assert.equal(isDuplicate(applyhome(window('2026-11-01', '2026-11-03')), lh(window('2026-11-07', '2026-11-08'))), false);
  // 날짜가 하나도 없으면 합치지 않는다.
  assert.equal(dateGap(applyhome(noWindow({})), lh(noWindow({}))), Infinity);
  assert.equal(isDuplicate(applyhome(noWindow({})), lh(noWindow({}))), false);
});

test('notices from the same source are never merged', () => {
  const a = applyhome({ key: '1-1' });
  const b = applyhome({ key: '2-1', name: '가나지구 A-2블록 신혼희망타운[공공분양] 잔여세대 추가입주자모집공고' });
  assert.equal(isDuplicate(a, b), false);
  assert.equal(dedupeAcrossSources([a, b], base).duplicates.length, 0);
});

test('the richer notice wins; a tie goes to 청약홈; the winner does not depend on input order', () => {
  // 목록 수준의 정보: 청약홈은 단계와 상세 주소가 있고 LH는 시도 이름만 있는 주소와 단계 하나다.
  assert.ok(noticeScore(applyhome()) > noticeScore(lh()));
  assert.equal(pickWinner(applyhome(), lh()).source, '청약홈');
  // LH가 더 풍부하면 LH가 이긴다(주택형 가격과 상세 주소).
  const rich = lh({ address: '서울특별시 강남구 가나동 1', models: [{ area: 59, price: 50000 }, { area: 84, price: 70000 }], stages: [{ start: '2026-11-02' }, { start: '2026-11-10' }, { start: '2026-11-11' }] });
  const poor = applyhome({ address: '', stages: [{ name: '무순위 접수', start: '2026-11-10' }] });
  assert.ok(noticeScore(rich) > noticeScore(poor));
  assert.equal(pickWinner(rich, poor).source, 'LH');
  assert.equal(pickWinner(poor, rich).source, 'LH');
  // 점수가 같으면 청약홈
  const tieA = applyhome({ address: '', stages: [{ start: '2026-11-10' }] });
  const tieL = lh({ stages: [{ start: '2026-11-10' }] });
  assert.equal(noticeScore(tieA), noticeScore(tieL));
  assert.equal(pickWinner(tieA, tieL).source, '청약홈');
  assert.equal(pickWinner(tieL, tieA).source, '청약홈');
  // 날짜 없는 단계와 가격 없는 주택형은 점수에 넣지 않는다.
  assert.equal(noticeScore({ stages: [{ name: 'x' }], models: [{ price: 0 }], address: '서울' }), 0);
});

test('the same inputs always give the same winner whatever the order', () => {
  const notices = [
    applyhome({ key: '1-1' }),
    lh({ key: 'LH-1' }),
    applyhome({ key: '2-1', name: '마바지구 단지(잔여세대)', region: '경기', address: '경기도 수원시 1', announceDate: '2026-11-03', overallStart: '2026-11-11', overallEnd: '2026-11-11', stages: [{ start: '2026-11-11' }] }),
    lh({ key: 'LH-2', name: '마바지구 단지[잔여세대]', region: '경기', address: '경기도 수원시 1', announceDate: '2026-11-03', overallStart: '2026-11-11', overallEnd: '2026-11-11', stages: [{ start: '2026-11-11' }] }),
    applyhome({ key: '3-1', name: '사아지구 단지', region: '인천' }),
  ];
  const winners = (list) => dedupeAcrossSources(list, base).duplicates.map(({ winner, loser }) => `${winner.key}>${loser.key}`).sort();
  const expected = winners(notices);
  assert.deepEqual(expected, ['1-1>LH-1', '2-1>LH-2']);
  // 순서를 여러 가지로 바꿔도 같고, 같은 입력을 되풀이해도 같다.
  for (let shift = 0; shift < notices.length; shift += 1) {
    const rotated = [...notices.slice(shift), ...notices.slice(0, shift)];
    assert.deepEqual(winners(rotated), expected);
    assert.deepEqual(winners(rotated.toReversed()), expected);
    assert.deepEqual(winners(rotated), winners(rotated));
  }
  // 남는 공고는 입력 순서를 지킨다.
  const kept = dedupeAcrossSources(notices, base).notices.map((notice) => notice.key);
  assert.deepEqual(kept, ['1-1', '2-1', '3-1']);
});

test('one notice is matched to at most one counterpart', () => {
  const a = applyhome({ key: '1-1' });
  const l1 = lh({ key: 'LH-1' });
  const l2 = lh({ key: 'LH-2' });
  const { notices, duplicates } = dedupeAcrossSources([l2, a, l1], base);
  assert.equal(duplicates.length, 1);
  assert.equal(notices.length, 2);
  assert.deepEqual(notices.map((notice) => notice.key).sort(), ['LH-2', '1-1'].sort());
});

test('with dedupeAcrossSources false nothing is merged; missing keys keep it on', () => {
  assert.equal(dedupeAcrossSources([applyhome(), lh()], { ...base, dedupeAcrossSources: false }).notices.length, 2);
  assert.equal(dedupeAcrossSources([applyhome(), lh()], base).notices.length, 1);
  // 허용 간격은 설정으로 바꾼다.
  const apart = [applyhome({ announceDate: '2026-11-01', overallStart: null, overallEnd: null, stages: [] }), lh({ announceDate: '2026-11-08', overallStart: null, overallEnd: null, stages: [] })];
  assert.equal(dedupeAcrossSources(apart, base).notices.length, 2);
  assert.equal(dedupeAcrossSources(apart, { ...base, duplicateToleranceDays: 7 }).notices.length, 1);
});

test('exempt notices are left out of the comparison', () => {
  const result = dedupeAcrossSources([applyhome(), lh()], base, new Set(['LH-0001']));
  assert.equal(result.notices.length, 2);
});

test('splitDuplicates trashes a stored loser row but keeps a checked 관심 row, and counts only', () => {
  const stored = rowsOf(row('LH-0001', { source: 'LH' }), row('100-1'));
  const out = splitDuplicates([applyhome(), lh()], stored, base);
  assert.deepEqual(out.notices.map((notice) => notice.key), ['100-1']);
  assert.deepEqual(out.archiveRows.map((item) => item.id), ['id-LH-0001']);
  assert.deepEqual([out.counts.duplicate_skipped, out.counts.duplicate_kept_interest], [1, 0]);

  const kept = splitDuplicates([applyhome(), lh()], rowsOf(row('LH-0001', { source: 'LH', interest: true })), base);
  assert.deepEqual(kept.archiveRows, []);
  assert.deepEqual([kept.counts.duplicate_skipped, kept.counts.duplicate_kept_interest], [1, 1]);

  // 저장된 행이 없으면 건너뛴 수만 센다.
  const none = splitDuplicates([applyhome(), lh()], new Map(), base);
  assert.deepEqual([none.archiveRows.length, none.counts.duplicate_skipped, none.counts.duplicate_kept_interest], [0, 1, 0]);
});

// ---------- 지역 범위 ----------

test('regionRule drops only known regions outside tableRegions', () => {
  assert.equal(regionRule({ region: '부산' }, base), 'region');
  assert.equal(regionRule({ region: '대전' }, base), 'region');
  assert.equal(regionRule({ region: '전북' }, base), 'region');
  assert.equal(regionRule({ region: '제주' }, base), 'region');
  for (const region of ['서울', '경기', '인천', '세종']) assert.equal(regionRule({ region }, base), null, region);
  // 모르는 지역은 남긴다.
  for (const region of [null, undefined, '', '  ', '전국', '수도권', '알수없음']) assert.equal(regionRule({ region }, base), null, String(region));
});

test('tableRegions missing, not an array or empty turns the feature off', () => {
  for (const value of [undefined, null, '서울', { 0: '서울' }, 7, []]) {
    const config = { tableRegions: value };
    assert.equal(tableRegions(config), null, JSON.stringify(value));
    assert.equal(regionRule({ region: '부산' }, config), null, JSON.stringify(value));
  }
  assert.equal(regionRule({ region: '부산' }, {}), null);
  assert.deepEqual(tableRegions({ tableRegions: ['서울'] }), ['서울']);
  // 배포하는 설정은 세종을 포함한다.
  const shipped = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.deepEqual(shipped.tableRegions, ['서울', '경기', '인천', '세종']);
  assert.equal(shipped.excludeUrbty, true);
});

test('urbtyRule follows kind for notices and the type name for stored rows, and is off by default', () => {
  assert.equal(urbtyRule({ kind: 'urbty' }, base), 'urbty');
  assert.equal(urbtyRule({ kind: 'apt', typeLabel: '오피스텔' }, base), null);
  for (const typeLabel of ['오피스텔', '도시형생활주택', '생활숙박시설']) assert.equal(urbtyRule({ typeLabel }, base), 'urbty', typeLabel);
  assert.equal(urbtyRule({ typeLabel: 'APT' }, base), null);
  assert.equal(urbtyRule({ typeLabel: null }, base), null);
  for (const config of [{}, { excludeUrbty: false }]) assert.equal(urbtyRule({ kind: 'urbty', typeLabel: '오피스텔' }, config), null);
});

test('splitTableScope skips and trashes out-of-region notices and keeps 세종, unknown regions and 관심 rows', () => {
  const notices = [
    applyhome({ key: 'seoul', region: '서울' }),
    applyhome({ key: 'sejong', region: '세종' }),
    applyhome({ key: 'unknown', region: null }),
    applyhome({ key: 'busan', region: '부산' }),
    applyhome({ key: 'jeju', region: '제주', kind: 'apt', typeLabel: 'APT', name: '제주 토지임대부 단지' }),
    applyhome({ key: 'daejeon', region: '대전' }),
  ];
  const stored = rowsOf(
    row('busan', { region: '부산' }),
    row('daejeon', { region: '대전', interest: true }),
    row('seoul'),
    // 이번에 수집되지 않은 행: 저장된 지역으로 판정한다.
    row('old-jeonbuk', { region: '전북' }),
    row('old-noregion', { region: null }),
    row('old-sejong', { region: '세종' }),
    row('old-interest', { region: '부산', interest: true }),
  );
  const out = splitTableScope(notices, stored, base);
  assert.deepEqual(out.notices.map((notice) => notice.key), ['seoul', 'sejong', 'unknown', 'daejeon']);
  assert.deepEqual(out.archiveRows.region.map((item) => item.key).sort(), ['busan', 'old-jeonbuk']);
  assert.deepEqual(out.archiveRows.urbty, []);
  assert.deepEqual([out.counts.region_scope_skipped, out.counts.region_scope_kept_interest], [2, 2]);
  assert.deepEqual([...out.keptOutKeys], ['daejeon']);
});

test('splitTableScope with the feature off changes nothing', () => {
  const notices = [applyhome({ key: 'busan', region: '부산' })];
  for (const config of [{}, { tableRegions: 'seoul' }, { tableRegions: [] }]) {
    const out = splitTableScope(notices, rowsOf(row('busan', { region: '부산' })), config);
    assert.equal(out.notices.length, 1);
    assert.deepEqual(out.archiveRows, { urbty: [], region: [] });
    assert.equal(out.counts.region_scope_skipped, 0);
  }
});

test('splitTableScope drops a restricted 토지임대부 notice outside the scope once', () => {
  const jeju = applyhome({ key: 'jeju', region: '제주', kind: 'apt', typeLabel: 'APT', name: '제주 토지임대부 단지' });
  const out = splitTableScope([jeju], rowsOf(row('jeju', { region: '제주' })), base);
  assert.equal(out.notices.length, 0);
  assert.deepEqual(out.archiveRows.region.map((item) => item.key), ['jeju']);
  assert.equal(out.counts.region_scope_skipped, 1);
});

test('splitTableScope skips and trashes urbty notices; 관심 rows stay; the flag off changes nothing', () => {
  const notices = [applyhome({ key: 'u1', kind: 'urbty', typeLabel: '오피스텔' }), applyhome({ key: 'u2', kind: 'urbty', typeLabel: '도시형생활주택' }), applyhome({ key: 'a1', kind: 'apt', typeLabel: 'APT' })];
  const stored = rowsOf(row('u1', { typeLabel: '오피스텔' }), row('u2', { typeLabel: '도시형생활주택', interest: true }), row('old', { typeLabel: '생활숙박시설' }), row('old-keep', { typeLabel: '생활숙박시설', interest: true }), row('a1', { typeLabel: 'APT' }));
  const out = splitTableScope(notices, stored, base);
  assert.deepEqual(out.notices.map((notice) => notice.key), ['u2', 'a1']);
  assert.deepEqual(out.archiveRows.urbty.map((item) => item.key).sort(), ['old', 'u1']);
  assert.deepEqual([out.counts.urbty_skipped, out.counts.urbty_kept_interest], [1, 2]);
  const off = splitTableScope(notices, stored, { ...base, excludeUrbty: false });
  assert.equal(off.notices.length, 3);
  assert.deepEqual(off.archiveRows.urbty, []);
});

test('a notice matching two cleanups is counted and trashed once, under 오피스텔 first', () => {
  const both = applyhome({ key: 'both', kind: 'urbty', typeLabel: '오피스텔', region: '부산' });
  const stored = rowsOf(row('both', { typeLabel: '오피스텔', region: '부산' }), row('old-both', { typeLabel: '오피스텔', region: '부산' }));
  const out = splitTableScope([both], stored, base);
  assert.deepEqual([out.counts.urbty_skipped, out.counts.region_scope_skipped], [1, 0]);
  assert.deepEqual(out.archiveRows.urbty.map((item) => item.key).sort(), ['both', 'old-both']);
  assert.deepEqual(out.archiveRows.region, []);
  // 관심 행도 한 번만 센다.
  const kept = splitTableScope([both], rowsOf(row('both', { typeLabel: '오피스텔', region: '부산', interest: true })), base);
  assert.deepEqual([kept.counts.urbty_kept_interest, kept.counts.region_scope_kept_interest], [1, 0]);
});

test('keys claimed by the LH scope are not counted or trashed again', () => {
  const lhBusan = lh({ key: 'LH-b', region: '부산' });
  const stored = rowsOf(row('LH-b', { region: '부산', source: 'LH', interest: true }), row('LH-old', { region: '부산', source: 'LH' }));
  const out = splitTableScope([lhBusan], stored, base, new Set(['LH-b', 'LH-old']));
  assert.equal(out.notices.length, 1);
  assert.deepEqual(out.archiveRows, { urbty: [], region: [] });
  assert.deepEqual(Object.values(out.counts).reduce((sum, value) => sum + value, 0), 0);
});
