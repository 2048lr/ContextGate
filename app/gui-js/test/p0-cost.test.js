const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const { normalizeUsage, extractUsageFromSSE, extractUsageFromResponse, shouldInjectStreamUsage, isStreamOptionsRejection, emptyUsage } = require('../lib/proxy/usage')
const { normalizeModelId, resolvePricing, buildCatalog } = require('../lib/monitor/pricing')
const { calculateCost, computeUsageCost, MODEL_PRICING } = require('../lib/monitor/cost-calculator')
const { evaluateBudget, BudgetGuard } = require('../lib/monitor/budget')

// ---------------------------------------------------------------------------
// FIX-04 单元验收
// ---------------------------------------------------------------------------

describe('FIX-04 usage 归一化', () => {
  it('兼容 OpenAI 形状（缓存计数包含在 prompt_tokens 内）', () => {
    const u = normalizeUsage({ prompt_tokens: 2000, completion_tokens: 40, total_tokens: 2040, prompt_tokens_details: { cached_tokens: 1500 } })
    assert.equal(u.prompt_tokens, 2000)
    assert.equal(u.cached_tokens, 1500)
    assert.equal(u.cached_inclusive, true)
    assert.equal(u.total_tokens, 2040)
  })

  it('兼容 Anthropic 形状（input_tokens 不含缓存读写）', () => {
    const u = normalizeUsage({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 })
    assert.equal(u.prompt_tokens, 100)
    assert.equal(u.cached_tokens, 900)
    assert.equal(u.cache_write_tokens, 50)
    assert.equal(u.cached_inclusive, false)
    assert.equal(u.total_tokens, 120)
  })

  it('空 usage 不产生 NaN', () => {
    assert.deepEqual(normalizeUsage(null), emptyUsage())
    assert.equal(normalizeUsage({ prompt_tokens: 'x' }).prompt_tokens, 0)
  })

  it('从全部 SSE chunk 中取最后一个 usage（不只看最后一行）', () => {
    const chunks = [
      Buffer.from('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'),
      Buffer.from('data: {"usage":{"prompt_tokens":11,"completion_tokens":2}}\n\n'),
      Buffer.from('data: {"choices":[{"delta":{}}]}\n\n'),
      Buffer.from('data: [DONE]\n\n'),
    ]
    const u = extractUsageFromSSE(chunks)
    assert.equal(u.prompt_tokens, 11)
    assert.equal(u.completion_tokens, 2)
  })

  it('无 usage 的流式响应被记为 0（调用方必须区分未知）', () => {
    const u = extractUsageFromSSE([Buffer.from('data: {"choices":[]}\n\ndata: [DONE]\n\n')])
    assert.equal(u.prompt_tokens, 0)
    assert.equal(u.raw, null)
  })

  it('非流式响应的 usage 可直接解析', () => {
    const u = extractUsageFromResponse({ usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })
    assert.equal(u.prompt_tokens, 7)
    assert.equal(u.total_tokens, 10)
  })
})

describe('FIX-04 stream_options 注入决策', () => {
  const openai = { id: 'openai', format: 'openai' }
  it('OpenAI 兼容且客户端未设置时注入', () => {
    assert.equal(shouldInjectStreamUsage(openai, { stream: true }), true)
  })
  it('非流式不注入', () => {
    assert.equal(shouldInjectStreamUsage(openai, { stream: false }), false)
  })
  it('客户端显式设置时不覆盖', () => {
    assert.equal(shouldInjectStreamUsage(openai, { stream: true, stream_options: { include_usage: false } }), false)
  })
  it('provider 关闭开关时不注入', () => {
    assert.equal(shouldInjectStreamUsage({ id: 'x', format: 'openai', supports_stream_usage: false }, { stream: true }), false)
  })
  it('Anthropic 不在注入范围内', () => {
    assert.equal(shouldInjectStreamUsage({ id: 'anthropic', format: 'openai' }, { stream: true }), false)
  })
  it('识别上游对 stream_options 的拒绝（用于降级重试）', () => {
    assert.equal(isStreamOptionsRejection({ response: { status: 400, data: { error: { message: 'Unknown parameter: stream_options' } } } }), true)
    assert.equal(isStreamOptionsRejection({ response: { status: 400, data: { error: { message: 'bad model' } } } }), false)
    assert.equal(isStreamOptionsRejection({ code: 'ECONNRESET' }), false)
  })
})

