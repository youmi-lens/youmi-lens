import type { CSSProperties } from 'react'
import type { CourseIdentity } from '../lib/courses/coursePresets'
import { CourseGlyph } from './CourseGlyph'

/**
 * The single tile that draws a course's visual identity.
 *
 * Colour never comes from CSS here: `tint` and `accent` are DATA carried on the
 * course row, applied inline. There is deliberately no course palette in any
 * stylesheet for a page to reach for, so two surfaces cannot disagree about
 * what a course looks like.
 *
 * Size and radius vary per surface; the three identity values never do.
 */
export function CourseIconTile({
  identity,
  size = 40,
  radius,
  glyph,
  className,
}: {
  identity: CourseIdentity
  size?: number
  radius?: number
  glyph?: number
  className?: string
}) {
  const style = {
    width: size,
    height: size,
    borderRadius: radius ?? Math.round(size * 0.28),
    background: identity.tint,
    color: identity.accent,
    '--course-tile-glyph': `${glyph ?? Math.round(size * 0.5)}px`,
  } as CSSProperties

  return (
    <span
      className={`course-tile${className ? ` ${className}` : ''}`}
      aria-hidden="true"
      data-course-icon={identity.icon}
      data-course-accent={identity.accent}
      style={style}
    >
      <CourseGlyph name={identity.icon} />
    </span>
  )
}
