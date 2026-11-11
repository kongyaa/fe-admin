import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { run } from '../src/main.js';

// run() 통합 시험. 공고 이름과 번호는 모두 만든 값이다. 설정은 배포하는 config.json을 쓴다.
const THU_NOW = '2026-11-04T22:30:00Z';
const THU = '2026-11-05';
const fileConfig = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
// 작은 표로 시험하므로 옮길 비율 상한은 풀고(1), 상한 시험만 따로 건다.
const loose = { ...fileConfig, cleanupMaxShare: 1 };
const PROFILE_JSON = '{"residenceSido":"인천","residenceYears":3,"specialTracks":["생애최초"]}';

const DUP_NAME = '가나지구 A-2블록 신혼희망타운(공공분양) 잔여세대 추가입주자모집공고';
const DUP_NAME_LH = '가나지구 A-2블록 신혼희망타운[공공분양] 잔여세대 추가입주자모집공고';

// 오늘 접수 시작이라 로또 알림이 가는 서울 무순위. 정리 때문에 알림이 막히지 않는지 보려고 둔다.
const alertRow = {
  HOUSE_MANAGE_NO: '7', PBLANC_NO: '7', HOUSE_NM: '알림단지', HOUSE_SECD: '04', SUBSCRPT_AREA_CODE_NM: '서울', HSSPLY_ADRES: '서울특별시 강남구 역삼동 1',
  RCRIT_PBLANC_DE: '2026-11-01', SUBSCRPT_RCEPT_BGNDE: THU, SUBSCRPT_RCEPT_ENDDE: THU, PBLANC_URL: 'https://www.applyhome.co.kr/a',
};
const remainder = (no, name, { region = '서울', address, announce = '2026-11-01', start = '2026-11-10', end = '2026-11-12' } = {}) => ({
  HOUSE_MANAGE_NO: String(no), PBLANC_NO: '1', HOUSE_NM: name, HOUSE_SECD: '04', SUBSCRPT_AREA_CODE_NM: region,
  HSSPLY_ADRES: address ?? (region ? `${region} 가나구 가나동 ${no}` : ''), RCRIT_PBLANC_DE: announce, SUBSCRPT_RCEPT_BGNDE: start, SUBSCRPT_RCEPT_ENDDE: end, PBLANC_URL: 'https://www.applyhome.co.kr/x',
});
const aptRowOf = (no, name, region) => ({
  HOUSE_MANAGE_NO: String(no), PBLANC_NO: '1', HOUSE_NM: name, HOUSE_SECD: '01', SUBSCRPT_AREA_CODE_NM: region, HSSPLY_ADRES: `${region} 가나구 가나동 ${no}`,
  RCRIT_PBLANC_DE: '2026-11-01', RCEPT_BGNDE: '2026-11-10', RCEPT_ENDDE: '2026-11-12', PBLANC_URL: 'https://www.applyhome.co.kr/x',
});
const urbtyRow = (no, name, region = '서울') => ({
  HOUSE_MANAGE_NO: String(no), PBLANC_NO: '1', HOUSE_NM: name, HOUSE_SECD: '02', SEARCH_HOUSE_SECD: '0202', SUBSCRPT_AREA_CODE_NM: region, HSSPLY_ADRES: `${region} 가나구 가나동 ${no}`,
  RCRIT_PBLANC_DE: '2026-11-01', SUBSCRPT_RCEPT_BGNDE: '2026-11-10', SUBSCRPT_RCEPT_ENDDE: '2026-11-12', PBLANC_URL: 'https://www.applyhome.co.kr/x',
});
const lhRow = (id, name, cnp = '서울특별시', { start = '2026.11.02', end = '2026.11.20' } = {}) => ({
  PAN_ID: id, PAN_NM: name, UPP_AIS_TP_NM: '분양주택', AIS_TP_CD_NM: '공공분양', CNP_CD_NM: cnp, PAN_NT_ST_DT: start, CLSG_DT: end, DTL_URL: 'https://apply.lh.or.kr/x',
});

