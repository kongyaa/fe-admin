# 시니어 프론트엔드 개발자 면접 질문 리스트

## 1. 프로젝트 경험 기반 질문

### 1.1 Vue.js에서 React로의 전환 프로젝트
1. Vue.js와 React의 라이프사이클 차이점을 경험하면서 가장 주의 깊게 다룬 부분은 무엇인가요?
2. 컨버팅 과정에서 발생한 주요 기술적 문제들과 해결 방법을 설명해주세요.
3. Tanstack Table 도입을 제안하게 된 구체적인 배경과 도입 후 개선된 점을 설명해주세요.
4. 테이블 컴포넌트의 타입 설계 시 고려한 확장성 포인트는 무엇이었나요?

### 1.2 번역 자동화 스크립트 개발
1. vue-i18n-extract 라이브러리를 선택한 기술적 이유는 무엇인가요?
2. 자동화 스크립트 개발 시 에러 처리와 복구 전략은 어떻게 설계했나요?
3. 팀 내 다른 개발자들의 사용성을 고려한 설계 포인트는 무엇이었나요?
4. 해당 도구의 성능 개선을 위해 추가로 고려했던 부분이 있었나요?

### 1.3 신상배송 결제 내부 개선
1. E2E 테스트를 선행한 이유와 구체적인 테스트 전략을 설명해주세요.
2. 클라이언트 상태와 서버 상태를 분리한 구체적인 기준은 무엇이었나요?
3. 결제 시스템에서 가장 중요하게 생각한 기술적 요구사항은 무엇이었나요?
4. 팀원들과의 도메인 지식 공유를 위해 어떤 방식을 사용했나요?

## 2. 기술 심화 질문

### 2.1 프론트엔드 아키텍처
1. 모노레포 구성 시 고려해야 할 주요 포인트는 무엇이라고 생각하시나요?
   ```typescript
   // 예시 구조에 대한 의견
   workspace/
     ├── packages/
     │   ├── shared/
     │   ├── web/
     │   └── admin/
     └── package.json
   ```

2. 마이크로프론트엔드 아키텍처를 고려해본 적이 있나요? 어떤 상황에서 도입을 추천하시나요?
   ```typescript
   // 예시 시나리오
   interface MicroFrontend {
     name: string;
     entry: string;
     container: string;
     exposedModules: string[];
   }
   ```

3. 프론트엔드에서 상태 관리 전략을 결정할 때 고려하는 기준은 무엇인가요?
   ```typescript
   // 예시 상황
   interface StateManagement {
     local: typeof useState;
     shared: typeof useContext;
     global: typeof createStore;
   }
   ```

### 2.2 성능 최적화
1. 대규모 테이블 데이터 렌더링 시 성능 최적화 전략은 무엇인가요?
   ```typescript
   interface OptimizationStrategy {
     virtualization: boolean;
     pagination: boolean;
     lazyLoading: boolean;
     caching: boolean;
   }
   ```

2. 번들 사이즈 최적화를 위해 사용해본 전략들을 설명해주세요.
   ```typescript
   // 예시 코드
   const DynamicComponent = dynamic(() => import('./Heavy'), {
     loading: () => <Loading />,
     ssr: false
   });
   ```

3. 프론트엔드 성능 메트릭스 중 가장 중요하게 생각하는 지표는 무엇인가요?
   ```typescript
   interface PerformanceMetrics {
     FCP: number; // First Contentful Paint
     LCP: number; // Largest Contentful Paint
     TTI: number; // Time to Interactive
     TBT: number; // Total Blocking Time
   }
   ```

### 2.3 테스트 및 품질
1. E2E 테스트와 단위 테스트의 적절한 비율은 어떻게 결정하시나요?
   ```typescript
   interface TestStrategy {
     unit: number;    // 비율 (%)
     integration: number;
     e2e: number;
   }
   ```

2. 프론트엔드 테스트 자동화 파이프라인을 구축한다면 어떤 방식으로 설계하시겠습니까?
   ```typescript
   interface TestPipeline {
     static: string[];  // 정적 분석
     unit: string[];   // 단위 테스트
     e2e: string[];    // E2E 테스트
     visual: string[]; // 시각적 테스트
   }
   ```

## 3. 소프트 스킬 질문

### 3.1 기술 리더십
1. 주니어 개발자의 성장을 위해 어떤 방식으로 멘토링을 진행하시나요?
2. 팀 내 기술 부채를 관리하는 본인만의 방식이 있다면 설명해주세요.
3. 새로운 기술 도입을 설득할 때 중요하게 생각하는 포인트는 무엇인가요?

### 3.2 문제 해결
1. 프로젝트 일정이 지연될 때 어떤 방식으로 대응하시나요?
2. 팀원 간 기술적 의견 충돌이 있을 때 어떻게 해결하시나요?
3. 운영 중인 서비스에서 심각한 버그가 발생했을 때의 대응 프로세스를 설명해주세요.

## 4. 기술 트렌드 및 비전

### 4.1 기술 트렌드
1. 현재 가장 주목하고 있는 프론트엔드 기술 트렌드는 무엇인가요?
2. React Server Components에 대한 본인의 견해를 말씀해주세요.
3. Web Assembly의 프론트엔드 활용 전망에 대해 어떻게 생각하시나요?

### 4.2 기술 비전
1. 프론트엔드 개발자로서의 본인의 중장기 기술 학습 계획은 무엇인가요?
2. 이상적인 프론트엔드 개발 문화는 무엇이라고 생각하시나요?
3. 프론트엔드 분야에서 가장 도전적인 과제는 무엇이라고 생각하시나요? 