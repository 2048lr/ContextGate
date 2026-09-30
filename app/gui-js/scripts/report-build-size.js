#!/usr/bin/env node
/**
 * FIX-16：打包体积报告。
 *
 * 用于回答「150MB 安装包里到底是什么」。列出 dist 产物、解包目录里的 app.asar
 * 与体积最大的若干文件，方便判断 files 过滤是否生效、哪些依赖最占地方。
 *
 * 用法：node scripts/report-build-size.js [--top 15]
 */
const fs = require('fs')
const path = require('path')

const APP_DIR = path.join(__dirname, '..')
const DIST = path.join(APP_DIR, 'dist')
const ARTIFACT_EXT = new Set(['.exe', '.msi', '.blockmap', '.yml', '.zip', '.dmg', '.appimage', '.deb', '.rpm'])

function human (bytes) {
  let n = Number(bytes) || 0
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    if (n < 1024) return n.toFixed(2) + ' ' + unit
    n /= 1024
  }
  return n.toFixed(2) + ' TB'
}

/** 递归收集文件大小（不跟随符号链接） */
function walk (dir, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) {
      try { out.push({ path: full, size: fs.statSync(full).size }) } catch { /* 忽略读不到的条目 */ }
    }
  }
  return out
}

/** dist 根目录下的产物（安装包 / 更新元数据 / 便携版） */
function listArtifacts (distDir = DIST) {
  let entries
  try { entries = fs.readdirSync(distDir, { withFileTypes: true }) } catch { return [] }
  const artifacts = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const ext = path.extname(entry.name).toLowerCase()
    const isTarGz = entry.name.endsWith('.tar.gz')
    if (!ARTIFACT_EXT.has(ext) && !isTarGz) continue
    const full = path.join(distDir, entry.name)
    try { artifacts.push({ name: entry.name, size: fs.statSync(full).size }) } catch { /* 忽略 */ }
  }
  return artifacts.sort((a, b) => b.size - a.size)
}

function report (options = {}) {
  const distDir = options.distDir || DIST
  const top = Number(options.top) > 0 ? Math.floor(Number(options.top)) : 15
  const artifacts = listArtifacts(distDir)
  const all = walk(distDir)
  const asar = all.find(f => f.path.endsWith('app.asar'))
  const biggest = [...all].sort((a, b) => b.size - a.size).slice(0, top)
  return {
    distDir,
    artifacts,
    totalBytes: all.reduce((sum, f) => sum + f.size, 0),
    asarBytes: asar ? asar.size : 0,
    asarPath: asar ? asar.path : null,
    biggest,
  }
}

function main () {
  const argv = process.argv.slice(2)
  const topIdx = argv.indexOf('--top')
  const data = report({ top: topIdx !== -1 ? Number(argv[topIdx + 1]) : 15 })
  if (data.artifacts.length === 0 && data.totalBytes === 0) {
    console.error('未找到 dist 目录或其中没有产物：' + data.distDir)
    process.exit(1)
  }
  console.log('\nContextGate 打包体积报告\n')
  console.log('dist: ' + data.distDir)
  console.log('解包总体积: ' + human(data.totalBytes) + '    app.asar: ' + (data.asarBytes ? human(data.asarBytes) : '(未解包)') + '\n')
  if (data.artifacts.length > 0) {
    console.log('产物：')
    for (const a of data.artifacts) console.log('  ' + human(a.size).padStart(10) + '  ' + a.name)
    console.log('')
  }
  console.log('体积最大的 ' + data.biggest.length + ' 个文件：')
  for (const f of data.biggest) console.log('  ' + human(f.size).padStart(10) + '  ' + path.relative(APP_DIR, f.path))
  console.log('')
}

module.exports = { report, listArtifacts, walk, human }

if (require.main === module) main()
