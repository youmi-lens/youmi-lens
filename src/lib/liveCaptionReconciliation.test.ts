/**
 * Caption reconciliation — the duplicate-caption regression.
 *
 * Real-account QA showed one spoken sentence stacking up many times in the live
 * caption stream. `LiveCaptionSessionModel.apply` committed `en_final`
 * unconditionally:
 *
 *     committedEn = [...committedEn, { id, text }]
 *
 * with no check for an id already present, so a provider retry, a duplicated
 * frame or a reconnect replay committed the same sentence again. `zh_final` had
 * always been keyed on segment id; English had not.
 *
 * Every assertion below is about SEGMENT IDENTITY, never about text similarity.
 * The same sentence genuinely spoken twice arrives under two ids and must
 * survive twice — a text-based dedupe would delete real speech, and there is
 * none anywhere in this pipeline.
 */
import { describe, expect, it } from 'vitest'
import { LiveCaptionSessionModel } from './liveCaptionSessionModel'

const enInterim = (segmentId: string, rev: number, text: string) =>
  ({ type: 'en_interim', segmentId, rev, text }) as const
const enFinal = (segmentId: string, text: string) =>
  ({ type: 'en_final', segmentId, text }) as const
const zhFinal = (segmentId: string, text: string, sourceEn: string) =>
  ({ type: 'zh_final', segmentId, text, sourceEn }) as const
const zhInterim = (segmentId: string, rev: number, text: string, sourceEn: string) =>
  ({ type: 'zh_interim', segmentId, rev, text, sourceEn }) as const

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return count
    count += 1
    from = at + needle.length
  }
}

