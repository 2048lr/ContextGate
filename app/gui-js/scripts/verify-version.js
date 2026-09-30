#!/usr/bin/env node
/**
 * FIX-19：版本一致性校验。
 *
 * 背景（P2-5 / P2-11）：package.json 到过 5.5.0，而 dist 里的产物与 Release 资产
 * 还停在 5.3.1，文件名甚至写着 5.2.8。发布与代码脱节会直接摧毁版本可信度。
 * 这个脚本把「仓库内所有声明版本的地方」放在一起比对，任何一个不一致就以非零码退出。
 *
 * 用法：node scripts/verify-version.js
 */
const fs = require('fs')
const path = require('path')

const APP_DIR = path.join(__dirname, '..')
const REPO_DIR = path.join(APP_DIR, '..', '..')

function readJson (file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function readText (file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return null }
}

/** package.json 的 version */
function packageVersion (appDir = APP_DIR) {
  const pkg = readJson(path.join(appDir, 'package.json'))
  return pkg ? pkg.version : null
}

/** index.html 的 <meta name="version" content="..."> */
function indexHtmlVersion (appDir = APP_DIR) {
  const html = readText(path.join(appDir, 'index.html'))
  if (!html) return null
  const m = html.match(/<meta\s+name=["']version["']\s+content=["']([^"']+)["']/i)
  return m ? m[1] : null
}

/** README 徽章 version-X.Y.Z */
function readmeBadgeVersion (repoDir = REPO_DIR) {
  const readme = readText(path.join(repoDir, 'README.md'))
  if (!readme) return null
  const m = readme.match(/badge\/version-([0-9][0-9A-Za-z.\-]*)/)
  return m ? m[1] : null
}

/** package-lock.json 根包版本（npm install 会同步，漏同步说明手工改了 package.json） */
function lockfileVersion (appDir = APP_DIR) {
  const lock = readJson(path.join(appDir, 'package-lock.json'))
  if (!lock) return null
  return lock.version || (lock.packages && lock.packages[''] && lock.packages[''].version) || null
}

/**
 * 收集所有「声明版本的地方」。
 * @returns {{ ok: boolean, expected: string|null, sources: Array<{name:string, path:string, version:string|null}> }}
 */
function collectVersions (options = {}) {
  const appDir = options.appDir || APP_DIR
  const repoDir = options.repoDir || REPO_DIR
  const sources = [
    { name: 'package.json', path: path.join(appDir, 'package.json'), version: packageVersion(appDir) },
    { name: 'package-lock.json', path: path.join(appDir, 'package-lock.json'), version: lockfileVersion(appDir) },
    { name: 'index.html <meta version>', path: path.join(appDir, 'index.html'), version: indexHtmlVersion(appDir) },
    { name: 'README.md badge', path: path.join(repoDir, 'README.md'), version: readmeBadgeVersion(repoDir) },
  ]
  const expected = sources[0].version
  const ok = Boolean(expected) && sources.every(s => s.version === expected)
  return { ok, expected, sources }
}

/** dist 产物文件名里出现的版本号（可选检查，dist 不存在时跳过） */
function distArtifactVersions (appDir = APP_DIR) {
  const dist = path.join(appDir, 'dist')
  let entries = []
  try { entries = fs.readdirSync(dist) } catch { return [] }
  const found = []
  for (const name of entries) {
    const m = name.match(/([0-9]+\.[0-9]+\.[0-9]+)/)
    if (m) found.push({ name, version: m[1] })
  }
  return found
}

function main () {
  const { ok, expected, sources } = collectVersions()
  const width = Math.max(...sources.map(s => s.name.length))
  console.log('\nContextGate 版本一致性校验\n')
  for (const s of sources) {
    const status = s.version === expected ? '✔' : '✖'
    console.log('  ' + status + ' ' + s.name.padEnd(width) + '  ' + (s.version || '(缺失)'))
  }
  const dist = distArtifactVersions()
  const stale = dist.filter(a => a.version !== expected)
  if (stale.length > 0) {
    console.log('\n  ⚠ dist/ 中的历史产物版本与当前版本不一致（不会被发布，仅提示清理）：')
    for (const a of stale) console.log('      - ' + a.name + ' → ' + a.version)
  }
  if (!ok) {
    console.error('\n✖ 版本不一致：期望全部为 ' + (expected || '(无法确定)') + '，请同步 package.json / package-lock.json / index.html / README.md。\n')
    process.exit(1)
  }
  console.log('\n✔ 版本一致：' + expected + '\n')
}

module.exports = {
  packageVersion, indexHtmlVersion, readmeBadgeVersion, lockfileVersion,
  collectVersions, distArtifactVersions, main,
}

if (require.main === module) main()
