const fs = require('fs')
const path = require('path')
const ignore = require('ignore')
const crypto = require('crypto')

const DEFAULT_EXTENSIONS = [
  '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.go', '.rs',
  '.c', '.cpp', '.h', '.hpp', '.md', '.txt', '.json', '.yaml',
  '.yml', '.toml', '.xml', '.csv', '.sql', '.sh', '.bash',
  '.css', '.scss', '.less', '.html', '.vue', '.svelte'
]

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.wav',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.db', '.sqlite', '.sqlite3',
  '.pyc', '.pyo', '.class', '.o', '.obj',
  '.lock', '.log'
])

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__',
  '.tox', '.venv', 'venv', 'env', '.env',
  'dist', 'build', '.next', '.nuxt', '.output',
  'coverage', '.nyc_output', '.pytest_cache',
  '.idea', '.vscode', '.vs',
  'target', 'bin', 'obj', '.gradle',
  'bower_components', 'vendor',
  '.turbo', '.cache', 'tmp', 'temp'
])

const INTENT_PATTERNS = {
  auth: {
    keywords: ['auth', 'login', 'password', 'credential', 'token', 'jwt', 'session', 'oauth', '认证', '登录', '密码', '授权'],
    patterns: [/auth|login|password|credential|token|jwt|session|oauth/i, /认证|登录|密码|授权/],
    filePatterns: ['auth', 'login', 'session', 'credential', 'oauth']
  },
  user: {
    keywords: ['user', 'profile', 'account', 'register', 'signup', '用户', '账号', '注册', '个人信息'],
    patterns: [/user|profile|account|register|signup/i, /用户|账号|注册|个人信息/],
    filePatterns: ['user', 'account', 'profile', 'member']
  },
  api: {
    keywords: ['api', 'endpoint', 'route', 'controller', 'handler', 'request', '接口', '路由', '控制器'],
    patterns: [/api|endpoint|route|controller|handler|request/i, /接口|路由|控制器/],
    filePatterns: ['api', 'route', 'controller', 'handler', 'endpoint']
  },
  database: {
    keywords: ['database', 'db', 'sql', 'mongo', 'redis', 'model', 'schema', 'table', '数据库', '查询', '存储'],
    patterns: [/database|db|sql|mongo|redis|model|schema|table/i, /数据库|查询|存储/],
    filePatterns: ['db', 'database', 'model', 'schema', 'repository', 'mongo', 'redis', 'sql']
  },
  config: {
    keywords: ['config', 'setting', 'option', 'env', 'initialization', '配置', '设置', '环境变量'],
    patterns: [/config|setting|option|env|initialization/i, /配置|设置|环境变量/],
    filePatterns: ['config', 'setting', 'env', 'option']
  },
  utils: {
    keywords: ['util', 'helper', 'tool', 'function', 'lib', 'common', '工具', '辅助', '函数'],
    patterns: [/util|helper|tool|function|lib|common/i, /工具|辅助|函数/],
    filePatterns: ['util', 'helper', 'tool', 'lib', 'common']
  },
  ui: {
    keywords: ['component', 'view', 'page', 'screen', 'widget', 'button', 'input', '界面', '组件', '页面'],
    patterns: [/component|view|page|screen|widget|button|input/i, /界面|组件|页面/],
    filePatterns: ['component', 'view', 'page', 'screen', 'widget', 'ui']
  },
  test: {
    keywords: ['test', 'spec', 'mock', 'vitest', 'jest', '测试', '单元测试'],
    patterns: [/test|spec|mock|vitest|jest/i, /测试|单元测试/],
    filePatterns: ['test', 'spec', 'mock', '__test__']
  },
  error: {
    keywords: ['error', 'exception', 'handle', 'catch', '错误', '异常', '处理'],
    patterns: [/error|exception|handle|catch/i, /错误|异常|处理/],
    filePatterns: ['error', 'exception', 'handler']
  },
  security: {
    keywords: ['security', 'encrypt', 'decrypt', 'hash', 'salt', '安全', '加密', '解密'],
    patterns: [/security|encrypt|decrypt|hash|salt/i, /安全|加密|解密/],
    filePatterns: ['security', 'crypto', 'encrypt']
  }
}

