import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCheckout, hasActiveStudentBasicAccess } from './stripeRoutes.mjs'

/* Cross-provider double-purchase guard for Stripe Checkout.
 *
 * The guard must reuse the provider-neutral entitlement authority (the same lookup /api/quota/status
 * uses), so ONE definition of "has paid access" covers Apple, Stripe, admin gifts and legacy passes —
 * these tests run the REAL lookup (getActiveEntitlement -> getEffectiveSubscription + user_entitlements)
 * against an in-memory database, and never touch Stripe: a blocked case must create no Stripe object. */

const NOW = Date.parse('2026-10-06T12:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()
const DAY = 86_400_000
const USER = 'user-free-0001'
const OTHER = 'user-other-0002'

/** Minimal chainable stand-in for the supabase-js query builder used by the entitlement lookup. */
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
  user_id: USER, product_id: 'com.aydenz.youmilensipad.student.monthly', original_transaction_id: 'orig-1',
  latest_transaction_id: 'tx-1', subscription_group_id: '22109238', environment: 'Production', app_account_token: USER,
  purchased_at: iso(NOW - 5 * DAY), expires_at: iso(NOW + 25 * DAY), auto_renew_status: true, status: 'active',
  revocation_at: null, last_verified_at: iso(NOW - DAY), ...over,
})
const binding = (over = {}) => ({ original_transaction_id: 'orig-1', user_id: USER, environment: 'Production', owner_state: 'active', ...over })
const entitlementRow = (over = {}) => ({
  user_id: USER, product_id: 'student_basic_monthly', plan_type: 'student_pass', status: 'active',
  starts_at: iso(NOW - 5 * DAY), expires_at: iso(NOW + 25 * DAY), revoked_at: null, source_transaction_id: 'sub_1', ...over,
})

function makeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this }, json(p) { this.body = p; return this } }
}

/** Run handleCheckout with every collaborator injected; report whether any Stripe object was created. */
async function checkout(tables, { userId = USER, lookup } = {}) {
  const calls = { customer: 0, session: 0 }
  const res = makeRes()
  const stripe = { checkout: { sessions: { create: async () => { calls.session += 1; return { url: 'https://checkout.stripe.test/session' } } } } }
  await handleCheckout(
    { headers: { authorization: 'Bearer t' }, body: { plan_code: 'student_basic_monthly' } },
    res,
    {
      authenticate: async () => ({ userId, email: `${userId}@example.com` }),
      getDb: () => fakeDb(tables),
      getStripeClient: async () => stripe,
      statusFor: async () => ({ provider: null, active: false, status: 'none', manageable: false }),
      entitlementLookup: lookup,
      trialHistory: async () => false, // trial eligibility is covered in stripeTrial.test.mjs; this suite is about the guards
      ensureCustomer: async () => { calls.customer += 1; return 'cus_test' },
    },
  )
  return { res, calls }
}

