const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { TokenMonitor } = require('../lib/monitor/token-monitor')
const { RequestLog, redact } = require('../lib/monitor/request-log')
const { openDatabase, availableDrivers } = require('../lib/monitor/sqlite-driver')

// FIX-12 / P1-4 验收：数据层重做（增量写 + WAL + 索引 + 保留策略 + 双实例不丢数据）

const DRIVERS = availableDrivers()
const HAS_NODE_SQLITE = DRIVERS.includes('node:sqlite')
// 大部分用例只关心「数据层行为」，跑当前环境的首选驱动即可；
// 双实例回归必须两种驱动都跑，因为丢数据就是 sql.js 回退路径上的老缺陷。
const PREFERRED = HAS_NODE_SQLITE ? 'node:sqlite' : 'sql.js'

// 测试里不关心驱动内部告警，统一静音，避免污染测试输出
const silent = { debug () {}, info () {}, warn () {}, error () {} }

function tempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-p1-'))
}

function sleepSync (ms) {
  const end = Date.now() + ms
  while (Date.now() < end) { /* 等待文件句柄释放 */ }
}

function cleanup (dir) {
  // Windows 上句柄释放有一点点延迟，rm 失败就重试几次
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return } catch { sleepSync(50) }
  }
}

async function readProviders (dbPath, driver) {
  const monitor = new TokenMonitor({ dbPath, driver, logger: silent })
  try {
    const summary = await monitor.getSummary()
    return { summary, providers: summary.byProvider.map(p => p.provider).sort() }
  } finally {
    await monitor.close()
  }
}

describe('FIX-12 / P1-4 双实例不再互相覆盖', () => {
  // 老缺陷：两个 TokenMonitor 先后 close，后关闭者的内存快照会整体覆盖先关闭者写盘的数据
  for (const driver of DRIVERS) {
    it(`先后开关的实例都要留下自己的数据（${driver}）`, async () => {
      const dir = tempDir()
      try {
        const dbPath = path.join(dir, 'contextgate.db')
        const a = new TokenMonitor({ dbPath, driver, logger: silent })
        await a.recordRequest({ provider: 'provider-A', model: 'gpt-4o', input_tokens: 10, output_tokens: 5, cost: 0.001 })
        await a.flush()
        await a.close()

        const b = new TokenMonitor({ dbPath, driver, logger: silent })
        await b.recordRequest({ provider: 'provider-B', model: 'gpt-4o', input_tokens: 20, output_tokens: 7, cost: 0.002 })
        await b.flush()
        await b.close()

        const { summary, providers } = await readProviders(dbPath, driver)
        assert.deepEqual(providers, ['provider-A', 'provider-B'])
        assert.equal(summary.total.requestCount, 2)
        assert.equal(summary.total.totalTokens, 42)
        assert.ok(Math.abs(summary.total.totalCost - 0.003) < 1e-12)
      } finally {
        cleanup(dir)
      }
    })

    it(`同时开着的两个实例也不丢数据（${driver}）`, async () => {
      const dir = tempDir()
      try {
        const dbPath = path.join(dir, 'contextgate.db')
        const a = new TokenMonitor({ dbPath, driver, logger: silent })
        const b = new TokenMonitor({ dbPath, driver, logger: silent })
        await a.recordRequest({ provider: 'provider-A', model: 'gpt-4o', input_tokens: 10, output_tokens: 5, cost: 0.001 })
        await b.recordRequest({ provider: 'provider-B', model: 'gpt-4o', input_tokens: 20, output_tokens: 7, cost: 0.002 })
        // a 先落盘，b 后落盘：b 必须先把磁盘上的 A 读回来再合并自己的写入
        await a.flush()
        await b.flush()
        await a.close()
        await b.close()

        const { summary, providers } = await readProviders(dbPath, driver)
        assert.deepEqual(providers, ['provider-A', 'provider-B'])
        assert.equal(summary.total.requestCount, 2)
      } finally {
        cleanup(dir)
      }
    })
  }
})

