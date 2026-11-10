import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  MAX_VALUE_SKIP_RATIO, NOTICE_LOOKBACK_DAYS, buildMap, checkSeoulValues, markAnnounced, parseArgs, run, summaryLines,
} from '../src/pipeline/build-map.js';
import { SEOUL_STAGES, DATASET_URL, DOWNLOAD_URL } from '../src/pipeline/seoul-redevelop.js';
import { TOWN_STAGES } from '../src/pipeline/newtowns.js';
import { DATA_ROWS, LISTING_HTML, UNKNOWN_STAGE_ROW, seoulFixture } from './map-fixtures.js';

const today = '2026-11-10';
const noSleep = async () => {};
const dir = mkdtempSync(join(tmpdir(), 'chungyak-map-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const seoulFile = join(dir, 'seoul.xlsx');
writeFileSync(seoulFile, seoulFixture());
const townsFile = join(dir, 'newtowns.yaml');
writeFileSync(townsFile, `
asOf: "2026-11-01"
towns:
  - id: hanam-gyosan
    name: 하남교산
    region: 경기
    district: 하남
    kind: 공공주택지구
    stage: 지구계획승인
    stageDates:
      지구계획승인: "2021-08"
    households: 33000
    noticeMatch: [교산]
    expected:
      from: "2027-06"
      to: "2029-06"
      basis: 보도된 계획
    sources:
      - title: 기사
        url: https://example.com/a
`);

// 청약홈 APT 상세만 공고 두 건을 돌려준다(신영1, 하남교산). 나머지 유형은 비어 있다.
function applyhomeFetch(calls = []) {
  return async (url) => {
    calls.push(url);
    const op = new URL(url).pathname.split('/').at(-1);
    if (op !== 'getAPTLttotPblancDetail') return Response.json({ totalCount: 0, data: [] });
    return Response.json({
      totalCount: 3,
      data: [
        // 접수가 끝난 서울 공고 (반포미도2차) -> announced
        {
          HOUSE_MANAGE_NO: '2026000005', PBLANC_NO: '2026000005', HOUSE_SECD: '01', HOUSE_NM: '반포 미도 재건축',
          SUBSCRPT_AREA_CODE_NM: '서울', HSSPLY_ADRES: '서울특별시 서초구 반포동 60-4',
          RCRIT_PBLANC_DE: '2026-05-04', PBLANC_URL: 'https://www.applyhome.co.kr/y',
          GNRL_RNK1_CRSPAREA_RCPTDE: '2026-05-20', GNRL_RNK1_CRSPAREA_ENDDE: '2026-05-21',
        },
        {
          HOUSE_MANAGE_NO: '2026000001', PBLANC_NO: '2026000001', HOUSE_SECD: '01', HOUSE_NM: '신영 센트럴',
          SUBSCRPT_AREA_CODE_NM: '서울', HSSPLY_ADRES: '서울특별시 종로구 신영동 158-2번지 일원',
          RCRIT_PBLANC_DE: '2026-11-01', PBLANC_URL: 'https://www.applyhome.co.kr/x',
          GNRL_RNK1_CRSPAREA_RCPTDE: '2026-11-20', GNRL_RNK1_CRSPAREA_ENDDE: '2026-11-20',
        },
        {
          HOUSE_MANAGE_NO: '2025000009', PBLANC_NO: '2025000009', HOUSE_SECD: '01', HOUSE_NM: '교산 A2블록',
          SUBSCRPT_AREA_CODE_NM: '경기', HSSPLY_ADRES: '경기도 하남시 천현동 일원',
          RCRIT_PBLANC_DE: '2026-03-31', PBLANC_URL: 'javascript:alert(1)',
          GNRL_RNK1_CRSPAREA_RCPTDE: '2026-04-20', GNRL_RNK1_CRSPAREA_ENDDE: '2026-04-21',
        },
      ],
    });
  };
}

test('buildMap from a local Seoul file links notices and computes windows', async () => {
  const calls = [];
  const data = await buildMap({
    fetch: applyhomeFetch(calls),
    env: { DATA_GO_KR_KEY: 'k' },
    today,
    seoulFile,
    newtownsFile: townsFile,
    sleep: noSleep,
  });
  assert.ok(calls.every((url) => url.startsWith('https://api.odcloud.kr/')));
  assert.equal(data.generatedAt, today);
  assert.deepEqual(data.sources.seoul, {
    asOf: '2026-06', title: '서울시 정비사업 추진현황 (26년 6월기준)', url: DATASET_URL, count: 4, skipped: {},
  });
  assert.deepEqual(data.sources.newtowns, { asOf: '2026-11-01', count: 1, skipped: null });
  assert.deepEqual(data.sources.notices, { linked: 3, checked: 3, skipped: null, errors: [] });
  assert.deepEqual(data.stages, { seoul: SEOUL_STAGES, town: TOWN_STAGES });
  assert.equal(data.projects.length, 5);

  const sinyoung = data.projects.find((p) => p.id === 'seoul-1441');
  assert.equal(sinyoung.live, true);
  assert.equal(sinyoung.bucket, 'live');
  assert.deepEqual(sinyoung.notices, [{
    key: '2026000001-2026000001', name: '신영 센트럴', announceDate: '2026-11-01', end: '2026-11-20',
    url: 'https://www.applyhome.co.kr/x', typeLabel: 'APT',
  }]);
  assert.deepEqual(sinyoung.window, { from: '2026-04', to: '2027-04' });

  const gyosan = data.projects.find((p) => p.id === 'town-hanam-gyosan');
  assert.equal(gyosan.live, false);
  // 공공주택지구는 지난 블록 공고가 있어도 보도된 기간을 그대로 쓴다(공고 목록에는 남김)
  assert.deepEqual(gyosan.notices.map((n) => [n.key, n.announceDate, n.end]), [['2025000009-2025000009', '2026-03-31', '2026-04-21']]);
  assert.equal(gyosan.notices[0].url, null);
  assert.deepEqual(gyosan.window, { from: '2027-06', to: '2029-06' });
  assert.equal(gyosan.windowStatus, 'estimated');
  assert.equal(gyosan.windowBasis, '알려진 계획: 보도된 계획');
  assert.equal(gyosan.bucket, 'soon');
  assert.equal('noticeMatch' in gyosan, false);
  assert.equal('expected' in gyosan, false);

  // 서울 사업에 접수가 끝난 공고만 이어지면 기간은 두고 announced
  const banpo = data.projects.find((p) => p.id === 'seoul-2002');
  assert.equal(banpo.live, false);
  assert.deepEqual(banpo.notices.map((n) => n.key), ['2026000005-2026000005']);
  assert.deepEqual(banpo.window, { from: '2027-07', to: '2029-01' });
  assert.equal(banpo.windowStatus, 'announced');
  assert.equal(banpo.windowBasis, '청약홈 공고가 이미 있었습니다(2026-05-04)');
  assert.equal(banpo.bucket, 'announced');

  const susong = data.projects.find((p) => p.id === 'seoul-1460');
  assert.equal(susong.window, null);
  assert.equal(susong.windowStatus, 'far');
  assert.equal(susong.bucket, 'far');

  assert.deepEqual(summaryLines(data).slice(0, 2), [
    'map seoul=4 skipped=0 asOf=2026-06 towns=1 notices checked=3 linked=3',
    'map buckets live=1 soon=2 mid=0 far=1 announced=1 overdue=0 likely_sold=0 done=0',
  ]);
});

test('buildMap downloads the latest Seoul file and skips notices without a key', async () => {
  const requested = [];
  const fetch = async (url, init = {}) => {
    requested.push(`${init.method ?? 'GET'} ${url}`);
    if (url === DATASET_URL) return new Response(LISTING_HTML);
    if (url === DOWNLOAD_URL) return new Response(seoulFixture());
    throw new Error('unexpected request');
  };
  const data = await buildMap({ fetch, env: {}, today, newtownsFile: join(dir, 'missing.yaml'), sleep: noSleep });
  assert.deepEqual(requested, [`GET ${DATASET_URL}`, `POST ${DOWNLOAD_URL}`]);
  assert.equal(data.sources.seoul.count, 4);
  assert.deepEqual(data.sources.newtowns, { asOf: null, count: 0, skipped: 'newtowns_missing' });
  assert.deepEqual(data.sources.notices, { linked: 0, checked: 0, skipped: 'no_key', errors: [] });
  assert.equal(summaryLines(data)[0], 'map seoul=4 skipped=0 asOf=2026-06 towns=0 notices skipped=no_key');
});

test('a notice failure is not fatal', async () => {
  const fetch = async () => new Response('', { status: 401 });
  const data = await buildMap({ fetch, env: { DATA_GO_KR_KEY: 'k' }, today, seoulFile, newtownsFile: townsFile, sleep: noSleep });
  assert.equal(data.sources.notices.skipped, 'applyhome_http_401');
  assert.equal(data.projects.length, 5);
  assert.ok(data.projects.every((p) => p.live === false));
});

test('run writes the file and logs counts only', async () => {
  const out = join(dir, 'site', 'projects.json');
  const lines = [];
  const code = await run({
    argv: ['--out', out, '--seoul-file', seoulFile, '--newtowns', townsFile],
    env: {},
    today,
    log: (line) => lines.push(line),
  });
  assert.equal(code, 0);
  assert.equal(lines[0], 'map seoul=4 skipped=0 asOf=2026-06 towns=1 notices skipped=no_key');
  const written = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(written.projects.length, 5);
  assert.ok(lines.every((line) => !line.includes('http')));
});

test('run exits non-zero when the Seoul source fails', async () => {
  const lines = [];
  const code = await run({
    argv: ['--out', join(dir, 'fail.json')],
    env: {},
    today,
    fetch: async () => new Response('', { status: 404 }),
    log: (line) => lines.push(line),
  });
  assert.equal(code, 1);
  assert.deepEqual(lines, ['map failed=seoul_http_404']);
});

test('invalid newtowns.yaml fails the build', async () => {
  const bad = join(dir, 'bad.yaml');
  writeFileSync(bad, 'towns:\n  - id: a\n    name: x\n    stage: 착공\n');
  const lines = [];
  const code = await run({ argv: ['--out', join(dir, 'bad.json'), '--seoul-file', seoulFile, '--newtowns', bad], env: {}, today, log: (l) => lines.push(l) });
  assert.equal(code, 1);
  assert.deepEqual(lines, ['map failed=newtowns_stage']);
});

test('argument parsing', () => {
  assert.equal(parseArgs([]).out, 'site/projects.json');
  assert.equal(parseArgs(['--seoul-file', 'a.xlsx']).seoulFile, 'a.xlsx');
  assert.throws(() => parseArgs(['--out']), { kind: 'map_args' });
  assert.throws(() => parseArgs(['--what']), { kind: 'map_args' });
});

test('skipped Seoul rows are reported, and too many unknown values fail the build', async () => {
  // 행 5개 중 1개(20%)가 모르는 단계
  const drift = join(dir, 'drift.xlsx');
  writeFileSync(drift, seoulFixture(UNKNOWN_STAGE_ROW));
  await assert.rejects(buildMap({ env: {}, today, seoulFile: drift, newtownsFile: townsFile }), { kind: 'seoul_values' });
  const lines = [];
  const code = await run({ argv: ['--out', join(dir, 'drift.json'), '--seoul-file', drift, '--newtowns', townsFile], env: {}, today, log: (l) => lines.push(l) });
  assert.equal(code, 1);
  assert.deepEqual(lines, ['map failed=seoul_values']);

  // 대부분이 모르는 단계 값(원자료 값이 바뀐 경우)
  const unknown = {};
  for (let i = 0; i < 12; i += 1) unknown[20 + i] = { A: 5000 + i, C: '마포구', D: `새구역${i}`, I: '주택정비형 재개발', J: '정비계획수립' };
  const mostly = join(dir, 'mostly.xlsx');
  writeFileSync(mostly, seoulFixture(unknown));
  await assert.rejects(buildMap({ env: {}, today, seoulFile: mostly, newtownsFile: townsFile }), { kind: 'seoul_values' });

  // 5% 이하면 계속하고 건너뛴 수를 남긴다: 행 21개 중 모르는 단계 1개
  const filler = {};
  for (let i = 0; i < 16; i += 1) filler[40 + i] = { ...DATA_ROWS[8], A: 6000 + i };
  const fine = join(dir, 'fine.xlsx');
  writeFileSync(fine, seoulFixture({ ...UNKNOWN_STAGE_ROW, ...filler }));
  const data = await buildMap({ env: {}, today, seoulFile: fine, newtownsFile: townsFile });
  assert.deepEqual(data.sources.seoul.skipped, { stage: 1 });
  assert.equal(data.sources.seoul.count, 20);
  assert.equal(summaryLines(data)[0], 'map seoul=20 skipped=stage:1 asOf=2026-06 towns=1 notices skipped=no_key');
});

test('checkSeoulValues counts stage and kind skips against all data rows', () => {
  const projects = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i) }));
  assert.equal(MAX_VALUE_SKIP_RATIO, 0.05);
  assert.doesNotThrow(() => checkSeoulValues({ projects: projects(19), skipped: { stage: 1 } })); // 1/20 = 5%
  assert.throws(() => checkSeoulValues({ projects: projects(18), skipped: { stage: 1, kind: 1 } }), { kind: 'seoul_values' });
  assert.throws(() => checkSeoulValues({ projects: projects(9), skipped: { kind: 1 } }), { kind: 'seoul_values' });
  // 중복은 값 이상이 아니지만 행 수에는 들어간다
  assert.doesNotThrow(() => checkSeoulValues({ projects: projects(10), skipped: { duplicate: 9, stage: 1 } }));
  assert.doesNotThrow(() => checkSeoulValues({ projects: projects(3) }));
});

