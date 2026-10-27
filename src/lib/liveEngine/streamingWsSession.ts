/**
 * Client-side streaming WebSocket session for live ASR (provider-agnostic).
 *
 * Protocol (/api/live-realtime-ws):
 *   1. WS open  ->  send { type: 'stream_start', sampleRate }
 *   2. Server responds { type: 'stream_ready' } once ASR provider is live
 *   3. Send binary ArrayBuffer frames (Int16 PCM continuously)
 *   4. Receive { type: 'stream_interim', text } for in-progress sentences
 *   5. Receive { type: 'stream_final', text } for completed sentences
 *   6. Send { type: 'stream_stop' } when recording ends
 *
 * Server-side ASR: DashScope streaming by default (see `server/liveRealtimeWs.mjs`).
 */

import { getAiApiBase } from '../ai/apiBase'
import { traceWsClosed } from '../liveCaptionTrace'

export type StreamingWsEvents = {
  /** WebSocket connection established; stream_start sent. ASR provider may not be ready yet. */
  onOpen?: () => void
  /** ASR provider confirmed live (stream_ready received). Safe to drain PCM queue now. */
  onReady?: () => void
  onInterim?: (text: string) => void
  onFinal?: (text: string) => void
  /** Server-declared stream failure (auth/quota/upstream), not a transport reconnect signal. */
  onStreamError?: (code: string, message: string) => void
  onError?: (reason: string) => void
  onClose?: () => void
}

export type StreamingWsOpts = {
  /** Called each time the WS opens to get a fresh JWT for the stream_start auth check. */
  tokenGetter?: () => Promise<string | null>
}

