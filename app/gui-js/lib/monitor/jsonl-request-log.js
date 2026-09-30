const fs = require('fs')
const path = require('path')
const { redact, DEFAULT_MAX_MESSAGE_PREVIEW } = require('./request-log')

// FIX-17：JSONL 请求日志后端。
//
// SQLite 适合查询与聚合，但接入 Langfuse/Helicone/自建采集器时，一行一条 JSON 的
// 追加日志更好用（可以直接 tail -f、filebeat、fluent-bit）。这里提供与 RequestLog
// 相同的接口，由配置 monitor.request_log.format 在两者之间切换。
//
// 与 SQLite 版一样，写入前必须脱敏：绝不落完整 prompt、请求头或 API Key。

const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024
const DEFAULT_FLUSH_INTERVAL_MS = 500
const DEFAULT_RETENTION_DAYS = 30

function toPublic (entry) {
  return {
    id: entry.id,
    timestamp: entry.timestamp || new Date().toISOString(),
    provider: entry.provider || null,
    model: entry.model || null,
    method: entry.method || null,
    path: entry.path || null,
    status: entry.status ?? null,
    cached: Boolean(entry.cached),
    error: entry.error || null,
    responseTime: entry.responseTime ?? null,
    inputTokens: entry.inputTokens ?? null,
    outputTokens: entry.outputTokens ?? null,
    cost: entry.cost ?? null,
    messagePreview: entry.messagePreview || '',
  }
}

class JsonlRequestLog {
  constructor (options = {}) {
    this.filePath = options.filePath
    this.logger = options.logger || console
    this.retentionDays = options.retentionDays === undefined
      ? DEFAULT_RETENTION_DAYS
      : Math.max(0, Number(options.retentionDays) || 0)
    this.maxMessagePreview = Number(options.maxMessagePreview) > 0
      ? Math.floor(Number(options.maxMessagePreview))
      : DEFAULT_MAX_MESSAGE_PREVIEW
    this.flushIntervalMs = Number(options.flushIntervalMs) > 0
      ? Math.floor(Number(options.flushIntervalMs))
      : DEFAULT_FLUSH_INTERVAL_MS
    this.maxReadBytes = Number(options.maxReadBytes) > 0 ? Math.floor(Number(options.maxReadBytes)) : DEFAULT_MAX_READ_BYTES
    this._pending = []
    this._timer = null
    this._closed = false
    this._nextId = 1
    if (this.filePath) {
      try { fs.mkdirSync(path.dirname(this.filePath), { recursive: true }) } catch { /* 目录已存在 */ }
    }
  }

  _ensureOpen () {
    if (this._closed) throw new Error('JsonlRequestLog is closed')
    if (!this.filePath) throw new Error('JsonlRequestLog requires filePath')
  }

  record (entry = {}) {
    if (this._closed) return Promise.resolve()
    try { this._ensureOpen() } catch { return Promise.resolve() }
    const row = toPublic(entry)
    row.id = this._nextId++
    row.messagePreview = redact(row.messagePreview, this.maxMessagePreview)
    row.path = redact(row.path, 200)
    row.error = redact(row.error, 200)
    this._pending.push(JSON.stringify(row))
    this._scheduleFlush()
    return Promise.resolve(row)
  }

  _scheduleFlush () {
    if (this._timer || this._closed) return
    this._timer = setTimeout(() => { this._timer = null; this.flush().catch(() => {}) }, this.flushIntervalMs)
    if (typeof this._timer.unref === 'function') this._timer.unref()
  }

  async flush () {
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    if (this._pending.length === 0) return 0
    const batch = this._pending
    this._pending = []
    try {
      await fs.promises.appendFile(this.filePath, batch.join('\n') + '\n', 'utf8')
      return batch.length
    } catch (e) {
      this.logger.warn?.('写入 JSONL 请求日志失败: ' + e.message)
      return 0
    }
  }

  _readTailLines () {
    let stat
    try { stat = fs.statSync(this.filePath) } catch { return [] }
    const start = Math.max(0, stat.size - this.maxReadBytes)
    const length = stat.size - start
    if (length <= 0) return []
    const fd = fs.openSync(this.filePath, 'r')
    try {
      const buffer = Buffer.alloc(length)
      fs.readSync(fd, buffer, 0, length, start)
      let text = buffer.toString('utf8')
      // 从中间截断时丢掉第一行残缺内容
      if (start > 0) {
        const firstNewline = text.indexOf('\n')
        text = firstNewline === -1 ? '' : text.slice(firstNewline + 1)
      }
      return text.split('\n').filter(Boolean)
    } finally {
      try { fs.closeSync(fd) } catch { /* 忽略 */ }
    }
  }

  async list (options = {}) {
    if (this._closed) return []
    await this.flush()
    const limit = Number(options.limit) > 0 ? Math.min(Math.floor(Number(options.limit)), 1000) : 100
    const offset = Number(options.offset) > 0 ? Math.floor(Number(options.offset)) : 0
    const lines = this._readTailLines()
    const rows = []
    for (const line of lines) {
      try { rows.push(JSON.parse(line)) } catch { /* 跳过损坏行 */ }
    }
    return rows.reverse().slice(offset, offset + limit)
  }

  /** 保留策略：把过老的行过滤掉后重写文件，返回删除条数 */
  async prune (retentionDays = this.retentionDays) {
    if (this._closed) return 0
    const days = Number(retentionDays)
    if (!days || days <= 0) return 0
    await this.flush()
    const lines = this._readTailLines()
    if (lines.length === 0) return 0
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const kept = []
    let removed = 0
    for (const line of lines) {
      let row
      try { row = JSON.parse(line) } catch { removed++; continue }
      const at = Date.parse(row.timestamp)
      if (Number.isFinite(at) && at < cutoff) removed++
      else kept.push(line)
    }
    if (removed > 0) {
      try { await fs.promises.writeFile(this.filePath, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8') }
      catch (e) { this.logger.warn?.('重写 JSONL 请求日志失败: ' + e.message) }
    }
    return removed
  }

  async close () {
    if (this._closed) return
    this._closed = true
    try { await this.flush() } catch { /* 忽略 */ }
  }
}

module.exports = { JsonlRequestLog, DEFAULT_MAX_READ_BYTES }
