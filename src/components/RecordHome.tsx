import { contentLanguageLabel } from '../lib/contentLanguages'
import { NEUTRAL_COURSE_IDENTITY, type CourseIdentity } from '../lib/courses/coursePresets'
import type { LanguagePreferences } from '../lib/languagePreferences'
import { openRecordLanguageSettings, runRecordHomeStart } from '../lib/recordHomeActions'
import { useLanguagePreferences } from '../languagePreferencesContext'
import { CourseIconTile } from './CourseIconTile'

export type RecentLectureItem = {
  id: string
  title: string
  course: string
  duration: string
  status: 'Ready' | 'Processing' | 'Failed'
}


/**
 * Record Home — a direct port of the approved mockup
 * (youmi-lens-desktop-v2-mockup/index.html).
 *
 * Page contents, in the mockup's order and nothing else: heading, one line of
 * intro, the setup card (course identity row + optional lecture title), the
 * primary action, the read-only language summary, and at most three recent
 * lectures.
 *
 * Corrections against the previous implementation:
 *   · Course is an IDENTITY ROW (colour chip, label, value, Change, New Course),
 *     not a free-text input.
 *   · Course and Lecture title stack; they were a two-column grid.
 *   · The start button carries no hollow circle — the mockup has none.
 *   · No hero, status, usage, summary or current-session blocks.
 *
 * All business state stays in App.tsx; this component only presents it.
 */
export function RecordHome({
  course,
  courseIdentity = NEUTRAL_COURSE_IDENTITY,
  audioSourceLabel,
  title,
  preferences,
  recentLectures,
  disabled = false,
  onTitleChange,
  onStartRecording,
  onOpenSettings,
  onChangeCourse,
  onNewCourse,
  onViewAll,
  onOpenLecture,
}: {
  course: string
  /**
   * The selected course's REAL identity. Defaults to the neutral tile, which is
   * the honest answer for Unfiled or for a name with no course row behind it —
   * it is never a second palette. The previous chip painted every course the
   * same hardcoded green, which is exactly the drift this phase removes.
   */
  courseIdentity?: CourseIdentity
  /** Read-only source summary, e.g. "System Audio". Omitted when unset. */
  audioSourceLabel?: string
  title: string
  preferences: LanguagePreferences
  recentLectures: RecentLectureItem[]
  disabled?: boolean
  onTitleChange: (value: string) => void
  onStartRecording: () => void
  onOpenSettings: () => void
  onChangeCourse: () => void
  onNewCourse: () => void
  onViewAll: () => void
  onOpenLecture: (id: string) => void
}) {
  const { t } = useLanguagePreferences()
  const modeLabel =
    preferences.languageMode === 'bilingual' ? t('record.bilingual') : t('record.captionsOnly')
  const visibleRecent = recentLectures.slice(0, 3)
  const courseName = course.trim() || t('record.unfiled')

  return (
    <>
      <section className="record-home-v2" aria-labelledby="record-home-title">
        <h1 className="record-home-v2__heading" id="record-home-title">
          {t('record.title')}
        </h1>
        <p className="record-home-v2__intro">{t('record.intro')}</p>

        <div className="record-home-v2__setup">
          <div className="record-home-v2__course">
            <CourseIconTile
              identity={courseIdentity}
              size={42}
              radius={11}
              glyph={20}
              className="record-home-v2__course-icon"
            />
            <span className="record-home-v2__course-copy">
              <span className="record-home-v2__course-label">{t('record.course')}</span>
              <span className="record-home-v2__course-value">{courseName}</span>
            </span>
            <button type="button" className="v2-quiet-link" onClick={onChangeCourse} disabled={disabled}>
              {t('record.changeCourse')}
            </button>
            <button
              type="button"
              className="record-home-v2__course-add"
              onClick={onNewCourse}
              disabled={disabled}
              aria-label={t('record.newCourse')}
              title={t('record.newCourse')}
            >
              ＋
            </button>
          </div>

          <div className="record-home-v2__title-field">
            <label htmlFor="record-home-lecture-title">
              {t('record.lectureTitle')} <span>({t('record.optional')})</span>
            </label>
            <input
              id="record-home-lecture-title"
              value={title}
              onChange={(event) => onTitleChange(event.target.value)}
              disabled={disabled}
              placeholder="Lecture 13"
            />
          </div>
        </div>

        <div className="record-home-v2__action">
          <button
            type="button"
            className="v2-btn v2-btn--record"
            onClick={() => runRecordHomeStart(onStartRecording)}
            disabled={disabled}
          >
            {t('record.start')}
          </button>
        </div>

        <div className="record-home-v2__summary" aria-label="Current language preferences">
          {/* Read-only. Changing the source is Settings' job — no configuration
              wall returns to Record Home. */}
          {audioSourceLabel ? <strong>{audioSourceLabel}</strong> : null}
          <span>
            {audioSourceLabel ? '· ' : ''}
            {contentLanguageLabel(preferences.captionLanguage)} →{' '}
            {contentLanguageLabel(preferences.translationLanguage)}
          </span>
          <span>· {modeLabel}</span>
          <button type="button" onClick={() => openRecordLanguageSettings(onOpenSettings)}>
            {t('record.changeSettings')}
          </button>
        </div>
      </section>

      {visibleRecent.length > 0 ? (
        <section className="record-home-v2__recent" aria-labelledby="record-home-recent-title">
          <div className="record-home-v2__recent-head">
            <h2 id="record-home-recent-title">{t('record.recent')}</h2>
            <button type="button" className="v2-quiet-link" onClick={onViewAll}>
              {t('record.viewAll')}
            </button>
          </div>
          {visibleRecent.map((lecture) => (
            <button
              key={lecture.id}
              type="button"
              className="record-home-v2__recent-row"
              onClick={() => onOpenLecture(lecture.id)}
            >
              <span>
                <span className="record-home-v2__recent-title">{lecture.title}</span>
                <span className="record-home-v2__recent-meta">
                  {lecture.course} · {lecture.duration}
                </span>
              </span>
              <span className="v2-badge" data-status={lecture.status.toLowerCase()}>
                {lecture.status}
              </span>
            </button>
          ))}
        </section>
      ) : null}
    </>
  )
}
