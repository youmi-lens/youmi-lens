/**
 * Runtime diagnostics for the two things that can only be measured in the real
 * packaged WKWebView: caption latency, and who actually receives a wheel gesture.
 *
 * Everything here writes to `console.info`. The packaged app's WebView console
 * is forwarded to the process's stdout, so launching the binary directly
 *
 *     "…/Youmi Lens Courses V2 QA.app/Contents/MacOS/app" > /tmp/youmi-qa.log 2>&1
 *
 * captures a real session without a debugger attached. Chromium cannot answer
 * either question: the wheel target depends on WebKit hit-testing, and the
 * latency depends on the live provider.
 *
 * Cost when idle is a boolean check. The wheel probe additionally rate-limits
 * itself so a continuous trackpad gesture cannot flood the log.
 */

const FLAG = 'youmi.diag.captions'

/** Diagnostics are opt-in per device: `localStorage['youmi.diag.captions'] = '1'`. */
export function captionDiagnosticsEnabled(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(FLAG) === '1'
  } catch {
    return false
  }
}

/* ── Latency chain ──────────────────────────────────────────────────────────
   The marks below complete the T0–T9 chain. The engine and the WS session
   already log `adapter_pcm_forward_to_ws`, `ws_first_pcm_sent` and
   `en_interim_ui_update`; what was missing were the two ends — when the
   microphone frame was produced, and when the caption was actually painted. */

export type LatencyMark =
  | 'T0_pcm_available'
  | 'T2_ws_send'
  | 'T7_client_receive'
  | 'T8_state_update'
  | 'T9_visible_render'

type Sample = { segmentId: string; mark: LatencyMark; at: number }

const samples: Sample[] = []
/** Wall-clock of the most recent speech onset, the T0 every span is measured from. */
let onsetAt = 0

export function markSpeechOnset(): void {
  if (!captionDiagnosticsEnabled()) return
  onsetAt = performance.now()
  console.info('[latency] T0_speech_onset', JSON.stringify({ at: Math.round(onsetAt) }))
}

export function markLatency(mark: LatencyMark, segmentId: string): void {
  if (!captionDiagnosticsEnabled()) return
  const at = performance.now()
  samples.push({ segmentId, mark, at })
  console.info(
    `[latency] ${mark}`,
    JSON.stringify({ segmentId, sinceOnsetMs: onsetAt ? Math.round(at - onsetAt) : -1 }),
  )
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return -1
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Math.round(sorted[index])
}

/**
 * Onset → first visible caption, per segment. This is the number the user
 * experiences, and the only one worth quoting as "the delay".
 */
export function summariseLatency(): {
  segments: number
  medianMs: number
  p95Ms: number
  perSegmentMs: number[]
} {
  const firstRenderBySeg = new Map<string, number>()
  for (const s of samples) {
    if (s.mark !== 'T9_visible_render') continue
    if (!firstRenderBySeg.has(s.segmentId)) firstRenderBySeg.set(s.segmentId, s.at)
  }
  const spans = [...firstRenderBySeg.values()].map((at) => Math.round(at - onsetAt)).filter((n) => n >= 0)
  return {
    segments: spans.length,
    medianMs: percentile(spans, 50),
    p95Ms: percentile(spans, 95),
    perSegmentMs: spans,
  }
}

/** Printed on Stop so one run yields the whole table without a debugger. */
export function reportLatencySummary(): void {
  if (!captionDiagnosticsEnabled()) return
  console.info('[latency] SUMMARY', JSON.stringify(summariseLatency()))
}

export function resetLatencyDiagnostics(): void {
  samples.length = 0
  onsetAt = 0
}

/* ── Wheel / scroll probe ───────────────────────────────────────────────────
   Answers, in the real WKWebView: which element receives the gesture, what the
   scroller's real geometry is, and whether anything above it in the composed
   path is also scrollable and could be consuming it. */

let lastWheelLog = 0

export function probeWheel(event: WheelEvent, scroller: HTMLElement | null): void {
  if (!captionDiagnosticsEnabled()) return
  const now = performance.now()
  // One line every 400ms: a trackpad emits dozens of events per second.
  if (now - lastWheelLog < 400) return
  lastWheelLog = now

  const path = (event.composedPath?.() ?? []) as EventTarget[]
  const described = path
    .filter((n): n is HTMLElement => n instanceof HTMLElement)
    .slice(0, 8)
    .map((el) => {
      const cs = getComputedStyle(el)
      const scrollable =
        /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight - el.clientHeight > 1
      return `${el.tagName.toLowerCase()}.${(el.getAttribute('class') || '').split(/\s+/)[0] || '-'}` +
        `[oy=${cs.overflowY}${scrollable ? ',SCROLLABLE' : ''}]`
    })

  console.info(
    '[scroll] wheel',
    JSON.stringify({
      deltaY: Math.round(event.deltaY),
      targetIsScroller: event.target === scroller,
      composedPath: described,
      scroller: scroller
        ? {
            scrollTop: Math.round(scroller.scrollTop),
            scrollHeight: scroller.scrollHeight,
            clientHeight: scroller.clientHeight,
            canScroll: scroller.scrollHeight - scroller.clientHeight > 1,
            fromBottom: Math.round(
              scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
            ),
          }
        : null,
      defaultPrevented: event.defaultPrevented,
    }),
  )
}

/** One-shot geometry dump, logged when the recording screen mounts. */
export function probeScrollerGeometry(scroller: HTMLElement | null): void {
  if (!captionDiagnosticsEnabled() || !scroller) return
  const cs = getComputedStyle(scroller)
  const ancestors: string[] = []
  let node: HTMLElement | null = scroller.parentElement
  while (node && ancestors.length < 8) {
    const a = getComputedStyle(node)
    ancestors.push(
      `${node.tagName.toLowerCase()}.${(node.getAttribute('class') || '').split(/\s+/)[0] || '-'}` +
        `[oy=${a.overflowY},minH=${a.minHeight},h=${Math.round(node.getBoundingClientRect().height)}]`,
    )
    node = node.parentElement
  }
  console.info(
    '[scroll] geometry',
    JSON.stringify({
      overflowY: cs.overflowY,
      overscrollBehaviorY: cs.overscrollBehaviorY,
      touchAction: cs.touchAction,
      scrollBehavior: cs.scrollBehavior,
      minHeight: cs.minHeight,
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
      canScroll: scroller.scrollHeight - scroller.clientHeight > 1,
      ancestors,
    }),
  )
}
