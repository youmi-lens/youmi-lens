/**
 * Lecture title integrity — the single authority on what a title *is*.
 *
 * THE INCIDENT THIS PREVENTS
 *
 * iPad's rename writes `.update({ title, updated_at })` (`lib/store.tsx:903`).
 * Before the Phase 1B migration, `recordings.updated_at` did not exist, so that
 * statement failed with `42703` and the rename never reached the cloud. It
 * looked fine because iPad's merge preferred the local title whenever the remote
 * row had no `updated_at` (`lib/store.tsx:437-441`):
 *
 *     preferLocalTitle = localTitle && localTitleUpdatedAt &&
 *                        (!remoteUpdatedAt || localTitleUpdatedAt > remoteUpdatedAt)
 *
 * The Phase 1B migration then added
 *
 *     add column if not exists updated_at timestamptz not null default now()
 *
 * which stamped EVERY pre-existing row with the migration instant. Every
 * historical `titleUpdatedAt` is older than that, so `preferLocalTitle` became
 * false for every rename the user had ever made, and the merge fell through to
 * the remote value — a placeholder. The local originals were then written back
 * over in AsyncStorage.
 *
 * THE INVARIANT
 *
 * A placeholder or empty title must NEVER displace a meaningful one on the
 * strength of a newer timestamp. Timestamps are consulted only after both sides
 * have been classified, and only when the two sides are of equal quality.
 *
 * A migration touching a bookkeeping column must not be able to change what a
 * lecture is called. Under these rules it cannot.
 *
 * This module is pure: no React, no Supabase, no I/O.
 */

export type LectureTitleClass = 'meaningful' | 'placeholder' | 'empty'

/**
 * Titles that mean "this lecture has no name", in every language the product
 * ships, plus the historical variants written by older builds.
 *
 * Compared case-insensitively after trimming. This list is the ONLY place such
 * strings may live — scattering `=== 'Untitled lecture'` through the codebase
 * is how a placeholder becomes indistinguishable from a real name.
 */
export const LECTURE_TITLE_PLACEHOLDERS: readonly string[] = [
  // English, current and historical (iPad used title case).
  'untitled',
  'untitled lecture',
  // The six shipped `recording.untitled` values.
  '未命名讲次',
  '無題の講義',
  'séance sans titre',
  'clase sin título',
  '제목 없는 강의',
  // Course-level placeholder, seen on lectures written by older code paths.
  'untitled course',
]

export function classifyLectureTitle(title: string | null | undefined): LectureTitleClass {
  const trimmed = (title ?? '').trim()
  if (!trimmed) return 'empty'
  return LECTURE_TITLE_PLACEHOLDERS.includes(trimmed.toLowerCase()) ? 'placeholder' : 'meaningful'
}

/** True only for a title a human actually chose. */
export function isMeaningfulLectureTitle(title: string | null | undefined): boolean {
  return classifyLectureTitle(title) === 'meaningful'
}

export type TitleCandidate = {
  title: string | null | undefined
  /**
   * When this side's title was last edited BY A USER.
   *
   * Deliberately not the row's `updated_at`: that moves for reasons which have
   * nothing to do with the name — a course assignment, a transcript write, or a
   * schema migration adding a column with `default now()`. Feeding row-level
   * mtime in here is precisely what caused the incident.
   */
  editedAt?: string | number | null
}

export type TitleMergeSide = 'local' | 'remote'

export type TitleMergeResult = {
  title: string
  winner: TitleMergeSide
  reason:
    | 'meaningful-beats-placeholder'
    | 'meaningful-beats-empty'
    | 'newer-meaningful-edit'
    | 'meaningful-kept-no-timestamps'
    | 'newer-placeholder'
    | 'both-empty'
}

