# 분양 예정 지도

서울 재개발·재건축과 경기 공공주택지구가 언제쯤 분양할지 거칠게 보여 주는 공개 정적 사이트다.
예상 시기는 단계별 경험 규칙으로 잡은 추정이며, 실제 일정이 아니다.

## 파이프라인

`src/pipeline/build-map.js`가 `site/projects.json`을 만들고(커밋하지 않음), `site/`의 정적 페이지가 그 파일을 읽는다.

1. 서울: `seoul-redevelop.js`가 서울 열린데이터광장 OA-22856 페이지에서 기준월이 가장 늦은 xlsx를 골라 내려받고, 사업 하나씩 지도 형태로 바꾼다. 형식은 `docs/sources.md`의 `서울시 정비사업 추진현황` 참고.
2. 공공주택지구: `newtowns.js`가 `data/newtowns.yaml`을 읽고 검사한다.
3. 예상 시기: `expected-window.js`가 단계와 단계 날짜로 기간을 잡고, 기간 시작까지 남은 달로 구간(`bucket`)을 정한다.
4. 공고 연결: `DATA_GO_KR_KEY`가 있으면 청약홈 공고(최근 1095일, 3년)를 모아 `link-notices.js`로 사업에 잇는다. 접수가 오늘 이후까지인 공고가 있으면 `live`.
   공공주택지구는 블록 공고 간격이 1년을 넘기도 해서(하남교산 A2 2025-03) 3년을 본다.
   서울 정비사업에 공고는 이어졌지만 모두 접수가 끝났으면 `windowStatus: announced`로 바꾸고 근거를 `청약홈 공고가 이미 있었습니다(<가장 늦은 공고일>)`로 적는다. 기간은 그대로 둔다. 준공(`done`)은 바꾸지 않는다. 3년 안의 오래된 공고도 접수가 끝났으면 같은 규칙으로 `announced`다.
   공공주택지구는 블록별로 여러 번 공고하므로 지난 블록 공고가 있어도 규칙·보도 기간과 구간을 그대로 두고, 공고는 목록에만 남긴다.

서울 자료가 실패하거나 `newtowns.yaml`이 형식에 맞지 않으면 0이 아닌 코드로 끝나 이전 배포가 유지된다.
서울 자료에서 단계나 사업유형 값을 몰라 건너뛴 행(`skipped.stage + skipped.kind`)이 데이터 행의 5%를 넘어도 `seoul_values`로 멈춘다. 원자료의 값 이름이 바뀐 경우다. 건너뛴 수는 `sources.seoul.skipped`와 로그에 남는다.
공고 연결 실패는 `notices.skipped`에 오류 종류만 남기고 계속한다. 키가 없으면 `skipped=no_key`.

로그 예: `map seoul=496 skipped=0 asOf=2026-06 towns=3 notices checked=812 linked=4`(건너뛴 행이 있으면 `skipped=stage:1,duplicate:2`), 이어서 구간별·단계별 건수.

## 예상 시기 규칙

현재 단계의 날짜부터 센다. 날짜가 없으면 오늘부터 세고 근거에 `날짜 없음, 오늘 기준`이라고 적는다.

| 유형 | 현재 단계 | 예상 분양 시기 |
|---|---|---|
| 재개발·재건축 | 구역지정·추진위·조합설립·건축심의 | 없음, `far` (사업시행인가 전이라 36개월 밖으로 예상) |
| | 사업시행인가 | 3~5년 뒤 |
| | 관리처분인가 | 1.5~3년 뒤 |
| | 이주 (관리처분이고 이주시작일이 자료 기준월 말일까지) | 0.5~2년 뒤 |
| | 착공 | 0~1년 뒤 (일반분양은 착공 전후가 많음) |
| 공공주택지구 | 후보지 | 없음, `far` |
| | 지구지정 | 3~5년 뒤 |
| | 지구계획승인 | 1.5~3년 뒤 |
| | 부지조성 착공 | 1~2년 뒤, 블록별 순차 공고 |
| | 블록별 분양 | 다음 블록 예상. 아래 "블록별 분양 지구" 참고 |
| | 준공 | 없음, `done` |

- `newtowns.yaml`에 `expected`(보도된 계획)가 있으면 규칙보다 우선한다(블록 계획보다도 먼저).
### 블록별 분양 지구

이미 블록 본청약이 시작된 지구의 기간은 첫 청약이 아니라 **다음 블록** 예상이다. 사업에 `windowLabel: '다음 블록 예상'`을 붙이고, 사이트는 이 이름으로 보여 준다(다른 사업은 `windowLabel`이 없고 '예상 청약').

1. `plans` 중 임대가 아닌 계획(`rental: true` 제외)만 본다. `expected`는 `YYYY-상반기` → 1~6월, `YYYY-하반기` → 7~12월, `YYYY-MM` → 그 달.
   계획 보도일(출처 날짜, 없으면 계획 시작 달) 이후의 분양 이력(`history`, 임대 제외)에 같은 블록(`A-1` = `A1` = `A1BL`)이 있으면 그 블록은 공고가 난 것으로 보고 뺀다.
