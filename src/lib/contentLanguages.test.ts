import { describe, expect, it } from 'vitest'
import { isSourceProven, isTargetProven } from './multilingualEvidence'
import {
  CONTENT_LANGUAGES,
  LANGUAGE_CODES,
  isSpaceDelimited,
  isSpokenLanguageAvailable,
  isTranslationTargetAvailable,
  languageScript,
} from './contentLanguages'

const byCode = (code: string) => CONTENT_LANGUAGES.find((language) => language.code === code)

describe('canonical language registry', () => {
  it('uses only the approved six language codes and labels', () => {
    expect(CONTENT_LANGUAGES.map((language) => language.code)).toEqual(LANGUAGE_CODES)
    expect(CONTENT_LANGUAGES.map((language) => language.label)).toEqual([
      'English', '简体中文', '日本語', 'Français', 'Español', '한국어',
    ])
  })

  it('every entry carries the caption script that decides how live captions are validated', () => {
    expect(languageScript('en')).toBe('latin')
    expect(languageScript('fr')).toBe('latin')
    expect(languageScript('zh-Hans')).toBe('cjk')
    expect(languageScript('ja')).toBe('cjk')
    expect(languageScript('ko')).toBe('cjk')
  })

  // `available` is a promise that the DEPLOYED stack was exercised end to end, so each flag is
  // answerable to the evidence table — in both directions.
  it('spoken: available exactly where live AND final transcription are proven', () => {
    for (const language of CONTENT_LANGUAGES) {
      expect(language.caption === 'available', language.code).toBe(isSourceProven(language.code))
    }
    // Spanish streams live but its saved lecture could not be transcribed.
    expect(byCode('es')?.caption).toBe('not-enabled')
    expect(byCode('es')?.captionBlockedReason).toBe('final-asr')
    expect(isSpokenLanguageAvailable('es')).toBe(false)
  })

  it('translate-to: available exactly where live + final + summary are proven — independent of being speakable', () => {
    for (const language of CONTENT_LANGUAGES) {
      expect(language.translation === 'available', language.code).toBe(isTargetProven(language.code))
    }
    // Source and target are independent: Spanish is a proven TARGET while blocked as a SOURCE.
    expect(isTranslationTargetAvailable('es')).toBe(true)
    expect(isSpokenLanguageAvailable('es')).toBe(false)
  })

  it('every language says whether it is written with spaces (Korean is "cjk" for validation yet spaced)', () => {
    expect(isSpaceDelimited('en')).toBe(true)
    expect(isSpaceDelimited('fr')).toBe(true)
    expect(isSpaceDelimited('es')).toBe(true)
    expect(isSpaceDelimited('ko')).toBe(true)
    expect(isSpaceDelimited('zh-Hans')).toBe(false)
    expect(isSpaceDelimited('ja')).toBe(false)
    expect(languageScript('ko')).toBe('cjk')
  })
})
