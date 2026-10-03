import { createSubscriptionDatabase } from './subscriptionDatabaseHarness.mjs'
const engines = []
afterEach(async () => { for (const db of engines.splice(0)) await db.pg.close() })
import { afterEach, describe, expect, it } from 'vitest'
import { NotificationTypeV2, Subtype } from '@apple/app-store-server-library'
import {
  deriveSubscriptionStatus,
  assertSubscriptionIdentity,
  subscriptionStatusIsActive,
  shouldBlockSubscriptionGrant,
  safeSubscriptionEntitlement,
  SubscriptionAccountTokenError,
  SubscriptionAlreadyLinkedError,
  isAutoRenewableProduct,
  isAnonymousUser,
  upsertSubscriptionState,
  listSubscriptionStateUserIds,
  findSubscriptionState,
  verifyAndPersistSubscription,
  getEffectiveSubscription,
} from './iapSubscriptions.mjs'

async function claimSubscriptionBinding(db, userId, verified, options) {
  await verifyAndPersistSubscription(db, userId, verified, options)
  return db._tables.app_store_subscription_bindings.find(b => b.original_transaction_id === verified.originalTransactionId)
}

// ── Minimal in-memory fake db for the two tables these functions touch ──────
// Only implements the exact chains iapSubscriptions.mjs actually calls
// (select/eq/eq/maybeSingle, insert, update/eq/eq, upsert, auth.admin.getUserById).
function makeFakeDb({ bindings = [], states = [], anonymousUserIds = new Set() } = {}) {
  let enginePromise
  const tables = {
    app_store_subscription_bindings: [...bindings],
    app_store_subscription_states: [...states],
  }
  function query(table) {
    let rows = tables[table] ?? (table === 'subscription_test_chain_policy' ? tables.app_store_subscription_states : [])
    const filters = []
    const builder = {
      select: () => builder,
      order: () => builder,
      limit: () => builder,
      eq(col, val) { filters.push([col, val]); return builder },
      async maybeSingle() {
        const match = rows.find((r) => filters.every(([c, v]) => r[c] === v))
        return { data: match ? { ...match } : null, error: null }
      },
      then(resolve) {
        // Awaited directly (no maybeSingle) — used by listSubscriptionStateUserIds.
        const matched = rows.filter((r) => filters.every(([c, v]) => r[c] === v))
        return Promise.resolve({ data: matched, error: null }).then(resolve)
      },
    }
    return builder
  }
  return {
    async rpc(name, args) {
      if (!enginePromise) enginePromise = createSubscriptionDatabase({bindings: tables.app_store_subscription_bindings, states: tables.app_store_subscription_states, anonymousUserIds}).then(db => {engines.push(db); return db})
      const engine = await enginePromise
      await engine.pg.query('insert into auth.users values($1,$2) on conflict do nothing',[engine.uuid(args.p_user_id), anonymousUserIds.has(args.p_user_id)])
      if (args.p_transaction.environment && args.p_transaction.environment !== 'Production') {
        await engine.pg.query('insert into public.subscription_test_chain_policy values($1,$2,$3,$4,now()) on conflict do nothing',[engine.uuid(args.p_user_id), args.p_transaction.originalTransactionId,args.p_transaction.environment,'Test fixture policy'])
      }
      const result = await engine.rpc(name,args)
      const snapshot = await engine.snapshots()
      tables.app_store_subscription_bindings.splice(0, tables.app_store_subscription_bindings.length, ...snapshot.bindings)
      tables.app_store_subscription_states.splice(0, tables.app_store_subscription_states.length, ...snapshot.states)
      return result
    },
    from(table) {
      return {
        select: (...args) => query(table).select(...args),
        async insert(row) {
          const rows = tables[table]
          const pkCols = table === 'app_store_subscription_bindings' ? ['original_transaction_id'] : ['original_transaction_id', 'user_id']
          if (rows.some((r) => pkCols.every((c) => r[c] === row[c]))) return { error: { code: '23505' } }
          rows.push({ ...row })
          return { error: null }
        },
        update(patch) {
          const filters = []
          const b = {
            eq(col, val) { filters.push([col, val]); return b },
            select: () => b,
            async maybeSingle() {
              const match = tables[table].find((r) => filters.every(([c, v]) => r[c] === v))
              if (match) Object.assign(match, patch)
              return { data: match ? { ...match } : null, error: null }
            },
          }
          return b
        },
        async upsert(row, { onConflict } = {}) {
          const rows = tables[table]
          const keyCols = (onConflict || 'original_transaction_id').split(',')
          const idx = rows.findIndex((r) => keyCols.every((c) => r[c] === row[c]))
          if (idx >= 0) rows[idx] = { ...rows[idx], ...row }
          else rows.push({ ...row })
          return { error: null }
        },
      }
    },
    auth: {
      admin: {
        async getUserById(id) {
          return { data: { user: { id, is_anonymous: anonymousUserIds.has(id) } }, error: null }
        },
      },
    },
    _tables: tables,
  }
}

