import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiJobStatus, Recording, RecordingDetail } from '../types'
import { getAiApiBase } from './ai/apiBase'

const BUCKET = 'lecture-audio'

export type SaveRecordingRemotePhase = 'storage_upload' | 'database_insert'

/** Thrown from {@link saveRecordingRemote} with a stable phase for UI messaging. */
export class SaveRecordingRemoteError extends Error {
  readonly phase: SaveRecordingRemotePhase

  constructor(phase: SaveRecordingRemotePhase, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SaveRecordingRemoteError'
    this.phase = phase
  }
}

function describeUnknown(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message
  }
  return String(err)
}

/** Pull Storage / fetch error fields Supabase sets on failed uploads. */
function serializeStorageUploadError(err: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!err || typeof err !== 'object') {
    out.raw = String(err)
    return out
  }
  const e = err as Record<string, unknown>
  if (typeof e.name === 'string') out.name = e.name
  if (typeof e.message === 'string') out.message = e.message
  if (typeof e.statusCode === 'number' || typeof e.statusCode === 'string') out.statusCode = e.statusCode
  if (typeof e.error === 'string') out.error = e.error
  if (e.__isAuthError === true) out.__isAuthError = true
  if (e.cause !== undefined) {
    out.causeMessage =
      e.cause instanceof Error ? e.cause.message : typeof e.cause === 'object' && e.cause && 'message' in e.cause
        ? String((e.cause as { message: unknown }).message)
        : undefined
  }
  return out
}

function userFacingUploadHint(baseMsg: string): string {
  const lower = baseMsg.toLowerCase()
  if (/load failed|failed to fetch|networkerror|network request failed/i.test(lower)) {
    return `${baseMsg} — Check internet/VPN, Desktop WebView permissions, and that your Supabase project URL is reachable (not blocked).`
  }
  if (/jwt|expired|session|not authenticated|401|403/i.test(lower)) {
    return `${baseMsg} — Sign out and sign in again; your session may have expired.`
  }
  return baseMsg
}

/** Shape of `public.recordings` rows from Supabase. */
export type RecordingDbRow = {
  id: string
  user_id: string
  course: string
  title: string
  created_at: string
  duration_sec: number
  mime: string
  storage_path: string
  transcript: string | null
  transcript_raw: string | null
  summary_en: string | null
  summary_zh: string | null
  live_transcript: string | null
  live_transcript_raw: string | null
  ai_status: string | null
  ai_error: string | null
  ai_updated_at: string | null
  transcript_ready?: boolean | null
  summary_ready?: boolean | null
  translation_ready?: boolean | null
  ai_pipeline_timing?: Record<string, unknown> | null
}

const AI_STATUSES: AiJobStatus[] = [
  'pending',
  'queued',
  'transcribing',
  'summarizing',
  'transcript_ready',
  'done',
  'failed',
]

/** Unknown / null `ai_status` (e.g. legacy rows) maps to `pending` so the UI stays usable. */
export function parseAiJobStatus(raw: string | null | undefined): AiJobStatus {
  if (raw && (AI_STATUSES as string[]).includes(raw)) return raw as AiJobStatus
  return 'pending'
}

export function mapDbRowToRecording(r: RecordingDbRow): Recording {
  return {
    id: r.id,
    course: r.course,
    title: r.title,
    createdAt: new Date(r.created_at).getTime(),
    durationSec: r.duration_sec,
    mime: r.mime,
    transcript: r.transcript ?? undefined,
    transcriptRaw: r.transcript_raw ?? undefined,
    summaryEn: r.summary_en ?? undefined,
    summaryZh: r.summary_zh ?? undefined,
    liveTranscript: r.live_transcript ?? undefined,
    liveTranscriptRaw: r.live_transcript_raw ?? undefined,
    aiStatus: parseAiJobStatus(r.ai_status),
    aiError: r.ai_error ?? undefined,
    aiUpdatedAt: r.ai_updated_at ? new Date(r.ai_updated_at).getTime() : undefined,
    transcriptReady: r.transcript_ready === true ? true : r.transcript_ready === false ? false : undefined,
    summaryReady: r.summary_ready === true ? true : r.summary_ready === false ? false : undefined,
    translationReady: r.translation_ready === true ? true : r.translation_ready === false ? false : undefined,
    aiPipelineTiming:
      r.ai_pipeline_timing && typeof r.ai_pipeline_timing === 'object'
        ? (r.ai_pipeline_timing as Recording['aiPipelineTiming'])
        : undefined,
  }
}

