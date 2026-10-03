import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import { createServer } from 'node:http'
import { handleProcessRecording } from './processRecording.mjs'
import * as youmiHosted from './ai/hosted/youmiHosted.mjs'
import {
  handleHostedSummarize,
  handleHostedTranslateCaption,
  handleHostedTranscribe,
  hostedUpload,
} from './ai/hostedHttp.mjs'
import { handleLiveTranscribeFromUrl } from './liveTranscribeFromUrl.mjs'
import {
  byokTranscribeMiddleware,
  handleByokSummarize,
  handleByokTranscribe,
  handleByokTranslateCaption,
} from './ai/byok/http.mjs'
import { attachLiveRealtimeWs } from './liveRealtimeWs.mjs'
import * as dashEnv from './dashscopeEnv.mjs'
import { audioUploadMiddleware, handleUploadAudio } from './uploadAudio.mjs'
import { handleGetLectureAudio } from './lectureAudioRoutes.mjs'
import { handleBetaUsageStatus, handleQuotaStatus } from './betaUsageStatus.mjs'
import { handleAuthCheckEmail } from './authCheckEmail.mjs'
import { handleSendSignupCode, handleVerifySignupCodeAndCreateUser } from './authSignupCode.mjs'
import {
  handleAppleNotifications,
  handleIapEntitlement,
  handleIapRestore,
  handleSubscriptionAvailability,
  handleSubscriptionPurchaseAuthorization,
  handleIapVerify,
} from './iapRoutes.mjs'
import { handleDeleteAccount } from './accountRoutes.mjs'
import { handleAdminWatchAccess } from './adminWatchAccess.mjs'
import {
  handleWatchAlerts,
  handleWatchCosts,
  handleWatchLogs,
  handleWatchOverview,
  handleWatchProviders,
  handleWatchSettings,
} from './watchRead.mjs'
import { handleWatchSnapshotsRefresh } from './watchSnapshots.mjs'
import {
  handleCheckout,
  handlePortal,
  handleSubscriptionStatus,
  handleSubscriptionRefresh,
  handleStripeWebhookRoute,
} from './stripeRoutes.mjs'

const PORT = Number(process.env.PORT || process.env.AI_SERVER_PORT || 3847)

if (process.env.YOUMI_TRANSCRIBE_FORCE_TEST === '1') {
  console.warn(
    '[live-latency] WARNING: YOUMI_TRANSCRIBE_FORCE_TEST=1 — POST /api/transcribe returns stub text; do not use for realtime latency benchmarks.',
  )
}

const app = express()
app.use(cors({ origin: true, credentials: true }))

// Stripe webhook MUST read the raw request body for signature verification, so
// it is registered BEFORE the global JSON parser (which would consume the body).
// This is the only route that bypasses express.json.
app.post(
  '/api/billing/stripe/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    void handleStripeWebhookRoute(req, res).catch((err) => {
      console.error('[stripe-webhook]', err)
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: 'webhook_processing_failed' })
      }
    })
  },
)

app.use(express.json({ limit: '2mb' }))

function present(v) {
  return v ? 'present' : 'missing'
}

