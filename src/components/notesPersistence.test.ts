import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LectureDetailPage } from './LectureDetailPage'
import { translateDesktop } from '../lib/desktopI18n'
import { CloudAnnotationsUnavailableError, isNotesUnavailable } from '../lib/lectureNotes'
import { updateRecordingNotesMarks } from '../lib/recordingsRepo'
import type { Recording } from '../types'

/**
 * Round 5 — Notes. Production has no `notes` column (verified read-only against
 * lbwsrnjbiayepshrdult: `column recordings.notes does not exist`; staging has it).
 * These pin the repository's reading of that error, the editor's states, and the App
 * wiring that keeps an unsaved note alive across leaving, reopening and relaunching.
 */

const t = (key: Parameters<typeof translateDesktop>[1], vars?: Record<string, string | number>) => translateDesktop('en', key, vars)
const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const page = readFileSync(new URL('./LectureDetailPage.tsx', import.meta.url), 'utf8')

/* ── The repository: how a missing column is read ───────────────────────── */

function fakeClient(result: { error: unknown }) {
  const calls: Array<{ payload: unknown; eq: Array<[string, unknown]> }> = []
  const client = {
    from: (table: string) => {
      expect(table).toBe('recordings')
      return {
        update: (payload: unknown) => {
          const rec = { payload, eq: [] as Array<[string, unknown]> }
          calls.push(rec)
          const chain = {
            eq: (col: string, val: unknown) => {
              rec.eq.push([col, val])
              return rec.eq.length < 2 ? chain : Promise.resolve(result)
            },
          }
          return chain
        },
      }
    },
  }
  return { client: client as never, calls }
}

describe('updateRecordingNotesMarks — what the database said', () => {
  const iso = '2026-10-04T21:20:00.000Z'

  it('sends the note and the EDIT-time clock for exactly this lecture and user', async () => {
    const { client, calls } = fakeClient({ error: null })
    await updateRecordingNotesMarks(client, 'u1', 'rec-1', { notes: 'Ss' }, iso)
    expect(calls).toEqual([{ payload: { notes: 'Ss', notes_updated_at: iso }, eq: [['id', 'rec-1'], ['user_id', 'u1']] }])
  })

  it.each([
    ['PostgREST schema cache (the production error)', { code: 'PGRST204', message: "Could not find the 'notes' column of 'recordings' in the schema cache" }],
    ['Postgres undefined column', { code: '42703', message: 'column recordings.notes does not exist' }],
  ])('a missing column (%s) becomes the typed "unavailable" error', async (_name, error) => {
    const { client } = fakeClient({ error })
    await expect(updateRecordingNotesMarks(client, 'u1', 'rec-1', { notes: 'Ss' }, iso)).rejects.toBeInstanceOf(
      CloudAnnotationsUnavailableError,
    )
  })

  it('a missing Marks column is the same typed error', async () => {
    const { client } = fakeClient({ error: { code: '42703', message: 'column recordings.marked_timestamps does not exist' } })
    await expect(updateRecordingNotesMarks(client, 'u1', 'rec-1', { markedTimestamps: [1] }, iso)).rejects.toBeInstanceOf(
      CloudAnnotationsUnavailableError,
    )
  })

  it('any OTHER failure is rethrown untouched, so a flaky network still reads as "try again"', async () => {
    const boom = { code: '57014', message: 'canceling statement due to statement timeout' }
    const { client } = fakeClient({ error: boom })
    await expect(updateRecordingNotesMarks(client, 'u1', 'rec-1', { notes: 'Ss' }, iso)).rejects.toBe(boom)
    expect(isNotesUnavailable(boom)).toBe(false)
  })

  it('an empty patch writes nothing', async () => {
    const { client, calls } = fakeClient({ error: null })
    await updateRecordingNotesMarks(client, 'u1', 'rec-1', {}, iso)
    expect(calls).toEqual([])
  })
})

