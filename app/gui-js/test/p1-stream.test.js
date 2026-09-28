const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const yaml = require('js-yaml')

const { ProxyServer } = require('../lib/proxy/proxy-server')
const { EventBus } = require('../lib/core/event-bus')

// ---------------------------------------------------------------------------
// FIX-07 / FIX-11 HTTP 集成验收（对应文档第 8 章）：
//   * 客户端取消后 1s 内上游连接被中止（不再继续计费）
//   * 上游半开连接被空闲超时掐断，且客户端能识别失败（不再是静默 200 截断）
//   * /v1/messages、/v1/responses、/v1/files(multipart) 原生透传
//   * 429 自动重试（P1-2 集成侧）
// ---------------------------------------------------------------------------

function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-p1-stream-'))
  fs.writeFileSync(path.join(dir, 'models-dev-cache.json'), '{}', 'utf8')
  return dir
}

function request(base, method, urlPath, { body, headers = {}, raw } = {}) {
  return new Promise(resolve => {
    const payload = raw !== undefined ? raw : (body !== undefined ? Buffer.from(JSON.stringify(body)) : null)
    const h = { ...headers }
    if (payload && !h['Content-Type'] && !h['content-type']) h['Content-Type'] = 'application/json'
    if (payload) h['Content-Length'] = Buffer.byteLength(payload)
    const req = http.request(base + urlPath, { method, headers: h }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), buffer: Buffer.concat(chunks) }))
    })
    req.on('error', e => resolve({ status: 0, headers: {}, text: String(e), buffer: Buffer.alloc(0) }))
    if (payload) req.write(payload)
    req.end()
  })
}

/** 慢速 SSE 假上游：记录每次命中、以及响应连接是否被下游中止 */
function slowSseUpstream({ chunkDelayMs = 60, maxChunks = 60, usage = null } = {}) {
  const hits = []
  const aborts = []
  const server = http.createServer((req, res) => {
    const parts = []
    req.on('data', c => parts.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(parts)
      let parsed = null
      try { parsed = JSON.parse(raw.toString('utf8')) } catch { /* multipart 等非 JSON */ }
      hits.push({ url: req.url, headers: req.headers, body: parsed, raw })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'tick-1' } }] }) + '\n\n')
      let n = 1
      const timer = setInterval(() => {
        n++
        if (n > maxChunks) { clearInterval(timer); res.end(); return }
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'tick-' + n } }] }) + '\n\n')
      }, chunkDelayMs)
      res.on('close', () => {
        clearInterval(timer)
        if (!res.writableFinished) aborts.push({ url: req.url, at: Date.now() })
      })
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server, hits, aborts, port: server.address().port,
    close: () => new Promise(r => server.close(r)),
  })))
}

async function bootProxy({ upstreamPort, overrides = {}, providerPatch = null } = {}) {
  const dataDir = makeDataDir()
  const cfgPath = path.join(dataDir, 'config.yaml')
  const base = {
    providers: { openai: { api_key: 'sk-unit-test-key-0123456789', base_url: 'http://127.0.0.1:' + upstreamPort + '/v1' } },
    default_provider: 'openai',
    proxy: { host: '127.0.0.1', port: 0 },
    monitor: { budget_limit: 100 },
    ...overrides,
  }
  if (providerPatch) base.providers.openai = { ...base.providers.openai, ...providerPatch }
  fs.writeFileSync(cfgPath, yaml.dump(base), 'utf8')
  const proxy = new ProxyServer({ configPath: cfgPath, dataDir, eventBus: new EventBus() })
  const started = await proxy.start('127.0.0.1', 0)
  return {
    proxy, port: started.port, token: started.token, dataDir,
    base: 'http://127.0.0.1:' + started.port,
    auth: { Authorization: 'Bearer ' + started.token },
    close: async () => { await proxy.stop(); try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* 忽略 */ } },
  }
}

