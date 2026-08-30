/**
 * Notes and Marks — the two account-level lecture fields that carry their own
 * freshness clocks.
 *
 * They are grouped here because they share one rule and one failure mode. The
 * rule: `notes_updated_at` and `marks_updated_at` decide their own field and
 * nothing else, so a transcript write, a summary write, a rename or a deletion
 * can never make Notes or Marks look fresher than they are. The failure mode:
 * both arrive as whatever the database happened to hold, so both are parsed
 * defensively at the edge rather than trusted into the render tree.
 *
 * MARKS V1, frozen — and deliberately not extended here:
 *
 *   `recordings.marked_timestamps` is `number[]`. Each number is an elapsed
 *   MILLISECOND offset from the start of the recording. There is no id, no
 *   label, no per-mark metadata and no sort requirement. Duplicates are legal.
 *   Array order is meaningful only in that it is preserved. The whole array is
 *   replaced on every write.
 *
 * Nothing in this module invents an object schema, sorts, or de-duplicates: a
 * client that quietly normalised the array would hand a different array back to
 * every other device on the next write.
 *
 * Notes are plain shared text. They are NOT the iPad Notebook — no strokes, no
 * pages, no canvas, no images. That is a separate future feature.
 *
 * Pure: no React, no Supabase, no storage.
 */

/* ── Marks ──────────────────────────────────────────────────────────────── */

/**
 * Read a stored marks array into the `number[]` the contract promises.
 *
 * The column is typed `unknown[]` all the way from PostgREST because it is
 * JSON, and malformed content must degrade to "no marks" rather than take the
 * lecture down. What survives:
 *
 *   · finite, non-negative numbers only — `NaN`, `Infinity` and negatives
 *     cannot be seeked to and are dropped;
 *   · order, exactly as stored;
 *   · duplicates, exactly as stored.
 *
 * Numeric strings are accepted because JSON round-trips through other clients
 * have historically produced them, and refusing a `"1500"` would silently lose
 * a real mark. Anything else — objects, null, booleans — is dropped.
 */
export function parseMarks(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  const out: number[] = []
  for (const value of raw) {
    const ms =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
          ? Number(value)
          : Number.NaN
    if (Number.isFinite(ms) && ms >= 0) out.push(ms)
  }
  return out
}

/**
 * A mark as a clock the user can read: `00:01`, `06:12`, `1:02:03`.
 *
 * Two-digit minutes below an hour, so a column of marks aligns. Milliseconds
 * are never shown — they are a storage detail, not a lecture position.
 */
export function formatMarkClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '00:00'
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** Where the audio element must be moved to for this mark. */
export function markSeekSeconds(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0
  return ms / 1000
}

/**
 * Append one mark at the given playback position.
 *
 * No sort, no de-duplicate, no rounding beyond whole milliseconds: marking the
 * same moment twice is the user's business, and reordering would rewrite marks
 * this device did not create.
 */
export function appendMark(marks: readonly number[], atMs: number): number[] {
  if (!Number.isFinite(atMs) || atMs < 0) return [...marks]
  return [...marks, Math.round(atMs)]
}

/* ── Freshness ──────────────────────────────────────────────────────────── */

/**
 * Whether the remote side of one field is newer than the local side.
 *
 * A missing clock never wins. That is the same rule the title merge uses and it
 * exists for the same reason: an absent timestamp is not evidence of anything,
 * and treating it as epoch 0 would let whichever side forgot to stamp lose
 * every conflict it should have won.
 */
function remoteIsNewer(localAt: number | null | undefined, remoteAt: number | null | undefined): boolean {
  if (typeof remoteAt !== 'number' || !Number.isFinite(remoteAt)) return false
  if (typeof localAt !== 'number' || !Number.isFinite(localAt)) return true
  return remoteAt > localAt
}

export type AnnotationSide = {
  notes?: string
  notesUpdatedAt?: number | null
  markedTimestamps?: unknown[]
  marksUpdatedAt?: number | null
}

export type AnnotationMerge = {
  notes: string | undefined
  notesUpdatedAt: number | null | undefined
  markedTimestamps: unknown[] | undefined
  marksUpdatedAt: number | null | undefined
  notesWinner: 'local' | 'remote'
  marksWinner: 'local' | 'remote'
}

/**
 * Merge one lecture's Notes and Marks, each by its OWN clock.
 *
 * The two fields are resolved independently on purpose: editing Notes on this
 * Mac while another device adds a Mark must keep both, and a single row-level
 * `updated_at` cannot express that. Nothing else about the row is considered —
 * transcript, translation and summary are server-authoritative and are never
 * consulted here.
 *
 * The winning side's clock travels with its value, so the next refresh still
 * orders correctly instead of losing to its own stale remote.
 */
export function mergeLectureAnnotations(
  local: AnnotationSide,
  remote: AnnotationSide,
): AnnotationMerge {
  const notesRemoteWins = remoteIsNewer(local.notesUpdatedAt, remote.notesUpdatedAt)
  const marksRemoteWins = remoteIsNewer(local.marksUpdatedAt, remote.marksUpdatedAt)

  // Local is the default. A refresh that carried no clock at all must not
  // silently replace text the user is looking at.
  return {
    notes: notesRemoteWins ? remote.notes : local.notes,
    notesUpdatedAt: notesRemoteWins ? remote.notesUpdatedAt : local.notesUpdatedAt,
    markedTimestamps: marksRemoteWins ? remote.markedTimestamps : local.markedTimestamps,
    marksUpdatedAt: marksRemoteWins ? remote.marksUpdatedAt : local.marksUpdatedAt,
    notesWinner: notesRemoteWins ? 'remote' : 'local',
    marksWinner: marksRemoteWins ? 'remote' : 'local',
  }
}

/**
 * Apply `mergeLectureAnnotations` across a freshly-read library.
 *
 * Shaped exactly like `reconcileLectureTitles`: rows the caller has never seen
 * pass through untouched, and a row missing from the refresh is not re-added —
 * whether a lecture exists at all is the deletion contract's decision, never
 * this function's.
 */
/** Content equality for a marks array — ignores nothing, sorts nothing, just compares. */
function marksEqual(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((value, i) => value === b[i])
}

export function reconcileLectureAnnotations<T extends { id: string } & AnnotationSide>(
  local: readonly T[],
  remote: readonly T[],
): T[] {
  if (local.length === 0) return [...remote]
  const byId = new Map(local.map((row) => [row.id, row]))
  return remote.map((row) => {
    const known = byId.get(row.id)
    if (!known) return row
    const merged = mergeLectureAnnotations(known, row)
    // A tie (equal clocks) defaults local, but if the values are the same
    // content the row already has, there is nothing to override — return it
    // untouched rather than manufacturing an equivalent copy.
    const notesUnchanged = merged.notesWinner === 'remote' || merged.notes === row.notes
    const marksUnchanged =
      merged.marksWinner === 'remote' || marksEqual(merged.markedTimestamps, row.markedTimestamps)
    if (notesUnchanged && marksUnchanged) return row
    return {
      ...row,
      notes: merged.notes,
      notesUpdatedAt: merged.notesUpdatedAt,
      markedTimestamps: merged.markedTimestamps,
      marksUpdatedAt: merged.marksUpdatedAt,
    }
  })
}
