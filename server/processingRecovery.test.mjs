import { describe, expect, it, vi } from 'vitest'

import {
  PROCESSING_RESUME_STAGES,
  acquireProcessingLease,
  determineProcessingResumeStage,
  executeProcessingRecovery,
  releaseProcessingLease,
  renewProcessingLease,
} from './processingRecovery.mjs'

const uploaded = {
  storage_path: 'user/recording.m4a',
  source_language: 'en',
  translation_language: 'zh-Hans',
}

class UpdateBuilder {
  constructor(db, patch) {
    this.db = db
    this.patch = patch
    this.filters = []
  }
  eq(key, value) { this.filters.push(['eq', key, value]); return this }
  lt(key, value) { this.filters.push(['lt', key, value]); return this }
  lte(key, value) { this.filters.push(['lte', key, value]); return this }
  select() { return this }
  async maybeSingle() {
    const recordingId = this.filters.find(([, key]) => key === 'recording_id')?.[2]
    const row = this.db.rows.get(recordingId)
    const matches = row && this.filters.every(([op, key, value]) => (
      op === 'eq' ? row[key] === value : (op === 'lt' ? row[key] < value : row[key] <= value)
    ))
    if (!matches) return { data: null, error: null }
    const next = { ...row, ...this.patch }
    this.db.rows.set(recordingId, next)
    return { data: { lease_token: next.lease_token }, error: null }
  }
}

class DeleteBuilder {
  constructor(db) { this.db = db; this.filters = [] }
  eq(key, value) { this.filters.push([key, value]); return this }
  then(resolve) {
    const recordingId = this.filters.find(([key]) => key === 'recording_id')?.[1]
    const row = this.db.rows.get(recordingId)
    if (row && this.filters.every(([key, value]) => row[key] === value)) this.db.rows.delete(recordingId)
    return Promise.resolve({ error: null }).then(resolve)
  }
}

class FakeLeaseDb {
  rows = new Map()
  from(table) {
    expect(table).toBe('recording_processing_leases')
    return {
      insert: async (row) => {
        if (this.rows.has(row.recording_id)) return { error: { code: '23505' } }
        this.rows.set(row.recording_id, { ...row })
        return { error: null }
      },
      update: (patch) => new UpdateBuilder(this, patch),
      delete: () => new DeleteBuilder(this),
    }
  }
}

describe('processing recovery stage selection', () => {
  it('runs transcription then summary for uploaded audio with no transcript', async () => {
    const transcribe = vi.fn(async () => 'persisted transcript')
    const summarize = vi.fn(async () => {})
    const result = await executeProcessingRecovery({
      recording: uploaded,
      transcribeAndPersist: transcribe,
      summarizeAndPersist: summarize,
    })
    expect(result.stage).toBe(PROCESSING_RESUME_STAGES.TRANSCRIPTION_THEN_SUMMARY)
    expect(transcribe).toHaveBeenCalledOnce()
    expect(summarize).toHaveBeenCalledWith('persisted transcript')
  })

  it('uses a persisted transcript for summary-only recovery', async () => {
    const transcribe = vi.fn()
    const summarize = vi.fn(async () => {})
    const recording = {
      source_language: 'en',
      translation_language: 'zh-Hans',
      transcript: 'existing transcript',
      ai_status: 'failed',
    }
    const result = await executeProcessingRecovery({
      recording,
      transcribeAndPersist: transcribe,
      summarizeAndPersist: summarize,
    })
    expect(result.stage).toBe(PROCESSING_RESUME_STAGES.SUMMARY_ONLY)
    expect(transcribe).not.toHaveBeenCalled()
    expect(summarize).toHaveBeenCalledWith('existing transcript')
  })

  it('does no work when durable transcript and summary content are complete', async () => {
    const transcribe = vi.fn()
    const summarize = vi.fn()
    const result = await executeProcessingRecovery({
      recording: {
        ...uploaded,
        transcript: 'T',
        source_summary: 'S',
        translated_summary: 'Z',
        ai_status: 'failed',
      },
      transcribeAndPersist: transcribe,
      summarizeAndPersist: summarize,
    })
    expect(result).toEqual({ stage: PROCESSING_RESUME_STAGES.COMPLETE, completed: true })
    expect(transcribe).not.toHaveBeenCalled()
    expect(summarize).not.toHaveBeenCalled()
  })

  it('preserves a persisted transcript when summary fails, then retries summary only', async () => {
    const recording = { ...uploaded }
    await expect(executeProcessingRecovery({
      recording,
      transcribeAndPersist: async () => {
        recording.transcript = 'durable transcript'
        return recording.transcript
      },
      summarizeAndPersist: async () => { throw new Error('summary failed') },
    })).rejects.toThrow('summary failed')
    expect(recording.transcript).toBe('durable transcript')

    const transcribe = vi.fn()
    const summarize = vi.fn(async () => {})
    await executeProcessingRecovery({ recording, transcribeAndPersist: transcribe, summarizeAndPersist: summarize })
    expect(transcribe).not.toHaveBeenCalled()
    expect(summarize).toHaveBeenCalledOnce()
  })

  it('does not run summary or create a transcript when transcription fails', async () => {
    const summarize = vi.fn()
    await expect(executeProcessingRecovery({
      recording: uploaded,
      transcribeAndPersist: async () => { throw new Error('transcription failed') },
      summarizeAndPersist: summarize,
    })).rejects.toThrow('transcription failed')
    expect(summarize).not.toHaveBeenCalled()
    expect(determineProcessingResumeStage(uploaded)).toBe(PROCESSING_RESUME_STAGES.TRANSCRIPTION_THEN_SUMMARY)
  })

  it('is unrecoverable without uploaded audio or a transcript', () => {
    expect(determineProcessingResumeStage({ ai_status: 'failed' })).toBe(PROCESSING_RESUME_STAGES.UNRECOVERABLE)
  })
})

