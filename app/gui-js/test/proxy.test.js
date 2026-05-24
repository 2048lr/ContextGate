const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const { AIProxy, ConfigManager } = require('../lib/proxy')

describe('AIProxy - LRUCache', () => {
  it('should create proxy with LRU cache', () => {
    const proxy = new AIProxy({ contextFile: '', configPath: '' })
    assert.ok(proxy.cache)
    assert.equal(typeof proxy.cache.get, 'function')
    assert.equal(typeof proxy.cache.set, 'function')
    assert.equal(typeof proxy.cache.has, 'function')
  })

  it('should respect cache size limits', () => {
    const proxy = new AIProxy({ contextFile: '', configPath: '', cacheMaxEntries: 3, cacheMaxMemoryMB: 1 })
    proxy.cache.set('a', { d: '1' })
    proxy.cache.set('b', { d: '2' })
    proxy.cache.set('c', { d: '3' })
    proxy.cache.set('d', { d: '4' })
    assert.equal(proxy.cache.size, 3)
    assert.ok(!proxy.cache.has('a'))
    assert.ok(proxy.cache.has('d'))
  })
})

describe('AIProxy - SSE parsing', () => {
  it('should parse SSE chunks into structured events', () => {
    const proxy = new AIProxy({ contextFile: '', configPath: '' })
    const rawChunks = [
      Buffer.from('data: {"id":"1","choices":[{"delta":{"content":"Hi"}}]}\n\n'),
      Buffer.from('data: {"id":"1","choices":[{"delta":{"content":" there"}}]}\n\n'),
      Buffer.from('data: [DONE]\n\n')
    ]
    const events = proxy._parseSSEChunks(rawChunks)
    assert.equal(events.length, 3)
    assert.ok(events[0].data.includes('Hi'))
    assert.equal(events[2].data, '[DONE]')
  })

  it('should serialize SSE events back to valid SSE format', () => {
    const proxy = new AIProxy({ contextFile: '', configPath: '' })
    const events = [
      { event: '', data: '{"choices":[]}', id: '', retry: '' },
      { event: '', data: '[DONE]', id: '', retry: '' }
    ]
    const serialized = proxy._serializeSSEEvents(events)
    assert.ok(serialized.startsWith('data: '))
    assert.ok(serialized.includes('data: [DONE]'))
    assert.ok(serialized.includes('\n\n'))
  })

  it('should handle SSE events with event field', () => {
    const proxy = new AIProxy({ contextFile: '', configPath: '' })
    const rawChunks = [
      Buffer.from('event: message\ndata: hello\n\n'),
      Buffer.from('event: error\ndata: timeout\nid: 42\n\n')
    ]
    const events = proxy._parseSSEChunks(rawChunks)
    assert.equal(events.length, 2)
    assert.equal(events[0].event, 'message')
    assert.equal(events[1].event, 'error')
    assert.equal(events[1].id, '42')
  })

  it('should round-trip SSE parse and serialize', () => {
    const proxy = new AIProxy({ contextFile: '', configPath: '' })
    const rawChunks = [
      Buffer.from('data: {"id":"1","choices":[{"delta":{"content":"A"}}]}\n\n'),
      Buffer.from('data: [DONE]\n\n')
    ]
    const events = proxy._parseSSEChunks(rawChunks)
    const serialized = proxy._serializeSSEEvents(events)
    const reParsed = proxy._parseSSEChunks([Buffer.from(serialized)])
    assert.equal(reParsed.length, events.length)
    assert.equal(reParsed[0].data, events[0].data)
    assert.equal(reParsed[1].data, events[1].data)
  })
})

describe('AIProxy - provider detection', () => {
  it('should detect zhipu from path', () => {
    const proxy = new AIProxy({ contextFile: '', configPath: '' })
    assert.equal(proxy._detectProvider('/chat/zhipu'), 'zhipu')
  })

  it('should detect deepseek from path', () => {
    const proxy = new AIProxy({ contextFile: '', configPath: '' })
    assert.equal(proxy._detectProvider('/deepseek/chat'), 'deepseek')
  })

  it('should default to openai for unknown paths', () => {
    const proxy = new AIProxy({ contextFile: '', configPath: '' })
    assert.equal(proxy._detectProvider('/chat/completions'), 'openai')
  })
})

describe('AIProxy - agent selection', () => {
  it('should use secure agent for HTTPS by default', () => {
    const proxy = new AIProxy({ contextFile: '', configPath: '' })
    const agent = proxy._getAgent({ base_url: 'https://api.openai.com' })
    assert.ok(agent)
  })

  it('should use insecure agent when tls.reject_unauthorized is false', () => {
    const proxy = new AIProxy({ contextFile: '', configPath: '' })
    const agent = proxy._getAgent({ base_url: 'https://self-signed.example.com', tls: { reject_unauthorized: false } })
    assert.ok(agent)
  })

  it('should use http agent for http URLs', () => {
    const proxy = new AIProxy({ contextFile: '', configPath: '' })
    const agent = proxy._getAgent({ base_url: 'http://localhost:8080' })
    assert.ok(agent)
  })
})
