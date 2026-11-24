import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  GRADE,
  GRADE_DEFAULTS,
  appendGradeLine,
  gradeFromStatus,
  gradeFromStored,
  gradeNotice,
  gradeSettings,
  qualityOf,
  statusFromStored,
} from '../src/grade.js';
import { STATUS } from '../src/lotto.js';
import { qualifiesAsLotto } from '../src/market-estimate.js';
import { ENDPOINTS, normalizeDetail } from '../src/sources/applyhome.js';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

// 합성 입력. 기본값은 마진율 -1%, 신뢰도 중, 품질 3점(서울, 세대수 600에 거래 60건, 래미안)이다.
const evaluation = (extra = {}) => ({
  status: STATUS.NOT,
  margin: -500,
  marginRate: -0.01,
  confidence: '중',
  tradeSamples: 60,
  estimate: 49500,
  ...extra,
});
const notice = (extra = {}) => ({ name: '래미안합성', builder: '', region: '서울', kind: 'apt', supplyUnits: 600, typeLabel: 'APT', ...extra });
const gradeOf = (parts = {}) => gradeNotice({ evaluation: evaluation(parts.evaluation), notice: notice(parts.notice), walkMinutes: parts.walkMinutes ?? null, config }).grade;

// 품질 점수를 정확히 맞춘다: 서울(입지) 하나, 서울이 아니고 역 도보 없음이면 0.
const withQuality = (score, evalExtra = {}) => {
  const items = [
    { notice: { region: '서울' }, off: { region: '경기' } },
    { notice: { supplyUnits: 600 }, off: { supplyUnits: 100 } },
    { notice: { name: '래미안합성' }, off: { name: '합성단지' } },
  ];
  const merged = items.reduce((acc, item, index) => ({ ...acc, ...(index < score ? item.notice : item.off) }), {});
  return { evaluation: evalExtra, notice: merged };
};

test('config.json carries the starting values of every grade key', () => {
  assert.deepEqual(gradeSettings(config.grade), GRADE_DEFAULTS);
  assert.deepEqual(GRADE_DEFAULTS, { positiveMinRate: 0.03, considerMinRate: -0.03, passMaxRate: -0.1, considerMinQuality: 2, stationMaxMinutes: 10, minUnits: 300, minTrades: 50 });
  // 없거나 숫자가 아닌 값은 시작값을 쓴다.
  assert.deepEqual(gradeSettings(undefined), GRADE_DEFAULTS);
  assert.deepEqual(gradeSettings({ minUnits: '많이', stationMaxMinutes: 7 }), { ...GRADE_DEFAULTS, stationMaxMinutes: 7 });
});

test('로또청약 is exactly STATUS.LOTTO, with or without an estimate', () => {
  assert.equal(gradeOf({ evaluation: { status: STATUS.LOTTO, margin: 20000, marginRate: 0.2 } }), GRADE.LOTTO);
  // 이전 판별 유지(keepPreviousLotto)는 이번에 추정이 없어도 로또다.
  assert.equal(gradeOf({ evaluation: { status: STATUS.LOTTO, margin: null, marginRate: null, confidence: null, estimate: null } }), GRADE.LOTTO);
  // 조회 실패로 신뢰도가 하로 내려가 로또로 정한 공고도 로또청약이다.
  assert.equal(gradeOf({ evaluation: { status: STATUS.LOTTO, margin: 20000, marginRate: 0.2, confidence: '하' } }), GRADE.LOTTO);
  // 로또가 아닌 상태는 마진이 아무리 커도 로또청약이 아니다.
  for (const status of [STATUS.NOT, STATUS.CHECK, STATUS.UNDETERMINED, STATUS.OUT_OF_SCOPE]) {
    assert.notEqual(gradeOf({ evaluation: { status, margin: 5000, marginRate: 0.05 } }), GRADE.LOTTO, status);
  }
});

