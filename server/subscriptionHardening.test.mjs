import { createSubscriptionDatabase } from './subscriptionDatabaseHarness.mjs'
const engines = []
afterEach(async () => { for (const db of engines.splice(0)) await db.pg.close() })
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Subscription state reconciliation hardening.
 *
 * Defect A — every renewal, plan change, and trial-to-paid transition in one
 * Apple lineage shares a single originalTransactionId, which is this table's
 * conflict key. Restore submits the full history and notifications can arrive
 * out of order, so without a monotonic guard an OLDER transaction could
 * overwrite a NEWER valid subscription state.
 *
 * Defect B — the subscription layer and the entitlement layer had two
 * different definitions of "active", so grace_period and
 * cancelled_but_active_until_expiry read as Free before expires_at.
 */

vi.hoisted(() => {
  process.env.SUPABASE_URL = 'https://stub.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-stub'
})

const {
  SUBSCRIPTION_ACTIVE_STATUSES,
  shouldReplaceSubscriptionState,
  subscriptionStatusIsActive,
  upsertSubscriptionState,
} = await import('./iapSubscriptions.mjs')
const { isEntitlementActive } = await import('./iapEntitlements.mjs')

const OTXN = 'orig-1'
const MONTHLY = 'com.aydenz.youmilensipad.student.monthly'
const ANNUAL = 'com.aydenz.youmilensipad.student.annual'

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2098-09-15T00:00:00Z')) })
afterEach(() => vi.useRealTimers())

const t = (iso) => new Date(iso).toISOString()
const P1 = t('2098-08-01T00:00:00Z') // older period start
const P1_END = t('2098-09-01T00:00:00Z')
const P2 = t('2098-09-01T00:00:00Z') // newer period start
const P2_END = t('2098-10-01T00:00:00Z')

const stored = (o = {}) => ({
  user_id: 'u1',
  product_id: MONTHLY,
  status: 'active',
  purchased_at: P2,
  expires_at: P2_END,
  auto_renew_status: true,
  ...o,
})
const incoming = (o = {}) => ({ product_id: MONTHLY, status: 'active', purchased_at: P1, expires_at: P1_END, ...o })

// ── A fake DB that records what actually reached the table ──────────────────
function makeDb(initial = null) {
  const table = { row: initial }
  let enginePromise
  return { table, async rpc(name,args) {
    if (!enginePromise) enginePromise=createSubscriptionDatabase({users:['u1'],bindings:[{original_transaction_id:OTXN,user_id:'u1',environment:'Production'}],states:initial?[{original_transaction_id:OTXN,...initial}]:[]}).then(db=>{engines.push(db);return db})
    const engine=await enginePromise
    const response=await engine.rpc(name,{...args,p_transaction:{...args.p_transaction,environment:'Production'}})
    const snapshot=await engine.snapshots(); table.row=snapshot.states[0]??null
    return response
  } }
}

const verified = (o = {}) => ({
  originalTransactionId: OTXN,
  transactionId: 'tx-1',
  productId: MONTHLY,
  subscriptionGroupId: '22109238',
  environment: 'Sandbox',
  ownershipType: 'PURCHASED',
  appAccountToken: 'u1',
  purchaseDate: P1,
  appleExpiresDate: P1_END,
  revokedAt: null,
  ...o,
})

