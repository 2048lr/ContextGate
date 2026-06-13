class LRUCache {
  constructor(maxSize = 200, maxMemoryMB = 100) {
    this.maxSize = maxSize
    this.maxMemory = maxMemoryMB * 1024 * 1024
    this.cache = new Map()
    this.currentMemory = 0
  }

  get(key) {
    if (!this.cache.has(key)) return undefined
    const entry = this.cache.get(key)
    this.cache.delete(key)
    this.cache.set(key, entry)
    entry.lastAccess = Date.now()
    return entry.value
  }

  set(key, value) {
    if (this.cache.has(key)) {
      const old = this.cache.get(key)
      this.currentMemory -= old.size
      this.cache.delete(key)
    }
    const size = this._estimateSize(value)
    while ((this.cache.size >= this.maxSize || this.currentMemory + size > this.maxMemory) && this.cache.size > 0) {
      const oldestKey = this.cache.keys().next().value
      const oldestEntry = this.cache.get(oldestKey)
      this.currentMemory -= oldestEntry.size
      this.cache.delete(oldestKey)
    }
    this.cache.set(key, { value, size, lastAccess: Date.now() })
    this.currentMemory += size
  }

  has(key) { return this.cache.has(key) }

  delete(key) {
    if (!this.cache.has(key)) return false
    const entry = this.cache.get(key)
    this.currentMemory -= entry.size
    this.cache.delete(key)
    return true
  }

  clear() { this.cache.clear(); this.currentMemory = 0 }
  get size() { return this.cache.size }

  _estimateSize(value) {
    if (!value) return 0
    if (value._sseEvents) {
      try { return Buffer.byteLength(JSON.stringify(value._sseEvents), 'utf8') + 1024 }
      catch { return value._sseEvents.length * 512 + 1024 }
    }
    if (value._streamChunks) {
      let s = 0
      for (const c of value._streamChunks) s += c.length || c.byteLength || 0
      return s + 1024
    }
    try { return Buffer.byteLength(JSON.stringify(value), 'utf8') }
    catch { return 10240 }
  }
}

module.exports = { LRUCache }
