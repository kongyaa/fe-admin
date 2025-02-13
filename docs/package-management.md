# 패키지 관리

## 패키지 구조

프로젝트는 pnpm 워크스페이스와 Turborepo를 사용하여 모노레포로 구성되어 있습니다.

### 워크스페이스 구조
```
fe-admin/
├── apps/
│   └── admin/
├── packages/
│   ├── api/
│   ├── ui/
│   ├── utils/
│   └── types/
└── package.json
```

## 패키지 관리 규칙

### 새로운 패키지 생성
1. packages 디렉토리 아래에 적절한 이름으로 디렉토리 생성
2. package.json 파일 생성
3. 필요한 의존성 설치
4. tsconfig.json 설정
5. 빌드 스크립트 설정

### 패키지 명명 규칙
- 모든 패키지는 `@fe-admin/` 스코프를 사용합니다.
- 패키지 이름은 기능을 명확하게 표현해야 합니다.

예시:
```json
{
  "name": "@fe-admin/ui",
  "version": "0.1.0"
}
```

### 의존성 관리
- 패키지 간 의존성은 workspace: 프로토콜을 사용합니다.
- 외부 의존성은 가능한 한 루트 package.json에서 관리합니다.
- 버전 충돌을 방지하기 위해 pnpm의 버전 관리 기능을 활용합니다.

예시:
```json
{
  "dependencies": {
    "@fe-admin/utils": "workspace:*",
    "@fe-admin/types": "workspace:*"
  }
}
```

## 빌드 설정

### Turborepo 파이프라인
- 각 패키지는 build, test, lint 스크립트를 제공해야 합니다.
- 패키지 간 의존성에 따라 빌드 순서가 자동으로 결정됩니다.

turbo.json 예시:
```json
{
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["build"],
      "outputs": []
    },
    "lint": {
      "outputs": []
    }
  }
}
```

## 패키지 배포

### 배포 프로세스
1. 변경사항 확인
2. 버전 업데이트
3. Changeset 생성
4. PR 생성 및 리뷰
5. 배포

### 버전 관리
- Semantic Versioning을 따릅니다.
- Changeset을 사용하여 버전과 변경사항을 관리합니다.

## 패키지 문서화

각 패키지는 다음 문서를 포함해야 합니다:
- README.md: 패키지 설명 및 사용법
- CHANGELOG.md: 변경사항 기록
- API 문서: TypeDoc을 사용한 API 문서화 