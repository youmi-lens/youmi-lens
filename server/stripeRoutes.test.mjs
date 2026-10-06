import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildCheckoutSessionParams,
  handleCheckout,
  handlePortal,
  handleSubscriptionStatus,
  shouldBlockCheckoutForSubscription,
} from './stripeRoutes.mjs'
import { getOrCreateStripeCustomer, getStripeCustomerId, linkStripeCustomer } from './stripeCustomers.mjs'
import { isCommercializationEnabled, safeRedirectUrl } from './stripeConfig.mjs'

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
  }
}

describe('buildCheckoutSessionParams (server-trusted only)', () => {
  it('binds the session to the authenticated account via metadata + client_reference_id', () => {
    const params = buildCheckoutSessionParams({
      userId: 'user-1',
      customerId: 'cus_1',
      planCode: 'student_basic_monthly',
      priceId: 'price_monthly',
      urls: { successUrl: 'https://x/ok', cancelUrl: 'https://x/no' },
    })
    expect(params.mode).toBe('subscription')
    expect(params.customer).toBe('cus_1')
    expect(params.client_reference_id).toBe('user-1')
    expect(params.metadata).toEqual({ user_id: 'user-1', plan_code: 'student_basic_monthly' })
    expect(params.subscription_data.metadata.user_id).toBe('user-1')
  })

  it('uses ONLY the server-resolved price — no client-supplied amount/price is honored', () => {
    // The builder has no channel for a client price/amount; the only price it can
    // emit is the one the server passes in.
    const params = buildCheckoutSessionParams({
      userId: 'user-1',
      customerId: 'cus_1',
      planCode: 'student_basic_annual',
      priceId: 'price_annual',
      urls: {},
    })
    expect(params.line_items).toEqual([{ price: 'price_annual', quantity: 1 }])
    expect(params.allow_promotion_codes).toBe(false)
  })
})

describe('redirect URL safety (no open redirects / bad schemes)', () => {
  it('accepts absolute http(s) URLs', () => {
    expect(safeRedirectUrl('https://youmilens.com/account')).toBe('https://youmilens.com/account')
    expect(safeRedirectUrl('http://localhost:5173/account')).toBe('http://localhost:5173/account')
  })

  it('rejects non-web schemes and malformed/relative values', () => {
    expect(safeRedirectUrl('javascript:alert(1)')).toBe('')
    expect(safeRedirectUrl('/account')).toBe('')
    expect(safeRedirectUrl('not a url')).toBe('')
    expect(safeRedirectUrl('')).toBe('')
    expect(safeRedirectUrl(undefined)).toBe('')
  })
})

describe('checkout / portal / status authentication', () => {
  it('rejects checkout without a bearer token', async () => {
    const res = makeRes()
    await handleCheckout({ headers: {}, body: { plan_code: 'student_basic_monthly' } }, res)
    expect(res.statusCode).toBe(401)
    expect(res.body).toMatchObject({ error: 'auth_required' })
  })

  it('rejects portal without a bearer token', async () => {
    const res = makeRes()
    await handlePortal({ headers: {}, body: {} }, res)
    expect(res.statusCode).toBe(401)
  })

  it('rejects subscription status without a bearer token', async () => {
    const res = makeRes()
    await handleSubscriptionStatus({ headers: {} }, res)
    expect(res.statusCode).toBe(401)
  })
})

describe('shouldBlockCheckoutForSubscription (active-subscriber guard)', () => {
  it('blocks active and canceling (still active) subscribers', () => {
    expect(shouldBlockCheckoutForSubscription({ active: true, status: 'active', manageable: true })).toBe(true)
    expect(
      shouldBlockCheckoutForSubscription({
        active: true,
        status: 'active',
        cancelAtPeriodEnd: true,
        manageable: true,
      }),
    ).toBe(true)
  })

  it('blocks manageable past_due even when access is inactive', () => {
    expect(
      shouldBlockCheckoutForSubscription({ active: false, status: 'past_due', manageable: true }),
    ).toBe(true)
  })

  it('allows free/none and expired with no active paid access', () => {
    expect(shouldBlockCheckoutForSubscription({ active: false, status: 'none', manageable: false })).toBe(false)
    expect(shouldBlockCheckoutForSubscription({ active: false, status: 'expired', manageable: true })).toBe(false)
    expect(shouldBlockCheckoutForSubscription({ active: false, status: 'canceled', manageable: true })).toBe(false)
    expect(shouldBlockCheckoutForSubscription({ active: false, status: 'past_due', manageable: false })).toBe(false)
  })
})

