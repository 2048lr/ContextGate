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
})
