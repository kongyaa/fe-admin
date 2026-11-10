import { AppError, fetchWithRetry, safeError, safeHttpUrl } from '../util.js';

// 지금 배포된 projects.json(이전 빌드)을 읽어 단계 변경을 찾는다. 실패해도 빌드는 계속한다(변경 없음, 실패 종류만 남김).

export const DEFAULT_PREVIOUS_URL = 'https://kongyaa.github.io/fe-admin/projects.json';

// 이전 수집 시각: 날짜('2026-11-10') 또는 시각('2026-11-10T07:30:00+09:00')만 받는다
const GENERATED_AT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?)?$/;

// 이전 자료의 꼴 검사. projects 배열이 없으면 previous_shape.
export function checkPrevious(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.projects)) throw new AppError('previous_shape');
  return {
    generatedAt: GENERATED_AT.test(String(data.generatedAt ?? '')) ? String(data.generatedAt) : null,
    projects: data.projects.filter((project) => project && typeof project.id === 'string'),
    feed: Array.isArray(data.feed) ? data.feed : [],
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('previous_json');
  }
}

/**
 * 이전 자료 읽기. file이 있으면 파일, 없으면 url(http(s)만). 어느 쪽도 없으면 skipped 'no_previous'.
 * 반환: { data: checkPrevious 결과 | null, skipped: 실패 종류 | null }. 절대 throw하지 않는다.
 * 한 번만 시도한다(배포된 파일이 없거나 느려도 빌드를 오래 붙잡지 않게).
 */
export async function loadPrevious({
  fetch = globalThis.fetch, url = null, file = null, readFile, sleep,
} = {}) {
  try {
    if (file) return { data: checkPrevious(parseJson(String(readFile(file)))), skipped: null };
    if (!url) return { data: null, skipped: 'no_previous' };
    const safe = safeHttpUrl(url);
    if (!safe) return { data: null, skipped: 'previous_url' };
    const response = await fetchWithRetry(fetch, safe, { headers: { accept: 'application/json' } }, {
      kind: 'previous', retries: 0, timeoutMs: 15000, sleep,
    });
    return { data: checkPrevious(parseJson(await response.text())), skipped: null };
  } catch (error) {
    const kind = safeError(error);
    return { data: null, skipped: kind === 'unexpected_error' ? 'previous_failed' : kind };
  }
}

// 단계가 바뀐 사업: 이전 자료와 지금 모두 있고 단계 값이 다른 사업. 사업 순서는 지금 목록 순서.
export function diffStages(previousProjects, projects) {
  const before = new Map((previousProjects ?? []).map((project) => [project.id, project.stage]));
  return projects.flatMap((project) => {
    const from = before.get(project.id);
    if (typeof from !== 'string' || !from || from === project.stage) return [];
    return [{ projectId: project.id, from, to: project.stage }];
  });
}

// changes 출력: { since: 이전 수집 시각 | null, items }. 이전 자료가 없으면 since null, items 빈 배열.
export function buildChanges(previous, projects) {
  if (!previous) return { since: null, items: [] };
  return { since: previous.generatedAt, items: diffStages(previous.projects, projects) };
}
