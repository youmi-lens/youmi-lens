import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Regression coverage for the subscription-ownership-conflict normalization
 * (Tier 1 backend-only fix): SubscriptionAccountTokenError (appAccountToken
 * mismatch) and SubscriptionAlreadyLinkedError (existing-binding conflict)
 * must produce the SAME client-facing `iap_already_linked` result, in both
 * /api/iap/apple/verify and /api/iap/restore — and restore must never
 * silently swallow either condition into a false "nothing to restore".
 *
 * Env vars are set before the dynamic import below so iapRoutes.mjs's
 * module-level SUPABASE_URL/SERVICE_ROLE_KEY/ANON_KEY constants resolve to
 * harmless placeholders, never real credentials.
 */
process.env.SUPABASE_URL = 'https://test-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
process.env.SUPABASE_ANON_KEY = 'test-anon-key'

const TEST_USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const { verifyAppleNotificationMock, upsertSubscriptionStateMock, reserveNotificationMock, markNotificationProcessedMock, findTransactionOwnerMock, findSubscriptionStateMock, verifyAppleTransactionMock, loadBillingProductMock, findSubscriptionBindingMock, verifyAndPersistSubscriptionMock, recordBillingEventMock, buildQuotaStatusMock, getOrCreateUserQuotaMock, createClientMock } = vi.hoisted(() => ({
  verifyAppleTransactionMock: vi.fn(),
  verifyAppleNotificationMock: vi.fn(),
  upsertSubscriptionStateMock: vi.fn(),
  reserveNotificationMock: vi.fn(async () => ({ reserved: true })),
  markNotificationProcessedMock: vi.fn(async () => {}),
  findTransactionOwnerMock: vi.fn(async () => null),
  findSubscriptionStateMock: vi.fn(async () => null),
  loadBillingProductMock: vi.fn(),
  findSubscriptionBindingMock: vi.fn(),
  verifyAndPersistSubscriptionMock: vi.fn(),
  recordBillingEventMock: vi.fn(async () => {}),
  buildQuotaStatusMock: vi.fn(async () => ({ planType: null, entitlement: null })),
  getOrCreateUserQuotaMock: vi.fn(async () => ({})),
  createClientMock: vi.fn(() => ({
    auth: { getUser: async () => ({ data: { user: { id: TEST_USER_ID, email: 'test@example.com' } }, error: null }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  })),
}))

vi.mock('@supabase/supabase-js', () => ({ createClient: createClientMock }))
vi.mock('./iapApple.mjs', () => ({
  verifyAppleTransaction: verifyAppleTransactionMock,
  verifyAppleNotification: verifyAppleNotificationMock,
}))
vi.mock('./iapEntitlements.mjs', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, loadBillingProduct: loadBillingProductMock, recordBillingEvent: recordBillingEventMock, reserveNotification: reserveNotificationMock, markNotificationProcessed: markNotificationProcessedMock, findTransactionOwner: findTransactionOwnerMock }
})
vi.mock('./iapSubscriptions.mjs', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, findSubscriptionBinding: findSubscriptionBindingMock, verifyAndPersistSubscription: verifyAndPersistSubscriptionMock, upsertSubscriptionState: upsertSubscriptionStateMock, findSubscriptionState: findSubscriptionStateMock }
})
vi.mock('./betaUsageStatus.mjs', () => ({ buildQuotaStatus: buildQuotaStatusMock }))
vi.mock('./betaGate.mjs', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getOrCreateUserQuota: getOrCreateUserQuotaMock }
})

let safeIapError, handleAppleNotifications, handleIapVerify, handleIapRestore, SubscriptionAccountTokenError, SubscriptionAlreadyLinkedError

beforeAll(async () => {
  ;({ safeIapError, handleAppleNotifications, handleIapVerify, handleIapRestore } = await import('./iapRoutes.mjs'))
  ;({ SubscriptionAccountTokenError, SubscriptionAlreadyLinkedError } = await import('./iapSubscriptions.mjs'))
})

afterEach(() => {
  verifyAppleNotificationMock.mockReset()
  upsertSubscriptionStateMock.mockReset()
  findSubscriptionStateMock.mockReset()
  verifyAppleTransactionMock.mockReset()
  loadBillingProductMock.mockReset()
  findSubscriptionBindingMock.mockReset()
  verifyAndPersistSubscriptionMock.mockReset()
  recordBillingEventMock.mockClear()
  buildQuotaStatusMock.mockClear()
  getOrCreateUserQuotaMock.mockClear()
})

