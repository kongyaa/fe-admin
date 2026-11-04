import { AppError, defaultSleep, fetchWithRetry, firstStageDate, safeHttpUrl } from './util.js';

const API = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';
const MIN_INTERVAL_MS = 350;
export const STATE_PREFIX = '청약 배치 상태';

const P = {
  name: '주택명',
  key: '고유 키',
  type: '유형',
  region: '공급지역',
  address: '주소',
  announce: '모집공고일',
  start: '접수 시작일',
  end: '접수 종료일',
  special: '특별공급 접수일',
  rank1: '1순위 접수일',
  rank2: '2순위 접수일',
  winner: '당첨자발표일',
  topPrice: '최고 분양가',
  estimate: '추정 시세',
  gain: '예상 차익',
  rate: '차익률',
  lotto: '로또 여부',
  reason: '판별 근거',
  link: '공고 링크',
  source: '소스',
  collected: '마지막 수집일',
  urgent: '긴급 알림 발송일',
};

const DB_SCHEMA = {
  [P.name]: { title: {} },
  [P.key]: { rich_text: {} },
  [P.type]: { select: {} },
  [P.region]: { select: {} },
  [P.address]: { rich_text: {} },
  [P.announce]: { date: {} },
  [P.start]: { date: {} },
  [P.end]: { date: {} },
  [P.special]: { date: {} },
  [P.rank1]: { date: {} },
  [P.rank2]: { date: {} },
  [P.winner]: { date: {} },
  [P.topPrice]: { number: { format: 'number' } },
  [P.estimate]: { number: { format: 'number' } },
  [P.gain]: { number: { format: 'number' } },
  [P.rate]: { number: { format: 'percent' } },
  [P.lotto]: {
    select: {
      options: [{ name: '로또' }, { name: '아님' }, { name: '판별 불가' }, { name: '대상 외' }],
    },
  },
  [P.reason]: { rich_text: {} },
  [P.link]: { url: {} },
  [P.source]: { select: {} },
  [P.collected]: { date: {} },
  [P.urgent]: { date: {} },
};

const text = (value) => [{ type: 'text', text: { content: String(value).slice(0, 2000) } }];
const dateProp = (value) => (value ? { date: { start: value } } : undefined);
const numberProp = (value) => (Number.isFinite(value) ? { number: value } : undefined);
const selectProp = (value) => (value ? { select: { name: String(value).replace(/,/g, ' ').slice(0, 100) } } : undefined);
const textProp = (value) => (value ? { rich_text: text(value) } : undefined);

// 값이 없는 속성은 보내지 않아 기존 값을 지우지 않는다. 긴급 알림 발송일은 여기서 쓰지 않는다.
export function buildProperties(notice, evaluation, today) {
  const url = safeHttpUrl(notice.url);
  const properties = {
    [P.name]: { title: text(notice.name || notice.key) },
    [P.key]: textProp(notice.key),
    [P.type]: selectProp(notice.typeLabel),
    [P.region]: selectProp(notice.region),
    [P.address]: textProp(notice.address),
    [P.announce]: dateProp(notice.announceDate),
    [P.start]: dateProp(notice.overallStart),
    [P.end]: dateProp(notice.overallEnd),
    [P.special]: dateProp(firstStageDate(notice.stages, '특별공급')),
    [P.rank1]: dateProp(firstStageDate(notice.stages, '1순위')),
    [P.rank2]: dateProp(firstStageDate(notice.stages, '2순위')),
    [P.winner]: dateProp(notice.winnerDate),
    [P.topPrice]: numberProp(evaluation?.topPrice),
    [P.estimate]: numberProp(evaluation?.estimate),
    [P.gain]: numberProp(evaluation?.gain),
    [P.rate]: numberProp(evaluation?.rate),
    [P.lotto]: selectProp(evaluation?.status),
    [P.reason]: textProp(evaluation?.reason),
    [P.link]: url && url.length <= 2000 ? { url } : undefined,
    [P.source]: selectProp(notice.source),
    [P.collected]: dateProp(today),
  };
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));
}

export function parseExistingPage(page) {
  const props = page.properties ?? {};
  return {
    id: page.id,
    key: (props[P.key]?.rich_text ?? []).map((part) => part.plain_text).join(''),
    lotto: props[P.lotto]?.select?.name ?? null,
    urgentDate: props[P.urgent]?.date?.start?.slice(0, 10) ?? null,
    end: props[P.end]?.date?.start?.slice(0, 10) ?? null,
  };
}