describe('en_final reconciliation', () => {
  it('A · a repeated identical final commits exactly once', () => {
    const m = new LiveCaptionSessionModel()
    m.apply(enFinal('seg-1', 'The midterm covers chapters four and five.'))
    const view = m.apply(enFinal('seg-1', 'The midterm covers chapters four and five.'))
    expect(occurrences(view.committedEnJoin, 'The midterm covers chapters four and five.')).toBe(1)
  })

  it('A · ten replays of the same final still commit once', () => {
    const m = new LiveCaptionSessionModel()
    let view = m.getView()
    for (let i = 0; i < 10; i++) view = m.apply(enFinal('seg-1', 'Problem set four is due Friday.'))
    expect(occurrences(view.committedEnJoin, 'Problem set four is due Friday.')).toBe(1)
  })

  it('B · cumulative interim replaces the current segment instead of stacking', () => {
    const m = new LiveCaptionSessionModel()
    m.apply(enInterim('seg-1', 1, 'I prefer'))
    m.apply(enInterim('seg-1', 2, 'I prefer to go'))
    const view = m.apply(enInterim('seg-1', 3, 'I prefer to go to the museum'))
    expect(view.primaryGray).toBe('I prefer to go to the museum')
    expect(occurrences(view.primaryGray, 'I prefer')).toBe(1)
    expect(view.committedEnJoin).toBe('')
  })

  it('C · interim then final commits once and clears the draft', () => {
    const m = new LiveCaptionSessionModel()
    m.apply(enInterim('seg-1', 1, 'I prefer to go'))
    const view = m.apply(enFinal('seg-1', 'I prefer to go to the museum.'))
    expect(view.committedEnJoin).toBe('I prefer to go to the museum.')
    expect(view.primaryGray).toBe('')
    // Never both: committed once, and not also sitting in the draft line.
    expect(occurrences(view.persistPrimaryFull, 'I prefer to go to the museum.')).toBe(1)
  })

  it('C · a late interim for an already-committed segment is ignored', () => {
    const m = new LiveCaptionSessionModel()
    m.apply(enFinal('seg-1', 'Sorting runs in n log n time.'))
    const view = m.apply(enInterim('seg-1', 9, 'Sorting runs in n log n time'))
    expect(view.primaryGray).toBe('')
    expect(occurrences(view.persistPrimaryFull, 'Sorting runs in n log n')).toBe(1)
  })

  it('D · a corrected final for the same segment REPLACES it in place', () => {
    const m = new LiveCaptionSessionModel()
    m.apply(enFinal('seg-1', 'First sentence.'))
    m.apply(enFinal('seg-2', 'Second sentence.'))
    const view = m.apply(enFinal('seg-1', 'First sentence, corrected.'))
    expect(view.committedEnJoin).toBe('First sentence, corrected. Second sentence.')
    expect(view.committedEnJoin).not.toContain('First sentence. ')
  })

  it('D · the SAME sentence spoken again later is kept — it has its own segment', () => {
    const m = new LiveCaptionSessionModel()
    m.apply(enFinal('seg-1', 'This will be on the exam.'))
    m.apply(enFinal('seg-2', 'Now, about the reading.'))
    const view = m.apply(enFinal('seg-3', 'This will be on the exam.'))
    // Genuine repetition, preserved. This is the case a text dedupe would eat.
    expect(occurrences(view.committedEnJoin, 'This will be on the exam.')).toBe(2)
  })

  it('E · a translation retry does not duplicate the source', () => {
    const m = new LiveCaptionSessionModel()
    m.apply(enFinal('seg-1', 'The exam is next week.'))
    m.apply(zhFinal('seg-1', '考试在下周。', 'The exam is next week.'))
    const view = m.apply(zhFinal('seg-1', '考试在下周。', 'The exam is next week.'))
    expect(occurrences(view.committedEnJoin, 'The exam is next week.')).toBe(1)
    expect(occurrences(view.secondaryBlack, '考试在下周。')).toBe(1)
  })

  it('E · a late translation attaches to its own finalized segment', () => {
    const m = new LiveCaptionSessionModel()
    m.apply(enFinal('seg-1', 'One.'))
    m.apply(enFinal('seg-2', 'Two.'))
    m.apply(zhFinal('seg-2', '二。', 'Two.'))
    const view = m.apply(zhFinal('seg-1', '一。', 'One.'))
    // Out of order in, still paired correctly out.
    expect(view.secondaryBlack).toContain('二。')
    expect(view.secondaryBlack).toContain('一。')
    expect(occurrences(view.secondaryBlack, '一。')).toBe(1)
  })

  it('E · a translation interim for a finalized segment is ignored', () => {
    const m = new LiveCaptionSessionModel()
    m.apply(enFinal('seg-1', 'Ready.'))
    m.apply(zhFinal('seg-1', '好了。', 'Ready.'))
    const view = m.apply(zhInterim('seg-1', 4, '好了', 'Ready.'))
    expect(occurrences(view.persistSecondaryFull, '好了')).toBe(1)
  })

  it('F · a reconnect replaying the whole session commits nothing twice', () => {
    const m = new LiveCaptionSessionModel()
    const session = [
      enFinal('seg-1', 'Welcome back.'),
      enFinal('seg-2', 'Today we cover graphs.'),
      enFinal('seg-3', 'Start with adjacency lists.'),
    ]
    for (const ev of session) m.apply(ev)
    const before = m.getView().committedEnJoin
    // The provider replays the session after reconnecting.
    for (const ev of session) m.apply(ev)
    expect(m.getView().committedEnJoin).toBe(before)
  })

  it('F · a replay followed by new speech keeps transcript order', () => {
    const m = new LiveCaptionSessionModel()
    m.apply(enFinal('seg-1', 'One.'))
    m.apply(enFinal('seg-2', 'Two.'))
    m.apply(enFinal('seg-1', 'One.'))
    const view = m.apply(enFinal('seg-3', 'Three.'))
    expect(view.committedEnJoin).toBe('One. Two. Three.')
  })

  it('punctuation-only differences are treated as a correction, not a new line', () => {
    const m = new LiveCaptionSessionModel()
    m.apply(enFinal('seg-1', 'Is that clear'))
    const view = m.apply(enFinal('seg-1', 'Is that clear?'))
    expect(view.committedEnJoin).toBe('Is that clear?')
    expect(occurrences(view.committedEnJoin, 'Is that clear')).toBe(1)
  })

  it('a stale final for an unknown old segment is still rejected', () => {
    const m = new LiveCaptionSessionModel()
    m.apply(enFinal('seg-5', 'Current utterance.'))
    const view = m.apply(enFinal('seg-2', 'Very late arrival from a dead segment.'))
    expect(view.committedEnJoin).toBe('Current utterance.')
  })

  it('empty and whitespace-only payloads never create a segment', () => {
    const m = new LiveCaptionSessionModel()
    m.apply(enFinal('seg-1', '   '))
    const view = m.apply(enFinal('seg-2', ''))
    expect(view.committedEnJoin).toBe('')
  })

  it('a long lecture of distinct segments keeps every one', () => {
    const m = new LiveCaptionSessionModel()
    let view = m.getView()
    for (let i = 0; i < 40; i++) view = m.apply(enFinal(`seg-${i}`, `Sentence ${i}.`))
    for (let i = 0; i < 40; i++) expect(view.committedEnJoin).toContain(`Sentence ${i}.`)
  })
})
