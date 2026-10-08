import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { authTrace, redactUrl } from './authTrace'
import { isPlausibleAuthCode } from './authPkce'

const LOG = '[lc-auth deep-link]'

function parseQueryOnly(href: string): Record<string, string> {
  const url = new URL(href)
  const result: Record<string, string> = {}
  url.searchParams.forEach((value, key) => {
    result[key] = value
  })
  return result
}

function parseHashOnly(href: string): Record<string, string> {
  const result: Record<string, string> = {}
  const url = new URL(href)
  if (url.hash && url.hash[0] === '#') {
    try {
      new URLSearchParams(url.hash.substring(1)).forEach((value, key) => {
        result[key] = value
      })
    } catch {
      /* ignore */
    }
  }
  return result
}

/**
 * Mirrors `@supabase/auth-js` `parseParametersFromURL` (not exported from the package root).
 * Collects query params and hash fragment into one map (query wins over hash).
 */
function parseParametersFromURL(href: string): Record<string, string> {
  const result: Record<string, string> = {}
  const url = new URL(href)
  if (url.hash && url.hash[0] === '#') {
    try {
      new URLSearchParams(url.hash.substring(1)).forEach((value, key) => {
        result[key] = value
      })
    } catch {
      /* ignore malformed hash */
    }
  }
  url.searchParams.forEach((value, key) => {
    result[key] = value
  })
  return result
}

/**
 * Safe for console: no token values, only presence / shape flags.
 */
export function inspectAuthCallbackUrl(href: string): {
  hrefLength: number
  hasAuthCallbackSubstring: boolean
  queryHasCode: boolean
  hashHasAccessToken: boolean
  hashHasRefreshToken: boolean
  queryHasTokenHash: boolean
  queryHasEmailAndToken: boolean
  hasOAuthErrorParams: boolean
  paramKeys: string[]
  parseOk: boolean
} {
  try {
    const q = parseQueryOnly(href)
    const h = parseHashOnly(href)
    const merged = parseParametersFromURL(href)
    return {
      hrefLength: href.length,
      hasAuthCallbackSubstring: href.includes('auth-callback'),
      queryHasCode: Boolean(q.code),
      hashHasAccessToken: Boolean(h.access_token),
      hashHasRefreshToken: Boolean(h.refresh_token),
      queryHasTokenHash: Boolean(q.token_hash ?? merged.token_hash),
      queryHasEmailAndToken: Boolean(
        (merged.email || q.email) && (merged.token || q.token) && (merged.type || q.type),
      ),
      hasOAuthErrorParams: Boolean(merged.error || merged.error_description),
      paramKeys: Object.keys(merged).sort(),
      parseOk: true,
    }
  } catch {
    return {
      hrefLength: href.length,
      hasAuthCallbackSubstring: href.includes('auth-callback'),
      queryHasCode: false,
      hashHasAccessToken: false,
      hashHasRefreshToken: false,
      queryHasTokenHash: false,
      queryHasEmailAndToken: false,
      hasOAuthErrorParams: false,
      paramKeys: [],
      parseOk: false,
    }
  }
}

export type ApplySessionBranch =
  | 'oauth_error'
  | 'exchange_code'
  | 'invalid_code'
  /** An implicit-flow callback (bearer access/refresh tokens in the URL). Never consumed: see applySessionInner. */
  | 'implicit_rejected'
  /** An emailed one-time-token callback (`token_hash`, or `email` + `token`). Never consumed: see applySessionInner. */
  | 'otp_callback_rejected'
  | 'no_usable_params'
  | 'parse_error'

export type ApplySessionResult = {
  error: string | null
  branch: ApplySessionBranch
  /** Session returned by Supabase for this step (prefer over a follow-up getSession when non-null). */
  session: Session | null
}

/**
 * Completes Supabase auth from a redirect URL delivered via Tauri deep link (Apple / Google browser OAuth).
 *
 * The ONLY credential a callback can carry is a PKCE authorization `code`. Accepted order:
 *   1. a provider/Supabase `error`  → surfaced, nothing consumed
 *   2. PKCE `code`                  → exchangeCodeForSession, which needs the verifier THIS build stored when it started
 *                                      the flow; a code issued to any other build/instance fails without a session
 * REJECTED (no session, no Supabase call of any kind):
 *   - implicit bearer tokens (`access_token` / `refresh_token`)      → 'implicit_rejected'
 *   - emailed one-time tokens (`token_hash`, or `email` + `token`)    → 'otp_callback_rejected'
 * Those shapes carry no initiator binding: whichever installed build receives the URL could turn them into a session,
 * so a forged or misrouted callback would sign it in as an arbitrary account. No Desktop flow generates them — password
 * sign-in, signup (backend code, then password) and password recovery (typed code, no redirect) use no callback, and the
 * typed email OTP is verified in-app by AuthProvider.verifyPasswordResetCode, never from a URL.
 *
 * A callback that carries a `code` is exchanged on that code alone — any other credential in the same URL is ignored,
 * never consumed — so a mixed URL cannot steer us onto an unbound path.
 */
