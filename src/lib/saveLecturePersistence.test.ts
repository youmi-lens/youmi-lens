import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { lectureRecordingInsertPayload } from './recordingsRepo'

/**
 * Save Lecture persistence — regression guards for a real Owner QA blocker:
 * Stop & Save appeared to do nothing, in both an existing-Course and a
 * brand-new-Course scenario, with no visible failure state.
 *
 * Root cause was environmental, not architectural: the qa-staging build never
 * overrode `VITE_API_BASE_URL`, so it silently inherited PRODUCTION's Railway
 * URL from `.env` (see `.env.qa.local`, `vite.config.ts`). The client
 * authenticated with a STAGING-signed JWT and sent it to the PRODUCTION API
 * server, which verifies tokens against PRODUCTION Supabase's own secret —
 * every upload failed auth immediately, before course linkage or
 * transcription ever ran, identically regardless of which course was
 * selected. Two compounding bugs made the failure invisible: the server never
 * persisted `course_id` at all, and the local pending-upload safety net was
 * classified as a soft `list_refresh_warn` — the same terminal stage as a
 * genuine success — with no live Retry action.
 *
 * These are static source guards (this codebase's established pattern for
 * pinning a real async handler's shape — see coursesV2FixGate.test.ts,
 * longRecordingSave.test.ts) plus pure-function coverage where extractable.
 */

const appSrc = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const uploadAudioSrc = readFileSync(new URL('../../server/uploadAudio.mjs', import.meta.url), 'utf8')
const viteConfigSrc = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8')

