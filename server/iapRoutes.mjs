/**
 * Apple IAP routes (server is the source of truth).
 *
 *   POST /api/iap/apple/verify         — verify StoreKit 2 signed transactions
 *                                        (auto-renewable + legacy Student Access).
 *   GET  /api/iap/entitlement          — normalized effective entitlement.
 *   POST /api/iap/restore              — re-verify + restore prior purchases.
 *   POST /api/iap/apple/notifications  — App Store Server Notifications V2
 *                                        (renew/fail/expire/refund/revoke/grace/retry).
 *   POST /api/iap/verify               — legacy alias for /api/iap/apple/verify.
 *
 * Auto-renewable subscriptions persist to app_store_subscription_* tables.
 * Legacy consumable/non-consumable SKUs keep the apple_iap_transactions +
 * user_entitlements path. One Apple original_transaction_id binds to exactly
 * one Youmi Lens account. Secrets/JWS/JWT are never logged.
 */
import { createClient } from '@supabase/supabase-js'
import { NotificationTypeV2 } from '@apple/app-store-server-library'
import { subscriptionAvailability } from './subscriptionAvailability.mjs'
import { buildQuotaStatus } from './betaUsageStatus.mjs'
import { BETA_ERROR_CODES, getOrCreateUserQuota } from './betaGate.mjs'
import { verifyAppleTransaction, verifyAppleNotification } from './iapApple.mjs'
import {
  isAppleIapLedgerUnavailableError,
  insertAppleIapTransaction,
  updateAppleIapTransactionByTransactionId,
  revokeAppleIapTransaction,
} from './iapLedger.mjs'
import {
  decideGrantWithBinding,
  loadBillingProduct,
  findTransactionBinding,
  findTransactionOwner,
  getActiveEntitlement,
  getEntitlementBySourceTransactionId,
  getLatestStackableEntitlementExpiry,
  getLatestStudentPassEntitlement,
  getLatestRevocationEventType,
  deriveInactiveEntitlementStatus,
  safeEntitlementSnapshot,
  recordBillingEvent,
  reserveNotification,
  markNotificationProcessed,
  markNotificationFailed,
} from './iapEntitlements.mjs'
import {
  SubscriptionAlreadyLinkedError,
  SubscriptionAccountTokenError,
  SubscriptionDeletedAccountError,
  SubscriptionEnvironmentError,
  SubscriptionSalesClosedError,
  findSubscriptionBinding,
  getEffectiveSubscription,
  isAutoRenewableProduct,
  safeSubscriptionEntitlement,
  upsertSubscriptionState,
  verifyAndPersistSubscription,
} from './iapSubscriptions.mjs'

/** ASN V2 types that refresh subscription state (idempotent upsert). */
const SUBSCRIPTION_STATUS_NOTIFICATIONS = new Set([
  NotificationTypeV2.DID_RENEW,
  NotificationTypeV2.DID_FAIL_TO_RENEW,
  NotificationTypeV2.EXPIRED,
  NotificationTypeV2.GRACE_PERIOD_EXPIRED,
  NotificationTypeV2.OFFER_REDEEMED,
  NotificationTypeV2.PRICE_INCREASE,
  NotificationTypeV2.REFUND,
  NotificationTypeV2.REFUND_REVERSED,
  NotificationTypeV2.REVOKE,
  NotificationTypeV2.SUBSCRIBED,
  NotificationTypeV2.DID_CHANGE_RENEWAL_STATUS,
  NotificationTypeV2.DID_CHANGE_RENEWAL_PREF,
  NotificationTypeV2.RENEWAL_EXTENDED,
  NotificationTypeV2.RENEWAL_EXTENSION,
])

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY

class AlreadyLinkedError extends Error {}
class DeletedAccountBindingError extends Error {}

function makeAdminClient() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return null
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