function apiFetch({ remainders = [], apts = [], urbties = [], lhRows = [] } = {}) {
  const page = (rows) => Response.json({ totalCount: rows.length, data: rows });
  return async (url) => {
    const text = String(url);
    if (text.includes('getRemndrLttotPblancDetail')) return page(remainders);
    if (text.includes('getAPTLttotPblancDetail')) return page(apts);
    if (text.includes('getUrbtyOfctlLttotPblancDetail')) return page(urbties);
    if (text.includes('lhLeaseNoticeInfo1/lhLeaseNoticeInfo1')) return Response.json([{ dsList: lhRows.map((item) => ({ ...item, ALL_CNT: lhRows.length })) }]);
    if (text.includes('api.odcloud.kr')) return Response.json({ totalCount: 0, data: [] });
    if (text.includes('apis.data.go.kr/1613000')) return new Response('<r><resultCode>000</resultCode><totalCount>0</totalCount></r>');
    return Response.json([{ dsList: [] }]);
  };
}

const stored = (key, extra = {}) => ({
  id: `id-${key}`, key, lotto: null, urgentDate: null, start: '2026-11-10', end: '2026-12-01', interest: false, name: '저장된 이름', typeLabel: '무순위', region: '서울', source: '청약홈', ...extra,
});

function fakeStore(rows = [], { archiveFails = [] } = {}) {
  const existing = new Map(rows.map((item) => [item.key, item]));
  const state = { upserts: [], stamps: [], archived: [], events: [] };
  return {
    state,
    init: async () => {},
    loadExisting: async () => existing,
    upsert: async (item) => { state.upserts.push(item.key); return `page-${item.key}`; },
    stampUrgent: async (id, date) => { state.stamps.push({ id, date }); },
    getWeeklyState: async () => '2026-11-02',
    setWeeklyState: async () => {},
    setReceptionStatus: async () => false,
    archivePage: async (id) => {
      if (archiveFails.includes(id)) throw new Error('https://api.notion.com/v1/pages secret-body');
      state.archived.push(id);
      state.events.push(`archive ${id}`);
    },
  };
}

function harness({ store, world, argv = [], env = {}, config } = {}) {
  const mails = [];
  const kakao = [];
  const logs = [];
  const deps = {
    fetch: apiFetch(world),
    store,
    accessToken: 'token',
    sleep: async () => {},
    now: () => new Date(THU_NOW),
    log: (line) => logs.push(line),
    write: () => {},
    sendMail: async (mail) => { mails.push(mail); },
    sendKakao: async (message) => { kakao.push(message); store.state.events.push('kakao'); },
    config: config ?? loose,
  };
  const fullEnv = { DATA_GO_KR_KEY: 'SECRET-DATA-KEY', NOTION_KEY: 'n', CHUNGYAK_NOTION_PAGE_ID: 'p', ...env };
  return { argv, deps, env: fullEnv, mails, kakao, logs, store };
}
const go = (h) => run({ argv: h.argv, env: h.env, deps: h.deps });
const summary = (h) => h.logs.find((line) => line.startsWith('collected='));
const errorMail = (h) => h.mails.find((mail) => mail.subject.includes('배치 오류'));
const count = (h, name) => Number(new RegExp(` ${name}=(\\d+)`).exec(summary(h))[1]);

// ---------- 소스 사이 중복 ----------

const dupWorld = () => ({
  remainders: [alertRow, remainder(31, DUP_NAME)],
  lhRows: [lhRow('d1', DUP_NAME_LH)],
});

test('the 청약홈 notice wins over the richer-looking LH variant; the stored LH loser goes to the trash after the alerts', async () => {
  const store = fakeStore([stored('31-1'), stored('LH-d1', { source: 'LH', typeLabel: '분양주택 공공분양' })]);
  const h = harness({ store, world: dupWorld() });
  assert.equal(await go(h), 0);
  // 승자만 저장한다. 진 LH 공고는 판별도 저장도 알림도 하지 않는다.
  assert.ok(store.state.upserts.includes('31-1'));
  assert.ok(!store.state.upserts.includes('LH-d1'));
  assert.equal(h.kakao.length, 1);
  assert.deepEqual(store.state.archived, ['id-LH-d1']);
  // 휴지통 이동은 알림과 발송 기록 뒤다.
  assert.ok(store.state.events.indexOf('kakao') < store.state.events.indexOf('archive id-LH-d1'));
  assert.ok(count(h, 'duplicate_skipped') === 1 && count(h, 'duplicate_archived') === 1 && count(h, 'duplicate_kept_interest') === 0);
  // 로그에는 건수만 있고 공고 이름은 없다.
  assert.ok(!h.logs.join('\n').includes('신혼희망타운') && !h.logs.join('\n').includes('가나지구'));
  assert.equal(errorMail(h), undefined);
});

