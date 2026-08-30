/**
 * Phase 1B fix gate — regression guards for the four failures found in
 * real-account QA of `Youmi Lens Courses V2 QA.app`.
 *
 *   A · Courses rendered the literal template `{count} courses`.
 *   B · Recently Deleted did not exist, while soft delete was already live.
 *   C · Start Recording dropped the user back into the legacy `.yl-*` shell.
 *   D · A Course Detail lecture row opened nothing.
 *
 * Every assertion here is written against the thing that actually broke, so a
 * future refactor that reintroduces one of them fails loudly.
 */
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CoursesPage } from './CoursesPage'
import { CourseDetailPage } from './CourseDetailPage'
import {
  DeleteLectureDialog,
  MoveLectureDialog,
  RenameLectureDialog,
} from './CourseDialogs'
import { LectureDetailPage } from './LectureDetailPage'
import { RecentlyDeletedPage } from './RecentlyDeletedPage'
import { RecordingV2 } from './RecordingV2'
import {
  DESKTOP_I18N_KEYS,
  DESKTOP_I18N_LOCALES,
  interpolate,
  translateDesktop,
  unresolvedPlaceholders,
} from '../lib/desktopI18n'
import { buildCaptionStack, splitCaptionSentences } from '../lib/recordingV2Captions'
import {
  courseToRestoreWithLecture,
  deletedLecturesFromLocalRows,
  deletedLecturesFromRegistry,
  recentlyDeletedCount,
} from '../lib/courses/deletedItems'
import { COURSE_PRESETS } from '../lib/courses/coursePresets'
import type { Course } from '../lib/courses/courseModel'
import type { CoursesCapabilities } from '../lib/courses/coursesRepository'
import type { Recording } from '../types'

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

/**
 * Source with comments stripped.
 *
 * The "must not contain" scans below are about CODE. Several of these files
 * name the forbidden thing in a doc comment precisely to explain why it is
 * absent ("It owns no MediaRecorder…"), and a naive substring scan would read
 * that explanation as the violation.
 */
/** CSS with `/* … *\/` comments removed, for the same reason as `codeOnly`. */
function cssCode(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function codeOnly(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

const t = (key: Parameters<typeof translateDesktop>[1], vars?: Record<string, string | number>) =>
  translateDesktop('en', key, vars)

const WRITABLE: CoursesCapabilities = {
  canCreate: true,
  canRename: true,
  canDelete: true,
  canRestore: true,
  canPurge: true,
  persistsIdentity: true,
}

function course(id: string, name: string, presetIndex: number, deletedAt: number | null = null): Course {
  const preset = COURSE_PRESETS[presetIndex]
  return {
    id,
    userId: 'u1',
    name,
    icon: preset.icon,
    tint: preset.tint,
    accent: preset.accent,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    deletedAt,
  }
}

function recording(id: string, title: string, courseName: string, createdAt: number): Recording {
  return {
    id,
    title,
    course: courseName,
    createdAt,
    durationSec: 1800,
    mime: 'audio/webm',
    storagePath: `u1/${id}.webm`,
    aiStatus: 'done',
  } as unknown as Recording
}

const cs101 = course('c1', 'CS 101', 0)
const math = course('c2', 'Math 210', 2)
const lectureA = recording('r1', 'Lecture A — sorting', 'CS 101', 3_000)
const lectureB = recording('r2', 'Lecture B — graphs', 'CS 101', 2_000)
const lectureC = recording('r3', 'Lecture C — limits', 'Math 210', 1_000)

function renderCourses(overrides: Partial<Parameters<typeof CoursesPage>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(CoursesPage, {
      t,
      courses: [cs101, math],
      recordings: [lectureA, lectureB, lectureC],
      capabilities: WRITABLE,
      lectureStatus: () => 'Ready' as const,
      formatDuration: () => '30:00',
      onOpenCourse: () => undefined,
      onOpenLecture: () => undefined,
      onNewCourse: () => undefined,
      onRenameCourse: () => undefined,
      onDeleteCourse: () => undefined,
      recentlyDeletedCount: 0,
      onOpenRecentlyDeleted: () => undefined,
      ...overrides,
    }),
  )
}

/* ── A · interpolation ───────────────────────────────────────────────────── */

describe('count interpolation', () => {
  it('the i18n layer substitutes named variables', () => {
    expect(interpolate('{count} courses', { count: 3 })).toBe('3 courses')
    expect(translateDesktop('en', 'courses.countOther', { count: 0 })).toBe('0 courses')
  })

  it('leaves an unknown token visible rather than blanking it', () => {
    // A silent empty string reads as a legitimately empty label; a visible
    // token is a bug the scan below catches.
    expect(interpolate('{count} of {total}', { count: 1 })).toBe('1 of {total}')
  })

  it('English produces the required singular and plural forms', () => {
    expect(translateDesktop('en', 'courses.countOther', { count: 0 })).toBe('0 courses')
    expect(translateDesktop('en', 'courses.countOne', { count: 1 })).toBe('1 course')
    expect(translateDesktop('en', 'courses.countOther', { count: 2 })).toBe('2 courses')
    expect(translateDesktop('en', 'courses.lectureCountOther', { count: 0 })).toBe('0 lectures')
    expect(translateDesktop('en', 'courses.lectureCountOne', { count: 1 })).toBe('1 lecture')
    expect(translateDesktop('en', 'courses.lectureCountOther', { count: 2 })).toBe('2 lectures')
  })

  it('French produces the required singular and plural forms', () => {
    // 0 takes the plural key by product decision; "cours" is invariant.
    expect(translateDesktop('fr', 'courses.countOther', { count: 0 })).toBe('0 cours')
    expect(translateDesktop('fr', 'courses.countOne', { count: 1 })).toBe('1 cours')
    expect(translateDesktop('fr', 'courses.countOther', { count: 2 })).toBe('2 cours')
    expect(translateDesktop('fr', 'courses.lectureCountOther', { count: 0 })).toBe('0 séances')
    expect(translateDesktop('fr', 'courses.lectureCountOne', { count: 1 })).toBe('1 séance')
    expect(translateDesktop('fr', 'courses.lectureCountOther', { count: 2 })).toBe('2 séances')
  })

  it('no locale leaves an unresolved token in any count string', () => {
    // Selected by what the ENGLISH template actually contains, not by key name:
    // `settings.account` matches a naive /count/ test and has no placeholder.
    const countKeys = DESKTOP_I18N_KEYS.filter((key) =>
      translateDesktop('en', key).includes('{count}'),
    )
    expect(countKeys.length).toBeGreaterThan(0)
    for (const locale of DESKTOP_I18N_LOCALES) {
      for (const key of countKeys) {
        for (const count of [0, 1, 2, 17]) {
          const rendered = translateDesktop(locale, key, { count })
          expect(unresolvedPlaceholders(rendered), `${locale}/${key}`).toEqual([])
          expect(rendered).toContain(String(count))
        }
      }
    }
  })

  it('renders no {count}, {course} or {name} anywhere on Courses V2', () => {
    for (const markup of [
      renderCourses(),
      renderCourses({ courses: [] }),
      renderCourses({ recentlyDeletedCount: 4 }),
      renderCourses({ courses: [cs101], recordings: [lectureA] }),
    ]) {
      expect(markup).not.toContain('{count}')
      expect(markup).not.toContain('{course}')
      expect(markup).not.toContain('{name}')
      expect(unresolvedPlaceholders(markup)).toEqual([])
    }
  })

  it('renders no unresolved token on Course Detail or Recently Deleted', () => {
    const detail = renderToStaticMarkup(
      createElement(CourseDetailPage, {
        t,
        course: cs101,
        courses: [cs101, math],
        recordings: [lectureA, lectureB, lectureC],
        capabilities: WRITABLE,
        lectureStatus: () => 'Ready' as const,
        formatDuration: () => '30:00',
        formatDate: () => 'Aug 5',
        onBack: () => undefined,
        onStartLecture: () => undefined,
        onOpenLecture: () => undefined,
        onRenameCourse: () => undefined,
        onDeleteCourse: () => undefined,
      }),
    )
    const bin = renderToStaticMarkup(
      createElement(RecentlyDeletedPage, {
        t,
        deletedCourses: [course('c9', 'Old course', 3, 1_700_100_000_000)],
        deletedLectures: deletedLecturesFromRegistry(
          { r9: { trashedAt: 1_700_200_000_000, title: 'Gone', course: 'CS 101' } },
          'Untitled lecture',
        ),
        activeCourses: [cs101],
        capabilities: WRITABLE,
        busy: false,
        formatDate: () => 'Aug 5',
        onBack: () => undefined,
        onRestoreCourse: () => undefined,
        onPurgeCourse: () => undefined,
        onRestoreLecture: () => undefined,
        onPurgeLecture: () => undefined,
      }),
    )
    expect(unresolvedPlaceholders(detail)).toEqual([])
    expect(unresolvedPlaceholders(bin)).toEqual([])
  })

  it('the context signature accepts variables, so callers cannot silently drop them', () => {
    expect(appSource).toContain('t={tDesktop}')
    const context = readFileSync(new URL('../languagePreferencesContext.ts', import.meta.url), 'utf8')
    expect(context).toContain('vars?: DesktopI18nVars')
  })

  it('no component substitutes counts by hand', () => {
    for (const file of ['CoursesPage.tsx', 'CourseDetailPage.tsx', 'RecentlyDeletedPage.tsx']) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
      expect(source, file).not.toContain(".replace('{count}'")
      expect(source, file).not.toContain('.replace("{count}"')
    }
  })
})

