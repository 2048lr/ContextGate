const express = require('express')
const fs = require('fs')
const path = require('path')
const { DEFAULT_PROXY_HOST, DEFAULT_PROXY_PORT } = require('../core/constants')
const { EventBus } = require('../core/event-bus')
const { CacheManager } = require('./cache-manager')
const { ConfigManager } = require('../core/config-manager')
const { ProviderRegistry } = require('./provider-registry')
const { createRoutes } = require('./router')
const { createLocalAuth, ensureLocalToken, regenerateLocalToken } = require('./auth')
const { setSecurityPolicy, getSecurityPolicy } = require('./forwarder')
const { ResilienceGate } = require('./resilience')
const { PromptCacheStats } = require('./prompt-cache')

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

class ProxyServer {
  constructor(options = {}) {
    this.contextFile = options.contextFile || ''
    this.configPath = options.configPath || path.join(options.dataDir || process.cwd(), 'config.yaml')
    this.projectRoot = options.projectRoot || null
    this.dataDir = options.dataDir || null
    this.eventBus = options.eventBus || new EventBus()
    // FIX-13：允许注入带「密钥解析器」的 ConfigManager，
    // 这样代理无需知道 API Key 是明文还是取自 safeStorage 加密库。
    this.configManager = options.configManager || new ConfigManager(this.configPath)
    this.providerRegistry = new ProviderRegistry()
    const cacheConfig = this.configManager.getCacheConfig()
    // FIX-09：默认把缓存落到 <dataDir>/cache，重启后仍可复用
    const persistEnabled = cacheConfig.persist !== false
    const cacheDir = options.cacheDir
      || cacheConfig.dir
      || (persistEnabled && options.dataDir ? path.join(options.dataDir, 'cache') : '')
    this.cacheManager = new CacheManager({
      maxEntries: options.cacheMaxEntries || cacheConfig.max_entries,
      maxMemoryMB: options.cacheMaxMemoryMB || cacheConfig.max_memory_mb,
      ttlSeconds: options.cacheTtlSeconds !== undefined ? options.cacheTtlSeconds : cacheConfig.ttl_seconds,
      dir: typeof cacheDir === 'string' ? cacheDir : '',
      maxDiskBytes: (Number(cacheConfig.max_disk_mb) || 0) * 1024 * 1024,
      persistMaxEntryBytes: cacheConfig.persist_max_entry_bytes,
      contextBinding: cacheConfig.context_binding === 'off' ? 'off' : 'hash',
      logger: console,
    })
    this.budgetGuard = options.budgetGuard || null
    // FIX-08：熔断状态必须在所有请求间共享，因此由 ProxyServer 持有
    this.resilience = options.resilience || new ResilienceGate({ config: this.configManager.getResilienceConfig() })
    this.promptCacheStats = options.promptCacheStats || new PromptCacheStats()
    this.requestLog = options.requestLog || null
    // FIX-17：/metrics 需要用量总览；由主进程注入 tokenMonitor.getSummary 之类的读取器
    this.getUsageSummary = options.getUsageSummary || null
    this.localToken = null
    this.app = express()
    this.server = null
    this._initialized = false
  }

  /** 配置里显式要求关闭 TLS 校验的 provider（FIX-S2） */
  providersRequestingInsecureTls() {
    const providers = this.configManager.getProviders() || {}
    return Object.entries(providers)
      .filter(([, cfg]) => cfg && cfg.tls && cfg.tls.reject_unauthorized === false)
      .map(([name]) => name)
  }

  /** FIX-12 / FIX-17：请求级脱敏日志（可选；装配失败不应影响代理可用性） */
  _createRequestLog() {
    if (this.requestLog) return this.requestLog
    const cfg = this.configManager.getRequestLogConfig()
    if (cfg.enabled === false) return null
    const dataDir = this.dataDir || process.cwd()
    try {
      if (cfg.format === 'jsonl') {
        const { JsonlRequestLog } = require('../monitor/jsonl-request-log')
        const filePath = path.isAbsolute(cfg.file) ? cfg.file : path.join(dataDir, cfg.file || 'requests.jsonl')
        this.requestLog = new JsonlRequestLog({
          filePath,
          retentionDays: cfg.retention_days,
          logger: console,
        })
        return this.requestLog
      }
      const { RequestLog } = require('../monitor/request-log')
      const dbPath = path.join(dataDir, 'contextgate.db')
      this.requestLog = new RequestLog({
        dbPath,
        retentionDays: cfg.retention_days,
        maxEntries: cfg.max_entries,
        logger: console,
      })
      return this.requestLog
    } catch (e) {
      console.warn('[proxy] 请求级日志不可用:', e.message)
      return null
    }
  }