function makeAnonClient(token) {
  if (!SUPABASE_URL || !ANON_KEY) return null
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

async function requireUser(req, res) {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!token) {
    res.status(401).json({ ok: false, error: BETA_ERROR_CODES.AUTH_REQUIRED, message: 'Sign in required.' })
    return null
  }
  const anon = makeAnonClient(token)
  if (!anon) {
    res.status(503).json({ ok: false, error: 'server_not_configured', message: 'Server auth is not configured.' })
    return null
  }
  const { data, error } = await anon.auth.getUser(token)
  const user = data?.user
  if (error || !user?.id) {
    res.status(401).json({ ok: false, error: BETA_ERROR_CODES.AUTH_REQUIRED, message: 'Invalid or expired session.' })
    return null
  }
  // Authoritative, server-verified — never a client-supplied boolean. Gates
  // whether a caller may touch app_store_subscription_bindings at all (see
  // claimSubscriptionBinding's doc comment in iapSubscriptions.mjs).
  return { userId: user.id, email: user.email || '', isAnonymous: Boolean(user.is_anonymous) }
}

// ── DB writes (ownership-safe + idempotent) ──────────────────────────────────

function transactionRow(userId, verified, product, status) {
  return {
    user_id: userId,
    product_id: verified.productId,
    plan_type: product.plan_type,
    transaction_id: verified.transactionId,
    original_transaction_id: verified.originalTransactionId,
    environment: verified.environment,
    status,
    purchase_date: verified.purchaseDate,
    apple_expires_date: verified.appleExpiresDate,
    revoked_at: verified.revokedAt,
    raw_transaction: verified.rawTransaction,
    last_verified_at: new Date().toISOString(),
    owner_state: 'active',
    account_deleted_at: null,
  }
}

/**
 * Persist the verified transaction WITHOUT ever reassigning ownership. A
 * re-verify by the same user updates in place; a brand-new transaction is
 * inserted; a unique-violation race is resolved by re-reading the owner.
 */
async function persistTransaction(db, userId, verified, product, status, binding) {
  if (binding?.ownerState === 'account_deleted') {
    throw new DeletedAccountBindingError('deleted account binding')
  }
  if (binding?.userId === userId) {
    const { error } = await updateAppleIapTransactionByTransactionId(
      db,
      verified.transactionId,
      {
        status,
        purchase_date: verified.purchaseDate,
        apple_expires_date: verified.appleExpiresDate,
        revoked_at: verified.revokedAt,
        raw_transaction: verified.rawTransaction,
        last_verified_at: new Date().toISOString(),
        owner_state: 'active',
        account_deleted_at: null,
      },
    )
    if (error) throw error
    return
  }

  const { error } = await insertAppleIapTransaction(db, transactionRow(userId, verified, product, status))
  if (error) {
    if (error.code === '23505') {
      const latestBinding = await findTransactionBinding(db, verified)
      if (latestBinding?.ownerState === 'account_deleted') {
        throw new DeletedAccountBindingError('deleted account binding')
      }
      if (latestBinding?.userId && latestBinding.userId !== userId) throw new AlreadyLinkedError('already linked')
      return // concurrent insert by the same user — fine
    }
    throw error
  }
}

/** Grant an ACTIVE entitlement. Consumables stack atomically in PostgreSQL. */
export async function grantEntitlement(db, userId, verified, product, window) {
  if (product.kind === 'consumable') {
    const { data, error } = await db.rpc('grant_consumable_entitlement', {
      p_user_id: userId,
      p_product_id: verified.productId,
      p_source_transaction_id: verified.transactionId,
      p_purchase_date: verified.purchaseDate,
    })
    if (error) throw error
    return Array.isArray(data) ? data[0] ?? null : data
  }

  const { error } = await db
    .from('user_entitlements')
    .upsert(
      {
        user_id: userId,
        product_id: verified.productId,
        plan_type: product.plan_type,
        source_transaction_id: verified.transactionId,
        starts_at: window.startsAt,
        expires_at: window.expiresAt,
        status: 'active',
        revoked_at: null,
      },
      { onConflict: 'source_transaction_id' },
    )
  if (error) throw error
}

