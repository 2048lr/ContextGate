const DEFAULT_PROXY_PORT = 12306
const currencySymbols = { USD: '$', CNY: '￥', EUR: '€' }

let config = {}, currentProject = null, proxyRunning = false, proxyPort = DEFAULT_PROXY_PORT
let currentCurrency = 'USD'
let localToken = null
let budgetState = null
let stats = { todayRequests: 0, todayTokens: 0, todayCost: 0, todaySavings: 0, cacheHits: 0 }

function toast(msg, type = 'info') {
  const c = document.getElementById('toast-container'); if (!c) return
  const el = document.createElement('div'); el.className = `toast toast-${type}`; el.textContent = msg; c.appendChild(el)
  requestAnimationFrame(() => el.classList.add('show'))
  setTimeout(() => { el.classList.remove('show'); el.addEventListener('transitionend', () => el.remove()) }, 3000)
}

async function init() {
  try { const url = await window.electronAPI.getBackgroundUrl(); document.getElementById('background-container').style.backgroundImage = `url('${url}')` } catch {}
  try { config = await window.electronAPI.getConfig(); if (config.workspace) { currentProject = config.workspace; updateProjectUI() }; updateCurrency() } catch {}
  // 代理未运行时，显示端口/地址端口应与配置端口保持一致
  if (config.proxy?.port) proxyPort = config.proxy.port
  await loadStats(); await loadLocalToken()
  setupEventListeners(); setupProxyListeners(); await checkProxyStatus(); updateMemoryUsage(); setInterval(updateMemoryUsage, 5000)
}

function updateCurrency() {
  if (config.currency?.fixed_currency) { currentCurrency = config.currency.fixed_currency; return }
  for (const p of Object.values(config.providers || {})) { if ((p.base_url || '').includes('.cn')) { currentCurrency = 'CNY'; return } }
}

async function loadStats() {
  try {
    const s = await window.electronAPI.getStats()
    if (s) {
      // FIX-04：「今日成本」与「今日节省」是两个口径，不能再把 cost 当成节省
      stats = {
        todayRequests: s.today?.requests || 0,
        todayTokens: s.today?.tokens || 0,
        todayCost: s.today?.cost || 0,
        todaySavings: s.today?.saved || 0,
        cacheHits: s.today?.cacheHits || 0,
      }
      budgetState = s.budget || null
      updateStatsUI()
    }
  } catch {}
}

async function loadLocalToken() {
  try {
    const r = await window.electronAPI.getLocalToken()
    localToken = r?.token || null
    const el = document.getElementById('proxy-token')
    if (el) el.textContent = localToken ? localToken.slice(0, 6) + '…' + localToken.slice(-4) : (r?.enabled === false ? '鉴权已关闭' : '未生成')
  } catch {}
}

function updateProjectUI() {
  const badge = document.getElementById('project-badge'), pv = document.querySelector('#project-path-display .info-value')
  if (currentProject) { badge.textContent = '已加载'; pv.textContent = currentProject }
  else { badge.textContent = '未选择'; pv.textContent = '点击选择项目...' }
}

