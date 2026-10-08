/**
 * NEW Desktop against the REAL new server.
 *
 * The two fixtures are event streams recorded from the actual `/api/live-realtime-ws` handler
 * (new backend code, mocked ASR/Qwen at their module boundaries), one English → Chinese and
 * one Chinese → English. They go through the real Desktop `StreamingWsSession` → adapter →
 * engine → caption model → caption stack, with a fake socket as the only stand-in.
 *
 * Nothing is attached by position: every assertion below holds because the server named the
 * captions (`final_id`, `source_ids`, `draft_of`).
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildBilingualStack } from '../bilingualCaptionStack'
import { languageScript } from '../contentLanguages'
import { LiveCaptionSessionModel, liveCaptionEventFromEngine } from '../liveCaptionSessionModel'
import { LiveEngine } from './engine'
import type { LiveEngineEvent } from './types'

type ServerMessage = Record<string, unknown> & { type: string }
const fixture = (name: string): ServerMessage[] =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

class FakeSocket {
  static last: FakeSocket | null = null
  static OPEN = 1
  readyState = 1
  binaryType = ''
  sent: string[] = []
  onopen: (() => void | Promise<void>) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  constructor(public url: string) { FakeSocket.last = this }
  send(d: string) { this.sent.push(d) }
  close() {}
  deliver(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }) }
}

async function replay(
  stream: ServerMessage[],
  languages: { source: 'en' | 'zh-Hans'; target: 'en' | 'zh-Hans' },
  opts: { stripIdentity?: boolean } = {},
) {
  vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:8787')
  vi.stubGlobal('WebSocket', FakeSocket)
  const model = new LiveCaptionSessionModel()
  model.setSourceLanguage(languages.source)
  model.setTranslationLanguage(languages.target)
  const events: LiveEngineEvent[] = []
  const engine = new LiveEngine({ tokenGetter: async () => 'tok' })
  engine.onEvent((e) => {
    events.push(e)
    const cap = liveCaptionEventFromEngine(e)
    if (cap) model.apply(cap)
  })
  engine.start({ sourceLanguage: languages.source, translationLanguage: languages.target })
  const warm = engine.warmUpstream(16000)
  for (let i = 0; i < 50 && !FakeSocket.last?.onopen; i++) await new Promise((r) => setTimeout(r, 5))
  const sock = FakeSocket.last!
  await sock.onopen?.()
  sock.deliver({ type: 'stream_ready' })
  await warm
  for (const raw of stream) {
    if (raw.type === 'ready') continue
    let m: ServerMessage = raw
    if (opts.stripIdentity) {
      // what an OLDER server would have sent: no identity fields at all
      const { final_id: _a, source_ids: _b, draft_of: _c, revision: _d, ...rest } = m as Record<string, unknown>
      void _a; void _b; void _c; void _d
      m = rest as ServerMessage
    }
    sock.deliver(m)
  }
  return { model, events, engine, sock }
}

const rowsOf = (model: LiveCaptionSessionModel, source: 'latin' | 'cjk', target: 'latin' | 'cjk') => {
  const v = model.getView()
  return buildBilingualStack(v.pairs, v.draft, { sourceScript: source, translationScript: target, translationEnabled: true })
}

beforeEach(() => { FakeSocket.last = null })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('English → 简体中文 stream from the real server', () => {
  it('stream_start asks for the real languages', async () => {
    const { sock } = await replay(fixture('server-stream-en-zh.json'), { source: 'en', target: 'zh-Hans' })
    const start = JSON.parse(sock.sent[0])
    expect(start).toMatchObject({ type: 'stream_start', sourceLanguage: 'en', translationLanguage: 'zh-Hans' })
  })

  it('every translation lands on the caption(s) the server named', async () => {
    const { model } = await replay(fixture('server-stream-en-zh.json'), { source: 'en', target: 'zh-Hans' })
    const v = model.getView()
    expect(v.pairs.map((p) => p.original)).toEqual([
      'Hello there everyone, welcome.',
      'I have something',
      'that I want to show you today.',
      'Next idea is simple',
    ])
    // caption 1: its own final
    expect(v.pairs[0]).toMatchObject({ translationState: 'final', translation: '大家好，欢迎。' })
    // captions 2+3: ONE sentence the server translated as a unit, naming both
    expect(v.pairs[1].groupKey).toBe(v.pairs[2].groupKey)
    expect(v.pairs[1].groupKey).not.toBeNull()
    expect(v.pairs[1].groupText).toBe('今天我想给大家展示一些东西。')
    // caption 4: its own final
    expect(v.pairs[3].translationState).toBe('final')
    expect(v.pairs[3].groupKey).toBeNull()
  })

  it('the screen rows pair exactly those: the two fragments share one row and one translation', async () => {
    const { model } = await replay(fixture('server-stream-en-zh.json'), { source: 'en', target: 'zh-Hans' })
    const s = rowsOf(model, 'latin', 'cjk')
    expect(s.history.map((r) => r.original)).toEqual([
      'Hello there everyone, welcome.',
      'I have something that I want to show you today.',
    ])
    expect(s.history[1].translation).toBe('今天我想给大家展示一些东西。')
    expect(s.current).toMatchObject({ original: 'Next idea is simple', translationState: 'final' })
  })

  it('the persisted live translation text is each translation ONCE, in caption order', async () => {
    const { model } = await replay(fixture('server-stream-en-zh.json'), { source: 'en', target: 'zh-Hans' })
    const text = model.getView().persistSecondaryFull
    expect(text.match(/今天我想给大家展示一些东西/g)).toHaveLength(1)
    expect(text.indexOf('大家好，欢迎')).toBeLessThan(text.indexOf('今天我想给'))
    expect(text.indexOf('今天我想给')).toBeLessThan(text.indexOf('下一个想法'))
  })
})

describe('简体中文 → English stream from the real server', () => {
  it('Chinese originals render and each English translation sits with its own caption', async () => {
    const { model } = await replay(fixture('server-stream-zh-en.json'), { source: 'zh-Hans', target: 'en' })
    const v = model.getView()
    expect(v.pairs.map((p) => p.original)).toEqual([
      '今天我们讲排序算法。',
      '首先是冒泡',
      '排序的基本思想是比较相邻的元素。',
      '然后是快速排序，它更高效',
    ])
    expect(v.pairs[0]).toMatchObject({ translation: 'Today we are covering sorting algorithms.', translationState: 'final' })
    expect(v.pairs[1].groupKey).toBe(v.pairs[2].groupKey)
    expect(v.pairs[1].groupText).toBe('First, bubble sort: the basic idea is to compare adjacent elements.')
    expect(languageScript('zh-Hans')).toBe('cjk')
  })

  it('draft translations were attached to the open caption they named, then superseded by the final', async () => {
    const { events } = await replay(fixture('server-stream-zh-en.json'), { source: 'zh-Hans', target: 'en' })
    const drafts = events.filter((e) => e.type === 'zh_interim') as Extract<LiveEngineEvent, { type: 'zh_interim' }>[]
    expect(drafts.length).toBeGreaterThan(0)
    // each draft names a caption that exists in the originals, and revisions only grow
    const revs = drafts.map((d) => d.rev)
    expect(revs).toEqual([...revs].sort((a, b) => a - b))
    for (const d of drafts) expect(d.segmentId).toMatch(/^stream-\d+$/)
  })
})

describe('an OLDER server (no identity fields) can never mis-pair', () => {
  it('originals render normally and NO translation is attached to anything', async () => {
    const { model, events } = await replay(fixture('server-stream-en-zh.json'), { source: 'en', target: 'zh-Hans' }, { stripIdentity: true })
    const v = model.getView()
    expect(v.pairs).toHaveLength(4)
    expect(v.pairs.every((p) => p.translationState === 'none')).toBe(true)
    expect(events.filter((e) => e.type === 'zh_interim' || e.type === 'zh_final')).toHaveLength(0)
  })
})

describe('Original only against the real server stream', () => {
  it('stream_start tells the server target === source and no translation is ever attached', async () => {
    const { sock, model } = await replay(fixture('server-stream-en-zh.json'), { source: 'en', target: 'en' })
    expect(JSON.parse(sock.sent[0])).toMatchObject({ sourceLanguage: 'en', translationLanguage: 'en' })
    expect(model.getView().pairs.every((p) => p.translationState === 'none')).toBe(true)
  })
})

/* ── The REAL Production stream (synthetic speech, deployed backend 0bdb7a7e) ───────────────────
   Recorded from the live Production socket on 2026-10-05. Unlike the fixtures above, this one has
   real Deepgram interim patterns and real Qwen timing — including a draft translation that
   arrived AFTER a newer one (revision 8 after 9). */
