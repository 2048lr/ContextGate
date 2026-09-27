const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const yaml = require('js-yaml')

const { ProxyServer } = require('../lib/proxy/proxy-server')
const { EventBus } = require('../lib/core/event-bus')
const { TokenMonitor } = require('../lib/monitor/token-monitor')
const { BudgetGuard } = require('../lib/monitor/budget')
const { ConfigManager } = require('../lib/core/config-manager')
const { LOOPBACK_HOSTNAMES, parseHostHeader, isAllowedOrigin, timingSafeEqualStr } = require('../lib/proxy/auth')

// ---------------------------------------------------------------------------
// P0 验收（见 docs/contextgate-competitive-gap-and-fix-plan.md 第 8 章）
//   P0-1 大 body 透传（1KB/300KB/8MB/超限）
//   P0-2 匿名 / 错误 token / Host 头 / Origin 头访问矩阵
//   P0-5 流式请求最终 usage 非 0 且成本 > 0
//   P0-6 相同 messages + 不同 tools/n 不共享缓存
// ---------------------------------------------------------------------------

function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-p0-'))
  // 预置 models.dev 磁盘缓存，避免测试触网
  fs.writeFileSync(path.join(dir, 'models-dev-cache.json'), '{}', 'utf8')
  return dir
}

function writeConfig(dataDir, overrides = {}) {
  const cfgPath = path.join(dataDir, 'config.yaml')
  const base = {
    providers: { openai: { api_key: 'sk-unit-test-key-0123456789', base_url: '' } },
    default_provider: 'openai',
    proxy: { host: '127.0.0.1', port: 0 },
    monitor: { budget_limit: 10 },
    ...overrides,
  }
  fs.writeFileSync(cfgPath, yaml.dump(base), 'utf8')
  return cfgPath
}

function startFakeUpstream(handler) {
  const hits = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw) } catch { /* 允许非 JSON */ }
      hits.push({ url: req.url, body })
      server.lastAuth = req.headers.authorization
      handler(req, res, body, hits.length)
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, port: server.address().port }))
  })
}

function jsonUpstream() {
  return startFakeUpstream((req, res, _body, n) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: 'chatcmpl-' + n,
      choices: [{ message: { role: 'assistant', content: 'ANSWER_' + n } }],
      usage: { prompt_tokens: 1200, completion_tokens: 34, total_tokens: 1234 },
    }))
  })
}

function sseUpstream() {
  return startFakeUpstream((req, res, body) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (body.stream_options && body.stream_options.include_usage) {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n\n')
      res.write('data: ' + JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 2000, completion_tokens: 40, total_tokens: 2040, prompt_tokens_details: { cached_tokens: 1500 } },
      }) + '\n\n')
    } else {
      // 模拟不支持 stream_options 的上游：只有 delta，没有 usage
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n\n')
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
}

function request(base, method, urlPath, { body, headers = {}, raw } = {}) {
  return new Promise(resolve => {
    const payload = raw !== undefined ? raw : (body !== undefined ? Buffer.from(JSON.stringify(body)) : null)
    const h = { 'Content-Type': 'application/json', ...headers }
    if (payload) h['Content-Length'] = Buffer.byteLength(payload)
    const req = http.request(base + urlPath, { method, headers: h }, res => {
      let out = ''
      res.on('data', c => { out += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: out }))
    })
    req.on('error', e => resolve({ status: 0, headers: {}, text: String(e) }))
    if (payload) req.write(payload)
    req.end()
  })
}

async function bootProxy({ overrides = {}, upstreamPort, withMonitor = false, providerPatch = null } = {}) {
  const dataDir = makeDataDir()
  const cfgPath = writeConfig(dataDir, overrides)
  if (upstreamPort || providerPatch) {
    const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8'))
    if (upstreamPort) cfg.providers.openai.base_url = 'http://127.0.0.1:' + upstreamPort + '/v1'
    if (providerPatch) cfg.providers.openai = { ...cfg.providers.openai, ...providerPatch }
    fs.writeFileSync(cfgPath, yaml.dump(cfg), 'utf8')
  }
  const eventBus = new EventBus()
  const completed = []
  const logs = []
  let monitor = null
  let guard = null
  if (withMonitor) {
    monitor = new TokenMonitor({ dbPath: path.join(dataDir, 'db.sqlite') })
    await monitor._ensureReady()
    guard = new BudgetGuard({ configManager: new ConfigManager(cfgPath), getSpent: () => monitor.getTodayCostSync() })
  }
  eventBus.on('request:complete', d => { completed.push(d); if (monitor) monitor.recordRequest(d).catch(() => {}) })
  eventBus.on('request:log', d => logs.push(d))
  const proxy = new ProxyServer({ configPath: cfgPath, dataDir, eventBus, budgetGuard: guard })
  const started = await proxy.start('127.0.0.1', 0)
  return {
    proxy, dataDir, cfgPath, eventBus, completed, logs, monitor, guard,
    base: 'http://127.0.0.1:' + started.port,
    token: started.token,
    auth: { 'X-ContextGate-Token': started.token },
    async close() { await proxy.stop(); if (monitor) monitor.close() },
  }
}