function updateStatsUI() {
  const sym = currencySymbols[currentCurrency]
  document.getElementById('stat-today-requests').textContent = stats.todayRequests.toLocaleString()
  document.getElementById('stat-today-tokens').textContent = (stats.todayTokens / 1000).toFixed(1) + 'k'
  document.getElementById('stat-today-cost').textContent = sym + stats.todayCost.toFixed(2)
  document.getElementById('stat-today-savings').textContent = sym + stats.todaySavings.toFixed(2)
  // 命中率分母是「总请求数」——缓存命中本身就是一次请求，不能再加一次
  const denom = stats.todayRequests
  document.getElementById('stat-cache-hit').textContent = (denom > 0 ? Math.round((stats.cacheHits / denom) * 100) : 0) + '%'
  const budgetEl = document.getElementById('stat-budget')
  if (budgetEl) {
    if (!budgetState || !budgetState.limit) budgetEl.textContent = '--'
    else {
      budgetEl.textContent = Math.round(budgetState.ratio * 100) + '%'
      budgetEl.style.color = budgetState.level === 'exceeded' ? 'var(--danger)'
        : budgetState.level === 'critical' ? 'var(--danger)'
          : budgetState.level === 'warning' ? '#e0a800' : ''
    }
  }
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
  document.getElementById('btn-copy-context').onclick = copyContext
  document.getElementById('btn-reveal-context').onclick = revealContext
  document.getElementById('btn-copy-token').onclick = copyToken
  document.getElementById('btn-rotate-token').onclick = rotateToken
  const insecureTlsToggle = document.getElementById('security-allow-insecure-tls')
  if (insecureTlsToggle) {
    insecureTlsToggle.addEventListener('change', () => {
      if (insecureTlsToggle.checked) toast('开启后 provider 可关闭 TLS 校验，API Key 可能被中间人截获', 'error')
    })
  }
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
  document.getElementById('btn-add-provider').onclick = openAddProviderModal
  document.getElementById('btn-remove-provider').onclick = removeProvider
  document.getElementById('btn-fetch-models').onclick = fetchModels
  document.getElementById('btn-confirm-add-provider').onclick = confirmAddProvider
  document.getElementById('btn-cancel-add-provider').onclick = closeAddProviderModal
  document.getElementById('btn-close-provider-modal').onclick = closeAddProviderModal
  document.getElementById('provider-name-modal').onclick = e => { if (e.target.id === 'provider-name-modal') closeAddProviderModal() }
  document.getElementById('provider-name-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); confirmAddProvider() } })
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
      addLogEntry({ type: 'response', method: 'BUILD', path: '/build', model: '-', provider: 'local', tokens: {}, cached: false, status: 200, responseTime: 0, messagePreview: `上下文构建完成: ${r.fileCount}/${r.totalFiles} 文件, 略过 ${r.skippedCount}` })
      if (r.secrets?.length) toast(`⚠ ${r.secrets.length} 个文件疑似包含凭据，已记入 manifest`, 'warn')
    } else toast('构建失败: ' + r.error, 'error')
  } catch (e) { toast('构建失败: ' + e.message, 'error') }
}

async function toggleProxy() { proxyRunning ? await stopProxy() : await startProxy() }
async function startProxy() {
  const r = await window.electronAPI.startProxy(config.proxy?.port || DEFAULT_PROXY_PORT)
  if (r.success) {
    proxyRunning = true; proxyPort = r.port; updateProxyUI()
    document.getElementById('connection-status').textContent = `运行中 :${r.port}`
    if (r.token) { localToken = r.token; loadLocalToken() }
    for (const w of r.warnings || []) toast(w, 'error')
    if (r.watch && r.watch.started === false && r.watch.error && r.watch.error !== 'watch_enabled=false') toast('文件监视未启用: ' + r.watch.error, 'warn')
  } else toast('启动失败: ' + r.error, 'error')
}
async function stopProxy() { const r = await window.electronAPI.stopProxy(); if (r.success) { proxyRunning = false; updateProxyUI(); document.getElementById('connection-status').textContent = '已停止' } }
function proxyHeaders(extra = {}) {
  const headers = { ...extra }
  if (localToken) headers['X-ContextGate-Token'] = localToken
  return headers
}

async function clearCache() {
  try {
    const res = await fetch(`http://${config.proxy?.host || '127.0.0.1'}:${proxyPort}/cache`, { method: 'DELETE', headers: proxyHeaders() })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    toast('缓存已清空', 'success')
  } catch (e) { toast('失败: ' + e.message, 'error') }
}

async function copyContext() {
  try {
    const r = await window.electronAPI.readContextFile()
    if (!r.success) { toast(r.error || '读取失败', 'warn'); return }
    const res = await window.electronAPI.copyToClipboard(r.content)
    if (!res.success) { toast('复制失败: ' + res.error, 'error'); return }
    toast(`已复制上下文 (${(r.size / 1024).toFixed(1)} KB)`, 'success')
  } catch (e) { toast('复制失败: ' + e.message, 'error') }
}

async function revealContext() {
  try {
    const r = await window.electronAPI.readContextFile()
    if (!r.success) { toast(r.error || '产物不存在', 'warn'); return }
    await window.electronAPI.revealPath(r.path)
  } catch (e) { toast('打开失败: ' + e.message, 'error') }
}

