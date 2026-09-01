import { getContentLanguage } from './contentLanguages'
import type { LanguagePreferences } from './languagePreferences'

/**
 * Whether the CURRENTLY SELECTED caption/translation combination has a real
 * support limitation worth telling the user about. Caption always matters;
 * translation only matters while bilingual mode would actually use it — in
 * captions-only mode an unsupported translation choice is saved but inert,
 * not a live limitation.
 */
export function hasLanguageLimitation(preferences: LanguagePreferences): boolean {
  const captionOk = getContentLanguage(preferences.captionLanguage).caption === 'available'
  if (!captionOk) return true
  if (preferences.languageMode !== 'bilingual') return false
  return getContentLanguage(preferences.translationLanguage).translation !== 'available'
}