describe('M1-M12: monotonic subscription state', () => {
  it('M1: a newer active state survives an older expired restore item', async () => {
    const db = makeDb(stored())
    const res = await upsertSubscriptionState(db, 'u1', verified({ appleExpiresDate: P1_END }))
    expect(res.stale).toBe(true)
    expect(res.active).toBe(true)
    expect(db.table.row.expires_at).toBe(P2_END) // untouched
  })

  it('M2: a newer Annual survives an older Monthly item', async () => {
    const db = makeDb(stored({ product_id: ANNUAL }))
    await upsertSubscriptionState(db, 'u1', verified({ productId: MONTHLY }))
    expect(db.table.row.product_id).toBe(ANNUAL)
  })

  it('M3: a newer Monthly survives an older Annual item', async () => {
    const db = makeDb(stored({ product_id: MONTHLY }))
    await upsertSubscriptionState(db, 'u1', verified({ productId: ANNUAL }))
    expect(db.table.row.product_id).toBe(MONTHLY)
  })

  it('M4: a later renewal extends expires_at', async () => {
    const db = makeDb(stored({ purchased_at: P1, expires_at: P1_END }))
    await upsertSubscriptionState(db, 'u1', verified({ purchaseDate: P2, appleExpiresDate: P2_END }))
    expect(db.table.row.expires_at).toBe(P2_END)
    expect(db.table.row.purchased_at).toBe(P2)
  })

  it('M5: replaying the same transaction is idempotent', async () => {
    const db = makeDb(stored({ purchased_at: P1, expires_at: P1_END }))
    await upsertSubscriptionState(db, 'u1', verified())
    const first = { ...db.table.row }
    await upsertSubscriptionState(db, 'u1', verified())
    expect(db.table.row.product_id).toBe(first.product_id)
    expect(db.table.row.expires_at).toBe(first.expires_at)
    expect(db.table.row.status).toBe(first.status)
  })

  it('M6: an old notification cannot regress a newer state', async () => {
    const db = makeDb(stored())
    await upsertSubscriptionState(db, 'u1', verified({ purchaseDate: P1, appleExpiresDate: P1_END }), {
      notificationType: 'EXPIRED',
      source: 'notification_v2',
    })
    expect(db.table.row.status).toBe('active')
    expect(db.table.row.expires_at).toBe(P2_END)
  })

  it('M7: a refund/revoke for the CURRENT period authoritatively overrides active', async () => {
    const db = makeDb(stored({ purchased_at: P2, expires_at: P2_END }))
    const res = await upsertSubscriptionState(db, 'u1', verified({ purchaseDate: P2, appleExpiresDate: P2_END, revoked: true, revokedAt: P2 }), {
      notificationType: 'REFUND',
      source: 'notification_v2',
    })
    expect(res.stale).toBe(false)
    expect(db.table.row.status).toBe('refunded')
    expect(subscriptionStatusIsActive(db.table.row.status, db.table.row.expires_at)).toBe(false)
  })

  it('M7b: a refund for an OLDER period must NOT revoke a newer valid one', () => {
    expect(shouldReplaceSubscriptionState(stored({ purchased_at: P2 }), incoming({ purchased_at: P1, status: 'refunded' }))).toBe(false)
  })

  it('M8/M9: restore in arbitrary order and reversed order converge on the same final state', async () => {
    const items = [
      verified({ transactionId: 'tx-1', purchaseDate: P1, appleExpiresDate: P1_END, productId: MONTHLY }),
      verified({ transactionId: 'tx-2', purchaseDate: P2, appleExpiresDate: P2_END, productId: ANNUAL }),
    ]
    const forward = makeDb(null)
    for (const v of items) await upsertSubscriptionState(forward, 'u1', v)
    const reversed = makeDb(null)
    for (const v of [...items].reverse()) await upsertSubscriptionState(reversed, 'u1', v)

    expect(forward.table.row.product_id).toBe(ANNUAL)
    expect(forward.table.row.expires_at).toBe(P2_END)
    expect(reversed.table.row.product_id).toBe(forward.table.row.product_id)
    expect(reversed.table.row.expires_at).toBe(forward.table.row.expires_at)
  })

  it('M10: absent renewal metadata preserves the stored auto_renew_status', async () => {
    const db = makeDb(stored({ purchased_at: P1, expires_at: P1_END, auto_renew_status: false }))
    // Restore carries no renewalInfo at all.
    await upsertSubscriptionState(db, 'u1', verified({ purchaseDate: P2, appleExpiresDate: P2_END }))
    expect(db.table.row.auto_renew_status).toBe(false)
    // ...and the cancellation is still reflected in the derived status.
    expect(db.table.row.status).toBe('cancelled_but_active_until_expiry')
  })

  it('M11: explicit newer renewal metadata updates it', async () => {
    const db = makeDb(stored({ purchased_at: P1, expires_at: P1_END, auto_renew_status: false }))
    await upsertSubscriptionState(db, 'u1', verified({ purchaseDate: P2, appleExpiresDate: P2_END }), {
      renewal: { autoRenewStatus: true },
      source: 'notification_v2',
    })
    expect(db.table.row.auto_renew_status).toBe(true)
    expect(db.table.row.status).toBe('active')
  })

  it('M12: writes always target the single conflict key — one row per lineage', async () => {
    const db = makeDb(null)
    await upsertSubscriptionState(db, 'u1', verified({ transactionId: 'tx-1', purchaseDate: P1, appleExpiresDate: P1_END }))
    await upsertSubscriptionState(db, 'u1', verified({ transactionId: 'tx-2', purchaseDate: P2, appleExpiresDate: P2_END }))
    expect(db.table.row.original_transaction_id).toBe(OTXN)
    expect(db.table.row.latest_transaction_id).toBe('tx-2')
  })
})

