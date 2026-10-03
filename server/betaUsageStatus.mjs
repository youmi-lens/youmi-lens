/**
 * GET /api/beta-usage-status
 * Returns the authenticated user's current beta plan and usage status.
 * Requires Supabase JWT (Bearer token).
 */

import {
  verifyJwt,
  getEffectiveQuota,
  getUsedMinutes,
  getDailyCount,
  getDailyMinutesUsed,
  BETA_ERROR_CODES,
  PAID_PLAN_LIMITS,
  PLAN_LIMITS,
  MONTHLY_PLANS,
  getAdminClient,
} from './betaGate.mjs'

const STUDENT_BASIC_PRODUCT_ID = 'com.aydenz.youmilensipad.studentbasic30d'

const DISPLAY_NAMES = {
  public_trial: 'Free Beta',
  core_tester: 'Core Tester',
  student_basic: 'Youmi Lens Basic',
  student_plus: 'Youmi Lens Plus',
  student_pro: 'Youmi Lens Pro',
  student_pass: 'Student Basic',
  admin: 'Developer Mode',
}

function roundMinutes(value) {
  return Math.round(Number(value || 0) * 10) / 10
}

function planLimit(quota, key) {
  return PLAN_LIMITS[quota?.plan_type]?.[key] ?? quota?.[key]
}

async function loadStudentPassPurchaseAvailability() {
  const db = getAdminClient()
  if (!db) return { productId: STUDENT_BASIC_PRODUCT_ID, isPurchasable: false, salesEndAt: null }
  try {
    const { data, error } = await db
      .from('billing_products')
      .select('product_id, is_purchasable, sales_end_at')
      .eq('product_id', STUDENT_BASIC_PRODUCT_ID)
      .maybeSingle()
    if (error) throw error
    return {
      productId: STUDENT_BASIC_PRODUCT_ID,
      isPurchasable: Boolean(data?.is_purchasable),
      salesEndAt: data?.sales_end_at ?? null,
    }
  } catch (err) {
    console.warn('[quota-status] billing product availability failed', err instanceof Error ? err.message : String(err))
    return { productId: STUDENT_BASIC_PRODUCT_ID, isPurchasable: false, salesEndAt: null }
  }
}

