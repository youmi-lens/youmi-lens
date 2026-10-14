import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NotificationTypeV2 } from '@apple/app-store-server-library'
import { PLAN_LIMITS } from './betaGate.mjs'
import { billingEventTypeForRevokingNotification } from './iapRoutes.mjs'

function read(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

describe('Student Pass quota defaults', () => {
  it('uses the limited server-side Student Access defaults', () => {
    expect(PLAN_LIMITS.public_trial).toMatchObject({
      monthly_minutes_limit: 300,
      daily_minutes_limit: 120,
      max_recording_minutes: 60,
      max_live_session_minutes: 60,
      max_recordings_per_day: 2,
      max_processing_jobs_per_day: 2,
    })
  })

  it('uses the locked server-side Student Pass defaults', () => {
    expect(PLAN_LIMITS.student_pass).toMatchObject({
      monthly_minutes_limit: 600,
      daily_minutes_limit: 120,
      max_recording_minutes: 90,
      max_live_session_minutes: 90,
      max_recordings_per_day: 6,
      max_processing_jobs_per_day: 10,
    })
  })

  it('keeps new Student Basic sales disabled in the consumable migration', () => {
    const migration = read('../supabase-migration-student-basic-consumable.sql')
    expect(migration).toContain("'com.aydenz.youmilensipad.studentbasic30d'")
    expect(migration).toMatch(/'Student Basic – 30 Days',\s*false,\s*NULL/)
    expect(migration).toMatch(/SET is_purchasable = false,[\s\S]*studentpass30d'/)
    expect(migration).toContain("CHECK (kind IN ('non_renewing', 'consumable'))")
    expect(migration).toContain('grant_consumable_entitlement')
    expect(migration).toContain('pg_advisory_xact_lock')
    expect(migration).toContain('WHERE source_transaction_id = p_source_transaction_id')
    expect(migration).toContain('greatest(')
  })
})

describe('App Store notification behavior', () => {
  it('maps refund and revoke notifications to billing events', () => {
    expect(billingEventTypeForRevokingNotification(NotificationTypeV2.REFUND)).toBe('refund')
    expect(billingEventTypeForRevokingNotification(NotificationTypeV2.REVOKE)).toBe('revoke')
  })
})

describe('Phase 2 active path guarantees', () => {
  it('account deletion no longer references app_store_subscriptions', () => {
    const source = read('./accountRoutes.mjs')
    expect(source).not.toContain("'app_store_subscriptions'")
    expect(source).not.toContain('"app_store_subscriptions"')
  })

  it('account deletion marks Apple transactions instead of deleting history', () => {
    const source = read('./accountRoutes.mjs')
    const ledger = read('./iapLedger.mjs')
    expect(source).toContain('prepareAppleIapLedgerForAccountDeletion')
    expect(ledger).toContain("owner_state: 'account_deleted'")
    expect(source).not.toMatch(/deleteRows\(db,\s*['"]apple_iap_transactions/)
  })

  it('account deletion preflights Stripe so renewing subscriptions cannot outlive the user', () => {
    const source = read('./accountRoutes.mjs')
    expect(source).toContain('preflightStripeAccountDeletion')
    expect(source).toContain('stripeSubscriptionBlocksAccountDeletion')
    expect(source).toContain('active_subscription')
  })

  it('/api/live-transcribe-url uses effective quota gates and usage accounting', () => {
    const source = read('./liveTranscribeFromUrl.mjs')
    expect(source).toContain('getEffectiveQuota')
    expect(source).toContain('checkLiveSessionAllowed')
    expect(source).toContain('recordBetaUsage')
  })

  it('/api/beta-usage-status resolves effective quota instead of stored plan only', () => {
    const source = read('./betaUsageStatus.mjs')
    expect(source).toContain('getEffectiveQuota(user.userId, user.email)')
    expect(source).not.toContain('const quota = await getOrCreateUserQuota(user.userId, user.email)')
  })

  it('/api/iap/entitlement returns safe inactive Student Pass status', () => {
    const source = read('./iapRoutes.mjs')
    expect(source).toContain('getLatestStudentPassEntitlement(db, user.userId)')
    expect(source).toContain("status: 'none'")
    expect(source).toContain('latestEntitlement: safeEntitlementSnapshot(latestEntitlement)')
    expect(source).toContain('currentEntitlement: null')
    expect(source).not.toContain('linked to a deleted Youmi Lens account')
  })
})
