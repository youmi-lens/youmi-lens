import { NotificationTypeV2, Subtype } from '@apple/app-store-server-library'

export const SUBSCRIPTION_PRODUCT_IDS = new Set([
  'com.aydenz.youmilensipad.student.monthly',
  'com.aydenz.youmilensipad.student.annual',
])

export class SubscriptionAlreadyLinkedError extends Error {}
export class SubscriptionAccountTokenError extends Error {}
export class SubscriptionDeletedAccountError extends Error {}
export class SubscriptionEnvironmentError extends Error {}
export class SubscriptionSalesClosedError extends Error {}

export function isAutoRenewableProduct(product) {
  return product?.kind === 'auto_renewable' && SUBSCRIPTION_PRODUCT_IDS.has(product?.product_id)
}

export function deriveSubscriptionStatus({ transaction, renewal = null, notificationType = null, subtype = null, nowMs = Date.now() }) {
  if (notificationType === NotificationTypeV2.REFUND) return 'refunded'
  if (notificationType === NotificationTypeV2.REVOKE || transaction?.revoked) return 'revoked'
  if (notificationType === NotificationTypeV2.GRACE_PERIOD_EXPIRED) return 'expired'
  if (notificationType === NotificationTypeV2.EXPIRED) return 'expired'

  const graceExpiry = renewal?.gracePeriodExpiresDate ? new Date(renewal.gracePeriodExpiresDate).getTime() : NaN
  if (subtype === Subtype.GRACE_PERIOD && Number.isFinite(graceExpiry) && graceExpiry > nowMs) {
    return 'grace_period'
  }

  // DID_FAIL_TO_RENEW (and explicit billing-retry signals) map to billing_retry.
  // PRICE_INCREASE / DID_RENEW intentionally fall through to date-based status.
  if (
    renewal?.isInBillingRetryPeriod === true ||
    subtype === Subtype.BILLING_RETRY ||
    (notificationType === NotificationTypeV2.DID_FAIL_TO_RENEW && subtype !== Subtype.GRACE_PERIOD)
  ) {
    return 'billing_retry'
  }

  const expiresMs = transaction?.expiresDateMs ?? (transaction?.appleExpiresDate ? new Date(transaction.appleExpiresDate).getTime() : NaN)
  if (!Number.isFinite(expiresMs)) return 'verification_pending'
  if (expiresMs <= nowMs) return 'expired'
  if (renewal?.autoRenewStatus === false) return 'cancelled_but_active_until_expiry'
  return 'active'
}

/** Production kill switch: block brand-new Production grants while sales stay closed. Sandbox/Xcode and existing bindings remain allowed. */
export function shouldBlockSubscriptionGrant({ product, verified, existingBinding }) {
  if (!isAutoRenewableProduct(product)) return null
  if (product.is_purchasable !== false) return null
  if (existingBinding) return null
  if (verified?.environment !== 'Production') return null
  return 'sales_closed'
}

/**
 * The single canonical vocabulary of "still entitled" subscription statuses.
 *
 * Both the subscription layer (subscriptionStatusIsActive, below) and the
 * entitlement layer (isEntitlementActive in iapEntitlements.mjs) derive from
 * this set, so the two can no longer drift apart. Previously a subscription in
 * grace_period or cancelled_but_active_until_expiry was reported active by the
 * subscription layer and then rejected by the entitlement layer, surfacing as
 * Free before expires_at.
 *
 * billing_retry is deliberately NOT active: Apple's billing-retry period means
 * the renewal has FAILED and is being retried, so it must not silently extend
 * access. Terminal states (expired/revoked/refunded) and non-committal ones
 * (verification_pending/unknown) are likewise inactive.
 */
export const SUBSCRIPTION_ACTIVE_STATUSES = Object.freeze([
  'active',
  'grace_period',
  'cancelled_but_active_until_expiry',
])

/** Statuses that authoritatively END access, even when out of expiry order. */
export const SUBSCRIPTION_TERMINAL_STATUSES = Object.freeze(['revoked', 'refunded'])

