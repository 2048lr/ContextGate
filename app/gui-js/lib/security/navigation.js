const path = require('path')
const { fileURLToPath } = require('url')

// FIX-S1：导航与窗口守卫
// Electron 安全清单要求禁用/收窄 will-navigate 与 window.open。原先两者都缺失，
// 一旦渲染层出现可导航点，配合 preload 暴露的 API 即可外传数据与密钥。

const DEFAULT_EXTERNAL_HOSTS = ['github.com']
const EXTERNAL_PROTOCOLS = new Set(['https:'])

function normalizeHost(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase().replace(/:\d+$/, '')
}

/**
 * 创建一个纯函数式的导航策略，便于单测。
 * @param {{ appDir?: string, allowedExternalHosts?: string[], isDev?: boolean }} [options]
 */
function createNavigationPolicy(options = {}) {
  const appDir = options.appDir ? path.resolve(options.appDir) : null
  const externalHosts = new Set(
    (Array.isArray(options.allowedExternalHosts) ? options.allowedExternalHosts : DEFAULT_EXTERNAL_HOSTS)
      .map(normalizeHost).filter(Boolean),
  )
  const isDev = options.isDev === true

  function parse(target) {
    try { return new URL(String(target)) } catch { return null }
  }

  /** 应用自身页面（以及开发期的 devtools）才算内部导航 */
  function isInternalUrl(target) {
    const url = parse(target)
    if (!url) return false
    if (url.protocol === 'file:') {
      if (!appDir) return true
      let filePath
      try { filePath = fileURLToPath(url) } catch { return false }
      const rel = path.relative(appDir, path.resolve(filePath))
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
    }
    if (isDev && (url.protocol === 'devtools:' || url.protocol === 'chrome-devtools:')) return true
    return false
  }

  /** 只有白名单域名 + https 才允许交给系统浏览器打开 */
  function isAllowedExternal(target) {
    const url = parse(target)
    if (!url) return false
    if (!EXTERNAL_PROTOCOLS.has(url.protocol)) return false
    return externalHosts.has(normalizeHost(url.hostname))
  }

  return {
    appDir,
    isDev,
    isInternalUrl,
    isAllowedExternal,
    allowedExternalHosts: () => [...externalHosts].sort(),
    shouldAllowNavigation: target => isInternalUrl(target),
  }
}

/**
 * 把策略挂到 Electron 上。所有渲染进程（含未来新建的）都会被覆盖。
 * @param {{ app: object, shell: object, policy: object, logger?: object }} deps
 */
function installNavigationGuards({ app, shell, policy, logger = console }) {
  function openExternalIfAllowed(url) {
    if (!policy.isAllowedExternal(url)) return false
    try {
      Promise.resolve(shell.openExternal(url)).catch(() => {})
      return true
    } catch { return false }
  }

  function guardContents(contents) {
    contents.setWindowOpenHandler(({ url }) => {
      const opened = openExternalIfAllowed(url)
      logger.warn(`[security] 已阻止 window.open：${url}${opened ? '（已交给系统浏览器）' : ''}`)
      return { action: 'deny' }
    })

    const blockNavigation = (event, url) => {
      if (policy.shouldAllowNavigation(url)) return
      event.preventDefault()
      const opened = openExternalIfAllowed(url)
      logger.warn(`[security] 已阻止导航：${url}${opened ? '（已交给系统浏览器）' : ''}`)
    }

    contents.on('will-navigate', blockNavigation)
    contents.on('will-redirect', blockNavigation)
    // 本项目不使用 webview；直接禁止挂载
    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
      logger.warn('[security] 已阻止 webview 挂载')
    })
  }

  app.on('web-contents-created', (_event, contents) => guardContents(contents))

  return {
    guardContents,
    /** 默认拒绝所有权限请求（摄像头/麦克风/通知/地理位置…） */
    applyPermissionHandler(session) {
      if (!session || typeof session.setPermissionRequestHandler !== 'function') return false
      session.setPermissionRequestHandler((_wc, permission, callback) => {
        logger.warn(`[security] 已拒绝权限请求：${permission}`)
        callback(false)
      })
      if (typeof session.setPermissionCheckHandler === 'function') {
        session.setPermissionCheckHandler(() => false)
      }
      return true
    },
  }
}

module.exports = {
  DEFAULT_EXTERNAL_HOSTS,
  EXTERNAL_PROTOCOLS,
  normalizeHost,
  createNavigationPolicy,
  installNavigationGuards,
}
