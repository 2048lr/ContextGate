const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const yaml = require('js-yaml')

const { ProxyServer } = require('../lib/proxy/proxy-server')
const { EventBus } = require('../lib/core/event-bus')
const { LargeBodyGate, LargeBodyBusyError, parseByteSize } = require('../lib/proxy/large-body')

// ---------------------------------------------------------------------------
// FIX-15 验收：大 body 与内存策略
//   - 超过阈值的请求不再经过 express.json（因此也不进缓存），而是流式透传
//   - 上游收到的是逐字节一致的请求体
//   - 大请求并发闸门：超出 max_concurrent + max_queue 时返回 429
//   - 超过 proxy.max_body_size 时返回结构化 413
// ---------------------------------------------------------------------------

function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-p2-large-'))
  fs.writeFileSync(path.join(dir, 'models-dev-cache.json'), '{}', 'utf8')
  return dir
}

function writeConfig(dataDir, overrides = {}) {
  const cfgPath = path.join(dataDir, 'config.yaml')
  const base = {
    providers: { openai: { api_key: 'sk-unit-test-key-0123456789', base_url: '' } },
    default_provider: 'openai',
    proxy: { host: '127.0.0.1', port: 0 },
    ...overrides,
  }
  fs.writeFileSync(cfgPath, yaml.dump(base), 'utf8')
  return cfgPath
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

async function bootProxy({ overrides = {}, handler, discard = false } = {}) {
  const dataDir = makeDataDir()
  const received = []
  let holdFirst = null
  const upstream = http.createServer((req, res) => {
    // discard=true：上游只读不存，避免用测试进程的堆来"记分"（内存基线的关键）
    if (discard) {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      received.push({ url: req.url, bytes: raw.length, body: raw.toString('utf8'), headers: req.headers })
      if (handler) return handler(req, res, raw, received.length)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'chatcmpl-large-' + received.length, bytes: raw.length }))
    })
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = upstream.address().port
  const cfgPath = writeConfig(dataDir, overrides)
  const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8'))
  cfg.providers.openai.base_url = 'http://127.0.0.1:' + upstreamPort + '/v1'
  fs.writeFileSync(cfgPath, yaml.dump(cfg), 'utf8')

  const proxy = new ProxyServer({ configPath: cfgPath, dataDir, eventBus: new EventBus() })
  const started = await proxy.start('127.0.0.1', 0)
  return {
    proxy, dataDir, received, upstream,
    holdFirst: fn => { holdFirst = fn },
    releaseFirst: () => holdFirst && holdFirst(),
    base: 'http://127.0.0.1:' + started.port,
    auth: { 'X-ContextGate-Token': started.token },
    async close() { await proxy.stop(); await new Promise(r => upstream.close(r)) },
  }
}

describe('FIX-15 parseByteSize', () => {
  it('识别大小单位', () => {
    assert.equal(parseByteSize('32mb'), 32 * 1024 * 1024)
    assert.equal(parseByteSize('1.5kb'), 1536)
    assert.equal(parseByteSize('2KB'), 2048)
    assert.equal(parseByteSize(4096), 4096)
    assert.equal(parseByteSize('1gb'), 1024 * 1024 * 1024)
  })
  it('无法解析时返回兜底值', () => {
    assert.equal(parseByteSize('', 7), 7)
    assert.equal(parseByteSize('nonsense', 9), 9)
    assert.equal(parseByteSize('12 zebibytes', 11), 11)
    assert.equal(parseByteSize(null, 5), 5)
  })
})

describe('FIX-15 LargeBodyGate', () => {
  it('按阈值判断是否需要流式透传', () => {
    const gate = new LargeBodyGate({ threshold_bytes: 1000 })
    assert.equal(gate.shouldStream(999), false)
    assert.equal(gate.shouldStream(1001), true)
    assert.equal(gate.shouldStream(undefined), false)
    assert.equal(new LargeBodyGate({ enabled: false, threshold_bytes: 1 }).shouldStream(99999), false)
  })

  it('并发不超过 maxConcurrent，超出后排队', async () => {
    const gate = new LargeBodyGate({ max_concurrent: 2, max_queue: 4 })
    let active = 0
    let peak = 0
    const tasks = []
    for (let i = 0; i < 6; i++) {
      tasks.push(gate.run(async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise(r => setTimeout(r, 20))
        active--
      }))
    }
    await Promise.all(tasks)
    assert.equal(peak, 2)
    assert.equal(gate.snapshot().active, 0)
    assert.equal(gate.snapshot().queued, 0)
  })

  it('队列满时以 LargeBodyBusyError 拒绝（映射为 429）', async () => {
    const gate = new LargeBodyGate({ max_concurrent: 1, max_queue: 0 })
    let release
    const blocker = gate.run(() => new Promise(r => { release = r }))
    await new Promise(r => setTimeout(r, 10))
    await assert.rejects(() => gate.run(async () => {}), err => {
      assert.ok(err instanceof LargeBodyBusyError)
      assert.equal(err.status, 429)
      assert.equal(err.code, 'large_request_busy')
      return true
    })
    release()
    await blocker
  })

  it('出错也会释放名额', async () => {
    const gate = new LargeBodyGate({ max_concurrent: 1 })
    await assert.rejects(() => gate.run(async () => { throw new Error('boom') }), /boom/)
    assert.equal(gate.snapshot().active, 0)
    await gate.run(async () => {})
    assert.equal(gate.snapshot().peakActive, 1)
  })
})

