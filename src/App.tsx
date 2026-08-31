import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type CSSProperties,
  type MouseEvent,
  type MutableRefObject,
  type ReactNode,
} from 'react'
import { flushSync } from 'react-dom'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { useAuth } from './useAuth'
import { useRecorder, LIVE_WHISPER_SLICE_MS, MAIN_RECORDER_REQUEST_DATA_MS } from './hooks/useRecorder'
import {
  deleteRecordingLocal,
  deleteTrashRecordingLocalPermanently,
  getAllRecordingsLocalWithBlobs,
  getRecordingDetailLocal,
  getRecordingWithBlob,
  listRecordingsLocal,
  listTrashRecordingsLocal,
  moveRecordingsToTrashLocal,
  restoreRecordingFromTrashLocal,
  saveRecordingLocal,
  updateRecordingLocal,
  savePendingUpload,
  getPendingUploadWithBlob,
  listPendingUploads,
  updatePendingUpload,
  deletePendingUpload,
} from './lib/db'
import {
  beginFinalizeRecordingSession,
  assignRecordingSessionCourse,
  completeRecordingSessionPersist,
  deleteRecordingSession,
  getRecordingSession,
  keepRecordingSessionForLater,
  listRecoverableRecordingSessions,
} from './lib/recordingSessionStore'
import { ownerKeyForUser, type RecordingSessionMeta } from './lib/recordingSession'
import {
  visiblePendingUploads,
  sanitizeUploadErrorCategory,
  pendingStatusLabel,
  pendingStatusDetail,
  pendingUploadNeedsCourseChoice,
  type PendingUploadMeta,
} from './lib/pendingUploads'
import { buildLocalBackupZip, importLocalBackupZip } from './lib/localBackup'
import { getSupabase, isSupabaseConfigured } from './lib/supabase'
import { summarizeRecording, transcribeRecording, translateLiveCaption } from './lib/aiClient'
import { getAiApiBase } from './lib/ai/apiBase'
import { openExternalContact } from './lib/openExternalContact'
import { computeUploadRetryPlan, isTransientUploadError } from './lib/uploadRetry'
import {
  hostedRecordingAiStatusLabel,
  liveCaptionBlockedMessage,
  userFacingGenericProcessingFailure,
  userFacingHostedJobFailure,
  userFacingSummarizeFailure,
  userFacingTranscribeFailure,
} from './lib/aiUserFacing'
import {
  getAiSourceSnapshot,
  getByokApiKey,
  getByokProvider,
  subscribeAiSource,
  usesYoumiHosted,
} from './lib/ai/aiSource'
import { BYOK_PROVIDER_CAPABILITIES } from './lib/ai/providers/types'
import { showDeveloperAiCredentialsUi } from './lib/productAi'
import { INTERNAL_BETA_NOTE, PRODUCT_VERSION_LABEL } from './lib/productMeta'
import {
  hostedHealthFromApiJson,
  isHostedAiConfigured,
  isHostedLiveCaptionsPipelineReady,
  isStubAiEnabled,
  type HostedHealthSnapshot,
} from './lib/ai/runtimeMode'
import { requestHostedRecordingAi } from './lib/recordingsAiJob'
import {
  fetchProfile,
  markFirstShellSeen,
  profileNeedsUsernameOnboarding,
  upsertProfileUsername,
  type UserProfileRow,
} from './lib/userProfile'
import { AccountSettingsModal } from './components/AccountSettingsModal'
import { UpdaterEntry } from './components/UpdaterEntry'
import { AiPreferencesSection } from './components/AiPreferencesSection'
import { AccessUsageModal } from './components/AccessUsageModal'
import { BillingPlanModal } from './components/BillingPlanModal'
import { AuthScreens } from './components/AuthScreens'
import { authTrace } from './lib/authTrace'
import { RecordingAudioPlayer } from './components/RecordingAudioPlayer'
import { OnboardingUsername } from './components/OnboardingUsername'
import { SmoothCaption } from './components/SmoothCaption'
import { whisperLanguageHint } from './lib/whisperLang'
import { AsyncTimeoutError, withTimeout } from './lib/asyncTimeout'
import {
  capturePhaseLabel,
  initialRecordingFlow,
  isCapturePipelinePhase,
  recordingFlowReducer,
  stopSaveButtonLabel,
} from './lib/recordingFlow'
import {
  aiOutcomeToRecent,
  type RecentAiOutcome,
  type RecentCaptureOutcome,
} from './lib/recentOutcomes'
import {
  ledgerClear,
  ledgerMarkDbCommitted,
  ledgerMarkUploaded,
  releaseTabSaveLock,
  tryAcquireTabSaveLock,
} from './lib/saveIdempotency'
import { nextRecentCaptureForNewSave } from './lib/recentCapturePolicy'
import {
  CloudSoftDeleteUnavailableError,
  SaveRecordingRemoteError,
  deleteLectures,
  downloadRecordingBlob,
  getRecordingAudioUrl,
  getRecordingDetail,
  getRecordingMeta,
  insertLectureRecordingRow,
  listLectures,
  restoreRecordingRemote,
  softDeleteRecordingRemote,
  updateRecordingAi,
  updateRecordingMetadata,
  updateRecordingNotesMarks,
  uploadLectureAudioViaServer,
} from './lib/recordingsRepo'
import { transcribeHostedLiveCaptionChunk } from './lib/liveCaptionHostedTranscribe'
import { LiveEngine, type LiveEngineOpts } from './lib/liveEngine/engine'
import { isMeaningfulLectureTitle, reconcileLectureTitles } from './lib/lectureTitleIntegrity'
import { appendMark, parseMarks, reconcileLectureAnnotations } from './lib/lectureAnnotations'
import { isLectureActive } from './lib/lectureDeletionResolution'
import {
  AUDIO_SOURCE_LABEL_KEY,
  DEFAULT_AUDIO_SOURCE,
  readAudioSource,
  systemAudioSupported,
  writeAudioSource,
  type AudioSource,
} from './lib/audioSource'
import {
  markLatency,
  markSpeechOnset,
  reportLatencySummary,
  resetLatencyDiagnostics,
} from './lib/captionDiagnostics'
import {
  LiveCaptionSessionModel,
  liveCaptionEventFromEngine,
  type LiveCaptionView,
} from './lib/liveCaptionSessionModel'
import { LIVE_PCM_SAMPLE_RATE } from './lib/livePcmCapture'
import { getEnArrivalWalls, traceCaptionStop } from './lib/liveCaptionTrace'
import { canonicalizeLectureTranscript } from './lib/transcriptCanonical'
import { youmiLiveLog } from './lib/youmiLiveDebug'
import { getOverlayLiveText } from './lib/overlayCaption'
import type { Recording, RecordingDetail } from './types'
import type { CloudTrashedMeta } from './lib/cloudLectureTrash'
import { loadCloudTrashRegistry, saveCloudTrashRegistry } from './lib/cloudLectureTrash'
import {
  classifyTrashDeletionScope,
  getScopedRecordingIds,
  type LibraryActiveScope,
  type TrashDeletionScope,
} from './lib/lectureLibraryScope'
import { YoumiLensShell } from './components/YoumiLensShell'

/** Settings sections that Phase 1A has not migrated yet map to their own label. */
const SETTINGS_PLACEHOLDER_TITLE = {
  appearance: 'settings.appearance',
  capture: 'settings.capture',
  language: 'settings.language',
  liveCaptions: 'settings.liveCaptions',
  dataBackup: 'settings.dataBackup',
  autoUpdate: 'settings.autoUpdate',
  account: 'settings.account',
  planUsage: 'settings.planUsage',
  advancedAi: 'settings.advancedAi',
  support: 'settings.support',
} as const
import { CourseDetailPage } from './components/CourseDetailPage'
import { CoursesPage, type LectureStatus } from './components/CoursesPage'
import {
  ConfirmPurgeDialog,
  CreateCourseDialog,
  DeleteCourseDialog,
  DeleteLectureDialog,
  MoveLectureDialog,
  RenameCourseDialog,
  RenameLectureDialog,
} from './components/CourseDialogs'
import { DesktopV2Shell } from './components/DesktopV2Shell'
import { LectureDetailPage } from './components/LectureDetailPage'
import { RecentlyDeletedPage } from './components/RecentlyDeletedPage'
import { RecordingV2 } from './components/RecordingV2'
import {
  courseIdentity,
  findCourseForRecording,
  lectureIdentity,
  lecturesInCourse,
  reconcileCourseSelection,
} from './lib/courses/courseModel'
import {
  courseToRestoreWithLecture,
  deletedLecturesFromCloudRows,
  deletedLecturesFromLocalRows,
  deletedLecturesFromRegistry,
  recentlyDeletedCount,
} from './lib/courses/deletedItems'
import { useCourses } from './lib/courses/useCourses'
import { useCloudLibraryRefresh } from './hooks/useCloudLibraryRefresh'
import { useCloudLibraryRealtime } from './hooks/useCloudLibraryRealtime'
import { isTerminalRecordingStage, ownsRecordingScreen, resolveRecordingV2Stage } from './lib/recordingV2Stage'
import { RecordHome } from './components/RecordHome'
import { SettingsLanguagePage } from './components/SettingsLanguagePage'
import { SettingsLayout, SettingsPlaceholder, SettingsRow } from './components/SettingsLayout'
import { DEFAULT_SETTINGS_SECTION, type SettingsSection } from './lib/settingsSections'
import { useLanguagePreferences } from './languagePreferencesContext'
import { YoumiLensMonogramY } from './branding/YoumiLensMonogramY'
import { designTokens } from './design-system/tokens'
import './design-system/tokens.css'
import './App.css'
import './styles/desktop-v2.css'
import './styles/courses-v2.css'
import './styles/course-overlays.css'

// ── Overlay bridge ─────────────────────────────────────────────────────────────
// Emits caption and status events to the floating Lecture Overlay window via the
// Tauri global event bus. Guards against non-Tauri (browser dev) contexts.

function isTauriContext(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

// Overlay caption helper lives in src/lib/overlayCaption.ts (pure, unit-tested).
// Imported below alongside its draft-trim sibling.

function emitOverlayCaptions(payload: {
  primaryBlack: string
  primaryGray: string
  secondaryBlack: string
  secondaryGray: string
}): void {
  if (!isTauriContext()) return
  void import('@tauri-apps/api/event')
    .then(({ emit }) => emit('youmi:overlay-captions', payload))
    .catch(() => {})
}

function emitOverlayStatus(payload: {
  recorderStatus: 'idle' | 'recording' | 'paused'
  translateActive: boolean
  elapsedSec: number
}): void {
  if (!isTauriContext()) return
  void import('@tauri-apps/api/event')
    .then(({ emit }) => emit('youmi:overlay-status', payload))
    .catch(() => {})
}

// ──────────────────────────────────────────────────────────────────────────────

const UI_BUILD_MARKER = 'SAFE-DELETE-V1'

/**
 * Gmail compose URL for support requests. See lib/openExternalContact.ts for
 * why we use Gmail compose instead of `mailto:` on the Mac client.
 */
const SUPPORT_CONTACT_URL =
  'https://mail.google.com/mail/?view=cm&fs=1&to=youmilens@gmail.com' +
  '&su=Youmi%20Lens%20Support' +
  '&body=Hi%20Youmi%20Lens%20team%2C%0A%0AI%20need%20help%20with%20Youmi%20Lens.' +
  '%0A%0AIssue%3A%0A%5BPlease%20describe%20the%20issue.%5D' +
  '%0A%0ADevice%3A%0AMac%0A%0AThanks.'

type SidebarPlanUsage = {
  /** User-facing access label from the backend (e.g. 'Free Beta', 'Core Tester', 'Developer'). */
  displayName: string
  /** Raw plan_type from the API, e.g. 'public_trial', 'core_tester', 'admin'. Empty string for fallback. */
  planType: string
  /** True when the API indicates no quota cap (admin / developer). */
  unlimited: boolean
  /** Monthly billable minutes used this calendar month. null while loading. */
  minutesUsed: number | null
  minutesLimit: number | null
  minutesRemaining: number | null
  /** Daily billable minutes used today (UTC). null while loading. */
  dailyMinutesUsed: number | null
  dailyMinutesLimit: number | null
  dailyMinutesRemaining: number | null
  /** Recordings processed today (UTC). null while loading. */
  recordingsUsedToday: number | null
  maxRecordingsPerDay: number | null
  recordingsRemainingToday: number | null
  source: 'api' | 'fallback'
}

/**
 * `lecture` is a real view, not a flavour of `courses`.
 *
 * Opening a lecture from Courses V2 used to set `selectedId` and leave
 * `workspaceView` on `courses`, so the V2 course grid kept rendering and the
 * detail was never shown. Lecture Detail V2 is a later phase, so this view
 * routes to the EXISTING production detail (transcript, summary, player) rather
 * than to a second, parallel one.
 */
type WorkspaceView = 'record' | 'courses' | 'lecture' | 'settings'
type CourseView =
  | { type: 'all' }
  | { type: 'recentlyDeleted' }
  | { type: 'unfiled' }
  | { type: 'folder'; folderId: string }

/**
 * Shape returned by GET /api/quota/status (the camelCase endpoint used by
 * iPad and Mac). Mac is on the same endpoint so usage stays consistent across
 * both platforms — the backend is the single source of truth.
 */
type QuotaStatusPayload = {
  ok: boolean
  plan?: {
    planType: string
    displayName: string
    status?: 'active' | 'suspended'
    unlimited: boolean
    monthlyMinutesLimit?: number | null
    minutesUsed?: number | null
    minutesLimit?: number | null
    minutesRemaining?: number | null
    dailyMinutesUsed?: number | null
    dailyMinutesLimit?: number | null
    dailyMinutesRemaining?: number | null
    maxRecordingsPerDay?: number | null
    recordingsUsedToday?: number | null
    recordingsRemainingToday?: number | null
    maxRecordingMinutes?: number | null
    maxLiveSessionMinutes?: number | null
  }
}

const FALLBACK_PLAN_USAGE: SidebarPlanUsage = {
  displayName: '',
  planType: '',
  unlimited: false,
  minutesUsed: null,
  minutesLimit: null,
  minutesRemaining: null,
  dailyMinutesUsed: null,
  dailyMinutesLimit: null,
  dailyMinutesRemaining: null,
  recordingsUsedToday: null,
  maxRecordingsPerDay: null,
  recordingsRemainingToday: null,
  source: 'fallback',
}

// ── Lecture Overlay entry button ──────────────────────────────────────────────

/**
 * Open the production floating caption overlay.
 *
 * Extracted from `LectureOverlayButton` unchanged so Recording V2 and the
 * legacy button invoke the SAME two Tauri commands. The overlay window itself —
 * the compact deep-navy one — is not touched by this phase.
 */
function openLectureOverlay(): void {
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => {
      void invoke('show_overlay')
      void invoke('minimize_main_window')
    })
    .catch(() => {})
}

function LectureOverlayButton() {
  const [hovered, setHovered] = useState(false)
  const [active, setActive] = useState(false)

  const handleClick = openLectureOverlay

  return (
    <button
      type="button"
      title="Open floating caption overlay — stays above other windows while you study"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setActive(false) }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      onClick={handleClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 34,
        padding: '0 13px',
        borderRadius: 12,
        background: active
          ? 'rgba(6,27,52,0.12)'
          : hovered
            ? 'rgba(6,27,52,0.08)'
            : 'rgba(6,27,52,0.04)',
        border: '1px solid rgba(6,27,52,0.14)',
        color: '#061B34',
        fontSize: 14,
        fontWeight: 600,
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
        letterSpacing: '-0.01em',
        cursor: 'pointer',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        transition: 'background 0.12s',
        flexShrink: 0,
        lineHeight: 1,
      }}
    >
      {/* floating window icon */}
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" style={{ flexShrink: 0 }}>
        <rect x="1" y="4" width="13" height="10" rx="2" stroke="#061B34" strokeWidth="1.3" strokeOpacity="0.75" fill="none"/>
        <rect x="4" y="1" width="7" height="5" rx="1.5" fill="rgba(6,27,52,0.55)"/>
      </svg>
      Lecture Overlay
    </button>
  )
}

/**
 * Map the camelCase /api/quota/status payload into the sidebar's compact shape.
 * Backend-only — never hardcodes limit numbers. Missing fields surface as null
 * so the UI can render "—" rather than a fabricated cap.
 */
function planUsageFromApi(payload: QuotaStatusPayload): SidebarPlanUsage {
  const plan = payload.plan
  if (!plan) return FALLBACK_PLAN_USAGE
  const planType = plan.planType ?? ''
  const displayName = plan.displayName ?? ''
  if (plan.unlimited) {
    return {
      displayName,
      planType,
      unlimited: true,
      minutesUsed: null,
      minutesLimit: null,
      minutesRemaining: null,
      dailyMinutesUsed: null,
      dailyMinutesLimit: null,
      dailyMinutesRemaining: null,
      recordingsUsedToday: null,
      maxRecordingsPerDay: null,
      recordingsRemainingToday: null,
      source: 'api',
    }
  }
  const numOrNull = (v: number | null | undefined): number | null =>
    v == null || !Number.isFinite(v) ? null : Number(v)
  return {
    displayName,
    planType,
    unlimited: false,
    minutesUsed: numOrNull(plan.minutesUsed),
    minutesLimit: numOrNull(plan.minutesLimit),
    minutesRemaining: numOrNull(plan.minutesRemaining),
    dailyMinutesUsed: numOrNull(plan.dailyMinutesUsed),
    dailyMinutesLimit: numOrNull(plan.dailyMinutesLimit),
    dailyMinutesRemaining: numOrNull(plan.dailyMinutesRemaining),
    recordingsUsedToday: numOrNull(plan.recordingsUsedToday),
    maxRecordingsPerDay: numOrNull(plan.maxRecordingsPerDay),
    recordingsRemainingToday: numOrNull(plan.recordingsRemainingToday),
    source: 'api',
  }
}

/**
 * User-facing access label. Free Access / Core Tester / Developer are the
 * only surfaces in the Mac UI. Backend may still return `displayName:
 * 'Free Beta'` for public_trial users — we normalize that to 'Free Access'
 * here without changing backend logic.
 */
function getDisplayAccessLabel(usage: SidebarPlanUsage): string {
  const t = usage.planType.toLowerCase().trim()
  if (['admin', 'developer', 'dev', 'internal_developer'].includes(t)) {
    if (usage.displayName && !/beta/i.test(usage.displayName)) return usage.displayName
    return 'Developer'
  }
  if (['core_tester', 'tester'].includes(t)) return 'Core Tester'
  if (t === 'public_trial') return 'Free Access'
  if (usage.displayName && !/beta/i.test(usage.displayName)) return usage.displayName
  return 'Free Access'
}

function formatLoadingNumber(value: number | null): string {
  return value == null ? '—' : Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/**
 * Compact label/value row used inside Settings cards. Replaces the previous
 * uppercase-overload <dl>/<dt>/<dd> pattern with a calmer single-line layout
 * that mirrors macOS Settings rows: label on the left, value on the right.
 */
function SettingsUsageRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="settings-usage-row">
      <span className="settings-usage-row__label">{label}</span>
      <span className="settings-usage-row__value">{value}</span>
    </div>
  )
}

/**
 * Subtle horizontal usage meter. ~4px tall, soft rounded corners, deep-navy
 * fill on a neutral track. Returns null when limit data is missing so the
 * bar never fakes progress. Hidden by the caller when unlimited.
 */
function UsageBar({
  used,
  limit,
  height = 4,
  trackColor = 'rgba(6, 27, 52, 0.08)',
  fillColor = 'rgba(47, 101, 184, 0.78)',
}: {
  used: number | null | undefined
  limit: number | null | undefined
  height?: number
  trackColor?: string
  fillColor?: string
}) {
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return null
  const u = Number.isFinite(used as number) ? Math.max(0, Number(used)) : 0
  const pct = Math.max(0, Math.min(100, (u / limit) * 100))
  return (
    <div
      aria-hidden
      style={{
        height,
        borderRadius: 999,
        background: trackColor,
        overflow: 'hidden',
        width: '100%',
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: '100%',
          borderRadius: 'inherit',
          background: fillColor,
          transition: 'width 240ms ease',
        }}
      />
    </div>
  )
}

/**
 * Derive a 1–2 character initials string from a profile name (preferred) or
 * an email local part. Never returns an empty string — falls back to '·'.
 */
function deriveInitials(email: string | null | undefined, displayName?: string | null): string {
  const raw = (displayName || '').trim()
  if (raw) {
    const parts = raw.split(/\s+/).filter(Boolean)
    if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
    if (parts.length === 1) {
      const w = parts[0]!
      return (w.length >= 2 ? w.slice(0, 2) : w[0]!).toUpperCase()
    }
  }
  const local = (email || '').split('@')[0] || ''
  if (!local) return '·'
  const segments = local.split(/[._\-+]+/).filter(Boolean)
  if (segments.length >= 2) {
    return (segments[0]![0]! + segments[1]![0]!).toUpperCase()
  }
  return local.slice(0, 2).toUpperCase()
}

/**
 * Circular initials avatar. Deep navy background, white initials. Quiet
 * affordance — communicates "this is the signed-in account" without any
 * profile editing intent.
 */
function AccountAvatar({ initials, size = 36 }: { initials: string; size?: number }) {
  return (
    <div
      aria-hidden
      style={{
        flexShrink: 0,
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 999,
        background: '#061b34',
        border: '1px solid rgba(255, 255, 255, 0.4)',
        boxShadow: '0 6px 14px rgba(6, 27, 52, 0.18)',
        color: '#ffffff',
        fontSize: size <= 32 ? 12 : 13,
        fontWeight: 700,
        letterSpacing: '0.02em',
      }}
    >
      {initials}
    </div>
  )
}

/**
 * Soft pill used for Lecture Defaults values. Subtle background, small font,
 * deep navy text — visually distinct from labels without screaming.
 */
function SettingsChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="settings-chip">
      {children}
    </span>
  )
}

/**
 * Row variant where the value is one or more chips instead of plain text.
 */
function SettingsChipRow({ label, chips }: { label: string; chips: string[] }) {
  return (
    <div className="settings-chip-row">
      <span className="settings-chip-row__label">{label}</span>
      <span className="settings-chip-row__chips">
        {chips.map((c) => (
          <SettingsChip key={c}>{c}</SettingsChip>
        ))}
      </span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function trashConfirmPrimaryLine(scope: TrashDeletionScope, count: number): string {
  const n = count === 1 ? '' : 's'
  if (scope.kind === 'folder') {
    return `Delete ${count} lecture${n} from folder "${scope.folderName}"?`
  }
  if (scope.kind === 'unfiled') {
    return `Delete ${count} unfiled lecture${n}?`
  }
  return `Delete ${count} lecture${n} across the entire library?`
}

const KEY_LIVE_LANG = 'lc_live_lang'
const KEY_TRANSLATE = 'lc_translate_target'
const LC_USE_LOCAL_KEY = 'lc_use_local_without_cloud'

type LiveTranslateTarget = 'zh' | 'en' | 'off'
const SUPPORTED_LIVE_LANG = 'en-US'
const SUPPORTED_TRANSLATE_TARGET: LiveTranslateTarget = 'zh'

const SAVE_UPLOAD_TIMEOUT_MS = 180_000
const SAVE_DB_TIMEOUT_MS = 45_000
const SAVE_LIST_TIMEOUT_MS = 30_000
const SAVE_META_TIMEOUT_MS = 20_000
const AI_DOWNLOAD_TIMEOUT_MS = 120_000
const AI_TRANSCRIBE_TIMEOUT_MS = 420_000
const AI_SUMMARIZE_TIMEOUT_MS = 180_000
const AI_PERSIST_TIMEOUT_MS = 45_000
/** Stop polling after-class Youmi AI job status after this (server Paraformer max ~10m + margin). */
const HOSTED_AI_POLL_MAX_MS = 12 * 60 * 1000

async function getRecordingMetaWithRetry(
  supabase: NonNullable<ReturnType<typeof getSupabase>>,
  userId: string,
  id: string,
  attempts = 5,
  delayMs = 400,
): Promise<{ id: string; storage_path: string; title: string } | null> {
  for (let i = 0; i < attempts; i++) {
    const m = await getRecordingMeta(supabase, userId, id)
    if (m) return m
    if (i < attempts - 1) {
      await new Promise((r) => window.setTimeout(r, delayMs))
    }
  }
  return null
}

/** Current beta support: English lecture input, Chinese translation output. */
const LIVE_LANG_OPTIONS: { value: string; label: string }[] = [
  { value: SUPPORTED_LIVE_LANG, label: 'English' },
]

const LIVE_WHISPER_SLICE_SEC = LIVE_WHISPER_SLICE_MS / 1000

/** Live caption chunk failures: never flash a global red error if captions are already streaming. */
const LIVE_CHUNK_SOFT_STREAK = 4
const LIVE_CHUNK_FATAL_STREAK = 8
/**
 * Dev-only escape: set `VITE_USE_LIVE_ENGINE_V2=false` to exercise legacy MediaRecorder slice + HTTP chunk path.
 * **Production + Youmi hosted:** always uses PCM → WebSocket → streaming ASR (this flag ignored).
 */
const USE_LIVE_ENGINE_V2 = import.meta.env.VITE_USE_LIVE_ENGINE_V2 !== 'false'

/** Trial builds: hide route/engine labels in UI. Dev still shows unless trial or set false explicitly. */
const VITE_TRIAL_BUILD = import.meta.env.VITE_TRIAL_BUILD === 'true'
const VITE_DEBUG_LIVE = import.meta.env.VITE_DEBUG_LIVE === 'true'
/** Console + window.__YL_LIVE_ROUTE__ only when debugging; off for trial and production. */
const LIVE_ROUTE_DIAG_ENABLED =
  !VITE_TRIAL_BUILD && (import.meta.env.DEV || VITE_DEBUG_LIVE)
/** On-screen “Route: …” line for engineers (hidden in trial/public builds). */
const SHOW_LIVE_ROUTE_DEBUG_UI = LIVE_ROUTE_DIAG_ENABLED

function liveRouteDiagLog(...args: unknown[]) {
  if (!LIVE_ROUTE_DIAG_ENABLED) return
  console.info(...args)
}

const LIVE_CAPTIONS_USER_EXPECTATION_EN =
  'Live preview. Full transcript and bilingual summaries are generated after you stop and save.'

type LiveRouteState =
  | 'legacy'
  | 'v2_waiting_session'
  | 'v2_blocked_pipeline'
  | 'v2_starting'
  | 'v2_streaming'
  | 'v2_error'

function spokenLanguageLabel(value: string): string {
  return LIVE_LANG_OPTIONS.find((o) => o.value === value)?.label ?? value
}

function formatClock(totalSec: number): string {
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

type LibraryDropId = string | 'unfiled'

function toDragTranslate(transform: { x: number; y: number } | null | undefined): string | undefined {
  if (!transform) return undefined
  return `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)`
}

function DraggableLectureItem({
  recordingId,
  selected,
  dragging,
  pickMode,
  onRowClick,
  suppressItemClickRef,
  children,
}: {
  recordingId: string
  selected: boolean
  dragging: boolean
  pickMode: boolean
  onRowClick: (e: MouseEvent<HTMLButtonElement>) => void
  suppressItemClickRef: MutableRefObject<boolean>
  children: ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `lecture:${recordingId}`,
    data: { kind: 'lecture', recordingId },
  })

  return (
    <button
      ref={setNodeRef}
      type="button"
      {...listeners}
      {...attributes}
      className={`rec-item ${selected ? 'active' : ''}${dragging || isDragging ? ' is-dragging' : ''}`}
      style={{ transform: toDragTranslate(transform), touchAction: 'none' }}
      onClick={(e) => {
        if (suppressItemClickRef.current && !pickMode) return
        onRowClick(e)
      }}
    >
      {children}
    </button>
  )
}

function DroppableLibraryTarget({
  dropId,
  className,
  activeDropId,
  children,
}: {
  dropId: LibraryDropId
  className: string
  activeDropId: LibraryDropId | null
  children: ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `drop:${dropId}`,
    data: { kind: 'library-drop', dropId },
  })

  return (
    <div ref={setNodeRef} className={`${className} ${isOver || activeDropId === dropId ? 'is-drop-target' : ''}`}>
      {children}
    </div>
  )
}

// ── Courses search helpers ─────────────────────────────────────────────────────

type MatchField = 'title' | 'course' | 'date' | 'duration' | 'transcript' | 'summary'

interface MatchReason {
  field: MatchField
  snippet?: string
}

/** True if the query is 1–2 purely-alphabetic characters (no digits, no CJK, no punctuation). */
function isShortAlphabetic(q: string): boolean {
  return q.length <= 2 && /^[a-zA-Z]+$/.test(q)
}

/** True if the query contains CJK characters → use pure substring matching for Chinese. */
function hasCJK(q: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf\u{20000}-\u{2a6df}]/u.test(q)
}

/**
 * Tokenise text at word boundaries, then check for an exact case-insensitive token match.
 * Also handles dotted abbreviations like "A.I." → normalised to "AI".
 */
function matchesToken(text: string, token: string): boolean {
  const normalised = text.replace(/\./g, '').toLowerCase()
  const target = token.toLowerCase()
  // Word-boundary split: split on anything that isn't a letter/digit
  const words = normalised.split(/[^a-z0-9]+/).filter(Boolean)
  return words.includes(target)
}

/** Known short-query expansions: token → [extra phrases to search by substring]. */
const SHORT_QUERY_EXPANSIONS: Record<string, string[]> = {
  ai: ['artificial intelligence'],
  eq: ['emotional intelligence', 'emotional quotient'],
}

function fieldMatches(text: string, ql: string, isShortAlpha: boolean): boolean {
  if (!text) return false
  const tl = text.toLowerCase()
  if (!isShortAlpha) return tl.includes(ql)
  if (matchesToken(text, ql)) return true
  const extras = SHORT_QUERY_EXPANSIONS[ql]
  if (extras) return extras.some((phrase) => tl.includes(phrase))
  return false
}

function extractSnippet(text: string, ql: string, isShortAlpha: boolean): string | undefined {
  if (!text) return undefined
  const tl = text.toLowerCase()
  let idx = -1
  if (isShortAlpha) {
    // Find the position of the exact token
    const words = tl.split(/[^a-z0-9]+/)
    let pos = 0
    for (const w of words) {
      if (w === ql) { idx = pos; break }
      pos += w.length + 1
    }
    // Also check expansions
    if (idx === -1) {
      const extras = SHORT_QUERY_EXPANSIONS[ql]
      if (extras) {
        for (const phrase of extras) {
          const i = tl.indexOf(phrase)
          if (i !== -1) { idx = i; break }
        }
      }
    }
  } else {
    idx = tl.indexOf(ql)
  }
  if (idx === -1) return undefined
  const start = Math.max(0, idx - 20)
  const end = Math.min(text.length, idx + ql.length + 40)
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '')
}

function matchLectureSearch(
  r: Recording,
  query: string,
): { matched: boolean; reason?: MatchReason } {
  const q = query.trim()
  if (!q) return { matched: true }
  const ql = q.toLowerCase()
  const cjk = hasCJK(q)
  const shortAlpha = !cjk && isShortAlphabetic(q)

  // For CJK or longer queries: pure substring; for short alpha: token matching
  const check = (text: string | undefined) => fieldMatches(text ?? '', ql, shortAlpha)
  const snip = (text: string | undefined) => extractSnippet(text ?? '', ql, shortAlpha)

  if (check(r.title)) return { matched: true, reason: { field: 'title', snippet: snip(r.title) } }
  if (check(r.course)) return { matched: true, reason: { field: 'course', snippet: snip(r.course) } }
  const dateText = formatDate(r.createdAt)
  if (fieldMatches(dateText, ql, false)) return { matched: true, reason: { field: 'date', snippet: dateText } }
  const durText = formatClock(r.durationSec)
  if (fieldMatches(durText, ql, false)) return { matched: true, reason: { field: 'duration', snippet: durText } }
  if (check(r.transcript)) return { matched: true, reason: { field: 'transcript', snippet: snip(r.transcript) } }
  if (check(r.liveTranscript)) return { matched: true, reason: { field: 'transcript', snippet: snip(r.liveTranscript) } }
  if (check(r.summaryEn)) return { matched: true, reason: { field: 'summary', snippet: snip(r.summaryEn) } }
  if (check(r.summaryZh)) return { matched: true, reason: { field: 'summary', snippet: snip(r.summaryZh) } }
  return { matched: false }
}

// ── Draggable course recording card ───────────────────────────────────────────

function DraggableCourseRecordingCard({
  recording,
  selected,
  dragging,
  pickMode,
  picked,
  onRowClick,
}: {
  recording: Recording
  selected: boolean
  dragging: boolean
  pickMode: boolean
  picked: boolean
  onRowClick: (e: MouseEvent<HTMLButtonElement>) => void
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `course-lecture:${recording.id}`,
    data: { kind: 'lecture', recordingId: recording.id },
  })

  return (
    <button
      ref={setNodeRef}
      type="button"
      {...listeners}
      {...attributes}
      className={`courses-recording-card${selected ? ' is-selected' : ''}${dragging || isDragging ? ' is-dragging' : ''}`}
      style={{ transform: toDragTranslate(transform), touchAction: 'none' }}
      onClick={onRowClick}
    >
      {pickMode ? (
        <span className="courses-recording-check" aria-hidden>
          {picked ? '✓' : ''}
        </span>
      ) : null}
      <span className="courses-recording-main">
        <strong>{recording.title}</strong>
        <small>{formatDate(recording.createdAt)}</small>
      </span>
      <span className="courses-recording-meta">
        <span>{recording.course?.trim() || 'Uncategorized'}</span>
        <span>{formatClock(recording.durationSec)}</span>
      </span>
    </button>
  )
}

function readForceLocalPreference(): boolean {
  try {
    return localStorage.getItem(LC_USE_LOCAL_KEY) === '1'
  } catch {
    return false
  }
}

function CloudSetupSplash({
  onUseLocal,
  onBack,
}: {
  onUseLocal: () => void
  /** Developer-only: return to the product-facing gate. */
  onBack?: () => void
}) {
  return (
    <div className="app narrow">
      {onBack ? (
        <p style={{ margin: '0.75rem 0 0' }}>
          <button type="button" className="btn ghost small" onClick={onBack}>
            ← Back
          </button>
        </p>
      ) : null}
      <header className="hero">
        <p className="eyebrow">Youmi Lens</p>
        <h1>Save recordings with an account (recommended)</h1>
        <p className="lede">
          After you sign in, recordings and transcripts live in your Supabase project. Use the same account on
          any browser or machine. You only need to do the steps below once.
        </p>
      </header>
      <section className="panel">
        <h2>1. Create a Supabase project</h2>
        <p className="hint small">
          Open{' '}
          <a href="https://supabase.com/dashboard" target="_blank" rel="noreferrer">
            supabase.com/dashboard
          </a>{' '}
          and create a project. In <strong>Project Settings → API</strong>, copy the <code>Project URL</code> and{' '}
          <code>anon public</code> key.
        </p>
        <h2>2. Enable email sign-in (optional but recommended)</h2>
        <p className="hint small">
          In <strong>Authentication → Providers</strong>, turn on <strong>Email</strong> (magic link).
        </p>
        <h2>3. Configure this repo&apos;s <code>.env</code></h2>
        <pre
          className="scroll subtle"
          style={{
            padding: '0.75rem 1rem',
            borderRadius: 8,
            border: '1px solid var(--border)',
            overflow: 'auto',
            fontSize: '0.85rem',
          }}
        >
          {`VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbG...`}
        </pre>
        <p className="hint small">
          Save the file, then run <code>npm run dev</code> again so Vite picks up the variables.
        </p>
        <button type="button" className="btn primary wide" onClick={() => window.location.reload()}>
          I&apos;ve configured it — reload
        </button>
      </section>
      <section className="panel">
        <h2>Local-only (no sign-in)</h2>
        <p className="hint small">
          Data stays in this browser&apos;s IndexedDB only. You may lose it if you switch browsers or clear site
          data. Use ZIP backup on this page, or add Supabase later and reload.
        </p>
        <button type="button" className="btn secondary wide" onClick={onUseLocal}>
          Continue in local mode
        </button>
      </section>
    </div>
  )
}

