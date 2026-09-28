import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'vitest'
import { paraformerFailureErrorCode } from './ai/hosted/youmiHosted.mjs'
import { determineProcessingResumeStage, PROCESSING_RESUME_STAGES } from './processingRecovery.mjs'

// Production incident, 2026-09-28: recording 7885e218-2814-4284-bfe9-dbca471a33a8
// failed with a generic "Transcription did not finish. Try again in a moment."
// message even though DashScope's own terminal task output already said
// exactly why: SUCCESS_WITH_NO_VALID_FRAGMENT (the task completed, found no
// speech in the audio — a deterministic outcome, not a transient failure).
// This is the ACTUAL `output` object captured from production Railway logs
// for that recording's failed Paraformer task (trimmed of its file_url,
// which carries a signed-URL token).
const PRODUCTION_NO_SPEECH_OUTPUT = {
  task_id: 'a1de10c3-22f2-47f8-a17c-c131949e4171',
  task_status: 'FAILED',
  submit_time: '2026-09-28 11:17:41.832',
  scheduled_time: '2026-09-28 11:17:41.870',
  end_time: '2026-09-28 11:17:44.551',
  code: 'SUCCESS_WITH_NO_VALID_FRAGMENT',
  message: 'SUCCESS_WITH_NO_VALID_FRAGMENT',
}

test('classifies the real production "no speech detected" terminal code distinctly', () => {
  assert.equal(paraformerFailureErrorCode(PRODUCTION_NO_SPEECH_OUTPUT), 'HOSTED_TRANSCRIBE_NO_SPEECH')
})

test('every other FAILED code keeps the original generic classification unchanged', () => {
  // Real DashScope task failures with a DIFFERENT code, an unknown/absent
  // code, or no code at all must be completely unaffected by this change —
  // this is the guard against silently reclassifying genuine transient or
  // unrelated provider failures as "no speech detected".
  assert.equal(paraformerFailureErrorCode({ code: 'SOME_OTHER_CODE', task_status: 'FAILED' }), 'HOSTED_TRANSCRIBE_FAILED')
  assert.equal(paraformerFailureErrorCode({ task_status: 'FAILED' }), 'HOSTED_TRANSCRIBE_FAILED')
  assert.equal(paraformerFailureErrorCode(undefined), 'HOSTED_TRANSCRIBE_FAILED')
  assert.equal(paraformerFailureErrorCode(null), 'HOSTED_TRANSCRIBE_FAILED')
})

test('pollParaformerTask only applies the new classification to FAILED, not UNKNOWN', () => {
  const source = readFileSync(new URL('./ai/hosted/youmiHosted.mjs', import.meta.url), 'utf8')
  assert.match(
    source,
    /throw new Error\(status === 'FAILED' \? paraformerFailureErrorCode\(out\) : 'HOSTED_TRANSCRIBE_FAILED'\)/,
    'UNKNOWN must keep throwing the original generic HOSTED_TRANSCRIBE_FAILED — only a real terminal FAILED status is inspected for the no-speech code',
  )
})

// ---- Product semantics correction: no-speech must become READY, not FAILED ----
//
// A lecture with SUCCESS_WITH_NO_VALID_FRAGMENT completed transcription
// successfully (just with nothing to transcribe). It must reach ai_status
// 'done' (client-mapped to processingStatus 'ready') with an empty
// transcript/summary, never markFailed — see markDoneEmptyNoSpeech in
// processRecording.mjs.

