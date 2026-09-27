const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const yaml = require('js-yaml')
const { pathToFileURL } = require('url')

const {
  createNavigationPolicy, installNavigationGuards, normalizeHost,
  DEFAULT_EXTERNAL_HOSTS,
} = require('../lib/security/navigation')
const {
  getAgent, setSecurityPolicy, getSecurityPolicy,
  isInsecureTlsEnabled, isInsecureTlsRequestedButBlocked,
} = require('../lib/proxy/forwarder')
const { ProxyServer } = require('../lib/proxy/proxy-server')

const APP_DIR = path.join(__dirname, '..')
const PKG = require('../package.json')

// ---------------------------------------------------------------------------
// FIX-S1 验收
//   - 不再有禁用沙箱的启动开关
//   - webPreferences 显式 sandbox: true / contextIsolation: true / nodeIntegration: false
//   - 导航与 window.open 白名单可用并已接线
// ---------------------------------------------------------------------------

describe('FIX-S1 静态加固断言（源代码级回归防护）', () => {
  const mainSrc = fs.readFileSync(path.join(APP_DIR, 'main.js'), 'utf8')

  it('不再出现禁用沙箱的 appendSwitch', () => {
    for (const flag of ['no-sandbox', 'disable-setuid-sandbox', 'disable-gpu-sandbox']) {
      assert.ok(
        !new RegExp("appendSwitch\\(\\s*['\"]" + flag + "['\"]").test(mainSrc),
        `main.js 不应再调用 appendSwitch('${flag}')`,
      )
    }
  })

  it('显式调用 app.enableSandbox()', () => {
    assert.match(mainSrc, /app\.enableSandbox\(\)/)
  })

  it('webPreferences 显式开启沙箱与上下文隔离', () => {
    assert.match(mainSrc, /sandbox:\s*true/)
    assert.match(mainSrc, /contextIsolation:\s*true/)
    assert.match(mainSrc, /nodeIntegration:\s*false/)
    assert.match(mainSrc, /webviewTag:\s*false/)
    assert.ok(!/nodeIntegration:\s*true/.test(mainSrc), '不得启用 nodeIntegration')
  })

  it('已接线导航守卫与权限处理器', () => {
    assert.match(mainSrc, /installNavigationGuards\(/)
    assert.match(mainSrc, /applyPermissionHandler\(/)
    assert.match(mainSrc, /createNavigationPolicy\(/)
  })

  it('preload 不引入 Node 文件/进程能力', () => {
    const preloadSrc = fs.readFileSync(path.join(APP_DIR, 'preload.js'), 'utf8')
    for (const mod of ['fs', 'child_process', 'net', 'http', 'https', 'os']) {
      assert.ok(!new RegExp("require\\(['\"]" + mod + "['\"]\\)").test(preloadSrc), `preload 不应 require('${mod}')`)
    }
    assert.ok(!/exposeInMainWorld\([^)]*ipcRenderer\s*\)/.test(preloadSrc), '不得把 ipcRenderer 整个暴露给渲染层')
  })

  it('Electron 版本高于所有已知修复版本（>= 39.8.9）', () => {
    const declared = PKG.devDependencies.electron.replace(/[^0-9.]/g, '')
    const [major, minor, patch] = declared.split('.').map(Number)
    const atLeastFloor = major > 39 || (major === 39 && (minor > 8 || (minor === 8 && patch >= 9)))
    assert.ok(atLeastFloor, `electron ${declared} 必须 >= 39.8.9`)
    const installed = require('electron/package.json').version
    const [iMajor] = installed.split('.').map(Number)
    assert.ok(iMajor >= 39, `已安装的 electron ${installed} 必须 >= 39`)
  })
})

describe('FIX-S1 导航策略', () => {
  const policy = createNavigationPolicy({ appDir: APP_DIR, allowedExternalHosts: ['github.com', 'Example.COM:8443'] })

  it('只允许应用自身目录内的 file:// 导航', () => {
    assert.equal(policy.isInternalUrl(pathToFileURL(path.join(APP_DIR, 'index.html')).href), true)
    assert.equal(policy.isInternalUrl(pathToFileURL(path.join(APP_DIR, 'lib', 'proxy', 'router.js')).href), true)
    assert.equal(policy.isInternalUrl(pathToFileURL(path.join(APP_DIR, '..', 'outside.html')).href), false)
    assert.equal(policy.isInternalUrl('file:///C:/Windows/System32/drivers/etc/hosts'), false)
  })

  it('拒绝远程与危险协议', () => {
    for (const url of [
      'https://evil.example/', 'http://127.0.0.1:12306/stats', 'javascript:alert(1)',
      'data:text/html,<script>1</script>', 'file:///etc/passwd', 'ftp://x.example/a',
      'not a url', '',
    ]) {
      assert.equal(policy.shouldAllowNavigation(url), false, '不应允许导航到 ' + url)
    }
  })

  it('外部打开白名单只放行 https + 指定域名', () => {
    assert.equal(policy.isAllowedExternal('https://github.com/2048lr/ContextGate'), true)
    assert.equal(policy.isAllowedExternal('https://example.com:8443/x'), true)
    assert.equal(policy.isAllowedExternal('http://github.com/'), false, 'http 不放行')
    assert.equal(policy.isAllowedExternal('https://evil.example/'), false)
    assert.equal(policy.isAllowedExternal('https://github.com.evil.example/'), false)
    assert.equal(policy.isAllowedExternal('file:///C:/x'), false)
  })

  it('默认白名单只包含项目自身仓库域名', () => {
    assert.deepEqual(DEFAULT_EXTERNAL_HOSTS, ['github.com'])
    assert.deepEqual(createNavigationPolicy({ appDir: APP_DIR }).allowedExternalHosts(), ['github.com'])
  })

  it('host 归一化去掉端口并小写', () => {
    assert.equal(normalizeHost('GitHub.COM:443'), 'github.com')
    assert.equal(normalizeHost('  LocalHost  '), 'localhost')
    assert.equal(normalizeHost(undefined), '')
  })
})

describe('FIX-S1 导航守卫接线', () => {
  function fakeElectron() {
    const handlers = {}
    const contentsHandlers = {}
    const opened = []
    const app = {
      on(event, cb) { handlers[event] = cb },
      emit(event, ...args) { if (handlers[event]) handlers[event](...args) },
    }
    const shell = { openExternal: (url) => { opened.push(url); return Promise.resolve() } }
    const contents = {
      setWindowOpenHandler(fn) { contentsHandlers.windowOpen = fn },
      on(event, fn) { contentsHandlers[event] = fn },
    }
    const session = {
      setPermissionRequestHandler(fn) { this._perm = fn },
      setPermissionCheckHandler(fn) { this._permCheck = fn },
    }
    return { app, shell, contents, session, opened, contentsHandlers }
  }

  it('window.open 一律拒绝，白名单域名交给系统浏览器', () => {
    const { app, shell, contents, opened, contentsHandlers } = fakeElectron()
    const warnings = []
    const guards = installNavigationGuards({
      app, shell,
      policy: createNavigationPolicy({ appDir: APP_DIR, allowedExternalHosts: ['github.com'] }),
      logger: { warn: m => warnings.push(m), error: () => {} },
    })
    app.emit('web-contents-created', {}, contents)
    const denied = contentsHandlers.windowOpen({ url: 'https://github.com/2048lr/ContextGate' })
    assert.deepEqual(denied, { action: 'deny' })
    assert.deepEqual(opened, ['https://github.com/2048lr/ContextGate'])

    const denied2 = contentsHandlers.windowOpen({ url: 'https://evil.example/' })
    assert.deepEqual(denied2, { action: 'deny' })
    assert.equal(opened.length, 1, '非白名单域名不得交给系统浏览器')
    assert.ok(warnings.length >= 2)
    assert.ok(guards)
  })

  it('will-navigate / will-redirect 阻止外部导航但放行内部页面', () => {
    const { app, shell, contents, opened, contentsHandlers } = fakeElectron()
    installNavigationGuards({
      app, shell,
      policy: createNavigationPolicy({ appDir: APP_DIR, allowedExternalHosts: ['github.com'] }),
      logger: { warn: () => {}, error: () => {} },
    })
    app.emit('web-contents-created', {}, contents)

    const internalUrl = pathToFileURL(path.join(APP_DIR, 'index.html')).href
    let prevented = false
    contentsHandlers['will-navigate']({ preventDefault: () => { prevented = true } }, internalUrl)
    assert.equal(prevented, false, '内部页面导航不应被阻止')

    contentsHandlers['will-navigate']({ preventDefault: () => { prevented = true } }, 'https://evil.example/')
    assert.equal(prevented, true)

    prevented = false
    contentsHandlers['will-navigate']({ preventDefault: () => { prevented = true } }, 'https://github.com/2048lr/ContextGate')
    assert.equal(prevented, true, '外部域名即使在白名单也必须离开应用窗口')
    assert.deepEqual(opened, ['https://github.com/2048lr/ContextGate'])

    prevented = false
    contentsHandlers['will-redirect']({ preventDefault: () => { prevented = true } }, 'https://evil.example/')
    assert.equal(prevented, true)
  })

  it('禁止挂载 webview', () => {
    const { app, shell, contents, contentsHandlers } = fakeElectron()
    installNavigationGuards({
      app, shell, policy: createNavigationPolicy({ appDir: APP_DIR }),
      logger: { warn: () => {}, error: () => {} },
    })
    app.emit('web-contents-created', {}, contents)
    let prevented = false
    contentsHandlers['will-attach-webview']({ preventDefault: () => { prevented = true } })
    assert.equal(prevented, true)
  })

  it('默认拒绝所有权限请求', () => {
    const { app, shell, session } = fakeElectron()
    const guards = installNavigationGuards({
      app, shell, policy: createNavigationPolicy({ appDir: APP_DIR }),
      logger: { warn: () => {}, error: () => {} },
    })
    assert.equal(guards.applyPermissionHandler(session), true)
    let granted = null
    session._perm({}, 'media', ok => { granted = ok })
    assert.equal(granted, false)
    assert.equal(session._permCheck(), false)
  })
})

// ---------------------------------------------------------------------------
// FIX-S2 验收：TLS 校验降级默认不可达，且开启时有测试覆盖
// ---------------------------------------------------------------------------

describe('FIX-S2 不安全 TLS 开关默认关闭', () => {
  const tlsProvider = { base_url: 'https://self-signed.internal/v1', tls: { reject_unauthorized: false } }
  const plainProvider = { base_url: 'https://api.openai.com/v1' }

  it('默认策略下 provider 请求降级也会继续校验证书', () => {
    setSecurityPolicy({ allowInsecureTls: false })
    assert.equal(isInsecureTlsEnabled(tlsProvider), false)
    assert.equal(isInsecureTlsRequestedButBlocked(tlsProvider), true)
    assert.equal(getAgent(tlsProvider).options.rejectUnauthorized, true)
  })

  it('全局开启后 provider 才能使用不校验证书的 agent', () => {
    setSecurityPolicy({ allowInsecureTls: true })
    try {
      assert.equal(isInsecureTlsEnabled(tlsProvider), true)
      assert.equal(getAgent(tlsProvider).options.rejectUnauthorized, false)
      assert.equal(isInsecureTlsRequestedButBlocked(tlsProvider), false)
    } finally { setSecurityPolicy({ allowInsecureTls: false }) }
  })

  it('未声明的 provider 始终使用安全 agent', () => {
    setSecurityPolicy({ allowInsecureTls: true })
    try {
      assert.equal(isInsecureTlsEnabled(plainProvider), false)
      assert.equal(getAgent(plainProvider).options.rejectUnauthorized, true)
    } finally { setSecurityPolicy({ allowInsecureTls: false }) }
  })

  it('getSecurityPolicy 返回副本，外部无法篡改内部状态', () => {
    setSecurityPolicy({ allowInsecureTls: false })
    const snapshot = getSecurityPolicy()
    snapshot.allowInsecureTls = true
    assert.equal(getSecurityPolicy().allowInsecureTls, false)
  })
})

describe('FIX-S2 启动告警', () => {
  function makeConfigDir(proxyExtra = {}, providerExtra = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-s2-'))
    fs.writeFileSync(path.join(dir, 'models-dev-cache.json'), '{}')
    fs.writeFileSync(path.join(dir, 'config.yaml'), yaml.dump({
      providers: { openai: { api_key: 'sk-live-abcdef1234567890', base_url: 'http://127.0.0.1:9/v1', ...providerExtra } },
      proxy: { host: '127.0.0.1', port: 0, ...proxyExtra },
    }))
    return dir
  }

  it('provider 请求降级但全局未开启 → 给出「已按安全默认值」告警', async () => {
    const dir = makeConfigDir({}, { tls: { reject_unauthorized: false } })
    const proxy = new ProxyServer({ configPath: path.join(dir, 'config.yaml'), dataDir: dir })
    const started = await proxy.start('127.0.0.1', 0)
    try {
      assert.ok(started.warnings.some(w => w.includes('allow_insecure_tls')), JSON.stringify(started.warnings))
      assert.equal(started.allowInsecureTls, false)
    } finally { await proxy.stop(); fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('全局开启 + provider 请求降级 → 给出「不安全连接已启用」告警', async () => {
    const dir = makeConfigDir()
    const cfgPath = path.join(dir, 'config.yaml')
    const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8'))
    cfg.providers.openai.tls = { reject_unauthorized: false }
    cfg.security = { allow_insecure_tls: true }
    fs.writeFileSync(cfgPath, yaml.dump(cfg))
    const proxy = new ProxyServer({ configPath: cfgPath, dataDir: dir })
    const started = await proxy.start('127.0.0.1', 0)
    try {
      assert.equal(started.allowInsecureTls, true)
      assert.ok(started.warnings.some(w => w.includes('不安全连接已启用')), JSON.stringify(started.warnings))
      assert.deepEqual(proxy.providersRequestingInsecureTls(), ['openai'])
    } finally {
      await proxy.stop()
      setSecurityPolicy({ allowInsecureTls: false })
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('没有 provider 请求降级时不产生 TLS 告警', async () => {
    const dir = makeConfigDir()
    const proxy = new ProxyServer({ configPath: path.join(dir, 'config.yaml'), dataDir: dir })
    const started = await proxy.start('127.0.0.1', 0)
    try {
      assert.ok(!started.warnings.some(w => w.includes('TLS')), JSON.stringify(started.warnings))
    } finally { await proxy.stop(); fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