describe('FIX-12 增量写入与既有 API 兼容', () => {
  it('N 条记录后 summary 数量正确，且不依赖定时器（显式 flush / close 后复查）', async () => {
    const dir = tempDir()
    try {
      const dbPath = path.join(dir, 'contextgate.db')
      const monitor = new TokenMonitor({ dbPath, driver: PREFERRED, logger: silent })
      for (let i = 0; i < 25; i++) {
        await monitor.recordRequest({
          provider: 'p' + (i % 2), model: 'gpt-4o',
          input_tokens: 100, output_tokens: 20, cost: 0.01,
          cached: i === 0, saved_cost: i === 0 ? 0.5 : 0,
        })
      }
      await monitor.flush()
      const summary = await monitor.getSummary()
      assert.equal(summary.total.requestCount, 25)
      assert.equal(summary.total.totalTokens, 25 * 120)
      assert.ok(Math.abs(summary.total.totalCost - 0.25) < 1e-12)
      assert.equal(summary.today.requests, 25)
      assert.equal(summary.today.tokens, 3000)
      await monitor.close()

      // 重新打开一个新实例（不经过任何定时器）确认数据真的落盘了
      const reopened = new TokenMonitor({ dbPath, driver: PREFERRED, logger: silent })
      const again = await reopened.getSummary()
      assert.equal(again.total.requestCount, 25)
      assert.equal(again.byProvider.length, 2)
      await reopened.close()
    } finally {
      cleanup(dir)
    }
  })

  it('reset 清空明细与聚合，且不会被待写批次补回来', async () => {
    const dir = tempDir()
    try {
      const dbPath = path.join(dir, 'contextgate.db')
      const monitor = new TokenMonitor({ dbPath, driver: PREFERRED, logger: silent })
      await monitor.recordRequest({ provider: 'openai', model: 'gpt-4o', input_tokens: 5, output_tokens: 5, cost: 0.01 })
      await monitor.reset()
      const summary = await monitor.getSummary()
      assert.equal(summary.total.requestCount, 0)
      assert.equal(summary.today.requests, 0)
      assert.equal(monitor.getTodayCostSync(), 0)
      await monitor.close()
    } finally {
      cleanup(dir)
    }
  })

  it('保留策略只删过老明细，daily_stats 聚合保留', async () => {
    const dir = tempDir()
    try {
      const dbPath = path.join(dir, 'contextgate.db')
      // retentionDays=0 关掉构造时的自动清理，用例自己显式调用
      const monitor = new TokenMonitor({ dbPath, driver: PREFERRED, retentionDays: 0, logRetentionDays: 0, logger: silent })
      await monitor.recordRequest({ provider: 'old-provider', model: 'gpt-4o', input_tokens: 1, output_tokens: 1, cost: 0.5 })
      await monitor.flush()
      // 造一条 2000 年的明细 + 同日的聚合，验证「明细删、聚合留」
      monitor._db.run("UPDATE requests SET timestamp='2000-01-01 00:00:00' WHERE provider=?", ['old-provider'])
      monitor._db.run("INSERT INTO daily_stats (date,total_requests,total_tokens,total_cost) VALUES ('2000-01-01',1,2,0.5)")
      await monitor.flush()

      const removed = await monitor.pruneOldData(90)
      assert.equal(removed, 1)
      assert.equal(monitor._db.all('SELECT id FROM requests').length, 0)
      const kept = monitor._db.all("SELECT date FROM daily_stats WHERE date='2000-01-01'")
      assert.equal(kept.length, 1, '聚合行必须保留，历史趋势不能因为保留策略消失')
      assert.equal(await monitor.pruneOldData(0), 0, '0 表示不清理')
      await monitor.close()
    } finally {
      cleanup(dir)
    }
  })

  it('requests 与 request_log 索引都存在', async () => {
    const dir = tempDir()
    try {
      const dbPath = path.join(dir, 'contextgate.db')
      const monitor = new TokenMonitor({ dbPath, driver: PREFERRED, logger: silent })
      await monitor._ensureReady()
      await monitor.flush()
      await monitor.close()

      const db = openDatabase({ dbPath, driver: PREFERRED, logger: silent })
      await db.ready()
      try {
        const names = db.all("SELECT name FROM sqlite_master WHERE type='index'").map(r => r.name)
        assert.ok(names.includes('idx_requests_timestamp'), 'requests(timestamp) 需要索引')
        assert.ok(names.includes('idx_requests_provider'), 'requests(provider) 需要索引')
        assert.ok(names.includes('idx_request_log_timestamp'), 'request_log(timestamp) 需要索引')
        const requestIndexes = db.all('PRAGMA index_list(requests)').map(r => r.name)
        assert.ok(requestIndexes.includes('idx_requests_timestamp'))
        assert.ok(requestIndexes.includes('idx_requests_provider'))
      } finally {
        db.close()
      }
    } finally {
      cleanup(dir)
    }
  })

  it('今日缓存的读/写 token 与节省额都进 summary，老字段保持不变', async () => {
    const dir = tempDir()
    try {
      const dbPath = path.join(dir, 'contextgate.db')
      const monitor = new TokenMonitor({ dbPath, driver: PREFERRED, logger: silent })
      // Anthropic 形状：缓存读写单独计数，saved_cost 是 prompt cache 折扣
      await monitor.recordRequest({
        provider: 'anthropic', model: 'claude-3-5-sonnet', input_tokens: 100, output_tokens: 20,
        cached_tokens: 900, cache_write_tokens: 50, cost: 0.005, saved_cost: 0.02,
      })
      // 响应缓存命中：saved_cost 只算 total_saved，不重复算 prompt cache 节省
      await monitor.recordRequest({
        provider: 'openai', model: 'gpt-4o', input_tokens: 10, output_tokens: 2,
        cost: 0, saved_cost: 0.03, cached: true,
      })
      // 今日花费同步可读（预算判定依赖它，不等数据库提交）
      assert.ok(Math.abs(monitor.getTodayCostSync() - 0.005) < 1e-12)
      assert.ok(Math.abs(await monitor.getTodayCost() - 0.005) < 1e-12)

      await monitor.flush()
      const s = await monitor.getSummary()
      assert.equal(s.total.cacheReadTokens, 900)
      assert.equal(s.total.cacheWriteTokens, 50)
      assert.ok(Math.abs(s.total.cacheSaved - 0.02) < 1e-12)
      assert.equal(s.today.cacheReadTokens, 900)
      assert.equal(s.today.cacheWriteTokens, 50)
      assert.ok(Math.abs(s.today.cacheSaved - 0.02) < 1e-12)
      // report.js 依赖的老字段
      assert.equal(s.today.requests, 2)
      assert.equal(s.today.tokens, 132)
      assert.equal(s.today.cacheHits, 1)
      assert.equal(s.today.unknownPricing, 0)
      assert.ok(Math.abs(s.today.saved - 0.05) < 1e-12)
      assert.ok(Math.abs(s.today.cost - 0.005) < 1e-12)
      assert.equal(s.month.requests, 2)
      assert.equal(s.month.tokens, 132)
      assert.equal(s.total.requestCount, 2)
      assert.ok(typeof s.uptime === 'number')

      const daily = await monitor.getDailyStats(7)
      assert.equal(daily.length, 1)
      assert.equal(daily[0].requests, 2)
      assert.equal(daily[0].cacheHits, 1)
      await monitor.close()
    } finally {
      cleanup(dir)
    }
  })

  it('价格未知的请求计入 unknownPricing（老行为不变）', async () => {
    const dir = tempDir()
    try {
      const dbPath = path.join(dir, 'contextgate.db')
      const monitor = new TokenMonitor({ dbPath, driver: PREFERRED, logger: silent })
      await monitor.recordRequest({ provider: 'x', model: 'no-such-model-zzz', input_tokens: 10, output_tokens: 2 })
      await monitor.flush()
      const s = await monitor.getSummary()
      assert.equal(s.today.unknownPricing, 1)
      assert.equal(s.total.unknownPricing, 1)
      assert.equal(s.total.totalCost, 0)
      await monitor.close()
    } finally {
      cleanup(dir)
    }
  })

  it('缺 provider 的请求也入库（NOT NULL 约束不该静默丢数据）', async () => {
    const dir = tempDir()
    try {
      const dbPath = path.join(dir, 'contextgate.db')
      const monitor = new TokenMonitor({ dbPath, driver: PREFERRED, logger: silent })
      await monitor.recordRequest({ model: 'gpt-4o', input_tokens: 1, output_tokens: 1, cost: 0.001 })
      await monitor.flush()
      const s = await monitor.getSummary()
      assert.equal(s.total.requestCount, 1)
      assert.equal(s.byProvider[0].provider, 'unknown')
      await monitor.close()
    } finally {
      cleanup(dir)
    }
  })
})

