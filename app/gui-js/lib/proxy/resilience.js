// FIX-08：重试 / 降级 / 限流
//
// 原实现（forwarder.js:72-88）只对 ECONNRESET/ETIMEDOUT/EPIPE/ECONNABORTED 重试 2 次：
//   - 429 / 5xx 完全不重试，直接透传给用户；
//   - 没有 jitter、不尊重 Retry-After；
//   - 没有 provider fallback、没有熔断；
//   - 没有并发上限，上游被打爆时代理只会一起雪崩；
//   - POST 无条件重试还可能让上游重复计费（没有幂等键概念）。
//
// 设计要点（安全优先）：
//   * 「可以安全重试」的判据是：上游明确表示没处理（429 / 503 / 连接未建立）,
//     或者客户端提供了幂等键（Idempotency-Key）。否则默认不重试 POST，
//     避免重复计费——宁可把错误抛给用户，也不要悄悄扣两次钱。

const SAFE_NETWORK_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']
const UNSAFE_NETWORK_CODES = ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED', 'ERR_CANCELED']
// 这两个状态码表示「上游没有处理该请求」，重试不会产生重复计费
const ALWAYS_SAFE_STATUS = [429, 503]

function parseRetryAfter(value) {
  if (value === undefined || value === null || value === '') return 0
  const raw = String(value).trim()
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 120000)
  const date = Date.parse(raw)
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 120000))
  return 0
}

function computeBackoff(attempt, { baseDelayMs = 500, maxDelayMs = 8000, jitter = true, retryAfterMs = 0 } = {}) {
  const exponential = Math.min(baseDelayMs * Math.pow(2, Math.max(0, attempt)), maxDelayMs)
  if (retryAfterMs > 0) return Math.max(retryAfterMs, exponential)
  if (!jitter) return exponential
  // full jitter：避免所有客户端在同一时刻一起重试（thundering herd）
  return Math.floor(Math.random() * exponential) + Math.floor(exponential / 2)
}

function statusOf(error) {
  return Number(error?.response?.status) || 0
}

/**
 * 判断一次失败是否值得重试。
 * @returns {{retry:boolean, reason:string}}
 */
function shouldRetry(error, ctx) {
  const {
    attempt = 0, maxRetries = 2, retryStatuses = [429, 500, 502, 503, 504],
    method = 'POST', hasIdempotencyKey = false, retryNonIdempotent = false,
    aborted = false,
  } = ctx || {}

  if (aborted || error?.code === 'ERR_CANCELED') return { retry: false, reason: 'aborted' }
  if (attempt >= maxRetries) return { retry: false, reason: 'max_retries_reached' }

  const status = statusOf(error)
  const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method).toUpperCase())
  const safeToReplay = !isWrite || hasIdempotencyKey || retryNonIdempotent

  if (status > 0) {
    if (!retryStatuses.includes(status)) return { retry: false, reason: `status_${status}_not_retryable` }
    if (!safeToReplay && !ALWAYS_SAFE_STATUS.includes(status)) {
      return { retry: false, reason: 'non_idempotent_write' }
    }
    return { retry: true, reason: `status_${status}` }
  }

  const code = String(error?.code || '')
  if (SAFE_NETWORK_CODES.includes(code)) return { retry: true, reason: code }
  if (UNSAFE_NETWORK_CODES.includes(code)) {
    return safeToReplay ? { retry: true, reason: code } : { retry: false, reason: 'non_idempotent_network_error' }
  }
  return { retry: false, reason: code || 'unknown_error' }
}

/**
 * 每个 provider 一个熔断器。连续失败达到阈值后进入 open，冷却期内直接快速失败，
 * 冷却结束后放一个探针（half-open），成功则恢复。
 */
class CircuitBreaker {
  constructor({ enabled = true, failureThreshold = 5, cooldownMs = 30000, now = () => Date.now() } = {}) {
    this.enabled = enabled !== false
    this.failureThreshold = failureThreshold
    this.cooldownMs = cooldownMs
    this.now = now
    this.states = new Map()
  }

  _entry(key) {
    let e = this.states.get(key)
    if (!e) {
      e = { failures: 0, openedAt: 0, halfOpenInFlight: false, lastError: null, successes: 0 }
      this.states.set(key, e)
    }
    return e
  }

  /** @returns {{allowed:boolean, state:string, retryAfterMs:number}} */
  canRequest(key) {
    if (!this.enabled) return { allowed: true, state: 'disabled', retryAfterMs: 0 }
    const e = this._entry(key)
    if (e.failures < this.failureThreshold) return { allowed: true, state: 'closed', retryAfterMs: 0 }
    const elapsed = this.now() - e.openedAt
    if (elapsed >= this.cooldownMs) {
      if (e.halfOpenInFlight) return { allowed: false, state: 'half-open', retryAfterMs: Math.max(0, this.cooldownMs - elapsed) }
      e.halfOpenInFlight = true
      return { allowed: true, state: 'half-open', retryAfterMs: 0 }
    }
    return { allowed: false, state: 'open', retryAfterMs: Math.max(0, this.cooldownMs - elapsed) }
  }

