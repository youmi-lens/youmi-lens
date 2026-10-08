import { describe, expect, it } from 'vitest'
import {
  applyStatusRows,
  nextPollDelayMs,
  POLL_BASE_MS,
  POLL_MAX_MS,
  selectTrackedIds,
} from './processingTracker'
import type { ProcessingStatusRow } from './recordingsRepo'

const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, storagePath: `u/${id}.webm`, durationSec: 30, ...extra })
const never = () => false

describe('selectTrackedIds — follow every lecture that is mid-processing, not just the open one', () => {
  it('follows every in-flight lecture even when none is open', () => {
    const ids = selectTrackedIds({
      library: [row('q', { aiStatus: 'queued' }), row('t', { aiStatus: 'transcribing' }), row('s', { aiStatus: 'summarizing' }), row('ts', { aiStatus: 'transcript_ready' })],
      aiExpected: true,
      requested: never,
    })
    expect(ids).toEqual(['q', 't', 's', 'ts'])
  })

  it('does not follow finished, failed or output-less done lectures', () => {
    const ids = selectTrackedIds({
      library: [
        row('ready', { aiStatus: 'done', transcript: 'T', summaryEn: 'S' }),
        row('failed', { aiStatus: 'failed' }),
        row('silent', { aiStatus: 'done' }),
      ],
      aiExpected: true,
      requested: never,
    })
    expect(ids).toEqual([])
  })

  it('a finished lecture is never followed even if it is pinned open', () => {
    const ids = selectTrackedIds({
      library: [row('ready', { aiStatus: 'done', transcript: 'T', summaryEn: 'S' })],
      aiExpected: true,
      requested: () => true,
      pinned: ['ready'],
    })
    expect(ids).toEqual([])
  })

  it('a `pending` lecture is followed only while a request for it is outstanding/accepted or it is open', () => {
    const library = [row('p', { aiStatus: 'pending' })]
    expect(selectTrackedIds({ library, aiExpected: true, requested: never })).toEqual([])
    expect(selectTrackedIds({ library, aiExpected: true, requested: (id) => id === 'p' })).toEqual(['p'])
    expect(selectTrackedIds({ library, aiExpected: true, requested: never, pinned: ['p'] })).toEqual(['p'])
  })

  it('follows nothing for local-only / own-key lectures', () => {
    expect(selectTrackedIds({ library: [row('q', { aiStatus: 'queued' })], aiExpected: false, requested: () => true })).toEqual([])
  })

  it('relaunch: in-flight rows from the server are picked up with no session state at all', () => {
    const ids = selectTrackedIds({ library: [row('a', { aiStatus: 'transcribing' })], aiExpected: true, requested: never })
    expect(ids).toEqual(['a'])
  })
})

describe('applyStatusRows — a poll moves the progress fields and nothing else', () => {
  const status = (id: string, extra: Partial<ProcessingStatusRow> = {}): ProcessingStatusRow => ({ id, aiStatus: 'queued', ...extra })

  it('moves status without touching titles, notes or marks', () => {
    const library = [{ ...row('a', { aiStatus: 'queued', title: 'Mine', notes: 'my notes' }) }]
    const out = applyStatusRows(library, [status('a', { aiStatus: 'transcribing', aiUpdatedAt: 5 })])
    expect(out.changed).toBe(true)
    expect(out.library[0]).toMatchObject({ aiStatus: 'transcribing', aiUpdatedAt: 5, title: 'Mine', notes: 'my notes' })
  })

  it('returns the SAME array when nothing changed, so a quiet poll causes no re-render', () => {
    const library = [row('a', { aiStatus: 'queued' })]
    const out = applyStatusRows(library, [status('a', { aiStatus: 'queued' })])
    expect(out.changed).toBe(false)
    expect(out.library).toBe(library)
  })

  it('asks for the full row exactly when the server says outputs exist and the client has none', () => {
    const lib = [row('a', { aiStatus: 'summarizing' }), row('b', { aiStatus: 'summarizing' })]
    const out = applyStatusRows(lib, [status('a', { aiStatus: 'done' }), status('b', { aiStatus: 'summarizing' })])
    expect(out.needFull).toEqual(['a'])
  })

  it('does not refetch text the client already holds', () => {
    const lib = [row('a', { aiStatus: 'summarizing', transcript: 'T', summaryEn: 'S' })]
    expect(applyStatusRows(lib, [status('a', { aiStatus: 'done' })]).needFull).toEqual([])
  })

  it('transcript_ready also triggers a text fetch, so a partial transcript appears early', () => {
    expect(applyStatusRows([row('a', { aiStatus: 'transcribing' })], [status('a', { aiStatus: 'transcript_ready' })]).needFull).toEqual(['a'])
  })

  it('a failed status becomes the failed lifecycle — never a stuck "Processing"', () => {
    const out = applyStatusRows([row('a', { aiStatus: 'transcribing' })], [status('a', { aiStatus: 'failed', aiError: 'boom' })])
    expect(out.library[0]).toMatchObject({ aiStatus: 'failed', aiError: 'boom' })
  })

  it('ignores rows for lectures it does not hold', () => {
    const lib = [row('a', { aiStatus: 'queued' })]
    expect(applyStatusRows(lib, [status('zzz', { aiStatus: 'done' })]).changed).toBe(false)
  })
})

