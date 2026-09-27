const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { CodeScanner, estimateTokens, scoreFile, rankFiles } = require('../lib/scanner/scanner')
const { detectSecrets, IgnoreRules, DEFAULT_IGNORE_PATTERNS } = require('../lib/scanner/ignore')
const { computeContextSignature } = require('../lib/proxy/cache-manager')

// ---------------------------------------------------------------------------
// P0-4 / FIX-05 验收：上下文按 token 预算裁剪 + 二次构建字节稳定 + 不再包含自身
// ---------------------------------------------------------------------------

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-scan-test-'))
  const write = (rel, content) => {
    const file = path.join(root, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  write('.gitignore', 'ignored_root.js\n')
  write('.contextgateignore', 'ignored_cg.js\n')
  write('ignored_root.js', 'SHOULD_NOT_APPEAR_ROOT')
  write('ignored_cg.js', 'SHOULD_NOT_APPEAR_CG')
  write('src/.gitignore', 'nested_ignored.js\n')
  write('src/nested_ignored.js', 'SHOULD_NOT_APPEAR_NESTED')
  write('src/main.js', 'console.log("main")\n'.repeat(60))
  write('src/util.ts', 'export const u = 1\n'.repeat(120))
  write('src/extra.py', 'x = 1\n'.repeat(240))
  write('docs/guide.md', '# guide\n'.repeat(400))
  write('.env', 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz012345')
  write('package-lock.json', '{"lockfileVersion":3}')
  write('big.json', JSON.stringify({ data: 'x'.repeat(400000) }))
  write('leak.js', 'const token = "ghp_' + 'a'.repeat(40) + '"')
  write('README.md', '# readme\n'.repeat(120))
  return root
}

describe('FIX-05 上下文预算与稳定前缀', () => {
  it('产出不超过 max_tokens 预算', async () => {
    const root = fixture()
    try {
      const scanner = new CodeScanner(root, { max_tokens: 8000 })
      const result = await scanner.buildContext(path.join(root, 'out.txt'))
      assert.ok(result.estimatedTokens <= 8000, '实际 ' + result.estimatedTokens)
      assert.equal(result.estimatedTokens, estimateTokens(fs.readFileSync(result.outputPath, 'utf8')))
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('连续两次构建（源码未变）除 manifest 外字节完全一致', async () => {
    const root = fixture()
    try {
      const out = path.join(root, 'out.txt')
      const scanner = new CodeScanner(root, { max_tokens: 4000 })
      await scanner.buildContext(out)
      const first = fs.readFileSync(out)
      await scanner.buildContext(out)
      const second = fs.readFileSync(out)
      assert.ok(first.equals(second), '两次构建产物应逐字节一致（时间戳已移入 manifest）')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('产物首行不再包含时间戳（保证 Prompt Caching 前缀可复用）', async () => {
    const root = fixture()
    try {
      const out = path.join(root, 'out.txt')
      const scanner = new CodeScanner(root, { max_tokens: 4000 })
      await scanner.buildContext(out)
      const prefix = fs.readFileSync(out, 'utf8').split('\n').slice(0, 5).join('\n')
      assert.ok(!/Generated:/i.test(prefix))
      assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(prefix))
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('二次构建不再把产物自身拼进去', async () => {
    const root = fixture()
    try {
      const out = path.join(root, 'full_context.txt')
      const scanner = new CodeScanner(root, { max_tokens: 100000 })
      await scanner.buildContext(out)
      const before = fs.statSync(out).size
      await scanner.buildContext(out)
      const after = fs.statSync(out).size
      assert.equal(before, after, '第二次构建体积不应增长（自包含污染）')
      assert.ok(!fs.readFileSync(out, 'utf8').includes('full_context.txt'))
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('遵守根 .gitignore / 嵌套 .gitignore / .contextgateignore', async () => {
    const root = fixture()
    try {
      const scanner = new CodeScanner(root, { max_tokens: 200000 })
      const result = await scanner.buildContext(path.join(root, 'out.txt'))
      const text = fs.readFileSync(result.outputPath, 'utf8')
      assert.ok(!text.includes('SHOULD_NOT_APPEAR_ROOT'))
      assert.ok(!text.includes('SHOULD_NOT_APPEAR_CG'))
      assert.ok(!text.includes('SHOULD_NOT_APPEAR_NESTED'))
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('.env 与锁文件默认不进上下文', async () => {
    const root = fixture()
    try {
      const scanner = new CodeScanner(root, { max_tokens: 200000 })
      const result = await scanner.buildContext(path.join(root, 'out.txt'))
      const text = fs.readFileSync(result.outputPath, 'utf8')
      assert.ok(!text.includes('OPENAI_API_KEY=sk-'))
      assert.ok(!text.includes('lockfileVersion'))
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('命中凭据的文件被记入 manifest 并告警（不静默）', async () => {
    const root = fixture()
    try {
      const scanner = new CodeScanner(root, { max_tokens: 200000 })
      const result = await scanner.buildContext(path.join(root, 'out.txt'))
      assert.ok(result.secrets.some(s => s.path === 'leak.js' && s.types.includes('github_token')))
      const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
      assert.ok(manifest.secrets.length > 0)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('max_tokens=0 表示全量模式', async () => {
    const root = fixture()
    try {
      const scanner = new CodeScanner(root, { max_tokens: 0 })
      const result = await scanner.buildContext(path.join(root, 'out.txt'))
      assert.ok(result.estimatedTokens > 8000)
      assert.equal(result.manifest.maxTokens, null)
      // 全量模式下不应略过任何候选文件
      assert.equal(result.fileCount, result.totalFiles)
      assert.ok(result.fileCount >= 7)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('XML 格式同样受预算约束', async () => {
    const root = fixture()
    try {
      const scanner = new CodeScanner(root, { max_tokens: 3000 })
      const result = await scanner.buildContext(path.join(root, 'out.xml'), { format: 'xml' })
      assert.equal(result.format, 'xml')
      assert.ok(result.estimatedTokens <= 3000)
      assert.match(fs.readFileSync(result.outputPath, 'utf8'), /^<context /)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('manifest 记录入选与略过的文件', async () => {
    const root = fixture()
    try {
      const scanner = new CodeScanner(root, { max_tokens: 1500 })
      const result = await scanner.buildContext(path.join(root, 'out.txt'))
      const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
      assert.ok(Array.isArray(manifest.included) && manifest.included.length > 0)
      assert.ok(manifest.skipped.length > 0)
      assert.ok(manifest.included.every(i => typeof i.tokens === 'number'))
      assert.ok(typeof manifest.generatedAt === 'string')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('computeContextSignature 能解析新产物（缓存失效判断仍然有效）', async () => {
    const root = fixture()
    try {
      const out = path.join(root, 'out.txt')
      const scanner = new CodeScanner(root, { max_tokens: 4000 })
      await scanner.buildContext(out)
      const sig = computeContextSignature(out, root)
      assert.ok(sig.fileCount > 0, '应从产物中解析出文件列表')
      assert.ok(sig.mainHash)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})

describe('FIX-05 排序启发式', () => {
  it('入口文件与源码文件排在文档/锁文件前面', () => {
    const score = (rel, size) => scoreFile(rel, size)
    assert.ok(score('src/index.ts', 2000) > score('docs/notes.md', 2000))
    assert.ok(score('package.json', 1000) > score('vendor/bundle.js', 1000))
    assert.ok(score('lib/core/util.js', 2000) > score('dist/app.min.js', 2000))
  })

  it('同分时按路径稳定排序（可复现）', () => {
    const entries = [{ rel: 'b.js', size: 100 }, { rel: 'a.js', size: 100 }]
    const ranked = rankFiles(entries)
    assert.deepEqual(ranked.map(e => e.rel), ['a.js', 'b.js'])
    const again = rankFiles(entries)
    assert.deepEqual(again.map(e => e.rel), ['a.js', 'b.js'])
  })

  it('被引用的文件获得更高分', () => {
    const refs = new Map([['lib/core/util.js', 4]])
    const withRefs = rankFiles([{ rel: 'lib/core/util.js', size: 2000 }], { references: refs })[0]
    const without = rankFiles([{ rel: 'lib/core/util.js', size: 2000 }])[0]
    assert.ok(withRefs.score > without.score)
  })
})

describe('FIX-05 凭据扫描', () => {
  it('识别常见凭据类型', () => {
    assert.deepEqual(detectSecrets('-----BEGIN RSA PRIVATE KEY-----'), ['private_key'])
    assert.ok(detectSecrets('AKIAIOSFODNN7EXAMPLE').includes('aws_access_key'))
    assert.ok(detectSecrets('token: "ghp_' + 'b'.repeat(40) + '"').includes('github_token'))
    assert.ok(detectSecrets('api_key = "sk-proj-abcdefghijklmnopqrstuvwx"').length > 0)
  })

  it('占位符不算凭据', () => {
    assert.deepEqual(detectSecrets('api_key: "your-api-key-here"'), [])
    assert.deepEqual(detectSecrets('const key = "sk-xxx"'), [])
    assert.deepEqual(detectSecrets('nothing to see here'), [])
  })
})

describe('IgnoreRules', () => {
  it('默认忽略 .env / 锁文件 / 私钥', () => {
    const rules = new IgnoreRules(process.cwd())
    assert.ok(rules.ignores('.env'))
    assert.ok(rules.ignores('.env.local'))
    assert.ok(rules.ignores('package-lock.json'))
    assert.ok(rules.ignores('certs/server.key'))
    assert.ok(rules.matchesEnvFile('.env.production'))
    assert.ok(!rules.ignores('src/main.js'))
  })

  it('DEFAULT_IGNORE_PATTERNS 非空且包含 .env', () => {
    assert.ok(DEFAULT_IGNORE_PATTERNS.includes('.env'))
  })
})
