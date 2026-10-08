/**
 * Notes persistence: ONE model.
 *
 *   The cloud row (`recordings.notes` + `notes_updated_at`) is the AUTHORITY.
 *   A per-lecture local DRAFT is only a write-ahead buffer in front of it.
 *
 * WHY (2026-10-04, QA 1007): "Ss" typed into Notes answered "Your notes were not
 * saved". The write itself was correct; production's `recordings` table has no
 * `notes` column (nor `notes_updated_at`, `marked_timestamps`, `marks_updated_at`,
 * `title_updated_at` — the Stage 4 migration was never applied there; staging has
 * them all). Nothing could ever have stored it. Around that real gap the client had
 * four defects, fixed here:
 *
 *   1. A draft lived only in component state, so leaving the lecture threw it
 *      away silently — even though its own error message promised "they are still
 *      here".
 *   2. A schema gap and a flaky network got the same "try again" message, so the
 *      user was invited to repeat something that could never succeed.
 *   3. Saves were not ordered: a save and a "save on leave" could overlap, and a
 *      late answer could mark a newer edit clean.
 *   4. A save's completion was applied to whichever lecture the editor happened to
 *      be showing by then.
 *
 * Rules this module enforces:
 *
 *   · WRITE-AHEAD. An edit is durable on this Mac the instant it is made, before
 *     any network. A failed save, a navigation, a quit or a crash cannot lose it.
 *   · The draft is removed only by (a) a confirmed save of exactly that text, or
 *     (b) a deliberate Discard, or (c) the server holding a NEWER note than the
 *     draft (the server wins). Never by an error, never by navigation.
 *   · One save in flight per lecture, ever. A second request joins it; edits made
 *     meanwhile are sent in a follow-up. Writes therefore reach the database in
 *     edit order and a repeat of a retry is a no-op.
 *   · The clock sent to the server is the draft's EDIT time, not the moment the
 *     response arrived, so retries are idempotent and cross-device ordering is
 *     about when the user wrote, not how slow the network was.
 *
 * Pure: no React, no Supabase. Storage and the network write are injected.
 */

/* ── Errors ──────────────────────────────────────────────────────────────── */

/**
 * The account's cloud cannot store Notes or Marks at all (the columns do not
 * exist). Retrying cannot help until the database is migrated, so the UI says
 * that instead of "try again".
 */
export class CloudAnnotationsUnavailableError extends Error {
  constructor() {
    super('This account’s cloud does not store Notes or Marks yet.')
    this.name = 'CloudAnnotationsUnavailableError'
  }
}

/** True for the schema gap, however it reached us. */
export function isNotesUnavailable(err: unknown): boolean {
  if (err instanceof CloudAnnotationsUnavailableError) return true
  const e = err as { name?: string; code?: string } | null
  return e?.name === 'CloudAnnotationsUnavailableError' || e?.code === '42703' || e?.code === 'PGRST204'
}

/* ── The local draft (write-ahead buffer) ────────────────────────────────── */

/** The slice of `Storage` this needs, so tests can inject a fake. */
export type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>

export type NotesDraft = {
  text: string
  /** Epoch ms of the user's last edit. Becomes `notes_updated_at` on save. */
  editedAt: number
}

/** A draft nobody has touched for this long is dropped rather than kept forever. */
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_DRAFTS = 100
const MAX_DRAFT_CHARS = 200_000
const keyFor = (userId: string) => `youmi.notesDrafts.v1:${userId}`

function defaultStorage(): DraftStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function parseDrafts(raw: string | null | undefined, now = Date.now()): Record<string, NotesDraft> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, NotesDraft> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const { text, editedAt } = value as { text?: unknown; editedAt?: unknown }
      if (typeof text !== 'string' || typeof editedAt !== 'number' || !Number.isFinite(editedAt)) continue
      if (now - editedAt > DRAFT_TTL_MS) continue
      out[id] = { text, editedAt }
    }
    return out
  } catch {
    return {}
  }
}

export function loadDrafts(userId: string, storage: DraftStorage | null = defaultStorage(), now = Date.now()): Record<string, NotesDraft> {
  if (!storage || !userId) return {}
  try {
    return parseDrafts(storage.getItem(keyFor(userId)), now)
  } catch {
    return {}
  }
}

/** Returns false when the store refused the write (unavailable, full, blocked). */
function writeDrafts(userId: string, drafts: Record<string, NotesDraft>, storage: DraftStorage | null): boolean {
  if (!storage) return false
  try {
    const entries = Object.entries(drafts)
      .sort((a, b) => a[1].editedAt - b[1].editedAt)
      .slice(-MAX_DRAFTS)
    storage.setItem(keyFor(userId), JSON.stringify(Object.fromEntries(entries)))
    return true
  } catch {
    return false
  }
}

/* ── What to show when a lecture is opened ───────────────────────────────── */

export type NotesOpenResolution = {
  /** The text the editor starts with. */
  text: string
  source: 'draft' | 'remote'
  /** An unsaved draft from an earlier visit was brought back. */
  restored: boolean
  /** The draft is moot (saved, identical, or superseded by a newer server note). */
  dropDraft: boolean
}

