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
    history: [],
    plans: [],
    blocks: [],
    blockTotal: null,
  });
});

const BLOCKS = withTown(`    stage: 블록별 분양
    history:
      - block: A2
        type: 공공분양
        stage: 사전청약
        households: 1056
        noticeDate: "2021-11-18"
        source: { title: 사전청약 기사, url: "https://example.com/pre", date: "2021-11-17" }
      - block: B-1
        type: 민간분양
        households: 213
        noticeDate: "2026-10-30"
        end: "2026-11-11"
        source: { title: 청약홈, outlet: 청약홈, url: "https://example.com/b1", date: "2026-10-30" }
      - block: A2
        type: 공공분양
        households: "1,115"
        noticeDate: "2025-03-31"
        stage: 본청약
        title: 교산 푸르지오 더 퍼스트
        moveIn: "2029-06"
        unknownKey: 무시
        source:
          - { title: LH 공고, url: "https://example.com/lh", date: "2025-03-31" }
          - { title: 나쁜 링크, url: "javascript:alert(1)" }
          - { title: 기사, url: "https://example.com/news", date: "2025-03-31" }
      - block: A-4
        type: 공공임대
        rental: true
        noticeDate: "2025-12"
        source: { url: "https://example.com/a4" }
    plans:
      - blocks: [A5]
        expected: "2027-09"
        source: { title: 일정표, url: "https://example.com/plan", date: "" }
      - blocks: [A9, A11]
        type: 공공분양
        households: { A9: 244, A11: 511 }
        expected: "2026-하반기"
        note: 지역 매체 보도
        source: { title: "기사 (하남Times)", url: "http://example.com/times", date: "2025-12-13" }
      - blocks: D2
        rental: false
        households: { D2: 100, D5: }
        expected: "2026-상반기"
        source: { url: "https://example.com/d" }`);

test('block history (사전청약·본청약) and plans are validated and sorted by date', () => {
  const [town] = parseNewtowns(BLOCKS).towns;
  assert.deepEqual(town.history[0], {
    block: 'A2', stage: '사전청약', type: '공공분양', title: null, households: 1056, noticeDate: '2021-11-18', end: null, rental: false, note: null,
    sources: [{ title: '사전청약 기사', url: 'https://example.com/pre', date: '2021-11-17' }],
  });
  // stage를 비우면 본청약
  assert.deepEqual(town.history.map((entry) => [entry.block, entry.stage, entry.noticeDate, entry.rental]), [
    ['A2', '사전청약', '2021-11-18', false], ['A2', '본청약', '2025-03-31', false],
    ['A-4', '본청약', '2025-12', true], ['B-1', '본청약', '2026-10-30', false],
  ]);
  const a2 = town.history[1];
  assert.equal(a2.households, 1115);
  assert.equal(a2.moveIn, '2029-06');
  assert.equal(a2.title, '교산 푸르지오 더 퍼스트');
  assert.equal('unknownKey' in a2, false);
  // 출처는 하나 또는 목록, http(s)만 남긴다
  assert.deepEqual(a2.sources.map((source) => source.url), ['https://example.com/lh', 'https://example.com/news']);
  assert.equal('moveIn' in town.history[2], false);
  assert.deepEqual(town.history[2].sources, [{ title: 'https://example.com/a4', url: 'https://example.com/a4', date: null }]);
  assert.equal(town.history[3].sources[0].outlet, '청약홈');
  // 접수 마감(end)은 선택. 적으면 그대로, 없으면 null
  assert.deepEqual(town.history.map((entry) => entry.end), [null, null, null, '2026-11-11']);

  assert.deepEqual(town.plans.map((plan) => [plan.blocks, plan.expected, plan.from, plan.to]), [
    [['D2'], '2026-상반기', '2026-01', '2026-06'],
    [['A9', 'A11'], '2026-하반기', '2026-07', '2026-12'],
    [['A5'], '2027-09', '2027-09', '2027-09'],
  ]);
  const [d2, a9] = town.plans;
  assert.deepEqual([d2.households, d2.householdsByBlock], [null, { D2: 100, D5: null }]);
  assert.deepEqual([a9.households, a9.householdsByBlock, a9.note, a9.rental], [755, { A9: 244, A11: 511 }, '지역 매체 보도', false]);
  assert.equal(town.plans[2].sources[0].date, null);
});

