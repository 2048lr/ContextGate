const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const {
  ResilienceGate, CircuitBreaker, ConcurrencyLimiter,
  parseRetryAfter, computeBackoff, shouldRetry, fallbackChainFor,
} = require('../lib/proxy/resilience')

// ---------------------------------------------------------------------------
// FIX-08 验收：429/5xx 指数退避重试（带 jitter、尊重 Retry-After）、provider fallback、
//            熔断、本地并发上限与队列、幂等键语义。
//   安全底线：没有幂等键的写请求默认不重试，避免上游重复计费。
// ---------------------------------------------------------------------------

function httpError(status, headers = {}, message = 'boom') {
  const err = new Error(message)
  err.response = { status, headers, data: { error: message } }
  return err
}

function netError(code) {
  const err = new Error(code)
  err.code = code
  return err
}

function recorder() {
  const delays = []
  return { delays, sleep: async ms => { delays.push(ms) } }
}

describe('FIX-08 重试判据', () => {
  it('429 / 503 属于「上游没处理」，即使没有幂等键也重试', () => {
    assert.equal(shouldRetry(httpError(429), { attempt: 0, maxRetries: 2, method: 'POST' }).retry, true)
    assert.equal(shouldRetry(httpError(503), { attempt: 0, maxRetries: 2, method: 'POST' }).retry, true)
  })

  it('500 对没有幂等键的写请求不重试（可能已经产生计费）', () => {
    const d = shouldRetry(httpError(500), { attempt: 0, maxRetries: 2, method: 'POST', hasIdempotencyKey: false })
    assert.equal(d.retry, false)
    assert.equal(d.reason, 'non_idempotent_write')
  })

  it('带幂等键时 500 可重试', () => {
    assert.equal(shouldRetry(httpError(500), { attempt: 0, maxRetries: 2, method: 'POST', hasIdempotencyKey: true }).retry, true)
  })

  it('GET 等幂等动词不受写请求限制', () => {
    assert.equal(shouldRetry(httpError(500), { attempt: 0, maxRetries: 2, method: 'GET' }).retry, true)
  })

  it('不重试 400/401/404', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      assert.equal(shouldRetry(httpError(status), { attempt: 0, maxRetries: 2, method: 'GET' }).retry, false, String(status))
    }
  })

  it('达到最大重试次数后不再重试', () => {
    assert.equal(shouldRetry(httpError(429), { attempt: 2, maxRetries: 2, method: 'GET' }).retry, false)
  })

  it('连接未建立（ECONNREFUSED）可以安全重试，ECONNRESET 对写请求不安全', () => {
    assert.equal(shouldRetry(netError('ECONNREFUSED'), { attempt: 0, maxRetries: 2, method: 'POST' }).retry, true)
    assert.equal(shouldRetry(netError('ECONNRESET'), { attempt: 0, maxRetries: 2, method: 'POST' }).retry, false)
    assert.equal(shouldRetry(netError('ECONNRESET'), { attempt: 0, maxRetries: 2, method: 'POST', hasIdempotencyKey: true }).retry, true)
  })

  it('客户端已中止时不重试', () => {
    assert.equal(shouldRetry(httpError(429), { attempt: 0, maxRetries: 3, aborted: true }).retry, false)
  })
})

describe('FIX-08 退避与 Retry-After', () => {
  it('parseRetryAfter 支持秒数与 HTTP 日期', () => {
    assert.equal(parseRetryAfter('2'), 2000)
    assert.ok(parseRetryAfter(new Date(Date.now() + 3000).toUTCString()) > 2000)
    assert.equal(parseRetryAfter(undefined), 0)
    assert.equal(parseRetryAfter('garbage'), 0)
  })

  it('Retry-After 优先于指数退避', () => {
    const d = computeBackoff(0, { baseDelayMs: 100, maxDelayMs: 8000, jitter: false, retryAfterMs: 5000 })
    assert.equal(d, 5000)
  })

  it('指数退避有上限，jitter 打开时落在 [1/2, 3/2) * 指数区间', () => {
    assert.equal(computeBackoff(10, { baseDelayMs: 100, maxDelayMs: 800, jitter: false }), 800)
    for (let i = 0; i < 20; i++) {
      const d = computeBackoff(1, { baseDelayMs: 500, maxDelayMs: 8000, jitter: true })
      assert.ok(d >= 500 && d < 1500, String(d)) // 1000/2 .. 1000*1.5
    }
  })
})