test('the winner does not flip when the LH row is listed first', async () => {
  const store = fakeStore([]);
  const world = dupWorld();
  const h = harness({ store, world: { ...world, remainders: [remainder(31, DUP_NAME), alertRow] } });
  assert.equal(await go(h), 0);
  assert.deepEqual(store.state.upserts.filter((key) => key !== '7-7'), ['31-1']);
  assert.equal(count(h, 'duplicate_skipped'), 1);
  assert.equal(count(h, 'duplicate_archived'), 0);
});

test('a pair with a 관심 row is not merged: both notices stay in the normal flow and nothing is archived', async () => {
  const store = fakeStore([stored('31-1'), stored('LH-d1', { source: 'LH', typeLabel: '분양주택 공공분양', interest: true })]);
  const h = harness({ store, world: dupWorld() });
  assert.equal(await go(h), 0);
  assert.deepEqual(store.state.archived, []);
  // 예전에는 관심 행의 공고를 얼려 두었다. 이제는 두 공고 모두 보통 공고처럼 갱신한다.
  assert.ok(store.state.upserts.includes('LH-d1') && store.state.upserts.includes('31-1'));
  assert.ok(count(h, 'duplicate_skipped') === 0 && count(h, 'duplicate_archived') === 0 && count(h, 'duplicate_kept_interest') === 1 && count(h, 'duplicate_pairs_examined') === 1, summary(h));
});

test('a pair whose stored row has 역 도보(분) typed in is not merged either', async () => {
  const store = fakeStore([stored('31-1'), stored('LH-d1', { source: 'LH', typeLabel: '분양주택 공공분양', walkMinutes: 9 })]);
  const h = harness({ store, world: dupWorld() });
  assert.equal(await go(h), 0);
  assert.deepEqual(store.state.archived, []);
  assert.ok(store.state.upserts.includes('LH-d1'));
  assert.ok(count(h, 'duplicate_skipped') === 0 && count(h, 'duplicate_kept_interest') === 1, summary(h));
});

test('a 관심 loser whose 청약홈 winner is unapplicable is not frozen: the 관심 notice is still updated normally', async () => {
  // 부산 공고(수도권 거주 프로필 기준 신청할 수 없음)라 청약홈 쪽은 저장하지 않는다. 합쳤다면 관심 행의 LH 공고가 얼어 아무것도 남지 않는다.
  // 이름에 신혼희망 같은 제한 유형 단어가 있으면 신청할 수 없는 공고로 보지 않으므로 쓰지 않는다.
  const world = { apts: [aptRowOf(81, '타카지구 단지 민영주택', '부산')], lhRows: [lhRow('u1', '타카지구 단지[민영주택]', '부산광역시')] };
  const store = fakeStore([stored('LH-u1', { source: 'LH', region: '부산', typeLabel: '분양주택 공공분양', interest: true })]);
  const h = harness({ store, world, env: { CHUNGYAK_PROFILE: PROFILE_JSON }, config: { ...loose, tableRegions: undefined } });
  assert.equal(await go(h), 0);
  assert.deepEqual(store.state.upserts, ['LH-u1']);
  // LH 부산 공고는 LH 범위 규칙이 관심으로 남겼으므로 그쪽에서만 센다(합치기 규칙은 그 공고가 든 쌍을 건너뛴다).
  assert.ok(count(h, 'unapplicable_skipped') === 1 && count(h, 'duplicate_skipped') === 0 && count(h, 'lh_out_of_scope_kept_interest') === 1, summary(h));
  assert.deepEqual(store.state.archived, []);
});

