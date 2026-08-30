import type { Recording } from '../../types'
import type { CloudTrashedMeta } from '../cloudLectureTrash'
import { courseNameKey, type Course } from './courseModel'

/**
 * The Recently Deleted view model.
 *
 * Two entirely different stores feed one screen, and neither of them is a
 * `courses` row:
 *
 *   · Deleted COURSES are real cloud rows with `courses.deleted_at` set. They
 *     sync across devices and are served by `CoursesRepository.listDeleted()`.
 *
 *   · Deleted LECTURES are cloud rows carrying `recordings.deleted_at` +
 *     `recordings.deletion_updated_at` — the authoritative account-level model,
 *     served by `deletedLecturesFromCloudRows`. In local-only mode the row is
 *     moved into a separate IndexedDB store instead.
 *
 *   · `deletedLecturesFromRegistry` reads the pre-Stage-4 device-local
 *     localStorage trash. It is COMPATIBILITY ONLY, for a database that has no
 *     deletion columns, and is never consulted when the cloud can answer.
 *
 * This file is pure: no React, no Supabase, no IndexedDB. It turns whatever the
 * caller already has into rows the page can render, and it owns the one
 * non-obvious product rule — restoring a lecture must also bring back its
 * course if that course is itself sitting in Recently Deleted.
 */

export type DeletedLecture = {
  id: string
  title: string
  /** The course label captured at deletion time; '' means Unfiled. */
  courseName: string
  /** Epoch ms, or 0 when the store never recorded one (local-only trash). */
  deletedAt: number
}

/**
 * The authoritative source: rows whose `deleted_at` is set in the cloud.
 *
 * These arrive from the same fetch that produced the active library, so a
 * lecture deleted on iPad appears here on Desktop with the deletion time the
 * account agreed on — not a time this Mac invented.
 */
export function deletedLecturesFromCloudRows(
  rows: readonly Recording[],
  fallbackTitle: string,
): DeletedLecture[] {
  return rows
    .map((row) => ({
      id: row.id,
      title: row.title?.trim() || fallbackTitle,
      courseName: row.course?.trim() ?? '',
      deletedAt: typeof row.deletedAt === 'number' ? row.deletedAt : 0,
    }))
    .sort((a, b) => b.deletedAt - a.deletedAt || a.title.localeCompare(b.title))
}

/**
 * COMPATIBILITY ONLY: the pre-Stage-4 per-device registry keyed by recording id.
 *
 * Used solely on a database with no deletion columns. Its timestamps are this
 * Mac's local clock and are never compared against a cloud clock.
 */
export function deletedLecturesFromRegistry(
  registry: Readonly<Record<string, CloudTrashedMeta>>,
  fallbackTitle: string,
): DeletedLecture[] {
  return Object.entries(registry)
    .map(([id, meta]) => ({
      id,
      title: meta.title.trim() || fallbackTitle,
      courseName: meta.course.trim(),
      deletedAt: meta.trashedAt,
    }))
    .sort((a, b) => b.deletedAt - a.deletedAt)
}

/**
 * Local-only mode: rows lifted out of the IndexedDB trash store.
 *
 * `deletedAt` is 0 because that store keeps the original row unchanged and
 * never stamps a deletion time. Showing 0 as "no date" is honest; inventing
 * `createdAt` as the deletion date would not be.
 */
export function deletedLecturesFromLocalRows(
  rows: readonly Recording[],
  fallbackTitle: string,
): DeletedLecture[] {
  return rows
    .map((row) => ({
      id: row.id,
      title: row.title?.trim() || fallbackTitle,
      courseName: row.course?.trim() ?? '',
      deletedAt: 0,
    }))
    .sort((a, b) => b.deletedAt - a.deletedAt || a.title.localeCompare(b.title))
}

/**
 * The course that must be restored alongside a lecture, if any.
 *
 * Restoring a lecture into a course that is itself in Recently Deleted would
 * put the lecture somewhere the user cannot see — it would vanish from Courses
 * entirely. So the course comes back with it.
 *
 * Matching is by normalized name, because the registry stores the legacy
 * `recordings.course` label rather than a `course_id`; `courseNameKey` is the
 * same `lower(btrim())` the database's unique index uses.
 */
export function courseToRestoreWithLecture(
  lecture: Pick<DeletedLecture, 'courseName'>,
  deletedCourses: readonly Course[],
): Course | null {
  const key = courseNameKey(lecture.courseName)
  if (!key) return null
  return deletedCourses.find((course) => courseNameKey(course.name) === key) ?? null
}

/** Total item count behind the Courses-page entry. Zero hides the entry. */
export function recentlyDeletedCount(
  deletedCourses: readonly Course[],
  deletedLectures: readonly DeletedLecture[],
): number {
  return deletedCourses.length + deletedLectures.length
}
