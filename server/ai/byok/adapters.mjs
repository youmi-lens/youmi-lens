/**
 * BYOK adapters (server-side proxy). Keys are never persisted; passed per request only.
 */

import { buildSummarizeMessages } from '../summarizePrompt.mjs'
import { extractSummaryFields, parseJsonObjectLoose } from '../summaryResponseParsing.mjs'
import { resolveQwenChatModel } from '../qwenModelConfig.mjs'

const OPENAI_AUDIO = 'https://api.openai.com/v1/audio/transcriptions'
const OPENAI_CHAT = 'https://api.openai.com/v1/chat/completions'
const DEEPSEEK_CHAT = 'https://api.deepseek.com/v1/chat/completions'
const DASHSCOPE_COMPAT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'

function nodeBufferToArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

export const byokProviderCapabilities = {
  openai: { transcribe: true, translate: true, summarize: true },
  deepseek: { transcribe: false, translate: true, summarize: true },
  qwen: { transcribe: false, translate: true, summarize: true },
}

export async function byokTranscribeOpenai(buffer, mime, filename, apiKey) {
  const ab = Buffer.isBuffer(buffer) ? nodeBufferToArrayBuffer(buffer) : buffer
  const u8 = new Uint8Array(ab)
  const body = new FormData()
  if (typeof File !== 'undefined') {
    body.append('file', new File([u8], filename, { type: mime }))
  } else {
    body.append('file', new Blob([u8], { type: mime }), filename)
  }
  body.append('model', 'whisper-1')
  const r = await fetch(OPENAI_AUDIO, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
  })
  const text = await r.text()
  if (!r.ok) throw new Error('BYOK_TRANSCRIBE_FAILED')
  const json = JSON.parse(text)
  return json.text ?? ''
}

async function chatOpenAiCompatible(url, apiKey, model, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, ...body }),
  })
  const raw = await r.text()
  if (!r.ok) throw new Error('BYOK_CHAT_FAILED')
  const data = JSON.parse(raw)
  const choice = data.choices?.[0]
  // A max_tokens cutoff must fail loudly, not hand back partial text as a
  // completed translation/summary. Callers surface this as a request error.
  if (choice?.finish_reason === 'length') throw new Error('BYOK_CHAT_TRUNCATED')
  return choice?.message?.content ?? ''
}

export async function byokSummarize(provider, transcript, course, title, apiKey) {
  const messages = buildSummarizeMessages(transcript, course, title)
  const payload = {
    temperature: 0.3,
    // Matches the hosted-adapter budget (youmiHosted.mjs summarizeTranscript):
    // the shared prompt has no length cap and asks for a full two-language
    // structured summary in one JSON response.
    max_tokens: 4000,
    response_format: { type: 'json_object' },
    messages,
  }
  let raw
  if (provider === 'openai') {
    raw = await chatOpenAiCompatible(OPENAI_CHAT, apiKey, 'gpt-4o-mini', payload)
  } else if (provider === 'deepseek') {
    raw = await chatOpenAiCompatible(DEEPSEEK_CHAT, apiKey, 'deepseek-chat', payload)
  } else if (provider === 'qwen') {
    raw = await chatOpenAiCompatible(DASHSCOPE_COMPAT, apiKey, resolveQwenChatModel(), payload)
  } else {
    throw new Error('BAD_PROVIDER')
  }

  const parsed = parseJsonObjectLoose(raw)
  if (!parsed) throw new Error('BYOK_SUMMARY_PARSE')
  // The provider-neutral prompt uses source/translated names; retain the
  // public BYOK response contract (summaryEn/summaryZh) and accept the legacy
  // field names only for compatibility with older provider responses.
  const { sourceSummary: summaryEn, translatedSummary: summaryZh } = extractSummaryFields(parsed)
  if (!summaryEn || !summaryZh) throw new Error('BYOK_SUMMARY_SHAPE')
  return { summaryEn, summaryZh }
}

export async function byokTranslate(provider, text, target, apiKey) {
  if (target !== 'zh' && target !== 'en') throw new Error('BAD_TARGET')
  const system =
    target === 'zh'
      ? 'You translate live classroom captions. Output Simplified Chinese only. Keep natural lecture tone. Output only the translation, no quotes, labels, or explanations.'
      : 'You translate live classroom captions into natural English. Output only the translation, no quotes, labels, or explanations.'
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: text.trim() },
  ]
  let out
  if (provider === 'openai') {
    out = await chatOpenAiCompatible(OPENAI_CHAT, apiKey, 'gpt-4o-mini', {
      temperature: 0.2,
      max_tokens: 1024,
      messages,
    })
  } else if (provider === 'deepseek') {
    out = await chatOpenAiCompatible(DEEPSEEK_CHAT, apiKey, 'deepseek-chat', {
      temperature: 0.2,
      messages,
    })
  } else if (provider === 'qwen') {
    out = await chatOpenAiCompatible(DASHSCOPE_COMPAT, apiKey, resolveQwenChatModel(), {
      temperature: 0.2,
      // Matches the OpenAI branch above — this path also serves chunked
      // post-class transcript translation (up to 1600 source chars), not
      // just short live-caption text.
      max_tokens: 1024,
      messages,
    })
  } else {
    throw new Error('BAD_PROVIDER')
  }
  return out.trim()
}
