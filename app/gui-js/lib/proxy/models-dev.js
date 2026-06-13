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
  const p = getCachePath(dataDir)
  try {
    if (fs.existsSync(p)) {
      const stat = fs.statSync(p)
      if (Date.now() - stat.mtimeMs < CACHE_TTL) {
        _cache = JSON.parse(fs.readFileSync(p, 'utf8'))
        _cacheTime = stat.mtimeMs
        return _cache
      }
    }
  } catch (e) { console.error('[ModelsDev] disk cache load failed:', e.message) }
  return null
}

function saveDiskCache(data, dataDir) {
  try { fs.writeFileSync(getCachePath(dataDir), JSON.stringify(data), 'utf8') }
  catch (e) { console.error('[ModelsDev] disk cache save failed:', e.message) }
}

async function fetchRemote() {
  try { return (await axios.get(MODELS_DEV_URL, { timeout: 15000 })).data }
  catch (e) { console.error('[ModelsDev] remote fetch failed:', e.message); return null }
}

async function load(dataDir) {
  if (_cache && (Date.now() - _cacheTime) < CACHE_TTL) return _cache
  const disk = loadDiskCache(dataDir)
  if (disk) return disk
  const remote = await fetchRemote()
  if (remote) { _cache = remote; _cacheTime = Date.now(); saveDiskCache(remote, dataDir); return remote }
  return _cache || {}
}

function searchModels(query, data) {
  const q = query.toLowerCase()
  const results = []
  for (const [providerId, provider] of Object.entries(data)) {
    if (!provider.models) continue
    for (const [modelId, model] of Object.entries(provider.models)) {
      const name = (model.name || modelId).toLowerCase()
      if (name.includes(q) || modelId.toLowerCase().includes(q) || (model.family || '').toLowerCase().includes(q)) {
        results.push({ providerId, providerName: provider.name || providerId, modelId, name: model.name || modelId, cost: model.cost || {}, limit: model.limit || {} })
      }
    }
  }
  return results
}

module.exports = { load, searchModels }
