let config = {}
let currentProject = null
let totalTokens = 0
let monthlySavings = 0
let currentCurrency = 'USD'
let currentProvider = null
let providers = {}
let proxyRunning = false

const currencySymbols = {
  USD: '$',
  CNY: '￥',
  EUR: '€'
}

const i18n = {
  zh_CN: {
    sidebar_title: '项目概览',
    active_project: '当前项目',
    total_tokens: '总 Token',
    monthly_savings: '本月节省',
    requests_log: '请求日志',
    cache_hit: '缓存命中',
    cache_miss: '缓存未命中',
    proxy_port: '代理端口',
    connection_status: '连接状态',
    connected: '已连接',
    disconnected: '已断开',
    billing_currency: '计费币种',
    select_project: '选择项目',
    build_context: '构建上下文',
    start_proxy: '启动代理',
    stop_proxy: '停止代理',
    settings: '设置'
  },
  en_US: {
    sidebar_title: 'Project Overview',
    active_project: 'Active Project',
    total_tokens: 'Total Tokens',
    monthly_savings: 'Monthly Savings',
    requests_log: 'Request Log',
    cache_hit: 'Cache Hit',
    cache_miss: 'Cache Miss',
    proxy_port: 'Proxy Port',
    connection_status: 'Connection',
    connected: 'Connected',
    disconnected: 'Disconnected',
    billing_currency: 'Currency',
    select_project: 'Select Project',
    build_context: 'Build Context',
    start_proxy: 'Start Proxy',
    stop_proxy: 'Stop Proxy',
    settings: 'Settings'
  }
}

let currentLang = 'zh_CN'

function t(key) {
  return i18n[currentLang][key] || key
}

async function init() {
  await loadBackground()
  await loadConfig()
  setupEventListeners()
  setupProxyListeners()
  detectLanguage()
  await checkProxyStatus()
}

async function loadBackground() {
  try {
    const url = await window.electronAPI.getBackgroundUrl()
    const container = document.getElementById('background-container')
    container.style.backgroundImage = `url('${url}')`
  } catch (e) {
    console.error('Failed to load background:', e)
  }
}

async function loadConfig() {
  try {
    config = await window.electronAPI.getConfig()
    providers = config.providers || {}
    updateProviderList()
    
    if (config.workspace) {
      currentProject = config.workspace
      document.getElementById('project-label').textContent = `${t('active_project')}:\n${currentProject}`
    }
    
    updateCurrencyFromConfig()
  } catch (e) {
    console.error('Failed to load config:', e)
  }
}

function detectLanguage() {
  const locale = navigator.language || 'en_US'
  if (locale.startsWith('zh')) {
    currentLang = 'zh_CN'
  } else {
    currentLang = 'en_US'
  }
}

function updateCurrencyFromConfig() {
  const currencyConfig = config.currency || {}
  if (currencyConfig.fixed_currency) {
    currentCurrency = currencyConfig.fixed_currency
  } else {
    const providers = config.providers || {}
    for (const name in providers) {
      const provider = providers[name]
      const baseUrl = provider.base_url || ''
      if (baseUrl.includes('.cn') || baseUrl.includes('zhipu') || baseUrl.includes('deepseek')) {
        currentCurrency = 'CNY'
        currentLang = 'zh_CN'
      }
      break
    }
  }
  updateCurrencyLabel()
}

function updateCurrencyLabel() {
  const symbol = currencySymbols[currentCurrency] || '$'
  document.getElementById('currency-label').textContent = `${t('billing_currency')}: ${currentCurrency} (${symbol})`
}

function updateProviderList() {
  const select = document.getElementById('provider-select')
  select.innerHTML = ''
  
  for (const name in providers) {
    const option = document.createElement('option')
    option.value = name
    option.textContent = name
    select.appendChild(option)
  }
  
  if (select.options.length > 0) {
    select.selectedIndex = 0
    loadProviderToEditor(select.options[0].value)
  }
}

function loadProviderToEditor(name) {
  currentProvider = name
  const provider = providers[name] || {}
  
  document.getElementById('provider-api-key').value = provider.api_key || ''
  document.getElementById('provider-base-url').value = provider.base_url || ''
  document.getElementById('provider-models').value = (provider.models || []).join('\n')
}

function saveProviderFromEditor() {
  if (!currentProvider) return
  
  providers[currentProvider] = {
    api_key: document.getElementById('provider-api-key').value,
    base_url: document.getElementById('provider-base-url').value,
    models: document.getElementById('provider-models').value.split('\n').filter(m => m.trim())
  }
}

