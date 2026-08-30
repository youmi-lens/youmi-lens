/**
 * Small, framework-free gate for Cloud Library invalidation.
 *
 * Focus and visibility commonly arrive together when a window returns to the
 * foreground. Keeping the gate outside React makes that pair one refresh,
 * while a failed refresh remains immediately retryable.
 */
export const CLOUD_LIBRARY_REFRESH_STALE_MS = 3_000

type Refresh = () => Promise<void>

export type CloudLibraryRefreshGate = {
  run: (refresh: Refresh, options?: { bypassStale?: boolean }) => Promise<boolean>
  reset: () => void
}

export function createCloudLibraryRefreshGate(options: {
  staleMs?: number
  now?: () => number
} = {}): CloudLibraryRefreshGate {
  const staleMs = options.staleMs ?? CLOUD_LIBRARY_REFRESH_STALE_MS
  const now = options.now ?? Date.now
  let lastSuccessAt = 0
  let inFlight: Promise<boolean> | null = null

  const run = (refresh: Refresh, options: { bypassStale?: boolean } = {}): Promise<boolean> => {
    if (inFlight) return inFlight
    if (!options.bypassStale && lastSuccessAt > 0 && now() - lastSuccessAt < staleMs) {
      return Promise.resolve(false)
    }

    inFlight = refresh()
      .then(() => {
        lastSuccessAt = now()
        return true
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  return {
    run,
    reset: () => {
      lastSuccessAt = 0
    },
  }
}
