import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LectureDetailPage } from './LectureDetailPage'
import type { Recording, RecordingDetail } from '../types'
import { translateDesktop } from '../lib/desktopI18n'

const t = (key: Parameters<typeof translateDesktop>[1], vars?: Record<string, string | number>) =>
  translateDesktop('en', key, vars)

const recording: Recording = {
  id: 'r1',
  course: 'CS 250',
  title: 'Lecture 1',
  createdAt: 0,
  durationSec: 600,
  mime: 'audio/webm',
  storagePath: 'u1/r1.webm',
}

const baseProps = {
  t,
  recording,
  course: null,
  audioUrl: null,
  languageLine: 'English → Chinese',
  formatDate: (ms: number) => new Date(ms).toISOString(),
  formatDuration: (s: number) => `${s}s`,
  onBack: () => undefined,
  backLabel: 'Courses',
  onRename: () => undefined,
  onMove: () => undefined,
  onDelete: () => undefined,
  actionsDisabled: false,
  onSaveNotes: async () => undefined,
  onAddMark: async () => undefined,
  annotationsEditable: true,
}

function render(
  detail: RecordingDetail | null,
  extra: Partial<Parameters<typeof LectureDetailPage>[0]> = {},
): string {
  return renderToStaticMarkup(createElement(LectureDetailPage, { ...baseProps, detail, ...extra }))
}

describe('LectureDetailPage distinguishes fetch failure from genuinely absent content', () => {
  it('a fetch failure shows a real error, not "No summary yet"', () => {
    const html = render(null, { detailLoadFailed: true })
    expect(html).toContain('Couldn’t load this content')
    expect(html).toContain('Your recording is safe')
    expect(html).not.toContain('No summary yet')
    expect(html).toContain('Try again')
  })

  // A lecture the server finished with nothing to show (e.g. silent audio): there
  // is no job left, so the tabs and their honest empty copy are the right body.
  const finishedEmpty: Recording = { ...recording, aiStatus: 'done' }

  it('a lecture that genuinely has no summary yet still shows the existing not-generated copy', () => {
    const html = render(null, { recording: finishedEmpty, detailLoadFailed: false })
    expect(html).toContain('No summary yet')
    expect(html).not.toContain('Couldn’t load this content')
  })

  it('recovers to normal empty-state rendering once detailLoadFailed clears (successful retry)', () => {
    const failed = render(null, { detailLoadFailed: true })
    const recovered = render(null, { recording: finishedEmpty, detailLoadFailed: false })
    expect(failed).toContain('Couldn’t load this content')
    expect(recovered).not.toContain('Couldn’t load this content')
    expect(recovered).toContain('No summary yet')
  })

  it('a fetch failure never hides the lecture header — title and course context stay visible', () => {
    const html = render(null, { detailLoadFailed: true })
    expect(html).toContain('Lecture 1')
  })

  it('successfully loaded content with a real summary renders normally regardless of detailLoadFailed', () => {
    const detail: RecordingDetail = {
      ...recording,
      aiStatus: 'done',
      transcript: 'The lecture covered gradients.',
      summaryEn: '## Overview\nThe lecture covered gradients.',
      storagePath: 'u1/r1.webm',
    }
    // Persisted outputs win: even a failed row fetch must not hide a finished result.
    const html = render(detail, { detailLoadFailed: true })
    expect(html).toContain('Overview')
    expect(html).not.toContain('Couldn’t load this content')
    expect(html).not.toContain('No summary yet')
  })
})

/**
 * Owner QA blocker: after Save Lecture started working, opening the saved
 * lecture left the audio section on "Loading audio…" forever, with no error
 * and no Retry. Root cause: the row-select fetch (`getRecordingDetail`) had
 * no timeout guard (unlike the signed-URL fetch beside it), and even when it
 * DID fail, the player block only reacted to `audioError` — never to
 * `detailLoadFailed` — so a failed/never-settling row fetch left the audio
 * area with no terminal state at all. See the paired fix in App.tsx (the
 * row fetch is now wrapped in the same `withTimeout` as the signed-URL
 * fetch).
 */
