/**
 * YoumiLiveAdapter — **default realtime main line only:** PCM → `/api/live-realtime-ws` → streaming ASR
 * (DashScope by default; Volc only via server `YOUMI_LIVE_ASR_EXPERIMENT`). No blob/base64 transcribe on this path.
 *
 * Design principles:
 *   • Provider delivers natural clause boundaries via VAD (definite:true = final).
 *   • No force-flush, no stall-commit, no synthetic-final patches needed.
 *   • On error/close → abandon in-flight segment (synthetic final) + reconnect.
 *   • Each ASR interim is emitted immediately (no client-side cadence) so text flows continuously.
 *   • **Warm session:** optional `warmSession(sr)` completes after DashScope `stream_ready` so Record avoids ~handshake latency.
 *
 * Segment lifecycle:
 *   First interim → create stream-N.
 *   Each interim  → immediate en_interim for stream-N.
 *   Provider final → en_final for stream-N; next interim opens stream-N+1.
 *   Burst finals (e.g. pause-commit) with no interim between reuse lastInterimSegmentId so segmentId stays stable.
 *
 * Audio flow:
 *   browser AudioContext (PCM Int16) → pushPcm() → StreamingWsSession (WS)
 *   → server ASR (DashScope default) → stream_interim / stream_final → adapter events
 */

import { StreamingWsSession } from '../streamingWsSession'

export type YoumiAdapterOpts = {
  tokenGetter?: () => Promise<string | null>
}

type YoumiAdapterEvent =
  | { type: 'connected' }
  /** Upstream WS torn down after warm idle TTL; caller should re-run warmSession (same sampleRate). */
  | { type: 'warm_idle_teardown' }
  | { type: 'reconnecting'; reason: string }
  | { type: 'closed' }
  | { type: 'en_interim'; segmentId: string; rev: number; text: string }
  | { type: 'en_final'; segmentId: string; text: string }
  | { type: 'error'; code: string; message: string; recoverable: boolean }

type YoumiAdapterListener = (event: YoumiAdapterEvent) => void

