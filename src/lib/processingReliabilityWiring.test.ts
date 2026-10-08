import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * App.tsx is one large component with no jsdom, so these pin the WIRING that
 * Round 4 (2026-10-04) depends on, in the codebase's source-shape convention. The
 * behaviour of each piece is tested where it lives: lectureLifecycle,
 * processingIntents, lectureProcessing, processingTracker, processingScreen.
 */
const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

function slice(from: string, to: string): string {
  const a = app.indexOf(from)
  const b = app.indexOf(to, a + from.length)
  expect(a, `missing "${from}"`).toBeGreaterThan(-1)
  expect(b, `missing "${to}"`).toBeGreaterThan(a)
  return app.slice(a, b)
}

describe('every save path hands the lecture over, durably', () => {
  it('Stop & Save, recovery and pending-upload retry all request processing', () => {
    const stop = slice('const handleStopAndSave = async () => {', 'const runTranscribeAndSummarize')
    const recovery = slice('const handleRecoverSave = useCallback(', 'const handleRecoverKeep = useCallback(')
    const retry = slice('const handleRetryPendingUpload', 'const handleDeletePendingUpload')
    expect(stop).toContain('startHostedProcessing(recordingId)')
    expect(recovery).toContain('startProcessingRef.current(recordingId)')
    expect(retry).toContain('startProcessingRef.current(id)')
  })

  it('recovery hands over only for hosted Youmi AI, and after the row is written', () => {
    const recovery = slice('const handleRecoverSave = useCallback(', 'const handleRecoverKeep = useCallback(')
    const at = recovery.indexOf('startProcessingRef.current(recordingId)')
    expect(recovery.slice(at - 80, at)).toContain('usesYoumiHosted()')
    expect(at).toBeGreaterThan(recovery.indexOf("'Database write (recovered)'"))
  })

  it('a hand-over failure is never allowed to fail or delay the save: nothing awaits it', () => {
    expect(app).not.toMatch(/await startHostedProcessing\(recordingId\)/)
    expect(app).not.toMatch(/await startProcessingRef\.current/)
  })
})

describe('startHostedProcessing records the intent BEFORE asking, and clears it only on acknowledgement', () => {
  const fn = slice('const startHostedProcessing = useCallback(', 'useEffect(() => {\n    startProcessingRef.current')

  it('writes the durable intent first', () => {
    expect(fn.indexOf('addProcessingIntent(userId, recordingId)')).toBeGreaterThan(-1)
    expect(fn.indexOf('addProcessingIntent(userId, recordingId)')).toBeLessThan(fn.indexOf('processingRequester.request('))
    expect(fn.indexOf('addProcessingIntent(userId, recordingId)')).toBeLessThan(fn.indexOf('processingRequester.retry('))
  })

  it('removes it only when the server acknowledged', () => {
    expect(fn).toMatch(/if \(out\.ok && userId\) removeProcessingIntent\(userId, recordingId\)/)
    expect(fn.match(/removeProcessingIntent\(/g)).toHaveLength(1)
  })

  it('a failed request keeps its intent, so a relaunch tries again', () => {
    expect(fn).not.toMatch(/if \(!out\.ok\)[^\n]*removeProcessingIntent/)
  })
})

describe('launch / list-load reconcile retries what this app saved but never handed over', () => {
  const effect = slice('// Launch / list-load reconcile:', '/**\n   * Follow every lecture that is mid-processing')

  it('uses the recorded intents against the loaded library', () => {
    expect(effect).toContain('listProcessingIntents(userId)')
    expect(effect).toContain('reconcileIntents(intents, recordings, reconciledProcessingRef.current)')
  })

  it('requests only what the pure rule says, and forgets lectures that moved on', () => {
    expect(effect).toContain('for (const id of request) void startHostedProcessing(id)')
    expect(effect).toContain('for (const id of clear) removeProcessingIntent(userId, id)')
  })

  it('does nothing without hosted AI or a signed-in user', () => {
    expect(effect).toMatch(/if \(!aiProcessingExpected \|\| !userId\) return/)
  })

  it('is bounded to recorded intents — it never scans the library for pending rows to process', () => {
    expect(effect).not.toMatch(/recordings\.(filter|forEach|map)/)
  })
})

describe('the status tracker follows every in-flight lecture, independent of the open screen', () => {
  it('is enabled by the hosted pipeline, not by a selected lecture', () => {
    const hook = slice('useProcessingTracker({', 'onRows: handleStatusRows')
    expect(hook).toContain('enabled: aiProcessingExpected && Boolean(supabase && userId)')
    expect(hook).toContain('ids: trackedProcessingIds')
    expect(hook).not.toContain('selectedId')
  })

  it('tracks from the whole library; the open lecture and the saved lecture are only pinned', () => {
    const tracked = slice('const trackedProcessingIds = useMemo(', 'const fullFetchInFlightRef')
    expect(tracked).toContain('library: recordings')
    expect(tracked).toContain('pinned: [selectedId, recentCapture?.recordingId]')
  })

  it('reads status with the narrow query, and fetches the text once when a row reports outputs', () => {
    expect(app).toContain('readStatuses: (ids) => getProcessingStatuses(supabase!, userId!, ids)')
    expect(app).toContain('for (const id of applied.needFull) void adoptFullLecture(id)')
  })

  it('retries the text fetch itself, so a slow database cannot strand a finished lecture', () => {
    const adopt = slice('const adoptFullLecture = useCallback(', 'const handleStatusRows = useCallback(')
    expect(adopt).toMatch(/for \(const delay of \[0, 1500, 4000, 10_000\]\)/)
  })

  it('the old poll that only followed the OPEN lecture is gone', () => {
    expect(app).not.toContain('HOSTED_AI_POLL_MAX_MS')
    expect(app).not.toContain('hostedAiPollStartedAtRef')
  })

  it('a list read can never drag a lecture backwards', () => {
    const refresh = slice('const refreshList = useCallback(', 'Phase 2D-2: real user retry')
    expect(refresh).toContain('preferNewerAiState(recordingsRef.current, list)')
  })
})

describe('local-only and own-key lectures are never forced into hosted processing', () => {
  it('the hosted pipeline is expected only for a signed-in, hosted-AI, non-local lecture', () => {
    expect(app).toContain('const aiProcessingExpected = !localOnly && usesHosted')
  })

  it('every consumer of processing state is gated on it', () => {
    expect(app).toContain('if (!aiProcessingExpected || !userId) return')
    expect(app).toContain('enabled: aiProcessingExpected && Boolean(supabase && userId)')
    expect(app).toContain('if (!id || !aiProcessingExpected) return null')
    expect(app).toContain('aiExpected={aiProcessingExpected}')
    expect(app).toContain('if (usesHosted) void startHostedProcessing(recordingId)')
  })
})

describe('Retry is idempotent: same lecture, same audio, existing endpoint', () => {
  it('Retry buttons call startHostedProcessing(id, "retry") for the SAME id — and nothing else retries', () => {
    const calls = app.match(/startHostedProcessing\([^)]*'retry'\)/g) ?? []
    expect(calls).toHaveLength(2) // the saved screen and the lecture detail
    expect(app).toContain("startHostedProcessing(openLecture.id, 'retry')")
    expect(app).toContain("startHostedProcessing(id, 'retry')")
  })

  it('there is no code path that records, uploads or inserts on Retry', () => {
    const fn = slice('const startHostedProcessing = useCallback(', 'useEffect(() => {\n    startProcessingRef.current')
    expect(fn).not.toMatch(/uploadLectureAudioViaServer|insertLectureRecordingRow|savePendingUpload|MediaRecorder/)
  })

  it('a finished lecture is never auto-requested: only `pending` rows qualify', () => {
    const open = slice('// Reconcile on open:', '// Phase 2D-4: detect unfinished durable recording sessions')
    expect(open).toContain('shouldRequestProcessing({')
  })
})