describe('the audio section always reaches a truthful terminal state', () => {
  it('shows "Loading audio…" only while nothing has failed yet', () => {
    const html = render(null, { audioUrl: null, audioError: null, detailLoadFailed: false })
    expect(html).toContain('Loading audio')
  })

  it('a signed-URL failure (row loaded fine) shows the unavailable state with Retry', () => {
    const detail: RecordingDetail = { ...recording, storagePath: 'u1/r1.webm' }
    const html = render(detail, { audioUrl: null, audioError: 'boom', detailLoadFailed: false })
    expect(html).not.toContain('Loading audio')
    expect(html).toContain('not available')
    expect(html).toContain('Try again')
  })

  it('a failed/timed-out row fetch ALSO leaves the audio section, not stuck on Loading', () => {
    // This is the exact bug: detailLoadFailed used to be invisible to the
    // player block, so this case rendered "Loading audio…" with no escape.
    const html = render(null, { audioUrl: null, audioError: null, detailLoadFailed: true })
    expect(html).not.toContain('Loading audio')
    expect(html).toContain('not available')
    expect(html).toContain('Try again')
  })

  it('a resolved audioUrl renders the player, not the loading/error note', () => {
    const detail: RecordingDetail = { ...recording, storagePath: 'u1/r1.webm' }
    const html = render(detail, { audioUrl: 'https://example.com/signed.webm', detailLoadFailed: false })
    expect(html).not.toContain('Loading audio')
    expect(html).not.toContain('not available')
  })
})

/**
 * Production incident 2026-10-04 — lecture 4e606f1d…: 2:17 of audio saved,
 * ai_status='pending', transcript NULL, summary NULL. The page read
 * "Ready / No summary yet / A summary is written once the transcript is ready"
 * while nothing was ever going to process it.
 */
describe('LectureDetailPage never says Ready over missing outputs (2026-10-04 incident)', () => {
  const pendingDetail: RecordingDetail = {
    ...recording,
    aiStatus: 'pending',
    transcript: null,
    summaryEn: null,
    summaryZh: null,
  }

  function badge(html: string): string {
    return html.match(/<span class="v2-badge" data-status="([^"]+)">([^<]*)</)?.slice(1, 3).join('|') ?? ''
  }

  it('shows Processing — not Ready — for saved audio whose hosted AI is still pending', () => {
    const html = render(pendingDetail)
    expect(badge(html)).toBe('processing|Processing')
    expect(html).not.toContain('data-status="ready"')
  })

  it('says the transcript is being made, instead of the stale "written once the transcript is ready"', () => {
    const html = render(pendingDetail)
    expect(html).not.toContain('A summary is written once the transcript is ready.')
  })

  it('shows Ready only once the transcript and a summary exist', () => {
    const html = render({
      ...pendingDetail,
      aiStatus: 'done',
      transcript: 'The lecture began.',
      summaryEn: '## Overview\nGradients.',
    })
    expect(badge(html)).toBe('ready|Ready')
  })

  it('shows an explicit, retryable failure when processing could not be started', () => {
    const html = render(pendingDetail, { processingFailed: true })
    expect(badge(html)).toBe('failed|Processing failed')
    expect(html).toContain('Your recording is safe. The transcript and summary couldn’t be generated.')
    expect(html).toContain('Try again')
    expect(html).not.toContain('data-status="ready"')
  })

  it('shows the same failure for a job the server marked failed', () => {
    const html = render({ ...pendingDetail, aiStatus: 'failed' })
    expect(badge(html)).toBe('failed|Processing failed')
    expect(html).toContain('Try again')
  })

  it('keeps the audio player available while processing or failed — audio durability is independent of AI', () => {
    for (const extra of [{}, { processingFailed: true }]) {
      const html = render(pendingDetail, { audioUrl: 'blob:audio', ...extra })
      expect(html).toContain('<audio')
    }
  })

  it('does not apply to local-only / own-key lectures, where audio is the whole product', () => {
    const html = render(pendingDetail, { aiExpected: false })
    expect(badge(html)).toBe('ready|Ready')
  })

  it('in flight states are Processing, never Ready', () => {
    for (const aiStatus of ['queued', 'transcribing', 'summarizing'] as const) {
      expect(badge(render({ ...pendingDetail, aiStatus }))).toBe('processing|Processing')
    }
  })
})
