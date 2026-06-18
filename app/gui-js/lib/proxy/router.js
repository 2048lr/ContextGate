const { VERSION } = require('../core/constants')
const { resolveApiKey } = require('./forwarder')
const { axiosRetry, buildAxiosConfig } = require('./forwarder')
const { extractMsgPreview } = require('./stream-handler')
const { calculateCost } = require('../monitor/cost-calculator')

const ALLOWED_V1_PATHS = [
  '/v1/chat/completions', '/v1/completions', '/v1/embeddings',
  '/v1/models', '/v1/images/generations', '/v1/audio/transcriptions',
  '/v1/audio/translations', '/v1/audio/speech', '/v1/moderations',
]

function createRoutes(app, svc) {
  const { cacheManager, configManager, providerRegistry, eventBus } = svc

  app.use(require('express').json())
  app.use((req, _res, next) => { console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`); next() })

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', provider: 'ContextGate', version: VERSION })
  })

  app.get('/v1', (_req, res) => {
    res.json({ status: 'ok', service: 'ContextGate Proxy', base_url: '/v1', routes: ALLOWED_V1_PATHS })
  })

  app.get('/v1/models', async (req, res) => {
    try {
      // 支持 X-Target-Base-Url header，用于前端获取任意 base_url 的模型列表
      const targetBaseUrl = req.headers['x-target-base-url']
      let providerConfig
      if (targetBaseUrl) {
        providerConfig = { base_url: targetBaseUrl.replace(/\/+$/, ''), api_key: '', passthrough_auth: true, format: 'openai' }
      } else {
        const provider = req.query.provider || configManager.getDefaultProvider() || 'openai'
        providerConfig = providerRegistry.resolveProvider(provider, configManager.getProvider(provider))
      }
      if (!providerConfig.base_url) return res.status(400).json({ error: 'Unknown provider' })
      const resolved = resolveApiKey(providerConfig, req.headers.authorization)
      if (resolved.error) return res.status(401).json({ error: resolved.error })
      const response = await axiosRetry(buildAxiosConfig(providerConfig, {
        method: 'GET', url: `${providerConfig.base_url}/models`,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resolved.key}` },
      }))
      res.json(response.data)
    } catch (error) {
      res.status(error.response?.status || 500).json({ error: error.message })
    }
  })

  app.all('/v1/*', async (req, res) => {
    // 规范化路径，移除尾部斜杠以匹配允许列表
    const normalizedPath = req.path.endsWith('/') && req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path
    if (!ALLOWED_V1_PATHS.includes(normalizedPath)) {
      return res.status(403).json({ error: 'Path not allowed', allowed: ALLOWED_V1_PATHS })
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
        return res.status(400).json({ error: `Unknown provider: ${providerId}` })
      }
      const backendUrl = providerConfig.base_url.replace(/\/+$/, '') + '/' + backendPath.replace(/^\/+/, '')

      const cacheKey = cacheManager.getCacheKey(req, cacheManager.getContextHash())
      if (cacheManager.has(cacheKey)) {
        const cached = cacheManager.get(cacheKey)
        const usage = cached._usage || cached.usage || {}
        eventBus.emit('request:complete', { provider: providerId, model, input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0, cached: true, response_time: 0 })
        eventBus.emit('request:log', { type: 'response', method: req.method, path: req.path, provider: providerId, model, backendUrl, requestSize: reqSize, messagePreview: msgPreview, tokens: { prompt: usage.prompt_tokens || 0, completion: usage.completion_tokens || 0, total: usage.total_tokens || 0 }, cost: calculateCost(model, usage.prompt_tokens || 0, usage.completion_tokens || 0), cached: true, status: 200, responseTime: Date.now() - reqStart })
        if (cached._sseEvents) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Cache': 'HIT' })
          return res.end(require('./stream-handler').serializeSSEEvents(cached._sseEvents))
        }
        if (cached._streamChunks) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Cache': 'HIT' })
          for (const chunk of cached._streamChunks) res.write(chunk)
          return res.end()
        }
        res.setHeader('X-Cache', 'HIT')
        return res.json(cached)
      }

      if (isStream) {
        return handleStreamProxy(providerConfig, providerId, model, messages, body, req, res, cacheKey, reqStart, svc, backendUrl)
      }

      const { forwardRequest } = require('./forwarder')
      const response = await forwardRequest(providerConfig, backendPath, body, req.headers)
      const responseTime = Date.now() - reqStart
      const usage = response.data?.usage
      if (response.data && cacheManager.shouldCache(req.method)) cacheManager.set(cacheKey, response.data)
      eventBus.emit('request:complete', { provider: providerId, model, input_tokens: usage?.prompt_tokens || 0, output_tokens: usage?.completion_tokens || 0, cached: false, response_time: responseTime })
      eventBus.emit('request:log', { type: 'response', method: req.method, path: req.path, provider: providerId, model, backendUrl, requestSize: reqSize, messagePreview: msgPreview, tokens: { prompt: usage?.prompt_tokens || 0, completion: usage?.completion_tokens || 0, total: usage?.total_tokens || 0 }, cost: calculateCost(model, usage?.prompt_tokens || 0, usage?.completion_tokens || 0), cached: false, status: response.status, responseTime })
      res.json(response.data)
    } catch (error) {
      const responseTime = Date.now() - reqStart
      eventBus.emit('request:log', { type: 'error', method: req.method, path: req.path, provider: '', model, requestSize: reqSize, messagePreview: msgPreview, error: error.message, status: error.response?.status || 500, responseTime })
      res.status(error.response?.status || 500).json({ error: error.message, details: error.response?.data })
    }
  })

  app.post('/proxy/chat', async (req, res) => {
    const reqStart = Date.now()
    const { provider = 'openai', model, messages, ...options } = req.body || {}
    const reqSize = JSON.stringify(req.body || {}).length
    const msgPreview = extractMsgPreview(messages)
    cacheManager.invalidateIfNeeded(svc.contextFile, svc.projectRoot)
    const providerConfig = providerRegistry.resolveProvider(provider, configManager.getProvider(provider))
    if (!providerConfig.base_url) return res.status(400).json({ error: `Unknown provider: ${provider}` })
    const cacheKey = cacheManager.getCacheKey(req, cacheManager.getContextHash())
    if (cacheManager.has(cacheKey)) {
      const cached = cacheManager.get(cacheKey)
      const usage = cached._usage || cached.usage || {}
      const cost = calculateCost(model, usage.prompt_tokens || 0, usage.completion_tokens || 0)
      eventBus.emit('request:complete', { provider, model, input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0, cost, cached: true, response_time: 0 })
      eventBus.emit('request:log', { type: 'response', method: 'POST', path: req.path, provider, model, backendUrl: providerConfig.base_url, requestSize: reqSize, messagePreview: msgPreview, tokens: { prompt: usage.prompt_tokens || 0, completion: usage.completion_tokens || 0, total: usage.total_tokens || 0 }, cost, cached: true, status: 200, responseTime: Date.now() - reqStart })
      return res.json(cached)
    }
    try {
      const { forwardChatRequest } = require('./forwarder')
      const response = await forwardChatRequest(providerConfig, model, messages, options, req.headers)
      const usage = response.data?.usage
      const cost = calculateCost(model, usage?.prompt_tokens || 0, usage?.completion_tokens || 0)
      cacheManager.set(cacheKey, response.data)
      eventBus.emit('request:complete', { provider, model, input_tokens: usage?.prompt_tokens || 0, output_tokens: usage?.completion_tokens || 0, cost, cached: false, response_time: Date.now() - reqStart })
      eventBus.emit('request:log', { type: 'response', method: 'POST', path: req.path, provider, model, backendUrl: providerConfig.base_url, requestSize: reqSize, messagePreview: msgPreview, tokens: { prompt: usage?.prompt_tokens || 0, completion: usage?.completion_tokens || 0, total: usage?.total_tokens || 0 }, cost, cached: false, status: response.status, responseTime: Date.now() - reqStart })
      res.json(response.data)
    } catch (error) {
      eventBus.emit('request:log', { type: 'error', method: 'POST', path: req.path, provider, model, requestSize: reqSize, messagePreview: msgPreview, error: error.message, status: error.response?.status || 500, responseTime: Date.now() - reqStart })
      res.status(500).json({ error: error.message })
    }
  })

  app.get('/stats', (_req, res) => {
    res.json({ cacheSize: cacheManager.size, contextHash: cacheManager.getContextHash(), uptime: process.uptime() })
  })

  app.get('/context/hash', (_req, res) => {
    cacheManager.loadContextSignature(svc.contextFile, svc.projectRoot)
    const sig = cacheManager.contextSignature
    res.json({ contextFile: svc.contextFile, hash: sig?.mainHash || null, combinedHash: sig?.combinedHash || null, fileCount: sig?.fileCount || 0 })
  })

  app.delete('/cache', (_req, res) => { cacheManager.clear(); res.json({ success: true }) })

  app.get('/providers', (_req, res) => {
    try { res.json({ providers: providerRegistry.getAvailableProviders() }) }
    catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.get('/providers/:id/models', (req, res) => {
    try { res.json({ provider: req.params.id, models: providerRegistry.getModelsFromModelsDev(req.params.id) }) }
    catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.get('/providers/:id/models/recommended', (req, res) => {
    try {
      const models = providerRegistry.getModelsFromModelsDev(req.params.id)
      res.json({ provider: req.params.id, models: models.slice(0, 20) })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.get('/models/search', (req, res) => {
    try {
      const q = req.query.q || ''
      if (!q) return res.json({ results: [] })
      res.json({ query: q, results: require('./models-dev').searchModels(q, providerRegistry.modelsDevData) })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.get('/models/:providerId/:modelId/cost', (req, res) => {
    try {
      const cost = providerRegistry.enrichProviderWithCost(req.params.providerId, req.params.modelId)
      if (!cost) return res.status(404).json({ error: 'Model not found' })
      res.json({ provider: req.params.providerId, model: req.params.modelId, cost })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })
}

function handleStreamProxy(providerConfig, providerId, model, messages, body, req, res, cacheKey, reqStart, svc, backendUrl) {
  const { axiosInstance, buildAxiosConfig, resolveApiKey } = require('./forwarder')
  const { parseSSEChunks } = require('./stream-handler')
  const url = backendUrl || `${providerConfig.base_url}/chat/completions`
  const resolved = resolveApiKey(providerConfig, req.headers?.authorization)
  if (resolved.error) return res.status(401).json({ error: resolved.error })

  axiosInstance({
    ...buildAxiosConfig(providerConfig, {
      method: 'POST', url,
      data: { ...body, model, messages, stream: true },
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resolved.key}` },
      responseType: 'stream',
    }),
  }).then(response => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Cache': 'MISS' })
    const rawChunks = []
    let lastChunkData = ''
    response.data.on('data', (chunk) => {
      rawChunks.push(chunk)
      res.write(chunk)
      const text = chunk.toString()
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') lastChunkData = line.substring(6)
      }
    })
    response.data.on('end', () => {
      // usage 解析单独包裹，解析失败不应影响后续缓存与统计
      let usage = {}
      if (lastChunkData) {
        try { const parsed = JSON.parse(lastChunkData); usage = parsed.usage || parsed }
        catch (e) { console.error('Stream usage parse error:', e.message) }
      }
      const inputTokens = usage.prompt_tokens || 0
      const outputTokens = usage.completion_tokens || 0
      const cost = calculateCost(model, inputTokens, outputTokens)
      try {
        const sseEvents = parseSSEChunks(rawChunks)
        svc.cacheManager.set(cacheKey, { _sseEvents: sseEvents, _usage: usage })
      } catch (e) { console.error('Stream cache error:', e.message) }
      try {
        svc.eventBus.emit('request:complete', { provider: providerId, model, input_tokens: inputTokens, output_tokens: outputTokens, cost, cached: false, response_time: Date.now() - reqStart })
        // 发送带最终 tokens 和 cost 的日志事件，供 UI 显示
        svc.eventBus.emit('request:log', { type: 'stream', method: 'POST', path: req.path, provider: providerId, model, backendUrl: url, tokens: { prompt: inputTokens, completion: outputTokens, total: usage.total_tokens || inputTokens + outputTokens }, cost, cached: false, status: 200, responseTime: Date.now() - reqStart })
      } catch (e) { console.error('Stream stats error:', e.message) }
      res.end()
    })
    response.data.on('error', (err) => {
      console.error('Stream error:', err.message)
      svc.eventBus.emit('request:complete', { provider: providerId, model, input_tokens: 0, output_tokens: 0, cached: false, response_time: Date.now() - reqStart })
      if (!res.headersSent) res.status(500).json({ error: err.message }); else res.end()
    })
  }).catch(error => {
    svc.eventBus.emit('request:log', { type: 'error', method: 'POST', path: req.path, provider: providerId, model, error: error.message, status: error.response?.status || 500, responseTime: Date.now() - reqStart })
    if (!res.headersSent) res.status(500).json({ error: error.message })
    else res.end()
  })
}

module.exports = { createRoutes, ALLOWED_V1_PATHS }
