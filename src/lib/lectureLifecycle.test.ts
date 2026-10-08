import { describe, expect, it } from 'vitest'
import {
  IN_FLIGHT_STATUSES,
  lectureLifecycle,
  mergeServerAiFields,
  phaseForStatus,
  preferNewerAiState,
  provisionalForOpen,
  STALL_AFTER_MS,
} from './lectureLifecycle'

/**
 * One lifecycle for every surface (list badge, saved screen, detail, reopen).
 * Round 4, 2026-10-04: a result appeared, the lecture was left and reopened, and
 * it was gone. The invariant these tests hold:
 *
 *   IF the transcript and a summary are persisted, the lecture is Ready — at any
 *   later time, whatever the status or the client believes.
 */

const base = { hasAudio: true, aiExpected: true }

describe('persisted outputs win', () => {
  it('transcript + summary ⇒ ready, for EVERY server status', () => {
    for (const aiStatus of ['pending', 'queued', 'transcribing', 'transcript_ready', 'summarizing', 'done', 'failed', null, undefined]) {
      const life = lectureLifecycle({ ...base, aiStatus, transcript: 'T', summaryEn: 'S' })
      expect(life.kind, String(aiStatus)).toBe('ready')
      expect(life.complete).toBe(true)
    }
  })

  it('a Chinese-only summary counts', () => {
    expect(lectureLifecycle({ ...base, aiStatus: 'done', transcript: 'T', summaryZh: '摘要' }).kind).toBe('ready')
  })

  it('a request failure on the client cannot make a finished lecture look unfinished', () => {
    expect(lectureLifecycle({ ...base, aiStatus: 'done', transcript: 'T', summaryEn: 'S', requestFailed: true }).kind).toBe('ready')
  })

  it('whitespace is not an output', () => {
    expect(lectureLifecycle({ ...base, aiStatus: 'done', transcript: '  ', summaryEn: '\n' }).kind).not.toBe('ready')
  })
})

describe('the phases are exactly the states the backend distinguishes', () => {
  it.each([
    ['pending', 'waiting'],
    ['queued', 'waiting'],
    ['transcribing', 'transcribing'],
    ['transcript_ready', 'summarizing'],
    ['summarizing', 'summarizing'],
    ['done', 'done'],
    ['failed', 'failed'],
  ] as const)('%s → %s', (status, phase) => {
    expect(phaseForStatus(status)).toBe(phase)
  })

  it('unknown statuses map to nothing — no invented stage', () => {
    expect(phaseForStatus('preparing')).toBeNull()
    expect(phaseForStatus(null)).toBeNull()
  })

  it('processing rows carry their phase', () => {
    expect(lectureLifecycle({ ...base, aiStatus: 'pending' })).toMatchObject({ kind: 'processing', phase: 'waiting' })
    expect(lectureLifecycle({ ...base, aiStatus: 'queued' })).toMatchObject({ kind: 'processing', phase: 'waiting' })
    expect(lectureLifecycle({ ...base, aiStatus: 'transcribing' })).toMatchObject({ kind: 'processing', phase: 'transcribing' })
    expect(lectureLifecycle({ ...base, aiStatus: 'summarizing' })).toMatchObject({ kind: 'processing', phase: 'summarizing' })
  })

  it('a saved row with audio and no status yet is waiting, not Ready', () => {
    expect(lectureLifecycle({ ...base })).toMatchObject({ kind: 'processing', phase: 'waiting' })
  })

  it('transcript without summary is usable and, while in flight, still summarizing', () => {
    expect(lectureLifecycle({ ...base, aiStatus: 'summarizing', transcript: 'T' })).toMatchObject({
      kind: 'transcript_only',
      phase: 'summarizing',
    })
    expect(lectureLifecycle({ ...base, aiStatus: 'done', transcript: 'T' })).toMatchObject({ kind: 'transcript_only', phase: null })
  })

  it('failed without outputs is failed — and so is a rejected request', () => {
    expect(lectureLifecycle({ ...base, aiStatus: 'failed' })).toMatchObject({ kind: 'failed', phase: 'failed' })
    expect(lectureLifecycle({ ...base, aiStatus: 'pending', requestFailed: true })).toMatchObject({ kind: 'failed' })
  })

  it('done with nothing to show (e.g. silent audio) is "none" — nothing more is coming', () => {
    expect(lectureLifecycle({ ...base, aiStatus: 'done' }).kind).toBe('none')
  })
})

