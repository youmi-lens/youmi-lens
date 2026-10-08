import { describe, expect, it } from 'vitest'
import { DEFAULT_LANGUAGE_PREFERENCES, type LanguagePreferences } from './languagePreferences'
import {
  LEGACY_LECTURE_LANGUAGES,
  ORIGINAL_ONLY,
  applyTranslateTo,
  defaultSummaryKind,
  initialSummaryKind,
  isTranslationEnabled,
  lectureLanguagesFromRow,
  lectureSummariesFor,
  liveTranslateRouteTarget,
  resolveLectureLanguages,
  translateToValue,
} from './lectureLanguages'

const prefs = (over: Partial<LanguagePreferences> = {}): LanguagePreferences => ({
  ...DEFAULT_LANGUAGE_PREFERENCES,
  ...over,
})

describe('1 · English → Simplified Chinese (the legacy product behaviour)', () => {
  it('resolves to en → zh-Hans with translation on and the live route target zh', () => {
    const r = resolveLectureLanguages(prefs())
    expect(r.languages).toEqual({ sourceLanguage: 'en', translationLanguage: 'zh-Hans' })
    expect(r.translationEnabled).toBe(true)
    expect(r.translationSkipReason).toBeNull()
    expect(liveTranslateRouteTarget(r.languages)).toBe('zh')
  })
})

describe('2 · English → English is skipped; 3 · Original only', () => {
  it('same spoken and target language: no translation (nothing to request, no cost)', () => {
    const r = resolveLectureLanguages(prefs({ translationLanguage: 'en' }))
    expect(r.translationEnabled).toBe(false)
    expect(r.translationSkipReason).toBe('same_language')
    expect(r.languages.translationLanguage).toBe(r.languages.sourceLanguage)
    expect(liveTranslateRouteTarget(r.languages)).toBe('off')
  })

  it('Original only: no translation, and the saved language pair says so (translation === source)', () => {
    const r = resolveLectureLanguages(prefs({ languageMode: 'captions-only' }))
    expect(r.translationEnabled).toBe(false)
    expect(r.translationSkipReason).toBe('original_only')
    expect(r.languages).toEqual({ sourceLanguage: 'en', translationLanguage: 'en' })
    expect(isTranslationEnabled(r.languages)).toBe(false)
    expect(liveTranslateRouteTarget(r.languages)).toBe('off')
  })
})

describe('4 · other spoken languages', () => {
  it('Chinese → English: spoken zh-Hans, translated to en, routed to the live route as en', () => {
    const r = resolveLectureLanguages(prefs({ captionLanguage: 'zh-Hans', translationLanguage: 'en' }))
    expect(r.languages).toEqual({ sourceLanguage: 'zh-Hans', translationLanguage: 'en' })
    expect(r.translationEnabled).toBe(true)
    expect(liveTranslateRouteTarget(r.languages)).toBe('en')
  })

  it('Japanese → English works on the same path (spoken ja is available)', () => {
    const r = resolveLectureLanguages(prefs({ captionLanguage: 'ja', translationLanguage: 'en' }))
    expect(r.languages).toEqual({ sourceLanguage: 'ja', translationLanguage: 'en' })
    expect(r.translationEnabled).toBe(true)
  })

  it('Spanish is NOT silently treated as spoken-supported: English is substituted and REPORTED', () => {
    const r = resolveLectureLanguages(prefs({ captionLanguage: 'es', translationLanguage: 'en' }))
    expect(r.sourceSubstituted).toBe(true)
    expect(r.languages.sourceLanguage).toBe('en')
  })
})

describe('5 · independence of Spoken language and Translate to', () => {
  it('changing the spoken language never rewrites the translation target (and vice versa)', () => {
    const base = prefs()
    expect(applyTranslateTo(base, ORIGINAL_ONLY).translationLanguage).toBe(base.translationLanguage)
    expect(applyTranslateTo(base, ORIGINAL_ONLY).captionLanguage).toBe(base.captionLanguage)
    expect(applyTranslateTo(base, 'en').captionLanguage).toBe(base.captionLanguage)
  })

  it('Original only remembers the previous target, so switching translation back on restores it', () => {
    const off = applyTranslateTo(prefs({ translationLanguage: 'zh-Hans' }), ORIGINAL_ONLY)
    expect(translateToValue(off)).toBe(ORIGINAL_ONLY)
    const back = applyTranslateTo(off, 'zh-Hans')
    expect(translateToValue(back)).toBe('zh-Hans')
  })
})

