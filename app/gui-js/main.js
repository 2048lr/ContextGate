const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, clipboard, shell, session } = require('electron')
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

function getConfigManager() { return new ConfigManager(path.join(getDataDir(), 'config.yaml')) }

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
  try { fs.writeFileSync(configPath, yaml.dump(newConfig, { lineWidth: -1 }), 'utf8'); config = newConfig; return true }
  catch (e) { console.error('Failed to save config:', e); return false }
}

async function startProxy(port = DEFAULT_PROXY_PORT) {
  if (proxyServer) return { success: false, error: 'Proxy already running' }
  const cfgPath = path.join(getDataDir(), 'config.yaml')
  const cfgMgr = new ConfigManager(cfgPath)
  // FIX-02：proxy.host 原先被硬编码成回环，设置里的主机地址是死旋钮；
  // 现在按配置生效，非回环地址会在启动时返回强告警。
  proxyHost = cfgMgr.getProxyConfig().host || DEFAULT_PROXY_HOST
  const workspace = cfgMgr.getWorkspace()
  const contextFile = getContextFilePath()
  let contextResult = null
  if (workspace) {
    try { contextResult = await rebuildContext() } catch (e) { console.error('Context build failed:', e.message) }
  }

  tokenMonitor = new TokenMonitor({ dbPath: path.join(getDataDir(), 'contextgate.db') })
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

  const proxy = new ProxyServer({ contextFile, configPath: cfgPath, projectRoot: workspace, dataDir: getDataDir(), eventBus, budgetGuard })
  try {
    const result = await proxy.start(proxyHost, port)
    proxyServer = proxy; isProxyRunning = true; proxyPort = result.port
    const watch = await startContextWatcher()
    updateTrayMenu()
    return {
      success: true, port: result.port, host: proxyHost,
      token: result.token, authEnabled: result.authEnabled,
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

async function stopProxy() {
  const wasRunning = !!proxyServer
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
app.on('before-quit', async (e) => { if (_quitting) return; _quitting = true; e.preventDefault(); await stopProxy(); app.exit(0) })

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
ipcMain.handle('get-config', () => loadConfig())
ipcMain.handle('save-config', (_, newConfig) => {
  const ok = saveConfig(newConfig)
  // 配置变更后重新评估预算与文件监视
  if (ok && budgetGuard) { try { budgetGuard.notify() } catch {} }
  return ok
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
    : await (async () => { const m = new TokenMonitor({ dbPath: path.join(getDataDir(), 'contextgate.db') }); try { return await m.getSummary() } finally { m.close() } })()
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