test('an LH notice kept by the LH out-of-scope 관심 exemption enters no merge', async () => {
  // LH 부산 공고는 LH 범위 밖이지만 관심 행이라 남는다. 같은 이름의 청약홈 부산 공고와 합치지 않는다(범위 규칙이 이미 센 공고).
  const world = { remainders: [remainder(82, DUP_NAME, { region: '부산' })], lhRows: [lhRow('o1', DUP_NAME_LH, '부산광역시')] };
  const store = fakeStore([stored('LH-o1', { source: 'LH', region: '부산', typeLabel: '분양주택 공공분양', interest: true })]);
  const h = harness({ store, world, config: { ...loose, tableRegions: undefined } });
  assert.equal(await go(h), 0);
  assert.ok(store.state.upserts.includes('LH-o1') && store.state.upserts.includes('82-1'));
  assert.ok(count(h, 'lh_out_of_scope_kept_interest') === 1 && count(h, 'duplicate_skipped') === 0, summary(h));
  assert.deepEqual(store.state.archived, []);
});

test('a live LH re-announcement is not merged away by an ended 청약홈 round of the same name', async () => {
  // 청약홈 회차는 10-24~10-26에 끝났고(공고 10-23) 같은 이름의 LH 재공고(공고 10-24)는 11-20까지 진행 중이다.
  const world = {
    remainders: [remainder(83, DUP_NAME, { announce: '2026-10-23', start: '2026-10-24', end: '2026-10-26' })],
    lhRows: [lhRow('e1', DUP_NAME_LH, '서울특별시', { start: '2026.10.24', end: '2026.11.20' })],
  };
  const store = fakeStore([stored('LH-e1', { source: 'LH', typeLabel: '분양주택 공공분양' })]);
  const h = harness({ store, world });
  assert.equal(await go(h), 0);
  assert.deepEqual(store.state.archived, []);
  assert.ok(store.state.upserts.includes('LH-e1'));
  assert.ok(count(h, 'duplicate_skipped') === 0 && count(h, 'duplicate_pairs_examined') === 0, summary(h));
});

test('a failed archive of a duplicate loser does not block the alerts and is reported by kind only', async () => {
  const store = fakeStore([stored('31-1'), stored('LH-d1', { source: 'LH', typeLabel: '분양주택 공공분양' })], { archiveFails: ['id-LH-d1'] });
  const h = harness({ store, world: dupWorld() });
  assert.equal(await go(h), 1);
  assert.equal(h.kakao.length, 1);
  assert.deepEqual(store.state.stamps, [{ id: 'page-7-7', date: THU }]);
  assert.equal(count(h, 'duplicate_archived'), 0);
  const mail = errorMail(h);
  assert.ok(mail.text.includes('duplicate_archive_failed x1'), mail.text);
  assert.ok(!mail.text.includes('secret-body') && !mail.text.includes('id-LH-d1') && !mail.text.includes('가나지구'));
});

test('dry-run archives nothing, logs the candidate counts and still skips the loser', async () => {
  const store = fakeStore([stored('31-1'), stored('LH-d1', { source: 'LH', typeLabel: '분양주택 공공분양' })]);
  const h = harness({ store, world: dupWorld(), argv: ['--dry-run'] });
  assert.equal(await go(h), 0);
  assert.deepEqual(store.state.archived, []);
  assert.deepEqual(store.state.upserts, []);
  assert.equal(h.kakao.length, 0);
  assert.ok(h.logs.includes('dry-run urbty_archive_candidates=0 region_scope_archive_candidates=0 duplicate_archive_candidates=1 duplicate_pairs_examined=1'), h.logs.join('|'));
  assert.ok(count(h, 'duplicate_skipped') === 1 && count(h, 'duplicate_archived') === 0);

  // Notion을 읽지 못한 dry-run은 후보를 알 수 없어 건수를 남기지 않는다.
  const unreadable = fakeStore();
  unreadable.loadExisting = async () => { throw new Error('down'); };
  const blind = harness({ store: unreadable, world: dupWorld(), argv: ['--dry-run'] });
  await go(blind);
  assert.ok(!blind.logs.some((line) => line.includes('archive_candidates=') && line.startsWith('dry-run urbty')), blind.logs.join('|'));
});

test('distinct notices of the same complex stay separate in a run', async () => {
  const store = fakeStore();
  const world = {
    remainders: [remainder(41, '다라지구 단지(A17BL) 공공분양주택')],
    lhRows: [lhRow('d2', '다라지구 단지[A17BL] 지분적립형 분양주택')],
  };
  const h = harness({ store, world });
  assert.equal(await go(h), 0);
  assert.deepEqual([...store.state.upserts].sort(), ['41-1', 'LH-d2']);
  assert.equal(count(h, 'duplicate_skipped'), 0);
});

