import type { Recording, RecordingDetail } from '../types'
import type { PendingUploadMeta } from './pendingUploads'
import { titleForPersist } from './lectureTitleIntegrity'

const DB_NAME = 'lecture-companion'
// v4 (Phase 2D-2): additive `pending_uploads` for failed cloud uploads.
// v5 (Phase 2D-4): additive `recording_sessions` + `recording_chunks` for
// durable incremental capture (crash-safe long lectures). Prior stores untouched.
const DB_VERSION = 5
const STORE = 'recordings'
const TRASH_STORE = 'recordings_trash'
const PENDING_STORE = 'pending_uploads'
const SESSION_STORE = 'recording_sessions'
const CHUNK_STORE = 'recording_chunks'

export type RecordingWithBlob = Recording & { audioBlob: Blob }
/** Durable cloud pending/failed upload: metadata (incl. userId) + the audio blob. */
export type PendingUploadRow = PendingUploadMeta & { audioBlob: Blob }

type Row = RecordingWithBlob

/** Shared DB open — also used by recordingSessionStore (same name/version). */
export function openLectureCompanionDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(TRASH_STORE)) {
        db.createObjectStore(TRASH_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(PENDING_STORE)) {
        db.createObjectStore(PENDING_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        const chunks = db.createObjectStore(CHUNK_STORE, { keyPath: 'id' })
        chunks.createIndex('by_session', 'sessionId', { unique: false })
      }
    }
  })
}

function openDb(): Promise<IDBDatabase> {
  return openLectureCompanionDb()
}

// ── Pending cloud uploads (Phase 2D-2) ───────────────────────────────────────
// A cloud recording whose upload failed is preserved here — keyed by the stable
// recording UUID and tagged with the authenticated userId — so it stays durably
// recoverable and retryable across restarts, and is only ever shown to its owner.

export async function savePendingUpload(row: PendingUploadRow): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.objectStore(PENDING_STORE).put(row)
  })
}

export async function getPendingUploadWithBlob(id: string): Promise<PendingUploadRow | null> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_STORE, 'readonly')
    const req = tx.objectStore(PENDING_STORE).get(id)
    req.onsuccess = () => resolve((req.result as PendingUploadRow | undefined) ?? null)
    req.onerror = () => reject(req.error)
  })
}

/** All pending uploads for one authenticated user (metadata only; no blobs). */
export async function listPendingUploads(userId: string): Promise<PendingUploadMeta[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_STORE, 'readonly')
    const req = tx.objectStore(PENDING_STORE).getAll()
    req.onsuccess = () => {
      const rows = (req.result as PendingUploadRow[]) ?? []
      const mine = rows
        .filter((r) => r.userId === userId)
        .map(({ audioBlob: _b, ...meta }) => {
          void _b
          return meta
        })
      resolve(mine)
    }
    req.onerror = () => reject(req.error)
  })
}

export async function updatePendingUpload(
  id: string,
  patch: Partial<
    Pick<PendingUploadMeta, 'state' | 'lastErrorCategory' | 'attempts' | 'updatedAt' | 'cloudUploaded' | 'course' | 'courseId'>
  >,
): Promise<void> {
  const existing = await getPendingUploadWithBlob(id)
  if (!existing) return
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.objectStore(PENDING_STORE).put({ ...existing, ...patch })
  })
}

export async function deletePendingUpload(id: string): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.objectStore(PENDING_STORE).delete(id)
  })
}

export async function saveRecordingLocal(row: RecordingWithBlob): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.objectStore(STORE).put(row as Row)
  })
}

export async function updateRecordingLocal(
  id: string,
  patch: Partial<
    Pick<
      Recording,
      | 'course'
      | 'title'
      | 'transcript'
      | 'transcriptRaw'
      | 'summaryEn'
      | 'summaryZh'
      | 'liveTranscript'
      | 'liveTranscriptRaw'
    >
  >,
): Promise<void> {
  const existing = await getRecordingWithBlob(id)
  if (!existing) throw new Error('Recording not found')
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    const next: Row = { ...existing, ...patch }
    // A patch may carry `title` only when it is a real rename. An empty string
    // or a display placeholder is dropped, so the stored name survives — the
    // same guard `updateRecordingMetadata` applies to the cloud row.
    if ('title' in patch && titleForPersist(patch.title) === undefined) {
      next.title = existing.title
    }
    tx.objectStore(STORE).put(next)
  })
}

export async function getRecordingWithBlob(id: string): Promise<RecordingWithBlob | null> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(id)
    req.onsuccess = () => resolve((req.result as Row | undefined) ?? null)
    req.onerror = () => reject(req.error)
  })
}

export async function getRecordingDetailLocal(id: string): Promise<RecordingDetail | null> {
  const row = await getRecordingWithBlob(id)
  if (!row) return null
  return {
    id: row.id,
    course: row.course,
    title: row.title,
    createdAt: row.createdAt,
    durationSec: row.durationSec,
    mime: row.mime,
    transcript: row.transcript,
    transcriptRaw: row.transcriptRaw,
    summaryEn: row.summaryEn,
    summaryZh: row.summaryZh,
    liveTranscript: row.liveTranscript,
    liveTranscriptRaw: row.liveTranscriptRaw,
    audioUrl: URL.createObjectURL(row.audioBlob),
    storagePath: id,
  }
}

/** Full rows including audio (for backup export). */
export async function getAllRecordingsLocalWithBlobs(): Promise<RecordingWithBlob[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = () => resolve((req.result as Row[]) ?? [])
    req.onerror = () => reject(req.error)
  })
}

export async function listRecordingsLocal(): Promise<Recording[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = () => {
      const rows = (req.result as Row[]).map((r) => {
        const { audioBlob: _b, ...meta } = r
        void _b
        return meta
      })
      rows.sort((a, b) => b.createdAt - a.createdAt)
      resolve(rows)
    }
    req.onerror = () => reject(req.error)
  })
}

export async function deleteRecordingLocal(id: string): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.objectStore(STORE).delete(id)
  })
}

/** Move lectures from the live store into local trash (full row + audio blob). */
export async function moveRecordingsToTrashLocal(ids: string[]): Promise<void> {
  const unique = [...new Set(ids)].filter(Boolean)
  for (const id of unique) {
    const row = await getRecordingWithBlob(id)
    if (!row) continue
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE, TRASH_STORE], 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.objectStore(TRASH_STORE).put(row as Row)
      tx.objectStore(STORE).delete(id)
    })
  }
}

export async function listTrashRecordingsLocal(): Promise<Recording[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRASH_STORE, 'readonly')
    const req = tx.objectStore(TRASH_STORE).getAll()
    req.onsuccess = () => {
      const rows = (req.result as Row[]).map((r) => {
        const { audioBlob: _b, ...meta } = r
        void _b
        return meta
      })
      rows.sort((a, b) => b.createdAt - a.createdAt)
      resolve(rows)
    }
    req.onerror = () => reject(req.error)
  })
}

export async function restoreRecordingFromTrashLocal(id: string): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, TRASH_STORE], 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    const req = tx.objectStore(TRASH_STORE).get(id)
    req.onsuccess = () => {
      const row = req.result as Row | undefined
      if (!row) return
      tx.objectStore(STORE).put(row)
      tx.objectStore(TRASH_STORE).delete(id)
    }
    req.onerror = () => reject(req.error)
  })
}

/** Remove one lecture blob from local trash permanently (already absent from live store). */
export async function deleteTrashRecordingLocalPermanently(id: string): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRASH_STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.objectStore(TRASH_STORE).delete(id)
  })
}
