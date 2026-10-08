/**
 * How long after an ORIGINAL caption became usable did ITS translation become usable?
 *
 * This is the number the live-translation acceptance is judged on. It is measured on
 * the client with one monotonic clock, from the moment the original text reached this
 * app to the moment the translation of exactly that text reached this app. Server-side
 * Qwen duration is NOT a substitute: it leaves out the network and the queueing.
 *
 *   final    — original = the `stream_final` of the LAST caption a group covers
 *   interim  — original = the moment the interim text the server translated (echoed
 *              back as `source_text`) was first seen here
 *
 * Pure: the clock is injected, nothing here touches the network or React.
 */

export type TranslationLagSample = {
  kind: 'interim' | 'final'
  lagMs: number
  at: number
}

export type TranslationLagStats = {
  count: number
  medianMs: number | null
  p90Ms: number | null
  maxMs: number | null
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

export function summarizeLag(values: readonly number[]): TranslationLagStats {
  if (values.length === 0) return { count: 0, medianMs: null, p90Ms: null, maxMs: null }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]
  return { count: sorted.length, medianMs: Math.round(at(0.5)), p90Ms: Math.round(at(0.9)), maxMs: Math.round(sorted[sorted.length - 1]) }
}

export class TranslationLagTracker {
  private readonly clock: () => number
  /** When each caption's final text arrived, by caption id. */
  private finalAt = new Map<string, number>()
  /** Recent interim texts per open caption → first time seen. */
  private interimSeen = new Map<string, Map<string, number>>()
  private samples: TranslationLagSample[] = []
  private static readonly MAX_SAMPLES = 500
  private static readonly MAX_TRACKED = 400

  constructor(clock: () => number = () => performance.now()) {
    this.clock = clock
  }

  reset() {
    this.finalAt.clear()
    this.interimSeen.clear()
    this.samples = []
  }

  noteInterim(segmentId: string, text: string) {
    const key = norm(text)
    if (!key) return
    let seen = this.interimSeen.get(segmentId)
    if (!seen) {
      seen = new Map()
      this.interimSeen.set(segmentId, seen)
    }
    if (!seen.has(key)) seen.set(key, this.clock())
    if (seen.size > 24) seen.delete(seen.keys().next().value as string)
    if (this.interimSeen.size > TranslationLagTracker.MAX_TRACKED) this.interimSeen.delete(this.interimSeen.keys().next().value as string)
  }

  noteFinal(segmentId: string) {
    this.finalAt.set(segmentId, this.clock())
    this.interimSeen.delete(segmentId)
    if (this.finalAt.size > TranslationLagTracker.MAX_TRACKED) this.finalAt.delete(this.finalAt.keys().next().value as string)
  }

  /** A draft translation arrived for `segmentId`, translating `sourceText`. */
  noteInterimTranslation(segmentId: string, sourceText: string | null): TranslationLagSample | null {
    if (!sourceText) return null
    const seenAt = this.interimSeen.get(segmentId)?.get(norm(sourceText))
    if (seenAt === undefined) return null
    return this.record('interim', this.clock() - seenAt)
  }

  /** A final translation arrived covering `segmentIds` (the LAST one's final is the clock start). */
  noteFinalTranslation(segmentIds: readonly string[]): TranslationLagSample | null {
    const last = segmentIds[segmentIds.length - 1]
    const at = last === undefined ? undefined : this.finalAt.get(last)
    if (at === undefined) return null
    return this.record('final', this.clock() - at)
  }

  private record(kind: TranslationLagSample['kind'], lagMs: number): TranslationLagSample {
    const sample = { kind, lagMs: Math.max(0, Math.round(lagMs)), at: this.clock() }
    this.samples.push(sample)
    if (this.samples.length > TranslationLagTracker.MAX_SAMPLES) this.samples.shift()
    return sample
  }

  stats(): { interim: TranslationLagStats; final: TranslationLagStats; all: TranslationLagStats } {
    const of = (k?: TranslationLagSample['kind']) => summarizeLag(this.samples.filter((s) => !k || s.kind === k).map((s) => s.lagMs))
    return { interim: of('interim'), final: of('final'), all: of() }
  }
}
