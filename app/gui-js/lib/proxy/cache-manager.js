const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { LRUCache } = require('../core/lru-cache')
const { DiskCacheStore } = require('./cache-store')

// FIX-06：白名单式列出「参与缓存指纹」的字段。
// 采用白名单而不是黑名单，新增参数若影响输出必须显式加入，避免再次出现
// 「带 tools 的请求把答案缓存给不带 tools 的请求」这类静默错答。
const CACHE_KEY_FIELDS = [
  'model', 'messages', 'temperature', 'top_p', 'max_tokens', 'max_completion_tokens',
  'stop', 'frequency_penalty', 'presence_penalty', 'seed', 'n', 'logprobs', 'top_logprobs',
  'tools', 'tool_choice', 'parallel_tool_calls', 'functions', 'function_call',
  'response_format', 'reasoning_effort', 'modalities', 'service_tier', 'prediction',
  'stream', 'user', 'provider',
  // FIX-11：新增协议的等价字段，否则 /v1/responses 与 /v1/messages 会串缓存
  'input', 'instructions', 'system', 'max_output_tokens', 'text', 'previous_response_id',
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
    this.staleReads = 0
    // FIX-09：上下文与缓存 key 的绑定方式
    //   'hash'（默认）= key 里带上下文 hash，上下文一变旧条目不可复用；
    //   'off' = 不绑定。当前版本代理并不把工作区上下文注入请求（P0-3），
    //           用户自己粘贴的上下文本身就在 messages 里、已参与指纹，
    //           因此关掉绑定可以避免「改一个源文件就全表失效」。
    this.contextBinding = options.contextBinding === 'off' ? 'off' : 'hash'
    this.diskStore = new DiskCacheStore({
      dir: options.dir || '',
      maxDiskBytes: options.maxDiskBytes,
      maxEntryBytes: options.persistMaxEntryBytes,
      logger: options.logger,
    })
  }

  /** 载入磁盘缓存（幂等；没有配置缓存目录时只是内存缓存） */
  async init() {
    await this.diskStore.init()
    return this
  }

  // 不触碰命中率统计，供 has() 使用
  _peek(key) {
    const entry = this.cache.get(key)
    if (entry !== undefined && entry !== null) {
      if (entry && entry.__cgWrapped) {
        if (entry.expiresAt && Date.now() > entry.expiresAt) {
          this.cache.delete(key)
          this.diskStore.delete(key)
        } else {
          return entry.value
        }
      } else {
        return entry
      }
    }
    // FIX-09：内存未命中时回查磁盘，并把条目提升回内存
    if (this.diskStore.enabled) {
      const fromDisk = this.diskStore.get(key)
      if (fromDisk !== undefined) {
        this.cache.set(key, { __cgWrapped: true, value: fromDisk.value, expiresAt: fromDisk.expiresAt || 0 })
        return fromDisk.value
      }
    }
    return undefined
  }

  get(key) {
    const value = this._peek(key)
    if (value === undefined) { this.misses++; return undefined }
    this.hits++
    return value
  }

  set(key, value) {
    const expiresAt = this.ttlMs > 0 ? Date.now() + this.ttlMs : 0
    const wrapped = { __cgWrapped: true, value, expiresAt }
    this.cache.set(key, wrapped)
    this.diskStore.set(key, value, { expiresAt })
  }

  has(key) { return this._peek(key) !== undefined }

  delete(key) { this.diskStore.delete(key); return this.cache.delete(key) }

  clear() {
    this.cache.clear()
    this.diskStore.clear()
  }

  get size() { return this.cache.size }

  setTtlSeconds(seconds) { this.ttlMs = Number(seconds) > 0 ? Number(seconds) * 1000 : 0 }

  setContextBinding(mode) { this.contextBinding = mode === 'off' ? 'off' : 'hash' }

  setDiskConfig({ dir, maxDiskBytes, persistMaxEntryBytes } = {}) {
    if (dir !== undefined) { this.diskStore.dir = dir || ''; this.diskStore.enabled = Boolean(dir) }
    if (maxDiskBytes !== undefined) this.diskStore.maxDiskBytes = Number(maxDiskBytes) || 0
    if (persistMaxEntryBytes !== undefined) this.diskStore.maxEntryBytes = Number(persistMaxEntryBytes) || 262144
  }

  getCacheKey(req, contextHash) {
    const body = req.body || {}
    const providerKey = body.provider || 'default'
    const ctxPart = this.contextBinding === 'off'
      ? 'unbound'
      : (contextHash ? String(contextHash).substring(0, 8) : 'none')
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

  /**
   * FIX-09：只失效「属于被替换掉的那个上下文」的条目，而不是整表清空。
   * 旧实现每次源码变化都 cache.clear()，既丢掉了其它上下文的缓存，
   * 也把命中率统计一起清零（导致监控数据失真）。
   * @returns {number} 被删除的条目数
   */
  invalidateContext(hashPart) {
    const part = String(hashPart || '').substring(0, 8)
    if (!part) return 0
    const marker = `:${part}:`
    // 同一个 key 可能同时存在于内存与磁盘，必须用集合去重后再计数，
    // 否则「删了 1 条」会被报成 2 条，日志与测试都会失真。
    const removedKeys = new Set()
    for (const key of this.cache.keys()) {
      if (!key.includes(marker)) continue
      this.cache.delete(key)
      removedKeys.add(key)
    }
    // 磁盘上匹配的条目一律删掉（含内存里刚删过的那份），但只把「新增的」计入返回数
    this.diskStore.deleteMatching(key => {
      if (!key.includes(marker)) return false
      removedKeys.add(key)
      return true
    })
    return removedKeys.size
  }

  invalidateIfNeeded(contextFile, projectRoot) {
    if (this.contextBinding === 'off') {
      // 不绑定上下文时，缓存是否有效完全由 key 里的 messages/tools 决定
      if (!this.contextSignature) this.loadContextSignature(contextFile, projectRoot)
      return false
    }
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
    const previousHash = this.getContextHash()
    const result = checkContextChanged(this.contextSignature, contextFile, projectRoot)
    if (result.changed) {
      const removed = previousHash && previousHash !== 'none' ? this.invalidateContext(previousHash) : 0
      console.log(`[Cache INVALIDATED] 上下文变更，按上下文选择性失效 ${removed} 条（保留其它条目）`)
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

  /** FIX-09：缓存可观测性（/stats） */
  stats() {
    return {
      entries: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits + this.misses > 0 ? this.hits / (this.hits + this.misses) : 0,
      ttlSeconds: this.ttlMs > 0 ? this.ttlMs / 1000 : 0,
      contextBinding: this.contextBinding,
      memoryBytes: this.cache.memoryBytes,
      disk: this.diskStore.snapshot(),
    }
  }

  /** 清理过期条目（内存 LRU 自身按容量淘汰，磁盘层需要显式 prune） */
  pruneExpired() {
    const removed = this.diskStore.pruneExpired()
    for (const key of this.cache.keys()) this._peek(key)
    return removed
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

module.exports = { CacheManager, computeContextSignature, checkContextChanged, CACHE_KEY_FIELDS }
