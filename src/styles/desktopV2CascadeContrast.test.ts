/**
 * QA17 — deterministic CSS cascade + contrast regression.
 *
 * WHY THIS FILE EXISTS
 * QA16 shipped three buttons whose labels were invisible (dark text on a dark
 * navy background). Every QA16 test passed, because they all asserted on
 * *source shape* ("does this class name appear?") and the markup was correct —
 * the bug lived entirely in which CSS rule won the cascade.
 *
 * So this file does not grep. It parses the real stylesheets, resolves the
 * cascade for a real element path (specificity, then source order, the same
 * way a browser does), resolves the winning value through the design tokens,
 * and asserts the resulting text/background pair actually contrasts.
 *
 * STATED LIMITATION: this is a cascade model, not a browser. It covers
 * specificity, source order, descendant/compound matching and `inherit`
 * chains, which is the class of bug that shipped. It does NOT model layout,
 * paint, stacking, opacity, blend modes, or platform form-control quirks.
 * Passing here is strong evidence of correct colour resolution, not a
 * substitute for the owner's runtime screenshot.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// ── minimal CSS cascade model ───────────────────────────────────────────────

type Decls = Record<string, string>
type Rule = { selector: string; decls: Decls; order: number }
/** One node in an element path, root first, target last. */
type El = { tag: string; classes: string[] }

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Drop @media/@supports blocks: we resolve the default (no-query) cascade. */
function stripAtBlocks(css: string): string {
  let out = ''
  let i = 0
  while (i < css.length) {
    if (css[i] !== '@') {
      out += css[i]
      i += 1
      continue
    }
    let j = i
    while (j < css.length && css[j] !== '{' && css[j] !== ';') j += 1
    if (css[j] === ';' || j >= css.length) {
      i = j + 1
      continue
    }
    let depth = 0
    let k = j
    for (; k < css.length; k += 1) {
      if (css[k] === '{') depth += 1
      else if (css[k] === '}') {
        depth -= 1
        if (depth === 0) {
          k += 1
          break
        }
      }
    }
    i = k
  }
  return out
}

function parseRules(css: string, startOrder: number): { rules: Rule[]; nextOrder: number } {
  const rules: Rule[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let order = startOrder
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) {
    const decls: Decls = {}
    for (const part of m[2].split(';')) {
      const idx = part.indexOf(':')
      if (idx === -1) continue
      decls[part.slice(0, idx).trim()] = part.slice(idx + 1).trim()
    }
    for (const sel of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      rules.push({ selector: sel, decls, order })
      order += 1
    }
  }
  return { rules, nextOrder: order }
}

