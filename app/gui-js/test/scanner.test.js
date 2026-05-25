const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { IntentExtractor } = require('../lib/scanner/intent')
const { CodeBlockExtractor, FileExtractor } = require('../lib/scanner/extractor')
const { CodeStructureAnalyzer, TfIdfScorer } = require('../lib/scanner/analyzer')
const { RelevanceScorer } = require('../lib/scanner/scorer')
const { SmartContextExtractor, ContextExtractor } = require('../lib/scanner/smart-extractor')
const { CodeScanner } = require('../lib/scanner')
const {
  DEFAULT_EXTENSIONS, BINARY_EXTENSIONS, EXCLUDE_DIRS,
  INTENT_PATTERNS, CODE_BLOCK_SIGNATURES, FILE_EXTENSION_MAP
} = require('../lib/scanner/constants')

describe('IntentExtractor', () => {
  it('should extract file references from prompt', () => {
    const extractor = new IntentExtractor('Fix the bug in auth.js and user.ts')
    assert.ok(extractor.fileReferences.length > 0)
    assert.ok(extractor.fileReferences.some(f => f.includes('auth.js')))
    assert.ok(extractor.fileReferences.some(f => f.includes('user.ts')))
  })

  it('should extract intents from prompt', () => {
    const extractor = new IntentExtractor('I need to implement user authentication with JWT tokens')
    assert.ok(extractor.intents.length > 0)
    const intentNames = extractor.intents.map(i => i.name)
    assert.ok(intentNames.includes('auth'))
    assert.ok(intentNames.includes('user'))
  })

  it('should extract module references', () => {
    const extractor = new IntentExtractor('Update the AuthService and UserController')
    assert.ok(extractor.moduleReferences.length > 0)
    assert.ok(extractor.moduleReferences.some(m => m.includes('auth')))
    assert.ok(extractor.moduleReferences.some(m => m.includes('user')))
  })

  it('should extract code concepts', () => {
    const extractor = new IntentExtractor('Create a new class for handling errors')
    assert.ok(extractor.codeConcepts.includes('class'))
    assert.ok(extractor.codeConcepts.includes('error'))
  })

  it('should extract action targets', () => {
    const extractor = new IntentExtractor('Create a new login module and fix the auth bug')
    assert.ok(extractor.actionTargets.length > 0)
  })

  it('should extract negated terms', () => {
    const extractor = new IntentExtractor('Fix the auth module but skip login files')
    assert.ok(extractor.negatedTerms.size > 0)
  })

  it('should return all keywords combined', () => {
    const extractor = new IntentExtractor('Fix auth.js login bug')
    const keywords = extractor.getAllKeywords()
    assert.ok(Array.isArray(keywords))
    assert.ok(keywords.length > 0)
  })

  it('should handle empty prompt', () => {
    const extractor = new IntentExtractor('')
    assert.equal(extractor.intents.length, 0)
    assert.equal(extractor.fileReferences.length, 0)
  })

  it('should support Chinese prompts', () => {
    const extractor = new IntentExtractor('修复用户认证模块的登录问题')
    const intentNames = extractor.intents.map(i => i.name)
    assert.ok(intentNames.includes('auth'))
    assert.ok(intentNames.includes('user'))
  })
})

describe('CodeBlockExtractor', () => {
  it('should extract JavaScript functions', () => {
    const code = `
      function hello() {
        return 'world'
      }
      async function fetchData() {
        const res = await fetch('/api')
        return res.json()
      }
    `
    const extractor = new CodeBlockExtractor('test.js', code)
    const blocks = extractor.extract()
    assert.ok(blocks.length >= 2)
    assert.ok(blocks.some(b => b.name === 'hello'))
    assert.ok(blocks.some(b => b.name === 'fetchData'))
  })

  it('should extract JavaScript classes', () => {
    const code = `
      class MyService {
        constructor() {}
        doWork() {}
      }
    `
    const extractor = new CodeBlockExtractor('service.js', code)
    const blocks = extractor.extract()
    assert.ok(blocks.some(b => b.type === 'class' && b.name === 'MyService'))
  })

  it('should extract Python functions', () => {
    const code = `
def hello():
    return 'world'

async def fetch_data():
    return await get()
    `
    const extractor = new CodeBlockExtractor('test.py', code)
    const blocks = extractor.extract()
    assert.ok(blocks.some(b => b.name === 'hello'))
    assert.ok(blocks.some(b => b.name === 'fetch_data'))
  })

  it('should return empty for unknown languages', () => {
    const extractor = new CodeBlockExtractor('test.xyz', 'some code')
    const blocks = extractor.extract()
    assert.equal(blocks.length, 0)
  })
})

describe('FileExtractor', () => {
  it('should detect binary files by extension', () => {
    assert.equal(FileExtractor.isBinary('image.png'), true)
    assert.equal(FileExtractor.isBinary('data.pdf'), true)
    assert.equal(FileExtractor.isBinary('archive.zip'), true)
    assert.equal(FileExtractor.isBinary('script.js'), false)
    assert.equal(FileExtractor.isBinary('app.py'), false)
  })

  it('should extract JavaScript imports', () => {
    const code = `
      import express from 'express'
      const lodash = require('lodash')
    `
    const imports = FileExtractor.extractImports(code, 'javascript')
    assert.ok(imports.includes('express'))
    assert.ok(imports.includes('lodash'))
  })

  it('should extract Python imports', () => {
    const code = `
import os
from pathlib import Path
    `
    const imports = FileExtractor.extractImports(code, 'python')
    assert.ok(imports.some(i => i.includes('os')))
    assert.ok(imports.some(i => i.includes('pathlib')))
  })
})

