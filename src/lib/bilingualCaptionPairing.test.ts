/**
 * QA 1009 physical failure: "CURRENT ORIGINAL + PREVIOUS TRANSLATION".
 *
 * Root cause (reproduced before the fix): the session model stored translations
 * correctly by segment id, but its VIEW flattened them into two joined strings and
 * the Recording screen re-split each string on its own. With no draft translation
 * for the new caption the "current translation" fell back to the LAST committed
 * translation — the previous caption's. Nothing in the pipeline paired them.
 *
 * The invariant under test: a translation belongs to ONE original caption identity
 * and is only ever read back under that identity.
 */
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildBilingualStack } from './bilingualCaptionStack'
import {
  captionFollowReducer,
  INITIAL_CAPTION_FOLLOW,
  shouldPinToBottom,
  shouldShowJumpToLatest,
} from './captionAutoFollow'
import { LiveCaptionSessionModel, type LiveCaptionView } from './liveCaptionSessionModel'
import { RecordingV2 } from '../components/RecordingV2'
import { translateDesktop } from './desktopI18n'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const JA = ['今日は機械学習について話します。', 'まず勾配降下法から始めます。', '次に学習率を説明します。']
const EN = ['Today I will talk about machine learning.', 'First we will start with gradient descent.', 'Next I will explain the learning rate.']
const id = (i: number) => `stream-${i}`

function model(translation: 'en' | 'zh-Hans' = 'en', source: 'ja' | 'en' | 'zh-Hans' = 'ja') {
  const m = new LiveCaptionSessionModel(() => 0)
  m.setSourceLanguage(source)
  m.setTranslationLanguage(translation)
  return m
}
const interim = (m: LiveCaptionSessionModel, i: number, text: string, rev = 1) =>
  m.apply({ type: 'en_interim', segmentId: id(i), rev, text })
const final = (m: LiveCaptionSessionModel, i: number, text: string) =>
  m.apply({ type: 'en_final', segmentId: id(i), text })
const tFinal = (m: LiveCaptionSessionModel, i: number, text: string, src: string) =>
  m.apply({ type: 'zh_final', segmentId: id(i), text, sourceEn: src })
const tInterim = (m: LiveCaptionSessionModel, i: number, text: string, src: string, rev: number) =>
  m.apply({ type: 'zh_interim', segmentId: id(i), rev, text, sourceEn: src })

const stackOf = (v: LiveCaptionView, o: Partial<Parameters<typeof buildBilingualStack>[2]> = {}) =>
  buildBilingualStack(v.pairs, v.draft, {
    sourceScript: 'cjk',
    translationScript: 'latin',
    translationEnabled: true,
    ...o,
  })

describe('1 · original N + translation N pair correctly', () => {
  it('each settled caption carries its own translation', () => {
    const m = model()
    for (let i = 0; i < 3; i++) {
      interim(m, i, JA[i])
      final(m, i, JA[i])
      tFinal(m, i, EN[i], JA[i])
    }
    const v = m.getView()
    expect(v.pairs.map((p) => [p.original, p.translation])).toEqual([
      [JA[0], EN[0]],
      [JA[1], EN[1]],
      [JA[2], EN[2]],
    ])
  })
})

describe('2 · the QA 1009 reproduction: translation N arrives after original N+1 appeared', () => {
  it('the new caption shows NO translation — not the previous one', () => {
    const m = model()
    interim(m, 0, JA[0])
    final(m, 0, JA[0])
    interim(m, 1, JA[1]) // utterance 1 is now being spoken; translation 0 still in flight
    let v = m.getView()
    expect(v.draft?.original).toBe(JA[1])
    expect(v.draft?.translation).toBe('')
    expect(v.draft?.translationState).toBe('none')
    expect(stackOf(v).current?.translation).toBe('')

    tFinal(m, 0, EN[0], JA[0]) // the late response
    v = m.getView()
    // It completes caption 0 …
    expect(v.pairs[0].translation).toBe(EN[0])
    // … and the current caption (1) still has none.
    expect(v.draft?.original).toBe(JA[1])
    expect(v.draft?.translation).toBe('')
    const s = stackOf(v)
    expect(s.current).toMatchObject({ original: JA[1], translation: '' })
    // The legacy string fields no longer carry the previous translation into the draft slot either.
    expect(v.secondaryGray).toBe('')
  })

  it('and when that caption (1) is finalized with no translation yet, the fixed line still shows none', () => {
    const m = model()
    for (const i of [0, 1]) {
      interim(m, i, JA[i])
      final(m, i, JA[i])
    }
    tFinal(m, 0, EN[0], JA[0])
    const s = stackOf(m.getView())
    expect(s.current).toMatchObject({ original: JA[1], translation: '' })
    expect(s.history[0]).toMatchObject({ original: JA[0], translation: EN[0] })
  })
})

