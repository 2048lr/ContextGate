 /**
 * @typedef {Object} CacheEntry
 * @property {*} value - The cached value
 * @property {number} size - Estimated byte size of the value
 * @property {number} lastAccess - Timestamp of last access
 */

/**
 * LRU (Least Recently Used) Cache with size and memory limits.
 * Supports caching of regular values, SSE events, and stream chunks.
 */
class LRUCache {
  /**
   * @param {number} [maxSize=200] - Maximum number of entries
   * @param {number} [maxMemoryMB=100] - Maximum memory usage in megabytes
   */
  constructor(maxSize = 200, maxMemoryMB = 100) {
    /** @type {number} */
    this.maxSize = maxSize
    /** @type {number} */
    this.maxMemory = maxMemoryMB * 1024 * 1024
    /** @type {Map<string, CacheEntry>} */
    this.cache = new Map()
    /** @type {number} */
    this.currentMemory = 0
  }

  /**
   * Retrieve a value from the cache, promoting it to most-recently-used.
   * @param {string} key - Cache key
   * @returns {*} The cached value, or undefined if not found
   */
  get(key) {
    if (!this.cache.has(key)) return undefined
    const entry = this.cache.get(key)
    this.cache.delete(key)
    this.cache.set(key, entry)
    entry.lastAccess = Date.now()
    return entry.value
  }

  /**
   * Store a value in the cache, evicting least-recently-used entries if needed.
   * @param {string} key - Cache key
   * @param {*} value - Value to cache
   */
  set(key, value) {
    if (this.cache.has(key)) {
      const oldEntry = this.cache.get(key)
      this.currentMemory -= oldEntry.size
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

  /**
   * Check if a key exists in the cache.
   * @param {string} key - Cache key
   * @returns {boolean}
   */
  has(key) {
    return this.cache.has(key)
  }

  /**
   * Remove a specific entry from the cache.
   * @param {string} key - Cache key to remove
   * @returns {boolean} True if the entry existed and was removed
   */
  delete(key) {
    if (!this.cache.has(key)) return false
    const entry = this.cache.get(key)
    this.currentMemory -= entry.size
    this.cache.delete(key)
    return true
  }

  /** Clear all entries from the cache. */
  clear() {
    this.cache.clear()
    this.currentMemory = 0
  }

  /** @type {number} Number of entries in the cache */
  get size() {
    return this.cache.size
  }

  /**
   * Estimate the byte size of a cached value.
   * @param {*} value - Value to estimate
   * @returns {number} Estimated size in bytes
   * @private
   */
  _estimateSize(value) {
    if (!value) return 0
    if (value._sseEvents) {
      try {
        return Buffer.byteLength(JSON.stringify(value._sseEvents), 'utf8') + 1024
      } catch (e) {
        console.error('Failed to estimate SSE events size:', e.message)
        return value._sseEvents.length * 512 + 1024
      }
    }
    if (value._streamChunks) {
      let chunksSize = 0
      for (const chunk of value._streamChunks) {
        chunksSize += chunk.length || chunk.byteLength || 0
      }
      return chunksSize + 1024
    }
    try {
      return Buffer.byteLength(JSON.stringify(value), 'utf8')
    } catch (e) {
      console.error('Failed to estimate cache value size:', e.message)
      return 10240
    }
  }
}

module.exports = { LRUCache }
