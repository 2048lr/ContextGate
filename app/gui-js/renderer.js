const DEFAULT_PROXY_PORT = 12306

let config = {}
let currentProject = null
let proxyRunning = false
let proxyPort = DEFAULT_PROXY_PORT
let stats = {
  todayRequests: 0,
  todayTokens: 0,
  todaySavings: 0,
  cacheHits: 0
}
let currentCurrency = 'USD'

const currencySymbols = { USD: '$', CNY: '￥', EUR: '€' }

function toast(msg, type) {
  type = type || 'info'
  const container = document.getElementById('toast-container')
  if (!container) return
  const el = document.createElement('div')
  el.className = 'toast toast-' + type
  el.textContent = msg
  container.appendChild(el)
  requestAnimationFrame(() => el.classList.add('show'))
  setTimeout(() => {
    el.classList.remove('show')
    el.addEventListener('transitionend', () => el.remove())
  }, 3000)
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
  fetch(`http://127.0.0.1:${proxyPort}/context/hash`)
    .then(r => r.json())
    .then(data => {
      const hashDisplay = document.querySelector('.hash-value')
      if (data.hash) {
        hashDisplay.textContent = data.hash.substring(0, 8)
      } else {
        hashDisplay.textContent = '未设置'
      }
    })
    .catch((err) => {
      console.error('Failed to update context hash:', err)
      document.querySelector('.hash-value').textContent = '未设置'
    })
}

