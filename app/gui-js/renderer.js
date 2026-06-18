const DEFAULT_PROXY_PORT = 12306
const currencySymbols = { USD: '$', CNY: '￥', EUR: '€' }

let config = {}, currentProject = null, proxyRunning = false, proxyPort = DEFAULT_PROXY_PORT
let currentCurrency = 'USD'
let stats = { todayRequests: 0, todayTokens: 0, todaySavings: 0, cacheHits: 0 }

function toast(msg, type = 'info') {
  const c = document.getElementById('toast-container'); if (!c) return
  const el = document.createElement('div'); el.className = `toast toast-${type}`; el.textContent = msg; c.appendChild(el)
  requestAnimationFrame(() => el.classList.add('show'))
  setTimeout(() => { el.classList.remove('show'); el.addEventListener('transitionend', () => el.remove()) }, 3000)
}

async function init() {
  try { const url = await window.electronAPI.getBackgroundUrl(); document.getElementById('background-container').style.backgroundImage = `url('${url}')` } catch {}
  try { config = await window.electronAPI.getConfig(); if (config.workspace) { currentProject = config.workspace; updateProjectUI() }; updateCurrency() } catch {}
  await loadStats()
  setupEventListeners(); setupProxyListeners(); await checkProxyStatus(); updateMemoryUsage(); setInterval(updateMemoryUsage, 5000)
}

function updateCurrency() {
  if (config.currency?.fixed_currency) { currentCurrency = config.currency.fixed_currency; return }
  for (const p of Object.values(config.providers || {})) { if ((p.base_url || '').includes('.cn')) { currentCurrency = 'CNY'; return } }
}

async function loadStats() {
  try {
    const s = await window.electronAPI.getStats()
    if (s) { stats = { todayRequests: s.today?.requests || 0, todayTokens: s.today?.tokens || 0, todaySavings: s.today?.cost || 0, cacheHits: s.total?.cacheHits || 0 }; updateStatsUI() }
  } catch {}
}

function updateProjectUI() {
  const badge = document.getElementById('project-badge'), pv = document.querySelector('#project-path-display .info-value')
  if (currentProject) { badge.textContent = '已加载'; pv.textContent = currentProject }
  else { badge.textContent = '未选择'; pv.textContent = '点击选择项目...' }
}

function updateStatsUI() {
  document.getElementById('stat-today-requests').textContent = stats.todayRequests.toLocaleString()
  document.getElementById('stat-today-tokens').textContent = (stats.todayTokens / 1000).toFixed(1) + 'k'
  document.getElementById('stat-today-savings').textContent = currencySymbols[currentCurrency] + stats.todaySavings.toFixed(2)
  const t = stats.todayRequests + stats.cacheHits
  document.getElementById('stat-cache-hit').textContent = (t > 0 ? Math.round((stats.cacheHits / t) * 100) : 0) + '%'
}

async function updateMemoryUsage() { try { const m = await window.electronAPI.getMemoryUsage(); document.getElementById('memory-usage').textContent = `内存: ${m.heapUsed} MB` } catch {} }

function setupEventListeners() {
  document.getElementById('btn-select-project').onclick = selectProject
  document.getElementById('btn-build-context').onclick = buildContext
  document.getElementById('btn-toggle-proxy').onclick = toggleProxy
  document.getElementById('btn-start-proxy').onclick = startProxy
  document.getElementById('btn-stop-proxy').onclick = stopProxy
  document.getElementById('btn-quick-build').onclick = buildContext
  document.getElementById('btn-clear-cache').onclick = clearCache
  document.getElementById('btn-settings').onclick = openSettings
  document.getElementById('btn-close-settings').onclick = closeSettings
  document.getElementById('btn-save-settings').onclick = saveSettings
  document.getElementById('btn-cancel-settings').onclick = closeSettings
  document.getElementById('btn-minimize').onclick = () => window.electronAPI.minimizeWindow()
  document.getElementById('btn-maximize').onclick = () => window.electronAPI.maximizeWindow()
  document.getElementById('btn-close').onclick = () => window.electronAPI.closeWindow()
  document.querySelectorAll('#card-log .filter-btn').forEach(b => b.onclick = () => filterLogs(b.dataset.filter))
  document.querySelectorAll('.tab-btn').forEach(b => b.onclick = () => switchTab(b.dataset.tab))
  document.getElementById('settings-modal').onclick = e => { if (e.target.id === 'settings-modal') closeSettings() }
  document.getElementById('btn-add-provider').onclick = addProvider
  document.getElementById('btn-remove-provider').onclick = removeProvider
  document.getElementById('btn-fetch-models').onclick = fetchModels
}