function setupEventListeners() {
  document.getElementById('btn-select-project').addEventListener('click', selectProject)
  document.getElementById('btn-build-context').addEventListener('click', buildContext)
  document.getElementById('btn-start-proxy').addEventListener('click', startProxy)
  document.getElementById('btn-stop-proxy').addEventListener('click', stopProxy)
  document.getElementById('btn-settings').addEventListener('click', openSettings)
  document.getElementById('btn-close-settings').addEventListener('click', closeSettings)
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings)
  document.getElementById('btn-cancel-settings').addEventListener('click', closeSettings)
  
  document.getElementById('btn-minimize').addEventListener('click', () => window.electronAPI.minimizeWindow())
  document.getElementById('btn-maximize').addEventListener('click', () => window.electronAPI.maximizeWindow())
  document.getElementById('btn-close').addEventListener('click', () => window.electronAPI.closeWindow())
  
  document.getElementById('provider-select').addEventListener('change', (e) => {
    saveProviderFromEditor()
    loadProviderToEditor(e.target.value)
  })
  
  document.getElementById('btn-add-provider').addEventListener('click', addProvider)
  document.getElementById('btn-remove-provider').addEventListener('click', removeProvider)
  
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab))
  })
  
  document.querySelectorAll('[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => addPreset(btn.dataset.preset))
  })
  
  document.getElementById('settings-modal').addEventListener('click', (e) => {
    if (e.target.id === 'settings-modal') {
      closeSettings()
    }
  })
}

function setupProxyListeners() {
  window.electronAPI.onProxyLog((data) => {
    console.log('Proxy log:', data)
    addLogEntry({
      model: 'proxy',
      tokens: 0,
      cost: 0,
      cacheHit: false
    })
  })
  
  window.electronAPI.onProxyError((data) => {
    console.error('Proxy error:', data)
  })
  
  window.electronAPI.onProxyStopped(() => {
    proxyRunning = false
    updateProxyUI()
  })
}

async function checkProxyStatus() {
  try {
    const status = await window.electronAPI.proxyStatus()
    proxyRunning = status.running
    updateProxyUI()
  } catch (e) {
    console.error('Failed to check proxy status:', e)
  }
}

function updateProxyUI() {
  const startBtn = document.getElementById('btn-start-proxy')
  const stopBtn = document.getElementById('btn-stop-proxy')
  const statusLabel = document.getElementById('status-label')
  
  if (proxyRunning) {
    startBtn.disabled = true
    stopBtn.disabled = false
    statusLabel.textContent = `${t('connection_status')}: ${t('connected')}`
    statusLabel.classList.add('connected')
  } else {
    startBtn.disabled = false
    stopBtn.disabled = true
    statusLabel.textContent = `${t('connection_status')}: ${t('disconnected')}`
    statusLabel.classList.remove('connected')
  }
}

async function selectProject() {
  const folder = await window.electronAPI.selectFolder()
  if (folder) {
    currentProject = folder
    document.getElementById('project-label').textContent = `${t('active_project')}:\n${folder}`
    config.workspace = folder
    await window.electronAPI.saveConfig(config)
  }
}

async function buildContext() {
  if (!currentProject) {
    alert(t('select_project'))
    return
  }
  
  try {
    const result = await window.electronAPI.buildContext(currentProject)
    if (result.success) {
      addLogEntry({
        model: 'scanner',
        tokens: 0,
        cost: 0,
        cacheHit: true
      })
    } else {
      alert('构建失败: ' + result.error)
    }
  } catch (e) {
    alert('构建失败: ' + e.message)
  }
}

async function startProxy() {
  const port = config.proxy?.port || 8000
  const result = await window.electronAPI.startProxy(port)
  
  if (result.success) {
    proxyRunning = true
    updateProxyUI()
    document.getElementById('port-label').textContent = `${t('proxy_port')}: ${result.port || port}`
  } else {
    alert('启动代理失败: ' + result.error)
  }
}

async function stopProxy() {
  const result = await window.electronAPI.stopProxy()
  if (result.success) {
    proxyRunning = false
    updateProxyUI()
  }
}

function openSettings() {
  loadConfigToSettings()
  document.getElementById('settings-modal').classList.remove('hidden')
}

function closeSettings() {
  document.getElementById('settings-modal').classList.add('hidden')
}

function loadConfigToSettings() {
  const proxyConfig = config.proxy || {}
  document.getElementById('proxy-host').value = proxyConfig.host || '127.0.0.1'
  document.getElementById('proxy-port').value = proxyConfig.port || 8080
  document.getElementById('proxy-sanitize').checked = proxyConfig.sanitize_requests !== false
  document.getElementById('default-provider').value = config.default_provider || 'openai'
  
  const monitorConfig = config.monitor || {}
  document.getElementById('budget-limit').value = monitorConfig.budget_limit || 10
  document.getElementById('warning-threshold').value = monitorConfig.warning_threshold || 75
  document.getElementById('critical-threshold').value = monitorConfig.critical_threshold || 90
  document.getElementById('db-path').value = monitorConfig.db_path || 'contextgate.db'
  
  const scannerConfig = config.scanner || {}
  document.getElementById('max-file-size').value = scannerConfig.max_file_size || 1048576
  document.getElementById('include-extensions').value = (scannerConfig.include_extensions || []).join('\n')
  
  const contextConfig = config.context || {}
  document.getElementById('output-file').value = contextConfig.output_file || 'full_context.txt'
  document.getElementById('watch-enabled').checked = contextConfig.watch_enabled !== false
  document.getElementById('debounce-seconds').value = contextConfig.debounce_seconds || 1
  
  const currencyConfig = config.currency || {}
  document.getElementById('fixed-currency').value = currencyConfig.fixed_currency || ''
  document.getElementById('fixed-rate').value = currencyConfig.fixed_rate || ''
  const rates = currencyConfig.default_rates || {}
  document.getElementById('cny-rate').value = rates.CNY || 7.2
  document.getElementById('eur-rate').value = rates.EUR || 0.92
}

