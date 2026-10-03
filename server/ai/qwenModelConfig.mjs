/**
 * Central selection for Model Studio text generation.
 *
 * Keep this independent from ASR: Paraformer model selection belongs to the
 * hosted adapter and is intentionally not coupled to this text-model setting.
 */
export const DEFAULT_QWEN_CHAT_MODEL = 'qwen-flash'

/** Models that must never be selected for a new text request. */
export const RETIRED_QWEN_CHAT_MODELS = new Set(['qwen-turbo'])

function normalizedModel(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function isRetiredQwenChatModel(model) {
  return RETIRED_QWEN_CHAT_MODELS.has(normalizedModel(model))
}

/**
 * Returns secret-free configuration diagnostics without throwing. This allows
 * health diagnostics to disclose a stale deployment setting safely, while the
 * request path below still fails before making a provider call.
 */
export function getQwenChatModelConfig(env = process.env) {
  const configured = normalizedModel(env.YUMI_QWEN_CHAT_MODEL)
  const model = configured || DEFAULT_QWEN_CHAT_MODEL
  return {
    model,
    source: configured ? 'YUMI_QWEN_CHAT_MODEL' : 'default',
    isRetired: isRetiredQwenChatModel(model),
  }
}

/**
 * Reject a retired model explicitly instead of silently switching models.
 * This is deliberately called immediately before a DashScope text request so
 * a stale production override cannot create an ambiguous partial fallback.
 */
export function assertSupportedQwenChatModel(model) {
  const selected = normalizedModel(model)
  if (!selected) {
    const error = new Error('QWEN_CHAT_MODEL_MISSING')
    error.code = 'QWEN_CHAT_MODEL_MISSING'
    throw error
  }
  if (isRetiredQwenChatModel(selected)) {
    const error = new Error('QWEN_CHAT_MODEL_RETIRED')
    error.code = 'QWEN_CHAT_MODEL_RETIRED'
    throw error
  }
  return selected
}

/** Resolve the current environment default or a supported stable override. */
export function resolveQwenChatModel(env = process.env) {
  return assertSupportedQwenChatModel(getQwenChatModelConfig(env).model)
}
