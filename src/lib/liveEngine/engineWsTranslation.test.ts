/**
 * The ONE live translation path: server translation on the persistent live socket,
 * consumed by identity.
 *
 * Replaces the QA 1009/1010 design (client HTTP `/api/translate-caption`, ~1.1–1.35 s
 * per caption, measured). These tests drive the REAL adapter and engine with a fake
 * socket, so they cover the whole client path from `stream_*` message to model event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { LiveEngineEvent } from './types'
import type { StreamingWsEvents, StreamingWsOpts } from './streamingWsSession'

const sockets: { events: StreamingWsEvents; opts: StreamingWsOpts; sampleRate: number }[] = []

vi.mock('./streamingWsSession', () => ({
  StreamingWsSession: class {
    constructor(sampleRate: number, events: StreamingWsEvents, opts: StreamingWsOpts = {}) {
      sockets.push({ events, opts, sampleRate })
    }
    connect() {
      const s = sockets[sockets.length - 1]
      queueMicrotask(() => { s.events.onOpen?.(); s.events.onReady?.() })
    }
    sendPcm() {}
    stop() {}
    destroy() {}
  },
}))

import { LiveEngine } from './engine'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

async function startEngine(
  source: 'en' | 'ja' | 'zh-Hans',
  translation: 'en' | 'zh-Hans' | 'ja',
) {
  const events: LiveEngineEvent[] = []
  const engine = new LiveEngine({})
  engine.onEvent((e) => events.push(e))
  engine.start({ sourceLanguage: source, translationLanguage: translation })
  await engine.warmUpstream(16000)
  const sock = sockets[sockets.length - 1]
  return { engine, events, sock, ev: sock.events }
}
const zh = (events: LiveEngineEvent[]) => events.filter((e) => e.type === 'zh_interim' || e.type === 'zh_final')

let fetchSpy: ReturnType<typeof vi.fn>
beforeEach(() => {
  sockets.length = 0
  fetchSpy = vi.fn(async () => { throw new Error('no network in this test') })
  vi.stubGlobal('fetch', fetchSpy)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('6–7 · ONE live translation path, no duplicate paid translation', () => {
  it('stream_start carries the lecture\'s REAL languages, so the server translates on this socket', async () => {
    const { sock } = await startEngine('ja', 'en')
    expect(sock.opts).toMatchObject({ sourceLanguage: 'ja', translationLanguage: 'en' })
  })

  it('the engine and adapter make no HTTP request for translation, however many captions arrive', async () => {
    const { ev } = await startEngine('zh-Hans', 'en')
    for (let i = 0; i < 6; i++) {
      ev.onInterim?.('今天我们讲排序算法', { finalId: `ws:${i + 1}` })
      ev.onFinal?.('今天我们讲排序算法。', { id: `ws:${i + 1}` })
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('no module in the live engine imports the HTTP translation client', () => {
    for (const file of ['./engine.ts', './adapters/youmiAdapter.ts', './streamingWsSession.ts']) {
      const src = read(file)
      expect(src, file).not.toMatch(/translateLiveCaption|\/translate-caption|from '\.\.\/aiClient'|from '\.\.\/\.\.\/aiClient'/)
    }
  })
})

describe('9–10 · Original only / same language performs zero translation work', () => {
  it('Original only: the socket is told target === source (the server then does nothing) and a stray translation is ignored', async () => {
    const { sock, ev, events } = await startEngine('en', 'en')
    expect(sock.opts.translationLanguage).toBe(sock.opts.sourceLanguage)
    ev.onInterim?.('Hello there', { finalId: 'ws:1' })
    ev.onFinal?.('Hello there everyone.', { id: 'ws:1' })
    ev.onTranslation?.({ final: true, text: '大家好', sourceIds: ['ws:1'], draftOf: null, revision: null, sourceText: 'x', language: 'zh-Hans' })
    expect(zh(events)).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('same language (ja → ja) is the same: nothing translated, nothing awaited', async () => {
    const { engine, ev, sock, events } = await startEngine('ja', 'ja')
    expect(sock.opts.translationLanguage).toBe('ja')
    ev.onInterim?.('今日は', { finalId: 'ws:1' })
    ev.onFinal?.('今日は機械学習について話します。', { id: 'ws:1' })
    const t0 = Date.now()
    await engine.waitAfterCaptureEnd({ minTailMs: 0, maxMs: 3000 })
    expect(Date.now() - t0).toBeLessThan(600) // nothing to wait for
    expect(zh(events)).toHaveLength(0)
  })
})

describe('2 · translation attaches by id', () => {
  it('draft → final: both land on the caption the server named, via the id it assigned', async () => {
    const { ev, events } = await startEngine('ja', 'en')
    ev.onInterim?.('今日は機械学習', { finalId: 'ws:1' })
    ev.onTranslation?.({ final: false, text: 'Today machine learning', sourceIds: null, draftOf: 'ws:1', revision: 1, sourceText: '今日は機械学習', language: 'en' })
    ev.onFinal?.('今日は機械学習について話します。', { id: 'ws:1' })
    ev.onTranslation?.({ final: true, text: 'Today I will talk about machine learning.', sourceIds: ['ws:1'], draftOf: null, revision: null, sourceText: '今日は機械学習について話します。', language: 'en' })
    const out = zh(events)
    expect(out.map((e) => e.type)).toEqual(['zh_interim', 'zh_final'])
    expect(out[0]).toMatchObject({ segmentId: 'stream-0', rev: 1 })
    expect(out[1]).toMatchObject({ segmentId: 'stream-0', segmentIds: ['stream-0'] })
  })

  it('a multi-caption sentence is attached to EVERY caption it names, in order', async () => {
    const { ev, events } = await startEngine('ja', 'en')
    ev.onInterim?.('まず並べ替えの', { finalId: 'ws:1' })
    ev.onFinal?.('まず並べ替えの', { id: 'ws:1' })
    ev.onInterim?.('話をします。', { finalId: 'ws:2' })
    ev.onFinal?.('話をします。', { id: 'ws:2' })
    ev.onTranslation?.({ final: true, text: 'First, let us talk about sorting.', sourceIds: ['ws:1', 'ws:2'], draftOf: null, revision: null, sourceText: 'まず並べ替えの 話をします。', language: 'en' })
    const fin = zh(events).find((e) => e.type === 'zh_final')
    expect(fin).toMatchObject({ segmentIds: ['stream-0', 'stream-1'], segmentId: 'stream-1' })
  })
})

describe('never attached by guessing', () => {
  it('a translation naming a caption we do not know is dropped (not given to the latest one)', async () => {
    const { ev, events } = await startEngine('ja', 'en')
    ev.onInterim?.('今日は', { finalId: 'ws:1' })
    ev.onFinal?.('今日は。', { id: 'ws:1' })
    ev.onTranslation?.({ final: true, text: 'orphan', sourceIds: ['ws:77'], draftOf: null, revision: null, sourceText: null, language: 'en' })
    ev.onTranslation?.({ final: true, text: 'half-known', sourceIds: ['ws:1', 'ws:77'], draftOf: null, revision: null, sourceText: null, language: 'en' })
    expect(zh(events)).toHaveLength(0)
  })

  it('an OLDER server\'s translation (no source_ids / draft_of) is never attached to anything', async () => {
    const { ev, events } = await startEngine('ja', 'en')
    ev.onInterim?.('今日は', { finalId: null })
    ev.onTranslation?.({ final: false, text: 'draft', sourceIds: null, draftOf: null, revision: null, sourceText: '今日は', language: 'en' })
    ev.onFinal?.('今日は。', { id: null })
    ev.onTranslation?.({ final: true, text: 'final', sourceIds: null, draftOf: null, revision: null, sourceText: '今日は。', language: 'en' })
    expect(zh(events)).toHaveLength(0)
    // …and the originals still render.
    expect(events.some((e) => e.type === 'en_final')).toBe(true)
  })

  it('a draft for a caption id we never saw is dropped', async () => {
    const { ev, events } = await startEngine('ja', 'en')
    ev.onTranslation?.({ final: false, text: 'draft', sourceIds: null, draftOf: 'ws:9', revision: 4, sourceText: 'x', language: 'en' })
    expect(zh(events)).toHaveLength(0)
  })

  it('ids from a RECONNECTED socket (new session prefix) cannot collide with the old ones', async () => {
    const { ev, events } = await startEngine('ja', 'en')
    ev.onInterim?.('一つ目', { finalId: 'aaa:1' })
    ev.onFinal?.('一つ目。', { id: 'aaa:1' })
    ev.onInterim?.('二つ目', { finalId: 'bbb:1' }) // same counter value, different session
    ev.onFinal?.('二つ目。', { id: 'bbb:1' })
    ev.onTranslation?.({ final: true, text: 'Second.', sourceIds: ['bbb:1'], draftOf: null, revision: null, sourceText: null, language: 'en' })
    expect(zh(events)[0]).toMatchObject({ segmentIds: ['stream-1'] })
  })
})

describe('1 · the original is never delayed by translation', () => {
  it('interim and final originals are emitted before any translation exists', async () => {
    const { ev, events } = await startEngine('zh-Hans', 'en')
    ev.onInterim?.('今天我们讲排序', { finalId: 'ws:1' })
    ev.onFinal?.('今天我们讲排序算法。', { id: 'ws:1' })
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['en_interim', 'en_final']))
    expect(zh(events)).toHaveLength(0)
  })
})

describe('8 · latency instrumentation (client clock, original → translation)', () => {
  it('final: lag runs from the LAST covered caption\'s final to the translation arriving', async () => {
    const clock = vi.spyOn(performance, 'now')
    clock.mockReturnValue(1000)
    const { engine, ev } = await startEngine('ja', 'en')
    ev.onInterim?.('まず', { finalId: 'ws:1' })
    ev.onFinal?.('まず並べ替えの', { id: 'ws:1' })
    clock.mockReturnValue(1200)
    ev.onInterim?.('話を', { finalId: 'ws:2' })
    ev.onFinal?.('話をします。', { id: 'ws:2' })
    clock.mockReturnValue(1650)
    ev.onTranslation?.({ final: true, text: 'x', sourceIds: ['ws:1', 'ws:2'], draftOf: null, revision: null, sourceText: null, language: 'en' })
    expect(engine.translationLag?.stats().final).toMatchObject({ count: 1, medianMs: 450 })
  })

  it('interim: lag runs from first seeing the text the server translated (echoed as source_text)', async () => {
    const clock = vi.spyOn(performance, 'now')
    clock.mockReturnValue(5000)
    const { engine, ev } = await startEngine('ja', 'en')
    ev.onInterim?.('今日は機械', { finalId: 'ws:1' })
    clock.mockReturnValue(5120)
    ev.onInterim?.('今日は機械学習', { finalId: 'ws:1' })
    clock.mockReturnValue(5520)
    ev.onTranslation?.({ final: false, text: 'x', sourceIds: null, draftOf: 'ws:1', revision: 1, sourceText: '今日は機械', language: 'en' })
    expect(engine.translationLag?.stats().interim).toMatchObject({ count: 1, medianMs: 520 })
  })

  it('a translation whose source text we never showed is not counted (no made-up numbers)', async () => {
    const { engine, ev } = await startEngine('ja', 'en')
    ev.onInterim?.('今日は', { finalId: 'ws:1' })
    ev.onTranslation?.({ final: false, text: 'x', sourceIds: null, draftOf: 'ws:1', revision: 1, sourceText: '全然違う文章', language: 'en' })
    expect(engine.translationLag?.stats().interim.count).toBe(0)
  })
})

describe('Stop waits for the tail translation, not a guessed delay', () => {
  it('waitAfterCaptureEnd returns once every finalized caption has its translation', async () => {
    vi.useFakeTimers()
    const { engine, ev } = await startEngine('ja', 'en')
    ev.onInterim?.('今日は', { finalId: 'ws:1' })
    ev.onFinal?.('今日は機械学習について話します。', { id: 'ws:1' })
    let done = false
    void engine.waitAfterCaptureEnd({ minTailMs: 0, maxMs: 6000 }).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(1500)
    expect(done).toBe(false) // still waiting for the translation
    ev.onTranslation?.({ final: true, text: 'Today I will talk about machine learning.', sourceIds: ['ws:1'], draftOf: null, revision: null, sourceText: null, language: 'en' })
    await vi.advanceTimersByTimeAsync(300)
    expect(done).toBe(true)
  })
})
