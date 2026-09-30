const express = require('express')
const { VERSION, DEFAULT_MAX_BODY_SIZE } = require('../core/constants')
const {
  resolveApiKey, axiosRetry, buildAxiosConfig, buildForwardHeaders, sendUpstream,
  joinUrl, getSecurityPolicy,
} = require('./forwarder')
const { extractMsgPreview, parseSSEChunks, serializeSSEEvents } = require('./stream-handler')
const { computeUsageCost } = require('../monitor/cost-calculator')
const usageTools = require('./usage')
const protocol = require('./protocol')
const { relayStream, writeStreamHeaders, writeSSEError } = require('./stream-relay')
const { ResilienceGate } = require('./resilience')
const { applyPromptCache, promptCacheMetrics, PromptCacheStats } = require('./prompt-cache')
const { LargeBodyGate, LargeBodyBusyError, parseByteSize } = require('./large-body')
const { buildMetrics, PROMETHEUS_CONTENT_TYPE } = require('../monitor/metrics')
const exportTools = require('../monitor/export')

const JSON_CONTENT_TYPES = ['application/json', 'application/*+json', 'text/json']

function openaiError(message, type = 'invalid_request_error', code = null, param = null) {
  return { error: { message, type, code, param } }
}

// 客户端把「本地令牌」放进 Authorization / x-api-key 是推荐用法；它绝不能又被当成上游 Key
// 转发出去（passthrough_auth 场景下会发生这种串味）。
function isLocalTokenValue(value, localToken) {
  if (typeof value !== 'string' || !value || !localToken) return false
  const presented = value.replace(/^Bearer\s+/i, '').trim()
  return presented === localToken
}

function upstreamAuthHeader(req, localToken) {
  const raw = req.headers?.authorization
  if (typeof raw !== 'string' || !raw) return undefined
  return isLocalTokenValue(raw, localToken) ? undefined : raw
}

function upstreamApiKeyHeader(req, localToken) {
  const raw = req.headers?.['x-api-key']
  if (typeof raw !== 'string' || !raw) return undefined
  return isLocalTokenValue(raw, localToken) ? undefined : raw
}

function upstreamHeaders(req, localToken) {
  const headers = { ...req.headers, authorization: upstreamAuthHeader(req, localToken) }
  const apiKey = upstreamApiKeyHeader(req, localToken)
  if (apiKey === undefined) delete headers['x-api-key']
  else headers['x-api-key'] = apiKey
  return headers
}

// FIX-02：X-Target-Base-Url 允许客户端指定转发目标（用于获取模型列表）。
// 这里做 scheme / 凭据 / 片段校验，且该入口已受本地令牌保护。
function validateTargetBaseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'X-Target-Base-Url must be a non-empty string' }
  let url
  try { url = new URL(raw.trim()) } catch { return { ok: false, error: 'X-Target-Base-Url is not a valid URL' } }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'X-Target-Base-Url must use http or https' }
  if (url.username || url.password) return { ok: false, error: 'X-Target-Base-Url must not embed credentials' }
  if (url.hash) return { ok: false, error: 'X-Target-Base-Url must not contain a fragment' }
  return { ok: true, url: url.toString().replace(/\/+$/, '') }
}

/**
 * FIX-07：客户端断开时中止上游。
 * 不能监听 req 的 'close'——实测它在「请求体读完」时就会触发（此时响应还没写完），
 * 会把所有请求当场中止。只有 res 的 'close' 且 writableFinished === false 才代表
 * 客户端真的断开了。
 */
function attachClientAbort(req, res) {
  const controller = new AbortController()
  const onClose = () => { if (!res.writableFinished) controller.abort(new Error('client_disconnected')) }
  res.on('close', onClose)
  return {
    controller,
    dispose: () => { try { res.off('close', onClose) } catch { /* 忽略 */ } },
  }
}

