/**
 * Explicit phases for record -> save -> optional **in-browser** AI (Whisper + summarize).
 * Live capture uses `recording` / `paused` from the recorder hook; other phases are driven by save / AI handlers.
 * Phase 2 (reserved): a future cloud worker would use DB `ai_*` columns separately; not wired here.
 */
export type RecordingFlowPhase =
  | 'idle'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'saving_upload'
  | 'saving_db'
  | 'verifying'
  | 'transcribing'
  | 'summarizing'
  | 'error'

/** User-visible outcome: avoids lumping different failures into "save failed". */
export type SaveUiOutcome =
  | 'ok'
  | 'storage_failed'
  | 'storage_ok_db_failed'
  | 'db_ok_verify_failed'
  | 'local_failed'
  /**
   * The cloud upload failed after retries, but the audio+metadata were
   * preserved as a durable local pending upload — not lost, not yet in any
   * Course. Must render as an actionable failure (Retry Save), never as a
   * success: the lecture is not durably in the cloud/Course yet.
   */
  | 'pending_upload'
  | 'other'

export type AiUiOutcome = 'ok' | 'transcribe_failed' | 'summarize_failed' | 'persist_failed' | 'other'

export type RecordingFlowState = {
  /** In-flight capture / AI steps only. Terminal save outcomes live in UI state (`recentCapture` / `recentAi`). */
  phase: RecordingFlowPhase
  /** Set during capture / AI work tied to one recording UUID */
  recordingId: string | null
}

export const initialRecordingFlow: RecordingFlowState = {
  phase: 'idle',
  recordingId: null,
}

export type RecordingFlowAction =
  | { type: 'LIVE_START' }
  | { type: 'LIVE_PAUSE' }
  | { type: 'LIVE_RESUME' }
  | { type: 'LIVE_DISCARD' }
  | { type: 'CAPTURE_BEGIN'; recordingId: string }
  | { type: 'CAPTURE_STOPPING' }
  | { type: 'CAPTURE_UPLOAD' }
  | { type: 'CAPTURE_DB' }
  | { type: 'CAPTURE_VERIFY' }
  /** Return control to idle after save attempt (success, warn, or failure). Outcome is stored separately in UI. */
  | { type: 'CAPTURE_FINISHED' }
  | { type: 'AI_START'; recordingId: string }
  | { type: 'AI_TRANSCRIBE' }
  | { type: 'AI_SUMMARIZE' }
  | { type: 'AI_DONE' }
  /** Terminal AI step; message lives in `recentAi` UI state. */
  | { type: 'AI_ERROR'; recordingSaved: boolean }
  | { type: 'RESET_TO_IDLE' }

export function recordingFlowReducer(
  state: RecordingFlowState,
  action: RecordingFlowAction,
): RecordingFlowState {
  switch (action.type) {
    case 'LIVE_START':
      return {
        ...state,
        phase: 'recording',
        recordingId: null,
      }
    case 'LIVE_PAUSE':
      return state.phase === 'recording' ? { ...state, phase: 'paused' } : state
    case 'LIVE_RESUME':
      return state.phase === 'paused' ? { ...state, phase: 'recording' } : state
    case 'LIVE_DISCARD':
      return { ...initialRecordingFlow }
    case 'CAPTURE_BEGIN':
      return {
        ...state,
        phase: 'stopping',
        recordingId: action.recordingId,
      }
    case 'CAPTURE_STOPPING':
      return { ...state, phase: 'stopping' }
    case 'CAPTURE_UPLOAD':
      return { ...state, phase: 'saving_upload' }
    case 'CAPTURE_DB':
      return { ...state, phase: 'saving_db' }
    case 'CAPTURE_VERIFY':
      return { ...state, phase: 'verifying' }
    case 'CAPTURE_FINISHED':
      return {
        ...state,
        phase: 'idle',
        recordingId: null,
      }
    case 'AI_START':
      return {
        ...state,
        phase: 'transcribing',
        recordingId: action.recordingId,
      }
    case 'AI_TRANSCRIBE':
      return { ...state, phase: 'transcribing' }
    case 'AI_SUMMARIZE':
      return { ...state, phase: 'summarizing' }
    case 'AI_DONE':
      return {
        ...state,
        phase: 'idle',
        recordingId: null,
      }
    case 'AI_ERROR':
      return {
        ...state,
        phase: action.recordingSaved ? 'idle' : 'error',
      }
    case 'RESET_TO_IDLE':
      return { ...initialRecordingFlow }
    default:
      return state
  }
}

/** Phase shown in the recorder card when not in an explicit capture/AI phase. */
export function livePhaseFromRecorder(
  flow: RecordingFlowState,
  recorderStatus: 'idle' | 'recording' | 'paused',
): RecordingFlowPhase {
  const busy =
    flow.phase === 'stopping' ||
    flow.phase === 'saving_upload' ||
    flow.phase === 'saving_db' ||
    flow.phase === 'verifying' ||
    flow.phase === 'transcribing' ||
    flow.phase === 'summarizing'

  if (busy) return flow.phase
  if (flow.phase === 'error') return 'error'
  if (recorderStatus === 'recording') return 'recording'
  if (recorderStatus === 'paused') return 'paused'
  return 'idle'
}

export function isCapturePipelinePhase(phase: RecordingFlowPhase): boolean {
  return (
    phase === 'stopping' ||
    phase === 'saving_upload' ||
    phase === 'saving_db' ||
    phase === 'verifying'
  )
}

export function capturePhaseLabel(phase: RecordingFlowPhase): string {
  switch (phase) {
    case 'stopping':
      return 'Stopping mic...'
    case 'saving_upload':
      return 'Uploading audio...'
    case 'saving_db':
      return 'Saving metadata...'
    case 'verifying':
      return 'Refreshing list...'
    default:
      return ''
  }
}

/** Short label for the Stop & save button while a capture step runs. */
export function stopSaveButtonLabel(phase: RecordingFlowPhase): string {
  switch (phase) {
    case 'stopping':
      return 'Stopping...'
    case 'saving_upload':
      return 'Uploading...'
    case 'saving_db':
      return 'Saving...'
    case 'verifying':
      return 'Verifying...'
    default:
      return 'Stop & save'
  }
}