const CODE_BLOCK_PATTERNS = {
  javascript: {
    function: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{[\s\S]*?\n\s*\}/g,
    arrowFunction: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>\s*\{[\s\S]*?\n\s*\}/g,
    class: /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?\s*\{[\s\S]*?\n\s*\}/g,
    method: /(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{[\s\S]*?\n\s*\}/g
  },
  typescript: {
    function: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]+>)?\s*\([^)]*\)(?:\s*:\s*[\w<>\[\]|&]+)?\s*\{[\s\S]*?\n\s*\}/g,
    arrowFunction: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[\w<>\[\]|&]+)?\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>\s*\{[\s\S]*?\n\s*\}/g,
    class: /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+[\w<>,\s]+)?(?:\s+implements\s+[\w,\s]+)?\s*\{[\s\S]*?\n\s*\}/g,
    interface: /(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+[\w,\s]+)?\s*\{[\s\S]*?\n\s*\}/g,
    type: /(?:export\s+)?type\s+(\w+)\s*=\s*[\s\S]*?;\n/g
  },
  python: {
    function: /(?:async\s+)?def\s+(\w+)\s*\([^)]*\)(?:\s*->\s*[\w<>\[\]|&]+)?:\n(?:[\t ][\s\S]*?)+(?=\n\s*(?:def|class)|\n\S|\n$)/g,
    class: /class\s+(\w+)(?:\([^)]*\))?:\n(?:[\t ][\s\S]*?)+(?=\n\s*(?:def|class)|\n\S|\n$)/g,
    method: /def\s+(\w+)\s*\([^)]*\):\n(?:[\t ][\s\S]*?)+(?=\n\s{0,4}def|\n\s{0,4}class|\n\S|\n$)/g
  },
  go: {
    function: /func\s+(?:\([^)]+\)\s+)?(\w+)\s*\([^)]*\)(?:\s*\([^)]*\))?\s*\{[\s\S]*?\n\s*\}/g,
    struct: /type\s+(\w+)\s+struct\s*\{[\s\S]*?\n\s*\}/g,
    interface: /type\s+(\w+)\s+interface\s*\{[\s\S]*?\n\s*\}/g
  },
  java: {
    class: /(?:public|private|protected)?\s*(?:abstract|final)?\s*class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s]+)?\s*\{[\s\S]*?\n\s*\}/g,
    method: /(?:public|private|protected)?\s*(?:static|final|abstract)?\s*\w+\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{[\s\S]*?\n\s*\}/g
  }
}

const FILE_EXTENSION_MAP = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.py': 'python',
  '.go': 'go',
  '.java': 'java'
}

class IntentExtractor {
  constructor(prompt) {
    this.prompt = prompt
    this.intents = []
    this.fileReferences = []
    this.moduleReferences = []
    this.codeConcepts = []
    this._extract()
  }

  _extract() {
    this._extractFileReferences()
    this._extractModuleReferences()
    this._extractIntents()
    this._extractCodeConcepts()
  }

  _extractFileReferences() {
    const filePatterns = [
      /["']([^"']+\.(?:js|ts|jsx|tsx|py|go|java|rs|c|cpp|h|vue|svelte))["']/gi,
      /\b(\w+\.(?:js|ts|jsx|tsx|py|go|java|rs|c|cpp|h|vue|svelte))\b/gi,
      /["']([^"']+)["']/g
    ]

    for (const pattern of filePatterns) {
      let match
      while ((match = pattern.exec(this.prompt)) !== null) {
        const file = match[1].toLowerCase()
        if (file && !this.fileReferences.includes(file) && file.length > 2) {
          this.fileReferences.push(file)
        }
      }
    }
  }

