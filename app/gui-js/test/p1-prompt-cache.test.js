const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const {
  estimatePrefixTokens, stabilityReport, injectAnthropicCacheControl, applyPromptCache,
  promptCacheMetrics, PromptCacheStats, MAX_ANTHROPIC_BREAKPOINTS,
} = require('../lib/proxy/prompt-cache')

// ---------------------------------------------------------------------------
// FIX-10 验收：Anthropic 缓存断点注入 + 前缀稳定性 + 缓存计量
//   官方口径：OpenAI 前缀缓存要求「Keep the prefix stable」，时间戳等动态内容
//   必须放到末尾；Anthropic 需要显式 cache_control 断点；最小可缓存前缀 1024 token。
// ---------------------------------------------------------------------------

const bigSystem = 'S'.repeat(8000) // ~2000 token，超过 1024 的最小前缀

function anthropicBody(extra = {}) {
  return {
    model: 'claude-3-5-sonnet',
    max_tokens: 1024,
    system: bigSystem,
    tools: [{ name: 'lookup', description: 'd', input_schema: { type: 'object' } }],
    messages: [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ],
    ...extra,
  }
}

describe('FIX-10 Anthropic cache_control 注入', () => {
  it('给 system / tools / 最后一条消息打上断点', () => {
    const r = injectAnthropicCacheControl(anthropicBody(), { minPrefixTokens: 1024 })
    assert.ok(r.injected >= 2)
    assert.equal(r.body.system[0].cache_control.type, 'ephemeral')
    assert.equal(r.body.tools[0].cache_control.type, 'ephemeral')
    const last = r.body.messages[r.body.messages.length - 1]
    assert.equal(last.content[0].cache_control.type, 'ephemeral')
    assert.ok(r.breakpoints.length <= MAX_ANTHROPIC_BREAKPOINTS)
  })

  it('不改动原始对象（不可变更新）', () => {
    const body = anthropicBody()
    injectAnthropicCacheControl(body, { minPrefixTokens: 1024 })
    assert.equal(typeof body.system, 'string')
    assert.equal(body.messages[2].content, 'second question')
  })

  it('前缀不足最小可缓存 token 时不注入（避免无意义断点）', () => {
    const small = { model: 'x', system: 'hi', messages: [{ role: 'user', content: 'hi' }] }
    const r = injectAnthropicCacheControl(small, { minPrefixTokens: 1024 })
    assert.equal(r.injected, 0)
    assert.match(r.skipped, /prefix_below_minimum/)
  })

  it('客户端已显式打过 cache_control 时不覆盖', () => {
    const body = anthropicBody()
    body.system = [{ type: 'text', text: bigSystem, cache_control: { type: 'ephemeral' } }]
    const r = injectAnthropicCacheControl(body, { minPrefixTokens: 1024 })
    assert.equal(r.skipped, 'client_already_set')
    assert.equal(r.injected, 0)
  })

  it('overrideClient 时允许覆盖客户端的断点', () => {
    const body = anthropicBody()
    body.system = [{ type: 'text', text: bigSystem, cache_control: { type: 'ephemeral' } }]
    const r = injectAnthropicCacheControl(body, { minPrefixTokens: 1024, overrideClient: true })
    assert.ok(r.injected > 0)
  })

  it('system 数组形态只在最后一个块打断点', () => {
    const body = anthropicBody({ system: [{ type: 'text', text: bigSystem }, { type: 'text', text: 'more' }] })
    const r = injectAnthropicCacheControl(body, { minPrefixTokens: 1024 })
    assert.equal(r.body.system[0].cache_control, undefined)
    assert.equal(r.body.system[1].cache_control.type, 'ephemeral')
  })

  it('最多 4 个断点', () => {
    const body = {
      model: 'x', system: bigSystem,
      tools: [{ name: 'a' }, { name: 'b' }],
      messages: Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(2000) })),
    }
    const r = injectAnthropicCacheControl(body, { minPrefixTokens: 1024 })
    assert.ok(r.injected <= MAX_ANTHROPIC_BREAKPOINTS)
  })
})