function wsUrl(): string {
  const base = getAiApiBase()
  const trimmed = base.replace(/\/$/, '')
  if (/^wss?:\/\//i.test(trimmed)) return `${trimmed}/live-realtime-ws`
  if (/^https?:\/\//i.test(trimmed))
    return `${trimmed.replace(/^http/i, 'ws')}/live-realtime-ws`
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const rel = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return `${proto}://${window.location.host}${rel}/live-realtime-ws`
}

/** Human-readable WebSocket close codes (RFC 6455 + common practice). */
function describeCloseCode(code: number): string {
  const m: Record<number, string> = {
    1000: 'normal_closure',
    1001: 'going_away',
    1002: 'protocol_error',
    1003: 'unsupported_data',
    1006: 'abnormal_closure_no_close_frame',
    1007: 'invalid_payload_data',
    1008: 'policy_violation',
    1009: 'message_too_big',
    1010: 'mandatory_extension',
    1011: 'internal_server_error',
    1012: 'service_restart',
    1013: 'try_again_later',
    1015: 'tls_handshake_failure',
  }
  return m[code] ?? `code_${code}`
}

export class StreamingWsSession {
  private ws: WebSocket | null = null
  private events: StreamingWsEvents
  private opts: StreamingWsOpts
  private sampleRate: number
  private destroyed = false
  /** True after JS calls ws.close() from destroy(); distinguishes client-initiated teardown in onclose. */
  private clientCloseRequested = false
  private wsReady = false

  // Latency instrumentation (all in ms, from Date.now())
  private T_connect = 0
  private T_ws_open = 0
  private T_stream_ready = 0
  private T_first_interim = 0
  private T_first_final = 0
  private interimCount = 0
  /** Last time a PCM frame was accepted by WebSocket.send (client → app server). */
  private lastPcmSentAt = 0
  private pcmFramesSent = 0

  constructor(sampleRate: number, events: StreamingWsEvents, opts: StreamingWsOpts = {}) {
    this.sampleRate = sampleRate
    this.events = events
    this.opts = opts
  }

  connect() {
    if (this.destroyed) return
    this.clientCloseRequested = false
    this.T_connect = Date.now()
    this.lastPcmSentAt = 0
    this.pcmFramesSent = 0
    const url = wsUrl()
    console.info('[StreamingWs] reconnect_attempt', JSON.stringify({ urlHostHint: url.slice(0, 48), sampleRate: this.sampleRate }))
    console.info('[StreamingWs] ws_connect_begin', JSON.stringify({ sampleRate: this.sampleRate }))
    const ws = new WebSocket(url)
    this.ws = ws
    ws.binaryType = 'arraybuffer'

    ws.onopen = async () => {
      if (this.destroyed) {
        ws.close(1001, 'destroyed_before_open')
        return
      }
      this.T_ws_open = Date.now()
      // Fetch fresh JWT for server-side beta gate check
      let token: string | null = null
      try { token = await this.opts.tokenGetter?.() ?? null } catch { /* ignore */ }
      const streamStartMsg: Record<string, unknown> = { type: 'stream_start', sampleRate: this.sampleRate }
      if (token) streamStartMsg.token = token
      ws.send(JSON.stringify(streamStartMsg))
      this.wsReady = true
      console.info('[StreamingWs] reconnect_success', JSON.stringify({ wsOpenMs: this.T_ws_open - this.T_connect }))
      console.info('[StreamingWs] ws_open', JSON.stringify({ sampleRate: this.sampleRate, streamStartSent: true, hasToken: Boolean(token) }))
      this.events.onOpen?.()
    }

    ws.onmessage = (ev: MessageEvent) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }

      if (msg.type === 'stream_ready') {
        this.T_stream_ready = Date.now()
        console.info('[StreamingWs] ASR provider live (stream_ready)', {
          readyMs: this.T_stream_ready - this.T_connect,
        })
        this.events.onReady?.()
      } else if (msg.type === 'stream_interim' && typeof msg.text === 'string') {
        const now = Date.now()
        this.interimCount++
        if (!this.T_first_interim) {
          this.T_first_interim = now
          console.info('[StreamingWs] TIMING first-interim', {
            connectToFirstInterimMs: now - this.T_connect,
            readyToFirstInterimMs: this.T_stream_ready ? now - this.T_stream_ready : -1,
            wsConnectMs: this.T_ws_open - this.T_connect,
            readyMs: this.T_stream_ready ? this.T_stream_ready - this.T_connect : -1,
          })
        }
        this.events.onInterim?.(msg.text as string)
      } else if (msg.type === 'stream_final' && typeof msg.text === 'string') {
        const now = Date.now()
        if (!this.T_first_final) {
          this.T_first_final = now
          if (import.meta.env.DEV) {
            console.info('[StreamingWs] TIMING first-final', {
              connectToFinalMs: now - this.T_connect,
              interimToFinalMs: this.T_first_interim ? now - this.T_first_interim : -1,
            })
          }
        }
        if (import.meta.env.DEV) {
          console.info('[StreamingWs] final', {
            len: (msg.text as string).length,
            sinceConnectMs: now - this.T_connect,
          })
        }
        this.events.onFinal?.(msg.text as string)
      } else if (msg.type === 'stream_error') {
        // Prefer structured code field for beta gate errors; fall back to message string
        const reason = typeof msg.code === 'string' ? msg.code
          : typeof msg.message === 'string' ? msg.message
          : 'stream_error'
        const message = typeof msg.message === 'string' ? msg.message : reason
        console.warn('[StreamingWs] FAIL server error', { reason, message })
        this.events.onStreamError?.(reason, message)
      }
    }

    ws.onerror = () => {
      console.warn('[StreamingWs] ws_error', JSON.stringify({ destroyed: this.destroyed }))
      if (!this.destroyed) this.events.onError?.('ws_connect_failed')
    }

    ws.onclose = (ev: CloseEvent) => {
      const code = ev.code
      const reason = typeof ev.reason === 'string' ? ev.reason : ''
      const who =
        this.clientCloseRequested || this.destroyed
          ? 'client_js_closed_socket'
          : ev.wasClean
            ? 'peer_clean_close'
            : 'abnormal_or_peer_unclean'

      console.warn(
        '[StreamingWs] ws_close',
        JSON.stringify({
          code,
          codeLabel: describeCloseCode(code),
          reason: reason.slice(0, 500),
          wasClean: ev.wasClean,
          whoClosed: who,
          pcmFramesSent: this.pcmFramesSent,
          lastPcmSentAgeMs: this.lastPcmSentAt ? Date.now() - this.lastPcmSentAt : -1,
          destroyed: this.destroyed,
          clientCloseRequested: this.clientCloseRequested,
        }),
      )

      this.wsReady = false
      this.ws = null
      if (!this.destroyed) {
        traceWsClosed('ws_onclose')
        this.events.onClose?.()
      }
    }
  }

  /** Send a raw Int16 PCM ArrayBuffer to the server -> DashScope. */
  sendPcm(buffer: ArrayBuffer) {
    if (!this.wsReady || this.destroyed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const now = Date.now()
    this.lastPcmSentAt = now
    this.pcmFramesSent += 1
    if (this.pcmFramesSent === 1) {
      console.info(
        '[StreamingWs] ws_first_pcm_sent',
        JSON.stringify({
          bytes: buffer.byteLength,
          msAfterWsOpen: this.T_ws_open ? now - this.T_ws_open : -1,
          msAfterConnect: now - this.T_connect,
        }),
      )
    }
    this.ws.send(buffer)
  }

  /** Signal end of audio stream; DashScope will flush remaining text. */
  stop() {
    if (!this.ws || !this.wsReady) return
    try {
      this.ws.send(JSON.stringify({ type: 'stream_stop' }))
    } catch {
      /* ignore */
    }
  }

  destroy() {
    this.destroyed = true
    this.wsReady = false
    if (this.ws) {
      this.clientCloseRequested = true
      try {
        this.ws.close(1000, 'client_destroy')
      } catch {
        /* ignore */
      }
      this.ws = null
    }
  }
}
