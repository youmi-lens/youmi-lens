/**
 * Stop & Save routing.
 *
 * The regression: `desktopV2View` selected the recording screen from
 * `recorder.status !== 'idle'`. `handleStopAndSave` awaits `recorder.stop()` as
 * its FIRST step, so the recorder reports idle while the pipeline is still
 * stopping the mic, uploading, writing the row and refreshing the list — and the
 * user was dropped onto Record Home mid-save, with the outcome banner living
 * only in the legacy tree where V2 never rendered it.
 */
import { describe, expect, it } from 'vitest'
import {
  isTerminalRecordingStage,
  ownsRecordingScreen,
  resolveRecordingV2Stage,
  RECORDING_STAGE_BODY_KEY,
  RECORDING_STAGE_TITLE_KEY,
  type RecordingV2StageInput,
} from './recordingV2Stage'
import { DESKTOP_I18N_KEYS, DESKTOP_I18N_LOCALES, translateDesktop } from './desktopI18n'

const base: RecordingV2StageInput = {
  recorderStatus: 'idle',
  flowPhase: 'idle',
  recentCapture: null,
  recentAi: null,
  saved: null,
  recoveryPending: false,
}

const stage = (over: Partial<RecordingV2StageInput>) =>
  resolveRecordingV2Stage({ ...base, ...over })

const savedOk = { kind: 'success', recordingId: 'r1', at: 1 } as const
const savedFail = {
  kind: 'failure',
  recordingId: 'r1',
  outcome: 'storage_failed',
  message: 'Upload failed.',
  at: 1,
} as const

describe('live capture', () => {
  it('a live mic outranks every other signal', () => {
    expect(stage({ recorderStatus: 'recording' })).toBe('recording')
    expect(stage({ recorderStatus: 'paused' })).toBe('paused')
    // Even mid-pipeline, audio still being captured keeps the live screen.
    expect(stage({ recorderStatus: 'recording', flowPhase: 'saving_upload' })).toBe('recording')
  })
})

describe('the capture pipeline', () => {
  it('covers the exact window the old condition missed', () => {
    // recorder.stop() has already resolved here — this is where the user used
    // to be thrown back to Record Home.
    expect(stage({ flowPhase: 'stopping' })).toBe('saving_local')
  })

  it('maps every upload phase to one uploading screen', () => {
    expect(stage({ flowPhase: 'saving_upload' })).toBe('uploading')
    expect(stage({ flowPhase: 'saving_db' })).toBe('uploading')
    expect(stage({ flowPhase: 'verifying' })).toBe('uploading')
  })

  it('maps the AI phases', () => {
    expect(stage({ flowPhase: 'transcribing' })).toBe('processing_transcript')
    expect(stage({ flowPhase: 'summarizing' })).toBe('processing_summary')
  })

  it('keeps the screen through every phase of a real save', () => {
    const walk: RecordingV2StageInput['flowPhase'][] = [
      'stopping', 'saving_upload', 'saving_db', 'verifying', 'transcribing', 'summarizing',
    ]
    for (const flowPhase of walk) {
      expect(ownsRecordingScreen(stage({ flowPhase })), flowPhase).toBe(true)
    }
  })
})

describe('completion', () => {
  it('a saved recording with no row yet is ready', () => {
    expect(stage({ recentCapture: savedOk })).toBe('ready')
  })

  it('transcript and summary both present is ready', () => {
    expect(
      stage({ recentCapture: savedOk, saved: { transcriptReady: true, summaryReady: true } }),
    ).toBe('ready')
  })

  it('transcript without summary is partial', () => {
    expect(
      stage({ recentCapture: savedOk, saved: { transcriptReady: true, summaryReady: false } }),
    ).toBe('partial_ready')
  })

  it('a list-refresh warning is still a successful save', () => {
    const warn = { kind: 'list_refresh_warn', recordingId: 'r1', message: 'x', at: 1 } as const
    expect(stage({ recentCapture: warn })).toBe('ready')
  })

  it('an AI failure after a successful save is never reported as a lost recording', () => {
    // The row and its audio are safe; only the AI step failed.
    const aiFail = { kind: 'summarize_failed', recordingId: 'r1', message: 'x', at: 2 } as const
    expect(
      stage({
        recentCapture: savedOk,
        recentAi: aiFail,
        saved: { transcriptReady: true, summaryReady: false },
      }),
    ).toBe('partial_ready')
    expect(stage({ recentCapture: savedOk, recentAi: aiFail })).toBe('ready')
  })
})