export async function handleBetaUsageStatus(req, res) {
  // Auth
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!token) {
    res.status(401).json({ error: BETA_ERROR_CODES.AUTH_REQUIRED, message: 'Sign in required.' })
    return
  }
  const user = await verifyJwt(token)
  if (!user) {
    res.status(401).json({ error: BETA_ERROR_CODES.AUTH_REQUIRED, message: 'Invalid or expired session.' })
    return
  }

  const quota = await getEffectiveQuota(user.userId, user.email)
  if (!quota) {
    res.status(503).json({ error: BETA_ERROR_CODES.QUOTA_REQUIRED, message: 'Beta quota temporarily unavailable.' })
    return
  }

  const planType = quota.plan_type || 'public_trial'
  const displayName = DISPLAY_NAMES[planType] ?? planType

  // Admin: no usage tracking
  if (planType === 'admin') {
    res.json({
      email: user.email,
      plan_type: planType,
      display_name: displayName,
      limits_bypassed: true,
      message: 'Usage limits are bypassed for this account.',
    })
    return
  }

  const recordingsToday = await getDailyCount(user.userId)

  // All non-admin plans (public_trial, core_tester, student_*) are now monthly.
  // Limit is sourced from PLAN_LIMITS via planLimit() so server constants win
  // over any stale value on the user_quota row.
  // Daily minute usage is the same on every non-admin branch — sum of
  // billable_minutes since UTC day start. `null` daily limit means unlimited
  // (treated as Infinity at gate time; surfaced as null here for honesty).
  const dailyMinutesUsed = await getDailyMinutesUsed(user.userId)
  const dailyMinutesLimitRaw = planLimit(quota, 'daily_minutes_limit')
  const dailyMinutesLimit = dailyMinutesLimitRaw == null ? null : Number(dailyMinutesLimitRaw)
  const dailyMinutesRemaining =
    dailyMinutesLimit == null ? null : roundMinutes(Math.max(0, dailyMinutesLimit - dailyMinutesUsed))

  if (planType === 'public_trial') {
    const usedMinutes = await getUsedMinutes(user.userId, quota)
    const baseLimit = planLimit(quota, 'monthly_minutes_limit') ?? 300
    const limitMinutes = Number(baseLimit) + (quota.extra_minutes_balance ?? 0)
    const remainingMinutes = Math.max(0, limitMinutes - usedMinutes)

    // Emit both the legacy public_trial shape and the monthly shape so existing
    // consumers (Mac App.tsx sidebar) keep working while new consumers can use
    // the monthly + daily field names. The numbers are identical — public_trial
    // is monthly now, plus the new daily minute fields below.
    res.json({
      email: user.email,
      plan_type: planType,
      display_name: displayName,
      used_minutes: roundMinutes(usedMinutes),
      limit_minutes: limitMinutes,
      remaining_minutes: roundMinutes(remainingMinutes),
      used_minutes_this_month: roundMinutes(usedMinutes),
      monthly_minutes_limit: limitMinutes,
      remaining_minutes_this_month: roundMinutes(remainingMinutes),
      recordings_today: recordingsToday,
      daily_recording_limit: planLimit(quota, 'max_recordings_per_day') ?? 2,
      daily_processing_job_limit:
        planLimit(quota, 'max_processing_jobs_per_day') ??
        planLimit(quota, 'max_recordings_per_day') ??
        2,
      max_recording_minutes: planLimit(quota, 'max_recording_minutes') ?? 60,
      max_live_session_minutes: planLimit(quota, 'max_live_session_minutes') ?? 60,
      daily_minutes_used: roundMinutes(dailyMinutesUsed),
      daily_minutes_limit: dailyMinutesLimit,
      daily_minutes_remaining: dailyMinutesRemaining,
    })
    return
  }

  if (planType === 'core_tester' || PAID_PLAN_LIMITS[planType]) {
    const usedMinutes = await getUsedMinutes(user.userId, quota)
    const baseLimit = planLimit(quota, 'monthly_minutes_limit') ?? 1000
    const limitMinutes = Number(baseLimit) + (quota.extra_minutes_balance ?? 0)
    const remainingMinutes = Math.max(0, limitMinutes - usedMinutes)

    res.json({
      email: user.email,
      plan_type: planType,
      display_name: displayName,
      used_minutes_this_month: roundMinutes(usedMinutes),
      monthly_minutes_limit: limitMinutes,
      remaining_minutes_this_month: roundMinutes(remainingMinutes),
      recordings_today: recordingsToday,
      daily_recording_limit: planLimit(quota, 'max_recordings_per_day') ?? 10,
      daily_processing_job_limit:
        planLimit(quota, 'max_processing_jobs_per_day') ??
        planLimit(quota, 'max_recordings_per_day') ??
        10,
      max_recording_minutes: planLimit(quota, 'max_recording_minutes') ?? 120,
      max_live_session_minutes: planLimit(quota, 'max_live_session_minutes') ?? 120,
      daily_minutes_used: roundMinutes(dailyMinutesUsed),
      daily_minutes_limit: dailyMinutesLimit,
      daily_minutes_remaining: dailyMinutesRemaining,
    })
    return
  }

  // Unknown plans fall back to public_trial monthly semantics. Emit both
  // legacy and monthly field shapes so old consumers keep working.
  const usedMinutes = await getUsedMinutes(user.userId, { ...quota, plan_type: 'public_trial' })
  const baseLimit = PLAN_LIMITS.public_trial.monthly_minutes_limit
  const limitMinutes = Number(baseLimit) + (quota.extra_minutes_balance ?? 0)
  const remainingMinutes = Math.max(0, limitMinutes - usedMinutes)
  const fallbackDailyLimit = PLAN_LIMITS.public_trial.daily_minutes_limit ?? null
  const fallbackDailyRemaining =
    fallbackDailyLimit == null ? null : roundMinutes(Math.max(0, fallbackDailyLimit - dailyMinutesUsed))
  res.json({
    email: user.email,
    plan_type: planType,
    display_name: DISPLAY_NAMES.public_trial,
    used_minutes: roundMinutes(usedMinutes),
    limit_minutes: limitMinutes,
    remaining_minutes: roundMinutes(remainingMinutes),
    used_minutes_this_month: roundMinutes(usedMinutes),
    monthly_minutes_limit: limitMinutes,
    remaining_minutes_this_month: roundMinutes(remainingMinutes),
    recordings_today: recordingsToday,
    daily_recording_limit: PLAN_LIMITS.public_trial.max_recordings_per_day,
    daily_processing_job_limit:
      PLAN_LIMITS.public_trial.max_processing_jobs_per_day ??
      PLAN_LIMITS.public_trial.max_recordings_per_day,
    max_recording_minutes: PLAN_LIMITS.public_trial.max_recording_minutes,
    max_live_session_minutes: PLAN_LIMITS.public_trial.max_live_session_minutes,
    daily_minutes_used: roundMinutes(dailyMinutesUsed),
    daily_minutes_limit: fallbackDailyLimit,
    daily_minutes_remaining: fallbackDailyRemaining,
  })
}

