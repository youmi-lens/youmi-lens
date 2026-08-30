/**
 * Durable pending-upload recovery model (Phase 2D-2).
 *
 * When a signed-in cloud user's recording upload fails after the bounded auto-
 * retries, the audio is preserved in a per-user IndexedDB `pending_uploads` store
 * (see src/lib/db.ts) so it stays recoverable and retryable across app restarts
 * — without re-recording. This module holds the PURE, framework-free logic:
 * the record shape, cross-account isolation + cloud de-duplication, a sanitized
 * error category (never secrets), and user-facing status labels.
 *
 * Idempotency: a pending record reuses the SAME recording UUID, so retrying it
 * uploads to the same stable storage path and hits the idempotent DB insert
 * (`insertLectureRecordingRow` → 'already_exists') — never a duplicate lecture.
 */

export type PendingUploadState = 'upload_failed' | 'uploading'

/** Sanitized failure buckets — safe to persist/log; never carry raw errors/secrets. */
export type PendingUploadErrorCategory = 'network' | 'timeout' | 'server' | 'storage' | 'unknown'

export interface PendingUploadMeta {
  /** Stable recording UUID (same id used for the cloud storage path + row). */
  id: string
  /** Authenticated owner — a pending upload is only ever shown to this user. */
  userId: string
  course: string
  /** Canonical course id at save time, if one was selected. Never re-derived from `course` on retry. */
  courseId?: string | null
  title: string
  durationSec: number
  mime: string
  /** Language settings required to process the recording after upload. */
  lang: string
  translateTarget: string
  liveTranscript?: string
  liveTranscriptRaw?: string
  createdAt: number
  updatedAt: number
  state: PendingUploadState
  lastErrorCategory: PendingUploadErrorCategory | null
  attempts: number
  /** True once the cloud upload+row are confirmed — then local cleanup is safe. */
  cloudUploaded: boolean
}

/** Map any error to a safe category. Never returns raw messages/secrets. */
export function sanitizeUploadErrorCategory(err: unknown): PendingUploadErrorCategory {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase()
  if (/timeout|timed out/.test(msg)) return 'timeout'
  if (/network|fetch failed|failed to fetch|econn|socket|offline/.test(msg)) return 'network'
  if (/bucket|storage|permission|unauthor|forbidden/.test(msg)) return 'storage'
  if (/5\d\d|gateway|server|temporarily|429|too many/.test(msg)) return 'server'
  return 'unknown'
}

/**
 * The pending uploads to SHOW in Courses for the current user:
 *   - belong to `userId` (cross-account isolation), AND
 *   - are NOT already present as a cloud recording (de-dup by recording id).
 * Sorted newest-first for stable ordering alongside the cloud list.
 */
export function visiblePendingUploads(
  all: PendingUploadMeta[],
  userId: string,
  cloudIds: Iterable<string>,
): PendingUploadMeta[] {
  const inCloud = cloudIds instanceof Set ? cloudIds : new Set(cloudIds)
  return all
    .filter((p) => p.userId === userId && !inCloud.has(p.id))
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** Short, user-facing status for a pending item. */
export function pendingStatusLabel(m: Pick<PendingUploadMeta, 'state'>): string {
  return m.state === 'uploading' ? 'Uploading…' : 'Saved on this device · Retry required'
}

/** Longer explanation for the pending item (safe; category-based). */
export function pendingStatusDetail(m: Pick<PendingUploadMeta, 'state' | 'lastErrorCategory'>): string {
  if (m.state === 'uploading') return 'Uploading to the cloud…'
  const why: Record<PendingUploadErrorCategory, string> = {
    network: 'the network was unavailable',
    timeout: 'the upload timed out',
    server: 'the server was temporarily unavailable',
    storage: 'cloud storage could not be reached',
    unknown: 'the upload could not complete',
  }
  const reason = m.lastErrorCategory ? why[m.lastErrorCategory] : why.unknown
  return `Your recording is safe on this device. Last upload didn’t finish because ${reason}. Retry when you’re back online — nothing needs to be re-recorded.`
}
