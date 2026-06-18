#!/usr/bin/env node
/**
 * version-bump.js - 版本号递增工具
 *
 * 用法:
 *   node scripts/version-bump.js patch  # 5.2.9 → 5.2.10
 *   node scripts/version-bump.js minor  # 5.2.9 → 5.3.0
 *   node scripts/version-bump.js major  # 5.2.9 → 6.0.0
 *
 * 流程:
 *   1. 读取当前版本号
 *   2. 按规则递增
 *   3. 调用 version-sync.js 同步到所有文件
 *   4. 输出下一步操作提示
 */

const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const PACKAGE_JSON = path.join(PROJECT_ROOT, 'app', 'gui-js', 'package.json')

function getCurrentVersion() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'))
  return pkg.version
}

function bumpVersion(current, type) {
  const parts = current.split('.').map(Number)
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid version format: ${current}`)
  }
  let [major, minor, patch] = parts
  switch (type) {
    case 'major': major++; minor = 0; patch = 0; break
    case 'minor': minor++; patch = 0; break
    case 'patch': patch++; break
    default: throw new Error(`Unknown bump type: ${type}. Use patch/minor/major.`)
  }
  return `${major}.${minor}.${patch}`
}

function main() {
  const type = process.argv[2]
  if (!['patch', 'minor', 'major'].includes(type)) {
    console.error('Usage: node scripts/version-bump.js <patch|minor|major>')
    process.exit(1)
  }

  const currentVersion = getCurrentVersion()
  const newVersion = bumpVersion(currentVersion, type)

  console.log(`\n  Bumping version: ${currentVersion} → ${newVersion} (${type})\n`)

  // 调用 version-sync.js 同步版本号
  try {
    execSync(`node "${path.join(__dirname, 'version-sync.js')}" ${newVersion}`, {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    })
  } catch (e) {
    console.error('Version sync failed:', e.message)
    process.exit(1)
  }

  console.log(`\n  Version bumped to ${newVersion} successfully.`)
  console.log(`\n  Next steps:`)
  console.log(`    1. Update CHANGELOG in README.md`)
  console.log(`    2. Run: npm test  (in app/gui-js)`)
  console.log(`    3. Commit: git add -A && git commit -m "release: v${newVersion}"`)
  console.log(`    4. Tag:    git tag v${newVersion}`)
  console.log(`    5. Build:  cd app/gui-js && npm run build:win`)
  console.log(`    6. Push:   git push && git push --tags`)
  console.log('')
}

main()