describe('P0-2 本地鉴权与来源校验（纯函数）', () => {
  it('parseHostHeader 去端口并保留 IPv6 方括号', () => {
    assert.equal(parseHostHeader('127.0.0.1:12306'), '127.0.0.1')
    assert.equal(parseHostHeader('LOCALHOST'), 'localhost')
    assert.equal(parseHostHeader('[::1]:12306'), '[::1]')
    assert.equal(parseHostHeader(''), null)
    assert.equal(parseHostHeader(undefined), null)
  })

  it('回环主机名白名单覆盖 127.0.0.1 / localhost / ::1', () => {
    assert.ok(LOOPBACK_HOSTNAMES.has('127.0.0.1'))
    assert.ok(LOOPBACK_HOSTNAMES.has('localhost'))
    assert.ok(LOOPBACK_HOSTNAMES.has('[::1]'))
  })

  it('Origin 校验只放行 file://、null 与回环源', () => {
    assert.ok(isAllowedOrigin('null'))
    assert.ok(isAllowedOrigin('file://'))
    assert.ok(isAllowedOrigin('http://127.0.0.1:12306'))
    assert.ok(isAllowedOrigin('http://localhost:3000'))
    assert.ok(!isAllowedOrigin('http://evil.com'))
    assert.ok(!isAllowedOrigin('https://attacker.example'))
    assert.ok(!isAllowedOrigin('http://127.0.0.1.evil.com'))
  })

  it('令牌比较是定长的 timing-safe 比较', () => {
    assert.ok(timingSafeEqualStr('abc', 'abc'))
    assert.ok(!timingSafeEqualStr('abc', 'abd'))
    assert.ok(!timingSafeEqualStr('abc', 'abcd'))
    assert.ok(!timingSafeEqualStr(null, 'abc'))
  })
})

describe('P0-2 本地鉴权与来源校验（HTTP 集成）', () => {
  let ctx
  before(async () => { ctx = await bootProxy() })
  after(async () => { await ctx.close() })

  it('匿名访问受保护端点 -> 401', async () => {
    for (const p of ['/stats', '/context/hash', '/providers']) {
      const r = await request(ctx.base, 'GET', p)
      assert.equal(r.status, 401, p + ' 应返回 401')
      assert.match(r.headers['content-type'] || '', /application\/json/)
    }
    assert.equal((await request(ctx.base, 'DELETE', '/cache')).status, 401)
  })

  it('错误令牌 -> 401，正确令牌 -> 200', async () => {
    assert.equal((await request(ctx.base, 'GET', '/stats', { headers: { Authorization: 'Bearer wrong-token-000000' } })).status, 401)
    assert.equal((await request(ctx.base, 'GET', '/stats', { headers: { 'X-ContextGate-Token': 'wrong-token-000000' } })).status, 401)
    assert.equal((await request(ctx.base, 'GET', '/stats', { headers: ctx.auth })).status, 200)
  })

  it('Authorization 里携带本地令牌同样有效', async () => {
    const r = await request(ctx.base, 'GET', '/stats', { headers: { Authorization: 'Bearer ' + ctx.token } })
    assert.equal(r.status, 200)
  })

  it('Host 头非回环 -> 403（DNS rebinding 缓解）', async () => {
    const r = await request(ctx.base, 'GET', '/stats', { headers: { ...ctx.auth, Host: 'evil.com' } })
    assert.equal(r.status, 403)
    const r2 = await request(ctx.base, 'GET', '/stats', { headers: { ...ctx.auth, Host: 'attacker.example:12306' } })
    assert.equal(r2.status, 403)
  })

  it('跨站 Origin -> 403', async () => {
    const r = await request(ctx.base, 'GET', '/stats', { headers: { ...ctx.auth, Origin: 'http://evil.com' } })
    assert.equal(r.status, 403)
  })

  it('/health 豁免令牌', async () => {
    assert.equal((await request(ctx.base, 'GET', '/health')).status, 200)
  })

  it('auth.enabled=false 时恢复匿名可用（兼容开关）', async () => {
    const open = await bootProxy({ overrides: { proxy: { host: '127.0.0.1', port: 0, auth: { enabled: false } } } })
    try {
      assert.equal((await request(open.base, 'GET', '/stats')).status, 200)
    } finally { await open.close() }
  })
})

