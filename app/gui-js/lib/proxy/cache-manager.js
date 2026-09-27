const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { LRUCache } = require('../core/lru-cache')

// FIX-06：白名单式列出「参与缓存指纹」的字段。
// 采用白名单而不是黑名单，新增参数若影响输出必须显式加入，避免再次出现
// 「带 tools 的请求把答案缓存给不带 tools 的请求」这类静默错答。
const CACHE_KEY_FIELDS = [
  'model', 'messages', 'temperature', 'top_p', 'max_tokens', 'max_completion_tokens',
  'stop', 'frequency_penalty', 'presence_penalty', 'seed', 'n', 'logprobs', 'top_logprobs',
  'tools', 'tool_choice', 'parallel_tool_calls', 'functions', 'function_call',
  'response_format', 'reasoning_effort', 'modalities', 'service_tier', 'prediction',
  'stream', 'user', 'provider',
]

// 规范化 JSON：对象键排序，保证同一语义的 body 得到同一指纹
function stableStringify(value) {
  if (value === undefined) return 'null'
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map(k => JSON.stringify(k) + ':' + stableStringify(value[k]))
      .join(',') + '}'
  }
  return JSON.stringify(value ?? null)
}

function fingerprintPayload(body) {
  const payload = {}
  for (const key of CACHE_KEY_FIELDS) {
    if (body[key] !== undefined) payload[key] = body[key]
  }
  // 兜底：非白名单字段里出现未知的自定义参数时，不应共享缓存
  const unknown = Object.keys(body).filter(k => !CACHE_KEY_FIELDS.includes(k)).sort()
  if (unknown.length > 0) payload.__extra_keys = unknown
  return payload
}

class CacheManager {
  constructor(options = {}) {
    this.cache = new LRUCache(options.maxEntries || 200, options.maxMemoryMB || 100)
    this.contextSignature = null
    // TTL 默认 1 小时；0 表示不过期
    this.ttlMs = options.ttlSeconds === undefined ? 3600 * 1000 : Number(options.ttlSeconds) * 1000
    this.hits = 0
    this.misses = 0
  }

  // 不触碰命中率统计，供 has() 使用
  _peek(key) {
    const entry = this.cache.get(key)
    if (entry === undefined || entry === null) return undefined
    if (entry && entry.__cgWrapped) {
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        this.cache.delete(key)
        return undefined
      }
      return entry.value
    }
    return entry
  }

  get(key) {
    const value = this._peek(key)
    if (value === undefined) { this.misses++; return undefined }
    this.hits++
    return value
  }

  set(key, value) {
    const wrapped = { __cgWrapped: true, value, expiresAt: this.ttlMs > 0 ? Date.now() + this.ttlMs : 0 }
    this.cache.set(key, wrapped)
  }

  has(key) { return this._peek(key) !== undefined }

  delete(key) { return this.cache.delete(key) }

  clear() { this.cache.clear(); this.hits = 0; this.misses = 0 }

  get size() { return this.cache.size }

  setTtlSeconds(seconds) { this.ttlMs = Number(seconds) > 0 ? Number(seconds) * 1000 : 0 }

  getCacheKey(req, contextHash) {
    const body = req.body || {}
    const providerKey = body.provider || 'default'
    const ctxPart = contextHash ? String(contextHash).substring(0, 8) : 'none'
    const fingerprint = crypto.createHash('sha256')
      .update(stableStringify(fingerprintPayload(body)))
      .digest('hex')
      .substring(0, 32)
    return `${req.method}:${req.path}:${providerKey}:${ctxPart}:${fingerprint}`
  }

  shouldCache(method) { return ['GET', 'POST'].includes(method) }

  loadContextSignature(contextFile, projectRoot) {
    this.contextSignature = computeContextSignature(contextFile, projectRoot)
  }

  getContextHash() {
    return this.contextSignature?.combinedHash || this.contextSignature?.mainHash || 'none'
  }

  invalidateIfNeeded(contextFile, projectRoot) {
    // 快速路径：先检查上下文文件 mtime，未变化则检查源文件 mtime
    if (this.contextSignature && this.contextSignature.file) {
      try {
        const stat = fs.statSync(this.contextSignature.file)
        if (this.contextSignature.mtimeMs && stat.mtimeMs === this.contextSignature.mtimeMs) {
          // 上下文文件未变，再快速检查源文件 mtime
          if (this._sourceMtimesUnchanged(this.contextSignature, projectRoot)) {
            return false
          }
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

  _sourceMtimesUnchanged(signature, projectRoot) {
    if (!signature || !signature.files || !projectRoot) return true
    for (const rel of signature.files) {
      try {
        const stat = fs.statSync(path.join(projectRoot, rel))
        // 源文件 mtime 记录在 fileHashes 中不合适，用单独的 map 存储
        if (!signature.sourceMtimes) return false // 无 mtime 记录，走完整检查
        const recorded = signature.sourceMtimes[rel]
        if (recorded === undefined || stat.mtimeMs !== recorded) return false
      } catch { return false } // 文件可能已删除
    }
    return true
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
      // markdown / plain 产物格式
      const m = line.match(/^# File: (.+?)(?: \((?:summary|ERROR)[^)]*\))?$/)
      if (m) { files.push(m[1]); continue }
      // XML 产物格式（FIX-03）
      const x = line.match(/^<file path="([^"]+)"/)
      if (x) files.push(x[1])
    }
    const fileHashes = {}
    const sourceMtimes = {}
    if (projectRoot) {
      for (const rel of files) {
        const fullPath = path.join(projectRoot, rel)
        const hash = computeFileHash(fullPath)
        if (hash) fileHashes[rel] = hash
        try { sourceMtimes[rel] = fs.statSync(fullPath).mtimeMs } catch { /* 文件可能已删除 */ }
      }
    }
    const combinedHash = crypto.createHash('sha1').update(JSON.stringify(fileHashes)).digest('hex')
    return { mainHash, combinedHash, fileHashes, sourceMtimes, fileCount: files.length, files, file: contextFile, mtimeMs: stat.mtimeMs }
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
