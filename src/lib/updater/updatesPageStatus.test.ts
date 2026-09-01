import { describe, expect, it } from 'vitest'
import type { UpdaterStatus } from './updaterCore'
import { updatesPageStatusKind } from './updatesPageStatus'

const ALL_STATUSES: UpdaterStatus[] = [
  'idle',
  'checking',
  'up-to-date',
  'available',
  'downloading',
  'ready',
  'installing',
  'restart-required',
  'error',
]

describe('updatesPageStatusKind — regression for the QA15 indefinite "Loading…" bug', () => {
  it('idle is an explicit, actionable "not checked yet" state, never a generic loading placeholder', () => {
    expect(updatesPageStatusKind('idle')).toBe('not-checked')
  })

  it('every possible updater status maps to its own distinct, named kind — nothing collapses into a shared ambiguous bucket', () => {
    const kinds = ALL_STATUSES.map(updatesPageStatusKind)
    expect(new Set(kinds).size).toBe(ALL_STATUSES.length)
  })

  it('no kind is literally the generic word "loading" (an active "downloading" is fine — it is a real, terminating state)', () => {
    const kinds = ALL_STATUSES.map(updatesPageStatusKind)
    expect(kinds).not.toContain('loading')
  })

  it('a failed/timed-out check reaches the terminal, recoverable "error" kind, not "not-checked"', () => {
    expect(updatesPageStatusKind('error')).toBe('error')
  })
})
