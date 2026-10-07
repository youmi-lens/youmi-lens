/**
 * Stripe subscription → canonical record → student_pass entitlement projection.
 *
 * The pure functions here carry the lifecycle rules and are unit-tested directly:
 *   mapStripeStatus         — Stripe status → our 5-state set
 *   deriveSubscriptionRecord — Stripe subscription object → canonical row shape
 *   entitlementProjection   — canonical record → { active, startsAt, expiresAt }
 *
 * Rules (approved Desktop model):
 *   • Monthly and annual BOTH map to plan_type='student_pass' (one tier).
 *   • active / trialing               → access until current_period_end.
 *   • cancel_at_period_end (still active) → access until current_period_end.
 *   • past_due                        → access until grace_until ONLY.
 *   • canceled (immediate) / expired  → no access.
 *   • Expiry is enforced at READ TIME (getActiveEntitlement window check) — no
 *     cron. A revoked/expired subscription simply stops projecting an active row.
 *
 * The DB helpers (apply/upsert) are thin and take an injected admin client.
 */
import { planCodeForPriceId, billingIntervalForPlanCode, getGracePeriodDays } from './stripeConfig.mjs'

const DAY_MS = 24 * 60 * 60 * 1000

/** Stripe subscription.status → our subscriptions.status CHECK set. */
export function mapStripeStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'active':
      return 'active'
    case 'trialing':
      return 'trialing'
    case 'past_due':
      return 'past_due'
    case 'canceled':
      return 'canceled'
    // No usable access for these; collapse to 'expired' (no access, read-time).
    case 'unpaid':
    case 'incomplete':
    case 'incomplete_expired':
    case 'paused':
    default:
      return 'expired'
  }
}

function unixToIso(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return null
  return new Date(Number(seconds) * 1000).toISOString()
}

/** Extract the first line item from a Stripe subscription object. */
function firstSubscriptionItem(sub) {
  return sub?.items?.data?.[0] ?? null
}

/** Extract the first line-item price id from a Stripe subscription object. */
export function priceIdFromSubscription(sub) {
  return firstSubscriptionItem(sub)?.price?.id ?? sub?.plan?.id ?? null
}

/**
 * Billing period start/end in unix seconds. As of newer Stripe API versions
 * (e.g. 2026-06-24.dahlia, which the webhook payload uses) the top-level
 * `current_period_start`/`current_period_end` were REMOVED from the Subscription
 * object and now live on the subscription ITEM. Read the top-level field when
 * present (older versions / SDK-pinned retrievals) and fall back to the item so
 * the entitlement window is computed correctly across API versions.
 */
export function subscriptionPeriod(sub) {
  const item = firstSubscriptionItem(sub)
  return {
    start: sub?.current_period_start ?? item?.current_period_start ?? null,
    end: sub?.current_period_end ?? item?.current_period_end ?? null,
  }
}

/**
 * Pure: Stripe subscription object → canonical `subscriptions` row shape.
 * grace_until is set only for past_due with a positive grace window (server-computed; documented policy).
 */
export function deriveSubscriptionRecord(sub, { nowMs = Date.now(), graceDays } = {}) {
  const status = mapStripeStatus(sub?.status)
  const priceId = priceIdFromSubscription(sub)
  const planCode = planCodeForPriceId(priceId)
  const period = subscriptionPeriod(sub)
  const currentPeriodStart = unixToIso(period.start)
  // While trialing, access ends at the trial end. Stripe's period normally equals the trial window, but the
  // explicit `trial_end` is authoritative, so an unexpectedly longer period can never extend a free trial.
  const currentPeriodEnd = (status === 'trialing' && unixToIso(sub?.trial_end)) || unixToIso(period.end)
  const cancelAtPeriodEnd = Boolean(sub?.cancel_at_period_end)

  // Grace is measured from the end of what was actually PAID, which for a past_due subscription is the
  // START of the current (unpaid) period. Stripe begins a new billing period when it creates the renewal
  // invoice — and when a trial ends — even if that invoice then fails, so `current_period_end` of a past_due
  // subscription is the end of an UNPAID period; measuring from it would hand out a free month on a failed
  // first charge after a trial. Default grace is 0 days (unapproved policy): no grace_until is stored and a
  // past_due subscription grants no access. A positive STRIPE_GRACE_PERIOD_DAYS gives exactly that many days
  // after the paid-through boundary — see stripeConfig.
  let graceUntil = null
  if (status === 'past_due') {
    const days = Number.isFinite(graceDays) ? graceDays : getGracePeriodDays()
    if (days > 0) {
      const paidThroughMs = currentPeriodStart ? Date.parse(currentPeriodStart) : nowMs
      graceUntil = new Date((Number.isFinite(paidThroughMs) ? paidThroughMs : nowMs) + days * DAY_MS).toISOString()
    }
  }

  return {
    provider: 'stripe',
    provider_subscription_id: sub?.id ?? null,
    plan_code: planCode,
    provider_price_id: priceId,
    status,
    current_period_start: currentPeriodStart,
    current_period_end: currentPeriodEnd,
    cancel_at_period_end: cancelAtPeriodEnd,
    grace_until: graceUntil,
    billing_interval: planCode ? billingIntervalForPlanCode(planCode) : null,
  }
}