/** Mark an entitlement + its transaction revoked (refund / revoke). */
async function revokeByTransaction(db, transactionId, revokedAtIso) {
  const revoked_at = revokedAtIso || new Date().toISOString()
  const { error: entErr } = await db
    .from('user_entitlements')
    .update({ status: 'revoked', revoked_at })
    .eq('source_transaction_id', transactionId)
  if (entErr) throw entErr
  const { error: txErr } = await revokeAppleIapTransaction(db, transactionId, revoked_at)
  if (txErr) throw txErr
}

// ── Verify (core) ────────────────────────────────────────────────────────────

export function safeIapError(err) {
  if (err instanceof SubscriptionDeletedAccountError) return { status: 409, error: 'iap_deleted_account_binding', message: 'This subscription needs account recovery review.' }
  if (err instanceof SubscriptionEnvironmentError) return { status: 403, error: 'environment_not_allowed', message: 'This subscription belongs to a test environment.' }
  if (err instanceof SubscriptionSalesClosedError) return { status: 403, error: 'sales_closed', message: 'Subscriptions currently unavailable.' }
  if (isAppleIapLedgerUnavailableError(err)) {
    return { status: 503, error: 'iap_temporarily_unavailable', message: 'In-app purchase service is temporarily unavailable.' }
  }
  if (
    ['IAP_DB_ERROR', 'PGRST202', '42P01', 'PGRST205', '42501', '42703', '23514', 'PGRST100', '57014'].includes(String(err?.code ?? '')) ||
    /fetch failed|timeout|timed out/i.test(String(err?.message ?? ''))
  ) {
    return { status: 503, error: 'iap_temporarily_unavailable', message: 'In-app purchase service is temporarily unavailable.' }
  }
  if (err instanceof AlreadyLinkedError) {
    return { status: 409, error: 'iap_already_linked', message: 'This App Store purchase is already linked to another account.' }
  }
  if (err instanceof DeletedAccountBindingError) {
    return { status: 409, error: 'iap_deleted_account_binding', message: 'This App Store purchase is linked to another account.' }
  }
  if (err instanceof SubscriptionAlreadyLinkedError) {
    return { status: 409, error: 'iap_already_linked', message: 'This App Store subscription is already linked to another account.' }
  }
  if (err instanceof SubscriptionAccountTokenError) {
    // Client-facing code is normalized to the SAME `iap_already_linked` the
    // client already handles (distinct SubscriptionResultCode, distinct
    // non-Restore-suggesting copy) — this and SubscriptionAlreadyLinkedError
    // are the same product-level condition: this Apple subscription lineage
    // belongs to another Youmi Lens account. Internal diagnostics still tell
    // the two apart via `errorClass` in logIapFailure (see below); no
    // previous account/transaction identifier is ever included here.
    return { status: 409, error: 'iap_already_linked', message: 'This App Store subscription is already linked to another account.' }
  }
  const message = err instanceof Error ? err.message : 'IAP verification failed'
  if (message.includes('not configured') || message.includes('root certificates') || message.includes('APPLE_')) {
    return { status: 503, error: 'iap_not_configured', message: 'In-app purchase verification is not configured.' }
  }
  return { status: 400, error: 'iap_verification_failed', message: 'Purchase could not be verified.' }
}

/**
 * Verify one purchase payload and persist transaction + entitlement idempotently.
 * Returns { granted:boolean, code? } — throws on verification/DB failure.
 */
