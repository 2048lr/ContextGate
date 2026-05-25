const crypto = require('crypto')

/**
 * @typedef {import('./config-manager').ConfigManager} ConfigManager
 */

/** @type {string[]} Whitelisted API paths for /v1/* proxy */
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

/**
 * Detect which AI provider should handle a request based on the backend path.
 * @param {string} backendPath - The API backend path
 * @param {ConfigManager} configManager - Configuration manager instance
 * @returns {string} Provider name
 */
function detectProvider(backendPath, configManager) {
  const lowerPath = backendPath.toLowerCase()
  if (lowerPath.includes('zhipu')) return 'zhipu'
  if (lowerPath.includes('deepseek')) return 'deepseek'
  if (lowerPath.includes('openai')) return 'openai'
  const defaultProvider = configManager.getDefaultProvider()
  if (defaultProvider) return defaultProvider
  const allProviders = configManager.getAllProviders()
  const providerNames = Object.keys(allProviders)
  if (providerNames.length === 1) return providerNames[0]
  for (const [name, config] of Object.entries(allProviders)) {
    if (config.base_url && lowerPath.includes(name.toLowerCase())) return name
  }
  return 'openai'
}

/**
 * Generate a cache key from the request and context hash.
 * @param {import('express').Request} req - Express request object
 * @param {string} contextHash - Current context hash
 * @returns {string} Cache key string
 */
function getCacheKey(req, contextHash) {
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

/**
 * Check if a request method is eligible for caching.
 * @param {string} method - HTTP method
 * @returns {boolean}
 */
function shouldCache(method) {
  return ['GET', 'POST'].includes(method)
}

module.exports = {
  ALLOWED_V1_PATHS,
  detectProvider,
  getCacheKey,
  shouldCache
}
