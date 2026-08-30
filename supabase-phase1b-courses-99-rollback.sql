-- ============================================================================
-- Youmi Lens · Phase 1B · Courses
-- FILE 5 of 5 — ROLLBACK
--
-- Run in: Supabase SQL Editor, only if a post-migration assertion failed or the
-- Desktop rollout is being reverted.
--
-- WHAT THIS GUARANTEES
--   Not one lecture, transcript, summary, audio file or course label is lost.
--   That is not a hope — it is structural: the migration and the backfill only
--   ever ADDED a table and two columns, and the backfill only ever wrote to
--   `recordings.course_id`. The legacy `recordings.course` TEXT, which is what
--   every pre-Phase-1B client reads, was never written to at any point. Undoing
--   Phase 1B therefore returns the system to byte-identical prior behaviour.
--
-- ORDER MATTERS
--   The foreign key must go before the column, and the column before the table,
--   or Postgres refuses with a dependency error. The order below is correct.
--
-- IDEMPOTENT
--   Every statement is IF EXISTS guarded.
-- ============================================================================

begin;

-- ── STEP 1 · drop the foreign key ───────────────────────────────────────────
-- WHY            recordings.course_id cannot be dropped while a constraint
--                references public.courses.
-- WHAT CHANGES   Constraint metadata only.
-- EXPECTED       Constraint gone. No row changes.
-- DATA IMPACT    None.
alter table public.recordings
  drop constraint if exists recordings_user_course_fk;

-- ── STEP 2 · drop the recordings index ──────────────────────────────────────
-- WHY            It indexes a column that is about to be removed.
-- EXPECTED       Index gone. No row changes.
-- DATA IMPACT    None.
drop index if exists public.recordings_user_course_idx;

-- ── STEP 3 · drop recordings.course_id ──────────────────────────────────────
-- WHY            Removes the Phase 1B link column.
-- WHAT CHANGES   One column disappears from public.recordings.
-- EXPECTED       Column gone; every other column, including `course`, `title`,
--                `transcript`, `summary_*` and `storage_path`, untouched.
-- DATA IMPACT    Course MEMBERSHIP as expressed by course_id is discarded — but
--                the course NAME survives on every row in `recordings.course`,
--                which is where it lived before Phase 1B and where every
--                existing client still reads it. Re-running 03-backfill.sql
--                after a future re-migration reconstructs the links exactly.
alter table public.recordings
  drop column if exists course_id;

-- ── STEP 4 · recordings.updated_at is deliberately KEPT ─────────────────────
-- WHY NOT DROPPED
--   This column is not a Phase 1B feature. iPad's renameCourse already writes
--   it (lib/store.tsx:862) against a column that did not exist, so that call
--   has been failing with 42703 in production. Adding it fixed a pre-existing
--   bug. Dropping it on rollback would re-break iPad for no benefit, and the
--   column is inert for every other client.
--
--   If it must go anyway, uncomment — but fix iPad first:
-- alter table public.recordings drop column if exists updated_at;

-- ── STEP 5 · drop the courses table ─────────────────────────────────────────
-- WHY            Removes the Phase 1B entity. Its indexes and RLS policies are
--                dropped automatically with it.
-- WHAT CHANGES   public.courses and its rows disappear.
-- EXPECTED       Table gone.
-- DATA IMPACT    The only information unique to these rows is icon/tint/accent
--                and the soft-delete state. Course NAMES are not lost — they
--                are still on every recording. Re-running 01-migration.sql then
--                03-backfill.sql regenerates identical courses with identical
--                presets, because the preset assignment is deterministic from
--                (first lecture timestamp, normalized name).
drop table if exists public.courses cascade;

commit;

-- ============================================================================
-- POST-ROLLBACK VERIFICATION — run these three and confirm before standing down
-- ============================================================================

-- R1 · recordings row count must equal the pre-migration number (194 at design
--      time). Any difference means data was lost and this rollback is NOT the
--      end of the incident.
select count(*) as total_recordings from public.recordings;

-- R2 · the legacy course label must still be present on every row.
select case when count(*) = 0 then 'PASS' else 'FAIL' end as verdict,
       count(*) as rows_missing_course_label
from public.recordings
where course is null or btrim(course) = '';

-- R3 · Phase 1B objects must all be gone.
select
  (select count(*) from information_schema.tables
    where table_schema='public' and table_name='courses')            as courses_table,
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='recordings'
      and column_name='course_id')                                   as course_id_column,
  (select count(*) from pg_constraint
    where conname='recordings_user_course_fk')                       as fk_constraint;
-- PASS: all three are 0.
