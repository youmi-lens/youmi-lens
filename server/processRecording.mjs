import { createClient } from '@supabase/supabase-js'
import * as youmiHosted from './ai/hosted/youmiHosted.mjs'
import { CLIENT_SAFE_UNAVAILABLE } from './ai/errors.mjs'
import { recordDashscopeChatUsage } from './watchModelUsage.mjs'
import {
  canonicalizeLectureTranscript,
  transcriptCanonicalQualityGate,
} from '../src/lib/transcriptCanonicalCore.js'
import {
  getEffectiveQuota,
  checkProcessingAllowed,
  hasRecordedProcessingUsage,
  recordProcessingUsageOnce,
} from './betaGate.mjs'
import { qwenLanguageFor, resolveContentLanguagePair, shouldTranslate, legacySummaryMirror } from './contentLanguages.mjs'
import {
  PROCESSING_LEASE_TTL_MS,
  PROCESSING_RESUME_STAGES,
  acquireProcessingLease,
  determineProcessingResumeStage,
  newProcessingLeaseToken,
  processingAcceptedStatus,
  releaseProcessingLease,
  renewProcessingLease,
} from './processingRecovery.mjs'

const BUCKET = 'lecture-audio'

const processingIds = new Set()
const PROCESSING_LEASE_RENEW_MS = Math.max(
  10_000,
  Math.min(60_000, Math.floor(PROCESSING_LEASE_TTL_MS / 3)),
)

const PROCESSING_RECORDING_COLUMNS = [
  'id',
  'user_id',
  'duration_sec',
  'created_at',
  'storage_path',
  'course',
  'title',
  'source_language',
  'translation_language',
  'transcript',
  'summary_en',
  'summary_zh',
  'source_summary',
  'translated_summary',
  'ai_status',
  'ai_error',
].join(',')

function v1PipelineLog(event, fields) {
  console.warn(`[V1Pipeline] ${event}`, JSON.stringify({ ...fields, t: new Date().toISOString() }))
  if (process.env.YOUMI_PIPELINE_TRACE === '1') {
    console.info(JSON.stringify({ source: 'v1_pipeline', event, ...fields }))
  }
}

/**
 * User-scoped client (JWT) for auth + Storage (RLS). Optional service-role client for `recordings` writes
 * so POST /api/process-recording can persist ai_status / transcript after ownership is verified.
 * Never use service role without `.eq('user_id', userId)` on recordings.
 */
function createSupabaseClients(supabaseUrl, anonKey, jwt) {
  const userSb = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  })
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  const dbSb = serviceRole
    ? createClient(supabaseUrl, serviceRole, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : userSb
  return { userSb, dbSb, usingServiceRoleForRecordings: Boolean(serviceRole) }
}

function logPostgrestError(scope, err, ctx = {}) {
  if (!err) return
  console.error(
    `[process-recording] ${scope}`,
    JSON.stringify(
      {
        table: 'recordings',
        ...ctx,
        message: err.message,
        code: err.code,
        details: err.details,
        hint: err.hint,
      },
      null,
      2,
    ),
  )
}

/**
 * Best-effort write of v1 pipeline columns (requires supabase-migration-v1-pipeline-flags.sql).
 * Never fails the job — core transcript/summary rows must persist without these columns.
 */
async function tryOptionalV1PipelineExtras(dbSb, recordingId, userId, patch, label) {
  const keys = Object.keys(patch)
  const { error } = await dbSb
    .from('recordings')
    .update(patch)
    .eq('id', recordingId)
    .eq('user_id', userId)
  if (error) {
    console.warn(
      `[process-recording] supabase optional_column_update_failed`,
      JSON.stringify({
        label,
        recordingId,
        userIdPrefix: userId.slice(0, 8),
        patchKeys: keys,
        columnNames: keys,
        migrationHint:
          'Run supabase-migration-v1-pipeline-flags.sql for transcript_ready/summary_ready/translation_ready/ai_pipeline_timing.',
        message: error.message,
        code: error.code,
        details: error.details,
        postgrestHint: error.hint,
      }),
    )
    return false
  }
  console.warn(`[process-recording] supabase update_ok`, JSON.stringify({ label, recordingId, patchKeys: keys }))
  return true
}

const TRANSCRIPT_TRANSLATE_CHUNK_CHARS = 1600

/**
 * Split a transcript into translation-sized chunks, preferring paragraph then
 * sentence boundaries, so each LLM translation call stays well within model
 * input/output limits. A pathologically long sentence is hard-sliced.
 */
function chunkTranscriptForTranslation(text, maxChars = TRANSCRIPT_TRANSLATE_CHUNK_CHARS) {
  const clean = String(text ?? '').trim()
  if (!clean) return []
  if (clean.length <= maxChars) return [clean]

  const chunks = []
  let buf = ''
  const flush = () => {
    const trimmed = buf.trim()
    if (trimmed) chunks.push(trimmed)
    buf = ''
  }
  const pushPiece = (piece, joiner) => {
    if (!piece) return
    if (buf && buf.length + joiner.length + piece.length > maxChars) flush()
    buf = buf ? `${buf}${joiner}${piece}` : piece
  }

  for (const paragraph of clean.split(/\n{2,}/)) {
    const para = paragraph.trim()
    if (!para) continue
    if (para.length <= maxChars) {
      pushPiece(para, '\n\n')
      continue
    }
    flush()
    for (const sentence of para.split(/(?<=[.!?。！？])\s+/)) {
      const s = sentence.trim()
      if (!s) continue
      if (s.length <= maxChars) {
        pushPiece(s, ' ')
        continue
      }
      flush()
      for (let i = 0; i < s.length; i += maxChars) chunks.push(s.slice(i, i + maxChars))
    }
    flush()
  }
  flush()
  return chunks
}

