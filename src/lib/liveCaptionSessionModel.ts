/**
 * Live-caption display state machine.
 *
 * The engine performs token-based de-overlap before emitting events, so all
 * en_interim / en_final text is already "novelText" (only the genuinely new
 * portion). This model simply accumulates finals and displays the current
 * interim as-is.
 *
 * Committed en/zh are append-only (never replaced) to stay monotonic.
 */
import { isSpaceDelimited, type ContentLanguageCode } from './contentLanguages'
import { compactTranslationSnapshot } from './liveCaptionCompaction'
import {
  isGarbledMixedScriptLine,
  normCaptionSpaces,
  normalizePrimaryPayloadOrReject,
  sanitizeSourceForTranslate,
} from './liveCaptionSanitize'
import { traceDisplayGray, tracePairLag, traceView, traceZhFinal, traceZhInterim } from './liveCaptionTrace'
import type { LiveEngineEvent } from './liveEngine/types'

// ── Types ────────────────────────────────────────────────────────────────────

export type UtteranceId = string

export type LiveCaptionCommittedLine = { id: UtteranceId; text: string }

export type LiveCaptionCurrentEn = { id: UtteranceId; text: string } | null
export type LiveCaptionCurrentZh = { id: UtteranceId; text: string } | null

/**
 * A translation belongs to ONE original utterance, identified by its segment id.
 * It is stored under that id and read back under that id — there is no "current
 * translation" slot anywhere, so a response that arrives late can only ever
 * complete its own caption, never whichever caption happens to be on screen.
 */
export type LiveCaptionTranslation = { text: string; final: boolean; rev: number }

/**
 * ONE final translation that covers several captions (the server translates a sentence
 * that ASR split across finals as a single unit). It names every caption it covers; the
 * model never works out membership from position, timing or arrival order.
 */
export type LiveCaptionTranslationGroup = { key: string; ids: readonly string[]; text: string }

export type LiveCaptionSessionState = {
  committedEn: LiveCaptionCommittedLine[]
  currentEn: LiveCaptionCurrentEn
  /** Smoothed EN gray for UI only; strict novel for persistence stays in `currentEn.text`. */
  displayGrayEn: string
  /** Translation per ORIGINAL segment id (interim until the final one lands). */
  translations: Map<string, LiveCaptionTranslation>
  /** Final translations that cover one or more captions, and which group each caption is in. */
  groups: Map<string, LiveCaptionTranslationGroup>
  groupOf: Map<string, string>
  lastEnFinalSanitizedById: Map<string, string>
  openUtteranceSeq: number
  /** Wall-clock marks per segment, for the original → translation lag diagnostics. */
  finalAtById: Map<string, number>
  /** Bumped whenever a committed line or ANY translation changes; keys the pair cache. */
  version: number
  pairsCache: { version: number; pairs: LiveCaptionPair[] } | null
}

export type TranslationState = 'none' | 'interim' | 'final'

/**
 * One original caption and — only ever — its own translation.
 * `translationState === 'none'` means no translation for THIS caption has
 * arrived; the view must then show nothing (or "translating"), never another
 * caption's translation.
 */
export type LiveCaptionPair = {
  id: UtteranceId
  seq: number
  original: string
  originalFinal: boolean
  /** This caption's OWN translation. For a grouped caption see `groupKey` / `groupText`. */
  translation: string
  translationState: TranslationState
  /** Set when a final translation covering this caption AND others names it in `source_ids`. */
  groupKey: string | null
  /** The whole group's translated text (identical on every member); '' when ungrouped. */
  groupText: string
}

