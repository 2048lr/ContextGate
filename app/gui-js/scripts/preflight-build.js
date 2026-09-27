#!/usr/bin/env node
/**
 * 打包前置校验：确认目标架构确实是当前 Electron 版本会发布的产物。
 *
 * 背景：Electron 从 44 起彻底移除了 32 位 Windows 构建（官方只发布 win32-x64 与
 * win32-arm64）。若 package.json 里仍写着 ia32，electron-builder 会去下载
 * electron-v44.x.y-win32-ia32.zip 并 404，报错信息完全不指向真实原因。
 * 这个脚本把它变成一句明确的前置失败。
 *
 * 用法（由 npm 的 prebuild:win* 钩子自动调用）：
 *   node scripts/preflight-build.js [--x64|--arm64|--ia32]
 */
const fs = require('fs')
const path = require('path')

const APP_DIR = path.join(__dirname, '..')

// Electron 44 是最后一个……不，是第一个不再发布 win32-ia32 的大版本
const WIN32_IA32_DROPPED_IN = 44
const ALL_WIN32_ARCHES = ['x64', 'ia32', 'arm64']

/** 从已安装的 electron 包读取版本 */
function readElectronVersion(appDir = APP_DIR) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDir, 'node_modules', 'electron', 'package.json'), 'utf8')).version
  } catch { return null }
}

/** 从已安装的 electron 包读取声明的版本（declared 范围，用于离线兜底判断） */
function readElectronRange(appDir = APP_DIR) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).devDependencies.electron
  } catch { return null }
}

function majorOf(version) {
  const m = String(version || '').match(/^\D*(\d+)/)
  return m ? Number(m[1]) : null
}

/**
 * 该 Electron 版本实际发布了哪些 win32 架构。
 * 优先使用 electron 包自带的 checksums.json（离线、权威）；不可用时退回版本规则。
 */
function supportedWin32Arches(electronVersion, appDir = APP_DIR) {
  const major = majorOf(electronVersion)
  try {
    const checksums = JSON.parse(fs.readFileSync(path.join(appDir, 'node_modules', 'electron', 'checksums.json'), 'utf8'))
    const versionInFile = (Object.keys(checksums)[0] || '').match(/-v(\d+\.\d+\.\d+)-/)
    // checksums.json 只覆盖它自己那一版；版本对不上就不要用它下结论
    if (!versionInFile || versionInFile[1] === String(electronVersion)) {
      const arches = new Set()
      for (const key of Object.keys(checksums)) {
        const m = key.match(/^electron-v[\d.]+-win32-([a-z0-9]+)\.zip$/)
        if (m) arches.add(m[1])
      }
      if (arches.size > 0) return [...arches].sort()
    }
  } catch { /* 没有 checksums.json 时走规则兜底 */ }
  if (major === null) return ALL_WIN32_ARCHES.slice()
  return major >= WIN32_IA32_DROPPED_IN ? ['arm64', 'x64'] : ['arm64', 'ia32', 'x64']
}

/** 从 build.win.target 里收集所有声明的架构 */
function declaredWinArches(buildConfig) {
  const found = new Set()
  const targets = buildConfig?.win?.target
  const list = Array.isArray(targets) ? targets : (targets ? [targets] : [])
  for (const t of list) {
    const arches = typeof t === 'string' ? null : t?.arch
    if (Array.isArray(arches)) for (const a of arches) found.add(String(a).toLowerCase())
    else if (typeof arches === 'string') found.add(arches.toLowerCase())
  }
  return [...found]
}

/** 从命令行参数里收集架构 */
function cliArches(argv) {
  const found = []
  for (const arg of argv) {
    const m = String(arg).match(/^--(x64|ia32|arm64|armv7l|arm)$/)
    if (m) found.push(m[1] === 'arm' ? 'armv7l' : m[1])
  }
  return found
}

/**
 * @returns {{ ok: boolean, electronVersion: string|null, supported: string[], invalid: string[] }}
 */
function checkArches({ electronVersion, declared = [], requested = [], appDir = APP_DIR }) {
  const supported = supportedWin32Arches(electronVersion, appDir)
  const wanted = [...new Set([...declared, ...requested])]
  const invalid = wanted.filter(a => !supported.includes(a))
  return { ok: invalid.length === 0, electronVersion: electronVersion || null, supported, invalid }
}

function main(argv = process.argv.slice(2)) {
  const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'))
  const electronVersion = readElectronVersion()
  const range = readElectronRange()
  const result = checkArches({
    electronVersion,
    declared: declaredWinArches(pkg.build),
    requested: cliArches(argv),
  })

  if (!result.ok) {
    console.error('\n✖ 打包前置校验失败：请求了当前 Electron 版本并不存在的 Windows 架构。\n')
    console.error(`  Electron:            ${electronVersion || '未安装（' + (range || '?') + '）'}`)
    console.error(`  本次请求的架构:      ${result.invalid.join(', ')}`)
    console.error(`  该版本实际可用架构:  ${result.supported.join(', ')}`)
    if (result.invalid.includes('ia32')) {
      console.error('\n  原因：Electron 从 44 起已彻底移除 32 位 Windows 构建（官方只发布 win32-x64 / win32-arm64）。')
      console.error('  处理：从 package.json 的 build.win.target[].arch 与 npm scripts 中移除 ia32，然后重新打包。')
      console.error('  若确实必须发布 32 位版本，唯一办法是把 electron 固定到 43.x（最后一个发布 win32-ia32 的大版本），')
      console.error('  但这会放弃后续的安全更新，请自行评估。')
    }
    console.error('')
    process.exit(1)
  }

  console.log(`[preflight] Electron ${result.electronVersion} 可用 Windows 架构: ${result.supported.join(', ')} — 校验通过`)
}

module.exports = {
  WIN32_IA32_DROPPED_IN,
  ALL_WIN32_ARCHES,
  readElectronVersion,
  readElectronRange,
  majorOf,
  supportedWin32Arches,
  declaredWinArches,
  cliArches,
  checkArches,
  main,
}

if (require.main === module) main()
