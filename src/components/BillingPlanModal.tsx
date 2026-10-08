/**
 * Desktop Billing / Plan modal (Commercialization V2 · Phase 2B-2 / 2B-3 / 2B-4).
 *
 * Displays authoritative billing + quota from useBilling.
 * Checkout via actions.upgrade(planCode); Portal via actions.manage().
 * No client-side entitlement activation; no return/focus/deep-link inference.
 */
import { useEffect, useId, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useAuth } from '../useAuth'
import { useLanguagePreferences } from '../languagePreferencesContext'
import { translateDesktop, type DesktopI18nKey, type DesktopI18nVars } from '../lib/desktopI18n'
import { useBilling, type BillingHookError, type UseBillingResult } from '../hooks/useBilling'
import {
  useBillingReturnRefresh,
  type BillingReturnRefreshFeedback,
} from '../hooks/useBillingReturnRefresh'
import type { BillingPlanCode } from '../lib/billing/billingClient'
import type {
  BillingState,
  EntitlementSummary,
  NormalizedBillingInterval,
  NormalizedQuota,
} from '../lib/billing/billingState'
import { markExternalBillingAction } from '../lib/billing/billingReturnCoordinator'
import { quotaTone, quotaUsedPercent } from '../lib/billing/quotaTone'
import { STUDENT_BASIC_COMPARISON } from '../lib/billing/planPresentation'
import {
  STUDENT_BASIC_ANNUAL_SAVINGS_USD,
  STUDENT_BASIC_ANNUAL_USD,
  STUDENT_BASIC_MONTHLY_USD,
  canOpenPortal,
  canStartCheckout,
  formatCheckoutError,
  formatPortalError,
  intervalFromPlanCode,
  planCodeFromInterval,
  portalActionLabel,
} from './billingCheckoutCopy'
import {
  handleBillingModalEscape,
  handleBillingModalOverlayMouseDown,
} from './billingPlanModalChrome'
import './BillingPlanModal.css'

export type BillingPlanModalProps = {
  open: boolean
  onClose: () => void
  /** Optional inject for tests — production uses useBilling(). */
  billing?: UseBillingResult
}

const DEFAULT_PLAN: BillingPlanCode = 'student_basic_monthly'
const defaultT = (key: DesktopI18nKey, vars?: DesktopI18nVars) => translateDesktop('en', key, vars)

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(
    new Date(ms),
  )
}

function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function planLabel(planCode: string | null | undefined): string {
  if (planCode === 'student_basic_monthly' || planCode === 'student_basic_annual') return 'Student Basic'
  return 'Student Basic'
}

function intervalLabel(
  interval: NormalizedBillingInterval | null | undefined,
  t: ReturnType<typeof useLanguagePreferences>['t'],
): string | null {
  if (interval === 'monthly') return t('billing.monthly')
  if (interval === 'annual') return t('billing.annual')
  return null
}

/** Restrained progress bar — color communicates how close the user is to the limit. */
function UsageBar({ used, limit }: { used: number | null; limit: number | null }) {
  const percent = quotaUsedPercent(used, limit)
  if (percent == null) return null
  const tone = quotaTone(used, limit)
  return (
    <div
      className={`billing-plan-modal__usage-bar billing-plan-modal__usage-bar--${tone}`}
      role="progressbar"
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="billing-plan-modal__usage-bar-fill" style={{ width: `${percent}%` }} />
    </div>
  )
}

function UsageMetricRow({
  label,
  used,
  limit,
  summary,
  remainingText,
}: {
  label: string
  used: number | null
  limit: number | null
  /** e.g. "240 / 300 min" or "300 min / month" (limit-only fallback). */
  summary: string
  remainingText: string | null
}) {
  return (
    <div className="billing-plan-modal__usage-metric">
      <div className="billing-plan-modal__usage-label">{label}</div>
      <div className="billing-plan-modal__usage-summary">{summary}</div>
      {remainingText ? <div className="billing-plan-modal__usage-remaining">{remainingText}</div> : null}
      <UsageBar used={used} limit={limit} />
    </div>
  )
}

/**
 * The three real usage metrics the existing quota state carries. Values are
 * read verbatim from `NormalizedQuota` — never derived from the Student Basic
 * presentation data, and never fabricated when
 * the backend hasn't returned a number yet (Study Tasks usage/remaining are
 * `null` today; only its daily limit is known, so it renders limit-only with
 * no progress bar rather than implying 0 used).
 */
