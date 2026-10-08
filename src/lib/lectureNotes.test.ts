import { describe, expect, it, vi } from 'vitest'
import {
  CloudAnnotationsUnavailableError,
  createNotesSaver,
  DRAFT_TTL_MS,
  isNotesUnavailable,
  loadDrafts,
  parseDrafts,
  resolveNotesForOpen,
  type DraftStorage,
} from './lectureNotes'

/**
 * Notes persistence, 2026-10-04 (QA 1007): "Ss" answered "Your notes were not saved".
 * Production's `recordings` table has no `notes` column, so no write could ever land.
 * These tests hold what the CLIENT must guarantee around that: the draft is never
 * lost, a schema gap is not dressed up as a flaky network, saves are ordered, and a
 * completion is applied to the lecture it belongs to.
 */

function disk(): DraftStorage & { raw: () => Record<string, string> } {
  const m: Record<string, string> = {}
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => {
      m[k] = v
    },
    raw: () => ({ ...m }),
  }
}

/** A controllable network write. */
function network() {
  const calls: Array<{ id: string; text: string; editedAt: number }> = []
  let mode: 'ok' | 'fail' | 'schema' | 'manual' = 'ok'
  const pending: Array<{ resolve: () => void; reject: (e: unknown) => void }> = []
  const write = vi.fn(async (id: string, text: string, editedAt: number) => {
    calls.push({ id, text, editedAt })
    if (mode === 'fail') throw new Error('network down')
    if (mode === 'schema') throw new CloudAnnotationsUnavailableError()
    if (mode === 'manual') await new Promise<void>((resolve, reject) => pending.push({ resolve, reject }))
  })
  return { write, calls, pending, set: (m: typeof mode) => (mode = m) }
}

const U = 'user-1'
const A = 'lecture-a'
const B = 'lecture-b'
let clock = 1000
const tick = () => (clock += 10)

function saverOn(storage: DraftStorage | null, net = network()) {
  return { net, saver: createNotesSaver({ userId: U, write: net.write, storage, now: tick }) }
}

describe('1 · edit → successful save', () => {
  it('writes the typed text with the edit time as the clock, then forgets the draft', async () => {
    const d = disk()
    const { saver, net } = saverOn(d)
    saver.edit(A, 'Ss')
    const edited = saver.draft(A)!.editedAt
    const out = await saver.save(A)
    expect(out).toEqual({ kind: 'saved', text: 'Ss', editedAt: edited })
    expect(net.calls).toEqual([{ id: A, text: 'Ss', editedAt: edited }])
    expect(saver.draft(A)).toBeNull()
    expect(saver.pending()).toEqual([])
  })

  it('saving with no draft is a no-op, never an empty write', async () => {
    const { saver, net } = saverOn(disk())
    expect(await saver.save(A)).toEqual({ kind: 'nothing' })
    expect(net.write).not.toHaveBeenCalled()
  })
})

describe('write-ahead: an edit is durable before any network', () => {
  it('is on disk the moment it is typed', () => {
    const d = disk()
    const { saver, net } = saverOn(d)
    saver.edit(A, 'Ss')
    expect(net.write).not.toHaveBeenCalled()
    expect(loadDrafts(U, d, clock)[A].text).toBe('Ss')
  })

  it('an unchanged edit does not move the edit time', () => {
    const { saver } = saverOn(disk())
    saver.edit(A, 'Ss')
    const first = saver.draft(A)!.editedAt
    saver.edit(A, 'Ss')
    expect(saver.draft(A)!.editedAt).toBe(first)
  })

  it('is per user', () => {
    const d = disk()
    createNotesSaver({ userId: 'u1', write: async () => undefined, storage: d, now: tick }).edit(A, 'mine')
    expect(loadDrafts('u2', d, clock)).toEqual({})
  })
})

