import { describe, expect, it } from 'vitest'
import {
  AUDIO_SOURCE_LABEL_KEY,
  AUDIO_SOURCES,
  DEFAULT_AUDIO_SOURCE,
  parseAudioSource,
  readAudioSource,
  writeAudioSource,
} from './audioSource'
import { DESKTOP_I18N_KEYS, DESKTOP_I18N_LOCALES, translateDesktop } from './desktopI18n'

function fakeStorage(initial?: string) {
  let value = initial
  return {
    getItem: () => value ?? null,
    setItem: (_k: string, v: string) => {
      value = v
    },
    get value() {
      return value
    },
  }
}

describe('audio source', () => {
  it('offers exactly microphone and system — no mixed until mixing exists', () => {
    expect([...AUDIO_SOURCES]).toEqual(['microphone', 'system'])
  })

  it('defaults to microphone, so an upgrade never switches a user silently', () => {
    expect(DEFAULT_AUDIO_SOURCE).toBe('microphone')
    expect(readAudioSource(fakeStorage())).toBe('microphone')
  })

  it('validates strictly: anything unrecognised reads as microphone', () => {
    for (const bad of ['mixed', 'MICROPHONE', '', 'null', 'speaker', '1']) {
      expect(parseAudioSource(bad), bad).toBe('microphone')
    }
    expect(parseAudioSource(undefined)).toBe('microphone')
    expect(parseAudioSource({ source: 'system' })).toBe('microphone')
  })

  it('round-trips a valid value', () => {
    const storage = fakeStorage()
    writeAudioSource(storage, 'system')
    expect(storage.value).toBe('system')
    expect(readAudioSource(storage)).toBe('system')
  })

  it('never persists an invalid value', () => {
    const storage = fakeStorage()
    writeAudioSource(storage, 'mixed' as never)
    expect(storage.value).toBe('microphone')
  })

  it('survives storage that throws', () => {
    const hostile = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readAudioSource(hostile)).toBe('microphone')
    expect(() => writeAudioSource(hostile, 'system')).not.toThrow()
  })

  it('labels every source in all six languages', () => {
    for (const source of AUDIO_SOURCES) {
      const key = AUDIO_SOURCE_LABEL_KEY[source]
      expect(DESKTOP_I18N_KEYS).toContain(key)
      for (const locale of DESKTOP_I18N_LOCALES) {
        expect(translateDesktop(locale, key).length, `${locale}/${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('explains the picker and the no-video promise in all six languages', () => {
    for (const locale of DESKTOP_I18N_LOCALES) {
      for (const key of ['capture.sourceSystemHelp', 'capture.systemPickerNote'] as const) {
        expect(translateDesktop(locale, key).length, `${locale}/${key}`).toBeGreaterThan(10)
      }
    }
  })
})

describe('capture wiring', () => {
  const recorder = readFileSyncSafe('../hooks/useRecorder.ts')
  const app = readFileSyncSafe('../App.tsx')

  it('system audio uses getDisplayMedia, microphone uses getUserMedia', () => {
    expect(recorder).toContain("if (source === 'system')")
    expect(recorder).toContain('getDisplayMedia({')
    expect(recorder).toContain('getUserMedia({')
  })

  it('the video track is stopped and removed, so no frame is ever read', () => {
    expect(recorder).toContain('for (const track of stream.getVideoTracks())')
    expect(recorder).toContain('stream.removeTrack(track)')
  })

  it('a stream with no audio track fails loudly instead of falling back to the mic', () => {
    expect(recorder).toContain('if (stream.getAudioTracks().length === 0)')
    // The forbidden repair: silently recording the room while claiming System Audio.
    const block = recorder.slice(
      recorder.indexOf('if (stream.getAudioTracks().length === 0)'),
      recorder.indexOf('} else {'),
    )
    expect(block).not.toContain('getUserMedia')
    expect(block).toContain('return null')
  })

  it('the source is frozen at Start, read through a ref', () => {
    expect(app).toContain('getAudioSource: () => audioSourceRef.current')
    expect(recorder).toContain("opts?.getAudioSource?.() ?? 'microphone'")
  })

  it('reuses the existing recording pipeline — no second durable path', () => {
    // One MediaRecorder, one AudioContext, whichever source produced the stream.
    expect(recorder.match(/new MediaRecorder\(stream,/g)?.length).toBe(1)
    expect(recorder).toContain('createMediaStreamSource(stream)')
  })

  it('the option is hidden, not offered, where it cannot work', () => {
    expect(app).toContain('systemAudioSupported() ? (')
    expect(app).toContain("tDesktop('capture.systemUnsupported')")
  })
})

function readFileSyncSafe(rel: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  return readFileSync(new URL(rel, import.meta.url), 'utf8')
}
