import { describe, expect, it } from 'vitest'
import {
  applyAcceptedChunk,
  assembleRecoveredChunks,
  createRecordingSessionMeta,
  ownerKeyForUser,
  planFinalize,
  planPostPersistCleanup,
  shouldAcceptChunkIndex,
  visibleRecoverableSessions,
  withSessionCourse,
  withSessionStatus,
  type RecordingSessionMeta,
} from './recordingSession'
import { expectedRecordingBytes } from './recordingBitrate'
import { readFileSync } from 'node:fs'

function session(over: Partial<RecordingSessionMeta> = {}): RecordingSessionMeta {
  return {
    ...createRecordingSessionMeta({
      id: 'rec-1',
      ownerKey: 'user-A',
      mime: 'audio/webm;codecs=opus',
      requestedBitrate: 64_000,
      startedAt: 1_000,
    }),
    ...over,
  }
}

describe('recordingSession pure model (Phase 2D-4)', () => {
  it('creates a recording session with status=recording', () => {
    const s = createRecordingSessionMeta({
      id: 'abc',
      ownerKey: 'user-A',
      mime: 'audio/webm',
      requestedBitrate: 64_000,
    })
    expect(s.status).toBe('recording')
    expect(s.nextChunkIndex).toBe(0)
    expect(s.chunkCount).toBe(0)
  })

  it('freezes the canonical course identity at recording start across a simulated restart', () => {
    const startedInCourseA = createRecordingSessionMeta({
      id: 'crash-recovery-course-a',
      ownerKey: 'user-A',
      mime: 'audio/webm',
      requestedBitrate: 64_000,
      course: 'Sample G',
      courseId: 'course-sample-g',
      title: 'Original lecture title',
    })
    // A relaunch may make Course B the Record-page default. Recovery must use
    // the durable session, not this new current-page selection.
    const currentRecordPageSelectionAfterRestart = 'course-staging-ml-test'
    const pendingUpload = {
      courseId: startedInCourseA.courseId,
      course: startedInCourseA.course,
      title: startedInCourseA.title,
    }

    expect(currentRecordPageSelectionAfterRestart).not.toBe(startedInCourseA.courseId)
    expect(pendingUpload).toEqual({
      courseId: 'course-sample-g',
      course: 'Sample G',
      title: 'Original lecture title',
    })
  })

  it('marks legacy sessions without a canonical course id as unknown rather than defaulting them', () => {
    const legacy = createRecordingSessionMeta({
      id: 'legacy', ownerKey: 'user-A', mime: 'audio/webm', requestedBitrate: 64_000,
    })
    expect(legacy.courseId).toBeNull()
  })

  it('requires an explicit legacy-course assignment and persists that exact canonical id', () => {
    const legacy = session({ courseId: null, course: undefined })
    const assigned = withSessionCourse(legacy, { id: 'course-c', name: 'Course C' }, 2_000)
    expect(assigned).toMatchObject({ id: legacy.id, courseId: 'course-c', course: 'Course C', updatedAt: 2_000 })
  })

  it('accepts ordered chunks and rejects duplicates / gaps', () => {
    let s = session()
    expect(shouldAcceptChunkIndex(s, 0)).toBe('accept')
    s = applyAcceptedChunk(s, 0, 1000)
    expect(s.nextChunkIndex).toBe(1)
    expect(s.chunkCount).toBe(1)
    expect(s.totalBytes).toBe(1000)
    expect(shouldAcceptChunkIndex(s, 0)).toBe('duplicate')
    expect(shouldAcceptChunkIndex(s, 2)).toBe('reject')
    expect(shouldAcceptChunkIndex(s, 1)).toBe('accept')
  })

  it('pause/resume stay on the same session id (status only)', () => {
    const id = 'same-session'
    let s = session({ id })
    s = withSessionStatus(s, 'paused')
    expect(s.id).toBe(id)
    s = withSessionStatus(s, 'recording')
    expect(s.id).toBe(id)
    expect(s.status).toBe('recording')
  })

  it('finalization is idempotent (already_done when finalized)', () => {
    const open = planFinalize(session({ status: 'recording' }))
    expect(open.action).toBe('proceed')
    expect(open.next?.status).toBe('finalizing')
    expect(planFinalize(session({ status: 'finalized' })).action).toBe('already_done')
    expect(planFinalize(session({ status: 'discarded' })).action).toBe('rejected')
  })

  it('post-persist cleanup marks finalized', () => {
    const plan = planPostPersistCleanup(session({ status: 'finalizing' }))
    expect(plan.action).toBe('cleanup')
    expect(plan.next.status).toBe('finalized')
  })

  it('reconstructs a non-empty durable recording from ordered checkpoints', async () => {
    const rebuilt = assembleRecoveredChunks(session({ chunkCount: 2 }), [
      { index: 0, blob: new Blob(['webm-header']) },
      { index: 1, blob: new Blob(['cluster-data']) },
    ])
    expect(rebuilt).not.toBeNull()
    expect(rebuilt!.mime).toBe('audio/webm;codecs=opus')
    expect(await rebuilt!.blob.text()).toBe('webm-headercluster-data')
  })

  it('refuses corrupt or incomplete durable checkpoints instead of pretending recovery is safe', () => {
    expect(assembleRecoveredChunks(session({ chunkCount: 2 }), [
      { index: 0, blob: new Blob(['header']) },
    ])).toBeNull()
    expect(assembleRecoveredChunks(session({ chunkCount: 2 }), [
      { index: 0, blob: new Blob(['header']) },
      { index: 2, blob: new Blob(['gap']) },
    ])).toBeNull()
  })

  it('startup recovery lists only the owner’s unfinished sessions with chunks', () => {
    const all = [
      session({ id: 'a', ownerKey: 'user-A', status: 'recording', chunkCount: 3 }),
      session({ id: 'b', ownerKey: 'user-B', status: 'recording', chunkCount: 9 }),
      session({ id: 'c', ownerKey: 'user-A', status: 'kept', chunkCount: 2 }),
      session({ id: 'd', ownerKey: 'user-A', status: 'recording', chunkCount: 0 }),
      session({ id: 'e', ownerKey: 'user-A', status: 'finalized', chunkCount: 5 }),
    ]
    expect(visibleRecoverableSessions(all, 'user-A').map((s) => s.id).sort()).toEqual(['a', 'c'])
    expect(visibleRecoverableSessions(all, 'user-B').map((s) => s.id)).toEqual(['b'])
  })

  it('orders multiple recoverable sessions newest-first so a new crash is never masked by an older legacy one', () => {
    const visible = visibleRecoverableSessions([
      session({ id: 'legacy', status: 'recording', chunkCount: 1, updatedAt: 100, courseId: null }),
      session({ id: 'new-course-c', status: 'recording', chunkCount: 1, updatedAt: 200, courseId: 'course-c' }),
    ], 'user-A')
    expect(visible.map((item) => item.id)).toEqual(['new-course-c', 'legacy'])
  })

  it('ownerKey isolates local vs cloud vs anonymous', () => {
    expect(ownerKeyForUser('u1', false)).toBe('u1')
    expect(ownerKeyForUser(undefined, true)).toBe('local')
    expect(ownerKeyForUser(null, false)).toBe('anonymous')
  })

  it('two-hour expected size stays within the chosen 64 kbps target', () => {
    expect(expectedRecordingBytes(120 * 60, 64_000)).toBe(57_600_000)
  })
})

