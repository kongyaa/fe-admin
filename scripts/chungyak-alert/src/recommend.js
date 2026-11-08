// 공고마다 지원할 전형과 그 접수일을 추천한다. 외부 호출과 입출력이 없는 순수 함수만 둔다.
// 소득, 자산, 세대주, 청약통장, 무주택 요건은 보지 않는다. 사용자가 공고문으로 확인해야 한다.
import { restrictedType } from './market-estimate.js';

export const SPECIAL_TRACKS = ['신생아', '신혼부부', '생애최초'];
const CAPITAL_AREA = ['서울', '경기', '인천'];

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

// 수도권 공고는 수도권 거주자가, 그 밖은 같은 시도 거주자가 1순위 대상이라고 본다.
function eligibleRegion(notice, profile) {
  if (!notice.region) return false;
  if (notice.region === profile.residenceSido) return true;
  return CAPITAL_AREA.includes(notice.region) && CAPITAL_AREA.includes(profile.residenceSido);
}

// 일반 1순위의 거주 구분. 서울·인천은 시도 전체가 해당지역이고, 경기는 시·군이 해당지역이라 같은 시·군인지 알 수 없어 기타경기로 본다.
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
// 접수 마감일이 오늘 이후면 아직 접수할 수 있다. 마감일이 없거나 시작일보다 이르면(잘못된 자료) 시작일 하루로 본다.
const isOpen = (stage, today) => {
  if (!stage) return false;
  const last = stage.end && stage.end >= stage.start ? stage.end : stage.start;
  return last >= today;
};
const remainderTrack = (notice) => {
  if (notice.kind === 'arbitrary') return '임의공급';
  return notice.houseSecd === '06' ? '불법행위 재공급' : '무순위';
};

// 추천이 없으면 null이다. 결과는 { track, date, end, text }이고 text는 판별 근거에 붙이는 한 줄이다.
// 접수가 끝나지 않은 첫 후보(특별공급, 일반 1순위 순)를 고르고, 모두 끝났으면 추천하지 않는다.
export function recommendTrack({ notice, models, profile, config, today }) {
  if (!profile) return null;
  if (!['apt', 'remainder', 'arbitrary'].includes(notice.kind)) return null;
  if (restrictedType(notice, config.market)) return null;
  if (!eligibleRegion(notice, profile)) return null;

  if (notice.kind !== 'apt') {
    const main = notice.stages.find((stage) => stage.start) ?? null;
    if (!isOpen(main, today)) return null;
    const track = remainderTrack(notice);
    return { track, date: main.start, end: main.end ?? null, text: `추천: ${track} ${shortDate(main.start)}` };
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
      track: `${special.track} 특별공급`,
      date: specialStage.start,
      end: specialStage.end ?? null,
      text: `추천: ${special.track} 특별공급 ${shortDate(specialStage.start)} (${special.units}세대${alsoGeneral}; ${checks})`,
    };
  }
  if (!general) return null;
  const sameCityNote = category === '기타경기' ? ', 같은 시·군 거주면 해당지역' : '';
  return {
    track: general.track,
    date: general.stage.start,
    end: general.stage.end ?? null,
    text: `추천: ${general.track} ${shortDate(general.stage.start)} (${checks}${sameCityNote})`,
  };
}
