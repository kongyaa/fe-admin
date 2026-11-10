import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WATCH_KINDS, loadNewtowns, parseNewtowns } from '../src/pipeline/newtowns.js';

const doc = (lines) => `asOf: "2026-11-10"
watchlist:
${lines.map((line) => `  - ${line}`).join('\n')}
towns:
  - { id: hanam-gyosan, name: 하남교산, district: 하남, stage: 블록별 분양 }
`;

test('watchlist: tracked towns point at a town project, untracked ones carry only name, kind and region', () => {
  const { watchlist } = parseNewtowns(doc([
    '{ name: 하남교산, kind: 3기 신도시, region: 경기, town: hanam-gyosan }',
    '{ name: 인천계양, kind: 3기 신도시, region: 인천, stage: 착공, note: 무시 }',
    '{ name: 어딘가, kind: 공공주택지구 }',
  ]));
  assert.deepEqual(watchlist, [
    {
      name: '하남교산', kind: '3기 신도시', region: '경기', tracked: true, projectId: 'town-hanam-gyosan',
    },
    // 모르는 키(stage, note)는 싣지 않는다
    {
      name: '인천계양', kind: '3기 신도시', region: '인천', tracked: false, projectId: null,
    },
    {
      name: '어딘가', kind: '공공주택지구', region: '경기', tracked: false, projectId: null,
    },
  ]);
});

test('watchlist errors', () => {
  assert.throws(() => parseNewtowns(doc(['{ name: 하남교산, kind: 3기 신도시, town: no-such-town }'])), { kind: 'newtowns_watchlist' });
  assert.throws(() => parseNewtowns(doc(['{ name: 하남교산, kind: 신도시 }'])), { kind: 'newtowns_field' });
  assert.throws(() => parseNewtowns(doc(['{ kind: 3기 신도시 }'])), { kind: 'newtowns_field' });
  assert.throws(() => parseNewtowns(doc(['그냥 글'])), { kind: 'newtowns_field' });
  assert.throws(() => parseNewtowns(doc(['{ name: 가, kind: 3기 신도시 }', '{ name: 가, kind: 공공주택지구 }'])), { kind: 'newtowns_duplicate' });
  assert.throws(() => parseNewtowns('towns: []\nwatchlist: 남양주왕숙'), { kind: 'newtowns_field' });
  assert.deepEqual(parseNewtowns('towns: []').watchlist, []);
});

test('the real watchlist: seven 3기 신도시 rows (왕숙·왕숙2 split) and the two 구리 공공주택지구, all tracked', () => {
  const { watchlist, projects } = loadNewtowns(new URL('../data/newtowns.yaml', import.meta.url));
  assert.deepEqual(WATCH_KINDS, ['3기 신도시', '공공주택지구']);
  assert.deepEqual(watchlist.map((w) => [w.name, w.kind, w.tracked, w.projectId]), [
    ['남양주왕숙', '3기 신도시', true, 'town-namyangju-wangsuk'],
    ['남양주왕숙2', '3기 신도시', true, 'town-namyangju-wangsuk2'],
    ['하남교산', '3기 신도시', true, 'town-hanam-gyosan'],
    ['고양창릉', '3기 신도시', true, 'town-goyang-changneung'],
    ['인천계양', '3기 신도시', true, 'town-incheon-gyeyang'],
    ['부천대장', '3기 신도시', true, 'town-bucheon-daejang'],
    ['광명시흥', '3기 신도시', true, 'town-gwangmyeong-siheung'],
    ['구리갈매역세권', '공공주택지구', true, 'town-guri-galmae-station'],
    ['구리토평한강', '공공주택지구', true, 'town-guri-topyeong-hangang'],
  ]);
  const ids = new Set(projects.map((p) => p.id));
  assert.ok(watchlist.filter((w) => w.tracked).every((w) => ids.has(w.projectId)));
  assert.equal(watchlist.find((w) => w.name === '인천계양').region, '인천');
});
