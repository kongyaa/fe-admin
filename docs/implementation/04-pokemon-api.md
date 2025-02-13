# 포켓몬 API 구현

## 1. 개요

PokeAPI를 활용한 포켓몬 데이터 조회 기능을 구현했습니다. 이는 fetch API 학습을 위한 예제로 구현되었습니다.

## 2. API 구조

### 2.1 기본 구성
```typescript
// Base URL
const BASE_URL = 'https://pokeapi.co/api/v2';

// API 엔드포인트
- /pokemon: 포켓몬 목록 조회
- /pokemon/{id}: 특정 포켓몬 상세 정보 조회
```

### 2.2 주요 인터페이스
```typescript
// 포켓몬 목록 응답
interface PokemonListResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: {
    name: string;
    url: string;
  }[];
}

// 포켓몬 상세 정보
interface Pokemon {
  id: number;
  name: string;
  height: number;
  weight: number;
  sprites: {
    front_default: string;
    back_default: string;
  };
  types: {
    slot: number;
    type: {
      name: string;
    };
  }[];
}
```

## 3. 구현된 기능

### 3.1 포켓몬 목록 조회
- 함수: `getPokemonList(offset = 0, limit = 20)`
- 페이지네이션 지원
- 기본값: 한 페이지당 20개 항목

### 3.2 포켓몬 상세 정보 조회
- 함수: `getPokemon(nameOrId: string | number)`
- 이름 또는 ID로 조회 가능

## 4. 사용 예시

```typescript
// 포켓몬 목록 조회
const list = await getPokemonList(0, 20);

// 특정 포켓몬 조회
const pokemon = await getPokemon('pikachu');
// 또는
const pokemon = await getPokemon(25);
```

## 5. 향후 개선 사항

### 5.1 단기 개선 사항
- [ ] 에러 처리 고도화
- [ ] 응답 데이터 캐싱 구현
- [ ] 타입 안정성 강화

### 5.2 중장기 개선 사항
- [ ] HTTP 클라이언트 추상화
- [ ] 환경 설정 분리
- [ ] 테스트 코드 작성
- [ ] API 요청 로깅 및 모니터링

## 6. 참고 사항

- PokeAPI 공식 문서: https://pokeapi.co/docs/v2
- 현재 구현은 기본적인 fetch API만을 사용하여 구현되었습니다.
- 실제 프로덕션 환경에서는 더 견고한 에러 처리와 캐싱이 필요합니다. 