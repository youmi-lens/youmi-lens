/**
 * getAuthRedirectUrl decides where Supabase sends the user back after OAuth, and it
 * is the single thing that makes desktop sign-in work or silently fail: if the value
 * is not in the Supabase "Redirect URLs" allow-list, Supabase falls back to the Site
 * URL and the app never receives a session.
 *
 * Allow-list read from the dashboard on 2026-07-31 (project lbwsrnjbiayepshrdult):
 *   lecturecompanion://auth-callback                                       ← packaged desktop
 *   https://youmi-lens-production.up.railway.app/tauri-auth-callback       ← desktop bridge
 *   youmilens://auth/callback, exp://*                                     ← iPad
 *   https://youmilens.com/{account,reset-password}/                        ← website
 *   http://localhost:8080/{account,reset-password}/                        ← local website
 *
 * Note what is NOT there: http://localhost:5173/tauri-auth-callback. That is exactly
 * what this function returns for `tauri dev` unless VITE_AUTH_BRIDGE_ORIGIN is set,
 * which is why the local .env sets it. These tests pin both the allow-listed outputs
 * and that dev-only trap so it cannot be reintroduced unnoticed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TAURI_AUTH_CALLBACK, isTauriAuthBridgePathname } from './authRedirect'

const ALLOWLISTED = new Set([
  'lecturecompanion://auth-callback',
  'https://youmi-lens-production.up.railway.app/tauri-auth-callback',
])

afterEach(() => {
  vi.resetModules()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/** Re-import with a chosen env + isTauri result, since the module reads both at call time. */
async function loadWithEnv(opts: {
  bridgeOrigin?: string
  dev: boolean
  tauri: boolean
  origin: string
  scheme?: string
}) {
  vi.resetModules()
  vi.doMock('@tauri-apps/api/core', () => ({
    isTauri: () => opts.tauri,
    invoke: async () => opts.scheme ?? 'lecturecompanion',
  }))
  vi.stubEnv('DEV', opts.dev)
  vi.stubEnv('VITE_AUTH_BRIDGE_ORIGIN', opts.bridgeOrigin ?? '')
  vi.stubGlobal('window', { location: { origin: opts.origin } })
  const mod = await import('./authRedirect')
  return mod.getAuthRedirectUrl()
}

describe('getAuthRedirectUrl', () => {
  it('packaged desktop (Tauri, prod, no bridge) uses the allow-listed custom scheme', async () => {
    const url = await loadWithEnv({ dev: false, tauri: true, origin: 'http://tauri.localhost' })
    expect(url).toBe(TAURI_AUTH_CALLBACK)
    expect(ALLOWLISTED.has(url)).toBe(true)
  })

  it('an explicit bridge origin wins everywhere, and is allow-listed', async () => {
    const url = await loadWithEnv({
      bridgeOrigin: 'https://youmi-lens-production.up.railway.app',
      dev: true,
      tauri: true,
      origin: 'http://localhost:5173',
    })
    expect(url).toBe('https://youmi-lens-production.up.railway.app/tauri-auth-callback')
    expect(ALLOWLISTED.has(url)).toBe(true)
  })

  it('trailing slashes on the bridge origin do not produce a double slash', async () => {
    const url = await loadWithEnv({
      bridgeOrigin: 'https://youmi-lens-production.up.railway.app/',
      dev: true,
      tauri: true,
      origin: 'http://localhost:5173',
    })
    expect(url).toBe('https://youmi-lens-production.up.railway.app/tauri-auth-callback')
  })

  it('DOCUMENTS THE TRAP: tauri dev without a bridge origin yields a NON-allow-listed URL', async () => {
    const url = await loadWithEnv({ dev: true, tauri: true, origin: 'http://localhost:5173' })
    expect(url).toBe('http://localhost:5173/tauri-auth-callback')
    // Not in the dashboard allow-list — OAuth would silently fall back to the Site URL.
    expect(ALLOWLISTED.has(url)).toBe(false)
  })

  it('QA build ignores the (Production-only) bridge and redirects straight to its own scheme', async () => {
    for (const [scheme, expected] of [
      ['lecturecompanion-qa1015', 'lecturecompanion-qa1015://auth-callback'],
      ['lecturecompanion-qa1016', 'lecturecompanion-qa1016://auth-callback'],
    ]) {
      const url = await loadWithEnv({
        bridgeOrigin: 'https://youmi-lens-production.up.railway.app',
        dev: false,
        tauri: true,
        origin: 'http://tauri.localhost',
        scheme,
      })
      expect(url).toBe(expected)
      expect(url.startsWith('https://')).toBe(false)
    }
  })

  it('a corrupt scheme from the runtime fails closed instead of falling back to Production', async () => {
    await expect(
      loadWithEnv({ dev: false, tauri: true, origin: 'http://tauri.localhost', scheme: 'evil' }),
    ).rejects.toThrow('auth_identity_invalid')
  })

  it('plain web uses the page origin', async () => {
    const url = await loadWithEnv({ dev: false, tauri: false, origin: 'https://youmilens.com' })
    expect(url).toBe('https://youmilens.com')
  })
})

describe('isTauriAuthBridgePathname', () => {
  it('matches the bridge path with or without a trailing slash', () => {
    expect(isTauriAuthBridgePathname('/tauri-auth-callback')).toBe(true)
    expect(isTauriAuthBridgePathname('/tauri-auth-callback/')).toBe(true)
  })

  it('does not match anything else', () => {
    expect(isTauriAuthBridgePathname('/')).toBe(false)
    expect(isTauriAuthBridgePathname('/account/')).toBe(false)
    expect(isTauriAuthBridgePathname('/tauri-auth-callback-x')).toBe(false)
  })
})
