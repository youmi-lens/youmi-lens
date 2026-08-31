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

describe('a freshly saved recording is read from the already-refreshed list first', () => {
  it('the effect seeds the row from recordingsRef before ever hitting the network', () => {
    expect(appSrc).toMatch(
      /const cachedRow = recordingsRef\.current\.find\(\(r\) => r\.id === selectedId\)\s*\n\s*let row: RecordingDetail \| null =\s*\n\s*cachedRow\?\.storagePath \? \{ \.\.\.cachedRow, storagePath: cachedRow\.storagePath \} : null/,
    )
  })

  it('the network row fetch only runs when the cached list row is not usable yet', () => {
    expect(appSrc).toMatch(/if \(!row\) \{\s*\n(?:\s*\/\/.*\n)*\s*row = await withTimeout\(\s*\n\s*getRecordingDetail\(/)
  })
})

describe('save-result to Lecture Detail owns one fresh loader lifecycle', () => {
  it('does not preselect the saved id before the user presses View lecture', () => {
    const saveTail = appSrc.slice(appSrc.lastIndexOf('lastFinalTimestampRef.current = 0'))
    expect(saveTail).not.toContain('setSelectedId(recordingId)')
  })

  it('the View lecture action routes through the shared opener', () => {
    expect(appSrc).toMatch(/const id = recentCapture\?\.recordingId[\s\S]*?if \(id\) openLectureDetail\(id\)/)
  })
})

describe('the row-select fallback is bounded and a null result is a real, Retry-capable failure', () => {
  it('getRecordingDetail (fallback path) is still wrapped in the same withTimeout guard as getRecordingAudioUrl', () => {
    expect(appSrc).toMatch(/row = await withTimeout\(\s*getRecordingDetail\(supabase!, userId!, selectedId, \{ signAudio: false \}\),\s*SAVE_META_TIMEOUT_MS,/)
  })

  it('a null row (cache miss AND fallback fetch both empty) sets detailLoadFailed instead of silently returning', () => {
    // Regression guard for the exact round-2 bug: `if (cancelled || !row) return`
    // used to make a null row indistinguishable from a legitimate cancellation.
    expect(appSrc).not.toMatch(/if \(cancelled \|\| !row\) return/)
    expect(appSrc).toMatch(/if \(cancelled\) return\s*\n\s*if \(!row\) \{\s*\n(?:\s*\/\/.*\n)*\s*setDetailLoadFailed\(true\)\s*\n\s*return\s*\n\s*\}/)
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
