/**
 * Title integrity — regression guards for the P0 incident.
 *
 * The incident, exactly:
 *   local  title = a real name the user typed,  titleUpdatedAt = months ago
 *   remote title = "Untitled lecture",          updated_at     = migration time
 *
 * The old merge compared timestamps FIRST, so the newer placeholder won and the
 * real name was overwritten in local storage. Every test below is written so it
 * fails against that behaviour.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildLectureMetadataPatch,
  classifyLectureTitle,
  isMeaningfulLectureTitle,
  LECTURE_TITLE_PLACEHOLDERS,
  mergeLectureTitle,
  reconcileLectureTitles,
  titleForPersist,
} from './lectureTitleIntegrity'

/** Months before the Phase 1B migration — a real rename. */
const OLD_EDIT = '2026-03-14T09:00:00.000Z'
/** The instant `add column ... default now()` stamped every existing row. */
const MIGRATION_STAMP = '2026-08-05T06:40:00.000Z'

describe('classification', () => {
  it('a real name is meaningful', () => {
    expect(classifyLectureTitle('Python — Week 3 loops')).toBe('meaningful')
    expect(isMeaningfulLectureTitle('Python — Week 3 loops')).toBe(true)
  })

  it('every shipped placeholder is recognised, case- and space-insensitively', () => {
    for (const p of LECTURE_TITLE_PLACEHOLDERS) {
      expect(classifyLectureTitle(p), p).toBe('placeholder')
      expect(classifyLectureTitle(`  ${p.toUpperCase()}  `), p).toBe('placeholder')
    }
  })

  it('covers the exact strings the two apps render', () => {
    // Desktop i18n `recording.untitled`, and iPad's title-cased variant.
    for (const s of ['Untitled lecture', 'Untitled Lecture', 'untitled', '未命名讲次', '제목 없는 강의']) {
      expect(classifyLectureTitle(s), s).toBe('placeholder')
    }
  })

  it('empty and whitespace are empty, not meaningful', () => {
    for (const s of ['', '   ', '\n\t', null, undefined]) {
      expect(classifyLectureTitle(s)).toBe('empty')
    }
  })

  it('a name that merely contains "untitled" is still meaningful', () => {
    // Substring matching would eat a real title. Only exact matches count.
    expect(classifyLectureTitle('Untitled works of Kafka')).toBe('meaningful')
    expect(classifyLectureTitle('Lecture 4 — untitled poems')).toBe('meaningful')
  })
})

describe('THE INCIDENT · merge rules', () => {
  it('1 · a meaningful local title survives a NEWER remote placeholder', () => {
    // This is the exact scenario. It must never regress.
    const result = mergeLectureTitle(
      { title: 'Python — Week 3 loops', editedAt: OLD_EDIT },
      { title: 'Untitled lecture', editedAt: MIGRATION_STAMP },
    )
    expect(result.title).toBe('Python — Week 3 loops')
    expect(result.winner).toBe('local')
    expect(result.reason).toBe('meaningful-beats-placeholder')
  })

  it('1b · survives even when the remote stamp is years newer', () => {
    const result = mergeLectureTitle(
      { title: 'Python — Week 3 loops', editedAt: '2020-01-01T00:00:00.000Z' },
      { title: 'Untitled Lecture', editedAt: '2099-01-01T00:00:00.000Z' },
    )
    expect(result.title).toBe('Python — Week 3 loops')
  })

  it('2 · a meaningful REMOTE title beats a local placeholder', () => {
    const result = mergeLectureTitle(
      { title: 'Untitled lecture', editedAt: MIGRATION_STAMP },
      { title: 'Renamed on iPad', editedAt: OLD_EDIT },
    )
    expect(result.title).toBe('Renamed on iPad')
    expect(result.winner).toBe('remote')
  })

  it('3 · meaningful beats empty, in both directions', () => {
    expect(mergeLectureTitle({ title: 'Real name' }, { title: '' }).title).toBe('Real name')
    expect(mergeLectureTitle({ title: '   ' }, { title: 'Real name' }).title).toBe('Real name')
  })

  it('4 · two real names compare USER EDIT timestamps', () => {
    const older = { title: 'First name', editedAt: '2026-01-01T00:00:00.000Z' }
    const newer = { title: 'Second name', editedAt: '2026-06-01T00:00:00.000Z' }
    expect(mergeLectureTitle(older, newer).title).toBe('Second name')
    expect(mergeLectureTitle(newer, older).title).toBe('Second name')
  })

  it('5 · placeholder vs placeholder may follow the clock', () => {
    const result = mergeLectureTitle(
      { title: 'Untitled', editedAt: OLD_EDIT },
      { title: 'Untitled lecture', editedAt: MIGRATION_STAMP },
    )
    expect(result.title).toBe('Untitled lecture')
  })

  it('6 · a MISSING timestamp never discards a meaningful title', () => {
    expect(mergeLectureTitle({ title: 'Kept' }, { title: 'Also real' }).title).toBe('Kept')
    expect(
      mergeLectureTitle({ title: 'Kept', editedAt: OLD_EDIT }, { title: 'Also real' }).title,
    ).toBe('Kept')
    // And the pre-migration shape: remote had no usable timestamp at all.
    expect(mergeLectureTitle({ title: 'Kept', editedAt: OLD_EDIT }, { title: '' }).title).toBe('Kept')
  })

  it('7 · a migration timestamp can never promote a placeholder', () => {
    // Simulates the whole table being stamped at once.
    for (const name of ['CS 101 Lecture 1', 'Python 基础', 'Séance 4']) {
      const r = mergeLectureTitle(
        { title: name, editedAt: OLD_EDIT },
        { title: 'Untitled lecture', editedAt: MIGRATION_STAMP },
      )
      expect(r.title, name).toBe(name)
    }
  })

  it('both empty yields empty, for the render layer to fall back over', () => {
    expect(mergeLectureTitle({ title: '' }, { title: null }).title).toBe('')
  })

  it('is stable: merging twice changes nothing', () => {
    const first = mergeLectureTitle(
      { title: 'Stable name', editedAt: OLD_EDIT },
      { title: 'Untitled lecture', editedAt: MIGRATION_STAMP },
    )
    const second = mergeLectureTitle(
      { title: first.title, editedAt: OLD_EDIT },
      { title: 'Untitled lecture', editedAt: MIGRATION_STAMP },
    )
    expect(second.title).toBe(first.title)
  })
})