async function copyToken() {
  if (!localToken) { toast('尚未生成令牌，请先启动代理', 'warn'); return }
  const r = await window.electronAPI.copyToClipboard(localToken)
  toast(r.success ? '令牌已复制到剪贴板' : '复制失败', r.success ? 'success' : 'error')
}

async function rotateToken() {
  if (!confirm('重置后所有已配置该令牌的客户端都需要重新填写，确认继续？')) return
  const r = await window.electronAPI.rotateLocalToken()
  if (!r.success) { toast(r.error || '重置失败', 'error'); return }
  localToken = r.token
  await loadLocalToken()
  config = await window.electronAPI.getConfig()
  toast('令牌已重置', 'success')
}

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

async function checkProxyStatus() { try { const s = await window.electronAPI.proxyStatus(); proxyRunning = s.running; if (s.running) { proxyPort = s.port || DEFAULT_PROXY_PORT } else if (config.proxy?.port) { proxyPort = config.proxy.port }; updateProxyUI() } catch { proxyRunning = false; if (config.proxy?.port) proxyPort = config.proxy.port; updateProxyUI() } }

function openAddProviderModal() {
  const input = document.getElementById('provider-name-input')
  input.value = ''
  document.getElementById('provider-name-modal').classList.remove('hidden')
  setTimeout(() => input.focus(), 50)
}
function closeAddProviderModal() {
  document.getElementById('provider-name-modal').classList.add('hidden')
}
function confirmAddProvider() {
  const name = document.getElementById('provider-name-input').value.trim()
  if (!name) { toast('请输入提供商名称', 'warn'); return }
  if (!/^[a-z0-9_-]+$/i.test(name)) { toast('名称只能包含字母、数字、下划线和连字符', 'warn'); return }
  if (!config.providers) config.providers = {}
  if (config.providers[name]) { toast('该提供商已存在', 'warn'); return }
  config.providers[name] = { api_key: '', base_url: '', models: [] }
  populateProviderSelect(); document.getElementById('provider-select').value = name; selectProvider()
  closeAddProviderModal(); toast(`已新增提供商: ${name}`, 'success')
}
function removeProvider() { const n = document.getElementById('provider-select').value; if (!n || !confirm(`确认删除 "${n}"?`)) return; delete config.providers[n]; populateProviderSelect(); selectProvider() }

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
  // 加载已保存的模型列表到复选框，避免切换提供商时模型丢失
  const container = document.getElementById('provider-models-checkboxes'); container.innerHTML = ''
  const savedModels = p.models || []
  for (const m of savedModels) {
    const l = document.createElement('label'); l.className = 'model-chip'
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = m; cb.checked = true; l.appendChild(cb)
    const s = document.createElement('span'); s.className = 'model-chip-name'; s.textContent = m; l.appendChild(s); container.appendChild(l)
  }
  document.getElementById('models-count').textContent = savedModels.length ? `共 ${savedModels.length} 个模型` : ''
}

