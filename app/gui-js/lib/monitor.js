const initSqlJs = require('sql.js')
const fs = require('fs')
const path = require('path')

class LRUCache {
  constructor(maxSize = 1000) {
    this.maxSize = maxSize
    this.cache = new Map()
  }

  get(key) {
    if (!this.cache.has(key)) return null
    this.cache.delete(key)
    this.cache.set(key, { value: this.cache.get(key).value, lastAccess: Date.now() })
    return this.cache.get(key)?.value
  }

  set(key, value) {
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value
      this.cache.delete(oldest)
    }
    this.cache.set(key, { value, lastAccess: Date.now() })
  }

  clear() {
    this.cache.clear()
  }

  get size() {
    return this.cache.size
  }
}

class TokenMonitor {
  constructor(options) {
    this.dbPath = options.dbPath
    this.db = null
    this.SQL = null
    this._initPromise = this._init()
    this._pendingWrites = []
    this._flushTimer = null
    this.lruCache = new LRUCache(options.cacheSize || 1000)
    this._writeQueue = []
    this._processing = false
  }

  async _init() {
    this.SQL = await initSqlJs()
    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath)
      this.db = new this.SQL.Database(buffer)
    } else {
      this.db = new this.SQL.Database()
      this._createTables()
    }
  }

  async _ensureReady() {
    if (!this.db) {
      await this._initPromise
    }
  }

  _createTables() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT DEFAULT (datetime('now')),
        provider TEXT NOT NULL,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER,
        cost REAL,
        currency TEXT DEFAULT 'USD',
        cached INTEGER DEFAULT 0,
        response_time INTEGER
      )
    `)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS daily_stats (
        date TEXT PRIMARY KEY,
        total_requests INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        total_cost REAL DEFAULT 0,
        cache_hits INTEGER DEFAULT 0
      )
    `)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS monthly_stats (
        month TEXT PRIMARY KEY,
        total_requests INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        total_cost REAL DEFAULT 0
      )
    `)

    this._saveDb()
  }

  _saveDb() {
    if (this.db && this.dbPath) {
      try {
        const data = this.db.export()
        const buffer = Buffer.from(data)
        const dir = path.dirname(this.dbPath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
        fs.writeFileSync(this.dbPath, buffer)
      } catch (e) {
        console.error('Failed to save DB:', e)
      }
    }
  }

  _asyncFlush() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer)
    }
    this._flushTimer = setTimeout(() => {
      this._flushToDisk()
    }, 5000)
  }

  _flushToDisk() {
    if (!this.db || this._writeQueue.length === 0) return

    const writes = this._writeQueue.splice(0, this._writeQueue.length)
    try {
      for (const write of writes) {
        this.db.run(...write.sql, write.params)
      }
      this._saveDb()
    } catch (e) {
      console.error('Failed to flush writes:', e)
      this._writeQueue.unshift(...writes)
    }
  }

  _enQueueWrite(sql, params) {
    this._writeQueue.push({ sql, params })
    if (!this._processing) {
      this._processing = true
      this._asyncFlush()
    }
  }

  async recordRequest(data) {
    await this._ensureReady()

    const {
      provider,
      model,
      input_tokens = 0,
      output_tokens = 0,
      cost = 0,
      currency = 'USD',
      cached = false,
      response_time = 0
    } = data

    const totalTokens = input_tokens + output_tokens

    const cacheKey = `${provider}:${model}:${input_tokens}:${output_tokens}:${Date.now()}`
    const cachedData = this.lruCache.get(cacheKey)

    if (!cached && totalTokens > 0) {
      this.lruCache.set(cacheKey, { data, totalTokens, cost })
    }

    this._enQueueWrite(
      `INSERT INTO requests (provider, model, input_tokens, output_tokens, total_tokens, cost, currency, cached, response_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [provider, model, input_tokens, output_tokens, totalTokens, cost, currency, cached ? 1 : 0, response_time]
    )

    const today = new Date().toISOString().split('T')[0]
    this._enQueueWrite(
      `INSERT INTO daily_stats (date, total_requests, total_tokens, total_cost, cache_hits)
       VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         total_requests = total_requests + 1,
         total_tokens = total_tokens + ?,
         total_cost = total_cost + ?,
         cache_hits = cache_hits + ?`,
      [today, totalTokens, cost, cached ? 1 : 0, totalTokens, cost, cached ? 1 : 0]
    )

    const month = today.substring(0, 7)
    this._enQueueWrite(
      `INSERT INTO monthly_stats (month, total_requests, total_tokens, total_cost)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(month) DO UPDATE SET
         total_requests = total_requests + 1,
         total_tokens = total_tokens + ?,
         total_cost = total_cost + ?`,
      [month, totalTokens, cost, totalTokens, cost]
    )
  }

  async getSummary() {
    await this._ensureReady()

    try {
      const requestCount = this.db.exec('SELECT COUNT(*) as count FROM requests')[0]?.values[0][0] || 0
      const totalTokens = this.db.exec('SELECT SUM(total_tokens) as sum FROM requests')[0]?.values[0][0] || 0
      const totalCost = this.db.exec('SELECT SUM(cost) as sum FROM requests')[0]?.values[0][0] || 0
      const cacheHits = this.db.exec('SELECT SUM(cache_hits) as sum FROM daily_stats')[0]?.values[0][0] || 0

      const today = new Date().toISOString().split('T')[0]
      const todayStats = this.db.exec('SELECT * FROM daily_stats WHERE date = ?', [today])[0]
      const todayData = todayStats ? {
        requests: todayStats.values[0][1],
        tokens: todayStats.values[0][2],
        cost: todayStats.values[0][3],
        cacheHits: todayStats.values[0][4]
      } : { requests: 0, tokens: 0, cost: 0, cacheHits: 0 }

      const month = today.substring(0, 7)
      const monthStats = this.db.exec('SELECT * FROM monthly_stats WHERE month = ?', [month])[0]
      const monthData = monthStats ? {
        requests: monthStats.values[0][1],
        tokens: monthStats.values[0][2],
        cost: monthStats.values[0][3]
      } : { requests: 0, tokens: 0, cost: 0 }

      const providerStats = this.db.exec('SELECT provider, COUNT(*) as count, SUM(total_tokens) as tokens, SUM(cost) as cost FROM requests GROUP BY provider')

      // Auto-calculate savings percentage: cached token ratio
      let savingsPercent = 0
      let todayCachedTokens = 0
      try {
        const cachedResult = this.db.exec(
          "SELECT COALESCE(SUM(total_tokens), 0) FROM requests WHERE cached = 1 AND date(timestamp) = date('now')"
        )
        todayCachedTokens = (cachedResult.length > 0 && cachedResult[0].values[0][0]) || 0
        const todayAllTokens = todayData.tokens + todayCachedTokens
        if (todayAllTokens > 0) {
          savingsPercent = Math.round((todayCachedTokens / todayAllTokens) * 100)
        }
      } catch (e) {}

      // Monthly savings percentage
      let monthSavingsPercent = 0
      try {
        const monthCachedResult = this.db.exec(
          "SELECT COALESCE(SUM(total_tokens), 0) FROM requests WHERE cached = 1 AND strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')"
        )
        const monthCachedTokens = (monthCachedResult.length > 0 && monthCachedResult[0].values[0][0]) || 0
        const monthAllTokens = monthData.tokens + monthCachedTokens
        if (monthAllTokens > 0) {
          monthSavingsPercent = Math.round((monthCachedTokens / monthAllTokens) * 100)
        }
      } catch (e) {}

      return {
        total: {
          requestCount,
          totalTokens,
          totalCost,
          cacheHits,
          memoryCacheSize: this.lruCache.size
        },
        today: todayData,
        month: monthData,
        byProvider: providerStats.length > 0 ? providerStats[0].values.map(row => ({
          provider: row[0],
          requests: row[1],
          tokens: row[2],
          cost: row[3]
        })) : [],
        savingsPercent,
        monthSavingsPercent,
        uptime: process.uptime()
      }
    } catch (e) {
      return {
        total: {
          requestCount: 0,
          totalTokens: 0,
          totalCost: 0,
          cacheHits: 0,
          memoryCacheSize: this.lruCache.size
        },
        today: { requests: 0, tokens: 0, cost: 0, cacheHits: 0 },
        month: { requests: 0, tokens: 0, cost: 0 },
        byProvider: [],
        savingsPercent: 0,
        monthSavingsPercent: 0,
        uptime: process.uptime()
      }
    }
  }

  async getDailyStats(days = 7) {
    await this._ensureReady()

    try {
      const result = this.db.exec(`
        SELECT date, total_requests, total_tokens, total_cost, cache_hits
        FROM daily_stats
        ORDER BY date DESC
        LIMIT ?
      `, [days])

      if (result.length === 0) return []

      return result[0].values.map(row => ({
        date: row[0],
        requests: row[1],
        tokens: row[2],
        cost: row[3],
        cacheHits: row[4]
      }))
    } catch (e) {
      return []
    }
  }

  async reset() {
    await this._ensureReady()
    this.db.run('DELETE FROM requests')
    this.db.run('DELETE FROM daily_stats')
    this.db.run('DELETE FROM monthly_stats')
    this.lruCache.clear()
    this._saveDb()
  }

  close() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer)
    }
    this._flushToDisk()
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }
}

module.exports = { TokenMonitor, LRUCache }