describe('write safety', () => {
  it('a placeholder is never persisted', () => {
    expect(titleForPersist('Untitled lecture')).toBeUndefined()
    expect(titleForPersist('  untitled  ')).toBeUndefined()
    expect(titleForPersist('')).toBeUndefined()
    expect(titleForPersist(null)).toBeUndefined()
    expect(titleForPersist('未命名讲次')).toBeUndefined()
  })

  it('a real name is persisted, trimmed', () => {
    expect(titleForPersist('  Week 3 loops  ')).toBe('Week 3 loops')
  })

  it('a patch omits title entirely when it was not supplied', () => {
    const patch = buildLectureMetadataPatch({ course: 'CS 101' })
    expect(patch).toEqual({ course: 'CS 101' })
    expect('title' in patch).toBe(false)
  })

  it('MOVE writes only course fields — never title', () => {
    const patch = buildLectureMetadataPatch({ course: 'Math 210', courseId: 'c-2' })
    expect(patch).toEqual({ course: 'Math 210', course_id: 'c-2' })
    expect('title' in patch).toBe(false)
  })

  it('assigning course_id alone writes only course_id', () => {
    expect(buildLectureMetadataPatch({ courseId: 'c-9' })).toEqual({ course_id: 'c-9' })
  })

  it('a display fallback passed by mistake is dropped, not written', () => {
    const patch = buildLectureMetadataPatch({ title: 'Untitled lecture', course: 'CS 101' })
    expect('title' in patch).toBe(false)
    expect(patch.course).toBe('CS 101')
  })

  it('an explicit rename does write title', () => {
    expect(buildLectureMetadataPatch({ title: 'Week 3 loops' }).title).toBe('Week 3 loops')
  })

  it('Unfiled moves are expressible without touching title', () => {
    expect(buildLectureMetadataPatch({ course: 'Unfiled', courseId: null })).toEqual({
      course: 'Unfiled',
      course_id: null,
    })
  })
})

