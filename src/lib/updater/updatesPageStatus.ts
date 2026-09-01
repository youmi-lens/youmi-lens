import type { UpdaterStatus } from './updaterCore'

/**
 * Settings-page-only status vocabulary — deliberately decoupled from
 * `updaterStatusLabel` (the legacy sidebar chip's copy), so wording chosen
 * here can never change that surface and vice versa.
 *
 * `'idle'` always maps to `'not-checked'`, never a generic loading word. QA15
 * fell back to a shared "Loading…" string for `'idle'`, and a silently-failed
 * background check (see `useUpdater`'s ambient startup timer) left the hook
 * sitting at `'idle'` indefinitely — so the Settings page displayed "Loading…"
 * forever with no visible way out. "Not checked yet" is an honest description
 * of that same state and pairs with a real, working "Check for Updates"
 * button, so the page is never stuck on an unexplained spinner.
 */
export type UpdatesPageStatusKind =
  | 'not-checked'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'restart-required'
  | 'error'

/** Exhaustive by construction — a new `UpdaterStatus` member fails to compile until mapped here. */
export function updatesPageStatusKind(status: UpdaterStatus): UpdatesPageStatusKind {
  switch (status) {
    case 'idle':
      return 'not-checked'
    case 'checking':
      return 'checking'
    case 'up-to-date':
      return 'up-to-date'
    case 'available':
      return 'available'
    case 'downloading':
      return 'downloading'
    case 'ready':
      return 'ready'
    case 'installing':
      return 'installing'
    case 'restart-required':
      return 'restart-required'
    case 'error':
      return 'error'
  }
}
