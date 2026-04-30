let config = {}
let currentProject = null
let proxyRunning = false
let stats = {
  todayRequests: 0,
  todayTokens: 0,
  todaySavings: 0,
  cacheHits: 0
}
let currentCurrency = 'USD'

const currencySymbols = { USD: '$', CNY: '￥', EUR: '€' }

const toolConfigs = {
  cursor: {
    name: 'Cursor',
    config: {
      "apiKey": "{YOUR_API_KEY}",
      "baseUrl": "http://127.0.0.1:12306/v1",
      "model": "gpt-4"
    }
  },
  cline: {
    name: 'cline',
    config: {
      "openaiApiKey": "{YOUR_API_KEY}",
      "openaiBaseUrl": "http://127.0.0.1:12306/v1"
    }
  },
  continue: {
    name: 'Continue',
    config: {
      "apiKey": "{YOUR_API_KEY}",
      "baseUrl": "http://127.0.0.1:12306/v1",
      "model": "gpt-4"
    }
  },
  windsurf: {
    name: 'Windsurf',
    config: {
      "apiKey": "{YOUR_API_KEY}",
      "baseUrl": "http://127.0.0.1:12306/v1",
      "model": "gpt-4"
    }
  }
}

async function init() {
  await loadBackground()
  await loadConfig()
  await loadStats()
  setupEventListeners()
  setupProxyListeners()
  await checkProxyStatus()
  updateMemoryUsage()
  setInterval(updateMemoryUsage, 5000)
}

async function loadBackground() {
  try {
    const url = await window.electronAPI.getBackgroundUrl()
    document.getElementById('background-container').style.backgroundImage = `url('${url}')`
  } catch (e) {
    console.error('Failed to load background:', e)
  }
}

async function loadConfig() {
  try {
    config = await window.electronAPI.getConfig()
    if (config.workspace) {
      currentProject = config.workspace
      updateProjectUI()
    }
    updateCurrencyFromConfig()
  } catch (e) {
    console.error('Failed to load config:', e)
  }
}

async function loadStats() {
  try {
    const summary = await window.electronAPI.getStats()
    if (summary) {
      stats = {
        todayRequests: summary.today?.requests || 0,
        todayTokens: summary.today?.tokens || 0,
        todaySavings: summary.today?.cost || 0,
        cacheHits: summary.total?.cacheHits || 0
      }
      updateStatsUI()
      updateContextHash()
    }
  } catch (e) {
    console.error('Failed to load stats:', e)
  }
}

function updateCurrencyFromConfig() {
  const currencyConfig = config.currency || {}
  if (currencyConfig.fixed_currency) {
    currentCurrency = currencyConfig.fixed_currency
  } else {
    const providers = config.providers || {}
    for (const name in providers) {
      const baseUrl = providers[name].base_url || ''
      if (baseUrl.includes('.cn') || baseUrl.includes('zhipu')) {
        currentCurrency = 'CNY'
      }
    }
  }
}

function updateProjectUI() {
  const badge = document.getElementById('project-badge')
  const pathDisplay = document.querySelector('#project-path-display .info-value')
  const fileCount = document.getElementById('file-count')
  const charCount = document.getElementById('char-count')
  const tokenEstimate = document.getElementById('token-estimate')

  if (currentProject) {
    badge.textContent = '已加载'
    pathDisplay.textContent = currentProject
  } else {
    badge.textContent = '未选择'
    pathDisplay.textContent = '点击选择项目...'
    fileCount.textContent = '0 文件'
    charCount.textContent = '0 字符'
    tokenEstimate.textContent = '~0 Token'
  }
}

function updateStatsUI() {
  document.getElementById('stat-today-requests').textContent = stats.todayRequests.toLocaleString()
  document.getElementById('stat-today-tokens').textContent = (stats.todayTokens / 1000).toFixed(1) + 'k'
  document.getElementById('stat-today-savings').textContent = currencySymbols[currentCurrency] + stats.todaySavings.toFixed(2)

  const totalReq = stats.todayRequests + stats.cacheHits
  const hitRate = totalReq > 0 ? Math.round((stats.cacheHits / totalReq) * 100) : 0
  document.getElementById('stat-cache-hit').textContent = hitRate + '%'
}

function updateContextHash() {
  fetch('http://127.0.0.1:12306/context/hash')
    .then(r => r.json())
    .then(data => {
      const hashDisplay = document.querySelector('.hash-value')
      if (data.hash) {
        hashDisplay.textContent = data.hash.substring(0, 8)
      } else {
        hashDisplay.textContent = '未设置'
      }
    })
    .catch(() => {
      document.querySelector('.hash-value').textContent = '未设置'
    })
}

