const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { LRUCache, calculateCost, MODEL_PRICING } = require('../lib/monitor')

describe('LRUCache', () => {
  it('should set and get values', () => {
    const cache = new LRUCache(5)
    cache.set('a', { x: 1 })
    cache.set('b', { x: 2 })
    assert.deepEqual(cache.get('a'), { x: 1 })
    assert.deepEqual(cache.get('b'), { x: 2 })
  })

  it('should return null for missing keys', () => {
    const cache = new LRUCache(5)
    assert.equal(cache.get('missing'), null)
  })

  it('should evict oldest entry when full', () => {
    const cache = new LRUCache(3)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    assert.equal(cache.size, 3)
    cache.set('d', 4)
    assert.equal(cache.size, 3)
    assert.equal(cache.get('a'), null)
    assert.equal(cache.get('d'), 4)
  })

  it('should promote accessed entries (LRU)', () => {
    const cache = new LRUCache(3)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    cache.get('a')
    cache.set('d', 4)
    assert.equal(cache.get('a'), 1)
    assert.equal(cache.get('b'), null)
  })

  it('should clear all entries', () => {
    const cache = new LRUCache(5)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.clear()
    assert.equal(cache.size, 0)
    assert.equal(cache.get('a'), null)
  })
})

describe('calculateCost', () => {
  it('should calculate gpt-4o cost correctly', () => {
    const cost = calculateCost('gpt-4o', 1000, 500)
    const expected = 1000 * MODEL_PRICING['gpt-4o'].input + 500 * MODEL_PRICING['gpt-4o'].output
    assert.ok(Math.abs(cost - expected) < 1e-10)
  })

  it('should calculate deepseek-chat cost correctly', () => {
    const cost = calculateCost('deepseek-chat', 1000, 500)
    const expected = 1000 * MODEL_PRICING['deepseek-chat'].input + 500 * MODEL_PRICING['deepseek-chat'].output
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

  it('should return 0 when tokens are zero', () => {
    assert.equal(calculateCost('gpt-4o', 0, 0), 0)
  })
})
