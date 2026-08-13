# MG 교재 재고관리 — PROJECT HANDOFF LATEST

> 최신 시작점은 `START_HERE_CHATGPT.md`이다.
> 이 문서는 현재 제품/데이터/검증 상태를 보충하는 장문 인계 문서다.

## 새 채팅 재개 방법

사용자가 새 채팅에서 아래 한 줄만 입력한다.

**`교재관리 다음 작업 진행`**

Assistant는 과거 대화를 요구하지 않고 GitHub `kfcccpro-ship-it/book`의 최신 `main`을 확인한 뒤:

1. `START_HERE_CHATGPT.md`
2. `PROJECT_STATE.json`
3. 이 문서
4. `simple/index.html`
5. `simple/simple-inventory-service.js`

순서로 읽고 `PROJECT_STATE.json.next_step`부터 이어간다.

## 단일 기준본

- Repository: `kfcccpro-ship-it/book`
- Canonical: `main`
- 운영/검증 URL: `https://kfcccpro-ship-it.github.io/book/simple/`
- Routine deploy: GitHub Pages 자동배포
- Routine workflow: 사용자 요청 → ChatGPT GitHub 확인/수정/commit → Pages 자동배포
- ZIP 업로드, PowerShell, Firebase CLI는 일상 작업에 사용하지 않는다.

## 현재 앱 목표

소수 담당자가 스마트폰으로 설명 없이 사용할 수 있는 단순 교재 재고관리.

핵심 메뉴:

`홈 / 입고 / 출고 / 재고 / 기록`

핵심 원칙:

- 현재 잔고가 가장 중요한 숫자
- 입고/출고 시 `현재 잔고 → 처리 후 잔고`를 크게 표시
- 잔고보다 많은 출고 차단
- 신규 음수 재고 금지
- 모든 변경은 담당자/시간/수량/메모 로그 보존

재고 시인성:

- < 50: 부족 / 빨강
- 50~99: 보통 / 보라
- >= 100: 여유 / 파랑

## 담당자

### 주나연 — 입고 주 담당 / 전체 권한

- 입고
- 정식 출고
- **즉시출고**
- 새 교재/과정 등록
- 표시명 변경
- 운영 종료 숨김/복원

### 교육매니저

- 정식 출고
- 필요 시 입고

## 즉시출고 — 최신 확정 개념

과거에 논의·구현했던 `비상출고`, `재고맞춤`, `실물재고 맞춤`이라는 사용자 노출 개념은 폐기한다.

앞으로 사용자에게 보이는 단일 개념은 **즉시출고**다.

- 주나연 전용
- 과정/차수/주차 선택 불필요
- 입고 화면에서 해당 교재의 `⇧ 즉시출고` 선택
- 현재 잔고를 크게 표시
- 1/2/5권 빠른 선택 가능
- 처리 후 잔고 즉시 미리보기
- 현재 잔고 초과 불가
- `즉시출고` 로그 별도 기록
- 정식 과정 출고 실적과 구분

큰 틀은 **“입고 담당자가 필요할 때 재량으로 바로 출고할 수 있다”**뿐이다. 복잡한 재고조정 워크플로를 사용자에게 노출하지 않는다.

## 데이터 / Firebase

- Firebase project: `new-book-e6ec7`
- Firestore `(default)`
- Anonymous Auth

이관 검증 기준선:

| 컬렉션 | 건수 |
|---|---:|
| courses | 180 |
| work_logs | 405 |
| sub_books | 6 |
| sub_book_logs | 13 |
| users | 77 |
| 합계 | 681 |

Field mismatch: 0

## 과거 재고 정합성 전수점검 — 완료

동일 Firebase 데이터를 이전 앱 계산식과 Simple 계산식으로 비교한 결과:

- 기존 과정 180건
- 기존 부교재 6종
- 주교재 불일치 **0종**
- Simple 음수 **1종**
- 미완료 상태 released_quantity 차이 **0종**

따라서 주교재 180건의 기존 재고 계산 기준은 맞으며 임의 변경하지 않는다.

음수 1종은 마이그레이션 계산 오류가 아니라 이전 기준에도 존재하던 값이다. 자동 보정하지 않는다.

## 기존 부교재 6종

기존 `sub_books`는 독립 실물 교재로 유지하며 Simple 입고/재고/기록 화면에 통합했다.

검증 당시 기준:

- (경력)신입직원 전산 / [경력] 신입직원 1, / 82-80 = 2
- (경력)신입직원 전산 / [경력] 신입직원 3, / 32-0 = 32
- 여신기본 실습(스프링) / 여신기본(집체) / 60-50 = 10
- (무경력)신입직원 전산실습2 / (무)신입직원 1,2, / 66-66 = 0
- 수신기본 실습(스프링) / 수신기본(집체) / 44-38 = 6
- (무경력)신입직원 전산실습 1 / (무)신입직원 1,2, / 80-70 = 10

이 값들은 과거 기준선이며 자동 변경하지 않는다.

## 현재 핵심 파일

- `START_HERE_CHATGPT.md` — 새 채팅 영구 진입점
- `PROJECT_STATE.json` — 최신 상태/다음 작업 기계판독 파일
- `simple/index.html` — 모바일 운영 UI
- `simple/simple-inventory-service.js` — 원자적 입고/출고/즉시출고 서비스
- `simple/inventory-audit.html` — 상세 읽기전용 재고 감사
- `simple/inventory-audit-summary.html` — 감사 결과 복사 도구
- `simple/sub-book-workflow-test.html` — 부교재 격리 테스트

## 이미 검증된 주요 흐름

- Firebase Auth / 읽기
- 운영 `courses + work_logs` 원자적 격리 쓰기
- 전체 상태 흐름 / 로그 / 정리 / 기준선 복원
- 유지보수 생성·수정·삭제·로그 원자성
- 부교재 기존 기준선 6/13 보존
- 주교재 재고 과거 앱 vs Simple 0 mismatch

## 다음 작업

항상 `PROJECT_STATE.json.next_step`을 최신 기준으로 삼는다.

현재 우선순위는:

1. 모바일에서 단일 `즉시출고` UI가 주나연에게만 명확히 보이는지 확인
2. 기존 복합 용어(`비상출고`, `재고맞춤`)가 운영 UI에 남아 있지 않은지 확인
3. 부교재 격리 테스트가 아직 실행되지 않았다면 6/13 기준선 복원 PASS 확인
4. 검증 후 감사/테스트 페이지를 유지할지 archive할지 결정
5. 실제 사용자 피드백 기반 모바일 UI 미세조정

## GitHub 상태 인계 규칙

중대한 단계 완료 시 Assistant는 GitHub의:

- `PROJECT_STATE.json`
- 필요 시 `PROJECT_HANDOFF_LATEST.md`

를 최신화한다.

따라서 사용자는 더 이상 별도의 백업 MD/ZIP을 다운로드하고 새 채팅에 업로드할 필요가 없다.
