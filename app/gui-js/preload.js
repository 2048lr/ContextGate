const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
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
  onProxyLog: (callback) => ipcRenderer.on('proxy-log', (event, data) => callback(data)),
  onProxyError: (callback) => ipcRenderer.on('proxy-error', (event, data) => callback(data)),
  onProxyStopped: (callback) => ipcRenderer.on('proxy-stopped', () => callback()),
  removeProxyListeners: () => {
    ipcRenderer.removeAllListeners('proxy-log')
    ipcRenderer.removeAllListeners('proxy-error')
    ipcRenderer.removeAllListeners('proxy-stopped')
  }
})
