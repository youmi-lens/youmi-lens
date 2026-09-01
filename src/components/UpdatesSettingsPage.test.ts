import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { translateDesktop } from '../lib/desktopI18n'
import { DEFAULT_LANGUAGE_PREFERENCES } from '../lib/languagePreferences'
import { LanguagePreferencesContext, type LanguagePreferencesContextValue } from '../languagePreferencesContext'
import { UpdatesSettingsPage } from './UpdatesSettingsPage'

const src = readFileSync(new URL('./UpdatesSettingsPage.tsx', import.meta.url), 'utf8')
const hookSrc = readFileSync(new URL('../lib/updater/useUpdater.ts', import.meta.url), 'utf8')

const contextValue: LanguagePreferencesContextValue = {
  preferences: DEFAULT_LANGUAGE_PREFERENCES,
  setPreference: () => undefined,
  t: (key, vars) => translateDesktop('en', key, vars),
}

function render(): string {
  return renderToStaticMarkup(
    createElement(
      LanguagePreferencesContext.Provider,
      { value: contextValue },
      createElement(UpdatesSettingsPage, {
        recordingSafety: { recorderStatus: 'idle', saveInFlight: false, recoveringSession: false },
      }),
    ),
  )
}

describe('UpdatesSettingsPage — outside Tauri (this test environment), before its mount effect fires', () => {
  it('never renders the literal, ambiguous "Loading…" string', () => {
    const html = render()
    expect(html).not.toContain('Loading…')
  })

  it('shows an explicit, actionable "Not checked yet" state with a real Check for Updates button', () => {
    const html = render()
    expect(html).toContain('Not checked yet')
    expect(html).toContain('Check for Updates')
  })

  it('shows the canonical version row (empty outside a packaged Tauri app, never a hardcoded fallback string)', () => {
    const html = render()
    expect(html).toContain('Version')
    expect(html).not.toMatch(/v0\.1(?!\d)/)
  })
})

describe('UpdatesSettingsPage source — the actual fix for the QA15 indefinite-loading bug', () => {
  it('runs its own real, non-silent check on mount instead of depending on the ambient silent startup timer', () => {
    expect(src).toContain('const check = up.actions.check')
    expect(src).toContain('void check()')
  })

  it('wires every actionable status to the correct updater action (Retry / Download / Install / Check)', () => {
    expect(src).toContain("kind === 'error') return void up.actions.check()")
    expect(src).toContain("kind === 'available') return void up.actions.download()")
    expect(src).toContain("kind === 'ready') return void up.actions.installAndRestart()")
  })

  it('never falls back to the shared billing "statusLoading" i18n key (that key is for billing, not updates)', () => {
    expect(src).not.toContain('settings.statusLoading')
  })
})

describe('useUpdater source — ambient startup timer cannot clobber an already-resolved status', () => {
  it('guards the silent startup check on the status still being idle', () => {
    expect(hookSrc).toContain("if (statusRef.current === 'idle') void check({ silent: true })")
  })

  it('keeps the bounded 12s timeout on every check (the hook-level guarantee that a check always terminates)', () => {
    expect(hookSrc).toContain('STARTUP_CHECK_TIMEOUT_MS = 12_000')
    expect(hookSrc).toContain('Promise.race')
  })
})
