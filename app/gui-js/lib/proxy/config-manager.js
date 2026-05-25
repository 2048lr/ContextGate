const fs = require('fs')
const yaml = require('js-yaml')
const { DEFAULT_PROXY_HOST, DEFAULT_PROXY_PORT } = require('../config')

/**
 * @typedef {Object} ProviderConfig
 * @property {string} base_url - Provider API base URL
 * @property {string} api_key - Provider API key
 * @property {number} [timeout] - Request timeout in ms
 * @property {Object} [tls] - TLS configuration
 * @property {boolean} [tls.reject_unauthorized] - Whether to reject unauthorized certs
 */

/**
 * @typedef {Object} ProxyConfig
 * @property {string} [host='127.0.0.1'] - Proxy listen host
 * @property {number} [port=12306] - Proxy listen port
 */

/**
 * @typedef {Object} MonitorConfig
 * @property {boolean} [enabled=true] - Whether monitoring is enabled
 * @property {number} [monthly_limit=100] - Monthly spending limit
 */

/**
 * @typedef {Object} CurrencyConfig
 * @property {string} [currency='USD'] - Currency code
 * @property {Object.<string, number>} [exchange_rates] - Exchange rates map
 */

/**
 * Manages YAML-based configuration for the AI proxy.
 */
class ConfigManager {
  /**
   * @param {string} configPath - Path to the YAML configuration file
   */
  constructor(configPath) {
    /** @type {string} */
    this.configPath = configPath
    /** @type {Object} */
    this.config = this._load()
  }

  /**
   * Load configuration from YAML file.
   * @returns {Object} Parsed configuration object
   * @private
   */
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

  /**
   * Save current configuration back to the YAML file.
   * @returns {boolean} True if saved successfully
   */
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

  /**
   * @returns {string|null} Workspace path
   */
  getWorkspace() {
    return this.config.workspace || null
  }

  /**
   * @param {string} workspacePath - New workspace path
   * @returns {boolean} True if saved successfully
   */
  setWorkspace(workspacePath) {
    this.config.workspace = workspacePath
    return this.save()
  }

  /**
   * @param {string} providerName - Name of the provider
   * @returns {ProviderConfig|null} Provider configuration, or null if not found
   */
  getProvider(providerName) {
    const providers = this.config.providers || {}
    return providers[providerName] || null
  }

  /**
   * @returns {string|null} Default provider name
   */
  getDefaultProvider() {
    return this.config.default_provider || null
  }

  /**
   * @returns {Object.<string, ProviderConfig>} All provider configurations
   */
  getAllProviders() {
    return this.config.providers || {}
  }

  /**
   * @returns {ProxyConfig} Proxy configuration
   */
  getProxyConfig() {
    return this.config.proxy || { host: DEFAULT_PROXY_HOST, port: DEFAULT_PROXY_PORT }
  }

  /**
   * @returns {MonitorConfig} Monitor configuration
   */
  getMonitorConfig() {
    return this.config.monitor || { enabled: true, monthly_limit: 100 }
  }

  /**
   * @returns {CurrencyConfig} Currency configuration
   */
  getCurrencyConfig() {
    return this.config.currency || { currency: 'USD', exchange_rates: {} }
  }
}

module.exports = { ConfigManager }
