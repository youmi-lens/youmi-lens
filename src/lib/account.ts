/**
 * Desktop account-deletion client — thin authenticated wrapper around the
 * existing `/api/account` DELETE route (server/accountRoutes.mjs). No new
 * auth system: reuses the same Supabase session the billing client reads.
 */
import { getAiApiBase } from './ai/apiBase'
import { getSupabase } from './supabase'

export type AccountApiErrorKind = 'http' | 'auth' | 'network'

export class AccountApiError extends Error {
  readonly kind: AccountApiErrorKind
  readonly status: number | null
  readonly code: string | null

  constructor(kind: AccountApiErrorKind, message: string, opts: { status?: number | null; code?: string | null } = {}) {
    super(message)
    this.name = 'AccountApiError'
    this.kind = kind
    this.status = opts.status ?? null
    this.code = opts.code ?? null
  }
}

async function requireAccessToken(): Promise<string> {
  const supabase = getSupabase()
  if (!supabase) {
    throw new AccountApiError('auth', 'Sign in required.', { status: 401, code: 'auth_required' })
  }
  let token: string | undefined
  try {
    const { data } = await supabase.auth.getSession()
    token = data.session?.access_token ?? undefined
  } catch {
    throw new AccountApiError('auth', 'Could not read session.', { status: 401, code: 'auth_required' })
  }
  if (!token) {
    throw new AccountApiError('auth', 'Sign in required.', { status: 401, code: 'auth_required' })
  }
  return token
}

function readErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback
  const message = (body as { message?: unknown }).message
  return typeof message === 'string' && message.length > 0 ? message : fallback
}

function readErrorCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const code = (body as { error?: unknown }).error
  return typeof code === 'string' && code.length > 0 ? code : null
}

/** Permanently deletes the signed-in user's account and data. Irreversible. */
export async function deleteAccount(): Promise<void> {
  const token = await requireAccessToken()

  let res: Response
  try {
    res = await fetch(`${getAiApiBase()}/account`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch {
    throw new AccountApiError('network', 'Network error deleting account.', {
      status: null,
      code: 'network_error',
    })
  }

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // Some error responses may not carry a JSON body; status handling below covers it.
  }

  if (res.status === 401) {
    throw new AccountApiError('auth', readErrorMessage(body, 'Sign in required.'), {
      status: 401,
      code: readErrorCode(body) ?? 'auth_required',
    })
  }

  if (!res.ok) {
    throw new AccountApiError('http', readErrorMessage(body, `Account deletion failed (${res.status}).`), {
      status: res.status,
      code: readErrorCode(body),
    })
  }
}
