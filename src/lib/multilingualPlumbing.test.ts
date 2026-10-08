import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LANGUAGE_PREFERENCES, persistLanguagePreferences, readLanguagePreferences } from './languagePreferences'
import { lectureLifecycle } from './lectureLifecycle'
import { createRecordingSessionMeta } from './recordingSession'
import {
  lectureRecordingInsertPayload,
  mapDbRowToRecording,
  uploadLectureAudioViaServer,
  type RecordingDbRow,
} from './recordingsRepo'
import { lectureLanguagesFromRow } from './lectureLanguages'
import { StreamingWsSession } from './liveEngine/streamingWsSession'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

// The production-target guard (correctly) refuses to run tests against the real API,
// so these tests point at a local address and never touch the network.
const stubLocalApi = () => vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:8787')

/* ── stream_start carries the lecture's languages ─────────────────────────── */

class FakeWebSocket {
  static last: FakeWebSocket | null = null
  sent: string[] = []
  binaryType = ''
  onopen: (() => void | Promise<void>) | null = null
  onmessage: ((e: unknown) => void) | null = null
  onclose: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  readyState = 1
  constructor(public url: string) {
    FakeWebSocket.last = this
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {}
}

async function streamStartFor(opts: ConstructorParameters<typeof StreamingWsSession>[2]) {
  stubLocalApi()
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('window', { location: { protocol: 'http:', host: 'localhost' } })
  const session = new StreamingWsSession(16000, {}, opts)
  session.connect()
  await FakeWebSocket.last!.onopen?.()
  return JSON.parse(FakeWebSocket.last!.sent[0]) as Record<string, unknown>
}

describe('live routing — stream_start', () => {
  it('sends the spoken and translation language so live recognition uses the lecture\'s language', async () => {
    const msg = await streamStartFor({ sourceLanguage: 'zh-Hans', translationLanguage: 'en' })
    expect(msg).toMatchObject({ type: 'stream_start', sourceLanguage: 'zh-Hans', translationLanguage: 'en' })
  })

  it('Original only sends translation === source, which makes the server skip its own (wasted) translation', async () => {
    const msg = await streamStartFor({ sourceLanguage: 'en', translationLanguage: 'en' })
    expect(msg.sourceLanguage).toBe('en')
    expect(msg.translationLanguage).toBe('en')
  })

  it('with no languages given, stream_start is unchanged from before (legacy)', async () => {
    const msg = await streamStartFor({})
    expect(msg).toEqual({ type: 'stream_start', sampleRate: 16000 })
  })
})

/* ── upload + row ─────────────────────────────────────────────────────────── */

function uploadWith(languages?: { sourceLanguage?: string; translationLanguage?: string }) {
  stubLocalApi()
  let form: FormData | null = null
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: FormData }) => {
      form = init.body
      return { ok: true, json: async () => ({ storagePath: 'u/r.webm', mime: 'audio/webm', size: 1 }) } as Response
    }),
  )
  const supabase = { auth: { getSession: async () => ({ data: { session: { access_token: 't' } }, error: null }) } }
  return uploadLectureAudioViaServer(supabase as never, 'rec-1', new Blob(['x']), 'audio/webm', 5, {
    course: 'C',
    title: 'T',
    liveTranscript: '',
    liveTranscriptRaw: '',
    ...languages,
  }).then(() => form!)
}

