process.env.STRIPE_PRICE_STUDENT_BASIC_MONTHLY = 'price_monthly'
process.env.STRIPE_PRICE_STUDENT_BASIC_ANNUAL = 'price_annual'

import { describe, expect, it } from 'vitest'
import {
  reserveStripeEvent,
  dispatchStripeEvent,
  handleStripeWebhook,
} from './stripeWebhook.mjs'

const START = Math.floor(Date.parse('2026-06-11T00:00:00Z') / 1000)
const END = Math.floor(Date.parse('2026-07-11T00:00:00Z') / 1000)

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

/** Thenable fake Supabase client covering the webhook code paths. */
function makeDb(config = {}) {
  const calls = { insert: [], update: [], upsert: [], rpc: [], billingEvents: [] }
  function chainFor(table) {
    const chain = {
      select() { return chain },
      eq() { return chain },
      order() { return chain },
      limit() { return chain },
      insert(row) {
        calls.insert.push({ table, row })
        if (table === 'billing_events') calls.billingEvents.push(row)
        const error = table === 'stripe_webhook_events' ? (config.reserveInsertError ?? null) : null
        return Promise.resolve({ error })
      },
      update(row) { calls.update.push({ table, row }); return chain },
      upsert(row, opts) { calls.upsert.push({ table, row, opts }); return Promise.resolve({ error: null }) },
      maybeSingle() {
        if (table === 'stripe_webhook_events') return Promise.resolve({ data: config.webhookExisting ?? null, error: null })
        if (table === 'stripe_customers') {
          const customer = Object.hasOwn(config, 'customer') ? config.customer : { user_id: 'user-1' }
          return Promise.resolve({ data: customer, error: null })
        }
        return Promise.resolve({ data: null, error: null })
      },
      then(res, rej) { return Promise.resolve({ error: null }).then(res, rej) },
    }
    return chain
  }
  const db = {
    from(table) { return chainFor(table) },
    rpc(fn, args) {
      calls.rpc.push({ fn, args })
      return Promise.resolve({ error: config.rpcError ?? null })
    },
  }
  return { db, calls }
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
  }
}

describe('reserveStripeEvent (idempotency)', () => {
  it('reserves a brand-new event', async () => {
    const { db } = makeDb()
    await expect(reserveStripeEvent(db, { eventId: 'evt_new', eventType: 't' })).resolves.toEqual({
      reserved: true,
      eventId: 'evt_new',
    })
  })

  it('dedupes an already-processed event', async () => {
    const { db } = makeDb({ reserveInsertError: { code: '23505' }, webhookExisting: { processing_status: 'processed' } })
    await expect(reserveStripeEvent(db, { eventId: 'evt_dup', eventType: 't' })).resolves.toEqual({
      reserved: false,
      eventId: 'evt_dup',
    })
  })

  it('allows a previously-failed event to be retried', async () => {
    const { db } = makeDb({ reserveInsertError: { code: '23505' }, webhookExisting: { processing_status: 'failed' } })
    await expect(reserveStripeEvent(db, { eventId: 'evt_retry', eventType: 't' })).resolves.toMatchObject({
      reserved: true,
      retrying: true,
    })
  })
})

describe('dispatchStripeEvent', () => {
  it('applies a subscription.created event and audits it', async () => {
    const { db, calls } = makeDb()
    const result = await dispatchStripeEvent(db, {
      id: 'evt_1',
      type: 'customer.subscription.created',
      data: { object: stripeSub() },
    })
    expect(result.applied).toBe(true)
    expect(calls.rpc[0].fn).toBe('project_stripe_entitlement')
    expect(calls.billingEvents[0]).toMatchObject({ event_type: 'stripe_subscription_created' })
  })

  it('uses the authoritative customer mapping on checkout.session.completed', async () => {
    const { db, calls } = makeDb({ customer: { user_id: 'user-1' } })
    const result = await dispatchStripeEvent(db, {
      id: 'evt_2',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', customer: 'cus_123', subscription: 'sub_123', metadata: { user_id: 'user-1' }, mode: 'subscription' } },
    })
    expect(result.userId).toBe('user-1')
    expect(calls.upsert.some((u) => u.table === 'stripe_customers')).toBe(false)
    expect(calls.billingEvents[0]).toMatchObject({ event_type: 'stripe_checkout_completed' })
  })

  it('does not create a customer mapping from untrusted checkout metadata', async () => {
    const { db, calls } = makeDb({ customer: null })
    const result = await dispatchStripeEvent(db, {
      id: 'evt_unmapped',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_2', customer: 'cus_unmapped', metadata: { user_id: 'user-attacker' }, mode: 'subscription' } },
    })
    expect(result.userId).toBe(null)
    expect(calls.upsert.some((u) => u.table === 'stripe_customers')).toBe(false)
    expect(calls.billingEvents[0]).toMatchObject({ user_id: null, event_type: 'stripe_checkout_completed' })
  })

  it('acknowledges but does not process unhandled event types', async () => {
    const { db, calls } = makeDb()
    const result = await dispatchStripeEvent(db, { id: 'evt_x', type: 'customer.created', data: { object: {} } })
    expect(result).toMatchObject({ applied: false, reason: 'unhandled' })
    expect(calls.rpc).toHaveLength(0)
  })
})

