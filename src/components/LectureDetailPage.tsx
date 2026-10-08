import { useEffect, useMemo, useRef, useState } from 'react'
import type { Recording, RecordingDetail } from '../types'
import { courseIdentity, lectureIdentity, type Course } from '../lib/courses/courseModel'
import type { DesktopI18nKey } from '../lib/desktopI18n'
import { formatMarkClock, markSeekSeconds, parseMarks } from '../lib/lectureAnnotations'
import { isNotesUnavailable } from '../lib/lectureNotes'
import { contentLanguageLabelOr } from '../lib/contentLanguages'
import { lectureLifecycle } from '../lib/lectureLifecycle'
import {
  initialSummaryKind,
  isTranslationEnabled,
  lectureLanguagesFromRow,
  lectureSummariesFor,
  type SummaryKind,
} from '../lib/lectureLanguages'
import { parseLectureSummary, transcriptParagraphs } from '../lib/lectureSummary'
import { CourseIconTile } from './CourseIconTile'
import { LectureProcessingPanel } from './LectureProcessingPanel'
import { RecordingAudioPlayer, type AudioPlayerHandle } from './RecordingAudioPlayer'
import '../styles/lecture-detail-v2.css'

/**
 * Lecture Detail V2 — the production screen, on real data.
 *
 * Replaces the legacy detail that lived inside `YoumiLensShell`'s transcript and
 * summary slots. Every entry point now routes here through
 * `openLectureDetail(recordingId)`; nothing reaches the legacy shell any more.
 *
 * Honesty rules that shape this component:
 *
 *  · Summary sections come from `parseLectureSummary`, which reads the `## `
 *    headings the production prompt actually asks for. A summary without
 *    headings renders whole, under no invented section titles.
 *  · The stored transcript has no timestamps, so there is no seek affordance and
 *    no per-sentence card wall — one continuous, selectable block.
 *  · Playback is the existing `RecordingAudioPlayer` on the real `audioUrl`.
 *    When there is no audio the player is replaced by a plain statement, never
 *    by a dead transport.
 *
 * This component performs no I/O: every action is a callback into an existing
 * production handler.
 */

type T = (key: DesktopI18nKey, vars?: Record<string, string | number>) => string

const READINESS_KEY = {
  ready: 'lecture.statusReady',
  transcript_only: 'lecture.statusTranscriptOnly',
  processing: 'lecture.statusProcessing',
  failed: 'lecture.statusFailed',
  none: 'lecture.statusNone',
} as const