export function createNotionStore({ key, parentPageId, config, sources, fetch, sleep = defaultSleep, minIntervalMs = MIN_INTERVAL_MS }) {
  let databaseId = null;
  let children = [];
  let lastCall = 0;
  // 스토어는 실행마다 하나다. 응답 없는 Notion이 잡 제한 시간을 다 쓰지 않도록 첫 장애 뒤에는 호출하지 않는다.
  let outage = null;

  async function request(method, path, body, { idempotent = true } = {}) {
    if (outage) throw outage;
    const wait = lastCall + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    try {
      const response = await fetchWithRetry(
        fetch,
        `${API}${path}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${key}`,
            'Notion-Version': VERSION,
            'Content-Type': 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
        },
        { kind: 'notion', retries: 5, idempotent, sleep },
      );
      return await response.json();
    } catch (error) {
      if (error.kind === 'notion_timeout' || error.kind === 'notion_network') outage = error;
      // 본문을 읽다 멈춘 경우는 fetchWithRetry를 지난 뒤라 여기서 따로 잡는다.
      else if (error?.name === 'TimeoutError') outage = new AppError('notion_timeout');
      throw outage ?? error;
    }
  }

  async function listChildren() {
    const blocks = [];
    let cursor;
    do {
      const query = new URLSearchParams({ page_size: '100' });
      if (cursor) query.set('start_cursor', cursor);
      const page = await request('GET', `/blocks/${parentPageId}/children?${query}`);
      blocks.push(...page.results);
      cursor = page.has_more ? page.next_cursor : undefined;
    } while (cursor);
    return blocks;
  }

  const createChildPage = (title, childBlocks = []) => request(
    'POST',
    '/pages',
    {
      parent: { page_id: parentPageId },
      properties: { title: { title: text(title) } },
      children: childBlocks,
    },
    { idempotent: false },
  );

  return {
    async init({ createMissing = true } = {}) {
      children = await listChildren();
      const { databaseTitle, sourcesPageTitle } = config.notion;
      const database = children.find((block) => block.type === 'child_database' && block.child_database?.title === databaseTitle);
      if (!createMissing) {
        if (!database) throw new AppError('notion_database_missing');
        databaseId = database.id;
        return;
      }
      if (database) {
        databaseId = database.id;
      } else {
        const created = await request(
          'POST',
          '/databases',
          { parent: { page_id: parentPageId }, title: text(databaseTitle), properties: DB_SCHEMA },
          { idempotent: false },
        );
        databaseId = created.id;
      }
      const hasSourcesPage = children.some((block) => block.type === 'child_page' && block.child_page?.title === sourcesPageTitle);
      if (!hasSourcesPage) {
        await createChildPage(
          sourcesPageTitle,
          sources.map((line) => ({
            object: 'block',
            type: 'bulleted_list_item',
            bulleted_list_item: { rich_text: text(line) },
          })),
        );
      }
    },

    async loadExisting() {
      const existing = new Map();
      let cursor;
      do {
        const page = await request('POST', `/databases/${databaseId}/query`, {
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        });
        for (const row of page.results) {
          const parsed = parseExistingPage(row);
          if (parsed.key) existing.set(parsed.key, parsed);
        }
        cursor = page.has_more ? page.next_cursor : undefined;
      } while (cursor);
      return existing;
    },

    async upsert(notice, evaluation, existing, today) {
      const properties = buildProperties(notice, evaluation, today);
      if (existing) {
        await request('PATCH', `/pages/${existing.id}`, { properties });
        return existing.id;
      }
      const created = await request(
        'POST',
        '/pages',
        { parent: { database_id: databaseId }, properties },
        { idempotent: false },
      );
      return created.id;
    },

    // Notion 휴지통으로 옮긴다. 영구 삭제가 아니다.
    async archivePage(pageId) {
      await request('PATCH', `/pages/${pageId}`, { archived: true });
    },

    async stampUrgent(pageId, date) {
      await request('PATCH', `/pages/${pageId}`, { properties: { [P.urgent]: { date: { start: date } } } });
    },

    async getWeeklyState() {
      // 캐시만 읽지만, 장애 중에는 발송 기록을 남길 수 없으므로 주간 메일을 막는다.
      if (outage) throw outage;
      const block = children.find((item) => item.type === 'child_page' && item.child_page?.title?.startsWith(STATE_PREFIX));
      return block ? /\d{4}-\d{2}-\d{2}/.exec(block.child_page.title)?.[0] ?? null : null;
    },

    async setWeeklyState(monday) {
      const title = `${STATE_PREFIX} ${monday}`;
      const block = children.find((item) => item.type === 'child_page' && item.child_page?.title?.startsWith(STATE_PREFIX));
      if (block) {
        await request('PATCH', `/pages/${block.id}`, { properties: { title: { title: text(title) } } });
        block.child_page.title = title;
      } else {
        const created = await createChildPage(title);
        children.push({ id: created.id, type: 'child_page', child_page: { title } });
      }
    },
  };
}
