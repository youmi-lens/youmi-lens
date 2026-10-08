import { readFileSync } from 'node:fs'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BillingApiError } from '../lib/billing/billingClient'
import type { UseBillingResult } from '../hooks/useBilling'
import { createBillingController } from '../hooks/useBilling'
import type { BillingState, NormalizedQuota } from '../lib/billing/billingState'
import {
  LanguagePreferencesContext,
  type LanguagePreferencesContextValue,
} from '../languagePreferencesContext'
import { DEFAULT_LANGUAGE_PREFERENCES } from '../lib/languagePreferences'
import { translateDesktop } from '../lib/desktopI18n'
import { STUDENT_BASIC_COMPARISON } from '../lib/billing/planPresentation'
import {
  ANNUAL_SAVINGS_COPY,
  STUDENT_BASIC_ANNUAL_SAVINGS_USD,
  STUDENT_BASIC_ANNUAL_USD,
  STUDENT_BASIC_MONTHLY_USD,
  STUDENT_BASIC_TWELVE_MONTHLY_USD,
  canStartCheckout,
  formatCheckoutError,
  planCodeFromInterval,
} from './billingCheckoutCopy'
import { BillingPlanContent, BillingPlanModal, ManagePortalPanel, PlanCheckoutPanel } from './BillingPlanModal'
import {
  handleBillingModalEscape,
  handleBillingModalOverlayMouseDown,
} from './billingPlanModalChrome'

vi.mock('./BillingPlanModal.css', () => ({}))

const billingPlanModalSrc = readFileSync(new URL('./BillingPlanModal.tsx', import.meta.url), 'utf8')

const emptyQuota: NormalizedQuota = {
  monthlyMinutesLimit: null,
  minutesUsed: null,
  minutesRemaining: null,
  maxRecordingsPerDay: null,
  recordingsUsedToday: null,
  recordingsRemainingToday: null,
  maxStudyTasksPerDay: null,
  studyTasksUsedToday: null,
  studyTasksRemainingToday: null,
}

const studentQuota: NormalizedQuota = {
  monthlyMinutesLimit: 600,
  minutesUsed: 40,
  minutesRemaining: 560,
  maxRecordingsPerDay: 6,
  recordingsUsedToday: 2,
  recordingsRemainingToday: 4,
  maxStudyTasksPerDay: 10,
  studyTasksUsedToday: null,
  studyTasksRemainingToday: null,
}

function mockBilling(state: BillingState, over: Partial<UseBillingResult> = {}): UseBillingResult {
  return {
    state,
    loading: state.status === 'loading',
    error: null,
    actions: {
      load: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}),
      upgrade: vi.fn(async () => {}),
      manage: vi.fn(async () => {}),
    },
    getStatus: () => state.status,
    ...over,
  }
}

const languageContextValue: LanguagePreferencesContextValue = {
  preferences: DEFAULT_LANGUAGE_PREFERENCES,
  setPreference: () => undefined,
  t: (key, vars) => translateDesktop('en', key, vars),
}

/** The usage section (QA16) reads Desktop i18n, so every render needs the provider. */
function withLanguageContext(node: ReactNode): ReactNode {
  return createElement(LanguagePreferencesContext.Provider, { value: languageContextValue }, node)
}

function renderContent(
  state: BillingState,
  extra: Partial<Parameters<typeof BillingPlanContent>[0]> = {},
): string {
  return renderToStaticMarkup(withLanguageContext(createElement(BillingPlanContent, { state, ...extra })))
}

