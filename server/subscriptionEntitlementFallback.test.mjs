import { describe, expect, it } from 'vitest'

import { getActiveEntitlement } from './iapEntitlements.mjs'

const LEGACY_ROW = {
  product_id: 'com.aydenz.youmilensipad.studentbasic30d',
  plan_type: 'student_pass',
  starts_at: '2026-06-11T03:04:18.000Z',
  expires_at: '2026-07-11T03:04:18.000Z',
  status: 'active',
  revoked_at: null,
}

const NOW = '2026-06-11T04:00:00.000Z'

/** A db whose subscription-state lookup succeeds with `subscriptionRows`. */
function dbWithSubscription(subscriptionRows) {
  const legacyQuery = {
    select() { return this },
    eq() { return this },
    lte() { return this },
    gt() { return this },
    is() { return this },
    order() { return this },
    limit() { return this },
    async maybeSingle() { return { data: LEGACY_ROW, error: null } },
  }
  const subscriptionQuery = {
    select() { return this },
    eq() { return this },
    order() { return this },
    limit() { return this },
    then(onFulfilled) {
      return Promise.resolve({ data: subscriptionRows, error: null }).then(onFulfilled)
    },
  }
  return {
    from(table) {
      if (table === 'app_store_subscription_states') return subscriptionQuery
      if (table === 'app_store_subscription_bindings') return {
        select() { return this }, eq() { return this },
        async maybeSingle() { return { data: { user_id: 'user-1', owner_state: 'active', environment: 'Sandbox' }, error: null } },
      }
      return legacyQuery
    },
  }
}

/** A db whose subscription-state lookup throws (schema drift / transient DB error). */
function dbWithSubscriptionFailure() {
  const legacyQuery = {
    select() { return this },
    eq() { return this },
    lte() { return this },
    gt() { return this },
    is() { return this },
    order() { return this },
    limit() { return this },
    async maybeSingle() { return { data: LEGACY_ROW, error: null } },
  }
  return {
    from(table) {
      if (table === 'app_store_subscription_states') {
        throw new Error('relation "app_store_subscription_states" does not exist')
      }
      return legacyQuery
    },
  }
}

describe('subscription entitlement fallback (quota status invariant)', () => {
  it('Q1/Q5: zero subscription rows → falls through to legacy, no exception', async () => {
    const db = dbWithSubscription([])
    await expect(getActiveEntitlement(db, 'user-1', NOW)).resolves.toEqual(LEGACY_ROW)
  })

  it('Q6: subscription lookup errors → falls back to legacy, no exception', async () => {
    const db = dbWithSubscriptionFailure()
    await expect(getActiveEntitlement(db, 'user-1', NOW)).resolves.toEqual(LEGACY_ROW)
  })

  it('Q2: an active subscription resolves to the Student entitlement', async () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    const db = dbWithSubscription([
      {
        product_id: 'com.aydenz.youmilensipad.student.monthly',
        original_transaction_id: 'orig-1',
        latest_transaction_id: 'tx-1',
        subscription_group_id: '22109238',
        environment: 'Sandbox',
        purchased_at: '2026-06-01T00:00:00.000Z',
        expires_at: future,
        auto_renew_status: true,
        status: 'active',
        revocation_at: null,
        last_verified_at: '2026-06-01T00:00:00.000Z',
      },
    ])
    const result = await getActiveEntitlement(db, 'user-1', NOW)
    expect(result.plan_type).toBe('student_pass')
    expect(result.product_id).toBe('com.aydenz.youmilensipad.student.monthly')
  })

  it('Q3: an expired subscription does not grant active entitlement (falls through)', async () => {
    const db = dbWithSubscription([
      {
        product_id: 'com.aydenz.youmilensipad.student.monthly',
        original_transaction_id: 'orig-1',
        latest_transaction_id: 'tx-1',
        environment: 'Sandbox',
        purchased_at: '2026-05-01T00:00:00.000Z',
        expires_at: '2026-05-31T00:00:00.000Z',
        auto_renew_status: false,
        status: 'expired',
        revocation_at: null,
        last_verified_at: '2026-05-01T00:00:00.000Z',
      },
    ])
    const result = await getActiveEntitlement(db, 'user-1', NOW)
    expect(result).toEqual(LEGACY_ROW)
  })
})
