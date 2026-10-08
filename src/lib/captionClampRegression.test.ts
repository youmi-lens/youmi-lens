import { describe, expect, it } from 'vitest'
import {
  captionFollowReducer,
  classifyHistoryScroll,
  distanceFromBottom,
  INITIAL_CAPTION_FOLLOW,
  isAtBottom,
  isScrolledUpFromAnchor,
  isUserScrollUp,
  nextFollowAnchor,
  shouldPinToBottom,
  type CaptionFollowState,
  type CaptionScrollMetrics,
  type FollowAnchor,
  type ScrollSample,
} from './captionAutoFollow'

/**
 * Regression for the auto-follow clamp bug (2026-10-04, round 2).
 *
 * REAL WKWebView evidence — diagnostic log of a physical session in the packaged
 * Tauri app, with NOBODY touching the history:
 *
 *   17:43:27.467  scroll  top=3490  (+28)    history viewport clientHeight 110
 *   17:43:27.552  scroll  top=3462  (-28)    clientHeight back to 138, scrollHeight 3600 throughout
 *   17:43:28.074  geometry: fromBottom=0, "Jump to latest" shown, following OFF
 *
 * The live line under the history wraps to two lines and back, so the history
 * viewport changes height by ~28px. When it grows, WebKit clamps scrollTop to the
 * new, lower maximum (3490 → 3462) and fires a scroll event that looks exactly
 * like a step upward. The classifier read it as the reader scrolling away, which
 * switched auto-follow off for the rest of the lecture. macOS rubber-banding at
 * the bottom produced the same shape (3485 overshoot → 3462), and did so right
 * after the reader had scrolled back down.
 */

const m = (scrollTop: number, scrollHeight: number, clientHeight: number): CaptionScrollMetrics => ({
  scrollTop,
  scrollHeight,
  clientHeight,
})
const s = (scrollTop: number, scrollHeight: number): ScrollSample => ({ scrollTop, scrollHeight })

/** The classifier exactly as shipped in QA 1004: no "landed on the bottom" rule. */
function qa1004Classify(prev: ScrollSample | null, anchor: FollowAnchor, mm: CaptionScrollMetrics) {
  const sample = s(mm.scrollTop, mm.scrollHeight)
  return isUserScrollUp(prev, sample) || isScrolledUpFromAnchor(anchor, sample)
}

describe('the real WKWebView clamp: clientHeight 110 → 138, scrollHeight 3600, scrollTop 3490 → 3462', () => {
  const atBottomShort = m(3490, 3600, 110) // reader at the bottom while the live line is two lines tall
  const anchor = nextFollowAnchor(null, atBottomShort)
  const clamped = m(3462, 3600, 138)

  it('is a decrease the old rule reads as a gesture (documents the defect)', () => {
    expect(qa1004Classify(s(3490, 3600), anchor, clamped)).toBe(true)
  })

  it('is NOT upward intent now: it landed on the bottom', () => {
    expect(isAtBottom(clamped)).toBe(true)
    expect(classifyHistoryScroll(s(3490, 3600), anchor, clamped).up).toBe(false)
  })

  it('leaves auto-follow ON when fed through the follow machine', () => {
    const { up } = classifyHistoryScroll(s(3490, 3600), anchor, clamped)
    const next = captionFollowReducer(
      { following: true, hasUnseen: false, overflowing: true },
      up ? { type: 'user-scrolled-up', metrics: clamped } : { type: 'scrolled', metrics: clamped },
    )
    expect(next.following).toBe(true)
    expect(shouldPinToBottom(next)).toBe(true)
  })

  it('also holds with only the anchor (no previous sample)', () => {
    expect(classifyHistoryScroll(null, anchor, clamped).up).toBe(false)
  })
})

