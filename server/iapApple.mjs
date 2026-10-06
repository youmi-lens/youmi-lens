/**
 * Apple App Store server-side verification for Youmi Lens.
 *
 * Monthly and annual auto-renewables use Apple period expiry. The retired
 * Student Pass NON-CONSUMABLE remains verifiable for existing transactions.
 * modern, Apple-supported JWS path (@apple/app-store-server-library):
 *   - SignedDataVerifier.verifyAndDecodeTransaction  — signed StoreKit 2 txns
 *   - SignedDataVerifier.verifyAndDecodeNotification — App Store Server Notif. V2
 *   - AppStoreServerAPIClient.getTransactionInfo     — fetch a signed txn by id
 *
 * The DECODED Apple transaction is authoritative. We never trust client-supplied
 * productId / transactionId / purchaseDate / expiry / plan type / status; any
 * client value passed in must MATCH the decoded value or we reject.
 *
 * This module performs no grant decision. Apple expiry is authoritative for
 * subscriptions; only retired passes use a server-computed 30-day window.
 *
 * Secrets (private key, JWS, JWT) are never logged here or by callers.
 */
import { readFileSync } from 'node:fs'
import {
  AppStoreServerAPIClient,
  Environment,
  SignedDataVerifier,
  Type,
} from '@apple/app-store-server-library'

const VALID_ENVIRONMENTS = new Set([
  Environment.SANDBOX,
  Environment.PRODUCTION,
  Environment.XCODE,
  Environment.LOCAL_TESTING,
])
export const STUDENT_BASIC_PRODUCT_ID = 'com.aydenz.youmilensipad.studentbasic30d'
export const LEGACY_STUDENT_PASS_PRODUCT_ID = 'com.aydenz.youmilensipad.studentpass30d'
export const STUDENT_MONTHLY_PRODUCT_ID = 'com.aydenz.youmilensipad.student.monthly'
export const STUDENT_ANNUAL_PRODUCT_ID = 'com.aydenz.youmilensipad.student.annual'
export const STUDENT_SUBSCRIPTION_GROUP_ID = '22109238'
const SUPPORTED_OWNERSHIP_TYPES = new Set(['PURCHASED', 'FAMILY_SHARED'])
const SUPPORTED_PRODUCT_TYPES = new Map([
  [STUDENT_BASIC_PRODUCT_ID, Type.CONSUMABLE],
  [LEGACY_STUDENT_PASS_PRODUCT_ID, Type.NON_CONSUMABLE],
  [STUDENT_MONTHLY_PRODUCT_ID, Type.AUTO_RENEWABLE_SUBSCRIPTION],
  [STUDENT_ANNUAL_PRODUCT_ID, Type.AUTO_RENEWABLE_SUBSCRIPTION],
])

const verifiers = new Map()
const apiClients = new Map()

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

function normalizeApplePrivateKey(value) {
  return value.replace(/\\n/g, '\n')
}

/**
 * The Apple environment this server PREFERS (Sandbox vs Production).
 *
 * NOT an isolation mechanism. It only decides the order in which `environmentTryOrder()` attempts
 * verification (configured first, then Production, then Sandbox); every environment is still tried, so
 * one backend serves TestFlight/Sandbox and live App Store users at once and its value does not gate
 * access. Environment isolation lives elsewhere: Apple signs the environment into each transaction,
 * the verified environment is pinned to the subscription chain, and a non-Production chain only grants
 * access with an explicit `subscription_test_chain_policy` row (enforced in the database).
 * Also read by /api/health (diagnostics). An invalid value throws, which breaks all verification.
 */
export function appleEnvironment() {
  const raw = process.env.APPLE_IAP_ENVIRONMENT?.trim() || Environment.SANDBOX
  const match = Object.values(Environment).find((value) => value.toLowerCase() === raw.toLowerCase())
  if (!match || !VALID_ENVIRONMENTS.has(match)) {
    throw new Error('APPLE_IAP_ENVIRONMENT must be Sandbox, Production, Xcode, or LocalTesting')
  }
  return match
}

