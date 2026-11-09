import { strToU8, zipSync } from 'fflate';

// 서울시 정비사업 추진현황 xlsx와 같은 머리글(1~4행, 병합 셀)을 가진 작은 xlsx를 만든다.
// 값이 문자열이면 공유 문자열, 숫자면 숫자 셀, { inline }이면 인라인 문자열, { si }이면 공유 문자열 원문(XML)이다.

const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const HEADER = {
  1: {
    A: 'CODE', B: '순번', C: '자치구',
    // 서식 런으로 나뉘고 윗주가 붙은 문자열
    D: { si: '<r><t>구역</t></r><r><t>명</t></r><rPh sb="0" eb="2"><t>クイキ</t></rPh><phoneticPr fontId="4"/>' },
    E: '위치', G: '사업방법', J: '사업추진단계', K: '기존 가구수(멸실량)', L: '추진단계', X: '공급형태별 건립세대수 (공급량)',
  },
  2: { X: '총합계', Y: '분양', Z: '임대' },
  3: {
    L: '구역지정\n(아파트 지구는 정비계획 수립)', N: '추진위원회', O: '조합설립인가\n(사업시행자 지정일)', P: '건축심의',
    Q: '사업시행인가', S: '관리처분\n계획인가', U: '이주', W: '착공',
  },
  4: {
    E: '위치1(지번주소)', F: '위치2(도로명주소)', G: '공공/민간', H: '일반/재촉지구', I: '사업유형',
    L: '최초', M: '변경(최종)', Q: '최초', R: '변경(최종)', S: '최초', T: '변경(최종)', U: '이주시작일', V: '이주종료일',
  },
};

export const MERGES = [
  'G1:I3', 'J1:J4', 'K1:K4', 'L1:W2', 'X1:Z1', 'X2:X4', 'Y2:Y4', 'Z2:Z4', 'L3:M3', 'N3:N4', 'O3:O4', 'P3:P4',
  'Q3:R3', 'S3:T3', 'U3:V3', 'W3:W4', 'A1:A4', 'B1:B4', 'C1:C4', 'D1:D4', 'E1:F3',
];

const COLUMN_ORDER = (ref) => ref.length * 100 + ref.charCodeAt(ref.length - 1);