test('a removed duplicate never reaches the alerts, the weekly mail or the urgent list', async () => {
  // 월요일 주간 메일이 나가는 실행에서 진 공고가 메일에 없고 승자는 있다.
  const store = fakeStore();
  store.getWeeklyState = async () => null;
  const h = harness({ store, world: { remainders: [remainder(31, DUP_NAME, { start: '2026-11-03', end: '2026-11-04' })], lhRows: [lhRow('d1', DUP_NAME_LH)] } });
  h.deps.now = () => new Date('2026-11-01T22:30:00Z');
  assert.equal(await go(h), 0);
  const weekly = h.mails.find((mail) => mail.subject.includes('주간') || mail.subject.includes('청약'));
  assert.ok(weekly);
  assert.equal((weekly.html.match(/신혼희망타운\(공공분양\)/g) ?? []).length, 1);
  assert.ok(!weekly.html.includes('신혼희망타운[공공분양]'));
});

// ---------- 지역 범위 ----------

const regionWorld = () => ({
  remainders: [
    alertRow,
    remainder(51, '부산 무순위 단지', { region: '부산' }),
    remainder(52, '세종 무순위 단지', { region: '세종' }),
    remainder(53, '주소 없는 무순위 단지', { region: '' }),
    remainder(54, '대전 관심 단지', { region: '대전' }),
  ],
  apts: [aptRowOf(55, '제주 토지임대부 단지', '제주')],
});
const regionStored = () => [
  stored('51-1', { region: '부산' }),
  stored('52-1', { region: '세종' }),
  stored('53-1', { region: null }),
  stored('54-1', { region: '대전', interest: true }),
  stored('55-1', { region: '제주', typeLabel: 'APT' }),
  stored('old-jeonbuk', { region: '전북' }),
];

test('out-of-region notices are skipped and their rows trashed; 세종, unknown regions and 관심 rows stay', async () => {
  const store = fakeStore(regionStored());
  const h = harness({ store, world: regionWorld() });
  assert.equal(await go(h), 0);
  assert.deepEqual([...store.state.archived].sort(), ['id-55-1', 'id-51-1', 'id-old-jeonbuk'].sort());
  for (const key of ['7-7', '52-1', '53-1', '54-1']) assert.ok(store.state.upserts.includes(key), key);
  for (const key of ['51-1', '55-1']) assert.ok(!store.state.upserts.includes(key), key);
  assert.ok(count(h, 'region_scope_skipped') === 2 && count(h, 'region_scope_archived') === 3 && count(h, 'region_scope_kept_interest') === 1, summary(h));
  assert.equal(h.kakao.length, 1);
  assert.ok(store.state.events.indexOf('kakao') < store.state.events.findIndex((event) => event.startsWith('archive')));
  assert.ok(!h.logs.join('\n').includes('부산 무순위'));
  assert.equal(errorMail(h), undefined);
});

test('dry-run counts region candidates without any archive', async () => {
  const store = fakeStore(regionStored());
  const h = harness({ store, world: regionWorld(), argv: ['--dry-run'] });
  assert.equal(await go(h), 0);
  assert.deepEqual(store.state.archived, []);
  assert.ok(h.logs.includes('dry-run urbty_archive_candidates=0 region_scope_archive_candidates=3 duplicate_archive_candidates=0 duplicate_pairs_examined=0'), h.logs.join('|'));
});

test('a failed region archive reaches the error mail by kind and the rest are still moved', async () => {
  const store = fakeStore(regionStored(), { archiveFails: ['id-51-1'] });
  const h = harness({ store, world: regionWorld() });
  assert.equal(await go(h), 1);
  assert.equal(h.kakao.length, 1);
  assert.deepEqual([...store.state.archived].sort(), ['id-55-1', 'id-old-jeonbuk'].sort());
  assert.equal(count(h, 'region_scope_archived'), 2);
  assert.ok(errorMail(h).text.includes('region_scope_archive_failed x1'));
});