function loadRootCertificates() {
  const certs = []
  const paths = process.env.APPLE_IAP_ROOT_CERTIFICATE_PATHS
    ?.split(',')
    .map((p) => p.trim())
    .filter(Boolean) ?? []
  for (const path of paths) certs.push(readFileSync(path))

  const base64Certs = process.env.APPLE_IAP_ROOT_CERTIFICATES_BASE64
    ?.split(',')
    .map((p) => p.trim())
    .filter(Boolean) ?? []
  for (const encoded of base64Certs) certs.push(Buffer.from(encoded, 'base64'))

  if (certs.length === 0) {
    throw new Error('Apple root certificates are not configured')
  }
  return certs
}

function buildVerifier(environment) {
  const bundleId = requiredEnv('APPLE_BUNDLE_ID')
  const appAppleIdRaw = process.env.APPLE_APP_APPLE_ID?.trim()
  const appAppleId = appAppleIdRaw ? Number(appAppleIdRaw) : undefined
  if (environment === Environment.PRODUCTION && !Number.isFinite(appAppleId)) {
    throw new Error('APPLE_APP_APPLE_ID is required for Production verification')
  }
  return new SignedDataVerifier(
    loadRootCertificates(),
    process.env.APPLE_IAP_ENABLE_ONLINE_CHECKS !== 'false',
    environment,
    bundleId,
    appAppleId,
  )
}

function getVerifierForEnvironment(environment) {
  let v = verifiers.get(environment)
  if (!v) {
    v = buildVerifier(environment)
    verifiers.set(environment, v)
  }
  return v
}

/**
 * Apple environments to attempt, in order. The configured APPLE_IAP_ENVIRONMENT
 * is preferred, then Production, then Sandbox. ONE backend therefore serves both
 * TestFlight (Sandbox transactions) and the App Store (Production transactions):
 * Apple embeds the environment inside the signed transaction, so we accept
 * whichever environment cryptographically verifies instead of rejecting on a
 * single static config (which would make either TestFlight or production fail).
 */
export function environmentTryOrder() {
  const order = [appleEnvironment(), Environment.PRODUCTION, Environment.SANDBOX]
  return [...new Set(order)]
}

/**
 * Verify + decode a signed transaction against each candidate environment until
 * one succeeds. Returns the decoded payload and the environment that verified it.
 */
async function verifyAndDecodeTransactionAnyEnvironment(signedTransactionInfo) {
  let lastError = null
  for (const environment of environmentTryOrder()) {
    try {
      const decoded = await getVerifierForEnvironment(environment).verifyAndDecodeTransaction(signedTransactionInfo)
      return { decoded, environment }
    } catch (err) {
      lastError = err
    }
  }
  throw lastError ?? new Error('Transaction could not be verified in any Apple environment')
}

/** Verify + decode a notification against each candidate environment. */
async function verifyAndDecodeNotificationAnyEnvironment(signedPayload) {
  let lastError = null
  for (const environment of environmentTryOrder()) {
    try {
      const decoded = await getVerifierForEnvironment(environment).verifyAndDecodeNotification(signedPayload)
      return { decoded, environment }
    } catch (err) {
      lastError = err
    }
  }
  throw lastError ?? new Error('Notification could not be verified in any Apple environment')
}

function getApiClient(environment = appleEnvironment()) {
  if (![Environment.PRODUCTION, Environment.SANDBOX].includes(environment)) throw new Error('Apple server API environment is unsupported')
  if (!apiClients.has(environment)) apiClients.set(environment, new AppStoreServerAPIClient(
    normalizeApplePrivateKey(requiredEnv('APPLE_IAP_PRIVATE_KEY')),
    requiredEnv('APPLE_IAP_KEY_ID'), requiredEnv('APPLE_IAP_ISSUER_ID'),
    requiredEnv('APPLE_BUNDLE_ID'), environment,
  ))
  return apiClients.get(environment)
}

