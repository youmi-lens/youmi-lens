import { createContext, useContext } from 'react'
import type { DesktopI18nKey, DesktopI18nVars } from './lib/desktopI18n'
import type {
  LanguagePreferenceName,
  LanguagePreferences,
} from './lib/languagePreferences'

export type LanguagePreferencesContextValue = {
  preferences: LanguagePreferences
  setPreference: <K extends LanguagePreferenceName>(
    name: K,
    value: LanguagePreferences[K],
  ) => void
  /**
   * `vars` is NOT optional decoration. Any key whose string contains `{count}`
   * renders that placeholder literally without it. This signature was
   * `(key) => string`, which type-checks against callers that pass variables —
   * TypeScript allows a function to ignore extra arguments — and that is
   * precisely how `{count} courses` reached production.
   */
  t: (key: DesktopI18nKey, vars?: DesktopI18nVars) => string
}

export const LanguagePreferencesContext = createContext<LanguagePreferencesContextValue | null>(null)

export function useLanguagePreferences(): LanguagePreferencesContextValue {
  const value = useContext(LanguagePreferencesContext)
  if (!value) throw new Error('useLanguagePreferences must be used inside LanguagePreferencesProvider')
  return value
}
