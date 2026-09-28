const { openDatabase } = require('./sqlite-driver')
const { computeUsageCost } = require('./cost-calculator')
const { ensureRequestLogSchema } = require('./request-log')

// FIX-12 数据层重做：旧实现在内存里跑 sql.js，每 5 秒 db.export() 全量覆盖写整库
// （非原子、崩溃可损坏、库越大越阻塞主进程），两个实例先后 close 还会互相覆盖丢数据。
// 现在改为：磁盘库 + 增量 INSERT/UPDATE + 短间隔批量提交（不依赖定时器也能 flush），
// 今日花费在内存里同步累加，保证预算判定不必等数据库。

const DEFAULT_RETENTION_DAYS = 90
const DEFAULT_LOG_RETENTION_DAYS = 30
const DEFAULT_FLUSH_INTERVAL_MS = 500
const MAX_BATCH_SIZE = 200
const PRUNE_DELAY_MS = 2000

const INSERT_REQUEST_SQL = `INSERT INTO requests
  (provider,model,input_tokens,output_tokens,total_tokens,cost,currency,cached,response_time,saved_cost,pricing_known,cached_tokens,cache_write_tokens)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`

// 聚合行用「相对累加」而不是读改写：批量提交 + 多实例共用同一个库时都不会互相覆盖
const UPSERT_DAILY_SQL = `INSERT INTO daily_stats
  (date,total_requests,total_tokens,total_cost,cache_hits,total_saved,unknown_pricing,cache_read_tokens,cache_write_tokens,cache_saved)
  VALUES (?,1,?,?,?,?,?,?,?,?)
  ON CONFLICT(date) DO UPDATE SET
    total_requests=total_requests+1,total_tokens=total_tokens+?,total_cost=total_cost+?,
    cache_hits=cache_hits+?,total_saved=total_saved+?,unknown_pricing=unknown_pricing+?,
    cache_read_tokens=cache_read_tokens+?,cache_write_tokens=cache_write_tokens+?,cache_saved=cache_saved+?`

const UPSERT_MONTHLY_SQL = `INSERT INTO monthly_stats (month,total_requests,total_tokens,total_cost) VALUES (?,1,?,?)
  ON CONFLICT(month) DO UPDATE SET total_requests=total_requests+1,total_tokens=total_tokens+?,total_cost=total_cost+?`