export function subscriptionStatusIsActive(status, expiresAt, nowMs = Date.now()) {
  if (!SUBSCRIPTION_ACTIVE_STATUSES.includes(status)) return false
  const expiresMs = expiresAt ? new Date(expiresAt).getTime() : NaN
  return Number.isFinite(expiresMs) && expiresMs > nowMs
}

/** Require verified Apple lineage and account-token provenance. */
export function assertSubscriptionIdentity(verified) {
  if (!verified?.originalTransactionId) throw new Error('Verified subscription is missing originalTransactionId')
  if (!verified?.appAccountToken) throw new SubscriptionAccountTokenError('Subscription is missing appAccountToken')
}

/**
 * Authoritative anonymity check for an EXISTING binding's owner. Never trust
 * a client-supplied or cached flag — this always re-reads Supabase Auth's own
 * `is_anonymous` via the admin API for the given user id.
 */
export async function isAnonymousUser(db, userId) {
  if (!userId) return false
  const { data, error } = await db.auth.admin.getUserById(userId)
  if (error) throw error
  return Boolean(data?.user?.is_anonymous)
}

/** Deterministic Apple period/event ordering; equal-period terminal states stay terminal. */
export function shouldReplaceSubscriptionState(stored, incoming) {
  if (!stored) return true
  const ms = (v) => v ? Date.parse(v) : NaN
  const oldStart = ms(stored.purchased_at), newStart = ms(incoming.purchased_at)
  if (!Number.isFinite(oldStart) || !Number.isFinite(newStart)) return false
  if (newStart !== oldStart) return newStart > oldStart
  const rank = (status) => ({ refunded: 60, revoked: 50, expired: 40, billing_retry: 30,
    cancelled_but_active_until_expiry: 20, grace_period: 20, active: 10 })[status] ?? 0
  const oldRank = rank(stored.status), newRank = rank(incoming.status)
  if (oldRank >= 40 && newRank < oldRank) return false
  const oldEvent = ms(stored.apple_event_at), newEvent = ms(incoming.apple_event_at)
  if (Number.isFinite(oldEvent) && (!Number.isFinite(newEvent) || newEvent < oldEvent)) return false
  if (oldEvent === newEvent && newRank < oldRank) return false
  if (!Number.isFinite(oldEvent) && !Number.isFinite(newEvent) && newRank < oldRank) return false
  if (newRank >= 40) return true
  return ms(incoming.expires_at) >= ms(stored.expires_at)
}

async function persistAtomic(db, userId, verified, options = {}) {
  assertSubscriptionIdentity(verified)
  const { data, error } = await db.rpc('persist_verified_subscription', {
    p_user_id: userId, p_transaction: verified, p_options: options,
  })
  if (error) {
    const reason = String(error.message ?? '')
    if (reason.includes('subscription_token_mismatch')) throw new SubscriptionAccountTokenError('Subscription token does not match this account')
    if (reason.includes('subscription_owner_conflict')) throw new SubscriptionAlreadyLinkedError('Subscription is linked to another account')
    if (reason.includes('subscription_account_deleted')) throw new SubscriptionDeletedAccountError('Deleted subscription owner requires reviewed recovery')
    if (reason.includes('subscription_environment_not_allowed')) throw new SubscriptionEnvironmentError('Subscription is not available in this environment')
    if (reason.includes('subscription_sales_closed')) throw new SubscriptionSalesClosedError('Subscription sales are closed')
    throw Object.assign(new Error('Subscription persistence failed'), { code: 'IAP_DB_ERROR' })
  }
  if (!data || data.user_id !== userId || data.original_transaction_id !== verified.originalTransactionId) {
    throw Object.assign(new Error('Subscription persistence returned an invalid owner'), { code: 'IAP_DB_ERROR' })
  }
  return data
}

