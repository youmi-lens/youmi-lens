import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCheckout } from './stripeRoutes.mjs'
import {
  SCOPED_TEST_CHECKOUT_MAX_USERS,
  isScopedTestCheckoutUser,
  isStripeTestModeKey,
  parseScopedTestCheckoutUserIds,
} from './stripeConfig.mjs'

/* Scoped Stripe TEST checkout allowlist.
 *
 * PUBLIC_COMMERCIALIZATION_ENABLED stays false. Exactly the allowlisted, SERVER-AUTHENTICATED user may pass the
 * top-level `commercialization_not_available` gate, and only on a Stripe TEST key. Every later guard (plan, price,
 * Stripe-subscription, cross-provider entitlement) must still run. These tests drive the real handleCheckout and the real
 * entitlement lookup (in-memory database); no Stripe object is ever created by a blocked case. */

const NOW = Date.parse('2026-10-06T12:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()
const DAY = 86_400_000
const TEST_USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const THIRD = '33333333-3333-4333-8333-333333333333'

function fakeDb(tables) {
  return {
    from(name) {
      let rows = [...(tables[name] ?? [])]
      const q = {
        select() { return q },
        eq(col, val) { rows = rows.filter((r) => r[col] === val); return q },
        lte(col, val) { rows = rows.filter((r) => r[col] <= val); return q },
        gt(col, val) { rows = rows.filter((r) => r[col] > val); return q },
        is(col, val) { rows = rows.filter((r) => (r[col] ?? null) === val); return q },
        order(col, { ascending = true } = {}) { rows.sort((a, b) => (a[col] < b[col] ? -1 : 1) * (ascending ? 1 : -1)); return q },
        limit(n) { rows = rows.slice(0, n); return q },
        maybeSingle() { return Promise.resolve({ data: rows[0] ?? null, error: null }) },
        then(resolve, reject) { return Promise.resolve({ data: rows, error: null }).then(resolve, reject) },
      }
      return q
    },
  }
}

const appleState = (over = {}) => ({
  user_id: TEST_USER, product_id: 'com.aydenz.youmilensipad.student.monthly', original_transaction_id: 'orig-1',
  latest_transaction_id: 'tx-1', subscription_group_id: '22109238', environment: 'Production', app_account_token: TEST_USER,
  purchased_at: iso(NOW - 5 * DAY), expires_at: iso(NOW + 25 * DAY), auto_renew_status: true, status: 'active',
  revocation_at: null, last_verified_at: iso(NOW - DAY), ...over,
})
const binding = (over = {}) => ({ original_transaction_id: 'orig-1', user_id: TEST_USER, environment: 'Production', owner_state: 'active', ...over })
const entitlementRow = (over = {}) => ({
  user_id: TEST_USER, product_id: 'student_basic_monthly', plan_type: 'student_pass', status: 'active',
  starts_at: iso(NOW - 5 * DAY), expires_at: iso(NOW + 25 * DAY), revoked_at: null, source_transaction_id: 'sub_1', ...over,
})

function makeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this }, json(p) { this.body = p; return this } }
}

/** Run handleCheckout with the REAL gate order. `authedAs` is what verified server auth returns. */
async function checkout(tables = {}, { authedAs = TEST_USER, req = {}, statusFor } = {}) {
  const calls = { customer: 0, session: 0, params: null }
  const res = makeRes()
  const stripe = { checkout: { sessions: { create: async (params) => { calls.session += 1; calls.params = params; return { url: 'https://checkout.stripe.test/session' } } } } }
  await handleCheckout(
    { headers: {}, body: { plan_code: 'student_basic_monthly' }, ...req },
    res,
    {
      authenticate: async () => ({ userId: authedAs, email: `${authedAs}@example.com` }),
      getDb: () => fakeDb(tables),
      getStripeClient: async () => stripe,
      statusFor: statusFor ?? (async () => ({ provider: null, active: false, status: 'none', manageable: false })),
      ensureCustomer: async () => { calls.customer += 1; return 'cus_test' },
    },
  )
  return { res, calls }
}

const closed = ({ res, calls }) => {
  expect(res.statusCode).toBe(503)
  expect(res.body).toMatchObject({ ok: false, error: 'commercialization_not_available' })
  expect(calls.customer).toBe(0)
  expect(calls.session).toBe(0)
}
const reachedCheckout = ({ res, calls }) => {
  expect(res.statusCode).toBe(200)
  expect(res.body).toEqual({ ok: true, url: 'https://checkout.stripe.test/session' })
  expect(calls.customer).toBe(1)
  expect(calls.session).toBe(1)
}

