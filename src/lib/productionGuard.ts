/**
 * Refuse to run a non-release Desktop build against the production database.
 *
 * The failure this guards against is silent, not loud: a Vite mode falls back
 * to `.env`, and `.env` in this repo happens to carry the same project ref as
 * `.env.production` — so a dev server or a QA/staging build with a missing or
 * misnamed override quietly inherits production instead of erroring. The
 * previous Cloud Library acceptance pass hit exactly this: every existing QA
 * `.app` was built from that default and pointed at production the whole time.
 *
 * The one build this must never touch is the real release: `vite build` with
 * no `--mode` flag runs in Vite's `production` mode, and production IS the
 * correct target there. `mode === 'production'` is therefore the sole
 * exemption — everything else (`development`, the `qa` staging mode, any
 * future mode) is checked.
 */

/** `youmi-lens-desktop/.env.production`, confirmed in this repo's own deploy docs. */
export const PRODUCTION_SUPABASE_REF = 'lbwsrnjbiayepshrdult'

/** True when a Supabase URL resolves to the production project, however it is formatted. */
export function isProductionSupabaseUrl(url: string | undefined | null): boolean {
  if (!url) return false
  return url.includes(PRODUCTION_SUPABASE_REF)
}

export class DesktopProductionGuardError extends Error {
  constructor(mode: string) {
    super(
      `[production-guard] refusing to run: Vite mode "${mode}" resolved a Supabase URL containing ` +
        `the PRODUCTION project ref (${PRODUCTION_SUPABASE_REF}). A development server or a QA/staging ` +
        'build must never target production. Check .env / .env.qa.local, and that VITE_SUPABASE_URL ' +
        'in the active mode actually points at staging.',
    )
    this.name = 'DesktopProductionGuardError'
  }
}

/**
 * Throws when `mode` is anything other than a real release build AND the
 * resolved URL is production. Returns silently in every other case —
 * including the release build itself, which this function does not evaluate
 * at all past the mode check, so it can never brick it.
 */
export function assertDesktopSupabaseTargetSafe(
  mode: string,
  supabaseUrl: string | undefined | null,
): void {
  if (mode === 'production') return
  if (!isProductionSupabaseUrl(supabaseUrl)) return
  throw new DesktopProductionGuardError(mode)
}

/**
 * The API/upload server has the exact same silent-inheritance failure mode as
 * Supabase above, and it caused a real one: a qa-mode build with no
 * VITE_API_BASE_URL override inherited `.env`'s production Railway URL,
 * authenticated with a STAGING-signed JWT, and failed every Save Lecture
 * upload at the server's auth check — before course linkage or transcription
 * ever ran. `vite.config.ts`'s build-time guard now also checks this; this is
 * the runtime companion, mirroring `assertDesktopSupabaseTargetSafe` exactly.
 */
export const PRODUCTION_API_BASE_URL = 'https://youmi-lens-production.up.railway.app'

export function isProductionApiBaseUrl(url: string | undefined | null): boolean {
  if (!url) return false
  return url.includes(PRODUCTION_API_BASE_URL)
}

export class DesktopApiTargetGuardError extends Error {
  constructor(mode: string) {
    super(
      `[production-guard] refusing to run: Vite mode "${mode}" resolved VITE_API_BASE_URL to the ` +
        `PRODUCTION API server (${PRODUCTION_API_BASE_URL}). A development server or a QA/staging ` +
        'build must never target production. Check .env.qa.local sets VITE_API_BASE_URL to a server ' +
        'that shares the same (staging) Supabase project as VITE_SUPABASE_URL.',
    )
    this.name = 'DesktopApiTargetGuardError'
  }
}

/** Runtime companion to `assertDesktopSupabaseTargetSafe` — same shape, same exemption. */
export function assertDesktopApiTargetSafe(mode: string, apiBaseUrl: string | undefined | null): void {
  if (mode === 'production') return
  if (!isProductionApiBaseUrl(apiBaseUrl)) return
  throw new DesktopApiTargetGuardError(mode)
}
