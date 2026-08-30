import { useCallback, useEffect, useRef } from 'react'
import { createCloudLibraryRefreshGate } from '../lib/cloudLibraryRefreshGate'

type UseCloudLibraryRefreshOptions = {
  enabled: boolean
  /** Changes when the authenticated Cloud Library identity changes. */
  sessionKey: string | null
  /** Null outside Courses; changes between grid and Course Detail. */
  routeKey: string | null
  refreshCourses: () => Promise<void>
  refreshRecordings: () => Promise<unknown>
}

export type CloudLibraryRefreshController = {
  /** Lifecycle fallback: subject to the small stale threshold. */
  refreshForLifecycle: () => Promise<boolean>
  /** Realtime invalidation: bypasses staleness, but never single-flight. */
  refreshForRealtime: () => Promise<boolean>
}

/**
 * Refreshes the two Cloud Library projections together when a user returns to
 * the app or re-enters Courses. It deliberately does not subscribe to
 * Realtime: this is an invalidation layer over the existing repositories, not
 * a new transport or schema contract.
 */
export function useCloudLibraryRefresh({
  enabled,
  sessionKey,
  routeKey,
  refreshCourses,
  refreshRecordings,
}: UseCloudLibraryRefreshOptions): CloudLibraryRefreshController {
  const enabledRef = useRef(enabled)
  const refreshCoursesRef = useRef(refreshCourses)
  const refreshRecordingsRef = useRef(refreshRecordings)
  const gateRef = useRef(createCloudLibraryRefreshGate())
  const seenRouteRef = useRef<string | null>(null)
  const hasObservedInitialRouteRef = useRef(false)

  useEffect(() => {
    enabledRef.current = enabled
    refreshCoursesRef.current = refreshCourses
    refreshRecordingsRef.current = refreshRecordings
  }, [enabled, refreshCourses, refreshRecordings])

  const refreshCloudLibrary = useCallback((bypassStale = false) => {
    if (!enabledRef.current) return Promise.resolve(false)
    return gateRef.current.run(async () => {
      await Promise.all([refreshCoursesRef.current(), refreshRecordingsRef.current()])
    }, { bypassStale })
  }, [])

  useEffect(() => {
    gateRef.current.reset()
    seenRouteRef.current = null
    hasObservedInitialRouteRef.current = false
  }, [sessionKey])

  useEffect(() => {
    if (!enabled) return

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refreshCloudLibrary().catch(() => undefined)
      }
    }
    const onFocus = () => {
      void refreshCloudLibrary().catch(() => undefined)
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
    }
  }, [enabled, refreshCloudLibrary])

  useEffect(() => {
    if (!routeKey) {
      seenRouteRef.current = null
      return
    }
    if (!hasObservedInitialRouteRef.current) {
      // Initial data has its own startup effect. Do not duplicate it merely
      // because the app mounted on Courses.
      hasObservedInitialRouteRef.current = true
      seenRouteRef.current = routeKey
      return
    }
    if (seenRouteRef.current === routeKey) return
    seenRouteRef.current = routeKey
    void refreshCloudLibrary().catch(() => undefined)
  }, [routeKey, refreshCloudLibrary])

  return {
    refreshForLifecycle: () => refreshCloudLibrary(),
    refreshForRealtime: () => refreshCloudLibrary(true),
  }
}
