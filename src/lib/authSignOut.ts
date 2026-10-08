/**
 * Desktop sign-out.
 *
 * A user pressing "Sign out" in a Desktop build must end THIS Desktop session only. supabase-js defaults to
 * `scope: 'global'`, which revokes every refresh token of the account — signing the same person out of Production
 * Desktop, other QA builds, the iPad and the Website too. So the scope is always passed explicitly here and defaults
 * to `'local'`.
 *
 * `local` is NOT "client-side only": supabase-js still POSTs `/logout?scope=local`, which revokes THIS session's refresh
 * token on the server, and then removes the persisted session. Other sessions are untouched.
 *
 * `global` is reserved for security-sensitive flows that deliberately end every session (the password-reset
 * confirmation). Anything that is not exactly `'global'` — including a stray click event passed as the argument — is
 * treated as `'local'`; `'others'` can never be requested through this module.
 */
export type SignOutScope = 'local' | 'global'
export type SignOutOptions = { scope?: SignOutScope }
export type SignOutResult = { error: string | null }

/** The slice of the Supabase client used here (keeps the module testable without the real client). */
export type SignOutClient = {
  auth: { signOut: (options: { scope: SignOutScope }) => Promise<{ error: { message: string } | null }> }
}

export const SIGN_OUT_FAILED_MESSAGE = 'Could not reach the server, but you have been signed out on this device.'

export function resolveSignOutScope(options?: unknown): SignOutScope {
  const scope = (options as SignOutOptions | null | undefined)?.scope
  return scope === 'global' ? 'global' : 'local'
}

/** Resolves (never rejects on a Supabase error), like the Website's signOut. */
export async function signOutDesktop(client: SignOutClient | null | undefined, options?: SignOutOptions): Promise<SignOutResult> {
  if (!client) return { error: null }
  const { error } = await client.auth.signOut({ scope: resolveSignOutScope(options) })
  if (error) {
    console.error('[Auth] signOut failed', error.message)
    return { error: SIGN_OUT_FAILED_MESSAGE }
  }
  return { error: null }
}
