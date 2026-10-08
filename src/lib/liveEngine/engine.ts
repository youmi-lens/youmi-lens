/**
 * LiveEngine — consumes **streaming ASR text** from `YoumiLiveAdapter` (`en_interim` / `en_final`) and
 * the server's live **translation** of that same stream (`translation_interim` / `translation_final`).
 * Post-class transcription/summary stay out of this module.
 *
 * There is exactly ONE live translation path: the server translates on the persistent live WebSocket
 * (the path the iPad has always used) and names, by id, the captions each translation belongs to. This
 * module no longer calls any HTTP translation route, so a caption is never translated (or paid for) twice.
 * Original captions are emitted the instant they arrive; translations follow whenever the server
 * delivers them and carry the caption identity the model needs to attach them correctly.
 */
import { deOverlapForLanguage } from '../liveCaptionDeOverlap'
import { isSpaceDelimited, languageScript, type ContentLanguageCode } from '../contentLanguages'
import {
  isRejectedTranslationToken,
  normalizePrimaryPayloadOrReject,
  normalizeZhPayloadOrReject,
} from '../liveCaptionSanitize'
import {
  bumpEnFinalArrivalWall,
  bumpEnInterimArrivalWall,
  traceDeOverlap,
  traceEnFinal,
  traceEnInterim,
  traceInterimPipeline,
  traceReset,
} from '../liveCaptionTrace'
import { YoumiLiveAdapter, type YoumiAdapterOpts } from './adapters/youmiAdapter'
import type { TranslationLagTracker } from './translationLag'
import type { LiveEngineEvent, LiveEngineListener } from './types'

type StartOptions = {
  /**
   * The language being SPOKEN, frozen for this recording. It decides how captions
   * are validated and de-duplicated and what the live socket is told to recognise.
   * Defaults to English (the legacy behaviour).
   */
  sourceLanguage?: ContentLanguageCode
  /**
   * The lecture's translation language. Equal to `sourceLanguage` (or omitted) means
   * Original only: the server is told there is nothing to translate and performs no
   * translation work at all.
   */
  translationLanguage?: ContentLanguageCode
}

function log(tag: string, fields?: Record<string, unknown>) {
  if (fields) console.info(`[LiveEngine] ${tag}`, JSON.stringify(fields))
  else console.info(`[LiveEngine] ${tag}`)
}

export type LiveEngineOpts = Pick<YoumiAdapterOpts, 'tokenGetter'>

export class LiveEngine {
  private engineOpts: LiveEngineOpts
  private listener: LiveEngineListener | null = null
  private adapter: YoumiLiveAdapter | null = null
  private running = false
  private sourceLanguage: ContentLanguageCode = 'en'
  private translationLanguage: ContentLanguageCode = 'en'
  /** False for Original only / same language: the server is told there is nothing to translate. */
  private translationEnabled = false
  /** Latest EN interim text per segment (de-duplicates identical interims). */
  private latestEnInterimBySeg = new Map<string, string>()

  /** Monotonic: only grows via appending de-overlapped novelText from en_final events. */
  private committedEnFull = ''

  /**
   * Finalized captions still waiting for the translation that covers them. Lets the
   * Stop flow wait for the tail translation instead of guessing a delay.
   */
  private awaitingTranslation = new Set<string>()

  // Session-level timing for long-run diagnostics: ms since engine.start()
  private sessionStartMs = 0
  private elapsed(): number {
    return this.sessionStartMs ? Date.now() - this.sessionStartMs : 0
  }

  constructor(opts: LiveEngineOpts = {}) {
    this.engineOpts = opts
  }

  onEvent(listener: LiveEngineListener) {
    this.listener = listener
  }

  /** Client-measured original → translation lag (median / p90), for the acceptance gate. */
  get translationLag(): TranslationLagTracker | null {
    return this.adapter?.lag ?? null
  }

