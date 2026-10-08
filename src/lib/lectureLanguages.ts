/**
 * The language contract of ONE lecture, and how a preference becomes it.
 *
 * Two settings, fully independent:
 *
 *   · SPOKEN language  — what the lecturer actually says. Drives live recognition
 *                        and the final transcript.
 *   · TRANSLATE TO     — what the reader wants to read. Drives live translation,
 *                        the translated transcript and the translated summary.
 *
 * Neither ever changes the other.
 *
 * `translationLanguage === sourceLanguage` means "Original only": that is the
 * backend's own rule (`shouldTranslate(source, target)`), so a lecture saved this
 * way is processed with no translation and no translated summary — the same shape
 * as the four English → English lectures already in production. No schema change.
 *
 * A lecture's languages are FROZEN when its recording starts. Everything after
 * that — live captions, the upload, a recovered session, a retried upload, the
 * server's processing retry — uses that snapshot, never whatever the preference
 * happens to be later.
 *
 * Pure: no React, no storage, no network.
 */
import {
  getContentLanguage,
  isContentLanguageCode,
  isSpokenLanguageAvailable,
  isTranslationTargetAvailable,
  type ContentLanguageCode,
} from './contentLanguages'
import type { LanguagePreferences } from './languagePreferences'

export type LectureLanguages = {
  sourceLanguage: ContentLanguageCode
  translationLanguage: ContentLanguageCode
}

/**
 * What every lecture recorded before language selection existed was, PROVEN from
 * two places: the Desktop live path was hard-wired to `en-US` + `zh`
 * (`SUPPORTED_LIVE_LANG` / `SUPPORTED_TRANSLATE_TARGET`), and the production
 * `recordings` columns default to `'en'` / `'zh-Hans'` (NOT NULL), so those rows
 * already carry exactly this.
 */
export const LEGACY_LECTURE_LANGUAGES: LectureLanguages = {
  sourceLanguage: 'en',
  translationLanguage: 'zh-Hans',
}

/** Why a requested translation is not being performed (null = it is). */
export type TranslationSkipReason = 'original_only' | 'same_language' | 'unavailable' | null

export type ResolvedLectureLanguages = {
  languages: LectureLanguages
  translationEnabled: boolean
  translationSkipReason: TranslationSkipReason
  /** The stored spoken language could not be used and English was substituted — tell the user. */
  sourceSubstituted: boolean
}

type LanguageChoice = Pick<LanguagePreferences, 'captionLanguage' | 'translationLanguage' | 'languageMode'>

/**
 * Turn the stored preference into the languages a recording will actually use.
 *
 * Nothing is substituted silently, and nothing is translated by surprise:
 *   · Original only (`captions-only`)        → no translation.
 *   · Translate-to equal to the spoken one   → no translation (nothing to translate).
 *   · A target the live route can't serve    → no translation, reported as `unavailable`
 *     (never quietly swapped for Chinese or English).
 *   · A spoken language no provider chain supports → English, reported via
 *     `sourceSubstituted` so the UI can say so.
 */
export function resolveLectureLanguages(choice: LanguageChoice): ResolvedLectureLanguages {
  const wantedSource = choice.captionLanguage
  const sourceSubstituted = !isSpokenLanguageAvailable(wantedSource)
  const sourceLanguage: ContentLanguageCode = sourceSubstituted ? LEGACY_LECTURE_LANGUAGES.sourceLanguage : wantedSource

  let translationSkipReason: TranslationSkipReason = null
  if (choice.languageMode !== 'bilingual') translationSkipReason = 'original_only'
  else if (choice.translationLanguage === sourceLanguage) translationSkipReason = 'same_language'
  else if (!isTranslationTargetAvailable(choice.translationLanguage)) translationSkipReason = 'unavailable'

  const translationEnabled = translationSkipReason === null
  return {
    languages: {
      sourceLanguage,
      translationLanguage: translationEnabled ? choice.translationLanguage : sourceLanguage,
    },
    translationEnabled,
    translationSkipReason,
    sourceSubstituted,
  }
}

export function isTranslationEnabled(languages: LectureLanguages): boolean {
  return languages.translationLanguage !== languages.sourceLanguage
}

/** The value the live translate route (`/api/translate-caption`) accepts. */
export type LiveTranslateRouteTarget = 'zh' | 'en' | 'off'

/**
 * The live route takes `zh` or `en` only. Anything else — including a target the
 * registry does not mark available — is `off`; the caller must not invent one.
 */