test('history and plans pass through to the project, always as arrays', () => {
  const { asOf, towns } = parseNewtowns(BLOCKS);
  const project = townToProject(towns[0], asOf);
  assert.deepEqual(project.history, towns[0].history);
  assert.deepEqual(project.plans, towns[0].plans);
  const plain = townToProject(parseNewtowns(VALID).towns[0], asOf);
  assert.deepEqual([plain.history, plain.plans], [[], []]);
});

test('bad block entries stop the build', () => {
  const entry = (list, lines) => withTown(`    stage: 블록별 분양\n    ${list}:\n      - ${lines.join('\n        ')}`);
  const src = 'source: { url: "https://example.com/a" }';
  // 날짜 형식
  assert.throws(() => parseNewtowns(entry('history', ['block: A1', 'noticeDate: "2025-13"', src])), { kind: 'newtowns_date' });
  assert.throws(() => parseNewtowns(entry('history', ['block: A1', 'noticeDate: 2025', src])), { kind: 'newtowns_date' });
  assert.throws(() => parseNewtowns(entry('history', ['block: A1', 'noticeDate: "2025-03-01"', 'moveIn: 내년', src])), { kind: 'newtowns_date' });
  assert.throws(() => parseNewtowns(entry('plans', ['blocks: [A1]', 'expected: "2026-3분기"', src])), { kind: 'newtowns_date' });
  // 접수 마감(end)은 일까지 있는 날짜만, 공고일보다 앞이면 안 된다
  assert.throws(() => parseNewtowns(entry('history', ['block: A1', 'noticeDate: "2026-10-30"', 'end: "2026-11"', src])), { kind: 'newtowns_date' });
  assert.throws(() => parseNewtowns(entry('history', ['block: A1', 'noticeDate: "2026-10-30"', 'end: 마감', src])), { kind: 'newtowns_date' });
  assert.throws(() => parseNewtowns(entry('history', ['block: A1', 'noticeDate: "2026-10-30"', 'end: "2026-10-29"', src])), { kind: 'newtowns_field' });
  assert.equal(parseNewtowns(entry('history', ['block: A1', 'noticeDate: "2026-10"', 'end: "2026-10-05"', src])).towns[0].history[0].end, '2026-10-05');
  assert.throws(() => parseNewtowns(entry('plans', ['blocks: [A1]', 'expected: "2026"', src])), { kind: 'newtowns_date' });
  assert.throws(() => parseNewtowns(entry('plans', ['blocks: [A1]', 'expected: "2026-00"', src])), { kind: 'newtowns_date' });
  // 필수 값
  assert.throws(() => parseNewtowns(entry('history', ['noticeDate: "2021-11-18"', src])), { kind: 'newtowns_field' });
  // 구분은 본청약·사전청약만
  assert.throws(() => parseNewtowns(entry('history', ['block: A1', 'stage: 무순위', 'noticeDate: "2025-03"', src])), { kind: 'newtowns_field' });
  // 예전 키 preSubscriptions는 조용히 빠지지 않게 멈춘다
  assert.throws(() => parseNewtowns(entry('preSubscriptions', ['block: A1', 'noticeDate: "2021-11-18"', src])), { kind: 'newtowns_field' });
  assert.throws(() => parseNewtowns(entry('history', ['block: A1', src])), { kind: 'newtowns_field' });
  assert.throws(() => parseNewtowns(entry('plans', ['blocks: []', 'expected: "2026-07"', src])), { kind: 'newtowns_field' });
  assert.throws(() => parseNewtowns(entry('plans', ['blocks: [A1]', src])), { kind: 'newtowns_field' });
  assert.throws(() => parseNewtowns(entry('history', ['block: A1', 'noticeDate: "2025-03"', 'rental: 예', src])), { kind: 'newtowns_field' });
  assert.throws(() => parseNewtowns(withTown('    stage: 블록별 분양\n    history: 없음')), { kind: 'newtowns_field' });
  assert.throws(() => parseNewtowns(withTown('    stage: 블록별 분양\n    plans:\n      - 그냥 글')), { kind: 'newtowns_field' });
  // 출처가 없거나 http(s)가 아니면 newtowns_source
  assert.throws(() => parseNewtowns(entry('history', ['block: A1', 'noticeDate: "2025-03"'])), { kind: 'newtowns_source' });
  assert.throws(() => parseNewtowns(entry('history', ['block: A1', 'noticeDate: "2025-03"', 'source: { url: "javascript:alert(1)" }'])), { kind: 'newtowns_source' });
  assert.throws(() => parseNewtowns(entry('plans', ['blocks: [A1]', 'expected: "2026-07"', 'source: { title: 주소 없음 }'])), { kind: 'newtowns_source' });
});

