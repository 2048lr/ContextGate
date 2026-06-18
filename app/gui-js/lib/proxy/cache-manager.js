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
    // 包含影响输出的关键参数，避免相同消息不同参数命中同一缓存
    const paramKeys = ['temperature', 'max_tokens', 'top_p', 'frequency_penalty', 'presence_penalty', 'stream']
    const paramFingerprint = paramKeys
      .filter(k => body[k] !== undefined)
      .map(k => `${k}=${body[k]}`)
      .join(',')
    const ctxPart = contextHash ? contextHash.substring(0, 8) : 'none'
    return `${req.method}:${req.path}:${modelKey}:${ctxPart}:${msgFingerprint}:${paramFingerprint}`
  }

  shouldCache(method) { return ['GET', 'POST'].includes(method) }

  loadContextSignature(contextFile, projectRoot) {
    this.contextSignature = computeContextSignature(contextFile, projectRoot)
  }

  getContextHash() {
    return this.contextSignature?.combinedHash || this.contextSignature?.mainHash || 'none'
  }

  invalidateIfNeeded(contextFile, projectRoot) {
    // 快速路径：先检查上下文文件 mtime，未变化则跳过完整哈希计算
    if (this.contextSignature && this.contextSignature.file) {
      try {
        const stat = fs.statSync(this.contextSignature.file)
        if (this.contextSignature.mtimeMs && stat.mtimeMs === this.contextSignature.mtimeMs) {
          return false
        }
      } catch { /* 文件可能已删除，继续走完整检查 */ }
    }
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
    const stat = fs.statSync(contextFile)
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
    return { mainHash, combinedHash, fileHashes, fileCount: files.length, files, file: contextFile, mtimeMs: stat.mtimeMs }
  } catch { return null }
}

function checkContextChanged(currentSignature, contextFile, projectRoot) {
  const newSig = computeContextSignature(contextFile, projectRoot)
  // 上下文文件被删除时，应失效缓存
  if (!newSig) {
    if (currentSignature) return { changed: true, signature: null }
    return { changed: false, signature: null }
  }
  if (!currentSignature) return { changed: true, signature: newSig }
  const changed = newSig.combinedHash !== currentSignature.combinedHash || newSig.mainHash !== currentSignature.mainHash
  return { changed, signature: newSig }
}

module.exports = { CacheManager, computeContextSignature, checkContextChanged }
