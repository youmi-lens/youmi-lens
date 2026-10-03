import { describe, it, expect } from 'vitest'
import { parseJsonObjectLoose, extractSummaryFields, summaryShapeDiagnostic } from './summaryResponseParsing.mjs'

// Real production incident (2026-09-24, recording 9ca64d1f-1b5e-4dc2-a7cf-9c76ebe1db7b):
// a genuinely successful, non-truncated chat completion was rejected with
// HOSTED_SUMMARY_SHAPE because the hosted path only accepted source_summary/
// translated_summary and had no JSON-extraction fallback — both defenses the
// sibling BYOK path already carried. These tests pin the fix.

describe('parseJsonObjectLoose', () => {
  it('parses byte-exact JSON directly', () => {
    expect(parseJsonObjectLoose('{"a":1}')).toEqual({ a: 1 })
  })

  it('extracts a JSON object wrapped in prose/markdown fences despite JSON mode', () => {
    const wrapped = 'Here is the summary:\n```json\n{"source_summary":"S","translated_summary":"T"}\n```\nDone.'
    expect(parseJsonObjectLoose(wrapped)).toEqual({ source_summary: 'S', translated_summary: 'T' })
  })

  it('returns null for genuinely unparseable content (no recoverable object)', () => {
    expect(parseJsonObjectLoose('not json at all, just prose')).toBeNull()
  })

  it('returns null for empty/non-string input', () => {
    expect(parseJsonObjectLoose('')).toBeNull()
    expect(parseJsonObjectLoose(undefined)).toBeNull()
  })
})

describe('extractSummaryFields — the real incident shape now accepted', () => {
  it('accepts the current field names (source_summary/translated_summary)', () => {
    const parsed = { source_summary: 'Source text', translated_summary: 'Translated text' }
    expect(extractSummaryFields(parsed)).toEqual({ sourceSummary: 'Source text', translatedSummary: 'Translated text' })
  })

  it('accepts the proven legacy field-name pair (summary_en/summary_zh) — the incident-rejected shape', () => {
    const parsed = { summary_en: 'English summary', summary_zh: 'Chinese summary' }
    expect(extractSummaryFields(parsed)).toEqual({ sourceSummary: 'English summary', translatedSummary: 'Chinese summary' })
  })

  it('prefers the current field names over legacy ones when both are present', () => {
    const parsed = {
      source_summary: 'Current source',
      translated_summary: 'Current translated',
      summary_en: 'Legacy en',
      summary_zh: 'Legacy zh',
    }
    expect(extractSummaryFields(parsed)).toEqual({ sourceSummary: 'Current source', translatedSummary: 'Current translated' })
  })

  it('returns null fields (not a throw) when required fields are missing entirely', () => {
    expect(extractSummaryFields({})).toEqual({ sourceSummary: null, translatedSummary: null })
    expect(extractSummaryFields(null)).toEqual({ sourceSummary: null, translatedSummary: null })
  })

  it('treats whitespace-only or empty-string fields as missing, not present', () => {
    const parsed = { source_summary: '   ', translated_summary: '' }
    expect(extractSummaryFields(parsed)).toEqual({ sourceSummary: null, translatedSummary: null })
  })

  it('trims surrounding whitespace from accepted values', () => {
    const parsed = { source_summary: '  Source  ', translated_summary: '  Translated  ' }
    expect(extractSummaryFields(parsed)).toEqual({ sourceSummary: 'Source', translatedSummary: 'Translated' })
  })
})

describe('summaryShapeDiagnostic — bounded, content-free', () => {
  it('never includes the raw transcript/summary text, only structure', () => {
    const raw = '{"source_summary":"SENSITIVE LECTURE CONTENT","translated_summary":"更多敏感内容"}'
    const diag = summaryShapeDiagnostic(raw, JSON.parse(raw))
    expect(JSON.stringify(diag)).not.toMatch(/SENSITIVE|敏感/)
    expect(diag).toEqual({
      rawLength: raw.length,
      looksLikeJsonObject: true,
      looksLikeFenced: false,
      parsedTopLevelKeys: ['source_summary', 'translated_summary'],
    })
  })

  it('flags fenced responses and caps reported keys, still without leaking values', () => {
    const raw = '```json\n{"a":1,"b":2}\n```'
    const diag = summaryShapeDiagnostic(raw, null)
    expect(diag.looksLikeFenced).toBe(true)
    expect(diag.looksLikeJsonObject).toBe(false)
    expect(diag.parsedTopLevelKeys).toEqual([])
  })
})

describe('truncation stays upstream — never reachable by this module\'s leniency', () => {
  it('a finish_reason:length response never reaches parseJsonObjectLoose: the transport layer throws HOSTED_CHAT_TRUNCATED/BYOK_CHAT_TRUNCATED first', () => {
    // This module has no finish_reason concept at all — it only ever receives
    // `raw` content, and both call sites (youmiHosted.mjs's chatCompleteJson,
    // byok/adapters.mjs's chatOpenAiCompatible) throw on finish_reason ===
    // 'length' before calling parseJsonObjectLoose/extractSummaryFields. A
    // partial/truncated JSON object is exactly the kind of "recoverable via
    // regex extraction" input this test proves would otherwise be tolerated —
    // which is precisely why that check must stay upstream of this module.
    const truncated = '{"source_summary":"This got cut off mid-sen'
    expect(parseJsonObjectLoose(truncated)).toBeNull()
  })
})
