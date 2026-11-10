import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  MAX_VALUE_SKIP_RATIO, NOTICE_LOOKBACK_DAYS, buildMap, checkSeoulValues, markAnnounced, parseArgs, run, summaryLines,
} from '../src/pipeline/build-map.js';
import { SEOUL_STAGES, DATASET_URL, DOWNLOAD_URL } from '../src/pipeline/seoul-redevelop.js';
import { linkNotices } from '../src/pipeline/link-notices.js';
import {
  MAP_REBUILD_DAYS, NEWS_ENDPOINTS, NEWS_MAX_AGE_DAYS, NEWS_PUBLISH_DAYS,
} from '../src/pipeline/news.js';
import { TOWN_STAGES } from '../src/pipeline/newtowns.js';
import { AppError } from '../src/util.js';
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

test('linking then markAnnounced: early Seoul stages get nothing, 관리처분인가 needs a newer notice, 착공 is unchanged', () => {
  const project = (stage, stageDate) => ({
    id: `seoul-${stage}`, region: '서울', district: '성북구', name: '하월곡1', address: '하월곡동88-1', stage,
    stageDates: { [stage]: stageDate }, window: { from: '2028-01', to: '2030-12' },
    windowStatus: 'estimated', windowBasis: `${stage} 뒤`, notices: [], live: false,
  });
  const notices = [{
    key: 'wolgok', name: '브라운스톤 월곡 센트럴', region: '서울', address: '서울특별시 성북구 하월곡동 88-1',
    announceDate: '2026-03-02', overallEnd: '2026-03-20', url: 'https://www.applyhome.co.kr/notice/1',
  }];
  const pipeline = (input) => markAnnounced(linkNotices([input], notices, today).projects[0]);

  // 추진위: 같은 지번 공고가 맞아도 잇지 않고 기간·상태는 그대로
  const early = pipeline(project('추진위', '2024-05-01'));
  assert.deepEqual(early.notices, []);
  assert.equal(early.live, false);
  assert.equal(early.windowStatus, 'estimated');
  assert.equal(early.windowBasis, '추진위 뒤');

  // 관리처분인가: 단계 날짜 뒤의 공고는 잇고 announced
  const approved = pipeline(project('관리처분인가', '2025-09-01'));
  assert.deepEqual(approved.notices.map((notice) => notice.key), ['wolgok']);
  assert.equal(approved.windowStatus, 'announced');
  assert.equal(approved.windowBasis, '청약홈 공고가 이미 있었습니다(2026-03-02)');
  // 단계 날짜보다 이른 공고는 잇기만 하고 announced는 아니다
  const stale = pipeline(project('관리처분인가', '2026-06-01'));
  assert.equal(stale.notices.length, 1);
  assert.equal(stale.windowStatus, 'estimated');

  // 착공: 날짜와 상관없이 잇고 announced(전과 같음)
  const started = pipeline(project('착공', '2026-06-01'));
  assert.deepEqual(started.notices.map((notice) => notice.key), ['wolgok']);
  assert.equal(started.windowStatus, 'announced');
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
    block: 'A2', stage: '본청약', type: '공공분양', title: '교산 푸르지오 더 퍼스트', households: 1115, noticeDate: '2025-03-31', end: null, rental: false,
    sources: [{ title: 'LH 공고', url: 'https://example.com/a2', date: '2025-03-31', outlet: 'LH' }],
  });
  assert.deepEqual(gyosan.history.map((e) => [e.block, e.stage, e.rental]), [['A2', '사전청약', false], ['A2', '본청약', false], ['A20', '본청약', true]]);
  for (const key of ['plans', 'blockPlans', 'blockHistory', 'preSubscriptions', 'noticeMatch', 'expected', 'blockEntries']) {
    assert.equal(key in gyosan, false, key);
  }
  // 블록별 현황: 이력·계획만 있는 블록도 줄이 되고, 상태 순서대로 나온다
  assert.deepEqual(gyosan.blocks.map((b) => [b.block, b.rental, b.status, b.statusDate]), [
    ['A2', false, '본청약 공고', '2025-03-31'],
    ['A20', true, '임대 공고', '2026-09-01'],
    ['A5', false, '다음 예정(보도)', null],
    ['A9', false, '다음 예정(보도)', '2025-12-13'],
    ['A11', false, '다음 예정(보도)', '2025-12-13'],
    ['S-1', false, '사업승인', '2025-11-24'],
  ]);
  assert.deepEqual(gyosan.blocks[0], {
    block: 'A2', type: '공공분양', households: 1115, rental: false, status: '본청약 공고', statusDate: '2025-03-31',
    timeline: [{ stage: '사전청약', date: '2021-11-18' }, { stage: '본청약', date: '2025-03-31' }],
    plan: null,
    note: null,
    sources: [
      { title: 'https://example.com/pre', url: 'https://example.com/pre', date: null },
      { title: 'LH 공고', url: 'https://example.com/a2', date: '2025-03-31', outlet: 'LH' },
    ],
  });
  assert.deepEqual(gyosan.blockSummary, { '본청약 공고': 1, '임대 공고': 1, '다음 예정(보도)': 3, 사업승인: 1 });
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

