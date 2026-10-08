/**
 * B2-B — PKCE browser OAuth: CREDENTIAL ACCEPTANCE isolation.
 *
 * B2-A made sure a callback reaches the right build. These tests prove what happens if it does not: the OAuth callback
 * carries only an authorization CODE, and only the app instance whose own storage holds the matching code verifier can
 * turn it into a session. Routing/scheme checks are covered elsewhere (authIdentity.test.ts); here the callback is handed
 * straight to the credential layer.
 *
 * Everything runs through the app's REAL `getSupabase()` configuration (flowType, persistence, detectSessionInUrl) and the
 * REAL supabase-js client and callback parser. Only two seams are injected: the network (a fake Supabase server that
 * issues codes bound to a challenge and checks the verifier like GoTrue) and the storage (one in-memory "disk" per
 * installed build). Each fresh module import is a separate app PROCESS; reusing a storage models a restart. No real
 * account, code, token or server is touched.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildAuthCallbackUrl, filterAuthCallbackUrls } from './authIdentity'
import { checkPkceAuthorizeUrl, isPlausibleAuthCode } from './authPkce'
import { applySessionFromSupabaseCallbackUrl } from './supabaseDeepLinkAuth'

/* ── seams injected into the REAL getSupabase() ──────────────────────────── */
const seams = vi.hoisted(() => ({
  storage: null as null | { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void },
  fetch: null as null | typeof fetch,
  authOptions: null as null | Record<string, unknown>,
}))

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))
vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const real = await importOriginal<typeof import('@supabase/supabase-js')>()
  return {
    ...real,
    createClient: (url: string, key: string, options: { auth?: Record<string, unknown> } = {}) => {
      seams.authOptions = { ...(options.auth ?? {}) } // what the APP asked for
      return real.createClient(url, key, {
        ...options,
        auth: { ...options.auth, storage: seams.storage as never, autoRefreshToken: false },
        global: { fetch: seams.fetch as typeof fetch },
      })
    },
  }
})

/* ── a fake Supabase server that behaves like GoTrue's PKCE ──────────────── */
const b64u = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')
const fakeJwt = (sub: string) =>
  `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig-${randomUUID()}`
const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

type Flow = { challenge: string; method: string; userId: string; used: boolean }
type Seen = { method: string; path: string; body: unknown }

function fakeSupabase() {
  const flows = new Map<string, Flow>()
  const seen: Seen[] = []
  const issuedSecrets: string[] = [] // access/refresh tokens handed out (leak checks)
  let failTokenWithNetworkError = false
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const sessionFor = (userId: string) => {
    const access = fakeJwt(userId)
    const refresh = `refresh-${randomUUID()}`
    issuedSecrets.push(access, refresh)
    return { access_token: access, refresh_token: refresh, token_type: 'bearer', expires_in: 3600, user: { id: userId, aud: 'authenticated', role: 'authenticated', email: `${userId}@example.test`, app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } }
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const path = `${url.pathname}${url.search}`
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    seen.push({ method: String(init?.method ?? 'GET'), path, body })

    if (url.pathname.endsWith('/token') && url.searchParams.get('grant_type') === 'pkce') {
      if (failTokenWithNetworkError) throw new TypeError('network down')
      const flow = flows.get(body?.auth_code)
      if (!flow || flow.used) return json(400, { error_code: 'flow_state_not_found', msg: 'invalid flow state, no valid flow state found' })
      const challenge = flow.method.toLowerCase() === 's256' ? s256(String(body?.code_verifier ?? '')) : String(body?.code_verifier ?? '')
      if (challenge !== flow.challenge) return json(400, { error_code: 'bad_code_verifier', msg: 'code challenge does not match previously saved code verifier' })
      flow.used = true
      return json(200, sessionFor(flow.userId))
    }
    if (url.pathname.endsWith('/token') && url.searchParams.get('grant_type') === 'password') {
      return body?.password === 'pw-correct' ? json(200, sessionFor('11111111-1111-4111-8111-aaaaaaaaaaaa')) : json(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' })
    }
    if (url.pathname.endsWith('/verify')) {
      return body?.token === '123456' && body?.type === 'recovery' ? json(200, sessionFor('11111111-1111-4111-8111-bbbbbbbbbbbb')) : json(403, { error_code: 'otp_expired', msg: 'Token has expired or is invalid' })
    }
    if (url.pathname.endsWith('/recover')) return json(200, {})
    if (url.pathname.endsWith('/user') && init?.method === 'PUT') return json(200, sessionFor('11111111-1111-4111-8111-bbbbbbbbbbbb').user)
    if (url.pathname.endsWith('/user')) return json(200, sessionFor('11111111-1111-4111-8111-aaaaaaaaaaaa').user)
    if (url.pathname.endsWith('/logout')) return new Response(null, { status: 204 })
    return json(500, { msg: `unexpected ${path}` })
  }) as typeof fetch

  return {
    fetch: fetchImpl,
    seen,
    issuedSecrets,
    tokenCalls: () => seen.filter((s) => s.path.includes('grant_type=pkce')),
    failNextTokenCallsWithNetworkError: (on: boolean) => { failTokenWithNetworkError = on },
    /** The browser leg: the user signs in at the provider; GoTrue binds a fresh code to the challenge from the authorize URL. */
    completeProviderLogin(authorizeUrl: string, userId: string): string {
      const u = new URL(authorizeUrl)
      const code = randomUUID()
      flows.set(code, { challenge: u.searchParams.get('code_challenge') ?? '', method: u.searchParams.get('code_challenge_method') ?? '', userId, used: false })
      return `${u.searchParams.get('redirect_to')}?code=${code}`
    },
  }
}

