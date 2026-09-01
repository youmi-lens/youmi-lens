/**
 * Desktop V2 — Phase 1A guardrails.
 *
 * These exist because the first attempt at Phase 1A looked correct in isolation
 * but shipped the legacy shell underneath the new components. Most of what is
 * asserted here is therefore about what must NOT be in the tree.
 */
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DesktopSidebar, type DesktopPrimaryView } from './DesktopSidebar'
import { DesktopV2Shell } from './DesktopV2Shell'
import { RecordHome } from './RecordHome'
import { AccountSettingsModal } from './AccountSettingsModal'
import { SettingsLanguagePage } from './SettingsLanguagePage'
import { SettingsLayout } from './SettingsLayout'
import { DEFAULT_SETTINGS_SECTION, SETTINGS_SECTIONS } from '../lib/settingsSections'
import { openRecordLanguageSettings, runRecordHomeStart } from '../lib/recordHomeActions'
import {
  LanguagePreferencesContext,
  type LanguagePreferencesContextValue,
} from '../languagePreferencesContext'
import { DEFAULT_LANGUAGE_PREFERENCES } from '../lib/languagePreferences'
import { translateDesktop } from '../lib/desktopI18n'

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const v2Css = readFileSync(new URL('../styles/desktop-v2.css', import.meta.url), 'utf8')
const v2Tokens = readFileSync(new URL('../styles/desktop-v2-tokens.css', import.meta.url), 'utf8')

const contextValue: LanguagePreferencesContextValue = {
  preferences: DEFAULT_LANGUAGE_PREFERENCES,
  setPreference: () => undefined,
  // Vars must be forwarded. A test double that drops them is the same defect as
  // the production provider had, and would hide it again.
  t: (key, vars) => translateDesktop('en', key, vars),
}

function render(node: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(
    createElement(LanguagePreferencesContext.Provider, { value: contextValue }, node),
  )
}

function renderSidebar(activeView: DesktopPrimaryView): string {
  return render(
    createElement(DesktopSidebar, {
      activeView,
      onNavigate: () => undefined,
      accountName: 'Ayden',
      accountPlan: 'Free Beta',
    }),
  )
}

const recordHomeProps = {
  course: 'CS 250',
  title: 'Lecture 13',
  preferences: DEFAULT_LANGUAGE_PREFERENCES,
  recentLectures: [],
  onTitleChange: () => undefined,
  onStartRecording: () => undefined,
  onOpenSettings: () => undefined,
  onChangeCourse: () => undefined,
  onNewCourse: () => undefined,
  onViewAll: () => undefined,
  onOpenLecture: () => undefined,
}

/** Class names that prove the legacy shell leaked into a V2 view. */
const LEGACY_MARKERS = [
  'yl-shell',
  'yl-topbar',
  'yl-sidebar',
  'record-workspace',
  'workspace-page-shell',
  'yl-nav-section',
  'yl-col-resizer',
]

function expectNoLegacyChrome(html: string) {
  for (const marker of LEGACY_MARKERS) {
    expect(html).not.toContain(marker)
  }
}

// ── 1 / 2 · V2 views contain no legacy shell DOM ────────────────────────────

describe('V2 views render no legacy shell DOM', () => {
  it('Record Home inside the V2 shell has no legacy chrome', () => {
    const html = render(
      createElement(
        DesktopV2Shell,
        {
          activeView: 'record',
          onNavigate: () => undefined,
          toolbarTitle: 'Record',
          accountName: 'Ayden',
          accountPlan: 'Free Beta',
        },
        createElement(RecordHome, recordHomeProps),
      ),
    )
    expectNoLegacyChrome(html)
    expect(html).toContain('desktop-v2')
  })

  it('Settings inside the V2 shell has no legacy chrome', () => {
    const html = render(
      createElement(
        DesktopV2Shell,
        {
          activeView: 'settings',
          onNavigate: () => undefined,
          toolbarTitle: 'Settings',
          accountName: 'Ayden',
          accountPlan: 'Free Beta',
        },
        createElement(
          SettingsLayout,
          { section: 'language', onSectionChange: () => undefined },
          createElement(SettingsLanguagePage, {
            preferences: DEFAULT_LANGUAGE_PREFERENCES,
            onPreferenceChange: () => undefined,
          }),
        ),
      ),
    )
    expectNoLegacyChrome(html)
    expect(html).toContain('settings-v2')
  })
})