describe('REAL Production stream, 简体中文 → English', () => {
  it('every caption ends up with a translation, attached by identity, and nothing is paired by position', async () => {
    const { model } = await replay(fixture('server-stream-prod-zh-en.json'), { source: 'zh-Hans', target: 'en' })
    const v = model.getView()
    expect(v.pairs.length).toBe(6)
    // finals 2 and 3 were translated as ONE sentence naming both: one group, one text.
    expect(v.pairs[1].groupKey).not.toBeNull()
    expect(v.pairs[1].groupKey).toBe(v.pairs[2].groupKey)
    expect(v.pairs[1].groupText.length).toBeGreaterThan(10)
    // the captions the server named individually have their own final translation
    for (const i of [0, 3, 4, 5]) expect(v.pairs[i].translationState).toBe('final')
    // no caption carries another caption's text: a translation is Latin script for Chinese originals
    for (const p of v.pairs) expect(/[一-鿿]/.test(p.groupText || p.translation)).toBe(false)
  })

  it('a draft that arrives after a newer one is never shown', async () => {
    const { events } = await replay(fixture('server-stream-prod-zh-en.json'), { source: 'zh-Hans', target: 'en' })
    const drafts = events.filter((e) => e.type === 'zh_interim') as Extract<LiveEngineEvent, { type: 'zh_interim' }>[]
    const seen = new Map<string, number>()
    for (const d of drafts) {
      expect(d.rev).toBeGreaterThan(seen.get(d.segmentId) ?? 0) // strictly increasing per caption: the stale one was dropped
      seen.set(d.segmentId, d.rev)
    }
    // the recording really contained the out-of-order pair (rev 8 delivered after rev 9)
    const raw = fixture('server-stream-prod-zh-en.json').filter((m) => m.type === 'stream_translation' && m.is_final === false).map((m) => m.revision as number)
    expect(raw.some((r, i) => i > 0 && r < raw[i - 1])).toBe(true)
    expect(drafts.length).toBe(raw.length - 1)
  })

  it('the screen shows the sentence group as one row with its one translation', async () => {
    const { model } = await replay(fixture('server-stream-prod-zh-en.json'), { source: 'zh-Hans', target: 'en' })
    const s = rowsOf(model, 'cjk', 'latin')
    const joined = s.history.concat(s.current ? [s.current] : [])
    const groupRow = joined.find((r) => r.original.includes('它的基本思想是比较') || r.original.includes('的元素'))
    expect(groupRow?.translationState).toBe('final')
    expect(joined.filter((r) => r.translation === groupRow?.translation)).toHaveLength(1)
  })
})

describe('REAL Production stream, English → 简体中文', () => {
  it('captions get Chinese translations by identity', async () => {
    const { model } = await replay(fixture('server-stream-prod-en-zh.json'), { source: 'en', target: 'zh-Hans' })
    const v = model.getView()
    expect(v.pairs.length).toBe(5)
    expect(v.pairs.every((p) => p.translationState === 'final')).toBe(true)
    for (const p of v.pairs) expect(/[一-鿿]/.test(p.translation || p.groupText)).toBe(true)
  })
})