describe('macOS rubber-band at the bottom: scrollTop overshoots then settles back', () => {
  const overshoot = m(3485, 3600, 138) // 23px past the end (max is 3462)
  const settled = m(3462, 3600, 138)

  it('treats the overshoot as the bottom, so the anchor is the real bottom, not the overshoot', () => {
    expect(distanceFromBottom(overshoot)).toBe(0)
    expect(nextFollowAnchor(null, overshoot)).toEqual({ scrollTop: 3462, scrollHeight: 3600 })
  })

  it('does not read the settle (3485 → 3462) as a step upward', () => {
    const anchor = nextFollowAnchor(null, overshoot)
    expect(qa1004Classify(s(3485, 3600), { scrollTop: 3485, scrollHeight: 3600 }, settled)).toBe(true) // old behaviour
    expect(classifyHistoryScroll(s(3485, 3600), anchor, settled).up).toBe(false)
  })

  it('manual return to the bottom resumes following and the bounce afterwards does not undo it', () => {
    let state: CaptionFollowState = { following: false, hasUnseen: true, overflowing: true }
    let anchor: FollowAnchor = null
    let prev: ScrollSample | null = s(3000, 3600)
    // The reader flicks down; the view overshoots then settles.
    for (const mm of [m(3300, 3600, 138), m(3460, 3600, 138), overshoot, m(3470, 3600, 138), settled]) {
      const cls = classifyHistoryScroll(prev, anchor, mm)
      anchor = cls.anchor
      prev = s(mm.scrollTop, mm.scrollHeight)
      state = captionFollowReducer(state, cls.up ? { type: 'user-scrolled-up', metrics: mm } : { type: 'scrolled', metrics: mm })
    }
    expect(state.following).toBe(true)
  })
})

describe('what must still count as the reader scrolling away', () => {
  it('a slow 1px-per-event drag from the bottom (the Round 1 fix survives)', () => {
    let anchor = nextFollowAnchor(null, m(3462, 3600, 138))
    let prev: ScrollSample | null = s(3462, 3600)
    const ups: boolean[] = []
    for (let i = 1; i <= 6; i++) {
      const mm = m(3462 - i, 3600, 138)
      const cls = classifyHistoryScroll(prev, anchor, mm)
      ups.push(cls.up)
      anchor = cls.anchor
      prev = s(mm.scrollTop, mm.scrollHeight)
    }
    expect(ups).toEqual([false, false, true, true, true, true])
  })

  it('a 2px drag and a fast flick', () => {
    for (const step of [2, 12, 60]) {
      const anchor = nextFollowAnchor(null, m(3462, 3600, 138))
      let up = false
      let prev: ScrollSample | null = s(3462, 3600)
      for (let i = 1; i <= 4 && !up; i++) {
        const mm = m(3462 - i * step, 3600, 138)
        up = classifyHistoryScroll(prev, anchor, mm).up
        prev = s(mm.scrollTop, mm.scrollHeight)
      }
      expect(up, `step ${step}`).toBe(true)
    }
  })

  it('a drag that begins right after a clamp, from the settled bottom', () => {
    const anchor = nextFollowAnchor(null, m(3462, 3600, 138))
    const dragged = m(3452, 3600, 138) // 10px up
    expect(classifyHistoryScroll(s(3462, 3600), anchor, dragged).up).toBe(true)
  })

  it('a drag that began while the history was at its short height', () => {
    const anchor = nextFollowAnchor(null, m(3490, 3600, 110))
    expect(classifyHistoryScroll(s(3490, 3600), anchor, m(3470, 3600, 110)).up).toBe(true)
  })

  it('history trimming at the cap is still not a gesture', () => {
    const anchor = nextFollowAnchor(null, m(3462, 3600, 138))
    expect(classifyHistoryScroll(s(3462, 3600), anchor, m(3402, 3540, 138)).up).toBe(false)
  })
})

/* ── Soak: the real layout wobble, end to end through the machine ──────────── */

const MAX_LINES = 60
const LINE = 60

