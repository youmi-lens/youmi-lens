/**
 * Auto-follow state machine for the caption history scroller.
 *
 * The first implementation pinned the scroller with
 * `scrollTop = scrollHeight` inside an effect that ran on every caption update.
 * That is correct only while the reader wants the newest line: the moment they
 * scroll up to re-read something, the next caption — a second or two away —
 * yanks them back to the bottom. The area was unreadable during a live lecture.
 *
 * So following is a STATE, not an unconditional side effect:
 *
 *      following ──user scrolls away from the bottom──▶ suspended
 *      suspended ──user returns near the bottom───────▶ following
 *      suspended ──"Jump to latest"───────────────────▶ following
 *
 * New captions never change the state. They are only allowed to move the
 * scroller while it is already `following`.
 *
 * This module is pure and DOM-free so the machine can be tested without a
 * layout engine; the component supplies real scroll metrics.
 */

/**
 * How close to the bottom still counts as "at the bottom", in CSS pixels.
 *
 * Sub-pixel layout and momentum scrolling routinely leave a residue of a pixel
 * or two, so an exact comparison would drop out of follow mode on its own. 32px
 * is inside the 24–48px band and is under one line of history (~34px), so a
 * deliberate one-line scroll up is still read as intent to stop following.
 */
export const NEAR_BOTTOM_PX = 32

export type CaptionScrollMetrics = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export type CaptionFollowState = {
  /** True while new captions may move the scroller. */
  following: boolean
  /** True when captions arrived that the reader has not scrolled down to. */
  hasUnseen: boolean
  /**
   * True when the content is actually taller than the viewport.
   *
   * Nothing about "the reader scrolled away" can be true while this is false:
   * a list that cannot scroll has no away to be. Tracking it explicitly is what
   * stops the Jump button appearing over four lines of history.
   */
  overflowing: boolean
}

export const INITIAL_CAPTION_FOLLOW: CaptionFollowState = {
  following: true,
  hasUnseen: false,
  overflowing: false,
}

export function distanceFromBottom(metrics: CaptionScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight)
}

/** Content shorter than the viewport is trivially "at the bottom". */
export function isNearBottom(metrics: CaptionScrollMetrics, threshold = NEAR_BOTTOM_PX): boolean {
  if (metrics.scrollHeight <= metrics.clientHeight) return true
  return distanceFromBottom(metrics) <= threshold
}

export type CaptionFollowEvent =
  /** The scroll container reported a position. Source of user intent. */
  | { type: 'scrolled'; metrics: CaptionScrollMetrics }
  /**
   * The reader physically scrolled upward — a two-finger trackpad gesture or a
   * wheel notch. Suspends immediately, without waiting to cross the near-bottom
   * threshold.
   *
   * Position alone is not enough. A slow trackpad drag moves a few pixels per
   * frame, so for the first ~32px the reader is still "near the bottom" and the
   * next caption re-pins them — the view fights the gesture and feels stuck.
   * Intent is expressed by the gesture, not by how far it has travelled yet.
   */
  | { type: 'user-scrolled-up'; metrics: CaptionScrollMetrics }
  /** A caption was appended or updated. Must never change `following`. */
  | { type: 'captions-changed' }
  /** The reader asked to go back to the newest line. */
  | { type: 'jump-to-latest' }
  /** The container was resized. Must never change `following` either. */
  | { type: 'resized'; metrics: CaptionScrollMetrics }

/**
 * Return the previous object when nothing changed.
 *
 * Identity stability matters: the pin effect and the ResizeObserver both key on
 * this state, so a fresh object on every scroll frame would re-run them dozens
 * of times a second during a gesture.
 */
function settle(prev: CaptionFollowState, next: CaptionFollowState): CaptionFollowState {
  if (
    prev.following === next.following &&
    prev.hasUnseen === next.hasUnseen &&
    prev.overflowing === next.overflowing
  ) {
    return prev
  }
  return next
}

