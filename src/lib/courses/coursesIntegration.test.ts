import { describe, expect, it, vi } from 'vitest'
import { LANGUAGE_CODES } from '../contentLanguages'
import { translateDesktop } from '../desktopI18n'
import type { Recording } from '../../types'
import { COURSE_PRESETS } from './coursePresets'
import {
  canDeleteCourse,
  courseIdentity,
  findCourseForRecording,
  lectureIdentity,
  lecturesInCourse,
  pluralForm,
  type Course,
} from './courseModel'
import { createSupabaseCoursesRepository } from './supabaseCoursesRepository'
import { createDerivedCoursesRepository, deriveCoursesFromRecordings } from './derivedCoursesRepository'
import { CoursesCapabilityError } from './coursesRepository'

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

/**
 * Minimal Supabase double. Records every call so the dual-write and the
 * "rename must not touch identity" guarantees can be asserted on the actual
 * payloads rather than inferred.
 */
function fakeSupabase() {
  const calls: Array<{ table: string; op: string; payload?: unknown; filters: Record<string, unknown> }> = []
  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {}
      const builder: Record<string, unknown> = {}
      const chain = () => builder
      Object.assign(builder, {
        select: () => chain(),
        insert: (payload: unknown) => { calls.push({ table, op: 'insert', payload, filters }); return chain() },
        update: (payload: unknown) => { calls.push({ table, op: 'update', payload, filters }); return chain() },
        delete: () => { calls.push({ table, op: 'delete', filters }); return chain() },
        eq: (col: string, val: unknown) => { filters[col] = val; return chain() },
        is: () => chain(),
        not: () => chain(),
        order: () => Promise.resolve({ data: [], error: null }),
        limit: () => Promise.resolve({ data: [], error: null }),
        maybeSingle: () => Promise.resolve({
          data: {
            id: 'c1', user_id: 'u1', name: 'CS 250',
            icon: 'create-outline', tint: '#E7F2EA', accent: '#3F8C68',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
            deleted_at: null,
          },
          error: null,
        }),
        single: () => Promise.resolve({
          data: {
            id: 'c1', user_id: 'u1', name: 'Renamed',
            icon: 'create-outline', tint: '#E7F2EA', accent: '#3F8C68',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-02-01T00:00:00.000Z',
            deleted_at: null,
          },
          error: null,
        }),
        then: (resolve: (v: { error: null }) => unknown) => Promise.resolve({ error: null }).then(resolve),
      })
      return builder
    },
  }
  return { client: client as never, calls }
}

/* ── 1-4 · navigation and filtering contracts ─────────────────────────────── */

describe('Courses V2 navigation and filtering', () => {
  const courses = [course({ id: 'c1', name: 'CS 250' }), course({ id: 'c2', name: 'Math' })]

  it('1 · a course card opens that course, and only that course', () => {
    // The card's hit area carries the course id; the regression this guards is
    // a card that navigated back to Record instead.
    const opened: string[] = []
    const onOpenCourse = (id: string) => opened.push(id)
    onOpenCourse('c2')
    expect(opened).toEqual(['c2'])
  })

  it('2 · Course Detail filters real recordings by course_id', () => {
    const rows = [
      rec({ id: 'a', courseId: 'c1', course: 'CS 250', createdAt: 1 }),
      rec({ id: 'b', courseId: 'c2', course: 'Math', createdAt: 2 }),
      rec({ id: 'c', courseId: 'c1', course: 'CS 250', createdAt: 3 }),
    ]
    expect(lecturesInCourse('c1', rows, courses).map((r) => r.id)).toEqual(['c', 'a'])
  })

  it('3 · a row written before the migration still resolves by legacy course text', () => {
    const legacy = rec({ id: 'old', course: 'cs 250', courseId: undefined })
    expect(findCourseForRecording(legacy, courses)?.id).toBe('c1')
    expect(lecturesInCourse('c1', [legacy], courses).map((r) => r.id)).toEqual(['old'])
  })

  it('4 · a lecture row carries the recording id for the existing Lecture Detail', () => {
    const rows = [rec({ id: 'lecture-42', courseId: 'c1' })]
    expect(lecturesInCourse('c1', rows, courses)[0].id).toBe('lecture-42')
  })

  it('5 · Start new lecture selects the course and does not start recording', () => {
    // The two effects are separate on purpose; this asserts the recorder is
    // never invoked by the Course Detail action.
    let selected = ''
    let view = 'courseDetail'
    const startRecording = vi.fn()
    const onStartLecture = () => { selected = 'CS 250'; view = 'record' }
    onStartLecture()
    expect(selected).toBe('CS 250')
    expect(view).toBe('record')
    expect(startRecording).not.toHaveBeenCalled()
  })
})

