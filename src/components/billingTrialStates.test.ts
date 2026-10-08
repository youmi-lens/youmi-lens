import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertSubscriptionRecord } from '../lib/billing/billingClient'
import type { QuotaStatusPayload, SubscriptionRecord } from '../lib/billing/billingClient'
import { createBillingController } from '../hooks/useBilling'
import { deriveBillingState, type BillingState } from '../lib/billing/billingState'
import {
  LanguagePreferencesContext,
  type LanguagePreferencesContextValue,
} from '../languagePreferencesContext'
import { DEFAULT_LANGUAGE_PREFERENCES } from '../lib/languagePreferences'
import { DESKTOP_I18N_LOCALES, translateDesktop } from '../lib/desktopI18n'
import { billingSummaryLabel, canOpenPortal } from './billingCheckoutCopy'
import { BillingPlanContent } from './BillingPlanModal'

vi.mock('./BillingPlanModal.css', () => ({}))

/* Stripe trial / payment-problem states in the Desktop billing UI.
 *
 * The backend is the only authority: `trialing`, `trialEnd` and `inGrace` come from /api/subscription/status and the
 * membership itself from /api/quota/status. Nothing here computes a trial end, a price from Stripe data, or an
 * entitlement. Apple-managed, admin and free accounts must render exactly as before. */

const languageContextValue: LanguagePreferencesContextValue = {
  preferences: DEFAULT_LANGUAGE_PREFERENCES,
  setPreference: () => undefined,
  t: (key, vars) => translateDesktop('en', key, vars),
}
const withLanguage = (node: ReactNode): ReactNode =>
  createElement(LanguagePreferencesContext.Provider, { value: languageContextValue }, node)
const render = (state: BillingState, extra: Partial<Parameters<typeof BillingPlanContent>[0]> = {}) =>
  renderToStaticMarkup(withLanguage(createElement(BillingPlanContent, { state, ...extra })))

const sub = (over: Partial<SubscriptionRecord> = {}): SubscriptionRecord => ({
  provider: 'stripe', active: true, planCode: 'student_basic_monthly', billingInterval: 'month', status: 'active',
  currentPeriodEnd: '2026-12-06T12:00:00.000Z', cancelAtPeriodEnd: false, graceUntil: null, manageable: true, ...over,
})
const paidQuota = (entitlement: QuotaStatusPayload['entitlement']): QuotaStatusPayload => ({
  planType: 'student_pass', effectivePlanType: 'student_pass', status: 'active', studentPassActive: true,
  unlimited: false, monthlyMinutesLimit: 600, maxRecordingsPerDay: 6, maxProcessingJobsPerDay: 10, entitlement,
})
const freeQuota: QuotaStatusPayload = {
  planType: 'public_trial', effectivePlanType: 'public_trial', status: 'active', studentPassActive: false,
  unlimited: false, monthlyMinutesLimit: 300, maxRecordingsPerDay: 2, maxProcessingJobsPerDay: 2,
  entitlement: { active: false, productId: null, expiresAt: null },
}
const STRIPE_MONTHLY = { active: true, status: 'active', productId: 'student_basic_monthly', planType: 'student_pass', expiresAt: '2026-11-06T12:00:00.000Z' }
const STRIPE_ANNUAL = { ...STRIPE_MONTHLY, productId: 'student_basic_annual' }
const APPLE = { active: true, status: 'active', productId: 'com.aydenz.youmilensipad.student.monthly', planType: 'student_pass', expiresAt: '2026-11-20T00:00:00.000Z', source: 'app_store_subscription' }
const GIFT = { active: true, status: 'active', productId: 'admin_student_basic', planType: 'student_pass', expiresAt: '2027-01-01T00:00:00.000Z' }

const TRIAL_END = '2026-11-06T12:00:00.000Z'
const GRACE_UNTIL = '2026-11-09T12:00:00.000Z'
const fmt = (iso: string) => new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(iso))
const stateFor = (quota: QuotaStatusPayload, subscription: SubscriptionRecord) =>
  deriveBillingState({ signedIn: true, loading: false, subscription, quota, error: null })

