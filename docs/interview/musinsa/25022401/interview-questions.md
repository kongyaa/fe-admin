# 시니어 프론트엔드 개발자 역량 평가 면접 질문 리스트

## 1. 프로젝트 경험 기반 질문

### 1.1 디자인 시스템 고도화 및 리팩토링
1. 디자인 시스템 컴포넌트로의 전환 과정에서 가장 큰 도전 과제는 무엇이었나요?
   ```typescript
   interface DesignSystemComponent<P> {
     name: string;
     props: P;
     variants: Record<string, unknown>;
     documentation: string;
   }
   ```
   - 꼬리질문: 레거시 컴포넌트 마이그레이션 전략은 어떻게 수립하셨나요?
   - 꼬리질문: 컴포넌트 문서화는 어떤 방식으로 진행하셨나요?

2. 디자인 시스템 도입으로 인한 구체적인 개선 효과는 무엇이었나요?
   - 꼬리질문: 개발 생산성 측면에서의 변화는?
   - 꼬리질문: 유지보수성 측면에서의 개선점은?

### 1.2 BFF(Backend for Frontend) 서버 개발
1. BFF 도입을 결정하게 된 구체적인 배경과 아키텍처 설계 과정을 설명해주세요.
   ```typescript
   interface BFFConfig {
     endpoints: string[];
     caching: {
       strategy: 'memory' | 'redis';
       ttl: number;
     };
     aggregation: {
       enabled: boolean;
       batchSize: number;
     };
   }
   ```
   - 꼬리질문: CDN 리소스 aggregation 전략은 어떻게 설계하셨나요?
   - 꼬리질문: 성능 개선 효과는 어떻게 측정하셨나요?

2. BFF 서버의 장애 대응 전략은 어떻게 수립하셨나요?
   - 꼬리질문: 캐싱 전략은 어떻게 구성하셨나요?
   - 꼬리질문: 백엔드 API 장애 시 대응 방안은?

### 1.3 결제 시스템 연동
1. 여러 결제 시스템(토스, Stripe) 연동 시 공통 인터페이스 설계는 어떻게 하셨나요?
   ```typescript
   interface PaymentProvider {
     initialize(): Promise<void>;
     processPayment(order: Order): Promise<PaymentResult>;
     handleCallback(data: unknown): Promise<void>;
     validatePayment(paymentId: string): Promise<boolean>;
   }
   ```
   - 꼬리질문: 결제 실패 시나리오는 어떻게 처리하셨나요?
   - 꼬리질문: 결제 프로세스 모니터링은 어떻게 구현하셨나요?

2. 인앱결제 연동 시 플랫폼별 차이점은 어떻게 처리하셨나요?
   - 꼬리질문: 가격 차등 적용 로직은 어떻게 구현하셨나요?
   - 꼬리질문: 결제 검증 프로세스는 어떻게 구현하셨나요?

## 2. 기술 심화 질문

### 2.1 성능 최적화
1. BFF 도입으로 인한 구체적인 성능 개선 수치와 측정 방법을 설명해주세요.
   ```typescript
   interface PerformanceMetrics {
     pageLoadTime: number;
     apiLatency: number;
     resourceLoadTime: number;
     ttfb: number;
     fcp: number;
   }
   ```

2. 라이브 스트리밍 서비스에서의 성능 최적화 전략은 무엇이었나요?
   - 꼬리질문: 실시간 채팅의 성능 이슈는 어떻게 해결하셨나요?
   - 꼬리질문: 네트워크 상태에 따른 대응 전략은?

### 2.2 아키텍처 설계
1. 디자인 시스템 설계 시 고려한 확장성 포인트는 무엇이었나요?
   ```typescript
   interface ThemeConfig {
     colors: Record<string, string>;
     spacing: Record<string, number>;
     breakpoints: Record<string, number>;
     typography: Record<string, unknown>;
   }
   ```

2. 사내 좌석 예약 툴 개발 시 데이터 모델링은 어떻게 하셨나요?
   - 꼬리질문: 동시성 이슈는 어떻게 해결하셨나요?
   - 꼬리질문: 예약 규칙 엔진은 어떻게 설계하셨나요?

### 2.3 테스트 전략
1. 결제 시스템 테스트는 어떻게 구성하셨나요?
   ```typescript
   interface PaymentTestCase {
     scenario: string;
     input: PaymentInput;
     expectedOutput: PaymentResult;
     mockResponses: Record<string, unknown>;
   }
   ```

2. E2E 테스트 자동화 전략은 어떻게 수립하셨나요?
   - 꼬리질문: CI/CD 파이프라인에서의 테스트 전략은?
   - 꼬리질문: 테스트 데이터 관리는 어떻게 하셨나요?

## 3. 기술 리더십

### 3.1 프로젝트 관리
1. 짧은 개발 기간 내 결제 시스템 연동을 성공적으로 완료한 프로젝트 관리 방법은?
   - 꼬리질문: 리스크 관리는 어떻게 하셨나요?
   - 꼬리질문: 팀 내 기술적 의사결정 프로세스는?

2. 디자인 시스템 도입 시 팀 내 합의를 이끌어낸 방법은?
   - 꼬리질문: 레거시 코드 마이그레이션 계획은 어떻게 수립하셨나요?
   - 꼬리질문: 팀원들의 학습 곡선은 어떻게 관리하셨나요?

### 3.2 기술 전략
1. BFF 도입을 결정하게 된 의사결정 과정과 설득 방법은?
   - 꼬리질문: 대안은 어떤 것들을 검토하셨나요?
   - 꼬리질문: ROI는 어떻게 측정하셨나요?

2. 향후 프론트엔드 아키텍처 발전 방향에 대한 의견은?
   - 꼬리질문: 마이크로 프론트엔드 도입에 대한 견해는?
   - 꼬리질문: 서버 컴포넌트에 대한 의견은?

## 4. 문제 해결 능력

### 4.1 장애 대응
1. 라이브 스트리밍 서비스에서 크리티컬 장애가 0건이었던 비결은?
   ```typescript
   interface IncidentPreventionStrategy {
     monitoring: string[];
     fallback: string[];
     recovery: string[];
   }
   ```

2. 결제 시스템 장애 대응 프로세스는 어떻게 구성하셨나요?
   - 꼬리질문: 장애 탐지 방법은?
   - 꼬리질문: 복구 프로세스는?

### 4.2 성능 개선
1. BFF 도입으로 페이지 로드 속도를 획기적으로 개선한 방법은?
   - 꼬리질문: 병목 지점은 어떻게 파악하셨나요?
   - 꼬리질문: 개선 효과는 어떻게 측정하셨나요?

2. 사내 좌석 예약 툴에서 예약 시간을 크게 단축한 방법은?
   - 꼬리질문: UI/UX 개선 포인트는?
   - 꼬리질문: 프로세스 자동화 방안은? 