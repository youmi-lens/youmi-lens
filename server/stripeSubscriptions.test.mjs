// Configure server-trusted price mapping BEFORE importing the modules under test
// (config reads env lazily, but set here for clarity/determinism).
process.env.STRIPE_PRICE_STUDENT_BASIC_MONTHLY = 'price_monthly'
process.env.STRIPE_PRICE_STUDENT_BASIC_ANNUAL = 'price_annual'
// Intentionally do NOT set STRIPE_GRACE_PERIOD_DAYS: the default (0, no grace)
// is the baseline; grace tests pass graceDays explicitly.

import { describe, expect, it } from 'vitest'
import { PLAN_LIMITS } from './betaGate.mjs'
import {
  isAllowedPlanCode,
  planTypeForPlanCode,
  billingIntervalForPlanCode,
  planCodeForPriceId,
  priceIdForPlanCode,
  getGracePeriodDays,
} from './stripeConfig.mjs'
import {
  mapStripeStatus,
  deriveSubscriptionRecord,
  entitlementProjection,
  resolveUserIdForSubscription,
  applyStripeSubscription,
  buildSubscriptionStatus,
} from './stripeSubscriptions.mjs'

const START = Math.floor(Date.parse('2026-06-11T00:00:00Z') / 1000)
const END = Math.floor(Date.parse('2026-07-11T00:00:00Z') / 1000)
const NOW = Date.parse('2026-06-20T00:00:00Z')
const DAY = 24 * 60 * 60 * 1000

function stripeSub(overrides = {}) {
  return {
    id: 'sub_123',
    status: 'active',
    customer: 'cus_123',
    livemode: false,
    cancel_at_period_end: false,
    current_period_start: START,
    current_period_end: END,
    items: { data: [{ price: { id: 'price_monthly' } }] },
    metadata: { user_id: 'user-1' },
    ...overrides,
  }
}

describe('Stripe status mapping', () => {
  it('maps Stripe statuses into the canonical 5-state set', () => {
    expect(mapStripeStatus('active')).toBe('active')
    expect(mapStripeStatus('trialing')).toBe('trialing')
    expect(mapStripeStatus('past_due')).toBe('past_due')
    expect(mapStripeStatus('canceled')).toBe('canceled')
    expect(mapStripeStatus('unpaid')).toBe('expired')
    expect(mapStripeStatus('incomplete')).toBe('expired')
    expect(mapStripeStatus('incomplete_expired')).toBe('expired')
    expect(mapStripeStatus('paused')).toBe('expired')
    expect(mapStripeStatus('something_new')).toBe('expired')
  })
})

