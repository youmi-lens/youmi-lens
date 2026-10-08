import { CONTENT_LANGUAGES, isContentLanguageCode, type LanguageAvailability } from '../lib/contentLanguages'
import type { LanguagePreferences } from '../lib/languagePreferences'
import { useLanguagePreferences } from '../languagePreferencesContext'
import { LanguageSelect, type LanguageSelectOption } from './LanguageSelect'
import { LectureLanguageFields } from './LectureLanguageFields'
import { SettingsRow } from './SettingsLayout'

const APP_OPTIONS: LanguageSelectOption[] = CONTENT_LANGUAGES.map((language) => ({
  value: language.code,
  label: language.label,
  availability: 'available',
}))

/**
 * Language settings — the DETAIL pane only. The master list lives in
 * SettingsLayout, so this page can no longer be the whole Settings screen.
 *
 * App language is its own setting. The lecture languages — "Spoken language" and
 * "Translate to" (including "Original only") — are the shared
 * `LectureLanguageFields`, the same control Record Home shows, so the two can
 * never disagree. Languages that cannot run yet are listed, disabled and
 * labelled; nothing is silently swapped.
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
              onChange={(value) => isContentLanguageCode(value) && onPreferenceChange('appLocale', value)}
            />
          }
        />
      </div>

      <div className="settings-v2__group">
        <LectureLanguageFields preferences={preferences} onPreferenceChange={onPreferenceChange} />
      </div>
    </>
  )
}