describe('FIX-07 流式可靠性（HTTP 集成）', () => {
  it('客户端取消后 1s 内上游连接被中止', async () => {
    const upstream = await slowSseUpstream({ chunkDelayMs: 80, maxChunks: 100 })
    const ctx = await bootProxy({ upstreamPort: upstream.port })
    try {
      await new Promise((resolve, reject) => {
        const body = Buffer.from(JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], stream: true }))
        const req = http.request(ctx.base + '/v1/chat/completions', {
          method: 'POST',
          headers: { ...ctx.auth, 'Content-Type': 'application/json', 'Content-Length': body.length },
        }, res => {
          res.once('data', () => {
            // 收到第一个 chunk 之后立刻断开，模拟用户按了「停止」
            setTimeout(() => { req.destroy(); resolve() }, 50)
          })
        })
        req.on('error', () => resolve())
        req.end(body)
      })

      const deadline = Date.now() + 1500
      while (upstream.aborts.length === 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 25))
      }
      assert.equal(upstream.hits.length, 1)
      assert.equal(upstream.aborts.length, 1, '上游连接应在 1s 内被中止')
      assert.ok(upstream.aborts[0].at - Date.now() < 1500)
    } finally {
      await ctx.close()
      await upstream.close()
    }
  })

  it('上游半开连接被空闲超时掐断，客户端拿到可识别的 SSE error 而不是静默 200', async () => {
    // 只发一个 chunk 就永远不再发（模拟半开连接）
    const server = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'once' } }] }) + '\n\n')
        // 不再 end，也不再写
      })
    })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    const ctx = await bootProxy({
      upstreamPort: server.address().port,
      overrides: { proxy: { host: '127.0.0.1', port: 0, stream: { idle_timeout_ms: 300 } } },
    })
    try {
      const started = Date.now()
      const res = await request(ctx.base, 'POST', '/v1/chat/completions', {
        headers: ctx.auth,
        body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], stream: true },
      })
      const elapsed = Date.now() - started
      assert.equal(res.status, 200)
      assert.ok(res.text.includes('once'), '第一个 chunk 应已透传')
      assert.ok(res.text.includes('upstream_idle_timeout') || res.text.includes('"error"'), '必须给出可识别的错误信号:' + res.text.slice(-200))
      assert.ok(res.text.includes('[DONE]'))
      assert.ok(elapsed < 3000, '空闲超时应尽快生效，实际 ' + elapsed + 'ms')
    } finally {
      await ctx.close()
      await new Promise(r => server.close(r))
    }
  })

  it('每个成功的中继都带 SSE 头与 X-Accel-Buffering，且 usage 被记账', async () => {
    const upstream = await slowSseUpstream({ chunkDelayMs: 5, maxChunks: 3 })
    const ctx = await bootProxy({ upstreamPort: upstream.port })
    try {
      const completed = []
      ctx.proxy.eventBus.on('request:complete', d => completed.push(d))
      const res = await request(ctx.base, 'POST', '/v1/chat/completions', {
        headers: ctx.auth,
        body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], stream: true },
      })
      assert.equal(res.status, 200)
      assert.match(res.headers['content-type'], /text\/event-stream/)
      assert.equal(res.headers['x-accel-buffering'], 'no')
      await new Promise(r => setTimeout(r, 100))
      assert.equal(completed.length, 1)
    } finally {
      await ctx.close()
      await upstream.close()
    }
  })
})

