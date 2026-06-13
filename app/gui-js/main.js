const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const yaml = require('js-yaml')

app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-setuid-sandbox')
app.commandLine.appendSwitch('disable-gpu-sandbox')
app.commandLine.appendSwitch('disable-dev-shm-usage')

const userDataPath = app.getPath('userData')
const tmpDir = path.join(userDataPath, 'tmp')
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
app.setPath('temp', tmpDir)
process.env.TMPDIR = process.env.TMP = process.env.TEMP = tmpDir

const { CodeScanner } = require('./lib/scanner/scanner')
const { ProxyServer } = require('./lib/proxy/proxy-server')
const { TokenMonitor } = require('./lib/monitor/token-monitor')
const { EventBus } = require('./lib/core/event-bus')
const { DEFAULT_PROXY_HOST, DEFAULT_PROXY_PORT } = require('./lib/core/constants')

const isLinux = process.platform === 'linux'
const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

let mainWindow = null, tray = null, config = {}
let proxyServer = null, proxyPort = DEFAULT_PROXY_PORT
const proxyHost = DEFAULT_PROXY_HOST
let isProxyRunning = false, tokenMonitor = null
const eventBus = new EventBus()

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
  const cfgMgr = new (require('./lib/core/config-manager').ConfigManager)(cfgPath)
  const workspace = cfgMgr.getWorkspace()
  const contextFile = workspace ? path.join(workspace, 'full_context.txt') : 'full_context.txt'
  if (workspace) { const scanner = new CodeScanner(workspace); await scanner.buildContext(contextFile) }

  tokenMonitor = new TokenMonitor({ dbPath: path.join(getDataDir(), 'contextgate.db') })
  eventBus.on('request:complete', data => tokenMonitor?.recordRequest(data))
  eventBus.on('request:log', data => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('proxy-log', data) })

  const proxy = new ProxyServer({ contextFile, configPath: cfgPath, projectRoot: workspace, dataDir: getDataDir(), eventBus })
  try {
    const result = await proxy.start(proxyHost, port)
    proxyServer = proxy; isProxyRunning = true; proxyPort = result.port
    updateTrayMenu()
    return { success: true, port: result.port, host: proxyHost }
  } catch (e) {
    proxy.stop(); proxyServer = null
    if (tokenMonitor) { tokenMonitor.close(); tokenMonitor = null }
    return { success: false, error: e.message }
  }
}

function stopProxy() {
  const wasRunning = !!proxyServer
  if (proxyServer) { try { proxyServer.stop() } catch {} proxyServer = null; isProxyRunning = false }
  if (tokenMonitor) { tokenMonitor.close(); tokenMonitor = null }
  eventBus.clear()
  updateTrayMenu()
  return wasRunning ? { success: true } : { success: false, error: 'Proxy not running' }
}

function createWindow() {
  const { screen } = require('electron')
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const opts = {
    width: Math.min(1280, Math.round(width * 0.8)), height: Math.min(800, Math.round(height * 0.8)),
    minWidth: 800, minHeight: 600, backgroundColor: '#19191e', show: false, icon: getIconPath(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
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

function cleanupAndQuit() { stopProxy(); if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; mainWindow = null; app.quit() }

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
    { label: '显示窗口', click: () => { mainWindow.show(); mainWindow.focus() } },
    { type: 'separator' },
    { label: isProxyRunning ? '停止代理' : '启动代理', click: () => isProxyRunning ? stopProxy() : startProxy(proxyPort) },
    { type: 'separator' },
    { label: '退出', click: () => { stopProxy(); if (!isLinux) mainWindow.destroy(); app.quit() } },
  ]
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(() => { loadConfig(); createWindow(); createTray(); app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() }) })
app.on('window-all-closed', () => { if (isLinux) cleanupAndQuit(); else if (!isMac) app.quit() })
app.on('before-quit', () => stopProxy())

ipcMain.handle('get-platform', () => ({ os: process.platform, isLinux, isMac, isWin, usesFrame: isLinux }))
ipcMain.handle('get-config', () => loadConfig())
ipcMain.handle('save-config', (_, newConfig) => saveConfig(newConfig))
ipcMain.handle('select-folder', async () => (await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })).filePaths[0] || null)
ipcMain.handle('get-background-url', () => `file://${getBackgroundPath()}`)
ipcMain.handle('get-locale', () => app.getLocale())
ipcMain.handle('window-minimize', () => mainWindow.minimize())
ipcMain.handle('window-maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize())
ipcMain.handle('window-close', () => isLinux ? cleanupAndQuit() : mainWindow.hide())
ipcMain.handle('window-show', () => { mainWindow.show(); mainWindow.focus() })
ipcMain.handle('quit-app', () => cleanupAndQuit())
ipcMain.handle('start-proxy', async (_, port) => startProxy(port || DEFAULT_PROXY_PORT))
ipcMain.handle('stop-proxy', () => stopProxy())
ipcMain.handle('proxy-status', () => ({ running: isProxyRunning, port: proxyPort, host: proxyHost }))
ipcMain.handle('build-context', async (_, projectPath) => {
  try {
    const scanner = new CodeScanner(projectPath)
    const { fileCount, totalChars, estimatedTokens, outputPath } = await scanner.buildContext()
    const cfgMgr = new (require('./lib/core/config-manager').ConfigManager)(path.join(getDataDir(), 'config.yaml'))
    cfgMgr.setWorkspace(projectPath)
    return { success: true, fileCount, totalChars, estimatedTokens, outputPath }
  } catch (e) { return { success: false, error: e.message } }
})
ipcMain.handle('get-stats', () => { if (!tokenMonitor) tokenMonitor = new TokenMonitor({ dbPath: path.join(getDataDir(), 'contextgate.db') }); return tokenMonitor.getSummary() })
ipcMain.handle('get-memory-usage', () => { const m = process.memoryUsage(); return { heapUsed: Math.round(m.heapUsed / 1024 / 1024), heapTotal: Math.round(m.heapTotal / 1024 / 1024), rss: Math.round(m.rss / 1024 / 1024) } })
