/**
 * Desktop authentication — a faithful port of the production Website auth pages.
 *
 * Visual + copy source of truth: landing/login/, landing/register/,
 * landing/forgot-password/ driven by landing/app/{login,register,forgot}.js and
 * landing/app/auth-ui.js. Styling comes from src/styles/auth-shell.css, which is a
 * byte-identical copy of landing/app/auth-shell.css (asserted by authShellParity.test.ts).
 *
 * Business rules are the Website's, unchanged:
 *   • sign in .................. Supabase email + password
 *   • create account ........... check-email → send-signup-code → 8-digit code →
 *                                verify-signup-code-and-create-user → auto sign-in
 *   • reset password ........... resetPasswordForEmail (no redirectTo) → recovery
 *                                OTP → verifyOtp({type:'recovery'}) → updateUser → signOut
 *
 * The ONLY platform divergence is OAuth transport, and it is confined to
 * AuthProvider.startOAuth (system browser + lecturecompanion:// deep link instead of
 * an in-page redirect). Nothing in this file knows about Tauri.
 *
 * Layout: the auth surface fills the whole app window (no outer canvas, no floating
 * card) — the desktop equivalent of the Website's `.yl-auth-full`. That rule is scoped
 * to the site, so the desktop version lives in src/styles/auth-desktop.css instead of
 * being copied in. The shared `.compact` modifier still drives the column split.
 *
 * Guest is deliberately not ported: the Website has none, and iPad's Guest rules are a
 * separate product decision.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import '../styles/auth-shell.css'
// Desktop-only overrides. auth-shell.css must stay byte-identical to the Website's
// copy (asserted by authShellParity.test.ts), so every desktop deviation lives here.
import '../styles/auth-desktop.css'
import { useAuth } from '../useAuth'
import { openExternalUrl } from '../lib/openExternalContact'
import { BrandPanel } from './auth/BrandPanel'
import { SsoStack } from './auth/SsoStack'
import { ResendControls } from './auth/ResendControls'
import { useResendCode, type ResendController } from './auth/useResendCode'
import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH, validateUsername } from './auth/username'

/** Same client-side email shape the Website uses (landing/app/auth-ui.js EMAIL_RE). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Website Terms / Privacy targets. Opened in the system browser from the
 * desktop app. Exported so Settings → Support & About can link to the exact
 * same URLs instead of hardcoding a second copy.
 */
export const TERMS_URL = 'https://youmilens.com/#support'
export const PRIVACY_URL = 'https://youmilens.com/#privacy'

/**
 * `compact` mirrors the Website's own `@media (max-width: 900px)` rules by applying
 * the `.compact` class the shared stylesheet defines for desktop, so both surfaces
 * retune the column split and padding at the same width.
 *
 * Everything about FILLING the window lives in auth-desktop.css — the auth surface is
 * always edge-to-edge here, at every window size, because a Tauri window has no page
 * chrome for a floating card to sit in.
 */
