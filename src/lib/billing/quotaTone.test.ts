import { describe, expect, it } from 'vitest'
import { quotaTone, quotaUsedPercent } from './quotaTone'

describe('quotaTone — deterministic near-limit/exhausted presentation', () => {
  it('is normal well under the limit', () => {
    expect(quotaTone(100, 300)).toBe('normal')
  })

  it('is warning exactly at the 20%-remaining boundary — "starts at 20%" is inclusive', () => {
    expect(quotaTone(240, 300)).toBe('warning') // 60/300 = 20% remaining
  })

  it('is normal just above the 20%-remaining boundary', () => {
    expect(quotaTone(239, 300)).toBe('normal') // 61/300 ≈ 20.3% remaining
  })

  it('is exhausted at exactly the limit', () => {
    expect(quotaTone(300, 300)).toBe('exhausted')
  })

  it('is exhausted over the limit (never negative remaining)', () => {
    expect(quotaTone(305, 300)).toBe('exhausted')
  })

  it('treats a null used count as zero used', () => {
    expect(quotaTone(null, 300)).toBe('normal')
  })

  it('is normal when there is no known limit (never fabricates a warning)', () => {
    expect(quotaTone(999, null)).toBe('normal')
  })

  it('is deterministic — same inputs always produce the same tone', () => {
    for (let i = 0; i < 5; i++) {
      expect(quotaTone(280, 300)).toBe('warning')
    }
  })
})

describe('quotaUsedPercent', () => {
  it('computes a simple percentage', () => {
    expect(quotaUsedPercent(240, 300)).toBe(80)
  })

  it('clamps above 100 when used exceeds the limit', () => {
    expect(quotaUsedPercent(400, 300)).toBe(100)
  })

  it('returns null when there is no known limit', () => {
    expect(quotaUsedPercent(50, null)).toBeNull()
  })

  it('treats a null used count as zero used', () => {
    expect(quotaUsedPercent(null, 300)).toBe(0)
  })
})
