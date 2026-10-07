/**
 * Website Account Dashboard — real data from the shared account backend.
 *   GET /api/quota/status         → plan + usage (Bearer)
 *   GET /api/subscription/status  → renewal / cancel / past-due facts (Bearer)
 * Sensitive IDs are never shown; backend values map to clear user-facing labels.
 */
import { getSession, getUsername, getQuotaStatus, getSubscriptionStatus, openBillingPortal, signOut } from './auth.js'
import { esc, toast } from './auth-ui.js'
import { mins, usd, PRICE } from './plans.js'
import { resolveAccountEntry } from './checkoutSuccess.js'

const root = () => document.getElementById('account-root')
function set(html) { const r = root(); if (r) r.innerHTML = html }

function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso); if (isNaN(d)) return '—'
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${M[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}

function badge(planType, sub) {
  if (planType === 'student_pass') {
    if (sub?.status === 'past_due') return ['danger', 'Payment issue']
    if (sub?.cancelAtPeriodEnd) return ['warn', 'Cancels soon']
    return ['active', 'Active']
  }
  if (sub && sub.status === 'canceled') return ['neutral', 'Expired']
  return ['neutral', 'Free']
}
function renewLine(planType, sub) {
  if (!sub) return ['', '']
  if (planType === 'public_trial' && sub.status === 'canceled') return [`Your Student Basic access ended ${fmtDate(sub.currentPeriodEnd)}.`, '']
  if (sub.status === 'past_due') return [`Payment failed. Access continues until ${fmtDate(sub.currentPeriodEnd)} unless billing is fixed.`, 'danger']
  if (sub.cancelAtPeriodEnd) return [`Access continues until ${fmtDate(sub.currentPeriodEnd)}, then switches to Free Beta.`, 'warn']
  if (sub.active) return [`Renews ${fmtDate(sub.currentPeriodEnd)} · ${sub.billingInterval === 'year' ? 'billed annually' : 'billed monthly'}.`, '']
  return ['', '']
}

function loadingView() {
  return `<div class="acct">
    <div class="card acct__head"><div class="acct__avatar skel" style="background:none"></div>
      <div class="acct__id"><div class="skel" style="height:16px;width:150px;margin-bottom:8px"></div><div class="skel" style="height:12px;width:220px"></div></div></div>
    <div class="card pane"><div class="skel" style="height:20px;width:220px;margin-bottom:12px"></div><div class="skel" style="height:9px;margin-bottom:14px"></div><div class="skel" style="height:38px;width:180px;border-radius:12px"></div></div>
  </div>`
}
function errorView(m) {
  return `<div class="acct"><div class="card empty"><div style="font-size:24px">⚠️</div><h2 style="font-size:18px">Something went wrong</h2>
    <p>${esc(m || 'Couldn’t load your account.')}</p><button class="btn btn--secondary" id="retry">Try again</button></div></div>`
}

function meterFill(used, limit) {
  const r = limit > 0 ? Math.min(1, used / limit) : 0
  return { pct: Math.round(r * 100), cls: r >= 1 ? 'danger' : r >= 0.85 ? 'warn' : '', remaining: Math.max(0, limit - used) }
}

function dashboardView(email, plan, sub, username) {
  // A session can lack an email (e.g. some OAuth identities). Show a neutral
  // value rather than inferring or fabricating an address.
  const emailText = email || 'Not available'
  // Identity precedence: real username → email local-part (legacy accounts that
  // predate an explicit username) → the neutral placeholder. Never fabricated.
  const handle = username || (email ? email.split('@')[0] : emailText)
  const planType = plan.planType
  const isPaid = planType === 'student_pass'
  const [tone, label] = badge(planType, sub)
  const [rl, rlCls] = renewLine(planType, sub)
  const displayName = plan.displayName || (isPaid ? 'Student Basic' : 'Free Beta')
  const priceStr = isPaid && sub?.billingInterval ? `${usd((sub.billingInterval === 'year' ? PRICE.annual : PRICE.monthly).usdCents)} / ${sub.billingInterval === 'year' ? 'year' : 'month'}` : ''
  const m = plan.minutesLimit != null ? meterFill(plan.minutesUsed || 0, plan.minutesLimit) : null
  // Public release switch: free users get NO purchase entry while
  // commercialization is off. Paid users ALWAYS keep Manage plan / Fix payment —
  // existing subscribers must never lose access to the Customer Portal.
  const commercialOn = window.YOUMI_CONFIG?.isCommercializationEnabled?.() === true
  const action = isPaid
    ? `<button class="btn btn--primary" id="manage">${sub?.status === 'past_due' ? 'Fix payment' : 'Manage plan'}</button>`
    : commercialOn
      ? `<a class="btn btn--primary" href="/pricing/">Upgrade to Student Basic</a>`
      : ''

  let details = `<dt>Email</dt><dd>${esc(emailText)}</dd><dt>Plan</dt><dd>${esc(displayName)}</dd><dt>Status</dt><dd><span class="badge badge--${tone}">${label}</span></dd>`
  if (sub && (sub.active || sub.status === 'canceled')) {
    const lbl = planType === 'public_trial' ? 'Access ended' : sub.cancelAtPeriodEnd ? 'Access until' : 'Renews on'
    details += `<dt>${lbl}</dt><dd>${fmtDate(sub.currentPeriodEnd)}</dd>`
  }
  if (isPaid && sub?.provider) details += `<dt>Billing</dt><dd>${sub.provider === 'stripe' ? 'Card · youmilens.com' : 'App Store (iPad)'}</dd>`
  details += `<dt>Platforms</dt><dd>Mac · Windows · iPad</dd>`

  return `<div class="acct">
    <div class="card acct__head"><div class="acct__avatar">${esc((handle[0] || 'A').toUpperCase())}</div>
      <div class="acct__id"><div class="acct__name">${esc(handle)}</div><div class="acct__email">${esc(emailText)}</div></div>
      <span class="badge badge--${tone}">${label}</span></div>
    <div class="card pane"><h3>Your plan</h3>
      <div class="plan-line"><span class="name">${esc(displayName)}</span>${priceStr ? `<span class="price">${priceStr}</span>` : ''}</div>
      ${rl ? `<p class="renew ${rlCls}">${esc(rl)}</p>` : ''}
      ${m ? `<div class="meter-row"><span>${mins(plan.minutesUsed || 0)} of ${mins(plan.minutesLimit)} used this month</span><span style="color:${m.cls === 'danger' ? 'var(--danger)' : 'var(--muted-text)'}">${mins(m.remaining)} left</span></div>
        <div class="meter"><div class="meter__fill ${m.cls}" style="width:${m.pct}%"></div></div>
        <div class="mini-stats">
          <div><div class="k">Longest recording</div><div class="v">${mins(plan.maxRecordingMinutes)}</div></div>
          <div><div class="k">Recordings today</div><div class="v">${plan.recordingsUsedToday ?? 0} / ${plan.maxRecordingsPerDay ?? '—'}</div></div>
          <div><div class="k">Live session cap</div><div class="v">${mins(plan.maxLiveSessionMinutes)}</div></div>
        </div>` : ''}
      <div class="actions">${action}<button class="btn btn--ghost" id="logout">Log out</button></div></div>
    <div class="card pane"><h3>Account details</h3><dl class="dl">${details}</dl></div>
  </div>`
}

function wire(email, plan, sub) {
  const mg = document.getElementById('manage')
  if (mg) mg.addEventListener('click', async () => {
    const label = mg.textContent // 'Fix payment' when past_due, else 'Manage plan'
    mg.disabled = true; mg.textContent = 'Opening…'
    const r = await openBillingPortal()
    if (r.ok) { location.assign(r.url); return }
    mg.disabled = false; mg.textContent = label
    toast(r.message || 'Billing is temporarily unavailable.')
  })
  const lo = document.getElementById('logout')
  if (lo) lo.addEventListener('click', async () => { await signOut(); location.assign('/') })
}

async function load() {
  set(loadingView())
  const [q, s] = await Promise.all([getQuotaStatus(), getSubscriptionStatus()])
  if (!q.ok && q.code === 'auth_required') { location.replace('/login/?next=/account/'); return }
  if (!q.ok) {
    set(errorView(q.message))
    const r = document.getElementById('retry'); if (r) r.addEventListener('click', load)
    return
  }
  const plan = q.body?.plan || {}
  const sub = s.ok ? s.body?.subscription : null
  const session = await getSession()
  const email = session?.user?.email || plan.email || '' // never fabricate an address
  // Non-fatal: getUsername() already degrades to metadata, and null here simply
  // means the legacy email-local-part fallback is used.
  let username = null
  try { username = await getUsername() } catch { username = null }
  set(dashboardView(email, plan, sub, username))
  wire(email, plan, sub)
}

;(async () => {
  // `?checkout=success` is decided FIRST and never touches the website session: this browser may be signed in as a
  // different account than the purchaser, so the success page is identity-neutral (see checkoutSuccess.js).
  const entry = await resolveAccountEntry({ pathname: location.pathname, search: location.search, getSession })
  if (entry.kind === 'checkout-success') { document.title = 'Subscription activated — Youmi Lens'; set(entry.html); return }
  if (entry.kind === 'login') { location.replace('/login/?next=/account/'); return }
  load()
})()
