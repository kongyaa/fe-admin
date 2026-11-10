// 분양 예정 지도의 분양 성과(분양가, 주변 시세 비교, 경쟁률) 검사
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  COMPETITION_BASE_URL, createCompetitionClient, parseRate, summarizeCompetition,
} from '../src/pipeline/applyhome-competition.js';
import {
  REASONS, attachPerformance, blockPerformance, buildPerformance, chooseCompetition, discountRate, loadConfig, marketPoint,
  monthsPeriod, performanceTargets, pickRepresentative, priceRows, restrictedReason,
} from '../src/pipeline/block-performance.js';
import { buildMap, performanceLine, summaryLines } from '../src/pipeline/build-map.js';
import { competitionEntry, parseNewtowns } from '../src/pipeline/newtowns.js';
import { CONFIDENCE } from '../src/market-estimate.js';
import { seoulFixture } from './map-fixtures.js';

const app = await import('../site/app.js');

const today = '2026-11-10';
const noSleep = async () => {};
const config = loadConfig();
const dir = mkdtempSync(join(tmpdir(), 'chungyak-perf-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const seoulFile = join(dir, 'seoul.xlsx');
writeFileSync(seoulFile, seoulFixture());

// --- 경쟁률 파서 ---------------------------------------------------------------

test('parseRate reads numbers and treats 미달, dashes and △ as unknown', () => {
  assert.equal(parseRate('263.3'), 263.3);
  assert.equal(parseRate('1,234.56'), 1234.56);
  assert.equal(parseRate(' 12.5:1 '), 12.5);
  assert.equal(parseRate(7), 7);
  for (const bad of ['미달', '-', '–', '(△3)', '△12', '', null, undefined, 'abc', -1, Number.NaN]) {
    assert.equal(parseRate(bad), null, String(bad));
  }
});

const row = (fields) => ({
  HOUSE_MANAGE_NO: '2025000001', PBLANC_NO: '2025000001', SUBSCRPT_RANK_CODE: 1, RESIDE_SECD: '01', ...fields,
});

test('summarizeCompetition sums rank-1 applicants over residence rows and divides by households once', () => {
  const summary = summarizeCompetition([
    row({ HOUSE_TY: '084.9800A', SUPLY_HSHLDCO: 100, REQ_CNT: '5,000', RESIDE_SECD: '01', CMPET_RATE: '50' }),
    row({ HOUSE_TY: '084.9800A', SUPLY_HSHLDCO: 100, REQ_CNT: '3000', RESIDE_SECD: '02', CMPET_RATE: '30' }),
    row({ HOUSE_TY: '084.9800A', SUPLY_HSHLDCO: 100, REQ_CNT: '900', SUBSCRPT_RANK_CODE: 2 }),
    // 순위 코드가 문자열이어도 1순위
    row({ HOUSE_TY: '059.9900A', SUPLY_HSHLDCO: '101', REQ_CNT: '44920', SUBSCRPT_RANK_CODE: '01' }),
  ]);
  assert.deepEqual(summary, {
    households: 201,
    applicants: 52920,
    rate: 263.28,
    shortfall: false,
    byType: [
      { houseType: '059.9900A', households: 101, applicants: 44920, rate: 444.75, shortfall: false },
      { houseType: '084.9800A', households: 100, applicants: 8000, rate: 80, shortfall: false },
    ],
  });
});

test('summarizeCompetition handles 미달 strings, CMPET_RATE fallback and empty data', () => {
  const summary = summarizeCompetition([
    // 접수건수가 숫자면 CMPET_RATE의 '미달'과 상관없이 다시 계산한다
    row({ HOUSE_TY: '046.0000A', SUPLY_HSHLDCO: 50, REQ_CNT: '20', CMPET_RATE: '미달' }),
    // 접수건수를 못 읽고 행이 하나뿐이면 경쟁률 문자열로 거꾸로 잡는다
    row({ HOUSE_TY: '055.0000A', SUPLY_HSHLDCO: 10, REQ_CNT: '-', CMPET_RATE: '3.5' }),
    // 접수건수도 경쟁률도 못 읽으면 뺀다
    row({ HOUSE_TY: '074.0000A', SUPLY_HSHLDCO: 10, REQ_CNT: '미달', CMPET_RATE: '(△4)' }),
    // 공급세대수를 모르면 뺀다
    row({ HOUSE_TY: '084.0000A', SUPLY_HSHLDCO: null, REQ_CNT: '100' }),
  ]);
  assert.deepEqual(summary.byType.map((t) => [t.houseType, t.applicants, t.rate, t.shortfall]), [
    ['046.0000A', 20, 0.4, true],
    ['055.0000A', 35, 3.5, false],
  ]);
  assert.equal(summary.households, 60);
  assert.equal(summary.applicants, 55);
  assert.equal(summary.shortfall, true);
  assert.equal(summarizeCompetition([]), null);
  assert.equal(summarizeCompetition([row({ SUBSCRPT_RANK_CODE: 2, SUPLY_HSHLDCO: 1, REQ_CNT: '3' })]), null);
  assert.equal(summarizeCompetition(null), null);
});

test('competition client: Authorization header, paging, soft errors and 401/403 stop', async () => {
  const urls = [];
  const auth = [];
  let status = 200;
  const fetch = async (url, init) => {
    urls.push(url);
    auth.push(init.headers.Authorization);
    if (status !== 200) return new Response('x', { status });
    const page = Number(new URL(url).searchParams.get('page'));
    return Response.json({
      matchCount: 2,
      data: [row({ HOUSE_TY: `0${page}`, SUPLY_HSHLDCO: 1, REQ_CNT: '2' })],
    });
  };
  const client = createCompetitionClient({ fetch, key: 'K', sleep: noSleep });
  const ok = await client.get({ houseManageNo: '2025000001', pblancNo: '2025000002' });
  assert.equal(ok.error, null);
  assert.equal(ok.result.byType.length, 2);
  assert.equal(urls.length, 2);
  const first = new URL(urls[0]);
  assert.equal(`${first.origin}${first.pathname}`, `${COMPETITION_BASE_URL}/getAPTLttotPblancCmpet`);
  assert.equal(first.searchParams.get('cond[HOUSE_MANAGE_NO::EQ]'), '2025000001');
  assert.equal(first.searchParams.get('cond[PBLANC_NO::EQ]'), '2025000002');
  assert.ok(!urls[0].includes('K'));
  assert.deepEqual([...new Set(auth)], ['Infuser K']);

  status = 500;
  const failed = await client.get({ houseManageNo: '1', pblancNo: '1' });
  assert.equal(failed.error, 'competition_http_500');
  assert.equal(client.stopped(), null);

  status = 403;
  const before = urls.length;
  const denied = await client.get({ houseManageNo: '1', pblancNo: '1' });
  assert.equal(denied.error, 'competition_http_403');
  assert.equal(urls.length, before + 1);
  const later = await client.get({ houseManageNo: '2', pblancNo: '2' });
  assert.deepEqual(later, { result: null, error: null, skipped: 'competition_unauthorized' });
  assert.equal(urls.length, before + 1);

  const broken = createCompetitionClient({ fetch: async () => Response.json({ nope: true }), key: 'K', sleep: noSleep });
  assert.equal((await broken.get({ houseManageNo: '1', pblancNo: '1' })).error, 'competition_parse');
  const notJson = createCompetitionClient({ fetch: async () => new Response('<html>'), key: 'K', sleep: noSleep });
  assert.equal((await notJson.get({ houseManageNo: '1', pblancNo: '1' })).error, 'competition_parse');
});

// --- 분양가·할인율 ---------------------------------------------------------------

test('priceRows keeps priced types with 만원/전용㎡ and pickRepresentative prefers ~84㎡', () => {
  const prices = priceRows([
    { houseType: '059.9900A', area: 59.99, price: 48000 },
    { houseType: '084.9800A', area: 84.98, price: 64000 },
    { houseType: '084.9700B', area: 84.97, price: 63000 },
    { houseType: '101.0000A', area: 101, price: 80000 },
    { houseType: '000', area: null, price: 1 },
    { houseType: '074', area: 74, price: null },
  ]);
  assert.deepEqual(prices.map((p) => [p.houseType, p.unitPrice]), [
    ['059.9900A', 800.1], ['084.9700B', 741.4], ['084.9800A', 753.1], ['101.0000A', 792.1],
  ]);
  // 84에서 0.97 대 0.98: 더 가까운 84.97
  assert.equal(pickRepresentative(prices).houseType, '084.9700B');
  // 같은 거리면 최고 분양가가 높은 것
  assert.equal(pickRepresentative([
    { houseType: 'a', area: 82, topPrice: 1 }, { houseType: 'b', area: 86, topPrice: 2 },
  ]).houseType, 'b');
  // ±3 밖이면 가장 넓은 것
  assert.equal(pickRepresentative(priceRows([
    { houseType: '046', area: 46, price: 30000 }, { houseType: '055', area: 55, price: 36000 },
  ])).houseType, '055');
  assert.equal(pickRepresentative([]), null);
  assert.deepEqual(priceRows(null), []);
});

test('discountRate is 1 − price/estimate and monthsPeriod spans the months', () => {
  assert.equal(discountRate(64000, 90000), 0.289);
  assert.equal(discountRate(99000, 90000), -0.1);
  assert.equal(discountRate(0, 90000), null);
  assert.equal(discountRate(64000, null), null);
  assert.equal(monthsPeriod(['202502', '202501', '202412', '202411', '202410', '202409']), '2024-09~2025-02');
  assert.equal(monthsPeriod([]), null);
});

const best = (overrides = {}) => ({
  estimate: 90000,
  confidence: CONFIDENCE.MID,
  margin: 1,
  safeValue: 85000,
  basis: {
    kind: 'comparables',
    scope: '시군구',
    samples: 41,
    comparables: ['가', '나', '다', '라', '마', '바'].map((name) => ({ name, reference: 1 })),
  },
  ...overrides,
});

test('marketPoint shows the estimate without margin and hides low confidence or missing estimates', () => {
  const months = ['202502', '202501', '202412', '202411', '202410', '202409'];
  const opts = {
    asOf: '2025-03-31', months, price: 64000, area: 84.98, place: { district: '하남시', umd: '천현동' },
  };
  const point = marketPoint(best(), opts);
  assert.deepEqual(point, {
    asOf: '2025-03-31',
    period: '2024-09~2025-02',
    estimate: 90000,
    unit: 1059.1,
    discountRate: 0.289,
    confidence: '중',
    scope: '시군구',
    scopeLabel: '하남시',
    comparables: ['가', '나', '다', '라', '마'],
    comparableCount: 6,
    samples: 41,
  });
  // 안전 마진·보수 시세는 옮기지 않는다
  assert.equal('margin' in point || 'safeValue' in point, false);
  assert.equal(marketPoint(best({ basis: { kind: 'comparables', scope: '법정동', samples: 5, comparables: [] } }), opts).scopeLabel, '천현동');
  assert.deepEqual(marketPoint(best({ confidence: CONFIDENCE.LOW }), opts), {
    asOf: '2025-03-31', period: '2024-09~2025-02', estimate: null, reason: REASONS.lowConfidence,
  });
  assert.equal(marketPoint(null, opts).reason, REASONS.noEstimate);
  assert.equal(marketPoint(best({ estimate: 0 }), opts).reason, REASONS.noEstimate);
});

// --- 경쟁률 우선순위·yaml ---------------------------------------------------------

const reported = {
  rate: 263.3, applicants: 52920, households: 201, scope: '일반공급',
  source: { title: '하남교산 A2 (뉴시스)', url: 'https://mobile.newsis.com/view/NISX20250509_0003170095', date: '2025-05-09' },
};

test('chooseCompetition prefers the 청약홈 API and falls back to the reported value with its source', () => {
  const api = summarizeCompetition([row({ HOUSE_TY: '084', SUPLY_HSHLDCO: 10, REQ_CNT: '100' })]);
  assert.deepEqual(chooseCompetition(api, reported), {
    source: '청약홈',
    scope: '1순위',
    rate: 10,
    applicants: 100,
    households: 10,
    shortfall: false,
    byType: [{ houseType: '084', households: 10, applicants: 100, rate: 10, shortfall: false }],
    ref: null,
  });
  assert.deepEqual(chooseCompetition(null, reported), {
    source: '보도',
    scope: '일반공급',
    rate: 263.3,
    applicants: 52920,
    households: 201,
    shortfall: false,
    byType: [],
    ref: {
      title: '하남교산 A2 (뉴시스)', url: 'https://mobile.newsis.com/view/NISX20250509_0003170095', date: '2025-05-09', outlet: '뉴시스',
    },
  });
  assert.equal(chooseCompetition(null, null), null);
});

const townYaml = (competition, extra = '') => `
towns:
  - id: t
    name: 테스트
    stage: 블록별 분양
    history:
      - block: A2
        noticeDate: "2025-03-31"
        ${extra}
        source: { title: 공고, url: "https://example.com/n" }
        competition: ${competition}
`;

test('newtowns.yaml history competition is validated', () => {
  const { towns } = parseNewtowns(townYaml(`{ scope: 일반공급, households: 201, applicants: "52,920", rank1Rate: 263.3, source: { title: 기사, url: "https://example.com/c", date: "2025-05-09" } }`));
  assert.deepEqual(towns[0].history[0].competition, {
    rate: 263.3, applicants: 52920, households: 201, scope: '일반공급', source: { title: '기사', url: 'https://example.com/c', date: '2025-05-09' },
  });
  // 경쟁률이 없으면 접수/세대로 계산
  assert.equal(competitionEntry({ applicants: 1000, households: 3, source: { url: 'https://example.com/c' } }).rate, 333.33);
  assert.equal(competitionEntry(null), null);
  const fails = (yaml, kind) => assert.throws(() => parseNewtowns(yaml), (error) => error.kind === kind);
  fails(townYaml('{ rank1Rate: 3 }'), 'newtowns_source');
  fails(townYaml('{ rank1Rate: 3, source: { url: "javascript:alert(1)" } }'), 'newtowns_source');
  fails(townYaml('{ applicants: 10, source: { url: "https://example.com/c" } }'), 'newtowns_field');
  fails(townYaml('{ rank1Rate: -1, source: { url: "https://example.com/c" } }'), 'newtowns_field');
  fails(townYaml('{ rank1Rate: 많음, source: { url: "https://example.com/c" } }'), 'newtowns_field');
  fails(townYaml('[1, 2]'), 'newtowns_field');
  fails(townYaml('{ rank1Rate: 3, source: { url: "https://example.com/c" } }', 'stage: 사전청약'), 'newtowns_field');
  fails(townYaml('{ rank1Rate: 3, source: { url: "https://example.com/c" } }', 'rental: true'), 'newtowns_field');
  // competition이 없는 이력에는 키가 생기지 않는다
  const plain = parseNewtowns(townYaml('').replace('        competition: \n', ''));
  assert.equal('competition' in plain.towns[0].history[0], false);
});

test('the real newtowns.yaml A2 competition matches the cited article (일반공급, not 1순위)', async () => {
  const { loadNewtowns } = await import('../src/pipeline/newtowns.js');
  const { DEFAULT_NEWTOWNS } = await import('../src/pipeline/build-map.js');
  const gyosan = loadNewtowns(DEFAULT_NEWTOWNS).projects.find((p) => p.id === 'town-hanam-gyosan');
  const a2 = gyosan.history.find((h) => h.block === 'A2' && h.stage === '본청약');
  assert.deepEqual(
    [a2.competition.scope, a2.competition.households, a2.competition.applicants, a2.competition.rate],
    ['일반공급', 201, 52920, 263.3],
  );
});

// --- 블록 하나 ---------------------------------------------------------------

const apt = (fields = {}) => ({
  key: '2025000001-2025000001',
  kind: 'apt',
  mdlOp: 'getAPTLttotPblancMdl',
  houseSecd: '01',
  houseManageNo: '2025000001',
  pblancNo: '2025000001',
  typeLabel: 'APT',
  name: '교산 푸르지오 더 퍼스트',
  builder: '',
  region: '경기',
  address: '경기도 하남시 천현동 일원',
  announceDate: '2025-03-31',
  url: 'https://www.applyhome.co.kr/a2',
  ...fields,
});

const fakeDeps = (overrides = {}) => {
  const calls = { models: 0, trades: 0, presale: 0, competition: 0 };
  return {
    calls,
    deps: {
      config,
      today,
      getModels: async () => {
        calls.models += 1;
        return [{ houseType: '084.9800A', area: 84.98, price: 64000 }];
      },
      molit: {
        getTrades: async () => {
          calls.trades += 1;
          return [];
        },
      },
      presale: {
        getTrades: async () => {
          calls.presale += 1;
          return { rows: [], ok: true };
        },
      },
      competition: {
        get: async () => {
          calls.competition += 1;
          return { result: null, error: null };
        },
      },
      ...overrides,
    },
  };
};

test('restricted types keep prices and competition but skip the 시세 lookups', async () => {
  for (const target of [
    { notice: apt({ houseSecd: '10', typeLabel: '신혼희망타운', name: '구리갈매역세권 A-1블록' }) },
    { notice: apt({ name: '하남교산 A5 나눔형' }) },
    { notice: apt(), rowType: '나눔형 공공분양' },
  ]) {
    const { calls, deps } = fakeDeps();
    const perf = await blockPerformance({ id: 'x', district: '구리시', history: null, ...target }, deps);
    assert.equal(perf.representative.houseType, '084.9800A');
    assert.equal(perf.market, null);
    assert.match(perf.marketReason, /비교하지 않습니다$/);
    assert.equal(calls.trades + calls.presale, 0);
    assert.equal(calls.competition, 1);
  }
  assert.equal(restrictedReason('신혼희망'), '신혼희망타운은 수익공유·전매 조건이 달라 시세 차익을 그대로 갖지 못해 주변 시세와 비교하지 않습니다');
});

test('blockPerformance hides a market point without enough comparables and reports each reason', async () => {
  const { calls, deps } = fakeDeps();
  const perf = await blockPerformance({ id: 'x', district: '하남시', notice: apt(), history: { competition: reported } }, deps);
  assert.deepEqual(perf.market, {
    atNotice: { asOf: '2025-03-31', period: '2024-09~2025-02', estimate: null, reason: REASONS.noEstimate },
    now: { asOf: today, period: '2026-05~2026-10', estimate: null, reason: REASONS.noEstimate },
  });
  assert.equal(calls.trades, 2);
  // API에 없으면 보도 값
  assert.equal(perf.competition.source, '보도');
  assert.equal(perf.competitionReason, null);

  const errors = [];
  const failing = fakeDeps({
    getModels: async () => {
      throw Object.assign(new Error('boom'), { name: 'AppError', kind: 'applyhome_http_500' });
    },
  });
  const noModels = await blockPerformance({ id: 'x', notice: apt(), history: null }, { ...failing.deps, errors });
  assert.equal(noModels.pricesReason, REASONS.modelsFailed);
  assert.equal(noModels.competitionReason, REASONS.noCompetition);

  const unmapped = await blockPerformance({ id: 'x', notice: apt({ address: '어딘가', region: null }), history: null }, fakeDeps().deps);
  assert.equal(unmapped.marketReason, REASONS.unmapped);

  const tradeErrors = [];
  const molitDown = fakeDeps({
    molit: {
      getTrades: async () => {
        const { AppError } = await import('../src/util.js');
        throw new AppError('molit_timeout');
      },
    },
  });
  const down = await blockPerformance({ id: 'x', notice: apt(), history: null }, { ...molitDown.deps, errors: tradeErrors });
  assert.equal(down.market.now.reason, REASONS.tradesFailed);
  assert.deepEqual(tradeErrors, ['molit_timeout', 'molit_timeout']);
  assert.equal(down.representative.topPrice, 64000);

  const noKey = await blockPerformance({ id: 'x', notice: null, history: { competition: reported } }, { ...fakeDeps().deps, hasKey: false });
  assert.equal(noKey.pricesReason, REASONS.noKey);
  assert.equal(noKey.competition.rate, 263.3);
});

test('performanceTargets picks sale rows with linked APT notices or a cited competition', () => {
  const project = {
    id: 'town-x',
    kind: '공공주택지구',
    stage: '블록별 분양',
    district: '하남시',
    history: [
      { block: 'A2', stage: '사전청약', noticeDate: '2021-11-18', rental: false },
      { block: 'A2', stage: '본청약', noticeDate: '2025-03-31', rental: false, competition: reported },
      { block: 'A-1', stage: '본청약', noticeDate: '2026-10-27', rental: true, type: '행복주택' },
      { block: 'B1', stage: '본청약', noticeDate: '2026-01-01', rental: false },
    ],
    plans: [],
    blockEntries: [{ block: 'A9', rental: false, status: '사업승인' }],
    notices: [
      { key: 'k-a9', name: '하남교산 A9블록 공공분양', announceDate: '2026-10-01', typeLabel: 'APT' },
      { key: 'k-a9-pre', name: '하남교산 A9블록 사전', announceDate: '2026-01-01', typeLabel: '민간사전청약' },
      { key: 'k-a1', name: 'A-1BL 행복주택', announceDate: '2026-10-27', typeLabel: '민간임대' },
    ],
    blocks: [
      { block: 'A2', rental: false, type: '공공분양' },
      { block: 'A9', rental: false, type: '공공분양' },
      { block: 'A-1', rental: true, type: '행복주택' },
      { block: 'B1', rental: false },
    ],
  };
  const fullByKey = new Map([
    ['k-a9', apt({ key: 'k-a9', announceDate: '2026-10-01' })],
    ['k-a9-pre', apt({ key: 'k-a9-pre', houseSecd: '09' })],
    ['k-a1', apt({ key: 'k-a1', kind: 'pblrent' })],
  ]);
  const targets = performanceTargets(project, { fullByKey, today });
  assert.deepEqual(targets.map((t) => [t.id, t.notice?.key ?? null, Boolean(t.history?.competition)]), [
    ['town-x|A2|sale', null, true],
    ['town-x|A9|sale', 'k-a9', false],
  ]);
  assert.deepEqual(performanceTargets({ ...project, stage: '지구계획승인' }, { fullByKey, today }), []);
  assert.deepEqual(performanceTargets({ id: 'seoul-1', region: '서울' }, { fullByKey, today }), []);
});

test('attachPerformance adds performance only to the matching rows', () => {
  const project = { id: 'p', blocks: [{ block: 'A-2', rental: false }, { block: 'A2', rental: true }, { block: 'B1', rental: false }] };
  const out = attachPerformance(project, new Map([['p|A2|sale', { name: 'x' }]]));
  assert.deepEqual(out.blocks.map((b) => b.performance ?? null), [{ name: 'x' }, null, null]);
  assert.equal('performance' in out.blocks[1], false);
  assert.equal(attachPerformance(project, new Map()), project);
});

test('buildPerformance isolates a block that throws and keeps counting', async () => {
  const { deps } = fakeDeps();
  const clients = { ...deps };
  let n = 0;
  clients.getModels = async () => {
    n += 1;
    if (n === 1) return [{ houseType: '084', area: 84, price: 50000 }];
    return { notAnArray: true, map: null };
  };
  // 두 번째 블록은 주택형 형식이 틀려도 priceRows가 빈 배열로 받고, 세 번째는 블록 처리 자체가 예외를 낸다
  const targets = [
    { id: 'a', notice: apt(), history: null },
    { id: 'b', notice: apt(), history: null },
    { id: 'c', get notice() { throw new TypeError('bad target'); }, history: null },
  ];
  const { results, stats } = await buildPerformance(targets, {
    fetch: async () => { throw new Error('should not fetch'); }, key: 'K', today, config, clients,
  });
  assert.deepEqual([...results.keys()], ['a', 'b']);
  assert.equal(results.get('b').pricesReason, REASONS.noPrices);
  assert.deepEqual(stats, {
    blocks: 2, priced: 1, estimated: 0, competition: 0, calls: 0, errors: ['performance_unexpected'], skipped: null,
  });
  assert.equal(performanceLine(stats), 'map performance blocks=2 priced=1 estimated=0 competition=0 calls=0 errors=1');
});

// --- 지도 빌드 통합 ---------------------------------------------------------------

const townsFile = join(dir, 'newtowns.yaml');
writeFileSync(townsFile, `
asOf: "2026-11-10"
towns:
  - id: hanam-gyosan
    name: 하남교산
    district: 하남
    stage: 블록별 분양
    noticeMatch: [교산]
    history:
      - block: A2
        type: 공공분양
        noticeDate: "2025-03-31"
        title: 교산 푸르지오 더 퍼스트
        source: { title: 공고, url: "https://example.com/a2" }
        competition: { scope: 일반공급, households: 201, applicants: 52920, rank1Rate: 263.3, source: { title: "기사 (뉴시스)", url: "https://example.com/c", date: "2025-05-09" } }
    blocks:
      - { block: A9, type: 공공분양, status: 사업승인, sources: { title: 기사, url: "https://example.com/a9" } }
  - id: guri-galmae-station
    name: 구리갈매역세권
    district: 구리
    stage: 블록별 분양
    noticeMatch: [갈매]
    history:
      - block: A-1
        type: 신혼희망타운
        noticeDate: "2025-07-29"
        source: { title: 공고, url: "https://example.com/a1" }
      - block: A-1
        type: 행복주택
        rental: true
        noticeDate: "2026-10-27"
        source: { title: 공고, url: "https://example.com/a1r" }
`);

const DETAIL = [
  {
    HOUSE_MANAGE_NO: '2025000101', PBLANC_NO: '2025000101', HOUSE_SECD: '01', HOUSE_NM: '하남교산 A-2BL 교산 푸르지오 더 퍼스트',
    SUBSCRPT_AREA_CODE_NM: '경기', HSSPLY_ADRES: '경기도 하남시 천현동 일원', RCRIT_PBLANC_DE: '2025-03-31',
    PBLANC_URL: 'https://www.applyhome.co.kr/a2', GNRL_RNK1_CRSPAREA_RCPTDE: '2025-05-08', GNRL_RNK1_CRSPAREA_ENDDE: '2025-05-09',
  },
  {
    HOUSE_MANAGE_NO: '2026000201', PBLANC_NO: '2026000201', HOUSE_SECD: '01', HOUSE_NM: '하남교산 A9블록 공공분양',
    SUBSCRPT_AREA_CODE_NM: '경기', HSSPLY_ADRES: '경기도 하남시 천현동 일원', RCRIT_PBLANC_DE: '2026-10-01',
    PBLANC_URL: 'https://www.applyhome.co.kr/a9', GNRL_RNK1_CRSPAREA_RCPTDE: '2026-10-20', GNRL_RNK1_CRSPAREA_ENDDE: '2026-10-21',
  },
  {
    HOUSE_MANAGE_NO: '2025000301', PBLANC_NO: '2025000301', HOUSE_SECD: '10', HOUSE_NM: '구리갈매역세권 A-1블록 신혼희망타운',
    SUBSCRPT_AREA_CODE_NM: '경기', HSSPLY_ADRES: '경기도 구리시 갈매동 일원', RCRIT_PBLANC_DE: '2025-07-29',
    PBLANC_URL: 'https://www.applyhome.co.kr/a1', GNRL_RNK1_CRSPAREA_RCPTDE: '2025-08-20', GNRL_RNK1_CRSPAREA_ENDDE: '2025-08-21',
  },
];

const MODELS = {
  2025000101: [
    { HOUSE_TY: '059.9900A', LTTOT_TOP_AMOUNT: '48,000', SUPLY_HSHLDCO: 101 },
    { HOUSE_TY: '084.9800A', LTTOT_TOP_AMOUNT: '64,000', SUPLY_HSHLDCO: 100 },
  ],
  2026000201: [{ HOUSE_TY: '084.0000A', LTTOT_TOP_AMOUNT: '70,000', SUPLY_HSHLDCO: 50 }],
  2025000301: [{ HOUSE_TY: '055.0000A', LTTOT_TOP_AMOUNT: '40,000', SUPLY_HSHLDCO: 80 }],
};

const COMPETITION = {
  2025000101: [
    row({ HOUSE_TY: '059.9900A', SUPLY_HSHLDCO: 101, REQ_CNT: '44920' }),
    row({ HOUSE_TY: '084.9800A', SUPLY_HSHLDCO: 100, REQ_CNT: '5,000', RESIDE_SECD: '01' }),
    row({ HOUSE_TY: '084.9800A', SUPLY_HSHLDCO: 100, REQ_CNT: '3,000', RESIDE_SECD: '02' }),
  ],
  2026000201: [],
  2025000301: [row({ HOUSE_TY: '055.0000A', SUPLY_HSHLDCO: 80, REQ_CNT: '40', CMPET_RATE: '미달' })],
};

const xml = (items) => `<response><header><resultCode>000</resultCode></header><body><items>${items
  .map((item) => `<item>${item}</item>`).join('')}</items><totalCount>${items.length}</totalCount></body></response>`;

// 하남시 다른 동의 비교 단지 3곳(2020년 준공, 84㎡, 10층). 달마다 단지당 3건.
function tradesXml(ym) {
  const year = ym.slice(0, 4);
  const month = String(Number(ym.slice(4)));
  const complexes = [['미사강변 가', '망월동', 100000], ['미사강변 나', '풍산동', 104000], ['감일 다', '감일동', 108000]];
  const items = complexes.flatMap(([name, umd, amount], i) => [0, 1, 2].map((k) => `<aptNm>${name}</aptNm>`
    + `<dealAmount>${(amount + k * 500).toLocaleString('en-US')}</dealAmount><excluUseAr>84.9</excluUseAr><floor>10</floor>`
    + `<umdNm>${umd}</umdNm><jibun>${100 + i}</jibun><buildYear>2020</buildYear><dealingGbn>중개거래</dealingGbn>`
    + `<aptSeq>41450-${i}</aptSeq><dealYear>${year}</dealYear><dealMonth>${month}</dealMonth><dealDay>${10 + k}</dealDay>`));
  return xml(items);
}

function cityFetch({ log = [], competitionStatus = 200, modelStatus = {} } = {}) {
  return async (url) => {
    log.push(url);
    const u = new URL(url);
    if (u.hostname === 'apis.data.go.kr') {
      if (u.pathname.includes('RTMSDataSvcSilvTrade')) return new Response(xml([]));
      if (u.searchParams.get('LAWD_CD') === '41450') return new Response(tradesXml(u.searchParams.get('DEAL_YMD')));
      return new Response(xml([]));
    }
    const op = u.pathname.split('/').at(-1);
    const house = u.searchParams.get('cond[HOUSE_MANAGE_NO::EQ]');
    if (op === 'getAPTLttotPblancDetail') return Response.json({ totalCount: DETAIL.length, data: DETAIL });
    if (op === 'getAPTLttotPblancMdl') {
      if (modelStatus[house]) return new Response('x', { status: modelStatus[house] });
      return Response.json({ totalCount: MODELS[house].length, data: MODELS[house] });
    }
    if (op === 'getAPTLttotPblancCmpet') {
      if (competitionStatus !== 200) return new Response('x', { status: competitionStatus });
      return Response.json({ totalCount: COMPETITION[house].length, data: COMPETITION[house] });
    }
    return Response.json({ totalCount: 0, data: [] });
  };
}

const kindOf = (url) => {
  const u = new URL(url);
  if (u.pathname.includes('RTMSDataSvcSilvTrade')) return 'presale';
  if (u.pathname.includes('RTMSDataSvcAptTrade')) return 'trade';
  return u.pathname.split('/').at(-1);
};

const perfOf = (data, id, block) => data.projects.find((p) => p.id === id).blocks
  .find((b) => b.block === block && !b.rental)?.performance ?? null;

test('buildMap attaches 분양 성과 to announced sale blocks, caches MOLIT months and counts calls', async () => {
  const log = [];
  const data = await buildMap({
    fetch: cityFetch({ log }), env: { DATA_GO_KR_KEY: 'k' }, today, seoulFile, newtownsFile: townsFile, sleep: noSleep,
  });
  const a2 = perfOf(data, 'town-hanam-gyosan', 'A2');
  assert.equal(a2.noticeKey, '2025000101-2025000101');
  assert.equal(a2.noticeUrl, 'https://www.applyhome.co.kr/a2');
  assert.deepEqual(a2.representative, {
    houseType: '084.9800A', area: 84.98, topPrice: 64000, unitPrice: 753.1,
  });
  // 청약홈 API 값이 yaml 보도 값보다 먼저
  assert.deepEqual([a2.competition.source, a2.competition.scope, a2.competition.applicants, a2.competition.households, a2.competition.rate],
    ['청약홈', '1순위', 52920, 201, 263.28]);
  for (const key of ['atNotice', 'now']) {
    const point = a2.market[key];
    assert.equal(point.confidence, '중', key);
    assert.equal(point.scope, '시군구');
    assert.equal(point.scopeLabel, '하남시');
    assert.equal(point.comparableCount, 3);
    assert.equal(point.discountRate, discountRate(64000, point.estimate));
    assert.ok(point.estimate > 64000);
    assert.equal('margin' in point, false);
  }
  assert.equal(a2.market.atNotice.period, '2024-09~2025-02');
  assert.equal(a2.market.now.period, '2026-05~2026-10');

  const a9 = perfOf(data, 'town-hanam-gyosan', 'A9');
  assert.equal(a9.representative.topPrice, 70000);
  assert.equal(a9.competition, null);
  assert.equal(a9.competitionReason, REASONS.noCompetition);
  assert.equal(a9.market.atNotice.period, '2026-04~2026-09');

  // 신혼희망타운: 분양가와 경쟁률은 보이고 시세 비교는 하지 않는다
  const a1 = perfOf(data, 'town-guri-galmae-station', 'A-1');
  assert.equal(a1.representative.houseType, '055.0000A');
  assert.equal(a1.market, null);
  assert.match(a1.marketReason, /^신혼희망타운은/);
  assert.deepEqual([a1.competition.rate, a1.competition.shortfall], [0.5, true]);
  // 임대 줄에는 붙지 않는다
  const rental = data.projects.find((p) => p.id === 'town-guri-galmae-station').blocks.find((b) => b.rental);
  assert.equal('performance' in rental, false);

  // 국토부: 하남 12달(공고 당시 6 + 현재 6) + A9 공고 당시 중 새 달 1개(2026-04). 구리는 제한 유형이라 0.
  const trades = log.filter((url) => kindOf(url) === 'trade');
  const pairs = trades.map((url) => `${new URL(url).searchParams.get('LAWD_CD')}-${new URL(url).searchParams.get('DEAL_YMD')}`);
  assert.equal(new Set(pairs).size, pairs.length);
  assert.equal(trades.length, 13);
  assert.equal(log.filter((url) => kindOf(url) === 'presale').length, 13);
  assert.equal(log.filter((url) => kindOf(url) === 'getAPTLttotPblancMdl').length, 3);
  assert.equal(log.filter((url) => kindOf(url) === 'getAPTLttotPblancCmpet').length, 3);
  const detailCalls = log.filter((url) => kindOf(url).endsWith('Detail')).length;
  assert.deepEqual(data.sources.performance, {
    blocks: 3, priced: 3, estimated: 2, competition: 2, calls: log.length - detailCalls, errors: [], skipped: null,
  });
  assert.equal(summaryLines(data).at(-1), `map performance blocks=3 priced=3 estimated=2 competition=2 calls=${log.length - detailCalls} errors=0`);
});

test('buildMap keeps going when the competition API is not approved and a model lookup fails', async () => {
  const log = [];
  const data = await buildMap({
    fetch: cityFetch({ log, competitionStatus: 403, modelStatus: { 2026000201: 500 } }),
    env: { DATA_GO_KR_KEY: 'k' },
    today,
    seoulFile,
    newtownsFile: townsFile,
    sleep: noSleep,
  });
  // 403 뒤에는 경쟁률 API를 다시 부르지 않는다
  assert.equal(log.filter((url) => kindOf(url) === 'getAPTLttotPblancCmpet').length, 1);
  const a2 = perfOf(data, 'town-hanam-gyosan', 'A2');
  assert.deepEqual([a2.competition.source, a2.competition.scope, a2.competition.rate, a2.competition.ref.outlet],
    ['보도', '일반공급', 263.3, '뉴시스']);
  const a9 = perfOf(data, 'town-hanam-gyosan', 'A9');
  assert.equal(a9.pricesReason, REASONS.modelsFailed);
  assert.equal(a9.competitionReason, REASONS.competitionUnavailable);
  assert.deepEqual(data.sources.performance.errors, ['competition_http_403', 'applyhome_http_500']);
  assert.match(summaryLines(data).at(-1), /errors=2$/);
});

test('buildMap without a key shows cited competition only and makes no performance calls', async () => {
  const log = [];
  const data = await buildMap({
    fetch: async (url) => {
      log.push(url);
      throw new Error('no network');
    },
    env: {},
    today,
    seoulFile,
    newtownsFile: townsFile,
    sleep: noSleep,
  });
  assert.deepEqual(log, []);
  const a2 = perfOf(data, 'town-hanam-gyosan', 'A2');
  assert.deepEqual([a2.competition.source, a2.pricesReason, a2.marketReason], ['보도', REASONS.noKey, REASONS.noKey]);
  assert.deepEqual(data.sources.performance, {
    blocks: 1, priced: 0, estimated: 0, competition: 1, calls: 0, errors: [], skipped: 'no_key',
  });
  assert.equal(summaryLines(data).at(-1), 'map performance blocks=1 priced=0 estimated=0 competition=1 calls=0 errors=0 skipped=no_key');
});

test('buildMap never fails because of the performance step', async () => {
  const data = await buildMap({
    fetch: cityFetch(),
    env: { DATA_GO_KR_KEY: 'k' },
    today,
    seoulFile,
    newtownsFile: townsFile,
    sleep: noSleep,
    performance: async () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual(data.sources.performance.errors, ['performance_failed']);
  assert.equal(perfOf(data, 'town-hanam-gyosan', 'A2'), null);
  assert.ok(data.projects.length > 2);
});

// --- 사이트 ---------------------------------------------------------------

test('site formats 분양 성과: money, discount, competition source and market lines', () => {
  assert.equal(app.fmtManwon(64000), '6억 4,000만 원');
  assert.equal(app.fmtManwon(60000), '6억 원');
  assert.equal(app.fmtManwon(9800), '9,800만 원');
  assert.equal(app.fmtManwon(null), '-');
  assert.equal(app.discountLabel(0.289), '29% 낮음');
  assert.equal(app.discountLabel(-0.12), '12% 높음');
  assert.equal(app.discountLabel(0.004), '비슷함');
  assert.equal(app.discountLabel(null), null);

  const perf = app.cleanPerformance({
    name: '교산 푸르지오 더 퍼스트',
    noticeDate: '2025-03-31',
    noticeUrl: 'javascript:alert(1)',
    prices: [{}, {}],
    representative: {
      houseType: '084.9800A', area: 84.98, topPrice: 64000, unitPrice: 753.1,
    },
    market: {
      atNotice: {
        asOf: '2025-03-31', period: '2024-09~2025-02', estimate: 90000, unit: 1059.1, discountRate: 0.289, confidence: '중',
        scope: '시군구', scopeLabel: '하남시', comparables: ['가', '나', '다'], comparableCount: 3, samples: 41,
      },
      now: { asOf: '2026-11-10', period: '2026-05~2026-10', estimate: null, reason: REASONS.lowConfidence },
    },
    competition: {
      source: '보도', scope: '일반공급', rate: 263.3, applicants: 52920, households: 201,
      ref: { title: 't', url: 'https://mobile.newsis.com/x', date: '2025-05-09' },
    },
  });
  assert.equal(perf.noticeUrl, null);
  assert.equal(app.performancePriceText(perf.representative), '대표 84.98㎡(084.9800A) 최고 6억 4,000만 원 · 전용㎡당 753만 원');
  assert.equal(app.competitionText(perf.competition), '일반공급 263.3:1 (52,920명 / 201가구)');
  assert.equal(perf.competition.ref.url, 'https://mobile.newsis.com/x');
  assert.equal(app.marketPointText(perf.atNotice, '공고 당시'),
    '공고 당시 주변 신축 환산 시세 9억 원 대비 분양가 29% 낮음 (신뢰도 중, 하남시 비교 3개 단지: 가·나·다, 실거래 41건, 2024-09~2025-02)');
  assert.equal(app.marketPointText(perf.now, '현재 기준'), `현재 기준: ${REASONS.lowConfidence} (2026-05~2026-10)`);
  const many = app.cleanPerformance({
    market: {
      now: {
        estimate: 76000, discountRate: -0.026, confidence: '중', scope: '법정동', scopeLabel: '갈매동',
        comparables: ['a', 'b', 'c', 'd', 'e', 'f'], comparableCount: 7, samples: 12, period: '2026-05~2026-10',
      },
    },
  }).now;
  assert.equal(app.marketPointText(many, '현재 기준'),
    '현재 기준 주변 신축 환산 시세 7억 6,000만 원 대비 분양가 3% 높음 (신뢰도 중, 갈매동 비교 7개 단지: a·b·c·d·e 외 2곳, 실거래 12건, 2026-05~2026-10)');
  assert.equal(app.competitionText(app.cleanPerformance({
    competition: {
      source: '청약홈', scope: '1순위', rate: 0.5, applicants: 40, households: 80, shortfall: true,
    },
  }).competition), '1순위 0.5:1 (접수 40건 / 80가구) · 미달');
  assert.match(app.MARKET_CAVEAT, /이 단지의 시세가 아닙니다 \(전매제한·미입주\)$/);
  assert.equal(app.cleanPerformance(null), null);
  assert.equal(app.cleanPerformance([1]), null);
  assert.equal(app.cleanPerformance({ competition: { rate: '많음' } }).competition, null);

  // 블록 줄: 분양 줄만 성과를 넘긴다
  const rows = app.blockRows({
    blocks: [
      { block: 'A2', status: '본청약 공고', statusDate: '2025-03-31', performance: { name: 'x' } },
      { block: 'A2', rental: true, status: '임대 공고', statusDate: '2025-03-31', performance: { name: 'y' } },
    ],
  }, today);
  assert.deepEqual(rows.map((r) => r.performance?.name ?? null), ['x', null]);
});
