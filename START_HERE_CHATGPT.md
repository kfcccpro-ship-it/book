# MG 교재 재고관리 — ChatGPT 새 채팅 시작점

> 이 파일은 **새 ChatGPT 채팅에서 프로젝트를 이어가기 위한 영구 진입점**이다.
> 별도 ZIP, 백업파일 업로드, PowerShell 작업을 기본적으로 사용하지 않는다.
> GitHub `main`이 코드와 작업상태의 단일 기준본(Single Source of Truth)이다.

## 새 채팅에서 사용자가 입력할 문구

**`교재관리 다음 작업 진행`**

새 채팅의 Assistant는 사용자에게 과거 내용을 다시 묻기 전에 반드시 다음 순서로 진행한다.

1. GitHub 저장소 `kfcccpro-ship-it/book`의 최신 `main` HEAD 확인
2. 이 파일 `START_HERE_CHATGPT.md` 읽기
3. `PROJECT_STATE.json` 읽기
4. `PROJECT_HANDOFF_LATEST.md` 읽기
5. `simple/index.html`과 `simple/simple-inventory-service.js`의 최신 상태 확인
6. GitHub Pages 배포 상태 확인
7. `PROJECT_STATE.json`의 `next_step`부터 작업 재개

## 저장소 / 운영 주소

- Repository: `kfcccpro-ship-it/book`
- Canonical branch: `main`
- 운영/검증 앱: `https://kfcccpro-ship-it.github.io/book/simple/`
- 배포: GitHub Pages, `main` push 후 자동 반영
- 데이터: Firebase project `new-book-e6ec7`, Firestore `(default)`, Anonymous Auth

## 절대 원칙

- 기존 데이터 무손실이 최우선
- GitHub 최신 `main`을 항상 먼저 읽고 수정
- 일상 작업에서 ZIP 업로드 / PowerShell / Firebase CLI 사용 금지
- 재고 변경과 로그 기록은 가능한 한 Firestore transaction/batch로 함께 처리
- 음수 재고 신규 발생 금지
- 기존 기준선과 다른 값은 자동 보정하지 않고 원인을 먼저 검증
- 테스트는 운영 문서를 직접 선택하지 않고 테스트 전용 문서만 생성·삭제
- 공개 저장소이므로 UID, 비밀번호, 토큰, 서비스계정 JSON 등 비밀정보 커밋 금지

## 현재 제품 철학

모바일에서 설명 없이 사용할 수 있는 단순 교재 재고 앱.

하단 핵심 메뉴:

`홈 / 입고 / 출고 / 재고 / 기록`

재고 색상:

- 50권 미만: 빨강 `부족`
- 50~99권: 보라 `보통`
- 100권 이상: 파랑 `여유`

가장 중요한 숫자는 **현재 잔고**이며, 입고/출고 처리 시 `현재 잔고 → 처리 후 잔고`를 크게 표시한다.

## 담당자

### 주나연
- 입고 주 담당
- 입고
- 정식 출고
- **즉시출고**
- 새 교재/과정 등록
- 표시명 변경
- 운영 종료 숨김/복원

### 교육매니저
- 정식 출고
- 필요 시 입고

모든 작업은 작업자·시간·수량·메모 로그를 남긴다.

## 중요 용어 — 반드시 유지

과거의 `비상출고`, `재고맞춤`, `실물재고 맞춤` UI 개념은 폐기한다.

공식 기능명은 오직:

**`즉시출고`**

의미:
- 주나연이 과정·차수·주차와 무관하게 입고 화면에서 원하는 교재를 즉시 출고
- 수량 입력 → 현재 잔고 확인 → 즉시 차감 → `즉시출고` 로그
- 현재 잔고 초과 불가
- 음수 잔고 신규 발생 불가
- 정식 과정 출고와 로그 유형을 구분

사용자에게 복잡한 재고조정 절차를 노출하지 않는다.

## 검증된 데이터 기준선

Firestore 이관 검증:

- courses: 180
- work_logs: 405
- sub_books: 6
- sub_book_logs: 13
- users: 77
- 총 681 / Field mismatch 0

재고 정합성 전수점검 결과:

- 기존 과정: 180건
- 기존 부교재: 6종
- 이전 앱 vs Simple 주교재 불일치: **0종**
- Simple 음수: **1종** — 동기화 오류가 아니라 이전 기준에도 존재하는 값
- 미완료 상태 출고량 차이: 0종

따라서 **주교재 180건의 기존 계산 기준은 변경하지 않는다.**

기존 부교재 6종은 `sub_books` 독립 실물 품목으로 Simple 입고/재고/기록 화면에 편입했다.

## 주요 파일

- `simple/index.html` — 현재 모바일 운영 UI
- `simple/simple-inventory-service.js` — 원자적 입고/출고/즉시출고 서비스와 보조 UI
- `simple/inventory-audit.html` — 읽기 전용 재고 정합성 상세 감사
- `simple/inventory-audit-summary.html` — 복사용 재고 감사 요약
- `simple/sub-book-workflow-test.html` — 기존 6/13 기준선을 보존하는 부교재 격리 테스트
- `PROJECT_STATE.json` — 기계가 읽기 쉬운 현재 상태 / 다음 작업
- `PROJECT_HANDOFF_LATEST.md` — 장문 인계 기록

## GitHub 인계 운영 규칙

중대한 작업이 끝날 때마다 Assistant는 별도 요청이 없어도 가능한 범위에서:

1. 코드 commit
2. `PROJECT_STATE.json`의 `last_updated`, `current_commit`, `completed`, `next_step` 갱신
3. 필요하면 `PROJECT_HANDOFF_LATEST.md` 갱신
4. GitHub Pages 배포 상태 확인

을 수행한다.

이 규칙 덕분에 새 채팅은 과거 채팅 기록이나 사용자가 보관한 백업파일 없이 GitHub만으로 작업을 이어간다.