describe('CodeStructureAnalyzer', () => {
  it('should analyze JavaScript structure', () => {
    const analyzer = new CodeStructureAnalyzer()
    const code = `
      import fs from 'fs'
      export function hello() {}
      export class MyComponent {}
    `
    const result = analyzer.analyze(code, 'javascript')
    assert.ok(result.functions.includes('hello'))
    assert.ok(result.classes.includes('MyComponent'))
    assert.ok(result.imports.includes('fs'))
  })

  it('should compute complexity', () => {
    const analyzer = new CodeStructureAnalyzer()
    const simpleCode = 'const x = 1'
    const complexCode = 'if (a) { for (let i = 0; i < 10; i++) { if (b) { try {} catch(e) {} } } }'
    const simple = analyzer.analyze(simpleCode, 'javascript')
    const complex = analyzer.analyze(complexCode, 'javascript')
    assert.ok(complex.complexity > simple.complexity)
  })

  it('should cache analysis results', () => {
    const analyzer = new CodeStructureAnalyzer()
    const code = 'function test() {}'
    const result1 = analyzer.analyze(code, 'javascript')
    const result2 = analyzer.analyze(code, 'javascript')
    assert.equal(result1, result2)
  })
})

describe('TfIdfScorer', () => {
  it('should score documents based on TF-IDF', () => {
    const scorer = new TfIdfScorer()
    scorer.buildIndex([
      { content: 'authentication login token' },
      { content: 'database query sql' },
      { content: 'ui component button' }
    ])
    const score = scorer.score('authentication token jwt', ['auth', 'token'])
    assert.ok(score > 0)
  })

  it('should return 0 for documents with no matching terms', () => {
    const scorer = new TfIdfScorer()
    scorer.buildIndex([{ content: 'hello world' }])
    const score = scorer.score('hello world', ['xyznonexistent'])
    assert.equal(score, 0)
  })
})

describe('RelevanceScorer', () => {
  it('should score files based on multiple factors', () => {
    const scorer = new RelevanceScorer()
    const extractor = new IntentExtractor('Fix the auth login bug')
    const fileInfo = {
      relativePath: 'src/auth/login.js',
      content: 'function authenticate(token) { /* auth logic */ }',
      mtime: new Date()
    }
    const result = scorer.score(fileInfo, extractor)
    assert.ok(result.total > 0)
    assert.ok(result.breakdown.filename >= 0)
    assert.ok(result.breakdown.path >= 0)
    assert.ok(result.breakdown.content >= 0)
    assert.ok(result.breakdown.intent >= 0)
    assert.ok(result.breakdown.recency >= 0)
  })

  it('should cap total score at 1.0', () => {
    const scorer = new RelevanceScorer()
    const extractor = new IntentExtractor('auth login user')
    const fileInfo = {
      relativePath: 'auth/login/user.js',
      content: 'auth login user authentication',
      mtime: new Date()
    }
    const result = scorer.score(fileInfo, extractor)
    assert.ok(result.total <= 1.0)
  })
})

describe('Constants', () => {
  it('should have DEFAULT_EXTENSIONS', () => {
    assert.ok(Array.isArray(DEFAULT_EXTENSIONS))
    assert.ok(DEFAULT_EXTENSIONS.includes('.js'))
    assert.ok(DEFAULT_EXTENSIONS.includes('.py'))
  })

  it('should have BINARY_EXTENSIONS as a Set', () => {
    assert.ok(BINARY_EXTENSIONS instanceof Set)
    assert.ok(BINARY_EXTENSIONS.has('.png'))
    assert.ok(BINARY_EXTENSIONS.has('.zip'))
  })

  it('should have EXCLUDE_DIRS as a Set', () => {
    assert.ok(EXCLUDE_DIRS instanceof Set)
    assert.ok(EXCLUDE_DIRS.has('node_modules'))
    assert.ok(EXCLUDE_DIRS.has('.git'))
  })

  it('should have INTENT_PATTERNS with required fields', () => {
    for (const [name, pattern] of Object.entries(INTENT_PATTERNS)) {
      assert.ok(Array.isArray(pattern.keywords), `${name} should have keywords`)
      assert.ok(Array.isArray(pattern.patterns), `${name} should have patterns`)
      assert.ok(Array.isArray(pattern.filePatterns), `${name} should have filePatterns`)
    }
  })

  it('should have FILE_EXTENSION_MAP', () => {
    assert.equal(FILE_EXTENSION_MAP['.js'], 'javascript')
    assert.equal(FILE_EXTENSION_MAP['.py'], 'python')
    assert.equal(FILE_EXTENSION_MAP['.ts'], 'typescript')
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
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
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
      const content = fs.readFileSync(outputPath, 'utf8')
      assert.ok(content.includes('hello.js'))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
