import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { isTauri } from '@tauri-apps/api/core'
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import { AuthContext, type AuthContextValue, type AuthMethodResult } from './authContext'
import { getAuthRedirectUrl } from './lib/authRedirect'
import { filterAuthCallbackUrls, getBuildAuthScheme } from './lib/authIdentity'
import { getSupabase, isSupabaseConfigured } from './lib/supabase'
import {
  checkEmail as apiCheckEmail,
  sendSignupCode as apiSendSignupCode,
  verifySignupCodeAndCreateUser as apiVerifySignupCodeAndCreateUser,
} from './lib/signupCodeApi'
import {
  applySessionFromSupabaseCallbackUrl,
  inspectAuthCallbackUrl,
} from './lib/supabaseDeepLinkAuth'
import { authTrace, redactUrl } from './lib/authTrace'
import { signOutDesktop, type SignOutOptions } from './lib/authSignOut'
import { checkPkceAuthorizeUrl } from './lib/authPkce'
import {
  mapSignInError,
  mapUpdatePasswordError,
  mapVerifyCodeError,
} from './lib/authErrors'

/**
 * What the user sees when a deep-link callback could not be turned into a session. Browser OAuth uses PKCE, so a failed
 * code exchange (no verifier on this device, expired / already-used code, network error) or a rejected legacy callback
 * shape is recoverable only by starting sign-in again FROM THIS APP. Never includes the code, the verifier or any token.
 */
function deepLinkFailureMessage(): string {
  return 'Sign-in couldn’t be completed. Please start sign-in again from this app.'
}

/**
 * Tauri may deliver `deep-link://new-url` as a JSON array of strings, but if anything coerces it to a
 * single string, `for..of` would iterate characters and session exchange would never run.
 */
function normalizeDeepLinkUrls(payload: unknown): string[] {
  if (payload == null) return []
  if (typeof payload === 'string') {
    return payload.includes('://') ? [payload] : []
  }
  if (Array.isArray(payload)) {
    return payload
      .map((x) => (typeof x === 'string' ? x : String(x)))
      .filter((s) => s.includes('://'))
  }
  console.warn('[lc-auth deep-link] unexpected payload shape', typeof payload)
  return []
}

/**
 * Deep-link URLs this build may act on: exactly `<this build's scheme>://auth-callback…`. Anything else
 * (another Youmi Lens build's scheme, wrong host/path, arbitrary `://` strings) is dropped before any
 * session code runs. Fails closed if the build identity cannot be resolved.
 */
async function acceptBuildCallbackUrls(payload: unknown): Promise<string[]> {
  const candidates = normalizeDeepLinkUrls(payload)
  if (candidates.length === 0) return []
  try {
    const accepted = filterAuthCallbackUrls(candidates, await getBuildAuthScheme())
    if (accepted.length !== candidates.length) {
      console.warn('[lc-auth deep-link] rejected callback URL(s) not addressed to this build', {
        rejected: candidates.length - accepted.length,
      })
    }
    return accepted
  } catch (e) {
    console.error('[lc-auth deep-link] build auth identity unresolved; callback dropped', e)
    return []
  }
}

function summarizeDeepLinkPayloadForLog(payload: unknown): {
  typeofPayload: string
  isArray: boolean
  arrayLength: number
  normalizedUrlCount: number
} {
  const normalized = normalizeDeepLinkUrls(payload)
  return {
    typeofPayload: typeof payload,
    isArray: Array.isArray(payload),
    arrayLength: Array.isArray(payload) ? payload.length : 0,
    normalizedUrlCount: normalized.length,
  }
}

/** Same-process safety: if anything created extra webviews, drop them after auth via deep link. */
async function tauriCloseNonMainWebviewWindows(): Promise<void> {
  if (!isTauri()) return
  try {
    const { getAllWebviewWindows } = await import('@tauri-apps/api/webviewWindow')
    const wins = await getAllWebviewWindows()
    await Promise.all(
      wins.filter((w) => w.label !== 'main').map((w) => w.close()),
    )
  } catch (e) {
    console.warn('[lc-auth] close non-main webview windows failed', e)
  }
}

function scrollAppChromeToTop(): void {
  try {
    window.scrollTo(0, 0)
    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0
    document.getElementById('root')?.scrollTo(0, 0)
  } catch {
    /* ignore */
  }
}

