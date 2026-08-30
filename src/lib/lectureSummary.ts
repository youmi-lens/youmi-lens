/**
 * Parser for the production lecture summary.
 *
 * The summary is NOT free text and it is NOT JSON. `server/ai/summarizePrompt.mjs`
 * asks the model for two markdown strings with fixed `## ` headings:
 *
 *   summary_en → `## Outline`, `## Key terms`, `## Takeaways`
 *   summary_zh → `## 大纲`,    `## 关键术语`,   `## 要点`
 *
 * So the sections are real and this parser reads what is actually there. Two
 * consequences follow, and both are deliberate:
 *
 *  · Section TITLES come from the document, never from a hardcoded list. A model
 *    that returns `## Key Terms` or a translated variant still renders with its
 *    own heading rather than being relabelled to something it did not say.
 *
 *  · A summary with no `## ` headings at all — an older row, a provider that
 *    ignored the format, a BYOK model — is returned as ONE unlabelled section.
 *    The UI shows the whole text. Splitting free prose into three invented
 *    buckets would be fabrication.
 *
 * Nothing here is lossy: concatenating the sections reproduces the input.
 */

export type LectureSummarySection = {
  /** The heading exactly as written, or null for a document with no headings. */
  title: string | null
  body: string
}

export type LectureSummary = {
  sections: LectureSummarySection[]
  /** True when the document carried real `## ` headings. */
  structured: boolean
}

const HEADING = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/

export function parseLectureSummary(raw: string | null | undefined): LectureSummary | null {
  const text = (raw ?? '').trim()
  if (!text) return null

  const sections: LectureSummarySection[] = []
  let current: { title: string | null; lines: string[] } | null = null

  for (const line of text.split(/\r?\n/)) {
    const match = HEADING.exec(line)
    if (match) {
      if (current) sections.push({ title: current.title, body: current.lines.join('\n').trim() })
      current = { title: match[1].trim(), lines: [] }
      continue
    }
    if (!current) current = { title: null, lines: [] }
    current.lines.push(line)
  }
  if (current) sections.push({ title: current.title, body: current.lines.join('\n').trim() })

  // Preamble before the first heading, when empty, is not a section.
  const cleaned = sections.filter((s, i) => s.title !== null || s.body.length > 0 || i > 0)
  const structured = cleaned.some((s) => s.title !== null)

  if (!structured) return { sections: [{ title: null, body: text }], structured: false }
  return { sections: cleaned.filter((s) => s.title !== null || s.body.length > 0), structured: true }
}

/* ── Transcript ─────────────────────────────────────────────────────────────
   The stored transcript is plain prose with no timestamps: `updateRecordingAi`
   writes a single `transcript` string. There is therefore nothing to seek to,
   and the detail view renders one continuous selectable block rather than a
   wall of per-sentence cards with invented times. */

/** True when a transcript carries `[hh:]mm:ss` markers we could seek from. */
export function transcriptHasTimestamps(transcript: string | null | undefined): boolean {
  if (!transcript) return false
  return /(^|\s)\[?\d{1,2}:\d{2}(:\d{2})?\]?(\s|$)/.test(transcript)
}

/** Paragraphs for rendering. Blank-line separated, whitespace normalised. */
export function transcriptParagraphs(transcript: string | null | undefined): string[] {
  const text = (transcript ?? '').trim()
  if (!text) return []
  return text
    .split(/\n{2,}/)
    .map((p) => p.replace(/[ \t]+\n/g, '\n').trim())
    .filter(Boolean)
}

/* ── Readiness ──────────────────────────────────────────────────────────────
   Derived from the same `aiStatus` the rest of the app uses, so the detail
   header cannot disagree with the badge on the lecture row. */

export type LectureReadiness = 'processing' | 'transcript_only' | 'ready' | 'failed' | 'none'

export function lectureReadiness(input: {
  /** Persisted audio is usable even while AI enrichment is pending or failed. */
  hasAudio?: boolean
  aiStatus?: string | null
  transcript?: string | null
  summaryEn?: string | null
  summaryZh?: string | null
}): LectureReadiness {
  if (input.hasAudio) return 'ready'
  if (input.aiStatus === 'failed') return 'failed'
  const hasSummary = Boolean(input.summaryEn?.trim() || input.summaryZh?.trim())
  const hasTranscript = Boolean(input.transcript?.trim())
  if (hasSummary && hasTranscript) return 'ready'
  if (hasTranscript) return 'transcript_only'
  if (input.aiStatus && !['done', 'transcript_ready'].includes(input.aiStatus)) return 'processing'
  return 'none'
}
