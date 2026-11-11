import { receptionStatus } from './reception.js';
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
  start: '접수 시작일',
  end: '접수 종료일',
  special: '특별공급 접수일',
  rank1: '1순위 접수일',
  rank2: '2순위 접수일',
  winner: '당첨자발표일',
  topPrice: '최고 분양가',
  averagePrice: '평균 분양가',
  minPrice: '최저 분양가',
  modelPrices: '주택형별 분양가',
  judgedArea: '판단 주택형(㎡)',
  receptionStatus: '접수 상태',
  estimate: '추정 시세',
  margin: '안전 마진',
  marginRate: '마진율',
  confidence: '시세 신뢰도',
  walkMinutes: '역 도보(분)',
  recommendTrack: '추천 전형',
  recommendDate: '추천 접수일',
  lotto: '로또 여부',
  reason: '판별 근거',
  link: '공고 링크',
  source: '소스',
  collected: '마지막 수집일',
  urgent: '긴급 알림 발송일',
  interest: '관심',
};

// 이전 실행까지 쓰던 속성 이름. 값이 유지되도록 삭제하지 않고 이름만 바꾼다.
const LEGACY = { margin: '예상 차익', marginRate: '차익률' };
const DEFAULT_COLUMNS = { margin: P.margin, marginRate: P.marginRate, confidence: P.confidence, averagePrice: P.averagePrice, recommendTrack: P.recommendTrack, recommendDate: P.recommendDate, minPrice: P.minPrice, modelPrices: P.modelPrices, judgedArea: P.judgedArea, receptionStatus: P.receptionStatus };
// 스키마를 읽지 못해 이번 실행의 이름을 모를 때 쓴다. 이 속성들만 빼서 다른 값의 저장을 막지 않는다.
const NO_COLUMNS = { margin: null, marginRate: null, confidence: null, averagePrice: null, recommendTrack: null, recommendDate: null, minPrice: null, modelPrices: null, judgedArea: null, receptionStatus: null };

const DB_SCHEMA = {
  [P.name]: { title: {} },
  [P.key]: { rich_text: {} },
  [P.type]: { select: {} },
  [P.region]: { select: {} },
  [P.address]: { rich_text: {} },
  [P.start]: { date: {} },
  [P.end]: { date: {} },
  [P.special]: { date: {} },
  [P.rank1]: { date: {} },
  [P.rank2]: { date: {} },
  [P.winner]: { date: {} },
  [P.topPrice]: { number: { format: 'number' } },
  [P.averagePrice]: { number: { format: 'number' } },
  [P.minPrice]: { number: { format: 'number' } },
  [P.modelPrices]: { rich_text: {} },
  [P.judgedArea]: { number: { format: 'number' } },
  [P.receptionStatus]: { select: { options: [{ name: '접수 전' }, { name: '접수 중' }, { name: '마감' }] } },
  [P.estimate]: { number: { format: 'number' } },
  [P.margin]: { number: { format: 'number' } },
  [P.marginRate]: { number: { format: 'percent' } },
  [P.confidence]: { select: { options: [{ name: '상' }, { name: '중' }, { name: '하' }] } },
  [P.walkMinutes]: { number: { format: 'number' } },
  [P.recommendTrack]: { select: {} },
  [P.recommendDate]: { date: {} },
  [P.lotto]: {
    select: {
      options: [{ name: '로또' }, { name: '아님' }, { name: '판별 불가' }, { name: '대상 외' }, { name: '확인 필요' }],
    },
  },
  [P.reason]: { rich_text: {} },
  [P.link]: { url: {} },
  [P.source]: { select: {} },
  [P.collected]: { date: {} },
  [P.urgent]: { date: {} },
  [P.interest]: { checkbox: {} },
};

const text = (value) => [{ type: 'text', text: { content: String(value).slice(0, 2000) } }];
const dateProp = (value) => (value ? { date: { start: value } } : undefined);
const numberProp = (value) => (Number.isFinite(value) ? { number: value } : undefined);
const selectProp = (value) => (value ? { select: { name: String(value).replace(/,/g, ' ').slice(0, 100) } } : undefined);
const textProp = (value) => (value ? { rich_text: text(value) } : undefined);

