// FIX-16：自动更新与更新通道。
//
// 设计目标：
//   - 纯逻辑（通道选择、版本比较、状态机）与 Electron 解耦，可在无 GUI 环境下单测；
//   - electron-updater 只在「打包后的正式版本」里被惰性加载。开发环境、CLI、
//     以及没有安装该依赖的情况下，整个模块退化为一个明确说明原因的空实现，
//     绝不因为缺少更新依赖而影响应用启动。

const DEFAULT_CHANNEL = 'stable'
const DEFAULT_CHECK_INTERVAL_HOURS = 6

/** electron-updater 的通道名：stable → latest，beta → beta */
function updateChannelName(value) {
  return normalizeChannel(value) === 'beta' ? 'beta' : 'latest'
}

function normalizeChannel(value) {
  return value === 'beta' ? 'beta' : DEFAULT_CHANNEL
}

function parseVersion(value) {
  const m = String(value == null ? '' : value).trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] || '' }
}

/** 语义化版本比较，返回 -1 / 0 / 1；无法解析时视为 0（相等） */
function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] > pb[key] ? 1 : -1
  }
  if (pa.prerelease === pb.prerelease) return 0
  if (!pa.prerelease) return 1
  if (!pb.prerelease) return -1
  return pa.prerelease > pb.prerelease ? 1 : -1
}

function isPrerelease(value) {
  const parsed = parseVersion(value)
  return Boolean(parsed && parsed.prerelease)
}

/** stable 只接受正式版；beta 接受正式版与预发布版 */
function channelAccepts(version, channel) {
  return normalizeChannel(channel) === 'beta' ? true : !isPrerelease(version)
}

/**
 * 从 release 列表里挑出该通道下、比 currentVersion 新的最高版本。
 * releases 元素可以是字符串版本号，也可以是 { version, ... }。
 */
function selectUpdate(releases, options = {}) {
  const channel = normalizeChannel(options.channel)
  const currentVersion = options.currentVersion || '0.0.0'
  const candidates = (Array.isArray(releases) ? releases : [])
    .map(item => (typeof item === 'string' ? { version: item } : item))
    .filter(item => item && item.version && channelAccepts(item.version, channel))
    .filter(item => compareVersions(item.version, currentVersion) > 0)
    .sort((a, b) => compareVersions(b.version, a.version))
  return candidates[0] || null
}

function resolveConfig(deps) {
  if (deps.updatesConfig && typeof deps.updatesConfig === 'object') return deps.updatesConfig
  if (deps.configManager && typeof deps.configManager.getUpdatesConfig === 'function') {
    try { return deps.configManager.getUpdatesConfig() } catch { /* 读配置失败时用默认值 */ }
  }
  return {}
}

/**
 * 创建一个更新控制器。
 *
 * @param {{
 *   app?: object, configManager?: object, updatesConfig?: object,
 *   logger?: object, requireFn?: Function, autoUpdater?: object,
 * }} deps
 */
