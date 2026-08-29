import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./processRecording.mjs', import.meta.url), 'utf8')
const recoverySource = readFileSync(new URL('./processingRecovery.mjs', import.meta.url), 'utf8')

describe('/api/process-recording recovery contract wiring', () => {
  it('derives durable stage before quota/lease work and no-ops complete recordings', () => {
    const decision = source.indexOf('determineProcessingResumeStage(row)')
    const complete = source.indexOf("status: 'already_complete'")
    const usageAudit = source.indexOf('hasRecordedProcessingUsage(userId, recordingId)')
    expect(decision).toBeGreaterThan(0)
    expect(complete).toBeGreaterThan(decision)
    expect(usageAudit).toBeGreaterThan(complete)
  })

  it('runs the normal quota gate only when no original usage event exists', () => {
    expect(source).toMatch(/if \(!usageAlreadyRecorded\) \{[\s\S]*checkProcessingAllowed\(quota, userId, durationSec\)/)
    expect(source).toContain("actionType: 'process_recording'")
  })

  it('acquires a durable lease before queueing work', () => {
    expect(source.indexOf('acquireProcessingLease(dbSb')).toBeLessThan(source.indexOf("ai_status: 'queued'"))
    expect(source).toContain("status: 'already_processing'")
    expect(source).toContain('renewProcessingLease(dbSb')
    expect(source).toContain('releaseProcessingLease(dbSb')
  })

  it('keeps transcription behind the transcription_then_summary branch', () => {
    const branch = source.indexOf('resumeStage === PROCESSING_RESUME_STAGES.TRANSCRIPTION_THEN_SUMMARY', source.indexOf('async function runJob'))
    const transcribe = source.indexOf('youmiHosted.transcribeAudioFromUrl', branch)
    const summaryOnlyElse = source.indexOf("jobLog('resume_summary_only'", branch)
    expect(branch).toBeGreaterThan(0)
    expect(transcribe).toBeGreaterThan(branch)
    expect(transcribe).toBeLessThan(summaryOnlyElse)
    const storageGuard = source.indexOf("row.storage_path.startsWith(`${userId}/`)", branch)
    expect(storageGuard).toBeGreaterThan(branch)
    expect(storageGuard).toBeLessThan(transcribe)
  })

  it('makes summary failure visible while preserving transcript-stage evidence', () => {
    const failure = source.slice(source.indexOf('const summarizeFailCore = {'), source.indexOf("v1PipelineLog('summary_failed'"))
    expect(failure).toContain("ai_status: 'failed'")
    expect(failure).not.toMatch(/transcript\s*:/)
    expect(failure).toContain('transcript_ready: true')
  })

  it('returns structured recovery states without an implicit regeneration path', () => {
    for (const status of [
      'already_processing',
      'already_complete',
      'resumed_from_transcription',
      'resumed_from_summary',
      'unrecoverable',
    ]) expect(`${source}\n${recoverySource}`).toContain(status)
    expect(source).not.toContain("const isRegeneration = row.ai_status")
    expect(source).not.toContain("betaActionType = isRegeneration")
  })

  it('does not import or mutate subscription/IAP modules', () => {
    expect(source).not.toMatch(/iapRoutes|iapSubscriptions|app_store_subscription|stripe/i)
  })
})
