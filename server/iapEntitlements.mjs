/**
 * Student Basic entitlement logic.
 *
 * The backend is the source of truth. The active consumable SKU stacks 30-day
 * grants from max(existing expiry, Apple-verified purchaseDate). The legacy
 * non-consumable SKU retains its original purchaseDate-based window.
 *
 *     starts_at  = purchaseDate
 *     expires_at = purchaseDate + billing_products.entitlement_days
 *
 * Apple's own expiresDate is ignored for entitlement decisions. The effective
 * plan is resolved at request time (no cron): an active, non-revoked entitlement
 * promotes the user to student_pass; otherwise they fall back to public_trial.
 *
 * The pure functions below (window/decision/resolution) carry the security
 * rules and are unit-tested directly. DB helpers are thin and injectable.
 */
import { findAppleIapTransactionBinding } from './iapLedger.mjs'
import { SUBSCRIPTION_ACTIVE_STATUSES, getEffectiveSubscription, safeSubscriptionEntitlement } from './iapSubscriptions.mjs'

const DAY_MS = 24 * 60 * 60 * 1000
export const STUDENT_BASIC_PRODUCT_ID = 'com.aydenz.youmilensipad.studentbasic30d'
export const LEGACY_STUDENT_PASS_PRODUCT_ID = 'com.aydenz.youmilensipad.studentpass30d'
export const STUDENT_ACCESS_PRODUCT_IDS = [
  STUDENT_BASIC_PRODUCT_ID,
  LEGACY_STUDENT_PASS_PRODUCT_ID,
]

/** Pure: compute the 30-day (configurable) entitlement window from purchaseDate. */
export function computeEntitlementWindow(purchaseDateMs, entitlementDays) {
  if (typeof purchaseDateMs !== 'number' || !Number.isFinite(purchaseDateMs)) {
    throw new Error('purchaseDateMs must be a finite number')
  }
  const days = Number(entitlementDays)
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error('entitlementDays must be a positive number')
  }
  const startsAtMs = purchaseDateMs
  const expiresAtMs = purchaseDateMs + days * DAY_MS
  return {
    startsAtMs,
    expiresAtMs,
    startsAt: new Date(startsAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  }
}

export function computeConsumableEntitlementWindow(
  purchaseDateMs,
  entitlementDays,
  existingExpiresAt = null,
) {
  const existingExpiresMs = existingExpiresAt ? new Date(existingExpiresAt).getTime() : NaN
  const extensionBaseMs = Number.isFinite(existingExpiresMs)
    ? Math.max(purchaseDateMs, existingExpiresMs)
    : purchaseDateMs
  const days = Number(entitlementDays)
  if (typeof purchaseDateMs !== 'number' || !Number.isFinite(purchaseDateMs)) {
    throw new Error('purchaseDateMs must be a finite number')
  }
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error('entitlementDays must be a positive number')
  }
  const expiresAtMs = extensionBaseMs + days * DAY_MS
  return {
    startsAtMs: purchaseDateMs,
    expiresAtMs,
    startsAt: new Date(purchaseDateMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  }
}

/**
 * Pure: decide what to write for a verified transaction. No I/O. The route
 * supplies the verified transaction, the billing_products row, the existing
 * owner of this transaction (if any), the requesting user, and `now`.
 *
 * Returns one of:
 *   { ok:false, code, message, event }                      — reject (no grant)
 *   { ok:true, active:boolean, window, entitlementStatus, event }  — write txn,
 *       and grant an entitlement when active (expires in the future).
 *
 * Security rules enforced here:
 *   - unknown product (no billing_products row) → reject
 *   - a transaction already owned by another user → reject (one txn ⇒ one account)
 *   - purchaseDate strictly after sales_end_at → reject new grant (cutoff)
 *   - window already elapsed → record txn but do NOT grant an active entitlement
 *   - Apple-revoked transaction → record as revoked, no active grant
 */
