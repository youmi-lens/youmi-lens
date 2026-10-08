import { CONTENT_LANGUAGES, isContentLanguageCode, type LanguageAvailability } from '../lib/contentLanguages'
import type { LanguagePreferences } from '../lib/languagePreferences'
import {
  ORIGINAL_ONLY,
  applyTranslateTo,
  resolveLectureLanguages,
  type TranslateToValue,
} from '../lib/lectureLanguages'
import { useLanguagePreferences } from '../languagePreferencesContext'
import { LanguageSelect, type LanguageSelectOption } from './LanguageSelect'
import { SettingsRow } from './SettingsLayout'

/**
 * The two language choices of a lecture — and nothing else:
 *
 *   Spoken language  [English ▼]
 *   Translate to     [Simplified Chinese ▼]   (or "Original only")
 *
 * Human names only, never codes. They are independent: changing one never
 * rewrites the other. A language that cannot run yet is listed but disabled and
 * says why, so nothing is silently swapped.
 *
 * Rendered as `SettingsRow` + `LanguageSelect` — the very components behind
 * Settings → App language — so the two places look identical and nothing here
 * carries its own sizing. The caller supplies the surrounding
 * `settings-v2__group`. Shared by Record Home and Settings.
 */
export function LectureLanguageFields({
  preferences,
  onPreferenceChange,
}: {
  preferences: LanguagePreferences
  onPreferenceChange: <K extends keyof LanguagePreferences>(name: K, value: LanguagePreferences[K]) => void
}) {
  const { t } = useLanguagePreferences()
  const resolved = resolveLectureLanguages(preferences)
  const effectiveSource = resolved.languages.sourceLanguage

  const statusLabel = (availability: LanguageAvailability) =>
    availability === 'beta' ? t('settings.beta') : t('settings.notEnabled')

  const spokenOptions: LanguageSelectOption[] = CONTENT_LANGUAGES.map((language) => ({
    value: language.code,
    label: language.label,
    availability: language.caption,
    // Spanish can be CAPTIONED live but its saved lecture could not be transcribed: say exactly that.
    ...(language.captionBlockedReason === 'final-asr' ? { disabledNote: t('record.spokenFinalAsrBlocked') } : {}),
  }))

  // The spoken language is never offered as its own translation target.
  const translateOptions: LanguageSelectOption[] = [
    { value: ORIGINAL_ONLY, label: t('record.originalOnly'), availability: 'available' },
    ...CONTENT_LANGUAGES.filter((language) => language.code !== effectiveSource).map((language) => ({
      value: language.code,
      label: language.label,
      availability: language.translation,
    })),
  ]

  // What the control SHOWS is what will actually happen: a stored target equal
  // to the spoken language, or one that cannot run, reads as "Original only".
  const translateValue: string = resolved.translationEnabled
    ? preferences.translationLanguage
    : ORIGINAL_ONLY

  const handleSpoken = (value: string) => {
    if (isContentLanguageCode(value)) onPreferenceChange('captionLanguage', value)
  }
  const handleTranslate = (value: string) => {
    const choice: TranslateToValue = value === ORIGINAL_ONLY ? ORIGINAL_ONLY : isContentLanguageCode(value) ? value : ORIGINAL_ONLY
    const next = applyTranslateTo(preferences, choice)
    if (next.languageMode !== preferences.languageMode) onPreferenceChange('languageMode', next.languageMode)
    if (next.translationLanguage !== preferences.translationLanguage) {
      onPreferenceChange('translationLanguage', next.translationLanguage)
    }
  }

  // Why translation is not running — only when the user asked for one.
  const note = resolved.sourceSubstituted
    ? t('record.spokenSubstituted')
    : preferences.languageMode === 'bilingual' && resolved.translationSkipReason === 'same_language'
      ? t('record.translationSameLanguage')
      : preferences.languageMode === 'bilingual' && resolved.translationSkipReason === 'unavailable'
        ? t('record.translationUnavailable')
        : null

  return (
    <>
      <SettingsRow
        name={t('record.spokenLanguage')}
        control={
          <LanguageSelect
            label={t('record.spokenLanguage')}
            value={effectiveSource}
            options={spokenOptions}
            statusLabel={statusLabel}
            onChange={handleSpoken}
          />
        }
      />
      <SettingsRow
        name={t('record.translateTo')}
        control={
          <LanguageSelect
            label={t('record.translateTo')}
            value={translateValue}
            options={translateOptions}
            statusLabel={statusLabel}
            onChange={handleTranslate}
          />
        }
      />
      {note ? (
        <p className="settings-v2__note lecture-language-note" role="note">
          {note}
        </p>
      ) : null}
    </>
  )
}
