// FIX-09：持久化缓存（磁盘层）
//
// 原实现只有进程内 LRU（200 条 / 100MB），重启即空；任何源文件变化触发整表 clear
// （cache-manager.js:68-72）→ 开发期命中率趋零。这里补上「落盘 + TTL + LRU 淘汰 +
// 容量上限 + 可统计/可清理」的磁盘层，并保证写入是原子的（tmp + rename）。
//
// 设计取舍：
//   * 一条缓存一个文件（<hash>.json），文件名用 key 的 sha1，避免把模型/messages
//     写进文件名；文件内含原始 key，便于反查与按 key 精确删除；
//   * 明确不落盘包含 Buffer 的值（_streamChunks），它们体积大且 JSON 序列化会失真；
//     这类条目只在内存里存活；
//   * 磁盘层有独立的容量上限与 LRU 顺序，超限时按 lastAccess 淘汰最久未用的条目。

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

function keyHash(key) {
  return crypto.createHash('sha1').update(String(key)).digest('hex')
}

function containsBinary(value) {
  if (!value || typeof value !== 'object') return false
  if (Buffer.isBuffer(value)) return true
  if (Array.isArray(value)) return value.some(containsBinary)
  if (value._streamChunks) return true
  for (const v of Object.values(value)) {
    if (Buffer.isBuffer(v)) return true
    if (v && typeof v === 'object' && containsBinary(v)) return true
  }
  return false
}

class DiskCacheStore {
  /**
   * @param {{dir?:string, maxDiskBytes?:number, maxEntryBytes?:number, logger?:object}} options
   */
  constructor(options = {}) {
    this.dir = options.dir || ''
    this.maxDiskBytes = Number(options.maxDiskBytes) > 0 ? Number(options.maxDiskBytes) : 0
    this.maxEntryBytes = Number(options.maxEntryBytes) > 0 ? Number(options.maxEntryBytes) : 262144
    this.logger = options.logger || console
    this.enabled = Boolean(this.dir)
    // hash -> { key, file, bytes, savedAt, lastAccess }
    this.index = new Map()
    this.totalBytes = 0
    this.stats = { writes: 0, hits: 0, misses: 0, evictions: 0, skips: 0, errors: 0 }
    this._ready = false
  }

