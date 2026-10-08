import { createContext } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import type { CheckEmailResult } from './lib/signupCodeApi'
import type { SignOutOptions } from './lib/authSignOut'

export type AuthMethodResult = { error: string | null }

/** Result for the signup-code methods. `code` carries the stable backend error code so UI can branch (e.g. email_exists). */
export type SignupAuthMethodResult = AuthMethodResult & { code: string | null }

export type AuthContextValue = {
  configured: boolean
  loading: boolean
  session: Session | null
  user: User | null
  /**
   * True while a Supabase password-recovery session is active (after verifyOtp with type='recovery')
   * and the user has not yet finished setting a new password. The app shell should keep rendering
   * the auth flow until this clears (via signOut after updatePassword succeeds).
   */
  inPasswordRecovery: boolean
  /**
   * OAuth entry points. On desktop these open the system browser and return via the
   * `lecturecompanion://auth-callback` deep link; the result reports only whether the
   * handoff STARTED — the session arrives later through onAuthStateChange.
   */
  signInWithGoogle: () => Promise<AuthMethodResult>
  signInWithApple: () => Promise<AuthMethodResult>
  /**
   * Legacy magic-link entry. Retained for deep-link / backwards-compatibility paths; not used by
   * the main login UI in the password-aligned flow.
   */
  signInWithEmailOtp: (email: string) => Promise<AuthMethodResult>
  /** Email + password sign-in (iPad-aligned primary UX). */
  signInWithPassword: (email: string, password: string) => Promise<AuthMethodResult>
  /** Pre-flight: is this email already registered? Advisory — never blocks signup. */
  checkEmail: (email: string) => Promise<CheckEmailResult>
  /** Step 1 of Create Account: send 8-digit signup verification code via backend. */
  requestSignupCode: (args: { email: string; username: string }) => Promise<SignupAuthMethodResult>
  /**
   * Step 2 of Create Profile: backend verifies code and creates the auth user + profile.
   * Returns ok-flag; caller then signs in with email+password to establish a session.
   */
  verifySignupCodeAndCreateUser: (args: {
    email: string
    username: string
    password: string
    code: string
  }) => Promise<SignupAuthMethodResult>
  /**
   * Forgot Password step 1: ask Supabase to send a recovery email containing `{{ .Token }}`.
   * Sent WITHOUT redirectTo, matching Website + iPad. A missing account still resolves
   * with `error: null` (no enumeration); a real send failure DOES report an error so the
   * UI never advances to a code screen for a code that was never sent.
   */
  requestPasswordResetCode: (email: string) => Promise<AuthMethodResult>
  /** Forgot Password step 2: verify the emailed recovery code. Establishes a recovery session. */
  verifyPasswordResetCode: (email: string, code: string) => Promise<AuthMethodResult>
  /** Forgot Password step 3: update the password on the current (recovery) session. */
  updatePassword: (newPassword: string) => Promise<AuthMethodResult>
  /**
   * Always resolves (never throws), like the Website's signOut. Signs out THIS Desktop session only; pass
   * `{ scope: 'global' }` solely for security flows that must end every session of the account.
   */
  signOut: (options?: SignOutOptions) => Promise<AuthMethodResult>
  /** Non-null when a deep-link auth callback was received but the token exchange failed. */
  deepLinkAuthError: string | null
  clearDeepLinkAuthError: () => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)
