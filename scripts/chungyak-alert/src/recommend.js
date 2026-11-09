// 공고마다 지원할 전형과 그 접수일을 추천한다. 외부 호출과 입출력이 없는 순수 함수만 둔다.
// 소득, 자산, 세대주 요건은 보지 않는다. 청약통장(민영 예치금)과 특별공급 시점 요건은 v2 신청자 정보가 있을 때만 대략 본다.
// 사용자가 공고문으로 확인해야 한다.
import { lhTypeClass } from './lh-scope.js';
import { restrictedKeywords, restrictedType } from './market-estimate.js';

export const SPECIAL_TRACKS = ['신생아', '신혼부부', '생애최초'];
const CAPITAL_AREA = ['서울', '경기', '인천'];
// 추천을 계산하는 공고 종류. 신청할 수 없는 공고를 가릴 때도 이 종류만 본다.
// LH 분양 공고는 상세 일정이 있을 때만 따로 추천하고(lhRecommendable), 신청할 수 없는 공고로는 빼지 않는다.
const RECOMMENDED_KINDS = ['apt', 'remainder', 'arbitrary'];
// 행복도시(세종) 공고는 기타지역 1순위가 전국이라 어느 시도 거주자든 기타지역으로 신청할 수 있다.
const NATIONWIDE_REGIONS = ['세종'];
// 청약홈 공급지역 이름(SUBSCRPT_AREA_CODE_NM)의 시도 짧은 이름. 이 밖의 값은 지역을 확신할 수 없다.
const SIDO = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종', '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'];

// 일반 1순위 단계 이름(src/sources/applyhome.js의 APT_STAGES)과 거주 구분
const GENERAL_STAGES = {
  해당지역: '1순위 해당',
  기타경기: '1순위 경기',
  기타지역: '1순위 기타',
};

// ---------- 신청자 정보 ----------
// v2 신청자 수와 이름표 길이 상한. 이름표는 Notion 글자에만 쓰고 로그에는 적지 않는다.
const MAX_APPLICANTS = 4;
const MAX_LABEL_LENGTH = 6;
// 이름표에는 판별 근거의 구분자(공백, 쉼표, 쌍반점, 빗금, 가운뎃점)를 쓰지 않는다.
const LABEL_PATTERN = /^[^\s,;/·]+$/;
const PROFILE_KEYS = ['applicants', 'household'];
const APPLICANT_KEYS = ['label', 'birthYear', 'residenceSido', 'residenceYears', 'account', 'specialTracks', 'pregnant', 'childBirths'];
const ACCOUNT_KEYS = ['joined', 'payments', 'depositManwon'];
const HOUSEHOLD_KEYS = ['married', 'marriageRegistered'];

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// 오타 난 키(예: pregnent)를 조용히 무시하면 전형이 빠질 수 있어, 모르는 키가 있으면 형식 오류로 본다.
const onlyKeys = (value, keys) => isPlainObject(value) && Object.keys(value).every((key) => keys.includes(key));
const isMonth = (value) => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const isDay = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const nullable = (value, check) => value === undefined || value === null || check(value);
const validTracks = (tracks) => Array.isArray(tracks) && tracks.every((track) => SPECIAL_TRACKS.includes(track));
const validResidence = (value) => typeof value.residenceSido === 'string'
  && value.residenceSido.trim() !== ''
  && Number.isFinite(value.residenceYears)
  && value.residenceYears >= 0;

// v1은 신청자 한 명이고 이름표가 없다. 출생 연도, 통장, 임신·출산, 혼인 정보를 모르므로 그 규칙은 보지 않는다.
const V1_HOUSEHOLD = { married: null, marriageRegistered: null };
function v1Applicant(value) {
  return {
    label: '',
    birthYear: null,
    residenceSido: value.residenceSido.trim(),
    residenceYears: value.residenceYears,
    specialTracks: [...new Set(value.specialTracks ?? [])],
    account: null,
    pregnant: null,
    childBirths: null,
  };
}

function parseApplicant(value) {
  if (!onlyKeys(value, APPLICANT_KEYS)) return null;
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  // account: null은 통장 값을 모두 모른다는 뜻이다.
  const account = value.account === null ? {} : value.account;
  const tracks = value.specialTracks ?? [];
  const childBirths = value.childBirths ?? [];
  const valid = LABEL_PATTERN.test(label)
    && Array.from(label).length <= MAX_LABEL_LENGTH
    && Number.isInteger(value.birthYear)
    && value.birthYear >= 1900
    && value.birthYear <= 2100
    && validResidence(value)
    && SIDO.includes(value.residenceSido.trim())
    && onlyKeys(account, ACCOUNT_KEYS)
    && nullable(account.joined, isMonth)
    && nullable(account.payments, (payments) => Number.isInteger(payments) && payments >= 0)
    && nullable(account.depositManwon, (deposit) => Number.isFinite(deposit) && deposit >= 0)
    && validTracks(tracks)
    && nullable(value.pregnant, (pregnant) => typeof pregnant === 'boolean')
    && Array.isArray(childBirths)
    && childBirths.every(isMonth);
  if (!valid) return null;
  return {
    label,
    birthYear: value.birthYear,
    residenceSido: value.residenceSido.trim(),
    residenceYears: value.residenceYears,
    specialTracks: [...new Set(tracks)],
    account: { joined: account.joined ?? null, payments: account.payments ?? null, depositManwon: account.depositManwon ?? null },
    pregnant: value.pregnant ?? false,
    childBirths: [...childBirths],
  };
}

