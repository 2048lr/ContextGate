const express = require('express')
const axios = require('axios')
const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')
const crypto = require('crypto')
const { CodeScanner, ContextExtractor } = require('./scanner')

const CONTEXT_HASH_FILE = '.context_hash'

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
    this.cache = new Map()
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
      res.json({ status: 'ok', provider: 'ContextGate', version: '3.1.0' })
    })

    this.app.get('/v1', (req, res) => {
      res.json({
        status: 'ok',
        service: 'ContextGate Proxy',
        base_url: '/v1',
        routes: ['GET /v1', 'GET /v1/models', 'POST /v1/chat/completions', 'POST /proxy/chat']
      })
    })

    this.app.get('/v1/models', async (req, res) => {
      try {
        const provider = req.query.provider || this.configManager.getDefaultProvider() || 'openai'
        const providerConfig = this.configManager.getProvider(provider)
        if (!providerConfig) {
          return res.status(400).json({ error: `Unknown provider: ${provider}` })
        }
        const response = await axios({
          method: 'GET',
          url: `${providerConfig.base_url}/models`,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${providerConfig.api_key}`
          },
          timeout: providerConfig.timeout || 60000
        })
        res.json(response.data)
      } catch (error) {
        res.status(error.response?.status || 500).json({
          error: error.message,
          details: error.response?.data
        })
      }
    })

    this.app.post('/v1/*', async (req, res) => {
      const reqStart = Date.now()
      const reqSize = JSON.stringify(req.body || {}).length
      const model = (req.body && req.body.model) || ''
      const messages = (req.body && req.body.messages) || []
      const isStream = !!(req.body && req.body.stream)

      try {
        this._invalidateCacheIfNeeded()

        const backendPath = req.path.replace('/v1/', '/')
        const provider = this._detectProvider(backendPath)
        const providerConfig = this.configManager.getProvider(provider)

        if (!providerConfig) {
          this._emitLog({
            type: 'error', method: 'POST', path: req.path,
            provider, model, requestSize: reqSize, messagePreview: this._extractMsgPreview(messages),
            error: 'Unknown provider: ' + provider, status: 400, responseTime: Date.now() - reqStart
          })
          return res.status(400).json({ error: `Unknown provider: ${provider}` })
        }

        const backendUrl = (providerConfig.base_url || '').replace(/\/+$/, '') + '/' + backendPath.replace(/^\/+/, '')
        const msgPreview = this._extractMsgPreview(messages)

        if (isStream) {
          this._emitLog({
            type: 'stream', method: 'POST', path: req.path,
            provider, model, backendUrl, requestSize: reqSize,
            messagePreview: msgPreview, status: 200, responseTime: Date.now() - reqStart
          })
          return this._streamChatRequest(
            providerConfig, provider, model, messages, req.body, req, res
          )
        }

        const cacheKey = this._getCacheKey(req)
        if (this.cache.has(cacheKey)) {
          console.log(`[Cache HIT] ${cacheKey}`)
          const cachedData = this.cache.get(cacheKey)
          const cachedUsage = cachedData && cachedData.usage
          this._recordRequest(provider, model, cachedData, true, 0)
          this._emitLog({
            type: 'response', method: 'POST', path: req.path,
            provider, model, backendUrl, requestSize: reqSize,
            messagePreview: msgPreview,
            tokens: { prompt: (cachedUsage && cachedUsage.prompt_tokens) || 0, completion: (cachedUsage && cachedUsage.completion_tokens) || 0, total: (cachedUsage && cachedUsage.total_tokens) || 0 },
            cached: true, status: 200, responseTime: Date.now() - reqStart
          })
          return res.json(cachedData)
        }

        const response = await this._forwardRequest(providerConfig, backendPath, req.body)
        const responseTime = Date.now() - reqStart
        const respUsage = response.data && response.data.usage

        if (response.data && this._shouldCache(req.method)) {
          this.cache.set(cacheKey, response.data)
          console.log(`[Cache SET] ${cacheKey}`)
        }

        this.requestCount++
        this._recordRequest(provider, model, response.data, false, responseTime)
        this._emitLog({
          type: 'response', method: 'POST', path: req.path,
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
          type: 'error', method: 'POST', path: req.path,
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
    return 'openai'
  }

  _getCacheKey(req) {
    const contextHash = this._getContextHash()
    const bodyHash = crypto.createHash('md5').update(JSON.stringify(req.body)).digest('hex').substring(0, 12)
    return `${req.method}:${req.path}:${contextHash.substring(0, 8)}:${bodyHash}`
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
      const response = await axios({
        method: 'POST',
        url,
        data,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${providerConfig.api_key}`
        },
        timeout: providerConfig.timeout || 60000
      })
      return response
    } catch (error) {
      // 重新抛出错误以便上层处理
      throw error
    }
  }

  async _forwardChatRequest(providerConfig, model, messages, options) {
    const url = `${providerConfig.base_url}/chat/completions`
    try {
      const response = await axios({
        method: 'POST',
        url,
        data: { model, messages, ...options },
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${providerConfig.api_key}`
        },
        timeout: providerConfig.timeout || 60000
      })
      return response
    } catch (error) {
      // 重新抛出错误以便上层处理
      throw error
    }
  }

  _streamChatRequest(providerConfig, provider, model, messages, options, req, res) {
    const url = `${providerConfig.base_url}/chat/completions`
    const requestStart = Date.now()

    const axiosReq = axios({
      method: 'POST',
      url,
      data: { model, messages, stream: true, ...options },
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${providerConfig.api_key}`
      },
      timeout: providerConfig.timeout || 60000,
      responseType: 'stream'
    })

    axiosReq.then(response => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      })

      let lastChunkData = ''
      response.data.on('data', (chunk) => {
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
          if (lastChunkData) {
            const parsed = JSON.parse(lastChunkData)
            const responseTime = Date.now() - requestStart
            this._recordRequest(provider, model, parsed, false, responseTime)
          }
        } catch (e) {
          console.error('Failed to parse stream usage:', e)
        }
        res.end()
      })

      response.data.on('error', (err) => {
        console.error('Stream error:', err.message)
        res.end()
      })
    }).catch(error => {
      console.error('Stream request error:', error.message)
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
