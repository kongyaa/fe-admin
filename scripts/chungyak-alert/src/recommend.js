// 공고마다 지원할 전형과 그 접수일을 추천한다. 외부 호출과 입출력이 없는 순수 함수만 둔다.
// 소득, 자산, 세대주, 청약통장, 무주택 요건은 보지 않는다. 사용자가 공고문으로 확인해야 한다.
import { restrictedType } from './market-estimate.js';

export const SPECIAL_TRACKS = ['신생아', '신혼부부', '생애최초'];
const CAPITAL_AREA = ['서울', '경기', '인천'];
// 추천을 계산하는 공고 종류. 신청할 수 없는 공고를 가릴 때도 이 종류만 본다.
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

// GitHub Secret CHUNGYAK_PROFILE의 JSON을 읽는다. 문제가 있으면 기능을 끄고 원인 종류만 돌려준다.
// 예(가짜 값): {"residenceSido":"인천","residenceYears":3,"specialTracks":["생애최초"]}
export function parseProfile(text) {
  if (text === undefined || text === null || String(text).trim() === '') return { profile: null, status: 'missing' };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { profile: null, status: 'invalid' };
  }
  const tracks = value?.specialTracks ?? [];
  const valid = value
    && typeof value === 'object'
    && typeof value.residenceSido === 'string'
    && value.residenceSido.trim() !== ''
    && Number.isFinite(value.residenceYears)
    && value.residenceYears >= 0
    && Array.isArray(tracks)
    && tracks.every((track) => SPECIAL_TRACKS.includes(track));
  if (!valid) return { profile: null, status: 'invalid' };
  return {
    profile: { residenceSido: value.residenceSido.trim(), residenceYears: value.residenceYears, specialTracks: [...new Set(tracks)] },
    status: 'ok',
  };
}

// 수도권 공고는 수도권 거주자가, 그 밖은 같은 시도 거주자가 1순위 대상이라고 본다. 세종 공고는 모든 거주자가 대상이다.
function eligibleRegion(notice, profile) {
  if (!notice.region) return false;
  if (notice.region === profile.residenceSido) return true;
  if (NATIONWIDE_REGIONS.includes(notice.region)) return true;
  return CAPITAL_AREA.includes(notice.region) && CAPITAL_AREA.includes(profile.residenceSido);
}

// 일반 1순위의 거주 구분. 서울·인천은 시도 전체가 해당지역이고, 경기는 시·군이 해당지역이라 같은 시·군인지 알 수 없어 기타경기로 본다.
// 다른 시도 거주자의 세종 공고는 기타지역이다(1순위 기타 단계).
export function residenceCategory(notice, profile, recommendation) {
  if (notice.region !== profile.residenceSido) return '기타지역';
  if (notice.region === '경기') return '기타경기';
  return profile.residenceYears >= recommendation.localResidenceYears ? '해당지역' : '기타지역';
}

const shortDate = (date) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

// 프로필의 특별공급 중 이번 공고에 세대가 있는 것. 세대가 가장 많은 것, 같으면 신생아, 신혼부부, 생애최초 순이다.
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

// 추천이 없으면 null이다. 결과는 { track, date, end, text }이다. track은 짧은 이름이고 text는 판별 근거에 붙이는 한 줄이다.
// 접수가 끝나지 않은 첫 후보(특별공급, 일반 1순위 순)를 고르고, 모두 끝났으면 추천하지 않는다.
export function recommendTrack({ notice, models, profile, config, today }) {
  if (!profile) return null;
  if (!RECOMMENDED_KINDS.includes(notice.kind)) return null;
  if (restrictedType(notice, config.market)) return null;
  if (!eligibleRegion(notice, profile)) return null;

  if (notice.kind !== 'apt') {
    const main = mainStageOf(notice);
    if (!isOpen(main, today)) return null;
    const name = remainderTrack(notice);
    return { track: REMAINDER_LABELS[name], date: main.start, end: main.end ?? null, text: `추천: ${name} ${shortDate(main.start)}` };
  }

  const category = residenceCategory(notice, profile, config.recommendation);
  const generalStage = stageOf(notice, GENERAL_STAGES[category]);
  const general = isOpen(generalStage, today) ? { track: `1순위 ${category}`, stage: generalStage } : null;
  const special = pickSpecialTrack(models, profile.specialTracks);
  const specialStage = stageOf(notice, '특별공급');
  const specialOpen = isOpen(specialStage, today);
  const checks = '세대주·청약통장 요건 확인';

  if (special && specialOpen) {
    const alsoGeneral = general ? `, ${general.track} ${shortDate(general.stage.start)}도 가능` : '';
    return {
      track: specialLabel(special.track),
      date: specialStage.start,
      end: specialStage.end ?? null,
      text: `추천: ${special.track} 특별공급 ${shortDate(specialStage.start)} (${special.units}세대${alsoGeneral}; ${checks})`,
    };
  }
  if (!general) return null;
  const sameCityNote = category === '기타경기' ? ', 같은 시·군 거주면 해당지역' : '';
  return {
    track: GENERAL_LABEL,
    date: general.stage.start,
    end: general.stage.end ?? null,
    text: `추천: ${general.track} ${shortDate(general.stage.start)} (${checks}${sameCityNote})`,
  };
}

