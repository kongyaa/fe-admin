const KST_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function kstToday(now = new Date()) {
  const parts = Object.fromEntries(KST_FORMAT.formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function toUtcDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(dateStr, days) {
  const date = toUtcDate(dateStr);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// 0 = 일요일 ... 6 = 토요일
export function weekdayOf(dateStr) {
  return toUtcDate(dateStr).getUTCDay();
}

export function weekRange(dateStr) {
  const fromMonday = (weekdayOf(dateStr) + 6) % 7;
  const monday = addDays(dateStr, -fromMonday);
  return { monday, sunday: addDays(monday, 6) };
}

// 진행 중인 달을 뺀 최근 n개 완결 월 (YYYYMM, 최신순)
export function completeMonths(dateStr, count) {
  let year = Number(dateStr.slice(0, 4));
  let month = Number(dateStr.slice(5, 7));
  const months = [];
  for (let i = 0; i < count; i += 1) {
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
    months.push(`${year}${String(month).padStart(2, '0')}`);
  }
  return months;
}

// YYYY-MM-DD, YYYYMMDD, YYYY.MM.DD를 YYYY-MM-DD로 통일한다. 달력에 없는 날짜는 null.
export function normalizeDate(value) {
  if (value === null || value === undefined) return null;
  const match = /^(\d{4})[-.]?(\d{2})[-.]?(\d{2})(?!\d)/.exec(String(value).trim());
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  const date = toUtcDate(iso);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function parseNumber(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/,/g, '').trim();
  if (cleaned === '') return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

export function normalizeRegion(name) {
  const token = String(name ?? '').trim().split(/\s+/)[0] ?? '';
  if (token.startsWith('서울')) return '서울';
  if (token.startsWith('인천')) return '인천';
  if (token.startsWith('경기')) return '경기';
  return token.replace(/(특별자치시|특별자치도|광역시|특별시|도)$/, '') || null;
}

// 오류 문구는 공개 로그에 남으므로 kind에는 고정 식별자만 넣는다.
export class AppError extends Error {
  constructor(kind) {
    super(kind);
    this.name = 'AppError';
    this.kind = kind;
  }
}

export function safeError(error) {
  if (error instanceof AppError) return error.kind;
  if (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(error.code)) {
    return `error_${error.code}`;
  }
  return error?.name === 'TimeoutError' ? 'timeout' : 'unexpected_error';
}

export const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// idempotent=false면 중복 실행을 막기 위해 429만 재시도한다.
export async function fetchWithRetry(fetchFn, url, init = {}, options = {}) {
  const {
    kind = 'http',
    retries = 2,
    timeoutMs = 20000,
    backoffMs = 500,
    idempotent = true,
    sleep = defaultSleep,
  } = options;
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (!idempotent || attempt >= retries) {
        throw new AppError(`${kind}_${error?.name === 'TimeoutError' ? 'timeout' : 'network'}`);
      }
      await sleep(backoffMs * 2 ** attempt);
      continue;
    }
    if (response.ok) return response;
    const retryable = response.status === 429 || (idempotent && response.status >= 500);
    if (!retryable || attempt >= retries) throw new AppError(`${kind}_http_${response.status}`);
    const retryAfter = Number(response.headers?.get?.('retry-after'));
    await response.body?.cancel?.();
    await sleep(retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : backoffMs * 2 ** attempt);
  }
}

// data.go.kr은 인코딩·디코딩 키를 모두 발급한다. 내부에서는 디코딩 값으로 통일한다.
export function decodeServiceKey(key) {
  if (!key || !key.includes('%')) return key;
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

export function maskValue(value, env, write = (line) => process.stdout.write(`${line}\n`)) {
  if (value && env.GITHUB_ACTIONS) write(`::add-mask::${value}`);
}

// 여러 줄일 수 있는 값은 줄마다 가린다. ::add-mask::는 한 줄 명령이라 여러 줄 값을 한 번에 넘기면
// 첫 줄만 가려지고 둘째 줄부터는 일반 로그로 찍힌다. 괄호와 쉼표만 있는 줄은 정보가 없어 가리지 않는다.
export function maskLines(value, env, write) {
  if (!value) return;
  for (const line of String(value).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^[{}[\],:]*$/.test(trimmed)) continue;
    maskValue(trimmed, env, write);
  }
}

export function maskServiceKey(key, env, write) {
  if (!key) return;
  const variants = new Set([
    key,
    encodeURIComponent(key),
    new URLSearchParams({ k: key }).toString().slice(2),
  ]);
  for (const variant of variants) maskValue(variant, env, write);
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function safeHttpUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function firstStageDate(stages, prefix) {
  const starts = stages
    .filter((stage) => stage.name.startsWith(prefix) && stage.start)
    .map((stage) => stage.start)
    .sort();
  return starts[0] ?? null;
}

// 종료일이 없는 단계는 시작일을 종료일로 본다. 가장 늦은 종료일이 그렇게 채운 값이면(실제 종료일이 아님) endInferred를 켠다.
// 접수 상태는 이 값으로 마감을 단정하지 않는다. 아니면 필드를 두지 않는다.
export function withOverall(notice) {
  const { endInferred: _stale, ...rest } = notice;
  const starts = notice.stages.map((stage) => stage.start).filter(Boolean).sort();
  const ends = notice.stages.map((stage) => stage.end ?? stage.start).filter(Boolean).sort();
  const overallEnd = ends.at(-1) ?? null;
  const inferred = overallEnd !== null && !notice.stages.some((stage) => stage.end && stage.end === overallEnd);
  return { ...rest, overallStart: starts[0] ?? null, overallEnd, ...(inferred ? { endInferred: true } : {}) };
}
