import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { CourseIdentity } from '../lib/courses/coursePresets'
import type { DesktopI18nKey } from '../lib/desktopI18n'
import type { BilingualStack, CaptionRow } from '../lib/bilingualCaptionStack'
import {
  captionFollowReducer,
  INITIAL_CAPTION_FOLLOW,
  classifyHistoryScroll,
  nextFollowAnchor,
  type FollowAnchor,
  shouldPinToBottom,
  shouldShowJumpToLatest,
  type ScrollSample,
} from '../lib/captionAutoFollow'
import {
  isTerminalRecordingStage,
  RECORDING_STAGE_BODY_KEY,
  RECORDING_STAGE_TITLE_KEY,
  type RecordingV2Stage,
} from '../lib/recordingV2Stage'
import { probeScrollerGeometry } from '../lib/captionDiagnostics'
import type { ProcessingPhase } from '../lib/lectureLifecycle'
import { CourseIconTile } from './CourseIconTile'
import { LectureProcessingPanel } from './LectureProcessingPanel'
import '../styles/recording-v2.css'

/**
 * The recording screen, for the whole flow — live capture AND everything after
 * Stop & Save, up to the point the user opens the saved lecture.
 *
 * Why it covers the tail as well: `handleStopAndSave` awaits `recorder.stop()`
 * first, so the recorder reports idle while the pipeline is still saving and
 * uploading. Selecting this screen from the recorder alone dropped the user onto
 * Record Home mid-save, and the outcome banner only existed in the legacy tree.
 * `resolveRecordingV2Stage` derives the stage from state that already exists.
 *
 * What this component is NOT:
 *   · It is not a recorder or an uploader. No MediaRecorder, no timer, no
 *     network call, no Supabase. Every value is a prop, every button a callback
 *     into the existing production handlers.
 *   · It is not the Overlay. `onOpenOverlay` invokes the existing compact
 *     deep-navy overlay window, unchanged.
 *   · It contains no caption de-duplication. Reconciliation belongs to
 *     `LiveCaptionSessionModel`; this only presents what that model committed.
 */

type T = (key: DesktopI18nKey, vars?: Record<string, string | number>) => string

/**
 * One settled caption row: the original and — directly under it — ITS translation.
 * With translation off, or none yet for this row, only the original renders; a
 * row never borrows a neighbour's translation to fill the gap.
 */
function CaptionPairRow({ row, translationEnabled }: { row: CaptionRow; translationEnabled: boolean }) {
  return (
    <div className="recording-v2__pair" data-translation={row.translationState}>
      <p className="recording-v2__pair-source">{row.original}</p>
      {translationEnabled && row.translation ? (
        <p className="recording-v2__pair-translation">{row.translation}</p>
      ) : null}
    </div>
  )
}