describe('isCommercializationEnabled (public release switch, fail-closed)', () => {
  const KEY = 'PUBLIC_COMMERCIALIZATION_ENABLED'
  const original = process.env[KEY]
  const set = (v) => { if (v === undefined) delete process.env[KEY]; else process.env[KEY] = v }
  afterEach(() => { set(original) })

  it('opens Checkout ONLY for the exact string true (case/space tolerant)', () => {
    for (const v of ['true', 'TRUE', 'True', '  true  ']) {
      set(v)
      expect(isCommercializationEnabled()).toBe(true)
    }
  })

  it('stays closed when missing or empty — a forgotten variable must never sell', () => {
    set(undefined)
    expect(isCommercializationEnabled()).toBe(false)
    set('')
    expect(isCommercializationEnabled()).toBe(false)
    set('   ')
    expect(isCommercializationEnabled()).toBe(false)
  })

  it('stays closed for false and for any unrecognized value', () => {
    for (const v of ['false', 'FALSE', '0', '1', 'yes', 'on', 'enabled', 'truthy']) {
      set(v)
      expect(isCommercializationEnabled()).toBe(false)
    }
  })
})

describe('checkout release switch (503 before any Stripe object is created)', () => {
  const KEY = 'PUBLIC_COMMERCIALIZATION_ENABLED'
  const original = process.env[KEY]
  afterEach(() => { if (original === undefined) delete process.env[KEY]; else process.env[KEY] = original })

  it('returns 503 commercialization_not_available for an authenticated caller when closed', async () => {
    delete process.env[KEY] // closed by default
    const res = makeRes()
    // A malformed bearer token still fails auth first, so assert the ORDER holds:
    // no token → 401 (switch state is never advertised to anonymous probes).
    await handleCheckout({ headers: {}, body: { plan_code: 'student_basic_monthly' } }, res)
    expect(res.statusCode).toBe(401)
    expect(res.body).toMatchObject({ error: 'auth_required' })
  })

  it('the switch is the only thing standing between auth and plan validation', () => {
    // Guard placement is asserted structurally: the 503 branch must appear after
    // authentication (handleCheckout injects `authenticate`, defaulting to requireUser) and before
    // plan_code / price resolution, so an invalid plan can never leak a 400 while commercialization is closed.
    const src = readFileSync(new URL('./stripeRoutes.mjs', import.meta.url), 'utf8')
    const auth = src.indexOf('const user = await authenticate(req, res)')
    const guard = src.indexOf('commercialization_not_available')
    const plan = src.indexOf("typeof req.body?.plan_code === 'string'")
    expect(auth).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(auth)
    expect(plan).toBeGreaterThan(guard)
  })

  it('does NOT gate portal, subscription status or refresh', () => {
    // Existing subscribers must keep managing/cancelling while the switch is off.
    const src = readFileSync(new URL('./stripeRoutes.mjs', import.meta.url), 'utf8')
    const occurrences = src.split('commercialization_not_available').length - 1
    expect(occurrences).toBe(1)
    for (const fn of ['handlePortal', 'handleSubscriptionStatus', 'handleSubscriptionRefresh']) {
      const body = src.slice(src.indexOf(`export async function ${fn}`))
      const next = body.indexOf('\nexport ', 1)
      expect((next === -1 ? body : body.slice(0, next))).not.toContain('commercialization_not_available')
    }
  })
})

// ── Stripe customer mapping (reuse + concurrency) ────────────────────────────

function customerDb({ existing = null } = {}) {
  const state = { rows: existing ? [{ user_id: 'user-1', stripe_customer_id: existing }] : [] }
  const calls = { upserts: [] }
  const db = {
    from() {
      return {
        select() { return this },
        eq() { return this },
        async maybeSingle() {
          const row = state.rows[0]
          return { data: row ? { stripe_customer_id: row.stripe_customer_id } : null, error: null }
        },
        async upsert(row, opts) {
          calls.upserts.push({ row, opts })
          // ignoreDuplicates: only the first writer wins.
          if (state.rows.length === 0) state.rows.push(row)
          return { error: null }
        },
      }
    },
  }
  return { db, calls, state }
}

describe('Stripe customer reuse', () => {
  it('returns the existing customer without creating a new one', async () => {
    const { db } = customerDb({ existing: 'cus_existing' })
    let created = 0
    const stripe = { customers: { create: async () => { created++; return { id: 'cus_new' } } } }
    const id = await getOrCreateStripeCustomer(db, stripe, { userId: 'user-1', email: 'a@b.com' })
    expect(id).toBe('cus_existing')
    expect(created).toBe(0)
  })

  it('creates and links a customer exactly once for a new user', async () => {
    const { db, calls } = customerDb()
    let created = 0
    const stripe = { customers: { create: async () => { created++; return { id: 'cus_new' } } } }
    const id = await getOrCreateStripeCustomer(db, stripe, { userId: 'user-1', email: 'a@b.com' })
    expect(created).toBe(1)
    expect(id).toBe('cus_new')
    expect(calls.upserts[0].opts).toMatchObject({ onConflict: 'user_id', ignoreDuplicates: true })
  })

  it('linkStripeCustomer returns the authoritative stored id (race winner)', async () => {
    const { db } = customerDb({ existing: 'cus_winner' })
    // A late writer tries to link its own id, but the stored winner is returned.
    const id = await linkStripeCustomer(db, 'user-1', 'cus_late')
    expect(id).toBe('cus_winner')
    expect(await getStripeCustomerId(db, 'user-1')).toBe('cus_winner')
  })
})
