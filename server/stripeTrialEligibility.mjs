/**
 * Free-trial ELIGIBILITY for a NEW Stripe Checkout subscription.
 *
 * Policy: the one-month trial is for an account with no prior REAL Student Basic subscription. The answer comes
 * from provider history only — nothing the client sends:
 *
 *   Apple  — a subscription state/binding owned by this user whose `environment` is exactly 'Production'.
 *            Sandbox / Xcode / LocalTesting history is test data and never blocks a real trial. `environment`
 *            is a NOT NULL, CHECK-constrained column filled from Apple's signed transaction (never inferred
 *            from a product id), and it is the same rule getEffectiveSubscription uses to decide whether a
 *            chain counts. An unrecognised value is ambiguous → throw (fail closed).
 *
 *   Stripe — history in the CURRENT account mode only, read from the Stripe API (authoritative). Our tables
 *            (`subscriptions`, `stripe_customers`, `user_entitlements`) carry NO test/live marker and the TEST
 *            rows already in Production would otherwise block a future LIVE trial, so they are deliberately
 *            NOT consulted. Stripe keeps modes separate: a TEST key only sees TEST customers/subscriptions, a
 *            LIVE key only LIVE ones. Customers are found by the stored mapping AND by their `user_id`
 *            metadata (so a stale mapping from the other mode cannot hide real history). Every object must
 *            report `livemode` equal to the key's mode; anything else is ambiguous → throw.
 *
 * What this CANNOT tell us: whether an Apple Production subscription actually USED Apple's introductory
 * offer (`offerType` is decoded but never stored) — any Production subscription counts, conservatively. It
 * also cannot see a deleted-and-recreated account. Apple enforces ITS OWN eligibility per Apple Account and
 * subscription group inside StoreKit; this check protects only the STRIPE checkout.
 *
 * Read-only. Throws whenever a source cannot be read or classified: the caller must FAIL CLOSED (no checkout).
 */
import { stripeKeyMode } from './stripeConfig.mjs'
import { getStripeCustomerId } from './stripeCustomers.mjs'

const APPLE_REAL_ENVIRONMENT = 'Production'
const APPLE_TEST_ENVIRONMENTS = new Set(['Sandbox', 'Xcode', 'LocalTesting'])
const APPLE_ROW_CAP = 200
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Production Apple history in one table. Test environments are ignored; unknown ones throw. */
async function hasProductionAppleRow(db, table, userId) {
  const { data, error } = await db.from(table).select('original_transaction_id, environment').eq('user_id', userId).limit(APPLE_ROW_CAP)
  if (error) throw error
  const rows = Array.isArray(data) ? data : []
  let production = false
  for (const row of rows) {
    if (row?.environment === APPLE_REAL_ENVIRONMENT) production = true
    else if (!APPLE_TEST_ENVIRONMENTS.has(row?.environment)) throw new Error(`apple_history_environment_unrecognized:${table}`)
  }
  // Could not see every row and none of the visible ones is Production → cannot rule Production out.
  if (!production && rows.length >= APPLE_ROW_CAP) throw new Error(`apple_history_incomplete:${table}`)
  return production
}

const isResourceMissing = (err) => err?.code === 'resource_missing' || err?.raw?.code === 'resource_missing'

/** Any Stripe subscription (any status) in the key's own mode for this user. */
async function hasStripeHistoryInCurrentMode(db, stripe, userId, customerLookup) {
  const mode = stripeKeyMode(process.env.STRIPE_SECRET_KEY)
  if (!mode) throw new Error('stripe_mode_unknown')
  const expectedLive = mode === 'live'
  // Verified Supabase ids only: this value is embedded in a Stripe search query.
  if (typeof userId !== 'string' || !USER_ID_PATTERN.test(userId)) throw new Error('trial_eligibility_invalid_user')

  const customerIds = new Set()
  const mapped = await customerLookup(db, userId)
  if (mapped) customerIds.add(mapped) // may belong to the other mode → Stripe answers resource_missing below
  const found = await stripe.customers.search({ query: `metadata['user_id']:'${userId}'`, limit: 10 })
  for (const customer of found?.data ?? []) {
    if (customer?.livemode !== expectedLive) throw new Error('stripe_history_mode_mismatch')
    customerIds.add(customer.id)
  }

  for (const customerId of customerIds) {
    let list
    try {
      list = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 1 })
    } catch (err) {
      if (isResourceMissing(err)) continue // an id from the other mode: no history in THIS mode through it
      throw err
    }
    const subscription = list?.data?.[0]
    if (!subscription) continue
    if (subscription.livemode !== expectedLive) throw new Error('stripe_history_mode_mismatch')
    return true
  }
  return false
}

/** @returns {Promise<boolean>} true when the account has prior REAL Student Basic subscription history. */
export async function hasPriorSubscriptionHistory(db, stripe, userId, { customerLookup = getStripeCustomerId } = {}) {
  if (await hasProductionAppleRow(db, 'app_store_subscription_states', userId)) return true
  if (await hasProductionAppleRow(db, 'app_store_subscription_bindings', userId)) return true
  return hasStripeHistoryInCurrentMode(db, stripe, userId, customerLookup)
}