async function verifyAndPersist(db, user, payload) {
  const verified = await verifyAppleTransaction(payload)
  safeSubscriptionStage('apple_verify_ok', user, {
    productId: verified.productId,
    environment: verified.environment,
    hasOriginalTransactionId: Boolean(verified.originalTransactionId),
    hasAppAccountToken: Boolean(verified.appAccountToken),
    hasExpiresDate: Boolean(verified.appleExpiresDate),
    subscriptionGroupId: verified.subscriptionGroupId ?? null,
    ownershipType: verified.ownershipType ?? null,
  })
  const product = await loadBillingProduct(db, verified.productId)
  // Distinguishes "catalog row missing/misconfigured" from every other
  // rejection: without this an unseeded product silently falls through to the
  // legacy path and returns `unknown_product` with no trace.
  safeSubscriptionStage('product_lookup', user, {
    productId: verified.productId,
    productFound: Boolean(product),
    productKind: product?.kind ?? null,
    autoRenewable: isAutoRenewableProduct(product),
  })
  if (verified.autoRenewable || isAutoRenewableProduct(product)) {
    const existingBinding = await findSubscriptionBinding(db, verified.originalTransactionId)
    // Sales admission controls starting StoreKit, never delivery after Apple succeeds.
    // REAL verification, signed token and canonical ownership still fail closed.
    safeSubscriptionStage('binding_lookup', user, {
      productId: verified.productId,
      callerIsAnonymous: user.isAnonymous,
      bindingExists: Boolean(existingBinding),
      bindingIsSameUser: existingBinding ? existingBinding.user_id === user.userId : null,
      bindingOwnerState: existingBinding?.owner_state ?? null,
    })
    const subscription = await verifyAndPersistSubscription(db, user.userId, verified, { purchaseAuthorizationId: payload.purchaseAuthorizationId ?? null })
    safeSubscriptionStage('subscription_state_write_ok', user, {
      productId: verified.productId,
      status: subscription.status,
      active: subscription.active,
    })
    await recordBillingEvent(db, user.userId, {
      event_type: existingBinding
        ? (subscription.active ? 'subscription_renewed' : 'subscription_status_changed')
        : (subscription.active ? 'subscription_started' : 'subscription_status_changed'),
      product_id: verified.productId,
      transaction_id: verified.transactionId,
      environment: verified.environment,
      detail: { status: subscription.status },
    })
    return {
      granted: subscription.active,
      safeToFinish: !verified.revoked && (subscription.active || subscription.status === 'expired'),
      code: subscription.status,
      transactionId: verified.transactionId,
      entitlement: safeSubscriptionEntitlement({ ...subscription, active: subscription.active }),
    }
  }
  const binding = await findTransactionBinding(db, verified)
  const existingGrant = binding?.userId === user.userId
    ? await getEntitlementBySourceTransactionId(db, verified.transactionId)
    : null

  if (existingGrant) {
    await persistTransaction(db, user.userId, verified, product, existingGrant.status, binding)
    return {
      granted:
        existingGrant.status === 'active' &&
        !existingGrant.revoked_at &&
        new Date(existingGrant.expires_at).getTime() > Date.now(),
      safeToFinish: !verified.revoked,
      code: 'idempotent_replay',
      transactionId: verified.transactionId,
    }
  }

  const existingEntitlementExpiresAt = product?.kind === 'consumable'
    ? await getLatestStackableEntitlementExpiry(db, user.userId)
    : null

  const decision = decideGrantWithBinding({
    verified,
    product,
    binding,
    requestingUserId: user.userId,
    existingEntitlementExpiresAt,
    nowMs: Date.now(),
  })

  if (!decision.ok) {
    await recordBillingEvent(db, user.userId, decision.event)
    if (decision.code === 'already_linked') throw new AlreadyLinkedError(decision.message)
    if (decision.code === 'account_deleted') throw new DeletedAccountBindingError(decision.message)
    return { granted: false, code: decision.code, message: decision.message, transactionId: verified.transactionId }
  }

  const ledgerStatus = decision.active ? 'active' : decision.entitlementStatus
  await persistTransaction(db, user.userId, verified, product, ledgerStatus, binding)

  if (decision.active) {
    await grantEntitlement(db, user.userId, verified, product, decision.window)
  }
  await recordBillingEvent(db, user.userId, { ...decision.event, event_type: 'verify_ok' })
  await recordBillingEvent(db, user.userId, decision.event)
  return { granted: decision.active, safeToFinish: !verified.revoked, code: decision.active ? 'granted' : decision.entitlementStatus, transactionId: verified.transactionId }
}

