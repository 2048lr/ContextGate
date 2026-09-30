const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('events')

const {
  normalizeChannel, updateChannelName, parseVersion, compareVersions,
  isPrerelease, channelAccepts, selectUpdate, createUpdater,
} = require('../lib/core/updater')

// ---------------------------------------------------------------------------
// FIX-16 验收：更新通道选择 + 状态机（不启动 Electron）
// ---------------------------------------------------------------------------

function fakeApp({ packaged = true, version = '5.5.0' } = {}) {
  return { isPackaged: packaged, getVersion: () => version }
}

/** 最小可用的 autoUpdater 替身：支持 on/emit/checkForUpdates/downloadUpdate/quitAndInstall */
class FakeAutoUpdater extends EventEmitter {
  constructor() {
    super()
    this.autoDownload = false
    this.autoInstallOnAppQuit = false
    this.channel = 'latest'
    this.allowPrerelease = false
    this.checks = 0
    this.downloads = 0
    this.installs = 0
    this.nextResult = 'update-not-available'
    this.nextInfo = { version: '6.0.0' }
  }

  async checkForUpdates() {
    this.checks++
    this.emit('checking-for-update')
    if (this.nextResult === 'error') {
      const err = new Error('network down')
      this.emit('error', err)
      throw err
    }
    if (this.nextResult === 'update-available') this.emit('update-available', this.nextInfo)
    else this.emit('update-not-available', {})
    return { updateInfo: this.nextInfo }
  }

  async downloadUpdate() {
    this.downloads++
    this.emit('download-progress', { percent: 50, transferred: 5, total: 10 })
    this.emit('update-downloaded', this.nextInfo)
    return ['file']
  }

  quitAndInstall() { this.installs++ }
}

function makeUpdater(overrides = {}) {
  const autoUpdater = overrides.autoUpdater || new FakeAutoUpdater()
  const app = overrides.app || fakeApp()
  const statuses = []
  const updater = createUpdater({
    app,
    autoUpdater,
    updatesConfig: { enabled: true, channel: 'stable', auto_download: false, ...overrides.updatesConfig },
    onStatus: s => statuses.push(s.status),
    logger: { log() {}, warn() {}, error() {} },
  })
  return { updater, autoUpdater, statuses, app }
}

describe('FIX-16 版本与通道（纯函数）', () => {
  it('通道名映射', () => {
    assert.equal(normalizeChannel('beta'), 'beta')
    assert.equal(normalizeChannel('stable'), 'stable')
    assert.equal(normalizeChannel('nonsense'), 'stable')
    assert.equal(updateChannelName('beta'), 'beta')
    assert.equal(updateChannelName('stable'), 'latest')
  })

  it('解析与比较版本', () => {
    assert.deepEqual(parseVersion('v5.5.0'), { major: 5, minor: 5, patch: 0, prerelease: '' })
    assert.equal(compareVersions('5.5.0', '5.5.0'), 0)
    assert.equal(compareVersions('5.6.0', '5.5.9'), 1)
    assert.equal(compareVersions('5.5.0', '5.10.0'), -1)
    assert.equal(compareVersions('6.0.0-beta.1', '6.0.0'), -1)
    assert.equal(compareVersions('6.0.0', '6.0.0-beta.1'), 1)
    assert.equal(compareVersions('not-a-version', '5.0.0'), 0)
  })

  it('stable 只接受正式版，beta 两者都接受', () => {
    assert.equal(isPrerelease('6.0.0-beta.1'), true)
    assert.equal(isPrerelease('6.0.0'), false)
    assert.equal(channelAccepts('6.0.0-beta.1', 'stable'), false)
    assert.equal(channelAccepts('6.0.0-beta.1', 'beta'), true)
    assert.equal(channelAccepts('6.0.0', 'stable'), true)
  })

  it('selectUpdate 只挑比当前版本新的最高版本', () => {
    const releases = ['5.5.0', { version: '5.6.0' }, '5.4.9', '6.0.0-beta.1']
    assert.equal(selectUpdate(releases, { channel: 'stable', currentVersion: '5.5.0' }).version, '5.6.0')
    assert.equal(selectUpdate(releases, { channel: 'beta', currentVersion: '5.5.0' }).version, '6.0.0-beta.1')
    assert.equal(selectUpdate(releases, { channel: 'stable', currentVersion: '7.0.0' }), null)
    assert.equal(selectUpdate([], { currentVersion: '1.0.0' }), null)
  })
})

