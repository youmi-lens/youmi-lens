/**
 * The Desktop production guard.
 *
 * What it exists to catch: the acceptance gate that STOPPED before any
 * cross-device testing began, because `.env` and `.env.production` in this
 * repo carry the SAME project ref — a QA build with no staging override
 * quietly inherits production rather than erroring. Every test below is
 * written so it fails against that silent-fallback shape.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  assertDesktopSupabaseTargetSafe,
  DesktopProductionGuardError,
  isProductionSupabaseUrl,
  PRODUCTION_SUPABASE_REF,
} from './productionGuard'

// Hardcoded literally, NOT built from the imported constant: if the module's
// own constant were ever truncated or typo'd, deriving the test URL from it
// would truncate right along with it and the test would keep passing against
// a guard that no longer recognises the real project.
const PRODUCTION_URL = 'https://lbwsrnjbiayepshrdult.supabase.co'
const STAGING_URL = 'https://keozbnzainrcuiwhmjae.supabase.co'

describe('isProductionSupabaseUrl', () => {
  it('the exported ref constant is the real, undamaged production project ref', () => {
    expect(PRODUCTION_SUPABASE_REF).toBe('lbwsrnjbiayepshrdult')
  })

  it('recognises the production project ref', () => {
    expect(isProductionSupabaseUrl(PRODUCTION_URL)).toBe(true)
  })

  it('does not flag staging', () => {
    expect(isProductionSupabaseUrl(STAGING_URL)).toBe(false)
  })

  it('is false for absent, empty or malformed values, never throws', () => {
    for (const bad of [undefined, null, '', 'not-a-url']) {
      expect(isProductionSupabaseUrl(bad)).toBe(false)
    }
  })

  it('matches regardless of surrounding URL shape', () => {
    // Whatever scheme or path the URL carries, the ref substring is what matters.
    expect(isProductionSupabaseUrl(`http://${PRODUCTION_SUPABASE_REF}.supabase.co/rest/v1`)).toBe(true)
  })
})

describe('THE REGRESSION · dev and QA refuse production; release is untouched', () => {
  it('a dev server pointed at production refuses to run', () => {
    expect(() => assertDesktopSupabaseTargetSafe('development', PRODUCTION_URL)).toThrow(
      DesktopProductionGuardError,
    )
  })

  it('a QA/staging build pointed at production refuses to run — the exact failure mode this fixes', () => {
    expect(() => assertDesktopSupabaseTargetSafe('qa', PRODUCTION_URL)).toThrow(
      DesktopProductionGuardError,
    )
  })

  it('any future non-production mode is checked too, not an allowlist of two names', () => {
    expect(() => assertDesktopSupabaseTargetSafe('preview', PRODUCTION_URL)).toThrow(
      DesktopProductionGuardError,
    )
  })

  it('a REAL production release build is the one exemption, and is never evaluated past the mode check', () => {
    expect(() => assertDesktopSupabaseTargetSafe('production', PRODUCTION_URL)).not.toThrow()
  })

  it('the guard never bricks a correctly-targeted build, in any mode', () => {
    expect(() => assertDesktopSupabaseTargetSafe('development', STAGING_URL)).not.toThrow()
    expect(() => assertDesktopSupabaseTargetSafe('qa', STAGING_URL)).not.toThrow()
    expect(() => assertDesktopSupabaseTargetSafe('production', PRODUCTION_URL)).not.toThrow()
  })

  it('an unconfigured URL (local-only mode) is not mistaken for production', () => {
    expect(() => assertDesktopSupabaseTargetSafe('development', undefined)).not.toThrow()
    expect(() => assertDesktopSupabaseTargetSafe('qa', '')).not.toThrow()
  })

  it('the error names the offending mode, so a misconfigured QA build says what it is', () => {
    try {
      assertDesktopSupabaseTargetSafe('qa', PRODUCTION_URL)
      throw new Error('expected assertDesktopSupabaseTargetSafe to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(DesktopProductionGuardError)
      expect((e as Error).message).toContain('"qa"')
      expect((e as Error).message).toContain(PRODUCTION_SUPABASE_REF)
    }
  })
})

describe('wired into the one place the client is actually created', () => {
  const supabaseSource = readFileSync(new URL('./supabase.ts', import.meta.url), 'utf8')

  it('getSupabase() calls the guard before createClient', () => {
    const guardAt = supabaseSource.indexOf('assertDesktopSupabaseTargetSafe(')
    const createAt = supabaseSource.indexOf('createClient(')
    expect(guardAt).toBeGreaterThan(-1)
    expect(createAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(createAt)
  })

  it('passes the real Vite mode, not a hardcoded string', () => {
    expect(supabaseSource).toContain('import.meta.env.MODE')
  })

  it('is not evaluated at module load — importing supabase.ts must never throw by itself', () => {
    const guardLine = supabaseSource.slice(0, supabaseSource.indexOf('assertDesktopSupabaseTargetSafe('))
    // The guard call sits inside getSupabase()'s body, after the function
    // signature — not at the top level of the module.
    expect(guardLine).toContain('export function getSupabase')
  })
})

describe('the staging override this guard protects', () => {
  it('.env.qa.local is gitignored — never committed, never a leak vector', () => {
    const gitignore = readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8')
    expect(gitignore).toMatch(/\.env\.\*\.local|\.env\.qa\.local/)
  })

  it('the qa build script uses a real Vite mode, not a same-mode override', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['build:qa-staging']).toContain('--mode qa')
    // A bare release build must still default to plain `production` mode —
    // adding the qa script must not have touched it.
    expect(pkg.scripts.build).not.toContain('--mode')
  })
})
