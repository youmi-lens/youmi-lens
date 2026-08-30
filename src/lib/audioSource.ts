/**
 * Which audio the recorder captures.
 *
 * `system` routes capture through `getDisplayMedia` instead of `getUserMedia`,
 * so a lecture playing through the Mac — Coursera, YouTube, a Zoom replay — is
 * what gets transcribed. Everything downstream is unchanged: the same
 * MediaStream drives the same MediaRecorder for the durable file and the same
 * AudioContext for live PCM, so the caption engine, upload, recovery and
 * Stop & Save paths never learn where the audio came from.
 *
 * That is the whole reason this approach was chosen over a native
 * ScreenCaptureKit service: a native capture would have to write its own
 * durable file, and a second recording path is a second way to lose a lecture.
 *
 * `mixed` deliberately does not exist. Mixing two clock domains needs a real
 * resampler, and a half-working mix is worse than none.
 */

export const AUDIO_SOURCES = ['microphone', 'system'] as const
export type AudioSource = (typeof AUDIO_SOURCES)[number]

export const DEFAULT_AUDIO_SOURCE: AudioSource = 'microphone'

const STORAGE_KEY = 'youmi.audioSource'

/** Anything unrecognised — a hand-edited value, a future enum — reads as microphone. */
export function parseAudioSource(raw: unknown): AudioSource {
  return AUDIO_SOURCES.includes(raw as AudioSource) ? (raw as AudioSource) : DEFAULT_AUDIO_SOURCE
}

export function readAudioSource(storage: Pick<Storage, 'getItem'>): AudioSource {
  try {
    return parseAudioSource(storage.getItem(STORAGE_KEY))
  } catch {
    return DEFAULT_AUDIO_SOURCE
  }
}

export function writeAudioSource(storage: Pick<Storage, 'setItem'>, source: AudioSource): void {
  try {
    storage.setItem(STORAGE_KEY, parseAudioSource(source))
  } catch {
    /* quota / private mode — the in-memory value still applies to this session */
  }
}

/**
 * Whether this build can offer System Audio at all.
 *
 * `getDisplayMedia` is the only route that keeps one recording pipeline. If the
 * WebView does not expose it, the option is hidden rather than offered and then
 * failed — and it is never silently swapped for the microphone, which would
 * record the room while claiming to record the computer.
 */
export function systemAudioSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  )
}

export const AUDIO_SOURCE_LABEL_KEY = {
  microphone: 'capture.sourceMicrophone',
  system: 'capture.sourceSystem',
} as const

/**
 * Thrown when System Audio was requested and the granted stream carries no
 * audio track — the user picked a window without audio, or declined to share
 * it. Surfaced as a real error so nothing pretends to be recording a lecture
 * that is not being captured.
 */
export class SystemAudioUnavailableError extends Error {
  constructor() {
    super('system_audio_no_track')
    this.name = 'SystemAudioUnavailableError'
  }
}