// ── GET /api/quota/status ────────────────────────────────────────────────────
// Live plan + quota for the iPad Settings screen. Normalized camelCase shape,
// secret-free. Distinct from /api/beta-usage-status (kept for the macOS app).

/** plan_type → user-facing plan name shown in Settings / Access page. */
const QUOTA_PLAN_DISPLAY_NAMES = {
  admin: 'Developer',
  developer: 'Developer',
  core_tester: 'Core Tester',
  student_basic: 'Youmi Lens Basic',
  student_plus: 'Youmi Lens Plus',
  student_pro: 'Youmi Lens Pro',
  student_pass: 'Student Basic',
  public_trial: 'Free Beta',
}

/** Plans that bypass all quota limits. */
const UNLIMITED_PLAN_TYPES = new Set(['admin', 'developer'])

/**
 * GET /api/quota/status
 * Returns the authenticated user's live plan + quota in a normalized,
 * secret-free shape. Requires a Supabase JWT (Bearer token). A missing
 * user_quota row is auto-created as public_trial by getOrCreateUserQuota.
 */
export async function buildQuotaStatus(userId, email) {
  // Effective plan (admin/core_tester override > active Student Pass entitlement
  // > public_trial). An expired pass resolves back to public_trial with no cron.
  const quota = await getEffectiveQuota(userId, email)
  if (!quota) return null

  const planType = quota.plan_type || 'public_trial'
  const displayName = QUOTA_PLAN_DISPLAY_NAMES[planType] ?? QUOTA_PLAN_DISPLAY_NAMES.public_trial
  const status = quota.status === 'suspended' ? 'suspended' : 'active'

  // Entitlement summary for the paywall / account screen. Secret-free.
  const ent = quota._entitlement ?? null
  const entitlement = ent
    ? {
        active: true,
        status: ent.status || 'active',
        productId: ent.product_id,
        planType: ent.plan_type,
        startsAt: ent.starts_at,
        expiresAt: ent.expires_at,
        autoRenewStatus: ent.auto_renew_status ?? null,
        originalTransactionId: ent.original_transaction_id ?? null,
        latestTransactionId: ent.source_transaction_id ?? null,
        subscriptionGroupId: ent.subscription_group_id ?? null,
        revocationAt: ent.revoked_at ?? null,
        source: ent.source ?? null,
        revoked: Boolean(ent.revoked_at),
      }
    : { active: false, productId: null, expiresAt: null }
  const studentPassActive = Boolean(ent)
  const studentPassExpiry = ent?.expires_at ?? null
  const effectivePlanType = planType
  const studentPass = await loadStudentPassPurchaseAvailability()

  // Developer / admin: unlimited — no usage counters to report.
  if (UNLIMITED_PLAN_TYPES.has(planType)) {
    return {
      planType,
      displayName,
      status,
      unlimited: true,
      entitlement,
      studentPassActive,
      studentPassExpiry,
      effectivePlanType,
      studentPass,
    }
  }

  // Limited tiers: report live daily + minute usage from the existing helpers.
  const recordingsUsedToday = await getDailyCount(userId)
  const maxRecordingsPerDay = Number(planLimit(quota, 'max_recordings_per_day') ?? 0)
  const maxProcessingJobsPerDay = Number(
    planLimit(quota, 'max_processing_jobs_per_day') ??
      planLimit(quota, 'max_recordings_per_day') ??
      0,
  )
  const maxRecordingMinutes = Number(planLimit(quota, 'max_recording_minutes') ?? 0)
  const maxLiveSessionMinutes = Number(planLimit(quota, 'max_live_session_minutes') ?? 0)
  const extraMinutesBalance = Number(quota.extra_minutes_balance ?? 0)

  // All non-admin plans (public_trial, core_tester, student_*) are monthly.
  // public_trial joined MONTHLY_PLANS as part of the student-beta tightening.
  const isMonthly = MONTHLY_PLANS.has(planType) || Boolean(PLAN_LIMITS[planType])
  const minutesUsed = await getUsedMinutes(
    userId,
    isMonthly ? quota : { ...quota, plan_type: 'public_trial' },
  )
  const baseMinutesLimit = isMonthly
    ? planLimit(quota, 'monthly_minutes_limit')
    : quota.total_trial_minutes_limit
  const minutesLimit = baseMinutesLimit == null ? null : Number(baseMinutesLimit) + extraMinutesBalance

  // Daily minute budget (per-UTC-day sum of billable_minutes for processed
  // recordings). NULL limit means no daily cap (used by admin only — admin
  // already returned above, so in practice always a number for limited tiers).
  const dailyMinutesUsed = await getDailyMinutesUsed(userId)
  const dailyMinutesLimitRaw = planLimit(quota, 'daily_minutes_limit')
  const dailyMinutesLimit = dailyMinutesLimitRaw == null ? null : Number(dailyMinutesLimitRaw)
  const dailyMinutesRemaining =
    dailyMinutesLimit == null ? null : roundMinutes(Math.max(0, dailyMinutesLimit - dailyMinutesUsed))

  return {
    planType,
    displayName,
    status,
    unlimited: false,
    entitlement,
    studentPass,
    maxRecordingsPerDay,
    maxProcessingJobsPerDay,
    recordingsUsedToday,
    recordingsRemainingToday: Math.max(0, maxRecordingsPerDay - recordingsUsedToday),
    maxRecordingMinutes,
    maxLiveSessionMinutes,
    totalTrialMinutesLimit:
      quota.total_trial_minutes_limit == null ? null : Number(quota.total_trial_minutes_limit),
    monthlyMinutesLimit:
      planLimit(quota, 'monthly_minutes_limit') == null
        ? null
        : Number(planLimit(quota, 'monthly_minutes_limit')),
    extraMinutesBalance,
    minutesUsed: roundMinutes(minutesUsed),
    minutesLimit,
    minutesRemaining: minutesLimit == null ? null : roundMinutes(Math.max(0, minutesLimit - minutesUsed)),
    dailyMinutesUsed: roundMinutes(dailyMinutesUsed),
    dailyMinutesLimit,
    dailyMinutesRemaining,
    studentPassActive,
    studentPassExpiry,
    effectivePlanType,
    quota: {
      monthly_minutes: planLimit(quota, 'monthly_minutes_limit') == null
        ? null
        : Number(planLimit(quota, 'monthly_minutes_limit')),
      daily_minutes: dailyMinutesLimit,
      max_recording_minutes: maxRecordingMinutes,
      max_live_minutes: maxLiveSessionMinutes,
      recordings_per_day: maxRecordingsPerDay,
      processing_jobs_per_day: maxProcessingJobsPerDay,
    },
  }
}

export async function handleQuotaStatus(req, res) {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!token) {
    res.status(401).json({ ok: false, error: BETA_ERROR_CODES.AUTH_REQUIRED, message: 'Sign in required.' })
    return
  }
  const user = await verifyJwt(token)
  if (!user) {
    res.status(401).json({ ok: false, error: BETA_ERROR_CODES.AUTH_REQUIRED, message: 'Invalid or expired session.' })
    return
  }

  const plan = await buildQuotaStatus(user.userId, user.email)
  if (!plan) {
    res.status(503).json({
      ok: false,
      error: BETA_ERROR_CODES.QUOTA_REQUIRED,
      message: 'Plan information is temporarily unavailable.',
    })
    return
  }

  res.json({ ok: true, plan })
}