/**
 * Pure: canonical record → entitlement projection at `nowMs`.
 * Returns { active, startsAt, expiresAt } where expiresAt is the access-until
 * boundary. active === (accessUntil in the future).
 */
export function entitlementProjection(record, nowMs = Date.now()) {
  const periodEndMs = record?.current_period_end ? Date.parse(record.current_period_end) : NaN
  const graceMs = record?.grace_until ? Date.parse(record.grace_until) : NaN

  let accessUntilMs = NaN
  switch (record?.status) {
    case 'active':
    case 'trialing':
      accessUntilMs = periodEndMs
      break
    case 'past_due':
      // Access preserved ONLY through the explicit grace boundary.
      accessUntilMs = graceMs
      break
    case 'canceled':
      // Cancel-at-period-end keeps access until the period ends; an immediate
      // cancellation (cancel_at_period_end=false) grants nothing.
      accessUntilMs = record?.cancel_at_period_end ? periodEndMs : NaN
      break
    case 'expired':
    default:
      accessUntilMs = NaN
  }

  const active = Number.isFinite(accessUntilMs) && accessUntilMs > nowMs
  const startsAtMs = record?.current_period_start ? Date.parse(record.current_period_start) : nowMs
  return {
    active,
    startsAt: new Date(Number.isFinite(startsAtMs) ? startsAtMs : nowMs).toISOString(),
    expiresAt: new Date(Number.isFinite(accessUntilMs) ? accessUntilMs : nowMs).toISOString(),
  }
}

// ── DB helpers (thin; injected service-role client) ──────────────────────────

/**
 * Resolve the owning Supabase user_id for a Stripe subscription object.
 *
 * The SERVER-CREATED stripe_customers mapping (customer id → user_id) is the
 * authoritative link. subscription.metadata.user_id is useful only as a
 * consistency signal: webhook metadata is not trusted as an ownership fallback.
 * If both are present and DISAGREE, the mismatch is logged and the mapping wins.
 */
export async function resolveUserIdForSubscription(db, sub) {
  const metaUser = typeof sub?.metadata?.user_id === 'string' ? sub.metadata.user_id : null
  const customerId = typeof sub?.customer === 'string' ? sub.customer : sub?.customer?.id
  let mappedUser = null
  if (customerId && db) {
    const { data, error } = await db
      .from('stripe_customers')
      .select('user_id')
      .eq('stripe_customer_id', customerId)
      .maybeSingle()
    if (error) throw error
    mappedUser = data?.user_id ?? null
  }
  if (mappedUser) {
    if (metaUser && metaUser !== mappedUser) {
      console.warn('[stripe] subscription metadata.user_id disagrees with customer mapping; using mapping')
    }
    return mappedUser
  }
  return null
}

/** Upsert the canonical subscriptions row (idempotent by provider+sub id). */
export async function upsertSubscriptionRecord(db, userId, record, { lastEventMs = null } = {}) {
  const row = {
    user_id: userId,
    provider: 'stripe',
    provider_subscription_id: record.provider_subscription_id,
    plan_code: record.plan_code,
    status: record.status,
    current_period_start: record.current_period_start,
    current_period_end: record.current_period_end,
    cancel_at_period_end: record.cancel_at_period_end,
    grace_until: record.grace_until,
    provider_price_id: record.provider_price_id,
  }
  // Only stamp last_event_at when we have an event time, so a live refresh (no
  // event) never wipes the ordering marker set by a real webhook.
  if (lastEventMs != null && Number.isFinite(lastEventMs)) {
    row.last_event_at = new Date(lastEventMs).toISOString()
  }
  const { error } = await db.from('subscriptions').upsert(row, {
    onConflict: 'provider,provider_subscription_id',
  })
  if (error) throw error
}

/** Project the record into exactly one student_pass entitlement (idempotent). */
export async function projectEntitlement(db, userId, record, nowMs = Date.now()) {
  const proj = entitlementProjection(record, nowMs)
  const productId = record.plan_code || 'student_basic_stripe'
  const { error } = await db.rpc('project_stripe_entitlement', {
    p_user_id: userId,
    p_subscription_id: record.provider_subscription_id,
    p_product_id: productId,
    p_starts_at: proj.startsAt,
    p_expires_at: proj.expiresAt,
    p_active: proj.active,
  })
  if (error) throw error
  return proj
}

