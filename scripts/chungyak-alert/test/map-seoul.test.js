import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import {
  DATASET_URL,
  DOWNLOAD_URL,
  SEOUL_STAGES,
  collectSeoul,
  columnIndex,
  decodeXml,
  excelSerialToDate,
  headerLabels,
  parseAsOf,
  parseFileList,
  parseSeoulWorkbook,
  parseSharedStrings,
  pickLatestFile,
  readXlsx,
  resolveColumns,
  sourceTitle,
} from '../src/pipeline/seoul-redevelop.js';
import { HEADER, LISTING_HTML, buildXlsx, seoulFixture } from './map-fixtures.js';

const noSleep = async () => {};

test('excel serial dates convert from 1970-01-01 = 25569', () => {
  assert.equal(excelSerialToDate(25569), '1970-01-01');
  assert.equal(excelSerialToDate(40544), '2011-01-01');
  assert.equal(excelSerialToDate(40542), '2010-12-30');
  assert.equal(excelSerialToDate('45658'), '2025-01-01');
  assert.equal(excelSerialToDate('46113.75'), '2026-04-01');
  assert.equal(excelSerialToDate('-'), null);
  assert.equal(excelSerialToDate(''), null);
  assert.equal(excelSerialToDate(null), null);
  assert.equal(excelSerialToDate(0), null);
  assert.equal(excelSerialToDate(199), null);
});

test('xml entities and column letters', () => {
  assert.equal(decodeXml('A&amp;B &lt;C&gt; &quot;D&quot; &#39;E&#x27; &unknown;'), 'A&B <C> "D" \'E\' &unknown;');
  assert.equal(columnIndex('A5'), 0);
  assert.equal(columnIndex('Z'), 25);
  assert.equal(columnIndex('AA12'), 26);
});

test('shared strings join rich text runs and skip phonetic runs', () => {
  const xml = '<sst><si><t>순번</t></si><si><r><t>구역</t></r><r><t xml:space="preserve">명</t></r><rPh sb="0" eb="1"><t>ク</t></rPh></si><si><t>A&amp;B</t></si><si/></sst>';
  assert.deepEqual(parseSharedStrings(xml), ['순번', '구역명', 'A&B', '']);
});

test('as-of month comes from the file title or the sheet name', () => {
  assert.equal(parseAsOf('★(26년 6월기준) 서울시 정비사업 추진현황.xlsx'), '2026-06');
  assert.equal(parseAsOf('(25년 12월 기준)'), '2025-12');
  assert.equal(parseAsOf('`26.6월말 기준_재개발, 재건축 추진현황'), '2026-06');
  assert.equal(parseAsOf('추진현황.xlsx'), null);
  assert.equal(sourceTitle('2026-06'), '서울시 정비사업 추진현황 (26년 6월기준)');
});

test('file listing picks the latest as-of month, not the first listed', () => {
  const files = parseFileList(LISTING_HTML);
  assert.deepEqual(files.map((file) => [file.seq, file.asOf]), [['1', '2025-12'], ['3', '2026-06'], ['2', '2026-03']]);
  const latest = pickLatestFile(files);
  assert.equal(latest.seq, '3');
  assert.equal(latest.title, '★(26년 6월기준) 서울시 정비사업 추진현황.xlsx');
  assert.throws(() => pickLatestFile(parseFileList('<p>no files</p>')), { kind: 'seoul_listing' });
});

test('header labels fill merged cells and resolve every column', () => {
  const { rows, merges } = readXlsx(seoulFixture());
  const labels = headerLabels(rows, merges);
  assert.equal(labels[17], '추진단계|사업시행인가|변경(최종)');
  const columns = resolveColumns(labels);
  assert.equal(columns.code, 0);
  assert.equal(columns.name, 3);
  assert.equal(columns.disposalLast, 19);
  assert.equal(columns.saleHouseholds, 24);
});

test('a shifted or missing header stops with seoul_header', () => {
  const shifted = { ...HEADER, 4: { ...HEADER[4], I: '사업 구분' } };
  assert.throws(() => parseSeoulWorkbook(buildXlsx({ rows: shifted })), { kind: 'seoul_header' });
  assert.throws(() => parseSeoulWorkbook(buildXlsx({ rows: { 1: { A: 'x' } }, merges: [] })), { kind: 'seoul_header' });
});

test('not a zip -> seoul_xlsx', () => {
  assert.throws(() => readXlsx(new Uint8Array([1, 2, 3])), { kind: 'seoul_xlsx' });
  assert.throws(() => readXlsx(zipSync({ 'a.txt': strToU8('x') })), { kind: 'seoul_xlsx' });
});