test('markAnnounced: a linked notice that already ended', () => {
  const base = { id: 'x', region: '서울', stage: '착공', window: { from: '2026-04', to: '2027-04' }, windowStatus: 'estimated', windowBasis: '착공 뒤', live: false };
  const ended = [{ key: 'b', announceDate: '2026-03-02' }, { key: 'a', announceDate: '2026-05-10' }];
  const marked = markAnnounced({ ...base, notices: ended });
  assert.equal(marked.windowStatus, 'announced');
  assert.equal(marked.windowBasis, '청약홈 공고가 이미 있었습니다(2026-05-10)');
  assert.deepEqual(marked.window, base.window);
  assert.equal(markAnnounced({ ...base, window: null, notices: [{ key: 'c', announceDate: null }] }).windowBasis, '청약홈 공고가 이미 있었습니다');
  // 공공주택지구(서울 밖), 접수 중(live), 공고 없음, 준공은 그대로
  const town = { ...base, region: '경기', kind: '공공주택지구', stage: '블록별 분양', notices: ended };
  assert.equal(markAnnounced(town), town);
  const live = { ...base, live: true, notices: ended };
  assert.equal(markAnnounced(live), live);
  const none = { ...base, notices: [] };
  assert.equal(markAnnounced(none), none);
  const done = { ...base, windowStatus: 'done', notices: ended };
  assert.equal(markAnnounced(done), done);
});

