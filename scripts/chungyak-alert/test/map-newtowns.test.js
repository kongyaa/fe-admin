import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOWN_STAGES, loadNewtowns, parseNewtowns, townDate, townDistrict, townToProject } from '../src/pipeline/newtowns.js';

const VALID = `
asOf: "2026-11-10"
towns:
  - id: hanam-gyosan
    name: 하남교산
    region: 경기
    district: 하남
    kind: 공공주택지구
    stage: 지구계획승인
    stageDates:
      지구지정: "2019-10"
      지구계획승인: "2021-08-26"
    households: 33000
    noticeMatch: [교산]
    expected:
      from: "2029-06"
      to: "2031-06-30"
      basis: "LH 계획"
    notes: 메모
    sources:
      - title: 기사
        url: https://example.com/a
        date: "2025-12-31"
      - title: 위험한 링크
        url: javascript:alert(1)
  - id: empty-fields
    name: 빈칸지구
    district: 구리시
    stage: 후보지
    stageDates:
    households:
    noticeMatch:
    expected:
    notes:
    sources:
`;

const withTown = (lines) => `asOf: "2026-11-10"\ntowns:\n  - id: t1\n    name: 시험\n    district: 하남\n${lines}\n`;

test('a valid file is parsed and normalized', () => {
  const { asOf, towns } = parseNewtowns(VALID);
  assert.equal(asOf, '2026-11-10');
  assert.equal(towns.length, 2);
  const [gyosan, empty] = towns;
  assert.equal(gyosan.district, '하남시');
  assert.deepEqual(gyosan.stageDates, { 지구지정: '2019-10', 지구계획승인: '2021-08-26' });
  assert.deepEqual(gyosan.expected, { from: '2029-06', to: '2031-06', basis: 'LH 계획' });
  assert.deepEqual(gyosan.sources, [{ title: '기사', url: 'https://example.com/a', date: '2025-12-31' }]);
  assert.deepEqual(gyosan.noticeMatch, ['교산']);

  // 빈 필드는 허용한다.
  assert.deepEqual(empty, {
    id: 'empty-fields',
    name: '빈칸지구',
    region: '경기',
    district: '구리시',
    kind: '공공주택지구',
    stage: '후보지',
    stageDates: {},
    households: null,
    noticeMatch: [],
    expected: null,
    notes: null,
    sources: [],
  });
});

test('towns become map projects', () => {
  const { asOf, towns } = parseNewtowns(VALID);
  const project = townToProject(towns[0], asOf);
  assert.equal(project.id, 'town-hanam-gyosan');
  assert.equal(project.kind, '공공주택지구');
  assert.equal(project.region, '경기');
  assert.equal(project.district, '하남시');
  assert.equal(project.stage, '지구계획승인');
  assert.equal(project.stageIndex, TOWN_STAGES.indexOf('지구계획승인'));
  assert.equal(project.households, 33000);
  assert.equal(project.asOf, '2026-11-10');
  assert.deepEqual(project.notices, []);
  assert.equal(project.live, false);
});

test('unknown stage names are rejected', () => {
  assert.throws(() => parseNewtowns(withTown('    stage: 착공')), { kind: 'newtowns_stage' });
  assert.throws(() => parseNewtowns(withTown('    stage:')), { kind: 'newtowns_stage' });
  assert.throws(() => parseNewtowns(withTown('    stage: 후보지\n    stageDates:\n      부지착공: "2026-01"')), { kind: 'newtowns_stage' });
});

test('bad dates are rejected', () => {
  assert.throws(() => parseNewtowns(withTown('    stage: 지구지정\n    stageDates:\n      지구지정: "2026-13"')), { kind: 'newtowns_date' });
  assert.throws(() => parseNewtowns(withTown('    stage: 지구지정\n    stageDates:\n      지구지정: "2026-02-30"')), { kind: 'newtowns_date' });
  assert.throws(() => parseNewtowns(withTown('    stage: 지구지정\n    stageDates:\n      지구지정: 내년')), { kind: 'newtowns_date' });
  assert.throws(() => parseNewtowns(withTown('    stage: 지구지정\n    expected:\n      from: "2031-01"\n      to: "2029-01"')), { kind: 'newtowns_date' });
});

test('structural errors have their own kinds', () => {
  assert.throws(() => parseNewtowns('towns: [a, b'), { kind: 'newtowns_yaml' });
  assert.throws(() => parseNewtowns('- just a list'), { kind: 'newtowns_shape' });
  assert.throws(() => parseNewtowns('towns: nope'), { kind: 'newtowns_field' });
  assert.throws(() => parseNewtowns('towns:\n  - name: 이름만\n    stage: 후보지'), { kind: 'newtowns_field' });
  assert.throws(() => parseNewtowns('towns:\n  - id: Bad Id\n    name: x\n    stage: 후보지'), { kind: 'newtowns_field' });
  assert.throws(() => parseNewtowns('towns:\n  - id: a\n    name: x\n    stage: 후보지\n  - id: a\n    name: y\n    stage: 후보지'), { kind: 'newtowns_duplicate' });
  assert.throws(() => parseNewtowns(withTown('    stage: 후보지\n    households: 많음')), { kind: 'newtowns_field' });
});

test('an empty town list is fine', () => {
  assert.deepEqual(parseNewtowns('asOf: "2026-11-10"\ntowns: []'), { asOf: '2026-11-10', towns: [] });
});

test('date and district helpers', () => {
  assert.equal(townDate('2026-05'), '2026-05');
  assert.equal(townDate('2026-05-31'), '2026-05-31');
  assert.equal(townDate(new Date('2026-05-31T00:00:00Z')), '2026-05-31');
  assert.equal(townDate(''), null);
  assert.equal(townDistrict('하남'), '하남시');
  assert.equal(townDistrict('구리시'), '구리시');
  assert.equal(townDistrict('계양구'), '계양구');
});

test('a missing file is skipped, not an error', () => {
  assert.equal(loadNewtowns('none.yaml', { exists: () => false }), null);
  const loaded = loadNewtowns('x.yaml', { exists: () => true, read: () => VALID });
  assert.deepEqual(loaded.projects.map((p) => p.id), ['town-hanam-gyosan', 'town-empty-fields']);
});
