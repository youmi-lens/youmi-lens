/**
 * IndexedDB persistence for durable recording sessions + ordered chunks (Phase 2D-4).
 *
 * Uses the shared `lecture-companion` DB (v5+) from db.ts. Chunk blobs are written
 * incrementally during capture so a crash does not lose the lecture.
 */

import { openLectureCompanionDb } from './db'
import {
  applyAcceptedChunk,
  assembleRecoveredChunks,
  chunkRowId,
  createRecordingSessionMeta,
  planFinalize,
  planPostPersistCleanup,
  shouldAcceptChunkIndex,
  visibleRecoverableSessions,
  withHeartbeat,
  withSessionStatus,
  type RecordingSessionMeta,
  type RecordingSessionStatus,
} from './recordingSession'

const SESSION_STORE = 'recording_sessions'
const CHUNK_STORE = 'recording_chunks'

export type RecordingChunkRow = {
  id: string
  sessionId: string
  index: number
  size: number
  createdAt: number
  blob: Blob
}

function openDb(): Promise<IDBDatabase> {
  return openLectureCompanionDb()
}

export async function createRecordingSession(input: {
  id: string
  ownerKey: string
  mime: string
  requestedBitrate: number
  course?: string
  courseId?: string | null
  title?: string
}): Promise<RecordingSessionMeta> {
  const meta = createRecordingSessionMeta(input)
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SESSION_STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.objectStore(SESSION_STORE).put(meta)
  })
  return meta
}

export async function getRecordingSession(id: string): Promise<RecordingSessionMeta | null> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESSION_STORE, 'readonly')
    const req = tx.objectStore(SESSION_STORE).get(id)
    req.onsuccess = () => resolve((req.result as RecordingSessionMeta | undefined) ?? null)
    req.onerror = () => reject(req.error)
  })
}

export async function putRecordingSession(meta: RecordingSessionMeta): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESSION_STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.objectStore(SESSION_STORE).put(meta)
  })
}

export async function updateRecordingSessionStatus(
  id: string,
  status: RecordingSessionStatus,
): Promise<RecordingSessionMeta | null> {
  const existing = await getRecordingSession(id)
  if (!existing) return null
  const next = withSessionStatus(existing, status)
  await putRecordingSession(next)
  return next
}

export async function heartbeatRecordingSession(
  id: string,
  approxDurationSec: number,
): Promise<void> {
  const existing = await getRecordingSession(id)
  if (!existing) return
  if (existing.status !== 'recording' && existing.status !== 'paused') return
  await putRecordingSession(withHeartbeat(existing, approxDurationSec))
}

/**
 * Persist one chunk. Duplicate indexes are ignored (idempotent). Out-of-order
 * indexes are rejected. Returns whether a new chunk was stored.
 */
export async function appendRecordingChunk(
  sessionId: string,
  index: number,
  blob: Blob,
): Promise<{ accepted: boolean; reason?: 'duplicate' | 'reject' | 'missing_session' }> {
  const session = await getRecordingSession(sessionId)
  if (!session) return { accepted: false, reason: 'missing_session' }
  const verdict = shouldAcceptChunkIndex(session, index)
  if (verdict === 'duplicate') return { accepted: false, reason: 'duplicate' }
  if (verdict === 'reject') return { accepted: false, reason: 'reject' }

  const row: RecordingChunkRow = {
    id: chunkRowId(sessionId, index),
    sessionId,
    index,
    size: blob.size,
    createdAt: Date.now(),
    blob,
  }
  const next = applyAcceptedChunk(session, index, blob.size)
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([SESSION_STORE, CHUNK_STORE], 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.objectStore(CHUNK_STORE).put(row)
    tx.objectStore(SESSION_STORE).put(next)
  })
  return { accepted: true }
}

export async function listRecordingChunks(sessionId: string): Promise<RecordingChunkRow[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, 'readonly')
    const store = tx.objectStore(CHUNK_STORE)
    const idx = store.indexNames.contains('by_session') ? store.index('by_session') : null
    const req = idx ? idx.getAll(sessionId) : store.getAll()
    req.onsuccess = () => {
      let rows = (req.result as RecordingChunkRow[]) ?? []
      if (!idx) rows = rows.filter((r) => r.sessionId === sessionId)
      rows.sort((a, b) => a.index - b.index)
      resolve(rows)
    }
    req.onerror = () => reject(req.error)
  })
}

/** Assemble a Blob from durable chunks (only at finalization boundary). */
export async function assembleRecordingBlob(
  sessionId: string,
): Promise<{ blob: Blob; mime: string } | null> {
  const session = await getRecordingSession(sessionId)
  if (!session) return null
  const rows = await listRecordingChunks(sessionId)
  return assembleRecoveredChunks(session, rows)
}

/**
 * Mark finalizing if needed. Idempotent: already-finalized sessions return already_done
 * without reassembling (caller should not create a duplicate lecture).
 */
export async function beginFinalizeRecordingSession(sessionId: string): Promise<{
  action: 'proceed' | 'already_done' | 'rejected' | 'missing'
  session?: RecordingSessionMeta
  assembled?: { blob: Blob; mime: string }
}> {
  const session = await getRecordingSession(sessionId)
  if (!session) return { action: 'missing' }
  const plan = planFinalize(session)
  if (plan.action === 'already_done') return { action: 'already_done', session }
  if (plan.action === 'rejected') return { action: 'rejected', session }
  await putRecordingSession(plan.next!)
  const assembled = await assembleRecordingBlob(sessionId)
  if (!assembled || assembled.blob.size <= 0) {
    return { action: 'rejected', session: plan.next }
  }
  return { action: 'proceed', session: plan.next, assembled }
}

/** After durable save/pending/cloud success — mark finalized and delete chunk blobs. */
export async function completeRecordingSessionPersist(sessionId: string): Promise<void> {
  const session = await getRecordingSession(sessionId)
  if (!session) return
  const plan = planPostPersistCleanup(session)
  const db = await openDb()
  const chunks = await listRecordingChunks(sessionId)
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([SESSION_STORE, CHUNK_STORE], 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    const chunkStore = tx.objectStore(CHUNK_STORE)
    for (const c of chunks) chunkStore.delete(c.id)
    tx.objectStore(SESSION_STORE).put(plan.next)
  })
}

/** Keep for later — stay recoverable, do not upload. */
export async function keepRecordingSessionForLater(sessionId: string): Promise<void> {
  await updateRecordingSessionStatus(sessionId, 'kept')
}

/** Delete session + chunks after user confirmation. */
export async function deleteRecordingSession(sessionId: string): Promise<void> {
  const db = await openDb()
  const chunks = await listRecordingChunks(sessionId)
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([SESSION_STORE, CHUNK_STORE], 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    const chunkStore = tx.objectStore(CHUNK_STORE)
    for (const c of chunks) chunkStore.delete(c.id)
    tx.objectStore(SESSION_STORE).delete(sessionId)
  })
}

export async function listAllRecordingSessions(): Promise<RecordingSessionMeta[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESSION_STORE, 'readonly')
    const req = tx.objectStore(SESSION_STORE).getAll()
    req.onsuccess = () => resolve((req.result as RecordingSessionMeta[]) ?? [])
    req.onerror = () => reject(req.error)
  })
}

export async function listRecoverableRecordingSessions(
  ownerKey: string,
): Promise<RecordingSessionMeta[]> {
  const all = await listAllRecordingSessions()
  return visibleRecoverableSessions(all, ownerKey)
}
