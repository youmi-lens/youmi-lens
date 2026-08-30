/**
 * Who decides whether a lecture is deleted.
 *
 * Before this milestone the answer was "a localStorage set on this Mac", which
 * meant an iPad deletion never arrived, a Desktop deletion never left, and a
 * reinstall resurrected everything. The contract decision is that the cloud
 * pair (`deleted_at` + `deletion_updated_at`) is authoritative and the legacy
 * registry is non-authoritative compatibility data.
 *
 * Every test below is written so it fails if the legacy registry regains a vote.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  isLectureActive,
  resolveLectureDeletion,
  type LectureDeletionInputs,
} from './lectureDeletionResolution'
import { partitionLecturesByDeletion } from './recordingsRepo'
import type { Recording } from '../types'

const CLOUD: Pick<LectureDeletionInputs, 'cloudDeletionAvailable'> = { cloudDeletionAvailable: true }
const LEGACY_DB: Pick<LectureDeletionInputs, 'cloudDeletionAvailable'> = {
  cloudDeletionAvailable: false,
}

describe('cloud state is authoritative', () => {
  it('a cloud tombstone deletes the lecture, with nothing in local trash', () => {
    // The iPad-deletion case: this Mac never recorded anything.
    expect(
      resolveLectureDeletion({ ...CLOUD, cloudDeletedAt: 1_700_000_000_000, inLegacyTrash: false }),
    ).toBe('deleted')
  })

  it('THE REGRESSION · an explicit cloud restore beats stale legacy trash', () => {
    // Deleted on this Mac long ago (registry entry survives), restored later on
    // another device. The lecture must come back here.
    expect(resolveLectureDeletion({ ...CLOUD, cloudDeletedAt: null, inLegacyTrash: true })).toBe(
      'active',
    )
    expect(isLectureActive({ ...CLOUD, cloudDeletedAt: null, inLegacyTrash: true })).toBe(true)
  })

  it('legacy trash cannot hide a cloud-active lecture under any timing', () => {
    // There is no timestamp input at all on the legacy side — by design. A
    // device-local clock is not evidence about another device's decision.
    for (const inLegacyTrash of [true, false]) {
      expect(resolveLectureDeletion({ ...CLOUD, cloudDeletedAt: null, inLegacyTrash })).toBe(
        'active',
      )
    }
  })

  it('a row with the column present and null is active, not "unknown"', () => {
    expect(resolveLectureDeletion({ ...CLOUD, cloudDeletedAt: null, inLegacyTrash: false })).toBe(
      'active',
    )
  })
})

describe('compatibility with a database that predates the columns', () => {
  it('the legacy registry still applies when the cloud cannot answer', () => {
    expect(
      resolveLectureDeletion({ ...LEGACY_DB, cloudDeletedAt: undefined, inLegacyTrash: true }),
    ).toBe('deleted')
    expect(
      resolveLectureDeletion({ ...LEGACY_DB, cloudDeletedAt: undefined, inLegacyTrash: false }),
    ).toBe('active')
  })

  it('an absent column is never mistaken for "deleted"', () => {
    expect(
      resolveLectureDeletion({ ...LEGACY_DB, cloudDeletedAt: undefined, inLegacyTrash: false }),
    ).toBe('active')
  })
})

describe('nothing here migrates the legacy registry', () => {
  // Comments stripped: this module documents at length what it refuses to do,
  // and the assertion is about the CODE, not the prose.
  const code = readFileSync(new URL('./lectureDeletionResolution.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  it('exposes no bulk conversion of local trash into cloud deletions', () => {
    // Replaying this Mac's private history onto the account was explicitly
    // rejected: those timestamps came from one machine's clock.
    for (const forbidden of ['migrate', 'softDelete', 'supabase', 'localStorage', 'Date.now']) {
      expect(code, forbidden).not.toContain(forbidden)
    }
  })

  it('is pure — it reads no store and performs no I/O', () => {
    expect(code).not.toContain('import')
    expect(code).not.toContain('async')
  })
})

/* ── The repository split ─────────────────────────────────────────────────── */

function lecture(id: string, deletedAt: number | null | undefined): Recording {
  return {
    id,
    course: 'CS 101',
    title: `Lecture ${id}`,
    createdAt: 1,
    durationSec: 60,
    mime: 'audio/webm',
    deletedAt,
  } as Recording
}

describe('partitioning a fetched library', () => {
  it('an iPad-origin deletion is filtered out of the active library', () => {
    const { active, deleted } = partitionLecturesByDeletion([
      lecture('a', null),
      lecture('b', 1_700_000_000_000),
      lecture('c', null),
    ])
    expect(active.map((r) => r.id)).toEqual(['a', 'c'])
    expect(deleted.map((r) => r.id)).toEqual(['b'])
  })

  it('the same fetch supplies Recently Deleted', () => {
    // Both halves come from one round trip, so the two lists cannot disagree
    // about the same instant.
    const { deleted } = partitionLecturesByDeletion([lecture('a', null), lecture('b', 5)])
    expect(deleted).toHaveLength(1)
    expect(deleted[0].id).toBe('b')
  })

  it('reports the capability only when a row actually carried the field', () => {
    expect(partitionLecturesByDeletion([lecture('a', null)]).cloudDeletionAvailable).toBe(true)
    expect(partitionLecturesByDeletion([lecture('a', 5)]).cloudDeletionAvailable).toBe(true)
    // Unmigrated database: `select('*')` simply omits the column.
    expect(partitionLecturesByDeletion([lecture('a', undefined)]).cloudDeletionAvailable).toBe(false)
  })

  it('an unmigrated row is active AND does not claim the capability', () => {
    // Collapsing undefined into null here would tell the caller the cloud can
    // answer, and the legacy registry would stop being consulted with nothing
    // taking its place.
    const result = partitionLecturesByDeletion([lecture('a', undefined)])
    expect(result.active.map((r) => r.id)).toEqual(['a'])
    expect(result.deleted).toEqual([])
    expect(result.cloudDeletionAvailable).toBe(false)
  })

  it('an empty library is harmless', () => {
    expect(partitionLecturesByDeletion([])).toEqual({
      active: [],
      deleted: [],
      cloudDeletionAvailable: false,
    })
  })
})

/* ── Call-site wiring ─────────────────────────────────────────────────────── */

describe('the app uses the cloud lifecycle', () => {
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
  const repo = readFileSync(new URL('./recordingsRepo.ts', import.meta.url), 'utf8')

  it('delete writes a cloud tombstone', () => {
    expect(app).toContain('softDeleteRecordingRemote(supabase!, userId, id)')
    expect(repo).toContain("update({ deleted_at: nowIso, deletion_updated_at: nowIso })")
  })

  it('restore clears the tombstone and advances the deletion clock', () => {
    expect(app).toContain('restoreRecordingRemote(supabase!, userId, id)')
    expect(repo).toContain("update({ deleted_at: null, deletion_updated_at: nowIso })")
  })

  it('the active list is resolved, not raw-subtracted from the registry', () => {
    expect(app).toContain('isLectureActive({')
    expect(app).not.toContain('return recordings.filter((r) => !trashed.has(r.id))')
  })

  it('Recently Deleted reads cloud rows when the cloud can answer', () => {
    expect(app).toContain('deletedLecturesFromCloudRows(cloudDeletedLectures, fallback)')
  })

  it('the library is fetched through the repository, not a UI query', () => {
    expect(app).toContain('await listLectures(supabase!, userId!)')
    expect(app).not.toMatch(/from\('recordings'\)/)
  })
})