test('with tableRegions missing, not an array or empty nothing is skipped for the region', async () => {
  for (const tableRegions of [undefined, '서울', { 0: '서울' }, []]) {
    const store = fakeStore(regionStored());
    const h = harness({ store, world: regionWorld(), config: { ...fileConfig, tableRegions } });
    assert.equal(await go(h), 0, JSON.stringify(tableRegions));
    assert.deepEqual(store.state.archived, [], JSON.stringify(tableRegions));
    assert.ok(count(h, 'region_scope_skipped') === 0 && count(h, 'region_scope_archived') === 0, JSON.stringify(tableRegions));
    for (const key of ['51-1', '55-1']) assert.ok(store.state.upserts.includes(key), key);
  }
});

test('a notice outside the scope is dropped once: not counted again by the unapplicable path or the LH scope', async () => {
  const world = {
    remainders: [],
    apts: [aptRowOf(61, '부산 일반 단지', '부산'), aptRowOf(62, '제주 토지임대부 단지', '제주')],
    lhRows: [lhRow('b1', '부산 LH 공공분양', '부산광역시')],
  };
  const store = fakeStore([stored('61-1', { region: '부산', typeLabel: 'APT' }), stored('62-1', { region: '제주', typeLabel: 'APT' }), stored('LH-b1', { region: '부산', source: 'LH', typeLabel: '분양주택 공공분양' })]);
  const h = harness({ store, world, env: { CHUNGYAK_PROFILE: PROFILE_JSON } });
  assert.equal(await go(h), 0);
  // 프로필 기준(수도권 거주)이라면 부산 APT는 신청할 수 없는 공고지만, 그 전에 지역 범위에서 빠져 한 번만 센다.
  assert.ok(count(h, 'unapplicable_skipped') === 0 && count(h, 'unapplicable_region') === 0 && count(h, 'unapplicable_archived') === 0, summary(h));
  // LH 부산 공고는 LH 범위 규칙이 먼저 다루고 표 지역 범위는 다시 세지 않는다.
  assert.ok(count(h, 'lh_out_of_scope_skipped') === 1 && count(h, 'lh_out_of_scope_area') === 1 && count(h, 'lh_out_of_scope_archived') === 1, summary(h));
  assert.ok(count(h, 'region_scope_skipped') === 2 && count(h, 'region_scope_archived') === 2, summary(h));
  // 세 행 모두 한 번씩만 옮긴다.
  assert.deepEqual([...store.state.archived].sort(), ['id-61-1', 'id-62-1', 'id-LH-b1']);
  assert.deepEqual(store.state.upserts, []);
});

test('an LH 관심 row outside the LH scope is counted by the LH scope only', async () => {
  const world = { remainders: [], lhRows: [lhRow('b2', '부산 LH 공공분양', '부산광역시')] };
  const store = fakeStore([stored('LH-b2', { region: '부산', source: 'LH', typeLabel: '분양주택 공공분양', interest: true })]);
  const h = harness({ store, world });
  assert.equal(await go(h), 0);
  assert.ok(count(h, 'lh_out_of_scope_kept_interest') === 1 && count(h, 'region_scope_kept_interest') === 0 && count(h, 'region_scope_skipped') === 0, summary(h));
  assert.deepEqual(store.state.archived, []);
});

// ---------- 오피스텔·도시형·생활숙박시설 ----------

const urbtyWorld = () => ({
  remainders: [alertRow],
  urbties: [urbtyRow(71, '가나 오피스텔'), urbtyRow(72, '다라 오피스텔', '서울'), urbtyRow(73, '부산 오피스텔', '부산')],
});
const urbtyStored = () => [
  stored('71-1', { typeLabel: '오피스텔' }),
  stored('72-1', { typeLabel: '오피스텔', interest: true }),
  stored('73-1', { typeLabel: '오피스텔', region: '부산' }),
  stored('old-urbty', { typeLabel: '도시형생활주택' }),
  stored('old-stay', { typeLabel: '생활숙박시설', interest: true }),
];

