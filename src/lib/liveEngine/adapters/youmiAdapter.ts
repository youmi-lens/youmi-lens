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

import { StreamingWsSession, type StreamTranslation } from '../streamingWsSession'
import { TranslationLagTracker } from '../translationLag'

export type YoumiAdapterOpts = {
  tokenGetter?: () => Promise<string | null>
  /** Canonical id of the language being spoken (see `contentLanguages`). */
  sourceLanguage?: string
  /** Equal to `sourceLanguage` ⇒ the server has nothing to translate. */
  translationLanguage?: string
}

type YoumiAdapterEvent =
  | { type: 'connected' }
  /** Intentional idle expiry; the next recording PCM opens a fresh session on demand. */
  | { type: 'warm_idle_teardown' }
  | { type: 'reconnecting'; reason: string }
  | { type: 'closed' }
  | { type: 'en_interim'; segmentId: string; rev: number; text: string }
  | { type: 'en_final'; segmentId: string; text: string }
  /** A draft translation for the open caption (server `draft_of`, mapped to our segment). */
  | { type: 'translation_interim'; segmentId: string; revision: number; text: string; sourceText: string | null }
  /** A final translation covering EVERY segment the server named in `source_ids`. */
  | { type: 'translation_final'; segmentIds: string[]; text: string; sourceText: string | null }
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
  private idleReconnectTimer: ReturnType<typeof setTimeout> | null = null
  private audioEnded = false
  /** First PCM after user actually records — disables warm-idle TTL teardown. */
  private recordingPcmSeen = false
  /** Sample rate used in the last warmSession() call — used to reconnect in idle if WS drops. */
  private lastWarmSampleRate: number | null = null
  /** Idle reconnect budget for this start lifecycle, never reset by stream_ready. */
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

  /**
   * Server caption id → our local segment id. Built ONLY from ids the server
   * assigned (`stream_interim.final_id`, `stream_final.id`); a translation is
   * attached through this table and nowhere else — never to "the latest caption".
   */
  private segByServerId = new Map<string, string>()
  /** Local segments that already received a final (a segment gets at most one server final). */
  private finalizedSegIds = new Set<string>()
  /** Highest draft-translation revision accepted per segment: an older response that arrives late is stale. */
  private lastDraftRevBySeg = new Map<string, number>()
  private static readonly MAX_SERVER_IDS = 600
  readonly lag = new TranslationLagTracker()

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
    this.audioEnded = false
    this.lastWarmSampleRate = null
    this.idleReconnectCount = 0
    this.rejectAllHandshakeWaiters(new Error('adapter_restarted'))
    this.clearHandshakeTimeout()
    this.clearWarmIdleTimer()
    this.clearIdleReconnectTimer()

    this.currentSegId = ''
    this.lastInterimSegmentId = ''
    this.segCounter = 0
    this.interimRev = 0
    this.lastInterimMs = 0
    this.speechOnsetMs = 0
    this.segByServerId.clear()
    this.finalizedSegIds.clear()
    this.lastDraftRevBySeg.clear()
    this.lag.reset()
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
    this.audioEnded = true
    this.clearWarmIdleTimer()
    this.clearIdleReconnectTimer()
    log('notifyAudioEnd (stream_stop only)')
    this.session?.stop()
  }

  stop() {
    this.closed = true
    this.activeRef.active = false
    this.rejectAllHandshakeWaiters(new Error('adapter_stopped'))
    this.clearHandshakeTimeout()
    this.clearWarmIdleTimer()
    this.clearIdleReconnectTimer()
    log('adapter stop')
    this.session?.stop()
    setTimeout(() => {
      this.session?.destroy()
      this.session = null
    }, 500)
    this.listener?.({ type: 'closed' })
  }

  // ── Translation routing (identity only) ───────────────────────────────────

  private rememberServerId(serverId: string, segmentId: string) {
    this.segByServerId.set(serverId, segmentId)
    if (this.segByServerId.size > YoumiLiveAdapter.MAX_SERVER_IDS) {
      this.segByServerId.delete(this.segByServerId.keys().next().value as string)
    }
  }

  /**
   * Attach a server translation to the captions it names. A translation whose
   * identity is missing, unknown, or only partly known is dropped and logged —
   * the one thing this must never do is guess which caption it belongs to.
   */
  private routeTranslation(t: StreamTranslation) {
    if (!t.final) {
      const segmentId = t.draftOf ? this.segByServerId.get(t.draftOf) : undefined
      if (!segmentId || t.revision === null) {
        log('translation draft dropped (no identity)', { hasDraftOf: Boolean(t.draftOf), mapped: Boolean(segmentId), hasRevision: t.revision !== null })
        return
      }
      // Draft requests run concurrently on the server, so an OLDER one can finish after a newer one
      // (seen on Production). It is never shown, so it must not count as visible latency either.
      if (t.revision <= (this.lastDraftRevBySeg.get(segmentId) ?? 0)) {
        log('translation draft dropped (older revision arrived late)', { revision: t.revision })
        return
      }
      this.lastDraftRevBySeg.set(segmentId, t.revision)
      const sample = this.lag.noteInterimTranslation(segmentId, t.sourceText)
      if (sample) console.info('[live-latency] translation_lag', JSON.stringify({ kind: 'interim', lagMs: sample.lagMs }))
      this.listener?.({ type: 'translation_interim', segmentId, revision: t.revision, text: t.text, sourceText: t.sourceText })
      return
    }
    if (!t.sourceIds) {
      log('translation dropped (server sent no source_ids)', {})
      return
    }
    const segmentIds: string[] = []
    for (const serverId of t.sourceIds) {
      const segmentId = this.segByServerId.get(serverId)
      if (!segmentId) {
        log('translation dropped (a source caption is unknown here)', { sources: t.sourceIds.length })
        return
      }
      if (!segmentIds.includes(segmentId)) segmentIds.push(segmentId)
    }
    const sample = this.lag.noteFinalTranslation(segmentIds)
    if (sample) console.info('[live-latency] translation_lag', JSON.stringify({ kind: 'final', lagMs: sample.lagMs, captions: segmentIds.length }))
    this.listener?.({ type: 'translation_final', segmentIds, text: t.text, sourceText: t.sourceText })
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
    this.clearIdleReconnectTimer()
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
    if (this.closed || this.audioEnded) return
    this.markRecordingPcmActivity()

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
    if (this.recordingPcmSeen || this.closed || this.audioEnded || !this.lastWarmSampleRate || this.idleReconnectTimer) return
    this.idleReconnectCount++
    if (this.idleReconnectCount > 3) {
      log('idle auto-reconnect budget exhausted', { attempts: this.idleReconnectCount })
      return
    }
    const sr = this.lastWarmSampleRate
    const backoffMs = this.idleReconnectCount * 500
    log('idle auto-reconnect scheduled', { attempt: this.idleReconnectCount, backoffMs })
    const generation = this.sessionInitGeneration
    this.idleReconnectTimer = setTimeout(() => {
      this.idleReconnectTimer = null
      if (!this.closed && !this.recordingPcmSeen && !this.audioEnded && generation === this.sessionInitGeneration && !this.session) {
        log('idle auto-reconnect — initSession', { attempt: this.idleReconnectCount, sampleRate: sr })
        this.initSession(sr)
      }
    }, backoffMs)
  }

  private clearIdleReconnectTimer() {
    if (this.idleReconnectTimer) clearTimeout(this.idleReconnectTimer)
    this.idleReconnectTimer = null
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────

  private initSession(sampleRate: number) {
    if (this.closed || this.audioEnded) return
    this.clearIdleReconnectTimer()
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

      onInterim: (text, meta) => {
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
        if (meta.finalId) this.rememberServerId(meta.finalId, this.currentSegId)
        this.lag.noteInterim(this.currentSegId, trimmed)
        this.listener?.({ type: 'en_interim', segmentId: this.currentSegId, rev, text: trimmed })
      },

      onFinal: (text, meta) => {
        if (!ref.active || this.closed || gen !== this.sessionInitGeneration || !text.trim()) return
        const now = Date.now()
        const trimmed = text.trim()

        // Burst finals (no interim between them) used to reuse the previous caption's segment, and
        // the second final then OVERWROTE the first in the transcript. The server numbers every
        // final, so when it gives us an id each final is its own caption: reuse the last interim's
        // segment only if no final has claimed it yet. (An older server sends no id; its behaviour
        // is unchanged.)
        const reusableInterimSeg =
          this.lastInterimSegmentId && !(meta.id && this.finalizedSegIds.has(this.lastInterimSegmentId))
            ? this.lastInterimSegmentId
            : ''
        const segId = this.currentSegId || reusableInterimSeg || `stream-${this.segCounter++}`
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
        if (meta.id) this.rememberServerId(meta.id, segId)
        this.finalizedSegIds.add(segId)
        if (this.finalizedSegIds.size > YoumiLiveAdapter.MAX_SERVER_IDS) this.finalizedSegIds.delete(this.finalizedSegIds.keys().next().value as string)
        this.lag.noteFinal(segId)

        this.listener?.({ type: 'connected' })
        this.listener?.({ type: 'en_final', segmentId: segId, text: trimmed })
        if (import.meta.env.DEV) {
          log('segment closed — waiting for next speech', { nextSeg: `stream-${this.segCounter}` })
        }
      },

      onTranslation: (translation) => {
        if (!ref.active || this.closed || gen !== this.sessionInitGeneration) return
        this.routeTranslation(translation)
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
    }, {
      tokenGetter: this.opts.tokenGetter,
      sourceLanguage: this.opts.sourceLanguage,
      translationLanguage: this.opts.translationLanguage,
    })

    this.session.connect()
  }

  /** Legacy blob path — no-op in streaming mode. Kept for interface compatibility. */
  async pushChunk(_blob: Blob, _mime: string): Promise<void> {
    // Audio arrives via pushPcm; blob slices are disabled in streaming mode.
  }
}