export function liveTranslateRouteTarget(languages: LectureLanguages): LiveTranslateRouteTarget {
  if (!isTranslationEnabled(languages)) return 'off'
  if (languages.translationLanguage === 'zh-Hans') return 'zh'
  if (languages.translationLanguage === 'en') return 'en'
  return 'off'
}

/**
 * A lecture row's languages, for reading history.
 *
 * Each field falls back on its own to the legacy default, so a row missing one
 * (or holding something this build does not know) still opens, interpreted as
 * the product always behaved — never as today's preference.
 */
export function lectureLanguagesFromRow(row: {
  sourceLanguage?: string | null
  translationLanguage?: string | null
}): LectureLanguages {
  return {
    sourceLanguage: isContentLanguageCode(row.sourceLanguage)
      ? row.sourceLanguage
      : LEGACY_LECTURE_LANGUAGES.sourceLanguage,
    translationLanguage: isContentLanguageCode(row.translationLanguage)
      ? row.translationLanguage
      : LEGACY_LECTURE_LANGUAGES.translationLanguage,
  }
}

/* ── The single "Translate to" control ─────────────────────────────────────
   The preference store keeps a language and a mode. The UI shows ONE control:
   "Original only" plus the targets. These two functions are the only place that
   maps between them. */

export const ORIGINAL_ONLY = 'original' as const
export type TranslateToValue = typeof ORIGINAL_ONLY | ContentLanguageCode

export function translateToValue(choice: Pick<LanguagePreferences, 'translationLanguage' | 'languageMode'>): TranslateToValue {
  return choice.languageMode === 'bilingual' ? choice.translationLanguage : ORIGINAL_ONLY
}

/**
 * Picking "Original only" keeps the previously chosen target in storage, so
 * switching translation back on restores it instead of resetting to a default.
 */
export function applyTranslateTo(
  current: LanguagePreferences,
  value: TranslateToValue,
): LanguagePreferences {
  if (value === ORIGINAL_ONLY) return { ...current, languageMode: 'captions-only' }
  return { ...current, languageMode: 'bilingual', translationLanguage: value }
}

/* ── Summaries ─────────────────────────────────────────────────────────────
   The backend writes the summary in the source language and, when translating,
   again in the translation language. Which one a reader sees FIRST follows the
   rule: translated when translation is on, otherwise the original. The other
   stays one click away. */

export type SummaryKind = 'source' | 'translated'

export function defaultSummaryKind(languages: LectureLanguages): SummaryKind {
  return isTranslationEnabled(languages) ? 'translated' : 'source'
}

export function languageEnglishName(code: ContentLanguageCode): string {
  return getContentLanguage(code).englishName
}

/* ── Reading a lecture's outputs ───────────────────────────────────────────
   Newer rows carry `sourceSummary` / `translatedSummary`; rows written before
   those columns existed only have the `summary_en` / `summary_zh` mirrors. The
   mirror is only trusted for the language it is actually written in, so an old
   row is never read as the wrong language. */

type SummaryRow = {
  sourceSummary?: string | null
  translatedSummary?: string | null
  summaryEn?: string | null
  summaryZh?: string | null
}

function legacySummaryIn(code: ContentLanguageCode, row: SummaryRow): string | null {
  if (code === 'en') return row.summaryEn?.trim() || null
  if (code === 'zh-Hans') return row.summaryZh?.trim() || null
  return null
}

export type LectureSummaries = {
  source: string | null
  /** Null when this lecture was not translated. */
  translated: string | null
}

export function lectureSummariesFor(languages: LectureLanguages, row: SummaryRow): LectureSummaries {
  const source = row.sourceSummary?.trim() || legacySummaryIn(languages.sourceLanguage, row)
  const translated = isTranslationEnabled(languages)
    ? row.translatedSummary?.trim() || legacySummaryIn(languages.translationLanguage, row)
    : null
  return { source: source || null, translated: translated || null }
}

/**
 * Which summary opens first: the translation when there is one, else the
 * original — never an empty pane while the other exists.
 */
export function initialSummaryKind(languages: LectureLanguages, summaries: LectureSummaries): SummaryKind | null {
  const wanted = defaultSummaryKind(languages)
  if (wanted === 'translated' && summaries.translated) return 'translated'
  if (summaries.source) return 'source'
  if (summaries.translated) return 'translated'
  return null
}
