import { BETA_ERROR_CODES, getAdminClient, verifyJwt } from './betaGate.mjs'
import {
  isAppleIapLedgerUnavailableError,
  isMissingAppleIapLedgerTableError,
  prepareAppleIapLedgerForAccountDeletion,
} from './iapLedger.mjs'
import { getStripe, isStripeConfigured } from './stripeClient.mjs'
import { getStripeCustomerId } from './stripeCustomers.mjs'
import { stripeSubscriptionBlocksAccountDeletion } from './stripeSubscriptions.mjs'

const AUDIO_BUCKET = 'lecture-audio'
const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205', 'PGRST116'])

function isMissingTableError(error) {
  if (!error) return false
  if (isMissingAppleIapLedgerTableError(error)) return true
  if (MISSING_TABLE_CODES.has(error.code)) return true
  const message = `${error.message ?? ''} ${error.details ?? ''}`.toLowerCase()
  return message.includes('does not exist') || message.includes('could not find the table')
}

function isTemporaryDatabaseStateError(error) {
  if (isAppleIapLedgerUnavailableError(error)) return true
  if (['42P01', 'PGRST205', '42501', '42703', '23514', 'PGRST100', '57014'].includes(String(error?.code ?? ''))) {
    return true
  }
  return /fetch failed|timeout|timed out/i.test(String(error?.message ?? ''))
}

async function deleteRows(db, table, column, value) {
  const { error } = await db.from(table).delete().eq(column, value)
  if (error && !isMissingTableError(error)) throw error
  return { table, skipped: Boolean(error), error: error?.message ?? null }
}

async function prepareAppleTransactionsForAccountDeletion(db, userId) {
  const result = await prepareAppleIapLedgerForAccountDeletion(db, userId)
  if (result.blocked) {
    const err = new Error('Account deletion is temporarily unavailable.')
    err.name = 'AccountDeletionTemporarilyUnavailableError'
    throw err
  }
  return {
    table: result.table,
    skipped: false,
    reason: result.reason ?? null,
    error: null,
  }
}

/**
 * Fail closed when Stripe would keep charging after auth.users CASCADE removes
 * the customer mapping (Portal becomes unreachable). Pure predicate coverage
 * lives on `stripeSubscriptionBlocksAccountDeletion`.
 *
 * Returns null when deletion may proceed, or an HTTP error payload to send.
 */
export async function preflightStripeAccountDeletion(db, userId, {
  stripeConfigured = isStripeConfigured,
  getStripeClient = getStripe,
  getCustomerId = getStripeCustomerId,
} = {}) {
  const customerId = await getCustomerId(db, userId)
  if (!customerId) return null

  if (!stripeConfigured()) {
    return {
      status: 503,
      body: {
        ok: false,
        error: 'account_delete_temporarily_unavailable',
        message:
          'Account deletion is temporarily unavailable while billing status cannot be verified. Please try again later or contact support.',
      },
    }
  }

  const stripe = await getStripeClient()
  if (!stripe) {
    return {
      status: 503,
      body: {
        ok: false,
        error: 'account_delete_temporarily_unavailable',
        message:
          'Account deletion is temporarily unavailable while billing status cannot be verified. Please try again later or contact support.',
      },
    }
  }

  let subs
  try {
    const list = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 20 })
    subs = Array.isArray(list?.data) ? list.data : []
  } catch {
    return {
      status: 503,
      body: {
        ok: false,
        error: 'account_delete_temporarily_unavailable',
        message:
          'Account deletion is temporarily unavailable while billing status cannot be verified. Please try again later or contact support.',
      },
    }
  }

  if (subs.some((sub) => stripeSubscriptionBlocksAccountDeletion(sub))) {
    return {
      status: 409,
      body: {
        ok: false,
        error: 'active_subscription',
        message:
          'Cancel your Student Basic subscription (Manage plan) before deleting your account. Otherwise billing can continue after the account is removed.',
      },
    }
  }

  return null
}

async function listStoragePaths(storage, prefix) {
  const paths = []
  const stack = [prefix]

  while (stack.length > 0) {
    const current = stack.pop()
    let offset = 0

    while (true) {
      const { data, error } = await storage.list(current, {
        limit: 100,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      })
      if (error) throw error
      const entries = data ?? []
      for (const entry of entries) {
        const path = `${current}/${entry.name}`
        if (entry.id === null) stack.push(path)
        else paths.push(path)
      }
      if (entries.length < 100) break
      offset += entries.length
    }
  }

  return paths
}

async function removeStoragePrefix(db, userId) {
  const storage = db.storage.from(AUDIO_BUCKET)
  const paths = await listStoragePaths(storage, userId)
  let removed = 0

  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100)
    if (chunk.length === 0) continue
    const { error } = await storage.remove(chunk)
    if (error) throw error
    removed += chunk.length
  }

  return { bucket: AUDIO_BUCKET, prefix: `${userId}/`, removed }
}

export async function handleDeleteAccount(req, res) {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!token) {
    res.status(401).json({ ok: false, error: BETA_ERROR_CODES.AUTH_REQUIRED, message: 'Sign in required.' })
    return
  }

  const user = await verifyJwt(token)
  if (!user) {
    res.status(401).json({ ok: false, error: BETA_ERROR_CODES.AUTH_REQUIRED, message: 'Invalid or expired session.' })
    return
  }

  const db = getAdminClient()
  if (!db) {
    res.status(503).json({ ok: false, error: 'server_not_configured', message: 'Server database is not configured.' })
    return
  }

  const { userId } = user

  try {
    // Stripe must be cleared BEFORE auth.users delete: FK CASCADE drops the
    // customer mapping, after which Portal/cancel is impossible from this app
    // while Stripe may keep renewing.
    const stripeBlock = await preflightStripeAccountDeletion(db, userId)
    if (stripeBlock) {
      res.status(stripeBlock.status).json(stripeBlock.body)
      return
    }

    const deleted = []
    deleted.push(await prepareAppleTransactionsForAccountDeletion(db, userId))
    const storage = await removeStoragePrefix(db, userId)
    deleted.push(await deleteRows(db, 'beta_usage', 'user_id', userId))
    deleted.push(await deleteRows(db, 'recordings', 'user_id', userId))
    deleted.push(await deleteRows(db, 'user_quota', 'user_id', userId))
    deleted.push(await deleteRows(db, 'profiles', 'id', userId))

    const { error: authError } = await db.auth.admin.deleteUser(userId)
    if (authError && !/not found|does not exist/i.test(authError.message ?? '')) {
      throw authError
    }

    console.warn(
      '[account-delete] ok',
      JSON.stringify({
        userIdPrefix: userId.slice(0, 8),
        storageRemoved: storage.removed,
        skippedTables: deleted.filter((entry) => entry.skipped).map((entry) => entry.table),
      }),
    )
    res.json({ ok: true })
  } catch (err) {
    console.error(
      '[account-delete] failed',
      JSON.stringify({
        userIdPrefix: userId.slice(0, 8),
        message: err instanceof Error ? err.message : String(err),
      }),
    )
    if (err?.name === 'AccountDeletionTemporarilyUnavailableError' || isTemporaryDatabaseStateError(err)) {
      res.status(503).json({
        ok: false,
        error: 'account_delete_temporarily_unavailable',
        message: 'Account deletion is temporarily unavailable. Please try again later or contact support.',
      })
      return
    }
    res.status(500).json({
      ok: false,
      error: 'account_delete_failed',
      message: 'Could not delete account. Please try again or contact support.',
    })
  }
}
