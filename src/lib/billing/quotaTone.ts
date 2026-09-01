/**
 * Semantic presentation tone for one quota metric's progress bar.
 *
 * No shared iOS/cross-platform threshold was found in this repository (the
 * iPad app lives in a separate repo and was not source-audited for this
 * change — see the QA16 report). This is the smallest explicit rule that
 * still gives the user real warning before they run out: "warning" starts
 * at 20% of the allowance remaining, matching the common low-battery-style
 * convention, and "exhausted" is reserved for genuinely zero remaining.
 */
export type QuotaTone = 'normal' | 'warning' | 'exhausted'

export const QUOTA_WARNING_REMAINING_RATIO = 0.2

/** `limit == null` means "no known cap" (e.g. unlimited) — always presented as normal. */
export function quotaTone(used: number | null, limit: number | null): QuotaTone {
  if (limit == null || limit <= 0) return 'normal'
  const remaining = Math.max(0, limit - (used ?? 0))
  if (remaining <= 0) return 'exhausted'
  if (remaining / limit <= QUOTA_WARNING_REMAINING_RATIO) return 'warning'
  return 'normal'
}

/** Percentage of the allowance consumed, clamped to [0, 100]. `null` when there is no known limit. */
export function quotaUsedPercent(used: number | null, limit: number | null): number | null {
  if (limit == null || limit <= 0) return null
  const pct = ((used ?? 0) / limit) * 100
  return Math.min(100, Math.max(0, pct))
}
