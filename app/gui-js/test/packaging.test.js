const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const APP_DIR = path.join(__dirname, '..')
const PKG = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'))
const {
  WIN32_IA32_DROPPED_IN,
  supportedWin32Arches,
  declaredWinArches,
  cliArches,
  checkArches,
  majorOf,
} = require('../scripts/preflight-build')

// ---------------------------------------------------------------------------
// 回归：Electron 44 起不再发布 32 位 Windows 产物
//   https://github.com/electron/electron —— 44.x 只提供 win32-x64 / win32-arm64
//   历史 bug：build.win.target 里保留 ia32，打包时去下载
//   electron-v44.4.5-win32-ia32.zip → 404，报错完全不指向真实原因。
// ---------------------------------------------------------------------------

const EMPTY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-preflight-'))

describe('打包目标架构与 Electron 版本一致', () => {
  const declared = declaredWinArches(PKG.build)

  it('build.win.target 不再声明 ia32', () => {
    assert.ok(declared.length > 0, '至少应声明一个 Windows 架构')
    assert.ok(!declared.includes('ia32'), `build.win.target 不应包含 ia32，实际: ${declared.join(', ')}`)
    assert.ok(declared.includes('x64'))
  })

  it('没有任何 npm script 还在传 --ia32', () => {
    for (const [name, cmd] of Object.entries(PKG.scripts)) {
      assert.ok(!/--ia32\b/.test(cmd), `script "${name}" 仍在传 --ia32: ${cmd}`)
    }
    assert.ok(!('build:win:ia32' in PKG.scripts), 'build:win:ia32 已无法工作，不应保留')
  })

  it('声明的架构被当前 Electron 版本支持', () => {
    const electronVersion = require('electron/package.json').version
    const supported = supportedWin32Arches(electronVersion, APP_DIR)
    for (const arch of declared) {
      assert.ok(supported.includes(arch), `electron ${electronVersion} 不发布 win32-${arch}（可用: ${supported.join(', ')}）`)
    }
  })

  it('package.json 声明的 Electron 版本下限也支持这些架构', () => {
    const range = PKG.devDependencies.electron
    const floor = range.replace(/[^0-9.]/g, '')
    const supported = supportedWin32Arches(floor, EMPTY_DIR)
    for (const arch of declared) {
      assert.ok(supported.includes(arch), `electron ${floor} 不发布 win32-${arch}`)
    }
  })
})

describe('preflight 架构表', () => {
  it('majorOf 解析各种版本写法', () => {
    assert.equal(majorOf('44.4.5'), 44)
    assert.equal(majorOf('v43.7.5'), 43)
    assert.equal(majorOf('^44.4.5'), 44)
    assert.equal(majorOf(''), null)
    assert.equal(majorOf(null), null)
  })

  it('44+ 只提供 x64 与 arm64', () => {
    assert.equal(WIN32_IA32_DROPPED_IN, 44)
    assert.deepEqual(supportedWin32Arches('44.4.5', EMPTY_DIR), ['arm64', 'x64'])
    assert.deepEqual(supportedWin32Arches('45.0.0', EMPTY_DIR), ['arm64', 'x64'])
  })

  it('43 及更早仍提供 ia32（用于给出「固定到 43.x」的备选建议）', () => {
    assert.deepEqual(supportedWin32Arches('43.7.5', EMPTY_DIR), ['arm64', 'ia32', 'x64'])
    assert.deepEqual(supportedWin32Arches('39.8.10', EMPTY_DIR), ['arm64', 'ia32', 'x64'])
  })

  it('优先使用 electron 包自带的 checksums.json（离线权威来源）', () => {
    const supported = supportedWin32Arches(require('electron/package.json').version, APP_DIR)
    assert.ok(supported.length >= 2)
    assert.ok(supported.includes('x64'))
  })
})

describe('preflight 校验逻辑', () => {
  it('44 + ia32 被拒绝，并给出可操作的原因', () => {
    const r = checkArches({ electronVersion: '44.4.5', declared: ['x64', 'ia32'], appDir: EMPTY_DIR })
    assert.equal(r.ok, false)
    assert.deepEqual(r.invalid, ['ia32'])
    assert.deepEqual(r.supported, ['arm64', 'x64'])
  })

  it('44 + x64/arm64 通过', () => {
    assert.equal(checkArches({ electronVersion: '44.4.5', declared: ['x64'], appDir: EMPTY_DIR }).ok, true)
    assert.equal(checkArches({ electronVersion: '44.4.5', requested: ['arm64'], appDir: EMPTY_DIR }).ok, true)
  })

  it('43 + ia32 通过（不会误报）', () => {
    assert.equal(checkArches({ electronVersion: '43.7.5', declared: ['x64', 'ia32'], appDir: EMPTY_DIR }).ok, true)
  })

  it('declaredWinArches 兼容字符串与数组两种写法', () => {
    assert.deepEqual(declaredWinArches({ win: { target: [{ target: 'nsis', arch: ['x64', 'ia32'] }] } }), ['x64', 'ia32'])
    assert.deepEqual(declaredWinArches({ win: { target: [{ target: 'nsis', arch: 'x64' }] } }), ['x64'])
    assert.deepEqual(declaredWinArches({ win: { target: ['nsis'] } }), [])
    assert.deepEqual(declaredWinArches({}), [])
  })

  it('cliArches 只认 electron-builder 的架构开关', () => {
    assert.deepEqual(cliArches(['--win', '--x64', '--dir']), ['x64'])
    assert.deepEqual(cliArches(['--ia32']), ['ia32'])
    assert.deepEqual(cliArches(['--arm']), ['armv7l'])
    assert.deepEqual(cliArches(['--config.npmRebuild=false']), [])
  })

  it('当前仓库的完整配置校验通过', () => {
    const electronVersion = require('electron/package.json').version
    const r = checkArches({ electronVersion, declared: declaredWinArches(PKG.build), requested: ['x64', 'arm64'], appDir: APP_DIR })
    assert.equal(r.ok, true, `不应有非法架构: ${r.invalid.join(', ')}`)
  })
})

describe('preflight 已接入构建脚本', () => {
  it('每个 build:win* 都有对应的 prebuild 钩子', () => {
    for (const name of ['build:win', 'build:win:x64', 'build:win:arm64']) {
      assert.ok(`pre${name}` in PKG.scripts, `缺少 pre${name} 钩子`)
      assert.match(PKG.scripts[`pre${name}`], /preflight-build\.js/)
    }
  })

  it('npm 对 prebuild 钩子的命名约定正确（pre + 脚本名）', () => {
    assert.equal(PKG.scripts['prebuild:win:x64'], 'node scripts/preflight-build.js')
  })
})