describe('FIX-12 驱动层', () => {
  it('availableDrivers 至少包含 sql.js 回退驱动', () => {
    const drivers = availableDrivers()
    assert.ok(Array.isArray(drivers))
    assert.ok(drivers.includes('sql.js'))
    assert.ok(drivers.length >= 1)
  })

  it('未知驱动名不抛错，自动挑选可用驱动', async () => {
    const dir = tempDir()
    try {
      const db = openDatabase({ dbPath: path.join(dir, 'auto.db'), driver: 'no-such-driver', logger: silent })
      await db.ready()
      assert.ok(['node:sqlite', 'sql.js'].includes(db.driverName))
      db.close()
    } finally {
      cleanup(dir)
    }
  })

  it('sql.js 回退：写入内存 + 原子落盘，不残留临时文件与锁文件', async () => {
    const dir = tempDir()
    try {
      const dbPath = path.join(dir, 'fallback.db')
      const db = openDatabase({ dbPath, driver: 'sql.js', logger: silent })
      await db.ready()
      assert.equal(db.driverName, 'sql.js')
      assert.equal(db.isPersistent, false, 'sql.js 必须显式 flush 才落盘')
      db.exec('CREATE TABLE t (a INTEGER, b TEXT)')
      db.run('INSERT INTO t (a,b) VALUES (?,?)', [1, 'x'])
      db.run('INSERT INTO t (a,b) VALUES (:a,:b)', { ':a': 2, ':b': 'y' })
      assert.equal(db.get('SELECT COUNT(*) AS c FROM t').c, 2, '对象参数与数组参数都要支持')
      assert.equal(db.all('SELECT a FROM t ORDER BY a').length, 2)
      assert.equal(db.get('SELECT * FROM t WHERE a=?', [99]), undefined)
      db.flush()
      assert.ok(fs.existsSync(dbPath), 'flush 后磁盘上应有数据库文件')
      db.close()
      const leftovers = fs.readdirSync(dir).filter(f => f.includes('.tmp-') || f.endsWith('.lock'))
      assert.deepEqual(leftovers, [])
      // 落盘的必须是可读的 sqlite 文件
      const reopened = openDatabase({ dbPath, driver: 'sql.js', logger: silent })
      await reopened.ready()
      assert.equal(reopened.get('SELECT COUNT(*) AS c FROM t').c, 2)
      reopened.close()
    } finally {
      cleanup(dir)
    }
  })

  it('node:sqlite 驱动：WAL + 磁盘增量写 + 数组/命名参数', { skip: !HAS_NODE_SQLITE }, async () => {
    const dir = tempDir()
    try {
      const dbPath = path.join(dir, 'disk.db')
      const db = openDatabase({ dbPath, driver: 'node:sqlite', logger: silent })
      await db.ready()
      assert.equal(db.driverName, 'node:sqlite')
      assert.equal(db.isPersistent, true)
      assert.equal(String(db.get('PRAGMA journal_mode').journal_mode).toLowerCase(), 'wal')
      assert.equal(Number(db.get('PRAGMA busy_timeout').timeout), 5000)
      db.run('CREATE TABLE t (a INTEGER, b TEXT)')
      db.run('INSERT INTO t (a,b) VALUES (?,?)', [1, 'x'])
      db.run('INSERT INTO t (a,b) VALUES (:a,:b)', { ':a': 2, ':b': 'y' })
      assert.equal(db.get('SELECT COUNT(*) AS c FROM t').c, 2)
      assert.equal(db.run('DELETE FROM t WHERE a=?', [1]).changes, 1)
      db.flush()
      db.close()
      const head = fs.readFileSync(dbPath).subarray(0, 15).toString('utf8')
      assert.equal(head, 'SQLite format 3')
    } finally {
      cleanup(dir)
    }
  })

  it('10 万行下 getSummary 仍然很快（有索引、不反复全表扫）', { skip: !HAS_NODE_SQLITE }, async (t) => {
    const dir = tempDir()
    try {
      const dbPath = path.join(dir, 'big.db')
      const setup = new TokenMonitor({ dbPath, driver: 'node:sqlite', retentionDays: 0, logger: silent })
      await setup._ensureReady()
      await setup.close()

      const db = openDatabase({ dbPath, driver: 'node:sqlite', logger: silent })
      await db.ready()
      db.exec('BEGIN')
      const chunk = 25000
      for (let done = 0; done < 100000; done += chunk) {
        const values = []
        for (let i = 0; i < chunk; i++) {
          values.push(`('p${(done + i) % 4}','gpt-4o',100,20,120,0.0001,'USD',0,10,0,1,0,0)`)
        }
        db.exec('INSERT INTO requests (provider,model,input_tokens,output_tokens,total_tokens,cost,currency,cached,response_time,saved_cost,pricing_known,cached_tokens,cache_write_tokens) VALUES ' + values.join(','))
      }
      db.exec('COMMIT')
      db.close()

      const monitor = new TokenMonitor({ dbPath, driver: 'node:sqlite', retentionDays: 0, logger: silent })
      await monitor.getSummary() // 预热
      const started = Date.now()
      const summary = await monitor.getSummary()
      const elapsed = Date.now() - started
      t.diagnostic(`getSummary on 100k rows: ${elapsed}ms`)
      assert.equal(summary.total.requestCount, 100000)
      assert.ok(elapsed < 1000, `10 万行 getSummary 应远快于 1s，实测 ${elapsed}ms`)
      await monitor.close()
    } finally {
      cleanup(dir)
    }
  })
})