function useCompactSurface(): boolean {
  const [compact, setCompact] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= 900,
  )
  useEffect(() => {
    const onResize = () => setCompact(window.innerWidth <= 900)
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return compact
}

/**
 * Marks <html> while any auth screen is mounted, so the full-height chain
 * (html → body → #root) applies only here and is torn down on sign-in.
 */
function useFullscreenAuthRoot(): void {
  useEffect(() => {
    const el = document.documentElement
    el.classList.add('yl-auth-fullscreen')
    return () => el.classList.remove('yl-auth-fullscreen')
  }, [])
}

function AuthSurface({ children }: { children: ReactNode }) {
  const compact = useCompactSurface()
  useFullscreenAuthRoot()
  return (
    <div className="yl-auth-desktop">
      <div className={`yl-auth-surface${compact ? ' compact' : ''}`}>
        <BrandPanel />
        <div className="yl-auth-form">
          <div className="yl-auth-card">{children}</div>
        </div>
      </div>
    </div>
  )
}

type BannerKind = 'err' | 'info' | 'ok'
type BannerMsg = { kind: BannerKind; text: string } | null

function Banner({ msg }: { msg: BannerMsg }) {
  if (!msg) return null
  return <div className={`yl-auth-banner ${msg.kind}`}>{msg.text}</div>
}

function FieldError({ text }: { text: string | null }) {
  if (!text) return null
  return <p className="yl-auth-err">{text}</p>
}

/**
 * The Website renders these navigation affordances as `<a href>`, so they carry the
 * browser's default underline. The desktop app has no routing, so they must be
 * `<button>` — and auth-shell.css only underlines buttons on :hover. Restoring the
 * underline here keeps the two surfaces looking the same at rest; the shared
 * stylesheet stays untouched (its byte-parity with the Website is asserted by test).
 */
const LINK_LIKE = { textDecoration: 'underline' } as const

/**
 * Password input with the Website's text Show/Hide affordance (`.yl-auth-eye`),
 * not the legacy icon button. One `visible` flag per screen drives every password
 * field on that screen, matching the Website's single `showPw` variable.
 */
function PwField({
  id,
  value,
  onChange,
  visible,
  onToggleVisible,
  autoComplete,
  placeholder,
  disabled,
  onEnter,
}: {
  id: string
  value: string
  onChange: (next: string) => void
  visible: boolean
  onToggleVisible: () => void
  autoComplete: string
  placeholder: string
  disabled?: boolean
  onEnter?: () => void
}) {
  return (
    <div className="yl-auth-pw">
      <input
        id={id}
        className="yl-auth-input"
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        disabled={disabled}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) {
            e.preventDefault()
            onEnter()
          }
        }}
      />
      <button
        type="button"
        className="yl-auth-eye"
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        // Keep the caret where it was — the click must not blur the input.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggleVisible}
      >
        {visible ? 'Hide' : 'Show'}
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

type View =
  | { kind: 'signIn'; flash?: string }
  | { kind: 'register' }
  | { kind: 'reset' }

export function AuthScreens() {
  const auth = useAuth()
  const [view, setView] = useState<View>({ kind: 'signIn' })

  /**
   * Resend controllers live HERE, above the screens, so a cooldown survives moving
   * between steps — the React equivalent of the Website keeping them at module scope
   * so re-rendering cannot hand the user a fresh allowance.
   */
  const signupResend = useResendCode()
  const resetResend = useResendCode()

  /**
   * Supabase entered password-recovery mode (a typed recovery code succeeded, or a
   * recovery deep link arrived while the user sat on the sign-in screen). Derived
   * during render rather than pushed through an effect, so there is no frame where
   * a recovery session is live but the sign-in form is still on screen.
   *
   * `onClaimView` below is what keeps the final "Password updated" confirmation on
   * screen: once the password is changed the app signs out, inPasswordRecovery goes
   * false, and without pinning the view this would snap back to sign-in mid-flow.
   */
  const isReset = view.kind === 'reset' || auth.inPasswordRecovery

  if (isReset) {
    return (
      <ResetScreen
        resend={resetResend}
        onClaimView={() => setView({ kind: 'reset' })}
        onBackToSignIn={(flash) => {
          resetResend.reset()
          setView({ kind: 'signIn', flash })
        }}
      />
    )
  }

  if (view.kind === 'register') {
    return (
      <RegisterScreen
        resend={signupResend}
        onBackToSignIn={(flash) => {
          signupResend.reset()
          setView({ kind: 'signIn', flash })
        }}
      />
    )
  }

  return (
    <SignInScreen
      flash={view.flash}
      onGoRegister={() => setView({ kind: 'register' })}
      onGoReset={() => setView({ kind: 'reset' })}
    />
  )
}

// ── Sign in ──────────────────────────────────────────────────────────────────
// Mirrors landing/app/login.js.

