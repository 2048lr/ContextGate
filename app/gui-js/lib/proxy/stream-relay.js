// FIX-07：流式可靠性
//
// 原实现（router.js:193-249）的问题：
//   - 没有 AbortController，用户取消请求后上游仍继续生成并计费；
//   - 不监听 req 'close'，客户端断开后代理仍把整个流读进内存；
//   - 上游 error 时若已发 header 就静默 res.end()，客户端只看到被截断的 HTTP 200，
//     无法区分「回答结束」与「连接中断」；
//   - 没有空闲超时，上游半开连接会永久挂住一个请求槽。
//
// 本模块把「HTTP 头 + 中转 + 计时 + 中止 + 错误表达」收敛成一处，
// 保证任何异常路径都留下可识别的信号，而不是静默 200。

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'Connection': 'keep-alive',
  // 让 Nginx / 中间代理不要缓冲 SSE
  'X-Accel-Buffering': 'no',
}

function writeSSEError(res, message, code = 'stream_interrupted') {
  if (res.writableEnded || res.destroyed) return
  const payload = JSON.stringify({ error: { message, type: 'api_error', code } })
  try {
    res.write(`event: error\ndata: ${payload}\n\n`)
    // 同时给出一个标准 data 帧 + [DONE]，让只解析 data 的 OpenAI SDK 也能识别失败
    res.write(`data: ${payload}\n\n`)
    res.write('data: [DONE]\n\n')
  } catch { /* 对端已断开，忽略 */ }
}

function writeSSEComment(res, text) {
  if (res.writableEnded || res.destroyed) return
  try { res.write(`: ${text}\n\n`) } catch { /* 忽略 */ }
}

/**
 * 中转一个上游 SSE 流。
 *
 * @param {object} opts
 * @param {import('http').ServerResponse} opts.res 下游响应（客户端断开的唯一可靠信号）
 *   注意：不要用 req 的 'close' 判断断开——它在请求体读完时就会触发，会把正常请求当场杀掉。
 * @param {import('stream').Readable} opts.upstream 上游响应流（axios response.data）
 * @param {AbortController} opts.controller 用于中止上游
 * @param {number} [opts.idleTimeoutMs] 两个 chunk 之间的最大间隔
 * @param {number} [opts.totalTimeoutMs] 整个流的最大时长（0 = 不限）
 * @param {number} [opts.maxCollectBytes] 最多保留多少字节用于 usage/缓存解析
 * @param {(chunks:Buffer[], collected:Buffer)=>void} [opts.onComplete] 正常结束（含被中止）
 * @param {(err:Error)=>void} [opts.onError] 异常结束
 * @param {(info:object)=>void} [opts.onAbort] 被中止（超时 / 客户端断开）
 * @param {object} [opts.logger]
 * @returns {{ promise: Promise<object>, abort: (reason:string)=>void }}
 */
