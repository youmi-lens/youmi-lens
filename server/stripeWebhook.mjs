/**
 * Stripe webhook processing (Desktop). At-least-once delivery → idempotent.
 *
 * Discipline mirrors server/iapEntitlements.mjs reserveNotification(): reserve
 * the event id BEFORE side effects; a duplicate is deduped; a previously-failed
 * event may be retried. Signatures are verified against the raw request body;
 * invalid signatures are rejected without processing.
 */
import { recordBillingEvent } from './iapEntitlements.mjs'
import { applyStripeSubscription, resolveUserIdForSubscription } from './stripeSubscriptions.mjs'

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
])

const BILLING_EVENT_TYPE = {
  'customer.subscription.created': 'stripe_subscription_created',
  'customer.subscription.updated': 'stripe_subscription_updated',
  'customer.subscription.deleted': 'stripe_subscription_deleted',
  'checkout.session.completed': 'stripe_checkout_completed',
  'invoice.paid': 'stripe_renewal',
  'invoice.payment_failed': 'stripe_payment_failed',
}

export function safeStripeError(err) {
  const message = err instanceof Error ? err.message : String(err ?? 'unknown')
  return message.slice(0, 240)
}

export const STRIPE_EVENT_PROCESSING_STALE_MS = 10 * 60 * 1000

function isStaleProcessingEvent(row, nowMs, processingStaleMs) {
  const updatedMs = row?.updated_at ? Date.parse(row.updated_at) : NaN
  return Number.isFinite(updatedMs) && updatedMs <= nowMs - processingStaleMs
}

/** Reserve a webhook event id; race-safe dedupe with failed-retry support. */
export async function reserveStripeEvent(
  db,
  { eventId, eventType },
  { nowMs = Date.now(), processingStaleMs = STRIPE_EVENT_PROCESSING_STALE_MS } = {},
) {
  if (!eventId) return { reserved: true, eventId: null }
  const row = { event_id: eventId, event_type: eventType ?? null, processing_status: 'processing', safe_error: null }
  const { error } = await db.from('stripe_webhook_events').insert(row)
  if (!error) return { reserved: true, eventId }
  if (error.code === '23505') {
    const { data, error: readErr } = await db
      .from('stripe_webhook_events')
      .select('processing_status, updated_at')
      .eq('event_id', eventId)
      .maybeSingle()
    if (readErr) throw readErr
    if (data?.processing_status === 'failed') {
      const { data: updated, error: updateErr } = await db
        .from('stripe_webhook_events')
        .update(row)
        .eq('event_id', eventId)
        .eq('processing_status', 'failed')
        .select('event_id')
        .maybeSingle()
      if (updateErr) throw updateErr
      if (!updated) return { reserved: false, eventId, retryable: true }
      return { reserved: true, eventId, retrying: true }
    }
    if (data?.processing_status === 'processing') {
      if (isStaleProcessingEvent(data, nowMs, processingStaleMs)) {
        const staleCutoffIso = new Date(nowMs - processingStaleMs).toISOString()
        const { data: updated, error: updateErr } = await db
          .from('stripe_webhook_events')
          .update(row)
          .eq('event_id', eventId)
          .eq('processing_status', 'processing')
          .lte('updated_at', staleCutoffIso)
          .select('event_id')
          .maybeSingle()
        if (updateErr) throw updateErr
        if (!updated) return { reserved: false, eventId, retryable: true }
        return { reserved: true, eventId, retrying: true, reclaimed: true }
      }
      return { reserved: false, eventId, retryable: true }
    }
    return { reserved: false, eventId }
  }
  throw error
}

export async function markStripeEventProcessed(db, eventId) {
  if (!eventId) return
  const { error } = await db
    .from('stripe_webhook_events')
    .update({ processing_status: 'processed', safe_error: null })
    .eq('event_id', eventId)
  if (error) throw error
}

export async function markStripeEventFailed(db, eventId, err) {
  if (!eventId) return
  const { error } = await db
    .from('stripe_webhook_events')
    .update({ processing_status: 'failed', safe_error: safeStripeError(err) })
    .eq('event_id', eventId)
  if (error) throw error
}

/**
 * Apply one Stripe event's side effects. Pure-ish: only touches the DB via the
 * injected admin client. Subscription lifecycle is the source of truth; invoice
 * events are audited (the paired subscription.updated carries the new state).
 */