export async function handleIapVerify(req, res) {
  const user = await requireUser(req, res)
  if (!user) return
  if (req.body?.platform !== 'ios') {
    res.status(400).json({ ok: false, error: 'unsupported_platform', message: 'Only iOS purchases are supported.' })
    return
  }
  const db = makeAdminClient()
  if (!db) {
    res.status(503).json({ ok: false, error: 'server_not_configured', message: 'Server database is not configured.' })
    return
  }

  try {
    const result = await verifyAndPersist(db, user, req.body)
    const quotaStatus = await buildQuotaStatus(user.userId, user.email)
    const entitlement = result.entitlement ?? quotaStatus?.entitlement ?? null
    if (!result.granted) {
      logIapOutcome('verify', user, result)
      res.status(result.code === 'sales_closed' ? 403 : 200).json({
        ok: result.code !== 'sales_closed' && result.code !== 'unknown_product',
        granted: false,
        safeToFinish: Boolean(result.safeToFinish),
        reason: result.code,
        message: result.message ?? null,
        planType: quotaStatus?.planType ?? null,
        entitlement,
        quotaStatus,
      })
      return
    }
    res.json({
      ok: true,
      granted: true,
      safeToFinish: Boolean(result.safeToFinish),
      planType: quotaStatus?.planType ?? null,
      entitlement,
      quotaStatus,
    })
  } catch (err) {
    logIapFailure('verify', user, req.body, err)
    const safe = safeIapError(err)
    res.status(safe.status).json({ ok: false, error: safe.error, message: safe.message })
  }
}

export async function handleIapRestore(req, res) {
  const user = await requireUser(req, res)
  if (!user) return
  if (req.body?.platform !== 'ios') {
    res.status(400).json({ ok: false, error: 'unsupported_platform', message: 'Only iOS purchases are supported.' })
    return
  }

  const purchases = Array.isArray(req.body?.purchases)
    ? req.body.purchases
        .map((p) => {
          if (typeof p === 'string') return { signedTransactionInfo: p }
          if (!p || typeof p !== 'object') return null
          return {
            signedTransactionInfo: p.signedTransactionInfo,
            purchaseToken: p.purchaseToken,
            transactionId: p.transactionId,
            productId: p.productId,
            originalTransactionId: p.originalTransactionId ?? p.originalTransactionIdentifierIOS,
            purchaseAuthorizationId: p.purchaseAuthorizationId,
          }
        })
        .filter((p) => p && (p.signedTransactionInfo || p.purchaseToken || p.transactionId))
    : []

  const db = makeAdminClient()
  if (!db) {
    res.status(503).json({ ok: false, error: 'server_not_configured', message: 'Server database is not configured.' })
    return
  }

  // Ensure a quota row exists even when there is nothing to restore.
  await getOrCreateUserQuota(user.userId, user.email)

  // Defense in depth ONLY. Restore submits the full StoreKit history in
  // whatever order Transaction.all yielded it; processing oldest-first means
  // the newest state is written last and naturally wins. Apple transaction ids
  // increase monotonically, so they order the lineage without needing to verify
  // first. Entries without a usable numeric id keep their relative order and
  // sort last. The real protection is shouldReplaceSubscriptionState in the
  // write layer — notifications can still arrive out of order, restore order
  // can change, and future callers may bypass this sort entirely.
  const orderKey = (p) => {
    const n = Number(p?.transactionId)
    return Number.isSafeInteger(n) && n > 0 ? n : Number.MAX_SAFE_INTEGER
  }
  const orderedPurchases = [...purchases].sort((a, b) => orderKey(a) - orderKey(b))

  let restoredActive = 0
  let restoredCount = 0
  let alreadyLinked = false
  const verifiedTransactionIds = []
  const outcomes = []
  for (const purchase of orderedPurchases) {
    try {
      const result = await verifyAndPersist(db, user, purchase)
      outcomes.push({ transactionId: result.transactionId ?? purchase.transactionId ?? null,
        code: result.code, granted: Boolean(result.granted), safeToFinish: Boolean(result.safeToFinish), retryable: result.code === 'sales_closed' })
      restoredCount += 1
      // Cryptographic validity alone is not delivery. Retryable policy denials
      // must leave the transaction available for later authorized reconciliation.
      if (result.safeToFinish && result.transactionId) verifiedTransactionIds.push(result.transactionId)
      if (result.granted) restoredActive += 1
    } catch (err) {
      const itemError = safeIapError(err)
      outcomes.push({ transactionId: purchase.transactionId ?? null, code: itemError.error,
        granted: false, safeToFinish: false, retryable: itemError.status === 503 || itemError.error === 'sales_closed' })
      if (
        err instanceof AlreadyLinkedError ||
        err instanceof DeletedAccountBindingError ||
        err instanceof SubscriptionAlreadyLinkedError ||
        err instanceof SubscriptionAccountTokenError ||
        err instanceof SubscriptionDeletedAccountError
      ) {
        // Ownership conflict — surface it (never silently swallow) so the
        // client shows "linked to another account" instead of the wrong
        // "No active purchase was found". No binding is written here; this
        // purchase's verifyAndPersist call already threw BEFORE any claim/
        // write, so restore cannot rebind or grant the wrong account.
        alreadyLinked = true
        logIapFailure('restore', user, purchase, err)
        continue
      }
      logIapFailure('restore', user, purchase, err)
    }
  }

  const quotaStatus = await buildQuotaStatus(user.userId, user.email)
  res.json({
    ok: true,
    planType: quotaStatus?.planType ?? null,
    entitlement: quotaStatus?.entitlement ?? null,
    quotaStatus,
    restoredCount,
    activeRestoredCount: restoredActive,
    alreadyLinked,
    verifiedTransactionIds,
    outcomes,
  })
}