let warn
beforeEach(() => {
  vi.stubEnv('PUBLIC_COMMERCIALIZATION_ENABLED', 'false')
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_abc123')
  vi.stubEnv('STRIPE_TEST_CHECKOUT_ALLOWED_USER_IDS', TEST_USER)
  vi.stubEnv('STRIPE_PRICE_STUDENT_BASIC_MONTHLY', 'price_test_monthly')
  vi.stubEnv('STRIPE_PRICE_STUDENT_BASIC_ANNUAL', 'price_test_annual')
  vi.stubEnv('APPLE_IAP_PRIVATE_KEY', '') // no Apple server API in tests: the lookup must not reach out
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('1. commercialization=false, no allowlist', () => {
  it.each([['unset', undefined], ['empty', ''], ['whitespace', '   ']])('allowlist %s → 503 commercialization_not_available', async (_n, value) => {
    vi.stubEnv('STRIPE_TEST_CHECKOUT_ALLOWED_USER_IDS', value ?? '')
    if (value === undefined) delete process.env.STRIPE_TEST_CHECKOUT_ALLOWED_USER_IDS
    closed(await checkout())
  })

  it('PUBLIC_COMMERCIALIZATION_ENABLED unset (fail-closed default) and no allowlist → 503', async () => {
    delete process.env.PUBLIC_COMMERCIALIZATION_ENABLED
    delete process.env.STRIPE_TEST_CHECKOUT_ALLOWED_USER_IDS
    closed(await checkout())
  })
})

describe('2. commercialization=false, user NOT on the allowlist', () => {
  it('a different authenticated user → 503, no Stripe customer or session', async () => {
    closed(await checkout({}, { authedAs: OTHER }))
  })

  it('a user id that merely contains / prefixes the allowlisted id is not a match', async () => {
    closed(await checkout({}, { authedAs: `${TEST_USER}0` }))
    closed(await checkout({}, { authedAs: TEST_USER.slice(0, 35) }))
  })

  it('multiple allowlisted ids: only the listed ones pass', async () => {
    vi.stubEnv('STRIPE_TEST_CHECKOUT_ALLOWED_USER_IDS', `${TEST_USER}, ${OTHER}`)
    reachedCheckout(await checkout({}, { authedAs: OTHER }))
    closed(await checkout({}, { authedAs: THIRD }))
  })
})

describe('3. commercialization=false + allowlisted user + Stripe TEST', () => {
  it('reaches the normal checkout path and creates the Stripe session with SERVER-derived values', async () => {
    const out = await checkout()
    reachedCheckout(out)
    expect(out.calls.params).toMatchObject({
      mode: 'subscription',
      customer: 'cus_test',
      line_items: [{ price: 'price_test_monthly', quantity: 1 }],
      client_reference_id: TEST_USER,
      metadata: { user_id: TEST_USER, plan_code: 'student_basic_monthly' },
    })
    expect(warn).toHaveBeenCalled() // the scoped path is auditable in logs
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TEST_USER) // …without logging the user id or any secret
  })

  it('matching is case-insensitive on the UUID', async () => {
    vi.stubEnv('STRIPE_TEST_CHECKOUT_ALLOWED_USER_IDS', TEST_USER.toUpperCase())
    reachedCheckout(await checkout())
  })

  it('a restricted TEST key (rk_test_) also counts as TEST mode', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'rk_test_abc123')
    reachedCheckout(await checkout())
  })

  it('later guards still run: invalid plan → 400 and unconfigured price → 503 plan_not_configured', async () => {
    const bad = await checkout({}, { req: { body: { plan_code: 'student_basic_lifetime' } } })
    expect(bad.res.statusCode).toBe(400)
    expect(bad.res.body.error).toBe('invalid_plan')
    expect(bad.calls.session).toBe(0)

    vi.stubEnv('STRIPE_PRICE_STUDENT_BASIC_MONTHLY', 'price_REPLACE_ME_MONTHLY')
    const unpriced = await checkout()
    expect(unpriced.res.statusCode).toBe(503)
    expect(unpriced.res.body.error).toBe('plan_not_configured')
    expect(unpriced.calls.session).toBe(0)
  })

  it('a client-supplied price is ignored: the server price id is always used', async () => {
    const out = await checkout({}, { req: { body: { plan_code: 'student_basic_monthly', price_id: 'price_attacker', price: 'price_attacker', amount: 1 } } })
    reachedCheckout(out)
    expect(out.calls.params.line_items).toEqual([{ price: 'price_test_monthly', quantity: 1 }])
  })
})

