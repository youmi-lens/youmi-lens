import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hasLanguageLimitation } from '../lib/languageLimitation'
import type { LanguagePreferences } from '../lib/languagePreferences'

const src = readFileSync(new URL('./SettingsLanguagePage.tsx', import.meta.url), 'utf8')

const base: LanguagePreferences = {
  appLocale: 'en',
  captionLanguage: 'en',
  translationLanguage: 'zh-Hans',
  languageMode: 'bilingual',
}

describe('hasLanguageLimitation — when the "verified live path" note should show', () => {
  it('is hidden for the one fully-verified combination: English captions + Simplified Chinese translation, bilingual', () => {
    expect(hasLanguageLimitation(base)).toBe(false)
  })

  it('is hidden for the verified combination in captions-only mode too (translation is irrelevant then)', () => {
    expect(hasLanguageLimitation({ ...base, translationLanguage: 'ja', languageMode: 'captions-only' })).toBe(false)
  })

  it('shows when captions are not fully available regardless of mode', () => {
    expect(hasLanguageLimitation({ ...base, captionLanguage: 'zh-Hans' })).toBe(true)
  })

  it('shows when bilingual mode picks a translation language that is not fully available', () => {
    expect(hasLanguageLimitation({ ...base, translationLanguage: 'ja' })).toBe(true)
  })

  it('does not show for an unsupported translation choice while in captions-only mode', () => {
    expect(hasLanguageLimitation({ ...base, translationLanguage: 'fr', languageMode: 'captions-only' })).toBe(false)
  })
})

describe('SettingsLanguagePage source — QA16 language-mode value wiring unchanged', () => {
  it('the segmented control still writes the exact stored values captions-only/bilingual', () => {
    expect(src).toContain("onPreferenceChange('languageMode', 'captions-only')")
    expect(src).toContain("onPreferenceChange('languageMode', 'bilingual')")
  })

  it('the internal "verified live path" wording no longer renders unconditionally', () => {
    expect(src).not.toContain('settings.runtimeNote')
    expect(src).not.toContain('settings.preferenceNote')
  })
})