test('로또청약 follows the lotto margin rule at, just below and just above each threshold', () => {
  const statusOf = (margin, marginRate, confidence = '중') => {
    const candidate = { margin, marginRate, confidence };
    if (!(margin > 0)) return STATUS.NOT;
    return qualifiesAsLotto(candidate, config.lotto) ? STATUS.LOTTO : STATUS.CHECK;
  };
  const cases = [
    [10000, 0.1, '중', true],
    [10000, 0.1, '상', true],
    [9999, 0.1, '중', false],
    [10001, 0.1, '중', true],
    [10000, 0.0999, '중', false],
    [10000, 0.1001, '중', true],
    [20000, 0.2, '하', false],
  ];
  for (const [margin, marginRate, confidence, lotto] of cases) {
    const status = statusOf(margin, marginRate, confidence);
    const grade = gradeOf({ evaluation: { status, margin, marginRate, confidence } });
    assert.equal(status === STATUS.LOTTO, lotto, `status ${margin} ${marginRate} ${confidence}`);
    assert.equal(grade === GRADE.LOTTO, lotto, `grade ${margin} ${marginRate} ${confidence}`);
  }
});

test('고려: a clearly positive margin rate at +3% or better regardless of quality, then -3% to +3% by quality', () => {
  // 양수 구간: +3%는 포함, 바로 아래는 제외, 바로 위는 포함. 품질과 무관하다.
  for (const score of [0, 1, 2, 3]) {
    assert.equal(gradeOf(withQuality(score, { marginRate: 0.03 })), GRADE.CONSIDER, `+3% ${score}점`);
    assert.equal(gradeOf(withQuality(score, { marginRate: 0.0301 })), GRADE.CONSIDER, `+3.01% ${score}점`);
    assert.equal(gradeOf(withQuality(score, { marginRate: 0.09 })), GRADE.CONSIDER, `+9% ${score}점`);
  }
  assert.equal(gradeOf(withQuality(0, { marginRate: 0.0299 })), GRADE.NO_MARGIN);
  assert.equal(gradeOf(withQuality(1, { marginRate: 0.0299 })), GRADE.NO_MARGIN);
  assert.equal(gradeOf(withQuality(2, { marginRate: 0.0299 })), GRADE.CONSIDER);
  // 시세 수준 구간(-3% ~ +3%): -3%는 포함, 바로 아래는 제외. 품질 2점 이상이면 고려
  for (const [rate, expected] of [[-0.03, GRADE.CONSIDER], [-0.0299, GRADE.CONSIDER], [0, GRADE.CONSIDER], [-0.0301, GRADE.NO_MARGIN]]) {
    assert.equal(gradeOf(withQuality(2, { marginRate: rate })), expected, String(rate));
  }
  // 품질 점수 경계: 2점은 고려, 1점과 0점은 안전마진 없음
  assert.equal(gradeOf(withQuality(3, { marginRate: -0.01 })), GRADE.CONSIDER);
  assert.equal(gradeOf(withQuality(2, { marginRate: -0.01 })), GRADE.CONSIDER);
  assert.equal(gradeOf(withQuality(1, { marginRate: -0.01 })), GRADE.NO_MARGIN);
  assert.equal(gradeOf(withQuality(0, { marginRate: -0.01 })), GRADE.NO_MARGIN);
  // 마진이 양수로 뚜렷하면 로또 기준(1억)에 못 미쳐도(내부 판정은 확인 필요) 품질과 무관하게 고려다. 예전에는 품질 0점이면 안전마진 없음이었다.
  assert.equal(gradeOf({ ...withQuality(0), evaluation: { status: STATUS.CHECK, margin: 9000, marginRate: 0.2 } }), GRADE.CONSIDER);
  assert.equal(gradeOf({ ...withQuality(3), evaluation: { status: STATUS.CHECK, margin: 9000, marginRate: 0.2 } }), GRADE.CONSIDER);
  // 마진율이 +3% 아래이면 마진이 양수여도 시세 수준이라 품질로 가른다.
  assert.equal(gradeOf({ ...withQuality(0), evaluation: { status: STATUS.CHECK, margin: 700, marginRate: 0.007 } }), GRADE.NO_MARGIN);
});

