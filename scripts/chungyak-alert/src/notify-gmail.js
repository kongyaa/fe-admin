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

export function buildWeeklyMail({ items, monday, sunday, warning = null, testMark = false }) {
  const prefix = testMark ? '[테스트] ' : '';
  const subject = `${prefix}[청약] 금주 일정 ${monday} ~ ${sunday} (${items.length}건)`;
  const rows = items.map(({ notice, status, weekStages }) => {
    const lotto = status === '로또' ? '<strong>[로또]</strong> ' : '';
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
  const html = `${testMark ? '<p><strong>테스트 발송입니다.</strong></p>' : ''}${warningHtml}${table}<p>${escapeHtml(DISCLAIMER)}</p>`;
  const lines = items.map(({ notice, status, weekStages }) => {
    const stages = weekStages.map((stage) => `${stage.name} ${stage.start}`).join(', ');
    return `${status === '로또' ? '[로또] ' : ''}${notice.name} (${notice.region}) ${stages}`;
  });
  const text = [warning, ...lines, DISCLAIMER].filter(Boolean).join('\n');
  return { subject, text, html };
}

export function buildUrgentMail({ notice, text, url }) {
  const safeUrl = safeHttpUrl(url);
  const body = safeUrl ? `${text}\n${safeUrl}` : text;
  return {
    subject: `[청약 긴급] ${notice.name}`,
    text: body,
    html: `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>${safeUrl ? `<p><a href="${escapeHtml(safeUrl)}">공고 보기</a></p>` : ''}`,
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
