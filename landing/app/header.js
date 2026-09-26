/**
 * Shared production site header — the ONE toolbar markup helper for every route
 * that is not the static homepage. It renders the same .site-nav structure, the
 * same link destinations, and the same macOS CTA as landing/index.html, and is
 * styled by the same landing/styles.css those routes now load. The homepage keeps
 * its markup inline so the nav still renders with JavaScript disabled;
 * websiteProduction.test.ts asserts the two stay identical.
 *
 * Only the right-hand cell varies:  signed out → Log in   ·   signed in → Account
 */
import { getSession, onAuthChange } from './auth.js'

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) }

/** Approved production macOS build — must equal the homepage CTA in index.html. */
export const MAC_DOWNLOAD_URL =
  'https://github.com/youmi-lens/youmi-lens/releases/download/v0.1.9/Youmi.Lens_0.1.9_aarch64.dmg'

/** Absolute destinations so every link resolves from any route, never /pricing/#download. */
export const NAV_LINKS = [
  ['/#features', 'Features'],
  ['/#privacy', 'Privacy'],
  ['/#download', 'Download'],
  ['/pricing/', 'Pricing'],
  ['/#support', 'Support'],
]

/**
 * Public release switch — Pricing is dropped from the toolbar while
 * commercialization is off. Fail-closed: an absent/partial config hides it.
 * The homepage keeps its own inline copy of this nav (index.html); both must
 * hide Pricing together — websiteProduction.test.ts asserts they stay identical.
 */
function visibleNavLinks() {
  const on = window.YOUMI_CONFIG?.isCommercializationEnabled?.() === true
  return on ? NAV_LINKS : NAV_LINKS.filter(([href]) => href !== '/pricing/')
}

function render(signedIn, email) {
  const onPricing = location.pathname.startsWith('/pricing')
  const links = visibleNavLinks().map(([href, label]) => {
    const current = href === '/pricing/' && onPricing
    return `<a href="${href}"${current ? ' aria-current="page" class="is-current"' : ''}>${label}</a>`
  }).join('\n        ')
  const right = signedIn
    ? `<a class="nav-account" href="/account/"><span class="av">${esc((email || 'A')[0].toUpperCase())}</span>Account</a>`
    : `<a class="nav-login" href="/login/">Log in</a>`
  return `
    <header class="site-nav" aria-label="Primary navigation">
      <a class="brand" href="/" aria-label="Youmi Lens home"><img class="brand-wordmark" src="/brand/youmi-lens-wordmark-tight.png" alt="Youmi Lens"></a>
      <nav class="nav-links" aria-label="Page sections">
        ${links}
      </nav>
      <div class="nav-right">
        ${right}
        <a class="nav-download" href="${MAC_DOWNLOAD_URL}" download>Download for macOS</a>
      </div>
    </header>`
}

async function mount() {
  const host = document.getElementById('site-header')
  if (!host) return
  const paint = (session) => { host.innerHTML = render(Boolean(session), session?.user?.email) }
  paint(await getSession())
  onAuthChange(paint) // update instantly on sign in / out
}

mount()
