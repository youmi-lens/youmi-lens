/**
 * Caption auto-follow state machine.
 *
 * The regression this guards: the scroller was pinned with
 * `scrollTop = scrollHeight` in an effect that ran on every caption update, so
 * scrolling up to re-read something was undone by the next caption a second
 * later. The invariant that matters is therefore negative — a caption arriving
 * must never change the follow state.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  captionFollowReducer,
  distanceFromBottom,
  INITIAL_CAPTION_FOLLOW,
  isNearBottom,
  isUserScrollUp,
  NEAR_BOTTOM_PX,
  shouldPinToBottom,
  shouldShowJumpToLatest,
  type CaptionFollowState,
} from './captionAutoFollow'

/** A scroller 400px tall over 2000px of history, `fromBottom` px from the end. */
const at = (fromBottom: number) => ({
  scrollTop: 2000 - 400 - fromBottom,
  scrollHeight: 2000,
  clientHeight: 400,
})

const suspended: CaptionFollowState = { following: false, hasUnseen: false, overflowing: true }
/** Content that fits: 300px of history in a 400px viewport. */
const fits = { scrollTop: 0, scrollHeight: 300, clientHeight: 400 }

describe('near-bottom detection', () => {
  it('measures the distance from the bottom edge', () => {
    expect(distanceFromBottom(at(0))).toBe(0)
    expect(distanceFromBottom(at(120))).toBe(120)
  })

  it('never reports a negative distance when overscrolled', () => {
    expect(distanceFromBottom({ scrollTop: 1700, scrollHeight: 2000, clientHeight: 400 })).toBe(0)
  })

  it('treats a residue inside the threshold as the bottom', () => {
    // Sub-pixel layout and momentum leave a pixel or two; an exact comparison
    // would drop out of follow mode by itself.
    expect(isNearBottom(at(0))).toBe(true)
    expect(isNearBottom(at(NEAR_BOTTOM_PX))).toBe(true)
    expect(isNearBottom(at(NEAR_BOTTOM_PX + 1))).toBe(false)
  })

  it('uses a threshold inside the required 24-48px band', () => {
    expect(NEAR_BOTTOM_PX).toBeGreaterThanOrEqual(24)
    expect(NEAR_BOTTOM_PX).toBeLessThanOrEqual(48)
  })

  it('treats content shorter than the viewport as the bottom', () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 400 })).toBe(true)
  })
})

