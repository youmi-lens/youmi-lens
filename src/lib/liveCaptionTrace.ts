/**
 * Live caption event-stream audit trace.
 *
 * Attach to a LiveEngine session via traceLiveCaptionSession().
 * Logs every en/zh event with change classification so we can diagnose
 * whether the problem is upstream ASR, translation, or display logic.
 *
 * Output: console.info('[CaptionTrace] ...') -- open DevTools Console,
 * filter by "CaptionTrace" to see the full audit.
 */

import { captionDiagnosticsEnabled } from './captionDiagnostics'

function tracingEnabled(): boolean {
  return import.meta.env.DEV || captionDiagnosticsEnabled()
}

type ChangeKind =
  | 'new_segment'
  | 'exact_same'
  | 'prefix_growth'
  | 'suffix_rewrite'
  | 'full_rewrite'
  | 'shorter_regression'

function classifyChange(prev: string, next: string): ChangeKind {
  if (!prev) return 'new_segment'
  if (prev === next) return 'exact_same'
  if (next.startsWith(prev)) return 'prefix_growth'
  if (next.length < prev.length) return 'shorter_regression'
  const lcp = longestCommonPrefixLen(prev, next)
  if (lcp > prev.length * 0.6) return 'suffix_rewrite'
  return 'full_rewrite'
}

function longestCommonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

function head(s: string, n = 120): string {
  return s.length <= n ? s : s.slice(0, n) + '...'
}

function tail(s: string, n = 120): string {
  return s.length <= n ? s : '...' + s.slice(-n)
}

type SegHistory = {
  prevText: string
  interimCount: number
  firstInterimMs: number
  lastInterimMs: number
  finalMs: number
}

const segHistoryEn = new Map<string, SegHistory>()
const segHistoryZh = new Map<string, SegHistory>()
let sessionStartMs = 0

/** Wall-clock ms of last raw en_interim pipeline sample (for inter-event timing). */
let lastInterimPipelineWallMs = 0
/** Last en_interim / en_final arrival (wall ms) for stop-tail diagnosis. */
let lastEnInterimWallMs = 0
let lastEnFinalWallMs = 0

function elapsed(): number {
  return sessionStartMs ? Date.now() - sessionStartMs : 0
}

function getOrCreateHist(map: Map<string, SegHistory>, segId: string): SegHistory {
  let h = map.get(segId)
  if (!h) {
    h = { prevText: '', interimCount: 0, firstInterimMs: 0, lastInterimMs: 0, finalMs: 0 }
    map.set(segId, h)
  }
  return h
}

function out(tag: string, fields: Record<string, unknown>) {
  if (!tracingEnabled()) return
  console.info(`[CaptionTrace] ${tag}`, JSON.stringify(fields, null, 0))
}

export function traceReset() {
  segHistoryEn.clear()
  segHistoryZh.clear()
  sessionStartMs = Date.now()
  lastInterimPipelineWallMs = 0
  lastEnInterimWallMs = 0
  lastEnFinalWallMs = 0
  out('RESET', { sessionStartMs })
}

export function traceInterimPipeline(
  segmentId: string,
  rev: number,
  fields: {
    rawTok: number
    novelTok: number
    shrink6to2: boolean
  },
) {
  const wall = Date.now()
  const msSincePrev = lastInterimPipelineWallMs ? wall - lastInterimPipelineWallMs : 0
  lastInterimPipelineWallMs = wall
  out('INTERIM_PIPELINE', {
    ms: elapsed(),
    wallMs: wall,
    segmentId,
    rev,
    rawTok: fields.rawTok,
    novelTok: fields.novelTok,
    msSincePrev,
    shrink6to2: fields.shrink6to2 || undefined,
  })
}

export function traceDisplayGray(segmentId: string, strictTok: number, displayTok: number) {
  out('DISPLAY_GRAY', {
    ms: elapsed(),
    segmentId,
    strictTok,
    displayTok,
    delta: displayTok - strictTok,
  })
}

export function bumpEnInterimArrivalWall() {
  lastEnInterimWallMs = Date.now()
}

export function bumpEnFinalArrivalWall() {
  lastEnFinalWallMs = Date.now()
}

export function getEnArrivalWalls() {
  return { lastEnInterimWallMs, lastEnFinalWallMs }
}

export function traceCaptionStop(phase: string, extra?: Record<string, unknown>) {
  const w = Date.now()
  out('STOP', {
    phase,
    wallMs: w,
    lastEnInterimWallMs: lastEnInterimWallMs || undefined,
    lastEnFinalWallMs: lastEnFinalWallMs || undefined,
    ...extra,
  })
}