test('urbty notices are skipped and their rows trashed after the alerts; 관심 rows stay', async () => {
  const store = fakeStore(urbtyStored());
  const h = harness({ store, world: urbtyWorld() });
  assert.equal(await go(h), 0);
  assert.deepEqual([...store.state.archived].sort(), ['id-71-1', 'id-73-1', 'id-old-urbty'].sort());
  assert.ok(!store.state.upserts.includes('71-1') && !store.state.upserts.includes('73-1'));
  // 관심을 체크한 행의 공고는 보통 공고처럼 갱신한다.
  assert.ok(store.state.upserts.includes('72-1'));
  // 부산 오피스텔은 오피스텔 정리 하나로만 세고 옮긴다(지역 정리에서 다시 세지 않는다).
  assert.ok(count(h, 'urbty_skipped') === 2 && count(h, 'urbty_archived') === 3 && count(h, 'urbty_kept_interest') === 2, summary(h));
  assert.ok(count(h, 'region_scope_skipped') === 0 && count(h, 'region_scope_archived') === 0 && count(h, 'region_scope_kept_interest') === 0, summary(h));
  assert.equal(h.kakao.length, 1);
  assert.ok(store.state.events.indexOf('kakao') < store.state.events.findIndex((event) => event.startsWith('archive')));
  assert.equal(new Set(store.state.archived).size, store.state.archived.length);
});

test('dry-run counts urbty candidates without any archive', async () => {
  const store = fakeStore(urbtyStored());
  const h = harness({ store, world: urbtyWorld(), argv: ['--dry-run'] });
  assert.equal(await go(h), 0);
  assert.deepEqual(store.state.archived, []);
  assert.ok(h.logs.includes('dry-run urbty_archive_candidates=3 region_scope_archive_candidates=0 duplicate_archive_candidates=0 duplicate_pairs_examined=0'), h.logs.join('|'));
});

test('with excludeUrbty off or missing urbty notices are stored as before and nothing is archived', async () => {
  for (const config of [{ ...fileConfig, excludeUrbty: false }, { ...fileConfig, excludeUrbty: undefined }]) {
    const store = fakeStore(urbtyStored());
    // 부산 오피스텔은 지역 정리 대상이라 지역 범위도 꺼서 오피스텔 규칙만 본다.
    const h = harness({ store, world: urbtyWorld(), config: { ...config, tableRegions: undefined } });
    assert.equal(await go(h), 0);
    assert.deepEqual(store.state.archived, []);
    for (const key of ['71-1', '72-1', '73-1']) assert.ok(store.state.upserts.includes(key), key);
    assert.ok(count(h, 'urbty_skipped') === 0 && count(h, 'urbty_archived') === 0 && count(h, 'urbty_kept_interest') === 0);
  }
});

test('a stored row that is both a rental and out of scope is trashed once', async () => {
  const store = fakeStore([stored('old-rent', { typeLabel: '공공지원민간임대', region: '부산' }), stored('old-urbty-busan', { typeLabel: '오피스텔', region: '부산' })]);
  const h = harness({ store, world: { remainders: [alertRow] } });
  assert.equal(await go(h), 0);
  assert.deepEqual([...store.state.archived].sort(), ['id-old-rent', 'id-old-urbty-busan']);
  assert.ok(count(h, 'rental_archived') === 1 && count(h, 'urbty_archived') === 1 && count(h, 'region_scope_archived') === 0, summary(h));
});

// ---------- 설정 검사와 한 번에 옮기는 행의 상한 ----------

const errorsLine = (h) => h.logs.find((line) => line.startsWith('errors='));

test('a tableRegions entry that is not a 시도 turns the region scope off for the run and is reported by kind', async () => {
  const store = fakeStore(regionStored());
  const h = harness({ store, world: regionWorld(), config: { ...loose, tableRegions: ['서울', '경기', '인천', '세종시'] } });
  assert.equal(await go(h), 0);
  assert.deepEqual(store.state.archived, []);
  assert.ok(count(h, 'region_scope_skipped') === 0 && count(h, 'region_scope_archived') === 0, summary(h));
  for (const key of ['51-1', '55-1']) assert.ok(store.state.upserts.includes(key), key);
  assert.ok(errorsLine(h).includes('table_scope_config_invalid:1'), errorsLine(h));
  assert.ok(errorMail(h).text.includes('table_scope_config_invalid x1'));
  assert.equal(h.kakao.length, 1);
});

