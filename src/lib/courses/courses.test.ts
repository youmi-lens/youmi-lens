import { describe, expect, it } from 'vitest'
import { LANGUAGE_CODES } from '../contentLanguages'
import { translateDesktop } from '../desktopI18n'
import type { Recording } from '../../types'
import {
  COURSE_PRESETS,
  NEUTRAL_COURSE_IDENTITY,
  coursePresetById,
  coursePresetByOrdinal,
} from './coursePresets'
import {
  canDeleteCourse,
  courseIdentity,
  courseNameConflicts,
  courseNameKey,
  findCourseForRecording,
  lectureIdentity,
  lecturesInCourse,
  mapCourseRow,
  pluralForm,
  reconcileCourseSelection,
  toCourseInsertRow,
  type Course,
} from './courseModel'
import {
  createDerivedCoursesRepository,
  deriveCoursesFromRecordings,
} from './derivedCoursesRepository'
import { CoursesCapabilityError } from './coursesRepository'
import { probeCoursesSchema } from './coursesRepositoryFactory'

/* ── fixtures ─────────────────────────────────────────────────────────────── */

function course(over: Partial<Course> = {}): Course {
  return {
    id: 'c1', userId: 'u1', name: 'CS 250',
    icon: 'create-outline', tint: '#E7F2EA', accent: '#3F8C68',
    createdAt: 1000, updatedAt: 1000, deletedAt: null,
    ...over,
  }
}

function rec(over: Partial<Recording> = {}): Recording {
  return {
    id: 'r1', course: 'CS 250', title: 'Lecture 1',
    createdAt: 1000, durationSec: 60, mime: 'audio/webm',
    ...over,
  }
}

/* ── preset registry ──────────────────────────────────────────────────────── */

describe('course preset registry', () => {
  // These twelve values are duplicated in three places by necessity: iPad
  // lib/models.ts:306-313, this registry, and the presets CTE in
  // supabase-phase1b-courses-03-backfill.sql. This test is the tripwire for
  // drift between them.
  it('matches the iPad registry and the backfill SQL exactly', () => {
    expect(COURSE_PRESETS.map((p) => [p.id, p.icon, p.tint, p.accent])).toEqual([
      ['blue', 'people-outline', '#E8F1FB', '#3F73B0'],
      ['green', 'create-outline', '#E7F2EA', '#3F8C68'],
      ['sand', 'trending-up-outline', '#F3ECDB', '#A9802F'],
      ['slate', 'git-network-outline', '#ECECF3', '#6C6E8E'],
      ['teal', 'flask-outline', '#E3F1F0', '#3C8A86'],
      ['rose', 'book-outline', '#F4EAEA', '#A8696A'],
    ])
  })

  it('falls back to the first preset for an unknown id, never undefined', () => {
    expect(coursePresetById('does-not-exist')).toBe(COURSE_PRESETS[0])
  })

  it('wraps ordinals, including negatives, without throwing', () => {
    expect(coursePresetByOrdinal(0)).toBe(COURSE_PRESETS[0])
    expect(coursePresetByOrdinal(6)).toBe(COURSE_PRESETS[0])
    expect(coursePresetByOrdinal(7)).toBe(COURSE_PRESETS[1])
    expect(coursePresetByOrdinal(-1)).toBe(COURSE_PRESETS[5])
  })
})

/* ── name normalization ───────────────────────────────────────────────────── */

