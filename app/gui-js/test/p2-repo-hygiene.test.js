const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const { collectVersions } = require('../scripts/verify-version')

// ---------------------------------------------------------------------------
// FIX-19 验收：仓库卫生与工程基建
//   - 版本号在 package / lock / index.html / README 一致
//   - 死代码已删除
//   - CI 工作流存在且覆盖 lint/test/版本校验/打包
//   - .gitignore / .npmrc 清理
// ---------------------------------------------------------------------------

const APP_DIR = path.join(__dirname, '..')
const REPO_DIR = path.join(APP_DIR, '..', '..')
const PKG = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'))

function repoFile(rel) {
  const file = path.join(REPO_DIR, rel)
  assert.ok(fs.existsSync(file), '缺少 ' + rel)
  return fs.readFileSync(file, 'utf8')
}

describe('FIX-19 版本一致性', () => {
  it('package.json / package-lock.json / index.html / README 版本号一致', () => {
    const { ok, expected, sources } = collectVersions()
    const mismatched = sources.filter(s => s.version !== expected).map(s => s.name + '=' + s.version)
    assert.equal(ok, true, '版本不一致: ' + mismatched.join(', '))
    assert.match(expected, /^\d+\.\d+\.\d+$/)
  })

  it('提供 verify:version 脚本与实现', () => {
    assert.match(PKG.scripts['verify:version'], /verify-version\.js/)
    assert.match(PKG.scripts['verify:package'], /preflight-build\.js/)
  })
})

describe('FIX-19 死代码清理', () => {
  for (const rel of ['lib/core/service-container.js', 'lib/ui/app.js', 'lib/ui/toast.js']) {
    it('已删除 ' + rel, () => {
      assert.equal(fs.existsSync(path.join(APP_DIR, rel)), false)
    })
  }
  it('源码中不再引用这些模块', () => {
    const root = path.join(APP_DIR, 'lib')
    const stack = [root]
    const offenders = []
    while (stack.length) {
      const dir = stack.pop()
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { stack.push(full); continue }
        if (!entry.name.endsWith('.js')) continue
        const text = fs.readFileSync(full, 'utf8')
        if (/service-container|lib\/ui\/app|lib\/ui\/toast|['"]\.\/app['"]|['"]\.\/toast['"]/.test(text)) offenders.push(path.relative(APP_DIR, full))
      }
    }
    assert.deepEqual(offenders, [])
  })
  it('renderer 只加载一个渲染层实现', () => {
    const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8')
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1])
    assert.deepEqual(scripts, ['renderer.js'])
  })
})

describe('FIX-19 CI 与发布流程', () => {
  it('存在 CI 工作流并覆盖 lint / 测试 / 版本校验', () => {
    const ci = repoFile('.github/workflows/ci.yml')
    assert.match(ci, /npm ci/)
    assert.match(ci, /npm run lint/)
    assert.match(ci, /npm test/)
    assert.match(ci, /verify:version/)
    assert.match(ci, /npm audit/)
    assert.match(ci, /prebuild:win/)
  })

  it('存在 Release 工作流，三平台构建并发布资产', () => {
    const release = repoFile('.github/workflows/release.yml')
    assert.match(release, /tags: \['v\*'\]/)
    assert.match(release, /build:win/)
    assert.match(release, /build:linux/)
    assert.match(release, /build:mac/)
    assert.match(release, /softprops\/action-gh-release/)
  })

  it('性能基线测试存在', () => {
    assert.ok(fs.existsSync(path.join(APP_DIR, 'test/perf-baseline.test.js')))
  })
})

describe('FIX-19 仓库卫生', () => {
  it('.gitignore 显式忽略 .claude/ 与 .dsh-backup/，并包含数据库', () => {
    const ignore = repoFile('.gitignore')
    assert.match(ignore, /^\.claude\/$/m)
    assert.match(ignore, /^\.dsh-backup\/$/m)
    assert.match(ignore, /^contextgate\.db$/m)
  })

  it('.npmrc 不再使用已废弃的 electron_mirror 配置项', () => {
    const npmrc = fs.readFileSync(path.join(APP_DIR, '.npmrc'), 'utf8')
    assert.ok(!/^electron_mirror=/m.test(npmrc), 'electron_mirror 已被 npm 标记为未知配置')
    assert.ok(!/^electron_builder_binaries_mirror=/m.test(npmrc))
    assert.match(npmrc, /ELECTRON_MIRROR/)
  })

  it('打包 files 过滤排除测试/文档/缓存/历史产物', () => {
    const files = PKG.build.files
    for (const pattern of ['!test/**', '!docs/**', '!dist/**', '!.npm-cache/**']) {
      assert.ok(files.includes(pattern), '缺少 files 过滤: ' + pattern)
    }
    assert.equal(PKG.build.asar, true)
    assert.equal(PKG.build.compression, 'maximum')
  })

  it('发布元数据与增量更新通道已配置', () => {
    assert.ok(Array.isArray(PKG.build.publish) && PKG.build.publish.length > 0)
    assert.equal(PKG.build.generateUpdatesFilesForAllChannels, true)
    assert.ok(PKG.dependencies['electron-updater'], '应把 electron-updater 作为运行时依赖')
    assert.equal(PKG.build.nsis.differentialPackage, true)
  })
})
