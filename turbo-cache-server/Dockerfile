FROM node:18-alpine

WORKDIR /app

# Turborepo CLI 설치
RUN npm install -g turbo

# 캐시 저장소 디렉토리 생성
RUN mkdir -p /app/cache

# 환경 변수 설정
ENV TURBO_TOKEN=your-secret-token
ENV STORAGE_PROVIDER=fs
ENV STORAGE_PATH=/app/cache

# 서버 실행
EXPOSE 3000
CMD ["turbo", "daemon", "--port", "3000"] 