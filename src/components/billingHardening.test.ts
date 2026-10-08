import { readFileSync } from 'node:fs'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QuotaStatusPayload, SubscriptionRecord } from '../lib/billing/billingClient'
import {
  FOCUS_REFRESH_MIN_INTERVAL_MS,
  createBillingController,
} from '../hooks/useBilling'
import {
  classifyEntitlementProvider,
  deriveBillingState,
  type BillingState,
} from '../lib/billing/billingState'
import {
  clearPendingBillingReturn,
  markExternalBillingAction,
  resetBillingReturnCoordinatorForTests,
} from '../lib/billing/billingReturnCoordinator'
import {
  LanguagePreferencesContext,
  type LanguagePreferencesContextValue,
} from '../languagePreferencesContext'
import { DEFAULT_LANGUAGE_PREFERENCES } from '../lib/languagePreferences'
import { DESKTOP_I18N_LOCALES, translateDesktop } from '../lib/desktopI18n'
import { formatCheckoutError } from './billingCheckoutCopy'
import { BillingPlanContent } from './BillingPlanModal'
import { RecordingV2 } from './RecordingV2'

vi.mock('./BillingPlanModal.css', () => ({}))

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const languageContextValue: LanguagePreferencesContextValue = {
  preferences: DEFAULT_LANGUAGE_PREFERENCES,
  setPreference: () => undefined,
  t: (key, vars) => translateDesktop('en', key, vars),
}
const withLanguage = (node: ReactNode): ReactNode =>
  createElement(LanguagePreferencesContext.Provider, { value: languageContextValue }, node)