export function traceWsClosed(reason?: string) {
  out('WS_CLOSE', { wallMs: Date.now(), ms: elapsed(), reason })
}

export function traceEnInterim(segmentId: string, rev: number, text: string) {
  if (!tracingEnabled()) return
  const h = getOrCreateHist(segHistoryEn, segmentId)
  const kind = classifyChange(h.prevText, text)
  const now = elapsed()
  if (h.interimCount === 0) h.firstInterimMs = now
  h.interimCount++
  const sinceLast = h.lastInterimMs ? now - h.lastInterimMs : 0
  h.lastInterimMs = now

  out('en_interim', {
    ms: now,
    segmentId,
    rev,
    kind,
    len: text.length,
    prevLen: h.prevText.length,
    sinceLast,
    interimN: h.interimCount,
    head: head(text),
    tail: tail(text),
  })

  h.prevText = text
}

export function traceEnFinal(segmentId: string, text: string) {
  if (!tracingEnabled()) return
  const h = getOrCreateHist(segHistoryEn, segmentId)
  const kind = classifyChange(h.prevText, text)
  const now = elapsed()
  const sinceFirstInterim = h.firstInterimMs ? now - h.firstInterimMs : 0
  h.finalMs = now

  out('en_final', {
    ms: now,
    segmentId,
    kind,
    len: text.length,
    prevLen: h.prevText.length,
    interimCount: h.interimCount,
    sinceFirstInterim,
    head: head(text),
    tail: tail(text),
  })

  h.prevText = text
}

export function traceZhInterim(
  segmentId: string,
  rev: number,
  text: string,
  sourceEn: string,
  dropped: string | null,
) {
  if (!tracingEnabled()) return
  const h = getOrCreateHist(segHistoryZh, segmentId)
  const now = elapsed()
  h.interimCount++

  out('zh_interim', {
    ms: now,
    segmentId,
    rev,
    len: text.length,
    sourceEnLen: sourceEn.length,
    interimN: h.interimCount,
    dropped,
    head: head(text),
    tail: tail(text),
  })

  if (!dropped) h.prevText = text
}

export function traceZhFinal(
  segmentId: string,
  text: string,
  sourceEn: string,
  dropped: string | null,
) {
  if (!tracingEnabled()) return
  const h = getOrCreateHist(segHistoryZh, segmentId)
  const now = elapsed()

  out('zh_final', {
    ms: now,
    segmentId,
    len: text.length,
    sourceEnLen: sourceEn.length,
    dropped,
    head: head(text),
    tail: tail(text),
  })

  if (!dropped) h.prevText = text
}

export function traceDeOverlap(
  eventType: string,
  segmentId: string,
  incomingLen: number,
  info: {
    verdict: string
    overlapTokenCount: number
    incomingTokenCount: number
    novelTokenCount: number
    overlapPreview: string
    novelPreview: string
    novelText: string
    matchedAnchorLen: number
    matchedAnchorText: string
    suspiciousShortAnchor: boolean
    containmentRatio: number
  },
) {
  out('DE_OVERLAP', {
    ms: elapsed(),
    event: eventType,
    segmentId,
    verdict: info.verdict,
    incomingLen,
    overlapTokenCount: info.overlapTokenCount,
    novelLen: info.novelText.length,
    novelTokens: info.novelTokenCount,
    matchedAnchorLen: info.matchedAnchorLen,
    matchedAnchorText: info.matchedAnchorText || undefined,
    suspiciousShortAnchor: info.suspiciousShortAnchor || undefined,
    containmentRatio: info.containmentRatio ? +info.containmentRatio.toFixed(3) : undefined,
    overlapPreview: info.overlapPreview,
    novelPreview: info.novelPreview,
  })
}

export function traceView(view: {
  primaryBlack: string
  primaryGray: string
  secondaryBlack: string
  secondaryGray: string
}) {
  const grayTok = view.primaryGray.trim()
    ? view.primaryGray.trim().split(/\s+/).length
    : 0
  out('VIEW', {
    ms: elapsed(),
    blackEnLen: view.primaryBlack.length,
    grayEnLen: view.primaryGray.length,
    grayEnTok: grayTok,
    blackZhLen: view.secondaryBlack.length,
    grayZhLen: view.secondaryGray.length,
    grayEnHead: head(view.primaryGray, 80),
    grayZhHead: head(view.secondaryGray, 80),
  })
}

/**
 * How long after an ORIGINAL caption was finalized its own translation arrived.
 * The number the pairing contract is judged on: it is the window in which the
 * view must show "pending" (never another caption's translation).
 */
export function tracePairLag(segmentId: string, translationLagMs: number) {
  out('pair_translation_lag', { ms: elapsed(), segmentId, translationLagMs })
}
