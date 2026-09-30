import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { deleteLectures, deleteRecordingRemote } from './recordingsRepo'

const here = dirname(fileURLToPath(import.meta.url))

type Call = { op: string; args?: unknown }

function makeMockSupabase(opts?: {
  selectRows?: Array<{ id: string; storage_path: string }>
  deleteError?: { message: string } | null
  storageRemoveError?: { message: string } | null
  remainingAfterDelete?: Array<{ id: string }>
}) {
  const calls: Call[] = []
  const selectRows = opts?.selectRows ?? [
    { id: 'rec-1', storage_path: 'user-1/rec-1.webm' },
    { id: 'rec-2', storage_path: 'user-1/rec-2.webm' },
  ]
  let deleted = false

  // Support .delete().eq('id').eq('user_id') and .delete().eq().in() chains.
  const deleteEqChain = () => ({
    eq(col: string, val: string) {
      calls.push({ op: `delete_eq:${col}`, args: val })
      return {
        eq(col2: string, val2: string) {
          calls.push({ op: `delete_eq:${col2}`, args: val2 })
          if (opts?.deleteError) return Promise.resolve({ error: opts.deleteError })
          deleted = true
          return Promise.resolve({ error: null })
        },
        in(colIn: string, ids: string[]) {
          calls.push({ op: `delete_in:${colIn}`, args: ids })
          if (opts?.deleteError) return Promise.resolve({ error: opts.deleteError })
          deleted = true
          return Promise.resolve({ error: null })
        },
      }
    },
  })

  const supabase = {
    from(table: string) {
      expect(table).toBe('recordings')
      return {
        select(cols: string) {
          calls.push({ op: 'select', args: cols })
          return {
            eq() {
              return {
                in(colIn: string, ids: string[]) {
                  calls.push({ op: 'select_in', args: { colIn, ids } })
                  if (deleted) {
                    return Promise.resolve({
                      data: opts?.remainingAfterDelete ?? [],
                      error: null,
                    })
                  }
                  return Promise.resolve({ data: selectRows, error: null })
                },
              }
            },
          }
        },
        delete() {
          calls.push({ op: 'delete_rows' })
          return deleteEqChain()
        },
      }
    },
    storage: {
      from(bucket: string) {
        expect(bucket).toBe('lecture-audio')
        return {
          remove(paths: string[]) {
            calls.push({ op: 'storage_remove', args: paths })
            if (opts?.storageRemoveError) {
              return Promise.resolve({ error: opts.storageRemoveError })
            }
            return Promise.resolve({ error: null })
          },
        }
      },
    },
  }

  return { supabase: supabase as never, calls }
}

describe('deleteLectures / deleteRecordingRemote ordering', () => {
  it('deletes DB rows before removing storage objects', async () => {
    const { supabase, calls } = makeMockSupabase()
    await deleteLectures(['rec-1', 'rec-2'], {
      localOnly: false,
      supabase,
      userId: 'user-1',
      deleteRecordingLocal: async () => {
        throw new Error('not used')
      },
    })

    const ops = calls.map((c) => c.op)
    const deleteIdx = ops.indexOf('delete_rows')
    const storageIdx = ops.findIndex((o) => o === 'storage_remove')
    expect(deleteIdx).toBeGreaterThanOrEqual(0)
    expect(storageIdx).toBeGreaterThan(deleteIdx)
    // Both objects removed only after row delete
    const removes = calls.filter((c) => c.op === 'storage_remove')
    expect(removes).toHaveLength(2)
  })

  it('does not remove storage when the row delete fails (audio preserved)', async () => {
    const { supabase, calls } = makeMockSupabase({
      deleteError: { message: 'db down' },
    })
    await expect(
      deleteLectures(['rec-1'], {
        localOnly: false,
        supabase,
        userId: 'user-1',
        deleteRecordingLocal: async () => {
          throw new Error('not used')
        },
      }),
    ).rejects.toThrow(/row delete failed/)

    expect(calls.some((c) => c.op === 'storage_remove')).toBe(false)
  })

  it('still completes the purge if storage cleanup fails after rows are gone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { supabase, calls } = makeMockSupabase({
      storageRemoveError: { message: 'storage timeout' },
    })
    await expect(
      deleteLectures(['rec-1'], {
        localOnly: false,
        supabase,
        userId: 'user-1',
        deleteRecordingLocal: async () => {
          throw new Error('not used')
        },
      }),
    ).resolves.toBeUndefined()

    expect(calls.some((c) => c.op === 'delete_rows')).toBe(true)
    expect(calls.some((c) => c.op === 'storage_remove')).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('deleteRecordingRemote also deletes the row before storage', async () => {
    const { supabase, calls } = makeMockSupabase()
    await deleteRecordingRemote(supabase, 'user-1', 'rec-1', 'user-1/rec-1.webm')
    const ops = calls.map((c) => c.op)
    const firstDeleteEq = ops.findIndex((o) => o.startsWith('delete_eq'))
    const storageIdx = ops.indexOf('storage_remove')
    expect(firstDeleteEq).toBeGreaterThanOrEqual(0)
    expect(storageIdx).toBeGreaterThan(firstDeleteEq)
  })
})

describe('deleteLectures source ordering invariant', () => {
  it('keeps row delete before storage remove in source', () => {
    const src = readFileSync(join(here, 'recordingsRepo.ts'), 'utf8')
    const fnStart = src.indexOf('export async function deleteLectures')
    const fnEnd = src.indexOf('export async function', fnStart + 10)
    const body = src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd)
    const rowDelete = body.indexOf(".delete()\n    .eq('user_id'")
    const altRowDelete = body.indexOf(".delete()\n      .eq('user_id'")
    const rowAt = Math.max(rowDelete, altRowDelete)
    const storageAt = body.indexOf('storage.from(BUCKET).remove')
    expect(rowAt).toBeGreaterThan(0)
    expect(storageAt).toBeGreaterThan(rowAt)
  })
})