export function decideGrant({
  verified,
  product,
  existingOwnerUserId,
  requestingUserId,
  existingEntitlementExpiresAt = null,
  nowMs,
}) {
  const baseEvent = {
    product_id: verified?.productId ?? null,
    transaction_id: verified?.transactionId ?? null,
    environment: verified?.environment ?? null,
  }

  if (!product) {
    return {
      ok: false,
      code: 'unknown_product',
      message: 'This product is not recognized.',
      event: { ...baseEvent, event_type: 'verify_reject', detail: { reason: 'unknown_product' } },
    }
  }

  if (existingOwnerUserId && existingOwnerUserId !== requestingUserId) {
    return {
      ok: false,
      code: 'already_linked',
      message: 'This App Store purchase is already linked to another account.',
      event: { ...baseEvent, event_type: 'verify_reject', detail: { reason: 'cross_account' } },
    }
  }

  // Sales cutoff: reject only purchases whose VERIFIED purchaseDate is after the
  // cutoff. Pre-cutoff purchases always pass (so verify/restore keep working
  // after sales stop). purchaseDate is immutable, so the decision is stable.
  if (product.sales_end_at) {
    const cutoffMs = new Date(product.sales_end_at).getTime()
    if (Number.isFinite(cutoffMs) && verified.purchaseDateMs > cutoffMs) {
      return {
        ok: false,
        code: 'sales_closed',
        message: 'This purchase was made after paid access sales ended.',
        event: { ...baseEvent, event_type: 'sales_cutoff_block', detail: { reason: 'after_sales_end_at' } },
      }
    }
  }

  const window = product.kind === 'consumable'
    ? computeConsumableEntitlementWindow(
        verified.purchaseDateMs,
        product.entitlement_days,
        existingEntitlementExpiresAt,
      )
    : computeEntitlementWindow(verified.purchaseDateMs, product.entitlement_days)

  // Apple-revoked (refund already applied) → record, never grant.
  if (verified.revoked) {
    return {
      ok: true,
      active: false,
      window,
      entitlementStatus: 'revoked',
      event: { ...baseEvent, event_type: 'grant', detail: { granted: false, reason: 'revoked' } },
    }
  }

  // Window already elapsed (e.g. restoring a long-expired pass) → record, no grant.
  if (window.expiresAtMs <= nowMs) {
    return {
      ok: true,
      active: false,
      window,
      entitlementStatus: 'expired',
      event: { ...baseEvent, event_type: 'grant', detail: { granted: false, reason: 'expired' } },
    }
  }

  return {
    ok: true,
    active: true,
    window,
    entitlementStatus: 'active',
    event: {
      ...baseEvent,
      event_type: 'grant',
      detail: { granted: true, plan_type: product.plan_type, expires_at: window.expiresAt },
    },
  }
}

export function decideGrantWithBinding({
  verified,
  product,
  binding,
  requestingUserId,
  existingEntitlementExpiresAt = null,
  nowMs,
}) {
  if (binding?.ownerState === 'account_deleted') {
    const baseEvent = {
      product_id: verified?.productId ?? null,
      transaction_id: verified?.transactionId ?? null,
      environment: verified?.environment ?? null,
    }
    return {
      ok: false,
      code: 'account_deleted',
      message: 'This App Store purchase is linked to another account.',
      event: { ...baseEvent, event_type: 'verify_reject', detail: { reason: 'deleted_account_binding' } },
    }
  }
  return decideGrant({
    verified,
    product,
    existingOwnerUserId: binding?.userId ?? null,
    requestingUserId,
    existingEntitlementExpiresAt,
    nowMs,
  })
}

/**
 * Pure: resolve the effective plan_type at request time.
 * Precedence: admin → active entitlement → core_tester → public_trial.
 * An expired/absent entitlement yields public_trial WITHOUT any cron.
 */
export function resolveEffectivePlanType({ storedPlanType, entitlement, nowMs }) {
  if (storedPlanType === 'admin') return 'admin'
  if (isEntitlementActive(entitlement, nowMs)) return entitlement.plan_type
  if (storedPlanType === 'core_tester') return 'core_tester'
  return 'public_trial'
}

/** Pure: is this entitlement currently active (status active, within window, not revoked)? */
export function isEntitlementActive(entitlement, nowMs) {
  if (!entitlement) return false
  // Uses the ONE canonical active-status vocabulary shared with the
  // subscription layer, so a subscription that is genuinely still entitled
  // (grace_period, or cancelled-but-not-yet-expired) is no longer rejected
  // here and shown as Free before its expires_at. Legacy user_entitlements
  // rows only ever carry 'active', so they are unaffected.
  //
  // Expiry stays authoritative regardless of status: the starts_at/expires_at
  // window below still gates every one of these statuses.
  if (!SUBSCRIPTION_ACTIVE_STATUSES.includes(entitlement.status)) return false
  if (entitlement.revoked_at) return false
  const startsMs = entitlement.starts_at ? new Date(entitlement.starts_at).getTime() : null
  const expiresMs = entitlement.expires_at ? new Date(entitlement.expires_at).getTime() : null
  if (startsMs == null || expiresMs == null) return false
  return startsMs <= nowMs && nowMs < expiresMs
}

// ── DB helpers (thin; admin/service-role client injected by caller) ───────────

/** Load the configured product row, or null if the product id is unknown. */
export async function loadBillingProduct(db, productId) {
  if (!db || !productId) return null
  const { data, error } = await db
    .from('billing_products')
    .select('product_id, plan_type, kind, entitlement_days, is_purchasable, sales_end_at')
    .eq('product_id', productId)
    .maybeSingle()
  if (error) throw error
  return data ?? null
}

