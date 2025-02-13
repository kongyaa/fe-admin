# Fetch API 딥 다이브

## 1. Fetch API 개요

Fetch API는 네트워크 요청을 위한 현대적인 인터페이스를 제공합니다. XMLHttpRequest를 대체하며, Promise 기반으로 작동합니다.

### 기본 구문
```typescript
fetch(resource [, options])
```

## 2. 주요 특징

### 2.1 Promise 기반
- fetch는 Promise를 반환합니다.
- 네트워크 오류가 아닌 한 reject되지 않습니다 (404, 500 등의 HTTP 에러도 resolve됨)
- 실제 데이터는 Response 객체의 메서드를 통해 추출해야 합니다.

### 2.2 Response 객체
주요 프로퍼티와 메서드:
- `status`: HTTP 상태 코드 (200, 404 등)
- `ok`: 상태 코드가 200-299 범위인 경우 true
- `headers`: 응답 헤더
- `json()`: JSON 형태로 파싱
- `text()`: 텍스트로 파싱
- `blob()`: 바이너리 데이터로 파싱

### 2.3 요청 옵션
```typescript
{
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(data),
  mode: 'cors' | 'no-cors' | 'same-origin',
  credentials: 'same-origin' | 'include' | 'omit',
  cache: 'default' | 'no-store' | 'reload' | 'no-cache' | 'force-cache',
  redirect: 'follow' | 'error' | 'manual',
  referrerPolicy: 'no-referrer' | 'client'
}
```

## 3. 실제 사용 예제

### 3.1 기본적인 GET 요청
```typescript
const response = await fetch('https://api.example.com/data');
const data = await response.json();
```

### 3.2 에러 처리
```typescript
try {
  const response = await fetch('https://api.example.com/data');
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  const data = await response.json();
} catch (error) {
  console.error('Fetch error:', error);
}
```

### 3.3 POST 요청
```typescript
const response = await fetch('https://api.example.com/posts', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    title: 'New Post',
    body: 'Post content',
  }),
});
```

## 4. 고급 기능

### 4.1 AbortController를 사용한 요청 취소
```typescript
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 5000);

try {
  const response = await fetch(url, {
    signal: controller.signal
  });
  const data = await response.json();
  clearTimeout(timeoutId);
} catch (error) {
  if (error.name === 'AbortError') {
    console.log('Fetch aborted');
  }
}
```

### 4.2 Progress 모니터링 (Response Stream)
```typescript
const response = await fetch('https://api.example.com/large-file');
const reader = response.body.getReader();
const contentLength = +response.headers.get('Content-Length');

let receivedLength = 0;
while(true) {
  const {done, value} = await reader.read();
  if (done) break;
  
  receivedLength += value.length;
  const progress = (receivedLength / contentLength) * 100;
  console.log(`Progress: ${progress}%`);
}
```

## 5. 모범 사례

### 5.1 타임아웃 설정
```typescript
const fetchWithTimeout = async (url: string, timeout = 5000) => {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      signal: controller.signal
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
};
```

### 5.2 재시도 로직
```typescript
const fetchWithRetry = async (url: string, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
    }
  }
};
```

## 6. 주의사항

1. CORS (Cross-Origin Resource Sharing)
   - 브라우저의 동일 출처 정책으로 인한 제약
   - 서버에서 적절한 CORS 헤더 설정 필요

2. 응답 본문 소비
   - response.json()과 같은 메서드는 한 번만 호출 가능
   - 여러 번 필요한 경우 response.clone() 사용

3. 캐시 동작
   - 기본적으로 브라우저 캐시 사용
   - cache 옵션으로 제어 가능

## 다음 단계
- [CRUD 구현 예제](./02-crud-implementation.md)
- [에러 처리 전략](./03-error-handling.md) 