const future = Date.now() + 86_400_000
const past = Date.now() - 86_400_000
const tx = (overrides = {}) => ({
  originalTransactionId: 'orig-1',
  appAccountToken: '00000000-0000-4000-8000-000000000000',
  expiresDateMs: future,
  revoked: false,
  ...overrides,
})

const monthlyProduct = {
  product_id: 'com.aydenz.youmilensipad.student.monthly',
  kind: 'auto_renewable',
  is_purchasable: false,
}

describe('subscription status model', () => {
  it('maps active and cancelled-but-active states', () => {
    expect(deriveSubscriptionStatus({ transaction: tx() })).toBe('active')
    expect(deriveSubscriptionStatus({ transaction: tx(), renewal: { autoRenewStatus: false } })).toBe('cancelled_but_active_until_expiry')
  })

  it('maps expired, revoked, and refunded states', () => {
    expect(deriveSubscriptionStatus({ transaction: tx({ expiresDateMs: past }) })).toBe('expired')
    expect(deriveSubscriptionStatus({ transaction: tx({ revoked: true }) })).toBe('revoked')
    expect(deriveSubscriptionStatus({ transaction: tx(), notificationType: NotificationTypeV2.REFUND })).toBe('refunded')
    expect(deriveSubscriptionStatus({ transaction: tx(), notificationType: NotificationTypeV2.REVOKE })).toBe('revoked')
    expect(deriveSubscriptionStatus({ transaction: tx(), notificationType: NotificationTypeV2.EXPIRED })).toBe('expired')
  })

  it('maps grace period and billing retry notification paths', () => {
    expect(deriveSubscriptionStatus({
      transaction: tx({ expiresDateMs: past }),
      renewal: { gracePeriodExpiresDate: new Date(future).toISOString() },
      notificationType: NotificationTypeV2.DID_FAIL_TO_RENEW,
      subtype: Subtype.GRACE_PERIOD,
    })).toBe('grace_period')
    expect(deriveSubscriptionStatus({
      transaction: tx({ expiresDateMs: past }),
      renewal: { isInBillingRetryPeriod: true },
      notificationType: NotificationTypeV2.DID_FAIL_TO_RENEW,
      subtype: Subtype.BILLING_RETRY,
    })).toBe('billing_retry')
    expect(deriveSubscriptionStatus({
      transaction: tx({ expiresDateMs: past }),
      notificationType: NotificationTypeV2.DID_FAIL_TO_RENEW,
    })).toBe('billing_retry')
  })

  it('keeps PRICE_INCREASE and DID_RENEW on date-based active status', () => {
    expect(deriveSubscriptionStatus({
      transaction: tx(),
      notificationType: NotificationTypeV2.PRICE_INCREASE,
      subtype: Subtype.PENDING,
    })).toBe('active')
    expect(deriveSubscriptionStatus({
      transaction: tx(),
      notificationType: NotificationTypeV2.DID_RENEW,
    })).toBe('active')
  })

  it('does not grant billing retry and keeps valid grace active', () => {
    expect(subscriptionStatusIsActive('billing_retry', new Date(future).toISOString())).toBe(false)
    expect(subscriptionStatusIsActive('grace_period', new Date(future).toISOString())).toBe(true)
    expect(subscriptionStatusIsActive('expired', new Date(past).toISOString())).toBe(false)
    expect(subscriptionStatusIsActive('refunded', new Date(future).toISOString())).toBe(false)
    expect(subscriptionStatusIsActive('revoked', new Date(future).toISOString())).toBe(false)
  })
})

