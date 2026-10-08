import { useEffect } from 'react'
import { TAURI_AUTH_CALLBACK } from '../lib/authRedirect'

/**
 * Loaded in the **system browser** after Supabase redirects to http(s)…/tauri-auth-callback?…#…
 * Forwards the same search + hash to the Production scheme (lecturecompanion://auth-callback) so the desktop
 * app receives the deep link. This dev/browser page has no Tauri runtime, hence no QA identity: QA builds
 * never use a bridge and redirect straight to their own scheme (see getAuthRedirectUrl).
 */
export function TauriAuthBridge() {
  const search = typeof window !== 'undefined' ? window.location.search : ''
  const hash = typeof window !== 'undefined' ? window.location.hash : ''

  useEffect(() => {
    if (!search && !hash) return
    const target = `${TAURI_AUTH_CALLBACK}${search}${hash}`
    window.location.replace(target)
  }, [search, hash])

  if (!search && !hash) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
          fontFamily: 'system-ui, sans-serif',
          color: '#333',
          textAlign: 'center',
        }}
      >
        <p style={{ maxWidth: 360, margin: 0, lineHeight: 1.5 }}>
          No login parameters in this link. Close this tab and sign in again from the Youmi Lens app.
        </p>
      </div>
    )
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        fontFamily: 'system-ui, sans-serif',
        color: '#333',
        textAlign: 'center',
      }}
    >
      <p style={{ maxWidth: 360, margin: 0, lineHeight: 1.5 }}>Opening Youmi Lens…</p>
    </div>
  )
}