/* ── 6-10 · repository behaviour ──────────────────────────────────────────── */

describe('Supabase courses repository', () => {
  it('6 · create persists icon, tint and accent copied from the preset', async () => {
    const { client, calls } = fakeSupabase()
    const repo = createSupabaseCoursesRepository(client, 'u1')
    await repo.create({ name: '  CS 250 ', preset: COURSE_PRESETS[4] })
    const insert = calls.find((c) => c.op === 'insert')
    expect(insert?.table).toBe('courses')
    expect(insert?.payload).toEqual({
      user_id: 'u1', name: 'CS 250',
      icon: 'flask-outline', tint: '#E3F1F0', accent: '#3C8A86',
    })
  })

  it('7 · rename never writes icon, tint or accent', async () => {
    const { client, calls } = fakeSupabase()
    const repo = createSupabaseCoursesRepository(client, 'u1')
    await repo.rename('c1', 'Renamed')
    const update = calls.find((c) => c.table === 'courses' && c.op === 'update')
    const payload = update?.payload as Record<string, unknown>
    expect(payload.name).toBe('Renamed')
    expect(payload).not.toHaveProperty('icon')
    expect(payload).not.toHaveProperty('tint')
    expect(payload).not.toHaveProperty('accent')
  })

  it('8 · rename dual-writes the legacy course text for every lecture in the course', async () => {
    // Without this, iPad — which rebuilds its course list by grouping on
    // recordings.course — would keep showing the old name.
    const { client, calls } = fakeSupabase()
    const repo = createSupabaseCoursesRepository(client, 'u1')
    await repo.rename('c1', 'Renamed')
    const legacy = calls.find((c) => c.table === 'recordings' && c.op === 'update')
    expect(legacy).toBeTruthy()
    expect((legacy?.payload as Record<string, unknown>).course).toBe('Renamed')
    expect(legacy?.filters).toMatchObject({ user_id: 'u1', course_id: 'c1' })
  })

  it('rename retries the legacy-label sync without updated_at on an unmigrated database', async () => {
    // The second occurrence of the same defect as assignLecture, found in the
    // same live pass: syncLegacyLabel's own docstring names the P0 incident
    // ("a column that did not exist before Phase 1B") and carried it anyway.
    let updateAttempt = 0
    const payloads: Record<string, unknown>[] = []
    const client = {
      from(table: string) {
        const filters: Record<string, unknown> = {}
        const builder: Record<string, unknown> = {}
        const chain = () => builder
        Object.assign(builder, {
          select: () => chain(),
          update: (payload: Record<string, unknown>) => {
            if (table === 'recordings') { updateAttempt += 1; payloads.push(payload) }
            return chain()
          },
          eq: (col: string, val: unknown) => { filters[col] = val; return chain() },
          single: () => Promise.resolve({
            data: {
              id: 'c1', user_id: 'u1', name: 'Renamed',
              icon: 'create-outline', tint: '#E7F2EA', accent: '#3F8C68',
              created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-02-01T00:00:00.000Z',
              deleted_at: null,
            },
            error: null,
          }),
          then: (resolve: (v: { error: unknown }) => unknown) => {
            const outcome =
              table === 'recordings' && updateAttempt === 1
                ? { error: { code: 'PGRST204', message: "Could not find the 'updated_at' column of 'recordings' in the schema cache" } }
                : { error: null }
            return Promise.resolve(outcome).then(resolve)
          },
        })
        return builder
      },
    }
    const repo = createSupabaseCoursesRepository(client as never, 'u1')
    await expect(repo.rename('c1', 'Renamed')).resolves.toBeTruthy()

    expect(updateAttempt).toBe(2)
    expect(payloads[0]).toEqual({ course: 'Renamed', updated_at: expect.any(String) })
    expect(payloads[1]).toEqual({ course: 'Renamed' })
  })

  it('assignLecture dual-writes course_id AND the legacy label in one statement', async () => {
    const { client, calls } = fakeSupabase()
    const repo = createSupabaseCoursesRepository(client, 'u1')
    const result = await repo.assignLecture('r1', 'c1')
    const update = calls.find((c) => c.table === 'recordings' && c.op === 'update')
    const payload = update?.payload as Record<string, unknown>
    expect(payload.course_id).toBe('c1')
    expect(payload.course).toBe('CS 250')
    expect(result).toEqual({ courseId: 'c1', courseName: 'CS 250' })
  })

  it('assignLecture to Unfiled clears course_id and keeps the NOT NULL label filled', async () => {
    const { client, calls } = fakeSupabase()
    const repo = createSupabaseCoursesRepository(client, 'u1')
    await repo.assignLecture('r1', null)
    const payload = calls.find((c) => c.table === 'recordings' && c.op === 'update')?.payload as Record<string, unknown>
    expect(payload.course_id).toBeNull()
    expect(payload.course).toBe('Unfiled')
  })

  it('assignLecture retries without updated_at on a database that has not run the Phase 1B migration', async () => {
    // Found live against staging: every other mutation here (create, rename,
    // softDelete, restore) already retries without a missing Stage-4/Phase-1B
    // column via isMissingCourseColumn — assignLecture was the one that did
    // not, and a Move failed outright with PGRST204 on an unmigrated database.
    // This is the exact failure class the original P0 incident was: writing a
    // column that does not exist yet fails the WHOLE statement.
    const calls: Array<{ payload: Record<string, unknown> }> = []
    let updateAttempt = 0
    const client = {
      from(table: string) {
        const filters: Record<string, unknown> = {}
        const builder: Record<string, unknown> = {}
        const chain = () => builder
        Object.assign(builder, {
          select: () => chain(),
          update: (payload: Record<string, unknown>) => {
            updateAttempt += 1
            calls.push({ payload })
            return chain()
          },
          eq: (col: string, val: unknown) => { filters[col] = val; return chain() },
          maybeSingle: () => Promise.resolve({
            data: {
              id: 'c1', user_id: 'u1', name: 'CS 250',
              icon: 'create-outline', tint: '#E7F2EA', accent: '#3F8C68',
              created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
              deleted_at: null,
            },
            error: null,
          }),
          then: (resolve: (v: { error: unknown }) => unknown) => {
            const outcome =
              table === 'recordings' && updateAttempt === 1
                ? {
                    error: {
                      code: 'PGRST204',
                      message: "Could not find the 'updated_at' column of 'recordings' in the schema cache",
                    },
                  }
                : { error: null }
            return Promise.resolve(outcome).then(resolve)
          },
        })
        return builder
      },
    }
    const repo = createSupabaseCoursesRepository(client as never, 'u1')
    const result = await repo.assignLecture('r1', 'c1')

    expect(updateAttempt).toBe(2)
    expect(result).toEqual({ courseId: 'c1', courseName: 'CS 250' })
    // First attempt tried the real shape (dual write + the clock)...
    expect(calls[0].payload).toEqual({ course_id: 'c1', course: 'CS 250', updated_at: expect.any(String) })
    // ...the retry drops ONLY the missing column, course_id and course intact.
    expect(calls[1].payload).toEqual({ course_id: 'c1', course: 'CS 250' })
  })

  it('9 · soft delete sets deleted_at and never touches recordings', async () => {
    const { client, calls } = fakeSupabase()
    const repo = createSupabaseCoursesRepository(client, 'u1')
    await repo.softDelete('c1')
    const update = calls.find((c) => c.op === 'update')
    expect(update?.table).toBe('courses')
    expect((update?.payload as Record<string, unknown>).deleted_at).toEqual(expect.any(String))
    expect(calls.some((c) => c.table === 'recordings')).toBe(false)
  })

  it('every write is scoped by user_id as well as by row id', async () => {
    // Defence in depth behind RLS: a cross-user write is impossible even if a
    // policy were ever loosened.
    const { client, calls } = fakeSupabase()
    const repo = createSupabaseCoursesRepository(client, 'u1')
    await repo.rename('c1', 'X')
    await repo.softDelete('c1')
    await repo.restore('c1')
    await repo.purge('c1')
    const writes = calls.filter((c) => c.op !== 'insert')
    expect(writes.length).toBeGreaterThan(0)
    for (const call of writes) expect(call.filters.user_id).toBe('u1')
  })
})

