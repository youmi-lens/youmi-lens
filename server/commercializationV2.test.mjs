import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(new URL('../supabase-migration-commercialization-v2-subscriptions.sql', import.meta.url), 'utf8')
const rollback = readFileSync(new URL('../supabase-rollback-commercialization-v2-subscriptions.sql', import.meta.url), 'utf8')
const routes = readFileSync(new URL('./iapRoutes.mjs', import.meta.url), 'utf8')
const apple = readFileSync(new URL('./iapApple.mjs', import.meta.url), 'utf8')

describe('Commercialization V2 migration', () => {
  it('adds both frozen products without deleting legacy products', () => {
    expect(migration).toContain('com.aydenz.youmilensipad.student.monthly')
    expect(migration).toContain('com.aydenz.youmilensipad.student.annual')
    expect(migration).not.toMatch(/DELETE FROM public\.user_entitlements/i)
    expect(migration).not.toMatch(/DROP TABLE.*apple_iap_transactions/i)
  })

  it('models every required subscription state and ownership binding', () => {
    for (const state of ['active', 'expired', 'grace_period', 'billing_retry', 'revoked', 'refunded', 'cancelled_but_active_until_expiry', 'verification_pending', 'unknown']) {
      expect(migration).toContain(`'${state}'`)
    }
    expect(migration).toContain('app_store_subscription_bindings')
    expect(migration).toContain('original_transaction_id text PRIMARY KEY')
    expect(migration).toContain('app_account_token')
  })

  it('enables RLS and exposes only own state to authenticated users', () => {
    expect(migration).toContain('app_store_subscription_states ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('TO authenticated')
    expect(migration).toContain('(SELECT auth.uid()) = user_id')
    expect(migration).toContain('REVOKE ALL ON public.app_store_subscription_bindings')
  })

  it('ships a guarded rollback', () => {
    expect(rollback).toContain('Refusing rollback')
    expect(rollback).toContain('app_store_subscription_states contains data')
  })
})

describe('Commercialization V2 verification and notification wiring', () => {
  it('uses Apple JWS verification and normalized subscription persistence', () => {
    expect(routes).toContain('verifyAppleTransaction(payload)')
    expect(routes).toContain('verifyAndPersistSubscription')
    expect(apple).toContain('verifyAndDecodeTransaction')
    expect(apple).toContain('verifyAndDecodeRenewalInfo')
  })

  it('handles notification renewal state and legacy refund separately', () => {
    expect(routes).toContain("source: 'notification_v2'")
    expect(routes).toContain('NotificationTypeV2.DID_RENEW')
    expect(routes).toContain('NotificationTypeV2.DID_FAIL_TO_RENEW')
    expect(routes).toContain('NotificationTypeV2.EXPIRED')
    expect(routes).toContain('NotificationTypeV2.PRICE_INCREASE')
    expect(routes).toContain('NotificationTypeV2.REFUND')
    expect(routes).toContain('NotificationTypeV2.REVOKE')
    expect(routes).toContain('!tx.autoRenewable')
  })

  it('keeps sales admission gated independently from verified delivery', () => {
    expect(routes).toContain('authorize_subscription_purchase')
    expect(routes).toContain('subscription_sales_closed')
    expect(routes).not.toContain('shouldBlockSubscriptionGrant')
    expect(migration).toContain("is_purchasable = false")
  })

  it('does not mutate legacy Student Basic / Student Pass product rows', () => {
    expect(migration).not.toMatch(/UPDATE[\s\S]*studentbasic30d/i)
    expect(migration).not.toMatch(/UPDATE[\s\S]*studentpass30d/i)
    expect(migration).not.toMatch(/DELETE FROM public\.billing_products/i)
  })
})
