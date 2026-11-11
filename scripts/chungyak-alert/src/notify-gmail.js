import nodemailer from 'nodemailer';
import { AppError, escapeHtml, safeHttpUrl } from './util.js';

export const DISCLAIMER = '로또 여부, 시세, 안전 마진은 실거래가 기반 추정치이며, 지원 자격은 판별하지 않습니다. 반드시 공고문을 확인하세요.';

export function createGmailSender({ user, password, to, createTransport = nodemailer.createTransport }) {
  return async ({ subject, text, html }) => {
    if (!user || !password || !to) throw new AppError('gmail_env_missing');
    const transport = createTransport({
      service: 'gmail',
      auth: { user, pass: password },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 60000,
      dnsTimeout: 10000,
    });
    try {
      await transport.sendMail({ from: user, to, subject, text, html });
    } catch (error) {
      throw new AppError(`gmail_${/^E[A-Z]+$/.test(error?.code ?? '') ? error.code : 'send_failed'}`);
    }
  };
}

// 확인 필요(조건에는 해당하나 시세 근거가 약함) 공고를 로또와 떨어뜨려 적는 별도 구역이다.
export const CHECK_SECTION_TITLE = '확인 필요(시세 근거 약함)';

const CHECK_SECTION_NOTE = '로또라고 단정하기 어려워 긴급 알림은 보내지 않았습니다. 공고문과 시세를 직접 확인하세요.';

const marginRateLabel = (rate) => (Number.isFinite(rate) ? `마진율 ${(rate * 100).toFixed(1)}%` : '마진율 없음');

// 마진율과 신뢰도는 여기서만 적는다. checkNote(사유)에는 같은 말을 넣지 않는다.
const checkDetail = ({ marginRate, confidence, checkNote }) => [marginRateLabel(marginRate), confidence ? `신뢰도 ${confidence}` : null, checkNote].filter(Boolean).join(', ');

const tagOf = (status) => ({ 로또: '[로또] ', '확인 필요': '[확인 필요] ' })[status] ?? '';

export function buildWeeklyMail({ items, monday, sunday, warning = null, testMark = false }) {
  const prefix = testMark ? '[테스트] ' : '';
  const subject = `${prefix}[청약] 금주 일정 ${monday} ~ ${sunday} (${items.length}건)`;
  const rows = items.map(({ notice, status, weekStages }) => {
    const lotto = status === '로또' ? '<strong>[로또]</strong> ' : escapeHtml(tagOf(status));
    const stages = weekStages
      .map((stage) => `${escapeHtml(stage.name)}: ${escapeHtml(stage.start)}${stage.end && stage.end !== stage.start ? ` ~ ${escapeHtml(stage.end)}` : ''}`)
      .join('<br>');
    const url = safeHttpUrl(notice.url);
    const link = url ? `<a href="${escapeHtml(url)}">공고</a>` : '-';
    return `<tr><td>${lotto}${escapeHtml(notice.name)}</td><td>${escapeHtml(notice.typeLabel)}</td><td>${escapeHtml(notice.region)}</td><td>${stages}</td><td>${link}</td></tr>`;
  });
  const warningHtml = warning ? `<p><strong>${escapeHtml(warning)}</strong></p>` : '';
  const table = items.length > 0
    ? `<table border="1" cellpadding="6" cellspacing="0"><thead><tr><th>주택명</th><th>유형</th><th>지역</th><th>금주 일정</th><th>링크</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
    : '<p>금주 수도권 접수 일정이 없습니다.</p>';
  // 확인 필요 구역은 해당 공고가 있을 때만 붙인다.
  // 이번 실행에서 판정한 항목(checkNote가 있는 것)만 적는다. 판정하지 않고 저장된 상태만 가져온 공고는 마진율과 사유를 몰라 뺀다.
  const checks = items.filter((item) => item.status === '확인 필요' && item.checkNote);
  const checkItems = checks.map((item) => `<li>${escapeHtml(item.notice.name)} (${escapeHtml(item.notice.region)}): ${escapeHtml(checkDetail(item))}</li>`).join('');
  const checkHtml = checks.length > 0 ? `<h3>${escapeHtml(CHECK_SECTION_TITLE)}</h3><p>${escapeHtml(CHECK_SECTION_NOTE)}</p><ul>${checkItems}</ul>` : '';
  const html = `${testMark ? '<p><strong>테스트 발송입니다.</strong></p>' : ''}${warningHtml}${table}${checkHtml}<p>${escapeHtml(DISCLAIMER)}</p>`;
  const lines = items.map(({ notice, status, weekStages }) => {
    const stages = weekStages.map((stage) => `${stage.name} ${stage.start}`).join(', ');
    return `${tagOf(status)}${notice.name} (${notice.region}) ${stages}`;
  });
  const checkLines = checks.length > 0
    ? [CHECK_SECTION_TITLE, CHECK_SECTION_NOTE, ...checks.map((item) => `- ${item.notice.name} (${item.notice.region}): ${checkDetail(item)}`)]
    : [];
  const text = [warning, ...lines, ...checkLines, DISCLAIMER].filter(Boolean).join('\n');
  return { subject, text, html };
}

export function buildUrgentMail({ notice, text, url, reason = null }) {
  const safeUrl = safeHttpUrl(url);
  const detail = reason ? `\n\n판별 근거: ${reason}` : '';
  const body = `${text}${detail}${safeUrl ? `\n${safeUrl}` : ''}`;
  return {
    subject: `[청약 긴급] ${notice.name}`,
    text: body,
    html: `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>${reason ? `<p>판별 근거: ${escapeHtml(reason)}</p>` : ''}${safeUrl ? `<p><a href="${escapeHtml(safeUrl)}">공고 보기</a></p>` : ''}`,
  };
}

export function buildErrorMail(errorCounts, today) {
  const lines = [...errorCounts].map(([kind, count]) => `${kind} x${count}`);
  return {
    subject: `[청약] 배치 오류 ${today} (${lines.length}종)`,
    text: lines.join('\n'),
    html: `<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`,
  };
}