const sub = (over: Partial<SubscriptionRecord> = {}): SubscriptionRecord => ({
  provider: null, active: false, planCode: null, billingInterval: null, status: 'none',
  currentPeriodEnd: null, cancelAtPeriodEnd: false, graceUntil: null, manageable: false, ...over,
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

const APPLE = { active: true, status: 'active', productId: 'com.aydenz.youmilensipad.student.monthly', planType: 'student_pass', expiresAt: '2026-11-20T00:00:00.000Z', source: 'app_store_subscription' }
const GIFT = { active: true, status: 'active', productId: 'admin_student_basic', planType: 'student_pass', expiresAt: '2027-01-01T00:00:00.000Z' }
const STRIPE = { active: true, status: 'active', productId: 'student_basic_monthly', planType: 'student_pass', expiresAt: '2026-11-06T00:00:00.000Z' }

function stateFor(quota: QuotaStatusPayload, subscription: SubscriptionRecord): BillingState {
  return deriveBillingState({ signedIn: true, loading: false, subscription, quota, error: null })
}
const render = (state: BillingState, extra: Partial<Parameters<typeof BillingPlanContent>[0]> = {}) =>
  renderToStaticMarkup(withLanguage(createElement(BillingPlanContent, { state, ...extra })))

afterEach(() => {
  resetBillingReturnCoordinatorForTests()
  vi.clearAllMocks()
})

describe('closed commercialization copy', () => {
  it('says plainly that Desktop subscriptions are not purchasable yet — not a generic failure', () => {
    const text = formatCheckoutError({ kind: 'http', message: 'Subscriptions are not available yet.', code: 'commercialization_not_available', status: 503 })
    expect(text).toBe('Desktop subscriptions aren’t available for purchase yet.')
    expect(text).not.toMatch(/couldn.t open|try again|network|payment/i)
  })

  it('explains an already-active plan (any provider) and an unconfirmed plan check', () => {
    for (const code of ['entitlement_already_active', 'subscription_already_exists']) {
      expect(formatCheckoutError({ kind: 'http', message: 'x', code, status: 409 })).toMatch(/already have an active Student Basic/)
    }
    expect(formatCheckoutError({ kind: 'http', message: 'x', code: 'entitlement_check_failed', status: 503 })).toMatch(/couldn.t confirm your plan/)
  })

  it('keeps the existing mappings (auth, network, unknown)', () => {
    expect(formatCheckoutError({ kind: 'auth', message: 'x', code: 'auth_required', status: 401 })).toMatch(/sign in again/i)
    expect(formatCheckoutError({ kind: 'network', message: 'x', code: 'network_error', status: null })).toMatch(/connection/i)
    expect(formatCheckoutError({ kind: 'http', message: 'x', code: 'something_else', status: 500 })).toMatch(/couldn.t open Checkout/)
  })
})

describe('provider-neutral entitlement classification', () => {
  it('maps backend source / product ids to a provider (presentation only)', () => {
    expect(classifyEntitlementProvider(APPLE)).toBe('apple')
    expect(classifyEntitlementProvider({ active: true, productId: 'com.aydenz.youmilensipad.studentbasic30d' })).toBe('apple')
    expect(classifyEntitlementProvider({ active: true, productId: 'x', source: 'app_store_subscription' })).toBe('apple')
    expect(classifyEntitlementProvider(GIFT)).toBe('granted')
    expect(classifyEntitlementProvider(STRIPE)).toBe('stripe')
    expect(classifyEntitlementProvider({ active: true, productId: 'something-new' })).toBe('other')
    expect(classifyEntitlementProvider(undefined)).toBe('other')
  })
})

describe('Apple / admin / Stripe entitlement UI', () => {
  it('Apple-managed: shows Student Basic active + Apple guidance, NO Upgrade, NO Portal, no invented renewal', () => {
    const state = stateFor(paidQuota(APPLE), sub())
    expect(state).toMatchObject({ status: 'active', manageable: false, entitlement: { provider: 'apple', expiresAt: APPLE.expiresAt } })
    const html = render(state, { onUpgrade: () => {}, onManage: () => {} })
    expect(html).toContain('Student Basic')
    expect(html).toContain('Your Student Basic subscription is managed through Apple.')
    expect(html).toContain('Access remains available through')
    expect(html).toContain('data-entitlement-provider="apple"')
    expect(html).not.toMatch(/Upgrade|Choose a new plan|Manage subscription|Opening Checkout/)
    expect(html).not.toContain('Renews') // no renewal date is claimed for a provider that exposes none here
  })

  it('admin gift: active, no Apple wording, no Upgrade, no Portal', () => {
    const html = render(stateFor(paidQuota(GIFT), sub()), { onUpgrade: () => {}, onManage: () => {} })
    expect(html).toContain('Student Basic access has been added to your account.')
    expect(html).not.toContain('Apple')
    expect(html).not.toMatch(/Upgrade|Manage subscription/)
  })

  it('Stripe-managed: shows Manage subscription and renewal, and no provider note', () => {
    const state = stateFor(
      paidQuota(STRIPE),
      sub({ provider: 'stripe', active: true, status: 'active', planCode: 'student_basic_monthly', billingInterval: 'month', currentPeriodEnd: '2026-11-06T00:00:00.000Z', manageable: true }),
    )
    const html = render(state, { onManage: () => {} })
    expect(html).toContain('Manage subscription')
    expect(html).toContain('Renews')
    expect(html).not.toContain('managed through Apple')
    expect(html).not.toMatch(/Upgrade|Choose a new plan/)
  })

  it('free state still offers Upgrade (and no provider note)', () => {
    const html = render(stateFor(freeQuota, sub()), { selectedPlan: 'student_basic_monthly', onUpgrade: () => {} })
    expect(html).toContain('data-billing-status="free"')
    expect(html).toContain('Upgrade to Student Basic')
    expect(html).not.toContain('managed through Apple')
  })

  it('an active entitlement never leaks into a free or signed-out render', () => {
    expect(render({ status: 'signed_out' })).not.toMatch(/managed through Apple|Student Basic access/)
    expect(stateFor(freeQuota, sub()).status).toBe('free')
  })

  it('the managed-by-provider copy exists in every locale', () => {
    for (const locale of DESKTOP_I18N_LOCALES) {
      for (const key of ['billing.managedApple', 'billing.managedGranted', 'billing.managedOther', 'limit.reached', 'limit.viewPlan'] as const) {
        expect(translateDesktop(locale, key).length, `${locale} ${key}`).toBeGreaterThan(3)
      }
    }
    expect(translateDesktop('en', 'billing.managedApple')).toBe('Your Student Basic subscription is managed through Apple.')
  })
})

/* ── Focus refresh + account switch ─────────────────────────────────────── */

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const ok = (subscription: SubscriptionRecord) => ({ ok: true as const, subscription })
const planRes = (plan: QuotaStatusPayload) => ({ ok: true as const, plan })

function controller(over: { getSub?: () => Promise<ReturnType<typeof ok>>; getQuota?: () => Promise<ReturnType<typeof planRes>>; now?: () => number } = {}) {
  const getSubscriptionStatus = vi.fn(over.getSub ?? (async () => ok(sub())))
  const getQuotaStatus = vi.fn(over.getQuota ?? (async () => planRes(freeQuota)))
  const c = createBillingController({ getSubscriptionStatus, getQuotaStatus, now: over.now })
  c.setAuthLoading(false)
  c.setSignedIn(true)
  return { c, getSubscriptionStatus, getQuotaStatus }
}

describe('focus refresh', () => {
  it('picks up an entitlement bought elsewhere when the app regains focus', async () => {
    let t = 1_000_000
    let bought = false
    const { c } = controller({
      now: () => t,
      getSub: async () => ok(sub()),
      getQuota: async () => planRes(bought ? paidQuota(APPLE) : freeQuota),
    })
    await c.load()
    expect(c.getSnapshot().state.status).toBe('free')
    bought = true // iPad purchase while Desktop stays open
    t += FOCUS_REFRESH_MIN_INTERVAL_MS + 1
    await c.loadOnFocus()
    expect(c.getSnapshot().state).toMatchObject({ status: 'active', entitlement: { provider: 'apple' } })
    c.dispose()
  })

  it('is bounded: repeated focus events inside the window do not refetch', async () => {
    let t = 5_000_000
    const { c, getQuotaStatus } = controller({ now: () => t })
    await c.load()
    expect(getQuotaStatus).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 5; i++) { t += 1_000; await c.loadOnFocus() }
    expect(getQuotaStatus).toHaveBeenCalledTimes(1)
    t += FOCUS_REFRESH_MIN_INTERVAL_MS
    await c.loadOnFocus()
    expect(getQuotaStatus).toHaveBeenCalledTimes(2)
    c.dispose()
  })

  it('never overlaps an in-flight read, and does nothing while signed out or auth is loading', async () => {
    const d = deferred<ReturnType<typeof planRes>>()
    let t = 9_000_000
    const { c, getQuotaStatus } = controller({ now: () => t, getQuota: () => d.promise })
    const first = c.load()
    t += FOCUS_REFRESH_MIN_INTERVAL_MS * 2
    await c.loadOnFocus()
    expect(getQuotaStatus).toHaveBeenCalledTimes(1)
    d.resolve(planRes(freeQuota)); await first
    c.setSignedIn(false)
    t += FOCUS_REFRESH_MIN_INTERVAL_MS * 2
    await c.loadOnFocus()
    expect(getQuotaStatus).toHaveBeenCalledTimes(1)
    c.dispose()
  })

  it('yields to the return-from-Checkout refresh that owns that focus event', async () => {
    let t = 20_000_000
    const { c, getQuotaStatus } = controller({ now: () => t })
    await c.load()
    markExternalBillingAction('checkout', t)
    t += FOCUS_REFRESH_MIN_INTERVAL_MS * 2
    await c.loadOnFocus()
    expect(getQuotaStatus).toHaveBeenCalledTimes(1)
    clearPendingBillingReturn()
    await c.loadOnFocus()
    expect(getQuotaStatus).toHaveBeenCalledTimes(2)
    c.dispose()
  })

  it('a failed background refresh keeps the last good plan instead of flashing "unavailable"', async () => {
    let t = 30_000_000
    let fail = false
    const { c } = controller({
      now: () => t,
      getQuota: async () => { if (fail) throw new Error('offline'); return planRes(paidQuota(APPLE)) },
    })
    await c.load()
    expect(c.getSnapshot().state.status).toBe('active')
    fail = true
    t += FOCUS_REFRESH_MIN_INTERVAL_MS + 1
    await c.loadOnFocus()
    expect(c.getSnapshot().state.status).toBe('active')
    c.dispose()
  })

  it('the hook wires window focus + visibility to the throttled refresh, with cleanup', () => {
    const src = read('../hooks/useBilling.ts')
    expect(src).toMatch(/addEventListener\('focus'/)
    expect(src).toMatch(/addEventListener\('visibilitychange'/)
    expect(src).toMatch(/removeEventListener\('focus'/)
    expect(src).toMatch(/loadOnFocus\(\)/)
    expect(src).toMatch(/FOCUS_REFRESH_MIN_INTERVAL_MS = 30_000/)
  })
})

describe('account switch', () => {
  it("a slow answer for the previous account can never overwrite the new account's plan", async () => {
    const a = deferred<ReturnType<typeof planRes>>()
    const b = deferred<ReturnType<typeof planRes>>()
    const answers = [a, b]
    let call = 0
    const { c } = controller({ getQuota: () => answers[call++].promise })
    const loadA = c.load() // user A (paid) — slow
    c.setSignedIn(false) // sign out
    c.setSignedIn(true) // user B signs in on the same controller
    const loadB = c.load()
    b.resolve(planRes(freeQuota)); await loadB
    expect(c.getSnapshot().state.status).toBe('free')
    a.resolve(planRes(paidQuota(APPLE))); await loadA // A's late answer arrives
    expect(c.getSnapshot().state.status).toBe('free') // still B
    c.dispose()
  })

  it('sign-out clears the plan; the next user never sees the previous one', async () => {
    const { c } = controller({ getQuota: async () => planRes(paidQuota(APPLE)) })
    await c.load()
    expect(c.getSnapshot().state.status).toBe('active')
    c.setSignedIn(false)
    expect(c.getSnapshot().state.status).toBe('signed_out')
    c.setSignedIn(true)
    expect(['loading', 'free', 'unavailable']).toContain(c.getSnapshot().state.status)
    expect(c.getSnapshot().state.status).not.toBe('active')
    c.dispose()
  })

  it('an unmounted controller ignores a late answer', async () => {
    const d = deferred<ReturnType<typeof planRes>>()
    const { c } = controller({ getQuota: () => d.promise })
    const p = c.load()
    c.dispose()
    d.resolve(planRes(paidQuota(APPLE))); await p
    expect(c.getSnapshot().state.status).not.toBe('active')
  })

  it('the app remounts per user (key = user id), so billing + usage state is rebuilt per account', () => {
    expect(read('../App.tsx')).toMatch(/<AuthenticatedApp\s+key=\{auth\.user\.id\}/)
  })
})

/* ── Limit reached ──────────────────────────────────────────────────────── */

describe('limit-reached UX', () => {
  const stage = { history: [], current: null }
  const renderRecording = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      withLanguage(
        createElement(RecordingV2, {
          t: (key, vars) => translateDesktop('en', key, vars),
          stage: 'recording', courseName: 'c', courseIdentity: { icon: 'edit', tint: 'sage' }, lectureTitle: 'x',
          elapsed: '0:01', languageLine: 'English', captions: stage, translationEnabled: false,
          notice: null, failureMessage: null, busy: false, canOpenOverlay: false,
          onOpenOverlay: () => {}, onDiscard: () => {}, onPause: () => {}, onResume: () => {}, onStopAndSave: () => {},
          onViewLecture: () => {}, onRecordAnother: () => {}, onRetry: () => {}, onRecoverRecording: () => {},
          onDiscardRecovery: () => {}, onCancelRecoveryDiscard: () => {}, recoveryDiscardConfirm: false,
          ...props,
        } as never),
      ),
    )

  it('the copy explains the limit and promises no purchase', () => {
    const copy = translateDesktop('en', 'limit.reached')
    expect(copy).toMatch(/reached your current usage limit/)
    expect(copy).not.toMatch(/buy|purchase|upgrade|subscribe|contact/i)
    expect(translateDesktop('en', 'limit.viewPlan')).toBe('View plan')
  })

  it('a limit notice renders the action that opens the plan view', () => {
    const html = renderRecording({
      notice: { tier: 'fatal', text: translateDesktop('en', 'limit.reached') },
      noticeAction: { label: 'View plan', onClick: () => {} },
    })
    expect(html).toContain('reached your current usage limit')
    expect(html).toContain('recording-v2__notice-action')
    expect(html).toContain('View plan')
  })

  it('no action renders for an ordinary notice', () => {
    const html = renderRecording({ notice: { tier: 'info', text: 'Realtime captions reconnecting…' }, noticeAction: null })
    expect(html).not.toContain('recording-v2__notice-action')
  })

  it('App wires every limit path to the plan view, drops the dead-end copy, and keeps the codes server-driven', () => {
    const app = read('../App.tsx')
    expect(app).not.toContain('Please contact Youmi Lens for more access')
    expect(app).toMatch(/action: 'open_plan' as const/)
    expect(app).toMatch(/liveCaptionChunkNotice\?\.action === 'open_plan'[\s\S]{0,160}setBillingPlanOpen\(true\)/)
    expect(app).toMatch(/failureAction=\{[\s\S]{0,260}setBillingPlanOpen\(true\)/)
    // The server still decides: these are the codes the engine reports, none removed or weakened.
    for (const code of ['beta_limit_reached', 'recording_too_long', 'daily_recording_limit_reached', 'quota_suspended', 'session_limit_reached']) {
      expect(app).toContain(`'${code}'`)
    }
    // The limit message handler must not depend on the UI language (it lives in a long-lived effect).
    expect(app).toMatch(/tDesktopRef\.current\('limit\.reached'\)/)
  })
})
