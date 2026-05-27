const fs = require('fs')
const yaml = require('js-yaml')
const { DEFAULT_PROXY_HOST, DEFAULT_PROXY_PORT } = require('../config')
const { ProviderRegistry } = require('./provider')

class ConfigManager {
  constructor(configPath) {
    this.configPath = configPath
    this.config = this._load()
    this.providerRegistry = new ProviderRegistry()
    this._initPromise = null
  }

  async init(dataDir) {
    if (!this._initPromise) {
      this._initPromise = this.providerRegistry.init(dataDir)
    }
    await this._initPromise
    return this
  }

  _load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const content = fs.readFileSync(this.configPath, 'utf8')
        return yaml.load(content) || {}
      }
    } catch (e) {
      console.error('Failed to load config:', e)
    }
    return {}
  }

  save() {
    try {
      const yamlStr = yaml.dump(this.config, { lineWidth: -1 })
      fs.writeFileSync(this.configPath, yamlStr, 'utf8')
      return true
    } catch (e) {
      console.error('Failed to save config:', e)
      return false
    }
  }

  reload() {
    this.config = this._load()
  }

  getWorkspace() {
    return this.config.workspace || null
  }

  setWorkspace(workspacePath) {
    this.config.workspace = workspacePath
    return this.save()
  }

  getProvider(providerName) {
    const userConfig = (this.config.providers || {})[providerName]
    if (!userConfig && !this.providerRegistry) return null
    if (!userConfig) {
      const builtin = require('./provider').BUILTIN_PROVIDERS[providerName]
      if (!builtin) return null
      return this.providerRegistry.resolveProvider(providerName, {})
    }
    return this.providerRegistry.resolveProvider(providerName, userConfig)
  }

  getRawProviderConfig(providerName) {
    return (this.config.providers || {})[providerName] || null
  }

  getDefaultProvider() {
    return this.config.default_provider || null
  }

  setDefaultProvider(name) {
    this.config.default_provider = name
  }

  getAllProviders() {
    return this.config.providers || {}
  }

  getResolvedProviders() {
    const userProviders = this.config.providers || {}
    const result = {}
    for (const [name, _] of Object.entries(userProviders)) {
      result[name] = this.getProvider(name)
    }
    return result
  }

  addProvider(name, config) {
    if (!this.config.providers) this.config.providers = {}
    this.config.providers[name] = {
      api_key: config.api_key || '',
      base_url: config.base_url || '',
      models: config.models || [],
      ...config
    }
  }

  removeProvider(name) {
    if (!this.config.providers) return
    delete this.config.providers[name]
  }

  getModelsFromCatalog(providerName) {
    if (!this.providerRegistry) return []
    return this.providerRegistry.getModelsFromModelsDev(providerName)
  }

  getRecommendedModels(providerName) {
    if (!this.providerRegistry) return []
    return this.providerRegistry.getRecommendedModels(providerName)
  }

  searchCatalogModels(query) {
    if (!this.providerRegistry) return []
    const ModelsDev = require('./models-dev')
    return ModelsDev.searchModels(query, this.providerRegistry.modelsDevData)
  }

  getAvailableCatalogProviders() {
    if (!this.providerRegistry) return []
    return this.providerRegistry.getAvailableProviders()
  }

  getProxyConfig() {
    return this.config.proxy || { host: DEFAULT_PROXY_HOST, port: DEFAULT_PROXY_PORT }
  }

  getMonitorConfig() {
    return this.config.monitor || { enabled: true, monthly_limit: 100 }
  }

  getCurrencyConfig() {
    return this.config.currency || { currency: 'USD', exchange_rates: {} }
  }

  getModelCostInfo(providerName, modelId) {
    if (!this.providerRegistry) return null
    return this.providerRegistry.enrichProviderWithCost(providerName, modelId)
  }
}

module.exports = { ConfigManager }
