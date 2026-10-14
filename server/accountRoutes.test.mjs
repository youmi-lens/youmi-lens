import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getAdminClientMock,
  getStripeCustomerIdMock,
  getStripeMock,
  isAppleIapLedgerUnavailableErrorMock,
  isMissingAppleIapLedgerTableErrorMock,
  isStripeConfiguredMock,
  prepareAppleIapLedgerForAccountDeletionMock,
  verifyJwtMock,
} = vi.hoisted(() => ({
  getAdminClientMock: vi.fn(),
  getStripeCustomerIdMock: vi.fn(),
  getStripeMock: vi.fn(),
  isAppleIapLedgerUnavailableErrorMock: vi.fn(() => false),
  isMissingAppleIapLedgerTableErrorMock: vi.fn(() => false),
  isStripeConfiguredMock: vi.fn(() => true),
  prepareAppleIapLedgerForAccountDeletionMock: vi.fn(),
  verifyJwtMock: vi.fn(),
}))

vi.mock('./betaGate.mjs', () => ({
  BETA_ERROR_CODES: { AUTH_REQUIRED: 'auth_required' },
  getAdminClient: getAdminClientMock,
  verifyJwt: verifyJwtMock,
}))

vi.mock('./iapLedger.mjs', () => ({
  isAppleIapLedgerUnavailableError: isAppleIapLedgerUnavailableErrorMock,
  isMissingAppleIapLedgerTableError: isMissingAppleIapLedgerTableErrorMock,
  prepareAppleIapLedgerForAccountDeletion: prepareAppleIapLedgerForAccountDeletionMock,
}))

vi.mock('./stripeClient.mjs', () => ({
  getStripe: getStripeMock,
  isStripeConfigured: isStripeConfiguredMock,
}))

vi.mock('./stripeCustomers.mjs', () => ({
  getStripeCustomerId: getStripeCustomerIdMock,
}))

import { handleDeleteAccount, preflightStripeAccountDeletion } from './accountRoutes.mjs'

const USER_ID = 'user-123456789'

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    },
  }
}

function makeDb() {
  const list = vi.fn().mockResolvedValue({ data: [], error: null })
  const remove = vi.fn().mockResolvedValue({ data: [], error: null })
  const deleteUser = vi.fn().mockResolvedValue({ error: null })
  return {
    storage: { from: vi.fn(() => ({ list, remove })) },
    from: vi.fn(() => ({
      delete: () => ({
        eq: async () => ({ error: null }),
      }),
    })),
    auth: { admin: { deleteUser } },
    deleteUser,
  }
}

describe('preflightStripeAccountDeletion', () => {
  it('allows deletion when the user has no Stripe customer mapping', async () => {
    const getCustomerId = vi.fn().mockResolvedValue(null)
    const result = await preflightStripeAccountDeletion({}, USER_ID, {
      getCustomerId,
      stripeConfigured: () => true,
      getStripeClient: async () => ({ subscriptions: { list: vi.fn() } }),
    })
    expect(result).toBeNull()
    expect(getCustomerId).toHaveBeenCalledWith({}, USER_ID)
  })

  it('blocks deletion while a renewing Stripe subscription is still live', async () => {
    const list = vi.fn().mockResolvedValue({
      data: [{ id: 'sub_1', status: 'active', cancel_at_period_end: false }],
    })
    const result = await preflightStripeAccountDeletion({}, USER_ID, {
      getCustomerId: async () => 'cus_1',
      stripeConfigured: () => true,
      getStripeClient: async () => ({ subscriptions: { list } }),
    })
    expect(result?.status).toBe(409)
    expect(result?.body?.error).toBe('active_subscription')
    expect(list).toHaveBeenCalledWith({ customer: 'cus_1', status: 'all', limit: 20 })
  })

  it('allows deletion after cancel-at-period-end (no further renewals)', async () => {
    const result = await preflightStripeAccountDeletion({}, USER_ID, {
      getCustomerId: async () => 'cus_1',
      stripeConfigured: () => true,
      getStripeClient: async () => ({
        subscriptions: {
          list: async () => ({
            data: [{ id: 'sub_1', status: 'active', cancel_at_period_end: true }],
          }),
        },
      }),
    })
    expect(result).toBeNull()
  })

  it('fails closed when Stripe status cannot be verified', async () => {
    const result = await preflightStripeAccountDeletion({}, USER_ID, {
      getCustomerId: async () => 'cus_1',
      stripeConfigured: () => false,
      getStripeClient: async () => null,
    })
    expect(result?.status).toBe(503)
    expect(result?.body?.error).toBe('account_delete_temporarily_unavailable')
  })
})

describe('handleDeleteAccount Stripe guard', () => {
  beforeEach(() => {
    verifyJwtMock.mockReset()
    getAdminClientMock.mockReset()
    getStripeCustomerIdMock.mockReset()
    getStripeMock.mockReset()
    isStripeConfiguredMock.mockReset()
    prepareAppleIapLedgerForAccountDeletionMock.mockReset()
    isStripeConfiguredMock.mockReturnValue(true)
    prepareAppleIapLedgerForAccountDeletionMock.mockResolvedValue({
      table: 'apple_iap_transactions',
      blocked: false,
      reason: 'new_ledger_marked_account_deleted',
    })
  })

  it('does not delete the auth user when Stripe still has a renewing subscription', async () => {
    const db = makeDb()
    verifyJwtMock.mockResolvedValue({ userId: USER_ID, email: 'a@example.com' })
    getAdminClientMock.mockReturnValue(db)
    getStripeCustomerIdMock.mockResolvedValue('cus_live')
    getStripeMock.mockResolvedValue({
      subscriptions: {
        list: async () => ({
          data: [{ id: 'sub_live', status: 'active', cancel_at_period_end: false }],
        }),
      },
    })

    const res = fakeRes()
    await handleDeleteAccount({ headers: { authorization: 'Bearer tok' } }, res)

    expect(res.statusCode).toBe(409)
    expect(res.body.error).toBe('active_subscription')
    expect(db.deleteUser).not.toHaveBeenCalled()
    expect(prepareAppleIapLedgerForAccountDeletionMock).not.toHaveBeenCalled()
  })

  it('proceeds with deletion when Stripe customer has no blocking subscription', async () => {
    const db = makeDb()
    verifyJwtMock.mockResolvedValue({ userId: USER_ID, email: 'a@example.com' })
    getAdminClientMock.mockReturnValue(db)
    getStripeCustomerIdMock.mockResolvedValue('cus_done')
    getStripeMock.mockResolvedValue({
      subscriptions: {
        list: async () => ({
          data: [{ id: 'sub_done', status: 'canceled', cancel_at_period_end: false }],
        }),
      },
    })

    const res = fakeRes()
    await handleDeleteAccount({ headers: { authorization: 'Bearer tok' } }, res)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(db.deleteUser).toHaveBeenCalledWith(USER_ID)
    expect(prepareAppleIapLedgerForAccountDeletionMock).toHaveBeenCalled()
  })
})
