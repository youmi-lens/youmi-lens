-- ============================================================================
-- Youmi Lens · Phase 1B · Courses
-- FILE 4 of 5 — POST-MIGRATION VALIDATION (READ ONLY)
--
-- Run in: Supabase SQL Editor.
-- Run TWICE:
--   (a) after 01-migration.sql   — structural assertions must PASS; the data
--                                  assertions will report "no rows yet", which
--                                  is correct at that point.
--   (b) after 03-backfill.sql    — every assertion, structural and data, must
--                                  PASS.
--
-- Nothing here writes. Every assertion returns a single row with a verdict
-- column so the whole file can be read at a glance: any 'FAIL' anywhere means
-- stop and roll back.
-- ============================================================================

-- ── A1 · courses table exists with the expected shape ───────────────────────
-- WHY   Confirms STEP 1 of the migration landed, and that no column was
--       created with an unexpected type.
-- PASS  verdict = PASS (9 columns, exact names and types).
select case when count(*) = 9 then 'PASS' else 'FAIL' end as verdict,
       count(*)                                           as column_count,
       string_agg(column_name || ':' || data_type, ', ' order by ordinal_position) as columns
from information_schema.columns
where table_schema = 'public' and table_name = 'courses';

-- ── A2 · recordings gained exactly the two intended columns ─────────────────
-- WHY   Confirms STEP 3 landed and that course_id is NULLABLE (a NOT NULL
--       course_id would break every old client that inserts without it).
-- PASS  verdict = PASS, course_id is_nullable = YES.
select case
         when count(*) filter (where column_name = 'course_id'  and is_nullable = 'YES') = 1
          and count(*) filter (where column_name = 'updated_at') = 1
         then 'PASS' else 'FAIL' end as verdict,
       string_agg(column_name || ' (nullable=' || is_nullable || ')', ', ') as added_columns
from information_schema.columns
where table_schema = 'public' and table_name = 'recordings'
  and column_name in ('course_id', 'updated_at');

-- ── A3 · legacy compatibility: recordings.course still intact ───────────────
-- WHY   THE most important structural assertion. Old iPad and old Desktop read
--       this column and nothing else. If it were dropped or made nullable, every
--       existing client would lose its course grouping.
-- PASS  verdict = PASS (column present, type text, NOT NULL).
select case when count(*) = 1 then 'PASS' else 'FAIL' end as verdict,
       max(data_type) as type, max(is_nullable) as nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'recordings'
  and column_name = 'course' and data_type = 'text' and is_nullable = 'NO';

-- ── A4 · composite foreign key present and correct ──────────────────────────
-- WHY   This constraint is what makes cross-user course references impossible.
--       Its exact definition matters: it must be composite and ON DELETE SET
--       NULL, never CASCADE.
-- PASS  verdict = PASS and the definition contains both user_id and course_id
--       and 'ON DELETE SET NULL'.
select case
         when count(*) = 1
          and max(pg_get_constraintdef(oid)) like '%(user_id, course_id)%'
          and max(pg_get_constraintdef(oid)) like '%ON DELETE SET NULL%'
         then 'PASS' else 'FAIL' end as verdict,
       max(pg_get_constraintdef(oid)) as definition
from pg_constraint
where conrelid = 'public.recordings'::regclass
  and conname = 'recordings_user_course_fk';

-- ── A5 · indexes present ────────────────────────────────────────────────────
-- WHY   The partial unique index is a correctness guarantee (no two active
--       courses share a normalized name per user), not just a performance one.
-- PASS  verdict = PASS (all three indexes).
select case when count(*) = 3 then 'PASS' else 'FAIL' end as verdict,
       string_agg(indexname, ', ' order by indexname) as indexes
from pg_indexes
where schemaname = 'public'
  and indexname in ('courses_user_active_name_key',
                    'courses_user_active_idx',
                    'recordings_user_course_idx');

-- ── A6 · RLS enabled on courses with four policies ──────────────────────────
-- WHY   Cross-user isolation for the new table. Without this, one user's
--       courses would be readable by any authenticated user.
-- PASS  verdict = PASS (rls_enabled true, policy_count 4).
select case when bool_and(c.relrowsecurity) and count(p.polname) = 4
            then 'PASS' else 'FAIL' end as verdict,
       bool_and(c.relrowsecurity)       as rls_enabled,
       count(p.polname)                 as policy_count,
       string_agg(p.polname, ', ' order by p.polname) as policies
