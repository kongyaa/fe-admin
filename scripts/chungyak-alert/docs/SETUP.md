# 설정 안내

이 저장소는 공개 저장소입니다. 키, 받는 메일, Notion ID는 파일에 쓰지 말고 GitHub Secrets에만 넣으세요.

## 1. 공공데이터포털 (data.go.kr)

1. 회원 가입 후 다음 3개 API를 활용신청합니다.
   - 청약홈 분양정보 조회 서비스 (15098547)
   - 국토교통부 아파트 매매 실거래가 상세 또는 해당 자료 (15126469)
   - LH 임대공고 조회
2. 마이페이지에서 일반 인증키를 복사해 `DATA_GO_KR_KEY`로 등록합니다. 디코딩 키를 권장합니다. 인코딩 키를 넣어도 코드가 풀어서 씁니다.

## 2. Notion

1. https://www.notion.so/my-integrations 에서 이 배치에 쓸 내부 통합의 토큰을 `CHUNGYAK_NOTION_KEY`로 등록합니다. 저장소의 기존 `NOTION_KEY` Secret은 다른 통합의 것이므로 쓰지 않습니다. 워크플로가 이 값을 환경 변수 `NOTION_KEY`로 넘깁니다.
2. 대상 페이지의 연결 메뉴에서 그 통합을 추가합니다.
3. 페이지 URL 끝의 32자리 ID를 `CHUNGYAK_NOTION_PAGE_ID`로 등록합니다.

첫 실행 때 데이터베이스, 소스 목록 페이지가 자동 생성되고, 첫 주간 메일 뒤 "청약 배치 상태" 페이지가 생깁니다. 이 페이지 제목의 날짜가 주간 메일 중복을 막으니 지우거나 고치지 마세요.

## 3. 카카오

앱 설정은 끝났습니다.

- [x] 카카오 로그인 활성화
- [x] 동의 항목 "카카오톡 메시지 전송"(`talk_message`) 선택 동의
- [x] Redirect URI `http://localhost:8080/callback` 등록
- [x] Web 사이트 도메인 `https://www.applyhome.co.kr` 등록. 카카오 문서상 메시지 링크에 필수입니다.

남은 작업은 다음과 같습니다.

1. 앱의 REST API 키를 `KAKAO_REST_KEY`로 등록합니다.
2. 클라이언트 시크릿을 켰다면 값을 `KAKAO_CLIENT_SECRET`으로 등록합니다. 쓰지 않으면 비워 둡니다.
3. PC에서 최초 인증을 1회 실행합니다.

   ```powershell
   cd scripts/chungyak-alert
   $env:KAKAO_REST_KEY = "REST 키"
   $env:KAKAO_CLIENT_SECRET = "시크릿, 없으면 이 줄 생략"
   node kakao-auth.js
   ```

4. 출력된 주소를 열어 동의하면 `.kakao-token.txt`가 생깁니다. 내용을 `KAKAO_REFRESH_TOKEN`으로 등록한 뒤 파일을 지웁니다. 이 파일은 커밋되지 않도록 제외되어 있습니다. 동의 화면에서 메시지 전송 항목을 꼭 선택하세요. 선택 동의라 해제하면 발송이 실패합니다.

## 4. Gmail

1. Google 계정에서 2단계 인증을 켭니다.
2. https://myaccount.google.com/apppasswords 에서 앱 비밀번호를 만듭니다.
3. 주소를 `GMAIL_USER`, 앱 비밀번호를 `GMAIL_APP_PASSWORD`, 받을 주소를 `MAIL_TO`로 등록합니다. 개인 주소를 권장합니다.

## 5. Secret 쓰기용 PAT

카카오 갱신 토큰이 교체되면 워크플로가 Secret을 직접 갱신합니다.

1. GitHub Settings > Developer settings > Fine-grained personal access tokens에서 새 토큰을 만듭니다.
2. Repository access는 **이 저장소만** 선택합니다.
3. Repository permissions에서 **Secrets: Read and write**만 줍니다.
4. 값을 `KAKAO_SECRET_WRITER_PAT`으로 등록합니다.
5. **토큰은 만료됩니다.** 만료일을 정하고 그 전에 갱신하도록 달력에 적어 두세요. 만료되어도 평소에는 문제가 드러나지 않다가 갱신 토큰이 교체되는 날 실패합니다.

## 6. GitHub Secrets 목록

저장소 Settings > Secrets and variables > Actions에 등록합니다.

| 이름 | 내용 | 필수 |
|---|---|---|
| `DATA_GO_KR_KEY` | 공공데이터포털 인증키 | 예 |
| `CHUNGYAK_NOTION_KEY` | 이 배치용 Notion 통합 토큰. 기존 `NOTION_KEY`와 별개 | 예 |
| `CHUNGYAK_NOTION_PAGE_ID` | 대상 페이지 ID | 예 |
| `KAKAO_REST_KEY` | 카카오 REST API 키 | 예 |
| `KAKAO_CLIENT_SECRET` | 카카오 클라이언트 시크릿 | 사용 시 |
| `KAKAO_REFRESH_TOKEN` | 카카오 갱신 토큰 | 예 |
| `GMAIL_USER` | 보내는 Gmail 주소 | 예 |
| `GMAIL_APP_PASSWORD` | Gmail 앱 비밀번호 | 예 |
| `MAIL_TO` | 받는 주소 | 예 |
| `KAKAO_SECRET_WRITER_PAT` | Secret 쓰기용 PAT | 예 |