// 프로필의 특별공급 세대가 이번 공고에 있을 수 있는지. 주택형 자료가 없거나 값이 하나라도 비어 알 수 없으면 있다고 본다.
function mayHaveSpecialUnits(models, tracks) {
  if (tracks.length === 0) return false;
  if (pickSpecialTrack(models, tracks)) return true;
  if (!Array.isArray(models) || models.length === 0) return true;
  return !models.every((model) => tracks.every((track) => Number.isFinite(model.specials?.[track])));
}

// 배치가 추천할 수 있는 전형의 접수가 모두 확실히 끝났는지. 필요한 단계가 없거나 날짜가 비면 끝나지 않았다고 본다.
function myTracksEnded({ notice, models, profile, config, today }) {
  if (notice.kind !== 'apt') {
    // 본 접수 단계가 끝났고 다른 단계(특별공급·일반공급 상세)도 열려 있지 않을 때만이다. 본 접수일이 없으면 빼지 않는다.
    return hasEnded(receiptStageOf(notice), today) && !notice.stages.some((stage) => isOpen(stage, today));
  }
  const category = residenceCategory(notice, profile, config.recommendation);
  if (!hasEnded(stageOf(notice, GENERAL_STAGES[category]), today)) return false;
  // 같은 시도 거주자는 실제 거주 구분이 추정과 다를 수 있다(공고마다 다른 거주 기간 요건, 경기의 같은 시·군).
  // 그래서 1순위 단계(해당, 경기, 기타)가 하나라도 열려 있으면 남긴다.
  if (notice.region === profile.residenceSido && notice.stages.some((stage) => stage.name.startsWith('1순위') && isOpen(stage, today))) return false;
  // 2순위가 열려 있어도 보지 않는다.
  if (!mayHaveSpecialUnits(models, profile.specialTracks)) return true;
  return hasEnded(stageOf(notice, '특별공급'), today);
}

// 지역 때문에 확실히 신청할 수 없는 공고. 수도권 거주자의 수도권 밖(세종 제외) APT 공고만이다.
// 수도권 밖 거주자는 기타지역이 광역 권역(예: 부산·울산·경남)을 따라 다르고, 무순위는 정해진 거주 요건이 없고 임의공급은 거주 요건이 없어 지역으로 빼지 않는다.
function surelyOutOfRegion(notice, profile) {
  return notice.kind === 'apt'
    && CAPITAL_AREA.includes(profile.residenceSido)
    && SIDO.includes(notice.region)
    && !CAPITAL_AREA.includes(notice.region)
    && !NATIONWIDE_REGIONS.includes(notice.region);
}

// 신청할 수 없는 공고를 가린다. 빼면 Notion에 저장하지 않는다. 결과는 null, 'region', 'ended' 중 하나다.
// 'region'은 surelyOutOfRegion인 공고, 'ended'는 지역 대상인 공고 중 추천할 수 있는 전형의 접수가 모두 끝난 공고다.
// 프로필이 없거나, 추천을 계산하지 않는 종류(LH, 오피스텔 등)거나, 제한 유형이거나, 지역을 확신할 수 없으면 빼지 않는다.
// 추천의 지역 규칙(eligibleRegion)으로 대상이 아니지만 확실하지 않은 공고는 접수 종료도 보지 않고 남긴다.
// models가 null이면 주택형 자료를 모르는 것으로 보고 특별공급 세대가 있을 수 있다고 본다.
export function unapplicableReason({ notice, models, profile, config, today }) {
  if (!profile) return null;
  if (!RECOMMENDED_KINDS.includes(notice.kind)) return null;
  if (restrictedType(notice, config.market)) return null;
  if (!SIDO.includes(notice.region) || !SIDO.includes(profile.residenceSido)) return null;
  if (surelyOutOfRegion(notice, profile)) return 'region';
  if (!eligibleRegion(notice, profile)) return null;
  return myTracksEnded({ notice, models, profile, config, today }) ? 'ended' : null;
}