async function updateMemoryUsage() {
  try {
    const memData = await window.electronAPI.getMemoryUsage()
    document.getElementById('memory-usage').textContent = `内存: ${memData.heapUsed} MB`
  } catch (e) {
    console.error('Failed to get memory usage:', e)
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

  document.getElementById('btn-add-provider').addEventListener('click', addProvider)
  document.getElementById('btn-remove-provider').addEventListener('click', removeProvider)
  document.getElementById('btn-fetch-models').addEventListener('click', fetchModels)
  document.getElementById('btn-select-all').addEventListener('click', () => {
    document.querySelectorAll('#provider-models-checkboxes input[type=checkbox]').forEach(cb => { cb.checked = true; cb.dispatchEvent(new Event('change')) })
  })
  document.getElementById('btn-deselect-all').addEventListener('click', () => {
    document.querySelectorAll('#provider-models-checkboxes input[type=checkbox]').forEach(cb => { cb.checked = false; cb.dispatchEvent(new Event('change')) })
  })

  document.getElementById('btn-minimize').addEventListener('click', () => window.electronAPI.minimizeWindow())
  document.getElementById('btn-maximize').addEventListener('click', () => window.electronAPI.maximizeWindow())
  document.getElementById('btn-close').addEventListener('click', () => window.electronAPI.closeWindow())

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

  const rows = document.querySelectorAll('#log-content .log-row')
  rows.forEach(row => {
    if (filter === 'all') {
      row.style.display = ''
    } else if (filter === 'cache') {
      row.style.display = row.classList.contains('log-row-cache') ? '' : 'none'
    } else if (filter === 'miss') {
      row.style.display = row.classList.contains('log-row-cache') ? 'none' : ''
    } else if (filter === 'error') {
      row.style.display = row.classList.contains('log-row-error') ? '' : 'none'
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
    toast('请先选择项目', 'warn')
    return
  }

  try {
    const result = await window.electronAPI.buildContext(currentProject)
    if (result.success) {
      document.getElementById('file-count').textContent = `${result.fileCount} 文件`
      document.getElementById('char-count').textContent = `${(result.totalChars / 1000).toFixed(1)}k 字符`
      document.getElementById('token-estimate').textContent = `~${(result.estimatedTokens / 1000).toFixed(1)}k Token`
      addLogEntry({ type: 'response', method: 'BUILD', path: '/build', model: '-', provider: 'local', tokens: {}, cached: false, status: 200, responseTime: 0, messagePreview: '上下文构建完成: ' + result.fileCount + ' 文件' })
      updateContextHash()
    } else {
      toast('构建失败: ' + result.error, 'error')
    }
  } catch (e) {
    toast('构建失败: ' + e.message, 'error')
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
  const port = config.proxy?.port || DEFAULT_PROXY_PORT
  const result = await window.electronAPI.startProxy(port)

  if (result.success) {
    proxyRunning = true
    proxyPort = result.port
    updateProxyUI()
    document.getElementById('connection-status').textContent = `运行中 :${result.port}`
  } else {
    toast('启动失败: ' + result.error, 'error')
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
    await fetch(`http://127.0.0.1:${proxyPort}/cache`, { method: 'DELETE' })
    addLogEntry({ type: 'response', method: 'DELETE', path: '/cache', model: '-', provider: 'local', tokens: {}, cached: true, status: 200, responseTime: 0, messagePreview: '缓存已清空' })
    toast('缓存已清空', 'success')
  } catch (e) {
    toast('清空失败: ' + e.message, 'error')
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

  const sidebarPort = document.getElementById('sidebar-port')
  if (sidebarPort) sidebarPort.textContent = proxyPort || DEFAULT_PROXY_PORT
  const proxyAddress = document.getElementById('proxy-address')
  if (proxyAddress) proxyAddress.textContent = `http://127.0.0.1:${proxyPort || DEFAULT_PROXY_PORT}`
}

async function checkProxyStatus() {
  try {
    const status = await window.electronAPI.proxyStatus()
    proxyRunning = status.running
    proxyPort = status.port || DEFAULT_PROXY_PORT
    updateProxyUI()
  } catch (e) {
    console.error('Failed to check proxy status:', e)
    proxyRunning = false
    updateProxyUI()
  }
}

function populateProviderSelect() {
  const select = document.getElementById('provider-select')
  if (!select) return
  select.onchange = null
  const currentValue = select.value
  select.innerHTML = ''
  const providers = config.providers || {}
  for (const name of Object.keys(providers)) {
    const option = document.createElement('option')
    option.value = name
    option.textContent = name
    select.appendChild(option)
  }
  if (select.options.length > 0) {
    if (Array.from(select.options).some(o => o.value === currentValue)) {
      select.value = currentValue
    } else {
      select.selectedIndex = 0
    }
  } else {
    document.getElementById('provider-api-key').value = ''
    document.getElementById('provider-base-url').value = ''
    _renderModelCheckboxes([])
    _currentProviderName = null
  }
  _populateDefaultProviderSelect()
  select.onchange = () => {
    selectProvider()
  }
}

function _populateDefaultProviderSelect() {
  const sel = document.getElementById('default-provider')
  if (!sel) return
  const currentVal = sel.value || config.default_provider || ''
  sel.innerHTML = ''
  const providers = config.providers || {}
  for (const name of Object.keys(providers)) {
    const opt = document.createElement('option')
    opt.value = name
    opt.textContent = name
    sel.appendChild(opt)
  }
  if (Array.from(sel.options).some(o => o.value === currentVal)) {
    sel.value = currentVal
  } else if (sel.options.length > 0) {
    sel.selectedIndex = 0
  }
}

function _renderModelCheckboxes(models) {
  const container = document.getElementById('provider-models-checkboxes')
  if (!container) return
  const currentProvider = config.providers && config.providers[document.getElementById('provider-select').value]
  const selectedModels = currentProvider ? (currentProvider.models || []) : []

  container.innerHTML = ''
  if (models.length === 0) {
    container.innerHTML = '<div class="models-empty-hint">点击"获取模型列表"获取</div>'
    return
  }

  const groups = _groupModels(models)
  const searchInput = document.getElementById('models-search-input')
  const countEl = document.getElementById('models-count')
  if (countEl) countEl.textContent = `共 ${models.length} 个模型`

  const renderFiltered = (filterText) => {
    const f = (filterText || '').toLowerCase()
    container.innerHTML = ''
    let visibleCount = 0

    for (const { group, items } of groups) {
      const filtered = f ? items.filter(m => m.toLowerCase().includes(f)) : items
      if (filtered.length === 0) continue
      visibleCount += filtered.length

      const groupHeader = document.createElement('div')
      groupHeader.className = 'model-group-header'
      const badge = document.createElement('span')
      badge.className = 'model-group-badge'
      badge.textContent = group
      groupHeader.appendChild(badge)
      groupHeader.appendChild(document.createTextNode(` (${filtered.length})`))
      container.appendChild(groupHeader)

      const grid = document.createElement('div')
      grid.className = 'model-grid'

      for (const modelId of filtered) {
        const isSelected = selectedModels.includes(modelId)
        const chip = document.createElement('label')
        chip.className = 'model-chip' + (isSelected ? ' selected' : '')
        chip.title = modelId

        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.value = modelId
        cb.checked = isSelected
        cb.addEventListener('change', () => {
          chip.classList.toggle('selected', cb.checked)
          _saveProviderFieldsToConfig(document.getElementById('provider-select').value)
        })
        chip.appendChild(cb)

        const nameSpan = document.createElement('span')
        nameSpan.className = 'model-chip-name'
        nameSpan.textContent = modelId
        chip.appendChild(nameSpan)

        grid.appendChild(chip)
      }
      container.appendChild(grid)
    }

    if (countEl) countEl.textContent = `共 ${models.length} 个模型` + (f ? ` · 匹配 ${visibleCount}` : '')
  }

  renderFiltered('')
  _currentModelFilterFn = renderFiltered
  if (searchInput) {
    searchInput.oninput = () => renderFiltered(searchInput.value)
    searchInput.value = ''
  }
}

function _groupModels(models) {
  const patterns = {
    'GPT': /^(gpt-|o1|o3|o4)/i,
    'Claude': /^claude/i,
    'Gemini': /^gemini/i,
    'Grok': /^grok/i,
    'Qwen': /^qwen/i,
    'DeepSeek': /^deepseek/i,
    'GLM': /^glm/i,
    'Llama': /^llama/i,
    'Gemma': /^gemma/i,
    'Mistral': /^mistral/i,
    'Kimi': /^kimi/i,
    'ERNIE': /^ERNIE/i,
    'SparkDesk': /^SparkDesk/i,
    'Minimax': /^minimax/i,
    'DALL-E': /^dall-e/i,
    'Whisper': /^whisper/i,
    'Embedding': /^(text-embedding|Embedding|babbage|davinci)/i,
    'TTS': /^(tts|speech)/i,
    'Flux': /^flux/i,
    'Kling': /^kling/i,
    'Wan': /^wan/i,
    'Veo': /^veo/i,
    'Sora': /^sora/i,
    'HappyHorse': /^happyhorse/i,
    'Mimo': /^mimo/i,
    'Vidu': /^vidu/i,
    'Doubao': /^doubao/i,
    'MJ': /^mj_/i,
    'Audio': /^(audio|gpt-audio)/i,
    'Pro/Rerank': /^Pro\//i
  }

  const grouped = {}
  const unmatched = []

  for (const m of models) {
    let matched = false
    for (const [label, re] of Object.entries(patterns)) {
      if (re.test(m)) {
        if (!grouped[label]) grouped[label] = []
        grouped[label].push(m)
        matched = true
        break
      }
    }
    if (!matched) unmatched.push(m)
  }

  const result = []
  for (const [label, items] of Object.entries(grouped)) {
    result.push({ group: label, items })
  }
  if (unmatched.length > 0) {
    result.push({ group: '其他', items: unmatched })
  }
  return result
}

let _currentProviderName = null
let _fetchedModelsMap = {}
let _currentModelFilterFn = null

function selectProvider() {
  if (_currentProviderName) {
    _saveProviderFieldsToConfig(_currentProviderName)
  }
  const select = document.getElementById('provider-select')
  if (!select) return
  const name = select.value
  if (!name) return
  _currentProviderName = name
  const providers = config.providers || {}
  const provider = providers[name]
  if (!provider) return
  document.getElementById('provider-api-key').value = provider.api_key || ''
  document.getElementById('provider-base-url').value = provider.base_url || ''
  _renderModelCheckboxes(_fetchedModelsMap[name] || [])
}

function _saveProviderFieldsToConfig(providerName) {
  if (!config.providers) config.providers = {}
  const existing = config.providers[providerName] || {}
  const checkedModels = []
  const container = document.getElementById('provider-models-checkboxes')
  if (container) {
    const cbs = container.querySelectorAll('input[type=checkbox]:checked')
    for (const cb of cbs) { checkedModels.push(cb.value) }
  }
  config.providers[providerName] = {
    ...existing,
    api_key: document.getElementById('provider-api-key').value,
    base_url: document.getElementById('provider-base-url').value,
    models: checkedModels
  }
}

async function fetchModels() {
  const baseUrl = document.getElementById('provider-base-url').value.trim()
  const apiKey = document.getElementById('provider-api-key').value.trim()
  const btn = document.getElementById('btn-fetch-models')
  const providerName = document.getElementById('provider-select').value

  if (!baseUrl) {
    toast('请先填写基础 URL', 'warn')
    return
  }
  if (!apiKey) {
    toast('请先填写 API 密钥', 'warn')
    return
  }

  btn.disabled = true
  btn.textContent = '⏳ 获取中...'

  try {
    const url = baseUrl.replace(/\/+$/, '') + '/models'
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    })
    if (!res.ok) {
      const errText = await res.text().catch((e) => { console.error('Failed to read error response text:', e); return '' })
      throw new Error(`HTTP ${res.status}: ${errText.substring(0, 200)}`)
    }
    const json = await res.json()
    const modelsRaw = (json.data || [])
    const models = modelsRaw
      .map(m => m.id || m.model || m.name)
      .filter(id => id && typeof id === 'string')
    const modelDetails = modelsRaw
      .map(m => ({
        id: m.id || m.model || m.name,
        contextWindow: m.context_window || m.maxTokens || m.max_input_tokens || m.max_tokens || 0
      }))
      .filter(m => m.id)

    if (models.length === 0) {
      toast('该提供商未返回模型列表', 'warn')
      btn.disabled = false
      btn.textContent = '⬇ 获取模型列表'
      return
    }

    _fetchedModelsMap[providerName] = models
    _saveProviderFieldsToConfig(providerName)
    _renderModelCheckboxes(models)

    const maxContextWindow = Math.max(...modelDetails.map(m => m.contextWindow), 0)
    if (maxContextWindow > 0) {
      const ctInput = document.getElementById('context-max-tokens')
      if (ctInput) {
        ctInput.value = Math.min(maxContextWindow, 200000)
      }
    }

    btn.textContent = `✓ 已获取 ${models.length} 个模型`
    setTimeout(() => { btn.textContent = '⬇ 获取模型列表'; btn.disabled = false }, 2000)
  } catch (e) {
    btn.disabled = false
    btn.textContent = '⬇ 获取模型列表'
    toast('获取模型列表失败: ' + e.message, 'error')
  }
}

function saveCurrentProvider() {
  if (_currentProviderName) _saveProviderFieldsToConfig(_currentProviderName)
}

function addProvider() {
  saveCurrentProvider()
  const name = prompt('输入提供商名称 (例如: openai, zhipu):')
  if (!name || !name.trim()) return
  const trimmed = name.trim()
  if (!config.providers) config.providers = {}
  config.providers[trimmed] = config.providers[trimmed] || { api_key: '', base_url: '', models: [] }
  populateProviderSelect()
  document.getElementById('provider-select').value = trimmed
  selectProvider()
}

function removeProvider() {
  const select = document.getElementById('provider-select')
  const name = select.value
  if (!name) return
  if (!confirm(`确认删除提供商 "${name}"?`)) return
  if (!config.providers) return
  delete config.providers[name]
  delete _fetchedModelsMap[name]
  _currentProviderName = null
  populateProviderSelect()
  if (select.options.length > 0) selectProvider()
}

function saveConfigProviders() {
  saveCurrentProvider()
  if (!config.providers) config.providers = {}
}

function openSettings() {
  loadConfigToSettings()
  document.getElementById('settings-modal').classList.remove('hidden')
}

function closeSettings() {
  document.getElementById('settings-modal').classList.add('hidden')
}

function loadConfigToSettings() {
  _currentProviderName = null
  const proxyConfig = config.proxy || {}
  document.getElementById('proxy-host').value = proxyConfig.host || '127.0.0.1'
  document.getElementById('proxy-port').value = proxyConfig.port || DEFAULT_PROXY_PORT
  document.getElementById('proxy-sanitize').checked = proxyConfig.sanitize_requests !== false

  populateProviderSelect()
  const providerSelect = document.getElementById('provider-select')
  if (providerSelect && providerSelect.options.length > 0) selectProvider()

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
  document.getElementById('context-max-tokens').value = contextConfig.max_tokens || 8000
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
    max_tokens: parseInt(document.getElementById('context-max-tokens').value) || 8000,
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

  saveConfigProviders()

  const success = await window.electronAPI.saveConfig(config)
  if (success) {
    closeSettings()
    toast('设置已保存', 'success')
  } else {
    toast('保存失败', 'error')
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
    if (data && data.type) {
      addLogEntry(data)
      if (data.type === 'response' || data.type === 'stream') {
        const tokens = data.tokens || {}
        stats.todayRequests++
        stats.todayTokens += tokens.total || 0
        if (data.cached) {
          stats.todaySavings += 0.002 * (tokens.total || 0)
          stats.cacheHits++
        }
        updateStatsUI()
      }
    }
  })

  window.electronAPI.onProxyStopped(() => {
    proxyRunning = false
    updateProxyUI()
  })
}

function addLogEntry(data) {
  const logContent = document.getElementById('log-content')
  if (!logContent) return

  const time = new Date().toLocaleTimeString()
  const isError = data.type === 'error'
  const isStream = data.type === 'stream'
  const isCache = data.cached === true
  const t = data.tokens || {}
  const currency = currencySymbols[currentCurrency]
  const cost = data.cost != null ? data.cost : (t.total ? (t.total * 0.000002).toFixed(6) : 0)

  const row = document.createElement('div')
  row.className = 'log-row' + (isError ? ' log-row-error' : '') + (isCache ? ' log-row-cache' : '') + (isStream ? ' log-row-stream' : '')

  const modelShort = (data.model || '').length > 26 ? (data.model || '').substring(0, 24) + '…' : (data.model || '-')
  const previewText = data.messagePreview || ''

  row.innerHTML =
    '<div class="log-row-main">' +
      '<span class="log-tag ' + (isError ? 'log-tag-err' : isCache ? 'log-tag-cache' : isStream ? 'log-tag-stream' : 'log-tag-ok') + '">' + (isError ? 'ERR' : isCache ? 'CACHE' : isStream ? 'STREAM' : 'OK') + '</span>' +
      '<span class="log-row-model" title="' + (data.model || '') + '">' + modelShort + '</span>' +
      '<span class="log-row-tokens">' + (t.prompt || 0) + '↑ ' + (t.completion || 0) + '↓ ' + (t.total || 0) + '∑</span>' +
      '<span class="log-row-time">' + (data.responseTime || 0) + 'ms</span>' +
      '<span class="log-row-provider">' + (data.provider || '') + '</span>' +
      '<span class="log-row-cost">' + currency + cost + '</span>' +
    '</div>' +
    '<div class="log-row-detail">' +
      '<span class="log-row-path">' + (data.method || '') + ' ' + (data.path || '') + '</span>' +
      '<span class="log-row-url">→ ' + (data.backendUrl || '') + '</span>' +
      '<span class="log-row-size">' + (data.requestSize ? (data.requestSize / 1024).toFixed(1) + 'KB' : '') + '</span>' +
      '<span class="log-row-status">' + (data.status || '') + '</span>' +
    '</div>' +
    (previewText ? '<div class="log-row-preview" title="' + previewText + '">' + previewText + '</div>' : '') +
    (isError ? '<div class="log-row-errmsg">' + (data.error || '') + '</div>' : '')

  logContent.appendChild(row)
  logContent.scrollTop = logContent.scrollHeight
}

init()