// 혼인 여부는 필수다. 혼인하지 않았는데 혼인신고일이 있으면 어느 쪽이 맞는지 몰라 형식 오류로 본다.
function parseHousehold(value) {
  if (!onlyKeys(value, HOUSEHOLD_KEYS) || typeof value.married !== 'boolean') return null;
  const registered = value.marriageRegistered ?? null;
  if (!nullable(registered, isDay)) return null;
  if (!value.married && registered) return null;
  return { married: value.married, marriageRegistered: registered };
}

function parseV2(value) {
  if (!onlyKeys(value, PROFILE_KEYS)) return null;
  const list = value.applicants;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_APPLICANTS) return null;
  const applicants = list.map(parseApplicant);
  if (applicants.some((applicant) => !applicant)) return null;
  if (new Set(applicants.map((applicant) => applicant.label)).size !== applicants.length) return null;
  const household = parseHousehold(value.household);
  if (!household) return null;
  return { version: 2, applicants, household };
}

// GitHub Secret CHUNGYAK_PROFILE의 JSON을 읽는다. 문제가 있으면 기능을 끄고 원인 종류만 돌려준다.
// v1(가짜 값): {"residenceSido":"인천","residenceYears":3,"specialTracks":["생애최초"]}
// v2는 applicants 배열과 household가 있다(docs/SETUP.md 11장). 결과는 두 형식 모두 { version, applicants, household }다.
export function parseProfile(text) {
  if (text === undefined || text === null || String(text).trim() === '') return { profile: null, status: 'missing' };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { profile: null, status: 'invalid' };
  }
  if (isPlainObject(value) && Object.hasOwn(value, 'applicants')) {
    const profile = parseV2(value);
    return profile ? { profile, status: 'ok' } : { profile: null, status: 'invalid' };
  }
  const valid = value
    && typeof value === 'object'
    && validResidence(value)
    && validTracks(value.specialTracks ?? []);
  if (!valid) return { profile: null, status: 'invalid' };
  return { profile: { version: 1, applicants: [v1Applicant(value)], household: { ...V1_HOUSEHOLD } }, status: 'ok' };
}

// 정규화한 신청자 정보를 그대로 쓰고, 예전 한 명짜리 객체({ residenceSido, ... })는 v1로 감싼다.
export function toProfile(profile) {
  if (!profile) return null;
  if (Array.isArray(profile.applicants)) return profile;
  return { version: 1, applicants: [v1Applicant({ ...profile, residenceSido: String(profile.residenceSido ?? '') })], household: { ...V1_HOUSEHOLD } };
}

// ---------- 날짜 ----------
const monthIndex = (value) => Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1;
const addYears = (day, years) => `${Number(day.slice(0, 4)) + years}${day.slice(4)}`;
// from부터 to까지 다 채운 해 수
const fullYears = (from, to) => Number(to.slice(0, 4)) - Number(from.slice(0, 4)) - (to.slice(5) < from.slice(5) ? 1 : 0);
// 시점 요건의 기준일. 청약홈 모집공고일(announceDate, RCRIT_PBLANC_DE)이고 없으면 실행일이다.
export const noticeBaseDate = (notice, today) => notice.announceDate || today;

// ---------- 특별공급 시점 요건 ----------
// 신생아: 공고일 기준 2년 안에 태어난 자녀가 있거나 임신 중. 출생은 월까지라 공고월로부터 24개월 안이면 맞다고 본다.
const NEWBORN_MONTHS = 24;
// 신혼부부: 혼인신고일부터 공고일까지 7년 이내
const NEWLYWED_YEARS = 7;

const keep = (...notes) => ({ valid: true, notes });
const DROP = { valid: false, notes: [] };

// 특별공급 하나의 시점 요건. 결과는 { valid, notes }이고 notes는 막지 않고 확인을 안내할 항목이다.
// 확실히 아닐 때만 뺀다. 모르는 값(v1의 null)은 막지 않고, v1은 예전처럼 적힌 전형을 그대로 쓴다.
// 공고일(announceDate)이 없으면 실행일로 기간을 재지 않고 전형을 남긴 채 공고일 확인('공고일')을 적는다.
// 신혼부부: 민영은 혼인신고한 신혼부부만 받는다. 국민·공공(구분을 모르는 공고 포함)은 예비신혼부부와 한부모도 받아 미혼이어도 남긴다.
// 혼인했는데 신고일을 모르면 남기고 혼인신고일 확인을 적는다.
export function specialTrackCheck(track, { applicant, household, notice, today }) {
  const dateKnown = Boolean(notice.announceDate);
  const at = noticeBaseDate(notice, today);
  if (track === '신생아') {
    if (applicant.pregnant === null || applicant.childBirths === null) return keep();
    if (applicant.pregnant) return keep();
    if (applicant.childBirths.length === 0) return DROP;
    if (!dateKnown) return keep('공고일');
    const base = monthIndex(at);
    return applicant.childBirths.some((month) => monthIndex(month) <= base && monthIndex(month) >= base - NEWBORN_MONTHS) ? keep() : DROP;
  }
  if (track === '신혼부부') {
    const married = household?.married;
    if (married === null || married === undefined) return keep();
    if (married === false) return notice.sector === '민영' ? DROP : keep('예비신혼부부 여부');
    const registered = household.marriageRegistered;
    if (!registered) return keep('혼인신고일');
    if (!dateKnown) return keep('공고일');
    return registered <= at && addYears(registered, NEWLYWED_YEARS) >= at ? keep() : DROP;
  }
  // 생애최초의 다른 요건은 보지 않는다.
  return keep();
}

