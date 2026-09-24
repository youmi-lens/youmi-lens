/**
 * Shared parsing for the two-language lecture-summary JSON contract
 * (source_summary + translated_summary — see summarizePrompt.mjs).
 *
 * Real production incident (2026-09-24, recording 9ca64d1f-…): a provider
 * response with `response_format: { type: 'json_object' }` set — which
 * DashScope/OpenAI-compatible "JSON mode" documents as guaranteeing
 * syntactically valid JSON, NOT any particular field-name schema — was
 * rejected with HOSTED_SUMMARY_SHAPE after a genuinely successful, non-
 * truncated chat completion, forcing a full re-transcription + re-translation
 * on retry (transcription and translation are independent of this parsing
 * step and had already succeeded). No raw-response diagnostic existed at the
 * time, so the exact historical bytes could not be forensically recovered —
 * see recordSummaryShapeDiagnostic below, added specifically so this is never
 * true again.
 *
 * `server/ai/byok/adapters.mjs`'s `byokSummarize` already carries a proven
 * fallback for the same model family (JSON extracted from a non-fenced-clean
 * response, and an accepted legacy field-name pair, `summary_en`/`summary_zh`
 * — its own comment says these are real values it has seen from provider
 * responses). The hosted path never received the same fallback. This module
 * is that fix, shared by both call sites instead of duplicated a third time.
 *
 * What this does NOT change: `finish_reason === 'length'` truncation
 * detection stays entirely at the transport layer (chatCompleteJson /
 * chatOpenAiCompatible), which throws *before* any content reaches this
 * module — a truncated response never gets a chance at the leniency below.
 * This module only tolerates non-schema-exact but genuinely complete JSON.
 */

/**
 * Parse a chat completion's raw text into an object, tolerating a response
 * that isn't byte-exact valid JSON on its own (e.g. wrapped in prose or
 * markdown fences despite JSON mode being requested) by extracting the first
 * top-level `{...}` object and retrying. Returns null if no JSON object can
 * be recovered at all — the caller decides what error that means.
 */
export function parseJsonObjectLoose(raw) {
  const text = typeof raw === 'string' ? raw : ''
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      return JSON.parse(match[0])
    } catch {
      return null
    }
  }
}

/**
 * Extract { sourceSummary, translatedSummary } from a parsed summary
 * response, accepting the current field names (source_summary /
 * translated_summary) and the proven legacy pair (summary_en / summary_zh)
 * as an equally valid representation of the same contract — not a broad
 * lenient parser, just the one alternate shape already confirmed real by
 * byokSummarize's own production history. Returns null fields (not a throw)
 * when a genuinely required field is missing/empty — the caller decides
 * whether that is fatal for its own needTranslated requirement.
 */
export function extractSummaryFields(parsed) {
  const obj = parsed && typeof parsed === 'object' ? parsed : {}
  const sourceSummary = (nonEmpty(obj.source_summary) ? obj.source_summary : obj.summary_en)?.trim() || null
  const translatedSummary = (nonEmpty(obj.translated_summary) ? obj.translated_summary : obj.summary_zh)?.trim() || null
  return { sourceSummary, translatedSummary }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Bounded, content-free diagnostic for a summary parse/shape failure — logs
 * only structure (never transcript/summary text, per the no-sensitive-
 * content-in-logs contract shared with the rest of this pipeline's
 * instrumentation), so a future occurrence is actually debuggable instead of
 * repeating this incident's evidence gap.
 */
export function summaryShapeDiagnostic(raw, parsed) {
  const text = typeof raw === 'string' ? raw : ''
  return {
    rawLength: text.length,
    looksLikeJsonObject: /^\s*\{/.test(text),
    looksLikeFenced: /^\s*```/.test(text),
    parsedTopLevelKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 20) : [],
  }
}