test('blocks and blockTotal are parsed, checked and passed to the project', () => {
  const { asOf, towns } = parseNewtowns(withTown(`    stage: 블록별 분양
    blockTotal:
      total: 39
      approved: "16"
      date: "2025-11-24"
      source: { title: "기사 (시티뉴스)", url: "http://example.com/ct", date: "2025-11-24" }
    blocks:
      - { block: A5, type: 공공분양, households: "492", status: 사업승인, statusDate: "2025-11", sources: { url: "https://example.com/a5" }, extra: 무시 }
      - block: A3
        rental: true
        status: 사업승인
        statusDate: "2026-04-23"
        note: 메모
        source:
          - { title: 나쁜 링크, url: "javascript:alert(1)" }
          - { title: 기사, outlet: 글로벌이코노믹, url: "https://example.com/a3", date: "2026-04-27" }
      - { block: S-1, households: 734, sources: { url: "https://example.com/s1" } }
      - { block: A-5, rental: true, status: 계획 보도, sources: { url: "https://example.com/a5r" } }`));
  const [town] = towns;
  assert.deepEqual(town.blocks[0], {
    block: 'A5', type: '공공분양', households: 492, rental: false, status: '사업승인', statusDate: '2025-11', note: null,
    sources: [{ title: 'https://example.com/a5', url: 'https://example.com/a5', date: null }],
  });
  assert.deepEqual(town.blocks[1].sources, [{ title: '기사', url: 'https://example.com/a3', date: '2026-04-27', outlet: '글로벌이코노믹' }]);
  assert.deepEqual([town.blocks[1].rental, town.blocks[1].note], [true, '메모']);
  // 상태를 비우면 미정, 유형을 비우면 null
  assert.deepEqual([town.blocks[2].status, town.blocks[2].type, town.blocks[2].statusDate], ['미정', null, null]);
  // 같은 블록이라도 분양 줄과 임대 줄은 따로 적을 수 있다
  assert.equal(town.blocks[3].block, 'A-5');
  assert.deepEqual(town.blockTotal, {
    total: 39, approved: 16, date: '2025-11-24', sources: [{ title: '기사 (시티뉴스)', url: 'http://example.com/ct', date: '2025-11-24' }],
  });
  const project = townToProject(town, asOf);
  assert.deepEqual([project.blockEntries, project.blockTotal], [town.blocks, town.blockTotal]);
  const plain = parseNewtowns(VALID).towns[0];
  assert.deepEqual([plain.blocks, plain.blockTotal], [[], null]);
  assert.deepEqual([townToProject(plain, asOf).blockEntries, townToProject(plain, asOf).blockTotal], [[], null]);
});