describe('call sites honour the guards', () => {
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
  const repo = readFileSync(new URL('./recordingsRepo.ts', import.meta.url), 'utf8')
  const db = readFileSync(new URL('./db.ts', import.meta.url), 'utf8')
  const coursesRepo = readFileSync(
    new URL('./courses/supabaseCoursesRepository.ts', import.meta.url),
    'utf8',
  )

  it('the metadata update is a PATCH with both fields optional', () => {
    expect(repo).toContain('patch: { course?: string; title?: string }')
    expect(repo).toContain('buildLectureMetadataPatch(patch)')
    // The old mandatory-both signature is what forced callers to invent a title.
    expect(repo).not.toContain('patch: { course: string; title: string }')
  })

  it('the local store refuses to overwrite a name with a placeholder', () => {
    expect(db).toContain("if ('title' in patch && titleForPersist(patch.title) === undefined)")
    expect(db).toContain('next.title = existing.title')
  })

  it('Rename sends title ONLY', () => {
    const fn = app.slice(
      app.indexOf('const renameLecture = useCallback('),
      app.indexOf('const moveLectureToCourse = useCallback('),
    )
    expect(fn).toContain('{ title: next }')
    expect(fn).toContain('isMeaningfulLectureTitle(next)')
    // No course in the payload: a rename must not be able to move a lecture.
    expect(fn).not.toContain('course,')
  })

  it('Move goes through the course repository and sends no title', () => {
    const fn = app.slice(
      app.indexOf('const moveLectureToCourse = useCallback('),
      app.indexOf('const deleteFolderIfEmpty ='),
    )
    expect(fn).toContain('coursesState.assignLecture(recordingId, courseId)')
    expect(fn).not.toContain('title:')
  })

  it('assignLecture writes course_id + course, never title', () => {
    const fn = coursesRepo.slice(coursesRepo.indexOf('async assignLecture('))
    expect(fn).toContain('course_id:')
    expect(fn).toContain('course: label')
    expect(fn).not.toContain('title')
  })

  it('Course rename propagates the label only', () => {
    const fn = coursesRepo.slice(
      coursesRepo.indexOf('async function syncLegacyLabel('),
      coursesRepo.indexOf('return {'),
    )
    expect(fn).toContain('.update({ course: name')
    expect(fn).not.toContain('title')
  })

  it('the legacy edit modal no longer generates a dated fallback name', () => {
    expect(app).not.toContain('`Lecture ${formatDate(existing.createdAt)}`')
    expect(app).toContain('isMeaningfulLectureTitle(titleTrim) ? titleTrim : undefined')
  })

  it('no Phase 1B SQL statement writes title', () => {
    for (const file of [
      'supabase-phase1b-courses-01-migration.sql',
      'supabase-phase1b-courses-03-backfill.sql',
      'supabase-phase1b-courses-99-rollback.sql',
    ]) {
      const sql = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
        // Strip comments; several of them discuss title precisely to record that
        // it is never touched.
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
      expect(sql.toLowerCase(), file).not.toMatch(/set\s+[^;]*\btitle\b/)
      expect(sql.toLowerCase(), file).not.toMatch(/update[^;]*\btitle\s*=/)
    }
  })
})

/* ── Freshness clock ────────────────────────────────────────────────────────
   The guards above stop Desktop LOSING a title. They do not make a Desktop
   rename legible to another device: without `title_updated_at` there is nothing
   to order two competing renames by, so the other side falls back to "keep
   local" and this rename is silently invisible. */

describe('rename stamps the freshness clock', () => {
  const NOW = '2026-08-11T10:00:00.000Z'

  it('an explicit rename writes title AND title_updated_at', () => {
    expect(buildLectureMetadataPatch({ title: 'Week 3 loops' }, NOW)).toEqual({
      title: 'Week 3 loops',
      title_updated_at: NOW,
    })
  })

  it('the clock is stamped in the SAME update as the name', () => {
    // Two statements could interleave with another device's rename and leave a
    // name stamped with someone else's time.
    const patch = buildLectureMetadataPatch({ title: 'Week 3 loops' }, NOW)
    expect(Object.keys(patch).sort()).toEqual(['title', 'title_updated_at'])
  })

  it('a refused placeholder rename stamps nothing', () => {
    // No name was written, so nothing became fresher.
    for (const bad of ['Untitled lecture', '  ', '未命名讲次']) {
      expect(buildLectureMetadataPatch({ title: bad }, NOW)).toEqual({})
    }
  })

  it('MOVE never writes title and never advances title freshness', () => {
    const patch = buildLectureMetadataPatch({ course: 'Math 210', courseId: 'c-2' }, NOW)
    expect(patch).toEqual({ course: 'Math 210', course_id: 'c-2' })
    expect('title_updated_at' in patch).toBe(false)
  })

  it('assigning course_id alone advances nothing', () => {
    expect(buildLectureMetadataPatch({ courseId: 'c-9' }, NOW)).toEqual({ course_id: 'c-9' })
  })

  it('a rename that is also a move stamps once, for the title only', () => {
    expect(buildLectureMetadataPatch({ title: 'Week 4', course: 'CS 101' }, NOW)).toEqual({
      title: 'Week 4',
      title_updated_at: NOW,
      course: 'CS 101',
    })
  })
})