test('markAnnounced: before 이주, only a notice on or after the current stage date counts', () => {
  const base = {
    id: 'y', region: '서울', stage: '관리처분인가', stageDates: { 관리처분인가: '2026-01-15' },
    window: { from: '2027-07', to: '2029-01' }, windowStatus: 'estimated', windowBasis: '관리처분인가 뒤', live: false,
  };
  // 단계 날짜보다 이른 공고(같은 지번의 예전 사업 등)는 목록에만 남기고 기간·상태는 그대로
  const old = { ...base, notices: [{ key: 'o', announceDate: '2024-05-02' }, { key: 'p', announceDate: '2026-01-14' }] };
  assert.equal(markAnnounced(old), old);
  // 단계 날짜와 같거나 뒤면 announced
  const marked = markAnnounced({ ...base, notices: [{ key: 'o', announceDate: '2024-05-02' }, { key: 'n', announceDate: '2026-01-15' }] });
  assert.equal(marked.windowStatus, 'announced');
  assert.equal(marked.windowBasis, '청약홈 공고가 이미 있었습니다(2026-01-15)');
  // 단계 날짜가 달까지만 있으면 같은 달부터
  assert.equal(markAnnounced({ ...base, stageDates: { 관리처분인가: '2026-01' }, notices: [{ key: 'n', announceDate: '2026-01-03' }] }).windowStatus, 'announced');
  // 단계 날짜를 모르거나 공고일이 없으면 판단하지 않는다
  const undated = { ...base, stageDates: {}, notices: [{ key: 'n', announceDate: '2026-05-01' }] };
  assert.equal(markAnnounced(undated), undated);
  const noDate = { ...base, notices: [{ key: 'n', announceDate: null }] };
  assert.equal(markAnnounced(noDate), noDate);
  // 이주·착공·일반분양은 날짜와 상관없이 announced
  for (const stage of ['이주', '착공', '일반분양']) {
    assert.equal(markAnnounced({ ...base, stage, stageDates: { [stage]: '2026-06-01' }, notices: old.notices }).windowStatus, 'announced', stage);
  }
});