describe('3 · out-of-order responses', () => {
  it('translation 2 before translation 1: each still lands on its own caption', () => {
    const m = model()
    for (let i = 0; i < 3; i++) {
      interim(m, i, JA[i])
      final(m, i, JA[i])
    }
    tFinal(m, 2, EN[2], JA[2])
    tFinal(m, 1, EN[1], JA[1])
    tFinal(m, 0, EN[0], JA[0])
    expect(m.getView().pairs.map((p) => p.translation)).toEqual(EN)
  })

  it('persisted translation text is in ORIGINAL order, not arrival order', () => {
    const m = model()
    for (let i = 0; i < 2; i++) {
      interim(m, i, JA[i])
      final(m, i, JA[i])
    }
    tFinal(m, 1, EN[1], JA[1])
    tFinal(m, 0, EN[0], JA[0])
    expect(m.getView().persistSecondaryFull).toBe(`${EN[0]} ${EN[1]}`)
  })

  it('an older interim translation that overtakes a newer one on the wire is ignored', () => {
    const m = model()
    interim(m, 0, JA[0])
    tInterim(m, 0, 'Today I will explain gradient descent in detail', JA[0], 2)
    tInterim(m, 0, 'Today I will', JA[0], 1)
    expect(m.getView().draft?.translation).toBe('Today I will explain gradient descent in detail')
  })
})

describe('4 · interim → final transition', () => {
  it('the interim translation is replaced by the final one, on the same caption', () => {
    const m = model()
    interim(m, 0, JA[0])
    tInterim(m, 0, 'Today I will talk', JA[0], 1)
    expect(m.getView().draft).toMatchObject({ translation: 'Today I will talk', translationState: 'interim' })
    final(m, 0, JA[0])
    expect(m.getView().pairs[0]).toMatchObject({ translation: 'Today I will talk', translationState: 'interim' })
    tFinal(m, 0, EN[0], JA[0])
    expect(m.getView().pairs[0]).toMatchObject({ translation: EN[0], translationState: 'final' })
  })

  it('a late interim can never overwrite a final translation', () => {
    const m = model()
    interim(m, 0, JA[0])
    final(m, 0, JA[0])
    tFinal(m, 0, EN[0], JA[0])
    tInterim(m, 0, 'stale partial', JA[0], 9)
    expect(m.getView().pairs[0].translation).toBe(EN[0])
  })
})

describe('5 · final translation attaches to the final original', () => {
  it('a translation whose source no longer matches the caption is refused', () => {
    const m = model()
    interim(m, 0, JA[0])
    final(m, 0, JA[0])
    tFinal(m, 0, 'translation of some OTHER text', 'まったく別の文です。')
    expect(m.getView().pairs[0].translationState).toBe('none')
  })

  it('a translation for a caption the model never had has nowhere to go', () => {
    const m = model()
    interim(m, 0, JA[0])
    final(m, 0, JA[0])
    tFinal(m, 7, 'orphan', 'どこにもない文です。')
    const v = m.getView()
    expect(v.pairs).toHaveLength(1)
    expect(v.persistSecondaryFull).toBe('')
  })

  it('an abandoned (never finalized) caption takes its translation with it', () => {
    const m = model()
    interim(m, 0, JA[0])
    tInterim(m, 0, 'Today', JA[0], 1)
    interim(m, 1, JA[1]) // caption 0 was replaced without a final
    tInterim(m, 0, 'Today I will talk', JA[0], 2) // late
    const v = m.getView()
    expect(v.draft?.id).toBe(id(1))
    expect(v.draft?.translation).toBe('')
  })
})

