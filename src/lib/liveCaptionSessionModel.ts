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
import { compactLiveZhSnapshot } from './liveCaptionCompaction'
import {
  isGarbledMixedScriptLine,
  normCaptionSpaces,
  normalizeEnglishPrimaryPayloadOrReject,
  sanitizeEnglishForZhTranslate,
} from './liveCaptionSanitize'
import { traceDisplayGray, traceView, traceZhFinal, traceZhInterim } from './liveCaptionTrace'
import type { LiveEngineEvent } from './liveEngine/types'

// ── Types ────────────────────────────────────────────────────────────────────

export type UtteranceId = string

export type LiveCaptionCommittedLine = { id: UtteranceId; text: string }

export type LiveCaptionCurrentEn = { id: UtteranceId; text: string } | null
export type LiveCaptionCurrentZh = { id: UtteranceId; text: string } | null

export type LiveCaptionSessionState = {
  committedEn: LiveCaptionCommittedLine[]
  currentEn: LiveCaptionCurrentEn
  /** Smoothed EN gray for UI only; strict novel for persistence stays in `currentEn.text`. */
  displayGrayEn: string
  committedZh: LiveCaptionCommittedLine[]
  currentZh: LiveCaptionCurrentZh
  finalizedZhIds: Set<string>
  lastEnFinalSanitizedById: Map<string, string>
  openUtteranceSeq: number
}

export type LiveCaptionView = {
  primaryBlack: string
  primaryGray: string
  secondaryBlack: string
  secondaryGray: string
  persistPrimaryFull: string
  persistSecondaryFull: string
  committedEnJoin: string
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
    committedZh: [],
    currentZh: null,
    finalizedZhIds: new Set(),
    lastEnFinalSanitizedById: new Map(),
    openUtteranceSeq: -1,
  }
}

// ── Projection ───────────────────────────────────────────────────────────────

let _viewCallCount = 0

function projectView(s: LiveCaptionSessionState): LiveCaptionView {
  const committedEnJoin = joinLines(s.committedEn)
  const committedZhJoin = joinLines(s.committedZh)

  const grayEnStrict = s.currentEn?.text ?? ''
  const grayEn = s.displayGrayEn.trim() ? s.displayGrayEn : grayEnStrict
  const grayZh = s.currentZh?.text ?? ''

  const persistPrimaryFull = [committedEnJoin, grayEnStrict].filter(Boolean).join(' ').trim()
  const persistSecondaryFull = [committedZhJoin, grayZh].filter(Boolean).join(' ').trim()

  const view = {
    primaryBlack: committedEnJoin ? windowTailWords(committedEnJoin, 150) : '',
    primaryGray: grayEn,
    secondaryBlack: committedZhJoin ? windowTailWords(committedZhJoin, 150) : '',
    secondaryGray: grayZh,
    persistPrimaryFull,
    persistSecondaryFull,
    committedEnJoin,
  }
  if (++_viewCallCount % 5 === 0) traceView(view)
  return view
}

// ── Event types ──────────────────────────────────────────────────────────────

export type LiveCaptionEngineApplyEvent =
  | { type: 'en_interim'; segmentId: string; rev: number; text: string }
  | { type: 'en_final'; segmentId: string; text: string }
  | { type: 'zh_interim'; segmentId: string; rev: number; text: string; sourceEn: string }
  | { type: 'zh_final'; segmentId: string; text: string; sourceEn: string }

export function liveCaptionEventFromEngine(ev: LiveEngineEvent): LiveCaptionEngineApplyEvent | null {
  if (ev.type === 'en_interim' || ev.type === 'en_final' || ev.type === 'zh_interim' || ev.type === 'zh_final') {
    return ev
  }
  return null
}

// ── Session model ────────────────────────────────────────────────────────────