export async function applySessionFromSupabaseCallbackUrl(
  supabase: SupabaseClient,
  callbackUrl: string,
  meta: { source: 'getCurrent' | 'onOpenUrl' | 'webLocation' },
): Promise<ApplySessionResult> {
  const result = await applySessionInner(supabase, callbackUrl, meta)
  // One line per attempt naming the branch taken (exchange_code vs set_session_implicit
  // vs verify_*), whether Supabase returned a session, and the failure reason if any.
  // This is what tells you whether the callback was PKCE or implicit without ever
  // logging the code or the tokens.
  authTrace('deeplink.apply.result', {
    source: meta.source,
    branch: result.branch,
    ok: result.error === null,
    hasSession: Boolean(result.session),
    error: result.error,
  })
  return result
}

async function applySessionInner(
  supabase: SupabaseClient,
  callbackUrl: string,
  meta: { source: 'getCurrent' | 'onOpenUrl' | 'webLocation' },
): Promise<ApplySessionResult> {
  let params: Record<string, string>
  try {
    params = parseParametersFromURL(callbackUrl)
  } catch (e) {
    console.error(`${LOG} parseParametersFromURL threw [${meta.source}]`, e)
    return { error: 'Invalid callback URL', branch: 'parse_error', session: null }
  }

  console.info(`${LOG} applySession start [${meta.source}]`, inspectAuthCallbackUrl(callbackUrl))
  authTrace('deeplink.apply.start', { source: meta.source, url: redactUrl(callbackUrl) })

  if (params.error || params.error_description) {
    console.warn(`${LOG} branch: oauth_error (not attempting session) [${meta.source}]`)
    return {
      error: params.error_description || params.error || 'Authentication failed',
      branch: 'oauth_error',
      session: null,
    }
  }

  // PKCE. The code is exchanged against the verifier this build stored when it started the flow; a code issued to a
  // different build/instance has no matching verifier here and the exchange fails without establishing a session.
  if (params.code !== undefined) {
    if (!isPlausibleAuthCode(params.code)) {
      console.warn(`${LOG} branch: invalid_code (malformed code; not sent to Supabase) [${meta.source}]`)
      return { error: 'Invalid sign-in callback', branch: 'invalid_code', session: null }
    }
    console.info(`${LOG} branch: exchangeCodeForSession (PKCE code present) [${meta.source}]`)
    const { data, error } = await supabase.auth.exchangeCodeForSession(params.code)
    if (error) {
      console.error(`${LOG} exchangeCodeForSession FAILED`, error.message)
    } else {
      console.info(`${LOG} exchangeCodeForSession OK hasSession=${Boolean(data.session)}`)
    }
    return {
      error: error?.message ?? null,
      branch: 'exchange_code',
      session: data?.session ?? null,
    }
  }

  if (params.token_hash || params.token) {
    // One-time email tokens in a URL: never consumed, never logged (`type` is only a hint and is not trusted either).
    console.warn(`${LOG} branch: otp_callback_rejected (emailed-token callback not accepted) [${meta.source}]`)
    return {
      error: 'This sign-in link is no longer supported',
      branch: 'otp_callback_rejected',
      session: null,
    }
  }

  if (params.access_token || params.refresh_token) {
    // Bearer tokens in a URL: never consumed, never logged. (Legacy implicit links sent before PKCE simply stop working.)
    console.warn(`${LOG} branch: implicit_rejected (bearer-token callback not accepted) [${meta.source}]`)
    return {
      error: 'This sign-in link is no longer supported',
      branch: 'implicit_rejected',
      session: null,
    }
  }

  console.error(
    `${LOG} branch: no_usable_params [${meta.source}] paramKeys=${Object.keys(params).sort().join(',') || '(none)'}`,
  )
  return {
    error: 'No auth parameters found in callback URL',
    branch: 'no_usable_params',
    session: null,
  }
}