test('the transcribe catch block routes HOSTED_TRANSCRIBE_NO_SPEECH to the empty-success path, never markFailed', () => {
  const source = readFileSync(new URL('./processRecording.mjs', import.meta.url), 'utf8')
  const catchBlock = source.slice(
    source.indexOf("} catch (e) {\n      console.warn('[process-recording] transcribe'"),
    source.indexOf('return\n    }', source.indexOf("} catch (e) {\n      console.warn('[process-recording] transcribe'")),
  )
  assert.match(catchBlock, /if \(errMessage === 'HOSTED_TRANSCRIBE_NO_SPEECH'\) \{\s*\n\s*await markDoneEmptyNoSpeech\(\)/, 'the no-speech code routes to markDoneEmptyNoSpeech, not markFailed')
  assert.ok(!/markFailed\(\s*\n?\s*errMessage === 'HOSTED_TRANSCRIBE_NO_SPEECH'/.test(catchBlock), 'markFailed must not be conditioned on the no-speech code any more')
  assert.match(catchBlock, /\} else \{\s*\n\s*await markFailed\('Transcription did not finish\. Try again in a moment\.'\)/, 'every other transcription failure still calls the original, unchanged markFailed')
})

test('markDoneEmptyNoSpeech persists the same core success schema as the normal path, with empty content and ai_status done', () => {
  const source = readFileSync(new URL('./processRecording.mjs', import.meta.url), 'utf8')
  const fnBody = source.slice(
    source.indexOf('const markDoneEmptyNoSpeech = async () => {'),
    source.indexOf('\n  }\n\n  jobLog(\'job_start\''),
  )
  assert.ok(fnBody.length > 0, 'found markDoneEmptyNoSpeech')
  // Same column set as the real success path (transcript_raw/transcript from
  // the transcript-save payload; summary_en/summary_zh/source_summary/
  // translated_summary/ai_status/ai_error from donePayload) — no new/
  // incompatible shape invented.
  for (const field of [
    "transcript_raw: ''",
    "transcript: ''",
    "summary_en: ''",
    "summary_zh: ''",
    "source_summary: ''",
    'translated_summary: null',
    "ai_status: 'done'",
    'ai_error: null',
  ]) {
    assert.ok(fnBody.includes(field), `empty-success payload includes ${field}`)
  }
  assert.ok(!fnBody.includes("ai_status: 'failed'"), 'the empty-success path never sets ai_status to failed')
  assert.ok(!/youmiHosted\.(translateText|summarizeTranscript)/.test(fnBody), 'no hosted chat call (translate/summarize) is made for empty content')
})

// Second production incident, 2026-09-28: recording
// b1aee347-08be-4b45-b12f-3e3e7a0cd869, a genuine 14-second silent test
// recording. DashScope again returned SUCCESS_WITH_NO_VALID_FRAGMENT (SAME
// semantic family, not a new provider case — confirmed via Railway logs:
// identical paraformer task failed / SUCCESS_WITH_NO_VALID_FRAGMENT shape)
// and markDoneEmptyNoSpeech routed correctly, but ITS OWN write then failed
// with a real Postgres/PostgREST error — the ACTUAL production
// `recordings` table (confirmed via a direct read-only query) has no
// `transcript_raw` column at all:
const PRODUCTION_MISSING_TRANSCRIPT_RAW_COLUMN_ERROR = {
  message: "Could not find the 'transcript_raw' column of 'recordings' in the schema cache",
  code: 'PGRST204',
  details: null,
  hint: null,
}

test('markDoneEmptyNoSpeech retries without transcript_raw on the real production PGRST204 "column not found" error, mirroring the normal transcript-save path\'s existing fallback', () => {
  const source = readFileSync(new URL('./processRecording.mjs', import.meta.url), 'utf8')
  const fnBody = source.slice(
    source.indexOf('const markDoneEmptyNoSpeech = async () => {'),
    source.indexOf('\n  }\n\n  jobLog(\'job_start\''),
  )
  // The exact same detection regex already proven correct by the sibling
  // transcript-save fallback (transcriptSavePayload, a few lines above).
  const looksLikeMissingColumn = /transcript_raw|column/i.test(PRODUCTION_MISSING_TRANSCRIPT_RAW_COLUMN_ERROR.message)
  assert.ok(looksLikeMissingColumn, 'sanity: the real production error text matches the missing-column detection')
  assert.match(fnBody, /looksLikeMissingColumn = \/transcript_raw\|column\/i\.test\(msg\)/, 'markDoneEmptyNoSpeech detects a missing-column error the same way the normal transcript-save path does')
  assert.match(fnBody, /const \{ transcript_raw: _omit, \.\.\.minimalPayload \} = emptySuccessPayload/, 'the retry payload omits transcript_raw, matching the real schema (confirmed: no transcript_raw column exists in production)')
  assert.match(fnBody, /\.update\(minimalPayload\)/, 'the retry actually writes the reduced payload')
})

test('a non-missing-column database error still falls through to markFailed (the retry is not a blanket swallow-all-errors path)', () => {
  const source = readFileSync(new URL('./processRecording.mjs', import.meta.url), 'utf8')
  const fnBody = source.slice(
    source.indexOf('const markDoneEmptyNoSpeech = async () => {'),
    source.indexOf('\n  }\n\n  jobLog(\'job_start\''),
  )
  assert.match(fnBody, /if \(looksLikeMissingColumn\) \{/, 'the retry is gated specifically on looksLikeMissingColumn, not attempted unconditionally')
  assert.match(fnBody, /if \(error\) \{\s*\n\s*logPostgrestError\('markDoneEmptyNoSpeech'/, 'any error remaining after the guarded retry still falls through to the existing logPostgrestError + markFailed handling')
})

test('determineProcessingResumeStage treats a no-speech (ai_status done, empty transcript) recording as COMPLETE, never re-transcribing', () => {
  // The exact durable shape markDoneEmptyNoSpeech leaves behind.
  const noSpeechRow = {
    ai_status: 'done',
    transcript: '',
    transcript_raw: '',
    source_summary: '',
    translated_summary: null,
    summary_en: '',
    summary_zh: '',
    storage_path: 'user123/recording456.m4a',
  }
  assert.equal(
    determineProcessingResumeStage(noSpeechRow),
    PROCESSING_RESUME_STAGES.COMPLETE,
    'a done-with-empty-content recording must resolve to COMPLETE, not TRANSCRIPTION_THEN_SUMMARY (which would resubmit the same audio)',
  )
})

test('the ai_status done shortcut does not change behavior for any other status, even with an empty transcript', () => {
  // Guards against the new check accidentally treating a genuinely
  // in-progress or never-started recording as complete.
  assert.equal(
    determineProcessingResumeStage({ ai_status: 'transcribing', transcript: '', storage_path: 'a/b.m4a' }),
    PROCESSING_RESUME_STAGES.TRANSCRIPTION_THEN_SUMMARY,
  )
  assert.equal(
    determineProcessingResumeStage({ ai_status: 'failed', transcript: '', storage_path: 'a/b.m4a' }),
    PROCESSING_RESUME_STAGES.TRANSCRIPTION_THEN_SUMMARY,
  )
  assert.equal(
    determineProcessingResumeStage({ ai_status: 'queued', transcript: '' }),
    PROCESSING_RESUME_STAGES.UNRECOVERABLE,
  )
})

test('a normal (non-empty transcript) recording is completely unaffected by the ai_status done shortcut', () => {
  // Real, ordinary successful lectures also carry ai_status: 'done' — the
  // shortcut must return the same COMPLETE result the pre-existing
  // content-based logic already gave them, not a different code path.
  const normalDoneRow = {
    ai_status: 'done',
    transcript: 'This is a real transcript with actual speech content.',
    source_summary: 'A real summary.',
    translated_summary: '一个真实的摘要。',
    source_language: 'en',
    translation_language: 'zh-Hans',
  }
  assert.equal(determineProcessingResumeStage(normalDoneRow), PROCESSING_RESUME_STAGES.COMPLETE)
})