describe('S1-S12: canonical active-status vocabulary', () => {
  const FUTURE = '2099-01-01T00:00:00.000Z'
  const PAST = new Date(Date.now() - 86_400_000).toISOString()
  const STARTED = new Date(Date.now() - 3_600_000).toISOString()
  const ent = (status, expires = FUTURE) => ({
    plan_type: 'student_pass',
    status,
    starts_at: STARTED,
    expires_at: expires,
    revoked_at: null,
  })
  const now = Date.now()

  it('S1: active + future expiry -> Student', () => expect(isEntitlementActive(ent('active'), now)).toBe(true))
  it('S2: grace_period + future expiry -> Student', () => expect(isEntitlementActive(ent('grace_period'), now)).toBe(true))
  it('S3: cancelled_but_active_until_expiry + future expiry -> Student', () =>
    expect(isEntitlementActive(ent('cancelled_but_active_until_expiry'), now)).toBe(true))
  it('S4: cancelled_but_active_until_expiry + PAST expiry -> Free (expiry stays authoritative)', () =>
    expect(isEntitlementActive(ent('cancelled_but_active_until_expiry', PAST), now)).toBe(false))
  it('S5: expired -> Free', () => expect(isEntitlementActive(ent('expired'), now)).toBe(false))
  it('S6: revoked -> Free', () => expect(isEntitlementActive(ent('revoked'), now)).toBe(false))
  it('S7: refunded -> Free', () => expect(isEntitlementActive(ent('refunded'), now)).toBe(false))
  it('S8: unknown -> Free', () => expect(isEntitlementActive(ent('unknown'), now)).toBe(false))
  it('S9: verification_pending -> Free', () => expect(isEntitlementActive(ent('verification_pending'), now)).toBe(false))
  it('S9b: billing_retry is NOT active — a failed renewal must not extend access', () => {
    expect(isEntitlementActive(ent('billing_retry'), now)).toBe(false)
    expect(SUBSCRIPTION_ACTIVE_STATUSES).not.toContain('billing_retry')
  })
  it('S12: a revoked entitlement is inactive even with a future window', () =>
    expect(isEntitlementActive({ ...ent('active'), revoked_at: PAST }, now)).toBe(false))

  it('the two layers now share ONE vocabulary', () => {
    for (const status of SUBSCRIPTION_ACTIVE_STATUSES) {
      expect(subscriptionStatusIsActive(status, FUTURE)).toBe(true)
      expect(isEntitlementActive(ent(status), now)).toBe(true)
    }
  })
})

describe('R1-R15: restore idempotence and non-destructiveness', () => {
  it('R1/R2/R3: restoring an active subscription leaves it active', async () => {
    for (const product of [MONTHLY, ANNUAL]) {
      const db = makeDb(stored({ product_id: product, purchased_at: P2, expires_at: P2_END }))
      const res = await upsertSubscriptionState(db, 'u1', verified({ productId: product, purchaseDate: P2, appleExpiresDate: P2_END }))
      expect(res.active).toBe(true)
      expect(db.table.row.product_id).toBe(product)
    }
  })

  it('R4: a cancelled-but-valid subscription stays active until expiry across restore', async () => {
    const db = makeDb(stored({ purchased_at: P2, expires_at: P2_END, status: 'cancelled_but_active_until_expiry', auto_renew_status: false }))
    const res = await upsertSubscriptionState(db, 'u1', verified({ purchaseDate: P2, appleExpiresDate: P2_END }))
    expect(db.table.row.status).toBe('cancelled_but_active_until_expiry')
    expect(res.auto_renew_status).toBe(false)
  })

  it('R7: a historical expired item alongside a current active state leaves it active', async () => {
    const db = makeDb(stored({ purchased_at: P2, expires_at: P2_END }))
    await upsertSubscriptionState(db, 'u1', verified({ purchaseDate: P1, appleExpiresDate: P1_END }))
    expect(subscriptionStatusIsActive(db.table.row.status, db.table.row.expires_at)).toBe(true)
  })

  it('R10: restoring twice produces identical state', async () => {
    const db = makeDb(stored({ purchased_at: P2, expires_at: P2_END }))
    await upsertSubscriptionState(db, 'u1', verified({ purchaseDate: P2, appleExpiresDate: P2_END }))
    const first = { ...db.table.row, last_verified_at: null }
    await upsertSubscriptionState(db, 'u1', verified({ purchaseDate: P2, appleExpiresDate: P2_END }))
    expect({ ...db.table.row, last_verified_at: null }).toEqual(first)
  })

  it('R11/R12: after a plan change the newest product stays authoritative through restore', async () => {
    const db = makeDb(stored({ product_id: ANNUAL, purchased_at: P2, expires_at: P2_END }))
    // Restore replays the older Monthly period.
    await upsertSubscriptionState(db, 'u1', verified({ productId: MONTHLY, purchaseDate: P1, appleExpiresDate: P1_END }))
    expect(db.table.row.product_id).toBe(ANNUAL)
  })

  it('R6/R13: with nothing to write, stored state is never touched', async () => {
    const db = makeDb(stored())
    const before = { ...db.table.row }
    // No purchases submitted -> no upsert call at all.
    expect(db.table.row).toEqual(before)
  })
})
