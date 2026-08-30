/**
 * POST /api/upload-audio
 *
 * Proxies lecture audio uploads from the Tauri WKWebView to Supabase Storage,
 * bypassing WKWebView's unstable binary Blob fetch for large files.
 *
 * Request: multipart/form-data
 *   - file:         audio binary
 *   - recordingId:  UUID string
 *   - mime:         MIME type, e.g. "audio/webm" or "audio/mp4"
 *   - duration_sec: recording duration in seconds (optional, used for early duration check)
 *   - course:       lecture course/title grouping (optional; defaults to "Course")
 *   - title:        lecture title (optional; defaults to "Lecture")
 *   - live_transcript: canonical live caption text (optional)
 *   - live_transcript_raw: raw live caption text (optional)
 * Headers:
 *   - Authorization: Bearer <supabase_access_token>
 *
 * Response: { storagePath, mime, size, recording }
 *
 * Beta gate: enforces per-recording duration limit before uploading.
 * Quota (daily/monthly) is checked at process-recording time, not here.
 */

import multer from 'multer'
import { createClient } from '@supabase/supabase-js'
import {
  verifyJwt,
  getEffectiveQuota,
  checkUploadAllowed,
  recordBetaUsage,
  BETA_ERROR_CODES,
} from './betaGate.mjs'
import { resolveContentLanguagePair } from './contentLanguages.mjs'

const BUCKET = 'lecture-audio'
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024 // 500 MB

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

function makeAdminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export const audioUploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
}).single('file')

function mimeToExt(mime) {
  if (!mime) return 'webm'
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('wav')) return 'wav'
  return 'webm'
}

function cleanText(value, fallback, maxLen = 500) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return fallback
  return trimmed.slice(0, maxLen)
}

