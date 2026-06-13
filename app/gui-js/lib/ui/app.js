const { toast } = require('./toast')

const DEFAULT_PROXY_PORT = 12306
const currencySymbols = { USD: '$', CNY: '￥', EUR: '€' }

let config = {}
let currentProject = null
let proxyRunning = false
let proxyPort = DEFAULT_PROXY_PORT
let currentCurrency = 'USD'
let stats = { todayRequests: 0, todayTokens: 0, todaySavings: 0, cacheHits: 0 }

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
  } catch {}
}

async function loadConfig() {
  try {
    config = await window.electronAPI.getConfig()
    if (config.workspace) { currentProject = config.workspace; updateProjectUI() }
    updateCurrencyFromConfig()
  } catch (e) { console.error('Failed to load config:', e) }
}

async function loadStats() {
  try {
    const s = await window.electronAPI.getStats()
    if (s) {
      stats = { todayRequests: s.today?.requests || 0, todayTokens: s.today?.tokens || 0, todaySavings: s.today?.cost || 0, cacheHits: s.total?.cacheHits || 0 }
      updateStatsUI()
    }
  } catch {}
}

function updateCurrencyFromConfig() {
  const cc = config.currency || {}
  if (cc.fixed_currency) { currentCurrency = cc.fixed_currency; return }
  for (const p of Object.values(config.providers || {})) {
    if ((p.base_url || '').includes('.cn')) { currentCurrency = 'CNY'; return }
  }
}

function updateProjectUI() {
  const badge = document.getElementById('project-badge')
  const pathDisplay = document.querySelector('#project-path-display .info-value')
  if (currentProject) { badge.textContent = '已加载'; pathDisplay.textContent = currentProject }
  else { badge.textContent = '未选择'; pathDisplay.textContent = '点击选择项目...' }
}

function updateStatsUI() {
  document.getElementById('stat-today-requests').textContent = stats.todayRequests.toLocaleString()
  document.getElementById('stat-today-tokens').textContent = (stats.todayTokens / 1000).toFixed(1) + 'k'
  document.getElementById('stat-today-savings').textContent = currencySymbols[currentCurrency] + stats.todaySavings.toFixed(2)
  const total = stats.todayRequests + stats.cacheHits
  document.getElementById('stat-cache-hit').textContent = (total > 0 ? Math.round((stats.cacheHits / total) * 100) : 0) + '%'
}

async function updateMemoryUsage() {
  try {
    const m = await window.electronAPI.getMemoryUsage()
    document.getElementById('memory-usage').textContent = `内存: ${m.heapUsed} MB`
  } catch {}
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
  document.querySelectorAll('#card-log .filter-btn').forEach(btn => btn.addEventListener('click', () => filterLogs(btn.dataset.filter)))
  document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)))
  document.getElementById('settings-modal').addEventListener('click', e => { if (e.target.id === 'settings-modal') closeSettings() })
  document.getElementById('btn-add-provider').addEventListener('click', addProvider)
  document.getElementById('btn-remove-provider').addEventListener('click', removeProvider)
  document.getElementById('btn-fetch-models').addEventListener('click', fetchModels)
}