export function buildXlsx({ rows, merges = MERGES, sheetName = '`26.6월말 기준_재개발, 재건축 추진현황', sheetPath = 'worksheets/sheet1.xml' }) {
  const strings = [];
  const stringIndex = new Map();
  const shared = (xml) => {
    if (!stringIndex.has(xml)) {
      stringIndex.set(xml, strings.length);
      strings.push(xml);
    }
    return stringIndex.get(xml);
  };
  const rowXml = Object.entries(rows).map(([rowNumber, cells]) => {
    const cellXml = Object.keys(cells).sort((a, b) => COLUMN_ORDER(a) - COLUMN_ORDER(b)).map((col) => {
      const value = cells[col];
      const ref = `${col}${rowNumber}`;
      if (value === null || value === undefined) return `<c r="${ref}" s="7"/>`;
      if (typeof value === 'number') return `<c r="${ref}" s="7"><v>${value}</v></c>`;
      if (value.inline !== undefined) return `<c r="${ref}" t="inlineStr"><is><t>${escape(value.inline)}</t></is></c>`;
      const xml = value.si ?? `<t>${escape(value)}</t>`;
      return `<c r="${ref}" s="6" t="s"><v>${shared(xml)}</v></c>`;
    });
    return `<row r="${rowNumber}">${cellXml.join('')}</row>`;
  });
  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<sheetData>${rowXml.join('')}</sheetData>`
    + `<mergeCells count="${merges.length}">${merges.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`
    + '</worksheet>';
  const sst = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">`
    + strings.map((xml) => `<si>${xml}</si>`).join('')
    + '</sst>';
  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheets><sheet name="${escape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${sheetPath}"/>`
    + '</Relationships>';
  return zipSync({
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(rels),
    [`xl/${sheetPath}`]: strToU8(sheet),
    'xl/sharedStrings.xml': strToU8(sst),
  });
}

// 날짜 일련번호: 2010-12-30 = 40542, 2024-01-01 = 45292, 2025-01-01 = 45658, 2026-01-01 = 46023, 2026-04-01 = 46113
export const DATA_ROWS = {
  // 착공까지 간 사업. 분양에는 조합원분이 들어 있다.
  5: {
    A: 1441, B: 1, C: '종로구', D: '신영1', E: '신영동158-2', F: '세검정로6길62-2', G: '민간', H: '일반', I: '주택정비형 재개발',
    J: '착공', K: 66, L: 40542, M: 45292, O: 45292, Q: 45292, S: 45658, U: 45658, W: 46113, X: 199, Y: 199, Z: 0,
  },
  // 건립세대 0 = 미정, '-' 날짜와 '-' 도로명주소
  6: {
    A: 1460, B: 2, C: '종로구', D: '수송1-2', E: '수송동146-12', F: '-', G: '민간', H: '일반', I: '도시정비형 재개발',
    J: '건축심의', K: 0, L: '-', M: 40542, N: '-', P: 46023, X: 0, Y: 0, Z: 0,
  },
  // 관리처분이고 이주가 시작됐다. 최초 관리처분일이 없어 변경(최종)을 쓴다.
  7: {
    A: 2001, B: 3, C: '강남구', D: { inline: '개포주공5단지' }, E: '개포동 187번지', F: '삼성로4길 17', G: '민간', H: '일반',
    I: '공동주택재건축', J: '관리처분', Q: 45292, S: '-', T: 45658, U: 46023, X: 1279, Y: 1092, Z: 187,
  },
  // 관리처분이고 이주 전
  8: {
    A: 2002, B: 4, C: '서초구', D: '반포미도2차', E: '반포동 60-4', G: '민간', H: '일반', I: '아파트지구재건축',
    J: '관리처분', S: 46023, X: 500, Y: 450, Z: 50,
  },
  // 빈 행
  9: { A: null, B: null },
  // 모르는 단계 값
  10: { A: 2003, C: '마포구', D: '아현9', I: '주택정비형 재개발', J: '기타' },
};

export function seoulFixture(extraRows = {}) {
  return buildXlsx({ rows: { ...HEADER, ...DATA_ROWS, ...extraRows } });
}

export const LISTING_HTML = `
<tbody>
  <tr id="fileTr_1">
    <td>1</td><td>데이터</td>
    <td class="align-l" style="cursor:pointer"><span title="★(25년 12월기준) 서울시 정비사업 추진현황.xlsx" onclick="javascript:downloadFile('1');">★(25년 12월기준) 서울시 정비사업 추진현황.xlsx</span></td>
    <td>0.1</td><td>2026.03.10.</td>
    <td><a href="javascript:downloadFile('1');" title="★(25년 12월기준) 서울시 정비사업 추진현황.xlsx"><span class="hide">다운로드</span></a></td>
  </tr>
  <tr id="fileTr_2">
    <td>2</td><td>데이터</td>
    <td class="align-l" style="cursor:pointer"><span title="★(26년 6월기준) 서울시 정비사업 추진현황.xlsx" onclick="javascript:downloadFile('3');">★(26년 6월기준) 서울시 정비사업 추진현황.xlsx</span></td>
    <td>0.1</td><td>2026.09.10.</td>
    <td><a href="javascript:downloadFile('3');" title="★(26년 6월기준) 서울시 정비사업 추진현황.xlsx"><span class="hide">다운로드</span></a></td>
  </tr>
  <tr id="fileTr_3">
    <td>3</td><td>데이터</td>
    <td class="align-l" style="cursor:pointer"><span title="★(26년 3월기준) 서울시 정비사업 추진현황.xlsx" onclick="javascript:downloadFile('2');">★(26년 3월기준) 서울시 정비사업 추진현황.xlsx</span></td>
    <td>0.1</td><td>2026.06.10.</td>
  </tr>
</tbody>`;
