import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { createLivePcmAudioContext, resolveAudioContextCtor } from '../lib/livePcmCapture'
import { logMediaEnvironmentOnce } from '../lib/mediaEnvDebug'
import {
  buildMediaRecorderOptions,
  selectSpeechBitrateBps,
  SPEECH_AUDIO_BITS_PER_SECOND,
} from '../lib/recordingBitrate'
import {
  appendRecordingChunk,
  assembleRecordingBlob,
  createRecordingSession,
  deleteRecordingSession,
  heartbeatRecordingSession,
  updateRecordingSessionStatus,
} from '../lib/recordingSessionStore'
import type { RecordingStatus } from '../types'

/** Incident / P0: evidence chain for main lecture track only (no secrets). */
function mainRecLine(
  phase: 'start' | 'data' | 'stop' | 'blob' | 'guard' | 'flush' | 'persist',
  payload: Record<string, string | number | boolean | undefined | null>,
): void {
  console.warn(`[MainRec][${phase}]`, JSON.stringify({ ...payload, t: Date.now() }))
}

function pickMime(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ]
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c
  }
  return ''
}

function newSessionId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `main-${Date.now()}`
}

/** Skip accidental tiny blobs from stop/pause races. */
const MIN_LIVE_AUDIO_BYTES = 2048

/** Live caption slice interval only (separate cloned MediaRecorder; does not use timeslice on main track). */
/** What a recording's durable session remembers about the lecture. */
export type SessionContext = {
  course?: string
  courseId?: string | null
  title?: string
  /** Canonical content-language ids, frozen at Start. */
  sourceLanguage?: string
  translationLanguage?: string
}

export const LIVE_WHISPER_SLICE_MS = 1600

/** After final requestData(), wait until no non-empty chunk for this long (or cap) before MediaRecorder.stop(). */
const MAIN_RECORDER_QUIET_MS = 100
const MAIN_RECORDER_FLUSH_MAX_MS = 3000

/** Periodic MediaRecorder.requestData interval — also drives durable chunk writes. */
export const MAIN_RECORDER_REQUEST_DATA_MS = 5000

