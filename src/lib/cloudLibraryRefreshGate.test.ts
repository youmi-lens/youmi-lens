import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createCloudLibraryRefreshGate } from './cloudLibraryRefreshGate'

describe('Cloud Library refresh invalidation gate', () => {
  it('runs a focus refresh once, then throttles the visibility companion event', async () => {
    let clock = 10_000
    const gate = createCloudLibraryRefreshGate({ staleMs: 3_000, now: () => clock })
    const refresh = vi.fn(async () => undefined)

    await expect(gate.run(refresh)).resolves.toBe(true)
    await expect(gate.run(refresh)).resolves.toBe(false)
    expect(refresh).toHaveBeenCalledTimes(1)

    clock += 3_000
    await expect(gate.run(refresh)).resolves.toBe(true)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('makes concurrent lifecycle signals single-flight', async () => {
    let resolveRefresh: (() => void) | undefined
    const gate = createCloudLibraryRefreshGate()
    const refresh = vi.fn(
      () => new Promise<void>((resolve) => { resolveRefresh = resolve }),
    )

    const focus = gate.run(refresh)
    const visible = gate.run(refresh)
    expect(focus).toBe(visible)
    expect(refresh).toHaveBeenCalledTimes(1)

    resolveRefresh?.()
    await expect(focus).resolves.toBe(true)
  })

  it('does not turn a refresh failure into a stale-success cache entry', async () => {
    const gate = createCloudLibraryRefreshGate({ staleMs: 60_000 })
    const failed = vi.fn(async () => { throw new Error('offline') })
    await expect(gate.run(failed)).rejects.toThrow('offline')

    const retry = vi.fn(async () => undefined)
    await expect(gate.run(retry)).resolves.toBe(true)
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('keeps the actual focus, visibility, and Courses route triggers wired', () => {
    // Mutation guard: deleting any of these trigger registrations must fail.
    const source = readFileSync(new URL('../hooks/useCloudLibraryRefresh.ts', import.meta.url), 'utf8')
    expect(source).toContain("document.addEventListener('visibilitychange', onVisibility)")
    expect(source).toContain("window.addEventListener('focus', onFocus)")
    expect(source).toContain('if (!routeKey)')
    expect(source).toContain('hasObservedInitialRouteRef')
    expect(source).toContain('await Promise.all([refreshCoursesRef.current(), refreshRecordingsRef.current()])')
  })
})
