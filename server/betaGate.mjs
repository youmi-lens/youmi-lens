/**
 * Youmi Lens Beta Gate — server-side quota enforcement.
 *
 * Plan tiers (free-beta launch):
 *   public_trial  — Free Beta: 300 min/month, 120 min/day, 60 min/recording, 2 recordings/day, 2 processing jobs/day, 60 min live session
 *   core_tester   — Core Tester: 1000 min/month, 240 min/day, 120 min/recording, 10 recordings/day, 120 min live session
 *   student_basic — kept for IAP back-compat (UI hidden): 200 min/month, 120 min/day, 60 min/recording, 10/day, 60 min live
 *   student_plus  — kept for IAP back-compat (UI hidden): 600 min/month, 240 min/day, 120 min/recording, 20/day, 120 min live
 *   student_pro   — kept for IAP back-compat (UI hidden): 1500 min/month, 360 min/day, 180 min/recording, 50/day, 180 min live
 *   admin         — bypass all limits
 *
 * Billable actions (count toward monthly + daily minute quotas):
 *   process_recording, regenerate_summary
 *
 * Non-billable (logged for monitoring only; gated against daily/monthly minute
 * caps when the user is already over, but do not increment usage themselves):
 *   upload_audio, live_caption_session, transcription, summary_generation, translate_caption
 *
 * Quota is shared per Supabase user_id across iPad and Mac (single user_quota
 * row per user; single beta_usage ledger keyed by user_id only, no platform
 * column anywhere).
 *
 * Error codes returned to clients:
 *   auth_required                  — JWT missing or invalid
 *   quota_required                 — quota row could not be created/read
 *   beta_limit_reached             — lifetime or monthly quota exhausted
 *   recording_too_long             — recording exceeds per-recording minute limit
 *   daily_recording_limit_reached  — too many recordings processed today
 *   daily_minutes_limit_reached    — daily billable-minute cap exhausted
 *   quota_suspended                — account suspended
 */

import { createClient } from '@supabase/supabase-js'
import { getActiveEntitlement, isEntitlementActive, resolveEffectivePlanType } from './iapEntitlements.mjs'

// ── Constants ──────────────────────────────────────────────────────────────────

export const BETA_LIMIT_MESSAGE =
  'Free beta limit reached. Please contact support for more beta access.'

/** Shown when an account has been put on hold by an admin (status = suspended). */
export const SUSPENDED_MESSAGE =
  'Your account is currently on hold. Please contact support for help.'

export const BETA_ERROR_CODES = {
  AUTH_REQUIRED: 'auth_required',
  QUOTA_REQUIRED: 'quota_required',
  BETA_LIMIT_REACHED: 'beta_limit_reached',
  RECORDING_TOO_LONG: 'recording_too_long',
  DAILY_LIMIT_REACHED: 'daily_recording_limit_reached',
  DAILY_MINUTES_LIMIT_REACHED: 'daily_minutes_limit_reached',
  SUSPENDED: 'quota_suspended',
}

/**
 * Default limits for new public_trial (Free Beta) users.
 *
 * Free-beta launch policy:
 *   - public_trial (Free Beta): 300 min/month, 120 min/day, 60 min/recording,
 *     2 recordings/day, 2 processing jobs/day, 60 min live.
 *   - core_tester (Core Tester): 1000 min/month, 240 min/day, 120 min/recording,
 *     10 recordings/day, 120 min live.
 *   - admin: unlimited / bypass.
 *
 * All numbers below can be overridden at deploy time via the BETA_* env vars
 * without code changes.
 *
 * BETA_MAX_TRIAL_MINUTES is retained only as the legacy lifetime-backstop
 * column default for new rows; it no longer drives quota enforcement.
 */