describe('audio alone is never Ready for a hosted lecture', () => {
  it('saved audio + hosted AI + no outputs is never ready', () => {
    for (const aiStatus of ['pending', 'queued', 'transcribing', 'summarizing', 'failed']) {
      expect(lectureLifecycle({ ...base, aiStatus }).kind, aiStatus).not.toBe('ready')
    }
  })

  it('local-only / own-key lectures (no hosted pipeline) stay Ready on audio', () => {
    expect(lectureLifecycle({ hasAudio: true, aiExpected: false, aiStatus: 'pending' }).kind).toBe('ready')
  })
})

describe('stalled', () => {
  const now = 10_000_000
  it('flags an in-flight job with no progress for a long time', () => {
    expect(lectureLifecycle({ ...base, aiStatus: 'transcribing', aiUpdatedAt: now - STALL_AFTER_MS - 1, now }).stalled).toBe(true)
  })
  it('does not flag recent progress, pending rows, or finished lectures', () => {
    expect(lectureLifecycle({ ...base, aiStatus: 'transcribing', aiUpdatedAt: now - 1000, now }).stalled).toBe(false)
    expect(lectureLifecycle({ ...base, aiStatus: 'pending', aiUpdatedAt: now - STALL_AFTER_MS * 5, now }).stalled).toBe(false)
    expect(lectureLifecycle({ ...base, aiStatus: 'done', transcript: 'T', summaryEn: 'S', aiUpdatedAt: 0, now }).stalled).toBe(false)
  })
  it('lists the statuses that mean a job exists', () => {
    expect([...IN_FLIGHT_STATUSES].sort()).toEqual(['queued', 'summarizing', 'transcribing', 'transcript_ready'])
  })
})

describe('mergeServerAiFields', () => {
  it('overlays only the server-owned fields and leaves what the client owns', () => {
    const row = { id: 'a', title: 'My title', notes: 'mine', aiStatus: 'transcribing' as const }
    const out = mergeServerAiFields(row, { aiStatus: 'done', transcript: 'T', summaryEn: 'S' })
    expect(out).toMatchObject({ id: 'a', title: 'My title', notes: 'mine', aiStatus: 'done', transcript: 'T', summaryEn: 'S' })
  })
  it('does not touch a field the server result did not mention', () => {
    const out = mergeServerAiFields({ transcript: 'kept' }, { aiStatus: 'summarizing' })
    expect(out.transcript).toBe('kept')
  })
})

describe('provisionalForOpen — what may be painted the instant a lecture opens', () => {
  const finished = { storagePath: 'u/a.webm', aiStatus: 'done' as const, transcript: 'T', summaryEn: 'S' }

  it('a finished lecture with its audio location may be shown early', () => {
    expect(provisionalForOpen(finished)).toMatchObject({ storagePath: 'u/a.webm', transcript: 'T' })
  })

  it('an unfinished or in-flight snapshot may NOT — it could be stale (the reopen bug)', () => {
    for (const aiStatus of ['pending', 'queued', 'transcribing', 'summarizing', 'failed', 'done'] as const) {
      expect(provisionalForOpen({ storagePath: 'u/a.webm', aiStatus }), aiStatus).toBeNull()
    }
  })

  it('nothing without an audio location, and nothing for a missing row', () => {
    expect(provisionalForOpen({ ...finished, storagePath: undefined })).toBeNull()
    expect(provisionalForOpen(undefined)).toBeNull()
  })
})

describe('preferNewerAiState — an older list read never drags a lecture backwards', () => {
  const done = { id: 'a', aiStatus: 'done' as const, aiUpdatedAt: 2000, transcript: 'T', summaryEn: 'S' }
  const staleList = { id: 'a', aiStatus: 'transcribing' as const, aiUpdatedAt: 1000 }

  it('keeps the newer local AI state and its fetched text', () => {
    const out = preferNewerAiState([done], [staleList])
    expect(out[0]).toMatchObject({ aiStatus: 'done', aiUpdatedAt: 2000, transcript: 'T', summaryEn: 'S' })
  })

  it('takes a genuinely newer server row', () => {
    const out = preferNewerAiState([staleList], [done])
    expect(out[0]).toMatchObject({ aiStatus: 'done', transcript: 'T' })
  })

  it('takes the server row when it has the same clock, and for lectures it has not seen', () => {
    expect(preferNewerAiState([done], [{ ...done, transcript: 'T2' }])[0].transcript).toBe('T2')
    expect(preferNewerAiState([], [staleList])).toEqual([staleList])
  })

  it('a re-requested lecture (server clock moves forward) is not frozen on the old state', () => {
    const regenerating = { id: 'a', aiStatus: 'queued' as const, aiUpdatedAt: 3000 }
    expect(preferNewerAiState([done], [regenerating])[0].aiStatus).toBe('queued')
  })
})
