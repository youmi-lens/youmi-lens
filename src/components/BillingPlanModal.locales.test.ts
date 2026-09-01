import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { UseBillingResult } from '../hooks/useBilling'
import type { BillingState, NormalizedQuota } from '../lib/billing/billingState'
import {
  LanguagePreferencesContext,
  type LanguagePreferencesContextValue,
} from '../languagePreferencesContext'
import { DEFAULT_LANGUAGE_PREFERENCES } from '../lib/languagePreferences'
import { translateDesktop, type DesktopI18nKey, type DesktopI18nVars } from '../lib/desktopI18n'
import type { ContentLanguageCode } from '../lib/contentLanguages'
import { BillingPlanContent, BillingPlanModal } from './BillingPlanModal'

vi.mock('./BillingPlanModal.css', () => ({}))

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

function localeContext(locale: ContentLanguageCode): LanguagePreferencesContextValue {
  return {
    preferences: { ...DEFAULT_LANGUAGE_PREFERENCES, appLocale: locale },
    setPreference: () => undefined,
    t: (key: DesktopI18nKey, vars?: DesktopI18nVars) => translateDesktop(locale, key, vars),
  }
}

function withLocale(locale: ContentLanguageCode, node: ReactNode): ReactNode {
  return createElement(
    LanguagePreferencesContext.Provider,
    { value: localeContext(locale) },
    node,
  )
}

function renderContent(locale: ContentLanguageCode, state: BillingState): string {
  return renderToStaticMarkup(
    withLocale(locale, createElement(BillingPlanContent, { state })),
  )
}

/**
 * The billing modal is rendered through the same module graph as the app shell,
 * so a module-scope or render-scope failure here blanks the whole desktop app
 * (the exact QA18 white-screen class). These renders cover every billing state
 * in both shipped locales so a `translateDesktop`/comparison-model regression
 * fails here instead of only in the packaged WebView.
 */
const STATES: BillingState[] = [
  { status: 'signed_out' },
  { status: 'loading' },
  { status: 'unavailable', reason: 'Billing information is temporarily unavailable', retryable: true },
  { status: 'free', quota: studentQuota },
  {
    status: 'active',
    planCode: 'student_basic_annual',
    interval: 'annual',
    currentPeriodEnd: '2026-12-31T00:00:00Z',
    manageable: true,
    quota: studentQuota,
  },
  {
    status: 'canceling',
    planCode: 'student_basic_monthly',
    interval: 'monthly',
    accessThrough: '2026-12-31T00:00:00Z',
    manageable: true,
    quota: studentQuota,
  },
  {
    status: 'past_due',
    planCode: 'student_basic_monthly',
    interval: 'monthly',
    currentPeriodEnd: '2026-12-31T00:00:00Z',
    graceUntil: '2026-12-10T00:00:00Z',
    accessActive: true,
    manageable: true,
    quota: studentQuota,
  },
  {
    status: 'expired',
    planCode: 'student_basic_monthly',
    interval: 'monthly',
    currentPeriodEnd: '2026-11-30T00:00:00Z',
    manageable: false,
    quota: studentQuota,
  },
]

describe('QA18 regression — billing modal renders in every state and locale', () => {
  it('renders all billing states in English and Simplified Chinese without throwing', () => {
    for (const locale of ['en', 'zh-Hans'] as const) {
      for (const state of STATES) {
        const html = renderContent(locale, state)
        expect(typeof html).toBe('string')
        expect(html.length).toBeGreaterThan(0)
        // Every rendered panel must carry its state marker (proves a real commit).
        expect(html).toContain(`data-billing-status="${state.status}"`)
      }
    }
  })

  it('renders the full free-state modal in Simplified Chinese with the shared comparison model', () => {
    const html = renderToStaticMarkup(
      withLocale(
        'zh-Hans',
        createElement(BillingPlanModal, {
          open: true,
          onClose: vi.fn(),
          billing: mockBilling({ status: 'free', quota: studentQuota }),
        }),
      ),
    )
    // The Student Basic comparison is derived from the shared product-plan model,
    // not module-level English copy; the free→paid figures must survive i18n.
    expect(html).toContain('data-billing-status="free"')
    expect(html).toContain('300')
    expect(html).toContain('600')
    expect(html).toContain('升级至 Student Basic')
  })

  it('renders the unavailable state (missing Stripe/staging config) without blanking', () => {
    // A staging backend without checkout/Stripe wiring must surface the panel,
    // never throw and unmount the tree.
    const html = renderContent('en', {
      status: 'unavailable',
      reason: 'Billing information is temporarily unavailable',
      retryable: true,
    })
    expect(html).toContain('Billing information is temporarily unavailable')
  })
})