describe('6 · a missing translation never shows a previous one', () => {
  it('captions 0 and 2 translated, caption 1 never: row 1 is original-only', () => {
    const m = model()
    for (let i = 0; i < 3; i++) {
      interim(m, i, JA[i])
      final(m, i, JA[i])
    }
    tFinal(m, 0, EN[0], JA[0])
    tFinal(m, 2, EN[2], JA[2])
    const v = m.getView()
    expect(v.pairs[1].translation).toBe('')
    const rows = stackOf(v, { maxHistory: 80 })
    // history rows are sentence rows (every caption here ends with 。)
    expect(rows.history.map((r) => r.translation)).toEqual([EN[0], ''])
    expect(rows.current?.translation).toBe(EN[2])
  })
})

describe('7 · Original only', () => {
  it('has no translated line anywhere', () => {
    const m = model('en', 'en')
    for (let i = 0; i < 2; i++) {
      interim(m, i, `Sentence ${i}.`)
      final(m, i, `Sentence ${i}.`)
    }
    const s = stackOf(m.getView(), { sourceScript: 'latin', translationEnabled: false })
    expect(s.history.every((r) => r.translation === '' && r.translationState === 'none')).toBe(true)
    expect(s.current?.translation).toBe('')
    const html = renderToStaticMarkup(
      createElement(RecordingV2, recordingProps(s, false)),
    )
    expect(html).not.toContain('recording-v2__pair-translation')
    expect(html).not.toContain('recording-v2__translation')
  })
})

describe('8 · bilingual finalized history keeps both lines', () => {
  it('renders original AND translation for every settled row, paired in one block', () => {
    const m = model()
    for (let i = 0; i < 3; i++) {
      interim(m, i, JA[i])
      final(m, i, JA[i])
      tFinal(m, i, EN[i], JA[i])
    }
    const html = renderToStaticMarkup(createElement(RecordingV2, recordingProps(stackOf(m.getView()), true)))
    for (let i = 0; i < 2; i++) {
      // Each pair is ONE element holding its own original then its own translation.
      const block = `<p class="recording-v2__pair-source">${JA[i]}</p><p class="recording-v2__pair-translation">${EN[i]}</p>`
      expect(html).toContain(block)
    }
  })
})

describe('9 · Chinese / Japanese (no whitespace) scripts', () => {
  it('one history row per sentence even though 。 is never followed by a space', () => {
    const m = model()
    for (let i = 0; i < 8; i++) {
      const t = `これは${i}番目の文です。`
      interim(m, i, t)
      final(m, i, t)
    }
    interim(m, 8, '今話している途中')
    const s = stackOf(m.getView())
    // The old text splitter produced ONE row for all of this, and none without a draft.
    expect(s.history).toHaveLength(8)
    expect(s.history[0].original).toBe('これは0番目の文です。')
  })

  it('Chinese works the same, and joins translated English with spaces', () => {
    const m = model('en', 'zh-Hans')
    for (let i = 0; i < 3; i++) {
      const t = `这是第${i}句话。`
      interim(m, i, t)
      final(m, i, t)
      tFinal(m, i, `This is sentence ${i}.`, t)
    }
    const s = buildBilingualStack(m.getView().pairs, null, { sourceScript: 'cjk', translationScript: 'latin', translationEnabled: true })
    expect(s.history).toHaveLength(2)
    expect(s.current).toMatchObject({ original: '这是第2句话。', translation: 'This is sentence 2.' })
  })

  it('a run with no punctuation at all is still cut, so it stays readable', () => {
    const m = model()
    for (let i = 0; i < 12; i++) {
      const t = 'あ'.repeat(30)
      interim(m, i, t + i)
      final(m, i, t + i)
    }
    const s = stackOf(m.getView())
    expect(s.history.length).toBeGreaterThan(1)
  })
})

