const initSqlJs = require('sql.js')
const fs = require('fs')
const path = require('path')

const MODEL_PRICING = {
  'gpt-4o-mini': { input: 0.15 / 1000000, output: 0.6 / 1000000 },
  'gpt-4o': { input: 2.5 / 1000000, output: 10 / 1000000 },
  'gpt-4-32k': { input: 60 / 1000000, output: 120 / 1000000 },
  'gpt-4-turbo': { input: 10 / 1000000, output: 30 / 1000000 },
  'gpt-4': { input: 30 / 1000000, output: 60 / 1000000 },
  'gpt-3.5-turbo': { input: 0.5 / 1000000, output: 1.5 / 1000000 },
  'o1-pro': { input: 150 / 1000000, output: 600 / 1000000 },
  'o1-mini': { input: 3 / 1000000, output: 12 / 1000000 },
  'o1': { input: 15 / 1000000, output: 60 / 1000000 },
  'o3-mini': { input: 1.1 / 1000000, output: 4.4 / 1000000 },
  'claude-3.5-sonnet': { input: 3 / 1000000, output: 15 / 1000000 },
  'claude-3.5-haiku': { input: 0.8 / 1000000, output: 4 / 1000000 },
  'claude-3-opus': { input: 15 / 1000000, output: 75 / 1000000 },
  'claude-3-sonnet': { input: 3 / 1000000, output: 15 / 1000000 },
  'claude-3-haiku': { input: 0.25 / 1000000, output: 1.25 / 1000000 },
  'deepseek-chat': { input: 0.27 / 1000000, output: 1.1 / 1000000 },
  'deepseek-reasoner': { input: 0.55 / 1000000, output: 2.19 / 1000000 },
  'glm-4': { input: 0.1 / 1000000, output: 0.1 / 1000000 },
  'glm-4-plus': { input: 0.5 / 1000000, output: 0.5 / 1000000 },
  'glm-4-flash': { input: 0.01 / 1000000, output: 0.01 / 1000000 },
  'qwen-turbo': { input: 0.3 / 1000000, output: 0.6 / 1000000 },
  'qwen-plus': { input: 0.8 / 1000000, output: 2 / 1000000 },
  'qwen-max': { input: 2.4 / 1000000, output: 9.6 / 1000000 },
  'gemini-1.5-pro': { input: 1.25 / 1000000, output: 5 / 1000000 },
  'gemini-1.5-flash': { input: 0.075 / 1000000, output: 0.3 / 1000000 },
  'gemini-2.0-flash': { input: 0.1 / 1000000, output: 0.4 / 1000000 }
}

function calculateCost(model, inputTokens, outputTokens) {
  if (!model) return 0
  const lowerModel = model.toLowerCase()
  for (const [prefix, pricing] of Object.entries(MODEL_PRICING)) {
    if (lowerModel.startsWith(prefix)) {
      return (inputTokens || 0) * pricing.input + (outputTokens || 0) * pricing.output
    }
  }
  return 0
}

class LRUCache {
  constructor(maxSize = 1000) {
    this.maxSize = maxSize
    this.cache = new Map()
  }

  get(key) {
    if (!this.cache.has(key)) return null
    const entry = this.cache.get(key)
    this.cache.delete(key)
    entry.lastAccess = Date.now()
    this.cache.set(key, entry)
    return entry.value
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
    this._flushing = false
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
    if (!this.db || this._writeQueue.length === 0 || this._flushing) return

    this._flushing = true
    const writes = this._writeQueue.splice(0, this._writeQueue.length)
    try {
      for (const write of writes) {
        this.db.run(write.sql, write.params)
      }
      this._saveDb()
    } catch (e) {
      console.error('Failed to flush writes:', e)
      this._writeQueue.unshift(...writes)
    } finally {
      this._flushing = false
      if (this._writeQueue.length > 0) {
        this._asyncFlush()
      } else {
        this._processing = false
      }
    }
  }

  _enQueueWrite(sql, params) {
    this._writeQueue.push({ sql, params })
    if (!this._processing && !this._flushing) {
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
      cost: explicitCost,
      currency = 'USD',
      cached = false,
      response_time = 0
    } = data

    const totalTokens = input_tokens + output_tokens
    const cost = explicitCost != null ? explicitCost : calculateCost(model, input_tokens, output_tokens)

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
      this._flushTimer = null
    }
    if (this._writeQueue.length > 0 && this.db) {
      for (const write of this._writeQueue) {
        try {
          this.db.run(write.sql, write.params)
        } catch (e) {
          console.error('Failed to write on close:', e)
        }
      }
      this._writeQueue = []
      this._saveDb()
    }
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }
}

module.exports = { TokenMonitor, LRUCache, calculateCost, MODEL_PRICING }