describe('deriveSubscriptionRecord', () => {
  it('derives a monthly record with correct plan_code and interval', () => {
    const rec = deriveSubscriptionRecord(stripeSub(), { nowMs: NOW })
    expect(rec).toMatchObject({
      provider: 'stripe',
      provider_subscription_id: 'sub_123',
      plan_code: 'student_basic_monthly',
      provider_price_id: 'price_monthly',
      status: 'active',
      cancel_at_period_end: false,
      grace_until: null,
      billing_interval: 'month',
    })
    expect(rec.current_period_end).toBe(new Date(END * 1000).toISOString())
  })

  it('derives an annual record from the annual price id', () => {
    const rec = deriveSubscriptionRecord(
      stripeSub({ items: { data: [{ price: { id: 'price_annual' } }] } }),
      { nowMs: NOW },
    )
    expect(rec.plan_code).toBe('student_basic_annual')
    expect(rec.billing_interval).toBe('year')
  })

  it('reads the billing period from the subscription ITEM when top-level fields are absent', () => {
    // Newer Stripe API versions (e.g. 2026-06-24.dahlia, used by webhook payloads)
    // removed current_period_start/end from the Subscription object; they now live
    // on the item. The record must still compute the correct window (regression:
    // otherwise the entitlement projects as inactive/revoked with a past expiry).
    const itemOnly = {
      id: 'sub_item_only',
      status: 'active',
      customer: 'cus_123',
      cancel_at_period_end: false,
      // NO top-level current_period_start / current_period_end
      items: { data: [{ price: { id: 'price_annual' }, current_period_start: START, current_period_end: END }] },
      metadata: { user_id: 'user-1' },
    }
    const rec = deriveSubscriptionRecord(itemOnly, { nowMs: NOW })
    expect(rec.current_period_start).toBe(new Date(START * 1000).toISOString())
    expect(rec.current_period_end).toBe(new Date(END * 1000).toISOString())
    // And it projects to an ACTIVE grant (the bug produced active:false / revoked).
    expect(entitlementProjection(rec, NOW).active).toBe(true)
    expect(entitlementProjection(rec, NOW).expiresAt).toBe(new Date(END * 1000).toISOString())
  })

  it('sets grace_until from the PAID-THROUGH boundary (start of the unpaid period) when a grace window is configured', () => {
    const rec = deriveSubscriptionRecord(stripeSub({ status: 'past_due' }), { nowMs: NOW, graceDays: 3 })
    expect(rec.status).toBe('past_due')
    // A past_due subscription's current period is the NEW, unpaid one (Stripe starts it when the renewal /
    // post-trial invoice is created), so grace counts from its start = the end of what was paid.
    expect(rec.grace_until).toBe(new Date(START * 1000 + 3 * DAY).toISOString())
  })

  it('applies NO grace by default (unapproved policy → 0 days): no grace_until, no access while past_due', () => {
    const saved = process.env.STRIPE_GRACE_PERIOD_DAYS
    delete process.env.STRIPE_GRACE_PERIOD_DAYS
    try {
      expect(getGracePeriodDays()).toBe(0)
      const rec = deriveSubscriptionRecord(stripeSub({ status: 'past_due' }), { nowMs: NOW })
      expect(rec.grace_until).toBe(null)
      // NOW is inside the unpaid period; with no grace it must not grant access (a failed first charge after
      // a trial, or a failed renewal, must not hand out a free month).
      expect(entitlementProjection(rec, NOW).active).toBe(false)
      expect(entitlementProjection(rec, START * 1000 + 1).active).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.STRIPE_GRACE_PERIOD_DAYS
      else process.env.STRIPE_GRACE_PERIOD_DAYS = saved
    }
  })
})

describe('entitlementProjection', () => {
  const rec = (o) => deriveSubscriptionRecord(stripeSub(o), { nowMs: NOW })

  it('active grants access until current_period_end', () => {
    const p = entitlementProjection(rec(), NOW)
    expect(p.active).toBe(true)
    expect(p.expiresAt).toBe(new Date(END * 1000).toISOString())
  })

  it('trialing grants access until current_period_end', () => {
    expect(entitlementProjection(rec({ status: 'trialing' }), NOW).active).toBe(true)
  })

  it('cancel_at_period_end (still active) keeps access until period end', () => {
    const p = entitlementProjection(rec({ status: 'active', cancel_at_period_end: true }), NOW)
    expect(p.active).toBe(true)
    expect(p.expiresAt).toBe(new Date(END * 1000).toISOString())
  })

  it('past_due preserves access only within an explicitly configured grace_until', () => {
    const graced = deriveSubscriptionRecord(stripeSub({ status: 'past_due' }), { nowMs: NOW, graceDays: 3 })
    const within = entitlementProjection(graced, Date.parse('2026-06-12T00:00:00Z'))
    expect(within.active).toBe(true) // grace = period start Jun 11 + 3d = Jun 14
    const after = entitlementProjection(graced, Date.parse('2026-06-20T00:00:00Z'))
    expect(after.active).toBe(false)
  })

  it('immediate cancellation grants no access', () => {
    const p = entitlementProjection(rec({ status: 'canceled', cancel_at_period_end: false }), NOW)
    expect(p.active).toBe(false)
  })

  it('canceled-at-period-end keeps access until period end, then expires', () => {
    const before = entitlementProjection(rec({ status: 'canceled', cancel_at_period_end: true }), NOW)
    expect(before.active).toBe(true)
    const after = entitlementProjection(
      rec({ status: 'canceled', cancel_at_period_end: true }),
      Date.parse('2026-07-12T00:00:00Z'),
    )
    expect(after.active).toBe(false)
  })

  it('expired subscription no longer resolves to access', () => {
    expect(entitlementProjection(rec({ status: 'unpaid' }), NOW).active).toBe(false)
  })

  it('an elapsed period is inactive at read time (no cron needed)', () => {
    const p = entitlementProjection(rec(), Date.parse('2026-08-01T00:00:00Z'))
    expect(p.active).toBe(false)
  })
})