function QuotaUsageRows({ quota }: { quota: NormalizedQuota }) {
  const { t } = useLanguagePreferences()

  const minutesLimit = quota.monthlyMinutesLimit
  const minutesSummary =
    minutesLimit == null
      ? t('settings.usageLimitUnavailable')
      : quota.minutesUsed == null
        ? t('settings.usageMinPerMonth', { count: formatCount(minutesLimit) })
        : t('settings.usageUsedOfMin', { used: formatCount(quota.minutesUsed), limit: formatCount(minutesLimit) })
  const minutesRemaining =
    quota.minutesRemaining != null ? t('settings.usageMinRemaining', { count: formatCount(quota.minutesRemaining) }) : null

  const recordingsLimit = quota.maxRecordingsPerDay
  const recordingsSummary =
    recordingsLimit == null
      ? t('settings.usageLimitUnavailable')
      : quota.recordingsUsedToday == null
        ? t('settings.usagePerDay', { count: formatCount(recordingsLimit) })
        : t('settings.usageUsedOfToday', { used: formatCount(quota.recordingsUsedToday), limit: formatCount(recordingsLimit) })
  const recordingsRemaining =
    quota.recordingsRemainingToday != null
      ? t('settings.usageRemaining', { count: formatCount(quota.recordingsRemainingToday) })
      : null

  const tasksLimit = quota.maxStudyTasksPerDay
  const tasksSummary =
    tasksLimit == null
      ? t('settings.usageLimitUnavailable')
      : quota.studyTasksUsedToday == null
        ? t('settings.usagePerDay', { count: formatCount(tasksLimit) })
        : t('settings.usageUsedOfToday', { used: formatCount(quota.studyTasksUsedToday), limit: formatCount(tasksLimit) })
  const tasksRemaining =
    quota.studyTasksRemainingToday != null
      ? t('settings.usageRemaining', { count: formatCount(quota.studyTasksRemainingToday) })
      : null

  return (
    <div className="billing-plan-modal__usage" aria-label={t('settings.usageTitle')}>
      <h3 className="billing-plan-modal__section-title">{t('settings.usageTitle')}</h3>
      <UsageMetricRow
        label={t('settings.usageStudyMinutes')}
        used={quota.minutesUsed}
        limit={minutesLimit}
        summary={minutesSummary}
        remainingText={minutesRemaining}
      />
      <UsageMetricRow
        label={t('settings.usageRecordings')}
        used={quota.recordingsUsedToday}
        limit={recordingsLimit}
        summary={recordingsSummary}
        remainingText={recordingsRemaining}
      />
      <UsageMetricRow
        label={t('settings.usageStudyTasks')}
        used={quota.studyTasksUsedToday}
        limit={tasksLimit}
        summary={tasksSummary}
        remainingText={tasksRemaining}
      />
    </div>
  )
}

/**
 * Active Student Basic with nothing to manage here (no Stripe customer to open a Portal for): say who
 * manages it. Provider-neutral wording; a date appears only when the backend exposes one, and it is an
 * "access through" date, never an invented renewal date.
 */
function EntitlementManagedNote({
  entitlement,
  t,
}: {
  entitlement: EntitlementSummary | undefined
  t: ReturnType<typeof useLanguagePreferences>['t']
}) {
  // Defensive: a state built without the summary reads as "active, provider unknown".
  const provider = entitlement?.provider ?? 'other'
  const key =
    provider === 'apple'
      ? 'billing.managedApple'
      : provider === 'granted'
        ? 'billing.managedGranted'
        : 'billing.managedOther'
  const through = formatDate(entitlement?.expiresAt)
  return (
    <div className="billing-plan-modal__managed" data-entitlement-provider={provider}>
      <p className="billing-plan-modal__copy">{t(key)}</p>
      {through ? <p className="billing-plan-modal__copy">{t('billing.accessThrough', { date: through })}</p> : null}
    </div>
  )
}

function StatusPill({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'ok' | 'warn' | 'danger' }) {
  return (
    <span className={`billing-plan-modal__pill billing-plan-modal__pill--${tone}`}>
      <span className="billing-plan-modal__pill-text">{label}</span>
    </span>
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="billing-plan-modal__meta-row">
      <span className="billing-plan-modal__meta-label">{label}</span>
      <span className="billing-plan-modal__meta-value">{value}</span>
    </div>
  )
}

