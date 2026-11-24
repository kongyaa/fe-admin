import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProperties, createNotionStore, parseExistingPage } from '../src/notion-store.js';

// 청약 등급 열의 이름 변경과 선택지 색, 쓰기와 읽기. Notion 가짜는 속성 이름 변경(id 유지)과 선택지 교체를 흉내 낸다.
const THU = '2026-11-05';
const noSleep = async () => {};
const GRADES = ['로또청약', '고려', '안전마진 없음', '패스', '판정 보류'];
const COLORS = { 로또청약: 'orange', 고려: 'green', '안전마진 없음': 'yellow', 패스: 'red', '판정 보류': 'gray' };
const NEW_OPTIONS = GRADES.map((name) => ({ name, color: COLORS[name] }));

// 배치가 이 테스트에서 건드리지 않게 다른 열은 모두 갖춘 스키마다.
const OTHERS = {
  '안전 마진': { type: 'number', number: {} },
  마진율: { type: 'number', number: {} },
  '시세 신뢰도': { type: 'select', select: {} },
  '평균 분양가': { type: 'number', number: {} },
  '추천 전형': { type: 'select', select: {} },
  '추천 접수일': { type: 'date', date: {} },
  '최저 분양가': { type: 'number', number: {} },
  '주택형별 분양가': { type: 'rich_text', rich_text: {} },
  '판단 주택형(㎡)': { type: 'number', number: {} },
  '접수 상태': { type: 'select', select: {} },
  '역 도보(분)': { type: 'number', number: {} },
  관심: { type: 'checkbox', checkbox: {} },
};

// 사용자의 옛 `로또 여부` 열: id가 있고, 사용자가 색을 바꾼 선택지가 있다.
const legacyColumn = () => ({
  id: 'prop-id-1',
  type: 'select',
  select: {
    options: [
      { id: 'o1', name: '로또', color: 'blue' },
      { id: 'o2', name: '아님', color: 'default' },
      { id: 'o3', name: '판별 불가', color: 'gray' },
      { id: 'o4', name: '대상 외', color: 'brown' },
      { id: 'o5', name: '확인 필요', color: 'yellow' },
    ],
  },
});

function schemaFake(initial, { intercept = () => null } = {}) {
  const calls = [];
  const state = { properties: structuredClone(initial) };
  const children = [
    { id: 'db', type: 'child_database', child_database: { title: '청약 정보' } },
    { id: 'src', type: 'child_page', child_page: { title: '청약 수집 소스' } },
  ];
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname.replace('/v1', '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path, body });
    const replaced = intercept({ method: init.method, path, body });
    if (replaced) return replaced;
    if (init.method === 'GET' && path.startsWith('/blocks/')) return Response.json({ results: children, has_more: false });
    if (init.method === 'GET' && path === '/databases/db') return Response.json({ id: 'db', properties: state.properties });
    if (init.method === 'PATCH' && path === '/databases/db') {
      for (const [name, change] of Object.entries(body.properties)) {
        if (change.name) {
          // 실제 Notion처럼 이름이 겹치면 거절한다. 이름만 바뀌고 id와 선택지는 그대로다.
          if (state.properties[change.name]) return new Response('', { status: 400 });
          state.properties[change.name] = state.properties[name];
          delete state.properties[name];
        } else if (change.select && state.properties[name]) {
          // 선택지 목록은 보낸 것으로 교체된다. 보내지 않은 선택지는 지워진다.
          state.properties[name] = { ...state.properties[name], select: change.select };
        } else {
          state.properties[name] = { type: Object.keys(change)[0], ...change };
        }
      }
      return Response.json({ id: 'db' });
    }
    if (path.endsWith('/query')) return Response.json({ has_more: false, results: [] });
    return Response.json({ id: 'page' });
  };
  return { calls, fetch, state };
}

const CONFIG = { notion: { databaseTitle: '청약 정보', sourcesPageTitle: '청약 수집 소스' } };
const storeOf = (fake) => createNotionStore({ key: 'k', parentPageId: 'parent', config: CONFIG, sources: [], fetch: fake.fetch, minIntervalMs: 0, sleep: noSleep });
const schemaPatches = (fake) => fake.calls.filter((call) => call.method === 'PATCH' && call.path === '/databases/db').map((call) => call.body.properties);
const rowWrite = (fake) => fake.calls.find((call) => call.method === 'POST' && call.path === '/pages');
const notice = { key: '1-1', name: '합성', region: '서울', typeLabel: 'APT', source: '청약홈', url: 'https://www.applyhome.co.kr/a', stages: [] };

