# MG 교재관리 시스템 — PROJECT STATUS

> 작업 브랜치 `firebase-migration`의 **실시간 인계 문서**.
> 새 채팅에서는 반드시 GitHub 최신 HEAD와 compare 결과를 다시 확인한 뒤 이 문서를 사용한다.

## CURRENT BRANCH

- Repository: `kfcccpro-ship-it/book`
- Branch: `firebase-migration`
- Latest verified work: isolated operational atomic transaction harness added
- `main` remains protected until Firebase write parity and regression verification complete.

## PROJECT PURPOSE

기존 Supabase 기반 MG 인재개발원 교재관리 웹앱을 Firebase 기반으로 전환하고, 현재까지 관리된 데이터를 손실 없이 유지하면서 향후 기능 수정·보완·업데이트를 GitHub 중심으로 단순화한다.

최우선 조건:

1. 기존 데이터 손실 0
2. Supabase 원본 유지
3. Firebase 기능 동등성 검증 후 운영 전환
4. 재고 변경과 로그 기록의 원자성 보장
5. UI/기능 리디자인은 DB 전환 안정화 후 진행

## VERIFIED DATA MIGRATION BASELINE

Supabase snapshot → Firestore migration and read-back verification completed.

| Collection | Source | Firestore | Result |
|---|---:|---:|---|
| courses | 180 | 180 | PASS |
| work_logs | 405 | 405 | PASS |
| sub_books | 6 | 6 | PASS |
| sub_book_logs | 13 | 13 | PASS |
| users | 77 | 77 | PASS |
| TOTAL | 681 | 681 | PASS |

- Field mismatch: 0
- Existing source anomalies are preserved, not auto-corrected.
- Supabase remains available as source/rollback reference.

## FIREBASE CONFIGURATION

- Firebase project: `new-book-e6ec7`
- Firebase Hosting test URL: `https://new-book-e6ec7.web.app`
- Firestore database: `(default)`
- Auth: Anonymous Authentication enabled
- Public repo: NEVER commit UID allowlists, passwords, tokens, service-account JSON, or secrets.

## SECURITY / RULES STATE

The last confirmed safe state was read-only for operational data. Do not assume current console Rules without re-checking immediately before a real write test.

Never enable unrestricted writes.

## VERIFIED FIREBASE FUNCTIONALITY

### Read path

Firebase test app previously opened and displayed migrated operational data successfully.

### Generic isolated transaction sandbox

`migration/write-test.html` has already verified a transaction using only:

- `migration_tests/{uid}`
- `migration_test_logs/{uid}`

Result previously confirmed:

- Auth PASS
- two-document transaction PASS
- immediate read-back PASS
- cleanup delete PASS
- operational 681 records unchanged

## LEGACY WRITE RISK

The legacy app frequently performs writes in this pattern:

`courses update → createLog(work_logs insert)`

This can leave inventory/status updated without a matching audit log if the second write fails.

Target Firebase design:

`course mutation + work_log creation` in a single Firestore transaction/batch.

## ATOMIC WRITE IMPLEMENTATION STATUS

### Completed in code

`migration/firebase-write-service.js` provides:

- updateCourseWithLog
- deleteCourseWithLog
- insertCourseWithLog
- logOnly

It supports expected-status conflict checking for update/delete paths.

`migration/firebase-atomic-patch.js` currently overrides the first two high-risk flows:

1. group stock-in
2. stock-out

`migration/index.html` injects the Firebase compatibility adapter, atomic write service, and atomic patch in that order and displays the atomic patch state in the migration banner.

### Newly added isolated operational harness

`migration/atomic-course-test.html` was added to test the real `courses` + `work_logs` transaction path without selecting or altering a historical business course.

Safety design:

- fixed test course ID: `migration_tx_test_<current anonymous UID>`
- creates only that dedicated course document
- calls the real `firebase-write-service.js` `updateCourseWithLog()` path
- writes one matching `work_logs` document whose `course_id` is the fixed test ID
- immediately reads course + log back and validates status/quantity/log values
- deletes the test course and all logs tied to that fixed test ID
- compares `courses` and `work_logs` counts before and after and requires exact restoration
- provides a cleanup-only button for interrupted tests
- dynamically displays a temporary Firestore Rules block limited to the current UID and fixed test course ID

The harness is committed on `firebase-migration`, but Firebase Hosting deployment and real execution are NOT yet confirmed.

## BRANCH RELATIONSHIP AT LAST CHECK

At the last check before the new harness commit:

- `main...firebase-migration`: diverged
- migration branch ahead by 13 commits and behind by 1 documentation-side commit

Re-check this on every new chat because the values can change.

## FIRST INCOMPLETE STEP

1. Confirm current `firebase-migration` HEAD and compare with `main` again.
2. Deploy the current `firebase-migration/migration` directory to Firebase Hosting if the new harness is not yet deployed.
3. Open `https://new-book-e6ec7.web.app/atomic-course-test.html`.
4. Confirm the page shows:
   - Anonymous Auth UID
   - `PASS · Firebase Auth + 실제 원자적 쓰기 서비스 준비`
   - fixed test ID `migration_tx_test_<UID>`
5. Before pressing the transaction button, inspect current Firestore Rules in Firebase Console.
6. Add only the page-generated temporary Rules blocks inside the existing `/databases/{database}/documents` scope. Do not broadly enable `courses` or `work_logs` writes.
7. Run the isolated transaction once.
8. Require all seven checks on the page to PASS, especially final count restoration.
9. Immediately remove the temporary Rules blocks and return operational data to read-only.
10. Re-open the normal migration app and confirm read functions remain normal.

## AFTER THE ISOLATED TEST PASSES

Only after the operational collection transaction harness passes should conversion continue to the next write paths:

3. stock-out confirmation
4. stock quantity edits
5. stock-in approval
6. setup start
7. setup completion
8. final setup confirmation
9. release reset
10. rollback/status correction
11. course create/edit/delete

Each converted path must use atomic course mutation + work log creation where both are logically one action.

## DO NOT DO YET

- Do not merge `firebase-migration` into `main`.
- Do not disable/delete Supabase.
- Do not globally enable Firestore write.
- Do not redesign the whole UI yet.
- Do not normalize duplicate users or historical anomalies yet.
- Do not change existing IDs or log history.

## LATER PHASES AFTER WRITE PARITY

After all core write paths pass:

1. remove Supabase runtime dependency
2. make Firebase version self-contained
3. regression-test all operational flows
4. add GitHub Actions validation
5. automate GitHub → Firebase Hosting deployment
6. only then consider UI hierarchy/redesign and code modularization
7. merge to `main` after explicit final verification

## NEW CHAT START PHRASE

User will say:

**`교재관리 다음 작업 진행`**

The Assistant should read:

1. `main/PROJECT_HANDOFF_LATEST.md`
2. this `firebase-migration/PROJECT_STATUS.md`
3. current GitHub refs/compare

Then continue from **FIRST INCOMPLETE STEP** without asking the user to re-explain the project.
