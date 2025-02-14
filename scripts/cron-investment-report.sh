#!/bin/bash

# 스크립트 디렉토리로 이동
cd "$(dirname "$0")"

# 환경 변수 설정
export PATH="/usr/local/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# OpenAI API 키 설정 (실제 키로 변경 필요)
export OPENAI_API_KEY="your-api-key-here"

# Node.js 버전 설정
nvm use 18

# 현재 날짜
TODAY=$(date '+%Y-%m-%d')

# 로그 디렉토리 생성
mkdir -p logs

# 리포트 생성
echo "[$TODAY] 투자 분석 리포트 생성 시작" >> logs/investment-report.log

# 시뮬레이션 및 AI 분석 실행
pnpm analyze >> logs/investment-report.log 2>&1

# 결과 확인
if [ $? -eq 0 ]; then
  echo "[$TODAY] 분석 완료" >> logs/investment-report.log
else
  echo "[$TODAY] 분석 실패" >> logs/investment-report.log
  exit 1
fi

# Git 커밋 및 푸시
if [ -d "../.git" ]; then
  cd ..
  git add docs/investment/analysis/daily-report.md
  git commit -m "docs: 일일 투자 분석 리포트 업데이트 ($TODAY)"
  git push
  echo "[$TODAY] Git 저장소 업데이트 완료" >> scripts/logs/investment-report.log
fi

# 슬랙 알림 전송 (선택사항)
if [ -n "$SLACK_WEBHOOK_URL" ]; then
  curl -X POST -H 'Content-type: application/json' \
    --data "{\"text\":\"📊 일일 투자 분석 리포트가 업데이트되었습니다.\n날짜: $TODAY\n링크: https://github.com/your-repo/docs/investment/analysis/daily-report.md\"}" \
    "$SLACK_WEBHOOK_URL"
fi

echo "[$TODAY] 프로세스 완료" >> scripts/logs/investment-report.log 