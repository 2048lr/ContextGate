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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

class ProxyServer {
  constructor(options = {}) {
    this.contextFile = options.contextFile || ''
    this.configPath = options.configPath || path.join(options.dataDir || process.cwd(), 'config.yaml')
    this.projectRoot = options.projectRoot || null
    this.dataDir = options.dataDir || null
    this.eventBus = options.eventBus || new EventBus()
    this.configManager = new ConfigManager(this.configPath)
    this.providerRegistry = new ProviderRegistry()
    const cacheConfig = this.configManager.getCacheConfig()
    this.cacheManager = new CacheManager({
      maxEntries: options.cacheMaxEntries || 200,
      maxMemoryMB: options.cacheMaxMemoryMB || 100,
      ttlSeconds: options.cacheTtlSeconds !== undefined ? options.cacheTtlSeconds : cacheConfig.ttl_seconds,
    })
    this.budgetGuard = options.budgetGuard || null
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

  async init() {
    if (this._initialized) return this
    // FIX-S2：把全局安全姿态交给 forwarder，TLS 降级默认不可达
    setSecurityPolicy({ allowInsecureTls: this.configManager.get('security.allow_insecure_tls') === true })
    await this.providerRegistry.init(this.dataDir)
    if (this.contextFile && fs.existsSync(this.contextFile)) {
      this.cacheManager.loadContextSignature(this.contextFile, this.projectRoot)
    }
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
      localToken: this.localToken,
      proxyServer: this,
      contextFile: this.contextFile,
      projectRoot: this.projectRoot,
    })
    this._initialized = true
    return this
  }

  /** 重新签发本地令牌（UI 的「重置令牌」） */
  rotateLocalToken() {
    this.localToken = regenerateLocalToken(this.configManager)
    return this.localToken
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
          warnings,
        })
      })
      this.server.on('error', reject)
    })
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve()
      const srv = this.server
      this.server = null
      let resolved = false
      const done = () => { if (!resolved) { resolved = true; resolve() } }
      srv.close(done)
      // 防止 server 已关闭或出错时回调不执行导致 Promise 永久挂起
      srv.on('error', done)
      setTimeout(done, 3000)
    })
  }
}

module.exports = { ProxyServer, LOOPBACK_HOSTS }
