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

// 이전 자료 크기 상한(지금 약 0.5MB). 넘으면 previous_too_large로 건너뛴다.
export const MAX_PREVIOUS_BYTES = 10 * 1024 * 1024;

function checkSize(bytes) {
  if (bytes > MAX_PREVIOUS_BYTES) throw new AppError('previous_too_large');
}

/**
 * 이전 자료 읽기. file이 있으면 파일, 없으면 url(http(s)만). 어느 쪽도 없으면 skipped 'no_previous'.
 * 반환: { data: checkPrevious 결과 | null, skipped: 실패 종류 | null }. 절대 throw하지 않는다.
 * 받기는 한 번 더 시도한다(retries 1). 그래도 못 받으면 이어 오던 단계 소식은 이번 빌드에서 끊긴다(받아들인 손실, docs/MAP.md).
 * 10MB를 넘는 자료는 읽지 않는다(Content-Length를 먼저 보고, 없으면 받은 뒤 크기를 본다).
 */
export async function loadPrevious({
  fetch = globalThis.fetch, url = null, file = null, readFile, sleep,
} = {}) {
  try {
    if (file) {
      const raw = readFile(file);
      checkSize(Buffer.byteLength(raw));
      return { data: checkPrevious(parseJson(String(raw))), skipped: null };
    }
    if (!url) return { data: null, skipped: 'no_previous' };
    const safe = safeHttpUrl(url);
    if (!safe) return { data: null, skipped: 'previous_url' };
    const response = await fetchWithRetry(fetch, safe, { headers: { accept: 'application/json' } }, {
      kind: 'previous', retries: 1, timeoutMs: 15000, sleep,
    });
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_PREVIOUS_BYTES) {
      await response.body?.cancel?.();
      throw new AppError('previous_too_large');
    }
    const text = await response.text();
    checkSize(Buffer.byteLength(text));
    return { data: checkPrevious(parseJson(text)), skipped: null };
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