export function appleServerApiConfigured() {
  return ['APPLE_IAP_PRIVATE_KEY','APPLE_IAP_KEY_ID','APPLE_IAP_ISSUER_ID','APPLE_BUNDLE_ID']
    .every(name => Boolean(process.env[name]?.trim()))
}

function normalizeRenewalInfo(info, environment) {
  if (info.environment && info.environment !== environment) throw new Error('Renewal environment does not match verified environment')
  return {
    environment, originalTransactionId: info.originalTransactionId ?? null,
    productId: info.productId ?? null, autoRenewProductId: info.autoRenewProductId ?? null,
    autoRenewStatus: info.autoRenewStatus === 1 ? true : info.autoRenewStatus === 0 ? false : null,
    isInBillingRetryPeriod: info.isInBillingRetryPeriod === true,
    gracePeriodExpiresDate: isoFromAppleMs(info.gracePeriodExpiresDate),
    renewalDate: isoFromAppleMs(info.renewalDate), expirationIntent: info.expirationIntent ?? null,
    appAccountToken: info.appAccountToken ?? null, signedDate: isoFromAppleMs(info.signedDate),
    renewalPrice: info.renewalPrice ?? null, currency: info.currency ?? null,
  }
}

/** Read-only Apple status fetch; only a caller's already-canonical chain is returned. */
export async function fetchVerifiedSubscriptionStatus(originalTransactionId, environment) {
  const response = await getApiClient(environment).getAllSubscriptionStatuses(originalTransactionId)
  for (const group of response?.data ?? []) for (const item of group.lastTransactions ?? []) {
    if (String(item.originalTransactionId) !== String(originalTransactionId)) continue
    if (!item.signedTransactionInfo || !item.signedRenewalInfo || ![1,2,3,4,5].includes(item.status)) throw new Error('Apple subscription status is incomplete')
    const verifier = getVerifierForEnvironment(environment)
    const transaction = normalizeDecodedTransaction(await verifier.verifyAndDecodeTransaction(item.signedTransactionInfo),
      {expectedBundleId: requiredEnv('APPLE_BUNDLE_ID'), expectedEnvironment: environment})
    const renewal = normalizeRenewalInfo(await verifier.verifyAndDecodeRenewalInfo(item.signedRenewalInfo), environment)
    assertNotificationLineage(environment, transaction, renewal)
    if (transaction.originalTransactionId !== originalTransactionId) throw new Error('Apple status chain does not match canonical binding')
    const dates = [transaction.appleSignedAt, renewal.signedDate].filter(Boolean).sort()
    return {transaction, renewal, appleStatus: item.status, appleEventAt: dates.at(-1) ?? transaction.purchaseDate}
  }
  return null
}

