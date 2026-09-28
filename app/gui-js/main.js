const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, clipboard, shell, session, safeStorage } = require('electron')
const path = require('path')
const fs = require('fs')
const yaml = require('js-yaml')

// FIX-S1：原实现全局关闭 Chromium 沙箱（no-sandbox / disable-setuid-sandbox /
// disable-gpu-sandbox）。官方安全清单明确 --no-sandbox 会「为所有进程关闭沙箱，
// 绝对不要在生产环境使用」。现在改为显式开启沙箱。
// 仅保留 Linux 容器常见的 /dev/shm 变通项（与沙箱无关，且本项目只支持 Windows）。
if (process.platform === 'linux') app.commandLine.appendSwitch('disable-dev-shm-usage')
app.enableSandbox()

// GPU 驱动导致渲染异常时的正确做法是关掉硬件加速，而不是关沙箱：
//   app.disableHardwareAcceleration()
// 上面这行必须在 app ready 之前调用；如需启用，请在此处放开，不要改回 --disable-gpu-sandbox。

// FIX-12（P1-5）：单实例锁。
// 没有它时重复启动会出现两个托盘、两次抢 12306 端口、两个进程写同一个 sqlite 库。
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  console.warn('[main] 已有 ContextGate 实例在运行，本次启动直接退出')
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus() }
  })
}

const userDataPath = app.getPath('userData')
const tmpDir = path.join(userDataPath, 'tmp')
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
app.setPath('temp', tmpDir)
process.env.TMPDIR = process.env.TMP = process.env.TEMP = tmpDir

const { CodeScanner } = require('./lib/scanner/scanner')
const { ContextWatcher } = require('./lib/scanner/watcher')
const { ProxyServer } = require('./lib/proxy/proxy-server')
const { TokenMonitor } = require('./lib/monitor/token-monitor')
const { BudgetGuard } = require('./lib/monitor/budget')
const { EventBus } = require('./lib/core/event-bus')
const { ConfigManager } = require('./lib/core/config-manager')
const { DEFAULT_PROXY_HOST, DEFAULT_PROXY_PORT } = require('./lib/core/constants')
const { createNavigationPolicy, installNavigationGuards } = require('./lib/security/navigation')
const { createSecretStore, absorbConfigSecrets } = require('./lib/core/secret-store')

const isLinux = process.platform === 'linux'
const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

let mainWindow = null, tray = null, config = {}
let proxyServer = null, proxyPort = DEFAULT_PROXY_PORT
let proxyHost = DEFAULT_PROXY_HOST
let isProxyRunning = false, tokenMonitor = null
let _proxyEventUnsubs = []
let contextWatcher = null
let budgetGuard = null
let navigationGuards = null
let navigationPolicy = null
// FIX-13：密钥库（safeStorage/DPAPI 加密），惰性创建
let secretStore = null
let maintenanceTimer = null
const eventBus = new EventBus()
// FIX-S1：渲染进程通过 preload 上报自身的沙箱/隔离状态，主进程据此做启动自检
let rendererSecurityReport = null
const securityEvents = []

function recordSecurityEvent(level, message) {
  const event = { level, message, at: new Date().toISOString() }
  securityEvents.push(event)
  if (securityEvents.length > 50) securityEvents.shift()
  if (level === 'error') console.error('[security]', message)
  else console.warn('[security]', message)
  return event
}

/** FIX-S1：主进程侧的沙箱自检；返回发现的问题列表 */
function auditSandboxConfiguration() {
  const problems = []
  for (const flag of ['no-sandbox', 'disable-setuid-sandbox', 'disable-gpu-sandbox']) {
    if (app.commandLine.hasSwitch(flag)) problems.push(`命令行出现了禁用沙箱的开关：--${flag}`)
  }
  if (rendererSecurityReport && rendererSecurityReport.sandboxed === false) {
    problems.push('渲染进程未启用沙箱（process.sandboxed === false）')
  }
  if (rendererSecurityReport && rendererSecurityReport.contextIsolated === false) {
    problems.push('渲染进程未启用上下文隔离（process.contextIsolated === false）')
  }
  return problems
}

/**
 * FIX-13：带密钥解析器的 ConfigManager。
 * 配置文件里只留 api_key_ref: 'secret'，明文 Key 由加密库提供，
 * 因此代理/监控读配置的代码完全不需要知道密钥存在哪里。
 */