/**
 * Cloud is the authority; a draft only wins while it is genuinely newer and
 * genuinely different.
 *
 *   · no draft                                → the cloud note
 *   · draft identical to the cloud note       → the cloud note (draft is moot)
 *   · cloud note STAMPED NEWER than the draft → the cloud note (server wins; the
 *                                               draft is older than what is saved)
 *   · otherwise                               → the draft, restored, still unsaved
 *
 * An absent cloud clock never beats a draft: "no timestamp" is not evidence.
 */
export function resolveNotesForOpen(input: {
  remote: { notes?: string | null; notesUpdatedAt?: number | null }
  draft: NotesDraft | null
}): NotesOpenResolution {
  const remoteText = input.remote.notes ?? ''
  const draft = input.draft
  if (!draft) return { text: remoteText, source: 'remote', restored: false, dropDraft: false }
  if (draft.text === remoteText) return { text: remoteText, source: 'remote', restored: false, dropDraft: true }
  const remoteAt = input.remote.notesUpdatedAt
  if (typeof remoteAt === 'number' && Number.isFinite(remoteAt) && remoteAt > draft.editedAt) {
    return { text: remoteText, source: 'remote', restored: false, dropDraft: true }
  }
  return { text: draft.text, source: 'draft', restored: true, dropDraft: false }
}

/* ── The saver ───────────────────────────────────────────────────────────── */

export type NotesWrite = (recordingId: string, text: string, editedAt: number) => Promise<void>

export type NotesSaveOutcome =
  | { kind: 'saved'; text: string; editedAt: number }
  | { kind: 'failed'; reason: 'unavailable' | 'other'; error: unknown }
  /** There was no draft to save. */
  | { kind: 'nothing' }

export type NotesSaver = {
  /** Write-ahead: durable locally NOW, no network. Call on every change. */
  edit: (recordingId: string, text: string) => void
  /** Persist the latest draft. One in flight per lecture; callers join it. */
  save: (recordingId: string) => Promise<NotesSaveOutcome>
  draft: (recordingId: string) => NotesDraft | null
  /** A deliberate Discard — the only way (besides a confirmed save) a draft goes. */
  discard: (recordingId: string) => void
  /** Drop a draft that is moot (saved elsewhere / superseded). Not a user discard. */
  settle: (recordingId: string) => void
  pending: () => string[]
  inFlight: (recordingId: string) => boolean
}

export function createNotesSaver(opts: {
  userId: string
  write: NotesWrite
  storage?: DraftStorage | null
  now?: () => number
}): NotesSaver {
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage
  const now = opts.now ?? Date.now
  const { userId } = opts
  const running = new Map<string, Promise<NotesSaveOutcome>>()
  const rerun = new Set<string>()
  // In-session copy. Disk is the truth across launches; this keeps a session
  // coherent when the store refuses a write (full, blocked) — the draft must not
  // vanish just because it could not be persisted.
  let mirror: Record<string, NotesDraft> = loadDrafts(userId, storage, now())
  let diskHealthy = Boolean(storage)

  const read = (): Record<string, NotesDraft> => {
    if (storage && diskHealthy) mirror = loadDrafts(userId, storage, now())
    return mirror
  }
  const commit = (next: Record<string, NotesDraft>) => {
    mirror = next
    diskHealthy = writeDrafts(userId, next, storage)
  }
  const without = (all: Record<string, NotesDraft>, id: string) => {
    const copy = { ...all }
    delete copy[id]
    return copy
  }

  async function run(id: string): Promise<NotesSaveOutcome> {
    let outcome: NotesSaveOutcome = { kind: 'nothing' }
    do {
      rerun.delete(id)
      const sent = read()[id]
      if (!sent) return outcome
      try {
        await opts.write(id, sent.text, sent.editedAt)
      } catch (error) {
        // The draft is untouched. It is still here, and Retry sends the same text.
        return { kind: 'failed', reason: isNotesUnavailable(error) ? 'unavailable' : 'other', error }
      }
      outcome = { kind: 'saved', text: sent.text, editedAt: sent.editedAt }
      // Confirmed. Forget the draft ONLY if it is still exactly what was sent: an
      // edit made while this was in flight is newer than anything the server has
      // and must stay.
      const current = read()[id]
      if (current && current.editedAt === sent.editedAt && current.text === sent.text) {
        commit(without(read(), id))
      }
    } while (rerun.has(id))
    return outcome
  }

  return {
    edit(recordingId, text) {
      if (!recordingId) return
      const all = read()
      const existing = all[recordingId]
      if (existing && existing.text === text) return
      commit({ ...all, [recordingId]: { text: text.slice(0, MAX_DRAFT_CHARS), editedAt: now() } })
    },
    save(recordingId) {
      const inFlight = running.get(recordingId)
      if (inFlight) {
        rerun.add(recordingId)
        return inFlight
      }
      const promise = run(recordingId).finally(() => {
        running.delete(recordingId)
      })
      running.set(recordingId, promise)
      return promise
    },
    draft: (recordingId) => read()[recordingId] ?? null,
    discard(recordingId) {
      commit(without(read(), recordingId))
    },
    settle(recordingId) {
      commit(without(read(), recordingId))
    },
    pending: () => Object.keys(read()),
    inFlight: (recordingId) => running.has(recordingId),
  }
}