describe('course name normalization', () => {
  // Must match `lower(btrim(name))` in the partial unique index, or the client
  // will let a user create a name the database then rejects.
  it('lowercases and trims, matching the database index expression', () => {
    expect(courseNameKey('  CS 250  ')).toBe('cs 250')
    expect(courseNameKey('cs 250')).toBe(courseNameKey('CS 250'))
    expect(courseNameKey(null)).toBe('')
  })

  it('detects a conflict with an active course, ignoring case and spacing', () => {
    const existing = [course({ id: 'a', name: 'CS 250' })]
    expect(courseNameConflicts(' cs 250 ', existing)).toBe(true)
    expect(courseNameConflicts('CS 251', existing)).toBe(false)
  })

  it('lets a course keep its own name, so a case-only rename is allowed', () => {
    const existing = [course({ id: 'a', name: 'CS 250' })]
    expect(courseNameConflicts('cs 250', existing, 'a')).toBe(false)
  })

  it('ignores soft-deleted courses, so a freed name can be reused', () => {
    const existing = [course({ id: 'a', name: 'CS 250', deletedAt: 5 })]
    expect(courseNameConflicts('CS 250', existing)).toBe(false)
  })
})

/* ── visual identity ──────────────────────────────────────────────────────── */

describe('course visual identity', () => {
  it('reads identity off the course itself', () => {
    expect(courseIdentity(course())).toEqual({
      icon: 'create-outline', tint: '#E7F2EA', accent: '#3F8C68',
    })
  })

  it('gives a lecture the course colours but the lecture glyph', () => {
    // iPad's rule at app/course/[id].tsx:377-378.
    expect(lectureIdentity(course())).toEqual({
      icon: 'document-text-outline', tint: '#E7F2EA', accent: '#3F8C68',
    })
  })

  it('falls back to the neutral identity when there is no course', () => {
    expect(courseIdentity(null)).toEqual(NEUTRAL_COURSE_IDENTITY)
    expect(lectureIdentity(undefined)).toEqual(NEUTRAL_COURSE_IDENTITY)
  })

  it('copies the preset onto the course at creation', () => {
    const row = toCourseInsertRow('u1', { name: '  CS 250 ', preset: COURSE_PRESETS[4] })
    expect(row).toEqual({
      user_id: 'u1', name: 'CS 250',
      icon: 'flask-outline', tint: '#E3F1F0', accent: '#3C8A86',
    })
  })

  it('renaming never changes identity', () => {
    const before = course()
    const after = { ...before, name: 'Renamed' }
    expect(courseIdentity(after)).toEqual(courseIdentity(before))
  })
})

/* ── row mapping ──────────────────────────────────────────────────────────── */

describe('mapCourseRow', () => {
  it('maps a row and converts timestamps to epoch ms', () => {
    const mapped = mapCourseRow({
      id: 'c1', user_id: 'u1', name: 'CS 250',
      icon: 'create-outline', tint: '#E7F2EA', accent: '#3F8C68',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      deleted_at: null,
    })
    expect(mapped.createdAt).toBe(Date.parse('2026-01-01T00:00:00.000Z'))
    expect(mapped.deletedAt).toBeNull()
  })

  it('maps a soft-deleted row', () => {
    const mapped = mapCourseRow({
      id: 'c1', user_id: 'u1', name: 'X', icon: 'i', tint: 't', accent: 'a',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      deleted_at: '2026-02-01T00:00:00.000Z',
    })
    expect(mapped.deletedAt).toBe(Date.parse('2026-02-01T00:00:00.000Z'))
  })
})

/* ── lecture ↔ course association ─────────────────────────────────────────── */