/** Desktop fallback after session is written: scroll reset + webview focus (Rust already activates the app). */
async function afterDeepLinkAuthSucceededUiPolish(): Promise<void> {
  await tauriCloseNonMainWebviewWindows()
  requestAnimationFrame(() => scrollAppChromeToTop())
  if (!isTauri()) return
  try {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    await getCurrentWebviewWindow().setFocus()
  } catch (e) {
    console.warn('[lc-auth] webview setFocus failed', e)
  }
}

function userForLog(s: Session | null): { id: string | null; email: string | null } {
  return {
    id: s?.user?.id ?? null,
    email: s?.user?.email ?? null,
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const configured = isSupabaseConfigured()
  const supabase = getSupabase()
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(configured)
  const [deepLinkAuthError, setDeepLinkAuthError] = useState<string | null>(null)
  const [inPasswordRecovery, setInPasswordRecovery] = useState(false)

  /**
   * Single bootstrap: subscribe first, then (Tauri) apply any pending deep-link auth before
   * the first getSession(). Magic-link params live on the app deep-link scheme, not window.location,
   * so Supabase URL detection never sees them; we end loading only after startup deep links run.
   */
  useEffect(() => {
    if (!supabase || !configured) return

    let cancelled = false

    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      console.info('[Auth] onAuthStateChange event:', event, { hasSession: Boolean(next) })
      authTrace('session.state_change', {
        event,
        hasSession: Boolean(next),
        // Which storage key the session landed under, so a dev can confirm it persisted
        // without ever seeing its contents.
        storageKeys:
          typeof localStorage === 'undefined'
            ? null
            : Object.keys(localStorage).filter((k) => k.startsWith('sb-')),
        origin: typeof window === 'undefined' ? null : window.location.origin,
      })
      if (cancelled) return
      setSession(next)
      // Supabase emits PASSWORD_RECOVERY after verifyOtp({type:'recovery'}) (the typed code — a recovery
      // deep link is no longer accepted, see supabaseDeepLinkAuth). The recovery session must not route into AuthenticatedApp until the user finishes
      // setting a new password; cleared on SIGNED_OUT which follows updateUser({password}).
      if (event === 'PASSWORD_RECOVERY') {
        setInPasswordRecovery(true)
      } else if (event === 'SIGNED_OUT') {
        setInPasswordRecovery(false)
      }
    })

    void (async () => {
      let sessionFromCallback: Session | null = null

      if (!isTauri() && typeof window !== 'undefined') {
        const inspect = inspectAuthCallbackUrl(window.location.href)
        const looksLikeAuthCallback =
          inspect.queryHasCode ||
          inspect.queryHasTokenHash ||
          inspect.hashHasAccessToken ||
          inspect.hashHasRefreshToken ||
          inspect.queryHasEmailAndToken
        if (looksLikeAuthCallback) {
          const { data: beforeData } = await supabase.auth.getSession()
          console.info('[lc-auth web-callback] detected in window.location', {
            inspect,
            beforeUser: userForLog(beforeData.session),
          })
          const applied = await applySessionFromSupabaseCallbackUrl(supabase, window.location.href, {
            source: 'webLocation',
          })
          if (applied.session) {
            sessionFromCallback = applied.session
            if (!cancelled) setSession(applied.session)
          }
          const { data: afterData } = await supabase.auth.getSession()
          console.info('[lc-auth web-callback] apply result', {
            branch: applied.branch,
            error: applied.error,
            hasReturnedSession: Boolean(applied.session),
            afterUser: userForLog(afterData.session),
          })
          if (!applied.error) {
            try {
              // Remove auth params so refresh won't re-run callback handling.
              window.history.replaceState({}, document.title, window.location.pathname)
            } catch {
              /* ignore */
            }
          }
        }
      }

      if (isTauri()) {
        try {
          const start = await getCurrent()
          const urls = await acceptBuildCallbackUrls(start)
          // Cold-start path: macOS launched the app FROM the deep link, so the URL is
          // waiting in getCurrent() rather than arriving via the onOpenUrl listener.
          authTrace('deeplink.received', {
            path: 'cold_start_getCurrent',
            count: urls.length,
            urls: urls.map(redactUrl),
          })
          if (urls.length) {
            console.info('[lc-auth deep-link] getCurrent', summarizeDeepLinkPayloadForLog(start), {
              urls: urls.map((u) => inspectAuthCallbackUrl(u)),
            })
            let anyOk = false
            for (const url of urls) {
              const _cb = inspectAuthCallbackUrl(url)
              console.info('[Auth] callback received:', {
                code: _cb.queryHasCode,
                access_token: _cb.hashHasAccessToken,
                refresh_token: _cb.hashHasRefreshToken,
              })
              const { data: beforeData } = await supabase.auth.getSession()
              console.info('[lc-auth deep-link] getCurrent before apply', userForLog(beforeData.session))
              const applied = await applySessionFromSupabaseCallbackUrl(supabase, url, {
                source: 'getCurrent',
              })
              console.info('[lc-auth deep-link] getCurrent apply result', {
                branch: applied.branch,
                error: applied.error,
                hasReturnedSession: Boolean(applied.session),
                returnedUser: userForLog(applied.session),
              })
              if (!applied.error) {
                anyOk = true
                if (applied.session) {
                  sessionFromCallback = applied.session
                  setSession(applied.session)
                  console.info('[Auth] setSession success: hasSession=true')
                }
              } else {
                console.error('[Auth] setSession failure:', applied.error, { branch: applied.branch })
                if (!cancelled) setDeepLinkAuthError(deepLinkFailureMessage())
              }
            }
            if (anyOk) await afterDeepLinkAuthSucceededUiPolish()
          }
        } catch (e) {
          console.warn('[lc-auth deep-link] getCurrent failed', e)
        }
      }

      const { data } = await supabase.auth.getSession()
      const finalSession = sessionFromCallback ?? data.session
      // Restart persistence check: was a session found in storage at boot, under which
      // key, and on which origin? A dev-server origin and a packaged `tauri://` origin
      // are different localStorage partitions — this line makes that visible.
      authTrace('session.bootstrap', {
        hasSession: Boolean(finalSession),
        fromDeepLinkCallback: Boolean(sessionFromCallback),
        fromStorage: Boolean(data.session),
        origin: typeof window === 'undefined' ? null : window.location.origin,
        storageKeys:
          typeof localStorage === 'undefined'
            ? null
            : Object.keys(localStorage).filter((k) => k.startsWith('sb-')),
      })
      if (!cancelled) {
        setSession(finalSession)
        console.info('[Auth] startup getSession result:', {
          hasSession: Boolean(finalSession),
        })
        console.info('[lc-auth bootstrap] getSession after deep-link pass', {
          hasSession: Boolean(finalSession),
          finalUser: userForLog(finalSession),
        })
        setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
    }
  }, [supabase, configured])

  /** Runtime deep links (e.g. app already open). Sync session after exchange. */
  useEffect(() => {
    if (!supabase || !configured || !isTauri()) return
    let unlisten: (() => void) | undefined

    void (async () => {
      try {
        unlisten = await onOpenUrl((payload) => {
          void (async () => {
            const urls = await acceptBuildCallbackUrls(payload)
            console.info('[lc-auth deep-link] onOpenUrl received', summarizeDeepLinkPayloadForLog(payload), {
              urls: urls.map((u) => inspectAuthCallbackUrl(u)),
            })
            // Warm path: app was already running. On macOS this is either a direct
            // RunEvent::Opened, or argv forwarded by single-instance and re-emitted
            // from Rust (see emit_forwarded_deep_link_urls in src-tauri/src/lib.rs).
            authTrace('deeplink.received', {
              path: 'running_onOpenUrl',
              count: urls.length,
              urls: urls.map(redactUrl),
            })
            if (urls.length === 0) {
              console.warn('[lc-auth deep-link] onOpenUrl: no valid URLs after normalize; auth step skipped')
            }
            let anyOk = false
            for (const url of urls) {
              const _cb = inspectAuthCallbackUrl(url)
              console.info('[Auth] callback received:', {
                code: _cb.queryHasCode,
                access_token: _cb.hashHasAccessToken,
                refresh_token: _cb.hashHasRefreshToken,
              })
              const { data: beforeData } = await supabase.auth.getSession()
              console.info('[lc-auth deep-link] onOpenUrl before apply', userForLog(beforeData.session))
              const applied = await applySessionFromSupabaseCallbackUrl(supabase, url, {
                source: 'onOpenUrl',
              })
              console.info('[lc-auth deep-link] onOpenUrl apply result', {
                branch: applied.branch,
                error: applied.error,
                hasReturnedSession: Boolean(applied.session),
                returnedUser: userForLog(applied.session),
              })
              if (!applied.error) {
                anyOk = true
                if (applied.session) {
                  setSession(applied.session)
                  setDeepLinkAuthError(null)
                  console.info('[Auth] setSession success: hasSession=true')
                }
              } else {
                console.error('[Auth] setSession failure:', applied.error, { branch: applied.branch })
                console.error('[lc-auth deep-link] onOpenUrl apply failed', applied.error)
                setDeepLinkAuthError(deepLinkFailureMessage())
              }
            }
            const { data } = await supabase.auth.getSession()
            setSession(data.session)
            console.info('[lc-auth deep-link] onOpenUrl getSession()', {
              hasSession: Boolean(data.session),
              finalUser: userForLog(data.session),
            })
            if (anyOk) await afterDeepLinkAuthSucceededUiPolish()
          })()
        })
      } catch (e) {
        console.warn(
          '[lc-auth deep-link] onOpenUrl listener failed (scheme / build / OS)',
          e,
        )
      }
    })()

    return () => {
      unlisten?.()
    }
  }, [supabase, configured])

  /**
   * OAuth launcher shared by Apple and Google.
   *
   * The Website calls signInWithOAuth and lets the browser navigate away. Desktop
   * cannot do that — the Tauri webview is the app — so the ONLY platform difference
   * lives here: `skipBrowserRedirect` keeps the webview put, and the authorize URL is
   * handed to the system browser. Supabase then returns via the HTTPS bridge or the
   * `lecturecompanion://auth-callback` deep link, which the existing deep-link
   * handlers above turn into a session. Everything above this function — buttons,
   * ordering, copy, error presentation — is identical to the Website.
   *
   * Returns a result instead of throwing so the auth screen can render the same
   * "Could not start sign-in" banner the Website shows.
   */
  const startOAuth = useCallback(
    async (provider: 'apple' | 'google'): Promise<AuthMethodResult> => {
      if (!supabase) {
        return {
          error:
            'Cloud sign-in isn’t available in this build. Use an official Youmi Lens release, or continue without an account.',
        }
      }
      setDeepLinkAuthError(null)
      const desktop = typeof window !== 'undefined' && isTauri()
      let redirectTo: string
      try {
        redirectTo = await getAuthRedirectUrl()
      } catch (e) {
        console.error('[Auth] build auth identity unresolved', e)
        return { error: 'Could not start sign-in. Please try again.' }
      }
      authTrace('oauth.click', { provider, desktop, redirectTo: redactUrl(redirectTo) })
      try {
        const { data, error } = await supabase.auth.signInWithOAuth({
          provider,
          options: {
            redirectTo,
            skipBrowserRedirect: desktop,
          },
        })
        if (error) {
          console.error('[Auth] signInWithOAuth failed', provider, error.message)
          authTrace('oauth.authorize_url', { provider, ok: false, reason: error.message })
          return { error: 'Could not start sign-in. Please try again.' }
        }
        authTrace('oauth.authorize_url', {
          provider,
          ok: true,
          hasUrl: Boolean(data.url),
          url: data.url ? redactUrl(data.url) : null,
        })
        if (desktop) {
          if (!data.url) {
            return { error: 'Could not start sign-in. Please try again.' }
          }
          // PKCE must really be S256. supabase-js silently downgrades to `plain` when WebCrypto is missing, which would put
          // the verifier itself in the browser URL — refuse to open the browser rather than start a weaker flow.
          const pkce = checkPkceAuthorizeUrl(data.url)
          if (!pkce.ok) {
            console.error('[Auth] OAuth authorize URL is not S256 PKCE; sign-in not started', pkce.reason)
            authTrace('oauth.pkce_guard', { provider, ok: false, reason: pkce.reason })
            return { error: 'Could not start sign-in securely on this device. Please try again or use email and password.' }
          }
          authTrace('oauth.pkce_guard', { provider, ok: true })
          const { open } = await import('@tauri-apps/plugin-shell')
          await open(data.url)
          authTrace('oauth.browser_open', { provider, ok: true })
        }
        return { error: null }
      } catch (e) {
        // Covers a failed plugin-shell open (no browser, blocked scheme) as well.
        console.error('[Auth] OAuth launch threw', provider, e)
        return { error: 'Could not start sign-in. Please try again.' }
      }
    },
    [supabase],
  )

  const signInWithGoogle = useCallback(() => startOAuth('google'), [startOAuth])
  const signInWithApple = useCallback(() => startOAuth('apple'), [startOAuth])

  const signInWithEmailOtp = useCallback(
    async (email: string) => {
      if (!supabase) {
        return {
          error:
            'Cloud sign-in isn’t available in this build. Use an official Youmi Lens release, or continue without an account.',
        }
      }
      const trimmed = email.trim()
      if (!trimmed) return { error: 'Enter your email address.' }
      let redirectUrl: string
      try {
        redirectUrl = await getAuthRedirectUrl()
      } catch (e) {
        console.error('[Auth] build auth identity unresolved', e)
        return { error: 'Could not start sign-in. Please try again.' }
      }
      console.info('[Auth] signInWithOtp redirectTo:', redirectUrl)
      console.info('[Auth] isTauri:', isTauri())
      console.info('[Auth] mode:', import.meta.env.MODE)
      console.info('[Auth] dev:', import.meta.env.DEV)
      console.info('[Auth] prod:', import.meta.env.PROD)
      setDeepLinkAuthError(null)
      const { error } = await supabase.auth.signInWithOtp({
        email: trimmed,
        options: { emailRedirectTo: redirectUrl },
      })
      return { error: error ? error.message : null }
    },
    [supabase],
  )

  const signInWithPassword = useCallback(
    async (email: string, password: string) => {
      if (!supabase) {
        return {
          error:
            'Cloud sign-in isn’t available in this build. Use an official Youmi Lens release, or continue without an account.',
        }
      }
      const trimmed = email.trim()
      if (!trimmed) return { error: 'Enter your email address.' }
      if (!password) return { error: 'Enter your password.' }
      setDeepLinkAuthError(null)
      const { error } = await supabase.auth.signInWithPassword({ email: trimmed, password })
      if (!error) return { error: null }
      /**
       * Network failures must NOT be reported as bad credentials. The Website maps
       * every signInWithPassword error to "Email or password is incorrect.", so an
       * offline user is told their password is wrong and retypes it forever. Supabase
       * marks transport failures as AuthRetryableFetchError (status 0 / "Failed to
       * fetch"), so they are separable — this uses the same network copy the Website
       * already uses for its fetch-based calls. Reported upstream as a Website defect.
       */
      return { error: mapSignInError(error) }
    },
    [supabase],
  )

  /**
   * Pre-flight email check before sending a signup code — the same call the Website
   * makes (landing/app/auth.js checkEmail) so an already-registered address is caught
   * before an email goes out. Advisory: a failed check never blocks signup, because
   * send-signup-code still returns `email_exists` as the authority.
   */
  const checkEmail = useCallback(async (email: string) => {
    return apiCheckEmail(email)
  }, [])

  const requestSignupCode = useCallback(
    async (args: { email: string; username: string }) => {
      if (!supabase) {
        return {
          error:
            'Cloud sign-in isn’t available in this build. Use an official Youmi Lens release, or continue without an account.',
          code: null,
        }
      }
      return apiSendSignupCode({
        email: args.email.trim(),
        username: args.username.trim(),
      })
    },
    [supabase],
  )

  const verifySignupCodeAndCreateUser = useCallback(
    async (args: { email: string; username: string; password: string; code: string }) => {
      if (!supabase) {
        return {
          error:
            'Cloud sign-in isn’t available in this build. Use an official Youmi Lens release, or continue without an account.',
          code: null,
        }
      }
      return apiVerifySignupCodeAndCreateUser({
        email: args.email.trim(),
        username: args.username.trim(),
        password: args.password,
        code: args.code.replace(/\s/g, ''),
      })
    },
    [supabase],
  )

  const requestPasswordResetCode = useCallback(
    async (email: string) => {
      if (!supabase) {
        return {
          error:
            'Cloud sign-in isn’t available in this build. Use an official Youmi Lens release, or continue without an account.',
        }
      }
      const trimmed = email.trim()
      if (!trimmed) return { error: 'Enter your email address.' }
      /**
       * NO redirectTo — deliberate, and identical to the Website
       * (landing/app/auth.js sendPasswordResetCode) and iPad (lib/auth.tsx).
       *
       * Passing a redirect turns the recovery email into a link-based flow aimed at
       * the desktop deep link, which contradicts the code-entry screen this app
       * actually shows. Omitting it keeps all three surfaces on the one shared
       * mechanism: emailed recovery OTP → verifyOtp({type:'recovery'}) → updateUser.
       */
      const { error } = await supabase.auth.resetPasswordForEmail(trimmed)
      /**
       * Enumeration-safe: "user not found" is reported to the UI as success, so the
       * screen can advance and say "if an account exists…". Any OTHER failure
       * (offline, mailer down) IS surfaced — the Website does the same. Previously
       * every error was swallowed, so a network failure silently advanced the user
       * to a code screen for a code that was never sent.
       */
      if (error && !/not\s*found/i.test(error.message || '')) {
        console.error('[Auth] resetPasswordForEmail failed', error.message)
        return { error: 'Could not send the reset email. Please try again.' }
      }
      return { error: null }
    },
    [supabase],
  )

  const verifyPasswordResetCode = useCallback(
    async (email: string, code: string) => {
      if (!supabase) {
        return {
          error:
            'Cloud sign-in isn’t available in this build. Use an official Youmi Lens release, or continue without an account.',
        }
      }
      const trimmedEmail = email.trim()
      const trimmedCode = code.replace(/\s/g, '')
      if (!trimmedEmail) return { error: 'Enter your email address.' }
      if (!trimmedCode) return { error: 'Enter the verification code.' }
      const { error } = await supabase.auth.verifyOtp({
        email: trimmedEmail,
        token: trimmedCode,
        type: 'recovery',
      })
      if (!error) {
        // Defensive: set recovery flag immediately so a race between this resolving and the
        // PASSWORD_RECOVERY event can never let App.tsx mount AuthenticatedApp first.
        setInPasswordRecovery(true)
        return { error: null }
      }
      return { error: mapVerifyCodeError(error) }
    },
    [supabase],
  )

  const updatePassword = useCallback(
    async (newPassword: string) => {
      if (!supabase) {
        return {
          error:
            'Cloud sign-in isn’t available in this build. Use an official Youmi Lens release, or continue without an account.',
        }
      }
      if (newPassword.length < 8) {
        return { error: 'Password must be at least 8 characters.' }
      }
      const { error } = await supabase.auth.updateUser({ password: newPassword })
      if (!error) return { error: null }
      return { error: mapUpdatePasswordError(error) }
    },
    [supabase],
  )

  /**
   * Returns a result instead of throwing, matching the Website (landing/app/auth.js
   * signOut, which always resolves). It previously threw, and the only caller invoked
   * it as `void auth.signOut()` — so a failed sign-out became an unhandled rejection,
   * the button's busy state cleared instantly, and the user was left looking at a
   * signed-in app with no indication anything had gone wrong.
   *
   * Scope: a normal sign-out ends THIS Desktop session only (`scope: 'local'`, see
   * lib/authSignOut.ts). `local` still revokes this session's refresh token on the
   * server (POST /logout?scope=local) and leaves the account's other sessions alone;
   * supabase-js's default `global` would sign the user out of every build and device.
   * Only an explicit `{ scope: 'global' }` (password-reset confirmation) widens it.
   *
   * Local state is cleared even when the network call fails (network error, HTTP 5xx,
   * expired token): supabase-js 2.101.1 still removes the persisted session and emits
   * SIGNED_OUT, so the message returned on error is accurate. Pinned by
   * lib/authSignOut.test.ts against the real client.
   */
  const signOut = useCallback(
    async (options?: SignOutOptions): Promise<AuthMethodResult> => signOutDesktop(supabase, options),
    [supabase],
  )

  const clearDeepLinkAuthError = useCallback(() => {
    setDeepLinkAuthError(null)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      configured,
      loading,
      session,
      user: session?.user ?? null,
      inPasswordRecovery,
      signInWithGoogle,
      signInWithApple,
      signInWithEmailOtp,
      signInWithPassword,
      checkEmail,
      requestSignupCode,
      verifySignupCodeAndCreateUser,
      requestPasswordResetCode,
      verifyPasswordResetCode,
      updatePassword,
      signOut,
      deepLinkAuthError,
      clearDeepLinkAuthError,
    }),
    [
      configured,
      loading,
      session,
      inPasswordRecovery,
      signInWithGoogle,
      signInWithApple,
      signInWithEmailOtp,
      signInWithPassword,
      checkEmail,
      requestSignupCode,
      verifySignupCodeAndCreateUser,
      requestPasswordResetCode,
      verifyPasswordResetCode,
      updatePassword,
      signOut,
      deepLinkAuthError,
      clearDeepLinkAuthError,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
