# 분양 예정 지도

서울 재개발·재건축과 경기 공공주택지구가 언제쯤 분양할지 거칠게 보여 주는 공개 정적 사이트다.
예상 시기는 단계별 경험 규칙으로 잡은 추정이며, 실제 일정이 아니다.

## 파이프라인

`src/pipeline/build-map.js`가 `site/projects.json`을 만들고(커밋하지 않음), `site/`의 정적 페이지가 그 파일을 읽는다.

1. 서울: `seoul-redevelop.js`가 서울 열린데이터광장 OA-22856 페이지에서 기준월이 가장 늦은 xlsx를 골라 내려받고, 사업 하나씩 지도 형태로 바꾼다. 형식은 `docs/sources.md`의 `서울시 정비사업 추진현황` 참고.
2. 공공주택지구: `newtowns.js`가 `data/newtowns.yaml`을 읽고 검사한다.
3. 예상 시기: `expected-window.js`가 단계와 단계 날짜로 기간을 잡고, 기간 시작까지 남은 달로 구간(`bucket`)을 정한다.
4. 공고 연결: `DATA_GO_KR_KEY`가 있으면 청약홈 공고(최근 365일)를 모아 `link-notices.js`로 사업에 잇는다. 접수가 오늘 이후까지인 공고가 있으면 `live`.

서울 자료가 실패하거나 `newtowns.yaml`이 형식에 맞지 않으면 0이 아닌 코드로 끝나 이전 배포가 유지된다.
공고 연결 실패는 `notices.skipped`에 오류 종류만 남기고 계속한다. 키가 없으면 `skipped=no_key`.

로그 예: `map seoul=496 asOf=2026-06 towns=3 notices checked=812 linked=4`, 이어서 구간별·단계별 건수.

## 예상 시기 규칙

현재 단계의 날짜부터 센다. 날짜가 없으면 오늘부터 세고 근거에 `날짜 없음, 오늘 기준`이라고 적는다.

| 유형 | 현재 단계 | 예상 분양 시기 |
|---|---|---|
| 재개발·재건축 | 구역지정·추진위·조합설립·건축심의 | 없음, `far` (사업시행인가 전이라 36개월 밖으로 예상) |
| | 사업시행인가 | 3~5년 뒤 |
| | 관리처분인가 | 1.5~3년 뒤 |
| | 이주 (관리처분이고 이주시작일이 있음) | 0.5~2년 뒤 |
| | 착공 | 0~1년 뒤 (일반분양은 착공 전후가 많음) |
| 공공주택지구 | 후보지 | 없음, `far` |
| | 지구지정 | 3~5년 뒤 |
| | 지구계획승인 | 1.5~3년 뒤 |
| | 부지조성 착공 | 1~2년 뒤, 블록별 순차 공고 |
| | 블록별 분양 | 오늘부터 2년 (남은 블록 순차 공고, 확장 규칙) |
| | 준공 | 없음, `done` |

- `newtowns.yaml`에 `expected`(보도된 계획)가 있으면 규칙보다 우선한다.
- 기간 끝이 이번 달보다 앞이면 기간은 그대로 두고 `overdue`(예상 시기가 지났습니다, 지연 가능성)로 표시한다.
- 구간: 공고 연결 시 `live`, 그 밖에 `done`, `overdue`, 기간 시작까지 12개월 미만 `soon`, 36개월 미만 `mid`, 나머지와 기간 없음은 `far`.

## 공고 연결 규칙

- 서울: 공고 주소에 같은 구가 있고(공고 지역도 서울), 주소에 사업의 동과 본번(`신영동158`, 공백과 `번지` 무시)이 있거나 공고명에 구역명(`구역`과 공백을 뺀 값, 3글자 이상)이 있으면 잇는다. 숫자로 끝나는 값은 뒤에 숫자가 이어지면 다른 것으로 본다(`신당1` ≠ `신당10`).
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

## 로컬 실행

```sh
cd scripts/chungyak-alert
npm ci
npm run build-map                     # 서울 자료를 내려받아 site/projects.json 생성
node src/pipeline/build-map.js --out site/projects.json --seoul-file ./seoul.xlsx   # 내려받은 파일로
node src/pipeline/build-map.js --newtowns ./other.yaml                              # 다른 지구 파일로
npx serve site                        # 또는 아무 정적 서버로 site/ 열기
```

`DATA_GO_KR_KEY`가 없으면 공고 연결만 건너뛴다.

## 배포

`.github/workflows/chungyak-map.yml`이 매주 화요일 06:00(KST)과 수동 실행 때 만들고 `main`에서만 GitHub Pages로 배포한다.
PR에서는 빌드와 아티팩트 업로드까지만 한다.
