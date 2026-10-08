import { buildTextStack } from '../lib/bilingualCaptionStack'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LectureProcessingPanel } from './LectureProcessingPanel'
import { LectureDetailPage } from './LectureDetailPage'
import { RecordingV2 } from './RecordingV2'
import { translateDesktop } from '../lib/desktopI18n'
import { processingStageStates } from '../lib/processingStages'
import { isTerminalRecordingStage, ownsRecordingScreen, resolveRecordingV2Stage } from '../lib/recordingV2Stage'
import type { ProcessingPhase } from '../lib/lectureLifecycle'
import type { Recording, RecordingDetail } from '../types'

const t = (key: Parameters<typeof translateDesktop>[1], vars?: Record<string, string | number>) => translateDesktop('en', key, vars)

function panel(phase: ProcessingPhase, extra: Partial<Parameters<typeof LectureProcessingPanel>[0]> = {}): string {
  return renderToStaticMarkup(createElement(LectureProcessingPanel, { t, phase, ...extra }))
}

describe('the Processing panel shows only stages the backend can distinguish', () => {
  it('lists Recording saved, Transcribing audio, Generating summary — and nothing else', () => {
    const html = panel('transcribing')
    expect(html).toContain('Processing your lecture')
    expect(html).toContain('Recording saved')
    expect(html).toContain('Transcribing audio')
    expect(html).toContain('Generating summary')
    expect(html).not.toMatch(/Preparing/i)
  })

  it('never shows a percentage or a progress bar — the backend has no fraction', () => {
    for (const phase of ['waiting', 'transcribing', 'summarizing'] as const) {
      const html = panel(phase)
      expect(html).not.toMatch(/\d+\s?%/)
      expect(html).not.toMatch(/<progress|role="progressbar"|aria-valuenow/)
    }
  })

  it('marks the stage the server is actually in', () => {
    expect(processingStageStates('waiting')).toEqual({ transcribing: 'pending', summarizing: 'pending' })
    expect(processingStageStates('transcribing')).toEqual({ transcribing: 'active', summarizing: 'pending' })
    expect(processingStageStates('summarizing')).toEqual({ transcribing: 'done', summarizing: 'active' })
    expect(processingStageStates('done')).toEqual({ transcribing: 'done', summarizing: 'done' })
  })

  it('renders the active stage as the current step', () => {
    expect(panel('summarizing')).toMatch(/aria-current="step"[^>]*>[\s\S]*?Generating summary/)
  })

  it('says it is waiting to start while the job is queued, and says the user may leave', () => {
    const html = panel('waiting')
    expect(html).toContain('Waiting to start')
    expect(html).toContain('You can leave this screen')
  })

  it('tells the user it is safe to leave: processing continues server-side', () => {
    expect(panel('transcribing')).toContain('processing continues')
  })
})

describe('failure and completion', () => {
  it('failed: says so, says the recording is safe, and offers Retry', () => {
    const html = panel('failed')
    expect(html).toContain('Processing failed')
    expect(html).toContain('Your recording is safe')
    expect(html).toContain('Try again')
    expect(html).toContain('role="alert"')
    expect(html).not.toContain('lecture-processing__spinner')
  })

  it('done: a clear completed state with View lecture as the primary action', () => {
    const html = panel('done', { onViewLecture: () => undefined })
    expect(html).toContain('Your lecture is ready')
    expect(html).toContain('View lecture')
    expect(html).toContain('v2-btn--record')
  })

  it('done without a handler offers no dead button', () => {
    expect(panel('done')).not.toContain('View lecture')
  })

  it('in flight offers no View lecture — the lecture is not ready', () => {
    for (const phase of ['waiting', 'transcribing', 'summarizing'] as const) {
      expect(panel(phase, { onViewLecture: () => undefined })).not.toContain('View lecture')
    }
  })

  it('a stalled job says it is taking longer and offers Retry', () => {
    const html = panel('transcribing', { stalled: true })
    expect(html).toContain('Taking longer than usual')
    expect(html).toContain('Try again')
  })

  it('a healthy in-flight job offers no Retry (the server is working; a repeat would not help)', () => {
    expect(panel('transcribing')).not.toContain('Try again')
  })
})

/* ── The saved screen right after Stop & Save ───────────────────────────── */

const cs = { icon: 'book', tint: '#E7F2EA', accent: '#3F8C68' }
function saved(overrides: Partial<Parameters<typeof RecordingV2>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(RecordingV2, {
      t,
      stage: 'ai_processing' as const,
      courseName: 'CS 101',
      courseIdentity: cs,
      lectureTitle: 'Lecture 13',
      elapsed: '12:04',
      languageLine: 'English → Chinese',
      captions: buildTextStack({ sourceCommitted: 'One. Two.', sourceDraft: '', translationCommitted: '', translationDraft: '' }),
      translationEnabled: true,
      notice: null,
      failureMessage: null,
      busy: false,
      canOpenOverlay: false,
      onOpenOverlay: () => undefined,
      onDiscard: () => undefined,
      onPause: () => undefined,
      onResume: () => undefined,
      onStopAndSave: () => undefined,
      onViewLecture: () => undefined,
      onRecordAnother: () => undefined,
      onRetry: () => undefined,
      onRecoverRecording: () => undefined,
      onDiscardRecovery: () => undefined,
      onCancelRecoveryDiscard: () => undefined,
      recoveryDiscardConfirm: false,
      processing: { phase: 'transcribing', stalled: false },
      onRetryProcessing: () => undefined,
      ...overrides,
    }),
  )
}

