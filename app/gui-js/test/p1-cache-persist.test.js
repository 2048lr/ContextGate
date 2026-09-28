const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { CacheManager } = require('../lib/proxy/cache-manager')
const { DiskCacheStore, containsBinary } = require('../lib/proxy/cache-store')

// ---------------------------------------------------------------------------
// FIX-09 验收：缓存落盘（重启后仍可用）、TTL 生效、容量淘汰、
//            「源码变化只失效相关条目」而不是整表清空。
// ---------------------------------------------------------------------------

let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-p1-cache-')) })
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 上偶尔占用，忽略 */ } })

function reqOf(body, { method = 'POST', path: p = '/v1/chat/completions' } = {}) {
  return { method, path: p, body }
}

describe('FIX-09 磁盘缓存', () => {
  it('重启（新实例）后缓存仍可命中', async () => {
    const a = await new CacheManager({ dir, ttlSeconds: 3600 }).init()
    a.set('POST:/v1/chat/completions:x:ctx:abc', { answer: 42 })
    assert.equal(a.size, 1)

    const b = await new CacheManager({ dir, ttlSeconds: 3600 }).init()
    // 新实例内存是空的（LRU 不预载），但磁盘层应该能命中
    assert.equal(b.diskStore.size, 1)
    assert.deepEqual(b.get('POST:/v1/chat/completions:x:ctx:abc'), { answer: 42 })
    assert.equal(b.hits, 1)
  })

  it('TTL 到期后磁盘条目也失效', async () => {
    const a = await new CacheManager({ dir, ttlSeconds: 0.05 }).init()
    a.set('k', { v: 1 })
    await new Promise(r => setTimeout(r, 90))
    const b = await new CacheManager({ dir }).init()
    assert.equal(b.has('k'), false)
    assert.equal(b.diskStore.size, 0)
  })

  it('超过单条体积上限的值不落盘（但内存仍可用）', async () => {
    const cm = await new CacheManager({ dir, persistMaxEntryBytes: 64 }).init()
    const big = { text: 'x'.repeat(500) }
    cm.set('big', big)
    assert.deepEqual(cm.get('big'), big)
    assert.equal(cm.diskStore.size, 0)
    assert.ok(cm.diskStore.stats.skips >= 1)
  })

  it('含 Buffer / 流式 chunk 的值不落盘（JSON 序列化会失真）', async () => {
    const cm = await new CacheManager({ dir }).init()
    cm.set('stream', { _streamChunks: [Buffer.from('data')] })
    assert.equal(cm.diskStore.size, 0)
    assert.equal(containsBinary({ a: Buffer.from('x') }), true)
    assert.equal(containsBinary({ a: 1 }), false)
  })

  it('磁盘容量超限时按 LRU 淘汰最久未用的条目', async () => {
    const store = new DiskCacheStore({ dir, maxDiskBytes: 900, maxEntryBytes: 1024 * 1024 })
    await store.init()
    for (let i = 0; i < 6; i++) store.set('key-' + i, { i, pad: 'x'.repeat(120) }, {})
    assert.ok(store.bytes <= 900, 'bytes=' + store.bytes)
    assert.ok(store.stats.evictions > 0)
    // 最后写入的一定还在
    assert.ok(store.get('key-5'))
  })

  it('clear() 会把磁盘条目一起删掉', async () => {
    const cm = await new CacheManager({ dir }).init()
    cm.set('k', { v: 1 })
    cm.clear()
    assert.equal(cm.size, 0)
    assert.equal(cm.diskStore.size, 0)
    assert.equal(fs.readdirSync(dir).length, 0)
  })

  it('pruneExpired 清理过期文件', async () => {
    const store = new DiskCacheStore({ dir })
    await store.init()
    store.set('live', { v: 1 }, { expiresAt: Date.now() + 60000 })
    store.set('dead', { v: 2 }, { expiresAt: Date.now() - 1000 })
    assert.equal(store.pruneExpired(), 1)
    assert.equal(store.size, 1)
  })
})

describe('FIX-09 选择性失效（不再「改一个文件就全清」）', () => {
  it('invalidateContext 只删属于该上下文的条目', async () => {
    const cm = await new CacheManager({ dir }).init()
    const keyA = cm.getCacheKey(reqOf({ model: 'gpt-4o', messages: [{ role: 'user', content: 'a' }] }), 'aaaaaaaabbbb')
    const keyB = cm.getCacheKey(reqOf({ model: 'gpt-4o', messages: [{ role: 'user', content: 'b' }] }), 'bbbbbbbbcccc')
    cm.set(keyA, { answer: 'A' })
    cm.set(keyB, { answer: 'B' })
    assert.equal(cm.size, 2)

    const removed = cm.invalidateContext('aaaaaaaabbbb')
    assert.equal(removed, 1)
    assert.equal(cm.has(keyA), false)
    assert.equal(cm.has(keyB), true)
    assert.equal(cm.diskStore.size, 1)
  })

  it('失效不会连带清空命中率统计（旧实现会）', async () => {
    const cm = await new CacheManager({ dir }).init()
    cm.set('POST:/v1/x:default:aaaaaaaa:ff', { v: 1 })
    cm.get('POST:/v1/x:default:aaaaaaaa:ff')
    const hitsBefore = cm.hits
    cm.invalidateContext('aaaaaaaabbbb')
    assert.equal(cm.hits, hitsBefore)
  })

  it('context_binding=off 时源码变化不会让缓存失效', () => {
    const cm = new CacheManager({ contextBinding: 'off' })
    const key = cm.getCacheKey(reqOf({ model: 'gpt-4o', messages: [] }), 'whateverhash')
    assert.match(key, /:unbound:/)
  })

  it('context_binding=hash（默认）时上下文 hash 进入 key', () => {
    const cm = new CacheManager()
    const k1 = cm.getCacheKey(reqOf({ model: 'gpt-4o', messages: [] }), 'hash-one')
    const k2 = cm.getCacheKey(reqOf({ model: 'gpt-4o', messages: [] }), 'hash-two')
    assert.notEqual(k1, k2)
    assert.match(k1, /:hash-one:/)
  })

  it('stats() 暴露内存/磁盘/命中率，供 /stats 展示', async () => {
    const cm = await new CacheManager({ dir, ttlSeconds: 60 }).init()
    cm.set('k', { v: 1 })
    cm.get('k')
    cm.get('missing')
    const s = cm.stats()
    assert.equal(s.entries, 1)
    assert.equal(s.hits, 1)
    assert.equal(s.misses, 1)
    assert.equal(s.hitRate, 0.5)
    assert.equal(s.ttlSeconds, 60)
    assert.equal(s.contextBinding, 'hash')
    assert.equal(s.disk.enabled, true)
    assert.equal(s.disk.entries, 1)
    assert.equal(s.disk.writes, 1)
  })

  it('没有配置目录时退化为纯内存缓存（不影响单测与 CLI）', () => {
    const cm = new CacheManager()
    cm.set('k', { v: 1 })
    assert.deepEqual(cm.get('k'), { v: 1 })
    assert.equal(cm.diskStore.enabled, false)
    assert.equal(cm.diskStore.set('k', { v: 1 }), false)
  })
})