/* ── B · Recently Deleted ────────────────────────────────────────────────── */

describe('Recently Deleted', () => {
  it('is hidden entirely when nothing has been deleted', () => {
    expect(renderCourses({ recentlyDeletedCount: 0 })).not.toContain('Recently deleted')
  })

  it('appears with a count once something is in the bin', () => {
    const markup = renderCourses({ recentlyDeletedCount: 1 })
    expect(markup).toContain('Recently deleted')
    expect(markup).toContain('1 item')
  })

  it('is not a sidebar destination', () => {
    const sidebar = readFileSync(new URL('./DesktopSidebar.tsx', import.meta.url), 'utf8')
    expect(sidebar).not.toContain('recentlyDeleted')
    expect(sidebar).toContain("'record' | 'courses' | 'settings'")
  })

  it('counts courses and lectures together', () => {
    const lectures = deletedLecturesFromRegistry(
      {
        r1: { trashedAt: 20, title: 'One', course: 'CS 101' },
        r2: { trashedAt: 10, title: 'Two', course: '' },
      },
      'Untitled lecture',
    )
    expect(recentlyDeletedCount([course('c9', 'Gone', 1, 5)], lectures)).toBe(3)
  })

  it('orders deleted lectures newest first', () => {
    const rows = deletedLecturesFromRegistry(
      {
        older: { trashedAt: 10, title: 'Older', course: 'CS 101' },
        newer: { trashedAt: 99, title: 'Newer', course: 'CS 101' },
      },
      'Untitled lecture',
    )
    expect(rows.map((r) => r.id)).toEqual(['newer', 'older'])
  })

  it('shows the original course and an Unfiled fallback', () => {
    const markup = renderToStaticMarkup(
      createElement(RecentlyDeletedPage, {
        t,
        deletedCourses: [],
        deletedLectures: deletedLecturesFromRegistry(
          {
            r1: { trashedAt: 20, title: 'Filed one', course: 'CS 101' },
            r2: { trashedAt: 10, title: 'Loose one', course: '' },
          },
          'Untitled lecture',
        ),
        activeCourses: [cs101],
        capabilities: WRITABLE,
        busy: false,
        formatDate: () => 'Aug 5',
        onBack: () => undefined,
        onRestoreCourse: () => undefined,
        onPurgeCourse: () => undefined,
        onRestoreLecture: () => undefined,
        onPurgeLecture: () => undefined,
      }),
    )
    expect(markup).toContain('CS 101')
    expect(markup).toContain('Unfiled')
    expect(markup).toContain('Restore')
    expect(markup).toContain('Delete permanently')
  })

  it('restoring a lecture identifies the soft-deleted course to restore with it', () => {
    const deletedCourse = course('c9', 'CS 101', 0, 1_700_000_000_000)
    const [lecture] = deletedLecturesFromRegistry(
      { r1: { trashedAt: 20, title: 'One', course: 'cs 101' } },
      'Untitled lecture',
    )
    // Name matching is lower(btrim()), the same key the database index uses.
    expect(courseToRestoreWithLecture(lecture, [deletedCourse])?.id).toBe('c9')
    expect(courseToRestoreWithLecture({ courseName: '' }, [deletedCourse])).toBeNull()
    expect(courseToRestoreWithLecture({ courseName: 'Other' }, [deletedCourse])).toBeNull()
  })

  it('local-only rows report no deletion date rather than inventing one', () => {
    const rows = deletedLecturesFromLocalRows([lectureA], 'Untitled lecture')
    expect(rows[0].deletedAt).toBe(0)
    expect(rows[0].createdAt).toBeUndefined()
  })

  it('offers no bulk empty action and invents no expiry', () => {
    const page = codeOnly('./RecentlyDeletedPage.tsx')
    expect(page).not.toMatch(/empty\s*(recently\s*)?deleted/i)
    expect(page).not.toMatch(/\b30[- ]day\b/i)
    expect(page).not.toMatch(/\bexpir/i)
    expect(page).not.toMatch(/countdown/i)
    // No dictionary string promises an expiry either.
    for (const locale of DESKTOP_I18N_LOCALES) {
      expect(translateDesktop(locale, 'deleted.noExpiry')).not.toMatch(/30|days?/i)
    }
  })

  it('performs no I/O of its own', () => {
    const page = codeOnly('./RecentlyDeletedPage.tsx')
    expect(page).not.toContain('supabase')
    expect(page).not.toContain('@supabase/supabase-js')
    expect(page).not.toContain('fetch(')
  })
})

/* ── C · active recording ────────────────────────────────────────────────── */

function renderRecording(overrides: Partial<Parameters<typeof RecordingV2>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(RecordingV2, {
      t,
      stage: 'recording' as const,
      courseName: 'CS 101',
      courseIdentity: { icon: cs101.icon, tint: cs101.tint, accent: cs101.accent },
      lectureTitle: 'Lecture 13',
      elapsed: '12:04',
      languageLine: 'English → Chinese · Bilingual',
      sourceCommitted: 'First sentence. Second sentence.',
      sourceDraft: 'third in progress',
      translationCommitted: '第一句。第二句。',
      translationDraft: '第三句进行中',
      translationEnabled: true,
      translationPending: false,
      notice: null,
      failureMessage: null,
      busy: false,
      canOpenOverlay: true,
      onOpenOverlay: () => undefined,
      onDiscard: () => undefined,
      onPause: () => undefined,
      onResume: () => undefined,
      onStopAndSave: () => undefined,
      onViewLecture: () => undefined,
      onRecordAnother: () => undefined,
      onRetry: () => undefined,
      ...overrides,
    }),
  )
}