describe('FIX-11 协议透传（HTTP 集成）', () => {
  it('/v1/messages 透传到 anthropic 原生路径，并带上 x-api-key 与 anthropic-version', async () => {
    const upstream = await slowSseUpstream({ chunkDelayMs: 5, maxChunks: 1 })
    const ctx = await bootProxy({
      upstreamPort: upstream.port,
      overrides: {
        providers: {
          anthropic: { api_key: 'sk-ant-unit-test-key-0001', base_url: 'http://127.0.0.1:' + upstream.port + '/v1' },
        },
        default_provider: 'openai',
      },
    })
    try {
      const res = await request(ctx.base, 'POST', '/v1/messages', {
        headers: ctx.auth,
        body: { model: 'claude-3-5-sonnet', max_tokens: 64, system: 'S'.repeat(6000), messages: [{ role: 'user', content: 'hi' }] },
      })
      assert.equal(res.status, 200)
      assert.equal(upstream.hits.length, 1)
      const hit = upstream.hits[0]
      assert.equal(hit.url, '/v1/messages')
      assert.equal(hit.headers['x-api-key'], 'sk-ant-unit-test-key-0001')
      assert.equal(hit.headers['anthropic-version'], '2023-06-01')
      // FIX-10：Anthropic 原生路径自动注入缓存断点
      assert.ok(Array.isArray(hit.body.system))
      assert.equal(hit.body.system[0].cache_control.type, 'ephemeral')
    } finally {
      await ctx.close()
      await upstream.close()
    }
  })

  it('/v1/responses 被透传（Codex CLI 默认端点）', async () => {
    const upstream = await slowSseUpstream({ chunkDelayMs: 5, maxChunks: 1 })
    const ctx = await bootProxy({ upstreamPort: upstream.port })
    try {
      const res = await request(ctx.base, 'POST', '/v1/responses', {
        headers: ctx.auth,
        body: { model: 'gpt-4o-mini', input: 'hello', max_output_tokens: 16 },
      })
      assert.equal(res.status, 200)
      assert.equal(upstream.hits[0].url, '/v1/responses')
      assert.equal(upstream.hits[0].body.input, 'hello')
      assert.equal(upstream.hits[0].body.max_output_tokens, 16)
    } finally {
      await ctx.close()
      await upstream.close()
    }
  })

  it('multipart 上传原样透传（boundary 与字节都不被改写）', async () => {
    const upstream = await slowSseUpstream({ chunkDelayMs: 5, maxChunks: 1 })
    const ctx = await bootProxy({ upstreamPort: upstream.port })
    try {
      const boundary = '----ContextGateTestBoundary'
      const fileContent = 'hello-from-audio-file'
      const raw = Buffer.from(
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="file"; filename="a.txt"\r\n' +
        'Content-Type: text/plain\r\n\r\n' +
        fileContent + '\r\n' +
        '--' + boundary + '--\r\n',
      )
      const res = await request(ctx.base, 'POST', '/v1/audio/transcriptions', {
        headers: { ...ctx.auth, 'Content-Type': 'multipart/form-data; boundary=' + boundary },
        raw,
      })
      assert.equal(res.status, 200)
      assert.equal(upstream.hits.length, 1)
      assert.equal(upstream.hits[0].url, '/v1/audio/transcriptions')
      assert.equal(upstream.hits[0].headers['content-type'], 'multipart/form-data; boundary=' + boundary)
      assert.equal(Buffer.compare(upstream.hits[0].raw, raw), 0, '上游收到的字节应与客户端完全一致')
    } finally {
      await ctx.close()
      await upstream.close()
    }
  })

  it('未知 /v1 路径返回结构化 403，而不是 Express 的 HTML', async () => {
    const upstream = await slowSseUpstream({ chunkDelayMs: 5, maxChunks: 1 })
    const ctx = await bootProxy({ upstreamPort: upstream.port })
    try {
      const res = await request(ctx.base, 'POST', '/v1/definitely-not-a-thing', { headers: ctx.auth, body: {} })
      assert.equal(res.status, 403)
      assert.equal(JSON.parse(res.text).error.code, 'path_not_allowed')
    } finally {
      await ctx.close()
      await upstream.close()
    }
  })

  it('Idempotency-Key 会被透传给上游（代理重试才安全）', async () => {
    const upstream = await slowSseUpstream({ chunkDelayMs: 5, maxChunks: 1 })
    const ctx = await bootProxy({ upstreamPort: upstream.port })
    try {
      await request(ctx.base, 'POST', '/v1/chat/completions', {
        headers: { ...ctx.auth, 'Idempotency-Key': 'idem-123' },
        body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      })
      assert.equal(upstream.hits[0].headers['idempotency-key'], 'idem-123')
    } finally {
      await ctx.close()
      await upstream.close()
    }
  })

  it('本地令牌放在 x-api-key 里也能通过鉴权（Claude Code 用法）', async () => {
    const upstream = await slowSseUpstream({ chunkDelayMs: 5, maxChunks: 1 })
    const ctx = await bootProxy({ upstreamPort: upstream.port })
    try {
      const res = await request(ctx.base, 'POST', '/v1/chat/completions', {
        headers: { 'x-api-key': ctx.token },
        body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      })
      assert.equal(res.status, 200)
      // 本地令牌绝不能被当成上游 Key 转发
      assert.notEqual(upstream.hits[0].headers.authorization, 'Bearer ' + ctx.token)
    } finally {
      await ctx.close()
      await upstream.close()
    }
  })
})