function createUpdater(deps = {}) {
  const logger = deps.logger || console
  const app = deps.app || null
  const requireFn = deps.requireFn || require
  const cfg = resolveConfig(deps)
  const channel = normalizeChannel(cfg.channel)
  const state = {
    supported: false,
    reason: null,
    channel,
    updateChannel: updateChannelName(channel),
    currentVersion: '',
    status: 'idle',
    availableVersion: null,
    downloadedVersion: null,
    progress: null,
    error: null,
    lastCheckedAt: null,
    autoDownload: cfg.auto_download === true,
    autoInstallOnQuit: cfg.auto_install_on_quit === true,
    releaseName: null,
    releaseNotes: null,
  }

  let autoUpdater = deps.autoUpdater || null

  function emit() {
    const snapshot = status()
    if (typeof deps.onStatus === 'function') { try { deps.onStatus(snapshot) } catch { /* UI 回调不影响更新 */ } }
    return snapshot
  }

  /** 记录「为什么不支持自动更新」，供 UI 明确告知用户而不是静默失效 */
  function unsupported(reason) {
    state.supported = false
    state.reason = reason
    state.status = 'unsupported'
    return status()
  }

  function status() { return { ...state } }

  if (!app) return { status, check: async () => unsupported('no-app-context'), download: async () => status(), quitAndInstall: () => false, dispose: () => {}, _state: state }
  state.currentVersion = typeof app.getVersion === 'function' ? app.getVersion() : ''
  if (cfg.enabled === false) return { status, check: async () => unsupported('disabled-by-config'), download: async () => status(), quitAndInstall: () => false, dispose: () => {}, _state: state }
  if (app.isPackaged !== true) {
    // 开发环境没有安装包元数据，electron-updater 会直接报错；这里明确跳过
    return { status, check: async () => unsupported('not-packaged'), download: async () => status(), quitAndInstall: () => false, dispose: () => {}, _state: state }
  }
  if (!autoUpdater) {
    try {
      autoUpdater = requireFn('electron-updater').autoUpdater
    } catch {
      return { status, check: async () => unsupported('electron-updater-not-installed'), download: async () => status(), quitAndInstall: () => false, dispose: () => {}, _state: state }
    }
  }
  if (!autoUpdater) return { status, check: async () => unsupported('electron-updater-not-installed'), download: async () => status(), quitAndInstall: () => false, dispose: () => {}, _state: state }

  state.supported = true
  state.reason = null
  autoUpdater.autoDownload = state.autoDownload
  autoUpdater.autoInstallOnAppQuit = state.autoInstallOnQuit
  autoUpdater.channel = state.updateChannel
  // stable 只跟 latest，beta 允许预发布版
  autoUpdater.allowPrerelease = channel === 'beta'

  const handlers = {
    'checking-for-update': () => { state.status = 'checking'; state.error = null; emit() },
    'update-available': info => {
      state.status = 'available'
      state.availableVersion = info?.version || null
      state.releaseName = info?.releaseName || null
      state.releaseNotes = typeof info?.releaseNotes === 'string' ? info.releaseNotes : null
      emit()
    },
    'update-not-available': () => { state.status = 'up-to-date'; state.availableVersion = null; emit() },
    'download-progress': progress => {
      state.status = 'downloading'
      state.progress = progress ? { percent: Number(progress.percent) || 0, transferred: progress.transferred, total: progress.total } : null
      emit()
    },
    'update-downloaded': info => {
      state.status = 'downloaded'
      state.downloadedVersion = info?.version || state.availableVersion
      state.progress = null
      emit()
    },
    error: err => {
      state.status = 'error'
      state.error = err ? String(err.message || err) : 'unknown update error'
      emit()
    },
  }

  const bound = []
  for (const [event, handler] of Object.entries(handlers)) {
    if (typeof autoUpdater.on === 'function') { autoUpdater.on(event, handler); bound.push([event, handler]) }
  }

  async function check(options = {}) {
    state.lastCheckedAt = new Date().toISOString()
    if (options && options.channel) {
      state.channel = normalizeChannel(options.channel)
      state.updateChannel = updateChannelName(state.channel)
      autoUpdater.channel = state.updateChannel
      autoUpdater.allowPrerelease = state.channel === 'beta'
    }
    try {
      // checkForUpdatesAndNotify 会自己弹系统通知；这里用 checkForUpdates 便于把状态交给 UI
      await autoUpdater.checkForUpdates()
      return emit()
    } catch (e) {
      state.status = 'error'
      state.error = String(e && e.message ? e.message : e)
      logger.warn?.(`[updater] 检查更新失败: ${state.error}`)
      return emit()
    }
  }

  async function download() {
    if (!state.supported) return status()
    try {
      state.status = 'downloading'
      emit()
      await autoUpdater.downloadUpdate()
      return emit()
    } catch (e) {
      state.status = 'error'
      state.error = String(e && e.message ? e.message : e)
      logger.warn?.(`[updater] 下载更新失败: ${state.error}`)
      return emit()
    }
  }

  function quitAndInstall() {
    if (!state.supported || state.status !== 'downloaded') return false
    try { autoUpdater.quitAndInstall(false, true); return true }
    catch (e) { logger.warn?.(`[updater] 安装更新失败: ${e.message}`); return false }
  }

  function dispose() {
    for (const [event, handler] of bound) {
      try { autoUpdater.removeListener?.(event, handler) } catch { /* 忽略 */ }
    }
    bound.length = 0
  }

  return { status, check, download, quitAndInstall, dispose, _state: state }
}

module.exports = {
  DEFAULT_CHANNEL,
  DEFAULT_CHECK_INTERVAL_HOURS,
  normalizeChannel,
  updateChannelName,
  parseVersion,
  compareVersions,
  isPrerelease,
  channelAccepts,
  selectUpdate,
  createUpdater,
}