function filterLogs(filter) {
  document.querySelectorAll('#card-log .filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === filter))
  document.querySelectorAll('#log-content .log-row').forEach(row => {
    if (filter === 'all') row.style.display = ''
    else if (filter === 'cache') row.style.display = row.classList.contains('log-row-cache') ? '' : 'none'
    else if (filter === 'miss') row.style.display = row.classList.contains('log-row-cache') ? 'none' : ''
    else if (filter === 'error') row.style.display = row.classList.contains('log-row-error') ? '' : 'none'
  })
}

async function selectProject() {
  const folder = await window.electronAPI.selectFolder()
  if (folder) { currentProject = folder; config.workspace = folder; await window.electronAPI.saveConfig(config); updateProjectUI() }
}

async function buildContext() {
  if (!currentProject) { toast('请先选择项目', 'warn'); return }
  try {
    const r = await window.electronAPI.buildContext(currentProject)
    if (r.success) {
      document.getElementById('file-count').textContent = `${r.fileCount} 文件`
      document.getElementById('char-count').textContent = `${(r.totalChars / 1000).toFixed(1)}k 字符`
      document.getElementById('token-estimate').textContent = `~${(r.estimatedTokens / 1000).toFixed(1)}k Token`
      addLogEntry({ type: 'response', method: 'BUILD', path: '/build', model: '-', provider: 'local', tokens: {}, cached: false, status: 200, responseTime: 0, messagePreview: '上下文构建完成: ' + r.fileCount + ' 文件' })
    } else toast('构建失败: ' + r.error, 'error')
  } catch (e) { toast('构建失败: ' + e.message, 'error') }
}

async function toggleProxy() { proxyRunning ? await stopProxy() : await startProxy() }

async function startProxy() {
  const port = config.proxy?.port || DEFAULT_PROXY_PORT
  const r = await window.electronAPI.startProxy(port)
  if (r.success) { proxyRunning = true; proxyPort = r.port; updateProxyUI(); document.getElementById('connection-status').textContent = `运行中 :${r.port}` }
  else toast('启动失败: ' + r.error, 'error')
}

async function stopProxy() {
  const r = await window.electronAPI.stopProxy()
  if (r.success) { proxyRunning = false; updateProxyUI(); document.getElementById('connection-status').textContent = '已停止' }
}

async function clearCache() {
  try { await fetch(`http://127.0.0.1:${proxyPort}/cache`, { method: 'DELETE' }); toast('缓存已清空', 'success') }
  catch (e) { toast('清空失败: ' + e.message, 'error') }
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
    badge.textContent = '运行中'; badge.classList.add('active')
    startBtn.disabled = true; stopBtn.disabled = false
    toggleBtn.querySelector('.action-text').textContent = '停止代理'
    toggleBtn.querySelector('.action-icon').textContent = '⬛'
  } else {
    indicator.classList.remove('active')
    indicator.querySelector('.status-text').textContent = '未启动'
    badge.textContent = '已停止'; badge.classList.remove('active')
    startBtn.disabled = false; stopBtn.disabled = true
    toggleBtn.querySelector('.action-text').textContent = '启动代理'
    toggleBtn.querySelector('.action-icon').textContent = '▶'
  }
  document.getElementById('sidebar-port').textContent = proxyPort || DEFAULT_PROXY_PORT
  document.getElementById('proxy-address').textContent = `http://127.0.0.1:${proxyPort || DEFAULT_PROXY_PORT}`
}

async function checkProxyStatus() {
  try {
    const s = await window.electronAPI.proxyStatus()
    proxyRunning = s.running; proxyPort = s.port || DEFAULT_PROXY_PORT
    updateProxyUI()
  } catch { proxyRunning = false; updateProxyUI() }
}

function addProvider() {
  const name = prompt('输入提供商名称 (例如: openai, anthropic, deepseek):')
  if (!name?.trim()) return
  const trimmed = name.trim()
  if (!config.providers) config.providers = {}
  if (!config.providers[trimmed]) config.providers[trimmed] = { api_key: '', base_url: '', models: [] }
  populateProviderSelect()
  document.getElementById('provider-select').value = trimmed
  selectProvider()
}

function removeProvider() {
  const name = document.getElementById('provider-select').value
  if (!name || !confirm(`确认删除提供商 "${name}"?`)) return
  delete config.providers[name]
  populateProviderSelect()
}

function populateProviderSelect() {
  const sel = document.getElementById('provider-select')
  sel.innerHTML = ''
  for (const name of Object.keys(config.providers || {})) {
    const opt = document.createElement('option'); opt.value = name; opt.textContent = name; sel.appendChild(opt)
  }
  sel.onchange = () => selectProvider()
  const defSel = document.getElementById('default-provider')
  defSel.innerHTML = ''
  for (const name of Object.keys(config.providers || {})) {
    const opt = document.createElement('option'); opt.value = name; opt.textContent = name; defSel.appendChild(opt)
  }
  if (config.default_provider) defSel.value = config.default_provider
}

