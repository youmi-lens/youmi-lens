import { useEffect, useRef } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createCloudLibraryInvalidationScheduler } from '../lib/cloudLibraryInvalidationScheduler'

type UseCloudLibraryRealtimeOptions = {
  enabled: boolean
  supabase: SupabaseClient | null
  userId: string | null
  /** Bypasses the lifecycle stale threshold, while preserving single-flight. */
  refreshNow: () => Promise<unknown>
}

/**
 * One auth-scoped Postgres Changes subscription for Cloud Library invalidation.
 * Event payloads are intentionally discarded: canonical repositories remain
 * the only writer of Course and Lecture state.
 */
export function useCloudLibraryRealtime({
  enabled,
  supabase,
  userId,
  refreshNow,
}: UseCloudLibraryRealtimeOptions): void {
  const refreshNowRef = useRef(refreshNow)
  useEffect(() => {
    refreshNowRef.current = refreshNow
  }, [refreshNow])

  useEffect(() => {
    if (!enabled || !supabase || !userId) return

    const scheduler = createCloudLibraryInvalidationScheduler(
      () => refreshNowRef.current(),
    )
    const invalidate = () => scheduler.invalidate()
    const channel = supabase
      .channel(`cloud-library-invalidation:${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'courses' }, invalidate)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'recordings' }, invalidate)
      .subscribe((status) => {
        // A successful initial join or automatic rejoin repairs anything
        // missed while the websocket was unavailable. Other terminal states
        // deliberately keep the cached UI intact; lifecycle refresh remains.
        if (status === 'SUBSCRIBED') {
          scheduler.invalidate()
          return
        }
        // supabase-js owns reconnect/backoff. These states intentionally do
        // not clear cached arrays or spin up another channel; its next
        // SUBSCRIBED callback repairs the snapshot above.
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') return
      })

    return () => {
      scheduler.dispose()
      void supabase.removeChannel(channel)
    }
  }, [enabled, supabase, userId])
}