function toEpoch(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Decide which side's title survives a merge.
 *
 * Rules, in order — quality first, time only as a tie-break:
 *
 *   1. meaningful local vs placeholder/empty remote → local
 *   2. placeholder/empty local vs meaningful remote → remote
 *   3. meaningful vs meaningful → the newer USER EDIT; if that cannot be
 *      established, the local value is kept (rule 6: a missing timestamp must
 *      never discard a meaningful title)
 *   4. placeholder vs placeholder → newer wins; ties keep local
 *   5. both empty → empty string, for the caller to render a fallback over
 */
export function mergeLectureTitle(
  local: TitleCandidate,
  remote: TitleCandidate,
): TitleMergeResult {
  const localTrim = (local.title ?? '').trim()
  const remoteTrim = (remote.title ?? '').trim()
  const localClass = classifyLectureTitle(localTrim)
  const remoteClass = classifyLectureTitle(remoteTrim)

  // ── Rules 1 and 2 · quality decides, before any clock is read ────────────
  if (localClass === 'meaningful' && remoteClass !== 'meaningful') {
    return {
      title: localTrim,
      winner: 'local',
      reason: remoteClass === 'empty' ? 'meaningful-beats-empty' : 'meaningful-beats-placeholder',
    }
  }
  if (remoteClass === 'meaningful' && localClass !== 'meaningful') {
    return {
      title: remoteTrim,
      winner: 'remote',
      reason: localClass === 'empty' ? 'meaningful-beats-empty' : 'meaningful-beats-placeholder',
    }
  }

  // ── Rule 3 · two real names: the newer USER EDIT wins ────────────────────
  if (localClass === 'meaningful' && remoteClass === 'meaningful') {
    const localAt = toEpoch(local.editedAt)
    const remoteAt = toEpoch(remote.editedAt)
    if (localAt !== null && remoteAt !== null) {
      return remoteAt > localAt
        ? { title: remoteTrim, winner: 'remote', reason: 'newer-meaningful-edit' }
        : { title: localTrim, winner: 'local', reason: 'newer-meaningful-edit' }
    }
    // Rule 6. One side has no verified edit time, so nothing is provably newer
    // and the local value stands. Guessing here is what loses data.
    return { title: localTrim, winner: 'local', reason: 'meaningful-kept-no-timestamps' }
  }

  // ── Rules 4 and 5 · nothing meaningful on either side ────────────────────
  if (localClass === 'empty' && remoteClass === 'empty') {
    return { title: '', winner: 'local', reason: 'both-empty' }
  }
  const localAt = toEpoch(local.editedAt)
  const remoteAt = toEpoch(remote.editedAt)
  if (localAt !== null && remoteAt !== null && remoteAt > localAt) {
    return { title: remoteTrim, winner: 'remote', reason: 'newer-placeholder' }
  }
  if (localClass === 'placeholder') {
    return { title: localTrim, winner: 'local', reason: 'newer-placeholder' }
  }
  return { title: remoteTrim, winner: 'remote', reason: 'newer-placeholder' }
}

/* ── Write safety ───────────────────────────────────────────────────────────
   The read side above is only half the protection. These guard the write side:
   a display fallback must never travel back into a repository call. */

/**
 * The title to PERSIST, or `undefined` meaning "leave the stored value alone".
 *
 * Any update that is not an explicit rename should pass its incoming value
 * through here. A placeholder or empty string returns `undefined`, and the
 * caller must then omit `title` from the payload entirely rather than writing
 * a default over a name the user chose.
 */
export function titleForPersist(title: string | null | undefined): string | undefined {
  const trimmed = (title ?? '').trim()
  return classifyLectureTitle(trimmed) === 'meaningful' ? trimmed : undefined
}

/**
 * Build a metadata PATCH that can only ever contain fields it was explicitly
 * given. `title` is included only when it is a real rename.
 *
 * Passing a whole recording object into an update is what turns a course move
 * into a title rewrite; this makes that shape impossible to express.
 */
export function buildLectureMetadataPatch(
  input: {
    /** Present only for an explicit rename. */
    title?: string | null
    /** Present only for an explicit course change. */
    course?: string | null
    courseId?: string | null
  },
  nowIso: string = new Date().toISOString(),
): { title?: string; title_updated_at?: string; course?: string; course_id?: string | null } {
  const patch: {
    title?: string
    title_updated_at?: string
    course?: string
    course_id?: string | null
  } = {}

  if (input.title !== undefined) {
    const safe = titleForPersist(input.title)
    // An explicit rename to a placeholder is refused rather than persisted:
    // the fallback belongs to the render layer, never to the row.
    if (safe !== undefined) {
      patch.title = safe
      // The freshness clock is stamped in the SAME logical update as the name,
      // and only ever alongside it. A title with no clock cannot be ordered
      // against a competing rename on another device, so the other side has to
      // fall back to "keep local" and this rename becomes invisible to it.
      //
      // It is emitted only here — a move, a transcript write or a summary write
      // never reaches this branch, so none of them can advance title freshness.
      patch.title_updated_at = nowIso
    }
  }
  if (input.course !== undefined && input.course !== null) patch.course = input.course
  if (input.courseId !== undefined) patch.course_id = input.courseId

  return patch
}

/**
 * Reconcile the titles of a freshly-read library against what is already on
 * screen, so an in-flight local rename is not undone by a row that was read
 * before it landed.
 *
 * This is `mergeLectureTitle` applied per id, and nothing else: only `title`
 * can differ in the result. Transcript, translation, summary, notes, marks and
 * every other column come from the remote row untouched, because those are
 * server-authoritative and have no client-side conflict rule.
 */
export function reconcileLectureTitles<
  T extends { id: string; title: string; titleUpdatedAt?: number | null },
>(local: readonly T[], remote: readonly T[]): T[] {
  if (local.length === 0) return [...remote]
  const byId = new Map(local.map((row) => [row.id, row]))
  return remote.map((row) => {
    const known = byId.get(row.id)
    if (!known) return row
    const merged = mergeLectureTitle(
      { title: known.title, editedAt: known.titleUpdatedAt },
      { title: row.title, editedAt: row.titleUpdatedAt },
    )
    if (merged.winner === 'remote' || merged.title === row.title) return row
    // Local won: keep the local name AND the local clock, so the next
    // comparison still orders correctly instead of losing to its own remote.
    return { ...row, title: merged.title, titleUpdatedAt: known.titleUpdatedAt }
  })
}
