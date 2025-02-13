# 포켓몬 API 구현

## 1. 개요

PokeAPI를 활용한 포켓몬 데이터 조회 기능을 구현했습니다. 실제 업무 레벨의 API 클라이언트 구현을 위한 예제입니다.

## 2. 핵심 컴포넌트

### 2.1 HTTP 클라이언트 (`HttpClient`)
```typescript
class HttpClient {
  constructor(baseURL: string);
  get<T>(path: string, config?: RequestConfig): Promise<T>;
  post<T>(path: string, data?: unknown, config?: RequestConfig): Promise<T>;
  patch<T>(path: string, data?: unknown, config?: RequestConfig): Promise<T>;
  delete<T>(path: string, config?: RequestConfig): Promise<T>;
}
```

### 2.2 캐시 관리 (`Cache`)
```typescript
class Cache<T> {
  constructor(config: CacheConfig);
  set(key: string, value: T): void;
  get(key: string): T | undefined;
  clear(): void;
  delete(key: string): void;
}
```

### 2.3 에러 처리
```typescript
class ApiError extends Error {
  constructor(message: string, status: number, code?: string, data?: unknown);
  static fromHttpError(error: Error & { status?: number; data?: unknown }): ApiError;
}
```

## 3. 설정 관리

### 3.1 API 설정
```typescript
const API_CONFIG = {
  baseURL: 'https://pokeapi.co/api/v2',
  defaultParams: {
    limit: 20,
  },
  timeout: 10000,
} as const;
```

### 3.2 캐시 설정
```typescript
const CACHE_CONFIG = {
  ttl: 5 * 60 * 1000, // 5분
  maxSize: 100,
} as const;
```

## 4. 포켓몬 API 클라이언트

### 4.1 기능
- 포켓몬 목록 조회 (페이지네이션 지원)
- 개별 포켓몬 상세 정보 조회
- 응답 데이터 캐싱
- 자동 캐시 만료 (TTL)
- 캐시 크기 제한

### 4.2 사용 예시
```typescript
const client = new PokemonClient();

// 포켓몬 목록 조회
const list = await client.getPokemonList(0, 20);

// 특정 포켓몬 조회 (캐시 자동 적용)
const pokemon = await client.getPokemon('pikachu');

// 캐시 수동 정리
client.clearCache();
```

## 5. 구현된 기능

### 5.1 HTTP 통신
- 표준화된 HTTP 메서드 지원
- URL 파라미터 자동 처리
- 요청/응답 인터셉터
- 타입 안전성 보장

### 5.2 캐싱
- 인메모리 캐시
- TTL 기반 만료
- LRU 캐시 정책
- 자동 캐시 정리

### 5.3 에러 처리
- 커스텀 에러 클래스
- HTTP 에러 변환
- 네트워크 에러 처리
- 타임아웃 처리

## 6. 향후 개선 사항

### 6.1 단기 개선 사항
- [ ] 요청 재시도 메커니즘 추가
- [ ] 요청 취소 기능 구현
- [ ] 요청 우선순위 설정
- [ ] 배치 요청 최적화

### 6.2 중장기 개선 사항
- [ ] 영구 스토리지 캐시 구현
- [ ] 실시간 데이터 동기화
- [ ] 오프라인 모드 지원
- [ ] 성능 메트릭 수집

## 7. 참고 사항

- PokeAPI 공식 문서: https://pokeapi.co/docs/v2
- HTTP 클라이언트는 fetch API를 기반으로 구현
- 타입스크립트의 제네릭을 활용한 타입 안전성 보장
- 모듈화된 설계로 유지보수성 향상 