describe('after Stop & Save the user sees a Processing screen, not an empty lecture', () => {
  it('shows the Processing screen with the stage list, and no View lecture yet', () => {
    const html = saved()
    expect(html).toContain('Processing your lecture')
    expect(html).toContain('Transcribing audio')
    expect(html).not.toContain('View lecture')
  })

  it('offers Record another while processing — the user is not trapped', () => {
    expect(saved()).toContain('Record another')
  })

  it('failure: Processing failed with Retry, and the recording is called safe', () => {
    const html = saved({ stage: 'ai_failed', processing: { phase: 'failed', stalled: false } })
    expect(html).toContain('Processing failed')
    expect(html).toContain('Your recording is safe')
    expect(html).toContain('Try again')
  })

  it('done: a clear completed state and the explicit View lecture CTA', () => {
    const html = saved({ stage: 'ready', processing: { phase: 'done', stalled: false } })
    expect(html).toContain('Your lecture is ready')
    expect(html).toContain('View lecture')
  })

  it('without a hosted pipeline (local-only / own key) the saved screen is the plain one', () => {
    const html = saved({ stage: 'ready', processing: null })
    expect(html).toContain('Lecture saved')
    expect(html).not.toContain('Processing your lecture')
  })

  it('keeps the captions readable on the Processing screen', () => {
    expect(saved()).toContain('recording-v2__history')
  })
})

describe('the Processing stages never trap the user', () => {
  it('are terminal-style: not pinned, so navigation away is allowed', () => {
    expect(isTerminalRecordingStage('ai_processing')).toBe(true)
    expect(isTerminalRecordingStage('ai_failed')).toBe(true)
    expect(ownsRecordingScreen('ai_processing')).toBe(false)
    expect(ownsRecordingScreen('ai_failed')).toBe(false)
  })
})

const stageBase = {
  recorderStatus: 'idle' as const,
  flowPhase: 'idle' as const,
  recentAi: null,
  saved: null,
  recoveryPending: false,
}
const ok = { kind: 'success', recordingId: 'r1', at: 1 } as const

describe('resolveRecordingV2Stage — authoritative processing drives the saved stage', () => {
  it('waiting / transcribing / summarizing → ai_processing', () => {
    for (const ai of ['waiting', 'transcribing', 'summarizing'] as const) {
      expect(resolveRecordingV2Stage({ ...stageBase, recentCapture: ok, ai })).toBe('ai_processing')
    }
  })
  it('failed → ai_failed; done → ready', () => {
    expect(resolveRecordingV2Stage({ ...stageBase, recentCapture: ok, ai: 'failed' })).toBe('ai_failed')
    expect(resolveRecordingV2Stage({ ...stageBase, recentCapture: ok, ai: 'done', saved: { transcriptReady: true, summaryReady: true } })).toBe('ready')
  })
  it('no hosted pipeline (ai null) keeps the old saved stage', () => {
    expect(resolveRecordingV2Stage({ ...stageBase, recentCapture: ok, ai: null })).toBe('ready')
  })
  it('also applies after a list-refresh warning (the save still succeeded)', () => {
    expect(resolveRecordingV2Stage({ ...stageBase, recentCapture: { kind: 'list_refresh_warn', recordingId: 'r1', message: 'm', at: 1 }, ai: 'transcribing' })).toBe('ai_processing')
  })
  it('a failed SAVE is still upload_failed — processing state never masks it', () => {
    expect(resolveRecordingV2Stage({ ...stageBase, recentCapture: { kind: 'failure', recordingId: 'r1', outcome: 'other', message: 'm', at: 1 }, ai: 'waiting' })).toBe('upload_failed')
  })
  it('a live mic still outranks everything', () => {
    expect(resolveRecordingV2Stage({ ...stageBase, recorderStatus: 'recording', recentCapture: ok, ai: 'failed' })).toBe('recording')
  })
})

/* ── Lecture Detail: leave, reopen, relaunch ─────────────────────────────── */