describe('nextPollDelayMs', () => {
  it('polls promptly while healthy, so done refreshes within a few seconds', () => {
    expect(nextPollDelayMs(0)).toBe(POLL_BASE_MS)
    expect(POLL_BASE_MS).toBeLessThanOrEqual(3000)
  })
  it('backs off on failed reads, bounded', () => {
    const delays = [1, 2, 3, 4, 5, 9].map((n) => nextPollDelayMs(n))
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1])
    expect(Math.max(...delays)).toBeLessThanOrEqual(POLL_MAX_MS)
  })
  it('reads a stalled job slowly instead of hammering it', () => {
    expect(nextPollDelayMs(0, true)).toBeGreaterThan(POLL_BASE_MS)
  })
})

import { afterEach, beforeEach, vi } from 'vitest'
import { POLL_FIRST_MS, startProcessingLoop, STATUS_READ_TIMEOUT_MS } from './processingTracker'

describe('startProcessingLoop — polling', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const status = (id: string, aiStatus: ProcessingStatusRow['aiStatus']): ProcessingStatusRow => ({ id, aiStatus })

  it('reads promptly and refreshes the moment the server says done', async () => {
    const seen: string[] = []
    const read = vi
      .fn<(ids: string[]) => Promise<ProcessingStatusRow[]>>()
      .mockResolvedValueOnce([status('a', 'transcribing')])
      .mockResolvedValueOnce([status('a', 'done')])
    const stop = startProcessingLoop({ ids: ['a'], readStatuses: read, onRows: (rows) => seen.push(rows[0].aiStatus ?? '') })
    await vi.advanceTimersByTimeAsync(POLL_FIRST_MS)
    expect(seen).toEqual(['transcribing'])
    await vi.advanceTimersByTimeAsync(POLL_BASE_MS)
    expect(seen).toEqual(['transcribing', 'done'])
    stop()
  })

  it('a failed read is only "unknown": nothing is applied, so it cannot read as Ready or failed', async () => {
    const onRows = vi.fn()
    const read = vi.fn().mockRejectedValue(new Error('db down'))
    const stop = startProcessingLoop({ ids: ['a'], readStatuses: read, onRows })
    await vi.advanceTimersByTimeAsync(POLL_FIRST_MS + 60_000)
    expect(read).toHaveBeenCalled()
    expect(onRows).not.toHaveBeenCalled()
    stop()
  })

  it('backs off while reads fail, then recovers on its own', async () => {
    const onRows = vi.fn()
    const read = vi
      .fn<(ids: string[]) => Promise<ProcessingStatusRow[]>>()
      .mockRejectedValueOnce(new Error('x'))
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValue([status('a', 'done')])
    const stop = startProcessingLoop({ ids: ['a'], readStatuses: read, onRows })
    await vi.advanceTimersByTimeAsync(POLL_FIRST_MS)
    expect(read).toHaveBeenCalledTimes(1)
    // After one failure the wait is wider than the healthy interval.
    await vi.advanceTimersByTimeAsync(POLL_BASE_MS)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(POLL_MAX_MS * 2)
    expect(onRows).toHaveBeenCalled()
    stop()
  })

  it('a read that never answers is a failure after the timeout, not a hang', async () => {
    const onRows = vi.fn()
    const read = vi.fn().mockImplementation(() => new Promise(() => undefined))
    const stop = startProcessingLoop({ ids: ['a'], readStatuses: read, onRows })
    await vi.advanceTimersByTimeAsync(POLL_FIRST_MS + STATUS_READ_TIMEOUT_MS + 100)
    await vi.advanceTimersByTimeAsync(POLL_MAX_MS + 100)
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(onRows).not.toHaveBeenCalled()
    stop()
  })

  it('never has two reads in flight — a slow read does not pile up a second', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const read = vi.fn().mockImplementation(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 10_000))
      inFlight--
      return [status('a', 'transcribing')]
    })
    const stop = startProcessingLoop({ ids: ['a'], readStatuses: read, onRows: () => undefined })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(maxInFlight).toBe(1)
    stop()
  })

  it('stops when told to, and an empty set does nothing', async () => {
    const read = vi.fn().mockResolvedValue([status('a', 'queued')])
    const stop = startProcessingLoop({ ids: ['a'], readStatuses: read, onRows: () => undefined })
    stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read).not.toHaveBeenCalled()
    const idle = vi.fn()
    startProcessingLoop({ ids: [], readStatuses: idle, onRows: () => undefined })()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(idle).not.toHaveBeenCalled()
  })

  it('reads the whole set in ONE call per tick (a small query, not one per lecture)', async () => {
    const read = vi.fn().mockResolvedValue([])
    const stop = startProcessingLoop({ ids: ['a', 'b', 'c'], readStatuses: read, onRows: () => undefined })
    await vi.advanceTimersByTimeAsync(POLL_FIRST_MS)
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith(['a', 'b', 'c'])
    stop()
  })
})