describe('P0-2 非回环绑定会给出强告警（proxy.host 不再是死旋钮）', () => {
  it('绑定 0.0.0.0 时返回局域网暴露与 Host 校验告警', async () => {
    const dataDir = makeDataDir()
    const cfgPath = writeConfig(dataDir, { proxy: { host: '0.0.0.0', port: 0 } })
    const proxy = new ProxyServer({ configPath: cfgPath, dataDir })
    const started = await proxy.start('0.0.0.0', 0)
    try {
      assert.equal(started.warnings.length >= 2, true)
      assert.ok(started.warnings.some(w => w.includes('局域网')))
      assert.ok(started.warnings.some(w => w.includes('allowed_hosts')))
    } finally {
      await proxy.stop()
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('auth.enabled=false 时额外告警', async () => {
    const dataDir = makeDataDir()
    const cfgPath = writeConfig(dataDir, { proxy: { host: '127.0.0.1', port: 0, auth: { enabled: false } } })
    const proxy = new ProxyServer({ configPath: cfgPath, dataDir })
    const started = await proxy.start('127.0.0.1', 0)
    try {
      assert.ok(started.warnings.some(w => w.includes('鉴权已被关闭')))
    } finally {
      await proxy.stop()
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('P0-2 本地令牌不会被当成上游 Key 转发', () => {
  let upstream, ctx
  before(async () => {
    upstream = await jsonUpstream()
    // 占位符 Key + passthrough_auth：客户端 Key 本应被透传，但本地令牌不算客户端 Key
    ctx = await bootProxy({
      upstreamPort: upstream.port,
      providerPatch: { api_key: 'sk-xxx', passthrough_auth: true },
    })
  })
  after(async () => { await ctx.close(); upstream.server.close() })

  it('以本地令牌作为 Authorization 时不会把它送给上游，而是返回 401', async () => {
    upstream.hits.length = 0
    const r = await request(ctx.base, 'POST', '/v1/chat/completions', {
      body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'leak?' }] },
      headers: { Authorization: 'Bearer ' + ctx.token },
    })
    assert.equal(r.status, 401)
    assert.equal(upstream.hits.length, 0, '不应向上游发起请求')
  })

  it('用 X-ContextGate-Token 鉴权时，Authorization 里的真实上游 Key 会被透传', async () => {
    upstream.hits.length = 0
    const r = await request(ctx.base, 'POST', '/v1/chat/completions', {
      body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'ok' }] },
      headers: { ...ctx.auth, Authorization: 'Bearer sk-real-upstream-key-123456' },
    })
    assert.equal(r.status, 200)
    assert.equal(upstream.hits.length, 1)
    assert.equal(upstream.server.lastAuth, 'Bearer sk-real-upstream-key-123456')
  })
})

describe('P0-1 请求体上限与结构化错误', () => {
  let upstream, ctx
  before(async () => {
    upstream = await jsonUpstream()
    ctx = await bootProxy({ upstreamPort: upstream.port })
  })
  after(async () => { await ctx.close(); upstream.server.close() })

  const bodyOf = size => ({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'a'.repeat(size) }] })

  it('1KB 请求可透传到上游', async () => {
    const r = await request(ctx.base, 'POST', '/v1/chat/completions', { body: bodyOf(1024), headers: ctx.auth })
    assert.equal(r.status, 200)
    assert.match(r.text, /ANSWER_/)
  })

  it('300KB 请求不再 413（原缺陷：Express 默认 100KB 上限）', async () => {
    const r = await request(ctx.base, 'POST', '/v1/chat/completions', { body: bodyOf(300 * 1024), headers: ctx.auth })
    assert.equal(r.status, 200)
  })

  it('8MB 请求在 32MB 限额内同样不 413', async () => {
    const r = await request(ctx.base, 'POST', '/v1/chat/completions', { body: bodyOf(8 * 1024 * 1024), headers: ctx.auth })
    assert.equal(r.status, 200)
  })

  it('超限请求返回可被 SDK 解析的 JSON 413', async () => {
    const r = await request(ctx.base, 'POST', '/v1/chat/completions', { body: bodyOf(33 * 1024 * 1024), headers: ctx.auth })
    assert.equal(r.status, 413)
    assert.match(r.headers['content-type'] || '', /application\/json/)
    const parsed = JSON.parse(r.text)
    assert.equal(parsed.error.type, 'invalid_request_error')
    assert.equal(parsed.error.code, 'request_too_large')
  })

  it('max_body_size 可配置', async () => {
    const custom = await bootProxy({ upstreamPort: upstream.port, overrides: { proxy: { host: '127.0.0.1', port: 0, max_body_size: '256kb' } } })
    try {
      assert.equal((await request(custom.base, 'POST', '/v1/chat/completions', { body: bodyOf(1024), headers: custom.auth })).status, 200)
      const big = await request(custom.base, 'POST', '/v1/chat/completions', { body: bodyOf(512 * 1024), headers: custom.auth })
      assert.equal(big.status, 413)
      assert.equal(JSON.parse(big.text).error.code, 'request_too_large')
    } finally { await custom.close() }
  })

  it('非法 JSON -> 400 JSON', async () => {
    const r = await request(ctx.base, 'POST', '/v1/chat/completions', { raw: '{not json', headers: ctx.auth })
    assert.equal(r.status, 400)
    assert.equal(JSON.parse(r.text).error.code, 'invalid_json')
  })

  it('未知端点 -> 404 JSON，而不是 HTML', async () => {
    const r = await request(ctx.base, 'GET', '/definitely/not/here', { headers: ctx.auth })
    assert.equal(r.status, 404)
    assert.match(r.headers['content-type'] || '', /application\/json/)
    assert.equal(JSON.parse(r.text).error.code, 'unknown_endpoint')
  })
})