test('notices are looked up for the last 3 years; an old notice before the Seoul stage date is not announced', async () => {
  assert.equal(NOTICE_LOOKBACK_DAYS, 1095);
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const op = new URL(url).pathname.split('/').at(-1);
    if (op !== 'getAPTLttotPblancDetail') return Response.json({ totalCount: 0, data: [] });
    return Response.json({
      totalCount: 2,
      data: [
        // 2년 반 전 서울 공고(반포미도2차): 1년 조회에는 빠졌던 공고
        {
          HOUSE_MANAGE_NO: '2024000003', PBLANC_NO: '2024000003', HOUSE_SECD: '01', HOUSE_NM: '반포 미도 재건축',
          SUBSCRPT_AREA_CODE_NM: '서울', HSSPLY_ADRES: '서울특별시 서초구 반포동 60-4',
          RCRIT_PBLANC_DE: '2024-05-02', PBLANC_URL: 'https://www.applyhome.co.kr/old',
          GNRL_RNK1_CRSPAREA_RCPTDE: '2024-05-20', GNRL_RNK1_CRSPAREA_ENDDE: '2024-05-21',
        },
        // 조회 시작일보다 앞선 공고는 서버가 걸러 주지 않아도 버린다
        {
          HOUSE_MANAGE_NO: '2023000001', PBLANC_NO: '2023000001', HOUSE_SECD: '01', HOUSE_NM: '신영 옛 공고',
          SUBSCRPT_AREA_CODE_NM: '서울', HSSPLY_ADRES: '서울특별시 종로구 신영동 158-2',
          RCRIT_PBLANC_DE: '2023-11-10', PBLANC_URL: 'https://www.applyhome.co.kr/older',
          GNRL_RNK1_CRSPAREA_RCPTDE: '2023-11-20', GNRL_RNK1_CRSPAREA_ENDDE: '2023-11-21',
        },
      ],
    });
  };
  const data = await buildMap({ fetch, env: { DATA_GO_KR_KEY: 'k' }, today, seoulFile, newtownsFile: townsFile, sleep: noSleep });
  const apt = calls.find((url) => url.includes('getAPTLttotPblancDetail'));
  assert.equal(new URL(apt).searchParams.get('cond[RCRIT_PBLANC_DE::GTE]'), '2023-11-11');
  // 반포미도2차는 관리처분인가(2026-01-01) 단계라 2024-05 공고는 이 사업의 공고로 보지 않는다(목록에는 남김)
  const banpo = data.projects.find((p) => p.id === 'seoul-2002');
  assert.equal(banpo.live, false);
  assert.deepEqual(banpo.notices.map((n) => [n.key, n.announceDate]), [['2024000003-2024000003', '2024-05-02']]);
  assert.equal(banpo.windowStatus, 'estimated');
  assert.deepEqual(banpo.window, { from: '2027-07', to: '2029-01' });
  assert.equal(banpo.windowBasis, '관리처분인가(2026-01) 뒤 1.5~3년');
  assert.equal(banpo.bucket, 'soon');
  const sinyoung = data.projects.find((p) => p.id === 'seoul-1441');
  assert.deepEqual(sinyoung.notices, []);
  assert.notEqual(sinyoung.windowStatus, 'announced');
});

