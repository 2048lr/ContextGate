const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { LRUCache } = require('../core/lru-cache')

class CacheManager {
  constructor(options = {}) {
    this.cache = new LRUCache(options.maxEntries || 200, options.maxMemoryMB || 100)
    this.contextSignature = null
  }

  get(key) { return this.cache.get(key) }
  set(key, value) { this.cache.set(key, value) }
  has(key) { return this.cache.has(key) }
  delete(key) { return this.cache.delete(key) }
  clear() { this.cache.clear() }
  get size() { return this.cache.size }

  getCacheKey(req, contextHash) {
    const body = req.body || {}
    let msgFingerprint = ''
    if (body.messages && Array.isArray(body.messages)) {
      const allContent = body.messages.map(m =>
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')
      ).join('\n')
      if (allContent) msgFingerprint = crypto.createHash('md5').update(allContent).digest('hex').substring(0, 12)
    }
    const modelKey = body.model || 'unknown'
    if (!msgFingerprint) {
      msgFingerprint = crypto.createHash('md5').update(JSON.stringify(body)).digest('hex').substring(0, 12)
    }
    const ctxPart = contextHash ? contextHash.substring(0, 8) : 'none'
    return `${req.method}:${req.path}:${modelKey}:${ctxPart}:${msgFingerprint}`
  }

  shouldCache(method) { return ['GET', 'POST'].includes(method) }

  loadContextSignature(contextFile, projectRoot) {
    this.contextSignature = computeContextSignature(contextFile, projectRoot)
  }

  getContextHash() {
    return this.contextSignature?.combinedHash || this.contextSignature?.mainHash || 'none'
  }

  invalidateIfNeeded(contextFile, projectRoot) {
    const result = checkContextChanged(this.contextSignature, contextFile, projectRoot)
    if (result.changed) {
      console.log('[Cache INVALIDATED] Source file changed')
      this.cache.clear()
      this.contextSignature = result.signature
      return true
    }
    return false
  }
}

function computeFileHash(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex')
  } catch { return null }
}

function computeContextSignature(contextFile, projectRoot) {
  try {
    if (!fs.existsSync(contextFile)) return null
    const content = fs.readFileSync(contextFile, 'utf8')
    const mainHash = crypto.createHash('sha1').update(content).digest('hex')
    const files = []
    for (const line of content.split('\n')) {
      const m = line.match(/^# File: (.+)$/)
      if (m) files.push(m[1])
    }
    const fileHashes = {}
    if (projectRoot) {
      for (const rel of files) {
        const hash = computeFileHash(path.join(projectRoot, rel))
        if (hash) fileHashes[rel] = hash
      }
    }
    const combinedHash = crypto.createHash('sha1').update(JSON.stringify(fileHashes)).digest('hex')
    return { mainHash, combinedHash, fileHashes, fileCount: files.length, files, file: contextFile }
  } catch { return null }
}

function checkContextChanged(currentSignature, contextFile, projectRoot) {
  const newSig = computeContextSignature(contextFile, projectRoot)
  if (!newSig) return { changed: false, signature: null }
  if (!currentSignature) return { changed: true, signature: newSig }
  const changed = newSig.combinedHash !== currentSignature.combinedHash || newSig.mainHash !== currentSignature.mainHash
  return { changed, signature: newSig }
}

module.exports = { CacheManager, computeContextSignature, checkContextChanged }
