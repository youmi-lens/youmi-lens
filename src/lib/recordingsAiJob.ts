import { getAiApiBase } from './aiClient'

/**
 * Ask the platform server to transcribe + summarize a cloud recording using server-side credentials.
 * Server updates `recordings` (ai_status, transcript, summaries). Client should poll until `done` / `failed`.
 */
type ProcessRecordingErrBody = {
  error?: string
  step?: string
  supabaseError?: { message?: string; code?: string; details?: string; hint?: string }
  usingServiceRoleForRecordings?: boolean
}

/**
 * How long the client waits for the enqueue answer. The server answers in 1–4s
 * normally, but when its own database calls stall (seen 2026-10-04) the socket
 * would otherwise hang indefinitely and the lecture would sit on "Processing"
 * with nothing in flight. A timeout is thrown, which the caller treats as a
 * transient failure worth retrying — the server dedupes a repeat.
 */
export const REQUEST_AI_TIMEOUT_MS = 45_000

export async function requestHostedRecordingAi(opts: {
  accessToken: string
  recordingId: string
}): Promise<{ ok: true } | { ok: false; message: string; debug?: ProcessRecordingErrBody; status: number }> {
  console.warn('[process-recording] start', JSON.stringify({ recordingId: opts.recordingId }))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_AI_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(`${getAiApiBase()}/process-recording`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.accessToken}`,
      },
      body: JSON.stringify({ recordingId: opts.recordingId }),
      signal: controller.signal,
    })
  } catch (err) {
    throw err instanceof Error && err.name === 'AbortError'
      ? new Error('Youmi AI did not answer in time.')
      : err
  } finally {
    clearTimeout(timer)
  }

  let bodySnippet: unknown
  try {
    bodySnippet = await res.clone().json()
  } catch {
    bodySnippet = null
  }
  console.warn(
    '[process-recording] response',
    JSON.stringify({
      recordingId: opts.recordingId,
      status: res.status,
      ok: res.ok,
      body: bodySnippet,
    }),
  )

  if (res.status === 202 || res.status === 200) {
    return { ok: true }
  }

  let message = 'Youmi AI could not be started. Try again in a moment.'
  let debug: ProcessRecordingErrBody | undefined
  try {
    const j = (await res.json()) as ProcessRecordingErrBody
    debug = j
    if (j.error && typeof j.error === 'string' && j.error.length < 200) {
      message = j.error
    }
    const se = j.supabaseError
    if (se?.message) {
      message = `${message} [${se.code ?? 'no-code'}] ${se.message}${se.details ? ` — ${se.details}` : ''}`
    }
    if (j.step) {
      message = `${message} (step: ${j.step})`
    }
  } catch {
    /* use default */
  }
  console.warn('[process-recording] enqueue_failed', JSON.stringify({ recordingId: opts.recordingId, message }))
  return { ok: false, message, debug, status: res.status }
}
