#!/bin/bash

# 스크립트 디렉토리로 이동
cd "$(dirname "$0")"
cd ../turbo-cache-server

# 환경 변수 로드
source ../.env

# Docker Compose로 캐시 서버 시작
docker-compose up -d

# 헬스체크
echo "Waiting for cache server to be ready..."
for i in {1..30}; do
  if curl -s http://localhost:3000/health > /dev/null; then
    echo "Cache server is ready!"
    exit 0
  fi
  echo "Waiting... ($i/30)"
  sleep 1
done

echo "Cache server failed to start"
docker-compose logs
exit 1 