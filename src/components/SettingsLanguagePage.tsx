import { CONTENT_LANGUAGES, type LanguageAvailability } from '../lib/contentLanguages'
import type { LanguageMode, LanguagePreferences } from '../lib/languagePreferences'
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
 * The previous version ended in a tall shaded callout repeating the summary.
 * It is replaced by one line of note text, per the approved mockup.
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
          help={t('settings.languageModeHelp')}
          control={
            <label className="language-select">
              <span className="v2-sr-only">{t('settings.languageMode')}</span>
              <select
                className="v2-select"
                aria-label={t('settings.languageMode')}
                value={preferences.languageMode}
                onChange={(event) =>
                  onPreferenceChange('languageMode', event.target.value as LanguageMode)
                }
              >
                <option value="bilingual">{t('record.bilingual')}</option>
                <option value="captions-only">{t('record.captionsOnly')}</option>
              </select>
            </label>
          }
        />
      </div>

      <p className="settings-v2__note">
        {t('settings.runtimeNote')} {t('settings.preferenceNote')}
      </p>
    </>
  )
}
