# Turborepo 스터디 가이드

## 1. Turborepo 기본 개념

Turborepo는 JavaScript/TypeScript 모노레포를 위한 빌드 시스템입니다. 주요 특징은 다음과 같습니다:

- 캐싱을 통한 빌드 성능 최적화
- 태스크 간의 의존성 관리
- 병렬 실행을 통한 성능 향상
- 원격 캐싱을 통한 CI/CD 최적화

## 2. 프로젝트 구조 설정

### 2.1 기본 구조
```bash
my-monorepo/
├── apps/              # 애플리케이션 코드
│   ├── web/          # 웹 애플리케이션
│   └── admin/        # 어드민 애플리케이션
├── packages/          # 공유 패키지
│   ├── ui/           # UI 컴포넌트
│   ├── config/       # 공통 설정
│   └── utils/        # 유틸리티 함수
├── package.json
├── turbo.json        # Turborepo 설정
└── pnpm-workspace.yaml
```

### 2.2 Workspace 설정
```yaml
# pnpm-workspace.yaml
packages:
  - "apps/*"
  - "packages/*"
  - "!**/dist"
```

### 2.3 Turborepo 설정
```json
// turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "globalDependencies": ["**/.env.*local"],
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**", "!.next/cache/**"]
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

## 3. 실습 예제

### 3.1 공유 UI 패키지 생성

```typescript
// packages/ui/src/Button.tsx
import React from 'react';

export interface ButtonProps {
  variant?: 'primary' | 'secondary';
  children: React.ReactNode;
  onClick?: () => void;
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  children,
  onClick
}) => {
  return (
    <button
      className={\`btn \${variant}\`}
      onClick={onClick}
    >
      {children}
    </button>
  );
};
```

```json
// packages/ui/package.json
{
  "name": "@my-monorepo/ui",
  "version": "0.1.0",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsup src/index.tsx --format cjs,esm --dts",
    "dev": "tsup src/index.tsx --format cjs,esm --dts --watch",
    "lint": "eslint src/**/*.ts*"
  },
  "devDependencies": {
    "tsup": "^6.0.0",
    "typescript": "^4.8.4"
  },
  "peerDependencies": {
    "react": "^18.0.0"
  }
}
```

### 3.2 애플리케이션에서 공유 패키지 사용

```typescript
// apps/web/src/pages/index.tsx
import { Button } from '@my-monorepo/ui';

export default function Home() {
  return (
    <div>
      <h1>Welcome to Web App</h1>
      <Button variant="primary">Click me</Button>
    </div>
  );
}
```

## 4. 주요 기능 활용

### 4.1 캐싱 활용
```bash
# 캐시된 빌드 실행
pnpm turbo build

# 캐시 무시하고 빌드
pnpm turbo build --force

# 특정 패키지만 빌드
pnpm turbo build --filter=@my-monorepo/ui
```

### 4.2 태스크 의존성 설정
```json
// turbo.json
{
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],  // 의존성 있는 패키지의 build를 먼저 실행
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["build"],   // 같은 패키지의 build를 먼저 실행
      "outputs": []
    }
  }
}
```

### 4.3 원격 캐싱 설정
```bash
# Vercel 원격 캐싱 설정
pnpm turbo login
pnpm turbo link

# 원격 캐시 활성화
pnpm turbo build --remote-only
```

## 5. 성능 최적화 전략

### 5.1 빌드 최적화
- 불필요한 재빌드 방지를 위한 의존성 설정
- 출력 파일 명확한 정의
- 캐시 전략 수립

```json
// turbo.json
{
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**"],
      "cache": true
    },
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

### 5.2 CI/CD 최적화
```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: ["main"]
  pull_request:
    branches: ["main"]

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v3
      
      - uses: pnpm/action-setup@v2
        with:
          version: 8
          
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: "18"
          cache: "pnpm"
          
      - name: Install dependencies
        run: pnpm install
        
      - name: Build
        run: pnpm turbo build
        env:
          TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
          TURBO_TEAM: ${{ secrets.TURBO_TEAM }}
```

## 6. 모범 사례

### 6.1 패키지 구조화
- 관심사 분리에 따른 패키지 분할
- 순환 참조 방지
- 명확한 의존성 관계 정의

### 6.2 스크립트 표준화
```json
// package.json
{
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "lint": "turbo run lint",
    "test": "turbo run test",
    "clean": "turbo run clean && rm -rf node_modules"
  }
}
```

### 6.3 개발 워크플로우
1. 새로운 기능 개발 시작
   ```bash
   pnpm turbo dev --filter=@my-monorepo/web...
   ```

2. 변경사항 테스트
   ```bash
   pnpm turbo test --filter=[현재 작업중인 패키지]
   ```

3. 전체 빌드 및 테스트
   ```bash
   pnpm turbo build test
   ```

## 7. 문제 해결 가이드

### 7.1 캐시 관련 문제
- 캐시 초기화: `pnpm turbo clean`
- 강제 재빌드: `pnpm turbo build --force`
- 캐시 위치 확인: `.turbo` 디렉토리

### 7.2 의존성 문제
- 순환 참조 확인
- package.json의 의존성 정확성 검증
- workspace 설정 확인

## 8. 추가 학습 자료
- [Turborepo 공식 문서](https://turbo.build/repo/docs)
- [모노레포 모범 사례](https://turbo.build/repo/docs/handbook)
- [성능 최적화 가이드](https://turbo.build/repo/docs/core-concepts/caching) 