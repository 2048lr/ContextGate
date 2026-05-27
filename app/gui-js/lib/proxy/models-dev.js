const fs = require('fs')
const path = require('path')
const axios = require('axios')

const MODELS_DEV_URL = 'https://models.dev/api.json'
const CACHE_TTL = 24 * 60 * 60 * 1000

let _cache = null
let _cacheTime = 0
let _cachePath = null

function getCachePath(dataDir) {
  if (_cachePath) return _cachePath
  _cachePath = path.join(dataDir || require('os').tmpdir(), 'models-dev-cache.json')
  return _cachePath
}

function loadDiskCache(dataDir) {
  const cachePath = getCachePath(dataDir)
  try {
    if (fs.existsSync(cachePath)) {
      const stat = fs.statSync(cachePath)
      const age = Date.now() - stat.mtimeMs
      if (age < CACHE_TTL) {
        const raw = fs.readFileSync(cachePath, 'utf8')
        const data = JSON.parse(raw)
        _cache = data
        _cacheTime = stat.mtimeMs
        return data
      }
    }
  } catch (e) {
    console.error('[ModelsDev] Failed to load disk cache:', e.message)
  }
  return null
}

function saveDiskCache(data, dataDir) {
  const cachePath = getCachePath(dataDir)
  try {
    fs.writeFileSync(cachePath, JSON.stringify(data), 'utf8')
  } catch (e) {
    console.error('[ModelsDev] Failed to save disk cache:', e.message)
  }
}

async function fetchRemote() {
  try {
    const response = await axios.get(MODELS_DEV_URL, { timeout: 15000 })
    return response.data
  } catch (e) {
    console.error('[ModelsDev] Failed to fetch from remote:', e.message)
    return null
  }
}

async function load(dataDir) {
  if (_cache && (Date.now() - _cacheTime) < CACHE_TTL) {
    return _cache
  }

  const disk = loadDiskCache(dataDir)
  if (disk) {
    _cache = disk
    return disk
  }

  const remote = await fetchRemote()
  if (remote) {
    _cache = remote
    _cacheTime = Date.now()
    saveDiskCache(remote, dataDir)
    return remote
  }

  return _cache || {}
}

function getProvider(providerId, data) {
  return data[providerId] || null
}

function getProviderModels(providerId, data) {
  const provider = getProvider(providerId, data)
  if (!provider || !provider.models) return {}
  return provider.models
}

function getModel(providerId, modelId, data) {
  const models = getProviderModels(providerId, data)
  return models[modelId] || null
}

function listProviders(data) {
  const result = []
  for (const [id, info] of Object.entries(data)) {
    result.push({
      id,
      name: info.name || id,
      api: info.api || '',
      env: info.env || [],
      npm: info.npm || '',
      doc: info.doc || '',
      modelCount: info.models ? Object.keys(info.models).length : 0
    })
  }
  return result
}

function listModelsForProvider(providerId, data) {
  const models = getProviderModels(providerId, data)
  const result = []
  for (const [id, info] of Object.entries(models)) {
    result.push({
      id,
      name: info.name || id,
      family: info.family || '',
      reasoning: info.reasoning || false,
      tool_call: info.tool_call || false,
      temperature: info.temperature !== false,
      attachment: info.attachment || false,
      knowledge: info.knowledge || '',
      release_date: info.release_date || '',
      modalities: info.modalities || { input: ['text'], output: ['text'] },
      limit: info.limit || {},
      cost: info.cost || {},
      open_weights: info.open_weights || false
    })
  }
  return result
}

function searchModels(query, data) {
  const q = query.toLowerCase()
  const results = []
  for (const [providerId, provider] of Object.entries(data)) {
    if (!provider.models) continue
    for (const [modelId, model] of Object.entries(provider.models)) {
      const name = (model.name || modelId).toLowerCase()
      const family = (model.family || '').toLowerCase()
      if (name.includes(q) || family.includes(q) || modelId.toLowerCase().includes(q)) {
        results.push({
          providerId,
          providerName: provider.name || providerId,
          modelId,
          name: model.name || modelId,
          family: model.family || '',
          cost: model.cost || {},
          limit: model.limit || {}
        })
      }
    }
  }
  return results
}

function clearCache(dataDir) {
  _cache = null
  _cacheTime = 0
  const cachePath = getCachePath(dataDir)
  try {
    if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath)
  } catch (e) {
    console.error('[ModelsDev] Failed to clear cache:', e.message)
  }
}

module.exports = {
  load,
  getProvider,
  getProviderModels,
  getModel,
  listProviders,
  listModelsForProvider,
  searchModels,
  clearCache
}
