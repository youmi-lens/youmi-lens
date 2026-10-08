/**
 * The Recording screen's caption stack, built from caption IDENTITY.
 *
 * The earlier stack was built from two joined strings (all committed originals,
 * all committed translations) that were each re-split into sentences on their
 * own. That cannot pair anything — which sentence of the translation answers
 * which sentence of the original is simply not recorded — and it silently
 * assumed a space after sentence punctuation, so Japanese and Chinese (no such
 * space) collapsed into one giant "sentence": no history rows, nothing to scroll.
 *
 * Here every row is made of whole captions (`LiveCaptionPair`), each carrying its
 * OWN translation. A row's translation is built only from the translations of
 * the captions inside that row, so an original can never be shown beside another
 * caption's translation, and the layout does not depend on the script.
 *
 * Pure: no React, no engine, no timers.
 */
import type { CaptionScript } from './contentLanguages'
import type { LiveCaptionPair } from './liveCaptionSessionModel'
import { buildCaptionStack } from './recordingV2Captions'

export type RowTranslationState = 'none' | 'partial' | 'interim' | 'final'

export type CaptionRow = {
  /** The id of the first caption in the row — stable while the row grows. */
  key: string
  original: string
  /** Empty when translation is off or none of this row's captions has one yet. */
  translation: string
  translationState: RowTranslationState
  /** True only for the caption still being spoken (an open draft). */
  live?: boolean
}

export type BilingualStack = {
  /** Settled rows, oldest first. Rendered faded and scrollable. */
  history: CaptionRow[]
  /** The caption being spoken now (or the latest one), fixed and full strength. */
  current: CaptionRow | null
}

export type StackOptions = {
  sourceScript: CaptionScript
  translationScript: CaptionScript
  /** Words separated by spaces? Defaults to `script === 'latin'`; Korean is `cjk` yet spaced. */
  sourceSpaced?: boolean
  translationSpaced?: boolean
  translationEnabled: boolean
  /** Bounds the DOM in a two-hour lecture; the full text is persisted elsewhere. */
  maxHistory?: number
}

/**
 * A row ends where the speaker's sentence ends: terminal punctuation in either
 * script, optionally followed by closing quotes/brackets. No whitespace needed.
 */
const SENTENCE_END = /[.!?。！？…]["'’”）)\]」』]*\s*$/
/** A run with no terminal punctuation at all is still cut, so it stays readable. */
const ROW_SOFT_CAP_CHARS = 160

function joinFor(script: CaptionScript, parts: string[], spaced?: boolean): string {
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join((spaced ?? script === 'latin') ? ' ' : '')
}

function translationStateOf(pairs: LiveCaptionPair[]): RowTranslationState {
  const have = pairs.filter((p) => p.translationState !== 'none')
  if (have.length === 0) return 'none'
  if (have.length < pairs.length) return 'partial'
  return have.every((p) => p.translationState === 'final') ? 'final' : 'interim'
}

/**
 * A row's translation is built ONLY from translations that belong to captions inside it.
 * Captions covered by one group translation (the server's `source_ids`) are always a single
 * row, so that translation sits under exactly the originals it translates — the row
 * boundary comes from the server's identity, not from a guess about sentences.
 */
function rowOf(pairs: LiveCaptionPair[], o: StackOptions, live = false): CaptionRow {
  const first = pairs[0]
  const groupText = first.groupKey && pairs.every((p) => p.groupKey === first.groupKey) ? first.groupText : null
  const translation = !o.translationEnabled
    ? ''
    : groupText !== null
      ? groupText
      : joinFor(o.translationScript, pairs.map((p) => p.translation), o.translationSpaced)
  return {
    key: first.id,
    original: joinFor(o.sourceScript, pairs.map((p) => p.original), o.sourceSpaced),
    translation,
    translationState: !o.translationEnabled ? 'none' : groupText !== null ? 'final' : translationStateOf(pairs),
    ...(live ? { live: true } : {}),
  }
}

export function buildBilingualStack(
  pairs: readonly LiveCaptionPair[],
  draft: LiveCaptionPair | null,
  options: StackOptions,
): BilingualStack {
  const maxHistory = options.maxHistory ?? 80

  // The current row is the open caption. With none open, the latest settled caption stays on the
  // fixed line so it is never blank mid-lecture — and if a group translation covers it, the whole
  // group is the current row, because that is what the translation actually translates.
  const lastPair = draft ? null : pairs.length > 0 ? pairs[pairs.length - 1] : null
  const lastGroup = lastPair?.groupKey ?? null
  const currentMembers: LiveCaptionPair[] = draft
    ? [draft]
    : lastPair
      ? lastGroup
        ? pairs.filter((p) => p.groupKey === lastGroup)
        : [lastPair]
      : []
  const inCurrent = new Set(currentMembers.map((p) => p.id))
  const settled = draft ? pairs : pairs.filter((p) => !inCurrent.has(p.id))

  const rows: CaptionRow[] = []
  let run: LiveCaptionPair[] = []
  let runChars = 0
  const flush = () => {
    if (run.length > 0) rows.push(rowOf(run, options))
    run = []
    runChars = 0
  }
  for (const pair of settled) {
    if (pair.groupKey) {
      // A group is one row, whole. Anything pending before it closes first.
      if (run.length > 0 && run[0].groupKey !== pair.groupKey) flush()
      run.push(pair)
      continue
    }
    if (run.length > 0 && run[0].groupKey) flush()
    run.push(pair)
    runChars += pair.original.length
    if (SENTENCE_END.test(pair.original) || runChars >= ROW_SOFT_CAP_CHARS) flush()
  }
  flush()

  return {
    history: rows.length > maxHistory ? rows.slice(-maxHistory) : rows,
    current:
      currentMembers.length > 0 && currentMembers.some((p) => p.original.trim())
        ? rowOf(currentMembers, options, Boolean(draft))
        : null,
  }
}

/**
 * The text-only stack, for the pipelines that have no caption identity at all
 * (own-key and stub captions: Whisper chunks and a separate translate call).
 * Behaviour is exactly what the screen did before: sentence rows for the
 * original, the translation shown only on the fixed line. The hosted live path
 * never uses it — it has identity and uses `buildBilingualStack`.
 */
export function buildTextStack(input: {
  sourceCommitted: string
  sourceDraft: string
  translationCommitted: string
  translationDraft: string
}): BilingualStack {
  const src = buildCaptionStack(input.sourceCommitted, input.sourceDraft)
  const tr = buildCaptionStack(input.translationCommitted, input.translationDraft)
  return {
    history: src.history.map((original, index) => ({
      key: `${index}-${original.slice(0, 24)}`,
      original,
      translation: '',
      translationState: 'none' as const,
    })),
    current: src.current
      ? {
          key: 'current',
          original: src.current,
          translation: tr.current,
          translationState: tr.current ? ('interim' as const) : ('none' as const),
          live: Boolean(input.sourceDraft.trim()),
        }
      : null,
  }
}
