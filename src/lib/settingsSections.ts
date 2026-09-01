/**
 * Settings section identifiers, in the order the approved mockup lists them.
 *
 * These live outside SettingsLayout.tsx so that file only exports components —
 * react-refresh cannot hot-reload a module that mixes components and constants.
 */
export const SETTINGS_SECTIONS = ['account', 'recording', 'ai', 'updates', 'support'] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

/** Opening Settings lands on Account — the most immediately useful section. */
export const DEFAULT_SETTINGS_SECTION: SettingsSection = 'account'