describe('FIX-08 熔断器', () => {
  it('连续失败达到阈值后打开，冷却后半开只放一个探针', () => {
    let now = 1000
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => now })
    assert.equal(cb.canRequest('openai').allowed, true)
    cb.recordFailure('openai', new Error('x'))
    assert.equal(cb.canRequest('openai').allowed, true)
    cb.recordFailure('openai', new Error('y'))
    assert.equal(cb.canRequest('openai').allowed, false)
    assert.equal(cb.canRequest('openai').state, 'open')
    now += 1001
    const probe = cb.canRequest('openai')
    assert.equal(probe.allowed, true)
    assert.equal(probe.state, 'half-open')
    // 半开状态下不允许第二个并发探针
    assert.equal(cb.canRequest('openai').allowed, false)
    cb.recordSuccess('openai')
    assert.equal(cb.canRequest('openai').allowed, true)
    assert.equal(cb.canRequest('openai').state, 'closed')
  })

  it('enabled:false 时始终放行', () => {
    const cb = new CircuitBreaker({ enabled: false, failureThreshold: 1 })
    cb.recordFailure('p', new Error('x'))
    assert.equal(cb.canRequest('p').allowed, true)
  })
})

describe('FIX-08 并发闸门', () => {
  it('超过并发上限且队列已满时快速失败', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 1, maxQueue: 0 })
    const first = await limiter.acquire()
    await assert.rejects(() => limiter.acquire(), e => e.code === 'CG_QUEUE_FULL')
    first.release()
    const again = await limiter.acquire()
    again.release()
  })

  it('排队超时返回 CG_QUEUE_TIMEOUT', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 1, maxQueue: 5, queueTimeoutMs: 20 })
    const held = await limiter.acquire()
    await assert.rejects(() => limiter.acquire(), e => e.code === 'CG_QUEUE_TIMEOUT')
    held.release()
  })

  // 回归：排队超时的 timer 曾经 unref()，于是当它是事件循环里最后一个 handle 时，
  // 进程会在 reject 之前就退出，acquire() 永远不 settle。必须放在子进程里验证：
  // 测试 runner 自己会撑住事件循环，同进程内测不出这个 bug。
  it('排队超时的 timer 不会被事件循环提前排空（子进程验证）', () => {
    const script = `
      const { ConcurrencyLimiter } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'proxy', 'resilience.js'))})
      ;(async () => {
        const limiter = new ConcurrencyLimiter({ maxConcurrency: 1, maxQueue: 5, queueTimeoutMs: 20 })
        const held = await limiter.acquire()
        try {
          await limiter.acquire()
          console.log('RESOLVED_UNEXPECTEDLY')
        } catch (e) {
          console.log('SETTLED:' + e.code)
        }
        held.release()
      })()
    `
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 })
    assert.match(out, /SETTLED:CG_QUEUE_TIMEOUT/, `子进程没有等到超时 reject，输出=${JSON.stringify(out)}`)
  })

  it('释放后槽位转交给排队者', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 1, maxQueue: 5, queueTimeoutMs: 1000 })
    const held = await limiter.acquire()
    const queued = limiter.acquire()
    assert.equal(limiter.stats().queued, 1)
    held.release()
    const slot = await queued
    assert.equal(limiter.stats().active, 1)
    slot.release()
    assert.equal(limiter.stats().active, 0)
    // completed 统计「已结束的逻辑请求数」：held 与转交后的 slot 各算一次
    assert.equal(limiter.stats().completed, 2)
  })
})

