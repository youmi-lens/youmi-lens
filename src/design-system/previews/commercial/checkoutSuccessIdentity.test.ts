/**
 * Checkout success must be identity-neutral.
 *
 * Stripe sends the buyer's browser to /account?checkout=success. That browser may be signed in as a DIFFERENT
 * website account than the one that paid (Desktop checks out in the system browser), so the success route must never
 * render the browser session's account. These tests drive the real decision module with injected sessions.
 */
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHECKOUT_SUCCESS_COPY,
  checkoutSuccessView,
  isCheckoutSuccess,
  isCheckoutSuccessAccountRoute,
  resolveAccountEntry,
} from '../../../../landing/app/checkoutSuccess.js'
import { getCheckoutUrls } from '../../../../server/stripeConfig.mjs'

const L = (p: string) => readFileSync(new URL(`../../../../landing/${p}`, import.meta.url), 'utf8')
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const PURCHASER = { user: { id: 'u-purchaser', email: 'youmilens+test32@gmail.com' } }
const OTHER = { user: { id: 'u-other', email: 'youmilens+stripe-e2e-annual-20260731@gmail.com' } }
const SUCCESS = { pathname: '/account/', search: '?checkout=success' }

const enter = (session: unknown, over: { pathname?: string; search?: string } = {}) => {
  const getSession = vi.fn(async () => session)
  return { getSession, run: () => resolveAccountEntry({ ...SUCCESS, ...over, getSession }) }
}

afterEach(() => vi.unstubAllEnvs())

describe('1–3. /account?checkout=success is the same neutral page for every browser session', () => {
  it('1. browser signed in as the PURCHASER → neutral success page', async () => {
    const { run } = enter(PURCHASER)
    const r = await run()
    expect(r.kind).toBe('checkout-success')
    expect(r.html).toContain(CHECKOUT_SUCCESS_COPY.title)
  })

  it('2. browser signed in as a DIFFERENT user → the SAME neutral page, nothing of the other account', async () => {
    const purchaser = await enter(PURCHASER).run()
    const other = await enter(OTHER).run()
    expect(other).toEqual(purchaser) // byte-identical outcome regardless of who is signed in
    expect(other.html).not.toContain('stripe-e2e-annual')
    expect(other.html).not.toContain('youmilens')
    expect(other.html).not.toContain('@')
  })

  it('3. browser LOGGED OUT → the same neutral page (not a redirect to login that would drop the marker)', async () => {
    const out = await enter(null).run()
    expect(out).toEqual(await enter(PURCHASER).run())
    expect(out.kind).not.toBe('login')
  })

  it('the website session is never even read on the success route', async () => {
    for (const session of [PURCHASER, OTHER, null]) {
      const { getSession, run } = enter(session)
      await run()
      expect(getSession).not.toHaveBeenCalled()
    }
  })

  it('works with and without the trailing slash (Cloudflare redirects /account → /account/)', async () => {
    for (const pathname of ['/account', '/account/']) {
      expect((await enter(OTHER, { pathname }).run()).kind).toBe('checkout-success')
    }
  })
})

