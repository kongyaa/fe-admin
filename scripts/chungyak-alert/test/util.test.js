import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AppError,
  completeMonths,
  decodeServiceKey,
  escapeHtml,
  fetchWithRetry,
  kstToday,
  maskServiceKey,
  median,
  normalizeDate,
  safeError,
  safeHttpUrl,
  weekRange,
} from '../src/util.js';

const noSleep = async () => {};

test('KST today at 22:30 UTC is the next KST date', () => {
  assert.equal(kstToday(new Date('2026-11-04T22:30:00Z')), '2026-11-05');
  assert.equal(kstToday(new Date('2026-11-04T14:59:59Z')), '2026-11-04');
  assert.equal(kstToday(new Date('2026-12-31T15:00:00Z')), '2027-01-01');
});

test('week range runs Monday to Sunday', () => {
  assert.deepEqual(weekRange('2026-11-02'), { monday: '2026-11-02', sunday: '2026-11-08' });
  assert.deepEqual(weekRange('2026-11-08'), { monday: '2026-11-02', sunday: '2026-11-08' });
  assert.deepEqual(weekRange('2026-11-09'), { monday: '2026-11-09', sunday: '2026-11-15' });
  assert.deepEqual(weekRange('2027-01-01'), { monday: '2026-12-28', sunday: '2027-01-03' });
});

test('normalizeDate handles each format and rejects bad values', () => {
  assert.equal(normalizeDate('2026-11-05'), '2026-11-05');
  assert.equal(normalizeDate('20261105'), '2026-11-05');
  assert.equal(normalizeDate('2026.11.05'), '2026-11-05');
  assert.equal(normalizeDate(20261105), '2026-11-05');
  for (const bad of ['', null, undefined, '00000000', '2026-02-30', '202611', '미정', '202611051']) {
    assert.equal(normalizeDate(bad), null);
  }
});

test('median handles odd, even and empty lists', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test('completeMonths excludes the current month and crosses years', () => {
  assert.deepEqual(completeMonths('2026-02-15', 3), ['202601', '202512', '202511']);
});

test('fetchWithRetry retries 5xx then succeeds', async () => {
  let calls = 0;
  const response = await fetchWithRetry(async () => {
    calls += 1;
    return calls === 1 ? new Response('', { status: 500 }) : new Response('ok');
  }, 'https://x.test', {}, { sleep: noSleep });
  assert.equal(calls, 2);
  assert.equal(await response.text(), 'ok');
});

test('fetchWithRetry does not retry non-idempotent calls on 5xx, but does on 429', async () => {
  let calls = 0;
  await assert.rejects(fetchWithRetry(async () => {
    calls += 1;
    return new Response('', { status: 500 });
  }, 'https://x.test', {}, { kind: 'k', idempotent: false, sleep: noSleep }), { kind: 'k_http_500' });
  assert.equal(calls, 1);

  calls = 0;
  await fetchWithRetry(async () => {
    calls += 1;
    return calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '1' } }) : new Response('ok');
  }, 'https://x.test', {}, { idempotent: false, sleep: noSleep });
  assert.equal(calls, 2);
});

test('error text contains no URL or key', async () => {
  const key = 'SECRET-KEY-123';
  const url = `https://apis.data.go.kr/path?serviceKey=${key}`;
  const failures = [
    async () => { throw new TypeError(`fetch failed ${url}`); },
    async () => new Response(`bad ${url}`, { status: 500 }),
    async () => new Response(`bad ${url}`, { status: 403 }),
  ];
  for (const fetchFn of failures) {
    const error = await fetchWithRetry(fetchFn, url, {}, { kind: 'molit', sleep: noSleep }).catch((e) => e);
    for (const text of [safeError(error), error.message, String(error)]) {
      assert.ok(!text.includes(key));
      assert.ok(!text.includes('http'.concat('s://')));
    }
  }
  const raw = safeError(new Error(`boom ${url}`));
  assert.equal(raw, 'unexpected_error');
  assert.equal(safeError(new AppError('kind_x')), 'kind_x');
});

test('masks raw and URL-encoded key in CI only', () => {
  const lines = [];
  maskServiceKey('a+b/c=', { GITHUB_ACTIONS: 'true' }, (line) => lines.push(line));
  assert.ok(lines.includes('::add-mask::a+b/c='));
  assert.ok(lines.includes('::add-mask::a%2Bb%2Fc%3D'));
  const local = [];
  maskServiceKey('a+b/c=', {}, (line) => local.push(line));
  assert.equal(local.length, 0);
});

test('decodes an encoded service key once', () => {
  assert.equal(decodeServiceKey('a%2Bb%3D'), 'a+b=');
  assert.equal(decodeServiceKey('a+b='), 'a+b=');
});

test('html and url helpers reject unsafe values', () => {
  assert.equal(escapeHtml('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpUrl('https://www.applyhome.co.kr/a'), 'https://www.applyhome.co.kr/a');
});
