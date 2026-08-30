import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Phase 2D regression guard on the real save handler in src/App.tsx.
 * These assertions fail if anyone re-introduces a client-side size gate that
 * discards long recordings, or removes the upload-failure local fallback.
 */
const appSrc = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

describe('long-recording save flow (src/App.tsx)', () => {
  it('does NOT reject/discard a recording by size before persisting it', () => {
    expect(appSrc).not.toContain('blob.size > MAX_WHISPER_BYTES')
    expect(appSrc).not.toMatch(/const MAX_WHISPER_BYTES\b/)
    // the destructive user message must no longer be wired into the save path
    expect(appSrc).not.toContain('recordingTooLargeUserMessage(')
  })

  it('persists audio on the primary paths (short + long recordings both save)', () => {
    // local-only save + cloud upload paths both remain present
    expect(appSrc).toContain('saveRecordingLocal({')
    expect(appSrc).toContain('uploadLectureAudioViaServer(')
  })

  it('preserves the audio as a durable per-user PENDING UPLOAD when the cloud upload fails (Scenario C)', () => {
    // the storage-failure branch now saves a per-user pending record (survives
    // restart, owner-only, retryable) instead of an invisible local row
    expect(appSrc).toContain('savePendingUpload({')
    expect(appSrc).toContain('userId: userId!')
    expect(appSrc).toContain('upload_failed_pending_saved')
  })

  it('exposes a real user retry that reuses the same recording id (idempotent, no duplicates)', () => {
    expect(appSrc).toContain('handleRetryPendingUpload')
    // same UUID → same storage path + idempotent insert; local copy dropped only after success
    expect(appSrc).toContain('uploadLectureAudioViaServer(supabase, id,')
    expect(appSrc).toContain('await deletePendingUpload(id)')
  })

  it('merges per-user pending uploads into Courses, de-duped against cloud', () => {
    expect(appSrc).toContain('listPendingUploads(userId)')
    expect(appSrc).toContain('visiblePendingUploads(')
    expect(appSrc).toContain('Pending uploads ·')
  })

  it('auto-retries transient upload interruptions (bounded, idempotent)', () => {
    expect(appSrc).toContain('computeUploadRetryPlan(')
    expect(appSrc).toContain('isTransientUploadError(')
    expect(appSrc).toContain('upload_retry')
  })

  it('does not tell the user to "Stop & Save again" (an invalid retry) on upload failure', () => {
    // the corrected message points at the real in-app Retry, not an invalid path
    expect(appSrc).not.toContain('try Stop & Save again when you’re back online')
    expect(appSrc).toContain('Tap Retry Save below when you’re back online')
  })

  it('classifies a pending-upload fallback as an actionable failure, never a silent success', () => {
    // Regression guard: this outcome used to be `list_refresh_warn`, which
    // `resolveRecordingV2Stage` maps to the SAME terminal stage as a genuine
    // success — the user saw a "Ready" screen with no indication the lecture
    // was not actually in the cloud/Course yet, and no working retry.
    expect(appSrc).not.toMatch(/kind: 'list_refresh_warn',\s*\n\s*recordingId,\s*\n\s*message:\s*\n\s*'Your recording is safe/)
    expect(appSrc).toContain("outcome: 'pending_upload'")
  })

  it('keeps the existing recording_too_long → local fallback intact', () => {
    expect(appSrc).toContain('recording_too_long')
    expect(appSrc).toContain("'Local save fallback'")
  })

  it('documents the persist-first / no-size-gate invariant at the guard site', () => {
    expect(appSrc).toContain('NO client-side size gate')
  })
})
