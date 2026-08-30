import type { Recording } from '../../types'
import { coursePresetByOrdinal } from './coursePresets'
import { courseNameKey, normalizeCourseName, type Course } from './courseModel'
import {
  CoursesCapabilityError,
  type CoursesCapabilities,
  type CoursesRepository,
  type MoveLectureResult,
} from './coursesRepository'

/**
 * Courses reconstructed from the legacy `recordings.course` strings.
 *
 * Used in two real situations, neither of which is temporary:
 *   · before the Phase 1B migration has been applied to a given environment;
 *   · in local-only mode, which has no cloud tables at all.
 *
 * It is READ ONLY by construction. There is nowhere to persist a new course, a
 * rename, or a delete: a course here is not a row, it is a `GROUP BY` over
 * recordings. Rather than pretend, it declares `canCreate: false` and throws
 * `CoursesCapabilityError` if a caller ignores that. The UI reads
 * `capabilities` and disables the affected controls — no silent no-ops.
 *
 * DETERMINISM
 *   The identity of a derived course must be identical on every launch and on
 *   every device, or the same course changes colour when the app restarts. The
 *   ordinal is therefore taken from stable data — (first lecture timestamp,
 *   normalized name), scoped to the user — and never from iteration or
 *   hydration order. This mirrors, exactly, the ordering used by
 *   `supabase-phase1b-courses-03-backfill.sql`, so a course keeps the colour it
 *   had in this fallback once the real rows are backfilled.
 *
 *   This is deliberately NOT what iPad does. iPad's
 *   `choosePreset(coursesById.size)` (`lib/store.tsx:366`) depends on the order
 *   rows arrive in, which is why one course can be teal on one device and slate
 *   on another.
 */

const CAPABILITIES: CoursesCapabilities = {
  canCreate: false,
  canRename: false,
  canDelete: false,
  canRestore: false,
  canPurge: false,
  persistsIdentity: false,
}

/** Deterministic id for a derived course. Same name → same id, always. */
export function derivedCourseId(userId: string, name: string): string {
  const slug = courseNameKey(name)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return `derived_${userId}_${slug || 'unfiled'}`
}

/**
 * Group recordings into courses.
 *
 * Exported and pure so the ordering rule can be tested directly and compared
 * against the backfill SQL without a database.
 */
export function deriveCoursesFromRecordings(
  userId: string,
  recordings: readonly Recording[],
): Course[] {
  const groups = new Map<string, { name: string; firstAt: number; firstId: string }>()

  for (const recording of recordings) {
    const name = normalizeCourseName(recording.course)
    if (!name) continue
    const key = courseNameKey(name)
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, { name, firstAt: recording.createdAt, firstId: recording.id })
      continue
    }
    // The DISPLAY name is the casing the user typed on the EARLIEST lecture in
    // the group. Deterministic, and free of the collation dependency that
    // min(btrim(course)) would carry — Postgres would resolve 'CS 250' vs
    // 'cs 250' differently under C than under en_US. The backfill SQL uses the
    // matching array_agg(... order by created_at, id))[1] for the same reason.
    const earlier =
      recording.createdAt < existing.firstAt ||
      (recording.createdAt === existing.firstAt && recording.id < existing.firstId)
    if (earlier) {
      existing.firstAt = recording.createdAt
      existing.firstId = recording.id
      existing.name = name
    }
  }

  return [...groups.entries()]
    // (first lecture timestamp, normalized name) — the backfill's ORDER BY.
    .sort((a, b) => a[1].firstAt - b[1].firstAt || a[0].localeCompare(b[0]))
    .map(([key, group], ordinal) => {
      const preset = coursePresetByOrdinal(ordinal)
      return {
        id: derivedCourseId(userId, key),
        userId,
        name: group.name,
        icon: preset.icon,
        tint: preset.tint,
        accent: preset.accent,
        createdAt: group.firstAt,
        updatedAt: group.firstAt,
        deletedAt: null,
      // A derived course is synthesised from recordings and has no cloud row,
      // so there is no deletion clock to report. Never invented.
      deletionUpdatedAt: null,
      }
    })
}

export function createDerivedCoursesRepository(
  userId: string,
  getRecordings: () => readonly Recording[],
): CoursesRepository {
  const unavailable = (capability: keyof CoursesCapabilities): never => {
    throw new CoursesCapabilityError(capability, 'derived')
  }

  return {
    kind: 'derived',
    capabilities: CAPABILITIES,

    async listActive(): Promise<Course[]> {
      return deriveCoursesFromRecordings(userId, getRecordings())
    },

    async listDeleted(): Promise<Course[]> {
      // A derived course cannot be deleted, so the bin is always empty. This is
      // an accurate answer, not a stub.
      return []
    },

    // Parameters are intentionally omitted: these methods only ever throw, and
    // a shorter signature is still assignable to the interface.
    async create(): Promise<Course> {
      return unavailable('canCreate')
    },
    async rename(): Promise<Course> {
      return unavailable('canRename')
    },
    async softDelete(): Promise<void> {
      return unavailable('canDelete')
    },
    async restore(): Promise<Course> {
      return unavailable('canRestore')
    },
    async purge(): Promise<void> {
      return unavailable('canPurge')
    },
    async assignLecture(): Promise<MoveLectureResult> {
      // Moving a lecture would mean rewriting `recordings.course`, which is the
      // very field the grouping is derived from — it would silently create or
      // destroy a course. The existing per-lecture edit path stays responsible
      // for that until the migration lands.
      return unavailable('canCreate')
    },
  }
}
