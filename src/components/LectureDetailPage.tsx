import { useEffect, useMemo, useRef, useState } from 'react'
import type { Recording, RecordingDetail } from '../types'
import { courseIdentity, lectureIdentity, type Course } from '../lib/courses/courseModel'
import type { DesktopI18nKey } from '../lib/desktopI18n'
import { formatMarkClock, markSeekSeconds, parseMarks } from '../lib/lectureAnnotations'
import {
  lectureReadiness,
  parseLectureSummary,
  transcriptParagraphs,
} from '../lib/lectureSummary'
import { CourseIconTile } from './CourseIconTile'
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
}: {
  t: T
  /** The list row: always present, so the header never waits on the detail. */
  recording: Recording
  /** The loaded row: transcript, summaries, storage path. Null while loading. */
  detail: RecordingDetail | null
  /** True when the row fetch itself failed — not the same as `detail` being
   * null because there is genuinely no summary/transcript yet. */
  detailLoadFailed?: boolean
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
}) {
  const [tab, setTab] = useState<'summary' | 'transcript' | 'notes'>('summary')
  const [summaryLocale, setSummaryLocale] = useState<'en' | 'zh'>('en')
  const [copied, setCopied] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  const transcript = detail?.transcript ?? null
  const summaryEn = detail?.summaryEn ?? null
  const summaryZh = detail?.summaryZh ?? null

  const readiness = lectureReadiness({
    hasAudio: Boolean(recording.storagePath || recording.durationSec > 0),
    aiStatus: detail?.aiStatus ?? recording.aiStatus,
    transcript,
    summaryEn,
    summaryZh,
  })

  const summary = useMemo(
    () => parseLectureSummary(summaryLocale === 'en' ? summaryEn : summaryZh),
    [summaryLocale, summaryEn, summaryZh],
  )
  const paragraphs = useMemo(() => transcriptParagraphs(transcript), [transcript])

  /* ── Notes ──────────────────────────────────────────────────────────────
     Source of truth is the row. `draft` is what the user is typing, and it is
     only re-seeded from the row when the row's own text changes — so a refresh
     arriving mid-sentence cannot wipe an unsaved edit. */
  const storedNotes = recording.notes ?? ''
  const [draft, setDraft] = useState(storedNotes)
  const [notesState, setNotesState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const lastSeeded = useRef(storedNotes)

  useEffect(() => {
    if (lastSeeded.current === storedNotes) return
    lastSeeded.current = storedNotes
    // A remote edit won the merge. Adopt it only when there is nothing unsaved
    // to lose; otherwise the user's in-progress text stays on screen.
    setDraft((current) => (current === '' || notesState === 'saved' ? storedNotes : current))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedNotes])

  // A different lecture is a different document.
  useEffect(() => {
    lastSeeded.current = recording.notes ?? ''
    setDraft(recording.notes ?? '')
    setNotesState('idle')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording.id])

  const notesDirty = draft !== storedNotes

  const saveNotes = () => {
    setNotesState('saving')
    onSaveNotes(draft)
      .then(() => {
        lastSeeded.current = draft
        setNotesState('saved')
      })
      // Nothing is cleared and nothing pretends to have succeeded: the text the
      // user wrote is still in the box, and the failure is stated.
      .catch(() => setNotesState('failed'))
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
  const bothSummaries = Boolean(summaryEn?.trim()) && Boolean(summaryZh?.trim())

  const copyTranscript = () => {
    if (!transcript) return
    void navigator.clipboard
      .writeText(transcript)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1600)
      })
      .catch(() => undefined)
  }

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
                aria-pressed={summaryLocale === 'en'}
                onClick={() => setSummaryLocale('en')}
              >
                {t('lecture.summaryEnglish')}
              </button>
              <button
                type="button"
                className="lecture-v2__locale-btn"
                aria-pressed={summaryLocale === 'zh'}
                onClick={() => setSummaryLocale('zh')}
              >
                {t('lecture.summaryChinese')}
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
          ) : detailLoadFailed ? (
            <div className="lecture-v2__empty" role="alert">
              <h2>{t('lecture.detailLoadError')}</h2>
              <p>{t('lecture.detailLoadErrorBody')}</p>
              <button type="button" className="v2-btn" onClick={onRetryDetail}>
                {t('common.retry')}
              </button>
            </div>
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
          ) : detailLoadFailed ? (
            <div className="lecture-v2__empty" role="alert">
              <h2>{t('lecture.detailLoadError')}</h2>
              <p>{t('lecture.detailLoadErrorBody')}</p>
              <button type="button" className="v2-btn" onClick={onRetryDetail}>
                {t('common.retry')}
              </button>
            </div>
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
                  setDraft(e.currentTarget.value)
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
                      setDraft(storedNotes)
                      setNotesState('idle')
                    }}
                  >
                    {t('lecture.notesDiscard')}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="v2-btn v2-btn--record"
                  onClick={saveNotes}
                  disabled={notesState === 'saving' || (!notesDirty && notesState !== 'failed')}
                >
                  {notesState === 'saving'
                    ? t('lecture.notesSaving')
                    : notesState === 'failed'
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
            <p>{audioError ? t('lecture.audioUnavailable') : t('lecture.audioLoading')}</p>
            {audioError ? (
              <button type="button" className="v2-btn" onClick={onRetryAudio}>
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