/** Which account binding (if any) already owns this transaction or original transaction. */
export async function findTransactionBinding(db, { transactionId, originalTransactionId }) {
  return findAppleIapTransactionBinding(db, { transactionId, originalTransactionId })
}

/** Back-compat helper for code paths that only need the current user id. */
export async function findTransactionOwner(db, transaction) {
  const binding = await findTransactionBinding(db, transaction)
  return binding?.userId ?? null
}

/**
 * Fetch the user's current best active entitlement (latest-expiring), or null.
 *
 * Source-agnostic (Commercialization V2 · 1A): resolution keys off
 * plan_type='student_pass' only, so an active grant projected from EITHER an
 * Apple transaction OR a Stripe subscription resolves identically. The previous
 * Apple-product-id filter was redundant (only student products ever carry
 * plan_type='student_pass') and would have excluded Stripe grants. Quota is
 * per user_id, so returning a single row here never multiplies quota even if a
 * user held multiple active grants.
 */
export async function getActiveEntitlement(db, userId, nowIso) {
  // Commercialization V2: an active auto-renewing subscription is the primary
  // entitlement source. It is projected into the same row shape the rest of the
  // entitlement/status pipeline already consumes, so callers are unchanged.
  //
  // Subscription state is an ADDITIVE source. A lookup error (schema drift,
  // transient DB/RLS failure, etc.) must never take down the whole entitlement
  // or quota-status response — it falls through to the legacy/free lookup, which
  // is what keeps an ordinary account (no subscription) answering normally.
  let subscription = null
  try {
    subscription = await getEffectiveSubscription(db, userId)
  } catch (err) {
    console.warn(
      '[iapEntitlements] subscription lookup failed; falling back to legacy entitlement',
      err instanceof Error ? err.message : String(err),
    )
  }
  if (subscription?.active) {
    const safe = safeSubscriptionEntitlement(subscription)
    // Canonical Apple-authoritative state is already active and unexpired here. A renewal delivered before its
    // period's purchaseDate must not read as "not started yet" (isEntitlementActive requires starts_at <= now),
    // so the projected start never lies in the future. Expiry/revocation remain authoritative.
    const startsMs = Date.parse(safe.startsAt)
    const nowMs = Date.parse(nowIso)
    const startsAt = Number.isFinite(startsMs) && Number.isFinite(nowMs) && startsMs > nowMs ? nowIso : safe.startsAt
    return {
      product_id: safe.productId,
      plan_type: safe.planType,
      starts_at: startsAt,
      expires_at: safe.expiresAt,
      status: safe.status,
      revoked_at: safe.revocationAt,
      source_transaction_id: safe.latestTransactionId,
      original_transaction_id: safe.originalTransactionId,
      auto_renew_status: safe.autoRenewStatus,
      subscription_group_id: safe.subscriptionGroupId,
      source: safe.source,
    }
  }

  // Source-agnostic fallback: an active grant projected from a Stripe or legacy
  // Apple transaction (both carry plan_type='student_pass') resolves here.
  const { data, error } = await db
    .from('user_entitlements')
    .select('product_id, plan_type, starts_at, expires_at, status, revoked_at, source_transaction_id')
    .eq('user_id', userId)
    .eq('plan_type', 'student_pass')
    .eq('status', 'active')
    .lte('starts_at', nowIso)
    .gt('expires_at', nowIso)
    .is('revoked_at', null)
    .order('expires_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data ?? null
}

export async function getEntitlementBySourceTransactionId(db, transactionId) {
  if (!transactionId) return null
  const { data, error } = await db
    .from('user_entitlements')
    .select('product_id, plan_type, starts_at, expires_at, status, revoked_at, source_transaction_id')
    .eq('source_transaction_id', transactionId)
    .maybeSingle()
  if (error) throw error
  return data ?? null
}

export async function getLatestStackableEntitlementExpiry(db, userId) {
  const { data, error } = await db
    .from('user_entitlements')
    .select('expires_at')
    .eq('user_id', userId)
    .eq('plan_type', 'student_pass')
    .eq('status', 'active')
    .is('revoked_at', null)
    .order('expires_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data?.expires_at ?? null
}

export function safeEntitlementSnapshot(entitlement) {
  if (!entitlement) return null
  return {
    productId: entitlement.product_id,
    planType: entitlement.plan_type,
    startsAt: entitlement.starts_at,
    expiresAt: entitlement.expires_at,
    status: entitlement.status,
  }
}

export function deriveInactiveEntitlementStatus(entitlement, latestRevocationEventType = null, nowMs = Date.now()) {
  if (!entitlement) return 'none'
  if (entitlement.status === 'revoked') {
    return latestRevocationEventType === 'refund' ? 'refunded' : 'revoked'
  }
  if (entitlement.revoked_at) return 'revoked'
  const expiresMs = entitlement.expires_at ? new Date(entitlement.expires_at).getTime() : NaN
  if (Number.isFinite(expiresMs) && expiresMs <= nowMs) return 'expired'
  return entitlement.status || 'none'
}

export async function getLatestStudentPassEntitlement(db, userId) {
  const { data, error } = await db
    .from('user_entitlements')
    .select('product_id, plan_type, starts_at, expires_at, status, revoked_at, source_transaction_id, created_at')
    .eq('user_id', userId)
    .eq('plan_type', 'student_pass')
    .order('expires_at', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data ?? null
}

export async function getLatestRevocationEventType(db, entitlement) {
  if (!entitlement?.source_transaction_id) return null
  const { data, error } = await db
    .from('billing_events')
    .select('event_type')
    .eq('transaction_id', entitlement.source_transaction_id)
    .in('event_type', ['refund', 'revoke'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data?.event_type ?? null
}

/**
 * Append an audit row. Never stores email, JWS, JWT, or other secrets/PII —
 * only ids, environment, type and small reason/detail objects supplied by the
 * caller. Best-effort: logs and swallows errors so auditing can't break a flow.
 */
export async function recordBillingEvent(db, userId, event) {
  if (!db || !event) return
  try {
    const { error } = await db.from('billing_events').insert({
      user_id: userId ?? null,
      event_type: event.event_type,
      product_id: event.product_id ?? null,
      transaction_id: event.transaction_id ?? null,
      environment: event.environment ?? null,
      detail: event.detail ?? null,
    })
    if (error) {
      console.warn('[billing_events] insert failed', JSON.stringify({ error: error.message, type: event.event_type }))
    }
  } catch (err) {
    console.warn('[billing_events] insert threw', err instanceof Error ? err.message : String(err))
  }
}

export function safeNotificationError(err) {
  const message = err instanceof Error ? err.message : String(err ?? 'unknown')
  return message.slice(0, 240)
}

export async function reserveNotification(db, decoded) {
  const notificationUUID = decoded?.notificationUUID
  if (!notificationUUID) return { reserved: true, notificationUUID: null }
  const row = {
    notification_uuid: notificationUUID,
    notification_type: decoded.notificationType ?? null,
    subtype: decoded.subtype ?? null,
    environment: decoded.environment ?? null,
    transaction_id: decoded.transaction?.transactionId ?? null,
    processing_status: 'processing',
    safe_error: null,
  }
  const { data: inserted, error } = await db.from('apple_iap_notifications').insert(row).select('updated_at').single()
  if (!error) return { reserved: true, notificationUUID, lease: inserted.updated_at }
  if (error.code === '23505') {
    const { data, error: readErr } = await db
      .from('apple_iap_notifications')
      .select('processing_status,updated_at')
      .eq('notification_uuid', notificationUUID)
      .maybeSingle()
    if (readErr) throw readErr
    if (data?.processing_status === 'processed') return { reserved: false, notificationUUID }
    const stale = data?.processing_status === 'processing' &&
      Number.isFinite(Date.parse(data.updated_at)) && Date.now() - Date.parse(data.updated_at) >= 5 * 60_000
    if (data?.processing_status === 'failed' || stale) {
      // Compare-and-swap the exact observed lease; only one retry owns it.
      const { data: claimed, error: updateErr } = await db.from('apple_iap_notifications')
        .update(row).eq('notification_uuid', notificationUUID)
        .eq('processing_status', data.processing_status).eq('updated_at', data.updated_at).select('updated_at')
      if (updateErr) throw updateErr
      if (claimed?.length) return { reserved: true, notificationUUID, retrying: true, lease: claimed[0].updated_at }
    }
    // A processing record is not proof of delivery. Ask Apple to retry,
    // including when its original worker died or another retry won the CAS.
    return { reserved: false, notificationUUID, inFlight: true }
  }
  throw error
}

export async function markNotificationProcessed(db, notificationUUID, lease = null) {
  if (!notificationUUID) return
  let query = db
    .from('apple_iap_notifications')
    .update({
      processing_status: 'processed',
      processed_at: new Date().toISOString(),
      safe_error: null,
    })
    .eq('notification_uuid', notificationUUID)
  if (lease) query = query.eq('updated_at', lease).eq('processing_status', 'processing')
  const { error } = await query
  if (error) throw error
}

export async function markNotificationFailed(db, notificationUUID, err, lease = null) {
  if (!notificationUUID) return
  let query = db
    .from('apple_iap_notifications')
    .update({
      processing_status: 'failed',
      processed_at: new Date().toISOString(),
      safe_error: safeNotificationError(err),
    })
    .eq('notification_uuid', notificationUUID)
  if (lease) query = query.eq('updated_at', lease).eq('processing_status', 'processing')
  const { error } = await query
  if (error) throw error
}
