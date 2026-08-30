import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CoursesCapabilities } from '../lib/courses/coursesRepository'
import type { DesktopI18nKey } from '../lib/desktopI18n'

/**
 * The ••• menu on a course card and on the Course Detail header.
 *
 * The popover is portaled to <body> and positioned `fixed` against the
 * trigger's viewport rect. Both hosts clip their rounded corners with
 * `overflow: hidden`, and an overflow clip cannot be escaped with z-index — an
 * absolutely-positioned popover gets sliced at the card edge. Being on <body>
 * also puts it outside `.desktop-v2`, so `course-menu.css` carries its own
 * palette and font.
 *
 * When the repository cannot write (the derived read-only fallback), the items
 * are rendered disabled with a reason rather than silently doing nothing.
 */

const GAP = 6
const EDGE = 8

type T = (key: DesktopI18nKey, vars?: Record<string, string | number>) => string

export function CourseActionsMenu({
  t,
  capabilities,
  onRename,
  onDelete,
  className,
}: {
  t: T
  capabilities: CoursesCapabilities
  onRename: () => void
  onDelete: () => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const place = useCallback(() => {
    const trigger = triggerRef.current
    const pop = popRef.current
    if (!trigger || !pop) return
    const anchor = trigger.getBoundingClientRect()
    const { width, height } = pop.getBoundingClientRect()
    let top = anchor.bottom + GAP
    if (top + height > window.innerHeight - EDGE) {
      const above = anchor.top - GAP - height
      top = above >= EDGE ? above : Math.max(EDGE, window.innerHeight - EDGE - height)
    }
    const left = Math.min(
      Math.max(anchor.right - width, EDGE),
      Math.max(EDGE, window.innerWidth - EDGE - width),
    )
    setPos({ top, left })
  }, [])

  useLayoutEffect(() => {
    if (open) place()
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target)) return
      if (popRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    const onMove = () => place()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [open, place])

  const notConnected = t('settings.notEnabled')

  return (
    <div
      className={`course-menu${className ? ` ${className}` : ''}`}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        ref={triggerRef}
        type="button"
        className="course-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('course.actions')}
        title={t('course.actions')}
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
          <circle cx="5.5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="18.5" cy="12" r="1.7" />
        </svg>
      </button>

      {open
        ? createPortal(
            <div
              ref={popRef}
              className="course-menu__pop"
              role="menu"
              aria-label={t('course.actions')}
              style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
            >
              <button
                type="button"
                role="menuitem"
                disabled={!capabilities.canRename}
                title={capabilities.canRename ? undefined : notConnected}
                onClick={() => {
                  setOpen(false)
                  onRename()
                }}
              >
                {t('course.rename')}
              </button>
              <div className="course-menu__rule" role="separator" />
              <button
                type="button"
                role="menuitem"
                data-danger="true"
                disabled={!capabilities.canDelete}
                title={capabilities.canDelete ? undefined : notConnected}
                onClick={() => {
                  setOpen(false)
                  onDelete()
                }}
              >
                {t('course.delete')}
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