function envDiagnostics() {
  const hostedEnv = youmiHosted.hostedEnvDiagnostics()
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const supabaseAnon = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
  return {
    DASHSCOPE_API_KEY: present(hostedEnv.DASHSCOPE_API_KEY),
    DASHSCOPE_OVERSEAS_API_KEY: present(hostedEnv.DASHSCOPE_OVERSEAS_API_KEY),
    DEEPGRAM_API_KEY: present(Boolean(process.env.DEEPGRAM_API_KEY?.trim())),
    OPENAI_API_KEY: present(hostedEnv.OPENAI_API_KEY),
    SUPABASE_URL_or_VITE_SUPABASE_URL: present(Boolean(supabaseUrl)),
    SUPABASE_ANON_KEY_or_VITE_SUPABASE_ANON_KEY: present(Boolean(supabaseAnon)),
    SUPABASE_SERVICE_ROLE_KEY: present(Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim())),
    APPLE_IAP_PRIVATE_KEY: present(Boolean(process.env.APPLE_IAP_PRIVATE_KEY?.trim())),
    APPLE_IAP_KEY_ID: present(Boolean(process.env.APPLE_IAP_KEY_ID?.trim())),
    APPLE_IAP_ISSUER_ID: present(Boolean(process.env.APPLE_IAP_ISSUER_ID?.trim())),
    APPLE_BUNDLE_ID: present(Boolean(process.env.APPLE_BUNDLE_ID?.trim())),
    APPLE_APP_APPLE_ID: present(Boolean(process.env.APPLE_APP_APPLE_ID?.trim())),
    APPLE_IAP_ENVIRONMENT: process.env.APPLE_IAP_ENVIRONMENT || 'Sandbox',
    APPLE_IAP_ROOT_CERTIFICATES: present(
      Boolean(
        process.env.APPLE_IAP_ROOT_CERTIFICATE_PATHS?.trim() ||
          process.env.APPLE_IAP_ROOT_CERTIFICATES_BASE64?.trim(),
      ),
    ),
    ENABLE_STUB_AI: hostedEnv.ENABLE_STUB_AI ? 'enabled' : 'disabled',
  }
}

function runtimeModeSummary() {
  const hostedEnv = youmiHosted.hostedEnvDiagnostics()
  return {
    hostedAdapterId: youmiHosted.HOSTED_ADAPTER_ID || 'unknown',
    hostedRuntimeMode: youmiHosted.hostedRuntimeMode(),
    hostedTranscribeImpl: process.env.YUMI_HOSTED_TRANSCRIBE_IMPL || 'default',
    productAiModeFlag: process.env.VITE_PRODUCT_AI_MODE || 'unset',
    hostedChatModel: hostedEnv.YUMI_QWEN_CHAT_MODEL,
    hostedTranscribeModel: hostedEnv.YUMI_PARAFORMER_MODEL,
    stubAiEnabled: hostedEnv.ENABLE_STUB_AI === true,
  }
}

function liveRealtimeAsrSummary() {
  const exp = (process.env.YOUMI_LIVE_ASR_EXPERIMENT || '').trim().toLowerCase()
  const provider =
    exp === 'volcengine' || exp === 'volc' || exp === 'vol'
      ? 'volcengine'
      : exp === 'deepgram' || exp === 'deep'
        ? 'deepgram'
        : 'dashscope'
  if (provider === 'volcengine') {
    const ok =
      Boolean(process.env.VOLCENGINE_ASR_APP_KEY?.trim()) &&
      Boolean(process.env.VOLCENGINE_ASR_ACCESS_KEY?.trim())
    return { provider, ready: ok }
  }
  if (provider === 'deepgram') {
    return {
      provider,
      ready: Boolean(process.env.DEEPGRAM_API_KEY?.trim()),
      deepgramConfigured: Boolean(process.env.DEEPGRAM_API_KEY?.trim()),
      liveRealtimeEnabled: true,
    }
  }
  return {
    provider,
    ready: Boolean(dashEnv.getDashScopeEffectiveKey()),
    deepgramConfigured: Boolean(process.env.DEEPGRAM_API_KEY?.trim()),
    liveRealtimeEnabled: true,
  }
}

