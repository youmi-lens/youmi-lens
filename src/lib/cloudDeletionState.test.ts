import { describe, expect, it } from 'vitest'
import { isRecordingTrashed, partitionByDeletion } from './cloudDeletionState'

const rec = (id: string, deletedAt: number | null | undefined) => ({ id, deletedAt })

describe('cloud deletion state — authoritative over legacy localStorage trash', () => {
  const empty = new Set<string>()

  it('cloud deletedAt timestamp → trashed (regardless of legacy trash)', () => {
    expect(isRecordingTrashed(rec('a', 1234), empty)).toBe(true)
    expect(isRecordingTrashed(rec('a', 1234), new Set(['a']))).toBe(true)
  })

  it('cloud deletedAt === null → ACTIVE even if the legacy trash still lists it (restore wins)', () => {
    // The key interop case: a restore on another device set deleted_at=null; a
    // stale localStorage trash entry must NOT keep it trashed.
    expect(isRecordingTrashed(rec('a', null), new Set(['a']))).toBe(false)
  })

  it('cloud column absent (deletedAt undefined) → fall back to the legacy trash registry', () => {
    expect(isRecordingTrashed(rec('a', undefined), new Set(['a']))).toBe(true)
    expect(isRecordingTrashed(rec('a', undefined), empty)).toBe(false)
  })

  it('partitions a mixed list correctly', () => {
    const list = [rec('active', null), rec('cloud-trashed', 5), rec('legacy-trashed', undefined), rec('legacy-active', undefined)]
    const { active, trashed } = partitionByDeletion(list, new Set(['legacy-trashed']))
    expect(active.map((r) => r.id).sort()).toEqual(['active', 'legacy-active'])
    expect(trashed.map((r) => r.id).sort()).toEqual(['cloud-trashed', 'legacy-trashed'])
  })
})
