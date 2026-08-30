/**
 * Presentation split for the active Recording screen's caption stack.
 *
 * The live caption engine hands the app two strings per language — committed
 * text and an in-progress draft — and nothing else. The approved Recording V2
 * layout needs three regions instead: scrollable faded history, one fixed
 * "current" line, and the translation pinned directly under it.
 *
 * This module does that split and nothing more. It reads no engine state,
 * subscribes to nothing and cannot affect capture, recovery or upload: the
 * recorder is untouched and this is a pure function of what it already emits.
 */

export type CaptionStack = {
  /** Settled phrases, oldest first. Rendered faded and scrollable. */
  history: string[]
  /** The phrase being spoken right now. Rendered fixed and full strength. */
  current: string
}

/**
 * Sentence boundaries for the languages this app captions.
 *
 * Latin `.` `!` `?` plus CJK `。！？` — a caption stream has no paragraph marks,
 * so terminal punctuation is the only signal available. Text with no
 * punctuation at all stays a single chunk rather than being chopped by length,
 * because an arbitrary cut mid-clause reads worse than one long line.
 */
const SENTENCE_END = /(?<=[.!?。！？])\s+/

export function splitCaptionSentences(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  return trimmed
    .split(SENTENCE_END)
    .map((part) => part.trim())
    .filter(Boolean)
}

/**
 * Build the three-region stack.
 *
 * While a draft exists it IS the current line and every committed sentence is
 * history. With no draft, the most recently committed sentence stays on the
 * current line so the fixed row is never blank mid-lecture.
 *
 * `maxHistory` bounds the DOM during a two-hour lecture; the full transcript is
 * persisted from the engine's own accumulators, never from this view.
 */
export function buildCaptionStack(
  committed: string,
  draft: string,
  maxHistory = 60,
): CaptionStack {
  const pending = draft.trim()
  const sentences = splitCaptionSentences(committed)

  const history = pending ? sentences : sentences.slice(0, -1)
  const current = pending || (sentences.length > 0 ? sentences[sentences.length - 1] : '')

  return {
    history: history.length > maxHistory ? history.slice(-maxHistory) : history,
    current,
  }
}