test('rename: 로또 여부 exists and 청약 등급 does not: renamed by name, id and old options kept, new options added with colors', async () => {
  const fake = schemaFake({ ...OTHERS, '로또 여부': legacyColumn() });
  const store = storeOf(fake);
  await store.init();
  const patches = schemaPatches(fake);
  assert.equal(patches.length, 2);
  // 1) 이름만 바꾼다(옵션 없음). 2) 기존 선택지를 id, name, color 그대로 모두 보내고 없는 등급만 색과 함께 더한다.
  assert.deepEqual(patches[0], { '로또 여부': { name: '청약 등급' } });
  assert.deepEqual(patches[1], {
    '청약 등급': {
      select: {
        options: [
          { id: 'o1', name: '로또', color: 'blue' },
          { id: 'o2', name: '아님', color: 'default' },
          { id: 'o3', name: '판별 불가', color: 'gray' },
          { id: 'o4', name: '대상 외', color: 'brown' },
          { id: 'o5', name: '확인 필요', color: 'yellow' },
          ...NEW_OPTIONS,
        ],
      },
    },
  });
  // 같은 속성이다: id가 그대로이고 옛 선택지가 하나도 지워지지 않았다.
  assert.equal(fake.state.properties['로또 여부'], undefined);
  assert.equal(fake.state.properties['청약 등급'].id, 'prop-id-1');
  assert.deepEqual(fake.state.properties['청약 등급'].select.options.map((option) => option.name), ['로또', '아님', '판별 불가', '대상 외', '확인 필요', ...GRADES]);
  assert.deepEqual(store.schemaIssues(), []);
  // 이번 실행은 새 이름으로 쓴다.
  await store.upsert(notice, { status: '아님', grade: '고려', reason: 'r' }, undefined, THU);
  const written = rowWrite(fake).body.properties;
  assert.deepEqual(written['청약 등급'], { select: { name: '고려' } });
  assert.equal(Object.hasOwn(written, '로또 여부'), false);
});

test('rename: a second run, and a database already renamed with every grade option, make no schema call', async () => {
  const fake = schemaFake({ ...OTHERS, '로또 여부': legacyColumn() });
  await storeOf(fake).init();
  const before = schemaPatches(fake).length;
  await storeOf(fake).init();
  assert.equal(schemaPatches(fake).length, before);

  // 사용자가 색을 바꿔 둔 등급 선택지는 되돌리지 않는다.
  const recolored = schemaFake({ ...OTHERS, '청약 등급': { id: 'p', type: 'select', select: { options: GRADES.map((name) => ({ id: name, name, color: 'purple' })) } } });
  const store = storeOf(recolored);
  await store.init();
  assert.deepEqual(schemaPatches(recolored), []);
  assert.deepEqual(store.schemaIssues(), []);
});

test('rename: an existing 청약 등급 column missing some grade options gets only those added, keeping every existing option', async () => {
  const fake = schemaFake({ ...OTHERS, '청약 등급': { id: 'p', type: 'select', select: { options: [{ id: 'a', name: '고려', color: 'pink' }, { id: 'b', name: '내가 만든 값', color: 'brown' }] } } });
  await storeOf(fake).init();
  assert.deepEqual(schemaPatches(fake), [{
    '청약 등급': {
      select: {
        options: [
          { id: 'a', name: '고려', color: 'pink' },
          { id: 'b', name: '내가 만든 값', color: 'brown' },
          ...NEW_OPTIONS.filter((option) => option.name !== '고려'),
        ],
      },
    },
  }]);
});

test('rename: neither column exists: the column is added with the five colored options', async () => {
  const fake = schemaFake({ ...OTHERS });
  const store = storeOf(fake);
  await store.init();
  assert.deepEqual(schemaPatches(fake), [{ '청약 등급': { select: { options: NEW_OPTIONS } } }]);
  await store.upsert(notice, { status: '로또', grade: '로또청약', reason: 'r' }, undefined, THU);
  assert.deepEqual(rowWrite(fake).body.properties['청약 등급'], { select: { name: '로또청약' } });
});