describe('P0-6 缓存 key 覆盖全部影响输出的参数', () => {
  let upstream, ctx
  before(async () => {
    upstream = await jsonUpstream()
    ctx = await bootProxy({ upstreamPort: upstream.port })
  })
  after(async () => { await ctx.close(); upstream.server.close() })

  const msg = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'SAME' }] }
  const send = extra => request(ctx.base, 'POST', '/v1/chat/completions', { body: { ...msg, ...extra }, headers: ctx.auth })

  it('完全相同的请求命中缓存（上游只调用一次）', async () => {
    ctx.proxy.cacheManager.clear()
    upstream.hits.length = 0
    const a = await send({})
    const b = await send({})
    assert.equal(a.headers['x-cache'], undefined)
    assert.equal(b.headers['x-cache'], 'HIT')
    assert.equal(upstream.hits.length, 1)
  })

  it('带 tools 的请求不会把答案缓存给不带 tools 的请求（原缺陷）', async () => {
    ctx.proxy.cacheManager.clear()
    upstream.hits.length = 0
    const withTools = await send({ tools: [{ type: 'function', function: { name: 'f' } }] })
    const without = await send({})
    assert.notEqual(withTools.text, undefined)
    assert.notEqual(without.headers['x-cache'], 'HIT')
    assert.equal(upstream.hits.length, 2)
  })

  for (const [name, a, b] of [
    ['n', { n: 1 }, { n: 2 }],
    ['seed', { seed: 1 }, { seed: 2 }],
    ['stop', { stop: ['x'] }, { stop: ['y'] }],
    ['response_format', { response_format: { type: 'json_object' } }, {}],
    ['parallel_tool_calls', { tools: [{ type: 'function', function: { name: 'f' } }], parallel_tool_calls: true }, { tools: [{ type: 'function', function: { name: 'f' } }], parallel_tool_calls: false }],
    ['未知自定义参数', { my_custom_option: 1 }, {}],
  ]) {
    it('不同 ' + name + ' 产生不同缓存 key', async () => {
      ctx.proxy.cacheManager.clear()
      upstream.hits.length = 0
      await send(a)
      await send(b)
      assert.equal(upstream.hits.length, 2, name + ' 不应共享缓存')
    })
  }
})