function SignInScreen({
  flash,
  onGoRegister,
  onGoReset,
}: {
  flash?: string
  onGoRegister: () => void
  onGoReset: () => void
}) {
  const auth = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<BannerMsg>(flash ? { kind: 'ok', text: flash } : null)
  const [fieldErr, setFieldErr] = useState<string | null>(null)

  /**
   * A stale deep-link failure ("link expired") must not outlive the next attempt.
   * The Website has no equivalent because a failed callback never reaches its form.
   */
  const clearDeepLinkError = auth.clearDeepLinkAuthError

  const submit = useCallback(async () => {
    if (busy) return
    setMsg(null)
    setFieldErr(null)
    const trimmed = email.trim()
    // Same order and copy as the Website.
    if (!EMAIL_RE.test(trimmed)) {
      setFieldErr('Enter a valid email address.')
      return
    }
    if (password.length < 8) {
      setFieldErr('Password must be at least 8 characters.')
      return
    }
    clearDeepLinkError()
    setBusy(true)
    try {
      const { error } = await auth.signInWithPassword(trimmed, password)
      if (error) setMsg({ kind: 'err', text: error })
      // Success: AuthProvider sets the session and App.tsx swaps in the workspace.
    } finally {
      setBusy(false)
    }
  }, [auth, busy, clearDeepLinkError, email, password])

  const onProvider = useCallback(
    async (provider: 'apple' | 'google') => {
      if (busy) return
      setMsg(null)
      setBusy(true)
      try {
        const { error } =
          provider === 'apple' ? await auth.signInWithApple() : await auth.signInWithGoogle()
        if (error) setMsg({ kind: 'err', text: error })
      } finally {
        // The browser handoff has been launched; the session arrives via deep link.
        setBusy(false)
      }
    },
    [auth, busy],
  )

  return (
    <AuthSurface>
      <h1 className="yl-auth-title">Welcome back</h1>
      <div className="yl-auth-switch">
        <span>New to Youmi Lens?</span>
        <button type="button" style={LINK_LIKE} onClick={onGoRegister}>
          Create account
        </button>
      </div>

      <Banner msg={msg} />
      {auth.deepLinkAuthError ? (
        <div className="yl-auth-banner err">{auth.deepLinkAuthError}</div>
      ) : null}

      <SsoStack word="sign in" onProvider={(p) => void onProvider(p)} disabled={busy} />

      <div className="yl-auth-field">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          className="yl-auth-input"
          type="email"
          autoComplete="email"
          placeholder="you@university.edu"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void submit()
            }
          }}
        />
      </div>

      <div className="yl-auth-field">
        <div className="yl-auth-forgot">
          <button type="button" style={LINK_LIKE} onClick={onGoReset}>
            Forgot password?
          </button>
        </div>
        <label htmlFor="pw">Password</label>
        <PwField
          id="pw"
          value={password}
          onChange={setPassword}
          visible={showPw}
          onToggleVisible={() => setShowPw((v) => !v)}
          autoComplete="current-password"
          placeholder="••••••••"
          onEnter={() => void submit()}
        />
        <FieldError text={fieldErr} />
      </div>

      <button
        type="button"
        className="yl-auth-primary"
        aria-busy={busy}
        disabled={busy}
        onClick={() => void submit()}
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </AuthSurface>
  )
}

// ── Create account ───────────────────────────────────────────────────────────
// Mirrors landing/app/register.js: form → verify → success.

type RegisterStep = 'form' | 'verify' | 'success'

