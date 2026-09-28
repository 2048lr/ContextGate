// FIX-10：Prompt Caching
//
// 竞品基线（OpenAI / Anthropic 官方指南）：
//   * 前缀缓存按「前缀逐字节相同」命中；官方明确要求 Keep the prefix stable，
//     时间戳、用户相关内容等动态内容必须放到末尾，否则每次请求都会重置缓存；
//   * Anthropic 需要在稳定前缀的最后一个块上显式打 cache_control: {type:'ephemeral'}
//     的断点（最多 4 个），否则不会缓存；
//   * OpenAI 自动前缀缓存不需要注入，但同样依赖前缀稳定（最小可缓存前缀 1024 token）；
//   * 官方要求直接统计 usage 里的 cached_tokens / cache_creation_input_tokens
//     来核算「缓存读 0.1x、缓存写 1.25x」带来的节省。
//
// 本模块做三件事：① 按 provider 形态注入 Anthropic 缓存断点；
// ② 检查前缀是否稳定并给出可操作告警；③ 把 usage 里的缓存字段归一化成可上报的指标。

const DEFAULT_MIN_PREFIX_TOKENS = 1024
const MAX_ANTHROPIC_BREAKPOINTS = 4

// 动态内容特征：出现在前缀里就会让缓存永远无法复用
const VOLATILE_PATTERNS = [
  { id: 'iso_timestamp', re: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/ },
  { id: 'generated_at', re: /\bgenerated\s*(at|on)\b/i },
  { id: 'uuid', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { id: 'request_id', re: /\b(request|session|trace)[-_ ]?id\b\s*[:=]/i },
  { id: 'nonce', re: /\bnonce\b\s*[:=]/i },
  { id: 'date_only', re: /\b(20\d{2})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/ },
]

function estimateTokensFromString(text) {
  if (typeof text !== 'string' || !text) return 0
  // 与现有 scanner.js 的估算口径保持一致：约 4 字符 1 token
  return Math.ceil(text.length / 4)
}

function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (typeof block.text === 'string') parts.push(block.text)
    else if (typeof block.content === 'string') parts.push(block.content)
    else if (typeof block.input === 'object') { try { parts.push(JSON.stringify(block.input)) } catch { /* 忽略 */ } }
  }
  return parts.join('\n')
}

/** 估算「会被缓存的前缀」的 token 数：system + tools + 除最后一条用户消息之外的对话 */
function estimatePrefixTokens(body) {
  if (!body || typeof body !== 'object') return 0
  let total = 0
  total += estimateTokensFromString(contentToText(body.system))
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      total += estimateTokensFromString(tool?.function?.name || tool?.name)
      total += estimateTokensFromString(tool?.function?.description || tool?.description)
      try { total += estimateTokensFromString(JSON.stringify(tool?.function?.parameters || tool?.input_schema || {})) } catch { /* 忽略 */ }
    }
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (let i = 0; i < Math.max(0, messages.length - 1); i++) {
    total += estimateTokensFromString(contentToText(messages[i]?.content))
  }
  const instructions = body.instructions
  total += estimateTokensFromString(contentToText(instructions))
  return total
}

/**
 * 检查前缀稳定性。返回命中的动态内容摘录，供 UI/日志提示。
 * 只检查「前缀」部分（system / instructions / tools / 除最后一条外的消息），
 * 因为末尾的动态内容不会破坏前缀缓存。
 */
