import { invoke, isTauri } from '@tauri-apps/api/core'

/**
 * Build-aware desktop auth callback identity.
 *
 * Single source of truth: `plugins.deep-link.desktop.schemes` in the Tauri config the build was packaged
 * with (the same value that becomes CFBundleURLSchemes). Rust reads it and exposes it through the
 * `auth_callback_scheme` command; this module only validates and consumes it. Production keeps
 * `lecturecompanion`; a QA overlay (scripts/qa-build-identity.mjs) swaps in `lecturecompanion-qa<tag>`.
 *
 * macOS URL schemes are a global namespace, so each coexisting build must own a distinct one.
 */
export const PRODUCTION_AUTH_SCHEME = 'lecturecompanion'
export const AUTH_CALLBACK_HOST = 'auth-callback'

/** `lecturecompanion` (Production) or `lecturecompanion-qa<alnum tag>` (QA). Nothing else is a Youmi Lens scheme. */
const QA_SCHEME = /^lecturecompanion-qa[a-z0-9]{1,16}$/

export function isValidAuthScheme(scheme: unknown): scheme is string {
  return typeof scheme === 'string' && (scheme === PRODUCTION_AUTH_SCHEME || QA_SCHEME.test(scheme))
}

export function isProductionAuthScheme(scheme: string): boolean {
  return scheme === PRODUCTION_AUTH_SCHEME
}

export function buildAuthCallbackUrl(scheme: string): string {
  if (!isValidAuthScheme(scheme)) throw new Error('invalid_auth_scheme')
  return `${scheme}://${AUTH_CALLBACK_HOST}`
}

/**
 * True only for `<scheme>://auth-callback` optionally followed by `/`, `?query` or `#hash`.
 * Rejects other schemes (including other Youmi Lens builds), other hosts/paths, userinfo and look-alikes
 * such as `auth-callback.evil` or `auth-callback@evil`.
 */
export function isAuthCallbackForScheme(url: unknown, scheme: string): boolean {
  if (typeof url !== 'string' || !isValidAuthScheme(scheme)) return false
  const trimmed = url.trim()
  const prefix = `${scheme}://${AUTH_CALLBACK_HOST}`
  if (trimmed.slice(0, prefix.length).toLowerCase() !== prefix) return false
  const rest = trimmed.slice(prefix.length)
  if (rest === '') return true
  if (rest[0] === '?' || rest[0] === '#') return true
  return rest[0] === '/' && (rest.length === 1 || rest[1] === '?' || rest[1] === '#')
}

export function filterAuthCallbackUrls(urls: string[], scheme: string): string[] {
  return urls.filter((u) => isAuthCallbackForScheme(u, scheme))
}

let schemePromise: Promise<string> | null = null

/** Resolves this build's callback scheme once. Outside Tauri (web, tests) it is the Production scheme. */
export function getBuildAuthScheme(): Promise<string> {
  if (!schemePromise) {
    schemePromise = (async () => {
      if (!isTauri()) return PRODUCTION_AUTH_SCHEME
      const scheme = await invoke<unknown>('auth_callback_scheme')
      if (!isValidAuthScheme(scheme)) throw new Error('auth_identity_invalid')
      return scheme
    })()
    // A failed resolution must be retried, never cached as a silent Production fallback.
    schemePromise.catch(() => {
      schemePromise = null
    })
  }
  return schemePromise
}

/** Test seam: clears the cached resolution. */
export function resetBuildAuthSchemeForTests(): void {
  schemePromise = null
}
