# Turborepo 원격 캐시 활용 실습

이 예제에서는 Turborepo의 원격 캐시 기능을 실제로 경험해볼 수 있습니다.

## 1. 원격 캐시 설정 방법

### 1.1 Vercel을 통한 원격 캐시 설정

```bash
# Vercel CLI 설치
pnpm add -g vercel

# Vercel에 로그인
pnpm turbo login

# 프로젝트와 원격 캐시 연결
pnpm turbo link
```

### 1.2 자체 원격 캐시 서버 설정

```typescript
// remote-cache-server/src/index.ts
import express from 'express';
import { createTurboHandler } from '@turbo/remote-cache';

const app = express();
const PORT = process.env.PORT || 3000;

// 캐시 핸들러 설정
const handler = createTurboHandler({
  // 캐시 저장소 설정
  storage: {
    type: 'local',  // 또는 's3', 'gcs' 등
    path: './cache' // 로컬 저장소 경로
  },
  // 인증 설정
  auth: {
    key: process.env.TURBO_API_KEY
  }
});

// 캐시 엔드포인트 설정
app.use('/v8/artifacts', handler);

app.listen(PORT, () => {
  console.log(`Remote cache server running on port ${PORT}`);
});
```

```json
// remote-cache-server/package.json
{
  "name": "remote-cache-server",
  "version": "1.0.0",
  "scripts": {
    "start": "ts-node src/index.ts"
  },
  "dependencies": {
    "express": "^4.18.2",
    "@turbo/remote-cache": "latest"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "ts-node": "^10.9.2",
    "typescript": "^5.0.0"
  }
}
```

## 2. 원격 캐시 설정하기

### 2.1 프로젝트 설정

```json
// turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "remoteCache": {
    "enabled": true,
    "teamId": "your-team-id",  // Vercel 팀 ID
    "signature": true          // 캐시 서명 활성화
  },
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"],
      "cache": true
    }
  }
}
```

### 2.2 환경 변수 설정

```bash
# .env
TURBO_API_KEY=your-api-key
TURBO_TEAM=your-team-name
TURBO_REMOTE_CACHE_URL=https://your-cache-server.com
```

## 3. 원격 캐시 활용 실습

### 3.1 초기 빌드 및 캐시 생성

```bash
# 전체 프로젝트 빌드
pnpm turbo build

# 결과 예시:
# packages/utils:build: cache miss, executing 2.31s
# apps/calculator:build: cache miss, executing 1.85s
# 
# Tasks: 2 successful, 2 total
# Time: 4.16s >>> FULL TURBO
# Remote cache uploaded in 1.2s
```

### 3.2 다른 환경에서 캐시 활용

```bash
# 새로운 환경에서 빌드
git clone your-repo
cd your-repo
pnpm install
pnpm turbo build

# 결과 예시:
# packages/utils:build: remote cache hit, replaying output 0.15s
# apps/calculator:build: remote cache hit, replaying output 0.12s
#
# Tasks: 2 successful, 2 total
# Time: 0.27s >>> FULL TURBO
```

## 4. 원격 캐시 모니터링

### 4.1 캐시 통계 확인

```bash
# 캐시 히트율 확인
pnpm turbo build --dry-run

# 결과 예시:
# Remote cache hits: 85%
# Local cache hits: 10%
# Cache misses: 5%
```

### 4.2 캐시 사용량 모니터링

```typescript
// remote-cache-server/src/monitor.ts
import { getCacheStats } from '@turbo/remote-cache';

async function monitorCache() {
  const stats = await getCacheStats();
  console.log('Cache Size:', stats.totalSize);
  console.log('Cache Items:', stats.itemCount);
  console.log('Hit Rate:', stats.hitRate);
}

monitorCache();
```

## 5. 원격 캐시 최적화 전략

### 5.1 캐시 정책 설정

```json
// turbo.json
{
  "remoteCache": {
    "enabled": true,
    "maxAge": "7d",      // 캐시 유효 기간
    "signature": true,   // 캐시 무결성 검증
    "compressionLevel": 6 // 압축 레벨 (1-9)
  }
}
```

