/**
 * Youmi Watch — internal cost estimation (Phase 2).
 *
 * Deterministic, dependency-free helpers for turning a metered quantity into an
 * estimated USD cost for the internal cost ledger (watch_cost_events).
 *
 * ⚠️  IMPORTANT — THESE ARE INTERNAL ESTIMATES ONLY.
 *   • The numbers below are rough, hand-entered placeholders for our own
 *     monitoring/budgeting. They are NOT authoritative provider pricing.
 *   • This module NEVER calls a provider pricing API and contains NO secrets.
 *   • Review and tune every constant before using these figures for any real
 *     billing, invoicing, or financial decision. Provider list prices change
 *     and vary by region/commit/tier.
 */

/** Canonical providers — must match the watch_* CHECK constraints. */
export const KNOWN_PROVIDERS = Object.freeze([
  'deepgram',
  'dashscope',
  'brevo',
  'railway',
  'supabase',
  'openai',
])

const PROVIDER_SET = new Set(KNOWN_PROVIDERS)

/** A few friendly aliases → canonical provider. */
const PROVIDER_ALIASES = Object.freeze({
  qwen: 'dashscope',
  'qwen-flash': 'dashscope',
  'qwen-plus': 'dashscope',
  // Historical telemetry only: retained so pre-migration ledger rows remain
  // attributable to DashScope. It is not a selectable inference model.
  'qwen-turbo': 'dashscope',
  dash: 'dashscope',
  gpt: 'openai',
  'open-ai': 'openai',
  sendinblue: 'brevo',
})

/** Unit aliases → canonical unit used by the pricing table. */
const UNIT_ALIASES = Object.freeze({
  min: 'minutes',
  mins: 'minutes',
  minute: 'minutes',
  minutes: 'minutes',
  in: 'tokens_in',
  input: 'tokens_in',
  input_tokens: 'tokens_in',
  tokens_in: 'tokens_in',
  out: 'tokens_out',
  output: 'tokens_out',
  output_tokens: 'tokens_out',
  tokens_out: 'tokens_out',
  token: 'tokens',
  tokens: 'tokens',
  email: 'emails',
  emails: 'emails',
  gb: 'gb',
  gigabyte: 'gb',
  gigabytes: 'gb',
  request: 'requests',
  requests: 'requests',
  check: 'checks',
  checks: 'checks',
  hour: 'hours',
  hours: 'hours',
})

/**
 * Internal estimated unit prices (USD). Token rates are PER 1,000 TOKENS; all
 * other units are per single unit. Estimates only — see the file header.
 */
export const PRICING = Object.freeze({
  deepgram: Object.freeze({
    // Streaming speech-to-text, ~ list estimate per audio minute.
    minutes: 0.0059,
  }),
  dashscope: Object.freeze({
    // Qwen chat — per 1K tokens (rough estimate).
    tokens_in: 0.0004,
    tokens_out: 0.0012,
    tokens: 0.0012, // unspecified direction → treat as output (conservative)
  }),
  openai: Object.freeze({
    // Fallback LLM — per 1K tokens (rough estimate, e.g. a 4o-class model).
    tokens_in: 0.005,
    tokens_out: 0.015,
    tokens: 0.015,
  }),
  brevo: Object.freeze({
    // Transactional email — per send (rough estimate).
    emails: 0.0007,
  }),
  supabase: Object.freeze({
    // Storage — per GB-month (rough estimate). A 'checks' event is monitoring
    // only and has no marginal cost.
    gb: 0.021,
    checks: 0,
  }),
  railway: Object.freeze({
    // Hosting is usage-based; health/deploy checks have no marginal cost. The
    // 'hours' rate is a coarse placeholder for runtime accounting only.
    checks: 0,
    requests: 0,
    hours: 0.01,
  }),
})

/** Token units are priced per 1,000 tokens. */
const PER_1K_UNITS = new Set(['tokens_in', 'tokens_out', 'tokens'])

/** Round to 6 decimals to match numeric(12,6). Non-finite → 0. */
export function round6(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return 0
  return Math.round(x * 1e6) / 1e6
}

/**
 * Normalize a provider string to its canonical form, or null if unknown/empty.
 */
export function normalizeProvider(provider) {
  if (typeof provider !== 'string') return null
  const p = provider.trim().toLowerCase()
  if (!p) return null
  if (PROVIDER_SET.has(p)) return p
  return PROVIDER_ALIASES[p] ?? null
}

/**
 * Normalize a unit string. Returns a canonical unit when recognized, otherwise
 * the lowercased/trimmed input (so unknown-but-present units still record, with
 * a $0 estimate), or null when empty/non-string.
 */
export function normalizeUnit(unit) {
  if (typeof unit !== 'string') return null
  const u = unit.trim().toLowerCase()
  if (!u) return null
  return UNIT_ALIASES[u] ?? u
}

/**
 * Estimate USD cost for a metered event. Deterministic; never throws.
 * Unknown provider/unit, or non-positive/invalid quantity → 0.
 *
 * @param {{ provider?: string, unit?: string, quantity?: number, metadata?: object }} input
 *   `metadata` is reserved for future model-specific overrides (unused today).
 * @returns {number} estimated cost in USD, rounded to 6 decimals.
 */
export function estimateCostUsd(input) {
  const src = input && typeof input === 'object' ? input : {}
  const provider = normalizeProvider(src.provider)
  const unit = normalizeUnit(src.unit)
  const quantity = Number(src.quantity)
  if (!provider || !unit || !Number.isFinite(quantity) || quantity <= 0) return 0

  const table = PRICING[provider]
  if (!table) return 0
  const rate = table[unit]
  if (rate == null) return 0

  const cost = PER_1K_UNITS.has(unit) ? (quantity / 1000) * rate : quantity * rate
  return round6(cost)
}