  _extractModuleReferences() {
    const modulePatterns = [
      /(\w+)[Mm]odule/g,
      /(\w+)[Ss]ervice/g,
      /(\w+)[Cc]ontroller/g,
      /(\w+)[Mm]odel/g,
      /(\w+)[Hh]andler/g,
      /(\w+)[Rr]epository/g,
      /(\w+)[Uu]til/g,
      /(\w+)[Hh]elper/g,
      /(\w+)[Cc]omponent/g,
      /(\w+)[Pp]age/g,
      /(\w+)模块/g,
      /(\w+)服务/g,
      /(\w+)控制器/g,
      /(\w+)组件/g
    ]

    for (const pattern of modulePatterns) {
      let match
      while ((match = pattern.exec(this.prompt)) !== null) {
        const mod = match[1].toLowerCase()
        if (mod && mod.length > 1 && !this.moduleReferences.includes(mod)) {
          this.moduleReferences.push(mod)
        }
      }
    }

    const camelCasePattern = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)*)\b/g
    let match
    while ((match = camelCasePattern.exec(this.prompt)) !== null) {
      const name = match[1]
      if (name && name.length > 2 && !this.moduleReferences.includes(name.toLowerCase())) {
        this.moduleReferences.push(name.toLowerCase())
      }
    }
  }

  _extractIntents() {
    for (const [intentName, intentConfig] of Object.entries(INTENT_PATTERNS)) {
      for (const pattern of intentConfig.patterns) {
        if (pattern.test(this.prompt)) {
          this.intents.push({
            name: intentName,
            keywords: intentConfig.keywords,
            filePatterns: intentConfig.filePatterns,
            confidence: 1.0
          })
          break
        }
      }
    }
  }

  _extractCodeConcepts() {
    const concepts = {
      function: /函数|function|方法|method|def\s|func\s/gi,
      class: /类|class|结构体|struct/gi,
      interface: /接口|interface|协议|protocol/gi,
      variable: /变量|variable|常量|const|let|var/gi,
      import: /导入|import|引用|require|include/gi,
      error: /错误|error|异常|exception|bug/gi,
      test: /测试|test|单元测试|unit test/gi
    }

    for (const [concept, pattern] of Object.entries(concepts)) {
      if (pattern.test(this.prompt)) {
        this.codeConcepts.push(concept)
      }
    }
  }

  getAllKeywords() {
    const keywords = new Set()
    
    for (const file of this.fileReferences) {
      const baseName = path.basename(file, path.extname(file))
      keywords.add(baseName.toLowerCase())
    }
    
    for (const mod of this.moduleReferences) {
      keywords.add(mod.toLowerCase())
    }
    
    for (const intent of this.intents) {
      for (const kw of intent.keywords) {
        keywords.add(kw.toLowerCase())
      }
      for (const fp of intent.filePatterns) {
        keywords.add(fp.toLowerCase())
      }
    }

    return Array.from(keywords)
  }
}

class CodeBlockExtractor {
  constructor(filePath, content) {
    this.filePath = filePath
    this.content = content
    this.ext = path.extname(filePath).toLowerCase()
    this.language = FILE_EXTENSION_MAP[this.ext] || 'unknown'
    this.blocks = []
  }

  extract() {
    if (this.language === 'unknown') {
      return [{ type: 'full', content: this.content, name: path.basename(this.filePath) }]
    }

    const patterns = CODE_BLOCK_PATTERNS[this.language]
    if (!patterns) {
      return [{ type: 'full', content: this.content, name: path.basename(this.filePath) }]
    }

    this._extractBlocks(patterns)
    
    if (this.blocks.length === 0) {
      return [{ type: 'full', content: this.content, name: path.basename(this.filePath) }]
    }

    return this.blocks
  }

  _extractBlocks(patterns) {
    for (const [type, pattern] of Object.entries(patterns)) {
      const regex = new RegExp(pattern.source, pattern.flags)
      let match
      while ((match = regex.exec(this.content)) !== null) {
        const name = match[1] || 'anonymous'
        const code = match[0]
        
        if (code.length > 50 && code.length < 5000) {
          this.blocks.push({
            type,
            name,
            content: code,
            startLine: this._getLineNumber(match.index),
            endLine: this._getLineNumber(match.index + code.length)
          })
        }
      }
    }
  }

  _getLineNumber(index) {
    return this.content.substring(0, index).split('\n').length
  }
}

class RelevanceScorer {
  constructor(intentExtractor) {
    this.intentExtractor = intentExtractor
  }

  scoreFile(filePath, content = null) {
    let score = 0
    const keywords = this.intentExtractor.getAllKeywords()
    const lowerPath = filePath.toLowerCase()
    const baseName = path.basename(filePath, path.extname(filePath)).toLowerCase()

    for (const fileRef of this.intentExtractor.fileReferences) {
      if (lowerPath.includes(fileRef) || fileRef.includes(baseName)) {
        score += 100
      }
    }

    for (const modRef of this.intentExtractor.moduleReferences) {
      if (baseName.includes(modRef) || lowerPath.includes(modRef)) {
        score += 50
      }
    }

    for (const intent of this.intentExtractor.intents) {
      for (const fp of intent.filePatterns) {
        if (baseName.includes(fp) || lowerPath.includes(fp)) {
          score += 30
        }
      }
    }

    for (const kw of keywords) {
      if (baseName.includes(kw)) {
        score += 20
      }
      if (lowerPath.includes(kw)) {
        score += 10
      }
    }

    if (content) {
      score += this._scoreContent(content, keywords)
    }

    return score
  }

