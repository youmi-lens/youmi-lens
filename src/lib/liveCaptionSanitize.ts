import { languageScript, type ContentLanguageCode } from './contentLanguages'

/** Strip CJK / Japanese / Korean from EN caption source (same rules as LiveEngine translate path). */
export function sanitizeEnglishForZhTranslate(text: string): string {
  return text
    .replace(/\p{Script=Han}/gu, ' ')
    .replace(/[\u3040-\u30ff]/gu, ' ')
    .replace(/[\uac00-\ud7af]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normCaptionSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Latin word (5+) + Han in one line ⇒ ASR/merge garbage (e.g. `Class个we`). */
export function isGarbledMixedScriptLine(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (!/\p{Script=Han}/u.test(t)) return false
  return /\b[A-Za-z]{5,}\b/.test(t)
}

/** English primary (ASR) line: no CJK scripts. */
export function isEnglishPrimarySlotText(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/\p{Script=Han}/u.test(t)) return false
  if (/[\u3040-\u30ff]/u.test(t)) return false
  if (/[\uac00-\ud7af]/u.test(t)) return false
  return true
}

/**
 * Normalize EN primary payload: accept clean ASR, or one CJK-strip pass; otherwise reject (do not show).
 */
export function normalizeEnglishPrimaryPayloadOrReject(raw: string): string | null {
  const t = raw.trim()
  if (!t) return null
  if (isEnglishPrimarySlotText(t) && !isGarbledMixedScriptLine(t)) return t
  const cleaned = sanitizeEnglishForZhTranslate(t).trim()
  if (cleaned && isEnglishPrimarySlotText(cleaned) && !isGarbledMixedScriptLine(cleaned)) return cleaned
  return null
}

/** Translation line when target is Chinese: must contain Han, or short non-Latin junk only. */
export function isZhTranslationSlotText(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/\p{Script=Han}/u.test(t)) return true
  return t.length <= 16 && !/\b[A-Za-z]{5,}\b/.test(t)
}

/** Translation line when target is English: no Han runs in secondary EN. */
export function isEnTranslationSlotText(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/\p{Script=Han}/u.test(t)) return false
  return true
}

/** Backend / client error tokens that must never appear as live translation text. */
const REJECTED_TRANSLATION_PAYLOAD_HINTS = new Set([
  'auth_required',
  'quota_required',
  'quota_suspended',
  'beta_limit_reached',
  'recording_too_long',
  'daily_recording_limit_reached',
  'session_limit_reached',
  'invalid_request',
  'youmi ai setup is not available yet.',
])

/** A backend / client error token that must never be shown as translation text. */
export function isRejectedTranslationToken(text: string): boolean {
  return REJECTED_TRANSLATION_PAYLOAD_HINTS.has(text.trim().toLowerCase())
}

export function normalizeZhPayloadOrReject(raw: string, translateTarget: 'zh' | 'en' | 'off'): string | null {
  if (translateTarget === 'off') return raw.trim() || null
  const t = raw.trim()
  if (!t) return null
  const hintKey = t.toLowerCase()
  if (REJECTED_TRANSLATION_PAYLOAD_HINTS.has(hintKey)) return null
  if (translateTarget === 'zh') {
    if (isGarbledMixedScriptLine(t)) return null
    if (!isZhTranslationSlotText(t)) return null
    return t
  }
  // English target. This used to refuse ANY Han character, which was right while
  // English was only ever the source. Now a Chinese lecture is translated INTO
  // English, and a correct English line can still carry a Chinese proper noun
  // ("Professor 李 said hello"); rejecting it would blank that sentence's
  // translation. What must still be refused is a line that is mostly Chinese —
  // the model handing the source back untranslated.
  return isMostlyHan(t) ? null : t
}

/** More than a third of the letters are Han: not an English line with a name in it. */
function isMostlyHan(text: string): boolean {
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length
  if (han === 0) return false
  const letters = (text.match(/[\p{L}]/gu) ?? []).length
  return han / Math.max(letters, 1) > 0.34
}

/* ── Language-aware primary captions ─────────────────────────────────────────
   The rules above were written for ONE spoken language: English captions may not
   contain Han, kana or hangul, and a Latin word beside Han is "garbage". Applied
   to a Chinese, Japanese or Korean lecture they would discard every caption, and
   in a Chinese lecture an English term in the middle of a sentence ("用 gradient
   descent 优化") is perfectly normal. So the checks follow the spoken language's
   script. Latin-script languages keep EXACTLY the existing English behaviour. */


/** A spoken-language caption payload: accepted, cleaned, or rejected. */
export function normalizePrimaryPayloadOrReject(raw: string, source: ContentLanguageCode): string | null {
  if (languageScript(source) === 'latin') return normalizeEnglishPrimaryPayloadOrReject(raw)
  const t = raw.replace(/\s+/g, ' ').trim()
  return t || null
}

/** The text sent to live translation. Latin sources strip stray CJK exactly as before. */
export function sanitizeSourceForTranslate(text: string, source: ContentLanguageCode): string {
  if (languageScript(source) === 'latin') return sanitizeEnglishForZhTranslate(text)
  return text.replace(/\s+/g, ' ').trim()
}