function stabilityReport(body) {
  if (!body || typeof body !== 'object') return { stable: true, volatile: [] }
  const segments = []
  segments.push(['system', contentToText(body.system)])
  segments.push(['instructions', contentToText(body.instructions)])
  if (Array.isArray(body.tools)) {
    for (let i = 0; i < body.tools.length; i++) {
      try { segments.push([`tools[${i}]`, JSON.stringify(body.tools[i])]) } catch { /* 忽略 */ }
    }
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (let i = 0; i < Math.max(0, messages.length - 1); i++) {
    segments.push([`messages[${i}]`, contentToText(messages[i]?.content)])
  }

  const volatile = []
  for (const [where, text] of segments) {
    if (!text) continue
    for (const p of VOLATILE_PATTERNS) {
      const m = p.re.exec(text)
      if (m) volatile.push({ where, kind: p.id, sample: m[0].slice(0, 60) })
    }
  }
  return { stable: volatile.length === 0, volatile }
}

function hasCacheControl(value) {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(hasCacheControl)
  if (value.cache_control) return true
  return false
}

function markEphemeral(block, ttl) {
  if (!block || typeof block !== 'object') return null
  if (block.cache_control) return null
  block.cache_control = ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' }
  return block
}

/**
 * 给 Anthropic 形态的请求注入缓存断点（最多 4 个）：
 *   ① tools 的最后一项  ② system 的最后一个块  ③ 最后一条消息的最后一个内容块
 * 断点只加在「稳定前缀」的末尾；客户端已经显式打过 cache_control 时默认不覆盖。
 *
 * @returns {{body:object, injected:number, breakpoints:string[], skipped:string}}
 */
function injectAnthropicCacheControl(body, opts = {}) {
  const { minPrefixTokens = DEFAULT_MIN_PREFIX_TOKENS, ttl = null, overrideClient = false } = opts
  const result = { body, injected: 0, breakpoints: [], skipped: null }
  if (!body || typeof body !== 'object') { result.skipped = 'invalid_body'; return result }
  if (!overrideClient && (hasCacheControl(body.system) || hasCacheControl(body.tools) || hasCacheControl(body.messages))) {
    result.skipped = 'client_already_set'
    return result
  }
  const prefixTokens = estimatePrefixTokens(body)
  if (prefixTokens < minPrefixTokens) {
    // Anthropic 对短前缀不会缓存，强行注入只是浪费断点
    result.skipped = `prefix_below_minimum(${prefixTokens}<${minPrefixTokens})`
    result.prefixTokens = prefixTokens
    return result
  }
  result.prefixTokens = prefixTokens

  const out = { ...body }
  let injected = 0

  if (Array.isArray(out.tools) && out.tools.length > 0 && injected < MAX_ANTHROPIC_BREAKPOINTS) {
    const tools = out.tools.map((t, i) => (i === out.tools.length - 1 ? { ...t } : t))
    if (markEphemeral(tools[tools.length - 1], ttl)) {
      out.tools = tools
      injected++
      result.breakpoints.push('tools[last]')
    }
  }

  if (out.system !== undefined && out.system !== null && injected < MAX_ANTHROPIC_BREAKPOINTS) {
    if (typeof out.system === 'string') {
      out.system = [{ type: 'text', text: out.system, cache_control: ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' } }]
      injected++
      result.breakpoints.push('system')
    } else if (Array.isArray(out.system) && out.system.length > 0) {
      const system = out.system.map((b, i) => (i === out.system.length - 1 ? { ...b } : b))
      if (markEphemeral(system[system.length - 1], ttl)) {
        out.system = system
        injected++
        result.breakpoints.push('system[last]')
      }
    }
  }

  if (Array.isArray(out.messages) && out.messages.length > 0 && injected < MAX_ANTHROPIC_BREAKPOINTS) {
    const idx = out.messages.length - 1
    const last = out.messages[idx]
    if (last && typeof last === 'object') {
      let content = last.content
      if (typeof content === 'string') {
        content = [{ type: 'text', text: content, cache_control: ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' } }]
        injected++
        result.breakpoints.push(`messages[${idx}].content`)
      } else if (Array.isArray(content) && content.length > 0) {
        const blocks = content.map((b, i) => (i === content.length - 1 ? { ...b } : b))
        if (markEphemeral(blocks[blocks.length - 1], ttl)) {
          content = blocks
          injected++
          result.breakpoints.push(`messages[${idx}].content[last]`)
        }
      }
      if (content !== last.content) {
        out.messages = out.messages.map((m, i) => (i === idx ? { ...m, content } : m))
      }
    }
  }

  result.body = out
  result.injected = injected
  return result
}

/**
 * 统一入口：按 provider 形态决定是否注入。
 * @returns {{body:object, meta:object}} meta 会写进 request:log，供 UI 判断缓存是否真的可能命中
 */
function applyPromptCache(body, providerConfig, config = {}) {
  const meta = {
    enabled: config.enabled !== false,
    applied: false,
    strategy: 'none',
    reason: null,
    injected: 0,
    breakpoints: [],
    prefixTokens: estimatePrefixTokens(body),
    minPrefixTokens: config.min_prefix_tokens ?? DEFAULT_MIN_PREFIX_TOKENS,
  }
  if (!body || typeof body !== 'object') { meta.reason = 'invalid_body'; return { body, meta } }
  if (meta.enabled === false) { meta.reason = 'disabled'; return { body, meta } }
  if (body.stream === true && providerConfig?.prompt_cache_on_stream === false) {
    meta.reason = 'stream_disabled_by_provider'
    return { body, meta }
  }

  const format = String(providerConfig?.format || 'openai').toLowerCase()
  const stability = config.openai_prefix_stability === false ? { stable: true, volatile: [] } : stabilityReport(body)
  meta.prefixStable = stability.stable
  meta.volatile = stability.volatile

  if (format === 'anthropic' && config.anthropic_cache_control !== false) {
    const r = injectAnthropicCacheControl(body, {
      minPrefixTokens: meta.minPrefixTokens,
      ttl: config.ttl || null,
      overrideClient: config.override_client === true,
    })
    meta.strategy = 'anthropic_cache_control'
    meta.applied = r.injected > 0
    meta.injected = r.injected
    meta.breakpoints = r.breakpoints
    meta.reason = r.skipped
    return { body: r.body, meta }
  }

  // OpenAI 兼容：不需要注入，但要保证前缀稳定（时间戳等必须挪到末尾）
  meta.strategy = 'openai_prefix'
  meta.applied = stability.stable
  meta.reason = stability.stable ? null : 'volatile_prefix'
  return { body, meta }
}

/**
 * 把归一化 usage 转成可上报的 Prompt Caching 指标。
 * 缓存读命中 = 省下 (input 价 - 缓存读价) * cached_tokens；
 * 缓存写 = 多付 (缓存写价 - input 价) * cache_write_tokens。
 */
function promptCacheMetrics(usageNorm, pricing) {
  const cached = Number(usageNorm?.cached_tokens) || 0
  const write = Number(usageNorm?.cache_write_tokens) || 0
  const inputPrice = Number(pricing?.input) || 0
  const readPrice = Number(pricing?.cacheRead ?? inputPrice) || 0
  const writePrice = Number(pricing?.cacheWrite ?? inputPrice) || 0
  return {
    cacheReadTokens: cached,
    cacheWriteTokens: write,
    cacheHit: cached > 0,
    savedUSD: Math.max(0, (inputPrice - readPrice) * cached),
    writePremiumUSD: Math.max(0, (writePrice - inputPrice) * write),
  }
}

/** 进程内累计的 Prompt Caching 统计（/stats 用） */
class PromptCacheStats {
  constructor() { this.reset() }
  reset() {
    this.requests = 0
    this.requestsWithCacheRead = 0
    this.cacheReadTokens = 0
    this.cacheWriteTokens = 0
    this.savedUSD = 0
    this.writePremiumUSD = 0
    this.requestsWithStablePrefix = 0
  }
  record(metrics, meta) {
    this.requests++
    if (meta?.prefixStable !== false) this.requestsWithStablePrefix++
    if (!metrics) return
    this.cacheReadTokens += metrics.cacheReadTokens || 0
    this.cacheWriteTokens += metrics.cacheWriteTokens || 0
    this.savedUSD += metrics.savedUSD || 0
    this.writePremiumUSD += metrics.writePremiumUSD || 0
    if (metrics.cacheHit) this.requestsWithCacheRead++
  }
  summary() {
    return {
      requests: this.requests,
      requestsWithCacheRead: this.requestsWithCacheRead,
      hitRate: this.requests > 0 ? this.requestsWithCacheRead / this.requests : 0,
      prefixStableRate: this.requests > 0 ? this.requestsWithStablePrefix / this.requests : 0,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      savedUSD: Number(this.savedUSD.toFixed(6)),
      writePremiumUSD: Number(this.writePremiumUSD.toFixed(6)),
    }
  }
}

module.exports = {
  DEFAULT_MIN_PREFIX_TOKENS,
  MAX_ANTHROPIC_BREAKPOINTS,
  VOLATILE_PATTERNS,
  estimateTokensFromString,
  estimatePrefixTokens,
  stabilityReport,
  injectAnthropicCacheControl,
  applyPromptCache,
  promptCacheMetrics,
  PromptCacheStats,
}