app.get('/api/health', (_req, res) => {
  const hosted = youmiHosted.hostedCapabilities()
  const env = envDiagnostics()
  const mode = runtimeModeSummary()
  const postClassTranscript = Boolean(hosted.transcribe && hosted.summarize)
  const postClassReady = Boolean(hosted.transcribe && hosted.summarize && hosted.translate)
  const liveRt = liveRealtimeAsrSummary()
  res.json({
    ok: true,
    youmiAi: {
      /** V1: full recording upload + post-class transcription + summaries is the primary product path. */
      product: {
        v1PrimaryFlow: 'post_class_transcript',
        liveCaptions: 'beta_preview',
      },
      ready: postClassReady,
      /** After-class transcript + bilingual summaries (process-recording / generate). */
      postClassTranscript,
      /** Near–real-time live captions (beta); same keys as DashScope but not required for V1 readiness. */
      liveCaptions: Boolean(hosted.liveCaptions),
      providerReadiness: {
        dashscope: {
          configured: Boolean(dashEnv.getDashScopeEffectiveKey()),
          region: dashEnv.getDashScopeEffectiveRegion(),
          keySource: dashEnv.getDashScopeKeySource(),
        },
        openaiFallback: {
          configured: Boolean(process.env.OPENAI_API_KEY?.trim()),
        },
        deepgram: {
          configured: Boolean(process.env.DEEPGRAM_API_KEY?.trim()),
        },
        postClass: {
          transcribe: Boolean(hosted.transcribe),
          summarize: Boolean(hosted.summarize),
          translate: Boolean(hosted.translate),
          ready: postClassTranscript,
        },
        liveRealtimeAsr: liveRt,
        liveTranslation: {
          enabled: process.env.YOUMI_LIVE_TRANSLATION_EXPERIMENT === 'enabled',
          envValuePresent: Boolean(process.env.YOUMI_LIVE_TRANSLATION_EXPERIMENT),
          providerReady: Boolean(hosted.translate),
        },
      },
      capabilities: {
        ...hosted,
        postClassTranscript,
      },
      mode,
      env,
    },
  })
})

app.post('/api/auth/check-email', (req, res) => {
  void handleAuthCheckEmail(req, res)
})

app.post('/api/auth/send-signup-code', (req, res) => {
  void handleSendSignupCode(req, res).catch((err) => {
    console.error('[send-signup-code]', err)
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'server_error', message: 'Account creation is temporarily unavailable.' })
    }
  })
})

app.post('/api/auth/verify-signup-code-and-create-user', (req, res) => {
  void handleVerifySignupCodeAndCreateUser(req, res).catch((err) => {
    console.error('[verify-signup-code]', err)
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'server_error', message: 'Account creation is temporarily unavailable.' })
    }
  })
})

app.delete('/api/account', (req, res) => {
  void handleDeleteAccount(req, res).catch((err) => {
    console.error('[account-delete]', err)
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'account_delete_failed', message: 'Could not delete account.' })
    }
  })
})

app.get('/api/beta-usage-status', (req, res) => {
  void handleBetaUsageStatus(req, res).catch((err) => {
    console.error('[beta-usage-status]', err)
    if (!res.headersSent) {
      res.status(500).json({ error: 'beta_usage_status_failed', message: 'Could not load beta usage status.' })
    }
  })
})

app.get('/api/quota/status', (req, res) => {
  void handleQuotaStatus(req, res).catch((err) => {
    console.error('[quota-status]', err)
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'quota_status_failed', message: 'Could not load plan information.' })
    }
  })
})

/** Internal Youmi Watch admin gate. Server-verified; fails closed on error. */
app.get('/api/admin/watch/access', (req, res) => {
  void handleAdminWatchAccess(req, res).catch((err) => {
    console.error('[admin-watch-access]', err)
    if (!res.headersSent) {
      res.status(200).json({ ok: false, authorized: false, reason: 'error' })
    }
  })
})

// ── Internal Youmi Watch read endpoints (Phase 3) ─────────────────────────────
// Read-only, admin/developer-verified, aggregated data from the watch_* tables
// with mock fallback. No provider APIs, no secrets, no writes.
const watchReadRoutes = [
  ['/api/admin/watch/overview', handleWatchOverview],
  ['/api/admin/watch/providers', handleWatchProviders],
  ['/api/admin/watch/alerts', handleWatchAlerts],
  ['/api/admin/watch/costs', handleWatchCosts],
  ['/api/admin/watch/logs', handleWatchLogs],
  ['/api/admin/watch/settings', handleWatchSettings],
]
for (const [path, handler] of watchReadRoutes) {
  app.get(path, (req, res) => {
    void handler(req, res).catch((err) => {
      console.error(`[watch-read] ${path}`, err)
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: 'watch_read_failed' })
      }
    })
  })
}

// Admin-triggered provider snapshot refresh (Phase 5D-1). Self-probes only —
// no external provider APIs. Cooldown + in-flight guarded; sanitized summary.
app.post('/api/admin/watch/snapshots/refresh', (req, res) => {
  void handleWatchSnapshotsRefresh(req, res).catch((err) => {
    console.error('[watch-snapshots]', err)
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'snapshot_refresh_failed' })
    }
  })
})

