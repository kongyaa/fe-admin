# 초기 환경 구성

## 1. 프로젝트 초기화

### Node.js 버전 설정
```bash
# .nvmrc 파일 생성
echo "v18.18.2" > .nvmrc
```

### pnpm 워크스페이스 설정
```bash
# package.json 초기화
pnpm init

# pnpm-workspace.yaml 생성
packages:
  - 'apps/*'
  - 'packages/*'
```

## 2. Turborepo 설정

### Turborepo 초기화
```bash
pnpm dlx create-turbo@latest
```

### turbo.json 구성
```json
{
  "$schema": "https://turbo.build/schema.json",
  "globalDependencies": [".env"],
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**"]
    },
    "lint": {},
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

## 3. TypeScript 설정

### 기본 설정
```bash
# TypeScript 설치
pnpm add -D typescript @types/node @types/react @types/react-dom

# tsconfig.json 생성
pnpm tsc --init
```

### tsconfig.json 구성
```json
{
  "compilerOptions": {
    "target": "es5",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "node",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [
      {
        "name": "next"
      }
    ],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

## 4. ESLint 및 Prettier 설정

### ESLint 설정
```bash
# ESLint 설치
pnpm add -D eslint eslint-config-next @typescript-eslint/parser @typescript-eslint/eslint-plugin

# .eslintrc.js 생성
module.exports = {
  root: true,
  extends: ['next/core-web-vitals'],
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  rules: {
    // 프로젝트 규칙 추가
  }
};
```

### Prettier 설정
```bash
# Prettier 설치
pnpm add -D prettier prettier-plugin-tailwindcss

# .prettierrc 생성
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "all",
  "printWidth": 100,
  "arrowParens": "always",
  "endOfLine": "auto"
}
```

## 5. Git 설정

### .gitignore 설정
```
# dependencies
node_modules
.pnp
.pnp.js

# testing
coverage

# next.js
.next/
out/
build
dist

# misc
.DS_Store
*.pem

# debug
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# local env files
.env*.local

# turbo
.turbo

# typescript
*.tsbuildinfo
next-env.d.ts
```

## 6. 환경 변수 설정

### .env 파일 생성
```bash
# .env.example 생성
NODE_ENV=development
NEXT_PUBLIC_API_URL=http://localhost:3000
```

## 다음 단계
- [기본 패키지 구성](./02-package-setup.md)
- [어드민 앱 구현](./03-admin-app.md) 