2. 남은 계획 중 기간 끝이 이번 달 이후인 것이 있으면 가장 이른 기간(같은 기간이면 블록을 합침). 규칙 `town-plan`, 근거 `보도된 다음 블록 계획: A9·A11 2026-하반기 (하남Times 2025-12-13)`.
   보도한 곳은 출처의 `outlet`, 없으면 제목 끝 괄호, 없으면 주소의 호스트. 출처 날짜가 없으면 `날짜 없음`.
3. 남은 계획이 있지만 모두 지났으면 오늘부터 12개월. 규칙 `town-plan-late`, 근거 `보도된 일정(<가장 늦게 끝난 계획의 expected>)이 지났지만 공고는 아직 없습니다. 남은 블록 순차 공고`.
4. 남은 분양 계획이 없으면(계획 없음, 임대 계획만, 모두 공고됨) 확장 규칙: 오늘부터 0~2년, 근거 `다음 블록 예상(규칙): 오늘부터 0~2년`.

모두 `status: estimated`라 구간은 기간 시작으로 정한다. 지난 블록 공고가 연결돼도 기간은 그대로다(위 공고 연결 참고).

### 그 밖의 규칙

- 이주시작일이 자료 기준월(예: 6월 기준이면 6월 말일) 뒤면 아직 예정이라 관리처분인가로 둔다.
- 기간 끝이 이번 달보다 앞이면 기간은 그대로 두고 단계로 가른다.
  - 이주·착공·일반분양: `likely_sold`(예상 시기가 지났습니다. 이미 분양했을 가능성이 큽니다(공고 미확인)). 공고 연결이 안 됐을 뿐 이미 분양했을 가능성이 크다.
  - 그 앞 단계(사업시행인가, 관리처분인가, 공공주택지구 단계): `overdue`(예상 시기가 지났습니다(지연 가능성)).
- 구간(정렬 순서): `live`(접수 중인 공고 연결) → `soon`(기간 시작까지 12개월 미만) → `mid`(36개월 미만) → `far`(나머지와 기간 없음) → `announced`(서울 사업에 지난 공고만 연결) → `overdue` → `likely_sold` → `done`.
  `announced`, `overdue`, `likely_sold`, `done`은 상태 그대로 구간이 된다. 사이트도 같은 규칙으로 다시 계산하므로(만든 뒤 달이 바뀌어 기간이 지나면 단계로 가름) 두 `bucketOf`는 같게 고친다. `test/map-site.test.js`의 공용 표 검사가 둘을 비교한다.
- 사이트: `announced`는 "공고 있었음"(초록 테두리), `likely_sold`는 "분양했을 가능성"(흐린 칩). 둘 다 1년/3년 필터와 구 타일의 1년·3년 집계에서 빠진다.

## 공고 연결 규칙

- 서울: 공고 주소에 같은 구가 있고(공고 지역도 서울), 주소에 사업의 동과 본번(`신영동158`, 공백과 `번지` 무시)이 있거나 공고명에 구역명(`구역`과 공백을 뺀 값, 3글자 이상)이 있으면 잇는다. 숫자로 끝나는 값은 뒤에 숫자, `차`, `단지`, `동`, `가`가 이어지면 다른 것으로 본다(`신당1` ≠ `신당10`, `신길2` ≠ `신길2차`·`신길2동`). 지번이 여럿인 주소(`이촌동193-3,5`, `청담동65,삼성동53-2`)는 첫 지번만 쓴다.
- 공공주택지구: 공고 주소나 이름에 시 이름(`하남`)과 `noticeMatch` 중 하나가 있어야 한다.

## `data/newtowns.yaml` 편집

```yaml
asOf: "2026-11-10"          # 파일을 마지막으로 확인한 날
towns:
  - id: hanam-gyosan        # 바꾸지 않는 영문 소문자·숫자·하이픈 (지도 id는 town-<id>)
    name: 하남교산
    region: 경기
    district: 하남           # 시는 빼고 적는다 (출력은 하남시). 구·군이면 그대로 적는다.
    kind: 공공주택지구
    stage: 지구계획승인        # 후보지, 지구지정, 지구계획승인, 부지조성 착공, 블록별 분양, 준공 중 하나
    stageDates:              # 출처로 확인한 날짜만, "YYYY-MM" 또는 "YYYY-MM-DD"
      지구지정: "2019-10"
    households: 33000        # 모르면 비워 둔다
    noticeMatch: [교산]      # 청약홈 공고명·주소에서 이 지구를 가리키는 글자
    expected:                # 선택. 보도된 분양 계획이 있을 때만
      from: "2029-06"
      to: "2031-06"
      basis: "…"
    notes: "…"
    sources:
      - title: "…"
        url: https://...
        date: "2025-12-31"
```

