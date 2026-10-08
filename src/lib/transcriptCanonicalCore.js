/**
 * Lecture transcript canonicalization (shared: Vite client + Node server via ESM import).
 * Domain-agnostic, STRUCTURE-ONLY: sentence merge/dedupe and repeated-run removal.
 *
 * INVARIANT: canonicalization never substitutes one word for another. It used to run a session-level
 * "term vote" that rewrote near-identical spellings; that silently turned real words into other real words
 * (fr forte -> forme, es modulo -> modelo, en stare -> state, nitrite -> nitrate, strong -> string), before
 * translation / summary / persistence and irreversibly. No stricter heuristic can prove it never does that,
 * so it was removed: leaving an ASR misspelling is acceptable, rewriting a valid word is not.
 * Not a substitute for ASR quality; stabilizes structure before summary / display.
 */

/** @typedef {{ canonical: string, raw: string, diagnostics: { sentenceCountIn: number, sentenceCountOut: number, droppedNearDupPairs: number, droppedRepeatedRuns: number, termClustersMerged: number } }} CanonicalizeResult */

const TRACK_A = /^\[Track A[^\]]*\]/im

function normalizeInnerWhitespace(s) {
  return s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Rough sentence split; keeps short openers/closers (coverage); does not drop fragments.
 * @param {string} t
 * @returns {string[]}
 */
function splitSentences(t) {
  const text = t.trim()
  if (!text) return []
  const parts = text.split(/(?<=[.!?\u2026])\s+/)
  const out = []
  for (const p of parts) {
    const s = p.trim()
    if (s) out.push(s)
  }
  return out.length ? out : [text]
}

function lcpRatio(a, b) {
  const p = a.trim().toLowerCase().replace(/\s+/g, ' ')
  const n = b.trim().toLowerCase().replace(/\s+/g, ' ')
  const max = Math.min(p.length, n.length)
  if (max === 0) return 0
  let i = 0
  while (i < max && p[i] === n[i]) i += 1
  return i / max
}

function isNearDuplicateSentence(prev, next) {
  const p = prev.trim()
  const n = next.trim()
  if (!p || !n) return false
  if (p === n) return true
  const pl = p.toLowerCase()
  const nl = n.toLowerCase()
  if (pl === nl) return true
  if (nl.startsWith(pl) || pl.startsWith(nl)) return true
  const minL = Math.min(p.length, n.length)
  const maxL = Math.max(p.length, n.length)
  if (maxL > 0 && minL / maxL >= 0.88 && lcpRatio(p, n) >= 0.82) return true
  return false
}

/**
 * Collapse adjacent revision pairs (streaming / ASR rewrites).
 * @param {string[]} sentences
 */
function mergeAdjacentNearDuplicates(sentences) {
  let dropped = 0
  if (sentences.length <= 1) return { sentences, dropped }
  const out = [sentences[0]]
  for (let i = 1; i < sentences.length; i++) {
    const prev = out[out.length - 1]
    const cur = sentences[i]
    if (isNearDuplicateSentence(prev, cur)) {
      out[out.length - 1] = cur.length >= prev.length ? cur : prev
      dropped += 1
    } else {
      out.push(cur)
    }
  }
  return { sentences: out, dropped }
}

/**
 * Remove repeated consecutive sentence runs (length 1..4).
 * @param {string[]} sentences
 */
function collapseRepeatedRuns(sentences) {
  let droppedRuns = 0
  if (sentences.length < 2) return { sentences, droppedRuns }
  const eq = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase()
  const out = [...sentences]
  let guard = 0
  while (guard++ < 50 && out.length >= 2) {
    let removed = false
    outer: for (let runLen = Math.min(4, Math.floor(out.length / 2)); runLen >= 1; runLen--) {
      for (let i = 0; i + 2 * runLen <= out.length; i++) {
        let same = true
        for (let k = 0; k < runLen; k++) {
          if (!eq(out[i + k], out[i + runLen + k])) {
            same = false
            break
          }
        }
        if (same) {
          out.splice(i + runLen, runLen)
          droppedRuns += 1
          removed = true
          break outer
        }
      }
    }
    if (!removed) break
  }
  return { sentences: out, droppedRuns }
}

function canonicalizeTrackBody(body) {
  let t = normalizeInnerWhitespace(body)
  let sentences = splitSentences(t)
  const countIn = sentences.length
  let droppedNearDupPairs = 0
  let droppedRepeatedRuns = 0

  const m1 = mergeAdjacentNearDuplicates(sentences)
  sentences = m1.sentences
  droppedNearDupPairs += m1.dropped

  const r1 = collapseRepeatedRuns(sentences)
  sentences = r1.sentences
  droppedRepeatedRuns += r1.droppedRuns

  const joined = sentences.join(' ').trim()
  const countOut = splitSentences(joined).length

  return {
    text: normalizeInnerWhitespace(joined),
    diagnostics: {
      sentenceCountIn: countIn,
      sentenceCountOut: countOut,
      droppedNearDupPairs,
      droppedRepeatedRuns,
      // Kept in the result shape for existing consumers; lexical voting is gone, so always 0.
      termClustersMerged: 0,
    },
  }
}

/**
 * If bilingual live format, canonicalize each track; else one block.
 * @param {string} raw
 * @returns {CanonicalizeResult}
 */
export function canonicalizeLectureTranscript(raw) {
  const source = raw ?? ''
  const trimmed = source.trim()
  if (!trimmed) {
    return {
      raw: source,
      canonical: '',
      diagnostics: {
        sentenceCountIn: 0,
        sentenceCountOut: 0,
        droppedNearDupPairs: 0,
        droppedRepeatedRuns: 0,
        termClustersMerged: 0,
      },
    }
  }

  const idxB = trimmed.search(/\n\[Track B[^\]]*\]/i)
  const hasA = TRACK_A.test(trimmed)
  if (hasA && idxB !== -1) {
    const head = trimmed.slice(0, idxB)
    const tail = trimmed.slice(idxB + 1)
    const nlA = head.indexOf('\n')
    const labelA = (nlA === -1 ? head : head.slice(0, nlA)).trim()
    const bodyA = (nlA === -1 ? '' : head.slice(nlA + 1)).trim()
    const nlB = tail.indexOf('\n')
    const labelB = (nlB === -1 ? tail : tail.slice(0, nlB)).trim()
    const bodyB = (nlB === -1 ? '' : tail.slice(nlB + 1)).trim()

    const ca = canonicalizeTrackBody(bodyA)
    const cb = canonicalizeTrackBody(bodyB)

    const canonical = [labelA, ca.text, '', labelB, cb.text].filter((x) => x !== '').join('\n')

    return {
      raw: source,
      canonical: normalizeInnerWhitespace(canonical),
      diagnostics: {
        sentenceCountIn: ca.diagnostics.sentenceCountIn + cb.diagnostics.sentenceCountIn,
        sentenceCountOut: ca.diagnostics.sentenceCountOut + cb.diagnostics.sentenceCountOut,
        droppedNearDupPairs: ca.diagnostics.droppedNearDupPairs + cb.diagnostics.droppedNearDupPairs,
        droppedRepeatedRuns: ca.diagnostics.droppedRepeatedRuns + cb.diagnostics.droppedRepeatedRuns,
        termClustersMerged: ca.diagnostics.termClustersMerged + cb.diagnostics.termClustersMerged,
      },
    }
  }

  const one = canonicalizeTrackBody(trimmed)
  return {
    raw: source,
    canonical: one.text,
    diagnostics: one.diagnostics,
  }
}

/**
 * @param {string} raw
 * @param {{ minCanonicalRatio?: number }} [opts]
 * @returns {{ ok: boolean, reason?: string }}
 */
export function transcriptCanonicalQualityGate(raw, opts = {}) {
  const minRatio = opts.minCanonicalRatio ?? 0.35
  const r = (raw || '').replace(/\s+/g, '')
  const { canonical } = canonicalizeLectureTranscript(raw)
  const c = canonical.replace(/\s+/g, '')
  if (!r.length) return { ok: false, reason: 'empty_raw' }
  if (!c.length) return { ok: false, reason: 'empty_canonical' }
  const ratio = c.length / r.length
  if (ratio < minRatio) return { ok: false, reason: `canonical_too_short:${ratio.toFixed(2)}` }
  return { ok: true }
}
