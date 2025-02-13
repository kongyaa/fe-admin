# 개발 가이드

## 개발 환경 설정

### 필수 요구사항
- Node.js v18.18.2 이상
- pnpm v8.x 이상
- Git

### 프로젝트 설정
```bash
# 저장소 클론
git clone [repository-url]

# 의존성 설치
pnpm install

# 개발 서버 실행
pnpm dev
```

## 코드 스타일

### TypeScript
- 모든 코드는 TypeScript로 작성되어야 합니다.
- `any` 타입 사용을 지양합니다.
- 가능한 한 명시적인 타입을 사용합니다.

### 컴포넌트 작성 규칙
- 함수형 컴포넌트를 사용합니다.
- props 타입은 명시적으로 정의합니다.
- 컴포넌트 파일명은 PascalCase를 사용합니다.

```typescript
// 좋은 예시
interface ButtonProps {
  label: string;
  onClick: () => void;
}

const Button: React.FC<ButtonProps> = ({ label, onClick }) => {
  return <button onClick={onClick}>{label}</button>;
};
```

### 파일 구조
- 관련된 코드는 같은 디렉토리에 위치시킵니다.
- 컴포넌트와 관련된 스타일, 테스트는 같은 디렉토리에 위치시킵니다.

```
Button/
├── index.tsx
├── styles.ts
├── Button.test.tsx
└── types.ts
```

## Git 작업 규칙

### 브랜치 전략
- main: 프로덕션 브랜치
- develop: 개발 브랜치
- feature/*: 기능 개발 브랜치
- bugfix/*: 버그 수정 브랜치

### 커밋 메시지 규칙
```
feat: 새로운 기능 추가
fix: 버그 수정
docs: 문서 수정
style: 코드 포맷팅
refactor: 코드 리팩토링
test: 테스트 코드 추가/수정
chore: 빌드 프로세스 또는 보조 도구 변경
```

## 테스트

### 단위 테스트
- 모든 공유 패키지는 단위 테스트를 포함해야 합니다.
- Jest와 React Testing Library를 사용합니다.

### E2E 테스트
- 주요 사용자 시나리오에 대한 E2E 테스트를 작성합니다.
- Cypress를 사용합니다.

## 배포

### 배포 프로세스
1. develop 브랜치에서 테스트 완료
2. main 브랜치로 PR 생성
3. 코드 리뷰 진행
4. main 브랜치 머지
5. 자동 배포 진행 