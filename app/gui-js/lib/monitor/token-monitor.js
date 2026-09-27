const initSqlJs = require('sql.js')
const fs = require('fs')
const path = require('path')
const { computeUsageCost } = require('./cost-calculator')

class TokenMonitor {
  constructor(options) {
    this.dbPath = options.dbPath
    this.db = null
    this.SQL = null
    this._initPromise = this._init()
    this._writeQueue = []
    this._flushTimer = null
    this._flushing = false
    this._processing = false
    this._closed = false
    // 供预算判定同步读取「今日已花费」，避免每次判定都走数据库
    this._todayCost = 0
    this._todayDate = this._today()
  }

  _today() { return new Date().toISOString().split('T')[0] }

  async _init() {
    this.SQL = await initSqlJs()
    if (fs.existsSync(this.dbPath)) {
      this.db = new this.SQL.Database(fs.readFileSync(this.dbPath))
      this._migrate()
    } else {
      this.db = new this.SQL.Database()
      this._createTables()
    }
    this._loadTodayCost()
  }

  _tableColumns(table) {
    try {
      const r = this.db.exec(`PRAGMA table_info(${table})`)
      return r.length ? r[0].values.map(v => v[1]) : []
    } catch { return [] }
  }

  // 老库补齐 FIX-04 新增列（幂等）
  _migrate() {
    try {
      const reqCols = this._tableColumns('requests')
      if (reqCols.length > 0) {
        if (!reqCols.includes('saved_cost')) this.db.run('ALTER TABLE requests ADD COLUMN saved_cost REAL DEFAULT 0')
        if (!reqCols.includes('pricing_known')) this.db.run('ALTER TABLE requests ADD COLUMN pricing_known INTEGER DEFAULT 1')
      } else {
        this._createTables()
        return
      }
      const dailyCols = this._tableColumns('daily_stats')
      if (dailyCols.length > 0) {
        if (!dailyCols.includes('total_saved')) this.db.run('ALTER TABLE daily_stats ADD COLUMN total_saved REAL DEFAULT 0')
        if (!dailyCols.includes('unknown_pricing')) this.db.run('ALTER TABLE daily_stats ADD COLUMN unknown_pricing INTEGER DEFAULT 0')
      }
      this._createTables()
    } catch (e) { console.error('TokenMonitor migration failed:', e.message) }
  }

  _loadTodayCost() {
    try {
      const today = this._today()
      const r = this.db.exec('SELECT total_cost FROM daily_stats WHERE date=?', [today])
      this._todayCost = r.length ? (Number(r[0].values[0][0]) || 0) : 0
      this._todayDate = today
    } catch { this._todayCost = 0 }
  }

  async _ensureReady() {
    if (this._closed) throw new Error('TokenMonitor is closed')
    if (!this.db) {
      try {
        await this._initPromise
      } catch (e) {
        throw new Error(`TokenMonitor not initialized: ${e.message}`)
      }
    }
    if (this._closed || !this.db) throw new Error('TokenMonitor is closed')
  }

  _createTables() {
    this.db.run(`CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT DEFAULT (datetime('now')),
      provider TEXT NOT NULL, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
      total_tokens INTEGER, cost REAL, currency TEXT DEFAULT 'USD',
      cached INTEGER DEFAULT 0, response_time INTEGER,
      saved_cost REAL DEFAULT 0, pricing_known INTEGER DEFAULT 1
    )`)
    this.db.run(`CREATE TABLE IF NOT EXISTS daily_stats (
      date TEXT PRIMARY KEY, total_requests INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0, total_cost REAL DEFAULT 0, cache_hits INTEGER DEFAULT 0,
      total_saved REAL DEFAULT 0, unknown_pricing INTEGER DEFAULT 0
    )`)
    this.db.run(`CREATE TABLE IF NOT EXISTS monthly_stats (
      month TEXT PRIMARY KEY, total_requests INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0, total_cost REAL DEFAULT 0
    )`)
    this._saveDb()
  }