export async function listRecordings(
  supabase: SupabaseClient,
  userId: string,
): Promise<Recording[]> {
  const { data, error } = await supabase
    .from('recordings')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) throw error
  return (data as RecordingDbRow[]).map(mapDbRowToRecording)
}

export async function getRecordingDetail(
  supabase: SupabaseClient,
  userId: string,
  id: string,
): Promise<RecordingDetail | null> {
  const { data, error } = await supabase
    .from('recordings')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as RecordingDbRow
  const { data: signed, error: signErr } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(row.storage_path, 3600)

  if (signErr || !signed?.signedUrl) throw signErr ?? new Error('Could not sign audio URL')

  return {
    ...mapDbRowToRecording(row),
    audioUrl: signed.signedUrl,
    storagePath: row.storage_path,
  }
}

export async function downloadRecordingBlob(
  supabase: SupabaseClient,
  storagePath: string,
): Promise<Blob> {
  const { data, error } = await supabase.storage.from(BUCKET).download(storagePath)
  if (error || !data) throw error ?? new Error('Download failed')
  return data
}

function extensionForMime(mime: string): string {
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('mp4')) return 'm4a'
  return 'bin'
}

/** Stable path per recording UUID enables idempotent re-upload (retries / same client_request_id). */
export function lectureAudioStoragePath(userId: string, recordingId: string, mime: string): string {
  return `${userId}/${recordingId}.${extensionForMime(mime)}`
}

/** DB row only (no Storage signing). Use to verify persistence without treating signing errors as "not saved". */
export async function getRecordingMeta(
  supabase: SupabaseClient,
  userId: string,
  id: string,
): Promise<{ id: string; storage_path: string; title: string } | null> {
  const { data, error } = await supabase
    .from('recordings')
    .select('id, storage_path, title')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null
  const row = data as { id: string; storage_path: string; title: string }
  return row
}

export async function uploadLectureAudio(
  supabase: SupabaseClient,
  path: string,
  blob: Blob,
  mime: string,
): Promise<void> {
  const tail = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path
  const userSeg = path.includes('/') ? path.slice(0, path.indexOf('/')) : ''
  const userIdPrefix = userSeg ? `${userSeg.slice(0, 8)}…` : 'unknown'

  const { data: sessData, error: sessErr } = await supabase.auth.getSession()
  const hasJwt = Boolean(sessData.session?.access_token)
  const expiresAt = sessData.session?.expires_at

  console.warn(
    '[storage-upload] start',
    JSON.stringify({
      bucket: BUCKET,
      storagePath: path,
      storageObjectTail: tail,
      userIdPrefix,
      clientBlobBytes: blob.size,
      mime: mime || 'audio/webm',
      hasSession: hasJwt,
      sessionExpiresAt: expiresAt ?? null,
      sessionError: sessErr?.message ?? null,
      t: Date.now(),
    }),
  )

  if (!hasJwt) {
    const msg =
      'Audio upload failed: Not signed in or session missing. Sign in again, then stop & save.'
    console.warn('[storage-upload] blocked_no_session', JSON.stringify({ userIdPrefix, pathTail: tail }))
    throw new SaveRecordingRemoteError('storage_upload', msg, { cause: sessErr ?? undefined })
  }

  const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, blob, {
    contentType: mime || 'audio/webm',
    upsert: true,
  })
  if (upErr) {
    const rawMsg = describeUnknown(upErr)
    const detail = serializeStorageUploadError(upErr)
    console.warn(
      '[storage-upload] supabase_error',
      JSON.stringify({
        bucket: BUCKET,
        storagePath: path,
        userIdPrefix,
        blobBytes: blob.size,
        mime: mime || 'audio/webm',
        ...detail,
      }),
    )
    const friendly = userFacingUploadHint(`Audio upload failed: ${rawMsg}`)
    throw new SaveRecordingRemoteError('storage_upload', friendly, { cause: upErr })
  }
  console.warn('[storage-upload] ok', JSON.stringify({ storageObjectTail: tail, bucket: BUCKET, t: Date.now() }))
}

/**
 * Upload lecture audio via Railway proxy instead of direct Supabase Storage upload.
 * Avoids WKWebView binary Blob fetch instability for large recordings.
 *
 * Returns the storage path (`${userId}/${recordingId}.${ext}`) computed by the server.
 */