/**
 * Apply a full Stripe subscription object to the DB: upsert the canonical row
 * and project the entitlement. Requires a resolvable user_id.
 *
 * Out-of-order protection: Stripe delivers webhooks at-least-once and WITHOUT
 * ordering guarantees. When `eventCreatedMs` is supplied (the Stripe event
 * `created` time), an event OLDER than the last one already applied to this
 * subscription is skipped, so a stale delivery can never regress a newer period
 * or status. A live refresh passes no event time and always applies.
 */
export async function applyStripeSubscription(db, sub, { nowMs = Date.now(), eventCreatedMs = null } = {}) {
  const userId = await resolveUserIdForSubscription(db, sub)
  if (!userId) return { applied: false, reason: 'no_user' }
  const record = deriveSubscriptionRecord(sub, { nowMs })
  if (!record.provider_subscription_id) return { applied: false, reason: 'no_subscription_id' }

  // A price we do not sell (foreign product, or this environment's price ids are not configured) must
  // never reach the database: `subscriptions.plan_code` is NOT NULL, so it would fail there anyway. Fail
  // explicitly BEFORE any write instead. It stays an error (webhook 500 -> event marked failed -> Stripe
  // retries) rather than a silent ack, so a legitimately paid subscription is not dropped by a config slip.
  if (!record.plan_code) {
    throw new Error(`unknown_stripe_price: ${record.provider_price_id ?? 'none'}`)
  }

  if (eventCreatedMs != null && Number.isFinite(eventCreatedMs)) {
    const { data: existing, error } = await db
      .from('subscriptions')
      .select('last_event_at')
      .eq('provider', 'stripe')
      .eq('provider_subscription_id', record.provider_subscription_id)
      .maybeSingle()
    if (error) throw error
    const storedMs = existing?.last_event_at ? Date.parse(existing.last_event_at) : NaN
    if (Number.isFinite(storedMs) && eventCreatedMs < storedMs) {
      return { applied: false, reason: 'stale', userId, record }
    }
  }

  await upsertSubscriptionRecord(db, userId, record, { lastEventMs: eventCreatedMs })
  const proj = await projectEntitlement(db, userId, record, nowMs)
  return { applied: true, userId, record, projection: proj }
}

/**
 * Build the normalized, secret-free subscription status for Mac/Windows/Website.
 * Picks the most access-relevant subscription (eligible one with furthest reach,
 * else most recent). Never exposes Stripe ids or raw payloads.
 */
export async function buildSubscriptionStatus(db, userId, nowMs = Date.now()) {
  const { data: rows, error } = await db
    .from('subscriptions')
    .select(
      'plan_code, status, current_period_start, current_period_end, cancel_at_period_end, grace_until, updated_at',
    )
    .eq('user_id', userId)
    .eq('provider', 'stripe')
    .order('updated_at', { ascending: false })
    .limit(10)
  if (error) throw error

  const { data: customer } = await db
    .from('stripe_customers')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle()
  const manageable = Boolean(customer)

  if (!rows || rows.length === 0) {
    return {
      provider: null,
      active: false,
      planCode: null,
      billingInterval: null,
      status: 'none',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      graceUntil: null,
      trialing: false,
      trialEnd: null,
      inGrace: false,
      manageable,
    }
  }

  // Prefer a currently-eligible subscription; otherwise the most recent row.
  let best = null
  for (const row of rows) {
    const proj = entitlementProjection(row, nowMs)
    if (proj.active) {
      if (!best || Date.parse(row.current_period_end ?? 0) > Date.parse(best.current_period_end ?? 0)) {
        best = row
      }
    }
  }
  const chosen = best ?? rows[0]
  const projection = entitlementProjection(chosen, nowMs)
  const trialing = chosen.status === 'trialing' && projection.active

  return {
    provider: 'stripe',
    active: projection.active,
    planCode: chosen.plan_code,
    billingInterval: chosen.plan_code ? billingIntervalForPlanCode(chosen.plan_code) : null,
    status: chosen.status,
    currentPeriodEnd: chosen.current_period_end,
    cancelAtPeriodEnd: Boolean(chosen.cancel_at_period_end),
    graceUntil: chosen.grace_until,
    // Additive, secret-free trial / grace facts so a client can word these states truthfully. `status` and
    // `cancelAtPeriodEnd` keep their meaning, so a trial cancelled during the trial is still `trialing`.
    trialing,
    trialEnd: trialing ? chosen.current_period_end : null,
    inGrace: chosen.status === 'past_due' && projection.active,
    manageable,
  }
}
