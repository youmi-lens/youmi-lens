import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  COURSE_PRESETS,
  type CourseIdentity,
  type CoursePreset,
} from '../lib/courses/coursePresets'
import {
  isCourseNameValid,
  normalizeCourseName,
  type Course,
} from '../lib/courses/courseModel'
import type { DesktopI18nKey } from '../lib/desktopI18n'
import { CourseGlyph } from './CourseGlyph'
import { CourseIconTile } from './CourseIconTile'

/**
 * Create / Rename / Delete Course dialogs.
 *
 * All three are portaled to <body>. Every card and row that hosts one of these
 * clips its rounded corners with `overflow: hidden`, and an overflow clip
 * cannot be escaped with z-index — a dialog rendered inside the page tree gets
 * sliced. The portal also puts the card outside `.desktop-v2`, so
 * `course-dialog.css` carries its own palette rather than relying on tokens
 * that would not resolve there.
 */

type T = (key: DesktopI18nKey, vars?: Record<string, string | number>) => string

function Dialog({
  title,
  onClose,
  children,
  footer,
  danger = false,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  footer: React.ReactNode
  danger?: boolean
}) {
  const titleId = useId()
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // Focus the card so Escape and Tab land inside the dialog immediately.
    cardRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="course-dialog-root">
      <div className="course-dialog__backdrop" onClick={onClose} />
      <div
        ref={cardRef}
        tabIndex={-1}
        className="course-dialog__card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-danger={danger ? 'true' : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="course-dialog__title">{title}</h2>
        <div className="course-dialog__body">{children}</div>
        <div className="course-dialog__foot">{footer}</div>
      </div>
    </div>,
    document.body,
  )
}

/* ── Create ───────────────────────────────────────────────────────────────── */

export function CreateCourseDialog({
  t,
  busy,
  error,
  onCancel,
  onCreate,
  nameConflicts,
}: {
  t: T
  busy: boolean
  error: string | null
  onCancel: () => void
  onCreate: (name: string, preset: CoursePreset) => void
  nameConflicts: (name: string) => boolean
}) {
  const [name, setName] = useState('')
  const [presetIndex, setPresetIndex] = useState(0)
  const preset = COURSE_PRESETS[presetIndex]
  const taken = nameConflicts(name)
  const canCreate = isCourseNameValid(name) && !taken && !busy

  return (
    <Dialog
      title={t('course.createTitle')}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="course-dialog__btn" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="course-dialog__btn course-dialog__btn--primary"
            disabled={!canCreate}
            onClick={() => onCreate(normalizeCourseName(name), preset)}
          >
            {t('courses.newCourse')}
          </button>
        </>
      }
    >
      {/* Live preview of the identity the course will be created with. */}
      <div className="course-dialog__preview">
        <CourseIconTile identity={preset} size={42} radius={11} glyph={20} />
        <span className="course-dialog__preview-name">
          {normalizeCourseName(name) || t('course.nameLabel')}
        </span>
      </div>

      <label className="course-dialog__label" htmlFor="course-name-new">
        {t('course.nameLabel')}
      </label>
      <input
        id="course-name-new"
        className="course-dialog__input"
        value={name}
        maxLength={48}
        autoFocus
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && canCreate) onCreate(normalizeCourseName(name), preset)
        }}
      />
      {taken ? <p className="course-dialog__error">{t('course.nameTaken')}</p> : null}

      <span className="course-dialog__label">{t('course.appearance')}</span>
      <div className="course-dialog__swatches" role="radiogroup" aria-label={t('course.appearance')}>
        {COURSE_PRESETS.map((option, index) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={index === presetIndex}
            aria-label={option.label}
            className="course-dialog__swatch"
            style={{ background: option.tint, color: option.accent }}
            data-course-icon={option.icon}
            data-course-accent={option.accent}
            onClick={() => setPresetIndex(index)}
          >
            <CourseGlyph name={option.icon} />
          </button>
        ))}
      </div>
      {error ? <p className="course-dialog__error">{error}</p> : null}
    </Dialog>
  )
}

/* ── Rename ───────────────────────────────────────────────────────────────── */

