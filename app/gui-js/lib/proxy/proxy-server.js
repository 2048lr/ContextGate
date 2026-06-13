const express = require('express')
const fs = require('fs')
const { DEFAULT_PROXY_HOST, DEFAULT_PROXY_PORT } = require('../core/constants')
const { EventBus } = require('../core/event-bus')
const { CacheManager } = require('./cache-manager')
const { ConfigManager } = require('../core/config-manager')
const { ProviderRegistry } = require('./provider-registry')
const { createRoutes } = require('./router')

class ProxyServer {
  constructor(options = {}) {
    this.contextFile = options.contextFile || ''
    this.configPath = options.configPath || ''
    this.projectRoot = options.projectRoot || null
    this.dataDir = options.dataDir || null
    this.eventBus = options.eventBus || new EventBus()
    this.configManager = new ConfigManager(this.configPath)
    this.providerRegistry = new ProviderRegistry()
    this.cacheManager = new CacheManager({
      maxEntries: options.cacheMaxEntries || 200,
      maxMemoryMB: options.cacheMaxMemoryMB || 100,
    })
    this.app = express()
    this.server = null
    this._initialized = false
  }

  async init() {
    if (this._initialized) return this
    await this.providerRegistry.init(this.dataDir)
    if (this.contextFile && fs.existsSync(this.contextFile)) {
      this.cacheManager.loadContextSignature(this.contextFile, this.projectRoot)
    }
    createRoutes(this.app, {
      cacheManager: this.cacheManager,
      configManager: this.configManager,
      providerRegistry: this.providerRegistry,
      eventBus: this.eventBus,
      proxyServer: this,
      contextFile: this.contextFile,
      projectRoot: this.projectRoot,
    })
    this._initialized = true
    return this
  }

  async start(host = DEFAULT_PROXY_HOST, port = DEFAULT_PROXY_PORT) {
    await this.init()
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(port, host, () => resolve({ port, host }))
      this.server.on('error', reject)
    })
  }

  stop() {
    if (this.server) { this.server.close(); this.server = null }
  }
}

module.exports = { ProxyServer }
