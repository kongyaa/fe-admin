import nodemailer from 'nodemailer';
import { GRADE, gradeFromStatus } from './grade.js';
import { AppError, escapeHtml, safeHttpUrl } from './util.js';

export const DISCLAIMER = '청약 등급, 시세, 안전 마진은 실거래가 기반 추정치이며, 지원 자격은 판별하지 않습니다. 반드시 공고문을 확인하세요.';

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

// 주간 메일의 등급별 구역. 패스는 싣지 않고 건수만 적는다. 로또청약은 접수 시작일에 긴급 알림이 가고, 나머지는 메일과 Notion 표에만 남는다.
const SECTIONS = [
  { grade: GRADE.LOTTO, note: null },
  { grade: GRADE.CONSIDER, note: '가격, 입지, 환금성, 대안을 함께 따져 볼 만한 공고입니다.' },
  { grade: GRADE.NO_MARGIN, note: '시세 수준의 분양가입니다. 실거주로 접근하세요.' },
  { grade: GRADE.HOLD, note: '근거 부족, 공고문과 시세 직접 확인. 긴급 알림은 보내지 않았습니다.' },
];

// 구역마다 싣는 최대 공고 수. 넘으면 앞에서부터 싣고 나머지는 건수로 알린다. 로또청약은 자르지 않는다.
export const WEEKLY_SECTION_MAX = 20;

// 등급이 없는 항목(예전 저장 값만 있는 행, 판정하지 않은 행)은 근거가 부족한 것으로 보고 판정 보류에 둔다.
const gradeOfItem = (item) => item.grade ?? gradeFromStatus(item.status) ?? GRADE.HOLD;

const detailOf = (item) => item.gradeDetail ?? '';

const sectionHead = ({ grade }, count) => `${grade} ${count}건`;

function selectSections(items) {
  const hiddenPass = items.filter((item) => gradeOfItem(item) === GRADE.PASS).length;
  const sections = SECTIONS.map((section) => {
    const all = items.filter((item) => gradeOfItem(item) === section.grade);
    const shown = section.grade === GRADE.LOTTO ? all : all.slice(0, WEEKLY_SECTION_MAX);
    return { ...section, all, shown, omitted: all.length - shown.length };
  }).filter((section) => section.all.length > 0);
  return { sections, hiddenPass, shownCount: sections.reduce((sum, section) => sum + section.all.length, 0) };
}

const stageText = (stage) => `${stage.name}: ${stage.start}${stage.end && stage.end !== stage.start ? ` ~ ${stage.end}` : ''}`;

export function buildWeeklyMail({ items, monday, sunday, warning = null, testMark = false }) {
  const prefix = testMark ? '[테스트] ' : '';
  const { sections, hiddenPass, shownCount } = selectSections(items);
  const subject = `${prefix}[청약] 금주 일정 ${monday} ~ ${sunday} (${shownCount}건)`;
  const passNote = hiddenPass > 0 ? `패스 ${hiddenPass}건은 싣지 않았습니다.` : '';
  const tableOf = (section) => {
    const rows = section.shown.map((item) => {
      const { notice, weekStages } = item;
      const stages = weekStages.map((stage) => escapeHtml(stageText(stage))).join('<br>');
      const url = safeHttpUrl(notice.url);
      const link = url ? `<a href="${escapeHtml(url)}">공고</a>` : '-';
      return `<tr><td>${escapeHtml(notice.name)}</td><td>${escapeHtml(notice.typeLabel)}</td><td>${escapeHtml(notice.region)}</td><td>${stages}</td><td>${escapeHtml(detailOf(item))}</td><td>${link}</td></tr>`;
    });
    const omitted = section.omitted > 0 ? `<p>외 ${section.omitted}건은 Notion 표에서 확인하세요.</p>` : '';
    const note = section.note ? `<p>${escapeHtml(section.note)}</p>` : '';
    return `<h3>${escapeHtml(sectionHead(section, section.all.length))}</h3>${note}<table border="1" cellpadding="6" cellspacing="0"><thead><tr><th>주택명</th><th>유형</th><th>지역</th><th>금주 일정</th><th>근거</th><th>링크</th></tr></thead><tbody>${rows.join('')}</tbody></table>${omitted}`;
  };
  const warningHtml = warning ? `<p><strong>${escapeHtml(warning)}</strong></p>` : '';
  const body = shownCount > 0 ? sections.map(tableOf).join('') : '<p>금주 알릴 접수 일정이 없습니다.</p>';
  const passHtml = passNote ? `<p>${escapeHtml(passNote)}</p>` : '';
  const html = `${testMark ? '<p><strong>테스트 발송입니다.</strong></p>' : ''}${warningHtml}${body}${passHtml}<p>${escapeHtml(DISCLAIMER)}</p>`;
  const textSections = sections.flatMap((section) => [
    sectionHead(section, section.all.length),
    ...(section.note ? [section.note] : []),
    ...section.shown.map((item) => {
      const stages = item.weekStages.map((stage) => `${stage.name} ${stage.start}`).join(', ');
      const detail = detailOf(item);
      return `- ${item.notice.name} (${item.notice.region}) ${stages}${detail ? ` / ${detail}` : ''}`;
    }),
    ...(section.omitted > 0 ? [`외 ${section.omitted}건은 Notion 표에서 확인하세요.`] : []),
  ]);
  const text = [warning, ...(shownCount > 0 ? textSections : ['금주 알릴 접수 일정이 없습니다.']), passNote, DISCLAIMER].filter(Boolean).join('\n');
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