export const specialTrackValid = (track, options) => specialTrackCheck(track, options).valid;

// ---------- 민영 예치금 ----------
// 예치금 기준(만원)은 config.json의 recommendation.privateDeposit이다. 신청자 거주 시도와 공고의 가장 작은 전용면적으로 고른다.
export function depositRequirement(residenceSido, area, table) {
  const group = table.groups.find((item) => item.sido.includes(residenceSido));
  const amounts = group ? group.manwon : table.otherManwon;
  const index = table.maxAreas.findIndex((max) => area <= max);
  return amounts[index === -1 ? table.maxAreas.length : index];
}

// 주택형 전용면적이 하나라도 비면 더 작은 주택형이 있을 수 있어 모른다고 본다.
const smallestArea = (models) => {
  if (!Array.isArray(models) || models.length === 0) return null;
  const areas = models.map((model) => model.area);
  return areas.every(Number.isFinite) ? Math.min(...areas) : null;
};

// 민영 APT 공고의 예치금. 결과는 { short, check }이다. short는 부족한 만원(모자라지 않으면 null),
// check는 값을 몰라 막지 않고 확인을 안내할 항목이다. v1, 국민, 구분을 모르는 공고, APT가 아닌 공고는 보지 않는다.
export function depositCheck({ notice, models, applicant, config }) {
  const table = config.recommendation?.privateDeposit;
  if (!applicant.account || !table || notice.kind !== 'apt' || notice.sector !== '민영') return { short: null, check: null };
  const deposit = applicant.account.depositManwon;
  if (deposit === null) return { short: null, check: '예치금' };
  const area = smallestArea(models);
  if (area === null) return { short: null, check: '예치금(면적 미상)' };
  const need = depositRequirement(applicant.residenceSido, area, table);
  return { short: deposit < need ? Math.ceil(need - deposit) : null, check: null };
}

// ---------- 가점 추정 ----------
// 민영 일반 1순위 가점제의 대략 값이다. 공고문과 청약홈 가점 계산기로 확인해야 한다.
// 만 30세를 그해 1월 1일로, 통장과 출생을 월 단위로 근사해 실제보다 높게 나오는 쪽이다.
// 무주택 기간: 만 30세(출생 연도+30년 1월 1일로 근사)부터, 그 전에 혼인신고를 했으면 혼인신고일부터 센다. 신고일을 모르면 30세부터다.
// 미혼이고 30세 전이면 0점, 1년 미만 2점, 이후 1년마다 2점, 최대 32점.
// 부양가족: 배우자(혼인했고 신고일이 공고일 뒤가 아님)와 이미 태어난 자녀(태아 제외). 5점 + 1명마다 5점, 최대 35점.
// 통장 가입 기간: 6개월 미만 1점, 1년 미만 2점, 이후 2점 + 다 채운 해 수, 최대 17점. 가입 월을 모르면 빼고 account는 null이다.
export function estimatePoints({ applicant, household, at }) {
  if (!Number.isInteger(applicant?.birthYear) || !at) return null;
  const date = household?.marriageRegistered ?? null;
  const registered = date && date <= at ? date : null;
  const spouse = household?.married === true && !(date && date > at);
  const thirty = `${applicant.birthYear + 30}-01-01`;
  const start = registered && registered < thirty ? registered : thirty;
  const homeless = start > at ? 0 : Math.min(32, 2 + 2 * fullYears(start, at));
  const children = (applicant.childBirths ?? []).filter((month) => monthIndex(month) <= monthIndex(at)).length;
  const dependents = Math.min(35, 5 + 5 * ((spouse ? 1 : 0) + children));
  const joined = applicant.account?.joined ?? null;
  let account = null;
  if (joined) {
    const months = Math.max(0, monthIndex(at) - monthIndex(joined));
    if (months < 6) account = 1;
    else if (months < 12) account = 2;
    else account = Math.min(17, 2 + Math.floor(months / 12));
  }
  return { total: homeless + dependents + (account ?? 0), homeless, dependents, account };
}

// ---------- 지역과 단계 ----------
// 수도권 공고는 수도권 거주자가, 그 밖은 같은 시도 거주자가 1순위 대상이라고 본다. 세종 공고는 모든 거주자가 대상이다.
function eligibleRegion(notice, applicant) {
  if (!notice.region) return false;
  if (notice.region === applicant.residenceSido) return true;
  if (NATIONWIDE_REGIONS.includes(notice.region)) return true;
  return CAPITAL_AREA.includes(notice.region) && CAPITAL_AREA.includes(applicant.residenceSido);
}

// 일반 1순위의 거주 구분. 서울·인천은 시도 전체가 해당지역이고, 경기는 시·군이 해당지역이라 같은 시·군인지 알 수 없어 기타경기로 본다.
// 다른 시도 거주자의 세종 공고는 기타지역이다(1순위 기타 단계).
export function residenceCategory(notice, applicant, recommendation) {
  if (notice.region !== applicant.residenceSido) return '기타지역';
  if (notice.region === '경기') return '기타경기';
  return applicant.residenceYears >= recommendation.localResidenceYears ? '해당지역' : '기타지역';
}

const shortDate = (date) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

