import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Recording } from '../../types'
import {
  courseNameConflicts,
  isCourseNameValid,
  reconcileCourseLists,
  type Course,
  type CreateCourseInput,
} from './courseModel'
import type {
  CoursesCapabilities,
  CoursesRepository,
  MoveLectureResult,
} from './coursesRepository'
import { resolveCoursesBackend } from './coursesRepositoryFactory'

/**
 * The one place the UI talks to the Course repository.
 *
 * Components receive courses and callbacks from here and never import a
 * Supabase client, so swapping the repository (which the factory does on its
 * own once the Phase 1B migration is present) changes nothing above this line.
 *
 * `capabilities` is surfaced deliberately: when the derived read-only
 * repository is in use, the UI disables the controls it cannot honour rather
 * than offering buttons that throw.
 */

export type CoursesState = {
  courses: Course[]
  /** Soft-deleted courses, newest first. Feeds Recently Deleted. */
  deletedCourses: Course[]
  loading: boolean
  /** Set when the repository itself failed — not when a mutation was refused. */
  error: string | null
  capabilities: CoursesCapabilities
  /** True once the courses table is present and writes are real. */
  migrated: boolean
  refresh: () => Promise<void>
  create: (input: CreateCourseInput) => Promise<Course | null>
  rename: (courseId: string, name: string) => Promise<boolean>
  softDelete: (courseId: string) => Promise<boolean>
  /** Clears `deleted_at`; the course returns to the grid under its own name. */
  restore: (courseId: string) => Promise<boolean>
  /** Physical delete from Recently Deleted. Lectures are never removed. */
  purge: (courseId: string) => Promise<boolean>
  /**
   * Move one lecture into a course, or to Unfiled with `null`.
   *
   * Goes through the repository so the dual write is preserved: `course_id`
   * AND the legacy `course` label in one statement. Writing only the label
   * would leave the pointer stale; writing only the pointer would make the
   * lecture appear Unfiled on iPad.
   */
  assignLecture: (recordingId: string, courseId: string | null) => Promise<MoveLectureResult | null>
  /** Non-null while a mutation is in flight; the UI disables its controls. */
  busy: boolean
  /** Last mutation failure, shown inline in the dialog that caused it. */
  mutationError: string | null
  clearMutationError: () => void
  nameConflicts: (name: string, exceptCourseId?: string) => boolean
}

const READ_ONLY: CoursesCapabilities = {
  canCreate: false,
  canRename: false,
  canDelete: false,
  canRestore: false,
  canPurge: false,
  persistsIdentity: false,
}

function describe(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message)
  }
  return String(err)
}

