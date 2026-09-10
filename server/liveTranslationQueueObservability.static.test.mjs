import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'vitest'

/**
 * SO100 P0-B — live final-translation queue must never silently drop a job.
 *
 * Real incident context: a real classroom session logged 965 translation
 * requests and only 852 successes, with zero corresponding failure logs for
 * the missing 113 — because the queue's two pressure-relief paths (staleness
 * and overflow) discarded jobs with no log and no client signal at all. The
 * final-caption path happened to stay under those thresholds that day, but
 * the mechanism was, and without this fix remains, capable of losing a
 * finalized English caption's translation with zero trace.
 *
 * `drainFinalTranslationQueue`/`enqueueFinalTranslation` are closures inside
 * the WS connection handler (per-connection queue state), not an exportable
 * module -- consistent with this repo's existing pattern for that situation
 * (see durable-recorder-checkpoint.test.mjs), this asserts the actual shipped
 * source implements the required invariants rather than re-testing pure
 * queue arithmetic in isolation.
 */

const source = readFileSync(new URL('./liveRealtimeWs.mjs', import.meta.url), 'utf8')

describe('live final-translation queue — every job reaches an observable terminal state', () => {
  it('defines a single terminal-unavailable helper that both logs and notifies the client', () => {
    const idx = source.indexOf('const sendTranslationUnavailable = (job, reason) => {')
    assert.ok(idx > 0, 'sendTranslationUnavailable must exist')
    const block = source.slice(idx, idx + 700)
    assert.match(block, /console\.warn\(\s*\n\s*'\[liveRealtimeWs\] live_translation_unavailable'/, 'must log with the job id and reason')
    assert.match(block, /id: job\.id/, 'log must carry the job identity')
    assert.match(block, /reason/, 'log must carry the reason')
    assert.match(block, /type: 'stream_translation', id: job\.id, status: 'unavailable', reason,/, 'must notify the client with a terminal status, not silence')
  })

  it('the staleness drop calls the terminal helper instead of a bare continue', () => {
    const idx = source.indexOf('if (Date.now() - job.enqueuedAt > 8000) {')
    assert.ok(idx > 0)
    const block = source.slice(idx, idx + 150)
    assert.match(block, /sendTranslationUnavailable\(job, 'stale'\)/)
    assert.match(block, /continue/, 'still bounded -- stale jobs are still skipped, just observably now')
  })

  it('the queue-overflow trim notifies every spliced-off job, not just the newest one dropped silently', () => {
    const idx = source.indexOf('const overflow = finalTranslationQueue.splice(')
    assert.ok(idx > 0)
    const block = source.slice(idx, idx + 200)
    assert.match(block, /for \(const job of overflow\) sendTranslationUnavailable\(job, 'queue_overflow'\)/)
  })

  it('an empty model response is treated as unavailable, not a silent success', () => {
    const idx = source.indexOf("if (!out) {")
    assert.ok(idx > 0)
    const block = source.slice(idx, idx + 100)
    assert.match(block, /sendTranslationUnavailable\(job, 'empty_response'\)/)
  })

  it('a hard request failure still logs live_translation_failed AND now also notifies the client', () => {
    const idx = source.indexOf("interim: false,\n                    message: err instanceof Error")
    assert.ok(idx > 0, 'must find the final-path failure log (interim: false)')
    const block = source.slice(idx, idx + 200)
    assert.match(block, /sendTranslationUnavailable\(job, 'request_failed'\)/)
  })

  it('bounded-resource constants are unchanged -- this is an observability fix, not a capacity increase', () => {
    assert.match(source, /const MAX_CONCURRENT_FINAL_TRANSLATIONS = 2/)
    assert.match(source, /const MAX_FINAL_TRANSLATION_QUEUE = 5/)
    assert.match(source, /Date\.now\(\) - job\.enqueuedAt > 8000/)
  })

  it('a successfully delivered translation is unchanged: still sends translated_text with no status field', () => {
    const idx = source.indexOf('const drainFinalTranslationQueue = () => {')
    assert.ok(idx > 0)
    const block = source.slice(idx, idx + 2000)
    assert.match(block, /type: 'stream_translation', id: job\.id, translated_text: out,/)
  })
})
