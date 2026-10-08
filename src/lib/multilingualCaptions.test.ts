import { describe, expect, it } from 'vitest'
import { compactTranslationSnapshot } from './liveCaptionCompaction'
import { deOverlapCjk, deOverlapForLanguage } from './liveCaptionDeOverlap'
import { LiveCaptionSessionModel } from './liveCaptionSessionModel'
import { normalizePrimaryPayloadOrReject, sanitizeSourceForTranslate } from './liveCaptionSanitize'

describe('live captions follow the SPOKEN language', () => {
  it('a Chinese / Japanese / Korean caption is accepted as-is (the English validator rejected all of it)', () => {
    for (const [text, lang] of [
      ['今天我们讲排序算法', 'zh-Hans'],
      ['今日はソートについて話します', 'ja'],
      ['오늘은 정렬을 배웁니다', 'ko'],
    ] as const) {
      expect(normalizePrimaryPayloadOrReject(text, lang)).toBe(text)
    }
  })

  it('English keeps EXACTLY the old behaviour: CJK-contaminated primary text is cleaned or rejected', () => {
    expect(normalizePrimaryPayloadOrReject('Hello everyone', 'en')).toBe('Hello everyone')
    expect(normalizePrimaryPayloadOrReject('今天', 'en')).toBeNull()
  })

  it('French is Latin-script and takes the same validation path as English', () => {
    expect(normalizePrimaryPayloadOrReject('Bonjour à tous', 'fr')).toBe('Bonjour à tous')
  })

  it('translation input is the source text as spoken, whatever the script', () => {
    expect(sanitizeSourceForTranslate('  今天  我们讲排序 ', 'zh-Hans')).toBe('今天 我们讲排序')
    expect(sanitizeSourceForTranslate('Hello  world', 'en')).toBe('Hello world')
  })
})

describe('CJK de-overlap (no whitespace tokens to anchor on)', () => {
  it('drops the repeated head of an incoming final and keeps only what is new', () => {
    const committed = '今天我们讲排序算法首先是冒泡排序'
    const r = deOverlapCjk(committed, '首先是冒泡排序然后是快速排序')
    expect(r.novelText).toBe('然后是快速排序')
  })

  it('an overlap shorter than the minimum anchor is NOT cut (a short run of characters repeats by chance in Chinese)', () => {
    expect(deOverlapCjk('今天我们讲排序', '我们讲排序然后').novelText).toBe('我们讲排序然后')
  })

  it('an unrelated incoming sentence is kept whole', () => {
    expect(deOverlapCjk('今天我们讲排序', '明天讨论图论').novelText).toBe('明天讨论图论')
  })

  it('routes by script: latin → word de-overlap, cjk → character de-overlap', () => {
    expect(deOverlapForLanguage('今天我们讲排序算法', '我们讲排序算法然后', 'cjk').novelText).toBe('然后')
    expect(deOverlapForLanguage('we will start with sorting', 'start with sorting and then', 'latin').novelText).toBe('and then')
  })
})

describe('translation text is cleaned for the language it is WRITTEN in', () => {
  it('an English translation keeps the space after a full stop (Chinese compaction glued sentences together)', () => {
    const t = 'The lecture covers sorting algorithms. Then we discuss quicksort and mergesort in detail.'
    expect(compactTranslationSnapshot(t, 'latin')).toBe(t)
  })

  it('a Chinese translation still uses the Chinese compaction', () => {
    const t = '今天我们讲排序。今天我们讲排序。然后讲快速排序和归并排序。'
    expect(compactTranslationSnapshot(t, 'cjk')).not.toBe(t)
  })
})