describe('the saved screen and the detail page read the authoritative lifecycle', () => {
  it('the saved stage is derived from the same lifecycle as the list badge and the detail', () => {
    const saved = slice('const savedLectureAi = useMemo(', 'const recordingStage = resolveRecordingV2Stage({')
    expect(saved).toContain('lectureLifecycle({')
    expect(saved).toContain('requestFailed: processingRequester.failed(id)')
    expect(app).toContain('ai: savedLectureAi?.phase ?? null')
    expect(app).toContain('processing={savedLectureAi}')
  })

  it('the detail page is told when the authoritative read is still pending', () => {
    expect(app).toContain('detailLoading={detail?.id !== openLecture.id && !detailLoadFailed}')
  })

  it('the list badge reads outputs and the server clock, not just a status string', () => {
    const fn = slice('const lectureStatusOf = useCallback(', 'Open the EXISTING production Lecture Detail')
    expect(fn).toContain('transcript: recording.transcript')
    expect(fn).toContain('aiUpdatedAt: recording.aiUpdatedAt')
  })
})

describe('audio durability and the history viewport are untouched', () => {
  it('the save pipeline order still protects the audio first', () => {
    const stop = slice('const handleStopAndSave = async () => {', 'const runTranscribeAndSummarize')
    const marks = ['ledgerMarkUploaded(', 'ledgerMarkDbCommitted(', 'startHostedProcessing(recordingId)', 'completeRecordingSessionPersist(recordingId).catch']
    let last = -1
    for (const m of marks) {
      const at = stop.indexOf(m, last + 1)
      expect(at, m).toBeGreaterThan(last)
      last = at
    }
  })

  it('the responsive history viewport and its native scrolling are still in place', () => {
    const css = readFileSync(new URL('../styles/recording-v2.css', import.meta.url), 'utf8')
    expect(css).toContain('--recording-history-max: clamp(200px, 38vh, 360px)')
    const tsx = readFileSync(new URL('../components/RecordingV2.tsx', import.meta.url), 'utf8')
    expect(tsx).not.toMatch(/onWheel|addEventListener\(['"]wheel|preventDefault/)
  })
})
