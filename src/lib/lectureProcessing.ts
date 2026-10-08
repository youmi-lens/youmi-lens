/**
 * Starting and presenting hosted AI processing for a saved lecture.
 *
 * WHY THIS EXISTS (production incident 2026-10-04, lecture 4e606f1d…)
 * Stop & Save uploaded the audio and the server wrote `ai_status='pending'` —
 * and then NOTHING asked the server to process it. `/api/upload-audio` never
 * enqueues work; only `POST /api/process-recording` does, and the only callers
 * were a manual button in the legacy shell and the pending-upload retry path.
 * The V2 shell had neither, so the row stayed pending forever (Railway showed
 * zero process-recording requests) while the UI read "Ready".
 *
 * The server side is already idempotent (`already_processing` dedupe,
 * `already_complete`, durable coordination) and quota-gated, so the client's job
 * is only: ask once, record a rejection honestly, and let the user retry.
 */
import type { LectureStatus } from '../components/CoursesPage'
import { hasAnySummary, lectureLifecycle } from './lectureLifecycle'

export type ProcessingTriggerInput = {
  /** A hosted AI pipeline applies (signed in, cloud row, Youmi AI — not local-only / own key). */
  aiExpected: boolean
  hasAudio: boolean
  aiStatus?: string | null
  transcript?: string | null
  summaryEn?: string | null
  summaryZh?: string | null
  sourceSummary?: string | null
  translatedSummary?: string | null
}

/**
 * Whether Desktop must ask the server to process this lecture now.
 *
 * Only a lecture that is still `pending` (or has no status) qualifies. Anything
 * in flight is already being worked and is polled, not re-requested; `failed`
 * is deliberately NOT auto-retried — a failure is surfaced and the user decides,
 * otherwise a permanently failing job would be hammered on every open.
 */
export function shouldRequestProcessing(input: ProcessingTriggerInput): boolean {
  if (!input.aiExpected || !input.hasAudio) return false
  const complete = Boolean(input.transcript?.trim() && hasAnySummary(input))
  if (complete) return false
  return !input.aiStatus || input.aiStatus === 'pending'
}

export type ProcessingRequestResult =
  | { ok: true }
  /** `retryable`: the request never got a definitive answer (network, timeout,
   *  5xx, or the row not visible yet) — worth another automatic attempt. A
   *  definitive refusal (sign-in, quota, forbidden) is not. */
  | { ok: false; message: string; retryable?: boolean }

type Send = (recordingId: string) => Promise<ProcessingRequestResult>

export type ProcessingRequester = {
  /** Idempotent per lecture: concurrent and repeated calls share one request. */
  request: (recordingId: string) => Promise<ProcessingRequestResult>
  /** Explicit user retry. Clears the failure, then asks again. */
  retry: (recordingId: string) => Promise<ProcessingRequestResult>
  /** True when the last attempt for this lecture was rejected or never reached the server. */
  failed: (recordingId: string) => boolean
  /** A request for this lecture is outstanding (sent or backing off). */
  requesting: (recordingId: string) => boolean
  /** The server acknowledged a request for this lecture during this session. */
  accepted: (recordingId: string) => boolean
  subscribe: (listener: () => void) => () => void
}

export type ProcessingRequesterOptions = {
  /** Delays between automatic attempts after a transient failure. */
  backoffMs?: readonly number[]
  /**
   * Whether the lecture still needs a request. Asked before every RE-attempt: if
   * the row has already moved past `pending` (the first request landed but its
   * answer was lost), asking again would at best be wasted and at worst a billable
   * regeneration, so the attempt is treated as done.
   */
  stillPending?: (recordingId: string) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
}

/**
 * Which refusals deserve another automatic attempt.
 *
 *  · 404 — the row is not visible to the server yet. The request now goes out
 *    straight after the row is confirmed, so a replica a moment behind is real.
 *  · 408 / 425 / 5xx — the server or its database was busy.
 *
 * Everything else (sign-in, quota, forbidden, bad request) is a definite answer:
 * repeating it would not change it, so the lecture surfaces "Processing failed"
 * with a manual Retry instead.
 */
