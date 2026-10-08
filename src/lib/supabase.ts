import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { isTauri } from '@tauri-apps/api/core'
import { assertDesktopSupabaseTargetSafe } from './productionGuard'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

let client: SupabaseClient | null = null

export function isSupabaseConfigured(): boolean {
  return Boolean(url && anon && url.length > 0 && anon.length > 0)
}

export function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured()) return null
  if (!client) {
    // Checked once, at first real use — not at module load, so importing this
    // file in a test or a tool that never calls getSupabase() never throws.
    assertDesktopSupabaseTargetSafe(import.meta.env.MODE, url)
    const desktop = typeof window !== 'undefined' && isTauri()
    client = createClient(url!, anon!, {
      auth: {
        /**
         * PKCE, not the implicit default. The OAuth callback carries an authorization code, not access/refresh tokens, and
         * only the instance holding the matching verifier can exchange it. supabase-js keeps that verifier in the default
         * storage (this build's own WebView localStorage, key `sb-<ref>-auth-token-code-verifier`), so it survives an app
         * restart (cold-start callback) and is NOT shared with other installed builds. Do not override `storage` /
         * `storageKey`: that would sign every existing user out and could share a verifier between builds.
         */
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        /** Deep-link auth uses `lecturecompanion://…`, not `window.location`; avoid init-time URL parsing fighting manual handlers. */
        detectSessionInUrl: !desktop,
      },
    })
  }
  return client
}
