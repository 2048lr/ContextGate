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
  // FIX-13：模型列表由主进程代取，渲染层不再需要（也拿不到）明文 Key
  fetchModels: (payload) => ipcRenderer.invoke('fetch-models', payload),
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
  // FIX-13：密钥状态只读视图（绝不含明文），以及显式删除某个 provider 的密钥
  getSecretsStatus: () => ipcRenderer.invoke('get-secrets-status'),
  deleteProviderKey: (providerId) => ipcRenderer.invoke('delete-provider-key', providerId),
  getRendererSecurity: () => ({ sandboxed: process.sandboxed, contextIsolated: process.contextIsolated, electron: process.versions.electron, chrome: process.versions.chrome }),
  onBudgetAlert: (cb) => ipcRenderer.on('budget-alert', (_, data) => cb(data)),
  onContextUpdated: (cb) => ipcRenderer.on('context-updated', (_, data) => cb(data)),
  // FIX-16：自动更新（状态 + 手动触发；安装不接收参数）
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_, data) => cb(data)),
  // FIX-17：可观测性信息与请求日志导出
  getObservabilityInfo: () => ipcRenderer.invoke('get-observability-info'),
  exportRequests: (payload) => ipcRenderer.invoke('export-requests', payload),
  removeProxyListeners: () => {
    ipcRenderer.removeAllListeners('proxy-log')
    ipcRenderer.removeAllListeners('proxy-stopped')
    ipcRenderer.removeAllListeners('budget-alert')
    ipcRenderer.removeAllListeners('context-updated')
    ipcRenderer.removeAllListeners('update-status')
  },
})