describe('unrelated writes cannot touch title freshness', () => {
  const repo = readFileSync(new URL('./recordingsRepo.ts', import.meta.url), 'utf8')

  // Comments stripped before slicing: several of these functions discuss title
  // precisely to record that they never write it, and the assertion is about
  // the CODE.
  const code = repo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  const body = (name: string) => {
    const start = code.indexOf(`export async function ${name}(`)
    expect(start, name).toBeGreaterThan(-1)
    const next = code.indexOf('\nexport ', start + 1)
    return code.slice(start, next === -1 ? undefined : next)
  }

  it('the transcript / summary writer touches neither title nor its clock', () => {
    const fn = body('updateRecordingAi')
    expect(fn).not.toContain('title')
    for (const col of ['transcript', 'transcript_raw', 'summary_en', 'summary_zh']) {
      expect(fn, col).toContain(col)
    }
  })

  it('the notes / marks writer touches neither title nor its clock', () => {
    const fn = body('updateRecordingNotesMarks')
    expect(fn).not.toContain('title')
    expect(fn).toContain('notes_updated_at')
    expect(fn).toContain('marks_updated_at')
  })

  it('soft delete and restore touch neither title nor its clock', () => {
    for (const name of ['softDeleteRecordingRemote', 'restoreRecordingRemote']) {
      expect(body(name), name).not.toContain('title')
    }
  })

  it('title_updated_at is emitted from exactly one place', () => {
    const integrity = readFileSync(new URL('./lectureTitleIntegrity.ts', import.meta.url), 'utf8')
    expect(integrity.match(/patch\.title_updated_at = /g)?.length).toBe(1)
  })

  it('a database without the column still accepts the rename', () => {
    // The name matters more than the stamp; an unmigrated project has no
    // cross-device conflict for the stamp to resolve anyway.
    const fn = body('updateRecordingMetadata')
    expect(fn).toContain('isMissingColumn(error)')
    expect(fn).toContain('title_updated_at: _clock')
  })
})

describe('reconciling a refreshed library', () => {
  const row = (id: string, title: string, titleUpdatedAt?: number | null) => ({
    id,
    title,
    titleUpdatedAt,
  })

  it('THE INCIDENT, at the list level · a placeholder row cannot overwrite a name', () => {
    const merged = reconcileLectureTitles(
      [row('r1', 'Python — Week 3 loops', Date.parse(OLD_EDIT))],
      [row('r1', 'Untitled lecture', Date.parse(MIGRATION_STAMP))],
    )
    expect(merged[0].title).toBe('Python — Week 3 loops')
  })

  it('an in-flight local rename survives a row read before it landed', () => {
    const merged = reconcileLectureTitles(
      [row('r1', 'Renamed just now', 2_000)],
      [row('r1', 'Older name', 1_000)],
    )
    expect(merged[0].title).toBe('Renamed just now')
    // The local clock travels with it, or the next refresh would lose to its
    // own stale remote.
    expect(merged[0].titleUpdatedAt).toBe(2_000)
  })

  it('a genuinely newer remote rename wins', () => {
    const merged = reconcileLectureTitles(
      [row('r1', 'Older name', 1_000)],
      [row('r1', 'Renamed on iPad', 2_000)],
    )
    expect(merged[0].title).toBe('Renamed on iPad')
    expect(merged[0].titleUpdatedAt).toBe(2_000)
  })

  it('rows the client has never seen pass through unchanged', () => {
    const incoming = [row('new', 'Fresh lecture', 5)]
    expect(reconcileLectureTitles([], incoming)[0]).toBe(incoming[0])
    expect(reconcileLectureTitles([row('other', 'x', 1)], incoming)[0]).toBe(incoming[0])
  })

  it('a row absent from the refresh is not re-added', () => {
    // Deletion is decided by the deletion contract, never by this function.
    expect(reconcileLectureTitles([row('gone', 'Deleted elsewhere', 1)], [])).toEqual([])
  })

  it('only title is ever taken from the local side', () => {
    const local = [{ id: 'r1', title: 'Local name', titleUpdatedAt: 2_000, transcript: 'stale' }]
    const remote = [{ id: 'r1', title: 'Older', titleUpdatedAt: 1_000, transcript: 'server truth' }]
    const merged = reconcileLectureTitles(local, remote)
    expect(merged[0].title).toBe('Local name')
    // Transcript / translation / summary are server-authoritative and must come
    // back untouched — no client-side clock is invented for them.
    expect(merged[0].transcript).toBe('server truth')
  })

  it('is identity-stable when nothing changed', () => {
    const remote = [row('r1', 'Same name', 1_000)]
    const merged = reconcileLectureTitles([row('r1', 'Same name', 1_000)], remote)
    expect(merged[0]).toBe(remote[0])
  })
})
