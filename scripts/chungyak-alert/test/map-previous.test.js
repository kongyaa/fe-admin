import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_PREVIOUS_URL, buildChanges, checkPrevious, diffStages, loadPrevious,
} from '../src/pipeline/previous.js';
import { previousSource } from '../src/pipeline/build-map.js';

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
