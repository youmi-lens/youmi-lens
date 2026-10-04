// Early-renewal entitlement regressions (real PostgreSQL via PGlite, Production-mirroring CHECK constraints).
// Physical incident 2026-10-04: a legitimate Sandbox DID_RENEW arrived 54s before its period's purchaseDate and was
// stored as 'verification_pending' (access lost for 5m21s). Apple-signed renewals may precede their purchaseDate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSubscriptionDatabase } from './subscriptionDatabaseHarness.mjs'
const apple = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('./iapApple.mjs', async (original) => ({ ...await original(), appleServerApiConfigured: () => true, fetchVerifiedSubscriptionStatus: apple.fetch }))
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const product = 'com.aydenz.youmilensipad.student.annual'
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString()
const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN
const initial = (user = A, extra = {}) => ({ originalTransactionId: 'chain', transactionId: 'initial', productId: product, appAccountToken: user,
  environment: 'Production', purchaseDate: iso(-5 * MIN), appleExpiresDate: iso(54 * SEC), appleSignedAt: iso(-5 * MIN), offerType: 1,
  offerDiscountType: 'FREE_TRIAL', price: 0, subscriptionGroupId: '22109238', ownershipType: 'PURCHASED', ...extra })
// The renewal Apple signed: period starts when the trial ends (54s from now) and lasts an hour; delivered NOW.
const renewal = (user = A, extra = {}) => initial(user, { transactionId: 'renewal', purchaseDate: iso(54 * SEC), appleExpiresDate: iso(HOUR + 54 * SEC),
  appleSignedAt: iso(0), offerType: null, offerDiscountType: null, price: 49990, ...extra })
let db, mod
beforeEach(async () => {
  vi.resetModules(); apple.fetch.mockReset(); apple.fetch.mockResolvedValue(null)
  db = await createSubscriptionDatabase({ users: [A, B] })
  mod = await import('./iapSubscriptions.mjs')
})
afterEach(async () => db.pg.close())
const didRenew = (tx, extra = {}) => mod.upsertSubscriptionState(db, A, tx, { source: 'notification_v2', notificationType: 'DID_RENEW',
  appleEventAt: new Date().toISOString(), renewal: { autoRenewStatus: true }, ...extra })

describe('early renewal keeps access continuous', () => {
  it('exact physical ordering: DID_RENEW 54s before purchaseDate stays active; entitlement never drops', async () => {
    await mod.verifyAndPersistSubscription(db, A, initial())
    expect((await mod.getEffectiveSubscription(db, A)).active).toBe(true)
    const state = await didRenew(renewal())
    expect(state.status).toBe('active')
    expect(state.active).toBe(true) // route safeToFinish = !revoked && (active || expired)
    expect(state.latest_transaction_id).toBe('renewal')
    const effective = await mod.getEffectiveSubscription(db, A)
    expect(effective.active).toBe(true) // JS no longer requires purchased_at <= now
    expect(effective.latest_transaction_id).toBe('renewal')
    const snapshot = await db.snapshots()
    expect(snapshot.bindings).toHaveLength(1); expect(snapshot.states).toHaveLength(1); expect(snapshot.states[0].status).toBe('active')
  })
  it('same early-renewal transaction through Restore/reconciliation (storekit_jws) is active and finishable', async () => {
    await mod.verifyAndPersistSubscription(db, A, initial())
    const restored = await mod.verifyAndPersistSubscription(db, A, renewal())
    expect(restored.status).toBe('active'); expect(restored.active).toBe(true)
    expect((await mod.getEffectiveSubscription(db, A)).active).toBe(true)
  })
  it('authoritative Apple status read of the early renewal is active', async () => {
    await mod.verifyAndPersistSubscription(db, A, initial())
    apple.fetch.mockResolvedValue({ transaction: renewal(), renewal: { autoRenewStatus: true }, appleStatus: 1, appleEventAt: iso(0) })
    expect((await mod.getEffectiveSubscription(db, A)).active).toBe(true)
  })
  it('idempotent: re-delivering the early renewal keeps one binding/state and stays active', async () => {
    await mod.verifyAndPersistSubscription(db, A, initial())
    await didRenew(renewal()); await didRenew(renewal()); await mod.verifyAndPersistSubscription(db, A, renewal())
    const snapshot = await db.snapshots()
    expect(snapshot.bindings).toHaveLength(1); expect(snapshot.states).toHaveLength(1); expect(snapshot.states[0].status).toBe('active')
  })
  it('anomaly guard: a renewal dated within 48h is granted; one dated beyond 48h is held, never granted', async () => {
    await mod.verifyAndPersistSubscription(db, A, initial())
    expect((await didRenew(renewal(A, { purchaseDate: iso(47 * HOUR), appleExpiresDate: iso(48 * HOUR) }))).active).toBe(true)
    const farDb = await createSubscriptionDatabase({ users: [A] })
    try {
      const far = await mod.verifyAndPersistSubscription(farDb, A, initial(A, { purchaseDate: iso(49 * HOUR), appleExpiresDate: iso(50 * HOUR) }))
      expect(far.status).toBe('verification_pending'); expect(far.active).toBe(false)
    } finally { await farDb.pg.close() }
  })
})