export async function handleIapEntitlement(req, res) {
  const user = await requireUser(req, res)
  if (!user) return
  const db = makeAdminClient()
  if (!db) {
    res.status(503).json({ ok: false, error: 'server_not_configured', message: 'Server database is not configured.' })
    return
  }
  await getOrCreateUserQuota(user.userId, user.email)
  const subscription = await getEffectiveSubscription(db, user.userId)
  if (subscription?.active) {
    res.json({ ok: true, entitlement: safeSubscriptionEntitlement(subscription) })
    return
  }
  const entitlement = await getActiveEntitlement(db, user.userId, new Date().toISOString())
  if (!entitlement) {
    const latestEntitlement = await getLatestStudentPassEntitlement(db, user.userId)
    if (!latestEntitlement && !subscription) {
      res.json({
        ok: true,
        entitlement: {
          active: false,
          status: 'none',
          productId: null,
          planType: null,
          expiresAt: null,
          currentEntitlement: null,
          latestEntitlement: null,
        },
      })
      return
    }
    if (subscription) {
      res.json({ ok: true, entitlement: safeSubscriptionEntitlement(subscription) })
      return
    }
    const latestRevocationEventType = await getLatestRevocationEventType(db, latestEntitlement)
    const status = deriveInactiveEntitlementStatus(latestEntitlement, latestRevocationEventType)
    res.json({
      ok: true,
      entitlement: {
        active: false,
        status,
        productId: latestEntitlement.product_id,
        planType: latestEntitlement.plan_type,
        expiresAt: latestEntitlement.expires_at,
        currentEntitlement: null,
        latestEntitlement: safeEntitlementSnapshot(latestEntitlement),
      },
    })
    return
  }
  const currentEntitlement = safeEntitlementSnapshot(entitlement)
  res.json({
    ok: true,
    entitlement: {
      active: true,
      status: 'active',
      productId: entitlement.product_id,
      planType: entitlement.plan_type,
      startsAt: entitlement.starts_at,
      expiresAt: entitlement.expires_at,
      currentEntitlement,
      latestEntitlement: currentEntitlement,
    },
  })
}

// ── App Store Server Notifications V2 (no JWT; JWS-authenticated) ─────────────

const REVOKING_NOTIFICATIONS = new Set([NotificationTypeV2.REFUND, NotificationTypeV2.REVOKE])

