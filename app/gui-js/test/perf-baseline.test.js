const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { buildMetrics } = require('../lib/monitor/metrics')
const { toCsv } = require('../lib/monitor/export')
const { LargeBodyGate } = require('../lib/proxy/large-body')
const { CodeScanner } = require('../lib/scanner/scanner')
const { RequestLog } = require('../lib/monitor/request-log')

// ---------------------------------------------------------------------------
// FIX-19 验收：性能基线。
//
// 这些阈值故意放得很宽（CI 机器比开发机慢得多），目标是拦住「数量级」的退化：
// 例如指标生成退化成 O(n²)、CSV 导出逐字符拼接、扫描器在几百个文件上超时。
// 如果某个阈值在干净的 CI 上都持续触发，那才是需要调查的信号。
// ---------------------------------------------------------------------------

function measure(fn) {
  const start = process.hrtime.bigint()
  const result = fn()
  const ms = Number(process.hrtime.bigint() - start) / 1e6
  return { ms, result }
}

async function measureAsync(fn) {
  const start = process.hrtime.bigint()
  const result = await fn()
  const ms = Number(process.hrtime.bigint() - start) / 1e6
  return { ms, result }
}

function tempProject(files = 400) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-perf-'))
  for (let i = 0; i < files; i++) {
    const sub = path.join(dir, 'src', 'mod' + (i % 20))
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(path.join(sub, 'file' + i + '.js'), 'export function f' + i + ' (x) {\n  return x + ' + i + '\n}\n'.repeat(20), 'utf8')
  }
  return dir
}

describe('FIX-19 性能基线', () => {
  it('Prometheus 指标：500 个 provider 的生成时间 < 500ms', () => {
    const byProvider = []
    for (let i = 0; i < 500; i++) byProvider.push({ provider: 'provider-' + i, requests: i, tokens: i * 10, cost: i / 1000 })
    const { ms, result } = measure(() => buildMetrics({
      summary: { total: { requestCount: 1e5, totalTokens: 1e6, totalCost: 12.34, cacheHits: 100 }, today: {}, byProvider, uptime: 42 },
      cache: { entries: 10, hitRate: 0.5, memoryBytes: 1024 },
      promptCache: {}, largeBody: {}, version: '5.5.0',
    }))
    assert.ok(result.includes('contextgate_requests_total 100000'))
    assert.ok(ms < 500, '指标生成耗时 ' + ms.toFixed(1) + 'ms，超过 500ms')
  })

  it('CSV 导出：20000 行 < 1000ms', () => {
    const rows = []
    for (let i = 0; i < 20000; i++) rows.push({ id: i, timestamp: '2026-01-01 00:00:00', provider: 'openai', model: 'gpt-4o', method: 'POST', path: '/v1/chat/completions', status: 200, cached: i % 3 === 0, responseTime: 12, inputTokens: 100, outputTokens: 20, cost: 0.001, messagePreview: 'hello, "world"' })
    const { ms, result } = measure(() => toCsv(rows))
    assert.equal(result.trim().split('\r\n').length, 20001)
    assert.ok(ms < 1000, 'CSV 导出耗时 ' + ms.toFixed(1) + 'ms，超过 1000ms')
  })

  it('大请求闸门：2000 次顺序执行 < 2000ms 且不泄漏名额', async () => {
    const gate = new LargeBodyGate({ max_concurrent: 4, max_queue: 64 })
    const { ms } = await measureAsync(async () => {
      for (let i = 0; i < 2000; i++) await gate.run(async () => {})
    })
    assert.equal(gate.snapshot().active, 0)
    assert.ok(ms < 2000, '闸门开销 ' + ms.toFixed(1) + 'ms，超过 2000ms')
  })

  it('扫描器：400 个文件 < 5000ms', async () => {
    const dir = tempProject(400)
    const scanner = new CodeScanner(dir, { max_file_size: 1048576 })
    const { ms, result } = await measureAsync(() => scanner.scan())
    assert.ok(result.length >= 400, '应扫描到全部文件，实际 ' + result.length)
    assert.ok(ms < 5000, '扫描耗时 ' + ms.toFixed(1) + 'ms，超过 5000ms')
  })

  it('请求日志：批量写入 5000 条 < 4000ms', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-perf-log-'))
    const log = new RequestLog({ dbPath: path.join(dir, 'db.sqlite'), logger: { warn() {} } })
    const { ms } = await measureAsync(async () => {
      for (let i = 0; i < 5000; i++) await log.record({ provider: 'openai', model: 'gpt-4o', method: 'POST', path: '/v1/chat/completions', status: 200, responseTime: 10, inputTokens: 10, outputTokens: 5, cost: 0.0001, messagePreview: 'x' })
      await log.flush()
    })
    await log.close()
    assert.ok(ms < 4000, '请求日志写入耗时 ' + ms.toFixed(1) + 'ms，超过 4000ms')
  })
})
