import { afterEach, describe, expect, it, vi } from 'vitest'
import { YoumiLiveAdapter } from './youmiAdapter'

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  static instances: FakeWebSocket[] = []

  CONNECTING = FakeWebSocket.CONNECTING
  OPEN = FakeWebSocket.OPEN
  CLOSED = FakeWebSocket.CLOSED

  binaryType: BinaryType = 'blob'
  readyState = FakeWebSocket.CONNECTING
  sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = []
  closed = false
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    this.sent.push(data)
  }

  close(code = 1000, reason = '') {
    this.closed = true
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code, reason, wasClean: true } as CloseEvent)
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  receive(value: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent)
  }
}

describe('YoumiLiveAdapter stream_error handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    FakeWebSocket.instances = []
  })

  it('surfaces server quota/auth stream_error as a fatal adapter error instead of reconnecting', async () => {
    vi.stubGlobal('window', {
      location: { protocol: 'https:', host: 'app.example.test' },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    const adapter = new YoumiLiveAdapter({ tokenGetter: async () => 'jwt' })
    const events: Array<{ type: string; code?: string; recoverable?: boolean; reason?: string }> = []
    adapter.onEvent((event) => events.push(event))
    adapter.start()

    const warm = adapter.warmSession(48_000)
    const ws = FakeWebSocket.instances[0]
    expect(ws).toBeDefined()
    ws.open()
    await Promise.resolve()

    ws.receive({
      type: 'stream_error',
      code: 'auth_required',
      message: 'Sign in required for live captions.',
    })

    await expect(warm).rejects.toThrow('auth_required')
    expect(events).toContainEqual({
      type: 'error',
      code: 'auth_required',
      message: 'Sign in required for live captions.',
      recoverable: false,
    })
    expect(events.some((event) => event.type === 'reconnecting')).toBe(false)
  })
})