/** When cloud env vars are missing: product-facing path only (no self-hosted setup as default). */
function UnconfiguredCloudGate({
  onUseLocal,
  onOpenDeveloperSetup,
}: {
  onUseLocal: () => void
  onOpenDeveloperSetup?: () => void
}) {
  const t = designTokens
  const px = (n: number) => `${n}px`
  return (
    <div
      className="ds-root login-screen"
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: px(t.spacing[8]),
        boxSizing: 'border-box',
      }}
    >
      <header
        style={{
          marginBottom: px(t.spacing[8]),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: px(t.spacing[4]),
        }}
      >
        <YoumiLensMonogramY size={32} color={t.colors.primary} aria-hidden />
        <span
          style={{
            fontSize: t.fontSize.xl,
            fontWeight: 600,
            letterSpacing: '-0.035em',
            color: t.colors.primary,
          }}
        >
          Youmi Lens
        </span>
      </header>

      <div style={{ width: '100%', maxWidth: 400, position: 'relative', zIndex: 1 }}>
        <div
          className="ds-card login-screen__card"
          style={{
            padding: `${px(t.spacing[6])} ${px(t.spacing[8])}`,
            border: `1px solid ${t.colors.border}`,
            background: t.colors.surface,
          }}
        >
          <h1
            style={{
              margin: `0 0 ${px(t.spacing[3])}`,
              fontSize: t.fontSize.md,
              fontWeight: 600,
              color: t.colors.text,
              letterSpacing: '-0.02em',
            }}
          >
            Sign in to Youmi Lens
          </h1>
          <p
            style={{
              margin: `0 0 ${px(t.spacing[4])}`,
              fontSize: t.fontSize.sm,
              color: t.colors.textMuted,
              lineHeight: t.lineHeight.relaxed,
            }}
          >
            This copy of the app isn&apos;t connected to Youmi Lens cloud, so email sign-in can&apos;t start
            here. Use an official release from your team, or continue on this device only.
          </p>
          <p
            style={{
              margin: `0 0 ${px(t.spacing[4])}`,
              fontSize: t.fontSize.sm,
              color: t.colors.textMuted,
              lineHeight: t.lineHeight.relaxed,
            }}
          >
            Offline mode keeps recordings and transcripts in this browser only. Export ZIP backups from the
            library when you use it.
          </p>
          <button type="button" className="ds-btn ds-btn--primary" style={{ width: '100%' }} onClick={onUseLocal}>
            Continue without an account
          </button>
        </div>
        {onOpenDeveloperSetup ? (
          <p
            style={{
              marginTop: px(t.spacing[4]),
              textAlign: 'center',
              fontSize: t.fontSize.sm,
              color: t.colors.textMuted,
            }}
          >
            <button type="button" className="btn ghost small" onClick={onOpenDeveloperSetup}>
              Developer: local Supabase setup
            </button>
          </p>
        ) : null}
      </div>
    </div>
  )
}

export default function App() {
  const auth = useAuth()
  const supabase = getSupabase()
  const cloudReady = isSupabaseConfigured()
  const [forceLocalWithoutCloud, setForceLocalWithoutCloud] = useState(readForceLocalPreference)
  const [devCloudSetupVisible, setDevCloudSetupVisible] = useState(false)

  const authUiGateLogged = useRef<string>('')
  useEffect(() => {
    let gate: string
    let detail: Record<string, unknown>
    if (!cloudReady) {
      gate = 'unconfigured-cloud-or-local'
      detail = { screen: gate, cloudReady: false }
    } else if (auth.loading) {
      gate = 'loading-session'
      detail = { screen: gate, loading: true }
    } else if (!auth.session || !auth.user || !supabase) {
      gate = 'login'
      detail = {
        screen: gate,
        hasSession: Boolean(auth.session),
        hasUser: Boolean(auth.user),
        hasSupabaseClient: Boolean(supabase),
      }
    } else if (auth.inPasswordRecovery) {
      gate = 'password-recovery'
      detail = { screen: gate }
    } else {
      gate = 'recording-workspace'
      detail = { screen: gate, userIdPrefix: auth.user.id.slice(0, 8) }
    }
    if (authUiGateLogged.current !== gate) {
      authUiGateLogged.current = gate
      console.info('[lc-auth ui] render gate', detail)
      // Answers "why is it still showing the login screen?" directly: the gate name
      // plus the exact inputs that chose it.
      authTrace('gate.render', detail)
    }
  }, [cloudReady, auth.loading, auth.session, auth.user, supabase, auth.inPasswordRecovery])

  if (!cloudReady) {
    if (!forceLocalWithoutCloud) {
      if (import.meta.env.DEV && devCloudSetupVisible) {
        return (
          <CloudSetupSplash
            onBack={() => setDevCloudSetupVisible(false)}
            onUseLocal={() => {
              try {
                localStorage.setItem(LC_USE_LOCAL_KEY, '1')
              } catch {
                /* ignore */
              }
              setDevCloudSetupVisible(false)
              setForceLocalWithoutCloud(true)
            }}
          />
        )
      }
      return (
        <UnconfiguredCloudGate
          onUseLocal={() => {
            try {
              localStorage.setItem(LC_USE_LOCAL_KEY, '1')
            } catch {
              /* ignore */
            }
            setForceLocalWithoutCloud(true)
          }}
          onOpenDeveloperSetup={
            import.meta.env.DEV ? () => setDevCloudSetupVisible(true) : undefined
          }
        />
      )
    }
    return (
      <RecordingWorkspace
        localOnly
        userLabel="Local mode: recordings stay in this browser (IndexedDB)"
        onReloadAfterCloudEnv
      />
    )
  }

  if (auth.loading) {
    return (
      <div className="app narrow">
        <p className="muted">Loading session…</p>
      </div>
    )
  }

  if (!auth.session || !auth.user || !supabase) {
    return <AuthScreens />
  }

  // Recovery session: keep rendering the auth flow until the user finishes setting a new
  // password. The recovery session is a real Supabase session, but mounting AuthenticatedApp
  // here would let the user into the workspace without a fresh sign-in.
  if (auth.inPasswordRecovery) {
    return <AuthScreens />
  }

  return (
    <AuthenticatedApp
      key={auth.user.id}
      supabase={supabase}
      userId={auth.user.id}
      userEmail={auth.user.email ?? null}
      userLabel={auth.user.email ?? auth.user.user_metadata?.full_name ?? 'Account'}
      // Returns the promise so the Sign out button can actually await it — `void`
      // here made the busy state finish instantly and dropped any failure.
      onSignOut={() => auth.signOut()}
    />
  )
}