/* ── The editor ─────────────────────────────────────────────────────────── */

const recording: Recording = {
  id: 'r1',
  course: 'test',
  title: 'Lecture Oct 4, 2026 at 5:12 PM',
  createdAt: 0,
  durationSec: 62,
  mime: 'audio/webm',
  storagePath: 'u1/r1.webm',
  aiStatus: 'done',
  transcript: 'T',
  summaryEn: '## S\nx',
}
const baseProps = {
  t,
  recording,
  detail: null,
  course: null,
  audioUrl: null,
  languageLine: 'English → Chinese',
  formatDate: (ms: number) => String(ms),
  formatDuration: (s: number) => `${s}s`,
  onBack: () => undefined,
  backLabel: 'Courses',
  onRename: () => undefined,
  onMove: () => undefined,
  onDelete: () => undefined,
  actionsDisabled: false,
  onSaveNotes: async () => undefined,
  onAddMark: async () => undefined,
  annotationsEditable: true,
  initialTab: 'notes' as const,
}
function notesPage(extra: Partial<Parameters<typeof LectureDetailPage>[0]> = {}): string {
  return renderToStaticMarkup(createElement(LectureDetailPage, { ...baseProps, ...extra }))
}
const textareaValue = (html: string) => html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)?.[1] ?? null

describe('the Notes editor opens with the right text', () => {
  it('shows the cloud note when there is no draft', () => {
    const html = notesPage({ recording: { ...recording, notes: 'saved note' } })
    expect(textareaValue(html)).toBe('saved note')
    expect(html).not.toContain('Unsaved changes from earlier')
  })

  it('brings back an unsaved draft from an earlier visit — and says so, with Save and Discard', () => {
    const html = notesPage({ initialNotes: 'Ss', notesRestored: true })
    expect(textareaValue(html)).toBe('Ss')
    expect(html).toContain('Unsaved changes from earlier are back. Save to keep them.')
    expect(html).toContain('Save notes')
    expect(html).toContain('Discard changes')
  })

  it('a restored draft is dirty, so Save is enabled — it was never saved', () => {
    const html = notesPage({ initialNotes: 'Ss', notesRestored: true })
    expect(html).toMatch(/<button[^>]*class="v2-btn v2-btn--record"[^>]*>Save notes<\/button>/)
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Save notes/)
  })

  it('with the draft equal to the cloud note there is nothing unsaved to discard', () => {
    const html = notesPage({ recording: { ...recording, notes: 'same' }, initialNotes: 'same' })
    expect(html).not.toContain('Discard changes')
    expect(html).toMatch(/disabled=""[^>]*>Save notes/)
  })
})

describe('the editor source: nothing silently discards, failures are told apart', () => {
  it('every keystroke is written ahead, before any network', () => {
    expect(page).toContain('onNotesDraftChange?.(value)')
  })

  it('Discard is the only thing that tells the owner to drop the draft', () => {
    expect(page.match(/onNotesDiscard\?\.\(\)/g)).toHaveLength(1)
    const at = page.indexOf('onNotesDiscard?.()')
    expect(page.slice(at - 260, at)).toContain('The only thing that throws a draft away')
  })

  it('leaving with unsaved text hands it to the owner to push, via the latest values', () => {
    expect(page).toContain('leave.current = { dirty: draft !== storedNotes, onNotesLeave }')
    expect(page).toMatch(/if \(leave\.current\.dirty\) leave\.current\.onNotesLeave\?\.\(\)/)
  })

  it('a first mount does not clobber the restored draft', () => {
    expect(page).toContain('if (seededFor.current === recording.id) return')
  })

  it('the schema gap and a flaky network get different words; neither clears the text', () => {
    expect(page).toContain("setNotesState(isNotesUnavailable(err) ? 'unavailable' : 'failed')")
    const en = (k: Parameters<typeof translateDesktop>[1]) => translateDesktop('en', k)
    expect(en('lecture.notesSaveFailed')).toContain('still here')
    expect(en('lecture.notesUnavailable')).toContain('kept on this Mac')
    expect(en('lecture.notesUnavailable')).not.toMatch(/try again/i)
  })
})

