import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RecentlyDeletedPage } from './RecentlyDeletedPage'
import type { Course } from '../lib/courses/courseModel'
import type { DeletedLecture } from '../lib/courses/deletedItems'
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

function deletedCourse(over: Partial<Course> = {}): Course {
  return {
    id: 'c1',
    userId: 'u1',
    name: 'CS 250',
    icon: 'create-outline',
    tint: '#eee',
    accent: '#333',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: 1000,
    deletionUpdatedAt: 1000,
    ...over,
  }
}

const deletedLecture: DeletedLecture = {
  id: 'l1',
  title: 'Lecture 1',
  courseName: 'CS 250',
  deletedAt: 1000,
}

const baseProps = {
  t,
  activeCourses: [],
  capabilities,
  formatDate: (ms: number) => new Date(ms).toISOString(),
  onBack: () => undefined,
  onRestoreCourse: () => undefined,
  onPurgeCourse: () => undefined,
  onRestoreLecture: () => undefined,
  onPurgeLecture: () => undefined,
}

function render(
  deletedCourses: Course[],
  deletedLectures: DeletedLecture[],
  extra: Partial<Parameters<typeof RecentlyDeletedPage>[0]> = {},
): string {
  return renderToStaticMarkup(
    createElement(RecentlyDeletedPage, { ...baseProps, deletedCourses, deletedLectures, busy: false, ...extra }),
  )
}

describe('RecentlyDeletedPage loading / error / empty are distinct', () => {
  it('loading shows the loading copy even when the lists happen to be empty', () => {
    const html = render([], [], { loading: true })
    expect(html).toContain('Loading Recently Deleted')
    expect(html).not.toContain('Nothing here')
  })

  it('fetch error shows the error copy and Retry, not the empty-state copy', () => {
    const onRetry = vi.fn()
    const html = render([], [], { error: 'raw backend failure', onRetry })
    expect(html).toContain('Couldn’t load Recently Deleted')
    expect(html).toContain('Try again')
    expect(html).not.toContain('Nothing here')
    expect(html).not.toContain('raw backend failure')
  })

  it('a genuinely empty bin (loaded, no error) still shows the real empty state', () => {
    const html = render([], [], { loading: false, error: null })
    expect(html).toContain('Nothing here')
  })
})

describe('RecentlyDeletedPage restore failure feedback', () => {
  it('shows a safe, translated restoreError banner without the raw backend message', () => {
    const html = render([deletedCourse()], [], { restoreError: t('deleted.restoreFailed') })
    expect(html).toContain('Couldn’t restore. Please try again.')
  })

  it('shows no restoreError banner when nothing has failed', () => {
    const html = render([deletedCourse()], [], { restoreError: null })
    expect(html).not.toContain('Couldn’t restore')
  })

  it('the deleted item stays visible alongside a restore-failure banner (no optimistic removal)', () => {
    const html = render([deletedCourse()], [deletedLecture], { restoreError: t('deleted.restoreFailed') })
    expect(html).toContain('CS 250')
    expect(html).toContain('Lecture 1')
    expect(html).toContain('Couldn’t restore')
  })
})

describe('RecentlyDeletedPage guards repeated Restore while a mutation is in flight', () => {
  it('disables every Restore/Purge control while busy', () => {
    const html = render([deletedCourse()], [deletedLecture], { busy: true })
    // Both the course row's Restore/Purge and the lecture row's Restore/Purge
    // must be disabled — a page-wide guard is sufficient because it blocks a
    // second click on the SAME item just as much as any other item.
    const disabledCount = (html.match(/disabled=""/g) ?? []).length
    expect(disabledCount).toBeGreaterThanOrEqual(4)
  })

  it('controls are enabled again once busy clears', () => {
    const html = render([deletedCourse()], [deletedLecture], { busy: false })
    expect(html).not.toContain('disabled=""')
  })
})