// 신청자의 특별공급 중 이번 공고에 세대가 있는 것. 세대가 가장 많은 것, 같으면 신생아, 신혼부부, 생애최초 순이다.
export function pickSpecialTrack(models, tracks) {
  const totals = tracks.map((track) => ({
    track,
    units: (models ?? []).reduce((sum, model) => sum + (Number.isFinite(model.specials?.[track]) ? model.specials[track] : 0), 0),
  }));
  const ranked = totals
    .filter((item) => item.units > 0)
    .sort((a, b) => b.units - a.units || SPECIAL_TRACKS.indexOf(a.track) - SPECIAL_TRACKS.indexOf(b.track));
  return ranked[0] ?? null;
}

const stageOf = (notice, prefix) => notice.stages.find((stage) => stage.name.startsWith(prefix) && stage.start) ?? null;
// 무순위·재공급·임의공급의 접수 단계. 상세의 첫 단계다.
const mainStageOf = (notice) => notice.stages.find((stage) => stage.start) ?? null;
// 무순위·재공급·임의공급의 본 접수 단계(applyhome.js의 '무순위 접수', '재공급 접수', '임의 접수', '접수').
// 본 접수일 없이 특별공급·일반공급 상세만 있는 공고는 어느 단계가 본 접수인지 알 수 없어 null이다.
const receiptStageOf = (notice) => notice.stages.find((stage) => stage.name.endsWith('접수') && stage.start) ?? null;
// 접수 마감일이 오늘 이후면 아직 접수할 수 있다. 마감일이 없거나 시작일보다 이르면(잘못된 자료) 시작일 하루로 본다.
const isOpen = (stage, today) => {
  if (!stage) return false;
  const last = stage.end && stage.end >= stage.start ? stage.end : stage.start;
  return last >= today;
};
// 접수가 확실히 끝난 단계. 시작일과 마감일이 모두 있고 마감일이 시작일 이후이면서 오늘보다 이를 때만이다.
// 단계가 없거나 날짜가 비었거나 어긋나면 끝났다고 보지 않는다. 공고를 빼는 판단이라 isOpen보다 보수적으로 본다.
const hasEnded = (stage, today) => Boolean(stage?.start && stage.end && stage.end >= stage.start && stage.end < today);
const remainderTrack = (notice) => {
  if (notice.kind === 'arbitrary') return '임의공급';
  return notice.houseSecd === '06' ? '불법행위 재공급' : '무순위';
};
// 추천 전형 열과 관심 알림에 쓰는 짧은 이름. 거주 구분(해당지역, 기타경기, 기타지역)은 판별 근거의 추천 줄에만 적는다.
const REMAINDER_LABELS = { 무순위: '무순위', '불법행위 재공급': '재공급', 임의공급: '임의공급' };
const specialLabel = (track) => `특별(${track})`;
const GENERAL_LABEL = '1순위';
const CHECKS = '세대주·청약통장 요건 확인';

// ---------- 신청자별 후보 ----------
// 신청자 한 명이 접수할 수 있는 첫 후보(특별공급, 일반 1순위 순). 없으면 null이다.
// 결과의 kind는 'special', 'general', 'remainder'이고 track은 짧은 이름, name은 판별 근거에 적는 이름이다.
// tracks는 시점 요건과 통장으로 거른 뒤의 특별공급이다.
function applicantCandidate({ notice, models, applicant, tracks, config, today }) {
  if (!eligibleRegion(notice, applicant)) return null;
  if (notice.kind !== 'apt') {
    const main = mainStageOf(notice);
    if (!isOpen(main, today)) return null;
    const name = remainderTrack(notice);
    return { kind: 'remainder', track: REMAINDER_LABELS[name], name, date: main.start, end: main.end ?? null };
  }
  const category = residenceCategory(notice, applicant, config.recommendation);
  const generalStage = stageOf(notice, GENERAL_STAGES[category]);
  const general = isOpen(generalStage, today) ? { track: `1순위 ${category}`, stage: generalStage } : null;
  const special = pickSpecialTrack(models, tracks);
  const specialStage = stageOf(notice, '특별공급');
  if (special && isOpen(specialStage, today)) {
    return { kind: 'special', specialTrack: special.track, track: specialLabel(special.track), name: `${special.track} 특별공급`, date: specialStage.start, end: specialStage.end ?? null, units: special.units, general };
  }
  if (!general) return null;
  return { kind: 'general', track: GENERAL_LABEL, name: general.track, date: general.stage.start, end: general.stage.end ?? null, category };
}

const alsoGeneralText = (candidate) => (candidate.general ? `${candidate.general.track} ${shortDate(candidate.general.stage.start)}도 가능` : null);
const sameCityText = (candidate) => (candidate.category === '기타경기' ? '같은 시·군 거주면 해당지역' : null);

// v1 판별 근거 한 줄. 예전과 글자까지 같다.
function v1Text(candidate) {
  const date = shortDate(candidate.date);
  if (candidate.kind === 'remainder') return `추천: ${candidate.name} ${date}`;
  if (candidate.kind === 'special') {
    const also = alsoGeneralText(candidate);
    return `추천: ${candidate.name} ${date} (${candidate.units}세대${also ? `, ${also}` : ''}; ${CHECKS})`;
  }
  const sameCity = sameCityText(candidate);
  return `추천: ${candidate.name} ${date} (${CHECKS}${sameCity ? `, ${sameCity}` : ''})`;
}