  _scoreContent(content, keywords) {
    let score = 0
    const lowerContent = content.toLowerCase()

    for (const kw of keywords) {
      const regex = new RegExp(kw, 'gi')
      const matches = lowerContent.match(regex)
      if (matches) {
        score += Math.min(matches.length * 2, 20)
      }
    }

    return Math.min(score, 100)
  }

  scoreCodeBlock(block, keywords) {
    let score = 0
    const lowerContent = block.content.toLowerCase()
    const lowerName = block.name.toLowerCase()

    for (const kw of keywords) {
      if (lowerName.includes(kw)) {
        score += 30
      }
      const regex = new RegExp(kw, 'gi')
      const matches = lowerContent.match(regex)
      if (matches) {
        score += Math.min(matches.length * 3, 50)
      }
    }

    return score
  }
}

class SmartContextExtractor {
  constructor(rootDir, options = {}) {
    this.rootDir = path.resolve(rootDir)
    this.scanner = new CodeScanner(rootDir)
    this.options = {
      maxTokens: options.maxTokens || 8000,
      maxFiles: options.maxFiles || 30,
      maxBlocksPerFile: options.maxBlocksPerFile || 5,
      minRelevanceScore: options.minRelevanceScore || 10,
      ...options
    }
    this.fileCache = new Map()
    this.contentCache = new Map()
  }

  extract(prompt) {
    const intentExtractor = new IntentExtractor(prompt)
    const scorer = new RelevanceScorer(intentExtractor)
    const keywords = intentExtractor.getAllKeywords()

    if (keywords.length === 0) {
      return this._fallbackExtraction(prompt)
    }

    const allFiles = this._getAllFiles()
    const scoredFiles = []

    for (const file of allFiles) {
      const content = this._getFileContent(file)
      const score = scorer.scoreFile(file, content)
      if (score >= this.options.minRelevanceScore) {
        scoredFiles.push({ file, score, content })
      }
    }

    scoredFiles.sort((a, b) => b.score - a.score)
    const topFiles = scoredFiles.slice(0, this.options.maxFiles)

    const extractedBlocks = []
    let totalTokens = 0

    for (const { file, score, content } of topFiles) {
      if (totalTokens >= this.options.maxTokens) break

      const blocks = this._extractRelevantBlocks(file, content, keywords, scorer)
      
      for (const block of blocks) {
        const blockTokens = Math.ceil(block.content.length / 4)
        if (totalTokens + blockTokens <= this.options.maxTokens) {
          extractedBlocks.push({
            file,
            ...block,
            relevanceScore: block.score
          })
          totalTokens += blockTokens
        }
      }
    }

    return {
      mode: 'smart',
      keywords,
      intents: intentExtractor.intents.map(i => i.name),
      fileReferences: intentExtractor.fileReferences,
      moduleReferences: intentExtractor.moduleReferences,
      blocks: extractedBlocks,
      totalTokens,
      stats: {
        totalFiles: allFiles.length,
        matchedFiles: topFiles.length,
        extractedBlocks: extractedBlocks.length
      }
    }
  }

  _extractRelevantBlocks(filePath, content, keywords, scorer) {
    const extractor = new CodeBlockExtractor(filePath, content)
    const allBlocks = extractor.extract()

    if (allBlocks.length === 1 && allBlocks[0].type === 'full') {
      return [{
        type: 'full',
        name: path.basename(filePath),
        content: allBlocks[0].content,
        score: scorer.scoreFile(filePath, content)
      }]
    }

    const scoredBlocks = []
    for (const block of allBlocks) {
      const score = scorer.scoreCodeBlock(block, keywords)
      if (score > 0) {
        scoredBlocks.push({ ...block, score })
      }
    }

    scoredBlocks.sort((a, b) => b.score - a.score)
    return scoredBlocks.slice(0, this.options.maxBlocksPerFile)
  }

