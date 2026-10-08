/**
 * QA 1009 physical finding: "Spoken language / Translate to" were oversized
 * boxes that did not match the product. The reference is Settings → App language.
 *
 * Contract: the lecture-language controls are the SAME components as the App
 * language row — `SettingsRow` + `LanguageSelect` inside a `settings-v2__group` —
 * and carry no sizing of their own.
 */
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LanguagePreferencesContext } from '../languagePreferencesContext'
import { translateDesktop } from '../lib/desktopI18n'
import { DEFAULT_LANGUAGE_PREFERENCES } from '../lib/languagePreferences'
import { LectureLanguageFields } from './LectureLanguageFields'
import { RecordHome } from './RecordHome'
import { SettingsLanguagePage } from './SettingsLanguagePage'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

function withContext(node: ReturnType<typeof createElement>) {
  const preferences = DEFAULT_LANGUAGE_PREFERENCES
  return renderToStaticMarkup(
    createElement(
      LanguagePreferencesContext.Provider,
      { value: { preferences, setPreference: () => undefined, t: (k, v) => translateDesktop('en', k, v) } },
      node,
    ),
  )
}

const recordHome = () =>
  withContext(
    createElement(RecordHome, {
      course: 'CS 250',
      audioSourceLabel: 'System Audio',
      title: '',
      preferences: DEFAULT_LANGUAGE_PREFERENCES,
      recentLectures: [],
      onTitleChange: () => undefined,
      onStartRecording: () => undefined,
      onOpenSettings: () => undefined,
      onChangeCourse: () => undefined,
      onNewCourse: () => undefined,
      onViewAll: () => undefined,
      onOpenLecture: () => undefined,
    }),
  )

describe('17 · compact language selector contract', () => {
  it('is rendered as settings rows — the same markup shape as App language', () => {
    const html = withContext(createElement(SettingsLanguagePage, { preferences: DEFAULT_LANGUAGE_PREFERENCES, onPreferenceChange: () => undefined }))
    const rows = html.match(/class="settings-v2__row"/g) ?? []
    // App language + Spoken language + Translate to
    expect(rows).toHaveLength(3)
    expect(html.match(/<label class="language-select">/g)).toHaveLength(3)
  })

  it('Record Home shows the two rows inside the standard settings group, not custom boxes', () => {
    const html = recordHome()
    expect(html).toContain('settings-v2__group record-home-v2__languages')
    expect(html).toContain('<div class="settings-v2__name">Spoken language</div>')
    expect(html).toContain('<div class="settings-v2__name">Translate to</div>')
    expect(html).not.toContain('lecture-language-fields')
  })

  it('no custom select / label sizing exists for them in any stylesheet', () => {
    for (const css of [read('../styles/desktop-v2.css'), read('../styles/recording-v2.css'), read('../App.css')]) {
      expect(css).not.toMatch(/lecture-language-fields/)
      expect(css).not.toMatch(/record-home-v2__languages[^{]*select/)
    }
  })

  it('keeps human names and the "Original only" choice', () => {
    const html = recordHome()
    expect(html).toContain('Original only')
    expect(html).toContain('简体中文')
    expect(html).not.toContain('en-US')
  })
})

describe('18 · App language style is reused, not copied', () => {
  const fields = read('./LectureLanguageFields.tsx')
  const settings = read('./SettingsLanguagePage.tsx')

  it('LectureLanguageFields is built from SettingsRow + LanguageSelect, the components App language uses', () => {
    expect(fields).toContain("import { SettingsRow } from './SettingsLayout'")
    expect(fields).toContain("import { LanguageSelect")
    expect(fields).toContain('<SettingsRow')
    expect(fields).toContain('<LanguageSelect')
    expect(settings).toContain('<SettingsRow')
  })

  it('introduces no className of its own for the controls', () => {
    expect(fields).not.toMatch(/className="(?!settings-v2__note)/)
  })

  it('a note about a skipped translation uses the existing settings note style', () => {
    const html = withContext(
      createElement(LectureLanguageFields, {
        preferences: { ...DEFAULT_LANGUAGE_PREFERENCES, captionLanguage: 'zh-Hans', translationLanguage: 'zh-Hans' },
        onPreferenceChange: () => undefined,
      }),
    )
    expect(html).toContain('settings-v2__note')
  })
})