async function fetchModels() {
  const baseUrl = document.getElementById('provider-base-url').value.trim(), apiKey = document.getElementById('provider-api-key').value.trim()
  if (!baseUrl) { toast('请先填写基础 URL', 'warn'); return }
  if (!apiKey) { toast('请先填写 API 密钥', 'warn'); return }
  const btn = document.getElementById('btn-fetch-models'); btn.disabled = true; btn.textContent = '⏳ 获取中...'
  try {
    // 通过代理服务器转发请求，避免渲染进程直接请求外部 API 的 CORS 问题
    const proxyHost = config.proxy?.host || '127.0.0.1'
    const res = await fetch(`http://${proxyHost}:${proxyPort}/v1/models`, { headers: proxyHeaders({ 'Authorization': `Bearer ${apiKey}`, 'X-Target-Base-Url': baseUrl.replace(/\/+$/, '') }) })
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

function openSettings() { loadConfigToSettings(); loadSecurityStatus(); document.getElementById('settings-modal').classList.remove('hidden') }

function securityRow(label, value, state) {
  const row = document.createElement('div')
  row.className = 'security-row' + (state ? ' ' + state : '')
  const l = document.createElement('span'); l.className = 'security-label'; l.textContent = label
  const v = document.createElement('span'); v.className = 'security-value'; v.textContent = value
  row.appendChild(l); row.appendChild(v)
  return row
}

async function loadSecurityStatus() {
  const container = document.getElementById('security-status')
  if (!container) return
  let s
  try { s = await window.electronAPI.getSecurityStatus() } catch { return }
  if (!s) return
  container.innerHTML = ''
  const r = s.renderer || {}
  container.appendChild(securityRow('Electron / Chromium', `${s.electron} / ${s.chrome}`, 'ok'))
  container.appendChild(securityRow('渲染进程沙箱', r.sandboxed == null ? '未知' : (r.sandboxed ? '已启用' : '已禁用'), r.sandboxed === false ? 'bad' : 'ok'))
  container.appendChild(securityRow('上下文隔离', r.contextIsolated === false ? '已禁用' : '已启用', r.contextIsolated === false ? 'bad' : 'ok'))
  container.appendChild(securityRow('渲染层 Node require', r.hasNodeRequire ? '可用（危险）' : '不可用', r.hasNodeRequire ? 'bad' : 'ok'))
  container.appendChild(securityRow('禁用沙箱的启动开关', s.main.sandboxFlagsPresent.length ? s.main.sandboxFlagsPresent.join(', ') : '无', s.main.sandboxFlagsPresent.length ? 'bad' : 'ok'))
  container.appendChild(securityRow('导航 / 弹窗守卫', s.navigation.guardsInstalled ? `已启用（放行 ${s.navigation.allowedExternalHosts.join(', ') || '无'}）` : '未启用', s.navigation.guardsInstalled ? 'ok' : 'bad'))
  container.appendChild(securityRow('本地令牌鉴权', s.proxy.authEnabled ? '已启用' : '已关闭', s.proxy.authEnabled ? 'ok' : 'bad'))
  container.appendChild(securityRow('Host 头校验', s.proxy.hostCheck ? '已启用' : '已关闭', s.proxy.hostCheck ? 'ok' : 'warn'))
  container.appendChild(securityRow('代理绑定地址', s.proxy.host, /^(127\.0\.0\.1|localhost|::1|\[::1\])$/.test(s.proxy.host) ? 'ok' : 'bad'))
  container.appendChild(securityRow('不安全 TLS 降级', s.proxy.allowInsecureTls ? `已允许（${s.proxy.providersRequestingInsecureTls.join(', ') || '无 provider 使用'}）` : '已禁用', s.proxy.allowInsecureTls ? 'bad' : 'ok'))
  container.appendChild(securityRow('遥测 / 崩溃上报', '未启用', 'ok'))
  for (const p of s.problems || []) container.appendChild(securityRow('⚠ 检测到问题', p, 'bad'))
}
function closeSettings() { document.getElementById('settings-modal').classList.add('hidden') }
function loadConfigToSettings() {
  document.getElementById('proxy-host').value = config.proxy?.host || '127.0.0.1'
  document.getElementById('proxy-host').oninput = () => {
    const v = document.getElementById('proxy-host').value.trim()
    if (v && v !== '127.0.0.1' && v !== 'localhost' && v !== '::1') {
      toast('非回环地址会让局域网内的设备也能访问代理，请确认这是你想要的', 'warn')
    }
  }
  document.getElementById('proxy-port').value = config.proxy?.port || DEFAULT_PROXY_PORT
  document.getElementById('proxy-sanitize').checked = config.proxy?.sanitize_requests !== false
  document.getElementById('proxy-auth-enabled').checked = config.proxy?.auth?.enabled !== false
  document.getElementById('proxy-max-body').value = config.proxy?.max_body_size || '32mb'
  populateProviderSelect()
  document.getElementById('budget-limit').value = config.monitor?.budget_limit || 10
  document.getElementById('warning-threshold').value = config.monitor?.warning_threshold || 75
  document.getElementById('critical-threshold').value = config.monitor?.critical_threshold || 90
  document.getElementById('db-path').value = config.monitor?.db_path || 'contextgate.db'
  document.getElementById('max-file-size').value = config.scanner?.max_file_size || 1048576
  document.getElementById('include-extensions').value = (config.scanner?.include_extensions || []).join('\n')
  document.getElementById('output-file').value = config.context?.output_file || 'full_context.txt'
  document.getElementById('context-max-tokens').value = config.context?.max_tokens ?? 8000
  document.getElementById('context-format').value = config.context?.format || 'markdown'
  document.getElementById('watch-enabled').checked = config.context?.watch_enabled !== false
  document.getElementById('debounce-seconds').value = config.context?.debounce_seconds || 1
  document.getElementById('context-extra-ignore').value = (config.scanner?.exclude || []).join('\n')
  document.getElementById('security-external-hosts').value = (config.security?.allowed_external_hosts || []).join('\n')
  document.getElementById('security-allow-insecure-tls').checked = config.security?.allow_insecure_tls === true
  document.getElementById('fixed-currency').value = config.currency?.fixed_currency || ''
  document.getElementById('fixed-rate').value = config.currency?.fixed_rate || ''
  document.getElementById('cny-rate').value = config.currency?.default_rates?.CNY || 7.2
  document.getElementById('eur-rate').value = config.currency?.default_rates?.EUR || 0.92
}
async function saveSettings() {
  // 展开保留未知字段（尤其是 proxy.local_token），否则保存设置会把令牌抹掉
  config.proxy = {
    ...(config.proxy || {}),
    host: document.getElementById('proxy-host').value,
    port: parseInt(document.getElementById('proxy-port').value),
    sanitize_requests: document.getElementById('proxy-sanitize').checked,
    max_body_size: document.getElementById('proxy-max-body').value.trim() || '32mb',
    auth: { ...(config.proxy?.auth || {}), enabled: document.getElementById('proxy-auth-enabled').checked },
  }
  config.default_provider = document.getElementById('default-provider').value
  config.monitor = { ...(config.monitor || {}), budget_limit: parseFloat(document.getElementById('budget-limit').value), warning_threshold: parseInt(document.getElementById('warning-threshold').value), critical_threshold: parseInt(document.getElementById('critical-threshold').value), db_path: document.getElementById('db-path').value }
  config.scanner = {
    ...(config.scanner || {}),
    max_file_size: parseInt(document.getElementById('max-file-size').value),
    include_extensions: document.getElementById('include-extensions').value.split('\n').filter(e => e.trim()),
    exclude: document.getElementById('context-extra-ignore').value.split('\n').map(e => e.trim()).filter(Boolean),
  }
  config.context = {
    ...(config.context || {}),
    output_file: document.getElementById('output-file').value,
    format: document.getElementById('context-format').value,
    max_tokens: parseInt(document.getElementById('context-max-tokens').value),
    watch_enabled: document.getElementById('watch-enabled').checked,
    debounce_seconds: parseFloat(document.getElementById('debounce-seconds').value),
  }
  if (isNaN(config.context.max_tokens)) config.context.max_tokens = 8000
  config.security = {
    ...(config.security || {}),
    allowed_external_hosts: document.getElementById('security-external-hosts').value.split('\n').map(e => e.trim()).filter(Boolean),
    allow_insecure_tls: document.getElementById('security-allow-insecure-tls').checked,
  }
  // FIX-S2：开启 TLS 降级必须二次确认
  if (config.security.allow_insecure_tls) {
    const ok = confirm('你正在允许 provider 关闭 TLS 证书校验。\n这会让 API Key 与对话内容暴露给中间人攻击。\n确认继续？')
    if (!ok) {
      config.security.allow_insecure_tls = false
      document.getElementById('security-allow-insecure-tls').checked = false
    }
  }
  const fc = document.getElementById('fixed-currency').value, fr = document.getElementById('fixed-rate').value
  config.currency = { default_rates: { CNY: parseFloat(document.getElementById('cny-rate').value), EUR: parseFloat(document.getElementById('eur-rate').value) } }
  if (fc) config.currency.fixed_currency = fc; if (fr) config.currency.fixed_rate = parseFloat(fr)
  saveCurrentProvider()
  const ok = await window.electronAPI.saveConfig(config)
  if (ok) {
    // 代理未运行时，同步显示端口/地址端口与设置端口保持一致
    if (!proxyRunning && config.proxy?.port) { proxyPort = config.proxy.port; updateProxyUI() }
    closeSettings(); toast('设置已保存', 'success')
  } else toast('保存失败', 'error')
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
        stats.todayRequests++
        stats.todayTokens += data.tokens?.total || 0
        stats.todayCost += data.cost || 0
        stats.todaySavings += data.savedCost || 0
        if (data.cached) stats.cacheHits++
        updateStatsUI()
      }
    }
  })
  window.electronAPI.onProxyStopped(() => { proxyRunning = false; updateProxyUI() })
  // FIX-04：预算阈值告警（原先三个阈值配置项从未生效）
  window.electronAPI.onBudgetAlert(state => {
    budgetState = state
    updateStatsUI()
    if (state.level === 'warning') toast(`预算已用 ${Math.round(state.ratio * 100)}%（${state.spent.toFixed(4)} / ${state.limit}）`, 'warn')
    else if (state.level === 'critical') toast(`预算接近上限：已用 ${Math.round(state.ratio * 100)}%`, 'error')
    else if (state.level === 'exceeded') toast('预算已超限，新的请求可能被拒绝', 'error')
  })
  // FIX-05：文件监视触发的自动重建
  window.electronAPI.onContextUpdated(data => {
    if (!data) return
    if (data.success) {
      document.getElementById('file-count').textContent = `${data.fileCount} 文件`
      document.getElementById('char-count').textContent = `${(data.totalChars / 1000).toFixed(1)}k 字符`
      document.getElementById('token-estimate').textContent = `~${(data.estimatedTokens / 1000).toFixed(1)}k Token`
      addLogEntry({ type: 'response', method: 'WATCH', path: '/rebuild', model: '-', provider: 'local', tokens: {}, cached: false, status: 200, responseTime: 0, messagePreview: `上下文已自动重建: ${data.fileCount} 文件 / 略过 ${data.skippedCount}` })
    } else {
      toast('自动重建失败: ' + data.error, 'error')
    }
  })
}