  recordSuccess(key) {
    const e = this._entry(key)
    e.failures = 0
    e.halfOpenInFlight = false
    e.lastError = null
    e.successes++
  }

  recordFailure(key, error) {
    const e = this._entry(key)
    e.halfOpenInFlight = false
    e.failures++
    e.lastError = error?.message || String(error || '')
    e.openedAt = this.now()
  }

  snapshot() {
    const out = {}
    for (const [key, e] of this.states) {
      out[key] = {
        failures: e.failures,
        open: e.failures >= this.failureThreshold,
        lastError: e.lastError,
      }
    }
    return out
  }

  reset(key) { if (key) this.states.delete(key); else this.states.clear() }
}

/**
 * 进程内并发闸门：限制同时在飞的上游请求数，超出的排队；
 * 队列满或等待超时则快速失败（返回可读错误，而不是无限堆积）。
 */
class ConcurrencyLimiter {
  constructor({ maxConcurrency = 32, maxQueue = 64, queueTimeoutMs = 30000, now = () => Date.now() } = {}) {
    this.maxConcurrency = Math.max(1, Number(maxConcurrency) || 32)
    this.maxQueue = Math.max(0, Number(maxQueue) || 0)
    this.queueTimeoutMs = Number(queueTimeoutMs) || 0
    this.now = now
    this.active = 0
    this.queue = []
    this.rejected = 0
    this.completed = 0
  }

  get pending() { return this.queue.length }

  /** @returns {Promise<{release:Function}>} */
  acquire(meta = {}) {
    if (this.active < this.maxConcurrency) {
      this.active++
      return Promise.resolve({ release: () => this._release() })
    }
    if (this.queue.length >= this.maxQueue) {
      this.rejected++
      const err = new Error('Proxy concurrency limit reached; try again later.')
      err.code = 'CG_QUEUE_FULL'
      err.status = 503
      return Promise.reject(err)
    }
    return new Promise((resolve, reject) => {
      const entry = { meta, resolve, reject, enqueuedAt: this.now(), timer: null }
      if (this.queueTimeoutMs > 0) {
        entry.timer = setTimeout(() => {
          const idx = this.queue.indexOf(entry)
          if (idx >= 0) this.queue.splice(idx, 1)
          this.rejected++
          const err = new Error(`Queued longer than ${this.queueTimeoutMs}ms while waiting for a proxy slot.`)
          err.code = 'CG_QUEUE_TIMEOUT'
          err.status = 503
          reject(err)
        }, this.queueTimeoutMs)
        if (entry.timer.unref) entry.timer.unref()
      }
      this.queue.push(entry)
    })
  }

  _release() {
    // completed 统计「已结束的逻辑请求数」，无论槽位是转交给排队者还是真正归还
    this.completed++
    const next = this.queue.shift()
    if (next) {
      if (next.timer) clearTimeout(next.timer)
      // 槽位直接转交，不递减 active
      next.resolve({ release: () => this._release() })
      return
    }
    this.active = Math.max(0, this.active - 1)
  }

  stats() { return { active: this.active, queued: this.queue.length, maxConcurrency: this.maxConcurrency, maxQueue: this.maxQueue, rejected: this.rejected, completed: this.completed } }
}

/** 降级链：[发起方, ...配置里的 fallback]，去重且保持顺序 */
function fallbackChainFor(providerId, config = {}) {
  const map = config.fallback || {}
  const list = Array.isArray(map[providerId]) ? map[providerId] : []
  const chain = [providerId]
  for (const id of list) {
    if (typeof id === 'string' && id && !chain.includes(id)) chain.push(id)
  }
  return chain
}

function isRetryableStatusList(value) {
  return Array.isArray(value) && value.length > 0 ? value.map(Number).filter(Number.isFinite) : null
}

/**
 * 把「重试 + 熔断 + 降级 + 并发」组合成一个入口。
 * 调用方只需给出候选 provider 链与一个「打一次」的函数。
 */