## 7. 확인 순서

Actions 탭에서 `chungyak-alert`를 수동 실행합니다.

1. `dry-run`: 수집과 판별만 합니다. 로그에서 건수와 오류 유형을 봅니다.
2. `test-send`: 표시된 샘플 메일 1통과 카카오 1건을 보냅니다. Notion에는 쓰지 않습니다.
3. `normal`: Notion 저장을 확인합니다. 두 번 실행해 중복 행이 없는지 봅니다.
4. `force-weekly`: 주간 메일을 강제 발송합니다.

### 접수가 끝난 페이지 정리

`cleanup-ended`는 수동 실행 전용입니다. 예약 실행에서는 돌지 않습니다. "청약 정보" 데이터베이스에서 저장된 접수 종료일이 오늘(KST) 이전인 페이지만 Notion 휴지통으로 옮깁니다.

- 접수 종료일이 오늘 이후이거나 비어 있는 페이지는 그대로 둡니다.
- 수집, 저장, 메일, 카카오 발송을 하지 않고 카카오 토큰도 갱신하지 않습니다.
- 로그에는 `archived`, `kept`, `failed` 건수만 남고, 하나라도 실패하면 잡이 실패합니다. 메일로는 알리지 않으니 Actions 결과를 확인하세요.
- 잘못 옮겼다면 Notion 휴지통에서 복원할 수 있습니다. 휴지통 보관 기간은 Notion 정책을 따르므로 필요하면 바로 확인하세요.
- PC에서 대상 건수만 보려면 `NOTION_KEY`와 `CHUNGYAK_NOTION_PAGE_ID`를 설정하고 `node src/main.js --cleanup-ended --dry-run`을 실행합니다.

PC에서 조회만 하려면 다음과 같이 실행합니다. `--print`는 쓰기와 발송을 하지 않으며 Actions에서는 무시됩니다.

```powershell
$env:DATA_GO_KR_KEY = "키"
npm run dry-run
node src/main.js --print
```

## 8. 운영 주의

- **60일 규칙:** 공개 저장소의 예약 워크플로는 저장소 활동이 60일 없으면 자동으로 꺼집니다. 꺼지면 Actions 탭에서 `chungyak-alert`를 선택해 **Enable workflow**를 누르세요. 기존 일일 리포트 커밋을 멈추면 이 일이 생길 수 있습니다.
- **카카오 토큰 복구:** `kakao_secret_write_failed` 메일을 받으면 새 갱신 토큰이 저장되지 않은 상태입니다. PAT를 고친 뒤 3장의 최초 인증을 다시 하고 Secret을 등록하세요.
- **갱신 토큰:** 워크플로가 매일 갱신을 실행하므로 알림이 없어도 쓰지 않아 만료되는 일은 없습니다. 카카오 쪽 동의 철회나 비밀번호 변경 등으로 끊기면 `kakao_access_token_missing` 메일이 옵니다.
- **Notion 오류:** Notion을 읽지 못해도 긴급 알림은 보냅니다. 발송 기록을 남기지 못하므로 같은 날 다음 실행에서 또 올 수 있고, 오류 메일에 `urgent_sent_without_stamp`로 표시됩니다. 주간 메일은 발송 기록이 필요해 Notion이 복구된 뒤 보냅니다. 잡은 실패로 끝납니다. 실행 중 Notion이 응답하지 않으면(`notion_timeout`, `notion_network`) 그 실행에서는 Notion 호출을 멈추고 같은 방식으로 처리합니다. 이때 저장하지 못한 공고는 접수가 끝나기 전이면 다음 실행에서 저장됩니다.
- **저장 범위:** 접수가 이미 끝난 공고는 Notion에 새로 넣지 않습니다. 날짜가 없는 LH 공고는 상태에 `마감`이나 `종료`가 들어 있으면 같이 건너뜁니다. 날짜도 마감 상태도 없는 공고는 저장합니다. 이미 Notion에 있는 페이지는 지우지 않습니다. 로그의 `skipped`는 이렇게 건너뛴 공고와 접수가 끝나 갱신하지 않은 기존 페이지를 합친 수입니다.
- **긴급 알림 유실:** 카카오와 메일이 모두 실패하면 오류 메일 항목 `urgent_lost`가 생기고 잡이 실패합니다. 메일까지 막혀 있으면 이 표시도 받지 못할 수 있으니 Actions 실패 알림을 켜 두세요.
- **청약홈 전체 실패:** 청약홈의 모든 조회가 실패하면 LH가 정상이어도 잡이 실패합니다.

## 9. 로또 판별 설정

`config.json`의 `lotto.includePriceCap`(분양가상한제), `lotto.includePublicDistrict`(공공주택지구)는 기본값이 켜짐입니다. 수도권의 해당 아파트 공고는 시세와 무관하게 로또로 표시되고, 접수 시작일에 긴급 알림이 갑니다. 끄려면 값을 `false`로 바꾸세요.
