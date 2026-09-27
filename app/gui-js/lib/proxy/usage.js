// FIX-04：usage 归一化与流式 usage 提取
//
// 问题：OpenAI 兼容接口只有在请求里带 stream_options.include_usage 时，
// 才会在最后一个 SSE chunk 回传 usage；因此代理原先在流式场景下恒记账 0 token。

const STREAM_USAGE_OPTION = { include_usage: true }

// 明确不支持 stream_options 的 provider（OpenAI 兼容层为 beta / 字段受限）
const STREAM_USAGE_DENYLIST = new Set(['anthropic'])

function isOpenAICompatible(providerConfig) {
  const format = (providerConfig?.format || 'openai').toLowerCase()
  return format === 'openai'
}

function shouldInjectStreamUsage(providerConfig, body, proxyConfig = {}) {
  if (proxyConfig.inject_stream_usage === false) return false
  if (!body || typeof body !== 'object') return false
  if (!body.stream) return false
  if (body.stream_options !== undefined) return false
  if (providerConfig?.supports_stream_usage === false) return false
  if (!isOpenAICompatible(providerConfig)) return false
  if (STREAM_USAGE_DENYLIST.has((providerConfig?.id || '').toLowerCase())) return false
  return true
}

function isStreamOptionsRejection(error) {
  if (!error?.response) return false
  const status = error.response.status
  if (status !== 400 && status !== 422) return false
  const data = error.response.data
  const text = typeof data === 'string' ? data : JSON.stringify(data || {})
  return /stream_options|include_usage/i.test(text)
}

function toNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// 归一化 usage：同时兼容 OpenAI（inclusive 缓存计数）与 Anthropic 原生（exclusive）
function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') {
    return emptyUsage()
  }
  const prompt = toNumber(raw.prompt_tokens ?? raw.input_tokens)
  const completion = toNumber(raw.completion_tokens ?? raw.output_tokens)
  const total = toNumber(raw.total_tokens) || (prompt + completion)

  const details = raw.prompt_tokens_details || raw.input_tokens_details || {}
  const completionDetails = raw.completion_tokens_details || raw.output_tokens_details || {}

  // Anthropic 原生 usage 里 input_tokens 不含缓存读/写；OpenAI 的 prompt_tokens 含。
  const anthropicShape = raw.cache_read_input_tokens !== undefined || raw.cache_creation_input_tokens !== undefined
  const cachedTokens = toNumber(details.cached_tokens ?? raw.cache_read_input_tokens)
  const cacheWriteTokens = toNumber(details.cache_write_tokens ?? raw.cache_creation_input_tokens)
  const reasoningTokens = toNumber(completionDetails.reasoning_tokens)

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    cached_tokens: cachedTokens,
    cache_write_tokens: cacheWriteTokens,
    reasoning_tokens: reasoningTokens,
    cached_inclusive: !anthropicShape,
    raw,
  }
}

function emptyUsage() {
  return {
    prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
    cached_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
    cached_inclusive: true, raw: null,
  }
}

// 扫描「全部」SSE chunk，取最后一个含 usage 的对象。
// 只取最后一个 chunk 会漏掉部分上游把 usage 放在倒数第二个 chunk 的实现。
function extractUsageFromSSE(rawChunks) {
  if (!Array.isArray(rawChunks) || rawChunks.length === 0) return emptyUsage()
  let buffer = ''
  for (const chunk of rawChunks) buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
  let found = null
  for (const rawLine of buffer.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload)
      if (parsed && typeof parsed === 'object' && parsed.usage) found = parsed.usage
    } catch { /* 非 JSON 的行（如 ping 注释）忽略 */ }
  }
  return normalizeUsage(found)
}

function extractUsageFromResponse(data) {
  if (data && typeof data === 'object' && data.usage) return normalizeUsage(data.usage)
  return emptyUsage()
}

module.exports = {
  STREAM_USAGE_OPTION,
  STREAM_USAGE_DENYLIST,
  shouldInjectStreamUsage,
  isStreamOptionsRejection,
  isOpenAICompatible,
  normalizeUsage,
  emptyUsage,
  extractUsageFromSSE,
  extractUsageFromResponse,
}