export function billingEventTypeForRevokingNotification(notificationType) {
  if (notificationType === NotificationTypeV2.REFUND) return 'refund'
  if (notificationType === NotificationTypeV2.REVOKE) return 'revoke'
  return null
}

export async function handleAppleNotifications(req, res) {
  const signedPayload = req.body?.signedPayload
  if (!signedPayload || typeof signedPayload !== 'string') {
    res.status(400).json({ ok: false, error: 'invalid_notification', message: 'Missing signedPayload.' })
    return
  }

  const db = makeAdminClient()
  if (!db) {
    res.status(503).json({ ok: false, error: 'server_not_configured' })
    return
  }

  let decoded
  let reservation
  try {
    decoded = await verifyAppleNotification(signedPayload)
  } catch (err) {
    // Bad signature / wrong environment: do not process, do not leak details.
    console.warn('[iap/notifications] verify failed', JSON.stringify({ message: err instanceof Error ? err.message : String(err) }))
    res.status(400).json({ ok: false, error: 'invalid_notification' })
    return
  }

  try {
    reservation = await reserveNotification(db, decoded)
    if (!reservation.reserved) {
      if (reservation.inFlight) { res.status(503).json({ ok: false, error: 'notification_in_progress' }); return }
      res.json({ ok: true, deduped: true })
      return
    }

    const tx = decoded.transaction
    let ownerUserId = tx && !tx.autoRenewable ? await findTransactionOwner(db, tx) : null

    if (tx?.autoRenewable) {
      const binding = await findSubscriptionBinding(db, tx.originalTransactionId)
      ownerUserId = binding?.owner_state === 'active' ? binding.user_id : null
      // Apple-signed Production evidence can recover a first purchase even
      // when its client died before /verify. Never bootstrap a test chain,
      // anonymous identity, deleted account, or an existing foreign binding.
      if (!binding && tx.environment === 'Production' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tx.appAccountToken ?? '')) {
        const { data, error } = await db.auth.admin.getUserById(tx.appAccountToken)
        if (error && error.status !== 404) throw error
        if (data?.user && !data.user.is_anonymous) ownerUserId = data.user.id
      }
      if (SUBSCRIPTION_STATUS_NOTIFICATIONS.has(decoded.notificationType)) {
        // Refresh only the canonical owner; possession of historical state rows
        // must not authorize a second identity on the same Apple lineage.
        const affectedUserIds = ownerUserId ? [ownerUserId] : []
        for (const uid of affectedUserIds) {
          const state = await upsertSubscriptionState(db, uid, tx, {
            appleEventAt: decoded.appleEventAt,
            renewal: decoded.renewal,
            notificationType: decoded.notificationType,
            subtype: decoded.subtype,
            source: 'notification_v2',
          })
          await recordBillingEvent(db, uid, {
            event_type: decoded.notificationType === NotificationTypeV2.DID_RENEW
              ? 'subscription_renewed'
              : 'subscription_status_changed',
            product_id: tx.productId,
            transaction_id: tx.transactionId,
            environment: decoded.environment,
            detail: { notificationType: decoded.notificationType, subtype: decoded.subtype ?? null, status: state.status },
          })
        }
        if (!ownerUserId) ownerUserId = affectedUserIds[0] ?? null
      }
    }

    if (REVOKING_NOTIFICATIONS.has(decoded.notificationType) && tx && !tx.autoRenewable) {
      // Preserve transaction + history; flip status to revoked.
      await revokeByTransaction(db, tx.transactionId, tx.revokedAt)
      await recordBillingEvent(db, ownerUserId, {
        event_type: billingEventTypeForRevokingNotification(decoded.notificationType),
        product_id: tx.productId,
        transaction_id: tx.transactionId,
        environment: decoded.environment,
        detail: { subtype: decoded.subtype ?? null },
      })
    }

    // Audit + dedupe marker (transaction_id carries the notificationUUID).
    await recordBillingEvent(db, ownerUserId, {
      event_type: 'notification',
      product_id: tx?.productId ?? null,
      transaction_id: decoded.notificationUUID ?? null,
      environment: decoded.environment,
      detail: { notificationType: decoded.notificationType, subtype: decoded.subtype ?? null },
    })
    await markNotificationProcessed(db, decoded.notificationUUID, reservation?.lease)

    res.json({ ok: true })
  } catch (err) {
    try {
      await markNotificationFailed(db, decoded?.notificationUUID, err, reservation?.lease)
    } catch (markErr) {
      console.warn('[iap/notifications] failed to mark notification failed', JSON.stringify({ message: markErr instanceof Error ? markErr.message : String(markErr) }))
    }
    console.error('[iap/notifications] processing failed', JSON.stringify({ message: err instanceof Error ? err.message : String(err) }))
    res.status(500).json({ ok: false, error: 'notification_processing_failed' })
  }
}

