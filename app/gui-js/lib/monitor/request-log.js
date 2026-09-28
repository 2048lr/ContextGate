const { openDatabase } = require('./sqlite-driver')

// P2-4 / FIX-12：请求级脱敏日志。
// 只写「可回溯的元数据 + 已脱敏的短预览」，绝不落完整 prompt、请求头或 API Key：
// 出问题时能定位是哪次请求、哪个 provider、什么状态码，但把日志文件交出去也不会泄漏密钥。

const DEFAULT_RETENTION_DAYS = 30
const DEFAULT_MAX_MESSAGE_PREVIEW = 80
const DEFAULT_MAX_TEXT = 200
const MAX_LIST_LIMIT = 1000
const FLUSH_INTERVAL_MS = 500
const MAX_BATCH_SIZE = 200

const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS request_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT DEFAULT (datetime('now')),
  provider TEXT, model TEXT, method TEXT, path TEXT, status INTEGER,
  cached INTEGER DEFAULT 0, error TEXT, response_time INTEGER,
  input_tokens INTEGER, output_tokens INTEGER, cost REAL, message_preview TEXT
)`
const INDEX_SQL = 'CREATE INDEX IF NOT EXISTS idx_request_log_timestamp ON request_log(timestamp)'
const INSERT_SQL = `INSERT INTO request_log (provider,model,method,path,status,cached,error,response_time,input_tokens,output_tokens,cost,message_preview) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`

// 脱敏规则顺序有意义：先处理 Bearer，再处理 key=value，
// 否则 "Authorization: Bearer xxx" 会先被 key 规则截成 "Authorization=***"，丢掉后面的令牌值。
const SECRET_RULES = [
  // sk-... / sk-ant-... / sk-proj-... 之类的平台密钥
  { re: /\bsk-[A-Za-z0-9_-]{3,}/g, to: '***' },
  // Bearer 令牌（值可能是 JWT、base64 或平台密钥）
  { re: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{3,}/gi, to: '$1 ***' },
  // api_key=v、x-api-key: v、access_token=v、password=v、url 里的 key=v
  // 负向断言避免把 "Authorization: Bearer ***" 里的 Bearer 又当成密钥值
  {
    re: /\b((?:x-)?(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|password|passwd|secret|key|authorization))\b\s*[:=]\s*["']?(?!(?:Bearer|Basic)\b)[^\s"'&,;)\]}]+/gi,
    to: '$1=***',
  },
]

/**
 * 纯函数：把密钥替换成 ***，并截断到 maxLength。
 * 返回值长度保证 <= maxLength（超长时用 … 结尾）。
 */
function redact (text, maxLength = DEFAULT_MAX_TEXT) {
  if (text === undefined || text === null) return ''
  let out = typeof text === 'string' ? text : String(text)
  for (const rule of SECRET_RULES) out = out.replace(rule.re, rule.to)
  out = out.trim()
  const limit = Number(maxLength) > 0 ? Math.floor(Number(maxLength)) : DEFAULT_MAX_TEXT
  if (out.length > limit) out = limit > 1 ? out.slice(0, limit - 1) + '…' : out.slice(0, limit)
  return out
}

/** requests 与 request_log 同库，TokenMonitor 建表时也走这里，保证两边 DDL 完全一致 */
function ensureRequestLogSchema (db) {
  db.exec(SCHEMA_SQL)
  db.exec(INDEX_SQL)
}

function toText (value) {
  return value === undefined || value === null ? null : String(value)
}

function toInt (value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

function toReal (value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

class RequestLog {
  constructor (options = {}) {
    this.dbPath = options.dbPath
    // driver 是给测试用的可选覆盖项：不传就按环境自动挑（node:sqlite 优先）
    this.driver = options.driver
    this.logger = options.logger || console
    this.retentionDays = options.retentionDays === undefined
      ? DEFAULT_RETENTION_DAYS
      : Math.max(0, Number(options.retentionDays) || 0)
    this.maxMessagePreview = Number(options.maxMessagePreview) > 0
      ? Math.floor(Number(options.maxMessagePreview))
      : DEFAULT_MAX_MESSAGE_PREVIEW
    this.driverName = null
    this._db = null
    this._closed = false
    this._pending = []
    this._flushTimer = null
    this._ready = this._init()
    // 没人 await 的初始化失败不该变成 unhandledRejection
    this._ready.catch(() => {})
  }

  async _init () {
    const db = openDatabase({ dbPath: this.dbPath, driver: this.driver, logger: this.logger })
    await db.ready()
    if (this._closed) { try { db.close() } catch { /* 忽略 */ } return }
    ensureRequestLogSchema(db)
    this._db = db
    this.driverName = db.driverName
    return db
  }

  async _ensureReady () {
    if (this._closed) throw new Error('RequestLog is closed')
    if (!this._db) {
      try { await this._ready } catch (e) { throw new Error(`RequestLog not initialized: ${e.message}`) }
    }
    if (this._closed || !this._db) throw new Error('RequestLog is closed')
  }

  _log (level, message) {
    const logger = this.logger || console
    const fn = typeof logger[level] === 'function' ? logger[level] : null
    if (fn) fn.call(logger, message)
  }

  /** 记录一条请求日志；path/error/messagePreview 一律先脱敏再入库 */
  async record (entry = {}) {
    if (this._closed) return
    try { await this._ensureReady() } catch (e) { if (this._closed) return; throw e }
    this._pending.push({
      sql: INSERT_SQL,
      params: [
        toText(entry.provider), toText(entry.model), toText(entry.method),
        redact(entry.path, DEFAULT_MAX_TEXT),
        toInt(entry.status), entry.cached ? 1 : 0,
        redact(entry.error, DEFAULT_MAX_TEXT),
        toInt(entry.responseTime), toInt(entry.inputTokens), toInt(entry.outputTokens), toReal(entry.cost),
        redact(entry.messagePreview, this.maxMessagePreview),
      ],
    })
    if (this._pending.length >= MAX_BATCH_SIZE) this._commit()
    else this._scheduleFlush()
  }

  _scheduleFlush () {
    if (this._flushTimer || this._closed || !this._db) return
    this._flushTimer = setTimeout(() => { this._flushTimer = null; this._commit() }, FLUSH_INTERVAL_MS)
    // 定时器不能拖住进程退出
    if (typeof this._flushTimer.unref === 'function') this._flushTimer.unref()
  }

  _commit () {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null }
    if (!this._db || this._pending.length === 0) return
    const batch = this._pending
    this._pending = []
    for (const write of batch) {
      try { this._db.run(write.sql, write.params) }
      catch (e) { this._log('warn', `写入请求日志失败: ${e.message}`) }
    }
    // sql.js 回退驱动是内存库，提交后还要整体落盘，否则重启就丢日志
    try { this._db.flush() } catch (e) { this._log('warn', `请求日志落盘失败: ${e.message}`) }
  }

  /** 按 timestamp 倒序（同一秒内用 id 兜底，保证插入顺序稳定） */
  async list (options = {}) {
    await this._ensureReady()
    this._commit()
    const limit = Number(options.limit) > 0 ? Math.min(Math.floor(Number(options.limit)), MAX_LIST_LIMIT) : 100
    const offset = Number(options.offset) > 0 ? Math.floor(Number(options.offset)) : 0
    try {
      const rows = this._db.all(
        `SELECT id,timestamp,provider,model,method,path,status,cached,error,response_time,
          input_tokens,output_tokens,cost,message_preview
         FROM request_log ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`,
        [limit, offset],
      )
      return rows.map(row => ({
        id: row.id, timestamp: row.timestamp, provider: row.provider, model: row.model,
        method: row.method, path: row.path, status: row.status, cached: !!row.cached,
        error: row.error, responseTime: row.response_time,
        inputTokens: row.input_tokens, outputTokens: row.output_tokens, cost: row.cost,
        messagePreview: row.message_preview,
      }))
    } catch (e) {
      this._log('warn', `读取请求日志失败: ${e.message}`)
      return []
    }
  }

  /** 保留策略：只删过老的日志明细，返回删除条数 */
  async prune (retentionDays = this.retentionDays) {
    await this._ensureReady()
    const days = Number(retentionDays)
    if (!days || days <= 0) return 0
    this._commit()
    const result = this._db.run("DELETE FROM request_log WHERE timestamp < datetime('now', ?)", [`-${Math.floor(days)} days`])
    this._db.flush()
    return result.changes
  }

  async flush () {
    if (!this._db) { try { await this._ready } catch { return } }
    if (!this._db) return
    this._commit()
  }

  close () {
    if (this._closed) return Promise.resolve()
    this._closed = true
    const finalize = () => {
      if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null }
      try { this._commit() } catch (e) { this._log('warn', `关闭前提交请求日志失败: ${e.message}`) }
      const db = this._db
      this._db = null
      if (!db) return
      try { db.flush() } catch (e) { this._log('warn', `关闭前落盘请求日志失败: ${e.message}`) }
      try { db.close() } catch (e) { this._log('warn', `关闭请求日志数据库失败: ${e.message}`) }
    }
    if (this._db) { finalize(); return Promise.resolve() }
    // 初始化还在进行：等 ready 之后再关，避免留下没人管的句柄
    return Promise.resolve(this._ready).catch(() => {}).then(finalize)
  }
}

module.exports = { RequestLog, redact, ensureRequestLogSchema, DEFAULT_RETENTION_DAYS, DEFAULT_MAX_MESSAGE_PREVIEW }