function RefreshPlanButton({
  onRefreshPlan,
  disabled,
}: {
  onRefreshPlan?: () => void
  disabled?: boolean
}) {
  const { t } = useLanguagePreferences()
  if (!onRefreshPlan) return null
  return (
    <button
      type="button"
      className="billing-plan-modal__btn billing-plan-modal__btn--secondary"
      onClick={onRefreshPlan}
      disabled={disabled}
    >
      {t('billing.refreshPlan')}
    </button>
  )
}

function ReturnRefreshFeedback({ feedback }: { feedback: BillingReturnRefreshFeedback }) {
  const { t } = useLanguagePreferences()
  if (feedback.status === 'idle') return null
  if (feedback.status === 'refreshing') {
    return (
      <p className="billing-plan-modal__copy" role="status" aria-live="polite">
        {t('billing.refreshing')}
      </p>
    )
  }
  if (feedback.status === 'updated') {
    return (
      <p className="billing-plan-modal__copy" role="status">
        {t('billing.updated')}
      </p>
    )
  }
  if (feedback.status === 'unchanged') {
    return (
      <p className="billing-plan-modal__copy" role="status">
        {t('billing.upToDate')}
      </p>
    )
  }
  return (
    <p className="billing-plan-modal__action-error" role="alert">
      {feedback.message}
    </p>
  )
}

export type PlanCheckoutPanelProps = {
  selectedPlan: BillingPlanCode
  onSelectedPlanChange: (plan: BillingPlanCode) => void
  onUpgrade: () => void
  checkoutBusy: boolean
  checkoutOpened: boolean
  upgradeLabel: string
  disabled?: boolean
  t?: typeof defaultT
}

