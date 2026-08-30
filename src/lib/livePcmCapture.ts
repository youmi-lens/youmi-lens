/**
 * The sample rate the live-caption path runs at, and the AudioContext that
 * guarantees it.
 *
 * Why this exists: the upstream ASR session is bound to the rate declared in
 * `stream_start`. The app warms that session while the user is still on Record
 * Home, using `probeDefaultAudioSampleRate()` — a bare AudioContext, which
 * reports the hardware OUTPUT rate. Capture then opened its own default
 * AudioContext, and the two do not always agree: acquiring the microphone can
 * move the device (a Bluetooth headset drops to HFP the moment an input is
 * opened), and output and input devices can simply differ.
 *
 * On a mismatch the adapter tears the upstream session down and re-handshakes.
 * That handshake was measured at 3.0–4.1 s against the DashScope endpoint, and
 * PCM is queued — not dropped, but not recognised either — for its whole
 * duration. Landing it on the user's first sentence is worth several seconds of
 * caption latency all by itself.
 *
 * Pinning both ends to one fixed rate removes the mismatch instead of racing
 * it: Web Audio resamples the device into the context, so the rate declared at
 * warm time is always the rate the frames arrive at.
 *
 * This affects the live-caption path only. The durable recording is written by
 * MediaRecorder straight from the MediaStream and never passes through this
 * context.
 */

/**
 * 48 kHz: what `paraformer-realtime-v2` is already asked for in production, and
 * the native rate of essentially every Mac audio device, so the common case
 * involves no resampling at all.
 */
export const LIVE_PCM_SAMPLE_RATE = 48000

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext

/**
 * Resolve the platform's AudioContext constructor, including the webkit alias
 * older WKWebView builds expose.
 */
export function resolveAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null
  const ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext
  return (ctor as AudioContextCtor | undefined) ?? null
}

/**
 * An AudioContext fixed at `LIVE_PCM_SAMPLE_RATE`.
 *
 * If the platform refuses the requested rate it throws `NotSupportedError`, and
 * the fallback is the plain default context — exactly the behaviour that
 * shipped before, still covered by the adapter's one-shot reconnect on a rate
 * change. Failing closed here would cost the user their live captions to fix a
 * latency problem.
 */
export function createLivePcmAudioContext(ctor: AudioContextCtor): AudioContext {
  try {
    return new ctor({ sampleRate: LIVE_PCM_SAMPLE_RATE })
  } catch {
    return new ctor()
  }
}