describe('verified transaction shape (caller ownership is checked at claim)', () => {
  it('accepts a well-formed verified transaction regardless of who is asking', () => {
    expect(() => assertSubscriptionIdentity(tx())).not.toThrow()
  })

  it('rejects a transaction with no appAccountToken at all (malformed/legacy)', () => {
    expect(() => assertSubscriptionIdentity(tx({ appAccountToken: null }))).toThrow(SubscriptionAccountTokenError)
  })

  it('rejects a transaction missing originalTransactionId', () => {
    expect(() => assertSubscriptionIdentity(tx({ originalTransactionId: null }))).toThrow(/originalTransactionId/)
  })
})

describe('isAnonymousUser', () => {
  it('reads Supabase Auth is_anonymous authoritatively via the admin API, never a stored/client flag', async () => {
    const db = makeFakeDb({ anonymousUserIds: new Set(['guest-x']) })
    expect(await isAnonymousUser(db, 'guest-x')).toBe(true)
    expect(await isAnonymousUser(db, 'permanent-p')).toBe(false)
    expect(await isAnonymousUser(db, null)).toBe(false)
  })
})

describe('claimSubscriptionBinding — canonical PERMANENT ownership only', () => {
  const T = 'orig-cross-device'
  const X = 'guest-x-uuid'
  const Y = 'guest-y-uuid'
  const P = 'permanent-p-uuid'
  const Q = 'permanent-q-uuid'

  it('first permanent claim on an unowned lineage succeeds', async () => {
    const db = makeFakeDb()
    const binding = await claimSubscriptionBinding(db, P, tx({ originalTransactionId: T, appAccountToken: P }))
    expect(binding.user_id).toBe(P)
    expect(db._tables.app_store_subscription_bindings).toHaveLength(1)
  })

  it('the same permanent owner reclaiming is idempotent', async () => {
    const db = makeFakeDb({ bindings: [{ original_transaction_id: T, user_id: P, app_account_token: X, environment: 'Sandbox', owner_state: 'active' }] })
    const binding = await claimSubscriptionBinding(db, P, tx({ originalTransactionId: T, appAccountToken: X, environment: 'Sandbox' }))
    expect(binding.user_id).toBe(P)
  })

  it('a matching permanent token holder may win a conditional legacy anonymous promotion', async () => {
    const db = makeFakeDb({
      bindings: [{ original_transaction_id: T, user_id: Y, app_account_token: X, environment: 'Sandbox', owner_state: 'active' }],
      anonymousUserIds: new Set([Y]),
    })
    const binding = await claimSubscriptionBinding(db, P, tx({ originalTransactionId: T, appAccountToken: P, environment: 'Sandbox' }))
    expect(binding.user_id).toBe(P)
    expect(db._tables.app_store_subscription_bindings[0].user_id).toBe(P)
  })

  it('an UNRELATED permanent account can NEVER take canonical ownership from another permanent account', async () => {
    const db = makeFakeDb({
      bindings: [{ original_transaction_id: T, user_id: P, app_account_token: X, environment: 'Sandbox', owner_state: 'active' }],
      anonymousUserIds: new Set(), // P is permanent, not anonymous
    })
    await expect(claimSubscriptionBinding(db, Q, tx({ originalTransactionId: T, appAccountToken: X, environment: 'Sandbox' })))
      .rejects.toThrow(SubscriptionAlreadyLinkedError)
    expect(db._tables.app_store_subscription_bindings[0].user_id).toBe(P) // unchanged
  })
})

