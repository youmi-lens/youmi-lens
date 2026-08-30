/**
 * The six course presets — the ONLY registry of course visual identity.
 *
 * Copied verbatim from the iPad app (`lib/models.ts:306-313`) and kept
 * byte-identical to the `presets` CTE in
 * `supabase-phase1b-courses-03-backfill.sql`. Those three places must never
 * drift: the same course has to look the same on iPad, on Desktop, and after a
 * server-side backfill.
 *
 * A preset is a TEMPLATE, not a reference. Creating a course copies the three
 * values onto the course row (exactly as iPad's create-course.tsx:36 does), and
 * from then on the course owns its identity. Nothing renders from `id`.
 *
 * Colour is never re-derived at runtime — not from a name hash, not from an
 * array index, not from a random source. That rule is what this module exists
 * to enforce.
 */

export type CoursePresetId = 'blue' | 'green' | 'sand' | 'slate' | 'teal' | 'rose'

/** The three values that ARE a course's visual identity. */
export type CourseIdentity = {
  icon: string
  tint: string
  accent: string
}

export type CoursePreset = CourseIdentity & {
  id: CoursePresetId
  /** Stable English label; the UI shows the swatch, not this string. */
  label: string
}

export const COURSE_PRESETS: readonly CoursePreset[] = [
  { id: 'blue', label: 'Blue', icon: 'people-outline', tint: '#E8F1FB', accent: '#3F73B0' },
  { id: 'green', label: 'Green', icon: 'create-outline', tint: '#E7F2EA', accent: '#3F8C68' },
  { id: 'sand', label: 'Sand', icon: 'trending-up-outline', tint: '#F3ECDB', accent: '#A9802F' },
  { id: 'slate', label: 'Slate', icon: 'git-network-outline', tint: '#ECECF3', accent: '#6C6E8E' },
  { id: 'teal', label: 'Teal', icon: 'flask-outline', tint: '#E3F1F0', accent: '#3C8A86' },
  { id: 'rose', label: 'Rose', icon: 'book-outline', tint: '#F4EAEA', accent: '#A8696A' },
] as const

export const DEFAULT_COURSE_PRESET = COURSE_PRESETS[0]

/** Never returns undefined; an unknown id falls back to the first preset. */
export function coursePresetById(id: string): CoursePreset {
  return COURSE_PRESETS.find((preset) => preset.id === id) ?? DEFAULT_COURSE_PRESET
}

/**
 * The preset at an ordinal position, wrapping after six.
 *
 * Used in exactly one place: assigning identity to a course reconstructed from
 * legacy data that predates the `courses` table. The ordinal must come from a
 * STABLE property of the data (see `derivedCoursesRepository`), never from
 * hydration order — that is the bug in iPad's `choosePreset(courses.size)`,
 * which makes one course teal on one device and slate on another.
 */
export function coursePresetByOrdinal(ordinal: number): CoursePreset {
  const size = COURSE_PRESETS.length
  const index = ((ordinal % size) + size) % size
  return COURSE_PRESETS[index]
}

/**
 * Identity for an item whose course is missing or not yet known.
 *
 * Values are iPad's own fallbacks (`components/LectureListItem.tsx:39-41`:
 * `colors.iceTint` / `colors.deepNavy` / `document-text-outline`), so an
 * unfiled lecture looks the same on both platforms.
 */
export const NEUTRAL_COURSE_IDENTITY: CourseIdentity = {
  icon: 'document-text-outline',
  tint: '#EDF2F7',
  accent: '#0B1F3B',
}