describe('no silent fallback for what the stack cannot serve', () => {
  it('a spoken language whose saved lecture could not be transcribed (Spanish) is never used: English is substituted and REPORTED', () => {
    const r = resolveLectureLanguages(prefs({ captionLanguage: 'es', translationLanguage: 'en' }))
    expect(r.sourceSubstituted).toBe(true)
    expect(r.languages.sourceLanguage).toBe('en')
  })

  it('every proven target is honoured — including ones the old HTTP route could not serve — and keeps the pair exactly', () => {
    for (const target of ['en', 'zh-Hans', 'ja', 'fr', 'es', 'ko'] as const) {
      const source = target === 'en' ? 'zh-Hans' : 'en'
      const r = resolveLectureLanguages(prefs({ captionLanguage: source, translationLanguage: target }))
      expect(r.translationEnabled, target).toBe(true)
      expect(r.languages, target).toEqual({ sourceLanguage: source, translationLanguage: target })
    }
  })
})

describe('legacy lectures', () => {
  it('a row with no language columns is interpreted as the product always behaved: en → zh-Hans', () => {
    expect(lectureLanguagesFromRow({})).toEqual(LEGACY_LECTURE_LANGUAGES)
    expect(LEGACY_LECTURE_LANGUAGES).toEqual({ sourceLanguage: 'en', translationLanguage: 'zh-Hans' })
  })

  it('each field falls back on its own; an unknown value never becomes today\'s preference', () => {
    expect(lectureLanguagesFromRow({ sourceLanguage: 'ja', translationLanguage: null })).toEqual({
      sourceLanguage: 'ja',
      translationLanguage: 'zh-Hans',
    })
    expect(lectureLanguagesFromRow({ sourceLanguage: 'xx', translationLanguage: 'yy' })).toEqual(
      LEGACY_LECTURE_LANGUAGES,
    )
  })

  it('a stored Original-only lecture stays Original-only whatever the preference is now', () => {
    expect(lectureLanguagesFromRow({ sourceLanguage: 'en', translationLanguage: 'en' })).toEqual({
      sourceLanguage: 'en',
      translationLanguage: 'en',
    })
  })
})

describe('summary rule', () => {
  const en2zh = { sourceLanguage: 'en', translationLanguage: 'zh-Hans' } as const
  const orig = { sourceLanguage: 'en', translationLanguage: 'en' } as const

  it('translation on → the translated summary opens first; the original stays available', () => {
    const s = lectureSummariesFor(en2zh, { sourceSummary: 'EN', translatedSummary: '中' })
    expect(defaultSummaryKind(en2zh)).toBe('translated')
    expect(initialSummaryKind(en2zh, s)).toBe('translated')
    expect(s.source).toBe('EN')
  })

  it('Original only → the source summary, and no translated one is ever invented', () => {
    const s = lectureSummariesFor(orig, { sourceSummary: 'EN', translatedSummary: 'stale' })
    expect(defaultSummaryKind(orig)).toBe('source')
    expect(s.translated).toBeNull()
    expect(initialSummaryKind(orig, s)).toBe('source')
  })

  it('an old row with only summary_en / summary_zh is read by the language each is written in', () => {
    const s = lectureSummariesFor(en2zh, { summaryEn: 'EN', summaryZh: '中' })
    expect(s).toEqual({ source: 'EN', translated: '中' })
  })

  it('never an empty pane while the other summary exists', () => {
    const s = lectureSummariesFor(en2zh, { sourceSummary: 'EN' })
    expect(initialSummaryKind(en2zh, s)).toBe('source')
    expect(initialSummaryKind(en2zh, { source: null, translated: null })).toBeNull()
  })

  it('a Chinese-spoken lecture reads summary_zh as its SOURCE summary (mirror trusted only for its own language)', () => {
    const zh2en = { sourceLanguage: 'zh-Hans', translationLanguage: 'en' } as const
    expect(lectureSummariesFor(zh2en, { summaryEn: 'EN', summaryZh: '中' })).toEqual({ source: '中', translated: 'EN' })
  })
})
