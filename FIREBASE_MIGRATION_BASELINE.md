# Firebase Migration Baseline

## Scope

This branch is the isolated migration workspace for moving the MG textbook inventory app from Supabase to Firebase without changing the production `main` branch until validation is complete.

## Protected production baseline

- Production branch: `main`
- Migration branch: `firebase-migration`
- Existing Supabase app remains operational during migration.
- Supabase is not to be deleted or disabled during this phase.

## Firebase target

- Project ID: `new-book-e6ec7`
- Firestore database: `(default)`
- Authentication: Anonymous enabled
- Current Firestore client rules after migration test: deny all (`allow read, write: if false;`)

## Verified source-to-Firestore migration baseline

The Supabase snapshot was exported and migrated to Firestore, then read back and compared field-by-field.

| Collection | Source | Firestore | Result |
|---|---:|---:|---|
| courses | 180 | 180 | PASS |
| work_logs | 405 | 405 | PASS |
| sub_books | 6 | 6 | PASS |
| sub_book_logs | 13 | 13 | PASS |
| users | 77 | 77 | PASS |
| **Total** | **681** | **681** | **PASS** |

Field mismatch count at migration verification: `0`.

## Known source-data conditions to preserve before cleanup

These are source facts to preserve during migration, not items to auto-correct during the database switch:

- `users` contains 77 rows although the practical operator set is 7 people; duplicates must remain until a later cleanup phase.
- Some historical `work_logs` reference course IDs no longer present in `courses`; these audit records must remain.
- At least one calculated course-group inventory state was negative in the source snapshot; it must not be silently corrected during migration.

## Migration rules

1. Do not redesign data while changing databases.
2. Preserve existing document IDs and historical logs.
3. Do not commit exported CSV snapshots, migration tokens, or service-account keys to this public repository.
4. Validate Firebase app behavior against the existing Supabase app before merging to `main`.
5. Only after functional parity is confirmed should legacy-code cleanup, UI redesign, or data normalization begin.
