const fs = require('fs')
const yaml = require('js-yaml')
const { DEFAULT_PROXY_HOST, DEFAULT_PROXY_PORT } = require('./constants')

class ConfigManager {
  constructor(configPath) {
    this.configPath = configPath
    this.config = this._load()
  }

  _load() {
    try {
      if (fs.existsSync(this.configPath)) {
        return yaml.load(fs.readFileSync(this.configPath, 'utf8')) || {}
      }
    } catch (e) {
      console.error('Failed to load config:', e)
    }
    return {}
  }

  save() {
    try {
      const dir = require('path').dirname(this.configPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(this.configPath, yaml.dump(this.config, { lineWidth: -1 }), 'utf8')
      return true
    } catch (e) {
      console.error('Failed to save config:', e)
      return false
    }
  }

  reload() { this.config = this._load() }

  get(key, defaultValue) {
    const keys = key.split('.')
    let val = this.config
    for (const k of keys) {
      if (val == null) return defaultValue
      val = val[k]
    }
    return val !== undefined ? val : defaultValue
  }

  set(key, value) {
    const keys = key.split('.')
    let obj = this.config
    for (let i = 0; i < keys.length - 1; i++) {
      if (!obj[keys[i]] || typeof obj[keys[i]] !== 'object') obj[keys[i]] = {}
      obj = obj[keys[i]]
    }
    obj[keys[keys.length - 1]] = value
  }

  getWorkspace() { return this.config.workspace || null }
  setWorkspace(p) { this.config.workspace = p; return this.save() }

  getProviders() { return this.config.providers || {} }
  getProvider(name) { return (this.config.providers || {})[name] || null }
  setProvider(name, cfg) {
    if (!this.config.providers) this.config.providers = {}
    this.config.providers[name] = cfg
  }
  removeProvider(name) { if (this.config.providers) delete this.config.providers[name] }

  getDefaultProvider() { return this.config.default_provider || null }
  setDefaultProvider(name) { this.config.default_provider = name }

  getProxyConfig() { return this.config.proxy || { host: DEFAULT_PROXY_HOST, port: DEFAULT_PROXY_PORT } }
  getMonitorConfig() { return this.config.monitor || { budget_limit: 10 } }
  getCurrencyConfig() { return this.config.currency || {} }
  getContextConfig() { return this.config.context || { output_file: 'full_context.txt', max_tokens: 8000, watch_enabled: true, debounce_seconds: 1 } }
  getScannerConfig() { return this.config.scanner || { max_file_size: 1048576 } }
}

module.exports = { ConfigManager }
