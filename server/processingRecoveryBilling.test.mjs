import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.SUPABASE_URL = 'https://stub.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-stub'
})

const state = vi.hoisted(() => ({ usage: [], upsertCalls: 0 }))

class UsageSelect {
  constructor() { this.filters = [] }
  select() { return this }
  eq(key, value) { this.filters.push([key, value]); return this }
  in(key, values) { this.filters.push([key, values]); return this }
  limit() { return this }
  async maybeSingle() {
    const row = state.usage.find((candidate) => this.filters.every(([key, value]) => (
      Array.isArray(value) ? value.includes(candidate[key]) : candidate[key] === value
    )))
    return { data: row ? { id: row.id } : null, error: null }
  }
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table) => {
      if (table !== 'beta_usage') return new UsageSelect()
      const query = new UsageSelect()
      query.upsert = async (row, options) => {
        state.upsertCalls += 1
        expect(options).toEqual({ onConflict: 'idempotency_key', ignoreDuplicates: true })
        if (!state.usage.some((item) => item.idempotency_key === row.idempotency_key)) {
          state.usage.push({ id: `usage-${state.usage.length + 1}`, ...row })
        }
        return { error: null }
      }
      return query
    },
  }),
}))

import {
  hasRecordedProcessingUsage,
  processingUsageIdempotencyKey,
  recordProcessingUsageOnce,
} from './betaGate.mjs'

const USER = '00000000-0000-4000-8000-000000000001'
const RECORDING = '10000000-0000-4000-8000-000000000002'

beforeEach(() => {
  state.usage.length = 0
  state.upsertCalls = 0
})

describe('processing usage idempotency', () => {
  it('recognizes historical billable rows that predate idempotency keys', async () => {
    state.usage.push({
      id: 'legacy',
      user_id: USER,
      recording_id: RECORDING,
      action_type: 'process_recording',
      idempotency_key: null,
    })
    await expect(hasRecordedProcessingUsage(USER, RECORDING)).resolves.toBe(true)
  })

  it('recognizes the old transcript-ready regeneration action as already billed', async () => {
    state.usage.push({
      id: 'legacy-regeneration',
      user_id: USER,
      recording_id: RECORDING,
      action_type: 'regenerate_summary',
    })
    await expect(hasRecordedProcessingUsage(USER, RECORDING)).resolves.toBe(true)
  })

  it('uses one stable key and one ledger row across repeated recovery writes', async () => {
    const expectedKey = processingUsageIdempotencyKey(USER, RECORDING)
    await recordProcessingUsageOnce(USER, 'Student@Example.com', RECORDING, 3_361)
    await recordProcessingUsageOnce(USER, 'Student@Example.com', RECORDING, 3_361)

    expect(state.upsertCalls).toBe(2)
    expect(state.usage).toHaveLength(1)
    expect(state.usage[0]).toMatchObject({
      user_id: USER,
      recording_id: RECORDING,
      action_type: 'process_recording',
      billable_minutes: 57,
      idempotency_key: expectedKey,
      email: 'student@example.com',
    })
  })
})
