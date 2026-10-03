import { NotificationTypeV2, Subtype } from '@apple/app-store-server-library'

export const SUBSCRIPTION_PRODUCT_IDS = new Set([
  'com.aydenz.youmilensipad.student.monthly',
  'com.aydenz.youmilensipad.student.annual',
])

export class SubscriptionAlreadyLinkedError extends Error {}
export class SubscriptionAccountTokenError extends Error {}

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
  if (status === 'grace_period') return true
  return Number.isFinite(expiresMs) && expiresMs > nowMs
}

/** Require verified Apple lineage and account-token provenance. */
export function assertSubscriptionIdentity(verified) {
  if (!verified?.originalTransactionId) throw new Error('Verified subscription is missing originalTransactionId')
  if (!verified?.appAccountToken) throw new SubscriptionAccountTokenError('Subscription is missing appAccountToken')
}

function assertSubscriptionAccountToken(userId, verified) {
  if (!userId || String(verified.appAccountToken).toLowerCase() !== String(userId).toLowerCase()) {
    throw new SubscriptionAccountTokenError('Subscription appAccountToken does not match this account')
  }
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

/**
 * Canonical ownership applies to permanent AND anonymous callers. Existing
 * owners retain access; a first claim must match the signed appAccountToken.
 * A permanent caller may promote a legacy anonymous binding only with a
 * matching signed token and a successful conditional ownership update.
 */
export async function claimSubscriptionBinding(db, userId, verified, { isAnonymous = false } = {}) {
  assertSubscriptionIdentity(verified)
  const { data: existing, error: readError } = await db
    .from('app_store_subscription_bindings')
    .select('original_transaction_id, user_id, app_account_token, environment, owner_state')
    .eq('original_transaction_id', verified.originalTransactionId)
    .maybeSingle()
  if (readError) throw readError

  if (existing) {
    if (existing.owner_state !== 'active') {
      throw new SubscriptionAlreadyLinkedError('Subscription is already linked to another account')
    }
    if (existing.user_id === userId) {
      if (existing.environment !== verified.environment) throw new Error('Subscription environment binding mismatch')
      return existing
    }
    if (isAnonymous) throw new SubscriptionAlreadyLinkedError('Subscription is already linked to another account')
    const existingOwnerIsAnonymous = await isAnonymousUser(db, existing.user_id)
    if (!existingOwnerIsAnonymous) {
      throw new SubscriptionAlreadyLinkedError('Subscription is already linked to another account')
    }
    assertSubscriptionAccountToken(userId, verified)
    const promoted = {
      original_transaction_id: verified.originalTransactionId,
      user_id: userId,
      app_account_token: verified.appAccountToken,
      environment: verified.environment,
      owner_state: 'active',
    }
    if (existing.environment !== verified.environment) throw new Error('Subscription environment binding mismatch')
    const { data: claimed, error: promoteError } = await db
      .from('app_store_subscription_bindings')
      .update(promoted)
      .eq('original_transaction_id', verified.originalTransactionId)
      .eq('user_id', existing.user_id)
      .eq('owner_state', 'active')
      .eq('environment', verified.environment)
      .select('original_transaction_id, user_id, app_account_token, environment, owner_state')
      .maybeSingle()
    if (promoteError) throw promoteError
    if (!claimed || claimed.user_id !== userId || claimed.owner_state !== 'active' || claimed.environment !== verified.environment) {
      throw new SubscriptionAlreadyLinkedError('Subscription ownership claim lost a race')
    }
    return claimed
  }

  assertSubscriptionAccountToken(userId, verified)
  const row = {
    original_transaction_id: verified.originalTransactionId,
    user_id: userId,
    app_account_token: verified.appAccountToken,
    environment: verified.environment,
    owner_state: 'active',
  }
  const { error } = await db.from('app_store_subscription_bindings').insert(row)
  if (!error) return row
  if (error.code === '23505') {
    const { data: raced, error: raceError } = await db
      .from('app_store_subscription_bindings')
      .select('original_transaction_id, user_id, app_account_token, environment, owner_state')
      .eq('original_transaction_id', verified.originalTransactionId)
      .maybeSingle()
    if (raceError) throw raceError
    if (raced?.owner_state === 'active' && raced.user_id === userId && raced.environment === verified.environment) return raced
    throw new SubscriptionAlreadyLinkedError('Subscription is already linked to another account')
  }
  throw error
}

/**
 * Decide whether an incoming subscription state may replace the stored one.
 *
 * Every renewal, plan change, and trial-to-paid transition inside one Apple
 * auto-renewable lineage shares a single originalTransactionId — which is this
 * table's conflict key — so all of them collapse onto ONE row. Restore submits
 * the full StoreKit history (Transaction.all), and App Store Server
 * Notifications can arrive out of order, so without this guard an OLDER
 * transaction can silently overwrite a NEWER valid subscription state.
 *
 * Chronology signal: purchaseDate (the period's own start), which strictly
 * advances across renewals and plan changes. expires_at alone is NOT sufficient
 * — a refund/revoke must be able to end access without carrying a later expiry.
 *
 * Policy:
 *   - no stored row                         -> accept (first write)
 *   - incoming period is newer              -> accept (renewal / plan change)
 *   - incoming period is older              -> REJECT (stale restore item or
 *                                              out-of-order notification)
 *   - same period, terminal event           -> accept (refund/revoke of the
 *                                              current period is authoritative)
 *   - same period, expiry not going backward-> accept (replay / metadata refresh)
 *   - same period, expiry going backward    -> REJECT
 *
 * A terminal event for an OLDER period is rejected on purpose: refunding a
 * past period must not revoke a newer, still-valid one.
 */
export function shouldReplaceSubscriptionState(stored, incoming) {
  if (!stored) return true
  const ms = (v) => (v ? new Date(v).getTime() : NaN)
  const storedStart = ms(stored.purchased_at)
  const incomingStart = ms(incoming.purchased_at)
  // A terminal period cannot be revived without a provably newer Apple period.
  if (SUBSCRIPTION_TERMINAL_STATUSES.includes(stored.status) && !SUBSCRIPTION_TERMINAL_STATUSES.includes(incoming.status) &&
      !(Number.isFinite(incomingStart) && Number.isFinite(storedStart) && incomingStart > storedStart)) return false
  // Without usable chronology on either side, fall back to accepting the write
  // rather than freezing the row forever.
  if (!Number.isFinite(storedStart) || !Number.isFinite(incomingStart)) return true
  if (incomingStart > storedStart) return true
  if (incomingStart < storedStart) return false

  if (SUBSCRIPTION_TERMINAL_STATUSES.includes(incoming.status)) return true
  const storedExpiry = ms(stored.expires_at)
  const incomingExpiry = ms(incoming.expires_at)
  if (!Number.isFinite(storedExpiry) || !Number.isFinite(incomingExpiry)) return true
  return incomingExpiry >= storedExpiry
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

export async function upsertSubscriptionState(db, userId, verified, {
  renewal = null,
  notificationType = null,
  subtype = null,
  source = 'storekit_jws',
} = {}) {
  const stored = await loadSubscriptionState(db, verified.originalTransactionId, userId)

  // Renewal metadata merge: ABSENT incoming metadata must never destroy
  // known-good stored state. The restore path carries no renewalInfo at all, so
  // without this a restore would blank auto_renew_status and downgrade a
  // cancelled-but-still-valid subscription back to a plain "active" reading.
  const storedAutoRenew = stored?.auto_renew_status ?? null
  const effectiveRenewal =
    renewal ?? (storedAutoRenew === null ? null : { autoRenewStatus: storedAutoRenew })

  const status = deriveSubscriptionStatus({ transaction: verified, renewal: effectiveRenewal, notificationType, subtype })
  const row = {
    original_transaction_id: verified.originalTransactionId,
    user_id: userId,
    product_id: verified.productId,
    latest_transaction_id: verified.transactionId,
    subscription_group_id: verified.subscriptionGroupId,
    environment: verified.environment,
    ownership_type: verified.ownershipType,
    app_account_token: verified.appAccountToken,
    purchased_at: verified.purchaseDate,
    expires_at: verified.appleExpiresDate,
    auto_renew_status: effectiveRenewal?.autoRenewStatus ?? null,
    status,
    revocation_at: verified.revokedAt,
    source,
    last_notification_type: notificationType,
    last_verified_at: new Date().toISOString(),
  }

  // Stale-write protection. A rejected write is NOT an error — restore
  // legitimately replays historical transactions — so the stored (newer) state
  // is returned unchanged and the caller proceeds normally.
  if (!shouldReplaceSubscriptionState(stored, row)) {
    return {
      ...row,
      product_id: stored.product_id,
      status: stored.status,
      purchased_at: stored.purchased_at,
      expires_at: stored.expires_at,
      auto_renew_status: stored.auto_renew_status ?? null,
      active: subscriptionStatusIsActive(stored.status, stored.expires_at),
      stale: true,
    }
  }

  const { error } = await db
    .from('app_store_subscription_states')
    .upsert(row, { onConflict: 'original_transaction_id,user_id' })
  if (error) throw error
  return { ...row, active: subscriptionStatusIsActive(status, row.expires_at) }
}

/** All authenticated callers must claim canonical ownership before state creation. */
export async function verifyAndPersistSubscription(db, userId, verified, { isAnonymous = false } = {}) {
  await claimSubscriptionBinding(db, userId, verified, { isAnonymous })
  return upsertSubscriptionState(db, userId, verified)
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
    // Unbound legacy guest rows are accepted only for their original token owner.
    const authorized = binding
      ? binding.owner_state === 'active' && binding.user_id === userId && binding.environment === row.environment
      : String(row.app_account_token ?? '').toLowerCase() === String(userId).toLowerCase()
    if (authorized) rows.push(row)
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
