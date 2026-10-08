/**
 * ONE lifecycle for a saved lecture, read by every surface.
 *
 * Why this exists (production incidents 2026-10-04): the Course list badge, the
 * Lecture Detail header, the saved-result screen and the reopen path each decided
 * for themselves what a row meant. One of them said "Ready" while another said
 * "Processing", and reopening a lecture could show a stale list snapshot with no
 * transcript even though the database held the finished result.
 *
 * The rule that makes the product trustworthy:
 *
 *   PERSISTED OUTPUTS WIN. If the transcript and a summary exist on the row, the
 *   lecture is Ready — whatever `ai_status` says, whatever the client believes
 *   about a request, whenever it is opened. Nothing about processing can make a
 *   finished lecture look unfinished.
 *
 * Everything else is derived from the AUTHORITATIVE server status. The backend
 * distinguishes exactly these states, so the UI shows exactly these and invents
 * no others (no percentages, no "preparing" step it cannot observe):
 *
 *   pending | queued            → waiting        (accepted / not yet started)
 *   transcribing                → transcribing
 *   transcript_ready | summarizing → summarizing
 *   done                        → done
 *   failed                      → failed
 *
 * This module is pure. It performs no I/O and holds no state.
 */
import type { Recording } from '../types'

export type ProcessingPhase = 'waiting' | 'transcribing' | 'summarizing' | 'done' | 'failed'

export type LectureLifecycleKind = 'ready' | 'transcript_only' | 'processing' | 'failed' | 'none'

export type LectureLifecycleInput = {
  /** Persisted audio. Keeps the lecture playable; never makes it "ready" on its own. */
  hasAudio?: boolean
  aiStatus?: string | null
  transcript?: string | null
  summaryEn?: string | null
  summaryZh?: string | null
  /** The language-agnostic summary columns. A lecture in, say, French → Chinese has NO English
   *  or Chinese legacy summary for its source language — these are where its summary lives. */
  sourceSummary?: string | null
  translatedSummary?: string | null
  /**
   * A hosted AI pipeline is expected to produce the outputs. False for
   * local-only and own-key lectures, where saved audio is the whole product.
   */
  aiExpected?: boolean
  /** The attempt to start processing was rejected or never reached the server. */
  requestFailed?: boolean
  /** Epoch ms of the row's last server-side progress (`ai_updated_at`). */
  aiUpdatedAt?: number | null
  now?: number
}

export type LectureLifecycle = {
  kind: LectureLifecycleKind
  /** The processing phase while `kind` is `processing`/`failed`/partially done; otherwise null. */
  phase: ProcessingPhase | null
  /** In flight on the server but with no progress for a long time. Retry is offered. */
  stalled: boolean
  /** Transcript AND a summary are persisted. */
  complete: boolean
}

/** Server statuses meaning a job exists and is working. */
export const IN_FLIGHT_STATUSES = ['queued', 'transcribing', 'summarizing', 'transcript_ready'] as const

/** No progress for this long while in flight = "taking longer than usual". */
export const STALL_AFTER_MS = 5 * 60 * 1000

export function isInFlightStatus(status: string | null | undefined): boolean {
  return Boolean(status) && (IN_FLIGHT_STATUSES as readonly string[]).includes(status as string)
}

export function phaseForStatus(status: string | null | undefined): ProcessingPhase | null {
  switch (status) {
    case 'queued':
    case 'pending':
      return 'waiting'
    case 'transcribing':
      return 'transcribing'
    case 'transcript_ready':
    case 'summarizing':
      return 'summarizing'
    case 'done':
      return 'done'
    case 'failed':
      return 'failed'
    default:
      return null
  }
}

/** Any summary at all, in any of the four columns the backend may write. */
export function hasAnySummary(row: {
  summaryEn?: string | null
  summaryZh?: string | null
  sourceSummary?: string | null
  translatedSummary?: string | null
}): boolean {
  return Boolean(
    row.summaryEn?.trim() || row.summaryZh?.trim() || row.sourceSummary?.trim() || row.translatedSummary?.trim(),
  )
}

export function lectureLifecycle(input: LectureLifecycleInput): LectureLifecycle {
  const aiExpected = input.aiExpected ?? true
  const hasTranscript = Boolean(input.transcript?.trim())
  const hasSummary = hasAnySummary(input)
  const complete = hasTranscript && hasSummary

  // Persisted outputs win over every other signal.
  if (complete) return { kind: 'ready', phase: 'done', stalled: false, complete: true }

  // Local-only / own-key: no hosted pipeline exists; saved audio is the product.
  if (input.hasAudio && !aiExpected) return { kind: 'ready', phase: null, stalled: false, complete }

  const status = input.aiStatus ?? null
  if (status === 'failed' || input.requestFailed) {
    return { kind: 'failed', phase: 'failed', stalled: false, complete }
  }

  const inFlight = isInFlightStatus(status)
  const now = input.now ?? Date.now()
  const stalled =
    inFlight && typeof input.aiUpdatedAt === 'number' && now - input.aiUpdatedAt > STALL_AFTER_MS

  // The transcript exists; the summary is still pending. The lecture is usable.
  if (hasTranscript) {
    return { kind: 'transcript_only', phase: inFlight ? 'summarizing' : null, stalled, complete }
  }

  if (inFlight) return { kind: 'processing', phase: phaseForStatus(status), stalled, complete }

  // Saved and not yet picked up by a worker: `pending` is a real server state,
  // and a cloud row with audio but no status yet is the same thing.
  if (aiExpected && (status === 'pending' || (!status && input.hasAudio))) {
    return { kind: 'processing', phase: 'waiting', stalled: false, complete }
  }

  return { kind: 'none', phase: null, stalled: false, complete }
}

