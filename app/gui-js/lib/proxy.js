const express = require('express')
const fs = require('fs')
const { CodeScanner, ContextExtractor } = require('./scanner')
const { VERSION, DEFAULT_PROXY_HOST, DEFAULT_PROXY_PORT } = require('./config')
const { LRUCache } = require('./lru-cache')
const { ConfigManager } = require('./proxy/config-manager')
const { computeContextSignature, checkContextChanged, getContextHash } = require('./proxy/context-signature')
const {
  axiosRetry, buildAxiosConfig, forwardRequest, forwardChatRequest,
  parseSSEChunks, serializeSSEEvents, extractMsgPreview, axiosInstance,
  getAgent, resolveApiKey
} = require('./proxy/forwarder')
const { ALLOWED_V1_PATHS, detectProvider, getCacheKey, shouldCache } = require('./proxy/routes')

class AIProxy {
  constructor(options) {
    this.contextFile = options.contextFile
    this.configPath = options.configPath
    this.projectRoot = options.projectRoot || null
    this.dataDir = options.dataDir || null
    this.configManager = new ConfigManager(this.configPath)
    this.dynamicContext = options.dynamicContext || false
    this.onRequestComplete = options.onRequestComplete || null
    this.onRequestLog = options.onRequestLog || null
    this.app = express()
    this.server = null
    this.cache = new LRUCache(
      options.cacheMaxEntries || 200,
      options.cacheMaxMemoryMB || 100
    )
    this.requestCount = 0
    this.contextSignature = null
    this._initialized = false
    this._initPromise = null
    this._setupRoutes()
    this._loadContextSignature()
  }

  async init() {
    if (this._initialized) return this
    if (this._initPromise) return this._initPromise
    this._initPromise = (async () => {
      await this.configManager.init(this.dataDir)
      this._initialized = true
    })()
    return this._initPromise
  }

  _recordRequest(provider, model, responseData, cached, responseTime) {
    if (!this.onRequestComplete) return
    try {
      const usage = responseData && responseData.usage
      this.onRequestComplete({
        provider: provider || 'unknown',
        model: model || 'unknown',
        input_tokens: (usage && usage.prompt_tokens) || 0,
        output_tokens: (usage && usage.completion_tokens) || 0,
        cost: 0,
        cached: !!cached,
        response_time: responseTime || 0
      })
    } catch (e) {
      console.error('Failed to record request:', e)
    }
  }

  _emitLog(data) {
    if (!this.onRequestLog) return
    try {
      this.onRequestLog(data)
    } catch (e) {
      console.error('Failed to emit log:', e)
    }
  }

  _loadContextSignature() {
    if (this.contextFile && fs.existsSync(this.contextFile)) {
      this.contextSignature = computeContextSignature(this.contextFile, this.projectRoot)
    }
  }

  _parseSSEChunks(rawChunks) {
    return parseSSEChunks(rawChunks)
  }

  _serializeSSEEvents(events) {
    return serializeSSEEvents(events)
  }

  _detectProvider(backendPath) {
    return detectProvider(backendPath, this.configManager)
  }

  _getAgent(providerConfig) {
    return getAgent(providerConfig)
  }

  _getContextHash() {
    this._loadContextSignature()
    return getContextHash(this.contextSignature)
  }

  _checkContextChanged() {
    const result = checkContextChanged(this.contextSignature, this.contextFile, this.projectRoot)
    return result.changed
  }

  _invalidateCacheIfNeeded() {
    const result = checkContextChanged(this.contextSignature, this.contextFile, this.projectRoot)
    if (result.changed) {
      console.log('[Cache INVALIDATED] Source file changed')
      this.cache.clear()
      this.contextSignature = result.signature
    }
  }