export function RenameCourseDialog({
  t,
  course,
  busy,
  error,
  onCancel,
  onRename,
  nameConflicts,
}: {
  t: T
  course: Course
  busy: boolean
  error: string | null
  onCancel: () => void
  onRename: (name: string) => void
  nameConflicts: (name: string, exceptCourseId?: string) => boolean
}) {
  const [name, setName] = useState(course.name)
  const taken = nameConflicts(name, course.id)
  const canSave = isCourseNameValid(name) && !taken && !busy

  return (
    <Dialog
      title={t('course.renameTitle')}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="course-dialog__btn" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="course-dialog__btn course-dialog__btn--primary"
            disabled={!canSave}
            onClick={() => onRename(normalizeCourseName(name))}
          >
            {t('course.rename')}
          </button>
        </>
      }
    >
      {/* The identity tile is shown but never edited here: a rename must not
          change what a course looks like. */}
      <div className="course-dialog__preview">
        <CourseIconTile identity={course} size={42} radius={11} glyph={20} />
        <span className="course-dialog__preview-name">{normalizeCourseName(name) || course.name}</span>
      </div>

      <label className="course-dialog__label" htmlFor="course-name-rename">
        {t('course.nameLabel')}
      </label>
      <input
        id="course-name-rename"
        className="course-dialog__input"
        value={name}
        maxLength={48}
        autoFocus
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && canSave) onRename(normalizeCourseName(name))
        }}
      />
      {taken ? <p className="course-dialog__error">{t('course.nameTaken')}</p> : null}
      {error ? <p className="course-dialog__error">{error}</p> : null}
    </Dialog>
  )
}

/* ── Delete ───────────────────────────────────────────────────────────────── */

export function DeleteCourseDialog({
  t,
  course,
  lectureCount,
  busy,
  error,
  onCancel,
  onDelete,
}: {
  t: T
  course: Course
  lectureCount: number
  busy: boolean
  error: string | null
  onCancel: () => void
  onDelete: () => void
}) {
  const blocked = lectureCount > 0

  return (
    <Dialog
      title={t('course.deleteTitle')}
      onClose={onCancel}
      danger
      footer={
        blocked ? (
          <button
            type="button"
            className="course-dialog__btn course-dialog__btn--primary"
            onClick={onCancel}
            autoFocus
          >
            {t('common.ok')}
          </button>
        ) : (
          <>
            <button type="button" className="course-dialog__btn" onClick={onCancel} disabled={busy} autoFocus>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="course-dialog__btn course-dialog__btn--danger"
              disabled={busy}
              onClick={onDelete}
            >
              {t('course.delete')}
            </button>
          </>
        )
      }
    >
      <div className="course-dialog__preview">
        <CourseIconTile identity={course} size={42} radius={11} glyph={20} />
        <span className="course-dialog__preview-name">{course.name}</span>
      </div>
      {/* A non-empty course is refused with an explanation, never with a
          disabled button and no reason. */}
      <p className="course-dialog__body-text">
        {blocked ? t('course.deleteBlocked') : t('course.deleteBody')}
      </p>
      {error ? <p className="course-dialog__error">{error}</p> : null}
    </Dialog>
  )
}

/* ── Lecture actions ──────────────────────────────────────────────────────────
   Rename, Move and Delete are three separate dialogs on purpose.

   They previously all opened one combined "edit title and course together"
   modal behind three different labels, which meant picking Rename could silently
   rewrite the lecture's course and picking Move could rewrite its title. Each
   dialog below touches exactly the one field its label promises; the underlying
   production mutations are unchanged. */

export function RenameLectureDialog({
  t,
  currentTitle,
  identity,
  busy,
  error,
  onCancel,
  onRename,
}: {
  t: T
  currentTitle: string
  identity: CourseIdentity
  busy: boolean
  error: string | null
  onCancel: () => void
  onRename: (title: string) => void
}) {
  const [title, setTitle] = useState(currentTitle)
  const next = title.trim()
  const canSave = next.length > 0 && next !== currentTitle.trim() && !busy

  return (
    <Dialog
      title={t('lecture.renameTitle')}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="course-dialog__btn" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="course-dialog__btn course-dialog__btn--primary"
            disabled={!canSave}
            onClick={() => onRename(next)}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      {/* The course is shown but never editable here — that is Move's job. */}
      <div className="course-dialog__preview">
        <CourseIconTile identity={identity} size={42} radius={11} glyph={20} />
        <span className="course-dialog__preview-name">{next || currentTitle}</span>
      </div>

      <label className="course-dialog__label" htmlFor="lecture-title-rename">
        {t('lecture.titleLabel')}
      </label>
      <input
        id="lecture-title-rename"
        className="course-dialog__input"
        value={title}
        maxLength={120}
        autoFocus
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && canSave) onRename(next)
        }}
      />
      {error ? <p className="course-dialog__error">{error}</p> : null}
    </Dialog>
  )
}