describe('4 · save network failure → the draft remains', () => {
  it('keeps the draft, on disk, exactly as typed', async () => {
    const d = disk()
    const { saver, net } = saverOn(d)
    net.set('fail')
    saver.edit(A, 'Ss')
    const out = await saver.save(A)
    expect(out).toMatchObject({ kind: 'failed', reason: 'other' })
    expect(saver.draft(A)?.text).toBe('Ss')
    expect(loadDrafts(U, d, clock)[A].text).toBe('Ss')
  })

  it('a schema gap is reported as "unavailable" — not as a retryable network failure — and still keeps the draft', async () => {
    const { saver, net } = saverOn(disk())
    net.set('schema')
    saver.edit(A, 'Ss')
    const out = await saver.save(A)
    expect(out).toMatchObject({ kind: 'failed', reason: 'unavailable' })
    expect(saver.draft(A)?.text).toBe('Ss')
  })
})

describe('5/6 · Retry', () => {
  it('Retry sends the SAME draft with the SAME clock, and clears it on success', async () => {
    const { saver, net } = saverOn(disk())
    net.set('fail')
    saver.edit(A, 'Ss')
    await saver.save(A)
    net.set('ok')
    const out = await saver.save(A)
    expect(out.kind).toBe('saved')
    expect(net.calls).toHaveLength(2)
    expect(net.calls[1]).toEqual(net.calls[0]) // idempotent: same text, same clock
    expect(saver.draft(A)).toBeNull()
  })

  it('a failing retry still leaves the draft, however many times it fails', async () => {
    const { saver, net } = saverOn(disk())
    net.set('fail')
    saver.edit(A, 'Ss')
    for (let i = 0; i < 4; i++) {
      expect((await saver.save(A)).kind).toBe('failed')
      expect(saver.draft(A)?.text).toBe('Ss')
    }
  })

  it('duplicate retries while one is in flight make ONE write', async () => {
    const { saver, net } = saverOn(disk())
    net.set('manual')
    saver.edit(A, 'Ss')
    const p1 = saver.save(A)
    const p2 = saver.save(A)
    const p3 = saver.save(A)
    expect(net.write).toHaveBeenCalledTimes(1)
    net.pending[0].resolve()
    await Promise.all([p1, p2, p3])
    expect(net.write).toHaveBeenCalledTimes(1)
  })
})

describe('2/3 · leave → reopen, quit → relaunch', () => {
  it('an unsaved draft survives a "relaunch": a brand-new saver on the same disk still has it', async () => {
    const d = disk()
    const first = saverOn(d)
    first.net.set('fail')
    first.saver.edit(A, 'Ss')
    await first.saver.save(A)
    // Quit and relaunch: nothing in memory, only the disk.
    const second = saverOn(d)
    expect(second.saver.draft(A)?.text).toBe('Ss')
    const resolved = resolveNotesForOpen({ remote: { notes: undefined, notesUpdatedAt: null }, draft: second.saver.draft(A) })
    expect(resolved).toMatchObject({ text: 'Ss', source: 'draft', restored: true, dropDraft: false })
  })

  it('after a confirmed save, reopening (or relaunching) shows the saved note and no stale draft', async () => {
    const d = disk()
    const first = saverOn(d)
    first.saver.edit(A, 'Ss')
    const out = await first.saver.save(A)
    const second = saverOn(d)
    expect(second.saver.draft(A)).toBeNull()
    const saved = out.kind === 'saved' ? out : null
    expect(
      resolveNotesForOpen({ remote: { notes: 'Ss', notesUpdatedAt: saved!.editedAt }, draft: second.saver.draft(A) }),
    ).toMatchObject({ text: 'Ss', source: 'remote', restored: false })
  })

  it('leaving never discards: the draft is still there after any number of "navigations"', () => {
    const d = disk()
    const { saver } = saverOn(d)
    saver.edit(A, 'half a thought')
    for (let i = 0; i < 5; i++) expect(saverOn(d).saver.draft(A)?.text).toBe('half a thought')
  })
})