function relayStream(opts) {
  const {
    res, upstream, controller,
    idleTimeoutMs = 60000,
    totalTimeoutMs = 0,
    maxCollectBytes = 8 * 1024 * 1024,
    onComplete, onError, onAbort, logger,
  } = opts || {}

  const log = logger || console
  const chunks = []
  let collectedBytes = 0
  let idleTimer = null
  let totalTimer = null
  let settled = false
  let aborted = false
  let abortReason = null
  let clientGone = false

  let resolvePromise
  const promise = new Promise(resolve => { resolvePromise = resolve })

  function clearTimers() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    if (totalTimer) { clearTimeout(totalTimer); totalTimer = null }
  }

  function abortUpstream(reason) {
    if (aborted) return
    aborted = true
    abortReason = reason
    clearTimers()
    try { controller?.abort(new Error(reason)) } catch { /* 已中止 */ }
    // 直接销毁上游流，确保 socket 立即关闭（axios 的 abort 是异步的）
    try { upstream?.destroy?.(new Error(reason)) } catch { /* 忽略 */ }
    try { onAbort?.({ reason, clientGone }) } catch (e) { log.warn?.('[stream] onAbort 回调异常:', e.message) }
  }

  function settle(kind, payload) {
    if (settled) return
    settled = true
    clearTimers()
    detach()
    const collected = Buffer.concat(chunks)
    if (kind === 'complete') {
      try { onComplete?.(chunks, collected) } catch (e) { log.warn?.('[stream] onComplete 回调异常:', e.message) }
    } else if (kind === 'error') {
      try { onError?.(payload) } catch (e) { log.warn?.('[stream] onError 回调异常:', e.message) }
    }
    resolvePromise({ kind, aborted, abortReason, clientGone, bytes: collectedBytes })
  }

  function refreshIdleTimer() {
    if (!idleTimeoutMs || idleTimeoutMs <= 0) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      log.warn?.(`[stream] 上游 ${idleTimeoutMs}ms 无数据，判定为半开连接并中止`)
      abortUpstream('upstream_idle_timeout')
      writeSSEError(res, `Upstream produced no data for ${idleTimeoutMs}ms; the stream was aborted.`, 'upstream_idle_timeout')
      try { res.end() } catch { /* 忽略 */ }
      settle('aborted')
    }, idleTimeoutMs)
    if (idleTimer.unref) idleTimer.unref()
  }

  function handleUpstreamData(chunk) {
    refreshIdleTimer()
    if (collectedBytes < maxCollectBytes) {
      chunks.push(chunk)
      collectedBytes += chunk.length || chunk.byteLength || 0
    }
    if (!res.writableEnded && !res.destroyed) {
      try { res.write(chunk) } catch { /* 对端已断开，close 事件会收尾 */ }
    }
  }

  function handleUpstreamEnd() {
    if (aborted) return settle('aborted')
    try { if (!res.writableEnded && !res.destroyed) res.end() } catch { /* 忽略 */ }
    settle('complete')
  }

  function handleUpstreamError(err) {
    if (aborted) return settle('aborted')
    log.warn?.('[stream] 上游流出错:', err?.message)
    if (res.headersSent) {
      // 关键修复：不再静默 200。用 SSE error 帧显式告诉客户端「这个回答不完整」。
      writeSSEError(res, `Upstream stream error: ${err?.message || 'unknown'}`, 'upstream_stream_error')
      try { res.end() } catch { /* 忽略 */ }
    }
    settle('error', err)
  }

  function handleClientClose() {
    if (settled) return
    // 注意（实测坑）：IncomingMessage 的 'close' 在「请求体读完」时就会触发，
    // 那时 res.writableFinished 还是 false，用它当中断信号会把所有流式请求当场杀掉。
    // 正确的中断信号是 ServerResponse 的 'close' 且 writableFinished === false。
    if (res.writableFinished) return
    clientGone = true
    log.warn?.('[stream] 客户端已断开，中止上游以停止计费')
    abortUpstream('client_disconnected')
    settle('aborted')
  }

  function handleUpstreamClose() {
    // 上游被提前销毁（socket 关闭）且还没走到 end/error
    if (settled) return
    if (!res.writableEnded && res.headersSent) {
      writeSSEError(res, 'Upstream connection closed before the stream completed.', 'upstream_closed')
      try { res.end() } catch { /* 忽略 */ }
    }
    settle('error', new Error('upstream_closed'))
  }

  function detach() {
    try { upstream?.off?.('data', handleUpstreamData) } catch { /* 忽略 */ }
    try { upstream?.off?.('end', handleUpstreamEnd) } catch { /* 忽略 */ }
    try { upstream?.off?.('error', handleUpstreamError) } catch { /* 忽略 */ }
    try { upstream?.off?.('close', handleUpstreamClose) } catch { /* 忽略 */ }
    try { res?.off?.('close', handleClientClose) } catch { /* 忽略 */ }
  }

  upstream.on('data', handleUpstreamData)
  upstream.on('end', handleUpstreamEnd)
  upstream.on('error', handleUpstreamError)
  upstream.on('close', handleUpstreamClose)
  // 只在「响应未写完就 close」时才算客户端断开（见 handleClientClose 的注释）
  res?.on?.('close', handleClientClose)

  if (totalTimeoutMs > 0) {
    totalTimer = setTimeout(() => {
      log.warn?.(`[stream] 流式请求超过总时长 ${totalTimeoutMs}ms，中止`)
      abortUpstream('stream_total_timeout')
      writeSSEError(res, `Stream exceeded the total timeout of ${totalTimeoutMs}ms.`, 'stream_total_timeout')
      try { res.end() } catch { /* 忽略 */ }
      settle('aborted')
    }, totalTimeoutMs)
    if (totalTimer.unref) totalTimer.unref()
  }
  refreshIdleTimer()

  return {
    promise,
    abort: abortUpstream,
    isAborted: () => aborted,
    isClientGone: () => clientGone,
  }
}

/** 写出 SSE 响应头（幂等；headersSent 后直接返回 false） */
function writeStreamHeaders(res, extra = {}) {
  if (res.headersSent) return false
  try {
    res.writeHead(200, { ...SSE_HEADERS, ...extra })
    // 长连接不应被 Node 默认的 socket 超时打断
    try { res.socket?.setTimeout?.(0) } catch { /* 忽略 */ }
    try { res.socket?.setNoDelay?.(true) } catch { /* 忽略 */ }
    return true
  } catch { return false }
}

module.exports = { relayStream, writeStreamHeaders, writeSSEError, writeSSEComment, SSE_HEADERS }
