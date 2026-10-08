/**
 * Desktop billing API client (Commercialization V2 · Phase 2B-1).
 *
 * Thin authenticated wrappers around the existing Stripe billing routes.
 * Never accepts Stripe price IDs, customer IDs, or entitlement overrides —
 * the backend derives all trusted values from the Supabase session.
 */
import { getAiApiBase } from '../ai/apiBase'
import { getSupabase } from '../supabase'

export const BILLING_PLAN_CODES = ['student_basic_monthly', 'student_basic_annual'] as const
export type BillingPlanCode = (typeof BILLING_PLAN_CODES)[number]

/** Backend billingInterval is `month` | `year`; UI normalizes separately. */
export type BillingInterval = 'monthly' | 'annual'

export type SubscriptionRecord = {
  provider: 'stripe' | null
  active: boolean
  planCode: string | null
  billingInterval: string | null
  status: string
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  graceUntil: string | null
  manageable: boolean
  /** Additive backend fields (absent from older responses; never defaulted in here). */
  trialing?: boolean
  /** Authoritative end of a Stripe free trial, exactly as the backend reports it. */
  trialEnd?: string | null
  /** past_due AND still inside the paid-for / grace window (backend decides). */
  inGrace?: boolean
}

export type SubscriptionStatusPayload = {
  ok: true
  subscription: SubscriptionRecord
}

export type SubscriptionRefreshPayload = {
  ok: true
  refreshed: boolean
  subscription: SubscriptionRecord
}

export type CheckoutPayload = {
  ok: true
  url: string
}

export type PortalPayload = {
  ok: true
  url: string
}

/**
 * Real `/api/quota/status` `plan` fields needed by later billing UI.
 * Study Tasks map to backend `maxProcessingJobsPerDay` when present;
 * usage/remaining are omitted by the backend today → stay null.
 */
export type QuotaStatusPayload = {
  planType?: string
  /** Provider-neutral effective plan; this is the membership authority for Desktop. */
  effectivePlanType?: string
  displayName?: string
  status?: string
  /** True only while the backend's current entitlement is active. */
  studentPassActive?: boolean
  entitlement?: {
    active?: boolean
    status?: string
    productId?: string | null
    planType?: string | null
    startsAt?: string | null
    expiresAt?: string | null
    revoked?: boolean
    /** Where the grant came from (e.g. 'app_store_subscription'); absent on legacy rows. */
    source?: string | null
  }
  unlimited?: boolean
  monthlyMinutesLimit?: number | null
  minutesUsed?: number | null
  minutesRemaining?: number | null
  minutesLimit?: number | null
  maxRecordingsPerDay?: number | null
  recordingsUsedToday?: number | null
  recordingsRemainingToday?: number | null
  maxProcessingJobsPerDay?: number | null
  [key: string]: unknown
}

export type QuotaStatusResponse = {
  ok: true
  plan: QuotaStatusPayload
}

export type BillingApiErrorKind = 'http' | 'auth' | 'network' | 'malformed' | 'invalid_plan'

export class BillingApiError extends Error {
  readonly kind: BillingApiErrorKind
  readonly status: number | null
  readonly code: string | null

  constructor(
    kind: BillingApiErrorKind,
    message: string,
    opts: { status?: number | null; code?: string | null } = {},
  ) {
    super(message)
    this.name = 'BillingApiError'
    this.kind = kind
    this.status = opts.status ?? null
    this.code = opts.code ?? null
  }
}

export function isBillingPlanCode(value: unknown): value is BillingPlanCode {
  return value === 'student_basic_monthly' || value === 'student_basic_annual'
}

async function requireAccessToken(): Promise<string> {
  const supabase = getSupabase()
  if (!supabase) {
    throw new BillingApiError('auth', 'Sign in required.', { status: 401, code: 'auth_required' })
  }
  let token: string | undefined
  try {
    const { data } = await supabase.auth.getSession()
    token = data.session?.access_token ?? undefined
  } catch {
    throw new BillingApiError('auth', 'Could not read session.', { status: 401, code: 'auth_required' })
  }
  if (!token) {
    throw new BillingApiError('auth', 'Sign in required.', { status: 401, code: 'auth_required' })
  }
  return token
}

function readErrorCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const code = (body as { error?: unknown }).error
  return typeof code === 'string' && code.length > 0 ? code : null
}

function readErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback
  const message = (body as { message?: unknown }).message
  return typeof message === 'string' && message.length > 0 ? message : fallback
}

async function parseJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    throw new BillingApiError('malformed', 'Billing response was not valid JSON.', {
      status: res.status,
      code: 'malformed_response',
    })
  }
}

async function billingFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = await requireAccessToken()
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  let res: Response
  try {
    res = await fetch(`${getAiApiBase()}${path}`, { ...init, headers })
  } catch {
    throw new BillingApiError('network', 'Network error talking to billing.', {
      status: null,
      code: 'network_error',
    })
  }

  const body = await parseJson(res)

  if (res.status === 401) {
    throw new BillingApiError('auth', readErrorMessage(body, 'Sign in required.'), {
      status: 401,
      code: readErrorCode(body) ?? 'auth_required',
    })
  }

  if (!res.ok) {
    throw new BillingApiError('http', readErrorMessage(body, `Billing request failed (${res.status}).`), {
      status: res.status,
      code: readErrorCode(body),
    })
  }

  if (!body || typeof body !== 'object' || (body as { ok?: unknown }).ok !== true) {
    throw new BillingApiError('malformed', 'Billing response was malformed.', {
      status: res.status,
      code: readErrorCode(body) ?? 'malformed_response',
    })
  }

  return body
}