test('a linked notice naming a planned block takes it out of the next-block window and fills its block row', async () => {
  const file = join(dir, 'notice-plan.yaml');
  writeFileSync(file, `
asOf: "2026-11-10"
towns:
  - id: hanam-gyosan
    name: 하남교산
    region: 경기
    district: 하남
    stage: 블록별 분양
    stageDates:
      블록별 분양: "2025-03-31"
    noticeMatch: [교산]
    history:
      - { block: A2, title: 교산 푸르지오 더 퍼스트, noticeDate: "2025-03-31", source: { url: "https://example.com/a2" } }
    plans:
      - { blocks: [A9, A11], expected: "2026-하반기", note: "지역지 보도만 있음", source: { title: "기사 (하남Times)", url: "http://example.com/a9", date: "2025-12-13" } }
  - id: guri-galmae-station
    name: 구리갈매역세권
    region: 경기
    district: 구리
    stage: 블록별 분양
    noticeMatch: [갈매역세권]
    history:
      - { block: B-1, title: 구리갈매역세권 신안인스빌 디센트, noticeDate: "2026-10-30", end: "2026-11-11", source: { url: "https://example.com/b1" } }
`);
  const fetch = async (url) => {
    const op = new URL(url).pathname.split('/').at(-1);
    if (op !== 'getAPTLttotPblancDetail') return Response.json({ totalCount: 0, data: [] });
    return Response.json({
      totalCount: 1,
      data: [{
        HOUSE_MANAGE_NO: '2026000600', PBLANC_NO: '2026000600', HOUSE_SECD: '01', HOUSE_NM: '하남교산 A9블록 공공분양',
        SUBSCRPT_AREA_CODE_NM: '경기', HSSPLY_ADRES: '경기도 하남시 천현동 일원',
        RCRIT_PBLANC_DE: '2026-11-03', PBLANC_URL: 'https://www.applyhome.co.kr/a9',
        GNRL_RNK1_CRSPAREA_RCPTDE: '2026-11-19', GNRL_RNK1_CRSPAREA_ENDDE: '2026-11-20',
      }],
    });
  };
  const data = await buildMap({ fetch, env: { DATA_GO_KR_KEY: 'k' }, today, seoulFile, newtownsFile: file, sleep: noSleep });
  const gyosan = data.projects.find((p) => p.id === 'town-hanam-gyosan');
  assert.equal(gyosan.bucket, 'live');
  // A9는 공고가 나서 근거에서 빠지고 A11만 남는다
  assert.equal(gyosan.windowRule, 'town-plan');
  assert.equal(gyosan.windowBasis, '보도된 다음 블록 계획: A11 2026-하반기 (하남Times 2025-12-13). 지역지 보도만 있음');
  assert.doesNotMatch(gyosan.windowBasis, /A9/);
  const rows = Object.fromEntries(gyosan.blocks.map((b) => [b.block, b]));
  assert.deepEqual([rows.A9.status, rows.A9.statusDate, rows.A9.plan], ['접수 중', '2026-11-20', null]);
  assert.deepEqual([rows.A11.status, rows.A11.plan.expected], ['다음 예정(보도)', '2026-하반기']);
  assert.deepEqual(gyosan.blockSummary, { '접수 중': 1, '본청약 공고': 1, '다음 예정(보도)': 1 });
  // 계획이 모두 지난 뒤(2027-02)에도 A9를 '공고는 아직 없습니다'에 넣지 않는다
  const later = await buildMap({ fetch, env: { DATA_GO_KR_KEY: 'k' }, today: '2027-02-01', seoulFile, newtownsFile: file, sleep: noSleep });
  const lateTown = later.projects.find((p) => p.id === 'town-hanam-gyosan');
  assert.equal(lateTown.windowRule, 'town-plan-late');
  assert.equal(lateTown.windowBasis, '보도된 일정(A11 2026-하반기)이 지났지만 공고는 아직 없습니다. 남은 블록 순차 공고');
  assert.equal(Object.fromEntries(lateTown.blocks.map((b) => [b.block, b])).A11.status, '예정 지남(보도)');
  // 청약홈 공고가 안 이어진 이력도 접수 마감(end)이 남았으면 접수 중이고, 출력 이력에 end가 있다
  const galmae = data.projects.find((p) => p.id === 'town-guri-galmae-station');
  assert.equal(galmae.history[0].end, '2026-11-11');
  assert.deepEqual([galmae.blocks[0].block, galmae.blocks[0].status, galmae.blocks[0].statusDate], ['B-1', '접수 중', '2026-11-11']);
});

