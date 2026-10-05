/**
 * Live translation protocol — end to end through the REAL `/api/live-realtime-ws` handler
 * (auth, quota, Deepgram and Qwen are mocked at their module boundaries).
 *
 * Why this exists: Desktop needs to know exactly which captions a translation belongs to,
 * and the iPad (Build 67, shipped) already consumes this socket. So every assertion is one
 * of two kinds — the NEW additive identity fields are correct, or the LEGACY fields the
 * iPad reads are exactly what they were.
 */
import http from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'

process.env.YOUMI_LIVE_ASR_EXPERIMENT = 'deepgram'
process.env.DEEPGRAM_API_KEY = 'test-key'
process.env.YOUMI_LIVE_TRANSLATION_EXPERIMENT = 'enabled'

let dg = null // handlers captured from the (mocked) Deepgram session
const translateText = vi.fn(async (text, target, source) => `[${source}→${target}] ${text}`)

vi.mock('./betaGate.mjs', () => ({
  verifyJwt: vi.fn(async () => ({ userId: 'user-12345678', email: 'u@example.com' })),
  getEffectiveQuota: vi.fn(async () => ({ plan_type: 'public_trial' })),
  checkLiveSessionAllowed: vi.fn(async () => ({ allowed: true, maxSessionMinutes: Infinity })),
  recordBetaUsage: vi.fn(async () => undefined),
  BETA_ERROR_CODES: { AUTH_REQUIRED: 'auth_required' },
  BETA_LIMIT_MESSAGE: 'limit',
}))
vi.mock('./deepgramStreamingAsr.mjs', () => ({
  createDeepgramStreamingSession: (_key, handlers) => {
    dg = handlers
    return { sendPcm() {}, finish() {}, destroy() {} }
  },
}))
vi.mock('./watchLiveUsage.mjs', () => ({ createDeepgramLiveCostFinalizer: () => () => undefined }))
vi.mock('./ai/hosted/youmiHosted.mjs', () => ({
  translateText: (...args) => translateText(...args),
  hostedCapabilities: () => ({ translate: true }),
}))

const { attachLiveRealtimeWs } = await import('./liveRealtimeWs.mjs')

