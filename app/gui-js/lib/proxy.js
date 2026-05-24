const express = require('express')
const axios = require('axios')
const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')
const crypto = require('crypto')
const { CodeScanner, ContextExtractor } = require('./scanner')
const { VERSION } = require('./config')

const CONTEXT_HASH_FILE = '.context_hash'

const sharedHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30000,
  rejectUnauthorized: true,
  minVersion: 'TLSv1.2',
  ciphers: 'HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA@STRENGTH'
})

const insecureHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30000,
  rejectUnauthorized: false,
  minVersion: 'TLSv1.2'
})

const sharedHttpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30000
})

const axiosInstance = axios.create({
  httpAgent: sharedHttpAgent,
  httpsAgent: sharedHttpsAgent,
  maxRedirects: 5,
  decompress: true,
  transitional: { silentJSONParsing: true, forcedJSONParsing: true, clarifyTimeoutError: true }
})

async function axiosRetry(config, retries) {
  retries = retries || 2
  let lastErr = null
  for (let i = 0; i <= retries; i++) {
    try {
      return await axiosInstance(config)
    } catch (err) {
      lastErr = err
      const code = err.code || ''
      if (['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code) && i < retries) {
        const delay = Math.min(500 * Math.pow(2, i), 3000)
        console.log(`[Retry ${i + 1}/${retries}] ${code} - waiting ${delay}ms`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      throw err
    }
  }
  throw lastErr
}

function computeFileHash(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    const content = fs.readFileSync(filePath)
    return crypto.createHash('sha1').update(content).digest('hex')
  } catch (e) {
    return null
  }
}

function loadSavedContextHash(contextDir) {
  const hashFile = path.join(contextDir, CONTEXT_HASH_FILE)
  try {
    if (fs.existsSync(hashFile)) {
      return fs.readFileSync(hashFile, 'utf8').trim()
    }
  } catch (e) {}
  return null
}

function saveContextHash(contextDir, hash) {
  const hashFile = path.join(contextDir, CONTEXT_HASH_FILE)
  try {
    fs.writeFileSync(hashFile, hash, 'utf8')
  } catch (e) {}
}

function getContextFilesList(contextFile) {
  if (!contextFile || !fs.existsSync(contextFile)) return []
  try {
    const dir = path.dirname(contextFile)
    const lines = fs.readFileSync(contextFile, 'utf8').split('\n')
    const files = []
    let currentFile = null
    for (const line of lines) {
      const fileMatch = line.match(/^# File: (.+)$/)
      if (fileMatch) {
        currentFile = fileMatch[1]
        files.push({ path: currentFile, hash: null })
      }
    }
    return files
  } catch (e) {
    return []
  }
}

function computeContextSignature(contextFile, projectRoot) {
  try {
    if (!fs.existsSync(contextFile)) return null
    const dir = path.dirname(contextFile)
    const content = fs.readFileSync(contextFile, 'utf8')
    const mainHash = crypto.createHash('sha1').update(content).digest('hex')
    const files = []
    let currentFile = null
    for (const line of content.split('\n')) {
      const fileMatch = line.match(/^# File: (.+)$/)
      if (fileMatch) {
        currentFile = fileMatch[1]
        files.push(currentFile)
      }
    }
    const fileHashes = {}
    for (const fileRelPath of files) {
      if (!projectRoot) continue
      const absPath = path.join(projectRoot, fileRelPath)
      const hash = computeFileHash(absPath)
      if (hash) {
        fileHashes[fileRelPath] = hash
      }
    }
    const combinedHash = crypto
      .createHash('sha1')
      .update(JSON.stringify(fileHashes))
      .digest('hex')
    return { mainHash, combinedHash, fileHashes, fileCount: files.length, files, file: contextFile }
  } catch (e) {
    return null
  }
}

class ConfigManager {
  constructor(configPath) {
    this.configPath = configPath
    this.config = this._load()
  }

  _load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const content = fs.readFileSync(this.configPath, 'utf8')
        return yaml.load(content) || {}
      }
    } catch (e) {
      console.error('Failed to load config:', e)
    }
    return {}
  }

  save() {
    try {
      const yamlStr = yaml.dump(this.config, { lineWidth: -1 })
      fs.writeFileSync(this.configPath, yamlStr, 'utf8')
      return true
    } catch (e) {
      console.error('Failed to save config:', e)
      return false
    }
  }

  getWorkspace() {
    return this.config.workspace || null
  }

  setWorkspace(workspacePath) {
    this.config.workspace = workspacePath
    return this.save()
  }

  getProvider(providerName) {
    const providers = this.config.providers || {}
    return providers[providerName] || null
  }

  getDefaultProvider() {
    return this.config.default_provider || null
  }

  getAllProviders() {
    return this.config.providers || {}
  }

  getProxyConfig() {
    return this.config.proxy || { host: '127.0.0.1', port: 12306 }
  }

  getMonitorConfig() {
    return this.config.monitor || { enabled: true, monthly_limit: 100 }
  }

  getCurrencyConfig() {
    return this.config.currency || { currency: 'USD', exchange_rates: {} }
  }
}

class LRUCache {
  constructor(maxSize = 200, maxMemoryMB = 100) {
    this.maxSize = maxSize
    this.maxMemory = maxMemoryMB * 1024 * 1024
    this.cache = new Map()
    this.currentMemory = 0
  }

  get(key) {
    if (!this.cache.has(key)) return undefined
    const entry = this.cache.get(key)
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.value
  }

  set(key, value) {
    if (this.cache.has(key)) {
      const oldEntry = this.cache.get(key)
      this.currentMemory -= oldEntry.size
      this.cache.delete(key)
    }
    const size = this._estimateSize(value)
    while ((this.cache.size >= this.maxSize || this.currentMemory + size > this.maxMemory) && this.cache.size > 0) {
      const oldestKey = this.cache.keys().next().value
      const oldestEntry = this.cache.get(oldestKey)
      this.currentMemory -= oldestEntry.size
      this.cache.delete(oldestKey)
    }
    this.cache.set(key, { value, size })
    this.currentMemory += size
  }

  has(key) {
    return this.cache.has(key)
  }

  clear() {
    this.cache.clear()
    this.currentMemory = 0
  }

  get size() {
    return this.cache.size
  }

  _estimateSize(value) {
    if (!value) return 0
    if (value._sseEvents) {
      try {
        return Buffer.byteLength(JSON.stringify(value._sseEvents), 'utf8') + 1024
      } catch (e) {
        return value._sseEvents.length * 512 + 1024
      }
    }
    if (value._streamChunks) {
      let chunksSize = 0
      for (const chunk of value._streamChunks) {
        chunksSize += chunk.length || chunk.byteLength || 0
      }
      return chunksSize + 1024
    }
    try {
      return Buffer.byteLength(JSON.stringify(value), 'utf8')
    } catch (e) {
      return 10240
    }
  }
}

class AIProxy {
  constructor(options) {
    this.contextFile = options.contextFile
    this.configPath = options.configPath
    this.projectRoot = options.projectRoot || null
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
    this._setupRoutes()
    this._loadContextSignature()
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

  _extractMsgPreview(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return ''
    const last = messages[messages.length - 1]
    if (!last || !last.content) return ''
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
    return text.length > 80 ? text.substring(0, 80) + '…' : text
  }

  _loadContextSignature() {
    if (this.contextFile && fs.existsSync(this.contextFile)) {
      this.contextSignature = computeContextSignature(this.contextFile, this.projectRoot)
    }
  }

  _getContextHash() {
    this._loadContextSignature()
    if (!this.contextSignature) return 'none'
    return this.contextSignature.combinedHash || this.contextSignature.mainHash
  }

  _checkContextChanged() {
    const newSignature = computeContextSignature(this.contextFile, this.projectRoot)
    if (!newSignature) return false
    if (!this.contextSignature) return true
    return newSignature.combinedHash !== this.contextSignature.combinedHash ||
           newSignature.mainHash !== this.contextSignature.mainHash
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
        const response = await axiosRetry(this._buildAxiosConfig(providerConfig, {
          method: 'GET',
          url: `${providerConfig.base_url}/models`,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${providerConfig.api_key}`
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

    const ALLOWED_V1_PATHS = [
      '/v1/chat/completions',
      '/v1/completions',
      '/v1/embeddings',
      '/v1/models',
      '/v1/images/generations',
      '/v1/audio/transcriptions',
      '/v1/audio/translations',
      '/v1/audio/speech',
      '/v1/moderations'
    ]

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
        const provider = this._detectProvider(backendPath)
        const providerConfig = this.configManager.getProvider(provider)

        if (!providerConfig) {
          this._emitLog({
            type: 'error', method: reqMethod, path: req.path,
            provider, model, requestSize: reqSize, messagePreview: this._extractMsgPreview(messages),
            error: 'Unknown provider: ' + provider, status: 400, responseTime: Date.now() - reqStart
          })
          return res.status(400).json({ error: `Unknown provider: ${provider}` })
        }

        const backendUrl = (providerConfig.base_url || '').replace(/\/+$/, '') + '/' + backendPath.replace(/^\/+/, '')
        const msgPreview = this._extractMsgPreview(messages)

        const cacheKey = this._getCacheKey(req)
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
            const serialized = this._serializeSSEEvents(cachedData._sseEvents)
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

        const response = await this._forwardRequest(providerConfig, backendPath, body)
        const responseTime = Date.now() - reqStart
        const respUsage = response.data && response.data.usage

        if (response.data && this._shouldCache(reqMethod)) {
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
          messagePreview: this._extractMsgPreview(messages),
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
      const msgPreview = this._extractMsgPreview(messages)

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

      const cacheKey = this._getCacheKey(req)
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
        const response = await this._forwardChatRequest(providerConfig, model, messages, options)
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
  }

  _detectProvider(backendPath) {
    const lowerPath = backendPath.toLowerCase()
    if (lowerPath.includes('zhipu')) return 'zhipu'
    if (lowerPath.includes('deepseek')) return 'deepseek'
    if (lowerPath.includes('openai')) return 'openai'
    const defaultProvider = this.configManager.getDefaultProvider()
    if (defaultProvider) return defaultProvider
    const allProviders = this.configManager.getAllProviders()
    const providerNames = Object.keys(allProviders)
    if (providerNames.length === 1) return providerNames[0]
    for (const [name, config] of Object.entries(allProviders)) {
      if (config.base_url && lowerPath.includes(name.toLowerCase())) return name
    }
    return 'openai'
  }

  _getAgent(providerConfig) {
    const baseUrl = (providerConfig.base_url || '').toLowerCase()
    const isInsecure = providerConfig.tls && providerConfig.tls.reject_unauthorized === false
    if (baseUrl.startsWith('https://')) {
      return isInsecure ? insecureHttpsAgent : sharedHttpsAgent
    }
    return sharedHttpAgent
  }

  _buildAxiosConfig(providerConfig, extra = {}) {
    const config = {
      ...extra,
      httpAgent: this._getAgent(providerConfig),
      httpsAgent: this._getAgent(providerConfig),
      timeout: providerConfig.timeout || 60000
    }
    return config
  }

  _getCacheKey(req) {
    const contextHash = this._getContextHash()
    const body = req.body || {}
    let msgFingerprint = ''
    if (body.messages && Array.isArray(body.messages)) {
      const lastUser = [...body.messages].reverse().find(m => m.role === 'user')
      if (lastUser && lastUser.content) {
        const text = typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)
        msgFingerprint = crypto.createHash('md5').update(text).digest('hex').substring(0, 12)
      }
    }
    const modelKey = body.model || 'unknown'
    if (!msgFingerprint) {
      msgFingerprint = crypto.createHash('md5').update(JSON.stringify(body)).digest('hex').substring(0, 12)
    }
    return `${req.method}:${req.path}:${modelKey}:${msgFingerprint}`
  }

  _shouldCache(method) {
    return ['GET', 'POST'].includes(method)
  }

  _invalidateCacheIfNeeded() {
    if (this._checkContextChanged()) {
      console.log('[Cache INVALIDATED] Source file changed')
      this.cache.clear()
      this._loadContextSignature()
    }
  }

  async _forwardRequest(providerConfig, backendPath, data) {
    const url = `${providerConfig.base_url}${backendPath}`
    try {
      const response = await axiosRetry(this._buildAxiosConfig(providerConfig, {
        method: 'POST',
        url,
        data,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${providerConfig.api_key}`
        }
      }))
      return response
    } catch (error) {
      throw error
    }
  }

  async _forwardChatRequest(providerConfig, model, messages, options) {
    const url = `${providerConfig.base_url}/chat/completions`
    try {
      const response = await axiosRetry(this._buildAxiosConfig(providerConfig, {
        method: 'POST',
        url,
        data: { model, messages, ...options },
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${providerConfig.api_key}`
        }
      }))
      return response
    } catch (error) {
      throw error
    }
  }

  _parseSSEChunks(rawChunks) {
    const events = []
    let buffer = ''
    for (const chunk of rawChunks) {
      buffer += chunk.toString()
    }
    const lines = buffer.split('\n')
    let currentEvent = { event: '', data: '', id: '', retry: '' }

    for (const line of lines) {
      if (line === '') {
        if (currentEvent.data || currentEvent.event) {
          events.push({ ...currentEvent })
        }
        currentEvent = { event: '', data: '', id: '', retry: '' }
        continue
      }
      if (line.startsWith('event:')) {
        currentEvent.event = line.substring(6).trim()
      } else if (line.startsWith('data:')) {
        currentEvent.data = line.substring(5).trim()
      } else if (line.startsWith('id:')) {
        currentEvent.id = line.substring(3).trim()
      } else if (line.startsWith('retry:')) {
        currentEvent.retry = line.substring(6).trim()
      }
    }
    if (currentEvent.data || currentEvent.event) {
      events.push({ ...currentEvent })
    }
    return events
  }

  _serializeSSEEvents(events) {
    let output = ''
    for (const evt of events) {
      if (evt.id) output += `id: ${evt.id}\n`
      if (evt.event) output += `event: ${evt.event}\n`
      if (evt.retry) output += `retry: ${evt.retry}\n`
      output += `data: ${evt.data}\n`
      output += '\n'
    }
    return output
  }

  _streamChatRequestCached(providerConfig, provider, model, messages, options, req, res, cacheKey, reqStart) {
    const url = `${providerConfig.base_url}/chat/completions`
    const rawChunks = []
    let lastChunkData = ''
    const backendUrl = url

    const msgPreview = this._extractMsgPreview(messages)
    this._emitLog({
      type: 'stream', method: 'POST', path: req.path,
      provider, model, backendUrl, requestSize: JSON.stringify(options || {}).length,
      messagePreview: msgPreview, status: 200, responseTime: Date.now() - reqStart
    })

    const axiosReq = axiosInstance({
      ...this._buildAxiosConfig(providerConfig, {
        method: 'POST',
        url,
        data: { model, messages, stream: true, ...options },
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${providerConfig.api_key}`
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
          const sseEvents = this._parseSSEChunks(rawChunks)
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

  async run(host = '127.0.0.1', port = 12306) {
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
