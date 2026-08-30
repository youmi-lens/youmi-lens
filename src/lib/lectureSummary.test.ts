/**
 * Lecture summary / transcript parsing.
 *
 * The production summary really is structured: `server/ai/summarizePrompt.mjs`
 * asks for markdown with `## Outline` / `## Key terms` / `## Takeaways` and the
 * Chinese `## 大纲` / `## 关键术语` / `## 要点`. These tests pin that the parser
 * reads the document rather than assuming a fixed set of section names, and
 * that anything unstructured survives intact instead of being invented into
 * three buckets.
 */
import { describe, expect, it } from 'vitest'
import {
  lectureReadiness,
  parseLectureSummary,
  transcriptHasTimestamps,
  transcriptParagraphs,
} from './lectureSummary'

const EN = `## Outline
The lecture covered sorting.

## Key terms
Quicksort, mergesort.

## Takeaways
Know the complexities.`

const ZH = `## 大纲
本讲介绍了排序。

## 关键术语
快速排序、归并排序。

## 要点
记住复杂度。`

describe('summary parsing', () => {
  it('reads the real English section headings', () => {
    const parsed = parseLectureSummary(EN)!
    expect(parsed.structured).toBe(true)
    expect(parsed.sections.map((s) => s.title)).toEqual(['Outline', 'Key terms', 'Takeaways'])
    expect(parsed.sections[1].body).toBe('Quicksort, mergesort.')
  })

  it('reads the real Chinese section headings', () => {
    const parsed = parseLectureSummary(ZH)!
    expect(parsed.structured).toBe(true)
    // The headings the prompt actually asks for — 大纲, not an assumed 摘要.
    expect(parsed.sections.map((s) => s.title)).toEqual(['大纲', '关键术语', '要点'])
  })

  it('uses the document\'s own heading text, not a hardcoded list', () => {
    // A model that answers "Key Terms" or translates a heading still renders
    // what it said. Relabelling would put words in its mouth.
    const parsed = parseLectureSummary('## Key Terms\nA\n\n## Summary of points\nB')!
    expect(parsed.sections.map((s) => s.title)).toEqual(['Key Terms', 'Summary of points'])
  })

  it('returns free text whole, as ONE unlabelled section', () => {
    const parsed = parseLectureSummary('Just a paragraph of prose with no headings at all.')!
    expect(parsed.structured).toBe(false)
    expect(parsed.sections).toHaveLength(1)
    expect(parsed.sections[0].title).toBeNull()
    expect(parsed.sections[0].body).toContain('no headings at all')
  })

  it('never invents sections from free text', () => {
    const parsed = parseLectureSummary('One. Two. Three. Four. Five.')!
    expect(parsed.sections).toHaveLength(1)
    expect(parsed.structured).toBe(false)
  })

  it('is lossless: every word of the input survives', () => {
    const parsed = parseLectureSummary(EN)!
    const joined = parsed.sections.map((s) => `${s.title}\n${s.body}`).join('\n')
    for (const word of ['sorting', 'Quicksort', 'mergesort', 'complexities']) {
      expect(joined).toContain(word)
    }
  })

  it('keeps preamble text that appears before the first heading', () => {
    const parsed = parseLectureSummary('A note first.\n\n## Outline\nBody.')!
    expect(parsed.sections[0].title).toBeNull()
    expect(parsed.sections[0].body).toBe('A note first.')
    expect(parsed.sections[1].title).toBe('Outline')
  })

  it('accepts # and ### as headings too', () => {
    const parsed = parseLectureSummary('# One\nA\n### Two\nB')!
    expect(parsed.sections.map((s) => s.title)).toEqual(['One', 'Two'])
  })

  it('returns null for empty or whitespace-only summaries', () => {
    expect(parseLectureSummary(null)).toBeNull()
    expect(parseLectureSummary(undefined)).toBeNull()
    expect(parseLectureSummary('   \n  ')).toBeNull()
  })

  it('tolerates a heading with no body', () => {
    const parsed = parseLectureSummary('## Outline\n\n## Takeaways\nSomething.')!
    expect(parsed.sections.map((s) => s.title)).toEqual(['Outline', 'Takeaways'])
    expect(parsed.sections[0].body).toBe('')
  })
})

/* ── Required fixtures ──────────────────────────────────────────────────────
   One case per shape the production data can actually take. Each asserts what
   the UI will show, so a parser change that starts inventing or dropping
   sections fails here rather than in front of a student. */

