import type { Course, CreateCourseInput } from './courseModel'

/**
 * The Course persistence boundary.
 *
 * Two implementations exist and are selected at runtime by
 * `coursesRepositoryFactory`:
 *
 *   · `supabaseCoursesRepository` — the real one. Requires the Phase 1B
 *     migration (the `courses` table and `recordings.course_id`).
 *
 *   · `derivedCoursesRepository` — a READ-ONLY fallback that reconstructs
 *     courses from the legacy `recordings.course` strings. It exists so the
 *     Courses UI is correct before the migration runs, and so local-only mode
 *     (which has no cloud at all) keeps working. It is not a temporary hack
 *     behind a flag: it is the honest implementation of "courses when there is
 *     no courses table", and it reports its own limits through `capabilities`.
 *
 * When the migration lands, only the factory's choice changes. No caller, no
 * component and no test needs to be rewritten — that is the point of this
 * interface existing before the table does.
 */

export type CoursesRepositoryKind = 'supabase' | 'derived'

export type CoursesCapabilities = {
  /** False for the derived repository: names live on recordings, not a row. */
  canCreate: boolean
  canRename: boolean
  /** Soft delete into Recently Deleted. */
  canDelete: boolean
  canRestore: boolean
  /** Physical removal from Recently Deleted. */
  canPurge: boolean
  /** True once identity is stored per course rather than reconstructed. */
  persistsIdentity: boolean
}

export type MoveLectureResult = {
  /** Written to `recordings.course_id`. */
  courseId: string | null
  /** Written to `recordings.course` in the SAME statement — see below. */
  courseName: string
}

export interface CoursesRepository {
  readonly kind: CoursesRepositoryKind
  readonly capabilities: CoursesCapabilities

  /** Active courses, oldest first (stable order for the grid). */
  listActive(): Promise<Course[]>

  /** Soft-deleted courses, most recently deleted first. */
  listDeleted(): Promise<Course[]>

  create(input: CreateCourseInput): Promise<Course>

  /**
   * Rename only. Identity (icon / tint / accent) is explicitly NOT touched —
   * a rename must never change what a course looks like.
   *
   * Implementations must also propagate the new name to
   * `recordings.course` for every lecture in the course, or clients that read
   * only the legacy column (iPad, older Desktop) will keep showing the old name.
   */
  rename(courseId: string, name: string): Promise<Course>

  /**
   * Soft delete. The caller is responsible for enforcing "only an empty course
   * may be deleted"; `canDeleteCourse` in courseModel is the shared predicate.
   * Implementations must never cascade to lectures.
   */
  softDelete(courseId: string): Promise<void>

  restore(courseId: string): Promise<Course>

  /** Physical delete from Recently Deleted. Lectures are never removed. */
  purge(courseId: string): Promise<void>

  /**
   * Assign a lecture to a course, or to Unfiled with `courseId = null`.
   *
   * DUAL WRITE — not optional. Both `course_id` and the legacy `course` TEXT
   * are written in one statement. iPad rebuilds its entire course list on every
   * hydrate by grouping recordings on the `course` string
   * (`lib/store.tsx:350-378`); a lecture that carried only `course_id` would
   * appear under a stale name, or Unfiled, on every other device.
   */
  assignLecture(recordingId: string, courseId: string | null): Promise<MoveLectureResult>
}

/** Thrown when a caller asks a repository for something it cannot do. */
export class CoursesCapabilityError extends Error {
  readonly capability: keyof CoursesCapabilities

  constructor(capability: keyof CoursesCapabilities, kind: CoursesRepositoryKind) {
    super(
      `The ${kind} courses repository cannot ${capability}. ` +
        `This build is running against a database without the Phase 1B courses table.`,
    )
    this.name = 'CoursesCapabilityError'
    this.capability = capability
  }
}
