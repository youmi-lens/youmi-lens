import { describe, expect, it, vi } from 'vitest'
import {
  createProcessingRequester,
  isRetryableEnqueueStatus,
  lectureListStatus,
  shouldRequestProcessing,
} from './lectureProcessing'

/**
 * Root cause, proven 2026-10-04 against production for lecture 4e606f1d…:
 *   - Railway: POST /api/upload-audio 200, then ZERO /api/process-recording
 *     requests in the whole window.
 *   - recordings row: ai_status='pending', ai_updated_at == created_at,
 *     transcript NULL, summary NULL, live_transcript 1613 chars.
 * Desktop's Stop & Save never asked the server to process, and the V2 shell has
 * no manual "Generate" button (the legacy shell's was the only trigger).
 */

const hosted = { aiExpected: true, hasAudio: true } as const

describe('shouldRequestProcessing — when Desktop must ask the server to process', () => {
  it('requests for a freshly saved hosted lecture still at ai_status=pending', () => {
    expect(shouldRequestProcessing({ ...hosted, aiStatus: 'pending' })).toBe(true)
  })

  it('requests when ai_status is absent on a cloud row with audio', () => {
    expect(shouldRequestProcessing({ ...hosted })).toBe(true)
  })

  it('does NOT request while a job is already in flight (server dedupes, but do not hammer it)', () => {
    for (const aiStatus of ['queued', 'transcribing', 'summarizing', 'transcript_ready']) {
      expect(shouldRequestProcessing({ ...hosted, aiStatus })).toBe(false)
    }
  })

  it('does NOT request once the outputs exist', () => {
    expect(
      shouldRequestProcessing({ ...hosted, aiStatus: 'done', transcript: 'x', summaryEn: 'y' }),
    ).toBe(false)
  })

  it('does NOT auto-retry a failed job — failure is explicit and the user retries', () => {
    expect(shouldRequestProcessing({ ...hosted, aiStatus: 'failed' })).toBe(false)
  })

  it('does NOT request for local-only / own-key lectures (no hosted pipeline applies)', () => {
    expect(shouldRequestProcessing({ aiExpected: false, hasAudio: true, aiStatus: 'pending' })).toBe(false)
  })

  it('does NOT request without persisted audio — nothing to process', () => {
    expect(shouldRequestProcessing({ aiExpected: true, hasAudio: false, aiStatus: 'pending' })).toBe(false)
  })
})

