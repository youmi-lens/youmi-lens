import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * App.tsx is one large component with no jsdom, so the ORDER of operations in
 * Stop & Save cannot be exercised behaviourally here. These pin the invariants
 * that matter for the 2026-10-04 incident, using the codebase's established
 * source-shape convention. The behaviour of each piece lives in
 * `lectureProcessing.test.ts` and `LectureDetailPage.test.ts`.
 */
const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

function slice(from: string, to: string): string {
  const a = app.indexOf(from)
  const b = app.indexOf(to, a + from.length)
  expect(a, `missing "${from}"`).toBeGreaterThan(-1)
  expect(b, `missing "${to}"`).toBeGreaterThan(a)
  return app.slice(a, b)
}

describe('Stop & Save hands the lecture to the server for processing', () => {
  const stopAndSave = slice('const handleStopAndSave = async () => {', 'const runTranscribeAndSummarize')

  it('requests processing exactly once, in the cloud branch', () => {
    expect(stopAndSave.match(/startHostedProcessing\(recordingId\)/g)).toHaveLength(1)
  })

  // Round 4 (2026-10-04): the request used to wait for the client-side
  // verification reads. When Supabase answered in 8–25s one of them timed out,
  // Stop & Save returned early, and a perfectly saved lecture was never processed
  // (3:58 PM lecture: 19 minutes at `pending`). The hand-over now happens the
  // moment audio AND row are committed — still never before — and ahead of any
  // read that is allowed to fail.
  it('right after the audio is uploaded and the row is committed — and BEFORE the verification reads', () => {
    const committed = stopAndSave.indexOf('ledgerMarkDbCommitted(recordingId, userId!)')
    expect(committed).toBeGreaterThan(stopAndSave.indexOf('uploadLectureAudioViaServer('))
    const at = stopAndSave.indexOf('startHostedProcessing(recordingId)', committed)
    expect(at).toBeGreaterThan(committed)
    expect(at).toBeLessThan(stopAndSave.indexOf("dispatchFlow({ type: 'CAPTURE_VERIFY' })", committed))
    expect(at).toBeLessThan(stopAndSave.indexOf("'Confirm recording in database'", committed))
    expect(at).toBeLessThan(stopAndSave.indexOf('getRecordingMetaWithRetry(', committed))
  })

  it('no early return can sit between the committed row and the hand-over', () => {
    const from = stopAndSave.indexOf('ledgerMarkDbCommitted(recordingId, userId!)')
    const to = stopAndSave.indexOf('startHostedProcessing(recordingId)', from)
    expect(to).toBeGreaterThan(from)
    // Strip comments first: the explanation mentions "returns early" on purpose.
    const code = stopAndSave.slice(from, to).replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/\breturn\b/)
  })

  it('requests exactly once in the cloud branch, and the local-only branch never does', () => {
    expect(stopAndSave.match(/startHostedProcessing\(recordingId\)/g)).toHaveLength(1)
  })

  it('is fire-and-forget and gated on hosted Youmi AI, so it can never delay or fail the save', () => {
    expect(stopAndSave).toContain('if (usesHosted) void startHostedProcessing(recordingId)')
  })

  it('runs before the session chunks are released, and awaits nothing that could block the save', () => {
    const at = stopAndSave.indexOf('startHostedProcessing(recordingId)')
    const persist = stopAndSave.indexOf('void completeRecordingSessionPersist(recordingId).catch', at)
    expect(persist).toBeGreaterThan(at)
    expect(stopAndSave.slice(at - 5, at)).not.toContain('await')
  })

  it('is requested from App-level code, never from the recording screen — unmounting it cannot lose the request', () => {
    const recordingV2 = readFileSync(new URL('../components/RecordingV2.tsx', import.meta.url), 'utf8')
    expect(recordingV2).not.toMatch(/process-recording|requestHostedRecordingAi|startHostedProcessing/)
    // The only things the screen can do are callbacks the App already owns.
    expect(recordingV2).toContain('onRetryProcessing')
  })
})

describe('opening a stuck lecture reconciles it once', () => {
  it('requests only for lectures the pure rule says have never been processed', () => {
    const effect = slice('// Reconcile on open:', '// Phase 2D-4: detect unfinished durable recording sessions')
    expect(effect).toContain('shouldRequestProcessing({')
    expect(effect).toContain('reconciledProcessingRef.current.has(detail.id)')
    expect(effect).toContain('void startHostedProcessing(detail.id)')
  })

  it('marks the lecture reconciled before sending, so a changing detail object cannot loop', () => {
    const fn = slice('const startHostedProcessing = useCallback(', 'const lectureStatusOf')
    expect(fn.indexOf('reconciledProcessingRef.current.add(recordingId)')).toBeLessThan(
      fn.indexOf('processingRequester.request(recordingId)'),
    )
  })

  it('pulls the authoritative row after a successful request so the tracker takes over', () => {
    const fn = slice('const startHostedProcessing = useCallback(', 'const lectureStatusOf')
    expect(fn).toContain('getRecordingDetail(supabase, userId, recordingId, { signAudio: false })')
    expect(fn).toContain('mergeServerAiFields(r, next)')
  })
})

describe('the list and the detail page read the same lifecycle', () => {
  it('list badges no longer treat saved audio as Ready', () => {
    const fn = slice('const lectureStatusOf = useCallback(', 'Open the EXISTING production Lecture Detail')
    expect(fn).toContain('lectureListStatus(')
    expect(fn).not.toMatch(/recording\.storagePath \|\| recording\.durationSec > 0\s*\?\s*'Ready'/)
  })

  it('the detail page is told whether AI is expected and whether processing failed, with a retry', () => {
    expect(app).toContain('aiExpected={aiProcessingExpected}')
    expect(app).toContain('processingFailed={processingRequester.failed(openLecture.id)}')
    expect(app).toContain("onRetryProcessing={() => void startHostedProcessing(openLecture.id, 'retry')}")
  })
})