describe('plan tier invariants', () => {
  it('monthly and annual both map to the same student_pass tier', () => {
    expect(isAllowedPlanCode('student_basic_monthly')).toBe(true)
    expect(isAllowedPlanCode('student_basic_annual')).toBe(true)
    expect(planTypeForPlanCode('student_basic_monthly')).toBe('student_pass')
    expect(planTypeForPlanCode('student_basic_annual')).toBe('student_pass')
    expect(billingIntervalForPlanCode('student_basic_monthly')).toBe('month')
    expect(billingIntervalForPlanCode('student_basic_annual')).toBe('year')
  })

  it('rejects unknown plan codes', () => {
    expect(isAllowedPlanCode('student_pro')).toBe(false)
    expect(planCodeForPriceId('price_unknown')).toBe(null)
  })

  it('does not change the Student Basic quota values (600 / 6 / 10)', () => {
    expect(PLAN_LIMITS.student_pass).toMatchObject({
      monthly_minutes_limit: 600,
      max_recordings_per_day: 6,
      max_processing_jobs_per_day: 10,
    })
  })
})

// ── DB apply (injected fake service-role client) ─────────────────────────────

function fakeDb({ customerUser = null, existingSub = null } = {}) {
  const calls = { upserts: [], rpc: [] }
  const db = {
    from(table) {
      return {
        _table: table,
        select() { return this },
        eq() { return this },
        async maybeSingle() {
          if (table === 'stripe_customers' && customerUser) return { data: { user_id: customerUser }, error: null }
          if (table === 'subscriptions') return { data: existingSub, error: null }
          return { data: null, error: null }
        },
        async upsert(row, opts) { calls.upserts.push({ table, row, opts }); return { error: null } },
      }
    },
    async rpc(fn, args) { calls.rpc.push({ fn, args }); return { error: null } },
  }
  return { db, calls }
}

describe('resolveUserIdForSubscription', () => {
  it('does not trust metadata.user_id when no customer mapping exists', async () => {
    const { db } = fakeDb()
    await expect(resolveUserIdForSubscription(db, stripeSub())).resolves.toBe(null)
  })

  it('resolves via the server customer mapping by customer id', async () => {
    const { db } = fakeDb({ customerUser: 'user-42' })
    const sub = stripeSub({ metadata: {} })
    await expect(resolveUserIdForSubscription(db, sub)).resolves.toBe('user-42')
  })

  it('prefers the server customer mapping over webhook metadata when they disagree', async () => {
    // Defense: never trust metadata over our own server-created mapping.
    const { db } = fakeDb({ customerUser: 'user-B' })
    const sub = stripeSub({ metadata: { user_id: 'user-A' } })
    await expect(resolveUserIdForSubscription(db, sub)).resolves.toBe('user-B')
  })

  it('returns null when no user can be resolved', async () => {
    const { db } = fakeDb()
    await expect(resolveUserIdForSubscription(db, stripeSub({ metadata: {}, customer: 'cus_x' }))).resolves.toBe(null)
  })
})

