import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Quota TIER and subscription OWNERSHIP are independent dimensions.
 *
 * An admin who also holds a real paid subscription must keep admin access
 * (unlimited, admin precedence untouched) AND still be reported as owning
 * that subscription. Before this fix, getEffectiveQuota returned early for
 * admin, so `_entitlement` was dropped, buildQuotaStatus computed
 * studentPassActive = Boolean(quota._entitlement) = false, and the iPad
 * Plans screen showed no Student Basic at all for a genuinely active
 * subscription. That is the production incident this suite locks down.
 */

vi.hoisted(() => {
  process.env.SUPABASE_URL = 'https://stub.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-stub'
})

const { state } = vi.hoisted(() => ({
  state: { quotaRow: null, entitlement: null, entitlementThrows: false, lastLookupUserId: undefined },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: state.quotaRow, error: null }) }),
        // billing_products lookup used by loadStudentPassPurchaseAvailability
        in: async () => ({ data: [], error: null }),
        order: () => ({ limit: async () => ({ data: [], error: null }) }),
      }),
    }),
  }),
}))

// Partial mock: only getActiveEntitlement is controlled. isEntitlementActive and
// resolveEffectivePlanType stay REAL, so admin precedence is exercised for real.
vi.mock('./iapEntitlements.mjs', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getActiveEntitlement: async (_db, userId) => {
      state.lastLookupUserId = userId
      if (state.entitlementThrows) throw new Error('lookup failed')
      return state.entitlement
    },
  }
})

const { getEffectiveQuota } = await import('./betaGate.mjs')
const { buildQuotaStatus } = await import('./betaUsageStatus.mjs')

const USER = '00000000-0000-4000-8000-00000000abcd'
const ANNUAL = 'com.aydenz.youmilensipad.student.annual'
const MONTHLY = 'com.aydenz.youmilensipad.student.monthly'

const FUTURE = new Date(Date.now() + 86_400_000).toISOString()
const PAST = new Date(Date.now() - 86_400_000).toISOString()
const STARTED = new Date(Date.now() - 3_600_000).toISOString()

const quota = (planType) => ({ user_id: USER, plan_type: planType, status: 'active', extra_minutes_balance: 0 })
const subEntitlement = (productId, { starts = STARTED, expires = FUTURE, status = 'active', revoked = null } = {}) => ({
  product_id: productId,
  plan_type: 'student_pass',
  starts_at: starts,
  expires_at: expires,
  status,
  revoked_at: revoked,
  source: 'app_store_subscription',
})

beforeEach(() => {
  state.quotaRow = null
  state.entitlement = null
  state.entitlementThrows = false
})