describe('10 · English spacing', () => {
  it('captions of one sentence join with a space; the old Chinese compaction glued "algorithms.Then"', () => {
    const m = model('en', 'ja')
    // Two captions that together make ONE sentence row (no terminal punctuation on the first).
    interim(m, 0, 'まず並べ替えの')
    final(m, 0, 'まず並べ替えの')
    tFinal(m, 0, 'First, about sorting', 'まず並べ替えの')
    interim(m, 1, '話をします。')
    final(m, 1, '話をします。')
    tFinal(m, 1, 'we will talk.', '話をします。')
    interim(m, 2, '次です。')
    const s = stackOf(m.getView())
    expect(s.history).toHaveLength(1)
    expect(s.history[0].translation).toBe('First, about sorting we will talk.')
  })

  it('an English translation snapshot keeps the space after a full stop', () => {
    const m = model('en', 'ja')
    interim(m, 0, JA[0])
    tInterim(m, 0, 'The lecture covers sorting algorithms. Then we discuss quicksort in detail.', JA[0], 1)
    expect(m.getView().draft?.translation).toBe('The lecture covers sorting algorithms. Then we discuss quicksort in detail.')
  })
})

/* ── Screen: markup contract, scroll invariants ─────────────────────────────── */

const t = (key: Parameters<typeof translateDesktop>[1], vars?: Record<string, string | number>) =>
  translateDesktop('en', key, vars)

function recordingProps(captions: ReturnType<typeof buildBilingualStack>, translationEnabled: boolean) {
  const noop = () => undefined
  return {
    t,
    stage: 'recording' as const,
    courseName: 'CS 101',
    courseIdentity: { icon: 'book', tint: '#E7F2EA', accent: '#3F8C68' } as never,
    lectureTitle: 'Lecture',
    elapsed: '00:10',
    languageLine: '日本語 → English',
    captions,
    translationEnabled,
    notice: null,
    failureMessage: null,
    busy: false,
    canOpenOverlay: false,
    onOpenOverlay: noop,
    onDiscard: noop,
    onPause: noop,
    onResume: noop,
    onStopAndSave: noop,
    onViewLecture: noop,
    onRecordAnother: noop,
    onRetry: noop,
    onRecoverRecording: noop,
    onDiscardRecovery: noop,
    onCancelRecoveryDiscard: noop,
    recoveryDiscardConfirm: false,
  }
}

describe('current caption uses the same identity pairing', () => {
  it('while the caption is LIVE: its own translation if it has one, otherwise nothing — no standing "Translating…", never another caption\'s', () => {
    const m = model()
    interim(m, 0, JA[0])
    final(m, 0, JA[0])
    tFinal(m, 0, EN[0], JA[0])
    interim(m, 1, JA[1])
    const s = stackOf(m.getView())
    expect(s.current).toMatchObject({ original: JA[1], translation: '', live: true })
    const html = renderToStaticMarkup(createElement(RecordingV2, recordingProps(s, true)))
    const live = html.slice(html.indexOf('recording-v2__live'))
    expect(live).toContain(JA[1])
    expect(live).not.toContain(EN[0])
    expect(live).not.toContain('Translating')
    // The previous caption's translation is where it belongs: in history, under its original.
    expect(html).toContain(`<p class="recording-v2__pair-translation">${EN[0]}</p>`)
  })

  it('a SETTLED caption still waiting shows the quiet hint (which fades in late)', () => {
    const m = model()
    interim(m, 0, JA[0])
    final(m, 0, JA[0])
    const s = stackOf(m.getView())
    expect(s.current?.live).toBeUndefined()
    const html = renderToStaticMarkup(createElement(RecordingV2, recordingProps(s, true)))
    expect(html).toContain('data-pending="true"')
    expect(html).toContain('Translating')
    expect(read('../styles/recording-v2.css')).toMatch(/\[data-pending='true'\][^}]*animation:[^;]*900ms/)
  })
})