function createConfigManager() {
  const mgr = new ConfigManager(path.join(getDataDir(), 'config.yaml'))
  mgr.setSecretResolver(id => {
    try { return getSecretStore().getKey(id) } catch { return '' }
  })
  return mgr
}

function getConfigManager() { return createConfigManager() }

/** FIX-13：safeStorage（Windows 走 DPAPI）加密存储 API Key */
function getSecretStore() {
  if (secretStore) return secretStore
  secretStore = createSecretStore({
    dataDir: getDataDir(),
    configManager: createConfigManager(),
    safeStorage,
    allowPlaintextFallback: true,
    logger: { log: console.log, warn: m => recordSecurityEvent('warn', m), error: m => recordSecurityEvent('error', m) },
  })
  return secretStore
}

/**
 * FIX-13：交给渲染进程的配置必须脱敏。
 * api_key 换成掩码 + has_api_key 标记，渲染层永远拿不到明文。
 */
function sanitizeConfigForRenderer(cfg) {
  const clone = JSON.parse(JSON.stringify(cfg || {}))
  const store = getSecretStore()
  const providers = clone.providers || {}
  for (const [id, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== 'object') continue
    const plain = (provider.api_key || '') || (() => { try { return store.getKey(id) } catch { return '' } })()
    const hasKey = Boolean(plain) || (() => { try { return store.hasKey(id) } catch { return false } })()
    delete provider.api_key
    provider.has_api_key = hasKey
    provider.api_key = hasKey ? store.maskKey(plain || '••••••••') : ''
  }
  if (clone.proxy) delete clone.proxy.local_token
  return clone
}

/**
 * FIX-13：保存配置时把密钥收进加密库，配置文件里不留明文。
 *  - 输入框里还是掩码 → 视为「未修改」，保留原密钥；
 *  - 输入框里是新明文 → 写入密钥库，配置里只写 api_key_ref: 'secret'；
 *  - 输入框被清空 → 删除该 provider 的密钥。
 */
function absorbSecretsFromConfig(incoming) {
  const result = absorbConfigSecrets(incoming, getSecretStore())
  if (result.cleared.length > 0) {
    recordSecurityEvent('warn', `以下 provider 的 API Key 未能加密保存，已清空以免明文落盘：${result.cleared.join(', ')}`)
  }
  return result.config
}

function sendToUI(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send(channel, payload) } catch { /* 窗口正在销毁 */ }
  }
}

function getContextFilePath() {
  const cfgMgr = getConfigManager()
  const workspace = cfgMgr.getWorkspace()
  const ctxCfg = cfgMgr.getContextConfig()
  return workspace ? path.join(workspace, ctxCfg.output_file || 'full_context.txt') : (ctxCfg.output_file || 'full_context.txt')
}

async function rebuildContext() {
  const cfgMgr = getConfigManager()
  const workspace = cfgMgr.getWorkspace()
  if (!workspace) return { success: false, error: '未选择项目' }
  const ctxCfg = cfgMgr.getContextConfig()
  const scanner = new CodeScanner(workspace, { ...cfgMgr.getScannerConfig(), ...ctxCfg })
  const result = await scanner.buildContext(path.join(workspace, ctxCfg.output_file || 'full_context.txt'), {
    format: ctxCfg.format,
    maxTokens: ctxCfg.max_tokens,
    enforceBudget: ctxCfg.enforce_budget !== false,
    summarizeSkipped: ctxCfg.summarize_skipped !== false,
    summaryLines: ctxCfg.summary_lines,
  })
  return { success: true, ...result }
}

// FIX-05：把 context.watch_enabled / debounce_seconds 真正接上（原先这两个配置项是死旋钮）
async function startContextWatcher() {
  await stopContextWatcher()
  const cfgMgr = getConfigManager()
  const workspace = cfgMgr.getWorkspace()
  const ctxCfg = cfgMgr.getContextConfig()
  if (!workspace) return { started: false, error: '未选择项目' }
  if (ctxCfg.watch_enabled === false) return { started: false, error: 'watch_enabled=false' }
  contextWatcher = new ContextWatcher({
    rootDir: workspace,
    debounceSeconds: ctxCfg.debounce_seconds,
    onRebuild: async (changedPath) => {
      try {
        const result = await rebuildContext()
        sendToUI('context-updated', { changedPath, ...result })
      } catch (e) {
        sendToUI('context-updated', { changedPath, success: false, error: e.message })
      }
    },
    onError: (err) => sendToUI('proxy-log', { type: 'error', method: 'WATCH', path: '/watch', provider: 'local', error: err.message, status: 0, responseTime: 0 }),
  })
  const r = await contextWatcher.start()
  if (!r.started) { contextWatcher = null }
  return r
}