function specificity(sel: string): [number, number, number] {
  const ids = (sel.match(/#[\w-]+/g) ?? []).length
  const classes =
    (sel.match(/\.[\w-]+/g) ?? []).length +
    (sel.match(/\[[^\]]*\]/g) ?? []).length +
    (sel.match(/:(?!:)[\w-]+/g) ?? []).length
  const types = (
    sel
      .replace(/\.[\w-]+/g, ' ')
      .replace(/#[\w-]+/g, ' ')
      .replace(/::?[\w-]+(\([^)]*\))?/g, ' ')
      .match(/\b[a-zA-Z][\w-]*\b/g) ?? []
  ).length
  return [ids, classes, types]
}

/** One compound simple selector, e.g. `button.a.b` / `.a.b` / `button` / `*`. */
function matchesSimple(part: string, el: El): boolean {
  // Stateful/attr/pseudo selectors are excluded: we resolve the resting state.
  if (/[:[]/.test(part)) return false
  const tag = part.match(/^[a-zA-Z][\w-]*/)
  if (tag && tag[0] !== el.tag) return false
  const classes = part.match(/\.[\w-]+/g) ?? []
  return classes.every((c) => el.classes.includes(c.slice(1)))
}

function matches(selector: string, path: El[]): boolean {
  if (/[>+~]/.test(selector)) return false // not used by the selectors under test
  const parts = selector.trim().split(/\s+/)
  let i = parts.length - 1
  let p = path.length - 1
  if (!matchesSimple(parts[i], path[p])) return false
  i -= 1
  p -= 1
  while (i >= 0) {
    let found = false
    while (p >= 0) {
      const hit = matchesSimple(parts[i], path[p])
      p -= 1
      if (hit) {
        found = true
        break
      }
    }
    if (!found) return false
    i -= 1
  }
  return true
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

/** The declaration a browser would apply for `prop` on the target element. */
function winning(prop: string, path: El[], rules: Rule[]): { value: string; selector: string } | null {
  let best: { value: string; selector: string } | null = null
  let bestKey = [-1, -1, -1, -1]
  for (const rule of rules) {
    const value = rule.decls[prop]
    if (value === undefined) continue
    if (!matches(rule.selector, path)) continue
    const s = specificity(rule.selector)
    const key = [s[0], s[1], s[2], rule.order]
    if (cmp(key, bestKey) > 0) {
      bestKey = key
      best = { value, selector: rule.selector }
    }
  }
  return best
}

/** Resolve `color`, following `inherit` (and unset -> inherited) up the path. */
function resolveColor(path: El[], rules: Rule[]): { value: string; selector: string } | null {
  for (let end = path.length; end > 0; end -= 1) {
    const hit = winning('color', path.slice(0, end), rules)
    if (hit && hit.value !== 'inherit') return hit
    // `color` is an inherited property: no rule (or `inherit`) -> ask the parent.
  }
  return null
}

// ── tokens + contrast ───────────────────────────────────────────────────────

const dir = new URL('.', import.meta.url)
const tokensCss = readFileSync(new URL('desktop-v2-tokens.css', dir), 'utf8')
const desktopCss = readFileSync(new URL('desktop-v2.css', dir), 'utf8')
const accountCss = readFileSync(new URL('../components/AccountSettingsModal.css', dir), 'utf8')
const billingCss = readFileSync(new URL('../components/BillingPlanModal.css', dir), 'utf8')

const TOKENS: Record<string, string> = {}
for (const m of stripComments(tokensCss).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
  TOKENS[m[1]] = m[2].trim()
}

function resolveVar(value: string): string {
  let out = value
  for (let i = 0; i < 5 && out.includes('var('); i += 1) {
    out = out.replace(/var\((--[\w-]+)\)/g, (_all, name: string) => TOKENS[name] ?? _all)
  }
  return out.trim()
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.trim().replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ]
}

function luminance(hex: string): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const [r, g, b] = hexToRgb(hex)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrastRatio(fg: string, bg: string): number {
  const a = luminance(fg)
  const b = luminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

// Sheet order mirrors the app: the global V2 sheet, then component sheets.
// (Specificity decides every assertion below, so order is not load-bearing.)
function sheets(...extra: string[]): Rule[] {
  const rules: Rule[] = []
  let order = 0
  for (const css of [desktopCss, ...extra]) {
    const parsed = parseRules(stripAtBlocks(stripComments(css)), order)
    rules.push(...parsed.rules)
    order = parsed.nextOrder
  }
  return rules
}

// ── the three elements the owner saw with invisible labels ──────────────────

const ACCOUNT_SAVE: El[] = [
  { tag: 'div', classes: ['desktop-v2', 'account-settings-modal__overlay'] },
  { tag: 'div', classes: ['account-settings-modal__dialog'] },
  { tag: 'div', classes: ['account-settings-modal__footer'] },
  { tag: 'div', classes: ['account-settings-modal__footer-trailing'] },
  { tag: 'button', classes: ['account-settings-modal__btn', 'account-settings-modal__btn--primary'] },
]

const BILLING_UPGRADE: El[] = [
  { tag: 'div', classes: ['desktop-v2', 'billing-plan-modal__overlay'] },
  { tag: 'div', classes: ['billing-plan-modal__dialog'] },
  { tag: 'div', classes: ['billing-plan-modal__body'] },
  { tag: 'div', classes: ['billing-plan-modal__panel'] },
  { tag: 'div', classes: ['billing-plan-modal__preview'] },
  {
    tag: 'button',
    classes: ['billing-plan-modal__btn', 'billing-plan-modal__btn--primary', 'billing-plan-modal__upgrade'],
  },
]

const SEGMENT_SELECTED: El[] = [
  { tag: 'div', classes: ['desktop-v2'] },
  { tag: 'section', classes: ['settings-v2__detail'] },
  { tag: 'div', classes: ['settings-v2__group'] },
  { tag: 'div', classes: ['settings-v2__row'] },
  { tag: 'div', classes: ['settings-v2__segmented'] },
  { tag: 'button', classes: ['settings-v2__segmented-btn', 'settings-v2__segmented-btn--selected'] },
]

const MIN_CONTRAST = 4.5 // WCAG AA, normal text

describe('QA17 — the shared root cause: `.desktop-v2 button { color: inherit }`', () => {
  it('the reset really is (0,1,1), so any single-class colour rule loses to it', () => {
    expect(specificity('.desktop-v2 button')).toEqual([0, 1, 1])
    expect(specificity('.account-settings-modal__btn--primary')).toEqual([0, 1, 0])
    // (0,1,0) < (0,1,1) regardless of source order — this is the whole bug.
    expect(cmp([0, 1, 0, 9999], [0, 1, 1, 0])).toBeLessThan(0)
  })

  it('inheriting is fatal here: the ambient ink and the navy button fill are the SAME colour', () => {
    // This is why the labels vanished rather than merely dimming.
    expect(resolveVar('var(--v2-ink)')).toBe(resolveVar('var(--v2-navy)'))
    expect(contrastRatio(resolveVar('var(--v2-ink)'), resolveVar('var(--v2-navy)'))).toBeCloseTo(1, 5)
  })
})

describe('QA17 — primary/selected labels resolve to a contrasting colour', () => {
  it('Account "Save changes": text colour comes from the modal rule, not the inherit reset', () => {
    const rules = sheets(accountCss)
    const color = resolveColor(ACCOUNT_SAVE, rules)
    const bg = winning('background', ACCOUNT_SAVE, rules)
    expect(color?.selector).toBe('.desktop-v2 .account-settings-modal__btn--primary')
    expect(color?.value).toBe('var(--v2-navy-ink)')
    expect(bg?.value).toBe('var(--v2-navy)')
    expect(contrastRatio(resolveVar(color!.value), resolveVar(bg!.value))).toBeGreaterThanOrEqual(MIN_CONTRAST)
  })

  it('Plan & Billing "Upgrade": text colour comes from the modal rule, not the inherit reset', () => {
    const rules = sheets(billingCss)
    const color = resolveColor(BILLING_UPGRADE, rules)
    const bg = winning('background', BILLING_UPGRADE, rules)
    expect(color?.selector).toBe('.desktop-v2 .billing-plan-modal__btn--primary')
    expect(color?.value).toBe('var(--v2-navy-ink)')
    expect(bg?.value).toBe('var(--v2-navy)')
    expect(contrastRatio(resolveVar(color!.value), resolveVar(bg!.value))).toBeGreaterThanOrEqual(MIN_CONTRAST)
  })

  it('selected "Bilingual" segment: text colour comes from the segment rule, not the inherit reset', () => {
    const rules = sheets()
    const color = resolveColor(SEGMENT_SELECTED, rules)
    const bg = winning('background', SEGMENT_SELECTED, rules)
    expect(color?.selector).toBe('button.settings-v2__segmented-btn--selected')
    expect(color?.value).toBe('var(--v2-navy-ink)')
    expect(bg?.value).toBe('var(--v2-navy)')
    expect(contrastRatio(resolveVar(color!.value), resolveVar(bg!.value))).toBeGreaterThanOrEqual(MIN_CONTRAST)
  })

  it('the UNSELECTED segment also keeps its own colour (it only looked fine by accident)', () => {
    const unselected: El[] = [
      ...SEGMENT_SELECTED.slice(0, -1),
      { tag: 'button', classes: ['settings-v2__segmented-btn'] },
    ]
    const rules = sheets()
    const color = resolveColor(unselected, rules)
    expect(color?.selector).toBe('button.settings-v2__segmented-btn')
    expect(color?.value).toBe('var(--v2-muted)')
  })
})

describe('QA17 — this model actually detects the QA16 regression', () => {
  it('reverting the fix (single-class colour rules) reproduces invisible-on-navy', () => {
    // Same resolver, fed the QA16 selectors: proves these tests would have failed.
    const broken = accountCss.replace(/\.desktop-v2 \.account-settings-modal__/g, '.account-settings-modal__')
    const rules = sheets(broken)

    // On the button itself, the reset wins outright and hands it `inherit`.
    const direct = winning('color', ACCOUNT_SAVE, rules)
    expect(direct?.selector).toBe('.desktop-v2 button')
    expect(direct?.value).toBe('inherit')

    // Following that inherit lands on the ambient ink from `.desktop-v2` —
    // the exact same colour as the button's own navy fill.
    const color = resolveColor(ACCOUNT_SAVE, rules)
    const bg = winning('background', ACCOUNT_SAVE, rules)
    expect(color?.selector).toBe('.desktop-v2')
    expect(contrastRatio(resolveVar(color!.value), resolveVar(bg!.value))).toBeLessThan(MIN_CONTRAST)
    expect(contrastRatio(resolveVar(color!.value), resolveVar(bg!.value))).toBeCloseTo(1, 5)
  })
})

describe('QA17 — overlay scoping stays correct in both dialogs', () => {
  it('the overlay rule is COMPOUND, so it matches the element that carries both classes', () => {
    // A descendant selector here can never match: the overlay is not a
    // descendant of itself. That was the genuine QA15 geometry bug.
    for (const [css, block] of [
      [accountCss, 'account-settings-modal'],
      [billingCss, 'billing-plan-modal'],
    ] as const) {
      const rules = parseRules(stripAtBlocks(stripComments(css)), 0).rules
      const overlay = rules.find((r) => r.selector.includes(`${block}__overlay`))
      expect(overlay?.selector).toBe(`.desktop-v2.${block}__overlay`)
      const el: El[] = [{ tag: 'div', classes: ['desktop-v2', `${block}__overlay`] }]
      expect(matches(overlay!.selector, el)).toBe(true)
      // the QA16 form still matches (it is what fixed centering)...
      expect(matches(`.${block}__overlay`, el)).toBe(true)
      // ...but the pre-QA16 descendant form never did.
      expect(matches(`.desktop-v2 .${block}__overlay`, el)).toBe(false)
    }
  })

  it('QA16 geometry is unchanged — still centered, still the accepted sizes', () => {
    expect(accountCss).toMatch(/max-width:\s*min\(92vw,\s*680px\)/)
    expect(accountCss).toMatch(/max-height:\s*80vh/)
    expect(billingCss).toMatch(/max-width:\s*min\(92vw,\s*760px\)/)
    expect(billingCss).toMatch(/max-height:\s*83vh/)
    for (const css of [accountCss, billingCss]) {
      expect(css).toMatch(/align-items:\s*center/)
      expect(css).toMatch(/justify-content:\s*center/)
    }
  })
})
