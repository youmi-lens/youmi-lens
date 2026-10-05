/**
 * When to translate an INTERIM (still-being-spoken) caption.
 *
 * The rule was written for English, in characters: a first translation at 6
 * characters, then every 14 characters of growth (≈3 words), or after 520 ms and
 * 4 more characters. Those numbers do not transfer to Chinese, Japanese or Korean,
 * where one character carries roughly a word's worth of meaning: 6 characters is
 * ~1.3 s of speech before anything is translated, and 14 is ~3 s, longer than a
 * whole ASR phrase. So the thresholds follow the SPOKEN language's script.
 *
 * `latin` is EXACTLY the previous rule (byte-for-byte the same numbers and
 * punctuation set), so English and every other Latin-script language — and the
 * iPad behaviour built on them — are unchanged.
 *
 * The CJK numbers were chosen from a calibrated request-volume simulation
 * (see the deployment report), not by feel: a first fragment after 3 characters,
 * +10 characters of growth, and an 800 ms / +4 character time gate.
 */

export const INTERIM_RULES = Object.freeze({
  latin: Object.freeze({ firstMin: 6, growth: 14, timeMs: 520, timeGrowth: 4, boundary: /[.!?,;:…]\s*$/ }),
  cjk: Object.freeze({ firstMin: 3, growth: 10, timeMs: 800, timeGrowth: 4, boundary: /[.!?…。！？]\s*$/ }),
})

const CJK_SOURCES = new Set(['zh-Hans', 'ja', 'ko'])

/** The script class that decides the interim thresholds for a source language. */
export function scriptForSource(sourceLanguage) {
  return CJK_SOURCES.has(sourceLanguage) ? 'cjk' : 'latin'
}

/**
 * @param {string} text latest interim source text
 * @param {{ lastText: string, lastAt: number, now: number, script: 'latin'|'cjk' }} state
 */
export function shouldTranslateInterim(text, { lastText, lastAt, now, script }) {
  const rule = INTERIM_RULES[script] ?? INTERIM_RULES.latin
  const t = (text ?? '').trim()
  if (!t || t === lastText) return false
  if (rule.boundary.test(t)) return true
  if (!lastText) return t.length >= rule.firstMin
  if (t.length - lastText.length >= rule.growth) return true
  return now - lastAt >= rule.timeMs && t.length > lastText.length + rule.timeGrowth
}
