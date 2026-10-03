import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { recordMock } = vi.hoisted(() => ({ recordMock: vi.fn() }))
vi.mock('./watchLedger.mjs', () => ({ recordWatchCostEvent: recordMock }))

import { recordDashscopeChatUsage } from './watchModelUsage.mjs'

const USAGE = {
  provider: 'dashscope',
  model: 'qwen-flash',
  prompt_tokens: 10000,
  completion_tokens: 500,
  total_tokens: 10500,
}

beforeEach(() => {
  recordMock.mockReset()
  recordMock.mockResolvedValue({ ok: true, id: 'evt' })
})
afterEach(() => vi.restoreAllMocks())

describe('recordDashscopeChatUsage (Phase 5B)', () => {
  it('records split tokens_in + tokens_out events on a successful request with usage', async () => {
    const r = await recordDashscopeChatUsage({
      usage: USAGE,
      userId: 'user-1',
      recordingId: 'rec-1',
    })
    expect(r.recorded).toBe(2)
    expect(recordMock).toHaveBeenCalledTimes(2)

    const calls = recordMock.mock.calls.map((c) => c[0])
    const inEvent = calls.find((e) => e.unit === 'tokens_in')
    const outEvent = calls.find((e) => e.unit === 'tokens_out')

    expect(inEvent).toMatchObject({
      provider: 'dashscope',
      event_type: 'summary',
      quantity: 10000,
      unit: 'tokens_in',
      source: 'internal',
      status: 'recorded',
      user_id: 'user-1',
      recording_id: 'rec-1',
      metadata: {
        model: 'qwen-flash',
        request_type: 'summary',
        feature: 'after_class_summary',
        direction: 'input',
        has_usage: true,
      },
    })
    expect(outEvent).toMatchObject({
      provider: 'dashscope',
      quantity: 500,
      unit: 'tokens_out',
      metadata: { direction: 'output', has_usage: true },
    })
  })

  it('records nothing when usage is missing (failed request / no usage block)', async () => {
    expect(await recordDashscopeChatUsage({ usage: null, userId: 'u', recordingId: 'r' })).toEqual({
      recorded: 0,
      reason: 'no_usage',
    })
    expect(await recordDashscopeChatUsage({ userId: 'u' })).toEqual({ recorded: 0, reason: 'no_usage' })
    expect(recordMock).not.toHaveBeenCalled()
  })

  it('records nothing when token counts are absent or zero (never guesses)', async () => {
    const r1 = await recordDashscopeChatUsage({ usage: { provider: 'dashscope' } })
    const r2 = await recordDashscopeChatUsage({
      usage: { provider: 'dashscope', prompt_tokens: 0, completion_tokens: 0 },
    })
    expect(r1).toEqual({ recorded: 0, reason: 'no_token_counts' })
    expect(r2).toEqual({ recorded: 0, reason: 'no_token_counts' })
    expect(recordMock).not.toHaveBeenCalled()
  })

  it('records nothing when the provider is not dashscope (e.g. OpenAI fallback)', async () => {
    const r = await recordDashscopeChatUsage({
      usage: { provider: 'openai', prompt_tokens: 100, completion_tokens: 50 },
    })
    expect(r).toEqual({ recorded: 0, reason: 'not_dashscope' })
    expect(recordMock).not.toHaveBeenCalled()
  })

  it('only records the side that has tokens (e.g. output-only)', async () => {
    const r = await recordDashscopeChatUsage({
      usage: { provider: 'dashscope', prompt_tokens: 0, completion_tokens: 42 },
    })
    expect(r.recorded).toBe(1)
    expect(recordMock).toHaveBeenCalledTimes(1)
    expect(recordMock.mock.calls[0][0]).toMatchObject({ unit: 'tokens_out', quantity: 42 })
  })

  it('does not throw when a ledger write fails or throws', async () => {
    recordMock.mockResolvedValueOnce({ ok: false, error: 'insert_failed' }) // tokens_in fails
    recordMock.mockResolvedValueOnce({ ok: true, id: 'evt' }) // tokens_out ok
    const r1 = await recordDashscopeChatUsage({ usage: USAGE })
    expect(r1.recorded).toBe(1) // one succeeded, no throw

    recordMock.mockReset()
    recordMock.mockRejectedValue(new Error('db down'))
    const r2 = await recordDashscopeChatUsage({ usage: USAGE })
    expect(r2).toEqual({ recorded: 0, reason: 'threw' })
  })

  it('stores only the safe descriptor metadata — no prompt/transcript/summary text, keys, or headers', async () => {
    await recordDashscopeChatUsage({
      usage: USAGE,
      userId: 'user-1',
      recordingId: 'rec-1',
    })
    const SENSITIVE_KEY = /prompt|transcript|summary|content|message|authorization|bearer|secret|api[-_]?key|token|credential|cookie|header|raw/i
    for (const call of recordMock.mock.calls) {
      const event = call[0]
      const dir = event.unit === 'tokens_in' ? 'input' : 'output'
      // Metadata is EXACTLY the five safe descriptors with constant values —
      // proving no extra/text/secret fields can ride along.
      expect(event.metadata).toEqual({
        model: 'qwen-flash',
        request_type: 'summary',
        feature: 'after_class_summary',
        direction: dir,
        has_usage: true,
      })
      // No metadata KEY hints at user content or secrets.
      for (const k of Object.keys(event.metadata)) {
        expect(SENSITIVE_KEY.test(k)).toBe(false)
      }
      // No metadata VALUE is a long string (would indicate embedded text).
      for (const v of Object.values(event.metadata)) {
        if (typeof v === 'string') expect(v.length).toBeLessThanOrEqual(64)
      }
      // Token counts live in the numeric quantity, not in any text field.
      expect(typeof event.quantity).toBe('number')
    }
  })
})
