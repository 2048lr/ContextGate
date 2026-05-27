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
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true })
}
app.setPath('temp', tmpDir)
process.env.TMPDIR = tmpDir
process.env.TMP = tmpDir
process.env.TEMP = tmpDir

const { CodeScanner } = require('./lib/scanner')
const { AIProxy, ConfigManager } = require('./lib/proxy')
const { TokenMonitor } = require('./lib/monitor')
const { DEFAULT_PROXY_HOST, DEFAULT_PROXY_PORT } = require('./lib/config')

const isLinux = process.platform === 'linux'
const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

let mainWindow = null
let tray = null
let config = {}
let proxyServer = null
let proxyPort = DEFAULT_PROXY_PORT
let proxyHost = DEFAULT_PROXY_HOST
let isProxyRunning = false
let tokenMonitor = null

function isCLIMode() {
  const args = process.argv.slice(1)
  return args.some(arg => ['build', 'serve', 'stats', 'scan'].includes(arg))
}

function getIconPath() {
  const isDev = !app.isPackaged
  return isDev
    ? path.join(__dirname, '..', '..', 'resources', 'icon.png')
    : path.join(process.resourcesPath, 'resources', 'icon.png')
}

function getBackgroundPath() {
  const isDev = !app.isPackaged
  return isDev
    ? path.join(__dirname, '..', '..', 'resources', 'background.jpg')
    : path.join(process.resourcesPath, 'resources', 'background.jpg')
}

function getDataDir() {
  const p = app.getPath('userData')
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true })
  return p
}

function loadConfig() {
  const configPath = path.join(getDataDir(), 'config.yaml')
  try {
    if (fs.existsSync(configPath)) {
      config = yaml.load(fs.readFileSync(configPath, 'utf8')) || {}
    } else {
      const isDev = !app.isPackaged
      const examplePath = isDev
        ? path.join(__dirname, '..', '..', 'config.yaml.example')
        : path.join(process.resourcesPath, 'config.yaml.example')
      if (fs.existsSync(examplePath)) {
        config = yaml.load(fs.readFileSync(examplePath, 'utf8')) || {}
        fs.writeFileSync(configPath, fs.readFileSync(examplePath, 'utf8'), 'utf8')
      }
    }
  } catch (e) {
    console.error('Failed to load config:', e)
  }
  return config
}

function saveConfig(newConfig) {
  const configPath = path.join(getDataDir(), 'config.yaml')
  try {
    fs.writeFileSync(configPath, yaml.dump(newConfig, { lineWidth: -1 }), 'utf8')
    config = newConfig
    return true
  } catch (e) {
    console.error('Failed to save config:', e)
    return false
  }
}

async function startProxy(port = DEFAULT_PROXY_PORT) {
  if (proxyServer) return { success: false, error: 'Proxy already running' }

  proxyPort = port
  const configManager = new ConfigManager(path.join(getDataDir(), 'config.yaml'))
  const workspace = configManager.getWorkspace()
  const contextFile = workspace ? path.join(workspace, 'full_context.txt') : 'full_context.txt'

  if (workspace) {
    const scanner = new CodeScanner(workspace)
    await scanner.buildContext(contextFile)
  }

  tokenMonitor = new TokenMonitor({ dbPath: path.join(getDataDir(), 'contextgate.db') })

  const proxy = new AIProxy({
    contextFile,
    configPath: path.join(getDataDir(), 'config.yaml'),
    projectRoot: workspace,
    onRequestComplete: (data) => tokenMonitor && tokenMonitor.recordRequest(data),
    onRequestLog: (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('proxy-log', data)
      }
    }
  })

  try {
    const result = await proxy.run(proxyHost, port)
    proxyServer = proxy
    isProxyRunning = true
    proxyPort = result.port

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('proxy-log', `代理服务器已启动在端口 ${result.port}`)
    }
    updateTrayMenu()
    return { success: true, port: result.port, host: proxyHost }
  } catch (e) {
    proxy.stop()
    proxyServer = null
    if (tokenMonitor) { tokenMonitor.close(); tokenMonitor = null }
    return { success: false, error: e.message }
  }
}

function stopProxy() {
  let wasRunning = false
  if (proxyServer) {
    wasRunning = true
    try { proxyServer.stop() } catch (e) { console.error('Error stopping proxy:', e) }
    proxyServer = null
    isProxyRunning = false
  }
  if (tokenMonitor) { tokenMonitor.close(); tokenMonitor = null }
  updateTrayMenu()
  return wasRunning ? { success: true } : { success: false, error: 'Proxy not running' }
}

function checkProxyStatus() {
  return { running: isProxyRunning, port: proxyPort, host: proxyHost }
}