describe('anonymous callers must respect canonical ownership', () => {
  const X = 'guest-x-uuid'
  const Y = 'guest-y-uuid'
  const purchase = () => tx({ appAccountToken: X, originalTransactionId: 'guest-chain', appleExpiresDate: new Date(future).toISOString() })

  it('matching original guest claims one binding and state', async () => {
    const db = makeFakeDb()
    const state = await verifyAndPersistSubscription(db, X, purchase(), { isAnonymous: true })
    expect(state.active).toBe(true)
    expect(db._tables.app_store_subscription_bindings).toHaveLength(1)
    expect(db._tables.app_store_subscription_states).toHaveLength(1)
  })

  it('existing guest owner can restore idempotently', async () => {
    const db = makeFakeDb()
    await verifyAndPersistSubscription(db, X, purchase(), { isAnonymous: true })
    await verifyAndPersistSubscription(db, X, purchase(), { isAnonymous: true })
    expect(db._tables.app_store_subscription_states).toHaveLength(1)
  })

  it('second guest possessing the same history is rejected without a state', async () => {
    const db = makeFakeDb()
    await verifyAndPersistSubscription(db, X, purchase(), { isAnonymous: true })
    await expect(verifyAndPersistSubscription(db, Y, purchase(), { isAnonymous: true })).rejects.toThrow(SubscriptionAlreadyLinkedError)
    expect(db._tables.app_store_subscription_states.map((r) => r.user_id)).toEqual([X])
  })

  it('wrong guest cannot claim an unbound chain', async () => {
    const db = makeFakeDb()
    await expect(verifyAndPersistSubscription(db, Y, purchase(), { isAnonymous: true })).rejects.toThrow(SubscriptionAccountTokenError)
    expect(db._tables.app_store_subscription_bindings).toHaveLength(0)
    expect(db._tables.app_store_subscription_states).toHaveLength(0)
  })
})

describe('listSubscriptionStateUserIds — notification sweep target', () => {
  it('returns every distinct identity holding entitlement for a lineage', async () => {
    const db = makeFakeDb({
      states: [
        { original_transaction_id: 'T', user_id: 'x', status: 'active', purchased_at: '2026-01-01', expires_at: '2026-02-01' },
        { original_transaction_id: 'T', user_id: 'y', status: 'active', purchased_at: '2026-01-01', expires_at: '2026-02-01' },
        { original_transaction_id: 'other', user_id: 'z', status: 'active', purchased_at: '2026-01-01', expires_at: '2026-02-01' },
      ],
    })
    expect((await listSubscriptionStateUserIds(db, 'T')).sort()).toEqual(['x', 'y'])
  })
})

describe('findSubscriptionState — sales kill-switch escape hatch for Guests', () => {
  it('finds a Guests own prior row (bindings never exist for Guests, so this is their only escape hatch)', async () => {
    const db = makeFakeDb({
      states: [{ original_transaction_id: 'T', user_id: 'guest-x', status: 'active', purchased_at: '2026-01-01', expires_at: '2026-02-01' }],
    })
    expect(await findSubscriptionState(db, 'T', 'guest-x')).not.toBeNull()
    expect(await findSubscriptionState(db, 'T', 'someone-else')).toBeNull()
  })
})