test('rename: both names present never renames onto the existing one; the new column is written and the old one is left alone', async () => {
  const fake = schemaFake({ ...OTHERS, '로또 여부': legacyColumn(), '청약 등급': { type: 'select', select: { options: GRADES.map((name) => ({ name })) } } });
  const store = storeOf(fake);
  await store.init();
  assert.deepEqual(schemaPatches(fake), []);
  await store.upsert(notice, { status: '아님', grade: '패스', reason: 'r' }, undefined, THU);
  const written = rowWrite(fake).body.properties;
  assert.deepEqual(written['청약 등급'], { select: { name: '패스' } });
  assert.equal(Object.hasOwn(written, '로또 여부'), false);
  assert.equal(fake.state.properties['로또 여부'].id, 'prop-id-1');
});

test('rename: a 청약 등급 property of another type is left alone and not written, and 로또 여부 is not renamed onto it', async () => {
  const fake = schemaFake({ ...OTHERS, '로또 여부': legacyColumn(), '청약 등급': { type: 'rich_text', rich_text: {} } });
  const store = storeOf(fake);
  await store.init();
  assert.deepEqual(schemaPatches(fake), []);
  await store.upsert(notice, { status: '아님', grade: '패스', reason: 'r' }, undefined, THU);
  const written = rowWrite(fake).body.properties;
  assert.equal(Object.hasOwn(written, '청약 등급'), false);
  assert.equal(Object.hasOwn(written, '로또 여부'), false);
  // 같은 이름의 다른 타입 값은 읽지 않는다.
  assert.equal(parseExistingPage({ id: 'p', properties: { '청약 등급': { rich_text: [] } } }).lotto, null);
});

test('rename: a 로또 여부 property of another type is not renamed; the new column is added instead', async () => {
  const fake = schemaFake({ ...OTHERS, '로또 여부': { type: 'rich_text', rich_text: {} } });
  await storeOf(fake).init();
  assert.deepEqual(schemaPatches(fake), [{ '청약 등급': { select: { options: NEW_OPTIONS } } }]);
  assert.equal(fake.state.properties['로또 여부'].type, 'rich_text');
});

test('rename failure: writes keep going under 로또 여부, the issue is reported once and no color call is tried', async () => {
  const fake = schemaFake({ ...OTHERS, '로또 여부': legacyColumn() }, {
    intercept: (call) => (call.method === 'PATCH' && call.path === '/databases/db' ? new Response('body-secret', { status: 403 }) : null),
  });
  const store = storeOf(fake);
  await store.init();
  assert.deepEqual(store.schemaIssues(), ['notion_rename_failed']);
  assert.equal(schemaPatches(fake).length, 1);
  await store.upsert(notice, { status: '아님', grade: '고려', reason: 'r' }, undefined, THU);
  const written = rowWrite(fake).body.properties;
  assert.deepEqual(written['로또 여부'], { select: { name: '고려' } });
  assert.equal(Object.hasOwn(written, '청약 등급'), false);
});

test('color failure: the rename stays, writes use the new name, and the issue names the options call only', async () => {
  const fake = schemaFake({ ...OTHERS, '로또 여부': legacyColumn() }, {
    intercept: (call) => (call.method === 'PATCH' && call.path === '/databases/db' && call.body.properties['청약 등급'] ? new Response('', { status: 400 }) : null),
  });
  const store = storeOf(fake);
  await store.init();
  assert.deepEqual(store.schemaIssues(), ['notion_grade_options_failed']);
  assert.equal(fake.state.properties['청약 등급'].id, 'prop-id-1');
  assert.deepEqual(fake.state.properties['청약 등급'].select.options.map((option) => option.name), ['로또', '아님', '판별 불가', '대상 외', '확인 필요']);
  await store.upsert(notice, { status: '로또', grade: '로또청약', reason: 'r' }, undefined, THU);
  assert.deepEqual(rowWrite(fake).body.properties['청약 등급'], { select: { name: '로또청약' } });
});

test('a failed schema read writes no grade column, and createMissing false leaves the schema alone', async () => {
  const unread = schemaFake({ ...OTHERS, '로또 여부': legacyColumn() }, {
    intercept: (call) => (call.method === 'GET' && call.path === '/databases/db' ? new Response('', { status: 403 }) : null),
  });
  const store = storeOf(unread);
  await store.init();
  assert.deepEqual(store.schemaIssues(), ['notion_schema_read_failed']);
  await store.upsert(notice, { status: '아님', grade: '고려', reason: 'r' }, undefined, THU);
  const written = rowWrite(unread).body.properties;
  assert.equal(Object.hasOwn(written, '청약 등급'), false);
  assert.equal(Object.hasOwn(written, '로또 여부'), false);

  const readOnly = schemaFake({ ...OTHERS, '로또 여부': legacyColumn() });
  await storeOf(readOnly).init({ createMissing: false });
  assert.deepEqual(schemaPatches(readOnly), []);
});