  _fallbackExtraction(prompt) {
    const allFiles = this._getAllFiles()
    const files = allFiles.slice(0, Math.min(10, this.options.maxFiles))
    
    return {
      mode: 'fallback',
      keywords: [],
      intents: [],
      fileReferences: [],
      moduleReferences: [],
      blocks: files.map(file => ({
        file,
        type: 'full',
        name: path.basename(file),
        content: this._getFileContent(file),
        score: 0
      })),
      totalTokens: 0,
      stats: {
        totalFiles: allFiles.length,
        matchedFiles: files.length,
        extractedBlocks: files.length
      }
    }
  }

  _getAllFiles() {
    if (this.fileCache.size === 0) {
      const files = this.scanner.scan()
      for (const file of files) {
        this.fileCache.set(file, true)
      }
      return files
    }
    return Array.from(this.fileCache.keys())
  }

  _getFileContent(relativePath) {
    if (this.contentCache.has(relativePath)) {
      return this.contentCache.get(relativePath)
    }
    
    const absPath = path.join(this.rootDir, relativePath)
    try {
      const content = fs.readFileSync(absPath, 'utf8')
      this.contentCache.set(relativePath, content)
      return content
    } catch (e) {
      return ''
    }
  }

  buildContext(prompt, outputPath) {
    const result = this.extract(prompt)
    const lines = []

    lines.push(`# ContextGate Smart Context`)
    lines.push(`# Generated: ${new Date().toISOString()}`)
    lines.push(`# Mode: ${result.mode}`)
    lines.push(`# Keywords: ${result.keywords.join(', ') || 'none'}`)
    lines.push(`# Intents: ${result.intents.join(', ') || 'none'}`)
    lines.push(`# Files Referenced: ${result.fileReferences.join(', ') || 'none'}`)
    lines.push(`# Modules Referenced: ${result.moduleReferences.join(', ') || 'none'}`)
    lines.push(`# Extracted Blocks: ${result.blocks.length}`)
    lines.push(`# Estimated Tokens: ${result.totalTokens}`)
    lines.push('')

    const fileGroups = new Map()
    for (const block of result.blocks) {
      if (!fileGroups.has(block.file)) {
        fileGroups.set(block.file, [])
      }
      fileGroups.get(block.file).push(block)
    }

    for (const [file, blocks] of fileGroups) {
      lines.push(`\n# ============================================================`)
      lines.push(`# File: ${file}`)
      lines.push(`# ============================================================`)
      
      for (const block of blocks) {
        if (block.type === 'full') {
          lines.push(block.content)
        } else {
          lines.push(`\n# --- ${block.type}: ${block.name} (lines ${block.startLine}-${block.endLine}) ---`)
          lines.push(block.content)
        }
      }
    }

    const content = lines.join('\n')
    fs.writeFileSync(outputPath, content, 'utf8')

    return {
      ...result,
      outputPath,
      contentLength: content.length
    }
  }

  clearCache() {
    this.fileCache.clear()
    this.contentCache.clear()
  }
}

