/**
 * Desktop Multilingual V1 — the matrix, against REAL Production streams.
 *
 * Each fixture is the event stream the deployed backend (0bdb7a7e) sent for a short synthetic
 * recording on 2026-10-05, one per language pair. They run through the real Desktop client path
 * (socket parser → adapter → engine → caption model → caption rows). Saved-lecture fixtures are
 * the rows Production stored for the two pairs that completed Stop & Save.
 */
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildBilingualStack } from '../bilingualCaptionStack'
import { isSpaceDelimited, languageScript, type ContentLanguageCode } from '../contentLanguages'
import { lectureLifecycle } from '../lectureLifecycle'
import {
  initialSummaryKind,
  isTranslationEnabled,
  lectureLanguagesFromRow,
  lectureSummariesFor,
  liveTranslateRouteTarget,
  resolveLectureLanguages,
} from '../lectureLanguages'
import { LiveCaptionSessionModel, liveCaptionEventFromEngine } from '../liveCaptionSessionModel'
import { DEFAULT_LANGUAGE_PREFERENCES } from '../languagePreferences'
import { mapDbRowToRecording, type RecordingDbRow } from '../recordingsRepo'
import { translateDesktop } from '../desktopI18n'
import { LectureDetailPage } from '../../components/LectureDetailPage'
import { LiveEngine } from './engine'
import type { LiveEngineEvent } from './types'

type Msg = Record<string, unknown> & { type: string }
const fixture = (name: string): Msg[] => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

