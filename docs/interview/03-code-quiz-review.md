# getNames 함수 코드 리뷰

## 1. 현재 코드 분석
```typescript
function getNames(emailIds) {
  return emailIds.map((emailId) => {
    const user = users.find((user) => {
      return user.email === emailId
    });
    return user?.name || emailId
  })
}
```

## 2. 개선이 필요한 부분

### 2.1 타입 안전성
- 매개변수와 반환값에 대한 타입 정의가 없음
- users 배열의 출처와 타입이 불명확
- 옵셔널 체이닝 사용 시 타입 추론이 제한적

### 2.2 성능
- users 배열을 매번 순회하는 비효율적인 구조
- 중복된 이메일 검색 시 캐싱 메커니즘 부재
- O(n * m) 시간 복잡도 (n: emailIds 길이, m: users 길이)

### 2.3 에러 처리
- 잘못된 이메일 형식에 대한 검증 부재
- users 배열이 undefined인 경우 처리 부재
- 에러 상황에 대한 명확한 피드백 부재

### 2.4 코드 스타일
- 불필요한 중첩된 화살표 함수
- 일관성 없는 return 문 사용
- 함수의 책임이 다소 모호

## 3. 개선된 코드 제안

### 3.1 기본적인 개선
```typescript
interface User {
  email: string;
  name: string;
}

function getNames(emailIds: string[]): string[] {
  if (!Array.isArray(emailIds)) {
    throw new Error('emailIds must be an array');
  }

  return emailIds.map(emailId => {
    const user = users.find(user => user.email === emailId);
    return user?.name || emailId;
  });
}
```

### 3.2 성능 최적화 버전
```typescript
interface User {
  email: string;
  name: string;
}

function getNames(emailIds: string[]): string[] {
  if (!Array.isArray(emailIds)) {
    throw new Error('emailIds must be an array');
  }

  // 이메일을 키로 하는 맵 생성
  const userMap = new Map(
    users.map(user => [user.email, user.name])
  );

  return emailIds.map(emailId => userMap.get(emailId) || emailId);
}
```

### 3.3 더 견고한 버전
```typescript
interface User {
  email: string;
  name: string;
}

interface GetNamesResult {
  success: boolean;
  names: string[];
  errors?: string[];
}

function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function getNames(emailIds: string[]): GetNamesResult {
  if (!Array.isArray(emailIds)) {
    return {
      success: false,
      names: [],
      errors: ['Invalid input: emailIds must be an array']
    };
  }

  const userMap = new Map(
    users.map(user => [user.email, user.name])
  );

  const errors: string[] = [];
  const names = emailIds.map(emailId => {
    if (!isValidEmail(emailId)) {
      errors.push(`Invalid email format: ${emailId}`);
      return emailId;
    }
    return userMap.get(emailId) || emailId;
  });

  return {
    success: errors.length === 0,
    names,
    ...(errors.length > 0 && { errors })
  };
}
```

## 4. 개선 사항 설명

### 4.1 타입 안전성 향상
- 인터페이스 정의로 타입 안전성 확보
- 함수 시그니처의 명확한 타입 정의
- 반환값 타입 명시로 사용처에서의 타입 추론 개선

### 4.2 성능 최적화
- Map 자료구조 사용으로 조회 성능 O(1)로 개선
- 불필요한 배열 순회 제거
- 메모리와 성능의 적절한 트레이드오프

### 4.3 에러 처리 강화
- 입력값 검증 로직 추가
- 이메일 형식 검증
- 명확한 에러 메시지와 결과 구조

### 4.4 코드 품질 향상
- 함수의 단일 책임 원칙 준수
- 가독성 있는 코드 구조
- 재사용 가능한 유틸리티 함수 분리

## 5. 사용 예시

```typescript
// 기본 사용
const result = getNames(['user1@example.com', 'user2@example.com']);
console.log(result.names); // ['User1', 'User2']

// 에러 처리
const resultWithError = getNames(['invalid-email', 'user@example.com']);
if (!resultWithError.success) {
  console.error(resultWithError.errors);
}
```

## 6. 추가 고려사항

### 6.1 캐싱 전략
```typescript
const nameCache = new Map<string, string>();

function getNames(emailIds: string[]): GetNamesResult {
  // 캐시 적용 로직
}
```

### 6.2 비동기 처리
```typescript
async function getNames(emailIds: string[]): Promise<GetNamesResult> {
  // 비동기 처리 로직
}
```

### 6.3 테스트 용이성
```typescript
function getNames(
  emailIds: string[],
  userMap?: Map<string, string>
): GetNamesResult {
  // 의존성 주입을 통한 테스트 용이성 확보
}
``` 