function selectProvider() {
  const name = document.getElementById('provider-select').value
  if (!name) return
  const p = (config.providers || {})[name]
  if (!p) return
  document.getElementById('provider-api-key').value = p.api_key || ''
  document.getElementById('provider-base-url').value = p.base_url || ''
}

async function fetchModels() {
  const baseUrl = document.getElementById('provider-base-url').value.trim()
  const apiKey = document.getElementById('provider-api-key').value.trim()
  if (!baseUrl) { toast('请先填写基础 URL', 'warn'); return }
  if (!apiKey) { toast('请先填写 API 密钥', 'warn'); return }
  const btn = document.getElementById('btn-fetch-models')
  btn.disabled = true; btn.textContent = '⏳ 获取中...'
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/models', { headers: { 'Authorization': `Bearer ${apiKey}` } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    const models = (json.data || []).map(m => m.id || m.model || m.name).filter(Boolean)
    if (models.length === 0) { toast('未返回模型列表', 'warn'); btn.disabled = false; btn.textContent = '⬇ 获取模型列表'; return }
    const container = document.getElementById('provider-models-checkboxes')
    container.innerHTML = ''
    for (const m of models) {
      const label = document.createElement('label')
      label.className = 'model-chip'
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = m
      label.appendChild(cb)
      const span = document.createElement('span'); span.className = 'model-chip-name'; span.textContent = m; label.appendChild(span)
      container.appendChild(label)
    }
    document.getElementById('models-count').textContent = `共 ${models.length} 个模型`
    btn.textContent = `✓ 已获取 ${models.length} 个模型`
    setTimeout(() => { btn.textContent = '⬇ 获取模型列表'; btn.disabled = false }, 2000)
  } catch (e) { btn.disabled = false; btn.textContent = '⬇ 获取模型列表'; toast('获取失败: ' + e.message, 'error') }
}

function openSettings() { loadConfigToSettings(); document.getElementById('settings-modal').classList.remove('hidden') }
function closeSettings() { document.getElementById('settings-modal').classList.add('hidden') }

function loadConfigToSettings() {
  const pc = config.proxy || {}
  document.getElementById('proxy-host').value = pc.host || '127.0.0.1'
  document.getElementById('proxy-port').value = pc.port || DEFAULT_PROXY_PORT
  document.getElementById('proxy-sanitize').checked = pc.sanitize_requests !== false
  populateProviderSelect()
  const mc = config.monitor || {}
  document.getElementById('budget-limit').value = mc.budget_limit || 10
  document.getElementById('warning-threshold').value = mc.warning_threshold || 75
  document.getElementById('critical-threshold').value = mc.critical_threshold || 90
  document.getElementById('db-path').value = mc.db_path || 'contextgate.db'
  const sc = config.scanner || {}
  document.getElementById('max-file-size').value = sc.max_file_size || 1048576
  document.getElementById('include-extensions').value = (sc.include_extensions || []).join('\n')
  const cc = config.context || {}
  document.getElementById('output-file').value = cc.output_file || 'full_context.txt'
  document.getElementById('context-max-tokens').value = cc.max_tokens || 8000
  document.getElementById('watch-enabled').checked = cc.watch_enabled !== false
  document.getElementById('debounce-seconds').value = cc.debounce_seconds || 1
  const cur = config.currency || {}
  document.getElementById('fixed-currency').value = cur.fixed_currency || ''
  document.getElementById('fixed-rate').value = cur.fixed_rate || ''
  const rates = cur.default_rates || {}
  document.getElementById('cny-rate').value = rates.CNY || 7.2
  document.getElementById('eur-rate').value = rates.EUR || 0.92
}

