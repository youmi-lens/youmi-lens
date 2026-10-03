import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSubscriptionServerReconciler } from './subscriptionServerReconciliation.mjs'
const row = { user_id: 'owner', original_transaction_id: 'chain', environment: 'Production', expires_at: new Date(10000).toISOString() }
const snapshot = { transaction: { originalTransactionId: 'chain', environment: 'Production' }, renewal: { autoRenewStatus: true }, appleStatus: 1 }
afterEach(() => vi.useRealTimers())
describe('missed notification recovery', () => {
  it('collapses parallel reads and persists only the authoritative matching chain', async () => {
    let resolve; const fetchStatus = vi.fn(() => new Promise(r => { resolve = r }))
    const reconcile = createSubscriptionServerReconciler({ fetchStatus, configured: () => true, now: () => 0 })
    const persist = vi.fn(async () => ({ ...row, expires_at: '2099-01-01T00:00:00Z' }))
    const a = reconcile(row, persist), b = reconcile(row, persist)
    await Promise.resolve(); resolve(snapshot)
    expect(await a).toEqual(await b); expect(fetchStatus).toHaveBeenCalledTimes(1); expect(persist).toHaveBeenCalledTimes(1)
    await reconcile(row, persist); expect(fetchStatus).toHaveBeenCalledTimes(1)
  })
  it('expiry crossing bypasses the 60-second throttle', async () => {
    let now = 0; const fetchStatus = vi.fn(async () => snapshot)
    const reconcile = createSubscriptionServerReconciler({ fetchStatus, configured: () => true, now: () => now })
    await reconcile(row, async () => row); now = 10001; await reconcile(row, async () => row)
    expect(fetchStatus).toHaveBeenCalledTimes(2)
  })
  it.each(['wrong chain', 'wrong environment', 'offline'])('fails closed for %s', async mode => {
    const fetchStatus = async () => { if (mode === 'offline') throw Error('network'); return { ...snapshot, transaction: { ...snapshot.transaction, ...(mode === 'wrong chain' ? { originalTransactionId: 'foreign' } : { environment: 'Sandbox' }) } } }
    const persist = vi.fn(); const reconcile = createSubscriptionServerReconciler({ fetchStatus, configured: () => true })
    expect(await reconcile(row, persist)).toBe(row); expect(persist).not.toHaveBeenCalled()
  })
  it('late Apple response after timeout cannot persist or extend access', async () => {
    vi.useFakeTimers(); let resolve; const persist = vi.fn()
    const reconcile = createSubscriptionServerReconciler({ fetchStatus: () => new Promise(r => { resolve = r }), configured: () => true })
    const pending = reconcile(row, persist); await vi.advanceTimersByTimeAsync(5001)
    expect(await pending).toBe(row); resolve(snapshot); await Promise.resolve(); expect(persist).not.toHaveBeenCalled()
  })
  it('missing server credentials never attempt an unsigned fallback', async () => {
    const fetchStatus = vi.fn(), persist = vi.fn()
    expect(await createSubscriptionServerReconciler({ fetchStatus, configured: () => false })(row, persist)).toBe(row)
    expect(fetchStatus).not.toHaveBeenCalled()
  })
  it('distinct owners and environments do not share a flight', async () => {
    const fetchStatus = vi.fn(async () => null)
    const reconcile = createSubscriptionServerReconciler({ fetchStatus, configured: () => true })
    await Promise.all([reconcile(row, vi.fn()), reconcile({ ...row, user_id: 'another' }, vi.fn()), reconcile({ ...row, environment: 'Sandbox' }, vi.fn())])
    expect(fetchStatus).toHaveBeenCalledTimes(3)
  })
})