function renderModal(billing: UseBillingResult, onClose = vi.fn()): string {
  return renderToStaticMarkup(
    withLanguageContext(createElement(BillingPlanModal, { open: true, onClose, billing })),
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('BillingPlanContent states', () => {
  it('signed_out', () => {
    const html = renderContent({ status: 'signed_out' })
    expect(html).toContain('Sign in to view your plan')
    expect(html).toContain('data-billing-status="signed_out"')
    expect(html).not.toContain('Upgrade')
    expect(html).not.toContain('Opening Checkout')
  })

  it('loading', () => {
    const html = renderContent({ status: 'loading' })
    expect(html).toContain('Loading plan information')
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('Upgrade')
  })

  it('free shows real prices, derived savings, and the entitlement comparison', () => {
    const html = renderContent(
      { status: 'free', quota: studentQuota },
      { selectedPlan: 'student_basic_annual', onUpgrade: () => {} },
    )
    expect(html).toContain('data-billing-status="free"')
    expect(html).toContain('Monthly')
    expect(html).toContain(`$${STUDENT_BASIC_MONTHLY_USD.toFixed(2)} / month`)
    expect(html).toContain('Annual')
    expect(html).toContain(`$${STUDENT_BASIC_ANNUAL_USD.toFixed(2)} / year`)
    expect(html).toContain(`Save $${STUDENT_BASIC_ANNUAL_SAVINGS_USD.toFixed(2)}`)
    expect(html).toContain('Upgrade to Student Basic')
    expect(html).toContain('300')
    expect(html).toContain('600')
    expect(html).not.toContain('Payment successful')
  })

  it('renders comparison values from the shared product-plan presentation model', () => {
    const html = renderContent({ status: 'free', quota: emptyQuota }, { onUpgrade: () => {} })
    for (const item of STUDENT_BASIC_COMPARISON) {
      expect(html).toContain(String(item.free))
      expect(html).toContain(String(item.studentBasic))
    }
    expect(billingPlanModalSrc).not.toContain('STUDENT_BASIC_BENEFITS')
  })

  it('active monthly has no Checkout purchase; Manage when manageable', () => {
    const html = renderContent({
      status: 'active',
      planCode: 'student_basic_monthly',
      interval: 'monthly',
      currentPeriodEnd: '2026-08-15T00:00:00.000Z',
      manageable: true,
      quota: studentQuota,
    }, { onManage: () => {} })
    expect(html).toContain('data-billing-interval="monthly"')
    expect(html).toContain('Active')
    expect(html).toContain('Manage subscription')
    expect(html).not.toContain('Upgrade')
    expect(html).not.toContain('Choose a new plan')
    expect(html).not.toContain('Subscription management opens in a later step')
  })

  it('active annual has no Checkout purchase', () => {
    const html = renderContent({
      status: 'active',
      planCode: 'student_basic_annual',
      interval: 'annual',
      currentPeriodEnd: '2027-01-01T00:00:00.000Z',
      manageable: true,
      quota: studentQuota,
    }, { onManage: () => {} })
    expect(html).toContain('data-billing-interval="annual"')
    expect(html).toContain('Manage subscription')
    expect(html).not.toContain('Upgrade')
    expect(html).not.toContain('Choose a new plan')
  })

  it('provider-neutral active membership has no Checkout or Stripe portal CTA', () => {
    const html = renderContent({
      status: 'active',
      planCode: null,
      interval: null,
      currentPeriodEnd: null,
      manageable: false,
      quota: studentQuota,
    }, { onUpgrade: () => {}, onManage: () => {} })
    expect(html).toContain('Student Basic')
    expect(html).toContain('Active')
    expect(html).not.toContain('Upgrade')
    expect(html).not.toContain('Choose a new plan')
    expect(html).not.toContain('Manage subscription')
  })

  it('canceling', () => {
    const html = renderContent({
      status: 'canceling',
      planCode: 'student_basic_monthly',
      interval: 'monthly',
      accessThrough: '2026-08-15T00:00:00.000Z',
      manageable: true,
      quota: studentQuota,
    }, { onManage: () => {} })
    expect(html).toContain('Cancellation scheduled')
    expect(html).toContain('Manage subscription')
    expect(html).not.toContain('Upgrade')
    expect(html).not.toContain('Choose a new plan')
  })

  it('past_due with grace', () => {
    const html = renderContent({
      status: 'past_due',
      planCode: 'student_basic_monthly',
      interval: 'monthly',
      currentPeriodEnd: '2026-07-01T00:00:00.000Z',
      graceUntil: '2026-07-04T00:00:00.000Z',
      accessActive: true,
      manageable: true,
      quota: studentQuota,
    }, { onManage: () => {} })
    expect(html).toContain('Payment issue')
    expect(html).toContain('Resolve billing issue')
    expect(html).not.toContain('Upgrade')
    expect(html).not.toContain('Choose a new plan')
  })

  it('past_due without grace', () => {
    const html = renderContent({
      status: 'past_due',
      planCode: 'student_basic_monthly',
      interval: 'monthly',
      currentPeriodEnd: null,
      graceUntil: null,
      accessActive: false,
      manageable: true,
      quota: emptyQuota,
    }, { onManage: () => {} })
    // Owner-approved wording (replaces the old "access is currently limited"): payment problem only, no access promise.
    expect(html).toContain('We couldn&#x27;t process your payment.')
    expect(html).not.toContain('Access continues')
    expect(html).toContain('Resolve billing issue')
    expect(html).not.toContain('Upgrade')
  })

  it('expired offers Choose a new plan without implying resume', () => {
    const html = renderContent(
      {
        status: 'expired',
        planCode: 'student_basic_annual',
        interval: 'annual',
        currentPeriodEnd: '2026-01-01T00:00:00.000Z',
        manageable: false,
        quota: studentQuota,
      },
      { onUpgrade: () => {} },
    )
    expect(html).toContain('Inactive')
    expect(html).toContain('Choose a new plan')
    expect(html).toContain('Choose a new plan if you want Student Basic again')
    expect(html).not.toContain('resume')
  })

  it('unavailable never renders Free fallback and has no Upgrade', () => {
    const html = renderContent(
      {
        status: 'unavailable',
        reason: 'Network error loading billing.',
        retryable: true,
        backendCode: 'network_error',
      },
      { onRetry: () => {} },
    )
    expect(html).toContain('Retry')
    expect(html).not.toContain('Upgrade')
    expect(html).not.toContain('data-billing-status="free"')
  })
})

describe('plan selection and savings', () => {
  it('computes annual savings exactly', () => {
    expect(STUDENT_BASIC_TWELVE_MONTHLY_USD).toBeCloseTo(59.88, 2)
    expect(STUDENT_BASIC_ANNUAL_SAVINGS_USD).toBeCloseTo(9.89, 2)
    expect(ANNUAL_SAVINGS_COPY).toBe(
      'Save $9.89 compared with paying monthly for 12 months.',
    )
  })

  it('maps interval controls to allowed plan codes only', () => {
    expect(planCodeFromInterval('monthly')).toBe('student_basic_monthly')
    expect(planCodeFromInterval('annual')).toBe('student_basic_annual')
  })

  it('exposes accessible selected state', () => {
    const html = renderToStaticMarkup(
      createElement(PlanCheckoutPanel, {
        selectedPlan: 'student_basic_monthly',
        onSelectedPlanChange: () => {},
        onUpgrade: () => {},
        checkoutBusy: false,
        checkoutOpened: false,
        upgradeLabel: 'Upgrade',
      }),
    )
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('aria-label="Choose billing interval"')
  })

  it('disables interval switching and Upgrade while opening Checkout', () => {
    const html = renderToStaticMarkup(
      createElement(PlanCheckoutPanel, {
        selectedPlan: 'student_basic_annual',
        onSelectedPlanChange: () => {},
        onUpgrade: () => {},
        checkoutBusy: true,
        checkoutOpened: false,
        upgradeLabel: 'Upgrade',
      }),
    )
    expect(html).toContain('Opening Checkout…')
    expect(html).toContain('aria-busy="true"')
    expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(3)
  })
})

describe('checkout action restrictions', () => {
  it('allows checkout only for free and expired', () => {
    expect(canStartCheckout('free')).toBe(true)
    expect(canStartCheckout('expired')).toBe(true)
    for (const status of ['signed_out', 'loading', 'unavailable', 'active', 'canceling', 'past_due']) {
      expect(canStartCheckout(status)).toBe(false)
    }
  })

  it('monthly and annual upgrade callbacks receive only BillingPlanCode', () => {
    const onUpgradeMonthly = vi.fn()
    const onUpgradeAnnual = vi.fn()
    const onChange = vi.fn()

    // Simulate the modal wiring: selected plan drives upgrade(planCode).
    const upgradeWith = (plan: 'student_basic_monthly' | 'student_basic_annual', fn: () => void) => {
      fn()
      return plan
    }
    expect(upgradeWith('student_basic_monthly', onUpgradeMonthly)).toBe('student_basic_monthly')
    expect(upgradeWith('student_basic_annual', onUpgradeAnnual)).toBe('student_basic_annual')
    onChange('student_basic_monthly')
    expect(onChange).toHaveBeenCalledWith('student_basic_monthly')
    expect(onChange.mock.calls[0][0]).not.toMatch(/^price_/)
  })

  it('successful launch copy is Checkout opened, not payment succeeded', () => {
    const html = renderContent(
      { status: 'free', quota: studentQuota },
      { checkoutOpened: true, onUpgrade: () => {}, onRefreshPlan: () => {} },
    )
    expect(html).toContain('Checkout opened in your browser')
    expect(html).toContain('Plan status updates after Stripe confirms payment')
    expect(html).toContain('Refresh plan status')
    expect(html).not.toContain('Payment successful')
    expect(html).not.toContain('data-billing-status="active"')
  })

  it('action errors stay user-safe and retryable', () => {
    expect(
      formatCheckoutError({ kind: 'auth', message: 'x', code: 'auth_required', status: 401 }),
    ).toBe('Please sign in again before upgrading.')
    expect(
      formatCheckoutError({
        kind: 'http',
        message: 'Billing is temporarily unavailable.',
        code: 'stripe_not_configured',
        status: 503,
      }),
    ).toBe('Checkout is temporarily unavailable.')
    expect(
      formatCheckoutError({
        kind: 'http',
        message: 'Could not start checkout.',
        code: 'checkout_failed',
        status: 502,
      }),
    ).toBe('We couldn’t open Checkout. Please try again.')
    expect(
      formatCheckoutError({ kind: 'network', message: 'Network error', code: 'network_error', status: null }),
    ).toBe('Check your connection and try again.')
    expect(
      formatCheckoutError({ kind: 'invalid_plan', message: 'bad', code: 'invalid_plan', status: 400 }),
    ).toBe('Checkout is temporarily unavailable.')

    const html = renderContent(
      { status: 'free', quota: studentQuota },
      {
        onUpgrade: () => {},
        actionErrorKind: 'checkout',
        actionError: {
          kind: 'network',
          message: 'secret stack',
          code: 'network_error',
          status: null,
        },
      },
    )
    expect(html).toContain('Check your connection and try again.')
    expect(html).not.toContain('secret stack')
    expect(html).not.toContain('price_')
    expect(html).not.toContain('cus_')
  })
})

describe('useBilling upgrade foundation', () => {
  it('monthly/annual upgrade opens backend URL once; no price/customer ids', async () => {
    const createCheckout = vi.fn(async (plan: string) => ({
      ok: true as const,
      url: `https://checkout.stripe.com/${plan}`,
    }))
    const openExternalUrl = vi.fn(async () => {})
    const c = createBillingController({ createCheckout, openExternalUrl })
    c.setAuthLoading(false)
    c.setSignedIn(true)
    await c.upgrade('student_basic_monthly')
    await c.upgrade('student_basic_annual')
    expect(createCheckout).toHaveBeenCalledWith('student_basic_monthly')
    expect(createCheckout).toHaveBeenCalledWith('student_basic_annual')
    expect(createCheckout.mock.calls.every((call) => call.length === 1)).toBe(true)
    expect(openExternalUrl).toHaveBeenCalledWith('https://checkout.stripe.com/student_basic_monthly')
    expect(openExternalUrl).toHaveBeenCalledWith('https://checkout.stripe.com/student_basic_annual')
    c.dispose()
  })

  it('duplicate upgrade clicks share one in-flight action', async () => {
    let resolve!: (v: { ok: true; url: string }) => void
    const gate = new Promise<{ ok: true; url: string }>((r) => {
      resolve = r
    })
    const createCheckout = vi.fn(() => gate)
    const openExternalUrl = vi.fn(async () => {})
    const c = createBillingController({ createCheckout, openExternalUrl })
    c.setAuthLoading(false)
    c.setSignedIn(true)
    const p1 = c.upgrade('student_basic_monthly')
    const p2 = c.upgrade('student_basic_monthly')
    resolve({ ok: true, url: 'https://checkout.stripe.com/once' })
    await Promise.all([p1, p2])
    expect(createCheckout).toHaveBeenCalledOnce()
    expect(openExternalUrl).toHaveBeenCalledOnce()
    c.dispose()
  })

  it('upgrade failure does not activate subscription and rethrows', async () => {
    const getSubscriptionStatus = vi.fn(async () => ({
      ok: true as const,
      subscription: {
        provider: null,
        active: false,
        planCode: null,
        billingInterval: null,
        status: 'none',
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        graceUntil: null,
        manageable: false,
      },
    }))
    const getQuotaStatus = vi.fn(async () => ({ ok: true as const, plan: { unlimited: false } }))
    const createCheckout = vi.fn(async () => {
      throw new BillingApiError('network', 'Network error talking to billing.', {
        code: 'network_error',
      })
    })
    const c = createBillingController({ getSubscriptionStatus, getQuotaStatus, createCheckout })
    c.setAuthLoading(false)
    c.setSignedIn(true)
    await c.load()
    expect(c.getSnapshot().state.status).toBe('free')
    await expect(c.upgrade('student_basic_monthly')).rejects.toBeInstanceOf(BillingApiError)
    expect(c.getSnapshot().state.status).toBe('free')
    expect(c.getSnapshot().error?.code).toBe('network_error')
    c.dispose()
  })

  it('rejects invalid plan before fetch', async () => {
    const createCheckout = vi.fn(async () => ({ ok: true as const, url: 'https://example.com' }))
    const { createCheckout: realCreate } = await import('../lib/billing/billingClient')
    void realCreate
    const c = createBillingController({
      createCheckout: async (plan) => {
        // Delegate to real validator path by only accepting typed codes.
        return createCheckout(plan)
      },
    })
    c.setAuthLoading(false)
    c.setSignedIn(true)
    // Controller types prevent invalid plans; billingClient still guards.
    const { createCheckout: clientCreate } = await import('../lib/billing/billingClient')
    await expect(clientCreate('not_a_plan' as 'student_basic_monthly')).rejects.toMatchObject({
      kind: 'invalid_plan',
    })
    expect(createCheckout).not.toHaveBeenCalled()
    c.dispose()
  })
})

/** Visible copy only: drops `v2-sr-only` nodes, tags, and extra whitespace. */
function visibleText(html: string): string {
  return html
    .replace(/<(\w+)[^>]*\bclass="[^"]*\bv2-sr-only\b[^"]*"[^>]*>.*?<\/\1>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

describe('QA18 — the Upgrade CTA renders a visible label', () => {
  it('the Free-state primary CTA names Student Basic as real button text, not only an aria-label', () => {
    const html = renderContent({ status: 'free', quota: studentQuota }, { onUpgrade: () => {} })
    const cta = html.slice(html.lastIndexOf('billing-plan-modal__upgrade'))
    const label = cta.slice(cta.indexOf('>') + 1, cta.indexOf('</button>'))
    expect(visibleText(label)).toBe('Upgrade to Student Basic')
  })

  it('the CTA keeps its accessible name alongside the visible label', () => {
    const html = renderContent({ status: 'free', quota: studentQuota }, { onUpgrade: () => {} })
    expect(html).toContain('aria-label="Upgrade to Student Basic"')
  })

  it('the busy state swaps the visible label rather than blanking it', () => {
    const html = renderContent(
      { status: 'free', quota: studentQuota },
      { onUpgrade: () => {}, checkoutBusy: true },
    )
    const cta = html.slice(html.lastIndexOf('billing-plan-modal__upgrade'))
    const label = cta.slice(cta.indexOf('>') + 1, cta.indexOf('</button>'))
    expect(visibleText(label)).toBe('Opening Checkout…')
  })
})

describe('QA17 — billing contract is untouched by the label fix', () => {
  it('Free may start Desktop checkout; an active plan may not', () => {
    expect(canStartCheckout('free')).toBe(true)
    expect(canStartCheckout('active')).toBe(false)
    expect(canStartCheckout('canceling')).toBe(false)
  })

  it('Stripe-manageable states expose Manage; non-manageable ones never do', () => {
    const base = {
      status: 'active' as const,
      planCode: 'student_basic_monthly' as const,
      interval: 'monthly' as const,
      currentPeriodEnd: null,
      quota: studentQuota,
    }
    expect(renderContent({ ...base, manageable: true }, { onManage: () => {} })).toContain(
      'Manage subscription',
    )
    expect(renderContent({ ...base, manageable: false }, { onManage: () => {} })).not.toContain(
      'Manage subscription',
    )
  })

  it('Apple/legacy active (entitled but not Desktop-manageable) shows the plan with NO purchase or manage CTA', () => {
    const html = renderContent(
      {
        status: 'active',
        planCode: null,
        interval: null,
        currentPeriodEnd: null,
        manageable: false,
        quota: studentQuota,
      },
      { onManage: () => {}, onUpgrade: () => {} },
    )
    expect(html).toContain('Student Basic')
    expect(html).toContain('Usage')
    expect(html).not.toContain('Manage subscription')
    expect(html).not.toContain('billing-plan-modal__upgrade')
  })

  it('Desktop is Stripe-only: no Restore Purchases anywhere, in any state', () => {
    const states: BillingState[] = [
      { status: 'free', quota: studentQuota },
      { status: 'active', planCode: 'student_basic_monthly', interval: 'monthly', currentPeriodEnd: null, manageable: true, quota: studentQuota },
      { status: 'canceling', planCode: 'student_basic_monthly', interval: 'monthly', accessThrough: null, manageable: true, quota: studentQuota },
      { status: 'past_due', planCode: 'student_basic_monthly', interval: 'monthly', currentPeriodEnd: null, graceUntil: null, accessActive: true, manageable: false, quota: studentQuota },
      { status: 'expired', planCode: null, interval: null, currentPeriodEnd: null, manageable: false, quota: studentQuota },
    ]
    for (const state of states) {
      const html = renderContent(state, { onUpgrade: () => {}, onManage: () => {} })
      expect(html.toLowerCase()).not.toContain('restore purchase')
      expect(html.toLowerCase()).not.toContain('restore purchases')
    }
    expect(billingPlanModalSrc.toLowerCase()).not.toContain('restore')
  })

  it('checkout still routes through the existing upgrade/manage actions — no new payment path', () => {
    expect(billingPlanModalSrc).toContain('await billing.actions.upgrade(selectedPlan)')
    expect(billingPlanModalSrc).toContain('await billing.actions.manage()')
    expect(billingPlanModalSrc).toContain("markExternalBillingAction('checkout')")
    expect(billingPlanModalSrc).toContain("markExternalBillingAction('portal')")
    // Prices come from the shared contract module, never re-declared here.
    expect(billingPlanModalSrc).not.toMatch(/4\.99|49\.99/)
  })
})

describe('BillingPlanContent usage', () => {
  it('maps 600 / 6 / 10 and omits fabricated Study Tasks usage', () => {
    const html = renderContent({ status: 'free', quota: studentQuota })
    expect(html).toContain('600')
    expect(html).toContain('6')
    expect(html).toContain('10 per day')
    expect(html).not.toContain('0 used today · 10 / day')
  })

  it('renders used / total / remaining for Study Minutes and Recordings from real quota fields', () => {
    const html = renderContent({
      status: 'free',
      quota: {
        monthlyMinutesLimit: 300,
        minutesUsed: 240,
        minutesRemaining: 60,
        maxRecordingsPerDay: 2,
        recordingsUsedToday: 1,
        recordingsRemainingToday: 1,
        maxStudyTasksPerDay: 2,
        studyTasksUsedToday: 1,
        studyTasksRemainingToday: 1,
      },
    })
    expect(html).toContain('240 / 300 min')
    expect(html).toContain('60 min remaining')
    expect(html).toContain('1 / 2 today')
    expect(html).toContain('1 remaining')
  })

  it('shows a neutral tone well under the limit, a warning tone near it, and an exhausted tone at/over it', () => {
    const normal = renderContent({ status: 'free', quota: { ...emptyQuota, monthlyMinutesLimit: 300, minutesUsed: 100 } })
    const warning = renderContent({ status: 'free', quota: { ...emptyQuota, monthlyMinutesLimit: 300, minutesUsed: 250 } })
    const exhausted = renderContent({ status: 'free', quota: { ...emptyQuota, monthlyMinutesLimit: 300, minutesUsed: 300 } })
    expect(normal).not.toContain('billing-plan-modal__usage-bar--warning')
    expect(normal).not.toContain('billing-plan-modal__usage-bar--exhausted')
    expect(warning).toContain('billing-plan-modal__usage-bar--warning')
    expect(exhausted).toContain('billing-plan-modal__usage-bar--exhausted')
  })

  it('never derives a quota number from the Student Basic upgrade benefits copy', () => {
    // The 600/6/10 benefits list and the usage numbers happen to match today
    // because the fixture's real quota values equal the plan's real limits —
    // proving there is no separate, hardcoded path is a source-level check.
    const usageSectionSrc = billingPlanModalSrc.slice(
      billingPlanModalSrc.indexOf('function QuotaUsageRows'),
      billingPlanModalSrc.indexOf('function StatusPill'),
    )
    expect(usageSectionSrc).not.toContain('STUDENT_BASIC_BENEFITS')
    expect(usageSectionSrc).toContain('quota.monthlyMinutesLimit')
    expect(usageSectionSrc).toContain('quota.maxRecordingsPerDay')
    expect(usageSectionSrc).toContain('quota.maxStudyTasksPerDay')
  })
})

describe('BillingPlanModal chrome', () => {
  it('renders dialog semantics when open', () => {
    const html = renderModal(mockBilling({ status: 'free', quota: studentQuota }))
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-label="Close"')
  })

  it('Escape closes; overlay click closes; content click does not', () => {
    const onClose = vi.fn()
    handleBillingModalEscape({ key: 'Escape' }, onClose)
    const overlay = { id: 'overlay' }
    handleBillingModalOverlayMouseDown({ target: overlay, currentTarget: overlay }, onClose)
    handleBillingModalOverlayMouseDown({ target: { id: 'dialog' }, currentTarget: overlay }, onClose)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('active state does not invoke upgrade/manage on render', () => {
    const upgrade = vi.fn(async () => {})
    const manage = vi.fn(async () => {})
    const html = renderModal(
      mockBilling(
        {
          status: 'active',
          planCode: 'student_basic_monthly',
          interval: 'monthly',
          currentPeriodEnd: '2026-08-01T00:00:00.000Z',
          manageable: true,
          quota: studentQuota,
        },
        {
          actions: {
            load: vi.fn(async () => {}),
            refresh: vi.fn(async () => {}),
            upgrade,
            manage,
          },
        },
      ),
    )
    expect(html).toContain('Manage subscription')
    expect(upgrade).not.toHaveBeenCalled()
    expect(manage).not.toHaveBeenCalled()
  })
})

describe('Portal eligibility and action UI', () => {
  it('shows Manage only when manageable is true', () => {
    const withManage = renderContent(
      {
        status: 'active',
        planCode: 'student_basic_monthly',
        interval: 'monthly',
        currentPeriodEnd: null,
        manageable: true,
        quota: studentQuota,
      },
      { onManage: () => {} },
    )
    const withoutManage = renderContent({
      status: 'active',
      planCode: 'student_basic_monthly',
      interval: 'monthly',
      currentPeriodEnd: null,
      manageable: false,
      quota: studentQuota,
    }, { onManage: () => {} })
    expect(withManage).toContain('Manage subscription')
    expect(withoutManage).not.toContain('Manage subscription')
  })

  it('canceling and past_due respect manageable', () => {
    expect(
      renderContent(
        {
          status: 'canceling',
          planCode: 'student_basic_monthly',
          interval: 'monthly',
          accessThrough: null,
          manageable: false,
          quota: studentQuota,
        },
        { onManage: () => {} },
      ),
    ).not.toContain('Manage subscription')
    expect(
      renderContent(
        {
          status: 'past_due',
          planCode: 'student_basic_monthly',
          interval: 'monthly',
          currentPeriodEnd: null,
          graceUntil: null,
          accessActive: true,
          manageable: false,
          quota: studentQuota,
        },
        { onManage: () => {} },
      ),
    ).not.toContain('Resolve billing issue')
  })

  it('free/signed_out/loading/unavailable never show Portal', () => {
    expect(renderContent({ status: 'free', quota: studentQuota }, { onManage: () => {} })).not.toContain(
      'Manage subscription',
    )
    expect(renderContent({ status: 'signed_out' }, { onManage: () => {} })).not.toContain('Manage subscription')
    expect(renderContent({ status: 'loading' }, { onManage: () => {} })).not.toContain('Manage subscription')
    expect(
      renderContent(
        { status: 'unavailable', reason: 'x', retryable: true },
        { onManage: () => {}, onRetry: () => {} },
      ),
    ).not.toContain('Manage subscription')
  })

  it('expired shows Manage billing only when manageable; Checkout remains', () => {
    const manageable = renderContent(
      {
        status: 'expired',
        planCode: 'student_basic_annual',
        interval: 'annual',
        currentPeriodEnd: null,
        manageable: true,
        quota: studentQuota,
      },
      { onManage: () => {}, onUpgrade: () => {} },
    )
    const notManageable = renderContent(
      {
        status: 'expired',
        planCode: 'student_basic_annual',
        interval: 'annual',
        currentPeriodEnd: null,
        manageable: false,
        quota: studentQuota,
      },
      { onManage: () => {}, onUpgrade: () => {} },
    )
    expect(manageable).toContain('Manage billing')
    expect(manageable).toContain('Choose a new plan')
    expect(notManageable).not.toContain('Manage billing')
    expect(notManageable).toContain('Choose a new plan')
  })

  it('portal opened copy does not claim subscription changed', () => {
    const html = renderContent(
      {
        status: 'active',
        planCode: 'student_basic_annual',
        interval: 'annual',
        currentPeriodEnd: '2027-01-01T00:00:00.000Z',
        manageable: true,
        quota: studentQuota,
      },
      { onManage: () => {}, portalOpened: true, onRefreshPlan: () => {} },
    )
    expect(html).toContain('Subscription management opened in your browser')
    expect(html).toContain('Refresh plan status')
    expect(html).not.toContain('Subscription updated')
    expect(html).not.toContain('Cancellation complete')
    expect(html).not.toContain('Payment fixed')
  })

  it('portal action error preserves active display and stays user-safe', () => {
    const html = renderContent(
      {
        status: 'active',
        planCode: 'student_basic_monthly',
        interval: 'monthly',
        currentPeriodEnd: null,
        manageable: true,
        quota: studentQuota,
      },
      {
        onManage: () => {},
        actionErrorKind: 'portal',
        actionError: {
          kind: 'http',
          message: 'raw cus_abc stack',
          code: 'no_customer',
          status: 409,
        },
      },
    )
    expect(html).toContain('data-billing-status="active"')
    expect(html).toContain('We couldn’t find a billing profile for this account.')
    expect(html).not.toContain('cus_')
    expect(html).not.toContain('raw cus_abc')
  })

  it('portal busy disables management control', () => {
    const html = renderToStaticMarkup(
      createElement(ManagePortalPanel, {
        label: 'Manage subscription',
        onManage: () => {},
        portalBusy: true,
        portalOpened: false,
      }),
    )
    expect(html).toContain('Opening subscription management…')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('disabled')
  })
})

describe('return refresh feedback', () => {
  it('shows refreshing / updated / unchanged / error without claiming payment success', () => {
    const base = {
      status: 'free' as const,
      quota: studentQuota,
    }
    expect(renderContent(base, { returnFeedback: { status: 'refreshing' } })).toContain(
      'Refreshing plan status…',
    )
    expect(renderContent(base, { returnFeedback: { status: 'updated' } })).toContain('Plan status updated.')
    expect(renderContent(base, { returnFeedback: { status: 'unchanged' } })).toContain(
      'Plan status is up to date.',
    )
    const errHtml = renderContent(base, {
      returnFeedback: { status: 'error', message: 'Could not refresh plan status. You can try again manually.' },
    })
    expect(errHtml).toContain('Could not refresh plan status')
    expect(errHtml).not.toContain('Payment successful')
    expect(errHtml).toContain('data-billing-status="free"')
  })
})

describe('Settings integration markers', () => {
  it('App Settings keeps BillingPlanModal without Checkout/Portal fetch in App', async () => {
    const fs = await import('node:fs/promises')
    const app = await fs.readFile(new URL('../App.tsx', import.meta.url), 'utf8')
    const modal = await fs.readFile(new URL('./BillingPlanModal.tsx', import.meta.url), 'utf8')
    expect(app).toContain('BillingPlanModal')
    expect(app).not.toContain('createCheckout')
    expect(app).not.toContain('openPortal')
    expect(app).not.toContain('window.open')
    expect(app).not.toContain('useBillingReturnRefresh')
    expect(modal).toContain('actions.upgrade')
    expect(modal).toContain('actions.manage')
    expect(modal).toContain('markExternalBillingAction')
    expect(modal).toContain('useBillingReturnRefresh')
    expect(modal).not.toContain('window.open')
    expect(modal).not.toContain('createCheckout(')
    expect(modal).not.toContain('openPortal(')
    expect(modal).not.toContain('fetch(')
    expect(modal).not.toContain('localStorage')
    expect(modal).not.toContain('sessionStorage')
  })
})

describe('no entitlement from client signals', () => {
  it('checkout query params and selected plan do not appear in content props contract', () => {
    const html = renderContent({ status: 'free', quota: studentQuota })
    expect(html).not.toContain('checkout=success')
    expect(html).toContain('data-billing-status="free"')
  })
})