function log(tag: string, fields?: Record<string, unknown>) {
  if (fields) console.info(`[LiveEngine][YoumiAdapter] ${tag}`, JSON.stringify(fields))
  else console.info(`[LiveEngine][YoumiAdapter] ${tag}`)
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Speech onset threshold (Int16 ±32767). Filters out silence before first word.
const VOICE_ENERGY_THRESHOLD = 500

// PCM queue capacity while waiting for WS+ASR handshake.
// 200 × ~43ms ≈ 8.6s — covers the full DashScope handshake even on a slow connection.
const PCM_QUEUE_CAP = 200

// ── YoumiLiveAdapter ──────────────────────────────────────────────────────────

export class YoumiLiveAdapter {
  private opts: YoumiAdapterOpts
  private listener: YoumiAdapterListener | null = null
  private closed = false
  private session: StreamingWsSession | null = null
  /** True only after server `stream_ready` (DashScope task-started + session bound). */
  private sessionReady = false
  private activeRef: { active: boolean } = { active: false }

  /** Session bound to `stream_start` sampleRate; mismatch triggers at most one reconnect. */
  private boundSampleRate: number | null = null
  private rateMismatchReconnectDone = false

  private upstreamHandshakeComplete = false
  private handshakeWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = []
  private handshakeRejectTimer: ReturnType<typeof setTimeout> | null = null

  private warmIdleTimer: ReturnType<typeof setTimeout> | null = null
  /** First PCM after user actually records — disables warm-idle TTL teardown. */
  private recordingPcmSeen = false
  /** Sample rate used in the last warmSession() call — used to reconnect in idle if WS drops. */
  private lastWarmSampleRate: number | null = null
  /** How many idle (pre-recording) auto-reconnect attempts have been made since last successful onReady. */
  private idleReconnectCount = 0

  /** Single-flight: avoid overlapping initSession for same warm call site. */
  private sessionInitGeneration = 0

  // Per-segment state
  private currentSegId = ''
  /** Last segment that received an interim — reused when a final arrives with currentSegId already cleared (burst pause-commit finals). */
  private lastInterimSegmentId = ''
  private segCounter = 0
  private interimRev = 0
  private lastInterimMs = 0

  // Latency diagnostics
  private speechOnsetMs = 0
  private firstInterimLogged = false
  private lastFinalMs = 0
  private loggedFirstPcmForwarded = false

  private pcmQueue: ArrayBuffer[] = []

  static readonly WARM_HANDSHAKE_TIMEOUT_MS = 45_000
  static readonly WARM_IDLE_TEARDOWN_MS = 120_000

  constructor(opts: YoumiAdapterOpts = {}) {
    this.opts = opts
  }

  onEvent(listener: YoumiAdapterListener) {
    this.listener = listener
  }

  start() {
    this.closed = false
    this.sessionReady = false
    this.activeRef = { active: false }
    this.boundSampleRate = null
    this.rateMismatchReconnectDone = false
    this.upstreamHandshakeComplete = false
    this.recordingPcmSeen = false
    this.lastWarmSampleRate = null
    this.idleReconnectCount = 0
    this.rejectAllHandshakeWaiters(new Error('adapter_restarted'))
    this.clearHandshakeTimeout()
    this.clearWarmIdleTimer()

    this.currentSegId = ''
    this.lastInterimSegmentId = ''
    this.segCounter = 0
    this.interimRev = 0
    this.lastInterimMs = 0
    this.speechOnsetMs = 0
    this.firstInterimLogged = false
    this.lastFinalMs = 0
    this.loggedFirstPcmForwarded = false
    this.pcmQueue = []

    if (this.session) {
      try {
        this.session.destroy()
      } catch {
        /* ignore */
      }
      this.session = null
    }

    log('adapter starting (live ASR: server DashScope main line)')
    // First `connected` event is emitted from `onReady` (DashScope stream_ready) — not here — so UI reflects warm progress.
  }

  /**
   * Wait until DashScope handshake completes (`stream_ready`). Safe to call repeatedly for the same sampleRate.
   * Does not send PCM; pairs with later `pushPcm` on the same session.
   */
  async warmSession(sampleRate: number): Promise<void> {
    if (this.closed) return
    this.lastWarmSampleRate = sampleRate
    this.ensureStreamingSession(sampleRate)
    if (this.upstreamHandshakeComplete) return
    await new Promise<void>((resolve, reject) => {
      this.handshakeWaiters.push({ resolve, reject })
      this.armHandshakeTimeout()
    })
  }

  /** Call when real recording PCM is about to flow — disables warm-idle upstream teardown. */
  markRecordingPcmActivity() {
    if (this.recordingPcmSeen) return
    this.recordingPcmSeen = true
    this.clearWarmIdleTimer()
  }

  notifyAudioEnd() {
    if (this.closed) return
    log('notifyAudioEnd (stream_stop only)')
    this.session?.stop()
  }

  stop() {
    this.closed = true
    this.activeRef.active = false
    this.rejectAllHandshakeWaiters(new Error('adapter_stopped'))
    this.clearHandshakeTimeout()
    this.clearWarmIdleTimer()
    log('adapter stop')
    this.session?.stop()
    setTimeout(() => {
      this.session?.destroy()
      this.session = null
    }, 500)
    this.listener?.({ type: 'closed' })
  }

  // ── Segment abandonment (on error / unexpected close) ─────────────────────

  private abandonCurrentSegment(reason: string) {
    const segId = this.currentSegId
    const text = '' // discard in-flight draft — content integrity > partial output
    this.currentSegId = ''
    this.lastInterimSegmentId = ''
    this.interimRev = 0
    this.lastInterimMs = 0
    this.firstInterimLogged = false
    this.speechOnsetMs = 0
    if (segId) {
      log('synthetic final for abandoned segment', { reason, segId, nextSeg: `stream-${this.segCounter}` })
      this.listener?.({ type: 'en_final', segmentId: segId, text })
    }
  }

  // ── Warm / handshake helpers ────────────────────────────────────────────────

  private rejectAllHandshakeWaiters(err: Error) {
    const waiters = this.handshakeWaiters
    this.handshakeWaiters = []
    for (const w of waiters) {
      try {
        w.reject(err)
      } catch {
        /* ignore */
      }
    }
  }

  private armHandshakeTimeout() {
    if (this.handshakeRejectTimer || this.handshakeWaiters.length === 0) return
    this.handshakeRejectTimer = setTimeout(() => {
      this.handshakeRejectTimer = null
      if (!this.upstreamHandshakeComplete) {
        this.rejectAllHandshakeWaiters(new Error('LIVE_WARM_HANDSHAKE_TIMEOUT'))
      }
    }, YoumiLiveAdapter.WARM_HANDSHAKE_TIMEOUT_MS)
  }

  private clearHandshakeTimeout() {
    if (this.handshakeRejectTimer) {
      clearTimeout(this.handshakeRejectTimer)
      this.handshakeRejectTimer = null
    }
  }

  private resolveHandshakeWaiters() {
    this.clearHandshakeTimeout()
    const waiters = this.handshakeWaiters
    this.handshakeWaiters = []
    for (const w of waiters) {
      try {
        w.resolve()
      } catch {
        /* ignore */
      }
    }
  }

  private notifyUpstreamReady() {
    this.upstreamHandshakeComplete = true
    this.sessionReady = true
    this.resolveHandshakeWaiters()
    this.scheduleWarmIdleTimer()
    log('upstream ready (stream_ready)')
  }

  private scheduleWarmIdleTimer() {
    this.clearWarmIdleTimer()
    if (this.closed || this.recordingPcmSeen || !this.upstreamHandshakeComplete) return
    this.warmIdleTimer = setTimeout(() => {
      this.warmIdleTimer = null
      if (this.closed || this.recordingPcmSeen) return
      log('warm idle TTL exceeded — tearing down upstream (will re-warm on demand)')
      this.teardownUpstreamPreserveAdapter()
      this.listener?.({ type: 'warm_idle_teardown' })
    }, YoumiLiveAdapter.WARM_IDLE_TEARDOWN_MS)
  }

  private clearWarmIdleTimer() {
    if (this.warmIdleTimer) {
      clearTimeout(this.warmIdleTimer)
      this.warmIdleTimer = null
    }
  }

  /** Close WS + reset handshake flags; adapter stays alive for warmSession/pushPcm retry. */
  private teardownUpstreamPreserveAdapter() {
    this.clearWarmIdleTimer()
    this.sessionReady = false
    this.upstreamHandshakeComplete = false
    this.boundSampleRate = null
    this.activeRef.active = false
    const dying = this.session
    this.session = null
    this.pcmQueue = []
    try {
      dying?.destroy()
    } catch {
      /* ignore */
    }
  }

  private destroyStreamingSessionHard(reason: string) {
    log('destroy streaming session', { reason })
    this.teardownUpstreamPreserveAdapter()
  }

  /**
   * Ensure one WS session exists for `sampleRate`. Single-flight guard: replaces session if sampleRate differs.
   */
  private ensureStreamingSession(sampleRate: number) {
    if (this.session && this.boundSampleRate === sampleRate) return
    if (this.session && this.boundSampleRate !== sampleRate) {
      this.destroyStreamingSessionHard('sample_rate_change')
    }
    if (!this.session) {
      this.initSession(sampleRate)
    }
  }

  // ── Audio input ───────────────────────────────────────────────────────────

  pushPcm(buffer: ArrayBuffer, sampleRate: number) {
    if (this.closed) return

    if (!this.speechOnsetMs) {
      const samples = new Int16Array(buffer)
      for (let i = 0; i < samples.length; i++) {
        if (Math.abs(samples[i]) > VOICE_ENERGY_THRESHOLD) {
          this.speechOnsetMs = Date.now()
          log('speech-onset detected')
          break
        }
      }
    }

    if (
      this.session &&
      this.boundSampleRate !== null &&
      sampleRate !== this.boundSampleRate
    ) {
      if (!this.rateMismatchReconnectDone) {
        this.rateMismatchReconnectDone = true
        log('sample rate mismatch — reconnect once', {
          bound: this.boundSampleRate,
          incoming: sampleRate,
        })
        this.destroyStreamingSessionHard('sample_rate_mismatch')
      } else {
        log('sample rate mismatch ignored (single reconnect already used)', {
          incoming: sampleRate,
        })
        return
      }
    }

    if (!this.session) this.initSession(sampleRate)

    if (this.sessionReady) {
      if (!this.loggedFirstPcmForwarded) {
        this.loggedFirstPcmForwarded = true
        const srMatch = this.lastWarmSampleRate === null || this.lastWarmSampleRate === sampleRate
        console.info(
          '[live-latency] adapter_pcm_forward_to_ws',
          JSON.stringify({
            bytes: buffer.byteLength,
            sampleRate,
            warmSampleRate: this.lastWarmSampleRate,
            sampleRateMatch: srMatch,
          }),
        )
        if (!srMatch) {
          console.warn(
            '[live-latency] sample_rate_mismatch_detected',
            JSON.stringify({ warmSampleRate: this.lastWarmSampleRate, recordingSampleRate: sampleRate }),
          )
        }
      }
      this.session?.sendPcm(buffer)
    } else {
      this.pcmQueue.push(buffer)
      if (this.pcmQueue.length > PCM_QUEUE_CAP) this.pcmQueue.shift()
    }
  }

  // ── Idle auto-reconnect ───────────────────────────────────────────────────

  /**
   * If the WS drops before recording starts (no PCM seen), automatically re-init
   * the session so the warm session heals without user action. Capped at 3 attempts
   * to avoid infinite loops on persistent server errors.
   */
  private scheduleIdleReconnectIfNeeded() {
    if (this.recordingPcmSeen || this.closed || !this.lastWarmSampleRate) return
    this.idleReconnectCount++
    if (this.idleReconnectCount > 3) {
      log('idle auto-reconnect budget exhausted', { attempts: this.idleReconnectCount })
      return
    }
    const sr = this.lastWarmSampleRate
    const backoffMs = this.idleReconnectCount * 500
    log('idle auto-reconnect scheduled', { attempt: this.idleReconnectCount, backoffMs })
    setTimeout(() => {
      if (!this.closed && !this.recordingPcmSeen) {
        log('idle auto-reconnect — initSession', { attempt: this.idleReconnectCount, sampleRate: sr })
        this.initSession(sr)
      }
    }, backoffMs)
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────

  private initSession(sampleRate: number) {
    if (this.closed) return
    this.sessionInitGeneration++
    const gen = this.sessionInitGeneration

    this.loggedFirstPcmForwarded = false
    this.rejectAllHandshakeWaiters(new Error('session_replaced'))
    this.clearHandshakeTimeout()
    this.upstreamHandshakeComplete = false
    this.sessionReady = false
    this.boundSampleRate = sampleRate

    const ref = { active: true }
    this.activeRef = ref
    const T_init = Date.now()
    log('init streaming session (server live-realtime-ws)', { sampleRate, nextSeg: `stream-${this.segCounter}` })

    this.session = new StreamingWsSession(sampleRate, {
      onOpen: () => {
        if (!ref.active || this.closed || gen !== this.sessionInitGeneration) return
        log('WS open — awaiting stream_ready before sending PCM', {
          wsOpenMs: Date.now() - T_init,
        })
      },

      onReady: () => {
        if (!ref.active || this.closed || gen !== this.sessionInitGeneration) return
        this.idleReconnectCount = 0
        this.notifyUpstreamReady()
        log('stream_ready — draining PCM queue', {
          queued: this.pcmQueue.length,
          readyMs: Date.now() - T_init,
          nextSeg: `stream-${this.segCounter}`,
        })
        this.listener?.({ type: 'connected' })
        for (const buf of this.pcmQueue) this.session?.sendPcm(buf)
        this.pcmQueue = []
      },

      onInterim: (text) => {
        if (!ref.active || this.closed || gen !== this.sessionInitGeneration || !text.trim()) return
        const now = Date.now()
        const trimmed = text.trim()

        const isFirst = !this.currentSegId
        if (isFirst) {
          this.currentSegId = `stream-${this.segCounter++}`
          this.interimRev = 0
          if (this.speechOnsetMs && !this.firstInterimLogged) {
            this.firstInterimLogged = true
            log('A-metric: speech-onset → first-interim', {
              onsetToFirstInterimMs: now - this.speechOnsetMs,
              segId: this.currentSegId,
            })
          }
          if (this.lastFinalMs) {
            log('inter-segment gap: last-final → first-interim', {
              gapMs: now - this.lastFinalMs,
              segId: this.currentSegId,
            })
          }
          log('new segment', {
            segId: this.currentSegId,
            firstWords: trimmed.slice(0, 60),
            sinceSessionInitMs: now - T_init,
          })
        }

        this.lastInterimMs = now
        const rev = ++this.interimRev
        this.lastInterimSegmentId = this.currentSegId
        this.listener?.({ type: 'en_interim', segmentId: this.currentSegId, rev, text: trimmed })
      },

      onFinal: (text) => {
        if (!ref.active || this.closed || gen !== this.sessionInitGeneration || !text.trim()) return
        const now = Date.now()
        const trimmed = text.trim()

        const segId =
          this.currentSegId ||
          this.lastInterimSegmentId ||
          `stream-${this.segCounter++}`
        if (import.meta.env.DEV) {
          log('B-metric: last-interim → final', {
            lastInterimToFinalMs: this.lastInterimMs ? now - this.lastInterimMs : -1,
            gapSinceLastFinalMs: this.lastFinalMs ? now - this.lastFinalMs : -1,
            segId,
          })
          log('en_final', { segId, len: trimmed.length, preview: trimmed.slice(0, 80) })
        }

        this.currentSegId = ''
        this.interimRev = 0
        this.lastInterimMs = 0
        this.firstInterimLogged = false
        this.speechOnsetMs = 0
        this.lastFinalMs = now

        this.listener?.({ type: 'connected' })
        this.listener?.({ type: 'en_final', segmentId: segId, text: trimmed })
        if (import.meta.env.DEV) {
          log('segment closed — waiting for next speech', { nextSeg: `stream-${this.segCounter}` })
        }
      },

      onStreamError: (code, message) => {
        if (!ref.active || this.closed || gen !== this.sessionInitGeneration) return
        log('stream_error — surfacing fatal engine error', {
          code,
          message,
          segId: this.currentSegId || '(none)',
        })
        ref.active = false
        this.sessionReady = false
        this.upstreamHandshakeComplete = false
        this.boundSampleRate = null
        this.rejectAllHandshakeWaiters(new Error(code))
        const dying = this.session
        this.session = null
        setTimeout(() => dying?.destroy(), 0)
        this.abandonCurrentSegment('stream_error')
        this.listener?.({ type: 'error', code, message, recoverable: false })
      },

      onError: (reason) => {
        if (!ref.active || this.closed || gen !== this.sessionInitGeneration) return
        log('RECONNECT — session error', { reason, segId: this.currentSegId || '(none)' })
        ref.active = false
        this.sessionReady = false
        this.upstreamHandshakeComplete = false
        this.boundSampleRate = null
        this.rejectAllHandshakeWaiters(new Error(String(reason)))
        const dying = this.session
        this.session = null
        setTimeout(() => dying?.destroy(), 0)
        this.abandonCurrentSegment('session_error')
        this.listener?.({ type: 'reconnecting', reason })
        this.scheduleIdleReconnectIfNeeded()
      },

      onClose: () => {
        if (!ref.active || this.closed || gen !== this.sessionInitGeneration) return
        ref.active = false
        this.sessionReady = false
        this.upstreamHandshakeComplete = false
        this.boundSampleRate = null
        this.rejectAllHandshakeWaiters(new Error('ws_closed'))
        this.session = null
        log('RECONNECT — session closed unexpectedly', { segId: this.currentSegId || '(none)' })
        this.abandonCurrentSegment('ws_closed')
        this.listener?.({ type: 'reconnecting', reason: 'ws_closed' })
        this.scheduleIdleReconnectIfNeeded()
      },
    }, { tokenGetter: this.opts.tokenGetter })

    this.session.connect()
  }

  /** Legacy blob path — no-op in streaming mode. Kept for interface compatibility. */
  async pushChunk(_blob: Blob, _mime: string): Promise<void> {
    void _blob
    void _mime
    // Audio arrives via pushPcm; blob slices are disabled in streaming mode.
  }
}