describe('out-of-order webhook protection', () => {
  it('skips a stale (older) event without projecting an entitlement', async () => {
    const { db, calls } = fakeDb({ customerUser: 'user-1', existingSub: { last_event_at: '2026-06-20T00:00:00.000Z' } })
    const result = await applyStripeSubscription(db, stripeSub(), {
      nowMs: NOW,
      eventCreatedMs: Date.parse('2026-06-19T00:00:00Z'), // older than stored
    })
    expect(result).toMatchObject({ applied: false, reason: 'stale' })
    expect(calls.rpc).toHaveLength(0)
    expect(calls.upserts).toHaveLength(0)
  })

  it('applies a newer event and advances the ordering marker', async () => {
    const { db, calls } = fakeDb({ customerUser: 'user-1', existingSub: { last_event_at: '2026-06-20T00:00:00.000Z' } })
    const result = await applyStripeSubscription(db, stripeSub(), {
      nowMs: NOW,
      eventCreatedMs: Date.parse('2026-06-21T00:00:00Z'), // newer than stored
    })
    expect(result.applied).toBe(true)
    expect(calls.upserts[0].row.last_event_at).toBe(new Date(Date.parse('2026-06-21T00:00:00Z')).toISOString())
    expect(calls.rpc[0].fn).toBe('project_stripe_entitlement')
  })
})

describe('dormant / placeholder product safety', () => {
  it('never returns a placeholder price id as sellable', () => {
    const saved = process.env.STRIPE_PRICE_STUDENT_BASIC_MONTHLY
    process.env.STRIPE_PRICE_STUDENT_BASIC_MONTHLY = 'price_REPLACE_ME_MONTHLY'
    try {
      expect(priceIdForPlanCode('student_basic_monthly')).toBe('')
    } finally {
      process.env.STRIPE_PRICE_STUDENT_BASIC_MONTHLY = saved
    }
  })

  it('returns a real configured price id', () => {
    expect(priceIdForPlanCode('student_basic_monthly')).toBe('price_monthly')
  })
})

describe('applyStripeSubscription', () => {
  it('creates an active entitlement projection for a new subscription', async () => {
    const { db, calls } = fakeDb({ customerUser: 'user-1' })
    const result = await applyStripeSubscription(db, stripeSub(), { nowMs: NOW })
    expect(result.applied).toBe(true)
    expect(calls.upserts[0]).toMatchObject({ table: 'subscriptions', opts: { onConflict: 'provider,provider_subscription_id' } })
    expect(calls.rpc[0].fn).toBe('project_stripe_entitlement')
    expect(calls.rpc[0].args).toMatchObject({
      p_user_id: 'user-1',
      p_subscription_id: 'sub_123',
      p_product_id: 'student_basic_monthly',
      p_active: true,
    })
  })

  it('is idempotent by subscription id (renewal updates the same row, active)', async () => {
    const { db, calls } = fakeDb({ customerUser: 'user-1' })
    await applyStripeSubscription(db, stripeSub(), { nowMs: NOW })
    // renewal: same id, later period
    const renewed = stripeSub({ current_period_start: END, current_period_end: END + 30 * 86400 })
    await applyStripeSubscription(db, renewed, { nowMs: Date.parse('2026-07-11T01:00:00Z') })
    // Both used the SAME provider_subscription_id → one canonical row, one grant key.
    expect(calls.rpc.every((c) => c.args.p_subscription_id === 'sub_123')).toBe(true)
    expect(calls.rpc[1].args.p_active).toBe(true)
  })

  it('immediate cancellation projects an inactive (revoked) entitlement', async () => {
    const { db, calls } = fakeDb({ customerUser: 'user-1' })
    await applyStripeSubscription(db, stripeSub({ status: 'canceled', cancel_at_period_end: false }), { nowMs: NOW })
    expect(calls.rpc[0].args.p_active).toBe(false)
  })

  it('skips when no user can be resolved', async () => {
    const { db, calls } = fakeDb()
    const result = await applyStripeSubscription(db, stripeSub({ metadata: {}, customer: 'cus_none' }), { nowMs: NOW })
    expect(result.applied).toBe(false)
    expect(calls.rpc).toHaveLength(0)
  })

  it('rejects an unknown / foreign Stripe price explicitly, before any database write', async () => {
    const { db, calls } = fakeDb({ customerUser: 'user-1' })
    const foreign = stripeSub({ items: { data: [{ price: { id: 'price_foreign' } }] } })
    await expect(applyStripeSubscription(db, foreign, { nowMs: NOW })).rejects.toThrow('unknown_stripe_price: price_foreign')
    expect(calls.upserts).toHaveLength(0)
    expect(calls.rpc).toHaveLength(0)
  })

  it('rejects a subscription with no price item the same way (no plan to grant)', async () => {
    const { db, calls } = fakeDb({ customerUser: 'user-1' })
    await expect(applyStripeSubscription(db, stripeSub({ items: { data: [] } }), { nowMs: NOW })).rejects.toThrow('unknown_stripe_price: none')
    expect(calls.upserts).toHaveLength(0)
    expect(calls.rpc).toHaveLength(0)
  })

  it('a foreign price for an UNMAPPED customer is still the quiet no_user skip (unchanged)', async () => {
    const { db } = fakeDb()
    const foreign = stripeSub({ metadata: {}, customer: 'cus_none', items: { data: [{ price: { id: 'price_foreign' } }] } })
    await expect(applyStripeSubscription(db, foreign, { nowMs: NOW })).resolves.toMatchObject({ applied: false, reason: 'no_user' })
  })

  it('both configured prices still project normally', async () => {
    for (const [price, product] of [['price_monthly', 'student_basic_monthly'], ['price_annual', 'student_basic_annual']]) {
      const { db, calls } = fakeDb({ customerUser: 'user-1' })
      await applyStripeSubscription(db, stripeSub({ items: { data: [{ price: { id: price } }] } }), { nowMs: NOW })
      expect(calls.rpc[0].args.p_product_id).toBe(product)
    }
  })
})