describe('upload carries the lecture\'s frozen languages', () => {
  it('Chinese → English is written to the row via the upload form', async () => {
    const form = await uploadWith({ sourceLanguage: 'zh-Hans', translationLanguage: 'en' })
    expect(form.get('source_language')).toBe('zh-Hans')
    expect(form.get('translation_language')).toBe('en')
  })

  it('Original only is sent as translation === source', async () => {
    const form = await uploadWith({ sourceLanguage: 'en', translationLanguage: 'en' })
    expect(form.get('source_language')).toBe('en')
    expect(form.get('translation_language')).toBe('en')
  })

  it('no languages ⇒ no fields (the server\'s column defaults, the legacy en → zh-Hans, apply)', async () => {
    const form = await uploadWith()
    expect(form.has('source_language')).toBe(false)
    expect(form.has('translation_language')).toBe(false)
  })

  it('the fallback row insert writes the same languages', () => {
    const base = {
      id: 'r', userId: 'u', course: 'C', title: 'T', durationSec: 1, mime: 'audio/webm',
      storagePath: 'p', liveTranscript: '', liveTranscriptRaw: '',
    }
    expect(lectureRecordingInsertPayload({ ...base, sourceLanguage: 'ja', translationLanguage: 'en' })).toMatchObject({
      source_language: 'ja',
      translation_language: 'en',
    })
    const legacy = lectureRecordingInsertPayload(base)
    expect('source_language' in legacy).toBe(false)
  })
})

describe('reopened lectures keep their own languages', () => {
  const row = (over: Partial<RecordingDbRow> = {}) =>
    ({
      id: 'r', user_id: 'u', course: 'C', title: 'T', created_at: '2026-10-01T00:00:00Z',
      duration_sec: 1, mime: 'audio/webm', storage_path: 'p', ai_status: 'done',
      ...over,
    }) as RecordingDbRow

  it('the row\'s languages survive mapping, and are what the detail page reads', () => {
    const rec = mapDbRowToRecording(row({ source_language: 'zh-Hans', translation_language: 'en' }))
    expect(lectureLanguagesFromRow(rec)).toEqual({ sourceLanguage: 'zh-Hans', translationLanguage: 'en' })
  })

  it('a legacy row with no language columns reads as en → zh-Hans (what it was recorded as)', () => {
    const rec = mapDbRowToRecording(row())
    expect(lectureLanguagesFromRow(rec)).toEqual({ sourceLanguage: 'en', translationLanguage: 'zh-Hans' })
  })

  it('rows are not reinterpreted by the current preference: nothing here reads preferences', () => {
    const src = read('./lectureLanguages.ts')
    const start = src.indexOf('export function lectureLanguagesFromRow')
    const body = src.slice(start, src.indexOf('\n}\n', start))
    expect(body).not.toMatch(/preferences?\b/i)
  })
})

describe('recovery keeps the languages', () => {
  it('a durable session remembers the languages it was started with', () => {
    const meta = createRecordingSessionMeta({
      id: 's', ownerKey: 'o', mime: 'audio/webm', requestedBitrate: 64000,
      sourceLanguage: 'zh-Hans', translationLanguage: 'en',
    })
    expect(lectureLanguagesFromRow(meta)).toEqual({ sourceLanguage: 'zh-Hans', translationLanguage: 'en' })
  })

  it('a session from before language selection recovers as the legacy default', () => {
    const meta = createRecordingSessionMeta({ id: 's', ownerKey: 'o', mime: 'audio/webm', requestedBitrate: 64000 })
    expect(lectureLanguagesFromRow(meta)).toEqual({ sourceLanguage: 'en', translationLanguage: 'zh-Hans' })
  })
})

describe('processing is language-agnostic on the client', () => {
  it('a Chinese → English lecture with only the generic summaries is "ready" (not stuck summarizing)', () => {
    const life = lectureLifecycle({
      hasAudio: true, aiStatus: 'done', transcript: '今天', sourceSummary: '摘要', translatedSummary: 'Summary', aiExpected: true,
    })
    expect(life.kind).toBe('ready')
  })

  it('a French lecture (no summary_en/zh mirror at all) with a source summary counts as having one', () => {
    const life = lectureLifecycle({
      hasAudio: true, aiStatus: 'done', transcript: 'Bonjour', sourceSummary: 'Résumé', aiExpected: true,
    })
    expect(life.kind).toBe('ready')
  })
})

/* ── preferences persist ───────────────────────────────────────────────────── */