describe('follow state machine', () => {
  it('follows by default', () => {
    expect(INITIAL_CAPTION_FOLLOW.following).toBe(true)
    expect(shouldPinToBottom(INITIAL_CAPTION_FOLLOW)).toBe(true)
  })

  it('scrolling up suspends following', () => {
    const next = captionFollowReducer(INITIAL_CAPTION_FOLLOW, {
      type: 'scrolled',
      metrics: at(300),
    })
    expect(next.following).toBe(false)
    expect(shouldPinToBottom(next)).toBe(false)
  })

  it('a one-line scroll up is enough to suspend', () => {
    // ~34px of line box. The threshold must be under one line, or a deliberate
    // nudge upward would be ignored.
    const next = captionFollowReducer(INITIAL_CAPTION_FOLLOW, { type: 'scrolled', metrics: at(40) })
    expect(next.following).toBe(false)
  })

  it('a wheel gesture upward suspends immediately, before 32px is travelled', () => {
    // The reported symptom: a slow two-finger drag moves a few pixels per
    // frame, stays "near the bottom", and every caption re-pins it. Intent has
    // to come from the gesture, not from how far it has got.
    const next = captionFollowReducer(INITIAL_CAPTION_FOLLOW, { type: 'user-scrolled-up', metrics: at(0) })
    expect(next.following).toBe(false)
    expect(shouldPinToBottom(next)).toBe(false)
  })

  it('a wheel gesture while already suspended changes nothing', () => {
    const withUnseen = captionFollowReducer(suspended, { type: 'captions-changed' })
    expect(captionFollowReducer(withUnseen, { type: 'user-scrolled-up', metrics: at(0) })).toBe(withUnseen)
  })

  it('a wheel up then captions then scroll back still resumes', () => {
    let s = captionFollowReducer(INITIAL_CAPTION_FOLLOW, { type: 'user-scrolled-up', metrics: at(0) })
    s = captionFollowReducer(s, { type: 'captions-changed' })
    expect(s).toMatchObject({ following: false, hasUnseen: true })
    s = captionFollowReducer(s, { type: 'scrolled', metrics: at(2) })
    expect(s).toEqual({ following: true, hasUnseen: false, overflowing: true })
  })

  it('a new caption does NOT resume following', () => {
    const next = captionFollowReducer(suspended, { type: 'captions-changed' })
    expect(next.following).toBe(false)
  })

  it('a new caption while suspended raises the unseen flag', () => {
    const next = captionFollowReducer(suspended, { type: 'captions-changed' })
    expect(next.hasUnseen).toBe(true)
  })

  it('twenty captions while suspended never force a jump', () => {
    let state = suspended
    for (let i = 0; i < 20; i++) state = captionFollowReducer(state, { type: 'captions-changed' })
    expect(state.following).toBe(false)
    expect(shouldPinToBottom(state)).toBe(false)
  })

  it('a caption while following does not raise the unseen flag', () => {
    const next = captionFollowReducer(INITIAL_CAPTION_FOLLOW, { type: 'captions-changed' })
    expect(next).toEqual(INITIAL_CAPTION_FOLLOW)
  })

  it('scrolling back near the bottom resumes and clears unseen', () => {
    const withUnseen = captionFollowReducer(suspended, { type: 'captions-changed' })
    const next = captionFollowReducer(withUnseen, { type: 'scrolled', metrics: at(4) })
    expect(next.following).toBe(true)
    expect(next.hasUnseen).toBe(false)
  })

  it('Jump to latest resumes from anywhere', () => {
    const withUnseen = captionFollowReducer(suspended, { type: 'captions-changed' })
    const next = captionFollowReducer(withUnseen, { type: 'jump-to-latest' })
    expect(next).toEqual({ following: true, hasUnseen: false, overflowing: true })
  })

  it('a resize preserves suspension', () => {
    // A window resize is not a reading decision.
    expect(captionFollowReducer(suspended, { type: 'resized', metrics: at(500) }).following).toBe(false)
  })

  it('a resize preserves following', () => {
    expect(captionFollowReducer(INITIAL_CAPTION_FOLLOW, { type: 'resized', metrics: at(500) }).following).toBe(true)
  })

  it('a resize preserves the unseen flag', () => {
    const withUnseen = captionFollowReducer(suspended, { type: 'captions-changed' })
    expect(captionFollowReducer(withUnseen, { type: 'resized', metrics: at(500) }).hasUnseen).toBe(true)
  })

  it('is stable: an unchanged scroll returns the same object', () => {
    // Identity stability keeps the pin effect from re-firing every scroll frame.
    const atBottom = captionFollowReducer(INITIAL_CAPTION_FOLLOW, {
      type: 'scrolled',
      metrics: at(0),
    })
    expect(captionFollowReducer(atBottom, { type: 'scrolled', metrics: at(0) })).toBe(atBottom)
    expect(captionFollowReducer(atBottom, { type: 'scrolled', metrics: at(4) })).toBe(atBottom)
  })

  /* ── Blocker 3: history that cannot scroll ──────────────────────────────
     Reported from the packaged app: a nearly-empty history with "Jump to
     latest" already showing. The wheel handler suspended follow on intent
     alone, so a gesture over a four-line list — which cannot scroll at all —
     put the UI into a state that has no way back except the button. */

  it('a wheel gesture over a list that cannot scroll does NOT suspend', () => {
    const next = captionFollowReducer(INITIAL_CAPTION_FOLLOW, {
      type: 'user-scrolled-up',
      metrics: fits,
    })
    expect(next.following).toBe(true)
    expect(next.overflowing).toBe(false)
    expect(shouldShowJumpToLatest(next)).toBe(false)
  })

  it('twenty wheel gestures over a short list never show the Jump button', () => {
    let s = INITIAL_CAPTION_FOLLOW
    for (let i = 0; i < 20; i++) {
      s = captionFollowReducer(s, { type: 'user-scrolled-up', metrics: fits })
      s = captionFollowReducer(s, { type: 'captions-changed' })
    }
    expect(shouldShowJumpToLatest(s)).toBe(false)
    expect(s.following).toBe(true)
  })

  it('a scroll report on a short list forces follow back on', () => {
    // Content shrinking below the viewport — captions cleared, window grown —
    // must not leave a stranded suspended state.
    const s = captionFollowReducer(suspended, { type: 'scrolled', metrics: fits })
    expect(s).toEqual({ following: true, hasUnseen: false, overflowing: false })
  })

  it('a resize that removes the overflow resumes following', () => {
    const s = captionFollowReducer(suspended, { type: 'resized', metrics: fits })
    expect(s.following).toBe(true)
    expect(shouldShowJumpToLatest(s)).toBe(false)
  })

  it('Jump to latest requires overflow AND being away from the bottom', () => {
    expect(shouldShowJumpToLatest({ following: true, hasUnseen: false, overflowing: true })).toBe(false)
    expect(shouldShowJumpToLatest({ following: false, hasUnseen: true, overflowing: false })).toBe(false)
    expect(shouldShowJumpToLatest({ following: false, hasUnseen: false, overflowing: true })).toBe(true)
  })

  it('the button only appears after a real scroll away on a real overflow', () => {
    let s = captionFollowReducer(INITIAL_CAPTION_FOLLOW, { type: 'scrolled', metrics: at(0) })
    expect(shouldShowJumpToLatest(s)).toBe(false)
    s = captionFollowReducer(s, { type: 'user-scrolled-up', metrics: at(0) })
    expect(shouldShowJumpToLatest(s)).toBe(true)
  })

  it('survives a full read-then-return round trip', () => {
    let s: CaptionFollowState = INITIAL_CAPTION_FOLLOW
    s = captionFollowReducer(s, { type: 'scrolled', metrics: at(500) })   // read history
    expect(s.following).toBe(false)
    s = captionFollowReducer(s, { type: 'captions-changed' })              // lecture continues
    s = captionFollowReducer(s, { type: 'captions-changed' })
    expect(s).toMatchObject({ following: false, hasUnseen: true })
    s = captionFollowReducer(s, { type: 'resized', metrics: at(500) })                       // window resized
    expect(s.following).toBe(false)
    s = captionFollowReducer(s, { type: 'jump-to-latest' })                // back to live
    expect(s).toEqual({ following: true, hasUnseen: false, overflowing: true })
  })
})