/**
 * Translate an English transcript to Chinese, chunk by chunk, via the existing
 * hosted translation helper (the same one used for live-caption translation).
 * Throws if any chunk fails — the caller treats translation as best-effort and
 * never fails the job over it.
 */
async function translateTranscript(transcript, sourceLanguage, translationLanguage) {
  const chunks = chunkTranscriptForTranslation(transcript)
  if (chunks.length === 0) return ''
  const source = qwenLanguageFor(sourceLanguage)
  const target = qwenLanguageFor(translationLanguage)
  const out = []
  for (let i = 0; i < chunks.length; i += 1) {
    const translated = await youmiHosted.translateText(chunks[i], target.name, source.name)
    out.push(typeof translated === 'string' ? translated.trim() : '')
  }
  return out.join('\n\n').trim()
}

/**
 * Best-effort write of the Chinese transcript. Never fails the job: a missing
 * transcript_zh column (supabase-migration-transcript-zh.sql not yet applied)
 * or any write error is logged and swallowed so the English transcript and
 * summaries are unaffected.
 */
async function persistTranslatedTranscript(dbSb, recordingId, userId, translated, translationLanguage) {
  const patch = { translated_transcript: translated }
  if (translationLanguage === 'zh-Hans') patch.transcript_zh = translated
  const { error } = await dbSb.from('recordings').update(patch).eq('id', recordingId).eq('user_id', userId)
  if (error) throw error
}

/**
 * POST /api/process-recording
 * Body: { recordingId: string }
 * Header: Authorization: Bearer <Supabase user JWT>
 */