/** Composite state keys are retained for schema compatibility; grants require a canonical owner. */
async function loadSubscriptionState(db, originalTransactionId, userId) {
  if (!originalTransactionId || !userId) return null
  const { data, error } = await db
    .from('app_store_subscription_states')
    .select('user_id, product_id, status, purchased_at, expires_at, auto_renew_status')
    .eq('original_transaction_id', originalTransactionId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return data ?? null
}

/** Existing state lookup supports legacy guests created before canonical binding enforcement. */
export async function findSubscriptionState(db, originalTransactionId, userId) {
  return loadSubscriptionState(db, originalTransactionId, userId)
}

/** Enumerate historical state holders for diagnostics; this list does not authorize access. */
export async function listSubscriptionStateUserIds(db, originalTransactionId) {
  if (!originalTransactionId) return []
  const { data, error } = await db
    .from('app_store_subscription_states')
    .select('user_id')
    .eq('original_transaction_id', originalTransactionId)
  if (error) throw error
  return Array.from(new Set((data ?? []).map((row) => row.user_id).filter(Boolean)))
}

// Both notifications and authenticated reconciliation use the same atomic operation.
export async function upsertSubscriptionState(db, userId, verified, options = {}) {
  return persistAtomic(db, userId, verified, options)
}

export async function verifyAndPersistSubscription(db, userId, verified, options = {}) {
  return persistAtomic(db, userId, verified, options)
}

export async function findSubscriptionBinding(db, originalTransactionId) {
  if (!originalTransactionId) return null
  const { data, error } = await db
    .from('app_store_subscription_bindings')
    .select('original_transaction_id, user_id, environment, owner_state')
    .eq('original_transaction_id', originalTransactionId)
    .maybeSingle()
  if (error) throw error
  return data ?? null
}

export async function getEffectiveSubscription(db, userId) {
  const { data, error } = await db
    .from('app_store_subscription_states')
    .select('product_id, original_transaction_id, latest_transaction_id, subscription_group_id, environment, app_account_token, purchased_at, expires_at, auto_renew_status, status, revocation_at, last_verified_at')
    .eq('user_id', userId)
    .order('expires_at', { ascending: false })
    .limit(10)
  if (error) throw error
  const rows = []
  for (const row of Array.isArray(data) ? data : []) {
    const binding = await findSubscriptionBinding(db, row.original_transaction_id)
    // Existing canonical owners keep access, including legacy token provenance.
    // Every granted state must have a canonical owner; migration preflight checks existing rows.
    const authorized = binding
      ? binding.owner_state === 'active' && binding.user_id === userId && binding.environment === row.environment
      : false
    let environmentAllowed = row.environment === 'Production'
    if (!environmentAllowed && authorized) {
      const { data: policy, error: policyError } = await db.from('subscription_test_chain_policy')
        .select('user_id').eq('user_id', userId).eq('original_transaction_id', row.original_transaction_id)
        .eq('environment', row.environment).maybeSingle()
      if (policyError) throw policyError
      environmentAllowed = Boolean(policy)
    }
    if (authorized && environmentAllowed) rows.push(row)
  }
  if (rows.length === 0) return null
  const ranked = rows.map((row) => ({
    ...row,
    active: subscriptionStatusIsActive(row.status, row.expires_at),
  }))
  return ranked.find((row) => row.active) ?? ranked[0]
}

export function safeSubscriptionEntitlement(state) {
  if (!state) return null
  const status = state.status
  const expiresAt = state.expires_at ?? null
  // For auto-renewables, Apple's expiresDate is the current period end / next renewal boundary.
  const renewalDate = state.auto_renew_status === false ? null : expiresAt
  return {
    active: Boolean(state.active),
    status,
    productId: state.product_id,
    planType: 'student_pass',
    environment: state.environment ?? null,
    startsAt: state.purchased_at,
    expiresAt,
    expirationDate: expiresAt,
    renewalDate,
    originalTransactionId: state.original_transaction_id,
    latestTransactionId: state.latest_transaction_id,
    subscriptionGroupId: state.subscription_group_id,
    autoRenewStatus: state.auto_renew_status,
    revocationAt: state.revocation_at,
    lastVerifiedAt: state.last_verified_at,
    verificationTimestamp: state.last_verified_at,
    source: 'app_store_subscription',
  }
}