async function stopContextWatcher() {
  if (!contextWatcher) return
  const w = contextWatcher
  contextWatcher = null
  try { await w.stop() } catch { /* 关闭失败不影响退出 */ }
}

function getDataDir() { const p = app.getPath('userData'); if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); return p }

function getIconPath() {
  return !app.isPackaged
    ? path.join(__dirname, '..', '..', 'resources', 'icon.png')
    : path.join(process.resourcesPath, 'resources', 'icon.png')
}

function getBackgroundPath() {
  return !app.isPackaged
    ? path.join(__dirname, '..', '..', 'resources', 'background.jpg')
    : path.join(process.resourcesPath, 'resources', 'background.jpg')
}

function loadConfig() {
  const configPath = path.join(getDataDir(), 'config.yaml')
  try {
    if (fs.existsSync(configPath)) { config = yaml.load(fs.readFileSync(configPath, 'utf8')) || {} }
    else {
      const exPath = !app.isPackaged
        ? path.join(__dirname, '..', '..', 'config.yaml.example')
        : path.join(process.resourcesPath, 'config.yaml.example')
      if (fs.existsSync(exPath)) { config = yaml.load(fs.readFileSync(exPath, 'utf8')) || {}; fs.writeFileSync(configPath, fs.readFileSync(exPath, 'utf8'), 'utf8') }
    }
  } catch (e) { console.error('Failed to load config:', e) }
  return config
}

function saveConfig(newConfig) {
  const configPath = path.join(getDataDir(), 'config.yaml')
  try {
    // FIX-13：先把密钥收进加密库，再落盘，保证配置文件里永远没有明文 Key
    const sanitized = absorbSecretsFromConfig(JSON.parse(JSON.stringify(newConfig || {})))
    fs.writeFileSync(configPath, yaml.dump(sanitized, { lineWidth: -1 }), 'utf8')
    config = sanitized
    return true
  } catch (e) { console.error('Failed to save config:', e); return false }
}

async function startProxy(port = DEFAULT_PROXY_PORT) {
  if (proxyServer) return { success: false, error: 'Proxy already running' }
  const cfgPath = path.join(getDataDir(), 'config.yaml')
  // FIX-13：带密钥解析器的 ConfigManager，代理无需感知密钥存放位置
  const cfgMgr = createConfigManager()
  // FIX-02：proxy.host 原先被硬编码成回环，设置里的主机地址是死旋钮；
  // 现在按配置生效，非回环地址会在启动时返回强告警。
  proxyHost = cfgMgr.getProxyConfig().host || DEFAULT_PROXY_HOST
  const workspace = cfgMgr.getWorkspace()
  const contextFile = getContextFilePath()
  let contextResult = null
  if (workspace) {
    try { contextResult = await rebuildContext() } catch (e) { console.error('Context build failed:', e.message) }
  }

  const monitorCfg = cfgMgr.getMonitorConfig()
  const logCfg = cfgMgr.getRequestLogConfig()
  // FIX-12：明细保留策略（默认 90 天），聚合数据不删
  tokenMonitor = new TokenMonitor({
    dbPath: path.join(getDataDir(), 'contextgate.db'),
    retentionDays: monitorCfg.retention_days,
    logRetentionDays: logCfg.retention_days,
  })
  await tokenMonitor._ensureReady().catch(() => {})
  budgetGuard = new BudgetGuard({
    configManager: getConfigManager(),
    getSpent: () => (tokenMonitor ? tokenMonitor.getTodayCostSync() : 0),
    onLevelChange: state => sendToUI('budget-alert', state),
  })

  _proxyEventUnsubs = [
    eventBus.on('request:complete', async data => {
      try { await tokenMonitor?.recordRequest(data) } catch (e) { console.error('recordRequest failed:', e.message) }
      try { budgetGuard?.notify() } catch (e) { console.error('budget check failed:', e.message) }
    }),
    eventBus.on('request:log', data => sendToUI('proxy-log', data)),
  ]

  const proxy = new ProxyServer({
    contextFile, configPath: cfgPath, projectRoot: workspace, dataDir: getDataDir(),
    eventBus, budgetGuard, configManager: cfgMgr,
  })
  try {
    const result = await proxy.start(proxyHost, port)
    proxyServer = proxy; isProxyRunning = true; proxyPort = result.port
    const watch = await startContextWatcher()
    startMaintenance(proxy)
    updateTrayMenu()
    return {
      success: true, port: result.port, host: proxyHost,
      token: result.token, authEnabled: result.authEnabled,
      cachePersist: result.cachePersist, requestLogEnabled: result.requestLogEnabled,
      warnings: result.warnings || [],
      context: contextResult ? { fileCount: contextResult.fileCount, estimatedTokens: contextResult.estimatedTokens, skippedCount: contextResult.skippedCount } : null,
      watch,
    }
  } catch (e) {
    proxy.stop(); proxyServer = null
    if (tokenMonitor) { tokenMonitor.close(); tokenMonitor = null }
    budgetGuard = null
    return { success: false, error: e.message }
  }
}