async function buildContext(projectPath) {
  try {
    const scanner = new CodeScanner(projectPath)
    const { fileCount, totalChars, estimatedTokens, outputPath } = await scanner.buildContext()
    const configManager = new ConfigManager(path.join(getDataDir(), 'config.yaml'))
    configManager.setWorkspace(projectPath)
    return { success: true, fileCount, totalChars, estimatedTokens, outputPath }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

function createWindow() {
  const { screen } = require('electron')
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width, height } = primaryDisplay.workAreaSize

  const iconPath = getIconPath()
  const windowOpts = {
    width: Math.min(1280, Math.round(width * 0.8)),
    height: Math.min(800, Math.round(height * 0.8)),
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#19191e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: iconPath,
    show: false
  }

  if (isLinux) {
    windowOpts.frame = true
    windowOpts.title = 'ContextGate'
    windowOpts.type = 'normal'
  } else if (isMac) {
    windowOpts.frame = false
    windowOpts.transparent = false
    windowOpts.titleBarStyle = 'hiddenInset'
  } else {
    windowOpts.frame = false
    windowOpts.transparent = false
  }

  mainWindow = new BrowserWindow(windowOpts)
  mainWindow.center()
  mainWindow.loadFile(path.join(__dirname, 'index.html'))

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  if (isLinux) {
    mainWindow.on('close', () => {
      cleanupAndQuit()
    })
  } else {
    mainWindow.on('close', (event) => {
      event.preventDefault()
      mainWindow.hide()
    })
  }
}

function cleanupAndQuit() {
  stopProxy()
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
  mainWindow = null
  app.quit()
}

function createTray() {
  const iconPath = getIconPath()
  let icon
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath)
    if (isLinux && icon.getSize().width > 24) {
      icon = icon.resize({ width: 24, height: 24 })
    }
  } else {
    icon = nativeImage.createEmpty()
  }

  tray = new Tray(icon)
  tray.setToolTip('ContextGate')

  updateTrayMenu()

  if (isLinux) {
    tray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.hide()
        } else {
          mainWindow.show()
          mainWindow.focus()
        }
      }
    })
  } else {
    tray.on('double-click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.hide()
        } else {
          mainWindow.show()
          mainWindow.focus()
        }
      }
    })
  }
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return

  const template = [
    { label: '显示窗口', click: () => { mainWindow.show(); mainWindow.focus() } },
    { type: 'separator' },
    {
      label: isProxyRunning ? '停止代理' : '启动代理',
      click: () => {
        if (isProxyRunning) {
          stopProxy()
        } else {
          startProxy(proxyPort)
        }
      }
    },
    { type: 'separator' }
  ]

  if (isLinux) {
    template.push({ label: '退出', click: () => cleanupAndQuit() })
  } else {
    template.push({ label: '隐藏窗口', click: () => mainWindow.hide() })
    template.push({ type: 'separator' })
    template.push({
      label: '退出',
      click: () => { stopProxy(); mainWindow.destroy(); app.quit() }
    })
  }

  tray.setContextMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(() => {
  loadConfig()
  createWindow()
  if (!isLinux || process.env.XDG_CURRENT_DESKTOP !== 'GNOME') {
    createTray()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (isLinux) {
    cleanupAndQuit()
  } else if (!isMac && !isCLIMode()) {
    app.quit()
  }
})

app.on('before-quit', () => {
  stopProxy()
})

ipcMain.handle('get-platform', () => ({
  os: process.platform,
  isLinux,
  isMac,
  isWin,
  usesFrame: isLinux
}))

ipcMain.handle('get-config', () => loadConfig())
ipcMain.handle('save-config', (event, newConfig) => saveConfig(newConfig))

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
  return result.filePaths[0] || null
})

ipcMain.handle('get-background-url', () => `file://${getBackgroundPath()}`)
ipcMain.handle('get-locale', () => app.getLocale())

ipcMain.handle('window-minimize', () => mainWindow.minimize())
ipcMain.handle('window-maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})
ipcMain.handle('window-close', () => {
  if (isLinux) cleanupAndQuit()
  else mainWindow.hide()
})
ipcMain.handle('window-show', () => { mainWindow.show(); mainWindow.focus() })
ipcMain.handle('quit-app', () => cleanupAndQuit())

ipcMain.handle('start-proxy', async (event, port) => startProxy(port || DEFAULT_PROXY_PORT))
ipcMain.handle('stop-proxy', () => stopProxy())
ipcMain.handle('proxy-status', () => checkProxyStatus())
ipcMain.handle('build-context', async (event, projectPath) => buildContext(projectPath))

const ALLOWED_SCRIPTS = new Set(['scripts/build.sh', 'scripts/serve.sh', 'scripts/scan.sh', 'scripts/stats.sh'])
const ALLOWED_ACTIONS = /^[a-zA-Z0-9_-]+$/

ipcMain.handle('run-script', async (event, scriptPath, action) => {
  if (!ALLOWED_SCRIPTS.has(scriptPath)) return { success: false, error: 'Script not allowed' }
  if (!action || !ALLOWED_ACTIONS.test(action)) return { success: false, error: 'Invalid action' }

  const { exec } = require('child_process')
  const isDev = !app.isPackaged
  const scriptFullPath = isDev
    ? path.join(__dirname, '..', '..', scriptPath)
    : path.join(process.resourcesPath, scriptPath)

  const resolved = path.resolve(scriptFullPath)
  const allowedBase = isDev
    ? path.resolve(path.join(__dirname, '..', '..'))
    : path.resolve(process.resourcesPath)
  if (!resolved.startsWith(allowedBase)) return { success: false, error: 'Path traversal detected' }
  if (!fs.existsSync(scriptFullPath)) return { success: false, error: 'Script not found' }

  return new Promise((resolve) => {
    exec(`bash "${scriptFullPath}" ${action}`, (error, stdout, stderr) => {
      if (error) resolve({ success: false, error: error.message })
      else resolve({ success: true, output: stdout })
    })
  })
})

ipcMain.handle('get-stats', () => {
  if (!tokenMonitor) tokenMonitor = new TokenMonitor({ dbPath: path.join(getDataDir(), 'contextgate.db') })
  return tokenMonitor.getSummary()
})

ipcMain.handle('get-memory-usage', () => {
  const m = process.memoryUsage()
  return {
    heapUsed: Math.round(m.heapUsed / 1024 / 1024),
    heapTotal: Math.round(m.heapTotal / 1024 / 1024),
    rss: Math.round(m.rss / 1024 / 1024)
  }
})