const LEGACY_LIFETIME_BACKSTOP_MINUTES = Number(process.env.BETA_MAX_TRIAL_MINUTES || 20)
const PUBLIC_TRIAL_MONTHLY_MINUTES = Number(process.env.BETA_PUBLIC_TRIAL_MONTHLY_MINUTES || 300)
const PUBLIC_TRIAL_DAILY_MINUTES = Number(process.env.BETA_PUBLIC_TRIAL_DAILY_MINUTES || 120)
const CORE_TESTER_MONTHLY_MINUTES = Number(process.env.BETA_CORE_TESTER_MONTHLY_MINUTES || 1000)
const CORE_TESTER_DAILY_MINUTES = Number(process.env.BETA_CORE_TESTER_DAILY_MINUTES || 240)
const DEFAULT_MAX_RECORDING_MINUTES = Number(process.env.BETA_MAX_RECORDING_MINUTES || 60)
const PUBLIC_TRIAL_MAX_RECORDINGS_PER_DAY = Number(
  process.env.BETA_PUBLIC_TRIAL_MAX_RECORDINGS_PER_DAY ||
    process.env.BETA_MAX_RECORDINGS_PER_DAY ||
    2,
)
const PUBLIC_TRIAL_MAX_PROCESSING_JOBS_PER_DAY = Number(
  process.env.BETA_PUBLIC_TRIAL_MAX_PROCESSING_JOBS_PER_DAY || 2,
)
const DEFAULT_MAX_LIVE_SESSION_MINUTES = Number(process.env.BETA_MAX_LIVE_SESSION_MINUTES || 60)

// Paid Student Pass limits. Every value is env-overridable so quotas can
// change server-side without shipping a new app version. NOT unlimited.
const STUDENT_PASS_MONTHLY_MINUTES = Number(process.env.BETA_STUDENT_PASS_MONTHLY_MINUTES || 600)
const STUDENT_PASS_DAILY_MINUTES = Number(process.env.BETA_STUDENT_PASS_DAILY_MINUTES || 120)
const STUDENT_PASS_MAX_RECORDING_MINUTES = Number(process.env.BETA_STUDENT_PASS_MAX_RECORDING_MINUTES || 90)
const STUDENT_PASS_MAX_RECORDINGS_PER_DAY = Number(process.env.BETA_STUDENT_PASS_MAX_RECORDINGS_PER_DAY || 6)
const STUDENT_PASS_MAX_PROCESSING_JOBS_PER_DAY = Number(process.env.BETA_STUDENT_PASS_MAX_PROCESSING_JOBS_PER_DAY || 10)
const STUDENT_PASS_MAX_LIVE_SESSION_MINUTES = Number(process.env.BETA_STUDENT_PASS_MAX_LIVE_SESSION_MINUTES || 90)

/**
 * Single source of truth for per-plan limits. Server constants win over any
 * stale value on the user_quota row — `planLimit()` checks PLAN_LIMITS first.
 *
 * `daily_minutes_limit` is the per-UTC-day cap on billable processing minutes
 * (sum of beta_usage.billable_minutes for action_type in process_recording /
 * regenerate_summary). admin bypasses all limits and has no entry here.
 */
export const PLAN_LIMITS = {
  public_trial: {
    monthly_minutes_limit: PUBLIC_TRIAL_MONTHLY_MINUTES,
    daily_minutes_limit: PUBLIC_TRIAL_DAILY_MINUTES,
    max_recording_minutes: DEFAULT_MAX_RECORDING_MINUTES,
    max_recordings_per_day: PUBLIC_TRIAL_MAX_RECORDINGS_PER_DAY,
    max_processing_jobs_per_day: PUBLIC_TRIAL_MAX_PROCESSING_JOBS_PER_DAY,
    max_live_session_minutes: DEFAULT_MAX_LIVE_SESSION_MINUTES,
  },
  core_tester: {
    monthly_minutes_limit: CORE_TESTER_MONTHLY_MINUTES,
    daily_minutes_limit: CORE_TESTER_DAILY_MINUTES,
    max_recording_minutes: 120,
    max_recordings_per_day: 10,
    max_processing_jobs_per_day: 10,
    max_live_session_minutes: 120,
  },
  student_basic: {
    monthly_minutes_limit: 200,
    daily_minutes_limit: 120,
    max_recording_minutes: 60,
    max_recordings_per_day: 10,
    max_processing_jobs_per_day: 10,
    max_live_session_minutes: 60,
  },
  student_plus: {
    monthly_minutes_limit: 600,
    daily_minutes_limit: 240,
    max_recording_minutes: 120,
    max_recordings_per_day: 20,
    max_processing_jobs_per_day: 20,
    max_live_session_minutes: 120,
  },
  student_pro: {
    monthly_minutes_limit: 1500,
    daily_minutes_limit: 360,
    max_recording_minutes: 180,
    max_recordings_per_day: 50,
    max_processing_jobs_per_day: 50,
    max_live_session_minutes: 180,
  },
  // Active product. Granted via a time-boxed user_entitlement (never written
  // permanently onto user_quota.plan_type); resolved at request time.
  student_pass: {
    monthly_minutes_limit: STUDENT_PASS_MONTHLY_MINUTES,
    daily_minutes_limit: STUDENT_PASS_DAILY_MINUTES,
    max_recording_minutes: STUDENT_PASS_MAX_RECORDING_MINUTES,
    max_recordings_per_day: STUDENT_PASS_MAX_RECORDINGS_PER_DAY,
    max_processing_jobs_per_day: STUDENT_PASS_MAX_PROCESSING_JOBS_PER_DAY,
    max_live_session_minutes: STUDENT_PASS_MAX_LIVE_SESSION_MINUTES,
  },
}

