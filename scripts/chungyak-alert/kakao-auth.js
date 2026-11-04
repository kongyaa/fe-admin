// 최초 1회 로컬에서 실행해 갱신 토큰을 .kakao-token.txt에 저장한다. 토큰은 화면에 출력하지 않는다.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = 8080;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const TOKEN_FILE = new URL('./.kakao-token.txt', import.meta.url);

const restKey = process.env.KAKAO_REST_KEY;
const clientSecret = process.env.KAKAO_CLIENT_SECRET;
if (!restKey) {
  console.log('KAKAO_REST_KEY 환경 변수를 먼저 설정하세요.');
  process.exit(1);
}

const state = randomBytes(16).toString('hex');
const authorizeUrl = new URL('https://kauth.kakao.com/oauth/authorize');
authorizeUrl.search = new URLSearchParams({
  response_type: 'code',
  client_id: restKey,
  redirect_uri: REDIRECT_URI,
  scope: 'talk_message',
  state,
}).toString();

async function exchange(code) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: restKey,
    redirect_uri: REDIRECT_URI,
    code,
  });
  if (clientSecret) form.set('client_secret', clientSecret);
  const response = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: form,
  });
  if (!response.ok) throw new Error(`토큰 발급 실패 (HTTP ${response.status})`);
  const body = await response.json();
  if (!body.refresh_token) throw new Error('응답에 갱신 토큰이 없습니다.');
  writeFileSync(TOKEN_FILE, body.refresh_token, { mode: 0o600 });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }
  const finish = (message, exitCode) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(message);
    console.log(message);
    server.close(() => process.exit(exitCode));
  };
  if (url.searchParams.get('state') !== state || !url.searchParams.get('code')) {
    finish('인증 실패: 응답이 올바르지 않습니다.', 1);
    return;
  }
  try {
    await exchange(url.searchParams.get('code'));
    finish('완료: .kakao-token.txt에 저장했습니다. 이 창을 닫으세요.', 0);
  } catch (error) {
    finish(error.message, 1);
  }
});

server.on('error', (error) => {
  console.log(error.code === 'EADDRINUSE'
    ? `포트 ${PORT}을 다른 프로그램이 쓰고 있습니다. 그 프로그램을 끄고 다시 실행하세요.`
    : `서버를 시작하지 못했습니다 (${error.code ?? '알 수 없는 오류'}).`);
  process.exit(1);
});

server.listen(PORT, 'localhost', () => {
  console.log('브라우저에서 아래 주소를 열어 동의하세요.');
  console.log(authorizeUrl.href);
});
