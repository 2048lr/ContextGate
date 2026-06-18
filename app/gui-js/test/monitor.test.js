const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { LRUCache } = require('../lib/core/lru-cache')
const { calculateCost, MODEL_PRICING } = require('../lib/monitor/cost-calculator')

describe('LRUCache', () => {
  it('should set and get values', () => {
    const c = new LRUCache(5)
    c.set('a', { x: 1 }); c.set('b', { x: 2 })
    assert.deepEqual(c.get('a'), { x: 1 })
    assert.deepEqual(c.get('b'), { x: 2 })
  })

  it('should return undefined for missing keys', () => {
    assert.equal(new LRUCache(5).get('missing'), undefined)
  })

  it('should evict oldest entry when full', () => {
    const c = new LRUCache(3, 1)
    c.set('a', 1); c.set('b', 2); c.set('c', 3); c.set('d', 4)
    assert.equal(c.size, 3)
    assert.equal(c.get('a'), undefined)
    assert.equal(c.get('d'), 4)
  })

  it('should promote accessed entries (LRU)', () => {
    const c = new LRUCache(3, 1)
    c.set('a', 1); c.set('b', 2); c.set('c', 3)
    c.get('a')
    c.set('d', 4)
    assert.equal(c.get('a'), 1)
    assert.equal(c.get('b'), undefined)
  })

  it('should clear all entries', () => {
    const c = new LRUCache(5)
    c.set('a', 1); c.set('b', 2); c.clear()
    assert.equal(c.size, 0)
  })

  it('should has() return correct boolean', () => {
    const c = new LRUCache(5)
    c.set('a', 1)
    assert.equal(c.has('a'), true)
    assert.equal(c.has('b'), false)
  })
})

describe('calculateCost', () => {
  it('should calculate gpt-4o cost correctly', () => {
    const cost = calculateCost('gpt-4o', 1000, 500)
    const expected = 1000 * MODEL_PRICING['gpt-4o'].input + 500 * MODEL_PRICING['gpt-4o'].output
    assert.ok(Math.abs(cost - expected) < 1e-10)
  })

  it('should return 0 for unknown models', () => {
    assert.equal(calculateCost('unknown-model', 1000, 500), 0)
  })

  it('should return 0 for null model', () => {
    assert.equal(calculateCost(null, 1000, 500), 0)
  })

  it('should match model by prefix (case insensitive)', () => {
    const cost = calculateCost('GPT-4O-MINI-2024-07-18', 1000, 500)
    const expected = 1000 * MODEL_PRICING['gpt-4o-mini'].input + 500 * MODEL_PRICING['gpt-4o-mini'].output
    assert.ok(Math.abs(cost - expected) < 1e-10)
  })

  // 回归：Bug#1 — o1-mini 不应被 o1 前缀误匹配（精确匹配优先）
  it('should NOT match o1-mini as o1 (exact match wins over prefix)', () => {
    const cost = calculateCost('o1-mini', 1000, 500)
    const expected = 1000 * MODEL_PRICING['o1-mini'].input + 500 * MODEL_PRICING['o1-mini'].output
    assert.ok(Math.abs(cost - expected) < 1e-10, `o1-mini cost ${cost} should equal o1-mini price ${expected}`)
    // 确认没有被算成 o1 的价格
    const o1Cost = 1000 * MODEL_PRICING['o1'].input + 500 * MODEL_PRICING['o1'].output
    assert.ok(Math.abs(cost - o1Cost) > 1e-10, 'o1-mini must not be priced as o1')
  })

  // 回归：Bug#1 — o1-mini-2024 变体应走最长前缀匹配到 o1-mini 而非 o1
  it('should match o1-mini variants by longest prefix', () => {
    const cost = calculateCost('o1-mini-2024-09-12', 1000, 500)
    const expected = 1000 * MODEL_PRICING['o1-mini'].input + 500 * MODEL_PRICING['o1-mini'].output
    assert.ok(Math.abs(cost - expected) < 1e-10)
  })

  it('should still match exact o1 correctly', () => {
    const cost = calculateCost('o1', 1000, 500)
    const expected = 1000 * MODEL_PRICING['o1'].input + 500 * MODEL_PRICING['o1'].output
    assert.ok(Math.abs(cost - expected) < 1e-10)
  })
})
