const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const yaml = require('js-yaml')

const { buildMetrics, PROMETHEUS_CONTENT_TYPE } = require('../lib/monitor/metrics')
const exportTools = require('../lib/monitor/export')
const { JsonlRequestLog } = require('../lib/monitor/jsonl-request-log')
const { ProxyServer } = require('../lib/proxy/proxy-server')
const { EventBus } = require('../lib/core/event-bus')
const { TokenMonitor } = require('../lib/monitor/token-monitor')

// ---------------------------------------------------------------------------
// FIX-17 验收：/metrics（Prometheus 文本）、CSV/JSON 导出、JSONL 脱敏日志
// ---------------------------------------------------------------------------

function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-p2-obs-'))
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

function request(base, method, urlPath, { body, headers = {} } = {}) {
  return new Promise(resolve => {
    const payload = body !== undefined ? Buffer.from(JSON.stringify(body)) : null
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

async function startUpstream() {
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-obs',
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

async function bootProxy({ overrides = {}, jsonl = false } = {}) {
  const dataDir = makeDataDir()
  const upstream = await startUpstream()
  const cfgPath = writeConfig(dataDir, overrides)
  const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8'))
  cfg.providers.openai.base_url = 'http://127.0.0.1:' + upstream.port + '/v1'
  if (jsonl) cfg.monitor = { ...(cfg.monitor || {}), request_log: { enabled: true, format: 'jsonl', file: 'requests.jsonl', retention_days: 30 } }
  fs.writeFileSync(cfgPath, yaml.dump(cfg), 'utf8')

  const monitor = new TokenMonitor({ dbPath: path.join(dataDir, 'contextgate.db') })
  await monitor._ensureReady()
  const eventBus = new EventBus()
  eventBus.on('request:complete', d => { monitor.recordRequest(d).catch(() => {}) })

  const proxy = new ProxyServer({
    configPath: cfgPath, dataDir, eventBus,
    getUsageSummary: () => monitor.getSummary(),
  })
  const started = await proxy.start('127.0.0.1', 0)
  return {
    proxy, monitor, dataDir, base: 'http://127.0.0.1:' + started.port,
    auth: { 'X-ContextGate-Token': started.token },
    token: started.token,
    async close() { await proxy.stop(); monitor.close(); await new Promise(r => upstream.server.close(r)) },
  }
}

describe('FIX-17 Prometheus 指标（纯函数）', () => {
  const summary = {
    total: { requestCount: 3, totalTokens: 300, totalCost: 0.42, totalSaved: 0.1, unknownPricing: 1, cacheHits: 2, cacheReadTokens: 50, cacheWriteTokens: 10 },
    today: { requests: 2, tokens: 200, cost: 0.2 },
    byProvider: [{ provider: 'openai', requests: 3, tokens: 300, cost: 0.42 }, { provider: 'anthropic', requests: 0, tokens: 0, cost: 0 }],
    uptime: 12.5,
  }

  it('输出合法的 exposition 文本，且 HELP/TYPE 各出现一次', () => {
    const text = buildMetrics({
      summary,
      cache: { entries: 4, hitRate: 0.4, memoryBytes: 1024 },
      promptCache: { requests: 3, hitRate: 0.5, prefixStableRate: 1, savedUSD: 0.02, writePremiumUSD: 0.01 },
      budget: { limit: 10, spent: 0.42, ratio: 0.042, level: 'ok', enforce: false },
      largeBody: { thresholdBytes: 1048576, active: 1, queued: 0, rejected: 2 },
      version: '5.5.0',
    })
    assert.ok(text.endsWith('\n'))
    assert.equal((text.match(/# HELP contextgate_requests_total /g) || []).length, 1)
    assert.equal((text.match(/# TYPE contextgate_requests_total /g) || []).length, 1)
    assert.match(text, /contextgate_requests_total 3/)
    assert.match(text, /contextgate_provider_requests_total\{provider="openai"\} 3/)
    assert.match(text, /contextgate_provider_requests_total\{provider="anthropic"\} 0/)
    assert.match(text, /contextgate_budget_limit_usd\{level="ok"\} 10/)
    assert.match(text, /contextgate_large_body_rejected_total 2/)
    assert.ok(text.includes('contextgate_build_info{version="5.5.0"'))
    // 每一行要么是注释，要么是 "指标名[标签] 数值"
    for (const line of text.trim().split('\n')) {
      if (line.startsWith('#')) continue
      assert.match(line, /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?[0-9.]+$/, '非法指标行: ' + line)
    }
  })

  it('标签值里的引号/换行/反斜杠被正确转义', () => {
    const text = buildMetrics({ summary: { byProvider: [{ provider: 'a"b\nc\\d', requests: 1 }] } })
    assert.match(text, /provider="a\\"b\\nc\\\\d"/)
  })

  it('没有任何数据时不产生半截指标（value 为 undefined 的样本被丢弃）', () => {
    const text = buildMetrics({})
    assert.equal(text.includes('contextgate_requests_total'), false)
    assert.ok(text.includes('contextgate_build_info'))
  })
})

describe('FIX-17 CSV/JSON 序列化（纯函数）', () => {
  const rows = [
    { id: 1, timestamp: '2026-01-01 00:00:00', provider: 'openai', model: 'gpt-4o', method: 'POST', path: '/v1/chat/completions', status: 200, cached: false, responseTime: 12, inputTokens: 100, outputTokens: 20, cost: 0.001, error: null, messagePreview: 'hi' },
    { id: 2, timestamp: '2026-01-01 00:00:01', provider: 'openai', model: 'gpt-4o', method: 'POST', path: '/v1/chat/completions', status: 200, cached: true, responseTime: 1, inputTokens: 0, outputTokens: 0, cost: 0, error: '', messagePreview: 'a,b"c\nd' },
  ]

  it('CSV 对逗号/引号/换行做 RFC4180 转义', () => {
    const csv = exportTools.toCsv(rows)
    const lines = csv.trim().split('\r\n')
    assert.equal(lines[0], exportTools.CSV_COLUMNS.join(','))
    assert.equal(lines.length, 3)
    assert.ok(lines[2].includes('"a,b""c'))
    assert.match(lines[2], /"a,b""c\nd"/)
  })

  it('JSON 导出带 exportedAt / count / entries', () => {
    const parsed = JSON.parse(exportTools.toJson(rows))
    assert.equal(parsed.count, 2)
    assert.equal(parsed.entries.length, 2)
    assert.ok(parsed.exportedAt)
  })

  it('serialize 按 format 选择内容类型与扩展名', () => {
    assert.equal(exportTools.serialize(rows, { format: 'csv' }).extension, 'csv')
    assert.equal(exportTools.serialize(rows, { format: 'csv' }).contentType.startsWith('text/csv'), true)
    assert.equal(exportTools.serialize(rows, {}).extension, 'json')
    assert.equal(exportTools.normalizeFormat('CSV'), 'csv')
    assert.equal(exportTools.normalizeFormat('weird'), 'json')
  })
})

describe('FIX-17 JSONL 请求日志（单元）', () => {
  it('写入即脱敏，list 倒序返回', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-p2-jsonl-'))
    const log = new JsonlRequestLog({ filePath: path.join(dir, 'requests.jsonl'), logger: { warn() {} } })
    await log.record({ provider: 'openai', model: 'gpt-4o', path: '/v1/chat/completions', status: 200, messagePreview: 'my key sk-abc123456789 and Authorization: Bearer abc.def.ghi' })
    await log.record({ provider: 'anthropic', model: 'claude', path: '/v1/messages', status: 200, messagePreview: 'second' })
    const rows = await log.list({ limit: 10 })
    assert.equal(rows.length, 2)
    assert.equal(rows[0].provider, 'anthropic')
    assert.equal(rows[1].provider, 'openai')
    assert.ok(!rows[1].messagePreview.includes('sk-abc123456789'), 'sk- 密钥必须被脱敏')
    assert.match(rows[1].messagePreview, /\*\*\*/)
    const raw = fs.readFileSync(path.join(dir, 'requests.jsonl'), 'utf8')
    assert.ok(!raw.includes('sk-abc123456789'))
    await log.close()
  })

  it('prune 会删除过老的行', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-p2-jsonl2-'))
    const file = path.join(dir, 'requests.jsonl')
    fs.writeFileSync(file, [
      JSON.stringify({ id: 1, timestamp: '2000-01-01T00:00:00.000Z', provider: 'old' }),
      JSON.stringify({ id: 2, timestamp: new Date().toISOString(), provider: 'new' }),
    ].join('\n') + '\n', 'utf8')
    const log = new JsonlRequestLog({ filePath: file, logger: { warn() {} } })
    const removed = await log.prune(30)
    assert.equal(removed, 1)
    const rows = await log.list({ limit: 10 })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].provider, 'new')
    await log.close()
  })
})

describe('FIX-17 /metrics 与导出端点（集成）', () => {
  let ctx
  before(async () => {
    ctx = await bootProxy()
    // 先产生一次真实请求，让统计与请求日志有内容
    await request(ctx.base, 'POST', '/v1/chat/completions', {
      body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] },
      headers: ctx.auth,
    })
    await new Promise(r => setTimeout(r, 100))
  })
  after(async () => { await ctx.close() })

  it('匿名访问 /metrics 被 401 拒绝', async () => {
    const res = await request(ctx.base, 'GET', '/metrics')
    assert.equal(res.status, 401)
  })

  it('/metrics 返回 Prometheus 文本与用量', async () => {
    const res = await request(ctx.base, 'GET', '/metrics', { headers: ctx.auth })
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /text\/plain/)
    assert.match(res.text, /contextgate_requests_total 1/)
    assert.match(res.text, /contextgate_provider_requests_total\{provider="openai"\} 1/)
    assert.match(res.text, /contextgate_tokens_total 120/)
  })

  it('CSV 导出带表头与附件文件名', async () => {
    const res = await request(ctx.base, 'GET', '/requests/export?format=csv', { headers: ctx.auth })
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /text\/csv/)
    assert.match(res.headers['content-disposition'], /attachment; filename="contextgate-requests\.csv"/)
    const lines = res.text.trim().split('\r\n')
    assert.equal(lines[0], exportTools.CSV_COLUMNS.join(','))
    assert.ok(lines.length >= 2)
  })

  it('JSON 导出返回结构化条目', async () => {
    const res = await request(ctx.base, 'GET', '/requests/export?format=json', { headers: ctx.auth })
    assert.equal(res.status, 200)
    const parsed = JSON.parse(res.text)
    assert.equal(parsed.count, 1)
    assert.equal(parsed.entries[0].provider, 'openai')
  })

  it('导出同样受令牌保护', async () => {
    const res = await request(ctx.base, 'GET', '/requests/export?format=csv')
    assert.equal(res.status, 401)
  })
})

describe('FIX-17 JSONL 后端装配（集成）', () => {
  it('配置 format=jsonl 时写入一行一条的脱敏日志', async () => {
    const ctx = await bootProxy({ jsonl: true })
    try {
      await request(ctx.base, 'POST', '/v1/chat/completions', {
        body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'token sk-live-abcdef123456' }] },
        headers: ctx.auth,
      })
      await new Promise(r => setTimeout(r, 100))
      const file = path.join(ctx.dataDir, 'requests.jsonl')
      // list() 会先把待写批次 flush 到磁盘（写接口本身是 500ms 批量追加）
      const rows = ctx.proxy.requestLog ? await ctx.proxy.requestLog.list({ limit: 10 }) : []
      assert.ok(fs.existsSync(file), '应写入 JSONL 文件')
      assert.equal(rows.length, 1)
      assert.equal(rows[0].provider, 'openai')
      assert.ok(!fs.readFileSync(file, 'utf8').includes('sk-live-abcdef123456'))
    } finally {
      await ctx.close()
    }
  })
})
