import { afterEach, describe, expect, it } from 'vitest'
import { Environment, Type } from '@apple/app-store-server-library'
import { assertNotificationLineage, environmentTryOrder, normalizeDecodedTransaction } from './iapApple.mjs'

const baseDecoded = {
  bundleId: 'com.aydenz.youmilensipad',
  environment: 'Sandbox',
  transactionId: 'tx-1',
  originalTransactionId: 'orig-1',
  productId: 'com.aydenz.youmilensipad.studentbasic30d',
  purchaseDate: Date.parse('2026-06-10T12:00:00Z'),
  expiresDate: Date.parse('2099-01-01T00:00:00Z'),
  type: Type.CONSUMABLE,
}

describe('signed notification component consistency', () => {
  const tx = { environment: 'Production', originalTransactionId: 'chain', appAccountToken: 'OWNER' }
  it('accepts matching components', () => expect(() => assertNotificationLineage('Production', tx, { environment: 'Production', originalTransactionId: 'chain', appAccountToken: 'owner' })).not.toThrow())
  it('rejects cross-environment transaction', () => expect(() => assertNotificationLineage('Sandbox', tx, null)).toThrow(/environment/))
  it('rejects cross-environment renewal', () => expect(() => assertNotificationLineage('Production', tx, { environment: 'Sandbox' })).toThrow(/environment/))
  it('rejects renewal from another Apple chain', () => expect(() => assertNotificationLineage('Production', tx, { originalTransactionId: 'other' })).toThrow(/originalTransactionId/))
  it('rejects inconsistent signed account tokens', () => expect(() => assertNotificationLineage('Production', tx, { appAccountToken: 'other' })).toThrow(/appAccountToken/))
})

function normalize(decoded = {}) {
  return normalizeDecodedTransaction(
    { ...baseDecoded, ...decoded },
    {
      expectedBundleId: 'com.aydenz.youmilensipad',
      expectedEnvironment: 'Sandbox',
    },
  )
}

describe('normalizeDecodedTransaction', () => {
  it('accepts a valid consumable Student Basic transaction', () => {
    expect(normalize()).toMatchObject({
      productId: 'com.aydenz.youmilensipad.studentbasic30d',
      transactionId: 'tx-1',
      originalTransactionId: 'orig-1',
      purchaseDate: '2026-06-10T12:00:00.000Z',
      appleExpiresDate: '2099-01-01T00:00:00.000Z',
      productType: Type.CONSUMABLE,
    })
  })

  it('keeps the legacy Student Pass non-consumable compatible', () => {
    expect(normalize({
      productId: 'com.aydenz.youmilensipad.studentpass30d',
      type: Type.NON_CONSUMABLE,
    })).toMatchObject({
      productId: 'com.aydenz.youmilensipad.studentpass30d',
      productType: Type.NON_CONSUMABLE,
    })
  })

  it('rejects wrong bundle ID', () => {
    expect(() => normalize({ bundleId: 'com.example.other' })).toThrow(/bundle identifier/)
  })

  it('rejects wrong environment', () => {
    expect(() => normalize({ environment: 'Production' })).toThrow(/environment/)
  })

  it('rejects a missing purchaseDate', () => {
    expect(() => normalize({ purchaseDate: undefined })).toThrow(/purchaseDate/)
  })

  it('rejects unknown product IDs', () => {
    expect(() => normalize({ productId: 'com.example.other' })).toThrow(/not supported/)
  })

  it('rejects a mismatched non-consumable type for the new product', () => {
    expect(() => normalize({ type: Type.NON_CONSUMABLE })).toThrow(/type/)
  })

  it('rejects auto-renewable subscription transactions', () => {
    expect(() => normalize({ type: Type.AUTO_RENEWABLE_SUBSCRIPTION })).toThrow(/type/)
  })

  it('normalizes a monthly auto-renewable subscription with the ownership fields', () => {
    const result = normalize({
      productId: 'com.aydenz.youmilensipad.student.monthly',
      type: Type.AUTO_RENEWABLE_SUBSCRIPTION,
      subscriptionGroupIdentifier: '22109238',
      inAppOwnershipType: 'PURCHASED',
      appAccountToken: '00000000-0000-4000-8000-000000000000',
      expiresDate: Date.parse('2099-01-01T00:00:00Z'),
    })
    expect(result.autoRenewable).toBe(true)
    expect(result.subscriptionGroupId).toBe('22109238')
    expect(result.ownershipType).toBe('PURCHASED')
    expect(result.appAccountToken).toBe('00000000-0000-4000-8000-000000000000')
    // Subscription JWS payload must never be persisted.
    expect(result.rawTransaction).toBeNull()
  })

  it('rejects an auto-renewable subscription missing expiresDate', () => {
    expect(() => normalize({
      productId: 'com.aydenz.youmilensipad.student.monthly',
      type: Type.AUTO_RENEWABLE_SUBSCRIPTION,
      subscriptionGroupIdentifier: '22109238',
      inAppOwnershipType: 'PURCHASED',
      expiresDate: undefined,
    })).toThrow(/expiresDate/)
  })

  it('rejects an auto-renewable subscription from the wrong group', () => {
    expect(() => normalize({
      productId: 'com.aydenz.youmilensipad.student.monthly',
      type: Type.AUTO_RENEWABLE_SUBSCRIPTION,
      subscriptionGroupIdentifier: '99999999',
      inAppOwnershipType: 'PURCHASED',
      expiresDate: Date.parse('2099-01-01T00:00:00Z'),
    })).toThrow(/group/)
  })
})

describe('environmentTryOrder', () => {
  const original = process.env.APPLE_IAP_ENVIRONMENT
  afterEach(() => {
    if (original === undefined) delete process.env.APPLE_IAP_ENVIRONMENT
    else process.env.APPLE_IAP_ENVIRONMENT = original
  })

  it('attempts both Production and Sandbox so one backend serves TestFlight + App Store', () => {
    delete process.env.APPLE_IAP_ENVIRONMENT // default (Sandbox preferred)
    const order = environmentTryOrder()
    expect(order).toContain(Environment.PRODUCTION)
    expect(order).toContain(Environment.SANDBOX)
    expect(new Set(order).size).toBe(order.length) // de-duplicated
  })

  it('prefers the configured environment first', () => {
    process.env.APPLE_IAP_ENVIRONMENT = 'Production'
    expect(environmentTryOrder()[0]).toBe(Environment.PRODUCTION)
    expect(environmentTryOrder()).toContain(Environment.SANDBOX)

    process.env.APPLE_IAP_ENVIRONMENT = 'Sandbox'
    expect(environmentTryOrder()[0]).toBe(Environment.SANDBOX)
    expect(environmentTryOrder()).toContain(Environment.PRODUCTION)
  })
})
