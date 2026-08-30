/**
 * Cloud Library Stage 4 — "is this lecture trashed?"
 *
 * The rule itself now lives in `lectureDeletionResolution`, which is the module
 * the app is wired to. This file existed first and had no callers; keeping a
 * second copy of the same rule is how the two drift apart, so it re-exports
 * rather than re-implements.
 *
 * The rule, unchanged:
 *   `deletedAt` is a timestamp → TRASHED
 *   `deletedAt` is null        → ACTIVE — this is what lets a restore on another
 *                                device beat a stale localStorage trash entry
 *   `deletedAt` is undefined   → the column is absent on this database; the
 *                                legacy registry is consulted as a fallback
 *
 * Historical localStorage entries are never bulk-converted into cloud
 * deletions.
 */
export { isRecordingTrashed, partitionByDeletion } from './lectureDeletionResolution'