export type LiveCaptionView = {
  primaryBlack: string
  primaryGray: string
  secondaryBlack: string
  secondaryGray: string
  persistPrimaryFull: string
  persistSecondaryFull: string
  committedEnJoin: string
  /** Finalized captions, oldest first, each with its own translation. */
  pairs: LiveCaptionPair[]
  /** The caption being spoken right now (not yet final), with ITS translation. */
  draft: LiveCaptionPair | null
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function liveCaptionSegmentSeq(segmentId: string): number {
  const m = /^(?:seg|stream)-(\d+)$/.exec(segmentId)
  if (!m) return Number.MAX_SAFE_INTEGER
  return Number(m[1])
}

function windowTailWords(full: string, maxWords: number): string {
  const t = full.trim()
  if (!t) return ''
  const words = t.split(/\s+/)
  return words.length > maxWords ? words.slice(-maxWords).join(' ') : t
}

function joinLines(lines: readonly LiveCaptionCommittedLine[]): string {
  return lines.map((x) => x.text).join(' ').trim()
}

function tokenCount(s: string): number {
  const t = s.trim()
  if (!t) return 0
  return t.split(/\s+/).length
}

/** Merge per-interim novel chunks into a readable rolling draft (display only). */
function mergeRollingGray(prev: string, novel: string): string {
  const n = novel.trim()
  if (!n) return prev
  const p = prev.trimEnd()
  if (!p) return n
  if (p === n) return p
  if (n.startsWith(p)) return n
  if (p.endsWith(n)) return p
  return `${p} ${n}`.replace(/\s+/g, ' ').trim()
}

// ── State ────────────────────────────────────────────────────────────────────

function initialState(): LiveCaptionSessionState {
  return {
    committedEn: [],
    currentEn: null,
    displayGrayEn: '',
    translations: new Map(),
    groups: new Map(),
    groupOf: new Map(),
    lastEnFinalSanitizedById: new Map(),
    openUtteranceSeq: -1,
    finalAtById: new Map(),
    version: 0,
    pairsCache: null,
  }
}

// ── Projection ───────────────────────────────────────────────────────────────

let _viewCallCount = 0

function pairFor(
  s: LiveCaptionSessionState,
  line: LiveCaptionCommittedLine,
  originalFinal: boolean,
): LiveCaptionPair {
  const tr = s.translations.get(line.id)
  const groupKey = s.groupOf.get(line.id) ?? null
  const group = groupKey ? s.groups.get(groupKey) : undefined
  if (group) {
    // A caption covered by a group translation. Its own text is the group's text only when
    // the group is just this one caption; otherwise the group text lives on `groupText`.
    return {
      id: line.id,
      seq: liveCaptionSegmentSeq(line.id),
      original: line.text,
      originalFinal,
      translation: group.ids.length === 1 ? group.text : '',
      translationState: 'final',
      groupKey: group.ids.length === 1 ? null : group.key,
      groupText: group.ids.length === 1 ? '' : group.text,
    }
  }
  return {
    id: line.id,
    seq: liveCaptionSegmentSeq(line.id),
    original: line.text,
    originalFinal,
    translation: tr?.text ?? '',
    translationState: tr ? (tr.final ? 'final' : 'interim') : 'none',
    groupKey: null,
    groupText: '',
  }
}

function committedPairs(s: LiveCaptionSessionState): LiveCaptionPair[] {
  if (s.pairsCache && s.pairsCache.version === s.version) return s.pairsCache.pairs
  const pairs = s.committedEn.map((line) => pairFor(s, line, true))
  s.pairsCache = { version: s.version, pairs }
  return pairs
}

function projectView(s: LiveCaptionSessionState): LiveCaptionView {
  const committedEnJoin = joinLines(s.committedEn)
  const pairs = committedPairs(s)

  const grayEnStrict = s.currentEn?.text ?? ''
  const grayEn = s.displayGrayEn.trim() ? s.displayGrayEn : grayEnStrict

  // The open caption and ITS translation — keyed by id, so a translation of an
  // earlier caption can never show up here.
  const draft: LiveCaptionPair | null = s.currentEn
    ? pairFor(s, { id: s.currentEn.id, text: grayEn }, false)
    : null
  const grayZh = draft?.translation ?? ''

  // Translations, in ORIGINAL order (not in the order responses happened to arrive). A group's text
  // is counted once, however many captions it covers.
  const translatedTexts = (finalOnly: boolean): string => {
    const out: string[] = []
    let lastGroup: string | null = null
    for (const p of pairs) {
      if (p.groupKey) {
        if (p.groupKey !== lastGroup) out.push(p.groupText)
        lastGroup = p.groupKey
        continue
      }
      lastGroup = null
      if (p.translationState === 'none') continue
      if (finalOnly && p.translationState !== 'final') continue
      out.push(p.translation)
    }
    return out.join(' ').trim()
  }
  const committedZhJoin = translatedTexts(true)
  const anyZhJoin = translatedTexts(false)

  const persistPrimaryFull = [committedEnJoin, grayEnStrict].filter(Boolean).join(' ').trim()
  const persistSecondaryFull = [anyZhJoin, grayZh].filter(Boolean).join(' ').trim()

  const view = {
    primaryBlack: committedEnJoin ? windowTailWords(committedEnJoin, 150) : '',
    primaryGray: grayEn,
    secondaryBlack: committedZhJoin ? windowTailWords(committedZhJoin, 150) : '',
    secondaryGray: grayZh,
    persistPrimaryFull,
    persistSecondaryFull,
    committedEnJoin,
    pairs,
    draft,
  }
  if (++_viewCallCount % 5 === 0) traceView(view)
  return view
}

// ── Event types ──────────────────────────────────────────────────────────────

export type LiveCaptionEngineApplyEvent =
  | { type: 'en_interim'; segmentId: string; rev: number; text: string }
  | { type: 'en_final'; segmentId: string; text: string }
  | { type: 'zh_interim'; segmentId: string; rev: number; text: string; sourceEn: string }
  | { type: 'zh_final'; segmentId: string; segmentIds?: string[]; text: string; sourceEn: string }

export function liveCaptionEventFromEngine(ev: LiveEngineEvent): LiveCaptionEngineApplyEvent | null {
  if (ev.type === 'en_interim' || ev.type === 'en_final' || ev.type === 'zh_interim' || ev.type === 'zh_final') {
    return ev
  }
  return null
}

// ── Session model ────────────────────────────────────────────────────────────

export class LiveCaptionSessionModel {
  private s: LiveCaptionSessionState = initialState()
  /** The language being spoken in this session: decides which primary captions are valid. */
  private sourceLanguage: ContentLanguageCode = 'en'

  /** Does the TRANSLATION separate words with spaces? Decides how its snapshots are cleaned. */
  private translationSpaced = false
  /** The "garbled mixed script" guard is a Simplified-Chinese output check — no other target. */
  private chineseTarget = true

  setSourceLanguage(language: ContentLanguageCode) {
    this.sourceLanguage = language
  }

  setTranslationLanguage(language: ContentLanguageCode) {
    this.translationSpaced = isSpaceDelimited(language)
    this.chineseTarget = language === 'zh-Hans'
  }

  /** Injectable clock, so the lag diagnostics are testable. */
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** A translation can attach only to a caption the model actually has. */
  private knowsSegment(id: string): boolean {
    return this.s.currentEn?.id === id || this.s.committedEn.some((line) => line.id === id)
  }

  /** Bound the map during a very long lecture: keep translations of captions still held. */
  private pruneTranslations() {
    const keep = new Set(this.s.committedEn.map((line) => line.id))
    if (this.s.currentEn) keep.add(this.s.currentEn.id)
    for (const id of [...this.s.translations.keys()]) if (!keep.has(id)) this.s.translations.delete(id)
  }

  /**
   * The "garbled" guard (Han next to a 5+ letter Latin word) exists for CHINESE output only. Japanese
   * and Korean translations legitimately carry Latin terms, and a Latin-script translation may carry a name.
   */
  private isGarbledTranslation(text: string): boolean {
    return this.chineseTarget && isGarbledMixedScriptLine(text)
  }

  reset() {
    this.s = initialState()
  }

  getView(): LiveCaptionView {
    return projectView(this.s)
  }

  apply(ev: LiveCaptionEngineApplyEvent): LiveCaptionView {
    const seq = liveCaptionSegmentSeq(ev.segmentId)
    const open = this.s.openUtteranceSeq

    // ── en_interim ─────────────────────────────────────────────────────────
    if (ev.type === 'en_interim') {
      const text = normalizePrimaryPayloadOrReject(ev.text, this.sourceLanguage)
      if (!text) return projectView(this.s)
      if (open >= 0 && seq < open) return projectView(this.s)
      // A late interim for a segment that has already been committed would
      // reappear as the gray current line while the same words sit in history —
      // the sentence rendered twice. zh_interim has always guarded this with
      // `finalizedZhIds`; English had no equivalent.
      if (this.s.committedEn.some((line) => line.id === ev.segmentId)) {
        return projectView(this.s)
      }

      if (this.s.currentEn && this.s.currentEn.id !== ev.segmentId) {
        // The previous open caption was never finalized: it is abandoned, and so is
        // anything translated for it. (A finalized caption keeps its translation.)
        if (this.s.translations.delete(this.s.currentEn.id)) this.s.version++
      }
      if (this.s.currentEn?.id !== ev.segmentId) {
        this.s.displayGrayEn = text
      } else {
        this.s.displayGrayEn = mergeRollingGray(this.s.displayGrayEn, text)
      }
      this.s.currentEn = { id: ev.segmentId, text }
      traceDisplayGray(ev.segmentId, tokenCount(text), tokenCount(this.s.displayGrayEn))
      this.s.openUtteranceSeq = seq
      return projectView(this.s)
    }

    // ── en_final ───────────────────────────────────────────────────────────
    // Text is already de-overlapped novelText from the engine.
    //
    // Reconciliation is keyed on `segmentId`, exactly as zh_final has always
    // been. This branch used to be unconditional append:
    //
    //     committedEn = [...committedEn, { id, text }]
    //
    // with no check for an id already present, so any repeat of a final — a
    // provider retry, a duplicated frame, or a reconnect replaying the session —
    // committed the same sentence again. That is the observed bug: one spoken
    // sentence stacking up many times in the caption stream.
    //
    // Identity, not text, decides. The same sentence genuinely spoken twice
    // arrives under two different segment ids and is kept twice; only the SAME
    // segment collapses. No global text dedupe is performed anywhere, because
    // that would silently delete legitimate repetition.
    if (ev.type === 'en_final') {
      const text = normalizePrimaryPayloadOrReject(ev.text, this.sourceLanguage)
      if (!text) return projectView(this.s)
      if (open >= 0 && seq < open) {
        // An out-of-order final for an ALREADY COMMITTED segment is still a
        // legitimate correction of that segment; only unknown stale ids drop.
        const known = this.s.committedEn.some((line) => line.id === ev.segmentId)
        if (!known) return projectView(this.s)
      }

      this.s.lastEnFinalSanitizedById.set(ev.segmentId, sanitizeSourceForTranslate(text, this.sourceLanguage))
      this.s.version++
      if (!this.s.finalAtById.has(ev.segmentId)) this.s.finalAtById.set(ev.segmentId, this.now())

      const existing = this.s.committedEn.findIndex((line) => line.id === ev.segmentId)
      if (existing >= 0) {
        // Replace in place: a corrected final keeps its position in the
        // transcript, and an identical replay is a no-op rather than a copy.
        if (this.s.committedEn[existing].text !== text) {
          this.s.committedEn = this.s.committedEn.map((line, i) =>
            i === existing ? { id: ev.segmentId, text } : line,
          )
        }
      } else {
        this.s.committedEn = [...this.s.committedEn, { id: ev.segmentId, text }]
      }

      if (this.s.currentEn?.id === ev.segmentId) {
        this.s.currentEn = null
        this.s.displayGrayEn = ''
      }
      this.s.openUtteranceSeq = Math.max(this.s.openUtteranceSeq, seq)
      return projectView(this.s)
    }

    // ── zh_interim ─────────────────────────────────────────────────────────
    // Translation events carry the id of the ORIGINAL utterance they translate and
    // are stored under that id. Nothing here reads "whatever is current".
    if (ev.type === 'zh_interim') {
      if (this.isGarbledTranslation(ev.text)) {
        traceZhInterim(ev.segmentId, ev.rev, ev.text, ev.sourceEn, 'garbled')
        return projectView(this.s)
      }
      if (!this.knowsSegment(ev.segmentId)) {
        // The caption it belonged to was abandoned (or never existed): nothing to attach to.
        traceZhInterim(ev.segmentId, ev.rev, ev.text, ev.sourceEn, 'unknown_segment')
        return projectView(this.s)
      }
      const prev = this.s.translations.get(ev.segmentId)
      if (prev?.final || this.s.groupOf.has(ev.segmentId)) {
        traceZhInterim(ev.segmentId, ev.rev, ev.text, ev.sourceEn, 'already_finalized')
        return projectView(this.s)
      }
      if (prev && ev.rev <= prev.rev) {
        // An older response that overtook a newer one on the wire.
        traceZhInterim(ev.segmentId, ev.rev, ev.text, ev.sourceEn, 'out_of_order')
        return projectView(this.s)
      }

      const text = (compactTranslationSnapshot(ev.text.trim(), this.translationSpaced ? 'latin' : 'cjk') || '').trim() || ev.text.trim()
      traceZhInterim(ev.segmentId, ev.rev, text, ev.sourceEn, null)
      this.s.translations.set(ev.segmentId, { text, final: false, rev: ev.rev })
      this.s.version++
      return projectView(this.s)
    }

    // ── zh_final ───────────────────────────────────────────────────────────
    // `segmentIds` (from the server's `source_ids`) names EVERY caption the text covers. Without
    // it the event is a single-caption translation of `segmentId`.
    if (ev.type === 'zh_final') {
      const named = ev.segmentIds && ev.segmentIds.length > 0 ? [...new Set(ev.segmentIds)] : [ev.segmentId]
      const grouped = Boolean(ev.segmentIds && ev.segmentIds.length > 0)
      // A caption the engine dropped as a pure repeat (no novel text) was never shown, so it has
      // nothing to attach to; the captions that WERE shown and named still get the translation.
      const ids = named.filter((id) => this.knowsSegment(id))
      if (this.isGarbledTranslation(ev.text)) {
        traceZhFinal(ev.segmentId, ev.text, ev.sourceEn, 'garbled')
        return projectView(this.s)
      }
      if (ids.length === 0) {
        traceZhFinal(ev.segmentId, ev.text, ev.sourceEn, 'unknown_segment')
        return projectView(this.s)
      }
      if (ids.some((id) => this.s.translations.get(id)?.final || this.s.groupOf.has(id))) {
        traceZhFinal(ev.segmentId, ev.text, ev.sourceEn, 'already_finalized')
        return projectView(this.s)
      }

      if (!grouped) {
        // Legacy single-caption event: the source text it echoes must still match.
        const expectedSan = normCaptionSpaces(
          this.s.lastEnFinalSanitizedById.get(ev.segmentId) ?? '',
        ).toLowerCase()
        const srcSan = normCaptionSpaces(ev.sourceEn).toLowerCase()
        if (expectedSan && srcSan && expectedSan !== srcSan) {
          traceZhFinal(ev.segmentId, ev.text, ev.sourceEn, 'source_mismatch')
          this.s.lastEnFinalSanitizedById.delete(ev.segmentId)
          return projectView(this.s)
        }
      }
      for (const id of ids) this.s.lastEnFinalSanitizedById.delete(id)
      traceZhFinal(ev.segmentId, ev.text, ev.sourceEn, null)

      const text = ev.text.trim()
      if (text) {
        if (ids.length === 1) {
          // `final` ends the caption's translation: no later interim can touch it.
          this.s.translations.set(ids[0], { text, final: true, rev: Number.MAX_SAFE_INTEGER })
        } else {
          const key = ids.join('+')
          this.s.groups.set(key, { key, ids, text })
          for (const id of ids) {
            this.s.groupOf.set(id, key)
            this.s.translations.delete(id) // the group's text supersedes any draft for its members
          }
        }
        this.s.version++
        const finalAt = this.s.finalAtById.get(ids[ids.length - 1])
        if (finalAt !== undefined) tracePairLag(ev.segmentId, this.now() - finalAt)
      }
      if (!this.s.currentEn) {
        this.s.openUtteranceSeq = -1
      }
      if (this.s.translations.size > 400) this.pruneTranslations()
      return projectView(this.s)
    }

    return projectView(this.s)
  }
}
