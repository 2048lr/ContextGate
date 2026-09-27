const { contextBridge } = require('electron')
contextBridge.exposeInMainWorld('__sandboxProbe', {
  sandboxed: process.sandboxed,
  contextIsolated: process.contextIsolated,
  hasRequire: typeof require === 'function',
})