// ── Logging (never logs JWS/JWT/secrets) ─────────────────────────────────────

/**
 * Structured, audit-safe subscription stage trace.
 *
 * Never logs tokens, JWS, receipts, keys, or email — only a stage name, the
 * product, and BOOLEAN presence of identity fields. This exists because the
 * non-granted verify path returns HTTP 200 and previously logged nothing at
 * all, so a rejection like `unknown_product` was invisible in production and
 * reached the client as a generic "could not be verified".
 */
export function safeSubscriptionStage(stage, user, detail = {}) {
  console.warn(
    '[iap/stage]',
    JSON.stringify({
      stage,
      userIdPrefix: user?.userId ? String(user.userId).slice(0, 8) : null,
      ...detail,
    }),
  )
}

/** Log a verify/restore that completed without granting. */
function logIapOutcome(scope, user, result, verified = null) {
  safeSubscriptionStage(`${scope}_not_granted`, user, {
    reason: result?.code ?? null,
    productId: verified?.productId ?? null,
    environment: verified?.environment ?? null,
    hasOriginalTransactionId: Boolean(verified?.originalTransactionId),
    hasAppAccountToken: Boolean(verified?.appAccountToken),
    hasExpiresDate: Boolean(verified?.appleExpiresDate),
  })
}

function logIapFailure(scope, user, body, err) {
  console.warn(
    `[iap/${scope}] failed`,
    JSON.stringify({
      userIdPrefix: user.userId.slice(0, 8),
      productId: body?.productId ?? null,
      transactionId: body?.transactionId ?? null,
      // Internal-only: distinguishes an appAccountToken mismatch from an
      // existing-binding conflict even though both normalize to the SAME
      // client-facing `iap_already_linked` code. Never sent to the client.
      errorClass: err?.constructor?.name ?? null,
      message: err instanceof Error ? err.message : String(err),
    }),
  )
}

// Account-independent, public catalog availability; no secrets or ownership data.
export async function handleSubscriptionAvailability(_req, res) {
  const db = makeAdminClient()
  if (!db) return res.status(503).json({ ok: false, error: 'iap_temporarily_unavailable', products: [] })
  try { res.json({ ok: true, products: await subscriptionAvailability(db) }) }
  catch { res.status(503).json({ ok: false, error: 'iap_temporarily_unavailable', products: [] }) }
}

export async function handleSubscriptionPurchaseAuthorization(req, res) {
  const user = await requireUser(req, res)
  if (!user) return
  const db = makeAdminClient()
  if (!db) return res.status(503).json({ ok: false, error: 'iap_temporarily_unavailable' })
  try {
    const { data, error } = await db.rpc('authorize_subscription_purchase', { p_user_id: user.userId, p_product_id: req.body?.productId })
    if (error) return res.status(String(error.message).includes('subscription_sales_closed') ? 403 : 503)
      .json({ ok: false, error: String(error.message).includes('subscription_sales_closed') ? 'sales_closed' : 'iap_temporarily_unavailable' })
    res.json({ ok: true, ...data })
  } catch { res.status(503).json({ ok: false, error: 'iap_temporarily_unavailable' }) }
}
