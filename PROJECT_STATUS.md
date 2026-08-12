# MG 교재관리 시스템 — PROJECT STATUS

## CURRENT ARCHITECTURE

- Repository: `kfcccpro-ship-it/book`
- Production/deployment branch: `main`
- Migration development branch: `firebase-migration`
- Web deployment: GitHub Pages (`main` root)
- GitHub Pages URL: `https://kfcccpro-ship-it.github.io/book/`
- Firebase project: `new-book-e6ec7`
- Firebase role: Anonymous Authentication + Firestore data store
- PowerShell/Firebase CLI deployment is no longer the normal workflow.

Normal workflow:

`user request -> ChatGPT edits GitHub -> commit/push -> GitHub Pages automatic deployment -> browser verification`

## DATA BASELINE

Supabase snapshot -> Firestore read-back verification already completed:

| Collection | Count |
|---|---:|
| courses | 180 |
| work_logs | 405 |
| sub_books | 6 |
| sub_book_logs | 13 |
| users | 77 |
| TOTAL | 681 |

- Field mismatch: 0
- Supabase source remains preserved as rollback/reference.

## CURRENT SAFETY MODEL

The project is intentionally being simplified for a very small internal user group, but data integrity remains the priority.

### 1. Startup legacy writes disabled

`migration/index.html` removes the legacy startup block that previously attempted to:

- rename/add users
- seed INITIAL_COURSES when courses appeared empty

The Firebase preview now uses the already migrated Firestore data only.

### 2. Unconverted legacy writes blocked in the app

`migration/firebase-write-service.js` installs a compatibility guard that blocks legacy:

- `sb.from(...).insert(...)`
- `sb.from(...).update(...)`
- `sb.from(...).delete(...)`

unless `window.MG_FIREBASE_ALLOW_LEGACY_WRITES === true` is explicitly set.

This means read paths and realtime subscriptions can continue while old non-atomic write flows remain disabled.

Converted Firestore atomic services write directly and are not blocked.

### 3. Atomic write service

Available operations:

- `updateCourseWithLog`
- `deleteCourseWithLog`
- `insertCourseWithLog`
- `logOnly`

Current first-wave operational patch:

1. group stock-in
2. stock-out

Both use one Firestore transaction for course mutation + work log creation.

## SIMPLE FIRESTORE RULES CANDIDATE

File: `FIRESTORE_RULES_SIMPLE.rules`

Target design for the small internal team:

- authenticated anonymous users can read/write `courses`
- authenticated anonymous users can read/write `work_logs`
- authenticated anonymous users can read/write `sub_books`
- authenticated anonymous users can read/write `sub_book_logs`
- authenticated users can read `users`, but normal app operation cannot write `users`
- all other collections closed
- migration sandbox remains UID-isolated

This is intentionally a low-complexity model. It is not strong identity security; the application is treated as a small internal inventory tool. App-side write guards and atomic transactions provide the primary protection against accidental data corruption.

## GITHUB PAGES MIGRATION PREVIEW

Published under `main/migration/` without replacing the existing root production `index.html`.

Important files:

- `migration/index.html`
- `migration/firebase-compat.js`
- `migration/firebase-write-service.js`
- `migration/firebase-atomic-patch.js`
- `migration/atomic-course-test.html`
- `migration/write-test.html`

GitHub Pages builds have been confirmed working after adding `.nojekyll`.

## ISOLATED ATOMIC TEST HARNESS

`migration/atomic-course-test.html`:

- uses test course ID `migration_tx_test_<anonymous UID>`
- creates only that test course
- calls the real `updateCourseWithLog()` service
- validates course + work_log read-back
- deletes all test artifacts
- requires course/work_log counts to return to their baseline

No historical course should be used for this test.

## FIRST INCOMPLETE STEP

1. Confirm the latest GitHub Pages build for the new safety-guard commits is `built`.
2. Apply the contents of `FIRESTORE_RULES_SIMPLE.rules` once in Firebase Console -> Firestore Database -> Rules -> Publish.
3. Open the GitHub Pages Firebase preview and verify existing Firestore data loads normally.
4. Open `/book/migration/atomic-course-test.html` and run one isolated test.
5. Require all seven checks to PASS, including final count restoration.
6. After the isolated test passes, continue converting the remaining legacy write flows to the atomic service.

## NEXT WRITE FLOWS TO CONVERT

After the isolated test passes:

3. stock-out confirmation
4. stock quantity edits
5. stock-in approval
6. setup start
7. setup completion
8. final setup confirmation
9. release reset
10. rollback/status correction
11. course create/edit/delete
12. sub-book write flows

## DO NOT DO YET

- Do not delete/disable Supabase yet.
- Do not replace the root production app with the Firebase preview yet.
- Do not change existing document IDs or historical logs.
- Do not enable legacy writes globally.
- Do not perform a major UI redesign until Firebase write parity is complete.

## NEW CHAT START PHRASE

When the user says:

**`교재관리 다음 작업 진행`**

read the latest GitHub state and continue from FIRST INCOMPLETE STEP without asking the user to restate the project.