// 값이 없는 속성은 보내지 않아 기존 값을 지우지 않는다. 긴급 알림 발송일과 사용자가 입력하는 관심, 역 도보(분)은 여기서 쓰지 않는다.
// 제한 유형은 clearMarket으로 저장된 추정 값을 명시적으로 지운다.
// existing은 저장된 행이다. 공고에 날짜가 없으면 저장된 날짜로 접수 상태를 계산한다(날짜 열도 값이 없으면 저장된 값을 둔다).
export function buildProperties(notice, evaluation, today, columns = DEFAULT_COLUMNS, existing = null) {
  const url = safeHttpUrl(notice.url);
  const properties = {
    [P.name]: { title: text(notice.name || notice.key) },
    [P.key]: textProp(notice.key),
    [P.type]: selectProp(notice.typeLabel),
    [P.region]: selectProp(notice.region),
    [P.address]: textProp(notice.address),
    [P.start]: dateProp(notice.overallStart),
    [P.end]: dateProp(notice.overallEnd),
    [P.special]: dateProp(firstStageDate(notice.stages, '특별공급')),
    [P.rank1]: dateProp(firstStageDate(notice.stages, '1순위')),
    [P.rank2]: dateProp(firstStageDate(notice.stages, '2순위')),
    [P.winner]: dateProp(notice.winnerDate),
    [P.topPrice]: numberProp(evaluation?.topPrice),
    [P.estimate]: evaluation?.clearMarket ? { number: null } : numberProp(evaluation?.estimate),
    [P.lotto]: selectProp(evaluation?.status),
    [P.reason]: textProp(evaluation?.reason),
    [P.link]: url && url.length <= 2000 ? { url } : undefined,
    [P.source]: selectProp(notice.source),
    [P.collected]: dateProp(today),
  };
  if (columns.margin) properties[columns.margin] = evaluation?.clearMarket ? { number: null } : numberProp(evaluation?.margin);
  if (columns.marginRate) properties[columns.marginRate] = evaluation?.clearMarket ? { number: null } : numberProp(evaluation?.marginRate);
  if (columns.confidence) properties[columns.confidence] = evaluation?.clearMarket ? { select: null } : selectProp(evaluation?.confidence);
  // 공고의 사실이라 제한 유형에서도 지우지 않는다. 값이 없으면 보내지 않아 저장된 값을 둔다.
  if (columns.averagePrice) properties[columns.averagePrice] = numberProp(evaluation?.averagePrice);
  // 최저 분양가와 주택형별 분양가도 공고의 사실이라 제한 유형에서 지우지 않는다. 값이 없으면 보내지 않는다.
  if (columns.minPrice) properties[columns.minPrice] = numberProp(evaluation?.minPrice);
  if (columns.modelPrices) properties[columns.modelPrices] = textProp(evaluation?.modelPrices);
  // 판단 주택형은 안전 마진과 함께 정해지므로 제한 유형처럼 추정 값을 지울 때 같이 지운다.
  if (columns.judgedArea) properties[columns.judgedArea] = evaluation?.clearMarket ? { number: null } : numberProp(evaluation?.judgedArea);
  // 접수 상태는 공고 날짜로 계산한다. 계산할 수 없으면 보내지 않아 저장된 값을 둔다.
  if (columns.receptionStatus) properties[columns.receptionStatus] = selectProp(receptionStatus(notice.overallStart ?? existing?.start ?? null, notice.overallEnd ?? existing?.end ?? null, today));
  // 추천은 프로필이 있을 때만 판정에 들어 있다. 없으면(undefined) 건드리지 않고, 추천이 없으면(null) 지운다.
  if (evaluation && evaluation.recommendation !== undefined) {
    const recommendation = evaluation.recommendation;
    if (columns.recommendTrack) properties[columns.recommendTrack] = recommendation ? selectProp(recommendation.track) : { select: null };
    if (columns.recommendDate) {
      properties[columns.recommendDate] = recommendation
        ? { date: { start: recommendation.date, ...(recommendation.end && recommendation.end > recommendation.date ? { end: recommendation.end } : {}) } }
        : { date: null };
    }
  }
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));
}