function nullableText(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export async function handleUploadAudio(req, res) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!token) {
    return res.status(401).json({
      error: BETA_ERROR_CODES.AUTH_REQUIRED,
      message: 'Sign in required to upload audio.',
    })
  }

  const user = await verifyJwt(token)
  if (!user) {
    return res.status(401).json({
      error: BETA_ERROR_CODES.AUTH_REQUIRED,
      message: 'Invalid or expired session. Sign in again.',
    })
  }
  const { userId, email } = user

  // ── Request validation ────────────────────────────────────────────────────
  const {
    recordingId,
    mime: rawMime,
    duration_sec: rawDuration,
    course: rawCourse,
    course_id: rawCourseId,
    title: rawTitle,
    live_transcript: rawLiveTranscript,
    live_transcript_raw: rawLiveTranscriptRaw,
    translated_live_transcript: rawTranslatedLiveTranscript,
    source_language: rawSourceLanguage,
    translation_language: rawTranslationLanguage,
  } = req.body
  if (!recordingId || typeof recordingId !== 'string' || !/^[\w-]{8,}$/.test(recordingId)) {
    return res.status(400).json({ error: 'invalid_request', message: 'Invalid or missing recordingId' })
  }
  if (!req.file) {
    return res.status(400).json({ error: 'invalid_request', message: 'Missing file field' })
  }

  const mime = (rawMime || 'audio/webm').trim()
  const durationSec = rawDuration ? Number(rawDuration) : 0
  const course = cleanText(rawCourse, 'Course')
  // Canonical course link. The client resolves this by id, never by re-deriving
  // it from the `course` label here — a course rename must not orphan lectures.
  const courseId = nullableText(rawCourseId)
  const title = cleanText(rawTitle, 'Lecture')
  const liveTranscript = nullableText(rawLiveTranscript)
  const liveTranscriptRaw = nullableText(rawLiveTranscriptRaw)
  const translatedLiveTranscript = nullableText(rawTranslatedLiveTranscript)
  const { sourceLanguage, translationLanguage } = resolveContentLanguagePair({
    sourceLanguage: rawSourceLanguage,
    translationLanguage: rawTranslationLanguage,
  })

  // ── Beta gate: per-recording duration check ───────────────────────────────
  if (durationSec > 0) {
    const quota = await getEffectiveQuota(userId, email)
    const gate = checkUploadAllowed(quota, durationSec)
    if (!gate.allowed) {
      console.warn(
        '[upload-audio] beta_gate_blocked',
        JSON.stringify({
          userId: userId.slice(0, 8),
          recordingId,
          durationSec,
          code: gate.body.error,
        }),
      )
      return res.status(gate.status).json(gate.body)
    }
  }

  // ── Storage upload ────────────────────────────────────────────────────────
  const ext = mimeToExt(mime)
  const storagePath = `${userId}/${recordingId}.${ext}`

  const adminClient = makeAdminClient()
  if (!adminClient) {
    console.error('[upload-audio] SUPABASE_SERVICE_ROLE_KEY not configured')
    return res.status(503).json({ error: 'server_error', message: 'Server storage not configured' })
  }

  const { data: existingRecording, error: existingErr } = await adminClient
    .from('recordings')
    .select('id,user_id,storage_path')
    .eq('id', recordingId)
    .maybeSingle()

  if (existingErr) {
    console.error(
      '[upload-audio] database lookup error',
      JSON.stringify({
        userId: `${userId.slice(0, 8)}…`,
        recordingId,
        storagePath,
        code: existingErr.code ?? null,
        message: existingErr.message,
      }),
    )
    return res.status(502).json({
      error: 'database_error',
      message: `Recording lookup failed before upload: ${existingErr.message}`,
    })
  }

  if (existingRecording && existingRecording.user_id !== userId) {
    console.error(
      '[upload-audio] recording id ownership conflict',
      JSON.stringify({
        userId: `${userId.slice(0, 8)}…`,
        recordingId,
        storagePath,
      }),
    )
    return res.status(409).json({
      error: 'recording_conflict',
      message: 'This recording id already belongs to another account. Save again as a new recording.',
    })
  }

  console.warn(
    '[upload-audio] start',
    JSON.stringify({
      userId: `${userId.slice(0, 8)}…`,
      recordingId,
      storagePath,
      mime,
      bytes: req.file.size,
      durationSec,
      t: Date.now(),
    }),
  )

  const { error: upErr } = await adminClient.storage.from(BUCKET).upload(storagePath, req.file.buffer, {
    contentType: mime,
    upsert: true,
  })

  if (upErr) {
    console.error(
      '[upload-audio] storage error',
      JSON.stringify({
        userId: `${userId.slice(0, 8)}…`,
        recordingId,
        storagePath,
        error: upErr.message,
      }),
    )
    return res.status(502).json({ error: 'storage_error', message: `Storage upload failed: ${upErr.message}` })
  }

  const nowIso = new Date().toISOString()
  const recordingPayload = {
    id: recordingId,
    user_id: userId,
    course,
    course_id: courseId,
    title,
    duration_sec: Math.round(durationSec) || 0,
    mime,
    storage_path: storagePath,
    live_transcript: liveTranscript,
    live_transcript_raw: liveTranscriptRaw,
    translated_live_transcript: translatedLiveTranscript,
    source_language: sourceLanguage,
    translation_language: translationLanguage,
    ai_status: 'pending',
    ai_error: null,
    ai_updated_at: nowIso,
  }

  const { data: recording, error: dbErr } = await adminClient
    .from('recordings')
    .upsert(recordingPayload, { onConflict: 'id' })
    .select('*')
    .single()

  if (dbErr) {
    console.error(
      '[upload-audio] database error',
      JSON.stringify({
        userId: `${userId.slice(0, 8)}…`,
        recordingId,
        storagePath,
        code: dbErr.code ?? null,
        message: dbErr.message,
        details: dbErr.details ?? null,
        hint: dbErr.hint ?? null,
      }),
    )
    return res.status(502).json({
      error: 'database_error',
      message: `Audio uploaded, but recording save failed: ${dbErr.message}`,
      storagePath,
    })
  }

  console.warn(
    '[upload-audio] database ok',
    JSON.stringify({
      userId: `${userId.slice(0, 8)}…`,
      recordingId,
      storagePath,
      t: Date.now(),
    }),
  )

  // Log upload (non-billable, monitoring only)
  void recordBetaUsage(userId, email, recordingId, 'upload_audio', durationSec)

  console.warn(
    '[upload-audio] ok',
    JSON.stringify({ storagePath, bytes: req.file.size, t: Date.now() }),
  )

  return res.json({ storagePath, mime, size: req.file.size, recording })
}