describe('durable processing lease', () => {
  it('allows only one concurrent claimant for a recording', async () => {
    const db = new FakeLeaseDb()
    const args = { recordingId: 'r1', userId: 'u1', nowMs: 1_000, ttlMs: 500 }
    const [a, b] = await Promise.all([
      acquireProcessingLease(db, { ...args, leaseToken: 'a' }),
      acquireProcessingLease(db, { ...args, leaseToken: 'b' }),
    ])
    expect([a.acquired, b.acquired].filter(Boolean)).toHaveLength(1)
  })

  it('reclaims an expired worker lease and rejects reclaim before expiry', async () => {
    const db = new FakeLeaseDb()
    await acquireProcessingLease(db, { recordingId: 'r1', userId: 'u1', leaseToken: 'old', nowMs: 1_000, ttlMs: 500 })
    const early = await acquireProcessingLease(db, { recordingId: 'r1', userId: 'u1', leaseToken: 'early', nowMs: 1_499, ttlMs: 500 })
    const stale = await acquireProcessingLease(db, { recordingId: 'r1', userId: 'u1', leaseToken: 'new', nowMs: 1_500, ttlMs: 500 })
    expect(early.acquired).toBe(false)
    expect(stale).toMatchObject({ acquired: true, reclaimed: true })
  })

  it('renews and releases only the owning token', async () => {
    const db = new FakeLeaseDb()
    await acquireProcessingLease(db, { recordingId: 'r1', userId: 'u1', leaseToken: 'owner', nowMs: 1_000, ttlMs: 500 })
    expect((await renewProcessingLease(db, { recordingId: 'r1', leaseToken: 'other', nowMs: 1_200, ttlMs: 500 })).renewed).toBe(false)
    expect((await renewProcessingLease(db, { recordingId: 'r1', leaseToken: 'owner', nowMs: 1_200, ttlMs: 500 })).renewed).toBe(true)
    await releaseProcessingLease(db, { recordingId: 'r1', leaseToken: 'other' })
    expect(db.rows.has('r1')).toBe(true)
    await releaseProcessingLease(db, { recordingId: 'r1', leaseToken: 'owner' })
    expect(db.rows.has('r1')).toBe(false)
  })

  it('lets different recordings process independently', async () => {
    const db = new FakeLeaseDb()
    const [a, b] = await Promise.all([
      acquireProcessingLease(db, { recordingId: 'r1', userId: 'u1', leaseToken: 'a' }),
      acquireProcessingLease(db, { recordingId: 'r2', userId: 'u1', leaseToken: 'b' }),
    ])
    expect(a.acquired).toBe(true)
    expect(b.acquired).toBe(true)
  })
})