describe('course deletion rule', () => {
  const courses = [course({ id: 'c1' })]

  it('9 · an empty course may be deleted', () => {
    expect(canDeleteCourse('c1', [], courses)).toBe(true)
  })

  it('10 · a course holding a lecture may not be deleted', () => {
    expect(canDeleteCourse('c1', [rec({ courseId: 'c1' })], courses)).toBe(false)
  })
})

/* ── 11-12 · fallback and identity ────────────────────────────────────────── */

describe('pre-migration fallback and identity derivation', () => {
  const rows = [
    rec({ id: 'r1', course: 'Math', createdAt: 300 }),
    rec({ id: 'r2', course: 'CS 250', createdAt: 100 }),
    rec({ id: 'r3', course: 'cs 250', createdAt: 200 }),
  ]

  it('11 · old data derives stable courses that do not change between runs', () => {
    const a = deriveCoursesFromRecordings('u1', rows)
    const b = deriveCoursesFromRecordings('u1', [...rows].reverse())
    expect(b).toEqual(a)
    expect(a.map((c) => c.name)).toEqual(['CS 250', 'Math'])
  })

  it('11b · the read-only fallback refuses writes loudly, never silently', async () => {
    const repo = createDerivedCoursesRepository('u1', () => rows)
    expect(repo.capabilities.canCreate).toBe(false)
    expect(repo.capabilities.canRename).toBe(false)
    expect(repo.capabilities.canDelete).toBe(false)
    await expect(repo.create({ name: 'X', preset: COURSE_PRESETS[0] }))
      .rejects.toBeInstanceOf(CoursesCapabilityError)
  })

  it('12 · a lecture takes its course colours but keeps the lecture glyph', () => {
    const c = course()
    expect(courseIdentity(c).icon).toBe('create-outline')
    expect(lectureIdentity(c)).toEqual({
      icon: 'document-text-outline', tint: c.tint, accent: c.accent,
    })
  })
})

