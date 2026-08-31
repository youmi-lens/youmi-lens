import { describe, expect, it } from 'vitest'
import {
  sanitizeUploadErrorCategory,
  visiblePendingUploads,
  pendingStatusLabel,
  pendingStatusDetail,
  pendingUploadNeedsCourseChoice,
  type PendingUploadMeta,
} from './pendingUploads'

function pending(over: Partial<PendingUploadMeta> = {}): PendingUploadMeta {
  return {
    id: 'rec-1', userId: 'user-A', course: 'CS 229', title: 'Backprop', durationSec: 1200,
    mime: 'audio/webm', lang: 'en-US', translateTarget: 'zh', createdAt: 1000, updatedAt: 1000,
    state: 'upload_failed', lastErrorCategory: 'network', attempts: 1, cloudUploaded: false, ...over,
  }
}

describe('pending upload recovery model (Phase 2D-2)', () => {
  it('sanitizes errors to safe categories (never raw text/secrets)', () => {
    expect(sanitizeUploadErrorCategory(new Error('Audio upload timed out'))).toBe('timeout')
    expect(sanitizeUploadErrorCategory(new Error('network error: fetch failed'))).toBe('network')
    expect(sanitizeUploadErrorCategory(new Error('Bucket not found'))).toBe('storage')
    expect(sanitizeUploadErrorCategory(new Error('503 gateway'))).toBe('server')
    expect(sanitizeUploadErrorCategory(new Error('Bearer sk_live_abc leaked'))).toBe('unknown')
  })

  it('shows only the current user’s pending uploads (cross-account isolation)', () => {
    const all = [pending({ id: 'a', userId: 'user-A' }), pending({ id: 'b', userId: 'user-B' })]
    const forA = visiblePendingUploads(all, 'user-A', new Set())
    expect(forA.map((p) => p.id)).toEqual(['a'])
    const forB = visiblePendingUploads(all, 'user-B', new Set())
    expect(forB.map((p) => p.id)).toEqual(['b'])
  })

  it('de-duplicates against cloud recordings (no duplicate row after a successful retry)', () => {
    const all = [pending({ id: 'a' }), pending({ id: 'b' })]
    // 'a' already exists in cloud (e.g. a prior retry uploaded it) → hide it
    const visible = visiblePendingUploads(all, 'user-A', new Set(['a']))
    expect(visible.map((p) => p.id)).toEqual(['b'])
  })

  it('orders newest-first for stable placement', () => {
    const all = [pending({ id: 'old', createdAt: 100 }), pending({ id: 'new', createdAt: 900 })]
    expect(visiblePendingUploads(all, 'user-A', new Set()).map((p) => p.id)).toEqual(['new', 'old'])
  })

  it('produces safe, clear status labels', () => {
    expect(pendingStatusLabel({ state: 'upload_failed' })).toMatch(/Retry required/)
    expect(pendingStatusLabel({ state: 'uploading' })).toBe('Uploading…')
    const detail = pendingStatusDetail({ state: 'upload_failed', lastErrorCategory: 'network' })
    expect(detail).toMatch(/safe on this device/)
    expect(detail).toMatch(/nothing needs to be re-recorded/)
    expect(detail).not.toMatch(/sk_|Bearer|token/i)
  })

  /**
   * Owner QA evidence: two rows landed in the staging DB with `course_id:
   * null` but a real-looking `course: "Staging ML Test"` text label — a
   * legacy pending upload (created before course-id capture existed)
   * retried through `handleRetryPendingUpload`, which had no guard at all.
   * `pendingUploadNeedsCourseChoice` is the single source of truth the
   * retry handler and the Pending Uploads list UI both consult, so they can
   * never disagree about whether a real Course choice is still required.
   */
  describe('a legacy pending upload with no canonical course id', () => {
    it('needs an explicit Course choice — courseId absent, null, or empty are all "needs choice"', () => {
      expect(pendingUploadNeedsCourseChoice(pending({ courseId: undefined }))).toBe(true)
      expect(pendingUploadNeedsCourseChoice(pending({ courseId: null }))).toBe(true)
    })

    it('a pending upload with a real courseId does not need a choice', () => {
      expect(pendingUploadNeedsCourseChoice(pending({ courseId: 'course-c' }))).toBe(false)
    })
  })
})
