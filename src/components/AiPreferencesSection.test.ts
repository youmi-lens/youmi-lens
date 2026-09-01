import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { translateDesktop } from '../lib/desktopI18n'
import { DEFAULT_LANGUAGE_PREFERENCES } from '../lib/languagePreferences'
import { LanguagePreferencesContext, type LanguagePreferencesContextValue } from '../languagePreferencesContext'
import { AiPreferencesSection } from './AiPreferencesSection'

const src = readFileSync(new URL('./AiPreferencesSection.tsx', import.meta.url), 'utf8')

const contextValue: LanguagePreferencesContextValue = {
  preferences: DEFAULT_LANGUAGE_PREFERENCES,
  setPreference: () => undefined,
  t: (key, vars) => translateDesktop('en', key, vars),
}

function render(allowByok: boolean): string {
  return renderToStaticMarkup(
    createElement(LanguagePreferencesContext.Provider, { value: contextValue }, createElement(AiPreferencesSection, { allowByok })),
  )
}

describe('AiPreferencesSection — QA16 calm two-option redesign', () => {
  it('renders both option titles on their own line, never adjacent to the description on the same inline run', () => {
    const html = render(true)
    // Title, badge, and description are each block-level spans — this is
    // what actually fixes QA15's "text running together" collision (the
    // previous markup used an inline <strong> next to an inline <span>).
    expect(html).toContain('settings-v2__ai-option-title')
    expect(html).toContain('settings-v2__ai-option-badge')
    expect(html).toContain('settings-v2__ai-option-desc')
    expect(html).toContain('Youmi AI')
    expect(html).toContain('Bring Your Own Key')
    expect(html).toContain('Recommended')
    expect(html).toContain('Advanced')
  })

  it('does not render the BYOK configuration fields before BYOK is selected (default mode is Youmi AI)', () => {
    const html = render(true)
    expect(html).not.toContain('settings-v2__ai-byok-fields')
  })

  it('hides the Bring Your Own Key option entirely when allowByok is false', () => {
    const html = render(false)
    expect(html).not.toContain('Bring Your Own Key')
  })

  it('caps the section to a comfortable reading width instead of stretching across the whole detail column', () => {
    const html = render(true)
    expect(html).toContain('settings-v2__ai-content')
  })
})

describe('AiPreferencesSection source — AI state machine and persistence unchanged', () => {
  it('still reads/writes the same three underlying preferences on mount and on every change', () => {
    expect(src).toContain('getAiSource()')
    expect(src).toContain('getByokProvider()')
    expect(src).toContain('getByokApiKey()')
    expect(src).toContain('setAiSource(nextMode)')
    expect(src).toContain('setByokProvider(p)')
    expect(src).toContain('setByokApiKey(k)')
  })

  it('the BYOK configuration block is still gated on mode === \'byok\' — the only thing that changed is presentation', () => {
    expect(src).toContain("mode === 'byok' ? (")
  })

  it('provider ids are unchanged (openai/deepseek/qwen) — not a new provider feature', () => {
    expect(src).toContain('openai:')
    expect(src).toContain('deepseek:')
    expect(src).toContain('qwen:')
  })

  it('does not add a Test Connection affordance (out of scope for this milestone)', () => {
    expect(src.toLowerCase()).not.toContain('test connection')
  })
})
