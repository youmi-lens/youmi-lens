/**
 * Youmi Lens Website — PUBLIC runtime configuration.
 *
 * These three values are PUBLIC-safe (the SAME shared Supabase project + public
 * anon key + production API origin already shipped in the Desktop app bundle and
 * committed in .env.production). The anon key is RLS-protected and designed to be
 * public. NO server secret (service-role key, Stripe secret, OAuth client secret,
 * Apple private key, SMTP/Brevo secret) belongs here.
 *
 * Source: .env.production → VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / VITE_API_BASE_URL.
 * Same account identity as Desktop and iPad — no separate account system.
 */
window.YOUMI_CONFIG = {
  supabaseUrl: "https://lbwsrnjbiayepshrdult.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxid3NybmpiaWF5ZXBzaHJkdWx0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUzNjk5MjEsImV4cCI6MjA5MDk0NTkyMX0.3RDacj9feMyJBPW59cbres8fi4YLdPrbtJQUeUiVfXs", // PUBLIC anon key (RLS-protected) — NOT the service-role key
  apiBaseOrigin: "https://youmi-lens-production.up.railway.app", // client uses `${origin}/api`
  // OAuth / password-reset return targets (relative; client builds an absolute
  // same-origin URL). MUST be in the Supabase Auth "Redirect URLs" allow-list.
  authReturnPath: "/account/",
  resetReturnPath: "/reset-password/",

  // PUBLIC COMMERCIALIZATION RELEASE SWITCH — the ONE front-end authority for
  // whether Pricing / prices / Upgrade / Checkout are shown to the public.
  // Website commercialization is finished and TEST MODE verified, but Mac /
  // Windows / iPad have not caught up yet, so it stays off.
  // v0.1.10 launch: ON. Merge only after Stripe LIVE + Railway prod are set
  // (PUBLIC_COMMERCIALIZATION_ENABLED=true) and the live smoke test passes.
  //
  // FAIL-CLOSED: every commercial surface is hidden in static markup and only
  // REVEALED when this is exactly true, so a visitor with JavaScript disabled
  // never sees a price. Mirrors the backend PUBLIC_COMMERCIALIZATION_ENABLED.
  //
  // Flipping this REQUIRES bumping the ?v= cache-buster on every page that
  // loads config.js, or Cloudflare will keep serving the old value.
  // Existing subscribers keep Manage plan + Customer Portal either way.
  commercializationEnabled: true,
};

/** Public commercial surfaces are shown only when the switch is exactly true. */
window.YOUMI_CONFIG.isCommercializationEnabled = function () {
  return window.YOUMI_CONFIG.commercializationEnabled === true;
};

/**
 * Reveal elements marked `hidden data-commercial` when the switch is on.
 * Static pages ship them hidden, so "off" needs no JavaScript at all.
 */
window.YOUMI_CONFIG.applyCommercialVisibility = function (root) {
  if (!window.YOUMI_CONFIG.isCommercializationEnabled()) return;
  (root || document).querySelectorAll("[data-commercial]").forEach(function (el) {
    el.hidden = false;
  });
};

/** True only when every required public value is present for this deploy. */
window.YOUMI_CONFIG.isConfigured = function () {
  const c = window.YOUMI_CONFIG;
  return (
    typeof c.supabaseUrl === "string" && c.supabaseUrl.startsWith("https://") &&
    typeof c.supabaseAnonKey === "string" && c.supabaseAnonKey.length > 20 &&
    typeof c.apiBaseOrigin === "string" && c.apiBaseOrigin.startsWith("https://")
  );
};