function canScroll(metrics: CaptionScrollMetrics): boolean {
  // 1px of slack: sub-pixel layout routinely reports a scrollHeight a fraction
  // above clientHeight for content that visibly fits.
  return metrics.scrollHeight - metrics.clientHeight > 1
}

export function captionFollowReducer(
  state: CaptionFollowState,
  event: CaptionFollowEvent,
): CaptionFollowState {
  switch (event.type) {
    case 'scrolled': {
      const overflowing = canScroll(event.metrics)
      // A list that cannot scroll is always following, by definition.
      if (!overflowing) return settle(state, { following: true, hasUnseen: false, overflowing })
      const near = isNearBottom(event.metrics)
      return settle(state, {
        following: near,
        hasUnseen: near ? false : state.hasUnseen,
        overflowing,
      })
    }

    case 'user-scrolled-up': {
      // Gesture intent only counts when there is somewhere to go. Suspending on
      // a list that cannot scroll is what put a Jump button over four lines of
      // history and made the screen look broken.
      if (!canScroll(event.metrics)) {
        return settle(state, { following: true, hasUnseen: false, overflowing: false })
      }
      if (!state.following) return state
      return { following: false, hasUnseen: false, overflowing: true }
    }

    case 'captions-changed':
      // Deliberately does NOT touch `following`. This is the whole point: a new
      // caption must not decide for the reader that they are done reading.
      if (state.following) return state.hasUnseen ? { ...state, hasUnseen: false } : state
      return state.hasUnseen ? state : { ...state, hasUnseen: true }

    case 'jump-to-latest':
      return settle(state, { following: true, hasUnseen: false, overflowing: state.overflowing })

    case 'resized': {
      // A resize is not a reading decision, so `following` survives it — but the
      // content may no longer overflow, and then there is nothing to be away
      // from.
      const overflowing = canScroll(event.metrics)
      if (!overflowing) return settle(state, { following: true, hasUnseen: false, overflowing })
      return settle(state, { ...state, overflowing })
    }

    default:
      return state
  }
}

/** Whether the caller should move the scroller to the newest line right now. */
export function shouldPinToBottom(state: CaptionFollowState): boolean {
  return state.following
}

/** One `scroll` reading, kept between events so direction can be derived. */
export type ScrollSample = { scrollTop: number; scrollHeight: number }

/**
 * Read "the reader scrolled upward" out of the native scroll position.
 *
 * `user-scrolled-up` is what stops auto-follow the instant a gesture begins,
 * rather than after it has travelled NEAR_BOTTOM_PX. Nothing dispatched it,
 * because the only honest source of that intent — a `wheel` handler — is
 * exactly what this screen may not have. Direction is therefore derived from
 * consecutive `scroll` positions instead: entirely passive, no `preventDefault`,
 * no synthetic scrolling, and it covers a trackpad, a wheel and Page Up alike.
 *
 * Two readings are deliberately NOT treated as upward intent:
 *
 *   · a shrinking `scrollHeight` — history is capped, so dropping the oldest
 *     line makes the platform clamp `scrollTop` down on its own. Reading that
 *     as a gesture would suspend follow by itself once a lecture got long.
 *   · a move of a single pixel — sub-pixel layout jitters by a fraction during
 *     momentum and would otherwise register as a scroll up.
 */
export function isUserScrollUp(prev: ScrollSample | null, next: ScrollSample): boolean {
  if (!prev) return false
  if (next.scrollHeight < prev.scrollHeight) return false
  return next.scrollTop < prev.scrollTop - 1
}

/**
 * Whether "Jump to latest" may be shown.
 *
 * All three must hold, and the first is the one that was missing: the history
 * has to actually overflow. A screenshot of four caption lines with a Jump
 * button floating over them is the symptom of checking only `following`.
 */
export function shouldShowJumpToLatest(state: CaptionFollowState): boolean {
  return state.overflowing && !state.following
}
