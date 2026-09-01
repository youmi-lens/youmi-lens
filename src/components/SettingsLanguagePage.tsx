import { CONTENT_LANGUAGES, type LanguageAvailability } from '../lib/contentLanguages'
import { hasLanguageLimitation } from '../lib/languageLimitation'
import type { LanguagePreferences } from '../lib/languagePreferences'
import { useLanguagePreferences } from '../languagePreferencesContext'
import { LanguageSelect, type LanguageSelectOption } from './LanguageSelect'
import { SettingsRow } from './SettingsLayout'

const APP_OPTIONS: LanguageSelectOption[] = CONTENT_LANGUAGES.map((language) => ({
  value: language.code,
  label: language.label,
  availability: 'available',
}))

const CAPTION_OPTIONS: LanguageSelectOption[] = CONTENT_LANGUAGES.map((language) => ({
  value: language.code,
  label: language.label,
  availability: language.caption,
}))

const TRANSLATION_OPTIONS: LanguageSelectOption[] = CONTENT_LANGUAGES.map((language) => ({
  value: language.code,
  label: language.label,
  availability: language.translation,
}))

/**
 * Language settings — the DETAIL pane only. The master list lives in
 * SettingsLayout, so this page can no longer be the whole Settings screen.
 *
 * The four preference fields stay independent (app locale, caption, translation,
 * mode) and the availability boundary is unchanged: caption is English-only and
 * translation is Simplified-Chinese-only today; everything else is disabled and
 * labelled, so nothing here claims six-language live captions already work.
 *
 * QA16: rows carry only the value in their trailing control (no repeated field
 * name / "· Available" — see LanguageSelect), helper copy is a single short
 * line, and the internal "verified live path" wording is not shown at all
 * unless the current selection actually has a limitation.
 */
export function SettingsLanguagePage({
  preferences,
  onPreferenceChange,
  showHeading = true,
}: {
  preferences: LanguagePreferences
  onPreferenceChange: <K extends keyof LanguagePreferences>(
    name: K,
    value: LanguagePreferences[K],
  ) => void
  /** False when embedded under a section that already has its own heading (Recording). */
  showHeading?: boolean
}) {
  const { t } = useLanguagePreferences()
  const statusLabel = (availability: LanguageAvailability) => {
    if (availability === 'available') return t('settings.available')
    if (availability === 'beta') return t('settings.beta')
    return t('settings.notEnabled')
  }

  return (
    <>
      {showHeading ? (
        <>
          <h2 id="settings-language-title">{t('settings.language')}</h2>
          <p className="settings-v2__lead">{t('settings.languageLead')}</p>
        </>
      ) : null}

      <div className="settings-v2__group">
        <SettingsRow
          name={t('settings.appLanguage')}
          help={t('settings.appLanguageHelp')}
          control={
            <LanguageSelect
              label={t('settings.appLanguage')}
              value={preferences.appLocale}
              options={APP_OPTIONS}
              statusLabel={statusLabel}
              onChange={(value) => onPreferenceChange('appLocale', value)}
            />
          }
        />
        <SettingsRow
          name={t('settings.captionLanguage')}
          help={t('settings.captionLanguageHelp')}
          control={
            <LanguageSelect
              label={t('settings.captionLanguage')}
              value={preferences.captionLanguage}
              options={CAPTION_OPTIONS}
              statusLabel={statusLabel}
              onChange={(value) => onPreferenceChange('captionLanguage', value)}
            />
          }
        />
        <SettingsRow
          name={t('settings.translationLanguage')}
          help={t('settings.translationLanguageHelp')}
          control={
            <LanguageSelect
              label={t('settings.translationLanguage')}
              value={preferences.translationLanguage}
              options={TRANSLATION_OPTIONS}
              statusLabel={statusLabel}
              onChange={(value) => onPreferenceChange('translationLanguage', value)}
            />
          }
        />
        <SettingsRow
          name={t('settings.languageMode')}
          control={
            <div className="settings-v2__segmented" role="group" aria-label={t('settings.languageMode')}>
              <button
                type="button"
                className={`settings-v2__segmented-btn${
                  preferences.languageMode === 'captions-only' ? ' settings-v2__segmented-btn--selected' : ''
                }`}
                aria-pressed={preferences.languageMode === 'captions-only'}
                onClick={() => onPreferenceChange('languageMode', 'captions-only')}
              >
                {t('record.captionsOnly')}
              </button>
              <button
                type="button"
                className={`settings-v2__segmented-btn${
                  preferences.languageMode === 'bilingual' ? ' settings-v2__segmented-btn--selected' : ''
                }`}
                aria-pressed={preferences.languageMode === 'bilingual'}
                onClick={() => onPreferenceChange('languageMode', 'bilingual')}
              >
                {t('record.bilingual')}
              </button>
            </div>
          }
        />
      </div>

      {hasLanguageLimitation(preferences) ? (
        <p className="settings-v2__note">{t('settings.languageLimitationNote')}</p>
      ) : null}
    </>
  )
}
