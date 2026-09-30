// FIX-15：大请求体的内存策略。
//
// 背景（P0-1 之后的遗留问题）：express.json({limit:'32mb'}) 虽然解除了 100KB 上限，
// 但它仍然会把整个请求体缓冲成 JS 字符串（UTF-16，通常是原始字节的 2 倍以上），
// 再叠加一层 Buffer，一个 8MB 的上下文请求可能占用 20MB+ 常驻内存。
//
// 这里做两件事：
//   1. 超过阈值的请求不解析、不缓存，直接把 socket 流式转发给上游（内存增量 ≈ 缓冲区大小）；
//   2. 用闸门限制「同时在途的大请求」数量，避免多个大请求同时驻留内存。

const DEFAULT_THRESHOLD_BYTES = 1024 * 1024
const DEFAULT_MAX_CONCURRENT = 2
const DEFAULT_MAX_QUEUE = 16
const DEFAULT_QUEUE_TIMEOUT_MS = 30000

const UNITS = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024, tb: 1024 * 1024 * 1024 * 1024 }

/**
 * 把 '32mb' / '1.5MB' / 1048576 这类写法统一成字节数。
 * 无法解析时返回 fallback（默认 0，表示不限制）。
 */
function parseByteSize (value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
  if (typeof value !== 'string') return fallback
  const text = value.trim().toLowerCase()
  if (!text) return fallback
  const m = text.match(/^(\d+(?:\.\d+)?)\s*([a-z]*)$/)
  if (!m) return fallback
  const n = Number(m[1])
  if (!Number.isFinite(n)) return fallback
  const unit = m[2] || 'b'
  const factor = UNITS[unit]
  if (!factor) return fallback
  return Math.floor(n * factor)
}

function positiveInt (value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

class LargeBodyBusyError extends Error {
  constructor (message = 'Too many large requests in flight') {
    super(message)
    this.name = 'LargeBodyBusyError'
    this.code = 'large_request_busy'
    this.status = 429
  }
}

/**
 * 大请求并发闸门。与小请求不同，大请求不重试（请求体是不可回放的流），
 * 因此这里只负责「限量 + 排队 + 超时」，不做重试。
 */
class LargeBodyGate {
  constructor (options = {}) {
    this.enabled = options.enabled !== false
    this.thresholdBytes = positiveInt(options.threshold_bytes, DEFAULT_THRESHOLD_BYTES)
    this.maxConcurrent = Math.max(1, positiveInt(options.max_concurrent, DEFAULT_MAX_CONCURRENT))
    this.maxQueue = positiveInt(options.max_queue, DEFAULT_MAX_QUEUE)
    this.queueTimeoutMs = positiveInt(options.queue_timeout_ms, DEFAULT_QUEUE_TIMEOUT_MS)
    this.active = 0
    this._queue = []
    this._peakActive = 0
    this._rejected = 0
  }

  /** 该请求体是否应该走「不解析、直接流式透传」的路径 */
  shouldStream (contentLength) {
    if (!this.enabled) return false
    const bytes = Number(contentLength)
    if (!Number.isFinite(bytes) || bytes < 0) return false
    return bytes > this.thresholdBytes
  }

  /** 闸门快照，供 /stats 与指标导出使用 */
  snapshot () {
    return {
      enabled: this.enabled,
      thresholdBytes: this.thresholdBytes,
      maxConcurrent: this.maxConcurrent,
      active: this.active,
      queued: this._queue.length,
      peakActive: this._peakActive,
      rejected: this._rejected,
      maxQueue: this.maxQueue,
      queueTimeoutMs: this.queueTimeoutMs,
    }
  }

  _acquire () {
    if (this.active < this.maxConcurrent) {
      this.active++
      if (this.active > this._peakActive) this._peakActive = this.active
      return Promise.resolve()
    }
    if (this._queue.length >= this.maxQueue) {
      this._rejected++
      return Promise.reject(new LargeBodyBusyError())
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null }
      if (this.queueTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const idx = this._queue.indexOf(waiter)
          if (idx !== -1) this._queue.splice(idx, 1)
          this._rejected++
          reject(new LargeBodyBusyError('Timed out waiting for a large-request slot'))
        }, this.queueTimeoutMs)
        if (typeof waiter.timer.unref === 'function') waiter.timer.unref()
      }
      this._queue.push(waiter)
    })
  }

  _release () {
    const next = this._queue.shift()
    if (next) {
      if (next.timer) clearTimeout(next.timer)
      // 直接把名额交给排队者，active 计数不变
      next.resolve()
      return
    }
    this.active = Math.max(0, this.active - 1)
  }

  /** 在闸门内执行 task；无论成功失败都会释放名额 */
  async run (task) {
    if (typeof task !== 'function') throw new TypeError('LargeBodyGate.run requires a function')
    await this._acquire()
    try {
      return await task()
    } finally {
      this._release()
    }
  }
}

module.exports = {
  LargeBodyGate,
  LargeBodyBusyError,
  parseByteSize,
  DEFAULT_THRESHOLD_BYTES,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_QUEUE,
  DEFAULT_QUEUE_TIMEOUT_MS,
}