function isoFromAppleMs(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/**
 * Normalize a verified, decoded Apple transaction into our internal shape.
 *
 * Pure (no I/O) so it is directly unit-testable: callers pass a decoded payload
 * plus the expected bundle id / environment. Validates signature-independent
 * invariants: bundle id, environment, and the presence of transactionId /
 * productId / purchaseDate. Does NOT map a plan or decide active/expired — that
 * is the backend's job from billing_products + the computed window.
 *
 * @param {object} decoded  JWSTransactionDecodedPayload (already signature-verified)
 * @param {{ expectedBundleId: string, expectedEnvironment: string }} config
 */
export function normalizeDecodedTransaction(decoded, { expectedBundleId, expectedEnvironment }) {
  if (!decoded || typeof decoded !== 'object') {
    throw new Error('Decoded transaction is missing')
  }
  if (decoded.bundleId !== expectedBundleId) {
    throw new Error('Transaction bundle identifier does not match this app')
  }
  if (decoded.environment !== expectedEnvironment) {
    // Rejects e.g. a Sandbox transaction when the server is configured Production.
    throw new Error('Transaction environment does not match server configuration')
  }
  if (!decoded.transactionId) throw new Error('Verified transaction is missing transactionId')
  if (!decoded.productId) throw new Error('Verified transaction is missing productId')
  if (typeof decoded.purchaseDate !== 'number' || !Number.isFinite(decoded.purchaseDate)) {
    throw new Error('Verified transaction is missing purchaseDate')
  }
  const expectedProductType = SUPPORTED_PRODUCT_TYPES.get(decoded.productId)
  if (!expectedProductType) {
    throw new Error('Verified transaction product is not supported')
  }
  if (decoded.type !== expectedProductType) {
    throw new Error('Verified transaction type does not match the supported product')
  }

  const autoRenewable = expectedProductType === Type.AUTO_RENEWABLE_SUBSCRIPTION
  if (autoRenewable && !decoded.originalTransactionId) throw new Error('Verified subscription is missing originalTransactionId')
  if (autoRenewable && (typeof decoded.expiresDate !== 'number' || !Number.isFinite(decoded.expiresDate))) {
    throw new Error('Verified subscription transaction is missing expiresDate')
  }
  if (autoRenewable && String(decoded.subscriptionGroupIdentifier ?? '') !== STUDENT_SUBSCRIPTION_GROUP_ID) {
    throw new Error('Verified subscription transaction is from the wrong subscription group')
  }
  if (autoRenewable && !SUPPORTED_OWNERSHIP_TYPES.has(decoded.inAppOwnershipType)) {
    throw new Error('Verified subscription transaction has an invalid ownership type')
  }

  return {
    productId: decoded.productId,
    transactionId: decoded.transactionId,
    originalTransactionId: decoded.originalTransactionId ?? decoded.transactionId,
    environment: decoded.environment,
    productType: decoded.type ?? null,
    appleSignedAt: isoFromAppleMs(decoded.signedDate),
    purchaseDateMs: decoded.purchaseDate,
    purchaseDate: isoFromAppleMs(decoded.purchaseDate),
    // Consumables ignore Apple's expiresDate; for auto-renewable subscriptions it
    // is the current period end / next renewal boundary and drives entitlement.
    appleExpiresDate: isoFromAppleMs(decoded.expiresDate),
    expiresDateMs: typeof decoded.expiresDate === 'number' ? decoded.expiresDate : null,
    revokedAt: isoFromAppleMs(decoded.revocationDate),
    revoked: Boolean(decoded.revocationDate),
    appAccountToken: decoded.appAccountToken ?? null,
    subscriptionGroupId: decoded.subscriptionGroupIdentifier ?? null,
    ownershipType: decoded.inAppOwnershipType ?? null,
    autoRenewable,
    offerType: decoded.offerType ?? null, offerDiscountType: decoded.offerDiscountType ?? null,
    price: decoded.price ?? null, currency: decoded.currency ?? null,
    // Legacy rows retain their existing decoded payload behavior. New
    // subscriptions persist only normalized fields, never the full JWS payload.
    rawTransaction: autoRenewable ? null : decoded,
  }
}

/** Fetch a signed transaction by id from the App Store Server API (used by restore). */
export async function fetchSignedTransactionInfo(transactionId) {
  if (!transactionId || typeof transactionId !== 'string') {
    throw new Error('transactionId is required')
  }
  for (const environment of environmentTryOrder().filter(env => ['Production','Sandbox'].includes(env))) {
    try {
      const response = await getApiClient(environment).getTransactionInfo(transactionId)
      if (!response?.signedTransactionInfo) throw new Error('Apple did not return signed transaction info')
      return response.signedTransactionInfo
    } catch (error) {
      if (error.httpStatusCode !== 404) throw error
    }
  }
  throw new Error('Apple transaction was not found in Production or Sandbox')
}

/**
 * Verify + decode a StoreKit 2 signed transaction (the authoritative path).
 * Accepts either the JWS directly (signedTransactionInfo / purchaseToken) or a
 * transactionId we can look up via the App Store Server API. Any client-supplied
 * productId / transactionId / originalTransactionId must match the decoded values.
 */
export async function verifyAppleTransaction(input = {}) {
  const signedTransactionInfo =
    input.signedTransactionInfo ||
    input.purchaseToken ||
    (input.transactionId ? await fetchSignedTransactionInfo(input.transactionId) : null)

  if (!signedTransactionInfo || typeof signedTransactionInfo !== 'string') {
    throw new Error('signedTransactionInfo or purchaseToken is required')
  }

  const { decoded, environment } = await verifyAndDecodeTransactionAnyEnvironment(signedTransactionInfo)
  const normalized = normalizeDecodedTransaction(decoded, {
    expectedBundleId: requiredEnv('APPLE_BUNDLE_ID'),
    expectedEnvironment: environment,
  })

  if (input.productId && input.productId !== normalized.productId) {
    throw new Error('Client productId does not match verified transaction')
  }
  if (input.transactionId && input.transactionId !== normalized.transactionId) {
    throw new Error('Client transactionId does not match verified transaction')
  }
  if (
    input.originalTransactionId &&
    input.originalTransactionId !== normalized.originalTransactionId
  ) {
    throw new Error('Client originalTransactionId does not match verified transaction')
  }

  return normalized
}

/**
 * Verify + decode an App Store Server Notification V2 `signedPayload` and, when
 * present, the embedded signed transaction. Returns a compact, audit-safe shape.
 * Accepts Sandbox or Production notifications (the same backend serves both).
 */
export function assertNotificationLineage(environment, transaction, renewal) {
  if (transaction && transaction.environment !== environment) throw new Error('Transaction environment does not match notification')
  if (renewal?.environment && renewal.environment !== environment) throw new Error('Renewal info environment does not match notification')
  if (transaction && renewal?.originalTransactionId && renewal.originalTransactionId !== transaction.originalTransactionId) {
    throw new Error('Renewal info originalTransactionId does not match transaction')
  }
  if (transaction?.appAccountToken && renewal?.appAccountToken && transaction.appAccountToken.toLowerCase() !== renewal.appAccountToken.toLowerCase()) {
    throw new Error('Renewal info appAccountToken does not match transaction')
  }
}

export async function verifyAppleNotification(signedPayload) {
  if (!signedPayload || typeof signedPayload !== 'string') {
    throw new Error('signedPayload is required')
  }
  const { decoded, environment: verifiedEnvironment } = await verifyAndDecodeNotificationAnyEnvironment(signedPayload)
  const env = decoded?.data?.environment ?? verifiedEnvironment
  if (env !== verifiedEnvironment) throw new Error('Notification environment does not match verified environment')

  let transaction = null
  const signedTransactionInfo = decoded?.data?.signedTransactionInfo
  if (signedTransactionInfo) {
    const { decoded: decodedTx, environment: txEnvironment } =
      await verifyAndDecodeTransactionAnyEnvironment(signedTransactionInfo)
    transaction = normalizeDecodedTransaction(decodedTx, {
      expectedBundleId: requiredEnv('APPLE_BUNDLE_ID'),
      expectedEnvironment: txEnvironment,
    })
  }

  let renewal = null
  const signedRenewalInfo = decoded?.data?.signedRenewalInfo
  if (signedRenewalInfo) {
    const renewalInfo = await getVerifierForEnvironment(verifiedEnvironment).verifyAndDecodeRenewalInfo(signedRenewalInfo)
    if (renewalInfo.environment && renewalInfo.environment !== verifiedEnvironment) {
      throw new Error('Renewal info environment does not match notification')
    }
    renewal = normalizeRenewalInfo(renewalInfo, verifiedEnvironment)
  }

  assertNotificationLineage(env, transaction, renewal)

  return {
    appleEventAt: isoFromAppleMs(decoded?.signedDate),
    notificationType: decoded?.notificationType ?? null,
    subtype: decoded?.subtype ?? null,
    notificationUUID: decoded?.notificationUUID ?? null,
    environment: env,
    transaction,
    renewal,
  }
}
