import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withBlocks } from '../src/pipeline/build-map.js';
import {
  NEWS_KINDS, canonicalBlock, splitBlocks, loadNews, newsDate, newsProjectId, parseNews, resolveNews,
} from '../src/pipeline/news.js';
import { loadNewtowns } from '../src/pipeline/newtowns.js';

const today = '2026-11-10';

const one = (lines) => `asOf: "2026-11-10"\nitems:\n  - ${lines.join('\n    ')}\n`;
const base = ['town: guri-galmae-station', 'date: "2026-11-08"', 'title: 요약', 'outlet: 스트레이트뉴스', 'url: https://www.straightnews.co.kr/a'];

test('news.yaml items: required fields, defaults and project ids', () => {
  const { asOf, items } = parseNews(one([...base, 'block: B-1', 'local: true', 'extra: 무시']));
  assert.equal(asOf, '2026-11-10');
  assert.deepEqual(items, [{
    town: 'guri-galmae-station',
    projectId: 'town-guri-galmae-station',
    block: 'B-1',
    date: '2026-11-08',
    title: '요약',
    outlet: '스트레이트뉴스',
    url: 'https://www.straightnews.co.kr/a',
    local: true,
    rental: false,
    kind: '뉴스',
  }]);
  assert.deepEqual(NEWS_KINDS, ['뉴스', '일정']);
  assert.equal(parseNews(one([...base, 'kind: 일정'])).items[0].kind, '일정');
  assert.equal(newsProjectId('seoul-1673'), 'seoul-1673');
  assert.equal(newsProjectId('hanam-gyosan'), 'town-hanam-gyosan');
  assert.equal(newsDate('2026-02-28'), '2026-02-28');
  assert.deepEqual(parseNews('asOf: "2026-11-10"'), { asOf: '2026-11-10', items: [] });
});

test('news.yaml errors have their own kinds', () => {
  const without = (key) => base.filter((line) => !line.startsWith(`${key}:`));
  assert.throws(() => parseNews('items: [a'), { kind: 'news_yaml' });
  assert.throws(() => parseNews('- a'), { kind: 'news_shape' });
  assert.throws(() => parseNews('items: 기사'), { kind: 'news_shape' });
  assert.throws(() => parseNews(one(without('title'))), { kind: 'news_field' });
  assert.throws(() => parseNews(one(without('outlet'))), { kind: 'news_field' });
  assert.throws(() => parseNews(one(without('town'))), { kind: 'news_field' });
  assert.throws(() => parseNews(one([...without('town'), 'town: 하남교산'])), { kind: 'news_field' });
  assert.throws(() => parseNews(one([...base, 'kind: 공고'])), { kind: 'news_field' });
  assert.throws(() => parseNews(one([...base, 'local: 예'])), { kind: 'news_field' });
  assert.throws(() => parseNews(one(without('url'))), { kind: 'news_url' });
  assert.throws(() => parseNews(one([...without('url'), 'url: "javascript:alert(1)"'])), { kind: 'news_url' });
  assert.throws(() => parseNews(one(without('date'))), { kind: 'news_date' });
  assert.throws(() => parseNews(one([...without('date'), 'date: "2026-11"'])), { kind: 'news_date' });
  assert.throws(() => parseNews(one([...without('date'), 'date: "2026-02-30"'])), { kind: 'news_date' });
  // 같은 사업·블록·주소가 두 번이면 멈춘다. 블록 표기만 다른 것(A1·A-1)도 같은 것으로 본다.
  const twice = `items:\n  - { ${base.map((l) => l.replace(': ', ': ')).join(', ')}, block: A1 }\n  - { ${base.join(', ')}, block: A-1 }\n`;
  assert.throws(() => parseNews(twice), { kind: 'news_duplicate' });
});