export async function dispatchStripeEvent(db, event, { nowMs = Date.now() } = {}) {
  const type = event?.type
  const object = event?.data?.object ?? {}
  // Stripe event `created` (unix seconds) — used for out-of-order protection.
  const eventCreatedMs = Number.isFinite(Number(event?.created)) ? Number(event.created) * 1000 : null

  if (SUBSCRIPTION_EVENTS.has(type)) {
    const result = await applyStripeSubscription(db, object, { nowMs, eventCreatedMs })
    await recordBillingEvent(db, result.userId ?? null, {
      event_type: BILLING_EVENT_TYPE[type],
      product_id: result.record?.plan_code ?? null,
      transaction_id: object?.id ?? null,
      environment: object?.livemode === false ? 'sandbox' : 'production',
      detail: {
        status: result.record?.status ?? null,
        cancel_at_period_end: result.record?.cancel_at_period_end ?? null,
        applied: result.applied,
        reason: result.reason ?? null,
      },
    })
    return result
  }

  if (type === 'checkout.session.completed') {
    // Checkout creates the customer mapping before it creates the session. Use
    // that server-owned mapping here; webhook metadata is not an identity source.
    const userId = await resolveUserIdForSubscription(db, object)
    await recordBillingEvent(db, userId, {
      event_type: BILLING_EVENT_TYPE[type],
      product_id: null,
      transaction_id: object?.subscription ?? object?.id ?? null,
      environment: object?.livemode === false ? 'sandbox' : 'production',
      detail: { mode: object?.mode ?? null },
    })
    return { applied: true, userId }
  }

  if (type === 'invoice.paid' || type === 'invoice.payment_failed') {
    // Audit only; the subscription.updated event carries the authoritative state.
    await recordBillingEvent(db, null, {
      event_type: BILLING_EVENT_TYPE[type],
      product_id: null,
      transaction_id: object?.subscription ?? object?.id ?? null,
      environment: object?.livemode === false ? 'sandbox' : 'production',
      detail: { billing_reason: object?.billing_reason ?? null },
    })
    return { applied: true }
  }

  // Unhandled event types are acknowledged (200) but not processed.
  return { applied: false, reason: 'unhandled' }
}

/**
 * Express handler. deps: { db, webhookSecret, constructEvent }.
 *   constructEvent(rawBody, signature, secret) → event | throws on bad signature.
 * req.body MUST be the raw Buffer (mount with express.raw for this route only).
 */
export async function handleStripeWebhook(req, res, deps) {
  const { db, webhookSecret, constructEvent } = deps
  if (!db || !webhookSecret || !constructEvent) {
    res.status(503).json({ ok: false, error: 'stripe_not_configured' })
    return
  }

  const signature = req.headers['stripe-signature']
  let event
  try {
    event = constructEvent(req.body, signature, webhookSecret)
  } catch (err) {
    console.warn('[stripe/webhook] signature verification failed', safeStripeError(err))
    res.status(400).json({ ok: false, error: 'invalid_signature' })
    return
  }

  let reservation
  try {
    reservation = await reserveStripeEvent(db, { eventId: event.id, eventType: event.type })
  } catch (err) {
    console.error('[stripe/webhook] reserve failed', safeStripeError(err))
    res.status(500).json({ ok: false, error: 'webhook_reserve_failed' })
    return
  }
  if (!reservation.reserved) {
    if (reservation.retryable) {
      res.status(503).json({ ok: false, error: 'webhook_processing_in_progress' })
      return
    }
    res.json({ ok: true, received: true, deduped: true })
    return
  }

  try {
    await dispatchStripeEvent(db, event, {})
    await markStripeEventProcessed(db, event.id)
    res.json({ ok: true, received: true })
  } catch (err) {
    try {
      await markStripeEventFailed(db, event.id, err)
      await recordBillingEvent(db, null, {
        event_type: 'stripe_webhook_error',
        transaction_id: event.id,
        detail: { type: event.type, error: safeStripeError(err) },
      })
    } catch (markErr) {
      console.warn('[stripe/webhook] mark-failed error', safeStripeError(markErr))
    }
    console.error('[stripe/webhook] processing failed', safeStripeError(err))
    res.status(500).json({ ok: false, error: 'webhook_processing_failed' })
  }
}