test('bad blocks and blockTotal stop the build', () => {
  const block = (lines) => withTown(`    stage: 블록별 분양\n    blocks:\n      - ${lines.join('\n        ')}`);
  const src = 'sources: { url: "https://example.com/a" }';
  assert.throws(() => parseNewtowns(block(['type: 공공분양', src])), { kind: 'newtowns_field' });
  assert.throws(() => parseNewtowns(block(['block: A1', 'status: 분양', src])), { kind: 'newtowns_field' });
  assert.throws(() => parseNewtowns(block(['block: A1', 'status: 사업승인', 'statusDate: "2025-11-31"', src])), { kind: 'newtowns_date' });
  assert.throws(() => parseNewtowns(block(['block: A1', 'statusDate: 작년', src])), { kind: 'newtowns_date' });
  assert.throws(() => parseNewtowns(block(['block: A1', 'rental: 네', src])), { kind: 'newtowns_field' });
  assert.throws(() => parseNewtowns(block(['block: A1', 'households: 많음', src])), { kind: 'newtowns_field' });
  assert.throws(() => parseNewtowns(block(['block: A1'])), { kind: 'newtowns_source' });
  assert.throws(() => parseNewtowns(block(['block: A1', 'sources: { url: "ftp://example.com/a" }'])), { kind: 'newtowns_source' });
  assert.throws(() => parseNewtowns(withTown('    stage: 블록별 분양\n    blocks: 많음')), { kind: 'newtowns_field' });
  // 같은 블록의 분양 줄(또는 임대 줄)이 두 번이면 멈춘다. 'A-1'과 'A1'은 같은 블록
  assert.throws(() => parseNewtowns(withTown(`    stage: 블록별 분양\n    blocks:\n      - { block: A-1, ${src} }\n      - { block: A1BL, ${src} }`)),
    { kind: 'newtowns_duplicate' });
  const total = (lines) => withTown(`    stage: 블록별 분양\n    blockTotal:\n      ${lines.join('\n      ')}`);
  assert.throws(() => parseNewtowns(total(['approved: 3', src])), { kind: 'newtowns_field' });
  assert.throws(() => parseNewtowns(total(['total: 10', 'approved: 11', src])), { kind: 'newtowns_field' });
  assert.throws(() => parseNewtowns(total(['total: 10.5', src])), { kind: 'newtowns_field' });
  assert.throws(() => parseNewtowns(total(['total: 10', 'date: 작년', src])), { kind: 'newtowns_date' });
  assert.throws(() => parseNewtowns(total(['total: 10'])), { kind: 'newtowns_source' });
  assert.throws(() => parseNewtowns(withTown('    stage: 블록별 분양\n    blockTotal: 39')), { kind: 'newtowns_field' });
});

test('the real newtowns.yaml parses', () => {
  const loaded = loadNewtowns(new URL('../data/newtowns.yaml', import.meta.url));
  const byId = Object.fromEntries(loaded.projects.map((p) => [p.id, p]));
  const gyosan = byId['town-hanam-gyosan'];
  assert.deepEqual(gyosan.history.map((e) => [e.block, e.stage, e.noticeDate]), [
    ['A2', '사전청약', '2021-11-18'], ['A5', '사전청약', '2023-09-25'], ['A2', '본청약', '2025-03-31'],
  ]);
  assert.ok(gyosan.history.every((e) => e.sources.length > 0));
  assert.deepEqual(gyosan.plans.map((p) => [p.blocks.join('·'), p.expected, p.rental]), [
    ['D2·D5', '2026-상반기', false], ['A20', '2026-하반기', true], ['A9·A11', '2026-하반기', false], ['S2', '2026-하반기', true],
  ]);
  assert.ok(byId['town-guri-galmae-station'].history.some((e) => e.rental));
  assert.ok(byId['town-guri-galmae-station'].history.some((e) => e.stage === '사전청약'));
  // B-1은 2순위 접수일(메트로신문 2026-11-03)을 접수 마감으로 둔다. A4 사전청약은 일반형·선택형 공고일이 달라 달까지
  const galmaeHistory = byId['town-guri-galmae-station'].history;
  assert.equal(galmaeHistory.find((e) => e.block === 'B-1').end, '2026-11-11');
  assert.deepEqual(galmaeHistory.filter((e) => e.block === 'A4').map((e) => [e.noticeDate, e.households, e.sources.length]), [['2023-09', 515, 2]]);
  assert.deepEqual(byId['town-guri-topyeong-hangang'].history, []);
  // 블록별 현황: 모든 블록에 출처, 교산은 지구 전체 블록 수(시티뉴스)
  for (const project of loaded.projects) assert.ok(project.blockEntries.every((b) => b.sources.length > 0), project.id);
  assert.deepEqual([gyosan.blockTotal.total, gyosan.blockTotal.approved], [39, 16]);
  assert.equal(gyosan.blockEntries.filter((b) => b.status === '사업승인').length, 16);
  assert.equal(byId['town-guri-galmae-station'].blockTotal, null);
  assert.equal(byId['town-guri-galmae-station'].blockEntries.find((b) => b.block === 'S-1').type, null);
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
