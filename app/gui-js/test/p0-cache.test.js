const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { CacheManager } = require('../lib/proxy/cache-manager')

// ---------------------------------------------------------------------------
// FIX-06 验收：同 messages 不同 tools/n 必须产生不同缓存 key；
//         新增 TTL；命中率统计口径修正。
// ---------------------------------------------------------------------------

function keyOf(body, { method = 'POST', path = '/v1/chat/completions', ctx = 'ctxhash' } = {}) {
  const cm = new CacheManager()
  return cm.getCacheKey({ method, path, body }, ctx)
}

const base = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'SAME' }] }

describe('FIX-06 缓存 key 覆盖影响输出的参数', () => {
  it('同样的 body 得到同样的 key', () => {
    assert.equal(keyOf(base), keyOf({ ...base }))
  })

  it('键顺序不影响 key（规范化 JSON）', () => {
    assert.equal(keyOf({ ...base, temperature: 0.2 }), keyOf({ temperature: 0.2, ...base }))
  })

  it('不同 tools 得到不同 key（原缺陷：会返回错误答案）', () => {
    const withTools = keyOf({ ...base, tools: [{ type: 'function', function: { name: 'f' } }] })
    assert.notEqual(withTools, keyOf(base))
  })

  it('tools 内容不同得到不同 key', () => {
    const a = keyOf({ ...base, tools: [{ type: 'function', function: { name: 'a' } }] })
    const b = keyOf({ ...base, tools: [{ type: 'function', function: { name: 'b' } }] })
    assert.notEqual(a, b)
  })

  for (const [name, patch] of [
    ['n', { n: 2 }],
    ['seed', { seed: 42 }],
    ['tool_choice', { tools: [{ type: 'function', function: { name: 'f' } }], tool_choice: 'required' }],
    ['response_format', { response_format: { type: 'json_schema', json_schema: { name: 'x' } } }],
    ['parallel_tool_calls', { parallel_tool_calls: false }],
    ['stop', { stop: ['END'] }],
    ['logprobs', { logprobs: true, top_logprobs: 3 }],
    ['reasoning_effort', { reasoning_effort: 'high' }],
    ['temperature', { temperature: 0.9 }],
    ['stream', { stream: true }],
    ['model', { model: 'gpt-4o' }],
  ]) {
    it('不同 ' + name + ' 得到不同 key', () => {
      assert.notEqual(keyOf({ ...base, ...patch }), keyOf(base), name)
    })
  }

  it('未知自定义参数也会改变 key（避免新增参数再次漏掉）', () => {
    assert.notEqual(keyOf({ ...base, custom_future_option: true }), keyOf(base))
  })

  it('messages 内容不同得到不同 key', () => {
    assert.notEqual(keyOf({ ...base, messages: [{ role: 'user', content: 'OTHER' }] }), keyOf(base))
  })

  it('上下文 hash 与 provider 参与 key', () => {
    assert.notEqual(keyOf(base, { ctx: 'aaa' }), keyOf(base, { ctx: 'bbb' }))
    assert.notEqual(keyOf({ ...base, provider: 'openai' }), keyOf({ ...base, provider: 'deepseek' }))
  })

  it('路径与方法参与 key', () => {
    assert.notEqual(keyOf(base, { path: '/v1/completions' }), keyOf(base))
    assert.notEqual(keyOf(base, { method: 'GET' }), keyOf(base))
  })
})

describe('FIX-06 缓存 TTL 与命中率统计', () => {
  it('TTL 到期后条目失效', async () => {
    const cm = new CacheManager({ ttlSeconds: 0.05 })
    cm.set('k', { ok: true })
    assert.ok(cm.has('k'))
    await new Promise(r => setTimeout(r, 90))
    assert.equal(cm.has('k'), false)
    assert.equal(cm.get('k'), undefined)
  })

  it('ttlSeconds=0 表示不过期', async () => {
    const cm = new CacheManager({ ttlSeconds: 0 })
    cm.set('k', { ok: true })
    await new Promise(r => setTimeout(r, 30))
    assert.ok(cm.has('k'))
  })

  it('has() 不计入命中率，get() 才计数', () => {
    const cm = new CacheManager()
    cm.set('k', { ok: true })
    cm.has('k'); cm.has('k')
    assert.equal(cm.hits, 0)
    cm.get('k')
    assert.equal(cm.hits, 1)
    cm.get('missing')
    assert.equal(cm.misses, 1)
  })

  it('存入的是原始值（包装层不外泄给调用方）', () => {
    const cm = new CacheManager()
    const payload = { choices: [], usage: { prompt_tokens: 1 } }
    cm.set('k', payload)
    assert.deepEqual(cm.get('k'), payload)
    assert.equal(cm.get('k').__cgWrapped, undefined)
  })
})