describe('Recording V2', () => {
  const LEGACY = [
    'yl-shell',
    'yl-topbar',
    'yl-sidebar',
    'record-workspace',
    'workspace-page-shell',
    'yl-recording-strip',
    'live-cockpit',
    'live-caption-columns',
    'yl-summary-card',
    'recording-status-card',
  ]

  it('contains zero legacy shell nodes', () => {
    const markup = renderRecording()
    for (const legacy of LEGACY) {
      expect(markup, legacy).not.toContain(legacy)
    }
    expect(markup).not.toContain('yl-')
  })

  it('renders zero legacy shell nodes at EVERY post-recording stage', () => {
    // The whole Stop & Save tail, not just the live screen: saving, uploading,
    // both processing steps, partial and full readiness, failure and recovery.
    const stages = [
      'saving_local', 'uploading', 'processing_transcript', 'processing_summary',
      'partial_ready', 'ready', 'upload_failed', 'recovery_required', 'paused',
    ] as const
    for (const stage of stages) {
      const markup = renderRecording({ stage, failureMessage: 'Upload failed.' })
      for (const legacy of LEGACY) expect(markup, `${stage}/${legacy}`).not.toContain(legacy)
      expect(markup, stage).not.toContain('yl-')
      expect(unresolvedPlaceholders(markup), stage).toEqual([])
    }
  })

  it('offers View lecture only once the lecture actually exists', () => {
    for (const stage of ['ready', 'partial_ready'] as const) {
      expect(renderRecording({ stage })).toContain('View lecture')
    }
    for (const stage of ['saving_local', 'uploading', 'upload_failed'] as const) {
      expect(renderRecording({ stage }), stage).not.toContain('View lecture')
    }
  })

  it('shows the real failure reason and a retry, never a silent loss', () => {
    const markup = renderRecording({ stage: 'upload_failed', failureMessage: 'Storage rejected the upload.' })
    expect(markup).toContain('Storage rejected the upload.')
    expect(markup).toContain('Try again')
  })

  it('hides the live controls once the mic has stopped', () => {
    const markup = renderRecording({ stage: 'uploading' })
    expect(markup).not.toContain('Stop &amp; Save')
    expect(markup).not.toContain('Discard')
  })

  it('View lecture opens the exact saved recording through the shared opener', () => {
    const block = appSource.slice(
      appSource.indexOf('onViewLecture={() => {'),
      appSource.indexOf('onRecordAnother={() => {'),
    )
    expect(block).toContain('recentCapture?.recordingId')
    expect(block).toContain('openLectureDetail(id)')
    // The outcome is cleared first, or the stage panel would still own the view.
    expect(block).toContain('setRecentCapture(null)')
  })

  it('an active recording outranks every other view in App.tsx', () => {
    // The whole failure was that this branch did not exist and desktopV2View
    // fell through to null, which selects the legacy shell.
    expect(appSource).toContain('ownsRecordingScreen(recordingStage)\n      ? \'recording\'')
    expect(appSource).toContain("desktopV2View === 'recording' ? (")
    expect(appSource).toContain('<RecordingV2')
  })

  it('a terminal recovery stage renders on Record and never traps navigation', () => {
    // P0 regression: with a pending "unfinished recording" the derived
    // desktopV2View forced 'recording' regardless of the sidebar click, so
    // Courses/Settings looked dead. The fix renders terminal stages on the
    // Record branch (via isTerminalRecordingStage) instead of the nav-pinning
    // 'recording' branch, and Dismiss clears only the recovery prompt.
    expect(appSource).toContain('isTerminalRecordingStage(recordingStage) ? (')
    expect(appSource).toContain('const recordingScreen = (')
    // Dismiss must not delete the durable session — it clears recoveredSessions
    // (the prompt) only, so audio stays recoverable on the next launch.
    const dismissBlock = appSource.slice(
      appSource.indexOf('onRecordAnother={() => {'),
      appSource.indexOf('onRetry={() => {'),
    )
    expect(dismissBlock).toContain('setRecoveredSessions([])')
    // Hard safety gate: the Dismiss path must never touch the durable session
    // store or its chunk blobs.
    expect(dismissBlock).not.toContain('deleteRecordingSession')
    expect(dismissBlock).not.toContain('keepRecordingSessionForLater')
    expect(dismissBlock).not.toContain('completeRecordingSessionPersist')
  })

  it('shows REC while recording and PAUSED while paused', () => {
    expect(renderRecording()).toContain('REC')
    const paused = renderRecording({ stage: 'paused' })
    expect(paused).toContain('PAUSED')
    expect(paused).toContain('Resume')
    expect(paused).not.toContain('>Pause<')
  })

  it('carries the real course identity, not a hardcoded palette', () => {
    const markup = renderRecording()
    expect(markup).toContain(cs101.tint)
    expect(markup).toContain(cs101.accent)
    expect(markup).toContain(`data-course-icon="${cs101.icon}"`)
  })

  it('renders every required control exactly once', () => {
    const markup = renderRecording()
    for (const label of ['Discard', 'Pause', 'Stop &amp; Save', 'Open Overlay', '12:04', 'Lecture 13']) {
      expect(markup, label).toContain(label)
    }
    expect(markup.match(/Stop &amp; Save/g)).toHaveLength(1)
  })

  it('hides Open Overlay outside Tauri rather than offering a dead button', () => {
    expect(renderRecording({ canOpenOverlay: false })).not.toContain('Open Overlay')
  })

  it('puts the translation directly under the current source line', () => {
    const markup = renderRecording()
    const source = markup.indexOf('recording-v2__source')
    const translation = markup.indexOf('recording-v2__translation')
    const history = markup.indexOf('recording-v2__history')
    expect(history).toBeGreaterThan(-1)
    expect(source).toBeGreaterThan(history)
    expect(translation).toBeGreaterThan(source)
  })

  it('omits the translation row when translation is off', () => {
    expect(renderRecording({ translationEnabled: false })).not.toContain('recording-v2__translation')
  })

  it('constrains the shell so the bottom controls stay above the fold', () => {
    // Measured regression: the shared shell is sized `min-height: 100dvh`, so it
    // grows with content and `flex: 1` resolves to "as tall as the captions".
    // That put Discard / Pause / Stop & Save 268px below the fold at 800x600.
    // The constraint is scoped with :has so no other V2 view is affected.
    const css = readFileSync(new URL('../styles/recording-v2.css', import.meta.url), 'utf8')
    expect(css).toContain('.desktop-v2:has(.recording-v2)')
    expect(css).toContain('height: 100dvh')
    expect(css).toContain('.desktop-v2-page:has(> .recording-v2)')
    // History is the only part allowed to scroll.
    expect(css).toContain('.recording-v2__history')
    expect(css).toMatch(/\.recording-v2__history\s*\{[^}]*overflow-y:\s*auto/)
    // The controls never scroll away with it.
    expect(css).toMatch(/\.recording-v2__controls\s*\{[^}]*flex:\s*0 0 auto/)
  })

  it('never pins the scroller unconditionally', () => {
    const source = codeOnly('./RecordingV2.tsx')
    // The forbidden shapes: both override a reader who has scrolled up.
    expect(source).not.toContain('scrollIntoView')
    expect(source).not.toMatch(/scrollTop\s*=\s*\w+\.scrollHeight/)
    // Every move is gated on the follow state.
    expect(source).toContain('shouldPinToBottom(follow)')
    expect(source).toContain('requestAnimationFrame')
  })

  it('gives the two destructive actions a real hit target', () => {
    // Both were 17px tall: the shared quiet-link style is a bare text run, which
    // is right for navigation and too small for an action with no undo.
    const recordingCss = readFileSync(new URL('../styles/recording-v2.css', import.meta.url), 'utf8')
    const coursesCss = readFileSync(new URL('../styles/courses-v2.css', import.meta.url), 'utf8')
    expect(recordingCss).toMatch(/\.recording-v2__discard\s*\{[^}]*min-height:\s*36px/)
    expect(coursesCss).toMatch(/\.deleted-v2__danger\s*\{[^}]*min-height:\s*36px/)
  })

  it('drives no recorder of its own', () => {
    const source = codeOnly('./RecordingV2.tsx')
    for (const forbidden of ['MediaRecorder', 'getUserMedia', 'supabase', 'setInterval', 'invoke(']) {
      expect(source, forbidden).not.toContain(forbidden)
    }
  })

  it('opens the SAME production overlay the legacy button used', () => {
    expect(appSource).toContain("void invoke('show_overlay')")
    expect(appSource).toContain('onOpenOverlay={openLectureOverlay}')
    expect(appSource.match(/invoke\('show_overlay'\)/g)).toHaveLength(1)
  })
})

describe('caption stack', () => {
  it('splits on terminal punctuation in both scripts', () => {
    expect(splitCaptionSentences('One. Two! Three?')).toEqual(['One.', 'Two!', 'Three?'])
    expect(splitCaptionSentences('第一句。第二句！')).toEqual(['第一句。第二句！'])
  })

  it('keeps unpunctuated text as one line rather than cutting mid-clause', () => {
    expect(splitCaptionSentences('a long stretch with no punctuation at all')).toHaveLength(1)
  })

  it('makes the draft the current line and everything committed history', () => {
    const stack = buildCaptionStack('One. Two.', 'three in progress')
    expect(stack.history).toEqual(['One.', 'Two.'])
    expect(stack.current).toBe('three in progress')
  })

  it('keeps the last committed sentence on the current line when no draft exists', () => {
    const stack = buildCaptionStack('One. Two.', '')
    expect(stack.history).toEqual(['One.'])
    expect(stack.current).toBe('Two.')
  })

  it('is empty for an empty stream', () => {
    expect(buildCaptionStack('', '')).toEqual({ history: [], current: '' })
  })

  it('bounds history so a two-hour lecture cannot grow the DOM without limit', () => {
    const committed = Array.from({ length: 200 }, (_, i) => `Line ${i}.`).join(' ')
    expect(buildCaptionStack(committed, 'now', 60).history).toHaveLength(60)
  })
})

/* ── D · Course Detail → Lecture Detail ──────────────────────────────────── */