const recording: Recording = { id: 'r1', course: 'CS 250', title: 'Lecture 1', createdAt: 0, durationSec: 600, mime: 'audio/webm', storagePath: 'u1/r1.webm' }
const props = {
  t,
  course: null,
  audioUrl: null,
  languageLine: 'English → Chinese',
  formatDate: (ms: number) => String(ms),
  formatDuration: (s: number) => `${s}s`,
  onBack: () => undefined,
  backLabel: 'Courses',
  onRename: () => undefined,
  onMove: () => undefined,
  onDelete: () => undefined,
  actionsDisabled: false,
  onSaveNotes: async () => undefined,
  onAddMark: async () => undefined,
  annotationsEditable: true,
}
function detailPage(
  rec: Recording,
  detail: RecordingDetail | null,
  extra: Partial<Parameters<typeof LectureDetailPage>[0]> = {},
): string {
  return renderToStaticMarkup(createElement(LectureDetailPage, { ...props, recording: rec, detail, ...extra }))
}
const finished: RecordingDetail = { ...recording, aiStatus: 'done', transcript: 'The lecture began.', summaryEn: '## Overview\nGradients.' }

describe('reopening a lecture shows the persisted result (the 2026-10-04 reopen bug)', () => {
  it('a finished lecture shows its transcript and summary — also while the detail is still loading', () => {
    const html = detailPage(finished, null, { detailLoading: true })
    expect(html).toContain('Overview')
    expect(html).not.toContain('Loading lecture')
    expect(html).not.toContain('Processing your lecture')
  })

  it('a finished lecture keeps showing its result even if the authoritative read FAILS (database outage)', () => {
    const html = detailPage(finished, null, { detailLoadFailed: true })
    expect(html).toContain('Overview')
    expect(html).not.toContain('Couldn’t load this content')
  })

  it('the finished result is identical whether it came from the list row or the loaded detail', () => {
    const fromList = detailPage(finished, null)
    const fromDetail = detailPage(finished, finished)
    const body = (html: string) => html.slice(html.indexOf('lecture-v2__tabs'), html.indexOf('lecture-v2__player'))
    expect(body(fromList)).toBe(body(fromDetail))
  })

  it('a stale list row that says "transcribing" never shows as Processing while the authoritative read is pending', () => {
    const stale: Recording = { ...recording, aiStatus: 'transcribing' }
    const html = detailPage(stale, null, { detailLoading: true })
    expect(html).toContain('Loading lecture')
    expect(html).not.toContain('Processing your lecture')
  })

  it('an unfinished lecture whose authoritative read failed shows an explicit error with Retry — never "No transcript yet"', () => {
    const html = detailPage({ ...recording, aiStatus: 'transcribing' }, null, { detailLoadFailed: true })
    expect(html).toContain('Couldn’t load this content')
    expect(html).toContain('Try again')
    expect(html).not.toContain('No transcript yet')
  })
})

describe('opening a lecture mid-processing reopens the Processing experience', () => {
  it.each([
    ['pending', 'Waiting to start'],
    ['queued', 'Waiting to start'],
    ['transcribing', 'Transcribing audio'],
    ['summarizing', 'Generating summary'],
  ] as const)('%s → the Processing screen', (aiStatus, text) => {
    const html = detailPage({ ...recording, aiStatus }, { ...recording, aiStatus })
    expect(html).toContain('Processing your lecture')
    expect(html).toContain(text)
    expect(html).not.toContain('role="tablist"')
    expect(html).toContain('data-status="processing"')
  })

  it('failed → Processing failed + Retry, on the same lecture', () => {
    const html = detailPage({ ...recording, aiStatus: 'failed' }, { ...recording, aiStatus: 'failed' })
    expect(html).toContain('Processing failed')
    expect(html).toContain('Try again')
    expect(html).toContain('data-status="failed"')
  })

  it('a stalled in-flight job offers Retry', () => {
    const html = detailPage(
      { ...recording, aiStatus: 'transcribing', aiUpdatedAt: Date.now() - 20 * 60_000 },
      null,
      {},
    )
    expect(html).toContain('Taking longer than usual')
    expect(html).toContain('Try again')
  })

  it('done → the normal lecture, not a processing placeholder', () => {
    const html = detailPage(finished, finished)
    expect(html).not.toContain('Processing your lecture')
    expect(html).toContain('role="tablist"')
    expect(html).toContain('data-status="ready"')
  })

  it('keeps the audio player and marks while processing or failed — audio is independent of AI', () => {
    for (const aiStatus of ['transcribing', 'failed'] as const) {
      const html = detailPage({ ...recording, aiStatus }, { ...recording, aiStatus }, { audioUrl: 'blob:audio' })
      expect(html).toContain('<audio')
      expect(html).toContain('Marked moments')
    }
  })

  it('the header badge and the panel agree', () => {
    const html = detailPage({ ...recording, aiStatus: 'transcribing' }, null)
    expect(html).toContain('>Processing</span>')
    expect(html).toContain('Processing your lecture')
  })

  it('local-only / own-key lectures are not forced into hosted processing', () => {
    const html = detailPage({ ...recording, aiStatus: 'pending' }, null, { aiExpected: false })
    expect(html).not.toContain('Processing your lecture')
    expect(html).toContain('data-status="ready"')
  })
})
