import { courseIdentity, lectureIdentity, type Course } from '../lib/courses/courseModel'
import {
  courseToRestoreWithLecture,
  type DeletedLecture,
} from '../lib/courses/deletedItems'
import { NEUTRAL_COURSE_IDENTITY } from '../lib/courses/coursePresets'
import type { CoursesCapabilities } from '../lib/courses/coursesRepository'
import type { DesktopI18nKey } from '../lib/desktopI18n'
import { CourseIconTile } from './CourseIconTile'

/**
 * Recently Deleted.
 *
 * Required now because soft delete is already live in production: a course the
 * user deletes leaves the grid, and without this screen there is nowhere to get
 * it back from.
 *
 * The approved rules, and what each one rules OUT:
 *   · No automatic expiration, no countdown, no cleanup job. Nothing here
 *     disappears on its own, so the page shows no "N days left" anywhere.
 *   · No "Empty Recently Deleted" bulk action. Permanent deletion is one item
 *     at a time, through a confirmation.
 *   · Restoring a lecture also restores its course when that course is itself
 *     deleted — otherwise the lecture would come back into a course the user
 *     cannot see. That decision is made in `deletedItems.ts`; this component
 *     only reports it.
 *
 * This component performs no I/O. Every action is a callback wired to a
 * repository or service function in App.tsx.
 */

type T = (key: DesktopI18nKey, vars?: Record<string, string | number>) => string

export function RecentlyDeletedPage({
  t,
  deletedCourses,
  deletedLectures,
  activeCourses,
  capabilities,
  busy,
  loading = false,
  error = null,
  onRetry = () => undefined,
  restoreError = null,
  formatDate,
  onBack,
  onRestoreCourse,
  onPurgeCourse,
  onRestoreLecture,
  onPurgeLecture,
}: {
  t: T
  deletedCourses: readonly Course[]
  deletedLectures: readonly DeletedLecture[]
  /** Used to colour a deleted lecture whose course is still active. */
  activeCourses: readonly Course[]
  capabilities: CoursesCapabilities
  busy: boolean
  /** True only while the initial (or an identity-change) fetch is in flight. */
  loading?: boolean
  /** Set when the repository itself failed to answer — not a mutation refusal. */
  error?: string | null
  onRetry?: () => void
  /** Last restore failure, user-safe copy only. Cleared on the next attempt. */
  restoreError?: string | null
  formatDate: (epochMs: number) => string
  onBack: () => void
  onRestoreCourse: (courseId: string) => void
  onPurgeCourse: (courseId: string) => void
  onRestoreLecture: (lectureId: string) => void
  onPurgeLecture: (lectureId: string) => void
}) {
  const empty = deletedCourses.length === 0 && deletedLectures.length === 0
  const notConnected = t('settings.notEnabled')

  /* A deleted lecture borrows the colours of its course wherever that course
     can still be found — active first, then the deleted list, then neutral.
     The lecture itself never stores a colour. */
  const identityForLecture = (lecture: DeletedLecture) => {
    const owner =
      courseToRestoreWithLecture(lecture, activeCourses) ??
      courseToRestoreWithLecture(lecture, deletedCourses)
    return owner ? lectureIdentity(owner) : NEUTRAL_COURSE_IDENTITY
  }

  return (
    <section className="deleted-v2" aria-labelledby="deleted-v2-title">
      <div className="deleted-v2__head">
        <h1 id="deleted-v2-title">{t('courses.recentlyDeleted')}</h1>
        <p>{t('deleted.noExpiry')}</p>
      </div>

      {loading ? (
        <div className="course-detail__empty" role="status" aria-live="polite">
          <h2>{t('deleted.loading')}</h2>
        </div>
      ) : error ? (
        <div className="course-detail__empty" role="alert">
          <h2>{t('deleted.loadError')}</h2>
          <button type="button" className="v2-btn" onClick={onRetry}>
            {t('common.retry')}
          </button>
        </div>
      ) : empty ? (
        <div className="course-detail__empty">
          <h2>{t('deleted.empty')}</h2>
          <p>{t('deleted.emptyBody')}</p>
        </div>
      ) : (
        <>
          {restoreError ? (
            <p className="course-dialog__error" role="alert">
              {restoreError}
            </p>
          ) : null}
          {deletedCourses.length > 0 ? (
            <section className="deleted-v2__group" aria-labelledby="deleted-v2-courses">
              <h2 id="deleted-v2-courses">{t('deleted.coursesHeading')}</h2>
              <div className="course-detail__list">
                {deletedCourses.map((course) => (
                  <div key={course.id} className="deleted-v2__row">
                    <CourseIconTile identity={courseIdentity(course)} size={40} radius={10} glyph={20} />
                    <span className="deleted-v2__row-body">
                      <span className="course-detail__row-title">{course.name}</span>
                      <span className="course-detail__row-meta">
                        <span>
                          {course.deletedAt
                            ? t('deleted.deletedOn', { date: formatDate(course.deletedAt) })
                            : '—'}
                        </span>
                      </span>
                    </span>
                    <span className="deleted-v2__row-actions">
                      <button
                        type="button"
                        className="v2-btn"
                        disabled={busy || !capabilities.canRestore}
                        title={capabilities.canRestore ? undefined : notConnected}
                        onClick={() => onRestoreCourse(course.id)}
                      >
                        {t('deleted.restore')}
                      </button>
                      <button
                        type="button"
                        className="v2-quiet-link deleted-v2__danger"
                        disabled={busy || !capabilities.canPurge}
                        title={capabilities.canPurge ? undefined : notConnected}
                        onClick={() => onPurgeCourse(course.id)}
                      >
                        {t('deleted.purge')}
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {deletedLectures.length > 0 ? (
            <section className="deleted-v2__group" aria-labelledby="deleted-v2-lectures">
              <h2 id="deleted-v2-lectures">{t('deleted.lecturesHeading')}</h2>
              {/* Truthful scope. Course deletion is cloud-backed and syncs;
                  lecture deletion is a per-device registry today, so this says
                  so rather than implying a cross-device delete. */}
              <p className="deleted-v2__scope-note">{t('deleted.lectureScopeNotice')}</p>
              <div className="course-detail__list">
                {deletedLectures.map((lecture) => (
                  <div key={lecture.id} className="deleted-v2__row">
                    <CourseIconTile identity={identityForLecture(lecture)} size={40} radius={10} glyph={20} />
                    <span className="deleted-v2__row-body">
                      <span className="course-detail__row-title">{lecture.title}</span>
                      <span className="course-detail__row-meta">
                        <span>{lecture.courseName || t('deleted.unfiled')}</span>
                        {/* Local-only trash never stamps a deletion time; an em
                            dash is honest where inventing createdAt would not be. */}
                        <span>
                          {lecture.deletedAt
                            ? t('deleted.deletedOn', { date: formatDate(lecture.deletedAt) })
                            : '—'}
                        </span>
                      </span>
                    </span>
                    <span className="deleted-v2__row-actions">
                      <button
                        type="button"
                        className="v2-btn"
                        disabled={busy}
                        onClick={() => onRestoreLecture(lecture.id)}
                      >
                        {t('deleted.restore')}
                      </button>
                      <button
                        type="button"
                        className="v2-quiet-link deleted-v2__danger"
                        disabled={busy}
                        onClick={() => onPurgeLecture(lecture.id)}
                      >
                        {t('deleted.purge')}
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}

      <div className="course-detail__back">
        <button type="button" className="v2-quiet-link" onClick={onBack}>
          ‹ {t('deleted.back')}
        </button>
      </div>
    </section>
  )
}
