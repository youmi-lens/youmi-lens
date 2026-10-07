/**
 * Desktop Stripe configuration + pure plan mapping (Commercialization V2 · 1A).
 *
 * The SERVER is the only authority for which plans exist and which Stripe price
 * each maps to. The client never supplies a price, amount, plan_type, or
 * customer id — it may only name a plan_code, which is validated here.
 *
 * All price ids come from environment variables so no unverified live Stripe id
 * is baked into the repo. Both plan codes map to the SAME entitlement tier
 * (plan_type = 'student_pass'); only the billing interval differs.
 */

export const STUDENT_PASS_PLAN_TYPE = 'student_pass'

export const PLAN_CODES = {
  STUDENT_BASIC_MONTHLY: 'student_basic_monthly',
  STUDENT_BASIC_ANNUAL: 'student_basic_annual',
}

/** Billing interval per plan_code (record-level; NOT an entitlement tier). */
const PLAN_INTERVALS = {
  [PLAN_CODES.STUDENT_BASIC_MONTHLY]: 'month',
  [PLAN_CODES.STUDENT_BASIC_ANNUAL]: 'year',
}

/**
 * Past-due grace window (days) before access is withdrawn.
 *
 * PRODUCT POLICY: grace is NOT an approved business decision yet, so the default
 * is ZERO days. Access during past_due is therefore never extended beyond the
 * already-paid current_period_end unless STRIPE_GRACE_PERIOD_DAYS is explicitly
 * set to a positive value. The knob is preserved so a grace policy can be turned
 * on later without a code change.
 */
export function getGracePeriodDays() {
  const raw = Number(process.env.STRIPE_GRACE_PERIOD_DAYS)
  return Number.isFinite(raw) && raw >= 0 ? raw : 0
}

/**
 * PUBLIC COMMERCIALIZATION RELEASE SWITCH.
 *
 * Website commercialization is finished and TEST MODE verified, but Mac /
 * Windows / iPad have not caught up, so paid Checkout must not be reachable by
 * the public yet. This is the single backend authority for that.
 *
 * FAIL-CLOSED BY DESIGN: only the exact string 'true' opens Checkout. Missing,
 * empty, 'false', or any other value keeps it closed, so a forgotten variable in
 * a new environment can never accidentally expose paid checkout. Controlled
 * TEST MODE verification sets PUBLIC_COMMERCIALIZATION_ENABLED=true explicitly.
 *
 * Scope is deliberately narrow — see handleCheckout. Portal, subscription
 * status/refresh and the webhook are NEVER gated: existing subscribers must keep
 * managing and cancelling their subscription while the public switch is off.
 */
export function isCommercializationEnabled() {
  return process.env.PUBLIC_COMMERCIALIZATION_ENABLED?.trim().toLowerCase() === 'true'
}

/**
 * SCOPED STRIPE TEST CHECKOUT (controlled TEST-mode verification only).
 *
 * While PUBLIC_COMMERCIALIZATION_ENABLED is false, Checkout is closed for everyone. Verifying the real
 * Stripe TEST flow against Production would otherwise require opening it globally, which would let any
 * signed-in user check out with a Stripe test card and receive real paid-tier access. This allowlist
 * lets exactly the named, SERVER-AUTHENTICATED Supabase user ids past that single gate instead.
 *
 * It is deliberately narrow:
 *   - only for a Stripe TEST secret key (sk_test_ / rk_test_): a live, missing or unrecognised key
 *     disables it, so a live cutover can never inherit a forgotten allowlist;
 *   - only while the public switch is closed (when it is open nothing changes — this is not consulted);
 *   - the id is matched against the authenticated user, never against anything the client sends;
 *   - STRICT parsing: every entry must be a UUID, at most MAX entries, and ANY malformed entry (typo,
 *     wildcard, empty slot, over the cap) disables the whole list rather than being skipped;
 *   - it bypasses ONLY the commercialization gate. Auth, plan/price validation, the Stripe-subscription
 *     guard, the cross-provider entitlement guard, ownership binding and the webhook are untouched.
 *
 * Remove the variable (or the key switch to live) to return to the exact pre-allowlist behavior.
 */
