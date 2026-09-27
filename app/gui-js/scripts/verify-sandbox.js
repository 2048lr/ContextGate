#!/usr/bin/env node
/**
 * FIX-S1 的可复现验收脚本：在真实 Electron 运行时里检查沙箱与上下文隔离。
 *
 * 用法：
 *   npm run verify:sandbox          # 在 app/gui-js 下
 *   node scripts/verify-sandbox.js
 *
 * 设计说明：Windows 上 Electron 是 GUI 子系统程序，stdout 不一定被父进程捕获，
 * 因此子进程把结果写入 .sandbox-report.json，由 Node 驱动进程读取并打印。
 */
const fs = require('fs')
const path = require('path')

const REPORT_PATH = path.join(__dirname, '..', '.sandbox-report.json')

function collectRendererState(win) {
  return win.webContents.executeJavaScript(
    '({ sandboxed: process.sandboxed, contextIsolated: process.contextIsolated, hasRequire: typeof require, hasProcess: typeof process })',
  )
}

async function runChild() {
  const { app, BrowserWindow, session } = require('electron')
  const { createNavigationPolicy, installNavigationGuards } = require('../lib/security/navigation')

  app.enableSandbox()

  const report = { ok: false, checks: [], startedAt: new Date().toISOString() }
  const add = (name, pass, detail) => { report.checks.push({ name, pass, detail }); return pass }

  await app.whenReady()

  const policy = createNavigationPolicy({ appDir: __dirname, isDev: true })
  const guards = installNavigationGuards({ app, shell: require('electron').shell, policy, logger: { warn() {}, error() {} } })
  guards.applyPermissionHandler(session.defaultSession)

  add('命令行未出现 no-sandbox', !app.commandLine.hasSwitch('no-sandbox'), app.commandLine.hasSwitch('no-sandbox') ? 'hasSwitch=true' : 'hasSwitch=false')
  add('命令行未出现 disable-setuid-sandbox', !app.commandLine.hasSwitch('disable-setuid-sandbox'), '')
  add('命令行未出现 disable-gpu-sandbox', !app.commandLine.hasSwitch('disable-gpu-sandbox'), '')

  try {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false,
        preload: path.join(__dirname, 'verify-sandbox-preload.js'),
      },
    })
    await win.loadFile(path.join(__dirname, 'verify-sandbox.html'))
    const state = await collectRendererState(win)
    add('渲染进程 sandboxed === true', state.sandboxed === true, JSON.stringify(state))
    add('渲染进程 contextIsolated === true', state.contextIsolated === true, '')
    add('渲染进程没有 Node require', state.hasRequire !== 'function', 'typeof require = ' + state.hasRequire)
    report.renderer = state
    win.destroy()
  } catch (e) {
    add('渲染进程检查', false, e.message)
  }

  // 导航策略自检
  try {
    add('拒绝 file:// 之外的导航', policy.shouldAllowNavigation('https://evil.example/') === false, '')
    add('允许应用自身 file:// 页面', policy.shouldAllowNavigation(require('url').pathToFileURL(path.join(__dirname, '..', 'index.html')).href) === true, '')
  } catch (e) {
    add('导航策略检查', false, e.message)
  }

  report.electron = process.versions.electron
  report.chrome = process.versions.chrome
  report.node = process.versions.node
  report.ok = report.checks.every(c => c.pass)
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8')
  app.exit(report.ok ? 0 : 1)
}

function runDriver() {
  let electronPath
  try { electronPath = require('electron') } catch { electronPath = null }
  if (typeof electronPath !== 'string') {
    console.error('找不到 Electron 可执行文件，请先在 app/gui-js 下运行 npm install。')
    process.exit(1)
  }
  try { fs.unlinkSync(REPORT_PATH) } catch { /* 首次运行没有旧报告 */ }
  const { spawnSync } = require('child_process')
  // stdio: 'inherit' 而不是 pipe —— 受限环境下管道捕获会 EPERM
  const child = spawnSync(electronPath, [__filename], { stdio: 'inherit' })
  let report = null
  try { report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8')) } catch { /* 子进程没有写出报告 */ }
  if (!report) {
    console.error('\n✖ 未取得沙箱报告（Electron 可能无法在当前会话启动窗口）。')
    console.error('  请在带桌面会话的环境下运行：npm run verify:sandbox')
    process.exit(child.status === 0 ? 1 : (child.status || 1))
  }
  console.log('\nContextGate 沙箱验收报告')
  console.log('Electron ' + report.electron + ' / Chromium ' + report.chrome + ' / Node ' + report.node)
  for (const c of report.checks) console.log((c.pass ? '  ✔ ' : '  ✖ ') + c.name + (c.pass || !c.detail ? '' : '  (' + c.detail + ')'))
  console.log(report.ok ? '\n✔ 沙箱与导航守卫均符合预期\n' : '\n✖ 存在未通过的检查项\n')
  process.exit(report.ok ? 0 : 1)
}

if (process.versions.electron) runChild()
else runDriver()