const trialSub = (over: Partial<SubscriptionRecord> = {}) =>
  sub({ status: 'trialing', trialing: true, trialEnd: TRIAL_END, currentPeriodEnd: TRIAL_END, ...over })

afterEach(() => vi.clearAllMocks())

describe('A. Stripe trial', () => {
  it('1. monthly → "Free trial ends {date}, then $4.99/month."', () => {
    const html = render(stateFor(paidQuota(STRIPE_MONTHLY), trialSub()), { onManage: () => {} })
    expect(html).toContain(`Free trial ends ${fmt(TRIAL_END)}, then $4.99/month.`)
    expect(html).toContain('data-billing-status="trialing"')
    expect(html).toContain('Free trial') // status pill
  })

  it('2. annual → "Free trial ends {date}, then $49.99/year."', () => {
    const html = render(stateFor(paidQuota(STRIPE_ANNUAL), trialSub({ planCode: 'student_basic_annual', billingInterval: 'year' })), { onManage: () => {} })
    expect(html).toContain(`Free trial ends ${fmt(TRIAL_END)}, then $49.99/year.`)
    expect(html).not.toContain('$4.99')
  })

  it('3. the date is the backend trialEnd, not currentPeriodEnd or anything computed', () => {
    const html = render(stateFor(paidQuota(STRIPE_MONTHLY), trialSub({ trialEnd: '2026-11-10T12:00:00.000Z', currentPeriodEnd: '2026-12-31T12:00:00.000Z' })))
    expect(html).toContain(fmt('2026-11-10T12:00:00.000Z'))
    expect(html).not.toContain(fmt('2026-12-31T12:00:00.000Z'))
  })

  it('4. the client never synthesizes a trial end: no trialEnd → no invented date', () => {
    const state = stateFor(paidQuota(STRIPE_MONTHLY), trialSub({ trialEnd: null }))
    expect(state).toMatchObject({ status: 'trialing', trialEnd: null })
    const html = render(state)
    expect(html).toContain('You are on a free trial.')
    expect(html).not.toMatch(/ends \w{3}|Free trial ends|then \$/)
    // …and an unknown cadence states the date without inventing a price.
    const noCadence = render(stateFor(paidQuota(STRIPE_MONTHLY), trialSub({ planCode: null, billingInterval: null })))
    expect(noCadence).toContain(`Free trial ends ${fmt(TRIAL_END)}.`)
    expect(noCadence).not.toMatch(/\$\d/)
  })

  it('a trial is not rendered as a generic Active subscription, and shows no Renews row', () => {
    const state = stateFor(paidQuota(STRIPE_MONTHLY), trialSub())
    expect(state.status).toBe('trialing')
    const html = render(state, { onManage: () => {} })
    expect(html).not.toContain('Renews')
    expect(html).not.toContain('data-billing-status="active"')
    expect(html).toContain('Manage subscription') // the Portal action is kept
  })

  it('the Settings summary and the Portal gate know the trial states', () => {
    const t = (key: Parameters<typeof billingSummaryLabel>[1] extends (k: infer K) => string ? K : never) => translateDesktop('en', key)
    const trial = stateFor(paidQuota(STRIPE_MONTHLY), trialSub())
    expect(billingSummaryLabel(trial, t)).toBe('Student Basic · Free trial')
    expect(canOpenPortal(trial)).toBe(true)
    const canceled = stateFor(paidQuota(STRIPE_MONTHLY), trialSub({ cancelAtPeriodEnd: true }))
    expect(billingSummaryLabel(canceled, t)).toContain('Student Basic')
    expect(canOpenPortal(canceled)).toBe(true)
  })
})