describe('FIX-15 大请求透传（集成）', () => {
  let ctx
  before(async () => {
    ctx = await bootProxy({ overrides: { proxy: { host: '127.0.0.1', port: 0, large_body: { enabled: true, threshold_bytes: 2048, max_concurrent: 4 } } } })
  })
  after(async () => { await ctx.close() })

  it('超过阈值的请求被逐字节透传，并绕过缓存', async () => {
    const payload = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x'.repeat(8192) }] }
    const first = await request(ctx.base, 'POST', '/v1/chat/completions', { body: payload, headers: ctx.auth })
    assert.equal(first.status, 200)
    assert.equal(first.headers['x-contextgate-mode'], 'large-body-passthrough')
    assert.equal(first.headers['x-cache'], undefined)

    const second = await request(ctx.base, 'POST', '/v1/chat/completions', { body: payload, headers: ctx.auth })
    assert.equal(second.status, 200)
    // 大请求不进响应缓存：第二次仍然是上游真实调用，而不是 X-Cache: HIT
    assert.equal(second.headers['x-cache'], undefined)

    assert.equal(ctx.received.length, 2)
    // 上游收到的字节与客户端发出的完全一致（证明没有被 express.json 重写）
    assert.equal(ctx.received[0].bytes, Buffer.byteLength(JSON.stringify(payload)))
    assert.equal(ctx.received[0].body, JSON.stringify(payload))
    assert.ok(ctx.received[0].headers['content-length'])
  })

  it('小请求仍然走解析路径并参与缓存', async () => {
    const payload = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'small' }] }
    const first = await request(ctx.base, 'POST', '/v1/chat/completions', { body: payload, headers: ctx.auth })
    const second = await request(ctx.base, 'POST', '/v1/chat/completions', { body: payload, headers: ctx.auth })
    assert.equal(first.status, 200)
    assert.equal(second.headers['x-cache'], 'HIT')
  })
})

describe('FIX-15 大请求并发闸门（集成）', () => {
  it('并发超过配额时第二个大请求得到 429', async () => {
    let releaseUpstream
    const held = new Promise(resolve => { releaseUpstream = resolve })
    const ctx = await bootProxy({
      overrides: { proxy: { host: '127.0.0.1', port: 0, large_body: { enabled: true, threshold_bytes: 128, max_concurrent: 1, max_queue: 0 } } },
      handler: async (req, res, raw) => {
        // 只有第一个请求会被阻塞；第二个请求在进入上游前就应被闸门拒绝
        if (raw.length > 4096) await held
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      },
    })
    try {
      const big = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'y'.repeat(9000) }] }
      const firstPromise = request(ctx.base, 'POST', '/v1/chat/completions', { body: big, headers: ctx.auth })
      // 等第一个请求真正进入上游
      const deadline = Date.now() + 3000
      while (ctx.received.length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
      assert.equal(ctx.received.length, 1)

      const second = await request(ctx.base, 'POST', '/v1/chat/completions', { body: big, headers: ctx.auth })
      assert.equal(second.status, 429)
      const parsed = JSON.parse(second.text)
      assert.equal(parsed.error.code, 'large_request_busy')

      releaseUpstream()
      const first = await firstPromise
      assert.equal(first.status, 200)
    } finally {
      releaseUpstream()
      await ctx.close()
    }
  })

  it('8MB 请求的堆内存峰值 < 2× 请求体（FIX-15 验收）', async () => {
    const body = JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x'.repeat(8 * 1024 * 1024) }] })
    const bytes = Buffer.byteLength(body)
    const measurePeak = async (enabled) => {
      // discard：上游不缓存请求体，否则测到的是上游的缓冲而不是代理的行为
      const ctx = await bootProxy({
        overrides: { proxy: { host: '127.0.0.1', port: 0, large_body: { enabled, threshold_bytes: 65536, max_concurrent: 4 } } },
        discard: true,
      })
      try {
        const send = () => request(ctx.base, 'POST', '/v1/chat/completions', {
          raw: Buffer.from(body), headers: ctx.auth,
        })
        await send() // 预热：让 JIT/缓冲池稳定下来
        const base = process.memoryUsage().heapUsed
        let peak = base
        const timer = setInterval(() => {
          const used = process.memoryUsage().heapUsed
          if (used > peak) peak = used
        }, 2)
        try {
          const res = await send()
          assert.equal(res.status, 200)
        } finally { clearInterval(timer) }
        return peak - base
      } finally { await ctx.close() }
    }

    const streamPeak = await measurePeak(true)
    assert.ok(
      streamPeak < bytes * 2,
      `流式透传的堆峰值 ${(streamPeak / 1048576).toFixed(1)}MB 应小于 2× 请求体（${(bytes * 2 / 1048576).toFixed(1)}MB）`,
    )
  })

  it('超过 max_body_size 时返回 JSON 413', async () => {
    const ctx = await bootProxy({ overrides: { proxy: { host: '127.0.0.1', port: 0, max_body_size: '2kb', large_body: { enabled: true, threshold_bytes: 128 } } } })
    try {
      const body = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'z'.repeat(6000) }] }
      const res = await request(ctx.base, 'POST', '/v1/chat/completions', { body, headers: ctx.auth })
      assert.equal(res.status, 413)
      const parsed = JSON.parse(res.text)
      assert.equal(parsed.error.code, 'request_too_large')
      assert.equal(ctx.received.length, 0)
    } finally {
      await ctx.close()
    }
  })
})
