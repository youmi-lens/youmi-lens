import { useEffect, useRef } from 'react'
import { startProcessingLoop } from './processingTracker'
import type { ProcessingStatusRow } from './recordingsRepo'

/**
 * Follow the given lectures' server status until they leave the set.
 *
 * Thin by design: the loop itself is `startProcessingLoop` (pure, tested with
 * fake timers). This only restarts it when the SET of ids changes. It lives at
 * App level and neither knows nor cares which screen is open, so a lecture
 * finishing while the user is on another screen, or a different lecture, still
 * updates.
 */
export function useProcessingTracker(opts: {
  enabled: boolean
  ids: readonly string[]
  readStatuses: (ids: string[]) => Promise<ProcessingStatusRow[]>
  onRows: (rows: ProcessingStatusRow[]) => void
}): void {
  const { enabled, ids } = opts
  const key = ids.join(',')
  const latest = useRef(opts)
  // Keep the callbacks current without restarting the loop on every render.
  useEffect(() => {
    latest.current = opts
  })

  useEffect(() => {
    if (!enabled || !key) return
    return startProcessingLoop({
      ids: key.split(','),
      readStatuses: (batch) => latest.current.readStatuses(batch),
      onRows: (rows) => latest.current.onRows(rows),
    })
  }, [enabled, key])
}
