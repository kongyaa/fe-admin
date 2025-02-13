# Git 명령어 가이드

## 1. 기본 명령어

### 1.1 상태 확인
```bash
# 현재 작업 디렉토리 상태 확인
git status

# 간단한 상태 확인 (브랜치, 변경사항 개수)
git status -s

# 브랜치 목록 확인
git branch
git branch -a  # 원격 브랜치 포함
git branch -v  # 마지막 커밋 메시지 포함

# 로그 확인
git log
git log --oneline  # 한 줄로 간단히
git log --graph    # 브랜치 그래프 표시
git log --pretty=format:"%h %s" --graph  # 커스텀 포맷
```

### 1.2 변경사항 관리
```bash
# 변경사항 확인
git diff                # 워킹 디렉토리와 스테이징 영역 비교
git diff --staged      # 스테이징 영역과 마지막 커밋 비교
git diff HEAD         # 워킹 디렉토리와 마지막 커밋 비교

# 파일 스테이징
git add <파일명>
git add .             # 모든 변경사항 스테이징
git add -p           # 변경사항을 대화형으로 선택

# 커밋
git commit -m "메시지"
git commit -am "메시지"  # 추적 중인 파일의 변경사항만 add + commit
                       # 주의: 새로 추가된(untracked) 파일은 포함되지 않음
                       # 예시:
                       # 1. test.js 수정 (tracked) -> commit -am으로 포함됨
                       # 2. new.js 생성 (untracked) -> commit -am으로 포함되지 않음
                       # 3. .gitignore에 있는 파일 -> commit -am으로 포함되지 않음
```

### 1.3 브랜치 관리
```bash
# 브랜치 생성
git branch <브랜치명>
git checkout -b <브랜치명>  # 생성 후 전환

# 브랜치 전환
git checkout <브랜치명>
git switch <브랜치명>     # Git 2.23+

# 브랜치 삭제
git branch -d <브랜치명>  # 안전하게 삭제
git branch -D <브랜치명>  # 강제 삭제
```

## 2. 협업 관련 명령어

### 2.1 원격 저장소 관리
```bash
# 원격 저장소 확인
git remote -v

# 원격 저장소 추가
git remote add <이름> <URL>

# 원격 저장소에서 가져오기
git fetch <원격저장소>
git fetch --all       # 모든 원격 저장소에서 가져오기

# 원격 저장소 변경사항 가져와서 병합
git pull
git pull --rebase    # rebase 방식으로 가져오기

# 변경사항 원격 저장소에 푸시
git push <원격저장소> <브랜치>
git push -u origin <브랜치>  # upstream 설정하며 푸시
```

### 2.2 병합 관련
```bash
# 브랜치 병합
git merge <브랜치명>
git merge --no-ff <브랜치명>  # fast-forward 하지 않고 병합

# rebase
git rebase <브랜치명>
git rebase -i HEAD~3         # 최근 3개 커밋 대화형 rebase

# 충돌 해결
git merge --abort           # 병합 취소
git rebase --abort         # rebase 취소
```

## 3. 고급 명령어

### 3.1 임시 저장
```bash
# 변경사항 임시 저장
git stash
git stash save "메시지"

# 임시 저장 목록 확인
git stash list

# 임시 저장 적용
git stash apply          # 최근 stash 적용
git stash apply stash@{n}  # 특정 stash 적용
git stash pop           # 적용 후 stash 제거

# 임시 저장 삭제
git stash drop stash@{n}
git stash clear         # 모든 stash 삭제
```

