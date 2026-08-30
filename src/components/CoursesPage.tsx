import { useMemo, useState } from 'react'
import type { Recording } from '../types'
import {
  courseIdentity,
  findCourseForRecording,
  lectureIdentity,
  lecturesInCourse,
  pluralForm,
  type Course,
} from '../lib/courses/courseModel'
import type { CoursesCapabilities } from '../lib/courses/coursesRepository'
import type { DesktopI18nKey } from '../lib/desktopI18n'
import { CourseIconTile } from './CourseIconTile'
import { CourseActionsMenu } from './CourseActionsMenu'

/**
 * Courses V2, wired to real data.
 *
 * The layout is the approved Preview design, unchanged: no spacing, typography,
 * colour, card or navigation change. Only the data source is different — every
 * course, count and lecture here comes from the repository and from real
 * recordings.
 *
 * With no courses the page collapses to a title and one clean card: no search,
 * no filters, no zero statistics, no recent list.
 */

type T = (key: DesktopI18nKey, vars?: Record<string, string | number>) => string

export type LectureStatus = 'Ready' | 'Processing' | 'Failed'

export function CoursesPage({
  t,
  courses,
  recordings,
  capabilities,
  loading = false,
  error = null,
  onRetry = () => undefined,
  lectureStatus,
  formatDuration,
  onOpenCourse,
  onOpenLecture,
  onNewCourse,
  onRenameCourse,
  onDeleteCourse,
  recentlyDeletedCount,
  onOpenRecentlyDeleted,
}: {
  t: T
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
  onOpenCourse: (courseId: string) => void
  onOpenLecture: (recordingId: string) => void
  onNewCourse: () => void
  onRenameCourse: (courseId: string) => void
  onDeleteCourse: (courseId: string) => void
  /** Deleted courses + deleted lectures. Zero hides the entry entirely. */
  recentlyDeletedCount: number
  onOpenRecentlyDeleted: () => void
}) {
  const [query, setQuery] = useState('')

  const recent = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return recordings
      .filter((recording) =>
        needle
          ? (recording.title ?? '').toLowerCase().includes(needle) ||
            (recording.course ?? '').toLowerCase().includes(needle)
          : true,
      )
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 8)
  }, [recordings, query])

  const courseCount = (n: number) =>
    t(pluralForm(n) === 'one' ? 'courses.countOne' : 'courses.countOther', { count: n })
  const lectureCount = (n: number) =>
    t(pluralForm(n) === 'one' ? 'courses.lectureCountOne' : 'courses.lectureCountOther', { count: n })
  const deletedCount = (n: number) =>
    t(pluralForm(n) === 'one' ? 'courses.deletedCountOne' : 'courses.deletedCountOther', { count: n })

  /* The lowest-weight destination on the page: a quiet link under everything
     else, shown only when there is something in the bin. */
  const recentlyDeletedEntry =
    recentlyDeletedCount > 0 ? (
      <div className="courses-v2__deleted-entry">
        <button type="button" className="v2-quiet-link" onClick={onOpenRecentlyDeleted}>
          {t('courses.recentlyDeleted')}
        </button>
        <span className="courses-v2__deleted-count">{deletedCount(recentlyDeletedCount)}</span>
      </div>
    ) : null

  /* ── Loading / fetch error ──────────────────────────────────────────────
     Checked before the empty state: an initial fetch still in flight, or one
     that failed outright, must never render as "you have no courses". */

  if (loading) {
    return (
      <section className="courses-v2" aria-labelledby="courses-v2-title">
        <div className="courses-v2__head">
          <div>
            <h1 id="courses-v2-title">{t('courses.title')}</h1>
          </div>
        </div>
        <div className="courses-v2__blank" role="status" aria-live="polite">
          <h2>{t('courses.loading')}</h2>
        </div>
      </section>
    )
  }

  if (error) {
    return (
      <section className="courses-v2" aria-labelledby="courses-v2-title">
        <div className="courses-v2__head">
          <div>
            <h1 id="courses-v2-title">{t('courses.title')}</h1>
          </div>
        </div>
        <div className="courses-v2__blank" role="alert">
          <h2>{t('courses.loadError')}</h2>
          <button type="button" className="v2-btn" onClick={onRetry}>
            {t('common.retry')}
          </button>
        </div>
      </section>
    )
  }

  /* ── No courses ─────────────────────────────────────────────────────────── */

  if (courses.length === 0) {
    return (
      <section className="courses-v2" aria-labelledby="courses-v2-title">
        <div className="courses-v2__head">
          <div>
            <h1 id="courses-v2-title">{t('courses.title')}</h1>
          </div>
        </div>
        <div className="courses-v2__blank">
          <h2>{t('courses.empty')}</h2>
          <p>{t('courses.emptyBody')}</p>
          <button
            type="button"
            className="v2-btn v2-btn--primary"
            onClick={onNewCourse}
            disabled={!capabilities.canCreate}
            title={capabilities.canCreate ? undefined : t('settings.notEnabled')}
          >
            {t('courses.newCourse')}
          </button>
        </div>
        {recentlyDeletedEntry}
      </section>
    )
  }

  /* ── At least one course ────────────────────────────────────────────────── */

  return (
    <section className="courses-v2" aria-labelledby="courses-v2-title">
      <div className="courses-v2__head">
        <div>
          <h1 id="courses-v2-title">{t('courses.title')}</h1>
          <p>
            {courseCount(courses.length)} · {lectureCount(recordings.length)}
          </p>
        </div>
        <span className="courses-v2__head-spacer" />
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
      </div>

      <div className="courses-v2__grid">
        {courses.map((course) => {
          const owned = lecturesInCourse(course.id, recordings, courses)
          const latest = owned[0]
          return (
            <div
              key={course.id}
              className="courses-v2__card"
              style={{ ['--course-accent' as string]: course.accent }}
            >
              <CourseIconTile identity={courseIdentity(course)} size={40} radius={8} glyph={20} />
              <h2>{course.name}</h2>
              {owned.length > 0 ? (
                <>
                  <p>{lectureCount(owned.length)}</p>
                  <span className="courses-v2__foot">
                    <span className="courses-v2__foot-label">{t('courses.lastLecture')}</span>
                    <span className="courses-v2__foot-value">
                      {latest.title?.trim() || t('courses.noLectures')}
                    </span>
                  </span>
                </>
              ) : (
                <p>{t('courses.noLectures')}</p>
              )}
              {/* Full-card hit area, under the ••• so the menu keeps its own
                  clicks. A nested <button> would be invalid HTML. */}
              <button
                type="button"
                className="courses-v2__card-open"
                aria-label={course.name}
                onClick={() => onOpenCourse(course.id)}
              />
              <CourseActionsMenu
                t={t}
                capabilities={capabilities}
                onRename={() => onRenameCourse(course.id)}
                onDelete={() => onDeleteCourse(course.id)}
                className="courses-v2__card-menu"
              />
            </div>
          )
        })}
        <button
          type="button"
          className="courses-v2__card courses-v2__card--ghost"
          onClick={onNewCourse}
          disabled={!capabilities.canCreate}
          title={capabilities.canCreate ? undefined : t('settings.notEnabled')}
        >
          <span className="courses-v2__symbol" aria-hidden="true">＋</span>
          <strong>{t('courses.newCourse')}</strong>
        </button>
      </div>

      <section className="courses-v2__recent" aria-labelledby="courses-v2-recent">
        <div className="courses-v2__section-line">
          <h2 id="courses-v2-recent">{t('courses.recent')}</h2>
        </div>
        <div className="courses-v2__list">
          {recent.map((recording) => {
            const owner = findCourseForRecording(recording, courses)
            const identity = lectureIdentity(owner)
            return (
              <button
                key={recording.id}
                type="button"
                className="courses-v2__row"
                onClick={() => onOpenLecture(recording.id)}
              >
                <span>
                  <strong>{recording.title?.trim() || t('courses.noLectures')}</strong>
                  <small>
                    <span
                      className="courses-v2__dot"
                      style={{ background: identity.accent }}
                      data-course-accent={identity.accent}
                      aria-hidden="true"
                    />
                    {owner?.name ?? recording.course}
                  </small>
                </span>
                <span>{formatDuration(recording.durationSec)}</span>
                <span className="v2-badge" data-status={lectureStatus(recording).toLowerCase()}>
                  {lectureStatus(recording)}
                </span>
              </button>
            )
          })}
        </div>
      </section>

      {recentlyDeletedEntry}
    </section>
  )
}