export class LiveCaptionSessionModel {
  private s: LiveCaptionSessionState = initialState()

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
      const text = normalizeEnglishPrimaryPayloadOrReject(ev.text)
      if (!text) return projectView(this.s)
      if (open >= 0 && seq < open) return projectView(this.s)
      // A late interim for a segment that has already been committed would
      // reappear as the gray current line while the same words sit in history —
      // the sentence rendered twice. zh_interim has always guarded this with
      // `finalizedZhIds`; English had no equivalent.
      if (this.s.committedEn.some((line) => line.id === ev.segmentId)) {
        return projectView(this.s)
      }

      if (this.s.currentZh && this.s.currentZh.id !== ev.segmentId) {
        this.s.currentZh = null
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
      const text = normalizeEnglishPrimaryPayloadOrReject(ev.text)
      if (!text) return projectView(this.s)
      if (open >= 0 && seq < open) {
        // An out-of-order final for an ALREADY COMMITTED segment is still a
        // legitimate correction of that segment; only unknown stale ids drop.
        const known = this.s.committedEn.some((line) => line.id === ev.segmentId)
        if (!known) return projectView(this.s)
      }

      this.s.lastEnFinalSanitizedById.set(ev.segmentId, sanitizeEnglishForZhTranslate(text))

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
    if (ev.type === 'zh_interim') {
      if (isGarbledMixedScriptLine(ev.text)) {
        traceZhInterim(ev.segmentId, ev.rev, ev.text, ev.sourceEn, 'garbled')
        return projectView(this.s)
      }
      if (this.s.finalizedZhIds.has(ev.segmentId)) {
        traceZhInterim(ev.segmentId, ev.rev, ev.text, ev.sourceEn, 'already_finalized')
        return projectView(this.s)
      }

      const text = (compactLiveZhSnapshot(ev.text.trim()) || '').trim() || ev.text.trim()
      traceZhInterim(ev.segmentId, ev.rev, text, ev.sourceEn, null)
      this.s.currentZh = { id: ev.segmentId, text }
      return projectView(this.s)
    }

    // ── zh_final ───────────────────────────────────────────────────────────
    if (ev.type === 'zh_final') {
      if (isGarbledMixedScriptLine(ev.text)) {
        traceZhFinal(ev.segmentId, ev.text, ev.sourceEn, 'garbled')
        return projectView(this.s)
      }
      if (this.s.finalizedZhIds.has(ev.segmentId)) {
        traceZhFinal(ev.segmentId, ev.text, ev.sourceEn, 'already_finalized')
        return projectView(this.s)
      }

      const expectedSan = normCaptionSpaces(
        this.s.lastEnFinalSanitizedById.get(ev.segmentId) ?? '',
      ).toLowerCase()
      const srcSan = normCaptionSpaces(ev.sourceEn).toLowerCase()
      if (expectedSan && srcSan && expectedSan !== srcSan) {
        traceZhFinal(ev.segmentId, ev.text, ev.sourceEn, 'source_mismatch')
        this.s.lastEnFinalSanitizedById.delete(ev.segmentId)
        return projectView(this.s)
      }
      this.s.lastEnFinalSanitizedById.delete(ev.segmentId)
      this.s.finalizedZhIds.add(ev.segmentId)
      traceZhFinal(ev.segmentId, ev.text, ev.sourceEn, null)

      const text = ev.text.trim()
      if (text) {
        const zidx = this.s.committedZh.findIndex((x) => x.id === ev.segmentId)
        if (zidx >= 0) {
          this.s.committedZh = this.s.committedZh.map((x, i) =>
            i === zidx ? { id: ev.segmentId, text } : x,
          )
        } else {
          this.s.committedZh = [...this.s.committedZh, { id: ev.segmentId, text }]
        }
      }
      if (this.s.currentZh?.id === ev.segmentId) {
        this.s.currentZh = null
      }
      if (!this.s.currentEn && !this.s.currentZh) {
        this.s.openUtteranceSeq = -1
      }
      if (this.s.finalizedZhIds.size > 80) {
        const arr = [...this.s.finalizedZhIds]
        this.s.finalizedZhIds = new Set(arr.slice(-40))
      }
      return projectView(this.s)
    }

    return projectView(this.s)
  }
}