  async init() {
    if (this._initialized) return this
    // FIX-S2：把全局安全姿态交给 forwarder，TLS 降级默认不可达
    setSecurityPolicy({ allowInsecureTls: this.configManager.get('security.allow_insecure_tls') === true })
    await this.providerRegistry.init(this.dataDir)
    // FIX-09：先把磁盘上的缓存载回内存，避免重启后命中率归零
    await this.cacheManager.init()
    if (this.contextFile && fs.existsSync(this.contextFile)) {
      this.cacheManager.loadContextSignature(this.contextFile, this.projectRoot)
    }
    this._createRequestLog()
    // FIX-02：鉴权中间件必须挂在 body 解析器与所有路由之前
    const authConfig = this.configManager.getAuthConfig()
    this.localToken = authConfig.enabled ? ensureLocalToken(this.configManager) : this.configManager.get('proxy.local_token', null)
    this.app.use(createLocalAuth(this.configManager, { token: this.localToken }))
    createRoutes(this.app, {
      cacheManager: this.cacheManager,
      configManager: this.configManager,
      providerRegistry: this.providerRegistry,
      eventBus: this.eventBus,
      budgetGuard: this.budgetGuard,
      resilience: this.resilience,
      promptCacheStats: this.promptCacheStats,
      requestLog: this.requestLog,
      localToken: this.localToken,
      proxyServer: this,
      contextFile: this.contextFile,
      projectRoot: this.projectRoot,
      getUsageSummary: this.getUsageSummary,
    })
    this._initialized = true
    return this
  }

  /** 配置热更新后重新读取降级链（否则改配置要重启才生效） */
  refreshResilience() {
    const cfg = this.configManager.getResilienceConfig()
    this.resilience.setFallbackMap(cfg.fallback)
    return cfg
  }

  /** 重新签发本地令牌（UI 的「重置令牌」） */
  rotateLocalToken() {
    this.localToken = regenerateLocalToken(this.configManager)
    return this.localToken
  }

  /** FIX-09：清理过期缓存 + FIX-12：清理过期日志 */
  async maintenance() {
    const prunedCache = this.cacheManager.pruneExpired()
    let prunedLogs = 0
    try { prunedLogs = this.requestLog ? await this.requestLog.prune() : 0 } catch { /* 忽略 */ }
    return { prunedCache, prunedLogs }
  }

  async start(host = DEFAULT_PROXY_HOST, port = DEFAULT_PROXY_PORT) {
    await this.init()
    const warnings = []
    const authConfig = this.configManager.getAuthConfig()
    const policy = getSecurityPolicy()
    const insecureProviders = this.providersRequestingInsecureTls()
    if (insecureProviders.length > 0 && policy.allowInsecureTls) {
      warnings.push(`不安全连接已启用：${insecureProviders.join(', ')} 关闭了 TLS 证书校验，API Key 与内容可能被中间人截获。`)
    } else if (insecureProviders.length > 0) {
      warnings.push(`以下 provider 请求关闭 TLS 校验，但 security.allow_insecure_tls 未开启，已按安全默认值继续校验证书：${insecureProviders.join(', ')}。`)
    }
    if (!LOOPBACK_HOSTS.has(String(host).toLowerCase())) {
      warnings.push(`代理绑定在 ${host}（非回环地址），同一局域网内的任何设备都可能访问它并使用你的 API Key。`)
      if (authConfig.host_check !== false) {
        warnings.push('当前启用了 Host 头校验，远程客户端会被 403 拒绝；如需放行，请把它们的主机名加入 proxy.auth.allowed_hosts。')
      }
    }
    if (authConfig.enabled === false) {
      warnings.push('本地令牌鉴权已被关闭（proxy.auth.enabled=false），本机任意进程都可直接使用该代理。')
    }
    const resilienceCfg = this.configManager.getResilienceConfig()
    if (resilienceCfg.retry_non_idempotent === true) {
      warnings.push('proxy.resilience.retry_non_idempotent 已开启：失败的写请求会被重试，上游可能重复计费。')
    }
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(port, host, () => {
        // 启动成功后替换为运行期错误处理器，防止 error 事件无人处理导致进程崩溃
        this.server.removeAllListeners('error')
        this.server.on('error', (err) => console.error('[ProxyServer] runtime error:', err))
        const boundPort = this.server.address()?.port ?? port
        resolve({
          port: boundPort, host, token: this.localToken,
          authEnabled: authConfig.enabled !== false,
          allowInsecureTls: policy.allowInsecureTls,
          cachePersist: this.cacheManager.diskStore.enabled ? this.cacheManager.diskStore.dir : null,
          requestLogEnabled: Boolean(this.requestLog),
          warnings,
        })
      })
      this.server.on('error', reject)
    })
  }

  /** 关闭 RequestLog 持有的 sqlite 句柄（FIX-12）；否则 Windows 上文件会被占用无法删除/替换 */
  async closeRequestLog() {
    if (!this.requestLog) return
    const log = this.requestLog
    this.requestLog = null
    try { await log.close() } catch (e) { console.warn('[proxy] 关闭请求日志失败:', e.message) }
  }

  async flushState() {
    try { await this.requestLog?.flush?.() } catch { /* 忽略 */ }
    await this.closeRequestLog()
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) { this.closeRequestLog().finally(() => resolve()); return }
      const srv = this.server
      this.server = null
      let resolved = false
      const done = () => { if (!resolved) { resolved = true; this.closeRequestLog().finally(() => resolve()) } }
      srv.close(done)
      // 防止 server 已关闭或出错时回调不执行导致 Promise 永久挂起
      srv.on('error', done)
      setTimeout(done, 3000)
    })
  }
}

module.exports = { ProxyServer, LOOPBACK_HOSTS }
