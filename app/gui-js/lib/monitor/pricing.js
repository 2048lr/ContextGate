// FIX-04：价格解析
//
// 问题：原实现把 22 个模型的价格硬编码在 cost-calculator.js 里，遇到
// claude-3-5-sonnet-20241022 这类带日期后缀的真实 ID 前缀匹配失败 → 成本记 0。
// 现在改为「models.dev 目录优先 + 本地覆盖表兜底」，并对模型 ID 做归一化。

// 本地兜底价格表（每百万 token 的美元价）。仅在 models.dev 目录不可用时使用。
const LOCAL_PRICING_PER_MILLION = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-4': { input: 30, output: 60 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'o1': { input: 15, output: 60 },
  'o1-mini': { input: 3, output: 12 },
  'o3-mini': { input: 1.1, output: 4.4 },
  // Anthropic 官方 ID 使用中划线；同时保留点号写法作为别名
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3.5-sonnet': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-3.5-haiku': { input: 0.8, output: 4 },
  'claude-3-opus': { input: 15, output: 75 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-opus-4': { input: 15, output: 75 },
  'deepseek-chat': { input: 0.27, output: 1.1 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
  'glm-4': { input: 0.1, output: 0.1 },
  'glm-4-flash': { input: 0.01, output: 0.01 },
  'qwen-turbo': { input: 0.3, output: 0.6 },
  'qwen-plus': { input: 0.8, output: 2 },
  'qwen-max': { input: 2.4, output: 9.6 },
  'gemini-1.5-pro': { input: 1.25, output: 5 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
}

// OpenAI 官方口径：缓存读取约 0.1x 未缓存输入价，缓存写入 1.25x
const DEFAULT_CACHE_READ_MULTIPLIER = 0.1
const DEFAULT_CACHE_WRITE_MULTIPLIER = 1.25

const DATE_SUFFIX_RE = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/
const NOISE_SUFFIX_RE = /-(?:latest|preview|beta|exp|experimental|stable)$/

// 归一化模型 ID：去掉 provider 前缀、日期后缀、渠道后缀（OpenRouter 的 :free 等）
function normalizeModelId(model) {
  if (!model || typeof model !== 'string') return ''
  let id = model.trim().toLowerCase()
  if (!id) return ''
  // provider 前缀：openai/gpt-4o、openrouter/anthropic/claude-3-5-sonnet
  const slash = id.lastIndexOf('/')
  if (slash !== -1) id = id.slice(slash + 1)
  // 渠道后缀：openrouter 的 claude-3-5-sonnet:free
  const colon = id.indexOf(':')
  if (colon !== -1) id = id.slice(0, colon)
  let prev = null
  while (prev !== id) {
    prev = id
    id = id.replace(DATE_SUFFIX_RE, '')
    id = id.replace(NOISE_SUFFIX_RE, '')
  }
  return id
}

function perMillionToPerToken(pricing) {
  return {
    input: (pricing.input || 0) / 1e6,
    output: (pricing.output || 0) / 1e6,
    cacheRead: (pricing.cache_read ?? pricing.cacheRead ?? null) !== null
      ? (pricing.cache_read ?? pricing.cacheRead) / 1e6
      : ((pricing.input || 0) * DEFAULT_CACHE_READ_MULTIPLIER) / 1e6,
    cacheWrite: (pricing.cache_write ?? pricing.cacheWrite ?? null) !== null
      ? (pricing.cache_write ?? pricing.cacheWrite) / 1e6
      : ((pricing.input || 0) * DEFAULT_CACHE_WRITE_MULTIPLIER) / 1e6,
  }
}

function localCatalog() {
  const map = new Map()
  for (const [id, pricing] of Object.entries(LOCAL_PRICING_PER_MILLION)) {
    map.set(normalizeModelId(id), { ...perMillionToPerToken(pricing), source: 'local' })
  }
  return map
}

const _local = localCatalog()

// models.dev 目录 → 归一化索引；按 provider 分桶，避免同名模型串价
function buildCatalog(modelsDevData) {
  const byProvider = new Map()
  const global = new Map()
  if (!modelsDevData || typeof modelsDevData !== 'object') return { byProvider, global }
  for (const [providerId, provider] of Object.entries(modelsDevData)) {
    const models = provider?.models
    if (!models || typeof models !== 'object') continue
    const bucket = new Map()
    for (const [modelId, info] of Object.entries(models)) {
      const cost = info?.cost
      if (!cost || (cost.input === undefined && cost.output === undefined)) continue
      const entry = { ...perMillionToPerToken(cost), source: 'models.dev', modelId }
      const key = normalizeModelId(modelId)
      if (!key) continue
      if (!bucket.has(key)) bucket.set(key, entry)
      if (!global.has(key)) global.set(key, entry)
    }
    byProvider.set(providerId, bucket)
  }
  return { byProvider, global }
}

function findInMap(map, normalizedId) {
  if (!map || !normalizedId) return null
  const direct = map.get(normalizedId)
  if (direct) return direct
  // 最长前缀：目录里 claude-3-5-sonnet 可以服务 claude-3-5-sonnet 变体
  let best = null
  let bestLen = 0
  for (const [key, entry] of map) {
    if (key.length > bestLen && normalizedId.startsWith(key)) { best = entry; bestLen = key.length }
  }
  return best
}

/**
 * 解析价格。
 * @param {string} model 模型 ID（可带 provider 前缀 / 日期后缀）
 * @param {{ providerId?: string, modelsDevData?: object, catalog?: object }} [opts]
 * @returns {{ input:number, output:number, cacheRead:number, cacheWrite:number, source:string }|null}
 *          每 token 美元价；无法识别时返回 null（调用方必须显式区分「价格未知」与「成本为 0」）
 */
function resolvePricing(model, opts = {}) {
  const normalized = normalizeModelId(model)
  if (!normalized) return null
  const catalog = opts.catalog || (opts.modelsDevData ? buildCatalog(opts.modelsDevData) : null)
  if (catalog) {
    if (opts.providerId && catalog.byProvider?.has(opts.providerId)) {
      const hit = findInMap(catalog.byProvider.get(opts.providerId), normalized)
      if (hit) return hit
    }
    const globalHit = findInMap(catalog.global, normalized)
    if (globalHit) return globalHit
  }
  const localHit = findInMap(_local, normalized)
  if (localHit) return localHit
  return null
}

module.exports = {
  LOCAL_PRICING_PER_MILLION,
  DEFAULT_CACHE_READ_MULTIPLIER,
  DEFAULT_CACHE_WRITE_MULTIPLIER,
  normalizeModelId,
  buildCatalog,
  resolvePricing,
  perMillionToPerToken,
}
