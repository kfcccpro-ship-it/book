# MG 교재관리 시스템 — PROJECT HANDOFF LATEST

> 이 문서는 새 ChatGPT 채팅이 과거 대화 없이도 현재 작업을 안전하게 이어가기 위한 **고정 진입점**이다.
> 저장소는 공개 저장소이므로 UID, 비밀번호, 토큰, 서비스계정 키 등 민감정보를 기록하지 않는다.

## 1. 새 채팅에서 가장 먼저 할 일

사용자가 **`교재관리 다음 작업 진행`**이라고 입력하면 다음 순서로 진행한다.

1. GitHub 저장소 `kfcccpro-ship-it/book`의 `main` 최신 HEAD를 확인한다.
2. 이 파일 `PROJECT_HANDOFF_LATEST.md`를 읽는다.
3. 작업 브랜치 `firebase-migration`의 최신 HEAD를 확인한다.
4. `firebase-migration/PROJECT_STATUS.md`를 읽는다.
5. `main`과 `firebase-migration`을 compare하여 최신 변경을 재확인한다.
6. GitHub Pages 배포 상태를 확인한다.
7. 확인된 FIRST INCOMPLETE STEP부터 이어간다.

## 2. 저장소와 배포 역할

- Repository: `kfcccpro-ship-it/book`
- `main`: GitHub Pages 운영/검증 배포 기준 브랜치.
- GitHub Pages: `https://kfcccpro-ship-it.github.io/book/`
- `firebase-migration`: Supabase → Firebase 무손실 전환 및 검증 개발 브랜치.
- Firebase 검증용 파일은 `main/migration/` 하위에 선택적으로 게시하여 GitHub Pages에서 테스트한다.
- 기존 운영 루트 `index.html`은 Firebase 전환 검증 완료 전까지 임의 교체하지 않는다.

## 3. 배포 원칙 — PowerShell/CLI 사용 중단

이 프로젝트에서는 일상적인 수정·배포에 PowerShell, Firebase CLI, ZIP 업로드를 사용하지 않는다.

기본 흐름:

`사용자 요청 → ChatGPT가 GitHub 최신 상태 확인 → 코드 수정 → GitHub commit/push → GitHub Pages 자동배포 → 사용자 URL 확인`

- GitHub Pages는 현재 `main` 브랜치 루트에서 자동 배포된다.
- Firebase Hosting은 더 이상 기본 배포 경로로 사용하지 않는다.
- Firebase는 주로 Authentication + Firestore 데이터 저장소로 사용한다.
- GitHub 연결이 끊긴 경우에만 수동 방식은 비상수단으로 고려한다.

## 4. 절대 우선 원칙

1. **기존 관리 데이터 무손실 유지가 최우선**이다.
2. Supabase 원본은 Firebase 전환 검증 완료 전까지 삭제·비활성화하지 않는다.
3. 기존 문서 ID, 과정 ID, 로그 이력은 유지한다.
4. 재고/상태 변경과 작업로그는 원자적으로 처리한다.
5. DB 전환 안정화 전에는 대규모 UI 리디자인을 동시에 진행하지 않는다.
6. 기존 운영 루트 앱을 한 번에 Firebase 앱으로 교체하지 않고 별도 `migration/` 경로에서 먼저 검증한다.

## 5. Firebase 기준

- Firebase project ID: `new-book-e6ec7`
- Authentication: Anonymous Auth 사용
- Firestore: `(default)`
- 소수 사용자(약 4명) 내부 재고관리 앱이므로 권한 구조는 가능한 단순하게 유지하되, 공개 웹에서 무제한 익명 쓰기는 허용하지 않는다.
- 최종 운영 Rules는 복잡한 역할 체계보다 `인증 사용자 + 필요한 컬렉션` 중심의 단순 구조를 목표로 한다.

## 6. 데이터 마이그레이션 검증 기준선

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
- 기존 Supabase 원본은 보존 중이다.

## 7. 현재 GitHub Pages 테스트 경로

Firebase 마이그레이션 검증 파일을 `main/migration/`에 게시한다.

주요 경로:

- `/book/migration/access.html`
- `/book/migration/`
- `/book/migration/atomic-course-test.html`

`atomic-course-test.html`은 운영 기록을 선택하지 않고 UID 전용 테스트 문서만 생성하여 실제 원자적 과정+로그 쓰기 서비스를 검증하도록 설계되어 있다.

## 8. 새 채팅이 반드시 읽어야 할 다음 파일

`firebase-migration/PROJECT_STATUS.md`

다만 과거 문서에 Firebase Hosting CLI 배포 지시가 남아 있으면 이 문서의 최신 원칙을 우선한다. 즉 **GitHub Pages 자동배포를 기본값**으로 사용한다.

## 9. 다음 큰 단계

1. GitHub Pages의 Firebase 테스트 앱 읽기 경로 검증
2. 격리 원자적 과정+로그 쓰기 검증
3. 핵심 쓰기 경로를 원자적 서비스로 전환
4. Firebase 기반 앱 전체 회귀검증
5. Firestore Rules를 소수 사용자용 단순 운영 규칙으로 정리
6. 기존 루트 앱을 Firebase 기준본으로 전환
7. Supabase 런타임 의존성 제거

## 10. 새 채팅 호출문

새 채팅에서 사용자는 아래 한 줄만 입력하면 된다.

**`교재관리 다음 작업 진행`**

Assistant는 추가 설명을 요구하기 전에 GitHub 최신 상태와 이 문서를 먼저 읽고 작업을 이어간다.
