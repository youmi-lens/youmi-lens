/**
 * Course deletion freshness.
 *
 * `deleted_at` says WHAT the state is; `deletion_updated_at` says WHEN it was
 * decided. They are read as a pair, and only the clock may order two competing
 * decisions — `deleted_at` itself cannot, because a restore sets it to null and
 * a null has no time in it.
 *
 * The invariant: a stale cache must never resurrect a newer deletion, and must
 * never bury a newer restore.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  mapCourseRow,
  mergeCourseDeletion,
  mergeCourseListDeletion,
  reconcileCourseLists,
  type Course,
  type CourseDbRow,
} from './courseModel'

const T0 = 1_700_000_000_000
const HOUR = 3_600_000

function course(overrides: Partial<Course> = {}): Course {
  return {
    id: 'c-1',
    userId: 'u-1',
    name: 'CS 101',
    icon: 'book',
    tint: '#111',
    accent: '#222',
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    deletionUpdatedAt: null,
    ...overrides,
  }
}

describe('the clock is read', () => {
  it('maps deletion_updated_at off the row', () => {
    const row: CourseDbRow = {
      id: 'c-1',
      user_id: 'u-1',
      name: 'CS 101',
      icon: 'book',
      tint: '#111',
      accent: '#222',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      deleted_at: '2026-03-01T00:00:00.000Z',
      deletion_updated_at: '2026-03-01T00:00:00.000Z',
    }
    const mapped = mapCourseRow(row)
    expect(mapped.deletedAt).toBe(Date.parse('2026-03-01T00:00:00.000Z'))
    expect(mapped.deletionUpdatedAt).toBe(Date.parse('2026-03-01T00:00:00.000Z'))
  })

  it('an unmigrated row reports null, never a fabricated time', () => {
    // A fabricated stamp would let a stale client win a comparison it must lose.
    const mapped = mapCourseRow({
      id: 'c-1',
      user_id: 'u-1',
      name: 'CS 101',
      icon: 'book',
      tint: '#111',
      accent: '#222',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      deleted_at: null,
    })
    expect(mapped.deletionUpdatedAt).toBeNull()
  })

  it('the repository actually SELECTs the column', () => {
    // Writing it without reading it was the audit finding: the client had
    // `deletedAt` and no way to order two decisions.
    const src = readFileSync(new URL('./supabaseCoursesRepository.ts', import.meta.url), 'utf8')
    expect(src).toContain('deleted_at,deletion_updated_at')
  })

  it('still selects a legacy list, so an unmigrated project keeps working', () => {
    // Asking for a column that does not exist fails the WHOLE select, which
    // would have taken Courses down entirely rather than degrading.
    const src = readFileSync(new URL('./supabaseCoursesRepository.ts', import.meta.url), 'utf8')
    expect(src).toContain('COLUMNS_LEGACY')
    expect(src).toContain('columns = COLUMNS_LEGACY')
    expect(src).not.toContain('select(COLUMNS)')
  })
})

describe('newer decision wins', () => {
  it('a newer DELETE beats a stale active cache', () => {
    const stale = course({ deletedAt: null, deletionUpdatedAt: T0 })
    const remote = course({ deletedAt: T0 + HOUR, deletionUpdatedAt: T0 + HOUR })
    expect(mergeCourseDeletion(stale, remote).deletedAt).toBe(T0 + HOUR)
  })

  it('a newer RESTORE beats a stale delete', () => {
    // The local side holds the newer decision here — a restore this device just
    // made, against a read that was issued before it landed.
    const local = course({ deletedAt: null, deletionUpdatedAt: T0 + HOUR })
    const staleRemote = course({ deletedAt: T0, deletionUpdatedAt: T0 })
    const merged = mergeCourseDeletion(local, staleRemote)
    expect(merged.deletedAt).toBeNull()
    expect(merged.deletionUpdatedAt).toBe(T0 + HOUR)
  })

  it('a stale cache never resurrects a newer deletion', () => {
    const stale = course({ deletedAt: null, deletionUpdatedAt: T0 - HOUR })
    const remote = course({ deletedAt: T0, deletionUpdatedAt: T0 })
    expect(mergeCourseDeletion(stale, remote).deletedAt).toBe(T0)
  })

  it('equal clocks defer to the freshly-read row', () => {
    const local = course({ deletedAt: null, deletionUpdatedAt: T0 })
    const remote = course({ deletedAt: T0, deletionUpdatedAt: T0 })
    expect(mergeCourseDeletion(local, remote).deletedAt).toBe(T0)
  })

  it('a local side with no clock cannot outrank anything', () => {
    const local = course({ deletedAt: null, deletionUpdatedAt: null })
    const remote = course({ deletedAt: T0, deletionUpdatedAt: T0 })
    expect(mergeCourseDeletion(local, remote).deletedAt).toBe(T0)
  })

  it('neither side has a clock — the server read wins', () => {
    const local = course({ deletedAt: null, deletionUpdatedAt: null })
    const remote = course({ deletedAt: T0, deletionUpdatedAt: null })
    expect(mergeCourseDeletion(local, remote).deletedAt).toBe(T0)
  })
})

describe('identity and content survive the merge', () => {
  it('the course UUID never changes', () => {
    const local = course({ id: 'c-1', deletionUpdatedAt: T0 + HOUR })
    const remote = course({ id: 'c-1', deletedAt: T0, deletionUpdatedAt: T0 })
    expect(mergeCourseDeletion(local, remote).id).toBe('c-1')
  })

  it('a rename on the server survives a locally-newer deletion decision', () => {
    // Only the deletion pair is merged. Name, icon, tint and accent are the
    // server's — this is not a general row merge.
    const local = course({ name: 'Old name', deletedAt: null, deletionUpdatedAt: T0 + HOUR })
    const remote = course({
      name: 'Renamed on iPad',
      icon: 'flask',
      tint: '#abc',
      accent: '#def',
      deletedAt: T0,
      deletionUpdatedAt: T0,
    })
    const merged = mergeCourseDeletion(local, remote)
    expect(merged.name).toBe('Renamed on iPad')
    expect(merged.icon).toBe('flask')
    expect(merged.tint).toBe('#abc')
    expect(merged.accent).toBe('#def')
    expect(merged.deletedAt).toBeNull()
  })
})

describe('across a whole list', () => {
  it('a course the client has never seen passes through untouched', () => {
    const remote = [course({ id: 'new', deletedAt: T0, deletionUpdatedAt: T0 })]
    expect(mergeCourseListDeletion([], remote)[0].deletedAt).toBe(T0)
    expect(mergeCourseListDeletion([course({ id: 'other' })], remote)[0].deletedAt).toBe(T0)
  })

  it('a course missing from the remote read is not re-added', () => {
    const local = [course({ id: 'gone' })]
    expect(mergeCourseListDeletion(local, [])).toEqual([])
  })

  it('re-splits by the MERGED state, not by which query the row came from', () => {
    // The restore landed after the read was issued, so the server still had the
    // course in its deleted list. It has to end up active anyway.
    const known = [course({ id: 'c-1', deletedAt: null, deletionUpdatedAt: T0 + HOUR })]
    const { active, deleted } = reconcileCourseLists(
      known,
      [],
      [course({ id: 'c-1', deletedAt: T0, deletionUpdatedAt: T0 })],
    )
    expect(active.map((c) => c.id)).toEqual(['c-1'])
    expect(deleted).toEqual([])
  })

  it('a newer remote delete moves the course into the bin', () => {
    const known = [course({ id: 'c-1', deletedAt: null, deletionUpdatedAt: T0 })]
    const { active, deleted } = reconcileCourseLists(
      known,
      [],
      [course({ id: 'c-1', deletedAt: T0 + HOUR, deletionUpdatedAt: T0 + HOUR })],
    )
    expect(active).toEqual([])
    expect(deleted.map((c) => c.id)).toEqual(['c-1'])
  })

  it('sort order is restored after a row crosses over', () => {
    const known = [course({ id: 'b', deletedAt: null, deletionUpdatedAt: T0 + HOUR })]
    const { active } = reconcileCourseLists(
      known,
      [course({ id: 'a', createdAt: T0 - HOUR }), course({ id: 'c', createdAt: T0 + HOUR })],
      [course({ id: 'b', createdAt: T0, deletedAt: T0, deletionUpdatedAt: T0 })],
    )
    expect(active.map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })

  it('the bin is newest-first', () => {
    const { deleted } = reconcileCourseLists(
      [],
      [],
      [
        course({ id: 'old', deletedAt: T0, deletionUpdatedAt: T0 }),
        course({ id: 'new', deletedAt: T0 + HOUR, deletionUpdatedAt: T0 + HOUR }),
      ],
    )
    expect(deleted.map((c) => c.id)).toEqual(['new', 'old'])
  })
})

describe('the hook applies it', () => {
  const src = readFileSync(new URL('./useCourses.ts', import.meta.url), 'utf8')

  it('every course list write goes through one reconciling applier', () => {
    expect(src).toContain('reconcileCourseLists(knownCoursesRef.current, active, deleted)')
    // Two raw setter pairs used to exist, one per fetch site.
    expect(src.match(/applyCourseLists\(/g)?.length).toBeGreaterThanOrEqual(3)
  })
})
