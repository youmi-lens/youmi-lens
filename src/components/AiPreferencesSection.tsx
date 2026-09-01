import { useEffect, useState } from 'react'
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

export function AiPreferencesSection({ allowByok }: Props) {
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
    <div className="settings-v2__group settings-v2__group--padded">
      <p className="settings-v2__lead">
        Default is Youmi AI — no setup required. Advanced: use your own API key and pick the connection type that
        matches your account.
      </p>

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
          <strong>Youmi AI</strong>
          <span className="settings-v2__help">Recommended — runs on our service after you sign in.</span>
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
            <strong>Use my own API key</strong>
            <span className="settings-v2__help">
              For advanced users. Your key stays in this browser only unless you use cloud features (sent securely
              to process requests).
            </span>
            {mode === 'byok' ? (
              <div className="settings-v2__ai-byok-fields">
                <label className="settings-v2__ai-field">
                  <span className="settings-v2__ai-field-label">Connection type</span>
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
                  <span className="settings-v2__ai-field-label">API key</span>
                  <input
                    type="password"
                    className="v2-select settings-v2__ai-key-input"
                    autoComplete="off"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    onBlur={() => persist(mode, provider, key)}
                    placeholder="Paste key once per device"
                  />
                </label>
              </div>
            ) : null}
          </span>
        </label>
      ) : null}
    </div>
  )
}
