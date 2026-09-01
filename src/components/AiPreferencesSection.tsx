import { useEffect, useState } from 'react'
import { useLanguagePreferences } from '../languagePreferencesContext'
import type { AiSourceMode } from '../lib/ai/aiSource'
import {
  getAiSource,
  getByokApiKey,
  getByokProvider,
  setAiSource,
  setByokApiKey,
  setByokProvider,
} from '../lib/ai/aiSource'
import type { ByokProviderId } from '../lib/ai/providers/types'

/** User-visible only: capability hints, no vendor or service codenames. */
const BYOK_LABELS: Record<ByokProviderId, string> = {
  openai: 'Full lecture features (transcription, live captions, summaries)',
  deepseek: 'Text features only — summaries & translation (no class-audio transcription)',
  qwen: 'Text features only — alternate path (no class-audio transcription)',
}

type Props = {
  /** When false, BYOK options are hidden (e.g. extreme dev-only builds). */
  allowByok: boolean
}

/**
 * Two calm, vertically-stacked options rather than one dense technical panel.
 * Each option's title/badge/description are separate block-level lines
 * (never inline siblings of the radio input) — QA15 rendered the title and
 * description as adjacent inline elements, which is what let them visually
 * collide with each other and with the radio control at narrower widths.
 */
export function AiPreferencesSection({ allowByok }: Props) {
  const { t } = useLanguagePreferences()
  const [mode, setMode] = useState<AiSourceMode>('youmi')
  const [provider, setProvider] = useState<ByokProviderId>('openai')
  const [key, setKey] = useState('')

  useEffect(() => {
    setMode(getAiSource())
    setProvider(getByokProvider())
    setKey(getByokApiKey())
  }, [])

  const persist = (nextMode: AiSourceMode, p: ByokProviderId, k: string) => {
    setAiSource(nextMode)
    setByokProvider(p)
    setByokApiKey(k)
  }

  return (
    <div className="settings-v2__ai-content">
      <p className="settings-v2__lead">{t('settings.aiLead')}</p>

      <div className="settings-v2__group settings-v2__group--padded">
        <label className="settings-v2__ai-option">
          <input
            type="radio"
            name="ai-source"
            checked={mode === 'youmi'}
            disabled={!allowByok && mode !== 'youmi'}
            onChange={() => {
              setMode('youmi')
              persist('youmi', provider, key)
            }}
          />
          <span className="settings-v2__ai-option-copy">
            <span className="settings-v2__ai-option-title">{t('settings.aiYoumiTitle')}</span>
            <span className="settings-v2__ai-option-badge">{t('settings.aiRecommended')}</span>
            <span className="settings-v2__ai-option-desc">{t('settings.aiYoumiDesc')}</span>
          </span>
        </label>

        {allowByok ? (
          <label className="settings-v2__ai-option">
            <input
              type="radio"
              name="ai-source"
              checked={mode === 'byok'}
              onChange={() => {
                setMode('byok')
                persist('byok', provider, key)
              }}
            />
            <span className="settings-v2__ai-option-copy">
              <span className="settings-v2__ai-option-title">{t('settings.aiByokTitle')}</span>
              <span className="settings-v2__ai-option-badge">{t('settings.aiAdvanced')}</span>
              <span className="settings-v2__ai-option-desc">{t('settings.aiByokDesc')}</span>

              {mode === 'byok' ? (
                <span className="settings-v2__ai-byok-fields">
                  <label className="settings-v2__ai-field">
                    <span className="settings-v2__ai-field-label">{t('settings.aiProvider')}</span>
                    <select
                      className="v2-select"
                      value={provider}
                      onChange={(e) => {
                        const p = e.target.value as ByokProviderId
                        setProvider(p)
                        persist('byok', p, key)
                      }}
                    >
                      {(Object.keys(BYOK_LABELS) as ByokProviderId[]).map((id) => (
                        <option key={id} value={id}>
                          {BYOK_LABELS[id]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="settings-v2__ai-field">
                    <span className="settings-v2__ai-field-label">{t('settings.aiApiKey')}</span>
                    <input
                      type="password"
                      className="v2-select settings-v2__ai-key-input"
                      autoComplete="off"
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                      onBlur={() => persist(mode, provider, key)}
                      placeholder={t('settings.aiApiKeyPlaceholder')}
                    />
                  </label>
                </span>
              ) : null}
            </span>
          </label>
        ) : null}
      </div>
    </div>
  )
}