test('between -10% and -3%: 안전마진 없음, or 패스 when the quality score is 0; below -10% is always 패스', () => {
  for (const rate of [-0.0301, -0.05, -0.1]) {
    assert.equal(gradeOf(withQuality(3, { marginRate: rate })), GRADE.NO_MARGIN, `3점 ${rate}`);
    assert.equal(gradeOf(withQuality(1, { marginRate: rate })), GRADE.NO_MARGIN, `1점 ${rate}`);
    assert.equal(gradeOf(withQuality(0, { marginRate: rate })), GRADE.PASS, `0점 ${rate}`);
  }
  // 바로 아래와 바로 위
  assert.equal(gradeOf(withQuality(0, { marginRate: -0.0999 })), GRADE.PASS);
  assert.equal(gradeOf(withQuality(1, { marginRate: -0.0999 })), GRADE.NO_MARGIN);
  for (const score of [0, 1, 2, 3]) {
    assert.equal(gradeOf(withQuality(score, { marginRate: -0.1001 })), GRADE.PASS, `${score}점`);
    assert.equal(gradeOf(withQuality(score, { marginRate: -0.5 })), GRADE.PASS, `${score}점 -50%`);
  }
});

test('the thresholds come from config.grade when it overrides them', () => {
  const custom = { ...config, grade: { positiveMinRate: 0.1, considerMinRate: -0.05, passMaxRate: -0.2, considerMinQuality: 3, stationMaxMinutes: 5, minUnits: 1000, minTrades: 10 } };
  const grade = (parts) => gradeNotice({ evaluation: evaluation(parts.evaluation), notice: notice(parts.notice), walkMinutes: parts.walkMinutes ?? null, config: custom }).grade;
  assert.equal(grade({ evaluation: { marginRate: -0.05 } }), GRADE.NO_MARGIN, '공급 세대수 600은 새 기준 1000에 못 미쳐 2점');
  assert.equal(grade({ ...withQuality(0), evaluation: { marginRate: 0.0999 } }), GRADE.NO_MARGIN, '양수 기준도 설정을 따른다');
  assert.equal(grade({ ...withQuality(0), evaluation: { marginRate: 0.1 } }), GRADE.CONSIDER);
  assert.equal(grade({ evaluation: { marginRate: -0.05 }, notice: { supplyUnits: 1000 } }), GRADE.CONSIDER);
  assert.equal(grade({ evaluation: { marginRate: -0.0501 }, notice: { supplyUnits: 1000 } }), GRADE.NO_MARGIN);
  assert.equal(grade({ evaluation: { marginRate: -0.15 }, notice: { region: '경기', supplyUnits: 1, name: '합성' } }), GRADE.PASS);
  assert.equal(grade({ evaluation: { marginRate: -0.2 }, notice: { region: '경기', supplyUnits: 1, name: '합성' } }), GRADE.PASS, '0점은 -20%까지 패스');
  assert.equal(grade({ evaluation: { marginRate: -0.19 }, notice: { region: '경기' } }), GRADE.NO_MARGIN);
  assert.equal(grade({ evaluation: { marginRate: -0.2001 }, notice: { supplyUnits: 5000 } }), GRADE.PASS);
});

test('quality item 입지: 서울, or the entered station walk at 10 minutes or less', () => {
  const location = (region, walkMinutes) => qualityOf({ evaluation: evaluation(), notice: notice({ region }), walkMinutes }, config).items[0];
  assert.deepEqual(location('서울', null), { label: '입지', ok: true, text: '서울' });
  assert.equal(location('서울', 40).ok, true, '서울은 도보와 무관');
  assert.equal(location('경기', 10).ok, true);
  assert.equal(location('경기', 0).ok, true);
  assert.equal(location('경기', 11).ok, false);
  assert.equal(location('경기', 11).text, '역 도보 11분');
  // 자료가 없으면 0점이고 자료 없음으로 적는다. 경기·인천은 서울이 아니다.
  assert.deepEqual(location('경기', null), { label: '입지', ok: false, text: '자료 없음(역 도보 미입력)' });
  assert.equal(location('인천', undefined).ok, false);
});