/**
 * Back-compat export. Other modules (notably iapRoutes.mjs / betaUsageStatus.mjs)
 * still import PAID_PLAN_LIMITS by name; keep it pointing at the paid subset so
 * iPad IAP code paths are not disturbed.
 */
export const PAID_PLAN_LIMITS = {
  student_basic: PLAN_LIMITS.student_basic,
  student_plus: PLAN_LIMITS.student_plus,
  student_pro: PLAN_LIMITS.student_pro,
}

/** Plans that use monthly quota (calendar-month reset). public_trial is now monthly. */
export const MONTHLY_PLANS = new Set([
  'public_trial',
  'core_tester',
  'student_basic',
  'student_plus',
  'student_pro',
  'student_pass',
])
/**
 * Lifetime-quota plans. Empty after the student-beta tightening — kept as a
 * defensive no-op so any future caller branching on it still type-checks.
 */
const LIFETIME_PLANS = new Set()

// ── Supabase admin client ──────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY

let _adminClient = null
export function getAdminClient() {
  if (!_adminClient && SUPABASE_URL && SERVICE_ROLE_KEY) {
    _adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }
  return _adminClient
}

let _anonClient = null
export function getAnonClient() {
  if (!_anonClient && SUPABASE_URL && ANON_KEY) {
    _anonClient = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }
  return _anonClient
}

// ── JWT verification ───────────────────────────────────────────────────────────

/**
 * Verify a Supabase JWT and return { userId, email }.
 * Returns null on failure.
 */
export async function verifyJwt(token) {
  if (!token || typeof token !== 'string') return null
  const anon = getAnonClient()
  if (!anon) return null
  try {
    const { data, error } = await anon.auth.getUser(token)
    if (error || !data?.user?.id) return null
    return { userId: data.user.id, email: data.user.email || '' }
  } catch {
    return null
  }
}

// ── Quota management ───────────────────────────────────────────────────────────

/**
 * Get the user's quota row, creating a public_trial row if none exists.
 * Returns null only if the DB is unavailable.
 */
export async function getOrCreateUserQuota(userId, email) {
  const db = getAdminClient()
  if (!db) return null

  const { data: existing } = await db
    .from('user_quota')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  if (existing) return existing

  // First-time user: create public_trial row
  const { data: created, error } = await db
    .from('user_quota')
    .insert({
      user_id: userId,
      email: (email || '').toLowerCase(),
      plan_type: 'public_trial',
      total_trial_minutes_limit: LEGACY_LIFETIME_BACKSTOP_MINUTES,
      monthly_minutes_limit: PUBLIC_TRIAL_MONTHLY_MINUTES,
      daily_minutes_limit: PUBLIC_TRIAL_DAILY_MINUTES,
      max_recording_minutes: DEFAULT_MAX_RECORDING_MINUTES,
      max_recordings_per_day: PUBLIC_TRIAL_MAX_RECORDINGS_PER_DAY,
      max_live_session_minutes: DEFAULT_MAX_LIVE_SESSION_MINUTES,
      extra_minutes_balance: 0,
      status: 'active',
    })
    .select()
    .single()

  if (error) {
    // Race: another request already inserted, re-fetch
    const { data: retry } = await db
      .from('user_quota')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()
    return retry || null
  }
  return created
}

