import { describe, expect, it } from 'vitest'
import { canonicalizeLectureTranscript, transcriptCanonicalQualityGate } from './transcriptCanonicalCore.js'

describe('canonicalizeLectureTranscript', () => {
  it('merges adjacent near-duplicate sentences (revision)', () => {
    const raw = 'The particles are tiny. The particles are tiny drifters in the fluid.'
    const { canonical } = canonicalizeLectureTranscript(raw)
    expect(canonical.toLowerCase()).toContain('drifters')
    expect(canonical).not.toMatch(/tiny\.\s+The particles are tiny\./i)
  })

  it('collapses repeated run of sentences', () => {
    const raw = 'Hello world. Hello world. Hello world. Next idea.'
    const { canonical, diagnostics } = canonicalizeLectureTranscript(raw)
    const lower = canonical.toLowerCase()
    const count = lower.split('hello world').length - 1
    expect(count).toBeLessThan(3)
    expect(diagnostics.droppedNearDupPairs + diagnostics.droppedRepeatedRuns).toBeGreaterThan(0)
  })

  it('canonicalizes bilingual live layout without dropping track labels', () => {
    const raw = `[Track A � speech en-US]
One two. One two three.

[Track B � Simplified Chinese]
Yi er. Yi er san.`
    const { canonical } = canonicalizeLectureTranscript(raw)
    expect(canonical).toMatch(/\[Track A/i)
    expect(canonical).toMatch(/\[Track B/i)
    expect(canonical).toMatch(/Yi er/)
  })

  it('quality gate rejects empty', () => {
    expect(transcriptCanonicalQualityGate('   ').ok).toBe(false)
    expect(transcriptCanonicalQualityGate('Some real text here.').ok).toBe(true)
  })
})

/** Every word of `text`, in order — what a structure-only canonicalizer must preserve exactly. */
const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}'’-]+/gu) ?? []
const squash = (text: string) => text.replace(/\s+/g, ' ').trim()
/**
 * Also called the way a language-aware caller would (extra options argument). The signature takes none, so
 * the argument must be ignored: no spelling of the call may re-enable any word substitution.
 */
const canonWithLanguage = canonicalizeLectureTranscript as unknown as (
  raw: string,
  opts?: { sourceLanguage?: string; translationLanguage?: string },
) => { canonical: string }

/**
 * INVARIANT: canonicalization performs NO speculative lexical substitution. It used to run a "term vote"
 * that rewrote near-identical spellings into the most frequent one; that turned valid words into other
 * valid words (QA 1012: French "forte" -> "forme"). Leaving an ASR misspelling alone is acceptable;
 * rewriting a valid word never is. No heuristic could prove otherwise, so voting was removed.
 */
describe('canonicalization never substitutes one word for another', () => {
  // QA 1012 French reproducer.
  const FRENCH =
    'La forme de la courbe est importante. Cette forme change avec la température. ' +
    'Une pression forte modifie le résultat. Ensuite nous mesurons la forme finale.'

  it('French: forte must remain forte (QA 1012 reproducer)', () => {
    const { canonical, diagnostics } = canonicalizeLectureTranscript(FRENCH)
    expect(canonical).toBe(FRENCH)
    expect(canonical).toContain('Une pression forte modifie le résultat.')
    expect(canonical).not.toContain('pression forme')
    expect(diagnostics.termClustersMerged).toBe(0)
  })

  it('Spanish: modulo must remain modulo', () => {
    const es = 'El modelo simple funciona. Ese modelo mejora. Un modelo nuevo. Tomamos el modulo final.'
    expect(canonicalizeLectureTranscript(es).canonical).toBe(es)
  })

  it('English: stare / stage / state and compliment / complement stay as spoken', () => {
    const en =
      'The state of the system is stable. Each state changes. A state machine. We stare at the stage. ' +
      'We compliment the design. The complement set is large. Another complement appears. The compliment was kind.'
    expect(canonicalizeLectureTranscript(en).canonical).toBe(en)
  })

  it('does not rewrite an ASR misspelling either (Kubernates stays Kubernates)', () => {
    const t = 'We use Kubernetes daily. Kubernetes scales well. Kubernetes runs pods. Then Kubernates broke.'
    expect(canonicalizeLectureTranscript(t).canonical).toBe(t)
    expect(canonWithLanguage(t, { sourceLanguage: 'en' }).canonical).toBe(t)
  })

  it('never rewrites a valid word into another: adversarial corpus found in the system English lexicon', () => {
    // [frequent word, valid one-letter neighbour]. Each pair satisfied the previous "stricter" voting
    // geometry (same first 3 letters, same last 2, edit distance 1) and WAS silently rewritten by it.
    const collisions: Array<[string, string]> = [
      ['nitrate', 'nitrite'], ['alkane', 'alkene'], ['string', 'strong'], ['stable', 'staple'],
      ['complement', 'compliment'], ['neutron', 'neuron'], ['patient', 'patent'], ['dessert', 'desert'],
      ['carbon', 'carton'], ['atomic', 'atopic'], ['isotope', 'isotype'], ['threat', 'throat'],
      ['trace', 'trance'], ['phosphate', 'phosphite'],
      ['chlorate', 'chlorite'], ['ration', 'ratton'], ['forme', 'forte'], ['modelo', 'modulo'],
      ['causa', 'casas'], ['maison', 'raison'], ['border', 'borer'],
    ]
    for (const [winner, loser] of collisions) {
      const text = `The ${winner} appears. Each ${winner} matters. A ${winner} here. Another ${winner} follows. Then the ${loser} ends.`
      const { canonical } = canonicalizeLectureTranscript(text)
      expect(canonical, `${loser} -> ${winner}`).toBe(text)
      expect(words(canonical)).toEqual(words(text))
      expect(canonWithLanguage(text, { sourceLanguage: 'en' }).canonical, `${loser} -> ${winner} (en)`).toBe(text)
      expect(canonWithLanguage(text, { sourceLanguage: 'fr' }).canonical, `${loser} -> ${winner} (fr)`).toBe(text)
    }
  })

  it('leaves proper nouns, technical terms, course terminology and embedded Latin untouched', () => {
    const t =
      'Euler and Euller co-authored it. Python, Pyhton and Pytorch differ. Use numpy, numpi and pandas. ' +
      'The mitochondria and mitochondrion; in vitro versus in vivo; et cetera; ad hoc; a priori. ' +
      'Use HTTPS, HTTP and HTML5 here. Dr. Smith and Dr. Smyth met. Dr. Smith spoke. Dr. Smith left.'
    expect(canonicalizeLectureTranscript(t).canonical).toBe(squash(t))
  })

  it('does not change a single word of CJK / Korean text with embedded ASCII terms', () => {
    const t = 'Kubernetesを使います。Kubernetesは便利です。Kubernetesが動く。Kubernatesは失敗した。'
    expect(canonicalizeLectureTranscript(t).canonical).toBe(t)
    const ko = '오늘은 Kubernetes를 배웁니다. Kubernetes는 편리합니다. Kubernetes가 동작합니다. Kubernates는 실패했습니다.'
    expect(canonicalizeLectureTranscript(ko).canonical).toBe(ko)
  })

  it('applies to both tracks of the bilingual live layout', () => {
    const raw = `[Track A — speech French]\n${FRENCH}\n\n[Track B — English]\nWe compliment it. The complement set. A complement. Another complement. The compliment ends.`
    const { canonical } = canonicalizeLectureTranscript(raw)
    expect(canonical).toContain('Une pression forte modifie le résultat.')
    expect(canonical).toContain('The compliment ends.')
  })
})

describe('structure-only cleanup still works', () => {
  it('merges an adjacent French revision pair (a near-duplicate re-recognition)', () => {
    const raw = 'Les particules sont petites et dérivent dans le fluide. Les particules sont petites et dérivent dans le fluide!'
    const { canonical, diagnostics } = canonicalizeLectureTranscript(raw)
    expect(canonical).toBe('Les particules sont petites et dérivent dans le fluide!')
    expect(diagnostics.droppedNearDupPairs).toBe(1)
  })

  it('collapses a repeated run and reports it', () => {
    const { canonical, diagnostics } = canonicalizeLectureTranscript('Bonjour à tous. Bonjour à tous. Bonjour à tous. Commençons.')
    expect(words(canonical).join(' ')).toBe('bonjour à tous commençons')
    expect(diagnostics.droppedNearDupPairs + diagnostics.droppedRepeatedRuns).toBeGreaterThan(0)
  })

  it('still normalizes whitespace and keeps the track labels', () => {
    const { canonical } = canonicalizeLectureTranscript('[Track A — speech English]\nOne   two.\n\n\n[Track B — French]\nUn  deux.')
    expect(canonical).toContain('[Track A')
    expect(canonical).toContain('[Track B')
    expect(canonical).toContain('One two.')
    expect(canonical).toContain('Un deux.')
  })

  it('quality gate is unchanged', () => {
    expect(transcriptCanonicalQualityGate('Une pression forte.').ok).toBe(true)
    expect(transcriptCanonicalQualityGate('   ').ok).toBe(false)
  })
})