describe('lecture to course association', () => {
  const courses = [course({ id: 'c1', name: 'CS 250' }), course({ id: 'c2', name: 'Math' })]

  it('prefers course_id over the legacy label', () => {
    const r = rec({ courseId: 'c2', course: 'CS 250' })
    expect(findCourseForRecording(r, courses)?.id).toBe('c2')
  })

  it('falls back to the legacy label when course_id is absent', () => {
    // Every row written by iPad, an older Desktop, or the server has only this.
    expect(findCourseForRecording(rec({ course: 'cs 250' }), courses)?.id).toBe('c1')
  })

  it('falls back to the label when course_id points at an unknown course', () => {
    expect(findCourseForRecording(rec({ courseId: 'gone', course: 'Math' }), courses)?.id).toBe('c2')
  })

  it('returns null for Unfiled rather than inventing a course', () => {
    expect(findCourseForRecording(rec({ course: '   ' }), courses)).toBeNull()
    expect(findCourseForRecording(rec({ course: 'Unknown' }), courses)).toBeNull()
  })

  it('never matches a soft-deleted course by name', () => {
    const deleted = [course({ id: 'c9', name: 'CS 250', deletedAt: 1 })]
    expect(findCourseForRecording(rec({ course: 'CS 250' }), deleted)).toBeNull()
  })

  it('lists only that course’s lectures, newest first', () => {
    const rs = [
      rec({ id: 'a', course: 'CS 250', createdAt: 1 }),
      rec({ id: 'b', course: 'Math', createdAt: 2 }),
      rec({ id: 'c', courseId: 'c1', course: 'CS 250', createdAt: 3 }),
    ]
    expect(lecturesInCourse('c1', rs, courses).map((r) => r.id)).toEqual(['c', 'a'])
  })
})

/* ── Record Home selection reconciliation ────────────────────────────────────
 * Regression coverage for the bug where Record Home showed a course name
 * ("CS 101") that did not exist in Courses at all — a hardcoded default that
 * was never validated against the live course list, plus a rename sync that
 * only ever matched by display name instead of by id. `reconcileCourseSelection`
 * is the pure decision behind the App.tsx effect that fixes this; these tests
 * drive it the same way that effect does: `findCourseForRecording` first, then
 * the reconciliation decision from that result. */
describe('Record Home course-selection reconciliation', () => {
  function selection(course: string, courseId: string | null) {
    return { course, courseId }
  }

  it('1 · a persisted selection that still exists is kept as-is', () => {
    const courses = [course({ id: 'c1', name: 'CS 250' })]
    const current = selection('CS 250', 'c1')
    const match = findCourseForRecording(current, courses)
    expect(reconcileCourseSelection(current, match)).toEqual({ action: 'keep' })
  })

  it('2 · a persisted selection whose course was renamed adopts the new name, not the stale one', () => {
    const courses = [course({ id: 'c1', name: 'CS 250 Renamed' })]
    const current = selection('CS 250', 'c1') // stale display name; id still matches
    const match = findCourseForRecording(current, courses)
    expect(reconcileCourseSelection(current, match)).toEqual({
      action: 'adopt',
      id: 'c1',
      name: 'CS 250 Renamed',
    })
  })

  it('3 · a persisted selection whose course was deleted clears rather than keeps showing the old name', () => {
    // Exactly the reported bug shape: a course id/name with nothing behind it —
    // here because the course was soft-deleted, so it is absent from the
    // active list entirely, same as a hardcoded default that never existed.
    const courses: Course[] = []
    const current = selection('CS 101', null)
    const match = findCourseForRecording(current, courses)
    expect(match).toBeNull()
    expect(reconcileCourseSelection(current, match)).toEqual({ action: 'clear' })
  })

  it('4 · a course that disappears after a live delete falls back safely on the next reconciliation', () => {
    const before = [course({ id: 'c1', name: 'CS 250' })]
    const current = selection('CS 250', 'c1')
    expect(reconcileCourseSelection(current, findCourseForRecording(current, before))).toEqual({
      action: 'keep',
    })
    // The course list refreshes after the delete; c1 is gone.
    const after: Course[] = []
    expect(reconcileCourseSelection(current, findCourseForRecording(current, after))).toEqual({
      action: 'clear',
    })
  })

  it('5 · a newly created course is adopted by id the moment it appears in the course list', () => {
    const coursesBeforeCreate: Course[] = []
    const current = selection('', null)
    expect(reconcileCourseSelection(current, findCourseForRecording(current, coursesBeforeCreate))).toEqual({
      action: 'keep',
    })
    // create() sets course + courseId directly (App.tsx), then the list refetches.
    const afterCreate = [course({ id: 'new-1', name: 'New Course' })]
    const created = selection('New Course', 'new-1')
    expect(reconcileCourseSelection(created, findCourseForRecording(created, afterCreate))).toEqual({
      action: 'keep',
    })
  })

  it('6 · a restored course becomes selectable again once it is back in the active list', () => {
    const whileDeleted: Course[] = []
    const restored = [course({ id: 'c1', name: 'CS 250' })]
    const current = selection('CS 250', 'c1')
    expect(reconcileCourseSelection(current, findCourseForRecording(current, whileDeleted))).toEqual({
      action: 'clear',
    })
    expect(reconcileCourseSelection(current, findCourseForRecording(current, restored))).toEqual({
      action: 'keep',
    })
  })

  it('never invents a course row — no match means Unfiled, never a fabricated identity', () => {
    const courses: Course[] = []
    const current = selection('CS 101', null)
    const decision = reconcileCourseSelection(current, findCourseForRecording(current, courses))
    expect(decision.action).not.toBe('adopt')
  })
})

