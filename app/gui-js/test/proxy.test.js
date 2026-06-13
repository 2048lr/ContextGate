const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { CacheManager } = require('../lib/proxy/cache-manager')
const { parseSSEChunks, serializeSSEEvents } = require('../lib/proxy/stream-handler')
const { isPlaceholderKey, resolveApiKey } = require('../lib/proxy/forwarder')
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

  it('should fall back to client key when proxy is placeholder', () => {
    const r = resolveApiKey({ api_key: 'sk-xxx' }, 'Bearer sk-client-key')
    assert.equal(r.key, 'sk-client-key')
    assert.equal(r.source, 'client')
  })

  it('should return error when no valid key', () => {
    const r = resolveApiKey({ api_key: 'sk-xxx' }, 'Bearer sk-xxx')
    assert.ok(r.error)
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
