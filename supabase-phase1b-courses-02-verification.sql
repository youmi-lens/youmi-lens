-- ============================================================================
-- Youmi Lens · Phase 1B · Courses
-- FILE 2 of 5 — PRE-MIGRATION VERIFICATION (READ ONLY)
--
-- Run in: Supabase SQL Editor.
-- Run BEFORE anything else. Nothing here writes; every statement is a SELECT.
--
-- ── CATALOG COMPATIBILITY ───────────────────────────────────────────────────
-- An earlier revision of this file's policy query selected `cmd, permissive,
-- roles` FROM `pg_policy`. Those column names belong to the pg_policies VIEW,
-- not to the pg_policy CATALOG TABLE, whose columns are prefixed (`polcmd`,
-- `polpermissive`, `polroles`). The result was:
--
--     ERROR: 42703  column "cmd" does not exist
--
-- This revision therefore reads from DOCUMENTED VIEWS wherever one exists:
--
--   pg_policies   schemaname, tablename, policyname, permissive, roles,
--                 cmd, qual, with_check                    (PostgreSQL 9.5+)
--   pg_tables     schemaname, tablename, tableowner, tablespace, hasindexes,
--                 hasrules, hastriggers, rowsecurity
--   pg_indexes    schemaname, tablename, indexname, tablespace, indexdef
--   information_schema.columns / .tables / .table_constraints   (SQL standard)
--
-- Only ONE query below reaches into a catalog table: CHECK 7 uses
-- pg_constraint to render a human-readable constraint definition, because no
-- view exposes pg_get_constraintdef(). It uses only `oid`, `conrelid`,
-- `conname` and `contype`, which have carried these names since PostgreSQL 7.x.
--
-- CHECK 0 verifies every one of those column names EXISTS before the script
-- relies on it, so a future catalog change surfaces as a readable report on
-- line one rather than as a 42703 halfway through.
--
-- HOW TO USE
--   Run the whole file. Compare each block against its PASS CONDITION.
--   If ANY block fails, stop. Do not run 01-migration.sql.
-- ============================================================================

-- ── CHECK 0 · catalog self-test  ★ RUN THIS FIRST ★ ─────────────────────────
-- WHY   Proves this script's assumptions about catalog shape before it makes
--       any of them. Nothing below is trustworthy if a row here says MISSING.
-- PASS  Every row reads PRESENT.
-- FAIL  Any MISSING → stop and report which one; the query that needs it must
--       be rewritten before the gate can be judged.
with required (obj, col) as (
  values
    ('pg_policies', 'policyname'), ('pg_policies', 'cmd'),
    ('pg_policies', 'permissive'), ('pg_policies', 'roles'),
    ('pg_policies', 'qual'),       ('pg_policies', 'with_check'),
    ('pg_tables',   'rowsecurity'),
    ('pg_indexes',  'indexname'),  ('pg_indexes', 'indexdef'),
    ('pg_constraint', 'conname'),  ('pg_constraint', 'contype'),
    ('pg_constraint', 'conrelid'), ('pg_constraint', 'oid')
)
select r.obj,
       r.col,
       case when c.column_name is null then 'MISSING' else 'PRESENT' end as status
from required r
left join information_schema.columns c
       on c.table_schema in ('pg_catalog', 'information_schema')
      and c.table_name = r.obj
      and c.column_name = r.col
order by r.obj, r.col;

-- ── CHECK 1 · recordings column inventory ───────────────────────────────────
-- WHY   The migration adds course_id and updated_at. If either already exists
--       with a different type, ADD COLUMN IF NOT EXISTS would silently keep the
--       wrong one.
-- PASS  27 rows. Neither `course_id` nor `updated_at` appears.
--       `course` appears as text with is_nullable = NO.
-- FAIL  `course_id` or `updated_at` present  → STOP, report the type.
--       `course` missing or renamed          → STOP, schema drifted.
select ordinal_position, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'recordings'
order by ordinal_position;

-- ── CHECK 2 · the two columns the migration adds must not exist yet ─────────
-- WHY   A compact, unambiguous answer to CHECK 1's most important question.
-- PASS  Both rows read ABSENT.
-- FAIL  Either reads PRESENT → STOP.
with expected (col) as (values ('course_id'), ('updated_at'))
select e.col,
       case when c.column_name is null then 'ABSENT' else 'PRESENT' end as status,
       c.data_type
from expected e
left join information_schema.columns c
       on c.table_schema = 'public' and c.table_name = 'recordings'
      and c.column_name = e.col
order by e.col;

-- ── CHECK 3 · courses must not already exist ────────────────────────────────
-- WHY   A pre-existing courses table (another branch, another developer, a
--       partially applied attempt) would make the migration a no-op over an
--       unknown shape.
-- PASS  0 rows.
-- FAIL  Any row → STOP. Inspect it before doing anything else.
select table_name, table_type
from information_schema.tables
where table_schema = 'public'
  and table_name in ('courses', 'course', 'user_courses');

-- ── CHECK 4 · row security enabled on recordings ────────────────────────────
-- WHY   Confirms RLS is actually on, not merely that anonymous reads happen to
--       return nothing. Read from pg_tables.rowsecurity, the documented view
--       over pg_class.relrowsecurity.
-- PASS  rowsecurity = true.
-- FAIL  false → STOP. Cross-user isolation is not guaranteed.
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname = 'public' and tablename = 'recordings';

-- ── CHECK 5 · recordings RLS policies  ★ THE DECIDING CHECK ★ ───────────────
-- WHY   Desktop must, as the signed-in user, UPDATE its own rows to set
--       course_id, course and updated_at. If the UPDATE policy's WITH CHECK
--       expression is row-scoped — typically (auth.uid() = user_id) — new
--       columns are covered automatically and nothing needs changing. If it
--       names specific columns, or if there is no UPDATE policy at all, the
--       dual-write will fail after the migration.
--
--       `cmd` here is the pg_policies view's own text column: 'ALL', 'SELECT',
--       'INSERT', 'UPDATE' or 'DELETE'. No mapping is needed.
--
-- PASS  A row with cmd = 'UPDATE' (or cmd = 'ALL') exists, and BOTH `qual` and
--       `with_check` reference only user_id / auth.uid(), with no column list.
--       Note: for cmd = 'ALL', PostgreSQL may report with_check as NULL, in
--       which case `qual` is applied to writes as well — that is still a PASS.
-- FAIL  No UPDATE-capable policy, or one that does not constrain user_id, or a
--       with_check that could reject a write to a newly added column → STOP.
--       Report the exact expression.
select policyname,
       cmd,
       permissive,
       roles,
       qual        as using_expr,
       with_check  as with_check_expr
from pg_policies
where schemaname = 'public' and tablename = 'recordings'
order by cmd, policyname;

-- ── CHECK 5b · plain-language verdict on the UPDATE path ────────────────────
-- WHY   CHECK 5 prints the evidence; this states the conclusion so the gate
--       cannot be misread. It is a heuristic on the expression text, so treat
--       it as a summary of CHECK 5, never as a replacement for reading it.
-- PASS  verdict = 'PASS — row-scoped UPDATE policy'.
-- FAIL  anything else → STOP and read CHECK 5 in full.
select case
         when count(*) = 0
           then 'FAIL — no UPDATE-capable policy on public.recordings'
         when bool_or(
                (qual is not null and qual like '%user_id%')
                and (with_check is null or with_check like '%user_id%')
              )
           then 'PASS — row-scoped UPDATE policy'
         else 'FAIL — UPDATE policy does not constrain user_id on both sides'
       end as verdict,
       count(*) as update_capable_policies
from pg_policies
where schemaname = 'public' and tablename = 'recordings'
  and cmd in ('UPDATE', 'ALL');

-- ── CHECK 6 · existing indexes on recordings ────────────────────────────────
-- WHY   The migration adds recordings_user_course_idx. A pre-existing index
--       with that name, over different columns, would collide.
-- PASS  No index named recordings_user_course_idx.
-- FAIL  Name already taken → STOP, rename the new index first.
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'recordings'
order by indexname;

-- ── CHECK 7 · existing constraints on recordings ────────────────────────────
-- WHY   The migration adds a COMPOSITE foreign key on (user_id, course_id).
--       Confirms (a) the name recordings_user_course_fk is free, (b) the
--       primary key is the single column `id`, (c) no UNIQUE or CHECK
--       constraint would reject the backfill.
--
--       constraint_type comes from information_schema.table_constraints, whose
--       values are exactly 'CHECK', 'FOREIGN KEY', 'PRIMARY KEY', 'UNIQUE'.
--       The readable definition comes from pg_get_constraintdef(), which has no
--       view equivalent; the join uses only oid/conrelid/conname.
--
-- PASS  PRIMARY KEY is (id). No constraint named recordings_user_course_fk.
--       No FK on user_id that would conflict with the new composite FK.
-- FAIL  A composite PK, or the FK name taken → STOP.
select tc.constraint_name,
       tc.constraint_type,
       pg_get_constraintdef(pc.oid) as definition
from information_schema.table_constraints tc
left join pg_constraint pc
       on pc.conname = tc.constraint_name
      and pc.conrelid = 'public.recordings'::regclass
where tc.table_schema = 'public' and tc.table_name = 'recordings'
order by tc.constraint_type, tc.constraint_name;

-- ── CHECK 7b · foreign keys on recordings, by column ────────────────────────
-- WHY   Names the referencing and referenced columns explicitly, so "does an FK
--       already involve user_id?" is answered without reading DDL text.
--
-- WHY NOT information_schema
--       The first revision of this check joined table_constraints against
--       referential_constraints / key_column_usage / constraint_column_usage.
--       Run against production it returned ZERO ROWS while
--       recordings_user_id_fkey demonstrably exists. Those views only expose a
--       referential constraint when the REFERENCED unique/primary key is itself
--       visible to the current role, and recordings' FK points at
--       auth.users(id), whose primary key is owned by supabase_auth_admin. The
--       check therefore under-reported every foreign key into the auth schema —
--       silently, which is the worst way for a gate to be wrong.
--
--       pg_constraint has no such visibility filter. conkey/confkey are the
--       ordered column-number arrays, expanded here against pg_attribute so the
--       columns are named rather than numbered, and confdeltype carries the
--       ON DELETE action.
--
-- PASS  Exactly one row BEFORE the migration:
--         conname            = recordings_user_id_fkey
--         referencing_columns = user_id
--         references_schema  = auth
--         references_table   = users
--         referenced_columns = id
--         on_delete          = CASCADE
--       and NO row named recordings_user_course_fk.
--
--       AFTER the migration, two rows: the one above, plus
--         conname            = recordings_user_course_fk
--         referencing_columns = user_id, course_id
--         references_schema  = public
--         references_table   = courses
--         referenced_columns = user_id, id
--         on_delete          = SET NULL
--
-- FAIL  recordings_user_course_fk already present before the migration, or any
--       other foreign key on (user_id, course_id) → STOP and compare it with
--       the proposed constraint. A single-column FK on user_id alone is
--       EXPECTED and does not conflict: a column may take part in several
--       foreign keys, and the new one references a different table.
select c.conname,
       (select string_agg(a.attname, ', ' order by k.ord)
          from unnest(c.conkey) with ordinality k(attnum, ord)
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum)
         as referencing_columns,
       fns.nspname as references_schema,
       fcl.relname as references_table,
       (select string_agg(a.attname, ', ' order by k.ord)
          from unnest(c.confkey) with ordinality k(attnum, ord)
          join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum)
         as referenced_columns,
       case c.confdeltype when 'a' then 'NO ACTION' when 'r' then 'RESTRICT'
                          when 'c' then 'CASCADE'   when 'n' then 'SET NULL'
                          when 'd' then 'SET DEFAULT' end as on_delete,
       pg_get_constraintdef(c.oid) as definition
from pg_constraint c
join pg_class     fcl on fcl.oid = c.confrelid
join pg_namespace fns on fns.oid = fcl.relnamespace
where c.conrelid = 'public.recordings'::regclass
  and c.contype = 'f'
order by c.conname;

-- ── CHECK 8 · backfill dry-run — what would be created ──────────────────────
-- WHY   Shows exactly the courses 03-backfill.sql will insert, before anything
--       is inserted. Grouping is (user_id, lower(btrim(course))), the same key
--       existing clients already use.
-- PASS  Row count matches the checklist (36 at design time). Names look like
--       real course names.
-- FAIL  A wildly different count → STOP and re-read CHECK 9.
select user_id,
       (array_agg(btrim(course) order by created_at, id))[1] as course_name_to_create,
       count(*)        as lectures_that_would_link,
       min(created_at) as first_lecture_at
from public.recordings
where course is not null and btrim(course) <> ''
group by user_id, lower(btrim(course))
order by user_id, lectures_that_would_link desc;

-- ── CHECK 9 · normalization collision check  ★ MUST BE ZERO ROWS ★ ──────────
-- WHY   The backfill groups case-insensitively. If a user has two course names
--       differing ONLY by case or surrounding whitespace they would be merged
--       into one course, destroying a distinction the user made on purpose.
-- PASS  0 rows.
-- FAIL  Any row → STOP. Do not run the backfill. Report the user and the
--       colliding names for a manual decision.
select user_id,
       count(distinct btrim(course))        as distinct_trimmed,
       count(distinct lower(btrim(course))) as distinct_normalized
from public.recordings
where course is not null and btrim(course) <> ''
group by user_id
having count(distinct btrim(course)) <> count(distinct lower(btrim(course)));

-- ── CHECK 10 · rows that would remain Unfiled ───────────────────────────────
-- WHY   A NULL or blank course cannot become a course. Those lectures stay
--       Unfiled, expressed as course_id IS NULL — never as a synthetic
--       "Unfiled" course row, which would be renamable and deletable.
-- PASS  Informational; any value is acceptable (0 at design time).
select count(*) as would_remain_unfiled
from public.recordings
where course is null or btrim(course) = '';

-- ── CHECK 11 · totals, for reconciliation after backfill ────────────────────
-- WHY   WRITE THESE THREE NUMBERS DOWN. 04-post-validation.sql asserts the
--       totals are unchanged after migration and backfill, which is how "no
--       lecture was lost" is proven rather than assumed.
select count(*)                             as total_recordings,
       count(distinct user_id)              as distinct_users,
       count(distinct lower(btrim(course))) as distinct_normalized_courses
from public.recordings;
