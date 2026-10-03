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

  it('starts transcript translation before summarization, without awaiting it first (concurrent, not serial)', () => {
    const runJob = source.slice(source.indexOf('async function runJob'))
    const translateStart = runJob.indexOf('const translateStageDone =')
    // The no-summarize early return is its own exit path (asserted separately
    // below) — the parallelism claim is about the path that actually reaches
    // summarization, so the "between" window starts after that branch closes.
    const summarizingUpdate = runJob.indexOf("ai_status: 'summarizing'", translateStart)
    const summarizeCall = runJob.indexOf('await youmiHosted.summarizeTranscript(')
    expect(translateStart).toBeGreaterThan(0)
    expect(summarizingUpdate).toBeGreaterThan(translateStart)
    expect(summarizeCall).toBeGreaterThan(summarizingUpdate)
    // No `await translateStageDone` between where the stage is kicked off and
    // where summarization is awaited — proves translation runs in the
    // background while summarization proceeds, not before it.
    const between = runJob.slice(summarizingUpdate, summarizeCall)
    expect(between).not.toMatch(/await translateStageDone/)
  })

  it('joins the concurrent translation stage on every exit path (summarize failure, summarize success, and no-summarize)', () => {
    const runJob = source.slice(source.indexOf('async function runJob'))
    const translateStart = runJob.indexOf('const translateStageDone =')
    const noSummarizeJoin = runJob.indexOf('await translateStageDone', translateStart)
    const failureJoin = runJob.indexOf('await translateStageDone', runJob.indexOf("jobLog('summarize_error'"))
    const successJoin = runJob.indexOf('await translateStageDone', runJob.indexOf("v1PipelineLog('timing'", failureJoin))
    expect(noSummarizeJoin).toBeGreaterThan(translateStart)
    expect(failureJoin).toBeGreaterThan(runJob.indexOf("jobLog('summarize_error'"))
    expect(successJoin).toBeGreaterThan(0)
    expect(successJoin).toBeLessThan(runJob.indexOf('const donePayload = {'))
  })

  it('the diagnostic audio HEAD request never blocks transcription on the critical path', () => {
    const runJob = source.slice(source.indexOf('async function runJob'))
    const headStart = runJob.indexOf("fetch(signed.signedUrl, { method: 'HEAD' })")
    const transcribeBegin = runJob.indexOf("jobLog('transcribe_begin'")
    expect(headStart).toBeGreaterThan(0)
    expect(transcribeBegin).toBeGreaterThan(headStart)
    // Not `await fetch(...)` — the HEAD request must be fire-and-forget so its
    // network round trip never delays the transcribe submit that follows it.
    expect(runJob.slice(headStart - 10, headStart)).not.toMatch(/await\s*$/)
  })

  it('emits bounded, content-free per-stage timing/outcome instrumentation on both the done and summary-failed paths', () => {
    const runJob = source.slice(source.indexOf('async function runJob'))
    const occurrences = [...runJob.matchAll(/jobLog\('stage_timings', \{[\s\S]*?\}\)/g)].map((m) => m[0])
    expect(occurrences.length).toBe(2)
    for (const block of occurrences) {
      for (const field of [
        'upload_to_job_start_ms',
        'transcribe_ms',
        'transcript_persist_ms',
        'translation_ms',
        'summary_ms',
        'final_persist_ms',
        'total_processing_ms',
        'stages',
      ]) {
        expect(block).toContain(field)
      }
      // Only durations/labels — never the transcript or summary text itself.
      expect(block).not.toMatch(/sourceSummary|translatedSummary|transcriptCanonical|transcriptRaw/)
    }
  })

  it('translation and summarization persist disjoint columns, so one failing cannot destroy the other\'s durable result', () => {
    const translateColumns = source.slice(
      source.indexOf('async function persistTranslatedTranscript'),
      source.indexOf('async function persistTranslatedTranscript') + 400,
    )
    expect(translateColumns).toMatch(/translated_transcript/)
    expect(translateColumns).toMatch(/transcript_zh/)
    expect(translateColumns).not.toMatch(/summary_en|summary_zh|source_summary|translated_summary|ai_status/)
  })
})
