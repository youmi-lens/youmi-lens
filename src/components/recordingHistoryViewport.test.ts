import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  captionFollowReducer,
  classifyHistoryScroll,
  distanceFromBottom,
  INITIAL_CAPTION_FOLLOW,
  nextFollowAnchor,
  shouldPinToBottom,
  shouldShowJumpToLatest,
  type CaptionFollowState,
  type CaptionScrollMetrics,
  type FollowAnchor,
  type ScrollSample,
} from '../lib/captionAutoFollow'

/**
 * Round 3 (2026-10-04): the history viewport must be a BOUNDED reading viewport.
 *
 * Physical finding, QA 1005: shrink the window and the history scrolls; maximize
 * it and it cannot. History was `flex: 1`, so it absorbed all free space. Measured
 * on the real DOM+CSS (history clientHeight): 142px at 800x600, 377px at
 * 1280x800, 694px at 1728x1117 — and with a short history a 423px blank band
 * between the last line and the live caption, and no overflow, so nothing to
 * scroll back through.
 *
 * There is no layout engine in this suite, so these read the REAL stylesheet and
 * test the invariant it must give, never exact pixels. The same scenarios were
 * run against the real component in a real browser (see the round-3 report).
 */

const css = readFileSync(new URL('../styles/recording-v2.css', import.meta.url), 'utf8')
const tsx = readFileSync(new URL('./RecordingV2.tsx', import.meta.url), 'utf8')