// v2 신청자 한 명의 추천 조각(이름표 제외)
function segmentText(candidate, points) {
  const details = [];
  // LH 특별공급은 유형별 세대수를 몰라(units: null) 세대수를 적지 않는다.
  if (candidate.kind === 'special') details.push(Number.isFinite(candidate.units) ? `${candidate.units}세대` : null, alsoGeneralText(candidate));
  if (candidate.kind === 'general') details.push(sameCityText(candidate));
  if (points) details.push(`가점 약 ${points.total}점${points.account === null ? '(통장 제외)' : ''}`);
  const shown = details.filter(Boolean);
  return `${candidate.name} ${shortDate(candidate.date)}${shown.length > 0 ? ` (${shown.join(', ')})` : ''}`;
}

// 같은 조각은 이름표를 묶어 한 번만 적는다(예: 무순위는 신청자 모두 같다).
function joinSegments(items) {
  const groups = new Map();
  for (const { label, segment } of items) groups.set(segment, [...(groups.get(segment) ?? []), label]);
  return [...groups].map(([segment, labels]) => `${labels.join('·')} ${segment}`).join(' / ');
}

// 값을 몰라 막지 않은 통장 항목. APT 공고만 본다.
function accountChecks({ notice, applicant, deposit }) {
  if (!applicant.account || notice.kind !== 'apt') return [];
  const items = [];
  if (applicant.account.joined === null) items.push('통장 가입일');
  if (notice.sector === '국민' && applicant.account.payments === null) items.push('납입횟수');
  if (deposit.check) items.push(deposit.check);
  return items;
}

const monthsSince = (joined, at) => monthIndex(at) - monthIndex(joined);
// 1순위 통장 요건의 확인 기준(개월). 수도권은 규제지역이면 24개월이라, 규제 여부를 따지지 않고 24개월 미만이면 확인을 적는다.
const RANK1_MONTHS = { capital: 24, other: 12 };
const ACCOUNT_MIN_MONTHS = 6;
const MIN_PAYMENTS = { special: 6, rank1: 12 };

// 아는 통장 값으로 확실히 신청할 수 없는 것만 거른다. 결과는 { block, noSpecial }이고 각각 판별 근거에 적을 말이다.
// block: 가입 6개월 미만이라 특별공급도 1순위도 안 된다. noSpecial: 국민 공고에서 납입 6회 미만이라 특별공급이 안 된다.
export function accountGate({ notice, applicant, at }) {
  const none = { block: null, noSpecial: null };
  if (!applicant.account || notice.kind !== 'apt') return none;
  const { joined, payments } = applicant.account;
  if (joined && monthsSince(joined, at) < ACCOUNT_MIN_MONTHS) return { block: '통장 6개월 미만', noSpecial: null };
  if (notice.sector === '국민' && payments !== null && payments < MIN_PAYMENTS.special) return { block: null, noSpecial: '납입 6회 미만(특별공급 제외)' };
  return none;
}

// 1순위를 추천할 때 아는 통장 값이 기준에 못 미칠 수 있으면 막지 않고 확인을 적는다.
function rank1AccountChecks({ notice, applicant, at }) {
  if (!applicant.account || notice.kind !== 'apt') return [];
  const { joined, payments } = applicant.account;
  const need = CAPITAL_AREA.includes(notice.region) ? RANK1_MONTHS.capital : RANK1_MONTHS.other;
  const items = [];
  if (joined && monthsSince(joined, at) < need) items.push('통장 가입기간');
  if (notice.sector === '국민' && payments !== null && payments < MIN_PAYMENTS.rank1) items.push('납입 12회 미만');
  return items;
}

// 신청자 한 명의 결과. 대상이 아니면 null이고, 아니면 { applicant, index, candidate, remarks, checks }이다.
// candidate가 null이면 통장·예치금 때문에 신청할 수 없고 remarks에 그 까닭이 있다.
// remarks는 판별 근거에 그대로 적는 말, checks는 '확인:' 뒤에 적는 항목이다.
function applicantResult({ notice, models, applicant, household, config, today, index }) {
  const at = noticeBaseDate(notice, today);
  const trackChecks = new Map(applicant.specialTracks.map((track) => [track, specialTrackCheck(track, { applicant, household, notice, today })]));
  const tracks = applicant.specialTracks.filter((track) => trackChecks.get(track).valid);
  const first = applicantCandidate({ notice, models, applicant, tracks, config, today });
  if (!first) return null;
  const gate = accountGate({ notice, applicant, at });
  const deposit = depositCheck({ notice, models, applicant, config });
  const remarks = [];
  let candidate = first;
  if (gate.block) {
    remarks.push(gate.block);
    candidate = null;
  } else if (gate.noSpecial && first.kind === 'special') {
    remarks.push(gate.noSpecial);
    candidate = applicantCandidate({ notice, models, applicant, tracks: [], config, today });
  }
  // 예치금이 모자라면 민영 1순위와 민영 특별공급 모두 신청할 수 없다.
  if (candidate && deposit.short !== null) {
    remarks.push(`예치금 ${deposit.short}만 부족`);
    candidate = null;
  }
  if (!candidate) return remarks.length > 0 ? { applicant, index, candidate: null, remarks, checks: [] } : null;
  const checks = [...accountChecks({ notice, applicant, deposit })];
  if (candidate.kind === 'special') checks.push(...trackChecks.get(candidate.specialTrack).notes);
  if (candidate.kind === 'general') checks.push(...rank1AccountChecks({ notice, applicant, at }));
  return { applicant, index, candidate, remarks, checks: [...new Set(checks)] };
}

