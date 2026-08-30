/**
 * Base URL for app AI HTTP routes (`/api/...`).
 *
 * - **Vite dev / `tauri dev`:** relative `/api` is proxied to the local AI server (see `vite.config.ts`).
 * - **Production web (same-origin deploy):** relative `/api` when `VITE_API_BASE_URL` is unset.
 * - **Tauri production (`tauri build`):** `VITE_API_BASE_URL` is **required** — no localhost fallback for trial installs.
 */
import { assertDesktopApiTargetSafe } from '../productionGuard'

function isTauriWebviewShell(): boolean {
  if (typeof window === 'undefined') return false
  return (
    '__TAURI_INTERNALS__' in window ||
    window.location.protocol === 'tauri:' ||
    window.location.hostname === 'tauri.localhost'
  )
}

export function getAiApiBase(): string {
  const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim()
  if (raw) {
    // Checked once, at first real use — mirrors assertDesktopSupabaseTargetSafe
    // in src/lib/supabase.ts. Catches a qa/dev build whose VITE_API_BASE_URL
    // was mistakenly set to production, even though the build-time guard in
    // vite.config.ts should already have refused to produce it.
    assertDesktopApiTargetSafe(import.meta.env.MODE, raw)
    return `${raw.replace(/\/$/, '')}/api`
  }

  if (import.meta.env.PROD && isTauriWebviewShell()) {
    const msg =
      'VITE_API_BASE_URL is required for packaged desktop builds. Set your HTTPS API gateway origin in .env.production (see docs/tauri-desktop-trial-p0.md).'
    console.error('[ai]', msg)
    throw new Error('AI_API_BASE_URL_REQUIRED')
  }

  return '/api'
}