describe('P0-5 流式 usage 与成本', () => {
  let upstream, ctx
  before(async () => {
    upstream = await sseUpstream()
    ctx = await bootProxy({ upstreamPort: upstream.port, withMonitor: true })
  })
  after(async () => { await ctx.close(); upstream.server.close() })

  it('代理为流式请求注入 stream_options.include_usage', async () => {
    upstream.hits.length = 0
    const r = await request(ctx.base, 'POST', '/v1/chat/completions', {
      body: { model: 'gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'x' }] }, headers: ctx.auth,
    })
    assert.equal(r.status, 200)
    assert.deepEqual(upstream.hits[0].body.stream_options, { include_usage: true })
  })

  it('客户端显式设置的 stream_options 不会被覆盖', async () => {
    upstream.hits.length = 0
    await request(ctx.base, 'POST', '/v1/chat/completions', {
      body: { model: 'gpt-4o-mini', stream: true, stream_options: { include_usage: false }, messages: [{ role: 'user', content: 'y' }] }, headers: ctx.auth,
    })
    await new Promise(r => setTimeout(r, 150))
    assert.deepEqual(upstream.hits[0].body.stream_options, { include_usage: false })
  })

  it('流式请求记录非 0 token 与成本，并计入缓存读取折扣', async () => {
    ctx.completed.length = 0
    await request(ctx.base, 'POST', '/v1/chat/completions', {
      body: { model: 'claude-3-5-sonnet-20241022', stream: true, messages: [{ role: 'user', content: 'z' }] }, headers: ctx.auth,
    })
    await new Promise(r => setTimeout(r, 250))
    const rec = ctx.completed.find(c => c.model === 'claude-3-5-sonnet-20241022')
    assert.ok(rec, '应产生一条 request:complete')
    assert.equal(rec.input_tokens, 2000)
    assert.equal(rec.output_tokens, 40)
    assert.ok(rec.cost > 0, '成本应大于 0（claude-3-5-sonnet-20241022 现在能解析价格）')
    assert.equal(rec.pricing_known, true)
    assert.equal(rec.cached_tokens, 1500)
    assert.ok(rec.saved_cost > 0, '缓存读取应产生节省金额')
  })

  it('未知模型被标记为价格未知，而不是静默记 0', async () => {
    ctx.completed.length = 0
    await request(ctx.base, 'POST', '/v1/chat/completions', {
      body: { model: 'totally-unknown-model-xyz', messages: [{ role: 'user', content: 'q' }] }, headers: ctx.auth,
    })
    await new Promise(r => setTimeout(r, 100))
    const rec = ctx.completed.find(c => c.model === 'totally-unknown-model-xyz')
    assert.ok(rec)
    assert.equal(rec.pricing_known, false)
    assert.equal(rec.cost, 0)
  })
})

describe('FIX-04 预算阈值与硬拦截', () => {
  let upstream, ctx
  before(async () => {
    upstream = await jsonUpstream()
    ctx = await bootProxy({
      upstreamPort: upstream.port,
      withMonitor: true,
      // gpt-4o 一次请求约 $0.00334，limit 设为更小值以便一次就超限
      overrides: { monitor: { budget_limit: 0.001, warning_threshold: 5, critical_threshold: 10, enforce_budget: true } },
    })
  })
  after(async () => { await ctx.close(); upstream.server.close() })

  it('累计花费超过 budget_limit 后拒绝新请求（402）', async () => {
    const body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'a' }] }
    const first = await request(ctx.base, 'POST', '/v1/chat/completions', { body, headers: ctx.auth })
    assert.equal(first.status, 200)
    await new Promise(r => setTimeout(r, 150))
    assert.ok(ctx.monitor.getTodayCostSync() > 0, '今日花费应被累加')
    const second = await request(ctx.base, 'POST', '/v1/chat/completions', { body: { ...body, messages: [{ role: 'user', content: 'b' }] }, headers: ctx.auth })
    assert.equal(second.status, 402)
    const parsed = JSON.parse(second.text)
    assert.equal(parsed.error.code, 'budget_exceeded')
    assert.equal(parsed.error.type, 'insufficient_quota')
  })

  it('预算等级按 warning/critical 阈值升级', async () => {
    const state = ctx.guard.check()
    assert.equal(state.level, 'exceeded')
    assert.equal(state.allowed, false)
  })
})