describe('FIX-04 价格目录', () => {
  it('带日期后缀的真实模型 ID 能解析价格', () => {
    const p = resolvePricing('claude-3-5-sonnet-20241022')
    assert.ok(p, '应能解析')
    assert.ok(Math.abs(p.input * 1e6 - 3) < 1e-9)
    assert.ok(Math.abs(p.output * 1e6 - 15) < 1e-9)
  })

  it('归一化去掉 provider 前缀、日期后缀与渠道后缀', () => {
    assert.equal(normalizeModelId('openai/gpt-4o'), 'gpt-4o')
    assert.equal(normalizeModelId('gpt-4o-mini-2024-07-18'), 'gpt-4o-mini')
    assert.equal(normalizeModelId('claude-3-5-sonnet:free'), 'claude-3-5-sonnet')
    assert.equal(normalizeModelId('CLAUDE-3-5-SONNET-LATEST'), 'claude-3-5-sonnet')
  })

  it('未知模型返回 null（调用方据此标记「价格未知」）', () => {
    assert.equal(resolvePricing('no-such-model-zzz'), null)
    assert.equal(resolvePricing(''), null)
    assert.equal(resolvePricing(null), null)
  })

  it('models.dev 目录优先于本地兜底表', () => {
    const catalog = buildCatalog({
      openai: { models: { 'gpt-4o': { cost: { input: 99, output: 199 } } } },
    })
    const p = resolvePricing('gpt-4o', { providerId: 'openai', catalog })
    assert.equal(p.source, 'models.dev')
    assert.ok(Math.abs(p.input * 1e6 - 99) < 1e-9)
  })

  it('本地表在目录缺失时兜底', () => {
    const p = resolvePricing('gpt-4o-mini', { modelsDevData: {} })
    assert.equal(p.source, 'local')
  })
})

describe('FIX-04 成本计算', () => {
  it('保持向后兼容：calculateCost(model, in, out)', () => {
    const cost = calculateCost('gpt-4o', 1000, 500)
    const expected = 1000 * MODEL_PRICING['gpt-4o'].input + 500 * MODEL_PRICING['gpt-4o'].output
    assert.ok(Math.abs(cost - expected) < 1e-12)
    assert.equal(calculateCost('unknown-model-zzz', 1000, 500), 0)
    assert.equal(calculateCost(null, 1000, 500), 0)
  })

  it('缓存读取按 0.1x 折扣计价并计入节省', () => {
    const r = computeUsageCost('gpt-4o', { prompt_tokens: 10000, completion_tokens: 0, cached_tokens: 9000, cached_inclusive: true })
    assert.ok(r.known)
    // 1000 未缓存输入 + 9000 缓存读取
    const expected = 1000 * (2.5 / 1e6) + 9000 * (0.25 / 1e6)
    assert.ok(Math.abs(r.cost - expected) < 1e-12, String(r.cost))
    assert.ok(Math.abs(r.savedCost - 9000 * (2.5 / 1e6 - 0.25 / 1e6)) < 1e-12)
  })

  it('Anthropic 形状的缓存计数不会被重复计入', () => {
    const r = computeUsageCost('claude-3-5-sonnet', { prompt_tokens: 100, completion_tokens: 10, cached_tokens: 900, cached_inclusive: false })
    const expected = 100 * (3 / 1e6) + 900 * (0.3 / 1e6) + 10 * (15 / 1e6)
    assert.ok(Math.abs(r.cost - expected) < 1e-12, String(r.cost))
  })

  it('价格未知时 known=false 且成本为 0', () => {
    const r = computeUsageCost('unknown-model-zzz', { prompt_tokens: 100, completion_tokens: 10 })
    assert.equal(r.known, false)
    assert.equal(r.cost, 0)
    assert.equal(r.source, null)
  })
})

describe('FIX-04 预算判定', () => {
  const cfg = { budget_limit: 10, warning_threshold: 75, critical_threshold: 90 }

  it('未达阈值时 level=ok 且允许', () => {
    const s = evaluateBudget(1, cfg)
    assert.equal(s.level, 'ok')
    assert.equal(s.allowed, true)
  })

  it('达到 warning_threshold 时告警但仍放行', () => {
    const s = evaluateBudget(8, cfg)
    assert.equal(s.level, 'warning')
    assert.equal(s.allowed, true)
  })

  it('达到 critical_threshold 时升级为 critical', () => {
    assert.equal(evaluateBudget(9, cfg).level, 'critical')
  })

  it('超过 budget_limit 记为 exceeded', () => {
    const s = evaluateBudget(11, cfg)
    assert.equal(s.level, 'exceeded')
    assert.ok(Math.abs(s.ratio - 1.1) < 1e-9)
  })

  it('enforce_budget=false 时即使超限也不拦截（升级后不静默断服）', () => {
    assert.equal(evaluateBudget(11, cfg).allowed, true)
    assert.equal(evaluateBudget(11, { ...cfg, enforce_budget: true }).allowed, false)
  })

  it('budget_limit<=0 表示不限制', () => {
    const s = evaluateBudget(999, { budget_limit: 0 })
    assert.equal(s.level, 'ok')
    assert.equal(s.allowed, true)
    assert.equal(s.limit, 0)
  })

  it('BudgetGuard 只在等级变化时回调', () => {
    let spent = 0
    const levels = []
    const guard = new BudgetGuard({
      configManager: { reload() {}, getMonitorConfig: () => ({ ...cfg, warning_threshold: 50, enforce_budget: false }) },
      getSpent: () => spent,
      onLevelChange: s => levels.push(s.level),
    })
    spent = 1; guard.notify()   // ok
    spent = 2; guard.notify()   // 仍是 ok，不重复通知
    spent = 6; guard.notify()   // warning
    spent = 6; guard.notify()   // 仍是 warning
    spent = 12; guard.notify()  // exceeded
    assert.deepEqual(levels, ['ok', 'warning', 'exceeded'])
  })
})
