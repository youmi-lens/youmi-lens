import { useEffect, useState } from 'react'

/**
 * The single canonical source of the shipped app version: Tauri's own
 * runtime `getVersion()`. `useUpdater` composes this same hook internally —
 * there is exactly one code path that reads the version, shared by every
 * caller (the updater itself, the Settings Updates page, Support & About,
 * and the Account modal), so none of them can ever disagree.
 *
 * Empty string on web/dev, where there is no packaged app version.
 */
export function useAppVersion(): string {
  const [version, setVersion] = useState('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { getVersion } = await import('@tauri-apps/api/app')
        const v = await getVersion()
        if (!cancelled) setVersion(v)
      } catch {
        /* web/dev: version comes from the build; leave empty */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return version
}