describe('final translation of a multi-caption sentence (server source_ids)', () => {
  const group = (m: LiveCaptionSessionModel, ids: number[], text: string) =>
    m.apply({ type: 'zh_final', segmentId: id(ids[ids.length - 1]), segmentIds: ids.map(id), text, sourceEn: '' })

  it('covers every named caption and appears ONCE, in one history row', () => {
    const m = model()
    for (const i of [0, 1, 2]) { interim(m, i, `断片${i}`); final(m, i, `断片${i}${i === 1 ? '。' : ''}`) }
    group(m, [0, 1], 'Fragment zero and one.')
    const s = stackOf(m.getView())
    expect(s.history).toHaveLength(1)
    expect(s.history[0]).toMatchObject({ original: '断片0断片1。', translation: 'Fragment zero and one.', translationState: 'final' })
    expect(s.current).toMatchObject({ original: '断片2', translation: '' })
  })

  it('never reaches a caption the server did not name', () => {
    const m = model()
    for (const i of [0, 1, 2, 3]) { interim(m, i, `文${i}。`); final(m, i, `文${i}。`) }
    group(m, [1, 2], 'Two and three.')
    const v = m.getView()
    expect(v.pairs.map((p) => p.translationState)).toEqual(['none', 'final', 'final', 'none'])
    expect(v.pairs[0].groupKey).toBeNull()
    expect(v.pairs[3].groupKey).toBeNull()
    expect(v.persistSecondaryFull).toBe('Two and three.')
  })

  it('a group that arrives out of order lands on its own captions', () => {
    const m = model()
    for (const i of [0, 1, 2, 3]) { interim(m, i, `文${i}。`); final(m, i, `文${i}。`) }
    group(m, [2, 3], 'Three and four.')
    group(m, [0, 1], 'One and two.')
    expect(m.getView().persistSecondaryFull).toBe('One and two. Three and four.')
    const s = stackOf(m.getView())
    expect(s.history[0]).toMatchObject({ original: '文0。文1。', translation: 'One and two.' })
    expect(s.current).toMatchObject({ original: '文2。文3。', translation: 'Three and four.' }) // the group IS the current row
  })

  it('the group\'s final text supersedes a draft for its members, and no later draft can touch it', () => {
    const m = model()
    interim(m, 0, '断片0')
    tInterim(m, 0, 'frag', '断片0', 1)
    final(m, 0, '断片0')
    interim(m, 1, '断片1。')
    final(m, 1, '断片1。')
    group(m, [0, 1], 'Fragments zero and one.')
    tInterim(m, 0, 'late draft', '断片0', 9)
    const v = m.getView()
    expect(v.pairs.every((p) => p.translationState === 'final')).toBe(true)
    expect(v.persistSecondaryFull).toBe('Fragments zero and one.')
  })

  it('a duplicate delivery of the same group changes nothing', () => {
    const m = model()
    for (const i of [0, 1]) { interim(m, i, `文${i}。`); final(m, i, `文${i}。`) }
    group(m, [0, 1], 'One and two.')
    const before = JSON.stringify(m.getView().pairs)
    group(m, [0, 1], 'Different retry text.')
    expect(JSON.stringify(m.getView().pairs)).toBe(before)
  })

  it('a caption the engine never showed (dropped as a pure repeat) does not block the shown ones', () => {
    const m = model()
    interim(m, 0, '文0。'); final(m, 0, '文0。')
    group(m, [0, 5], 'Zero (and a repeat).')
    expect(m.getView().pairs[0]).toMatchObject({ translation: 'Zero (and a repeat).', translationState: 'final' })
  })
})