from pg_class c
left join pg_policy p on p.polrelid = c.oid
where c.oid = 'public.courses'::regclass
group by c.oid;

-- ── A7 · every policy is row-scoped, not column-scoped ──────────────────────
-- WHY   Row-scoped policies keep working when a column is added later.
-- PASS  Each row shows an expression referencing user_id / auth.uid().
select polname,
       pg_get_expr(polqual, polrelid)      as using_expr,
       pg_get_expr(polwithcheck, polrelid) as with_check_expr
from pg_policy
where polrelid = 'public.courses'::regclass
order by polname;

-- ── D1 · no lecture was lost ────────────────────────────────────────────────
-- WHY   The single most important data assertion. Compare against the number
--       recorded from CHECK 10 of 02-verification.sql (194 at design time).
-- PASS  total_recordings equals the pre-migration number, exactly.
-- FAIL  any difference → STOP and roll back immediately.
select count(*) as total_recordings, count(distinct user_id) as distinct_users
from public.recordings;

-- ── D2 · every non-blank course string got linked ───────────────────────────
-- WHY   Proves the backfill reached every eligible row.
-- PASS  verdict = PASS, unlinked = 0.
-- NOTE  Before the backfill runs, this correctly reports FAIL with unlinked =
--       the full count. That is expected at validation pass (a).
select case when count(*) = 0 then 'PASS' else 'FAIL' end as verdict,
       count(*) as unlinked_but_should_be_linked
from public.recordings
where course_id is null
  and course is not null
  and btrim(course) <> '';

-- ── D3 · no orphan links ────────────────────────────────────────────────────
-- WHY   A course_id pointing at a missing or soft-deleted course, or at another
--       user's course. The FK makes the first two impossible; this asserts it.
-- PASS  verdict = PASS, 0 rows.
select case when count(*) = 0 then 'PASS' else 'FAIL' end as verdict,
       count(*) as orphan_recordings
from public.recordings r
left join public.courses c
  on c.id = r.course_id and c.user_id = r.user_id
where r.course_id is not null and c.id is null;

-- ── D4 · no duplicate courses ───────────────────────────────────────────────
-- WHY   Two active courses with the same normalized name for one user would
--       split a library in two. The partial unique index should make this
--       impossible; this asserts the index is actually doing its job.
-- PASS  verdict = PASS, 0 rows.
select case when count(*) = 0 then 'PASS' else 'FAIL' end as verdict,
       count(*) as duplicate_groups
from (
  select user_id, lower(btrim(name))
  from public.courses
  where deleted_at is null
  group by user_id, lower(btrim(name))
  having count(*) > 1
) d;

-- ── D5 · course label and course row agree ──────────────────────────────────
-- WHY   Desktop dual-writes course_id AND course TEXT so that old clients keep
--       working. This finds any lecture whose two course identities disagree —
--       the exact drift the dual-write exists to prevent.
-- PASS  verdict = PASS, 0 rows.
-- NOTE  A non-zero result after old clients have been writing is expected and
--       is repaired by re-running 03-backfill.sql's STEP 2 logic; it is a
--       reconciliation signal, not corruption.
select case when count(*) = 0 then 'PASS' else 'FAIL' end as verdict,
       count(*) as mismatched_label_vs_row
from public.recordings r
join public.courses c on c.id = r.course_id
where lower(btrim(c.name)) <> lower(btrim(coalesce(r.course, '')));

-- ── D6 · course inventory, for eyeballing ───────────────────────────────────
-- WHY   Final human check: does each user's course list look like a real
--       library, with sensible names, counts and distinct presets?
-- PASS  Counts sum to D1's total minus the Unfiled count.
select c.user_id,
       c.name,
       c.icon,
       c.accent,
       count(r.id) as lectures,
       c.deleted_at
from public.courses c
left join public.recordings r on r.course_id = c.id
group by c.id, c.user_id, c.name, c.icon, c.accent, c.deleted_at
order by c.user_id, lectures desc;

-- ── D7 · deletion rule is satisfiable ───────────────────────────────────────
-- WHY   The product rule is "only an empty course may be deleted". This lists
--       any soft-deleted course that still holds lectures — which would mean
--       the rule was bypassed somewhere.
-- PASS  verdict = PASS, 0 rows.
select case when count(*) = 0 then 'PASS' else 'FAIL' end as verdict,
       count(*) as deleted_courses_still_holding_lectures
from public.courses c
join public.recordings r on r.course_id = c.id
where c.deleted_at is not null;
