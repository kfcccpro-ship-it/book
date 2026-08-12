# MG 교재관리 시스템 — PROJECT HANDOFF LATEST

> 이 문서는 새 ChatGPT 채팅이 과거 대화 없이도 현재 작업을 안전하게 이어가기 위한 **고정 진입점**이다.
> 저장소는 공개 저장소이므로 UID, 비밀번호, 토큰, 서비스계정 키 등 민감정보를 이 문서에 기록하지 않는다.

## 1. 새 채팅에서 가장 먼저 할 일

사용자가 **`교재관리 다음 작업 진행`**이라고 입력하면 다음 순서로 진행한다.

1. GitHub 저장소 `kfcccpro-ship-it/book`의 `main` 최신 HEAD를 확인한다.
2. 이 파일 `PROJECT_HANDOFF_LATEST.md`를 읽는다.
3. 작업 브랜치 `firebase-migration`의 최신 HEAD를 확인한다.
4. `firebase-migration/PROJECT_STATUS.md`를 읽는다.
5. `main`과 `firebase-migration`을 compare하여 ahead/behind와 변경 파일을 재확인한다.
6. 문서에 기록된 상태를 그대로 신뢰하지 말고 GitHub 최신 상태와 대조한다.
7. `PROJECT_STATUS.md`의 **FIRST INCOMPLETE STEP**부터 이어간다.

## 2. 저장소와 브랜치 역할

- Repository: `kfcccpro-ship-it/book`
- `main`: 기존 운영 Supabase 앱 기준본. Firebase 전환 검증이 끝날 때까지 앱 코드를 직접 변경하지 않는다.
- `firebase-migration`: Supabase → Firebase 무손실 전환 및 검증 작업 브랜치.
- 현재 개발 중에는 `firebase-migration`을 기준으로 수정·커밋한다.
- Firebase 전환, 쓰기 검증, 회귀검증이 모두 끝나기 전에는 `main`에 병합하지 않는다.

## 3. 절대 우선 원칙

1. **기존 관리 데이터 무손실 유지가 최우선**이다.
2. Supabase 원본은 Firebase 전환 검증 완료 전까지 삭제·비활성화하지 않는다.
3. 데이터베이스 전환과 UI 리디자인을 동시에 하지 않는다.
4. 기존 문서 ID, 과정 ID, 로그 이력은 유지한다.
5. 실제 운영 데이터 쓰기 전에는 제한된 Rules + 격리 테스트 + 재조회 검증을 먼저 한다.
6. 재고/상태 변경과 작업로그는 최종적으로 원자적 처리한다.
7. 운영 `main`은 검증 완료 전까지 보호한다.

## 4. Firebase 기준

- Firebase project ID: `new-book-e6ec7`
- Firebase Hosting 테스트 주소: `https://new-book-e6ec7.web.app`
- Authentication: Anonymous Auth 사용
- Firestore: `(default)`
- 정확한 Rules 상태는 새 채팅 시작 시 사용자/콘솔 상태를 다시 확인한다.

## 5. 데이터 마이그레이션 검증 기준선

Supabase 스냅샷 → Firestore 이관 후 전수 재조회 검증 완료:

| Collection | Source | Firestore | Result |
|---|---:|---:|---|
| courses | 180 | 180 | PASS |
| work_logs | 405 | 405 | PASS |
| sub_books | 6 | 6 | PASS |
| sub_book_logs | 13 | 13 | PASS |
| users | 77 | 77 | PASS |
| **Total** | **681** | **681** | **PASS** |

- Field mismatch: `0`
- 기존 Supabase 원본은 보존 중.
- 마이그레이션 과정에서 기존 데이터의 의미를 임의 보정하지 않는다.

## 6. 새 채팅이 반드시 읽어야 할 다음 파일

작업 브랜치의 다음 파일을 읽는다.

`firebase-migration/PROJECT_STATUS.md`

이 파일에 다음이 들어 있다.

- 현재 브랜치/커밋 상태
- 이미 검증한 항목
- 아직 배포되지 않은 변경
- Firestore Rules 안전 상태
- 원자적 쓰기 진행 범위
- 첫 미완료 작업
- 다음 테스트 절차

## 7. 운영 방식

목표 운영 흐름:

`사용자 요청 → ChatGPT가 GitHub 수정 → commit/push → 검증 → Firebase Hosting 배포 → 사용자 URL 테스트`

가능하면 ZIP 다운로드/업로드 방식은 사용하지 않는다. GitHub 연결이 끊기거나 저장소 쓰기 권한이 없는 경우에만 수동 백업 방식을 비상수단으로 사용한다.

## 8. 새 채팅 호출문

새 채팅에서 사용자는 아래 한 줄만 입력하면 된다.

**`교재관리 다음 작업 진행`**

새 채팅의 Assistant는 추가 설명을 요구하기 전에 GitHub의 위 문서와 작업 브랜치 상태를 먼저 읽고, 확인된 FIRST INCOMPLETE STEP부터 이어간다.