describe('11–16 · the history stays a bounded, scrollable, followable viewport with bilingual rows', () => {
  const tsx = read('../components/RecordingV2.tsx')
  const css = read('../styles/recording-v2.css')

  it('11. pair rows render INSIDE the one bounded scroller (the page does not grow with them)', () => {
    const history = tsx.slice(tsx.indexOf('className="recording-v2__history"'), tsx.indexOf('recording-v2__live'))
    expect(history).toContain('<CaptionPairRow')
    expect(css).toMatch(/\.recording-v2__history-wrap \{[^}]*max-height:\s*var\(--recording-history-max\)/)
    expect(css).toMatch(/\.recording-v2__history \{[^}]*overflow-y:\s*auto/)
    // the bilingual row must not opt out of the bound or add its own scroller
    const pair = css.slice(css.indexOf('.recording-v2__pair'), css.indexOf('.desktop-v2 .recording-v2__history p {'))
    expect(pair).not.toMatch(/overflow(-x|-y)?\s*:|max-height|position:\s*(fixed|absolute)/)
  })

  it('12. scrolling stays the platform\'s: no wheel/touch handler was added for the bilingual rows', () => {
    expect(tsx).not.toMatch(/onWheel|onTouchMove|preventDefault\(\)/)
    expect(css).toMatch(/\.recording-v2__history \{[^}]*touch-action:\s*pan-y/)
    expect(css).toMatch(/\.recording-v2__history \{[^}]*overscroll-behavior:\s*contain/)
  })

  it('13. at the bottom, a new caption keeps follow mode pinned', () => {
    let st = captionFollowReducer(INITIAL_CAPTION_FOLLOW, { type: 'scrolled', metrics: { scrollTop: 1700, scrollHeight: 2000, clientHeight: 300 } })
    st = captionFollowReducer(st, { type: 'captions-changed' })
    expect(shouldPinToBottom(st)).toBe(true)
  })

  it('14. scrolling up disables follow, and a new caption does not re-enable it', () => {
    let st = captionFollowReducer(INITIAL_CAPTION_FOLLOW, { type: 'scrolled', metrics: { scrollTop: 1700, scrollHeight: 2000, clientHeight: 300 } })
    st = captionFollowReducer(st, { type: 'user-scrolled-up', metrics: { scrollTop: 900, scrollHeight: 2000, clientHeight: 300 } })
    st = captionFollowReducer(st, { type: 'captions-changed' })
    expect(shouldPinToBottom(st)).toBe(false)
    expect(shouldShowJumpToLatest(st)).toBe(true)
  })

  it('15. Jump to latest restores follow mode', () => {
    let st = captionFollowReducer(INITIAL_CAPTION_FOLLOW, { type: 'user-scrolled-up', metrics: { scrollTop: 900, scrollHeight: 2000, clientHeight: 300 } })
    st = captionFollowReducer(st, { type: 'jump-to-latest' })
    expect(shouldPinToBottom(st)).toBe(true)
    expect(shouldShowJumpToLatest(st)).toBe(false)
  })

  it('16. a resize while following re-pins (the content AND the viewport are observed)', () => {
    expect(tsx).toContain('observer.observe(el)')
    expect(tsx).toContain('observer.observe(viewport)')
    const st = captionFollowReducer(INITIAL_CAPTION_FOLLOW, { type: 'resized', metrics: { scrollTop: 1700, scrollHeight: 2400, clientHeight: 300 } })
    expect(shouldPinToBottom(st)).toBe(true)
  })

  it('the scroll SYSTEM itself (reducer, pinning, geometry CSS) is exactly the QA 1008 one', () => {
    // QA 1008 passed the physical scroll test. The regression was DATA — the text splitter — so
    // the scroller code must not have been redesigned: it still reads position, not gesture.
    expect(tsx).toContain('classifyHistoryScroll')
    expect(tsx).toContain('userScrollingUntil')
    expect(tsx).toContain('jump-to-latest')
  })
})

describe('the model view still feeds the persisted live transcript correctly', () => {
  it('primary text is the originals in order; the secondary is translations in the same order', () => {
    const m = model()
    for (let i = 0; i < 2; i++) {
      interim(m, i, JA[i])
      final(m, i, JA[i])
      tFinal(m, i, EN[i], JA[i])
    }
    const v = m.getView()
    expect(v.persistPrimaryFull).toBe(`${JA[0]} ${JA[1]}`)
    expect(v.persistSecondaryFull).toBe(`${EN[0]} ${EN[1]}`)
  })
})

describe('App wiring (source shape)', () => {
  const app = read('../App.tsx')

  it('the hosted live screen renders from the identity stack, not from the joined strings', () => {
    expect(app).toContain('captions={captionStack}')
    expect(app).not.toMatch(/sourceCommitted=|translationCommitted=|translationDraft=/)
    expect(app).toContain('buildBilingualStack(captionPairs, captionDraft')
  })

  it('only the pipelines without caption identity use the text stack', () => {
    expect(app).toMatch(/useLiveEngineV2\s*\?\s*buildBilingualStack[\s\S]*?:\s*buildTextStack/)
  })

  it('the overlay HUD pairs ONE caption with its own translation', () => {
    expect(app).toContain('const hud = v.draft ?? v.pairs[v.pairs.length - 1] ?? null')
    expect(app).toContain('tailForOverlay(hud?.translation ?? \'\', 28)')
    expect(app).not.toContain('committed: v.secondaryBlack')
  })

  it('the model is told both languages, so translation snapshots are cleaned for the right script', () => {
    expect(app).toContain('setTranslationLanguage(liveTranslationLanguage)')
  })
})