### 3.2 커밋 관리
```bash
# 마지막 커밋 수정
git commit --amend
git commit --amend --no-edit  # 메시지 수정 없이

# 이전 커밋 수정 (rebase -i 사용법)
git rebase -i <커밋해시>   # 해당 커밋의 바로 다음 커밋부터 수정
git rebase -i HEAD~3     # 최근 3개의 커밋 수정

# rebase -i 실행 시 나타나는 에디터에서 사용할 수 있는 명령어:
# p, pick   = 커밋 유지 (기본값)
# r, reword = 커밋 메시지만 수정
#   예시: pick 1234567 -> reword 1234567
#   저장 후 종료하면 새로운 에디터가 열려 메시지 수정 가능
# e, edit   = 커밋 자체를 수정
#   예시: pick 1234567 -> edit 1234567
#   저장 후 종료하면 해당 커밋 시점으로 이동
#   파일 수정 후 git add . && git commit --amend
#   수정 완료 후 git rebase --continue
# s, squash = 이전 커밋과 합치기
#   예시:
#   pick 1234567 첫 번째 커밋
#   squash 7654321 두 번째 커밋
#   저장 후 종료하면 두 커밋이 하나로 합쳐짐
# f, fixup  = 이전 커밋과 합치기 (커밋 메시지 무시)
# d, drop   = 커밋 삭제

# rebase -i 실제 예시:
# 1. 최근 3개 커밋의 메시지를 수정하고 싶은 경우
git rebase -i HEAD~3
# 에디터에서:
# reword 1234567 첫 번째 커밋
# reword 7654321 두 번째 커밋
# reword abcdefg 세 번째 커밋

# 2. 연속된 두 커밋을 하나로 합치고 싶은 경우
git rebase -i HEAD~2
# 에디터에서:
# pick 1234567 첫 번째 커밋
# squash 7654321 두 번째 커밋

# 3. 특정 커밋을 삭제하고 싶은 경우
git rebase -i HEAD~3
# 에디터에서:
# pick 1234567 첫 번째 커밋
# drop 7654321 두 번째 커밋 (이 커밋이 삭제됨)
# pick abcdefg 세 번째 커밋

# rebase 중 문제 발생 시
git rebase --abort     # rebase 취소하고 처음으로 돌아가기
git rebase --continue  # 충돌 해결 후 rebase 계속하기
git rebase --skip      # 현재 커밋을 건너뛰고 계속하기
```

### 3.3 문제 해결
```bash
# 파일 복구
git checkout -- <파일명>  # 워킹 디렉토리 변경사항 취소
git restore <파일명>     # Git 2.23+

# 커밋 되돌리기
git reset --soft HEAD~1   # 커밋만 취소 (변경사항 보존)
git reset --mixed HEAD~1  # 커밋과 스테이징 취소
git reset --hard HEAD~1   # 모든 변경사항 삭제

# 리모트 브랜치 초기화
git fetch origin
git reset --hard origin/<브랜치명>
```

## 4. 유용한 설정

### 4.1 별칭 설정
```bash
# ~/.gitconfig 또는 .git/config에 추가
[alias]
  st = status
  co = checkout
  br = branch
  ci = commit
  unstage = reset HEAD --
  last = log -1 HEAD
  lg = log --color --graph --pretty=format:'%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset' --abbrev-commit
```

### 4.2 글로벌 설정
```bash
# 사용자 정보 설정
git config --global user.name "이름"
git config --global user.email "이메일"

# 기본 브랜치 설정
git config --global init.defaultBranch main

# 자동 줄바꿈 설정
git config --global core.autocrlf input  # Mac/Linux
git config --global core.autocrlf true   # Windows
```

## 5. 모범 사례

### 5.1 커밋 메시지 규칙
```
<type>: <subject>

<body>

<footer>

# 타입 예시
feat: 새로운 기능 추가
fix: 버그 수정
docs: 문서 수정
style: 코드 포맷팅
refactor: 코드 리팩토링
test: 테스트 코드
chore: 빌드 업무 수정
```

### 5.2 브랜치 전략
```
main/master: 제품 출시 브랜치
develop: 개발 브랜치
feature/*: 기능 개발 브랜치
release/*: 출시 준비 브랜치
hotfix/*: 긴급 수정 브랜치
``` 