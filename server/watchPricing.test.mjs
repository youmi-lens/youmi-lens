import { describe, expect, it } from 'vitest'
import {
  KNOWN_PROVIDERS,
  PRICING,
  estimateCostUsd,
  normalizeProvider,
  normalizeUnit,
  round6,
} from './watchPricing.mjs'

describe('normalizeProvider', () => {
  it('passes through known providers (case/space-insensitive)', () => {
    for (const p of KNOWN_PROVIDERS) {
      expect(normalizeProvider(p)).toBe(p)
      expect(normalizeProvider(`  ${p.toUpperCase()} `)).toBe(p)
    }
  })

  it('maps known aliases', () => {
    expect(normalizeProvider('qwen')).toBe('dashscope')
    expect(normalizeProvider('qwen-flash')).toBe('dashscope')
    expect(normalizeProvider('sendinblue')).toBe('brevo')
    expect(normalizeProvider('gpt')).toBe('openai')
  })

  it('returns null for unknown/empty/non-string', () => {
    expect(normalizeProvider('not-a-provider')).toBeNull()
    expect(normalizeProvider('')).toBeNull()
    expect(normalizeProvider(null)).toBeNull()
    expect(normalizeProvider(42)).toBeNull()
  })
})

describe('normalizeUnit', () => {
  it('canonicalizes known unit aliases', () => {
    expect(normalizeUnit('min')).toBe('minutes')
    expect(normalizeUnit('Minutes')).toBe('minutes')
    expect(normalizeUnit('input')).toBe('tokens_in')
    expect(normalizeUnit('output_tokens')).toBe('tokens_out')
    expect(normalizeUnit('email')).toBe('emails')
    expect(normalizeUnit('GB')).toBe('gb')
  })

  it('returns the lowercased input for unknown-but-present units', () => {
    expect(normalizeUnit('widgets')).toBe('widgets')
  })

  it('returns null for empty/non-string', () => {
    expect(normalizeUnit('')).toBeNull()
    expect(normalizeUnit('   ')).toBeNull()
    expect(normalizeUnit(undefined)).toBeNull()
  })
})

describe('round6', () => {
  it('rounds to 6 decimals and guards non-finite', () => {
    expect(round6(0.12345678)).toBeCloseTo(0.123457, 6)
    expect(round6(Infinity)).toBe(0)
    expect(round6('nope')).toBe(0)
  })
})

describe('estimateCostUsd', () => {
  it('deepgram minutes', () => {
    expect(estimateCostUsd({ provider: 'deepgram', unit: 'minutes', quantity: 100 })).toBe(
      round6(100 * PRICING.deepgram.minutes),
    )
  })

  it('dashscope input vs output tokens (priced per 1K)', () => {
    expect(estimateCostUsd({ provider: 'dashscope', unit: 'tokens_in', quantity: 2000 })).toBe(
      round6((2000 / 1000) * PRICING.dashscope.tokens_in),
    )
    expect(estimateCostUsd({ provider: 'dashscope', unit: 'output', quantity: 2000 })).toBe(
      round6((2000 / 1000) * PRICING.dashscope.tokens_out),
    )
  })

  it('openai tokens (per 1K)', () => {
    expect(estimateCostUsd({ provider: 'openai', unit: 'tokens_out', quantity: 1000 })).toBe(
      round6(PRICING.openai.tokens_out),
    )
  })

  it('brevo emails', () => {
    expect(estimateCostUsd({ provider: 'brevo', unit: 'emails', quantity: 10 })).toBe(
      round6(10 * PRICING.brevo.emails),
    )
  })

  it('supabase storage GB', () => {
    expect(estimateCostUsd({ provider: 'supabase', unit: 'gb', quantity: 5 })).toBe(
      round6(5 * PRICING.supabase.gb),
    )
  })

  it('railway health checks cost nothing', () => {
    expect(estimateCostUsd({ provider: 'railway', unit: 'checks', quantity: 1000 })).toBe(0)
  })

  it('aliases resolve before pricing (qwen → dashscope, min → minutes)', () => {
    expect(estimateCostUsd({ provider: 'qwen', unit: 'output', quantity: 1000 })).toBe(
      round6(PRICING.dashscope.tokens_out),
    )
  })

  it('returns 0 for unknown provider, unknown unit, or non-positive quantity', () => {
    expect(estimateCostUsd({ provider: 'mystery', unit: 'minutes', quantity: 10 })).toBe(0)
    expect(estimateCostUsd({ provider: 'deepgram', unit: 'widgets', quantity: 10 })).toBe(0)
    expect(estimateCostUsd({ provider: 'deepgram', unit: 'minutes', quantity: 0 })).toBe(0)
    expect(estimateCostUsd({ provider: 'deepgram', unit: 'minutes', quantity: -5 })).toBe(0)
    expect(estimateCostUsd({})).toBe(0)
  })

  it('never throws on garbage input', () => {
    expect(() => estimateCostUsd(null)).not.toThrow()
    expect(estimateCostUsd({ provider: 123, unit: {}, quantity: 'x' })).toBe(0)
  })
})