const ANNUAL_PRODUCT_ROW = { product_id: 'com.aydenz.youmilensipad.student.annual', plan_type: 'student_pass', kind: 'auto_renewable', is_purchasable: false }
const MONTHLY_PRODUCT_ROW = { product_id: 'com.aydenz.youmilensipad.student.monthly', plan_type: 'student_pass', kind: 'auto_renewable', is_purchasable: false }

function verifiedAnnualTransaction(overrides = {}) {
  return {
    productId: 'com.aydenz.youmilensipad.student.annual',
    transactionId: 'txn-annual-1',
    originalTransactionId: 'orig-1',
    environment: 'Sandbox',
    appAccountToken: TEST_USER_ID,
    purchaseDate: '2026-01-01T00:00:00.000Z',
    appleExpiresDate: '2027-01-01T00:00:00.000Z',
    subscriptionGroupId: '22109238',
    ownershipType: 'PURCHASED',
    ...overrides,
  }
}

function fakeReq(body) {
  return { headers: { authorization: 'Bearer test-token' }, body }
}
function fakeRes() {
  const res = { statusCode: 200, payload: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (payload) => { res.payload = payload; return res }
  return res
}

// ── A/B: safeIapError normalization ─────────────────────────────────────────
describe('safeIapError normalizes both ownership-conflict exceptions identically', () => {
  it('A: SubscriptionAccountTokenError (appAccountToken mismatch) -> 409 iap_already_linked', () => {
    const result = safeIapError(new SubscriptionAccountTokenError('Subscription appAccountToken does not match this account'))
    expect(result.status).toBe(409)
    expect(result.error).toBe('iap_already_linked')
  })

  it('B: SubscriptionAlreadyLinkedError (existing binding owned by another user) -> SAME 409 iap_already_linked', () => {
    const result = safeIapError(new SubscriptionAlreadyLinkedError('Subscription is already linked to another account'))
    expect(result.status).toBe(409)
    expect(result.error).toBe('iap_already_linked')
  })

  it('H: the client-facing error object exposes no identifiers', () => {
    const result = safeIapError(new SubscriptionAccountTokenError('Subscription appAccountToken does not match this account'))
    expect(Object.keys(result).sort()).toEqual(['error', 'message', 'status'])
    expect(result.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i) // no UUID
    expect(result.message).not.toMatch(/@/) // no email
  })
})

// ── C/D: restore must classify, never swallow ───────────────────────────────
describe('handleIapRestore surfaces ownership conflicts instead of swallowing them', () => {
  it('C: SubscriptionAccountTokenError during restore -> alreadyLinked=true, nothing granted, nothing to finish', async () => {
    verifyAppleTransactionMock.mockResolvedValue(verifiedAnnualTransaction())
    loadBillingProductMock.mockResolvedValue(ANNUAL_PRODUCT_ROW)
    findSubscriptionBindingMock.mockResolvedValue(null)
    verifyAndPersistSubscriptionMock.mockRejectedValue(new SubscriptionAccountTokenError('Subscription appAccountToken does not match this account'))

    const req = fakeReq({ platform: 'ios', purchases: [{ signedTransactionInfo: 'fake-jws', transactionId: 'txn-annual-1' }] })
    const res = fakeRes()
    await handleIapRestore(req, res)

    expect(res.payload.ok).toBe(true)
    expect(res.payload.alreadyLinked).toBe(true)
    expect(res.payload.activeRestoredCount).toBe(0)
    expect(res.payload.verifiedTransactionIds).not.toContain('txn-annual-1') // client will not finishTransaction for this one
  })

  it('D: SubscriptionAlreadyLinkedError during restore -> SAME alreadyLinked=true, nothing granted', async () => {
    verifyAppleTransactionMock.mockResolvedValue(verifiedAnnualTransaction())
    loadBillingProductMock.mockResolvedValue(ANNUAL_PRODUCT_ROW)
    findSubscriptionBindingMock.mockResolvedValue(null)
    verifyAndPersistSubscriptionMock.mockRejectedValue(new SubscriptionAlreadyLinkedError('Subscription is already linked to another account'))

    const req = fakeReq({ platform: 'ios', purchases: [{ signedTransactionInfo: 'fake-jws', transactionId: 'txn-annual-1' }] })
    const res = fakeRes()
    await handleIapRestore(req, res)

    expect(res.payload.ok).toBe(true)
    expect(res.payload.alreadyLinked).toBe(true)
    expect(res.payload.activeRestoredCount).toBe(0)
    expect(res.payload.verifiedTransactionIds).not.toContain('txn-annual-1')
  })

  it('previous behavior (regression guard): before this fix these exceptions were swallowed — this proves they no longer are', async () => {
    verifyAppleTransactionMock.mockResolvedValue(verifiedAnnualTransaction())
    loadBillingProductMock.mockResolvedValue(ANNUAL_PRODUCT_ROW)
    findSubscriptionBindingMock.mockResolvedValue(null)
    verifyAndPersistSubscriptionMock.mockRejectedValue(new SubscriptionAccountTokenError('mismatch'))

    const req = fakeReq({ platform: 'ios', purchases: [{ signedTransactionInfo: 'fake-jws', transactionId: 'txn-annual-1' }] })
    const res = fakeRes()
    await handleIapRestore(req, res)

    // The old bug: alreadyLinked stayed false and the client showed
    // "No active purchase was found for this Apple Account." — a false claim.
    expect(res.payload.alreadyLinked).not.toBe(false)
  })
})

// ── E/F/G: legitimate ownership paths are untouched ─────────────────────────
describe('legitimate subscription flows are unaffected by the normalization', () => {
  it('E: same-user Monthly -> Annual still succeeds (identity assertion passes, subscription updates)', async () => {
    verifyAppleTransactionMock.mockResolvedValue(verifiedAnnualTransaction({ appAccountToken: TEST_USER_ID }))
    loadBillingProductMock.mockResolvedValue(ANNUAL_PRODUCT_ROW)
    findSubscriptionBindingMock.mockResolvedValue({ original_transaction_id: 'orig-1', user_id: TEST_USER_ID, environment: 'Sandbox', owner_state: 'active' })
    verifyAndPersistSubscriptionMock.mockResolvedValue({ active: true, status: 'active', product_id: 'com.aydenz.youmilensipad.student.annual', expires_at: '2027-01-01T00:00:00.000Z' })

    const req = fakeReq({ platform: 'ios', signedTransactionInfo: 'fake-jws' })
    const res = fakeRes()
    await handleIapVerify(req, res)

    expect(res.payload.ok).toBe(true)
    expect(res.payload.granted).toBe(true)
  })

  it('F: different-user Monthly -> Annual remains rejected as an ownership conflict (not silently granted)', async () => {
    verifyAppleTransactionMock.mockResolvedValue(verifiedAnnualTransaction({ appAccountToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }))
    loadBillingProductMock.mockResolvedValue(ANNUAL_PRODUCT_ROW)
    findSubscriptionBindingMock.mockResolvedValue(null)
    verifyAndPersistSubscriptionMock.mockRejectedValue(new SubscriptionAccountTokenError('Subscription appAccountToken does not match this account'))

    const req = fakeReq({ platform: 'ios', signedTransactionInfo: 'fake-jws' })
    const res = fakeRes()
    await handleIapVerify(req, res)

    expect(res.statusCode).toBe(409)
    expect(res.payload.ok).toBe(false)
    expect(res.payload.error).toBe('iap_already_linked')
    expect(res.payload.granted).toBeUndefined()
  })

  it('G: a fresh legitimate subscription purchase still succeeds end to end', async () => {
    verifyAppleTransactionMock.mockResolvedValue({
      productId: 'com.aydenz.youmilensipad.student.monthly',
      transactionId: 'txn-monthly-1',
      originalTransactionId: 'orig-fresh',
      environment: 'Sandbox',
      appAccountToken: TEST_USER_ID,
      purchaseDate: '2026-01-01T00:00:00.000Z',
      appleExpiresDate: '2026-02-01T00:00:00.000Z',
      subscriptionGroupId: '22109238',
      ownershipType: 'PURCHASED',
    })
    loadBillingProductMock.mockResolvedValue(MONTHLY_PRODUCT_ROW)
    findSubscriptionBindingMock.mockResolvedValue(null)
    verifyAndPersistSubscriptionMock.mockResolvedValue({ active: true, status: 'active', product_id: 'com.aydenz.youmilensipad.student.monthly', expires_at: '2026-02-01T00:00:00.000Z' })

    const req = fakeReq({ platform: 'ios', signedTransactionInfo: 'fake-jws' })
    const res = fakeRes()
    await handleIapVerify(req, res)

    expect(res.payload.ok).toBe(true)
    expect(res.payload.granted).toBe(true)
  })

  it('I: a rejected ownership-conflict transaction is never treated as grantable/finishable by /verify', async () => {
    verifyAppleTransactionMock.mockResolvedValue(verifiedAnnualTransaction({ appAccountToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }))
    loadBillingProductMock.mockResolvedValue(ANNUAL_PRODUCT_ROW)
    findSubscriptionBindingMock.mockResolvedValue(null)
    verifyAndPersistSubscriptionMock.mockRejectedValue(new SubscriptionAccountTokenError('Subscription appAccountToken does not match this account'))

    const req = fakeReq({ platform: 'ios', signedTransactionInfo: 'fake-jws' })
    const res = fakeRes()
    await handleIapVerify(req, res)

    expect(res.payload.granted).toBeUndefined()
    expect(res.payload.ok).toBe(false)
    // recordBillingEvent (which only fires on a real grant/decision path) was
    // never reached — the identity assertion throws before any persistence.
    expect(recordBillingEventMock).not.toHaveBeenCalled()
  })
})


describe('Restore delivery contract', () => {
  it('H: sales_closed is not safe to finish and does not persist a subscription', async () => {
    verifyAppleTransactionMock.mockResolvedValue(verifiedAnnualTransaction({ productId: MONTHLY_PRODUCT_ROW.product_id, environment: 'Production' }))
    loadBillingProductMock.mockResolvedValue(MONTHLY_PRODUCT_ROW)
    findSubscriptionBindingMock.mockResolvedValue(null)
    const res = fakeRes()
    await handleIapRestore(fakeReq({ platform: 'ios', purchases: [{ signedTransactionInfo: 'jws', transactionId: 'txn-annual-1' }] }), res)
    expect(res.payload.verifiedTransactionIds).toEqual([])
    expect(res.payload.activeRestoredCount).toBe(0)
    expect(verifyAndPersistSubscriptionMock).not.toHaveBeenCalled()
    expect(recordBillingEventMock).toHaveBeenCalledWith(expect.anything(), TEST_USER_ID, expect.objectContaining({ event_type: 'kill_switch_block' }))
  })

  it('I: granted transaction is safe to finish', async () => {
    verifyAppleTransactionMock.mockResolvedValue(verifiedAnnualTransaction())
    loadBillingProductMock.mockResolvedValue(ANNUAL_PRODUCT_ROW)
    findSubscriptionBindingMock.mockResolvedValue(null)
    verifyAndPersistSubscriptionMock.mockResolvedValue({ active: true, status: 'active' })
    const res = fakeRes()
    await handleIapRestore(fakeReq({ platform: 'ios', purchases: [{ signedTransactionInfo: 'jws', transactionId: 'txn-annual-1' }] }), res)
    expect(res.payload.verifiedTransactionIds).toEqual(['txn-annual-1'])
    expect(res.payload.activeRestoredCount).toBe(1)
  })

  it('verification or retryable persistence failure is not safe to finish', async () => {
    verifyAppleTransactionMock.mockRejectedValue(new Error('verification unavailable'))
    const res = fakeRes()
    await handleIapRestore(fakeReq({ platform: 'ios', purchases: [{ signedTransactionInfo: 'jws', transactionId: 'txn-annual-1' }] }), res)
    expect(res.payload.verifiedTransactionIds).toEqual([])
    verifyAppleTransactionMock.mockResolvedValue(verifiedAnnualTransaction())
    loadBillingProductMock.mockResolvedValue(ANNUAL_PRODUCT_ROW)
    findSubscriptionBindingMock.mockResolvedValue(null)
    verifyAndPersistSubscriptionMock.mockRejectedValue(new Error('database unavailable'))
    const retry = fakeRes()
    await handleIapRestore(fakeReq({ platform: 'ios', purchases: [{ signedTransactionInfo: 'jws' }] }), retry)
    expect(retry.payload.verifiedTransactionIds).toEqual([])
  })
})


describe('authorized terminal reconciliation and notification ownership', () => {
  it('successfully persisted terminal subscription is safe to finish without granting active access', async () => {
    verifyAppleTransactionMock.mockResolvedValue(verifiedAnnualTransaction())
    loadBillingProductMock.mockResolvedValue(ANNUAL_PRODUCT_ROW)
    findSubscriptionBindingMock.mockResolvedValue({ user_id: TEST_USER_ID })
    verifyAndPersistSubscriptionMock.mockResolvedValue({ active: false, status: 'revoked' })
    const res = fakeRes()
    await handleIapRestore(fakeReq({ platform: 'ios', purchases: [{ signedTransactionInfo: 'jws' }] }), res)
    expect(res.payload.verifiedTransactionIds).toEqual(['txn-annual-1'])
    expect(res.payload.activeRestoredCount).toBe(0)
  })

  it('retryable verification_pending state is not safe to finish', async () => {
    verifyAppleTransactionMock.mockResolvedValue(verifiedAnnualTransaction())
    loadBillingProductMock.mockResolvedValue(ANNUAL_PRODUCT_ROW)
    findSubscriptionBindingMock.mockResolvedValue({ user_id: TEST_USER_ID })
    verifyAndPersistSubscriptionMock.mockResolvedValue({ active: false, status: 'verification_pending' })
    const res = fakeRes()
    await handleIapRestore(fakeReq({ platform: 'ios', purchases: [{ signedTransactionInfo: 'jws' }] }), res)
    expect(res.payload.verifiedTransactionIds).toEqual([])
  })

  it('renewal writes only canonical owner state', async () => {
    const transaction = { ...verifiedAnnualTransaction(), autoRenewable: true }
    verifyAppleNotificationMock.mockResolvedValue({ transaction, notificationType: 'DID_RENEW', notificationUUID: 'notification-1', environment: 'Sandbox' })
    findSubscriptionBindingMock.mockResolvedValue({ user_id: TEST_USER_ID, owner_state: 'active' })
    upsertSubscriptionStateMock.mockResolvedValue({ status: 'active' })
    const res = fakeRes()
    await handleAppleNotifications({ body: { signedPayload: 'jws' } }, res)
    expect(res.statusCode).toBe(200)
    expect(upsertSubscriptionStateMock).toHaveBeenCalledTimes(1)
    expect(upsertSubscriptionStateMock).toHaveBeenCalledWith(expect.anything(), TEST_USER_ID, transaction, expect.anything())
  })

  it('notification without binding or original-owner state grants nobody', async () => {
    verifyAppleNotificationMock.mockResolvedValue({ transaction: { ...verifiedAnnualTransaction(), autoRenewable: true }, notificationType: 'DID_RENEW', notificationUUID: 'notification-2', environment: 'Sandbox' })
    findSubscriptionBindingMock.mockResolvedValue(null)
    findSubscriptionStateMock.mockResolvedValue(null)
    const res = fakeRes()
    await handleAppleNotifications({ body: { signedPayload: 'jws' } }, res)
    expect(res.statusCode).toBe(200)
    expect(upsertSubscriptionStateMock).not.toHaveBeenCalled()
  })

  it('notification preserves legitimate original legacy guest state', async () => {
    verifyAppleNotificationMock.mockResolvedValue({ transaction: { ...verifiedAnnualTransaction(), autoRenewable: true }, notificationType: 'DID_RENEW', notificationUUID: 'notification-3', environment: 'Sandbox' })
    findSubscriptionBindingMock.mockResolvedValue(null)
    findSubscriptionStateMock.mockResolvedValue({ user_id: TEST_USER_ID })
    upsertSubscriptionStateMock.mockResolvedValue({ status: 'active' })
    const res = fakeRes()
    await handleAppleNotifications({ body: { signedPayload: 'jws' } }, res)
    expect(res.statusCode).toBe(200)
    expect(upsertSubscriptionStateMock).toHaveBeenCalledTimes(1)
    expect(upsertSubscriptionStateMock.mock.calls[0][1]).toBe(TEST_USER_ID)
  })
})