/**
 * Resolve the user's EFFECTIVE quota at request time.
 *
 * user_quota.plan_type is never permanently set to student_pass — paid access
 * lives in a time-boxed user_entitlement. This returns the stored quota row with
 * its plan_type replaced by the effective plan:
 *   admin (stored override) > active student_pass entitlement > core_tester > public_trial.
 *
 * PLAN_LIMITS keys off plan_type, so the returned object drives every existing
 * gate with the correct limits. An expired/absent entitlement yields
 * public_trial automatically — no cron required. `_entitlement` (if active) is
 * attached for status surfaces; it is not a DB column.
 */
export async function getEffectiveQuota(userId, email) {
  const quota = await getOrCreateUserQuota(userId, email)
  if (!quota) return null

  const db = getAdminClient()
  if (!db) return quota // fail safe: behave as stored plan if DB unavailable

  const nowMs = Date.now()
  let entitlement = null
  try {
    entitlement = await getActiveEntitlement(db, userId, new Date(nowMs).toISOString())
  } catch (err) {
    console.warn('[betaGate] getActiveEntitlement failed', err instanceof Error ? err.message : String(err))
    // On lookup failure, fall back to the stored plan rather than over-granting.
    return quota
  }

  // Quota TIER and subscription OWNERSHIP are independent dimensions. Admin
  // still outranks every entitlement for access/limits — that precedence lives
  // in resolveEffectivePlanType and is unchanged — but an admin who also holds
  // a real paid subscription must still be REPORTED as owning it. Attaching
  // `_entitlement` independently of the tier decision is what lets
  // buildQuotaStatus answer studentPassActive truthfully for those accounts;
  // previously admin returned early here, so an active subscription was
  // silently dropped and the Plans screen showed no Student Basic at all.
  const activeEntitlement = isEntitlementActive(entitlement, nowMs) ? entitlement : null

  const effectivePlan = resolveEffectivePlanType({
    storedPlanType: quota.plan_type,
    entitlement,
    nowMs,
  })
  if (effectivePlan === quota.plan_type && !activeEntitlement) return quota
  return { ...quota, plan_type: effectivePlan, _entitlement: activeEntitlement }
}

export function quotaPatchForPlan(planType) {
  // Preserve the iPad IAP contract: this helper is called by iapRoutes.mjs to
  // promote a user to a paid plan. Restrict it to paid plans only so a typo
  // can't write a public_trial / core_tester patch through this path.
  // IAP is dormant in the free-beta launch; the patch shape is kept current
  // (including daily_minutes_limit) so a future relaunch still works.
  const limits = PAID_PLAN_LIMITS[planType]
  if (!limits) return { plan_type: planType }
  return {
    plan_type: planType,
    monthly_minutes_limit: limits.monthly_minutes_limit,
    daily_minutes_limit: limits.daily_minutes_limit,
    max_recording_minutes: limits.max_recording_minutes,
    max_recordings_per_day: limits.max_recordings_per_day,
    max_live_session_minutes: limits.max_live_session_minutes,
    status: 'active',
  }
}

function planLimit(quota, key) {
  return PLAN_LIMITS[quota?.plan_type]?.[key] ?? quota?.[key]
}

// ── Usage queries ──────────────────────────────────────────────────────────────

/** Sum of billable_minutes for billable action types (process_recording + regenerate_summary). */
export async function getBillableMinutesUsed(userId, { sinceIso } = {}) {
  const db = getAdminClient()
  if (!db) return 0
  let q = db
    .from('beta_usage')
    .select('billable_minutes')
    .eq('user_id', userId)
    .in('action_type', ['process_recording', 'regenerate_summary'])
  if (sinceIso) q = q.gte('created_at', sinceIso)
  const { data } = await q
  return (data ?? []).reduce((sum, r) => sum + Number(r.billable_minutes ?? 0), 0)
}

/** Count of billable actions today (UTC day). */
export async function getDailyRecordingCount(userId) {
  const db = getAdminClient()
  if (!db) return 0
  const now = new Date()
  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString()
  const { count, error } = await db
    .from('beta_usage')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('action_type', ['process_recording', 'regenerate_summary'])
    .gte('created_at', todayStart)
  if (error) return 0
  return count ?? 0
}

/**
 * Sum of billable_minutes for billable action types since the current UTC
 * day start. Uses the same day boundary as getDailyRecordingCount so the
 * "today" window is consistent across all gate checks and status endpoints.
 * Server-derived time only — never trusts the client clock.
 */
