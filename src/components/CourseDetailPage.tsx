import { useMemo, useState } from 'react'
import type { Recording } from '../types'
import {
  courseIdentity,
  lectureIdentity,
  lecturesInCourse,
  pluralForm,
  type Course,
} from '../lib/courses/courseModel'
import type { CoursesCapabilities } from '../lib/courses/coursesRepository'
import type { DesktopI18nKey } from '../lib/desktopI18n'
import { CourseIconTile } from './CourseIconTile'
import { CourseActionsMenu } from './CourseActionsMenu'
import type { LectureStatus } from './CoursesPage'

/**
 * Course Detail, wired to real data.
 *
 * A lecture row's body opens the EXISTING Lecture Detail — Lecture Detail V2 is
 * explicitly out of scope for this phase. There is deliberately no per-lecture
 * ••• menu here either: that would drag the Lecture CRUD UI in ahead of its
 * phase.
 *
 * "Start new lecture" starts recording under this course immediately — the same
 * explicit recording entry as Record Home's Start button, with the course UUID
 * already selected. It is the one behaviour that distinguishes this button from
 * opening a course card.
 */

type T = (key: DesktopI18nKey, vars?: Record<string, string | number>) => string

export function CourseDetailPage({
  t,
  course,
  courses,
  recordings,
  capabilities,
  loading = false,
  error = null,
  onRetry = () => undefined,
  lectureStatus,
  formatDuration,
  formatDate,
  onBack,
  onStartLecture,
  onOpenLecture,
  onRenameCourse,
  onDeleteCourse,
}: {
  t: T
  course: Course
  courses: readonly Course[]
  recordings: readonly Recording[]
  capabilities: CoursesCapabilities
  /** True only while the initial (or an identity-change) fetch is in flight. */
  loading?: boolean
  /** Set when the repository itself failed to answer — not a mutation refusal. */
  error?: string | null
  onRetry?: () => void
  lectureStatus: (recording: Recording) => LectureStatus
  formatDuration: (seconds: number) => string
  formatDate: (epochMs: number) => string
  onBack: () => void
  onStartLecture: () => void
  onOpenLecture: (recordingId: string) => void
  onRenameCourse: () => void
  onDeleteCourse: () => void
}) {
  const [query, setQuery] = useState('')

  const owned = useMemo(
    () => lecturesInCourse(course.id, recordings, courses),
    [course.id, recordings, courses],
  )

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return owned
    return owned.filter((recording) => (recording.title ?? '').toLowerCase().includes(needle))
  }, [owned, query])

  const lectureCount = (n: number) =>
    t(pluralForm(n) === 'one' ? 'courses.lectureCountOne' : 'courses.lectureCountOther', { count: n })

  const identity = lectureIdentity(course)

  return (
    <section className="course-detail" aria-labelledby="course-detail-title">
      <div className="course-detail__hero">
        <CourseIconTile identity={courseIdentity(course)} size={56} radius={14} glyph={28} />
        <div className="course-detail__hero-text">
          <h1 id="course-detail-title">{course.name}</h1>
          <p>
            {lectureCount(owned.length)}
            {owned[0] ? (
              <>
                <span className="course-detail__dot" aria-hidden="true" />
                {formatDate(owned[0].createdAt)}
              </>
            ) : null}
          </p>
        </div>
        <CourseActionsMenu
          t={t}
          capabilities={capabilities}
          onRename={onRenameCourse}
          onDelete={onDeleteCourse}
        />
      </div>

      <div className="course-detail__tools">
        <button type="button" className="v2-btn v2-btn--record" onClick={onStartLecture}>
          {t('course.startLecture')}
        </button>
        <span className="course-detail__spacer" />
        {owned.length > 0 ? (
          <label className="courses-v2__search">
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              placeholder={t('courses.searchLectures')}
              aria-label={t('courses.searchLectures')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        ) : null}
      </div>

      {loading ? (
        <div className="course-detail__empty" role="status" aria-live="polite">
          <h2>{t('course.detailLoading')}</h2>
        </div>
      ) : error ? (
        <div className="course-detail__empty" role="alert">
          <h2>{t('course.detailLoadError')}</h2>
          <button type="button" className="v2-btn" onClick={onRetry}>
            {t('common.retry')}
          </button>
        </div>
      ) : owned.length === 0 ? (
        <div className="course-detail__empty">
          <h2>{t('course.detailEmpty')}</h2>
          <p>{t('course.detailEmptyBody')}</p>
        </div>
      ) : (
        <div className="course-detail__list">
          {visible.map((recording) => (
            <button
              key={recording.id}
              type="button"
              className="course-detail__row"
              onClick={() => onOpenLecture(recording.id)}
            >
              {/* Course colours, lecture glyph — a lecture is not its course. */}
              <CourseIconTile identity={identity} size={40} radius={10} glyph={20} />
              <span className="course-detail__row-body">
                <span className="course-detail__row-title">
                  {recording.title?.trim() || t('courses.noLectures')}
                </span>
                <span className="course-detail__row-meta">
                  <span>{formatDate(recording.createdAt)}</span>
                  <span>{formatDuration(recording.durationSec)}</span>
                  {recording.transcriptReady ? <span>{t('settings.available')}</span> : null}
                </span>
              </span>
              <span className="v2-badge" data-status={lectureStatus(recording).toLowerCase()}>
                {lectureStatus(recording)}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="course-detail__back">
        <button type="button" className="v2-quiet-link" onClick={onBack}>
          ‹ {t('course.back')}
        </button>
      </div>
    </section>
  )
}