/* ── deletion rule ────────────────────────────────────────────────────────── */

describe('course deletion rule', () => {
  const courses = [course({ id: 'c1', name: 'CS 250' })]

  it('allows deleting an empty course', () => {
    expect(canDeleteCourse('c1', [], courses)).toBe(true)
  })

  it('blocks deleting a course that still holds a lecture', () => {
    expect(canDeleteCourse('c1', [rec({ course: 'CS 250' })], courses)).toBe(false)
  })
})

/* ── derived (pre-migration) repository ───────────────────────────────────── */

describe('courses derived from legacy recordings', () => {
  const recordings = [
    rec({ id: 'r1', course: 'Math', createdAt: 300 }),
    rec({ id: 'r2', course: 'CS 250', createdAt: 100 }),
    rec({ id: 'r3', course: 'cs 250', createdAt: 200 }),
    rec({ id: 'r4', course: '   ', createdAt: 400 }),
  ]

  it('groups case-insensitively and skips blank labels', () => {
    const derived = deriveCoursesFromRecordings('u1', recordings)
    // 'CS 250' wins over 'cs 250' because r2 (createdAt 100) is earlier than
    // r3 (200) — the display name is the casing on the earliest lecture, the
    // same rule the backfill SQL applies.
    expect(derived.map((c) => c.name)).toEqual(['CS 250', 'Math'])
  })

  it('orders by first lecture then name, matching the backfill ORDER BY', () => {
    const derived = deriveCoursesFromRecordings('u1', recordings)
    expect(derived[0].createdAt).toBe(100)
    expect(derived[0].icon).toBe(COURSE_PRESETS[0].icon)
    expect(derived[1].icon).toBe(COURSE_PRESETS[1].icon)
  })

  it('is deterministic: input order cannot change identity', () => {
    const a = deriveCoursesFromRecordings('u1', recordings)
    const b = deriveCoursesFromRecordings('u1', [...recordings].reverse())
    expect(b).toEqual(a)
  })

  it('gives the same course the same id every time', () => {
    const a = deriveCoursesFromRecordings('u1', recordings)
    const b = deriveCoursesFromRecordings('u1', recordings)
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id))
  })

  it('refuses writes loudly instead of silently doing nothing', async () => {
    const repo = createDerivedCoursesRepository('u1', () => recordings)
    expect(repo.capabilities.canCreate).toBe(false)
    expect(repo.capabilities.persistsIdentity).toBe(false)
    await expect(repo.create({ name: 'X', preset: COURSE_PRESETS[0] }))
      .rejects.toBeInstanceOf(CoursesCapabilityError)
    await expect(repo.rename('x', 'y')).rejects.toBeInstanceOf(CoursesCapabilityError)
    await expect(repo.softDelete('x')).rejects.toBeInstanceOf(CoursesCapabilityError)
  })

  it('reports an empty bin, which is the true answer here', async () => {
    const repo = createDerivedCoursesRepository('u1', () => recordings)
    await expect(repo.listDeleted()).resolves.toEqual([])
  })
})

