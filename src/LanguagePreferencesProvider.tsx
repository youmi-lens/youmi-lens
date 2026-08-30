import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { LanguagePreferencesContext } from './languagePreferencesContext'
import {
  translateDesktop,
  type DesktopI18nKey,
  type DesktopI18nVars,
} from './lib/desktopI18n'
import {
  DEFAULT_LANGUAGE_PREFERENCES,
  persistLanguagePreferences,
  readLanguagePreferences,
  writeLanguagePreference,
  type LanguagePreferenceName,
  type LanguagePreferences,
} from './lib/languagePreferences'

function browserStorage(): Storage | null {
  return typeof window === 'undefined' ? null : window.localStorage
}

export function LanguagePreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<LanguagePreferences>(() => {
    const storage = browserStorage()
    return storage ? readLanguagePreferences(storage) : DEFAULT_LANGUAGE_PREFERENCES
  })

  useEffect(() => {
    const storage = browserStorage()
    if (storage) persistLanguagePreferences(storage, preferences)
    // Migration persistence runs once; later writes are isolated per field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setPreference = useCallback(
    <K extends LanguagePreferenceName>(name: K, value: LanguagePreferences[K]) => {
      setPreferences((current) => {
        const storage = browserStorage()
        return storage
          ? writeLanguagePreference(storage, current, name, value)
          : { ...current, [name]: value }
      })
    },
    [],
  )

  const value = useMemo(
    () => ({
      preferences,
      setPreference,
      t: (key: DesktopI18nKey, vars?: DesktopI18nVars) =>
        translateDesktop(preferences.appLocale, key, vars),
    }),
    [preferences, setPreference],
  )

  return (
    <LanguagePreferencesContext.Provider value={value}>
      {children}
    </LanguagePreferencesContext.Provider>
  )
}