describe('lecture navigation', () => {
  it('routes through one shared opener, not per-callsite state juggling', () => {
    expect(appSource).toContain('const openLectureDetail = useCallback(')
    // Every V2 surface that opens a lecture uses it.
    expect(appSource.match(/onOpenLecture=\{openLectureDetail\}/g)?.length).toBe(4)
  })

  it('sets the selected id, clears stale detail and leaves the courses view', () => {
    const opener = appSource.slice(
      appSource.indexOf('const openLectureDetail = useCallback('),
      appSource.indexOf('/* ── Recently Deleted V2'),
    )
    expect(opener).toContain('setDetail(null)')
    expect(opener).toContain('setSelectedId(recordingId)')
    expect(opener).toContain("setWorkspaceView('lecture')")
    // The old behaviour: it stayed on `courses`, so the V2 grid kept rendering.
    expect(opener).not.toContain("setWorkspaceView('courses')")
  })

  it('refuses a lecture that is no longer in the library', () => {
    const opener = appSource.slice(
      appSource.indexOf('const openLectureDetail = useCallback('),
      appSource.indexOf('/* ── Recently Deleted V2'),
    )
    expect(opener).toContain('if (!recordingsInLibrary.some((r) => r.id === recordingId)) return')
  })

  it('the lecture view is now V2, and the legacy detail is unreachable', () => {
    // INVERTED: `lecture` used to yield a null V2 page on purpose, which
    // selected the legacy shell. That was the regression — View Lecture landed
    // back in the old interface. It is a real V2 view now.
    expect(appSource).toContain("openLecture\n            ? 'lecture'")
    expect(appSource).toContain("desktopV2View === 'lecture' && openLecture ? (")
    expect(appSource).toContain('<LectureDetailPage')
    // The legacy detail markup may remain, but nothing routes to it.
    expect(appSource).not.toContain("workspaceView === 'lecture'\n          ? null")
  })

  it('keeps the open course so leaving a lecture returns to that course', () => {
    const detailBlock = appSource.slice(
      appSource.indexOf("desktopV2View === 'courseDetail' && openCourse ? ("),
      appSource.indexOf("desktopV2View === 'courses' ? ("),
    )
    expect(detailBlock).toContain('onOpenLecture={openLectureDetail}')
    expect(detailBlock).toContain('setRecordingCourseId(openCourse.id)')
    // `onStartLecture` legitimately clears the open course on its way to Record
    // Home. What must not come back is the OLD `onOpenLecture` body, which
    // cleared it and then routed to `courses` — losing both the course and the
    // lecture. The shared opener touches neither.
    const opener = appSource.slice(
      appSource.indexOf('const openLectureDetail = useCallback('),
      appSource.indexOf('/* ── Recently Deleted V2'),
    )
    expect(opener).not.toContain('setOpenCourseId')
  })

  it('a course detail row carries the id of its own lecture', () => {
    const opened: string[] = []
    renderToStaticMarkup(
      createElement(CourseDetailPage, {
        t,
        course: cs101,
        courses: [cs101, math],
        recordings: [lectureA, lectureB, lectureC],
        capabilities: WRITABLE,
        lectureStatus: () => 'Ready' as const,
        formatDuration: () => '30:00',
        formatDate: () => 'Aug 5',
        onBack: () => undefined,
        onStartLecture: () => undefined,
        onOpenLecture: (id: string) => opened.push(id),
        onRenameCourse: () => undefined,
        onDeleteCourse: () => undefined,
      }),
    )
    // Only this course's lectures are listed; Math 210's is not.
    const markup = renderToStaticMarkup(
      createElement(CourseDetailPage, {
        t,
        course: cs101,
        courses: [cs101, math],
        recordings: [lectureA, lectureB, lectureC],
        capabilities: WRITABLE,
        lectureStatus: () => 'Ready' as const,
        formatDuration: () => '30:00',
        formatDate: () => 'Aug 5',
        onBack: () => undefined,
        onStartLecture: () => undefined,
        onOpenLecture: () => undefined,
        onRenameCourse: () => undefined,
        onDeleteCourse: () => undefined,
      }),
    )
    expect(markup).toContain('Lecture A — sorting')
    expect(markup).toContain('Lecture B — graphs')
    expect(markup).not.toContain('Lecture C — limits')
    expect(opened).toEqual([])
  })
})

/* ── Course → Start Lecture entry (P0) ───────────────────────────────────── */