class FakeSocket {
  static last: FakeSocket | null = null
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

async function replay(stream: Msg[], source: ContentLanguageCode, target: ContentLanguageCode) {
  vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:8787')
  vi.stubGlobal('WebSocket', FakeSocket)
  const model = new LiveCaptionSessionModel()
  model.setSourceLanguage(source)
  model.setTranslationLanguage(target)
  const events: LiveEngineEvent[] = []
  const engine = new LiveEngine({ tokenGetter: async () => 'tok' })
  engine.onEvent((e) => {
    events.push(e)
    const cap = liveCaptionEventFromEngine(e)
    if (cap) model.apply(cap)
  })
  engine.start({ sourceLanguage: source, translationLanguage: target })
  const warm = engine.warmUpstream(16000)
  for (let i = 0; i < 50 && !FakeSocket.last?.onopen; i++) await new Promise((r) => setTimeout(r, 5))
  const sock = FakeSocket.last!
  await sock.onopen?.()
  sock.deliver({ type: 'stream_ready' })
  await warm
  for (const m of stream) sock.deliver(m)
  return { model, events, sock }
}

const rowsOf = (model: LiveCaptionSessionModel, s: ContentLanguageCode, t: ContentLanguageCode, enabled = true) => {
  const v = model.getView()
  const st = buildBilingualStack(v.pairs, v.draft, {
    sourceScript: languageScript(s), translationScript: languageScript(t),
    sourceSpaced: isSpaceDelimited(s), translationSpaced: isSpaceDelimited(t), translationEnabled: enabled,
  })
  return st.history.concat(st.current ? [st.current] : [])
}

const SCRIPT: Record<string, (t: string) => boolean> = {
  ja: (t) => /[぀-ヿ]/.test(t),
  ko: (t) => /[가-힯]/.test(t),
  'zh-Hans': (t) => /[一-鿿]/.test(t),
  fr: (t) => /[A-Za-zÀ-ÿ]{3}/.test(t) && !/[぀-ヿ一-鿿가-힯]/.test(t),
  es: (t) => /[A-Za-zÀ-ÿ]{3}/.test(t) && !/[぀-ヿ一-鿿가-힯]/.test(t),
  en: (t) => /[A-Za-z]{3}/.test(t) && !/[぀-ヿ一-鿿가-힯]/.test(t),
}

const PAIRS: Array<{ name: string; source: ContentLanguageCode; target: ContentLanguageCode; file: string }> = [
  { name: 'ja-en', source: 'ja', target: 'en', file: 'server-stream-prod-ja-en.json' },
  { name: 'fr-en', source: 'fr', target: 'en', file: 'server-stream-prod-fr-en.json' },
  { name: 'ko-en', source: 'ko', target: 'en', file: 'server-stream-prod-ko-en.json' },
  { name: 'en-ja', source: 'en', target: 'ja', file: 'server-stream-prod-en-ja.json' },
  { name: 'en-fr', source: 'en', target: 'fr', file: 'server-stream-prod-en-fr.json' },
  { name: 'en-es', source: 'en', target: 'es', file: 'server-stream-prod-en-es.json' },
  { name: 'en-ko', source: 'en', target: 'ko', file: 'server-stream-prod-en-ko.json' },
  { name: 'zh-en', source: 'zh-Hans', target: 'en', file: 'server-stream-prod-zh-en.json' },
  { name: 'en-zh', source: 'en', target: 'zh-Hans', file: 'server-stream-prod-en-zh.json' },
]

beforeEach(() => { FakeSocket.last = null })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe.each(PAIRS)('LIVE $name — real Production stream', ({ source, target, file }) => {
  const stream = fixture(file)
  const serverFinals = stream.filter((m) => m.type === 'stream_final')
  const serverFinalTranslations = stream.filter((m) => m.type === 'stream_translation' && m.is_final !== false)

  it('asks the server for exactly this lecture\'s source and target', async () => {
    const { sock } = await replay(stream, source, target)
    expect(JSON.parse(sock.sent[0])).toMatchObject({ type: 'stream_start', sourceLanguage: source, translationLanguage: target })
  })

  it('every original renders, in the SPOKEN language', async () => {
    const { model } = await replay(stream, source, target)
    const pairs = model.getView().pairs
    expect(pairs.length).toBe(serverFinals.length)
    for (const p of pairs) expect(SCRIPT[source](p.original), p.original).toBe(true)
  })

  it('every caption ends up with a translation attached by identity, in the TARGET language', async () => {
    const { model, events } = await replay(stream, source, target)
    const v = model.getView()
    expect(v.pairs.every((p) => p.translationState === 'final')).toBe(true)
    for (const p of v.pairs) expect(SCRIPT[target](p.groupText || p.translation), p.groupText || p.translation).toBe(true)
    // nothing the server translated was rejected by a guard (Japanese/Korean keep their Latin terms)
    const accepted = events.filter((e) => e.type === 'zh_final').length
    expect(accepted).toBe(serverFinalTranslations.length)
  })

  it('draft translations are attached to open captions and never stale', async () => {
    const { events } = await replay(stream, source, target)
    const drafts = events.filter((e) => e.type === 'zh_interim') as Extract<LiveEngineEvent, { type: 'zh_interim' }>[]
    expect(drafts.length).toBeGreaterThan(0)
    const last = new Map<string, number>()
    for (const d of drafts) {
      expect(d.rev).toBeGreaterThan(last.get(d.segmentId) ?? 0)
      last.set(d.segmentId, d.rev)
    }
  })

  it('rows read naturally: no sentence is glued to the next one', async () => {
    const { model } = await replay(stream, source, target)
    const glued = /[.!?。！？][A-Za-zÀ-ÿ぀-ヿ一-鿿가-힯]/
    for (const r of rowsOf(model, source, target)) {
      if (isSpaceDelimited(source)) expect(r.original).not.toMatch(glued)
      if (isSpaceDelimited(target)) expect(r.translation).not.toMatch(glued)
    }
  })
})

describe('Original only — every enabled spoken language performs zero translation', () => {
  it.each(PAIRS.filter((p) => ['ja', 'fr', 'ko', 'en', 'zh-Hans'].includes(p.source)))('$source: target = source, nothing translated, originals unaffected', async ({ source, file }) => {
    const { sock, events, model } = await replay(fixture(file), source, source)
    expect(JSON.parse(sock.sent[0])).toMatchObject({ sourceLanguage: source, translationLanguage: source })
    expect(events.filter((e) => e.type === 'zh_interim' || e.type === 'zh_final')).toHaveLength(0)
    expect(model.getView().pairs.length).toBeGreaterThan(0)
    expect(model.getView().pairs.every((p) => p.translationState === 'none')).toBe(true)
    expect(rowsOf(model, source, source, false).every((r) => r.translation === '')).toBe(true)
  })

  it.each(['en', 'zh-Hans', 'ja', 'fr', 'ko'] as const)('%s: a stored target equal to the new spoken language normalizes to Original only', (source) => {
    const r = resolveLectureLanguages({ ...DEFAULT_LANGUAGE_PREFERENCES, captionLanguage: source, translationLanguage: source, languageMode: 'bilingual' })
    expect(r.translationEnabled).toBe(false)
    expect(r.languages.translationLanguage).toBe(source)
  })
})

describe('hosted translation no longer depends on the old HTTP route\'s zh/en support', () => {
  it('every pair is "translation on" by the language pair alone, while the HTTP-era mapping says "off" for ja/fr/es/ko targets', () => {
    for (const p of PAIRS) {
      const languages = { sourceLanguage: p.source, translationLanguage: p.target }
      expect(isTranslationEnabled(languages), p.name).toBe(true)
    }
    for (const t of ['ja', 'fr', 'es', 'ko'] as const) {
      expect(liveTranslateRouteTarget({ sourceLanguage: 'en', translationLanguage: t })).toBe('off')
    }
    const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
    expect(app).toContain('const translationOn = useLiveEngineV2 ? isTranslationEnabled(activeLanguages) : translateTarget')
    expect(app).toContain('translationEnabled={translationOn}')
    expect(app).not.toMatch(/translationEnabled=\{translateTarget/)
  })
})

const SAVED = [
  ['ko-en', 'ko', 'en'],
  ['en-es', 'en', 'es'],
  ['ja-en', 'ja', 'en'],
  ['fr-en', 'fr', 'en'],
  ['en-ja', 'en', 'ja'],
  ['en-fr', 'en', 'fr'],
  ['en-ko', 'en', 'ko'],
] as const

describe('PERSIST / REOPEN — rows Production actually stored (synthetic content)', () => {
  const saved = (name: string, id: string) => {
    const f = JSON.parse(readFileSync(new URL(`./fixtures/saved-row-${name}.json`, import.meta.url), 'utf8'))
    const row = {
      id, user_id: 'u', course: 'Smoke', title: `smoke ${name}`, created_at: '2026-10-05T14:00:00Z', duration_sec: 20,
      mime: 'audio/webm', storage_path: `u/${id}.webm`, ...f,
    } as RecordingDbRow
    return mapDbRowToRecording(row)
  }

  it.each(SAVED)('%s: reopen yields the stored pair, not the current settings', (name, source, target) => {
    const rec = saved(name, `rec-${name}`)
    expect(lectureLanguagesFromRow(rec)).toEqual({ sourceLanguage: source, translationLanguage: target })
  })

  it.each(SAVED)('%s: transcript, translated transcript, source summary and translated summary are all there, in the right languages', (name, source, target) => {
    const rec = saved(name, `rec-${name}`)
    const languages = lectureLanguagesFromRow(rec)
    const sums = lectureSummariesFor(languages, rec)
    expect(SCRIPT[source](rec.transcript ?? '')).toBe(true)
    expect(SCRIPT[target](rec.translatedTranscript ?? '')).toBe(true)
    expect(SCRIPT[source](sums.source ?? '')).toBe(true)
    expect(SCRIPT[target](sums.translated ?? '')).toBe(true)
    // translated summary opens first (translation was on), the original stays one click away
    expect(initialSummaryKind(languages, sums)).toBe('translated')
    // the lifecycle says the lecture is finished
    expect(lectureLifecycle({
      hasAudio: true, aiStatus: rec.aiStatus, transcript: rec.transcript, summaryEn: rec.summaryEn, summaryZh: rec.summaryZh,
      sourceSummary: rec.sourceSummary, translatedSummary: rec.translatedSummary, aiExpected: true,
    }).kind).toBe('ready')
  })

  it.each(SAVED)('%s: the legacy EN/ZH mirrors never hold the wrong language (English summary only in summary_en, nothing in summary_zh)', (name, source) => {
    const rec = saved(name, `rec-${name}`)
    // the English summary is the translated one when English is the target, the source one when English is spoken
    expect(rec.summaryEn).toBe(source === 'en' ? rec.sourceSummary : rec.translatedSummary)
    expect(rec.summaryZh ?? '').toBe('')
    expect(rec.translatedTranscript?.length).toBeGreaterThan(10)
  })

  it.each(SAVED.map((x) => x[0]))('%s: the detail page offers both languages by their own names and reads the generic fields', (name) => {
    const rec = saved(name, `rec-${name}`)
    const t = (k: Parameters<typeof translateDesktop>[1], v?: Record<string, string | number>) => translateDesktop('en', k, v)
    const html = renderToStaticMarkup(
      createElement(LectureDetailPage, {
        t, recording: rec, detail: { ...rec, audioUrl: '' } as never, course: null, audioUrl: null, languageLine: 'x',
        formatDate: () => 'Oct 5', formatDuration: () => '0:20', onBack() {}, backLabel: 'Back', onRename() {}, onMove() {},
        onDelete() {}, actionsDisabled: false, onSaveNotes: async () => undefined, onAddMark: async () => undefined, annotationsEditable: true,
      }),
    )
    const LABEL: Record<string, string> = { en: 'English', ja: '日本語', fr: 'Français', es: 'Español', ko: '한국어' }
    const [, srcCode, tgtCode] = SAVED.find((x) => x[0] === name)!
    const [a, b] = [LABEL[srcCode], LABEL[tgtCode]]
    expect(html).toContain(`>${a}<`)
    expect(html).toContain(`>${b}<`)
  })
})

describe('Korean is validated as CJK but written with SPACES (the classification gap the audit found)', () => {
  it('captions of one Korean sentence are joined with a space, not glued', () => {
    const m = new LiveCaptionSessionModel()
    m.setSourceLanguage('ko')
    m.setTranslationLanguage('en')
    m.apply({ type: 'en_interim', segmentId: 'stream-0', rev: 1, text: '먼저 정렬' })
    m.apply({ type: 'en_final', segmentId: 'stream-0', text: '먼저 정렬' })
    m.apply({ type: 'en_interim', segmentId: 'stream-1', rev: 1, text: '알고리즘을 봅니다.' })
    m.apply({ type: 'en_final', segmentId: 'stream-1', text: '알고리즘을 봅니다.' })
    m.apply({ type: 'en_interim', segmentId: 'stream-2', rev: 1, text: '다음은' })
    expect(rowsOf(m, 'ko', 'en')[0].original).toBe('먼저 정렬 알고리즘을 봅니다.')
  })

  it('a Korean TRANSLATION snapshot keeps the space after a full stop (Chinese compaction would glue it)', () => {
    const m = new LiveCaptionSessionModel()
    m.setSourceLanguage('en')
    m.setTranslationLanguage('ko')
    m.apply({ type: 'en_interim', segmentId: 'stream-0', rev: 1, text: 'Today we study sorting algorithms and more' })
    m.apply({ type: 'zh_interim', segmentId: 'stream-0', rev: 1, text: '오늘은 정렬을 배웁니다. 그리고 더 많은 것을 봅니다.', sourceEn: '' })
    expect(m.getView().draft?.translation).toBe('오늘은 정렬을 배웁니다. 그리고 더 많은 것을 봅니다.')
  })

  it('a Japanese translation is NOT dropped for carrying a Latin term next to kanji (the Chinese-only guard)', () => {
    const m = new LiveCaptionSessionModel()
    m.setSourceLanguage('en')
    m.setTranslationLanguage('ja')
    m.apply({ type: 'en_interim', segmentId: 'stream-0', rev: 1, text: 'We use quicksort here' })
    m.apply({ type: 'en_final', segmentId: 'stream-0', text: 'We use quicksort here.' })
    m.apply({ type: 'zh_final', segmentId: 'stream-0', text: 'ここでは quicksort アルゴリズムを使います。', sourceEn: 'We use quicksort here.' })
    expect(m.getView().pairs[0].translationState).toBe('final')
  })

  it('…while a Chinese translation keeps its guard against Latin-garbled output', () => {
    const m = new LiveCaptionSessionModel()
    m.setSourceLanguage('en')
    m.setTranslationLanguage('zh-Hans')
    m.apply({ type: 'en_interim', segmentId: 'stream-0', rev: 1, text: 'Hello everyone' })
    m.apply({ type: 'en_final', segmentId: 'stream-0', text: 'Hello everyone.' })
    m.apply({ type: 'zh_final', segmentId: 'stream-0', text: '大家 hello world 你好', sourceEn: 'Hello everyone.' })
    expect(m.getView().pairs[0].translationState).toBe('none')
  })
})

describe('generic translation guard (targets without a script guard)', () => {
  async function accepts(target: ContentLanguageCode, text: string, sourceText: string | null) {
    const stream: Msg[] = [
      { type: 'stream_interim', text: 'We start here', final_id: 'S:1' },
      { type: 'stream_final', id: 'S:1', text: 'We start here today.' },
      { type: 'stream_translation', id: 'S:1', translated_text: text, translation_language: target, is_final: true, source_ids: ['S:1'], source_text: sourceText },
    ]
    const { events } = await replay(stream, 'en', target)
    return events.filter((e) => e.type === 'zh_final').length === 1
  }
  it.each(['ja', 'fr', 'es', 'ko'] as const)('%s: a real translation passes', async (t) => {
    expect(await accepts(t, 'テスト 番号', 'We start here today.')).toBe(true)
  })
  it('the source handed back unchanged is not a translation', async () => {
    expect(await accepts('fr', 'We start here today.', 'We start here today.')).toBe(false)
  })
  it('a server error token is never shown as a translation', async () => {
    expect(await accepts('es', 'quota_required', 'We start here today.')).toBe(false)
  })
})
