/**
 * Dev-only structured trace for the OAuth / deep-link sign-in chain.
 *
 * HARD RULE: this module never accepts or prints a secret. Callers pass presence
 * flags, never values. `redactUrl` exists so a URL can be logged as scheme + path +
 * PARAMETER NAMES ONLY — every value is dropped, so an access_token, refresh_token,
 * authorization code, or token_hash can never reach the console through it.
 *
 * Silent unless `import.meta.env.DEV`, so packaged builds emit nothing.
 */

const ENABLED = import.meta.env.DEV

/** Params whose presence is worth tracing. Values are NEVER read. */
const INTERESTING = [
  'code',
  'access_token',
  'refresh_token',
  'token_hash',
  'token',
  'type',
  'error',
  'error_description',
  'state',
] as const

export type AuthTraceStep =
  | 'oauth.click'
  | 'oauth.authorize_url'
  | 'oauth.pkce_guard'
  | 'oauth.browser_open'
  | 'deeplink.received'
  | 'deeplink.apply.start'
  | 'deeplink.apply.result'
  | 'session.state_change'
  | 'session.bootstrap'
  | 'gate.render'

/**
 * Scheme + host + path + which parameter names were present. No values, ever.
 * A malformed URL degrades to a length-only report rather than echoing the string.
 */
export function redactUrl(href: string): Record<string, unknown> {
  try {
    const u = new URL(href)
    const names = new Set<string>()
    u.searchParams.forEach((_v, k) => names.add(k))
    if (u.hash.startsWith('#')) {
      new URLSearchParams(u.hash.slice(1)).forEach((_v, k) => names.add(k))
    }
    const present: Record<string, boolean> = {}
    for (const k of INTERESTING) present[k] = names.has(k)
    return {
      scheme: u.protocol.replace(':', ''),
      host: u.host || null,
      path: u.pathname,
      paramNames: [...names].sort(),
      present,
      hasHash: u.hash.length > 1,
      hasQuery: u.search.length > 1,
      length: href.length,
    }
  } catch {
    return { parseOk: false, length: href.length }
  }
}

export function authTrace(step: AuthTraceStep, detail: Record<string, unknown> = {}): void {
  if (!ENABLED) return
  // Single-line JSON so a whole sign-in attempt can be grepped out of the dev log.
  console.info(`[auth-trace] ${step}`, JSON.stringify(detail))
}

export const authTraceEnabled = ENABLED
