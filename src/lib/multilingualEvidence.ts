/**
 * What has actually been PROVEN end to end, per language — the single place the registry's
 * `available` flags are answerable to.
 *
 * Every entry names the evidence. A flag in `contentLanguages.ts` may be `available` only if this
 * table says the corresponding stages were exercised on the DEPLOYED stack. The test
 * `contentLanguages.test.ts` fails when the two disagree, in either direction, so a language can
 * neither be switched on by hope nor left off after it was proven.
 *
 * Stages:  live    — live captions / live translation over the persistent socket
 *          final   — Stop & Save → final transcription (source) / final translation (target)
 *          summary — source summary / translated summary generated and stored
 *
 * Production smoke 2026-10-05 (ephemeral user, synthetic speech) unless noted.
 */
export type Stage = 'proven' | 'pending' | 'blocked'

export type SourceEvidence = { live: Stage; final: Stage; evidence: string }
export type TargetEvidence = { live: Stage; final: Stage; summary: Stage; evidence: string }

export const SOURCE_EVIDENCE: Record<string, SourceEvidence> = {
  en: { live: 'proven', final: 'proven', evidence: '315 en→zh recordings done in Production; smoke en→es live+save' },
  'zh-Hans': { live: 'proven', final: 'proven', evidence: 'zh→en: 3 Production rows done; QA 1011 physical test; smoke live' },
  ja: { live: 'proven', final: 'proven', evidence: 'Production ja→ja row done; smoke ja→en: live, upload, final ASR, both summaries, status done' },
  fr: { live: 'proven', final: 'proven', evidence: 'Production fr→zh row done; smoke fr→en: live, upload, final ASR, both summaries, status done' },
  ko: { live: 'proven', final: 'proven', evidence: 'smoke ko→en: live captions, upload, final ASR, both summaries, status done' },
  es: { live: 'proven', final: 'blocked', evidence: 'paraformer-v2 has no Spanish: a Spanish hint makes the DashScope task FAIL (reported as "no speech")' },
}

export const TARGET_EVIDENCE: Record<string, TargetEvidence> = {
  en: { live: 'proven', final: 'proven', summary: 'proven', evidence: 'Production zh→en rows with translated transcript + both summaries; smoke ko→en' },
  'zh-Hans': { live: 'proven', final: 'proven', summary: 'proven', evidence: '206 Production translated transcripts, 212 translated summaries' },
  es: { live: 'proven', final: 'proven', summary: 'proven', evidence: 'smoke en→es: live translation, translated transcript, translated summary, status done' },
  ja: { live: 'proven', final: 'proven', summary: 'proven', evidence: 'smoke en→ja: live translation, translated transcript, translated summary, status done' },
  fr: { live: 'proven', final: 'proven', summary: 'proven', evidence: 'smoke en→fr: live translation, translated transcript, translated summary, status done' },
  ko: { live: 'proven', final: 'proven', summary: 'proven', evidence: 'smoke en→ko: live translation, translated transcript, translated summary, status done' },
}

export const isSourceProven = (code: string) => {
  const e = SOURCE_EVIDENCE[code]
  return Boolean(e && e.live === 'proven' && e.final === 'proven')
}
export const isTargetProven = (code: string) => {
  const e = TARGET_EVIDENCE[code]
  return Boolean(e && e.live === 'proven' && e.final === 'proven' && e.summary === 'proven')
}
