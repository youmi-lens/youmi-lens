/**
 * Durable incremental recording session model (Phase 2D-4) — pure logic.
 *
 * Active capture must not live solely in JS memory. Sessions + ordered chunks
 * are persisted; this module owns the idempotent state machine and ownership
 * rules used by the IndexedDB store and the recorder hook.
 */

export type RecordingSessionStatus =
  | 'recording'
  | 'paused'
  | 'finalizing'
  | 'finalized'
  | 'kept'
  | 'discarded'

export interface RecordingSessionMeta {
  /** Stable recording UUID — reused for pending upload + cloud row. */
  id: string
  /** Owner isolation key (auth user id, or `local` / `anonymous`). */
  ownerKey: string
  startedAt: number
  updatedAt: number
  mime: string
  requestedBitrate: number
  status: RecordingSessionStatus
  /** Approximate duration from UI heartbeat / elapsed timer. */
  approxDurationSec: number
  /** Next chunk index that should be accepted (0-based). */
  nextChunkIndex: number
  chunkCount: number
  totalBytes: number
  course?: string
  courseId?: string | null
  title?: string
}

export interface RecordingChunkMeta {
  /** `${sessionId}:${index}` */
  id: string
  sessionId: string
  index: number
  size: number
  createdAt: number
}

/**
 * Rebuild the locally durable part of an interrupted MediaRecorder session.
 *
 * WebKit's first `requestData()` chunk carries the WebM header and later
 * chunks carry subsequent clusters. Keeping their original order in one Blob
 * is therefore the same stream the recorder would have produced at Stop.
 * Refuse a gap or an empty checkpoint rather than offering a misleading
 * recovery action for corrupted IndexedDB data.
 */
export function assembleRecoveredChunks(
  session: Pick<RecordingSessionMeta, 'mime' | 'chunkCount'>,
  chunks: ReadonlyArray<{ index: number; blob: Blob }>,
): { blob: Blob; mime: string } | null {
  if (session.chunkCount <= 0 || chunks.length !== session.chunkCount) return null
  const ordered = [...chunks].sort((a, b) => a.index - b.index)
  if (ordered.some((chunk, index) => chunk.index !== index || chunk.blob.size <= 0)) return null
  const mime = session.mime || 'audio/webm'
  const blob = new Blob(ordered.map((chunk) => chunk.blob), { type: mime })
  return blob.size > 0 ? { blob, mime } : null
}

/** Statuses that mean "show recovery UI on startup". */
export const RECOVERABLE_SESSION_STATUSES: readonly RecordingSessionStatus[] = [
  'recording',
  'paused',
  'finalizing',
  'kept',
]

export function chunkRowId(sessionId: string, index: number): string {
  return `${sessionId}:${index}`
}

export function ownerKeyForUser(
  userId: string | null | undefined,
  localOnly: boolean,
): string {
  if (userId && userId.trim()) return userId.trim()
  return localOnly ? 'local' : 'anonymous'
}

export function createRecordingSessionMeta(input: {
  id: string
  ownerKey: string
  mime: string
  requestedBitrate: number
  startedAt?: number
  course?: string
  courseId?: string | null
  title?: string
}): RecordingSessionMeta {
  const now = input.startedAt ?? Date.now()
  return {
    id: input.id,
    ownerKey: input.ownerKey,
    startedAt: now,
    updatedAt: now,
    mime: input.mime,
    requestedBitrate: input.requestedBitrate,
    status: 'recording',
    approxDurationSec: 0,
    nextChunkIndex: 0,
    chunkCount: 0,
    totalBytes: 0,
    course: input.course,
    courseId: input.courseId ?? null,
    title: input.title,
  }
}

/** Accept chunk if index === nextChunkIndex; reject duplicates / gaps. */
export function shouldAcceptChunkIndex(
  session: Pick<RecordingSessionMeta, 'nextChunkIndex' | 'status'>,
  index: number,
): 'accept' | 'duplicate' | 'reject' {
  if (session.status === 'finalized' || session.status === 'discarded') return 'reject'
  if (index < session.nextChunkIndex) return 'duplicate'
  if (index > session.nextChunkIndex) return 'reject'
  return 'accept'
}

export function applyAcceptedChunk(
  session: RecordingSessionMeta,
  index: number,
  size: number,
  now = Date.now(),
): RecordingSessionMeta {
  if (shouldAcceptChunkIndex(session, index) !== 'accept') return session
  return {
    ...session,
    nextChunkIndex: index + 1,
    chunkCount: session.chunkCount + 1,
    totalBytes: session.totalBytes + Math.max(0, size),
    updatedAt: now,
  }
}

export function withSessionStatus(
  session: RecordingSessionMeta,
  status: RecordingSessionStatus,
  now = Date.now(),
): RecordingSessionMeta {
  return { ...session, status, updatedAt: now }
}

export function withHeartbeat(
  session: RecordingSessionMeta,
  approxDurationSec: number,
  now = Date.now(),
): RecordingSessionMeta {
  return {
    ...session,
    approxDurationSec: Math.max(0, Math.floor(approxDurationSec)),
    updatedAt: now,
  }
}

/** Sessions the current owner may recover (never another user). */
export function visibleRecoverableSessions(
  all: RecordingSessionMeta[],
  ownerKey: string,
): RecordingSessionMeta[] {
  return all
    .filter(
      (s) =>
        s.ownerKey === ownerKey &&
        RECOVERABLE_SESSION_STATUSES.includes(s.status) &&
        s.chunkCount > 0,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Idempotent finalize gate:
 * - finalized → already_done (caller must not recreate lecture)
 * - discarded → rejected
 * - else → proceed (mark finalizing)
 */
export function planFinalize(session: RecordingSessionMeta): {
  action: 'proceed' | 'already_done' | 'rejected'
  next?: RecordingSessionMeta
} {
  if (session.status === 'finalized') return { action: 'already_done' }
  if (session.status === 'discarded') return { action: 'rejected' }
  return { action: 'proceed', next: withSessionStatus(session, 'finalizing') }
}

/** After durable lecture/pending row exists — safe to drop chunk blobs. */
export function planPostPersistCleanup(session: RecordingSessionMeta): {
  action: 'cleanup' | 'skip'
  next: RecordingSessionMeta
} {
  if (session.status === 'discarded') {
    return { action: 'cleanup', next: session }
  }
  return { action: 'cleanup', next: withSessionStatus(session, 'finalized') }
}