describe('4. allowlisted user with an active entitlement is STILL blocked (guards preserved)', () => {
  const blocked = ({ res, calls }, error = 'entitlement_already_active') => {
    expect(res.statusCode).toBe(409)
    expect(res.body).toMatchObject({ ok: false, error })
    expect(calls.customer).toBe(0)
    expect(calls.session).toBe(0)
  }

  it('active Apple Production subscription', async () => {
    blocked(await checkout({ app_store_subscription_states: [appleState()], app_store_subscription_bindings: [binding()] }))
  })

  it('active admin gift', async () => {
    blocked(await checkout({ user_entitlements: [entitlementRow({ product_id: 'admin_student_basic', source_transaction_id: null })] }))
  })

  it('active Stripe entitlement (projected)', async () => {
    blocked(await checkout({ user_entitlements: [entitlementRow()] }))
  })

  it('active Stripe subscription per the Stripe-status guard', async () => {
    blocked(await checkout({}, { statusFor: async () => ({ active: true, status: 'active', manageable: true }) }), 'subscription_already_exists')
  })

  it('an entitlement-lookup failure still fails closed for the allowlisted user', async () => {
    const calls = { customer: 0, session: 0 }
    const res = makeRes()
    await handleCheckout({ headers: {}, body: { plan_code: 'student_basic_monthly' } }, res, {
      authenticate: async () => ({ userId: TEST_USER, email: 'u@example.com' }),
      getDb: () => fakeDb({}),
      getStripeClient: async () => ({ checkout: { sessions: { create: async () => { calls.session += 1 } } } }),
      statusFor: async () => ({ active: false, status: 'none', manageable: false }),
      entitlementLookup: async () => { throw new Error('db down') },
      ensureCustomer: async () => { calls.customer += 1 },
    })
    expect(res.statusCode).toBe(503)
    expect(res.body.error).toBe('entitlement_check_failed')
    expect(calls).toEqual({ customer: 0, session: 0 })
  })
})

describe('5. malformed allowlist fails closed', () => {
  it.each([
    ['not a uuid', 'not-a-uuid'],
    ['wildcard', '*'],
    ['wildcard beside a valid id', `${TEST_USER},*`],
    ['valid id plus garbage', `${TEST_USER},garbage`],
    ['trailing comma (empty slot)', `${TEST_USER},`],
    ['leading comma', `,${TEST_USER}`],
    ['double comma', `${TEST_USER},,${OTHER}`],
    ['JSON-ish', JSON.stringify([TEST_USER])],
    ['quoted', `"${TEST_USER}"`],
    ['uuid with extra suffix', `${TEST_USER}x`],
    ['email instead of id', 'summer@example.com'],
    ['the literal word true', 'true'],
    ['over the cap', [TEST_USER, OTHER, THIRD, '44444444-4444-4444-8444-444444444444'].join(',')],
  ])('%s → nobody is allowed, even the id that appears in the list', async (_name, value) => {
    vi.stubEnv('STRIPE_TEST_CHECKOUT_ALLOWED_USER_IDS', value)
    closed(await checkout({}, { authedAs: TEST_USER }))
    closed(await checkout({}, { authedAs: OTHER }))
  })

  it('a malformed authenticated user id never matches', async () => {
    for (const bad of ['', '   ', 'x', null, undefined]) {
      expect(isScopedTestCheckoutUser(bad)).toBe(false)
    }
  })
})

describe('6. Stripe LIVE (or non-test) key + allowlist + commercialization=false → still blocked', () => {
  it.each([
    ['sk_live_', 'sk_live_abc123'],
    ['rk_live_', 'rk_live_abc123'],
    ['missing key', ''],
    ['whitespace key', '   '],
    ['bare prefix', 'sk_test_'],
    ['unknown prefix', 'pk_test_abc123'],
    ['test text inside a live key', 'sk_live_sk_test_abc'],
    ['uppercase prefix', 'SK_TEST_abc123'],
  ])('%s → 503', async (_name, key) => {
    vi.stubEnv('STRIPE_SECRET_KEY', key)
    closed(await checkout())
  })

  it('no key variable at all → 503', async () => {
    delete process.env.STRIPE_SECRET_KEY
    closed(await checkout())
  })
})

describe('7. commercialization=true → existing public behavior unchanged', () => {
  it('any user reaches checkout, allowlist or not, and the scoped path is not consulted', async () => {
    vi.stubEnv('PUBLIC_COMMERCIALIZATION_ENABLED', 'true')
    vi.stubEnv('STRIPE_TEST_CHECKOUT_ALLOWED_USER_IDS', '')
    reachedCheckout(await checkout({}, { authedAs: OTHER }))
    vi.stubEnv('STRIPE_TEST_CHECKOUT_ALLOWED_USER_IDS', TEST_USER)
    reachedCheckout(await checkout({}, { authedAs: OTHER }))
    reachedCheckout(await checkout({}, { authedAs: TEST_USER }))
    expect(warn).not.toHaveBeenCalled()
  })

  it('a LIVE key with the public switch open behaves exactly as before (allowlist irrelevant)', async () => {
    vi.stubEnv('PUBLIC_COMMERCIALIZATION_ENABLED', 'true')
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_abc123')
    reachedCheckout(await checkout({}, { authedAs: OTHER }))
  })

  it('the entitlement guards are unchanged under the public switch', async () => {
    vi.stubEnv('PUBLIC_COMMERCIALIZATION_ENABLED', 'true')
    const out = await checkout({ user_entitlements: [entitlementRow()] })
    expect(out.res.statusCode).toBe(409)
    expect(out.res.body.error).toBe('entitlement_already_active')
  })

  it.each(['TRUE', ' true ', 'True'])('the switch value %j still opens checkout as before', async (value) => {
    vi.stubEnv('PUBLIC_COMMERCIALIZATION_ENABLED', value)
    reachedCheckout(await checkout({}, { authedAs: OTHER }))
  })

  it.each(['1', 'yes', 'on', ''])('a non-"true" switch value %j does NOT open it for the public', async (value) => {
    vi.stubEnv('PUBLIC_COMMERCIALIZATION_ENABLED', value)
    closed(await checkout({}, { authedAs: OTHER }))
  })
})

