import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppError, fetchWithRetry, maskValue, safeError } from './util.js';

const TOKEN_URL = 'https://kauth.kakao.com/oauth/token';

export async function refreshKakaoToken({ restKey, clientSecret, refreshToken, fetch, sleep }) {
  if (!restKey || !refreshToken) throw new AppError('kakao_refresh_env_missing');
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: restKey,
    refresh_token: refreshToken,
  });
  if (clientSecret) form.set('client_secret', clientSecret);
  const response = await fetchWithRetry(
    fetch,
    TOKEN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: form,
    },
    { kind: 'kakao_refresh', retries: 1, idempotent: false, sleep },
  );
  let body;
  try {
    body = await response.json();
  } catch {
    throw new AppError('kakao_refresh_parse');
  }
  if (!body?.access_token) throw new AppError('kakao_refresh_parse');
  return { accessToken: body.access_token, rotatedRefreshToken: body.refresh_token ?? null };
}

export async function runRefresh({ env = process.env, fetch = globalThis.fetch, write } = {}) {
  const tokens = await refreshKakaoToken({
    restKey: env.KAKAO_REST_KEY,
    clientSecret: env.KAKAO_CLIENT_SECRET,
    refreshToken: env.KAKAO_REFRESH_TOKEN,
    fetch,
  });
  maskValue(tokens.accessToken, env, write);
  maskValue(tokens.rotatedRefreshToken, env, write);
  const dir = env.RUNNER_TEMP;
  if (!dir) throw new AppError('runner_temp_missing');
  writeFileSync(join(dir, 'kakao_access'), tokens.accessToken, { mode: 0o600 });
  if (tokens.rotatedRefreshToken) {
    writeFileSync(join(dir, 'kakao_refresh'), tokens.rotatedRefreshToken, { mode: 0o600 });
  }
  return { rotated: Boolean(tokens.rotatedRefreshToken) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRefresh().then(
    ({ rotated }) => console.log(`kakao refresh ok, rotated=${rotated}`),
    (error) => {
      console.log(`kakao refresh failed: ${safeError(error)}`);
      process.exitCode = 1;
    },
  );
}