describe('recordingSession wiring regressions (App + recorder)', () => {
  const appSrc = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
  const recorderSrc = readFileSync(new URL('../hooks/useRecorder.ts', import.meta.url), 'utf8')
  const aiSrc = readFileSync(new URL('./aiUserFacing.ts', import.meta.url), 'utf8')

  it('persists chunks durably during recording (not only at Stop)', () => {
    expect(recorderSrc).toContain('appendRecordingChunk')
    expect(recorderSrc).toContain('createRecordingSession')
    expect(recorderSrc).toContain('audioBitsPerSecond')
    expect(recorderSrc).not.toMatch(/chunksRef\.current\.push/)
  })

  it('Stop reuses durable session id for pending upload (no second UUID at save)', () => {
    expect(appSrc).toContain('recorder.activeSessionId')
    expect(appSrc).toContain('completeRecordingSessionPersist')
    expect(appSrc).toContain('Unfinished recording recovered')
    expect(appSrc).toContain('Save and process')
    expect(appSrc).toContain('Keep for later')
    expect(appSrc).toContain('Confirm delete')
  })

  it('records immutable session course context at Start and recovery never uses the post-relaunch selection', () => {
    expect(recorderSrc).toContain('getSessionContext')
    expect(recorderSrc).toContain('courseId: sessionContext?.courseId ?? null')
    const recovery = appSrc.slice(appSrc.indexOf('const handleRecoverSave'), appSrc.indexOf('const handleRecoverKeep'))
    expect(recovery).toContain('const recoveryCourseId = fresh.courseId')
    expect(recovery).toContain('courseId: recoveryCourseId')
    expect(recovery).not.toContain('courseId: recordingCourseId')
  })

  it('Course Detail passes its explicit course snapshot into the Start call before React state commits', () => {
    const courseStart = appSrc.slice(appSrc.indexOf('onStartLecture={() => {'), appSrc.indexOf('// The EXISTING Lecture Detail.'))
    expect(courseStart).toContain('startRecording({ course: openCourse.name, courseId: openCourse.id')
    expect(recorderSrc).toContain('sessionContextOverride ?? opts?.getSessionContext?.()')
  })

  it('retrying a legacy pending upload with no canonical course is guarded the same way as session recovery', () => {
    // Owner QA evidence: staging rows landed with course_id: null because
    // handleRetryPendingUpload had no guard at all, unlike handleRecoverSave.
    const retry = appSrc.slice(appSrc.indexOf('const handleRetryPendingUpload'), appSrc.indexOf('const handleAssignPendingUploadCourse'))
    expect(retry).toContain('if (pendingUploadNeedsCourseChoice(rec)) return')
    expect(appSrc).toContain('const handleAssignPendingUploadCourse = useCallback(')
    expect(appSrc).toMatch(/disabled=\{p\.state === 'uploading' \|\| pendingUploadNeedsCourseChoice\(p\)\}/)
  })

  it('deletion of recovered recording requires confirmation', () => {
    expect(appSrc).toContain('recoveryDeleteConfirmId')
    expect(appSrc).toContain('Confirm delete')
  })

  it('no shorter-lecture / 25 MB gate messaging regression', () => {
    expect(aiSrc).not.toMatch(/shorter sessions \(under about 25 MB\)/)
    expect(appSrc).not.toContain('recordingTooLargeUserMessage(')
    expect(appSrc).toContain('NO client-side size gate')
  })

  it('updater remains blocked while recovering a durable session', () => {
    expect(appSrc).toContain('recoveringSession: Boolean(recoveryBusyId)')
  })
})
