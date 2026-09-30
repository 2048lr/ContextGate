const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

// ---------------------------------------------------------------------------
// FIX-18 验收：跨平台构建配置 + 无头（Docker）形态
//   - package.json 恢复 linux/mac 构建目标
//   - Dockerfile / .dockerignore / docker-compose.yml 可用，且容器里跑的是纯 Node CLI
//   - CLI 支持把上下文产物写到项目目录之外（只读挂载场景）
// ---------------------------------------------------------------------------

const APP_DIR = path.join(__dirname, '..')
const REPO_DIR = path.join(APP_DIR, '..', '..')
const PKG = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'))
const CLI = fs.readFileSync(path.join(APP_DIR, 'cli.js'), 'utf8')

function readRepo(rel) {
  const file = path.join(REPO_DIR, rel)
  assert.ok(fs.existsSync(file), `缺少 ${rel}`)
  return fs.readFileSync(file, 'utf8')
}

function targetsFor(platform) {
  const targets = PKG.build[platform].target
  return targets.map(t => (typeof t === 'string' ? t : t.target)).map(t => String(t).toLowerCase())
}

describe('FIX-18 跨平台构建目标', () => {
  it('Windows 保持 x64 nsis + portable', () => {
    assert.ok(targetsFor('win').includes('nsis'))
    assert.ok(targetsFor('win').includes('portable'))
  })

  it('恢复 Linux 目标（AppImage + deb）', () => {
    const targets = targetsFor('linux')
    assert.ok(targets.includes('appimage'), '应包含 AppImage')
    assert.ok(targets.includes('deb'), '应包含 deb')
  })

  it('恢复 macOS 目标（dmg + zip）', () => {
    const targets = targetsFor('mac')
    assert.ok(targets.includes('dmg'))
    assert.ok(targets.includes('zip'))
  })

  it('提供对应 npm 脚本', () => {
    assert.equal(PKG.scripts['build:linux'], 'electron-builder --linux')
    assert.equal(PKG.scripts['build:mac'], 'electron-builder --mac')
    assert.match(PKG.scripts['build:all'], /--win --linux --mac/)
  })

  it('主进程已为 Linux/macOS 平台分支（托盘、窗口边框、关闭行为）', () => {
    const main = fs.readFileSync(path.join(APP_DIR, 'main.js'), 'utf8')
    assert.match(main, /isLinux/)
    assert.match(main, /isMac/)
    assert.match(main, /titleBarStyle/)
  })
})

describe('FIX-18 无头容器形态', () => {
  it('Dockerfile 只基于 Node，不安装 Electron', () => {
    const dockerfile = readRepo('Dockerfile')
    assert.match(dockerfile, /^FROM node:20/m)
    // 不安装 Electron / 桌面构建链：只装运行时依赖
    assert.ok(!/npm (install|i|ci)\s+[^\n]*electron/i.test(dockerfile), '无头镜像不应安装 Electron')
    assert.match(dockerfile, /npm ci --omit=dev/)
    assert.match(dockerfile, /USER node/)
    assert.match(dockerfile, /HEALTHCHECK/)
    assert.match(dockerfile, /ENTRYPOINT \["node", "\/app\/cli\.js"\]/)
    assert.match(dockerfile, /--omit=dev/)
  })

  it('容器把上下文产物写到项目目录之外，以便项目可只读挂载', () => {
    const dockerfile = readRepo('Dockerfile')
    assert.match(dockerfile, /-o", "\/tmp\/full_context\.txt/)
  })

  it('.dockerignore 排除 node_modules/dist/本地缓存', () => {
    const ignore = readRepo('.dockerignore')
    for (const entry of ['**/node_modules', '**/dist', '**/.npm-cache', '.git']) {
      assert.ok(ignore.includes(entry), '缺少 .dockerignore 规则: ' + entry)
    }
  })

  it('docker-compose.yml 存在且只暴露回环端口', () => {
    const compose = readRepo('docker-compose.yml')
    assert.match(compose, /127\.0\.0\.1:12306:12306/)
    assert.match(compose, /OPENAI_API_KEY/)
  })

  it('CLI serve 支持 --output，把产物写到项目之外', () => {
    assert.match(CLI, /--output <path>/)
    assert.match(CLI, /options\.output/)
  })

  it('无头入口不加载 Electron：cli.js 不 require electron/main.js', () => {
    assert.ok(!/require\(['"]electron['"]\)/.test(CLI), 'cli.js 不应依赖 electron')
    assert.ok(!/require\(['"]\.\/main['"]\)/.test(CLI), 'cli.js 不应加载桌面主进程')
    const proxyServer = fs.readFileSync(path.join(APP_DIR, 'lib/proxy/proxy-server.js'), 'utf8')
    assert.ok(!/require\(['"]electron['"]\)/.test(proxyServer), 'proxy-server 不应依赖 electron')
  })
})
