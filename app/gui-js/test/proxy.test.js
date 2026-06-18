const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { CacheManager } = require('../lib/proxy/cache-manager')
const { parseSSEChunks, serializeSSEEvents } = require('../lib/proxy/stream-handler')
const { isPlaceholderKey, resolveApiKey, joinUrl } = require('../lib/proxy/forwarder')
const { ProviderRegistry } = require('../lib/proxy/provider-registry')

describe('CacheManager', () => {
  it('should create cache manager', () => {
    const cm = new CacheManager()
    assert.ok(cm.cache)
    assert.equal(typeof cm.get, 'function')
    assert.equal(typeof cm.set, 'function')
  })

  it('should respect cache size limits', () => {
    const cm = new CacheManager({ maxEntries: 3, maxMemoryMB: 1 })
    cm.set('a', { d: '1' }); cm.set('b', { d: '2' }); cm.set('c', { d: '3' }); cm.set('d', { d: '4' })
    assert.equal(cm.size, 3)
    assert.ok(!cm.has('a'))
    assert.ok(cm.has('d'))
  })
})

describe('SSE parsing', () => {
  it('should parse SSE chunks into structured events', () => {
    const raw = [Buffer.from('data: {"id":"1","choices":[{"delta":{"content":"Hi"}}]}\n\n'), Buffer.from('data: [DONE]\n\n')]
    const events = parseSSEChunks(raw)
    assert.equal(events.length, 2)
    assert.ok(events[0].data.includes('Hi'))
    assert.equal(events[1].data, '[DONE]')
  })

  it('should serialize SSE events back to valid format', () => {
    const events = [{ event: '', data: '{"choices":[]}', id: '', retry: '' }, { event: '', data: '[DONE]', id: '', retry: '' }]
    const s = serializeSSEEvents(events)
    assert.ok(s.startsWith('data: '))
    assert.ok(s.includes('data: [DONE]'))
  })

  it('should round-trip parse and serialize', () => {
    const raw = [Buffer.from('data: hello\n\n'), Buffer.from('data: [DONE]\n\n')]
    const events = parseSSEChunks(raw)
    const serialized = serializeSSEEvents(events)
    const reParsed = parseSSEChunks([Buffer.from(serialized)])
    assert.equal(reParsed.length, events.length)
  })

  // 回归：Bug#6 — CRLF 行尾应正确分隔事件
  it('should parse CRLF line endings correctly', () => {
    const raw = [Buffer.from('data: {"a":1}\r\n\r\ndata: [DONE]\r\n\r\n')]
    const events = parseSSEChunks(raw)
    assert.equal(events.length, 2)
    assert.equal(events[0].data, '{"a":1}')
    assert.equal(events[1].data, '[DONE]')
  })

  it('should parse mixed CRLF and LF without merging events', () => {
    const raw = [Buffer.from('data: a\r\n\r\n'), Buffer.from('data: b\n\n')]
    const events = parseSSEChunks(raw)
    assert.equal(events.length, 2)
    assert.equal(events[0].data, 'a')
    assert.equal(events[1].data, 'b')
  })
})

describe('API Key resolution', () => {
  it('should detect placeholder keys', () => {
    assert.ok(isPlaceholderKey('sk-xxx'))
    assert.ok(isPlaceholderKey('your-api-key'))
    assert.ok(isPlaceholderKey(''))
    assert.ok(!isPlaceholderKey('sk-real-key-12345'))
  })

  it('should prefer proxy key when set', () => {
    const r = resolveApiKey({ api_key: 'sk-real-key' }, 'Bearer sk-client-key')
    assert.equal(r.key, 'sk-real-key')
    assert.equal(r.source, 'proxy')
  })

  it('should fall back to client key when proxy is placeholder and passthrough_auth is enabled', () => {
    const r = resolveApiKey({ api_key: 'sk-xxx', passthrough_auth: true }, 'Bearer sk-client-key')
    assert.equal(r.key, 'sk-client-key')
    assert.equal(r.source, 'client')
  })

  it('should not use client key when passthrough_auth is disabled', () => {
    const r = resolveApiKey({ api_key: 'sk-xxx', passthrough_auth: false }, 'Bearer sk-client-key')
    assert.ok(r.error)
    assert.equal(r.key, '')
  })

  it('should return error when no valid key', () => {
    const r = resolveApiKey({ api_key: 'sk-xxx' }, 'Bearer sk-xxx')
    assert.ok(r.error)
  })
})

// 回归：Bug#9 — URL 拼接不应产生双斜杠或缺失斜杠
describe('joinUrl', () => {
  it('should join base without trailing slash and path with leading slash', () => {
    assert.equal(joinUrl('https://api.openai.com/v1', '/chat/completions'), 'https://api.openai.com/v1/chat/completions')
  })

  it('should not produce double slash when base has trailing slash', () => {
    assert.equal(joinUrl('https://api.openai.com/v1/', '/chat/completions'), 'https://api.openai.com/v1/chat/completions')
  })

  it('should handle path without leading slash', () => {
    assert.equal(joinUrl('https://api.openai.com/v1', 'chat/completions'), 'https://api.openai.com/v1/chat/completions')
  })

  it('should handle multiple trailing/leading slashes', () => {
    assert.equal(joinUrl('https://x.com/v1///', '///chat'), 'https://x.com/v1/chat')
  })

  it('should return base alone when path is empty', () => {
    assert.equal(joinUrl('https://x.com/v1/', ''), 'https://x.com/v1')
  })
})

describe('ProviderRegistry', () => {
  it('should detect providers from path', () => {
    const reg = new ProviderRegistry()
    assert.equal(reg.detectProviderFromPath('/chat/zhipu', { getDefaultProvider: () => 'openai', getAllProviders: () => ({}) }), 'zhipu')
    assert.equal(reg.detectProviderFromPath('/deepseek/chat', { getDefaultProvider: () => 'openai', getAllProviders: () => ({}) }), 'deepseek')
    assert.equal(reg.detectProviderFromPath('/gemini/chat', { getDefaultProvider: () => 'openai', getAllProviders: () => ({}) }), 'google')
  })

  it('should resolve provider with format', () => {
    const reg = new ProviderRegistry()
    const p = reg.resolveProvider('openai', { api_key: 'test' })
    assert.equal(p.format, 'openai')
    assert.equal(p.name, 'OpenAI')
  })

  it('should resolve google as gemini format', () => {
    const reg = new ProviderRegistry()
    const p = reg.resolveProvider('google', {})
    assert.equal(p.format, 'gemini')
  })

  it('should list available providers', () => {
    const reg = new ProviderRegistry()
    const providers = reg.getAvailableProviders()
    assert.ok(providers.length > 0)
    assert.ok(providers.some(p => p.id === 'openai'))
    assert.ok(providers.some(p => p.id === 'google'))
  })
})
