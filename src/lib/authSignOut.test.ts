/**
 * Desktop "Sign out" ends THIS Desktop session only.
 *
 * supabase-js defaults `signOut()` to `scope: 'global'`, which revokes every refresh token of the account (other
 * builds, Production Desktop, iPad, Website). These tests prove the normal logout path is `local`, that `global` can only
 * be requested explicitly, and — against the REAL supabase-js client with a fake network and in-memory storage — that
 * the request that actually leaves the app is `POST /logout?scope=local` and the local session is cleared.
 * No real account, token or server is touched.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { SIGN_OUT_FAILED_MESSAGE, resolveSignOutScope, signOutDesktop, type SignOutClient } from './authSignOut'

const mockClient = (result: { error: { message: string } | null } = { error: null }) => {
  const signOut = vi.fn<SignOutClient['auth']['signOut']>(async () => result)
  return { client: { auth: { signOut } } as SignOutClient, signOut }
}

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => { errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks() })

describe('1. normal Desktop Sign out is LOCAL', () => {
  it('defaults to scope local (no options)', async () => {
    const { client, signOut } = mockClient()
    await expect(signOutDesktop(client)).resolves.toEqual({ error: null })
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('defaults to local for empty options and an explicit local', async () => {
    for (const options of [undefined, {}, { scope: 'local' as const }]) {
      const { client, signOut } = mockClient()
      await signOutDesktop(client, options)
      expect(signOut).toHaveBeenCalledWith({ scope: 'local' })
    }
  })

  it('never passes a bare / argument-less signOut() (the global default)', async () => {
    const { client, signOut } = mockClient()
    await signOutDesktop(client)
    expect(signOut.mock.calls[0]).toHaveLength(1)
    expect(signOut.mock.calls[0][0]).toHaveProperty('scope')
  })
})

describe('4. no global scope unless it is explicitly, exactly requested', () => {
  it('global is honored only for scope === "global"', async () => {
    const { client, signOut } = mockClient()
    await signOutDesktop(client, { scope: 'global' })
    expect(signOut).toHaveBeenCalledWith({ scope: 'global' })
  })

  it.each([
    ['a click event object passed by mistake', { type: 'click', target: {} }],
    ['"others"', { scope: 'others' }],
    ['"GLOBAL" (wrong case)', { scope: 'GLOBAL' }],
    ['"global " (padded)', { scope: 'global ' }],
    ['a truthy non-string', { scope: true }],
    ['null', null],
    ['a string', 'global'],
    ['a number', 1],
  ])('%s → local', async (_name, options) => {
    expect(resolveSignOutScope(options)).toBe('local')
    const { client, signOut } = mockClient()
    await signOutDesktop(client, options as never)
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' })
  })
})

describe('result handling is unchanged', () => {
  it('resolves { error: null } on success and when there is no client', async () => {
    const { client } = mockClient()
    await expect(signOutDesktop(client)).resolves.toEqual({ error: null })
    await expect(signOutDesktop(null)).resolves.toEqual({ error: null })
    await expect(signOutDesktop(undefined)).resolves.toEqual({ error: null })
  })

  it('a Supabase error becomes the same user message and is logged; it never rejects', async () => {
    const { client } = mockClient({ error: { message: 'fetch failed' } })
    await expect(signOutDesktop(client)).resolves.toEqual({ error: SIGN_OUT_FAILED_MESSAGE })
    expect(errorSpy).toHaveBeenCalledWith('[Auth] signOut failed', 'fetch failed')
  })
})

/* ── the real supabase-js client, fake network, in-memory storage ─────────── */
const b64u = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const fakeJwt = (sub: string) =>
  `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub, aud: 'authenticated', role: 'authenticated', session_id: 'fake-session', exp: Math.floor(Date.now() / 1000) + 3600, email: 'qa@example.test' })}.fake-signature`
const FAKE_USER = { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'qa@example.test', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }
const ACCESS = fakeJwt(FAKE_USER.id)

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v) },
    removeItem: (k: string) => { map.delete(k) },
  }
}

type Req = { method: string; url: string; authorization: string | null }

async function signedInClient(opts: { logoutFails?: boolean; logoutStatus?: number } = {}) {
  const requests: Req[] = []
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    requests.push({ method: String(init?.method ?? 'GET'), url, authorization: headers.get('authorization') })
    if (url.includes('/auth/v1/logout')) {
      if (opts.logoutFails) throw new TypeError('network down')
      if (opts.logoutStatus) return new Response(JSON.stringify({ message: 'server error' }), { status: opts.logoutStatus, headers: { 'content-type': 'application/json' } })
      return new Response(null, { status: 204 })
    }
    if (url.includes('/auth/v1/user')) return new Response(JSON.stringify(FAKE_USER), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ error: 'unexpected', error_description: url }), { status: 500, headers: { 'content-type': 'application/json' } })
  }
  const storage = memoryStorage()
  const client = createClient('https://fake-project.supabase.test', 'fake-anon-key', {
    auth: { storage, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fakeFetch as typeof fetch },
  })
  const events: string[] = []
  client.auth.onAuthStateChange((event) => { events.push(event) })
  const set = await client.auth.setSession({ access_token: ACCESS, refresh_token: 'fake-refresh-token' })
  expect(set.error).toBeNull()
  expect((await client.auth.getSession()).data.session?.user.id).toBe(FAKE_USER.id)
  requests.length = 0 // only what sign-out sends matters
  return { client, storage, requests, events }
}
const logoutCalls = (requests: Req[]) => requests.filter((r) => r.url.includes('/auth/v1/logout'))

