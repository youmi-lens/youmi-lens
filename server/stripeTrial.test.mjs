// Server-trusted price mapping BEFORE importing the modules under test.
process.env.STRIPE_PRICE_STUDENT_BASIC_MONTHLY = 'price_monthly'
process.env.STRIPE_PRICE_STUDENT_BASIC_ANNUAL = 'price_annual'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PLAN_LIMITS } from './betaGate.mjs'
import { getActiveEntitlement, isEntitlementActive } from './iapEntitlements.mjs'
import { handleCheckout } from './stripeRoutes.mjs'
import {
  TRIAL_CHECKOUT_EXPIRES_SECONDS,
  addCalendarMonthsUtc,
  stripeKeyMode,
  trialEndUnixForPlanCode,
  trialMonthsForPlanCode,
} from './stripeConfig.mjs'
import { applyStripeSubscription, buildSubscriptionStatus, deriveSubscriptionRecord } from './stripeSubscriptions.mjs'
import { hasPriorSubscriptionHistory } from './stripeTrialEligibility.mjs'

/* Stripe free trial: ONE calendar month on both Student Basic plans, server-decided.
 *
 *  - the trial is a server-computed absolute `trial_end` (never `trial_period_days`, never client input);
 *  - eligibility = no prior REAL history: Apple `environment = 'Production'` rows, and Stripe history in the CURRENT
 *    account mode only (TEST and LIVE never see each other; our unmarked tables are not consulted);
 *  - every existing checkout guard still runs first; any lookup that fails or is ambiguous refuses checkout;
 *  - a `trialing` subscription grants Student Basic until the trial ends; a failed payment gets the 3-day grace
 *    counted from the start of the unpaid period and never a full unpaid month. */

const NOW = Date.parse('2026-10-06T12:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()
const DAY = 86_400_000
const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const unix = (s) => Math.floor(Date.parse(s) / 1000)

/* ── pure: calendar-month arithmetic ─────────────────────────────────────── */
describe('addCalendarMonthsUtc — one CALENDAR month, not 30 days', () => {
  const plusOne = (from) => iso(addCalendarMonthsUtc(Date.parse(from), 1) * 1000)

  it.each([
    ['2026-10-06T12:00:00.000Z', '2026-11-06T12:00:00.000Z', 'ordinary day (31-day month)'],
    ['2026-10-31T09:30:15.000Z', '2026-11-30T09:30:15.000Z', 'Oct 31 → Nov 30 (clamped)'],
    ['2026-03-31T00:00:00.000Z', '2026-04-30T00:00:00.000Z', 'Mar 31 → Apr 30 (clamped)'],
    ['2026-08-31T23:59:59.000Z', '2026-09-30T23:59:59.000Z', 'Aug 31 → Sep 30 (clamped)'],
    ['2027-01-31T12:00:00.000Z', '2027-02-28T12:00:00.000Z', 'Jan 31 → Feb 28 (common year)'],
    ['2028-01-31T12:00:00.000Z', '2028-02-29T12:00:00.000Z', 'Jan 31 → Feb 29 (leap year)'],
    ['2027-01-29T12:00:00.000Z', '2027-02-28T12:00:00.000Z', 'Jan 29 → Feb 28 (common year)'],
    ['2028-02-29T12:00:00.000Z', '2028-03-29T12:00:00.000Z', 'Feb 29 → Mar 29'],
    ['2027-02-28T12:00:00.000Z', '2027-03-28T12:00:00.000Z', 'Feb 28 → Mar 28 (does not jump to month end)'],
    ['2026-12-31T12:00:00.000Z', '2027-01-31T12:00:00.000Z', 'Dec 31 → Jan 31 (year rollover)'],
    ['2026-12-15T12:00:00.000Z', '2027-01-15T12:00:00.000Z', 'Dec 15 → Jan 15 (year rollover)'],
  ])('%s → %s (%s)', (from, to) => {
    expect(plusOne(from)).toBe(to)
  })

  it('differs from "30 days" exactly where it should (31-day months), and is always ≥ 28 days (> Checkout 48h minimum)', () => {
    expect(addCalendarMonthsUtc(NOW, 1) * 1000 - NOW).toBe(31 * DAY) // Oct 6 → Nov 6 is 31 days, not 30
    for (let day = 0; day < 366; day++) {
      const from = NOW + day * DAY
      const span = addCalendarMonthsUtc(from, 1) * 1000 - from
      expect(span).toBeGreaterThanOrEqual(28 * DAY)
      expect(span).toBeLessThanOrEqual(31 * DAY)
    }
  })

  it('returns whole unix seconds', () => {
    expect(Number.isInteger(addCalendarMonthsUtc(NOW + 123, 1))).toBe(true)
  })
})

describe('trial policy per plan (server-owned)', () => {
  it('both Student Basic plans get exactly one month, with the same end moment', () => {
    expect(trialMonthsForPlanCode('student_basic_monthly')).toBe(1)
    expect(trialMonthsForPlanCode('student_basic_annual')).toBe(1)
    const m = trialEndUnixForPlanCode('student_basic_monthly', NOW)
    const a = trialEndUnixForPlanCode('student_basic_annual', NOW)
    expect(m).toBe(unix('2026-11-06T12:00:00.000Z'))
    expect(a).toBe(m)
  })

  it('an unknown plan code has no trial', () => {
    for (const bad of ['student_basic_lifetime', '', undefined, null, 'student_basic_monthly ']) {
      expect(trialMonthsForPlanCode(bad)).toBe(0)
      expect(trialEndUnixForPlanCode(bad, NOW)).toBe(null)
    }
  })
})

describe('stripeKeyMode', () => {
  it('classifies the key by its own prefix; anything else is unknown (null)', () => {
    expect(stripeKeyMode('sk_test_abc')).toBe('test')
    expect(stripeKeyMode('rk_test_abc')).toBe('test')
    expect(stripeKeyMode(' sk_live_abc ')).toBe('live')
    expect(stripeKeyMode('rk_live_abc')).toBe('live')
    for (const bad of ['', '  ', 'sk_test_', 'sk_live_', 'pk_live_abc', 'whsec_x', 'live', undefined, null, 5, 'xx_live_abc']) {
      expect(stripeKeyMode(bad)).toBe(null)
    }
  })
})

/* ── fakes ────────────────────────────────────────────────────────────────── */
function fakeDb(tables, { failTable = null } = {}) {
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
        maybeSingle() {
          if (failTable === name) return Promise.resolve({ data: null, error: new Error(`${name} unavailable`) })
          return Promise.resolve({ data: rows[0] ?? null, error: null })
        },
        then(resolve, reject) {
          const error = failTable === name ? new Error(`${name} unavailable`) : null
          return Promise.resolve({ data: error ? null : rows, error }).then(resolve, reject)
        },
      }
      return q
    },
  }
}

