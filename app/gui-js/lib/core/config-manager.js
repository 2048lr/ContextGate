const fs = require('fs')
const yaml = require('js-yaml')
const {
  DEFAULT_PROXY_HOST, DEFAULT_PROXY_PORT, DEFAULT_MAX_BODY_SIZE,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS, DEFAULT_STREAM_TOTAL_TIMEOUT_MS,
  DEFAULT_RETRY_STATUSES, DEFAULT_MAX_RETRIES, DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_MAX_DELAY_MS, DEFAULT_CIRCUIT_FAILURE_THRESHOLD, DEFAULT_CIRCUIT_COOLDOWN_MS,
  DEFAULT_MAX_CONCURRENCY, DEFAULT_MAX_QUEUE, DEFAULT_QUEUE_TIMEOUT_MS, DEFAULT_IDEMPOTENCY_HEADER,
  DEFAULT_MIN_CACHEABLE_PREFIX_TOKENS,
  DEFAULT_CACHE_MAX_DISK_MB, DEFAULT_CACHE_PERSIST_MAX_ENTRY_BYTES,
  DEFAULT_RETENTION_DAYS, DEFAULT_REQUEST_LOG_RETENTION_DAYS, DEFAULT_REQUEST_LOG_MAX_ENTRIES,
} = require('./constants')

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

  /**
   * FIX-13：密钥不再以明文写在配置文件里，而是存在 safeStorage 加密库中。
   * 主进程把「按 provider 取明文 Key」的回调注进来，配置文件里只保留
   * api_key_ref: 'secret' 标记；这样下游（代理、CLI 统计）读配置的代码无需改动。
   */
  setSecretResolver(resolver) { this._secretResolver = typeof resolver === 'function' ? resolver : null }

  _withSecret(name, provider) {
    if (!provider || typeof provider !== 'object') return provider
    if (provider.api_key || !this._secretResolver) return provider
    let secret = ''
    try { secret = this._secretResolver(name) || '' } catch { secret = '' }
    if (!secret) return provider
    return { ...provider, api_key: secret }
  }

  getProviders() {
    const providers = this.config.providers || {}
    if (!this._secretResolver) return providers
    const out = {}
    for (const [name, cfg] of Object.entries(providers)) out[name] = this._withSecret(name, cfg)
    return out
  }

  getProvider(name) { return this._withSecret(name, (this.config.providers || {})[name] || null) }
  setProvider(name, cfg) {
    if (!this.config.providers) this.config.providers = {}
    this.config.providers[name] = cfg
  }
  removeProvider(name) { if (this.config.providers) delete this.config.providers[name] }

  getDefaultProvider() { return this.config.default_provider || null }
  setDefaultProvider(name) { this.config.default_provider = name }

  getProxyConfig() {
    return { host: DEFAULT_PROXY_HOST, port: DEFAULT_PROXY_PORT, max_body_size: DEFAULT_MAX_BODY_SIZE, ...(this.config.proxy || {}) }
  }

  getAuthConfig() {
    return {
      enabled: true, host_check: true, allowed_hosts: [], allow_target_base_url: true,
      // FIX-13：密钥由 safeStorage 加密存储，配置里只留 api_key_ref 标记
      secrets_in_safe_storage: true,
      ...(this.config.proxy?.auth || {}),
    }
  }

  getMonitorConfig() {
    return {
      budget_limit: 10, warning_threshold: 75, critical_threshold: 90, enforce_budget: false,
      retention_days: DEFAULT_RETENTION_DAYS,
      ...(this.config.monitor || {}),
    }
  }

  getCurrencyConfig() { return this.config.currency || {} }

  // FIX-07：流式可靠性（客户端断开 / 空闲超时 / 总超时）
  getStreamConfig() {
    return {
      idle_timeout_ms: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      total_timeout_ms: DEFAULT_STREAM_TOTAL_TIMEOUT_MS,
      client_disconnect_grace_ms: 250,
      ...(this.config.proxy?.stream || {}),
    }
  }

  // FIX-08：重试 / 退避 / 熔断 / 降级 / 并发
  getResilienceConfig() {
    const raw = this.config.proxy?.resilience || {}
    const cb = raw.circuit_breaker || {}
    return {
      max_retries: DEFAULT_MAX_RETRIES,
      retry_statuses: DEFAULT_RETRY_STATUSES,
      base_delay_ms: DEFAULT_RETRY_BASE_DELAY_MS,
      max_delay_ms: DEFAULT_RETRY_MAX_DELAY_MS,
      jitter: true,
      respect_retry_after: true,
      // 只有带幂等键的写请求才会被重试，避免上游重复计费
      retry_non_idempotent: false,
      max_concurrency: DEFAULT_MAX_CONCURRENCY,
      max_queue: DEFAULT_MAX_QUEUE,
      queue_timeout_ms: DEFAULT_QUEUE_TIMEOUT_MS,
      idempotency_header: DEFAULT_IDEMPOTENCY_HEADER,
      fallback: {},
      ...raw,
      circuit_breaker: {
        enabled: cb.enabled !== false,
        failure_threshold: Number(cb.failure_threshold) > 0 ? Number(cb.failure_threshold) : DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
        cooldown_ms: Number(cb.cooldown_ms) > 0 ? Number(cb.cooldown_ms) : DEFAULT_CIRCUIT_COOLDOWN_MS,
      },
    }
  }

  // FIX-10：Prompt Caching
  getPromptCacheConfig() {
    return {
      enabled: true,
      anthropic_cache_control: true,
      openai_prefix_stability: true,
      min_prefix_tokens: DEFAULT_MIN_CACHEABLE_PREFIX_TOKENS,
      ...(this.config.proxy?.prompt_cache || {}),
    }
  }

  // FIX-11：协议兼容
  getProtocolConfig() {
    return {
      native_passthrough: true,
      extra_paths: [],
      ...(this.config.proxy?.protocols || {}),
    }
  }

  getContextConfig() {
    return {
      output_file: 'full_context.txt',
      format: 'markdown',
      max_tokens: 8000,
      enforce_budget: true,
      summarize_skipped: true,
      summary_lines: 12,
      watch_enabled: true,
      debounce_seconds: 1,
      secret_scan: true,
      ...(this.config.context || {}),
    }
  }

  getScannerConfig() { return { max_file_size: 1048576, ...(this.config.scanner || {}) } }

  // FIX-09：持久化缓存
  getCacheConfig() {
    return {
      ttl_seconds: 3600,
      persist: true,
      dir: '',
      max_entries: 200,
      max_memory_mb: 100,
      max_disk_mb: DEFAULT_CACHE_MAX_DISK_MB,
      persist_max_entry_bytes: DEFAULT_CACHE_PERSIST_MAX_ENTRY_BYTES,
      ...(this.config.cache || {}),
    }
  }

  // FIX-12：数据保留与请求级日志
  getRequestLogConfig() {
    const raw = this.config.monitor?.request_log || {}
    return {
      enabled: true,
      retention_days: DEFAULT_REQUEST_LOG_RETENTION_DAYS,
      max_entries: DEFAULT_REQUEST_LOG_MAX_ENTRIES,
      ...raw,
    }
  }
}

module.exports = { ConfigManager }