describe('P2-4 请求级脱敏日志', () => {
  it('redact 把密钥、Bearer 令牌、api_key 值都替换成 ***', () => {
    const out = redact('Authorization: Bearer abc123def456 key sk-proj-abcdef123456 api_key=vsecret999')
    assert.ok(!out.includes('abc123def456'), out)
    assert.ok(!out.includes('sk-proj-abcdef123456'), out)
    assert.ok(!out.includes('vsecret999'), out)
    assert.ok(out.includes('***'))
    assert.ok(out.includes('api_key=***'))
    assert.ok(!redact('sk-xxx').includes('sk-xxx'))
    assert.ok(!redact('Bearer abc').includes('abc'))
    assert.ok(!redact('api_key=v').includes('=v'))
    // 非密钥内容不该被误伤
    assert.equal(redact('model=gpt-4o, tokens: 128'), 'model=gpt-4o, tokens: 128')
    assert.equal(redact(null), '')
    assert.equal(redact(undefined), '')
  })

  it('redact 会截断超长文本', () => {
    const out = redact('x'.repeat(500), 80)
    assert.ok(out.length <= 80, String(out.length))
    assert.ok(out.endsWith('…'))
    assert.ok(redact('y'.repeat(50), 80).length === 50)
  })

  it('RequestLog 记录、脱敏并可按 limit/offset 取回', async () => {
    const dir = tempDir()
    try {
      const dbPath = path.join(dir, 'contextgate.db')
      const log = new RequestLog({ dbPath, driver: PREFERRED, retentionDays: 30, maxMessagePreview: 40, logger: silent })
      for (let i = 0; i < 5; i++) {
        await log.record({
          provider: 'openai', model: 'gpt-4o', method: 'POST',
          path: '/v1/chat/completions?api_key=sk-abcdef123456',
          status: 200, cached: i === 0, responseTime: 12,
          inputTokens: 10, outputTokens: 3, cost: 0.001,
          messagePreview: 'Bearer sk-abcdef123456 请帮我写一段代码',
        })
      }
      const rows = await log.list({ limit: 3 })
      assert.equal(rows.length, 3)
      assert.equal(rows[0].provider, 'openai')
      assert.equal(rows[0].method, 'POST')
      assert.equal(rows[0].status, 200)
      // 倒序返回：最新的一条 cached=false（只有 i===0 那条是命中）
      assert.equal(rows[0].cached, false)
      assert.equal(rows[0].inputTokens, 10)
      assert.equal(rows[0].responseTime, 12)
      assert.ok(!rows[0].path.includes('sk-abcdef123456'), rows[0].path)
      assert.ok(rows[0].path.includes('api_key=***'), rows[0].path)
      assert.ok(!rows[0].messagePreview.includes('sk-abcdef123456'), rows[0].messagePreview)
      assert.ok(rows[0].messagePreview.length <= 40)
      const all = await log.list()
      assert.equal(all.length, 5)
      // timestamp DESC（同秒用 id 兜底，保证顺序稳定）
      assert.ok(all[0].id > all[4].id)
      assert.equal(all[4].cached, true, '最早插入的那条是缓存命中')
      const second = await log.list({ limit: 2, offset: 2 })
      assert.equal(second.length, 2)
      assert.notEqual(second[0].id, all[0].id)
      await log.close()
    } finally {
      cleanup(dir)
    }
  })

  it('RequestLog 保留策略删掉过老日志', async () => {
    const dir = tempDir()
    try {
      const dbPath = path.join(dir, 'contextgate.db')
      const log = new RequestLog({ dbPath, driver: PREFERRED, retentionDays: 30, logger: silent })
      await log.record({ provider: 'openai', method: 'POST', path: '/v1/chat/completions', status: 200 })
      await log.flush()
      log._db.run("UPDATE request_log SET timestamp='2000-01-01 00:00:00'")
      await log.flush()
      assert.equal(await log.prune(), 1)
      assert.equal((await log.list()).length, 0)
      assert.equal(await log.prune(0), 0)
      await log.close()
    } finally {
      cleanup(dir)
    }
  })

  it('RequestLog 与 TokenMonitor 共用同一个库文件（表结构幂等）', async () => {
    const dir = tempDir()
    try {
      const dbPath = path.join(dir, 'contextgate.db')
      const monitor = new TokenMonitor({ dbPath, driver: PREFERRED, logger: silent })
      await monitor.recordRequest({ provider: 'openai', model: 'gpt-4o', input_tokens: 1, output_tokens: 1, cost: 0.001 })
      await monitor.flush()
      await monitor.close()

      const log = new RequestLog({ dbPath, driver: PREFERRED, logger: silent })
      await log.record({ provider: 'openai', method: 'POST', path: '/v1/chat/completions', status: 200 })
      const rows = await log.list()
      assert.equal(rows.length, 1)
      await log.close()

      const again = new TokenMonitor({ dbPath, driver: PREFERRED, logger: silent })
      const summary = await again.getSummary()
      assert.equal(summary.total.requestCount, 1, '请求日志不该破坏统计表')
      await again.close()
    } finally {
      cleanup(dir)
    }
  })
})