function RegisterScreen({
  resend,
  onBackToSignIn,
}: {
  resend: ResendController
  onBackToSignIn: (flash?: string) => void
}) {
  const auth = useAuth()
  const [step, setStep] = useState<RegisterStep>('form')
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [showPw, setShowPw] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<BannerMsg>(null)
  const [formErr, setFormErr] = useState<string | null>(null)
  const [usernameErr, setUsernameErr] = useState<string | null>(null)
  const [codeErr, setCodeErr] = useState<string | null>(null)
  /** Rendered as a "Sign in instead" affordance, like the Website's info banner link. */
  const [emailTaken, setEmailTaken] = useState(false)

  /** Same providers, same order, same handling as the sign-in screen and the Website. */
  const onProvider = useCallback(
    async (provider: 'apple' | 'google') => {
      if (busy) return
      setMsg(null)
      setBusy(true)
      try {
        const { error } =
          provider === 'apple' ? await auth.signInWithApple() : await auth.signInWithGoogle()
        if (error) setMsg({ kind: 'err', text: error })
      } finally {
        setBusy(false)
      }
    },
    [auth, busy],
  )

  const onCreate = useCallback(async () => {
    if (busy) return
    setMsg(null)
    setFormErr(null)
    setUsernameErr(null)
    setEmailTaken(false)

    const trimmedEmail = email.trim()
    // Validation order copied from the Website.
    if (!EMAIL_RE.test(trimmedEmail)) {
      setFormErr('Enter a valid email address.')
      return
    }
    const uname = validateUsername(username)
    if (!uname.ok) {
      setUsernameErr(uname.message)
      return
    }
    if (password.length < 8) {
      setFormErr('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setFormErr('Passwords don’t match.')
      return
    }
    if (!agreed) {
      setFormErr('Please accept the Terms and Privacy Policy.')
      return
    }

    setBusy(true)
    try {
      // Advisory pre-check — a failure here never blocks signup (send-signup-code
      // remains the authority and returns email_exists).
      const chk = await auth.checkEmail(trimmedEmail)
      if (chk.ok && chk.exists && chk.status === 'registered') {
        setEmailTaken(true)
        setMsg({
          kind: 'info',
          text: 'That email already has a Youmi Lens account. Sign in instead.',
        })
        return
      }

      const sent = await auth.requestSignupCode({ email: trimmedEmail, username: uname.value })
      if (sent.error) {
        if (sent.code === 'username_taken') {
          setUsernameErr(sent.error)
          return
        }
        if (sent.code === 'email_exists') {
          setEmailTaken(true)
          setMsg({
            kind: 'info',
            text: 'That email already has a Youmi Lens account. Sign in instead.',
          })
          return
        }
        setMsg({ kind: 'err', text: sent.error })
        return
      }
      setEmail(trimmedEmail)
      setUsername(uname.value)
      setCode('')
      setCodeErr(null)
      setStep('verify')
    } finally {
      setBusy(false)
    }
  }, [agreed, auth, busy, confirm, email, password, username])

  const onVerify = useCallback(async () => {
    if (busy) return
    setMsg(null)
    setCodeErr(null)
    const cleaned = code.replace(/\s/g, '')
    if (!/^\d{8}$/.test(cleaned)) {
      setCodeErr('Enter the full 8-digit code.')
      return
    }
    setBusy(true)
    try {
      const verified = await auth.verifySignupCodeAndCreateUser({
        email,
        username,
        password,
        code: cleaned,
      })
      if (verified.error) {
        if (verified.code === 'username_taken') {
          // Lost the race — no account was created. Back to the form, values kept.
          // The cooldown belongs to a code that is now void, so release it.
          resend.reset()
          setStep('form')
          setUsernameErr(verified.error)
          return
        }
        if (verified.code === 'email_exists') {
          resend.reset()
          setStep('form')
          setEmailTaken(true)
          setMsg({
            kind: 'info',
            text: 'That email already has a Youmi Lens account. Sign in instead.',
          })
          return
        }
        setMsg({ kind: 'err', text: verified.error })
        return
      }
      // The backend never returns a session — establish one, exactly like the Website.
      const signedIn = await auth.signInWithPassword(email, password)
      if (signedIn.error) {
        // The account DOES exist now; guide the user rather than stranding them.
        onBackToSignIn('Account created. Please sign in with your email and password.')
        return
      }
      // Session established. App.tsx swaps in the workspace on the next render, so
      // this success state is momentary — it mirrors the Website, whose onAuthChange
      // redirect to /account/ also outruns its success page.
      setStep('success')
    } finally {
      setBusy(false)
    }
  }, [auth, busy, code, email, onBackToSignIn, password, resend, username])

  if (step === 'success') {
    return (
      <AuthSurface>
        <div className="yl-auth-center">
          <div className="yl-auth-icon ok">✓</div>
          <h1 className="yl-auth-title">You’re all set</h1>
          <p className="yl-auth-lede">
            Your Youmi Lens account is ready. You’re on <strong>Free Beta</strong> — upgrade to
            Student Basic anytime.
          </p>
          <button
            type="button"
            className="yl-auth-primary"
            onClick={() => onBackToSignIn()}
          >
            Continue to Youmi Lens
          </button>
        </div>
      </AuthSurface>
    )
  }

  if (step === 'verify') {
    return (
      <AuthSurface>
        <div className="yl-auth-center">
          <div className="yl-auth-icon">✉️</div>
          <h1 className="yl-auth-title">Verify your email</h1>
          <p className="yl-auth-lede">
            We emailed an 8-digit code to <strong>{email}</strong>. Enter it to finish creating your
            account.
          </p>
        </div>

        <Banner msg={msg} />

        <div className="yl-auth-field">
          <label htmlFor="code">8-digit verification code</label>
          <input
            id="code"
            className="yl-auth-input yl-auth-code"
            inputMode="numeric"
            maxLength={8}
            placeholder="••••••••"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\s/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void onVerify()
              }
            }}
          />
          <FieldError text={codeErr} />
        </div>

        <button
          type="button"
          className="yl-auth-primary"
          aria-busy={busy}
          disabled={busy}
          onClick={() => void onVerify()}
        >
          {busy ? 'Verifying…' : 'Verify & create account'}
        </button>

        <ResendControls
          controller={resend}
          onSend={async () => {
            const r = await auth.requestSignupCode({ email, username })
            return { ok: !r.error, message: r.error }
          }}
          onChangeEmail={() => {
            resend.reset()
            setMsg(null)
            setCodeErr(null)
            setStep('form')
          }}
        />
      </AuthSurface>
    )
  }

  return (
    <AuthSurface>
      <h1 className="yl-auth-title">Create your account</h1>
      <div className="yl-auth-switch">
        <span>Already have an account?</span>
        <button type="button" style={LINK_LIKE} onClick={() => onBackToSignIn()}>
          Sign in
        </button>
      </div>

      <Banner msg={msg} />
      {emailTaken ? (
        <button
          type="button"
          className="yl-auth-back"
          style={{ marginTop: 0 }}
          onClick={() => onBackToSignIn()}
        >
          Sign in instead
        </button>
      ) : null}

      <SsoStack word="sign up" onProvider={(p) => void onProvider(p)} disabled={busy} />

      <div className="yl-auth-field">
        <label htmlFor="reg-email">Email</label>
        <input
          id="reg-email"
          className="yl-auth-input"
          type="email"
          autoComplete="email"
          placeholder="you@university.edu"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div className="yl-auth-field">
        <label htmlFor="uname">Username</label>
        <input
          id="uname"
          className="yl-auth-input"
          type="text"
          autoComplete="nickname"
          placeholder="How you want to be greeted"
          maxLength={USERNAME_MAX_LENGTH}
          aria-describedby="uname-hint"
          aria-invalid={usernameErr ? 'true' : 'false'}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <p className="yl-auth-hint" id="uname-hint">
          {USERNAME_MIN_LENGTH}–{USERNAME_MAX_LENGTH} characters.
        </p>
        <FieldError text={usernameErr} />
      </div>

      <div className="yl-auth-field">
        <label htmlFor="reg-pw">Password</label>
        <PwField
          id="reg-pw"
          value={password}
          onChange={setPassword}
          visible={showPw}
          onToggleVisible={() => setShowPw((v) => !v)}
          autoComplete="new-password"
          placeholder="Create a password"
        />
        <p className="yl-auth-hint">We’ll email a verification code to confirm your address.</p>
      </div>

      <div className="yl-auth-field">
        <label htmlFor="reg-cf">Confirm password</label>
        <PwField
          id="reg-cf"
          value={confirm}
          onChange={setConfirm}
          visible={showPw}
          onToggleVisible={() => setShowPw((v) => !v)}
          autoComplete="new-password"
          placeholder="Re-enter password"
          onEnter={() => void onCreate()}
        />
      </div>

      <label className="yl-auth-terms">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span>
          I agree to the{' '}
          <a
            href={TERMS_URL}
            onClick={(e) => {
              e.preventDefault()
              void openExternalUrl(TERMS_URL)
            }}
          >
            Terms
          </a>{' '}
          and{' '}
          <a
            href={PRIVACY_URL}
            onClick={(e) => {
              e.preventDefault()
              void openExternalUrl(PRIVACY_URL)
            }}
          >
            Privacy Policy
          </a>
          .
        </span>
      </label>

      <FieldError text={formErr} />

      <button
        type="button"
        className="yl-auth-primary"
        aria-busy={busy}
        disabled={busy}
        onClick={() => void onCreate()}
      >
        {busy ? 'Sending code…' : 'Create account'}
      </button>
    </AuthSurface>
  )
}