describe('Course → Start Lecture entry', () => {
  const detailHtml = () =>
    renderToStaticMarkup(
      createElement(CourseDetailPage, {
        t,
        course: cs101,
        courses: [cs101, math],
        recordings: [lectureA],
        capabilities: WRITABLE,
        lectureStatus: () => 'Ready' as const,
        formatDuration: () => '30:00',
        formatDate: () => 'Aug 5',
        onBack: () => undefined,
        onStartLecture: () => undefined,
        onOpenLecture: () => undefined,
        onRenameCourse: () => undefined,
        onDeleteCourse: () => undefined,
      }),
    )

  it('renders an obvious primary recording CTA, not a ghost/overflow action', () => {
    const markup = detailHtml()
    // The label and the filled navy "record" button style are both present.
    expect(markup).toContain('Start new lecture')
    expect(markup).toContain('v2-btn--record')
    // The CTA is a direct button, not buried in the ••• overflow menu.
    expect(markup).not.toContain('v2-btn--primary')
  })

  it('Start Lecture begins recording with the exact course UUID', () => {
    const start = appSource.indexOf('onStartLecture={() => {')
    const end = appSource.indexOf('}}', start)
    const block = appSource.slice(start, end)
    // Canonical UUID, never the course name, is what gets selected.
    expect(block).toContain('setRecordingCourseId(openCourse.id)')
    expect(block).toContain('setCourse(openCourse.name)')
    // Recording V2 opens immediately via the SAME single recorder entry point.
    expect(block).toContain('startRecording()')
  })

  it('Finish/upload writes the same canonical course_id', () => {
    // Both the audio upload and the DB insert pass `recordingCourseId` through
    // as `courseId`, so the lecture lands under exactly the selected course.
    const matches = appSource.match(/courseId: recordingCourseId/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })

  it('no duplicate recorder implementation is introduced', () => {
    // The single `startRecording` definition remains the only recorder entry.
    const starts = appSource.match(/const startRecording = /g) ?? []
    expect(starts).toHaveLength(1)
  })
})

/* ── title typography ────────────────────────────────────────────────────── */

describe('heading typography', () => {
  const v2Css = readFileSync(new URL('../styles/desktop-v2.css', import.meta.url), 'utf8')
  const recordingCss = readFileSync(new URL('../styles/recording-v2.css', import.meta.url), 'utf8')
  const globalCss = readFileSync(new URL('../index.css', import.meta.url), 'utf8')

  it('the cramped title had an inherited ABSOLUTE tracking, and it is neutralised', () => {
    // index.css sets `h1 { letter-spacing: -1.68px }`, tuned for a 56px hero
    // (~-0.03em). Inherited onto the 17px recording title that is ~-0.10em, and
    // the letters collided. The global rule still exists for the marketing
    // pages; V2 headings now start from `normal`.
    expect(globalCss).toContain('letter-spacing: -1.68px')
    expect(v2Css).toMatch(/\.desktop-v2 h1,[\s\S]{0,120}letter-spacing: normal/)
    expect(recordingCss).toMatch(
      /\.recording-v2__title-block h1 \{[^}]*letter-spacing: normal/,
    )
  })

  it('no V2 heading uses an absolute-length tracking', () => {
    // px tracking cannot scale with font-size; em is the only safe unit here.
    // Comments are stripped: the rules above quote the -1.68px they replace.
    const coursesCss = readFileSync(new URL('../styles/courses-v2.css', import.meta.url), 'utf8')
    for (const css of [v2Css, recordingCss, coursesCss]) {
      const px = [...cssCode(css).matchAll(/letter-spacing:\s*(-?[\d.]+)px/g)]
      expect(px.map((m) => m[0])).toEqual([])
    }
  })

  it('no V2 heading uses an unsafe negative tracking', () => {
    const em = [...cssCode(`${v2Css}\n${recordingCss}`).matchAll(/letter-spacing:\s*(-[\d.]+)em/g)]
    expect(em.length).toBeGreaterThan(0)
    for (const match of em) {
      // -0.04em is about the floor before letterforms start to touch at UI sizes.
      expect(Number(match[1]), match[0]).toBeGreaterThanOrEqual(-0.04)
    }
  })

  it('the narrow header gives the title its own row, not a squeezed slot', () => {
    // `width: 100%` with `order: 4` left flex-basis at 0, so the title landed to
    // the right of Open Overlay on the first row instead of wrapping.
    expect(recordingCss).toMatch(/\.recording-v2__title-block \{ order: 4; flex: 1 0 100%; \}/)
  })

  it('the title can shrink instead of forcing the header wider', () => {
    expect(recordingCss).toMatch(/\.recording-v2__title-block \{[^}]*min-width: 0/)
    expect(recordingCss).toMatch(/\.recording-v2__title-block \{[^}]*flex: 1/)
    expect(recordingCss).toMatch(/\.recording-v2__title-block h1 \{[^}]*text-overflow: ellipsis/)
    expect(recordingCss).toMatch(/\.recording-v2__title-block h1 \{[^}]*line-height: 1\.35/)
  })

  it('renders every language without an unresolved token', () => {
    const titles = [
      'Untitled lecture',
      'Lecture 13 — nucleophilic substitution and its stereochemical consequences',
      '线性代数 第十三讲 —— 特征值与特征向量',
      '第13回 ナビエ・ストークス方程式の導出',
      'Séance 13 — substitution nucléophile et stéréochimie',
      '13강 — 고유값과 고유벡터',
    ]
    for (const lectureTitle of titles) {
      const markup = renderRecording({ lectureTitle })
      expect(markup).toContain(lectureTitle.slice(0, 10))
      expect(unresolvedPlaceholders(markup)).toEqual([])
    }
  })
})

/* ── caption scrolling ───────────────────────────────────────────────────── */

describe('caption history scrolling', () => {
  const css = readFileSync(new URL('../styles/recording-v2.css', import.meta.url), 'utf8')

  it('is a real scroll container, not a synthetic drag', () => {
    expect(css).toMatch(/\.recording-v2__history \{[^}]*overflow-y: auto/)
    expect(css).toMatch(/\.recording-v2__history \{[^}]*overscroll-behavior: contain/)
    const source = codeOnly('./RecordingV2.tsx')
    // Zero gesture handlers of any kind: two-finger scrolling, momentum, the
    // wheel and Page Up/Down are entirely the platform's, exactly as in Safari.
    // Intent is read from the resulting scroll POSITION instead.
    for (const fake of ['onMouseDown', 'onPointerDown', 'onTouchMove', 'onTouchStart', 'onWheel']) {
      expect(source, fake).not.toContain(fake)
    }
    expect(source).not.toContain('preventDefault')
    expect(source).not.toContain('{ passive: false }')
    expect(source).toContain('onScroll={onHistoryScroll}')
  })

  it('does not pin while the platform is still animating a gesture', () => {
    // macOS momentum keeps firing `scroll` after the fingers lift; writing
    // scrollTop during that window is what a fight feels like.
    const source = codeOnly('./RecordingV2.tsx')
    expect(source).toContain('if (performance.now() < userScrollingUntil.current) return')
    expect(source).toContain('userScrollingUntil.current = performance.now() + 220')
  })

  it('keeps the scroller off the composited slow path', () => {
    // A `-webkit-mask-image` on a scroll container forces a composited layer and
    // loses WebKit's fast scrolling — the reason two-finger scrolling felt heavy
    // in the real WKWebView while Chromium was fine. The fade is an overlay now.
    expect(css).not.toMatch(/\.recording-v2__history \{[^}]*mask-image/)
    expect(css).toMatch(/\.recording-v2__history-wrap::before \{[^}]*linear-gradient/)
    expect(css).toMatch(/\.recording-v2__history-wrap::before \{[^}]*pointer-events: none/)
  })

  it('leaves exactly one scroll container in the recording view', () => {
    // The shared page area is `overflow: auto`; nesting the history inside it
    // gave a two-finger gesture two possible targets.
    expect(css).toMatch(/\.desktop-v2-page:has\(> \.recording-v2\) \{[^}]*overflow: hidden/)
    expect(css).toMatch(/\.recording-v2__history \{[^}]*overflow-y: auto/)
  })

  it('keeps min-height: 0 on every link of the flex chain', () => {
    // A flex child defaults to `min-height: auto`, which lets content push the
    // box taller than its parent — the scroller then never scrolls.
    for (const sel of ['.recording-v2 ', '.recording-v2__captions ', '.recording-v2__history-wrap ', '.recording-v2__history ']) {
      const block = new RegExp(`\\${sel.trim()} \\{[^}]*min-height: 0`)
      expect(css, sel).toMatch(block)
    }
    expect(css).toMatch(/\.desktop-v2:has\(\.recording-v2\) \.desktop-v2-main \{[^}]*min-height: 0/)
  })

  it('never animates the scroll for live caption updates', () => {
    expect(css).toMatch(/\.recording-v2__history \{[^}]*scroll-behavior: auto/)
    // 'smooth' appears exactly once: the explicit Jump to latest call.
    const source = codeOnly('./RecordingV2.tsx')
    expect(source.match(/'smooth'/g)).toHaveLength(1)
    expect(source).toContain("pinToBottom('smooth')")
  })

  it('listens to native scroll to learn the reader\'s intent', () => {
    expect(codeOnly('./RecordingV2.tsx')).toContain('onScroll={onHistoryScroll}')
  })

  it('is keyboard reachable so Page Up / Page Down work', () => {
    expect(renderRecording()).toContain('tabindex="0"')
  })

  it('does not make a screen reader re-read history on every interim token', () => {
    const markup = renderRecording()
    expect(markup).toContain('aria-live="off"')
    // The current line is the polite region instead.
    expect(markup).toContain('aria-live="polite"')
  })

  it('shows Jump to latest only while suspended', () => {
    // Default render is following, so the affordance is absent.
    expect(renderRecording()).not.toContain('Jump to latest')
  })

  it('constrains a very long current caption instead of pushing the controls away', () => {
    expect(css).toMatch(/\.recording-v2__live \{[^}]*max-height/)
    expect(css).toMatch(/\.recording-v2__live \{[^}]*overflow-y: auto/)
    expect(css).toMatch(/recording-v2__source \{[^}]*overflow-wrap: anywhere/)
  })

  it('keeps history quieter and smaller than the current line', () => {
    const historySize = /\.recording-v2__history p \{[^}]*font-size: (\d+)px/.exec(css)
    const currentSize = /\.recording-v2__source \{[^}]*font-size: (\d+)px/.exec(css)
    expect(historySize).toBeTruthy()
    expect(currentSize).toBeTruthy()
    expect(Number(currentSize![1])).toBeGreaterThan(Number(historySize![1]))
    expect(css).toMatch(/\.recording-v2__history p \{[^}]*color: var\(--v2-faint\)/)
  })
})

/* ── deletion scope disclosure ───────────────────────────────────────────── */

describe('lecture deletion scope', () => {
  it('states the device-local truth in all six languages', () => {
    for (const locale of DESKTOP_I18N_LOCALES) {
      const text = translateDesktop(locale, 'deleted.lectureScopeNotice')
      expect(text.length, locale).toBeGreaterThan(20)
      expect(unresolvedPlaceholders(text), locale).toEqual([])
    }
    expect(translateDesktop('en', 'deleted.lectureScopeNotice')).toBe(
      'Deleted lectures are currently stored on this Mac and may still appear on other devices.',
    )
  })

  it('appears in Recently Deleted next to the lectures section', () => {
    const markup = renderToStaticMarkup(
      createElement(RecentlyDeletedPage, {
        t,
        deletedCourses: [],
        deletedLectures: deletedLecturesFromRegistry(
          { r1: { trashedAt: 20, title: 'One', course: 'CS 101' } },
          'Untitled lecture',
        ),
        activeCourses: [cs101],
        capabilities: WRITABLE,
        busy: false,
        formatDate: () => 'Aug 5',
        onBack: () => undefined,
        onRestoreCourse: () => undefined,
        onPurgeCourse: () => undefined,
        onRestoreLecture: () => undefined,
        onPurgeLecture: () => undefined,
      }),
    )
    expect(markup).toContain('may still appear on other devices')
  })

  it('appears in the lecture delete confirmation', () => {
    expect(appSource).toContain("tDesktop('deleted.lectureScopeNotice')")
  })

  it('claims no cross-device delete, expiry or cloud restore for lectures', () => {
    for (const locale of DESKTOP_I18N_LOCALES) {
      const notice = translateDesktop(locale, 'deleted.lectureScopeNotice')
      expect(notice).not.toMatch(/30|cloud|sync/i)
    }
  })
})

/* ── Lecture Detail V2 ───────────────────────────────────────────────────── */

describe('Lecture Detail V2', () => {
  const detailCss = readFileSync(new URL('../styles/lecture-detail-v2.css', import.meta.url), 'utf8')

  function renderDetail(over: Partial<Parameters<typeof LectureDetailPage>[0]> = {}) {
    return renderToStaticMarkup(
      createElement(LectureDetailPage, {
        t,
        recording: lectureA,
        detail: {
          ...lectureA,
          audioUrl: 'blob:x',
          storagePath: 'u/r1.webm',
          transcript: 'The lecture began with a review.\n\nThen we covered quicksort.',
          summaryEn: '## Outline\nSorting.\n\n## Key terms\nQuicksort.\n\n## Takeaways\nKnow them.',
          summaryZh: '## 大纲\n排序。\n\n## 关键术语\n快速排序。\n\n## 要点\n记住。',
        } as never,
        course: cs101,
        audioUrl: 'blob:x',
        languageLine: 'English → Chinese',
        formatDate: () => 'Aug 5, 2026',
        formatDuration: () => '30:00',
        onBack: () => undefined,
        backLabel: 'CS 101',
        onRename: () => undefined,
        onMove: () => undefined,
        onDelete: () => undefined,
        actionsDisabled: false,
        onSaveNotes: async () => undefined,
        onAddMark: async () => undefined,
        annotationsEditable: true,
        ...over,
      }),
    )
  }

  it('renders zero legacy shell nodes', () => {
    const markup = renderDetail()
    for (const legacy of ['yl-shell', 'yl-topbar', 'yl-sidebar', 'record-workspace', 'workspace-page-shell']) {
      expect(markup, legacy).not.toContain(legacy)
    }
    expect(markup).not.toContain('yl-')
    expect(unresolvedPlaceholders(markup)).toEqual([])
  })

  it('shows the real title, course, date, duration and readiness', () => {
    const markup = renderDetail()
    expect(markup).toContain('Lecture A — sorting')
    expect(markup).toContain('CS 101')
    expect(markup).toContain('Aug 5, 2026')
    expect(markup).toContain('30:00')
    expect(markup).toContain('Ready')
  })

  it('renders the summary under the document\'s own headings', () => {
    const markup = renderDetail()
    expect(markup).toContain('Outline')
    expect(markup).toContain('Key terms')
    expect(markup).toContain('Takeaways')
    expect(markup).toContain('Quicksort.')
  })

  it('offers the language switch only when both summaries exist', () => {
    expect(renderDetail()).toContain('简体中文')
    expect(renderDetail({ detail: { ...lectureA, audioUrl: '', storagePath: '', summaryEn: '## Outline\nX' } as never }))
      .not.toContain('简体中文')
  })

  it('falls back to the whole text for an unstructured summary, and says so', () => {
    const markup = renderDetail({
      detail: { ...lectureA, audioUrl: '', storagePath: '', summaryEn: 'Plain prose with no headings.' } as never,
    })
    expect(markup).toContain('Plain prose with no headings.')
    expect(markup).toContain('saved before sections were introduced')
  })

  it('states plainly when audio is unavailable rather than showing a dead transport', () => {
    const markup = renderDetail({ audioUrl: null, audioError: 'signing failed' })
    expect(markup).toContain('Audio is not available')
    expect(markup).toContain('Try again')
  })

  it('uses the real production player when audio exists', () => {
    const source = codeOnly('./LectureDetailPage.tsx')
    expect(source).toContain('RecordingAudioPlayer')
    // No preview timer, no synthetic playback.
    expect(source).not.toContain('setInterval')
    expect(source).not.toContain('Math.random')
  })

  it('performs no I/O of its own', () => {
    const source = codeOnly('./LectureDetailPage.tsx')
    expect(source).not.toContain('supabase')
    expect(source).not.toContain('fetch(')
  })

  it('keeps the transcript as one selectable block, with no invented timestamps', () => {
    expect(detailCss).toMatch(/\.lecture-v2__transcript \{[^}]*user-select: text/)
    const source = codeOnly('./LectureDetailPage.tsx')
    expect(source).not.toContain('onSeek')
    expect(source).not.toContain('timestamp')
  })

  it('uses em tracking, never the inherited absolute value', () => {
    expect(cssCode(detailCss)).not.toMatch(/letter-spacing:\s*-?[\d.]+px/)
  })

  /* ── M2 · Notes ──────────────────────────────────────────────────────── */

  describe('Notes tab', () => {
    it('adds a third tab alongside Summary and Transcript, not a new screen', () => {
      const markup = renderDetail()
      expect(markup).toContain('Summary')
      expect(markup).toContain('Transcript')
      expect(markup).toContain('Notes')
      // One tablist, one tabpanel visible at a time — this is a tab, not a
      // dedicated Notebook-style screen.
      expect((markup.match(/role="tab"/g) ?? []).length).toBe(3)
    })

    it('shows existing cloud notes, with line breaks preserved', () => {
      // The tab starts on Summary (`useState('summary')`), so the Notes panel
      // is not in the initial static markup — the same reason this file's
      // Transcript tests assert against source rather than rendered output.
      const source = codeOnly('./LectureDetailPage.tsx')
      // Read-only path (local-only mode): the stored text is rendered whole.
      expect(source).toContain('<div className="lecture-v2__prose lecture-v2__notes-read">{storedNotes}</div>')
      // Editable path (cloud mode): the live draft is what the box shows.
      expect(source).toContain('value={draft}')
      // Line breaks come from CSS `white-space`, not from injecting <br> tags
      // that would fight the user's own paragraph breaks.
      expect(detailCss).toMatch(/\.lecture-v2__notes-read \{[^}]*white-space: pre-wrap/)
    })

    it('an empty Notes state says so, distinct from "no notes yet, sign in"', () => {
      const source = codeOnly('./LectureDetailPage.tsx')
      // Three branches: editable (textarea), read-only with text (prose block),
      // read-only with nothing (the true empty state). Cloud mode with nothing
      // written reaches the editable textarea, not this empty state.
      expect(source).toContain('annotationsEditable ? (')
      expect(source).toContain(') : storedNotes.trim() ? (')
      expect(source).toContain("t('lecture.notesEmpty')")
      expect(source).toContain("t('lecture.notesLocalOnly')")
    })

    it('the editor is a real textarea, not a fake contenteditable div', () => {
      const source = codeOnly('./LectureDetailPage.tsx')
      expect(source).toContain('<textarea')
      expect(source).toContain('id="lecture-v2-notes"')
      expect(source).toContain('<label')
      expect(source).toContain('htmlFor="lecture-v2-notes"')
    })

    it('typing marks the draft dirty and enables Save; an untouched draft cannot be saved twice', () => {
      const source = codeOnly('./LectureDetailPage.tsx')
      expect(source).toContain('const notesDirty = draft !== storedNotes')
      expect(source).toContain("disabled={notesState === 'saving' || (!notesDirty && notesState !== 'failed')}")
    })

    it('Save sends the draft through onSaveNotes and nothing else', () => {
      const source = codeOnly('./LectureDetailPage.tsx')
      expect(source).toContain('onClick={saveNotes}')
      expect(source).toContain('onSaveNotes(draft)')
      // Not the stored value, not the recording object — only the text field.
      expect(source).not.toContain('onSaveNotes(recording)')
    })

    it('a failed save keeps the text and states the failure, never a silent success', () => {
      const source = codeOnly('./LectureDetailPage.tsx')
      expect(source).toContain(".catch(() => setNotesState('failed'))")
      expect(source).toContain("notesState === 'failed'")
      expect(source).toContain('notesSaveFailed')
      // Nothing clears `draft` in the failure branch — only success does.
      const catchBlock = source.slice(source.indexOf('.catch(() => setNotesState'))
      expect(catchBlock.slice(0, 40)).not.toContain('setDraft')
    })

    it('a confirmed save is what marks the field clean, not the keystroke', () => {
      const source = codeOnly('./LectureDetailPage.tsx')
      const thenBlock = source.slice(source.indexOf('.then(() =>'), source.indexOf('.catch'))
      expect(thenBlock).toContain("lastSeeded.current = draft")
      expect(thenBlock).toContain("setNotesState('saved')")
    })

    it('a remote row read before a save completes cannot overwrite the unsaved draft', () => {
      const source = codeOnly('./LectureDetailPage.tsx')
      // The re-seed effect only adopts the row's text when there is nothing
      // typed, or the last save already landed — never over a dirty draft.
      expect(source).toContain("current === '' || notesState === 'saved' ? storedNotes : current")
    })

    it('title, transcript and summary writes never appear in the Notes save path', () => {
      const patchSrc = readFileSync(new URL('../lib/lectureTitleIntegrity.ts', import.meta.url), 'utf8')
      const buildFn = patchSrc.slice(
        patchSrc.indexOf('export function buildLectureMetadataPatch('),
        patchSrc.indexOf('/**\n * Reconcile the titles'),
      )
      expect(buildFn).not.toContain('notes')
      const appNotesFn = appSource.slice(
        appSource.indexOf('const saveLectureNotes = useCallback('),
        appSource.indexOf('const addLectureMark = useCallback('),
      )
      expect(appNotesFn).not.toContain('title')
      expect(appNotesFn).not.toContain('markedTimestamps')
      expect(appNotesFn).toContain('notesUpdatedAt')
    })
  })

  /* ── M2 · Marks ──────────────────────────────────────────────────────── */

  describe('Marks', () => {
    it('renders a number[] as clock times, never raw milliseconds', () => {
      const markup = renderDetail({
        recording: { ...lectureA, markedTimestamps: [1500, 42000, 372100] } as never,
      })
      expect(markup).toContain('00:01')
      expect(markup).toContain('00:42')
      expect(markup).toContain('06:12')
      expect(markup).not.toContain('1500')
      expect(markup).not.toContain('42000')
      expect(markup).not.toContain('372100')
    })

    it('an empty marks list says so', () => {
      const markup = renderDetail({ recording: { ...lectureA, markedTimestamps: [] } as never })
      expect(markup).toContain('No marked moments yet')
    })

    it('duplicate marks render without crashing, once each', () => {
      const markup = renderDetail({
        recording: { ...lectureA, markedTimestamps: [1500, 1500, 1500] } as never,
      })
      // "00:01" appears twice per mark (the visible label AND the aria-label),
      // so three marks is six occurrences of the text — counting the button
      // elements themselves is the honest measure of "one each".
      expect((markup.match(/class="lecture-v2__mark"/g) ?? []).length).toBe(3)
    })

    it('stored order is preserved — the list is never sorted for display', () => {
      const markup = renderDetail({
        recording: { ...lectureA, markedTimestamps: [42000, 1500] } as never,
      })
      expect(markup.indexOf('00:42')).toBeLessThan(markup.indexOf('00:01'))
    })

    it('malformed remote marks degrade to nothing rendered, not a crash', () => {
      const markup = renderDetail({
        recording: {
          ...lectureA,
          markedTimestamps: ['not-a-number', null, undefined, {}, [], -5, Number.NaN, Infinity],
        } as never,
      })
      expect(markup).toContain('No marked moments yet')
    })

    it('a numeric string mark still renders — a real value from another client is not dropped', () => {
      const markup = renderDetail({ recording: { ...lectureA, markedTimestamps: ['1500'] } as never })
      expect(markup).toContain('00:01')
    })

    it('clicking a mark seeks the SAME player, ms/1000, never a second audio element', () => {
      const source = codeOnly('./LectureDetailPage.tsx')
      expect(source).toContain('onClick={() => seekToMark(ms)}')
      expect(source).toContain('player.current?.seekTo(markSeekSeconds(ms))')
      expect(source).toContain('controlsRef={player}')
      expect(source.match(/<audio/g)).toBeNull()
      expect(source).not.toContain('new Audio(')
    })

    it('seeking does not touch playback state, duration or the signed URL', () => {
      const playerSource = codeOnly('./RecordingAudioPlayer.tsx')
      const seekToFn = playerSource.slice(
        playerSource.indexOf('seekTo: (seconds: number) => {'),
        playerSource.indexOf('currentTime: () => ref.current'),
      )
      expect(seekToFn).not.toContain('setPlaying')
      expect(seekToFn).not.toContain('setFrozenTotalSec')
      expect(seekToFn).not.toContain('.play()')
      expect(seekToFn).not.toContain('.pause()')
    })

    it('Add Mark reads the SAME player position it seeks to', () => {
      const source = codeOnly('./LectureDetailPage.tsx')
      expect(source).toContain('const at = player.current?.currentTime()')
      expect(source).toContain('onAddMark(Math.round(at * 1000))')
    })

    it('a failed Add Mark states the failure without touching the list already shown', () => {
      const source = codeOnly('./LectureDetailPage.tsx')
      expect(source).toContain("onAddMark(Math.round(at * 1000)).catch(() => setMarkError(true))")
      expect(source).toContain('marksAddFailed')
    })

    it('Add Mark writes the WHOLE array plus the clock, in one update', () => {
      const fn = appSource.slice(
        appSource.indexOf('const addLectureMark = useCallback('),
        appSource.indexOf('/**\n   * Move a lecture to another course.'),
      )
      expect(fn).toContain('appendMark(current, atMs)')
      expect(fn).toContain('updateRecordingNotesMarks(supabase, userId, recordingId, { markedTimestamps: next })')
      expect(fn).toContain('marksUpdatedAt: now')
      // No sort, no dedupe before the write — that would rewrite marks another
      // device wrote.
      expect(fn).not.toContain('.sort(')
      expect(fn).not.toContain('Set(')
    })

    it('no object schema is introduced anywhere in the Marks write path', () => {
      // Scoped to the functions that actually touch a mark VALUE — not the
      // whole file, which legitimately has `{ id: string }` on the RECORDING
      // (the lecture the marks belong to, an existing concept unrelated to
      // per-mark identity, which V1 does not have).
      const annotations = codeOnly('../lib/lectureAnnotations.ts')
      const parseFn = annotations.slice(
        annotations.indexOf('export function parseMarks('),
        annotations.indexOf('export function formatMarkClock('),
      )
      const appendFn = annotations.slice(
        annotations.indexOf('export function appendMark('),
        // The next marker after `codeOnly` has stripped comments — a comment
        // string cannot be an end marker here, or the slice runs to EOF.
        annotations.indexOf('export type AnnotationSide'),
      )
      for (const fn of [parseFn, appendFn]) {
        expect(fn).not.toContain('label:')
        expect(fn).not.toContain('createdAt:')
        expect(fn).not.toMatch(/\{\s*id:/)
      }
      const addMarkFn = appSource.slice(
        appSource.indexOf('const addLectureMark = useCallback('),
        appSource.indexOf('/**\n   * Move a lecture to another course.'),
      )
      expect(addMarkFn).not.toContain('label:')
      expect(addMarkFn).not.toMatch(/\{\s*id:/)
    })

    it('accessible: each mark has a real label naming the time it jumps to', () => {
      const source = codeOnly('./LectureDetailPage.tsx')
      expect(source).toContain("aria-label={t('lecture.marksSeek', { time: formatMarkClock(ms) })}")
    })

    it('Marks and Notes are separate — no Notebook vocabulary anywhere near either', () => {
      const source = codeOnly('./LectureDetailPage.tsx')
      const annotationsSource = codeOnly('../lib/lectureAnnotations.ts')
      for (const forbidden of ['notebook', 'stroke', 'pencil', 'canvas', 'drawing']) {
        expect(source.toLowerCase(), forbidden).not.toContain(forbidden)
        expect(annotationsSource.toLowerCase(), forbidden).not.toContain(forbidden)
      }
    })
  })
})

describe('Lecture Detail routing', () => {
  it('every V2 entry point calls the one shared opener', () => {
    // Record Home recents, Courses recents, Course Detail rows.
    expect(appSource.match(/onOpenLecture=\{openLectureDetail\}/g)?.length).toBe(4)
    // Stop & Save → View Lecture.
    expect(appSource).toContain('openLectureDetail(id)')
  })

  it('the opener routes to the V2 view, not the legacy shell', () => {
    const opener = appSource.slice(
      appSource.indexOf('const openLectureDetail = useCallback('),
      appSource.indexOf('/* ── Recently Deleted V2'),
    )
    expect(opener).toContain("setWorkspaceView('lecture')")
    expect(appSource).toContain("openLecture\n            ? 'lecture'")
  })

  it('the header reads from the list row so it never blanks while loading', () => {
    expect(appSource).toContain('const openLecture = useMemo(')
    expect(appSource).toContain('recordingsInLibrary.find((r) => r.id === selectedId)')
  })

  it('passes the detail only when it belongs to the open lecture', () => {
    // Guards the stale-lecture case: a detail still loading for a previous id
    // must not be rendered under the new one.
    expect(appSource).toContain('detail?.id === openLecture.id ? detail : null')
    expect(appSource).toContain('detail?.id === openLecture.id ? audioUrl : null')
  })

  it('Back returns to the owning course, not to Record', () => {
    const block = appSource.slice(
      appSource.indexOf('<LectureDetailPage'),
      appSource.indexOf('actionsDisabled={lectureMetadataBusy'),
    )
    expect(block).toContain('setOpenCourseId(openLectureCourse ? openLectureCourse.id : null)')
    expect(block).toContain("setWorkspaceView('courses')")
    expect(block).not.toContain("setWorkspaceView('record')")
  })

  it('Rename, Move and Delete open three DIFFERENT dialogs', () => {
    // They shared one "edit title and course together" modal behind three
    // labels, so Rename could rewrite the course and Move could rewrite the
    // title. Each verb now has its own dialog.
    const block = appSource.slice(
      appSource.indexOf('<LectureDetailPage'),
      appSource.indexOf('actionsDisabled={lectureMetadataBusy'),
    )
    expect(block).toContain("setLectureDialog({ kind: 'rename'")
    expect(block).toContain("setLectureDialog({ kind: 'move'")
    expect(block).toContain("setLectureDialog({ kind: 'delete'")
    expect(block).not.toContain('openEditLectureModal')
  })

  it('Rename writes the title and NOTHING else', () => {
    const fn = appSource.slice(
      appSource.indexOf('const renameLecture = useCallback('),
      appSource.indexOf('const moveLectureToCourse = useCallback('),
    )
    // Stronger than before. `updateRecordingMetadata` is a PATCH now, so the
    // course is simply absent from the payload rather than read back and
    // rewritten — a rename cannot move a lecture even in principle.
    expect(fn).toContain('{ title: next }')
    expect(fn).toContain('{ ...r, title: next }')
    expect(fn).toContain('isMeaningfulLectureTitle(next)')
    expect(fn).not.toContain('courseDraft')
    expect(fn).not.toContain('course,')
  })

  it('Move writes the course and never touches the title', () => {
    const fn = appSource.slice(
      appSource.indexOf('const moveLectureToCourse = useCallback('),
      appSource.indexOf('const deleteFolderIfEmpty ='),
    )
    expect(fn).toContain('coursesState.assignLecture(recordingId, courseId)')
    expect(fn).toContain('{ ...r, course: result.courseName }')
    expect(fn).not.toContain('title:')
  })

  it('Move goes through the repository, preserving the dual write', () => {
    const repo = readFileSync(
      new URL('../lib/courses/supabaseCoursesRepository.ts', import.meta.url),
      'utf8',
    )
    expect(repo).toMatch(/course_id: course \? course\.id : null,\s*\n\s*course: label/)
  })

  it('Delete uses the V2 dialog and keeps the device-local disclosure', () => {
    const dialogs = readFileSync(new URL('./CourseDialogs.tsx', import.meta.url), 'utf8')
    expect(dialogs).toContain('export function DeleteLectureDialog')
    expect(dialogs).toContain("t('deleted.lectureScopeNotice')")
    // The existing production trash path, not a new delete.
    expect(appSource).toContain('void commitMoveToTrash([dialogLecture.id])')
  })
})

/*
 * Dialog assertions are structural, not render-based.
 *
 * Every dialog in CourseDialogs.tsx goes through `createPortal(…, document.body)`
 * — required, because each is hosted by a card that clips with
 * `overflow: hidden`, which no z-index can escape. React's server renderer
 * cannot render portals and this suite runs on the `node` environment, so these
 * read the source, exactly as the Create / Rename / Delete Course dialogs
 * already are. What matters here is which FIELDS each dialog owns, and that is
 * visible statically.
 */
describe('lecture action dialogs', () => {
  const dialogs = readFileSync(new URL('./CourseDialogs.tsx', import.meta.url), 'utf8')

  /** The source of one exported dialog, up to the next export. */
  function dialogSource(name: string): string {
    const start = dialogs.indexOf(`export function ${name}(`)
    expect(start, name).toBeGreaterThan(-1)
    const after = dialogs.indexOf('export function ', start + 10)
    return dialogs.slice(start, after > 0 ? after : undefined)
  }

  it('all three exist and go through the shared portal Dialog', () => {
    for (const name of ['RenameLectureDialog', 'MoveLectureDialog', 'DeleteLectureDialog']) {
      expect(dialogSource(name)).toContain('<Dialog')
    }
    expect(dialogs).toContain('createPortal(')
    expect(typeof RenameLectureDialog).toBe('function')
    expect(typeof MoveLectureDialog).toBe('function')
    expect(typeof DeleteLectureDialog).toBe('function')
  })

  it('they use V2 dialog classes, not browser defaults', () => {
    const overlays = readFileSync(new URL('../styles/course-overlays.css', import.meta.url), 'utf8')
    expect(overlays).toContain('.course-dialog-root')
    expect(overlays).toContain('.course-dialog__choice')
    expect(overlays).toContain('.course-dialog__scope-note')
    for (const name of ['RenameLectureDialog', 'MoveLectureDialog', 'DeleteLectureDialog']) {
      expect(dialogSource(name), name).toContain('course-dialog__btn')
    }
  })

  it('Rename owns a title field and NO course picker', () => {
    const src = dialogSource('RenameLectureDialog')
    expect(src).toContain("t('lecture.titleLabel')")
    expect(src).toContain('lecture-title-rename')
    expect(src).toContain('onRename(next)')
    // The proof it cannot move anything: no course list, no course state.
    expect(src).not.toContain('course-dialog__choices')
    expect(src).not.toContain('courses')
    expect(src).not.toContain('onMove')
  })

  it('Move owns a course picker and NO title field', () => {
    const src = dialogSource('MoveLectureDialog')
    expect(src).toContain('course-dialog__choices')
    expect(src).toContain("role=\"radiogroup\"")
    expect(src).toContain("t('deleted.unfiled')")
    expect(src).toContain('onMove(target)')
    // The proof it cannot rename anything: no input at all.
    expect(src).not.toContain('<input')
    expect(src).not.toContain('titleLabel')
    expect(src).not.toContain('onRename')
  })

  it('Move refuses when Unfiled is the only destination', () => {
    const src = dialogSource('MoveLectureDialog')
    expect(src).toContain('const destinations = courses.length + (currentCourseId === null ? 0 : 1)')
    expect(src).toContain('const nothingToDo = destinations <= 1')
    expect(src).toContain('!nothingToDo')
    expect(src).toContain("t('lecture.moveNowhere')")
  })

  it('Move cannot save a no-op', () => {
    expect(dialogSource('MoveLectureDialog')).toContain('target !== currentCourseId')
  })

  it('Delete keeps the device-local disclosure and reuses the trash path', () => {
    const src = dialogSource('DeleteLectureDialog')
    expect(src).toContain("t('deleted.lectureScopeNotice')")
    expect(src).toContain("t('lecture.deleteBody')")
    expect(src).toContain('course-dialog__btn--danger')
    // Cancel takes focus, not the destructive control.
    expect(src).toMatch(/onClick=\{onCancel\} disabled=\{busy\} autoFocus/)
  })

  it('every dialog string resolves in all six languages', () => {
    const keys = [
      'lecture.renameTitle', 'lecture.titleLabel',
      'lecture.moveTitle', 'lecture.moveBody', 'lecture.moveNowhere',
      'lecture.deleteTitle', 'lecture.deleteBody', 'lecture.delete',
      'deleted.lectureScopeNotice', 'deleted.unfiled',
    ] as const
    for (const locale of DESKTOP_I18N_LOCALES) {
      for (const key of keys) {
        const text = translateDesktop(locale, key)
        expect(text.length, `${locale}/${key}`).toBeGreaterThan(0)
        expect(unresolvedPlaceholders(text), `${locale}/${key}`).toEqual([])
      }
    }
  })
})

/* ── identity consistency across every surface ───────────────────────────── */

describe('course identity', () => {
  it('Record Home reads the real course fields instead of a green chip', () => {
    const recordHome = readFileSync(new URL('./RecordHome.tsx', import.meta.url), 'utf8')
    expect(recordHome).toContain('courseIdentity')
    expect(recordHome).toContain('CourseIconTile')
    expect(recordHome).not.toContain('courseInitials')
    const css = readFileSync(new URL('../styles/desktop-v2.css', import.meta.url), 'utf8')
    expect(css).not.toContain('--v2-course-green')
  })

  it('no stylesheet offers a course palette to reach for', () => {
    for (const file of ['courses-v2.css', 'recording-v2.css', 'desktop-v2-tokens.css']) {
      const css = readFileSync(new URL(`../styles/${file}`, import.meta.url), 'utf8')
      for (const preset of COURSE_PRESETS) {
        expect(css.toLowerCase(), `${file} / ${preset.id}`).not.toContain(preset.tint.toLowerCase())
        expect(css.toLowerCase(), `${file} / ${preset.id}`).not.toContain(preset.accent.toLowerCase())
      }
    }
  })

  it('resolves identity from course data, never from a hash or an index', () => {
    const model = readFileSync(new URL('../lib/courses/courseModel.ts', import.meta.url), 'utf8')
    expect(model).not.toMatch(/hash|charCodeAt|Math\.random/i)
  })
})