class ContextExtractor {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir)
    this.scanner = new CodeScanner(rootDir)
    this.smartExtractor = new SmartContextExtractor(rootDir)
    this.allFiles = null
  }

  _extractKeywords(prompt) {
    const keywords = new Set()
    for (const [key, pattern] of Object.entries(KEYWORD_PATTERNS)) {
      if (pattern.test(prompt)) {
        keywords.add(key)
      }
    }
    const fileMatches = prompt.match(/"[^"]+"|'[^']+'|\b\w+\.\w+\b/g)
    if (fileMatches) {
      for (const match of fileMatches) {
        const clean = match.replace(/["']/g, '')
        const parts = clean.split('.')
        if (parts.length >= 1) keywords.add(parts[0].toLowerCase())
      }
    }
    return Array.from(keywords)
  }

  _matchFile(keywords, filePath) {
    const lowerPath = filePath.toLowerCase()
    for (const kw of keywords) {
      if (lowerPath.includes(kw)) return true
      const baseName = path.basename(filePath, path.extname(filePath)).toLowerCase()
      if (baseName.includes(kw)) return true
    }
    return false
  }

  _buildFileHashCache() {
    if (this.allFiles) return this.allFiles
    this.allFiles = this.scanner.scan()
    return this.allFiles
  }

  extract(prompt, maxFiles = 20) {
    return this.smartExtractor.extract(prompt)
  }

  buildPartial(prompt, outputPath) {
    return this.smartExtractor.buildContext(prompt, outputPath)
  }
}

const KEYWORD_PATTERNS = {
  'auth': /auth|login|password|credential|token|jwt|session|oauth/i,
  'user': /user|profile|account|register|signup/i,
  'api': /api|endpoint|route|controller|handler|request/i,
  'db': /database|db|sql|mongo|redis|model|schema|table/i,
  'config': /config|setting|option|env|initialization/i,
  'utils': /util|helper|tool|function|lib|common/i,
  'ui': /component|view|page|screen|widget|button|input/i,
  'test': /test|spec|mock|spec|vitest|jest/i,
}

class CodeScanner {
  constructor(rootDir, config = {}) {
    this.rootDir = path.resolve(rootDir)
    this.config = config
    this._ig = null
    this._loadGitignore()
  }

  _loadGitignore() {
    this._ig = ignore()
    const gitignorePath = path.join(this.rootDir, '.gitignore')
    if (fs.existsSync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath, 'utf8')
      this._ig.add(content)
    }
  }

  _isBinary(filePath) {
    const ext = path.extname(filePath).toLowerCase()
    if (BINARY_EXTENSIONS.has(ext)) return true
    try {
      const buf = Buffer.alloc(512)
      const fd = fs.openSync(filePath, 'r')
      const bytesRead = fs.readSync(fd, buf, 0, 512, 0)
      fs.closeSync(fd)
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0) return true
      }
    } catch (e) {
      return true
    }
    return false
  }

  _shouldIncludeFile(filePath) {
    const ext = path.extname(filePath).toLowerCase()
    const includeExts = this.config.include_extensions || DEFAULT_EXTENSIONS
    if (includeExts.length > 0 && !includeExts.includes(ext)) return false
    if (BINARY_EXTENSIONS.has(ext)) return false
    const maxSize = this.config.max_file_size || 1048576
    try {
      const stat = fs.statSync(filePath)
      if (stat.size > maxSize) return false
    } catch (e) {
      return false
    }
    return true
  }

  _walkDir(dir, files = []) {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      return files
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      const relativePath = path.relative(this.rootDir, fullPath)

      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue
        if (entry.name.startsWith('.')) continue
        const relDir = relativePath + '/'
        if (this._ig.ignores(relDir)) continue
        this._walkDir(fullPath, files)
      } else if (entry.isFile()) {
        if (this._ig.ignores(relativePath)) continue
        if (this._shouldIncludeFile(fullPath)) {
          files.push(relativePath)
        }
      }
    }

    return files
  }

  scan() {
    const files = this._walkDir(this.rootDir)
    return files.sort()
  }

  buildContext(outputPath) {
    const files = this.scan()
    if (!outputPath) {
      outputPath = path.join(this.rootDir, 'full_context.txt')
    }

    let totalChars = 0
    const lines = []
    lines.push(`# ContextGate Generated Context File`)
    lines.push(`# Project: ${this.rootDir}`)
    lines.push(`# Generated: ${new Date().toISOString()}`)
    lines.push(`# Files: ${files.length}`)
    lines.push('')
    totalChars += lines.join('\n').length

    for (const relPath of files) {
      const absPath = path.join(this.rootDir, relPath)
      try {
        const content = fs.readFileSync(absPath, 'utf8')
        const header = `\n# ============================================================\n# File: ${relPath}\n# ============================================================\n`
        lines.push(header)
        lines.push(content)
        totalChars += header.length + content.length
      } catch (e) {
        const errMsg = `\n# File: ${relPath} (ERROR: ${e.message})\n`
        lines.push(errMsg)
        totalChars += errMsg.length
      }
    }

    const fullContent = lines.join('\n')
    fs.writeFileSync(outputPath, fullContent, 'utf8')

    const estimatedTokens = Math.ceil(totalChars / 4)

    return {
      fileCount: files.length,
      totalChars,
      estimatedTokens,
      outputPath
    }
  }

  buildPartialContext(prompt, outputPath) {
    const extractor = new SmartContextExtractor(this.rootDir)
    return extractor.buildContext(prompt, outputPath)
  }
}

module.exports = { 
  CodeScanner, 
  ContextExtractor, 
  SmartContextExtractor,
  IntentExtractor,
  CodeBlockExtractor,
  RelevanceScorer
}
