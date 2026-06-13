const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getBackgroundUrl: () => ipcRenderer.invoke('get-background-url'),
  getLocale: () => ipcRenderer.invoke('get-locale'),
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window-maximize'),
  closeWindow: () => ipcRenderer.invoke('window-close'),
  showWindow: () => ipcRenderer.invoke('window-show'),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  startProxy: (port) => ipcRenderer.invoke('start-proxy', port),
  stopProxy: () => ipcRenderer.invoke('stop-proxy'),
  proxyStatus: () => ipcRenderer.invoke('proxy-status'),
  buildContext: (projectPath) => ipcRenderer.invoke('build-context', projectPath),
  getStats: () => ipcRenderer.invoke('get-stats'),
  getMemoryUsage: () => ipcRenderer.invoke('get-memory-usage'),
  onProxyLog: (cb) => ipcRenderer.on('proxy-log', (_, data) => cb(data)),
  onProxyStopped: (cb) => ipcRenderer.on('proxy-stopped', () => cb()),
  removeProxyListeners: () => { ipcRenderer.removeAllListeners('proxy-log'); ipcRenderer.removeAllListeners('proxy-stopped') },
})