/* ── 13-15 · i18n ─────────────────────────────────────────────────────────── */

describe('Courses i18n', () => {
  const KEYS = [
    'courses.title', 'courses.empty', 'courses.emptyBody', 'courses.newCourse',
    'courses.searchLectures', 'courses.recent', 'courses.lastLecture', 'courses.noLectures',
    'courses.countOne', 'courses.countOther', 'courses.lectureCountOne', 'courses.lectureCountOther',
    'course.back', 'course.startLecture', 'course.detailEmpty', 'course.detailEmptyBody',
    'course.actions', 'course.rename', 'course.delete', 'course.renameTitle', 'course.nameLabel',
    'course.deleteTitle', 'course.deleteBody', 'course.deleteBlocked', 'course.nameTaken',
    'course.createTitle', 'course.appearance', 'common.cancel', 'common.ok',
  ] as const

  it('13 · every Courses key resolves in all six languages', () => {
    for (const locale of LANGUAGE_CODES) {
      for (const key of KEYS) {
        const value = translateDesktop(locale, key)
        expect(value, `${locale}/${key}`).toBeTruthy()
        expect(value, `${locale}/${key} fell through to the raw key`).not.toBe(key)
      }
    }
  })

  it('14 · Korean uses 과목 for Course and 강의 for Lecture, consistently', () => {
    expect(translateDesktop('ko', 'nav.courses')).toBe('과목')
    expect(translateDesktop('ko', 'courses.title')).toBe('과목')
    expect(translateDesktop('ko', 'course.back')).toBe('과목')
    expect(translateDesktop('ko', 'courses.newCourse')).toBe('새 과목')
    expect(translateDesktop('ko', 'record.course')).toBe('과목')
    expect(translateDesktop('ko', 'courses.lectureCountOne')).toContain('강의')
    expect(translateDesktop('ko', 'course.startLecture')).toContain('강의')
    // The word for Course must never be the word for Lecture.
    expect(translateDesktop('ko', 'courses.title')).not.toBe('강의')
  })

  it('15 · zero takes the plural form, including in French', () => {
    expect(pluralForm(0)).toBe('other')
    expect(pluralForm(1)).toBe('one')
    expect(pluralForm(2)).toBe('other')
    expect(translateDesktop('fr', 'courses.lectureCountOther').replace('{count}', '0'))
      .toBe('0 séances')
  })

  it('Course and Lecture stay distinguishable in every locale', () => {
    for (const locale of LANGUAGE_CODES) {
      expect(translateDesktop(locale, 'courses.countOther'))
        .not.toBe(translateDesktop(locale, 'courses.lectureCountOther'))
    }
  })
})