test('quality item 규모·환금성: the supply count of this notice and the trade count must both pass, except for 무순위 and 임의공급', () => {
  const scale = (supplyUnits, tradeSamples, kind = 'apt') => qualityOf({ evaluation: evaluation({ tradeSamples }), notice: notice({ supplyUnits, kind }), walkMinutes: null }, config).items[1];
  // 기본 기준은 공급 세대수 300, 거래 50건(단지 전체 규모가 아니라 이 공고의 공급 세대수다)
  assert.equal(scale(300, 50).ok, true);
  assert.equal(scale(299, 50).ok, false);
  assert.equal(scale(300, 49).ok, false);
  assert.equal(scale(301, 51).ok, true);
  assert.equal(scale(299, 49).text, '공급 세대수 299, 거래 49건');
  assert.equal(scale(299, 60).text, '공급 세대수 299');
  assert.equal(scale(600, 49).text, '거래 49건');
  assert.equal(scale(600, 60).text, '공급 세대수 600, 거래 60건');
  // 자료가 없으면 0점이다. 한쪽만 있어도 둘 다 필요하다.
  assert.deepEqual(scale(null, 60), { label: '규모·환금성', ok: false, text: '공급 세대수 자료 없음' });
  assert.deepEqual(scale(undefined, 60).ok, false);
  assert.deepEqual(scale(600, null), { label: '규모·환금성', ok: false, text: '거래 자료 없음' });
  assert.equal(scale(600, undefined).ok, false);
  assert.equal(scale(null, null).text, '공급 세대수 자료 없음, 거래 자료 없음');
  assert.equal(scale(0, 60).ok, false);
  // LH는 공급 세대수를 읽지 않아(null) 이 절반이 자료 없음이다.
  assert.deepEqual(scale(null, 80, 'lh'), { label: '규모·환금성', ok: false, text: '공급 세대수 자료 없음' });
  // 무순위와 임의공급은 공급 세대수를 보지 않고 거래 건수만 본다. 근거에 제외했다고 적는다.
  assert.deepEqual(scale(5, 62, 'remainder'), { label: '규모·환금성', ok: true, text: '거래 62건 (공급 세대수는 무순위라 제외)' });
  assert.deepEqual(scale(null, 62, 'remainder'), { label: '규모·환금성', ok: true, text: '거래 62건 (공급 세대수는 무순위라 제외)' });
  assert.deepEqual(scale(5, 49, 'remainder'), { label: '규모·환금성', ok: false, text: '거래 49건 (공급 세대수는 무순위라 제외)' });
  assert.deepEqual(scale(5, 50, 'arbitrary'), { label: '규모·환금성', ok: true, text: '거래 50건 (공급 세대수는 임의공급이라 제외)' });
  assert.deepEqual(scale(5, null, 'remainder'), { label: '규모·환금성', ok: false, text: '거래 자료 없음 (공급 세대수는 무순위라 제외)' });
});

test('재건축 단지: 3,000 households in the complex but 224 supplied is judged by the supply count (224 < 300) and the trade count', () => {
  const row = normalizeDetail(ENDPOINTS.find((endpoint) => endpoint.kind === 'apt'), { HOUSE_MANAGE_NO: '9', PBLANC_NO: '9', HOUSE_NM: '합성재건축', TOT_SUPLY_HSHLDCO: '224' });
  assert.equal(row.supplyUnits, 224);
  const scale = (tradeSamples) => qualityOf({ evaluation: evaluation({ tradeSamples }), notice: { ...notice(), ...row, supplyUnits: row.supplyUnits }, walkMinutes: null }, config).items[1];
  // 단지가 3,000세대라도 공급이 224세대이면 기준(300)에 못 미친다. 거래가 충분해도 이 항목은 0점이다.
  assert.deepEqual(scale(120), { label: '규모·환금성', ok: false, text: '공급 세대수 224' });
  assert.deepEqual(scale(30), { label: '규모·환금성', ok: false, text: '공급 세대수 224, 거래 30건' });
  // 기준을 공급 규모에 맞게 낮추면 통과한다. 기준은 설정이다.
  const lower = { ...config, grade: { ...config.grade, minUnits: 200 } };
  assert.equal(qualityOf({ evaluation: evaluation({ tradeSamples: 120 }), notice: { ...notice(), supplyUnits: 224 }, walkMinutes: null }, lower).items[1].ok, true);
  // 같은 공고가 무순위 종류였다면 공급 세대수는 보지 않는다.
  assert.equal(qualityOf({ evaluation: evaluation({ tradeSamples: 120 }), notice: notice({ kind: 'remainder', supplyUnits: 224 }), walkMinutes: null }, config).items[1].ok, true);
});

