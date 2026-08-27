import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_TAKEN_MESSAGE,
  normalizeOptionalPhone,
  normalizedDisplayNameKey,
  validateDisplayName,
} from '../lib/profileFields'
import {
  fetchProfile,
  isProfileDisplayNameTakenByOther,
  upsertProfileUsername,
  type UserProfileRow,
} from '../lib/userProfile'
import { deleteAccount } from '../lib/account'
import { INTERNAL_BETA_NOTE, PRODUCT_VERSION_LABEL } from '../lib/productMeta'
import './AccountSettingsModal.css'

type Props = {
  open: boolean
  onClose: () => void
  supabase: SupabaseClient
  userId: string
  accountEmail: string | null
  profile: UserProfileRow | null
  onSaved: (row: UserProfileRow | null) => void
  onSignOut: () => void
  /** Called after the account is permanently deleted server-side; caller must sign out / clear local state. */
  onAccountDeleted: () => void
}

export function AccountSettingsModal({
  open,
  onClose,
  supabase,
  userId,
  accountEmail,
  profile,
  onSaved,
  onSignOut,
  onAccountDeleted,
}: Props) {
  const [displayName, setDisplayName] = useState('')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [signOutBusy, setSignOutBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteErr, setDeleteErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setErr(null)
    setOkMsg(null)
    setDeleteErr(null)
    setDisplayName(profile?.username?.trim() ?? '')
    setPhone(profile?.phone?.trim() ?? '')
  }, [open, profile])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const prevBodyOverflow = document.body.style.overflow
    const prevHtmlOverflow = document.documentElement.style.overflow
    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prevBodyOverflow
      document.documentElement.style.overflow = prevHtmlOverflow
    }
  }, [open])

  const handleSave = async () => {
    setErr(null)
    setOkMsg(null)
    const v = validateDisplayName(displayName)
    if (!v.ok) {
      setErr(v.message)
      return
    }
    const prevKey = normalizedDisplayNameKey(profile?.username ?? '')
    const nextKey = normalizedDisplayNameKey(v.value)
    if (nextKey !== prevKey) {
      const { taken } = await isProfileDisplayNameTakenByOther(supabase, userId, v.value)
      if (taken) {
        setErr(DISPLAY_NAME_TAKEN_MESSAGE)
        return
      }
    }
    setBusy(true)
    try {
      const { error } = await upsertProfileUsername(supabase, userId, {
        username: v.value,
        phone: normalizeOptionalPhone(phone),
      })
      if (error) {
        setErr(error)
        return
      }
      const row = await fetchProfile(supabase, userId)
      onSaved(row)
      setOkMsg('Your profile was updated.')
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteAccount = async () => {
    if (deleteBusy) return
    const firstConfirm = window.confirm(
      'Delete your Youmi Lens account? This permanently removes your recordings, courses, and account data. This cannot be undone.',
    )
    if (!firstConfirm) return
    const secondConfirm = window.confirm('Are you absolutely sure? This is your last chance to cancel.')
    if (!secondConfirm) return

    setDeleteErr(null)
    setDeleteBusy(true)
    try {
      await deleteAccount()
      onAccountDeleted()
    } catch (e) {
      setDeleteErr(e instanceof Error ? e.message : 'Could not delete account. Please try again or contact support.')
    } finally {
      setDeleteBusy(false)
    }
  }

  if (!open) return null

  return (
    <div
      className="desktop-v2 account-settings-modal__overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-labelledby="account-settings-title"
        className="account-settings-modal__dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="account-settings-modal__header">
          <h2 id="account-settings-title" className="account-settings-modal__title">
            Account
          </h2>
          <p className="account-settings-modal__lead">
            Update how Youmi Lens greets you and your optional phone number.
          </p>
        </div>

        <div className="account-settings-modal__body">
          <label className="account-settings-modal__field">
            <span className="account-settings-modal__field-label">Email</span>
            <input
              className="login-screen__email-input account-settings-modal__input"
              type="text"
              readOnly
              value={accountEmail || 'Not available for this sign-in method'}
            />
          </label>

          <label className="account-settings-modal__field">
            <span className="account-settings-modal__field-label">Display name</span>
            <input
              className="login-screen__email-input account-settings-modal__input"
              type="text"
              maxLength={DISPLAY_NAME_MAX_LENGTH}
              autoComplete="nickname"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>

          <label className="account-settings-modal__field">
            <span className="account-settings-modal__field-label">Phone (optional)</span>
            <input
              className="login-screen__email-input account-settings-modal__input"
              type="tel"
              autoComplete="tel"
              placeholder=""
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </label>

          {okMsg ? <p className="account-settings-modal__message account-settings-modal__message--ok">{okMsg}</p> : null}
          {err ? <p className="account-settings-modal__message account-settings-modal__message--error">{err}</p> : null}

          <div className="account-settings-modal__meta">
            <h3 className="account-settings-modal__meta-title">{PRODUCT_VERSION_LABEL}</h3>
            <p className="account-settings-modal__meta-note">{INTERNAL_BETA_NOTE}</p>
          </div>

          <div className="account-settings-modal__danger-section">
            <h3 className="account-settings-modal__danger-title">Delete account</h3>
            <p className="account-settings-modal__danger-note">
              Permanently removes your account, recordings, and course data. This cannot be undone.
            </p>
            {deleteErr ? (
              <p className="account-settings-modal__message account-settings-modal__message--error">{deleteErr}</p>
            ) : null}
            <button
              type="button"
              className="account-settings-modal__btn account-settings-modal__btn--danger"
              disabled={deleteBusy}
              aria-busy={deleteBusy}
              onClick={() => void handleDeleteAccount()}
            >
              {deleteBusy ? 'Deleting…' : 'Delete account'}
            </button>
          </div>
        </div>

        <div className="account-settings-modal__footer">
          <button
            type="button"
            className="account-settings-modal__btn account-settings-modal__btn--primary"
            disabled={busy || !displayName.trim()}
            aria-busy={busy}
            onClick={() => void handleSave()}
          >
            {busy ? 'Saving…' : 'Save changes'}
          </button>
          <button
            type="button"
            className="account-settings-modal__btn account-settings-modal__btn--secondary"
            disabled={busy || signOutBusy}
            aria-busy={signOutBusy}
            onClick={() => {
              if (signOutBusy) return
              setSignOutBusy(true)
              void Promise.resolve(onSignOut()).finally(() => setSignOutBusy(false))
            }}
          >
            {signOutBusy ? 'Signing out…' : 'Sign out'}
          </button>
          <button type="button" className="account-settings-modal__btn account-settings-modal__btn--secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