// ── 3 / 12 · exactly one shell, and recording keeps the legacy one ──────────

describe('shell selection', () => {
  it('App renders the V2 shell OR the legacy shell, never both', () => {
    // One ternary guards the whole thing, so the two branches cannot co-exist.
    expect(appSource).toContain('{desktopV2Page ? (')
    expect(appSource).toContain('<DesktopV2Shell')
    expect(appSource.match(/<YoumiLensShell/g)).toHaveLength(1)
    // The legacy shell must not be neutralised with CSS anywhere in V2 styles.
    expect(v2Css).not.toContain('display: none !important')
  })

  it('an ACTIVE recording takes the V2 path, ahead of every other view', () => {
    // INVERTED from Phase 1A, deliberately. This assertion used to require
    // `workspaceView === 'record' && recorder.status === 'idle'`, i.e. that a
    // live recording fell back to the legacy `.yl-shell`. Real-account QA
    // confirmed that as a regression against the approved Preview: pressing
    // Start swapped the whole window back to the old cockpit. `recording` is now
    // the FIRST branch of desktopV2View, so no other view can outrank it.
    // Now keyed on the derived STAGE, not the recorder: `handleStopAndSave`
    // awaits `recorder.stop()` first, so the recorder reports idle while the
    // pipeline is still saving — keying on it dropped the user onto Record Home
    // mid-save.
    expect(appSource).toContain('ownsRecordingScreen(recordingStage)\n      ? \'recording\'')
    expect(appSource).not.toContain("workspaceView === 'record' && recorder.status === 'idle'")
  })

  it('the nested DesktopSidebar was removed from the legacy sidebar prop', () => {
    expect(appSource).not.toContain('<DesktopSidebar')
  })
})

// ── 4 / 5 / 6 · the sidebar ────────────────────────────────────────────────

describe('DesktopSidebar', () => {
  it('emits its own <aside>, not a fragment for someone else to wrap', () => {
    // React 19 emits <link rel="preload"> resource hints for the wordmark ahead
    // of the markup; strip them before checking the component's own root tag.
    const html = renderSidebar('record').replace(/<link\b[^>]*\/>/g, '')
    expect(html.startsWith('<aside')).toBe(true)
    expect(html).toContain('desktop-v2-sidebar')
    expect(html.trimEnd().endsWith('</aside>')).toBe(true)
  })

  it('is byte-identical across pages except for the active indicator', () => {
    const outputs = (['record', 'courses', 'settings'] as const).map(renderSidebar)
    const normalized = outputs.map((html) => html.replace(/ aria-current="page"/g, ''))
    expect(new Set(normalized).size).toBe(1)
    for (const html of outputs) {
      expect(html.match(/data-view=/g)).toHaveLength(3)
      expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    }
  })

  it('uses the official wordmark asset and carries no updater or version utility', () => {
    const html = renderSidebar('record')
    expect(html).toContain('/brand/youmi-lens-wordmark-transparent.png')
    expect(html.toLowerCase()).not.toContain('updater')
    expect(html.toLowerCase()).not.toContain('version')
  })
})

// ── 7 / 8 / 9 · Record Home ────────────────────────────────────────────────

