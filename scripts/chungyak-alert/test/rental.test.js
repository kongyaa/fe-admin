import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalizeLh } from '../src/sources/lh.js';
import { ENDPOINTS, normalizeDetail } from '../src/sources/applyhome.js';
import { isRental, rentalRule } from '../src/rental.js';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

test('config turns the rental exclusion on with the keyword list', () => {
  assert.equal(config.excludeRental, true);
  assert.deepEqual(config.rentalKeywords, ['임대', '행복주택', '국민임대', '영구임대', '공공임대', '매입임대', '전세임대', '분양전환', '장기전세']);
});

test('each rental rule, checked on typeLabels seen in live runs', () => {
  const cases = [
    // 청약홈 공공지원민간임대 엔드포인트는 유형과 관계없이 임대다.
    [{ kind: 'pblrent', typeLabel: '공공지원민간임대', name: '어느 단지' }, 'kind'],
    [{ kind: 'pblrent', typeLabel: '기타', name: '어느 단지' }, 'kind'],
    // LH 상위 유형이 임대주택
    [{ kind: 'lh', typeLabel: '임대주택 공공임대', name: '공고' }, 'lh_upper_type'],
    [{ kind: 'lh', typeLabel: '임대주택 국민임대', name: '공고' }, 'lh_upper_type'],
    [{ kind: 'lh', typeLabel: '임대주택', name: '공고' }, 'lh_upper_type'],
    // 상위 유형 없이 세부 유형만 온 LH 공고
    [{ kind: 'lh', typeLabel: '공공임대', name: '공고' }, 'type_keyword'],
    [{ kind: 'lh', typeLabel: '국민임대', name: '공고' }, 'type_keyword'],
    [{ kind: 'lh', typeLabel: '행복주택', name: '공고' }, 'type_keyword'],
    [{ kind: 'lh', typeLabel: '주거복지 매입임대', name: '공고' }, 'type_keyword'],
    [{ kind: 'lh', typeLabel: '분양주택 분양전환', name: '공고' }, 'type_keyword'],
    [{ kind: 'lh', typeLabel: '신혼희망타운 행복주택', name: '공고' }, 'type_keyword'],
    // 청약홈 도시형 엔드포인트의 민간임대(0203)
    [{ kind: 'urbty', typeLabel: '민간임대', name: '어느 오피스텔' }, 'type_keyword'],
    // 유형으로 정할 수 없을 때만 이름을 본다.
    [{ kind: 'lh', typeLabel: 'LH', name: '○○지구 영구임대 입주자 모집' }, 'name_keyword'],
    [{ kind: 'lh', typeLabel: '주거복지', name: '전세임대 예비입주자' }, 'name_keyword'],
    [{ kind: 'lh', typeLabel: '', name: '장기전세 공급' }, 'name_keyword'],
  ];
  for (const [item, rule] of cases) assert.equal(rentalRule(item, config), rule, `${item.typeLabel} / ${item.name}`);
});

test('sale notices are kept even when the name has a rental word', () => {
  const kept = [
    { kind: 'apt', typeLabel: 'APT', name: '○○ 임대아파트 부지 민영 단지' },
    { kind: 'apt', typeLabel: 'APT', name: '행복주택 옆 공공분양' },
    { kind: 'remainder', typeLabel: '무순위', name: '공공임대 인근 무순위' },
    { kind: 'remainder', typeLabel: '불법행위 재공급', name: '재공급 단지' },
    { kind: 'arbitrary', typeLabel: '임의공급', name: '임대 후 분양 아님' },
    { kind: 'apt', typeLabel: '신혼희망타운', name: '하남교산 신혼희망타운(공공분양)' },
    { kind: 'apt', typeLabel: '민간사전청약', name: '사전청약' },
    { kind: 'urbty', typeLabel: '오피스텔', name: '임대형 아님 오피스텔' },
    { kind: 'urbty', typeLabel: '도시형생활주택', name: '도시형' },
    { kind: 'lh', typeLabel: '분양주택 공공분양', name: '국민임대 단지 옆 공공분양' },
    { kind: 'lh', typeLabel: '신혼희망타운', name: '신혼희망타운 공공분양' },
    { kind: 'lh', typeLabel: 'LH', name: '공공분양 입주자 모집' },
  ];
  for (const item of kept) assert.equal(rentalRule(item, config), null, `${item.typeLabel} / ${item.name}`);
});

test('stored rows without a kind use the stored type and name', () => {
  assert.equal(rentalRule({ typeLabel: '공공지원민간임대', name: '단지' }, config), 'type_keyword');
  assert.equal(rentalRule({ typeLabel: '임대주택 행복주택', name: '단지' }, config), 'lh_upper_type');
  assert.equal(rentalRule({ typeLabel: 'APT', name: '임대 단어가 있는 분양' }, config), null);
  assert.equal(rentalRule({ typeLabel: null, name: '국민임대 단지' }, config), 'name_keyword');
  assert.equal(rentalRule({ typeLabel: null, name: '' }, config), null);
});

test('the flag turns every rule off', () => {
  const off = { ...config, excludeRental: false };
  for (const item of [{ kind: 'pblrent', typeLabel: '공공지원민간임대' }, { kind: 'lh', typeLabel: '임대주택 국민임대' }, { typeLabel: 'LH', name: '영구임대' }]) {
    assert.equal(isRental(item, off), false);
  }
});

test('the parsers produce the labels the rules read', () => {
  const lh = (upper, detail, name = '공고') => normalizeLh({ PAN_ID: 'p1', PAN_NM: name, UPP_AIS_TP_NM: upper, AIS_TP_CD_NM: detail, CNP_CD_NM: '서울특별시', PAN_NT_ST_DT: '2026.11.01', CLSG_DT: '2026.11.20' }, config.lh.excludeTypeKeywords);
  assert.equal(rentalRule(lh('임대주택', '국민임대'), config), 'lh_upper_type');
  assert.equal(lh('임대주택', '국민임대').typeLabel, '임대주택 국민임대');
  assert.equal(rentalRule(lh(undefined, '행복주택'), config), 'type_keyword');
  assert.equal(rentalRule(lh('분양주택', '공공분양', '임대 단어가 있는 이름'), config), null);
  const detail = (op, extra) => normalizeDetail(ENDPOINTS.find((item) => item.op === op), { HOUSE_MANAGE_NO: '1', PBLANC_NO: '1', HOUSE_NM: '단지', ...extra });
  assert.equal(rentalRule(detail('getPblPvtRentLttotPblancDetail', { HOUSE_SECD: '0303' }), config), 'kind');
  assert.equal(rentalRule(detail('getUrbtyOfctlLttotPblancDetail', { HOUSE_SECD: '0203' }), config), 'type_keyword');
  assert.equal(rentalRule(detail('getUrbtyOfctlLttotPblancDetail', { HOUSE_SECD: '0202', HOUSE_NM: '임대 아님' }), config), null);
  assert.equal(rentalRule(detail('getAPTLttotPblancDetail', { HOUSE_SECD: '01', HOUSE_NM: '공공임대 부지 민영' }), config), null);
});