async function updateMemoryUsage() {
  const mem = await fetch('http://127.0.0.1:12306/stats').catch(() => null)
  if (mem) {
    const data = await mem.json()
    const memMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    document.getElementById('memory-usage').textContent = `内存: ${memMB} MB`
  }
}

function setupEventListeners() {
  document.getElementById('btn-select-project').addEventListener('click', selectProject)
  document.getElementById('btn-build-context').addEventListener('click', buildContext)
  document.getElementById('btn-toggle-proxy').addEventListener('click', toggleProxy)
  document.getElementById('btn-start-proxy').addEventListener('click', startProxy)
  document.getElementById('btn-stop-proxy').addEventListener('click', stopProxy)
  document.getElementById('btn-quick-build').addEventListener('click', buildContext)
  document.getElementById('btn-clear-cache').addEventListener('click', clearCache)

  document.getElementById('btn-settings').addEventListener('click', openSettings)
  document.getElementById('btn-close-settings').addEventListener('click', closeSettings)
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings)
  document.getElementById('btn-cancel-settings').addEventListener('click', closeSettings)

  document.getElementById('btn-minimize').addEventListener('click', () => window.electronAPI.minimizeWindow())
  document.getElementById('btn-maximize').addEventListener('click', () => window.electronAPI.maximizeWindow())
  document.getElementById('btn-close').addEventListener('click', () => window.electronAPI.closeWindow())

  document.getElementById('btn-enable-transparent').addEventListener('click', async () => {
    try {
      const scriptPath = '../resources/transparent_proxy.sh'
      const result = await window.electronAPI.runScript(scriptPath, 'install')
      showToast(result.success ? '透明代理已启用' : result.error || '启用失败')
    } catch (e) {
      showToast('请手动运行: sudo ./resources/transparent_proxy.sh install')
    }
  })

  document.querySelectorAll('[data-config]').forEach(btn => {
    btn.addEventListener('click', (e) => copyToolConfig(e.target.dataset.config))
  })

  document.querySelectorAll('#card-log .filter-btn').forEach(btn => {
    btn.addEventListener('click', () => filterLogs(btn.dataset.filter))
  })

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab))
  })

  document.getElementById('settings-modal').addEventListener('click', (e) => {
    if (e.target.id === 'settings-modal') closeSettings()
  })
}

function filterLogs(filter) {
  document.querySelectorAll('#card-log .filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter)
  })

  const entries = document.querySelectorAll('#log-content .log-entry')
  entries.forEach(entry => {
    if (filter === 'all') {
      entry.style.display = ''
    } else if (filter === 'cache') {
      entry.style.display = entry.classList.contains('log-hit') ? '' : 'none'
    } else if (filter === 'miss') {
      entry.style.display = entry.classList.contains('log-miss') ? '' : 'none'
    }
  })
}

async function selectProject() {
  const folder = await window.electronAPI.selectFolder()
  if (folder) {
    currentProject = folder
    config.workspace = folder
    await window.electronAPI.saveConfig(config)
    updateProjectUI()
  }
}

async function buildContext() {
  if (!currentProject) {
    alert('请先选择项目')
    return
  }

  try {
    const result = await window.electronAPI.buildContext(currentProject)
    if (result.success) {
      document.getElementById('file-count').textContent = `${result.fileCount} 文件`
      document.getElementById('char-count').textContent = `${(result.totalChars / 1000).toFixed(1)}k 字符`
      document.getElementById('token-estimate').textContent = `~${(result.estimatedTokens / 1000).toFixed(1)}k Token`
      addLogEntry({ method: 'POST', path: '/build', model: '-', tokens: 0, cost: 0, cacheHit: true })
      updateContextHash()
    } else {
      alert('构建失败: ' + result.error)
    }
  } catch (e) {
    alert('构建失败: ' + e.message)
  }
}

async function toggleProxy() {
  if (proxyRunning) {
    await stopProxy()
  } else {
    await startProxy()
  }
}

async function startProxy() {
  const port = config.proxy?.port || 12306
  const result = await window.electronAPI.startProxy(port)

  if (result.success) {
    proxyRunning = true
    updateProxyUI()
    document.getElementById('connection-status').textContent = `运行中 :${result.port}`
  } else {
    alert('启动失败: ' + result.error)
  }
}

async function stopProxy() {
  const result = await window.electronAPI.stopProxy()
  if (result.success) {
    proxyRunning = false
    updateProxyUI()
    document.getElementById('connection-status').textContent = '已停止'
  }
}