// FIX-09/FIX-12：定期清理过期缓存条目与过老的请求明细，避免长期运行无限增长
function startMaintenance(proxy) {
  stopMaintenance()
  const run = () => { proxy.maintenance().catch(e => console.warn('[maintenance] 失败:', e.message)) }
  setTimeout(run, 10000).unref?.()
  maintenanceTimer = setInterval(run, 60 * 60 * 1000)
  if (maintenanceTimer.unref) maintenanceTimer.unref()
}

function stopMaintenance() {
  if (maintenanceTimer) { clearInterval(maintenanceTimer); maintenanceTimer = null }
}

async function stopProxy() {
  const wasRunning = !!proxyServer
  stopMaintenance()
  await stopContextWatcher()
  if (proxyServer) {
    try { await proxyServer.stop() } catch {}
    proxyServer = null; isProxyRunning = false
  }
  if (tokenMonitor) { tokenMonitor.close(); tokenMonitor = null }
  budgetGuard = null
  for (const unsub of _proxyEventUnsubs) { try { unsub() } catch {} }
  _proxyEventUnsubs = []
  updateTrayMenu()
  // 通知渲染进程代理已停止（含从托盘/退出流程触发的情况），保持 UI 状态同步
  if (wasRunning && mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('proxy-stopped') } catch {}
  }
  return wasRunning ? { success: true } : { success: false, error: 'Proxy not running' }
}

function createWindow() {
  const { screen } = require('electron')
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const opts = {
    width: Math.min(1280, Math.round(width * 0.8)), height: Math.min(800, Math.round(height * 0.8)),
    minWidth: 800, minHeight: 600, backgroundColor: '#19191e', show: false, icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // FIX-S1：显式开启沙箱与上下文隔离（不再依赖默认值）
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      spellcheck: false,
    },
  }
  if (isLinux) { opts.frame = true; opts.title = 'ContextGate' }
  else if (isMac) { opts.titleBarStyle = 'hiddenInset' }
  else { opts.frame = false }
  mainWindow = new BrowserWindow(opts)
  mainWindow.center()
  mainWindow.loadFile(path.join(__dirname, 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())
  if (isLinux) mainWindow.on('close', () => cleanupAndQuit())
  else mainWindow.on('close', e => { e.preventDefault(); mainWindow.hide() })
}

async function cleanupAndQuit() { await stopProxy(); if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; mainWindow = null; app.quit() }

