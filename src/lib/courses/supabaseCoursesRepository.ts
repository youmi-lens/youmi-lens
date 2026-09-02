import type { SupabaseClient } from '@supabase/supabase-js'
import {
  mapCourseRow,
  normalizeCourseName,
  toCourseInsertRow,
  type Course,
  type CourseDbRow,
  type CreateCourseInput,
} from './courseModel'
import type {
  CoursesCapabilities,
  CoursesRepository,
  MoveLectureResult,
} from './coursesRepository'

/**
 * The production Course repository.
 *
 * Requires the Phase 1B migration: `public.courses` plus
 * `public.recordings.course_id`. Until that has run,
 * `coursesRepositoryFactory` selects `derivedCoursesRepository` instead — this
 * module is never constructed against a database that cannot serve it.
 *
 * Every statement is scoped by `user_id` in addition to RLS. RLS is the
 * boundary; the explicit filter is defence in depth and keeps the queries
 * readable about their own intent.
 *
 * Nothing here touches audio, transcripts, summaries or any AI column.
 */

/**
 * True when an UPDATE failed because a Phase-1B-or-later column is absent —
 * `courses.deletion_updated_at` or `recordings.updated_at` — on a database
 * that has not run that migration. Lets the write retry without that column
 * instead of failing the whole delete / restore / move.
 */
function isMissingCourseColumn(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null
  if (!e) return false
  if (e.code === '42703' || e.code === 'PGRST204') return true
  return /deletion_updated_at|does not exist|schema cache/i.test(e.message ?? '')
}

const CAPABILITIES: CoursesCapabilities = {
  canCreate: true,
  canRename: true,
  canDelete: true,
  canRestore: true,
  canPurge: true,
  persistsIdentity: true,
}

/**
 * `deletion_updated_at` is READ, not merely written.
 *
 * It is the freshness half of the deletion pair, and without selecting it the
 * client has `deletedAt` with no way to order two competing decisions — a stale
 * cache could then resurrect a newer delete. Reading it is what makes
 * `mergeCourseDeletion` possible.
 */
const COLUMNS_STAGE4 =
  'id,user_id,name,icon,tint,accent,created_at,updated_at,deleted_at,deletion_updated_at'

/**
 * The same list without the Stage-4 column, for a database that predates the
 * migration. Asking for a column that does not exist fails the WHOLE select, so
 * a plain upgrade of the column list would have taken Courses down entirely on
 * an unmigrated project. `mapCourseRow` maps the absent field to `null`.
 */
const COLUMNS_LEGACY = 'id,user_id,name,icon,tint,accent,created_at,updated_at,deleted_at'

