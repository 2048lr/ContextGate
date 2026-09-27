const express = require('express')
const { VERSION, DEFAULT_MAX_BODY_SIZE } = require('../core/constants')
const { resolveApiKey, axiosRetry, buildAxiosConfig, axiosInstance } = require('./forwarder')
const { extractMsgPreview, parseSSEChunks, serializeSSEEvents } = require('./stream-handler')
const { computeUsageCost } = require('../monitor/cost-calculator')
const usageTools = require('./usage')

// P1-3（协议扩展）仍待办：/v1/responses、/v1/messages、/v1/files、/v1/batches
const ALLOWED_V1_PATHS = [
  '/v1/chat/completions', '/v1/completions', '/v1/embeddings',
  '/v1/models', '/v1/images/generations', '/v1/audio/transcriptions',
  '/v1/audio/translations', '/v1/audio/speech', '/v1/moderations',
]

function openaiError(message, type = 'invalid_request_error', code = null, param = null) {
  return { error: { message, type, code, param } }
}

// 客户端把「本地令牌」放进 Authorization 是推荐用法；它绝不能又被当成上游 Key
// 转发出去（passthrough_auth 场景下会发生这种串味）。
function upstreamAuthHeader(req, localToken) {
  const raw = req.headers?.authorization
  if (typeof raw !== 'string' || !raw) return undefined
  const presented = raw.replace(/^Bearer\s+/i, '').trim()
  if (localToken && presented && presented === localToken) return undefined
  return raw
}