describe('production kill switch', () => {
  it('blocks brand-new Production grants while purchasable=false', () => {
    expect(shouldBlockSubscriptionGrant({
      product: monthlyProduct,
      verified: { environment: 'Production' },
      existingBinding: null,
    })).toBe('sales_closed')
  })

  it('allows Sandbox, existing bindings, and open sales', () => {
    expect(shouldBlockSubscriptionGrant({
      product: monthlyProduct,
      verified: { environment: 'Sandbox' },
      existingBinding: null,
    })).toBeNull()
    expect(shouldBlockSubscriptionGrant({
      product: monthlyProduct,
      verified: { environment: 'Production' },
      existingBinding: { original_transaction_id: 'orig-1' },
    })).toBeNull()
    expect(shouldBlockSubscriptionGrant({
      product: { ...monthlyProduct, is_purchasable: true },
      verified: { environment: 'Production' },
      existingBinding: null,
    })).toBeNull()
  })
})

describe('normalized entitlement snapshot', () => {
  it('returns required status fields for an active subscription', () => {
    const snapshot = safeSubscriptionEntitlement({
      active: true,
      status: 'active',
      product_id: 'com.aydenz.youmilensipad.student.monthly',
      environment: 'Sandbox',
      purchased_at: '2026-07-01T00:00:00.000Z',
      expires_at: '2026-08-01T00:00:00.000Z',
      original_transaction_id: 'orig-1',
      latest_transaction_id: 'tx-2',
      subscription_group_id: '22109238',
      auto_renew_status: true,
      revocation_at: null,
      last_verified_at: '2026-07-23T00:00:00.000Z',
    })
    expect(snapshot).toMatchObject({
      active: true,
      status: 'active',
      productId: 'com.aydenz.youmilensipad.student.monthly',
      environment: 'Sandbox',
      expiresAt: '2026-08-01T00:00:00.000Z',
      expirationDate: '2026-08-01T00:00:00.000Z',
      renewalDate: '2026-08-01T00:00:00.000Z',
      subscriptionGroupId: '22109238',
      verificationTimestamp: '2026-07-23T00:00:00.000Z',
    })
  })

  it('clears renewalDate when auto-renew is off and preserves revoked/refunded statuses', () => {
    expect(safeSubscriptionEntitlement({
      active: false,
      status: 'refunded',
      product_id: 'com.aydenz.youmilensipad.student.annual',
      environment: 'Production',
      purchased_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2027-01-01T00:00:00.000Z',
      original_transaction_id: 'orig-9',
      latest_transaction_id: 'tx-9',
      subscription_group_id: '22109238',
      auto_renew_status: false,
      revocation_at: '2026-07-01T00:00:00.000Z',
      last_verified_at: '2026-07-01T00:00:00.000Z',
    })).toMatchObject({
      active: false,
      status: 'refunded',
      renewalDate: null,
      environment: 'Production',
    })
  })
})