describe('1 · existing course → lecture saves with the canonical course id', () => {
  it('the main upload call sends the course id captured by the durable recording session', () => {
    expect(appSrc).toMatch(
      /uploadLectureAudioViaServer\(supabase!, recordingId, blob, mime, durationSec, \{\s*course: courseVal,\s*courseId: saveCourseId,/,
    )
  })

  it('the server persists course_id from the request instead of dropping it', () => {
    expect(uploadAudioSrc).toContain("course_id: rawCourseId")
    expect(uploadAudioSrc).toMatch(/const courseId = nullableText\(rawCourseId\)/)
    expect(uploadAudioSrc).toMatch(/course_id: courseId,/)
  })

  it('lectureRecordingInsertPayload (the client-side fallback insert) writes course_id from the canonical id, never from the name', () => {
    const payload = lectureRecordingInsertPayload({
      id: 'r1',
      userId: 'u1',
      course: 'Stale Display Name',
      courseId: 'course-uuid-real',
      title: 't',
      durationSec: 1,
      mime: 'audio/webm',
      storagePath: 'p',
      liveTranscript: '',
      liveTranscriptRaw: '',
    })
    expect(payload).toMatchObject({ course_id: 'course-uuid-real' })
  })
})

describe('2 · a newly created course → the save uses that new course id', () => {
  it('creating a course sets both the display state and the canonical id together, from the created row', () => {
    expect(appSrc).toMatch(/setCourse\(created\.name\)/)
    expect(appSrc).toMatch(/setRecordingCourseId\(created\.id\)/)
  })

  it('handleStopAndSave reads recordingCourseId live at save time (React state), not a value captured at record-start', () => {
    // A plain function body (not a stale useCallback closure) reading current
    // component state — so a course created mid-session is used on save.
    expect(appSrc).toMatch(/const handleStopAndSave = async \(\) => \{/)
  })
})

describe('3 · transcription unavailable → the lecture still saves successfully', () => {
  it('the AI hand-over after a successful retry-upload is fire-and-forget and durable, so it can never fail the save', () => {
    // It used to be a single awaited attempt whose failure was swallowed in a bare
    // catch — and then nothing would ever process the lecture. It now records a
    // durable intent and retries itself (see processingIntents / lectureProcessing).
    expect(appSrc).toMatch(/await deletePendingUpload\(id\)\s*\n(?:\s*\/\/.*\n)*\s*void startProcessingRef\.current\(id\)/)
    expect(appSrc).not.toMatch(/if \(tok\) await requestHostedRecordingAi/)
  })

  it('no save-success path is gated on a transcription/summary API call succeeding first', () => {
    // The durable row/list-refresh success signal never awaits a transcribe call.
    expect(appSrc).not.toMatch(/await\s+(transcribe|requestHostedRecordingAi)[\s\S]{0,80}endCapture\(\{\s*kind: 'success'/)
  })
})

describe('4 · downstream processing failure leaves the lecture durably saved', () => {
  it('the durable local-session cleanup after a successful save is itself best-effort, never able to undo the save', () => {
    expect(appSrc).toContain('void completeRecordingSessionPersist(recordingId).catch(() => { /* best-effort */ })')
  })

  it('a pending-upload retry drops the local fallback copy only after cloud persistence is confirmed, and hands over separately', () => {
    const retry = appSrc.slice(appSrc.indexOf('const handleRetryPendingUpload'), appSrc.indexOf('const handleDeletePendingUpload'))
    expect(retry.indexOf('await deletePendingUpload(id)')).toBeGreaterThan(retry.indexOf('insertLectureRecordingRow('))
    expect(retry.indexOf('void startProcessingRef.current(id)')).toBeGreaterThan(retry.indexOf('await deletePendingUpload(id)'))
  })
})

describe('5 · a save that only reaches local pending-upload is a visible, recoverable failure — never a silent success', () => {
  it('is classified as an actionable failure outcome, not the success-equivalent list_refresh_warn', () => {
    expect(appSrc).toContain("outcome: 'pending_upload'")
  })

  it('the pending-upload save always carries the canonical course id forward, so a later retry cannot lose it', () => {
    expect(appSrc).toMatch(/savePendingUpload\(\{\s*id: recordingId,\s*userId: userId!,\s*course: courseVal,\s*courseId: saveCourseId,/)
  })

  it('a recovered crash recording enters the same canonical course-aware upload and insert path', () => {
    const recovery = appSrc.slice(
      appSrc.indexOf('const handleRecoverSave = useCallback('),
      appSrc.indexOf('const handleRecoverKeep = useCallback('),
    )
    expect(recovery).toContain('const recoveryCourseId = fresh.courseId')
    expect(recovery).toMatch(/uploadLectureAudioViaServer\(supabase, recordingId, blob, mime, durationSec, \{\s*course: courseVal,\s*[\s\S]*?courseId: recoveryCourseId,/)
    expect(recovery).toMatch(/insertLectureRecordingRow\(\{\s*[\s\S]*?course: courseVal,\s*courseId: recoveryCourseId,/)
    expect(recovery).toContain("Choose a course before saving this recovered recording")
    expect(recovery.indexOf('if (!fresh.courseId)')).toBeLessThan(recovery.indexOf('beginFinalizeRecordingSession(fresh.id)'))
  })

  it('re-reads the durable session instead of trusting the closure argument, so a just-assigned course is never missed', () => {
    // Owner QA evidence: recovered lectures landed with course_id: null in
    // the database despite showing a real-looking course text label —
    // consistent with `handleRecoverSave` using a `session` argument that
    // was stale relative to the durable record (e.g. captured a render
    // before a course assignment committed). Re-fetching fresh from
    // IndexedDB removes that class of staleness entirely.
    const recovery = appSrc.slice(
      appSrc.indexOf('const handleRecoverSave = useCallback('),
      appSrc.indexOf('const handleRecoverKeep = useCallback('),
    )
    expect(recovery).toContain('const fresh = await getRecordingSession(session.id)')
    expect(recovery.indexOf('const fresh = await getRecordingSession')).toBeLessThan(
      recovery.indexOf('if (!fresh.courseId)'),
    )
  })

  it('derives a heartbeat-independent duration floor from chunk count, so a quick crash never reports ~0s', () => {
    // Owner QA evidence: two recovered lectures both stored duration_sec: 0
    // despite containing real, multi-chunk audio — the 15s heartbeat never
    // got a chance to fire before the crash. chunkCount * checkpoint
    // interval is always at least as accurate as the last heartbeat.
    const recovery = appSrc.slice(
      appSrc.indexOf('const handleRecoverSave = useCallback('),
      appSrc.indexOf('const handleRecoverKeep = useCallback('),
    )
    expect(recovery).toMatch(
      /const durationSec = Math\.max\(\s*fresh\.approxDurationSec \|\| 0,\s*Math\.round\(\(fresh\.chunkCount \* MAIN_RECORDER_REQUEST_DATA_MS\) \/ 1000\),\s*\)/,
    )
  })

  it('retry reuses the exact same recording id — idempotent insert, never a duplicate lecture', () => {
    expect(appSrc).toContain('handleRetryPendingUpload')
    expect(appSrc).toMatch(/uploadLectureAudioViaServer\(supabase, id, rec\.audioBlob, rec\.mime, rec\.durationSec, \{\s*course: rec\.course,\s*courseId: rec\.courseId/)
    expect(appSrc).toContain('await deletePendingUpload(id)')
  })

  it('the terminal screen retry action re-attempts the pending upload instead of only dismissing the message', () => {
    expect(appSrc).toMatch(
      /if \(recentCapture\?\.kind === 'failure' && recentCapture\.outcome === 'pending_upload'\)/,
    )
    expect(appSrc).toMatch(/if \(recordingId\) void handleRetryPendingUpload\(recordingId\)/)
  })

  it('no raw backend error text reaches the pending-upload failure message', () => {
    const match = appSrc.match(
      /outcome: 'pending_upload',\s*\n\s*message:\s*\n\s*'([^']+)'/,
    )
    expect(match).not.toBeNull()
    const message = match![1]
    expect(message).not.toMatch(/HTTP \d|SaveRecordingRemoteError|stack|Error:/)
  })
})

describe('6 · a repeated Save click while one is already in flight is guarded', () => {
  it('handleStopAndSave bails out immediately if a save is already in progress', () => {
    expect(appSrc).toMatch(/const handleStopAndSave = async \(\) => \{\s*\n\s*if \(saveInFlightRef\.current\) return/)
  })
})

describe('7 · a successful save is reflected in Recent Lectures / the Course list', () => {
  it('the list is refreshed before the save is reported as successful', () => {
    expect(appSrc).toMatch(/await withTimeout\(refreshList\(\), SAVE_LIST_TIMEOUT_MS, 'Refresh recording list'\)/)
  })
})

describe('8 · a stale display name never wins over a valid canonical course id', () => {
  it('the qa-staging build guard refuses a build that would repeat this exact class of bug', () => {
    // The build-time guard added alongside this fix: qa mode must never
    // silently resolve VITE_API_BASE_URL to production, the same way it
    // already refuses a production VITE_SUPABASE_URL.
    expect(viteConfigSrc).toContain('PRODUCTION_API_BASE_URL')
    expect(viteConfigSrc).toMatch(/apiBase\.includes\(PRODUCTION_API_BASE_URL\)/)
  })
})
