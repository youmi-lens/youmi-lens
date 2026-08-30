/**
 * Notes + Marks — the two account-level fields with their own freshness
 * clocks.
 *
 * MARKS V1 is frozen: `recordings.marked_timestamps` is `number[]` of elapsed
 * milliseconds. No id, no label, no per-mark metadata, no sort requirement,
 * duplicates legal, whole-array replacement. Every test that could tempt an
 * object schema in is written to fail if one appears.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  appendMark,
  formatMarkClock,
  markSeekSeconds,
  mergeLectureAnnotations,
  parseMarks,
  reconcileLectureAnnotations,
} from './lectureAnnotations'

describe('parseMarks — reading the contract defensively', () => {
  it('a clean number[] passes through unchanged, order and all', () => {
    expect(parseMarks([1500, 42000, 372100])).toEqual([1500, 42000, 372100])
  })

  it('duplicates are preserved, not de-duplicated', () => {
    expect(parseMarks([1500, 1500, 1500])).toEqual([1500, 1500, 1500])
  })

  it('order is never sorted', () => {
    expect(parseMarks([42000, 1500])).toEqual([42000, 1500])
  })

  it('a numeric string round-tripped through another client is accepted', () => {
    expect(parseMarks(['1500', '42000'])).toEqual([1500, 42000])
  })

  it('malformed elements are dropped, not thrown', () => {
    expect(parseMarks(['not-a-number', null, undefined, {}, [], true, () => 1])).toEqual([])
  })

  it('negative and non-finite numbers are dropped — nothing to seek to', () => {
    expect(parseMarks([-5, Number.NaN, Infinity, -Infinity])).toEqual([])
  })

  it('zero is a legal mark — the very start of the recording', () => {
    expect(parseMarks([0])).toEqual([0])
  })

  it('a non-array column (absent, null, a stray object) reads as no marks', () => {
    for (const raw of [undefined, null, {}, 'oops', 5]) {
      expect(parseMarks(raw)).toEqual([])
    }
  })

  it('a mix of valid and invalid keeps only the valid, in their original order', () => {
    expect(parseMarks([1500, 'bad', 42000, null, 372100])).toEqual([1500, 42000, 372100])
  })
})

describe('formatMarkClock — never raw milliseconds', () => {
  it('formats sub-minute, minute and hour scales', () => {
    expect(formatMarkClock(1500)).toBe('00:01')
    expect(formatMarkClock(42000)).toBe('00:42')
    expect(formatMarkClock(372100)).toBe('06:12')
  })

  it('drops sub-second precision — a clock, not a stopwatch', () => {
    expect(formatMarkClock(1999)).toBe('00:01')
  })

  it('zero formats as the start, not blank', () => {
    expect(formatMarkClock(0)).toBe('00:00')
  })

  it('an hour boundary carries correctly', () => {
    expect(formatMarkClock(3_600_000)).toBe('1:00:00')
  })

  it('a bad value never throws — falls back to zero', () => {
    expect(formatMarkClock(Number.NaN)).toBe('00:00')
    expect(formatMarkClock(-100)).toBe('00:00')
  })
})

describe('markSeekSeconds — the exact seek contract', () => {
  it('is ms / 1000, exactly', () => {
    expect(markSeekSeconds(1500)).toBe(1.5)
    expect(markSeekSeconds(42000)).toBe(42)
    expect(markSeekSeconds(372100)).toBe(372.1)
  })

  it('a bad value seeks to the start rather than throwing', () => {
    expect(markSeekSeconds(Number.NaN)).toBe(0)
    expect(markSeekSeconds(-5)).toBe(0)
  })
})

describe('appendMark — the only mutation V1 offers', () => {
  it('appends at the end, never re-sorted', () => {
    expect(appendMark([42000, 1500], 9000)).toEqual([42000, 1500, 9000])
  })

  it('does not mutate the array it was given', () => {
    const original = [1500]
    const next = appendMark(original, 42000)
    expect(original).toEqual([1500])
    expect(next).toEqual([1500, 42000])
  })

  it('marking the same moment twice is legal — no de-dupe', () => {
    expect(appendMark([1500], 1500)).toEqual([1500, 1500])
  })

  it('rounds to a whole millisecond', () => {
    expect(appendMark([], 1500.7)).toEqual([1501])
  })

  it('refuses a negative or non-finite position without throwing', () => {
    expect(appendMark([1500], -1)).toEqual([1500])
    expect(appendMark([1500], Number.NaN)).toEqual([1500])
  })
})

/* ── Freshness ─────────────────────────────────────────────────────────── */

const T0 = 1_700_000_000_000
const HOUR = 3_600_000

