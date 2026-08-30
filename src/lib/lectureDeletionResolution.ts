/**
 * Who decides whether a lecture is deleted.
 *
 * Two stores can answer that question and they do not agree:
 *
 *   · the cloud — `recordings.deleted_at` + `recordings.deletion_updated_at`,
 *     an account-level pair that every device reads and writes;
 *   · the legacy registry — `yl_cloud_lecture_trash_v1:<userId>` in
 *     localStorage, written by Desktop builds that shipped before the cloud
 *     columns existed. It never left this Mac, and its timestamps were taken
 *     from this Mac's clock.
 *
 * The frozen contract decision: **cloud deletion state is authoritative, and
 * the legacy registry is non-authoritative compatibility data.** It is consulted
 * only where the cloud genuinely cannot answer — a database that predates Cloud
 * Library Stage 4 — and it never competes on timestamps, because a device-local
 * clock is not evidence about what another device decided.
 *
 * What that buys, concretely:
 *   · a lecture restored on iPad comes back on this Mac even though this Mac
 *     still holds a stale trash entry for it;
 *   · a lecture deleted on iPad disappears here without this Mac ever having
 *     recorded a deletion;
 *   · nothing on startup converts old registry entries into cloud tombstones,
 *     which would publish this Mac's private history to every other device.
 *
 * Pure: no storage, no network, no React.
 */

export type LectureDeletionInputs = {
  /**
   * The cloud's answer for this lecture.
   *   `undefined` — the column is absent from the row (unmigrated database)
   *   `null`      — the column exists and the lecture is active
   *   number      — deleted at that instant
   */
  cloudDeletedAt: number | null | undefined
  /** True when this lecture is present in the legacy device-local registry. */
  inLegacyTrash: boolean
  /**
   * Whether this database answers the deletion question at all, established
   * from the fetched rows rather than assumed.
   */
  cloudDeletionAvailable: boolean
}

export type LectureDeletionState = 'active' | 'deleted'

/**
 * Resolve one lecture's deletion state.
 *
 * Note what is deliberately absent: any comparison between the legacy
 * `trashedAt` and the cloud clock. Once the cloud can answer, the legacy value
 * is not an older opinion to be out-voted — it is not an opinion at all.
 */
export function resolveLectureDeletion(input: LectureDeletionInputs): LectureDeletionState {
  if (input.cloudDeletionAvailable) {
    // The cloud decides, in both directions. A row that is active in the cloud
    // is active here even if the legacy registry still lists it — that is what
    // makes an explicit cloud restore beat stale local trash.
    return typeof input.cloudDeletedAt === 'number' ? 'deleted' : 'active'
  }
  // No cloud deletion contract on this database. The registry is the only
  // record of the user's intent, so it still applies — this is the
  // compatibility path, not the default.
  return input.inLegacyTrash ? 'deleted' : 'active'
}

/** Convenience wrapper for list filtering. */
export function isLectureActive(input: LectureDeletionInputs): boolean {
  return resolveLectureDeletion(input) === 'active'
}

/**
 * Per-row form of the same rule, for callers holding a legacy id set rather
 * than a per-fetch capability flag.
 *
 * The two forms agree in every case: `select('*')` returns the deletion column
 * for every row or for none, so "this row has no deletion field" and "this
 * database has no deletion columns" are the same fact seen from two distances.
 * This one is kept because a caller that only has one lecture in hand should
 * not have to synthesise a list-level flag to ask about it.
 */
export function isRecordingTrashed(
  recording: { id: string; deletedAt?: number | null },
  legacyTrashIds: ReadonlySet<string>,
): boolean {
  return (
    resolveLectureDeletion({
      cloudDeletedAt: recording.deletedAt,
      inLegacyTrash: legacyTrashIds.has(recording.id),
      cloudDeletionAvailable: recording.deletedAt !== undefined,
    }) === 'deleted'
  )
}

/** Split a list using the per-row form above. */
export function partitionByDeletion<T extends { id: string; deletedAt?: number | null }>(
  recordings: readonly T[],
  legacyTrashIds: ReadonlySet<string>,
): { active: T[]; trashed: T[] } {
  const active: T[] = []
  const trashed: T[] = []
  for (const r of recordings) {
    ;(isRecordingTrashed(r, legacyTrashIds) ? trashed : active).push(r)
  }
  return { active, trashed }
}

/*
 * There is deliberately NO bulk migration here.
 *
 * Converting the existing registry into cloud tombstones on first launch was
 * considered and rejected: those entries were written against this Mac's clock,
 * were never visible to any other device, and replaying them would publish one
 * machine's private history to the whole account — including for lectures the
 * user has since restored elsewhere. The registry is left in place, ignored,
 * and only pruned where an explicit user action already touches the same
 * lecture.
 */
