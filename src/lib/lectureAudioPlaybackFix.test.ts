import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Owner QA blocker (round 1): after Save Lecture started working, opening
 * the saved lecture left the audio section on "Loading audio…" forever — no
 * player, no error, no Retry.
 *
 * Direct staging inspection (real DB row, real storage object, real signed
 * URL, replicated with a genuine authenticated session) proved the recorded
 * audio itself was fully intact. The backend was healthy; the client-side
 * loading effect was not: of the two network calls it made, only the
 * signed-URL fetch had a `withTimeout` guard, and the player only ever
 * checked `audioError`, never `detailLoadFailed`.
 *
 * Owner QA blocker (round 2, this file's newer guards): a lecture reopened
 * later now loads fine, but a lecture recorded and saved *just now* still
 * got stuck — same symptom, different cause. `getRecordingDetail`'s single-
 * row select doesn't hang; it can resolve to a genuinely null row when
 * issued immediately after the INSERT that created it, before that write
 * has finished propagating on the read path. The effect's old
 * `if (cancelled || !row) return` treated that null exactly like a
 * legitimate cancellation — no `detail`, no `audioUrl`, no
 * `audioLoadError`, no `detailLoadFailed`. Nothing was ever wrong enough to
 * retry, and nothing ever would.
 *
 * The fix is data-driven, not a delay: `handleStopAndSave` already awaits
 * `refreshList()` before reporting success (see saveLecturePersistence.test.ts),
 * so a freshly saved recording's canonical row — storagePath included — is
 * already sitting in the in-memory recordings list by the time its Lecture
 * Detail screen can possibly open. Reading that row directly sidesteps the
 * single-row re-fetch race entirely for the exact case that used to fail.
 * The network fetch remains as a fallback (still timeout-bounded, from
 * round 1), and its own null result is now a real, Retry-capable failure
 * instead of a silent one.
 *
 * These are static source guards (this codebase's established pattern for
 * pinning a real async handler's shape — see saveLecturePersistence.test.ts,
 * longRecordingSave.test.ts) plus the render-level tests in
 * LectureDetailPage.test.ts for the player's terminal-state behavior.
 */

const appSrc = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const detailPageSrc = readFileSync(new URL('../components/LectureDetailPage.tsx', import.meta.url), 'utf8')

/**
 * Round 4 (2026-10-04): OPEN IS AUTHORITATIVE.
 *
 * The loader used to adopt the cached list row as the lecture itself and never
 * refetch. A snapshot taken before a job finished therefore came back as "no
 * transcript / no summary" on reopen even though the database held the result
 * (and stayed that way while the database was slow). The cached row is now only
 * an EARLY PAINT, and only for a lecture that is already finished.
 */
describe('opening a lecture always reads the authoritative row; the cached list row is only an early paint', () => {
  const loader = appSrc.slice(
    appSrc.indexOf('OPEN IS AUTHORITATIVE'),
    appSrc.indexOf('const retryAudioLoad'),
  )

  it('adopts the cached row early ONLY through the finished-lecture rule', () => {
    expect(loader).toMatch(/const provisional = provisionalForOpen<RecordingDetail>\(\s*\n\s*recordingsRef\.current\.find\(\(r\) => r\.id === selectedId\)/)
    // The old unconditional adoption is gone.
    expect(loader).not.toMatch(/let row: RecordingDetail \| null =\s*\n\s*cachedRow\?\.storagePath \? \{ \.\.\.cachedRow/)
  })

  it('the authoritative fetch ALWAYS runs — it is not behind an "if no cached row" guard', () => {
    const fetchAt = loader.indexOf('getRecordingDetail(supabase!, userId!, selectedId, { signAudio: false })')
    expect(fetchAt).toBeGreaterThan(-1)
    expect(loader.slice(0, fetchAt)).not.toMatch(/if \(!row\) \{\s*\n(?:\s*\/\/.*\n)*\s*row = await/)
  })

  it('writes what the server said back onto the list row, so the badge and the detail cannot disagree', () => {
    expect(loader).toContain('mergeServerAiFields(r, row!)')
  })
})

describe('save-result to Lecture Detail owns one fresh loader lifecycle', () => {
  it('does not preselect the saved id before the user presses View lecture', () => {
    const saveTail = appSrc.slice(appSrc.lastIndexOf('lastFinalTimestampRef.current = 0'))
    expect(saveTail).not.toContain('setSelectedId(recordingId)')
  })

  it('recovery and pending-upload retry leave selection to View lecture so its loader always runs', () => {
    const recovery = appSrc.slice(appSrc.indexOf('const handleRecoverSave'), appSrc.indexOf('const handleRecoverKeep'))
    const retry = appSrc.slice(appSrc.indexOf('const handleRetryPendingUpload'), appSrc.indexOf('const handleDeletePendingUpload'))
    expect(recovery).not.toContain('setSelectedId(recordingId)')
    expect(retry).not.toContain('setSelectedId(id)')
    expect(retry).toContain("setRecentCapture({ kind: 'success', recordingId: id, at: Date.now() })")
  })

  it('the View lecture action routes through the shared opener', () => {
    expect(appSrc).toMatch(/const id = recentCapture\?\.recordingId[\s\S]*?if \(id\) openLectureDetail\(id\)/)
  })

  it('reopening the already-selected lecture restarts the detail/audio loader', () => {
    // Back preserves selectedId. Setting it to the same id is a React no-op,
    // so the opener must also change the effect dependency used for retries.
    const opener = appSrc.slice(appSrc.indexOf('const openLectureDetail'), appSrc.indexOf('const openLecture = useMemo'))
    expect(opener).toMatch(
      /setDetailRetryNonce\(\(nonce\) => nonce \+ 1\)[\s\S]*?setDetail\(null\)[\s\S]*?setSelectedId\(recordingId\)/,
    )
  })
})

describe('the row fetch is bounded and retried, and a null row is a real, Retry-capable failure', () => {
  const loader = appSrc.slice(appSrc.indexOf('OPEN IS AUTHORITATIVE'), appSrc.indexOf('const retryAudioLoad'))

  it('getRecordingDetail is wrapped in the same withTimeout guard as getRecordingAudioUrl, and retried', () => {
    expect(loader).toMatch(/await withTimeout\(\s*getRecordingDetail\(supabase!, userId!, selectedId, \{ signAudio: false \}\),\s*SAVE_META_TIMEOUT_MS,/)
    expect(loader).toMatch(/for \(const delay of \[0, 1500, 4000\]\)/)
  })

  it('a null row (a just-saved insert not yet visible) is retried instead of being final', () => {
    expect(loader).toMatch(/if \(fetched\) \{\s*\n\s*row = fetched\s*\n\s*break\s*\n\s*\}/)
  })

  it('after every attempt a null row sets detailLoadFailed — unless a finished lecture is already on screen', () => {
    // Regression guard for the exact round-2 bug: `if (cancelled || !row) return`
    // used to make a null row indistinguishable from a legitimate cancellation.
    expect(appSrc).not.toMatch(/if \(cancelled \|\| !row\) return/)
    expect(loader).toMatch(/if \(cancelled\) return\s*\n\s*if \(!row\) \{\s*\n(?:\s*\/\/.*\n)*\s*if \(!provisional\) \{\s*\n\s*setDetail\(null\)\s*\n\s*setDetailLoadFailed\(true\)\s*\n\s*\}\s*\n\s*return\s*\n\s*\}/)
  })
})

describe('the audio player section treats a failed row fetch as a real audio failure', () => {
  it('the loading-vs-unavailable text checks detailLoadFailed, not just audioError', () => {
    expect(detailPageSrc).toContain(
      "{audioError || detailLoadFailed ? t('lecture.audioUnavailable') : t('lecture.audioLoading')}",
    )
  })

  it('the Retry button appears for either failure mode, and retries the right thing', () => {
    expect(detailPageSrc).toContain('{audioError || detailLoadFailed ? (')
    // A failed row fetch must retry the row (onRetryDetail, which bumps
    // detailRetryNonce and re-runs the whole effect — re-reading the list
    // cache too); a failed sign-only call must retry just the signing.
    expect(detailPageSrc).toContain('onClick={detailLoadFailed ? onRetryDetail : onRetryAudio}')
  })
})