test('more rows to trash than cleanupMaxRows block every cleanup: nothing is archived, notices stay, alerts still go out', async () => {
  const store = fakeStore([...regionStored(), ...urbtyStored()]);
  const h = harness({ store, world: { ...regionWorld(), urbties: urbtyWorld().urbties }, config: { ...loose, cleanupMaxRows: 4 } });
  assert.equal(await go(h), 0);
  assert.deepEqual(store.state.archived, []);
  // 공고도 빼지 않아 저장된 행과 어긋나지 않는다.
  for (const key of ['51-1', '55-1', '71-1', '73-1']) assert.ok(store.state.upserts.includes(key), key);
  for (const name of ['region_scope_skipped', 'urbty_skipped', 'region_scope_archived', 'urbty_archived', 'duplicate_skipped']) assert.equal(count(h, name), 0, name);
  assert.equal(h.kakao.length, 1);
  assert.ok(errorsLine(h).includes('table_cleanup_blocked:1'), errorsLine(h));
  assert.ok(errorMail(h).text.includes('table_cleanup_blocked x1'));
  assert.ok(!h.logs.join('\n').includes('부산 무순위'));
});

test('the share of stored rows blocks too, and 관심 rows are not counted', async () => {
  // 후보 3행 / 저장 6행 = 0.5. 상한 0.4면 막고, 0.5면 지나간다.
  const blocked = harness({ store: fakeStore(regionStored()), world: regionWorld(), config: { ...loose, cleanupMaxShare: 0.4 } });
  assert.equal(await go(blocked), 0);
  assert.deepEqual(blocked.store.state.archived, []);
  assert.ok(errorsLine(blocked).includes('table_cleanup_blocked:1'));
  const passed = harness({ store: fakeStore(regionStored()), world: regionWorld(), config: { ...loose, cleanupMaxShare: 0.5 } });
  assert.equal(await go(passed), 0);
  assert.equal(passed.store.state.archived.length, 3);
  // 관심 행(54-1)은 세지 않으므로 상한이 후보 3행과 같으면 지나간다.
  const exact = harness({ store: fakeStore(regionStored()), world: regionWorld(), config: { ...loose, cleanupMaxRows: 3 } });
  assert.equal(await go(exact), 0);
  assert.equal(exact.store.state.archived.length, 3);
  assert.equal(errorsLine(exact), 'errors=none');
});

test('a count under the caps passes: the expected first run (about 12 of 45 rows) is archived with the default limits', async () => {
  const filler = Array.from({ length: 33 }, (_, i) => stored('keep-' + i, { start: '2026-12-10', end: '2026-12-20' }));
  const stale = Array.from({ length: 12 }, (_, i) => stored('gone-' + i, { region: '대전' }));
  const store = fakeStore([...filler, ...stale]);
  const h = harness({ store, world: { remainders: [alertRow] }, config: fileConfig });
  assert.equal(await go(h), 0);
  assert.equal(store.state.archived.length, 12);
  assert.equal(count(h, 'region_scope_archived'), 12);
  assert.equal(errorsLine(h), 'errors=none');
});

test('dry-run is never blocked: it logs the candidates and whether a normal run would be blocked', async () => {
  const store = fakeStore(regionStored());
  const h = harness({ store, world: regionWorld(), argv: ['--dry-run'], config: { ...loose, cleanupMaxRows: 2 } });
  assert.equal(await go(h), 0);
  assert.deepEqual(store.state.archived, []);
  assert.ok(h.logs.includes('dry-run urbty_archive_candidates=0 region_scope_archive_candidates=3 duplicate_archive_candidates=0 duplicate_pairs_examined=0'), h.logs.join('|'));
  assert.ok(h.logs.includes('dry-run cleanup_candidates=3 stored_rows=6 max_rows=2 max_share=1 would_block=true'), h.logs.join('|'));
  assert.equal(errorsLine(h), 'errors=none');
  assert.equal(count(h, 'region_scope_skipped'), 2);
  const ok = harness({ store: fakeStore(regionStored()), world: regionWorld(), argv: ['--dry-run'], config: loose });
  await go(ok);
  assert.ok(ok.logs.some((line) => line.startsWith('dry-run cleanup_candidates=3 ') && line.endsWith('would_block=false')), ok.logs.join('|'));
});