class ResilienceGate {
  constructor(options = {}) {
    const cfg = options.config || {}
    this.config = {
      maxRetries: cfg.max_retries ?? 2,
      retryStatuses: isRetryableStatusList(cfg.retry_statuses) || [429, 500, 502, 503, 504],
      baseDelayMs: cfg.base_delay_ms ?? 500,
      maxDelayMs: cfg.max_delay_ms ?? 8000,
      jitter: cfg.jitter !== false,
      respectRetryAfter: cfg.respect_retry_after !== false,
      retryNonIdempotent: cfg.retry_non_idempotent === true,
      idempotencyHeader: cfg.idempotency_header || 'Idempotency-Key',
      fallback: cfg.fallback || {},
    }
    const cb = cfg.circuit_breaker || {}
    this.breaker = new CircuitBreaker({ enabled: cb.enabled !== false, failureThreshold: cb.failure_threshold, cooldownMs: cb.cooldown_ms })
    this.limiter = new ConcurrencyLimiter({
      maxConcurrency: cfg.max_concurrency, maxQueue: cfg.max_queue, queueTimeoutMs: cfg.queue_timeout_ms,
    })
    this.logger = options.logger || console
    this.sleep = options.sleep || (ms => new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref() }))
    this.now = options.now || (() => Date.now())
    this.stats = { retries: 0, fallbacks: 0, circuitRejections: 0, attempts: 0 }
  }

  chainFor(providerId) { return fallbackChainFor(providerId, this.config) }

  circuitState(providerId) { return this.breaker.canRequest(providerId) }

  snapshot() {
    return {
      limiter: this.limiter.stats(),
      circuits: this.breaker.snapshot(),
      stats: { ...this.stats },
      policy: {
        maxRetries: this.config.maxRetries,
        retryStatuses: this.config.retryStatuses,
        retryNonIdempotent: this.config.retryNonIdempotent,
        jitter: this.config.jitter,
        respectRetryAfter: this.config.respectRetryAfter,
      },
    }
  }

  setFallbackMap(map) { this.config.fallback = map || {} }

  /**
   * @param {object} opts
   * @param {string} opts.providerId 起始 provider
   * @param {(candidate:{providerId:string}) => Promise<any>} opts.attempt 打一次上游
   * @param {(providerId:string) => string[]} [opts.resolveChain] 自定义降级链
   * @param {string} [opts.method]
   * @param {object} [opts.headers]
   * @param {boolean} [opts.stream] 流式请求不做重试（已开始产出就无法回退）
   * @returns {Promise<{result:any, providerId:string, attempts:object[]}>}
   */
  async run(opts) {
    const {
      providerId, attempt, resolveChain, method = 'POST',
      headers = {}, stream = false, onFallback,
    } = opts
    const chain = (resolveChain ? resolveChain(providerId) : this.chainFor(providerId)).slice()
    const lower = Object.keys(headers || {}).map(k => k.toLowerCase())
    const hasIdempotencyKey = lower.includes(String(this.config.idempotencyHeader).toLowerCase())
    const attempts = []
    const deadline = this.now() + 10 * 60 * 1000

    const slot = await this.limiter.acquire({ providerId })
    try {
      let lastError = null
      for (let ci = 0; ci < chain.length; ci++) {
        const candidateId = chain[ci]
        const circuit = this.breaker.canRequest(candidateId)
        if (!circuit.allowed) {
          this.stats.circuitRejections++
          attempts.push({ providerId: candidateId, outcome: 'circuit_open', retryAfterMs: circuit.retryAfterMs })
          const err = new Error(`Circuit breaker open for provider "${candidateId}"`)
          err.code = 'CG_CIRCUIT_OPEN'
          err.status = 503
          lastError = err
          continue
        }
        // 流式请求一旦开始输出就无法安全重试，因此只允许「打一次」
        const maxRetries = stream ? 0 : this.config.maxRetries
        for (let attemptNo = 0; attemptNo <= maxRetries; attemptNo++) {
          this.stats.attempts++
          try {
            const result = await attempt({ providerId: candidateId })
            this.breaker.recordSuccess(candidateId)
            attempts.push({ providerId: candidateId, outcome: 'success', attempt: attemptNo })
            if (ci > 0) this.stats.fallbacks++
            return { result, providerId: candidateId, attempts }
          } catch (error) {
            lastError = error
            const decision = shouldRetry(error, {
              attempt: attemptNo, maxRetries, retryStatuses: this.config.retryStatuses,
              method, hasIdempotencyKey, retryNonIdempotent: this.config.retryNonIdempotent,
              aborted: opts.isAborted ? opts.isAborted() : false,
            })
            attempts.push({
              providerId: candidateId, outcome: decision.retry ? 'retry' : 'failed',
              attempt: attemptNo, reason: decision.reason, status: statusOf(error) || undefined,
              error: error?.message,
            })
            if (!decision.retry) break
            const retryAfterMs = this.config.respectRetryAfter
              ? parseRetryAfter(error?.response?.headers?.['retry-after'])
              : 0
            let delay = computeBackoff(attemptNo, {
              baseDelayMs: this.config.baseDelayMs, maxDelayMs: this.config.maxDelayMs,
              jitter: this.config.jitter, retryAfterMs,
            })
            if (this.now() + delay > deadline) { delay = Math.max(0, deadline - this.now()) }
            this.stats.retries++
            this.logger.warn?.(`[resilience] ${candidateId} 第 ${attemptNo + 1} 次失败（${decision.reason}），${delay}ms 后重试`)
            await this.sleep(delay)
          }
        }
        this.breaker.recordFailure(candidateId, lastError)
        if (ci < chain.length - 1) {
          try { onFallback?.({ from: candidateId, to: chain[ci + 1], error: lastError }) } catch { /* 忽略 */ }
        }
      }
      lastError = lastError || new Error('All upstream attempts failed')
      lastError.cg_attempts = attempts
      throw lastError
    } finally {
      slot.release()
    }
  }
}

module.exports = {
  ResilienceGate, CircuitBreaker, ConcurrencyLimiter,
  parseRetryAfter, computeBackoff, shouldRetry, fallbackChainFor,
  SAFE_NETWORK_CODES, UNSAFE_NETWORK_CODES, ALWAYS_SAFE_STATUS,
}
