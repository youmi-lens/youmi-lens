import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CourseDetailPage } from './CourseDetailPage'
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

const course: Course = {
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
}

const baseProps = {
  t,
  course,
  courses: [course],
  capabilities,
  lectureStatus: () => 'Ready' as const,
  formatDuration: (s: number) => `${s}s`,
  formatDate: (ms: number) => new Date(ms).toISOString(),
  onBack: () => undefined,
  onStartLecture: () => undefined,
  onOpenLecture: () => undefined,
  onRenameCourse: () => undefined,
  onDeleteCourse: () => undefined,
}

function render(recordings: Parameters<typeof CourseDetailPage>[0]['recordings'], extra: Partial<Parameters<typeof CourseDetailPage>[0]> = {}): string {
  return renderToStaticMarkup(createElement(CourseDetailPage, { ...baseProps, recordings, ...extra }))
}

describe('CourseDetailPage loading / error / empty are distinct', () => {
  it('loading shows the loading copy, not "no lectures in this course"', () => {
    const html = render([], { loading: true })
    expect(html).toContain('Loading this course')
    expect(html).not.toContain('No lectures in this course')
  })

  it('fetch error shows the error copy and Retry, not the empty-state copy', () => {
    const onRetry = vi.fn()
    const html = render([], { error: 'raw backend failure', onRetry })
    expect(html).toContain('Couldn’t load this course')
    expect(html).toContain('Try again')
    expect(html).not.toContain('No lectures in this course')
    expect(html).not.toContain('raw backend failure')
  })

  it('a genuinely empty course (loaded, no error) still shows the real empty state', () => {
    const html = render([], { loading: false, error: null })
    expect(html).toContain('No lectures in this course')
  })

  it('the course hero stays visible even while the lecture list is loading', () => {
    const html = render([], { loading: true })
    expect(html).toContain('CS 250')
  })
})
