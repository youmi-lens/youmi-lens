import { isTauri } from '@tauri-apps/api/core'
import { PRODUCTION_AUTH_SCHEME, buildAuthCallbackUrl, getBuildAuthScheme, isProductionAuthScheme } from './authIdentity'

/**
 * Production custom scheme callback. Must be listed in Supabase → Authentication → URL Configuration →
 * Redirect URLs. Other builds derive theirs from the Tauri config (see authIdentity.ts); QA builds use
 * `lecturecompanion-qa<tag>://auth-callback`, covered by the `lecturecompanion-qa*://auth-callback` entry.
 */
export const TAURI_AUTH_CALLBACK = buildAuthCallbackUrl(PRODUCTION_AUTH_SCHEME)

/**
 * HTTP(S) path on the web origin that forwards query + hash to the custom scheme (see TauriAuthBridge).
 * Supabase redirect allow list must include the full URL, e.g. http://localhost:5173/tauri-auth-callback
 */
export const TAURI_AUTH_BRIDGE_PATH = '/tauri-auth-callback'

export function isTauriAuthBridgePathname(pathname: string): boolean {
  const normalized = pathname.replace(/\/$/, '') || '/'
  return normalized === TAURI_AUTH_BRIDGE_PATH
}

function bridgeOriginFromEnv(): string | null {
  const raw = import.meta.env.VITE_AUTH_BRIDGE_ORIGIN?.trim()
  if (!raw) return null
  return raw.replace(/\/$/, '')
}

/**
 * Email magic link + OAuth `emailRedirectTo` / `redirectTo`.
 *
 * Priority order:
 * 1. `VITE_AUTH_BRIDGE_ORIGIN` set → always use HTTPS bridge (most reliable; not gated on isTauri()).
 * 2. Not Tauri (pure web) → same-origin (Supabase detectSessionInUrl handles callback).
 * 3. Tauri + DEV → localhost bridge (Vite dev server serves /tauri-auth-callback).
 * 4. Tauri + PROD → custom scheme direct (lecturecompanion://auth-callback).
 * A non-Production build (QA) skips 1 and always returns its own `<scheme>://auth-callback`.
 *
 * NOTE: The envBridge check is intentionally FIRST — before isTauri() — so that production packaged
 * builds always use the Railway HTTPS bridge regardless of whether isTauri() resolves correctly
 * (window.location.origin in a packaged Tauri app is http://tauri.localhost, not a usable redirect).
 */
export async function getAuthRedirectUrl(): Promise<string> {
  if (typeof window === 'undefined') {
    return TAURI_AUTH_CALLBACK
  }
  // Non-Production desktop builds never use the HTTPS bridge: it forwards to the Production scheme only.
  // They redirect straight to their own scheme, which no other installed build owns.
  if (isTauri()) {
    const scheme = await getBuildAuthScheme()
    if (!isProductionAuthScheme(scheme)) return buildAuthCallbackUrl(scheme)
  }
  // If an explicit HTTPS bridge origin is configured, always use it — independent of isTauri().
  const envBridge = bridgeOriginFromEnv()
  if (envBridge) {
    return `${envBridge}${TAURI_AUTH_BRIDGE_PATH}`
  }
  if (!isTauri()) {
    return window.location.origin
  }
  if (import.meta.env.DEV) {
    return `${window.location.origin}${TAURI_AUTH_BRIDGE_PATH}`
  }
  return TAURI_AUTH_CALLBACK
}