app.get('/api/iap/subscriptions/availability', handleSubscriptionAvailability)
app.post('/api/iap/subscriptions/authorize', handleSubscriptionPurchaseAuthorization)

// Primary Student Pass verification endpoint.
app.post('/api/iap/apple/verify', (req, res) => {
  void handleIapVerify(req, res).catch((err) => {
    console.error('[iap-verify]', err)
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'iap_verify_failed', message: 'Could not verify purchase.' })
    }
  })
})

// Legacy alias (kept temporarily for older client builds). Same handler.
app.post('/api/iap/verify', (req, res) => {
  void handleIapVerify(req, res).catch((err) => {
    console.error('[iap-verify]', err)
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'iap_verify_failed', message: 'Could not verify purchase.' })
    }
  })
})

app.get('/api/iap/entitlement', (req, res) => {
  void handleIapEntitlement(req, res).catch((err) => {
    console.error('[iap-entitlement]', err)
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'iap_entitlement_failed', message: 'Could not load entitlement.' })
    }
  })
})

app.post('/api/iap/restore', (req, res) => {
  void handleIapRestore(req, res).catch((err) => {
    console.error('[iap-restore]', err)
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'iap_restore_failed', message: 'Could not restore purchases.' })
    }
  })
})

// App Store Server Notifications V2 (Apple → server; JWS-authenticated, no JWT).
app.post('/api/iap/apple/notifications', (req, res) => {
  void handleAppleNotifications(req, res).catch((err) => {
    console.error('[iap-notifications]', err)
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'notification_processing_failed' })
    }
  })
})

// ── Desktop Stripe billing (Website checkout + Mac/Windows read-only status) ──
app.post('/api/billing/checkout', (req, res) => {
  void handleCheckout(req, res).catch((err) => {
    console.error('[billing-checkout]', err)
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'checkout_failed', message: 'Could not start checkout.' })
    }
  })
})

app.post('/api/billing/portal', (req, res) => {
  void handlePortal(req, res).catch((err) => {
    console.error('[billing-portal]', err)
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'portal_failed', message: 'Could not open the billing portal.' })
    }
  })
})

app.get('/api/subscription/status', (req, res) => {
  void handleSubscriptionStatus(req, res).catch((err) => {
    console.error('[subscription-status]', err)
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'subscription_status_failed', message: 'Could not load subscription.' })
    }
  })
})

app.post('/api/subscription/refresh', (req, res) => {
  void handleSubscriptionRefresh(req, res).catch((err) => {
    console.error('[subscription-refresh]', err)
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'subscription_refresh_failed', message: 'Could not refresh subscription.' })
    }
  })
})

app.post('/api/transcribe', hostedUpload.single('file'), (req, res) => {
  void handleHostedTranscribe(req, res)
})

/** Live captions: client uploads slice to Storage, passes signed GET URL; server runs Paraformer. */
app.post('/api/live-transcribe-url', (req, res) => {
  void handleLiveTranscribeFromUrl(req, res)
})

app.post('/api/summarize', (req, res) => {
  void handleHostedSummarize(req, res)
})

app.post('/api/translate-caption', (req, res) => {
  void handleHostedTranslateCaption(req, res)
})

app.post('/api/byok/transcribe', byokTranscribeMiddleware, (req, res) => {
  void handleByokTranscribe(req, res)
})

app.post('/api/byok/summarize', (req, res) => {
  void handleByokSummarize(req, res)
})

app.post('/api/byok/translate-caption', (req, res) => {
  void handleByokTranslateCaption(req, res)
})

/** Proxy audio upload from Tauri WKWebView → Railway → Supabase Storage (avoids WKWebView binary fetch instability). */
app.post('/api/upload-audio', audioUploadMiddleware, (req, res) => {
  void handleUploadAudio(req, res)
})