  _saveDb() {
    if (!this.db || !this.dbPath) return
    try {
      const dir = path.dirname(this.dbPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(this.dbPath, Buffer.from(this.db.export()))
    } catch (e) { console.error('Failed to save DB:', e) }
  }

  _enQueueWrite(sql, params) {
    this._writeQueue.push({ sql, params })
    if (!this._processing && !this._flushing) { this._processing = true; this._asyncFlush() }
  }

  _asyncFlush() {
    if (this._flushTimer) clearTimeout(this._flushTimer)
    this._flushTimer = setTimeout(() => this._flushToDisk(), 5000)
  }

  _flushToDisk() {
    if (!this.db || this._writeQueue.length === 0 || this._flushing) return
    this._flushing = true
    const writes = this._writeQueue.splice(0)
    try { for (const w of writes) this.db.run(w.sql, w.params); this._saveDb() }
    catch (e) { console.error('Flush failed:', e); this._writeQueue.unshift(...writes) }
    finally {
      this._flushing = false
      if (this._writeQueue.length > 0) this._asyncFlush()
      else this._processing = false
    }
  }

  async recordRequest(data) {
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
      provider, model, input_tokens = 0, output_tokens = 0, cost: explicitCost,
      saved_cost: savedCostInput, pricing_known: pricingKnownInput,
      currency = 'USD', cached = false, response_time = 0,
    } = data
    const totalTokens = input_tokens + output_tokens

    let cost
    let pricingKnown
    if (explicitCost != null) {
      cost = Number(explicitCost) || 0
      pricingKnown = pricingKnownInput !== false
    } else {
      const computed = computeUsageCost(model, { prompt_tokens: input_tokens, completion_tokens: output_tokens })
      cost = computed.cost
      pricingKnown = pricingKnownInput !== undefined ? pricingKnownInput !== false : computed.known
    }
    const savedCost = Number(savedCostInput) || 0

    // 预算判定需要立即可见的今日花费，因此同步累加，不等数据库 flush
    const today = this._today()
    if (today !== this._todayDate) { this._todayDate = today; this._todayCost = 0 }
    this._todayCost += cost

    this._enQueueWrite(
      'INSERT INTO requests (provider,model,input_tokens,output_tokens,total_tokens,cost,currency,cached,response_time,saved_cost,pricing_known) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [provider, model, input_tokens, output_tokens, totalTokens, cost, currency, cached ? 1 : 0, response_time, savedCost, pricingKnown ? 1 : 0],
    )
    this._enQueueWrite(
      `INSERT INTO daily_stats (date,total_requests,total_tokens,total_cost,cache_hits,total_saved,unknown_pricing) VALUES (?,1,?,?,?,?,?)
       ON CONFLICT(date) DO UPDATE SET total_requests=total_requests+1,total_tokens=total_tokens+?,total_cost=total_cost+?,cache_hits=cache_hits+?,total_saved=total_saved+?,unknown_pricing=unknown_pricing+?`,
      [today, totalTokens, cost, cached ? 1 : 0, savedCost, pricingKnown ? 0 : 1,
        totalTokens, cost, cached ? 1 : 0, savedCost, pricingKnown ? 0 : 1],
    )
    const month = today.substring(0, 7)
    this._enQueueWrite(
      `INSERT INTO monthly_stats (month,total_requests,total_tokens,total_cost) VALUES (?,1,?,?) ON CONFLICT(month) DO UPDATE SET total_requests=total_requests+1,total_tokens=total_tokens+?,total_cost=total_cost+?`,
      [month, totalTokens, cost, totalTokens, cost],
    )
  }

  /** 同步读取今日已花费（美元），供预算判定使用 */
  getTodayCostSync() {
    const today = this._today()
    if (today !== this._todayDate) { this._todayDate = today; this._todayCost = 0 }
    return this._todayCost
  }

  async getTodayCost() {
    await this._ensureReady()
    return this.getTodayCostSync()
  }

