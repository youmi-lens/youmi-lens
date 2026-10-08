export const LANGUAGE_CODES = ['en', 'zh-Hans', 'ja', 'fr', 'es', 'ko'] as const

export type ContentLanguageCode = (typeof LANGUAGE_CODES)[number]
export type LanguageAvailability = 'available' | 'beta' | 'not-enabled'

/**
 * How a language is written, which decides how live captions are validated and
 * de-duplicated. `latin` languages are space-delimited words; `cjk` languages
 * (Chinese, Japanese, Korean) are not tokenised by whitespace.
 */
export type CaptionScript = 'latin' | 'cjk'

/** Why a language cannot be SPOKEN even though live captioning could handle it. */
export type CaptionBlockedReason = 'final-asr'

export type ContentLanguage = {
  code: ContentLanguageCode
  label: string
  /** English exonym, used in explanations and logs — never shown as the primary label. */
  englishName: string
  script: CaptionScript
  /**
   * Words are separated by spaces (English, French, Spanish, Korean). Decides how captions are
   * JOINED and how translation snapshots are cleaned. Independent of `script`: Korean is `cjk`
   * for caption validation (Hangul is not Latin) yet is written with spaces.
   */
  spaced: boolean
  /** Set when `caption` is not available because a later stage (not live ASR) cannot serve it. */
  captionBlockedReason?: CaptionBlockedReason
  /**
   * May this language be SPOKEN (live captions + final transcript)?
   * `available` only when BOTH providers support it:
   *   · live  — Deepgram `nova-3`, streamed over the live WebSocket
   *   · final — DashScope `paraformer-v2` file ASR (`language_hints`)
   */
  caption: LanguageAvailability
  /**
   * May captions be TRANSLATED INTO this language?
   * `available` only when BOTH the live route (`/api/translate-caption`, which
   * today accepts only `zh` and `en`) AND the final Qwen translation support it.
   */
  translation: LanguageAvailability
}

/**
 * THE canonical language definition. Every other module derives from this one;
 * provider-specific codes (Deepgram, DashScope hints, Qwen names) are the
 * backend adapter's business (`server/contentLanguages.mjs`) — the client only
 * ever sends these canonical ids.
 *
 * Capability audit, 2026-10-04 (provider docs + the DEPLOYED backend source):
 *
 *   · Spanish is spoken-capable live (Deepgram) but NOT in `paraformer-v2`, so a
 *     Spanish lecture could be captioned and then never transcribed. Not offered.
 *   · Japanese / Korean / French / Spanish as a TRANSLATION target work in the
 *     final pipeline (Qwen, by language name) but the live route rejects them
 *     (HTTP 400). Shown, disabled and labelled, until the route is generalised.
 *   · German / Italian / Portuguese / Traditional Chinese are not in the backend's
 *     registry at all (the live WebSocket answers `invalid_language`).
 *   · Auto-detect: Deepgram does not support language detection for streaming.
 */
export const CONTENT_LANGUAGES: readonly ContentLanguage[] = [
  { code: 'en', label: 'English', englishName: 'English', script: 'latin', spaced: true, caption: 'available', translation: 'available' },
  { code: 'zh-Hans', label: '简体中文', englishName: 'Simplified Chinese', script: 'cjk', spaced: false, caption: 'available', translation: 'available' },
  { code: 'ja', label: '日本語', englishName: 'Japanese', script: 'cjk', spaced: false, caption: 'available', translation: 'available' },
  { code: 'fr', label: 'Français', englishName: 'French', script: 'latin', spaced: true, caption: 'available', translation: 'available' },
  // Spanish: live captions would work (Deepgram nova-3 `es`), but final transcription would FAIL —
  // paraformer-v2 does not list Spanish and a Spanish hint makes the task fail. As a TARGET it is
  // fully proven (live + Stop & Save), so source and target are independent here.
  { code: 'es', label: 'Español', englishName: 'Spanish', script: 'latin', spaced: true, caption: 'not-enabled', captionBlockedReason: 'final-asr', translation: 'available' },
  { code: 'ko', label: '한국어', englishName: 'Korean', script: 'cjk', spaced: true, caption: 'available', translation: 'available' },
] as const

export function isContentLanguageCode(value: unknown): value is ContentLanguageCode {
  return typeof value === 'string' && LANGUAGE_CODES.includes(value as ContentLanguageCode)
}

export function getContentLanguage(code: ContentLanguageCode): ContentLanguage {
  return CONTENT_LANGUAGES.find((language) => language.code === code) ?? CONTENT_LANGUAGES[0]
}

export function contentLanguageLabel(code: ContentLanguageCode): string {
  return getContentLanguage(code).label
}

/** Safe for any string a stale preference, a legacy row or the network might hold. */
export function contentLanguageLabelOr(value: string | null | undefined, fallback: string): string {
  return isContentLanguageCode(value) ? contentLanguageLabel(value) : fallback
}

export function isSpokenLanguageAvailable(code: ContentLanguageCode): boolean {
  return getContentLanguage(code).caption === 'available'
}

export function isTranslationTargetAvailable(code: ContentLanguageCode): boolean {
  return getContentLanguage(code).translation === 'available'
}

export function isSpaceDelimited(code: ContentLanguageCode): boolean {
  return getContentLanguage(code).spaced
}

export function languageScript(code: ContentLanguageCode): CaptionScript {
  return getContentLanguage(code).script
}
