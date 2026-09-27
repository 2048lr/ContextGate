const { contextBridge, ipcRenderer } = require('electron')

// FIX-S1：把渲染进程真实的沙箱/隔离状态回报给主进程，供启动自检与「安全状态」面板使用
try {
  ipcRenderer.send('renderer-security-report', {
    sandboxed: process.sandboxed,
    contextIsolated: process.contextIsolated,
    hasNodeRequire: typeof require === 'function',
    reportedAt: new Date().toISOString(),
  })
} catch { /* 上报失败不应影响界面 */ }

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
  getLocalToken: () => ipcRenderer.invoke('get-local-token'),
  rotateLocalToken: () => ipcRenderer.invoke('rotate-local-token'),
  readContextFile: () => ipcRenderer.invoke('read-context-file'),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
  revealPath: (target) => ipcRenderer.invoke('reveal-path', target),
  onProxyLog: (cb) => ipcRenderer.on('proxy-log', (_, data) => cb(data)),
  onProxyStopped: (cb) => ipcRenderer.on('proxy-stopped', () => cb()),
  getSecurityStatus: () => ipcRenderer.invoke('get-security-status'),
  getRendererSecurity: () => ({ sandboxed: process.sandboxed, contextIsolated: process.contextIsolated, electron: process.versions.electron, chrome: process.versions.chrome }),
  onBudgetAlert: (cb) => ipcRenderer.on('budget-alert', (_, data) => cb(data)),
  onContextUpdated: (cb) => ipcRenderer.on('context-updated', (_, data) => cb(data)),
  removeProxyListeners: () => {
    ipcRenderer.removeAllListeners('proxy-log')
    ipcRenderer.removeAllListeners('proxy-stopped')
    ipcRenderer.removeAllListeners('budget-alert')
    ipcRenderer.removeAllListeners('context-updated')
  },
})
