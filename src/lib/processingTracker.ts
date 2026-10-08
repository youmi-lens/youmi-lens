/**
 * Which lectures to follow, how fast, and how a status update lands on a row.
 * Pure: the hook in `useProcessingTracker` supplies the clock and the network.
 *
 * Design rules, from the 2026-10-04 incidents:
 *
 *  · Following a job must not depend on its Lecture Detail being open. The saved
 *    screen, a list badge and a reopened lecture all need to move to Ready on
 *    their own, so the tracker follows EVERY lecture that is mid-processing, not
 *    just the selected one.
 *  · A status read is small (no text) and tolerant: a failed or slow read means
 *    "unknown", backs off, and tries again. It never marks a lecture finished or
 *    failed.
 *  · The text is fetched once, when a row first says it has outputs.
 */
import { hasAnySummary, isInFlightStatus, lectureLifecycle, mergeServerAiFields } from './lectureLifecycle'
import type { ProcessingStatusRow } from './recordingsRepo'

export const POLL_FIRST_MS = 800
export const POLL_BASE_MS = 2500
export const POLL_MAX_MS = 20_000

/** Exponential back-off after consecutive failed reads; a stalled job is read slowly. */
export function nextPollDelayMs(consecutiveFailures: number, stalled = false): number {
  if (consecutiveFailures > 0) {
    return Math.min(POLL_MAX_MS, POLL_BASE_MS * 2 ** Math.min(consecutiveFailures, 4))
  }
  return stalled ? 15_000 : POLL_BASE_MS
}

type TrackRow = {
  id: string
  aiStatus?: string | null
  aiUpdatedAt?: number | null
  transcript?: string | null
  summaryEn?: string | null
  summaryZh?: string | null
  sourceSummary?: string | null
  translatedSummary?: string | null
  storagePath?: string | null
  durationSec?: number
}

/**
 * The lectures worth reading the server about right now.
 *
 *  · Anything the server reports as in flight (queued / transcribing / summarizing…).
 *  · A `pending` lecture only while a request for it is outstanding or accepted
 *    this session (or it is pinned open): a pending row nobody has asked about
 *    has no job to follow.
 *  · Never a Ready or failed lecture — a failure waits for the user's Retry.
 */
export function selectTrackedIds(input: {
  library: readonly TrackRow[]
  aiExpected: boolean
  requested: (id: string) => boolean
  pinned?: ReadonlyArray<string | null | undefined>
  now?: number
}): string[] {
  if (!input.aiExpected) return []
  const pinned = new Set((input.pinned ?? []).filter((x): x is string => Boolean(x)))
  const out: string[] = []
  for (const row of input.library) {
    const life = lectureLifecycle({
      hasAudio: Boolean(row.storagePath || (row.durationSec ?? 0) > 0),
      aiStatus: row.aiStatus,
      aiUpdatedAt: row.aiUpdatedAt,
      transcript: row.transcript,
      summaryEn: row.summaryEn,
      summaryZh: row.summaryZh,
      sourceSummary: row.sourceSummary,
      translatedSummary: row.translatedSummary,
      aiExpected: true,
      now: input.now,
    })
    if (life.kind === 'ready' || life.kind === 'failed' || life.kind === 'none') continue
    if (isInFlightStatus(row.aiStatus)) out.push(row.id)
    else if (input.requested(row.id) || pinned.has(row.id)) out.push(row.id)
  }
  return out
}

/** True once a status row says text should now exist on the server. */
function reportsOutputs(status: string | undefined | null): boolean {
  return status === 'done' || status === 'transcript_ready'
}

/**
 * Lay fresh status rows over the library. Only the server-owned progress fields
 * move; titles, notes and marks are untouched. Returns the SAME array when
 * nothing changed so React does not re-render on every quiet poll, plus the ids
 * whose text must now be fetched.
 */
export function applyStatusRows<T extends TrackRow & { transcriptReady?: boolean; summaryReady?: boolean; translationReady?: boolean; aiError?: string }>(
  library: readonly T[],
  rows: readonly ProcessingStatusRow[],
): { library: T[]; changed: boolean; needFull: string[] } {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const needFull: string[] = []
  let changed = false
  const next = library.map((row) => {
    const fresh = byId.get(row.id)
    if (!fresh) return row
    const same =
      row.aiStatus === fresh.aiStatus &&
      row.aiError === fresh.aiError &&
      row.aiUpdatedAt === fresh.aiUpdatedAt &&
      row.transcriptReady === fresh.transcriptReady &&
      row.summaryReady === fresh.summaryReady &&
      row.translationReady === fresh.translationReady
    const hasOutputs = Boolean(row.transcript?.trim() && hasAnySummary(row))
    if (reportsOutputs(fresh.aiStatus) && !hasOutputs) needFull.push(row.id)
    if (same) return row
    changed = true
    return mergeServerAiFields(row, {
      aiStatus: fresh.aiStatus,
      aiError: fresh.aiError,
      aiUpdatedAt: fresh.aiUpdatedAt,
      transcriptReady: fresh.transcriptReady,
      summaryReady: fresh.summaryReady,
      translationReady: fresh.translationReady,
    })
  })
  return { library: changed ? next : (library as T[]), changed, needFull }
}

/** A status read that has not answered by now counts as a failed read. */
export const STATUS_READ_TIMEOUT_MS = 15_000

export type ProcessingLoopOptions = {
  ids: readonly string[]
  readStatuses: (ids: string[]) => Promise<ProcessingStatusRow[]>
  onRows: (rows: ProcessingStatusRow[]) => void
  timeoutMs?: number
  now?: () => number
}

/**
 * "Read, apply, wait" — the polling loop, with no React in it.
 *
 * A loop rather than an interval: a slow read never piles a second one behind it,
 * and a failure widens the wait. A read that FAILS or TIMES OUT is only "unknown":
 * `onRows` is not called, so nothing is marked finished or failed on a guess. The
 * returned function stops it.
 */
export function startProcessingLoop(opts: ProcessingLoopOptions): () => void {
  const ids = [...opts.ids]
  if (ids.length === 0) return () => undefined
  const timeoutMs = opts.timeoutMs ?? STATUS_READ_TIMEOUT_MS
  const now = opts.now ?? Date.now
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let failures = 0

  const tick = async () => {
    let stalledHint = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const rows = await Promise.race([
        opts.readStatuses(ids),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('status read timed out')), timeoutMs)
        }),
      ])
      if (cancelled) return
      failures = 0
      opts.onRows(rows)
      const t = now()
      stalledHint = rows.some((r) => typeof r.aiUpdatedAt === 'number' && t - r.aiUpdatedAt > 5 * 60 * 1000)
    } catch {
      failures += 1
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    if (!cancelled) timer = setTimeout(tick, nextPollDelayMs(failures, stalledHint))
  }

  timer = setTimeout(tick, POLL_FIRST_MS)
  return () => {
    cancelled = true
    if (timer) clearTimeout(timer)
  }
}