describe('11 · an unsaved draft is only ever discarded deliberately', () => {
  it('an error does not discard it, and an explicit Discard does', async () => {
    const { saver, net } = saverOn(disk())
    net.set('fail')
    saver.edit(A, 'Ss')
    await saver.save(A)
    expect(saver.draft(A)).not.toBeNull()
    saver.discard(A)
    expect(saver.draft(A)).toBeNull()
  })

  it('Discard on one lecture touches no other lecture', () => {
    const { saver } = saverOn(disk())
    saver.edit(A, 'a')
    saver.edit(B, 'b')
    saver.discard(A)
    expect(saver.draft(B)?.text).toBe('b')
  })
})

describe('7 · a delayed response cannot overwrite (or mark clean) a newer edit', () => {
  it('an edit made while the save is in flight survives its confirmation', async () => {
    const { saver, net } = saverOn(disk())
    net.set('manual')
    saver.edit(A, 'first')
    const inflight = saver.save(A)
    saver.edit(A, 'first, then more')
    net.pending[0].resolve()
    const out = await inflight
    // What was SENT is what is reported saved…
    expect(out).toMatchObject({ kind: 'saved', text: 'first' })
    // …but the newer text is NOT forgotten: it is still an unsaved draft.
    expect(saver.draft(A)?.text).toBe('first, then more')
    expect(saver.pending()).toContain(A)
  })

  it('a save requested while one is in flight sends the LATEST text afterwards, in order', async () => {
    const { saver, net } = saverOn(disk())
    net.set('manual')
    saver.edit(A, 'v1')
    const p1 = saver.save(A)
    saver.edit(A, 'v2')
    const p2 = saver.save(A)
    net.pending[0].resolve()
    await vi.waitFor(() => expect(net.pending).toHaveLength(2))
    net.pending[1].resolve()
    await Promise.all([p1, p2])
    expect(net.calls.map((c) => c.text)).toEqual(['v1', 'v2'])
    expect(net.calls[1].editedAt).toBeGreaterThan(net.calls[0].editedAt)
    expect(saver.draft(A)).toBeNull()
  })

  it('writes never overlap for one lecture', async () => {
    const { saver, net } = saverOn(disk())
    net.set('manual')
    saver.edit(A, 'v1')
    void saver.save(A)
    saver.edit(A, 'v2')
    void saver.save(A)
    await Promise.resolve()
    expect(net.write).toHaveBeenCalledTimes(1)
    expect(saver.inFlight(A)).toBe(true)
  })
})

describe('8 · rapid edits', () => {
  it('only the final text is ever sent; intermediate keystrokes cost no network', async () => {
    const { saver, net } = saverOn(disk())
    for (const t of ['S', 'Ss', 'Ss ', 'Ss n', 'Ss notes']) saver.edit(A, t)
    expect(net.write).not.toHaveBeenCalled()
    await saver.save(A)
    expect(net.calls.map((c) => c.text)).toEqual(['Ss notes'])
  })
})

describe('9/12 · switching lectures cannot save into the wrong lecture', () => {
  it('each lecture has its own draft, its own write, its own clock', async () => {
    const { saver, net } = saverOn(disk())
    saver.edit(A, 'note for A')
    saver.edit(B, 'note for B')
    await saver.save(A)
    expect(net.calls).toEqual([expect.objectContaining({ id: A, text: 'note for A' })])
    expect(saver.draft(B)?.text).toBe('note for B')
  })

  it('a save in flight for A does not block, or leak into, B', async () => {
    const { saver, net } = saverOn(disk())
    net.set('manual')
    saver.edit(A, 'a')
    const pa = saver.save(A)
    saver.edit(B, 'b')
    const pb = saver.save(B)
    expect(net.calls.map((c) => [c.id, c.text])).toEqual([[A, 'a'], [B, 'b']])
    net.pending[0].resolve()
    net.pending[1].resolve()
    expect((await pa)).toMatchObject({ kind: 'saved', text: 'a' })
    expect((await pb)).toMatchObject({ kind: 'saved', text: 'b' })
  })

  it('a failure on A leaves B’s successful save untouched', async () => {
    const { saver, net } = saverOn(disk())
    net.set('fail')
    saver.edit(A, 'a')
    await saver.save(A)
    net.set('ok')
    saver.edit(B, 'b')
    await saver.save(B)
    expect(saver.draft(A)?.text).toBe('a')
    expect(saver.draft(B)).toBeNull()
  })

  it('never writes an id it was not asked to', async () => {
    const { saver, net } = saverOn(disk())
    saver.edit(A, 'a')
    await saver.save(B)
    expect(net.write).not.toHaveBeenCalled()
  })
})