describe('FIX-10 前缀稳定性检查', () => {
  it('system 里的 ISO 时间戳会被检出（毁掉前缀缓存）', () => {
    const rep = stabilityReport({ system: '# Generated: 2026-09-28T04:00:00Z\nbody', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(rep.stable, false)
    assert.ok(rep.volatile.some(v => v.kind === 'iso_timestamp'))
  })

  it('时间戳出现在最后一条消息里不算问题（它本就在前缀之外）', () => {
    const rep = stabilityReport({
      system: 'stable prefix',
      messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'now 2026-09-28T04:00:00Z' }],
    })
    assert.equal(rep.stable, true)
  })

  it('UUID / request_id / nonce 也会被检出', () => {
    const rep = stabilityReport({
      system: 'id 8f14e45f-ceea-467a-9e1a-1b2c3d4e5f60 request_id: abc nonce=1',
      messages: [{ role: 'user', content: 'x' }],
    })
    const kinds = rep.volatile.map(v => v.kind)
    assert.ok(kinds.includes('uuid'))
    assert.ok(kinds.includes('request_id'))
    assert.ok(kinds.includes('nonce'))
  })

  it('干净前缀报告 stable', () => {
    assert.equal(stabilityReport({ system: 'pure text', messages: [{ role: 'user', content: 'x' }] }).stable, true)
  })
})

describe('FIX-10 applyPromptCache 分派与计量', () => {
  it('Anthropic 形态注入断点并记录策略', () => {
    const { meta } = applyPromptCache(anthropicBody(), { format: 'anthropic' }, {})
    assert.equal(meta.strategy, 'anthropic_cache_control')
    assert.equal(meta.applied, true)
    assert.ok(meta.breakpoints.length > 0)
  })

  it('Anthropic 原生路径即使 provider 写着 openai 也按 Anthropic 处理', () => {
    const { meta } = applyPromptCache(anthropicBody(), { format: 'anthropic' }, { anthropic_cache_control: true })
    assert.equal(meta.strategy, 'anthropic_cache_control')
  })

  it('OpenAI 形态不注入，只报告前缀是否稳定', () => {
    const stable = applyPromptCache({ model: 'gpt-4o', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] }, { format: 'openai' }, {})
    assert.equal(stable.meta.strategy, 'openai_prefix')
    assert.equal(stable.meta.applied, true)
    const volatile = applyPromptCache({ model: 'gpt-4o', messages: [{ role: 'system', content: 'Generated at 2026-09-28T04:00:00Z' }, { role: 'user', content: 'u' }] }, { format: 'openai' }, {})
    assert.equal(volatile.meta.applied, false)
    assert.equal(volatile.meta.reason, 'volatile_prefix')
  })

  it('enabled:false 时直接跳过', () => {
    const { meta } = applyPromptCache(anthropicBody(), { format: 'anthropic' }, { enabled: false })
    assert.equal(meta.reason, 'disabled')
  })

  it('缓存计量：读命中省下 (input - cacheRead) * cached_tokens', () => {
    const m = promptCacheMetrics({ cached_tokens: 1000, cache_write_tokens: 0 }, { input: 3e-6, cacheRead: 3e-7, cacheWrite: 3.75e-6 })
    assert.equal(m.cacheReadTokens, 1000)
    assert.equal(m.cacheHit, true)
    assert.ok(Math.abs(m.savedUSD - 1000 * (3e-6 - 3e-7)) < 1e-12)
  })

  it('缓存写入的溢价单独计量', () => {
    const m = promptCacheMetrics({ cached_tokens: 0, cache_write_tokens: 500 }, { input: 3e-6, cacheRead: 3e-7, cacheWrite: 3.75e-6 })
    assert.ok(Math.abs(m.writePremiumUSD - 500 * (3.75e-6 - 3e-6)) < 1e-12)
    assert.equal(m.cacheHit, false)
  })

  it('PromptCacheStats 汇总命中率与节省', () => {
    const s = new PromptCacheStats()
    s.record(promptCacheMetrics({ cached_tokens: 100, cache_write_tokens: 0 }, { input: 1e-5, cacheRead: 1e-6 }), { prefixStable: true })
    s.record(promptCacheMetrics({ cached_tokens: 0, cache_write_tokens: 0 }, { input: 1e-5, cacheRead: 1e-6 }), { prefixStable: false })
    const sum = s.summary()
    assert.equal(sum.requests, 2)
    assert.equal(sum.requestsWithCacheRead, 1)
    assert.equal(sum.hitRate, 0.5)
    assert.equal(sum.prefixStableRate, 0.5)
    assert.equal(sum.cacheReadTokens, 100)
  })

  it('estimatePrefixTokens 随前缀长度增长', () => {
    assert.ok(estimatePrefixTokens({ system: bigSystem, messages: [] }) > estimatePrefixTokens({ system: 'x', messages: [] }))
  })
})