test('블록별 분양 towns carry their history, label and plan window into projects.json, plans stay internal', async () => {
  const file = join(dir, 'blocks.yaml');
  writeFileSync(file, `
asOf: "2026-11-10"
towns:
  - id: hanam-gyosan
    name: 하남교산
    district: 하남
    stage: 블록별 분양
    stageDates:
      블록별 분양: "2025-03-31"
    noticeMatch: [교산]
    history:
      - { block: A2, stage: 사전청약, households: 1056, noticeDate: "2021-11-18", source: { url: "https://example.com/pre" } }
      - block: A2
        type: 공공분양
        title: 교산 푸르지오 더 퍼스트
        households: 1115
        noticeDate: "2025-03-31"
        moveIn: "2029-06"
        note: 메모
        source:
          - { title: "LH 공고", outlet: LH, url: "https://example.com/a2", date: "2025-03-31" }
          - { title: "나쁜 링크", url: "javascript:alert(1)" }
      - { block: A20, rental: true, households: 249, noticeDate: "2026-09-01", source: { url: "https://example.com/a20" } }
    plans:
      - { blocks: [A5], expected: "2027-09", source: { title: 일정표, outlet: 하남도시공사, url: "https://example.com/a5" } }
      - { blocks: [A9, A11], expected: "2026-하반기", source: { title: "기사 (하남Times)", url: "http://example.com/a9", date: "2025-12-13" } }
    blockTotal: { total: 39, approved: 16, date: "2025-11-24", source: { title: "기사 (시티뉴스)", url: "http://example.com/ct", date: "2025-11-24" } }
    blocks:
      - { block: S-1, status: 사업승인, statusDate: "2025-11-24", sources: { url: "https://example.com/s1" } }
  - id: guri-galmae-station
    name: 구리갈매역세권
    district: 구리
    stage: 블록별 분양
    noticeMatch: [갈매역세권]
    plans:
      - { blocks: [B2], rental: true, expected: "2029-하반기", source: { url: "https://example.com/b2" } }
  - id: other
    name: 다른지구
    district: 구리
    stage: 지구지정
    stageDates:
      지구지정: "2025-12-31"
`);
  const data = await buildMap({ fetch: async () => { throw new Error('no fetch'); }, env: {}, today, seoulFile, newtownsFile: file, sleep: noSleep });
  const byId = Object.fromEntries(data.projects.map((p) => [p.id, p]));
  const gyosan = byId['town-hanam-gyosan'];
  // 2026-하반기 계획이지만 이번 달(2026-11)부터 보여 주고, 보도뿐이라 '공고 미확인'을 붙인다. 날짜 없는 A5 계획은 쓰지 않는다
  assert.deepEqual(gyosan.window, { from: '2026-11', to: '2026-12' });
  assert.equal(gyosan.windowRule, 'town-plan');
  assert.equal(gyosan.windowLabel, '다음 블록 예상');
  assert.equal(gyosan.windowBasis, '보도된 다음 블록 계획: A9·A11 2026-하반기 (하남Times 2025-12-13). 공고 미확인');
  assert.equal(gyosan.bucket, 'soon');
  assert.deepEqual(gyosan.history[1], {
    block: 'A2', stage: '본청약', type: '공공분양', title: '교산 푸르지오 더 퍼스트', households: 1115, noticeDate: '2025-03-31', rental: false,
    sources: [{ title: 'LH 공고', url: 'https://example.com/a2', date: '2025-03-31', outlet: 'LH' }],
  });
  assert.deepEqual(gyosan.history.map((e) => [e.block, e.stage, e.rental]), [['A2', '사전청약', false], ['A2', '본청약', false], ['A20', '본청약', true]]);
  for (const key of ['plans', 'blockPlans', 'blockHistory', 'preSubscriptions', 'noticeMatch', 'expected', 'blockEntries']) {
    assert.equal(key in gyosan, false, key);
  }
  // 블록별 현황: 이력·계획만 있는 블록도 줄이 되고, 상태 순서대로 나온다
  assert.deepEqual(gyosan.blocks.map((b) => [b.block, b.rental, b.status, b.statusDate]), [
    ['A2', false, '분양 끝남', '2025-03-31'],
    ['A20', true, '임대 공고', '2026-09-01'],
    ['A5', false, '다음 예정(보도)', null],
    ['A9', false, '다음 예정(보도)', '2025-12-13'],
    ['A11', false, '다음 예정(보도)', '2025-12-13'],
    ['S-1', false, '사업승인', '2025-11-24'],
  ]);
  assert.deepEqual(gyosan.blocks[0], {
    block: 'A2', type: '공공분양', households: 1115, rental: false, status: '분양 끝남', statusDate: '2025-03-31',
    timeline: [{ stage: '사전청약', date: '2021-11-18' }, { stage: '본청약', date: '2025-03-31' }],
    plan: null,
    note: null,
    sources: [
      { title: 'https://example.com/pre', url: 'https://example.com/pre', date: null },
      { title: 'LH 공고', url: 'https://example.com/a2', date: '2025-03-31', outlet: 'LH' },
    ],
  });
  assert.deepEqual(gyosan.blockSummary, { '분양 끝남': 1, '임대 공고': 1, '다음 예정(보도)': 3, 사업승인: 1 });
  assert.deepEqual(gyosan.blockTotal, {
    total: 39, approved: 16, date: '2025-11-24', outlet: '시티뉴스',
    sources: [{ title: '기사 (시티뉴스)', url: 'http://example.com/ct', date: '2025-11-24' }],
  });
  const galmae = byId['town-guri-galmae-station'];
  assert.deepEqual(galmae.blocks.map((b) => [b.block, b.rental, b.status]), [['B2', true, '다음 예정(보도)']]);
  assert.equal(galmae.blockTotal, null);
  assert.equal('blocks' in byId['seoul-1441'], false);
  assert.deepEqual(galmae.window, { from: '2026-11', to: '2028-11' });
  assert.equal(galmae.windowBasis, '다음 블록 예상(규칙): 오늘부터 0~2년');
  assert.equal(galmae.windowLabel, '다음 블록 예상');
  assert.deepEqual(galmae.history, []);
  assert.equal(byId['town-other'].windowLabel, null);
  assert.deepEqual(byId['town-other'].history, []);
  assert.equal(byId['seoul-1441'].windowLabel, null);
  assert.equal('history' in byId['seoul-1441'], false);
});