describe('real supabase-js client, fake network (no real account touched)', () => {
  it('2/3. Sign out sends exactly ONE POST /logout?scope=local for THIS session and clears it locally', async () => {
    const { client, storage, requests, events } = await signedInClient()
    await expect(signOutDesktop(client)).resolves.toEqual({ error: null })

    const calls = logoutCalls(requests)
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(new URL(calls[0].url).searchParams.get('scope')).toBe('local')
    expect(calls[0].authorization).toBe(`Bearer ${ACCESS}`) // it revokes THIS session's token
    expect(requests.some((r) => /scope=(global|others)/.test(r.url))).toBe(false)

    expect((await client.auth.getSession()).data.session).toBeNull() // current session cleared
    expect([...storage.map.keys()].some((k) => k.endsWith('-auth-token'))).toBe(false) // nothing left in storage
    expect(events).toContain('SIGNED_OUT') // what AuthProvider listens to → the app returns to the signed-in-less state
  })

  it('4. the library default really is GLOBAL (why the scope must be explicit)', async () => {
    const { client, requests } = await signedInClient()
    await client.auth.signOut() // what the app used to call
    expect(new URL(logoutCalls(requests)[0].url).searchParams.get('scope')).toBe('global')
  })

  it('global is sent only when explicitly requested (password-reset confirmation)', async () => {
    const { client, requests } = await signedInClient()
    await signOutDesktop(client, { scope: 'global' })
    expect(new URL(logoutCalls(requests)[0].url).searchParams.get('scope')).toBe('global')
    expect((await client.auth.getSession()).data.session).toBeNull()
  })

  it('an expired / unknown session (401/403/404 from the server) still signs out locally', async () => {
    const { client } = await signedInClient()
    // supabase-js ignores 401/403/404 on logout and still clears local state
    ;(client as unknown as { auth: { admin: { signOut: unknown } } }).auth.admin.signOut = async () => ({ data: null, error: Object.assign(new Error('jwt expired'), { __isAuthError: true, name: 'AuthApiError', status: 401 }) })
    await expect(signOutDesktop(client)).resolves.toEqual({ error: null })
    expect((await client.auth.getSession()).data.session).toBeNull()
  })

  it.each([
    ['the network is down', { logoutFails: true as const }],
    ['the server answers 5xx', { logoutStatus: 500 }],
  ])('even when %s, the user is signed out locally and told so (the error message is accurate)', async (_name, opts) => {
    const { client, storage, events } = await signedInClient(opts)
    const result = await signOutDesktop(client)
    expect(result.error).toBe(SIGN_OUT_FAILED_MESSAGE)
    expect((await client.auth.getSession()).data.session).toBeNull() // supabase-js 2.101.1 clears local state anyway
    expect([...storage.map.keys()].some((k) => k.endsWith('-auth-token'))).toBe(false)
    expect(events).toContain('SIGNED_OUT')
  })
})

/* ── structure: which code paths can issue which scope ───────────────────── */
const SRC = new URL('..', import.meta.url).pathname
/** Scan code, not prose: doc comments legitimately mention `scope: 'global'`. */
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
const sources = readdirSync(SRC, { recursive: true, withFileTypes: false })
  .map(String)
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f))
  .map((f) => ({ file: f, text: stripComments(readFileSync(`${SRC}${f}`, 'utf8')) }))
const read = (file: string) => stripComments(readFileSync(`${SRC}${file}`, 'utf8'))

describe('6. no global sign-out from the normal logout UI', () => {
  it('only authSignOut.ts and the Watch module call supabase auth.signOut(…), and neither is a bare call', () => {
    const callers = sources.filter((s) => /\.auth\.signOut\(/.test(s.text)).map((s) => s.file).sort()
    expect(callers).toEqual(['lib/authSignOut.ts', 'youmi-watch/lib/watchAuth.ts'])
    for (const s of sources) expect(s.text, s.file).not.toMatch(/\.auth\.signOut\(\s*\)/) // a bare call is the global default
  })

  it('AuthProvider delegates to the scoped helper and never calls supabase.auth.signOut itself', () => {
    const text = read('AuthProvider.tsx')
    expect(text).toContain('signOutDesktop(supabase, options)')
    expect(text).not.toMatch(/supabase\.auth\.signOut/)
  })

  it('the helper always passes a resolved scope; the Watch module stays local', () => {
    expect(read('lib/authSignOut.ts')).toContain('client.auth.signOut({ scope: resolveSignOutScope(options) })')
    expect(read('youmi-watch/lib/watchAuth.ts')).toContain("signOut({ scope: 'local' })")
  })

  it('every user-facing logout button goes through auth.signOut() with no scope (→ local)', () => {
    const app = read('App.tsx')
    expect(app).toContain('onSignOut={() => auth.signOut()}') // Settings, account sidebar, account modal, account deletion
    expect(app).not.toMatch(/scope:\s*'global'/)
    expect(read('components/AccountSettingsModal.tsx')).not.toMatch(/scope:\s*'(global|others)'/)
  })

  it("'global' appears in exactly one place: the password-reset confirmation (deliberate, documented)", () => {
    const offenders = sources.filter((s) => /scope:\s*'global'/.test(s.text)).map((s) => s.file).sort()
    expect(offenders).toEqual(['components/AuthScreens.tsx'])
    expect(read('components/AuthScreens.tsx')).toContain("await auth.signOut({ scope: 'global' })")
    for (const s of sources) expect(s.text, s.file).not.toMatch(/scope:\s*'others'/)
  })

  it('the auth context contract accepts an optional scope and AuthProvider forwards it', () => {
    expect(read('authContext.ts')).toContain('signOut: (options?: SignOutOptions) => Promise<AuthMethodResult>')
    expect(read('AuthProvider.tsx')).toContain('async (options?: SignOutOptions): Promise<AuthMethodResult>')
  })
})