// ── Product change inside one Apple subscription group (S5/S6/S7) ────────────
// Apple keeps ONE originalTransactionId across Monthly⇄Annual changes in the
// same group. Ownership must be preserved and the product updated in place —
// an Annual change must never be treated as an unrelated membership.
describe('subscription product change within the same group', () => {
  const OWNER = '11111111-1111-4111-8111-111111111111'
  const ORIGINAL = 'orig-shared-across-group'
  const monthly = tx({ originalTransactionId: ORIGINAL, appAccountToken: OWNER, environment: 'Sandbox' })
  const annual = tx({ originalTransactionId: ORIGINAL, appAccountToken: OWNER, environment: 'Sandbox' })

  it('S5/S6: the same owner keeps identity when switching Monthly ⇄ Annual', () => {
    expect(() => assertSubscriptionIdentity(monthly)).not.toThrow()
    expect(() => assertSubscriptionIdentity(annual)).not.toThrow()
  })

  it('S7: a product change reuses the SAME originalTransactionId', () => {
    // The upsert key is original_transaction_id, so the row is updated in
    // place rather than creating a second, competing subscription.
    expect(annual.originalTransactionId).toBe(monthly.originalTransactionId)
  })

  it('S9: a different PERMANENT Youmi account cannot claim the same Apple subscription (now enforced by claimSubscriptionBinding, not appAccountToken equality)', async () => {
    const db = makeFakeDb({
      bindings: [{ original_transaction_id: ORIGINAL, user_id: OWNER, app_account_token: OWNER, environment: 'Sandbox', owner_state: 'active' }],
    })
    const other = '22222222-2222-4222-8222-222222222222'
    await expect(claimSubscriptionBinding(db, other, annual)).rejects.toThrow(SubscriptionAlreadyLinkedError)
  })

  it('S11: a legacy transaction with no appAccountToken is rejected, not silently accepted', () => {
    const legacy = tx({ originalTransactionId: ORIGINAL, appAccountToken: null })
    expect(() => assertSubscriptionIdentity(legacy)).toThrow(SubscriptionAccountTokenError)
  })

  it('S13: an existing binding keeps a Sandbox/TestFlight change out of the sales kill switch', () => {
    const annualProduct = {
      product_id: 'com.aydenz.youmilensipad.student.annual',
      kind: 'auto_renewable',
      is_purchasable: false,
    }
    // TestFlight is Sandbox — never blocked.
    expect(shouldBlockSubscriptionGrant({
      product: annualProduct,
      verified: { environment: 'Sandbox' },
      existingBinding: null,
    })).toBeNull()
    // ...and an existing owner is never blocked even in Production.
    expect(shouldBlockSubscriptionGrant({
      product: annualProduct,
      verified: { environment: 'Production' },
      existingBinding: { user_id: OWNER },
    })).toBeNull()
  })

  it('unseeded catalog row is what turns Annual into unknown_product', () => {
    // isAutoRenewableProduct is the fork: a missing billing_products row sends
    // an auto-renewable subscription down the legacy path, which rejects it.
    expect(isAutoRenewableProduct(null)).toBe(false)
    expect(isAutoRenewableProduct({
      product_id: 'com.aydenz.youmilensipad.student.annual',
      kind: 'auto_renewable',
    })).toBe(true)
  })
})


