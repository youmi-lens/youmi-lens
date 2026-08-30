/**
 * Live PCM capture rate.
 *
 * The regression this guards is a latency one, and it is invisible in any
 * screenshot: the upstream ASR session is bound to the sample rate declared
 * when it is warmed, and capture used to open a *default* AudioContext whose
 * rate follows the device. When the two disagreed the adapter destroyed the
 * warmed session and re-handshook — measured at 3.0–4.1s against DashScope —
 * with the user's first sentence queued behind it.
 *
 * So: both ends must name the same constant, and capture must actually ask for
 * it. Every test below fails if the request is dropped.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  createLivePcmAudioContext,
  LIVE_PCM_SAMPLE_RATE,
  resolveAudioContextCtor,
} from './livePcmCapture'

/** Minimal stand-in: records the options it was constructed with. */
function fakeCtor(behaviour: 'accepts' | 'rejects-options') {
  const calls: (AudioContextOptions | undefined)[] = []
  const ctor = vi.fn(function (this: unknown, options?: AudioContextOptions) {
    calls.push(options)
    if (behaviour === 'rejects-options' && options) {
      // What WebKit throws for a rate the hardware cannot be driven at.
      throw new DOMException('sample rate not supported', 'NotSupportedError')
    }
    return { sampleRate: options?.sampleRate ?? 44100 } as unknown as AudioContext
  }) as unknown as new (options?: AudioContextOptions) => AudioContext
  return { ctor, calls }
}

describe('the fixed capture rate', () => {
  it('is 48kHz — the rate production already asks paraformer-realtime-v2 for', () => {
    expect(LIVE_PCM_SAMPLE_RATE).toBe(48000)
  })

  it('is requested explicitly, not inherited from the device', () => {
    const { ctor, calls } = fakeCtor('accepts')
    const ctx = createLivePcmAudioContext(ctor)
    expect(calls).toEqual([{ sampleRate: 48000 }])
    expect(ctx.sampleRate).toBe(LIVE_PCM_SAMPLE_RATE)
  })

  it('falls back to the default context rather than losing captions', () => {
    // A platform that refuses the rate must still record. The adapter's
    // one-shot reconnect covers the mismatch that follows; refusing to open a
    // context at all would trade a latency bug for a total outage.
    const { ctor, calls } = fakeCtor('rejects-options')
    const ctx = createLivePcmAudioContext(ctor)
    expect(calls).toEqual([{ sampleRate: 48000 }, undefined])
    expect(ctx.sampleRate).toBe(44100)
  })
})

describe('constructor resolution', () => {
  it('returns null off-DOM instead of throwing', () => {
    const original = globalThis.window
    // @ts-expect-error — deleting the global is the point of the test
    delete globalThis.window
    try {
      expect(resolveAudioContextCtor()).toBeNull()
    } finally {
      if (original) globalThis.window = original
    }
  })

  it('accepts the webkit alias older WKWebView builds expose', () => {
    const original = globalThis.window
    const webkitAudioContext = fakeCtor('accepts').ctor
    // @ts-expect-error — minimal window stand-in
    globalThis.window = { webkitAudioContext }
    try {
      expect(resolveAudioContextCtor()).toBe(webkitAudioContext)
    } finally {
      if (original) globalThis.window = original
      // @ts-expect-error — restore absence when there was none
      else delete globalThis.window
    }
  })
})

describe('warm and capture agree', () => {
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
  const recorder = readFileSync(new URL('../hooks/useRecorder.ts', import.meta.url), 'utf8')

  it('the warm handshake declares the fixed rate', () => {
    expect(app).toContain('warmSampleRateRef = useRef(LIVE_PCM_SAMPLE_RATE)')
    expect(app).toContain('warmSampleRateRef.current = LIVE_PCM_SAMPLE_RATE')
    // The output-device probe is what made the two ends disagree.
    expect(app).not.toContain('probeDefaultAudioSampleRate()')
  })

  it('capture opens the pinned context, not a default one', () => {
    expect(recorder).toContain('createLivePcmAudioContext(ACtx)')
    expect(recorder).not.toContain('const ctx = new ACtx()')
  })
})
