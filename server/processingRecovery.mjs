import { randomUUID } from 'node:crypto'

export const PROCESSING_RESUME_STAGES = Object.freeze({
  COMPLETE: 'complete',
  SUMMARY_ONLY: 'summary_only',
  TRANSCRIPTION_THEN_SUMMARY: 'transcription_then_summary',
  UNRECOVERABLE: 'unrecoverable',
})

const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1000

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function summaryForLanguage(recording, language) {
  if (language === 'en') return recording.summary_en
  if (language === 'zh-Hans') return recording.summary_zh
  return null
}

/**
 * Durable content, not a transient ai_status, determines the next stage.
 * A persisted canonical transcript is authoritative: recovery never sends the
 * audio through transcription again unless that transcript is absent.
 */
export function determineProcessingResumeStage(recording) {
  const row = recording ?? {}
  const sourceLanguage = row.source_language || 'en'
  const translationLanguage = row.translation_language || 'zh-Hans'
  const translationRequired = sourceLanguage !== translationLanguage
  const transcriptReady = nonEmpty(row.transcript)
  const sourceSummary = nonEmpty(row.source_summary)
    ? row.source_summary
    : summaryForLanguage(row, sourceLanguage)
  const translatedSummary = nonEmpty(row.translated_summary)
    ? row.translated_summary
    : summaryForLanguage(row, translationLanguage)
  const summaryReady = nonEmpty(sourceSummary)
    && (!translationRequired || nonEmpty(translatedSummary))

  if (transcriptReady && summaryReady) return PROCESSING_RESUME_STAGES.COMPLETE
  if (transcriptReady) return PROCESSING_RESUME_STAGES.SUMMARY_ONLY
  if (nonEmpty(row.storage_path)) return PROCESSING_RESUME_STAGES.TRANSCRIPTION_THEN_SUMMARY
  return PROCESSING_RESUME_STAGES.UNRECOVERABLE
}

/** Execute only the stages selected from durable state. */
export async function executeProcessingRecovery({
  recording,
  transcribeAndPersist,
  summarizeAndPersist,
}) {
  const stage = determineProcessingResumeStage(recording)
  if (stage === PROCESSING_RESUME_STAGES.COMPLETE) return { stage, completed: true }
  if (stage === PROCESSING_RESUME_STAGES.UNRECOVERABLE) return { stage, completed: false }

  let transcript = recording.transcript?.trim() || ''
  if (stage === PROCESSING_RESUME_STAGES.TRANSCRIPTION_THEN_SUMMARY) {
    transcript = await transcribeAndPersist()
  }
  await summarizeAndPersist(transcript)
  return { stage, completed: true }
}

export function newProcessingLeaseToken() {
  return randomUUID()
}

function leaseExpiry(nowMs, ttlMs) {
  return new Date(nowMs + ttlMs).toISOString()
}

/**
 * Claim by INSERT first. If a row already exists, a conditional UPDATE may
 * reclaim it only after expiry. PostgreSQL rechecks the UPDATE predicate after
 * waiting on a concurrent row lock, so only one stale-lease claimant wins.
 */
export async function acquireProcessingLease(db, {
  recordingId,
  userId,
  leaseToken,
  nowMs = Date.now(),
  ttlMs = DEFAULT_LEASE_TTL_MS,
}) {
  const now = new Date(nowMs).toISOString()
  const expiresAt = leaseExpiry(nowMs, ttlMs)
  const row = {
    recording_id: recordingId,
    user_id: userId,
    lease_token: leaseToken,
    lease_expires_at: expiresAt,
    updated_at: now,
  }
  const inserted = await db.from('recording_processing_leases').insert(row)
  if (!inserted.error) return { acquired: true, expiresAt, reclaimed: false }
  if (inserted.error.code !== '23505') throw inserted.error

  const { data, error } = await db
    .from('recording_processing_leases')
    .update({
      user_id: userId,
      lease_token: leaseToken,
      lease_expires_at: expiresAt,
      updated_at: now,
    })
    .eq('recording_id', recordingId)
    .lte('lease_expires_at', now)
    .select('lease_token')
    .maybeSingle()
  if (error) throw error
  return { acquired: data?.lease_token === leaseToken, expiresAt, reclaimed: Boolean(data) }
}

export async function renewProcessingLease(db, {
  recordingId,
  leaseToken,
  nowMs = Date.now(),
  ttlMs = DEFAULT_LEASE_TTL_MS,
}) {
  const now = new Date(nowMs).toISOString()
  const expiresAt = leaseExpiry(nowMs, ttlMs)
  const { data, error } = await db
    .from('recording_processing_leases')
    .update({ lease_expires_at: expiresAt, updated_at: now })
    .eq('recording_id', recordingId)
    .eq('lease_token', leaseToken)
    .select('lease_token')
    .maybeSingle()
  if (error) throw error
  return { renewed: data?.lease_token === leaseToken, expiresAt }
}

export async function releaseProcessingLease(db, { recordingId, leaseToken }) {
  const { error } = await db
    .from('recording_processing_leases')
    .delete()
    .eq('recording_id', recordingId)
    .eq('lease_token', leaseToken)
  if (error) throw error
}

export function processingAcceptedStatus(stage) {
  if (stage === PROCESSING_RESUME_STAGES.SUMMARY_ONLY) return 'resumed_from_summary'
  if (stage === PROCESSING_RESUME_STAGES.TRANSCRIPTION_THEN_SUMMARY) return 'resumed_from_transcription'
  if (stage === PROCESSING_RESUME_STAGES.COMPLETE) return 'already_complete'
  return 'unrecoverable'
}

export const PROCESSING_LEASE_TTL_MS = DEFAULT_LEASE_TTL_MS