function createTray() {
  let icon = nativeImage.createFromPath(getIconPath())
  if (isLinux && icon.getSize().width > 24) icon = icon.resize({ width: 24, height: 24 })
  tray = new Tray(icon); tray.setToolTip('ContextGate'); updateTrayMenu()
  const handler = isLinux ? 'click' : 'double-click'
  tray.on(handler, () => { if (mainWindow) { mainWindow.isVisible() ? mainWindow.hide() : (mainWindow.show(), mainWindow.focus()) } })
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return
  const template = [
    { label: '显示窗口', click: () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus() } } },
    { type: 'separator' },
    { label: isProxyRunning ? '停止代理' : '启动代理', click: () => isProxyRunning ? stopProxy() : startProxy(proxyPort) },
    { type: 'separator' },
    { label: '退出', click: () => { stopProxy(); if (!isLinux && mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy(); app.quit() } },
  ]
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(() => {
  // FIX-12：第二个实例直接退出，不要创建窗口/托盘/数据库连接
  if (!gotSingleInstanceLock) return
  // FIX-13：把历史版本遗留在 config.yaml 里的明文 Key 迁进 safeStorage 加密库
  try {
    const migrated = getSecretStore().migrateFromConfig()
    if (migrated.migrated.length > 0) {
      console.log(`[security] 已把 ${migrated.migrated.length} 个 provider 的明文 API Key 迁入加密存储（backend=${migrated.backend}）`)
    }
    if (migrated.backend === 'plaintext') {
      recordSecurityEvent('warn', '当前环境没有可用的 safeStorage，API Key 只能以明文方式保存在 secrets.json 中。')
    }
  } catch (e) { recordSecurityEvent('error', `密钥迁移失败: ${e.message}`) }
  // FIX-S1：导航/弹窗/webview 白名单 + 默认拒绝所有权限请求
  navigationPolicy = createNavigationPolicy({
    appDir: __dirname,
    allowedExternalHosts: new ConfigManager(path.join(getDataDir(), 'config.yaml')).get('security.allowed_external_hosts'),
    isDev: !app.isPackaged,
  })
  navigationGuards = installNavigationGuards({
    app, shell, policy: navigationPolicy,
    logger: { warn: m => recordSecurityEvent('warn', m), error: m => recordSecurityEvent('error', m) },
  })
  if (session && session.defaultSession) navigationGuards.applyPermissionHandler(session.defaultSession)

  loadConfig()
  createWindow()
  createTray()
  const problems = auditSandboxConfiguration()
  for (const p of problems) recordSecurityEvent('error', p)

  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
})
let _quitting = false
app.on('window-all-closed', () => { if (isLinux) cleanupAndQuit(); else if (!isMac) app.quit() })
app.on('before-quit', async (e) => { if (_quitting) return; _quitting = true; e.preventDefault(); stopMaintenance(); await stopProxy(); app.exit(0) })

ipcMain.handle('get-platform', () => ({ os: process.platform, isLinux, isMac, isWin, usesFrame: isLinux }))

// preload 在页面加载时上报渲染进程的真实沙箱状态（FIX-S1 的运行时验收点）
ipcMain.on('renderer-security-report', (event, report) => {
  // 只接受本应用主窗口主框架的上报，避免其它 webContents 伪造「沙箱已启用」
  const sender = event?.sender
  const isMainFrame = event?.senderFrame ? event.senderFrame === event.sender?.mainFrame : true
  if (!mainWindow || mainWindow.isDestroyed() || sender !== mainWindow.webContents || !isMainFrame) {
    recordSecurityEvent('warn', '忽略来自非主窗口的渲染进程安全上报')
    return
  }
  rendererSecurityReport = report && typeof report === 'object'
    ? { sandboxed: report.sandboxed === true, contextIsolated: report.contextIsolated === true, hasNodeRequire: report.hasNodeRequire === true, reportedAt: report.reportedAt }
    : null
  for (const problem of auditSandboxConfiguration()) recordSecurityEvent('error', problem)
})