// 공고 단위 추천 고르기: 접수일이 가장 이른 신청자, 같으면 특별공급, 특별공급끼리는 SPECIAL_TRACKS 순서
// (신생아, 신혼부부, 생애최초), 그다음 신청자 순서다.
export function chooseApplicant(results) {
  const isSpecial = (result) => (result.candidate.kind === 'special' ? 1 : 0);
  // 목록에 없는 특별공급 이름은 맨 뒤로 보낸다. 특별공급이 아니면 서로 같다(isSpecial이 먼저 가른다).
  const trackRank = (result) => {
    if (result.candidate.kind !== 'special') return -1;
    const rank = SPECIAL_TRACKS.indexOf(result.candidate.specialTrack);
    return rank === -1 ? SPECIAL_TRACKS.length : rank;
  };
  return [...results].sort((a, b) => a.candidate.date.localeCompare(b.candidate.date) || isSpecial(b) - isSpecial(a) || trackRank(a) - trackRank(b) || a.index - b.index)[0] ?? null;
}

// 추천 전형 열의 짧은 이름. v1은 이름표가 없어 예전과 같다.
export const recommendLabel = (label, track) => (label ? `${label} ${track}` : track);

// ---------- LH 공공분양 ----------
// LH 단계 이름은 src/lh-detail-map.js의 lhStageName이 공급 일정의 접수 대상 이름으로 만든다:
// `특별공급 <이름>`, `1순위 <이름>`, `2순위 <이름>`, 무순위·잔여·추가는 이름 그대로다.
// LH 자료에는 특별공급 유형별 세대수가 없어 세대수가 아니라 단계 이름으로 전형을 고른다.
const LH_PENDING_STATES = ['failed', 'capped', 'supply_failed'];
const LH_REMAINDER_WORDS = ['무순위', '잔여', '추가'];
const LH_INCOME_CHECK = '소득·자산 기준 확인';
const LH_SAVING_NOTE = '공공분양 일반공급은 납입 인정 금액 순';
const squash = (value) => String(value ?? '').replace(/\s+/g, '');

const isLhSale = (notice, config) => notice.kind === 'lh' && lhTypeClass(notice, config.lh ?? {}) === 'sale';

// 추천을 계산하는 LH 공고: 분양 유형이고 상세·공급 조회가 성공해(lhDetailState ok) 단계가 있는 공고.
// 나눔형, 신혼희망타운, 토지임대부도 제한 유형이지만 접수 단계는 같아 추천한다.
export function lhRecommendable(notice, config) {
  return isLhSale(notice, config) && notice.lhDetailState === 'ok' && Array.isArray(notice.stages) && notice.stages.length > 0;
}

// 이번 실행에 LH 상세·공급 조회가 실패했거나 상한에 걸린 분양 공고. 단계를 몰라 저장된 추천을 그대로 둔다(src/lotto.js).
export function lhRecommendPending(notice, config) {
  return isLhSale(notice, config) && LH_PENDING_STATES.includes(notice.lhDetailState);
}

// LH 단계 이름이 가리키는 신청자 특별공급 전형(SPECIAL_TRACKS 순서). 신생아 → 신생아, 신혼부부·예비신혼부부 → 신혼부부,
// 생애최초 → 생애최초다. 다자녀, 노부모부양, 한부모가족, 기관추천, 청년 등은 신청자 전형이 아니라 빈 배열이다.
export function lhStageTracks(name) {
  const text = squash(name);
  return SPECIAL_TRACKS.filter((track) => text.includes(track));
}

const isLhRemainderStage = (stage) => !/^(특별공급|1순위|2순위)/.test(stage.name) && LH_REMAINDER_WORDS.some((word) => squash(stage.name).includes(word));
const openStages = (notice, today, match) => notice.stages.filter((stage) => stage.start && match(stage) && isOpen(stage, today));

// 전형에 맞는 열린 특별공급 단계. 신혼희망타운은 1순위 단계라도 이름에 신혼부부가 있으면 신혼부부 단계로 본다.
// 신혼부부 단계가 신혼부부와 예비신혼부부로 나뉘면 혼인하지 않은 세대(married: false)는 예비신혼부부, 그 밖은 신혼부부를 먼저 본다.
function lhSpecialStage({ notice, track, household, today, newlywedTown }) {
  const special = (stage) => stage.name.startsWith('특별공급') || (newlywedTown && stage.name.startsWith('1순위'));
  const stages = openStages(notice, today, (stage) => special(stage) && lhStageTracks(stage.name).includes(track));
  if (track !== '신혼부부') return stages[0] ?? null;
  const engaged = household?.married === false;
  return stages.find((stage) => squash(stage.name).includes('예비신혼부부') === engaged) ?? stages[0] ?? null;
}

// 열린 1순위 단계. 이름에 해당지역·기타지역이 적혀 있으면 신청자의 거주 구분과 어긋나는 단계는 고르지 않는다.
function lhRank1Stage({ notice, applicant, config, today }) {
  const local = residenceCategory(notice, applicant, config.recommendation) === '해당지역';
  const avoid = local ? '기타' : '해당';
  return openStages(notice, today, (stage) => stage.name.startsWith('1순위') && !squash(stage.name).includes(avoid))[0] ?? null;
}