export async function handleProcessRecording(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
  const caps = youmiHosted.hostedCapabilities()

  console.warn(
    '[process-recording] received',
    JSON.stringify({
      hasRecordingId: Boolean(req.body?.recordingId),
      transcribeCap: caps.transcribe,
      marker: process.env.YOUMI_DEPLOY_MARKER || null,
    }),
  )

  if (!supabaseUrl || !anonKey) {
    res.status(503).json({ error: CLIENT_SAFE_UNAVAILABLE })
    return
  }

  const authHeader = req.headers.authorization
  const jwt = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!jwt) {
    res.status(401).json({ error: 'Sign in again to continue.' })
    return
  }

  const recordingId = req.body?.recordingId
  if (!recordingId || typeof recordingId !== 'string') {
    res.status(400).json({ error: 'Invalid request' })
    return
  }

  if (processingIds.has(recordingId)) {
    res.status(202).json({ ok: true, status: 'already_processing', recordingId, deduped: true })
    return
  }

  const { userSb, dbSb, usingServiceRoleForRecordings } = createSupabaseClients(supabaseUrl, anonKey, jwt)

  const { data: userData, error: userErr } = await userSb.auth.getUser()
  const userId = userData.user?.id
  if (userErr || !userId) {
    res.status(401).json({ error: 'Sign in again to continue.' })
    return
  }

  const { data: row, error: rowErr } = await userSb
    .from('recordings')
    .select(PROCESSING_RECORDING_COLUMNS)
    .eq('id', recordingId)
    .eq('user_id', userId)
    .maybeSingle()

  if (rowErr || !row) {
    if (rowErr) logPostgrestError('enqueue select recording', rowErr)
    res.status(404).json({ error: 'Recording not found.' })
    return
  }

  let resumeStage = determineProcessingResumeStage(row)
  if (resumeStage === PROCESSING_RESUME_STAGES.COMPLETE) {
    if (row.ai_status !== 'done' || row.ai_error) {
      const { error: healErr } = await dbSb
        .from('recordings')
        .update({ ai_status: 'done', ai_error: null, ai_updated_at: new Date().toISOString() })
        .eq('id', recordingId)
        .eq('user_id', userId)
      if (healErr) logPostgrestError('heal complete recording status', healErr, { recordingId })
    }
    res.status(200).json({ ok: true, status: 'already_complete', recordingId })
    return
  }
  if (resumeStage === PROCESSING_RESUME_STAGES.UNRECOVERABLE) {
    res.status(409).json({
      ok: false,
      status: 'unrecoverable',
      error: 'No uploaded audio or persisted transcript is available for recovery.',
      recordingId,
    })
    return
  }
  if (
    (resumeStage === PROCESSING_RESUME_STAGES.TRANSCRIPTION_THEN_SUMMARY && !caps.transcribe)
    || !caps.summarize
  ) {
    res.status(503).json({ ok: false, status: 'unavailable', error: CLIENT_SAFE_UNAVAILABLE, recordingId })
    return
  }

  const durationSec = Number(row.duration_sec) || 0
  const email = userData.user?.email || ''
  let usageAlreadyRecorded
  try {
    usageAlreadyRecorded = await hasRecordedProcessingUsage(userId, recordingId)
  } catch (error) {
    console.error('[process-recording] usage audit failed', error)
    res.status(503).json({ ok: false, status: 'unavailable', error: 'Processing usage could not be verified.' })
    return
  }

  // A retry for a recording that already has its original billable event must
  // not be blocked or charged again. A genuinely new job still uses the normal
  // quota gate before any AI work is accepted.
  if (!usageAlreadyRecorded) {
    const quota = await getEffectiveQuota(userId, email)
    const gate = await checkProcessingAllowed(quota, userId, durationSec)
    if (!gate.allowed) {
      console.warn(
        '[process-recording] beta_gate_blocked',
        JSON.stringify({
          userId: userId.slice(0, 8),
          recordingId,
          durationSec,
          actionType: 'process_recording',
          code: gate.body.error,
        }),
      )
      res.status(gate.status).json(gate.body)
      return
    }
  }

  if (!usingServiceRoleForRecordings) {
    res.status(503).json({ ok: false, status: 'unavailable', error: 'Durable processing coordination is unavailable.' })
    return
  }

  const leaseToken = newProcessingLeaseToken()
  let lease
  try {
    lease = await acquireProcessingLease(dbSb, { recordingId, userId, leaseToken })
  } catch (error) {
    console.error('[process-recording] durable lease claim failed', error)
    res.status(503).json({ ok: false, status: 'unavailable', error: 'Processing coordination failed.' })
    return
  }
  if (!lease.acquired) {
    res.status(202).json({ ok: true, status: 'already_processing', recordingId, deduped: true })
    return
  }

  const releaseClaim = async () => {
    try {
      await releaseProcessingLease(dbSb, { recordingId, leaseToken })
    } catch (error) {
      console.error('[process-recording] durable lease release failed', error)
    }
  }

  // Re-read after winning the claim. Another worker may have completed between
  // the first snapshot and our atomic lease acquisition.
  const { data: claimedRow, error: claimedRowErr } = await dbSb
    .from('recordings')
    .select(PROCESSING_RECORDING_COLUMNS)
    .eq('id', recordingId)
    .eq('user_id', userId)
    .maybeSingle()
  if (claimedRowErr || !claimedRow) {
    if (claimedRowErr) logPostgrestError('claimed recording refresh', claimedRowErr, { recordingId })
    await releaseClaim()
    res.status(404).json({ error: 'Recording not found.' })
    return
  }
  resumeStage = determineProcessingResumeStage(claimedRow)
  if (resumeStage === PROCESSING_RESUME_STAGES.COMPLETE) {
    await releaseClaim()
    res.status(200).json({ ok: true, status: 'already_complete', recordingId })
    return
  }
  if (resumeStage === PROCESSING_RESUME_STAGES.UNRECOVERABLE) {
    await releaseClaim()
    res.status(409).json({ ok: false, status: 'unrecoverable', error: 'Recovery source is unavailable.', recordingId })
    return
  }

  processingIds.add(recordingId)

  console.warn(
    '[process-recording] enqueue',
    JSON.stringify({ recordingId, userIdPrefix: userId.slice(0, 8), t: new Date().toISOString() }),
  )

  const now = new Date().toISOString()
  const enqueuePayloadKeys = ['ai_status', 'ai_error', 'ai_updated_at']
  /** Step: enqueue job — UPDATE ai_status -> queued (fails here => client sees "Could not update recording.") */
  console.warn(
    '[process-recording] supabase update start',
    JSON.stringify({
      step: 'enqueue_ai_status_queued',
      recordingId,
      userIdPrefix: userId.slice(0, 8),
      table: 'recordings',
      payloadKeys: enqueuePayloadKeys,
      usingServiceRoleForRecordings,
    }),
  )
  const { error: upErr } = await dbSb
    .from('recordings')
    .update({
      ai_status: 'queued',
      ai_error: null,
      ai_updated_at: now,
    })
    .eq('id', recordingId)
    .eq('user_id', userId)

  if (upErr) {
    console.warn('[process-recording] supabase update error', JSON.stringify({ step: 'enqueue_ai_status_queued', recordingId }))
    logPostgrestError('enqueue update ai_status=queued', upErr, {
      recordingId,
      userIdPrefix: userId.slice(0, 8),
      payloadKeys: enqueuePayloadKeys,
    })
    processingIds.delete(recordingId)
    await releaseClaim()
    res.status(500).json({
      error: 'Could not update recording.',
      step: 'enqueue_ai_status_queued',
      supabaseError: {
        message: upErr.message,
        code: upErr.code,
        details: upErr.details,
        hint: upErr.hint,
      },
      usingServiceRoleForRecordings,
    })
    return
  }

  const acceptedStatus = processingAcceptedStatus(resumeStage)
  res.status(202).json({
    ok: true,
    status: acceptedStatus,
    resumeStage,
    recordingId,
    usageAlreadyRecorded,
    usingServiceRoleForRecordings,
  })

  setImmediate(() => {
    runJob({
      userSb,
      dbSb,
      userId,
      email,
      recordingId,
      durationSec,
      resumeStage,
      recording: claimedRow,
      usageAlreadyRecorded,
      leaseToken,
      usingServiceRoleForRecordings,
    }).finally(() => {
      processingIds.delete(recordingId)
      void releaseClaim()
    })
  })
}

