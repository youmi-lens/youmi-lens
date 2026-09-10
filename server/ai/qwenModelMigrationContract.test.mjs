import { afterEach, describe, expect, it, vi } from 'vitest'

import { byokSummarize, byokTranslate } from './byok/adapters.mjs'
import * as hosted from './hosted/youmiHosted.mjs'

const ENV_KEYS = [
  'DASHSCOPE_API_KEY',
  'DASHSCOPE_OVERSEAS_API_KEY',
  'ENABLE_STUB_AI',
  'VITE_ENABLE_STUB_AI',
  'YUMI_QWEN_CHAT_MODEL',
]
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
const originalFetch = globalThis.fetch

function restoreEnvironment() {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] == null) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  globalThis.fetch = originalFetch
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(restoreEnvironment)

describe('Qwen text-model migration runtime contract', () => {
  it('sends hosted translation and structured summaries through qwen-flash without changing their response shape', async () => {
    process.env.ENABLE_STUB_AI = 'false'
    delete process.env.VITE_ENABLE_STUB_AI
    process.env.DASHSCOPE_API_KEY = 'test-only-key'
    delete process.env.DASHSCOPE_OVERSEAS_API_KEY
    delete process.env.YUMI_QWEN_CHAT_MODEL
    const requests = []
    globalThis.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body)
      requests.push(body)
      return jsonResponse({
        model: body.model,
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        choices: [{ message: { content: body.response_format ? JSON.stringify({
          source_summary: 'Source summary',
          translated_summary: 'Translated summary',
        }) : '翻译结果' } }],
      })
    })
    await expect(hosted.translateText('Class begins now.', 'Simplified Chinese')).resolves.toBe('翻译结果')
    await expect(hosted.summarizeTranscript('Lecture transcript', 'CS111', 'Lecture 1')).resolves.toMatchObject({
      sourceSummary: 'Source summary',
      translatedSummary: 'Translated summary',
      usage: { provider: 'dashscope', model: 'qwen-flash' },
    })
    expect(requests).toHaveLength(2)
    expect(requests.map((request) => request.model)).toEqual(['qwen-flash', 'qwen-flash'])
    expect(requests[0].max_tokens).toBe(1024)
    expect(requests[1].max_tokens).toBe(4000)
    expect(requests[1].response_format).toEqual({ type: 'json_object' })
  })

  it('uses the same central model selection for Qwen BYOK text requests', async () => {
    delete process.env.YUMI_QWEN_CHAT_MODEL
    const requests = []
    globalThis.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body)
      requests.push(body)
      return jsonResponse({ choices: [{ message: { content: '翻译结果' } }] })
    })
    await expect(byokTranslate('qwen', 'Class begins now.', 'zh', 'test-only-key')).resolves.toBe('翻译结果')
    expect(requests[0].model).toBe('qwen-flash')
    expect(requests[0].max_tokens).toBe(1024)
  })

  it('maps the shared structured-summary fields back to the established BYOK response shape', async () => {
    delete process.env.YUMI_QWEN_CHAT_MODEL
    const requests = []
    globalThis.fetch = vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body))
      return jsonResponse({
      choices: [{ message: { content: JSON.stringify({
        source_summary: 'English summary',
        translated_summary: '中文摘要',
      }) } }],
      })
    })

    await expect(byokSummarize('qwen', 'Transcript', 'Course', 'Title', 'test-only-key')).resolves.toEqual({
      summaryEn: 'English summary',
      summaryZh: '中文摘要',
    })
    expect(requests[0].max_tokens).toBe(4000)
  })

  it('fails before a request when an old deployment override still selects qwen-turbo', async () => {
    process.env.ENABLE_STUB_AI = 'false'
    delete process.env.VITE_ENABLE_STUB_AI
    process.env.DASHSCOPE_API_KEY = 'test-only-key'
    process.env.YUMI_QWEN_CHAT_MODEL = 'qwen-turbo'
    globalThis.fetch = vi.fn()
    await expect(hosted.translateText('Class begins now.', 'Simplified Chinese')).rejects.toThrow(
      'QWEN_CHAT_MODEL_RETIRED',
    )
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('fails hosted translation/summary instead of returning a max_tokens-truncated result', async () => {
    process.env.ENABLE_STUB_AI = 'false'
    delete process.env.VITE_ENABLE_STUB_AI
    process.env.DASHSCOPE_API_KEY = 'test-only-key'
    delete process.env.DASHSCOPE_OVERSEAS_API_KEY
    delete process.env.YUMI_QWEN_CHAT_MODEL
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        model: 'qwen-flash',
        choices: [{ finish_reason: 'length', message: { content: 'The lecture begins and then cuts' } }],
      }),
    )
    await expect(hosted.translateText('Long transcript chunk.', 'Simplified Chinese')).rejects.toThrow(
      'HOSTED_CHAT_TRUNCATED',
    )
    await expect(hosted.summarizeTranscript('Long transcript', 'CS111', 'Lecture 1')).rejects.toThrow(
      'HOSTED_CHAT_TRUNCATED',
    )
  })

  it('fails BYOK translation/summary instead of returning a max_tokens-truncated result', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        choices: [{ finish_reason: 'length', message: { content: 'partial' } }],
      }),
    )
    await expect(byokTranslate('qwen', 'Long text.', 'zh', 'test-only-key')).rejects.toThrow(
      'BYOK_CHAT_TRUNCATED',
    )
    await expect(byokSummarize('qwen', 'Long transcript', 'Course', 'Title', 'test-only-key')).rejects.toThrow(
      'BYOK_CHAT_TRUNCATED',
    )
  })
})
