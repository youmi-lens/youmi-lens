-- ============================================================================
-- Youmi Lens · Phase 1B · Courses as a first-class cloud entity
-- FILE 1 of 5 — MIGRATION
--
-- Run in: Supabase SQL Editor (production project lbwsrnjbiayepshrdult).
-- Run AFTER: supabase-phase1b-courses-02-verification.sql has been run once and
--            its output reviewed. Do not run this file blind.
-- Run BEFORE: 03-backfill.sql
--
-- WHY THIS EXISTS
--   A Course is currently not an entity anywhere. Desktop keeps folders in
--   localStorage (lost on reinstall, never synced); iPad keeps courses in
--   AsyncStorage and rebuilds them on every hydrate by grouping recordings on
--   the free-text `recordings.course` column; the database has neither a
--   courses table nor a course_id. That makes "One account, every device"
--   impossible for courses, and makes a course's colour and icon device-local.
--   This migration makes Course a real, per-user, synced row.
--
-- SAFETY CONTRACT — every statement below is ADDITIVE
--   · no column is dropped
--   · no column is renamed
--   · no column changes type
--   · no table is dropped
--   · no row is updated or deleted (backfill is a separate, later file)
--   · `recordings.course` TEXT is untouched and REMAINS AUTHORITATIVE for every
--     client that predates course_id (today: iPad, older Desktop, the server)
--   · transcript / summary / audio / storage_path columns are not referenced
--
-- IDEMPOTENT
--   Every statement is `if not exists` guarded. Re-running is a no-op.
--
-- EXPECTED RUNTIME
--   < 1 second. `recordings` held 194 rows at design time; ALTER TABLE ADD
--   COLUMN with a non-volatile default does not rewrite the table in PG 11+.
--
-- ROLLBACK
--   99-rollback.sql reverses everything here. Because nothing is destructive,
--   rollback cannot lose a lecture, a transcript, or a course label.
-- ============================================================================

begin;

-- ── STEP 1 · courses ────────────────────────────────────────────────────────
--
-- WHAT IT CHANGES  Creates public.courses. Nothing existing is touched.
-- EXPECTED RESULT  Table exists, 0 rows.
-- ROLLBACK IMPACT  Dropping it is safe as long as it is dropped BEFORE the
--                  recordings.course_id column (the FK depends on it). The
--                  rollback file does this in the right order.
--
-- COLUMN NOTES
--   icon/tint/accent  The course's visual identity, stored ON the course. This
--                     is the whole point of the round: identity is data, not a
--                     value re-derived per page from a hash, an array index or
--                     a name. Values come from the six-preset registry that is
--                     copied verbatim from iPad lib/models.ts:306-313.
--   deleted_at        Soft delete. Required for a SYNCED entity: with a hard
--                     delete, device A deletes a course while device B still
--                     holds it locally, and B's next push resurrects it. A
--                     tombstone makes delete idempotent across devices. It also
--                     matches iPad's own Course type, which already carries
--                     deletedAt/deletedReason (lib/models.ts:90-93).
--   unique(user_id,id) Not decorative — the composite foreign key in STEP 3
--                     requires a unique constraint on exactly these two
--                     columns to reference.
create table if not exists public.courses (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  name        text        not null check (btrim(name) <> ''),
  icon        text        not null,
  tint        text        not null,
  accent      text        not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz null,
  constraint courses_user_id_id_key unique (user_id, id)
);

comment on table public.courses is
  'A course is a long-lived container owned by exactly one user. A lecture belongs to at most one course. Soft-deleted rows keep deleted_at set.';
comment on column public.courses.name is
  'Display name, original casing preserved. Grouping and uniqueness use lower(btrim(name)).';
comment on column public.courses.icon is
  'Ionicons outline glyph name from the six-preset registry, e.g. create-outline.';
comment on column public.courses.tint is
  'Soft tile background hex from the same preset, e.g. #E7F2EA.';
comment on column public.courses.accent is
  'Medium accent hex used for the glyph and the identity stripe, e.g. #3F8C68.';
comment on column public.courses.deleted_at is
  'Soft delete. NULL = active. Only an EMPTY course may be deleted; deleting a course never deletes its lectures.';

-- ── STEP 2 · courses indexes ────────────────────────────────────────────────
--
-- WHAT IT CHANGES  Two indexes on the new table only.
-- EXPECTED RESULT  Both indexes exist.
-- ROLLBACK IMPACT  Dropped with the table.
--
-- The unique index is PARTIAL (`where deleted_at is null`) so that a name freed
-- by a soft delete can be reused, while two ACTIVE courses can never share a
-- normalized name. The normalization (lower + btrim) is deliberately identical
-- to how every existing client already groups recordings by course name
-- (iPad lib/store.tsx:354-359), so the constraint cannot reject data that
-- today's clients consider distinct.
create unique index if not exists courses_user_active_name_key
  on public.courses (user_id, lower(btrim(name)))
  where deleted_at is null;

