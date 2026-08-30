import type { SupabaseClient } from '@supabase/supabase-js'
import type { Recording } from '../../types'
import { createDerivedCoursesRepository } from './derivedCoursesRepository'
import { createSupabaseCoursesRepository } from './supabaseCoursesRepository'
import type { CoursesRepository } from './coursesRepository'

/**
 * Chooses which Course repository this session gets.
 *
 * The choice is made from what the database can actually do, probed once, not
 * from a hand-set flag that someone has to remember to flip on deploy day. When
 * `supabase-phase1b-courses-01-migration.sql` runs, the next launch picks up
 * the real repository on its own; if it is rolled back, the next launch falls
 * back without an error screen.
 *
 * This is the ONLY place that needs to change when the migration lands, and it
 * changes by itself.
 */

export type CoursesBackend = {
  repository: CoursesRepository
  /** True once the Phase 1B schema is present. */
  migrated: boolean
}

/**
 * One cheap round trip: ask for a single course id.
 *
 * `PGRST205` (table missing from the schema cache) and `42P01` (undefined
 * table) both mean "not migrated yet". Any other error is a real failure — a
 * network outage or an expired session must NOT be misread as "no migration",
 * because that would silently downgrade a migrated user to a read-only course
 * list. Those cases return `false` for capability but are surfaced to the
 * caller through `probeError`.
 */
export async function probeCoursesSchema(
  supabase: SupabaseClient,
): Promise<{ available: boolean; probeError: unknown | null }> {
  const { error } = await supabase.from('courses').select('id').limit(1)
  if (!error) return { available: true, probeError: null }

  const code = (error as { code?: string }).code
  if (code === 'PGRST205' || code === '42P01') {
    return { available: false, probeError: null }
  }
  return { available: false, probeError: error }
}

export type CoursesBackendInput = {
  /** Null in local-only mode or before sign-in. */
  supabase: SupabaseClient | null
  userId: string | null
  localOnly: boolean
  /** Live recordings, used only by the derived fallback. */
  getRecordings: () => readonly Recording[]
}

export async function resolveCoursesBackend(input: CoursesBackendInput): Promise<CoursesBackend> {
  const { supabase, userId, localOnly, getRecordings } = input

  // Local-only mode has no cloud tables at all; the derived repository is the
  // correct implementation there permanently, not a fallback.
  if (localOnly || !supabase || !userId) {
    return {
      repository: createDerivedCoursesRepository(userId ?? 'local', getRecordings),
      migrated: false,
    }
  }

  const { available } = await probeCoursesSchema(supabase)
  if (!available) {
    return {
      repository: createDerivedCoursesRepository(userId, getRecordings),
      migrated: false,
    }
  }

  return {
    repository: createSupabaseCoursesRepository(supabase, userId),
    migrated: true,
  }
}