// --- 관련 소식(네이버 뉴스) ---

const newsEnv = { NAVER_CLIENT_ID: 'test-id', NAVER_CLIENT_SECRET: 'test-secret' };
const newsRaw = (title, pubDate, url, extra = {}) => ({
  title, originallink: url, link: 'https://n.news.naver.com/article/003/1', description: '요약은 저장하지 않는다', pubDate, ...extra,
});

const newsLineOf = (lines) => lines.find((line) => line.startsWith('map news '));

// 네이버 API 허브 뉴스 검색만 받는 가짜 fetch. reply(query) -> items 배열 또는 Response
function newsFetch(reply, calls = []) {
  return async (url, init = {}) => {
    const u = new URL(url);
    if (`${u.origin}${u.pathname}` !== NEWS_ENDPOINTS.hub.url) throw new Error('unexpected request');
    const query = u.searchParams.get('query');
    calls.push({ query, headers: init.headers ?? {} });
    const answer = reply(query);
    if (answer instanceof Response) return answer;
    return Response.json({ total: answer.length, start: 1, display: answer.length, items: answer });
  };
}

test('news keeps 14 days on the map so a weekly rebuild stays within the 21-day storage limit', () => {
  assert.equal(NEWS_PUBLISH_DAYS, 14);
  assert.equal(NEWS_PUBLISH_DAYS + MAP_REBUILD_DAYS, NEWS_MAX_AGE_DAYS);
  assert.equal(NEWS_MAX_AGE_DAYS, 21);
});

test('buildMap attaches recent news to target projects (hub headers, 14-day cutoff, public shape)', async () => {
  const calls = [];
  const fetch = newsFetch((query) => {
    if (query === '하남교산') {
      return [
        newsRaw('<b>하남교산</b> A3블록 &quot;본청약&quot; 일정', 'Tue, 10 Nov 2026 09:00:00 +0900', 'https://www.hankyung.com/1'),
        newsRaw('교산 신도시 교통 대책', 'Tue, 27 Oct 2026 10:00:00 +0900', 'https://www.newsis.com/2'), // 14일 전: 남김
        newsRaw('하남교산 토지보상 마무리', 'Mon, 26 Oct 2026 10:00:00 +0900', 'https://www.yna.co.kr/3'), // 15일 전: 뺌
        newsRaw('감일지구 소식', 'Mon, 09 Nov 2026 10:00:00 +0900', 'https://www.mk.co.kr/4'), // 이름 없음: 뺌
      ];
    }
    if (query === '종로 신영1구역 재개발') return [newsRaw('신영10구역 조합 총회', 'Mon, 09 Nov 2026 10:00:00 +0900', 'https://www.yna.co.kr/5')];
    return [];
  }, calls);
  const data = await buildMap({
    fetch, env: newsEnv, today, seoulFile, newtownsFile: townsFile, sleep: noSleep,
  });
  assert.deepEqual(calls.map((c) => c.query), ['하남교산', '종로 신영1구역 재개발', '강남 개포주공5단지 재건축', '서초 반포미도2차 재건축']);
  // 공고 연결을 건너뛰어(키 없음) 반포미도2차도 announced가 아닌 soon이라 대상이다.
  for (const { headers } of calls) {
    assert.equal(headers['X-NCP-APIGW-API-KEY-ID'], 'test-id');
    assert.equal(headers['X-NCP-APIGW-API-KEY'], 'test-secret');
  }
  assert.deepEqual(data.sources.news, {
    checked: 4, matched: 1, projects: 4, skipped: null, errors: [], stopped: null,
  });
  const gyosan = data.projects.find((p) => p.id === 'town-hanam-gyosan');
  assert.deepEqual(gyosan.news, [
    { title: '하남교산 A3블록 "본청약" 일정', outlet: '한국경제', date: '2026-11-10', url: 'https://www.hankyung.com/1' },
    { title: '교산 신도시 교통 대책', outlet: '뉴시스', date: '2026-10-27', url: 'https://www.newsis.com/2' },
  ]);
  // 기사가 없는 사업에는 news가 없다. 요약(description)은 어디에도 남지 않는다.
  assert.equal(data.projects.filter((p) => 'news' in p).length, 1);
  assert.equal(JSON.stringify(data).includes('요약은 저장하지 않는다'), false);
  assert.equal(newsLineOf(summaryLines(data)), 'map news checked=4 matched=1 projects=4 errors=0 stopped=none');
});