describe('mergeLectureAnnotations — each field by its OWN clock', () => {
  it('newer remote notes win; local marks are untouched by it', () => {
    const local = { notes: 'old', notesUpdatedAt: T0, markedTimestamps: [1500], marksUpdatedAt: T0 }
    const remote = {
      notes: 'new from iPad',
      notesUpdatedAt: T0 + HOUR,
      markedTimestamps: [1500],
      marksUpdatedAt: T0,
    }
    const merged = mergeLectureAnnotations(local, remote)
    expect(merged.notes).toBe('new from iPad')
    expect(merged.notesWinner).toBe('remote')
    expect(merged.markedTimestamps).toEqual([1500])
    expect(merged.marksWinner).toBe('local')
  })

  it('newer local marks (a mark just added here) survive a stale remote read', () => {
    const local = {
      notes: 'x',
      notesUpdatedAt: T0,
      markedTimestamps: [1500, 42000],
      marksUpdatedAt: T0 + HOUR,
    }
    const remote = { notes: 'x', notesUpdatedAt: T0, markedTimestamps: [1500], marksUpdatedAt: T0 }
    const merged = mergeLectureAnnotations(local, remote)
    expect(merged.markedTimestamps).toEqual([1500, 42000])
    expect(merged.marksWinner).toBe('local')
  })

  it('a missing clock never wins — the same rule the title merge uses', () => {
    const local = { notes: 'kept', notesUpdatedAt: undefined, markedTimestamps: [], marksUpdatedAt: undefined }
    const remote = { notes: 'also real', notesUpdatedAt: T0, markedTimestamps: [1], marksUpdatedAt: T0 }
    const merged = mergeLectureAnnotations(local, remote)
    // Remote HAS a clock and local does not, so remote wins here — this proves
    // the function reads the clock rather than defaulting blindly to local.
    expect(merged.notesWinner).toBe('remote')
  })

  it('local wins outright when NEITHER side has a clock', () => {
    const local = { notes: 'local text', notesUpdatedAt: null, markedTimestamps: [1], marksUpdatedAt: null }
    const remote = { notes: 'remote text', notesUpdatedAt: null, markedTimestamps: [2], marksUpdatedAt: null }
    const merged = mergeLectureAnnotations(local, remote)
    expect(merged.notes).toBe('local text')
    expect(merged.markedTimestamps).toEqual([1])
  })

  it('an unrelated title/transcript/summary change cannot appear in the result at all', () => {
    // The function's own input type has no such fields — this is enforced at
    // the type level, and this test documents that as the contract.
    const merged = mergeLectureAnnotations(
      { notes: 'a', notesUpdatedAt: T0, markedTimestamps: [], marksUpdatedAt: T0 },
      { notes: 'b', notesUpdatedAt: T0 - 1, markedTimestamps: [], marksUpdatedAt: T0 - 1 },
    )
    expect(Object.keys(merged).sort()).toEqual(
      ['markedTimestamps', 'marksUpdatedAt', 'marksWinner', 'notes', 'notesUpdatedAt', 'notesWinner'].sort(),
    )
  })
})

describe('reconcileLectureAnnotations — across a refreshed library', () => {
  const row = (
    id: string,
    notes: string,
    notesUpdatedAt: number,
    marks: number[],
    marksUpdatedAt: number,
  ) => ({ id, notes, notesUpdatedAt, markedTimestamps: marks, marksUpdatedAt })

  it('an unsaved-but-just-confirmed local edit survives a row read before it landed', () => {
    const merged = reconcileLectureAnnotations(
      [row('r1', 'just saved', 2_000, [1500], 1_000)],
      [row('r1', 'stale', 1_000, [1500], 1_000)],
    )
    expect(merged[0].notes).toBe('just saved')
  })

  it('a genuinely newer remote Mark (added on iPad) is adopted', () => {
    const merged = reconcileLectureAnnotations(
      [row('r1', 'x', 1_000, [1500], 1_000)],
      [row('r1', 'x', 1_000, [1500, 42000], 2_000)],
    )
    expect(merged[0].markedTimestamps).toEqual([1500, 42000])
  })

  it('rows never seen before pass through untouched', () => {
    const incoming = [row('new', 'fresh', 5, [], 5)]
    expect(reconcileLectureAnnotations([], incoming)[0]).toBe(incoming[0])
  })

  it('a row missing from the refresh is not re-added — deletion is a separate contract', () => {
    expect(reconcileLectureAnnotations([row('gone', 'x', 1, [], 1)], [])).toEqual([])
  })

  it('is identity-stable when both fields already agree', () => {
    const remote = [row('r1', 'same', 1_000, [1500], 1_000)]
    const merged = reconcileLectureAnnotations([row('r1', 'same', 1_000, [1500], 1_000)], remote)
    expect(merged[0]).toBe(remote[0])
  })
})

/* ── Call-site wiring ─────────────────────────────────────────────────────── */

function codeOnly(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

describe('the app reconciles Notes/Marks the same way it reconciles titles', () => {
  const app = codeOnly('../App.tsx')

  it('every refresh runs both reconciliations, title then annotations', () => {
    const titleAt = app.indexOf('reconcileLectureTitles(recordingsRef.current, list)')
    const annotationsAt = app.indexOf('reconcileLectureAnnotations(recordingsRef.current, list)')
    expect(titleAt).toBeGreaterThan(-1)
    expect(annotationsAt).toBeGreaterThan(titleAt)
  })

  it('the repository read path maps notes/marks and their clocks — proven at the type level', () => {
    const repo = codeOnly('./recordingsRepo.ts')
    expect(repo).toContain("notes: r.notes ?? undefined")
    expect(repo).toContain('markedTimestamps: Array.isArray(r.marked_timestamps) ? r.marked_timestamps : undefined')
    expect(repo).toContain('notesUpdatedAt: r.notes_updated_at')
    expect(repo).toContain('marksUpdatedAt: r.marks_updated_at')
  })
})