// ── Reset password ───────────────────────────────────────────────────────────
// Mirrors landing/app/forgot.js: email → code → password → done.

type ResetStep = 'email' | 'code' | 'password' | 'done'

function ResetScreen({
  resend,
  onClaimView,
  onBackToSignIn,
}: {
  resend: ResendController
  /** Pin the parent to this flow so the final confirmation survives the sign-out. */
  onClaimView: () => void
  onBackToSignIn: (flash?: string) => void
}) {
  const auth = useAuth()
  const [step, setStep] = useState<ResetStep>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<BannerMsg>(null)
  const [fieldErr, setFieldErr] = useState<string | null>(null)

  /**
   * A live recovery session always means "set your new password" — that is the
   * Website's /reset-password/ landing route. Derived, not pushed through an effect,
   * so a recovery deep link can never render the email step for a frame.
   *
   * `done` wins so a failed sign-out (which would leave inPasswordRecovery true)
   * cannot bounce the user back into the form after they have already succeeded.
   */
  const activeStep: ResetStep =
    step === 'done' ? 'done' : auth.inPasswordRecovery ? 'password' : step

  const sendCode = useCallback(async () => {
    if (busy) return
    setMsg(null)
    setFieldErr(null)
    const trimmed = email.trim()
    if (!EMAIL_RE.test(trimmed)) {
      setFieldErr('Enter a valid email address.')
      return
    }
    setBusy(true)
    try {
      const { error } = await auth.requestPasswordResetCode(trimmed)
      // A genuine send failure must NOT advance — otherwise the user waits for a
      // code that was never sent. A non-existent account still resolves without
      // error, so this stays enumeration-safe.
      if (error) {
        setMsg({ kind: 'err', text: error })
        return
      }
      setEmail(trimmed)
      setCode('')
      setStep('code')
    } finally {
      setBusy(false)
    }
  }, [auth, busy, email])

  const verifyCode = useCallback(async () => {
    if (busy) return
    setMsg(null)
    setFieldErr(null)
    const cleaned = code.replace(/\s/g, '')
    if (!cleaned) {
      setFieldErr('Enter the verification code.')
      return
    }
    setBusy(true)
    try {
      const { error } = await auth.verifyPasswordResetCode(email, cleaned)
      if (error) {
        setMsg({ kind: 'err', text: error })
        return
      }
      setStep('password')
    } finally {
      setBusy(false)
    }
  }, [auth, busy, code, email])

  const updatePassword = useCallback(async () => {
    if (busy) return
    setMsg(null)
    setFieldErr(null)
    if (password.length < 8) {
      setFieldErr('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setFieldErr('Passwords don’t match.')
      return
    }
    setBusy(true)
    try {
      const { error } = await auth.updatePassword(password)
      if (error) {
        setMsg({ kind: 'err', text: error })
        return
      }
      // Pin the parent BEFORE signing out: signOut clears inPasswordRecovery, and
      // without this the deep-link entry path would fall straight back to sign-in
      // instead of showing the confirmation.
      onClaimView()
      // Clear the recovery session so the user must sign in with the new password.
      try {
        await auth.signOut()
      } catch {
        /* a failed signOut must not block the confirmation */
      }
      setStep('done')
    } finally {
      setBusy(false)
    }
  }, [auth, busy, confirm, onClaimView, password])

  if (activeStep === 'done') {
    return (
      <AuthSurface>
        <div className="yl-auth-center">
          <div className="yl-auth-icon ok">✓</div>
          <h1 className="yl-auth-title">Password updated</h1>
          <p className="yl-auth-lede">
            Your password has been changed. Sign in with your new password.
          </p>
          <button type="button" className="yl-auth-primary" onClick={() => onBackToSignIn()}>
            Go to sign in
          </button>
        </div>
      </AuthSurface>
    )
  }

  if (activeStep === 'password') {
    return (
      <AuthSurface>
        <h1 className="yl-auth-title">Set a new password</h1>
        <p className="yl-auth-lede">Choose a new password for your Youmi Lens account.</p>
        <Banner msg={msg} />

        <div className="yl-auth-field">
          <label htmlFor="new-pw">New password</label>
          <PwField
            id="new-pw"
            value={password}
            onChange={setPassword}
            visible={showPw}
            onToggleVisible={() => setShowPw((v) => !v)}
            autoComplete="new-password"
            placeholder="New password"
          />
        </div>
        <div className="yl-auth-field">
          <label htmlFor="new-cf">Confirm password</label>
          <PwField
            id="new-cf"
            value={confirm}
            onChange={setConfirm}
            visible={showPw}
            onToggleVisible={() => setShowPw((v) => !v)}
            autoComplete="new-password"
            placeholder="Re-enter new password"
            onEnter={() => void updatePassword()}
          />
          <FieldError text={fieldErr} />
        </div>

        <button
          type="button"
          className="yl-auth-primary"
          aria-busy={busy}
          disabled={busy}
          onClick={() => void updatePassword()}
        >
          {busy ? 'Updating…' : 'Update password'}
        </button>
      </AuthSurface>
    )
  }

  if (activeStep === 'code') {
    return (
      <AuthSurface>
        <div className="yl-auth-center">
          <div className="yl-auth-icon">✉️</div>
          <h1 className="yl-auth-title">Enter your code</h1>
          <p className="yl-auth-lede">
            We emailed a reset code to <strong>{email}</strong>. Enter it to continue.
          </p>
        </div>

        <Banner msg={msg} />

        <div className="yl-auth-field">
          <label htmlFor="reset-code">Reset code</label>
          <input
            id="reset-code"
            className="yl-auth-input yl-auth-code"
            inputMode="numeric"
            maxLength={8}
            placeholder="••••••••"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\s/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void verifyCode()
              }
            }}
          />
          <FieldError text={fieldErr} />
        </div>

        <button
          type="button"
          className="yl-auth-primary"
          aria-busy={busy}
          disabled={busy}
          onClick={() => void verifyCode()}
        >
          {busy ? 'Verifying…' : 'Verify code'}
        </button>

        <ResendControls
          controller={resend}
          onSend={async () => {
            const r = await auth.requestPasswordResetCode(email)
            return { ok: !r.error, message: r.error }
          }}
          onChangeEmail={() => {
            resend.reset()
            setMsg(null)
            setFieldErr(null)
            setStep('email')
          }}
        />
      </AuthSurface>
    )
  }

  return (
    <AuthSurface>
      <h1 className="yl-auth-title">Reset password</h1>
      <p className="yl-auth-lede">Enter your account email and we’ll send a reset code.</p>
      <Banner msg={msg} />

      <div className="yl-auth-field">
        <label htmlFor="reset-email">Email</label>
        <input
          id="reset-email"
          className="yl-auth-input"
          type="email"
          autoComplete="email"
          placeholder="you@university.edu"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void sendCode()
            }
          }}
        />
        <FieldError text={fieldErr} />
      </div>

      <button
        type="button"
        className="yl-auth-primary"
        aria-busy={busy}
        disabled={busy}
        onClick={() => void sendCode()}
      >
        {busy ? 'Sending…' : 'Send reset code'}
      </button>

      <button type="button" className="yl-auth-back" onClick={() => onBackToSignIn()}>
        Back to sign in
      </button>
    </AuthSurface>
  )
}
