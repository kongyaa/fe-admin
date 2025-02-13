# Git 계정 설정 가이드

## 프로젝트별 Git 계정 설정 방법

### 1. 프로젝트 로컬 Git 설정
프로젝트 디렉토리에서 로컬 Git 설정을 변경하여 해당 프로젝트에서만 다른 Git 계정을 사용할 수 있습니다.

```bash
# 프로젝트 디렉토리로 이동
cd fe-admin

# 프로젝트에 대한 로컬 Git 사용자 이름과 이메일 설정
git config user.name "kongyaa"
git config user.email "kongyaa의 이메일 주소"

# 설정이 제대로 되었는지 확인
git config user.name
git config user.email
```

### 2. SSH 키 추가 설정 (권장)

여러 Git 계정을 사용할 때는 SSH 키를 사용하는 것이 가장 안전하고 효율적입니다.

```bash
# 새로운 SSH 키 생성
ssh-keygen -t ed25519 -C "kongyaa의 이메일 주소" -f ~/.ssh/kongyaa_id_ed25519

# SSH 설정 파일 생성 또는 수정
touch ~/.ssh/config
```

~/.ssh/config 파일에 다음 내용 추가:
```
# 기본 회사 계정
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519
  
# kongyaa 계정
Host github.com-kongyaa
  HostName github.com
  User git
  IdentityFile ~/.ssh/kongyaa_id_ed25519
```

### 3. 레포지토리 설정

새로운 레포지토리를 클론하거나 리모트를 설정할 때는 다음과 같이 합니다:

```bash
# 새 레포지토리 클론
git clone git@github.com-kongyaa:kongyaa/fe-admin.git

# 또는 기존 레포지토리의 리모트 URL 변경
git remote set-url origin git@github.com-kongyaa:kongyaa/fe-admin.git
```

### 4. GitHub에 SSH 키 등록

1. 새로 생성한 SSH 공개키 복사:
```bash
cat ~/.ssh/kongyaa_id_ed25519.pub | pbcopy
```

2. GitHub 설정
   - GitHub.com에 kongyaa 계정으로 로그인
   - Settings > SSH and GPG keys > New SSH key
   - 복사한 공개키 붙여넣기

### 5. 연결 테스트

```bash
# SSH 연결 테스트
ssh -T git@github.com-kongyaa
```

## 주의사항

1. 프로젝트별 Git 설정은 해당 프로젝트의 `.git/config` 파일에만 적용됩니다.
2. 글로벌 Git 설정은 변경되지 않으므로 다른 프로젝트에는 영향을 주지 않습니다.
3. SSH 설정을 사용하면 인증 정보를 안전하게 관리할 수 있습니다.

## 문제 해결

### 자격 증명 캐시 초기화
만약 이전 자격 증명이 캐시되어 있다면:
```bash
# macOS 키체인에서 GitHub 관련 자격 증명 삭제
git credential-osxkeychain erase
host=github.com
protocol=https 