function jobLog(phase, payload) {
  console.warn(
    `[process-recording] ${phase}`,
    JSON.stringify({ ...payload, t: new Date().toISOString() }),
  )
}

async function runJob({
  userSb,
  dbSb,
  userId,
  email,
  recordingId,
  durationSec,
  resumeStage,
  recording,
  usageAlreadyRecorded,
  leaseToken,
  usingServiceRoleForRecordings,
}) {
  const jobT0 = Date.now()
  // Bounded, content-free per-job timing — durations and stage outcomes only,
  // never transcript/summary text. uploadToJobStartMs is the only figure that
  // needs the recording's own creation time; everything else is measured
  // relative to jobT0 below.
  const createdAtMs = recording?.created_at ? Date.parse(recording.created_at) : NaN
  const uploadToJobStartMs = Number.isFinite(createdAtMs) ? Math.max(0, jobT0 - createdAtMs) : null
  const stageTimings = { transcript_persist_ms: null, translation_ms: null, final_persist_ms: null }
  const stageOutcomes = { transcript: null, translation: null, summary: null }
  const heartbeat = setInterval(() => {
    void renewProcessingLease(dbSb, { recordingId, leaseToken }).then(({ renewed }) => {
      if (!renewed) jobLog('lease_lost', { recordingId })
    }).catch((error) => {
      jobLog('lease_renew_failed', { recordingId, message: error instanceof Error ? error.message : String(error) })
    })
  }, PROCESSING_LEASE_RENEW_MS)

  const markFailed = async (msg) => {
    jobLog('mark_failed', { recordingId, userId: userId.slice(0, 8), message: msg })
    const { error } = await dbSb
      .from('recordings')
      .update({
        ai_status: 'failed',
        ai_error: msg,
        ai_updated_at: new Date().toISOString(),
      })
      .eq('id', recordingId)
      .eq('user_id', userId)
    if (error) logPostgrestError('markFailed', error)
  }

  /**
   * DashScope's SUCCESS_WITH_NO_VALID_FRAGMENT (see youmiHosted.mjs's
   * paraformerFailureErrorCode) means transcription genuinely completed —
   * it just found no speech. That is a valid empty result, not a processing
   * failure: the lecture must still reach Ready to Review, with an empty
   * transcript/summary rather than being stuck at Processing Failed.
   *
   * This writes the SAME core columns the normal success path eventually
   * writes (transcript/transcript_raw + the summary quartet + ai_status:
   * 'done'), just atomically in one update instead of two, since there is
   * nothing to transcribe/translate/summarize — no hosted chat call is made
   * for empty content. `determineProcessingResumeStage` treats `ai_status
   * === 'done'` as authoritative (see processingRecovery.mjs), so a later
   * resume/retry will not misread this empty transcript as "never
   * transcribed" and resubmit the same audio.
   */
  const markDoneEmptyNoSpeech = async () => {
    jobLog('transcribe_no_speech_ready', { recordingId, userId: userId.slice(0, 8) })
    const emptySuccessPayload = {
      transcript_raw: '',
      transcript: '',
      summary_en: '',
      summary_zh: '',
      source_summary: '',
      translated_summary: null,
      ai_status: 'done',
      ai_error: null,
      ai_updated_at: new Date().toISOString(),
    }
    let { error } = await dbSb
      .from('recordings')
      .update(emptySuccessPayload)
      .eq('id', recordingId)
      .eq('user_id', userId)
    if (error) {
      // Same fallback as the normal transcript-save path just above:
      // production's `recordings` table has no `transcript_raw` column
      // (PostgREST error PGRST204, "column ... not found in the schema
      // cache") — confirmed the real cause of a second production incident,
      // 2026-09-28, recording b1aee347-08be-4b45-b12f-3e3e7a0cd869, where
      // this write's OWN failure (not a new DashScope case) fell through to
      // markFailed and produced a visible "Could not save transcription
      // result." error despite transcription having genuinely completed.
      const msg = String(error.message || '')
      const looksLikeMissingColumn = /transcript_raw|column/i.test(msg)
      if (looksLikeMissingColumn) {
        jobLog('no_speech_ready_retry_without_transcript_raw', { recordingId, firstError: msg })
        const { transcript_raw: _omit, ...minimalPayload } = emptySuccessPayload
        const retry = await dbSb
          .from('recordings')
          .update(minimalPayload)
          .eq('id', recordingId)
          .eq('user_id', userId)
        error = retry.error
      }
    }
    if (error) {
      logPostgrestError('markDoneEmptyNoSpeech', error, {
        recordingId,
        userIdPrefix: userId.slice(0, 8),
        payloadKeys: Object.keys(emptySuccessPayload),
      })
      // The row must never be left stuck mid-flight (e.g. still
      // 'transcribing') if the empty-success write itself fails — that is a
      // real, if rare, failure the user should see, not a silent hang.
      await markFailed('Could not save transcription result.')
      return
    }
    await tryOptionalV1PipelineExtras(
      dbSb,
      recordingId,
      userId,
      {
        transcript_ready: true,
        summary_ready: true,
        translation_ready: true,
        ai_pipeline_timing: {
          job_start_to_transcript_ready_ms: Date.now() - jobT0,
        },
      },
      'no_speech_ready_flags',
    )
    jobLog('job_done_no_speech', { recordingId })
  }

  jobLog('job_start', {
    recordingId,
    userIdPrefix: userId.slice(0, 8),
    usingServiceRoleForRecordings,
  })

  try {
    /** Prefer service-role reads when available: avoids RLS/JWT edge cases that return 0 rows for user client. */
    const metaClient = usingServiceRoleForRecordings ? dbSb : userSb
    const { data: refreshedRow, error: metaErr } = await metaClient
      .from('recordings')
      .select('storage_path,course,title')
      .eq('id', recordingId)
      .eq('user_id', userId)
      .maybeSingle()
    const row = refreshedRow ? { ...recording, ...refreshedRow } : recording

    if (metaErr || !row) {
      if (metaErr) logPostgrestError('runJob select meta', metaErr)
      jobLog('meta_missing', {
        recordingId,
        metaErr: metaErr ? metaErr.message : null,
        usedClient: usingServiceRoleForRecordings ? 'service_role' : 'user_jwt',
      })
      await markFailed('Recording could not be loaded.')
      return
    }

    jobLog('meta_ok', {
      recordingId,
      storagePathTail: row.storage_path?.includes('/')
        ? row.storage_path.slice(row.storage_path.lastIndexOf('/') + 1)
        : row.storage_path,
      usedClient: usingServiceRoleForRecordings ? 'service_role' : 'user_jwt',
    })

    const { sourceLanguage, translationLanguage } = resolveContentLanguagePair({
      sourceLanguage: row.source_language,
      translationLanguage: row.translation_language,
    })

    if (
      resumeStage === PROCESSING_RESUME_STAGES.TRANSCRIPTION_THEN_SUMMARY
      && (!row.storage_path || !row.storage_path.startsWith(`${userId}/`))
    ) {
      await markFailed('Invalid storage path for this recording.')
      return
    }

    if (!usageAlreadyRecorded) {
      await recordProcessingUsageOnce(userId, email || '', recordingId, durationSec || 0)
    }

    let transcriptCanonical = typeof row.transcript === 'string' ? row.transcript.trim() : ''
    let transcriptReadyMs = 0

    if (resumeStage === PROCESSING_RESUME_STAGES.TRANSCRIPTION_THEN_SUMMARY) {
    const { error: stErr } = await dbSb
      .from('recordings')
      .update({
        ai_status: 'transcribing',
        ai_updated_at: new Date().toISOString(),
      })
      .eq('id', recordingId)
      .eq('user_id', userId)
    if (stErr) {
      logPostgrestError('runJob update transcribing', stErr)
      await markFailed('Could not update recording status.')
      return
    }

    jobLog('status_transcribing', { recordingId })

    const signedTtlSec = Number(process.env.YUMI_STORAGE_SIGNED_URL_SEC || 7200)
    const { data: signed, error: signErr } = await userSb.storage
      .from(BUCKET)
      .createSignedUrl(row.storage_path, signedTtlSec)

    if (signErr || !signed?.signedUrl) {
      logPostgrestError('runJob storage signed url', signErr)
      jobLog('signed_url_failed', { recordingId, signErr: signErr?.message ?? 'no url' })
      await markFailed('Could not prepare audio for processing.')
      return
    }

    const pathTail = row.storage_path.includes('/')
      ? row.storage_path.slice(row.storage_path.lastIndexOf('/') + 1)
      : row.storage_path
    // Diagnostic only — its result (content-length/type) never gates or
    // informs transcription, so it must not block the transcribe submit on
    // the critical path. Fire-and-forget; logs the same fields as before.
    void fetch(signed.signedUrl, { method: 'HEAD' })
      .then((headRes) => {
        jobLog('audio_head', {
          recordingId,
          storageObjectTail: pathTail,
          headStatus: headRes.status,
          contentLength: headRes.headers.get('content-length') ?? 'absent',
          contentType: headRes.headers.get('content-type') ?? 'absent',
        })
      })
      .catch((hErr) => {
        jobLog('audio_head_failed', {
          recordingId,
          storageObjectTail: pathTail,
          message: String(hErr),
        })
      })

    let transcriptRaw
    const transcribeT0 = Date.now()
    try {
      jobLog('transcribe_begin', { recordingId })
      transcriptRaw = await youmiHosted.transcribeAudioFromUrl(signed.signedUrl, [qwenLanguageFor(sourceLanguage).code])
      // Submit vs. provider-queue-wait aren't split out here: the hosted
      // adapter (youmiHosted.mjs) owns that boundary internally and is a
      // stateless, recording-agnostic module — splitting it would mean
      // threading recordingId through a shared AI-provider adapter for a
      // number that's provider-queue-dominated anyway (see Task D evidence:
      // 42s-6min variance). This combined figure still separates OUR total
      // transcribe wall time from provider queue time in the BEFORE/AFTER report.
      stageTimings.transcribe_ms = Date.now() - transcribeT0
      jobLog('transcribe_done', { recordingId, textLen: transcriptRaw?.length ?? 0, transcribe_ms: stageTimings.transcribe_ms })
    } catch (e) {
      console.warn('[process-recording] transcribe', e)
      const errMessage = e instanceof Error ? e.message : String(e)
      jobLog('transcribe_error', { recordingId, message: errMessage })
      // HOSTED_TRANSCRIBE_NO_SPEECH is DashScope's own terminal
      // "ran to completion, found no speech" code (see youmiHosted.mjs's
      // paraformerFailureErrorCode) — a valid EMPTY result, not a processing
      // failure. The lecture must still reach Ready to Review rather than
      // being stuck at Processing Failed — see markDoneEmptyNoSpeech.
      // Every other transcription failure keeps the original generic
      // markFailed behavior completely unchanged.
      if (errMessage === 'HOSTED_TRANSCRIBE_NO_SPEECH') {
        await markDoneEmptyNoSpeech()
      } else {
        await markFailed('Transcription did not finish. Try again in a moment.')
      }
      return
    }

    const gate = transcriptCanonicalQualityGate(transcriptRaw)
    if (!gate.ok) {
      jobLog('canonical_quality_gate', { recordingId, reason: gate.reason ?? 'unknown' })
    }
    const canonicalized = canonicalizeLectureTranscript(transcriptRaw)
    transcriptCanonical = canonicalized.canonical
    const canonDiag = canonicalized.diagnostics
    jobLog('canonical_ok', { recordingId, ...canonDiag })

    transcriptReadyMs = Date.now() - jobT0
    v1PipelineLog('timing', {
      recordingId,
      transcript_ready_ms: transcriptReadyMs,
    })

    jobLog('transcribe_success', { recordingId, textLen: transcriptRaw?.length ?? 0 })

    /** Core columns only — works without v1 migration (no transcript_ready / ai_pipeline_timing columns). */
    const transcriptSavePayload = {
      transcript_raw: transcriptRaw,
      transcript: transcriptCanonical,
      ai_status: 'transcript_ready',
      ai_error: null,
      ai_updated_at: new Date().toISOString(),
    }
    const transcriptSaveKeys = Object.keys(transcriptSavePayload)
    console.warn(
      '[process-recording] supabase update start',
      JSON.stringify({
        step: 'persist_transcript_core',
        recordingId,
        userIdPrefix: userId.slice(0, 8),
        table: 'recordings',
        payloadKeys: transcriptSaveKeys,
        usingServiceRoleForRecordings,
      }),
    )

    const transcriptPersistT0 = Date.now()
    let { error: txErr } = await dbSb
      .from('recordings')
      .update(transcriptSavePayload)
      .eq('id', recordingId)
      .eq('user_id', userId)
    if (txErr) {
      const msg = String(txErr.message || '')
      const looksLikeMissingColumn = /transcript_raw|column/i.test(msg)
      if (looksLikeMissingColumn) {
        jobLog('transcript_save_retry_without_transcript_raw', { recordingId, firstError: msg })
        const minimalPayload = {
          transcript: transcriptCanonical,
          ai_status: 'transcript_ready',
          ai_error: null,
          ai_updated_at: new Date().toISOString(),
        }
        const r2 = await dbSb
          .from('recordings')
          .update(minimalPayload)
          .eq('id', recordingId)
          .eq('user_id', userId)
        txErr = r2.error
        if (!txErr) {
          console.warn(
            '[process-recording] transcript_saved_minimal',
            JSON.stringify({ recordingId, note: 'transcript_raw column missing; run supabase-migration-transcript-canonical.sql' }),
          )
        }
      }
    }
    if (txErr) {
      console.warn('[process-recording] supabase update error', JSON.stringify({ step: 'persist_transcript_core', recordingId }))
      logPostgrestError('runJob update transcript (core columns)', txErr, {
        recordingId,
        userIdPrefix: userId.slice(0, 8),
        payloadKeys: transcriptSaveKeys,
      })
      await markFailed('Could not save transcript after transcription.')
      return
    }
    stageTimings.transcript_persist_ms = Date.now() - transcriptPersistT0
    stageOutcomes.transcript = 'executed'

    console.warn('[process-recording] done', JSON.stringify({ phase: 'transcript_saved_core', recordingId }))

    await tryOptionalV1PipelineExtras(
      dbSb,
      recordingId,
      userId,
      {
        transcript_ready: true,
        summary_ready: false,
        translation_ready: false,
        ai_pipeline_timing: {
          job_start_to_transcript_ready_ms: transcriptReadyMs,
        },
      },
      'after_transcript_flags',
    )

    jobLog('status_transcript_ready', {
      recordingId,
      transcript_ready_ms: transcriptReadyMs,
      transcriptLen: transcriptCanonical.length,
      transcriptRawLen: transcriptRaw.length,
    })
    } else {
      stageOutcomes.transcript = 'reused'
      jobLog('resume_summary_only', {
        recordingId,
        transcriptLen: transcriptCanonical.length,
      })
    }

    // Transcript translation (best-effort, writes translated_transcript /
    // transcript_zh) and summarization (required, writes summary_en /
    // summary_zh / source_summary / translated_summary) both depend only on
    // the already-persisted canonical transcript — never on each other's
    // output — and write disjoint columns, so they run concurrently instead
    // of serially to cut wall time. translateStageDone is started here but
    // deliberately not awaited yet; it keeps running while summarization
    // proceeds below, and is joined (awaited) at each exit point so the job
    // never returns with it still in flight. Its own semantics are unchanged:
    // still gated the same way, still best-effort, still never fails the job.
    const canTranslate = youmiHosted.hostedCapabilities().translate
    const wantTranscriptTranslation = (
      resumeStage === PROCESSING_RESUME_STAGES.TRANSCRIPTION_THEN_SUMMARY
      && canTranslate
      && shouldTranslate(sourceLanguage, translationLanguage)
    )
    const translateStageDone = wantTranscriptTranslation
      ? (async () => {
          stageOutcomes.translation = 'executed'
          const translateT0 = Date.now()
          jobLog('transcript_translate_begin', {
            recordingId,
            transcriptLen: transcriptCanonical.length,
          })
          const translatedTranscript = await translateTranscript(transcriptCanonical, sourceLanguage, translationLanguage)
          if (translatedTranscript) {
            await persistTranslatedTranscript(dbSb, recordingId, userId, translatedTranscript, translationLanguage)
            stageTimings.translation_ms = Date.now() - translateT0
            jobLog('transcript_translate_done', { recordingId, translatedTranscriptLen: translatedTranscript.length, translationLanguage })
          } else {
            stageTimings.translation_ms = Date.now() - translateT0
            jobLog('transcript_translate_empty', { recordingId })
          }
        })().catch((e) => {
          // Logged and swallowed — the Chinese transcript is optional study support.
          console.warn('[process-recording] transcript_translate', e)
          jobLog('transcript_translate_error', {
            recordingId,
            message: e instanceof Error ? e.message : String(e),
          })
        })
      : (
        stageOutcomes.translation = 'skipped',
        jobLog('transcript_translate_skipped', { recordingId, reason: canTranslate ? 'source_equals_target' : 'translate_unconfigured' }),
        Promise.resolve()
      )

    const canSummarize = youmiHosted.hostedCapabilities().summarize
    if (!canSummarize) {
      await translateStageDone
      jobLog('job_done_no_summarize', { recordingId })
      v1PipelineLog('job_partial', { recordingId, reason: 'summarize_unconfigured' })
      return
    }

    const { error: summarizingStatusErr } = await dbSb
      .from('recordings')
      .update({
        ai_status: 'summarizing',
        ai_error: null,
        ai_updated_at: new Date().toISOString(),
      })
      .eq('id', recordingId)
      .eq('user_id', userId)
    if (summarizingStatusErr) {
      logPostgrestError('runJob update summarizing', summarizingStatusErr, { recordingId })
      await markFailed('Could not update recording status.')
      return
    }

    let sourceSummary
    let translatedSummary
    const summarizeWallT0 = Date.now()
    try {
      jobLog('summarize_begin', { recordingId })
      const s = await youmiHosted.summarizeTranscript(transcriptCanonical, row.course, row.title, {
        sourceLanguage,
        translationLanguage,
      })
      sourceSummary = s.sourceSummary
      translatedSummary = s.translatedSummary
      // Best-effort: record DashScope/Qwen token usage for this successful
      // summary as internal cost-ledger events (Phase 5B). Fire-and-forget —
      // never blocks or fails the job; records nothing if usage is absent.
      void recordDashscopeChatUsage({
        usage: s.usage,
        userId,
        recordingId,
        eventType: 'summary',
        feature: 'after_class_summary',
      })
      stageOutcomes.summary = 'executed'
      jobLog('summarize_done', {
        recordingId,
        sourceSummaryLen: sourceSummary?.length ?? 0,
        translatedSummaryLen: translatedSummary?.length ?? 0,
      })
    } catch (e) {
      console.warn('[process-recording] summarize', e)
      jobLog('summarize_error', { recordingId, message: e instanceof Error ? e.message : String(e) })
      // Join the concurrently-running translation stage before returning —
      // it writes independent columns and its outcome (success or its own
      // already-swallowed failure) is unaffected by this summarize failure.
      await translateStageDone
      jobLog('stage_timings', {
        recordingId,
        outcome: 'summary_failed',
        upload_to_job_start_ms: uploadToJobStartMs,
        transcribe_ms: stageTimings.transcribe_ms ?? null,
        transcript_persist_ms: stageTimings.transcript_persist_ms,
        translation_ms: stageTimings.translation_ms,
        summary_ms: Date.now() - summarizeWallT0,
        final_persist_ms: null,
        total_processing_ms: Date.now() - jobT0,
        stages: { ...stageOutcomes, summary: 'failed' },
      })
      const summarizeFailCore = {
        // Failure is terminal/visible to clients, while the persisted transcript
        // remains authoritative evidence that the next retry is summary-only.
        ai_status: 'failed',
        ai_error:
          'Summaries did not finish. Your transcript is available — you can try again shortly.',
        ai_updated_at: new Date().toISOString(),
      }
      console.warn(
        '[process-recording] supabase update start',
        JSON.stringify({
          step: 'summarize_fail_core',
          recordingId,
          payloadKeys: Object.keys(summarizeFailCore),
        }),
      )
      const { error: sumFailErr } = await dbSb
        .from('recordings')
        .update(summarizeFailCore)
        .eq('id', recordingId)
        .eq('user_id', userId)
      if (sumFailErr) {
        console.warn('[process-recording] supabase update error', JSON.stringify({ step: 'summarize_fail_core', recordingId }))
        logPostgrestError('runJob summarize fail persist (core)', sumFailErr, {
          recordingId,
          userIdPrefix: userId.slice(0, 8),
          payloadKeys: Object.keys(summarizeFailCore),
        })
      } else {
        await tryOptionalV1PipelineExtras(
          dbSb,
          recordingId,
          userId,
          {
            transcript_ready: true,
            summary_ready: false,
            translation_ready: false,
            ai_pipeline_timing: {
              ...(transcriptReadyMs > 0 ? { job_start_to_transcript_ready_ms: transcriptReadyMs } : {}),
              summarize_failed_ms: Date.now() - jobT0,
            },
          },
          'summarize_fail_flags',
        )
      }
      v1PipelineLog('summary_failed', { recordingId, transcript_ready_ms: transcriptReadyMs })
      return
    }

    const summaryReadyMs = Date.now() - jobT0
    v1PipelineLog('timing', {
      recordingId,
      transcript_ready_ms: transcriptReadyMs,
      summary_ready_ms: summaryReadyMs,
      summarize_wall_ms: Date.now() - summarizeWallT0,
    })

    // Join the concurrently-running translation stage — by this point
    // summarization has already taken at least as long, so this almost never
    // adds wait time; it only bounds the job's lifecycle so a fast summarize
    // can't return while translation is still writing its own columns.
    await translateStageDone

    const translationRequired = shouldTranslate(sourceLanguage, translationLanguage)
    const summaryOk = Boolean(sourceSummary?.trim() && (!translationRequired || translatedSummary?.trim()))
    /** Summary success path: persist the complete language pair atomically. */
    // Legacy language-specific mirror: each legacy column holds the summary
    // version in THAT language, whether it is the source or the translated one.
    // Non-English/non-Chinese summaries are never written into these columns.
    const { summary_en, summary_zh } = legacySummaryMirror(
      sourceLanguage,
      translationLanguage,
      sourceSummary,
      translatedSummary,
    )
    // The authoritative generic fields and terminal status must land in one
    // atomic row update. Otherwise a client can observe `done`, stop polling,
    // and permanently miss the generic translated summary written afterward.
    const donePayload = {
      summary_en,
      summary_zh,
      source_summary: sourceSummary,
      translated_summary: translationRequired ? translatedSummary : null,
      ai_status: 'done',
      ai_error: null,
      ai_updated_at: new Date().toISOString(),
    }
    const doneColumns = Object.keys(donePayload)
    console.warn(
      '[process-recording] supabase update start',
      JSON.stringify({
        step: 'final_done_summaries',
        recordingId,
        userIdPrefix: userId.slice(0, 8),
        table: 'recordings',
        payloadKeys: doneColumns,
        columnsWritten: doneColumns,
        usingServiceRoleForRecordings,
      }),
    )
    const finalPersistT0 = Date.now()
    const { error: doneErr } = await dbSb
      .from('recordings')
      .update(donePayload)
      .eq('id', recordingId)
      .eq('user_id', userId)
    stageTimings.final_persist_ms = Date.now() - finalPersistT0
    if (doneErr) {
      console.warn(
        '[process-recording] supabase update error',
        JSON.stringify({
          step: 'final_done_summaries',
          recordingId,
          userIdPrefix: userId.slice(0, 8),
          payloadKeys: doneColumns,
          columnsWritten: doneColumns,
          message: doneErr.message,
          code: doneErr.code,
          details: doneErr.details,
          hint: doneErr.hint,
        }),
      )
      logPostgrestError('runJob final done summaries', doneErr, {
        recordingId,
        userIdPrefix: userId.slice(0, 8),
        payloadKeys: doneColumns,
        columnsWritten: doneColumns,
      })
      await markFailed('Could not save summaries after processing.')
    } else {
      await tryOptionalV1PipelineExtras(
        dbSb,
        recordingId,
        userId,
        {
          transcript_ready: true,
          summary_ready: summaryOk,
          translation_ready: summaryOk,
          ai_pipeline_timing: {
            ...(transcriptReadyMs > 0 ? { job_start_to_transcript_ready_ms: transcriptReadyMs } : {}),
            job_start_to_summary_ready_ms: summaryReadyMs,
            summarize_wall_ms: Date.now() - summarizeWallT0,
          },
        },
        'final_done_flags',
      )
      jobLog('stage_timings', {
        recordingId,
        outcome: 'done',
        upload_to_job_start_ms: uploadToJobStartMs,
        transcribe_ms: stageTimings.transcribe_ms ?? null,
        transcript_persist_ms: stageTimings.transcript_persist_ms,
        translation_ms: stageTimings.translation_ms,
        summary_ms: Date.now() - summarizeWallT0,
        final_persist_ms: stageTimings.final_persist_ms,
        total_processing_ms: Date.now() - jobT0,
        stages: stageOutcomes,
      })
      jobLog('job_done', { recordingId, summary_ready_ms: summaryReadyMs })
      console.warn('[process-recording] done', JSON.stringify({ phase: 'job_complete', recordingId }))
    }
  } catch (e) {
    console.warn('[process-recording] job', e)
    jobLog('job_throw', { recordingId, message: e instanceof Error ? e.message : String(e) })
    await markFailed('Something went wrong while processing this lecture.')
  } finally {
    clearInterval(heartbeat)
  }
}