export async function getDailyMinutesUsed(userId) {
  const now = new Date()
  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString()
  return getBillableMinutesUsed(userId, { sinceIso: todayStart })
}

/** Sum billable usage for the quota period used by the user's current plan. */
export async function getUsedMinutes(userId, quota) {
  if (!quota) return 0
  if (LIFETIME_PLANS.has(quota.plan_type)) {
    return getBillableMinutesUsed(userId)
  }
  if (MONTHLY_PLANS.has(quota.plan_type)) {
    const now = new Date()
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ).toISOString()
    return getBillableMinutesUsed(userId, { sinceIso: monthStart })
  }
  return 0
}

/** Count billable recording-generation actions since UTC day start. */
export async function getDailyCount(userId) {
  return getDailyRecordingCount(userId)
}

// ── Gate functions ─────────────────────────────────────────────────────────────

/**
 * Build a structured error response object (for use in res.status(4xx).json(...)).
 */
export function betaError(code, message, details = {}) {
  return { error: code, message, details }
}

/**
 * Check whether a cloud audio upload is allowed for this user.
 * Only enforces per-recording duration limit (to prevent uploading 2-hour files).
 * Quota (daily/monthly) is enforced at process time, not at upload time.
 *
 * @param {object} quota  — result of getOrCreateUserQuota()
 * @param {number} durationSec  — recording duration in seconds (from client)
 * @returns {{ allowed: true } | { allowed: false, status: number, body: object }}
 */
export function checkUploadAllowed(quota, durationSec) {
  if (!quota) return { allowed: true } // can't enforce without quota row

  if (quota.status === 'suspended') {
    return {
      allowed: false,
      status: 403,
      body: betaError(BETA_ERROR_CODES.SUSPENDED, SUSPENDED_MESSAGE, {}),
    }
  }

  if (quota.plan_type === 'admin') return { allowed: true }

  const maxRecordingMinutes = Number(planLimit(quota, 'max_recording_minutes') ?? DEFAULT_MAX_RECORDING_MINUTES)
  const maxSec = maxRecordingMinutes * 60
  if (durationSec > maxSec) {
    return {
      allowed: false,
      status: 403,
      body: betaError(
        BETA_ERROR_CODES.RECORDING_TOO_LONG,
        `This plan is limited to ${maxRecordingMinutes} minutes per recording. This recording is about ${Math.ceil(durationSec / 60)} minutes — please record a shorter session.`,
        {
          recording_minutes: Math.ceil(durationSec / 60),
          limit_minutes: maxRecordingMinutes,
        },
      ),
    }
  }

  return { allowed: true }
}

/**
 * Check whether a new AI processing action is allowed.
 * Enforces: per-recording duration, daily count, lifetime/monthly quota.
 *
 * @param {object} quota
 * @param {string} userId
 * @param {number} durationSec  — from recordings.duration_sec
 * @returns {Promise<{ allowed: true } | { allowed: false, status: number, body: object }>}
 */
