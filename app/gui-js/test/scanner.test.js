const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { IntentExtractor } = require('../lib/scanner/intent')
const { CodeScanner } = require('../lib/scanner/scanner')
const { DEFAULT_EXTENSIONS, BINARY_EXTENSIONS, EXCLUDE_DIRS, FILE_EXTENSION_MAP } = require('../lib/scanner/constants')

describe('IntentExtractor', () => {
  it('should extract file references from prompt', () => {
    const e = new IntentExtractor('Fix the bug in auth.js and user.ts')
    assert.ok(e.fileReferences.length > 0)
    assert.ok(e.fileReferences.some(f => f.includes('auth.js')))
    assert.ok(e.fileReferences.some(f => f.includes('user.ts')))
  })

  it('should extract intents from prompt', () => {
    const e = new IntentExtractor('I need to implement user authentication with JWT tokens')
    assert.ok(e.intents.length > 0)
    const names = e.intents.map(i => i.name)
    assert.ok(names.includes('auth'))
    assert.ok(names.includes('user'))
  })

  it('should extract module references', () => {
    const e = new IntentExtractor('Update the AuthService and UserController')
    assert.ok(e.moduleReferences.length > 0)
  })

  it('should extract code concepts', () => {
    const e = new IntentExtractor('Create a new class for handling errors')
    assert.ok(e.codeConcepts.includes('class'))
    assert.ok(e.codeConcepts.includes('error'))
  })

  it('should handle empty prompt', () => {
    const e = new IntentExtractor('')
    assert.equal(e.intents.length, 0)
    assert.equal(e.fileReferences.length, 0)
  })

  it('should return all keywords combined', () => {
    const e = new IntentExtractor('Fix auth.js login bug')
    const kw = e.getAllKeywords()
    assert.ok(Array.isArray(kw))
    assert.ok(kw.length > 0)
  })
})

describe('CodeScanner', () => {
  it('should scan a project directory', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'))
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'const a = 1')
    fs.writeFileSync(path.join(tmpDir, 'b.py'), 'b = 2')
    fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'c.js'), 'const c = 3')
    try {
      const scanner = new CodeScanner(tmpDir)
      const files = await scanner.scan()
      assert.ok(files.some(f => f.includes('a.js')))
      assert.ok(files.some(f => f.includes('b.py')))
      assert.ok(!files.some(f => f.includes('node_modules')))
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }) }
  })

  it('should build context file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'))
    fs.writeFileSync(path.join(tmpDir, 'hello.js'), 'console.log("hello")')
    const outputPath = path.join(tmpDir, 'context.txt')
    try {
      const scanner = new CodeScanner(tmpDir)
      const result = await scanner.buildContext(outputPath)
      assert.ok(result.fileCount >= 1)
      assert.ok(result.totalChars > 0)
      assert.ok(fs.existsSync(outputPath))
      assert.ok(fs.readFileSync(outputPath, 'utf8').includes('hello.js'))
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }) }
  })
})

describe('Constants', () => {
  it('should have DEFAULT_EXTENSIONS', () => {
    assert.ok(Array.isArray(DEFAULT_EXTENSIONS))
    assert.ok(DEFAULT_EXTENSIONS.includes('.js'))
    assert.ok(DEFAULT_EXTENSIONS.includes('.py'))
  })

  it('should have BINARY_EXTENSIONS as Set', () => {
    assert.ok(BINARY_EXTENSIONS instanceof Set)
    assert.ok(BINARY_EXTENSIONS.has('.png'))
  })

  it('should have EXCLUDE_DIRS as Set', () => {
    assert.ok(EXCLUDE_DIRS instanceof Set)
    assert.ok(EXCLUDE_DIRS.has('node_modules'))
  })

  it('should have FILE_EXTENSION_MAP', () => {
    assert.equal(FILE_EXTENSION_MAP['.js'], 'javascript')
    assert.equal(FILE_EXTENSION_MAP['.py'], 'python')
  })
})
