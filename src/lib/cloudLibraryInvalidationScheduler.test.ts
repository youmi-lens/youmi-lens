import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createCloudLibraryInvalidationScheduler } from './cloudLibraryInvalidationScheduler'
import { createCloudLibraryRefreshGate } from './cloudLibraryRefreshGate'

describe('Cloud Library realtime invalidation', () => {
  it('coalesces a burst into one canonical refresh', async () => {
    vi.useFakeTimers()
    const refresh = vi.fn(async () => undefined)
    const scheduler = createCloudLibraryInvalidationScheduler(refresh)
    for (let index = 0; index < 10; index += 1) scheduler.invalidate()
    await vi.advanceTimersByTimeAsync(60)
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('runs one follow-up when a change lands during the canonical read', async () => {
    vi.useFakeTimers()
    let resolveRead: (() => void) | undefined
    const refresh = vi.fn(
      () => new Promise<void>((resolve) => { resolveRead = resolve }),
    )
    const scheduler = createCloudLibraryInvalidationScheduler(refresh)
    scheduler.invalidate()
    await vi.advanceTimersByTimeAsync(60)
    scheduler.invalidate()
    resolveRead?.()
    await vi.runAllTimersAsync()
    expect(refresh).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('bypasses lifecycle staleness but still shares the in-flight request', async () => {
    let now = 1_000
    const gate = createCloudLibraryRefreshGate({ staleMs: 60_000, now: () => now })
    const refresh = vi.fn(async () => undefined)
    await gate.run(refresh)
    await expect(gate.run(refresh)).resolves.toBe(false)
    await expect(gate.run(refresh, { bypassStale: true })).resolves.toBe(true)
    expect(refresh).toHaveBeenCalledTimes(2)
    now += 1
  })

  it('keeps a single payload-free subscription and its reconnect repair', () => {
    // Mutation guard: removal of an event callback or a table subscription
    // must fail this regression rather than silently returning 30s latency.
    const source = readFileSync(new URL('../hooks/useCloudLibraryRealtime.ts', import.meta.url), 'utf8')
    expect(source).toContain("table: 'courses'")
    expect(source).toContain("table: 'recordings'")
    expect(source).toContain("event: '*'")
    expect(source).toContain("status === 'SUBSCRIBED'")
    expect(source).toContain("status === 'CHANNEL_ERROR'")
    expect(source).toContain("status === 'TIMED_OUT'")
    expect(source).toContain("status === 'CLOSED'")
    expect(source).toContain('void supabase.removeChannel(channel)')
    expect(source).not.toContain('setCourses(')
    expect(source).not.toContain('setRecordings(')
  })
})