export function useRecorder(opts?: {
  /** Receives each timed audio slice while recording (cloned track; same mic as main file). */
  onLiveAudioChunkRef?: RefObject<((blob: Blob, mime: string) => void) | null>
  /**
   * PCM streaming path: receives raw Int16 PCM frames (~90ms each) from an AudioContext
   * ScriptProcessor. Used by the DashScope Paraformer real-time streaming ASR path.
   * When provided, the blob-slice MediaRecorder cycle should be disabled via experimentalSkipLiveSlice.
   */
  onPcmChunkRef?: RefObject<((buffer: ArrayBuffer, sampleRate: number) => void) | null>
  /**
   * Fired the moment the capture AudioContext exists, with the rate the stream
   * will ACTUALLY use — before any PCM has been produced.
   *
   * The live session is warmed ahead of Record using
   * `probeDefaultAudioSampleRate()`, which opens a bare AudioContext and reports
   * the hardware OUTPUT rate. Opening the microphone can change it: on macOS a
   * Bluetooth headset switches to its HFP mode when the mic is acquired, so the
   * capture context comes back at a different rate than the warm used. The
   * adapter then sees a mismatch on the first PCM frame and tears the upstream
   * session down for a full reconnect — at the exact moment the user starts
   * speaking. This callback moves that reconnect earlier, into the gap between
   * pressing Start and the first word.
   */
  onCaptureSampleRate?: (sampleRate: number) => void
  /**
   * Local A/B only: when true, do not clone the mic or run the live slice MediaRecorder cycle.
   * Main track is unchanged. Used to test whether the Youmi live chain interferes with main recording.
   */
  experimentalSkipLiveSlice?: boolean
  /** Owner isolation key for durable sessions (`userId` or `local` / `anonymous`). */
  getOwnerKey?: () => string
  getSessionContext?: () => SessionContext
  /**
   * Read at Start and never again, so the source is frozen for the session —
   * changing the setting mid-lecture cannot change what is being captured.
   */
  getAudioSource?: () => 'microphone' | 'system'
}) {
  const [status, setStatus] = useState<RecordingStatus>('idle')
  const [elapsedSec, setElapsedSec] = useState(0)
  const [error, setError] = useState<string | null>(null)
  /** Stable recording UUID for the active durable session (also used as cloud/pending id). */
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const liveSliceRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const liveStreamRef = useRef<MediaStream | null>(null)
  /**
   * Phase 2D-4: do NOT retain the full lecture in memory. Only a short queue of
   * chunks awaiting confirmed IndexedDB persistence is held; after each write
   * the Blob reference is released.
   */
  const persistQueueRef = useRef<Array<{ index: number; blob: Blob }>>([])
  const persistChainRef = useRef<Promise<void>>(Promise.resolve())
  const mimeRef = useRef<string>('audio/webm')
  const bitrateRef = useRef<number>(SPEECH_AUDIO_BITS_PER_SECOND)
  // PCM streaming capture (AudioContext path)
  const audioContextRef = useRef<AudioContext | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scriptProcessorRef = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const audioSourceRef = useRef<any>(null)
  /** One id per main MediaRecorder session — correlates [MainRec] lines in console. */
  const mainRecSessionIdRef = useRef<string>('')
  const mainDataChunkIndexRef = useRef(0)
  /** Last time main `MediaRecorder` emitted a non-empty blob (for end-of-recording quiet-period flush). */
  const mainLastChunkAtRef = useRef(0)
  /** Force periodic flush so long sessions don't collapse to ~1s output. */
  const mainRequestDataTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const elapsedSecRef = useRef(0)

  const liveCyclingRef = useRef(false)
  const liveSliceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const liveSliceWaitRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startLiveSliceCycleRef = useRef<(() => void) | null>(null)
  const waitForHandlerAttemptsRef = useRef(0)

  /** PCM diagnostics (streaming ASR latency chain). */
  const pcmFrameDiagCountRef = useRef(0)
  /** Log once per recording session when legacy MediaRecorder slice path emits audio. */
  const legacySliceDiagLoggedRef = useRef(false)

  useEffect(() => {
    elapsedSecRef.current = elapsedSec
  }, [elapsedSec])

  useEffect(() => {
    if (status !== 'recording') return
    const id = window.setInterval(() => {
      setElapsedSec((s) => s + 1)
    }, 1000)
    return () => window.clearInterval(id)
  }, [status])

  const enqueuePersist = useCallback((sessionId: string, index: number, blob: Blob) => {
    persistQueueRef.current.push({ index, blob })
    persistChainRef.current = persistChainRef.current.then(async () => {
      while (persistQueueRef.current.length > 0) {
        const item = persistQueueRef.current.shift()!
        try {
          const result = await appendRecordingChunk(sessionId, item.index, item.blob)
          mainRecLine('persist', {
            session: sessionId.slice(-8),
            chunkIndex: item.index,
            size: item.blob.size,
            accepted: result.accepted,
            reason: result.reason ?? '',
          })
        } catch (err) {
          // Re-queue at front so stop() can still flush; keep reference until success.
          persistQueueRef.current.unshift(item)
          mainRecLine('persist', {
            session: sessionId.slice(-8),
            chunkIndex: item.index,
            error: err instanceof Error ? err.message : String(err),
          })
          throw err
        }
        // Release chunk reference after confirmed persistence (or duplicate ignore).
      }
    }).catch(() => {
      /* chain continues on next enqueue; stop() awaits drain */
    })
  }, [])

  const drainPersistQueue = useCallback(async () => {
    await persistChainRef.current
    // One more pass if a failed item was re-queued
    if (persistQueueRef.current.length > 0) {
      const sessionId = mainRecSessionIdRef.current
      persistChainRef.current = persistChainRef.current.then(async () => {
        while (persistQueueRef.current.length > 0 && sessionId) {
          const item = persistQueueRef.current.shift()!
          await appendRecordingChunk(sessionId, item.index, item.blob)
        }
      })
      await persistChainRef.current
    }
  }, [])

  /** Stop the current slice timer/recorder only (keep cycle fn so Resume can restart). */
  const haltLiveSliceCycle = useCallback(() => {
    liveCyclingRef.current = false
    if (liveSliceTimerRef.current) {
      clearTimeout(liveSliceTimerRef.current)
      liveSliceTimerRef.current = null
    }
    if (liveSliceWaitRef.current) {
      clearTimeout(liveSliceWaitRef.current)
      liveSliceWaitRef.current = null
    }
  }, [])

  const teardownLiveSliceCycle = useCallback(() => {
    haltLiveSliceCycle()
    startLiveSliceCycleRef.current = null
  }, [haltLiveSliceCycle])

  const teardownPcmCapture = useCallback(() => {
    try {
      audioSourceRef.current?.disconnect()
    } catch { /* ignore */ }
    try {
      scriptProcessorRef.current?.disconnect()
    } catch { /* ignore */ }
    audioSourceRef.current = null
    scriptProcessorRef.current = null
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => { /* ignore */ })
      audioContextRef.current = null
    }
  }, [])

  const stopStream = useCallback(() => {
    if (mainRequestDataTimerRef.current) {
      clearInterval(mainRequestDataTimerRef.current)
      mainRequestDataTimerRef.current = null
    }
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current)
      heartbeatTimerRef.current = null
    }
    teardownPcmCapture()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    liveStreamRef.current?.getTracks().forEach((t) => t.stop())
    liveStreamRef.current = null
  }, [teardownPcmCapture])

  const start = useCallback(async (sessionContextOverride?: SessionContext): Promise<string | null> => {
    setError(null)
    try {
      const existing = mediaRecorderRef.current
      if (existing && existing.state !== 'inactive') {
        mainRecLine('guard', {
          reason: 'start_called_while_active',
          state: existing.state,
          session: mainRecSessionIdRef.current.slice(-8),
        })
        return mainRecSessionIdRef.current || null
      }
      logMediaEnvironmentOnce()
      if (!navigator.mediaDevices?.getUserMedia) {
        setError(
          'Microphone API unavailable (navigator.mediaDevices missing). On macOS desktop, rebuild the app after adding Info.plist (NSMicrophoneUsageDescription). See console [lc-media env].',
        )
        return null
      }
      /*
       * One stream, two possible origins.
       *
       * Everything after this line is identical for both: the same MediaRecorder
       * writes the durable file and the same AudioContext produces live PCM. The
       * caption engine, the upload and the recovery path never learn which was
       * used — which is exactly why System Audio does not need a second
       * recording implementation.
       */
      const source = opts?.getAudioSource?.() ?? 'microphone'
      let stream: MediaStream
      if (source === 'system') {
        if (typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
          setError('This build cannot capture computer audio.')
          return null
        }
        // `video` is required by the spec to get a picker at all, but the track
        // is stopped immediately below: no frame is ever read, encoded or saved.
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        })
        for (const track of stream.getVideoTracks()) {
          track.stop()
          stream.removeTrack(track)
        }
        if (stream.getAudioTracks().length === 0) {
          // Never fall back to the microphone here. Recording the room while the
          // UI says "System Audio" is worse than refusing.
          for (const track of stream.getTracks()) track.stop()
          setError(
            'No computer audio was shared. Choose a screen or window and tick “Share audio”, then try again.',
          )
          return null
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
          },
        })
      }
      streamRef.current = stream
      const mime = pickMime()
      mimeRef.current = mime || 'audio/webm'
      const bitrate = selectSpeechBitrateBps()
      bitrateRef.current = bitrate
      const mr = new MediaRecorder(stream, buildMediaRecorderOptions(mime, bitrate))
      const sessionId = newSessionId()
      mainRecSessionIdRef.current = sessionId
      mainDataChunkIndexRef.current = 0
      pcmFrameDiagCountRef.current = 0
      legacySliceDiagLoggedRef.current = false
      persistQueueRef.current = []
      persistChainRef.current = Promise.resolve()

      const ownerKey = opts?.getOwnerKey?.() ?? 'anonymous'
      // A Course Detail CTA changes React state and starts capture in the same
      // event. Take its explicit snapshot when provided rather than reading a
      // pre-commit render closure.
      const sessionContext = sessionContextOverride ?? opts?.getSessionContext?.()
      await createRecordingSession({
        id: sessionId,
        ownerKey,
        mime: mime || 'audio/webm',
        requestedBitrate: bitrate,
        course: sessionContext?.course,
        courseId: sessionContext?.courseId ?? null,
        title: sessionContext?.title,
        sourceLanguage: sessionContext?.sourceLanguage,
        translationLanguage: sessionContext?.translationLanguage,
      })
      setActiveSessionId(sessionId)

      const session = sessionId
      mr.ondataavailable = (e) => {
        const ev = e as BlobEvent & { timecode?: number }
        const idx = mainDataChunkIndexRef.current++
        const tc = typeof ev.timecode === 'number' ? ev.timecode : undefined
        if (e.data.size > 0) {
          mainLastChunkAtRef.current = Date.now()
          // Durable write — do not retain full session in component memory.
          enqueuePersist(session, idx, e.data)
        }
        mainRecLine('data', {
          session: session.slice(-8),
          chunkIndex: idx,
          size: e.data.size,
          timecodeMs: tc,
          queueDepth: persistQueueRef.current.length,
          audioBitsPerSecond: bitrate,
        })
      }
      /**
       * Full lecture file MUST be one continuous capture. Do not use a timeslice here: on several
       * browsers (notably WebKit) intermediate `dataavailable` blobs can be empty or invalid, and
       * filtering `size > 0` then leaves only the last slice — saved audio can be ~1s while the UI
       * timer shows the full session. Live captions use a separate cloned stream + their own MR.
       *
       * Chunks are flushed via requestData every MAIN_RECORDER_REQUEST_DATA_MS and persisted to
       * IndexedDB immediately so a crash mid-lecture does not lose the only copy.
       *
       * Commit `recording` status BEFORE `mr.start()` so parent useLayoutEffect attaches live chunk
       * handlers before any audio is captured (fixes first-session truncation vs second session OK).
       */
      flushSync(() => {
        setElapsedSec(0)
        setStatus('recording')
      })
      mr.start()
      mediaRecorderRef.current = mr
      mainRecLine('start', {
        session: session.slice(-8),
        mime: mr.mimeType || mime || '',
        recorderState: mr.state,
        audioTracks: stream.getAudioTracks().length,
        audioBitsPerSecond: bitrate,
        experimentalSkipLiveSlice: Boolean(opts?.experimentalSkipLiveSlice),
      })
      if (typeof mr.requestData === 'function') {
        if (mainRequestDataTimerRef.current) {
          clearInterval(mainRequestDataTimerRef.current)
        }
        mainRequestDataTimerRef.current = window.setInterval(() => {
          if (mr.state !== 'recording') return
          try {
            mr.requestData()
            mainRecLine('flush', { session: session.slice(-8), kind: 'periodic_requestData' })
          } catch {
            /* ignore */
          }
        }, MAIN_RECORDER_REQUEST_DATA_MS)
      }

      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current)
      heartbeatTimerRef.current = window.setInterval(() => {
        void heartbeatRecordingSession(session, elapsedSecRef.current)
      }, 15_000)

      // PCM streaming capture via AudioContext ScriptProcessor.
      // Runs alongside the main MediaRecorder — does not affect the lecture recording.
      // Provides ~90ms Int16 PCM frames at the device sample rate for DashScope realtime ASR.
      const pcmChunkRef = opts?.onPcmChunkRef
      // Check the ref object exists (not .current) — .current is set by a useEffect that runs
      // after this recorder.start() call; reading it here would always be null.
      if (pcmChunkRef) {
        try {
          // Fixed at LIVE_PCM_SAMPLE_RATE so the rate the upstream ASR session
          // was warmed at is the rate frames actually arrive at. A default
          // context follows the device, which can move when the input opens,
          // and the resulting mid-record re-handshake costs seconds of caption
          // latency. Falls back to the default context if the platform refuses.
          const ACtx = resolveAudioContextCtor()
          if (!ACtx) throw new Error('AudioContext unavailable')
          const ctx = createLivePcmAudioContext(ACtx)
          audioContextRef.current = ctx
          const sampleRate = ctx.sampleRate

          // Announce the REAL capture rate now, while the user is still reaching
          // for their first word. If it differs from the warm rate the upstream
          // reconnect happens here instead of on the first spoken frame.
          try {
            opts?.onCaptureSampleRate?.(sampleRate)
          } catch {
            /* diagnostics must never break capture */
          }

          const source = ctx.createMediaStreamSource(stream)
          audioSourceRef.current = source

          // 2048-sample buffer ≈ 43–46ms at 44.1–48kHz.
          // Smaller than 4096 so DashScope receives audio in shorter bursts, reducing
          // the silence gap at the start of a new session and improving first-word latency.
          // 2048 is the minimum Web Audio spec guarantees; 1024 can cause audio glitches.
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          const processor = ctx.createScriptProcessor(2048, 1, 1)
          scriptProcessorRef.current = processor

          processor.onaudioprocess = (event: AudioProcessingEvent) => {
            const send = pcmChunkRef.current
            if (!send) return
            const float32 = event.inputBuffer.getChannelData(0)
            const int16 = new Int16Array(float32.length)
            for (let i = 0; i < float32.length; i++) {
              const s = float32[i]
              int16[i] = s > 1 ? 32767 : s < -1 ? -32768 : Math.round(s * 32767)
            }
            pcmFrameDiagCountRef.current += 1
            if (pcmFrameDiagCountRef.current === 1) {
              console.info(
                '[live-latency] first_pcm_chunk_from_mic',
                JSON.stringify({
                  sampleRate,
                  samples: int16.length,
                  approxMs: Math.round((int16.length / sampleRate) * 1000),
                }),
              )
            }
            // Transfer ownership to avoid copy
            send(int16.buffer, sampleRate)
          }

          // Route through a silent GainNode to keep the processor active without speaker output
          const silentGain = ctx.createGain()
          silentGain.gain.value = 0
          source.connect(processor)
          processor.connect(silentGain)
          silentGain.connect(ctx.destination)

          // Windows/WebView2: an AudioContext created after `await getUserMedia` (i.e. outside the
          // synchronous user-gesture window) frequently stays in "suspended" state, so
          // `onaudioprocess` never fires and no PCM frames reach live captions — the WebSocket
          // connects fine but receives no audio, so no captions and no error appear. macOS
          // WKWebView auto-runs the context. resume() is a safe no-op on an already-running
          // context, so this does not change the Mac path.
          const ctxStateBeforeResume = ctx.state
          void ctx
            .resume()
            .then(() =>
              console.info(
                '[live-latency] pcm_audiocontext_resume',
                JSON.stringify({ before: ctxStateBeforeResume, after: ctx.state }),
              ),
            )
            .catch((resumeErr) =>
              console.warn(
                '[live-latency] pcm_audiocontext_resume_failed',
                JSON.stringify({ before: ctxStateBeforeResume, state: ctx.state, message: String(resumeErr) }),
              ),
            )

          console.info('[useRecorder] PCM capture started', JSON.stringify({ sampleRate, bufferSize: 2048, ctxState: ctx.state }))
          console.info(
            '[live-latency] pcm_capture_started',
            JSON.stringify({
              sampleRate,
              bufferSamples: 2048,
              approxFrameMs: Math.round((2048 / sampleRate) * 1000),
              ctxState: ctx.state,
            }),
          )

          // Watchdog: if no PCM frame is produced shortly after capture starts, the context is
          // almost certainly still suspended/blocked (the common WebView2 symptom), which means
          // live captions will be silent. Surface it once so packaged-build logs explain why.
          window.setTimeout(() => {
            if (pcmFrameDiagCountRef.current === 0 && audioContextRef.current === ctx) {
              console.warn(
                '[live-latency] pcm_no_frames_warning',
                JSON.stringify({ afterMs: 1500, ctxState: ctx.state, sampleRate }),
              )
            }
          }, 1500)
        } catch (pcmErr) {
          console.warn('[useRecorder] PCM capture setup failed', pcmErr)
          // Non-fatal: fall through; live captions unavailable in streaming mode
        }
      }

      const chunkRef = opts?.onLiveAudioChunkRef
      const runLiveSlice = Boolean(chunkRef) && !opts?.experimentalSkipLiveSlice
      if (chunkRef && opts?.experimentalSkipLiveSlice) {
        // In LiveEngine v2 mode, blob-slices are intentionally disabled; PCM streaming replaces them.
        // This is NOT triggered by VITE_EXPERIMENT_SKIP_YOUMI_LIVE_SLICE env var in v2 builds.
        console.info('[useRecorder] blob-slice disabled (v2 PCM streaming path is active)')
      }
      if (runLiveSlice && chunkRef) {
        const liveStream = stream.clone()
        liveStreamRef.current = liveStream
        const chunkRefNonNull = chunkRef

        const sliceOnce = () => {
          if (!liveCyclingRef.current || !liveStreamRef.current) return
          const send = chunkRefNonNull.current
          if (!send) {
            waitForHandlerAttemptsRef.current += 1
            if (waitForHandlerAttemptsRef.current > 100) {
              setError(
                'Live captions failed to start (handler not ready). Try Discard and Start again.',
              )
              liveCyclingRef.current = false
              return
            }
            liveSliceWaitRef.current = window.setTimeout(sliceOnce, 40)
            return
          }
          waitForHandlerAttemptsRef.current = 0

          const mimeType = mimeRef.current || pickMime()
          let rec: MediaRecorder
          try {
            rec = new MediaRecorder(
              liveStreamRef.current,
              buildMediaRecorderOptions(mimeType, bitrateRef.current),
            )
          } catch {
            if (liveCyclingRef.current) {
              liveSliceWaitRef.current = window.setTimeout(sliceOnce, 100)
            }
            return
          }

          const parts: BlobPart[] = []
          rec.ondataavailable = (e) => {
            if (e.data.size > 0) parts.push(e.data)
          }
          rec.onstop = () => {
            const mt = rec.mimeType || mimeType || 'audio/webm'
            const blob = new Blob(parts, { type: mt })
            liveSliceRecorderRef.current = null
            if (blob.size >= MIN_LIVE_AUDIO_BYTES && liveCyclingRef.current) {
              const now = Date.now()
              console.info(
                '[LiveEngine][recorder] live chunk ready',
                JSON.stringify({ bytes: blob.size, mime: mt, atMs: now }),
              )
              if (!legacySliceDiagLoggedRef.current) {
                legacySliceDiagLoggedRef.current = true
                console.info(
                  '[live-latency] legacy_http_slice_ready',
                  JSON.stringify({
                    bytes: blob.size,
                    mime: mt,
                    sliceIntervalMs: LIVE_WHISPER_SLICE_MS,
                  }),
                )
              }
              send(blob, mt)
            }
            if (liveCyclingRef.current) {
              sliceOnce()
            }
          }

          liveSliceRecorderRef.current = rec
          rec.start()

          if (liveSliceTimerRef.current) clearTimeout(liveSliceTimerRef.current)
          liveSliceTimerRef.current = window.setTimeout(() => {
            liveSliceTimerRef.current = null
            if (rec.state === 'recording') {
              try {
                rec.stop()
              } catch {
                /* ignore */
              }
            }
          }, LIVE_WHISPER_SLICE_MS)
        }

        startLiveSliceCycleRef.current = sliceOnce
        liveCyclingRef.current = true
        waitForHandlerAttemptsRef.current = 0
      }

      if (runLiveSlice) {
        window.setTimeout(() => {
          if (liveCyclingRef.current && liveStreamRef.current) {
            startLiveSliceCycleRef.current?.()
          }
        }, 120)
      }
      return sessionId
    } catch (e) {
      console.warn('[useRecorder] microphone access failed', e)
      setError(
        'Microphone access is required to record lectures. Please allow Youmi Lens in System Settings -> Privacy & Security -> Microphone, then restart the app.',
      )
      stopStream()
      return null
    }
  }, [opts?.onLiveAudioChunkRef, opts?.experimentalSkipLiveSlice, opts?.getOwnerKey, stopStream, enqueuePersist])

  const pause = useCallback(() => {
    const mr = mediaRecorderRef.current
    if (!mr || mr.state !== 'recording') return
    haltLiveSliceCycle()
    audioContextRef.current?.suspend().catch(() => { /* ignore */ })
    const liveMr = liveSliceRecorderRef.current
    if (liveMr && liveMr.state !== 'inactive') {
      try {
        liveMr.onstop = () => {
          liveSliceRecorderRef.current = null
        }
        liveMr.stop()
      } catch {
        liveSliceRecorderRef.current = null
      }
    }
    mr.pause()
    setStatus('paused')
    const sid = mainRecSessionIdRef.current
    if (sid) void updateRecordingSessionStatus(sid, 'paused')
  }, [haltLiveSliceCycle])

  const resume = useCallback(() => {
    const mr = mediaRecorderRef.current
    if (!mr || mr.state !== 'paused') return
    mr.resume()
    audioContextRef.current?.resume().catch(() => { /* ignore */ })
    liveCyclingRef.current = true
    startLiveSliceCycleRef.current?.()
    setStatus('recording')
    const sid = mainRecSessionIdRef.current
    if (sid) void updateRecordingSessionStatus(sid, 'recording')
  }, [])

  const stop = useCallback((): Promise<{ blob: Blob; mime: string; sessionId: string }> => {
    return new Promise((resolve, reject) => {
      const mr = mediaRecorderRef.current
      const liveMr = liveSliceRecorderRef.current

      if (!mr || mr.state === 'inactive') {
        reject(new Error('Not recording'))
        return
      }

      teardownLiveSliceCycle()

      const finishMain = () => {
        liveSliceRecorderRef.current = null
        const sessionTag = mainRecSessionIdRef.current.slice(-8)
        const sessionId = mainRecSessionIdRef.current
        mainRecLine('stop', {
          session: sessionTag,
          preStopState: mr.state,
          queueDepth: persistQueueRef.current.length,
        })
        if (mainRequestDataTimerRef.current) {
          clearInterval(mainRequestDataTimerRef.current)
          mainRequestDataTimerRef.current = null
        }
        if (heartbeatTimerRef.current) {
          clearInterval(heartbeatTimerRef.current)
          heartbeatTimerRef.current = null
        }
        try {
          if (typeof mr.requestData === 'function') {
            mr.requestData()
            mainRecLine('flush', { session: sessionTag, kind: 'final_requestData_before_stop' })
          }
        } catch {
          /* requestData unsupported or wrong state */
        }
        mainLastChunkAtRef.current = Date.now()
        mr.onstop = () => {
          void (async () => {
            try {
              await drainPersistQueue()
              await updateRecordingSessionStatus(sessionId, 'finalizing')
              // Assemble ONLY from durable chunks — no in-memory full array retained during capture.
              const assembled = await assembleRecordingBlob(sessionId)
              if (!assembled || assembled.blob.size <= 0) {
                throw new Error('Recording finalize produced an empty audio blob')
              }
              const mime = mr.mimeType || mimeRef.current || assembled.mime
              mainRecLine('blob', {
                session: sessionTag,
                finalBlobSize: assembled.blob.size,
                finalBlobType: assembled.blob.type || mime,
                source: 'durable_chunks',
              })
              mediaRecorderRef.current = null
              stopStream()
              setStatus('idle')
              resolve({ blob: assembled.blob, mime, sessionId })
            } catch (err) {
              mediaRecorderRef.current = null
              stopStream()
              setStatus('idle')
              reject(err instanceof Error ? err : new Error(String(err)))
            }
          })()
        }
        const waitQuietThenStop = () => {
          const deadline = Date.now() + MAIN_RECORDER_FLUSH_MAX_MS
          const tick = () => {
            const quietFor = Date.now() - mainLastChunkAtRef.current
            if (quietFor >= MAIN_RECORDER_QUIET_MS || Date.now() >= deadline) {
              mainRecLine('flush', {
                session: sessionTag,
                kind: 'quiet_period_before_stop',
                quietForMs: quietFor,
                hitMaxWait: Date.now() >= deadline,
              })
              try {
                mr.stop()
              } catch (stopErr) {
                mainRecLine('stop', {
                  session: sessionTag,
                  error: stopErr instanceof Error ? stopErr.message : String(stopErr),
                })
                reject(stopErr instanceof Error ? stopErr : new Error(String(stopErr)))
              }
              return
            }
            window.setTimeout(tick, Math.min(40, MAIN_RECORDER_QUIET_MS))
          }
          window.setTimeout(tick, 0)
        }
        waitQuietThenStop()
      }

      if (liveMr && liveMr.state !== 'inactive') {
        liveMr.onstop = () => {
          liveSliceRecorderRef.current = null
          finishMain()
        }
        try {
          liveMr.stop()
        } catch {
          finishMain()
        }
      } else {
        finishMain()
      }
    })
  }, [teardownLiveSliceCycle, stopStream, drainPersistQueue])

  const cancel = useCallback(() => {
    teardownLiveSliceCycle()
    const liveMr = liveSliceRecorderRef.current
    const mr = mediaRecorderRef.current
    const sessionId = mainRecSessionIdRef.current
    if (mainRequestDataTimerRef.current) {
      clearInterval(mainRequestDataTimerRef.current)
      mainRequestDataTimerRef.current = null
    }
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current)
      heartbeatTimerRef.current = null
    }
    if (liveMr && liveMr.state !== 'inactive') {
      try {
        liveMr.ondataavailable = null
        liveMr.onstop = () => {
          liveSliceRecorderRef.current = null
        }
        liveMr.stop()
      } catch {
        liveSliceRecorderRef.current = null
      }
    } else {
      liveSliceRecorderRef.current = null
    }
    if (mr && mr.state !== 'inactive') {
      mr.onstop = null
      mr.stop()
    }
    mediaRecorderRef.current = null
    persistQueueRef.current = []
    persistChainRef.current = Promise.resolve()
    stopStream()
    setStatus('idle')
    setElapsedSec(0)
    setActiveSessionId(null)
    if (sessionId) {
      void deleteRecordingSession(sessionId).catch(() => { /* best-effort */ })
    }
    mainRecSessionIdRef.current = ''
  }, [teardownLiveSliceCycle, stopStream])

  return {
    status,
    elapsedSec,
    error,
    activeSessionId,
    start,
    pause,
    resume,
    stop,
    cancel,
  }
}