/* ── "installed builds": each has its own disk, like its own WKWebView localStorage ── */
function diskStorage(initial: Record<string, string> = {}) {
  const disk = new Map<string, string>(Object.entries(initial))
  return {
    disk,
    getItem: (k: string) => disk.get(k) ?? null,
    setItem: (k: string, v: string) => void disk.set(k, v),
    removeItem: (k: string) => void disk.delete(k),
    /** What survives a process exit. */
    persisted: () => Object.fromEntries(disk),
  }
}
type Disk = ReturnType<typeof diskStorage>

const PROD = 'lecturecompanion'
const QA1015 = 'lecturecompanion-qa1015'
const QA1016 = 'lecturecompanion-qa1016'
const USER_A = '22222222-2222-4222-8222-222222222222'
/** Every storage entry that can hold a PKCE verifier (supabase-js ≥ 2.11x also keeps per-flow slots and an index). */
const VERIFIER_KEY = /-code-verifier$/
/** The fixed key a flow-less `exchangeCodeForSession(code)` (what the app calls) reads — and deletes. Values are JSON-encoded. */
const FIXED_VERIFIER_KEY = /-auth-token-code-verifier$/
const fixedVerifierKey = (disk: Disk) => [...disk.disk.keys()].find((k) => FIXED_VERIFIER_KEY.test(k)) ?? null
const verifierOf = (disk: Disk): string | null => {
  const key = fixedVerifierKey(disk)
  return key ? (JSON.parse(disk.disk.get(key) as string) as string) : null
}
/** Every verifier value currently stored under any slot (for leak checks). */
const allVerifierValues = (disk: Disk): string[] =>
  [...disk.disk.entries()].filter(([k]) => VERIFIER_KEY.test(k) && !/-flows-code-verifier$/.test(k)).map(([, v]) => JSON.parse(v) as string)
const hasSessionKey = (disk: Disk) => [...disk.disk.keys()].some((k) => k.endsWith('-auth-token'))

/** One app PROCESS: a fresh module graph, so `getSupabase()` builds a new client over `disk` and the given network. */
async function launchApp(scheme: string, disk: Disk, server: ReturnType<typeof fakeSupabase>) {
  vi.resetModules()
  seams.storage = disk
  seams.fetch = server.fetch
  const { getSupabase } = await import('./supabase')
  const client = getSupabase() as SupabaseClient
  expect(client).toBeTruthy()
  const events: string[] = []
  client.auth.onAuthStateChange((e) => void events.push(e))
  return {
    scheme,
    client,
    disk,
    events,
    /** AuthProvider.startOAuth, minus React: same redirect target, same options. */
    async startOAuth(provider: 'google' | 'apple' = 'google') {
      const { data, error } = await client.auth.signInWithOAuth({ provider, options: { redirectTo: buildAuthCallbackUrl(scheme), skipBrowserRedirect: true } })
      expect(error).toBeNull()
      return data.url as string
    },
    /** What AuthProvider does with a deep link: build-scheme filter, THEN the credential layer. */
    async receiveDeepLink(url: string) {
      const accepted = filterAuthCallbackUrls([url], scheme)
      if (accepted.length === 0) return { accepted: false as const }
      return { accepted: true as const, result: await applySessionFromSupabaseCallbackUrl(client, accepted[0], { source: 'onOpenUrl' }) }
    },
    /** The credential layer alone (a callback that somehow reached this app despite routing). */
    receiveCredentialsDirectly: (url: string) => applySessionFromSupabaseCallbackUrl(client, url, { source: 'onOpenUrl' }),
    sessionUserId: async () => (await client.auth.getSession()).data.session?.user.id ?? null,
  }
}

let logs: unknown[][]
beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://fake-project.supabase.test')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'fake-anon-key')
  vi.stubGlobal('window', {}) // `desktop` = window && isTauri() (isTauri is mocked true)
  logs = []
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules() })

const loggedText = () => JSON.stringify(logs)

/* ───────────────────────────────────────────────────────────────────────── */
describe('1. the app really runs PKCE (its own getSupabase() config)', () => {
  it('requests flowType pkce, keeps persistence, and does not override storage or storage key', async () => {
    await launchApp(QA1015, diskStorage(), fakeSupabase())
    expect(seams.authOptions).toMatchObject({ flowType: 'pkce', persistSession: true, detectSessionInUrl: false })
    expect(seams.authOptions).not.toHaveProperty('storage') // default per-WebView localStorage: not shared across builds
    expect(seams.authOptions).not.toHaveProperty('storageKey') // changing it would sign every existing user out
  })

  it('the authorize URL is an S256 PKCE URL and the guard accepts it', async () => {
    const app = await launchApp(QA1015, diskStorage(), fakeSupabase())
    const url = await app.startOAuth()
    expect(new URL(url).searchParams.get('code_challenge_method')?.toLowerCase()).toBe('s256')
    expect(new URL(url).searchParams.get('redirect_to')).toBe('lecturecompanion-qa1015://auth-callback')
    expect(checkPkceAuthorizeUrl(url)).toEqual({ ok: true })
  })

  it('the PKCE verifier is written to THIS build\'s storage when sign-in starts, and the challenge is S256(verifier)', async () => {
    const disk = diskStorage()
    const app = await launchApp(QA1015, disk, fakeSupabase())
    const url = await app.startOAuth()
    const verifier = verifierOf(disk)
    expect(verifier).toBeTruthy()
    expect(new URL(url).searchParams.get('code_challenge')).toBe(s256(verifier as string))
    expect(url).not.toContain(verifier as string) // the verifier itself never appears in the browser URL
  })

  it('the guard REFUSES a downgraded `plain` flow (WebCrypto missing → supabase-js silently falls back to plain)', async () => {
    const disk = diskStorage()
    const app = await launchApp(QA1015, disk, fakeSupabase())
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) }) // no `subtle`
    const url = await app.startOAuth()
    expect(new URL(url).searchParams.get('code_challenge_method')?.toLowerCase()).toBe('plain')
    expect(checkPkceAuthorizeUrl(url)).toEqual({ ok: false, reason: 'challenge_method_not_s256' })
  })
})