function filterLogs(f) {
  document.querySelectorAll('#card-log .filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === f))
  document.querySelectorAll('#log-content .log-row').forEach(r => {
    r.style.display = f === 'all' ? '' : f === 'cache' ? (r.classList.contains('log-row-cache') ? '' : 'none') : f === 'miss' ? (r.classList.contains('log-row-cache') ? 'none' : '') : (r.classList.contains('log-row-error') ? '' : 'none')
  })
}

async function selectProject() { const f = await window.electronAPI.selectFolder(); if (f) { currentProject = f; config.workspace = f; await window.electronAPI.saveConfig(config); updateProjectUI() } }

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
  const r = await window.electronAPI.startProxy(config.proxy?.port || DEFAULT_PROXY_PORT)
  if (r.success) { proxyRunning = true; proxyPort = r.port; updateProxyUI(); document.getElementById('connection-status').textContent = `运行中 :${r.port}` }
  else toast('启动失败: ' + r.error, 'error')
}
async function stopProxy() { const r = await window.electronAPI.stopProxy(); if (r.success) { proxyRunning = false; updateProxyUI(); document.getElementById('connection-status').textContent = '已停止' } }
async function clearCache() { try { await fetch(`http://${config.proxy?.host || '127.0.0.1'}:${proxyPort}/cache`, { method: 'DELETE' }); toast('缓存已清空', 'success') } catch (e) { toast('失败: ' + e.message, 'error') } }

function updateProxyUI() {
  const ind = document.getElementById('proxy-status-indicator'), badge = document.getElementById('proxy-badge')
  const sb = document.getElementById('btn-start-proxy'), stb = document.getElementById('btn-stop-proxy'), tb = document.getElementById('btn-toggle-proxy')
  if (proxyRunning) {
    ind.classList.add('active'); ind.querySelector('.status-text').textContent = '运行中'
    badge.textContent = '运行中'; badge.classList.add('active'); sb.disabled = true; stb.disabled = false
    tb.querySelector('.action-text').textContent = '停止代理'; tb.querySelector('.action-icon').textContent = '⬛'
  } else {
    ind.classList.remove('active'); ind.querySelector('.status-text').textContent = '未启动'
    badge.textContent = '已停止'; badge.classList.remove('active'); sb.disabled = false; stb.disabled = true
    tb.querySelector('.action-text').textContent = '启动代理'; tb.querySelector('.action-icon').textContent = '▶'
  }
  document.getElementById('sidebar-port').textContent = proxyPort || DEFAULT_PROXY_PORT
  document.getElementById('proxy-address').textContent = `http://127.0.0.1:${proxyPort || DEFAULT_PROXY_PORT}`
}

async function checkProxyStatus() { try { const s = await window.electronAPI.proxyStatus(); proxyRunning = s.running; proxyPort = s.port || DEFAULT_PROXY_PORT; updateProxyUI() } catch { proxyRunning = false; updateProxyUI() } }

function addProvider() {
  const name = prompt('输入提供商名称 (例如: openai, anthropic, deepseek):')
  if (!name?.trim()) return
  if (!config.providers) config.providers = {}
  if (!config.providers[name.trim()]) config.providers[name.trim()] = { api_key: '', base_url: '', models: [] }
  populateProviderSelect(); document.getElementById('provider-select').value = name.trim(); selectProvider()
}
function removeProvider() { const n = document.getElementById('provider-select').value; if (!n || !confirm(`确认删除 "${n}"?`)) return; delete config.providers[n]; populateProviderSelect() }

function populateProviderSelect() {
  const sel = document.getElementById('provider-select'); sel.innerHTML = ''
  for (const n of Object.keys(config.providers || {})) { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o) }
  sel.onchange = () => selectProvider()
  const ds = document.getElementById('default-provider'); ds.innerHTML = ''
  for (const n of Object.keys(config.providers || {})) { const o = document.createElement('option'); o.value = n; o.textContent = n; ds.appendChild(o) }
  if (config.default_provider) ds.value = config.default_provider
}
function selectProvider() {
  const n = document.getElementById('provider-select').value; if (!n) return
  const p = (config.providers || {})[n]; if (!p) return
  document.getElementById('provider-api-key').value = p.api_key || ''
  document.getElementById('provider-base-url').value = p.base_url || ''
}