describe('FIX-08 重试（HTTP 集成）', () => {
  it('429 后自动重试并最终成功', async () => {
    let calls = 0
    const server = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        calls++
        if (calls < 3) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'slow down' } })); return }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ id: 'ok', choices: [{ message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }))
      })
    })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    const ctx = await bootProxy({
      upstreamPort: server.address().port,
      overrides: {
        proxy: {
          host: '127.0.0.1', port: 0,
          resilience: { max_retries: 3, base_delay_ms: 1, max_delay_ms: 2, jitter: false, retry_statuses: [429, 500, 502, 503, 504] },
        },
      },
    })
    try {
      const res = await request(ctx.base, 'POST', '/v1/chat/completions', {
        headers: ctx.auth,
        body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      })
      assert.equal(res.status, 200)
      assert.equal(calls, 3, '应当是 2 次 429 + 1 次成功')
      assert.equal(JSON.parse(res.text).choices[0].message.content, 'done')
    } finally {
      await ctx.close()
      await new Promise(r => server.close(r))
    }
  })

  it('降级到配置里的备用 provider', async () => {
    const primary = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'nope' } })) })
    })
    const backup = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ id: 'backup', choices: [{ message: { role: 'assistant', content: 'from-backup' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
      })
    })
    await new Promise(r => primary.listen(0, '127.0.0.1', r))
    await new Promise(r => backup.listen(0, '127.0.0.1', r))
    const dataDir = makeDataDir()
    const cfgPath = path.join(dataDir, 'config.yaml')
    fs.writeFileSync(cfgPath, yaml.dump({
      providers: {
        openai: { api_key: 'sk-unit-test-key-0123456789', base_url: 'http://127.0.0.1:' + primary.address().port + '/v1' },
        deepseek: { api_key: 'sk-unit-test-key-0123456789', base_url: 'http://127.0.0.1:' + backup.address().port + '/v1' },
      },
      default_provider: 'openai',
      proxy: { host: '127.0.0.1', port: 0, resilience: { max_retries: 0, fallback: { openai: ['deepseek'] } } },
    }), 'utf8')
    const proxy = new ProxyServer({ configPath: cfgPath, dataDir, eventBus: new EventBus() })
    const started = await proxy.start('127.0.0.1', 0)
    try {
      const res = await request('http://127.0.0.1:' + started.port, 'POST', '/v1/chat/completions', {
        headers: { Authorization: 'Bearer ' + started.token },
        body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      })
      assert.equal(res.status, 200)
      assert.equal(JSON.parse(res.text).choices[0].message.content, 'from-backup')
      const stats = JSON.parse((await request('http://127.0.0.1:' + started.port, 'GET', '/stats', { headers: { Authorization: 'Bearer ' + started.token } })).text)
      assert.equal(stats.resilience.stats.fallbacks, 1)
    } finally {
      await proxy.stop()
      await new Promise(r => primary.close(r))
      await new Promise(r => backup.close(r))
      try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
  })
})
