import type { RecordingFlowPhase } from './recordingFlow'
import type { ProcessingPhase } from './lectureLifecycle'
import type { RecentAiOutcome, RecentCaptureOutcome } from './recentOutcomes'

/**
 * Which V2 screen the recording flow is on, derived from existing production
 * state. Nothing here starts, stops, retries or uploads anything.
 *
 * Why this module exists: `desktopV2View` selected the recording screen from
 * `recorder.status !== 'idle'` alone. `handleStopAndSave` awaits
 * `recorder.stop()` as its FIRST step, so the recorder reports idle while the
 * capture pipeline is still stopping the mic, uploading audio, writing the row
 * and refreshing the list. At that instant the V2 view fell back to Record Home
 * — the user was thrown out of the recording flow mid-save, and the save
 * outcome banner only ever existed in the legacy tree, so nothing told them what
 * had happened.
 *
 * The stage is a pure function of state that already exists. The flow phases,
 * the outcome records and the recording row are all unchanged.
 */

export type RecordingV2Stage =
  /** Mic still live. */
  | 'recording'
  | 'paused'
  /** Mic stopped, audio being written locally. */
  | 'saving_local'
  /** Audio uploading, then row insert and list refresh. */
  | 'uploading'
  | 'processing_transcript'
  | 'processing_summary'
  /** Transcript exists, summary does not. Detail is already useful. */
  | 'partial_ready'
  /**
   * Saved, and the hosted server is transcribing / summarizing it. NOT a pinned
   * stage: the user may leave, processing continues, and the lecture shows
   * Processing in Courses.
   */
  | 'ai_processing'
  /** The server could not process a saved lecture. The recording is safe; Retry. */
  | 'ai_failed'
  | 'ready'
  | 'upload_failed'
  /** An unfinished durable session was found and needs the user's decision. */
  | 'recovery_required'
  /** Not in the recording flow at all. */
  | 'none'

export type RecordingV2StageInput = {
  recorderStatus: 'idle' | 'recording' | 'paused'
  flowPhase: RecordingFlowPhase
  recentCapture: RecentCaptureOutcome
  recentAi: RecentAiOutcome
  /** The saved row, once it has loaded. */
  saved: { transcriptReady: boolean; summaryReady: boolean } | null
  /** True while an unfinished session from a previous run awaits a decision. */
  recoveryPending: boolean
  /**
   * The authoritative processing phase of the lecture that was just saved, from
   * `lectureLifecycle`. `null` when no hosted pipeline applies (local-only,
   * own key) or nothing is pending, in which case the saved stage is as before.
   */
  ai?: ProcessingPhase | null
}

/** Terminal stages: the flow is finished and the screen is waiting on the user. */
const TERMINAL: ReadonlySet<RecordingV2Stage> = new Set<RecordingV2Stage>([
  'ready',
  'partial_ready',
  'ai_processing',
  'ai_failed',
  'upload_failed',
  'recovery_required',
])

export function isTerminalRecordingStage(stage: RecordingV2Stage): boolean {
  return TERMINAL.has(stage)
}

/**
 * True while the recording flow must PIN the screen — live capture and the
 * in-flight save/upload/AI pipeline. These are the stages that outrank
 * navigation: the user cannot abandon a live mic or a mid-save upload by
 * clicking Courses/Settings.
 *
 * The four terminal stages (ready / partial_ready / upload_failed /
 * recovery_required) are deliberately NOT owned here. They wait on the user,
 * so they must never trap the user on the Record screen. They still RENDER on
 * Record — `desktopV2View` shows them via `isTerminalRecordingStage` when the
 * workspace is `record` — but navigating away is allowed and is not forced
 * back.
 */
export function ownsRecordingScreen(stage: RecordingV2Stage): boolean {
  return stage !== 'none' && !isTerminalRecordingStage(stage)
}

export function resolveRecordingV2Stage(input: RecordingV2StageInput): RecordingV2Stage {
  const { recorderStatus, flowPhase, recentCapture, recentAi, saved, recoveryPending, ai = null } = input

  // A live mic outranks everything: never leave the recording screen while
  // audio is still being captured.
  if (recorderStatus === 'recording') return 'recording'
  if (recorderStatus === 'paused') return 'paused'

  // The capture pipeline. `stopping` is the window the old condition missed.
  switch (flowPhase) {
    case 'stopping':
      return 'saving_local'
    case 'saving_upload':
    case 'saving_db':
    case 'verifying':
      return 'uploading'
    case 'transcribing':
      return 'processing_transcript'
    case 'summarizing':
      return 'processing_summary'
    default:
      break
  }

  // A save that failed keeps the screen, so the user sees the reason and the
  // retry rather than being returned to Record Home with a silent loss.
  if (recentCapture?.kind === 'failure') return 'upload_failed'

  // Recovery is only surfaced once nothing else is in flight; it is a decision
  // about a PREVIOUS session, and the existing logic still owns the actions.
  if (recoveryPending) return 'recovery_required'

  if (recentCapture?.kind === 'success' || recentCapture?.kind === 'list_refresh_warn') {
    // The audio is safe. What the screen shows next is the SERVER'S word on the
    // lecture, not the client's guess: processing, failed, or done.
    if (ai === 'failed') return 'ai_failed'
    if (ai === 'waiting' || ai === 'transcribing' || ai === 'summarizing') return 'ai_processing'
    // An AI failure after a successful save is not a lost recording: the row and
    // its audio are safe, so this reports partial readiness, never a failure.
    if (recentAi && recentAi.kind !== 'success') {
      return saved?.transcriptReady ? 'partial_ready' : 'ready'
    }
    if (!saved) return 'ready'
    if (saved.transcriptReady && saved.summaryReady) return 'ready'
    if (saved.transcriptReady) return 'partial_ready'
    return 'ready'
  }

  return 'none'
}

/** The i18n key naming each stage, so the component holds no English. */
export const RECORDING_STAGE_TITLE_KEY = {
  saving_local: 'recording.savingLocal',
  uploading: 'recording.uploading',
  processing_transcript: 'recording.processingTranscript',
  processing_summary: 'recording.processingSummary',
  partial_ready: 'recording.partialReady',
  ai_processing: 'processing.title',
  ai_failed: 'processing.failedTitle',
  ready: 'recording.ready',
  upload_failed: 'recording.uploadFailed',
  recovery_required: 'recording.recoveryRequired',
} as const

export const RECORDING_STAGE_BODY_KEY = {
  saving_local: 'recording.savingLocalBody',
  uploading: 'recording.uploadingBody',
  processing_transcript: 'recording.processingTranscriptBody',
  processing_summary: 'recording.processingSummaryBody',
  partial_ready: 'recording.partialReadyBody',
  ai_processing: 'processing.body',
  ai_failed: 'processing.failedBody',
  ready: 'recording.readyBody',
  upload_failed: 'recording.uploadFailedBody',
  recovery_required: 'recording.recoveryRequiredBody',
} as const