describe('FIX-16 更新控制器状态机', () => {
  it('未打包时明确返回 unsupported，而不是静默失败', async () => {
    const { updater } = makeUpdater({ app: fakeApp({ packaged: false }) })
    assert.equal(updater.status().supported, false)
    const s = await updater.check()
    assert.equal(s.status, 'unsupported')
    assert.equal(s.reason, 'not-packaged')
  })

  it('配置关闭时不加载更新器', async () => {
    const { updater } = makeUpdater({ updatesConfig: { enabled: false } })
    const s = await updater.check()
    assert.equal(s.status, 'unsupported')
    assert.equal(s.reason, 'disabled-by-config')
  })

  it('缺少 electron-updater 依赖时退化为 unsupported', async () => {
    const updater = createUpdater({
      app: fakeApp(),
      requireFn: () => { throw new Error('module not found') },
      updatesConfig: { enabled: true },
      logger: { warn() {} },
    })
    const s = await updater.check()
    assert.equal(s.status, 'unsupported')
    assert.equal(s.reason, 'electron-updater-not-installed')
  })

  it('打包 + 有依赖时配置通道并驱动状态：check → available → download → downloaded → install', async () => {
    const { updater, autoUpdater, statuses } = makeUpdater()
    assert.equal(updater.status().supported, true)
    assert.equal(updater.status().updateChannel, 'latest')
    assert.equal(autoUpdater.autoDownload, false)
    assert.equal(autoUpdater.autoInstallOnAppQuit, false)

    autoUpdater.nextResult = 'update-available'
    autoUpdater.nextInfo = { version: '5.6.0', releaseName: 'v5.6.0' }
    const checked = await updater.check()
    assert.equal(checked.status, 'available')
    assert.equal(checked.availableVersion, '5.6.0')
    assert.equal(autoUpdater.checks, 1)

    const downloading = await updater.download()
    assert.equal(downloading.status, 'downloaded')
    assert.equal(downloading.downloadedVersion, '5.6.0')
    assert.ok(statuses.includes('downloading'))
    assert.ok(statuses.includes('downloaded'))

    assert.equal(updater.quitAndInstall(), true)
    assert.equal(autoUpdater.installs, 1)
  })

  it('beta 通道会打开 allowPrerelease', async () => {
    const { updater, autoUpdater } = makeUpdater({ updatesConfig: { channel: 'beta' } })
    assert.equal(updater.status().updateChannel, 'beta')
    assert.equal(autoUpdater.allowPrerelease, true)
  })

  it('检查失败被记录为 error 而不是抛给调用方', async () => {
    const { updater, autoUpdater } = makeUpdater()
    autoUpdater.nextResult = 'error'
    const s = await updater.check()
    assert.equal(s.status, 'error')
    assert.match(s.error, /network down/)
  })

  it('未下载完成时 quitAndInstall 不做任何事', () => {
    const { updater, autoUpdater } = makeUpdater()
    assert.equal(updater.quitAndInstall(), false)
    assert.equal(autoUpdater.installs, 0)
  })

  it('dispose 会移除事件监听（避免长生命周期泄漏）', () => {
    const { updater, autoUpdater } = makeUpdater()
    updater.dispose()
    // FakeAutoUpdater 继承 EventEmitter：移除后不应再触发状态回调
    const before = updater.status()
    autoUpdater.emit('update-available', { version: '9.9.9' })
    assert.deepEqual(updater.status(), before)
  })
})