/**
 * A Stripe client that behaves like Stripe's mode isolation: it only knows customers of ITS OWN mode (a customer id
 * from the other mode is `resource_missing`), `customers.search` only returns same-mode customers, and every
 * object carries `livemode`. `customers`: [{ id, user_id, livemode }]; `subs`: { [customerId]: [{ id, status, livemode }] }.
 */
function stripeFake({ mode = 'test', customers = [], subs = {}, searchError = null, listError = null } = {}) {
  const calls = { customer: 0, session: 0, params: null, searches: 0, lists: [] }
  const live = mode === 'live'
  const known = (id) => customers.find((c) => c.id === id && c.livemode === live)
  const client = {
    checkout: { sessions: { create: async (params) => { calls.session += 1; calls.params = params; return { url: 'https://checkout.stripe.test/session' } } } },
    customers: {
      search: async ({ query }) => {
        calls.searches += 1
        if (searchError) throw searchError
        const uid = /:'([^']+)'/.exec(query)?.[1]
        return { data: customers.filter((c) => c.livemode === live && c.user_id === uid).map((c) => ({ id: c.id, livemode: c.livemode })) }
      },
    },
    subscriptions: {
      list: async ({ customer }) => {
        calls.lists.push(customer)
        if (listError) throw listError
        if (!known(customer)) { const e = new Error(`No such customer: '${customer}'`); e.code = 'resource_missing'; throw e }
        return { data: subs[customer] ?? [] }
      },
    },
  }
  return { client, calls, mode }
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
const expiredApple = (env) => ({ app_store_subscription_states: [appleState({ environment: env, status: 'expired', expires_at: iso(NOW - DAY) })] })
const makeRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this }, json(p) { this.body = p; return this } })

/** Run the REAL handleCheckout. `stripe` options build a mode-aware Stripe fake (also sets the matching key). */
async function checkout(tables = {}, { planCode = 'student_basic_monthly', body, authedAs = USER, stripe: stripeOpts = {}, trialHistory, failTable, statusFor } = {}) {
  const fake = stripeFake(stripeOpts)
  vi.stubEnv('STRIPE_SECRET_KEY', fake.mode === 'live' ? 'sk_live_abc123' : 'sk_test_abc123')
  const res = makeRes()
  const deps = {
    authenticate: async () => ({ userId: authedAs, email: `${authedAs}@example.com` }),
    getDb: () => fakeDb(tables, { failTable }),
    getStripeClient: async () => fake.client,
    statusFor: statusFor ?? (async () => ({ provider: null, active: false, status: 'none', manageable: false })),
    ensureCustomer: async () => { fake.calls.customer += 1; return 'cus_new' },
  }
  if (trialHistory) deps.trialHistory = trialHistory
  await handleCheckout({ headers: {}, body: body ?? { plan_code: planCode } }, res, deps)
  return { res, calls: fake.calls }
}

const ok = ({ res, calls }) => { expect(res.statusCode).toBe(200); expect(res.body).toMatchObject({ ok: true }); expect(calls.session).toBe(1) }
const noStripeObjects = ({ calls }) => { expect(calls.customer).toBe(0); expect(calls.session).toBe(0) }
const expectedTrialEnd = unix('2026-11-06T12:00:00.000Z')
const withTrial = (out) => { ok(out); expect(out.calls.params.subscription_data.trial_end).toBe(expectedTrialEnd) }
const withoutTrial = (out) => {
  ok(out)
  expect(out.calls.params.subscription_data).not.toHaveProperty('trial_end')
  expect(out.calls.params.subscription_data).not.toHaveProperty('trial_period_days')
  expect(out.calls.params).not.toHaveProperty('payment_method_collection')
  expect(out.calls.params).not.toHaveProperty('expires_at')
  expect(out.calls.params.line_items).toEqual([{ price: 'price_monthly', quantity: 1 }]) // pays the normal price
}
const failedClosed = (out) => {
  expect(out.res.statusCode).toBe(503)
  expect(out.res.body).toMatchObject({ ok: false, error: 'trial_eligibility_check_failed' })
  noStripeObjects(out)
}

