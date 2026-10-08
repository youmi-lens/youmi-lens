import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  captionFollowReducer,
  classifyHistoryScroll,
  distanceFromBottom,
  INITIAL_CAPTION_FOLLOW,
  isScrolledUpFromAnchor,
  isUserScrollUp,
  nextFollowAnchor,
  shouldPinToBottom,
  UPWARD_INTENT_PX,
  type CaptionFollowState,
  type CaptionScrollMetrics,
  type FollowAnchor,
  type ScrollSample,
} from './captionAutoFollow'

/**
 * Regression for Bug #2 (2026-10-04): live transcript history could not be
 * scrolled back during recording.
 *
 * REPRODUCED against the real RecordingV2 + real CSS in Chromium with trusted
 * wheel events while captions kept arriving:
 *   - 2px per frame: the reader leaves the bottom fine.
 *   - 1px per frame (a slow two-finger drag): distance-from-bottom climbed
 *     6, 12, 18, 24 then snapped back to ~2, repeating; 2.5s later the reader was
 *     back at 0px. The drag was undone every time a caption arrived.
 *
 * Cause: `isUserScrollUp` only counts a move of MORE than 1px between two
 * consecutive scroll events. A slow drag moves <=1px per event, so it never
 * registered as upward intent; the machine fell back to position, where the
 * first 32px still counts as "following", and the next caption pinned the
 * reader straight back down.
 */

const CLIENT = 170
const START_HEIGHT = 3600

/** A tiny model of the scroller: content grows as captions arrive. */
function makeScroller() {
  let scrollHeight = START_HEIGHT
  let scrollTop = scrollHeight - CLIENT
  return {
    metrics: (): CaptionScrollMetrics => ({ scrollTop, scrollHeight, clientHeight: CLIENT }),
    userDrag: (px: number) => {
      scrollTop = Math.max(0, scrollTop - px)
    },
    captionArrives: (lineHeight = 34) => {
      scrollHeight += lineHeight
    },
    pin: () => {
      scrollTop = scrollHeight - CLIENT
    },
    distance: () => distanceFromBottom({ scrollTop, scrollHeight, clientHeight: CLIENT }),
  }
}

type Classifier = (
  prev: ScrollSample | null,
  anchor: FollowAnchor,
  m: CaptionScrollMetrics,
) => { up: boolean; anchor: FollowAnchor }

/** What the component did BEFORE the fix: consecutive-sample comparison only. */
const legacyClassifier: Classifier = (prev, anchor, m) => ({
  up: isUserScrollUp(prev, { scrollTop: m.scrollTop, scrollHeight: m.scrollHeight }),
  anchor,
})

/**
 * One slow drag against a live feed: a wheel event every frame, and a caption
 * landing every `captionEveryFrames` frames, after which the component pins to
 * the bottom iff the machine says it is following (the effect, the
 * ResizeObserver and the rAF correction all reduce to this).
 */
function simulateDrag(opts: {
  pxPerFrame: number
  frames: number
  captionEveryFrames: number
  classify: Classifier
}) {
  const s = makeScroller()
  let state: CaptionFollowState = INITIAL_CAPTION_FOLLOW
  let prev: ScrollSample | null = null
  let anchor: FollowAnchor = nextFollowAnchor(null, s.metrics())
  prev = { scrollTop: s.metrics().scrollTop, scrollHeight: s.metrics().scrollHeight }
  const trace: number[] = []

  for (let f = 1; f <= opts.frames; f++) {
    s.userDrag(opts.pxPerFrame)
    const m = s.metrics()
    const cls = opts.classify(prev, anchor, m)
    prev = { scrollTop: m.scrollTop, scrollHeight: m.scrollHeight }
    anchor = cls.anchor
    state = captionFollowReducer(state, cls.up ? { type: 'user-scrolled-up', metrics: m } : { type: 'scrolled', metrics: m })

    if (f % opts.captionEveryFrames === 0) {
      s.captionArrives()
      state = captionFollowReducer(state, { type: 'captions-changed' })
      if (shouldPinToBottom(state)) {
        s.pin()
        const pm = s.metrics()
        prev = { scrollTop: pm.scrollTop, scrollHeight: pm.scrollHeight }
        anchor = nextFollowAnchor(anchor, pm)
      }
    }
    trace.push(Math.round(s.distance()))
  }
  return { s, state, trace }
}

describe('the pre-fix classifier cannot see a slow drag (documents the defect)', () => {
  it('a 1px-per-event drag is never upward intent under consecutive-sample comparison', () => {
    let prev: ScrollSample = { scrollTop: 3430, scrollHeight: 3600 }
    for (let i = 1; i <= 40; i++) {
      const next = { scrollTop: 3430 - i, scrollHeight: 3600 }
      expect(isUserScrollUp(prev, next)).toBe(false)
      prev = next
    }
  })

  it('so against a live feed the reader is dragged back to the bottom every time (the observed lock)', () => {
    const { s, trace } = simulateDrag({
      pxPerFrame: 1,
      frames: 120,
      captionEveryFrames: 7,
      classify: legacyClassifier,
    })
    expect(s.distance()).toBeLessThan(UPWARD_INTENT_PX + 40)
    // The trace sawtooths: it keeps returning near zero instead of growing.
    expect(trace.filter((d) => d <= 2).length).toBeGreaterThan(5)
  })
})

