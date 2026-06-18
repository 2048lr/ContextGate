const axios = require('axios')
const https = require('https')
const http = require('http')

const sharedHttpsAgent = new https.Agent({
  keepAlive: true, keepAliveMsecs: 30000,
  maxSockets: 50, maxFreeSockets: 10, timeout: 30000,
  rejectUnauthorized: true, minVersion: 'TLSv1.2',
})

const insecureHttpsAgent = new https.Agent({
  keepAlive: true, keepAliveMsecs: 30000,
  maxSockets: 50, maxFreeSockets: 10, timeout: 30000,
  rejectUnauthorized: false, minVersion: 'TLSv1.2',
})

const sharedHttpAgent = new http.Agent({
  keepAlive: true, keepAliveMsecs: 30000,
  maxSockets: 50, maxFreeSockets: 10, timeout: 30000,
})

const axiosInstance = axios.create({
  httpAgent: sharedHttpAgent,
  httpsAgent: sharedHttpsAgent,
  maxRedirects: 5,
  decompress: true,
})

const PLACEHOLDER_PATTERNS = [
  /^sk-xxx/i, /^sk-none$/i, /^sk-placeholder/i, /^sk-your/i, /^sk-test/i,
  /^your[-_]/i, /^placeholder/i, /^xxx+$/i, /^test[-_]?key/i,
  /^dummy/i, /^fake/i, /^changeme/i, /^replace[_-]?me/i,
  /^enter[_-]?your/i, /^insert[_-]?key/i, /^<.*>$/, /^$/,
]

function isPlaceholderKey(key) {
  if (!key || typeof key !== 'string') return true
  const trimmed = key.trim()
  if (trimmed.length === 0) return true
  return PLACEHOLDER_PATTERNS.some(p => p.test(trimmed))
}

function resolveApiKey(providerConfig, clientAuthHeader) {
  const proxyKey = (providerConfig.api_key || '').trim()
  let clientKey = ''
  if (clientAuthHeader && typeof clientAuthHeader === 'string') {
    clientKey = clientAuthHeader.replace(/^Bearer\s+/i, '').trim()
  }
  // 优先使用代理配置的 key
  if (!isPlaceholderKey(proxyKey)) return { key: proxyKey, source: 'proxy' }
  // 代理未配置 key 时，仅在 passthrough_auth 启用时使用客户端 key
  if (providerConfig.passthrough_auth && !isPlaceholderKey(clientKey)) return { key: clientKey, source: 'client' }
  return { key: '', source: 'none', error: 'No valid API key configured' }
}

function getAgent(providerConfig) {
  const url = (providerConfig.base_url || '').toLowerCase()
  if (providerConfig.tls?.reject_unauthorized === false) return insecureHttpsAgent
  if (url.startsWith('https://')) return sharedHttpsAgent
  return sharedHttpAgent
}

function buildAxiosConfig(providerConfig, extra = {}) {
  return {
    ...extra,
    httpAgent: getAgent(providerConfig),
    httpsAgent: getAgent(providerConfig),
    timeout: providerConfig.timeout || 60000,
  }
}

async function axiosRetry(config, retries = 2) {
  let lastErr = null
  for (let i = 0; i <= retries; i++) {
    try {
      return await axiosInstance(config)
    } catch (err) {
      lastErr = err
      const code = err.code || ''
      if (['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED'].includes(code) && i < retries) {
        await new Promise(r => setTimeout(r, Math.min(500 * Math.pow(2, i), 3000)))
        continue
      }
      throw err
    }
  }
  throw lastErr
}

// 拼接 base_url 与路径，去除多余斜杠避免出现 .../v1//chat/completions
function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '')
  const p = String(path || '').replace(/^\/+/, '')
  return p ? `${b}/${p}` : b
}

async function forwardRequest(providerConfig, backendPath, data, requestHeaders) {
  const url = joinUrl(providerConfig.base_url, backendPath)
  const resolved = resolveApiKey(providerConfig, requestHeaders?.authorization)
  if (resolved.error) {
    const err = new Error(resolved.error)
    err.response = { status: 401, data: { error: resolved.error } }
    throw err
  }
  return axiosRetry(buildAxiosConfig(providerConfig, {
    method: 'POST', url, data,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resolved.key}` },
  }))
}

async function forwardChatRequest(providerConfig, model, messages, options, requestHeaders) {
  const url = joinUrl(providerConfig.base_url, '/chat/completions')
  const resolved = resolveApiKey(providerConfig, requestHeaders?.authorization)
  if (resolved.error) {
    const err = new Error(resolved.error)
    err.response = { status: 401, data: { error: resolved.error } }
    throw err
  }
  return axiosRetry(buildAxiosConfig(providerConfig, {
    method: 'POST', url,
    data: { model, messages, ...options },
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resolved.key}` },
  }))
}

module.exports = {
  axiosInstance, axiosRetry, getAgent, buildAxiosConfig,
  forwardRequest, forwardChatRequest, joinUrl,
  isPlaceholderKey, resolveApiKey,
}