/** The row fields that only the server may decide. Merged, never guessed. */
export type ServerAiFields = Partial<
  Pick<
    Recording,
    | 'aiStatus'
    | 'aiError'
    | 'aiUpdatedAt'
    | 'transcript'
    | 'transcriptRaw'
    | 'summaryEn'
    | 'summaryZh'
    | 'sourceSummary'
    | 'translatedSummary'
    | 'translatedTranscript'
    | 'transcriptReady'
    | 'summaryReady'
    | 'translationReady'
    | 'aiPipelineTiming'
  >
>

/**
 * Overlay the authoritative AI columns of a freshly fetched row onto a list row,
 * leaving everything the client owns (title, notes, marks…) untouched. A field
 * the server did not return is left as it was; one it returned as absent is
 * cleared — that is the server's decision, not ours.
 */
export function mergeServerAiFields<T extends object>(row: T, fresh: ServerAiFields): T {
  const keys: Array<keyof ServerAiFields> = [
    'aiStatus',
    'aiError',
    'aiUpdatedAt',
    'transcript',
    'transcriptRaw',
    'summaryEn',
    'summaryZh',
    'sourceSummary',
    'translatedSummary',
    'translatedTranscript',
    'transcriptReady',
    'summaryReady',
    'translationReady',
    'aiPipelineTiming',
  ]
  const next: Record<string, unknown> = { ...(row as Record<string, unknown>) }
  for (const k of keys) {
    if (k in fresh) next[k] = (fresh as Record<string, unknown>)[k]
  }
  return next as T
}

/**
 * A list read that STARTED before a newer status landed must not drag a row
 * backwards. `refreshList` and the status tracker run concurrently; when a slow
 * list read (the database was answering in 8–25s) resolves after the tracker has
 * already moved a lecture to done, the older snapshot would otherwise bring back
 * "transcribing" — and discard the transcript that had just been fetched.
 *
 * For each lecture present in both, if the previous row's server clock
 * (`aiUpdatedAt`) is strictly newer than the fetched row's, keep the previous
 * AI fields. Everything else comes from the fresh list untouched.
 */
export function preferNewerAiState<T extends { id: string; aiUpdatedAt?: number } & ServerAiFields>(
  previous: readonly T[],
  fresh: readonly T[],
): T[] {
  const prev = new Map(previous.map((r) => [r.id, r]))
  return fresh.map((row) => {
    const old = prev.get(row.id)
    if (!old || typeof old.aiUpdatedAt !== 'number') return row
    if (typeof row.aiUpdatedAt === 'number' && old.aiUpdatedAt <= row.aiUpdatedAt) return row
    return mergeServerAiFields(row, {
      aiStatus: old.aiStatus,
      aiError: old.aiError,
      aiUpdatedAt: old.aiUpdatedAt,
      transcript: old.transcript,
      transcriptRaw: old.transcriptRaw,
      summaryEn: old.summaryEn,
      summaryZh: old.summaryZh,
      sourceSummary: old.sourceSummary,
      translatedSummary: old.translatedSummary,
      translatedTranscript: old.translatedTranscript,
      transcriptReady: old.transcriptReady,
      summaryReady: old.summaryReady,
      translationReady: old.translationReady,
      aiPipelineTiming: old.aiPipelineTiming,
    })
  })
}

/**
 * May a cached list row be shown the instant a lecture is opened?
 *
 * Only when it is ALREADY a finished lecture with its audio location: persisted
 * outputs are never wrong, so painting them early is safe and instant. Anything
 * else — pending, in flight, failed, missing outputs — might be a stale snapshot
 * of a job that has since moved on, so it is NOT shown; the page waits for the
 * authoritative read instead. This is the rule whose absence made a finished
 * lecture come back empty on reopen.
 */
export function provisionalForOpen<
  T extends {
    storagePath?: string
    aiStatus?: string | null
    transcript?: string | null
    summaryEn?: string | null
    summaryZh?: string | null
    sourceSummary?: string | null
    translatedSummary?: string | null
  },
>(cached: T | undefined | null): (T & { storagePath: string }) | null {
  if (!cached?.storagePath) return null
  const life = lectureLifecycle({
    hasAudio: true,
    aiStatus: cached.aiStatus,
    transcript: cached.transcript,
    summaryEn: cached.summaryEn,
    summaryZh: cached.summaryZh,
    sourceSummary: cached.sourceSummary,
    translatedSummary: cached.translatedSummary,
  })
  return life.complete ? { ...cached, storagePath: cached.storagePath } : null
}