describe('handleStripeWebhook', () => {
  const baseDeps = (db) => ({
    db,
    webhookSecret: 'whsec_test',
    constructEvent: () => ({ id: 'evt_1', type: 'customer.subscription.created', data: { object: stripeSub() } }),
  })

  it('rejects an invalid signature with 400', async () => {
    const { db } = makeDb()
    const res = makeRes()
    const deps = {
      db,
      webhookSecret: 'whsec_test',
      constructEvent: () => { throw new Error('No signatures found matching the expected signature') },
    }
    await handleStripeWebhook({ headers: { 'stripe-signature': 'bad' }, body: Buffer.from('{}') }, res, deps)
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatchObject({ error: 'invalid_signature' })
  })

  it('503s when not configured', async () => {
    const res = makeRes()
    await handleStripeWebhook({ headers: {}, body: Buffer.from('{}') }, res, { db: null, webhookSecret: '', constructEvent: null })
    expect(res.statusCode).toBe(503)
  })

  it('processes a valid event and marks it processed', async () => {
    const { db, calls } = makeDb()
    const res = makeRes()
    await handleStripeWebhook({ headers: { 'stripe-signature': 'ok' }, body: Buffer.from('{}') }, res, baseDeps(db))
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ received: true })
    expect(calls.update.some((u) => u.table === 'stripe_webhook_events' && u.row.processing_status === 'processed')).toBe(true)
  })

  it('dedupes a replayed event without re-processing side effects', async () => {
    const { db, calls } = makeDb({ reserveInsertError: { code: '23505' }, webhookExisting: { processing_status: 'processed' } })
    const res = makeRes()
    await handleStripeWebhook({ headers: { 'stripe-signature': 'ok' }, body: Buffer.from('{}') }, res, baseDeps(db))
    expect(res.body).toMatchObject({ deduped: true })
    expect(calls.rpc).toHaveLength(0) // no entitlement projection on replay
  })

  it('marks the event failed and returns 500 when processing throws', async () => {
    const { db, calls } = makeDb({ rpcError: { message: 'db down' } })
    const res = makeRes()
    await handleStripeWebhook({ headers: { 'stripe-signature': 'ok' }, body: Buffer.from('{}') }, res, baseDeps(db))
    expect(res.statusCode).toBe(500)
    expect(calls.update.some((u) => u.table === 'stripe_webhook_events' && u.row.processing_status === 'failed')).toBe(true)
    expect(calls.billingEvents.some((e) => e.event_type === 'stripe_webhook_error')).toBe(true)
  })

  it('a foreign Stripe price fails closed with a clean retryable error: nothing is granted, the event is marked failed', async () => {
    const { db, calls } = makeDb()
    const res = makeRes()
    const foreign = stripeSub({ items: { data: [{ price: { id: 'price_foreign' } }] } })
    const deps = {
      db,
      webhookSecret: 'whsec_test',
      constructEvent: () => ({ id: 'evt_foreign', type: 'customer.subscription.created', data: { object: foreign } }),
    }
    await handleStripeWebhook({ headers: { 'stripe-signature': 'ok' }, body: Buffer.from('{}') }, res, deps)
    expect(res.statusCode).toBe(500)
    expect(res.body).toMatchObject({ error: 'webhook_processing_failed' })
    expect(calls.upsert).toHaveLength(0) // no subscriptions row
    expect(calls.rpc).toHaveLength(0) // no entitlement projection
    const failed = calls.update.find((u) => u.table === 'stripe_webhook_events' && u.row.processing_status === 'failed')
    expect(failed.row.safe_error).toContain('unknown_stripe_price: price_foreign')
    expect(calls.update.some((u) => u.row.processing_status === 'processed')).toBe(false)
    expect(calls.billingEvents.some((e) => e.event_type === 'stripe_webhook_error')).toBe(true)
  })
})