beforeEach(() => {
  vi.stubEnv('PUBLIC_COMMERCIALIZATION_ENABLED', 'true')
  vi.stubEnv('APPLE_IAP_PRIVATE_KEY', '')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('eligible account: one calendar month free, price from the plan', () => {
  it('monthly → trial_end = +1 calendar month, server price, card collected, no trial_period_days', async () => {
    const out = await checkout()
    withTrial(out)
    expect(out.calls.params.line_items).toEqual([{ price: 'price_monthly', quantity: 1 }])
    expect(out.calls.params.subscription_data).not.toHaveProperty('trial_period_days')
    expect(out.calls.params.payment_method_collection).toBe('always')
    expect(out.calls.params.subscription_data.metadata).toEqual({ user_id: USER, plan_code: 'student_basic_monthly' })
    expect(out.calls.params.client_reference_id).toBe(USER)
  })

  it('annual → the same one-month trial, annual price', async () => {
    const out = await checkout({}, { planCode: 'student_basic_annual' })
    withTrial(out)
    expect(out.calls.params.line_items).toEqual([{ price: 'price_annual', quantity: 1 }])
    expect(out.calls.params.payment_method_collection).toBe('always')
  })

  it('month-end start (Oct 31) ends on Nov 30, not Dec 1', async () => {
    vi.setSystemTime(Date.parse('2026-10-31T08:00:00.000Z'))
    const out = await checkout()
    expect(out.calls.params.subscription_data.trial_end).toBe(unix('2026-11-30T08:00:00.000Z'))
  })
})

describe('6 (timing). a trial session is short-lived so little of the month is lost', () => {
  it('expires_at = creation + 1 hour (inside Stripe\'s 30 min – 24 h window), far before the trial end', async () => {
    const out = await checkout()
    const created = Math.floor(NOW / 1000)
    expect(TRIAL_CHECKOUT_EXPIRES_SECONDS).toBe(3600)
    expect(out.calls.params.expires_at).toBe(created + 3600)
    expect(out.calls.params.expires_at - created).toBeGreaterThanOrEqual(30 * 60)
    expect(out.calls.params.expires_at - created).toBeLessThanOrEqual(24 * 3600)
    expect(out.calls.params.subscription_data.trial_end - out.calls.params.expires_at).toBeGreaterThan(27 * 86400)
  })

  it('a session without a trial is unchanged (no expires_at override, default 24 h)', async () => {
    withoutTrial(await checkout({ ...expiredApple('Production') }))
  })

  it('the worst-case shortening is the session lifetime: 1 h of a ≥28-day trial (≤0.15%)', () => {
    expect(TRIAL_CHECKOUT_EXPIRES_SECONDS / (28 * 86400)).toBeLessThan(0.0015)
  })
})

describe('18. the client cannot specify, extend or force a trial, or influence environment / grace / dates', () => {
  const hostile = {
    plan_code: 'student_basic_monthly', trial: true, trial_end: unix('2030-01-01T00:00:00Z'), trial_period_days: 365,
    trial_days: 365, subscription_data: { trial_period_days: 365, trial_end: 1 }, free_trial: true, payment_method_collection: 'if_required',
    price: 'price_attacker', amount: 0, livemode: true, environment: 'Sandbox', mode: 'live', stripe_mode: 'test',
    grace_days: 365, grace_until: '2099-01-01T00:00:00Z', current_period_end: '2099-01-01T00:00:00Z', expires_at: 1, eligible: true, has_history: false,
  }

  it('an ELIGIBLE user still gets exactly the server trial — body fields are ignored', async () => {
    const out = await checkout({}, { body: hostile })
    withTrial(out)
    expect(out.calls.params.subscription_data).not.toHaveProperty('trial_period_days')
    expect(out.calls.params.payment_method_collection).toBe('always')
    expect(out.calls.params.expires_at).toBe(Math.floor(NOW / 1000) + 3600)
    expect(out.calls.params.line_items).toEqual([{ price: 'price_monthly', quantity: 1 }])
  })

  it('an INELIGIBLE user (Production Apple history) cannot force trial=true / clear history / claim another environment', async () => {
    withoutTrial(await checkout(expiredApple('Production'), { body: hostile }))
  })

  it('an unknown plan_code never reaches trial logic (400 invalid_plan)', async () => {
    const out = await checkout({}, { body: { plan_code: 'student_basic_lifetime', trial: true } })
    expect(out.res.statusCode).toBe(400)
    noStripeObjects(out)
  })
})

/* ── Part 1: Apple environment semantics ─────────────────────────────────── */
describe('1–2. Apple history: only PRODUCTION blocks the real Stripe trial', () => {
  it.each([
    ['expired Production state', expiredApple('Production')],
    ['refunded Production state', { app_store_subscription_states: [appleState({ status: 'refunded', expires_at: iso(NOW - DAY) })] }],
    ['Production binding only', { app_store_subscription_bindings: [binding()] }],
  ])('1. %s → NO trial (conservative)', async (_name, tables) => {
    withoutTrial(await checkout(tables))
  })

  it.each(['Sandbox', 'Xcode', 'LocalTesting'])('2. %s state is test data → does NOT block the trial', async (env) => {
    withTrial(await checkout(expiredApple(env)))
  })

  it.each(['Sandbox', 'Xcode', 'LocalTesting'])('2. %s binding is test data → does NOT block the trial', async (env) => {
    withTrial(await checkout({ app_store_subscription_bindings: [binding({ environment: env })] }))
  })

  it('a Sandbox row never masks a Production row for the same user', async () => {
    withoutTrial(await checkout({
      app_store_subscription_states: [appleState({ environment: 'Sandbox', original_transaction_id: 'orig-sb', latest_transaction_id: 'tx-sb', status: 'expired' })],
      app_store_subscription_bindings: [binding({ original_transaction_id: 'orig-prod', environment: 'Production' })],
    }))
  })

  it("environment comes from the stored column, never from the product id", async () => {
    // A Sandbox row whose product id is the real production product still does not block.
    withTrial(await checkout(expiredApple('Sandbox')))
  })

  it("another user's Production Apple history does not affect this user", async () => {
    withTrial(await checkout({ app_store_subscription_states: [appleState({ user_id: OTHER })], app_store_subscription_bindings: [binding({ user_id: OTHER })] }))
  })
})

/* ── Part 2: Stripe TEST vs LIVE isolation ───────────────────────────────── */
describe('3–5. Stripe history is read in the CURRENT mode only', () => {
  const testCust = { id: 'cus_TEST1', user_id: USER, livemode: false }
  const liveCust = { id: 'cus_LIVE1', user_id: USER, livemode: true }
  const subIn = (livemode, id = 'sub_old', status = 'canceled') => ({ id, status, livemode })

  it('3. TEST history blocks another TEST trial', async () => {
    const out = await checkout({ stripe_customers: [{ user_id: USER, stripe_customer_id: 'cus_TEST1' }] }, { stripe: { mode: 'test', customers: [testCust], subs: { cus_TEST1: [subIn(false)] } } })
    withoutTrial(out)
    expect(out.calls.lists).toEqual(['cus_TEST1'])
  })

  it('4. TEST history does NOT block a LIVE trial (stale TEST mapping, nothing live)', async () => {
    const out = await checkout(
      { stripe_customers: [{ user_id: USER, stripe_customer_id: 'cus_TEST1' }] }, // the pre-cutover mapping
      { stripe: { mode: 'live', customers: [testCust], subs: { cus_TEST1: [subIn(false)] } } },
    )
    withTrial(out)
    expect(out.calls.lists).toEqual(['cus_TEST1']) // Stripe answered resource_missing → no LIVE history through it
  })

  it('4b. leftover TEST rows in OUR tables never block a LIVE trial (they carry no mode marker, so they are not read)', async () => {
    const staleTestRows = {
      subscriptions: [{ user_id: USER, provider: 'stripe', provider_subscription_id: 'sub_test_row', status: 'active', provider_price_id: 'price_TEST' }],
      user_entitlements: [], // a test entitlement is irrelevant to eligibility (the active-entitlement guard handles access)
      billing_events: [{ user_id: USER, event_type: 'stripe_subscription_created', environment: 'sandbox' }],
    }
    withTrial(await checkout(staleTestRows, { stripe: { mode: 'live' } }))
    withTrial(await checkout(staleTestRows, { stripe: { mode: 'test' } })) // …and our table alone is not the history source in TEST either
  })

  it('5. LIVE history blocks another LIVE trial', async () => {
    const out = await checkout({ stripe_customers: [{ user_id: USER, stripe_customer_id: 'cus_LIVE1' }] }, { stripe: { mode: 'live', customers: [liveCust], subs: { cus_LIVE1: [subIn(true)] } } })
    withoutTrial(out)
  })

  it('5b. LIVE history is NOT hidden by a stale TEST mapping: it is found by the customer metadata', async () => {
    const out = await checkout(
      { stripe_customers: [{ user_id: USER, stripe_customer_id: 'cus_TEST1' }] }, // mapping still points at the TEST customer
      { stripe: { mode: 'live', customers: [testCust, liveCust], subs: { cus_TEST1: [subIn(false)], cus_LIVE1: [subIn(true, 'sub_live')] } } },
    )
    withoutTrial(out)
    expect(out.calls.searches).toBe(1)
  })

  it('5c. a TEST subscription never counts under a LIVE key, and a LIVE one never under a TEST key', async () => {
    withTrial(await checkout({}, { stripe: { mode: 'live', customers: [testCust], subs: { cus_TEST1: [subIn(false)] } } }))
    withTrial(await checkout({}, { stripe: { mode: 'test', customers: [liveCust], subs: { cus_LIVE1: [subIn(true)] } } }))
  })

  it('a customer with NO subscriptions in this mode is still eligible; the history query asks for every status', async () => {
    const calls = []
    const fake = stripeFake({ mode: 'test', customers: [testCust], subs: {} })
    const spy = vi.spyOn(fake.client.subscriptions, 'list').mockImplementation(async (args) => { calls.push(args); return { data: [] } })
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_abc123')
    await expect(hasPriorSubscriptionHistory(fakeDb({ stripe_customers: [{ user_id: USER, stripe_customer_id: 'cus_TEST1' }] }), fake.client, USER)).resolves.toBe(false)
    expect(calls).toEqual([{ customer: 'cus_TEST1', status: 'all', limit: 1 }])
    spy.mockRestore()
  })

  it('a user with no Stripe customer anywhere makes no list call', async () => {
    const out = await checkout({}, { stripe: { mode: 'test' } })
    withTrial(out)
    expect(out.calls.lists).toEqual([])
    expect(out.calls.searches).toBe(1)
  })
})

describe('6. malformed / ambiguous history fails safely (checkout refused, nothing created)', () => {
  it.each([
    ['Apple state with an unrecognised environment', { app_store_subscription_states: [appleState({ environment: 'Staging' })] }],
    ['Apple state with a NULL environment', { app_store_subscription_states: [appleState({ environment: null })] }],
    ['Apple binding with a lower-cased environment', { app_store_subscription_bindings: [binding({ environment: 'production' })] }],
    ['Apple binding with an unrecognised environment', { app_store_subscription_bindings: [binding({ environment: 'Enterprise' })] }],
  ])('%s', async (_name, tables) => {
    failedClosed(await checkout(tables))
  })

  it('too many Apple rows to rule Production out', async () => {
    const many = Array.from({ length: 200 }, (_, i) => appleState({ environment: 'Sandbox', original_transaction_id: `o${i}`, latest_transaction_id: `t${i}` }))
    failedClosed(await checkout({ app_store_subscription_states: many }))
  })

  it('a Stripe subscription whose livemode disagrees with the key', async () => {
    const cust = { id: 'cus_X', user_id: USER, livemode: false }
    failedClosed(await checkout({ stripe_customers: [{ user_id: USER, stripe_customer_id: 'cus_X' }] }, { stripe: { mode: 'test', customers: [cust], subs: { cus_X: [{ id: 'sub', status: 'active', livemode: true }] } } }))
    failedClosed(await checkout({ stripe_customers: [{ user_id: USER, stripe_customer_id: 'cus_X' }] }, { stripe: { mode: 'test', customers: [cust], subs: { cus_X: [{ id: 'sub', status: 'active' }] } } })) // livemode missing
  })

  it('a searched customer whose livemode disagrees with the key', async () => {
    const out = await checkout({}, { stripe: { mode: 'test', customers: [{ id: 'cus_Y', user_id: USER, livemode: false }] } })
    withTrial(out)
    const fake = stripeFake({ mode: 'test' })
    fake.client.customers.search = async () => ({ data: [{ id: 'cus_Y', livemode: true }] })
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_abc123')
    await expect(hasPriorSubscriptionHistory(fakeDb({}), fake.client, USER)).rejects.toThrow('stripe_history_mode_mismatch')
  })

  it('an unrecognised Stripe key (mode unknown)', async () => {
    const fake = stripeFake({ mode: 'test' })
    vi.stubEnv('STRIPE_SECRET_KEY', 'not-a-stripe-key')
    await expect(hasPriorSubscriptionHistory(fakeDb({}), fake.client, USER)).rejects.toThrow('stripe_mode_unknown')
  })

  it('a non-UUID user id is rejected before it can reach a Stripe search query', async () => {
    const fake = stripeFake({ mode: 'test' })
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_abc123')
    const search = vi.spyOn(fake.client.customers, 'search')
    await expect(hasPriorSubscriptionHistory(fakeDb({}), fake.client, "x'} OR metadata['user_id']:'y")).rejects.toThrow('trial_eligibility_invalid_user')
    expect(search).not.toHaveBeenCalled()
  })

  it('a Stripe error other than resource_missing is not swallowed', async () => {
    const out = await checkout({ stripe_customers: [{ user_id: USER, stripe_customer_id: 'cus_X' }] }, { stripe: { mode: 'test', customers: [{ id: 'cus_X', user_id: USER, livemode: false }], listError: Object.assign(new Error('rate limited'), { code: 'rate_limit' }) } })
    failedClosed(out)
  })

  it.each([
    ['Apple state table unreadable', { failTable: 'app_store_subscription_states' }],
    ['Apple binding table unreadable', { failTable: 'app_store_subscription_bindings' }],
    ['Stripe customer mapping unreadable', { failTable: 'stripe_customers' }],
    ['Stripe customer search fails', { stripe: { mode: 'test', searchError: new Error('search down') } }],
    ['an injected lookup that throws', { trialHistory: async () => { throw new Error('boom') } }],
  ])('%s', async (_name, opts) => {
    failedClosed(await checkout({}, opts))
  })
})

describe('active entitlements still block checkout — a trial never bypasses the guards', () => {
  const blocked = (out) => { expect(out.res.statusCode).toBe(409); expect(out.res.body.error).toBe('entitlement_already_active'); noStripeObjects(out) }

  it('17. active Apple-managed subscription → 409 (behavior unchanged)', async () => {
    blocked(await checkout({ app_store_subscription_states: [appleState()], app_store_subscription_bindings: [binding()] }))
  })
  it('active Stripe entitlement (incl. a trialing one) → 409', async () => {
    blocked(await checkout({ user_entitlements: [entitlementRow()] }))
  })
  it('admin entitlement → 409', async () => {
    blocked(await checkout({ user_entitlements: [entitlementRow({ product_id: 'admin_student_basic', source_transaction_id: null })] }))
  })
  it('the Stripe-status guard still wins first, before any history lookup', async () => {
    const out = await checkout({}, { statusFor: async () => ({ active: true, status: 'trialing', manageable: true }), trialHistory: async () => { throw new Error('must not be reached') } })
    expect(out.res.statusCode).toBe(409)
    expect(out.res.body.error).toBe('subscription_already_exists')
    noStripeObjects(out)
  })
})

describe('15–16. scoped allowlist and the public switch are unchanged', () => {
  it('PUBLIC_COMMERCIALIZATION_ENABLED=false + no allowlist → 503 BEFORE any eligibility lookup', async () => {
    vi.stubEnv('PUBLIC_COMMERCIALIZATION_ENABLED', 'false')
    const trialHistory = vi.fn(async () => false)
    const out = await checkout({}, { trialHistory })
    expect(out.res.statusCode).toBe(503)
    expect(out.res.body.error).toBe('commercialization_not_available')
    expect(trialHistory).not.toHaveBeenCalled()
    noStripeObjects(out)
  })

  it('allowlisted TEST user while the switch is closed → normal path WITH the trial', async () => {
    vi.stubEnv('PUBLIC_COMMERCIALIZATION_ENABLED', 'false')
    vi.stubEnv('STRIPE_TEST_CHECKOUT_ALLOWED_USER_IDS', USER)
    withTrial(await checkout())
  })

  it('allowlisted user with prior Production history gets no trial; another user stays blocked', async () => {
    vi.stubEnv('PUBLIC_COMMERCIALIZATION_ENABLED', 'false')
    vi.stubEnv('STRIPE_TEST_CHECKOUT_ALLOWED_USER_IDS', USER)
    withoutTrial(await checkout(expiredApple('Production')))
    const stranger = await checkout({}, { authedAs: OTHER })
    expect(stranger.res.statusCode).toBe(503)
    noStripeObjects(stranger)
  })

  it('a LIVE key with the allowlist and a closed switch is still blocked', async () => {
    vi.stubEnv('PUBLIC_COMMERCIALIZATION_ENABLED', 'false')
    vi.stubEnv('STRIPE_TEST_CHECKOUT_ALLOWED_USER_IDS', USER)
    const out = await checkout({}, { stripe: { mode: 'live' } })
    expect(out.res.statusCode).toBe(503)
    noStripeObjects(out)
  })
})

/* ── Part 3 / 5: lifecycle, 3-day grace, API payload ─────────────────────── */
const TRIAL_START = unix('2026-10-06T12:00:00Z')
const TRIAL_END = unix('2026-11-06T12:00:00Z')
const FIRST_PERIOD_END = unix('2026-12-06T12:00:00Z')
const SECOND_PERIOD_END = unix('2027-01-06T12:00:00Z')
const GRACE = 3

/** A Stripe `trialing` subscription as the pinned basil API returns it: period on the ITEM, not the root. */
function trialingSub(over = {}) {
  return {
    id: 'sub_trial', status: 'trialing', customer: 'cus_123', livemode: false, cancel_at_period_end: false,
    trial_start: TRIAL_START, trial_end: TRIAL_END,
    items: { data: [{ price: { id: 'price_monthly' }, current_period_start: TRIAL_START, current_period_end: TRIAL_END }] },
    metadata: { user_id: USER },
    ...over,
  }
}
const period = (start, end, price = 'price_monthly') => ({ data: [{ price: { id: price }, current_period_start: start, current_period_end: end }] })

/** In-memory Supabase stand-in that records project_stripe_entitlement as a real keyed upsert. */
function projectionDb() {
  const entitlements = new Map() // key = the Stripe subscription id — the table's unique (provider, provider_ref)
  const subscriptionRows = new Map()
  const rpcCalls = []
  const db = {
    from(table) {
      const q = {
        select() { return q }, eq() { return q },
        maybeSingle: async () => ({ data: table === 'stripe_customers' ? { user_id: USER } : null, error: null }),
        upsert: async (row) => { if (table === 'subscriptions') subscriptionRows.set(row.provider_subscription_id, row); return { error: null } },
      }
      return q
    },
    rpc: async (fn, args) => {
      rpcCalls.push({ fn, args })
      entitlements.set(args.p_subscription_id, {
        user_id: args.p_user_id, product_id: args.p_product_id, plan_type: 'student_pass', provider: 'stripe',
        status: args.p_active ? 'active' : 'revoked', revoked_at: args.p_active ? null : iso(NOW),
        starts_at: args.p_starts_at, expires_at: args.p_expires_at, source_transaction_id: null,
      })
      return { error: null }
    },
  }
  return { db, entitlements, subscriptionRows, rpcCalls }
}

/** The REAL entitlement authority (getActiveEntitlement + isEntitlementActive) over the projected rows. */
async function authorityAt(entitlements, nowMs) {
  const lookupDb = fakeDb({ user_entitlements: [...entitlements.values()] })
  const entitlement = await getActiveEntitlement(lookupDb, USER, iso(nowMs))
  return { entitlement, active: isEntitlementActive(entitlement, nowMs) }
}
const at = (unixSeconds, plusMs = 0) => unixSeconds * 1000 + plusMs

describe('10. a Stripe `trialing` subscription grants Student Basic', () => {
  it('projects an ACTIVE student_pass entitlement spanning the trial, and the quota authority honors it', async () => {
    const { db, entitlements, rpcCalls } = projectionDb()
    const result = await applyStripeSubscription(db, trialingSub(), { nowMs: NOW, eventCreatedMs: NOW })
    expect(result).toMatchObject({ applied: true })
    expect(result.record).toMatchObject({ status: 'trialing', plan_code: 'student_basic_monthly', billing_interval: 'month' })
    expect(rpcCalls[0].args).toMatchObject({
      p_user_id: USER, p_subscription_id: 'sub_trial', p_product_id: 'student_basic_monthly', p_active: true,
      p_starts_at: iso(TRIAL_START * 1000), p_expires_at: iso(TRIAL_END * 1000),
    })
    const during = await authorityAt(entitlements, NOW + 10 * DAY)
    expect(during.active).toBe(true)
    expect(during.entitlement).toMatchObject({ plan_type: 'student_pass', product_id: 'student_basic_monthly' })
    expect(PLAN_LIMITS[during.entitlement.plan_type]).toMatchObject({ monthly_minutes_limit: 600, max_recordings_per_day: 6, max_processing_jobs_per_day: 10 })
  })

  it('an annual trialing subscription grants the same tier', async () => {
    const { db, entitlements } = projectionDb()
    await applyStripeSubscription(db, trialingSub({ items: period(TRIAL_START, TRIAL_END, 'price_annual') }), { nowMs: NOW })
    const during = await authorityAt(entitlements, NOW + DAY)
    expect(during.active).toBe(true)
    expect(during.entitlement.product_id).toBe('student_basic_annual')
  })

  it('access ends at the trial end if nothing renews it (never open-ended)', async () => {
    const { db, entitlements } = projectionDb()
    await applyStripeSubscription(db, trialingSub(), { nowMs: NOW })
    expect((await authorityAt(entitlements, at(TRIAL_END, -1000))).active).toBe(true)
    expect((await authorityAt(entitlements, at(TRIAL_END, 1000))).active).toBe(false)
  })

  it('the explicit trial_end bounds access even if the reported period is unexpectedly longer', () => {
    const rec = deriveSubscriptionRecord(trialingSub({ items: period(TRIAL_START, FIRST_PERIOD_END) }), { nowMs: NOW })
    expect(rec.current_period_end).toBe(iso(TRIAL_END * 1000))
    // …but once ACTIVE the real paid period is used.
    const paid = deriveSubscriptionRecord(trialingSub({ status: 'active', items: period(TRIAL_END, FIRST_PERIOD_END) }), { nowMs: NOW })
    expect(paid.current_period_end).toBe(iso(FIRST_PERIOD_END * 1000))
  })
})

describe('cancelling during the trial', () => {
  it('cancel-at-period-end (portal) keeps access to the TRIAL END, then none', async () => {
    const { db, entitlements } = projectionDb()
    const result = await applyStripeSubscription(db, trialingSub({ cancel_at_period_end: true }), { nowMs: NOW })
    expect(result.record).toMatchObject({ status: 'trialing', cancel_at_period_end: true })
    expect((await authorityAt(entitlements, NOW + 20 * DAY)).active).toBe(true)
    expect((await authorityAt(entitlements, at(TRIAL_END, 1000))).active).toBe(false)
  })

  it('the terminal customer.subscription.deleted at trial end grants nothing and adds no row', async () => {
    const { db, entitlements } = projectionDb()
    await applyStripeSubscription(db, trialingSub({ cancel_at_period_end: true }), { nowMs: NOW })
    await applyStripeSubscription(db, trialingSub({ status: 'canceled', cancel_at_period_end: true }), { nowMs: at(TRIAL_END, 5000) })
    expect(entitlements.size).toBe(1)
    expect((await authorityAt(entitlements, at(TRIAL_END, 10_000))).active).toBe(false)
  })

  it('an immediate cancellation during the trial revokes access at once', async () => {
    const { db, entitlements, rpcCalls } = projectionDb()
    await applyStripeSubscription(db, trialingSub(), { nowMs: NOW })
    await applyStripeSubscription(db, trialingSub({ status: 'canceled', cancel_at_period_end: false }), { nowMs: NOW + 5 * DAY })
    expect(rpcCalls[1].args.p_active).toBe(false)
    expect((await authorityAt(entitlements, NOW + 5 * DAY + 1000)).active).toBe(false)
  })
})

describe('trial → active: one entitlement, extended — never duplicated', () => {
  it('the same subscription id upserts one row and its window moves to the paid period', async () => {
    const { db, entitlements, rpcCalls } = projectionDb()
    await applyStripeSubscription(db, trialingSub(), { nowMs: NOW, eventCreatedMs: NOW })
    const afterTrial = at(TRIAL_END, 60_000)
    await applyStripeSubscription(db, trialingSub({ status: 'active', items: period(TRIAL_END, FIRST_PERIOD_END) }), { nowMs: afterTrial, eventCreatedMs: afterTrial })
    expect(rpcCalls.map((c) => c.args.p_subscription_id)).toEqual(['sub_trial', 'sub_trial'])
    expect(entitlements.size).toBe(1)
    expect(rpcCalls[1].args).toMatchObject({ p_active: true, p_starts_at: iso(TRIAL_END * 1000), p_expires_at: iso(FIRST_PERIOD_END * 1000) })
    expect((await authorityAt(entitlements, afterTrial + DAY)).active).toBe(true)
    expect((await authorityAt(entitlements, at(FIRST_PERIOD_END, 1000))).active).toBe(false)
  })

  it('a late, older trialing event cannot regress the paid period (webhook ordering)', async () => {
    const stored = { last_event_at: iso(at(TRIAL_END, 60_000)) }
    const rpc = vi.fn()
    const db = {
      from(table) { const q = { select() { return q }, eq() { return q }, maybeSingle: async () => ({ data: table === 'stripe_customers' ? { user_id: USER } : stored, error: null }), upsert: vi.fn() }; return q },
      rpc,
    }
    const result = await applyStripeSubscription(db, trialingSub(), { nowMs: NOW, eventCreatedMs: TRIAL_START * 1000 })
    expect(result).toMatchObject({ applied: false, reason: 'stale' })
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('7–10. 3-day grace for a failed payment, counted from the START of the unpaid period', () => {
  // Policy under test is injected explicitly (STRIPE_GRACE_PERIOD_DAYS=3 is NOT assumed to be set in Production yet).
  beforeEach(() => { vi.stubEnv('STRIPE_GRACE_PERIOD_DAYS', String(GRACE)) })

  const firstChargeFails = trialingSub({ status: 'past_due', items: period(TRIAL_END, FIRST_PERIOD_END) })
  const renewalFails = trialingSub({ status: 'past_due', items: period(FIRST_PERIOD_END, SECOND_PERIOD_END) })

  it('the grace length is explicit config, not implied by the code path', () => {
    const rec = deriveSubscriptionRecord(firstChargeFails, { nowMs: at(TRIAL_END, 3600_000), graceDays: GRACE })
    expect(rec.grace_until).toBe(iso(TRIAL_END * 1000 + 3 * DAY))
    expect(deriveSubscriptionRecord(firstChargeFails, { graceDays: 0 }).grace_until).toBe(null)
    expect(deriveSubscriptionRecord(firstChargeFails, { graceDays: 1 }).grace_until).toBe(iso(TRIAL_END * 1000 + DAY))
  })

  it('7. failed FIRST payment after the trial: usable for at most 3 days, never the unpaid month', async () => {
    const { db, entitlements } = projectionDb()
    await applyStripeSubscription(db, trialingSub(), { nowMs: NOW })
    const hourAfter = at(TRIAL_END, 3600_000)
    const result = await applyStripeSubscription(db, firstChargeFails, { nowMs: hourAfter })
    expect(result.record).toMatchObject({ status: 'past_due', grace_until: iso(TRIAL_END * 1000 + 3 * DAY) })
    expect((await authorityAt(entitlements, at(TRIAL_END, 2 * DAY))).active).toBe(true)
    expect((await authorityAt(entitlements, at(TRIAL_END, 3 * DAY - 1000))).active).toBe(true)
    expect((await authorityAt(entitlements, at(TRIAL_END, 3 * DAY + 1000))).active).toBe(false)
    expect((await authorityAt(entitlements, at(TRIAL_END, 15 * DAY))).active).toBe(false) // mid unpaid month
    expect((await authorityAt(entitlements, at(FIRST_PERIOD_END, -1000))).active).toBe(false)
  })

  it('8. failed RENEWAL: same rule from the start of the unpaid renewal period', async () => {
    const { db, entitlements } = projectionDb()
    await applyStripeSubscription(db, trialingSub({ status: 'active', items: period(TRIAL_END, FIRST_PERIOD_END) }), { nowMs: at(TRIAL_END, 3600_000) })
    const result = await applyStripeSubscription(db, renewalFails, { nowMs: at(FIRST_PERIOD_END, 3600_000) })
    expect(result.record.grace_until).toBe(iso(FIRST_PERIOD_END * 1000 + 3 * DAY))
    expect((await authorityAt(entitlements, at(FIRST_PERIOD_END, 2 * DAY))).active).toBe(true)
    expect((await authorityAt(entitlements, at(FIRST_PERIOD_END, 3 * DAY + 1000))).active).toBe(false)
    expect((await authorityAt(entitlements, at(FIRST_PERIOD_END, 20 * DAY))).active).toBe(false)
  })

  it('9. recovery during grace: payment succeeds → active through the paid period, same single entitlement', async () => {
    const { db, entitlements, rpcCalls } = projectionDb()
    await applyStripeSubscription(db, firstChargeFails, { nowMs: at(TRIAL_END, 3600_000), eventCreatedMs: at(TRIAL_END, 3600_000) })
    const recovered = at(TRIAL_END, DAY)
    const result = await applyStripeSubscription(db, trialingSub({ status: 'active', items: period(TRIAL_END, FIRST_PERIOD_END) }), { nowMs: recovered, eventCreatedMs: recovered })
    expect(result.record).toMatchObject({ status: 'active', grace_until: null }) // the grace marker is cleared
    expect(entitlements.size).toBe(1)
    expect(rpcCalls.every((c) => c.args.p_subscription_id === 'sub_trial')).toBe(true)
    expect((await authorityAt(entitlements, at(TRIAL_END, 4 * DAY))).active).toBe(true) // past the old grace end: normal access
    expect((await authorityAt(entitlements, at(FIRST_PERIOD_END, -1000))).active).toBe(true)
    expect((await authorityAt(entitlements, at(FIRST_PERIOD_END, 1000))).active).toBe(false)
  })

  it('10. grace expires without recovery: nothing grants access, even with no further webhook', async () => {
    const { db, entitlements } = projectionDb()
    await applyStripeSubscription(db, firstChargeFails, { nowMs: at(TRIAL_END, 3600_000) })
    // no later event ever arrives; the stored window alone must close access
    expect((await authorityAt(entitlements, at(TRIAL_END, 3 * DAY + 60_000))).active).toBe(false)
    expect((await authorityAt(entitlements, at(FIRST_PERIOD_END, 30 * DAY))).active).toBe(false)
  })

  it.each([
    ['unpaid', { status: 'unpaid' }],
    ['incomplete', { status: 'incomplete' }],
    ['incomplete_expired', { status: 'incomplete_expired' }],
    ['paused', { status: 'paused' }],
    ['canceled (immediate)', { status: 'canceled', cancel_at_period_end: false }],
  ])('%s while still inside the grace window → revoked at once (never beyond the paid/grace boundary)', async (_label, over) => {
    const { db, entitlements, rpcCalls } = projectionDb()
    await applyStripeSubscription(db, firstChargeFails, { nowMs: at(TRIAL_END, 3600_000) })
    const t = at(TRIAL_END, DAY)
    await applyStripeSubscription(db, trialingSub({ ...over, items: period(TRIAL_END, FIRST_PERIOD_END) }), { nowMs: t })
    expect(rpcCalls[1].args.p_active).toBe(false)
    expect((await authorityAt(entitlements, t + 1000)).active).toBe(false)
  })

  it('a webhook delivered AFTER the grace window opens no access (the clock is the unpaid period, not delivery time)', async () => {
    const { db, entitlements } = projectionDb()
    await applyStripeSubscription(db, firstChargeFails, { nowMs: at(TRIAL_END, 5 * DAY) })
    expect((await authorityAt(entitlements, at(TRIAL_END, 5 * DAY + 1000))).active).toBe(false)
  })

  it('18. grace comes from server config only: a hostile subscription payload cannot lengthen it', () => {
    const hostile = trialingSub({ status: 'past_due', items: period(TRIAL_END, FIRST_PERIOD_END), grace_days: 365, grace_until: '2099-01-01T00:00:00Z', metadata: { user_id: USER, grace_days: '365' } })
    const rec = deriveSubscriptionRecord(hostile, { nowMs: at(TRIAL_END, 3600_000) })
    expect(rec.grace_until).toBe(iso(TRIAL_END * 1000 + 3 * DAY))
  })
})

describe('11–14. the subscription status payload tells a client the truth (additive fields only)', () => {
  /** Rows exactly as applyStripeSubscription stores them, served through the real buildSubscriptionStatus. */
  async function statusFor(sub, nowMs, { graceDays = GRACE } = {}) {
    const rec = deriveSubscriptionRecord(sub, { nowMs, graceDays })
    const row = { plan_code: rec.plan_code, status: rec.status, current_period_start: rec.current_period_start, current_period_end: rec.current_period_end, cancel_at_period_end: rec.cancel_at_period_end, grace_until: rec.grace_until, updated_at: iso(nowMs) }
    return buildSubscriptionStatus(fakeDb({ subscriptions: [{ user_id: USER, provider: 'stripe', ...row }], stripe_customers: [{ user_id: USER, stripe_customer_id: 'cus_123' }] }), USER, nowMs)
  }
  const LEGACY_KEYS = ['provider', 'active', 'planCode', 'billingInterval', 'status', 'currentPeriodEnd', 'cancelAtPeriodEnd', 'graceUntil', 'manageable']
  const NEW_KEYS = ['trialing', 'trialEnd', 'inGrace']

  it('11. a trialing subscription stays `trialing`, with its end date, and is not presented as a paid renewal', async () => {
    const s = await statusFor(trialingSub(), NOW + 3 * DAY)
    expect(s).toMatchObject({ provider: 'stripe', active: true, status: 'trialing', trialing: true, trialEnd: iso(TRIAL_END * 1000), currentPeriodEnd: iso(TRIAL_END * 1000), cancelAtPeriodEnd: false, inGrace: false, planCode: 'student_basic_monthly', billingInterval: 'month', manageable: true })
  })

  it('11b. annual trial: same state, annual cadence', async () => {
    const s = await statusFor(trialingSub({ items: period(TRIAL_START, TRIAL_END, 'price_annual') }), NOW + DAY)
    expect(s).toMatchObject({ status: 'trialing', trialing: true, planCode: 'student_basic_annual', billingInterval: 'year', trialEnd: iso(TRIAL_END * 1000) })
  })

  it('12. cancelled during the trial it is STILL identifiable as a trial (status trialing + cancelAtPeriodEnd)', async () => {
    const s = await statusFor(trialingSub({ cancel_at_period_end: true }), NOW + 3 * DAY)
    expect(s).toMatchObject({ active: true, status: 'trialing', trialing: true, cancelAtPeriodEnd: true, trialEnd: iso(TRIAL_END * 1000), currentPeriodEnd: iso(TRIAL_END * 1000) })
  })

  it('a trial that has run out is no longer reported as trialing', async () => {
    const s = await statusFor(trialingSub({ cancel_at_period_end: true }), at(TRIAL_END, DAY))
    expect(s).toMatchObject({ active: false, trialing: false, trialEnd: null })
  })

  it('13. an active paid subscription is unchanged (and is not a trial)', async () => {
    const s = await statusFor(trialingSub({ status: 'active', items: period(TRIAL_END, FIRST_PERIOD_END) }), at(TRIAL_END, 5 * DAY))
    expect(s).toMatchObject({ provider: 'stripe', active: true, status: 'active', currentPeriodEnd: iso(FIRST_PERIOD_END * 1000), cancelAtPeriodEnd: false, graceUntil: null, trialing: false, trialEnd: null, inGrace: false })
  })

  it('13b. an active subscription cancelled for period end keeps its legacy shape', async () => {
    const s = await statusFor(trialingSub({ status: 'active', cancel_at_period_end: true, items: period(TRIAL_END, FIRST_PERIOD_END) }), at(TRIAL_END, 5 * DAY))
    expect(s).toMatchObject({ active: true, status: 'active', cancelAtPeriodEnd: true, trialing: false })
  })

  it('14. past_due inside the 3-day grace → inGrace with the grace date', async () => {
    const s = await statusFor(trialingSub({ status: 'past_due', items: period(TRIAL_END, FIRST_PERIOD_END) }), at(TRIAL_END, 2 * DAY))
    expect(s).toMatchObject({ status: 'past_due', active: true, inGrace: true, graceUntil: iso(TRIAL_END * 1000 + 3 * DAY), trialing: false })
  })

  it('14b. past_due after the grace window → no access, not in grace', async () => {
    const s = await statusFor(trialingSub({ status: 'past_due', items: period(TRIAL_END, FIRST_PERIOD_END) }), at(TRIAL_END, 4 * DAY))
    expect(s).toMatchObject({ status: 'past_due', active: false, inGrace: false, graceUntil: iso(TRIAL_END * 1000 + 3 * DAY) })
  })

  it('14c. past_due with no grace configured → no access, no grace date', async () => {
    const s = await statusFor(trialingSub({ status: 'past_due', items: period(TRIAL_END, FIRST_PERIOD_END) }), at(TRIAL_END, 3600_000), { graceDays: 0 })
    expect(s).toMatchObject({ status: 'past_due', active: false, inGrace: false, graceUntil: null })
  })

  it('every payload keeps ALL legacy keys and adds only the three new ones (no Stripe ids / blobs)', async () => {
    for (const sub of [trialingSub(), trialingSub({ status: 'active', items: period(TRIAL_END, FIRST_PERIOD_END) }), trialingSub({ status: 'past_due', items: period(TRIAL_END, FIRST_PERIOD_END) })]) {
      const s = await statusFor(sub, at(TRIAL_END, 3600_000))
      expect(Object.keys(s).sort()).toEqual([...LEGACY_KEYS, ...NEW_KEYS].sort())
      expect(JSON.stringify(s)).not.toMatch(/sub_|cus_|price_|sk_|whsec_/)
    }
  })

  it('an account with no subscription reports the same additive fields (none)', async () => {
    const s = await buildSubscriptionStatus(fakeDb({}), USER, NOW)
    expect(s).toMatchObject({ status: 'none', active: false, trialing: false, trialEnd: null, inGrace: false, provider: null })
    expect(Object.keys(s).sort()).toEqual([...LEGACY_KEYS, ...NEW_KEYS].sort())
  })
})