-- Serves the hot path: "list this user's active courses".
create index if not exists courses_user_active_idx
  on public.courses (user_id)
  where deleted_at is null;

-- ── STEP 3 · recordings: two additive columns ───────────────────────────────
--
-- WHAT IT CHANGES  Adds two nullable/defaulted columns to public.recordings.
--                  No existing column is read, written, renamed or dropped.
-- EXPECTED RESULT  Both columns exist; every existing row has course_id = NULL
--                  and updated_at = now(). No row's course/title/transcript/
--                  summary/audio changes.
-- ROLLBACK IMPACT  course_id can be dropped freely — it is additive and the
--                  legacy `course` TEXT still carries the course label for
--                  every row. updated_at is intentionally NOT dropped on
--                  rollback; see the note in 99-rollback.sql.
--
-- WHY updated_at
--   It is not cosmetic. iPad's renameCourse already writes it
--   (lib/store.tsx:862 → .update({ course, updated_at })) and the column does
--   not exist, so that statement fails with 42703 and iPad's cloud course
--   rename is silently broken in production today. Adding the column fixes an
--   existing bug as a side effect of an additive change.
alter table public.recordings
  add column if not exists course_id  uuid        null,
  add column if not exists updated_at timestamptz not null default now();

comment on column public.recordings.course_id is
  'Owning course. NULL = Unfiled. recordings.course TEXT is retained and stays authoritative for clients that predate this column.';
comment on column public.recordings.updated_at is
  'Last metadata write. Clients (including iPad renameCourse) already send this; the column was missing until Phase 1B.';

-- ── STEP 4 · composite foreign key ──────────────────────────────────────────
--
-- WHAT IT CHANGES  Adds one FK constraint to public.recordings.
-- EXPECTED RESULT  Constraint recordings_user_course_fk exists. It validates
--                  immediately against existing rows, all of which have
--                  course_id IS NULL and therefore trivially satisfy it.
-- ROLLBACK IMPACT  Dropping the constraint changes no data.
--
-- WHY COMPOSITE, NOT `references courses(id)`
--   A single-column FK would allow user A's recording to point at user B's
--   course. RLS governs which rows a user can SEE; it does not govern
--   referential integrity. Referencing (user_id, course_id) against
--   courses(user_id, id) makes "a recording may only belong to a course owned
--   by the same user" a hard database guarantee that survives any future
--   policy mistake.
--
-- WHY ON DELETE SET NULL, NEVER CASCADE
--   Deleting a course must never delete a lecture. Because the product rule is
--   "only an empty course may be deleted", this should never actually fire —
--   it is a safety net, not a code path.
--
-- The DO block exists because ADD CONSTRAINT has no IF NOT EXISTS form.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'recordings_user_course_fk'
  ) then
    alter table public.recordings
      add constraint recordings_user_course_fk
      foreign key (user_id, course_id)
      references public.courses (user_id, id)
      on delete set null;
  end if;
end $$;

-- ── STEP 5 · recordings index ───────────────────────────────────────────────
--
-- WHAT IT CHANGES  One index on public.recordings.
-- EXPECTED RESULT  Index exists. Serves "list the lectures in this course" and
--                  "count the lectures in this course" (the emptiness check
--                  that gates course deletion).
-- ROLLBACK IMPACT  Dropping it changes no data.
create index if not exists recordings_user_course_idx
  on public.recordings (user_id, course_id);

-- ── STEP 6 · RLS on courses ─────────────────────────────────────────────────
--
-- WHAT IT CHANGES  Enables RLS on the NEW table and adds four policies. No
--                  existing policy on any existing table is read or modified.
-- EXPECTED RESULT  relrowsecurity = true for public.courses; four policies
--                  present; an anonymous SELECT returns zero rows.
-- ROLLBACK IMPACT  Dropped with the table.
--
-- Each policy is row-level (auth.uid() = user_id) with no column list, so
-- adding a column to courses later never requires touching these policies.
alter table public.courses enable row level security;

do $$
begin
  if not exists (select 1 from pg_policy
                 where polrelid='public.courses'::regclass and polname='courses_select_own') then
    create policy courses_select_own on public.courses
      for select using (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policy
                 where polrelid='public.courses'::regclass and polname='courses_insert_own') then
    create policy courses_insert_own on public.courses
      for insert with check (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policy
                 where polrelid='public.courses'::regclass and polname='courses_update_own') then
    create policy courses_update_own on public.courses
      for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policy
                 where polrelid='public.courses'::regclass and polname='courses_delete_own') then
    create policy courses_delete_own on public.courses
      for delete using (auth.uid() = user_id);
  end if;
end $$;

commit;

-- ============================================================================
-- NEXT STEP
--   Run supabase-phase1b-courses-04-post-validation.sql and confirm every
--   assertion passes BEFORE running 03-backfill.sql.
-- ============================================================================