export async function uploadLectureAudioViaServer(
  supabase: SupabaseClient,
  recordingId: string,
  blob: Blob,
  mime: string,
  durationSec?: number,
  metadata?: {
    course: string
    title: string
    liveTranscript: string
    liveTranscriptRaw: string
  },
): Promise<{ storagePath: string; recording?: RecordingDbRow }> {
  const { data: sessData, error: sessErr } = await supabase.auth.getSession()
  const token = sessData.session?.access_token
  if (!token) {
    const msg = 'Audio upload failed: Not signed in or session missing. Sign in again, then stop & save.'
    console.warn('[upload-via-server] blocked_no_session')
    throw new SaveRecordingRemoteError('storage_upload', msg, { cause: sessErr ?? undefined })
  }

  const form = new FormData()
  form.append('file', blob, `recording.${mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : 'webm'}`)
  form.append('recordingId', recordingId)
  form.append('mime', mime || 'audio/webm')
  if (durationSec != null && durationSec > 0) {
    form.append('duration_sec', String(Math.round(durationSec)))
  }
  if (metadata) {
    form.append('course', metadata.course)
    form.append('title', metadata.title)
    form.append('live_transcript', metadata.liveTranscript)
    form.append('live_transcript_raw', metadata.liveTranscriptRaw)
  }

  const apiBase = getAiApiBase()
  const url = `${apiBase}/upload-audio`

  console.warn('[upload-via-server] start', JSON.stringify({ recordingId, mime, bytes: blob.size, t: Date.now() }))

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
  } catch (fetchErr) {
    const msg = userFacingUploadHint(`Audio upload failed: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`)
    throw new SaveRecordingRemoteError('storage_upload', msg, { cause: fetchErr })
  }

  if (!res.ok) {
    let serverMsg = `HTTP ${res.status}`
    let serverCode = ''
    let storagePath: string | undefined
    try {
      const body = await res.json() as { error?: string; message?: string }
      serverCode = body.error ?? ''
      storagePath = (body as { storagePath?: string }).storagePath
      if (body.message) serverMsg = body.message
      else if (body.error) serverMsg = body.error
    } catch { /* ignore */ }
    if (serverCode === 'database_error' || serverCode === 'recording_conflict') {
      console.warn(
        '[upload-via-server] database_error',
        JSON.stringify({ status: res.status, serverCode, serverMsg, recordingId, storagePath }),
      )
      throw new SaveRecordingRemoteError('database_insert', `Database save failed: ${serverMsg}`)
    }
    const msg = userFacingUploadHint(`Audio upload failed: ${serverMsg}`)
    console.warn('[upload-via-server] server_error', JSON.stringify({ status: res.status, serverMsg, recordingId }))
    throw new SaveRecordingRemoteError('storage_upload', msg)
  }

  const result = await res.json() as { storagePath: string; mime: string; size: number; recording?: RecordingDbRow }
  console.warn('[upload-via-server] ok', JSON.stringify({ storagePath: result.storagePath, bytes: result.size, t: Date.now() }))
  return { storagePath: result.storagePath, recording: result.recording }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === '23505'
  )
}

/** Payload for `recordings.insert` on cloud save. Sets Phase-2-reserved job columns (worker will advance them). */
export function lectureRecordingInsertPayload(input: {
  id: string
  userId: string
  course: string
  title: string
  durationSec: number
  mime: string
  storagePath: string
  /** Canonical live caption (display + downstream). */
  liveTranscript: string
  /** Raw assembled live text before canonicalization. */
  liveTranscriptRaw: string
  /** @internal fixed clock for tests */
  nowIso?: string
}) {
  const nowIso = input.nowIso ?? new Date().toISOString()
  return {
    id: input.id,
    user_id: input.userId,
    course: input.course,
    title: input.title,
    duration_sec: input.durationSec,
    mime: input.mime,
    storage_path: input.storagePath,
    live_transcript: input.liveTranscript || null,
    live_transcript_raw: input.liveTranscriptRaw || null,
    ai_status: 'pending' as const,
    ai_error: null,
    ai_updated_at: nowIso,
  }
}

/**
 * Inserts row; if this client_request_id (recording id) already exists for the user, treats as idempotent success.
 * Returns whether a new row was inserted.
 */