/* ── App wiring ─────────────────────────────────────────────────────────── */

function slice(from: string, to: string): string {
  const a = app.indexOf(from)
  const b = app.indexOf(to, a + from.length)
  expect(a, from).toBeGreaterThan(-1)
  expect(b, to).toBeGreaterThan(a)
  return app.slice(a, b)
}

describe('App: one persistence model — cloud authority, local write-ahead draft', () => {
  const notesBlock = slice('const notesSaver = useMemo(', "Append one mark to the open lecture's")

  it('the cloud write carries the draft’s EDIT time as notes_updated_at', () => {
    expect(notesBlock).toContain('new Date(editedAt).toISOString()')
    expect(notesBlock).toContain('updateRecordingNotesMarks(supabase, userId, recordingId, { notes: text }')
  })

  it('save writes ahead FIRST, then goes through the ordered saver', () => {
    const fn = slice('const saveLectureNotes = useCallback(', 'const recordingsLoaded')
    expect(fn.indexOf('notesSaver.edit(recordingId, notes)')).toBeLessThan(fn.indexOf('notesSaver.save(recordingId)'))
  })

  it('a failed save rethrows (so the editor shows it) and applies nothing to the list', () => {
    const fn = slice('const saveLectureNotes = useCallback(', 'const recordingsLoaded')
    expect(fn.indexOf("if (out.kind === 'failed') throw out.error")).toBeLessThan(fn.indexOf('setRecordings('))
  })

  it('a completion is applied to ITS lecture only, and never over a newer local note', () => {
    const fn = slice('const saveLectureNotes = useCallback(', 'const recordingsLoaded')
    expect(fn).toContain('r.id === recordingId && !((r.notesUpdatedAt ?? 0) > out.editedAt)')
  })

  it('the editor is keyed by lecture, so one lecture’s draft and save state can never reach another', () => {
    expect(app).toMatch(/<LectureDetailPage\s+key=\{openLecture\.id\}/)
  })

  it('opening resolves draft vs cloud with the pure rule, recomputed on every open', () => {
    const open = slice('const notesOpen = useMemo(', 'A draft that is moot')
    expect(open).toContain('resolveNotesForOpen({')
    expect(open).toContain('notesSaver.draft(selectedId)')
    expect(open).toContain('detailRetryNonce')
  })

  it('the editor is fed the restored draft, the write-ahead hook, Discard and the leave push', () => {
    expect(app).toContain('initialNotes={notesOpen?.text}')
    expect(app).toContain('notesRestored={notesOpen?.restored ?? false}')
    expect(app).toContain('onNotesDraftChange={(text) => notesSaver?.edit(openLecture.id, text)}')
    expect(app).toContain('onNotesDiscard={() => notesSaver?.discard(openLecture.id)}')
    expect(app).toContain('onNotesLeave={() => {')
  })

  it('relaunch: unsaved drafts are pushed in the background — once, never the open lecture, never discarding', () => {
    const effect = slice('const notesSyncAttemptedRef = useRef(new Set<string>())', '/**\n   * Append one mark')
    expect(effect).toContain('for (const id of notesSaver.pending())')
    expect(effect).toContain('if (id === selectedId) continue')
    expect(effect).toContain('notesSyncAttemptedRef.current.has(id)')
    expect(effect).toContain('notesSaver.settle(id)')
    // The only removals are `settle` (moot) — never a bare discard, never on failure.
    expect(effect).not.toContain('notesSaver.discard')
  })

  it('processing, transcript and summary code paths are not part of the Notes block', () => {
    expect(notesBlock).not.toMatch(/startHostedProcessing|processingRequester|getProcessingStatuses|transcript|summary/i)
  })
})