describe('language choices persist across restart', () => {
  const memory = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
  }

  it('Spoken language, Translate to and Original only round-trip through storage', () => {
    const storage = memory()
    persistLanguagePreferences(storage, {
      ...DEFAULT_LANGUAGE_PREFERENCES, captionLanguage: 'zh-Hans', translationLanguage: 'en', languageMode: 'captions-only',
    })
    expect(readLanguagePreferences(storage)).toMatchObject({
      captionLanguage: 'zh-Hans', translationLanguage: 'en', languageMode: 'captions-only',
    })
  })

  it('the app no longer overwrites the stored choice with English → Chinese on launch', () => {
    const app = read('../App.tsx')
    expect(app).not.toMatch(/SUPPORTED_LIVE_LANG|SUPPORTED_TRANSLATE_TARGET/)
    expect(app).not.toContain("localStorage.setItem(KEY_LIVE_LANG")
    expect(app).not.toContain("localStorage.setItem(KEY_TRANSLATE")
  })
})

/* ── App wiring (source shape) ─────────────────────────────────────────────── */

describe('App wiring', () => {
  const app = read('../App.tsx')
  const stopAndSave = app.slice(app.indexOf('const handleStopAndSave = async'), app.indexOf('const handleStopAndSave = async') + 40_000)

  it('freezes the languages when recording starts', () => {
    const start = app.slice(app.indexOf('const startRecording ='), app.indexOf('const discardRecording ='))
    expect(start).toContain('recordingLanguagesRef.current = languageSnapshot')
    expect(start).toContain('...captureCourse,')
    expect(start).toContain('...languageSnapshot')
  })

  it('Stop & Save uploads, falls back to a row insert, and saves a pending upload with the FROZEN languages', () => {
    expect(stopAndSave).toContain('recordingLanguagesRef.current ?? resolvedPreference.languages')
    expect(stopAndSave.match(/\.\.\.saveLanguages/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('a retried pending upload uses that entry\'s own languages, never today\'s preference', () => {
    const retry = app.slice(app.indexOf('const handleRetryPendingUpload'), app.indexOf('const handleDeletePendingUpload'))
    expect(retry).toContain('lectureLanguagesFromRow(rec)')
    expect(retry.match(/\.\.\.retryLanguages/g)?.length).toBe(2)
    expect(retry).not.toContain('languagePreferences')
  })

  it('a recovered session saves with its own languages', () => {
    const recover = app.slice(app.indexOf('const handleRecoverSave'), app.indexOf('const handleRecoverKeep'))
    expect(recover).toContain('lectureLanguagesFromRow(fresh)')
    expect(recover.match(/\.\.\.recoveryLanguages/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('live translation is requested only when translation is enabled (Original only / same language make no request)', () => {
    expect(app).toContain('const translateTarget: LiveTranslateTarget = liveTranslateRouteTarget(activeLanguages)')
    // every translate entry point is gated on it
    expect(app.match(/if \(translateTarget === 'off'\) return/g)?.length).toBeGreaterThanOrEqual(4)
  })

  it('the lecture detail page reads the LECTURE\'s languages, not the preference', () => {
    expect(app).toContain('languageLineFor(lectureLanguagesFromRow(openLecture)')
  })

  it('the engine is started with the source and translation languages', () => {
    expect(app).toContain('sourceLanguage: liveLang,')
    expect(app).toContain('translationLanguage: liveTranslationLanguage,')
    expect(app).toContain('setTranslationLanguage(liveTranslationLanguage)')
  })
})

describe('engine routing (source shape)', () => {
  const engine = read('./liveEngine/engine.ts')
  it('opens the live adapter with the lecture\'s REAL source and translation language', () => {
    expect(engine).toContain('sourceLanguage: this.sourceLanguage,')
    expect(engine).toContain('translationLanguage: this.translationLanguage,')
    // the old suppression hack (always "translate nothing") is gone: the server is the one translator
    expect(engine).not.toContain('translationLanguage: this.sourceLanguage,')
  })

  it('has no client-side translation requests at all', () => {
    expect(engine).not.toMatch(/translateLiveCaption|translateInterim|translateFinal|fetch\(/)
  })
})
