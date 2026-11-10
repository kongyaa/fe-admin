import { safeHttpUrl } from '../util.js';
import { SEOUL_STAGES } from './seoul-redevelop.js';

// 청약홈 공고를 지도 사업에 잇는다. 같은 구·시가 먼저 맞아야 하고, 그다음 지번 또는 이름으로 본다.

// 공백과 '번지'를 뺀 비교용 문자열
export function compact(value) {
  return String(value ?? '').replace(/\s+/g, '').replace(/번지/g, '');
}

// '신영동158-2' -> '신영동158', '쌍문2동 81번지' -> '쌍문2동81', '신문로1가158' -> '신문로1가158'.
// 산 지번은 '신영동산12'처럼 '산'을 동 쪽에 붙여 둔다. 동 이름에 한글이 없거나 본번이 없으면 null.
// 지번이 여럿이면('이촌동193-3,5', '청담동65,삼성동53-2') 첫 지번만 쓴다.
export function lotKey(address) {
  const first = compact(address).split(/[,·]/)[0];
  const value = first.replace(/(일대|일원|외\d*필지|외)$/, '');
  const match = /^(.*?)(\d+)(?:-\d+)?$/.exec(value);
  if (!match || !/[가-힣]/.test(match[1]) || match[1].length < 2) return null;
  return `${match[1]}${match[2]}`;
}

// 구역명 비교값. '구역'과 공백을 빼고, 3글자 미만이면 오탐이 많아 쓰지 않는다.
export function zoneKey(name) {
  const value = compact(name).replace(/구역/g, '');
  return value.length >= 3 ? value : null;
}

// 숫자로 끝나는 key 바로 뒤에 오면 다른 것을 가리키는 글자: 숫자, 차, 단지, 동, 가
// (신당1 ≠ 신당10, 신길2 ≠ 신길2차·신길2동, 신영동158 ≠ 신영동1580)
const NUMBER_TAIL = /^(\d|차|단지|동|가)/;

// haystack에 key가 있고, key가 숫자로 끝나면 바로 뒤가 NUMBER_TAIL이 아닐 때만
export function containsToken(haystack, key) {
  if (!key) return false;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(key, from);
    if (index < 0) return false;
    if (!/\d$/.test(key) || !NUMBER_TAIL.test(haystack.slice(index + key.length))) return true;
    from = index + 1;
  }
}

// 시 이름에서 '시'를 뺀 부분 ('하남시' -> '하남'). 공고명에는 '시'가 없는 경우가 많다.
function cityStem(district) {
  const value = compact(district);
  const stem = value.replace(/시$/, '');
  return stem.length >= 2 ? stem : value;
}

export function matchesProject(project, notice) {
  if (project.region && notice.region && project.region !== notice.region) return false;
  const address = compact(notice.address);
  const name = compact(notice.name);
  if (project.region === '서울') {
    if (!project.district || !address.includes(compact(project.district))) return false;
    const lot = lotKey(project.address);
    if (lot && containsToken(address, lot)) return true;
    return containsToken(name, zoneKey(project.name));
  }
  const keys = (project.noticeMatch ?? []).map(compact).filter(Boolean);
  if (!project.district || keys.length === 0) return false;
  const both = `${address}|${name}`;
  if (!both.includes(cityStem(project.district))) return false;
  return keys.some((key) => both.includes(key));
}

export function noticeSummary(notice) {
  return {
    key: notice.key,
    name: notice.name,
    announceDate: notice.announceDate ?? null,
    end: notice.overallEnd ?? null,
    url: safeHttpUrl(notice.url),
    typeLabel: notice.typeLabel ?? null,
  };
}

const newestFirst = (a, b) => String(b.announceDate ?? '').localeCompare(String(a.announceDate ?? ''))
  || String(a.key).localeCompare(String(b.key));

// 서울 사업은 사업시행인가 전(구역지정·추진위·조합설립·건축심의)이면 자기 분양 공고가 있을 수 없다.
// 이때 맞는 공고는 같은 지번·구역명의 이웃 단지 공고라서 아예 잇지 않는다. 단계를 모르면 잇는다.
export function canLinkNotices(project) {
  if (project.region !== '서울') return true;
  const index = SEOUL_STAGES.indexOf(project.stage);
  return index < 0 || index >= SEOUL_STAGES.indexOf('사업시행인가');
}

// linked: 공고가 하나 이상 이어진 사업 수(사업시행인가 전 서울 사업은 세지 않음)
export function linkNotices(projects, notices, today) {
  // 같은 공고가 여러 번 오면 처음 것만 쓴다.
  const byKey = new Map();
  for (const notice of notices) if (notice?.key && !byKey.has(notice.key)) byKey.set(notice.key, notice);
  const unique = [...byKey.values()];
  let linked = 0;
  const result = projects.map((project) => {
    if (!canLinkNotices(project)) return { ...project, notices: [], live: false };
    const matched = unique.filter((notice) => matchesProject(project, notice));
    if (matched.length === 0) return project;
    linked += 1;
    return {
      ...project,
      notices: matched.map(noticeSummary).sort(newestFirst),
      live: matched.some((notice) => notice.overallEnd && notice.overallEnd >= today),
    };
  });
  return { projects: result, linked, checked: unique.length };
}