describe('2. the OAuth callback carries a CODE, never bearer tokens', () => {
  it('provider login → callback URL has `code` and no access_token / refresh_token anywhere', async () => {
    const server = fakeSupabase()
    const app = await launchApp(QA1015, diskStorage(), server)
    const callback = server.completeProviderLogin(await app.startOAuth(), USER_A)
    const u = new URL(callback)
    expect(u.searchParams.get('code')).toBeTruthy()
    expect(callback).not.toMatch(/access_token|refresh_token|token_type|expires_in|#/)
    expect(`${u.protocol}//${u.host}`).toBe('lecturecompanion-qa1015://auth-callback')
  })
})

describe('3. already-running app', () => {
  it('callback → build check → code exchange with the stored verifier → the right session, verifier consumed', async () => {
    const server = fakeSupabase()
    const disk = diskStorage()
    const app = await launchApp(QA1015, disk, server)
    const callback = server.completeProviderLogin(await app.startOAuth(), USER_A)

    const out = await app.receiveDeepLink(callback)
    expect(out).toMatchObject({ accepted: true, result: { branch: 'exchange_code', error: null } })
    expect(await app.sessionUserId()).toBe(USER_A)
    expect(app.events).toContain('SIGNED_IN')
    expect(verifierOf(disk)).toBeNull() // one-shot
    expect(hasSessionKey(disk)).toBe(true)
    expect(server.tokenCalls()).toHaveLength(1)
    // the exchange request is what proves possession of the verifier
    expect(server.tokenCalls()[0].body).toMatchObject({ auth_code: expect.any(String), code_verifier: expect.any(String) })
  })
})

describe('3b. what is left in storage after a successful exchange', () => {
  it('the fixed verifier key is consumed; any per-flow slot left by newer supabase-js can no longer redeem anything', async () => {
    const server = fakeSupabase()
    const disk = diskStorage()
    const app = await launchApp(QA1015, disk, server)
    const callback = server.completeProviderLogin(await app.startOAuth(), USER_A)
    await app.receiveDeepLink(callback)
    expect(fixedVerifierKey(disk)).toBeNull()
    // A stale per-flow slot (if this supabase-js writes them) is useless: the flow-less exchange the app performs never
    // reads it, and the code it belonged to is single-use. Pin that, so a future library change cannot quietly alter it.
    const tokenCallsBefore = server.tokenCalls().length
    const replay = await app.receiveCredentialsDirectly(callback)
    expect(replay.session).toBeNull()
    expect(server.tokenCalls().length).toBe(tokenCallsBefore)
  })
})

describe('4. cold start (callback launches the app)', () => {
  it('verifier persisted → process exits → app starts FROM the callback → verifier found → exchange succeeds → right session', async () => {
    const server = fakeSupabase()
    const disk = diskStorage()
    const first = await launchApp(QA1015, disk, server)
    const callback = server.completeProviderLogin(await first.startOAuth(), USER_A)

    // process exit: nothing in memory survives, only what was persisted
    const survived = diskStorage(disk.persisted())
    expect([...survived.disk.keys()].some((k) => VERIFIER_KEY.test(k))).toBe(true)
    expect(hasSessionKey(survived)).toBe(false) // not signed in yet

    const second = await launchApp(QA1015, survived, server) // a brand-new process (fresh module graph + client)
    const out = await second.receiveDeepLink(callback) // the Tauri getCurrent() path hands the URL to the same pipeline
    expect(out).toMatchObject({ accepted: true, result: { branch: 'exchange_code', error: null } })
    expect(await second.sessionUserId()).toBe(USER_A)
    expect(verifierOf(survived)).toBeNull()

    // …and the new session itself survives the next restart
    const third = await launchApp(QA1015, diskStorage(survived.persisted()), server)
    expect(await third.sessionUserId()).toBe(USER_A)
  })

  it('a cold start whose verifier was lost fails SAFELY: no network call, no session, a retry works', async () => {
    const server = fakeSupabase()
    const first = await launchApp(QA1015, diskStorage(), server)
    const callback = server.completeProviderLogin(await first.startOAuth(), USER_A)

    const wiped = await launchApp(QA1015, diskStorage(), server) // storage did not persist
    const out = await wiped.receiveDeepLink(callback)
    expect(out).toMatchObject({ accepted: true, result: { branch: 'exchange_code', session: null } })
    expect((out as { result: { error: string } }).result.error).toMatch(/verifier/i)
    expect(server.tokenCalls()).toHaveLength(0)
    expect(await wiped.sessionUserId()).toBeNull()

    const retryCallback = server.completeProviderLogin(await wiped.startOAuth(), USER_A) // user clicks Continue with Google again
    expect(await wiped.receiveDeepLink(retryCallback)).toMatchObject({ result: { error: null } })
    expect(await wiped.sessionUserId()).toBe(USER_A)
  })
})

describe('5. WRONG-BUILD credential acceptance', () => {
  it('a code issued to QA1015 is NOT accepted by QA1016: it has no matching verifier, and it never even asks the server', async () => {
    const server = fakeSupabase()
    const qa15 = await launchApp(QA1015, diskStorage(), server)
    const callback15 = server.completeProviderLogin(await qa15.startOAuth(), USER_A)

    const qa16Disk = diskStorage()
    const qa16 = await launchApp(QA1016, qa16Disk, server)
    // Route-independent: hand the credential layer the callback directly, as if routing had failed.
    const stolen = await qa16.receiveCredentialsDirectly(callback15)
    expect(stolen.branch).toBe('exchange_code')
    expect(stolen.session).toBeNull()
    expect(stolen.error).toMatch(/verifier/i)
    expect(server.tokenCalls()).toHaveLength(0)
    expect(await qa16.sessionUserId()).toBeNull()
    expect(hasSessionKey(qa16Disk)).toBe(false)

    // …and the rightful owner is unaffected.
    expect(await qa15.receiveDeepLink(callback15)).toMatchObject({ result: { error: null } })
    expect(await qa15.sessionUserId()).toBe(USER_A)
  })

  it('even a build that has its OWN sign-in in flight cannot redeem another build\'s code (verifier mismatch at the server)', async () => {
    const server = fakeSupabase()
    const qa15 = await launchApp(QA1015, diskStorage(), server)
    const callback15 = server.completeProviderLogin(await qa15.startOAuth(), USER_A)

    const qa16Disk = diskStorage()
    const qa16 = await launchApp(QA1016, qa16Disk, server)
    await qa16.startOAuth() // QA1016 has verifier B stored
    const stolen = await qa16.receiveCredentialsDirectly(callback15)
    expect(stolen.session).toBeNull()
    expect(stolen.error).toBeTruthy()
    expect(server.tokenCalls()).toHaveLength(1) // the server was asked, and refused
    expect(await qa16.sessionUserId()).toBeNull()
    expect(hasSessionKey(qa16Disk)).toBe(false)
  })

  it('Production\'s verifier is not a QA build\'s verifier (and vice versa)', async () => {
    const server = fakeSupabase()
    const prod = await launchApp(PROD, diskStorage(), server)
    const qa = await launchApp(QA1015, diskStorage(), server)
    const prodCallback = server.completeProviderLogin(await prod.startOAuth(), USER_A)
    const qaCallback = server.completeProviderLogin(await qa.startOAuth(), USER_A)
    expect(verifierOf(prod.disk)).not.toBe(verifierOf(qa.disk))
    expect((await qa.receiveCredentialsDirectly(prodCallback)).session).toBeNull()
    expect((await prod.receiveCredentialsDirectly(qaCallback)).session).toBeNull()
    expect(await prod.sessionUserId()).toBeNull()
    expect(await qa.sessionUserId()).toBeNull()
  })

  it('a wrong-scheme callback is dropped before any credential code runs (B2-A routing guard still in front)', async () => {
    const server = fakeSupabase()
    const qa16 = await launchApp(QA1016, diskStorage(), server)
    const qa15 = await launchApp(QA1015, diskStorage(), server)
    const callback15 = server.completeProviderLogin(await qa15.startOAuth(), USER_A)
    expect(await qa16.receiveDeepLink(callback15)).toEqual({ accepted: false })
    expect(server.tokenCalls()).toHaveLength(0)
  })
})

describe('6. replay, wrong verifier, missing verifier, malformed callbacks', () => {
  it('exchanged once → success; the SAME callback replayed → fails, no second session', async () => {
    const server = fakeSupabase()
    const app = await launchApp(QA1015, diskStorage(), server)
    const callback = server.completeProviderLogin(await app.startOAuth(), USER_A)
    expect(await app.receiveDeepLink(callback)).toMatchObject({ result: { error: null } })
    const events = app.events.filter((e) => e === 'SIGNED_IN').length

    const replay = await app.receiveDeepLink(callback)
    expect(replay).toMatchObject({ result: { branch: 'exchange_code', session: null } })
    expect((replay as { result: { error: string } }).result.error).toBeTruthy()
    expect(server.tokenCalls()).toHaveLength(1) // refused locally (verifier already consumed), never re-sent
    expect(app.events.filter((e) => e === 'SIGNED_IN').length).toBe(events)
  })

  it('the SERVER also refuses a replayed code even if a fresh verifier is present', async () => {
    const server = fakeSupabase()
    const app = await launchApp(QA1015, diskStorage(), server)
    const callback = server.completeProviderLogin(await app.startOAuth(), USER_A)
    await app.receiveDeepLink(callback)
    await app.startOAuth() // a new verifier now exists
    const replay = await app.receiveCredentialsDirectly(callback)
    expect(replay.session).toBeNull()
    expect(replay.error).toBeTruthy()
    expect(server.tokenCalls()).toHaveLength(2) // asked, and refused
  })

  it('a verifier that does not match the code is refused (no session)', async () => {
    const server = fakeSupabase()
    const disk = diskStorage()
    const app = await launchApp(QA1015, disk, server)
    const callback = server.completeProviderLogin(await app.startOAuth(), USER_A)
    disk.disk.set(fixedVerifierKey(disk) as string, JSON.stringify('a'.repeat(56))) // corrupted / substituted verifier
    const out = await app.receiveCredentialsDirectly(callback)
    expect(out.session).toBeNull()
    expect(out.error).toBeTruthy()
    expect(await app.sessionUserId()).toBeNull()
  })

  it.each([
    ['empty code', 'lecturecompanion-qa1015://auth-callback?code='],
    ['whitespace', 'lecturecompanion-qa1015://auth-callback?code=%20%20'],
    ['embedded space', 'lecturecompanion-qa1015://auth-callback?code=abc%20def'],
    ['path traversal', 'lecturecompanion-qa1015://auth-callback?code=..%2F..%2Fetc'],
    ['markup', 'lecturecompanion-qa1015://auth-callback?code=%3Cscript%3Ex'],
    ['quote injection', "lecturecompanion-qa1015://auth-callback?code=a'b"],
    ['oversized', `lecturecompanion-qa1015://auth-callback?code=${'a'.repeat(513)}`],
  ])('malformed code (%s) fails safely — rejected locally, nothing sent anywhere', async (_name, url) => {
    const server = fakeSupabase()
    const app = await launchApp(QA1015, diskStorage(), server)
    await app.startOAuth()
    const out = await app.receiveDeepLink(url)
    expect(out).toMatchObject({ accepted: true, result: { branch: 'invalid_code', session: null } })
    expect(server.tokenCalls()).toHaveLength(0)
    expect(server.seen.filter((s) => s.path.includes('/token'))).toHaveLength(0)
    expect(await app.sessionUserId()).toBeNull()
    expect(isPlausibleAuthCode(new URL(url).searchParams.get('code'))).toBe(false)
  })

  it.each([
    'lecturecompanion-qa1016://auth-callback?code=abc123',
    'lecturecompanion://auth-callback?code=abc123',
    'lecturecompanion-qa1015://other-path?code=abc123',
    'lecturecompanion-qa1015://auth-callback.evil?code=abc123',
    'lecturecompanion-qa1015://auth-callback@evil?code=abc123',
    'https://example.com/auth-callback?code=abc123',
  ])('wrong scheme / host / path is rejected BEFORE any exchange: %s', async (url) => {
    const server = fakeSupabase()
    const app = await launchApp(QA1015, diskStorage(), server)
    await app.startOAuth()
    expect(await app.receiveDeepLink(url)).toEqual({ accepted: false })
    expect(server.tokenCalls()).toHaveLength(0)
  })

  it('a legacy IMPLICIT callback (bearer tokens) is rejected: setSession is never reached, nothing is sent, no session', async () => {
    const server = fakeSupabase()
    const disk = diskStorage()
    const app = await launchApp(QA1015, disk, server)
    const out = await app.receiveDeepLink('lecturecompanion-qa1015://auth-callback#access_token=AT&refresh_token=RT&token_type=bearer&expires_in=3600')
    expect(out).toMatchObject({ accepted: true, result: { branch: 'implicit_rejected', session: null } })
    expect(server.seen).toHaveLength(0)
    expect(await app.sessionUserId()).toBeNull()
    expect(hasSessionKey(disk)).toBe(false)
    expect(app.events).not.toContain('SIGNED_IN')
  })

  it('a URL with a code AND bearer tokens is exchanged on the code alone; the tokens are never consumed', async () => {
    const server = fakeSupabase()
    const app = await launchApp(QA1015, diskStorage(), server)
    const callback = server.completeProviderLogin(await app.startOAuth(), USER_A)
    const out = await app.receiveDeepLink(`${callback}#access_token=EVIL&refresh_token=EVIL2`)
    expect(out).toMatchObject({ result: { branch: 'exchange_code', error: null } })
    expect(await app.sessionUserId()).toBe(USER_A) // the code's user, not whatever the tokens claimed
    expect(JSON.stringify(server.seen)).not.toMatch(/EVIL/)
  })

  it('a network failure during the exchange fails safely and recoverably (the verifier is one-shot, so the user starts sign-in again)', async () => {
    const server = fakeSupabase()
    const disk = diskStorage()
    const app = await launchApp(QA1015, disk, server)
    const callback = server.completeProviderLogin(await app.startOAuth(), USER_A)

    server.failNextTokenCallsWithNetworkError(true)
    const failed = await app.receiveDeepLink(callback)
    expect(failed).toMatchObject({ result: { branch: 'exchange_code', session: null } })
    expect((failed as { result: { error: string } }).result.error).toBeTruthy()
    expect(await app.sessionUserId()).toBeNull()
    expect(verifierOf(disk)).toBeNull() // documented supabase-js 2.101.1 behavior: consumed even on failure

    server.failNextTokenCallsWithNetworkError(false)
    const retry = server.completeProviderLogin(await app.startOAuth(), USER_A) // a fresh flow works
    expect(await app.receiveDeepLink(retry)).toMatchObject({ result: { error: null } })
    expect(await app.sessionUserId()).toBe(USER_A)
  })
})

describe('7. nothing sensitive reaches the logs', () => {
  it('across a full sign-in, a replay, a stolen-code attempt and a failure: no code, verifier, access or refresh token is ever logged', async () => {
    const server = fakeSupabase()
    const disk = diskStorage()
    const qa15 = await launchApp(QA1015, disk, server)
    const url = await qa15.startOAuth()
    const verifiers = allVerifierValues(disk)
    expect(verifiers.length).toBeGreaterThan(0)
    const callback = server.completeProviderLogin(url, USER_A)
    const code = new URL(callback).searchParams.get('code') as string
    const qa16 = await launchApp(QA1016, diskStorage(), server)

    await qa16.receiveCredentialsDirectly(callback) // stolen
    await qa15.receiveDeepLink(callback) // legit
    await qa15.receiveDeepLink(callback) // replay
    await qa15.receiveDeepLink('lecturecompanion-qa1015://auth-callback#access_token=AT-SECRET&refresh_token=RT-SECRET')

    const text = loggedText()
    expect(logs.length).toBeGreaterThan(0)
    for (const secret of [code, ...verifiers, 'AT-SECRET', 'RT-SECRET', ...server.issuedSecrets]) expect(text, 'logged a secret').not.toContain(secret)
  })
})

/* ── non-OAuth flows keep working under the PKCE client ──────────────────── */
describe('8. non-OAuth auth is unchanged', () => {
  it('email + password sign-in works and the session restores after a restart', async () => {
    const server = fakeSupabase()
    const disk = diskStorage()
    const app = await launchApp(QA1015, disk, server)
    const ok = await app.client.auth.signInWithPassword({ email: 'qa@example.test', password: 'pw-correct' })
    expect(ok.error).toBeNull()
    expect(ok.data.session?.user.id).toBeTruthy()
    const bad = await app.client.auth.signInWithPassword({ email: 'qa@example.test', password: 'wrong' })
    expect(bad.error).toBeTruthy()

    const restarted = await launchApp(QA1015, diskStorage(disk.persisted()), server)
    expect(await restarted.sessionUserId()).toBe(ok.data.session?.user.id)
  })

  it('typed email OTP (password-reset code): verifyOtp(email+token) works with no verifier involved', async () => {
    const server = fakeSupabase()
    const app = await launchApp(QA1015, diskStorage(), server)
    const { error } = await app.client.auth.verifyOtp({ email: 'qa@example.test', token: '123456', type: 'recovery' })
    expect(error).toBeNull()
    expect(await app.sessionUserId()).toBeTruthy()
    const wrong = await app.client.auth.verifyOtp({ email: 'qa@example.test', token: '000000', type: 'recovery' })
    expect(wrong.error).toBeTruthy()
  })

  it('password reset end to end: request code → typed code → update password → explicit GLOBAL sign-out', async () => {
    const server = fakeSupabase()
    const app = await launchApp(QA1015, diskStorage(), server)
    expect((await app.client.auth.resetPasswordForEmail('qa@example.test')).error).toBeNull() // no redirectTo, like the app
    expect((await app.client.auth.verifyOtp({ email: 'qa@example.test', token: '123456', type: 'recovery' })).error).toBeNull()
    expect((await app.client.auth.updateUser({ password: 'a-new-password-1' })).error).toBeNull()

    const { signOutDesktop } = await import('./authSignOut')
    await signOutDesktop(app.client, { scope: 'global' }) // what AuthScreens does after the reset
    expect(server.seen.some((s) => s.path.includes('/logout') && s.path.includes('scope=global'))).toBe(true)
    expect(await app.sessionUserId()).toBeNull()
  })

  it('local sign-out (B2-A.1) still sends scope=local and clears the session under the PKCE client', async () => {
    const server = fakeSupabase()
    const app = await launchApp(QA1015, diskStorage(), server)
    await app.client.auth.signInWithPassword({ email: 'qa@example.test', password: 'pw-correct' })
    const { signOutDesktop } = await import('./authSignOut')
    await signOutDesktop(app.client)
    const logout = server.seen.filter((s) => s.path.includes('/logout'))
    expect(logout).toHaveLength(1)
    expect(logout[0].path).toContain('scope=local')
    expect(await app.sessionUserId()).toBeNull()
  })

  it('KNOWN LIMITATION (documented): the PKCE verifier is a single slot, so a password-reset request made while an OAuth round-trip is in flight invalidates that round-trip — the user simply signs in again', async () => {
    const server = fakeSupabase()
    const disk = diskStorage()
    const app = await launchApp(QA1015, disk, server)
    const callback = server.completeProviderLogin(await app.startOAuth(), USER_A)
    await app.client.auth.resetPasswordForEmail('qa@example.test') // overwrites the stored verifier
    const out = await app.receiveDeepLink(callback)
    expect(out).toMatchObject({ result: { session: null } })
    expect(await app.sessionUserId()).toBeNull() // safe failure, not a wrong session
    const retry = server.completeProviderLogin(await app.startOAuth(), USER_A)
    expect(await app.receiveDeepLink(retry)).toMatchObject({ result: { error: null } })
  })
})

/* ── structure: the wiring the pure tests cannot see ─────────────────────── */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

describe('9. wiring', () => {
  it('AuthProvider starts OAuth with skipBrowserRedirect on desktop and refuses a non-S256 authorize URL before opening the browser', () => {
    const ap = code(read('../AuthProvider.tsx'))
    expect(ap).toContain('skipBrowserRedirect: desktop')
    const start = ap.indexOf('await supabase.auth.signInWithOAuth(')
    const guard = ap.indexOf('checkPkceAuthorizeUrl(data.url)')
    const open = ap.indexOf('await open(data.url)')
    expect(start).toBeGreaterThan(0)
    expect(guard).toBeGreaterThan(start)
    expect(open).toBeGreaterThan(guard) // guard first, browser second
    // nothing between starting the flow and the guard may open a browser (under any name) or touch the shell plugin
    expect(ap.slice(start, guard)).not.toMatch(/plugin-shell|\bopen\w*\(/)
    // exactly one place opens the authorize URL
    expect((ap.match(/plugin-shell/g) ?? []).length).toBe(1)
  })

  it('the guard failure path neither opens the browser nor logs / returns the authorize URL', () => {
    const ap = code(read('../AuthProvider.tsx'))
    const guardStart = ap.indexOf('const pkce = checkPkceAuthorizeUrl(data.url)')
    const failureBlock = ap.slice(guardStart + 'const pkce = checkPkceAuthorizeUrl(data.url)'.length, ap.indexOf('await open(data.url)'))
    expect(failureBlock).toContain('return { error:')
    expect(failureBlock).not.toMatch(/data\.url/) // the URL carries the challenge; it must not appear in logs, traces or the UI message
    expect(failureBlock).not.toMatch(/redirectTo/)
  })

  it('both the cold-start (getCurrent) and warm (onOpenUrl) paths filter by build scheme BEFORE the credential layer, and cold-start failures now reach the user', () => {
    const ap = code(read('../AuthProvider.tsx'))
    expect((ap.match(/acceptBuildCallbackUrls\(/g) ?? []).length).toBeGreaterThanOrEqual(3) // definition + 2 call sites
    expect(ap).toMatch(/getCurrent\(\)[\s\S]*acceptBuildCallbackUrls\(start\)[\s\S]*applySessionFromSupabaseCallbackUrl/)
    expect(ap).toMatch(/onOpenUrl\([\s\S]*acceptBuildCallbackUrls\(payload\)[\s\S]*applySessionFromSupabaseCallbackUrl/)
    expect((ap.match(/setDeepLinkAuthError\(deepLinkFailureMessage\(\)\)/g) ?? []).length).toBe(2)
  })

  it('nothing outside the callback parser can turn URL bearer tokens into a session', () => {
    const offenders: string[] = []
    const walk = (rel: string) => {
      for (const f of readdirSync(new URL(rel, import.meta.url), { withFileTypes: true })) {
        const next = `${rel}${f.name}`
        if (f.isDirectory()) walk(`${next}/`)
        else if (/\.(ts|tsx)$/.test(f.name) && !/\.test\./.test(f.name) && /\.setSession\(/.test(code(read(next)))) offenders.push(next)
      }
    }
    walk('../')
    expect(offenders).toEqual([]) // no production code path calls setSession at all
  })
})

/* ── B2-B.1: no callback can establish a session without the PKCE verifier ──────────────────────────────────────── */
describe('10. forged / legacy callbacks cannot establish a session', () => {
  /** REAL, currently valid bearer material for some account (a password sign-in on another install). */
  async function realTokens(server: ReturnType<typeof fakeSupabase>) {
    const other = await launchApp(PROD, diskStorage(), server)
    const { data } = await other.client.auth.signInWithPassword({ email: 'victim@example.test', password: 'pw-correct' })
    return { access: data.session?.access_token as string, refresh: data.session?.refresh_token as string }
  }
  const noEffect = async (app: Awaited<ReturnType<typeof launchApp>>, server: ReturnType<typeof fakeSupabase>, before: number) => {
    expect(server.seen.length).toBe(before) // not one request left the app
    expect(await app.sessionUserId()).toBeNull()
    expect(app.events).not.toContain('SIGNED_IN')
    expect(app.events).not.toContain('PASSWORD_RECOVERY')
    expect(hasSessionKey(app.disk)).toBe(false)
  }

  it('1. a callback carrying REAL access + refresh tokens (hash or query) does not sign the app in', async () => {
    const server = fakeSupabase()
    const { access, refresh } = await realTokens(server)
    expect(access && refresh).toBeTruthy()
    for (const url of [
      `lecturecompanion-qa1015://auth-callback#access_token=${access}&refresh_token=${refresh}&token_type=bearer&expires_in=3600`,
      `lecturecompanion-qa1015://auth-callback?access_token=${access}&refresh_token=${refresh}`,
      `lecturecompanion-qa1015://auth-callback#access_token=${access}`,
      `lecturecompanion-qa1015://auth-callback?refresh_token=${refresh}`,
      `lecturecompanion-qa1015://auth-callback?type=bearer#access_token=${access}&refresh_token=${refresh}`,
    ]) {
      const app = await launchApp(QA1015, diskStorage(), server)
      const before = server.seen.length
      const out = await app.receiveDeepLink(url)
      expect(out).toMatchObject({ accepted: true, result: { branch: 'implicit_rejected', session: null } })
      await noEffect(app, server, before)
    }
  })

  it('also when the app has its own sign-in in flight (a verifier is present, so only the shape can protect it)', async () => {
    const server = fakeSupabase()
    const { access, refresh } = await realTokens(server)
    const app = await launchApp(QA1015, diskStorage(), server)
    await app.startOAuth()
    const before = server.seen.length
    await app.receiveDeepLink(`lecturecompanion-qa1015://auth-callback#access_token=${access}&refresh_token=${refresh}`)
    expect(server.seen.length).toBe(before)
    expect(await app.sessionUserId()).toBeNull()
  })

  it.each(['signup', 'invite', 'magiclink', 'recovery', 'email_change', 'email'])(
    '2. a `token_hash` callback (type=%s) establishes nothing: verifyOtp is never reached, no /verify request, no recovery state',
    async (type) => {
      const server = fakeSupabase()
      const app = await launchApp(QA1015, diskStorage(), server)
      const before = server.seen.length
      const out = await app.receiveDeepLink(`lecturecompanion-qa1015://auth-callback?token_hash=${randomUUID()}&type=${type}`)
      expect(out).toMatchObject({ accepted: true, result: { branch: 'otp_callback_rejected', session: null } })
      await noEffect(app, server, before)
      expect(server.seen.some((s) => s.path.includes('/verify'))).toBe(false)
    },
  )

  it('3. `email` + `token` (+ type) cannot silently bypass PKCE — even the token the fake server WOULD accept (123456)', async () => {
    const server = fakeSupabase()
    const app = await launchApp(QA1015, diskStorage(), server)
    const before = server.seen.length
    const out = await app.receiveDeepLink('lecturecompanion-qa1015://auth-callback?email=victim%40example.test&token=123456&type=recovery')
    expect(out).toMatchObject({ accepted: true, result: { branch: 'otp_callback_rejected', session: null } })
    await noEffect(app, server, before)
    // …while the SAME token typed into the app (the supported recovery path) works:
    const typed = await app.client.auth.verifyOtp({ email: 'victim@example.test', token: '123456', type: 'recovery' })
    expect(typed.error).toBeNull()
  })

  it('a valid PKCE code plus a forged OTP / bearer credential is exchanged on the code ALONE', async () => {
    const server = fakeSupabase()
    const app = await launchApp(QA1015, diskStorage(), server)
    const callback = server.completeProviderLogin(await app.startOAuth(), USER_A)
    const out = await app.receiveDeepLink(`${callback}&token_hash=FORGED&email=victim%40example.test&token=123456&type=recovery#access_token=EVIL&refresh_token=EVIL2`)
    expect(out).toMatchObject({ accepted: true, result: { branch: 'exchange_code', error: null } })
    expect(await app.sessionUserId()).toBe(USER_A)
    expect(server.seen.some((s) => s.path.includes('/verify'))).toBe(false)
    expect(JSON.stringify(server.seen)).not.toMatch(/FORGED|EVIL/)
  })

  it('4. an OAuth code with NO verifier on this install fails safely (the lost-verifier / other-install case)', async () => {
    const server = fakeSupabase()
    const issuer = await launchApp(QA1015, diskStorage(), server)
    const callback = server.completeProviderLogin(await issuer.startOAuth(), USER_A)
    const stranger = await launchApp(QA1015, diskStorage(), server) // same scheme, different install: no verifier
    const before = server.seen.length
    const out = await stranger.receiveDeepLink(callback)
    expect(out).toMatchObject({ accepted: true, result: { branch: 'exchange_code', session: null } })
    expect((out as { result: { error: string } }).result.error).toMatch(/verifier/i)
    expect(server.seen.length).toBe(before)
    expect(await stranger.sessionUserId()).toBeNull()
  })

  it('5/6. the wrong build is refused and the right build still signs in with a normal PKCE exchange', async () => {
    const server = fakeSupabase()
    const qa15 = await launchApp(QA1015, diskStorage(), server)
    const qa16 = await launchApp(QA1016, diskStorage(), server)
    const callback = server.completeProviderLogin(await qa15.startOAuth(), USER_A)
    expect((await qa16.receiveCredentialsDirectly(callback)).session).toBeNull()
    expect(await qa16.sessionUserId()).toBeNull()
    expect(await qa15.receiveDeepLink(callback)).toMatchObject({ result: { branch: 'exchange_code', error: null } })
    expect(await qa15.sessionUserId()).toBe(USER_A)
  })

  it('7. password recovery still works end to end through the TYPED code, and a recovery DEEP LINK cannot trigger it', async () => {
    const server = fakeSupabase()
    const app = await launchApp(QA1015, diskStorage(), server)

    // forged recovery deep link → nothing (no session, no PASSWORD_RECOVERY)
    const before = server.seen.length
    await app.receiveDeepLink('lecturecompanion-qa1015://auth-callback?token_hash=X&type=recovery')
    await app.receiveDeepLink('lecturecompanion-qa1015://auth-callback?email=victim%40example.test&token=123456&type=recovery')
    expect(server.seen.length).toBe(before)
    expect(app.events).not.toContain('PASSWORD_RECOVERY')

    // the real path: request code (no redirect) → typed code → PASSWORD_RECOVERY → update password
    expect((await app.client.auth.resetPasswordForEmail('victim@example.test')).error).toBeNull()
    expect((await app.client.auth.verifyOtp({ email: 'victim@example.test', token: '123456', type: 'recovery' })).error).toBeNull()
    expect(app.events).toContain('PASSWORD_RECOVERY')
    expect((await app.client.auth.updateUser({ password: 'a-new-password-1' })).error).toBeNull()
  })

  it('8. typed email OTP rejects a wrong code and accepts the right one, independent of any callback', async () => {
    const server = fakeSupabase()
    const app = await launchApp(QA1015, diskStorage(), server)
    expect((await app.client.auth.verifyOtp({ email: 'victim@example.test', token: '000000', type: 'recovery' })).error).toBeTruthy()
    expect(await app.sessionUserId()).toBeNull()
    expect((await app.client.auth.verifyOtp({ email: 'victim@example.test', token: '123456', type: 'recovery' })).error).toBeNull()
    expect(await app.sessionUserId()).toBeTruthy()
  })
})

describe('11. which code is allowed to create a session (structure)', () => {
  const walk = (rel: string, out: { file: string; text: string }[] = []) => {
    for (const f of readdirSync(new URL(rel, import.meta.url), { withFileTypes: true })) {
      const next = `${rel}${f.name}`
      if (f.isDirectory()) walk(`${next}/`, out)
      else if (/\.(ts|tsx)$/.test(f.name) && !/\.test\./.test(f.name)) out.push({ file: next.replace('../', ''), text: code(read(next)) })
    }
    return out
  }
  const files = walk('../')
  const using = (re: RegExp) => files.filter((f) => re.test(f.text)).map((f) => f.file).sort()

  it('verifyOtp exists ONLY in the typed password-reset code path — never in the deep-link parser', () => {
    expect(using(/\.verifyOtp\(/)).toEqual(['AuthProvider.tsx'])
    expect(read('../AuthProvider.tsx').match(/\.verifyOtp\(/g)).toHaveLength(1)
    expect(code(read('./supabaseDeepLinkAuth.ts'))).not.toMatch(/verifyOtp|setSession|signInWith|refreshSession/)
  })

  it('exchangeCodeForSession is called ONLY by the deep-link parser; setSession by nobody', () => {
    expect(using(/\.exchangeCodeForSession\(/)).toEqual(['lib/supabaseDeepLinkAuth.ts'])
    expect(using(/\.setSession\(/)).toEqual([])
  })

  it('the parser can only ever produce a session through the exchange branch', () => {
    const parser = code(read('./supabaseDeepLinkAuth.ts'))
    expect((parser.match(/supabase\.auth\.\w+\(/g) ?? []).sort()).toEqual(['supabase.auth.exchangeCodeForSession('])
  })
})