  start(opts: StartOptions) {
    if (this.running) this.stop()
    this.running = true
    this.sourceLanguage = opts.sourceLanguage ?? 'en'
    this.translationLanguage = opts.translationLanguage ?? this.sourceLanguage
    this.translationEnabled = this.translationLanguage !== this.sourceLanguage
    this.latestEnInterimBySeg.clear()
    this.awaitingTranslation.clear()
    this.committedEnFull = ''
    this.sessionStartMs = Date.now()
    traceReset()
    log('start', { translation: this.translationEnabled })
    this.emit({ type: 'status', status: 'starting' })
    const adapter = new YoumiLiveAdapter({
      tokenGetter: this.engineOpts.tokenGetter,
      sourceLanguage: this.sourceLanguage,
      // The REAL target: the server translates on this same socket and tells us, by id,
      // which captions each translation belongs to. Equal to the source = Original only,
      // and the server then does no translation work at all.
      translationLanguage: this.translationLanguage,
    })
    this.adapter = adapter
    adapter.onEvent((ev) => {
      if (!this.running) return
      if (ev.type === 'connected') {
        log('adapter connected')
        this.emit({ type: 'status', status: 'connected' })
        return
      }
      if (ev.type === 'warm_idle_teardown') {
        // Intentional TTL expiry ends this idle warm lifecycle. Keep the adapter
        // ready for demand-driven PCM, but do not open another paid idle session.
        log('warm_idle_teardown — waiting for recording')
        return
      }
      if (ev.type === 'reconnecting') {
        log('adapter reconnecting', { reason: ev.reason })
        this.emit({ type: 'status', status: 'reconnecting', detail: ev.reason })
        return
      }
      if (ev.type === 'closed') {
        log('adapter closed')
        this.emit({ type: 'status', status: 'closed' })
        return
      }
      if (ev.type === 'error') {
        log('error', { code: ev.code, message: ev.message })
        this.emit({ type: 'error', code: ev.code, message: ev.message, recoverable: ev.recoverable })
        return
      }
      if (ev.type === 'en_interim') {
        const clean = normalizePrimaryPayloadOrReject(ev.text, this.sourceLanguage)
        if (!clean) return
        traceEnInterim(ev.segmentId, ev.rev, clean)
        const prev = this.latestEnInterimBySeg.get(ev.segmentId) ?? ''
        if (clean === prev) return
        this.latestEnInterimBySeg.set(ev.segmentId, clean)

        const deo = deOverlapForLanguage(this.committedEnFull, clean, languageScript(this.sourceLanguage))
        traceDeOverlap('en_interim', ev.segmentId, clean.length, deo)
        const rawTok = clean.split(/\s+/).filter(Boolean).length
        traceInterimPipeline(ev.segmentId, ev.rev, {
          rawTok,
          novelTok: deo.novelTokenCount,
          shrink6to2: rawTok >= 6 && deo.novelTokenCount <= 2,
        })
        // The original goes out IMMEDIATELY — nothing here waits on translation.
        this.emit({ type: 'en_interim', segmentId: ev.segmentId, rev: ev.rev, text: deo.novelText })
        bumpEnInterimArrivalWall()
        return
      }
      if (ev.type === 'en_final') {
        const cleanFinal = normalizePrimaryPayloadOrReject(ev.text, this.sourceLanguage)
        if (!cleanFinal) return
        traceEnFinal(ev.segmentId, cleanFinal)

        const deo = deOverlapForLanguage(this.committedEnFull, cleanFinal, languageScript(this.sourceLanguage))
        traceDeOverlap('en_final', ev.segmentId, cleanFinal.length, deo)

        if (!deo.novelText.trim()) {
          log('en_final skipped (no novel text)', {
            segmentId: ev.segmentId,
            incomingLen: cleanFinal.length,
            overlapTokens: deo.overlapTokenCount,
            sessionMs: this.elapsed(),
          })
          return
        }

        this.committedEnFull += (this.committedEnFull && isSpaceDelimited(this.sourceLanguage) ? ' ' : '') + deo.novelText
        log('en_final', {
          segmentId: ev.segmentId,
          novelLen: deo.novelText.length,
          committedLen: this.committedEnFull.length,
          overlapTokens: deo.overlapTokenCount,
          sessionMs: this.elapsed(),
          awaitingTranslation: this.awaitingTranslation.size,
        })
        if (this.translationEnabled) this.awaitingTranslation.add(ev.segmentId)
        this.emit({ type: 'en_final', segmentId: ev.segmentId, text: deo.novelText })
        bumpEnFinalArrivalWall()
        return
      }
      if (ev.type === 'translation_interim') {
        if (!this.translationEnabled) return
        const text = this.acceptTranslationText(ev.text, ev.sourceText)
        if (!text) return
        this.emit({
          type: 'zh_interim',
          segmentId: ev.segmentId,
          rev: ev.revision,
          text,
          sourceEn: ev.sourceText ?? '',
        })
        return
      }
      if (ev.type === 'translation_final') {
        if (!this.translationEnabled) return
        const text = this.acceptTranslationText(ev.text, ev.sourceText)
        for (const id of ev.segmentIds) this.awaitingTranslation.delete(id)
        if (!text) return
        this.emit({
          type: 'zh_final',
          segmentId: ev.segmentIds[ev.segmentIds.length - 1],
          segmentIds: ev.segmentIds,
          text,
          sourceEn: ev.sourceText ?? '',
        })
      }
    })
    adapter.start()
  }

