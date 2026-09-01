import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type UpdaterStatus,
  type RecordingSafetyState,
  canInstallUpdate,
  sanitizeUpdaterError,
} from './updaterCore'
import { useAppVersion } from './useAppVersion'

/**
 * In-app updater hook (Phase 2E). Wraps the official Tauri v2
 * @tauri-apps/plugin-updater + @tauri-apps/plugin-process. Runs ONLY inside the
 * Tauri desktop shell; on web/dev it stays inert (`idle`). The Tauri updater
 * plugin verifies the update signature and selects the correct platform artifact
 * itself — this hook adds the UX state machine + the recording-safety gate.
 */

function isTauriShell(): boolean {
  if (typeof window === 'undefined') return false
  return (
    '__TAURI_INTERNALS__' in window ||
    window.location.protocol === 'tauri:' ||
    window.location.hostname === 'tauri.localhost'
  )
}

// Minimal structural type for the plugin's Update handle (avoids a hard type dep).
type TauriUpdate = {
  version: string
  currentVersion?: string
  body?: string | null
  date?: string | null
  download: (onEvent?: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void) => Promise<void>
  install: () => Promise<void>
  downloadAndInstall?: (onEvent?: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void) => Promise<void>
}

const STARTUP_CHECK_TIMEOUT_MS = 12_000

export interface UseUpdaterResult {
  status: UpdaterStatus
  currentVersion: string
  newVersion: string | null
  releaseNotes: string | null
  /** 0–100 while downloading, else null. */
  progress: number | null
  error: string | null
  /** Non-null when install was blocked by the recording-safety gate. */
  blockedReason: string | null
  actions: {
    check: (opts?: { silent?: boolean }) => Promise<void>
    download: () => Promise<void>
    installAndRestart: () => Promise<void>
    dismissError: () => void
  }
}

export function useUpdater(recordingSafety: RecordingSafetyState): UseUpdaterResult {
  const [status, setStatus] = useState<UpdaterStatus>('idle')
  const currentVersion = useAppVersion()
  const [newVersion, setNewVersion] = useState<string | null>(null)
  const [releaseNotes, setReleaseNotes] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [blockedReason, setBlockedReason] = useState<string | null>(null)

  const updateRef = useRef<TauriUpdate | null>(null)
  const busyRef = useRef(false)
  const mountedRef = useRef(true)
  const safetyRef = useRef(recordingSafety)
  safetyRef.current = recordingSafety
  const statusRef = useRef(status)
  statusRef.current = status

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const check = useCallback(async (opts?: { silent?: boolean }) => {
    if (!isTauriShell() || busyRef.current) return
    busyRef.current = true
    if (!opts?.silent) setStatus('checking')
    setError(null)
    try {
      const { check: tauriCheck } = await import('@tauri-apps/plugin-updater')
      // Bounded so a slow/unreachable update service never hangs or blocks the app.
      const update = (await Promise.race([
        tauriCheck(),
        new Promise((_r, rej) => setTimeout(() => rej(new Error('update check timeout')), STARTUP_CHECK_TIMEOUT_MS)),
      ])) as TauriUpdate | null
      if (!mountedRef.current) return
      if (update) {
        updateRef.current = update
        setNewVersion(update.version)
        setReleaseNotes(update.body ?? null)
        setStatus('available')
      } else {
        updateRef.current = null
        setNewVersion(null)
        // Silent startup checks stay quiet; a manual check shows "up to date".
        setStatus(opts?.silent ? 'idle' : 'up-to-date')
      }
    } catch (err) {
      if (!mountedRef.current) return
      // A temporarily-unavailable update service must NOT show an error on startup.
      if (opts?.silent) setStatus('idle')
      else {
        setError(sanitizeUpdaterError(err))
        setStatus('error')
      }
    } finally {
      busyRef.current = false
    }
  }, [])

  const download = useCallback(async () => {
    const update = updateRef.current
    if (!update || busyRef.current) return
    busyRef.current = true
    setStatus('downloading')
    setProgress(0)
    setError(null)
    try {
      let total = 0
      let received = 0
      await update.download((e) => {
        if (e.event === 'Started') total = e.data?.contentLength ?? 0
        else if (e.event === 'Progress') {
          received += e.data?.chunkLength ?? 0
          if (total > 0 && mountedRef.current) setProgress(Math.min(99, Math.round((received / total) * 100)))
        } else if (e.event === 'Finished' && mountedRef.current) setProgress(100)
      })
      if (mountedRef.current) setStatus('ready')
    } catch (err) {
      if (mountedRef.current) {
        setError(sanitizeUpdaterError(err))
        setStatus('error')
      }
    } finally {
      busyRef.current = false
    }
  }, [])

  const installAndRestart = useCallback(async () => {
    const update = updateRef.current
    if (!update || busyRef.current) return
    // Recording-safety gate: never sacrifice an in-memory / in-flight recording.
    const gate = canInstallUpdate(safetyRef.current)
    if (!gate.ok) {
      setBlockedReason(gate.reason)
      return
    }
    setBlockedReason(null)
    busyRef.current = true
    setStatus('installing')
    setError(null)
    try {
      await update.install()
      if (mountedRef.current) setStatus('restart-required')
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    } catch (err) {
      if (mountedRef.current) {
        setError(sanitizeUpdaterError(err))
        setStatus('error')
      }
    } finally {
      busyRef.current = false
    }
  }, [])

  const dismissError = useCallback(() => {
    setError(null)
    setBlockedReason(null)
    setStatus(updateRef.current ? 'available' : 'idle')
  }, [])

  // One bounded, non-blocking check shortly after startup (Tauri only). Guarded
  // on the CURRENT status so this silent, failure-swallowing check can never
  // clobber a definitive result some other caller (e.g. the Settings page,
  // which always runs its own real check on open) already reached — without
  // this guard, a silent check that fires after that real check already
  // resolved could reset a shown 'up-to-date'/'available' state back to
  // 'idle' on any transient hiccup, flickering the UI backwards.
  useEffect(() => {
    if (!isTauriShell()) return
    const t = window.setTimeout(() => {
      if (statusRef.current === 'idle') void check({ silent: true })
    }, 2500)
    return () => window.clearTimeout(t)
  }, [check])

  return {
    status,
    currentVersion,
    newVersion,
    releaseNotes,
    progress,
    error,
    blockedReason,
    actions: { check, download, installAndRestart, dismissError },
  }
}
