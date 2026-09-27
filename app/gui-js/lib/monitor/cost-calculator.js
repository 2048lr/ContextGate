const {
  LOCAL_PRICING_PER_MILLION,
  resolvePricing,
  normalizeModelId,
  buildCatalog,
  perMillionToPerToken,
} = require('./pricing')

// 向后兼容导出：每 token 的本地兜底价格表
const MODEL_PRICING = {}
for (const [id, pricing] of Object.entries(LOCAL_PRICING_PER_MILLION)) {
  MODEL_PRICING[id] = { input: pricing.input / 1e6, output: pricing.output / 1e6 }
}

/**
 * 计算一次请求的成本（FIX-04）。
 *
 * 与旧版的关键区别：
 *  - 价格来自 models.dev 目录优先 + 本地表兜底，模型 ID 会做归一化
 *    （claude-3-5-sonnet-20241022 现在可以算出价格，而不是记 0）；
 *  - 建模缓存读/写折扣（OpenAI 口径：读 ≈ 0.1x、写 ≈ 1.25x 输入价）；
 *  - 价格未知时 known=false，调用方必须显式区分「未知」与「0 成本」。
 *
 * @param {string} model
 * @param {object} usage normalizeUsage() 的输出（或 {prompt_tokens, completion_tokens}）
 * @param {object} [opts] { providerId, modelsDevData, catalog }
 * @returns {{cost:number, known:boolean, source:string|null, pricing:object|null, savedCost:number}}
 */
function computeUsageCost(model, usage, opts = {}) {
  if (!model) return { cost: 0, known: false, source: null, pricing: null, savedCost: 0 }
  const pricing = resolvePricing(model, opts)
  if (!pricing) return { cost: 0, known: false, source: null, pricing: null, savedCost: 0 }

  const u = usage || {}
  const prompt = Number(u.prompt_tokens) || 0
  const completion = Number(u.completion_tokens) || 0
  const cached = Number(u.cached_tokens) || 0
  const cacheWrite = Number(u.cache_write_tokens) || 0
  const inclusive = u.cached_inclusive !== false

  // OpenAI 的 prompt_tokens 含缓存命中；Anthropic 原生 usage 不含
  const uncachedInput = inclusive ? Math.max(0, prompt - cached - cacheWrite) : prompt

  const cost =
    uncachedInput * pricing.input +
    cached * pricing.cacheRead +
    cacheWrite * pricing.cacheWrite +
    completion * pricing.output

  const savedCost = cached * Math.max(0, pricing.input - pricing.cacheRead)

  return { cost, known: true, source: pricing.source, pricing, savedCost }
}

/**
 * 兼容旧签名的成本计算。
 * @returns {number} 美元；模型价格未知时返回 0（用 computeUsageCost 区分）
 */
function calculateCost(model, inputTokens, outputTokens, opts = {}) {
  const result = computeUsageCost(model, {
    prompt_tokens: inputTokens || 0,
    completion_tokens: outputTokens || 0,
    cached_tokens: 0,
    cache_write_tokens: 0,
    cached_inclusive: true,
  }, opts)
  return result.cost
}

function isPricingKnown(model, opts = {}) {
  return resolvePricing(model, opts) !== null
}

module.exports = {
  calculateCost,
  computeUsageCost,
  isPricingKnown,
  MODEL_PRICING,
  normalizeModelId,
  resolvePricing,
  buildCatalog,
  perMillionToPerToken,
}