// Cloud Library — authenticated audio retrieval for any client holding a
// Lecture ID (Mac/Windows/second iPad). Ownership-scoped, returns a short-lived
// signed URL. See server/lectureAudioRoutes.mjs.
app.get('/api/lectures/:id/audio', (req, res) => {
  void handleGetLectureAudio(req, res).catch((err) => {
    console.error('[lecture-audio]', err)
    if (!res.headersSent) res.status(500).json({ error: 'server_error' })
  })
})

app.post('/api/process-recording', express.json({ limit: '256kb' }), (req, res) => {
  void handleProcessRecording(req, res).catch((err) => {
    console.error('[process-recording]', err)
    if (!res.headersSent) {
      res.status(500).json({ error: 'Youmi AI is temporarily unavailable.' })
    }
  })
})

// ── Tauri auth bridge ─────────────────────────────────────────────────────────
// Supabase magic-link / OAuth redirects here from the email client (HTTPS, always
// allowed by email clients and Supabase). The page forwards query + hash to the
// lecturecompanion:// custom scheme so the desktop app receives the deep link.
//
// Add to Supabase → Authentication → URL Configuration → Redirect URLs:
//   https://youmi-lens-production.up.railway.app/tauri-auth-callback
app.get('/tauri-auth-callback', (_req, res) => {
  // Supabase magic-link redirects here after verifying the token. This page uses
  // client-side JS to forward the callback to the lecturecompanion:// scheme.
  //
  // Two token delivery formats are handled:
  //   PKCE flow:    /tauri-auth-callback?code=...         (params in query string)
  //   Implicit flow: /tauri-auth-callback#access_token=... (params in hash — server cannot read)
  //
  // The server never sees or logs hash fragment tokens.
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Opening Youmi Lens\u2026</title></head>
<body style="font-family:system-ui,sans-serif;color:#333;margin:0;padding:2rem">
<p>Opening Youmi Lens\u2026</p>
<p id="fb" style="color:#888;display:none">If nothing happens, open Youmi Lens and request a new sign-in link.</p>
<script>
(function () {
  // Build the deep-link target using query string (PKCE) and/or hash (implicit tokens).
  // Tokens stay in the browser — this script never sends them to any server.
  var target = 'lecturecompanion://auth-callback' + window.location.search + window.location.hash;
  window.location.replace(target);
  setTimeout(function () {
    var fb = document.getElementById('fb');
    if (fb) fb.style.display = '';
  }, 2500);
})();
</script>
</body>
</html>`)
})

const server = createServer(app)
attachLiveRealtimeWs(server)

server.listen(PORT, '0.0.0.0', () => {
  const marker = process.env.YOUMI_DEPLOY_MARKER || 'dev'
  console.log(`Youmi AI server on http://127.0.0.1:${PORT}`)
  console.log(`[youmi-ai/version] marker=${marker}`)
  const hosted = youmiHosted.hostedCapabilities()
  const env = envDiagnostics()
  const mode = runtimeModeSummary()
  console.log(
    `[youmi-ai/diag] DASHSCOPE_API_KEY=${env.DASHSCOPE_API_KEY} DASHSCOPE_OVERSEAS_API_KEY=${env.DASHSCOPE_OVERSEAS_API_KEY} OPENAI_API_KEY=${env.OPENAI_API_KEY} SUPABASE_URL=${env.SUPABASE_URL_or_VITE_SUPABASE_URL} SUPABASE_ANON_KEY=${env.SUPABASE_ANON_KEY_or_VITE_SUPABASE_ANON_KEY} SUPABASE_SERVICE_ROLE_KEY=${env.SUPABASE_SERVICE_ROLE_KEY} APPLE_IAP=${env.APPLE_IAP_PRIVATE_KEY}/${env.APPLE_IAP_KEY_ID}/${env.APPLE_IAP_ISSUER_ID}/${env.APPLE_BUNDLE_ID}/${env.APPLE_IAP_ROOT_CERTIFICATES}`,
  )
  console.log(
    `[youmi-ai/diag] adapter=${mode.hostedAdapterId} transcribeImpl=${mode.hostedTranscribeImpl} productAiMode=${mode.productAiModeFlag} capabilities=${JSON.stringify(hosted)}`,
  )
})
