import type { SVGProps } from 'react'

/**
 * The glyphs a course identity can use.
 *
 * The iPad app draws these with `@expo/vector-icons` (Ionicons outline). The
 * desktop app has no Ionicons font and Phase 1B is not the place to add a
 * dependency, so these are hand-drawn outline equivalents at the same 24-unit
 * box and a comparable stroke weight. This is a KNOWN difference: the geometry
 * is equivalent, not byte-identical. Every colour value IS byte-identical.
 *
 * The names are exactly the six in the preset registry plus the lecture glyph,
 * so `coursePresets.ts` and this file cannot drift apart without a type error.
 */

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

export function CourseGlyph({ name, ...rest }: { name: string } & SVGProps<SVGSVGElement>) {
  const common = { viewBox: '0 0 24 24', 'aria-hidden': true, ...rest }
  switch (name) {
    case 'people-outline':
      return (
        <svg {...common} {...STROKE}>
          <circle cx="9" cy="8.2" r="3.1" />
          <path d="M3.4 19.2a5.9 5.9 0 0 1 11.2 0" />
          <path d="M16.1 6.4a2.9 2.9 0 0 1 0 5.5M17.4 14.2a5 5 0 0 1 3.3 4.4" />
        </svg>
      )
    case 'create-outline':
      return (
        <svg {...common} {...STROKE}>
          <path d="M12.6 5.3H6.2A2.2 2.2 0 0 0 4 7.5v10.3a2.2 2.2 0 0 0 2.2 2.2h10.3a2.2 2.2 0 0 0 2.2-2.2v-6.4" />
          <path d="M16.4 4.1a1.9 1.9 0 0 1 2.7 2.7l-7.4 7.4-3.4.7.7-3.4z" />
        </svg>
      )
    case 'trending-up-outline':
      return (
        <svg {...common} {...STROKE}>
          <path d="M3.4 16.6 9 11l3.6 3.6L20.6 6.6" />
          <path d="M15.6 6.6h5v5" />
        </svg>
      )
    case 'git-network-outline':
      return (
        <svg {...common} {...STROKE}>
          <circle cx="12" cy="4.9" r="2.4" />
          <circle cx="5.6" cy="19.1" r="2.4" />
          <circle cx="18.4" cy="19.1" r="2.4" />
          <path d="M12 7.3v4.4M5.6 16.7v-2.2h12.8v2.2" />
        </svg>
      )
    case 'flask-outline':
      return (
        <svg {...common} {...STROKE}>
          <path d="M9.4 3.6h5.2M10.6 3.6v5.5L5.4 17.4a2 2 0 0 0 1.7 3h9.8a2 2 0 0 0 1.7-3l-5.2-8.3V3.6" />
          <path d="M7.6 14.4h8.8" />
        </svg>
      )
    case 'book-outline':
      return (
        <svg {...common} {...STROKE}>
          <path d="M3.6 5.1a13.7 13.7 0 0 1 8.4 1.9v12.4a13.7 13.7 0 0 0-8.4-1.9z" />
          <path d="M20.4 5.1a13.7 13.7 0 0 0-8.4 1.9v12.4a13.7 13.7 0 0 1 8.4-1.9z" />
        </svg>
      )
    case 'document-text-outline':
    default:
      return (
        <svg {...common} {...STROKE}>
          <path d="M13.4 3.6H7.2a2 2 0 0 0-2 2v12.8a2 2 0 0 0 2 2h9.6a2 2 0 0 0 2-2V9z" />
          <path d="M13.4 3.6V9h5.4" />
          <path d="M8.6 13.2h6.8M8.6 16.6h4.8" />
        </svg>
      )
  }
}
