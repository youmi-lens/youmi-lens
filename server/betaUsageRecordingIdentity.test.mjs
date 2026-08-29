import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.hoisted(() => {
  process.env.SUPABASE_URL = 'https://stub.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-stub'
})

const { insertedRows } = vi.hoisted(() => ({ insertedRows: [] }))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table) => ({
      insert: async (row) => {
        insertedRows.push({ table, row })
        return { error: null }
      },
    }),
  }),
}))

import { recordBetaUsage } from './betaGate.mjs'

function read(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

beforeEach(() => {
  insertedRows.length = 0
})

describe('beta_usage recording identity contract', () => {
  it('writes null when a live session has no recording UUID', async () => {
    await expect(
      recordBetaUsage('00000000-0000-4000-8000-000000000001', 'live@example.com', null, 'live_caption_session', 2),
    ).resolves.toBeUndefined()

    expect(insertedRows).toHaveLength(1)
    expect(insertedRows[0]).toEqual({
      table: 'beta_usage',
      row: {
        user_id: '00000000-0000-4000-8000-000000000001',
        email: 'live@example.com',
        recording_id: null,
        action_type: 'live_caption_session',
        duration_sec: 2,
        billable_minutes: 0,
      },
    })
  })

  it('preserves a real recording UUID for recorded/processing usage', async () => {
    const recordingUuid = '10000000-0000-4000-8000-000000000002'
    await recordBetaUsage(
      '00000000-0000-4000-8000-000000000001',
      'recorded@example.com',
      recordingUuid,
      'process_recording',
      61,
    )

    expect(insertedRows[0].row.recording_id).toBe(recordingUuid)
    expect(insertedRows[0].row.billable_minutes).toBe(2)
  })

  it('never passes the short WebSocket session ID to beta_usage recording_id', () => {
    const liveSource = read('./liveRealtimeWs.mjs')
    expect(liveSource).toContain('const wsSessionId = crypto.randomUUID().slice(-12)')
    expect(liveSource).toContain('const liveUsageRecordingUuid = null')
    expect(liveSource).not.toMatch(
      /recordBetaUsage\(\s*liveUser\.userId,\s*liveUser\.email,\s*wsSessionId,/,
    )
    expect(liveSource.match(/liveUsageRecordingUuid,\s*'live_caption_session'/g)).toHaveLength(2)
  })

  it('keeps existing real-recording writers and session metadata identities unchanged', () => {
    const processSource = read('./processRecording.mjs')
    const uploadSource = read('./uploadAudio.mjs')
    const liveCostSource = read('./watchLiveUsage.mjs')

    expect(processSource).toContain(
      "recordProcessingUsageOnce(userId, email || '', recordingId, durationSec || 0)",
    )
    expect(processSource).not.toContain("betaActionType || 'process_recording'")
    expect(uploadSource).toContain(
      "recordBetaUsage(userId, email, recordingId, 'upload_audio', durationSec)",
    )
    expect(liveCostSource).toContain('recording_id: null')
    expect(liveCostSource).toContain('session_id: sid')
  })

  it('does not change quota gates or multilingual stream_start resolution', () => {
    const liveSource = read('./liveRealtimeWs.mjs')
    expect(liveSource).toContain('const liveQuota = await getEffectiveQuota(liveUser.userId, liveUser.email)')
    expect(liveSource).toContain('const liveGate = await checkLiveSessionAllowed(liveQuota, liveUser.userId)')
    expect(liveSource).toContain('const { sourceLanguage, translationLanguage } = resolveContentLanguagePair(msg)')
    expect(liveSource).toContain('const translationRequired = shouldTranslate(sourceLanguage, translationLanguage)')
  })
})
