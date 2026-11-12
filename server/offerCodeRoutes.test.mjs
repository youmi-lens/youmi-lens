import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Placeholders only; every client and Apple call below is mocked.
process.env.SUPABASE_URL = 'https://test-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
process.env.SUPABASE_ANON_KEY = 'test-anon-key'

const TEST_USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const { verifyAppleTransactionMock, setAppAccountTokenMock, loadBillingProductMock, findSubscriptionBindingMock,
  verifyAndPersistSubscriptionMock, createClientMock } = vi.hoisted(() => ({
  verifyAppleTransactionMock: vi.fn(),
  setAppAccountTokenMock: vi.fn(async () => ({ ok: true })),
  loadBillingProductMock: vi.fn(),
  findSubscriptionBindingMock: vi.fn(async () => null),
  verifyAndPersistSubscriptionMock: vi.fn(),
  createClientMock: vi.fn(() => ({
    auth: { getUser: async () => ({ data: { user: { id: TEST_USER_ID, email: 'test@example.com' } }, error: null }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  })),
}))

vi.mock('@supabase/supabase-js', () => ({ createClient: createClientMock }))
vi.mock('./iapApple.mjs', () => ({
  verifyAppleTransaction: verifyAppleTransactionMock,
  verifyAppleNotification: vi.fn(),
  setAppAccountTokenBestEffort: setAppAccountTokenMock,
  appleServerApiConfigured: () => false,
  fetchVerifiedSubscriptionStatus: vi.fn(),
}))
vi.mock('./iapEntitlements.mjs', async (importOriginal) => ({
  ...(await importOriginal()), loadBillingProduct: loadBillingProductMock, recordBillingEvent: vi.fn(async () => {}),
}))
vi.mock('./iapSubscriptions.mjs', async (importOriginal) => ({
  ...(await importOriginal()), findSubscriptionBinding: findSubscriptionBindingMock, verifyAndPersistSubscription: verifyAndPersistSubscriptionMock,
}))
vi.mock('./betaUsageStatus.mjs', () => ({ buildQuotaStatus: vi.fn(async () => ({ planType: null, entitlement: null })) }))
vi.mock('./betaGate.mjs', async (importOriginal) => ({ ...(await importOriginal()), getOrCreateUserQuota: vi.fn(async () => ({})) }))

let handleIapVerify, handleIapRestore, safeIapError, SubscriptionOfferRequiresAccountError, SubscriptionAlreadyLinkedError
beforeAll(async () => {
  ;({ handleIapVerify, handleIapRestore, safeIapError } = await import('./iapRoutes.mjs'))
  ;({ SubscriptionOfferRequiresAccountError, SubscriptionAlreadyLinkedError } = await import('./iapSubscriptions.mjs'))
})
afterEach(() => { vi.clearAllMocks(); setAppAccountTokenMock.mockImplementation(async () => ({ ok: true })) })

const offerCodeTransaction = {
  productId: 'com.aydenz.youmilensipad.student.annual', transactionId: 'offer-tx-1', originalTransactionId: 'offer-chain',
  environment: 'Production', appAccountToken: null, offerType: 3, offerIdentifier: 'XHS-monthly-30', autoRenewable: true,
  purchaseDate: '2026-11-01T00:00:00.000Z', appleExpiresDate: '2027-11-01T00:00:00.000Z', subscriptionGroupId: '22109238',
}
const persisted = (extra = {}) => ({ user_id: TEST_USER_ID, original_transaction_id: 'offer-chain', product_id: offerCodeTransaction.productId,
  status: 'active', active: true, expires_at: '2027-11-01T00:00:00.000Z', offer_bound: true, ...extra })
const fakeReq = (body) => ({ headers: { authorization: 'Bearer test-token' }, body })
const fakeRes = () => {
  const res = { statusCode: 200, payload: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (payload) => { res.payload = payload; return res }
  return res
}

describe('offer-code verify/restore routes', () => {
  it('grants a newly bound offer code and asks Apple to set the owner token', async () => {
    verifyAppleTransactionMock.mockResolvedValue(offerCodeTransaction)
    loadBillingProductMock.mockResolvedValue({ product_id: offerCodeTransaction.productId, kind: 'auto_renewable' })
    verifyAndPersistSubscriptionMock.mockResolvedValue(persisted())
    const res = fakeRes()
    await handleIapVerify(fakeReq({ platform: 'ios', signedTransactionInfo: 'fake-jws' }), res)
    expect(res.payload).toMatchObject({ ok: true, granted: true })
    expect(verifyAndPersistSubscriptionMock).toHaveBeenCalledWith(expect.anything(), TEST_USER_ID, offerCodeTransaction, expect.anything())
    expect(setAppAccountTokenMock).toHaveBeenCalledWith('offer-chain', 'Production', TEST_USER_ID)
  })

  it('does not wait for Apple: a hanging Set App Account Token call never blocks the grant', async () => {
    setAppAccountTokenMock.mockImplementation(() => new Promise(() => {}))
    verifyAppleTransactionMock.mockResolvedValue(offerCodeTransaction)
    loadBillingProductMock.mockResolvedValue({ product_id: offerCodeTransaction.productId, kind: 'auto_renewable' })
    verifyAndPersistSubscriptionMock.mockResolvedValue(persisted())
    const res = fakeRes()
    await handleIapVerify(fakeReq({ platform: 'ios', signedTransactionInfo: 'fake-jws' }), res)
    expect(res.payload).toMatchObject({ ok: true, granted: true })
  })

  it('does not call Apple again for an already-bound chain', async () => {
    verifyAppleTransactionMock.mockResolvedValue(offerCodeTransaction)
    loadBillingProductMock.mockResolvedValue({ product_id: offerCodeTransaction.productId, kind: 'auto_renewable' })
    findSubscriptionBindingMock.mockResolvedValue({ user_id: TEST_USER_ID, owner_state: 'active' })
    verifyAndPersistSubscriptionMock.mockResolvedValue(persisted({ offer_bound: false }))
    const res = fakeRes()
    await handleIapVerify(fakeReq({ platform: 'ios', signedTransactionInfo: 'fake-jws' }), res)
    expect(res.payload).toMatchObject({ ok: true, granted: true })
    expect(setAppAccountTokenMock).not.toHaveBeenCalled()
  })

  it('restore reports an offer code owned by another account as alreadyLinked and grants nothing', async () => {
    verifyAppleTransactionMock.mockResolvedValue(offerCodeTransaction)
    loadBillingProductMock.mockResolvedValue({ product_id: offerCodeTransaction.productId, kind: 'auto_renewable' })
    verifyAndPersistSubscriptionMock.mockRejectedValue(new SubscriptionAlreadyLinkedError('Subscription is linked to another account'))
    const res = fakeRes()
    await handleIapRestore(fakeReq({ platform: 'ios', purchases: [{ signedTransactionInfo: 'fake-jws', transactionId: 'offer-tx-1' }] }), res)
    expect(res.payload).toMatchObject({ ok: true, alreadyLinked: true, activeRestoredCount: 0, verifiedTransactionIds: [] })
    expect(setAppAccountTokenMock).not.toHaveBeenCalled()
  })

  it('a guest redeeming a code is told to sign in, without identifiers', async () => {
    const result = safeIapError(new SubscriptionOfferRequiresAccountError('Offer code redemption requires a signed-in account'))
    expect(result).toEqual({ status: 403, error: 'iap_account_required', message: expect.stringMatching(/sign in/i) })
    verifyAppleTransactionMock.mockResolvedValue(offerCodeTransaction)
    loadBillingProductMock.mockResolvedValue({ product_id: offerCodeTransaction.productId, kind: 'auto_renewable' })
    verifyAndPersistSubscriptionMock.mockRejectedValue(new SubscriptionOfferRequiresAccountError('x'))
    const res = fakeRes()
    await handleIapVerify(fakeReq({ platform: 'ios', signedTransactionInfo: 'fake-jws' }), res)
    expect(res.statusCode).toBe(403)
    expect(res.payload).toMatchObject({ ok: false, error: 'iap_account_required' })
  })
})