export async function checkProcessingAllowed(quota, userId, durationSec) {
  if (!quota) return { allowed: true }

  if (quota.status === 'suspended') {
    return {
      allowed: false,
      status: 403,
      body: betaError(BETA_ERROR_CODES.SUSPENDED, SUSPENDED_MESSAGE, {}),
    }
  }

  if (quota.plan_type === 'admin') return { allowed: true }

  // Per-recording duration check
  const maxRecordingMinutes = Number(planLimit(quota, 'max_recording_minutes') ?? DEFAULT_MAX_RECORDING_MINUTES)
  const maxSec = maxRecordingMinutes * 60
  if (durationSec > maxSec) {
    return {
      allowed: false,
      status: 403,
      body: betaError(
        BETA_ERROR_CODES.RECORDING_TOO_LONG,
        `This plan is limited to ${maxRecordingMinutes} minutes per recording. This recording is about ${Math.ceil(durationSec / 60)} minutes — please record a shorter session.`,
        {
          recording_minutes: Math.ceil(durationSec / 60),
          limit_minutes: maxRecordingMinutes,
        },
      ),
    }
  }

  // Daily count check
  const todayCount = await getDailyRecordingCount(userId)
  const maxProcessingJobsPerDay = Number(
    planLimit(quota, 'max_processing_jobs_per_day') ??
      planLimit(quota, 'max_recordings_per_day') ??
      PUBLIC_TRIAL_MAX_PROCESSING_JOBS_PER_DAY,
  )
  if (todayCount >= maxProcessingJobsPerDay) {
    return {
      allowed: false,
      status: 429,
      body: betaError(
        BETA_ERROR_CODES.DAILY_LIMIT_REACHED,
        `Daily limit reached. You can process up to ${maxProcessingJobsPerDay} lectures per day on this plan.`,
        { used_today: todayCount, limit_today: maxProcessingJobsPerDay },
      ),
    }
  }

  const billableMinutes = Math.ceil((durationSec || 0) / 60)

  // Daily MINUTE check. Enforces a strict per-UTC-day ceiling on billable
  // minutes — independent of and stricter than max_recordings_per_day x
  // max_recording_minutes. Skipped if the plan has no daily cap configured
  // (planLimit returns undefined → Infinity).
  const dailyMinutesUsed = await getDailyMinutesUsed(userId)
  const dailyMinutesLimitRaw = planLimit(quota, 'daily_minutes_limit')
  const dailyMinutesLimit = dailyMinutesLimitRaw == null ? Infinity : Number(dailyMinutesLimitRaw)
  if (dailyMinutesUsed + billableMinutes > dailyMinutesLimit) {
    return {
      allowed: false,
      status: 429,
      body: betaError(
        BETA_ERROR_CODES.DAILY_MINUTES_LIMIT_REACHED,
        `Daily minute limit reached (${dailyMinutesLimit} min/day on this plan). You have used ${Math.round(dailyMinutesUsed)} min today.`,
        {
          used_minutes_today: Math.round(dailyMinutesUsed),
          limit_minutes_today: dailyMinutesLimit,
          recording_minutes: billableMinutes,
        },
      ),
    }
  }

  // Quota (lifetime or monthly) check
  let usedMinutes = 0
  let limitMinutes = Infinity

  if (LIFETIME_PLANS.has(quota.plan_type)) {
    usedMinutes = await getBillableMinutesUsed(userId)
    limitMinutes = quota.total_trial_minutes_limit + (quota.extra_minutes_balance || 0)
  } else if (MONTHLY_PLANS.has(quota.plan_type)) {
    const now = new Date()
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ).toISOString()
    usedMinutes = await getBillableMinutesUsed(userId, { sinceIso: monthStart })
    limitMinutes = Number(planLimit(quota, 'monthly_minutes_limit') ?? Infinity) + (quota.extra_minutes_balance || 0)
  }

  if (usedMinutes + billableMinutes > limitMinutes) {
    return {
      allowed: false,
      status: 403,
      body: betaError(
        BETA_ERROR_CODES.BETA_LIMIT_REACHED,
        BETA_LIMIT_MESSAGE,
        {
          used_minutes: Math.round(usedMinutes),
          limit_minutes: limitMinutes,
          recording_minutes: billableMinutes,
        },
      ),
    }
  }

  return { allowed: true }
}

/**
 * Check whether a live caption session is allowed for this user.
 * Blocks if quota is fully exhausted. Does not deduct from quota.
 *
 * @param {object} quota
 * @param {string} userId
 * @returns {Promise<{ allowed: true, maxSessionMinutes: number } | { allowed: false, status: number, body: object }>}
 */
