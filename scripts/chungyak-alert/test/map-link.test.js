import assert from 'node:assert/strict';
import { test } from 'node:test';
import { containsToken, linkNotices, lotKey, matchesProject, zoneKey } from '../src/pipeline/link-notices.js';

const today = '2026-11-10';

const seoul = (extra) => ({ id: 'seoul-1', region: '서울', district: '종로구', name: '신영1', address: '신영동158-2', notices: [], live: false, ...extra });
const town = (extra) => ({
  id: 'town-hanam-gyosan', region: '경기', district: '하남시', name: '하남교산', noticeMatch: ['교산'], notices: [], live: false, ...extra,
});
const notice = (extra) => ({
  key: 'n1', name: '아무 단지', address: '', region: '서울', announceDate: '2026-10-01', overallEnd: '2026-10-20',
  url: 'https://www.applyhome.co.kr/notice/1', typeLabel: 'APT', ...extra,
});

test('lot key keeps the 동 and 본번', () => {
  assert.equal(lotKey('신영동158-2'), '신영동158');
  assert.equal(lotKey('쌍문2동 81번지'), '쌍문2동81');
  assert.equal(lotKey('신문로1가158'), '신문로1가158');
  assert.equal(lotKey('창신동23-606번지일원'), '창신동23');
  assert.equal(lotKey('신영동 산12-3'), '신영동산12');
  assert.equal(lotKey('158-2'), null);
  assert.equal(lotKey(null), null);
});

test('zone key strips 구역 and spaces and needs 3 characters', () => {
  assert.equal(zoneKey('한남3구역'), '한남3');
  assert.equal(zoneKey('반포 미도2차'), '반포미도2차');
  assert.equal(zoneKey('수표'), null);
  assert.equal(zoneKey('명동 구역'), null);
});

test('numbered keys do not match a longer number', () => {
  assert.equal(containsToken('신당10구역', '신당1'), false);
  assert.equal(containsToken('신당1구역', '신당1'), true);
  assert.equal(containsToken('신영동1580,신영동158-2', '신영동158'), true);
  assert.equal(containsToken('신영동1580', '신영동158'), false);
  assert.equal(containsToken('반포미도2차아파트', '반포미도2차'), true);
});

test('seoul notices match by 구 + 지번', () => {
  assert.equal(matchesProject(seoul(), notice({ address: '서울특별시 종로구 신영동 158-2번지 일원' })), true);
  assert.equal(matchesProject(seoul(), notice({ address: '서울특별시 종로구 신영동158' })), true);
});

test('seoul notices match by 구 + 구역명', () => {
  const project = seoul({ name: '한남3구역', district: '용산구', address: '한남동686' });
  assert.equal(matchesProject(project, notice({ name: '한남3구역 디에이치', address: '서울특별시 용산구 한남동 999' })), true);
});

test('seoul false-positive guards', () => {
  // 다른 구
  assert.equal(matchesProject(seoul(), notice({ address: '서울특별시 성북구 신영동 158-2' })), false);
  // 서울 중구 사업과 인천 중구 공고
  const jung = seoul({ district: '중구', name: '신당10', address: '신당동236-100' });
  assert.equal(matchesProject(jung, notice({ region: '인천', address: '인천광역시 중구 신당동 236-100', name: '신당10' })), false);
  // 짧은 구역명
  const short = seoul({ district: '중구', name: '수표', address: '수표동11-5' });
  assert.equal(matchesProject(short, notice({ address: '서울특별시 중구 을지로동 1', name: '수표 센트럴' })), false);
  // 번호가 더 긴 구역
  const sindang = seoul({ district: '중구', name: '신당1', address: '신당동1' });
  assert.equal(matchesProject(sindang, notice({ address: '서울특별시 중구 황학동 2', name: '신당10구역 재개발' })), false);
  // 본번이 다름
  assert.equal(matchesProject(seoul(), notice({ address: '서울특별시 종로구 신영동 1580' })), false);
});

test('town notices need the 시 and a noticeMatch substring', () => {
  assert.equal(matchesProject(town(), notice({ region: '경기', address: '경기도 하남시 천현동 일원', name: '교산 푸르지오 더 퍼스트' })), true);
  assert.equal(matchesProject(town(), notice({ region: '경기', address: '경기도 하남시 교산동 1', name: '하남 A2블록' })), true);
  assert.equal(matchesProject(town(), notice({ region: '경기', address: '경기도 남양주시 진접읍', name: '교산마을 단지' })), false);
  assert.equal(matchesProject(town(), notice({ region: '경기', address: '경기도 하남시 미사동', name: '미사 단지' })), false);
  assert.equal(matchesProject(town({ noticeMatch: [] }), notice({ region: '경기', address: '경기도 하남시 교산동' })), false);
  assert.equal(matchesProject(town(), notice({ region: '서울', address: '서울특별시 하남시 교산동' })), false);
});

test('linkNotices attaches sorted, deduped notices and marks live', () => {
  const notices = [
    notice({ key: 'old', address: '서울특별시 종로구 신영동 158-2', announceDate: '2026-01-05', overallEnd: '2026-01-20' }),
    notice({ key: 'new', address: '서울특별시 종로구 신영동 158-2', announceDate: '2026-11-01', overallEnd: '2026-11-10' }),
    notice({ key: 'new', address: '서울특별시 강남구 개포동 1', announceDate: '2026-11-01', overallEnd: '2026-11-10' }),
    notice({ key: 'other', address: '서울특별시 강남구 개포동 1' }),
  ];
  const projects = [seoul(), seoul({ id: 'seoul-2', name: '세운4', address: '예지동85' })];
  const result = linkNotices(projects, notices, today);
  assert.equal(result.checked, 3);
  assert.equal(result.linked, 1);
  const [linked, unlinked] = result.projects;
  assert.deepEqual(linked.notices.map((n) => n.key), ['new', 'old']);
  assert.equal(linked.live, true);
  assert.equal(linked.notices[1].end, '2026-01-20');
  assert.equal(linked.notices[1].url, 'https://www.applyhome.co.kr/notice/1');
  assert.equal(unlinked, projects[1]);
});

test('notice urls go through safeHttpUrl and ended notices are not live', () => {
  const result = linkNotices([seoul()], [notice({ address: '서울특별시 종로구 신영동 158', url: 'javascript:alert(1)' })], today);
  assert.equal(result.projects[0].notices[0].url, null);
  assert.equal(result.projects[0].live, false);
});