describe('future purchaseDate never overrides Apple authority or ownership', () => {
  it('future purchaseDate + revoked/refunded authoritative state: no grant', async () => {
    await mod.verifyAndPersistSubscription(db, A, initial())
    const revoked = await didRenew(renewal(A, { revoked: true, revokedAt: iso(0) }), { notificationType: 'REVOKE' })
    expect(revoked.status).toBe('revoked'); expect(revoked.active).toBe(false)
    expect((await mod.getEffectiveSubscription(db, A)).active).toBe(false)
  })
  it('future purchaseDate + refunded notification: no grant', async () => {
    await mod.verifyAndPersistSubscription(db, A, initial())
    const refunded = await didRenew(renewal(), { notificationType: 'REFUND' })
    expect(refunded.status).toBe('refunded'); expect(refunded.active).toBe(false)
  })
  it('future purchaseDate + authoritative expired status: no grant', async () => {
    await mod.verifyAndPersistSubscription(db, A, initial())
    const expired = await mod.upsertSubscriptionState(db, A, renewal(), { source: 'app_store_server_api', appleStatus: 2, appleEventAt: iso(0), renewal: { autoRenewStatus: false } })
    expect(expired.status).toBe('expired'); expect(expired.active).toBe(false)
  })
  it('terminal precedence: an older transaction cannot resurrect a revoked chain', async () => {
    await mod.verifyAndPersistSubscription(db, A, initial())
    await didRenew(renewal(A, { revoked: true, revokedAt: iso(0) }), { notificationType: 'REVOKE' })
    const stale = await mod.verifyAndPersistSubscription(db, A, initial())
    expect(stale.status).toBe('revoked'); expect(stale.active).toBe(false)
    expect((await mod.getEffectiveSubscription(db, A)).active).toBe(false)
  })
  it('wrong appAccountToken is still rejected for an early renewal', async () => {
    await mod.verifyAndPersistSubscription(db, A, initial())
    await expect(mod.verifyAndPersistSubscription(db, B, renewal(A))).rejects.toThrow(mod.SubscriptionAlreadyLinkedError)
    await expect(mod.verifyAndPersistSubscription(db, B, renewal(B, { originalTransactionId: 'other-chain' }))).resolves.toBeTruthy()
  })
  it('foreign canonical owner is still rejected', async () => {
    await mod.verifyAndPersistSubscription(db, A, initial())
    await expect(mod.verifyAndPersistSubscription(db, B, renewal(B))).rejects.toThrow(mod.SubscriptionAlreadyLinkedError)
    expect((await db.snapshots()).bindings.map((b) => b.user_id)).toEqual([A])
  })
  it('Sandbox chain without an explicit policy is still rejected', async () => {
    await expect(mod.verifyAndPersistSubscription(db, A, initial(A, { environment: 'Sandbox' }))).rejects.toThrow(mod.SubscriptionEnvironmentError)
    expect(await db.snapshots()).toEqual({ bindings: [], states: [] })
  })
  it('normal Production-style subscription is unchanged (active, auto-renew, single owner)', async () => {
    const normal = await mod.verifyAndPersistSubscription(db, A, initial(A, { purchaseDate: iso(-1 * HOUR), appleExpiresDate: iso(30 * 24 * HOUR) }))
    expect(normal.status).toBe('active'); expect(normal.active).toBe(true)
  })
})