/* ── schema probe ─────────────────────────────────────────────────────────── */

describe('courses schema probe', () => {
  const client = (error: unknown) =>
    ({ from: () => ({ select: () => ({ limit: async () => ({ error }) }) }) }) as never

  it('reports available when the table answers', async () => {
    expect(await probeCoursesSchema(client(null))).toEqual({ available: true, probeError: null })
  })

  it('treats a missing table as not-yet-migrated', async () => {
    for (const code of ['PGRST205', '42P01']) {
      expect(await probeCoursesSchema(client({ code }))).toEqual({ available: false, probeError: null })
    }
  })

  it('does not misread a network or auth failure as not-yet-migrated', async () => {
    // Downgrading a migrated user to a read-only course list because their
    // token expired would look exactly like data loss to them.
    const err = { code: 'PGRST301', message: 'JWT expired' }
    const result = await probeCoursesSchema(client(err))
    expect(result.available).toBe(false)
    expect(result.probeError).toBe(err)
  })
})

/* ── i18n ─────────────────────────────────────────────────────────────────── */

describe('Courses i18n', () => {
  const KEYS = [
    'courses.title', 'courses.empty', 'courses.emptyBody', 'courses.newCourse',
    'courses.searchLectures', 'courses.recent', 'courses.recentlyDeleted',
    'courses.lastLecture', 'courses.noLectures',
    'courses.countOne', 'courses.countOther',
    'courses.lectureCountOne', 'courses.lectureCountOther',
    'course.back', 'course.startLecture', 'course.detailEmpty', 'course.detailEmptyBody',
    'course.actions', 'course.rename', 'course.delete',
    'course.renameTitle', 'course.nameLabel', 'course.deleteTitle', 'course.deleteBody',
    'course.deleteBlocked', 'course.nameTaken', 'course.createTitle', 'course.appearance',
  ] as const

  it('translates every Courses key in all six languages with no English leakage', () => {
    for (const locale of LANGUAGE_CODES) {
      for (const key of KEYS) {
        const value = translateDesktop(locale, key)
        expect(value, `${locale}/${key}`).toBeTruthy()
        expect(value, `${locale}/${key} fell through to the raw key`).not.toBe(key)
      }
    }
  })

  it('uses 과목 for Course and 강의 for Lecture in Korean, consistently', () => {
    // The sidebar previously said 강의 for Courses while the toolbar used 강의
    // for Lecture, so one word meant two different things.
    expect(translateDesktop('ko', 'nav.courses')).toBe('과목')
    expect(translateDesktop('ko', 'courses.title')).toBe('과목')
    expect(translateDesktop('ko', 'course.back')).toBe('과목')
    expect(translateDesktop('ko', 'courses.newCourse')).toBe('새 과목')
    expect(translateDesktop('ko', 'record.course')).toBe('과목')
    expect(translateDesktop('ko', 'courses.lectureCountOne')).toContain('강의')
    expect(translateDesktop('ko', 'course.startLecture')).toContain('강의')
  })

  it('uses the plural form for zero, including French', () => {
    expect(pluralForm(0)).toBe('other')
    expect(pluralForm(1)).toBe('one')
    expect(pluralForm(2)).toBe('other')
    const zero = translateDesktop('fr', 'courses.lectureCountOther').replace('{count}', '0')
    expect(zero).toBe('0 séances')
  })

  it('keeps Course and Lecture distinct in every locale’s count strings', () => {
    for (const locale of LANGUAGE_CODES) {
      expect(translateDesktop(locale, 'courses.countOther'))
        .not.toBe(translateDesktop(locale, 'courses.lectureCountOther'))
    }
  })
})