test('a new database is created with 청약 등급 and its five colored options, and not with 로또 여부', async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname.replace('/v1', '');
    calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'GET' && path.startsWith('/blocks/')) return Response.json({ results: [], has_more: false });
    if (path === '/databases') return Response.json({ id: 'db' });
    return Response.json({ id: 'x' });
  };
  await createNotionStore({ key: 'k', parentPageId: 'parent', config: CONFIG, sources: [], fetch, minIntervalMs: 0, sleep: noSleep }).init();
  const created = calls.find((call) => call.path === '/databases').body.properties;
  assert.deepEqual(created['청약 등급'], { select: { options: NEW_OPTIONS } });
  assert.equal(Object.hasOwn(created, '로또 여부'), false);
});

test('written values: each grade as is, internal statuses without a grade map to 판정 보류, a row not re-judged keeps its stored value', () => {
  const grade = (evaluation) => buildProperties(notice, evaluation, THU)['청약 등급'];
  for (const name of GRADES) assert.deepEqual(grade({ status: '아님', grade: name }), { select: { name } });
  // 계산한 등급이 우선이다. 확인 필요도 근거가 약하지 않으면 마진율로 정한 등급이다.
  assert.deepEqual(grade({ status: '확인 필요', grade: '안전마진 없음' }), { select: { name: '안전마진 없음' } });
  // 등급 없이 내부 판정만 오면 판별 불가, 대상 외, 확인 필요는 판정 보류, 로또는 로또청약이다.
  for (const status of ['판별 불가', '대상 외', '확인 필요']) assert.deepEqual(grade({ status }), { select: { name: '판정 보류' } }, status);
  assert.deepEqual(grade({ status: '로또' }), { select: { name: '로또청약' } });
  // 아님은 어느 등급인지 몰라 보내지 않는다. 다시 판정하지 않은 행(평가 없음)도 보내지 않아 옛 값이 남는다.
  assert.equal(grade({ status: '아님' }), undefined);
  assert.equal(grade(null), undefined);
  // 열을 쓸 수 없으면(없음, 다른 타입) 보내지 않는다.
  assert.equal(Object.hasOwn(buildProperties(notice, { status: '로또', grade: '로또청약' }, THU, { margin: null, marginRate: null, confidence: null, grade: null }), '청약 등급'), false);
  // 이름 변경이 실패한 실행의 열 이름
  assert.deepEqual(buildProperties(notice, { status: '로또', grade: '고려' }, THU, { margin: null, marginRate: null, confidence: null, grade: '로또 여부' })['로또 여부'], { select: { name: '고려' } });
});

test('reading rows: the new column, the legacy column and legacy values all give the internal status that alerts and demotion counts use', () => {
  const read = (properties) => parseExistingPage({ id: 'p', properties });
  const select = (name) => ({ select: { name } });
  // 새 열: 로또청약과 옛 값 로또는 로또다. 그 밖의 등급은 로또가 아니다.
  assert.equal(read({ '청약 등급': select('로또청약') }).lotto, '로또');
  assert.equal(read({ '청약 등급': select('로또') }).lotto, '로또');
  for (const name of ['고려', '안전마진 없음', '패스']) assert.equal(read({ '청약 등급': select(name) }).lotto, '아님', name);
  assert.equal(read({ '청약 등급': select('판정 보류') }).lotto, '판별 불가');
  // 옛 열(이름 변경 전, 또는 변경이 실패한 DB)
  for (const name of ['로또', '아님', '확인 필요', '판별 불가', '대상 외']) assert.equal(read({ '로또 여부': select(name) }).lotto, name, name);
  assert.equal(read({ '로또 여부': select('로또') }).grade, '로또청약');
  assert.equal(read({ '로또 여부': select('확인 필요') }).grade, '판정 보류');
  assert.equal(read({ '로또 여부': select('아님') }).grade, null);
  // 둘 다 있으면 새 열이 먼저다. 모르는 값과 빈 값은 null이다.
  assert.equal(read({ '청약 등급': select('고려'), '로또 여부': select('로또') }).lotto, '아님');
  assert.equal(read({ '청약 등급': { select: null } }).lotto, null);
  assert.equal(read({ '청약 등급': select('엉뚱한 값') }).lotto, null);
  assert.equal(read({}).grade, null);
});