describe('summary fixtures', () => {
  it('fixture: fully structured English', () => {
    const p = parseLectureSummary(EN)!
    expect(p.structured).toBe(true)
    expect(p.sections).toHaveLength(3)
    expect(p.sections.map((s) => s.title)).toEqual(['Outline', 'Key terms', 'Takeaways'])
    expect(p.sections.every((s) => s.body.length > 0)).toBe(true)
  })

  it('fixture: fully structured Chinese, with 大纲 kept as written', () => {
    const p = parseLectureSummary(ZH)!
    expect(p.sections[0].title).toBe('大纲')
    // Never relabelled to 摘要 — the model did not say that.
    expect(p.sections.map((s) => s.title)).not.toContain('摘要')
  })

  it('fixture: a section is missing', () => {
    const p = parseLectureSummary('## Outline\nA.\n\n## Takeaways\nB.')!
    expect(p.structured).toBe(true)
    expect(p.sections.map((s) => s.title)).toEqual(['Outline', 'Takeaways'])
    // No empty "Key terms" is conjured to fill the gap.
    expect(p.sections).toHaveLength(2)
  })

  it('fixture: a different but valid heading order', () => {
    const p = parseLectureSummary('## Takeaways\nA.\n\n## Outline\nB.\n\n## Key terms\nC.')!
    // Document order is preserved; the parser does not re-sort into a canon.
    expect(p.sections.map((s) => s.title)).toEqual(['Takeaways', 'Outline', 'Key terms'])
  })

  it('fixture: unstructured legacy summary', () => {
    const legacy =
      'The lecture reviewed sorting algorithms and their complexities, then moved on to graphs.'
    const p = parseLectureSummary(legacy)!
    expect(p.structured).toBe(false)
    expect(p.sections).toHaveLength(1)
    expect(p.sections[0].title).toBeNull()
    expect(p.sections[0].body).toBe(legacy)
  })

  it('fixture: empty summary', () => {
    expect(parseLectureSummary('')).toBeNull()
    expect(parseLectureSummary('\n\n   \n')).toBeNull()
  })

  it('fixture: malformed markdown survives without loss', () => {
    // A stray fence, an unclosed emphasis, a `#` with no space: none of this is
    // a heading, so it all stays in the body rather than vanishing.
    const malformed = '```\n## Not a heading inside a fence\n#NoSpace\n**unclosed'
    const p = parseLectureSummary(malformed)!
    expect(p.sections.map((s) => s.body).join('\n')).toContain('#NoSpace')
    expect(p.sections.map((s) => s.body).join('\n')).toContain('**unclosed')
  })

  it('fixture: heading-only document keeps every heading', () => {
    const p = parseLectureSummary('## Outline\n## Key terms\n## Takeaways')!
    expect(p.sections.map((s) => s.title)).toEqual(['Outline', 'Key terms', 'Takeaways'])
    expect(p.sections.every((s) => s.body === '')).toBe(true)
  })

  it('no fixture ever produces a section the source did not contain', () => {
    for (const src of [EN, ZH, 'Plain prose.', '## Only one\nBody.', '']) {
      const p = parseLectureSummary(src)
      if (!p) continue
      for (const section of p.sections) {
        if (section.title) expect(src).toContain(section.title)
      }
    }
  })
})

describe('transcript', () => {
  it('splits on blank lines and keeps the text intact', () => {
    expect(transcriptParagraphs('One line.\n\nSecond block.')).toEqual([
      'One line.',
      'Second block.',
    ])
  })

  it('returns a single paragraph for continuous prose', () => {
    expect(transcriptParagraphs('A long single run of speech with no breaks')).toHaveLength(1)
  })

  it('is empty for no transcript', () => {
    expect(transcriptParagraphs(null)).toEqual([])
    expect(transcriptParagraphs('  ')).toEqual([])
  })

  it('reports that the stored transcript has no timestamps', () => {
    // `updateRecordingAi` writes one plain string. There is nothing to seek to,
    // so the UI must not render clickable times.
    expect(transcriptHasTimestamps('The lecture began with a review.')).toBe(false)
    expect(transcriptHasTimestamps('[00:12] The lecture began.')).toBe(true)
    expect(transcriptHasTimestamps(null)).toBe(false)
  })
})

describe('readiness', () => {
  it('is ready only when transcript AND a summary exist', () => {
    expect(lectureReadiness({ transcript: 'x', summaryEn: 'y' })).toBe('ready')
    expect(lectureReadiness({ transcript: 'x', summaryZh: 'y' })).toBe('ready')
  })

  it('reports transcript-only honestly', () => {
    expect(lectureReadiness({ transcript: 'x', aiStatus: 'transcript_ready' })).toBe('transcript_only')
  })

  it('reports a failed AI job', () => {
    expect(lectureReadiness({ aiStatus: 'failed', transcript: 'x', summaryEn: 'y' })).toBe('failed')
  })

  it('treats persisted audio as ready even while AI is pending or failed', () => {
    expect(lectureReadiness({ hasAudio: true, aiStatus: 'pending' })).toBe('ready')
    expect(lectureReadiness({ hasAudio: true, aiStatus: 'failed' })).toBe('ready')
  })

  it('reports processing while a job is in flight', () => {
    expect(lectureReadiness({ aiStatus: 'queued' })).toBe('processing')
    expect(lectureReadiness({ aiStatus: 'summarizing' })).toBe('processing')
  })

  it('reports nothing processed for a bare recording', () => {
    expect(lectureReadiness({})).toBe('none')
    expect(lectureReadiness({ aiStatus: 'pending' })).toBe('processing')
  })
})