/**
 * Direction, derived from position.
 *
 * `user-scrolled-up` existed and was tested from the day the machine was
 * written, but nothing ever dispatched it: the component read only
 * `{ type: 'scrolled' }`, so the first NEAR_BOTTOM_PX of a trackpad gesture
 * still counted as "at the bottom" and the next caption pinned the reader
 * straight back down. That is the "auto-follow steals the scroll" report.
 */
describe('reading scroll direction from position', () => {
  it('a first reading is never a gesture — there is nothing to compare to', () => {
    expect(isUserScrollUp(null, { scrollTop: 1600, scrollHeight: 2000 })).toBe(false)
  })

  it('detects a scroll up far smaller than the near-bottom threshold', () => {
    // 8px: well inside NEAR_BOTTOM_PX, which is exactly the case the position
    // test alone gets wrong.
    expect(8).toBeLessThan(NEAR_BOTTOM_PX)
    expect(
      isUserScrollUp({ scrollTop: 1600, scrollHeight: 2000 }, { scrollTop: 1592, scrollHeight: 2000 }),
    ).toBe(true)
  })

  it('scrolling down is not scrolling up', () => {
    expect(
      isUserScrollUp({ scrollTop: 1200, scrollHeight: 2000 }, { scrollTop: 1400, scrollHeight: 2000 }),
    ).toBe(false)
  })

  it('a programmatic pin — which only ever moves down — is not a gesture', () => {
    expect(
      isUserScrollUp({ scrollTop: 1500, scrollHeight: 2000 }, { scrollTop: 1600, scrollHeight: 2000 }),
    ).toBe(false)
  })

  it('ignores sub-pixel jitter during momentum', () => {
    expect(
      isUserScrollUp({ scrollTop: 1600, scrollHeight: 2000 }, { scrollTop: 1599.4, scrollHeight: 2000 }),
    ).toBe(false)
  })

  it('trimming the oldest line is NOT a scroll up', () => {
    // History is capped, so a long lecture drops lines off the top and the
    // platform clamps scrollTop down by itself. Reading that as a gesture would
    // suspend follow with nobody touching the trackpad — and put a Jump button
    // on screen — once a lecture ran past the cap.
    expect(
      isUserScrollUp({ scrollTop: 1600, scrollHeight: 2000 }, { scrollTop: 1566, scrollHeight: 1966 }),
    ).toBe(false)
  })
})