export function LectureDetailPage({
  t,
  recording,
  detail,
  detailLoadFailed = false,
  detailLoading = false,
  onRetryDetail = () => undefined,
  course,
  audioUrl,
  audioError = null,
  onRetryAudio = () => undefined,
  languageLine,
  formatDate,
  formatDuration,
  onBack,
  backLabel,
  onRename,
  onMove,
  onDelete,
  actionsDisabled,
  onSaveNotes,
  onAddMark,
  annotationsEditable,
  aiExpected = true,
  processingFailed = false,
  onRetryProcessing = () => undefined,
  initialNotes,
  notesRestored = false,
  onNotesDraftChange,
  onNotesDiscard,
  onNotesLeave,
  initialTab = 'summary',
}: {
  t: T
  /** The list row: always present, so the header never waits on the detail. */
  recording: Recording
  /** The loaded row: transcript, summaries, storage path. Null while loading. */
  detail: RecordingDetail | null
  /** True when the row fetch itself failed — not the same as `detail` being
   * null because there is genuinely no summary/transcript yet. */
  detailLoadFailed?: boolean
  /** The authoritative row is being fetched and there is nothing complete to show yet. */
  detailLoading?: boolean
  onRetryDetail?: () => void
  course: Course | null
  audioUrl: string | null
  audioError?: string | null
  onRetryAudio?: () => void
  languageLine: string
  formatDate: (epochMs: number) => string
  formatDuration: (seconds: number) => string
  onBack: () => void
  /** Names where Back goes — the owning course, or Courses. */
  backLabel: string
  onRename: () => void
  onMove: () => void
  onDelete: () => void
  actionsDisabled: boolean
  /**
   * Persist Notes. Resolves on a confirmed write and REJECTS on failure — the
   * editor keeps the text and says so rather than clearing itself and hoping.
   */
  onSaveNotes: (notes: string) => Promise<void>
  /** Persist the whole marks array with one appended. Rejects on failure. */
  onAddMark: (atMs: number) => Promise<void>
  /**
   * False in local-only mode, where these fields have no store. The surfaces
   * stay visible and read-only rather than silently dropping writes.
   */
  annotationsEditable: boolean
  /**
   * A hosted AI pipeline is expected to produce the transcript and summary.
   * False for local-only / own-key, where saved audio is the whole product.
   */
  aiExpected?: boolean
  /** The attempt to start processing was rejected or never reached the server.
   *  The row still says `pending`, so this is what turns "Processing" into an
   *  honest, retryable failure. */
  processingFailed?: boolean
  onRetryProcessing?: () => void
  /**
   * What the editor starts with. The cloud note, or — when this lecture was left
   * with unsaved text — that draft, brought back. Defaults to the stored note.
   */
  initialNotes?: string
  /** `initialNotes` is an unsaved draft from an earlier visit. */
  notesRestored?: boolean
  /** Every edit, so the text is durable on this Mac before any network. */
  onNotesDraftChange?: (text: string) => void
  /** A deliberate Discard — the only thing that may throw a draft away. */
  onNotesDiscard?: () => void
  /** Leaving with unsaved text: the owner pushes it to the cloud in the background. */
  onNotesLeave?: () => void
  /** Which tab opens first. Only tests and deep links need anything but Summary. */
  initialTab?: 'summary' | 'transcript' | 'notes'
}) {
  const [tab, setTab] = useState<'summary' | 'transcript' | 'notes'>(initialTab)
  // The reader's explicit choice; until they make one the default rule decides.
  const [summaryChoice, setSummaryChoice] = useState<SummaryKind | null>(null)
  const [transcriptChoice, setTranscriptChoice] = useState<SummaryKind>('source')
  const [copied, setCopied] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  // Outputs come from the loaded row, else from the list row (which carries the
  // same columns). A finished lecture therefore never renders empty just because
  // its detail is still being fetched, or because that fetch failed.
  const source = detail ?? recording
  const transcript = source.transcript ?? null
  const summaryEn = source.summaryEn ?? null
  const summaryZh = source.summaryZh ?? null
  // The lecture's OWN languages (frozen on its row), never today's preference.
  const languages = lectureLanguagesFromRow(source)
  const translationOn = isTranslationEnabled(languages)
  const summaries = lectureSummariesFor(languages, source)
  const translatedTranscript = translationOn ? source.translatedTranscript?.trim() || null : null

  const life = lectureLifecycle({
    hasAudio: Boolean(recording.storagePath || recording.durationSec > 0),
    aiStatus: source.aiStatus ?? recording.aiStatus,
    aiUpdatedAt: source.aiUpdatedAt ?? recording.aiUpdatedAt,
    transcript,
    summaryEn,
    summaryZh,
    sourceSummary: source.sourceSummary ?? null,
    translatedSummary: source.translatedSummary ?? null,
    aiExpected,
    requestFailed: processingFailed,
  })
  const readiness = life.kind

  // Translated summary first when translation was on, else the original; the
  // other is one click away. A choice for a summary that does not exist yields
  // to the one that does.
  const summaryKind: SummaryKind | null =
    summaryChoice && summaries[summaryChoice]
      ? summaryChoice
      : initialSummaryKind(languages, summaries)
  const summaryText =
    summaryKind === 'translated' ? summaries.translated : summaryKind === 'source' ? summaries.source : null
  // A short markdown parse; computed directly (the React Compiler memoises it).
  const summary = parseLectureSummary(summaryText)
  const shownTranscript =
    transcriptChoice === 'translated' && translatedTranscript ? translatedTranscript : transcript
  const paragraphs = useMemo(() => transcriptParagraphs(shownTranscript), [shownTranscript])
  const sourceLabel = contentLanguageLabelOr(languages.sourceLanguage, languages.sourceLanguage)
  const translatedLabel = contentLanguageLabelOr(languages.translationLanguage, languages.translationLanguage)

  /* ── Notes ──────────────────────────────────────────────────────────────
     Source of truth is the row. `draft` is what the user is typing, and it is
     only re-seeded from the row when the row's own text changes — so a refresh
     arriving mid-sentence cannot wipe an unsaved edit. */
  const storedNotes = recording.notes ?? ''
  const [draft, setDraft] = useState(initialNotes ?? storedNotes)
  const [notesState, setNotesState] = useState<'idle' | 'saving' | 'saved' | 'failed' | 'unavailable'>('idle')
  const lastSeeded = useRef(storedNotes)
  const seededFor = useRef(recording.id)

  useEffect(() => {
    if (lastSeeded.current === storedNotes) return
    lastSeeded.current = storedNotes
    // A remote edit won the merge. Adopt it only when there is nothing unsaved
    // to lose; otherwise the user's in-progress text stays on screen.
    setDraft((current) => (current === '' || notesState === 'saved' ? storedNotes : current))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedNotes])

  // A different lecture is a different document. (Not on first mount: the editor
  // was just initialised, possibly with a restored unsaved draft.)
  useEffect(() => {
    if (seededFor.current === recording.id) return
    seededFor.current = recording.id
    lastSeeded.current = recording.notes ?? ''
    setDraft(initialNotes ?? recording.notes ?? '')
    setNotesState('idle')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording.id])

  // Leaving with unsaved text hands it to the owner, which pushes it in the
  // background. The text is already durable (every edit was written ahead); this
  // only gives the cloud a chance to catch up. Refs: it must see the LATEST values
  // at unmount, not the ones from first render.
  const leave = useRef({ dirty: false, onNotesLeave })
  useEffect(() => {
    leave.current = { dirty: draft !== storedNotes, onNotesLeave }
  })
  useEffect(
    () => () => {
      if (leave.current.dirty) leave.current.onNotesLeave?.()
    },
    [],
  )

  const notesDirty = draft !== storedNotes

  const saveNotes = () => {
    setNotesState('saving')
    onSaveNotes(draft)
      .then(() => {
        lastSeeded.current = draft
        setNotesState('saved')
      })
      // Nothing is cleared and nothing pretends to have succeeded: the text the
      // user wrote is still in the box (and still on this Mac), and the failure is
      // stated — a schema gap in words that do not promise a retry will fix it.
      .catch((err) => setNotesState(isNotesUnavailable(err) ? 'unavailable' : 'failed'))
  }

  /* ── Marks ──────────────────────────────────────────────────────────────
     `marked_timestamps` is `number[]` of elapsed milliseconds. Parsed, never
     sorted and never de-duplicated: stored order is the contract, and a client
     that normalised it would hand a different array to every other device. */
  const marks = useMemo(() => parseMarks(recording.markedTimestamps), [recording.markedTimestamps])
  const player = useRef<AudioPlayerHandle | null>(null)
  const [markError, setMarkError] = useState(false)

  const seekToMark = (ms: number) => {
    player.current?.seekTo(markSeekSeconds(ms))
  }

  const addMark = () => {
    const at = player.current?.currentTime()
    if (at === undefined) return
    setMarkError(false)
    onAddMark(Math.round(at * 1000)).catch(() => setMarkError(true))
  }

  // Only offer the language switch when both really exist.
  const bothSummaries = Boolean(summaries.source) && Boolean(summaries.translated)

  const copyTranscript = () => {
    if (!shownTranscript) return
    void navigator.clipboard
      .writeText(shownTranscript)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1600)
      })
      .catch(() => undefined)
  }

  /* While the lecture is not finished, the body is ONE honest state, not a pair
     of empty tabs:
       · the authoritative row could not be read      → load error + Retry
       · it is still being read                       → loading (never a stale "Processing")
       · the server is working, or it failed          → the Processing panel
     A finished lecture (outputs persisted) never gets here — see `lectureLifecycle`. */
  const reloadable = life.kind === 'processing' || life.kind === 'failed' || life.kind === 'none'
  const gate = life.complete ? null : detailLoadFailed ? (
    <div className="lecture-v2__empty" role="alert">
      <h2>{t('lecture.detailLoadError')}</h2>
      <p>{t('lecture.detailLoadErrorBody')}</p>
      <button type="button" className="v2-btn" onClick={onRetryDetail}>
        {t('common.retry')}
      </button>
    </div>
  ) : detailLoading && reloadable ? (
    <div className="lecture-v2__empty" role="status" aria-live="polite">
      <h2>{t('processing.loadingLecture')}</h2>
    </div>
  ) : life.kind === 'processing' || life.kind === 'failed' ? (
    <LectureProcessingPanel
      t={t}
      phase={life.phase ?? 'waiting'}
      stalled={life.stalled}
      onRetry={onRetryProcessing}
    />
  ) : null

  const title = recording.title?.trim() || t('recording.untitled')

  return (
    <section className="lecture-v2" aria-labelledby="lecture-v2-title">
      <div className="lecture-v2__bar">
        <button type="button" className="v2-quiet-link" onClick={onBack}>
          ‹ {backLabel}
        </button>
        <span className="lecture-v2__bar-spacer" />
        <div className="lecture-v2__menu" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="course-menu__trigger"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t('lecture.actions')}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
              <circle cx="5.5" cy="12" r="1.7" />
              <circle cx="12" cy="12" r="1.7" />
              <circle cx="18.5" cy="12" r="1.7" />
            </svg>
          </button>
          {menuOpen ? (
            <div className="lecture-v2__menu-pop" role="menu" aria-label={t('lecture.actions')}>
              <button
                type="button"
                role="menuitem"
                disabled={actionsDisabled}
                onClick={() => {
                  setMenuOpen(false)
                  onRename()
                }}
              >
                {t('lecture.rename')}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={actionsDisabled}
                onClick={() => {
                  setMenuOpen(false)
                  onMove()
                }}
              >
                {t('lecture.move')}
              </button>
              <div className="course-menu__rule" role="separator" />
              <button
                type="button"
                role="menuitem"
                data-danger="true"
                disabled={actionsDisabled}
                onClick={() => {
                  setMenuOpen(false)
                  onDelete()
                }}
              >
                {t('lecture.delete')}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <header className="lecture-v2__head">
        <CourseIconTile identity={lectureIdentity(course)} size={48} radius={12} glyph={24} />
        <div className="lecture-v2__head-text">
          <h1 id="lecture-v2-title">{title}</h1>
          <p className="lecture-v2__meta">
            {course ? (
              <span className="lecture-v2__course">
                <CourseIconTile identity={courseIdentity(course)} size={16} radius={5} glyph={9} />
                {t('lecture.inCourse', { course: course.name })}
              </span>
            ) : (
              <span>{t('deleted.unfiled')}</span>
            )}
            <span className="lecture-v2__dot" aria-hidden="true" />
            <span>{formatDate(recording.createdAt)}</span>
            <span className="lecture-v2__dot" aria-hidden="true" />
            <span>{formatDuration(recording.durationSec)}</span>
            <span className="lecture-v2__dot" aria-hidden="true" />
            <span>{languageLine}</span>
          </p>
        </div>
        <span className="v2-badge" data-status={readiness === 'ready' ? 'ready' : readiness === 'failed' ? 'failed' : 'processing'}>
          {t(READINESS_KEY[readiness])}
        </span>
      </header>

      {gate ?? (
        <>
          <div className="lecture-v2__tabs" role="tablist" aria-label={title}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'summary'}
              className="lecture-v2__tab"
              onClick={() => setTab('summary')}
            >
              {t('lecture.tabSummary')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'transcript'}
              className="lecture-v2__tab"
              onClick={() => setTab('transcript')}
            >
              {t('lecture.tabTranscript')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'notes'}
              className="lecture-v2__tab"
              onClick={() => setTab('notes')}
            >
              {t('lecture.tabNotes')}
            </button>
          </div>

          {tab === 'summary' ? (
            <div className="lecture-v2__panel" role="tabpanel">
              {bothSummaries ? (
                <div className="lecture-v2__locale">
                  <button
                    type="button"
                    className="lecture-v2__locale-btn"
                    aria-pressed={summaryKind === 'source'}
                    onClick={() => setSummaryChoice('source')}
                  >
                    {sourceLabel}
                  </button>
                  <button
                    type="button"
                    className="lecture-v2__locale-btn"
                    aria-pressed={summaryKind === 'translated'}
                    onClick={() => setSummaryChoice('translated')}
                  >
                    {translatedLabel}
                  </button>
                </div>
              ) : null}

              {summary ? (
                <>
                  {/* An older row with no headings is shown whole, and labelled as
                      such, rather than being chopped into invented sections. */}
                  {!summary.structured ? (
                    <p className="lecture-v2__note">{t('lecture.summaryUnstructured')}</p>
                  ) : null}
                  {summary.sections.map((section, index) => (
                    <section key={`${index}-${section.title ?? 'body'}`} className="lecture-v2__section">
                      {section.title ? <h2>{section.title}</h2> : null}
                      <div className="lecture-v2__prose">
                        {section.body.split(/\n{2,}/).map((block, i) => (
                          <p key={i}>{block}</p>
                        ))}
                      </div>
                    </section>
                  ))}
                </>
              ) : (
                <div className="lecture-v2__empty">
                  <h2>{t('lecture.summaryEmpty')}</h2>
                  <p>
                    {readiness === 'processing' || readiness === 'transcript_only'
                      ? t('lecture.summaryProcessing')
                      : t('lecture.summaryEmptyBody')}
                  </p>
                </div>
              )}
            </div>
          ) : tab === 'transcript' ? (
            <div className="lecture-v2__panel" role="tabpanel">
              {paragraphs.length > 0 ? (
                <>
                  {translatedTranscript ? (
                    <div className="lecture-v2__locale">
                      <button
                        type="button"
                        className="lecture-v2__locale-btn"
                        aria-pressed={transcriptChoice === 'source'}
                        onClick={() => setTranscriptChoice('source')}
                      >
                        {sourceLabel}
                      </button>
                      <button
                        type="button"
                        className="lecture-v2__locale-btn"
                        aria-pressed={transcriptChoice === 'translated'}
                        onClick={() => setTranscriptChoice('translated')}
                      >
                        {translatedLabel}
                      </button>
                    </div>
                  ) : null}
                  <div className="lecture-v2__panel-tools">
                    <button type="button" className="v2-btn" onClick={copyTranscript}>
                      {copied ? t('lecture.copied') : t('lecture.copyTranscript')}
                    </button>
                  </div>
                  {/* One continuous selectable block. The stored transcript carries
                      no timestamps, so there is nothing to seek to and no per-line
                      card wall pretending otherwise. */}
                  <div className="lecture-v2__prose lecture-v2__transcript">
                    {paragraphs.map((p, i) => (
                      <p key={i}>{p}</p>
                    ))}
                  </div>
                </>
              ) : (
                <div className="lecture-v2__empty">
                  <h2>{t('lecture.transcriptEmpty')}</h2>
                  <p>
                    {readiness === 'processing'
                      ? t('lecture.transcriptProcessing')
                      : t('lecture.transcriptEmptyBody')}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="lecture-v2__panel" role="tabpanel">
              {annotationsEditable ? (
                <>
                  <label className="lecture-v2__notes-label" htmlFor="lecture-v2-notes">
                    {t('lecture.tabNotes')}
                  </label>
                  <textarea
                    id="lecture-v2-notes"
                    className="lecture-v2__notes"
                    value={draft}
                    placeholder={t('lecture.notesPlaceholder')}
                    spellCheck
                    onChange={(e) => {
                      const value = e.currentTarget.value
                      setDraft(value)
                      // Write-ahead: durable on this Mac before any network.
                      onNotesDraftChange?.(value)
                      if (notesState !== 'idle') setNotesState('idle')
                    }}
                  />
                  <div className="lecture-v2__notes-bar">
                    {/* The failure is stated in words, next to the text that is
                        still there. Nothing was lost and nothing was cleared. */}
                    {notesState === 'failed' ? (
                      <p className="lecture-v2__notes-error" role="alert">
                        {t('lecture.notesSaveFailed')}
                      </p>
                    ) : notesState === 'unavailable' ? (
                      <p className="lecture-v2__notes-error" role="alert">
                        {t('lecture.notesUnavailable')}
                      </p>
                    ) : notesRestored && notesDirty && notesState === 'idle' ? (
                      <p className="lecture-v2__notes-hint" role="status">
                        {t('lecture.notesRestored')}
                      </p>
                    ) : notesState === 'saved' && !notesDirty ? (
                      <p className="lecture-v2__notes-ok" role="status">
                        {t('lecture.notesSaved')}
                      </p>
                    ) : (
                      <span className="lecture-v2__notes-hint">{t('lecture.notesEmptyBody')}</span>
                    )}
                    <span className="lecture-v2__notes-spacer" />
                    {notesDirty && notesState !== 'saving' ? (
                      <button
                        type="button"
                        className="v2-quiet-link"
                        onClick={() => {
                          // The only thing that throws a draft away: a deliberate click.
                          setDraft(storedNotes)
                          setNotesState('idle')
                          onNotesDiscard?.()
                        }}
                      >
                        {t('lecture.notesDiscard')}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="v2-btn v2-btn--record"
                      onClick={saveNotes}
                      disabled={
                        notesState === 'saving' ||
                        (!notesDirty && notesState !== 'failed' && notesState !== 'unavailable')
                      }
                    >
                      {notesState === 'saving'
                        ? t('lecture.notesSaving')
                        : notesState === 'failed' || notesState === 'unavailable'
                          ? t('lecture.notesRetry')
                          : t('lecture.notesSave')}
                    </button>
                  </div>
                </>
              ) : storedNotes.trim() ? (
                /* Local-only mode: the field has no store here, so it is shown as
                   written elsewhere rather than offered as an editor that drops
                   what the user types. Line breaks are preserved by the CSS. */
                <div className="lecture-v2__prose lecture-v2__notes-read">{storedNotes}</div>
              ) : (
                <div className="lecture-v2__empty">
                  <h2>{t('lecture.notesEmpty')}</h2>
                  <p>{t('lecture.notesLocalOnly')}</p>
                </div>
              )}
            </div>
          )}
        </>
      )}

      <div className="lecture-v2__player">
        {audioUrl ? (
          <RecordingAudioPlayer
            recordingId={recording.id}
            src={audioUrl}
            durationSecFallback={recording.durationSec}
            controlsRef={player}
          />
        ) : (
          <div className="lecture-v2__note">
            {/* A failed row fetch (`detailLoadFailed`) never produces `audioUrl`
                or `audioError` — without this check the audio section stayed on
                "Loading audio…" forever even after the row load itself had
                already reached its own Retry state above. */}
            <p>{audioError || detailLoadFailed ? t('lecture.audioUnavailable') : t('lecture.audioLoading')}</p>
            {audioError || detailLoadFailed ? (
              <button type="button" className="v2-btn" onClick={detailLoadFailed ? onRetryDetail : onRetryAudio}>
                {t('recording.retry')}
              </button>
            ) : null}
          </div>
        )}

        {/* Marked moments sit with the transport they control, so a mark is one
            click from the scrubber rather than a separate screen. */}
        <section className="lecture-v2__marks" aria-label={t('lecture.marksTitle')}>
          <div className="lecture-v2__marks-head">
            <h2>{t('lecture.marksTitle')}</h2>
            {marks.length > 0 ? (
              <span className="lecture-v2__marks-count">
                {t('lecture.marksCount', { count: marks.length })}
              </span>
            ) : null}
            <span className="lecture-v2__notes-spacer" />
            {annotationsEditable && audioUrl ? (
              <button type="button" className="v2-btn" onClick={addMark}>
                {t('lecture.marksAdd')}
              </button>
            ) : null}
          </div>

          {markError ? (
            <p className="lecture-v2__notes-error" role="alert">
              {t('lecture.marksAddFailed')}
            </p>
          ) : null}

          {marks.length > 0 ? (
            <ul className="lecture-v2__mark-list">
              {/* Stored order, duplicates included. Index is part of the key
                  because two marks at the same millisecond are legal V1 data. */}
              {marks.map((ms, index) => (
                <li key={`${index}-${ms}`}>
                  <button
                    type="button"
                    className="lecture-v2__mark"
                    onClick={() => seekToMark(ms)}
                    disabled={!audioUrl}
                    aria-label={t('lecture.marksSeek', { time: formatMarkClock(ms) })}
                  >
                    {formatMarkClock(ms)}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="lecture-v2__note">{t('lecture.marksEmpty')}</p>
          )}
        </section>
      </div>
    </section>
  )
}
