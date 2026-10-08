/**
 * A durable record of "this saved lecture still has to be handed to the server".
 *
 * WHY (production, 2026-10-04): the processing request used to live in memory,
 * after two client-side verification reads. When one of those reads timed out —
 * Supabase was answering in 8–25 seconds that evening — Stop & Save returned
 * early and the request was never made. The lecture sat at `pending` for 19
 * minutes until someone happened to open it. Quitting the app, an exception, or
 * a navigation had the same effect, because nothing outlived the call.
 *
 * The intent is written the moment the audio and its row are confirmed, BEFORE
 * any request or verification, and removed only when the server has acknowledged
 * the request or the row has visibly moved on. On launch (and whenever the list
 * loads) the app retries what is still recorded. The server is idempotent for a
 * lecture that is already queued or running, so retrying is safe; it is NEVER
 * used for a lecture that is already done — a repeat there is a billable
 * regeneration.
 *
 * Bounded by design: only lectures THIS app saved are recorded, entries expire,
 * and nothing here ever scans or processes the whole library.
 */

/** The slice of `Storage` this needs, so tests can inject a fake. */
export type IntentStorage = Pick<Storage, 'getItem' | 'setItem'>

export type ProcessingIntent = { id: string; at: number }

/** An intent older than this is dropped rather than retried forever. */
export const INTENT_TTL_MS = 24 * 60 * 60 * 1000
const MAX_INTENTS = 50
const keyFor = (userId: string) => `youmi.processingIntents.v1:${userId}`

function defaultStorage(): IntentStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function parseIntents(raw: string | null | undefined, now = Date.now()): ProcessingIntent[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const out: ProcessingIntent[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const { id, at } = item as { id?: unknown; at?: unknown }
      if (typeof id !== 'string' || !id || typeof at !== 'number' || !Number.isFinite(at)) continue
      if (now - at > INTENT_TTL_MS || seen.has(id)) continue
      seen.add(id)
      out.push({ id, at })
    }
    return out.slice(-MAX_INTENTS)
  } catch {
    return []
  }
}

export function listProcessingIntents(
  userId: string,
  storage: IntentStorage | null = defaultStorage(),
  now = Date.now(),
): ProcessingIntent[] {
  if (!storage || !userId) return []
  try {
    return parseIntents(storage.getItem(keyFor(userId)), now)
  } catch {
    return []
  }
}

function write(userId: string, intents: ProcessingIntent[], storage: IntentStorage | null): void {
  if (!storage) return
  try {
    storage.setItem(keyFor(userId), JSON.stringify(intents.slice(-MAX_INTENTS)))
  } catch {
    /* storage unavailable or full — the in-memory request and open-time reconcile still apply */
  }
}

/** Record that this lecture must be processed. Idempotent. */
export function addProcessingIntent(
  userId: string,
  recordingId: string,
  storage: IntentStorage | null = defaultStorage(),
  now = Date.now(),
): void {
  if (!userId || !recordingId) return
  const current = listProcessingIntents(userId, storage, now)
  if (current.some((i) => i.id === recordingId)) return
  write(userId, [...current, { id: recordingId, at: now }], storage)
}

/** The server acknowledged it, or the row has moved on. */
export function removeProcessingIntent(
  userId: string,
  recordingId: string,
  storage: IntentStorage | null = defaultStorage(),
  now = Date.now(),
): void {
  if (!userId || !recordingId) return
  const current = listProcessingIntents(userId, storage, now)
  if (!current.some((i) => i.id === recordingId)) return
  write(userId, current.filter((i) => i.id !== recordingId), storage)
}

/**
 * What to do with the recorded intents once a library listing is known.
 *
 *  · `request`  — the row is still `pending` (never picked up): ask the server.
 *  · `clear`    — the row has any other status: it has moved on, forget it.
 *  · `wait`     — the row is not in this listing yet (a stale read): keep it.
 *
 * `done` is deliberately a `clear`, never a `request`: asking again would be a
 * billable regeneration.
 */
export function reconcileIntents(
  intents: readonly ProcessingIntent[],
  library: ReadonlyArray<{ id: string; aiStatus?: string | null }>,
  alreadyRequested: ReadonlySet<string>,
): { request: string[]; clear: string[]; wait: string[] } {
  const byId = new Map(library.map((r) => [r.id, r]))
  const request: string[] = []
  const clear: string[] = []
  const wait: string[] = []
  for (const { id } of intents) {
    const row = byId.get(id)
    if (!row) {
      wait.push(id)
      continue
    }
    const status = row.aiStatus ?? 'pending'
    if (status !== 'pending') clear.push(id)
    else if (!alreadyRequested.has(id)) request.push(id)
    else wait.push(id)
  }
  return { request, clear, wait }
}
