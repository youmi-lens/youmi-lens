import { appendSegment, shouldFlushBuffer, FINAL_BUFFER_DEBOUNCE_MS } from './liveTranslationBuffer.mjs'
import { shouldTranslateInterim } from './liveTranslationPolicy.mjs'

/**
 * Server-side live translation for ONE live caption stream.
 *
 * Extracted verbatim from the `stream_start` closure in `liveRealtimeWs.mjs` so it
 * can be tested: the iPad build in production consumes exactly these events.
 * Nothing about the legacy behaviour changed — same scheduling, same sentence
 * buffer, same queue limits, same log lines, same legacy event fields. The
 * additions are PURELY ADDITIVE fields that let a client attach a translation to
 * the exact captions it belongs to without guessing:
 *
 *   interim  stream_translation  + draft_of  (the stream_final id this draft will become)
 *                                + revision  (monotonic request ticket, orders late responses)
 *   final    stream_translation  + source_ids (EVERY stream_final id the text covers, in order)
 *                                + source_text
 *   stream_interim               + final_id   (the stream_final id this interim will become)
 *
 * Existing consumers read `id`, `translated_text`, `translation_zh`,
 * `translation_language`, `is_final` and `source_text`; none of those changed.
 */
export function createLiveTranslationSession({
  wsSessionId,
  translationLanguage,
  sourceScript = 'latin',
  isEnabled,
  translateText,
  qwenSource,
  qwenTarget,
  send,
  getFinalSeq,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  info = (tag, payload) => console.info(tag, JSON.stringify(payload)),
  warn = (tag, payload) => console.warn(tag, JSON.stringify(payload)),
}) {
  const MAX_CONCURRENT_FINAL_TRANSLATIONS = 2
  const MAX_FINAL_TRANSLATION_QUEUE = 5

  let interimTimer = null
  let latestInterim = ''
  let lastTranslatedInterim = ''
  let lastTranslatedInterimAt = 0
  let interimGen = 0
  let revisionSeq = 0
  const finalQueue = []
  let activeFinal = 0

  // Sentence-aware buffer: finals are relayed to the client immediately, but their
  // TRANSLATION accumulates into a coherent phrase. The result is attached to the
  // LAST buffered id for legacy clients, and now also lists EVERY id it covers.
  let bufferText = ''
  let bufferIds = []
  let bufferTimer = null

  const zhExtra = (out) => (translationLanguage === 'zh-Hans' ? { translation_zh: out } : {})

  const scheduleInterim = () => {
    if (interimTimer) clearTimer(interimTimer)
    const expectedGen = interimGen
    interimTimer = setTimer(() => {
      interimTimer = null
      if (!isEnabled()) return
      if (expectedGen !== interimGen) return
      const text = latestInterim.trim()
      if (!shouldTranslateInterim(text, { lastText: lastTranslatedInterim, lastAt: lastTranslatedInterimAt, now: now(), script: sourceScript })) return
      const nextFinalSeq = getFinalSeq() + 1
      const id = `${wsSessionId}:draft:${nextFinalSeq}`
      const draftOf = `${wsSessionId}:${nextFinalSeq}`
      const revision = ++revisionSeq
      info('[liveRealtimeWs] live_translation_requested', { wsSessionId, id, textLen: text.length, interim: true })
      Promise.resolve(translateText(text, qwenTarget.name, qwenSource.name))
        .then((translatedText) => {
          if (expectedGen !== interimGen) return
          const out = typeof translatedText === 'string' ? translatedText.trim() : ''
          if (!out) return
          lastTranslatedInterim = text
          lastTranslatedInterimAt = now()
          info('[liveRealtimeWs] live_translation_ok', { wsSessionId, id, textLen: text.length, translationLen: out.length, interim: true })
          send({
            type: 'stream_translation',
            id,
            translated_text: out,
            translation_language: translationLanguage,
            ...zhExtra(out),
            is_final: false,
            source_text: text,
            draft_of: draftOf,
            revision,
          })
          info('[liveRealtimeWs] live_translation_sent', { wsSessionId, id, translationLen: out.length, interim: true })
        })
        .catch((err) => {
          warn('[liveRealtimeWs] live_translation_failed', {
            wsSessionId,
            id,
            interim: true,
            message: err instanceof Error ? err.message : String(err),
          })
        })
    }, 120)
  }

  const drainFinalQueue = () => {
    while (activeFinal < MAX_CONCURRENT_FINAL_TRANSLATIONS && finalQueue.length > 0) {
      const job = finalQueue.shift()
      if (!job) return
      if (now() - job.enqueuedAt > 8000) continue
      activeFinal += 1
      info('[liveRealtimeWs] live_translation_requested', { wsSessionId, id: job.id, textLen: job.text.length, interim: false })
      Promise.resolve(translateText(job.text, qwenTarget.name, qwenSource.name))
        .then((translatedText) => {
          const out = typeof translatedText === 'string' ? translatedText.trim() : ''
          if (!out) return
          info('[liveRealtimeWs] live_translation_ok', { wsSessionId, id: job.id, textLen: job.text.length, translationLen: out.length })
          send({
            type: 'stream_translation',
            id: job.id,
            translated_text: out,
            translation_language: translationLanguage,
            is_final: true,
            ...zhExtra(out),
            source_ids: job.ids,
            source_text: job.text,
          })
          info('[liveRealtimeWs] live_translation_sent', { wsSessionId, id: job.id, translationLen: out.length, interim: false })
        })
        .catch((err) => {
          warn('[liveRealtimeWs] live_translation_failed', {
            wsSessionId,
            id: job.id,
            interim: false,
            message: err instanceof Error ? err.message : String(err),
          })
        })
        .finally(() => {
          activeFinal -= 1
          drainFinalQueue()
        })
    }
  }

  const enqueueFinal = (ids, text) => {
    finalQueue.push({ id: ids[ids.length - 1], ids, text, enqueuedAt: now() })
    if (finalQueue.length > MAX_FINAL_TRANSLATION_QUEUE) {
      finalQueue.splice(0, finalQueue.length - MAX_FINAL_TRANSLATION_QUEUE)
    }
    drainFinalQueue()
  }

  const flushBuffer = () => {
    if (bufferTimer) {
      clearTimer(bufferTimer)
      bufferTimer = null
    }
    const text = bufferText.trim()
    const ids = bufferIds
    bufferText = ''
    bufferIds = []
    if (ids.length === 0 || !text) return
    if (!isEnabled()) return
    enqueueFinal(ids, text)
  }

  return {
    /** An interim caption was relayed to the client. */
    noteInterim(text) {
      latestInterim = typeof text === 'string' ? text : ''
      scheduleInterim()
    },

    /** A final caption (`id`) was relayed to the client. */
    noteFinal(id, text) {
      interimGen += 1
      latestInterim = ''
      lastTranslatedInterim = ''
      if (interimTimer) {
        clearTimer(interimTimer)
        interimTimer = null
      }
      const enabled = isEnabled()
      const trimmed = typeof text === 'string' ? text.trim() : ''
      info('[liveRealtimeWs] live_translation_gate_checked', {
        wsSessionId,
        id,
        enabled,
        envValuePresent: Boolean(process.env.YOUMI_LIVE_TRANSLATION_EXPERIMENT),
        textLen: trimmed.length,
      })
      if (!enabled) {
        info('[liveRealtimeWs] live_translation_skipped_gate_off', { wsSessionId, id, textLen: trimmed.length })
        return
      }
      if (!trimmed) return
      bufferText = appendSegment(bufferText, trimmed)
      if (!bufferIds.includes(id)) bufferIds.push(id)
      if (shouldFlushBuffer(bufferText) === 'flush') {
        flushBuffer()
      } else {
        if (bufferTimer) clearTimer(bufferTimer)
        bufferTimer = setTimer(flushBuffer, FINAL_BUFFER_DEBOUNCE_MS)
      }
    },

    /** Translate whatever has accumulated now (stream_stop). */
    flush: flushBuffer,

    /** Drop the pending buffer and timers without translating (re-start / close). */
    clear() {
      if (bufferTimer) {
        clearTimer(bufferTimer)
        bufferTimer = null
      }
      bufferText = ''
      bufferIds = []
    },
  }
}