async function fetchModels() {
  const baseUrl = document.getElementById('provider-base-url').value.trim(), apiKey = document.getElementById('provider-api-key').value.trim()
  if (!baseUrl) { toast('请先填写基础 URL', 'warn'); return }
  if (!apiKey) { toast('请先填写 API 密钥', 'warn'); return }
  const btn = document.getElementById('btn-fetch-models'); btn.disabled = true; btn.textContent = '⏳ 获取中...'
  try {
    // 通过代理服务器转发请求，避免渲染进程直接请求外部 API 的 CORS 问题
    const proxyHost = config.proxy?.host || '127.0.0.1'
    const res = await fetch(`http://${proxyHost}:${proxyPort}/v1/models`, { headers: { 'Authorization': `Bearer ${apiKey}`, 'X-Target-Base-Url': baseUrl.replace(/\/+$/, '') } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const models = ((await res.json()).data || []).map(m => m.id || m.model || m.name).filter(Boolean)
    if (!models.length) { toast('未返回模型列表', 'warn'); btn.disabled = false; btn.textContent = '⬇ 获取模型列表'; return }
    const container = document.getElementById('provider-models-checkboxes'); container.innerHTML = ''
    for (const m of models) {
      const l = document.createElement('label'); l.className = 'model-chip'
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = m; l.appendChild(cb)
      const s = document.createElement('span'); s.className = 'model-chip-name'; s.textContent = m; l.appendChild(s); container.appendChild(l)
    }
    document.getElementById('models-count').textContent = `共 ${models.length} 个模型`
    btn.textContent = `✓ 已获取 ${models.length} 个模型`; setTimeout(() => { btn.textContent = '⬇ 获取模型列表'; btn.disabled = false }, 2000)
  } catch (e) { btn.disabled = false; btn.textContent = '⬇ 获取模型列表'; toast('获取失败: ' + e.message, 'error') }
}

function openSettings() { loadConfigToSettings(); document.getElementById('settings-modal').classList.remove('hidden') }
function closeSettings() { document.getElementById('settings-modal').classList.add('hidden') }
function loadConfigToSettings() {
  document.getElementById('proxy-host').value = config.proxy?.host || '127.0.0.1'
  document.getElementById('proxy-port').value = config.proxy?.port || DEFAULT_PROXY_PORT
  document.getElementById('proxy-sanitize').checked = config.proxy?.sanitize_requests !== false
  populateProviderSelect()
  document.getElementById('budget-limit').value = config.monitor?.budget_limit || 10
  document.getElementById('warning-threshold').value = config.monitor?.warning_threshold || 75
  document.getElementById('critical-threshold').value = config.monitor?.critical_threshold || 90
  document.getElementById('db-path').value = config.monitor?.db_path || 'contextgate.db'
  document.getElementById('max-file-size').value = config.scanner?.max_file_size || 1048576
  document.getElementById('include-extensions').value = (config.scanner?.include_extensions || []).join('\n')
  document.getElementById('output-file').value = config.context?.output_file || 'full_context.txt'
  document.getElementById('context-max-tokens').value = config.context?.max_tokens || 8000
  document.getElementById('watch-enabled').checked = config.context?.watch_enabled !== false
  document.getElementById('debounce-seconds').value = config.context?.debounce_seconds || 1
  document.getElementById('fixed-currency').value = config.currency?.fixed_currency || ''
  document.getElementById('fixed-rate').value = config.currency?.fixed_rate || ''
  document.getElementById('cny-rate').value = config.currency?.default_rates?.CNY || 7.2
  document.getElementById('eur-rate').value = config.currency?.default_rates?.EUR || 0.92
}
async function saveSettings() {
  config.proxy = { host: document.getElementById('proxy-host').value, port: parseInt(document.getElementById('proxy-port').value), sanitize_requests: document.getElementById('proxy-sanitize').checked }
  config.default_provider = document.getElementById('default-provider').value
  config.monitor = { budget_limit: parseFloat(document.getElementById('budget-limit').value), warning_threshold: parseInt(document.getElementById('warning-threshold').value), critical_threshold: parseInt(document.getElementById('critical-threshold').value), db_path: document.getElementById('db-path').value }
  config.scanner = { max_file_size: parseInt(document.getElementById('max-file-size').value), include_extensions: document.getElementById('include-extensions').value.split('\n').filter(e => e.trim()) }
  config.context = { output_file: document.getElementById('output-file').value, max_tokens: parseInt(document.getElementById('context-max-tokens').value) || 8000, watch_enabled: document.getElementById('watch-enabled').checked, debounce_seconds: parseFloat(document.getElementById('debounce-seconds').value) }
  const fc = document.getElementById('fixed-currency').value, fr = document.getElementById('fixed-rate').value
  config.currency = { default_rates: { CNY: parseFloat(document.getElementById('cny-rate').value), EUR: parseFloat(document.getElementById('eur-rate').value) } }
  if (fc) config.currency.fixed_currency = fc; if (fr) config.currency.fixed_rate = parseFloat(fr)
  saveCurrentProvider()
  const ok = await window.electronAPI.saveConfig(config)
  if (ok) { closeSettings(); toast('设置已保存', 'success') } else toast('保存失败', 'error')
}
function saveCurrentProvider() {
  const n = document.getElementById('provider-select').value; if (!n || !config.providers) return
  const checked = []; document.querySelectorAll('#provider-models-checkboxes input[type=checkbox]:checked').forEach(cb => checked.push(cb.value))
  config.providers[n] = { ...config.providers[n], api_key: document.getElementById('provider-api-key').value, base_url: document.getElementById('provider-base-url').value, models: checked }
}
function switchTab(id) { document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === id)); document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === `tab-${id}`)) }

