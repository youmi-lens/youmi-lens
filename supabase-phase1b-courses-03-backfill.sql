-- ============================================================================
-- Youmi Lens · Phase 1B · Courses
-- FILE 3 of 5 — BACKFILL
--
-- Run in: Supabase SQL Editor.
-- Run AFTER: 01-migration.sql, and after 04-post-validation.sql reports every
--            structural assertion as PASS.
-- Run BEFORE: re-running 04-post-validation.sql (it also validates the data).
--
-- WHY THIS EXISTS
--   The migration creates an empty courses table. Every existing lecture still
--   carries only the legacy free-text `recordings.course`. This file turns
--   those strings into real course rows and links each lecture to one, so that
--   existing users open Courses V2 and see their real library rather than an
--   empty state.
--
-- WHAT IT TOUCHES
--   INSERT into public.courses.
--   UPDATE public.recordings SET course_id — one column, and only where it is
--   currently NULL.
--
-- WHAT IT NEVER TOUCHES
--   audio, storage_path, transcript, transcript_zh, live_transcript,
--   summary_en, summary_zh, source_summary, translated_summary, title,
--   duration_sec, ai_* — none of these appear anywhere in this file, and
--   `recordings.course` itself is READ ONLY here. No lecture content can be
--   altered by running this.
--
-- IDEMPOTENT
--   The INSERT uses ON CONFLICT DO NOTHING against the partial unique index on
--   (user_id, lower(btrim(name))). The UPDATE only touches rows where
--   course_id IS NULL. Running this file twice produces no additional rows and
--   no additional writes.
--
-- ROLLBACK
--   99-rollback.sql drops course_id and the courses table, which removes every
--   effect of this file. `recordings.course` is unchanged throughout, so a
--   rollback returns the system to exactly its pre-Phase-1B behaviour.
-- ============================================================================

begin;

-- ── STEP 1 · create one course per (user, normalized name) ──────────────────
--
-- WHAT IT CHANGES  Inserts rows into public.courses only.
-- EXPECTED RESULT  One row per distinct (user_id, lower(btrim(course))).
--                  At design time: 36 rows across 17 users.
-- ROLLBACK IMPACT  Rows disappear with the table.
--
-- GROUPING KEY
--   lower(btrim(course)) — identical to how iPad already groups recordings into
--   courses (lib/store.tsx:354-359). Using the same key guarantees the backfill
--   cannot split or merge anything differently from what users already see.
--   CHECK 8 in 02-verification.sql proves this merges nothing: at design time
--   29 distinct raw names normalized to 29 distinct names, zero collisions.
--
-- DISPLAY NAME
--   The casing the user typed on the EARLIEST lecture in the group. Taken with
--   array_agg(... order by created_at, id))[1] rather than min(btrim(course)):
--   min() resolves 'CS 250' vs 'cs 250' according to the database collation,
--   which differs between C and en_US, so the client could not reproduce it.
--   The client's derivedCoursesRepository applies exactly this rule.
--
-- PRESET ASSIGNMENT — read this before changing it
--   The preset is chosen by the course's ordinal WITHIN ITS OWN USER, ordered
--   by (first lecture timestamp, normalized name). Both are stable facts in the
--   database, so the result is:
--     · identical on every device (unlike iPad's choosePreset(courses.size),
--       which depends on client hydration order and is why one course can be
--       teal on one device and slate on another),
--     · identical on every re-run,
--     · distinct within a user until they exceed six courses.
--   A hash of (user_id || name) was measured against real data first and
--   produced 11 within-user collisions — one user would have had 6 of 10
--   courses render identically. The ordinal approach reduced that to 5, which
--   is the floor (two users hold 7 and 10 courses against a 6-preset registry).
--
--   The six presets are copied verbatim from iPad lib/models.ts:306-313 and
--   MUST stay byte-identical to src/lib/courses/coursePresets.ts on the client.
with grouped as (
  select
    user_id,
    lower(btrim(course)) as name_key,
    (array_agg(btrim(course) order by created_at, id))[1] as display_name,
    min(created_at)      as first_lecture_at
  from public.recordings
  where course is not null
    and btrim(course) <> ''
  group by user_id, lower(btrim(course))
),
ranked as (
  select
    g.*,
    (row_number() over (
       partition by g.user_id
       order by g.first_lecture_at, g.name_key
     ) - 1) % 6 as preset_index
  from grouped g
),
presets (preset_index, icon, tint, accent) as (
  values
    (0, 'people-outline',      '#E8F1FB', '#3F73B0'),
    (1, 'create-outline',      '#E7F2EA', '#3F8C68'),
    (2, 'trending-up-outline', '#F3ECDB', '#A9802F'),
    (3, 'git-network-outline', '#ECECF3', '#6C6E8E'),
    (4, 'flask-outline',       '#E3F1F0', '#3C8A86'),
    (5, 'book-outline',        '#F4EAEA', '#A8696A')
)
insert into public.courses (user_id, name, icon, tint, accent, created_at, updated_at)
select r.user_id, r.display_name, p.icon, p.tint, p.accent, r.first_lecture_at, now()
from ranked r
join presets p on p.preset_index = r.preset_index
on conflict do nothing;

-- ── STEP 2 · link every lecture to its course ───────────────────────────────
--
-- WHAT IT CHANGES  public.recordings.course_id, and nothing else. The SET list
--                  contains exactly one column.
-- EXPECTED RESULT  Every recording with a non-blank course gets a course_id.
--                  At design time: 194 of 194 rows linked, 0 left Unfiled.
-- ROLLBACK IMPACT  The column is dropped entirely on rollback.
--
-- The join is scoped by user_id as well as name, so a course name shared by two
-- different users can never cross-link. `where r.course_id is null` makes the
-- statement re-runnable and prevents it from ever overwriting a link that a
-- client has already set.
--
-- updated_at is deliberately NOT bumped here: this is a system backfill, not a
-- user edit, and iPad uses updated_at for conflict resolution. Touching it
-- would make every lecture look freshly edited to every client.
update public.recordings r
set course_id = c.id
from public.courses c
where r.course_id is null
  and c.user_id = r.user_id
  and c.deleted_at is null
  and lower(btrim(c.name)) = lower(btrim(r.course));

commit;

-- ============================================================================
-- NEXT STEP
--   Re-run supabase-phase1b-courses-04-post-validation.sql. Every assertion,
--   structural AND data, must report PASS before Desktop is pointed at the
--   production repository.
-- ============================================================================