describe('success page content: UX confirmation only', () => {
  const html = checkoutSuccessView()

  it('says what happened and what to do next', () => {
    expect(html).toContain('Subscription activated')
    expect(html).toContain('Your subscription was processed successfully.')
    expect(html).toContain('Return to Youmi Lens to refresh your plan status.')
    expect(html).toContain('You can close this tab.')
  })

  it('carries NO account-specific or billing-owner information and no actions', () => {
    for (const forbidden of [/@/, /Renews/i, /Manage/i, /Billing/i, /\$\d/, /Email/i, /Plan\b/, /minutes/i, /quota/i, /Log out/i, /<a /i, /<button/i, /Student Basic/i]) {
      expect(html, String(forbidden)).not.toMatch(forbidden)
    }
  })

  it('is static: no interpolation of any value (no URL/session data can reach the markup)', () => {
    expect(checkoutSuccessView()).toBe(checkoutSuccessView())
    const src = stripComments(readFileSync(new URL('../../../../landing/app/checkoutSuccess.js', import.meta.url), 'utf8'))
    const viewFn = src.slice(src.indexOf('export function checkoutSuccessView'), src.indexOf('export async function resolveAccountEntry'))
    expect(viewFn.match(/\$\{/g)?.length).toBe(4) // only the four frozen copy strings
    expect(viewFn).not.toMatch(/location|search|session|email|localStorage/)
  })
})

describe('4. normal /account (no success marker) is unchanged', () => {
  it('signed in → dashboard; signed out → login; the session IS consulted', async () => {
    const signedIn = enter(PURCHASER, { search: '' })
    expect((await signedIn.run()).kind).toBe('dashboard')
    expect(signedIn.getSession).toHaveBeenCalledTimes(1)
    const signedOut = enter(null, { search: '' })
    expect((await signedOut.run()).kind).toBe('login')
    expect(signedOut.getSession).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['cancelled marker', '?checkout=cancelled'],
    ['uppercase', '?checkout=SUCCESS'],
    ['duplicated/ambiguous', '?checkout=success&checkout=cancelled'],
    ['empty value', '?checkout='],
    ['unrelated key', '?foo=checkout=success'],
    ['other key', '?status=success'],
    ['success-ish value', '?checkout=success1'],
    ['no query', ''],
  ])('%s is NOT the success route', async (_n, search) => {
    expect(isCheckoutSuccess(search)).toBe(false)
    expect((await enter(OTHER, { search }).run()).kind).toBe('dashboard')
  })

  it('only the Account route is affected (other pages keep their behavior)', () => {
    for (const pathname of ['/pricing/', '/pricing', '/', '/login/', '/accountx', '/account/extra', '/ACCOUNT/', '']) {
      expect(isCheckoutSuccessAccountRoute(pathname, '?checkout=success'), pathname).toBe(false)
    }
    expect(isCheckoutSuccessAccountRoute('/account/', '?checkout=success')).toBe(true)
    expect(isCheckoutSuccessAccountRoute(undefined as never, undefined as never)).toBe(false)
  })
})

describe('5. a forged / manually typed ?checkout=success changes nothing', () => {
  it('the success module cannot mutate anything: no network, no auth, no storage, no navigation', () => {
    const src = stripComments(readFileSync(new URL('../../../../landing/app/checkoutSuccess.js', import.meta.url), 'utf8'))
    expect(src).not.toMatch(/\bfetch\s*\(/)
    expect(src).not.toMatch(/\bimport\s+[^;]*from\s+['"]\.\/auth/)
    expect(src).not.toMatch(/localStorage|sessionStorage|document\.cookie|location\.(assign|replace|href)|XMLHttpRequest|sendBeacon/)
    expect(src).not.toMatch(/startCheckout|openBillingPortal|billing\/(checkout|portal)|quota|subscription\/(status|refresh)/)
  })

  it('a forged marker for ANY session just yields the informational page — no entitlement/plan state is read or written', async () => {
    const calls: string[] = []
    const getSession = vi.fn(async () => { calls.push('getSession'); return OTHER })
    const r = await resolveAccountEntry({ pathname: '/account', search: '?checkout=success&utm=forged', getSession })
    expect(r.kind).toBe('checkout-success')
    expect(calls).toEqual([])
    expect(JSON.stringify(r)).not.toMatch(/active|entitle|student_pass|trialing|renews/i)
  })
})

describe('page + header wiring (static): the neutral route is decided before any auth call', () => {
  const account = stripComments(L('app/account.js'))
  const header = stripComments(L('app/header.js'))

  it('account.js resolves the entry first and only afterwards can load the dashboard', () => {
    expect(account).toMatch(/from '\.\/checkoutSuccess\.js'/)
    const iife = account.slice(account.lastIndexOf(';(async () => {'))
    expect(iife).toMatch(/resolveAccountEntry\(\{ pathname: location\.pathname, search: location\.search, getSession \}\)/)
    expect(iife).toMatch(/entry\.kind === 'checkout-success'[^\n]*set\(entry\.html\)[^\n]*return/)
    // the success branch precedes the login redirect and the dashboard load
    expect(iife.indexOf("'checkout-success'")).toBeLessThan(iife.indexOf("location.replace('/login/?next=/account/')"))
    expect(iife.indexOf("'checkout-success'")).toBeLessThan(iife.indexOf('load()'))
    // no direct session read bypasses the resolver
    expect(iife).not.toMatch(/await getSession\(\)/)
  })

  it('the normal account flow is untouched (login redirect, dashboard, manage, plans.js)', () => {
    expect(account).toMatch(/location\.replace\('\/login\/\?next=\/account\/'\)/)
    expect(account).toMatch(/function dashboardView/)
    expect(account).toMatch(/openBillingPortal\(\)/)
    expect(account).toMatch(/from '\.\/plans\.js'/)
  })

  it('header.js shows no account identity on the success route and makes no auth call there', () => {
    const mount = header.slice(header.indexOf('async function mount'))
    expect(header).toMatch(/from '\.\/checkoutSuccess\.js'/)
    expect(mount.indexOf('isCheckoutSuccessAccountRoute(location.pathname, location.search)')).toBeLessThan(mount.indexOf('await getSession()'))
    expect(mount).toMatch(/render\(false, '', true\); return/) // neutral paint, early return (no onAuthChange repaint)
    const render = header.slice(header.indexOf('function render'), header.indexOf('async function mount'))
    expect(render).toMatch(/neutral\s*\?\s*`<a class="nav-account" href="\/account\/">Account<\/a>`/)
  })

  it('cache-busters were bumped so a cached copy cannot keep the old behavior on /account', () => {
    const html = L('account/index.html')
    expect(html).toContain('/app/account.js?v=8')
    expect(html).toContain('/app/header.js?v=8')
    expect(html).not.toMatch(/(account|header)\.js\?v=7/)
  })
})

describe('Stripe checkout semantics are unchanged', () => {
  it('success_url is still /account?checkout=success; cancel and portal return are untouched', () => {
    vi.stubEnv('WEBSITE_ORIGIN', 'https://youmilens.com')
    vi.stubEnv('STRIPE_CHECKOUT_SUCCESS_URL', '')
    vi.stubEnv('STRIPE_CHECKOUT_RETURN_ORIGIN', '')
    const urls = getCheckoutUrls()
    expect(urls.successUrl).toBe('https://youmilens.com/account?checkout=success')
    expect(urls.cancelUrl).toBe('https://youmilens.com/pricing?checkout=cancelled')
    expect(urls.portalReturnUrl).toBe('https://youmilens.com/account')
  })

  it('the success marker used by Stripe is exactly what the neutral route recognises', () => {
    vi.stubEnv('WEBSITE_ORIGIN', 'https://youmilens.com')
    vi.stubEnv('STRIPE_CHECKOUT_SUCCESS_URL', '')
    vi.stubEnv('STRIPE_CHECKOUT_RETURN_ORIGIN', '')
    const u = new URL(getCheckoutUrls().successUrl)
    expect(isCheckoutSuccessAccountRoute(u.pathname, u.search)).toBe(true)
  })
})