export function createSupabaseCoursesRepository(
  supabase: SupabaseClient,
  userId: string,
): CoursesRepository {
  /**
   * Which column list this session uses. Starts optimistic and degrades at most
   * once, on the first select that proves the column is absent — the same
   * shape the write paths below already use for their own fallback.
   */
  let columns = COLUMNS_STAGE4

  type SelectResult = { data: unknown; error: unknown }

  /**
   * Run a select with the current column list, degrading once if it is too new.
   *
   * Returns `unknown`: the column list is a runtime value, so PostgREST cannot
   * infer a row type from it and each caller states the shape it expects — the
   * same `as CourseDbRow` the literal-column version already used.
   */
  async function selectCourses(
    run: (cols: string) => PromiseLike<SelectResult>,
  ): Promise<unknown> {
    // Compare the list THIS attempt used, not the shared `columns` variable:
    // `useCourses.load` runs listActive() and listDeleted() in one Promise.all,
    // so on an unmigrated database both fail 42703 concurrently. Reading the
    // shared variable meant whichever response was handled second saw it
    // already degraded to LEGACY, concluded it had run out of fallbacks, and
    // rethrew — which is exactly how production showed "Couldn't load your
    // courses" while staging (which has the Stage-4 column, so never degrades)
    // stayed green.
    const attempted = columns
    const first = await run(attempted)
    if (!first.error) return first.data
    if (attempted === COLUMNS_LEGACY || !isMissingCourseColumn(first.error)) throw first.error
    columns = COLUMNS_LEGACY
    const retry = await run(COLUMNS_LEGACY)
    if (retry.error) throw retry.error
    return retry.data
  }

  async function requireCourse(courseId: string): Promise<Course> {
    const data = await selectCourses((cols) =>
      supabase.from('courses').select(cols).eq('id', courseId).eq('user_id', userId).maybeSingle(),
    )
    if (!data) throw new Error('Course not found')
    return mapCourseRow(data as CourseDbRow)
  }

  /**
   * Keep the legacy `recordings.course` label in step with the course row.
   *
   * This is the compatibility half of the dual write. Old clients read only
   * this column; without this call a rename would be invisible to them, which
   * is exactly the bug iPad has today (its own attempt fails because it also
   * writes `updated_at`, a column that did not exist before Phase 1B).
   */
  async function syncLegacyLabel(courseId: string, name: string): Promise<void> {
    // Same retry as assignLecture, and the same reason: this docstring already
    // named the P0 incident this function exists to fix — iPad's rename wrote
    // `updated_at` before the column existed and the whole statement failed —
    // and this call carried the identical defect, discovered live against a
    // database that has not run the Phase 1B migration.
    let { error } = await supabase
      .from('recordings')
      .update({ course: name, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('course_id', courseId)
    if (error && isMissingCourseColumn(error)) {
      ;({ error } = await supabase
        .from('recordings')
        .update({ course: name })
        .eq('user_id', userId)
        .eq('course_id', courseId))
    }
    if (error) throw error
  }

  return {
    kind: 'supabase',
    capabilities: CAPABILITIES,

    async listActive(): Promise<Course[]> {
      const data = await selectCourses((cols) =>
        supabase
          .from('courses')
          .select(cols)
          .eq('user_id', userId)
          .is('deleted_at', null)
          .order('created_at', { ascending: true }),
      )
      return (data as CourseDbRow[]).map(mapCourseRow)
    },

    async listDeleted(): Promise<Course[]> {
      const data = await selectCourses((cols) =>
        supabase
          .from('courses')
          .select(cols)
          .eq('user_id', userId)
          .not('deleted_at', 'is', null)
          .order('deleted_at', { ascending: false }),
      )
      return (data as CourseDbRow[]).map(mapCourseRow)
    },

    async create(input: CreateCourseInput): Promise<Course> {
      // 23505 is the partial unique index on (user_id, lower(btrim(name))).
      // Surfacing it plainly lets the UI say "that name is taken" instead of
      // showing a raw Postgres error.
      const data = await selectCourses((cols) =>
        supabase.from('courses').insert(toCourseInsertRow(userId, input)).select(cols).single(),
      )
      return mapCourseRow(data as CourseDbRow)
    },

    async rename(courseId: string, name: string): Promise<Course> {
      const next = normalizeCourseName(name)
      // icon / tint / accent are deliberately absent from this payload: a
      // rename must never change a course's visual identity.
      const data = await selectCourses((cols) =>
        supabase
          .from('courses')
          .update({ name: next, updated_at: new Date().toISOString() })
          .eq('id', courseId)
          .eq('user_id', userId)
          .select(cols)
          .single(),
      )
      await syncLegacyLabel(courseId, next)
      return mapCourseRow(data as CourseDbRow)
    },

    async softDelete(courseId: string): Promise<void> {
      // Soft delete only. Lectures are never touched — the foreign key is
      // ON DELETE SET NULL and this statement does not reach recordings at all.
      // Stage 4: stamp deletion_updated_at (the cross-device freshness clock);
      // retry without it on a database that predates the column (compatibility).
      const now = new Date().toISOString()
      let { error } = await supabase
        .from('courses')
        .update({ deleted_at: now, deletion_updated_at: now, updated_at: now })
        .eq('id', courseId)
        .eq('user_id', userId)
      if (error && isMissingCourseColumn(error)) {
        ;({ error } = await supabase
          .from('courses')
          .update({ deleted_at: now, updated_at: now })
          .eq('id', courseId)
          .eq('user_id', userId))
      }
      if (error) throw error
    },

    async restore(courseId: string): Promise<Course> {
      // Stage 4: stamp a fresh deletion_updated_at so a restore wins over a stale
      // tombstone on another client; retry without it where the column is absent.
      const now = new Date().toISOString()
      let res = await supabase
        .from('courses')
        .update({ deleted_at: null, deletion_updated_at: now, updated_at: now })
        .eq('id', courseId)
        .eq('user_id', userId)
        .select(columns)
        .single()
      if (res.error && isMissingCourseColumn(res.error)) {
        columns = COLUMNS_LEGACY
        res = await supabase
          .from('courses')
          .update({ deleted_at: null, updated_at: now })
          .eq('id', courseId)
          .eq('user_id', userId)
          .select(columns)
          .single()
      }
      if (res.error) throw res.error
      return mapCourseRow(res.data as unknown as CourseDbRow)
    },

    async purge(courseId: string): Promise<void> {
      // Any lecture still pointing here would be set to NULL by the foreign
      // key rather than deleted. In practice this cannot happen: only an empty
      // course reaches Recently Deleted in the first place.
      const { error } = await supabase
        .from('courses')
        .delete()
        .eq('id', courseId)
        .eq('user_id', userId)
      if (error) throw error
    },

    async assignLecture(recordingId: string, courseId: string | null): Promise<MoveLectureResult> {
      const course = courseId ? await requireCourse(courseId) : null
      // Unfiled keeps the legacy column non-empty because `recordings.course`
      // is NOT NULL in production. 'Unfiled' is the same word iPad uses for the
      // absent case (lib/store.tsx:53).
      const label = course ? course.name : 'Unfiled'
      // `recordings.updated_at` is the Phase 1B column this migration adds —
      // the same one whose ABSENCE caused the original P0 incident (iPad wrote
      // it before the column existed, the whole UPDATE failed with 42703, and
      // the rename never reached the cloud). Every other mutation in this file
      // already retries without the Stage-4 column; this was the one that did
      // not, discovered live against a database that has not run the migration.
      let { error } = await supabase
        .from('recordings')
        .update({
          // DUAL WRITE, one statement, one round trip: the new pointer AND the
          // legacy label that every pre-Phase-1B client reads.
          course_id: course ? course.id : null,
          course: label,
          updated_at: new Date().toISOString(),
        })
        .eq('id', recordingId)
        .eq('user_id', userId)
      if (error && isMissingCourseColumn(error)) {
        ;({ error } = await supabase
          .from('recordings')
          .update({ course_id: course ? course.id : null, course: label })
          .eq('id', recordingId)
          .eq('user_id', userId))
      }
      if (error) throw error
      return { courseId: course ? course.id : null, courseName: label }
    },
  }
}