async function clearCache() {
  try {
    await fetch('http://127.0.0.1:12306/cache', { method: 'DELETE' })
    addLogEntry({ method: 'DELETE', path: '/cache', model: '-', tokens: 0, cost: 0, cacheHit: true })
    alert('缓存已清空')
  } catch (e) {
    alert('清空失败: ' + e.message)
  }
}

function updateProxyUI() {
  const indicator = document.getElementById('proxy-status-indicator')
  const badge = document.getElementById('proxy-badge')
  const startBtn = document.getElementById('btn-start-proxy')
  const stopBtn = document.getElementById('btn-stop-proxy')
  const toggleBtn = document.getElementById('btn-toggle-proxy')

  if (proxyRunning) {
    indicator.classList.add('active')
    indicator.querySelector('.status-text').textContent = '运行中'
    badge.textContent = '运行中'
    badge.classList.add('active')
    startBtn.disabled = true
    stopBtn.disabled = false
    toggleBtn.querySelector('.action-text').textContent = '停止代理'
    toggleBtn.querySelector('.action-icon').textContent = '⬛'
  } else {
    indicator.classList.remove('active')
    indicator.querySelector('.status-text').textContent = '未启动'
    badge.textContent = '已停止'
    badge.classList.remove('active')
    startBtn.disabled = false
    stopBtn.disabled = true
    toggleBtn.querySelector('.action-text').textContent = '启动代理'
    toggleBtn.querySelector('.action-icon').textContent = '▶'
  }
}

async function checkProxyStatus() {
  try {
    const status = await window.electronAPI.proxyStatus()
    proxyRunning = status.running
    updateToolConfigs(status.port || 12306)
    updateProxyUI()
  } catch (e) {
    proxyRunning = false
    updateProxyUI()
  }
}

function updateToolConfigs(port) {
  const baseUrl = `http://127.0.0.1:${port}/v1`
  for (const tool of ['cursor', 'cline', 'continue', 'windsurf']) {
    if (toolConfigs[tool]) {
      toolConfigs[tool].config.baseUrl = baseUrl
    }
  }
}

function copyToolConfig(tool) {
  const toolData = toolConfigs[tool]
  if (!toolData) return

  const configStr = JSON.stringify(toolData.config, null, 2)
  navigator.clipboard.writeText(configStr).then(() => {
    showToast(`${toolData.name} 配置已复制到剪贴板`)
  })
}

function showToast(message) {
  const toast = document.createElement('div')
  toast.className = 'toast'
  toast.textContent = message
  document.body.appendChild(toast)
  setTimeout(() => toast.remove(), 3000)
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
  document.getElementById('proxy-port').value = proxyConfig.port || 12306
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
  if (fixedCurrency) config.currency.fixed_currency = fixedCurrency
  if (fixedRate) config.currency.fixed_rate = parseFloat(fixedRate)

  const success = await window.electronAPI.saveConfig(config)
  if (success) {
    closeSettings()
    alert('设置已保存')
  } else {
    alert('保存失败')
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

function setupProxyListeners() {
  window.electronAPI.onProxyLog((data) => {
    console.log('Proxy log:', data)
    addLogEntry({
      method: 'POST',
      path: '/v1/chat',
      model: data.model || 'gpt-4',
      tokens: data.tokens || 0,
      cost: data.cost || 0,
      cacheHit: data.cacheHit || false
    })
    stats.todayRequests++
    stats.todayTokens += data.tokens || 0
    stats.todaySavings += data.cost || 0
    if (data.cacheHit) stats.cacheHits++
    updateStatsUI()
  })

  window.electronAPI.onProxyStopped(() => {
    proxyRunning = false
    updateProxyUI()
  })
}

function addLogEntry(data) {
  const logContent = document.getElementById('log-content')
  const time = new Date().toLocaleTimeString()

  const entry = document.createElement('div')
  entry.className = `log-entry ${data.cacheHit ? 'log-hit' : 'log-miss'}`

  entry.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-method">${data.method}</span>
    <span class="log-path">${data.path}</span>
    <span class="log-model">${data.model}</span>
    <span class="log-tokens">${data.tokens}</span>
    <span class="log-cost">${currencySymbols[currentCurrency]}${data.cost.toFixed(4)}</span>
    <span class="${data.cacheHit ? 'log-hit' : 'log-miss'}">[${data.cacheHit ? 'HIT' : 'MISS'}]</span>
  `

  logContent.appendChild(entry)
  logContent.scrollTop = logContent.scrollHeight
}

init()