describe('FIX-08 ResilenceGate 端到端', () => {
  it('429 后重试成功，并尊重 Retry-After', async () => {
    const rec = recorder()
    const gate = new ResilienceGate({ config: { max_retries: 2, base_delay_ms: 10, jitter: false }, sleep: rec.sleep })
    let calls = 0
    const { result, attempts } = await gate.run({
      providerId: 'openai', method: 'POST', headers: {},
      attempt: async () => {
        calls++
        if (calls === 1) throw httpError(429, { 'retry-after': '3' })
        return { ok: true }
      },
    })
    assert.equal(result.ok, true)
    assert.equal(calls, 2)
    assert.ok(rec.delays[0] >= 3000)
    assert.ok(attempts.some(a => a.outcome === 'retry'))
    assert.equal(gate.snapshot().stats.retries, 1)
  })

  it('5xx 对写请求不重试，直接失败', async () => {
    const gate = new ResilienceGate({ config: { max_retries: 3 }, sleep: async () => {} })
    let calls = 0
    await assert.rejects(() => gate.run({
      providerId: 'openai', method: 'POST', headers: {},
      attempt: async () => { calls++; throw httpError(500) },
    }))
    assert.equal(calls, 1)
  })

  it('带 Idempotency-Key 时 500 会重试', async () => {
    const gate = new ResilienceGate({ config: { max_retries: 2 }, sleep: async () => {} })
    let calls = 0
    await gate.run({
      providerId: 'openai', method: 'POST', headers: { 'Idempotency-Key': 'k1' },
      attempt: async () => { calls++; if (calls < 2) throw httpError(500); return { ok: true } },
    })
    assert.equal(calls, 2)
  })

  it('第一个 provider 失败后按配置降级到下一个', async () => {
    const gate = new ResilienceGate({
      config: { max_retries: 0, fallback: { openai: ['deepseek'] } },
      sleep: async () => {},
    })
    const tried = []
    const { providerId, result } = await gate.run({
      providerId: 'openai', method: 'POST', headers: {},
      attempt: async ({ providerId: id }) => {
        tried.push(id)
        if (id === 'openai') throw httpError(400)
        return { from: id }
      },
    })
    assert.deepEqual(tried, ['openai', 'deepseek'])
    assert.equal(providerId, 'deepseek')
    assert.equal(result.from, 'deepseek')
    assert.equal(gate.snapshot().stats.fallbacks, 1)
  })

  it('降级链去重且保持顺序', () => {
    assert.deepEqual(fallbackChainFor('a', { fallback: { a: ['b', 'a', 'c', 'b'] } }), ['a', 'b', 'c'])
    assert.deepEqual(fallbackChainFor('x', {}), ['x'])
  })

  it('熔断打开后直接快速失败，不再打上游', async () => {
    const gate = new ResilienceGate({
      config: { max_retries: 0, circuit_breaker: { failure_threshold: 1, cooldown_ms: 60000 } },
      sleep: async () => {},
    })
    let calls = 0
    const attempt = async () => { calls++; throw httpError(400) }
    await assert.rejects(() => gate.run({ providerId: 'p', method: 'GET', attempt }))
    assert.equal(calls, 1)
    await assert.rejects(() => gate.run({ providerId: 'p', method: 'GET', attempt }), /Circuit breaker open/)
    assert.equal(calls, 1)
    assert.equal(gate.snapshot().stats.circuitRejections, 1)
  })

  it('流式请求不做重试（已开始产出就无法回退）', async () => {
    const gate = new ResilienceGate({ config: { max_retries: 5 }, sleep: async () => {} })
    let calls = 0
    await assert.rejects(() => gate.run({
      providerId: 'p', method: 'POST', headers: {}, stream: true,
      attempt: async () => { calls++; throw httpError(429) },
    }))
    assert.equal(calls, 1)
  })

  it('并发上限生效：同时只允许 N 个在飞', async () => {
    const gate = new ResilienceGate({ config: { max_retries: 0, max_concurrency: 2, max_queue: 10, queue_timeout_ms: 2000 } })
    let inFlight = 0
    let peak = 0
    const task = () => gate.run({
      providerId: 'p', method: 'GET',
      attempt: async () => {
        inFlight++; peak = Math.max(peak, inFlight)
        await new Promise(r => setTimeout(r, 20))
        inFlight--
        return { ok: true }
      },
    })
    await Promise.all([task(), task(), task(), task()])
    assert.ok(peak <= 2, 'peak=' + peak)
    assert.equal(gate.snapshot().limiter.completed, 4)
  })

  it('全部候选失败时抛出最后一次错误，并带上尝试轨迹', async () => {
    const gate = new ResilienceGate({ config: { max_retries: 0, fallback: { a: ['b'] } }, sleep: async () => {} })
    try {
      await gate.run({ providerId: 'a', method: 'GET', attempt: async ({ providerId: id }) => { throw httpError(400, {}, 'fail-' + id) } })
      assert.fail('应当抛错')
    } catch (e) {
      assert.match(e.message, /fail-b/)
      assert.equal(e.cg_attempts.length, 2)
    }
  })
})