export async function checkLiveSessionAllowed(quota, userId) {
  if (!quota) return { allowed: true, maxSessionMinutes: DEFAULT_MAX_LIVE_SESSION_MINUTES }

  if (quota.status === 'suspended') {
    return {
      allowed: false,
      status: 403,
      body: betaError(BETA_ERROR_CODES.SUSPENDED, SUSPENDED_MESSAGE, {}),
    }
  }

  if (quota.plan_type === 'admin') {
    return { allowed: true, maxSessionMinutes: Infinity }
  }

  // Daily MINUTE gate. Live caption sessions don't increment billable_minutes
  // themselves (they record with billable_minutes=0), but we still refuse to
  // start one when the user has already exhausted their daily budget on
  // processed recordings — the experience would be a tease otherwise.
  const dailyMinutesUsed = await getDailyMinutesUsed(userId)
  const dailyMinutesLimitRaw = planLimit(quota, 'daily_minutes_limit')
  const dailyMinutesLimit = dailyMinutesLimitRaw == null ? Infinity : Number(dailyMinutesLimitRaw)
  if (dailyMinutesUsed >= dailyMinutesLimit) {
    return {
      allowed: false,
      status: 429,
      body: betaError(
        BETA_ERROR_CODES.DAILY_MINUTES_LIMIT_REACHED,
        `Daily minute limit reached (${dailyMinutesLimit} min/day on this plan).`,
        { used_minutes_today: Math.round(dailyMinutesUsed), limit_minutes_today: dailyMinutesLimit },
      ),
    }
  }

  // Check if quota is already exhausted (block live session start if so)
  let usedMinutes = 0
  let limitMinutes = Infinity

  if (LIFETIME_PLANS.has(quota.plan_type)) {
    usedMinutes = await getBillableMinutesUsed(userId)
    limitMinutes = quota.total_trial_minutes_limit + (quota.extra_minutes_balance || 0)
  } else if (MONTHLY_PLANS.has(quota.plan_type)) {
    const now = new Date()
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ).toISOString()
    usedMinutes = await getBillableMinutesUsed(userId, { sinceIso: monthStart })
    limitMinutes = Number(planLimit(quota, 'monthly_minutes_limit') ?? Infinity) + (quota.extra_minutes_balance || 0)
  }

  if (usedMinutes >= limitMinutes) {
    return {
      allowed: false,
      status: 403,
      body: betaError(
        BETA_ERROR_CODES.BETA_LIMIT_REACHED,
        BETA_LIMIT_MESSAGE,
        { used_minutes: Math.round(usedMinutes), limit_minutes: limitMinutes },
      ),
    }
  }

  return {
    allowed: true,
    maxSessionMinutes: planLimit(quota, 'max_live_session_minutes') ?? DEFAULT_MAX_LIVE_SESSION_MINUTES,
  }
}

/**
 * Check whether a direct hosted AI action is allowed.
 * This protects endpoints such as /api/transcribe and /api/summarize where
 * there may be no trusted recording duration yet.
 */
export async function checkHostedActionAllowed(quota, userId) {
  if (!quota) {
    return {
      allowed: false,
      status: 503,
      body: betaError(BETA_ERROR_CODES.QUOTA_REQUIRED, 'Beta quota is temporarily unavailable.', {}),
    }
  }

  if (quota.status === 'suspended') {
    return {
      allowed: false,
      status: 403,
      body: betaError(BETA_ERROR_CODES.SUSPENDED, SUSPENDED_MESSAGE, {}),
    }
  }

  if (quota.plan_type === 'admin') return { allowed: true }

  const todayCount = await getDailyRecordingCount(userId)
  const maxProcessingJobsPerDay = Number(
    planLimit(quota, 'max_processing_jobs_per_day') ??
      planLimit(quota, 'max_recordings_per_day') ??
      PUBLIC_TRIAL_MAX_PROCESSING_JOBS_PER_DAY,
  )
  if (todayCount >= maxProcessingJobsPerDay) {
    return {
      allowed: false,
      status: 429,
      body: betaError(
        BETA_ERROR_CODES.DAILY_LIMIT_REACHED,
        `Daily limit reached. You can process up to ${maxProcessingJobsPerDay} lectures per day on this plan.`,
        { used_today: todayCount, limit_today: maxProcessingJobsPerDay },
      ),
    }
  }

  // Daily MINUTE gate. Hosted actions (transcribe/summarize) record with
  // billable_minutes=0 today, so they never increment the daily counter, but
  // we still refuse to run them when the user has already exhausted their
  // daily budget on processed recordings — same rationale as live sessions.
  const dailyMinutesUsed = await getDailyMinutesUsed(userId)
  const dailyMinutesLimitRaw = planLimit(quota, 'daily_minutes_limit')
  const dailyMinutesLimit = dailyMinutesLimitRaw == null ? Infinity : Number(dailyMinutesLimitRaw)
  if (dailyMinutesUsed >= dailyMinutesLimit) {
    return {
      allowed: false,
      status: 429,
      body: betaError(
        BETA_ERROR_CODES.DAILY_MINUTES_LIMIT_REACHED,
        `Daily minute limit reached (${dailyMinutesLimit} min/day on this plan).`,
        { used_minutes_today: Math.round(dailyMinutesUsed), limit_minutes_today: dailyMinutesLimit },
      ),
    }
  }

  let usedMinutes = 0
  let limitMinutes = Infinity
  if (LIFETIME_PLANS.has(quota.plan_type)) {
    usedMinutes = await getBillableMinutesUsed(userId)
    limitMinutes = quota.total_trial_minutes_limit + (quota.extra_minutes_balance || 0)
  } else if (MONTHLY_PLANS.has(quota.plan_type)) {
    const now = new Date()
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ).toISOString()
    usedMinutes = await getBillableMinutesUsed(userId, { sinceIso: monthStart })
    limitMinutes = Number(planLimit(quota, 'monthly_minutes_limit') ?? Infinity) + (quota.extra_minutes_balance || 0)
  }

  if (usedMinutes >= limitMinutes) {
    return {
      allowed: false,
      status: 403,
      body: betaError(
        BETA_ERROR_CODES.BETA_LIMIT_REACHED,
        BETA_LIMIT_MESSAGE,
        { used_minutes: Math.round(usedMinutes), limit_minutes: limitMinutes },
      ),
    }
  }

  return { allowed: true }
}

