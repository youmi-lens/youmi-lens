/**
 * Controlled, low-volume Qwen text-model verification.
 *
 * Required environment (do not use a production key):
 *   DASHSCOPE_TEST_API_KEY
 *   YUMI_QWEN_TEST_TRANSCRIPT_PATH  absolute path to an approved transcript copy
 * Optional:
 *   DASHSCOPE_TEST_OVERSEAS_API_KEY  tests the international Hosted endpoint
 *   YUMI_QWEN_TEST_MODEL            defaults to qwen-flash
 *
 * This script deliberately prints no key and no transcript/summary content.
 */
import { readFile } from 'node:fs/promises'

const testKey = process.env.DASHSCOPE_TEST_API_KEY?.trim()
const transcriptPath = process.env.YUMI_QWEN_TEST_TRANSCRIPT_PATH?.trim()
if (!testKey || !transcriptPath) {
  console.error('QWEN_STAGING_VERIFICATION_BLOCKED: DASHSCOPE_TEST_API_KEY and YUMI_QWEN_TEST_TRANSCRIPT_PATH are required')
  process.exitCode = 2
} else {
  process.env.DASHSCOPE_API_KEY = testKey
  if (process.env.DASHSCOPE_TEST_OVERSEAS_API_KEY?.trim()) {
    process.env.DASHSCOPE_OVERSEAS_API_KEY = process.env.DASHSCOPE_TEST_OVERSEAS_API_KEY.trim()
  } else {
    delete process.env.DASHSCOPE_OVERSEAS_API_KEY
  }
  process.env.YUMI_QWEN_CHAT_MODEL = process.env.YUMI_QWEN_TEST_MODEL?.trim() || 'qwen-flash'
  process.env.ENABLE_STUB_AI = 'false'
  delete process.env.VITE_ENABLE_STUB_AI

  const [{ byokSummarize, byokTranslate }, hosted] = await Promise.all([
    import('../server/ai/byok/adapters.mjs'),
    import('../server/ai/hosted/youmiHosted.mjs'),
  ])
  const transcript = await readFile(transcriptPath, 'utf8')
  if (!transcript.trim()) throw new Error('QWEN_STAGING_TRANSCRIPT_EMPTY')

  const samples = [
    'The lecture begins now.',
    'Do not submit 12 assignments before verifying the result.',
    'The amortized complexity of this operation is O(log n).',
  ]
  const timings = []
  for (const text of samples) {
    const started = performance.now()
    const translated = await hosted.translateText(text, 'Simplified Chinese')
    if (!translated.trim()) throw new Error('QWEN_STAGING_HOSTED_TRANSLATION_EMPTY')
    timings.push(Math.round(performance.now() - started))
  }

  const hostedSummary = await hosted.summarizeTranscript(transcript, 'QA Course', 'Qwen flash staging QA')
  if (typeof hostedSummary.sourceSummary !== 'string' || typeof hostedSummary.translatedSummary !== 'string') {
    throw new Error('QWEN_STAGING_HOSTED_SUMMARY_SHAPE')
  }

  const byokTranslation = await byokTranslate('qwen', samples[1], 'zh', testKey)
  const byokSummary = await byokSummarize('qwen', transcript, 'QA Course', 'Qwen flash staging QA', testKey)
  if (!byokTranslation.trim() || !byokSummary.summaryEn?.trim() || !byokSummary.summaryZh?.trim()) {
    throw new Error('QWEN_STAGING_BYOK_RESPONSE_INVALID')
  }

  console.log(JSON.stringify({
    model: process.env.YUMI_QWEN_CHAT_MODEL,
    hostedRegion: hosted.hostedEnvDiagnostics().dashscopeEffectiveRegion,
    hostedTranslationLatencyMs: timings,
    hostedSummary: {
      sourceSummaryType: typeof hostedSummary.sourceSummary,
      translatedSummaryType: typeof hostedSummary.translatedSummary,
      sourceSummaryLength: hostedSummary.sourceSummary.length,
      translatedSummaryLength: hostedSummary.translatedSummary.length,
      usage: hostedSummary.usage
        ? {
            provider: hostedSummary.usage.provider,
            model: hostedSummary.usage.model,
            promptTokens: hostedSummary.usage.prompt_tokens ?? null,
            completionTokens: hostedSummary.usage.completion_tokens ?? null,
          }
        : null,
    },
    byok: { translationNonEmpty: true, summaryEnNonEmpty: true, summaryZhNonEmpty: true },
    manualReviewRequired: [
      'Review the three fixed-sentence translations for meaning, numbers, negation, and terminology.',
      'Review the approved transcript summary for factual and bilingual accuracy before release.',
    ],
  }, null, 2))
}