describe('8. the client cannot spoof the user id', () => {
  const spoofRequest = {
    headers: {
      'x-user-id': TEST_USER, 'x-supabase-user-id': TEST_USER, 'x-test-user': TEST_USER, 'x-admin': 'true',
      'x-youmi-test-checkout': '1', 'x-forwarded-user': TEST_USER,
    },
    body: {
      plan_code: 'student_basic_monthly', user_id: TEST_USER, userId: TEST_USER, uid: TEST_USER, sub: TEST_USER,
      admin: true, is_admin: true, test: true, test_checkout: true, bypass: true, commercialization: true,
      metadata: { user_id: TEST_USER },
    },
    query: { user_id: TEST_USER, admin: 'true' },
  }

  it('body / header / query naming the allowlisted user does not help another authenticated user → 503', async () => {
    closed(await checkout({}, { authedAs: OTHER, req: spoofRequest }))
  })

  it('the identity used is the verified one even when the body names someone else', async () => {
    const out = await checkout({}, { authedAs: TEST_USER, req: { body: { plan_code: 'student_basic_monthly', user_id: OTHER, userId: OTHER, metadata: { user_id: OTHER } } } })
    reachedCheckout(out)
    expect(out.calls.params.client_reference_id).toBe(TEST_USER)
    expect(out.calls.params.metadata.user_id).toBe(TEST_USER)
    expect(out.calls.params.subscription_data.metadata.user_id).toBe(TEST_USER)
  })

  it('an unauthenticated caller gets 401 from the real auth step; the allowlist is never consulted', async () => {
    const res = makeRes()
    await handleCheckout({ headers: { 'x-user-id': TEST_USER }, body: { plan_code: 'student_basic_monthly', user_id: TEST_USER } }, res)
    expect(res.statusCode).toBe(401)
    expect(res.body.error).toBe('auth_required')
    expect(warn).not.toHaveBeenCalled()
  })

  it('isScopedTestCheckoutUser takes only an id: nothing in the environment-agnostic signature reads a request', () => {
    expect(isScopedTestCheckoutUser.length).toBe(1)
    expect(isScopedTestCheckoutUser(TEST_USER)).toBe(true)
    expect(isScopedTestCheckoutUser(OTHER)).toBe(false)
  })
})

describe('config parsing (pure)', () => {
  it('isStripeTestModeKey accepts only sk_test_/rk_test_ keys with a body', () => {
    expect(isStripeTestModeKey('sk_test_abc')).toBe(true)
    expect(isStripeTestModeKey('rk_test_abc')).toBe(true)
    expect(isStripeTestModeKey('  sk_test_abc  ')).toBe(true)
    for (const bad of ['sk_live_abc', 'rk_live_abc', 'sk_test_', '', ' ', undefined, null, 42, {}, 'whsec_abc']) {
      expect(isStripeTestModeKey(bad)).toBe(false)
    }
  })

  it('parses, trims, lower-cases and de-duplicates valid UUID lists', () => {
    expect(parseScopedTestCheckoutUserIds(TEST_USER)).toEqual([TEST_USER])
    expect(parseScopedTestCheckoutUserIds(` ${TEST_USER.toUpperCase()} , ${OTHER} `)).toEqual([TEST_USER, OTHER])
    expect(parseScopedTestCheckoutUserIds(`${TEST_USER},${TEST_USER}`)).toEqual([TEST_USER])
    expect(SCOPED_TEST_CHECKOUT_MAX_USERS).toBe(3)
  })

  it('returns an empty (nobody) list for unset, blank, non-string and malformed input', () => {
    for (const bad of [undefined, null, '', '  ', 5, {}, [], `${TEST_USER};${OTHER}`, `${TEST_USER} ${OTHER}`]) {
      expect(parseScopedTestCheckoutUserIds(bad)).toEqual([])
    }
  })
})
