import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { MAX_VALUE_SKIP_RATIO, buildMap, checkSeoulValues, markAnnounced, parseArgs, run, summaryLines } from '../src/pipeline/build-map.js';
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