describe('THE SYMPTOM · a short drag up must survive the next caption', () => {
  /** 400px viewport over 2000px of history. */
  const sample = (fromBottom: number) => ({
    scrollTop: 2000 - 400 - fromBottom,
    scrollHeight: 2000,
    clientHeight: 400,
  })

  it('an 8px drag stops auto-follow, and captions keep it stopped', () => {
    const before = sample(0)
    const after = sample(8)
    // What the component now does with the two readings.
    expect(isUserScrollUp(before, after)).toBe(true)

    let s = captionFollowReducer(INITIAL_CAPTION_FOLLOW, { type: 'user-scrolled-up', metrics: after })
    expect(shouldPinToBottom(s)).toBe(false)

    s = captionFollowReducer(s, { type: 'captions-changed' })
    s = captionFollowReducer(s, { type: 'captions-changed' })
    expect(shouldPinToBottom(s)).toBe(false)
  })

  it('the old wiring is what failed: the same drag left follow ON', () => {
    // Kept as the counter-example. Dispatching `scrolled` for this reading —
    // which is all the component used to do — keeps `following` true, so the
    // caption arriving ~400ms later yanks the reader back to the bottom.
    const s = captionFollowReducer(INITIAL_CAPTION_FOLLOW, { type: 'scrolled', metrics: sample(8) })
    expect(shouldPinToBottom(s)).toBe(true)
  })

  it('returning to the bottom resumes following', () => {
    let s = captionFollowReducer(INITIAL_CAPTION_FOLLOW, { type: 'user-scrolled-up', metrics: sample(8) })
    expect(s.following).toBe(false)
    // Scrolling back down reports a downward reading, so the component sends
    // `scrolled` and the near-bottom rule takes over again.
    expect(isUserScrollUp(sample(8), sample(0))).toBe(false)
    s = captionFollowReducer(s, { type: 'scrolled', metrics: sample(0) })
    expect(s.following).toBe(true)
    expect(shouldShowJumpToLatest(s)).toBe(false)
  })

  it('a short history can never show the Jump button, however the reader scrolls', () => {
    let s: CaptionFollowState = INITIAL_CAPTION_FOLLOW
    for (const ev of ['user-scrolled-up', 'scrolled'] as const) {
      s = captionFollowReducer(s, { type: ev, metrics: fits })
      expect(shouldShowJumpToLatest(s)).toBe(false)
    }
  })
})

describe('the component actually dispatches it', () => {
  const src = readFileSync(new URL('../components/RecordingV2.tsx', import.meta.url), 'utf8')

  it('the scroll handler chooses between up-intent and position', () => {
    // Intent is classified by `classifyHistoryScroll`, which combines the
    // consecutive-event step with accumulated travel from the bottom anchor.
    expect(src).toContain('classifyHistoryScroll(lastSample.current, followAnchor.current, metrics)')
    expect(src).toContain("up ? { type: 'user-scrolled-up', metrics } : { type: 'scrolled', metrics }")
  })

  it('still no custom wheel behaviour anywhere on this screen', () => {
    // Native scrolling is a requirement, not an implementation detail: the
    // momentum has to match Finder and Safari exactly.
    expect(src).not.toContain('onWheel')
    expect(src).not.toContain('preventDefault')
    expect(src).not.toContain('addEventListener')
  })

  it('there is exactly one scroll container in the live view', () => {
    const live = src.slice(src.indexOf('/* ── Live ─'))
    expect(live.match(/onScroll=/g)?.length).toBe(1)
  })
})