test('buildMap skips news without both Naver keys', async () => {
  for (const env of [{}, { NAVER_CLIENT_ID: 'test-id' }, { NAVER_CLIENT_ID: ' ', NAVER_CLIENT_SECRET: 'x' }]) {
    const calls = [];
    const data = await buildMap({
      fetch: newsFetch(() => [], calls), env, today, seoulFile, newtownsFile: townsFile, sleep: noSleep,
    });
    assert.equal(calls.length, 0);
    assert.deepEqual(data.sources.news, {
      checked: 0, matched: 0, projects: 0, skipped: 'no_key', errors: [], stopped: null,
    });
    assert.ok(data.projects.every((p) => !('news' in p)));
    assert.equal(newsLineOf(summaryLines(data)), 'map news skipped=no_key');
  }
});

test('news failures never stop the map build', async () => {
  // 사업 하나가 실패하면 kind만 남기고 다음 사업으로 간다.
  const partial = await buildMap({
    fetch: newsFetch((query) => (query === '하남교산'
      ? new Response('', { status: 500 })
      : [newsRaw('신영1구역 관리처분 인가', 'Mon, 09 Nov 2026 10:00:00 +0900', 'https://www.yna.co.kr/9')])),
    env: newsEnv, today, seoulFile, newtownsFile: townsFile, sleep: noSleep,
  });
  assert.equal(partial.projects.length, 5);
  assert.deepEqual(partial.sources.news, {
    checked: 4, matched: 1, projects: 4, skipped: null, errors: ['news_http_500'], stopped: null,
  });
  assert.deepEqual(partial.projects.find((p) => p.id === 'seoul-1441').news.map((n) => n.url), ['https://www.yna.co.kr/9']);
  assert.equal(newsLineOf(summaryLines(partial)), 'map news checked=4 matched=1 projects=4 errors=1 stopped=none kinds=news_http_500');

  // 인증 오류는 첫 사업에서 멈춘다.
  const calls = [];
  const denied = await buildMap({
    fetch: newsFetch(() => new Response('', { status: 401 }), calls),
    env: newsEnv, today, seoulFile, newtownsFile: townsFile, sleep: noSleep,
  });
  assert.equal(calls.length, 1);
  assert.equal(denied.projects.length, 5);
  assert.deepEqual(denied.sources.news, {
    checked: 1, matched: 0, projects: 4, skipped: null, errors: ['news_http_401'], stopped: 'news_http_401',
  });

  // 뉴스 단계가 통째로 던져도 지도는 만들어지고 kind만 남는다.
  for (const [thrown, kind] of [[new Error('boom'), 'news_failed'], [new AppError('news_parse'), 'news_parse']]) {
    const data = await buildMap({
      fetch: newsFetch(() => []),
      env: newsEnv,
      today,
      seoulFile,
      newtownsFile: townsFile,
      sleep: noSleep,
      news: async () => { throw thrown; },
    });
    assert.equal(data.projects.length, 5);
    assert.ok(data.projects.every((p) => !('news' in p)));
    assert.deepEqual(data.sources.news, {
      checked: 0, matched: 0, projects: 0, skipped: null, errors: [kind], stopped: null,
    });
  }
});

test('run logs the news line with counts only', async () => {
  const lines = [];
  const code = await run({
    argv: ['--out', join(dir, 'news.json'), '--seoul-file', seoulFile, '--newtowns', townsFile],
    env: newsEnv,
    today,
    fetch: newsFetch((query) => (query === '하남교산'
      ? [newsRaw('하남교산 본청약', 'Mon, 09 Nov 2026 10:00:00 +0900', 'https://www.hankyung.com/1')]
      : [])),
    log: (line) => lines.push(line),
  });
  assert.equal(code, 0);
  assert.equal(newsLineOf(lines), 'map news checked=4 matched=1 projects=4 errors=0 stopped=none');
  assert.ok(lines.every((line) => !line.includes('http') && !line.includes('test-id') && !line.includes('test-secret')));
});