const towns = [
  {
    id: 'town-guri-galmae-station',
    region: '경기',
    blocks: [{ block: 'A-1', rental: false }, { block: 'A-1', rental: true }, { block: 'B-1', rental: false }],
    history: [{ block: 'A1' }],
    plans: [{ blocks: ['B2'] }],
  },
  { id: 'seoul-1673', region: '서울' },
];
const item = (extra) => ({
  projectId: 'town-guri-galmae-station', block: null, date: '2026-11-08', title: '요약', outlet: '매체', url: 'https://a.example/x', ...extra,
});

test('resolveNews checks the town and block and uses the town view block names', () => {
  const { items, skipped } = resolveNews([
    item({ block: 'A1' }), item({ block: 'b-1' }), item({ block: 'B-2' }), item({}), item({ projectId: 'seoul-1673' }), item({ projectId: 'seoul-9' }),
  ], towns);
  assert.deepEqual(items.map((i) => [i.projectId, i.block]), [
    ['town-guri-galmae-station', 'A-1'], ['town-guri-galmae-station', 'B-1'], ['town-guri-galmae-station', 'B2'],
    ['town-guri-galmae-station', null], ['seoul-1673', null],
  ]);
  // 서울 자료에서 빠진 사업의 기사는 건너뛰고 센다
  assert.equal(skipped, 1);
  assert.throws(() => resolveNews([item({ projectId: 'town-no-such' })], towns), { kind: 'news_town' });
  assert.throws(() => resolveNews([item({ block: 'Z-9' })], towns), { kind: 'news_block' });
  assert.throws(() => resolveNews([item({ projectId: 'seoul-1673', block: 'A1' })], towns), { kind: 'news_block' });
  assert.equal(canonicalBlock('', towns[0]), null);
  // 여러 블록 기사: '·'로 이은 블록이 모두 있어야 하고, 지구 표기로 바꿔 한 건으로 낸다
  assert.deepEqual(splitBlocks('A1 · B-1·'), ['A1', 'B-1']);
  assert.equal(resolveNews([item({ block: 'A1·b-1' })], towns).items[0].block, 'A-1·B-1');
  assert.throws(() => resolveNews([item({ block: 'A1·Z-9' })], towns), { kind: 'news_block' });
  assert.throws(() => resolveNews([item({ block: '·' })], towns), { kind: 'news_block' });
});

test('loadNews returns null when the file is missing', () => {
  assert.equal(loadNews('none.yaml', { exists: () => false }), null);
  assert.equal(loadNews('x.yaml', { exists: () => true, read: () => one(base) }).items.length, 1);
});

test('the real news.yaml resolves against the real newtowns.yaml', () => {
  const news = loadNews(new URL('../data/news.yaml', import.meta.url));
  const { projects } = loadNewtowns(new URL('../data/newtowns.yaml', import.meta.url));
  const withRows = projects.map((project) => withBlocks(project, today));
  const { items, skipped } = resolveNews(news.items, withRows);
  assert.equal(skipped, 0);
  assert.equal(items.length, news.items.length);
  assert.ok(items.every((i) => /^https?:\/\//.test(i.url) && i.date <= today && i.title.length > 0));
  // 지역지(하남일보·하남Times·시티뉴스)는 local
  assert.ok(items.filter((i) => ['하남일보', '하남Times'].includes(i.outlet)).every((i) => i.local));
  // 블록 표기는 지구 화면 줄 이름
  const galmaeBlocks = new Set(items.filter((i) => i.projectId === 'town-guri-galmae-station' && i.block).map((i) => i.block));
  assert.deepEqual([...galmaeBlocks].sort(), ['A-1', 'A-2', 'A-4', 'B-1', 'S-1']);
  assert.deepEqual(items.filter((i) => i.block === 'A9·A11').map((i) => [i.date, i.kind, i.local]), [['2026-03-08', '일정', true]]);
  const b1 = items.find((i) => i.url === 'https://www.straightnews.co.kr/news/articleView.html?idxno=314854');
  assert.deepEqual([b1.block, b1.date, b1.outlet, b1.local], ['B-1', '2026-11-08', '스트레이트뉴스', false]);
});