export function RecordingV2({
  t,
  stage,
  courseName,
  courseIdentity,
  lectureTitle,
  elapsed,
  languageLine,
  captions,
  translationEnabled,
  notice,
  failureMessage,
  noticeAction,
  failureAction,
  busy,
  canOpenOverlay,
  onOpenOverlay,
  onDiscard,
  onPause,
  onResume,
  onStopAndSave,
  onViewLecture,
  onRecordAnother,
  onRetry,
  onRecoverRecording,
  onDiscardRecovery,
  onCancelRecoveryDiscard,
  recoveryDiscardConfirm,
  processing = null,
  onRetryProcessing = () => {},
  recoveryItems = [],
  selectedRecoveryId = null,
  selectedRecoveryNeedsCourse = false,
  recoveryCourseOptions = [],
  onSelectRecovery = () => {},
  onAssignRecoveryCourse = () => {},
  onCreateRecoveryCourse = () => {},
}: {
  t: T
  stage: RecordingV2Stage
  courseName: string
  courseIdentity: CourseIdentity
  lectureTitle: string
  /** Preformatted clock from App's `formatClock`. */
  elapsed: string
  /** e.g. "English → Chinese · Bilingual". */
  languageLine: string
  /**
   * The caption stack, built from caption IDENTITY: every row carries its own
   * original and its own translation (`buildBilingualStack`).
   */
  captions: BilingualStack
  translationEnabled: boolean
  /** Live-caption banner from the existing session surface, if any. */
  notice: { tier: 'info' | 'fatal'; text: string } | null
  /** The real message from a failed save. */
  failureMessage: string | null
  /** Optional follow-up for a limit notice / failure (e.g. open the plan view). */
  noticeAction?: { label: string; onClick: () => void } | null
  failureAction?: { label: string; onClick: () => void } | null
  busy: boolean
  canOpenOverlay: boolean
  onOpenOverlay: () => void
  onDiscard: () => void
  onPause: () => void
  onResume: () => void
  onStopAndSave: () => void
  /** Opens the exact saved lecture in the existing Lecture Detail. */
  onViewLecture: () => void
  onRecordAnother: () => void
  onRetry: () => void
  /** Saves the selected durable interrupted session through the normal pipeline. */
  onRecoverRecording: () => void
  /** First press arms deletion; the second performs the durable cleanup. */
  onDiscardRecovery: () => void
  onCancelRecoveryDiscard: () => void
  recoveryDiscardConfirm: boolean
  /**
   * Authoritative processing state of the lecture that was just saved (from
   * `lectureLifecycle`). Drives the Processing screen and, once `done`, the
   * explicit "View lecture" completion. Null when no hosted pipeline applies.
   */
  processing?: { phase: ProcessingPhase; stalled: boolean } | null
  /** Retry processing the SAME lecture and audio through the existing endpoint. */
  onRetryProcessing?: () => void
  recoveryItems?: Array<{ id: string; label: string }>
  selectedRecoveryId?: string | null
  selectedRecoveryNeedsCourse?: boolean
  recoveryCourseOptions?: Array<{ id: string; name: string }>
  onSelectRecovery?: (id: string) => void
  onAssignRecoveryCourse?: (courseId: string) => void
  onCreateRecoveryCourse?: () => void
}) {
  const live = stage === 'recording' || stage === 'paused'
  const terminal = isTerminalRecordingStage(stage)
  // The Processing screen: while the server works, when it failed, and the
  // completed state (with the explicit View lecture) once it is done.
  const showProcessingPanel =
    stage === 'ai_processing' ||
    stage === 'ai_failed' ||
    (stage === 'ready' && processing?.phase === 'done')

  const sourceHistory = captions.history
  const sourceLine = captions.current?.original ?? ''
  // THIS caption's translation, or nothing yet. Never the previous caption's.
  const translationLine = captions.current?.translation ?? ''
  // While the speaker is mid-caption a missing translation is simply not there yet — a standing
  // "Translating…" under every new phrase is more distracting than the short gap. Only a SETTLED
  // caption that is still waiting gets the quiet hint (and it fades in late, so a sub-second wait never flashes).
  const translationWaiting = Boolean(sourceLine) && !translationLine && !captions.current?.live

  /* ── Caption history scrolling ──────────────────────────────────────────────
     A plain `overflow-y: auto` container, so a two-finger trackpad gesture,
     a wheel and Page Up / Page Down are all handled natively — there is no
     synthetic drag anywhere. Auto-follow is a state machine rather than an
     effect that pins the scroller on every render, because the latter fought
     the reader for control every time a caption arrived. */
  const [follow, dispatchFollow] = useReducer(captionFollowReducer, INITIAL_CAPTION_FOLLOW)
  const historyRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef(0)

  /** Latest follow state, readable from a callback that was queued earlier. */
  const followRef = useRef(follow)
  useEffect(() => {
    followRef.current = follow
  }, [follow])
  /** Where the reader was last genuinely at the bottom — slow drags accumulate against it. */
  const followAnchor = useRef<FollowAnchor>(null)

  const pinToBottom = useCallback((behavior: ScrollBehavior = 'auto', force = false) => {
    const write = () => {
      const node = historyRef.current
      if (!node) return
      // A pin queued while following can land a frame AFTER the reader began
      // scrolling away and silently undo the first pixels of the drag. Re-check
      // at write time. Only "Jump to latest" bypasses this.
      if (!force && !shouldPinToBottom(followRef.current)) return
      node.scrollTo({ top: node.scrollHeight, behavior })
      // Seed the anchor even before any scroll event has fired, so the very
      // first drag from a freshly pinned bottom already has a reference.
      if (behavior === 'auto') {
        followAnchor.current = nextFollowAnchor(followAnchor.current, {
          scrollTop: node.scrollTop,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
        })
      }
    }
    // Written synchronously first. A rAF-only pin silently stops working
    // whenever the window is not being painted — and Open Overlay minimises the
    // main window on purpose — so the frame callback can only ever be a
    // correction, never the sole mechanism.
    write()
    // Then one rAF-batched correction per burst, after layout settles: captions
    // can arrive faster than a frame, and each write forces a layout flush.
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(write)
  }, [])

  /**
   * While this is in the future, a caption arriving may not move the scroller.
   *
   * macOS momentum keeps firing `scroll` long after the fingers lift. Pinning
   * during that window is what made the panel feel like it was pulling against
   * the gesture.
   */
  const userScrollingUntil = useRef(0)

  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])

  // One-shot geometry dump so a real WKWebView session records what the
  // scroller and every ancestor actually resolved to.
  useEffect(() => {
    probeScrollerGeometry(historyRef.current)
  }, [])

  // New captions may MOVE the scroller, but never change the follow state.
  useEffect(() => {
    dispatchFollow({ type: 'captions-changed' })
  }, [sourceHistory.length, sourceLine])

  useEffect(() => {
    // Never write scrollTop while the platform is still animating the user's
    // own gesture — that is what a fight feels like.
    if (performance.now() < userScrollingUntil.current) return
    if (shouldPinToBottom(follow)) pinToBottom()
  }, [follow, sourceHistory.length, sourceLine, pinToBottom])

  const readMetrics = useCallback(() => {
    const el = historyRef.current
    if (!el) return null
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }
  }, [])

  /** Previous scroll reading — the only way to tell which way the reader moved. */
  const lastSample = useRef<ScrollSample | null>(null)

  const onHistoryScroll = useCallback(() => {
    userScrollingUntil.current = performance.now() + 220
    const metrics = readMetrics()
    if (!metrics) return
    const sample: ScrollSample = { scrollTop: metrics.scrollTop, scrollHeight: metrics.scrollHeight }
    // Consecutive-event comparison alone ignores a move of 1px or less, so a
    // slow two-finger drag was never read as intent and the next caption pinned
    // the reader back down. See `classifyHistoryScroll`.
    const { up, anchor } = classifyHistoryScroll(lastSample.current, followAnchor.current, metrics)
    followAnchor.current = anchor
    lastSample.current = sample
    // Upward intent suspends follow immediately. Reporting it as a plain
    // position ('scrolled') instead keeps `following` true for the first
    // NEAR_BOTTOM_PX of the gesture, and the caption arriving a few hundred
    // milliseconds later pins the reader straight back down — the "auto-follow
    // steals the scroll" symptom.
    dispatchFollow(up ? { type: 'user-scrolled-up', metrics } : { type: 'scrolled', metrics })
  }, [readMetrics])

  /*
   * There is deliberately NO wheel handler.
   *
   * The history is a plain `overflow-y: auto` box, so two-finger scrolling,
   * momentum, the mouse wheel and Page Up/Down are entirely the platform's —
   * identical to Safari. Intent is read from the resulting scroll POSITION
   * instead of from the gesture, which is what keeps the panel from ever
   * fighting the user's fingers.
   *
   * The one thing that could fight is a programmatic pin arriving mid-gesture.
   * `userScrollingUntil` below suppresses that.
   */

  /*
   * Observe the CONTENT, not the scroll container.
   *
   * The container is sized by flex and its box never changes, so a
   * ResizeObserver on it never fires as lines are added. The first version did
   * exactly that and the very first pin landed while the list was still
   * unlaid-out — `scrollTo(clientHeight)` clamped to 0 and nothing ever
   * re-pinned, leaving history stuck at the top for the whole lecture.
   *
   * Growth of the inner list is the real signal, and it also covers a window
   * resize (reflow changes the content height too).
   */
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      const metrics = readMetrics()
      if (metrics) dispatchFollow({ type: 'resized', metrics })
      if (shouldPinToBottom(follow)) pinToBottom()
    })
    observer.observe(el)
    // The scroller's OWN box as well. Its height is now bounded by the window
    // (and moves with the live line below it), while the text inside does not
    // change when only the height of the window changes — so a following reader
    // whose window shrank was left with the newest line out of view until the
    // next caption. Pinning here is gated by `follow`, so a reader who has
    // scrolled away is never moved.
    const viewport = historyRef.current
    if (viewport) observer.observe(viewport)
    return () => observer.disconnect()
    // Rebuilding on a follow change is cheap: `follow` flips only when the
    // reader crosses the near-bottom threshold, a handful of times a lecture.
  }, [follow, pinToBottom, readMetrics])

  const jumpToLatest = useCallback(() => {
    dispatchFollow({ type: 'jump-to-latest' })
    pinToBottom('smooth', true)
  }, [pinToBottom])


  /* ── Header ─────────────────────────────────────────────────────────────── */

  const header = (
    <header className="recording-v2__head">
      <span className="recording-v2__status" data-status={stage}>
        <span className="recording-v2__dot" aria-hidden="true" />
        {stage === 'paused' ? t('recording.paused') : t('recording.rec')}
      </span>

      <span className="recording-v2__chip">
        <CourseIconTile identity={courseIdentity} size={28} radius={8} glyph={15} />
        <span className="recording-v2__chip-name">{courseName}</span>
      </span>

      <span className="recording-v2__title-block">
        <h1 id="recording-v2-title">{lectureTitle}</h1>
        <span className="recording-v2__meta">{languageLine}</span>
      </span>

      <span className="recording-v2__timer" aria-live="polite">
        <span className="recording-v2__timer-label">{t('recording.elapsed')}</span>
        <span className="recording-v2__timer-value">{elapsed}</span>
      </span>

      {canOpenOverlay ? (
        <button type="button" className="v2-btn" onClick={onOpenOverlay}>
          {t('recording.openOverlay')}
        </button>
      ) : null}
    </header>
  )

  /* ── After Stop & Save ──────────────────────────────────────────────────── */

  if (!live) {
    const titleKey = RECORDING_STAGE_TITLE_KEY[stage as keyof typeof RECORDING_STAGE_TITLE_KEY]
    const bodyKey = RECORDING_STAGE_BODY_KEY[stage as keyof typeof RECORDING_STAGE_BODY_KEY]

    return (
      <section className="recording-v2 recording-v2--after" aria-labelledby="recording-v2-title">
        {header}

        {showProcessingPanel ? (
          <div className="lecture-processing-slot" data-stage={stage}>
            <LectureProcessingPanel
              t={t}
              phase={stage === 'ai_failed' ? 'failed' : (processing?.phase ?? 'waiting')}
              stalled={processing?.stalled ?? false}
              busy={busy}
              onRetry={onRetryProcessing}
              onViewLecture={onViewLecture}
            />
            <div className="recording-v2__stage-actions">
              <button type="button" className="v2-btn" onClick={onRecordAnother} disabled={busy}>
                {t('recording.recordAnother')}
              </button>
            </div>
          </div>
        ) : (
        <div className="recording-v2__stage" data-stage={stage} role="status" aria-live="polite">
          {terminal ? null : <span className="recording-v2__spinner" aria-hidden="true" />}
          <h2>{titleKey ? t(titleKey) : ''}</h2>
          <p>{bodyKey ? t(bodyKey) : ''}</p>
          {/* The real reason, from the existing save pipeline. */}
          {failureMessage ? <p className="recording-v2__failure">{failureMessage}</p> : null}
          {failureMessage && failureAction ? (
            <button type="button" className="recording-v2__notice-action" onClick={failureAction.onClick}>
              {failureAction.label}
            </button>
          ) : null}

          <div className="recording-v2__stage-actions">
            {stage === 'upload_failed' ? (
              <button type="button" className="v2-btn v2-btn--record" onClick={onRetry} disabled={busy}>
                {t('recording.retry')}
              </button>
            ) : null}
            {stage === 'ready' || stage === 'partial_ready' ? (
              <>
                <button
                  type="button"
                  className="v2-btn v2-btn--record"
                  onClick={onViewLecture}
                  disabled={busy}
                >
                  {t('recording.viewLecture')}
                </button>
                <button type="button" className="v2-btn" onClick={onRecordAnother} disabled={busy}>
                  {t('recording.recordAnother')}
                </button>
              </>
            ) : null}
            {stage === 'recovery_required' ? (
              <>
                {recoveryItems.length > 1 ? (
                  <label className="recording-v2__recovery-select">
                    <span>Recovered recording</span>
                    <select value={selectedRecoveryId ?? ''} onChange={(event) => onSelectRecovery(event.target.value)} disabled={busy}>
                      {recoveryItems.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                    </select>
                  </label>
                ) : null}
                {selectedRecoveryNeedsCourse ? (
                  <label className="recording-v2__recovery-select">
                    <span>Choose course before saving</span>
                    {recoveryCourseOptions.length ? (
                      <select value="" onChange={(event) => onAssignRecoveryCourse(event.target.value)} disabled={busy}>
                        <option value="" disabled>Choose course</option>
                        {recoveryCourseOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                      </select>
                    ) : (
                      <button type="button" className="v2-btn" onClick={onCreateRecoveryCourse} disabled={busy}>Create a course</button>
                    )}
                  </label>
                ) : null}
                <button
                  type="button"
                  className="v2-btn v2-btn--record"
                  onClick={onRecoverRecording}
                  disabled={busy || selectedRecoveryNeedsCourse}
                >
                  {t('recording.recover')}
                </button>
                <button type="button" className="v2-btn" onClick={onDiscardRecovery} disabled={busy}>
                  {recoveryDiscardConfirm ? t('recording.confirmDiscard') : t('recording.discard')}
                </button>
                {recoveryDiscardConfirm ? (
                  <button type="button" className="v2-quiet-link" onClick={onCancelRecoveryDiscard}>
                    {t('common.cancel')}
                  </button>
                ) : null}
              </>
            ) : null}
            {stage === 'upload_failed' ? (
              <button type="button" className="v2-quiet-link" onClick={onRecordAnother}>
                {t('recording.dismiss')}
              </button>
            ) : null}
          </div>
        </div>
        )}

        {/* Captions from the session stay readable while it saves. */}
        {sourceHistory.length > 0 || sourceLine ? (
          <div className="recording-v2__captions recording-v2__captions--after">
            <div
              className="recording-v2__history"
              ref={historyRef}
              onScroll={onHistoryScroll}
                          tabIndex={0}
              role="log"
              aria-label={t('recording.sourceLabel')}
            >
              {sourceHistory.map((row) => (
                <CaptionPairRow key={row.key} row={row} translationEnabled={translationEnabled} />
              ))}
              {captions.current ? (
                <CaptionPairRow row={captions.current} translationEnabled={translationEnabled} />
              ) : null}
            </div>
          </div>
        ) : null}
      </section>
    )
  }

  /* ── Live ───────────────────────────────────────────────────────────────── */

  return (
    <section className="recording-v2" aria-labelledby="recording-v2-title">
      {header}

      {notice ? (
        <p
          className="recording-v2__notice"
          data-tier={notice.tier}
          role={notice.tier === 'fatal' ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      ) : null}
      {notice && noticeAction ? (
        <button type="button" className="recording-v2__notice-action" onClick={noticeAction.onClick}>
          {noticeAction.label}
        </button>
      ) : null}

      <div className="recording-v2__captions">
        <div className="recording-v2__history-wrap">
          <div
            className="recording-v2__history"
            ref={historyRef}
            onScroll={onHistoryScroll}
                      tabIndex={0}
            role="log"
            /*
             * `off`, deliberately. The live line below is the polite live
             * region; announcing history too would make a screen reader re-read
             * the whole lecture on every interim token.
             */
            aria-live="off"
            aria-label={t('recording.sourceLabel')}
          >
            <div ref={contentRef}>
              {sourceHistory.map((row) => (
                <CaptionPairRow key={row.key} row={row} translationEnabled={translationEnabled} />
              ))}
            </div>
          </div>

          {shouldShowJumpToLatest(follow) ? (
            <button
              type="button"
              className="recording-v2__jump"
              onClick={jumpToLatest}
              data-unseen={follow.hasUnseen ? 'true' : undefined}
            >
              {t('recording.jumpToLatest')}
            </button>
          ) : null}
        </div>

        <div className="recording-v2__live" aria-live="polite">
          <p className="recording-v2__source" data-empty={sourceLine ? undefined : 'true'}>
            {sourceLine || t('recording.waiting')}
          </p>
          {translationEnabled ? (
            <p
              className="recording-v2__translation"
              data-empty={translationLine ? undefined : 'true'}
              data-pending={translationWaiting ? 'true' : undefined}
            >
              {translationLine || (translationWaiting ? t('recording.translating') : '')}
            </p>
          ) : null}
        </div>
      </div>

      <footer className="recording-v2__controls">
        <button
          type="button"
          className="v2-quiet-link recording-v2__discard"
          onClick={onDiscard}
          disabled={busy}
        >
          {t('recording.discard')}
        </button>
        <span className="recording-v2__spacer" />
        <button
          type="button"
          className="v2-btn"
          onClick={stage === 'recording' ? onPause : onResume}
          disabled={busy}
        >
          {stage === 'recording' ? t('recording.pause') : t('recording.resume')}
        </button>
        <button
          type="button"
          className="v2-btn v2-btn--record"
          onClick={onStopAndSave}
          disabled={busy}
        >
          {t('recording.stopSave')}
        </button>
      </footer>
    </section>
  )
}