async function saveSettings() {
  saveProviderFromEditor()
  
  config.providers = providers
  config.proxy = {
    host: document.getElementById('proxy-host').value,
    port: parseInt(document.getElementById('proxy-port').value),
    sanitize_requests: document.getElementById('proxy-sanitize').checked
  }
  config.default_provider = document.getElementById('default-provider').value
  
  config.monitor = {
    budget_limit: parseFloat(document.getElementById('budget-limit').value),
    warning_threshold: parseInt(document.getElementById('warning-threshold').value),
    critical_threshold: parseInt(document.getElementById('critical-threshold').value),
    db_path: document.getElementById('db-path').value
  }
  
  config.scanner = {
    max_file_size: parseInt(document.getElementById('max-file-size').value),
    include_extensions: document.getElementById('include-extensions').value.split('\n').filter(e => e.trim())
  }
  
  config.context = {
    output_file: document.getElementById('output-file').value,
    watch_enabled: document.getElementById('watch-enabled').checked,
    debounce_seconds: parseFloat(document.getElementById('debounce-seconds').value)
  }
  
  const fixedCurrency = document.getElementById('fixed-currency').value
  const fixedRate = document.getElementById('fixed-rate').value
  config.currency = {
    default_rates: {
      CNY: parseFloat(document.getElementById('cny-rate').value),
      EUR: parseFloat(document.getElementById('eur-rate').value)
    }
  }
  if (fixedCurrency) {
    config.currency.fixed_currency = fixedCurrency
  }
  if (fixedRate) {
    config.currency.fixed_rate = parseFloat(fixedRate)
  }
  
  const success = await window.electronAPI.saveConfig(config)
  if (success) {
    alert(t('settings') + ' 已保存')
    closeSettings()
    updateCurrencyFromConfig()
  } else {
    alert('保存失败')
  }
}

function addProvider() {
  let name = '新提供商'
  let counter = 1
  while (providers[name]) {
    name = `新提供商_${counter}`
    counter++
  }
  
  providers[name] = {
    api_key: '',
    base_url: '',
    models: []
  }
  
  updateProviderList()
  const select = document.getElementById('provider-select')
  select.value = name
  loadProviderToEditor(name)
}

function removeProvider() {
  const select = document.getElementById('provider-select')
  const name = select.value
  if (!name) return
  
  if (confirm(`确定要删除提供商 '${name}' 吗？`)) {
    delete providers[name]
    updateProviderList()
  }
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId)
  })
  document.querySelectorAll('.tab-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === `tab-${tabId}`)
  })
}

function addPreset(preset) {
  const textarea = document.getElementById('include-extensions')
  const current = new Set(textarea.value.split('\n').filter(e => e.trim()))
  
  const presets = {
    python: ['.py', '.pyw'],
    web: ['.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.json'],
    common: ['.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.md', '.txt', '.json', '.yaml', '.yml']
  }
  
  presets[preset].forEach(ext => current.add(ext))
  textarea.value = Array.from(current).sort().join('\n')
}

function addLogEntry(data) {
  const logContent = document.getElementById('log-content')
  const time = new Date().toLocaleTimeString()
  
  const entry = document.createElement('div')
  entry.className = 'log-entry'
  
  const statusClass = data.cacheHit ? 'log-hit' : 'log-miss'
  const statusText = data.cacheHit ? t('cache_hit') : t('cache_miss')
  
  entry.innerHTML = `
    <span class="log-time">${time}</span> | 
    <span class="log-model">${data.model.padEnd(20)}</span> | 
    <span class="log-tokens">${data.tokens.toLocaleString().padStart(8)}</span> | 
    <span class="log-cost">${formatCost(data.cost).padStart(10)}</span> | 
    <span class="${statusClass}">[${statusText}]</span>
  `
  
  logContent.appendChild(entry)
  logContent.scrollTop = logContent.scrollHeight
  
  totalTokens += data.tokens
  document.getElementById('tokens-label').textContent = `${t('total_tokens')}: ${totalTokens.toLocaleString()}`
}

function formatCost(cost) {
  const symbol = currencySymbols[currentCurrency] || '$'
  if (currentCurrency === 'USD') {
    return `${symbol}${cost.toFixed(4)}`
  } else {
    const rate = (config.currency?.default_rates?.[currentCurrency]) || 1
    return `${symbol}${(cost * rate).toFixed(2)}`
  }
}

init()