export const SCOPED_TEST_CHECKOUT_MAX_USERS = 3
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True only for a Stripe TEST-mode secret/restricted key. Live, empty and unknown keys are false. */
export function isStripeTestModeKey(key) {
  return typeof key === 'string' && /^(sk|rk)_test_.+/.test(key.trim())
}

/**
 * Parse STRIPE_TEST_CHECKOUT_ALLOWED_USER_IDS (comma-separated UUIDs) into normalized lowercase ids.
 * Returns [] — meaning "nobody" — for unset/blank input and for ANY malformed input.
 */
export function parseScopedTestCheckoutUserIds(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return []
  const parts = raw.split(',').map((part) => part.trim())
  if (parts.length > SCOPED_TEST_CHECKOUT_MAX_USERS) return []
  if (!parts.every((part) => USER_ID_PATTERN.test(part))) return []
  return [...new Set(parts.map((part) => part.toLowerCase()))]
}

/**
 * May this AUTHENTICATED user reach Stripe Checkout while the public switch is closed?
 * `userId` must come from verified server auth (never from the request body or headers).
 */
export function isScopedTestCheckoutUser(userId) {
  if (isCommercializationEnabled()) return false
  if (!isStripeTestModeKey(process.env.STRIPE_SECRET_KEY)) return false
  if (typeof userId !== 'string' || !USER_ID_PATTERN.test(userId)) return false
  return parseScopedTestCheckoutUserIds(process.env.STRIPE_TEST_CHECKOUT_ALLOWED_USER_IDS).includes(userId.toLowerCase())
}

/** A configured value that is still a repo placeholder must never be sold. */
function isPlaceholderPriceId(value) {
  return !value || value.startsWith('price_REPLACE_ME')
}

/**
 * plan_code → configured Stripe price id (env only). Returns '' when unset OR
 * when the value is still a placeholder, so dormant/placeholder products can
 * never be accidentally charged.
 */
export function priceIdForPlanCode(planCode) {
  const map = {
    [PLAN_CODES.STUDENT_BASIC_MONTHLY]: process.env.STRIPE_PRICE_STUDENT_BASIC_MONTHLY?.trim() || '',
    [PLAN_CODES.STUDENT_BASIC_ANNUAL]: process.env.STRIPE_PRICE_STUDENT_BASIC_ANNUAL?.trim() || '',
  }
  const value = map[planCode] || ''
  return isPlaceholderPriceId(value) ? '' : value
}

/** Reverse lookup: Stripe price id → plan_code (from env config). Null if none. */
export function planCodeForPriceId(priceId) {
  if (!priceId) return null
  for (const planCode of Object.values(PLAN_CODES)) {
    if (priceIdForPlanCode(planCode) === priceId) return planCode
  }
  return null
}

export function isAllowedPlanCode(planCode) {
  return Object.values(PLAN_CODES).includes(planCode)
}

export function billingIntervalForPlanCode(planCode) {
  return PLAN_INTERVALS[planCode] ?? null
}

/** Both plan codes are the same tier. */
export function planTypeForPlanCode(planCode) {
  return isAllowedPlanCode(planCode) ? STUDENT_PASS_PLAN_TYPE : null
}

/**
 * Only accept an absolute http(s) URL. Redirect targets are server-configured
 * (never client-supplied), and this additionally rejects malformed / non-web
 * schemes (e.g. javascript:) so a misconfiguration cannot become an open
 * redirect. Returns '' for anything not a valid http(s) absolute URL.
 */
export function safeRedirectUrl(value) {
  const raw = (value || '').trim()
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? raw : ''
  } catch {
    return ''
  }
}

/** Checkout success/cancel + portal return URLs (Website; env-configured, validated). */
export function getCheckoutUrls() {
  const base = process.env.STRIPE_CHECKOUT_RETURN_ORIGIN?.trim() || process.env.WEBSITE_ORIGIN?.trim() || ''
  const withBase = (explicit, path) =>
    safeRedirectUrl(explicit) || (base ? safeRedirectUrl(`${base}${path}`) : '')
  return {
    successUrl: withBase(process.env.STRIPE_CHECKOUT_SUCCESS_URL, '/account?checkout=success'),
    cancelUrl: withBase(process.env.STRIPE_CHECKOUT_CANCEL_URL, '/pricing?checkout=cancelled'),
    portalReturnUrl: withBase(process.env.STRIPE_PORTAL_RETURN_URL, '/account'),
  }
}
