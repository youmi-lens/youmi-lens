import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordingCourseContext, type Course } from './courses/courseModel'
import { uploadLectureAudioViaServer, updateRecordingAi } from './recordingsRepo'
import { getPendingUploadWithBlob, savePendingUpload, type PendingUploadRow } from './db'

vi.mock('./ai/apiBase', () => ({ getAiApiBase: () => 'https://upload.invalid/api' }))

const id = '00000000-0000-4000-8000-000000000001'
const course: Course = { id, name: 'CS111', userId: 'owner', icon: '', tint: '', accent: '', createdAt: 0, updatedAt: 0, deletedAt: null, deletionUpdatedAt: null }
const client = { auth: { getSession: async () => ({ data: { session: { access_token: 'test-session' } } }) } } as unknown as SupabaseClient
const audio = new Blob(['audio'], { type: 'audio/webm' })
const metadata = { title: 'Lecture', liveTranscript: '', liveTranscriptRaw: '' }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('course identity across capture and multipart upload', () => {
  it('captures the UUID from a displayed name-only selection and sends it to the upload route', async () => {
    const selected = recordingCourseContext({ course: ' cs111 ', courseId: null }, [course])
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ storagePath: 'test/audio.webm', size: 5 }) }))
    vi.stubGlobal('fetch', fetch)
    await uploadLectureAudioViaServer(client, 'recording', audio, 'audio/webm', 1, { ...metadata, ...selected })
    const form = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData
    expect(form.get('course_id')).toBe(id)
    expect(form.get('course')).toBe('CS111')
  })

  it('does not reassign an explicit missing UUID to a same-name replacement', () => {
    expect(recordingCourseContext({ course: 'CS111', courseId: 'deleted-id' }, [course]).courseId).toBe('deleted-id')
  })

  it('an intentionally unfiled capture stays unfiled when unrelated courses exist', () => {
    expect(recordingCourseContext({ course: '', courseId: null }, [course])).toEqual({ course: '', courseId: null })
  })

  it('the durable pending upload preserves UUID and retry sends it unchanged', async () => {
    // Small asynchronous IDB test double: exercises the real put/get persistence
    // functions without importing a browser or opening any production database.
    const rows = new Map<string, PendingUploadRow>()
    vi.stubGlobal('indexedDB', { open: () => {
      const request: Record<string, unknown> = {}
      request.result = { transaction: () => {
        const tx: Record<string, unknown> = {}
        tx.objectStore = () => ({
          put: (row: PendingUploadRow) => { rows.set(row.id, structuredClone(row)); queueMicrotask(() => (tx.oncomplete as () => void)?.()) },
          get: (key: string) => {
            const get: Record<string, unknown> = { result: structuredClone(rows.get(key)) }
            queueMicrotask(() => (get.onsuccess as () => void)?.())
            return get
          },
        })
        return tx
      } }
      queueMicrotask(() => (request.onsuccess as () => void)?.())
      return request
    } })
    const selected = recordingCourseContext({ course: 'CS111', courseId: null }, [course])
    await savePendingUpload({ id: 'recording', userId: 'owner', ...selected, ...metadata, durationSec: 1, mime: 'audio/webm', lang: 'en', translateTarget: 'off', createdAt: 0, updatedAt: 0, state: 'upload_failed', lastErrorCategory: 'network', attempts: 1, cloudUploaded: false, audioBlob: audio })
    const pending = await getPendingUploadWithBlob('recording')
    expect(pending?.courseId).toBe(id)
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ storagePath: 'test/audio.webm' }) }))
    vi.stubGlobal('fetch', fetch)
    await uploadLectureAudioViaServer(client, pending!.id, pending!.audioBlob, pending!.mime, pending!.durationSec, { ...metadata, course: pending!.course, courseId: pending!.courseId })
    expect(((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData).get('course_id')).toBe(id)
  })

  it('Start and Stop&Save use the captured context instead of mutable selection state', () => {
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    expect(source).toContain('void recorder.start({ ...captureCourse,')
    const save = source.slice(source.indexOf('const handleStopAndSave = async'), source.indexOf('const handleProcessRecording'))
    expect(save).toContain('const capturedSession = await getRecordingSession(recordingId)')
    expect(save).toContain('courseId: saveCourseId')
    expect(save).not.toContain('courseId: recordingCourseId,')
  })
})

describe('AI persistence against the real production column set', () => {
  it('persists canonical transcript and summaries without the absent transcript_raw column', async () => {
    let payload: unknown
    const filters: Array<[string, string]> = []
    const query = { eq: (key: string, value: string) => { filters.push([key, value]); return query }, then: (resolve: (value: { error: null }) => unknown) => Promise.resolve({ error: null }).then(resolve) }
    const db = { from: () => ({ update: (p: unknown) => { payload = p; return query } }) } as unknown as SupabaseClient
    await updateRecordingAi(db, 'owner', 'recording', { transcript: 'canonical', transcriptRaw: 'provider raw', summaryEn: 'summary', summaryZh: '摘要' })
    expect(payload).toEqual({ transcript: 'canonical', summary_en: 'summary', summary_zh: '摘要' })
    expect(filters).toEqual([['id', 'recording'], ['user_id', 'owner']])
  })

  it('still surfaces genuine persistence errors', async () => {
    const query = { eq: () => query, then: (resolve: (value: { error: Error }) => unknown) => Promise.resolve({ error: new Error('offline') }).then(resolve) }
    const db = { from: () => ({ update: () => query }) } as unknown as SupabaseClient
    await expect(updateRecordingAi(db, 'owner', 'recording', { transcript: 'canonical' })).rejects.toThrow('offline')
  })
})