describe('buildSubscriptionStatus', () => {
  function statusDb(rows, hasCustomer = true) {
    return {
      from(table) {
        return {
          select() { return this },
          eq() { return this },
          order() { return this },
          async limit() { return { data: table === 'subscriptions' ? rows : null, error: null } },
          async maybeSingle() {
            return { data: table === 'stripe_customers' && hasCustomer ? { user_id: 'user-1' } : null, error: null }
          },
        }
      },
    }
  }

  it('reports no subscription cleanly', async () => {
    const status = await buildSubscriptionStatus(statusDb([], false), 'user-1', NOW)
    expect(status).toMatchObject({ provider: null, active: false, status: 'none', manageable: false })
  })

  it('reports a single active subscription without multiplying anything', async () => {
    const rows = [
      { plan_code: 'student_basic_monthly', status: 'active', current_period_start: new Date(START * 1000).toISOString(), current_period_end: new Date(END * 1000).toISOString(), cancel_at_period_end: false, grace_until: null },
      { plan_code: 'student_basic_monthly', status: 'active', current_period_start: new Date(START * 1000).toISOString(), current_period_end: new Date(END * 1000).toISOString(), cancel_at_period_end: false, grace_until: null },
    ]
    const status = await buildSubscriptionStatus(statusDb(rows), 'user-1', NOW)
    // Two active records still resolve to ONE active student_pass status.
    expect(status).toMatchObject({ provider: 'stripe', active: true, status: 'active', billingInterval: 'month', manageable: true })
  })

  it('does not expose Stripe ids or secrets', async () => {
    const rows = [{ plan_code: 'student_basic_annual', status: 'active', current_period_start: new Date(START * 1000).toISOString(), current_period_end: new Date(END * 1000).toISOString(), cancel_at_period_end: true, grace_until: null }]
    const status = await buildSubscriptionStatus(statusDb(rows), 'user-1', NOW)
    const json = JSON.stringify(status)
    expect(json).not.toMatch(/cus_/)
    expect(json).not.toMatch(/sub_/)
    expect(json).not.toMatch(/price_/)
    expect(status.cancelAtPeriodEnd).toBe(true)
  })
})
