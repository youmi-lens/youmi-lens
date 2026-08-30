import type { Recording } from '../../types'
import {
  NEUTRAL_COURSE_IDENTITY,
  type CourseIdentity,
  type CoursePreset,
} from './coursePresets'

/**
 * The Course domain model and its mappers.
 *
 * A Course is a long-lived container owned by exactly one user. A Lecture (a
 * `Recording`) belongs to at most one Course. A Course carries its own visual
 * identity; a Lecture never stores a colour and always derives one from its
 * Course.
 *
 * This module is pure: no Supabase client, no React, no I/O. It is the shared
 * vocabulary between the two repository implementations, the UI, and the tests.
 */

/** Domain shape used everywhere in the app. */
export type Course = {
  id: string
  userId: string
  name: string
  icon: string
  tint: string
  accent: string
  /** Epoch ms. */
  createdAt: number
  /** Epoch ms. */
  updatedAt: number
  /** Epoch ms while the course sits in Recently Deleted; null when active. */
  deletedAt: number | null
  /**
   * Epoch ms of the last change to the deletion state — the cross-device
   * freshness clock, read as a PAIR with `deletedAt`.
   *
   * `null` means the database predates Cloud Library Stage 4 and has no clock
   * to offer. It is never invented: a fabricated timestamp would let a stale
   * client win a comparison it should lose.
   */
  deletionUpdatedAt: number | null
}

/** Row shape of `public.courses`, as returned by PostgREST. */
export type CourseDbRow = {
  id: string
  user_id: string
  name: string
  icon: string
  tint: string
  accent: string
  created_at: string
  updated_at: string
  deleted_at: string | null
  /** Cloud Library Stage 4. Absent on a database that predates the migration. */
  deletion_updated_at?: string | null
}

/** Insert payload for `public.courses`. */
export type CourseInsertRow = {
  user_id: string
  name: string
  icon: string
  tint: string
  accent: string
}

export type CreateCourseInput = {
  name: string
  preset: CoursePreset
}

/**
 * Grouping / uniqueness key for a course name.
 *
 * `lower(btrim(name))` — identical to the partial unique index in
 * `supabase-phase1b-courses-01-migration.sql` and to how iPad groups recordings
 * by course (`lib/store.tsx:354-359`). Client and database must agree on this
 * or the client will let a user create a name the database then rejects.
 */
export function courseNameKey(name: string | null | undefined): string {
  return (name ?? '').trim().toLowerCase()
}

/** Display-normalised name: trimmed, original casing preserved. */
export function normalizeCourseName(name: string | null | undefined): string {
  return (name ?? '').trim()
}

export function isCourseNameValid(name: string | null | undefined): boolean {
  return normalizeCourseName(name).length > 0
}

/**
 * True when `name` would collide with an existing ACTIVE course.
 *
 * `exceptCourseId` lets a rename keep its own name (including a pure
 * case change, which is a legitimate edit).
 */
export function courseNameConflicts(
  name: string,
  courses: readonly Course[],
  exceptCourseId?: string,
): boolean {
  const key = courseNameKey(name)
  if (!key) return false
  return courses.some(
    (course) =>
      course.deletedAt === null && course.id !== exceptCourseId && courseNameKey(course.name) === key,
  )
}

function toEpoch(value: string | null | undefined): number {
  if (!value) return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

export function mapCourseRow(row: CourseDbRow): Course {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    icon: row.icon,
    tint: row.tint,
    accent: row.accent,
    createdAt: toEpoch(row.created_at),
    updatedAt: toEpoch(row.updated_at),
    deletedAt: row.deleted_at ? toEpoch(row.deleted_at) : null,
    deletionUpdatedAt: row.deletion_updated_at ? toEpoch(row.deletion_updated_at) : null,
  }
}

export function toCourseInsertRow(userId: string, input: CreateCourseInput): CourseInsertRow {
  // The preset's three values are COPIED onto the course, exactly as iPad does
  // at app/create-course.tsx:36. The preset table is never consulted again to
  // render this course.
  return {
    user_id: userId,
    name: normalizeCourseName(input.name),
    icon: input.preset.icon,
    tint: input.preset.tint,
    accent: input.preset.accent,
  }
}