ipcMain.handle('get-security-status', () => {
  const cfgMgr = getConfigManager()
  const proxyCfg = cfgMgr.getProxyConfig()
  const authCfg = cfgMgr.getAuthConfig()
  const problems = auditSandboxConfiguration()
  return {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    packaged: app.isPackaged,
    main: {
      sandboxFlagsPresent: ['no-sandbox', 'disable-setuid-sandbox', 'disable-gpu-sandbox'].filter(f => app.commandLine.hasSwitch(f)),
      enableSandboxCalled: true,
    },
    renderer: rendererSecurityReport,
    proxy: {
      host: proxyCfg.host,
      authEnabled: authCfg.enabled !== false,
      hostCheck: authCfg.host_check !== false,
      allowInsecureTls: cfgMgr.get('security.allow_insecure_tls') === true,
      providersRequestingInsecureTls: proxyServer ? proxyServer.providersRequestingInsecureTls() : [],
    },
    navigation: {
      guardsInstalled: navigationGuards !== null,
      allowedExternalHosts: navigationPolicy ? navigationPolicy.allowedExternalHosts() : [],
    },
    telemetry: { crashReporting: false, analytics: false },
    problems,
    events: securityEvents.slice(-20),
  }
})
// FIX-13：渲染进程永远拿不到明文 API Key（只给掩码 + has_api_key）
ipcMain.handle('get-config', () => sanitizeConfigForRenderer(loadConfig()))
ipcMain.handle('save-config', (_, newConfig) => {
  const ok = saveConfig(newConfig)
  // 配置变更后重新评估预算、降级链与文件监视
  if (ok && budgetGuard) { try { budgetGuard.notify() } catch {} }
  if (ok && proxyServer) { try { proxyServer.refreshResilience() } catch {} }
  return ok
})
// FIX-13：密钥状态的只读视图（绝不含明文）
ipcMain.handle('get-secrets-status', () => {
  const store = getSecretStore()
  let view = { providers: [] }
  try { view = store.export() } catch { /* 读取失败时返回空视图 */ }
  return { ...view, maskSample: store.maskKey('sk-1234567890abcdef') }
})
ipcMain.handle('delete-provider-key', (_, providerId) => {
  if (!providerId || typeof providerId !== 'string') return { success: false, error: '缺少 provider 名称' }
  const store = getSecretStore()
  let removed = false
  try { removed = store.deleteKey(providerId) } catch (e) { recordSecurityEvent('error', `删除密钥失败: ${e.message}`) }
  // 注意：这里必须用「不带密钥解析器」的 ConfigManager，
  // 否则 getProvider() 会把刚删掉的密钥又注回内存配置里。
  try {
    const raw = new ConfigManager(path.join(getDataDir(), 'config.yaml'))
    const provider = (raw.config.providers || {})[providerId]
    if (provider) {
      provider.api_key = ''
      delete provider.api_key_ref
      raw.save()
    }
  } catch (e) { recordSecurityEvent('warn', `清理 api_key_ref 失败: ${e.message}`) }
  return { success: true, removed }
})
/**
 * FIX-13 / FIX-11：获取模型列表。
 *
 * 原来由渲染进程直接带着明文 Key 请求代理（fetch + X-Target-Base-Url）：
 * 渲染层一旦拿不到明文（正是 FIX-13 的目标），这条路就断了，而且 Key 会暴露在页面里。
 * 现在改为主进程代劳：Key 从加密库/环境变量解析，渲染层只拿到模型 ID 列表。
 */
ipcMain.handle('fetch-models', async (_, payload = {}) => {
  const providerId = typeof payload.providerId === 'string' ? payload.providerId : ''
  const baseUrl = typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : ''
  if (!baseUrl) return { success: false, error: '请先填写基础 URL' }
  let parsed
  try { parsed = new URL(baseUrl) } catch { return { success: false, error: '基础 URL 不是合法 URL' } }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { success: false, error: '基础 URL 必须使用 http 或 https' }
  if (parsed.username || parsed.password) return { success: false, error: '基础 URL 不能内嵌用户名/密码' }

  const { buildForwardHeaders, sendUpstream, joinUrl, resolveEnvApiKey } = require('./lib/proxy/forwarder')
  const { normalizeGeminiBaseUrl } = require('./lib/proxy/protocol')
  const { BUILTIN_PROVIDERS } = require('./lib/proxy/provider-registry')
  const store = getSecretStore()
  const supplied = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : ''
  let storedKey = ''
  try { storedKey = providerId ? (store.getKey(providerId) || '') : '' } catch { storedKey = '' }
  // 掩码原样回传时按「未修改」处理，用加密库里的真 Key
  const isMask = supplied.length > 0 && storedKey.length > 0 && supplied === store.maskKey(storedKey)
  const providerConfig = { format: 'openai', base_url: baseUrl }
  const envKey = resolveEnvApiKey({ env: BUILTIN_PROVIDERS[providerId]?.env || [] })
  const apiKey = (!supplied || isMask) ? (storedKey || envKey) : supplied
  try {
    const response = await sendUpstream({
      providerConfig, method: 'GET',
      url: joinUrl(normalizeGeminiBaseUrl(baseUrl), 'models'),
      headers: buildForwardHeaders(providerConfig, apiKey, {}, {}),
    })
    const list = response.data?.data || response.data?.models || []
    const models = list.map(m => m.id || m.model || m.name).filter(Boolean)
    return { success: true, models }
  } catch (e) {
    return { success: false, error: e.response?.status ? ('HTTP ' + e.response.status) : e.message }
  }
})