function rule(selector: string): string {
  const m = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`))
  expect(m, `missing rule ${selector}`).not.toBeNull()
  return m![1]
}

/** `--recording-history-max: clamp(Apx, Bvh, Cpx)` — the single source of the bound. */
function boundRule() {
  const m = css.match(/--recording-history-max:\s*clamp\(\s*(\d+)px\s*,\s*(\d+(?:\.\d+)?)vh\s*,\s*(\d+)px\s*\)/)
  expect(m, 'history bound must be a responsive clamp(min px, vh, max px)').not.toBeNull()
  return { minPx: Number(m![1]), vh: Number(m![2]), maxPx: Number(m![3]) }
}

describe('the stylesheet gives the history a bounded, responsive viewport', () => {
  const wrap = rule('.recording-v2__history-wrap')
  const history = rule('.recording-v2__history')
  const captions = rule('.recording-v2__captions')

  it('caps the viewport with the responsive bound — not a fixed pixel height and not "all remaining space"', () => {
    expect(wrap).toMatch(/max-height:\s*var\(--recording-history-max\)/)
    expect(wrap).toMatch(/flex:\s*0 1 auto/)
    expect(wrap).not.toMatch(/(^|[;\s])height:/)
    expect(history).not.toMatch(/(^|[;\s])height:/)
  })

  it('is a deliberate reading size: bounded above, and not tiny', () => {
    const { minPx, vh, maxPx } = boundRule()
    expect(maxPx).toBeLessThanOrEqual(480)
    expect(maxPx).toBeGreaterThanOrEqual(240)
    expect(minPx).toBeGreaterThanOrEqual(120)
    expect(minPx).toBeLessThan(maxPx)
    expect(vh).toBeGreaterThanOrEqual(25)
    expect(vh).toBeLessThanOrEqual(50)
  })

  it('still shrinks in a small window: min-height 0 on every link, so the controls stay reachable', () => {
    expect(wrap).toMatch(/min-height:\s*0/)
    expect(history).toMatch(/min-height:\s*0/)
    expect(captions).toMatch(/min-height:\s*0/)
    expect(wrap).toMatch(/flex:\s*0 1 auto/) // shrink factor 1
    expect(history).toMatch(/flex:\s*1 1 auto/)
  })

  it('is the only scroller, scrolling natively', () => {
    expect(history).toMatch(/overflow-y:\s*auto/)
    expect(history).toMatch(/overscroll-behavior:\s*contain/)
    expect(tsx).not.toMatch(/onWheel|addEventListener\(['"]wheel|preventDefault/)
  })

  it('leaves the slack ABOVE the transcript so the live caption stays directly under the history', () => {
    expect(captions).toMatch(/justify-content:\s*flex-end/)
  })

  it('keeps the current caption and the controls out of the scroller and out of the flexing space', () => {
    expect(rule('.recording-v2__live')).toMatch(/flex:\s*0 0 auto/)
    expect(rule('.recording-v2__controls')).toMatch(/flex:\s*0 0 auto/)
  })
})

/* ── Layout model, driven by the real bound ──────────────────────────────────
   History height = min(its content, the responsive cap, the room the window
   leaves). `room` is approximate on purpose: the invariants below do not depend
   on its exact value, only on it growing with the window. */

const LINE_PX = 62
const room = (windowH: number) => Math.max(0, windowH - 458)

function capFor(windowH: number): number {
  const { minPx, vh, maxPx } = boundRule()
  return Math.min(maxPx, Math.max(minPx, (windowH * vh) / 100))
}
function viewportHeight(windowH: number, contentPx: number): number {
  return Math.max(0, Math.min(contentPx, capFor(windowH), room(windowH)))
}
/** What it used to be: `flex: 1`, i.e. all the room, regardless of content. */
function legacyViewportHeight(windowH: number): number {
  return room(windowH)
}
const overflows = (windowH: number, contentPx: number) => contentPx - viewportHeight(windowH, contentPx) > 1

const SMALL = 600
const NORMAL = 800
const MAXIMIZED = 1117

describe('A–D. window size vs history viewport', () => {
  const longHistory = 30 * LINE_PX // enough finalized captions to fill any window

  it('A. small window, enough history: overflows, so the reader can scroll back', () => {
    expect(overflows(SMALL, longHistory)).toBe(true)
  })

  it('B. normal window, enough history: overflows', () => {
    expect(overflows(NORMAL, longHistory)).toBe(true)
  })

  it('C. maximized, enough history: the viewport stays BOUNDED and the history overflows inside it', () => {
    const h = viewportHeight(MAXIMIZED, longHistory)
    expect(h).toBeLessThanOrEqual(boundRule().maxPx)
    expect(h).toBeLessThan(room(MAXIMIZED)) // it no longer absorbs the free space
    expect(overflows(MAXIMIZED, longHistory)).toBe(true)
  })

  it('C2. the legacy rule is the defect: the viewport grew with the window', () => {
    expect(legacyViewportHeight(MAXIMIZED)).toBeGreaterThan(boundRule().maxPx)
    expect(legacyViewportHeight(MAXIMIZED)).toBeGreaterThan(legacyViewportHeight(SMALL) * 3)
  })

  it('C3. needs far less history to overflow when maximized than the legacy rule did', () => {
    const lines = (px: number) => Math.ceil(px / LINE_PX)
    expect(lines(viewportHeight(MAXIMIZED, 1e6))).toBeLessThan(lines(legacyViewportHeight(MAXIMIZED)))
  })

  it('D. maximized with SHORT history: it simply fits — no fake scrollbar, no blank band inside the viewport', () => {
    for (const lines of [1, 2, 4]) {
      const content = lines * LINE_PX
      expect(viewportHeight(MAXIMIZED, content)).toBe(content)
      expect(overflows(MAXIMIZED, content)).toBe(false)
    }
  })

  it('the viewport never exceeds the bound at ANY window height, and never shrinks as the window grows', () => {
    let previous = 0
    for (let h = 420; h <= 2400; h += 20) {
      const v = viewportHeight(h, longHistory)
      expect(v).toBeLessThanOrEqual(boundRule().maxPx)
      expect(v).toBeGreaterThanOrEqual(previous)
      previous = v
    }
  })

  it('never takes more room than the window leaves (small windows behave exactly as before)', () => {
    for (let h = 420; h <= 900; h += 20) {
      expect(viewportHeight(h, longHistory)).toBeLessThanOrEqual(room(h))
    }
  })
})

/* ── E / F. Resize and the follow machine ────────────────────────────────── */

const LINES = 60
const LINE = 60

/** A scroller whose viewport height is set by the window; WebKit clamps scrollTop on shrink-of-max. */
function makeScroller(viewport: number) {
  let clientHeight = viewport
  const scrollHeight = LINES * LINE
  let scrollTop = scrollHeight - clientHeight
  const max = () => scrollHeight - clientHeight
  return {
    metrics: (): CaptionScrollMetrics => ({ scrollTop, scrollHeight, clientHeight }),
    /** Window resize. Returns whether the platform moved scrollTop (a clamp). */
    resizeTo: (h: number) => {
      const before = scrollTop
      clientHeight = h
      scrollTop = Math.min(scrollTop, max())
      return scrollTop !== before
    },
    userScrollUp: (px: number) => {
      scrollTop = Math.max(0, scrollTop - px)
    },
    pin: () => {
      scrollTop = max()
    },
    distance: () => distanceFromBottom({ scrollTop, scrollHeight, clientHeight }),
    top: () => scrollTop,
  }
}

function reader(viewport: number) {
  const sc = makeScroller(viewport)
  let state: CaptionFollowState = { ...INITIAL_CAPTION_FOLLOW, overflowing: true }
  let anchor: FollowAnchor = nextFollowAnchor(null, sc.metrics())
  let prev: ScrollSample | null = { scrollTop: sc.metrics().scrollTop, scrollHeight: sc.metrics().scrollHeight }

  const onScroll = () => {
    const m = sc.metrics()
    const cls = classifyHistoryScroll(prev, anchor, m)
    anchor = cls.anchor
    prev = { scrollTop: m.scrollTop, scrollHeight: m.scrollHeight }
    state = captionFollowReducer(state, cls.up ? { type: 'user-scrolled-up', metrics: m } : { type: 'scrolled', metrics: m })
  }
  return {
    sc,
    state: () => state,
    /** The component: viewport box changed → 'resized'; pin only if following. */
    resize: (h: number) => {
      if (sc.resizeTo(h)) onScroll()
      state = captionFollowReducer(state, { type: 'resized', metrics: sc.metrics() })
      if (shouldPinToBottom(state)) {
        const before = sc.top()
        sc.pin()
        if (sc.top() !== before) onScroll()
      }
    },
    scrollAway: (px: number) => {
      // Slow two-finger drag, one px per event.
      for (let i = 0; i < px; i++) {
        sc.userScrollUp(1)
        onScroll()
      }
    },
    scrollToBottomByHand: () => {
      sc.pin()
      onScroll()
    },
  }
}

describe('E. resize large → small → large while following', () => {
  it('stays following, newest line in view, no Jump pill', () => {
    const r = reader(360)
    for (const h of [166, 360, 304, 360, 142, 360]) {
      r.resize(h)
      expect(r.state().following).toBe(true)
      expect(r.sc.distance()).toBe(0)
      expect(shouldShowJumpToLatest(r.state())).toBe(false)
    }
  })

  it('a window that only changed HEIGHT still re-pins (the scroller box is observed, not just its text)', () => {
    expect(tsx).toMatch(/const viewport = historyRef\.current\s*\n\s*if \(viewport\) observer\.observe\(viewport\)/)
    expect(tsx).toMatch(/observer\.observe\(el\)/)
    // The pin in that callback is gated by the follow state.
    expect(tsx).toMatch(/dispatchFollow\(\{ type: 'resized', metrics \}\)\s*\n\s*if \(shouldPinToBottom\(follow\)\) pinToBottom\(\)/)
  })
})

describe('F. resize while the reader has scrolled up', () => {
  it('does not drag the reader to the latest line, and keeps offering Jump to latest', () => {
    const r = reader(360)
    r.scrollAway(900)
    expect(r.state().following).toBe(false)
    const top = r.sc.top()
    for (const h of [166, 360, 142, 360]) {
      r.resize(h)
      expect(r.state().following).toBe(false)
      expect(r.sc.distance()).toBeGreaterThan(300)
      expect(shouldShowJumpToLatest(r.state())).toBe(true)
      expect(r.sc.top()).toBe(top)
    }
  })

  it('a resize that lands the reader on the bottom is just the bottom — following resumes coherently', () => {
    const r = reader(166)
    r.scrollAway(40)
    expect(r.state().following).toBe(false)
    r.resize(360) // viewport grows past where they were: the platform clamps to the bottom
    expect(r.sc.distance()).toBe(0)
    expect(r.state().following).toBe(true)
  })

  it('and Jump to latest / returning to the bottom by hand still resume following', () => {
    const r = reader(360)
    r.scrollAway(700)
    r.scrollToBottomByHand()
    expect(r.state().following).toBe(true)
    r.scrollAway(700)
    expect(captionFollowReducer(r.state(), { type: 'jump-to-latest' }).following).toBe(true)
  })
})
