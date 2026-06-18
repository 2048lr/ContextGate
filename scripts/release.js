#!/usr/bin/env node
/**
 * release.js - 版本发布流程自动化工具
 *
 * 用法:
 *   node scripts/release.js              # 交互式发布
 *   node scripts/release.js --patch      # 补丁版本发布
 *   node scripts/release.js --minor      # 次版本发布
 *   node scripts/release.js --major      # 主版本发布
 *
 * 流程:
 *   1. 检查工作区是否干净
 *   2. 运行测试
 *   3. 检查版本一致性
 *   4. 递增版本号
 *   5. 创建 Git 提交和标签
 *   6. 输出构建和推送指令
 */

const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const PACKAGE_JSON = path.join(PROJECT_ROOT, 'app', 'gui-js', 'package.json')

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: PROJECT_ROOT, encoding: 'utf8', ...opts }).trim()
}

function runInherit(cmd, opts = {}) {
  execSync(cmd, { cwd: PROJECT_ROOT, stdio: 'inherit', ...opts })
}

function getCurrentVersion() {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).version
}

function gitIsClean() {
  const status = run('git status --porcelain')
  return status.length === 0
}

function main() {
  const arg = process.argv[2] || ''
  const type = arg.replace('--', '')

  if (!['', 'patch', 'minor', 'major'].includes(type)) {
    console.error('Usage: node scripts/release.js [--patch|--minor|--major]')
    process.exit(1)
  }

  console.log('\n  === ContextGate Release Process ===\n')

  // Step 1: 检查工作区
  console.log('  [1/6] Checking working tree...')
  if (!gitIsClean()) {
    console.error('  ✗ Working tree is not clean. Please commit or stash changes first.')
    console.error('    ' + run('git status --short'))
    process.exit(1)
  }
  console.log('  ✓ Working tree is clean')

  // Step 2: 运行测试
  console.log('  [2/6] Running tests...')
  try {
    runInherit('node --test test/proxy.test.js test/monitor.test.js test/scanner.test.js', {
      cwd: path.join(PROJECT_ROOT, 'app', 'gui-js'),
    })
  } catch (e) {
    console.error('  ✗ Tests failed. Aborting release.')
    process.exit(1)
  }
  console.log('  ✓ All tests passed')

  // Step 3: 检查版本一致性
  console.log('  [3/6] Checking version consistency...')
  try {
    runInherit('node scripts/version-sync.js --check')
  } catch (e) {
    console.error('  ✗ Version consistency check failed.')
    process.exit(1)
  }
  console.log('  ✓ Versions are consistent')

  // Step 4: 递增版本号
  const currentVersion = getCurrentVersion()
  const bumpType = type || 'patch'
  console.log(`  [4/6] Bumping version (${bumpType})...`)
  try {
    runInherit(`node scripts/version-bump.js ${bumpType}`)
  } catch (e) {
    console.error('  ✗ Version bump failed.')
    process.exit(1)
  }
  const newVersion = getCurrentVersion()
  console.log(`  ✓ Version: ${currentVersion} → ${newVersion}`)

  // Step 5: Git 提交和标签
  console.log('  [5/6] Creating Git commit and tag...')
  try {
    run('git add -A')
    run(`git commit -m "release: v${newVersion}"`)
    run(`git tag -a v${newVersion} -m "Release v${newVersion}"`)
  } catch (e) {
    console.error('  ✗ Git operations failed:', e.message)
    process.exit(1)
  }
  console.log(`  ✓ Created commit and tag v${newVersion}`)

  // Step 6: 输出后续指令
  console.log('  [6/6] Next steps (manual):')
  console.log(`    1. Build:  cd app/gui-js && npm run build:win`)
  console.log(`    2. Push:   git push && git push --tags`)
  console.log(`    3. Create GitHub Release with dist/ artifacts`)
  console.log('')
  console.log('  To rollback this release:')
  console.log(`    git tag -d v${newVersion}`)
  console.log(`    git reset --hard HEAD~1`)
  console.log('')
}

main()