export async function insertLectureRecordingRow(input: {
  supabase: SupabaseClient
  userId: string
  id: string
  course: string
  title: string
  durationSec: number
  mime: string
  storagePath: string
  liveTranscript: string
  liveTranscriptRaw: string
}): Promise<'inserted' | 'already_exists'> {
  const { error: insErr } = await input.supabase
    .from('recordings')
    .insert(
      lectureRecordingInsertPayload({
        id: input.id,
        userId: input.userId,
        course: input.course,
        title: input.title,
        durationSec: input.durationSec,
        mime: input.mime,
        storagePath: input.storagePath,
        liveTranscript: input.liveTranscript,
        liveTranscriptRaw: input.liveTranscriptRaw,
      }),
    )

  if (!insErr) return 'inserted'

  if (isUniqueViolation(insErr)) {
    const meta = await getRecordingMeta(input.supabase, input.userId, input.id)
    if (meta && meta.storage_path === input.storagePath) {
      return 'already_exists'
    }
    if (meta) {
      throw new SaveRecordingRemoteError(
        'database_insert',
        'This recording ID already exists with different data. Try saving as a new recording.',
        { cause: insErr },
      )
    }
    throw new SaveRecordingRemoteError(
      'database_insert',
      `Database save failed: ${describeUnknown(insErr)}`,
      { cause: insErr },
    )
  }

  const { error: rmErr } = await input.supabase.storage.from(BUCKET).remove([input.storagePath])
  if (rmErr) {
    console.warn('insertLectureRecordingRow: could not remove orphan upload after DB failure', rmErr)
  }
  throw new SaveRecordingRemoteError(
    'database_insert',
    `Database save failed: ${describeUnknown(insErr)}`,
    { cause: insErr },
  )
}

/** @deprecated Prefer {@link uploadLectureAudio} + {@link insertLectureRecordingRow} for phased saves. */
export async function saveRecordingRemote(input: {
  supabase: SupabaseClient
  userId: string
  id: string
  course: string
  title: string
  durationSec: number
  mime: string
  blob: Blob
  liveTranscript: string
  liveTranscriptRaw: string
}): Promise<void> {
  const path = lectureAudioStoragePath(input.userId, input.id, input.mime)
  await uploadLectureAudio(input.supabase, path, input.blob, input.mime)
  await insertLectureRecordingRow({
    supabase: input.supabase,
    userId: input.userId,
    id: input.id,
    course: input.course,
    title: input.title,
    durationSec: input.durationSec,
    mime: input.mime,
    storagePath: path,
    liveTranscript: input.liveTranscript,
    liveTranscriptRaw: input.liveTranscriptRaw,
  })
}

/**
 * Persists transcript / summaries from the **browser** Whisper flow only.
 * Does not update `ai_status` / `ai_error` / `ai_updated_at` (Phase 2: reserved for async workers).
 */
export async function updateRecordingAi(
  supabase: SupabaseClient,
  userId: string,
  id: string,
  patch: {
    transcript?: string
    transcriptRaw?: string
    summaryEn?: string
    summaryZh?: string
  },
): Promise<void> {
  const payload: Record<string, string | undefined> = {}
  if (patch.transcript !== undefined) payload.transcript = patch.transcript
  if (patch.transcriptRaw !== undefined) payload.transcript_raw = patch.transcriptRaw
  if (patch.summaryEn !== undefined) payload.summary_en = patch.summaryEn
  if (patch.summaryZh !== undefined) payload.summary_zh = patch.summaryZh

  const { error } = await supabase
    .from('recordings')
    .update(payload)
    .eq('id', id)
    .eq('user_id', userId)

  if (error) throw error
}

/** Update lecture display fields only (course / title). Does not touch audio, transcripts, or AI columns. */
export async function updateRecordingMetadata(
  supabase: SupabaseClient,
  userId: string,
  id: string,
  patch: { course: string; title: string },
): Promise<void> {
  const { error } = await supabase
    .from('recordings')
    .update({ course: patch.course, title: patch.title })
    .eq('id', id)
    .eq('user_id', userId)

  if (error) throw error
}

export async function deleteRecordingRemote(
  supabase: SupabaseClient,
  userId: string,
  id: string,
  storagePath: string,
): Promise<void> {
  // Delete the DB row FIRST. Removing storage before the row is gone means a
  // failed row delete leaves a visible lecture with permanently missing audio.
  // Orphaned storage after a successful row delete is recoverable; silent audio
  // loss is not.
  const { error } = await supabase.from('recordings').delete().eq('id', id).eq('user_id', userId)
  if (error) throw error

  const { error: stErr } = await supabase.storage.from(BUCKET).remove([storagePath])
  if (stErr) throw stErr
}