describe('anchor-based upward intent', () => {
  it('registers a slow drag once it has travelled UPWARD_INTENT_PX from the bottom, not per event', () => {
    let anchor: FollowAnchor = nextFollowAnchor(null, { scrollTop: 3430, scrollHeight: 3600, clientHeight: CLIENT })
    const seen: boolean[] = []
    for (let i = 1; i <= 5; i++) {
      const next = { scrollTop: 3430 - i, scrollHeight: 3600 }
      seen.push(isScrolledUpFromAnchor(anchor, next))
      // Still within 1px of the bottom does not move the anchor; beyond it never does.
      anchor = nextFollowAnchor(anchor, { ...next, clientHeight: CLIENT })
    }
    expect(seen).toEqual([false, false, true, true, true])
  })

  it('ignores sub-pixel jitter around the bottom — that is layout noise, not a gesture', () => {
    const anchor: FollowAnchor = { scrollTop: 3430, scrollHeight: 3600 }
    for (const jitter of [0.2, 0.4, 0.9, 1.4, 2.5]) {
      expect(isScrolledUpFromAnchor(anchor, { scrollTop: 3430 - jitter, scrollHeight: 3600 })).toBe(false)
    }
  })

  it('never reads a clamp from trimmed history as a gesture (scrollHeight shrank)', () => {
    const anchor: FollowAnchor = { scrollTop: 3430, scrollHeight: 3600 }
    expect(isScrolledUpFromAnchor(anchor, { scrollTop: 3380, scrollHeight: 3550 })).toBe(false)
  })

  it('has no opinion before any bottom position was ever recorded', () => {
    expect(isScrolledUpFromAnchor(null, { scrollTop: 10, scrollHeight: 3600 })).toBe(false)
  })

  it('only moves the anchor while the reader is actually at the bottom', () => {
    const atBottom = { scrollTop: 3430, scrollHeight: 3600, clientHeight: CLIENT }
    const first = nextFollowAnchor(null, atBottom)
    expect(first).toEqual({ scrollTop: 3430, scrollHeight: 3600 })
    // Scrolled away: the anchor must stay where the reader left the bottom.
    expect(nextFollowAnchor(first, { scrollTop: 3000, scrollHeight: 3600, clientHeight: CLIENT })).toBe(first)
    // New content landed and the reader was pinned again: the anchor follows.
    expect(nextFollowAnchor(first, { scrollTop: 3464, scrollHeight: 3634, clientHeight: CLIENT })).toEqual({
      scrollTop: 3464,
      scrollHeight: 3634,
    })
  })
})

describe('classifyHistoryScroll — the fix', () => {
  it('lets a 1px-per-frame drag leave the bottom and STAY there while captions keep arriving', () => {
    const { s, state, trace } = simulateDrag({
      pxPerFrame: 1,
      frames: 120,
      captionEveryFrames: 7,
      classify: classifyHistoryScroll,
    })
    expect(state.following).toBe(false)
    // Monotonic-ish growth, never a snap back to the bottom.
    expect(s.distance()).toBeGreaterThan(100)
    expect(trace.slice(10).every((d) => d > 2)).toBe(true)
  })

  it('also holds for a 2px and a fast 12px drag', () => {
    for (const pxPerFrame of [2, 12]) {
      const { s, state } = simulateDrag({ pxPerFrame, frames: 40, captionEveryFrames: 5, classify: classifyHistoryScroll })
      expect(state.following).toBe(false)
      expect(s.distance()).toBeGreaterThan(40)
    }
  })

  it('does NOT suspend following when the reader is simply sitting at the bottom as captions arrive', () => {
    const { s, state } = simulateDrag({ pxPerFrame: 0, frames: 120, captionEveryFrames: 5, classify: classifyHistoryScroll })
    expect(state.following).toBe(true)
    expect(s.distance()).toBe(0)
  })

  it('does NOT suspend following on history trimming at the cap (scrollHeight shrinks, scrollTop clamps)', () => {
    const anchor: FollowAnchor = { scrollTop: 3430, scrollHeight: 3600 }
    const out = classifyHistoryScroll(
      { scrollTop: 3430, scrollHeight: 3600 },
      anchor,
      { scrollTop: 3380, scrollHeight: 3550, clientHeight: CLIENT },
    )
    expect(out.up).toBe(false)
  })

  it('resumes following once the reader returns to the bottom', () => {
    let state: CaptionFollowState = { following: false, hasUnseen: true, overflowing: true }
    state = captionFollowReducer(state, {
      type: 'scrolled',
      metrics: { scrollTop: 3430, scrollHeight: 3600, clientHeight: CLIENT },
    })
    expect(state.following).toBe(true)
  })
})

describe('RecordingV2 uses the accumulating classifier and re-checks follow when a pin lands', () => {
  // The component has no jsdom harness; the behaviour above is the pure logic,
  // and the real-component behaviour was verified against real Chromium wheel
  // events (see the incident notes). These pin the wiring so it cannot regress.
  const src = readFileSync(new URL('../components/RecordingV2.tsx', import.meta.url), 'utf8')

  it('classifies scrolls with the anchor-based classifier, not consecutive samples alone', () => {
    expect(src).toContain('classifyHistoryScroll(lastSample.current, followAnchor.current, metrics)')
    expect(src).not.toMatch(/const up = isUserScrollUp\(/)
  })

  it('a queued pin re-checks the follow state at write time, so it cannot undo a drag that began a frame later', () => {
    expect(src).toContain('if (!force && !shouldPinToBottom(followRef.current)) return')
  })

  it('only Jump to latest bypasses that check', () => {
    expect(src).toContain("pinToBottom('smooth', true)")
    expect(src.match(/pinToBottom\([^)]*true\)/g)).toHaveLength(1)
  })

  it('still has no wheel handler — scrolling stays entirely native', () => {
    expect(src).not.toMatch(/onWheel|addEventListener\(['"]wheel/)
  })
})