function escapeHtml(str) { const d = document.createElement('div'); d.textContent = str ?? ''; return d.innerHTML }

function addLogEntry(data) {
  const lc = document.getElementById('log-content'); if (!lc) return
  const isErr = data.type === 'error', isCache = data.cached === true, isStream = data.type === 'stream'
  const t = data.tokens || {}, cost = data.cost ?? 0
  const priceUnknown = data.pricingKnown === false && !isErr
  const costLabel = isCache && data.savedCost
    ? `省 ${currencySymbols[currentCurrency]}${Number(data.savedCost).toFixed(4)}`
    : priceUnknown ? '价格未知' : `${currencySymbols[currentCurrency]}${Number(cost).toFixed(4)}`
  const row = document.createElement('div')
  row.className = 'log-row' + (isErr ? ' log-row-error' : '') + (isCache ? ' log-row-cache' : '') + (isStream ? ' log-row-stream' : '')
  const ms = (data.model || '').length > 26 ? (data.model || '').substring(0, 24) + '…' : (data.model || '-')
  const safeMs = escapeHtml(ms)
  const safePath = escapeHtml(`${data.method || ''} ${data.path || ''}`)
  const safeUrl = escapeHtml(data.backendUrl || '')
  const safePreview = escapeHtml(data.messagePreview || '')
  const safeError = escapeHtml(data.error || '')
  row.innerHTML = `<div class="log-row-main"><span class="log-tag ${isErr ? 'log-tag-err' : isCache ? 'log-tag-cache' : isStream ? 'log-tag-stream' : 'log-tag-ok'}">${isErr ? 'ERR' : isCache ? 'CACHE' : isStream ? 'STREAM' : 'OK'}</span><span class="log-row-model">${safeMs}</span><span class="log-row-tokens">${t.prompt || 0}↑ ${t.completion || 0}↓ ${t.total || 0}∑</span><span class="log-row-time">${data.responseTime || 0}ms</span><span class="log-row-cost" title="${priceUnknown ? '该模型不在价格目录中，成本按 0 计但已标记' : ''}">${costLabel}</span></div><div class="log-row-detail"><span class="log-row-path">${safePath}</span><span class="log-row-url">→ ${safeUrl}</span></div>${safePreview ? `<div class="log-row-preview">${safePreview}</div>` : ''}${isErr ? `<div class="log-row-errmsg">${safeError}</div>` : ''}`
  lc.appendChild(row); lc.scrollTop = lc.scrollHeight
}

init()
