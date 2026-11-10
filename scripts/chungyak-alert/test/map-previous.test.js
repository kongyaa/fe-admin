import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_PREVIOUS_URL, MAX_PREVIOUS_BYTES, buildChanges, checkPrevious, diffStages, loadPrevious,
} from '../src/pipeline/previous.js';
import { previousSource, summaryLines } from '../src/pipeline/build-map.js';

const noSleep = async () => {};
const published = {
  generatedAt: '2026-11-10T07:30:00+09:00',
  projects: [{ id: 'seoul-1', stage: '조합설립' }, { id: 'seoul-2', stage: '착공' }, { id: 'town-a', stage: '지구지정' }],
  feed: [{ kind: '단계', id: 'x' }],
};

test('loadPrevious reads the published projects.json through an injected fetch', async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    return Response.json(published);
  };
  const { data, skipped } = await loadPrevious({ fetch, url: DEFAULT_PREVIOUS_URL, sleep: noSleep });
  assert.deepEqual(calls, ['https://kongyaa.github.io/fe-admin/projects.json']);
  assert.equal(skipped, null);
  assert.equal(data.generatedAt, '2026-11-10T07:30:00+09:00');
  assert.equal(data.projects.length, 3);
  assert.equal(data.feed.length, 1);
});

test('loadPrevious never throws: each failure has a kind', async () => {
  const cases = [
    [{ fetch: async () => new Response('', { status: 404 }), url: DEFAULT_PREVIOUS_URL }, 'previous_http_404'],
    [{ fetch: async () => { throw new TypeError('fetch failed'); }, url: DEFAULT_PREVIOUS_URL }, 'previous_network'],
    [{ fetch: async () => new Response('<html>'), url: DEFAULT_PREVIOUS_URL }, 'previous_json'],
    [{ fetch: async () => Response.json({ projects: 'x' }), url: DEFAULT_PREVIOUS_URL }, 'previous_shape'],
    [{ fetch: async () => Response.json([]), url: DEFAULT_PREVIOUS_URL }, 'previous_shape'],
    [{ url: 'file:///etc/passwd' }, 'previous_url'],
    [{}, 'no_previous'],
    [{ file: 'missing.json', readFile: () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } }, 'error_ENOENT'],
  ];
  for (const [options, kind] of cases) {
    const result = await loadPrevious({ sleep: noSleep, ...options });
    assert.deepEqual(result, { data: null, skipped: kind }, kind);
  }
});

test('loadPrevious reads a local file (CLI --previous)', async () => {
  const { data, skipped } = await loadPrevious({ file: 'prev.json', readFile: () => Buffer.from(JSON.stringify(published)) });
  assert.equal(skipped, null);
  assert.equal(data.projects[0].id, 'seoul-1');
});

test('checkPrevious keeps only a date or ISO time as generatedAt', () => {
  assert.equal(checkPrevious({ generatedAt: '2026-11-10', projects: [] }).generatedAt, '2026-11-10');
  assert.equal(checkPrevious({ generatedAt: '<script>', projects: [] }).generatedAt, null);
  assert.deepEqual(checkPrevious({ projects: [null, { id: 3 }, { id: 'a' }] }).projects, [{ id: 'a' }]);
});

test('diffStages lists projects whose stage changed, in current order', () => {
  const now = [
    { id: 'seoul-2', stage: '착공' }, { id: 'seoul-1', stage: '사업시행인가' }, { id: 'town-a', stage: '지구계획승인' }, { id: 'seoul-new', stage: '구역지정' },
  ];
  assert.deepEqual(diffStages(published.projects, now), [
    { projectId: 'seoul-1', from: '조합설립', to: '사업시행인가' },
    { projectId: 'town-a', from: '지구지정', to: '지구계획승인' },
  ]);
  assert.deepEqual(buildChanges(checkPrevious(published), now).since, '2026-11-10T07:30:00+09:00');
  assert.deepEqual(buildChanges(null, now), { since: null, items: [] });
});

test('previousSource: --previous file, then MAP_PREVIOUS_URL, then the published URL', () => {
  assert.deepEqual(previousSource({ previousFile: 'p.json' }, { MAP_PREVIOUS_URL: 'https://x.example/p.json' }), { file: 'p.json' });
  assert.deepEqual(previousSource({ previousFile: null }, { MAP_PREVIOUS_URL: 'https://x.example/p.json' }), { url: 'https://x.example/p.json' });
  assert.deepEqual(previousSource({ previousFile: null }, {}), { url: DEFAULT_PREVIOUS_URL });
});

test('loadPrevious retries once, then gives up with a kind', async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('fetch failed');
    return Response.json(published);
  };
  assert.equal((await loadPrevious({ fetch: flaky, url: DEFAULT_PREVIOUS_URL, sleep: noSleep })).skipped, null);
  assert.equal(calls, 2);
  calls = 0;
  const down = async () => {
    calls += 1;
    return new Response('', { status: 503 });
  };
  assert.deepEqual(await loadPrevious({ fetch: down, url: DEFAULT_PREVIOUS_URL, sleep: noSleep }), { data: null, skipped: 'previous_http_503' });
  assert.equal(calls, 2);
});

test('loadPrevious refuses snapshots over 10 MB', async () => {
  assert.equal(MAX_PREVIOUS_BYTES, 10 * 1024 * 1024);
  const declared = async () => new Response('{}', { headers: { 'content-length': String(MAX_PREVIOUS_BYTES + 1) } });
  assert.deepEqual(await loadPrevious({ fetch: declared, url: DEFAULT_PREVIOUS_URL, sleep: noSleep }), { data: null, skipped: 'previous_too_large' });
  const big = `{"projects":[],"pad":"${'x'.repeat(MAX_PREVIOUS_BYTES)}"}`;
  const undeclared = async () => new Response(big);
  assert.deepEqual(await loadPrevious({ fetch: undeclared, url: DEFAULT_PREVIOUS_URL, sleep: noSleep }), { data: null, skipped: 'previous_too_large' });
  assert.deepEqual(await loadPrevious({ file: 'big.json', readFile: () => Buffer.from(big) }), { data: null, skipped: 'previous_too_large' });
});

test('a failed previous snapshot is logged by kind; changes.since is null', () => {
  const data = (skipped) => ({
    sources: {
      seoul: { count: 1, asOf: '2026-06', skipped: {} }, newtowns: { count: 0, skipped: null }, notices: { skipped: 'no_key' }, news: { count: 0, skipped: null }, previous: { skipped },
    },
    feed: [],
    calendar: [],
    changes: buildChanges(null, []),
    projects: [],
  });
  const failed = summaryLines(data('previous_network'));
  assert.ok(failed[0].endsWith('changes=skipped:previous_network news=0'));
  assert.ok(failed.includes('previous skipped=previous_network'));
  assert.equal(data('previous_network').changes.since, null);
  assert.ok(!summaryLines(data('no_previous')).some((line) => line.startsWith('previous skipped')));
});
