# FE Admin 프로젝트 문서

이 문서는 FE Admin 프로젝트의 구조와 개발 규칙을 설명합니다.

## 목차

### 프로젝트 기본 구성
- [프로젝트 구조](./project/structure.md)
- [개발 환경 설정](./project/setup.md)
- [패키지 관리](./project/package-management.md)

### 개발 가이드
- [코딩 스타일](./guides/coding-style.md)
- [Git 작업 규칙](./guides/git-convention.md)
- [Git 계정 설정](./guides/git-account-setup.md)
- [테스트 가이드](./guides/testing.md)
- [배포 프로세스](./guides/deployment.md)

### 구현 과정
- [초기 환경 구성](./implementation/01-initial-setup.md)
- [기본 패키지 구성](./implementation/02-package-setup.md)
- [어드민 앱 구현](./implementation/03-admin-app.md)

### 스터디 기록
- [프론트엔드 스터디](./study/frontend/README.md)
  - [React & Next.js](./study/frontend/react/README.md)
  - [TypeScript](./study/frontend/typescript/README.md)
  - [상태 관리](./study/frontend/state-management/README.md)
  - [성능 최적화](./study/frontend/performance/README.md)
  - [테스트](./study/frontend/testing/README.md)

### 투자 포트폴리오
- [투자 전략](./investment/strategy/README.md)
  - [포트폴리오 구성](./investment/strategy/portfolio-structure.md)
  - [리스크 관리](./investment/strategy/risk-management.md)
  - [자산 배분](./investment/strategy/asset-allocation.md)
- [투자 일지](./investment/journal/README.md)
  - [월간 리뷰](./investment/journal/monthly/README.md)
  - [분기별 성과](./investment/journal/quarterly/README.md)
  - [연간 성과](./investment/journal/yearly/README.md)
- [투자 분석](./investment/analysis/README.md)
  - [시장 분석](./investment/analysis/market/README.md)
  - [종목 분석](./investment/analysis/stocks/README.md)
  - [섹터 분석](./investment/analysis/sectors/README.md)

## 프로젝트 개요

이 프로젝트는 Turborepo와 pnpm을 사용한 모노레포 구조로 구성되어 있으며, Next.js와 Ant Design을 기반으로 하는 관리자 시스템을 포함하고 있습니다. 또한 프론트엔드 개발 스터디와 투자 포트폴리오 관리를 위한 문서화 시스템을 통합하여 제공합니다.

### 문서화 원칙
1. 모든 문서는 마크다운(.md) 형식으로 작성
2. 날짜별로 추적 가능한 형태로 기록
3. 문서 간의 상호 참조를 통한 연결성 유지
4. 정기적인 회고와 업데이트 진행
5. 코드와 문서의 동기화 유지 