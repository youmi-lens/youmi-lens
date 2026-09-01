import type { ReactNode, SVGProps } from 'react'
import { useLanguagePreferences } from '../languagePreferencesContext'
import type { DesktopI18nKey } from '../lib/desktopI18n'
import { SETTINGS_SECTIONS, type SettingsSection } from '../lib/settingsSections'

const SECTION_LABEL_KEY: Record<SettingsSection, DesktopI18nKey> = {
  account: 'settings.account',
  recording: 'settings.recording',
  ai: 'settings.ai',
  updates: 'settings.updates',
  support: 'settings.support',
}

/**
 * Section icons — same stroke language as `DesktopSidebar`'s `SidebarIcon`
 * (24x24 viewBox, 1.8 stroke, round caps, currentColor, no fill): a
 * recognizably related family for the list one level down, not a new
 * illustration style.
 */
function SectionIcon({ name, ...props }: SVGProps<SVGSVGElement> & { name: SettingsSection }) {
  if (name === 'account') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" {...props}>
        <circle cx="12" cy="8" r="3.4" />
        <path d="M5 20c1.2-3.6 4-5.4 7-5.4s5.8 1.8 7 5.4" />
      </svg>
    )
  }
  if (name === 'recording') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" {...props}>
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 12a7 7 0 0 0 14 0M12 19v3" />
      </svg>
    )
  }
  if (name === 'ai') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" {...props}>
        <path d="M12 3.5l1.7 4.6 4.6 1.7-4.6 1.7-1.7 4.6-1.7-4.6-4.6-1.7 4.6-1.7z" />
        <path d="M18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
      </svg>
    )
  }
  if (name === 'updates') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <path d="M4 12a8 8 0 0 1 13.66-5.66L20 8" />
        <path d="M20 4v4h-4" />
        <path d="M20 12a8 8 0 0 1-13.66 5.66L4 16" />
        <path d="M4 20v-4h4" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.2 9.4a2.8 2.8 0 0 1 5.4.9c0 1.8-2.6 2-2.6 3.7" />
      <path d="M12 17.3v.1" />
    </svg>
  )
}

/**
 * Settings master/detail frame, ported from the approved mockup
 * (youmi-lens-desktop-v2-mockup/settings.html → `.settings-grid`).
 *
 * The master column is a real navigation list; the previous implementation
 * rendered it as inert `<span>`s inside the Language page, which is why Settings
 * could only ever show Language.
 */
export function SettingsLayout({
  section,
  onSectionChange,
  children,
}: {
  section: SettingsSection
  onSectionChange: (next: SettingsSection) => void
  children: ReactNode
}) {
  const { t } = useLanguagePreferences()

  return (
    <div className="settings-v2">
      <aside className="settings-v2__list" aria-label={t('settings.title')}>
        <h1>{t('settings.title')}</h1>
        <nav>
          {SETTINGS_SECTIONS.map((key) => (
            <button
              key={key}
              type="button"
              data-section={key}
              aria-current={section === key ? 'page' : undefined}
              onClick={() => onSectionChange(key)}
            >
              <SectionIcon name={key} aria-hidden="true" />
              <span>{t(SECTION_LABEL_KEY[key])}</span>
            </button>
          ))}
        </nav>
      </aside>
      <section className="settings-v2__detail">{children}</section>
    </div>
  )
}

/** One settings row: name, low-weight help text, and a compact control. */
export function SettingsRow({
  name,
  help,
  control,
}: {
  name: string
  help?: string
  control?: ReactNode
}) {
  return (
    <div className="settings-v2__row">
      <div className="settings-v2__row-copy">
        <div className="settings-v2__name">{name}</div>
        {help ? <div className="settings-v2__help">{help}</div> : null}
      </div>
      {control ? <div className="settings-v2__control">{control}</div> : null}
    </div>
  )
}

/**
 * A whole-row navigation control: name on the left, an optional trailing
 * value + chevron on the right, and the ENTIRE row is the click target —
 * replaces a generic "Open" button competing with the row's own content.
 */
export function SettingsNavRow({
  name,
  value,
  onClick,
  disabled,
  tone = 'default',
}: {
  name: string
  value?: string
  onClick: () => void
  disabled?: boolean
  tone?: 'default' | 'danger'
}) {
  return (
    <button
      type="button"
      className={`settings-v2__row settings-v2__row--nav${tone === 'danger' ? ' settings-v2__row--danger' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="settings-v2__name">{name}</span>
      <span className="settings-v2__row-trailing">
        {value ? <span className="settings-v2__help">{value}</span> : null}
        <span className="settings-v2__chevron" aria-hidden="true">
          ›
        </span>
      </span>
    </button>
  )
}

/**
 * A whole-row radio control for a small set of MUTUALLY EXCLUSIVE choices
 * (e.g. Recording's Audio Source). Renders a real `<input type="radio">` so
 * the control communicates its own semantics natively, rather than a plain
 * button standing in for one.
 */
export function SettingsRadioRow({
  name,
  help,
  checked,
  onSelect,
  disabled,
  groupName,
}: {
  name: string
  help?: string
  checked: boolean
  onSelect: () => void
  disabled?: boolean
  /** `name` attribute shared by every radio in the group. */
  groupName: string
}) {
  return (
    <label className={`settings-v2__row settings-v2__row--radio${disabled ? ' settings-v2__row--radio-disabled' : ''}`}>
      <span className="settings-v2__row-copy">
        <span className="settings-v2__name">{name}</span>
        {help ? <span className="settings-v2__help">{help}</span> : null}
      </span>
      <input
        type="radio"
        name={groupName}
        checked={checked}
        disabled={disabled}
        onChange={() => {
          if (!disabled) onSelect()
        }}
      />
    </label>
  )
}

/** A plain full-row action button (Sign Out) — same row rhythm, no chevron/value. */
export function SettingsActionRow({
  name,
  onClick,
  disabled,
  busy,
  tone = 'default',
}: {
  name: string
  onClick: () => void
  disabled?: boolean
  busy?: boolean
  tone?: 'default' | 'danger'
}) {
  return (
    <button
      type="button"
      className={`settings-v2__row settings-v2__row--action${tone === 'danger' ? ' settings-v2__row--danger' : ''}`}
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy}
    >
      <span className="settings-v2__name">{name}</span>
    </button>
  )
}