test('seoul rows normalize into map projects', () => {
  const result = parseSeoulWorkbook(seoulFixture());
  assert.equal(result.asOf, '2026-06');
  assert.equal(result.title, '서울시 정비사업 추진현황 (26년 6월기준)');
  assert.deepEqual(result.skipped, { stage: 1 });
  assert.deepEqual(result.projects.map((p) => p.id), ['seoul-1441', 'seoul-1460', 'seoul-2001', 'seoul-2002']);

  const [sinyoung, susong, gaepo, banpo] = result.projects;
  assert.deepEqual(sinyoung, {
    id: 'seoul-1441',
    name: '신영1',
    kind: '재개발',
    subKind: '주택정비형 재개발',
    region: '서울',
    district: '종로구',
    address: '신영동158-2',
    roadAddress: '세검정로6길62-2',
    operator: '민간',
    stage: '착공',
    stageIndex: 7,
    stageDates: {
      구역지정: '2010-12-30',
      조합설립: '2024-01-01',
      사업시행인가: '2024-01-01',
      관리처분인가: '2025-01-01',
      이주: '2025-01-01',
      착공: '2026-04-01',
    },
    households: 199,
    saleHouseholds: 199,
    rentalHouseholds: 0,
    generalSupply: null,
    notices: [],
    live: false,
    sources: [{ title: '서울시 정비사업 추진현황 (26년 6월기준)', url: DATASET_URL }],
    asOf: '2026-06',
  });

  // '-' 최초 구역지정일은 변경(최종)으로, 세대수 0은 미정(null)
  assert.equal(susong.stage, '건축심의');
  assert.equal(susong.roadAddress, null);
  assert.deepEqual(susong.stageDates, { 구역지정: '2010-12-30', 건축심의: '2026-01-01' });
  assert.equal(susong.households, null);
  assert.equal(susong.saleHouseholds, null);
  assert.equal(susong.rentalHouseholds, null);

  // 관리처분 + 이주시작일 -> 이주
  assert.equal(gaepo.name, '개포주공5단지');
  assert.equal(gaepo.kind, '재건축');
  assert.equal(gaepo.stage, '이주');
  assert.equal(gaepo.stageIndex, SEOUL_STAGES.indexOf('이주'));
  assert.equal(gaepo.stageDates.관리처분인가, '2025-01-01');
  assert.equal(gaepo.stageDates.이주, '2026-01-01');

  assert.equal(banpo.stage, '관리처분인가');
  assert.equal(banpo.kind, '재건축');
  assert.equal(banpo.households, 500);
});

test('as-of given by the listing wins over the sheet name', () => {
  assert.equal(parseSeoulWorkbook(seoulFixture(), { asOf: '2026-09' }).asOf, '2026-09');
  const unnamed = buildXlsx({ rows: { ...HEADER, 5: { A: 1, C: '종로구', D: '테스트', I: '주택정비형 재개발', J: '추진위' } }, sheetName: 'Sheet1' });
  assert.equal(parseSeoulWorkbook(unnamed, { fileName: '★(26년 3월기준) x.xlsx' }).asOf, '2026-03');
});

test('a sheet without data rows is an error', () => {
  assert.throws(() => parseSeoulWorkbook(buildXlsx({ rows: HEADER })), { kind: 'seoul_empty' });
});

test('first sheet is resolved through workbook relationships', () => {
  const bytes = buildXlsx({ rows: { ...HEADER, 5: { A: 7, C: '중구', D: '수표', I: '도시정비형 재개발', J: '구역지정' } }, sheetPath: 'worksheets/data.xml' });
  assert.deepEqual(parseSeoulWorkbook(bytes).projects.map((p) => p.id), ['seoul-7']);
});

test('collectSeoul reads the listing, posts the download form and parses the file', async () => {
  const calls = [];
  const xlsx = seoulFixture();
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ?? null, type: init.headers?.['Content-Type'] ?? null });
    if (url === DATASET_URL) return new Response(LISTING_HTML);
    if (url === DOWNLOAD_URL) return new Response(xlsx);
    return new Response('', { status: 404 });
  };
  const result = await collectSeoul({ fetch, sleep: noSleep });
  assert.equal(result.asOf, '2026-06');
  assert.equal(result.projects.length, 4);
  assert.deepEqual(calls[1], {
    url: DOWNLOAD_URL,
    method: 'POST',
    body: 'infId=OA-22856&seqNo=&seq=3&infSeq=2',
    type: 'application/x-www-form-urlencoded',
  });
});

test('a download that is not a zip or fails is a seoul error', async () => {
  const html = async (url) => (url === DATASET_URL ? new Response(LISTING_HTML) : new Response('<html>error</html>'));
  await assert.rejects(collectSeoul({ fetch: html, sleep: noSleep }), { kind: 'seoul_download' });
  const down = async () => new Response('', { status: 503 });
  await assert.rejects(collectSeoul({ fetch: down, sleep: noSleep }), { kind: 'seoul_http_503' });
});