  async init() {
    if (!this.enabled || this._ready) return this
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
      for (const file of files) {
        const full = path.join(this.dir, file)
        try {
          const stat = fs.statSync(full)
          const raw = JSON.parse(fs.readFileSync(full, 'utf8'))
          if (!raw || typeof raw.key !== 'string') { fs.unlinkSync(full); continue }
          const hash = file.replace(/\.json$/, '')
          this.index.set(hash, { key: raw.key, file: full, bytes: stat.size, savedAt: raw.savedAt || 0, lastAccess: Date.now() })
          this.totalBytes += stat.size
        } catch {
          // 损坏的条目直接丢弃，不能让它拖垮启动
          try { fs.unlinkSync(full) } catch { /* 忽略 */ }
        }
      }
      this._ready = true
      if (this.index.size > 0) this.logger.log?.(`[cache] 从磁盘恢复 ${this.index.size} 条缓存（${(this.totalBytes / 1024).toFixed(1)} KB）`)
    } catch (e) {
      this.enabled = false
      this.logger.warn?.('[cache] 磁盘缓存不可用，已回退为纯内存缓存:', e.message)
    }
    return this
  }

  _fileFor(hash) { return path.join(this.dir, `${hash}.json`) }

  get(key) {
    if (!this.enabled) return undefined
    const hash = keyHash(key)
    const entry = this.index.get(hash)
    if (!entry) { this.stats.misses++; return undefined }
    try {
      const raw = JSON.parse(fs.readFileSync(entry.file, 'utf8'))
      if (raw.expiresAt && Date.now() > raw.expiresAt) {
        this.delete(key)
        this.stats.misses++
        return undefined
      }
      entry.lastAccess = Date.now()
      this.stats.hits++
      return { value: raw.value, expiresAt: raw.expiresAt || 0 }
    } catch {
      this.delete(key)
      this.stats.misses++
      return undefined
    }
  }

  set(key, value, { expiresAt = 0 } = {}) {
    if (!this.enabled) return false
    if (containsBinary(value)) { this.stats.skips++; return false }
    let serialized
    try { serialized = JSON.stringify({ key, expiresAt, savedAt: Date.now(), value }) }
    catch { this.stats.skips++; return false }
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (this.maxEntryBytes > 0 && bytes > this.maxEntryBytes) { this.stats.skips++; return false }

    const hash = keyHash(key)
    const file = this._fileFor(hash)
    const tmp = `${file}.${process.pid}.tmp`
    try {
      fs.writeFileSync(tmp, serialized, 'utf8')
      fs.renameSync(tmp, file)
    } catch (e) {
      this.stats.errors++
      try { fs.unlinkSync(tmp) } catch { /* 忽略 */ }
      this.logger.warn?.('[cache] 落盘失败:', e.message)
      return false
    }
    const existing = this.index.get(hash)
    if (existing) this.totalBytes -= existing.bytes
    this.index.set(hash, { key, file, bytes, savedAt: Date.now(), lastAccess: Date.now() })
    this.totalBytes += bytes
    this.stats.writes++
    this._enforceQuota()
    return true
  }

  delete(key) {
    if (!this.enabled) return false
    const hash = keyHash(key)
    const entry = this.index.get(hash)
    if (!entry) return false
    this.index.delete(hash)
    this.totalBytes -= entry.bytes
    try { fs.unlinkSync(entry.file) } catch { /* 文件可能已不存在 */ }
    return true
  }

  /** 按 key 的「上下文片段」选择性删除，而不是整表清空（FIX-09 的核心行为变化） */
  deleteMatching(predicate) {
    if (!this.enabled) return 0
    let removed = 0
    for (const [hash, entry] of [...this.index]) {
      let matched = false
      try { matched = predicate(entry.key) === true } catch { matched = false }
      if (!matched) continue
      this.index.delete(hash)
      this.totalBytes -= entry.bytes
      try { fs.unlinkSync(entry.file) } catch { /* 忽略 */ }
      removed++
    }
    return removed
  }

  clear() {
    if (!this.enabled) return
    for (const entry of this.index.values()) { try { fs.unlinkSync(entry.file) } catch { /* 忽略 */ } }
    this.index.clear()
    this.totalBytes = 0
  }

  /** 清掉过期条目；返回删除数量 */
  pruneExpired(now = Date.now()) {
    if (!this.enabled) return 0
    let removed = 0
    for (const [hash, entry] of [...this.index]) {
      try {
        const raw = JSON.parse(fs.readFileSync(entry.file, 'utf8'))
        if (!raw.expiresAt || now <= raw.expiresAt) continue
      } catch { /* 读取失败按过期处理 */ }
      this.index.delete(hash)
      this.totalBytes -= entry.bytes
      try { fs.unlinkSync(entry.file) } catch { /* 忽略 */ }
      removed++
    }
    return removed
  }

  _enforceQuota() {
    if (!this.maxDiskBytes || this.totalBytes <= this.maxDiskBytes) return
    const ordered = [...this.index.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess)
    for (const [hash, entry] of ordered) {
      if (this.totalBytes <= this.maxDiskBytes) break
      this.index.delete(hash)
      this.totalBytes -= entry.bytes
      try { fs.unlinkSync(entry.file) } catch { /* 忽略 */ }
      this.stats.evictions++
    }
  }

  get size() { return this.index.size }
  get bytes() { return this.totalBytes }

  snapshot() {
    return {
      enabled: this.enabled,
      dir: this.dir,
      entries: this.index.size,
      bytes: this.totalBytes,
      maxDiskBytes: this.maxDiskBytes,
      maxEntryBytes: this.maxEntryBytes,
      ...this.stats,
    }
  }
}

module.exports = { DiskCacheStore, keyHash, containsBinary }
