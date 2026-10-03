import { appleServerApiConfigured, fetchVerifiedSubscriptionStatus } from './iapApple.mjs'

/** Repair missed notifications using Apple evidence, never an optimistic extension.
 * Reads are bounded; a late Apple response cannot start a database write.
 */
export function createSubscriptionServerReconciler({ fetchStatus = fetchVerifiedSubscriptionStatus,
  configured = appleServerApiConfigured, now = Date.now, timeoutMs = 5000 } = {}) {
  const flights = new Map(), attempts = new Map()
  return async function reconcile(row, persist) {
    if (!configured() || !['Production', 'Sandbox'].includes(row.environment)) return row
    const key = `${row.user_id}:${row.environment}:${row.original_transaction_id}`
    if (flights.has(key)) return flights.get(key)
    const previous = attempts.get(key), expiry = Date.parse(row.expires_at)
    // A read just before expiry must not suppress the first read after expiry.
    const crossedExpiry = previous !== undefined && previous < expiry && now() >= expiry
    if (previous !== undefined && !crossedExpiry && now() - previous < 60_000) return row
    const run = async () => {
      let timer
      try {
        const snapshot = await Promise.race([
          fetchStatus(row.original_transaction_id, row.environment),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Apple status timeout')), timeoutMs) }),
        ])
        if (!snapshot) return row
        if (snapshot.transaction.originalTransactionId !== row.original_transaction_id ||
            snapshot.transaction.environment !== row.environment) throw new Error('Apple status lineage mismatch')
        return await persist(snapshot)
      } catch {
        // Existing expiry/revocation remains authoritative during an outage.
        return row
      } finally {
        clearTimeout(timer)
        attempts.delete(key); attempts.set(key, now())
        if (attempts.size > 1024) attempts.delete(attempts.keys().next().value)
      }
    }
    const flight = Promise.resolve().then(run).finally(() => flights.delete(key))
    flights.set(key, flight)
    return flight
  }
}

export const reconcileSubscriptionFromApple = createSubscriptionServerReconciler()