describe('session model routing — source and translation languages are independent', () => {
  const seg = (n: number) => `live-${n}`

  it('Chinese → English: Chinese primary is shown, English translation is shown, spacing intact', () => {
    const m = new LiveCaptionSessionModel()
    m.setSourceLanguage('zh-Hans')
    m.setTranslationLanguage('en')
    m.apply({ type: 'en_interim', segmentId: seg(1), rev: 1, text: '今天我们讲排序' })
    m.apply({ type: 'en_final', segmentId: seg(1), text: '今天我们讲排序' })
    m.apply({
      type: 'zh_final',
      segmentId: seg(1),
      text: 'Today we cover sorting. Then quicksort.',
      sourceEn: '今天我们讲排序',
    })
    const v = m.getView()
    expect(v.persistPrimaryFull).toContain('今天我们讲排序')
    expect(v.persistSecondaryFull).toBe('Today we cover sorting. Then quicksort.')
  })

  it('an English translation that quotes a Chinese name is not discarded as "garbled"', () => {
    const m = new LiveCaptionSessionModel()
    m.setSourceLanguage('zh-Hans')
    m.setTranslationLanguage('en')
    m.apply({ type: 'en_final', segmentId: seg(1), text: '李教授说了你好' })
    m.apply({ type: 'zh_final', segmentId: seg(1), text: 'Professor 李 said hello', sourceEn: '李教授说了你好' })
    expect(m.getView().persistSecondaryFull).toContain('Professor')
  })

  it('English → Chinese keeps the original guard: a Latin-garbled Chinese line is dropped', () => {
    const m = new LiveCaptionSessionModel()
    m.setSourceLanguage('en')
    m.setTranslationLanguage('zh-Hans')
    m.apply({ type: 'en_final', segmentId: seg(1), text: 'Hello everyone' })
    m.apply({ type: 'zh_final', segmentId: seg(1), text: '大家 hello world 你好', sourceEn: 'Hello everyone' })
    expect(m.getView().persistSecondaryFull).toBe('')
  })

  it('English → Chinese still works end to end (the unchanged default path)', () => {
    const m = new LiveCaptionSessionModel()
    m.setSourceLanguage('en')
    m.setTranslationLanguage('zh-Hans')
    m.apply({ type: 'en_final', segmentId: seg(1), text: 'Hello everyone' })
    m.apply({ type: 'zh_final', segmentId: seg(1), text: '大家好', sourceEn: 'Hello everyone' })
    const v = m.getView()
    expect(v.persistPrimaryFull).toBe('Hello everyone')
    expect(v.persistSecondaryFull).toBe('大家好')
  })

  it('Original only: no translation events arrive, and the primary still works', () => {
    const m = new LiveCaptionSessionModel()
    m.setSourceLanguage('en')
    m.setTranslationLanguage('en')
    m.apply({ type: 'en_final', segmentId: seg(1), text: 'Hello everyone' })
    const v = m.getView()
    expect(v.persistPrimaryFull).toBe('Hello everyone')
    expect(v.persistSecondaryFull).toBe('')
  })
})

describe('engine translation payload guard follows the target language', () => {
  it('into English: a line with a Chinese proper noun is kept; a line handed back untranslated is refused', async () => {
    const { normalizeZhPayloadOrReject } = await import('./liveCaptionSanitize')
    expect(normalizeZhPayloadOrReject('Professor 李 said hello to the class', 'en')).toBe('Professor 李 said hello to the class')
    expect(normalizeZhPayloadOrReject('今天我们讲排序算法', 'en')).toBeNull()
    expect(normalizeZhPayloadOrReject('Today we cover sorting.', 'en')).toBe('Today we cover sorting.')
  })

  it('into Chinese: the original guards are unchanged', async () => {
    const { normalizeZhPayloadOrReject } = await import('./liveCaptionSanitize')
    expect(normalizeZhPayloadOrReject('大家好', 'zh')).toBe('大家好')
    expect(normalizeZhPayloadOrReject('大家 hello world 你好', 'zh')).toBeNull()
    expect(normalizeZhPayloadOrReject('This is clearly English text only', 'zh')).toBeNull()
    expect(normalizeZhPayloadOrReject('auth_required', 'zh')).toBeNull()
  })
})
