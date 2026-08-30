import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CoursesPage } from './CoursesPage'
import type { Course } from '../lib/courses/courseModel'
import type { CoursesCapabilities } from '../lib/courses/coursesRepository'
import { translateDesktop } from '../lib/desktopI18n'

const t = (key: Parameters<typeof translateDesktop>[1], vars?: Record<string, string | number>) =>
  translateDesktop('en', key, vars)

const capabilities: CoursesCapabilities = {
  canCreate: true,
  canRename: true,
  canDelete: true,
  canRestore: true,
  canPurge: true,
  persistsIdentity: true,
}

function course(over: Partial<Course> = {}): Course {
  return {
    id: 'c1',
    userId: 'u1',
    name: 'CS 250',
    icon: 'create-outline',
    tint: '#eee',
    accent: '#333',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    deletionUpdatedAt: null,
    ...over,
  }
}

const baseProps = {
  t,
  recordings: [],
  capabilities,
  lectureStatus: () => 'Ready' as const,
  formatDuration: (s: number) => `${s}s`,
  onOpenCourse: () => undefined,
  onOpenLecture: () => undefined,
  onNewCourse: () => undefined,
  onRenameCourse: () => undefined,
  onDeleteCourse: () => undefined,
  recentlyDeletedCount: 0,
  onOpenRecentlyDeleted: () => undefined,
}

function render(courses: Course[], extra: Partial<Parameters<typeof CoursesPage>[0]> = {}): string {
  return renderToStaticMarkup(createElement(CoursesPage, { ...baseProps, courses, ...extra }))
}

describe('CoursesPage loading / error / empty are distinct', () => {
  it('loading (with no data yet) shows the loading copy, not the empty-state copy', () => {
    const html = render([], { loading: true })
    expect(html).toContain('Loading courses')
    expect(html).not.toContain('No courses yet')
    expect(html).not.toContain('New course')
  })

  it('fetch error shows the error copy and a Retry action, not the empty-state copy', () => {
    const onRetry = vi.fn()
    const html = render([], { error: 'boom from the database', onRetry })
    expect(html).toContain('Couldn’t load your courses')
    expect(html).toContain('Try again')
    expect(html).not.toContain('No courses yet')
    // The raw error string is deliberately never shown to the user.
    expect(html).not.toContain('boom from the database')
  })

  it('a genuinely empty account (loading finished, no error) still shows the real empty state', () => {
    const html = render([], { loading: false, error: null })
    expect(html).toContain('No courses yet')
    expect(html).toContain('New course')
  })

  it('loading takes precedence over a stale error from a previous failed attempt', () => {
    const html = render([], { loading: true, error: 'previous failure' })
    expect(html).toContain('Loading courses')
    expect(html).not.toContain('previous failure')
  })

  it('data renders the grid regardless of loading/error props (both false/null)', () => {
    const html = render([course()], { loading: false, error: null })
    expect(html).toContain('CS 250')
    expect(html).not.toContain('Loading courses')
    expect(html).not.toContain('No courses yet')
  })
})