// 신청자 한 명의 LH 후보(특별공급, 1순위, 무순위 순). 없으면 null이다. 모양은 applicantCandidate와 같고 units는 null이다.
// 특별공급은 신청자 전형 중 열린 단계가 있는 것을 신생아, 신혼부부, 생애최초 순으로 고른다(같은 날 특별공급 순서와 같다).
// 신혼희망타운은 신생아나 신혼부부 전형이 있으면 신혼부부 단계로 추천한다. checkTrack은 시점 요건 확인을 가져올 전형이다.
function lhApplicantCandidate({ notice, applicant, household, tracks, config, today }) {
  if (!eligibleRegion(notice, applicant)) return null;
  const newlywedTown = restrictedKeywords(notice, config.market).includes('신혼희망');
  const sources = new Map(tracks.map((track) => [track, track]));
  if (newlywedTown && !sources.has('신혼부부') && sources.has('신생아')) sources.set('신혼부부', '신생아');
  const rank1 = lhRank1Stage({ notice, applicant, config, today });
  const general = rank1 ? { track: rank1.name, stage: rank1 } : null;
  for (const track of SPECIAL_TRACKS) {
    if (!sources.has(track)) continue;
    const stage = lhSpecialStage({ notice, track, household, today, newlywedTown });
    if (stage) {
      return { kind: 'special', specialTrack: track, checkTrack: sources.get(track), track: specialLabel(track), name: `${track} 특별공급`, date: stage.start, end: stage.end ?? null, units: null, general };
    }
  }
  if (rank1) return { kind: 'general', track: GENERAL_LABEL, name: rank1.name, date: rank1.start, end: rank1.end ?? null, category: null };
  const remainder = openStages(notice, today, isLhRemainderStage)[0];
  if (remainder) return { kind: 'remainder', track: REMAINDER_LABELS.무순위, name: '무순위', date: remainder.start, end: remainder.end ?? null };
  return null;
}

// LH 신청자 한 명의 결과. applicantResult와 같은 모양이다. 통장·예치금은 보지 않는다(LH 공고에는 자료가 없다).
function lhApplicantResult({ notice, applicant, household, config, today, index }) {
  const trackChecks = new Map(applicant.specialTracks.map((track) => [track, specialTrackCheck(track, { applicant, household, notice, today })]));
  const tracks = applicant.specialTracks.filter((track) => trackChecks.get(track).valid);
  const candidate = lhApplicantCandidate({ notice, applicant, household, tracks, config, today });
  if (!candidate) return null;
  const checks = candidate.kind === 'special' ? trackChecks.get(candidate.checkTrack).notes : [];
  return { applicant, index, candidate, remarks: [], checks: [...new Set(checks)] };
}

// LH 추천 문구 끝에 붙일 안내. 소득·자산 기준은 늘 적고, 1순위를 추천하면 납입 인정 금액 순을 적는다.
const lhNotes = (candidates) => [LH_INCOME_CHECK, ...(candidates.some((candidate) => candidate.kind === 'general') ? [LH_SAVING_NOTE] : [])];

// 공고 하나의 추천. 결과는 { recommendation, text }이다.
// recommendation은 { track, date, end, text } 또는 null이고, text는 판별 근거에 붙일 줄(없으면 null)이다.
// v2에서 통장·예치금 때문에 아무도 신청할 수 없으면 recommendation은 null이고 text에 그 까닭을 적는다.
export function recommendForProfile({ notice, models, profile, config, today }) {
  const none = { recommendation: null, text: null };
  const target = toProfile(profile);
  if (!target) return none;
  const lh = lhRecommendable(notice, config);
  if (!RECOMMENDED_KINDS.includes(notice.kind) && !lh) return none;
  if (!lh && restrictedType(notice, config.market)) return none;
  const at = noticeBaseDate(notice, today);
  const resultOf = lh ? lhApplicantResult : applicantResult;
  const results = target.applicants
    .map((applicant, index) => resultOf({ notice, models, applicant, household: target.household, config, today, index }))
    .filter(Boolean);
  const able = results.filter((result) => result.candidate);
  const chosen = chooseApplicant(able);

  if (target.version === 1) {
    if (!chosen) return none;
    // LH는 v2와 같은 조각에 LH 안내를 붙인다. 청약홈 공고는 예전과 글자까지 같다.
    const text = lh ? [`추천: ${segmentText(chosen.candidate, null)}`, ...lhNotes([chosen.candidate])].join('; ') : v1Text(chosen.candidate);
    return { recommendation: { track: chosen.candidate.track, date: chosen.candidate.date, end: chosen.candidate.end, text }, text };
  }

  const showPoints = notice.kind === 'apt' && notice.sector !== '국민';
  const segments = able.map((result) => {
    const points = showPoints ? estimatePoints({ applicant: result.applicant, household: target.household, at }) : null;
    return { label: result.applicant.label, segment: segmentText(result.candidate, points), points };
  });
  const remarks = results.flatMap((result) => result.remarks.map((remark) => `${result.applicant.label} ${remark}`));
  const checks = able
    .filter((result) => result.checks.length > 0)
    .map((result) => `${result.applicant.label} ${result.checks.join('·')}`);
  if (!chosen && remarks.length === 0) return none;
  const parts = [chosen ? `추천: ${joinSegments(segments)}` : '추천 없음', ...remarks];
  if (checks.length > 0) parts.push(`확인: ${checks.join(', ')}`);
  if (chosen && notice.kind === 'apt') parts.push(CHECKS);
  if (chosen && lh) parts.push(...lhNotes(able.map((result) => result.candidate)));
  if (segments.some((item) => item.points)) parts.push('가점은 추정');
  const text = parts.join('; ');
  if (!chosen) return { recommendation: null, text };
  return {
    recommendation: { track: recommendLabel(chosen.applicant.label, chosen.candidate.track), date: chosen.candidate.date, end: chosen.candidate.end, text },
    text,
  };
}

