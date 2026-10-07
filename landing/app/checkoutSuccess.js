/**
 * Identity-NEUTRAL Stripe Checkout success state for the website.
 *
 * Stripe returns the purchaser's browser to `/account?checkout=success` after a hosted Checkout. That browser
 * may hold a DIFFERENT website session than the account that just paid (the Desktop app checks out in the
 * system browser, which can be signed in as someone else). So this route never consults the website session and
 * never renders account data: no email, plan, renewal date, quota, billing owner or Manage button. It is a UX
 * confirmation only — the URL carries no proof of payment and grants nothing. The entitlement authority stays
 * the backend (webhook → entitlement → quota) and the app the buyer returns to.
 *
 * Pure, DOM-free helpers so the decision is unit-testable: account.js and header.js call them BEFORE any auth
 * call on this route.
 */

/** True only for `?checkout=success` exactly (case-sensitive, a single value); anything else is the normal page. */
export function isCheckoutSuccess(search) {
  const params = new URLSearchParams(typeof search === 'string' ? search : '')
  const values = params.getAll('checkout')
  return values.length === 1 && values[0] === 'success'
}

/** The Account route with the success marker (`/account` or `/account/`). */
export function isCheckoutSuccessAccountRoute(pathname, search) {
  return /^\/account\/?$/.test(typeof pathname === 'string' ? pathname : '') && isCheckoutSuccess(search)
}

export const CHECKOUT_SUCCESS_COPY = Object.freeze({
  title: 'Subscription activated',
  body: 'Your subscription was processed successfully.',
  next: 'Return to Youmi Lens to refresh your plan status.',
  close: 'You can close this tab.',
})

/** Static, account-free markup (no interpolated values at all). */
export function checkoutSuccessView() {
  const c = CHECKOUT_SUCCESS_COPY
  return `<div class="acct" data-checkout-success="true"><div class="card empty">
    <div style="font-size:24px" aria-hidden="true">✅</div>
    <h2 style="font-size:18px">${c.title}</h2>
    <p>${c.body}</p>
    <p>${c.next}</p>
    <p class="muted">${c.close}</p>
  </div></div>`
}

/**
 * Decide what /account does on load. `getSession` is injected and is NOT called on the success route, so a
 * logged-in, different, or logged-out browser all get the identical neutral page (and a logged-out visitor is
 * not bounced to login, which would also drop the marker).
 *   → { kind: 'checkout-success', html } | { kind: 'login' } | { kind: 'dashboard' }
 */
export async function resolveAccountEntry({ pathname, search, getSession }) {
  if (isCheckoutSuccessAccountRoute(pathname, search)) return { kind: 'checkout-success', html: checkoutSuccessView() }
  const session = await getSession()
  return session ? { kind: 'dashboard' } : { kind: 'login' }
}