function num (value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function emptyToday () {
  return {
    requests: 0, tokens: 0, cost: 0, cacheHits: 0, saved: 0, unknownPricing: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, cacheSaved: 0,
  }
}

function emptySummary () {
  return {
    total: {
      requestCount: 0, totalTokens: 0, totalCost: 0, totalSaved: 0, unknownPricing: 0, cacheHits: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, cacheSaved: 0,
    },
    today: emptyToday(),
    month: { requests: 0, tokens: 0, cost: 0 },
    byProvider: [],
    uptime: process.uptime(),
  }
}

class TokenMonitor {
  constructor (options = {}) {
    this.dbPath = options.dbPath
    this.driver = options.driver
    this.logger = options.logger || console
    this.retentionDays = options.retentionDays === undefined || options.retentionDays === null
      ? DEFAULT_RETENTION_DAYS
      : Math.max(0, Math.floor(Number(options.retentionDays) || 0))
    this.logRetentionDays = options.logRetentionDays === undefined || options.logRetentionDays === null
      ? DEFAULT_LOG_RETENTION_DAYS
      : Math.max(0, Math.floor(Number(options.logRetentionDays) || 0))
    this.flushIntervalMs = Number(options.flushIntervalMs) > 0
      ? Math.floor(Number(options.flushIntervalMs))
      : DEFAULT_FLUSH_INTERVAL_MS
    this.driverName = null
    this.isPersistent = false
    this._db = null
    this._closed = false
    this._pending = []
    this._flushTimer = null
    this._pruneTimer = null
    // 供预算判定同步读取「今日已花费」，避免每次判定都走数据库
    this._todayCost = 0
    this._todayDate = this._today()
    this._ready = this._init()
    // 没人 await 的初始化失败不该变成 unhandledRejection
    this._ready.catch(() => {})
  }

  _today () { return new Date().toISOString().split('T')[0] }

  async _init () {
    const db = openDatabase({ dbPath: this.dbPath, driver: this.driver, logger: this.logger })
    await db.ready()
    if (this._closed) { try { db.close() } catch { /* 忽略 */ } return }
    this._db = db
    this.driverName = db.driverName
    this.isPersistent = db.isPersistent
    this._ensureSchema()
    this._loadTodayCost()
    this._schedulePrune()
    return db
  }

  _log (level, message) {
    const logger = this.logger || console
    const fn = typeof logger[level] === 'function' ? logger[level] : null
    if (fn) fn.call(logger, message)
  }

  _ensureSchema () {
    const db = this._db
    db.exec(`CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT DEFAULT (datetime('now')),
      provider TEXT NOT NULL, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
      total_tokens INTEGER, cost REAL, currency TEXT DEFAULT 'USD',
      cached INTEGER DEFAULT 0, response_time INTEGER,
      saved_cost REAL DEFAULT 0, pricing_known INTEGER DEFAULT 1,
      cached_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0
    )`)
    db.exec(`CREATE TABLE IF NOT EXISTS daily_stats (
      date TEXT PRIMARY KEY, total_requests INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0, total_cost REAL DEFAULT 0, cache_hits INTEGER DEFAULT 0,
      total_saved REAL DEFAULT 0, unknown_pricing INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0, cache_saved REAL DEFAULT 0
    )`)
    db.exec(`CREATE TABLE IF NOT EXISTS monthly_stats (
      month TEXT PRIMARY KEY, total_requests INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0, total_cost REAL DEFAULT 0
    )`)
    // 老库迁移（幂等）：FIX-04 的 saved_cost/pricing_known，FIX-12 的 prompt cache 计数
    this._ensureColumn('requests', 'saved_cost', 'REAL DEFAULT 0')
    this._ensureColumn('requests', 'pricing_known', 'INTEGER DEFAULT 1')
    this._ensureColumn('requests', 'cached_tokens', 'INTEGER DEFAULT 0')
    this._ensureColumn('requests', 'cache_write_tokens', 'INTEGER DEFAULT 0')
    this._ensureColumn('daily_stats', 'total_saved', 'REAL DEFAULT 0')
    this._ensureColumn('daily_stats', 'unknown_pricing', 'INTEGER DEFAULT 0')
    this._ensureColumn('daily_stats', 'cache_read_tokens', 'INTEGER DEFAULT 0')
    this._ensureColumn('daily_stats', 'cache_write_tokens', 'INTEGER DEFAULT 0')
    this._ensureColumn('daily_stats', 'cache_saved', 'REAL DEFAULT 0')
    // 索引：总览聚合、按 provider 分组、按时间做保留策略清理都靠它，
    // 没有索引时 10 万行会退化成多次全表扫（P1-4 的「长期运行卡顿」）
    db.exec('CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_requests_provider ON requests(provider)')
    // 请求级脱敏日志与 requests 同库；表与索引一并建好，避免索引指向不存在的表
    ensureRequestLogSchema(db)
  }

  _ensureColumn (table, column, definition) {
    try {
      const columns = this._db.all(`PRAGMA table_info(${table})`).map(row => row.name)
      if (columns.length === 0) return
      if (!columns.includes(column)) this._db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    } catch (e) {
      this._log('warn', `迁移 ${table}.${column} 失败: ${e.message}`)
    }
  }

  _loadTodayCost () {
    try {
      const today = this._today()
      const row = this._db.get('SELECT total_cost FROM daily_stats WHERE date=?', [today])
      this._todayCost = row ? num(row.total_cost) : 0
      this._todayDate = today
    } catch {
      this._todayCost = 0
    }
  }

  _schedulePrune () {
    if (!(this.retentionDays > 0)) return
    // 清理老明细不该拖慢启动：初始化完成后异步跑一次，失败也不影响记账
    this._pruneTimer = setTimeout(() => {
      this._pruneTimer = null
      this.pruneOldData().catch(e => this._log('warn', `保留策略清理失败: ${e.message}`))
    }, PRUNE_DELAY_MS)
    if (typeof this._pruneTimer.unref === 'function') this._pruneTimer.unref()
  }

  async _ensureReady () {
    if (this._closed) throw new Error('TokenMonitor is closed')
    if (!this._db) {
      try {
        await this._ready
      } catch (e) {
        throw new Error(`TokenMonitor not initialized: ${e.message}`)
      }
    }
    if (this._closed || !this._db) throw new Error('TokenMonitor is closed')
  }

  _enqueue (sql, params) {
    this._pending.push({ sql, params })
    if (this._pending.length >= MAX_BATCH_SIZE) { this._commit(); return }
    this._scheduleFlush()
  }

  _scheduleFlush () {
    if (this._flushTimer || this._closed || !this._db) return
    this._flushTimer = setTimeout(() => { this._flushTimer = null; this._commit() }, this.flushIntervalMs)
    // 定时器不能拖住进程退出（CLI 用完就 close）
    if (typeof this._flushTimer.unref === 'function') this._flushTimer.unref()
  }

  /** 把待写批次落库；单条失败只告警，不让一条坏语句卡住整个批次 */
  _commit () {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null }
    if (!this._db || this._pending.length === 0) return
    const batch = this._pending
    this._pending = []
    for (const write of batch) {
      try { this._db.run(write.sql, write.params) }
      catch (e) { this._log('warn', `写入统计失败: ${e.message}`) }
    }
    // sql.js 回退驱动是内存库，提交后还得整体落盘；node:sqlite 下这是 no-op
    try { this._db.flush() } catch (e) { this._log('warn', `统计落盘失败: ${e.message}`) }
  }

  /** 把待写批次立刻落库（测试与关闭路径都靠它，不依赖定时器） */
  async flush () {
    if (!this._db) { try { await this._ready } catch { return } }
    if (!this._db) return
    this._commit()
    try { this._db.flush() } catch (e) { this._log('warn', `统计落盘失败: ${e.message}`) }
  }

  async recordRequest (data) {
    // 代理停止后仍可能有 in-flight 请求触发本回调；此时静默丢弃，
    // 避免 _ensureReady 抛错变成未捕获的 Promise rejection
    if (this._closed) return
    try {
      await this._ensureReady()
    } catch (e) {
      if (this._closed) return
      throw e
    }
    const {
      model, input_tokens: inputTokens = 0, output_tokens: outputTokens = 0, cost: explicitCost,
      saved_cost: savedCostInput, pricing_known: pricingKnownInput,
      currency = 'USD', cached = false, response_time: responseTime = 0,
      cached_tokens: cachedTokensInput = 0, cache_write_tokens: cacheWriteTokensInput = 0,
    } = data
    // requests.provider 是 NOT NULL：缺 provider 的行会被约束拒绝，静默丢数据，这里兜底成 unknown
    const provider = data.provider || 'unknown'
    const input = num(inputTokens)
    const output = num(outputTokens)
    const totalTokens = input + output
    const cacheReadTokens = num(cachedTokensInput)
    const cacheWriteTokens = num(cacheWriteTokensInput)

    let cost
    let pricingKnown
    if (explicitCost != null) {
      cost = num(explicitCost)
      pricingKnown = pricingKnownInput !== false
    } else {
      const computed = computeUsageCost(model, { prompt_tokens: input, completion_tokens: output })
      cost = computed.cost
      pricingKnown = pricingKnownInput !== undefined ? pricingKnownInput !== false : computed.known
    }
    const savedCost = num(savedCostInput)
    // prompt cache（读/写缓存 token）带来的节省单独记一列；
    // 响应缓存命中（cached=true）的节省只进 total_saved，不重复计入 cache_saved
    const cacheSaved = (cacheReadTokens > 0 || cacheWriteTokens > 0) ? savedCost : 0

    // 预算判定需要立即可见的今日花费，因此同步累加，不等数据库提交
    const today = this._today()
    if (today !== this._todayDate) { this._todayDate = today; this._todayCost = 0 }
    this._todayCost += cost

    this._enqueue(INSERT_REQUEST_SQL, [
      provider, model, input, output, totalTokens, cost, currency,
      cached ? 1 : 0, responseTime, savedCost, pricingKnown ? 1 : 0, cacheReadTokens, cacheWriteTokens,
    ])
    this._enqueue(UPSERT_DAILY_SQL, [
      today, totalTokens, cost, cached ? 1 : 0, savedCost, pricingKnown ? 0 : 1,
      cacheReadTokens, cacheWriteTokens, cacheSaved,
      totalTokens, cost, cached ? 1 : 0, savedCost, pricingKnown ? 0 : 1,
      cacheReadTokens, cacheWriteTokens, cacheSaved,
    ])
    const month = today.substring(0, 7)
    this._enqueue(UPSERT_MONTHLY_SQL, [month, totalTokens, cost, totalTokens, cost])
  }

  /** 同步读取今日已花费（美元），供预算判定使用 */
  getTodayCostSync () {
    const today = this._today()
    if (today !== this._todayDate) { this._todayDate = today; this._todayCost = 0 }
    return this._todayCost
  }

  async getTodayCost () {
    await this._ensureReady()
    return this.getTodayCostSync()
  }

  async getSummary () {
    await this._ensureReady()
    // 先把待写批次落库，保证 summary 与已经 recordRequest 的数据一致（不依赖定时器）
    this._commit()
    try {
      // 一次扫描算出 total 全部字段，避免 10 万行时对 requests 反复全表扫
      const totals = this._db.get(`SELECT
        COUNT(*) AS requestCount,
        COALESCE(SUM(total_tokens),0) AS totalTokens,
        COALESCE(SUM(cost),0) AS totalCost,
        COALESCE(SUM(saved_cost),0) AS totalSaved,
        COALESCE(SUM(CASE WHEN pricing_known=0 THEN 1 ELSE 0 END),0) AS unknownPricing,
        COALESCE(SUM(cached_tokens),0) AS cacheReadTokens,
        COALESCE(SUM(cache_write_tokens),0) AS cacheWriteTokens,
        COALESCE(SUM(CASE WHEN cached_tokens>0 OR cache_write_tokens>0 THEN saved_cost ELSE 0 END),0) AS cacheSaved
        FROM requests`) || {}
      const daily = this._db.get('SELECT COALESCE(SUM(cache_hits),0) AS cacheHits FROM daily_stats') || {}
      const today = this._today()
      const todayRow = this._db.get('SELECT * FROM daily_stats WHERE date=?', [today])
      const todayData = todayRow
        ? {
            requests: num(todayRow.total_requests), tokens: num(todayRow.total_tokens), cost: num(todayRow.total_cost),
            cacheHits: num(todayRow.cache_hits), saved: num(todayRow.total_saved),
            unknownPricing: num(todayRow.unknown_pricing),
            cacheReadTokens: num(todayRow.cache_read_tokens), cacheWriteTokens: num(todayRow.cache_write_tokens),
            cacheSaved: num(todayRow.cache_saved),
          }
        : emptyToday()
      const monthRow = this._db.get('SELECT * FROM monthly_stats WHERE month=?', [today.substring(0, 7)])
      const monthData = monthRow
        ? { requests: num(monthRow.total_requests), tokens: num(monthRow.total_tokens), cost: num(monthRow.total_cost) }
        : { requests: 0, tokens: 0, cost: 0 }
      const providers = this._db.all('SELECT provider,COUNT(*) AS requests,SUM(total_tokens) AS tokens,SUM(cost) AS cost FROM requests GROUP BY provider')
      return {
        total: {
          requestCount: num(totals.requestCount), totalTokens: num(totals.totalTokens), totalCost: num(totals.totalCost),
          totalSaved: num(totals.totalSaved), unknownPricing: num(totals.unknownPricing), cacheHits: num(daily.cacheHits),
          cacheReadTokens: num(totals.cacheReadTokens), cacheWriteTokens: num(totals.cacheWriteTokens), cacheSaved: num(totals.cacheSaved),
        },
        today: todayData,
        month: monthData,
        byProvider: providers.map(row => ({
          provider: row.provider, requests: num(row.requests), tokens: num(row.tokens), cost: num(row.cost),
        })),
        uptime: process.uptime(),
      }
    } catch (e) {
      this._log('warn', `读取统计失败: ${e.message}`)
      return emptySummary()
    }
  }

  async getDailyStats (days = 7) {
    await this._ensureReady()
    this._commit()
    try {
      const limit = Number(days) > 0 ? Math.floor(Number(days)) : 7
      const rows = this._db.all('SELECT date,total_requests,total_tokens,total_cost,cache_hits FROM daily_stats ORDER BY date DESC LIMIT ?', [limit])
      return rows.map(row => ({
        date: row.date, requests: num(row.total_requests), tokens: num(row.total_tokens),
        cost: num(row.total_cost), cacheHits: num(row.cache_hits),
      }))
    } catch { return [] }
  }

  /**
   * 保留策略：删掉 requests 里过老的明细行，daily_stats/monthly_stats 是聚合，保留下来；
   * retentionDays<=0 表示不清理。返回删除的明细条数（含过老的请求日志）。
   */
  async pruneOldData (retentionDays = this.retentionDays) {
    await this._ensureReady()
    const days = Number(retentionDays)
    if (!days || days <= 0) return 0
    this._commit()
    const cutoff = `-${Math.floor(days)} days`
    const result = this._db.run("DELETE FROM requests WHERE timestamp < datetime('now', ?)", [cutoff])
    let removed = num(result && result.changes)
    if (this.logRetentionDays > 0 && this._tableExists('request_log')) {
      const logResult = this._db.run("DELETE FROM request_log WHERE timestamp < datetime('now', ?)", [`-${Math.floor(this.logRetentionDays)} days`])
      removed += num(logResult && logResult.changes)
    }
    try { this._db.flush() } catch (e) { this._log('warn', `保留策略落盘失败: ${e.message}`) }
    return removed
  }

  _tableExists (name) {
    try {
      return this._db.all("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]).length > 0
    } catch { return false }
  }

  async reset () {
    await this._ensureReady()
    // 丢弃待写批次：否则 reset 之后定时器又把旧数据补写回来
    this._pending = []
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null }
    this._db.run('DELETE FROM requests')
    this._db.run('DELETE FROM daily_stats')
    this._db.run('DELETE FROM monthly_stats')
    this._todayCost = 0
    this._todayDate = this._today()
    try { this._db.flush() } catch (e) { this._log('warn', `重置后落盘失败: ${e.message}`) }
  }

  close () {
    if (this._closed) return Promise.resolve()
    this._closed = true
    if (this._pruneTimer) { clearTimeout(this._pruneTimer); this._pruneTimer = null }
    const finalize = () => {
      if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null }
      try { this._commit() } catch (e) { this._log('warn', `关闭前提交失败: ${e.message}`) }
      const db = this._db
      this._db = null
      if (!db) return
      // 必须先把内存批次整体落盘再关句柄：sql.js 回退驱动漏掉 flush 就等于丢掉最后一批请求
      try { db.flush() } catch (e) { this._log('warn', `关闭前落盘失败: ${e.message}`) }
      try { db.close() } catch (e) { this._log('warn', `关闭数据库失败: ${e.message}`) }
    }
    if (this._db) { finalize(); return Promise.resolve() }
    // 初始化仍在进行：等 ready 之后再关，防止 _init 完成后留下悬空的数据库句柄
    return Promise.resolve(this._ready).catch(() => {}).then(finalize)
  }
}

module.exports = { TokenMonitor }