describe('Q1-Q10: admin tier and subscription ownership resolve independently', () => {
  it('Q1: admin + active Monthly -> plan stays admin, subscription still reported', async () => {
    state.quotaRow = quota('admin')
    state.entitlement = subEntitlement(MONTHLY)
    const q = await getEffectiveQuota(USER)
    expect(q.plan_type).toBe('admin')
    expect(q._entitlement?.product_id).toBe(MONTHLY)
  })

  it('Q2: admin + active Annual -> plan stays admin, subscription still reported', async () => {
    state.quotaRow = quota('admin')
    state.entitlement = subEntitlement(ANNUAL)
    const q = await getEffectiveQuota(USER)
    expect(q.plan_type).toBe('admin')
    expect(q._entitlement?.product_id).toBe(ANNUAL)
    expect(q._entitlement?.expires_at).toBe(FUTURE)
  })

  it('Q3: admin + no subscription -> admin, nothing attached', async () => {
    state.quotaRow = quota('admin')
    state.entitlement = null
    const q = await getEffectiveQuota(USER)
    expect(q.plan_type).toBe('admin')
    expect(q._entitlement ?? null).toBeNull()
  })

  it('Q4: public_trial + active subscription -> upgraded to student_pass (unchanged behavior)', async () => {
    state.quotaRow = quota('public_trial')
    state.entitlement = subEntitlement(ANNUAL)
    const q = await getEffectiveQuota(USER)
    expect(q.plan_type).toBe('student_pass')
    expect(q._entitlement?.product_id).toBe(ANNUAL)
  })

  it('Q5: public_trial + no subscription -> unchanged Free behavior', async () => {
    state.quotaRow = quota('public_trial')
    state.entitlement = null
    const q = await getEffectiveQuota(USER)
    expect(q.plan_type).toBe('public_trial')
    expect(q._entitlement ?? null).toBeNull()
  })

  it('Q6: core_tester + no subscription -> unchanged', async () => {
    state.quotaRow = quota('core_tester')
    state.entitlement = null
    const q = await getEffectiveQuota(USER)
    expect(q.plan_type).toBe('core_tester')
    expect(q._entitlement ?? null).toBeNull()
  })

  it('Q7: ordinary student subscriber -> unchanged', async () => {
    state.quotaRow = quota('public_trial')
    state.entitlement = subEntitlement(MONTHLY)
    const q = await getEffectiveQuota(USER)
    expect(q.plan_type).toBe('student_pass')
    expect(q._entitlement?.product_id).toBe(MONTHLY)
  })

  it('Q8: admin + EXPIRED subscription -> admin, nothing attached', async () => {
    state.quotaRow = quota('admin')
    state.entitlement = subEntitlement(ANNUAL, { starts: PAST, expires: PAST })
    const q = await getEffectiveQuota(USER)
    expect(q.plan_type).toBe('admin')
    expect(q._entitlement ?? null).toBeNull()
  })

  it('Q8b: admin + REVOKED subscription -> admin, nothing attached', async () => {
    state.quotaRow = quota('admin')
    state.entitlement = subEntitlement(ANNUAL, { revoked: PAST })
    const q = await getEffectiveQuota(USER)
    expect(q.plan_type).toBe('admin')
    expect(q._entitlement ?? null).toBeNull()
  })

  it('Q9/Q10: ownership isolation — the resolver only ever sees this user\'s own entitlement', async () => {
    // getActiveEntitlement is queried BY userId (getEffectiveSubscription filters
    // .eq('user_id', userId), and the legacy fallback does the same), so a
    // foreign or unbound subscription surfaces as null here and is never attached.
    state.quotaRow = quota('admin')
    state.entitlement = null
    const q = await getEffectiveQuota(USER)
    expect(q._entitlement ?? null).toBeNull()
    // The entitlement lookup must be scoped to the REQUESTING user — this is
    // what makes a foreign/unbound subscription unreachable from here.
    expect(state.lastLookupUserId).toBe(USER)

    // A lookup failure must fall back to the stored plan, never over-grant.
    state.entitlementThrows = true
    const failed = await getEffectiveQuota(USER)
    expect(failed.plan_type).toBe('admin')
    expect(failed._entitlement ?? null).toBeNull()
  })
})

describe('API contract: buildQuotaStatus output', () => {
  it('ADMIN + ACTIVE ANNUAL -> admin plan, unlimited access, and studentPassActive=true', async () => {
    state.quotaRow = quota('admin')
    state.entitlement = subEntitlement(ANNUAL)
    const status = await buildQuotaStatus(USER)
    expect(status.effectivePlanType).toBe('admin')
    expect(status.planType).toBe('admin')
    expect(status.unlimited).toBe(true) // admin quota values unchanged
    expect(status.studentPassActive).toBe(true)
    expect(status.studentPassExpiry).toBe(FUTURE)
    expect(status.entitlement.active).toBe(true)
    expect(status.entitlement.productId).toBe(ANNUAL)
    expect(status.entitlement.expiresAt).toBe(FUTURE)
  })

  it('quota DTO preserves signed cancellation/renewal information and never infers null',async()=>{
    state.quotaRow=quota('admin')
    state.entitlement={...subEntitlement(ANNUAL),status:'cancelled_but_active_until_expiry',auto_renew_status:false}
    const cancelled=await buildQuotaStatus(USER)
    expect(cancelled.entitlement.status).toBe('cancelled_but_active_until_expiry')
    expect(cancelled.entitlement.autoRenewStatus).toBe(false)
    expect(cancelled.entitlement.active).toBe(true)
    state.entitlement={...subEntitlement(ANNUAL),auto_renew_status:true}
    expect((await buildQuotaStatus(USER)).entitlement.autoRenewStatus).toBe(true)
    state.entitlement={...subEntitlement(ANNUAL),auto_renew_status:null}
    expect((await buildQuotaStatus(USER)).entitlement.autoRenewStatus).toBeNull()
  })

  it('ADMIN + NO SUBSCRIPTION -> admin, unlimited, studentPassActive=false', async () => {
    state.quotaRow = quota('admin')
    state.entitlement = null
    const status = await buildQuotaStatus(USER)
    expect(status.effectivePlanType).toBe('admin')
    expect(status.unlimited).toBe(true)
    expect(status.studentPassActive).toBe(false)
    expect(status.entitlement.active).toBe(false)
  })
})