/* ── Visual identity resolution ──────────────────────────────────────────────
   The only two functions allowed to decide what colour something is. Every
   surface — Courses, Course Detail, Record selector, Recording, Recently
   Deleted, the Move picker, every dialog — must go through one of them.
   ────────────────────────────────────────────────────────────────────────── */

/** A course's own identity. */
export function courseIdentity(course: Course | null | undefined): CourseIdentity {
  if (!course) return NEUTRAL_COURSE_IDENTITY
  return { icon: course.icon, tint: course.tint, accent: course.accent }
}

/**
 * A lecture's identity: its course's colours, but the lecture glyph.
 *
 * iPad's rule at `app/course/[id].tsx:377-378` — a lecture is not its course,
 * so it borrows the colour, never the glyph.
 */
export function lectureIdentity(course: Course | null | undefined): CourseIdentity {
  if (!course) return NEUTRAL_COURSE_IDENTITY
  return { icon: NEUTRAL_COURSE_IDENTITY.icon, tint: course.tint, accent: course.accent }
}

/* ── Lecture ↔ Course association ────────────────────────────────────────── */

/**
 * The course a recording belongs to.
 *
 * Resolution order, and the reason for each step:
 *   1. `course_id` — authoritative once Phase 1B has shipped.
 *   2. the legacy `course` TEXT matched by normalized name — every row written
 *      by iPad, by an older Desktop, or by the server has only this. Without
 *      this step those lectures would appear Unfiled on Desktop even though
 *      they are filed everywhere else.
 *   3. `null` — genuinely Unfiled.
 *
 * Unfiled is the ABSENCE of a course. It is deliberately never represented by a
 * synthetic course row, which would be renamable and deletable.
 */
export function findCourseForRecording(
  recording: Pick<Recording, 'course'> & { courseId?: string | null },
  courses: readonly Course[],
): Course | null {
  if (recording.courseId) {
    const byId = courses.find((course) => course.id === recording.courseId)
    if (byId) return byId
  }
  const key = courseNameKey(recording.course)
  if (!key) return null
  return courses.find((course) => course.deletedAt === null && courseNameKey(course.name) === key) ?? null
}

/**
 * What Record Home's course selection should do once the live course list is
 * known, given a canonical match (or lack of one) from `findCourseForRecording`.
 *
 * A match wins outright — its `id`/`name` are the truth, so a rename or a
 * selection that only ever matched by legacy name self-heals to the real row,
 * and an existing valid selection is never displaced just because some other
 * course (e.g. a newly created one) now sorts first.
 *
 * With no match — the selection is missing, stale, deleted, or (as with the
 * hardcoded default this replaced) never had a course behind it at all — the
 * FIRST course in `courses` is adopted instead, in the exact order the caller
 * already uses for Courses/Course Detail. This function does not sort or
 * otherwise decide what "first" means; it only reads `courses[0]`. Record
 * Home should always point at a real course when one exists — Unfiled is not
 * offered as a resting state while real courses are available. Only a
 * genuinely empty `courses` clears the selection.
 *
 * `'keep'` is reported whenever the current state already agrees, so a caller
 * driving a React effect from this can skip the `setState` calls that would
 * otherwise re-run the effect for no reason.
 */
export type CourseSelectionReconciliation =
  | { action: 'keep' }
  | { action: 'adopt'; id: string; name: string }
  | { action: 'clear' }

export function reconcileCourseSelection(
  current: { course: string; courseId: string | null },
  match: Course | null,
  courses: readonly Course[],
): CourseSelectionReconciliation {
  if (match) {
    if (match.id !== current.courseId || match.name !== current.course) {
      return { action: 'adopt', id: match.id, name: match.name }
    }
    return { action: 'keep' }
  }
  const first = courses[0]
  if (first) {
    return { action: 'adopt', id: first.id, name: first.name }
  }
  if (current.courseId !== null || current.course !== '') {
    return { action: 'clear' }
  }
  return { action: 'keep' }
}