/** Exported for tests: the pure response parser (additive fields stay absent unless correctly typed). */
export function assertSubscriptionRecord(value: unknown, label: string): SubscriptionRecord {
  if (!value || typeof value !== 'object') {
    throw new BillingApiError('malformed', `${label} missing subscription.`, {
      code: 'malformed_response',
    })
  }
  const s = value as Record<string, unknown>
  if (typeof s.active !== 'boolean') {
    throw new BillingApiError('malformed', `${label} missing subscription.active.`, {
      code: 'malformed_response',
    })
  }
  if (typeof s.status !== 'string') {
    throw new BillingApiError('malformed', `${label} missing subscription.status.`, {
      code: 'malformed_response',
    })
  }
  if (typeof s.cancelAtPeriodEnd !== 'boolean') {
    throw new BillingApiError('malformed', `${label} missing subscription.cancelAtPeriodEnd.`, {
      code: 'malformed_response',
    })
  }
  if (typeof s.manageable !== 'boolean') {
    throw new BillingApiError('malformed', `${label} missing subscription.manageable.`, {
      code: 'malformed_response',
    })
  }
  const provider = s.provider === 'stripe' ? 'stripe' : s.provider == null ? null : null
  if (s.provider != null && s.provider !== 'stripe') {
    throw new BillingApiError('malformed', `${label} has unexpected provider.`, {
      code: 'malformed_response',
    })
  }
  // Additive trial / grace facts: copied only when they have the expected type, so an older response (or a
  // malformed value) leaves them absent instead of inventing a state.
  const additive: Pick<SubscriptionRecord, 'trialing' | 'trialEnd' | 'inGrace'> = {}
  if (typeof s.trialing === 'boolean') additive.trialing = s.trialing
  if (typeof s.trialEnd === 'string') additive.trialEnd = s.trialEnd
  else if (s.trialEnd === null) additive.trialEnd = null
  if (typeof s.inGrace === 'boolean') additive.inGrace = s.inGrace
  return {
    ...additive,
    provider,
    active: s.active,
    planCode: typeof s.planCode === 'string' ? s.planCode : s.planCode == null ? null : null,
    billingInterval:
      typeof s.billingInterval === 'string' ? s.billingInterval : s.billingInterval == null ? null : null,
    status: s.status,
    currentPeriodEnd:
      typeof s.currentPeriodEnd === 'string'
        ? s.currentPeriodEnd
        : s.currentPeriodEnd == null
          ? null
          : null,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    graceUntil: typeof s.graceUntil === 'string' ? s.graceUntil : s.graceUntil == null ? null : null,
    manageable: s.manageable,
  }
}

function assertUrlPayload(body: unknown, label: string): string {
  const url = body && typeof body === 'object' ? (body as { url?: unknown }).url : undefined
  if (typeof url !== 'string' || url.trim().length === 0) {
    throw new BillingApiError('malformed', `${label} missing url.`, { code: 'malformed_response' })
  }
  return url
}

export async function getSubscriptionStatus(): Promise<SubscriptionStatusPayload> {
  const body = await billingFetch('/subscription/status', { method: 'GET' })
  const subscription = assertSubscriptionRecord(
    (body as { subscription?: unknown }).subscription,
    'subscription/status',
  )
  return { ok: true, subscription }
}

export async function refreshSubscription(): Promise<SubscriptionRefreshPayload> {
  const body = await billingFetch('/subscription/refresh', { method: 'POST' })
  const subscription = assertSubscriptionRecord(
    (body as { subscription?: unknown }).subscription,
    'subscription/refresh',
  )
  const refreshed = (body as { refreshed?: unknown }).refreshed === true
  return { ok: true, refreshed, subscription }
}

export async function createCheckout(planCode: BillingPlanCode): Promise<CheckoutPayload> {
  if (!isBillingPlanCode(planCode)) {
    throw new BillingApiError('invalid_plan', 'Unknown subscription plan.', {
      status: 400,
      code: 'invalid_plan',
    })
  }
  const body = await billingFetch('/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({ plan_code: planCode }),
  })
  return { ok: true, url: assertUrlPayload(body, 'billing/checkout') }
}

export async function openPortal(): Promise<PortalPayload> {
  const body = await billingFetch('/billing/portal', {
    method: 'POST',
    body: JSON.stringify({}),
  })
  return { ok: true, url: assertUrlPayload(body, 'billing/portal') }
}

export async function getQuotaStatus(): Promise<QuotaStatusResponse> {
  const body = await billingFetch('/quota/status', { method: 'GET' })
  const plan = (body as { plan?: unknown }).plan
  if (!plan || typeof plan !== 'object') {
    throw new BillingApiError('malformed', 'quota/status missing plan.', {
      code: 'malformed_response',
    })
  }
  return { ok: true, plan: plan as QuotaStatusPayload }
}