/** A scroller whose viewport height changes (live line wrap) and whose content is capped. */
function makeWobblingScroller() {
  const lines = MAX_LINES
  let clientHeight = 138
  let scrollTop = lines * LINE - clientHeight
  const max = () => lines * LINE - clientHeight
  const clamp = () => {
    scrollTop = Math.min(Math.max(0, scrollTop), max())
  }
  return {
    metrics: (): CaptionScrollMetrics => ({ scrollTop, scrollHeight: lines * LINE, clientHeight }),
    /** The live line grows/shrinks; WebKit clamps scrollTop to the new maximum. */
    resizeTo: (h: number) => {
      clientHeight = h
      clamp()
    },
    userDrag: (px: number) => {
      scrollTop = Math.max(0, scrollTop - px)
    },
    pin: () => {
      scrollTop = max()
    },
    distance: () => distanceFromBottom({ scrollTop, scrollHeight: lines * LINE, clientHeight }),
  }
}

/**
 * One frame per iteration. A caption (interim or final) lands every
 * CAPTION_EVERY frames — that is when the live line may change height and when
 * the component pins to the bottom if it is following. A drag is one small
 * wheel step per frame, like a two-finger trackpad.
 */
const CAPTION_EVERY = 7
const WRAP_EVERY = 4 // captions between a one-line and a two-line live caption

function soak(opts: { frames: number; classify: boolean; dragAtFrame?: number; dragPx?: number }) {
  const sc = makeWobblingScroller()
  let state: CaptionFollowState = { ...INITIAL_CAPTION_FOLLOW, overflowing: true }
  let anchor: FollowAnchor = nextFollowAnchor(null, sc.metrics())
  let prev: ScrollSample | null = s(sc.metrics().scrollTop, sc.metrics().scrollHeight)
  let suspendedByLayout = 0

  const onScroll = (userInitiated: boolean) => {
    const mm = sc.metrics()
    const cls = opts.classify
      ? classifyHistoryScroll(prev, anchor, mm)
      : { up: qa1004Classify(prev, anchor, mm), anchor: nextFollowAnchor(anchor, mm) }
    anchor = cls.anchor
    prev = s(mm.scrollTop, mm.scrollHeight)
    const wasFollowing = state.following
    state = captionFollowReducer(state, cls.up ? { type: 'user-scrolled-up', metrics: mm } : { type: 'scrolled', metrics: mm })
    if (wasFollowing && !state.following && !userInitiated) suspendedByLayout++
  }

  for (let f = 1; f <= opts.frames; f++) {
    if (opts.dragAtFrame !== undefined && f >= opts.dragAtFrame && f < opts.dragAtFrame + 40) {
      sc.userDrag(opts.dragPx ?? 1)
      onScroll(true)
    }
    if (f % CAPTION_EVERY === 0) {
      const caption = f / CAPTION_EVERY
      const before = sc.metrics().scrollTop
      sc.resizeTo(caption % (WRAP_EVERY * 2) < WRAP_EVERY ? 110 : 138)
      if (sc.metrics().scrollTop !== before) onScroll(false)
      if (shouldPinToBottom(state)) {
        const pinBefore = sc.metrics().scrollTop
        sc.pin()
        if (sc.metrics().scrollTop !== pinBefore) onScroll(false)
      }
    }
  }
  return { sc, state, suspendedByLayout }
}

describe('soak: the live line wraps 1↔2 lines for thousands of frames with no input', () => {
  it('QA 1004 behaviour suspended follow by itself (documents the defect)', () => {
    const r = soak({ frames: 3000, classify: false })
    expect(r.suspendedByLayout).toBeGreaterThan(0)
    expect(r.state.following).toBe(false)
  })

  it('now never suspends follow, and the newest line stays in view', () => {
    const r = soak({ frames: 3000, classify: true })
    expect(r.suspendedByLayout).toBe(0)
    expect(r.state.following).toBe(true)
    expect(r.sc.distance()).toBe(0)
  })

  it('a real slow drag during the wobble still suspends follow and holds', () => {
    for (const px of [1, 2, 8]) {
      const r = soak({ frames: 400, classify: true, dragAtFrame: 100, dragPx: px })
      expect(r.state.following, `drag ${px}px`).toBe(false)
      expect(r.sc.distance(), `drag ${px}px`).toBeGreaterThan(5)
    }
  })
})