test('quality item 브랜드: the 단지명 or the 시공사 is a top or mid brand by the existing tiers', () => {
  const brand = (extra) => qualityOf({ evaluation: evaluation(), notice: notice({ name: '합성단지', builder: '', ...extra }), walkMinutes: null }, config).items[2];
  assert.equal(brand({ name: '래미안합성' }).ok, true, '단지명 상위');
  assert.equal(brand({ name: '합성센트레빌' }).ok, true, '단지명 중위');
  assert.equal(brand({ builder: '삼성물산(주)' }).ok, true, '시공사 상위');
  assert.equal(brand({ builder: '호반건설(주)' }).ok, true, '시공사 중위');
  assert.equal(brand({ builder: '합성건설(주), 삼성물산' }).ok, false, '컨소시엄은 주간사만 본다');
  assert.equal(brand({}).ok, false);
  assert.equal(brand({ name: '', builder: '' }).text, '자료 없음');
  assert.equal(brand({ name: '', builder: '' }).ok, false);
});

test('the evidence gate: weak or missing evidence is 판정 보류, never 고려, 안전마진 없음 or 패스', () => {
  const strong = { margin: 5000, marginRate: 0.05 };
  const cases = {
    '추정 없음': { margin: null, marginRate: null, confidence: null, estimate: null },
    '추정 없음(마진 없음만)': { margin: undefined },
    '신뢰도 하': { confidence: '하' },
    '신뢰도 없음': { confidence: null },
    '판별 불가': { status: STATUS.UNDETERMINED },
    '대상 외': { status: STATUS.OUT_OF_SCOPE },
    '확인 필요이고 신뢰도 하': { status: STATUS.CHECK, confidence: '하' },
    '확인 필요이고 추정 없음': { status: STATUS.CHECK, margin: null, marginRate: null, confidence: null },
    '마진율 없음': { marginRate: null },
    '음수 마진도 근거가 약하면': { margin: -9000, marginRate: -0.3, confidence: '하' },
  };
  for (const [label, extra] of Object.entries(cases)) {
    for (const score of [0, 3]) {
      const parts = withQuality(score, { ...strong, ...extra });
      assert.equal(gradeOf(parts), GRADE.HOLD, `${label} ${score}점`);
    }
  }
  // 제한 유형은 마진이 있어도(참고 마진 행 포함) 보류다. 토지임대부, 지분적립형, 나눔형, 신혼희망타운.
  for (const name of ['고덕 토지임대부 단지', '합성 지분적립형 단지', '합성 지분적립 단지', '합성 나눔형 단지', '하남교산 신혼희망타운']) {
    const result = gradeNotice({ evaluation: evaluation({ ...strong, status: STATUS.NOT }), notice: notice({ name }), config });
    assert.equal(result.grade, GRADE.HOLD, name);
    assert.ok(result.line.includes('제한 유형'), result.line);
  }
  const reference = gradeNotice({ evaluation: evaluation({ status: STATUS.OUT_OF_SCOPE, ...strong }), notice: notice({ houseSecd: '10', name: '합성타운' }), config });
  assert.equal(reference.grade, GRADE.HOLD);
  // 신혼희망타운은 유형 코드(houseSecd 10)로도 알아본다
  assert.equal(gradeNotice({ evaluation: evaluation(strong), notice: notice({ houseSecd: '10' }), config }).grade, GRADE.HOLD);
  // 판정 보류에는 품질을 재지 않는다.
  assert.equal(gradeNotice({ evaluation: evaluation({ confidence: '하' }), notice: notice(), config }).quality, undefined);
});

