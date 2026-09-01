import { useUpdater } from '../lib/updater/useUpdater'
import { updaterStatusLabel, type RecordingSafetyState } from '../lib/updater/updaterCore'
import { useLanguagePreferences } from '../languagePreferencesContext'
import { SettingsRow } from './SettingsLayout'

/**
 * Settings-native Updates page. Reuses `useUpdater` exactly as `UpdaterEntry`
 * does (same hook, same recording-safety gate, same check/download/install
 * logic) — only the presentation is native to `.settings-v2` instead of a
 * standalone chip + its own modal chrome.
 */
export function UpdatesSettingsPage({ recordingSafety }: { recordingSafety: RecordingSafetyState }) {
  const { t } = useLanguagePreferences()
  const up = useUpdater(recordingSafety)
  const actionable = up.status !== 'idle' && up.status !== 'up-to-date'

  const actionLabel = () => {
    if (up.status === 'error') return t('settings.retryUpdate')
    if (up.status === 'available') return t('settings.downloadUpdate')
    if (up.status === 'ready') return t('settings.installAndRestart')
    if (up.status === 'downloading' || up.status === 'installing' || up.status === 'checking') return null
    return t('settings.checkForUpdates')
  }

  const runAction = () => {
    if (up.status === 'error') return void up.actions.check()
    if (up.status === 'available') return void up.actions.download()
    if (up.status === 'ready') return void up.actions.installAndRestart()
    return void up.actions.check()
  }

  const label = actionLabel()

  return (
    <>
      <h2>{t('settings.updates')}</h2>
      <div className="settings-v2__group">
        <SettingsRow name={t('settings.version')} help={up.currentVersion ? `v${up.currentVersion}` : '—'} />
        <SettingsRow
          name={t('settings.updateStatus')}
          help={undefined}
          control={
            <div>
              <div className="settings-v2__update-status">
                <span
                  aria-hidden="true"
                  className={`settings-v2__update-dot${
                    up.status === 'error'
                      ? ' settings-v2__update-dot--error'
                      : actionable
                        ? ' settings-v2__update-dot--actionable'
                        : ''
                  }`}
                />
                <span>
                  {up.status === 'downloading' && up.progress != null
                    ? `${updaterStatusLabel(up.status)} ${up.progress}%`
                    : /* Briefly empty for 'idle', before the startup check (~2.5s) resolves. */
                      updaterStatusLabel(up.status) || t('settings.statusLoading')}
                </span>
                {label ? (
                  <button type="button" className="v2-btn" onClick={runAction}>
                    {label}
                  </button>
                ) : null}
              </div>
              {up.status === 'downloading' ? (
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
