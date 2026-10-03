import { describe, expect, it } from 'vitest'

import {
  DEFAULT_QWEN_CHAT_MODEL,
  assertSupportedQwenChatModel,
  getQwenChatModelConfig,
  resolveQwenChatModel,
} from './qwenModelConfig.mjs'

describe('Qwen text-model migration configuration', () => {
  it('uses the current stable flash model when no override is configured', () => {
    expect(DEFAULT_QWEN_CHAT_MODEL).toBe('qwen-flash')
    expect(resolveQwenChatModel({})).toBe('qwen-flash')
    expect(getQwenChatModelConfig({})).toEqual({
      model: 'qwen-flash',
      source: 'default',
      isRetired: false,
    })
  })

  it('preserves the existing override name for a supported rollback model', () => {
    expect(resolveQwenChatModel({ YUMI_QWEN_CHAT_MODEL: 'qwen-plus' })).toBe('qwen-plus')
  })

  it('rejects the retired model before any provider request can be made', () => {
    expect(getQwenChatModelConfig({ YUMI_QWEN_CHAT_MODEL: 'qwen-turbo' })).toEqual({
      model: 'qwen-turbo',
      source: 'YUMI_QWEN_CHAT_MODEL',
      isRetired: true,
    })
    expect(() => resolveQwenChatModel({ YUMI_QWEN_CHAT_MODEL: 'qwen-turbo' })).toThrow(
      'QWEN_CHAT_MODEL_RETIRED',
    )
    expect(() => assertSupportedQwenChatModel('qwen-turbo')).toThrow('QWEN_CHAT_MODEL_RETIRED')
  })
})
