import { AppError, fetchWithRetry, safeHttpUrl } from './util.js';

const SEND_URL = 'https://kapi.kakao.com/v2/api/talk/memo/default/send';
const MAX_TEXT = 200;
const FALLBACK_LINK = 'https://www.applyhome.co.kr';
const TAIL = '추정치이며 자격은 미판별. 공고문 확인 필수';
// 단계 이름 상한. 관심 알림의 추천 전형은 v2 신청자 이름표(6자)가 붙어 '신청자B 특별(신혼부부)'처럼 길어진다.
const STAGE_NAME_LENGTH = 20;

const cut = (value, length) => Array.from(String(value ?? '')).slice(0, length).join('');
const size = (value) => Array.from(value).length;

export function buildKakaoText({ notice, stage, reason, prefix = '[로또 청약]', verb = '오늘 시작' }) {
  const name = cut(notice.name, 50);
  const period = stage.end && stage.end !== stage.start ? `${stage.start}~${stage.end}` : stage.start;
  const head = `${prefix} ${name}\n${cut(stage.name, STAGE_NAME_LENGTH)} ${verb} ${period}`;
  const room = MAX_TEXT - size(head) - size(TAIL) - 2;
  const reasonLine = reason && room > 0 ? `\n${cut(reason, room)}` : '';
  return cut(`${head}${reasonLine}\n${TAIL}`, MAX_TEXT);
}

export function linkFor(url) {
  return safeHttpUrl(url) ?? FALLBACK_LINK;
}

// 발송은 재시도하면 중복될 수 있어 재시도하지 않는다.
export async function sendKakaoMemo({ token, text, url, fetch, sleep }) {
  if (!token) throw new AppError('kakao_token_missing');
  const link = linkFor(url);
  const template = {
    object_type: 'text',
    text: cut(text, MAX_TEXT),
    link: { web_url: link, mobile_web_url: link },
    button_title: '공고 보기',
  };
  const response = await fetchWithRetry(
    fetch,
    SEND_URL,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      },
      body: new URLSearchParams({ template_object: JSON.stringify(template) }),
    },
    { kind: 'kakao_send', retries: 0, idempotent: false, sleep },
  );
  let body;
  try {
    body = await response.json();
  } catch {
    throw new AppError('kakao_send_parse');
  }
  if (body?.result_code !== 0) throw new AppError('kakao_send_rejected');
}