  /**
   * The translation text, or null when it must not be shown.
   *
   * Chinese and English targets keep their script guards (an error token, a mostly-Han "English" line,
   * a Latin-garbled "Chinese" line). Every other target — Japanese, French, Spanish, Korean — gets only
   * the generic checks: not empty, not a server error token, and not the source handed back unchanged.
   * No Chinese assumption is applied to them: Latin terms inside Japanese or Korean are legitimate.
   */
  private acceptTranslationText(raw: string, sourceText: string | null): string | null {
    const text = raw.trim()
    if (!text) return null
    if (isRejectedTranslationToken(text)) return null
    const norm = (v: string) => v.replace(/\s+/g, ' ').trim().toLowerCase()
    if (sourceText && norm(text) === norm(sourceText)) return null // the source echoed back is not a translation
    if (this.translationLanguage === 'zh-Hans') return normalizeZhPayloadOrReject(text, 'zh')
    if (this.translationLanguage === 'en') return normalizeZhPayloadOrReject(text, 'en')
    return text
  }

  /**
   * Pre-connect app WS + DashScope before PCM (`stream_ready`). Idempotent for same healthy session.
   */
  async warmUpstream(sampleRate: number): Promise<void> {
    if (!this.running || !this.adapter) return
    this.emit({ type: 'status', status: 'warming' })
    await this.adapter.warmSession(sampleRate)
  }

  /**
   * Call after local microphone capture has stopped so the ASR provider can emit
   * trailing finals. Does not tear down the adapter (still receives WS messages).
   * `stream_stop` also makes the server translate the trailing phrase immediately.
   */
  notifyAudioCaptureEnded() {
    if (!this.running) return
    log('notifyAudioCaptureEnded')
    this.adapter?.notifyAudioEnd()
  }

  /**
   * Wait for trailing stream_final events and the translation that covers them after capture end.
   * `minTailMs` gives ASR time to flush; exit early once every finalized caption has its translation.
   */
  async waitAfterCaptureEnd(opts: { minTailMs: number; maxMs: number }): Promise<void> {
    if (!this.running) return
    const t0 = Date.now()
    while (Date.now() - t0 < opts.maxMs) {
      await new Promise((r) => setTimeout(r, 120))
      const elapsed = Date.now() - t0
      if (elapsed >= opts.minTailMs && this.awaitingTranslation.size === 0) break
    }
    log('waitAfterCaptureEnd', {
      waitedMs: Date.now() - t0,
      awaitingTranslation: this.awaitingTranslation.size,
    })
  }

  stop() {
    if (!this.running) return
    this.running = false
    this.adapter?.stop()
    this.adapter = null
    this.awaitingTranslation.clear()
    this.emit({ type: 'status', status: 'closed' })
    log('stop', { totalSessionMs: this.elapsed() })
  }

  pushAudioChunk(blob: Blob, mime: string) {
    if (!this.running || !this.adapter) {
      log('pushAudioChunk ignored', {
        running: this.running,
        hasAdapter: Boolean(this.adapter),
        bytes: blob.size,
        mime,
      })
      return
    }
    log('pushAudioChunk', { bytes: blob.size, mime })
    void this.adapter.pushChunk(blob, mime)
  }

  /** Push a raw PCM Int16 frame from AudioContext capture (streaming path). */
  pushPcmChunk(buffer: ArrayBuffer, sampleRate: number) {
    if (!this.running || !this.adapter) return
    this.adapter.markRecordingPcmActivity()
    this.adapter.pushPcm(buffer, sampleRate)
  }

  private emit(ev: LiveEngineEvent) {
    this.listener?.(ev)
  }
}