### 5.2 선택적 캐시 업로드

```json
// turbo.json
{
  "tasks": {
    "build": {
      "cache": true,
      "remoteCache": {
        "enabled": true,
        "outputs": ["dist/**", "!dist/**/*.map"]
      }
    },
    "test": {
      "cache": true,
      "remoteCache": {
        "enabled": false  // 테스트 결과는 원격 캐시에 저장하지 않음
      }
    }
  }
}
```

## 6. 실전 팁

### 6.1 CI/CD 환경 설정

```yaml
# .github/workflows/build.yml
name: Build
on: [push]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: pnpm/action-setup@v2
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'pnpm'
          
      - name: Install dependencies
        run: pnpm install
        
      - name: Setup Turborepo cache
        uses: actions/cache@v3
        with:
          path: .turbo
          key: ${{ runner.os }}-turbo-${{ github.sha }}
          restore-keys: |
            ${{ runner.os }}-turbo-
            
      - name: Build
        run: pnpm turbo build
        env:
          TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
          TURBO_TEAM: ${{ secrets.TURBO_TEAM }}
```

### 6.2 캐시 디버깅

```bash
# 캐시 동작 상세 로그 확인
pnpm turbo build --debug

# 원격 캐시 연결 테스트
pnpm turbo build --remote-only

# 로컬 캐시만 사용
pnpm turbo build --no-remote
```

### 6.3 캐시 최적화 체크리스트

- [ ] 빌드 출력이 결정적(deterministic)인지 확인
- [ ] 불필요한 파일이 캐시되지 않도록 설정
- [ ] 환경 변수가 적절히 관리되고 있는지 확인
- [ ] 캐시 서명이 활성화되어 있는지 확인
- [ ] CI/CD 환경에서 캐시가 올바르게 복원되는지 확인

### 6.4 모니터링 및 알림 설정

```typescript
// remote-cache-server/src/alerts.ts
import { monitorCache } from './monitor';
import { sendSlackAlert } from './slack';

async function checkCacheHealth() {
  const stats = await monitorCache();
  
  // 캐시 히트율이 낮을 때 알림
  if (stats.hitRate < 0.7) {
    await sendSlackAlert({
      channel: '#dev-ops',
      message: `⚠️ Cache hit rate is low: ${stats.hitRate * 100}%`
    });
  }
  
  // 캐시 용량이 많이 찼을 때 알림
  if (stats.usedSpace > stats.totalSpace * 0.9) {
    await sendSlackAlert({
      channel: '#dev-ops',
      message: `🚨 Cache storage is almost full: ${stats.usedSpace}/${stats.totalSpace}`
    });
  }
}

// 주기적으로 체크
setInterval(checkCacheHealth, 1000 * 60 * 60); // 1시간마다
```

## 7. 문제 해결

### 7.1 일반적인 문제

1. **캐시 불일치**
   ```bash
   # 캐시 강제 무효화
   pnpm turbo clean
   
   # 원격 캐시 재설정
   pnpm turbo link --reset
   ```

2. **인증 문제**
   ```bash
   # 토큰 재설정
   pnpm turbo logout
   pnpm turbo login
   
   # 환경 변수 확인
   echo $TURBO_TOKEN
   echo $TURBO_TEAM
   ```

3. **네트워크 문제**
   ```bash
   # 연결 테스트
   curl -I $TURBO_REMOTE_CACHE_URL
   
   # 프록시 설정
   export HTTPS_PROXY=http://proxy.company.com:8080
   ```

### 7.2 성능 문제

1. **느린 캐시 업로드**
   ```json
   // turbo.json
   {
     "remoteCache": {
       "enabled": true,
       "compressionLevel": 3,  // 압축 레벨 낮춤
       "signature": false      // 서명 비활성화 (보안 수준 낮아짐)
     }
   }
   ```

2. **큰 캐시 크기**
   ```json
   // turbo.json
   {
     "tasks": {
       "build": {
         "outputs": [
           "dist/**",
           "!dist/**/*.map",    // 소스맵 제외
           "!dist/**/*.stats.json" // 통계 파일 제외
         ]
       }
     }
   }
   ``` 