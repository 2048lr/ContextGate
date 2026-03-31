const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const yaml = require('js-yaml')

const { CodeScanner } = require('./lib/scanner')
const { AIProxy, ConfigManager } = require('./lib/proxy')
const { TokenMonitor } = require('./lib/monitor')

let mainWindow = null
let tray = null
let config = {}
let proxyServer = null
let proxyPort = 8000
let isProxyRunning = false
let tokenMonitor = null

const BACKGROUND_URL = 'https://liurun.click/133084259_p4.jpg'

function getDataDir() {
  const isDev = !app.isPackaged
  if (isDev) {
    return path.join(__dirname, '..', '..')
  }
  const userDataPath = app.getPath('userData')
  if (!fs.existsSync(userDataPath)) {
    fs.mkdirSync(userDataPath, { recursive: true })
  }
  return userDataPath
}

function getProjectRoot() {
  return getDataDir()
}

function loadConfig() {
  const configPath = path.join(getDataDir(), 'config.yaml')
  try {
    if (fs.existsSync(configPath)) {
      const fileContents = fs.readFileSync(configPath, 'utf8')
      config = yaml.load(fileContents) || {}
    } else {
      const examplePath = path.join(process.resourcesPath, 'config.yaml.example')
      if (fs.existsSync(examplePath)) {
        const exampleContents = fs.readFileSync(examplePath, 'utf8')
        config = yaml.load(exampleContents) || {}
        fs.writeFileSync(configPath, exampleContents, 'utf8')
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
    const yamlStr = yaml.dump(newConfig, { lineWidth: -1 })
    fs.writeFileSync(configPath, yamlStr, 'utf8')
    config = newConfig
    return true
  } catch (e) {
    console.error('Failed to save config:', e)
    return false
  }
}

async function startProxy(port = 8000) {
  if (proxyServer) {
    return { success: false, error: 'Proxy already running' }
  }

  proxyPort = port
  const configManager = new ConfigManager(path.join(getDataDir(), 'config.yaml'))
  const workspace = configManager.getWorkspace()
  const contextFile = workspace ? path.join(workspace, 'full_context.txt') : 'full_context.txt'

  if (workspace) {
    const scanner = new CodeScanner(workspace)
    scanner.buildContext(contextFile)
  }

  const proxy = new AIProxy({
    contextFile,
    configPath: path.join(getDataDir(), 'config.yaml')
  })

  tokenMonitor = new TokenMonitor({ dbPath: path.join(getDataDir(), 'contextgate.db') })

  try {
    const result = await proxy.run('127.0.0.1', port)
    proxyServer = proxy
    isProxyRunning = true
    proxyPort = result.port

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('proxy-log', `代理服务器已启动在端口 ${result.port}`)
    }

    return { success: true, port: result.port }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

function stopProxy() {
  if (proxyServer) {
    try {
      proxyServer.stop()
    } catch (e) {
      console.error('Error stopping proxy:', e)
    }
    proxyServer = null
    isProxyRunning = false
    return { success: true }
  }
  return { success: false, error: 'Proxy not running' }
}

function checkProxyStatus() {
  return { running: isProxyRunning, port: proxyPort }
}

async function buildContext(projectPath) {
  try {
    const scanner = new CodeScanner(projectPath)
    const { fileCount, totalChars, estimatedTokens, outputPath } = scanner.buildContext()

    const configManager = new ConfigManager(path.join(getDataDir(), 'config.yaml'))
    configManager.setWorkspace(projectPath)

    return {
      success: true,
      fileCount,
      totalChars,
      estimatedTokens,
      outputPath
    }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

function createWindow() {
  const { screen } = require('electron')
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width, height } = primaryDisplay.workAreaSize

  const isDev = !app.isPackaged
  const iconPath = isDev 
    ? path.join(__dirname, '..', '..', 'resources', 'icon.png')
    : path.join(process.resourcesPath, 'resources', 'icon.png')

  mainWindow = new BrowserWindow({
    width: width,
    height: height,
    x: 0,
    y: 0,
    frame: false,
    transparent: false,
    backgroundColor: '#19191e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: iconPath,
    show: false
  })

  mainWindow.loadFile(path.join(__dirname, 'index.html'))

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize()
    mainWindow.show()
  })

  mainWindow.on('close', (event) => {
    event.preventDefault()
    mainWindow.hide()
    return false
  })
}

function createTray() {
  const isDev = !app.isPackaged
  const iconPath = isDev 
    ? path.join(__dirname, '..', '..', 'resources', 'icon.png')
    : path.join(process.resourcesPath, 'resources', 'icon.png')
  let icon
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath)
  } else {
    icon = nativeImage.createEmpty()
  }

  tray = new Tray(icon)

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        mainWindow.show()
        mainWindow.focus()
      }
    },
    {
      label: '隐藏窗口',
      click: () => {
        mainWindow.hide()
      }
    },
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
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        stopProxy()
        mainWindow.destroy()
        app.quit()
      }
    }
  ])

  tray.setToolTip('ContextGate')
  tray.setContextMenu(contextMenu)

  tray.on('double-click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide()
    } else {
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

app.whenReady().then(() => {
  loadConfig()
  createWindow()
  createTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  stopProxy()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  stopProxy()
})

ipcMain.handle('get-config', () => {
  return loadConfig()
})

ipcMain.handle('save-config', (event, newConfig) => {
  return saveConfig(newConfig)
})

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  })
  return result.filePaths[0] || null
})

ipcMain.handle('get-background-url', () => {
  return BACKGROUND_URL
})

ipcMain.handle('get-locale', () => {
  return app.getLocale()
})

ipcMain.handle('window-minimize', () => {
  mainWindow.minimize()
})

ipcMain.handle('window-maximize', () => {
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow.maximize()
  }
})

ipcMain.handle('window-close', () => {
  mainWindow.hide()
})

ipcMain.handle('window-show', () => {
  mainWindow.show()
  mainWindow.focus()
})

ipcMain.handle('quit-app', () => {
  stopProxy()
  mainWindow.destroy()
  app.quit()
})

ipcMain.handle('start-proxy', async (event, port) => {
  return await startProxy(port || 8000)
})

ipcMain.handle('stop-proxy', () => {
  return stopProxy()
})

ipcMain.handle('proxy-status', () => {
  return checkProxyStatus()
})

ipcMain.handle('build-context', async (event, projectPath) => {
  return await buildContext(projectPath)
})

ipcMain.handle('get-stats', () => {
  if (!tokenMonitor) {
    tokenMonitor = new TokenMonitor({ dbPath: path.join(getDataDir(), 'contextgate.db') })
  }
  return tokenMonitor.getSummary()
})
