const path = require('path')
const { EXCLUDE_DIRS } = require('./constants')

// FIX-05：把 context.watch_enabled / context.debounce_seconds 这两个「死旋钮」接上。
// 原实现里 chokidar 是已声明的依赖但从未被 require，UI 上的开关毫无作用。
class ContextWatcher {
  constructor(options = {}) {
    this.rootDir = options.rootDir ? path.resolve(options.rootDir) : null
    this.debounceMs = Math.max(100, (Number(options.debounceSeconds) || 1) * 1000)
    this.onRebuild = options.onRebuild || (() => {})
    this.onError = options.onError || (() => {})
    this.onEvent = options.onEvent || (() => {})
    this._chokidar = options.chokidar || null
    this.watcher = null
    this._timer = null
  }

  get running() { return this.watcher !== null }

  _resolveChokidar() {
    if (this._chokidar) return this._chokidar
    try { return require('chokidar') } catch (e) {
      this.onError(new Error(`chokidar 不可用，文件监视未启用: ${e.message}`))
      return null
    }
  }

  isIgnored(target) {
    if (!this.rootDir) return false
    const rel = path.relative(this.rootDir, target)
    if (!rel || rel.startsWith('..')) return false
    const base = path.basename(target)
    if (base === 'full_context.txt' || base.endsWith('.manifest.json')) return true
    const parts = rel.split(path.sep)
    if (parts.some(part => EXCLUDE_DIRS.has(part))) return true
    // 隐藏目录（.git/.vscode/...）不触发重建
    if (parts.length > 1 && parts.slice(0, -1).some(part => part.startsWith('.'))) return true
    return false
  }

  async start() {
    if (this.watcher) return { started: false, error: 'watcher already running' }
    if (!this.rootDir) return { started: false, error: 'no workspace configured' }
    const chokidar = this._resolveChokidar()
    if (!chokidar) return { started: false, error: 'chokidar unavailable' }
    this.watcher = chokidar.watch(this.rootDir, {
      ignoreInitial: true,
      ignored: (target) => this.isIgnored(target),
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    })
    this.watcher.on('all', (event, filePath) => {
      try { this.onEvent(event, filePath) } catch { /* 事件回调不应影响监视 */ }
      this._schedule(filePath)
    })
    this.watcher.on('error', (err) => { try { this.onError(err) } catch { /* ignore */ } })
    return { started: true, debounceMs: this.debounceMs }
  }

  _schedule(filePath) {
    if (this._timer) clearTimeout(this._timer)
    this._timer = setTimeout(() => {
      this._timer = null
      Promise.resolve()
        .then(() => this.onRebuild(filePath))
        .catch(err => { try { this.onError(err) } catch { /* ignore */ } })
    }, this.debounceMs)
    if (this._timer.unref) this._timer.unref()
  }

  async stop() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    if (!this.watcher) return
    const w = this.watcher
    this.watcher = null
    try { await w.close() } catch { /* 关闭失败不影响退出 */ }
  }
}

module.exports = { ContextWatcher }