function setupProxyListeners() {
  window.electronAPI.onProxyLog(data => {
    if (data?.type) {
      addLogEntry(data)
      if (data.type === 'response' || data.type === 'stream') {
        stats.todayRequests++; stats.todayTokens += data.tokens?.total || 0
        if (data.cached) { stats.todaySavings += data.cost || 0; stats.cacheHits++ }
        updateStatsUI()
      }
    }
  })
  window.electronAPI.onProxyStopped(() => { proxyRunning = false; updateProxyUI() })
}

function escapeHtml(str) { const d = document.createElement('div'); d.textContent = str ?? ''; return d.innerHTML }

function addLogEntry(data) {
  const lc = document.getElementById('log-content'); if (!lc) return
  const isErr = data.type === 'error', isCache = data.cached === true, isStream = data.type === 'stream'
  const t = data.tokens || {}, cost = data.cost ?? 0
  const row = document.createElement('div')
  row.className = 'log-row' + (isErr ? ' log-row-error' : '') + (isCache ? ' log-row-cache' : '') + (isStream ? ' log-row-stream' : '')
  const ms = (data.model || '').length > 26 ? (data.model || '').substring(0, 24) + '…' : (data.model || '-')
  const safeMs = escapeHtml(ms)
  const safePath = escapeHtml(`${data.method || ''} ${data.path || ''}`)
  const safeUrl = escapeHtml(data.backendUrl || '')
  const safePreview = escapeHtml(data.messagePreview || '')
  const safeError = escapeHtml(data.error || '')
  row.innerHTML = `<div class="log-row-main"><span class="log-tag ${isErr ? 'log-tag-err' : isCache ? 'log-tag-cache' : isStream ? 'log-tag-stream' : 'log-tag-ok'}">${isErr ? 'ERR' : isCache ? 'CACHE' : isStream ? 'STREAM' : 'OK'}</span><span class="log-row-model">${safeMs}</span><span class="log-row-tokens">${t.prompt || 0}↑ ${t.completion || 0}↓ ${t.total || 0}∑</span><span class="log-row-time">${data.responseTime || 0}ms</span><span class="log-row-cost">${currencySymbols[currentCurrency]}${cost}</span></div><div class="log-row-detail"><span class="log-row-path">${safePath}</span><span class="log-row-url">→ ${safeUrl}</span></div>${safePreview ? `<div class="log-row-preview">${safePreview}</div>` : ''}${isErr ? `<div class="log-row-errmsg">${safeError}</div>` : ''}`
  lc.appendChild(row); lc.scrollTop = lc.scrollHeight
}

init()
