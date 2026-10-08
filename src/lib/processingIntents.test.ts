import { describe, expect, it } from 'vitest'
import {
  addProcessingIntent,
  INTENT_TTL_MS,
  listProcessingIntents,
  parseIntents,
  reconcileIntents,
  removeProcessingIntent,
  type IntentStorage,
} from './processingIntents'

/**
 * Round 4: the 3:58 PM lecture was uploaded and never processed — the request was
 * in memory, behind two client reads that could fail. A recorded intent survives
 * a failed read, a quit, an exception and a relaunch.
 */

function memoryStorage(): IntentStorage & { dump: () => Record<string, string> } {
  const m: Record<string, string> = {}
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => {
      m[k] = v
    },
    dump: () => ({ ...m }),
  }
}

describe('processing intents survive a relaunch', () => {
  it('an intent written before the request is still there for a brand-new session', () => {
    const disk = memoryStorage()
    addProcessingIntent('u1', 'rec-1', disk, 1000)
    // "Quit and relaunch": nothing in memory, only what is on disk.
    expect(listProcessingIntents('u1', disk, 2000).map((i) => i.id)).toEqual(['rec-1'])
  })

  it('is per user — one account never retries another account’s lectures', () => {
    const disk = memoryStorage()
    addProcessingIntent('u1', 'rec-1', disk, 1000)
    expect(listProcessingIntents('u2', disk, 1000)).toEqual([])
  })

  it('is idempotent and removable', () => {
    const disk = memoryStorage()
    addProcessingIntent('u1', 'rec-1', disk, 1000)
    addProcessingIntent('u1', 'rec-1', disk, 1500)
    expect(listProcessingIntents('u1', disk, 2000)).toHaveLength(1)
    removeProcessingIntent('u1', 'rec-1', disk, 2000)
    expect(listProcessingIntents('u1', disk, 2000)).toEqual([])
  })

  it('expires, so a lecture that can never be processed is not retried forever', () => {
    const disk = memoryStorage()
    addProcessingIntent('u1', 'old', disk, 0)
    expect(listProcessingIntents('u1', disk, INTENT_TTL_MS + 1)).toEqual([])
  })

  it('survives unusable storage and corrupt data without throwing', () => {
    expect(() => addProcessingIntent('u1', 'r', null)).not.toThrow()
    expect(listProcessingIntents('u1', null)).toEqual([])
    expect(parseIntents('{not json')).toEqual([])
    expect(parseIntents('[1, {"id": 5}, {"id":"ok","at":1}]', 1)).toEqual([{ id: 'ok', at: 1 }])
    const throwing: IntentStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('full')
      },
    }
    expect(() => addProcessingIntent('u1', 'r', throwing)).not.toThrow()
    expect(listProcessingIntents('u1', throwing)).toEqual([])
  })

  it('is bounded', () => {
    const disk = memoryStorage()
    for (let i = 0; i < 80; i++) addProcessingIntent('u1', `r${i}`, disk, 1000 + i)
    expect(listProcessingIntents('u1', disk, 2000).length).toBeLessThanOrEqual(50)
  })
})

describe('reconcileIntents — what to do once the library is known', () => {
  const intents = [
    { id: 'pending', at: 1 },
    { id: 'running', at: 1 },
    { id: 'done', at: 1 },
    { id: 'failed', at: 1 },
    { id: 'unseen', at: 1 },
    { id: 'asked', at: 1 },
  ]
  const library = [
    { id: 'pending', aiStatus: 'pending' },
    { id: 'running', aiStatus: 'transcribing' },
    { id: 'done', aiStatus: 'done' },
    { id: 'failed', aiStatus: 'failed' },
    { id: 'asked', aiStatus: 'pending' },
  ]

  it('requests only lectures still `pending` that this session has not already asked about', () => {
    const out = reconcileIntents(intents, library, new Set(['asked']))
    expect(out.request).toEqual(['pending'])
  })

  it('NEVER requests a finished lecture — a repeat there would be a billable regeneration', () => {
    const out = reconcileIntents(intents, library, new Set())
    expect(out.request).not.toContain('done')
    expect(out.clear).toContain('done')
  })

  it('clears every lecture that has moved on, in flight or failed', () => {
    const out = reconcileIntents(intents, library, new Set())
    expect(out.clear.sort()).toEqual(['done', 'failed', 'running'])
  })

  it('waits for a lecture the listing does not contain yet (a read a moment behind)', () => {
    expect(reconcileIntents(intents, library, new Set()).wait).toContain('unseen')
  })

  it('treats a row with no status as pending', () => {
    expect(reconcileIntents([{ id: 'x', at: 1 }], [{ id: 'x' }], new Set()).request).toEqual(['x'])
  })
})
