import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Owner QA blocker: after Save Lecture started working, opening the saved
 * lecture left the audio section on "Loading audio…" forever — no player,
 * no error, no Retry.
 *
 * Direct staging inspection (real DB row, real storage object, real signed
 * URL, replicated with a genuine authenticated session) proved the recorded
 * audio itself was fully intact: correct `course_id`, correct `storage_path`,
 * a non-empty object (55,629 bytes) with the right mimetype, and a
 * `createSignedUrl` call that resolved in well under a second. The backend
 * was healthy; the client-side loading effect was not.
 *
 * Root cause: of the two network calls the Lecture Detail effect makes —
 * `getRecordingDetail` (the row select) then `getRecordingAudioUrl` (the
 * sign call) — only the SECOND had a `withTimeout` guard. A slow/stalled row
 * fetch (this staging box runs a background AI-status poll every 2.8s for as
 * long as `aiStatus` stays pending, which it does whenever transcription is
 * unconfigured, contending for the same Supabase host) could `await` forever
 * with no bounded escape. And even on an ordinary (non-hung) row-fetch
 * failure, the player block only ever checked `audioError` — never
 * `detailLoadFailed` — so that failure was invisible to the audio section
 * specifically, even though the Summary/Transcript tabs already had a
 * working Retry UI for it.
 *
 * These are static source guards (this codebase's established pattern for
 * pinning a real async handler's shape — see saveLecturePersistence.test.ts,
 * longRecordingSave.test.ts) for the two-line fix: bound the row fetch, and
 * make the player react to a failed row fetch the same way it reacts to a
 * failed sign call.
 */

const appSrc = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const detailPageSrc = readFileSync(new URL('../components/LectureDetailPage.tsx', import.meta.url), 'utf8')

describe('the lecture-detail row fetch is bounded, like the signed-URL fetch beside it', () => {
  it('getRecordingDetail is wrapped in the same withTimeout guard as getRecordingAudioUrl', () => {
    expect(appSrc).toMatch(
      /const row = await withTimeout\(\s*getRecordingDetail\(supabase!, userId!, selectedId, \{ signAudio: false \}\),\s*SAVE_META_TIMEOUT_MS,/,
    )
  })

  it('a stalled row fetch reaches the existing detailLoadFailed/Retry path, not a bare unhandled hang', () => {
    // The row-fetch timeout throws into the same outer catch that already
    // sets detailLoadFailed — no new failure path was invented.
    expect(appSrc).toMatch(
      /const row = await withTimeout\([\s\S]{0,200}\)\s*\n\s*if \(cancelled \|\| !row\) return/,
    )
    expect(appSrc).toContain('setDetailLoadFailed(true)')
  })
})

describe('the audio player section treats a failed row fetch as a real audio failure', () => {
  it('the loading-vs-unavailable text now also checks detailLoadFailed, not just audioError', () => {
    expect(detailPageSrc).toContain(
      "{audioError || detailLoadFailed ? t('lecture.audioUnavailable') : t('lecture.audioLoading')}",
    )
  })

  it('the Retry button appears for either failure mode, and retries the right thing', () => {
    expect(detailPageSrc).toContain('{audioError || detailLoadFailed ? (')
    // A failed row fetch must retry the row (onRetryDetail); a failed sign-only
    // call must retry just the signing (onRetryAudio) — never the wrong one.
    expect(detailPageSrc).toContain('onClick={detailLoadFailed ? onRetryDetail : onRetryAudio}')
  })
})