describe('B. Stripe trial cancelled before it ends', () => {
  const canceled = () => stateFor(paidQuota(STRIPE_MONTHLY), trialSub({ cancelAtPeriodEnd: true }))

  it('5. → "Access through {date}. You won\'t be charged."', () => {
    expect(canceled().status).toBe('trial_canceling') // the trial fact is NOT erased by the generic `canceling`
    const html = render(canceled(), { onManage: () => {} })
    expect(html).toContain(`Access through ${fmt(TRIAL_END)}. You won&#x27;t be charged.`)
    expect(html).toContain('data-billing-status="trial_canceling"')
  })

  it('6. never shows "Renews"', () => {
    expect(render(canceled(), { onManage: () => {} })).not.toContain('Renews')
  })

  it('7. never shows future-charge copy ("then $…")', () => {
    const html = render(canceled(), { onManage: () => {} })
    expect(html).not.toMatch(/then \$|\$4\.99|\$49\.99|Free trial ends/)
  })

  it('annual cancelled trial shows no price either', () => {
    const html = render(stateFor(paidQuota(STRIPE_ANNUAL), trialSub({ planCode: 'student_basic_annual', billingInterval: 'year', cancelAtPeriodEnd: true })))
    expect(html).not.toMatch(/\$\d/)
    expect(html).toContain("won&#x27;t be charged")
  })

  it('no trialEnd → still no invented date, still no charge', () => {
    const html = render(stateFor(paidQuota(STRIPE_MONTHLY), trialSub({ cancelAtPeriodEnd: true, trialEnd: null })))
    expect(html).toContain("You won&#x27;t be charged.")
    expect(html).not.toMatch(/Access through \w/)
  })
})

describe('C/D. past_due: payment-problem copy only claims access the backend confirms', () => {
  const pastDue = (over: Partial<SubscriptionRecord>, quota: QuotaStatusPayload) =>
    stateFor(quota, sub({ status: 'past_due', active: true, graceUntil: GRACE_UNTIL, inGrace: true, ...over }))

  it('10. in grace → payment failure + "Access continues until {graceUntil}."', () => {
    const state = pastDue({}, paidQuota(STRIPE_MONTHLY))
    expect(state).toMatchObject({ status: 'past_due', inGrace: true, accessActive: true })
    const html = render(state, { onManage: () => {} })
    expect(html).toContain(`We couldn&#x27;t process your payment. Access continues until ${fmt(GRACE_UNTIL)}.`)
    expect(html).toContain('Resolve billing issue') // the fix-your-payment action is kept
  })

  it('11. in grace → nothing promises access beyond graceUntil (no Renews, no later date)', () => {
    const html = render(pastDue({ currentPeriodEnd: '2026-12-06T12:00:00.000Z' }, paidQuota(STRIPE_MONTHLY)), { onManage: () => {} })
    expect(html).not.toContain('Renews')
    expect(html).not.toContain(fmt('2026-12-06T12:00:00.000Z'))
    expect(html).not.toMatch(/Upgrade|Choose a new plan/)
  })

  it('12. after grace → payment failure only: no Active / Renews / access promise', () => {
    const state = pastDue({ active: false, inGrace: false }, freeQuota)
    expect(state).toMatchObject({ status: 'past_due', inGrace: false, accessActive: false })
    const html = render(state, { onManage: () => {} })
    expect(html).toContain('We couldn&#x27;t process your payment.')
    expect(html).not.toContain('Access continues')
    expect(html).not.toContain('Renews')
    expect(html).not.toContain(fmt(GRACE_UNTIL)) // an expired grace date is not shown as if it were live
    expect(html).not.toMatch(/>Active</)
    expect(html).toContain('Resolve billing issue')
  })

  it('backend says inGrace=false even if a stale quota still shows an entitlement → no access promise', () => {
    const html = render(pastDue({ inGrace: false }, paidQuota(STRIPE_MONTHLY)), { onManage: () => {} })
    expect(html).not.toContain('Access continues')
  })

  it('inGrace=true but the quota authority shows no access → still no access promise (both must agree)', () => {
    const state = pastDue({ inGrace: true }, freeQuota)
    expect(state).toMatchObject({ status: 'past_due', accessActive: false, inGrace: true })
    const html = render(state, { onManage: () => {} })
    expect(html).toContain('We couldn&#x27;t process your payment.')
    expect(html).not.toContain('Access continues')
  })

  it('an older response without inGrace falls back to the quota entitlement (still needs a date)', () => {
    const noField = pastDue({ inGrace: undefined }, paidQuota(STRIPE_MONTHLY))
    expect(noField).toMatchObject({ status: 'past_due', accessActive: true })
    expect(render(noField)).toContain(`Access continues until ${fmt(GRACE_UNTIL)}`)
    const noDate = render(pastDue({ inGrace: undefined, graceUntil: null }, paidQuota(STRIPE_MONTHLY)))
    expect(noDate).toContain('We couldn&#x27;t process your payment.')
    expect(noDate).not.toContain('Access continues')
  })
})

