# MG 교재관리 시스템 — PROJECT STATUS

> 작업 브랜치 `firebase-migration`의 **실시간 인계 문서**.
> 새 채팅에서는 반드시 GitHub 최신 HEAD와 compare 결과를 다시 확인한 뒤 이 문서를 사용한다.

## CURRENT BRANCH

- Repository: `kfcccpro-ship-it/book`
- Branch: `firebase-migration`
- Expected HEAD at handoff creation: `656cf4cf66bdd663e8f9d66a06a5c2c447ca3119`
- `main` base at handoff creation: `386aa14113ae5773d75e7f428932e57abbbeb8b4` or newer documentation-only commit
- Important: HEAD hashes are checkpoints, not assumptions. Re-fetch current refs in every new chat.

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
- Hosting test URL: `https://new-book-e6ec7.web.app`
- Firestore database: `(default)`
- Auth: Anonymous Authentication enabled
- Public repo: NEVER commit UID allowlists, passwords, tokens, service-account JSON, or secrets.

## SECURITY / RULES STATE

At the last confirmed user step, Firestore Rules were restored from test-write mode to **read-only for the current test UID and write=false for operational data**.

Do not assume this is still true in a new chat. Ask the user for a screenshot or have them verify Rules immediately before any real write test.

Never enable unrestricted writes.

## VERIFIED FIREBASE FUNCTIONALITY

### Read path

Firebase test app successfully opened and displayed operational data using migrated Firestore data.

Observed working UI included:

- operator selection
- dashboard
- stock-in tab
- course inventory rows
- current stock/release counts

### Isolated atomic write sandbox

`migration/write-test.html` tested only:

- `migration_tests/{uid}`
- `migration_test_logs/{uid}`

Result:

- Auth PASS
- two-document transaction PASS
- immediate read-back PASS
- cleanup delete PASS
- operational 681 records unchanged

## MIGRATION FILES

Key migration files currently in branch:

- `FIREBASE_MIGRATION_BASELINE.md`
- `.firebaserc`
- `firebase.json`
- `migration/access.html`
- `migration/index.html`
- `migration/firebase-compat.js`
- `migration/firebase-test.html`
- `migration/write-test.html`
- `migration/firebase-write-service.js`
- `migration/firebase-atomic-patch.js`

## LEGACY WRITE RISK DISCOVERED

The legacy app frequently performs writes in this pattern:

`courses update → createLog(work_logs insert)`

This can leave inventory/status updated without a matching audit log if the second write fails.

Examples found include:

- group stock-in
- stock-out
- stock-out confirmation
- stock quantity edit
- release reset
- setup start/completion/final confirmation
- course edits and status transitions

Target Firebase design:

`course mutation + work_log creation` in a single Firestore transaction/batch.

## ATOMIC WRITE IMPLEMENTATION STATUS

### Completed in code

`migration/firebase-write-service.js` provides atomic operations for:

- updateCourseWithLog
- deleteCourseWithLog
- insertCourseWithLog
- logOnly

It also supports expected-status conflict checking for update/delete paths.

`migration/firebase-atomic-patch.js` was added to begin routing the highest-risk operational functions through the atomic service.

### Current intended first conversion scope

First priority:

1. group stock-in
2. stock-out

Then extend to:

3. stock-out confirmation
4. stock quantity edits
5. stock-in approval
6. setup start
7. setup completion
8. final setup confirmation
9. release reset
10. rollback/status correction
11. course create/edit/delete

## IMPORTANT DEPLOYMENT STATE

At handoff creation, the atomic write service and patch code were committed to GitHub, but **the user had not yet confirmed a Firebase Hosting deployment of the newest atomic-write patch nor a real operational write test**.

Therefore do NOT assume the deployed `new-book-e6ec7.web.app` contains the latest atomic patch.

## FIRST INCOMPLETE STEP

1. Re-fetch `firebase-migration` HEAD.
2. Compare `main...firebase-migration`.
3. Inspect `migration/firebase-atomic-patch.js`, `migration/firebase-write-service.js`, and `migration/index.html` to confirm current integration.
4. If latest files are not deployed, instruct user to run:

```bash
cd ~/book
git pull origin firebase-migration
firebase deploy --only hosting
```

5. Confirm the Firebase test page loads the atomic patch indicator.
6. **Do not permit operational writes yet.**
7. Select or create a deliberately isolated test course/document strategy so the next real transaction test cannot alter production historical records.
8. Temporarily allow writes only to the exact test document(s) and matching work-log path, then perform one reversible stock-in or stock-out transaction.
9. Read back course and work_log and verify both values.
10. Restore Rules to read-only immediately.

## TESTING PRINCIPLE FOR NEXT STEP

Avoid testing a real historical course if possible.

Preferred sequence:

- create a dedicated Firebase-only test course/document with an obvious ID such as `migration_tx_test_*`
- keep it outside normal production filtering if practical
- atomically mutate that test course + create matching work_log
- verify both
- delete test artifacts atomically or by controlled cleanup
- confirm original collection counts/business records remain unchanged

If the compatibility layer or UI cannot isolate such a test course safely, build a dedicated transaction test page instead of using operational buttons.

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