describe('failure and recovery', () => {
  it('a failed save keeps the screen so the reason and the retry are visible', () => {
    expect(stage({ recentCapture: savedFail })).toBe('upload_failed')
    // A failed save still RENDERS on Record (a terminal stage), but it no
    // longer PINS navigation — the user can leave to Courses/Settings.
    expect(ownsRecordingScreen('upload_failed')).toBe(false)
  })

  it('a failure outranks a pending recovery', () => {
    expect(stage({ recentCapture: savedFail, recoveryPending: true })).toBe('upload_failed')
  })

  it('recovery surfaces only when nothing else is in flight', () => {
    expect(stage({ recoveryPending: true })).toBe('recovery_required')
    expect(stage({ recoveryPending: true, flowPhase: 'saving_upload' })).toBe('uploading')
    expect(stage({ recoveryPending: true, recorderStatus: 'recording' })).toBe('recording')
  })
})

describe('leaving the flow', () => {
  it('an idle recorder with no outcome does not own the screen', () => {
    expect(stage({})).toBe('none')
    expect(ownsRecordingScreen('none')).toBe(false)
  })

  it('only the four waiting-on-the-user stages are terminal', () => {
    expect(isTerminalRecordingStage('ready')).toBe(true)
    expect(isTerminalRecordingStage('partial_ready')).toBe(true)
    expect(isTerminalRecordingStage('upload_failed')).toBe(true)
    expect(isTerminalRecordingStage('recovery_required')).toBe(true)
    expect(isTerminalRecordingStage('uploading')).toBe(false)
    expect(isTerminalRecordingStage('recording')).toBe(false)
  })

  it('terminal stages render on Record but never pin navigation', () => {
    // P0 regression: a pending recovery used to make the sidebar appear dead
    // because `ownsRecordingScreen` treated every non-'none' stage as owning
    // (pinning) the view. Terminal stages wait on the user, so they must let
    // navigation through while still rendering on Record.
    const terminal = ['ready', 'partial_ready', 'upload_failed', 'recovery_required'] as const
    for (const s of terminal) {
      expect(ownsRecordingScreen(s), s).toBe(false)
    }
    // The active flow still owns (pins) the screen: a live mic or an in-flight
    // save cannot be abandoned by clicking Courses/Settings.
    const active = [
      'recording',
      'paused',
      'saving_local',
      'uploading',
      'processing_transcript',
      'processing_summary',
    ] as const
    for (const s of active) {
      expect(ownsRecordingScreen(s), s).toBe(true)
    }
  })
})

describe('stage copy', () => {
  it('every stage key exists in every locale and resolves cleanly', () => {
    const keys = [
      ...Object.values(RECORDING_STAGE_TITLE_KEY),
      ...Object.values(RECORDING_STAGE_BODY_KEY),
    ]
    for (const key of keys) {
      expect(DESKTOP_I18N_KEYS, key).toContain(key)
      for (const locale of DESKTOP_I18N_LOCALES) {
        const text = translateDesktop(locale, key)
        expect(text.length, `${locale}/${key}`).toBeGreaterThan(0)
        expect(text, `${locale}/${key}`).not.toMatch(/\{[A-Za-z_]/)
      }
    }
  })

  it('an upload failure never claims the audio was lost', () => {
    for (const locale of DESKTOP_I18N_LOCALES) {
      expect(translateDesktop(locale, 'recording.uploadFailedBody').length).toBeGreaterThan(0)
    }
    expect(translateDesktop('en', 'recording.uploadFailedBody')).toContain('nothing has been lost')
  })
})
