# Phase 1B · Courses — Production Migration Execution Record

An auditable record of one production schema change. This project has no
migration-tracking table and its `.sql` files are not a reliable record of what
has actually been applied (see the Notes), so this document is the record.

Contains aggregate counts and schema facts only — no secrets, no emails, no user
IDs, no course or lecture names, no transcripts, no storage paths.

---

## Execution

| | |
|---|---|
| Project ref | `lbwsrnjbiayepshrdult` |
| Project | Ayden- lecture's Project · branch `main` · badge **PRODUCTION** |
| Executed | 2026-08-05, 14:40 CST (UTC+08:00) |
| Method | Supabase Dashboard → SQL Editor (official UI, logged-in session) |
| Operator | Ayden Zhang |
| Migration file | `supabase-phase1b-courses-01-migration.sql` |
| Backfill file | `supabase-phase1b-courses-03-backfill.sql` |
| Verification file | `supabase-phase1b-courses-02-verification.sql` |
| Validation file | `supabase-phase1b-courses-04-post-validation.sql` |
| Rollback file | `supabase-phase1b-courses-99-rollback.sql` |
| **Rollback required** | **No** |

No CLI, `psql`, database password, personal access token, custom RPC,
service-role workaround or browser-console injection was used at any point.

---

## Pre-migration snapshot

Taken immediately before the migration, in the same session.

| Metric | Value |
|---|---|
| recordings | **196** |
| distinct users | 17 |
| distinct normalized course groups | 29 |
| courses to create | 36 |
| recordings that would link | 196 |
| recordings that would remain Unfiled | 0 |
| **normalization collisions** | **0** |
| `public.courses` | absent |
| `recordings.course_id` | absent |
| `recordings.updated_at` | absent |
| recordings indexes | 2 — `recordings_pkey`, `recordings_user_created` |
| recordings foreign keys | 1 — `recordings_user_id_fkey` → `auth.users(id)` ON DELETE CASCADE |
| recordings RLS policies | 4 — select/insert/update/delete, all owner-scoped |
| recordings RLS enabled | true |

The design-time audit had recorded 194 recordings. Two further legitimate
recordings arrived between the audit and execution. Continuation was permitted
under the pre-agreed rule because collisions stayed at 0, `linked + unfiled =
total` held exactly (196 + 0 = 196), and no schema drift appeared. 196 is the
execution baseline used for every subsequent assertion.

---

## Migration result

`Success. No rows returned.` — one transaction, committed.

Applied:

1. `public.courses` created — 9 columns, including `deleted_at` for soft delete
2. `recordings.course_id uuid null` added
3. `recordings.updated_at timestamptz not null default now()` added
4. `courses_user_active_name_key` — partial unique index on `(user_id, lower(btrim(name))) where deleted_at is null`
5. `courses_user_active_idx` — partial index on `(user_id) where deleted_at is null`
6. `recordings_user_course_idx` — index on `(user_id, course_id)`
7. `recordings_user_course_fk` — composite FK `(user_id, course_id) → courses(user_id, id) ON DELETE SET NULL`
8. RLS enabled on `public.courses`
9. Four owner-only policies: `courses_select_own`, `courses_insert_own`, `courses_update_own`, `courses_delete_own`

Nothing was dropped, renamed or retyped. `recordings.course` was not written to.
No recording content, transcript, summary, audio path or billing/auth table was
touched.

---

## Structural validation (before backfill)

| Assertion | Result |
|---|---|
| courses table shape (9 columns) | PASS |
| `course_id` present and NULLABLE, `updated_at` present | PASS |
| legacy `recordings.course` still `text NOT NULL` | PASS |
| composite FK with `(user_id, course_id)` + `ON DELETE SET NULL` | PASS |
| all three new indexes present | PASS |
| RLS enabled on courses | PASS |
| course policy count | 4 |
| recordings total | 196 — unchanged |
| courses rows | 0 — correct before backfill |
| eligible-but-unlinked recordings | 196 — correct before backfill |

---

## Backfill result

`Success. No rows returned.` — one transaction, committed.

| Metric | Value |
|---|---|
| Course rows created | **36** |
| Recordings linked | **196 / 196** |
| Recordings left Unfiled | 0 |
| Orphan course references | 0 |
| Normalization collisions | 0 |

Supabase's SQL Editor raised a "creates a table without enabling RLS" advisory
against the `insert into public.courses`. It is a false positive from a static
heuristic — the statement creates no table, and RLS on `public.courses` had
already been verified enabled with four policies. "Run without RLS" was chosen
because it executes the audited SQL unchanged; "Run and enable RLS" would have
appended an unapproved statement. RLS was re-verified as enabled afterwards.

---

## Final data validation (after backfill)

| # | Property | Result |
|---|---|---|
| 1 | recordings total unchanged from baseline | **196** ✓ |
| 2 | every existing recording preserved | ✓ |
| 3 | all eligible recordings carry a valid `course_id` | PASS |
| 4 | no cross-user course reference | PASS |
| 5 | no orphan `course_id` | PASS |
| 6 | normalization collisions | 0 |
| 7 | no duplicate active course name per user | PASS |
| 8 | linked + unfiled = total (196 + 0) | ✓ |
| 9 | `recordings.course` still populated on every row | PASS |
| 10 | every icon/tint/accent from the six-preset registry | PASS |
| 11 | RLS enabled on both `courses` and `recordings` | PASS |
| 12 | four owner-only course policies present | PASS |
| 13 | `recordings.updated_at` exists | PASS |
| 14 | recordings indexes intact — `recordings_pkey`, `recordings_user_created`, `recordings_user_course_idx` | PASS |
| 15 | `recordings_user_id_fkey` still present alongside `recordings_user_course_fk` | PASS |

Additional: soft-deleted courses holding lectures — 0; legacy label matches the
course row on every linked recording — PASS.

---

## Notes for the next operator

**The `.sql` files in this repository are not a record of production state.**
`supabase-migration-transcript-canonical.sql` declares two columns; only one of
them (`live_transcript_raw`) exists in production, so that file was applied
partially. There is no migration-tracking table. Always re-run
`supabase-phase1b-courses-02-verification.sql` and read its output before
applying anything.

**CHECK 7b was repaired before this execution.** Its first revision joined
`information_schema.referential_constraints` and returned zero rows while
`recordings_user_id_fkey` demonstrably existed — those views only expose a
referential constraint when the referenced key is visible to the current role,
and `auth.users`' primary key is owned by `supabase_auth_admin`. It now reads
`pg_constraint` / `pg_attribute`, which has no such visibility filter.

**`recordings.updated_at` fixed a pre-existing bug as a side effect.** iPad's
`renameCourse` (`lib/store.tsx:862`) writes `{ course, updated_at }` to
`public.recordings`; the column did not exist, so that statement failed with
`42703` and cloud course renames from iPad were silently not persisting. Adding
the column makes those writes succeed. iPad itself was not modified.