  _setupRoutes() {
    this.app.use(express.json())

    this.app.use((req, res, next) => {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`)
      next()
    })

    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', provider: 'ContextGate', version: VERSION })
    })

    this.app.get('/v1', (req, res) => {
      res.json({
        status: 'ok',
        service: 'ContextGate Proxy',
        base_url: '/v1',
        routes: ['ALL /v1/*', 'GET /v1', 'GET /v1/models', 'POST /proxy/chat'],
        cacheMode: 'smart',
        streamCaching: true
      })
    })

    this.app.get('/v1/models', async (req, res) => {
      try {
        const provider = req.query.provider || this.configManager.getDefaultProvider() || 'openai'
        const providerConfig = this.configManager.getProvider(provider)
        if (!providerConfig) {
          return res.status(400).json({ error: `Unknown provider: ${provider}` })
        }
        const resolved = resolveApiKey(providerConfig, req.headers.authorization)
        if (resolved.error) {
          return res.status(401).json({ error: resolved.error })
        }
        const response = await axiosRetry(buildAxiosConfig(providerConfig, {
          method: 'GET',
          url: `${providerConfig.base_url}/models`,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${resolved.key}`
          }
        }))
        res.json(response.data)
      } catch (error) {
        res.status(error.response?.status || 500).json({
          error: error.message,
          details: error.response?.data
        })
      }
    })

    this.app.all('/v1/*', async (req, res) => {
      if (!ALLOWED_V1_PATHS.includes(req.path)) {
        return res.status(403).json({
          error: 'Path not allowed',
          message: `Path ${req.path} is not in the allowed API endpoints whitelist`,
          allowed: ALLOWED_V1_PATHS
        })
      }

      const reqStart = Date.now()
      const body = req.body || (req.query || {})
      const reqSize = JSON.stringify(body).length
      const model = body.model || req.query.model || ''
      const messages = body.messages || []
      const isStream = !!(body.stream)
      const reqMethod = req.method

      try {
        this._invalidateCacheIfNeeded()

        const backendPath = req.path.replace('/v1/', '/')
        const provider = detectProvider(backendPath, this.configManager)
        const providerConfig = this.configManager.getProvider(provider)

        if (!providerConfig) {
          this._emitLog({
            type: 'error', method: reqMethod, path: req.path,
            provider, model, requestSize: reqSize, messagePreview: extractMsgPreview(messages),
            error: 'Unknown provider: ' + provider, status: 400, responseTime: Date.now() - reqStart
          })
          return res.status(400).json({ error: `Unknown provider: ${provider}` })
        }

        const backendUrl = (providerConfig.base_url || '').replace(/\/+$/, '') + '/' + backendPath.replace(/^\/+/, '')
        const msgPreview = extractMsgPreview(messages)

        const cacheKey = getCacheKey(req, this._getContextHash())
        if (this.cache.has(cacheKey)) {
          console.log(`[Cache HIT] ${cacheKey}`)
          const cachedData = this.cache.get(cacheKey)
          const cachedUsage = cachedData._usage || (cachedData.usage) || {}
          this._recordRequest(provider, model, { usage: cachedUsage }, true, 0)
          this._emitLog({
            type: 'response', method: reqMethod, path: req.path,
            provider, model, backendUrl, requestSize: reqSize,
            messagePreview: msgPreview,
            tokens: { prompt: cachedUsage.prompt_tokens || 0, completion: cachedUsage.completion_tokens || 0, total: cachedUsage.total_tokens || 0 },
            cached: true, status: 200, responseTime: Date.now() - reqStart
          })

          if (cachedData._sseEvents) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'X-Accel-Buffering': 'no',
              'X-Cache': 'HIT'
            })
            const serialized = serializeSSEEvents(cachedData._sseEvents)
            res.write(serialized)
            return res.end()
          }

          if (cachedData._streamChunks) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'X-Accel-Buffering': 'no',
              'X-Cache': 'HIT'
            })
            for (const chunk of cachedData._streamChunks) {
              res.write(chunk)
            }
            return res.end()
          }

          res.setHeader('X-Cache', 'HIT')
          return res.json(cachedData)
        }

        if (isStream) {
          return this._streamChatRequestCached(
            providerConfig, provider, model, messages, body, req, res, cacheKey, reqStart
          )
        }

        const response = await forwardRequest(providerConfig, backendPath, body, req.headers)
        const responseTime = Date.now() - reqStart
        const respUsage = response.data && response.data.usage

        if (response.data && shouldCache(reqMethod)) {
          this.cache.set(cacheKey, response.data)
          console.log(`[Cache SET] ${cacheKey}`)
        }

        this.requestCount++
        this._recordRequest(provider, model, response.data, false, responseTime)
        this._emitLog({
          type: 'response', method: reqMethod, path: req.path,
          provider, model, backendUrl, requestSize: reqSize,
          messagePreview: msgPreview,
          tokens: { prompt: (respUsage && respUsage.prompt_tokens) || 0, completion: (respUsage && respUsage.completion_tokens) || 0, total: (respUsage && respUsage.total_tokens) || 0 },
          cached: false, status: response.status, responseTime
        })
        res.json(response.data)
      } catch (error) {
        const responseTime = Date.now() - reqStart
        console.error('Proxy error:', error.message)
        this._emitLog({
          type: 'error', method: reqMethod, path: req.path,
          provider: '', model, requestSize: reqSize,
          messagePreview: extractMsgPreview(messages),
          error: error.message, status: error.response ? error.response.status : 500, responseTime
        })
        res.status(error.response ? error.response.status : 500).json({
          error: error.message,
          details: error.response && error.response.data
        })
      }
    })

    this.app.post('/proxy/chat', async (req, res) => {
      const reqStart = Date.now()
      const reqSize = JSON.stringify(req.body || {}).length
      const { provider = 'openai', model, messages, ...options } = req.body
      const msgPreview = extractMsgPreview(messages)

      this._invalidateCacheIfNeeded()

      const providerConfig = this.configManager.getProvider(provider)
      if (!providerConfig) {
        this._emitLog({
          type: 'error', method: 'POST', path: '/proxy/chat',
          provider, model, requestSize: reqSize, messagePreview: msgPreview,
          error: 'Unknown provider: ' + provider, status: 400, responseTime: Date.now() - reqStart
        })
        return res.status(400).json({ error: `Unknown provider: ${provider}` })
      }

      const backendUrl = (providerConfig.base_url || '').replace(/\/+$/, '') + '/chat/completions'

      const cacheKey = getCacheKey(req, this._getContextHash())
      if (this.cache.has(cacheKey)) {
        const cachedData = this.cache.get(cacheKey)
        const cachedUsage = cachedData && cachedData.usage
        this._recordRequest(provider, model, cachedData, true, 0)
        this._emitLog({
          type: 'response', method: 'POST', path: '/proxy/chat',
          provider, model, backendUrl, requestSize: reqSize,
          messagePreview: msgPreview,
          tokens: { prompt: (cachedUsage && cachedUsage.prompt_tokens) || 0, completion: (cachedUsage && cachedUsage.completion_tokens) || 0, total: (cachedUsage && cachedUsage.total_tokens) || 0 },
          cached: true, status: 200, responseTime: Date.now() - reqStart
        })
        return res.json(cachedData)
      }

      try {
        const response = await forwardChatRequest(providerConfig, model, messages, options, req.headers)
        const responseTime = Date.now() - reqStart
        const respUsage = response.data && response.data.usage
        this.cache.set(cacheKey, response.data)
        this.requestCount++
        this._recordRequest(provider, model, response.data, false, responseTime)
        this._emitLog({
          type: 'response', method: 'POST', path: '/proxy/chat',
          provider, model, backendUrl, requestSize: reqSize,
          messagePreview: msgPreview,
          tokens: { prompt: (respUsage && respUsage.prompt_tokens) || 0, completion: (respUsage && respUsage.completion_tokens) || 0, total: (respUsage && respUsage.total_tokens) || 0 },
          cached: false, status: response.status, responseTime
        })
        res.json(response.data)
      } catch (error) {
        const responseTime = Date.now() - reqStart
        this._emitLog({
          type: 'error', method: 'POST', path: '/proxy/chat',
          provider, model, requestSize: reqSize, messagePreview: msgPreview,
          error: error.message, status: error.response ? error.response.status : 500, responseTime
        })
        res.status(500).json({ error: error.message })
      }
    })

    this.app.get('/stats', (req, res) => {
      res.json({
        requestCount: this.requestCount,
        cacheSize: this.cache.size,
        contextHash: this._getContextHash(),
        dynamicContext: this.dynamicContext,
        uptime: process.uptime()
      })
    })

    this.app.get('/context/hash', (req, res) => {
      this._loadContextSignature()
      res.json({
        contextFile: this.contextFile,
        hash: this.contextSignature?.mainHash || null,
        combinedHash: this.contextSignature?.combinedHash || null,
        fileCount: this.contextSignature?.fileCount || 0,
        changed: this._checkContextChanged()
      })
    })

    this.app.delete('/cache', (req, res) => {
      this.cache.clear()
      res.json({ success: true })
    })

    this.app.get('/providers', (req, res) => {
      try {
        const providers = this.configManager.getAvailableCatalogProviders()
        res.json({ providers })
      } catch (error) {
        res.status(500).json({ error: error.message })
      }
    })

    this.app.get('/providers/:id/models', (req, res) => {
      try {
        const providerId = req.params.id
        const models = this.configManager.getModelsFromCatalog(providerId)
        res.json({ provider: providerId, models })
      } catch (error) {
        res.status(500).json({ error: error.message })
      }
    })

    this.app.get('/providers/:id/models/recommended', (req, res) => {
      try {
        const providerId = req.params.id
        const models = this.configManager.getRecommendedModels(providerId)
        res.json({ provider: providerId, models })
      } catch (error) {
        res.status(500).json({ error: error.message })
      }
    })

    this.app.get('/models/search', (req, res) => {
      try {
        const q = req.query.q || ''
        if (!q) return res.json({ results: [] })
        const results = this.configManager.searchCatalogModels(q)
        res.json({ query: q, results })
      } catch (error) {
        res.status(500).json({ error: error.message })
      }
    })

    this.app.get('/models/:providerId/:modelId/cost', (req, res) => {
      try {
        const { providerId, modelId } = req.params
        const cost = this.configManager.getModelCostInfo(providerId, modelId)
        if (!cost) return res.status(404).json({ error: 'Model not found' })
        res.json({ provider: providerId, model: modelId, cost })
      } catch (error) {
        res.status(500).json({ error: error.message })
      }
    })
  }

  _streamChatRequestCached(providerConfig, provider, model, messages, options, req, res, cacheKey, reqStart) {
    const url = `${providerConfig.base_url}/chat/completions`
    const rawChunks = []
    let lastChunkData = ''
    const backendUrl = url

    const msgPreview = extractMsgPreview(messages)
    this._emitLog({
      type: 'stream', method: 'POST', path: req.path,
      provider, model, backendUrl, requestSize: JSON.stringify(options || {}).length,
      messagePreview: msgPreview, status: 200, responseTime: Date.now() - reqStart
    })

    const resolved = resolveApiKey(providerConfig, req.headers && req.headers.authorization)
    if (resolved.error) {
      this._emitLog({
        type: 'error', method: 'POST', path: req.path,
        provider, model, requestSize: 0,
        messagePreview: msgPreview,
        error: resolved.error, status: 401, responseTime: Date.now() - reqStart
      })
      return res.status(401).json({ error: resolved.error })
    }

    const axiosReq = axiosInstance({
      ...buildAxiosConfig(providerConfig, {
        method: 'POST',
        url,
        data: { model, messages, stream: true, ...options },
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${resolved.key}`
        },
        responseType: 'stream'
      })
    })

    axiosReq.then(response => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Cache': 'MISS'
      })

      response.data.on('data', (chunk) => {
        rawChunks.push(chunk)
        res.write(chunk)
        const text = chunk.toString()
        const lines = text.split('\n')
        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            lastChunkData = line.substring(6)
          }
        }
      })

      response.data.on('end', () => {
        try {
          let usage = {}
          if (lastChunkData) {
            const parsed = JSON.parse(lastChunkData)
            usage = parsed.usage || parsed
            const responseTime = Date.now() - reqStart
            this._recordRequest(provider, model, parsed, false, responseTime)
          }
          const sseEvents = parseSSEChunks(rawChunks)
          this.cache.set(cacheKey, { _sseEvents: sseEvents, _usage: usage })
          console.log(`[Cache SET stream] ${cacheKey} (${sseEvents.length} events)`)
        } catch (e) {
          console.error('Failed to parse stream usage:', e)
        }
        this.requestCount++
        res.end()
      })

      response.data.on('error', (err) => {
        console.error('Stream error:', err.message)
        res.end()
      })
    }).catch(error => {
      console.error('Stream request error:', error.message)
      const responseTime = Date.now() - reqStart
      this._emitLog({
        type: 'error', method: 'POST', path: req.path,
        provider, model, requestSize: 0,
        messagePreview: msgPreview,
        error: error.message, status: error.response ? error.response.status : 500, responseTime
      })
      res.status(500).json({ error: error.message })
    })
  }

  async run(host = DEFAULT_PROXY_HOST, port = DEFAULT_PROXY_PORT) {
    await this.init()
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(port, host, () => {
        resolve({ port, host })
      })
      this.server.on('error', reject)
    })
  }

  stop() {
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }
}

module.exports = { AIProxy, ConfigManager }