test('the effective confidence decides the gate, like the lotto decision; the displayed confidence does not', () => {
  const parts = (confidence, effectiveConfidence) => ({ ...withQuality(3), evaluation: { confidence, effectiveConfidence, marginRate: -0.01, margin: -100 } });
  // 분양권·역 정보 조회 실패로만 하로 내려갔으면(표시 하, 판정에 쓴 값 중) 로또 판정처럼 중으로 본다.
  assert.equal(gradeOf(parts('하', '중')), GRADE.CONSIDER);
  assert.equal(gradeOf(parts('하', '상')), GRADE.CONSIDER);
  // 자료 때문에 하이면 그대로 보류다. 값이 없으면 표시 신뢰도를 쓴다.
  assert.equal(gradeOf(parts('하', '하')), GRADE.HOLD);
  assert.equal(gradeOf(parts('하', undefined)), GRADE.HOLD);
  assert.equal(gradeOf(parts('중', '중')), GRADE.CONSIDER);
  assert.equal(gradeOf(parts('중', undefined)), GRADE.CONSIDER);
  assert.equal(gradeNotice({ evaluation: evaluation({ confidence: '하', effectiveConfidence: '하' }), notice: notice(), config }).line, '등급: 판정 보류 (시세 신뢰도 하)');
});

test('the reason line names the grade, the margin rate and every quality item', () => {
  const consider = gradeNotice({
    evaluation: evaluation({ marginRate: -0.012, tradeSamples: 80 }),
    notice: notice({ supplyUnits: 280, name: '래미안합성' }),
    walkMinutes: null,
    config,
  });
  assert.equal(consider.grade, GRADE.CONSIDER);
  assert.equal(consider.line, '등급: 고려 (마진율 -1.20%, 입지 ✓ 서울, 규모·환금성 ✗ 공급 세대수 280, 브랜드 ✓)');
  assert.equal(consider.detail, '마진율 -1.20%, 입지 ✓ 서울, 규모·환금성 ✗ 공급 세대수 280, 브랜드 ✓');
  const missing = gradeNotice({ evaluation: evaluation({ marginRate: 0.01, tradeSamples: null }), notice: notice({ region: '경기', supplyUnits: null, name: '합성' }), config });
  assert.equal(missing.line, '등급: 안전마진 없음 (마진율 +1.00%, 입지 ✗ 자료 없음(역 도보 미입력), 규모·환금성 ✗ 공급 세대수 자료 없음, 거래 자료 없음, 브랜드 ✗)');
  assert.equal(gradeNotice({ evaluation: evaluation({ status: STATUS.LOTTO, marginRate: 0.125 }), notice: notice(), config }).line, '등급: 로또청약 (마진율 +12.50%)');
  assert.equal(gradeNotice({ evaluation: evaluation({ confidence: '하' }), notice: notice(), config }).line, '등급: 판정 보류 (시세 신뢰도 하)');
  assert.equal(gradeNotice({ evaluation: evaluation({ status: STATUS.UNDETERMINED, margin: null }), notice: notice(), config }).line, '등급: 판정 보류 (판별 불가)');
  assert.equal(gradeNotice({ evaluation: evaluation({ margin: null }), notice: notice(), config }).line, '등급: 판정 보류 (시세 추정 없음)');
  // 기준 바로 아래 마진율이 기준으로 읽히지 않게 소수 둘째 자리까지 적는다.
  assert.ok(gradeNotice({ evaluation: evaluation({ marginRate: -0.0304 }), notice: notice({ region: '경기', name: '합성' }), config }).line.startsWith('등급: 안전마진 없음 (마진율 -3.04%'));
  // 한 줄이고 공고 이름을 담지 않는다.
  assert.ok(!consider.line.includes('\n'));
  assert.ok(!consider.line.includes('래미안합성'));
});