export function isRetryableEnqueueStatus(status: number | undefined): boolean {
  if (status === undefined) return true
  return status === 404 || status === 408 || status === 425 || (status >= 500 && status <= 599)
}

export const DEFAULT_REQUEST_BACKOFF_MS = [1500, 4000, 9000] as const

export function createProcessingRequester(
  send: Send,
  options: ProcessingRequesterOptions = {},
): ProcessingRequester {
  const backoff = options.backoffMs ?? DEFAULT_REQUEST_BACKOFF_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const inflight = new Map<string, Promise<ProcessingRequestResult>>()
  const active = new Set<string>()
  const acceptedIds = new Set<string>()
  const failedIds = new Set<string>()
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((l) => l())

  async function attemptOnce(recordingId: string): Promise<ProcessingRequestResult> {
    try {
      return await send(recordingId)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Request failed', retryable: true }
    }
  }

  function run(recordingId: string): Promise<ProcessingRequestResult> {
    active.add(recordingId)
    notify()
    const attempt = (async (): Promise<ProcessingRequestResult> => {
      let out = await attemptOnce(recordingId)
      for (let i = 0; !out.ok && out.retryable && i < backoff.length; i++) {
        await sleep(backoff[i])
        if (options.stillPending) {
          let pending = true
          try {
            pending = await options.stillPending(recordingId)
          } catch {
            /* can't tell — assume it still needs the request */
          }
          if (!pending) {
            out = { ok: true }
            break
          }
        }
        out = await attemptOnce(recordingId)
      }
      active.delete(recordingId)
      if (out.ok) {
        acceptedIds.add(recordingId)
        if (failedIds.delete(recordingId)) notify()
      } else if (!failedIds.has(recordingId)) {
        failedIds.add(recordingId)
      }
      notify()
      return out
    })()
    inflight.set(recordingId, attempt)
    return attempt
  }

  return {
    request: (recordingId) => inflight.get(recordingId) ?? run(recordingId),
    retry: (recordingId) => {
      inflight.delete(recordingId)
      acceptedIds.delete(recordingId)
      if (failedIds.delete(recordingId)) notify()
      return run(recordingId)
    },
    failed: (recordingId) => failedIds.has(recordingId),
    requesting: (recordingId) => active.has(recordingId),
    accepted: (recordingId) => acceptedIds.has(recordingId),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/**
 * List-row badge. Reads the SAME lifecycle as the detail header and the processing
 * screen, so a row and its detail can never disagree: Ready means the outputs are
 * persisted, not that audio was saved.
 */
export function lectureListStatus(
  recording: {
    hasAudio: boolean
    aiStatus?: string | null
    aiUpdatedAt?: number | null
    transcript?: string | null
    summaryEn?: string | null
    summaryZh?: string | null
    sourceSummary?: string | null
    translatedSummary?: string | null
  },
  opts: { aiExpected: boolean; requestFailed?: boolean },
): LectureStatus {
  const life = lectureLifecycle({
    hasAudio: recording.hasAudio,
    aiStatus: recording.aiStatus,
    aiUpdatedAt: recording.aiUpdatedAt,
    transcript: recording.transcript,
    summaryEn: recording.summaryEn,
    summaryZh: recording.summaryZh,
    sourceSummary: recording.sourceSummary,
    translatedSummary: recording.translatedSummary,
    aiExpected: opts.aiExpected,
    requestFailed: opts.requestFailed,
  })
  if (life.kind === 'ready') return 'Ready'
  if (life.kind === 'failed') return 'Failed'
  // Done on the server with nothing to show (e.g. silent audio): nothing more is coming.
  if (life.kind === 'none' && recording.aiStatus === 'done') return 'Ready'
  return 'Processing'
}