describe('Record Home', () => {
  it('presents Course as an identity row, not a text input', () => {
    const html = render(createElement(RecordHome, recordHomeProps))
    expect(html).toContain('record-home-v2__course-icon')
    expect(html).toContain('record-home-v2__course-value')
    // The only input on the page is the optional lecture title.
    expect(html.match(/<input/g)).toHaveLength(1)
    expect(html).toContain('record-home-lecture-title')
  })

  it('has no hollow circle on the start button and stacks the setup rows', () => {
    const html = render(createElement(RecordHome, recordHomeProps))
    expect(html).not.toContain('record-home__start-dot')
    expect(html).not.toContain('record-home__setup')
    expect(html).toContain('v2-btn--record')
  })

  it('Start Recording invokes the original callback', () => {
    const start = vi.fn()
    runRecordHomeStart(start)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('Change in Settings routes to the settings view', () => {
    const open = vi.fn()
    openRecordLanguageSettings(open)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('shows the read-only language summary for the current preferences', () => {
    const html = render(createElement(RecordHome, recordHomeProps))
    expect(html).toContain('English')
    expect(html).toContain('record-home-v2__summary')
  })

  /**
   * Owner QA: a fresh account with zero real Courses could still show a
   * fake `Unfiled` course-like row and let Start Recording begin. Every
   * lecture must belong to a real Course — an empty `course` prop here only
   * ever means the account genuinely has none yet (see
   * `reconcileCourseSelection`'s 'clear' action), never a deliberate
   * "leave this one unfiled" choice, so it must read as "none yet".
   */
  it('a genuinely empty Course (zero Courses) reads as "no courses yet", never a fake Unfiled category', () => {
    const html = render(createElement(RecordHome, { ...recordHomeProps, course: '' }))
    expect(html).toContain('No courses yet')
    expect(html).not.toContain('Unfiled')
  })

  it('a real selected Course still renders normally', () => {
    const html = render(createElement(RecordHome, recordHomeProps))
    expect(html).toContain('CS 250')
    expect(html).not.toContain('No courses yet')
  })
})

// ── 10 / 11 · Settings ─────────────────────────────────────────────────────

describe('Settings', () => {
  it('opens on Account — the most immediately useful section — not a section with no real controls', () => {
    expect(DEFAULT_SETTINGS_SECTION).toBe('account')
    expect(DEFAULT_SETTINGS_SECTION).not.toBe('appearance')
  })

  it('master list is real navigation and marks the open section', () => {
    const html = render(
      createElement(
        SettingsLayout,
        { section: 'recording', onSectionChange: () => undefined },
        null,
      ),
    )
    expect(html.match(/data-section=/g)).toHaveLength(SETTINGS_SECTIONS.length)
    expect(html).toContain('data-section="recording" aria-current="page"')
  })

  it('keeps the four language preference fields independent', () => {
    const html = render(
      createElement(SettingsLanguagePage, {
        preferences: DEFAULT_LANGUAGE_PREFERENCES,
        onPreferenceChange: () => undefined,
      }),
    )
    for (const label of ['App language', 'Caption language', 'Translation language', 'Language mode']) {
      expect(html).toContain(label)
    }
    expect(html.match(/<select/g)).toHaveLength(4)
  })

  it('does not claim unsupported languages are live', () => {
    const html = render(
      createElement(SettingsLanguagePage, {
        preferences: DEFAULT_LANGUAGE_PREFERENCES,
        onPreferenceChange: () => undefined,
      }),
    )
    // Unsupported caption/translation options must be disabled, not silently offered.
    expect(html).toContain('disabled')
  })

  it('renders exactly the 5 approved sections and nothing from the retired 10-section IA', () => {
    for (const section of SETTINGS_SECTIONS) {
      const html = render(createElement(SettingsLayout, { section, onSectionChange: () => undefined }, null))
      expect(html.match(/data-section=/g)).toHaveLength(5)
      for (const retired of ['appearance', 'capture', 'language', 'liveCaptions', 'dataBackup', 'autoUpdate', 'planUsage', 'advancedAi']) {
        expect(html).not.toContain(`data-section="${retired}"`)
      }
    }
    expect(SETTINGS_SECTIONS).toEqual(['account', 'recording', 'ai', 'updates', 'support'])
  })

  it('App.tsx never dispatches to a retired settings section (a stale deep-link would be a broken state)', () => {
    const retired = ['appearance', 'capture', 'language', 'liveCaptions', 'dataBackup', 'autoUpdate', 'planUsage', 'advancedAi']
    for (const section of retired) {
      expect(appSource).not.toContain(`setSettingsSection('${section}')`)
    }
  })

  it('App.tsx no longer uses SettingsPlaceholder anywhere (every approved section is fully implemented)', () => {
    expect(appSource).not.toContain('SettingsPlaceholder')
  })

  it('Account section wires the identity row to the Account modal and the plan row to the Billing modal, reading real billing state', () => {
    const accountBranch = appSource.slice(
      appSource.indexOf("settingsSection === 'account'"),
      appSource.indexOf("settingsSection === 'recording'"),
    )
    expect(accountBranch).toContain('onClick={() => setAccountSettingsOpen(true)}')
    expect(accountBranch).toContain('onClick={() => setBillingPlanOpen(true)}')
    expect(accountBranch).toContain('billingSummaryLabel(billing.state, tDesktop)')
    expect(accountBranch).toContain("tone=\"danger\"")
  })

  it('Recording section keeps the real audio-source controls and embeds Language & Captions without a duplicate heading', () => {
    const recordingBranch = appSource.slice(
      appSource.indexOf("settingsSection === 'recording'"),
      appSource.indexOf("settingsSection === 'ai'"),
    )
    expect(recordingBranch).toContain("setAudioSource('microphone')")
    expect(recordingBranch).toContain("setAudioSource('system')")
    expect(recordingBranch).toContain('<SettingsLanguagePage')
    expect(recordingBranch).toContain('showHeading={false}')
  })

  it('AI section renders the real AiPreferencesSection with BYOK allowed, not a placeholder', () => {
    const aiBranch = appSource.slice(
      appSource.indexOf("settingsSection === 'ai'"),
      appSource.indexOf("settingsSection === 'updates'"),
    )
    expect(aiBranch).toContain('<AiPreferencesSection allowByok />')
  })

  it('Updates section is driven by UpdatesSettingsPage, not a hardcoded version string', () => {
    const updatesBranch = appSource.slice(
      appSource.indexOf("settingsSection === 'updates'"),
      appSource.indexOf('const recordingScreen ='),
    )
    expect(updatesBranch).toContain('<UpdatesSettingsPage')
    expect(appSource).not.toMatch(/Youmi Lens v0\.1/)
  })

  it('Support & About exposes Email, Privacy, and Terms via the shared URL constants, plus the canonical app version', () => {
    const supportBranch = appSource.slice(
      appSource.indexOf("tDesktop('settings.emailSupport')") - 200,
      appSource.indexOf('const recordingScreen ='),
    )
    expect(supportBranch).toContain('openExternalContact(SUPPORT_CONTACT_URL)')
    expect(supportBranch).toContain('openExternalUrl(PRIVACY_URL)')
    expect(supportBranch).toContain('openExternalUrl(TERMS_URL)')
    expect(supportBranch).toContain("appVersion ? `v${appVersion}` : '—'")
  })
})

describe('AccountSettingsModal', () => {
  const baseProps = {
    open: true,
    onClose: () => undefined,
    supabase: {} as never,
    userId: 'user-1',
    accountEmail: 'ayden@example.com',
    profile: null,
    onSaved: () => undefined,
    onSignOut: () => undefined,
    onAccountDeleted: () => undefined,
  }

  it('shows the real signed-in email and the canonical runtime version, never the retired hardcoded label', () => {
    const html = render(createElement(AccountSettingsModal, { ...baseProps, appVersion: '2.3.1' }))
    expect(html).toContain('ayden@example.com')
    expect(html).toContain('Youmi Lens v2.3.1')
    expect(html).not.toMatch(/Youmi Lens v0\.1/)
  })

  it('falls back to a plain product name when no runtime version is available yet (web/dev)', () => {
    const html = render(createElement(AccountSettingsModal, { ...baseProps, appVersion: '' }))
    expect(html).toContain('>Youmi Lens<')
  })

  it('keeps Delete Account physically separated in its own danger zone and Sign Out available', () => {
    const html = render(createElement(AccountSettingsModal, { ...baseProps, appVersion: '2.3.1' }))
    expect(html).toContain('account-settings-modal__danger-section')
    expect(html).toContain('account-settings-modal__btn--danger')
    expect(html).toContain('Delete account')
    expect(html).toContain('Sign out')
  })
})

// ── 13 · scoped CSS ────────────────────────────────────────────────────────

describe('V2 stylesheet', () => {
  it('contains no legacy shell selectors', () => {
    // Comments explain WHY `.yl-*` is banned, so compare against the rules only.
    const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(stripComments(v2Css)).not.toMatch(/\.yl-/)
    expect(stripComments(v2Tokens)).not.toMatch(/\.yl-/)
  })

  it('is px-based so the global 18px root font-size cannot rescale it', () => {
    // The 42rem panel became 756px under an 18px root; px keeps it at 672.
    expect(v2Tokens).toContain('--v2-panel-width: 672px')
    expect(v2Tokens).toContain('--v2-sidebar-width: 232px')
    expect(v2Tokens).toContain('--v2-rail-width: 72px')
    expect(v2Tokens).toContain('--v2-toolbar-height: 56px')
    expect(v2Tokens).not.toMatch(/:\s*[\d.]+rem/)
  })
})