ipcMain.handle('select-folder', async () => {
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  const result = parent
    ? await dialog.showOpenDialog(parent, { properties: ['openDirectory'] })
    : await dialog.showOpenDialog({ properties: ['openDirectory'] })
  return result.filePaths[0] || null
})
ipcMain.handle('get-background-url', () => `file://${getBackgroundPath()}`)
ipcMain.handle('get-locale', () => app.getLocale())
ipcMain.handle('window-minimize', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize() })
ipcMain.handle('window-maximize', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize() })
ipcMain.handle('window-close', () => isLinux ? cleanupAndQuit() : (mainWindow && !mainWindow.isDestroyed() && mainWindow.hide()))
ipcMain.handle('window-show', () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus() } })
ipcMain.handle('quit-app', () => cleanupAndQuit())
ipcMain.handle('start-proxy', async (_, port) => startProxy(port || DEFAULT_PROXY_PORT))
ipcMain.handle('stop-proxy', async () => stopProxy())
ipcMain.handle('proxy-status', () => ({ running: isProxyRunning, port: proxyPort, host: proxyHost }))
ipcMain.handle('build-context', async (_, projectPath) => {
  try {
    const cfgMgr = getConfigManager()
    if (projectPath) cfgMgr.setWorkspace(projectPath)
    const result = await rebuildContext()
    if (result.success && proxyServer) { try { await startContextWatcher() } catch {} }
    return result
  } catch (e) { return { success: false, error: e.message } }
})
ipcMain.handle('get-stats', async () => {
  const summary = tokenMonitor
    ? await tokenMonitor.getSummary()
    : await (async () => { const m = new TokenMonitor({ dbPath: path.join(getDataDir(), 'contextgate.db') }); try { return await m.getSummary() } finally { await m.close() } })()
  const cfgMgr = getConfigManager()
  const spent = tokenMonitor ? tokenMonitor.getTodayCostSync() : (summary.today?.cost || 0)
  const budget = require('./lib/monitor/budget').evaluateBudget(spent, cfgMgr.getMonitorConfig())
  return { ...summary, budget }
})
ipcMain.handle('get-local-token', () => {
  const cfgMgr = getConfigManager()
  return { token: cfgMgr.get('proxy.local_token', null), enabled: cfgMgr.get('proxy.auth.enabled') !== false }
})
ipcMain.handle('rotate-local-token', () => {
  if (!proxyServer) return { success: false, error: '代理未运行' }
  return { success: true, token: proxyServer.rotateLocalToken() }
})
ipcMain.handle('read-context-file', async () => {
  const file = getContextFilePath()
  try {
    if (!fs.existsSync(file)) return { success: false, error: '上下文文件不存在，请先构建' }
    const content = await fs.promises.readFile(file, 'utf8')
    const manifestPath = file + '.manifest.json'
    let manifest = null
    try { if (fs.existsSync(manifestPath)) manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) } catch {}
    return { success: true, path: file, content, manifest, size: Buffer.byteLength(content, 'utf8') }
  } catch (e) { return { success: false, error: e.message } }
})
ipcMain.handle('copy-to-clipboard', (_, text) => {
  try { clipboard.writeText(String(text ?? '')); return { success: true } }
  catch (e) { return { success: false, error: e.message } }
})
ipcMain.handle('reveal-path', (_, target) => {
  try { if (target && fs.existsSync(target)) shell.showItemInFolder(target); return { success: true } }
  catch (e) { return { success: false, error: e.message } }
})
ipcMain.handle('get-memory-usage', () => { const m = process.memoryUsage(); return { heapUsed: Math.round(m.heapUsed / 1024 / 1024), heapTotal: Math.round(m.heapTotal / 1024 / 1024), rss: Math.round(m.rss / 1024 / 1024) } })