// 추천이 없으면 null이다. 결과는 { track, date, end, text }이다. track은 짧은 이름이고 text는 판별 근거에 붙이는 한 줄이다.
// 신청자마다 접수가 끝나지 않은 첫 후보(특별공급, 일반 1순위 순)를 고르고, 모두 끝났으면 추천하지 않는다.
export function recommendTrack(options) {
  return recommendForProfile(options).recommendation;
}

// ---------- 신청할 수 없는 공고 ----------
// 신청자의 특별공급 세대가 이번 공고에 있을 수 있는지. 주택형 자료가 없거나 값이 하나라도 비어 알 수 없으면 있다고 본다.
// 빼는 판단이라 시점 요건으로 거르기 전의 적힌 전형을 그대로 본다.
function mayHaveSpecialUnits(models, tracks) {
  if (tracks.length === 0) return false;
  if (pickSpecialTrack(models, tracks)) return true;
  if (!Array.isArray(models) || models.length === 0) return true;
  return !models.every((model) => tracks.every((track) => Number.isFinite(model.specials?.[track])));
}

// 배치가 추천할 수 있는 전형의 접수가 모두 확실히 끝났는지. 필요한 단계가 없거나 날짜가 비면 끝나지 않았다고 본다.
function myTracksEnded({ notice, models, applicant, config, today }) {
  if (notice.kind !== 'apt') {
    // 본 접수 단계가 끝났고 다른 단계(특별공급·일반공급 상세)도 열려 있지 않을 때만이다. 본 접수일이 없으면 빼지 않는다.
    return hasEnded(receiptStageOf(notice), today) && !notice.stages.some((stage) => isOpen(stage, today));
  }
  const category = residenceCategory(notice, applicant, config.recommendation);
  if (!hasEnded(stageOf(notice, GENERAL_STAGES[category]), today)) return false;
  // 같은 시도 거주자는 실제 거주 구분이 추정과 다를 수 있다(공고마다 다른 거주 기간 요건, 경기의 같은 시·군).
  // 그래서 1순위 단계(해당, 경기, 기타)가 하나라도 열려 있으면 남긴다.
  if (notice.region === applicant.residenceSido && notice.stages.some((stage) => stage.name.startsWith('1순위') && isOpen(stage, today))) return false;
  // 2순위가 열려 있어도 보지 않는다.
  if (!mayHaveSpecialUnits(models, applicant.specialTracks)) return true;
  return hasEnded(stageOf(notice, '특별공급'), today);
}

// 지역 때문에 확실히 신청할 수 없는 공고. 수도권 거주자의 수도권 밖(세종 제외) APT 공고만이다.
// 수도권 밖 거주자는 기타지역이 광역 권역(예: 부산·울산·경남)을 따라 다르고, 무순위는 정해진 거주 요건이 없고 임의공급은 거주 요건이 없어 지역으로 빼지 않는다.
function surelyOutOfRegion(notice, applicant) {
  return notice.kind === 'apt'
    && CAPITAL_AREA.includes(applicant.residenceSido)
    && SIDO.includes(notice.region)
    && !CAPITAL_AREA.includes(notice.region)
    && !NATIONWIDE_REGIONS.includes(notice.region);
}

// 신청자 한 명에게 신청할 수 없는 공고인지. 결과는 null, 'region', 'ended' 중 하나다.
function applicantUnapplicable({ notice, models, applicant, config, today }) {
  if (!SIDO.includes(notice.region) || !SIDO.includes(applicant.residenceSido)) return null;
  if (surelyOutOfRegion(notice, applicant)) return 'region';
  if (!eligibleRegion(notice, applicant)) return null;
  return myTracksEnded({ notice, models, applicant, config, today }) ? 'ended' : null;
}

// 신청할 수 없는 공고를 가린다. 빼면 Notion에 저장하지 않는다. 결과는 null, 'region', 'ended' 중 하나다.
// 신청자 모두에게 신청할 수 없을 때만 뺀다. 모두 'region'이면 'region', 아니면 'ended'다.
// 'region'은 surelyOutOfRegion인 공고, 'ended'는 지역 대상인 공고 중 추천할 수 있는 전형의 접수가 모두 끝난 공고다.
// 신청자 정보가 없거나, 추천을 계산하지 않는 종류(LH, 오피스텔 등)거나, 제한 유형이거나, 지역을 확신할 수 없으면 빼지 않는다.
// 추천의 지역 규칙(eligibleRegion)으로 대상이 아니지만 확실하지 않은 공고는 접수 종료도 보지 않고 남긴다.
// models가 null이면 주택형 자료를 모르는 것으로 보고 특별공급 세대가 있을 수 있다고 본다.
// 통장·예치금 부족과 특별공급 시점 요건으로는 빼지 않는다(2순위와 공고문 확인이 남는다).
export function unapplicableReason({ notice, models, profile, config, today }) {
  const target = toProfile(profile);
  if (!target) return null;
  if (!RECOMMENDED_KINDS.includes(notice.kind)) return null;
  if (restrictedType(notice, config.market)) return null;
  const reasons = target.applicants.map((applicant) => applicantUnapplicable({ notice, models, applicant, config, today }));
  if (reasons.some((reason) => reason === null)) return null;
  return reasons.every((reason) => reason === 'region') ? 'region' : 'ended';
}