test('stored values map to internal statuses and grades, legacy values included', () => {
  const statuses = {
    로또청약: STATUS.LOTTO,
    로또: STATUS.LOTTO,
    고려: STATUS.NOT,
    '안전마진 없음': STATUS.NOT,
    패스: STATUS.NOT,
    '판정 보류': STATUS.UNDETERMINED,
    아님: STATUS.NOT,
    '확인 필요': STATUS.CHECK,
    '판별 불가': STATUS.UNDETERMINED,
    '대상 외': STATUS.OUT_OF_SCOPE,
  };
  for (const [stored, status] of Object.entries(statuses)) assert.equal(statusFromStored(stored), status, stored);
  assert.equal(statusFromStored('모르는 값'), null);
  assert.equal(statusFromStored(null), null);
  const grades = { 로또청약: GRADE.LOTTO, 로또: GRADE.LOTTO, 고려: GRADE.CONSIDER, '안전마진 없음': GRADE.NO_MARGIN, 패스: GRADE.PASS, '판정 보류': GRADE.HOLD, '확인 필요': GRADE.HOLD, '판별 불가': GRADE.HOLD, '대상 외': GRADE.HOLD };
  for (const [stored, grade] of Object.entries(grades)) assert.equal(gradeFromStored(stored), grade, stored);
  // 옛 아님은 어느 등급인지 몰라 등급을 지어내지 않는다.
  assert.equal(gradeFromStored('아님'), null);
  assert.equal(gradeFromStored(null), null);
  // 등급을 계산하지 않은 평가: 로또와 판정 보류만 옮기고 아님은 모른다.
  assert.deepEqual([STATUS.LOTTO, STATUS.CHECK, STATUS.UNDETERMINED, STATUS.OUT_OF_SCOPE, STATUS.NOT].map(gradeFromStatus), [GRADE.LOTTO, GRADE.HOLD, GRADE.HOLD, GRADE.HOLD, null]);
});

test('the grade line is appended and stays inside the Notion text limit', () => {
  assert.equal(appendGradeLine('근거', '등급: 고려'), '근거\n등급: 고려');
  assert.equal(appendGradeLine('', '등급: 고려'), '등급: 고려');
  assert.equal(appendGradeLine(null, '등급: 고려'), '등급: 고려');
  const long = '가'.repeat(2500);
  const line = '등급: 안전마진 없음 (마진율 -5.0%)';
  const result = appendGradeLine(long, line);
  assert.ok(result.length <= 2000, String(result.length));
  assert.ok(result.endsWith(`…\n${line}`));
  // 한도 안이면 그대로다.
  const fits = '가'.repeat(1900 - line.length);
  assert.equal(appendGradeLine(fits, line), `${fits}\n${line}`);
});

test('the notice carries the supply household count (TOT_SUPLY_HSHLDCO) for every kind, and null when it is absent or not positive', () => {
  const base = { HOUSE_MANAGE_NO: '1', PBLANC_NO: '1', HOUSE_NM: '합성단지' };
  for (const endpoint of ENDPOINTS) {
    assert.equal(normalizeDetail(endpoint, { ...base, TOT_SUPLY_HSHLDCO: '840' }).supplyUnits, 840, endpoint.kind);
    assert.equal(normalizeDetail(endpoint, base).supplyUnits, null, endpoint.kind);
  }
  const apt = ENDPOINTS.find((endpoint) => endpoint.kind === 'apt');
  assert.equal(normalizeDetail(apt, { ...base, TOT_SUPLY_HSHLDCO: '1,200' }).supplyUnits, 1200);
  assert.equal(normalizeDetail(apt, { ...base, TOT_SUPLY_HSHLDCO: 500 }).supplyUnits, 500);
  for (const bad of ['0', 0, '', null, '알수없음', '-3']) assert.equal(normalizeDetail(apt, { ...base, TOT_SUPLY_HSHLDCO: bad }).supplyUnits, null, String(bad));
});