describe('regressions: everything else renders as before', () => {
  it('8. an ACTIVE Stripe paid subscription keeps the existing wording (Active + Renews + Manage)', () => {
    const state = stateFor(paidQuota(STRIPE_MONTHLY), sub({ trialing: false, trialEnd: null, inGrace: false }))
    expect(state.status).toBe('active')
    const html = render(state, { onManage: () => {} })
    expect(html).toContain('data-billing-status="active"')
    expect(html).toContain('Renews')
    expect(html).toContain(fmt('2026-12-06T12:00:00.000Z'))
    expect(html).toContain('Manage subscription')
    expect(html).not.toMatch(/Free trial|You won&#x27;t be charged/)
  })

  it('9. an ACTIVE Stripe subscription cancelled for period end keeps the existing canceling wording', () => {
    const state = stateFor(paidQuota(STRIPE_MONTHLY), sub({ cancelAtPeriodEnd: true, trialing: false }))
    expect(state.status).toBe('canceling')
    const html = render(state, { onManage: () => {} })
    expect(html).toContain('Cancellation scheduled')
    expect(html).toContain('Access remains available through')
    expect(html).not.toMatch(/Free trial|won&#x27;t be charged/)
  })

  it('13. Apple-managed Student Basic: wording unchanged, never Stripe trial/payment copy', () => {
    const state = stateFor(paidQuota(APPLE), sub({ provider: null, active: false, status: 'none', planCode: null, billingInterval: null, manageable: false }))
    expect(state).toMatchObject({ status: 'active', entitlement: { provider: 'apple' } })
    const html = render(state, { onUpgrade: () => {}, onManage: () => {} })
    expect(html).toContain('Your Student Basic subscription is managed through Apple.')
    expect(html).toContain('data-entitlement-provider="apple"')
    expect(html).not.toMatch(/Free trial|couldn&#x27;t process|You won&#x27;t be charged|Manage subscription|Upgrade/)
  })

  it('13b. even a (stale) Stripe trialing record never turns an APPLE entitlement into trial copy', () => {
    const state = stateFor(paidQuota(APPLE), trialSub())
    expect(state.status).not.toBe('trialing')
    expect(state.status).not.toBe('trial_canceling')
    expect(render(state)).not.toContain('Free trial ends')
  })

  it('14. an admin entitlement never becomes an Apple or Stripe trial', () => {
    const plain = stateFor(paidQuota(GIFT), sub({ provider: null, active: false, status: 'none', planCode: null, billingInterval: null, manageable: false }))
    expect(plain).toMatchObject({ status: 'active', entitlement: { provider: 'granted' } })
    expect(render(plain)).toContain('Student Basic access has been added to your account.')
    const withTrialRecord = stateFor(paidQuota(GIFT), trialSub())
    expect(['trialing', 'trial_canceling']).not.toContain(withTrialRecord.status)
    expect(render(withTrialRecord)).not.toMatch(/Free trial ends|managed through Apple/)
  })

  it('15. a free user is unchanged (Upgrade offered, no trial copy)', () => {
    const state = stateFor(freeQuota, sub({ provider: null, active: false, status: 'none', planCode: null, billingInterval: null, manageable: false }))
    expect(state.status).toBe('free')
    const html = render(state, { selectedPlan: 'student_basic_monthly', onUpgrade: () => {} })
    expect(html).toContain('Upgrade to Student Basic')
    expect(html).not.toMatch(/Free trial ends|couldn&#x27;t process/)
  })

  it('a trial flag with NO active entitlement never grants a trial state', () => {
    const state = stateFor(freeQuota, trialSub())
    expect(state.status).not.toBe('trialing')
    expect(state.status).not.toBe('trial_canceling')
  })

  it('a Stripe-looking but INACTIVE entitlement never grants a trial state (membership comes from the quota authority)', () => {
    const inactive = { ...paidQuota({ ...STRIPE_MONTHLY, active: false }), studentPassActive: false }
    const state = stateFor(inactive, trialSub())
    expect(state.status).not.toBe('trialing')
    expect(state.status).not.toBe('trial_canceling')
    expect(render(state)).not.toContain('Free trial ends')
  })
})

describe('16. additive fields are optional: older / local / malformed responses stay safe', () => {
  const base = { ok: true, provider: 'stripe', active: true, planCode: 'student_basic_monthly', billingInterval: 'month', status: 'active', currentPeriodEnd: '2026-12-06T12:00:00.000Z', cancelAtPeriodEnd: false, graceUntil: null, manageable: true }

  it('a legacy payload parses with the additive keys absent (not defaulted)', () => {
    const rec = assertSubscriptionRecord(base, 'test')
    expect(rec).not.toHaveProperty('trialing')
    expect(rec).not.toHaveProperty('trialEnd')
    expect(rec).not.toHaveProperty('inGrace')
    expect(stateFor(paidQuota(STRIPE_MONTHLY), rec).status).toBe('active') // exactly the old behavior
  })

  it('a new payload carries the three fields through', () => {
    const rec = assertSubscriptionRecord({ ...base, status: 'trialing', trialing: true, trialEnd: TRIAL_END, inGrace: false }, 'test')
    expect(rec).toMatchObject({ trialing: true, trialEnd: TRIAL_END, inGrace: false })
    expect(rec.status).toBe('trialing')
  })

  it('wrongly-typed additive values are ignored, never coerced into a state', () => {
    const rec = assertSubscriptionRecord({ ...base, trialing: 'yes', trialEnd: 12345, inGrace: 1 }, 'test')
    expect(rec).not.toHaveProperty('trialing')
    expect(rec).not.toHaveProperty('inGrace')
    expect(rec.trialEnd ?? null).toBe(null)
    expect(stateFor(paidQuota(STRIPE_MONTHLY), rec).status).toBe('active')
  })

  it('`trialing: false` and `trialEnd: null` are understood', () => {
    const rec = assertSubscriptionRecord({ ...base, trialing: false, trialEnd: null, inGrace: false }, 'test')
    expect(rec).toMatchObject({ trialing: false, trialEnd: null, inGrace: false })
  })

  it('existing legacy fields are all still parsed', () => {
    const rec = assertSubscriptionRecord(base, 'test')
    expect(rec).toMatchObject({ provider: 'stripe', active: true, planCode: 'student_basic_monthly', billingInterval: 'month', status: 'active', currentPeriodEnd: '2026-12-06T12:00:00.000Z', cancelAtPeriodEnd: false, graceUntil: null, manageable: true })
  })
})

describe('17–18. identity protection and focus refresh still hold with trial states', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void
    const promise = new Promise<T>((res) => { resolve = res })
    return { promise, resolve }
  }
  const ok = (subscription: SubscriptionRecord) => ({ ok: true as const, subscription })
  const planRes = (plan: QuotaStatusPayload) => ({ ok: true as const, plan })

  it('17. a slow trialing answer for the previous account never overwrites the new account', async () => {
    const aSub = deferred<ReturnType<typeof ok>>()
    const bSub = deferred<ReturnType<typeof ok>>()
    const aPlan = deferred<ReturnType<typeof planRes>>()
    const bPlan = deferred<ReturnType<typeof planRes>>()
    const subs = [aSub, bSub]
    const plans = [aPlan, bPlan]
    let s = 0
    let p = 0
    const c = createBillingController({
      getSubscriptionStatus: vi.fn(() => subs[s++].promise),
      getQuotaStatus: vi.fn(() => plans[p++].promise),
    })
    c.setAuthLoading(false)
    c.setSignedIn(true)
    const loadA = c.load() // user A (trialing) — slow
    c.setSignedIn(false)
    c.setSignedIn(true) // user B on the same controller
    const loadB = c.load()
    bSub.resolve(ok(sub({ provider: null, active: false, status: 'none', planCode: null, billingInterval: null, manageable: false })))
    bPlan.resolve(planRes(freeQuota))
    await loadB
    expect(c.getSnapshot().state.status).toBe('free')
    aSub.resolve(ok(trialSub()))
    aPlan.resolve(planRes(paidQuota(STRIPE_MONTHLY)))
    await loadA // A's late trialing answer
    expect(c.getSnapshot().state.status).toBe('free') // still B
    c.dispose()
  })

  it('18. focus refresh surfaces a trial that started elsewhere (e.g. after returning from Checkout)', async () => {
    let t = 1_000_000
    let trialStarted = false
    const c = createBillingController({
      getSubscriptionStatus: vi.fn(async () => ok(trialStarted ? trialSub() : sub({ provider: null, active: false, status: 'none', planCode: null, billingInterval: null, manageable: false }))),
      getQuotaStatus: vi.fn(async () => planRes(trialStarted ? paidQuota(STRIPE_MONTHLY) : freeQuota)),
      now: () => t,
    })
    c.setAuthLoading(false)
    c.setSignedIn(true)
    await c.load()
    expect(c.getSnapshot().state.status).toBe('free')
    trialStarted = true
    t += 31_000
    await c.loadOnFocus()
    expect(c.getSnapshot().state).toMatchObject({ status: 'trialing', trialEnd: TRIAL_END })
    c.dispose()
  })
})

describe('copy exists in every locale', () => {
  const KEYS = ['billing.trialThen', 'billing.trialEndsOnly', 'billing.trialNoDate', 'billing.trialCanceled', 'billing.trialCanceledNoDate', 'billing.trialStatus', 'billing.paymentFailed', 'billing.paymentFailedGrace'] as const

  it('every locale has every key, and date/price placeholders survive translation', () => {
    for (const locale of DESKTOP_I18N_LOCALES) {
      for (const key of KEYS) expect(translateDesktop(locale, key, { date: 'D', price: 'P', unit: 'U' }).length, `${locale} ${key}`).toBeGreaterThan(3)
      expect(translateDesktop(locale, 'billing.trialThen', { date: 'D', price: 'P', unit: 'U' })).toMatch(/D.*P.*U/s)
      expect(translateDesktop(locale, 'billing.trialCanceled', { date: 'D' })).toContain('D')
      expect(translateDesktop(locale, 'billing.paymentFailedGrace', { date: 'D' })).toContain('D')
      expect(translateDesktop(locale, 'billing.trialCanceled', { date: 'D' })).not.toMatch(/\{/)
    }
  })

  it('the owner-approved English strings are exact', () => {
    expect(translateDesktop('en', 'billing.trialThen', { date: 'Nov 6, 2026', price: '$4.99', unit: 'month' })).toBe('Free trial ends Nov 6, 2026, then $4.99/month.')
    expect(translateDesktop('en', 'billing.trialThen', { date: 'Nov 6, 2026', price: '$49.99', unit: 'year' })).toBe('Free trial ends Nov 6, 2026, then $49.99/year.')
    expect(translateDesktop('en', 'billing.trialCanceled', { date: 'Nov 6, 2026' })).toBe("Access through Nov 6, 2026. You won't be charged.")
    expect(translateDesktop('en', 'billing.paymentFailedGrace', { date: 'Nov 9, 2026' })).toBe("We couldn't process your payment. Access continues until Nov 9, 2026.")
    expect(translateDesktop('en', 'billing.paymentFailed')).toBe("We couldn't process your payment.")
  })
})