  async getSummary() {
    await this._ensureReady()
    try {
      const rc = this.db.exec('SELECT COUNT(*) FROM requests')[0]?.values[0][0] || 0
      const tt = this.db.exec('SELECT SUM(total_tokens) FROM requests')[0]?.values[0][0] || 0
      const tc = this.db.exec('SELECT SUM(cost) FROM requests')[0]?.values[0][0] || 0
      const ts = this.db.exec('SELECT SUM(saved_cost) FROM requests')[0]?.values[0][0] || 0
      const up = this.db.exec('SELECT COUNT(*) FROM requests WHERE pricing_known=0')[0]?.values[0][0] || 0
      const ch = this.db.exec('SELECT SUM(cache_hits) FROM daily_stats')[0]?.values[0][0] || 0
      const today = this._today()
      const tRow = this.db.exec('SELECT * FROM daily_stats WHERE date=?', [today])[0]
      const todayData = tRow
        ? { requests: tRow.values[0][1], tokens: tRow.values[0][2], cost: tRow.values[0][3], cacheHits: tRow.values[0][4], saved: tRow.values[0][5] || 0, unknownPricing: tRow.values[0][6] || 0 }
        : { requests: 0, tokens: 0, cost: 0, cacheHits: 0, saved: 0, unknownPricing: 0 }
      const month = today.substring(0, 7)
      const ms = this.db.exec('SELECT * FROM monthly_stats WHERE month=?', [month])[0]
      const monthData = ms ? { requests: ms.values[0][1], tokens: ms.values[0][2], cost: ms.values[0][3] } : { requests: 0, tokens: 0, cost: 0 }
      const ps = this.db.exec('SELECT provider,COUNT(*),SUM(total_tokens),SUM(cost) FROM requests GROUP BY provider')
      return {
        total: { requestCount: rc, totalTokens: tt, totalCost: tc, totalSaved: ts, unknownPricing: up, cacheHits: ch },
        today: todayData, month: monthData,
        byProvider: ps.length > 0 ? ps[0].values.map(r => ({ provider: r[0], requests: r[1], tokens: r[2], cost: r[3] })) : [],
        uptime: process.uptime(),
      }
    } catch {
      return {
        total: { requestCount: 0, totalTokens: 0, totalCost: 0, totalSaved: 0, unknownPricing: 0, cacheHits: 0 },
        today: { requests: 0, tokens: 0, cost: 0, cacheHits: 0, saved: 0, unknownPricing: 0 },
        month: { requests: 0, tokens: 0, cost: 0 }, byProvider: [], uptime: process.uptime(),
      }
    }
  }

  async getDailyStats(days = 7) {
    await this._ensureReady()
    try {
      const r = this.db.exec('SELECT date,total_requests,total_tokens,total_cost,cache_hits FROM daily_stats ORDER BY date DESC LIMIT ?', [days])
      if (!r.length) return []
      return r[0].values.map(row => ({ date: row[0], requests: row[1], tokens: row[2], cost: row[3], cacheHits: row[4] }))
    } catch { return [] }
  }

  async reset() {
    await this._ensureReady()
    this.db.run('DELETE FROM requests'); this.db.run('DELETE FROM daily_stats'); this.db.run('DELETE FROM monthly_stats')
    this._todayCost = 0
    this._saveDb()
  }

  close() {
    this._closed = true
    // 若初始化仍在进行，先等待完成再关闭，防止 _init 完成后创建悬空 db 实例
    const doClose = () => {
      if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null }
      if (this._writeQueue.length > 0 && this.db) {
        for (const w of this._writeQueue) try { this.db.run(w.sql, w.params) } catch (e) { console.error('TokenMonitor close write failed:', e) }
        this._writeQueue = []; this._saveDb()
      }
      if (this.db) { this.db.close(); this.db = null }
    }
    // 若 _initPromise 尚未 settled，等待后再关闭
    if (!this.db) {
      Promise.resolve(this._initPromise).catch(() => {}).then(doClose)
    } else {
      doClose()
    }
  }
}

module.exports = { TokenMonitor }
