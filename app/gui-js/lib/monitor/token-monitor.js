const initSqlJs = require('sql.js')
const fs = require('fs')
const path = require('path')
const { calculateCost } = require('./cost-calculator')

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
  }

  async _init() {
    this.SQL = await initSqlJs()
    if (fs.existsSync(this.dbPath)) {
      this.db = new this.SQL.Database(fs.readFileSync(this.dbPath))
    } else {
      this.db = new this.SQL.Database()
      this._createTables()
    }
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
      cached INTEGER DEFAULT 0, response_time INTEGER
    )`)
    this.db.run(`CREATE TABLE IF NOT EXISTS daily_stats (
      date TEXT PRIMARY KEY, total_requests INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0, total_cost REAL DEFAULT 0, cache_hits INTEGER DEFAULT 0
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
    const { provider, model, input_tokens = 0, output_tokens = 0, cost: explicitCost, currency = 'USD', cached = false, response_time = 0 } = data
    const totalTokens = input_tokens + output_tokens
    const cost = explicitCost != null ? explicitCost : calculateCost(model, input_tokens, output_tokens)

    this._enQueueWrite(
      'INSERT INTO requests (provider,model,input_tokens,output_tokens,total_tokens,cost,currency,cached,response_time) VALUES (?,?,?,?,?,?,?,?,?)',
      [provider, model, input_tokens, output_tokens, totalTokens, cost, currency, cached ? 1 : 0, response_time],
    )
    const today = new Date().toISOString().split('T')[0]
    this._enQueueWrite(
      `INSERT INTO daily_stats (date,total_requests,total_tokens,total_cost,cache_hits) VALUES (?,1,?,?,?) ON CONFLICT(date) DO UPDATE SET total_requests=total_requests+1,total_tokens=total_tokens+?,total_cost=total_cost+?,cache_hits=cache_hits+?`,
      [today, totalTokens, cost, cached ? 1 : 0, totalTokens, cost, cached ? 1 : 0],
    )
    const month = today.substring(0, 7)
    this._enQueueWrite(
      `INSERT INTO monthly_stats (month,total_requests,total_tokens,total_cost) VALUES (?,1,?,?) ON CONFLICT(month) DO UPDATE SET total_requests=total_requests+1,total_tokens=total_tokens+?,total_cost=total_cost+?`,
      [month, totalTokens, cost, totalTokens, cost],
    )
  }

  async getSummary() {
    await this._ensureReady()
    try {
      const rc = this.db.exec('SELECT COUNT(*) FROM requests')[0]?.values[0][0] || 0
      const tt = this.db.exec('SELECT SUM(total_tokens) FROM requests')[0]?.values[0][0] || 0
      const tc = this.db.exec('SELECT SUM(cost) FROM requests')[0]?.values[0][0] || 0
      const ch = this.db.exec('SELECT SUM(cache_hits) FROM daily_stats')[0]?.values[0][0] || 0
      const today = new Date().toISOString().split('T')[0]
      const ts = this.db.exec('SELECT * FROM daily_stats WHERE date=?', [today])[0]
      const todayData = ts ? { requests: ts.values[0][1], tokens: ts.values[0][2], cost: ts.values[0][3], cacheHits: ts.values[0][4] } : { requests: 0, tokens: 0, cost: 0, cacheHits: 0 }
      const month = today.substring(0, 7)
      const ms = this.db.exec('SELECT * FROM monthly_stats WHERE month=?', [month])[0]
      const monthData = ms ? { requests: ms.values[0][1], tokens: ms.values[0][2], cost: ms.values[0][3] } : { requests: 0, tokens: 0, cost: 0 }
      const ps = this.db.exec('SELECT provider,COUNT(*),SUM(total_tokens),SUM(cost) FROM requests GROUP BY provider')
      return {
        total: { requestCount: rc, totalTokens: tt, totalCost: tc, cacheHits: ch },
        today: todayData, month: monthData,
        byProvider: ps.length > 0 ? ps[0].values.map(r => ({ provider: r[0], requests: r[1], tokens: r[2], cost: r[3] })) : [],
        uptime: process.uptime(),
      }
    } catch { return { total: { requestCount: 0, totalTokens: 0, totalCost: 0, cacheHits: 0 }, today: { requests: 0, tokens: 0, cost: 0, cacheHits: 0 }, month: { requests: 0, tokens: 0, cost: 0 }, byProvider: [], uptime: process.uptime() } }
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