function AuthenticatedApp({
  supabase,
  userId,
  userEmail,
  userLabel,
  onSignOut,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabase>>
  userId: string
  userEmail: string | null
  userLabel: string
  /** May return a promise; the Sign out button awaits it for its busy state. */
  onSignOut: () => void | Promise<unknown>
}) {
  const [profile, setProfile] = useState<UserProfileRow | null>(null)
  const [profileLoading, setProfileLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void fetchProfile(supabase, userId).then((row) => {
      if (!cancelled) {
        setProfile(row)
        setProfileLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [supabase, userId])

  const welcomeLine = useMemo(() => {
    if (!profile || profileNeedsUsernameOnboarding(profile)) return undefined
    const name = profile.username!.trim()
    return profile.first_shell_seen_at ? `Welcome back, ${name}` : `Welcome, ${name}`
  }, [profile])

  useEffect(() => {
    if (!profile || profileNeedsUsernameOnboarding(profile)) return
    if (profile.first_shell_seen_at) return
    void markFirstShellSeen(supabase, userId).then(() => {
      void fetchProfile(supabase, userId).then(setProfile)
    })
  }, [profile, supabase, userId])

  if (profileLoading) {
    return (
      <div className="app narrow">
        <p className="muted">Loading profile…</p>
      </div>
    )
  }

  if (profileNeedsUsernameOnboarding(profile)) {
    return (
      <OnboardingUsername
        key={userId}
        userId={userId}
        supabase={supabase}
        initialUsername={profile?.username ?? null}
        onSubmit={async (username, phone) => {
          const { error } = await upsertProfileUsername(supabase, userId, { username, phone })
          if (!error) {
            const row = await fetchProfile(supabase, userId)
            setProfile(row)
          }
          return { error }
        }}
      />
    )
  }

  return (
    <RecordingWorkspace
      supabase={supabase}
      userId={userId}
      userLabel={userLabel}
      userEmail={userEmail}
      profileRow={profile}
      onProfileRowChange={setProfile}
      onSignOut={onSignOut}
      welcomeLine={
        welcomeLine ??
        (profile?.username?.trim() ? `Welcome, ${profile.username.trim()}` : 'Welcome')
      }
    />
  )
}

function recentCaptureHeadline(c: RecentCaptureOutcome): string {
  if (!c) return ''
  if (c.kind === 'success') return 'Saved'
  if (c.kind === 'list_refresh_warn') return 'Saved (list refresh issue)'
  if (c.kind === 'failure') {
    if (c.outcome === 'storage_failed') return 'Upload failed'
    if (c.outcome === 'storage_ok_db_failed') return 'Uploaded; database write failed'
    if (c.outcome === 'db_ok_verify_failed') return 'Saved; verification read failed'
    if (c.outcome === 'local_failed') return 'Local save failed'
    if (c.outcome === 'pending_upload') return 'Not saved to the cloud yet'
    return 'Save incomplete'
  }
  return ''
}

function recentAiHeadline(c: RecentAiOutcome): string {
  if (!c) return ''
  if (c.kind === 'success') return 'Transcription and summaries ready'
  if (c.kind === 'transcribe_failed') return 'Recording saved; transcription failed'
  if (c.kind === 'summarize_failed') return 'Recording saved; summarization failed (transcript kept)'
  if (c.kind === 'persist_failed') return 'Recording saved; failed to save transcript/summaries'
  return 'Processing incomplete'
}

/** Collapsible transcript/summary body; remount with key to reset open state per recording. */
function CollapsibleResultBlock({
  title,
  status,
  children,
}: {
  title: string
  status?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className={`result-collapsible ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="result-collapsible__header"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="result-collapsible__header-main">
          <span className="result-collapsible__chevron" aria-hidden>
            ▸
          </span>
          <span className="result-collapsible__title">{title}</span>
        </span>
        {status ? <span className="result-collapsible__status">{status}</span> : null}
      </button>
      {open ? <div className="result-collapsible__body">{children}</div> : null}
    </div>
  )
}

function RecordingWorkspace({
  localOnly = false,
  supabase,
  userId,
  userLabel,
  userEmail = null,
  profileRow = null,
  onProfileRowChange,
  onSignOut,
  onReloadAfterCloudEnv,
  welcomeLine,
}: {
  localOnly?: boolean
  supabase?: NonNullable<ReturnType<typeof getSupabase>>
  userId?: string
  userLabel: string
  /** Cloud: signed-in email for account panel (readonly). */
  userEmail?: string | null
  /** Cloud: current profile row for account panel. */
  profileRow?: UserProfileRow | null
  onProfileRowChange?: (row: UserProfileRow | null) => void
  /** May return a promise; the Sign out button awaits it for its busy state. */
  onSignOut?: () => void | Promise<unknown>
  /** After user adds Supabase to .env, reload to switch to login + cloud. */
  onReloadAfterCloudEnv?: boolean
  /** Top bar welcome; cloud mode only */
  welcomeLine?: string
}) {
  const devCredentialsUi = showDeveloperAiCredentialsUi()
  const aiStoreTick = useSyncExternalStore(
    subscribeAiSource,
    getAiSourceSnapshot,
    getAiSourceSnapshot,
  )
  void aiStoreTick
  const usesHosted = usesYoumiHosted()
  const byokKey = getByokApiKey().trim()
  const byokReady = !usesHosted && byokKey.length > 0
  const byokProvider = getByokProvider()
  const byokTranscribeOk = BYOK_PROVIDER_CAPABILITIES[byokProvider].transcribe
  const [hostedHealth, setHostedHealth] = useState<HostedHealthSnapshot | null>(null)
  const [hostedHealthUnreachable, setHostedHealthUnreachable] = useState(false)
  const [sidebarPlanUsage, setSidebarPlanUsage] = useState<SidebarPlanUsage>(FALLBACK_PLAN_USAGE)
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('record')
  /** Which Settings detail is open. Starts on the Settings page itself. */
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(DEFAULT_SETTINGS_SECTION)
  const { preferences: languagePreferences, setPreference: setLanguagePreference, t: tDesktop } = useLanguagePreferences()
  const hostedConfigured = isHostedAiConfigured(hostedHealth)
  const stubMode = isStubAiEnabled(hostedHealth)
  /** Cloud Youmi: health not fetched yet — treat pipeline as available until /health proves otherwise (avoids dead UI on login). */
  const optimisticCloudYoumiHealthLoading = !localOnly && usesHosted && hostedHealth === null
  /** Lecture processing + summaries (separate from live chunk pipeline). */
  const postClassAiEnabled = usesHosted
    ? optimisticCloudYoumiHealthLoading || hostedConfigured || stubMode
    : byokReady
  /** Live captions only: hosted stub/liveCaptions capability, or BYOK with speech-to-text. */
  const liveCaptionsPipelineEnabled = usesHosted
    ? optimisticCloudYoumiHealthLoading
      ? true
      : isHostedLiveCaptionsPipelineReady(hostedHealth)
    : byokReady && byokTranscribeOk
  const hostedUnavailableMessage =
    hostedHealthUnreachable
      ? 'Local AI server is not running. Start it with `npm run dev` (or `npm run dev:server`) and reload.'
      : !localOnly && usesHosted && hostedHealth !== null && !hostedConfigured && !stubMode
      ? 'Youmi AI is not available on this device yet.'
      : null

  const refreshHostedHealth = useCallback(async () => {
    if (localOnly) return
    try {
      const r = await fetch(`${getAiApiBase()}/health`)
      const j = (await r.json()) as unknown
      setHostedHealth(hostedHealthFromApiJson(j))
      setHostedHealthUnreachable(false)
    } catch {
      setHostedHealth(null)
      setHostedHealthUnreachable(!localOnly && usesHosted)
    }
  }, [localOnly, usesHosted])

  /** Mount + whenever AI source snapshot changes: re-fetch /health so Youmi/BYOK switches see fresh capability. */
  useEffect(() => {
    if (localOnly) return
    let cancelled = false
    void (async () => {
      try {
        const r = await fetch(`${getAiApiBase()}/health`)
        const j = (await r.json()) as unknown
        if (!cancelled) {
          setHostedHealth(hostedHealthFromApiJson(j))
          setHostedHealthUnreachable(false)
        }
      } catch {
        if (!cancelled) {
          setHostedHealth(null)
          setHostedHealthUnreachable(!localOnly && usesHosted)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [localOnly, aiStoreTick])

  useEffect(() => {
    if (localOnly || !supabase) {
      setSidebarPlanUsage(FALLBACK_PLAN_USAGE)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const { data } = await supabase.auth.getSession()
        const token = data.session?.access_token
        if (!token) throw new Error('missing_session')
        const res = await fetch(`${getAiApiBase()}/quota/status`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error(`usage_${res.status}`)
        const payload = (await res.json()) as QuotaStatusPayload
        if (!cancelled) setSidebarPlanUsage(planUsageFromApi(payload))
      } catch {
        if (!cancelled) setSidebarPlanUsage(FALLBACK_PLAN_USAGE)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [localOnly, supabase])

  const onLiveAudioChunkRef = useRef<((blob: Blob, mime: string) => void) | null>(null)
  const onLivePcmChunkRef = useRef<((buffer: ArrayBuffer, sampleRate: number) => void) | null>(null)
  /** Set by the LiveEngine effect; re-warms upstream at the real capture rate. */
  const onCaptureSampleRateRef = useRef<((sampleRate: number) => void) | null>(null)
  /* ── Audio source ─────────────────────────────────────────────────────────
     `microphone` (default) or `system`. The ref is what the recorder reads at
     Start, so the value is frozen for the session even if Settings changes. */
  const [audioSource, setAudioSourceState] = useState<AudioSource>(() =>
    typeof localStorage === 'undefined' ? DEFAULT_AUDIO_SOURCE : readAudioSource(localStorage),
  )
  const audioSourceRef = useRef(audioSource)
  const setAudioSource = useCallback((next: AudioSource) => {
    audioSourceRef.current = next
    setAudioSourceState(next)
    if (typeof localStorage !== 'undefined') writeAudioSource(localStorage, next)
  }, [])
  /** Cloud live captions: one Storage prefix per recording session (before recording row exists). */
  const liveCaptionSessionIdRef = useRef<string | null>(null)
  const liveChunkIndexRef = useRef(0)
    /** Youmi hosted live captions: batch a few ~3s slices, tuned for lower latency with stable output. */
  const youmiLiveBatchPartsRef = useRef<Blob[]>([])
  const youmiLiveBatchBytesRef = useRef(0)
  const youmiLiveBatchMimeRef = useRef<string>('')
  const youmiLiveBatchStartedAtRef = useRef<number | null>(null)
  const youmiLiveBatchFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Warm-up: first one/two batches flush earlier to reduce first-caption latency. */
  const youmiLiveWarmupBatchesSentRef = useRef(0)
  /** Avoid stale closure: timer uses the latest queue fn. */
  const youmiLiveQueueTranscribeRef = useRef<
    ((blob: Blob, mime: string, reason: string) => void) | null
  >(null)
  const liveTranscribeQueueRef = useRef<Array<{ seq: number; blob: Blob; mime: string; reason: string }>>([])
  const liveTranscribeInFlightRef = useRef(0)
  const liveTranscribeSeqIssuedRef = useRef(0)
  const liveTranscribeSeqCommitRef = useRef(0)
  const liveTranscribePiecesRef = useRef(new Map<number, string>())
  const resetLiveTranscribeRuntime = useCallback(() => {
    liveTranscribeQueueRef.current = []
    liveTranscribeInFlightRef.current = 0
    liveTranscribeSeqIssuedRef.current = 0
    liveTranscribeSeqCommitRef.current = 0
    liveTranscribePiecesRef.current.clear()
  }, [])
  /** When hosted post-class job is queued/transcribing/summarizing — for max poll duration. */
  const hostedAiPollStartedAtRef = useRef<number | null>(null)
  /** Local A/B: set `VITE_EXPERIMENT_SKIP_YOUMI_LIVE_SLICE=true` to disable only the live slice loop in Youmi AI mode (main track unchanged). */
  const experimentSkipYoumiLiveSlice =
    import.meta.env.VITE_EXPERIMENT_SKIP_YOUMI_LIVE_SLICE === 'true'
  /** Default realtime for Youmi hosted: PCM → `/api/live-realtime-ws` → DashScope streaming ASR. Prod always on. */
  const useLiveEngineV2ForHosted = usesHosted && (import.meta.env.PROD || USE_LIVE_ENGINE_V2)
  const getRecordingOwnerKey = useCallback(
    () => ownerKeyForUser(userId, Boolean(localOnly)),
    [userId, localOnly],
  )
  const recorder = useRecorder({
    onLiveAudioChunkRef,
    onPcmChunkRef: onLivePcmChunkRef,
    onCaptureSampleRate: (sampleRate) => onCaptureSampleRateRef.current?.(sampleRate),
    // Read once at Start: the session's source is frozen for its lifetime.
    getAudioSource: () => audioSourceRef.current,
    // Skip the MediaRecorder blob-slice cycle when PCM streaming drives the live engine (v2 path).
    experimentalSkipLiveSlice: useLiveEngineV2ForHosted || (experimentSkipYoumiLiveSlice && usesHosted),
    getOwnerKey: getRecordingOwnerKey,
    getSessionContext: () => ({ course: course.trim(), courseId: recordingCourseId, title: title.trim() }),
  })

  const [flow, dispatchFlow] = useReducer(recordingFlowReducer, initialRecordingFlow)
  const [recentCapture, setRecentCapture] = useState<RecentCaptureOutcome>(null)
  const [recentAi, setRecentAi] = useState<RecentAiOutcome>(null)
  /** Unfinished durable sessions recovered on startup (owner-isolated). */
  const [recoveredSessions, setRecoveredSessions] = useState<RecordingSessionMeta[]>([])
  const [selectedRecoverySessionId, setSelectedRecoverySessionId] = useState<string | null>(null)
  const [recoveryBusyId, setRecoveryBusyId] = useState<string | null>(null)
  const [recoveryDeleteConfirmId, setRecoveryDeleteConfirmId] = useState<string | null>(null)

  /** In-flight capture only; terminal outcomes use `recentCapture` / `recentAi`. */
  const saveOrFinishBusy = isCapturePipelinePhase(flow.phase) || flow.phase === 'stopping'

  /** After Stop, keep LiveEngine mounted briefly so ASR can flush trailing finals into the session. */
  const [liveEngineDrainPhase, setLiveEngineDrainPhase] = useState(false)
  const liveCaptionSessionActive =
    recorder.status === 'recording' || recorder.status === 'paused' || liveEngineDrainPhase
  const useLiveEngineV2 = useLiveEngineV2ForHosted
  const [liveRouteState, setLiveRouteState] = useState<LiveRouteState>('legacy')

  /** Hosted live captions API gate — avoid useless warm attempts while health is still loading. */
  const hostedLiveCaptionsGate =
    stubMode || (hostedHealth !== null && hostedHealth.liveCaptions === true)

  /**
   * Keep LiveEngine mounted on the capture surface **before** Record so DashScope can pre-handshake.
   * Include `stopping` so one React frame never tears down the engine between CAPTURE_BEGIN and drain latch.
   */
  const liveEngineMountActive = useMemo(
    () =>
      Boolean(
        useLiveEngineV2 &&
          usesHosted &&
          liveCaptionsPipelineEnabled &&
          (hostedConfigured || stubMode || optimisticCloudYoumiHealthLoading) &&
          (hostedLiveCaptionsGate || optimisticCloudYoumiHealthLoading) &&
          (flow.phase === 'idle' ||
            flow.phase === 'recording' ||
            flow.phase === 'paused' ||
            flow.phase === 'stopping' ||
            liveEngineDrainPhase) &&
          flow.phase !== 'transcribing' &&
          flow.phase !== 'summarizing',
      ),
    [
      useLiveEngineV2,
      usesHosted,
      liveCaptionsPipelineEnabled,
      hostedConfigured,
      stubMode,
      hostedHealth,
      hostedLiveCaptionsGate,
      flow.phase,
      liveEngineDrainPhase,
    ],
  )

  const liveCaptionSessionSurface = useMemo(() => {
    if (!liveCaptionSessionActive) return null
    if (liveCaptionsPipelineEnabled) return null
    if (usesHosted && hostedHealth === null) return null

    if (usesHosted) {
      if (!hostedConfigured && !stubMode) {
        return { tier: 'fatal' as const, text: 'Youmi AI setup is not available yet.' }
      }
      if ((hostedConfigured || stubMode) && !stubMode && hostedHealth?.liveCaptions !== true) {
        return {
          tier: 'info' as const,
          text: 'Live captions are not available for Youmi AI in this environment yet. Recording continues — use Generate transcript & summaries after class for the full transcript.',
        }
      }
    } else {
      if (!byokReady) {
        return {
          tier: 'fatal' as const,
          text: liveCaptionBlockedMessage(false, devCredentialsUi, false),
        }
      }
      if (!byokTranscribeOk) {
        return {
          tier: 'info' as const,
          text: 'Your advanced connection type does not support speech-to-text for live captions. Change the connection type in Account or switch to Youmi AI.',
        }
      }
    }
    return null
  }, [
    liveCaptionSessionActive,
    liveCaptionsPipelineEnabled,
    usesHosted,
    hostedHealth,
    hostedConfigured,
    stubMode,
    byokReady,
    byokTranscribeOk,
    devCredentialsUi,
  ])

  const liveLang = SUPPORTED_LIVE_LANG
  const translateTarget = SUPPORTED_TRANSLATE_TARGET

  useEffect(() => {
    localStorage.setItem(KEY_LIVE_LANG, SUPPORTED_LIVE_LANG)
    localStorage.setItem(KEY_TRANSLATE, SUPPORTED_TRANSLATE_TARGET)
  }, [])

  const [secondaryCaption, setSecondaryCaption] = useState('')
  const [secondaryCaptionDraft, setSecondaryCaptionDraft] = useState('')
  const onFinalPhraseRef = useRef<((phrase: string) => void) | null>(null)
  const onDraftPhraseRef = useRef<((phrase: string) => void) | null>(null)
  const liveEngineRef = useRef<LiveEngine | null>(null)
  const warmSampleRateRef = useRef(LIVE_PCM_SAMPLE_RATE)
  /** LiveEngine v2: single session model (EN/ZH each = committed[] + current|null). */
  const liveCaptionSessionRef = useRef(new LiveCaptionSessionModel())
  /** Joined committed EN text mirror (save / diagnostics). */
  const v2CommittedEnRef = useRef('')

  // Retained for future use (paragraph block separation, currently disabled).
  const lastFinalTimestampRef = useRef(0)

  const [primaryCaption, setPrimaryCaption] = useState('')
  const [primaryCaptionDraft, setPrimaryCaptionDraft] = useState('')
  const primaryCaptionRef = useRef('')
  /** Full zh transcript for live v2 (state is windowed to 150 words). */
  const secondaryCaptionFullRef = useRef('')

  // Overlay caption emission: see src/lib/overlayCaption.ts. The overlay
  // shows ONLY the in-progress phrase the speaker is producing right
  // now (committed-tail since the last sentence boundary + draft). When
  // `committed` ends on a sentence boundary AND `draft` is non-empty,
  // the helper drops the old completed sentence entirely and only
  // emits the draft, so the overlay never shows a stale "Hello world."
  // prefixed to a new in-progress phrase.
  //
  // We deliberately emit a SINGLE combined string per language as
  // `primaryBlack` / `secondaryBlack` and leave `primaryGray` /
  // `secondaryGray` empty: rendering committed (white) + draft (gray
  // italic) as two adjacent inline spans introduced a visible style
  // seam mid-line, and made students perceive the row as having two
  // "zones" rather than one growing left-to-right caption. With one
  // span, the OverlayWindow renders normal LTR text that grows
  // naturally to the right as the speaker produces words.
  //
  // Budgets (55 EN / 28 ZH) are tuned to fit the 600px-wide overlay
  // on one left-aligned line at fontSize 17. Main-app transcript
  // still receives the full accumulated text via primaryCaption /
  // secondaryCaption refs (unchanged).
  const syncLiveCaptionViewFromModel = useCallback((v: LiveCaptionView) => {
    primaryCaptionRef.current = v.persistPrimaryFull
    secondaryCaptionFullRef.current = v.persistSecondaryFull
    v2CommittedEnRef.current = v.committedEnJoin
    setPrimaryCaption(v.primaryBlack)
    setPrimaryCaptionDraft(v.primaryGray)
    setSecondaryCaption(v.secondaryBlack)
    setSecondaryCaptionDraft(v.secondaryGray)
    const enText = getOverlayLiveText({
      committed: v.primaryBlack,
      draft: v.primaryGray,
      maxChars: 55,
    })
    const zhText = getOverlayLiveText({
      committed: v.secondaryBlack,
      draft: v.secondaryGray,
      maxChars: 28,
    })
    emitOverlayCaptions({
      primaryBlack: enText,
      primaryGray: '',
      secondaryBlack: zhText,
      secondaryGray: '',
    })
  }, [])

  const resetLiveCaptionSessionUi = useCallback(() => {
    liveCaptionSessionRef.current.reset()
    // syncLiveCaptionViewFromModel emits empty caption text to the overlay,
    // clearing any leftover sentence from the previous recording session.
    syncLiveCaptionViewFromModel(liveCaptionSessionRef.current.getView())
  }, [syncLiveCaptionViewFromModel])

  // Broadcast recorder status + elapsed time + translation mode to overlay window.
  // Runs every second during recording (elapsedSec increments) to keep the overlay timer live.
  useEffect(() => {
    emitOverlayStatus({
      recorderStatus: recorder.status as 'idle' | 'recording' | 'paused',
      translateActive: SUPPORTED_TRANSLATE_TARGET !== 'off',
      elapsedSec: recorder.elapsedSec,
    })
  }, [recorder.status, recorder.elapsedSec])

  /** Session-level banners are derived in `liveCaptionSessionSurface`; this is only for per-chunk issues. */
  const [liveCaptionChunkNotice, setLiveCaptionChunkNotice] = useState<{
    kind: 'soft' | 'fatal'
    message: string
  } | null>(null)
  const liveChunkFailStreakRef = useRef(0)
  const [liveCaptionPendingSlices, setLiveCaptionPendingSlices] = useState(0)
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false)
  const [accessUsageOpen, setAccessUsageOpen] = useState(false)
  const [billingPlanOpen, setBillingPlanOpen] = useState(false)

  useEffect(() => {
    if (!LIVE_ROUTE_DIAG_ENABLED) return
    const snapshot = {
      VITE_USE_LIVE_ENGINE_V2_flag: USE_LIVE_ENGINE_V2,
      useLiveEngineV2,
      usesHosted,
      liveCaptionsPipelineEnabled,
      recorderStatus: recorder.status,
    }
    liveRouteDiagLog('[LiveEngine][diag] route snapshot', JSON.stringify(snapshot))
    ;(window as unknown as { __YL_LIVE_ROUTE__?: unknown }).__YL_LIVE_ROUTE__ = snapshot
  }, [useLiveEngineV2, usesHosted, liveCaptionsPipelineEnabled, recorder.status])

  /** LiveEngine v2 only: hearing / drafting / refining so the panel never feels "stuck on spinner". */
  const liveV2CaptionPhase = useMemo(() => {
    if (!useLiveEngineV2) return null
    if (recorder.status === 'paused') return 'paused' as const
    if (recorder.status !== 'recording') return null
    const hasDraft = Boolean(primaryCaptionDraft.trim())
    const hasFinal = Boolean(primaryCaption.trim())
    // Streaming mode: derive phase from caption text state (no pending-slice counter needed).
    // "hearing"  = recording active, nothing shown yet — first words in flight
    // "drafting" = interim text visible and updating in real-time
    // "refining" = sentence finalized, waiting for next sentence
    if (!hasDraft && !hasFinal) return 'hearing' as const
    if (hasDraft) return 'drafting' as const
    return 'refining' as const
  }, [
    useLiveEngineV2,
    recorder.status,
    primaryCaptionDraft,
    primaryCaption,
  ])
  const prevRecorderStatusRef = useRef(recorder.status)
  /** Log `[live-latency] recording_session_route` once per recording segment (diag path selection). */
  const liveLatencyRouteLoggedRef = useRef(false)
  useEffect(() => {
    if (prevRecorderStatusRef.current === 'idle' && recorder.status === 'recording') {
      liveChunkFailStreakRef.current = 0
      setLiveCaptionChunkNotice(null)
    }
    prevRecorderStatusRef.current = recorder.status
  }, [recorder.status])

  useEffect(() => {
    if (recorder.status !== 'recording') {
      liveLatencyRouteLoggedRef.current = false
      return
    }
    if (liveLatencyRouteLoggedRef.current) return
    liveLatencyRouteLoggedRef.current = true
    const skipSlice =
      useLiveEngineV2ForHosted || (experimentSkipYoumiLiveSlice && usesHosted)
    console.info(
      '[live-latency] recording_session_route',
      JSON.stringify({
        path: useLiveEngineV2 ? 'v2_pcm_ws_streaming' : 'legacy_blob_http',
        usesHosted,
        prodBuild: import.meta.env.PROD,
        viteLiveEngineV2: USE_LIVE_ENGINE_V2,
        experimentalSkipLiveSlice: skipSlice,
        legacyMediaRecorderSlicesActive: Boolean(onLiveAudioChunkRef) && !skipSlice,
      }),
    )
  }, [
    recorder.status,
    useLiveEngineV2,
    usesHosted,
    useLiveEngineV2ForHosted,
    experimentSkipYoumiLiveSlice,
  ])

  useEffect(() => {
    if (liveCaptionsPipelineEnabled) setLiveCaptionChunkNotice(null)
  }, [liveCaptionsPipelineEnabled])

  useEffect(() => {
    resetLiveCaptionSessionUi()
  }, [translateTarget, resetLiveCaptionSessionUi])

  useEffect(() => {
    if (liveCaptionSessionActive) return
    // Session ended: ensure batching timer cannot fire later.
    if (youmiLiveBatchFlushTimerRef.current) {
      clearTimeout(youmiLiveBatchFlushTimerRef.current)
      youmiLiveBatchFlushTimerRef.current = null
    }
    youmiLiveQueueTranscribeRef.current = null
  }, [liveCaptionSessionActive])

  useLayoutEffect(() => {
    if (useLiveEngineV2) {
      setLiveRouteState(liveEngineMountActive ? 'v2_starting' : 'v2_waiting_session')
      liveRouteDiagLog(
        '[LiveEngine][diag] v2 branch selected; legacy chunk handler detached',
        JSON.stringify({ liveCaptionSessionActive, liveEngineMountActive }),
      )
      onLiveAudioChunkRef.current = null
      return
    }
    setLiveRouteState('legacy')
    liveRouteDiagLog('[LiveEngine][diag] legacy branch selected')
    if (!liveCaptionSessionActive) {
      onLiveAudioChunkRef.current = null
      resetLiveTranscribeRuntime()
      return
    }

    const langHint = whisperLanguageHint(liveLang)

    const YOU_MI_LIVE_BATCH_TARGET_SLICES = 1
    const YOU_MI_LIVE_BATCH_MAX_WAIT_MS = 2_600
    const YOU_MI_LIVE_WARMUP_MAX_BATCHES = 2

    const currentYoumiTargetSlices = () => {
      return YOU_MI_LIVE_BATCH_TARGET_SLICES
    }

    const currentYoumiMaxWaitMs = () => {
      const n = youmiLiveWarmupBatchesSentRef.current
      if (n <= 0) return 1400
      if (n === 1) return 1900
      return YOU_MI_LIVE_BATCH_MAX_WAIT_MS
    }

    const clearYoumiBatchTimer = (reason: string) => {
      const t = youmiLiveBatchFlushTimerRef.current
      if (!t) return
      clearTimeout(t)
      youmiLiveBatchFlushTimerRef.current = null
      youmiLiveLog('emit', 'Youmi live batch timer cleared', { reason })
    }

    const flushYoumiBatchIfReady = (opts: {
      reason: 'target_reached' | 'timer_fired'
    }): { blob: Blob; mime: string; bufferedSlices: number; bufferedBytes: number } | null => {
      const parts = youmiLiveBatchPartsRef.current
      if (!parts.length) return null
      const startedAt = youmiLiveBatchStartedAtRef.current
      const ageMs = startedAt ? Date.now() - startedAt : 0
      const targetSlices = currentYoumiTargetSlices()
      const maxWaitMs = currentYoumiMaxWaitMs()
      const readyByCount = parts.length >= targetSlices
      const readyByAge = startedAt !== null && ageMs >= maxWaitMs
      if (opts.reason === 'target_reached' && !readyByCount) {
        youmiLiveLog('emit', 'flush skipped (target not reached)', {
          bufferedSlices: parts.length,
          bufferedBytes: youmiLiveBatchBytesRef.current,
          targetSlices,
          warmupBatchesSent: youmiLiveWarmupBatchesSentRef.current,
        })
        return null
      }
      if (opts.reason === 'timer_fired' && !readyByAge) {
        youmiLiveLog('emit', 'flush skipped (timer fired too early?)', {
          bufferedSlices: parts.length,
          bufferedBytes: youmiLiveBatchBytesRef.current,
          ageMs,
          maxWaitMs,
          warmupBatchesSent: youmiLiveWarmupBatchesSentRef.current,
        })
        return null
      }
      const mt = youmiLiveBatchMimeRef.current || 'audio/webm'
      const bufferedSlices = parts.length
      const bufferedBytes = youmiLiveBatchBytesRef.current
      const out = new Blob(parts, { type: mt })
      youmiLiveBatchPartsRef.current = []
      youmiLiveBatchBytesRef.current = 0
      youmiLiveBatchMimeRef.current = ''
      youmiLiveBatchStartedAtRef.current = null
      clearYoumiBatchTimer('flush')
      return { blob: out, mime: mt, bufferedSlices, bufferedBytes }
    }

    const resetYoumiBatch = (reason: string) => {
      youmiLiveBatchPartsRef.current = []
      youmiLiveBatchBytesRef.current = 0
      youmiLiveBatchMimeRef.current = ''
      youmiLiveBatchStartedAtRef.current = null
      clearYoumiBatchTimer(`reset:${reason}`)
    }

    const commitReadyPieces = () => {
      let appended = ''
      let committedCount = 0
      while (true) {
        const seq = liveTranscribeSeqCommitRef.current
        const piece = liveTranscribePiecesRef.current.get(seq)
        if (typeof piece === 'undefined') break
        liveTranscribePiecesRef.current.delete(seq)
        liveTranscribeSeqCommitRef.current = seq + 1
        committedCount += 1
        if (!piece) continue
        appended = appended ? `${appended} ${piece}` : piece
      }
      if (committedCount > 0) {
        // Draft is for immediate feedback; clear it once ordered pieces are committed.
        setPrimaryCaptionDraft('')
      }
      if (!appended) return
      youmiLiveLog('E', 'appending to primary line', {
        pieceLen: appended.length,
        preview: appended.slice(0, 120),
      })
      setPrimaryCaption((prev) => {
        const next = prev ? `${prev} ${appended}` : appended
        primaryCaptionRef.current = next
        return next
      })
      onFinalPhraseRef.current?.(appended)
    }

    const isYoumiHostedSession =
      usesHosted && !stubMode && !localOnly && Boolean(supabase) && Boolean(userId)
    const MAX_LIVE_TRANSCRIBE_CONCURRENCY = isYoumiHostedSession ? 3 : 1

    const drainTranscribeQueue = () => {
      while (
        liveTranscribeInFlightRef.current < MAX_LIVE_TRANSCRIBE_CONCURRENCY &&
        liveTranscribeQueueRef.current.length > 0
      ) {
        const item = liveTranscribeQueueRef.current.shift()
        if (!item) break
        const { seq, blob, mime, reason } = item
        liveTranscribeInFlightRef.current += 1
        void (async () => {
          const ext = mime.includes('webm') ? 'webm' : mime.includes('mp4') ? 'm4a' : 'webm'
          try {
            let t: string
            if (stubMode) {
              t = await transcribeRecording(blob, `live.${ext}`, {
                language: langHint,
              })
            } else if (usesHosted && !localOnly && supabase && userId) {
              /** Legacy hosted slice path (dev only when v2 off): HTTP Storage+signed URL chunk — never WS base64 transcribe. */
              const { data: sess } = await supabase.auth.getSession()
              const tok = sess.session?.access_token
              if (!tok) throw new Error('Sign in again to use live captions.')
              const chunkIdx = liveChunkIndexRef.current++
              const sid = liveCaptionSessionIdRef.current
              if (!sid) throw new Error('Live caption session not ready.')
              youmiLiveLog('srv', 'hosted live chunk (HTTP)', {
                chunkIndex: chunkIdx,
                bytes: blob.size,
                mime,
                seq,
                reason,
              })
              t = await transcribeHostedLiveCaptionChunk({
                supabase,
                accessToken: tok,
                userId,
                sessionId: sid,
                chunkIndex: chunkIdx,
                blob,
                mime,
                filename: `live.${ext}`,
              })
            } else {
              t = await transcribeRecording(blob, `live.${ext}`, {
                language: langHint,
              })
            }
            const piece = t.trim()
            liveChunkFailStreakRef.current = 0
            setLiveCaptionChunkNotice(null)
            if (piece) {
              // Draft-first: show quickly even before ordered commit catches up.
              setPrimaryCaptionDraft(piece)
              onDraftPhraseRef.current?.(piece)
            }
            liveTranscribePiecesRef.current.set(seq, piece)
            commitReadyPieces()
            if (!piece) {
              youmiLiveLog(
                'D',
                'transcribe returned empty string; primary not updated this chunk',
                { seq, reason },
              )
            }
          } catch (e) {
            youmiLiveLog('fail', 'chunk pipeline threw', {
              message: e instanceof Error ? e.message : String(e),
              seq,
              reason,
            })
            const hasPrimary = primaryCaptionRef.current.trim().length > 0
            liveChunkFailStreakRef.current += 1
            const streak = liveChunkFailStreakRef.current
            liveTranscribePiecesRef.current.set(seq, '')
            commitReadyPieces()
            if (hasPrimary) {
              if (streak >= LIVE_CHUNK_SOFT_STREAK) {
                setLiveCaptionChunkNotice({
                  kind: 'soft',
                  message:
                    'A few caption lines could not be updated. Recording continues — captions may skip a phrase.',
                })
              }
            } else if (streak >= LIVE_CHUNK_FATAL_STREAK) {
              const msg = e instanceof Error ? e.message : ''
              const looksLikeHostedSetup = /not available yet|setup is not available/i.test(msg)
              setLiveCaptionChunkNotice({
                kind: 'fatal',
                message:
                  usesHosted && looksLikeHostedSetup
                    ? 'Youmi AI setup is not available yet.'
                    : usesHosted
                      ? 'Live captions could not start with Youmi AI. Check your connection or try again after class with Generate transcript & summaries.'
                      : 'Live captions could not start. Check Account settings or your connection.',
              })
            }
          } finally {
            liveTranscribeInFlightRef.current = Math.max(0, liveTranscribeInFlightRef.current - 1)
            setLiveCaptionPendingSlices((n) => Math.max(0, n - 1))
            drainTranscribeQueue()
          }
        })()
      }
    }

    const queueLiveTranscribe = (blob: Blob, mime: string, reason: string) => {
      const ext = mime.includes('webm') ? 'webm' : mime.includes('mp4') ? 'm4a' : 'webm'
      youmiLiveLog('emit', 'batch->transcribe queued', {
        reason,
        bytes: blob.size,
        mime,
        ext,
      })
      const seq = liveTranscribeSeqIssuedRef.current++
      setLiveCaptionPendingSlices((n) => n + 1)
      liveTranscribeQueueRef.current.push({ seq, blob, mime, reason })
      drainTranscribeQueue()
    }
    // Keep the latest queue fn for any timer-fired flush.
    youmiLiveQueueTranscribeRef.current = queueLiveTranscribe

    onLiveAudioChunkRef.current = (blob, mime) => {
      if (!liveCaptionsPipelineEnabled) {
        youmiLiveLog('A', 'chunk handler skipped (pipeline not enabled)', {
          liveCaptionsPipelineEnabled: false,
        })
        return
      }

      const isYoumiHostedLive =
        usesHosted && !stubMode && !localOnly && Boolean(supabase) && Boolean(userId)

      if (isYoumiHostedLive) {
        if (!youmiLiveBatchStartedAtRef.current) youmiLiveBatchStartedAtRef.current = Date.now()
        youmiLiveBatchPartsRef.current.push(blob)
        youmiLiveBatchBytesRef.current += blob.size
        if (!youmiLiveBatchMimeRef.current) youmiLiveBatchMimeRef.current = mime
        const targetSlices = currentYoumiTargetSlices()
        const maxWaitMs = currentYoumiMaxWaitMs()

        youmiLiveLog('emit', 'Youmi live slice buffered (batching enabled)', {
          sliceBytes: blob.size,
          sliceMime: mime,
          bufferedSlices: youmiLiveBatchPartsRef.current.length,
          bufferedBytes: youmiLiveBatchBytesRef.current,
          targetSlices,
          maxWaitMs,
          warmupBatchesSent: youmiLiveWarmupBatchesSentRef.current,
        })

        if (!youmiLiveBatchFlushTimerRef.current) {
          youmiLiveLog('emit', 'Youmi live batch timer armed', {
            maxWaitMs,
            bufferedSlices: youmiLiveBatchPartsRef.current.length,
            bufferedBytes: youmiLiveBatchBytesRef.current,
            targetSlices,
            warmupBatchesSent: youmiLiveWarmupBatchesSentRef.current,
          })
          youmiLiveBatchFlushTimerRef.current = window.setTimeout(() => {
            youmiLiveLog('emit', 'Youmi live batch timer fired', {
              bufferedSlices: youmiLiveBatchPartsRef.current.length,
              bufferedBytes: youmiLiveBatchBytesRef.current,
              targetSlices: currentYoumiTargetSlices(),
              maxWaitMs: currentYoumiMaxWaitMs(),
              warmupBatchesSent: youmiLiveWarmupBatchesSentRef.current,
            })
            const flushed = flushYoumiBatchIfReady({ reason: 'timer_fired' })
            if (!flushed) return
            youmiLiveLog('emit', 'Youmi live batch flushed (timer)', {
              batchBytes: flushed.blob.size,
              batchMime: flushed.mime,
              bufferedSlices: flushed.bufferedSlices,
              bufferedBytes: flushed.bufferedBytes,
              warmupBatchesSent: youmiLiveWarmupBatchesSentRef.current,
            })
            const q = youmiLiveQueueTranscribeRef.current
            if (!q) {
              youmiLiveLog('emit', 'timer fired but queue fn missing (skipped)', {})
              return
            }
            if (youmiLiveWarmupBatchesSentRef.current < YOU_MI_LIVE_WARMUP_MAX_BATCHES) {
              youmiLiveWarmupBatchesSentRef.current += 1
            }
            q(flushed.blob, flushed.mime, 'youmi_batch_timer')
          }, maxWaitMs)
        }

        const flushedNow = flushYoumiBatchIfReady({ reason: 'target_reached' })
        if (!flushedNow) return
        blob = flushedNow.blob
        mime = flushedNow.mime
        if (youmiLiveWarmupBatchesSentRef.current < YOU_MI_LIVE_WARMUP_MAX_BATCHES) {
          youmiLiveWarmupBatchesSentRef.current += 1
        }

        youmiLiveLog('emit', 'Youmi live batch flushed (queued to transcribe)', {
          batchBytes: blob.size,
          batchMime: mime,
          slicesPerBatch: targetSlices,
          warmupBatchesSent: youmiLiveWarmupBatchesSentRef.current,
        })
      } else {
        resetYoumiBatch('non_youmi_hosted_live')
        youmiLiveLog('emit', 'chunk received in App handler (queued to transcribe)', {
          bytes: blob.size,
          mime,
        })
      }

      queueLiveTranscribe(blob, mime, isYoumiHostedLive ? 'youmi_batch_flush' : 'direct_slice')
    }

    return () => {
      onLiveAudioChunkRef.current = null
      // Important: do NOT clear the batching timer here. This effect can re-run while the session
      // stays active (e.g. health refresh / auth/session updates). Clearing would cause "buffered
      // but never flushed" if no further slices arrive to re-arm the timer.
    }
  }, [
    liveCaptionSessionActive,
    liveLang,
    liveCaptionsPipelineEnabled,
    usesHosted,
    stubMode,
    localOnly,
    supabase,
    userId,
    resetLiveTranscribeRuntime,
    useLiveEngineV2,
  ])

  useEffect(() => {
    if (useLiveEngineV2) {
      onFinalPhraseRef.current = null
      onDraftPhraseRef.current = null
      return
    }
    if (!liveCaptionSessionActive) {
      onFinalPhraseRef.current = null
      onDraftPhraseRef.current = null
      return
    }

    const hostedTranslateToken = async (): Promise<string | null> => {
      if (!supabase) return null
      try {
        const { data } = await supabase.auth.getSession()
        return data.session?.access_token ?? null
      } catch {
        return null
      }
    }

    const pending: string[] = []
    const pendingDraft: string[] = []
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let draftDebounceTimer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false
    let chain: Promise<void> = Promise.resolve()
    const TRANSLATE_DEBOUNCE_MS = 140
    const TRANSLATE_REFLUSH_MS = 70
    const TRANSLATE_MAX_PHRASES_PER_BATCH = 1
    const TRANSLATE_DRAFT_DEBOUNCE_MS = 90
    const translatedRecently = new Set<string>()

    const normalizeForDedup = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

    const flushPending = () => {
      debounceTimer = null
      if (cancelled) return
      const batch = pending.splice(0, TRANSLATE_MAX_PHRASES_PER_BATCH).join(' ').trim()
      if (!batch) return
      if (translateTarget === 'off') return
      if (!liveCaptionsPipelineEnabled) return
      const target = translateTarget

      chain = chain.then(async () => {
        if (cancelled) return
        try {
          const t = await translateLiveCaption(batch, {
            target,
            getAccessToken: hostedTranslateToken,
          })
          if (cancelled || !t) return
          setSecondaryCaption((c) => (c ? `${c} ${t}` : t))
        } catch (err) {
          youmiLiveLog('F', 'translateLiveCaption failed (secondary only)', {
            message: err instanceof Error ? err.message : String(err),
          })
        } finally {
          // Keep secondary closely following primary when phrases arrive quickly.
          if (!cancelled && pending.length > 0 && !debounceTimer) {
            debounceTimer = window.setTimeout(flushPending, TRANSLATE_REFLUSH_MS)
          }
        }
      })
    }

    const flushDraftPending = () => {
      draftDebounceTimer = null
      if (cancelled) return
      const batch = pendingDraft.splice(0, 1).join(' ').trim()
      if (!batch) return
      if (translateTarget === 'off') return
      if (!liveCaptionsPipelineEnabled) return
      const key = normalizeForDedup(batch)
      if (translatedRecently.has(key)) return
      translatedRecently.add(key)
      const target = translateTarget

      chain = chain.then(async () => {
        if (cancelled) return
        try {
          const t = await translateLiveCaption(batch, {
            target,
            getAccessToken: hostedTranslateToken,
          })
          if (cancelled || !t) return
          setSecondaryCaption((c) => (c ? `${c} ${t}` : t))
        } catch (err) {
          youmiLiveLog('F', 'translateLiveCaption failed (draft secondary)', {
            message: err instanceof Error ? err.message : String(err),
          })
        }
      })
    }

    onFinalPhraseRef.current = (phrase: string) => {
      if (translateTarget === 'off') return
      if (!liveCaptionsPipelineEnabled) return
      const p = phrase.trim()
      if (!p) return
      translatedRecently.add(normalizeForDedup(p))
      pending.push(p)
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = window.setTimeout(flushPending, TRANSLATE_DEBOUNCE_MS)
    }

    onDraftPhraseRef.current = (phrase: string) => {
      if (translateTarget === 'off') return
      if (!liveCaptionsPipelineEnabled) return
      const p = phrase.trim()
      if (!p) return
      pendingDraft.push(p)
      if (draftDebounceTimer) clearTimeout(draftDebounceTimer)
      draftDebounceTimer = window.setTimeout(flushDraftPending, TRANSLATE_DRAFT_DEBOUNCE_MS)
    }

    return () => {
      cancelled = true
      onFinalPhraseRef.current = null
      onDraftPhraseRef.current = null
      if (debounceTimer) clearTimeout(debounceTimer)
      if (draftDebounceTimer) clearTimeout(draftDebounceTimer)
    }
  }, [liveCaptionSessionActive, translateTarget, liveCaptionsPipelineEnabled, useLiveEngineV2, supabase])

  // useLayoutEffect: attach PCM handler before paint so ScriptProcessor callbacks never run with a null ref
  // (recorder.start uses flushSync('recording') then starts AudioContext — effect would be too late).
  useLayoutEffect(() => {
    if (!useLiveEngineV2) {
      if (liveEngineRef.current) {
        liveRouteDiagLog('[LiveEngine][diag] stopping v2 engine because route is legacy')
        liveEngineRef.current.stop()
        liveEngineRef.current = null
      }
      return
    }
    if (!liveEngineMountActive) {
      setLiveRouteState('v2_waiting_session')
      onLiveAudioChunkRef.current = null
      onLivePcmChunkRef.current = null
      if (liveEngineRef.current) {
        liveRouteDiagLog('[LiveEngine][diag] stopping v2 engine because capture surface unmounted')
        liveEngineRef.current.stop()
        liveEngineRef.current = null
      }
      return
    }
    if (!liveCaptionsPipelineEnabled || !usesHosted) {
      setLiveRouteState('v2_blocked_pipeline')
      liveRouteDiagLog(
        '[LiveEngine][diag] v2 blocked (pipeline/capability)',
        JSON.stringify({ liveCaptionsPipelineEnabled, usesHosted }),
      )
      onLiveAudioChunkRef.current = null
      onLivePcmChunkRef.current = null
      return
    }

    setLiveRouteState('v2_starting')
    liveRouteDiagLog('[LiveEngine][diag] LiveEngine.start()')
    const engineOpts: LiveEngineOpts = {
      tokenGetter: async () => {
        try {
          const { data } = await supabase!.auth.getSession()
          return data.session?.access_token ?? null
        } catch {
          return null
        }
      },
    }
    const engine = new LiveEngine(engineOpts)
    liveEngineRef.current = engine
    liveCaptionSessionRef.current.reset()
    lastFinalTimestampRef.current = 0
    syncLiveCaptionViewFromModel(liveCaptionSessionRef.current.getView())

    // Warm at the rate capture is pinned to, not at whatever the output device
    // happens to report. See `livePcmCapture` — the two disagreeing is what put
    // a 3–4s upstream re-handshake on the user's first sentence.
    warmSampleRateRef.current = LIVE_PCM_SAMPLE_RATE

    engine.onEvent((ev) => {
      if (ev.type === 'status') {
        liveRouteDiagLog('[LiveEngine][App] status', JSON.stringify({ status: ev.status, detail: ev.detail }))
        if (ev.status === 'warming') setLiveRouteState('v2_starting')
        if (ev.status === 'connected' || ev.status === 'streaming') setLiveRouteState('v2_streaming')
        if (ev.status === 'error') setLiveRouteState('v2_error')
        if (ev.status === 'reconnecting') {
          setLiveCaptionChunkNotice({
            kind: 'soft',
            message: 'Realtime captions reconnecting…',
          })
        } else if (ev.status === 'connected' || ev.status === 'streaming') {
          setLiveCaptionChunkNotice(null)
        }
        return
      }
      if (ev.type === 'error') {
        liveRouteDiagLog(
          '[LiveEngine][App] error',
          JSON.stringify({ code: ev.code, message: ev.message, recoverable: ev.recoverable }),
        )
        // Beta gate errors: show specific quota message, do not attempt reconnect
        const BETA_CODES = new Set([
          'beta_limit_reached', 'recording_too_long', 'daily_recording_limit_reached',
          'quota_suspended', 'auth_required', 'session_limit_reached',
        ])
        if (BETA_CODES.has(ev.code)) {
          const betaMsg = ev.code === 'auth_required'
            ? 'Sign in again to use live captions.'
            : 'Free access limit reached. Please contact Youmi Lens for more access.'
          setLiveCaptionChunkNotice({ kind: 'fatal', message: betaMsg })
          setLiveRouteState('v2_error')
          return
        }
        setLiveCaptionChunkNotice({
          kind: ev.recoverable ? 'soft' : 'fatal',
          message: ev.message,
        })
        setLiveRouteState('v2_error')
        if (ev.recoverable) {
          setLiveCaptionPendingSlices((n) => Math.max(0, n - 1))
        }
        return
      }
      if (ev.type === 'en_interim') {
        liveRouteDiagLog('[LiveEngine][App] en_interim', JSON.stringify({ segmentId: ev.segmentId, rev: ev.rev }))
        // T7: the interim reached the client. T8 is the state write below.
        markLatency('T7_client_receive', ev.segmentId)
        const cap = liveCaptionEventFromEngine(ev)
        if (cap) syncLiveCaptionViewFromModel(liveCaptionSessionRef.current.apply(cap))
        markLatency('T8_state_update', ev.segmentId)
        // T9: React commits synchronously inside this handler, so the paint that
        // follows shows this text. Measuring here is the honest "visible" mark
        // short of a rAF, which does not fire while the window is unpainted.
        markLatency('T9_visible_render', ev.segmentId)
        return
      }
      if (ev.type === 'en_final') {
        liveRouteDiagLog('[LiveEngine][App] en_final', JSON.stringify({ segmentId: ev.segmentId }))
        setLiveCaptionPendingSlices((n) => Math.max(0, n - 1))
        const cap = liveCaptionEventFromEngine(ev)
        if (cap) syncLiveCaptionViewFromModel(liveCaptionSessionRef.current.apply(cap))
        return
      }
      if (ev.type === 'zh_interim') {
        const cap = liveCaptionEventFromEngine(ev)
        if (cap) {
          syncLiveCaptionViewFromModel(liveCaptionSessionRef.current.apply(cap))
          liveRouteDiagLog('[LiveEngine][App] zh_interim', JSON.stringify({ segmentId: ev.segmentId, rev: ev.rev }))
        }
        return
      }
      if (ev.type === 'zh_final') {
        liveRouteDiagLog('[LiveEngine][App] zh_final', JSON.stringify({ segmentId: ev.segmentId }))
        const cap = liveCaptionEventFromEngine(ev)
        if (cap) syncLiveCaptionViewFromModel(liveCaptionSessionRef.current.apply(cap))
      }
    })

    engine.start({ translateTarget })

    let warmCancelled = false
    void (async () => {
      try {
        console.info(
          '[live-latency] live_engine_warm_begin',
          JSON.stringify({ sampleRate: warmSampleRateRef.current }),
        )
        await engine.warmUpstream(warmSampleRateRef.current)
        if (!warmCancelled) {
          console.info('[live-latency] live_engine_warm_complete', JSON.stringify({}))
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (!warmCancelled) {
          console.warn('[live-latency] live_engine_warm_failed', JSON.stringify({ message: msg }))
          setLiveCaptionChunkNotice({
            kind: 'soft',
            message:
              'Live captions will finish connecting when you record (warm-up did not complete in time).',
          })
        }
      }
    })()

    // PCM streaming path: AudioContext frames drive the engine directly (no blob slices needed).
    onLivePcmChunkRef.current = (buffer, sampleRate) => {
      engine.pushPcmChunk(buffer, sampleRate)
    }
    onLiveAudioChunkRef.current = null

    /*
     * Re-warm at the rate the microphone actually gave us.
     *
     * Capture is pinned to LIVE_PCM_SAMPLE_RATE, which the warm above used too,
     * so this should now be a no-op on every machine. It stays as the safety
     * net for the one case that can still diverge: a platform that refuses the
     * requested rate, where `createLivePcmAudioContext` falls back to the
     * device default. The adapter reacts to a rate change on the first PCM
     * frame by destroying the upstream session and reconnecting, and that
     * reconnect would otherwise land on the user's first word.
     *
     * Firing here moves it into the gap between pressing Start and speaking, and
     * PCM keeps buffering in the adapter's queue meanwhile, so nothing is lost.
     */
    onCaptureSampleRateRef.current = (sampleRate) => {
      if (sampleRate === warmSampleRateRef.current) return
      console.warn(
        '[live-latency] capture_rate_differs_from_warm',
        JSON.stringify({ warmSampleRate: warmSampleRateRef.current, captureSampleRate: sampleRate }),
      )
      warmSampleRateRef.current = sampleRate
      void engine.warmUpstream(sampleRate).catch(() => undefined)
    }

    return () => {
      warmCancelled = true
      onCaptureSampleRateRef.current = null
      onLivePcmChunkRef.current = null
      onLiveAudioChunkRef.current = null
      engine.stop()
      if (liveEngineRef.current === engine) liveEngineRef.current = null
      if (useLiveEngineV2) setLiveRouteState('v2_waiting_session')
    }
  }, [
    useLiveEngineV2,
    liveEngineMountActive,
    liveCaptionsPipelineEnabled,
    usesHosted,
    translateTarget,
    syncLiveCaptionViewFromModel,
  ])

  const [recordings, setRecordings] = useState<Recording[]>([])
  /** Mirrors `recordings` so a refresh can reconcile titles against what is on
   *  screen without making itself depend on — and re-run for — every change. */
  const recordingsRef = useRef<Recording[]>([])
  recordingsRef.current = recordings
  /** Lectures carrying `deleted_at` from the cloud; the Recently Deleted source. */
  const [cloudDeletedLectures, setCloudDeletedLectures] = useState<Recording[]>([])
  /** True once a fetched row proved this database has the deletion columns. */
  const [cloudDeletionAvailable, setCloudDeletionAvailable] = useState(false)
  /** Durable pending/failed cloud uploads for the current user (Phase 2D-2). */
  const [pendingUploads, setPendingUploads] = useState<PendingUploadMeta[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RecordingDetail | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [audioLoadError, setAudioLoadError] = useState<string | null>(null)
  /**
   * True when the transcript/summary row fetch itself failed (network, backend
   * error) — distinct from a lecture that genuinely has no summary/transcript
   * yet. `detail` is null in both cases, so this is the only signal that tells
   * them apart.
   */
  const [detailLoadFailed, setDetailLoadFailed] = useState(false)
  const [detailRetryNonce, setDetailRetryNonce] = useState(0)

  const [libraryActiveScope, setLibraryActiveScope] = useState<LibraryActiveScope>({ kind: 'all' })
  const [courseView, setCourseView] = useState<CourseView>({ type: 'all' })
  const [libraryPickMode, setLibraryPickMode] = useState(false)
  const [libraryPickedIds, setLibraryPickedIds] = useState<string[]>([])
  const libraryShiftAnchorRef = useRef<string | null>(null)

  const hostedCloudJobActive =
    !localOnly &&
    usesHosted &&
    detail &&
    ['queued', 'transcribing', 'summarizing', 'transcript_ready'].includes(detail.aiStatus ?? '')

  const hostedPostClassOutputsComplete = Boolean(
    detail?.transcript?.trim() && detail?.summaryEn?.trim() && detail?.summaryZh?.trim(),
  )

  const showHostedReadyToGenerateHint =
    !localOnly &&
    usesHosted &&
    detail &&
    detail.aiStatus === 'pending' &&
    !hostedCloudJobActive &&
    (hostedConfigured || stubMode || optimisticCloudYoumiHealthLoading) &&
    !hostedUnavailableMessage &&
    !hostedPostClassOutputsComplete

  /** True from click until hosted enqueue returns or BYOK pipeline finishes; avoids “dead” UI before network. */
  const [transcribeSubmitPending, setTranscribeSubmitPending] = useState(false)
  const transcribeActionLockRef = useRef(false)

  const aiSourceSwitchEpochRef = useRef<string | null>(null)
  useEffect(() => {
    if (aiSourceSwitchEpochRef.current === null) {
      aiSourceSwitchEpochRef.current = aiStoreTick
      return
    }
    if (aiSourceSwitchEpochRef.current === aiStoreTick) return
    aiSourceSwitchEpochRef.current = aiStoreTick
    setRecentAi(null)
    setLiveCaptionChunkNotice(null)
    liveChunkFailStreakRef.current = 0
    setLiveCaptionPendingSlices(0)
    transcribeActionLockRef.current = false
    setTranscribeSubmitPending(false)
    if (recorder.status === 'idle') {
      lastFinalTimestampRef.current = 0
      resetLiveCaptionSessionUi()
      liveCaptionSessionIdRef.current = null
      youmiLiveBatchPartsRef.current = []
      youmiLiveBatchBytesRef.current = 0
      youmiLiveBatchMimeRef.current = ''
      youmiLiveBatchStartedAtRef.current = null
      youmiLiveWarmupBatchesSentRef.current = 0
      if (youmiLiveBatchFlushTimerRef.current) {
        clearTimeout(youmiLiveBatchFlushTimerRef.current)
        youmiLiveBatchFlushTimerRef.current = null
      }
      resetLiveTranscribeRuntime()
    }
  }, [aiStoreTick, recorder.status, resetLiveTranscribeRuntime, resetLiveCaptionSessionUi])

  const aiPipelineBusy =
    transcribeSubmitPending ||
    hostedCloudJobActive ||
    flow.phase === 'transcribing' ||
    flow.phase === 'summarizing'

  const generateTranscribeButtonLabel = useMemo(() => {
    if (transcribeSubmitPending && !localOnly && usesHosted && !hostedCloudJobActive) {
      return 'Starting Youmi AI…'
    }
    if (aiPipelineBusy) {
      return usesHosted ? 'Youmi AI is working…' : 'Working…'
    }
    if (!localOnly && usesHosted) return 'Generate transcript & summaries'
    return 'Transcribe & summarize (bilingual)'
  }, [
    transcribeSubmitPending,
    localOnly,
    usesHosted,
    hostedCloudJobActive,
    aiPipelineBusy,
  ])

  /**
   * Empty until reconciled against the real course list below, which adopts
   * the first canonical course once one is known (or leaves this empty only
   * if there are truly none yet). This must never start as a literal course
   * name: a hardcoded default here has no course row behind it, and would
   * display exactly like the bug this session fixed (Record Home showing
   * "CS 101" while no such course exists).
   */
  const [course, setCourse] = useState('')
  /** Canonical Course UUID for the lecture currently being prepared. */
  const [recordingCourseId, setRecordingCourseId] = useState<string | null>(null)
  const [title, setTitle] = useState('')

  const saveInFlightRef = useRef(false)

  const [backupBusy, setBackupBusy] = useState(false)
  const [backupError, setBackupError] = useState<string | null>(null)
  const [backupMsg, setBackupMsg] = useState<string | null>(null)
  const [deleteActionBusy, setDeleteActionBusy] = useState(false)
  /** Recently Deleted restore failure, user-safe copy only. Cleared on the next attempt. */
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [cloudTrash, setCloudTrash] = useState<Record<string, CloudTrashedMeta>>({})
  const [globalSelectArmed, setGlobalSelectArmed] = useState(false)
  const [trashConfirmModal, setTrashConfirmModal] = useState<{ ids: string[]; scope: TrashDeletionScope } | null>(
    null,
  )
  const [permanentPurgeModal, setPermanentPurgeModal] = useState<string[] | null>(null)
  /* ── Courses V2 (Phase 1B) ────────────────────────────────────────────────
     Course is a real cloud entity now. `useCourses` owns the repository; this
     component never touches Supabase for courses directly. */
  const [openCourseId, setOpenCourseId] = useState<string | null>(null)
  const [courseDialog, setCourseDialog] = useState<
    { kind: 'create' } | { kind: 'rename'; courseId: string } | { kind: 'delete'; courseId: string } | null
  >(null)
  /** Recently Deleted V2. Distinct from the legacy sidebar's `recentlyDeletedOpen`. */
  const [coursesV2DeletedOpen, setCoursesV2DeletedOpen] = useState(false)
  /** Pending permanent delete. Nothing is removed until this is confirmed. */
  const [purgeDialog, setPurgeDialog] = useState<
    { kind: 'course'; courseId: string } | { kind: 'lecture'; lectureId: string } | null
  >(null)
  /** Confirmation for discarding a live recording. */
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false)
  /**
   * Lecture actions, one dialog per verb.
   *
   * Rename, Move and Delete used to share one "edit title and course together"
   * modal, so choosing Rename could rewrite the course and choosing Move could
   * rewrite the title. Each kind below writes exactly the field its label names.
   */
  const [lectureDialog, setLectureDialog] = useState<
    { kind: 'rename' | 'move' | 'delete'; recordingId: string } | null
  >(null)
  const [lectureDialogError, setLectureDialogError] = useState<string | null>(null)
  const [folderDeleteModal, setFolderDeleteModal] = useState<{ folderId: string; folderName: string } | null>(null)
  const [recentlyDeletedOpen, setRecentlyDeletedOpen] = useState(false)
  const [localTrashRows, setLocalTrashRows] = useState<Recording[]>([])
  const [trashRefreshNonce, setTrashRefreshNonce] = useState(0)
  const [libraryFolderNotice, setLibraryFolderNotice] = useState<string | null>(null)
  const [signOutBusy, setSignOutBusy] = useState(false)

  // Auto-dismiss library folder notices after 2 s.
  useEffect(() => {
    if (!libraryFolderNotice) return
    const t = setTimeout(() => setLibraryFolderNotice(null), 2000)
    return () => clearTimeout(t)
  }, [libraryFolderNotice])

  type LibraryFolder = { id: string; name: string; createdAt: number }
  const LIB_FOLDERS_KEY = 'yl_library_folders_v1'
  const LIB_LECTURE_LOCATION_KEY = 'yl_library_lecture_location_v1'

  const [libraryFolders, setLibraryFolders] = useState<LibraryFolder[]>(() => {
    try {
      const raw = localStorage.getItem(LIB_FOLDERS_KEY)
      if (!raw) return []
      const arr = JSON.parse(raw) as unknown
      if (!Array.isArray(arr)) return []
      const out: LibraryFolder[] = []
      for (const it of arr) {
        if (!it || typeof it !== 'object') continue
        const o = it as { id?: unknown; name?: unknown; createdAt?: unknown }
        if (typeof o.id !== 'string' || typeof o.name !== 'string') continue
        const createdAt = typeof o.createdAt === 'number' ? o.createdAt : Date.now()
        out.push({ id: o.id, name: o.name, createdAt })
      }
      return out
    } catch {
      return []
    }
  })

  const [libraryLectureLocation, setLibraryLectureLocation] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem(LIB_LECTURE_LOCATION_KEY)
      if (!raw) return {}
      const obj = JSON.parse(raw) as unknown
      if (!obj || typeof obj !== 'object') return {}
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof v !== 'string') continue
        out[k] = v
      }
      return out
    } catch {
      return {}
    }
  })

const [editLectureModal, setEditLectureModal] = useState<{
    id: string
    courseDraft: string
    titleDraft: string
    error: string | null
  } | null>(null)
  const [lectureMetadataBusy, setLectureMetadataBusy] = useState(false)
  const [newFolderInputVisible, setNewFolderInputVisible] = useState(false)
  const [newFolderInputValue, setNewFolderInputValue] = useState('')
  const [coursesSearchQuery, setCoursesSearchQuery] = useState('')

  useEffect(() => {
    try {
      localStorage.setItem(LIB_FOLDERS_KEY, JSON.stringify(libraryFolders))
      localStorage.setItem(LIB_LECTURE_LOCATION_KEY, JSON.stringify(libraryLectureLocation))
    } catch {
      /* ignore */
    }
  }, [libraryFolders, libraryLectureLocation])

  useEffect(() => {
    if (!userId || localOnly) {
      setCloudTrash({})
      return
    }
    setCloudTrash(loadCloudTrashRegistry(userId))
  }, [userId, localOnly])

  // Recovery is a list, not an implicit "first item". Default to the newest
  // durable session (the store sorts newest-first), while preserving an
  // explicit choice as long as that item remains recoverable.
  useEffect(() => {
    setSelectedRecoverySessionId((current) =>
      current && recoveredSessions.some((session) => session.id === current)
        ? current
        : (recoveredSessions[0]?.id ?? null),
    )
  }, [recoveredSessions])

  useEffect(() => {
    setGlobalSelectArmed(false)
  }, [libraryActiveScope, libraryPickMode])

  useEffect(() => {
    if (!localOnly) return
    void listTrashRecordingsLocal().then(setLocalTrashRows)
  }, [localOnly, trashRefreshNonce])

  useEffect(() => {
    if (!trashConfirmModal && !permanentPurgeModal && !folderDeleteModal) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setTrashConfirmModal(null)
        setPermanentPurgeModal(null)
        setFolderDeleteModal(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [trashConfirmModal, permanentPurgeModal, folderDeleteModal])


  const refreshList = useCallback(async (): Promise<Recording[]> => {
    let list: Recording[]
    if (localOnly) {
      list = await listRecordingsLocal()
      setCloudDeletedLectures([])
      setCloudDeletionAvailable(false)
    } else {
      // One fetch, both halves. `active` already excludes anything deleted on
      // ANY device, so an iPad deletion leaves this library without Desktop
      // having recorded anything locally.
      const lists = await listLectures(supabase!, userId!)
      list = lists.active
      setCloudDeletedLectures(lists.deleted)
      setCloudDeletionAvailable(lists.cloudDeletionAvailable)
    }
    // A rename made on this Mac that has not round-tripped yet must not be
    // undone by a row read before it landed. Titles only — every other column
    // is server-authoritative and comes back untouched.
    list = reconcileLectureTitles(recordingsRef.current, list)
    // Same shape, for Notes and Marks, each judged by its own clock — an
    // unsaved Notes edit or a mark just added on this Mac must not be undone by
    // a row read before either write landed.
    list = reconcileLectureAnnotations(recordingsRef.current, list)
    setRecordings(list)
    // Durable pending/failed cloud uploads for THIS user, de-duped against cloud
    // (so a successfully-retried recording never shows twice). Best-effort: never
    // block the main list. Local-only mode has no pending cloud uploads.
    if (!localOnly && userId) {
      try {
        const mine = await listPendingUploads(userId)
        setPendingUploads(visiblePendingUploads(mine, userId, new Set(list.map((r) => r.id))))
      } catch {
        /* ignore */
      }
    } else {
      setPendingUploads([])
    }
    return list
  }, [localOnly, supabase, userId])

  /**
   * Phase 2D-2: real user retry for a pending/failed upload. Reuses the SAME
   * recording UUID → same stable storage path + idempotent DB insert, so it can
   * never create a duplicate lecture, storage object, or quota charge. Local audio
   * is preserved until cloud persistence is confirmed, then cleaned up.
   */
  const handleRetryPendingUpload = useCallback(
    async (id: string) => {
      if (localOnly || !supabase || !userId) return
      const rec = await getPendingUploadWithBlob(id)
      if (!rec) {
        await refreshList()
        return
      }
      // Legacy pending upload with no canonical course — never silently
      // retry into a default/first Course. The picker in the Pending
      // Uploads list must persist a real choice first (see
      // handleAssignPendingUploadCourse), same contract as recovery.
      if (pendingUploadNeedsCourseChoice(rec)) return
      await updatePendingUpload(id, { state: 'uploading', updatedAt: Date.now() })
      setPendingUploads((prev) => prev.map((p) => (p.id === id ? { ...p, state: 'uploading' } : p)))
      try {
        let saveResult: Awaited<ReturnType<typeof uploadLectureAudioViaServer>> | undefined
        for (let attempt = 1; ; attempt++) {
          try {
            saveResult = await withTimeout(
              uploadLectureAudioViaServer(supabase, id, rec.audioBlob, rec.mime, rec.durationSec, {
                course: rec.course,
                courseId: rec.courseId ?? null,
                title: rec.title,
                liveTranscript: rec.liveTranscript ?? '',
                liveTranscriptRaw: rec.liveTranscriptRaw ?? '',
              }),
              SAVE_UPLOAD_TIMEOUT_MS,
              'Retry upload',
            )
            break
          } catch (attemptErr) {
            const plan = computeUploadRetryPlan(attempt)
            if (!plan.retry || !isTransientUploadError(attemptErr)) throw attemptErr
            await new Promise((r) => window.setTimeout(r, plan.delayMs))
          }
        }
        if (!saveResult!.recording) {
          await insertLectureRecordingRow({
            supabase,
            userId,
            id,
            course: rec.course,
            courseId: rec.courseId ?? null,
            title: rec.title,
            durationSec: rec.durationSec,
            mime: rec.mime,
            storagePath: saveResult!.storagePath,
            liveTranscript: rec.liveTranscript ?? '',
            liveTranscriptRaw: rec.liveTranscriptRaw ?? '',
          })
        }
        // Cloud persistence confirmed → the local fallback copy is now safe to drop.
        await deletePendingUpload(id)
        try {
          const { data } = await supabase.auth.getSession()
          const tok = data.session?.access_token
          if (tok) await requestHostedRecordingAi({ accessToken: tok, recordingId: id })
        } catch {
          /* processing can be started later from the lecture; upload already safe */
        }
        await refreshList()
        // Do not preselect the lecture here. The terminal recovery UI owns the
        // subsequent View lecture action; preselecting the same id makes that
        // action a no-op and skips its fresh detail/audio load.
        setRecentCapture({ kind: 'success', recordingId: id, at: Date.now() })
      } catch (err) {
        await updatePendingUpload(id, {
          state: 'upload_failed',
          lastErrorCategory: sanitizeUploadErrorCategory(err),
          attempts: (rec.attempts ?? 1) + 1,
          updatedAt: Date.now(),
        })
        await refreshList()
      }
    },
    [localOnly, supabase, userId, refreshList],
  )

  const handleDeletePendingUpload = useCallback(
    async (id: string) => {
      const ok = window.confirm(
        'Delete this recording?\n\nThis is the only copy, saved on this device — it has NOT been uploaded to the cloud. Deleting permanently removes the audio and cannot be undone.',
      )
      if (!ok) return
      await deletePendingUpload(id)
      await refreshList()
    },
    [refreshList],
  )

  const [draggingRecordingId, setDraggingRecordingId] = useState<string | null>(null)
  const [dropTargetFolderId, setDropTargetFolderId] = useState<LibraryDropId | null>(null)
  const [dragOverlayRecordingId, setDragOverlayRecordingId] = useState<string | null>(null)
  const fileExplorerScrollRef = useRef<HTMLDivElement | null>(null)
  const suppressItemClickRef = useRef(false)

  const lectureLocationFor = useCallback(
    (recordingId: string): string => libraryLectureLocation[recordingId] ?? 'unfiled',
    [libraryLectureLocation],
  )

  /**
   * The active library.
   *
   * `recordings` already excludes anything the cloud reports as deleted, so
   * this only has to settle the remaining question: does the legacy
   * device-local registry still get a vote? It does not, once the cloud can
   * answer — see `lectureDeletionResolution`.
   */
  const recordingsInLibrary = useMemo(() => {
    if (localOnly) return recordings
    if (!userId) return recordings
    const trashed = new Set(Object.keys(cloudTrash))
    return recordings.filter((r) =>
      isLectureActive({
        cloudDeletedAt: r.deletedAt,
        inLegacyTrash: trashed.has(r.id),
        cloudDeletionAvailable,
      }),
    )
  }, [recordings, cloudTrash, cloudDeletionAvailable, localOnly, userId])

  const coursesState = useCourses({
    supabase: supabase ?? null,
    userId: userId ?? null,
    localOnly,
    recordings: recordingsInLibrary,
  })

  const handleAssignPendingUploadCourse = useCallback(
    async (id: string, courseId: string) => {
      const selectedCourse = coursesState.courses.find((item) => item.id === courseId)
      if (!selectedCourse) return
      await updatePendingUpload(id, { course: selectedCourse.name, courseId: selectedCourse.id, updatedAt: Date.now() })
      await refreshList()
    },
    [coursesState.courses, refreshList],
  )

  const cloudLibraryRouteKey =
    !localOnly && userId && workspaceView === 'courses'
      ? `${userId}:${openCourseId ?? 'grid'}`
      : null
  const cloudLibraryRefresh = useCloudLibraryRefresh({
    enabled: !localOnly && Boolean(supabase && userId),
    sessionKey: userId ?? null,
    routeKey: cloudLibraryRouteKey,
    refreshCourses: coursesState.refresh,
    refreshRecordings: refreshList,
  })
  useCloudLibraryRealtime({
    enabled: !localOnly && Boolean(supabase && userId),
    supabase: supabase ?? null,
    userId: userId ?? null,
    refreshNow: cloudLibraryRefresh.refreshForRealtime,
  })
  const openCourse = useMemo(
    () => coursesState.courses.find((c) => c.id === openCourseId) ?? null,
    [coursesState.courses, openCourseId],
  )
  const dialogCourse = useMemo(
    () =>
      courseDialog && courseDialog.kind !== 'create'
        ? (coursesState.courses.find((c) => c.id === courseDialog.courseId) ?? null)
        : null,
    [courseDialog, coursesState.courses],
  )
  /** Status shown on a lecture row, derived from the real AI job state. */
  const lectureStatusOf = useCallback(
    (recording: Recording): LectureStatus =>
      // Audio persistence is the readiness boundary. AI is enrichment and must
      // never make a saved lecture look unavailable.
      recording.storagePath || recording.durationSec > 0
        ? 'Ready'
        : recording.aiStatus === 'failed'
          ? 'Failed'
          : 'Processing',
    [],
  )

  /**
   * Open the EXISTING production Lecture Detail for one recording.
   *
   * Every piece of state the current detail reads is set here, in one place:
   *
   *   · `selectedId` — the effect at the top of this component loads
   *     `RecordingDetail` (transcript, summary status, storage path) from it,
   *     and `audioUrl` is derived from that row, so the player follows.
   *   · `detail` is cleared FIRST. The loader only assigns on resolve, so
   *     without this the previous lecture's transcript and audio stay on screen
   *     until the new row arrives — a visible stale-lecture flash.
   *   · `workspaceView` must leave `courses`, or the V2 course grid keeps
   *     rendering and the detail is never reached. That was Failure D.
   *
   * A lecture that is no longer in the library (deleted into Recently Deleted)
   * is refused rather than opened onto a row that no longer exists.
   */
  const openLectureDetail = useCallback(
    (recordingId: string) => {
      if (!recordingsInLibrary.some((r) => r.id === recordingId)) return
      setDetail(null)
      setSelectedId(recordingId)
      setLibraryPickedIds([])
      setLibraryPickMode(false)
      setWorkspaceView('lecture')
    },
    [recordingsInLibrary],
  )

  /* ── Recently Deleted V2 ──────────────────────────────────────────────────
     Deleted COURSES and deleted LECTURES are both real cloud rows now, each
     carrying `deleted_at` + `deletion_updated_at`, so this screen shows the
     account's deletions rather than this Mac's. Local-only mode reads the
     IndexedDB trash store; the localStorage registry survives only for a
     database with no deletion columns. */
  const deletedLectures = useMemo(() => {
    const fallback = tDesktop('recording.untitled')
    if (localOnly) return deletedLecturesFromLocalRows(localTrashRows, fallback)
    if (cloudDeletionAvailable) return deletedLecturesFromCloudRows(cloudDeletedLectures, fallback)
    return deletedLecturesFromRegistry(cloudTrash, fallback)
  }, [localOnly, localTrashRows, cloudDeletionAvailable, cloudDeletedLectures, cloudTrash, tDesktop])
  const recentlyDeletedTotal = recentlyDeletedCount(coursesState.deletedCourses, deletedLectures)

  /**
   * The lecture the detail view is showing.
   *
   * Taken from the LIST row, not from `detail`: the row is already in memory,
   * so the header renders immediately with the right title, course and
   * duration while the transcript and summaries load. Falling back to `detail`
   * covers the moment a row has left the list but its detail is still open.
   */
  const openLecture = useMemo(
    () =>
      selectedId
        ? (recordingsInLibrary.find((r) => r.id === selectedId) ??
          (detail?.id === selectedId ? detail : null))
        : null,
    [selectedId, recordingsInLibrary, detail],
  )
  const openLectureCourse = useMemo(
    () => (openLecture ? findCourseForRecording(openLecture, coursesState.courses) : null),
    [openLecture, coursesState.courses],
  )

  const dialogLecture = useMemo(
    () =>
      lectureDialog
        ? (recordingsInLibrary.find((r) => r.id === lectureDialog.recordingId) ?? null)
        : null,
    [lectureDialog, recordingsInLibrary],
  )
  const dialogLectureCourse = useMemo(
    () => (dialogLecture ? findCourseForRecording(dialogLecture, coursesState.courses) : null),
    [dialogLecture, coursesState.courses],
  )

  const purgeCourse = useMemo(
    () =>
      purgeDialog?.kind === 'course'
        ? (coursesState.deletedCourses.find((c) => c.id === purgeDialog.courseId) ?? null)
        : null,
    [purgeDialog, coursesState.deletedCourses],
  )
  const purgeLecture = useMemo(
    () =>
      purgeDialog?.kind === 'lecture'
        ? (deletedLectures.find((row) => row.id === purgeDialog.lectureId) ?? null)
        : null,
    [purgeDialog, deletedLectures],
  )

  /* ── The recording flow's own stage ───────────────────────────────────────
     Derived from state that already exists — the flow reducer, the save/AI
     outcome records, the saved row and the durable-session list. Nothing here
     starts, stops, retries or uploads; it only decides which screen is shown. */
  const savedRecording = useMemo(() => {
    const id = recentCapture?.recordingId ?? null
    if (!id) return null
    const row = recordings.find((r) => r.id === id) ?? (detail?.id === id ? detail : null)
    if (!row) return null
    return {
      transcriptReady: Boolean(row.transcriptReady || row.aiStatus === 'transcript_ready' || row.aiStatus === 'done'),
      summaryReady: row.aiStatus === 'done',
    }
  }, [recentCapture, recordings, detail])

  const recordingStage = resolveRecordingV2Stage({
    recorderStatus: recorder.status as 'idle' | 'recording' | 'paused',
    flowPhase: flow.phase,
    recentCapture,
    recentAi,
    saved: savedRecording,
    // Recovery is the EXISTING durable-session prompt. This only reports that
    // it is pending; the existing handlers still own Save / Keep / Delete.
    recoveryPending: recoveredSessions.length > 0 && recorder.status === 'idle' && flow.phase === 'idle',
  })

  /**
   * The canonical Course row behind Record Home's current selection, looked up
   * by `recordingCourseId` first and only falling back to a name match for a
   * selection that predates Phase 1B. This is the single source of truth for
   * what Record Home may call "selected" — never the raw `course` string on
   * its own, which can otherwise go stale (a rename, delete, or an app launch
   * that starts from a hardcoded default with no real row behind it at all).
   */
  const selectedCourseRecord = useMemo(
    () => findCourseForRecording({ course, courseId: recordingCourseId }, coursesState.courses),
    [course, recordingCourseId, coursesState.courses],
  )

  /** The identity of the course currently selected on Record Home. */
  const activeCourseIdentity = useMemo(() => courseIdentity(selectedCourseRecord), [selectedCourseRecord])

  const selectedRecoverySession = useMemo(
    () => recoveredSessions.find((session) => session.id === selectedRecoverySessionId) ?? null,
    [recoveredSessions, selectedRecoverySessionId],
  )
  const selectedRecoveryCourse = useMemo(
    () => selectedRecoverySession?.courseId
      ? coursesState.courses.find((item) => item.id === selectedRecoverySession.courseId) ?? null
      : null,
    [selectedRecoverySession, coursesState.courses],
  )
  const recoveryNeedsCourseChoice = Boolean(selectedRecoverySession && !selectedRecoverySession.courseId)
  const recordingHeaderCourseName = recordingStage === 'recovery_required'
    ? (selectedRecoveryCourse?.name ?? (recoveryNeedsCourseChoice ? 'Choose course' : (selectedRecoverySession?.course?.trim() || 'Course unavailable')))
    : (course.trim() || tDesktop('record.unfiled'))
  const recordingHeaderCourseIdentity = recordingStage === 'recovery_required'
    ? courseIdentity(selectedRecoveryCourse)
    : activeCourseIdentity

  /**
   * Reconciles the Record Home selection against the live course list once it
   * has actually loaded (never while `coursesState.loading` is true — a still-
   * empty list mid-fetch is not evidence the selected course is gone).
   *
   * A found row wins outright: its canonical `id`/`name` replace whatever is
   * currently held, so a rename or a stale/legacy selection self-heals without
   * a separate string-matching patch, and an already-valid selection is never
   * displaced by this effect. With no match, Record Home always points at a
   * real course when one exists: `coursesState.courses[0]` — the same
   * canonical order Courses/Course Detail already render — is adopted instead
   * of falling back to Unfiled. Only a genuinely empty course list clears the
   * selection.
   */
  useEffect(() => {
    if (coursesState.loading) return
    const decision = reconcileCourseSelection(
      { course, courseId: recordingCourseId },
      selectedCourseRecord,
      coursesState.courses,
    )
    if (decision.action === 'adopt') {
      setRecordingCourseId(decision.id)
      setCourse(decision.name)
    } else if (decision.action === 'clear') {
      setRecordingCourseId(null)
      setCourse('')
    }
  }, [coursesState.loading, selectedCourseRecord, coursesState.courses, recordingCourseId, course])

  const unfiledRecordings = useMemo(
    () =>
      recordingsInLibrary
        .filter((r) => lectureLocationFor(r.id) === 'unfiled')
        .sort((a, b) => b.createdAt - a.createdAt),
    [recordingsInLibrary, lectureLocationFor],
  )

  const folderRecordingsMap = useMemo(() => {
    const out: Record<string, Recording[]> = {}
    for (const f of libraryFolders) out[f.id] = []
    for (const r of recordingsInLibrary) {
      const loc = lectureLocationFor(r.id)
      if (loc !== 'unfiled' && out[loc]) out[loc].push(r)
    }
    for (const id of Object.keys(out)) {
      out[id].sort((a, b) => b.createdAt - a.createdAt)
    }
    return out
  }, [libraryFolders, recordingsInLibrary, lectureLocationFor])

  const recordingIdsInActiveScopeOrdered = useCallback((): string[] => {
    return getScopedRecordingIds(
      libraryActiveScope,
      recordingsInLibrary,
      unfiledRecordings,
      folderRecordingsMap,
    )
  }, [libraryActiveScope, recordingsInLibrary, unfiledRecordings, folderRecordingsMap])

  const applyShiftPickRange = useCallback(
    (anchorId: string, targetId: string) => {
      const order = recordingIdsInActiveScopeOrdered()
      const ia = order.indexOf(anchorId)
      const ib = order.indexOf(targetId)
      if (ia < 0 || ib < 0) return
      const lo = Math.min(ia, ib)
      const hi = Math.max(ia, ib)
      const range = order.slice(lo, hi + 1)
      setLibraryPickedIds((prev) => Array.from(new Set([...prev, ...range])))
    },
    [recordingIdsInActiveScopeOrdered],
  )

  const handleLectureRowClick = useCallback(
    (recordingId: string) => (e: MouseEvent<HTMLButtonElement>) => {
      // DnD-kit can briefly suppress click events after dragging. In pick mode,
      // we never want that to prevent selection toggling.
      if (suppressItemClickRef.current && !libraryPickMode) return
      if (libraryPickMode) {
        setLibraryPickedIds((prev) =>
          prev.includes(recordingId) ? prev.filter((x) => x !== recordingId) : [...prev, recordingId],
        )
        libraryShiftAnchorRef.current = recordingId
        return
      }
      if (e.shiftKey && libraryShiftAnchorRef.current) {
        e.preventDefault()
        applyShiftPickRange(libraryShiftAnchorRef.current, recordingId)
        return
      }
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault()
        setLibraryPickedIds((prev) =>
          prev.includes(recordingId) ? prev.filter((x) => x !== recordingId) : [...prev, recordingId],
        )
        libraryShiftAnchorRef.current = recordingId
        return
      }
      setLibraryPickedIds([])
      setLibraryPickMode(false)
      setSelectedId(recordingId)
      libraryShiftAnchorRef.current = recordingId
    },
    [applyShiftPickRange, libraryPickMode],
  )

  useEffect(() => {
    void refreshList()
  }, [refreshList])

  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      setAudioUrl(null)
      setAudioLoadError(null)
      setDetailLoadFailed(false)
      return
    }
    let cancelled = false
    setAudioUrl(null)
    setAudioLoadError(null)
    setDetailLoadFailed(false)
    void (async () => {
      try {
        if (localOnly) {
          const row = await getRecordingDetailLocal(selectedId)
          if (!cancelled) {
            setDetail(row)
            setAudioUrl(row?.audioUrl ?? null)
          }
          return
        }

        // The list is already refreshed before Save reports success (see
        // handleStopAndSave / refreshList), so a freshly saved recording's
        // canonical row — storagePath included — is already sitting in
        // `recordingsInLibrary` by the time this effect can possibly run.
        // Using it directly skips a redundant single-row re-fetch that raced
        // the just-completed INSERT often enough to matter in practice: a
        // null result from that race used to be swallowed silently
        // (`if (!row) return`), leaving the audio section on "Loading
        // audio…" forever with no error and no Retry — the exact "new
        // lecture never becomes playable" Owner QA report.
        const cachedRow = recordingsRef.current.find((r) => r.id === selectedId)
        let row: RecordingDetail | null =
          cachedRow?.storagePath ? { ...cachedRow, storagePath: cachedRow.storagePath } : null

        if (!row) {
          // Render the lecture row first. Storage signing is independent and
          // may be slow or fail; it must never keep the whole lecture in
          // Loading. The row fetch itself is bounded too — a stalled/queued
          // request here (e.g. contention with the background AI-status
          // poll) must reach the same failure/Retry path below rather than
          // leaving the audio section on "Loading audio…" with no way out.
          row = await withTimeout(
            getRecordingDetail(supabase!, userId!, selectedId, { signAudio: false }),
            SAVE_META_TIMEOUT_MS,
            'Load lecture detail',
          )
        }
        if (cancelled) return
        if (!row) {
          // Genuinely not found (or a still-propagating write a manual Retry
          // can recover from) — a real terminal failure, never a silent
          // forever-Loading with no way out.
          setDetailLoadFailed(true)
          return
        }
        setDetail(row)
        try {
          const signed = await withTimeout(
            getRecordingAudioUrl(supabase!, row.storagePath),
            SAVE_META_TIMEOUT_MS,
            'Load audio playback',
          )
          if (!cancelled) setAudioUrl(signed)
        } catch (error) {
          if (!cancelled) setAudioLoadError(error instanceof Error ? error.message : 'Audio could not load')
        }
      } catch {
        // The row fetch itself failed — not the same as a row with no
        // summary/transcript yet. `detailLoadFailed` is how the detail page
        // tells those two apart instead of showing "not generated yet" for a
        // network or backend failure.
        if (!cancelled) {
          setDetail(null)
          setDetailLoadFailed(true)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedId, supabase, userId, localOnly, detailRetryNonce])

  const retryAudioLoad = useCallback(() => {
    if (localOnly || !detail || !supabase) return
    setAudioUrl(null)
    setAudioLoadError(null)
    void withTimeout(getRecordingAudioUrl(supabase, detail.storagePath), SAVE_META_TIMEOUT_MS, 'Load audio playback')
      .then(setAudioUrl)
      .catch((error) => setAudioLoadError(error instanceof Error ? error.message : 'Audio could not load'))
  }, [localOnly, detail, supabase])

  useEffect(() => {
    if (!selectedId) return
    if (!recordingsInLibrary.some((r) => r.id === selectedId)) {
      setSelectedId(null)
      setDetail(null)
    }
  }, [recordingsInLibrary, selectedId])

  useEffect(() => {
    if (!selectedId) hostedAiPollStartedAtRef.current = null
  }, [selectedId])

  useEffect(() => {
    if (localOnly || !usesHosted || !selectedId || !supabase || !userId) return
    const st = detail?.aiStatus
    if (!st || !['queued', 'transcribing', 'summarizing', 'transcript_ready'].includes(st)) {
      hostedAiPollStartedAtRef.current = null
      return
    }
    if (hostedAiPollStartedAtRef.current === null) {
      hostedAiPollStartedAtRef.current = Date.now()
    }

    const id = window.setInterval(() => {
      void (async () => {
        try {
          const started = hostedAiPollStartedAtRef.current
          if (started !== null && Date.now() - started > HOSTED_AI_POLL_MAX_MS) {
            window.clearInterval(id)
            hostedAiPollStartedAtRef.current = null
            const next = await getRecordingDetail(supabase, userId, selectedId)
            if (next) setDetail(next)
            await refreshList()
            return
          }
          const next = await getRecordingDetail(supabase, userId, selectedId)
          if (next) setDetail(next)
          await refreshList()
        } catch {
          /* ignore */
        }
      })()
    }, 2800)
    return () => clearInterval(id)
  }, [localOnly, usesHosted, selectedId, supabase, userId, detail?.aiStatus, refreshList])

  // Phase 2D-4: detect unfinished durable recording sessions on startup / owner change.
  // Never auto-resume mic, never auto-upload — user chooses Save / Keep / Delete.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const ownerKey = ownerKeyForUser(userId, Boolean(localOnly))
        const sessions = await listRecoverableRecordingSessions(ownerKey)
        if (!cancelled) setRecoveredSessions(sessions)
      } catch {
        if (!cancelled) setRecoveredSessions([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [userId, localOnly])

  const startRecording = (sessionContext?: { course?: string; courseId?: string | null; title?: string }) => {
    if (!localOnly && usesHosted) {
      void refreshHostedHealth()
    }
    dispatchFlow({ type: 'LIVE_START' })
    // T0 for the latency chain: everything downstream is measured from here.
    resetLatencyDiagnostics()
    markSpeechOnset()
    liveCaptionSessionIdRef.current = crypto.randomUUID()
    youmiLiveLog('emit', 'Start pressed: new live session', {
      sessionSuffix: liveCaptionSessionIdRef.current.slice(-12),
      livePipelineEnabled: liveCaptionsPipelineEnabled,
      usesHosted,
      localOnly: Boolean(localOnly),
    })
    liveChunkIndexRef.current = 0
    youmiLiveBatchPartsRef.current = []
    youmiLiveBatchBytesRef.current = 0
    youmiLiveBatchMimeRef.current = ''
    youmiLiveBatchStartedAtRef.current = null
    youmiLiveWarmupBatchesSentRef.current = 0
    if (youmiLiveBatchFlushTimerRef.current) {
      clearTimeout(youmiLiveBatchFlushTimerRef.current)
      youmiLiveBatchFlushTimerRef.current = null
    }
    resetLiveTranscribeRuntime()
    lastFinalTimestampRef.current = 0
    setLiveCaptionChunkNotice(null)
    resetLiveCaptionSessionUi()
    if (typeof document !== 'undefined') {
      document.documentElement.lang = liveLang
    }
    void recorder.start(sessionContext)
  }

  const discardRecording = () => {
    dispatchFlow({ type: 'LIVE_DISCARD' })
    liveCaptionSessionIdRef.current = null
    youmiLiveBatchPartsRef.current = []
    youmiLiveBatchBytesRef.current = 0
    youmiLiveBatchMimeRef.current = ''
    youmiLiveBatchStartedAtRef.current = null
    youmiLiveWarmupBatchesSentRef.current = 0
    if (youmiLiveBatchFlushTimerRef.current) {
      clearTimeout(youmiLiveBatchFlushTimerRef.current)
      youmiLiveBatchFlushTimerRef.current = null
    }
    recorder.cancel()
    resetLiveTranscribeRuntime()
    lastFinalTimestampRef.current = 0
    setLiveCaptionChunkNotice(null)
    resetLiveCaptionSessionUi()
  }

  const pauseRecording = () => {
    dispatchFlow({ type: 'LIVE_PAUSE' })
    recorder.pause()
  }

  const resumeRecording = () => {
    dispatchFlow({ type: 'LIVE_RESUME' })
    recorder.resume()
  }

  const endCapture = useCallback((outcome: RecentCaptureOutcome) => {
    setRecentCapture(outcome)
    dispatchFlow({ type: 'CAPTURE_FINISHED' })
  }, [])

  const formatRecoveryDuration = (sec: number) => {
    const s = Math.max(0, Math.floor(sec))
    const m = Math.floor(s / 60)
    const r = s % 60
    return m > 0 ? `${m}m ${r}s` : `${r}s`
  }

  const handleRecoverSave = useCallback(
    async (session: RecordingSessionMeta) => {
      if (recoveryBusyId || saveInFlightRef.current) return
      if (recorder.status === 'recording' || recorder.status === 'paused') return
      // Re-read the durable session instead of trusting the React-closure
      // argument: `session` can be a snapshot from an earlier render (e.g. the
      // moment just before a course was assigned via the picker), and this
      // save must never write a stale/blank course identity just because a
      // click landed a render behind. The IndexedDB row is the one place a
      // just-assigned courseId is guaranteed current.
      const fresh = await getRecordingSession(session.id)
      if (!fresh) {
        endCapture({ kind: 'failure', recordingId: session.id, outcome: 'other', message: 'This recovered recording is no longer available.', at: Date.now() })
        return
      }
      // Do not mutate the durable state until a Course is known. Legacy
      // sessions remain recoverable while the user chooses one explicitly.
      if (!fresh.courseId) {
        endCapture({ kind: 'failure', recordingId: fresh.id, outcome: 'other', message: 'Choose a course before saving this recovered recording.', at: Date.now() })
        return
      }
      setRecoveryBusyId(fresh.id)
      saveInFlightRef.current = true
      dispatchFlow({ type: 'CAPTURE_BEGIN', recordingId: fresh.id })
      try {
        const fin = await beginFinalizeRecordingSession(fresh.id)
        if (fin.action === 'already_done') {
          setRecoveredSessions((prev) => prev.filter((s) => s.id !== fresh.id))
          endCapture({
            kind: 'list_refresh_warn',
            recordingId: fresh.id,
            message: 'This recording was already saved. Check Recent or Pending uploads.',
            at: Date.now(),
          })
          return
        }
        if (fin.action !== 'proceed' || !fin.assembled) {
          endCapture({
            kind: 'failure',
            recordingId: fresh.id,
            outcome: 'other',
            message: 'Could not recover this recording (no usable audio). You can Keep for later or Delete.',
            at: Date.now(),
          })
          return
        }
        const { blob, mime } = fin.assembled
        const courseVal = fresh.course?.trim() || 'Course'
        const recoveryCourseId = fresh.courseId
        const titleVal = fresh.title?.trim() || `Lecture ${formatDate(fresh.startedAt)}`
        // The 15s heartbeat may never fire before a quick crash, leaving
        // `approxDurationSec` at (or near) 0 even though several 5-second
        // checkpoints of real audio were durably persisted — the exact "only
        // a small portion recovered" symptom, when in fact the chunks (and
        // the assembled blob) hold much more than the heartbeat ever saw.
        // A chunk-count floor is heartbeat-independent and always at least
        // as accurate as the last heartbeat.
        const durationSec = Math.max(
          fresh.approxDurationSec || 0,
          Math.round((fresh.chunkCount * MAIN_RECORDER_REQUEST_DATA_MS) / 1000),
        )
        const recordingId = fresh.id

        if (localOnly) {
          dispatchFlow({ type: 'CAPTURE_UPLOAD' })
          await withTimeout(
            saveRecordingLocal({
              id: recordingId,
              course: courseVal,
              title: titleVal,
              createdAt: fresh.startedAt,
              durationSec,
              mime,
              audioBlob: blob,
            }),
            SAVE_DB_TIMEOUT_MS,
            'Local save (recovered)',
          )
          await completeRecordingSessionPersist(recordingId)
          setRecoveredSessions((prev) => prev.filter((s) => s.id !== recordingId))
          try {
            await refreshList()
          } catch { /* ignore */ }
          endCapture({ kind: 'success', recordingId, at: Date.now() })
          return
        }

        if (!supabase || !userId) {
          endCapture({
            kind: 'failure',
            recordingId,
            outcome: 'other',
            message: 'Sign in to save and process this recovered recording, or Keep for later.',
            at: Date.now(),
          })
          return
        }

        dispatchFlow({ type: 'CAPTURE_UPLOAD' })
        try {
          let saveResult: Awaited<ReturnType<typeof uploadLectureAudioViaServer>> | undefined
          for (let attempt = 1; ; attempt++) {
            try {
              saveResult = await withTimeout(
                uploadLectureAudioViaServer(supabase, recordingId, blob, mime, durationSec, {
                  course: courseVal,
                  // Recovery is a normal lecture save. Keep the canonical id
                  // alongside the legacy label so a recovered lecture cannot
                  // be detached by a course rename or refresh.
                  courseId: recoveryCourseId,
                  title: titleVal,
                  liveTranscript: '',
                  liveTranscriptRaw: '',
                }),
                SAVE_UPLOAD_TIMEOUT_MS,
                'Audio upload (recovered)',
              )
              break
            } catch (attemptErr) {
              const plan = computeUploadRetryPlan(attempt)
              if (!plan.retry || !isTransientUploadError(attemptErr)) throw attemptErr
              await new Promise((r) => window.setTimeout(r, plan.delayMs))
            }
          }
          if (!saveResult!.recording) {
            await withTimeout(
              insertLectureRecordingRow({
                supabase,
                userId,
                id: recordingId,
                course: courseVal,
                courseId: recoveryCourseId,
                title: titleVal,
                durationSec,
                mime,
                storagePath: saveResult!.storagePath,
                liveTranscript: '',
                liveTranscriptRaw: '',
              }),
              SAVE_DB_TIMEOUT_MS,
              'Database write (recovered)',
            )
          }
          await completeRecordingSessionPersist(recordingId)
          setRecoveredSessions((prev) => prev.filter((s) => s.id !== recordingId))
          try {
            await refreshList()
          } catch { /* ignore */ }
          endCapture({ kind: 'success', recordingId, at: Date.now() })
        } catch (upErr) {
          await withTimeout(
            savePendingUpload({
              id: recordingId,
              userId,
              course: courseVal,
              courseId: recoveryCourseId,
              title: titleVal,
              durationSec,
              mime,
              lang: liveLang,
              translateTarget,
              createdAt: fresh.startedAt,
              updatedAt: Date.now(),
              state: 'upload_failed',
              lastErrorCategory: sanitizeUploadErrorCategory(upErr),
              attempts: 1,
              cloudUploaded: false,
              audioBlob: blob,
            }),
            SAVE_DB_TIMEOUT_MS,
            'Preserve recovered upload (pending)',
          )
          await completeRecordingSessionPersist(recordingId)
          setRecoveredSessions((prev) => prev.filter((s) => s.id !== recordingId))
          try {
            await refreshList()
          } catch { /* ignore */ }
          // Not a success: the recording is only local so far, and must not be
          // presented as if it were already in the cloud/Course.
          endCapture({
            kind: 'failure',
            recordingId,
            outcome: 'pending_upload',
            message:
              'Recovered recording is safe on this device, but the cloud upload didn’t finish. Retry when you’re back online — nothing needs to be re-recorded.',
            at: Date.now(),
          })
        }
      } catch (e) {
        endCapture({
          kind: 'failure',
          recordingId: session.id,
          outcome: 'other',
          message: e instanceof Error ? e.message : 'Could not save recovered recording',
          at: Date.now(),
        })
      } finally {
        saveInFlightRef.current = false
        setRecoveryBusyId(null)
        dispatchFlow({ type: 'CAPTURE_FINISHED' })
      }
    },
    [
      recoveryBusyId,
      recorder.status,
      localOnly,
      supabase,
      userId,
      liveLang,
      translateTarget,
      refreshList,
      endCapture,
    ],
  )

  const handleRecoverKeep = useCallback(async (sessionId: string) => {
    await keepRecordingSessionForLater(sessionId)
    setRecoveredSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, status: 'kept' as const } : s)),
    )
  }, [])

  const handleAssignRecoveryCourse = useCallback(async (sessionId: string, courseId: string) => {
    const selectedCourse = coursesState.courses.find((item) => item.id === courseId)
    if (!selectedCourse) return
    const next = await assignRecordingSessionCourse(sessionId, { id: selectedCourse.id, name: selectedCourse.name })
    if (!next) return
    setRecoveredSessions((prev) => prev.map((session) => session.id === sessionId ? next : session))
  }, [coursesState.courses])

  const handleRecoverDelete = useCallback(async (sessionId: string) => {
    if (recoveryDeleteConfirmId !== sessionId) {
      setRecoveryDeleteConfirmId(sessionId)
      return
    }
    await deleteRecordingSession(sessionId)
    setRecoveryDeleteConfirmId(null)
    setRecoveredSessions((prev) => prev.filter((s) => s.id !== sessionId))
  }, [recoveryDeleteConfirmId])

  const handleStopAndSave = async () => {
    if (saveInFlightRef.current) return
    if (recorder.status !== 'recording' && recorder.status !== 'paused') return

    // Phase 2D-4: reuse the durable session UUID created at Start (same id for
    // chunks → pending upload → cloud row). Never mint a second id here.
    const recordingId = recorder.activeSessionId
    if (!recordingId) {
      setRecentCapture({
        kind: 'failure',
        recordingId: 'unknown',
        outcome: 'other',
        message: 'No active recording session was found. Try Start again.',
        at: Date.now(),
      })
      return
    }

    if (!localOnly && userId && !tryAcquireTabSaveLock(recordingId)) {
      setRecentCapture({
        kind: 'failure',
        recordingId,
        outcome: 'other',
        message:
          'Another tab may be saving a recording. Wait for it to finish, or close other Youmi Lens tabs and try again.',
        at: Date.now(),
      })
      return
    }

    saveInFlightRef.current = true
    // One table per run, printed without a debugger attached.
    reportLatencySummary()
    setRecentCapture((prev) => nextRecentCaptureForNewSave(prev))
    dispatchFlow({ type: 'CAPTURE_BEGIN', recordingId })

    const releaseLock = () => {
      if (!localOnly && userId) releaseTabSaveLock(recordingId)
    }

    let liveDrainLatched = false
    try {
      const useLiveDrain =
        useLiveEngineV2 && liveCaptionsPipelineEnabled && usesHosted
      if (useLiveDrain) {
        flushSync(() => {
          setLiveEngineDrainPhase(true)
          liveDrainLatched = true
        })
      }
      traceCaptionStop('stop_click', {
        useLiveDrain,
        ...getEnArrivalWalls(),
      })

      const uiElapsedSecBeforeStop = recorder.elapsedSec
      const { blob, mime, sessionId } = await recorder.stop()
      if (sessionId !== recordingId) {
        console.warn('[capture] session_id_mismatch', JSON.stringify({ recordingId, sessionId }))
      }
      traceCaptionStop('after_recorder_stop', {
        ...getEnArrivalWalls(),
      })
      if (import.meta.env.DEV) {
        console.warn(
          '[MainRec][save]',
          JSON.stringify({
            recordingIdTail: recordingId.slice(-8),
            uiElapsedSec: uiElapsedSecBeforeStop,
            durationSource: 'elapsed_state_before_stop',
            blobBytes: blob.size,
            mime,
            t: Date.now(),
          }),
        )
      }
      const eng = liveEngineRef.current
      if (useLiveDrain && eng) {
        eng.notifyAudioCaptureEnded()
        traceCaptionStop('after_stream_stop_signal', { ...getEnArrivalWalls() })
        await eng.waitAfterCaptureEnd({ minTailMs: 2600, maxMs: 6000 })
        traceCaptionStop('after_drain_wait', { ...getEnArrivalWalls() })
      }
      const drainUntil = Date.now() + 4500
      while (
        Date.now() < drainUntil &&
        (liveTranscribeInFlightRef.current > 0 || liveTranscribeQueueRef.current.length > 0)
      ) {
        await new Promise((r) => window.setTimeout(r, 90))
      }
      const capSnap = useLiveEngineV2 ? liveCaptionSessionRef.current.getView() : null
      const primary = (useLiveEngineV2 ? capSnap!.persistPrimaryFull : primaryCaptionRef.current).trim()
      const secondary = (useLiveEngineV2 ? capSnap!.persistSecondaryFull : secondaryCaption.trim()).trim()
      traceCaptionStop('caption_snapshot', {
        primaryLen: primary.length,
        secondaryLen: secondary.length,
        ...getEnArrivalWalls(),
      })
      if (liveDrainLatched) {
        flushSync(() => {
          setLiveEngineDrainPhase(false)
          liveDrainLatched = false
        })
        traceCaptionStop('drain_phase_off', { ...getEnArrivalWalls() })
      }
      const liveText =
        translateTarget === 'off'
          ? primary
          : [
              `[Track A — speech ${liveLang}]`,
              primary || '(empty)',
              '',
              `[Track B — ${translateTarget === 'zh' ? 'Simplified Chinese' : 'English'}]`,
              secondary || '(empty)',
            ].join('\n')
      const liveTranscriptRaw = liveText
      const { canonical: liveTranscriptCanonical } = canonicalizeLectureTranscript(liveTranscriptRaw)
      // Phase 2D: NO client-side size gate. The full recording is persisted to
      // durable storage (Supabase Storage; server cap 500MB) and transcribed by
      // Paraformer from a signed URL — neither has a 25MB per-file limit, so a
      // 45–120 min lecture saves and processes normally. The old 25MB byte-size
      // guard rejected + DISCARDED the audio here (losing ~20 min / ~57MB
      // lectures) before anything was persisted; that violated "recording must
      // not be lost". Size is a downstream transcription concern (BYOK OpenAI
      // Whisper only), handled after the audio is safely persisted.

      const courseVal = course.trim() || 'Course'
      const titleVal = title.trim() || `Lecture ${formatDate(Date.now())}`
      const durationSec = uiElapsedSecBeforeStop

      if (localOnly) {
        dispatchFlow({ type: 'CAPTURE_UPLOAD' })
        try {
          await withTimeout(
            saveRecordingLocal({
              id: recordingId,
              course: courseVal,
              title: titleVal,
              createdAt: Date.now(),
              durationSec,
              mime,
              audioBlob: blob,
              liveTranscript: liveTranscriptCanonical || undefined,
              liveTranscriptRaw: liveTranscriptRaw || undefined,
            }),
            SAVE_DB_TIMEOUT_MS,
            'Local save (browser storage)',
          )
        } catch (locErr) {
          const inner = locErr instanceof Error ? locErr.message : String(locErr)
          endCapture({
            kind: 'failure',
            recordingId,
            outcome: 'local_failed',
            message: `Local save failed (browser storage): ${inner}`,
            at: Date.now(),
          })
          ledgerClear(recordingId)
          return
        }

        dispatchFlow({ type: 'CAPTURE_VERIFY' })
        let listOk = true
        try {
          await withTimeout(refreshList(), SAVE_LIST_TIMEOUT_MS, 'Refresh recording list')
        } catch {
          listOk = false
        }
        const verified = await withTimeout(
          getRecordingDetailLocal(recordingId),
          SAVE_META_TIMEOUT_MS,
          'Verify saved recording',
        )
        if (!verified) {
          endCapture({
            kind: 'failure',
            recordingId,
            outcome: 'db_ok_verify_failed',
            message:
              'The recording was written locally but could not be verified immediately. Try refreshing or selecting it again in Recent; if it still does not appear, check browser storage permissions.',
            at: Date.now(),
          })
          ledgerClear(recordingId)
          return
        }
        if (listOk) {
          endCapture({ kind: 'success', recordingId, at: Date.now() })
        } else {
          endCapture({
            kind: 'list_refresh_warn',
            recordingId,
            message:
              'The recording was saved locally but refreshing the list timed out or failed. Refresh the page; it should still be in your local library.',
            at: Date.now(),
          })
        }
        void completeRecordingSessionPersist(recordingId).catch(() => { /* best-effort */ })
        ledgerClear(recordingId)
      } else {
        dispatchFlow({ type: 'CAPTURE_UPLOAD' })
        let path: string
        let serverSavedRecording = false
        try {
          // Phase 2D-1: bounded, idempotent auto-retry for transient upload
          // interruptions. The storage path is stable per recording UUID and the
          // DB insert is idempotent, so re-attempting cannot duplicate the lecture
          // or the storage object. Non-transient outcomes are re-thrown to the
          // failure handling below (which preserves the audio locally).
          let saveResult: Awaited<ReturnType<typeof uploadLectureAudioViaServer>> | undefined
          for (let attempt = 1; ; attempt++) {
            try {
              saveResult = await withTimeout(
                uploadLectureAudioViaServer(supabase!, recordingId, blob, mime, durationSec, {
                  course: courseVal,
                  courseId: recordingCourseId,
                  title: titleVal,
                  liveTranscript: liveTranscriptCanonical,
                  liveTranscriptRaw,
                }),
                SAVE_UPLOAD_TIMEOUT_MS,
                'Audio upload',
              )
              break
            } catch (attemptErr) {
              const plan = computeUploadRetryPlan(attempt)
              if (!plan.retry || !isTransientUploadError(attemptErr)) throw attemptErr
              console.warn('[capture] upload_retry', JSON.stringify({ recordingId, attempt, delayMs: plan.delayMs }))
              await new Promise((r) => window.setTimeout(r, plan.delayMs))
            }
          }
          path = saveResult!.storagePath
          serverSavedRecording = Boolean(saveResult!.recording)
        } catch (upErr) {
          const msg =
            upErr instanceof SaveRecordingRemoteError
              ? upErr.message
              : upErr instanceof Error
                ? upErr.message
                : String(upErr)

          if (upErr instanceof SaveRecordingRemoteError && upErr.phase === 'database_insert') {
            endCapture({
              kind: 'failure',
              recordingId,
              outcome: 'storage_ok_db_failed',
              message: `Audio uploaded, but saving the lecture record failed (database). You can try again; upload may be overwritten. Details: ${msg}`,
              at: Date.now(),
            })
            ledgerClear(recordingId)
            return
          }

          // If the recording is too long for cloud processing,
          // fall back to local save so the audio is never lost.
          if (/recording_too_long/i.test(msg) || /recording.*too long|too long.*recording/i.test(msg)) {
            console.warn('[capture] recording_too_long — falling back to local save', JSON.stringify({ recordingId, durationSec }))
            try {
              await withTimeout(
                saveRecordingLocal({
                  id: recordingId,
                  course: courseVal,
                  title: titleVal,
                  createdAt: Date.now(),
                  durationSec,
                  mime,
                  audioBlob: blob,
                  liveTranscript: liveTranscriptCanonical || undefined,
                  liveTranscriptRaw: liveTranscriptRaw || undefined,
                }),
                SAVE_DB_TIMEOUT_MS,
                'Local save fallback',
              )
              endCapture({
                kind: 'list_refresh_warn',
                recordingId,
                message:
                  'Recording saved locally (too long for cloud processing). Free access limit reached. Please contact Youmi Lens for more access.',
                at: Date.now(),
              })
              void completeRecordingSessionPersist(recordingId).catch(() => { /* best-effort */ })
            } catch (locFallbackErr) {
              endCapture({
                kind: 'failure',
                recordingId,
                outcome: 'storage_failed',
                message: 'Free access limit reached. Please contact Youmi Lens for more access.',
                at: Date.now(),
              })
            }
            ledgerClear(recordingId)
            return
          }

          // Phase 2D: upload/storage failed (e.g. network interruption). NEVER
          // discard the audio — fall back to a durable LOCAL save so the lecture
          // is preserved and stays recoverable/retryable without re-recording.
          let friendly = msg
          if (/bucket not found/i.test(msg)) {
            friendly =
              'Storage bucket missing: in Supabase go to Storage → New bucket, name it exactly lecture-audio, keep it private. Or run the SQL in project file supabase-setup.sql (creates bucket + RLS). Then try Stop & save again.'
          }
          try {
            // Phase 2D-2: preserve as a DURABLE, per-user PENDING UPLOAD (keyed by
            // the stable recording UUID + authenticated userId). It survives app
            // restart and has a real Retry action right on this screen — no
            // re-recording, no data loss. Not yet in the cloud or any Course, so
            // this must render as an actionable failure below, never a success.
            await withTimeout(
              savePendingUpload({
                id: recordingId,
                userId: userId!,
                course: courseVal,
                courseId: recordingCourseId,
                title: titleVal,
                durationSec,
                mime,
                lang: liveLang,
                translateTarget,
                liveTranscript: liveTranscriptCanonical || undefined,
                liveTranscriptRaw: liveTranscriptRaw || undefined,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                state: 'upload_failed',
                lastErrorCategory: sanitizeUploadErrorCategory(upErr),
                attempts: 1,
                cloudUploaded: false,
                audioBlob: blob,
              }),
              SAVE_DB_TIMEOUT_MS,
              'Preserve failed upload (pending)',
            )
            console.warn('[capture] upload_failed_pending_saved', JSON.stringify({ recordingId, durationSec, category: sanitizeUploadErrorCategory(upErr) }))
            // Pending upload row now holds the durable blob — safe to drop session chunks.
            void completeRecordingSessionPersist(recordingId).catch(() => { /* best-effort */ })
            try {
              await refreshList()
            } catch {
              /* best-effort refresh */
            }
            endCapture({
              kind: 'failure',
              recordingId,
              outcome: 'pending_upload',
              message:
                'Your recording is safe — the audio is saved on this device and nothing was lost. The upload to the cloud didn’t finish. Tap Retry Save below when you’re back online — no need to re-record.',
              at: Date.now(),
            })
          } catch {
            endCapture({
              kind: 'failure',
              recordingId,
              outcome: 'storage_failed',
              message: friendly,
              at: Date.now(),
            })
          }
          ledgerClear(recordingId)
          return
        }
        ledgerMarkUploaded(recordingId, userId!, path)

        if (!serverSavedRecording) {
          dispatchFlow({ type: 'CAPTURE_DB' })
          try {
            await withTimeout(
              insertLectureRecordingRow({
                supabase: supabase!,
                userId: userId!,
                id: recordingId,
                course: courseVal,
                courseId: recordingCourseId,
                title: titleVal,
                durationSec,
                mime,
                storagePath: path,
                liveTranscript: liveTranscriptCanonical,
                liveTranscriptRaw,
              }),
              SAVE_DB_TIMEOUT_MS,
              'Database write',
            )
          } catch (dbErr) {
            const msg =
              dbErr instanceof SaveRecordingRemoteError
                ? dbErr.message
                : dbErr instanceof Error
                  ? dbErr.message
                  : String(dbErr)
            endCapture({
              kind: 'failure',
              recordingId,
              outcome: 'storage_ok_db_failed',
              message: `Audio uploaded, but saving the lecture record failed (database). You can try again; upload may be overwritten. Details: ${msg}`,
              at: Date.now(),
            })
            ledgerClear(recordingId)
            return
          }
        }
        ledgerMarkDbCommitted(recordingId, userId!)

        dispatchFlow({ type: 'CAPTURE_VERIFY' })
        let listOk = true
        try {
          await withTimeout(refreshList(), SAVE_LIST_TIMEOUT_MS, 'Refresh recording list')
        } catch {
          listOk = false
        }

        const meta = await withTimeout(
          getRecordingMetaWithRetry(supabase!, userId!, recordingId),
          25_000,
          'Confirm recording in database',
        )

        if (!meta) {
          endCapture({
            kind: 'failure',
            recordingId,
            outcome: 'db_ok_verify_failed',
            message:
              'The recording was written to the cloud but could not be confirmed after retries (network or permissions delay). Refresh and check Recent; avoid deleting audio if duplicate rows appear.',
            at: Date.now(),
          })
          ledgerClear(recordingId)
          return
        }

        if (listOk) {
          endCapture({ kind: 'success', recordingId, at: Date.now() })
        } else {
          endCapture({
            kind: 'list_refresh_warn',
            recordingId,
            message:
              'The recording was saved to the cloud but refreshing the list timed out or failed. Refresh the page; it should still be in the database.',
            at: Date.now(),
          })
        }

        void completeRecordingSessionPersist(recordingId).catch(() => { /* best-effort */ })
        ledgerClear(recordingId)
      }

      lastFinalTimestampRef.current = 0
      setLiveCaptionChunkNotice(null)
      resetLiveCaptionSessionUi()
      // The saved-result screen owns the transition into Lecture Detail. Do
      // not preselect this id here: doing so starts a hidden detail/audio load
      // before the user presses “View lecture”. That loader can be cancelled
      // by the save-result transition, while the later opener receives the
      // same id and therefore has no dependency change with which to retry.
      // `openLectureDetail` selects it at the point the detail actually opens.
      setTitle('')
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not save recording'
      let friendly = msg
      if (/bucket not found/i.test(msg)) {
        friendly =
          'Storage bucket missing: in Supabase go to Storage → New bucket, name it exactly lecture-audio, keep it private. Or run the SQL in project file supabase-setup.sql (creates bucket + RLS). Then try Stop & save again.'
      }
      endCapture({
        kind: 'failure',
        recordingId,
        outcome: 'other',
        message: e instanceof AsyncTimeoutError ? e.message : friendly,
        at: Date.now(),
      })
      ledgerClear(recordingId)
    } finally {
      if (liveDrainLatched) {
        flushSync(() => {
          setLiveEngineDrainPhase(false)
        })
        traceCaptionStop('drain_phase_off_error_path', { ...getEnArrivalWalls() })
      }
      saveInFlightRef.current = false
      releaseLock()
    }
  }

  const runTranscribeAndSummarize = async () => {
    if (!detail) return
    if (transcribeActionLockRef.current) return

    if (!localOnly && usesHosted) {
      if (!hostedConfigured && !stubMode) {
        setRecentAi({
          kind: 'other',
          recordingId: detail.id,
          message: 'Youmi AI setup is not available yet. Try again later or use Advanced mode.',
          at: Date.now(),
        })
        return
      }
      if (!supabase || !userId) return
    } else {
      if (!byokReady) {
        setRecentAi({
          kind: 'other',
          recordingId: detail.id,
          message:
            'Open Account to use Youmi AI or configure advanced options with your own key.',
          at: Date.now(),
        })
        dispatchFlow({ type: 'AI_ERROR', recordingSaved: true })
        return
      }
      if (!usesHosted && !BYOK_PROVIDER_CAPABILITIES[getByokProvider()].transcribe) {
        setRecentAi({
          kind: 'other',
          recordingId: detail.id,
          message:
            'Speech-to-text is not available with your current advanced key setup. Open Account to change the connection type or switch to Youmi AI.',
          at: Date.now(),
        })
        dispatchFlow({ type: 'AI_ERROR', recordingSaved: true })
        return
      }
    }

    transcribeActionLockRef.current = true
    flushSync(() => {
      setTranscribeSubmitPending(true)
    })

    try {
      if (!localOnly && usesHosted) {
        const { data: sess } = await supabase!.auth.getSession()
        const tok = sess.session?.access_token
        if (!tok) {
          setRecentAi({
            kind: 'other',
            recordingId: detail.id,
            message: 'Sign in again to process recordings.',
            at: Date.now(),
          })
          return
        }
        setRecentAi(null)
        const out = await requestHostedRecordingAi({ accessToken: tok, recordingId: detail.id })
        if (!out.ok) {
          console.warn('[process-recording] save error', JSON.stringify({ recordingId: detail.id, message: out.message, debug: out.debug }))
          setRecentAi({
            kind: 'other',
            recordingId: detail.id,
            message: out.message,
            at: Date.now(),
          })
          return
        }
        console.warn('[process-recording] save start', JSON.stringify({ recordingId: detail.id, note: 'refresh_detail_after_enqueue' }))
        try {
          const next = await withTimeout(
            getRecordingDetail(supabase!, userId!, detail.id),
            SAVE_META_TIMEOUT_MS,
            'Refresh recording',
          )
          if (next) setDetail(next)
          await refreshList()
          console.warn('[process-recording] refresh_ok', JSON.stringify({ recordingId: detail.id }))
        } catch (e) {
          console.warn('[process-recording] refresh_error', JSON.stringify({ recordingId: detail.id, message: e instanceof Error ? e.message : String(e) }))
          /* polling will refresh */
        }
        return
      }

      setRecentAi(null)
      flushSync(() => {
        dispatchFlow({ type: 'AI_START', recordingId: detail.id })
      })

      const blob = localOnly
        ? await (async () => {
            const r = await getRecordingWithBlob(detail.id)
            if (!r?.audioBlob) {
              throw new Error('Recording or audio blob not found in local storage.')
            }
            return r.audioBlob
          })()
        : await withTimeout(
            downloadRecordingBlob(supabase!, detail.storagePath),
            AI_DOWNLOAD_TIMEOUT_MS,
            'Download audio for transcription',
          )
      const ext =
        detail.mime.includes('webm') ? 'webm' : detail.mime.includes('mp4') ? 'm4a' : 'audio'

      let transcript: string
      try {
        transcript = await withTimeout(
          transcribeRecording(blob, `lecture.${ext}`, {}),
          AI_TRANSCRIBE_TIMEOUT_MS,
          'Speech transcription',
        )
      } catch (txErr) {
        console.warn('[transcribe]', txErr)
        setRecentAi(
          aiOutcomeToRecent(
            'transcribe_failed',
            detail.id,
            userFacingTranscribeFailure(),
          ),
        )
        dispatchFlow({ type: 'AI_ERROR', recordingSaved: true })
        return
      }

      const transcriptRaw = transcript
      const { canonical: transcriptCanon } = canonicalizeLectureTranscript(transcriptRaw)

      dispatchFlow({ type: 'AI_SUMMARIZE' })
      let summaryEn: string
      let summaryZh: string
      try {
        const sums = await withTimeout(
          summarizeRecording(transcriptCanon, { course: detail.course, title: detail.title }),
          AI_SUMMARIZE_TIMEOUT_MS,
          'Bilingual summary',
        )
        summaryEn = sums.summaryEn
        summaryZh = sums.summaryZh
      } catch (sumErr) {
        console.warn('[summarize]', sumErr)
        try {
          if (localOnly) {
            await withTimeout(
              updateRecordingLocal(detail.id, {
                transcript: transcriptCanon,
                transcriptRaw,
              }),
              AI_PERSIST_TIMEOUT_MS,
              'Save transcript locally',
            )
          } else {
            await withTimeout(
              updateRecordingAi(supabase!, userId!, detail.id, {
                transcript: transcriptCanon,
                transcriptRaw,
              }),
              AI_PERSIST_TIMEOUT_MS,
              'Save transcript to database',
            )
          }
        } catch (persistErr) {
          console.warn('[summarize + persist]', sumErr, persistErr)
          setRecentAi(
            aiOutcomeToRecent(
              'persist_failed',
              detail.id,
              'We could not save your transcript after this step. Try Transcribe & summarize again, or contact support if it continues.',
            ),
          )
          dispatchFlow({ type: 'AI_ERROR', recordingSaved: true })
          return
        }
        const next = localOnly
          ? await getRecordingDetailLocal(detail.id)
          : await getRecordingDetail(supabase!, userId!, detail.id)
        setDetail(next)
        await refreshList()
        setRecentAi(
          aiOutcomeToRecent(
            'summarize_failed',
            detail.id,
            `${userFacingSummarizeFailure()} You can tap Transcribe & summarize again shortly.`,
          ),
        )
        dispatchFlow({ type: 'AI_ERROR', recordingSaved: true })
        return
      }

      if (localOnly) {
        await withTimeout(
          updateRecordingLocal(detail.id, {
            transcript: transcriptCanon,
            transcriptRaw,
            summaryEn,
            summaryZh,
          }),
          AI_PERSIST_TIMEOUT_MS,
          'Save transcript and summaries locally',
        )
        const next = await getRecordingDetailLocal(detail.id)
        setDetail(next)
      } else {
        await withTimeout(
          updateRecordingAi(supabase!, userId!, detail.id, {
            transcript: transcriptCanon,
            transcriptRaw,
            summaryEn,
            summaryZh,
          }),
          AI_PERSIST_TIMEOUT_MS,
          'Save transcript and summaries to database',
        )
        const next = await getRecordingDetail(supabase!, userId!, detail.id)
        setDetail(next)
      }
      await refreshList()
      setRecentAi({ kind: 'success', recordingId: detail.id, at: Date.now() })
      dispatchFlow({ type: 'AI_DONE' })
    } catch (e) {
      console.warn('[ai pipeline]', e)
      setRecentAi(
        aiOutcomeToRecent(
          'other',
          detail.id,
          e instanceof AsyncTimeoutError
            ? 'This step took too long. Your recording should still be safe — try again.'
            : userFacingGenericProcessingFailure(),
        ),
      )
      dispatchFlow({ type: 'AI_ERROR', recordingSaved: true })
    } finally {
      setTranscribeSubmitPending(false)
      transcribeActionLockRef.current = false
    }
  }

  const handleExportLocalBackup = async () => {
    if (!localOnly) return
    setBackupError(null)
    setBackupMsg(null)
    setBackupBusy(true)
    try {
      const rows = await getAllRecordingsLocalWithBlobs()
      if (rows.length === 0) {
        setBackupMsg('No recordings to export yet.')
        return
      }
      const zip = await buildLocalBackupZip(rows)
      const url = URL.createObjectURL(zip)
      const a = document.createElement('a')
      a.href = url
      a.download = `youmi-lens-backup-${new Date().toISOString().slice(0, 10)}.zip`
      a.click()
      URL.revokeObjectURL(url)
      setBackupMsg(`Exported ${rows.length} recording(s). Keep the ZIP somewhere safe (cloud drive, etc.).`)
    } catch (e) {
      setBackupError(e instanceof Error ? e.message : 'Export failed')
    } finally {
      setBackupBusy(false)
    }
  }

  const handleImportLocalBackup = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !localOnly) return
    setBackupError(null)
    setBackupMsg(null)
    setBackupBusy(true)
    try {
      const overwrite = window.confirm(
        'If a backup item has the same ID as a recording you already have, replace it?\n\nOK = replace\nCancel = skip duplicates and only add new ones',
      )
      const buf = await file.arrayBuffer()
      const { imported, skipped } = await importLocalBackupZip(buf, {
        saveRow: saveRecordingLocal,
        exists: async (id) => (await getRecordingWithBlob(id)) !== null,
        overwrite,
      })
      await refreshList()
      setBackupMsg(`Import finished: ${imported} added or updated, ${skipped} skipped.`)
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setBackupBusy(false)
    }
  }

  const permanentlyPurgeLectures = useCallback(
    async (ids: string[]) => {
      const unique = [...new Set(ids)].filter(Boolean)
      if (unique.length === 0) return

      setDeleteActionBusy(true)
      try {
        if (localOnly) {
          for (const id of unique) await deleteTrashRecordingLocalPermanently(id)
        } else {
          await deleteLectures(unique, {
            localOnly: false,
            supabase: supabase ?? null,
            userId: userId ?? null,
            deleteRecordingLocal,
          })
          if (userId) {
            setCloudTrash((prev) => {
              const next = { ...prev }
              for (const id of unique) delete next[id]
              saveCloudTrashRegistry(userId, next)
              return next
            })
          }
          setLibraryLectureLocation((prev) => {
            const next = { ...prev }
            for (const id of unique) delete next[id]
            return next
          })
          const list = await refreshList()
          setLibraryPickedIds([])
          if (unique.includes(selectedId ?? '')) {
            const nextSelection = list.find((r) => !unique.includes(r.id))?.id ?? null
            setSelectedId(nextSelection)
            if (!nextSelection) setDetail(null)
          }
        }
        setTrashRefreshNonce((n) => n + 1)
      } catch (err) {
        console.error('[library-delete] permanent purge failed', err)
        throw err
      } finally {
        setDeleteActionBusy(false)
      }
    },
    [localOnly, supabase, userId, refreshList, selectedId],
  )

  const commitMoveToTrash = useCallback(
    async (ids: string[]) => {
      const unique = [...new Set(ids)].filter(Boolean)
      if (unique.length === 0) return

      setDeleteActionBusy(true)
      try {
        if (localOnly) {
          await moveRecordingsToTrashLocal(unique)
        } else if (userId) {
          // Authoritative path: stamp `deleted_at` + `deletion_updated_at` on
          // the row, so every device sees this deletion. Falls back to the
          // device-local registry only when the database has no such columns.
          try {
            for (const id of unique) {
              await softDeleteRecordingRemote(supabase!, userId, id)
            }
          } catch (err) {
            if (!(err instanceof CloudSoftDeleteUnavailableError)) throw err
            setCloudDeletionAvailable(false)
            setCloudTrash((prev) => {
              const next = { ...prev }
              for (const id of unique) {
                const r = recordings.find((x) => x.id === id)
                next[id] = {
                  trashedAt: Date.now(),
                  title: r?.title?.trim() || 'Untitled lecture',
                  course: r?.course?.trim() || '',
                }
              }
              saveCloudTrashRegistry(userId, next)
              return next
            })
          }
        }
        setLibraryLectureLocation((prev) => {
          const next = { ...prev }
          for (const id of unique) delete next[id]
          return next
        })
        setLibraryPickedIds([])
        if (unique.includes(selectedId ?? '')) {
          setSelectedId(null)
          setDetail(null)
        }
        await refreshList()
        setTrashRefreshNonce((n) => n + 1)
      } catch (err) {
        console.error('[library-trash] move to trash failed', err)
        setLibraryFolderNotice(err instanceof Error ? err.message : String(err))
      } finally {
        setDeleteActionBusy(false)
      }
    },
    [localOnly, supabase, userId, recordings, refreshList, selectedId],
  )

  const restoreLecturesFromTrash = useCallback(
    async (ids: string[]) => {
      const unique = [...new Set(ids)].filter(Boolean)
      if (unique.length === 0) return
      setDeleteActionBusy(true)
      try {
        if (localOnly) {
          for (const id of unique) await restoreRecordingFromTrashLocal(id)
        } else if (userId) {
          // Clear `deleted_at` and stamp a FRESH `deletion_updated_at`, so this
          // restore outranks a tombstone another device may still be holding.
          try {
            for (const id of unique) {
              await restoreRecordingRemote(supabase!, userId, id)
            }
          } catch (err) {
            if (!(err instanceof CloudSoftDeleteUnavailableError)) throw err
            setCloudDeletionAvailable(false)
          }
          // Drop any legacy entry regardless of which path ran. The resolver
          // already refuses to let stale trash hide a cloud-active lecture;
          // pruning here means the dead entry cannot mislead later either.
          setCloudTrash((prev) => {
            if (!unique.some((id) => id in prev)) return prev
            const next = { ...prev }
            for (const id of unique) delete next[id]
            saveCloudTrashRegistry(userId, next)
            return next
          })
        }
        await refreshList()
        setTrashRefreshNonce((n) => n + 1)
      } finally {
        setDeleteActionBusy(false)
      }
    },
    [localOnly, supabase, userId, refreshList],
  )

  /**
   * Restore one lecture from Recently Deleted, bringing its course back with it.
   *
   * Restoring a lecture into a course that is ITSELF soft-deleted would put the
   * lecture somewhere the user cannot navigate to — it would leave the bin and
   * then be invisible in Courses. So the owning course is restored first, and
   * only then the lecture, which keeps the lecture from existing in a
   * courseless limbo even for one render.
   */
  const restoreLectureWithCourse = useCallback(
    async (lectureId: string) => {
      const lecture = deletedLectures.find((row) => row.id === lectureId)
      if (lecture) {
        const owner = courseToRestoreWithLecture(lecture, coursesState.deletedCourses)
        if (owner) await coursesState.restore(owner.id)
      }
      await restoreLecturesFromTrash([lectureId])
    },
    [deletedLectures, coursesState, restoreLecturesFromTrash],
  )

  const handleDeleteSelectedLectures = useCallback(() => {
    const validIdSet = new Set(recordingsInLibrary.map((r) => r.id))
    const ids = libraryPickedIds.filter((id) => validIdSet.has(id))
    if (ids.length === 0) return
    const scope = classifyTrashDeletionScope(
      ids,
      libraryActiveScope,
      unfiledRecordings,
      folderRecordingsMap,
      libraryFolders,
    )
    setTrashConfirmModal({ ids, scope })
  }, [
    libraryPickedIds,
    recordingsInLibrary,
    libraryActiveScope,
    unfiledRecordings,
    folderRecordingsMap,
    libraryFolders,
  ])

  const deleteLectureFromDetailPanel = useCallback(() => {
    if (!selectedId) return
    const validIdSet = new Set(recordingsInLibrary.map((r) => r.id))
    if (!validIdSet.has(selectedId)) return
    const scope = classifyTrashDeletionScope(
      [selectedId],
      libraryActiveScope,
      unfiledRecordings,
      folderRecordingsMap,
      libraryFolders,
    )
    setTrashConfirmModal({ ids: [selectedId], scope })
  }, [
    selectedId,
    recordingsInLibrary,
    libraryActiveScope,
    unfiledRecordings,
    folderRecordingsMap,
    libraryFolders,
  ])

  const handleDeleteLectureById = useCallback(
    (lectureId: string | null | undefined) => {
      if (!lectureId) return
      const validIdSet = new Set(recordingsInLibrary.map((r) => r.id))
      if (!validIdSet.has(lectureId)) return
      const scope = classifyTrashDeletionScope(
        [lectureId],
        libraryActiveScope,
        unfiledRecordings,
        folderRecordingsMap,
        libraryFolders,
      )
      setTrashConfirmModal({ ids: [lectureId], scope })
    },
    [recordingsInLibrary, libraryActiveScope, unfiledRecordings, folderRecordingsMap, libraryFolders],
  )

  const createFolder = () => {
    setNewFolderInputValue('')
    setNewFolderInputVisible(true)
  }

  const confirmNewFolder = () => {
    const name = newFolderInputValue.trim()
    setNewFolderInputVisible(false)
    setNewFolderInputValue('')
    if (!name) return
    const id =
      typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `f-${Date.now()}`
    const folder: LibraryFolder = { id, name, createdAt: Date.now() }
    setLibraryFolders((prev) => [folder, ...prev])
  }

const openEditLectureModal = useCallback(() => {
    if (!selectedId) return
    const meta =
      recordings.find((r) => r.id === selectedId) ?? (detail?.id === selectedId ? detail : null)
    if (!meta) return
    setEditLectureModal({
      id: selectedId,
      courseDraft: meta.course ?? '',
      titleDraft: meta.title ?? '',
      error: null,
    })
  }, [selectedId, recordings, detail])

  const commitEditLectureModal = useCallback(async () => {
    if (!editLectureModal) return
    const id = editLectureModal.id
    const existing = recordings.find((r) => r.id === id) ?? (detail?.id === id ? detail : null)
    if (!existing) {
      setEditLectureModal(null)
      return
    }
    const courseTrim = editLectureModal.courseDraft.trim()
    const titleTrim = editLectureModal.titleDraft.trim()
    const existingCourse = (existing.course ?? '').trim()
    const courseNext = courseTrim || existingCourse || 'Untitled course'
    // `undefined` means "do not write title at all". Clearing the field is a
    // request to stop naming the lecture, not a request to store a generated
    // name over the one that is already there.
    const titleNext = isMeaningfulLectureTitle(titleTrim) ? titleTrim : undefined

    setLectureMetadataBusy(true)
    try {
      if (localOnly) {
        await updateRecordingLocal(id, { course: courseNext, title: titleNext })
      } else {
        if (!supabase || !userId) {
          setEditLectureModal((prev) => (prev ? { ...prev, error: 'Not signed in.' } : null))
          setLectureMetadataBusy(false)
          return
        }
        await updateRecordingMetadata(supabase, userId, id, { course: courseNext, title: titleNext })
      }
      // Mirror exactly what was written: when `titleNext` is undefined the row
      // kept its stored name, so local state must keep it too.
      const applyEdit = <T extends { course: string; title: string }>(row: T): T => ({
        ...row,
        course: courseNext,
        ...(titleNext === undefined ? {} : { title: titleNext }),
      })
      setRecordings((prev) => prev.map((r) => (r.id === id ? applyEdit(r) : r)))
      setDetail((prev) => (prev && prev.id === id ? applyEdit(prev) : prev))
      setEditLectureModal(null)
    } catch (e) {
      setEditLectureModal((prev) =>
        prev ? { ...prev, error: e instanceof Error ? e.message : String(e) } : null,
      )
    } finally {
      setLectureMetadataBusy(false)
    }
  }, [editLectureModal, recordings, detail, localOnly, supabase, userId])

  /**
   * Rename a lecture. Title only.
   *
   * `updateRecordingMetadata` takes both fields, so the CURRENT course is read
   * back and written unchanged rather than omitted — the mutation is the
   * existing production one, and this adapter simply refuses to move anything.
   */
  const renameLecture = useCallback(
    async (recordingId: string, title: string) => {
      const existing =
        recordings.find((r) => r.id === recordingId) ??
        (detail?.id === recordingId ? detail : null)
      if (!existing) return false
      const next = title.trim()
      // A rename to a placeholder is refused outright: `Untitled lecture` is a
      // render-time fallback and must never become the stored name.
      if (!isMeaningfulLectureTitle(next)) return false

      setLectureMetadataBusy(true)
      setLectureDialogError(null)
      try {
        // TITLE ONLY. The course is deliberately absent from this payload — a
        // rename that also carries a course is how a rename becomes a move.
        if (localOnly) {
          await updateRecordingLocal(recordingId, { title: next })
        } else {
          if (!supabase || !userId) throw new Error('Not signed in.')
          await updateRecordingMetadata(supabase, userId, recordingId, { title: next })
        }
        setRecordings((prev) =>
          prev.map((r) => (r.id === recordingId ? { ...r, title: next } : r)),
        )
        setDetail((prev) => (prev && prev.id === recordingId ? { ...prev, title: next } : prev))
        return true
      } catch (e) {
        setLectureDialogError(e instanceof Error ? e.message : String(e))
        return false
      } finally {
        setLectureMetadataBusy(false)
      }
    },
    [recordings, detail, localOnly, supabase, userId],
  )

  /**
   * Persist Notes for the open lecture. Cloud only — local-only mode has no
   * store for this field, so `LectureDetailPage` never offers the editor there
   * (`annotationsEditable`) and this is not called.
   *
   * Rejects on failure so the editor can say so and keep the unsaved text; it
   * never optimistically marks the row saved before the write is confirmed.
   */
  const saveLectureNotes = useCallback(
    async (recordingId: string, notes: string): Promise<void> => {
      if (!supabase || !userId) throw new Error('Not signed in.')
      const now = Date.now()
      await updateRecordingNotesMarks(supabase, userId, recordingId, { notes })
      setRecordings((prev) =>
        prev.map((r) => (r.id === recordingId ? { ...r, notes, notesUpdatedAt: now } : r)),
      )
    },
    [supabase, userId],
  )

  /**
   * Append one mark to the open lecture's `marked_timestamps`.
   *
   * V1 contract: `number[]` of elapsed milliseconds, no id, no per-mark
   * metadata, whole-array replacement. `appendMark` does not sort or
   * de-duplicate — reordering here would rewrite marks another device wrote.
   */
  const addLectureMark = useCallback(
    async (recordingId: string, atMs: number): Promise<void> => {
      if (!supabase || !userId) throw new Error('Not signed in.')
      const existing = recordings.find((r) => r.id === recordingId)
      const current = parseMarks(existing?.markedTimestamps)
      const next = appendMark(current, atMs)
      const now = Date.now()
      await updateRecordingNotesMarks(supabase, userId, recordingId, { markedTimestamps: next })
      setRecordings((prev) =>
        prev.map((r) =>
          r.id === recordingId ? { ...r, markedTimestamps: next, marksUpdatedAt: now } : r,
        ),
      )
    },
    [recordings, supabase, userId],
  )

  /**
   * Move a lecture to another course. Course only.
   *
   * Goes through the Course repository so the dual write is preserved:
   * `course_id` and the legacy `course` label in one statement. The title is
   * never part of this payload.
   */
  const moveLectureToCourse = useCallback(
    async (recordingId: string, courseId: string | null) => {
      setLectureDialogError(null)
      const result = await coursesState.assignLecture(recordingId, courseId)
      if (!result) {
        setLectureDialogError(coursesState.mutationError)
        return false
      }
      setRecordings((prev) =>
        prev.map((r) => (r.id === recordingId ? { ...r, course: result.courseName } : r)),
      )
      setDetail((prev) =>
        prev && prev.id === recordingId ? { ...prev, course: result.courseName } : prev,
      )
      return true
    },
    [coursesState],
  )

  const deleteFolderIfEmpty = (folderId?: string) => {
    setLibraryFolderNotice(null)
    if (!folderId) {
      setLibraryFolderNotice('Select a folder first.')
      return
    }
    const count = folderRecordingsMap[folderId]?.length ?? 0
    if (count > 0) {
      setLibraryFolderNotice('Move or delete lectures before deleting this folder.')
      console.log('[library-folder-delete] blocked_non_empty', { folderId, count })
      return
    }
    setLibraryFolders((prev) => prev.filter((x) => x.id !== folderId))
    setLibraryLectureLocation((prev) => {
      const next = { ...prev }
      for (const [recordingId, loc] of Object.entries(next)) {
        if (loc === folderId) delete next[recordingId]
      }
      return next
    })
    if (libraryActiveScope.kind === 'folder' && libraryActiveScope.folderId === folderId) {
      setLibraryActiveScope({ kind: 'all' })
    }
    setLibraryPickedIds([])
    setLibraryFolderNotice('Folder deleted.')
    console.log('[library-folder-delete] deleted', { folderId })
  }

  const moveLectureToFolder = (recordingId: string, folderId: string) => {
    setLibraryLectureLocation((prev) => ({ ...prev, [recordingId]: folderId }))
  }

  const moveLectureToUnfiled = (recordingId: string) => {
    setLibraryLectureLocation((prev) => ({ ...prev, [recordingId]: 'unfiled' }))
  }

useEffect(() => {
    if (!editLectureModal) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEditLectureModal(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editLectureModal])

  useEffect(() => {
    setCoursesSearchQuery('')
  }, [courseView])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  )

  const handleDndStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as { kind?: string; recordingId?: string } | undefined
    if (data?.kind !== 'lecture' || !data.recordingId) return
    setDraggingRecordingId(data.recordingId)
    setDragOverlayRecordingId(data.recordingId)
    suppressItemClickRef.current = true
  }, [])

  const handleDndOver = useCallback(
    (event: DragOverEvent) => {
      const overData = event.over?.data.current as { kind?: string; dropId?: LibraryDropId } | undefined
      if (overData?.kind === 'library-drop' && overData.dropId) {
        setDropTargetFolderId(overData.dropId)
      } else {
        setDropTargetFolderId(null)
      }
    },
    [],
  )

  const resetDndState = useCallback(() => {
    setDraggingRecordingId(null)
    setDragOverlayRecordingId(null)
    setDropTargetFolderId(null)
    window.setTimeout(() => {
      suppressItemClickRef.current = false
    }, 0)
  }, [])

  const handleDndCancel = useCallback(
    (_event: DragCancelEvent) => {
      resetDndState()
    },
    [resetDndState],
  )

  const handleDndEnd = useCallback(
    (event: DragEndEvent) => {
      const activeData = event.active.data.current as { kind?: string; recordingId?: string } | undefined
      const overData = event.over?.data.current as { kind?: string; dropId?: LibraryDropId } | undefined
      if (activeData?.kind === 'lecture' && activeData.recordingId && overData?.kind === 'library-drop' && overData.dropId) {
        if (overData.dropId === 'unfiled') moveLectureToUnfiled(activeData.recordingId)
        else moveLectureToFolder(activeData.recordingId, overData.dropId)
      }
      resetDndState()
    },
    [moveLectureToFolder, moveLectureToUnfiled, resetDndState],
  )

  useEffect(() => {
    return () => {
      if (audioUrl?.startsWith('blob:')) URL.revokeObjectURL(audioUrl)
    }
  }, [audioUrl])

  const selectedFolderLectureCount =
    libraryActiveScope.kind === 'folder'
      ? folderRecordingsMap[libraryActiveScope.folderId]?.length ?? 0
      : 0

  const visibleLectureIds = recordingIdsInActiveScopeOrdered()
  const courseViewLectureIds = useMemo(() => {
    if (courseView.type === 'recentlyDeleted') return []
    return getScopedRecordingIds(
      courseView.type === 'folder'
        ? { kind: 'folder', folderId: courseView.folderId }
        : courseView.type === 'unfiled'
          ? { kind: 'unfiled' }
          : { kind: 'all' },
      recordingsInLibrary,
      unfiledRecordings,
      folderRecordingsMap,
    )
  }, [courseView, recordingsInLibrary, unfiledRecordings, folderRecordingsMap])
  const visibleCourseRecordings = useMemo(() => {
    const byId = new Map(recordingsInLibrary.map((r) => [r.id, r]))
    return courseViewLectureIds.map((id) => byId.get(id)).filter((r): r is Recording => Boolean(r))
  }, [recordingsInLibrary, courseViewLectureIds])

  const filteredCourseRecordings = useMemo((): Array<Recording & { _matchReason?: MatchReason }> => {
    const q = coursesSearchQuery.trim()
    if (!q) return visibleCourseRecordings
    const results: Array<Recording & { _matchReason?: MatchReason }> = []
    for (const r of visibleCourseRecordings) {
      const { matched, reason } = matchLectureSearch(r, q)
      if (matched) results.push(reason ? { ...r, _matchReason: reason } : r)
    }
    return results
  }, [coursesSearchQuery, visibleCourseRecordings])

  const cloudTrashEntriesSorted = useMemo(
    () =>
      Object.entries(cloudTrash)
        .map(([id, meta]) => ({ id, ...meta }))
        .sort((a, b) => b.trashedAt - a.trashedAt),
    [cloudTrash],
  )

  const trashTotalCount = localOnly ? localTrashRows.length : cloudTrashEntriesSorted.length

  const filteredTrashRows = useMemo(() => {
    const rows = localOnly
      ? localTrashRows.map((r) => ({ id: r.id, title: r.title?.trim() || 'Untitled lecture', course: r.course ?? '' }))
      : cloudTrashEntriesSorted.map((r) => ({ id: r.id, title: r.title?.trim() || 'Untitled lecture', course: r.course ?? '' }))
    const q = coursesSearchQuery.trim()
    if (!q) return rows
    const ql = q.toLowerCase()
    return rows.filter(
      (row) => row.title.toLowerCase().includes(ql) || row.course.toLowerCase().includes(ql),
    )
  }, [coursesSearchQuery, localOnly, localTrashRows, cloudTrashEntriesSorted])

  const primaryScopedSelectLabel =
    libraryActiveScope.kind === 'folder'
      ? 'Select this folder'
      : libraryActiveScope.kind === 'unfiled'
        ? 'Select unfiled lectures'
        : 'Select all lectures'

  const activeCourseScopeLabel =
    courseView.type === 'folder'
      ? libraryFolders.find((f) => f.id === courseView.folderId)?.name ?? 'Folder'
      : courseView.type === 'recentlyDeleted'
        ? 'Recently Deleted'
        : courseView.type === 'unfiled'
        ? 'Unfiled'
        : 'All lectures'
  const activeCourseLectureCount =
    courseView.type === 'recentlyDeleted' ? filteredTrashRows.length : filteredCourseRecordings.length

  const validPickedLectureCount = libraryPickedIds.filter((id) =>
    recordingsInLibrary.some((r) => r.id === id),
  ).length
  const deleteSelectedEnabled = libraryPickMode && validPickedLectureCount > 0 && !deleteActionBusy
  const coursesDeleteDisabled = deleteActionBusy || courseView.type === 'recentlyDeleted'

  const showAccountPanel =
    !localOnly && supabase && userId && onProfileRowChange
  const handleCoursesDelete = () => {
    // ── Diagnostic ───────────────────────────────────────────────────────────
    const validIdSet = new Set(recordingsInLibrary.map((r) => r.id))
    const selectedLectureIds = libraryPickedIds.filter((id) => validIdSet.has(id))
    const currentSelectedLecture = selectedId && validIdSet.has(selectedId) ? selectedId : null
    const resolvedTargetType =
      libraryPickMode && selectedLectureIds.length > 0
        ? 'multi-select'
        : currentSelectedLecture
          ? 'single-lecture'
          : courseView.type === 'folder'
            ? 'folder'
            : 'none'
    console.log('[CoursesDelete] clicked', {
      courseView,
      activeFolderId: courseView.type === 'folder' ? courseView.folderId : null,
      selectedId,
      selectedRecording: selectedId ? recordings.find((r) => r.id === selectedId) : null,
      selectMode: libraryPickMode,
      checkedLectureIds: libraryPickedIds,
      checkedLectureCount: libraryPickedIds.length,
      deleteDisabled: coursesDeleteDisabled,
      isRecentlyDeletedView: courseView.type === 'recentlyDeleted',
      visibleLectureIds: courseViewLectureIds,
      recordingsInLibraryCount: recordingsInLibrary.length,
      selectedFolderName: courseView.type === 'folder'
        ? libraryFolders.find((f) => f.id === courseView.folderId)?.name ?? null
        : null,
      resolvedTargetType,
      resolvedTargetIds: resolvedTargetType === 'multi-select' ? selectedLectureIds
        : resolvedTargetType === 'single-lecture' ? [currentSelectedLecture]
        : resolvedTargetType === 'folder' ? [courseView.type === 'folder' ? courseView.folderId : null]
        : [],
    })

    // ── Guard: Recently Deleted view ─────────────────────────────────────────
    if (courseView.type === 'recentlyDeleted') {
      console.log('[CoursesDelete] early return: recentlyDeleted view')
      setLibraryFolderNotice('Use Restore or Delete forever on deleted lectures.')
      return
    }

    setLibraryFolderNotice(null)

    // Build a LibraryActiveScope that matches the current course view for classifyTrashDeletionScope
    const courseViewScope: LibraryActiveScope =
      courseView.type === 'folder'
        ? { kind: 'folder', folderId: courseView.folderId }
        : courseView.type === 'unfiled'
          ? { kind: 'unfiled' }
          : { kind: 'all' }

    // ── Case B: multi-select ─────────────────────────────────────────────────
    if (libraryPickMode && selectedLectureIds.length > 0) {
      console.log('[CoursesDelete] multi-select branch, opening trashConfirmModal', selectedLectureIds)
      const scope = classifyTrashDeletionScope(
        selectedLectureIds,
        courseViewScope,
        unfiledRecordings,
        folderRecordingsMap,
        libraryFolders,
      )
      setTrashConfirmModal({ ids: selectedLectureIds, scope })
      return
    }

    // ── Case A: single lecture ───────────────────────────────────────────────
    if (currentSelectedLecture) {
      console.log('[CoursesDelete] single-lecture branch, opening trashConfirmModal', currentSelectedLecture)
      const scope = classifyTrashDeletionScope(
        [currentSelectedLecture],
        courseViewScope,
        unfiledRecordings,
        folderRecordingsMap,
        libraryFolders,
      )
      setTrashConfirmModal({ ids: [currentSelectedLecture], scope })
      return
    }

    // ── Case C: folder ───────────────────────────────────────────────────────
    if (courseView.type === 'folder') {
      const folder = libraryFolders.find((f) => f.id === courseView.folderId)
      const folderName = folder?.name.trim() || 'this folder'
      const count = folderRecordingsMap[courseView.folderId]?.length ?? 0
      console.log('[CoursesDelete] folder branch', { folderId: courseView.folderId, folderName, count })
      if (count > 0) {
        console.log('[CoursesDelete] folder blocked: non-empty', { count })
        setLibraryFolderNotice('Move or delete lectures before deleting this folder.')
        return
      }
      console.log('[CoursesDelete] opening folderDeleteModal for empty folder')
      setFolderDeleteModal({ folderId: courseView.folderId, folderName })
      return
    }

    // ── Case D: no valid target ──────────────────────────────────────────────
    console.log('[CoursesDelete] no valid target')
    setLibraryFolderNotice('Select a folder or lecture first.')
  }

  const legacySettingsEnabled: boolean = false

  /**
   * The single source of truth for which shell and which page render.
   *
   * An ACTIVE recording is now a V2 view (`recording`). It used to be `null`,
   * which dropped the user out of the V2 shell and back into the legacy
   * `.yl-shell` cockpit the moment they pressed Start — the regression this
   * gate exists to fix.
   *
   * `null` selects the legacy shell. Nothing in the normal user path reaches it
   * any more: Lecture Detail is a V2 view (`lecture`), so Stop & Save,
   * Course Detail rows, Recent lists and Record Home all land on the same
   * production screen. The legacy detail markup still exists but is
   * unreachable.
   *
   * The recording screen is selected from `recordingStage`, not from the
   * recorder alone: `handleStopAndSave` awaits `recorder.stop()` first, so the
   * recorder reports idle while the pipeline is still saving and uploading, and
   * keying on it dropped the user onto Record Home mid-save.
   */
  const desktopV2View:
    | 'record'
    | 'recording'
    | 'settings'
    | 'courses'
    | 'courseDetail'
    | 'recentlyDeleted'
    | 'lecture' =
    ownsRecordingScreen(recordingStage)
      ? 'recording'
      : workspaceView === 'settings'
        ? 'settings'
        : workspaceView === 'lecture'
          ? // A lecture view whose lecture has gone — deleted from under it, or
            // dropped from the library — falls back to Courses, NOT to the
            // legacy shell. This was the last remaining route into legacy UI:
            // `null` selected `YoumiLensShell`, and the effect that clears
            // `selectedId` when a recording leaves the library does not reset
            // `workspaceView`.
            openLecture
            ? 'lecture'
            : 'courses'
          : workspaceView === 'courses'
            ? coursesV2DeletedOpen
              ? 'recentlyDeleted'
              // `openCourse`, not `openCourseId`: a course deleted while its
              // detail is open leaves the id set but the row gone, and that
              // combination also used to reach the legacy shell.
              : openCourse
                ? 'courseDetail'
                : 'courses'
            : 'record'

  const settingsDetail =
    settingsSection === 'language' ? (
      <SettingsLanguagePage
        preferences={languagePreferences}
        onPreferenceChange={setLanguagePreference}
      />
    ) : settingsSection === 'capture' ? (
      <>
        <h2>{tDesktop('settings.capture')}</h2>
        <p className="settings-v2__lead">{tDesktop('capture.audioSourceHelp')}</p>
        <div className="settings-v2__group">
          <SettingsRow
            name={tDesktop('capture.sourceMicrophone')}
            help={tDesktop('capture.sourceMicrophoneHelp')}
            control={
              <button
                type="button"
                className="v2-btn"
                aria-pressed={audioSource === 'microphone'}
                disabled={recorder.status !== 'idle'}
                onClick={() => setAudioSource('microphone')}
              >
                {audioSource === 'microphone' ? '✓' : ''}
              </button>
            }
          />
          {/* Hidden, not disabled, when the WebView has no getDisplayMedia:
              an option that cannot work should not be offered at all. */}
          {systemAudioSupported() ? (
            <SettingsRow
              name={tDesktop('capture.sourceSystem')}
              help={`${tDesktop('capture.sourceSystemHelp')} ${tDesktop('capture.systemPickerNote')}`}
              control={
                <button
                  type="button"
                  className="v2-btn"
                  aria-pressed={audioSource === 'system'}
                  disabled={recorder.status !== 'idle'}
                  onClick={() => setAudioSource('system')}
                >
                  {audioSource === 'system' ? '✓' : ''}
                </button>
              }
            />
          ) : (
            <SettingsRow
              name={tDesktop('capture.sourceSystem')}
              help={tDesktop('capture.systemUnsupported')}
            />
          )}
        </div>
      </>
    ) : settingsSection === 'appearance' ? (
      <>
        <h2>{tDesktop('settings.appearance')}</h2>
        <p className="settings-v2__lead">{tDesktop('settings.languageLead')}</p>
        <div className="settings-v2__group">
          <SettingsRow name="Theme" help="Desktop V2 uses the light appearance." />
          <SettingsRow name="Text size" help="Applies to captions and reading views." />
        </div>
      </>
    ) : settingsSection === 'account' ? (
      <>
        <SettingsPlaceholder
          title={tDesktop('settings.account')}
          note="Profile, sign-in methods and sign out."
        />
        <div className="settings-v2__group">
          <SettingsRow
            name={tDesktop('settings.account')}
            help={userEmail ?? undefined}
            control={
              showAccountPanel ? (
                <button type="button" className="v2-btn" onClick={() => setAccountSettingsOpen(true)}>
                  Open
                </button>
              ) : undefined
            }
          />
        </div>
      </>
    ) : settingsSection === 'planUsage' ? (
      <>
        <SettingsPlaceholder
          title={tDesktop('settings.planUsage')}
          note="Your Student Basic plan, usage, and billing."
        />
        <div className="settings-v2__group">
          <SettingsRow
            name={tDesktop('settings.planUsage')}
            help="View your plan, usage, and manage billing."
            control={
              showAccountPanel ? (
                <button type="button" className="v2-btn" onClick={() => setBillingPlanOpen(true)}>
                  Open
                </button>
              ) : undefined
            }
          />
        </div>
      </>
    ) : settingsSection === 'advancedAi' ? (
      <>
        <SettingsPlaceholder
          title={tDesktop(SETTINGS_PLACEHOLDER_TITLE.advancedAi)}
          note="Bring your own API key for AI processing, or use the hosted default."
        />
        <div className="settings-v2__group">
          <AiPreferencesSection allowByok />
        </div>
      </>
    ) : settingsSection === 'autoUpdate' ? (
      <>
        <SettingsPlaceholder
          title={tDesktop(SETTINGS_PLACEHOLDER_TITLE.autoUpdate)}
          note="Youmi Lens checks for updates automatically and never interrupts an active recording."
        />
        <div className="settings-v2__group">
          <UpdaterEntry
            recordingSafety={{
              recorderStatus: recorder.status as 'idle' | 'recording' | 'paused',
              saveInFlight: saveOrFinishBusy,
              recoveringSession: Boolean(recoveryBusyId),
            }}
          />
        </div>
      </>
    ) : settingsSection === 'support' ? (
      <>
        <SettingsPlaceholder
          title={tDesktop(SETTINGS_PLACEHOLDER_TITLE.support)}
          note="Youmi Lens is available as a free educational tool. Please report issues with recording, live captions, translation, or summaries."
        />
        <div className="settings-v2__group">
          <SettingsRow
            name="Email support"
            help="youmilens@gmail.com"
            control={
              <button
                type="button"
                className="v2-btn"
                onClick={() => void openExternalContact(SUPPORT_CONTACT_URL)}
              >
                Email support
              </button>
            }
          />
        </div>
      </>
    ) : (
      <SettingsPlaceholder
        title={tDesktop(SETTINGS_PLACEHOLDER_TITLE[settingsSection])}
        note="Not migrated to Desktop V2 yet — these controls still live in the previous interface."
      />
    )

  // The recording screen is shared by two branches: the ACTIVE flow
  // (`desktopV2View === 'recording'`) and a TERMINAL stage shown on Record
  // (`desktopV2View === 'record'` while a saved result or recovery decision is
  // still waiting on the user). Hoisted so the identical element renders in both
  // without duplicating its props. Terminal stages no longer PIN navigation:
  // `ownsRecordingScreen` excludes them, so the sidebar can leave Record and the
  // recovery card stays recoverable rather than trapping the user.
  const recordingScreen = (
    <RecordingV2
      t={tDesktop}
      stage={recordingStage}
      courseName={recordingHeaderCourseName}
      courseIdentity={recordingHeaderCourseIdentity}
      lectureTitle={title.trim() || tDesktop('recording.untitled')}
      elapsed={formatClock(recorder.elapsedSec)}
      languageLine={`${tDesktop(AUDIO_SOURCE_LABEL_KEY[audioSource])} · ${spokenLanguageLabel(liveLang)} → ${
        translateTarget === 'zh' ? 'Chinese' : 'English'
      } · ${
        languagePreferences.languageMode === 'bilingual'
          ? tDesktop('record.bilingual')
          : tDesktop('record.captionsOnly')
      }`}
      sourceCommitted={primaryCaption}
      sourceDraft={primaryCaptionDraft}
      translationCommitted={secondaryCaption}
      translationDraft={secondaryCaptionDraft}
      translationEnabled={translateTarget !== 'off'}
      translationPending={useLiveEngineV2 && Boolean(primaryCaptionDraft.trim())}
      notice={
        liveCaptionChunkNotice
          ? {
              tier: liveCaptionChunkNotice.kind === 'fatal' ? 'fatal' : 'info',
              text: liveCaptionChunkNotice.message,
            }
          : liveCaptionSessionSurface
            ? {
                tier: liveCaptionSessionSurface.tier === 'fatal' ? 'fatal' : 'info',
                text: liveCaptionSessionSurface.text,
              }
            : null
      }
      failureMessage={recentCapture?.kind === 'failure' ? recentCapture.message : null}
      busy={saveOrFinishBusy}
      canOpenOverlay={isTauriContext()}
      onOpenOverlay={openLectureOverlay}
      onDiscard={() => setDiscardConfirmOpen(true)}
      onPause={pauseRecording}
      onResume={resumeRecording}
      onStopAndSave={() => void handleStopAndSave()}
      onViewLecture={() => {
        // The EXACT saved recording, through the one shared opener. Clearing
        // the outcome first releases this screen, so the lecture is not
        // rendered behind a stage panel that still claims to be saving.
        const id = recentCapture?.recordingId
        setRecentCapture(null)
        setRecentAi(null)
        if (id) openLectureDetail(id)
      }}
      onRecordAnother={() => {
        setRecentCapture(null)
        setRecentAi(null)
        setTitle('')
        // Recovery Dismiss: hide the prompt for this session only. The durable
        // session and its audio chunks stay in IndexedDB, so the recording
        // remains recoverable on the next launch — nothing is deleted.
        setRecoveredSessions([])
        setWorkspaceView('record')
      }}
      onRetry={() => {
        // A save that only made it to the local pending-upload fallback has a
        // real retry: re-attempt the SAME durable recordingId (idempotent —
        // insertLectureRecordingRow upserts by id, so this can never create a
        // duplicate lecture). Every other failure kind keeps the existing
        // behavior: clear the outcome and let the user save again from the
        // durable recording session.
        if (recentCapture?.kind === 'failure' && recentCapture.outcome === 'pending_upload') {
          const recordingId = recentCapture.recordingId
          setRecentCapture(null)
          if (recordingId) void handleRetryPendingUpload(recordingId)
          return
        }
        setRecentCapture(null)
      }}
      onRecoverRecording={() => {
        const session = selectedRecoverySession
        if (session) void handleRecoverSave(session)
      }}
      onDiscardRecovery={() => {
        const session = selectedRecoverySession
        if (session) void handleRecoverDelete(session.id)
      }}
      onCancelRecoveryDiscard={() => setRecoveryDeleteConfirmId(null)}
      recoveryDiscardConfirm={Boolean(selectedRecoverySession && recoveryDeleteConfirmId === selectedRecoverySession.id)}
      recoveryItems={recoveredSessions.map((session) => ({
        id: session.id,
        label: `${new Date(session.startedAt).toLocaleString()} · ${session.course?.trim() || 'Course not chosen'}`,
      }))}
      selectedRecoveryId={selectedRecoverySessionId}
      selectedRecoveryNeedsCourse={recoveryNeedsCourseChoice}
      recoveryCourseOptions={coursesState.courses.map((item) => ({ id: item.id, name: item.name }))}
      onSelectRecovery={setSelectedRecoverySessionId}
      onAssignRecoveryCourse={(courseId) => {
        if (selectedRecoverySession) void handleAssignRecoveryCourse(selectedRecoverySession.id, courseId)
      }}
      onCreateRecoveryCourse={() => {
        setCourseDialog({ kind: 'create' })
        setWorkspaceView('courses')
      }}
    />
  )

  const desktopV2Page =
    desktopV2View === 'record' ? (
      isTerminalRecordingStage(recordingStage) ? (
        recordingScreen
      ) : (
        <RecordHome
          course={course}
          courseIdentity={activeCourseIdentity}
          audioSourceLabel={tDesktop(AUDIO_SOURCE_LABEL_KEY[audioSource])}
          title={title}
          preferences={languagePreferences}
          disabled={saveOrFinishBusy}
          recentLectures={recordingsInLibrary
            .slice()
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 3)
            .map((recording) => ({
              id: recording.id,
              title: recording.title?.trim() || 'Untitled lecture',
              course: recording.course?.trim() || 'Unfiled',
              duration: formatClock(recording.durationSec),
              status:
                recording.storagePath || recording.durationSec > 0
                  ? ('Ready' as const)
                  : recording.aiStatus === 'failed'
                    ? ('Failed' as const)
                    : ('Processing' as const),
            }))}
          onTitleChange={setTitle}
          onStartRecording={startRecording}
          onOpenSettings={() => {
            setSettingsSection('language')
            setWorkspaceView('settings')
          }}
          onChangeCourse={() => setWorkspaceView('courses')}
          onNewCourse={() => setWorkspaceView('courses')}
          onViewAll={() => setWorkspaceView('courses')}
          onOpenLecture={openLectureDetail}
        />
      )
    ) : desktopV2View === 'recording' ? (
      recordingScreen
    ) : desktopV2View === 'recentlyDeleted' ? (
      <RecentlyDeletedPage
        t={tDesktop}
        deletedCourses={coursesState.deletedCourses}
        deletedLectures={deletedLectures}
        activeCourses={coursesState.courses}
        capabilities={coursesState.capabilities}
        busy={coursesState.busy || deleteActionBusy}
        loading={coursesState.loading}
        error={coursesState.error}
        onRetry={() => void coursesState.refresh()}
        restoreError={restoreError}
        formatDate={formatDate}
        onBack={() => {
          setRestoreError(null)
          setCoursesV2DeletedOpen(false)
        }}
        onRestoreCourse={(courseId) => {
          setRestoreError(null)
          void coursesState.restore(courseId).then((ok) => {
            if (!ok) setRestoreError(tDesktop('deleted.restoreFailed'))
          })
        }}
        onPurgeCourse={(courseId) => setPurgeDialog({ kind: 'course', courseId })}
        onRestoreLecture={(lectureId) => {
          setRestoreError(null)
          void restoreLectureWithCourse(lectureId).catch(() => {
            setRestoreError(tDesktop('deleted.restoreFailed'))
          })
        }}
        onPurgeLecture={(lectureId) => setPurgeDialog({ kind: 'lecture', lectureId })}
      />
    ) : desktopV2View === 'lecture' && openLecture ? (
      <LectureDetailPage
        t={tDesktop}
        recording={openLecture}
        detail={detail?.id === openLecture.id ? detail : null}
        detailLoadFailed={detailLoadFailed}
        onRetryDetail={() => setDetailRetryNonce((n) => n + 1)}
        course={openLectureCourse}
        audioUrl={detail?.id === openLecture.id ? audioUrl : null}
        audioError={detail?.id === openLecture.id ? audioLoadError : null}
        onRetryAudio={retryAudioLoad}
        languageLine={`${spokenLanguageLabel(liveLang)} → ${
          translateTarget === 'zh' ? 'Chinese' : 'English'
        }`}
        formatDate={formatDate}
        formatDuration={formatClock}
        backLabel={openLectureCourse ? openLectureCourse.name : tDesktop('courses.title')}
        onBack={() => {
          // Back to the owning course when there is one, otherwise the grid.
          setOpenCourseId(openLectureCourse ? openLectureCourse.id : null)
          setWorkspaceView('courses')
        }}
        onRename={() => {
          setLectureDialogError(null)
          setLectureDialog({ kind: 'rename', recordingId: openLecture.id })
        }}
        onMove={() => {
          setLectureDialogError(null)
          setLectureDialog({ kind: 'move', recordingId: openLecture.id })
        }}
        onDelete={() => {
          setLectureDialogError(null)
          setLectureDialog({ kind: 'delete', recordingId: openLecture.id })
        }}
        actionsDisabled={lectureMetadataBusy || deleteActionBusy}
        onSaveNotes={(notes) => saveLectureNotes(openLecture.id, notes)}
        onAddMark={(atMs) => addLectureMark(openLecture.id, atMs)}
        annotationsEditable={!localOnly && Boolean(supabase) && Boolean(userId)}
      />
    ) : desktopV2View === 'settings' ? (
      <SettingsLayout section={settingsSection} onSectionChange={setSettingsSection}>
        {settingsDetail}
      </SettingsLayout>
    ) : desktopV2View === 'courseDetail' && openCourse ? (
      <CourseDetailPage
        t={tDesktop}
        course={openCourse}
        courses={coursesState.courses}
        recordings={recordingsInLibrary}
        capabilities={coursesState.capabilities}
        loading={coursesState.loading}
        error={coursesState.error}
        onRetry={() => void coursesState.refresh()}
        lectureStatus={lectureStatusOf}
        formatDuration={formatClock}
        formatDate={formatDate}
        onBack={() => setOpenCourseId(null)}
        onStartLecture={() => {
          // Start a lecture under THIS course: preserve the canonical UUID, then
          // begin recording immediately (the SAME `startRecording` path the
          // Record Home "Start" button uses — no second recorder). Recording V2
          // opens as soon as the mic is live, and Finish/upload writes this
          // course's UUID as `course_id`.
          setCourse(openCourse.name)
          setRecordingCourseId(openCourse.id)
          setOpenCourseId(null)
          setWorkspaceView('record')
          startRecording({ course: openCourse.name, courseId: openCourse.id, title: title.trim() })
        }}
        // The EXISTING Lecture Detail. `openCourseId` is deliberately kept, so
        // leaving the lecture returns to this course rather than to the grid.
        onOpenLecture={openLectureDetail}
        onRenameCourse={() => setCourseDialog({ kind: 'rename', courseId: openCourse.id })}
        onDeleteCourse={() => setCourseDialog({ kind: 'delete', courseId: openCourse.id })}
      />
    ) : desktopV2View === 'courses' ? (
      <CoursesPage
        t={tDesktop}
        courses={coursesState.courses}
        recordings={recordingsInLibrary}
        capabilities={coursesState.capabilities}
        loading={coursesState.loading}
        error={coursesState.error}
        onRetry={() => void coursesState.refresh()}
        lectureStatus={lectureStatusOf}
        formatDuration={formatClock}
        onOpenCourse={(id) => setOpenCourseId(id)}
        onOpenLecture={openLectureDetail}
        onNewCourse={() => setCourseDialog({ kind: 'create' })}
        onRenameCourse={(id) => setCourseDialog({ kind: 'rename', courseId: id })}
        onDeleteCourse={(id) => setCourseDialog({ kind: 'delete', courseId: id })}
        recentlyDeletedCount={recentlyDeletedTotal}
        onOpenRecentlyDeleted={() => setCoursesV2DeletedOpen(true)}
      />
    ) : (
      /* Total fallback. `desktopV2View` is non-nullable and every case above is
         covered, so this is unreachable — but it is Courses rather than `null`
         because `null` is what selects the legacy shell, and no unforeseen
         state may put the user back there. */
      <CoursesPage
        t={tDesktop}
        courses={coursesState.courses}
        recordings={recordingsInLibrary}
        capabilities={coursesState.capabilities}
        loading={coursesState.loading}
        error={coursesState.error}
        onRetry={() => void coursesState.refresh()}
        lectureStatus={lectureStatusOf}
        formatDuration={formatClock}
        onOpenCourse={(id) => setOpenCourseId(id)}
        onOpenLecture={openLectureDetail}
        onNewCourse={() => setCourseDialog({ kind: 'create' })}
        onRenameCourse={(id) => setCourseDialog({ kind: 'rename', courseId: id })}
        onDeleteCourse={(id) => setCourseDialog({ kind: 'delete', courseId: id })}
        recentlyDeletedCount={recentlyDeletedTotal}
        onOpenRecentlyDeleted={() => setCoursesV2DeletedOpen(true)}
      />
    )

  const workspacePage =
    workspaceView === 'courses' ? (

      <section className="workspace-page courses-workspace-page" aria-labelledby="courses-title">
        <div className="workspace-page-head">
          <p className="yl-recording-strip__eyebrow">Workspace</p>
          <h1 id="courses-title">Courses</h1>
          <p>Manage courses and lecture recordings.</p>
        </div>
        <div className="courses-manager-card">
          <header className="courses-manager-toolbar">
            <label className="courses-search-field">
              <span>Search lectures</span>
              <div style={{ position: 'relative' }}>
                <input
                  type="search"
                  placeholder="Search title, course, transcript..."
                  aria-label="Search lectures"
                  value={coursesSearchQuery}
                  onChange={(e) => {
                    setCoursesSearchQuery(e.target.value)
                    setLibraryPickedIds([])
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setCoursesSearchQuery('')
                      setLibraryPickedIds([])
                    }
                  }}
                  style={{ width: '100%', boxSizing: 'border-box', paddingRight: coursesSearchQuery ? '2rem' : undefined }}
                />
                {coursesSearchQuery ? (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => {
                      setCoursesSearchQuery('')
                      setLibraryPickedIds([])
                    }}
                    style={{
                      position: 'absolute',
                      right: '0.6rem',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: '#6b7890',
                      fontSize: '1.1rem',
                      lineHeight: 1,
                      padding: '0 2px',
                    }}
                  >
                    ×
                  </button>
                ) : null}
              </div>
              <span style={{ fontSize: '0.72rem', color: '#9ba3af', marginTop: '0.2rem', lineHeight: 1.3 }}>
                Searches title, course, date, and loaded transcript/summary.
              </span>
            </label>
            <div className="courses-toolbar-actions">
              {!newFolderInputVisible ? (
                <button type="button" className="btn ghost small" onClick={createFolder}>
                  New folder
                </button>
              ) : null}
              <button
                type="button"
                className="btn ghost small"
                disabled={courseView.type === 'recentlyDeleted'}
                onClick={() => {
                  if (libraryPickMode) {
                    setLibraryPickMode(false)
                    setLibraryPickedIds([])
                  } else {
                    setLibraryPickMode(true)
                    setLibraryPickedIds([])
                    setSelectedId(null)
                  }
                }}
              >
                {libraryPickMode ? 'Done' : 'Select'}
              </button>
              {libraryPickMode ? (
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() =>
                    setLibraryPickedIds(
                      coursesSearchQuery.trim()
                        ? filteredCourseRecordings.map((r) => r.id)
                        : courseViewLectureIds,
                    )
                  }
                >
                  {primaryScopedSelectLabel}
                </button>
              ) : null}
              <button
                type="button"
                className="btn ghost small"
                disabled={coursesDeleteDisabled}
                onClick={handleCoursesDelete}
              >
                {deleteActionBusy ? 'Working…' : 'Delete'}
              </button>
            </div>
          </header>

          {newFolderInputVisible ? (
            <div className="courses-inline-create">
              <input
                type="text"
                autoFocus
                placeholder="Folder name"
                value={newFolderInputValue}
                onChange={(e) => setNewFolderInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmNewFolder()
                  if (e.key === 'Escape') {
                    setNewFolderInputVisible(false)
                    setNewFolderInputValue('')
                  }
                }}
                onBlur={confirmNewFolder}
              />
            </div>
          ) : null}

          {libraryFolderNotice ? (
            <div className="courses-notice" role="status">
              {libraryFolderNotice}
            </div>
          ) : null}

          {(libraryPickMode || libraryPickedIds.length > 0) ? (
            <div className="yl-library-multiselect-banner">
              <span className="yl-library-multiselect-count">
                {libraryPickMode ? validPickedLectureCount : libraryPickedIds.length} selected
              </span>
              <button type="button" className="btn ghost small" onClick={() => setLibraryPickedIds([])}>
                Clear selection
              </button>
            </div>
          ) : null}

          <DndContext
            sensors={sensors}
            collisionDetection={pointerWithin}
            onDragStart={handleDndStart}
            onDragOver={handleDndOver}
            onDragCancel={handleDndCancel}
            onDragEnd={handleDndEnd}
          >
          <div className="courses-manager-grid">
            <aside className="courses-scope-list" aria-label="Courses and folders">
              <button
                type="button"
                className={`courses-scope-item${courseView.type === 'all' ? ' is-active' : ''}`}
                onClick={() => {
                  setCourseView({ type: 'all' })
                  setLibraryActiveScope({ kind: 'all' })
                  setSelectedId(null)
                  setLibraryPickedIds([])
                  setLibraryPickMode(false)
                }}
              >
                <span>All lectures</span>
                <small>{recordingsInLibrary.length}</small>
              </button>
              <button
                type="button"
                className={`courses-scope-item${courseView.type === 'recentlyDeleted' ? ' is-active' : ''}`}
                onClick={() => {
                  setCourseView({ type: 'recentlyDeleted' })
                  setSelectedId(null)
                  setLibraryPickedIds([])
                  setLibraryPickMode(false)
                }}
              >
                <span>Recently deleted</span>
                <small>{trashTotalCount}</small>
              </button>
              <DroppableLibraryTarget
                dropId="unfiled"
                activeDropId={dropTargetFolderId}
                className="courses-scope-drop"
              >
                <button
                  type="button"
                  className={`courses-scope-item${courseView.type === 'unfiled' ? ' is-active' : ''}`}
                  onClick={() => {
                    setCourseView({ type: 'unfiled' })
                    setLibraryActiveScope({ kind: 'unfiled' })
                    setSelectedId(null)
                    setLibraryPickedIds([])
                    setLibraryPickMode(false)
                  }}
                >
                  <span>Unfiled</span>
                  <small>{unfiledRecordings.length}</small>
                </button>
              </DroppableLibraryTarget>
              {libraryFolders
                .slice()
                .sort((a, b) => b.createdAt - a.createdAt)
                .map((folder) => (
                  <DroppableLibraryTarget
                    key={folder.id}
                    dropId={folder.id}
                    activeDropId={dropTargetFolderId}
                    className="courses-scope-drop"
                  >
                    <button
                      type="button"
                      className={`courses-scope-item${
                        courseView.type === 'folder' && courseView.folderId === folder.id ? ' is-active' : ''
                      }`}
                      onClick={() => {
                        setCourseView({ type: 'folder', folderId: folder.id })
                        setLibraryActiveScope({ kind: 'folder', folderId: folder.id })
                        setSelectedId(null)
                        setLibraryPickedIds([])
                        setLibraryPickMode(false)
                      }}
                    >
                      <span>{folder.name}</span>
                      <small>{folderRecordingsMap[folder.id]?.length ?? 0}</small>
                    </button>
                  </DroppableLibraryTarget>
                ))}
            </aside>

            <section className="courses-lecture-list" aria-label="Saved lectures">
              <div className="courses-lecture-list-head">
                <div>
                  <h2>{activeCourseScopeLabel}</h2>
                  <p>
                    {activeCourseLectureCount} lecture{activeCourseLectureCount === 1 ? '' : 's'}
                    {coursesSearchQuery.trim() ? ` for "${coursesSearchQuery.trim()}"` : ''}
                  </p>
                </div>
              </div>
              {pendingUploads.length > 0 && (
                <div
                  role="region"
                  aria-label="Pending uploads"
                  style={{
                    margin: '0 0 14px',
                    border: '1px solid rgba(6,27,52,0.14)',
                    background: 'rgba(255,255,255,0.72)',
                    borderRadius: 12,
                    padding: '12px 14px',
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, color: '#334155' }}>
                    Pending uploads · {pendingUploads.length}
                  </div>
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12 }}>
                    {pendingUploads.map((p) => (
                      <li
                        key={p.id}
                        style={{ display: 'flex', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between' }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 14 }}>{p.title}</div>
                          <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                            {/* A legacy pending upload with no canonical course must never
                                display its stale text label as if it still owns that Course. */}
                            {pendingUploadNeedsCourseChoice(p) ? 'Choose course' : p.course} ·{' '}
                            {Math.max(1, Math.round(p.durationSec / 60))} min · {pendingStatusLabel(p)}
                          </div>
                          <div style={{ fontSize: 12, color: '#8492a6', marginTop: 4, lineHeight: 1.45 }}>
                            {pendingStatusDetail(p)}
                          </div>
                          {pendingUploadNeedsCourseChoice(p) ? (
                            <select
                              aria-label="Choose course before retrying this pending upload"
                              value=""
                              disabled={p.state === 'uploading'}
                              onChange={(e) => {
                                if (e.target.value) void handleAssignPendingUploadCourse(p.id, e.target.value)
                              }}
                              style={{ fontSize: 12, marginTop: 6 }}
                            >
                              <option value="" disabled>
                                Choose course
                              </option>
                              {coursesState.courses.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                            </select>
                          ) : null}
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                          <button
                            type="button"
                            className="btn small"
                            disabled={p.state === 'uploading' || pendingUploadNeedsCourseChoice(p)}
                            onClick={() => void handleRetryPendingUpload(p.id)}
                          >
                            {p.state === 'uploading' ? 'Uploading…' : 'Retry upload'}
                          </button>
                          <button
                            type="button"
                            className="btn ghost small"
                            disabled={p.state === 'uploading'}
                            onClick={() => void handleDeletePendingUpload(p.id)}
                          >
                            Delete
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {courseView.type === 'recentlyDeleted' ? (
                <div className="courses-trash-panel">
                  <h3>Recently Deleted</h3>
                  {trashTotalCount === 0 ? (
                    <p className="muted small">Trash is empty.</p>
                  ) : filteredTrashRows.length === 0 ? (
                    <div className="courses-empty-list">
                      <h3>No lectures found.</h3>
                      <p>Try another keyword or switch to All lectures.</p>
                    </div>
                  ) : (
                    <ul>
                      {filteredTrashRows.map((row) => (
                        <li key={row.id}>
                          <span>{row.title}</span>
                          <button type="button" className="btn ghost small" disabled={deleteActionBusy} onClick={() => void restoreLecturesFromTrash([row.id])}>
                            Restore
                          </button>
                          <button type="button" className="btn ghost small" disabled={deleteActionBusy} onClick={() => setPermanentPurgeModal([row.id])}>
                            Delete forever
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : filteredCourseRecordings.length === 0 ? (
                <div className="courses-empty-list">
                  {coursesSearchQuery.trim() ? (
                    <>
                      <h3>No lectures found.</h3>
                      <p>Try another keyword or switch to All lectures.</p>
                    </>
                  ) : (
                    <>
                      <h3>No lectures here yet.</h3>
                      <p>Saved recordings for this course or folder will appear here.</p>
                    </>
                  )}
                </div>
              ) : (
                <ul className="courses-recording-list">
                  {filteredCourseRecordings.map((recording) => (
                    <li key={recording.id}>
                      <DraggableCourseRecordingCard
                        recording={recording}
                        selected={recording.id === selectedId}
                        dragging={draggingRecordingId === recording.id}
                        pickMode={libraryPickMode}
                        picked={libraryPickedIds.includes(recording.id)}
                        onRowClick={handleLectureRowClick(recording.id)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
          <DragOverlay>
            {dragOverlayRecordingId ? (
              <div className="courses-drag-preview">
                {recordings.find((r) => r.id === dragOverlayRecordingId)?.title ?? 'Lecture'}
              </div>
            ) : null}
          </DragOverlay>
          </DndContext>
        </div>
      </section>
    ) : legacySettingsEnabled ? (
      <section className="workspace-page workspace-placeholder-page" aria-labelledby="settings-title">
        <div className="workspace-page-head">
          <p className="yl-recording-strip__eyebrow">Workspace</p>
          <h1 id="settings-title">Settings</h1>
          <p>Preferences &amp; account</p>
        </div>
        <div className="settings-placeholder-grid">
          <div className="settings-top-grid">

          {/* ── 1. Account & Access ─────────────────────────────────────────── */}
          {localOnly ? (
            <section className="workspace-placeholder-card settings-card settings-card--account">
              <h2>Account &amp; Access</h2>
              <div className="settings-account-row">
                <AccountAvatar initials={deriveInitials(userEmail, profileRow?.username)} />
                <div className="settings-account-identity">
                  <div className="settings-account-email">Local only</div>
                  <span className="settings-access-pill">Free Access</span>
                </div>
              </div>
              <div className="settings-card-divider" />
              <p className="settings-muted-copy">
                Sign in to share usage across iPad and Mac.
              </p>
              <p className="settings-card-footnote settings-card-footnote--with-action">
                <span>Plans require a signed-in account</span>
                <button
                  type="button"
                  className="settings-footnote-action"
                  onClick={() => setBillingPlanOpen(true)}
                >
                  View plans
                </button>
              </p>
            </section>
          ) : (
            <section className="workspace-placeholder-card settings-card settings-card--account">
              <h2>Account &amp; Access</h2>
              <div className="settings-account-row">
                <AccountAvatar initials={deriveInitials(userEmail, profileRow?.username)} />
                <div className="settings-account-identity">
                  {userEmail ? (
                    <div className="settings-account-email">{userEmail}</div>
                  ) : null}
                  <span className="settings-access-pill">
                    {getDisplayAccessLabel(sidebarPlanUsage)}
                    {sidebarPlanUsage.source === 'fallback' && (
                      <span className="settings-access-pill__status">loading…</span>
                    )}
                  </span>
                </div>
                {onSignOut ? (
                  <button
                    type="button"
                    className="btn ghost small settings-outline-button"
                    onClick={onSignOut}
                  >
                    Sign out
                  </button>
                ) : null}
              </div>

              <div className="settings-card-divider" />

              <div className="settings-usage-stack">
                {sidebarPlanUsage.unlimited ? (
                  <div className="settings-unlimited-copy">
                    <span>{getDisplayAccessLabel(sidebarPlanUsage)}</span>
                    <strong>Unlimited access</strong>
                  </div>
                ) : (
                  <>
                    <div className="settings-usage-meter">
                      <SettingsUsageRow
                        label="Monthly"
                        value={`${formatLoadingNumber(sidebarPlanUsage.minutesUsed)} / ${formatLoadingNumber(sidebarPlanUsage.minutesLimit)} min`}
                      />
                      <UsageBar
                        used={sidebarPlanUsage.minutesUsed}
                        limit={sidebarPlanUsage.minutesLimit}
                        height={3}
                      />
                    </div>
                    <div className="settings-usage-meter">
                      <SettingsUsageRow
                        label="Today"
                        value={`${formatLoadingNumber(sidebarPlanUsage.dailyMinutesUsed)} / ${formatLoadingNumber(sidebarPlanUsage.dailyMinutesLimit)} min`}
                      />
                      <UsageBar
                        used={sidebarPlanUsage.dailyMinutesUsed}
                        limit={sidebarPlanUsage.dailyMinutesLimit}
                        height={3}
                      />
                    </div>
                    <div className="settings-usage-meter">
                      <SettingsUsageRow
                        label="Recordings"
                        value={`${formatLoadingNumber(sidebarPlanUsage.recordingsUsedToday)} / ${formatLoadingNumber(sidebarPlanUsage.maxRecordingsPerDay)}`}
                      />
                      <UsageBar
                        used={sidebarPlanUsage.recordingsUsedToday}
                        limit={sidebarPlanUsage.maxRecordingsPerDay}
                        height={3}
                      />
                    </div>
                  </>
                )}
              </div>

              <p className="settings-card-footnote settings-card-footnote--with-action">
                <span>Shared across iPad and Mac</span>
                <span className="settings-footnote-actions">
                  <button
                    type="button"
                    className="settings-footnote-action"
                    onClick={() => setBillingPlanOpen(true)}
                  >
                    View plan
                  </button>
                  <button
                    type="button"
                    className="settings-footnote-action"
                    onClick={() => setAccessUsageOpen(true)}
                  >
                    View details
                  </button>
                </span>
              </p>
            </section>
          )}

          {/* ── 2. Lecture Defaults ─────────────────────────────────────────── */}
          <section className="workspace-placeholder-card settings-card settings-card--defaults">
            <h2>Lecture Defaults</h2>
            <div className="settings-chip-list">
              <SettingsChipRow label="Spoken language" chips={['English']} />
              <SettingsChipRow label="Translation" chips={['Chinese Simplified']} />
              <SettingsChipRow label="Output" chips={['Transcript + Summary']} />
              <SettingsChipRow label="Overlay" chips={['Overlay captions']} />
            </div>
            <p className="settings-card-footnote">
              Configurable language and output controls are coming soon.
            </p>
          </section>
          </div>

          {/* ── 3. Feedback & Support (spans full row) ──────────────────────── */}
          <section className="workspace-placeholder-card settings-card settings-card--support">
            <h2>Feedback &amp; Support</h2>
            <p className="settings-support-copy">
              Youmi Lens is available as a free educational tool. Please report issues with
              recording, live captions, translation, summary generation, or overlay display.
            </p>
            <div className="settings-support-row">
              <button
                type="button"
                onClick={() => void openExternalContact(SUPPORT_CONTACT_URL)}
                title="Email Youmi Lens support"
                className="settings-support-email"
              >
                youmilens@gmail.com
              </button>
              <button
                type="button"
                className="btn ghost small settings-outline-button"
                onClick={() => {
                  void navigator.clipboard.writeText('youmilens@gmail.com').catch(() => {})
                }}
              >
                Copy
              </button>
              <button
                type="button"
                className="btn ghost small settings-outline-button"
                onClick={() => void openExternalContact(SUPPORT_CONTACT_URL)}
              >
                Email support
              </button>
            </div>
          </section>

        </div>
      </section>
    ) : undefined

  return (
    <>
      {showAccountPanel ? (
        <AccountSettingsModal
          open={accountSettingsOpen}
          onClose={() => setAccountSettingsOpen(false)}
          supabase={supabase}
          userId={userId}
          accountEmail={userEmail}
          profile={profileRow ?? null}
          onSaved={(row) => onProfileRowChange(row)}
          onSignOut={() => {
            setAccountSettingsOpen(false)
            onSignOut?.()
          }}
          onAccountDeleted={() => {
            setAccountSettingsOpen(false)
            onSignOut?.()
          }}
        />
      ) : null}
      {showAccountPanel && supabase ? (
        <AccessUsageModal
          open={accessUsageOpen}
          onClose={() => setAccessUsageOpen(false)}
          supabase={supabase}
        />
      ) : null}
      <BillingPlanModal open={billingPlanOpen} onClose={() => setBillingPlanOpen(false)} />
      {trashConfirmModal ? (
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1250,
            background: 'rgba(15, 23, 42, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1rem',
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setTrashConfirmModal(null)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="yl-trash-confirm-title"
            style={{
              background: 'var(--yl-card, #fff)',
              borderRadius: '10px',
              padding: '1.15rem',
              maxWidth: 'min(440px, 100%)',
              boxShadow: '0 12px 40px rgba(0,0,0,0.12)',
              border:
                trashConfirmModal.scope.kind === 'global'
                  ? '2px solid rgba(185, 28, 28, 0.85)'
                  : '1px solid var(--yl-border, #e2e8f0)',
            }}
          >
            <h3 id="yl-trash-confirm-title" style={{ margin: '0 0 0.65rem', fontSize: '1.05rem' }}>
              Move to Recently deleted?
            </h3>
            <p style={{ margin: '0 0 0.5rem', fontWeight: 600 }}>
              {trashConfirmPrimaryLine(trashConfirmModal.scope, trashConfirmModal.ids.length)}
            </p>
            <p style={{ margin: '0 0 0.65rem', fontSize: '0.875rem', lineHeight: 1.45, color: '#475569' }}>
              Lectures go to <strong>Recently deleted</strong> first. You can restore them from there, or permanently
              delete them later.
            </p>
            {/* Truthful scope: lecture deletion is a per-device registry today,
                so this must not read as a cross-device delete. */}
            <p style={{ margin: '0 0 0.65rem', fontSize: '0.8rem', lineHeight: 1.45, color: '#844309' }}>
              {tDesktop('deleted.lectureScopeNotice')}
            </p>
            {trashConfirmModal.scope.kind === 'global' ? (
              <p
                style={{
                  margin: '0 0 0.85rem',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  color: '#b91c1c',
                }}
              >
                Warning: this selection spans beyond your current folder view — it affects multiple areas of your
                library.
              </p>
            ) : null}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button type="button" className="btn ghost small" onClick={() => setTrashConfirmModal(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary small"
                disabled={deleteActionBusy}
                aria-busy={deleteActionBusy}
                onClick={() => {
                  const ids = trashConfirmModal.ids
                  void (async () => {
                    await commitMoveToTrash(ids)
                    setTrashConfirmModal(null)
                  })()
                }}
              >
                {deleteActionBusy ? 'Working…' : 'Move to Recently deleted'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {permanentPurgeModal ? (
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1260,
            background: 'rgba(15, 23, 42, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1rem',
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPermanentPurgeModal(null)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="yl-permanent-purge-title"
            style={{
              background: 'var(--yl-card, #fff)',
              borderRadius: '10px',
              padding: '1.15rem',
              maxWidth: 'min(440px, 100%)',
              boxShadow: '0 12px 40px rgba(0,0,0,0.12)',
              border: '2px solid rgba(185, 28, 28, 0.85)',
            }}
          >
            <h3 id="yl-permanent-purge-title" style={{ margin: '0 0 0.65rem', fontSize: '1.05rem', color: '#991b1b' }}>
              Permanently delete?
            </h3>
            <p style={{ margin: '0 0 0.65rem', fontSize: '0.875rem', lineHeight: 1.45, color: '#334155' }}>
              This removes {permanentPurgeModal.length} lecture{permanentPurgeModal.length === 1 ? '' : 's'}{' '}
              {localOnly ? 'from this device' : 'from your account (database and audio storage)'} — not recoverable from
              the app.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button type="button" className="btn ghost small" onClick={() => setPermanentPurgeModal(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary small"
                style={{ background: '#dc2626', borderColor: '#b91c1c' }}
                disabled={deleteActionBusy}
                aria-busy={deleteActionBusy}
                onClick={() => {
                  const ids = permanentPurgeModal
                  void (async () => {
                    try {
                      await permanentlyPurgeLectures(ids)
                      setPermanentPurgeModal(null)
                    } catch (e) {
                      setLibraryFolderNotice(e instanceof Error ? e.message : String(e))
                    }
                  })()
                }}
              >
                {deleteActionBusy ? 'Working…' : 'Delete forever'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {folderDeleteModal ? (
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1260,
            background: 'rgba(15, 23, 42, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1rem',
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setFolderDeleteModal(null)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="yl-folder-delete-title"
            style={{
              background: 'var(--yl-card, #fff)',
              borderRadius: '10px',
              padding: '1.15rem',
              maxWidth: 'min(420px, 100%)',
              boxShadow: '0 12px 40px rgba(0,0,0,0.12)',
              border: '1px solid var(--yl-border, #e2e8f0)',
            }}
          >
            <h3 id="yl-folder-delete-title" style={{ margin: '0 0 0.5rem', fontSize: '1.05rem' }}>
              Delete folder?
            </h3>
            <p style={{ margin: '0 0 0.85rem', fontSize: '0.875rem', lineHeight: 1.45, color: '#475569' }}>
              Delete folder <strong>"{folderDeleteModal.folderName}"</strong>? Lectures inside it will not be deleted —
              they will become unfiled.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button type="button" className="btn ghost small" onClick={() => setFolderDeleteModal(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary small"
                onClick={() => {
                  const { folderId } = folderDeleteModal
                  console.log('[CoursesDelete] folderDeleteModal confirmed', { folderId })
                  deleteFolderIfEmpty(folderId)
                  setCourseView({ type: 'all' })
                  setLibraryActiveScope({ kind: 'all' })
                  setSelectedId(null)
                  setLibraryPickedIds([])
                  setFolderDeleteModal(null)
                }}
              >
                Delete folder
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {editLectureModal ? (
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1270,
            background: 'rgba(15, 23, 42, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1rem',
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setEditLectureModal(null)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="yl-edit-lecture-title"
            style={{
              background: 'var(--yl-card, #fff)',
              borderRadius: '10px',
              padding: '1rem',
              minWidth: 'min(360px, 100%)',
              boxShadow: '0 12px 40px rgba(0,0,0,0.12)',
              border: '1px solid var(--yl-border, #e2e8f0)',
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 id="yl-edit-lecture-title" style={{ margin: '0 0 0.75rem', fontSize: '1rem' }}>
              Edit lecture
            </h3>
            <label className="field" style={{ display: 'block', marginBottom: '0.65rem' }}>
              <span>Course</span>
              <input
                type="text"
                className="input"
                value={editLectureModal.courseDraft}
                disabled={lectureMetadataBusy}
                onChange={(e) =>
                  setEditLectureModal((prev) =>
                    prev ? { ...prev, courseDraft: e.target.value, error: null } : null,
                  )
                }
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
            </label>
            <label className="field" style={{ display: 'block', marginBottom: '0.75rem' }}>
              <span>Title</span>
              <input
                type="text"
                className="input"
                value={editLectureModal.titleDraft}
                disabled={lectureMetadataBusy}
                onChange={(e) =>
                  setEditLectureModal((prev) =>
                    prev ? { ...prev, titleDraft: e.target.value, error: null } : null,
                  )
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitEditLectureModal()
                }}
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
            </label>
            <p className="muted small" style={{ margin: '0 0 0.75rem' }}>
              Empty fields keep your current course or title. If both would be empty, course defaults to
              &quot;Untitled course&quot; and title to a dated lecture name.
            </p>
            {editLectureModal.error && (
              <p style={{ margin: '-0.25rem 0 0.65rem', fontSize: '0.82rem', color: '#c0392b' }}>
                {editLectureModal.error}
              </p>
            )}
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn ghost small"
                disabled={lectureMetadataBusy}
                onClick={() => setEditLectureModal(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn ghost small"
                disabled={lectureMetadataBusy}
                aria-busy={lectureMetadataBusy}
                onClick={() => void commitEditLectureModal()}
              >
                {lectureMetadataBusy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {/* EITHER the V2 shell OR the legacy shell — never both, and the hidden
          one is not rendered at all rather than suppressed with CSS. */}
      {/* Course dialogs. Portaled to <body> from inside, so they escape the
          card and row overflow clips. */}
      {courseDialog?.kind === 'create' ? (
        <CreateCourseDialog
          t={tDesktop}
          busy={coursesState.busy}
          error={coursesState.mutationError}
          nameConflicts={(name) => coursesState.nameConflicts(name)}
          onCancel={() => {
            coursesState.clearMutationError()
            setCourseDialog(null)
          }}
          onCreate={(name, preset) => {
            void coursesState.create({ name, preset }).then((created) => {
              if (!created) return
              setCourseDialog(null)
              // Creating a course selects it, matching the iPad store.
              setCourse(created.name)
              setRecordingCourseId(created.id)
            })
          }}
        />
      ) : null}
      {courseDialog?.kind === 'rename' && dialogCourse ? (
        <RenameCourseDialog
          t={tDesktop}
          course={dialogCourse}
          busy={coursesState.busy}
          error={coursesState.mutationError}
          nameConflicts={coursesState.nameConflicts}
          onCancel={() => {
            coursesState.clearMutationError()
            setCourseDialog(null)
          }}
          onRename={(name) => {
            const previous = dialogCourse.name
            void coursesState.rename(dialogCourse.id, name).then((ok) => {
              if (!ok) return
              setCourseDialog(null)
              // The repository dual-writes the legacy label; mirror it into the
              // in-memory recordings so the UI does not need a full refetch.
              setRecordings((rows) =>
                rows.map((row) =>
                  (row.courseId && row.courseId === dialogCourse.id) ||
                  (row.course ?? '').trim().toLowerCase() === previous.trim().toLowerCase()
                    ? { ...row, course: name }
                    : row,
                ),
              )
              // Record Home's own selection is reconciled by the
              // selectedCourseRecord effect once coursesState.courses reflects
              // the rename — no name-matching patch needed here.
            })
          }}
        />
      ) : null}
      {courseDialog?.kind === 'delete' && dialogCourse ? (
        <DeleteCourseDialog
          t={tDesktop}
          course={dialogCourse}
          lectureCount={
            lecturesInCourse(dialogCourse.id, recordingsInLibrary, coursesState.courses).length
          }
          busy={coursesState.busy}
          error={coursesState.mutationError}
          onCancel={() => {
            coursesState.clearMutationError()
            setCourseDialog(null)
          }}
          onDelete={() => {
            void coursesState.softDelete(dialogCourse.id).then((ok) => {
              if (!ok) return
              setCourseDialog(null)
              if (openCourseId === dialogCourse.id) setOpenCourseId(null)
            })
          }}
        />
      ) : null}
      {lectureDialog && dialogLecture ? (
        lectureDialog.kind === 'rename' ? (
          <RenameLectureDialog
            t={tDesktop}
            currentTitle={dialogLecture.title?.trim() || ''}
            identity={lectureIdentity(dialogLectureCourse)}
            busy={lectureMetadataBusy}
            error={lectureDialogError}
            onCancel={() => setLectureDialog(null)}
            onRename={(title) => {
              void renameLecture(dialogLecture.id, title).then((ok) => {
                if (ok) setLectureDialog(null)
              })
            }}
          />
        ) : lectureDialog.kind === 'move' ? (
          <MoveLectureDialog
            t={tDesktop}
            lectureTitle={dialogLecture.title?.trim() || tDesktop('recording.untitled')}
            courses={coursesState.courses}
            currentCourseId={dialogLectureCourse?.id ?? null}
            busy={coursesState.busy}
            error={lectureDialogError}
            onCancel={() => setLectureDialog(null)}
            onMove={(courseId) => {
              void moveLectureToCourse(dialogLecture.id, courseId).then((ok) => {
                if (ok) setLectureDialog(null)
              })
            }}
          />
        ) : (
          <DeleteLectureDialog
            t={tDesktop}
            lectureTitle={dialogLecture.title?.trim() || tDesktop('recording.untitled')}
            identity={lectureIdentity(dialogLectureCourse)}
            busy={deleteActionBusy}
            error={lectureDialogError}
            onCancel={() => setLectureDialog(null)}
            onDelete={() => {
              // The existing production trash path, unchanged.
              void commitMoveToTrash([dialogLecture.id]).then(() => {
                setLectureDialog(null)
                setWorkspaceView('courses')
              })
            }}
          />
        )
      ) : null}
      {purgeDialog?.kind === 'course' && purgeCourse ? (
        <ConfirmPurgeDialog
          t={tDesktop}
          title={tDesktop('deleted.purgeCourseTitle')}
          body={tDesktop('deleted.purgeCourseBody')}
          itemName={purgeCourse.name}
          identity={courseIdentity(purgeCourse)}
          busy={coursesState.busy}
          error={coursesState.mutationError}
          onCancel={() => {
            coursesState.clearMutationError()
            setPurgeDialog(null)
          }}
          onConfirm={() => {
            void coursesState.purge(purgeCourse.id).then((ok) => {
              if (ok) setPurgeDialog(null)
            })
          }}
        />
      ) : null}
      {purgeDialog?.kind === 'lecture' && purgeLecture ? (
        <ConfirmPurgeDialog
          t={tDesktop}
          title={tDesktop('deleted.purgeLectureTitle')}
          body={tDesktop('deleted.purgeLectureBody')}
          itemName={purgeLecture.title}
          identity={lectureIdentity(
            courseToRestoreWithLecture(purgeLecture, coursesState.courses) ??
              courseToRestoreWithLecture(purgeLecture, coursesState.deletedCourses),
          )}
          busy={deleteActionBusy}
          error={null}
          onCancel={() => setPurgeDialog(null)}
          onConfirm={() => {
            // The existing production purge: it removes the row, its audio
            // object and the local copy. Nothing about it changes here.
            void permanentlyPurgeLectures([purgeLecture.id]).finally(() => setPurgeDialog(null))
          }}
        />
      ) : null}
      {discardConfirmOpen ? (
        <ConfirmPurgeDialog
          t={tDesktop}
          title={tDesktop('recording.discardTitle')}
          body={tDesktop('recording.discardBody')}
          itemName={title.trim() || tDesktop('recording.untitled')}
          identity={activeCourseIdentity}
          confirmLabel={tDesktop('recording.discard')}
          busy={saveOrFinishBusy}
          error={null}
          onCancel={() => setDiscardConfirmOpen(false)}
          onConfirm={() => {
            setDiscardConfirmOpen(false)
            discardRecording()
          }}
        />
      ) : null}
      {desktopV2Page ? (
        <DesktopV2Shell
          activeView={
            // While recording, Record stays the active destination whatever the
            // sidebar was last asked for: the Recording screen outranks every
            // other view, so the sidebar must not claim otherwise.
            desktopV2View === 'recording'
              ? 'record'
              : workspaceView === 'settings'
                ? 'settings'
                : workspaceView === 'courses' || workspaceView === 'lecture'
                  ? 'courses'
                  : 'record'
          }
          onNavigate={(view) => {
            // Leaving Courses closes any open Course Detail and Recently
            // Deleted, so returning later lands on the list rather than on a
            // stale sub-page.
            if (view !== 'courses') {
              setOpenCourseId(null)
              setCoursesV2DeletedOpen(false)
            }
            setWorkspaceView(view)
          }}
          toolbarTitle={
            desktopV2View === 'settings'
              ? tDesktop('settings.title')
              : desktopV2View === 'recording'
                ? tDesktop('nav.record')
                : desktopV2View === 'lecture' && openLecture
                  ? openLecture.title?.trim() || tDesktop('recording.untitled')
                  : desktopV2View === 'recentlyDeleted'
                  ? tDesktop('courses.recentlyDeleted')
                  : desktopV2View === 'courseDetail' && openCourse
                    ? openCourse.name
                    : desktopV2View === 'courses'
                      ? tDesktop('courses.title')
                      : tDesktop('nav.record')
          }
          accountName={profileRow?.username?.trim() || userLabel}
          accountPlan={localOnly ? 'Local only' : getDisplayAccessLabel(sidebarPlanUsage)}
          onAccountClick={showAccountPanel ? () => setAccountSettingsOpen(true) : undefined}
        >
          {desktopV2Page}
        </DesktopV2Shell>
      ) : (
      <YoumiLensShell
      workspacePage={workspacePage}
      showWorkspaceSummary={workspaceView === 'courses'}
      welcomeLine={!localOnly ? welcomeLine : undefined}
      topBarActions={
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
            maxWidth: 'min(720px, 94vw)',
          }}
        >
          <span style={{ color: 'rgba(248,250,252,0.9)', fontSize: '0.8rem', lineHeight: 1.45 }}>
            {localOnly ? (
              <>
                <strong>{userLabel}</strong>. Data stays in this browser only — export ZIP backups from the
                library. Reload after installing a cloud-enabled build to sign in and sync.
                {onReloadAfterCloudEnv && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="btn ghost small"
                      style={{ marginLeft: '0.35rem', verticalAlign: 'middle' }}
                      onClick={() => {
                        try {
                          localStorage.removeItem(LC_USE_LOCAL_KEY)
                        } catch {
                          /* ignore */
                        }
                        window.location.reload()
                      }}
                    >
                      Reload to try cloud sign-in
                    </button>
                  </>
                )}
              </>
            ) : (
              <>
                Signed in as <strong>{userLabel}</strong>
              </>
            )}
          </span>
          {showAccountPanel ? (
            <button
              type="button"
              className="btn ghost small"
              onClick={() => setAccountSettingsOpen(true)}
            >
              Account
            </button>
          ) : null}
          {!localOnly && onSignOut && !showAccountPanel ? (
            <button
              type="button"
              className={`btn ghost small${signOutBusy ? ' is-busy' : ''}`}
              disabled={signOutBusy}
              aria-busy={signOutBusy}
              onClick={() => {
                if (signOutBusy) return
                setSignOutBusy(true)
                void Promise.resolve(onSignOut?.()).finally(() => {
                  setSignOutBusy(false)
                })
              }}
            >
              {signOutBusy ? 'Signing out…' : 'Sign out'}
            </button>
          ) : null}
        </div>
      }
      sidebar={
        <>
          <div className="yl-nav-section">
            <div className="yl-nav-section-label">Workspace</div>
            <nav className="yl-nav" aria-label="Workspace">
              <button
                type="button"
                className={`yl-nav-item${workspaceView === 'record' ? ' yl-active' : ''}`}
                onClick={() => setWorkspaceView('record')}
              >
                <span className="yl-nav-icon" aria-hidden>⌕</span>
                <span className="yl-nav-copy">
                  <strong>Record</strong>
                  <small>Start a new lecture</small>
                </span>
              </button>
              <button
                type="button"
                className={`yl-nav-item${workspaceView === 'courses' ? ' yl-active' : ''}`}
                onClick={() => setWorkspaceView('courses')}
              >
                <span className="yl-nav-icon" aria-hidden>▤</span>
                <span className="yl-nav-copy">
                  <strong>Courses</strong>
                  <small>Manage your courses</small>
                </span>
              </button>
              <button
                type="button"
                className={`yl-nav-item${workspaceView === 'settings' ? ' yl-active' : ''}`}
                onClick={() => setWorkspaceView('settings')}
              >
                <span className="yl-nav-icon" aria-hidden>⚙</span>
                <span className="yl-nav-copy">
                  <strong>Settings</strong>
                  <small>Preferences & account</small>
                </span>
              </button>
            </nav>
          </div>
          <UpdaterEntry
            recordingSafety={{
              recorderStatus: recorder.status as 'idle' | 'recording' | 'paused',
              saveInFlight: saveOrFinishBusy,
              recoveringSession: Boolean(recoveryBusyId),
            }}
          />
          <div className="yl-sidebar-divider record-sidebar-admin-hidden" aria-hidden />
          <div
            id="yl-library"
            className="yl-history-section list-panel record-sidebar-admin-hidden"
            aria-hidden="true"
          >
            <div className="yl-nav-section-label yl-nav-section-label--secondary yl-library-head">
              <span>
                Lectures
                <span className="yl-library-build-marker">UI build: {UI_BUILD_MARKER}</span>
              </span>
              {!newFolderInputVisible && (
                <button type="button" className="btn ghost small" onClick={createFolder}>
                  New folder
                </button>
              )}
            </div>
            {libraryFolderNotice ? (
              <div
                role="status"
                style={{
                  padding: '6px 10px',
                  fontSize: 12,
                  color: '#92400e',
                  background: '#fffbeb',
                  borderBottom: '1px solid #fcd34d',
                }}
              >
                {libraryFolderNotice}
              </div>
            ) : null}
            {newFolderInputVisible && (
              <div style={{ padding: '4px 8px 6px' }}>
                <input
                  type="text"
                  autoFocus
                  placeholder="Folder name"
                  value={newFolderInputValue}
                  onChange={(e) => setNewFolderInputValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmNewFolder()
                    if (e.key === 'Escape') { setNewFolderInputVisible(false); setNewFolderInputValue('') }
                  }}
                  onBlur={confirmNewFolder}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    fontSize: '13px',
                    padding: '4px 8px',
                    borderRadius: '6px',
                    border: '1px solid var(--yl-border, #e2e8f0)',
                    outline: 'none',
                  }}
                />
              </div>
            )}

            <div className="yl-library-toolbar">
              <div className="yl-library-toolbar__row">
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() => {
                    if (libraryPickMode) {
                      setLibraryPickMode(false)
                      setLibraryPickedIds([])
                    } else {
                      setLibraryPickMode(true)
                      setLibraryPickedIds([])
                      setSelectedId(null)
                    }
                  }}
                >
                  {libraryPickMode ? 'Done' : 'Select'}
                </button>
                {libraryPickMode ? (
                  <>
                    <button
                      type="button"
                      className="btn primary small"
                      onClick={() => setLibraryPickedIds(visibleLectureIds)}
                    >
                      {primaryScopedSelectLabel}
                    </button>
                    <button type="button" className="btn ghost small" onClick={() => setLibraryPickedIds([])}>
                      Clear
                    </button>
                    <button
                      type="button"
                      className="btn ghost small"
                      disabled={!deleteSelectedEnabled}
                      onClick={() => handleDeleteSelectedLectures()}
                    >
                      {deleteActionBusy ? 'Working…' : 'Delete selected…'}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn ghost small"
                      disabled={deleteActionBusy || libraryPickMode}
                      title={
                        libraryActiveScope.kind !== 'folder'
                          ? 'Select a folder first.'
                          : selectedFolderLectureCount > 0
                            ? 'Only empty folders can be deleted. Move or delete lectures first.'
                            : 'Delete this empty folder'
                      }
                      onClick={() =>
                        deleteFolderIfEmpty(
                          libraryActiveScope.kind === 'folder'
                            ? libraryActiveScope.folderId
                            : undefined,
                        )
                      }
                    >
                      Delete folder
                    </button>
                  </>
                )}
              </div>
              {libraryPickMode && libraryActiveScope.kind !== 'all' ? (
                <div
                  style={{
                    marginTop: 8,
                    padding: '8px 10px',
                    borderRadius: 8,
                    background: globalSelectArmed ? '#fef2f2' : '#f8fafc',
                    border: globalSelectArmed ? '1px solid #fecaca' : '1px solid var(--yl-border, #e2e8f0)',
                  }}
                >
                  {!globalSelectArmed ? (
                    <button
                      type="button"
                      className="btn ghost small"
                      style={{ color: '#b91c1c', fontWeight: 600 }}
                      onClick={() => setGlobalSelectArmed(true)}
                    >
                      Select all lectures across library…
                    </button>
                  ) : (
                    <>
                      <p style={{ margin: '0 0 8px', fontSize: 12, lineHeight: 1.45, color: '#991b1b' }}>
                        This selects every lecture in your library (all folders and unfiled). Tap again only if that is
                        what you want.
                      </p>
                      <button
                        type="button"
                        className="btn primary small"
                        style={{ background: '#dc2626', borderColor: '#b91c1c' }}
                        onClick={() => {
                          setLibraryPickedIds(recordingsInLibrary.map((r) => r.id))
                          setGlobalSelectArmed(false)
                        }}
                      >
                        Select all lectures across library
                      </button>
                      <button
                        type="button"
                        className="btn ghost small"
                        style={{ marginLeft: 8 }}
                        onClick={() => setGlobalSelectArmed(false)}
                      >
                        Cancel
                      </button>
                    </>
                  )}
                </div>
              ) : null}
              {libraryPickMode && libraryActiveScope.kind === 'all' ? (
                <p style={{ margin: '8px 0 0', fontSize: 11, color: '#64748b', lineHeight: 1.45 }}>
                  You are viewing <strong>All lectures</strong>. The green button selects everything currently shown in the
                  library.
                </p>
              ) : null}
              {(libraryPickMode || libraryPickedIds.length > 0) && (
                <div className="yl-library-multiselect-banner">
                  <span className="yl-library-multiselect-count">
                    {libraryPickMode ? validPickedLectureCount : libraryPickedIds.length} selected
                  </span>
                  <button type="button" className="btn ghost small" onClick={() => setLibraryPickedIds([])}>
                    Clear selection
                  </button>
                </div>
              )}
            </div>

            <div
              style={{
                padding: '8px 8px 6px',
                borderTop: '1px solid var(--yl-border, #e2e8f0)',
              }}
            >
              <button
                type="button"
                className="btn ghost small"
                style={{ width: '100%', justifyContent: 'space-between', display: 'flex', alignItems: 'center' }}
                onClick={() => setRecentlyDeletedOpen((o) => !o)}
              >
                <span>Recently deleted ({trashTotalCount})</span>
                <span aria-hidden>{recentlyDeletedOpen ? '▾' : '▸'}</span>
              </button>
              {recentlyDeletedOpen ? (
                <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.45, color: '#475569' }}>
                  <p style={{ margin: '0 0 10px' }}>
                    {localOnly
                      ? 'Recover full audio and transcripts from this device until you delete forever.'
                      : 'Hidden on this device only. Lectures stay on your account until you permanently delete them here.'}
                  </p>
                  {localOnly ? (
                    localTrashRows.length === 0 ? (
                      <p style={{ margin: 0 }}>Trash is empty.</p>
                    ) : (
                      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                        {localTrashRows.map((r) => (
                          <li
                            key={r.id}
                            style={{
                              display: 'flex',
                              flexWrap: 'wrap',
                              gap: 6,
                              alignItems: 'center',
                              marginBottom: 10,
                              paddingBottom: 8,
                              borderBottom: '1px solid var(--yl-border, #e2e8f0)',
                            }}
                          >
                            <span style={{ flex: '1 1 140px', fontWeight: 500, color: '#0f172a' }}>
                              {r.title?.trim() || 'Untitled lecture'}
                            </span>
                            <button
                              type="button"
                              className="btn ghost small"
                              disabled={deleteActionBusy}
                              onClick={() => void restoreLecturesFromTrash([r.id])}
                            >
                              Restore
                            </button>
                            <button
                              type="button"
                              className="btn ghost small"
                              disabled={deleteActionBusy}
                              style={{ color: '#b91c1c' }}
                              onClick={() => setPermanentPurgeModal([r.id])}
                            >
                              Delete forever
                            </button>
                          </li>
                        ))}
                      </ul>
                    )
                  ) : cloudTrashEntriesSorted.length === 0 ? (
                    <p style={{ margin: 0 }}>Trash is empty.</p>
                  ) : (
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                      {cloudTrashEntriesSorted.map((row) => (
                        <li
                          key={row.id}
                          style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: 6,
                            alignItems: 'center',
                            marginBottom: 10,
                            paddingBottom: 8,
                            borderBottom: '1px solid var(--yl-border, #e2e8f0)',
                          }}
                        >
                          <span style={{ flex: '1 1 140px', fontWeight: 500, color: '#0f172a' }}>
                            {row.title?.trim() || 'Untitled lecture'}
                          </span>
                          <button
                            type="button"
                            className="btn ghost small"
                            disabled={deleteActionBusy}
                            onClick={() => void restoreLecturesFromTrash([row.id])}
                          >
                            Restore
                          </button>
                          <button
                            type="button"
                            className="btn ghost small"
                            disabled={deleteActionBusy}
                            style={{ color: '#b91c1c' }}
                            onClick={() => setPermanentPurgeModal([row.id])}
                          >
                            Delete forever
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </div>


            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDndStart}
              onDragOver={handleDndOver}
              onDragCancel={handleDndCancel}
              onDragEnd={handleDndEnd}
            >
              <div
                className="yl-history"
                ref={fileExplorerScrollRef}
              >
                <div className="yl-file-explorer">
                  <section className="yl-recent-group">
                    <div
                      className={`yl-recent-group-head${libraryActiveScope.kind === 'all' ? ' is-folder-selected' : ''}`}
                    >
                      <button
                        type="button"
                        className="yl-recent-group-head-btn"
                        onClick={() => {
                          setLibraryActiveScope({ kind: 'all' })
                          setSelectedId(null)
                          setLibraryPickedIds([])
                          setLibraryPickMode(false)
                        }}
                      >
                        <span className="yl-recent-group-label">
                          <span className="yl-recent-course">All lectures</span>
                          <span className="yl-recent-count">({recordings.length})</span>
                        </span>
                      </button>
                    </div>
                  </section>

                  {libraryFolders
                    .slice()
                    .sort((a, b) => b.createdAt - a.createdAt)
                    .map((f) => {
                      const items = folderRecordingsMap[f.id] || []
                      const shouldShowLectures =
                        libraryActiveScope.kind === 'all' ||
                        (libraryActiveScope.kind === 'folder' && libraryActiveScope.folderId === f.id)
                      return (
                        <section key={f.id} className="yl-recent-group">
                          <DroppableLibraryTarget
                            dropId={f.id}
                            activeDropId={dropTargetFolderId}
                            className={`yl-recent-group-head${
                              libraryActiveScope.kind === 'folder' && libraryActiveScope.folderId === f.id
                                ? ' is-folder-selected'
                                : ''
                            }`}
                          >
                            <button
                              type="button"
                              className="yl-recent-group-head-btn"
                              onClick={() => {
                                setLibraryActiveScope({ kind: 'folder', folderId: f.id })
                                setSelectedId(null)
                                setLibraryPickedIds([])
                                setLibraryPickMode(false)
                              }}
                            >
                              <span className="yl-recent-group-label">
                                <span className="yl-recent-course">{f.name}</span>
                                <span className="yl-recent-count">({items.length})</span>
                              </span>
                            </button>
                          </DroppableLibraryTarget>
                          {shouldShowLectures ? (
                            items.length > 0 ? (
                              <ul className="rec-list yl-recent-items">
                                {items.map((r) => (
                                  <li key={r.id}>
                                    <div
                                      className={`yl-lecture-row${
                                        libraryPickedIds.includes(r.id) ? ' is-picked' : ''
                                      }`}
                                    >
                                      {libraryPickMode ? (
                                        <label
                                          className="yl-lecture-row__check"
                                          onPointerDown={(e) => e.stopPropagation()}
                                        >
                                          <input
                                            type="checkbox"
                                            checked={libraryPickedIds.includes(r.id)}
                                            onChange={() => {
                                              setLibraryPickedIds((prev) =>
                                                prev.includes(r.id)
                                                  ? prev.filter((x) => x !== r.id)
                                                  : [...prev, r.id],
                                              )
                                              libraryShiftAnchorRef.current = r.id
                                            }}
                                          />
                                        </label>
                                      ) : null}
                                      <DraggableLectureItem
                                        recordingId={r.id}
                                        selected={r.id === selectedId}
                                        dragging={draggingRecordingId === r.id}
                                        pickMode={libraryPickMode}
                                        onRowClick={handleLectureRowClick(r.id)}
                                        suppressItemClickRef={suppressItemClickRef}
                                      >
                                        <span className="yl-recent-item-body">
                                          <span className="rec-title">{r.title}</span>
                                          <span className="rec-meta">
                                            {(r.course?.trim() ? r.course.trim() : 'Uncategorized')} ·{' '}
                                            {formatClock(r.durationSec)} · {formatDate(r.createdAt)}
                                          </span>
                                        </span>
                                      </DraggableLectureItem>
                                      {!libraryPickMode ? (
                                        <button
                                          type="button"
                                          className="btn ghost small yl-lecture-row__delete"
                                          disabled={deleteActionBusy}
                                          onPointerDown={(e) => e.stopPropagation()}
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            void handleDeleteLectureById(r.id)
                                          }}
                                        >
                                          Delete…
                                        </button>
                                      ) : null}
                                    </div>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="muted" style={{ padding: '4px 8px 8px' }}>
                                Empty folder.
                              </p>
                            )
                          ) : null}
                        </section>
                      )
                    })}

                  <section className="yl-recent-group">
                    <DroppableLibraryTarget
                      dropId="unfiled"
                      activeDropId={dropTargetFolderId}
                      className={`yl-recent-group-head${
                        libraryActiveScope.kind === 'unfiled' ? ' is-folder-selected' : ''
                      }`}
                    >
                      <button
                        type="button"
                        className="yl-recent-group-head-btn yl-recent-group-head-btn--unfiled"
                        onClick={() => {
                          setLibraryActiveScope({ kind: 'unfiled' })
                          setSelectedId(null)
                          setLibraryPickedIds([])
                          setLibraryPickMode(false)
                        }}
                      >
                        <span className="yl-recent-group-label">
                          <span className="yl-recent-course">Unfiled</span>
                          <span className="yl-recent-count">({unfiledRecordings.length})</span>
                        </span>
                      </button>
                    </DroppableLibraryTarget>
                    {(
                      libraryActiveScope.kind === 'all' || libraryActiveScope.kind === 'unfiled'
                    ) && (
                      <>
                        {unfiledRecordings.length > 0 ? (
                          <ul className="rec-list yl-recent-items">
                            {unfiledRecordings.map((r) => (
                              <li key={r.id}>
                                <div
                                  className={`yl-lecture-row${
                                    libraryPickedIds.includes(r.id) ? ' is-picked' : ''
                                  }`}
                                >
                                  {libraryPickMode ? (
                                    <label
                                      className="yl-lecture-row__check"
                                      onPointerDown={(e) => e.stopPropagation()}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={libraryPickedIds.includes(r.id)}
                                        onChange={() => {
                                          setLibraryPickedIds((prev) =>
                                            prev.includes(r.id)
                                              ? prev.filter((x) => x !== r.id)
                                              : [...prev, r.id],
                                          )
                                          libraryShiftAnchorRef.current = r.id
                                        }}
                                      />
                                    </label>
                                  ) : null}
                                  <DraggableLectureItem
                                    recordingId={r.id}
                                    selected={r.id === selectedId}
                                    dragging={draggingRecordingId === r.id}
                                    pickMode={libraryPickMode}
                                    onRowClick={handleLectureRowClick(r.id)}
                                    suppressItemClickRef={suppressItemClickRef}
                                  >
                                    <span className="yl-recent-item-body">
                                      <span className="rec-title">{r.title}</span>
                                      <span className="rec-meta">
                                        {(r.course?.trim() ? r.course.trim() : 'Uncategorized')} ·{' '}
                                        {formatClock(r.durationSec)} · {formatDate(r.createdAt)}
                                      </span>
                                    </span>
                                  </DraggableLectureItem>
                                  {!libraryPickMode ? (
                                    <button
                                      type="button"
                                      className="btn ghost small yl-lecture-row__delete"
                                      disabled={deleteActionBusy}
                                      onPointerDown={(e) => e.stopPropagation()}
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        void handleDeleteLectureById(r.id)
                                      }}
                                    >
                                      Delete…
                                    </button>
                                  ) : null}
                                </div>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="muted" style={{ padding: '4px 8px 8px' }}>
                            No unfiled lectures.
                          </p>
                        )}
                      </>
                    )}
                  </section>
                </div>
              </div>
              <DragOverlay>
                {dragOverlayRecordingId ? (
                  <div className="yl-drag-preview" style={{ minWidth: 180, maxWidth: 340 }}>
                    <div className="rec-item is-dragging">
                      <span className="yl-recent-item-body">
                        <span className="rec-title">
                          {recordings.find((r) => r.id === dragOverlayRecordingId)?.title ?? 'Lecture'}
                        </span>
                      </span>
                    </div>
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          </div>
        </>
      }
      recordingStrip={
        <>
          <div className="yl-recording-strip__lead">
            <div className="record-card-head">
              <div>
                <p className="yl-recording-strip__eyebrow">Workspace</p>
                <h1 className="yl-lecture-title">Record Lecture</h1>
              </div>
              <span className="record-help-link">How it works</span>
            </div>
            <div className="row record-fields-grid" style={{ flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end', marginBottom: '0.35rem' }}>
          <label className="field">
            <span>Course</span>
            <input
              className="input"
              value={course}
              onChange={(e) => {
                setCourse(e.target.value)
                // A free-form name is not evidence of a particular Course UUID.
                setRecordingCourseId(null)
              }}
              disabled={recorder.status !== 'idle' || saveOrFinishBusy}
            />
          </label>
          <label className="field">
            <span>Lecture title (optional)</span>
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={recorder.status !== 'idle' || saveOrFinishBusy}
              placeholder="e.g. Week 3 — sorting"
            />
          </label>
            </div>
            <p className="yl-meta">
              {course.trim() || 'Course'} ·{' '}
              {recorder.status !== 'idle' ? formatClock(recorder.elapsedSec) : '—'} ·{' '}
              {saveOrFinishBusy && capturePhaseLabel(flow.phase)
                ? capturePhaseLabel(flow.phase)
                : recorder.status === 'idle'
                  ? 'Ready'
                  : recorder.status === 'recording'
                    ? 'Recording'
                    : 'Paused'}
            </p>
          </div>
          <div className="yl-recording-strip__controls recording-status-card">
            <div className="recording-status-head">
              <span className={`recording-status-icon recording-status-icon--${recorder.status}`} aria-hidden>
                ●
              </span>
              <div className="recording-status-copy">
                <span className="recording-status-label">
                  {recorder.status === 'idle' ? 'Ready' : recorder.status === 'recording' ? 'Listening' : 'Paused'}
                </span>
                <span className="recording-status-subtitle">
                  {saveOrFinishBusy && capturePhaseLabel(flow.phase)
                    ? capturePhaseLabel(flow.phase)
                    : recorder.status === 'idle'
                      ? 'Set your lecture details, then start listening.'
                      : 'Recording continues until you stop and save.'}
                </span>
              </div>
              <div className="yl-timer-block" aria-live="polite">
                <span className="yl-timer-label">Elapsed</span>
                <span className="yl-timer">{formatClock(recorder.elapsedSec)}</span>
              </div>
            </div>
            <div className="recording-waveform" aria-hidden>
              {Array.from({ length: 42 }, (_, index) => (
                <span key={index} style={{ '--bar': `${22 + ((index * 17) % 46)}%` } as CSSProperties} />
              ))}
            </div>
            <div className="yl-record-actions">
              {recorder.status === 'idle' && (
                <button
                  type="button"
                  className="yl-btn-primary"
                  onClick={() => startRecording()}
                  disabled={saveOrFinishBusy}
                >
                  {saveOrFinishBusy ? 'Please wait…' : 'Start'}
                </button>
              )}
              {recorder.status === 'recording' && (
                <>
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={pauseRecording}
                    disabled={saveOrFinishBusy}
                  >
                    Pause
                  </button>
                  <button
                    type="button"
                    className="btn danger"
                    disabled={saveOrFinishBusy}
                    onClick={() => void handleStopAndSave()}
                  >
                    {stopSaveButtonLabel(flow.phase)}
                  </button>
                </>
              )}
              {recorder.status === 'paused' && (
                <>
                  <button
                    type="button"
                    className="yl-btn-primary"
                    onClick={resumeRecording}
                    disabled={saveOrFinishBusy}
                  >
                    Resume
                  </button>
                  <button
                    type="button"
                    className="btn danger"
                    disabled={saveOrFinishBusy}
                    onClick={() => void handleStopAndSave()}
                  >
                    {stopSaveButtonLabel(flow.phase)}
                  </button>
                </>
              )}
              {recorder.status !== 'idle' && (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={discardRecording}
                  disabled={saveOrFinishBusy}
                >
                  Discard
                </button>
              )}
            </div>
          </div>
        </>
      }
      mainExtra={
        <>
      <header className="hero">
        <h1>Record class, real-time captions, bilingual summaries</h1>
        <p className="lede">
          While you teach or study in English, Youmi Lens shows live captions and can prepare a full transcript
          with Chinese summaries after class.
        </p>
            <p className="legal">
          Only record when your professor and local law allow it.{' '}
          {localOnly
            ? 'Audio stays in this browser until you use cloud login.'
            : 'You control data in your Supabase project.'}
        </p>
      </header>

      {localOnly && (
        <section className="panel">
          <h2>Backup &amp; restore</h2>
          <p className="hint small">
            Before switching browsers, devices, or clearing site data, export a ZIP. On a new device open this
            page and import to restore IndexedDB. Independent of cloud sign-in.
          </p>
          <div className="row" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
            <button
              type="button"
              className="btn secondary"
              disabled={backupBusy || recordings.length === 0}
              onClick={() => void handleExportLocalBackup()}
            >
              Export all (.zip)
            </button>
            <label className="btn secondary" style={{ cursor: backupBusy ? 'not-allowed' : 'pointer' }}>
              Import backup…
              <input
                type="file"
                accept=".zip,application/zip"
                disabled={backupBusy}
                style={{ display: 'none' }}
                onChange={(ev) => void handleImportLocalBackup(ev)}
              />
            </label>
          </div>
          {backupMsg && <p className="hint small" style={{ marginTop: '0.75rem' }}>{backupMsg}</p>}
          {backupError && <p className="error" style={{ marginTop: '0.5rem' }}>{backupError}</p>}
        </section>
      )}

          <section className="panel" id="yl-settings">
            <div className="record-card-head">
              <div>
                <p className="yl-recording-strip__eyebrow">Session</p>
                <h2>Language setup</h2>
              </div>
            </div>
            <div className="session-form-row">
              <label className="field session-field">
                <span className="session-field__label">Spoken language</span>
                <div className="input session-field__readonly" aria-readonly="true">
                  English
                </div>
              </label>
              <label className="field session-field">
                <span className="session-field__label">Translation</span>
                <div className="input session-field__readonly" aria-readonly="true">
                  Translate to Chinese
                </div>
              </label>
            </div>
        <p className="hint small session-quiet-copy">
          Live preview stays focused while the full transcript and summaries are generated after saving.
        </p>
        {!postClassAiEnabled ? (
          <p className="hint small" style={{ marginTop: '0.35rem' }}>
            Open <strong>Account</strong> to use <strong>Youmi AI</strong> (recommended) or configure advanced options
            with your own key.
          </p>
        ) : null}

        {recorder.error && <p className="error">{recorder.error}</p>}
        {recoveredSessions.length > 0 && (
          <div className="recent-outcome" role="status" style={{ marginBottom: '0.75rem' }}>
            <div className="recent-outcome-head">
              <strong>Unfinished recording recovered</strong>
            </div>
            {recoveredSessions.map((s) => (
              <div key={s.id} style={{ marginTop: '0.5rem' }}>
                <p className="hint small" style={{ margin: '0 0 0.35rem' }}>
                  {new Date(s.startedAt).toLocaleString()} · ~{formatRecoveryDuration(s.approxDurationSec)} ·{' '}
                  {s.status}
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                  <button
                    type="button"
                    className="btn primary small"
                    disabled={Boolean(recoveryBusyId) || recorder.status !== 'idle'}
                    onClick={() => void handleRecoverSave(s)}
                  >
                    {recoveryBusyId === s.id ? 'Saving…' : 'Save and process'}
                  </button>
                  <button
                    type="button"
                    className="btn ghost small"
                    disabled={Boolean(recoveryBusyId)}
                    onClick={() => void handleRecoverKeep(s.id)}
                  >
                    Keep for later
                  </button>
                  <button
                    type="button"
                    className="btn ghost small"
                    disabled={Boolean(recoveryBusyId)}
                    onClick={() => void handleRecoverDelete(s.id)}
                  >
                    {recoveryDeleteConfirmId === s.id ? 'Confirm delete' : 'Delete'}
                  </button>
                  {recoveryDeleteConfirmId === s.id ? (
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => setRecoveryDeleteConfirmId(null)}
                    >
                      Cancel
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
        {recentCapture && (
          <div className="recent-outcome" role="status">
            <div className="recent-outcome-head">
              <strong>{recentCaptureHeadline(recentCapture)}</strong>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => setRecentCapture(null)}
              >
                Dismiss
              </button>
            </div>
            {recentCapture.kind === 'success' && (
              <p className="hint small">
                Recording saved {localOnly ? 'locally' : 'to the cloud'}. Open it from Recent on the left.
                {!localOnly ? ' Run Generate transcript & summaries for the full lecture text in Supabase.' : null}
              </p>
            )}
            {recentCapture.kind === 'list_refresh_warn' && (
              <p className="hint small">{recentCapture.message}</p>
            )}
            {recentCapture.kind === 'failure' && (
              <p className="error small">{recentCapture.message}</p>
            )}
          </div>
        )}
        <div
          className="internal-beta-note"
          style={{
            marginTop: '1.25rem',
            paddingTop: '1rem',
            borderTop: '1px solid var(--yl-border, #e2e8f0)',
          }}
        >
          <h3 style={{ margin: '0 0 0.45rem', fontSize: '0.95rem', fontWeight: 600 }}>
            {PRODUCT_VERSION_LABEL}
          </h3>
          <p className="hint small" style={{ margin: 0, lineHeight: 1.5 }}>
            {INTERNAL_BETA_NOTE}
          </p>
        </div>
          </section>
        </>
      }
      transcript={
        <>
        {(recorder.status === 'recording' || recorder.status === 'paused') && (
          <>
            {liveCaptionSessionSurface?.tier === 'fatal' && (
              <p className="error" role="alert">
                {liveCaptionSessionSurface.text}
              </p>
            )}
            {liveCaptionSessionSurface?.tier === 'info' && (
              <p className="hint small" style={{ marginBottom: '0.35rem' }}>
                {liveCaptionSessionSurface.text}
              </p>
            )}
            {liveCaptionChunkNotice?.kind === 'fatal' && (
              <p className="error" role="alert">
                {liveCaptionChunkNotice.message}
              </p>
            )}
            {liveCaptionChunkNotice?.kind === 'soft' && (
              <p className="hint small" style={{ marginBottom: '0.35rem' }}>
                {liveCaptionChunkNotice.message}
              </p>
            )}
          </>
        )}
        {(recorder.status === 'recording' || recorder.status === 'paused') && (
          <div className="live-cockpit">
            <div className="live-cockpit-head">
              <div>
                <h2>Live Captions</h2>
                <p className="live-caption-hint muted small">{LIVE_CAPTIONS_USER_EXPECTATION_EN}</p>
              </div>
              <div className="live-cockpit-actions">
                {recorder.status === 'paused' && (
                  <span className="live-pill">Paused - text kept</span>
                )}
                {isTauriContext() && (
                  <LectureOverlayButton />
                )}
              </div>
            </div>
            <div className="live-caption-columns">
            <div className="live-caption live-caption-primary" aria-live="polite">
              <div className="live-caption-head">
                <div className="live-caption-label">
                  Primary · {spokenLanguageLabel(liveLang)}
                </div>
              </div>
              <p className="live-caption-hint muted small">
                {useLiveEngineV2 && liveV2CaptionPhase && liveV2CaptionPhase !== 'paused' ? (
                  <>
                    <span className="live-pill" style={{ marginRight: '0.4rem' }}>
                      {liveV2CaptionPhase === 'hearing' ? 'Hearing' : null}
                      {liveV2CaptionPhase === 'drafting' ? 'Draft' : null}
                      {liveV2CaptionPhase === 'refining' ? 'Refining' : null}
                    </span>
                    {liveV2CaptionPhase === 'hearing'
                      ? 'Listening — first words appear within a second.'
                      : null}
                    {liveV2CaptionPhase === 'drafting'
                      ? 'Live — faint text is the current phrase updating in real time.'
                      : null}
                    {liveV2CaptionPhase === 'refining'
                      ? 'Processing — next caption will follow shortly.'
                      : null}
                  </>
                ) : (
                  <>
                    Live preview is waiting for the next spoken phrase.
                  </>
                )}
              </p>
              {SHOW_LIVE_ROUTE_DEBUG_UI && (
                <p className="live-caption-hint muted small">
                  Route: {useLiveEngineV2 ? `LiveEngine v2 (${liveRouteState})` : 'Legacy live captions'}
                </p>
              )}
              <div className="live-caption-text live-realtime">
                {primaryCaption && <span className="live-final">{primaryCaption}</span>}
                {primaryCaptionDraft && (
                  <span className="live-interim">
                    {primaryCaption ? ' ' : ''}
                    <SmoothCaption value={primaryCaptionDraft} />
                  </span>
                )}
                {liveCaptionPendingSlices > 0 && !useLiveEngineV2 && (
                  <span className="live-interim">
                    {primaryCaption || primaryCaptionDraft ? ' ' : ''}
                    (Updating…)
                  </span>
                )}
                {!primaryCaption && !primaryCaptionDraft && liveCaptionPendingSlices === 0 && (
                  <span className="muted">
                    {recorder.status === 'recording'
                      ? useLiveEngineV2
                        ? 'Speak — captions stream as you go.'
                        : `First segment in ~${LIVE_WHISPER_SLICE_SEC}s after you start…`
                      : 'Paused'}
                  </span>
                )}
              </div>
            </div>
            {translateTarget !== 'off' && (
              <div className="live-caption live-caption-secondary" aria-live="polite">
                <div className="live-caption-head">
                  <div className="live-caption-label">
                    Translation · {translateTarget === 'zh' ? 'Chinese' : 'English'}
                  </div>
                </div>
                <div className="live-caption-text live-realtime">
                  {secondaryCaption ? <span className="live-final">{secondaryCaption}</span> : null}
                  {secondaryCaptionDraft ? (
                    <span className="live-interim">
                      {secondaryCaption ? ' ' : ''}
                      {secondaryCaptionDraft}
                    </span>
                  ) : null}
                  {useLiveEngineV2 && Boolean(primaryCaptionDraft.trim()) && !secondaryCaptionDraft ? (
                    <span className="live-interim muted">Translating…</span>
                  ) : null}
                  {!secondaryCaption &&
                  !secondaryCaptionDraft &&
                  !(useLiveEngineV2 && Boolean(primaryCaptionDraft.trim())) ? (
                    <span className="muted">
                      {liveCaptionsPipelineEnabled
                        ? 'Translated lines appear after each primary line…'
                        : 'Translation will appear here when each line is ready.'}
                    </span>
                  ) : null}
                </div>
              </div>
            )}
            </div>
          </div>
        )}

          {recorder.status === 'idle' && selectedId && !detail && (
            <p className="muted">Loading transcript…</p>
          )}

          {recorder.status === 'idle' && detail && (
            <>
              {detail.liveTranscript && (
                <CollapsibleResultBlock
                  key={`${detail.id}-live`}
                  title="Live captions (saved)"
                  status="Saved"
                >
                  <pre className="scroll subtle result-collapsible__pre">{detail.liveTranscript}</pre>
                </CollapsibleResultBlock>
              )}

              {detail.transcript && (
                <CollapsibleResultBlock
                  key={`${detail.id}-transcript-full`}
                  title="Full transcript"
                  status="Ready"
                >
                  <pre className="scroll result-collapsible__pre">{detail.transcript}</pre>
                </CollapsibleResultBlock>
              )}

              {!detail.liveTranscript && !detail.transcript && (
                <p className="muted small">
                  {!localOnly && usesHosted && detail.aiStatus === 'pending'
                    ? 'No full transcript yet. When you’re ready, open the summary column and tap Generate transcript & summaries.'
                    : 'No transcript yet. Use Transcribe & summarize in the summary column.'}
                </p>
              )}
            </>
          )}

          {recorder.status === 'idle' && !selectedId && (
            <div className="yl-transcript-placeholder">
              <p className="yl-transcript-line">Pick a recording from the sidebar, or start a new session.</p>
              <p className="yl-transcript-line">
                Live captions stream here while you record; saved transcripts appear when you open a lecture.
              </p>
            </div>
          )}
        </>
      }
      summaryHint={
        <p className="yl-summary-hint">
          {detail
            ? 'Bilingual summaries and actions for this session.'
            : selectedId
              ? 'Loading session…'
              : 'Select a recording or start a new session.'}
        </p>
      }
      rightPanel={
        <div className="yl-summary-body">
          {!selectedId && (
            <div className="summary-empty-state">
              <div className="summary-empty-icon" aria-hidden />
              <h3>No lecture selected</h3>
              <p>After saving a lecture, Youmi Lens will generate:</p>
              <ul>
                <li>English summary</li>
                <li>Chinese summary</li>
                <li>Full transcript</li>
              </ul>
            </div>
          )}
          {recorder.status !== 'idle' && (
            <section className="current-session-card" aria-label="Current session">
              <div className="current-session-head">
                <h3>Current Session</h3>
                <span className="current-session-status">
                  <span aria-hidden />
                  {recorder.status === 'recording' ? 'Listening' : 'Paused'}
                </span>
              </div>
              <dl className="current-session-list">
                <div>
                  <dt>Duration</dt>
                  <dd>{formatClock(recorder.elapsedSec)}</dd>
                </div>
                <div>
                  <dt>Course</dt>
                  <dd>{course.trim() || 'Untitled course'}</dd>
                </div>
                <div>
                  <dt>Language</dt>
                  <dd>{spokenLanguageLabel(liveLang)} → {translateTarget === 'zh' ? 'Chinese' : 'English'}</dd>
                </div>
              </dl>
            </section>
          )}
          {selectedId && !detail && <p className="muted">Loading…</p>}
          {detail && (
            <>
              <div className="detail-head">
                <div>
                  <h3>{detail.title}</h3>
                  <p className="muted">
                    {detail.course} · {formatClock(detail.durationSec)}
                  </p>
                </div>
              </div>

              {audioUrl && (
                <RecordingAudioPlayer
                  recordingId={detail.id}
                  src={audioUrl}
                  durationSecFallback={detail.durationSec}
                />
              )}

              <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className={`btn ghost small${lectureMetadataBusy ? ' is-busy' : ''}`}
                  disabled={lectureMetadataBusy}
                  aria-busy={lectureMetadataBusy}
                  onClick={() => openEditLectureModal()}
                >
                  {lectureMetadataBusy ? 'Saving…' : 'Edit lecture'}
                </button>
                <button
                  type="button"
                  className={`btn ghost small${deleteActionBusy ? ' is-busy' : ''}`}
                  disabled={deleteActionBusy}
                  aria-busy={deleteActionBusy}
                  onClick={() => void deleteLectureFromDetailPanel()}
                >
                  {deleteActionBusy ? 'Working…' : 'Delete lecture…'}
                </button>
              </div>

              <div className="ai-actions">
                {stubMode && usesHosted && (
                  <p className="hint small" style={{ marginBottom: '0.5rem' }}>
                    Demo mode is active on this device.
                  </p>
                )}
                {hostedUnavailableMessage && (
                  <p className="hint small" style={{ marginBottom: '0.5rem' }}>
                    {hostedUnavailableMessage}
                  </p>
                )}
                {showHostedReadyToGenerateHint && (
                  <p className="hint small" style={{ marginBottom: '0.5rem' }}>
                    Saved. Ready to generate transcript and summaries when you want — tap the button below. Nothing
                    starts automatically after save.
                  </p>
                )}
                {transcribeSubmitPending && !hostedCloudJobActive && !localOnly && usesHosted && (
                  <p className="hint small" aria-live="polite" style={{ marginBottom: '0.5rem' }}>
                    Starting Youmi AI…
                  </p>
                )}
                {hostedCloudJobActive && (
                  <p className="hint small" aria-live="polite" style={{ marginBottom: '0.5rem' }}>
                    {hostedRecordingAiStatusLabel(detail.aiStatus) ?? 'Youmi AI is working…'}
                  </p>
                )}
                {!hostedCloudJobActive &&
                  (flow.phase === 'transcribing' || flow.phase === 'summarizing') && (
                    <p className="hint small" aria-live="polite" style={{ marginBottom: '0.5rem' }}>
                      {flow.phase === 'transcribing'
                        ? 'Transcribing class audio (long lectures may take several minutes)…'
                        : 'Writing bilingual summaries…'}
                    </p>
                  )}
                {detail.aiStatus === 'failed' && (
                  <p className="error small" style={{ marginBottom: '0.5rem' }}>
                    {userFacingHostedJobFailure(detail.aiError)}
                  </p>
                )}
                {detail.aiStatus === 'transcript_ready' && detail.aiError?.trim() && (
                  <p className="hint small" style={{ marginBottom: '0.5rem' }}>
                    {userFacingHostedJobFailure(detail.aiError)}
                  </p>
                )}
                <button
                  type="button"
                  className={`btn primary${aiPipelineBusy ? ' is-busy' : ''}`}
                  disabled={aiPipelineBusy || Boolean(hostedUnavailableMessage)}
                  aria-busy={aiPipelineBusy}
                  onClick={() => void runTranscribeAndSummarize()}
                >
                  {generateTranscribeButtonLabel}
                </button>
                {recentAi && (
                  <div className="recent-outcome" role="status">
                    <div className="recent-outcome-head">
                      <strong>{recentAiHeadline(recentAi)}</strong>
                      <button
                        type="button"
                        className="btn ghost small"
                        onClick={() => setRecentAi(null)}
                      >
                        Dismiss
                      </button>
                    </div>
                    {recentAi.kind === 'success' && (
                      <p className="hint small">See transcript and summaries below.</p>
                    )}
                    {recentAi.kind !== 'success' && (
                      <p className="error small">{recentAi.message}</p>
                    )}
                  </div>
                )}
              </div>
              {detail.summaryEn && (
                <CollapsibleResultBlock
                  key={`${detail.id}-sum-en`}
                  title="Summary (English)"
                  status="Ready"
                >
                  <div className="markdown scroll result-collapsible__md">{detail.summaryEn}</div>
                </CollapsibleResultBlock>
              )}
              {detail.summaryZh && (
                <CollapsibleResultBlock
                  key={`${detail.id}-sum-zh`}
                  title="Summary (Chinese)"
                  status="Ready"
                >
                  <div className="markdown scroll result-collapsible__md">{detail.summaryZh}</div>
                </CollapsibleResultBlock>
              )}
            </>
          )}
        </div>
      }
    />
      )}
    </>
  )

}