test('a live notice on a 블록별 분양 town keeps it live and moves the rule window past the notice end', async () => {
  const file = join(dir, 'live-blocks.yaml');
  writeFileSync(file, `
asOf: "2026-11-10"
towns:
  - id: guri-galmae-station
    name: 구리갈매역세권
    region: 경기
    district: 구리
    stage: 블록별 분양
    stageDates:
      블록별 분양: "2025-07-29"
    noticeMatch: [갈매역세권]
    plans:
      - { blocks: [B2], rental: true, expected: "2029-하반기", source: { url: "https://example.com/b2" } }
  - id: hanam-gyosan
    name: 하남교산
    region: 경기
    district: 하남
    stage: 블록별 분양
    noticeMatch: [교산]
    plans:
      - { blocks: [A9], expected: "2027-상반기", source: { title: "기사 (하남Times)", url: "https://example.com/a9", date: "2025-12-13" } }
`);
  const fetch = async (url) => {
    const op = new URL(url).pathname.split('/').at(-1);
    if (op !== 'getAPTLttotPblancDetail') return Response.json({ totalCount: 0, data: [] });
    return Response.json({
      totalCount: 2,
      data: [
        {
          HOUSE_MANAGE_NO: '2026000472', PBLANC_NO: '2026000472', HOUSE_SECD: '01', HOUSE_NM: '구리갈매역세권 신안인스빌 디센트',
          SUBSCRPT_AREA_CODE_NM: '경기', HSSPLY_ADRES: '경기도 구리시 갈매동 일원',
          RCRIT_PBLANC_DE: '2026-10-30', PBLANC_URL: 'https://www.applyhome.co.kr/b1',
          GNRL_RNK1_CRSPAREA_RCPTDE: '2026-11-10', GNRL_RNK1_CRSPAREA_ENDDE: '2026-12-02',
        },
        {
          HOUSE_MANAGE_NO: '2026000500', PBLANC_NO: '2026000500', HOUSE_SECD: '01', HOUSE_NM: '하남교산 A-2BL 잔여',
          SUBSCRPT_AREA_CODE_NM: '경기', HSSPLY_ADRES: '경기도 하남시 천현동 일원',
          RCRIT_PBLANC_DE: '2026-11-01', PBLANC_URL: 'https://www.applyhome.co.kr/a2',
          GNRL_RNK1_CRSPAREA_RCPTDE: '2026-11-12', GNRL_RNK1_CRSPAREA_ENDDE: '2026-11-13',
        },
      ],
    });
  };
  const data = await buildMap({ fetch, env: { DATA_GO_KR_KEY: 'k' }, today, seoulFile, newtownsFile: file, sleep: noSleep });
  const galmae = data.projects.find((p) => p.id === 'town-guri-galmae-station');
  assert.equal(galmae.live, true);
  assert.equal(galmae.bucket, 'live');
  // 규칙 기간은 접수 중인 공고 마감(2026-12-02) 다음 달부터
  assert.deepEqual(galmae.window, { from: '2027-01', to: '2029-01' });
  assert.equal(galmae.windowBasis, '다음 블록 예상(규칙): 접수 중인 공고(마감 2026-12-02) 뒤 0~2년');
  assert.equal(galmae.windowStatus, 'estimated');
  assert.equal(galmae.windowLabel, '다음 블록 예상');
  // 보도된 블록 계획으로 잡은 기간은 그대로, 구간은 live
  const gyosan = data.projects.find((p) => p.id === 'town-hanam-gyosan');
  assert.equal(gyosan.bucket, 'live');
  assert.equal(gyosan.windowRule, 'town-plan');
  assert.deepEqual(gyosan.window, { from: '2027-01', to: '2027-06' });
});
