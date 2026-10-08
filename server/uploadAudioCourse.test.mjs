import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  process.env.SUPABASE_URL = 'https://stub.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only-service-key'
  return { client: null, existing: null, courseError: null, courseOwner: 'owner', courseDeleted: false, saved: null, courseFilters: [], upload: vi.fn() }
})
vi.mock('@supabase/supabase-js', () => ({ createClient: () => state.client }))
vi.mock('./betaGate.mjs', () => ({
  verifyJwt: vi.fn(async token => token === 'test-session' ? { userId: 'owner', email: 'test@example.com' } : null),
  getEffectiveQuota: vi.fn(), checkUploadAllowed: vi.fn(), recordBetaUsage: vi.fn(),
  BETA_ERROR_CODES: { AUTH_REQUIRED: 'auth_required' },
}))
import { handleUploadAudio } from './uploadAudio.mjs'

const courseId = '00000000-0000-4000-8000-000000000001'
const recordingId = '00000000-0000-4000-8000-000000000002'
function req(course = courseId) {
  return { headers: { authorization: 'Bearer test-session' }, body: { recordingId, course: 'CS111', course_id: course, title: 'Lecture', mime: 'audio/webm' }, file: { buffer: Buffer.from('audio'), size: 5 } }
}
function res() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this }, json(body) { this.body = body; return this } }
}
beforeEach(() => {
  state.existing = null; state.courseError = null; state.courseOwner = 'owner'; state.courseDeleted = false
  state.saved = null; state.courseFilters = []; state.upload.mockReset(); state.upload.mockResolvedValue({ error: null })
  state.client = {
    storage: { from: () => ({ upload: state.upload }) },
    from: table => {
      const filters = {}
      const chain = {
        select: () => chain,
        eq: (key, value) => { filters[key] = value; if (table === 'courses') state.courseFilters.push([key, value]); return chain },
        is: (key, value) => { filters[key] = value; if (table === 'courses') state.courseFilters.push([key, value]); return chain },
        maybeSingle: async () => table === 'courses'
          ? { data: filters.id === courseId && filters.user_id === state.courseOwner && filters.deleted_at === null && !state.courseDeleted ? { id: courseId } : null, error: state.courseError }
          : { data: state.existing, error: null },
        upsert: payload => { state.saved = { ...state.existing, ...payload }; return chain },
        single: async () => ({ data: state.saved, error: null }),
      }
      return chain
    },
  }
})

describe('authenticated upload course ownership', () => {
  it('persists an owned active UUID in the saved recording response', async () => {
    const response = res()
    await handleUploadAudio(req(), response)
    expect(response.statusCode).toBe(200)
    expect(response.body.recording.course_id).toBe(courseId)
    expect(state.saved.user_id).toBe('owner')
    expect(state.courseFilters).toEqual([['id', courseId], ['user_id', 'owner'], ['deleted_at', null]])
    expect(state.upload).toHaveBeenCalledTimes(1)
  })
  it('rejects another user\'s UUID before Storage or database writes', async () => {
    state.courseOwner = 'someone-else'
    const response = res()
    await handleUploadAudio(req(), response)
    expect(response.statusCode).toBe(404)
    expect(state.upload).not.toHaveBeenCalled()
    expect(state.saved).toBeNull()
  })
  it('a missing UUID produces the same response as a foreign UUID', async () => {
    const response = res()
    await handleUploadAudio(req('00000000-0000-4000-8000-000000000099'), response)
    expect(response.statusCode).toBe(404)
    expect(state.upload).not.toHaveBeenCalled()
  })
  it('rejects a deleted course', async () => {
    state.courseDeleted = true
    const response = res()
    await handleUploadAudio(req(), response)
    expect(response.statusCode).toBe(404)
    expect(state.saved).toBeNull()
  })
  it('fails closed on a course lookup error', async () => {
    state.courseError = { code: '42501' }
    const response = res()
    await handleUploadAudio(req(), response)
    expect(response.statusCode).toBe(503)
    expect(state.upload).not.toHaveBeenCalled()
  })
  it.each(['not-a-uuid', ['duplicate-field'], {}])('rejects malformed course input %s', async invalid => {
    const response = res()
    await handleUploadAudio(req(invalid), response)
    expect(response.statusCode).toBe(400)
    expect(state.upload).not.toHaveBeenCalled()
  })
  it('accepts the legacy/no-course insert without inventing a UUID', async () => {
    const request = req(); delete request.body.course_id
    const response = res()
    await handleUploadAudio(request, response)
    expect(response.statusCode).toBe(200)
    expect(state.saved).not.toHaveProperty('course_id')
  })
  it('a legacy retry does not clear a stored authoritative course UUID', async () => {
    state.existing = { id: recordingId, user_id: 'owner', course_id: courseId }
    const request = req(); delete request.body.course_id
    const response = res()
    await handleUploadAudio(request, response)
    expect(response.body.recording.course_id).toBe(courseId)
  })
  it('preserves the recording ownership conflict guard', async () => {
    state.existing = { id: recordingId, user_id: 'someone-else' }
    const response = res()
    await handleUploadAudio(req(), response)
    expect(response.statusCode).toBe(409)
    expect(state.upload).not.toHaveBeenCalled()
  })
})