export function parseExistingPage(page) {
  const props = page.properties ?? {};
  // 같은 이름의 다른 타입 속성은 빈 값으로 본다.
  const walk = props[P.walkMinutes]?.number;
  return {
    id: page.id,
    key: (props[P.key]?.rich_text ?? []).map((part) => part.plain_text).join(''),
    lotto: props[P.lotto]?.select?.name ?? null,
    urgentDate: props[P.urgent]?.date?.start?.slice(0, 10) ?? null,
    end: props[P.end]?.date?.start?.slice(0, 10) ?? null,
    start: props[P.start]?.date?.start?.slice(0, 10) ?? null,
    // 같은 이름의 다른 타입 속성은 체크로 보지 않는다.
    interest: props[P.interest]?.checkbox === true,
    name: (props[P.name]?.title ?? []).map((part) => part.plain_text).join(''),
    // 임대 정리에 쓴다(src/rental.js).
    typeLabel: props[P.type]?.select?.name ?? null,
    // LH 범위 정리에 쓴다(src/lh-scope.js).
    region: props[P.region]?.select?.name ?? null,
    source: props[P.source]?.select?.name ?? null,
    link: props[P.link]?.url ?? null,
    walkMinutes: Number.isFinite(walk) && walk >= 0 ? walk : null,
    // 같은 이름의 다른 타입 속성은 빈 값으로 본다.
    receptionStatus: props[P.receptionStatus]?.select?.name ?? null,
    recommendTrack: props[P.recommendTrack]?.select?.name ?? null,
    recommendDate: props[P.recommendDate]?.date?.start?.slice(0, 10) ?? null,
    recommendEnd: props[P.recommendDate]?.date?.end?.slice(0, 10) ?? null,
  };
}

