/**
 * PKCE guards for browser OAuth (Desktop).
 *
 * The Supabase client is configured with `flowType: 'pkce'` (lib/supabase.ts): the OAuth callback carries an
 * authorization CODE, and only the app instance that holds the matching code verifier — stored by supabase-js in THIS
 * build's own WebView localStorage — can exchange it. No reusable access/refresh token travels in the callback URL.
 *
 * Two small guards live here because the library is lenient where we must not be:
 *
 *  - supabase-js silently falls back to the `plain` challenge method when WebCrypto is unavailable. A `plain` challenge
 *    IS the verifier, so it would sit in the browser URL and the binding would be worthless. The authorize URL is therefore
 *    checked before the browser is opened and sign-in is refused unless it is S256.
 *  - a callback `code` is a short opaque token; anything else (spaces, slashes, markup, huge strings) is rejected locally
 *    before it can reach the network.
 */

export type PkceAuthorizeCheck = { ok: true } | { ok: false; reason: 'unparseable_url' | 'missing_code_challenge' | 'challenge_method_not_s256' }

/** Is this the authorize URL of an S256 PKCE flow? Never logs or returns the challenge value. */
export function checkPkceAuthorizeUrl(href: string | null | undefined): PkceAuthorizeCheck {
  let url: URL
  try {
    url = new URL(String(href ?? ''))
  } catch {
    return { ok: false, reason: 'unparseable_url' }
  }
  const challenge = url.searchParams.get('code_challenge')
  if (!challenge || challenge.trim() === '') return { ok: false, reason: 'missing_code_challenge' }
  if ((url.searchParams.get('code_challenge_method') ?? '').toLowerCase() !== 's256') {
    return { ok: false, reason: 'challenge_method_not_s256' }
  }
  return { ok: true }
}

const AUTH_CODE_PATTERN = /^[A-Za-z0-9._~-]{1,512}$/

/** A callback authorization code must be a plausible opaque token. */
export function isPlausibleAuthCode(code: unknown): code is string {
  return typeof code === 'string' && AUTH_CODE_PATTERN.test(code)
}
