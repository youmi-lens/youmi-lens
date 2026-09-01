import { useEffect } from 'react'
import { useUpdater } from '../lib/updater/useUpdater'
import type { RecordingSafetyState } from '../lib/updater/updaterCore'
import { updatesPageStatusKind, type UpdatesPageStatusKind } from '../lib/updater/updatesPageStatus'
import { useLanguagePreferences } from '../languagePreferencesContext'
import type { DesktopI18nKey } from '../lib/desktopI18n'
import { SettingsRow } from './SettingsLayout'

const STATUS_TEXT_KEY: Record<UpdatesPageStatusKind, DesktopI18nKey> = {
  'not-checked': 'settings.updateNotChecked',
  checking: 'settings.updateChecking',
  'up-to-date': 'settings.updateUpToDate',
  available: 'settings.updateAvailableStatus',
  downloading: 'settings.updateDownloadingStatus',
  ready: 'settings.updateReadyStatus',
  installing: 'settings.updateInstallingStatus',
  'restart-required': 'settings.updateRestartRequiredStatus',
  error: 'settings.updateUnableToCheck',
}

/**
 * Settings-native Updates page. Reuses `useUpdater` exactly as `UpdaterEntry`
 * does (same hook, same recording-safety gate, same check/download/install
 * logic) — only the presentation is native to `.settings-v2`.
 *
 * Root cause of the QA15 "stuck on Loading…" report: this page's hook
 * instance only ever got an answer from `useUpdater`'s ambient, deliberately
 * SILENT startup timer (2.5s after mount) — and a silent check that fails or
 * times out resets straight back to 'idle' with no visible signal, by design,
 * so a routine app-launch toast never scares the user. Settings has no such
 * concern: the user opened this page on purpose, so it always fires its own
 * real, non-silent check on mount, which is guaranteed to land on a terminal
 * state (bounded to 12s inside `useUpdater`) instead of inheriting whatever
 * the ambient timer silently gave up on.
 */
export function UpdatesSettingsPage({ recordingSafety }: { recordingSafety: RecordingSafetyState }) {
  const { t } = useLanguagePreferences()
  const up = useUpdater(recordingSafety)

  const check = up.actions.check
  useEffect(() => {
    // `check` is a stable useCallback identity from useUpdater (empty deps),
    // so listing it here does not cause repeat calls — this only ever fires
    // once per Settings-page mount. This is the page's own authoritative,
    // non-silent check, run every time Settings→Updates is opened.
    void check()
  }, [check])

  const kind = updatesPageStatusKind(up.status)
  const busy = kind === 'checking' || kind === 'downloading' || kind === 'installing'

  const actionLabel = () => {
    if (kind === 'error') return t('settings.retryUpdate')
    if (kind === 'available') return t('settings.downloadUpdate')
    if (kind === 'ready') return t('settings.installAndRestart')
    if (busy) return null
    return t('settings.checkForUpdates')
  }

  const runAction = () => {
    if (kind === 'error') return void up.actions.check()
    if (kind === 'available') return void up.actions.download()
    if (kind === 'ready') return void up.actions.installAndRestart()
    return void up.actions.check()
  }

  const label = actionLabel()
  const statusText =
    kind === 'downloading' && up.progress != null
      ? `${t(STATUS_TEXT_KEY.downloading)} ${up.progress}%`
      : t(STATUS_TEXT_KEY[kind])

  return (
    <>
      <h2>{t('settings.updates')}</h2>
      <div className="settings-v2__group">
        <SettingsRow name={t('settings.version')} help={up.currentVersion ? `v${up.currentVersion}` : '—'} />
        <SettingsRow
          name={t('settings.updateStatus')}
          control={
            <div>
              <div className="settings-v2__update-status">
                <span
                  aria-hidden="true"
                  className={`settings-v2__update-dot${
                    kind === 'error'
                      ? ' settings-v2__update-dot--error'
                      : kind === 'not-checked' || kind === 'up-to-date'
                        ? ''
                        : ' settings-v2__update-dot--actionable'
                  }`}
                />
                <span aria-live="polite">{statusText}</span>
                {label ? (
                  <button type="button" className="v2-btn" onClick={runAction}>
                    {label}
                  </button>
                ) : null}
              </div>
              {kind === 'downloading' ? (
                <div className="settings-v2__update-progress">
                  <div className="settings-v2__update-progress-fill" style={{ width: `${up.progress ?? 0}%` }} />
                </div>
              ) : null}
              {up.blockedReason ? <div className="settings-v2__update-blocked">{up.blockedReason}</div> : null}
              {up.error ? <div className="settings-v2__update-error">{up.error}</div> : null}
            </div>
          }
        />
      </div>
      {up.releaseNotes ? <div className="settings-v2__update-notes">{up.releaseNotes}</div> : null}
    </>
  )
}