let server
let port
const openSockets = []
beforeAll(async () => {
  server = http.createServer()
  attachLiveRealtimeWs(server)
  await new Promise((r) => server.listen(0, r))
  port = server.address().port
})
afterAll(() => new Promise((r) => { openSockets.forEach((w) => { try { w.terminate() } catch { /* ignore */ } }); server.closeAllConnections?.(); server.close(() => r()) }))
beforeEach(() => {
  dg = null
  translateText.mockClear()
  translateText.mockImplementation(async (text, target, source) => `[${source}→${target}] ${text}`)
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Open a socket, send stream_start with the given languages, return helpers. */
async function openStream(languages = { sourceLanguage: 'en', translationLanguage: 'zh-Hans' }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live-realtime-ws`)
  const messages = []
  openSockets.push(ws)
  ws.on('message', (d) => messages.push(JSON.parse(String(d))))
  await new Promise((r) => ws.on('open', r))
  ws.send(JSON.stringify({ type: 'stream_start', sampleRate: 16000, token: 'jwt', ...languages }))
  for (let i = 0; i < 100 && !dg; i++) await sleep(10)
  expect(dg).toBeTruthy()
  return {
    ws,
    messages,
    of: (type) => messages.filter((m) => m.type === type),
    close: () => ws.close(),
  }
}

const LEGACY_FINAL_KEYS = ['type', 'id', 'text', 'transcript', 'caption']

describe('1–3 · final translation names every source caption', () => {
  it('a one-fragment sentence → source_ids is exactly that final id', async () => {
    const s = await openStream()
    dg.onFinal('Welcome to the lecture.')
    await sleep(150)
    const fin = s.of('stream_final')
    const tr = s.of('stream_translation').filter((m) => m.is_final)
    expect(fin).toHaveLength(1)
    expect(tr).toHaveLength(1)
    expect(tr[0].source_ids).toEqual([fin[0].id])
    expect(tr[0].id).toBe(fin[0].id) // legacy: attached to the last id
    s.close()
  })

  it('a sentence split across finals → source_ids lists EVERY id, in order', async () => {
    const s = await openStream()
    dg.onFinal('I have something')
    dg.onFinal('that I want to show you today.')
    await sleep(150)
    const [a, b] = s.of('stream_final')
    const tr = s.of('stream_translation').filter((m) => m.is_final)
    expect(tr).toHaveLength(1)
    expect(tr[0].source_ids).toEqual([a.id, b.id])
    expect(tr[0].id).toBe(b.id)
    expect(tr[0].source_text).toBe('I have something that I want to show you today.')
    s.close()
  })

  it('three fragments then a new sentence → two separate groups, no id in both', async () => {
    const s = await openStream()
    dg.onFinal('First we define the problem')
    dg.onFinal('and then we look at')
    dg.onFinal('the simplest case.')
    dg.onFinal('Next sentence here.')
    await sleep(150)
    const ids = s.of('stream_final').map((m) => m.id)
    const groups = s.of('stream_translation').filter((m) => m.is_final).map((m) => m.source_ids)
    expect(groups).toEqual([[ids[0], ids[1], ids[2]], [ids[3]]])
    expect(new Set(groups.flat()).size).toBe(groups.flat().length)
    s.close()
  })

  it('a trailing unpunctuated fragment is translated on the debounce, with its own id', async () => {
    const s = await openStream()
    dg.onFinal('and that is all for')
    await sleep(1300)
    const tr = s.of('stream_translation').filter((m) => m.is_final)
    expect(tr).toHaveLength(1)
    expect(tr[0].source_ids).toEqual([s.of('stream_final')[0].id])
    s.close()
  })

  it('stream_stop translates the trailing phrase at once instead of waiting out the debounce', async () => {
    const s = await openStream()
    dg.onFinal('and the last words')
    s.ws.send(JSON.stringify({ type: 'stream_stop' }))
    await sleep(200)
    expect(s.of('stream_translation').filter((m) => m.is_final)).toHaveLength(1)
    s.close()
  })
})

describe('4–5 · interim identity and revision', () => {
  it('an interim names the final id it will become, and its draft translation points at it', async () => {
    const s = await openStream()
    dg.onInterim('Hello there everyone')
    await sleep(300)
    const interim = s.of('stream_interim')[0]
    const draft = s.of('stream_translation').find((m) => !m.is_final)
    expect(interim.final_id).toMatch(/:1$/)
    expect(draft.draft_of).toBe(interim.final_id)
    expect(draft.id).toBe(interim.final_id.replace(/:1$/, ':draft:1'))
    expect(draft.revision).toBe(1)
    dg.onFinal('Hello there everyone.')
    await sleep(60)
    expect(s.of('stream_final')[0].id).toBe(interim.final_id) // the promise holds
    dg.onInterim('Second phrase now')
    await sleep(50)
    expect(s.of('stream_interim')[1].final_id).toMatch(/:2$/)
    s.close()
  })

  it('draft revisions only ever increase', async () => {
    const s = await openStream()
    dg.onInterim('One two three four')
    await sleep(250)
    dg.onInterim('One two three four five six seven eight nine ten')
    await sleep(250)
    const revs = s.of('stream_translation').filter((m) => !m.is_final).map((m) => m.revision)
    expect(revs.length).toBeGreaterThanOrEqual(2)
    expect(revs).toEqual([...revs].sort((a, b) => a - b))
    s.close()
  })

  it('a late interim translation can never replace a final: it is dropped once the final is relayed', async () => {
    let release
    translateText.mockImplementationOnce(() => new Promise((r) => { release = () => r('late draft') }))
    const s = await openStream()
    dg.onInterim('Hello there everyone')
    await sleep(250) // draft request is now in flight
    dg.onFinal('Hello there everyone.')
    release()
    await sleep(300)
    const events = s.messages.filter((m) => m.type === 'stream_translation')
    expect(events.some((m) => m.is_final === false)).toBe(false)
    expect(events.filter((m) => m.is_final)).toHaveLength(1)
    s.close()
  })
})

describe('6 · iPad legacy event fields are unchanged', () => {
  it('stream_final keeps exactly its legacy keys and values', async () => {
    const s = await openStream()
    dg.onFinal('Plain sentence.')
    await sleep(50)
    const fin = s.of('stream_final')[0]
    expect(Object.keys(fin).sort()).toEqual([...LEGACY_FINAL_KEYS].sort())
    expect(fin.text).toBe('Plain sentence.')
    expect(fin.transcript).toBe('Plain sentence.')
    expect(fin.caption).toBe('Plain sentence.')
    s.close()
  })

  it('stream_interim keeps text/transcript/caption; the only addition is final_id', async () => {
    const s = await openStream()
    dg.onInterim('Some words so far')
    await sleep(30)
    const m = s.of('stream_interim')[0]
    expect(m.text).toBe('Some words so far')
    expect(m.transcript).toBe('Some words so far')
    expect(m.caption).toBe('Some words so far')
    expect(Object.keys(m).sort()).toEqual(['caption', 'final_id', 'text', 'transcript', 'type'])
    s.close()
  })

  it('stream_translation (final) keeps every legacy field; additions are only source_ids / source_text', async () => {
    const s = await openStream()
    dg.onFinal('Plain sentence.')
    await sleep(150)
    const tr = s.of('stream_translation').find((m) => m.is_final)
    expect(tr.type).toBe('stream_translation')
    expect(typeof tr.id).toBe('string')
    expect(tr.translated_text).toBe('[English→Simplified Chinese] Plain sentence.')
    expect(tr.translation_language).toBe('zh-Hans')
    expect(tr.translation_zh).toBe(tr.translated_text) // the legacy Chinese field the iPad reads
    expect(tr.is_final).toBe(true)
    expect(Object.keys(tr).sort()).toEqual(
      ['id', 'is_final', 'source_ids', 'source_text', 'translated_text', 'translation_language', 'translation_zh', 'type'],
    )
    s.close()
  })

  it('stream_translation (interim) keeps every legacy field; additions are only draft_of / revision', async () => {
    const s = await openStream()
    dg.onInterim('Some words so far')
    await sleep(300)
    const tr = s.of('stream_translation').find((m) => !m.is_final)
    expect(tr.id).toMatch(/:draft:1$/)
    expect(tr.is_final).toBe(false)
    expect(tr.source_text).toBe('Some words so far')
    expect(Object.keys(tr).sort()).toEqual(
      ['draft_of', 'id', 'is_final', 'revision', 'source_text', 'translated_text', 'translation_language', 'translation_zh', 'type'],
    )
    s.close()
  })

  it('a non-Chinese target never carries translation_zh (as before)', async () => {
    const s = await openStream({ sourceLanguage: 'zh-Hans', translationLanguage: 'en' })
    dg.onFinal('今天我们讲排序。')
    await sleep(150)
    const tr = s.of('stream_translation').find((m) => m.is_final)
    expect('translation_zh' in tr).toBe(false)
    expect(tr.translation_language).toBe('en')
    s.close()
  })
})

describe('7–8 · no translation work when there is nothing to translate', () => {
  it('Original only (target === source) performs ZERO translation', async () => {
    const s = await openStream({ sourceLanguage: 'en', translationLanguage: 'en' })
    dg.onInterim('Hello there everyone')
    await sleep(250)
    dg.onFinal('Hello there everyone.')
    await sleep(1300)
    expect(translateText).not.toHaveBeenCalled()
    expect(s.of('stream_translation')).toHaveLength(0)
    expect(s.of('stream_final')).toHaveLength(1) // captions themselves are unaffected
    s.close()
  })

  it('same-language (ja → ja) performs ZERO translation', async () => {
    const s = await openStream({ sourceLanguage: 'ja', translationLanguage: 'ja' })
    dg.onInterim('今日は機械学習について話します')
    await sleep(250)
    dg.onFinal('今日は機械学習について話します。')
    await sleep(300)
    expect(translateText).not.toHaveBeenCalled()
    s.close()
  })

  it('with the flag off, nothing is translated even when languages differ', async () => {
    process.env.YOUMI_LIVE_TRANSLATION_EXPERIMENT = 'disabled'
    try {
      const s = await openStream()
      dg.onFinal('Hello.')
      await sleep(200)
      expect(translateText).not.toHaveBeenCalled()
      s.close()
    } finally {
      process.env.YOUMI_LIVE_TRANSLATION_EXPERIMENT = 'enabled'
    }
  })
})

describe('9 · source and target language reach Qwen correctly', () => {
  it.each([
    ['en', 'zh-Hans', 'Simplified Chinese', 'English'],
    ['zh-Hans', 'en', 'English', 'Simplified Chinese'],
    ['ja', 'en', 'English', 'Japanese'],
    ['ko', 'en', 'English', 'Korean'],
  ])('%s → %s is requested as target "%s" from source "%s"', async (source, target, targetName, sourceName) => {
    const s = await openStream({ sourceLanguage: source, translationLanguage: target })
    dg.onFinal('Sentence.')
    await sleep(150)
    expect(translateText).toHaveBeenCalledTimes(1)
    expect(translateText.mock.calls[0][1]).toBe(targetName)
    expect(translateText.mock.calls[0][2]).toBe(sourceName)
    s.close()
  })
})