export function createNotionStore({ key, parentPageId, config, sources, fetch, sleep = defaultSleep, minIntervalMs = MIN_INTERVAL_MS }) {
  let databaseId = null;
  let children = [];
  let lastCall = 0;
  // 스토어는 실행마다 하나다. 응답 없는 Notion이 잡 제한 시간을 다 쓰지 않도록 첫 장애 뒤에는 호출하지 않는다.
  let outage = null;
  // 휴지통으로 옮긴 직후의 조회에 남아 있어도 이번 실행에서는 세지 않는다.
  const archivedIds = new Set();
  // 이번 실행에서 쓸 속성 이름. 이름 변경이 실패하면 옛 이름으로 저장해 모든 행이 400으로 실패하지 않게 한다.
  let columns = DEFAULT_COLUMNS;
  const schemaIssues = [];

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

  // 기존 DB에 관심 속성이 없을 때만 추가한다. 실패해도 수집과 알림을 막지 않고 다음 실행에서 다시 시도한다.
  // 같은 이름의 다른 타입 속성은 사용자의 것일 수 있어 바꾸지 않는다.
  async function ensureInterestProperty(properties) {
    try {
      if (properties[P.interest]) return;
      await request('PATCH', `/databases/${databaseId}`, { properties: { [P.interest]: DB_SCHEMA[P.interest] } });
    } catch {
      // 위 주석 참고
    }
  }

  async function patchSchema(change, issue) {
    try {
      await request('PATCH', `/databases/${databaseId}`, { properties: change });
      return true;
    } catch {
      schemaIssues.push(issue);
      return false;
    }
  }

  // 옛 이름이 있고 새 이름이 없을 때만 이름을 바꾼다. 있는 속성 위로 바꾸지 않아 두 번 실행해도 같다.
  // 돌려주는 값은 이번 실행에서 쓸 이름이고, 숫자 속성이 하나도 없으면 null이다.
  async function ensureNumberColumn(properties, newName, oldName) {
    const isNumber = (name) => properties[name]?.type === 'number';
    if (isNumber(newName)) return newName;
    if (properties[newName]) return isNumber(oldName) ? oldName : null;
    if (isNumber(oldName)) {
      const renamed = await patchSchema({ [oldName]: { name: newName } }, 'notion_rename_failed');
      return renamed ? newName : oldName;
    }
    const added = await patchSchema({ [newName]: DB_SCHEMA[newName] }, 'notion_property_add_failed');
    return added ? newName : null;
  }

  async function ensureConfidenceColumn(properties) {
    const property = properties[P.confidence];
    if (property) return property.type === 'select' ? P.confidence : null;
    const added = await patchSchema({ [P.confidence]: DB_SCHEMA[P.confidence] }, 'notion_property_add_failed');
    return added ? P.confidence : null;
  }

  // 사용자가 입력하는 열이다. 없을 때만 추가하고, 같은 이름의 다른 타입 속성은 건드리지 않는다.
  // 배치가 쓰는 열이다. 없을 때만 추가하고, 같은 이름의 다른 타입 속성은 건드리지 않고 쓰지도 않는다.
  async function ensureTypedColumn(properties, name, type) {
    const property = properties[name];
    if (property) return property.type === type ? name : null;
    const added = await patchSchema({ [name]: DB_SCHEMA[name] }, 'notion_property_add_failed');
    return added ? name : null;
  }

  // 배치가 쓰는 숫자 열이다. 없을 때만 추가하고, 같은 이름의 다른 타입 속성은 건드리지 않고 쓰지도 않는다.
  async function ensureAveragePriceColumn(properties) {
    const property = properties[P.averagePrice];
    if (property) return property.type === 'number' ? P.averagePrice : null;
    const added = await patchSchema({ [P.averagePrice]: DB_SCHEMA[P.averagePrice] }, 'notion_property_add_failed');
    return added ? P.averagePrice : null;
  }

  async function ensureWalkProperty(properties) {
    if (properties[P.walkMinutes]) return;
    await patchSchema({ [P.walkMinutes]: DB_SCHEMA[P.walkMinutes] }, 'notion_property_add_failed');
  }

  // 스키마는 한 번만 읽는다. 읽기나 변경이 실패해도 수집과 알림을 막지 않는다.
  async function ensureProperties() {
    let properties;
    try {
      const database = await request('GET', `/databases/${databaseId}`);
      properties = database.properties ?? {};
    } catch {
      columns = NO_COLUMNS;
      schemaIssues.push('notion_schema_read_failed');
      return;
    }
    columns = {
      margin: await ensureNumberColumn(properties, P.margin, LEGACY.margin),
      marginRate: await ensureNumberColumn(properties, P.marginRate, LEGACY.marginRate),
      confidence: await ensureConfidenceColumn(properties),
      averagePrice: await ensureAveragePriceColumn(properties),
      recommendTrack: await ensureTypedColumn(properties, P.recommendTrack, 'select'),
      recommendDate: await ensureTypedColumn(properties, P.recommendDate, 'date'),
      // 분양가 사실과 접수 상태 열. 없을 때만 추가하고, 같은 이름의 다른 타입 속성은 건드리지 않고 쓰지도 않는다.
      minPrice: await ensureTypedColumn(properties, P.minPrice, 'number'),
      modelPrices: await ensureTypedColumn(properties, P.modelPrices, 'rich_text'),
      judgedArea: await ensureTypedColumn(properties, P.judgedArea, 'number'),
      receptionStatus: await ensureTypedColumn(properties, P.receptionStatus, 'select'),
    };
    await ensureWalkProperty(properties);
    await ensureInterestProperty(properties);
  }

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
        await ensureProperties();
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
          if (row.archived || row.in_trash || archivedIds.has(row.id)) continue;
          const parsed = parseExistingPage(row);
          if (parsed.key) existing.set(parsed.key, parsed);
        }
        cursor = page.has_more ? page.next_cursor : undefined;
      } while (cursor);
      return existing;
    },

    async upsert(notice, evaluation, existing, today) {
      const properties = buildProperties(notice, evaluation, today, columns, existing);
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

    // 다시 판정하지 않는 저장된 행의 접수 상태만 고친다. 다른 열은 보내지 않는다.
    // 이번 실행에서 쓸 수 있는 열이 없으면(없고 추가도 못 함, 다른 타입) 호출하지 않고 false를 돌려준다.
    async setReceptionStatus(pageId, status) {
      if (!columns.receptionStatus) return false;
      await request('PATCH', `/pages/${pageId}`, { properties: { [columns.receptionStatus]: { select: { name: status } } } });
      return true;
    },

    // Notion 휴지통으로 옮긴다. 영구 삭제가 아니다.
    async archivePage(pageId) {
      await request('PATCH', `/pages/${pageId}`, { archived: true });
      archivedIds.add(pageId);
    },

    async stampUrgent(pageId, date) {
      await request('PATCH', `/pages/${pageId}`, { properties: { [P.urgent]: { date: { start: date } } } });
    },

    // 오류 메일에 건수만 남길 고정 식별자 목록이다.
    schemaIssues: () => [...schemaIssues],

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