export function useCourses(input: {
  supabase: SupabaseClient | null
  userId: string | null
  localOnly: boolean
  recordings: readonly Recording[]
}): CoursesState {
  const { supabase, userId, localOnly, recordings } = input

  const [courses, setCourses] = useState<Course[]>([])
  const [deletedCourses, setDeletedCourses] = useState<Course[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [capabilities, setCapabilities] = useState<CoursesCapabilities>(READ_ONLY)
  const [migrated, setMigrated] = useState(false)

  const repoRef = useRef<CoursesRepository | null>(null)
  // The derived repository reads live recordings; a ref keeps the repository
  // stable while still seeing the newest list.
  const recordingsRef = useRef(recordings)
  recordingsRef.current = recordings

  /**
   * Every course the hook currently knows about, in both states.
   *
   * Held in a ref so `applyCourseLists` can consult it without becoming a
   * dependency of `load` — which would re-run the fetch each time its own
   * result landed.
   */
  const knownCoursesRef = useRef<Course[]>([])
  // A background invalidation failure must leave an already-rendered grid in
  // place. A first-load failure still reports the empty/error state as before.
  const hasLoadedCoursesRef = useRef(false)
  const sourceKey = `${localOnly ? 'local' : 'cloud'}:${userId ?? 'anonymous'}:${Boolean(supabase)}`
  const loadedSourceKeyRef = useRef(sourceKey)

  /**
   * The single place course lists are written.
   *
   * Deletion state is reconciled by freshness before the split: a read issued
   * before this device's own restore landed would otherwise put the course back
   * in Recently Deleted, and a newer delete from another device must equally not
   * be undone by a stale active cache. See `mergeCourseDeletion`.
   */
  const applyCourseLists = useCallback((active: Course[], deleted: Course[]) => {
    const next = reconcileCourseLists(knownCoursesRef.current, active, deleted)
    knownCoursesRef.current = [...next.active, ...next.deleted]
    setCourses(next.active)
    setDeletedCourses(next.deleted)
  }, [])

  const load = useCallback(async () => {
    // Keeping a stale grid on a transient refresh failure is correct, but
    // never across a signed-in identity or storage-mode change.
    if (loadedSourceKeyRef.current !== sourceKey) {
      loadedSourceKeyRef.current = sourceKey
      hasLoadedCoursesRef.current = false
      knownCoursesRef.current = []
      setCourses([])
      setDeletedCourses([])
    }
    setLoading(true)
    setError(null)
    try {
      const backend = await resolveCoursesBackend({
        supabase,
        userId,
        localOnly,
        getRecordings: () => recordingsRef.current,
      })
      repoRef.current = backend.repository
      setCapabilities(backend.repository.capabilities)
      setMigrated(backend.migrated)
      const [active, deleted] = await Promise.all([
        backend.repository.listActive(),
        backend.repository.listDeleted(),
      ])
      applyCourseLists(active, deleted)
      hasLoadedCoursesRef.current = true
    } catch (err) {
      // A failure here means the repository could not answer at all. It is
      // surfaced rather than swallowed: silently showing an empty course list
      // is indistinguishable from "you have no courses".
      setError(describe(err))
      if (!hasLoadedCoursesRef.current) {
        knownCoursesRef.current = []
        setCourses([])
        setDeletedCourses([])
      }
    } finally {
      setLoading(false)
    }
  }, [supabase, userId, localOnly, sourceKey, applyCourseLists])

  useEffect(() => {
    void load()
  }, [load])

  // The derived repository recomputes from recordings, so a new lecture must
  // refresh the list. The Supabase repository owns its own rows and does not.
  const derivedSignature = useMemo(
    () => (migrated ? '' : recordings.map((r) => `${r.id}:${r.course}`).join('|')),
    [migrated, recordings],
  )
  useEffect(() => {
    if (migrated || loading) return
    const repo = repoRef.current
    if (!repo) return
    void repo
      .listActive()
      // Deleted courses are not re-fetched here, so they are carried across
      // rather than passed as an empty list — which would clear the bin.
      .then((active) =>
        applyCourseLists(
          active,
          knownCoursesRef.current.filter((c) => c.deletedAt !== null),
        ),
      )
      .catch(() => undefined)
  }, [derivedSignature, migrated, loading, applyCourseLists])

  const runMutation = useCallback(
    async <T,>(action: (repo: CoursesRepository) => Promise<T>): Promise<T | null> => {
      const repo = repoRef.current
      if (!repo) return null
      setBusy(true)
      setMutationError(null)
      try {
        const result = await action(repo)
        // Both lists after every mutation: soft delete, restore and purge each
        // move a course BETWEEN them, so refreshing only the active list would
        // leave Recently Deleted showing a course that is no longer there.
        const [active, deleted] = await Promise.all([repo.listActive(), repo.listDeleted()])
        applyCourseLists(active, deleted)
        return result
      } catch (err) {
        setMutationError(describe(err))
        return null
      } finally {
        setBusy(false)
      }
    },
    [applyCourseLists],
  )

  const create = useCallback(
    (createInput: CreateCourseInput) => {
      if (!isCourseNameValid(createInput.name)) return Promise.resolve(null)
      return runMutation((repo) => repo.create(createInput))
    },
    [runMutation],
  )

  const rename = useCallback(
    async (courseId: string, name: string) => {
      if (!isCourseNameValid(name)) return false
      return (await runMutation((repo) => repo.rename(courseId, name))) !== null
    },
    [runMutation],
  )

  const softDelete = useCallback(
    async (courseId: string) => (await runMutation((repo) => repo.softDelete(courseId))) !== null,
    [runMutation],
  )

  const restore = useCallback(
    async (courseId: string) => (await runMutation((repo) => repo.restore(courseId))) !== null,
    [runMutation],
  )

  const purge = useCallback(
    async (courseId: string) => (await runMutation((repo) => repo.purge(courseId))) !== null,
    [runMutation],
  )

  const assignLecture = useCallback(
    (recordingId: string, courseId: string | null) =>
      runMutation((repo) => repo.assignLecture(recordingId, courseId)),
    [runMutation],
  )

  const nameConflicts = useCallback(
    (name: string, exceptCourseId?: string) => courseNameConflicts(name, courses, exceptCourseId),
    [courses],
  )

  return {
    courses,
    deletedCourses,
    loading,
    error,
    capabilities,
    migrated,
    refresh: load,
    create,
    rename,
    softDelete,
    restore,
    purge,
    assignLecture,
    busy,
    mutationError,
    clearMutationError: useCallback(() => setMutationError(null), []),
    nameConflicts,
  }
}