async function saveSettings() {
  config.proxy = { host: document.getElementById('proxy-host').value, port: parseInt(document.getElementById('proxy-port').value), sanitize_requests: document.getElementById('proxy-sanitize').checked }
  config.default_provider = document.getElementById('default-provider').value
  config.monitor = { budget_limit: parseFloat(document.getElementById('budget-limit').value), warning_threshold: parseInt(document.getElementById('warning-threshold').value), critical_threshold: parseInt(document.getElementById('critical-threshold').value), db_path: document.getElementById('db-path').value }
  config.scanner = { max_file_size: parseInt(document.getElementById('max-file-size').value), include_extensions: document.getElementById('include-extensions').value.split('\n').filter(e => e.trim()) }
  config.context = { output_file: document.getElementById('output-file').value, max_tokens: parseInt(document.getElementById('context-max-tokens').value) || 8000, watch_enabled: document.getElementById('watch-enabled').checked, debounce_seconds: parseFloat(document.getElementById('debounce-seconds').value) }
  const fc = document.getElementById('fixed-currency').value
  const fr = document.getElementById('fixed-rate').value
  config.currency = { default_rates: { CNY: parseFloat(document.getElementById('cny-rate').value), EUR: parseFloat(document.getElementById('eur-rate').value) } }
  if (fc) config.currency.fixed_currency = fc
  if (fr) config.currency.fixed_rate = parseFloat(fr)
  saveCurrentProvider()
  const ok = await window.electronAPI.saveConfig(config)
  if (ok) { closeSettings(); toast('设置已保存', 'success') } else toast('保存失败', 'error')
}

function saveCurrentProvider() {
  const name = document.getElementById('provider-select').value
  if (!name || !config.providers) return
  const checked = []
  document.querySelectorAll('#provider-models-checkboxes input[type=checkbox]:checked').forEach(cb => checked.push(cb.value))
  config.providers[name] = { ...config.providers[name], api_key: document.getElementById('provider-api-key').value, base_url: document.getElementById('provider-base-url').value, models: checked }
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId))
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === `tab-${tabId}`))
}

function setupProxyListeners() {
  window.electronAPI.onProxyLog(data => {
    if (data?.type) {
      addLogEntry(data)
      if (data.type === 'response' || data.type === 'stream') {
        stats.todayRequests++; stats.todayTokens += (data.tokens?.total || 0)
        if (data.cached) { stats.todaySavings += 0.002 * (data.tokens?.total || 0); stats.cacheHits++ }
        updateStatsUI()
      }
    }
  })
  window.electronAPI.onProxyStopped(() => { proxyRunning = false; updateProxyUI() })
}

function addLogEntry(data) {
  const logContent = document.getElementById('log-content')
  if (!logContent) return
  const isError = data.type === 'error', isCache = data.cached === true, isStream = data.type === 'stream'
  const t = data.tokens || {}
  const currency = currencySymbols[currentCurrency]
  const cost = data.cost != null ? data.cost : (t.total ? (t.total * 0.000002).toFixed(6) : 0)
  const row = document.createElement('div')
  row.className = 'log-row' + (isError ? ' log-row-error' : '') + (isCache ? ' log-row-cache' : '') + (isStream ? ' log-row-stream' : '')
  const modelShort = (data.model || '').length > 26 ? (data.model || '').substring(0, 24) + '…' : (data.model || '-')
  row.innerHTML =
    '<div class="log-row-main"><span class="log-tag ' + (isError ? 'log-tag-err' : isCache ? 'log-tag-cache' : isStream ? 'log-tag-stream' : 'log-tag-ok') + '">' + (isError ? 'ERR' : isCache ? 'CACHE' : isStream ? 'STREAM' : 'OK') + '</span><span class="log-row-model">' + modelShort + '</span><span class="log-row-tokens">' + (t.prompt || 0) + '↑ ' + (t.completion || 0) + '↓ ' + (t.total || 0) + '∑</span><span class="log-row-time">' + (data.responseTime || 0) + 'ms</span><span class="log-row-cost">' + currency + cost + '</span></div><div class="log-row-detail"><span class="log-row-path">' + (data.method || '') + ' ' + (data.path || '') + '</span><span class="log-row-url">→ ' + (data.backendUrl || '') + '</span></div>' + (data.messagePreview ? '<div class="log-row-preview">' + data.messagePreview + '</div>' : '') + (isError ? '<div class="log-row-errmsg">' + (data.error || '') + '</div>' : '')
  logContent.appendChild(row)
  logContent.scrollTop = logContent.scrollHeight
}

init()