/** Active lectures inside one course, newest first. */
export function lecturesInCourse(
  courseId: string,
  recordings: readonly (Recording & { courseId?: string | null })[],
  courses: readonly Course[],
): Recording[] {
  return recordings
    .filter((recording) => findCourseForRecording(recording, courses)?.id === courseId)
    .sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * Whether a course may be deleted.
 *
 * The product rule, unchanged from the existing Desktop behaviour
 * (`App.tsx:4284-4289` `deleteFolderIfEmpty`) and from iPad: only an EMPTY
 * course may be deleted. Deleting a course must never delete a lecture.
 */
export function canDeleteCourse(
  courseId: string,
  recordings: readonly (Recording & { courseId?: string | null })[],
  courses: readonly Course[],
): boolean {
  return lecturesInCourse(courseId, recordings, courses).length === 0
}

/* ── Counting ─────────────────────────────────────────────────────────────── */

/**
 * Which plural form a count takes.
 *
 * French is called out explicitly because it is the one locale in this set
 * where the rule is contested. CLDR treats 0 as the `one` form in French
 * ("0 séance"), but the product decision for Youmi Lens is that **0 uses the
 * plural form**. Only exactly 1 is singular, in every locale here.
 *
 * zh-Hans / ja / ko have no grammatical plural; both keys carry the same string
 * so the choice is invisible there.
 */
export function pluralForm(count: number): 'one' | 'other' {
  return count === 1 ? 'one' : 'other'
}

/* ── Deletion freshness ───────────────────────────────────────────────────── */

/**
 * Reconcile one course's deletion state across devices.
 *
 * `deleted_at` and `deletion_updated_at` are read as a PAIR. `deleted_at`
 * says WHAT the state is; `deletion_updated_at` says WHEN that state was last
 * decided, and it is the only field the comparison is allowed to use — a
 * restore clears `deleted_at` to null, so `deleted_at` itself cannot order two
 * competing decisions.
 *
 * The rule the contract requires, in one line: **the side with the newer
 * deletion clock wins.** That is what makes a newer delete beat a stale active
 * cache AND a newer restore beat a stale delete, with no special-casing of
 * which direction the change went.
 *
 * When neither side carries a clock — a database that predates Cloud Library
 * Stage 4 — the freshly-read remote row wins, because there is nothing to
 * compare and the server is the more recent read. A missing clock is never
 * treated as "epoch 0" and never invented.
 *
 * Only the deletion pair is merged. Name, icon, tint, accent and the course's
 * UUID come from `remote` untouched: this is not a general row merge, and
 * identity is never derived from any of them.
 */
export function mergeCourseDeletion(local: Course, remote: Course): Course {
  const localClock = local.deletionUpdatedAt
  const remoteClock = remote.deletionUpdatedAt

  // A stale cache may not resurrect a newer decision — nor may it be discarded
  // when it is the one holding the newer decision.
  if (localClock !== null && (remoteClock === null || localClock > remoteClock)) {
    return { ...remote, deletedAt: local.deletedAt, deletionUpdatedAt: localClock }
  }
  return remote
}

/**
 * Apply `mergeCourseDeletion` across a freshly-read list.
 *
 * Courses the caller has never seen pass through unchanged, and a course that
 * has disappeared from the remote list is not re-added: this reconciles the
 * deletion pair on rows that exist remotely, and nothing else.
 */
export function mergeCourseListDeletion(
  local: readonly Course[],
  remote: readonly Course[],
): Course[] {
  if (local.length === 0) return [...remote]
  const byId = new Map(local.map((course) => [course.id, course]))
  return remote.map((row) => {
    const known = byId.get(row.id)
    return known ? mergeCourseDeletion(known, row) : row
  })
}

/**
 * Reconcile a freshly-read active/deleted pair against what is already known,
 * then re-split it.
 *
 * The two lists come from two queries, so the database has already sorted each
 * row into one of them. Merging can move a row across that line — a restore
 * this device just made, against a read that was issued before it landed — so
 * the split is recomputed from the merged `deletedAt` rather than trusted from
 * which query the row arrived in.
 *
 * Sort order is restored explicitly for the same reason: a row that crossed
 * over would otherwise sit wherever concatenation left it.
 */
export function reconcileCourseLists(
  known: readonly Course[],
  fetchedActive: readonly Course[],
  fetchedDeleted: readonly Course[],
): { active: Course[]; deleted: Course[] } {
  const merged = mergeCourseListDeletion(known, [...fetchedActive, ...fetchedDeleted])
  return {
    active: merged.filter((c) => c.deletedAt === null).sort((a, b) => a.createdAt - b.createdAt),
    deleted: merged.filter((c) => c.deletedAt !== null).sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0)),
  }
}
