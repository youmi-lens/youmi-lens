/**
 * Coalesces a burst of invalidations without adding a perceptible delay.
 *
 * A change which arrives while the canonical read is in flight schedules one
 * follow-up read. That closes the read/change race without creating a request
 * for every Postgres Changes message in an upload burst.
 */
export const CLOUD_LIBRARY_INVALIDATION_COALESCE_MS = 60

export type CloudLibraryInvalidationScheduler = {
  invalidate: () => void
  dispose: () => void
}

export function createCloudLibraryInvalidationScheduler(
  refresh: () => Promise<unknown>,
  options: {
    coalesceMs?: number
    setTimer?: typeof setTimeout
    clearTimer?: typeof clearTimeout
  } = {},
): CloudLibraryInvalidationScheduler {
  const coalesceMs = options.coalesceMs ?? CLOUD_LIBRARY_INVALIDATION_COALESCE_MS
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let refreshAgain = false
  let disposed = false

  const run = () => {
    timer = null
    if (disposed) return
    if (running) {
      refreshAgain = true
      return
    }
    running = true
    void refresh()
      .catch(() => undefined)
      .finally(() => {
        running = false
        if (!disposed && refreshAgain) {
          refreshAgain = false
          schedule()
        }
      })
  }

  const schedule = () => {
    if (timer !== null || disposed) return
    timer = setTimer(run, coalesceMs)
  }

  return {
    invalidate: () => {
      if (running) {
        refreshAgain = true
        return
      }
      schedule()
    },
    dispose: () => {
      disposed = true
      refreshAgain = false
      if (timer !== null) clearTimer(timer)
      timer = null
    },
  }
}