function createRoutes(app, svc) {
  const { cacheManager, configManager, providerRegistry, eventBus } = svc
  const proxyConfig = configManager.getProxyConfig()
  const maxBodySize = proxyConfig.max_body_size || DEFAULT_MAX_BODY_SIZE
  const allowTargetBaseUrl = configManager.get('proxy.auth.allow_target_base_url') !== false
  const promptCacheConfig = configManager.getPromptCacheConfig()
  const protocolConfig = configManager.getProtocolConfig()
  const resilience = svc.resilience || new ResilienceGate({ config: configManager.getResilienceConfig() })
  const promptCacheStats = svc.promptCacheStats || new PromptCacheStats()
  const requestLog = svc.requestLog || null
  const observabilityConfig = configManager.getObservabilityConfig()

  // FIX-11：按内容类型分流 body 解析。
  // multipart / 二进制（audio、files、images/edits）必须原样透传，
  // 走 express.json 会被解析失败或被改写成 JSON 字符串。
  const jsonParser = express.json({ limit: maxBodySize, type: JSON_CONTENT_TYPES })
  const rawParser = express.raw({ limit: maxBodySize, type: () => true })
  // FIX-15：超过阈值的大请求不走 body parser，直接以 socket 流透传。
  // express.json 会把整个请求体缓冲成 JS 字符串（UTF-16），一个 8MB 的上下文请求
  // 往往占用 20MB+ 内存；流式透传把这个开销降到与 socket 缓冲区同量级。
  const largeBodyConfig = configManager.getLargeBodyConfig()
  const largeBodyGate = svc.largeBodyGate || new LargeBodyGate(largeBodyConfig)
  const maxBodyBytes = parseByteSize(maxBodySize, 32 * 1024 * 1024)
  app.use((req, res, next) => {
    const method = String(req.method || '').toUpperCase()
    if (method === 'GET' || method === 'HEAD' || method === 'DELETE' || method === 'OPTIONS') return next()
    const declared = Number(req.headers['content-length'])
    if (largeBodyGate.shouldStream(declared)) {
      req._largeBody = { bytes: declared }
      return next()
    }
    if (protocol.isRawBodyRequest(req)) return rawParser(req, res, next)
    return jsonParser(req, res, next)
  })
  app.use((req, _res, next) => { console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`); next() })

  function resolveCandidate(providerId) {
    return providerRegistry.resolveProvider(providerId, configManager.getProvider(providerId))
  }

  function costFor(providerId, model, usageNorm) {
    return computeUsageCost(model, usageNorm, {
      providerId,
      modelsDevData: providerRegistry?.modelsDevData,
    })
  }

  /** 记录请求级脱敏日志（FIX-12），失败不影响主流程（RequestLog 的写接口是异步的） */
  function logRequest(entry) {
    if (!requestLog) return
    try {
      const r = requestLog.record(entry)
      if (r && typeof r.catch === 'function') r.catch(e => console.warn('[router] 请求日志写入失败:', e.message))
    } catch (e) { console.warn('[router] 请求日志写入失败:', e.message) }
  }

  /** 把 usage + 成本 + Prompt Caching 指标汇总后一次性上报 */
  function reportCompletion({ providerId, model, usageNorm, priced, promptCacheMeta, cached, responseTime, path, method, backendUrl, requestSize, msgPreview, status }) {
    const cacheMetrics = usageNorm ? promptCacheMetrics(usageNorm, priced?.pricing) : null
    if (promptCacheMeta || cacheMetrics) promptCacheStats.record(cacheMetrics, promptCacheMeta)
    eventBus.emit('request:complete', {
      provider: providerId, model,
      input_tokens: usageNorm?.prompt_tokens || 0, output_tokens: usageNorm?.completion_tokens || 0,
      cached_tokens: usageNorm?.cached_tokens || 0, cache_write_tokens: usageNorm?.cache_write_tokens || 0,
      cost: priced?.cost || 0, saved_cost: priced?.savedCost || 0,
      pricing_known: priced?.known !== false, pricing_source: priced?.source,
      cached: !!cached, response_time: responseTime || 0,
    })
    eventBus.emit('request:log', {
      type: 'response', method, path, provider: providerId, model, backendUrl,
      requestSize, messagePreview: msgPreview,
      tokens: {
        prompt: usageNorm?.prompt_tokens || 0, completion: usageNorm?.completion_tokens || 0,
        total: usageNorm?.total_tokens || 0, cached: usageNorm?.cached_tokens || 0,
        cacheWrite: usageNorm?.cache_write_tokens || 0,
      },
      cost: priced?.cost || 0, savedCost: priced?.savedCost || 0, pricingKnown: priced?.known !== false,
      promptCache: promptCacheMeta || undefined,
      cached: !!cached, status: status || 200, responseTime: responseTime || 0,
    })
    logRequest({
      provider: providerId, model, method, path, status: status || 200, cached: !!cached,
      responseTime: responseTime || 0,
      inputTokens: usageNorm?.prompt_tokens || 0, outputTokens: usageNorm?.completion_tokens || 0,
      cost: priced?.cost || 0, messagePreview: msgPreview,
    })
  }

  // FIX-04：预算硬约束（只有显式 enforce_budget 时才会拒绝请求）
  function budgetAllows(req, res, routeMeta) {
    const guard = svc.budgetGuard
    if (!guard) return true
    let state
    try { state = guard.check() } catch { return true }
    if (state.allowed) return true
    eventBus.emit('request:log', {
      type: 'error', method: req.method, path: req.path, provider: routeMeta?.provider || '',
      model: routeMeta?.model || '', error: state.reason, status: 402, responseTime: 0,
    })
    res.status(402).json(openaiError(state.reason, 'insufficient_quota', 'budget_exceeded'))
    return false
  }

  /**
   * FIX-15：大请求体透传。
   * 大请求不解析、不缓存、不做 prompt-cache 注入（这些都需要完整 body），
   * 但保留鉴权、预算、provider 解析与响应字节的透明转发。
   */
  async function handleLargeBodyPassthrough(req, res, route, reqStart) {
    const declared = req._largeBody?.bytes || 0
    if (maxBodyBytes > 0 && declared > maxBodyBytes) {
      try { req.resume() } catch { /* 忽略 */ }
      eventBus.emit('request:log', {
        type: 'error', method: req.method, path: req.path, provider: '', model: '',
        error: `请求体 ${declared} 字节超过上限 ${maxBodySize}`, status: 413, responseTime: Date.now() - reqStart,
      })
      return res.status(413).json(openaiError(
        `Request body exceeds the configured limit (${maxBodySize})`,
        'invalid_request_error', 'request_too_large',
      ))
    }
    try {
      await largeBodyGate.run(() => pipeLargeBody(req, res, route, reqStart))
    } catch (error) {
      if (error instanceof LargeBodyBusyError) {
        try { req.resume() } catch { /* 忽略 */ }
        eventBus.emit('request:log', {
          type: 'error', method: req.method, path: req.path, provider: '', model: '',
          error: error.message, status: error.status || 429, responseTime: Date.now() - reqStart,
        })
        if (!res.headersSent) {
          return res.status(error.status || 429).json(openaiError(error.message, 'rate_limit_error', 'large_request_busy'))
        }
        return undefined
      }
      throw error
    }
    return undefined
  }

  function forwardLargeResponse(response, res) {
    const headers = { 'X-ContextGate-Mode': 'large-body-passthrough' }
    const upstreamType = response.headers?.['content-type']
    if (upstreamType) headers['Content-Type'] = upstreamType
    res.writeHead(response.status || 200, headers)
  }

  /** 把上游响应流原样接到客户端；客户端断开时销毁上游流，避免继续下载 */
  function waitForStream(stream, res) {
    return new Promise(resolve => {
      let settled = false
      const finish = () => { if (!settled) { settled = true; resolve() } }
      stream.on('error', () => { try { res.destroy() } catch { /* 忽略 */ } finish() })
      stream.on('close', finish)
      res.on('finish', finish)
      res.on('close', () => { try { stream.destroy?.() } catch { /* 忽略 */ } finish() })
      stream.pipe(res)
    })
  }

  async function pipeLargeBody(req, res, route, reqStart) {
    const declared = req._largeBody?.bytes || 0
    const backendPath = protocol.upstreamPathFor(req.path)
    const providerId = protocol.providerHintForPath(route.path, configManager)
      || providerRegistry.detectProviderFromPath(backendPath, configManager)
    const providerConfig = resolveCandidate(providerId)
    if (!providerConfig.base_url) {
      try { req.resume() } catch { /* 忽略 */ }
      eventBus.emit('request:log', { type: 'error', method: req.method, path: req.path, provider: providerId, model: '', error: `Unknown provider: ${providerId}`, status: 400, responseTime: Date.now() - reqStart })
      return res.status(400).json(openaiError(`Unknown provider: ${providerId}`, 'invalid_request_error', 'unknown_provider'))
    }
    if (!budgetAllows(req, res, { provider: providerId, model: '' })) { try { req.resume() } catch { /* 忽略 */ } return undefined }

    const forwardHeaders = upstreamHeaders(req, svc.localToken)
    const resolved = resolveApiKey(providerConfig, forwardHeaders.authorization, forwardHeaders['x-api-key'])
    if (resolved.error) {
      try { req.resume() } catch { /* 忽略 */ }
      return res.status(401).json(openaiError(resolved.error, 'invalid_request_error', 'invalid_api_key'))
    }
    const headers = buildForwardHeaders(providerConfig, resolved.key, forwardHeaders, {
      keepContentType: true,
      contentType: req.headers['content-type'] || 'application/json',
      routeId: route.id,
    })
    // 流式请求体必须带 Content-Length：axios 默认改用 chunked，部分上游会直接拒绝。
    // Accept-Encoding 固定为 identity，保证响应是未压缩字节，可以逐字节转发。
    headers['Content-Length'] = String(declared)
    headers['Accept-Encoding'] = 'identity'
    const { controller, dispose } = attachClientAbort(req, res)
    const url = joinUrl(protocol.normalizeGeminiBaseUrl(providerConfig.base_url), backendPath)
    let bytesOut = 0
    try {
      const response = await sendUpstream({
        providerConfig, method: req.method, url, data: req, headers,
        responseType: 'stream', signal: controller.signal,
      })
      response.data.on('data', chunk => { bytesOut += chunk.length })
      forwardLargeResponse(response, res)
      await waitForStream(response.data, res)
      logRequest({
        provider: providerId, model: '', method: req.method, path: req.path,
        status: response.status || 200, responseTime: Date.now() - reqStart,
        messagePreview: `[large ${declared}B → ${bytesOut}B]`,
      })
      return undefined
    } catch (error) {
      // 上游在返回响应头之后才失败：错误体同样是 stream，原样转发
      if (error?.response?.data && typeof error.response.data.pipe === 'function') {
        try {
          forwardLargeResponse(error.response, res)
          await waitForStream(error.response.data, res)
        } catch { try { res.destroy() } catch { /* 忽略 */ } }
      } else if (!res.headersSent) {
        res.status(error.response?.status || 500).json(error.response?.data && typeof error.response.data === 'object'
          ? error.response.data
          : openaiError(error.message, 'api_error', 'upstream_error'))
      } else {
        try { res.destroy() } catch { /* 忽略 */ }
      }
      eventBus.emit('request:log', {
        type: 'error', method: req.method, path: req.path, provider: providerId, model: '',
        error: error.message, status: error.response?.status || 500, responseTime: Date.now() - reqStart,
      })
      return undefined
    } finally {
      dispose()
    }
  }

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', provider: 'ContextGate', version: VERSION })
  })

  app.get('/v1', (_req, res) => {
    res.json({ status: 'ok', service: 'ContextGate Proxy', base_url: '/v1', routes: protocol.allowedV1Paths() })
  })

  app.get('/v1/models', async (req, res) => {
    try {
      const targetBaseUrl = req.headers['x-target-base-url']
      let providerConfig
      if (targetBaseUrl) {
        if (!allowTargetBaseUrl) {
          return res.status(403).json(openaiError('X-Target-Base-Url is disabled by configuration', 'invalid_request_error', 'feature_disabled'))
        }
        const validated = validateTargetBaseUrl(targetBaseUrl)
        if (!validated.ok) return res.status(400).json(openaiError(validated.error, 'invalid_request_error', 'invalid_base_url'))
        providerConfig = { base_url: validated.url, api_key: '', passthrough_auth: true, format: 'openai' }
      } else {
        const provider = req.query.provider || configManager.getDefaultProvider() || 'openai'
        providerConfig = resolveCandidate(provider)
      }
      if (!providerConfig.base_url) return res.status(400).json(openaiError('Unknown provider', 'invalid_request_error', 'unknown_provider'))
      const resolved = resolveApiKey(providerConfig, upstreamAuthHeader(req, svc.localToken), upstreamApiKeyHeader(req, svc.localToken))
      if (resolved.error) return res.status(401).json(openaiError(resolved.error, 'invalid_request_error', 'invalid_api_key'))
      const headers = buildForwardHeaders(providerConfig, resolved.key, req.headers, {})
      const response = await axiosRetry(buildAxiosConfig(providerConfig, {
        method: 'GET', url: `${protocol.normalizeGeminiBaseUrl(providerConfig.base_url)}/models`, headers,
      }))
      res.json(response.data)
    } catch (error) {
      res.status(error.response?.status || 500).json(error.response?.data || openaiError(error.message, 'api_error', 'upstream_error'))
    }
  })

  /**
   * 统一的 /v1/* 转发入口。
   * FIX-11：路径白名单来自 protocol.ROUTE_RULES，原生透传 /v1/messages、/v1/responses、
   *        /v1/files、/v1/batches，并对 multipart 走原始 body。
   */
  app.all('/v1/*', async (req, res) => {
    const reqStart = Date.now()
    const route = protocol.matchProtocolPath(req.path)
    if (!route) {
      return res.status(403).json(openaiError(`Path not allowed: ${req.path}`, 'invalid_request_error', 'path_not_allowed'))
    }
    if (protocolConfig.native_passthrough === false && route.providerHint) {
      return res.status(403).json(openaiError(`Native passthrough for ${route.path} is disabled`, 'invalid_request_error', 'feature_disabled'))
    }

    const isRaw = route.bodyMode === 'raw'
    const body = isRaw ? undefined : (req.body || {})
    const model = body?.model || ''
    const messages = Array.isArray(body?.messages) ? body.messages : []
    const isStream = protocol.isStreamingRequest(route, body, req.headers['content-type'])
    const reqSize = isRaw ? (req.body?.length || 0) : JSON.stringify(body || {}).length
    const msgPreview = extractMsgPreview(messages)

    try {
      // FIX-15：大请求走字节级透传（不解析、不缓存）
      if (req._largeBody) return await handleLargeBodyPassthrough(req, res, route, reqStart)
      if (!isRaw) cacheManager.invalidateIfNeeded(svc.contextFile, svc.projectRoot)

      const backendPath = protocol.upstreamPathFor(req.path)
      const providerId = protocol.providerHintForPath(route.path, configManager)
        || providerRegistry.detectProviderFromPath(backendPath, configManager)
      const providerConfig = resolveCandidate(providerId)
      if (!providerConfig.base_url) {
        eventBus.emit('request:log', { type: 'error', method: req.method, path: req.path, provider: providerId, model, error: `Unknown provider: ${providerId}`, status: 400, responseTime: Date.now() - reqStart })
        return res.status(400).json(openaiError(`Unknown provider: ${providerId}`, 'invalid_request_error', 'unknown_provider'))
      }
      if (!budgetAllows(req, res, { provider: providerId, model })) return

      // FIX-10：按 provider 形态注入 Prompt Caching 断点 / 检查前缀稳定性
      // FIX-11：Anthropic 原生路径（/v1/messages）无论 provider 配置写成什么格式，
      // 都应该按 Anthropic 形态处理缓存断点。
      const promptCacheTarget = route.id.startsWith('anthropic_')
        ? { ...providerConfig, format: 'anthropic' }
        : providerConfig
      let upstreamBody = body
      let promptCacheMeta = null
      if (!isRaw && body && typeof body === 'object') {
        const applied = applyPromptCache(body, promptCacheTarget, promptCacheConfig)
        upstreamBody = applied.body
        promptCacheMeta = applied.meta
      }

      const useCache = route.cacheable && !isRaw && !route.binaryResponse && body && cacheManager.shouldCache(req.method)
      let cacheKey = null
      if (useCache) {
        cacheKey = cacheManager.getCacheKey(req, cacheManager.getContextHash())
        if (cacheManager.has(cacheKey)) {
          return serveCacheHit({ req, res, cacheKey, providerId, model, reqStart, reqSize, msgPreview, route })
        }
      }

      const forwardHeaders = upstreamHeaders(req, svc.localToken)

      if (isStream) {
        return handleStreamProxy({
          req, res, providerId, model, upstreamBody, backendPath, routeId: route.id,
          reqStart, msgPreview, cacheKey, forwardHeaders,
          resolveCandidate, resilience, promptCacheMeta, promptCacheStats,
          eventBus, cacheManager, configManager, costFor, logRequest,
        })
      }

      const { controller, dispose } = attachClientAbort(req, res)
      try {
        const attempt = async ({ providerId: candidateId }) => {
          const cfg = resolveCandidate(candidateId)
          const resolved = resolveApiKey(cfg, forwardHeaders.authorization, forwardHeaders['x-api-key'])
          if (resolved.error) {
            const err = new Error(resolved.error)
            err.response = { status: 401, data: openaiError(resolved.error, 'invalid_request_error', 'invalid_api_key') }
            throw err
          }
          const headers = buildForwardHeaders(cfg, resolved.key, forwardHeaders, {
            keepContentType: isRaw,
            contentType: isRaw ? req.headers['content-type'] : 'application/json',
            routeId: route.id,
          })
          return sendUpstream({
            providerConfig: cfg,
            method: req.method,
            url: joinUrl(protocol.normalizeGeminiBaseUrl(cfg.base_url), backendPath),
            data: isRaw ? req.body : upstreamBody,
            headers,
            responseType: route.binaryResponse ? 'arraybuffer' : 'json',
            signal: controller.signal,
          })
        }

        const outcome = await resilience.run({
          providerId, attempt, method: req.method, headers: forwardHeaders,
          isAborted: () => controller.signal.aborted,
          onFallback: info => eventBus.emit('request:log', {
            type: 'error', method: req.method, path: req.path, provider: info.from, model,
            error: `上游失败，降级到 ${info.to}: ${info.error?.message}`, status: 0, responseTime: Date.now() - reqStart,
          }),
        })
        const response = outcome.result
        const usedProvider = outcome.providerId
        const responseTime = Date.now() - reqStart

        if (route.binaryResponse) {
          const upstreamType = response.headers?.['content-type'] || 'application/octet-stream'
          res.writeHead(response.status || 200, { 'Content-Type': upstreamType, 'Content-Length': response.data?.length || 0 })
          res.end(Buffer.from(response.data || []))
          logRequest({ provider: usedProvider, model, method: req.method, path: req.path, status: response.status || 200, responseTime, messagePreview: msgPreview })
          return
        }

        const usageNorm = usageTools.extractUsageFromResponse(response.data)
        const priced = costFor(usedProvider, model, usageNorm)
        if (useCache && cacheKey) cacheManager.set(cacheKey, response.data)
        reportCompletion({
          providerId: usedProvider, model, usageNorm, priced, promptCacheMeta,
          cached: false, responseTime, path: req.path, method: req.method,
          backendUrl: joinUrl(protocol.normalizeGeminiBaseUrl(providerConfig.base_url), backendPath),
          requestSize: reqSize, msgPreview, status: response.status,
        })
        res.status(response.status || 200).json(response.data)
      } finally {
        dispose()
      }
    } catch (error) {
      const responseTime = Date.now() - reqStart
      eventBus.emit('request:log', { type: 'error', method: req.method, path: req.path, provider: '', model, requestSize: reqSize, messagePreview: msgPreview, error: error.message, status: error.response?.status || 500, responseTime })
      logRequest({ provider: '', model, method: req.method, path: req.path, status: error.response?.status || 500, responseTime, error: error.message, messagePreview: msgPreview })
      if (res.headersSent) return res.end()
      res.status(error.response?.status || 500).json(error.response?.data && typeof error.response.data === 'object'
        ? error.response.data
        : openaiError(error.message, (error.response?.status || 500) >= 500 ? 'api_error' : 'invalid_request_error', 'upstream_error'))
    }
  })

  function serveCacheHit({ req, res, cacheKey, providerId, model, reqStart, reqSize, msgPreview, route }) {
    const cached = cacheManager.get(cacheKey)
    const cachedUsage = cached?._usage || cached?.usage || null
    const usageNorm = cachedUsage ? usageTools.normalizeUsage(cachedUsage) : usageTools.emptyUsage()
    const priced = costFor(providerId, model, usageNorm)
    // 缓存命中没有真实支出：成本记 0，省下的金额记在 saved_cost
    eventBus.emit('request:complete', {
      provider: providerId, model,
      input_tokens: usageNorm.prompt_tokens, output_tokens: usageNorm.completion_tokens,
      cached_tokens: usageNorm.cached_tokens, cache_write_tokens: usageNorm.cache_write_tokens,
      cost: 0, saved_cost: priced.cost, pricing_known: priced.known,
      cached: true, response_time: 0,
    })
    eventBus.emit('request:log', {
      type: 'response', method: req.method, path: req.path, provider: providerId, model,
      requestSize: reqSize, messagePreview: msgPreview,
      tokens: { prompt: usageNorm.prompt_tokens, completion: usageNorm.completion_tokens, total: usageNorm.total_tokens },
      cost: 0, savedCost: priced.cost, pricingKnown: priced.known,
      cached: true, status: 200, responseTime: Date.now() - reqStart,
    })
    logRequest({ provider: providerId, model, method: req.method, path: req.path, status: 200, cached: true, responseTime: Date.now() - reqStart, inputTokens: usageNorm.prompt_tokens, outputTokens: usageNorm.completion_tokens, cost: 0, messagePreview: msgPreview })
    if (route?.binaryResponse) return res.status(404).end()
    if (cached?._sseEvents) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Cache': 'HIT' })
      return res.end(serializeSSEEvents(cached._sseEvents))
    }
    if (cached?._streamChunks) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Cache': 'HIT' })
      for (const chunk of cached._streamChunks) res.write(chunk)
      return res.end()
    }
    res.setHeader('X-Cache', 'HIT')
    return res.json(cached)
  }

  app.post('/proxy/chat', async (req, res) => {
    const reqStart = Date.now()
    // FIX-15：/proxy/chat 需要解析后的 body 才能取 provider/model，无法流式透传
    if (req._largeBody) {
      try { req.resume() } catch { /* 忽略 */ }
      return res.status(413).json(openaiError(
        'Request too large for /proxy/chat; send it to /v1/chat/completions, which streams large bodies straight to the upstream.',
        'invalid_request_error', 'request_too_large',
      ))
    }
    const { provider = 'openai', model, messages, ...options } = req.body || {}
    const reqSize = JSON.stringify(req.body || {}).length
    const msgPreview = extractMsgPreview(messages)
    cacheManager.invalidateIfNeeded(svc.contextFile, svc.projectRoot)
    const providerConfig = resolveCandidate(provider)
    if (!providerConfig.base_url) return res.status(400).json(openaiError(`Unknown provider: ${provider}`, 'invalid_request_error', 'unknown_provider'))
    if (!budgetAllows(req, res, { provider, model })) return
    const forwardHeaders = upstreamHeaders(req, svc.localToken)
    const applied = applyPromptCache({ model, messages, ...options }, providerConfig, promptCacheConfig)
    const cacheKey = cacheManager.getCacheKey(req, cacheManager.getContextHash())
    if (cacheManager.has(cacheKey)) {
      const cached = cacheManager.get(cacheKey)
      const usageNorm = cached?._usage ? usageTools.normalizeUsage(cached._usage) : usageTools.extractUsageFromResponse(cached)
      const priced = costFor(provider, model, usageNorm)
      eventBus.emit('request:complete', {
        provider, model, input_tokens: usageNorm.prompt_tokens, output_tokens: usageNorm.completion_tokens,
        cost: 0, saved_cost: priced.cost, pricing_known: priced.known, cached: true, response_time: 0,
      })
      eventBus.emit('request:log', {
        type: 'response', method: 'POST', path: req.path, provider, model, backendUrl: providerConfig.base_url,
        requestSize: reqSize, messagePreview: msgPreview,
        tokens: { prompt: usageNorm.prompt_tokens, completion: usageNorm.completion_tokens, total: usageNorm.total_tokens },
        cost: 0, savedCost: priced.cost, pricingKnown: priced.known, cached: true, status: 200, responseTime: Date.now() - reqStart,
      })
      res.setHeader('X-Cache', 'HIT')
      return res.json(cached)
    }
    const { controller, dispose } = attachClientAbort(req, res)
    try {
      const attempt = async ({ providerId: candidateId }) => {
        const cfg = resolveCandidate(candidateId)
        const resolved = resolveApiKey(cfg, forwardHeaders.authorization, forwardHeaders['x-api-key'])
        if (resolved.error) {
          const err = new Error(resolved.error)
          err.response = { status: 401, data: openaiError(resolved.error, 'invalid_request_error', 'invalid_api_key') }
          throw err
        }
        const headers = buildForwardHeaders(cfg, resolved.key, forwardHeaders, {})
        return sendUpstream({
          providerConfig: cfg, method: 'POST',
          url: joinUrl(protocol.normalizeGeminiBaseUrl(cfg.base_url), '/chat/completions'),
          data: { ...applied.body, model: applied.body.model || model },
          headers, signal: controller.signal,
        })
      }
      const outcome = await resilience.run({ providerId: provider, attempt, method: 'POST', headers: forwardHeaders, isAborted: () => controller.signal.aborted })
      const response = outcome.result
      const usageNorm = usageTools.extractUsageFromResponse(response.data)
      const priced = costFor(outcome.providerId, model, usageNorm)
      cacheManager.set(cacheKey, response.data)
      reportCompletion({
        providerId: outcome.providerId, model, usageNorm, priced, promptCacheMeta: applied.meta,
        cached: false, responseTime: Date.now() - reqStart, path: req.path, method: 'POST',
        backendUrl: providerConfig.base_url, requestSize: reqSize, msgPreview, status: response.status,
      })
      res.json(response.data)
    } catch (error) {
      eventBus.emit('request:log', { type: 'error', method: 'POST', path: req.path, provider, model, requestSize: reqSize, messagePreview: msgPreview, error: error.message, status: error.response?.status || 500, responseTime: Date.now() - reqStart })
      logRequest({ provider, model, method: 'POST', path: req.path, status: error.response?.status || 500, responseTime: Date.now() - reqStart, error: error.message, messagePreview: msgPreview })
      if (res.headersSent) return res.end()
      res.status(error.response?.status || 500).json(openaiError(error.message, 'api_error', 'upstream_error'))
    } finally {
      dispose()
    }
  })

  app.get('/stats', (_req, res) => {
    const budget = svc.budgetGuard ? svc.budgetGuard.check() : null
    res.json({
      cacheSize: cacheManager.size,
      cacheHits: cacheManager.hits,
      cacheMisses: cacheManager.misses,
      cacheTtlSeconds: cacheManager.ttlMs > 0 ? cacheManager.ttlMs / 1000 : 0,
      cache: cacheManager.stats(),
      promptCache: promptCacheStats.summary(),
      resilience: resilience.snapshot(),
      largeBody: largeBodyGate.snapshot(),
      contextHash: cacheManager.getContextHash(),
      budget,
      security: {
        authEnabled: configManager.get('proxy.auth.enabled') !== false,
        hostCheck: configManager.get('proxy.auth.host_check') !== false,
        allowInsecureTls: getSecurityPolicy().allowInsecureTls,
      },
      uptime: process.uptime(),
    })
  })

  app.get('/context/hash', (_req, res) => {
    cacheManager.loadContextSignature(svc.contextFile, svc.projectRoot)
    const sig = cacheManager.contextSignature
    res.json({ contextFile: svc.contextFile, hash: sig?.mainHash || null, combinedHash: sig?.combinedHash || null, fileCount: sig?.fileCount || 0 })
  })

  app.delete('/cache', (_req, res) => { cacheManager.clear(); res.json({ success: true }) })

  app.get('/requests', async (req, res) => {
    if (!requestLog) return res.status(404).json(openaiError('Request log is disabled', 'invalid_request_error', 'feature_disabled'))
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000)
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0)
    try { res.json({ entries: await requestLog.list({ limit, offset }) }) }
    catch (e) { res.status(500).json(openaiError(e.message, 'api_error')) }
  })

  // FIX-17：Prometheus 指标。受本地令牌保护（与其它端点一致），
  // 采集端需要在 scrape 配置里带上 Authorization 头。
  app.get(observabilityConfig.metrics.path, async (_req, res) => {
    if (!observabilityConfig.metrics.enabled) {
      return res.status(404).json(openaiError('Metrics endpoint is disabled', 'invalid_request_error', 'feature_disabled'))
    }
    let summary = null
    try { summary = svc.getUsageSummary ? await svc.getUsageSummary() : null } catch { summary = null }
    let budget = null
    try { budget = svc.budgetGuard ? svc.budgetGuard.check() : null } catch { budget = null }
    const text = buildMetrics({
      summary: summary || {},
      cache: { ...cacheManager.stats(), size: cacheManager.size },
      promptCache: promptCacheStats.summary(),
      budget,
      largeBody: largeBodyGate.snapshot(),
      version: VERSION,
    })
    res.set('Content-Type', PROMETHEUS_CONTENT_TYPE).send(text)
  })

  // FIX-17：把脱敏的请求日志导出为 CSV/JSON（默认上限见 observability.request_export.max_entries）
  app.get('/requests/export', async (req, res) => {
    if (!requestLog) return res.status(404).json(openaiError('Request log is disabled', 'invalid_request_error', 'feature_disabled'))
    if (!observabilityConfig.request_export.enabled) {
      return res.status(404).json(openaiError('Request export is disabled', 'invalid_request_error', 'feature_disabled'))
    }
    const maxEntries = observabilityConfig.request_export.max_entries
    const requestedLimit = parseInt(req.query.limit, 10) || maxEntries
    const limit = Math.min(Math.max(requestedLimit, 1), maxEntries)
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0)
    try {
      const entries = await requestLog.list({ limit, offset })
      const payload = exportTools.serialize(entries, { format: req.query.format })
      res.setHeader('Content-Disposition', `attachment; filename="contextgate-requests.${payload.extension}"`)
      res.set('Content-Type', payload.contentType).send(payload.body)
    } catch (e) {
      res.status(500).json(openaiError(e.message, 'api_error'))
    }
  })

  app.get('/providers', (_req, res) => {
    try { res.json({ providers: providerRegistry.getAvailableProviders() }) }
    catch (e) { res.status(500).json(openaiError(e.message, 'api_error')) }
  })

  app.get('/providers/:id/models', (req, res) => {
    try { res.json({ provider: req.params.id, models: providerRegistry.getModelsFromModelsDev(req.params.id) }) }
    catch (e) { res.status(500).json(openaiError(e.message, 'api_error')) }
  })

  app.get('/providers/:id/models/recommended', (req, res) => {
    try {
      const models = providerRegistry.getModelsFromModelsDev(req.params.id)
      res.json({ provider: req.params.id, models: models.slice(0, 20) })
    } catch (e) { res.status(500).json(openaiError(e.message, 'api_error')) }
  })

  app.get('/models/search', (req, res) => {
    try {
      const q = req.query.q || ''
      if (!q) return res.json({ results: [] })
      res.json({ query: q, results: require('./models-dev').searchModels(q, providerRegistry.modelsDevData) })
    } catch (e) { res.status(500).json(openaiError(e.message, 'api_error')) }
  })

  app.get('/models/:providerId/:modelId/cost', (req, res) => {
    try {
      const cost = providerRegistry.enrichProviderWithCost(req.params.providerId, req.params.modelId)
      if (!cost) return res.status(404).json(openaiError('Model not found', 'invalid_request_error', 'model_not_found'))
      res.json({ provider: req.params.providerId, model: req.params.modelId, cost })
    } catch (e) { res.status(500).json(openaiError(e.message, 'api_error')) }
  })

  // FIX-01：未知端点也返回 JSON，而不是 Express 默认的 HTML 页面
  app.use((req, res) => {
    // FIX-15：大请求在这里没被消费，必须排空，否则连接会一直挂着等客户端传完
    if (req._largeBody) { try { req.resume() } catch { /* 忽略 */ } }
    res.status(404).json(openaiError(`Unknown endpoint: ${req.method} ${req.path}`, 'invalid_request_error', 'unknown_endpoint'))
  })

  // FIX-01：统一错误中间件 —— body-parser 的 413 原先会被渲染成 HTML
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err)
    if (req && req._largeBody) { try { req.resume() } catch { /* 忽略 */ } }
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
      return res.status(413).json(openaiError(
        `Request body exceeds the configured limit (${maxBodySize}). Increase proxy.max_body_size to allow larger payloads.`,
        'invalid_request_error', 'request_too_large',
      ))
    }
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json(openaiError('Invalid JSON body', 'invalid_request_error', 'invalid_json'))
    }
    if (err && (err.type === 'charset.unsupported' || err.type === 'encoding.unsupported')) {
      return res.status(415).json(openaiError('Unsupported content encoding', 'invalid_request_error', 'unsupported_encoding'))
    }
    console.error('[router] unhandled error:', err)
    return res.status(500).json(openaiError('Internal proxy error', 'api_error', 'internal_error'))
  })

  return { resilience, promptCacheStats }
}

/**
 * FIX-07 + FIX-11：流式转发。
 * 用 stream-relay 统一处理「写头 → 中转 → 空闲/总超时 → 客户端断开 → 中止上游 → 错误表达」，
 * 上游在开始产出前失败时仍然可以走 resilience 的重试/降级。
 */
function handleStreamProxy(ctx) {
  const {
    req, res, providerId, model, upstreamBody, backendPath, routeId,
    reqStart, msgPreview, cacheKey, forwardHeaders,
    resolveCandidate, resilience, promptCacheMeta, promptCacheStats,
    eventBus, cacheManager, configManager, costFor, logRequest,
  } = ctx
  const streamCfg = configManager.getStreamConfig()
  const { controller, dispose } = attachClientAbort(req, res)
  const injectUsage = configManager.get('proxy.inject_stream_usage') !== false

  const attempt = async ({ providerId: candidateId }) => {
    const cfg = resolveCandidate(candidateId)
    const resolved = resolveApiKey(cfg, forwardHeaders.authorization, forwardHeaders['x-api-key'])
    if (resolved.error) {
      const err = new Error(resolved.error)
      err.response = { status: 401, data: openaiError(resolved.error, 'invalid_request_error', 'invalid_api_key') }
      throw err
    }
    const useStreamOptions = injectUsage && usageTools.shouldInjectStreamUsage(cfg, upstreamBody, {})
    const url = joinUrl(protocol.normalizeGeminiBaseUrl(cfg.base_url), backendPath)
    const send = (withUsage) => {
      const data = { ...upstreamBody, stream: true }
      if (withUsage) data.stream_options = usageTools.STREAM_USAGE_OPTION
      const headers = buildForwardHeaders(cfg, resolved.key, forwardHeaders, { routeId })
      return sendUpstream({ providerConfig: cfg, method: 'POST', url, data, headers, responseType: 'stream', signal: controller.signal })
    }
    try {
      return await send(useStreamOptions)
    } catch (error) {
      // 部分上游不接受 stream_options：仅在这种情况下降级重试一次，不再注入
      if (useStreamOptions && usageTools.isStreamOptionsRejection(error)) {
        console.warn('[router] upstream rejected stream_options; retrying without usage injection')
        return send(false)
      }
      throw error
    }
  }

  resilience.run({
    providerId, attempt, method: 'POST', headers: forwardHeaders, stream: true,
    isAborted: () => controller.signal.aborted,
    onFallback: info => eventBus?.emit('request:log', {
      type: 'error', method: 'POST', path: req.path, provider: info.from, model,
      error: `上游失败，降级到 ${info.to}: ${info.error?.message}`, status: 0, responseTime: Date.now() - reqStart,
    }),
  }).then(outcome => {
    const response = outcome.result
    const usedProvider = outcome.providerId
    writeStreamHeaders(res, { 'X-Cache': 'MISS' })
    relayStream({
      req, res, upstream: response.data, controller,
      idleTimeoutMs: streamCfg.idle_timeout_ms,
      totalTimeoutMs: streamCfg.total_timeout_ms,
      onComplete: (chunks, collected) => {
        const usageNorm = usageTools.extractUsageFromSSE(chunks)
        const priced = costFor(usedProvider, model, usageNorm)
        try {
          const sseEvents = parseSSEChunks(chunks)
          cacheManager.set(cacheKey, {
            _sseEvents: sseEvents,
            _usage: usageNorm.raw || { prompt_tokens: usageNorm.prompt_tokens, completion_tokens: usageNorm.completion_tokens, total_tokens: usageNorm.total_tokens },
          })
        } catch (e) { console.error('Stream cache error:', e.message) }
        const metrics = promptCacheMetrics(usageNorm, priced.pricing)
        promptCacheStats?.record(metrics, promptCacheMeta)
        try {
          eventBus?.emit('request:complete', {
            provider: usedProvider, model,
            input_tokens: usageNorm.prompt_tokens, output_tokens: usageNorm.completion_tokens,
            cached_tokens: usageNorm.cached_tokens, cache_write_tokens: usageNorm.cache_write_tokens,
            cost: priced.cost, saved_cost: priced.savedCost, pricing_known: priced.known, pricing_source: priced.source,
            cached: false, response_time: Date.now() - reqStart,
          })
          eventBus?.emit('request:log', {
            type: 'stream', method: 'POST', path: req.path, provider: usedProvider, model,
            backendUrl: joinUrl(protocol.normalizeGeminiBaseUrl((resolveCandidate(usedProvider).base_url) || ''), backendPath),
            bytes: collected?.length || 0,
            tokens: {
              prompt: usageNorm.prompt_tokens, completion: usageNorm.completion_tokens,
              total: usageNorm.total_tokens, cached: usageNorm.cached_tokens, cacheWrite: usageNorm.cache_write_tokens,
            },
            cost: priced.cost, savedCost: priced.savedCost, pricingKnown: priced.known,
            promptCache: promptCacheMeta || undefined,
            cached: false, status: 200, responseTime: Date.now() - reqStart,
          })
          logRequest?.({
            provider: usedProvider, model, method: 'POST', path: req.path, status: 200, cached: false,
            responseTime: Date.now() - reqStart,
            inputTokens: usageNorm.prompt_tokens, outputTokens: usageNorm.completion_tokens,
            cost: priced.cost, messagePreview: msgPreview,
          })
        } catch (e) { console.error('Stream stats error:', e.message) }
      },
      onError: (err) => {
        console.error('Stream error:', err?.message)
        eventBus?.emit('request:log', {
          type: 'error', method: 'POST', path: req.path, provider: usedProvider, model,
          error: err?.message || 'stream_error', status: 502, responseTime: Date.now() - reqStart,
        })
      },
      onAbort: ({ reason, clientGone }) => {
        const status = clientGone ? 499 : 504
        console.warn(`[router] 流式请求被中止（${reason}），状态 ${status}`)
        eventBus?.emit('request:log', {
          type: 'error', method: 'POST', path: req.path, provider: usedProvider, model,
          error: reason, status, responseTime: Date.now() - reqStart,
        })
      },
    }).promise.catch(e => console.error('[router] stream relay failed:', e.message))
  }).catch(error => {
    console.error('[router] upstream stream failed:', error.message)
    eventBus?.emit('request:log', { type: 'error', method: 'POST', path: req.path, provider: providerId, model, error: error.message, status: error.response?.status || 500, responseTime: Date.now() - reqStart })
    logRequest?.({
      provider: providerId, model, method: 'POST', path: req.path,
      status: error.response?.status || 500, responseTime: Date.now() - reqStart,
      error: error.message, messagePreview: msgPreview,
    })
    if (!res.headersSent) {
      res.status(error.response?.status || 500).json(error.response?.data && typeof error.response.data === 'object'
        ? error.response.data
        : openaiError(error.message, 'api_error', 'upstream_error'))
    } else {
      writeSSEError(res, error.message, 'upstream_error')
      try { res.end() } catch { /* 忽略 */ }
    }
  }).finally(() => {
    // relay 自己会清理 res 监听；dispose 兜底避免长时间运行后监听器泄漏
    setTimeout(dispose, 5000).unref?.()
  })
}

module.exports = {
  createRoutes,
  // 向后兼容：旧的发现接口与单测可能引用这个常量
  ALLOWED_V1_PATHS: protocol.allowedV1Paths(),
  validateTargetBaseUrl, openaiError, upstreamAuthHeader, upstreamApiKeyHeader, attachClientAbort,
}