/** Monthly/annual selector + Upgrade — free and expired purchase paths. */
export function PlanCheckoutPanel({
  selectedPlan,
  onSelectedPlanChange,
  onUpgrade,
  checkoutBusy,
  checkoutOpened,
  upgradeLabel,
  disabled = false,
  t = defaultT,
}: PlanCheckoutPanelProps) {
  const selectedInterval = intervalFromPlanCode(selectedPlan)
  const controlsDisabled = disabled || checkoutBusy

  return (
    <div className="billing-plan-modal__preview">
      <h3 className="billing-plan-modal__section-title">Student Basic</h3>
      <p className="billing-plan-modal__upgrade-lead">{t('billing.moreCapacity')}</p>
      <div className="billing-plan-modal__interval-toggle" role="group" aria-label={t('billing.chooseInterval')}>
        <button
          type="button"
          className={
            selectedInterval === 'monthly'
              ? 'billing-plan-modal__interval-btn billing-plan-modal__interval-btn--selected'
              : 'billing-plan-modal__interval-btn'
          }
          aria-pressed={selectedInterval === 'monthly'}
          disabled={controlsDisabled}
          onClick={() => onSelectedPlanChange(planCodeFromInterval('monthly'))}
        >
          <span className="billing-plan-modal__interval-name">{t('billing.monthly')}</span>
          <span className="billing-plan-modal__interval-price">
            ${STUDENT_BASIC_MONTHLY_USD.toFixed(2)} / {t('billing.month')}
          </span>
        </button>
        <button
          type="button"
          className={
            selectedInterval === 'annual'
              ? 'billing-plan-modal__interval-btn billing-plan-modal__interval-btn--selected'
              : 'billing-plan-modal__interval-btn'
          }
          aria-pressed={selectedInterval === 'annual'}
          disabled={controlsDisabled}
          onClick={() => onSelectedPlanChange(planCodeFromInterval('annual'))}
        >
          <span className="billing-plan-modal__interval-head">
            <span className="billing-plan-modal__interval-name">{t('billing.annual')}</span>
            {/* Always visible, not only when annual is selected: the value
                advantage is the reason to look at annual in the first place. */}
            <span className="billing-plan-modal__interval-badge">{t('billing.bestValue')}</span>
          </span>
          <span className="billing-plan-modal__interval-price">
            ${STUDENT_BASIC_ANNUAL_USD.toFixed(2)} / {t('billing.year')}
          </span>
          <span className="billing-plan-modal__interval-save">
            {t('billing.saveAmount', { amount: `$${STUDENT_BASIC_ANNUAL_SAVINGS_USD.toFixed(2)}` })}
          </span>
        </button>
      </div>
      <div className="billing-plan-modal__comparison" aria-label={t('billing.comparisonLabel')}>
        {STUDENT_BASIC_COMPARISON.map((item) => (
          <div className="billing-plan-modal__comparison-row" key={item.metric}>
            <span>{t(`billing.${item.metric}` as 'billing.minutes' | 'billing.recordings' | 'billing.tasks')}</span>
            <span className="billing-plan-modal__comparison-values">
              <span className="billing-plan-modal__comparison-from">{item.free}</span>
              <span className="billing-plan-modal__comparison-arrow" aria-hidden="true"> → </span>
              <strong className="billing-plan-modal__comparison-to">{item.studentBasic}</strong>
              <small> / {t(item.cadence === 'month' ? 'billing.month' : 'billing.day')}</small>
            </span>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="billing-plan-modal__btn billing-plan-modal__btn--primary billing-plan-modal__upgrade"
        aria-label={checkoutBusy ? t('billing.openingCheckout') : upgradeLabel}
        aria-busy={checkoutBusy || undefined}
        disabled={controlsDisabled}
        onClick={onUpgrade}
      >
        {checkoutBusy ? t('billing.openingCheckout') : upgradeLabel}
      </button>
      {checkoutOpened ? (
        <div className="billing-plan-modal__checkout-note" role="status">
          <p className="billing-plan-modal__copy">
            {t('billing.checkoutOpened')}
          </p>
        </div>
      ) : null}
    </div>
  )
}

export type ManagePortalPanelProps = {
  label: string
  onManage: () => void
  portalBusy: boolean
  portalOpened: boolean
  disabled?: boolean
  t?: typeof defaultT
}

export function ManagePortalPanel({
  label,
  onManage,
  portalBusy,
  portalOpened,
  disabled = false,
  t = defaultT,
}: ManagePortalPanelProps) {
  const controlsDisabled = disabled || portalBusy
  return (
    <div className="billing-plan-modal__manage">
      <button
        type="button"
        className="billing-plan-modal__btn billing-plan-modal__btn--secondary billing-plan-modal__manage-btn"
        aria-label={portalBusy ? t('billing.openingManagement') : label}
        aria-busy={portalBusy || undefined}
        disabled={controlsDisabled}
        onClick={onManage}
      >
        {portalBusy ? t('billing.openingManagement') : label}
      </button>
      {portalOpened ? (
        <div className="billing-plan-modal__checkout-note" role="status">
          <p className="billing-plan-modal__copy">
            {t('billing.managementOpened')}
          </p>
        </div>
      ) : null}
    </div>
  )
}

export type BillingPlanContentProps = {
  state: BillingState
  onRetry?: () => void
  selectedPlan?: BillingPlanCode
  onSelectedPlanChange?: (plan: BillingPlanCode) => void
  onUpgrade?: () => void
  onManage?: () => void
  onRefreshPlan?: () => void
  checkoutBusy?: boolean
  checkoutOpened?: boolean
  portalBusy?: boolean
  portalOpened?: boolean
  actionError?: BillingHookError | null
  actionErrorKind?: 'checkout' | 'portal' | null
  returnFeedback?: BillingReturnRefreshFeedback
}

/** Presentational body — used by the modal and unit tests. */
export function BillingPlanContent({
  state,
  onRetry,
  selectedPlan = DEFAULT_PLAN,
  onSelectedPlanChange,
  onUpgrade,
  onManage,
  onRefreshPlan,
  checkoutBusy = false,
  checkoutOpened = false,
  portalBusy = false,
  portalOpened = false,
  actionError = null,
  actionErrorKind = null,
  returnFeedback = { status: 'idle' },
}: BillingPlanContentProps) {
  const { t } = useLanguagePreferences()
  const checkoutError =
    actionErrorKind === 'checkout' ? formatCheckoutError(actionError) : null
  const portalError = actionErrorKind === 'portal' ? formatPortalError(actionError) : null
  const actionBusy = checkoutBusy || portalBusy || returnFeedback.status === 'refreshing'
  const showRefresh = Boolean(onRefreshPlan && (checkoutOpened || portalOpened || returnFeedback.status !== 'idle'))
  const showPortal = canOpenPortal(state) && Boolean(onManage)

  if (state.status === 'signed_out') {
    return (
      <div className="billing-plan-modal__panel" data-billing-status="signed_out">
        <h3 className="billing-plan-modal__headline">{t('billing.signInTitle')}</h3>
        <p className="billing-plan-modal__copy">
          {t('billing.signInBody')}
        </p>
      </div>
    )
  }

  if (state.status === 'loading') {
    return (
      <div className="billing-plan-modal__panel" data-billing-status="loading" aria-busy="true">
        <p className="billing-plan-modal__copy">{t('billing.loading')}</p>
        <div className="billing-plan-modal__skeleton" aria-hidden>
          <div className="billing-plan-modal__skeleton-line" />
          <div className="billing-plan-modal__skeleton-line billing-plan-modal__skeleton-line--short" />
          <div className="billing-plan-modal__skeleton-line" />
        </div>
      </div>
    )
  }

  if (state.status === 'unavailable') {
    return (
      <div className="billing-plan-modal__panel" data-billing-status="unavailable">
        <h3 className="billing-plan-modal__headline">{t('billing.unavailableTitle')}</h3>
        <p className="billing-plan-modal__copy">{state.reason}</p>
        {onRetry ? (
          <button
            type="button"
            className="billing-plan-modal__btn billing-plan-modal__btn--secondary"
            onClick={onRetry}
          >
            {t('billing.retry')}
          </button>
        ) : null}
      </div>
    )
  }

  if (state.status === 'free') {
    return (
      <div className="billing-plan-modal__panel" data-billing-status="free">
        <div className="billing-plan-modal__header-row">
          <div>
            <p className="billing-plan-modal__eyebrow">{t('billing.currentPlan')}</p>
            <h3 className="billing-plan-modal__headline">Free</h3>
          </div>
          {/* Free access is a healthy, available state — not a neutral one. */}
          <StatusPill label={t('billing.freeAccess')} tone="ok" />
        </div>

        <QuotaUsageRows quota={state.quota} />

        <PlanCheckoutPanel
          selectedPlan={selectedPlan}
          onSelectedPlanChange={(plan) => onSelectedPlanChange?.(plan)}
          onUpgrade={() => onUpgrade?.()}
          checkoutBusy={checkoutBusy}
          checkoutOpened={checkoutOpened}
          upgradeLabel={t('billing.upgradeStudentBasic')}
          disabled={portalBusy}
          t={t}
        />
        {checkoutError ? (
          <p className="billing-plan-modal__action-error" role="alert">
            {checkoutError}
          </p>
        ) : null}
        <ReturnRefreshFeedback feedback={returnFeedback} />
        <RefreshPlanButton onRefreshPlan={showRefresh ? onRefreshPlan : undefined} disabled={actionBusy} />
      </div>
    )
  }

  if (state.status === 'active') {
    const billing = intervalLabel(state.interval, t)
    const renews = formatDate(state.currentPeriodEnd)
    return (
      <div
        className="billing-plan-modal__panel"
        data-billing-status="active"
        data-billing-interval={state.interval ?? 'unknown'}
      >
        <div className="billing-plan-modal__header-row">
          <div>
            <p className="billing-plan-modal__eyebrow">{t('billing.currentPlan')}</p>
            <h3 className="billing-plan-modal__headline">{planLabel(state.planCode)}</h3>
          </div>
          <StatusPill label={t('settings.statusActive')} tone="ok" />
        </div>
        <div className="billing-plan-modal__meta">
          {billing ? <MetaRow label={t('billing.billing')} value={billing} /> : null}
          {renews ? <MetaRow label={t('billing.renews')} value={renews} /> : null}
        </div>
        <QuotaUsageRows quota={state.quota} />
        {!showPortal ? <EntitlementManagedNote entitlement={state.entitlement} t={t} /> : null}
        {showPortal ? (
          <ManagePortalPanel
            label={portalActionLabel('active')}
            onManage={() => onManage?.()}
            portalBusy={portalBusy}
            portalOpened={portalOpened}
            disabled={checkoutBusy}
            t={t}
          />
        ) : null}
        {portalError ? (
          <p className="billing-plan-modal__action-error" role="alert">
            {portalError}
          </p>
        ) : null}
        <ReturnRefreshFeedback feedback={returnFeedback} />
        <RefreshPlanButton onRefreshPlan={showRefresh ? onRefreshPlan : undefined} disabled={actionBusy} />
      </div>
    )
  }

  if (state.status === 'trialing' || state.status === 'trial_canceling') {
    // The date is the backend's `trialEnd` verbatim — never computed here. Price comes from the plan cadence the
    // app already maps (monthly / annual), never from arbitrary subscription data.
    const ends = formatDate(state.trialEnd)
    const canceling = state.status === 'trial_canceling'
    const cadence = state.interval
    const trialCopy = canceling
      ? ends
        ? t('billing.trialCanceled', { date: ends })
        : t('billing.trialCanceledNoDate')
      : ends && cadence
        ? t('billing.trialThen', {
            date: ends,
            price: `$${(cadence === 'monthly' ? STUDENT_BASIC_MONTHLY_USD : STUDENT_BASIC_ANNUAL_USD).toFixed(2)}`,
            unit: cadence === 'monthly' ? t('billing.month') : t('billing.year'),
          })
        : ends
          ? t('billing.trialEndsOnly', { date: ends })
          : t('billing.trialNoDate')
    return (
      <div
        className="billing-plan-modal__panel"
        data-billing-status={state.status}
        data-billing-interval={state.interval ?? 'unknown'}
      >
        <div className="billing-plan-modal__header-row">
          <div>
            <p className="billing-plan-modal__eyebrow">{t('billing.currentPlan')}</p>
            <h3 className="billing-plan-modal__headline">{planLabel(state.planCode)}</h3>
          </div>
          <StatusPill
            label={canceling ? t('billing.cancellationScheduled') : t('billing.trialStatus')}
            tone={canceling ? 'warn' : 'ok'}
          />
        </div>
        <p className="billing-plan-modal__copy" data-trial-copy>
          {trialCopy}
        </p>
        <QuotaUsageRows quota={state.quota} />
        {showPortal ? (
          <ManagePortalPanel
            label={portalActionLabel(state.status)}
            onManage={() => onManage?.()}
            portalBusy={portalBusy}
            portalOpened={portalOpened}
            disabled={checkoutBusy}
            t={t}
          />
        ) : null}
        {portalError ? (
          <p className="billing-plan-modal__action-error" role="alert">
            {portalError}
          </p>
        ) : null}
        <ReturnRefreshFeedback feedback={returnFeedback} />
        <RefreshPlanButton onRefreshPlan={showRefresh ? onRefreshPlan : undefined} disabled={actionBusy} />
      </div>
    )
  }

  if (state.status === 'canceling') {
    const through = formatDate(state.accessThrough)
    return (
      <div className="billing-plan-modal__panel" data-billing-status="canceling">
        <div className="billing-plan-modal__header-row">
          <div>
            <p className="billing-plan-modal__eyebrow">{t('billing.currentPlan')}</p>
            <h3 className="billing-plan-modal__headline">{planLabel(state.planCode)}</h3>
          </div>
          <StatusPill label={t('billing.cancellationScheduled')} tone="warn" />
        </div>
        <p className="billing-plan-modal__copy">
          {through
            ? t('billing.accessThrough', { date: through })
            : t('billing.accessThroughPeriod')}
        </p>
        <QuotaUsageRows quota={state.quota} />
        {showPortal ? (
          <ManagePortalPanel
            label={portalActionLabel('canceling')}
            onManage={() => onManage?.()}
            portalBusy={portalBusy}
            portalOpened={portalOpened}
            disabled={checkoutBusy}
            t={t}
          />
        ) : null}
        {portalError ? (
          <p className="billing-plan-modal__action-error" role="alert">
            {portalError}
          </p>
        ) : null}
        <ReturnRefreshFeedback feedback={returnFeedback} />
        <RefreshPlanButton onRefreshPlan={showRefresh ? onRefreshPlan : undefined} disabled={actionBusy} />
      </div>
    )
  }

  if (state.status === 'past_due') {
    const grace = formatDate(state.graceUntil)
    // Access is claimed only when the backend says so (quota entitlement active AND, when reported, inGrace) and
    // there is a date to state; after the grace window only the payment problem is shown.
    const graceAccess = state.accessActive && state.inGrace !== false && Boolean(grace)
    return (
      <div className="billing-plan-modal__panel" data-billing-status="past_due" data-billing-grace={graceAccess ? 'active' : 'ended'}>
        <div className="billing-plan-modal__header-row">
          <div>
            <p className="billing-plan-modal__eyebrow">{t('billing.currentPlan')}</p>
            <h3 className="billing-plan-modal__headline">{planLabel(state.planCode)}</h3>
          </div>
          <StatusPill label={t('settings.statusPastDue')} tone="danger" />
        </div>
        <p className="billing-plan-modal__copy">
          {graceAccess ? t('billing.paymentFailedGrace', { date: grace ?? '' }) : t('billing.paymentFailed')}
        </p>
        <div className="billing-plan-modal__meta">
          <MetaRow label={t('billing.access')} value={graceAccess ? t('settings.statusActive') : t('billing.limited')} />
          {graceAccess && grace ? <MetaRow label={t('billing.graceUntil')} value={grace} /> : null}
        </div>
        <QuotaUsageRows quota={state.quota} />
        {showPortal ? (
          <ManagePortalPanel
            label={portalActionLabel('past_due')}
            onManage={() => onManage?.()}
            portalBusy={portalBusy}
            portalOpened={portalOpened}
            disabled={checkoutBusy}
            t={t}
          />
        ) : null}
        {portalError ? (
          <p className="billing-plan-modal__action-error" role="alert">
            {portalError}
          </p>
        ) : null}
        <ReturnRefreshFeedback feedback={returnFeedback} />
        <RefreshPlanButton onRefreshPlan={showRefresh ? onRefreshPlan : undefined} disabled={actionBusy} />
      </div>
    )
  }

  // expired — Checkout for a new plan; Portal only when manageable.
  return (
    <div className="billing-plan-modal__panel" data-billing-status="expired">
      <div className="billing-plan-modal__header-row">
        <div>
          <p className="billing-plan-modal__eyebrow">{t('billing.subscription')}</p>
          <h3 className="billing-plan-modal__headline">{t('billing.inactive')}</h3>
        </div>
        <StatusPill label={t('billing.ended')} tone="neutral" />
      </div>
      <p className="billing-plan-modal__copy">
        {state.planCode
          ? `Your ${planLabel(state.planCode)} subscription is no longer active.`
          : `${t('billing.subscription')} ${t('billing.inactive')}.`}{' '}
        {t('billing.expiredBody')}
      </p>
      <QuotaUsageRows quota={state.quota} />
      {showPortal ? (
        <ManagePortalPanel
          label={portalActionLabel('expired')}
          onManage={() => onManage?.()}
          portalBusy={portalBusy}
          portalOpened={portalOpened}
          disabled={checkoutBusy}
          t={t}
        />
      ) : null}
      {portalError ? (
        <p className="billing-plan-modal__action-error" role="alert">
          {portalError}
        </p>
      ) : null}
      <PlanCheckoutPanel
        selectedPlan={selectedPlan}
        onSelectedPlanChange={(plan) => onSelectedPlanChange?.(plan)}
        onUpgrade={() => onUpgrade?.()}
        checkoutBusy={checkoutBusy}
        checkoutOpened={checkoutOpened}
        upgradeLabel={t('billing.chooseNewPlan')}
        disabled={portalBusy}
        t={t}
      />
      {checkoutError ? (
        <p className="billing-plan-modal__action-error" role="alert">
          {checkoutError}
        </p>
      ) : null}
      <ReturnRefreshFeedback feedback={returnFeedback} />
      <RefreshPlanButton onRefreshPlan={showRefresh ? onRefreshPlan : undefined} disabled={actionBusy} />
    </div>
  )
}

function BillingPlanModalFrame({
  open,
  onClose,
  billing,
  returnFeedback,
}: {
  open: boolean
  onClose: () => void
  billing: UseBillingResult
  returnFeedback: BillingReturnRefreshFeedback
}) {
  const { t } = useLanguagePreferences()
  const titleId = useId()
  const [selectedPlan, setSelectedPlan] = useState<BillingPlanCode>(DEFAULT_PLAN)
  const [checkoutBusy, setCheckoutBusy] = useState(false)
  const [checkoutOpened, setCheckoutOpened] = useState(false)
  const [portalBusy, setPortalBusy] = useState(false)
  const [portalOpened, setPortalOpened] = useState(false)
  const [actionErrorKind, setActionErrorKind] = useState<'checkout' | 'portal' | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => handleBillingModalEscape(e, onClose)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const prevBodyOverflow = document.body.style.overflow
    const prevHtmlOverflow = document.documentElement.style.overflow
    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prevBodyOverflow
      document.documentElement.style.overflow = prevHtmlOverflow
    }
  }, [open])

  const loadBilling = billing.actions.load
  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- each modal opening starts a fresh billing-action session.
    setCheckoutOpened(false)
    setCheckoutBusy(false)
    setPortalOpened(false)
    setPortalBusy(false)
    setActionErrorKind(null)
    void loadBilling()
  }, [open, loadBilling])

  if (!open) return null

  const allowCheckout = canStartCheckout(billing.state.status)
  const allowPortal = canOpenPortal(billing.state)
  const busy =
    billing.state.status === 'loading' ||
    billing.loading ||
    checkoutBusy ||
    portalBusy ||
    returnFeedback.status === 'refreshing'

  const handleUpgrade = () => {
    if (!allowCheckout || checkoutBusy || portalBusy) return
    setCheckoutBusy(true)
    setCheckoutOpened(false)
    setPortalOpened(false)
    setActionErrorKind(null)
    void (async () => {
      try {
        await billing.actions.upgrade(selectedPlan)
        setCheckoutOpened(true)
        setActionErrorKind(null)
        markExternalBillingAction('checkout')
      } catch {
        setCheckoutOpened(false)
        setActionErrorKind('checkout')
      } finally {
        setCheckoutBusy(false)
      }
    })()
  }

  const handleManage = () => {
    if (!allowPortal || portalBusy || checkoutBusy) return
    setPortalBusy(true)
    setPortalOpened(false)
    setCheckoutOpened(false)
    setActionErrorKind(null)
    void (async () => {
      try {
        await billing.actions.manage()
        setPortalOpened(true)
        setActionErrorKind(null)
        markExternalBillingAction('portal')
      } catch {
        setPortalOpened(false)
        setActionErrorKind('portal')
      } finally {
        setPortalBusy(false)
      }
    })()
  }

  return (
    <div
      className="desktop-v2 billing-plan-modal__overlay"
      role="presentation"
      data-testid="billing-plan-overlay"
      onMouseDown={(e: ReactMouseEvent<HTMLDivElement>) => handleBillingModalOverlayMouseDown(e, onClose)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
        className="billing-plan-modal__dialog"
        data-testid="billing-plan-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="billing-plan-modal__titlebar">
          <h2 id={titleId} className="billing-plan-modal__title">
            {t('billing.title')}
          </h2>
          <button type="button" className="billing-plan-modal__close" aria-label={t('billing.close')} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="billing-plan-modal__body">
          <BillingPlanContent
            state={billing.state}
            onRetry={
              billing.state.status === 'unavailable'
                ? () => {
                    void billing.actions.load()
                  }
                : undefined
            }
            selectedPlan={selectedPlan}
            onSelectedPlanChange={setSelectedPlan}
            onUpgrade={allowCheckout ? handleUpgrade : undefined}
            onManage={allowPortal ? handleManage : undefined}
            onRefreshPlan={() => {
              void billing.actions.refresh()
            }}
            checkoutBusy={checkoutBusy}
            checkoutOpened={checkoutOpened}
            portalBusy={portalBusy}
            portalOpened={portalOpened}
            actionError={billing.error}
            actionErrorKind={actionErrorKind}
            returnFeedback={returnFeedback}
          />
        </div>
      </div>
    </div>
  )
}

function BillingPlanModalConnected({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { session } = useAuth()
  const billing = useBilling()
  const signedIn = Boolean(session)
  const { feedback } = useBillingReturnRefresh({
    signedIn,
    refresh: billing.actions.refresh,
    getStatus: billing.getStatus,
  })
  return (
    <BillingPlanModalFrame open={open} onClose={onClose} billing={billing} returnFeedback={feedback} />
  )
}

export function BillingPlanModal({ open, onClose, billing }: BillingPlanModalProps) {
  if (billing) {
    return (
      <BillingPlanModalFrame
        open={open}
        onClose={onClose}
        billing={billing}
        returnFeedback={{ status: 'idle' }}
      />
    )
  }
  return <BillingPlanModalConnected open={open} onClose={onClose} />
}