describe('permanent ownership and promotion regressions', () => {
  const P = 'permanent-p'
  const Q = 'permanent-q'
  const G = 'legacy-guest'
  const T = 'ownership-chain'
  const purchase = (token = P) => tx({ originalTransactionId: T, appAccountToken: token, environment: 'Production', purchaseDate: new Date(Date.now() - 1000).toISOString(), appleExpiresDate: new Date(future).toISOString() })

  it('A/K: matching first claim and repeated verification have one owner/state', async () => {
    const db = makeFakeDb()
    await verifyAndPersistSubscription(db, P, purchase())
    await verifyAndPersistSubscription(db, P, purchase())
    expect(db._tables.app_store_subscription_bindings.map((r) => r.user_id)).toEqual([P])
    expect(db._tables.app_store_subscription_states.map((r) => r.user_id)).toEqual([P])
  })

  it('B: mismatched first permanent claim creates no binding or state', async () => {
    const db = makeFakeDb()
    await expect(verifyAndPersistSubscription(db, Q, purchase())).rejects.toThrow(SubscriptionAccountTokenError)
    expect(db._tables.app_store_subscription_bindings).toHaveLength(0)
    expect(db._tables.app_store_subscription_states).toHaveLength(0)
  })

  it('C/G: a different permanent user cannot replace the canonical owner', async () => {
    const db = makeFakeDb()
    await verifyAndPersistSubscription(db, P, purchase())
    await expect(verifyAndPersistSubscription(db, Q, purchase(Q))).rejects.toThrow(SubscriptionAlreadyLinkedError)
    expect(db._tables.app_store_subscription_bindings[0].user_id).toBe(P)
    expect(db._tables.app_store_subscription_states.map((r) => r.user_id)).toEqual([P])
  })

  it('E/F/G: concurrent legacy promotion has exactly one winner; losing caller creates no state', async () => {
    const db = makeFakeDb({ bindings: [{ original_transaction_id: T, user_id: G, app_account_token: G, environment: 'Production', owner_state: 'active' }], anonymousUserIds: new Set([G]) })
    const results = await Promise.allSettled([
      verifyAndPersistSubscription(db, P, purchase(P)),
      verifyAndPersistSubscription(db, Q, purchase(Q)),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected')
    expect(rejected.reason).toBeInstanceOf(SubscriptionAlreadyLinkedError)
    const winner = db._tables.app_store_subscription_bindings[0].user_id
    expect(db._tables.app_store_subscription_states.map((r) => r.user_id)).toEqual([winner])
  })

  it('legacy promotion with mismatched token is rejected without changing owner', async () => {
    const db = makeFakeDb({ bindings: [{ original_transaction_id: T, user_id: G, app_account_token: G, environment: 'Production', owner_state: 'active' }], anonymousUserIds: new Set([G]) })
    await expect(verifyAndPersistSubscription(db, P, purchase(G))).rejects.toThrow(SubscriptionAccountTokenError)
    expect(db._tables.app_store_subscription_bindings[0].user_id).toBe(G)
    expect(db._tables.app_store_subscription_states).toHaveLength(0)
  })

  it.each(['revoked', 'refunded'])('J: stale active replay cannot resurrect a %s period', async (terminal) => {
    const db = makeFakeDb()
    const initial = purchase()
    await verifyAndPersistSubscription(db, P, initial)
    await upsertSubscriptionState(db, P, initial, { notificationType: terminal === 'refunded' ? NotificationTypeV2.REFUND : NotificationTypeV2.REVOKE })
    const replayed = await verifyAndPersistSubscription(db, P, initial)
    expect(replayed.active).toBe(false)
    expect(replayed.status).toBe(terminal)
    expect(db._tables.app_store_subscription_states[0].status).toBe(terminal)
  })

  it('L: valid Production transaction passes open monthly gate and persists Apple expiry', async () => {
    const db = makeFakeDb()
    const verified = purchase()
    expect(shouldBlockSubscriptionGrant({ product: { ...monthlyProduct, is_purchasable: true }, verified, existingBinding: null })).toBeNull()
    const state = await verifyAndPersistSubscription(db, P, verified)
    expect(state.active).toBe(true)
    expect(state.expires_at).toBe(verified.appleExpiresDate)
    expect(state.app_account_token).toBe(P)
  })
})


describe('effective access respects canonical ownership', () => {
  const owner = 'canonical-owner'
  const other = 'other-identity'
  const row = (user) => ({ user_id: user, original_transaction_id: 'shared-chain', app_account_token: user, environment: 'Production', status: 'active', expires_at: new Date(future).toISOString() })

  it('preserves canonical owner access and denies historical duplicate rows', async () => {
    const db = makeFakeDb({ bindings: [{ original_transaction_id: 'shared-chain', user_id: owner, environment: 'Production', owner_state: 'active' }], states: [row(owner), row(other)] })
    expect((await getEffectiveSubscription(db, owner)).active).toBe(true)
    expect(await getEffectiveSubscription(db, other)).toBeNull()
  })

  it('unbound legacy states cannot grant access without a canonical owner', async () => {
    const db = makeFakeDb({ states: [row(owner), { ...row(other), app_account_token: owner }] })
    expect(await getEffectiveSubscription(db, owner)).toBeNull()
    expect(await getEffectiveSubscription(db, other)).toBeNull()
  })
})


describe('concurrent first claim', () => {
  it('same matching owner retries concurrently without duplicate rows', async () => {
    const db = makeFakeDb()
    const owner = 'same-owner'
    const verified = tx({ originalTransactionId: 'concurrent-first', appAccountToken: owner, environment: 'Production', appleExpiresDate: new Date(future).toISOString() })
    const result = await Promise.all([verifyAndPersistSubscription(db, owner, verified), verifyAndPersistSubscription(db, owner, verified)])
    expect(result.every((r) => r.active)).toBe(true)
    expect(db._tables.app_store_subscription_bindings).toHaveLength(1)
    expect(db._tables.app_store_subscription_states).toHaveLength(1)
  })
})
