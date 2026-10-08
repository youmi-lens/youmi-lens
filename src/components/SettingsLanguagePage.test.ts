import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LANGUAGE_PREFERENCES, type LanguagePreferences } from '../lib/languagePreferences'
import { LanguagePreferencesContext } from '../languagePreferencesContext'
import { translateDesktop } from '../lib/desktopI18n'
import { LectureLanguageFields } from './LectureLanguageFields'

const src = readFileSync(new URL('./SettingsLanguagePage.tsx', import.meta.url), 'utf8')

function render(preferences: LanguagePreferences): string {
  return renderToStaticMarkup(
    createElement(
      LanguagePreferencesContext.Provider,
      {
        value: {
          preferences,
          setPreference: () => undefined,
          t: (key, vars) => translateDesktop(preferences.appLocale, key, vars),
        },
      },
      createElement(LectureLanguageFields, { preferences, onPreferenceChange: () => undefined }),
    ),
  )
}

const selected = (html: string, label: string): string => {
  const select = html.slice(html.indexOf(`aria-label="${label}"`))
  const end = select.indexOf('</select>')
  const chosen = select.slice(0, end).match(/<option value="([^"]*)"[^>]*selected/)
  return chosen?.[1] ?? ''
}

describe('LectureLanguageFields', () => {
  it('shows the default as English → 简体中文, independently selectable', () => {
    const html = render(DEFAULT_LANGUAGE_PREFERENCES)
    expect(selected(html, 'Spoken language')).toBe('en')
    expect(selected(html, 'Translate to')).toBe('zh-Hans')
  })

  it('Original only is its own choice and is what the control shows in captions-only mode', () => {
    const html = render({ ...DEFAULT_LANGUAGE_PREFERENCES, languageMode: 'captions-only' })
    expect(selected(html, 'Translate to')).toBe('original')
    // The remembered target survives, so switching translation back on restores it.
  })

  it('never offers the spoken language as its own translation target', () => {
    const html = render({ ...DEFAULT_LANGUAGE_PREFERENCES, captionLanguage: 'zh-Hans', translationLanguage: 'en' })
    const translate = html.slice(html.indexOf('aria-label="Translate to"'))
    expect(translate).not.toContain('value="zh-Hans"')
    expect(translate).toContain('value="en"')
  })

  it('a target equal to the spoken language reads as Original only, with a note — not a silent translation', () => {
    const html = render({ ...DEFAULT_LANGUAGE_PREFERENCES, captionLanguage: 'zh-Hans', translationLanguage: 'zh-Hans' })
    expect(selected(html, 'Translate to')).toBe('original')
    expect(html).toContain('Same as the spoken language')
  })

  it('Spanish as a SPOKEN language is listed, disabled, and says exactly why (final transcription)', () => {
    const html = render(DEFAULT_LANGUAGE_PREFERENCES)
    const spoken = html.slice(html.indexOf('aria-label="Spoken language"'), html.indexOf('aria-label="Translate to"'))
    expect(spoken).toMatch(/<option value="es" disabled="">Español · transcription not supported yet<\/option>/)
    expect(spoken).not.toContain('Not yet enabled')
  })

  it('every language is selectable as a TRANSLATION target (Español included), with no "not enabled" label', () => {
    const html = render({ ...DEFAULT_LANGUAGE_PREFERENCES, captionLanguage: 'zh-Hans', translationLanguage: 'en' })
    const target = html.slice(html.indexOf('aria-label="Translate to"'))
    for (const value of ['original', 'en', 'ja', 'fr', 'es', 'ko']) expect(target).toContain(`<option value="${value}"`)
    expect(target).not.toMatch(/disabled=""/)
    expect(target).not.toContain('Not yet enabled')
    // the spoken language itself is never offered as its own target
    expect(target).not.toContain('<option value="zh-Hans"')
  })

  it('shows human names only — never raw codes', () => {
    const html = render({ ...DEFAULT_LANGUAGE_PREFERENCES, captionLanguage: 'zh-Hans', translationLanguage: 'en' })
    expect(html).not.toContain('en-US')
    expect(html).not.toContain('zh-CN')
    expect(html).toContain('>English<')
    expect(html).toContain('>简体中文<')
  })
})

describe('SettingsLanguagePage source', () => {
  it('uses the shared fields, so Settings and Record Home cannot disagree', () => {
    expect(src).toContain('LectureLanguageFields')
  })

  it('has no second, competing control for translation (the old language-mode switch is gone)', () => {
    expect(src).not.toContain("onPreferenceChange('languageMode'")
  })

  it('the internal "verified live path" wording no longer renders', () => {
    expect(src).not.toContain('settings.runtimeNote')
    expect(src).not.toContain('settings.preferenceNote')
  })
})
