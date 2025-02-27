# Turborepo 캐시 활용 실습

이 예제에서는 Turborepo의 캐시 기능을 실제로 경험해볼 수 있습니다.

## 1. 프로젝트 구조

```bash
cache-example/
├── packages/
│   └── utils/          # 공통 유틸리티 패키지
│       ├── src/
│       │   ├── math.ts
│       │   └── format.ts
│       └── package.json
├── apps/
│   └── calculator/     # 계산기 애플리케이션
│       ├── src/
│       │   └── index.ts
│       └── package.json
├── package.json
└── turbo.json
```

## 2. 패키지 구현

### 2.1 유틸리티 패키지 (packages/utils)

```typescript
// packages/utils/src/math.ts
export const add = (a: number, b: number): number => a + b;
export const subtract = (a: number, b: number): number => a - b;
export const multiply = (a: number, b: number): number => a * b;
export const divide = (a: number, b: number): number => {
  if (b === 0) throw new Error('Division by zero');
  return a / b;
};

// 복잡한 계산을 시뮬레이션하기 위한 함수
export const complexCalculation = (input: number): number => {
  // 의도적으로 시간이 걸리는 연산
  let result = input;
  for (let i = 0; i < 1000000; i++) {
    result = Math.sqrt(result * i);
  }
  return result;
};
```

```typescript
// packages/utils/src/format.ts
export const formatNumber = (num: number): string => {
  return new Intl.NumberFormat('ko-KR').format(num);
};

export const formatCurrency = (amount: number): string => {
  return new Intl.NumberFormat('ko-KR', {
    style: 'currency',
    currency: 'KRW'
  }).format(amount);
};
```

```json
// packages/utils/package.json
{
  "name": "@cache-example/utils",
  "version": "1.0.0",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsup src/index.ts --format cjs,esm --dts --clean",
    "dev": "tsup src/index.ts --format cjs,esm --dts --watch",
    "test": "jest",
    "lint": "eslint src/**/*.ts"
  },
  "devDependencies": {
    "@types/jest": "^29.0.0",
    "jest": "^29.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.0.0"
  }
}
```

### 2.2 계산기 애플리케이션 (apps/calculator)

```typescript
// apps/calculator/src/index.ts
import { add, multiply, complexCalculation, formatCurrency } from '@cache-example/utils';

async function main() {
  console.time('Calculation');
  
  // 복잡한 계산 수행
  const baseNumber = 1000;
  const result1 = complexCalculation(baseNumber);
  console.log('Complex calculation result:', formatCurrency(result1));
  
  // 기본 연산 수행
  const result2 = multiply(add(100, 200), 3);
  console.log('Basic calculation result:', formatCurrency(result2));
  
  console.timeEnd('Calculation');
}

main().catch(console.error);
```

```json
// apps/calculator/package.json
{
  "name": "@cache-example/calculator",
  "version": "1.0.0",
  "scripts": {
    "build": "tsup src/index.ts --format cjs,esm --clean",
    "start": "node dist/index.js",
    "dev": "tsup src/index.ts --format cjs,esm --watch",
    "test": "jest",
    "lint": "eslint src/**/*.ts"
  },
  "dependencies": {
    "@cache-example/utils": "workspace:*"
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "typescript": "^5.0.0"
  }
}
```

## 3. Turborepo 설정

```json
// turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"],
      "cache": true
    },
    "test": {
      "dependsOn": ["build"],
      "outputs": ["coverage/**"],
      "cache": true
    },
    "lint": {
      "outputs": []
    },
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

## 4. 캐시 활용 실습

### 4.1 초기 빌드 실행

```bash
# 전체 프로젝트 빌드
pnpm turbo build

# 결과 예시:
# packages/utils:build: cache miss, executing 2.31s
# apps/calculator:build: cache miss, executing 1.85s
# 
# Tasks: 2 successful, 2 total
# Time: 4.16s >>> FULL TURBO
```

### 4.2 캐시된 빌드 실행

```bash
# 동일한 빌드 다시 실행
pnpm turbo build

# 결과 예시:
# packages/utils:build: cache hit, replaying output 0.15s
# apps/calculator:build: cache hit, replaying output 0.12s
#
# Tasks: 2 successful, 2 total
# Time: 0.27s >>> FULL TURBO
```

### 4.3 특정 패키지 변경 후 빌드

```typescript
// packages/utils/src/math.ts 수정
export const add = (a: number, b: number): number => {
  console.log('Adding:', a, b);  // 로그 추가
  return a + b;
};
```

```bash
# 빌드 실행
pnpm turbo build

# 결과 예시:
# packages/utils:build: cache miss, executing 2.35s
# apps/calculator:build: cache miss, executing 1.88s
#
# Tasks: 2 successful, 2 total
# Time: 4.23s >>> FULL TURBO
```

### 4.4 의존성이 없는 패키지만 빌드

```bash
# calculator 앱만 빌드
pnpm turbo build --filter=@cache-example/calculator

# 결과 예시:
# apps/calculator:build: cache hit, replaying output 0.12s
#
# Tasks: 1 successful, 1 total
# Time: 0.12s >>> FULL TURBO
```

## 5. 캐시 동작 원리 이해하기

### 5.1 캐시 키 생성 요소
- 소스 파일의 내용
- 의존성 패키지의 버전
- 환경 변수
- turbo.json의 설정

### 5.2 캐시 저장 위치
```bash
# 로컬 캐시 위치
.turbo/turbo-cache.json

# 원격 캐시 설정 (선택사항)
pnpm turbo login
pnpm turbo link
```

### 5.3 캐시 무효화 조건
1. 소스 코드 변경
2. 의존성 버전 변경
3. 환경 변수 변경
4. turbo.json 설정 변경

## 6. 캐시 최적화 전략

### 6.1 출력 파일 최적화
```json
// turbo.json
{
  "pipeline": {
    "build": {
      "outputs": [
        "dist/**",
        "!dist/**/*.map"  // 소스맵 제외
      ]
    }
  }
}
```

### 6.2 환경 변수 관리
```json
// turbo.json
{
  "pipeline": {
    "build": {
      "env": [
        "NEXT_PUBLIC_API_URL",
        "NODE_ENV"
      ]
    }
  }
}
```

### 6.3 캐시 정책 설정
```json
// turbo.json
{
  "pipeline": {
    "build": {
      "cache": true,
      "outputs": ["dist/**"],
      "outputMode": "hash-only"  // 출력 파일 해시만 저장
    },
    "test": {
      "cache": true,
      "outputs": ["coverage/**"]
    }
  }
}
```

## 7. 실전 팁

### 7.1 캐시 디버깅
```bash
# 캐시 히트/미스 상세 정보 확인
pnpm turbo build --debug

# 캐시 강제 무효화
pnpm turbo build --force

# 특정 태스크의 캐시만 초기화
pnpm turbo clean --filter=@cache-example/utils
```

### 7.2 캐시 최적화 체크리스트
- [ ] 불필요한 파일이 outputs에 포함되지 않았는지 확인
- [ ] 환경 변수가 적절히 관리되고 있는지 확인
- [ ] 의존성 그래프가 최적화되어 있는지 확인
- [ ] 빌드 스크립트가 결정적(deterministic)인지 확인

### 7.3 모니터링
```bash
# 캐시 히트율 확인
pnpm turbo build --dry-run

# 태스크 실행 시간 분석
pnpm turbo build --profile

# 의존성 그래프 시각화
pnpm turbo graph
``` 