beforeEach(() => {
  vi.stubEnv('PUBLIC_COMMERCIALIZATION_ENABLED', 'true')
  vi.stubEnv('STRIPE_PRICE_STUDENT_BASIC_MONTHLY', 'price_test_monthly')
  vi.stubEnv('STRIPE_PRICE_STUDENT_BASIC_ANNUAL', 'price_test_annual')
  vi.stubEnv('APPLE_IAP_PRIVATE_KEY', '') // no Apple server API in tests: the lookup must not reach out
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

const blocked = ({ res, calls }) => {
  expect(res.statusCode).toBe(409)
  expect(res.body).toMatchObject({ ok: false, error: 'entitlement_already_active' })
  expect(calls).toEqual({ customer: 0, session: 0 }) // no Stripe customer, no Checkout Session
}
const allowed = ({ res, calls }) => {
  expect(res.statusCode).toBe(200)
  expect(res.body).toEqual({ ok: true, url: 'https://checkout.stripe.test/session' })
  expect(calls).toEqual({ customer: 1, session: 1 })
}

describe('free user', () => {
  it('may create Stripe Checkout when commercialization is enabled', async () => {
    allowed(await checkout({}))
  })
})

describe('active paid access from ANY provider blocks a new Stripe subscription', () => {
  it('Apple Production subscription', async () => {
    blocked(await checkout({ app_store_subscription_states: [appleState()], app_store_subscription_bindings: [binding()] }))
  })

  it('Apple Sandbox / TestFlight subscription on an allowed test chain', async () => {
    blocked(await checkout({
      app_store_subscription_states: [appleState({ environment: 'Sandbox' })],
      app_store_subscription_bindings: [binding({ environment: 'Sandbox' })],
      subscription_test_chain_policy: [{ user_id: USER, original_transaction_id: 'orig-1', environment: 'Sandbox' }],
    }))
  })

  it('active Stripe subscription (projected into user_entitlements)', async () => {
    blocked(await checkout({ user_entitlements: [entitlementRow()] }))
  })

  it('admin gift (admin_student_basic)', async () => {
    blocked(await checkout({ user_entitlements: [entitlementRow({ product_id: 'admin_student_basic', source_transaction_id: null })] }))
  })

  it('legacy 30-day Apple pass', async () => {
    blocked(await checkout({ user_entitlements: [entitlementRow({ product_id: 'com.aydenz.youmilensipad.studentbasic30d' })] }))
  })

  it('the Stripe-status guard still blocks first and independently', async () => {
    const calls = { customer: 0, session: 0 }
    const res = makeRes()
    await handleCheckout({ headers: {}, body: { plan_code: 'student_basic_monthly' } }, res, {
      authenticate: async () => ({ userId: USER, email: 'u@example.com' }),
      getDb: () => fakeDb({}),
      getStripeClient: async () => ({ checkout: { sessions: { create: async () => { calls.session += 1 } } } }),
      statusFor: async () => ({ active: true, status: 'active', manageable: true }),
      ensureCustomer: async () => { calls.customer += 1 },
    })
    expect(res.statusCode).toBe(409)
    expect(res.body.error).toBe('subscription_already_exists')
    expect(calls).toEqual({ customer: 0, session: 0 })
  })
})

describe('non-granting entitlements do not block', () => {
  it('expired entitlement', async () => {
    allowed(await checkout({ user_entitlements: [entitlementRow({ expires_at: iso(NOW - DAY) })] }))
  })

  it('revoked entitlement', async () => {
    allowed(await checkout({ user_entitlements: [entitlementRow({ revoked_at: iso(NOW - DAY) })] }))
  })

  it('entitlement that has not started yet', async () => {
    allowed(await checkout({ user_entitlements: [entitlementRow({ starts_at: iso(NOW + DAY) })] }))
  })

  it('non-active status row', async () => {
    allowed(await checkout({ user_entitlements: [entitlementRow({ status: 'expired' })] }))
  })

  it('expired Apple subscription', async () => {
    allowed(await checkout({
      app_store_subscription_states: [appleState({ status: 'expired', expires_at: iso(NOW - DAY) })],
      app_store_subscription_bindings: [binding()],
    }))
  })

  it('Apple Sandbox chain with NO test-chain policy does not grant access, so it does not block', async () => {
    allowed(await checkout({
      app_store_subscription_states: [appleState({ environment: 'Sandbox' })],
      app_store_subscription_bindings: [binding({ environment: 'Sandbox' })],
    }))
  })

  it('Apple state whose canonical owner is someone else does not block this user', async () => {
    allowed(await checkout({
      app_store_subscription_states: [appleState()],
      app_store_subscription_bindings: [binding({ user_id: OTHER })],
    }))
  })
})

describe('account isolation', () => {
  it("another user's active entitlement never blocks this user", async () => {
    allowed(await checkout({
      user_entitlements: [entitlementRow({ user_id: OTHER })],
      app_store_subscription_states: [appleState({ user_id: OTHER })],
      app_store_subscription_bindings: [binding({ user_id: OTHER })],
    }))
  })

  it('an active entitlement blocks only its own owner', async () => {
    const tables = { user_entitlements: [entitlementRow({ user_id: OTHER })] }
    blocked(await checkout(tables, { userId: OTHER }))
    allowed(await checkout(tables, { userId: USER }))
  })
})

describe('fail closed', () => {
  it('an entitlement lookup failure refuses checkout and creates no Stripe object', async () => {
    const out = await checkout({}, { lookup: async () => { throw new Error('db down') } })
    expect(out.res.statusCode).toBe(503)
    expect(out.res.body.error).toBe('entitlement_check_failed')
    expect(out.calls).toEqual({ customer: 0, session: 0 })
  })

  it('commercialization closed still blocks everyone BEFORE the entitlement check', async () => {
    vi.stubEnv('PUBLIC_COMMERCIALIZATION_ENABLED', 'false')
    let looked = 0
    const lookup = async () => { looked += 1; return null }
    for (const tables of [{}, { user_entitlements: [entitlementRow()] }]) {
      const out = await checkout(tables, { lookup })
      expect(out.res.statusCode).toBe(503)
      expect(out.res.body.error).toBe('commercialization_not_available')
      expect(out.calls).toEqual({ customer: 0, session: 0 })
    }
    expect(looked).toBe(0)
  })
})

describe('hasActiveStudentBasicAccess is read-only and uses the neutral authority', () => {
  it('reports each source through the same function', async () => {
    const t = (tables) => hasActiveStudentBasicAccess(fakeDb(tables), USER, NOW)
    expect(await t({})).toBe(false)
    expect(await t({ user_entitlements: [entitlementRow()] })).toBe(true)
    expect(await t({ app_store_subscription_states: [appleState()], app_store_subscription_bindings: [binding()] })).toBe(true)
  })
})