describe('10 · the authoritative server note wins when appropriate', () => {
  const draft = { text: 'my draft', editedAt: 1000 }

  it('no draft → the cloud note', () => {
    expect(resolveNotesForOpen({ remote: { notes: 'cloud', notesUpdatedAt: 5 }, draft: null })).toMatchObject({ text: 'cloud', source: 'remote' })
  })

  it('a cloud note stamped NEWER than the draft wins, and the older draft is settled', () => {
    expect(resolveNotesForOpen({ remote: { notes: 'from iPad', notesUpdatedAt: 2000 }, draft })).toMatchObject({
      text: 'from iPad',
      source: 'remote',
      restored: false,
      dropDraft: true,
    })
  })

  it('a draft NEWER than the cloud note is restored — it is genuinely unsaved work', () => {
    expect(resolveNotesForOpen({ remote: { notes: 'old', notesUpdatedAt: 500 }, draft })).toMatchObject({
      text: 'my draft',
      source: 'draft',
      restored: true,
      dropDraft: false,
    })
  })

  it('an absent cloud clock never beats a draft — "no timestamp" is not evidence', () => {
    expect(resolveNotesForOpen({ remote: { notes: 'old', notesUpdatedAt: null }, draft })).toMatchObject({ source: 'draft', restored: true })
    expect(resolveNotesForOpen({ remote: {}, draft })).toMatchObject({ source: 'draft', restored: true })
  })

  it('a draft identical to the cloud note is moot', () => {
    expect(resolveNotesForOpen({ remote: { notes: 'my draft', notesUpdatedAt: 1 }, draft })).toMatchObject({ source: 'remote', restored: false, dropDraft: true })
  })

  it('an emptied note is a real note: clearing it is saved, not mistaken for "no draft"', async () => {
    const { saver, net } = saverOn(disk())
    saver.edit(A, 'something')
    saver.edit(A, '')
    expect(saver.draft(A)?.text).toBe('')
    await saver.save(A)
    expect(net.calls[0].text).toBe('')
  })
})

describe('robustness', () => {
  it('an unavailable or full store does not lose the draft within the session', async () => {
    const throwing: DraftStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('quota')
      },
    }
    const { saver, net } = saverOn(throwing)
    net.set('fail')
    saver.edit(A, 'Ss')
    expect((await saver.save(A)).kind).toBe('failed')
    expect(saver.draft(A)?.text).toBe('Ss')
    net.set('ok')
    expect((await saver.save(A)).kind).toBe('saved')
    expect(saver.draft(A)).toBeNull()
  })

  it('works with no store at all', async () => {
    const { saver, net } = saverOn(null)
    saver.edit(A, 'Ss')
    await saver.save(A)
    expect(net.calls[0].text).toBe('Ss')
  })

  it('corrupt storage reads as no drafts', () => {
    expect(parseDrafts('{nope')).toEqual({})
    expect(parseDrafts('[1,2]')).toEqual({})
    expect(parseDrafts('{"a":{"text":5,"editedAt":1},"b":{"text":"ok","editedAt":1}}', 1)).toEqual({ b: { text: 'ok', editedAt: 1 } })
  })

  it('a draft nobody has touched for a month expires', () => {
    expect(parseDrafts('{"a":{"text":"old","editedAt":0}}', DRAFT_TTL_MS + 1)).toEqual({})
  })

  it('classifies the schema gap however it arrives', () => {
    expect(isNotesUnavailable(new CloudAnnotationsUnavailableError())).toBe(true)
    expect(isNotesUnavailable({ code: '42703' })).toBe(true)
    expect(isNotesUnavailable({ code: 'PGRST204' })).toBe(true)
    expect(isNotesUnavailable(new Error('network down'))).toBe(false)
    expect(isNotesUnavailable({ code: '401' })).toBe(false)
  })
})
