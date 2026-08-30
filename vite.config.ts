import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
const apiTarget = 'http://127.0.0.1:3847'

/** Staging Supabase project ref (`.env.qa.local`). QA builds must resolve here. */
const QA_STAGING_SUPABASE_REF = 'keozbnzainrcuiwhmjae'
/** Production Supabase project ref (`.env` / `.env.production`). QA must never resolve here. */
const PRODUCTION_SUPABASE_REF = 'lbwsrnjbiayepshrdult'

/**
 * Build-time hard guard for the `qa` staging mode.
 *
 * This is deliberately NOT the runtime guard in `src/lib/productionGuard.ts` —
 * that one only throws when `getSupabase()` is first called, i.e. after the
 * package already exists. The failure mode this guards against is a QA/staging
 * build quietly inheriting the production project (a missing or misnamed
 * override falls back to `.env`, whose `VITE_SUPABASE_URL` IS production), and
 * by the time anyone notices, a signed `.app` has already been produced.
 *
 * Refusing here means `vite build --mode qa` fails, which fails the Tauri
 * `beforeBuildCommand`, so the wrong package is never bundled.
 *
 * `mode === 'production'` (a real release) and every other mode are untouched:
 * this plugin returns without inspecting anything, so production behaviour is
 * unchanged by construction.
 */
function qaStagingTargetGuard(): Plugin {
  return {
    name: 'qa-staging-target-guard',
    config(_config, { command, mode }) {
      if (command !== 'build' || mode !== 'qa') return
      const env = loadEnv(mode, process.cwd(), '')
      const url = String(env.VITE_SUPABASE_URL ?? '').trim()
      const isStaging = url.includes(QA_STAGING_SUPABASE_REF)
      const isProduction = url.includes(PRODUCTION_SUPABASE_REF)
      if (!isStaging || isProduction) {
        throw new Error(
          `[qa-staging-guard] Refusing to build the QA frontend: Vite mode "qa" resolved ` +
            `VITE_SUPABASE_URL=${url || '(empty)'}. Expected the staging project ` +
            `(${QA_STAGING_SUPABASE_REF}) and NOT production (${PRODUCTION_SUPABASE_REF}). ` +
            `Check .env.qa.local is present and targets staging.`,
        )
      }
    },
  }
}

export default defineConfig({
  // Keeps Tauri `devUrl` (http://localhost:5173) aligned when the port is taken.
  clearScreen: false,
  plugins: [react(), qaStagingTargetGuard()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, ws: true },
    },
  },
  preview: {
    host: true,
    port: 4173,
    proxy: {
      '/api': { target: apiTarget, ws: true },
    },
  },
})
