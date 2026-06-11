const axios = require('axios')
const https = require('https')
const http = require('http')

/**
 * @typedef {import('./config-manager').ProviderConfig} ProviderConfig
 */

/**
 * @typedef {Object} SSEEvent
 * @property {string} event - Event type
 * @property {string} data - Event data payload
 * @property {string} id - Event ID
 * @property {string} retry - Retry interval
 */

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

/** @type {import('axios').AxiosInstance} */
const axiosInstance = axios.create({
  httpAgent: sharedHttpAgent,
  httpsAgent: sharedHttpsAgent,
  maxRedirects: 5,
  decompress: true,
  transitional: { silentJSONParsing: true, forcedJSONParsing: true, clarifyTimeoutError: true }
})

/**
 * Execute an axios request with automatic retry on transient errors.
 * @param {import('axios').AxiosRequestConfig} config - Axios request configuration
 * @param {number} [retries=2] - Number of retry attempts
 * @returns {Promise<import('axios').AxiosResponse>}
 */
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

/**
 * Select the appropriate HTTP agent based on provider configuration.
 * @param {ProviderConfig} providerConfig
 * @returns {https.Agent|http.Agent}
 */
function getAgent(providerConfig) {
  const baseUrl = (providerConfig.base_url || '').toLowerCase()
  const isInsecure = providerConfig.tls && providerConfig.tls.reject_unauthorized === false
  if (baseUrl.startsWith('https://')) {
    return isInsecure ? insecureHttpsAgent : sharedHttpsAgent
  }
  return sharedHttpAgent
}

/**
 * Build a complete axios configuration for a provider request.
 * @param {ProviderConfig} providerConfig
 * @param {import('axios').AxiosRequestConfig} [extra={}] - Additional axios config to merge
 * @returns {import('axios').AxiosRequestConfig}
 */
function buildAxiosConfig(providerConfig, extra = {}) {
  return {
    ...extra,
    httpAgent: getAgent(providerConfig),
    httpsAgent: getAgent(providerConfig),
    timeout: providerConfig.timeout || 60000
  }
}

const PLACEHOLDER_PATTERNS = [
  /^sk-xxx/i,
  /^sk-none$/i,
  /^sk-placeholder/i,
  /^sk-your/i,
  /^sk-test/i,
  /^your[-_]/i,
  /^placeholder/i,
  /^xxx+$/i,
  /^test[-_]?key/i,
  /^dummy/i,
  /^fake/i,
  /^changeme/i,
  /^replace[_-]?me/i,
  /^enter[_-]?your/i,
  /^insert[_-]?key/i,
  /^<.*>$/,
  /^$/,
]

function isPlaceholderKey(key) {
  if (!key || typeof key !== 'string') return true
  const trimmed = key.trim()
  if (trimmed.length === 0) return true
  return PLACEHOLDER_PATTERNS.some(pattern => pattern.test(trimmed))
}

function resolveApiKey(providerConfig, clientAuthHeader) {
  const proxyKey = (providerConfig.api_key || '').trim()
  let clientKey = ''
  if (clientAuthHeader && typeof clientAuthHeader === 'string') {
    clientKey = clientAuthHeader.replace(/^Bearer\s+/i, '').trim()
  }

  const proxyIsPlaceholder = isPlaceholderKey(proxyKey)
  const clientIsPlaceholder = isPlaceholderKey(clientKey)

  if (!proxyIsPlaceholder) {
    return { key: proxyKey, source: 'proxy' }
  }

  if (providerConfig.passthrough_auth && !clientIsPlaceholder) {
    return { key: clientKey, source: 'client' }
  }

  if (!clientIsPlaceholder) {
    return { key: clientKey, source: 'client' }
  }

  return { key: '', source: 'none', error: 'No valid API key: configure one in ContextGate settings or pass a real key from the client' }
}

/**
 * Forward a generic API request to the provider backend.
 * @param {ProviderConfig} providerConfig
 * @param {string} backendPath - API path (e.g. '/chat/completions')
 * @param {Object} data - Request body
 * @param {Object} [requestHeaders] - Original request headers from client
 * @returns {Promise<import('axios').AxiosResponse>}
 */
async function forwardRequest(providerConfig, backendPath, data, requestHeaders) {
  const url = `${providerConfig.base_url}${backendPath}`
  const resolved = resolveApiKey(providerConfig, requestHeaders && requestHeaders.authorization)
  if (resolved.error) {
    const err = new Error(resolved.error)
    err.response = { status: 401, data: { error: resolved.error } }
    throw err
  }
  return axiosRetry(buildAxiosConfig(providerConfig, {
    method: 'POST',
    url,
    data,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${resolved.key}`
    }
  }))
}

/**
 * Forward a chat completion request to the provider backend.
 * @param {ProviderConfig} providerConfig
 * @param {string} model - Model identifier
 * @param {Array<Object>} messages - Chat messages array
 * @param {Object} [options] - Additional request options
 * @param {Object} [requestHeaders] - Original request headers from client
 * @returns {Promise<import('axios').AxiosResponse>}
 */
async function forwardChatRequest(providerConfig, model, messages, options, requestHeaders) {
  const url = `${providerConfig.base_url}/chat/completions`
  const resolved = resolveApiKey(providerConfig, requestHeaders && requestHeaders.authorization)
  if (resolved.error) {
    const err = new Error(resolved.error)
    err.response = { status: 401, data: { error: resolved.error } }
    throw err
  }
  return axiosRetry(buildAxiosConfig(providerConfig, {
    method: 'POST',
    url,
    data: { model, messages, ...options },
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${resolved.key}`
    }
  }))
}

/**
 * Parse raw SSE chunks into structured event objects.
 * @param {Array<Buffer|string>} rawChunks - Raw SSE data chunks
 * @returns {SSEEvent[]} Parsed SSE events
 */
function parseSSEChunks(rawChunks) {
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
      const dataValue = line.substring(5).trim()
      currentEvent.data = currentEvent.data ? currentEvent.data + '\n' + dataValue : dataValue
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

/**
 * Serialize SSE events back to wire format.
 * @param {SSEEvent[]} events - SSE events to serialize
 * @returns {string} Serialized SSE text
 */
function serializeSSEEvents(events) {
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

/**
 * Extract a short preview of the last message in a chat messages array.
 * @param {Array<{content: string|Object}>} messages
 * @returns {string} Message preview text (max 80 chars)
 */
function extractMsgPreview(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return ''
  const last = messages[messages.length - 1]
  if (!last || !last.content) return ''
  const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
  return text.length > 80 ? text.substring(0, 80) + '…' : text
}

module.exports = {
  axiosInstance,
  axiosRetry,
  getAgent,
  buildAxiosConfig,
  forwardRequest,
  forwardChatRequest,
  parseSSEChunks,
  serializeSSEEvents,
  extractMsgPreview,
  isPlaceholderKey,
  resolveApiKey
}