function describeSupabaseError(prefix: string, error: unknown): Error {
  const err = error as {
    message?: string
    code?: string
    details?: string
    hint?: string
    statusCode?: string | number
    status?: string | number
    name?: string
  }
  const parts = [
    prefix,
    err?.message ? `message=${err.message}` : null,
    err?.code ? `code=${err.code}` : null,
    err?.details ? `details=${err.details}` : null,
    err?.hint ? `hint=${err.hint}` : null,
    err?.statusCode ? `statusCode=${err.statusCode}` : null,
    err?.status ? `status=${err.status}` : null,
    err?.name ? `name=${err.name}` : null,
  ].filter(Boolean)
  return new Error(parts.join(' | '))
}

/**
 * Delete one or more cloud or local lecture recordings.
 *
 * Cloud path: delete recording rows first, verify they are gone, then remove
 * Storage audio. Storage-before-row ordering is unsafe — a failed row delete
 * after a successful storage remove permanently destroys the only audio copy
 * while the lecture remains visible/restorable in the UI.
 *
 * Storage cleanup after a successful row delete is best-effort: an orphaned
 * object is preferable to silent audio loss. No Supabase work for `localOnly`.
 */
export async function deleteLectures(
  ids: string[],
  options: {
    localOnly: boolean
    supabase: SupabaseClient | null
    userId: string | null
    deleteRecordingLocal: (id: string) => Promise<void>
  },
): Promise<void> {
  const unique = [...new Set(ids)].filter(Boolean)
  if (unique.length === 0) return

  if (options.localOnly) {
    for (const id of unique) {
      try {
        await options.deleteRecordingLocal(id)
      } catch (err) {
        throw new Error(
          `[deleteLectures] local delete failed for id=${id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
    return
  }

  const { supabase, userId } = options
  if (!supabase || !userId) {
    throw new Error('Not signed in.')
  }

  const { data, error } = await supabase
    .from('recordings')
    .select('id, storage_path')
    .eq('user_id', userId)
    .in('id', unique)

  if (error) throw describeSupabaseError('[deleteLectures] select failed', error)

  const rows = data ?? []
  const foundIds = new Set<string>()
  const storageById = new Map<string, string>()
  for (const row of data ?? []) {
    const r = row as { id?: string; storage_path?: string }
    if (typeof r.id !== 'string') continue
    foundIds.add(r.id)
    if (typeof r.id === 'string' && typeof r.storage_path === 'string' && r.storage_path) {
      storageById.set(r.id, r.storage_path)
    }
  }

  const missingIds = unique.filter((id) => !foundIds.has(id))
  if (missingIds.length > 0) {
    throw new Error(`[deleteLectures] recording row not found for id(s): ${missingIds.join(',')}`)
  }

  const { error: deleteError } = await supabase
    .from('recordings')
    .delete()
    .eq('user_id', userId)
    .in('id', unique)

  if (deleteError) throw describeSupabaseError('[deleteLectures] row delete failed', deleteError)

  const { data: remainingRows, error: verifyError } = await supabase
    .from('recordings')
    .select('id')
    .eq('user_id', userId)
    .in('id', unique)

  if (verifyError) throw describeSupabaseError('[deleteLectures] verify delete failed', verifyError)

  if ((remainingRows ?? []).length > 0) {
    const remainingIds = rows
      .filter((row) => (remainingRows as { id?: string }[]).some((remaining) => remaining.id === row.id))
      .map((row) => row.id)
      .filter(Boolean)
    throw new Error(`[deleteLectures] row delete did not remove id(s): ${remainingIds.join(',')}`)
  }

  for (const id of unique) {
    const storagePath = storageById.get(id)
    if (!storagePath) {
      console.warn('[deleteLectures] storage_path missing; row already deleted', { id })
      continue
    }
    const { error: stErr } = await supabase.storage.from(BUCKET).remove([storagePath])
    if (stErr) {
      // Row is already gone — do not fail the purge or the UI will look like
      // nothing changed while audio may already be unreachable from the app.
      console.warn(
        '[deleteLectures] storage remove failed after row delete (orphan left)',
        JSON.stringify({
          id,
          storagePath,
          message: stErr.message ?? String(stErr),
        }),
      )
    }
  }
}
