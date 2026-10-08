import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamingWsEvents, StreamingWsOpts } from './streamingWsSession'

const sockets: Array<{ events: StreamingWsEvents; opts: StreamingWsOpts; send: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = []
vi.mock('./streamingWsSession', () => ({
  StreamingWsSession: class {
    private socket: typeof sockets[number]
    constructor(_rate: number, events: StreamingWsEvents, opts: StreamingWsOpts) {
      this.socket = { events, opts, send: vi.fn(), destroy: vi.fn(), stop: vi.fn() }
      sockets.push(this.socket)
    }
    connect() {}
    sendPcm(buffer: ArrayBuffer) { this.socket.send(buffer) }
    stop() { this.socket.stop() }
    destroy() { this.socket.destroy() }
  },
}))
import { LiveEngine } from './engine'
import { YoumiLiveAdapter } from './adapters/youmiAdapter'

const engines: LiveEngine[] = []
const pcm = () => new Int16Array([1000, -1000]).buffer
async function warm() {
  const engine = new LiveEngine()
  engines.push(engine)
  engine.start({ sourceLanguage: 'ja', translationLanguage: 'en' })
  const warming = engine.warmUpstream(24000)
  sockets.at(-1)!.events.onReady?.()
  await warming
  return engine
}
beforeEach(() => { vi.useFakeTimers(); sockets.length = 0 })
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('bounded pre-recording warm lifecycle', () => {
  it('intentional TTL teardown leaves an idle engine dormant for hours', async () => {
    await warm()
    await vi.advanceTimersByTimeAsync(YoumiLiveAdapter.WARM_IDLE_TEARDOWN_MS)
    expect(sockets[0].destroy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000)
    expect(sockets).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('Start after expiry opens one usable session and buffers the first PCM until ready', async () => {
    const engine = await warm()
    await vi.advanceTimersByTimeAsync(YoumiLiveAdapter.WARM_IDLE_TEARDOWN_MS)
    const frame = pcm()
    engine.pushPcmChunk(frame, 24000)
    expect(sockets).toHaveLength(2)
    expect(sockets[1].opts).toMatchObject({ sourceLanguage: 'ja', translationLanguage: 'en' })
    expect(sockets[1].send).not.toHaveBeenCalled()
    sockets[1].events.onReady?.()
    expect(sockets[1].send).toHaveBeenCalledWith(frame)
    await vi.advanceTimersByTimeAsync(3 * YoumiLiveAdapter.WARM_IDLE_TEARDOWN_MS)
    expect(sockets).toHaveLength(2)
    expect(sockets[1].destroy).not.toHaveBeenCalled()
  })

  it('successful idle reconnects do not reset the three-attempt budget', async () => {
    await warm()
    for (let attempt = 1; attempt <= 3; attempt++) {
      sockets.at(-1)!.events.onClose?.()
      await vi.advanceTimersByTimeAsync(attempt * 500)
      expect(sockets).toHaveLength(attempt + 1)
      sockets.at(-1)!.events.onReady?.()
    }
    sockets.at(-1)!.events.onClose?.()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(sockets).toHaveLength(4)
  })

  it('recording remains usable even when the idle reconnect budget was exhausted', async () => {
    const engine = await warm()
    for (let attempt = 1; attempt <= 4; attempt++) {
      sockets.at(-1)!.events.onClose?.()
      await vi.advanceTimersByTimeAsync(attempt * 500)
      if (attempt < 4) sockets.at(-1)!.events.onReady?.()
    }
    engine.pushPcmChunk(pcm(), 24000)
    expect(sockets).toHaveLength(5)
    sockets[4].events.onReady?.()
    expect(sockets[4].send).toHaveBeenCalledTimes(1)
  })

  it('a real recording failure reconnects on the next PCM without dropping the queued frame', async () => {
    const engine = await warm()
    engine.pushPcmChunk(pcm(), 24000)
    sockets[0].events.onError?.('transient_network')
    const frame = pcm()
    engine.pushPcmChunk(frame, 24000)
    sockets[1].events.onReady?.()
    expect(sockets[1].send).toHaveBeenCalledWith(frame)
    expect(sockets).toHaveLength(2)
  })

  it('Stop cancels a pending idle reconnect and leaves no session loop', async () => {
    const engine = await warm()
    sockets[0].events.onClose?.()
    engine.stop()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(sockets).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('audio end prevents reconnect during the tail-drain interval', async () => {
    const engine = await warm()
    sockets[0].events.onClose?.()
    engine.notifyAudioCaptureEnded()
    engine.pushPcmChunk(pcm(), 24000)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(sockets).toHaveLength(1)
  })

  it('a new recording after Stop gets a fresh usable session', async () => {
    const engine = await warm()
    engine.stop()
    await vi.advanceTimersByTimeAsync(500)
    engine.start({ sourceLanguage: 'en', translationLanguage: 'zh-Hans' })
    const warming = engine.warmUpstream(24000)
    sockets[1].events.onReady?.()
    await warming
    engine.pushPcmChunk(pcm(), 24000)
    expect(sockets[1].send).toHaveBeenCalledTimes(1)
    expect(sockets[1].opts).toMatchObject({ sourceLanguage: 'en', translationLanguage: 'zh-Hans' })
  })
})