export function MoveLectureDialog({
  t,
  lectureTitle,
  courses,
  currentCourseId,
  busy,
  error,
  onCancel,
  onMove,
}: {
  t: T
  lectureTitle: string
  /** Active courses only. */
  courses: readonly Course[]
  currentCourseId: string | null
  busy: boolean
  error: string | null
  onCancel: () => void
  onMove: (courseId: string | null) => void
}) {
  const [target, setTarget] = useState<string | null>(currentCourseId)
  // Unfiled counts as a destination, so a filed lecture always has somewhere to
  // go; only a lecture that is Unfiled with no courses at all has nowhere.
  const destinations = courses.length + (currentCourseId === null ? 0 : 1)
  const nothingToDo = destinations <= 1
  const canMove = !busy && !nothingToDo && target !== currentCourseId

  return (
    <Dialog
      title={t('lecture.moveTitle')}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="course-dialog__btn" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="course-dialog__btn course-dialog__btn--primary"
            disabled={!canMove}
            onClick={() => onMove(target)}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <p className="course-dialog__body-text" style={{ marginTop: 0 }}>
        {nothingToDo ? t('lecture.moveNowhere') : t('lecture.moveBody')}
      </p>

      {/* The title is displayed, never edited — that is Rename's job. */}
      <div className="course-dialog__preview">
        <span className="course-dialog__preview-name">{lectureTitle}</span>
      </div>

      <div className="course-dialog__choices" role="radiogroup" aria-label={t('lecture.moveTitle')}>
        {courses.map((course) => (
          <button
            key={course.id}
            type="button"
            role="radio"
            aria-checked={target === course.id}
            className="course-dialog__choice"
            disabled={busy}
            onClick={() => setTarget(course.id)}
          >
            <CourseIconTile identity={course} size={28} radius={8} glyph={15} />
            <span>{course.name}</span>
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={target === null}
          className="course-dialog__choice"
          disabled={busy}
          onClick={() => setTarget(null)}
        >
          <span>{t('deleted.unfiled')}</span>
        </button>
      </div>
      {error ? <p className="course-dialog__error">{error}</p> : null}
    </Dialog>
  )
}

export function DeleteLectureDialog({
  t,
  lectureTitle,
  identity,
  busy,
  error,
  onCancel,
  onDelete,
}: {
  t: T
  lectureTitle: string
  identity: CourseIdentity
  busy: boolean
  error: string | null
  onCancel: () => void
  onDelete: () => void
}) {
  return (
    <Dialog
      title={t('lecture.deleteTitle')}
      onClose={onCancel}
      danger
      footer={
        <>
          <button type="button" className="course-dialog__btn" onClick={onCancel} disabled={busy} autoFocus>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="course-dialog__btn course-dialog__btn--danger"
            disabled={busy}
            onClick={onDelete}
          >
            {t('lecture.delete')}
          </button>
        </>
      }
    >
      <div className="course-dialog__preview">
        <CourseIconTile identity={identity} size={42} radius={11} glyph={20} />
        <span className="course-dialog__preview-name">{lectureTitle}</span>
      </div>
      <p className="course-dialog__body-text">{t('lecture.deleteBody')}</p>
      {/* The device-local truth travels with every lecture delete. */}
      <p className="course-dialog__scope-note">{t('deleted.lectureScopeNotice')}</p>
      {error ? <p className="course-dialog__error">{error}</p> : null}
    </Dialog>
  )
}

/* ── Permanent delete, from Recently Deleted ──────────────────────────────────
   Purging is the one action in this phase with no undo, so it is never a bare
   button: it always goes through this confirmation, and Cancel — not the
   destructive control — takes focus. */

export function ConfirmPurgeDialog({
  t,
  title,
  body,
  itemName,
  identity,
  confirmLabel,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  t: T
  title: string
  body: string
  itemName: string
  identity: CourseIdentity
  /** Names the actual consequence. Defaults to permanent deletion. */
  confirmLabel?: string
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      danger
      footer={
        <>
          <button type="button" className="course-dialog__btn" onClick={onCancel} disabled={busy} autoFocus>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="course-dialog__btn course-dialog__btn--danger"
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel ?? t('deleted.purge')}
          </button>
        </>
      }
    >
      <div className="course-dialog__preview">
        <CourseIconTile identity={identity} size={42} radius={11} glyph={20} />
        <span className="course-dialog__preview-name">{itemName}</span>
      </div>
      <p className="course-dialog__body-text">{body}</p>
      {error ? <p className="course-dialog__error">{error}</p> : null}
    </Dialog>
  )
}