function upstreamHeaders(req, localToken) {
  return { ...req.headers, authorization: upstreamAuthHeader(req, localToken) }
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

function createRoutes(app, svc) {
  const { cacheManager, configManager, providerRegistry, eventBus } = svc
  const proxyConfig = configManager.getProxyConfig()
  const maxBodySize = proxyConfig.max_body_size || DEFAULT_MAX_BODY_SIZE
  // 允许关闭 stream_options 注入（部分上游不接受该字段）
  const injectStreamUsage = configManager.get('proxy.inject_stream_usage') !== false
  const allowTargetBaseUrl = configManager.get('proxy.auth.allow_target_base_url') !== false

  // FIX-01：解除 100KB 默认上限，否则带上下文的请求直接 413
  app.use(express.json({ limit: maxBodySize }))
  app.use((req, _res, next) => { console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`); next() })

  function costFor(providerId, model, usageNorm) {
    return computeUsageCost(model, usageNorm, {
      providerId,
      modelsDevData: providerRegistry?.modelsDevData,
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

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', provider: 'ContextGate', version: VERSION })
  })

  app.get('/v1', (_req, res) => {
    res.json({ status: 'ok', service: 'ContextGate Proxy', base_url: '/v1', routes: ALLOWED_V1_PATHS })
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
        providerConfig = providerRegistry.resolveProvider(provider, configManager.getProvider(provider))
      }
      if (!providerConfig.base_url) return res.status(400).json(openaiError('Unknown provider', 'invalid_request_error', 'unknown_provider'))
      const resolved = resolveApiKey(providerConfig, upstreamAuthHeader(req, svc.localToken))
      if (resolved.error) return res.status(401).json(openaiError(resolved.error, 'invalid_request_error', 'invalid_api_key'))
      const response = await axiosRetry(buildAxiosConfig(providerConfig, {
        method: 'GET', url: `${providerConfig.base_url}/models`,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resolved.key}` },
      }))
      res.json(response.data)
    } catch (error) {
      res.status(error.response?.status || 500).json(error.response?.data || openaiError(error.message, 'api_error', 'upstream_error'))
    }
  })

  app.all('/v1/*', async (req, res) => {
    // 规范化路径，移除尾部斜杠以匹配允许列表
    const normalizedPath = req.path.endsWith('/') && req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path
    if (!ALLOWED_V1_PATHS.includes(normalizedPath)) {
      return res.status(403).json(openaiError(`Path not allowed: ${normalizedPath}`, 'invalid_request_error', 'path_not_allowed'))
    }
    const reqStart = Date.now()
    const body = req.body || {}
    const model = body.model || ''
    const messages = body.messages || []
    const isStream = !!body.stream
    const reqSize = JSON.stringify(body).length
    const msgPreview = extractMsgPreview(messages)

    try {
      cacheManager.invalidateIfNeeded(svc.contextFile, svc.projectRoot)

      const backendPath = req.path.replace('/v1/', '/')
      const providerId = providerRegistry.detectProviderFromPath(backendPath, configManager)
      const providerConfig = providerRegistry.resolveProvider(providerId, configManager.getProvider(providerId))
      if (!providerConfig.base_url) {
        eventBus.emit('request:log', { type: 'error', method: req.method, path: req.path, provider: providerId, model, error: `Unknown provider: ${providerId}`, status: 400, responseTime: Date.now() - reqStart })
        return res.status(400).json(openaiError(`Unknown provider: ${providerId}`, 'invalid_request_error', 'unknown_provider'))
      }
      if (!budgetAllows(req, res, { provider: providerId, model })) return
      const backendUrl = providerConfig.base_url.replace(/\/+$/, '') + '/' + backendPath.replace(/^\/+/, '')

      const cacheKey = cacheManager.getCacheKey(req, cacheManager.getContextHash())
      if (cacheManager.has(cacheKey)) {
        const cached = cacheManager.get(cacheKey)
        const cachedUsage = cached._usage || cached.usage || null
        const usageNorm = cachedUsage ? usageTools.normalizeUsage(cachedUsage) : usageTools.emptyUsage()
        const priced = costFor(providerId, model, usageNorm)
        // 缓存命中没有真实支出：成本记 0，省下的金额记在 saved_cost
        eventBus.emit('request:complete', {
          provider: providerId, model,
          input_tokens: usageNorm.prompt_tokens, output_tokens: usageNorm.completion_tokens,
          cost: 0, saved_cost: priced.cost, pricing_known: priced.known,
          cached: true, response_time: 0,
        })
        eventBus.emit('request:log', {
          type: 'response', method: req.method, path: req.path, provider: providerId, model, backendUrl,
          requestSize: reqSize, messagePreview: msgPreview,
          tokens: { prompt: usageNorm.prompt_tokens, completion: usageNorm.completion_tokens, total: usageNorm.total_tokens },
          cost: 0, savedCost: priced.cost, pricingKnown: priced.known,
          cached: true, status: 200, responseTime: Date.now() - reqStart,
        })
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

      if (isStream) {
        return handleStreamProxy(providerConfig, providerId, model, messages, body, req, res, cacheKey, reqStart, svc, backendUrl, { injectStreamUsage, costFor, eventBus })
      }

      const { forwardRequest } = require('./forwarder')
      const response = await forwardRequest(providerConfig, backendPath, body, upstreamHeaders(req, svc.localToken))
      const responseTime = Date.now() - reqStart
      const usageNorm = usageTools.extractUsageFromResponse(response.data)
      const priced = costFor(providerId, model, usageNorm)
      if (response.data && cacheManager.shouldCache(req.method)) cacheManager.set(cacheKey, response.data)
      eventBus.emit('request:complete', {
        provider: providerId, model, input_tokens: usageNorm.prompt_tokens, output_tokens: usageNorm.completion_tokens,
        cost: priced.cost, saved_cost: priced.savedCost, pricing_known: priced.known, pricing_source: priced.source,
        cached: false, response_time: responseTime,
      })
      eventBus.emit('request:log', {
        type: 'response', method: req.method, path: req.path, provider: providerId, model, backendUrl,
        requestSize: reqSize, messagePreview: msgPreview,
        tokens: { prompt: usageNorm.prompt_tokens, completion: usageNorm.completion_tokens, total: usageNorm.total_tokens },
        cost: priced.cost, savedCost: priced.savedCost, pricingKnown: priced.known,
        cached: false, status: response.status, responseTime,
      })
      res.json(response.data)
    } catch (error) {
      const responseTime = Date.now() - reqStart
      const status = error.response?.status || 500
      eventBus.emit('request:log', { type: 'error', method: req.method, path: req.path, provider: '', model, requestSize: reqSize, messagePreview: msgPreview, error: error.message, status, responseTime })
      if (res.headersSent) return res.end()
      res.status(status).json(error.response?.data && typeof error.response.data === 'object'
        ? error.response.data
        : openaiError(error.message, status >= 500 ? 'api_error' : 'invalid_request_error', 'upstream_error'))
    }
  })

  app.post('/proxy/chat', async (req, res) => {
    const reqStart = Date.now()
    const { provider = 'openai', model, messages, ...options } = req.body || {}
    const reqSize = JSON.stringify(req.body || {}).length
    const msgPreview = extractMsgPreview(messages)
    cacheManager.invalidateIfNeeded(svc.contextFile, svc.projectRoot)
    const providerConfig = providerRegistry.resolveProvider(provider, configManager.getProvider(provider))
    if (!providerConfig.base_url) return res.status(400).json(openaiError(`Unknown provider: ${provider}`, 'invalid_request_error', 'unknown_provider'))
    if (!budgetAllows(req, res, { provider, model })) return
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
    try {
      const { forwardChatRequest } = require('./forwarder')
      const response = await forwardChatRequest(providerConfig, model, messages, options, upstreamHeaders(req, svc.localToken))
      const usageNorm = usageTools.extractUsageFromResponse(response.data)
      const priced = costFor(provider, model, usageNorm)
      cacheManager.set(cacheKey, response.data)
      eventBus.emit('request:complete', {
        provider, model, input_tokens: usageNorm.prompt_tokens, output_tokens: usageNorm.completion_tokens,
        cost: priced.cost, saved_cost: priced.savedCost, pricing_known: priced.known, cached: false, response_time: Date.now() - reqStart,
      })
      eventBus.emit('request:log', {
        type: 'response', method: 'POST', path: req.path, provider, model, backendUrl: providerConfig.base_url,
        requestSize: reqSize, messagePreview: msgPreview,
        tokens: { prompt: usageNorm.prompt_tokens, completion: usageNorm.completion_tokens, total: usageNorm.total_tokens },
        cost: priced.cost, savedCost: priced.savedCost, pricingKnown: priced.known, cached: false, status: response.status, responseTime: Date.now() - reqStart,
      })
      res.json(response.data)
    } catch (error) {
      eventBus.emit('request:log', { type: 'error', method: 'POST', path: req.path, provider, model, requestSize: reqSize, messagePreview: msgPreview, error: error.message, status: error.response?.status || 500, responseTime: Date.now() - reqStart })
      res.status(error.response?.status || 500).json(openaiError(error.message, 'api_error', 'upstream_error'))
    }
  })

  app.get('/stats', (_req, res) => {
    const budget = svc.budgetGuard ? svc.budgetGuard.check() : null
    res.json({
      cacheSize: cacheManager.size,
      cacheHits: cacheManager.hits,
      cacheMisses: cacheManager.misses,
      cacheTtlSeconds: cacheManager.ttlMs > 0 ? cacheManager.ttlMs / 1000 : 0,
      contextHash: cacheManager.getContextHash(),
      budget,
      security: {
        authEnabled: configManager.get('proxy.auth.enabled') !== false,
        hostCheck: configManager.get('proxy.auth.host_check') !== false,
        allowInsecureTls: require('./forwarder').getSecurityPolicy().allowInsecureTls,
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
    res.status(404).json(openaiError(`Unknown endpoint: ${req.method} ${req.path}`, 'invalid_request_error', 'unknown_endpoint'))
  })

  // FIX-01：统一错误中间件 —— body-parser 的 413 原先会被渲染成 HTML
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err)
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
}

function handleStreamProxy(providerConfig, providerId, model, messages, body, req, res, cacheKey, reqStart, svc, backendUrl, helpers) {
  const { injectStreamUsage, costFor, eventBus } = helpers || {}
  const url = backendUrl || `${providerConfig.base_url}/chat/completions`
  const resolved = resolveApiKey(providerConfig, upstreamAuthHeader(req, svc.localToken))
  if (resolved.error) return res.status(401).json(openaiError(resolved.error, 'invalid_request_error', 'invalid_api_key'))

  const useStreamOptions = injectStreamUsage !== false && usageTools.shouldInjectStreamUsage(providerConfig, body, {})
  const buildData = (withStreamOptions) => {
    const data = { ...body, model, messages, stream: true }
    if (withStreamOptions) data.stream_options = usageTools.STREAM_USAGE_OPTION
    return data
  }

  const run = (withStreamOptions) => axiosInstance({
    ...buildAxiosConfig(providerConfig, {
      method: 'POST', url,
      data: buildData(withStreamOptions),
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resolved.key}` },
      responseType: 'stream',
    }),
  })

  const start = (withStreamOptions) => {
    run(withStreamOptions).then(response => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Cache': 'MISS' })
      const rawChunks = []
      response.data.on('data', (chunk) => {
        rawChunks.push(chunk)
        res.write(chunk)
      })
      response.data.on('end', () => {
        const usageNorm = usageTools.extractUsageFromSSE(rawChunks)
        const priced = costFor(providerId, model, usageNorm)
        try {
          const sseEvents = parseSSEChunks(rawChunks)
          svc.cacheManager.set(cacheKey, { _sseEvents: sseEvents, _usage: usageNorm.raw || { prompt_tokens: usageNorm.prompt_tokens, completion_tokens: usageNorm.completion_tokens, total_tokens: usageNorm.total_tokens } })
        } catch (e) { console.error('Stream cache error:', e.message) }
        try {
          eventBus.emit('request:complete', {
            provider: providerId, model,
            input_tokens: usageNorm.prompt_tokens, output_tokens: usageNorm.completion_tokens,
            cached_tokens: usageNorm.cached_tokens, cache_write_tokens: usageNorm.cache_write_tokens,
            cost: priced.cost, saved_cost: priced.savedCost, pricing_known: priced.known, pricing_source: priced.source,
            cached: false, response_time: Date.now() - reqStart,
          })
          eventBus.emit('request:log', {
            type: 'stream', method: 'POST', path: req.path, provider: providerId, model, backendUrl: url,
            tokens: { prompt: usageNorm.prompt_tokens, completion: usageNorm.completion_tokens, total: usageNorm.total_tokens },
            cost: priced.cost, savedCost: priced.savedCost, pricingKnown: priced.known,
            cached: false, status: 200, responseTime: Date.now() - reqStart,
          })
        } catch (e) { console.error('Stream stats error:', e.message) }
        res.end()
      })
      response.data.on('error', (err) => {
        console.error('Stream error:', err.message)
        eventBus.emit('request:complete', { provider: providerId, model, input_tokens: 0, output_tokens: 0, cached: false, response_time: Date.now() - reqStart })
        if (!res.headersSent) res.status(500).json(openaiError(err.message, 'api_error', 'stream_error')); else res.end()
      })
    }).catch(error => {
      // 部分上游不接受 stream_options：仅在这种情况下降级重试一次，不再注入
      if (withStreamOptions && usageTools.isStreamOptionsRejection(error)) {
        console.warn('[router] upstream rejected stream_options; retrying without usage injection')
        return start(false)
      }
      eventBus.emit('request:log', { type: 'error', method: 'POST', path: req.path, provider: providerId, model, error: error.message, status: error.response?.status || 500, responseTime: Date.now() - reqStart })
      if (!res.headersSent) {
        res.status(error.response?.status || 500).json(error.response?.data && typeof error.response.data === 'object'
          ? error.response.data
          : openaiError(error.message, 'api_error', 'upstream_error'))
      } else res.end()
    })
  }

  start(useStreamOptions)
}

module.exports = { createRoutes, ALLOWED_V1_PATHS, validateTargetBaseUrl, openaiError, upstreamAuthHeader }