describe('createProcessingRequester — exactly-once per lecture, failure is recorded', () => {
  const ok = { ok: true } as const

  it('sends one request per lecture even if triggered repeatedly (effect re-runs, double click)', async () => {
    const send = vi.fn().mockResolvedValue(ok)
    const requester = createProcessingRequester(send)
    await Promise.all([requester.request('a'), requester.request('a'), requester.request('a')])
    await requester.request('a')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('treats different lectures independently', async () => {
    const send = vi.fn().mockResolvedValue(ok)
    const requester = createProcessingRequester(send)
    await requester.request('a')
    await requester.request('b')
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('reports a rejected enqueue as failed and allows an explicit retry', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, message: 'quota' })
      .mockResolvedValueOnce(ok)
    const requester = createProcessingRequester(send)

    expect(await requester.request('a')).toEqual({ ok: false, message: 'quota' })
    expect(requester.failed('a')).toBe(true)

    // Not retried automatically...
    await requester.request('a')
    expect(send).toHaveBeenCalledTimes(1)

    // ...but an explicit retry goes through and clears the failure.
    expect(await requester.retry('a')).toEqual(ok)
    expect(send).toHaveBeenCalledTimes(2)
    expect(requester.failed('a')).toBe(false)
  })

  it('a thrown network error is a failure, never an unhandled rejection or a silent success', async () => {
    const send = vi.fn().mockRejectedValue(new Error('offline'))
    // No automatic retries here: this case is about the failure being recorded.
    const requester = createProcessingRequester(send, { backoffMs: [] })
    const out = await requester.request('a')
    expect(out.ok).toBe(false)
    expect(requester.failed('a')).toBe(true)
  })

  it('notifies subscribers when failure state changes so the UI can leave "Processing"', async () => {
    const send = vi.fn().mockResolvedValueOnce({ ok: false, message: 'x' }).mockResolvedValueOnce(ok)
    const requester = createProcessingRequester(send)
    const seen: boolean[] = []
    requester.subscribe(() => seen.push(requester.failed('a')))
    await requester.request('a')
    expect(requester.failed('a')).toBe(true)
    await requester.retry('a')
    expect(requester.failed('a')).toBe(false)
    // The UI was told about the failure and about its clearing (it also hears
    // about requests starting, which is why this is not an exact sequence).
    expect(seen).toContain(true)
    expect(seen[seen.length - 1]).toBe(false)
  })
})

describe('lectureListStatus — list badges follow the same lifecycle as the detail page', () => {
  it('shows Processing, not Ready, for saved audio whose hosted AI is pending', () => {
    expect(lectureListStatus({ hasAudio: true, aiStatus: 'pending' }, { aiExpected: true })).toBe('Processing')
  })

  it('shows Ready only when the transcript and summary exist', () => {
    expect(
      lectureListStatus(
        { hasAudio: true, aiStatus: 'done', transcriptReady: true, summaryReady: true },
        { aiExpected: true },
      ),
    ).toBe('Ready')
  })

  it('shows Failed for a failed job or a failed enqueue, even with audio', () => {
    expect(lectureListStatus({ hasAudio: true, aiStatus: 'failed' }, { aiExpected: true })).toBe('Failed')
    expect(
      lectureListStatus({ hasAudio: true, aiStatus: 'pending' }, { aiExpected: true, requestFailed: true }),
    ).toBe('Failed')
  })

  it('keeps Ready on saved audio where no hosted pipeline applies', () => {
    expect(lectureListStatus({ hasAudio: true, aiStatus: 'pending' }, { aiExpected: false })).toBe('Ready')
  })
})

/**
 * Round 4 — the request must survive a busy or briefly unreachable backend.
 * Supabase answered in 8–25s on 2026-10-04, so the enqueue could time out or find
 * the row not yet visible; a single attempt then left a saved lecture unprocessed.
 */
describe('createProcessingRequester — transient failures are retried, definite ones are not', () => {
  const noSleep = async () => undefined

  it('retries a transient failure and succeeds, without ever showing failure', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, message: 'busy', retryable: true })
      .mockResolvedValueOnce({ ok: false, message: 'busy', retryable: true })
      .mockResolvedValueOnce({ ok: true })
    const requester = createProcessingRequester(send, { sleep: noSleep })
    const out = await requester.request('a')
    expect(out.ok).toBe(true)
    expect(send).toHaveBeenCalledTimes(3)
    expect(requester.failed('a')).toBe(false)
    expect(requester.accepted('a')).toBe(true)
  })

  it('retries a thrown network error / timeout (always transient)', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({ ok: true })
    const out = await createProcessingRequester(send, { sleep: noSleep }).request('a')
    expect(out.ok).toBe(true)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a definite refusal (sign-in, quota, forbidden)', async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, message: 'Daily limit reached', retryable: false })
    const requester = createProcessingRequester(send, { sleep: noSleep })
    const out = await requester.request('a')
    expect(out.ok).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
    expect(requester.failed('a')).toBe(true)
  })

  it('gives up after the backoff is exhausted and surfaces an explicit failure', async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, message: 'busy', retryable: true })
    const requester = createProcessingRequester(send, { sleep: noSleep, backoffMs: [1, 2, 3] })
    const out = await requester.request('a')
    expect(out.ok).toBe(false)
    expect(send).toHaveBeenCalledTimes(4)
    expect(requester.failed('a')).toBe(true)
  })

  it('waits the configured backoff between attempts', async () => {
    const waits: number[] = []
    const send = vi.fn().mockResolvedValue({ ok: false, message: 'x', retryable: true })
    await createProcessingRequester(send, {
      backoffMs: [10, 20],
      sleep: async (ms) => {
        waits.push(ms)
      },
    }).request('a')
    expect(waits).toEqual([10, 20])
  })

  it('before a RE-attempt, a lecture that already moved past pending is treated as handed over — no repeat request', async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, message: 'lost answer', retryable: true })
    const stillPending = vi.fn().mockResolvedValue(false)
    const requester = createProcessingRequester(send, { sleep: noSleep, stillPending })
    const out = await requester.request('a')
    expect(out.ok).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(stillPending).toHaveBeenCalledTimes(1)
  })

  it('an unreadable status does not block the retry (assume it still needs the request)', async () => {
    const send = vi.fn().mockResolvedValueOnce({ ok: false, message: 'x', retryable: true }).mockResolvedValueOnce({ ok: true })
    const stillPending = vi.fn().mockRejectedValue(new Error('db slow'))
    const out = await createProcessingRequester(send, { sleep: noSleep, stillPending }).request('a')
    expect(out.ok).toBe(true)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('stays idempotent per lecture while retrying: concurrent callers share one run', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true })
    const requester = createProcessingRequester(send, { sleep: noSleep })
    await Promise.all([requester.request('a'), requester.request('a'), requester.request('a')])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('reports an outstanding request, so a pending lecture with a request in flight is followed', async () => {
    let release!: () => void
    const send = vi.fn().mockImplementation(() => new Promise((r) => (release = () => r({ ok: true }))))
    const requester = createProcessingRequester(send, { sleep: noSleep })
    const pending = requester.request('a')
    expect(requester.requesting('a')).toBe(true)
    release()
    await pending
    expect(requester.requesting('a')).toBe(false)
    expect(requester.accepted('a')).toBe(true)
  })

  it('user Retry uses the same lecture and clears the failure first', async () => {
    const send = vi.fn().mockResolvedValueOnce({ ok: false, message: 'x', retryable: false }).mockResolvedValueOnce({ ok: true })
    const requester = createProcessingRequester(send, { sleep: noSleep })
    await requester.request('a')
    expect(requester.failed('a')).toBe(true)
    const out = await requester.retry('a')
    expect(out.ok).toBe(true)
    expect(requester.failed('a')).toBe(false)
    expect(send.mock.calls.map((c) => c[0])).toEqual(['a', 'a'])
  })
})

describe('isRetryableEnqueueStatus', () => {
  it('retries network-level, not-yet-visible and server-busy answers', () => {
    for (const status of [undefined, 404, 408, 425, 500, 502, 503, 504]) {
      expect(isRetryableEnqueueStatus(status), String(status)).toBe(true)
    }
  })
  it('does not retry definite answers', () => {
    for (const status of [400, 401, 402, 403, 409, 422, 429]) {
      expect(isRetryableEnqueueStatus(status), String(status)).toBe(false)
    }
  })
})