// ── Usage recording ────────────────────────────────────────────────────────────

/**
 * Record a beta usage event. Best-effort — never throws.
 * @param {string} userId
 * @param {string} email
 * @param {string|null} recordingUuid  Real public.recordings.id UUID, or null when no recording exists.
 * @param {string} actionType
 * @param {number} durationSec
 */
export async function recordBetaUsage(userId, email, recordingUuid, actionType, durationSec = 0) {
  const db = getAdminClient()
  if (!db) return
  const BILLABLE_ACTIONS = new Set(['process_recording', 'regenerate_summary'])
  const billableMinutes = BILLABLE_ACTIONS.has(actionType)
    ? Math.ceil((durationSec || 0) / 60)
    : 0
  try {
    const { error } = await db.from('beta_usage').insert({
      user_id: userId,
      email: (email || '').toLowerCase(),
      recording_id: recordingUuid || null,
      action_type: actionType,
      duration_sec: Math.round(durationSec) || 0,
      billable_minutes: billableMinutes,
    })
    if (error) {
      console.warn(
        '[betaGate] recordBetaUsage error',
        JSON.stringify({ error: error.message, actionType, userIdPrefix: userId.slice(0, 8) }),
      )
    }
  } catch (e) {
    console.warn('[betaGate] recordBetaUsage threw', e?.message)
  }
}

const PROCESSING_BILLABLE_ACTIONS = ['process_recording', 'regenerate_summary']

export function processingUsageIdempotencyKey(userId, recordingUuid) {
  return `process-recording:${userId}:${recordingUuid}`
}

/**
 * Historical processing rows predate idempotency_key, so recovery checks the
 * durable recording/action identity too. An unavailable ledger is a hard
 * failure: proceeding would risk charging the same recording twice.
 */
export async function hasRecordedProcessingUsage(userId, recordingUuid) {
  const db = getAdminClient()
  if (!db) throw new Error('Usage ledger is unavailable.')
  const { data, error } = await db
    .from('beta_usage')
    .select('id')
    .eq('user_id', userId)
    .eq('recording_id', recordingUuid)
    .in('action_type', PROCESSING_BILLABLE_ACTIONS)
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Could not inspect processing usage: ${error.message}`)
  return Boolean(data?.id)
}

/**
 * Exactly-once initial processing usage. The database's unique index
 * on idempotency_key is the durable authority across retries and instances.
 */
export async function recordProcessingUsageOnce(userId, email, recordingUuid, durationSec = 0) {
  const db = getAdminClient()
  if (!db) throw new Error('Usage ledger is unavailable.')
  const billableMinutes = Math.ceil((durationSec || 0) / 60)
  const idempotencyKey = processingUsageIdempotencyKey(userId, recordingUuid)
  const { error } = await db.from('beta_usage').upsert({
    user_id: userId,
    email: (email || '').toLowerCase(),
    recording_id: recordingUuid,
    action_type: 'process_recording',
    duration_sec: Math.round(durationSec) || 0,
    billable_minutes: billableMinutes,
    idempotency_key: idempotencyKey,
  }, {
    onConflict: 'idempotency_key',
    ignoreDuplicates: true,
  })
  if (error) throw new Error(`Could not persist processing usage: ${error.message}`)
  return { idempotencyKey, billableMinutes }
}
