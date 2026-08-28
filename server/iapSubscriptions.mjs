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

/**
 * Presence-only sanity check on the verified transaction. This intentionally
 * does NOT compare appAccountToken to a requesting user id anymore — see the
 * module doc comment above `claimSubscriptionBinding` for why an equality
 * check there was wrong for the Guest-restore case. `appAccountToken` is
 * still required to exist (a legitimate StoreKit 2 transaction for a product
 * this app configures always carries one), and is retained purely as
 * original-purchase provenance / diagnostic metadata.
 */
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

/**
 * Canonical PERMANENT-account ownership claim for an Apple subscription
 * lineage. Anonymous (Guest) callers must NEVER reach this function — see
 * `verifyAndPersistSubscription`'s `isAnonymous` branch, which routes Guests
 * straight to their own `app_store_subscription_states` row instead.
 *
 * Ownership model (App Review 5.1.1(v) clarification):
 *   - no existing binding                    -> this permanent account claims it
 *   - existing binding, same permanent user  -> idempotent success
 *   - existing binding, owner is ANONYMOUS   -> promote: this permanent
 *       account becomes the canonical owner. Safe because the caller only
 *       reaches here with a server-verified Apple transaction for T — Apple
 *       only ever hands that to a device actually authorized for T, so
 *       "promote" can only happen for someone who legitimately restored it.
 *   - existing binding, owner is a DIFFERENT permanent user -> reject
 *       (SubscriptionAlreadyLinkedError). This is the one case that must
 *       never move — an unrelated real account can never take over T.
 *
 * appAccountToken is stored for provenance but is NOT used to gate any of
 * this — it is permanently fixed to whichever identity made the ORIGINAL
 * purchase and therefore cannot equal a different device's restoring/
 * upgrading identity even when that identity is the legitimate owner.
 */
export async function claimSubscriptionBinding(db, userId, verified) {
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
    const existingOwnerIsAnonymous = await isAnonymousUser(db, existing.user_id)
    if (!existingOwnerIsAnonymous) {
      throw new SubscriptionAlreadyLinkedError('Subscription is already linked to another account')
    }
    const promoted = {
      original_transaction_id: verified.originalTransactionId,
      user_id: userId,
      app_account_token: verified.appAccountToken,
      environment: verified.environment,
      owner_state: 'active',
    }
    const { error: promoteError } = await db
      .from('app_store_subscription_bindings')
      .update(promoted)
      .eq('original_transaction_id', verified.originalTransactionId)
      .eq('user_id', existing.user_id)
    if (promoteError) throw promoteError
    return promoted
  }

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

/**
 * `app_store_subscription_states` is now keyed by (original_transaction_id,
 * user_id) — every legitimately-verified identity holding entitlement from
 * lineage T (Guest X, Guest Y, and/or a permanent account) has its OWN row.
 * Loads/writes are therefore always scoped by BOTH columns; never by
 * original_transaction_id alone, or one identity's write would read/replace
 * another's.
 */
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

/** Public wrapper — used by the sales kill-switch check (Guests never hold a binding, so it must consult their OWN state row instead). */
export async function findSubscriptionState(db, originalTransactionId, userId) {
  return loadSubscriptionState(db, originalTransactionId, userId)
}

/** Every distinct user_id currently holding an entitlement row for lineage T — used to sweep renewal/expiration/revocation notifications across every Guest + permanent identity, not just the canonical binding owner. */
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

/**
 * Grant/refresh entitlement for lineage T on behalf of `userId`.
 *
 * - Permanent (non-anonymous) caller: goes through `claimSubscriptionBinding`
 *   first — canonical ownership is a permanent-account-only concept (see that
 *   function's doc comment for the full rule).
 * - Anonymous (Guest) caller: NEVER touches `app_store_subscription_bindings`
 *   — no read, no write, no claim. A verified Apple transaction is
 *   sufficient on its own to grant/refresh THIS Guest's own state row. This
 *   is what lets Guest X (device A) and Guest Y (device B) both hold active
 *   entitlement from the same restored lineage without either rebinding or
 *   displacing the other — see `upsertSubscriptionState`'s composite key.
 */
export async function verifyAndPersistSubscription(db, userId, verified, { isAnonymous = false } = {}) {
  if (!isAnonymous) {
    await claimSubscriptionBinding(db, userId, verified)
  } else {
    assertSubscriptionIdentity(verified)
  }
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
    .select('product_id, original_transaction_id, latest_transaction_id, subscription_group_id, environment, purchased_at, expires_at, auto_renew_status, status, revocation_at, last_verified_at')
    .eq('user_id', userId)
    .order('expires_at', { ascending: false })
    .limit(10)
  if (error) throw error
  const rows = Array.isArray(data) ? data : []
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