- 날짜는 따옴표로 감싼 문자열로 쓴다.
- 모르는 값은 비워 둔다. 빈 `households`, `stageDates`, `noticeMatch`, `expected`, `notes`, `sources`는 허용한다.
- 단계 이름이 목록에 없으면 `newtowns_stage`, 날짜 형식이 틀리면 `newtowns_date`, id가 겹치면 `newtowns_duplicate`, 필수 값(id, name)이 없거나 형식이 틀리면 `newtowns_field`, YAML 문법 오류는 `newtowns_yaml`로 빌드가 멈춘다. PR 실행에서 바로 드러난다.
- `noticeMatch`는 너무 짧거나 흔한 글자(`토평`처럼 기존 단지 이름에도 쓰이는 것)를 피한다.
- `sources`의 url은 http(s)만 남는다.

### 블록별 분양 이력과 계획

`블록별 분양` 지구는 블록 공고 이력과 보도된 다음 블록 계획을 적을 수 있다. 사이트 상세의 "블록별 분양 이력"에 표로 나오고, 계획은 다음 블록 예상 기간에 쓰인다.

```yaml
    preSubscriptions:          # 사전청약 (선택)
      - block: A2
        type: 공공분양
        households: 1056
        noticeDate: "2021-11-18"
        source: { title: "… (뉴데일리)", url: "https://…", date: "2021-11-17" }
    history:                   # 본청약·블록 공고 (선택)
      - block: A2
        type: 공공분양
        households: 1115
        noticeDate: "2025-03-31"
        title: 교산 푸르지오 더 퍼스트   # 선택, 단지 이름
        moveIn: "2029-06"              # 선택, 입주 예정
        rental: true                   # 임대 공고면 true (분양 계획을 채우지 않음)
        source:                        # 하나 또는 목록
          - { title: "…", url: "https://…", date: "2025-03-31" }
          - { title: "… (뉴시스)", url: "https://…", date: "2025-03-31" }
    plans:                     # 보도된 다음 블록 계획 (선택)
      - blocks: [A9, A11]
        type: 공공분양
        households: { A9: 244, A11: 511 }   # 숫자 하나 또는 블록별
        expected: "2026-하반기"              # YYYY-MM, YYYY-상반기, YYYY-하반기
        rental: true                         # 임대 계획이면 true (기간 계산에서 뺌)
        note: "…"                            # 선택, 확인 정도·주의
        source: { title: "… (하남Times)", outlet: 하남Times, url: "http://…", date: "2025-12-13" }
```

- `noticeDate`(이력)와 `expected`(계획)는 필수다. 날짜는 따옴표로 감싼 `YYYY-MM` 또는 `YYYY-MM-DD`.
- 항목마다 http(s) 주소가 있는 `source`가 하나 이상 있어야 한다. 없으면 `newtowns_source`로 빌드가 멈춘다. `outlet`(보도한 곳)은 선택이다.
- 날짜·`expected` 형식이 틀리면 `newtowns_date`, 블록 이름이나 필수 값이 없거나 `rental`이 true/false가 아니면 `newtowns_field`.
- 모르는 키(예: `stage: 사전청약`)는 무시한다.
- 출력(`projects.json`)에는 `preSubscriptions`, `blockHistory`(`history`), `blockPlans`(`plans`, 달 범위 `from`·`to`와 `householdsByBlock`을 붙임)로 날짜순으로 나간다. 비어 있으면 키가 없다.
- 사이트는 사전청약·본청약을 한 표(최근 공고 먼저), 계획을 다른 표로 보여 주고, 계획 기간이 이번 달 전에 끝났으면 "보도 일정 지남"을 붙인다.

## 로컬 실행

```sh
cd scripts/chungyak-alert
npm ci
npm run build-map                     # 서울 자료를 내려받아 site/projects.json 생성
node src/pipeline/build-map.js --out site/projects.json --seoul-file ./seoul.xlsx   # 내려받은 파일로
node src/pipeline/build-map.js --newtowns ./other.yaml                              # 다른 지구 파일로
npx serve site                        # 또는 아무 정적 서버로 site/ 열기
# 주소 뒤에 ?sample=1 을 붙이면 projects.json 대신 site/sample-projects.json(예시 자료, 예시 안내 표시)을 읽는다
```

`DATA_GO_KR_KEY`가 없으면 공고 연결만 건너뛴다.

## 배포

`.github/workflows/chungyak-map.yml`이 매주 화요일 06:00(KST), 수동 실행, `main`에 이 패키지나 워크플로 변경이 합쳐질 때(push) 만들고 `main`에서만 GitHub Pages로 배포한다.
PR에서는 빌드와 아티팩트 업로드까지만 한다.
같은 PR 브랜치의 이전 실행은 새 커밋이 오면 취소되고, 예약·수동·push 실행(main)은 서로 취소하지 않고 차례로 돈다.
