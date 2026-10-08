/**
 * Same-utterance **display** snapshot compaction: deterministic, lightweight,
 * not NLP - collapses obvious ASR/translation self-repetition inside one line.
 * Intended to be idempotent so engine + session may both apply safely.
 */
import { normCaptionSpaces } from './liveCaptionSanitize'

function collapseWholeStringRepeat(t: string, minUnitChars: number): string {
  const s = normCaptionSpaces(t)
  const n = s.length
  if (n < minUnitChars * 2) return t
  for (let parts = 5; parts >= 2; parts--) {
    const unitLen = Math.floor(n / parts)
    if (unitLen < minUnitChars) continue
    const unit = normCaptionSpaces(s.slice(0, unitLen))
    if (unit.length < minUnitChars) continue
    let ok = true
    for (let p = 1; p < parts; p++) {
      const seg = normCaptionSpaces(s.slice(unitLen * p, unitLen * (p + 1)))
      if (seg !== unit) {
        ok = false
        break
      }
    }
    if (ok) return collapseWholeStringRepeat(unit, minUnitChars)
  }
  return t
}

/** Last k words identical to the k words before them: drop the trailing duplicate block (repeat). */
function collapseDoubledSuffixWords(t: string, minWordsInBlock: number, minBlockChars: number): string {
  let words = normCaptionSpaces(t)
    .split(/\s+/)
    .filter(Boolean)
  let guard = 0
  while (words.length >= minWordsInBlock * 2 && guard++ < 48) {
    let removed = false
    const maxK = Math.floor(words.length / 2)
    for (let k = maxK; k >= minWordsInBlock; k--) {
      const a = words.slice(-2 * k, -k).join(' ')
      const b = words.slice(-k).join(' ')
      if (a === b && a.length >= minBlockChars) {
        words = words.slice(0, -k)
        removed = true
        break
      }
    }
    if (!removed) break
  }
  return words.join(' ')
}

function splitEnglishSentences(t: string): string[] {
  const s = t.trim()
  if (!s) return []
  return s
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter(Boolean)
}

function mergeAdjacentDuplicateSentences(sentences: string[], locale: string): string[] {
  if (sentences.length <= 1) return sentences
  const out: string[] = []
  for (const sent of sentences) {
    const key = normCaptionSpaces(sent).toLocaleLowerCase(locale)
    const prevKey =
      out.length > 0 ? normCaptionSpaces(out[out.length - 1]!).toLocaleLowerCase(locale) : ''
    if (key && key === prevKey) continue
    out.push(sent)
  }
  return out
}

/**
 * Compacts a single English interim/full-line snapshot: whole-string repeats,
 * doubled word suffixes, adjacent duplicate sentences.
 */
export function compactLiveEnglishSnapshot(raw: string): string {
  let t = normCaptionSpaces(raw)
  if (t.length < 12) return t

  t = collapseWholeStringRepeat(t, 10)
  t = normCaptionSpaces(t)
  t = collapseDoubledSuffixWords(t, 4, 14)
  t = normCaptionSpaces(t)

  const sents = splitEnglishSentences(t)
  if (sents.length >= 2) {
    t = mergeAdjacentDuplicateSentences(sents, 'en').join(' ')
    t = normCaptionSpaces(t)
  }

  t = collapseDoubledSuffixWords(t, 4, 14)
  return normCaptionSpaces(t)
}

/** Splits on CJK/ASCII sentence ends; keeps delimiter on each chunk (pattern is \\u-only for encoding safety). */
function splitZhSentences(t: string): string[] {
  const s = t.trim()
  if (!s) return []
  const punct = '\u3002\uFF01\uFF1F!?.'
  const m = s.match(new RegExp(`[^${punct}]+(?:[${punct}])?`, 'gu'))
  if (!m) return [s]
  return m.map((x) => x.trim()).filter(Boolean)
}

/** Last k chars equal the k chars before them (no sentence mark): drop trailing duplicate run. */
function collapseDoubledSuffixChars(t: string, minK: number, maxK: number): string {
  let s = t
  let guard = 0
  while (s.length >= minK * 2 && guard++ < 32) {
    const n = s.length
    let removed = false
    const hi = Math.min(maxK, Math.floor(n / 2))
    for (let k = hi; k >= minK; k--) {
      const a = s.slice(-2 * k, -k)
      const b = s.slice(-k)
      if (a === b && a.length >= minK) {
        s = s.slice(0, -k)
        removed = true
        break
      }
    }
    if (!removed) break
  }
  return s
}

/** Compacts obvious internal repetition in a Chinese (or mixed CJK) interim line. */
export function compactLiveZhSnapshot(raw: string): string {
  let t = normCaptionSpaces(raw)
  if (t.length < 12) return t

  t = collapseWholeStringRepeat(t, 8)
  t = normCaptionSpaces(t)
  t = collapseDoubledSuffixChars(t, 10, 160)
  t = normCaptionSpaces(t)

  const sents = splitZhSentences(t)
  if (sents.length >= 2) {
    t = mergeAdjacentDuplicateSentences(sents, 'zh').join('')
    t = normCaptionSpaces(t)
  }

  t = collapseDoubledSuffixChars(t, 10, 160)
  return normCaptionSpaces(t)
}

/**
 * Clean one live TRANSLATION snapshot for the language it is written in.
 *
 * `compactLiveZhSnapshot` is Chinese-specific: it splits on sentence punctuation
 * and re-joins with no separator, which is right for Chinese and wrong for any
 * space-delimited language ("algorithms. Then" → "algorithms.Then"). An English
 * (or other Latin-script) translation only gets whitespace normalisation.
 */
export function compactTranslationSnapshot(raw: string, script: 'latin' | 'cjk'): string {
  return script === 'cjk' ? compactLiveZhSnapshot(raw) : normCaptionSpaces(raw)
}
