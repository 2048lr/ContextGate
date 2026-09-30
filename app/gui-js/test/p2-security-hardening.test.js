const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const {
  createNavigationPolicy, installNavigationGuards,
  normalizeHost, DEFAULT_EXTERNAL_HOSTS,
} = require('../lib/security/navigation')

// ---------------------------------------------------------------------------
// FIX-14 验收：Electron 安全硬化
//   - CSP 收紧：connect-src 不再允许任意 https 出网
//   - 沙箱开启、无禁用沙箱开关
//   - 导航/弹窗/权限全部默认拒绝
//   - 依赖审计入口存在
// ---------------------------------------------------------------------------

const APP_DIR = path.join(__dirname, '..')
const INDEX_HTML = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8')
const MAIN_JS = fs.readFileSync(path.join(APP_DIR, 'main.js'), 'utf8')
const PRELOAD_JS = fs.readFileSync(path.join(APP_DIR, 'preload.js'), 'utf8')
const PKG = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'))

function cspDirectives(html) {
  const m = html.match(/http-equiv=["']Content-Security-Policy["']\s+content="([^"]+)"/i)
  assert.ok(m, 'index.html 必须声明 CSP')
  const directives = {}
  for (const part of m[1].split(';')) {
    const tokens = part.trim().split(/\s+/)
    if (tokens.length >= 2) directives[tokens[0].toLowerCase()] = tokens.slice(1)
  }
  return directives
}

describe('FIX-14 CSP 收紧', () => {
  const directives = cspDirectives(INDEX_HTML)

  it('connect-src 只允许本机回环，不再放行任意 https', () => {
    const connect = directives['connect-src'] || []
    assert.ok(connect.includes("'self'"), 'connect-src 应保留 self')
    assert.ok(connect.some(v => v.includes('127.0.0.1')), 'connect-src 需要允许回环 127.0.0.1')
    assert.ok(connect.some(v => v.includes('localhost')), 'connect-src 需要允许 localhost')
    assert.ok(!connect.includes('https:'), 'connect-src 不应允许任意 https')
    assert.ok(!connect.includes('http:'), 'connect-src 不应允许任意 http')
    assert.ok(!connect.includes('*'), 'connect-src 不应出现通配符')
  })

  it('其它出网面同样被收窄', () => {
    assert.ok(!(directives['img-src'] || []).includes('https:'), 'img-src 不应允许任意 https')
    assert.deepEqual(directives['script-src'], ["'self'"])
    assert.deepEqual(directives['object-src'], ["'none'"])
    assert.deepEqual(directives['base-uri'], ["'none'"])
    assert.deepEqual(directives['form-action'], ["'none'"])
    assert.deepEqual(directives['frame-ancestors'], ["'none'"])
    assert.equal(directives['default-src'][0], "'self'")
  })

  it('CSP 里不再有宽泛的 https: / http: 源', () => {
    const raw = INDEX_HTML.match(/Content-Security-Policy["']\s+content="([^"]+)"/i)[1]
    assert.ok(!/\bhttps:\s/.test(raw) && !/\bhttp:\s/.test(raw), '不应保留宽泛的 http(s): 源: ' + raw)
  })
})

describe('FIX-14 沙箱与隔离', () => {
  it('主进程显式开启沙箱，且没有禁用沙箱的开关', () => {
    assert.match(MAIN_JS, /app\.enableSandbox\(\)/)
    assert.match(MAIN_JS, /sandbox:\s*true/)
    assert.match(MAIN_JS, /contextIsolation:\s*true/)
    assert.match(MAIN_JS, /nodeIntegration:\s*false/)
    for (const flag of ['no-sandbox', 'disable-setuid-sandbox', 'disable-gpu-sandbox']) {
      assert.ok(!new RegExp(`appendSwitch\\(['"]${flag}['"]`).test(MAIN_JS), `不应再追加 --${flag}`)
    }
    // 禁用沙箱的字样只应出现在「检测/告警」逻辑里，不能出现在 appendSwitch 调用里
    const appends = MAIN_JS.match(/appendSwitch\([^)]*\)/g) || []
    assert.ok(appends.every(a => !a.includes('sandbox')), 'appendSwitch 中不应出现 sandbox: ' + appends.join(' | '))
  })

  it('webPreferences 关闭 webview 与不安全内容', () => {
    assert.match(MAIN_JS, /webviewTag:\s*false/)
    assert.match(MAIN_JS, /allowRunningInsecureContent:\s*false/)
    assert.match(MAIN_JS, /webSecurity:\s*true/)
    assert.match(MAIN_JS, /allowRunningInsecureContent:\s*false/)
  })

  it('preload 通过 contextBridge 暴露 API，且不上报 Node require 可用', () => {
    assert.match(PRELOAD_JS, /contextBridge\.exposeInMainWorld/)
    assert.ok(!/nodeIntegration:\s*true/.test(PRELOAD_JS))
  })
})

describe('FIX-14 导航 / 弹窗 / 权限守卫', () => {
  it('安装守卫时会拦截导航、弹窗、重定向与 webview', () => {
    const src = fs.readFileSync(path.join(APP_DIR, 'lib/security/navigation.js'), 'utf8')
    for (const event of ['will-navigate', 'will-redirect', 'setWindowOpenHandler', 'will-attach-webview']) {
      assert.ok(src.includes(event), '导航守卫应处理 ' + event)
    }
    assert.ok(src.includes('setPermissionRequestHandler'), '应默认拒绝权限请求')
    assert.ok(src.includes('setPermissionCheckHandler'))
  })

  it('createNavigationPolicy：内部 file 页面放行，外部按域名白名单', () => {
    const policy = createNavigationPolicy({ appDir: APP_DIR, allowedExternalHosts: ['github.com'] })
    assert.equal(policy.shouldAllowNavigation('file:///' + path.join(APP_DIR, 'index.html').replace(/\\/g, '/')), true)
    assert.equal(policy.shouldAllowNavigation('https://evil.example.com/'), false)
    assert.equal(policy.isAllowedExternal('https://github.com/2048lr/ContextGate'), true)
    assert.equal(policy.isAllowedExternal('http://github.com/'), false, '外部链接只允许 https')
    assert.equal(policy.isAllowedExternal('https://evil.example.com/'), false)
    assert.deepEqual(policy.allowedExternalHosts(), ['github.com'])
  })

  it('installNavigationGuards 对 web-contents-created 生效并拒绝 window.open', () => {
    const handlers = {}
    const contentsHandlers = {}
    const fakeContents = {
      setWindowOpenHandler: fn => { handlers.windowOpen = fn },
      on: (event, fn) => { contentsHandlers[event] = fn },
    }
    const warnings = []
    const guard = installNavigationGuards({
      app: { on: (event, fn) => { handlers[event] = fn } },
      shell: { openExternal: () => Promise.resolve() },
      policy: createNavigationPolicy({ appDir: APP_DIR, allowedExternalHosts: ['github.com'] }),
      logger: { warn: m => warnings.push(m), error: m => warnings.push(m) },
    })
    handlers['web-contents-created']({}, fakeContents)
    assert.equal(typeof handlers.windowOpen, 'function', '守卫应注册 window.open 处理器')
    assert.equal(typeof contentsHandlers['will-navigate'], 'function')
    assert.equal(typeof contentsHandlers['will-redirect'], 'function')
    assert.equal(typeof contentsHandlers['will-attach-webview'], 'function')
    assert.equal(handlers.windowOpen({ url: 'https://evil.example.com' }).action, 'deny')
    assert.equal(handlers.windowOpen({ url: 'https://github.com/' }).action, 'deny', '即使白名单也只交给系统浏览器，不在应用内打开')
    // 权限处理器默认拒绝
    const calls = []
    const applied = guard.applyPermissionHandler({
      setPermissionRequestHandler: fn => calls.push(fn),
      setPermissionCheckHandler: fn => calls.push(fn),
    })
    assert.equal(applied, true)
    assert.equal(calls.length, 2)
    let allowed = null
    calls[0](null, 'media', v => { allowed = v })
    assert.equal(allowed, false)
    assert.equal(calls[1]('camera'), false)
    assert.ok(warnings.length > 0)
  })

  it('normalizeHost 去端口并小写', () => {
    assert.equal(normalizeHost('GitHub.com:443'), 'github.com')
    assert.equal(normalizeHost('  EXAMPLE.com  '), 'example.com')
    assert.deepEqual(DEFAULT_EXTERNAL_HOSTS, ['github.com'])
  })
})

describe('FIX-14 依赖审计入口', () => {
  it('package.json 提供 npm audit 脚本', () => {
    assert.match(PKG.scripts.audit, /npm audit/)
    assert.match(PKG.scripts['audit:prod'], /--omit=dev/)
  })
})
