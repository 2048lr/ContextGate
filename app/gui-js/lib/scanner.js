const fs = require('fs')
const fsp = fs.promises
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

const CODE_BLOCK_SIGNATURES = {
  javascript: {
    function: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{/g,
    arrowFunction: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>\s*\{/g,
    class: /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?\s*\{/g,
    method: /(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/g
  },
  typescript: {
    function: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]+>)?\s*\([^)]*\)(?:\s*:\s*[\w<>\[\]|&]+)?\s*\{/g,
    arrowFunction: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[\w<>\[\]|&]+)?\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>\s*\{/g,
    class: /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+[\w<>,\s]+)?(?:\s+implements\s+[\w,\s]+)?\s*\{/g,
    interface: /(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+[\w,\s]+)?\s*\{/g,
    type: /(?:export\s+)?type\s+(\w+)\s*=\s*\{/g
  },
  python: {
    function: /(?:async\s+)?def\s+(\w+)\s*\([^)]*\)(?:\s*->\s*[\w<>\[\]|&]+)?:/g,
    class: /class\s+(\w+)(?:\([^)]*\))?:/g
  },
  go: {
    function: /func\s+(?:\([^)]+\)\s+)?(\w+)\s*\([^)]*\)(?:\s*\([^)]*\))?\s*\{/g,
    struct: /type\s+(\w+)\s+struct\s*\{/g,
    interface: /type\s+(\w+)\s+interface\s*\{/g
  },
  java: {
    class: /(?:public|private|protected)?\s*(?:abstract|final)?\s*class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s]+)?\s*\{/g,
    method: /(?:public|private|protected)?\s*(?:static|final|abstract)?\s*\w+\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{/g
  }
}

function extractBraceBlock(content, openBraceIndex) {
  let depth = 0
  let i = openBraceIndex
  let inString = false
  let stringChar = ''
  let inTemplate = false
  let templateDepth = 0
  let inLineComment = false
  let inBlockComment = false

  while (i < content.length) {
    const ch = content[i]
    const next = content[i + 1]

    if (inLineComment) {
      if (ch === '\n') inLineComment = false
      i++
      continue
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        i += 2
        continue
      }
      i++
      continue
    }

    if (inString) {
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === stringChar) {
        inString = false
      }
      i++
      continue
    }

    if (ch === '/' && next === '/') {
      inLineComment = true
      i += 2
      continue
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true
      i += 2
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true
      stringChar = ch
      i++
      continue
    }

    if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        return i
      }
    }

    i++
  }

  return -1
}

function extractIndentBlock(content, defLineStart) {
  const lines = content.substring(defLineStart).split('\n')
  if (lines.length === 0) return -1

  const firstLine = lines[0]
  const indentMatch = firstLine.match(/^(\s*)/)
  const baseIndent = indentMatch ? indentMatch[1].length : 0

  let endOffset = firstLine.length

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().length === 0) {
      endOffset += 1 + line.length
      continue
    }
    const lineIndentMatch = line.match(/^(\s*)/)
    const lineIndent = lineIndentMatch ? lineIndentMatch[1].length : 0
    if (lineIndent <= baseIndent && line.trim().length > 0) {
      break
    }
    endOffset += 1 + line.length
  }

  return defLineStart + endOffset
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
    this.actionTargets = []
    this.negatedTerms = new Set()
    this.intentCooccurrences = new Map()
    this._extract()
  }

  _extract() {
    this._extractFileReferences()
    this._extractModuleReferences()
    this._extractIntents()
    this._extractCodeConcepts()
    this._extractActionTargets()
    this._extractNegatedTerms()
    this._computeIntentCooccurrences()
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

  _extractActionTargets() {
    const actionPatterns = [
      { action: 'create', pattern: /(?:创建|新增|添加|新建|create|add|new|implement)[\s]+(\w+)|(?:创建|新增|添加|新建)([\u4e00-\u9fff]+)/gi },
      { action: 'modify', pattern: /(?:修改|更新|编辑|变更|modify|update|edit|change|fix)[\s]+(\w+)|(?:修改|更新|编辑|变更)([\u4e00-\u9fff]+)/gi },
      { action: 'delete', pattern: /(?:删除|移除|清除|delete|remove|drop|clear)[\s]+(\w+)|(?:删除|移除|清除)([\u4e00-\u9fff]+)/gi },
      { action: 'query', pattern: /(?:查找|搜索|查询|获取|读取|find|search|query|get|fetch|read)[\s]+(\w+)|(?:查找|搜索|查询|获取|读取)([\u4e00-\u9fff]+)/gi },
      { action: 'debug', pattern: /(?:调试|排查|修复|debug|troubleshoot|fix|resolve)[\s]+(\w+)|(?:调试|排查|修复)([\u4e00-\u9fff]+)/gi },
      { action: 'refactor', pattern: /(?:重构|优化|改进|refactor|optimize|improve)[\s]+(\w+)|(?:重构|优化|改进)([\u4e00-\u9fff]+)/gi }
    ]

    for (const { action, pattern } of actionPatterns) {
      const regex = new RegExp(pattern.source, pattern.flags)
      let match
      while ((match = regex.exec(this.prompt)) !== null) {
        const target = (match[1] || match[2] || '').toLowerCase()
        if (target.length > 1 && !this._isStopWord(target)) {
          this.actionTargets.push({ action, target })
        }
      }
    }
  }

  _extractNegatedTerms() {
    const negationPatterns = [
      /(?:不要|别|除[了外]|不[要需用动]|skip|ignore|exclude|without|don't\s+(?:touch|modify|change|update)\s+|not|no)\s+(\w+)/gi,
      /(?:不要|别|除[了外]|不[要需用动])([\u4e00-\u9fff]+)/gi,
      /(?:不要|别|除[了外]|不[要需用动]|skip|ignore|exclude|without|don't|not|no)\s+["']([^"']+)["']/gi,
      /(?:不要|别|除[了外]|不[要需用动]|skip|ignore|exclude)\s+the\s+(\w+)\s+module/gi
    ]

    for (const pattern of negationPatterns) {
      const regex = new RegExp(pattern.source, pattern.flags)
      let match
      while ((match = regex.exec(this.prompt)) !== null) {
        const rawTerm = (match[1] || match[2] || '').toLowerCase()
        if (rawTerm.length > 1 && !this._isStopWord(rawTerm)) {
          this.negatedTerms.add(rawTerm)
        }
        if (/[\u4e00-\u9fff]/.test(rawTerm)) {
          for (const intent of this.intents) {
            for (const kw of intent.keywords) {
              if (rawTerm.includes(kw)) {
                this.negatedTerms.add(kw)
              }
            }
            for (const fp of intent.filePatterns) {
              if (rawTerm.includes(fp)) {
                this.negatedTerms.add(fp)
              }
            }
          }
        }
      }
    }
  }

  _computeIntentCooccurrences() {
    const intentNames = this.intents.map(i => i.name)
    for (let i = 0; i < intentNames.length; i++) {
      for (let j = i + 1; j < intentNames.length; j++) {
        const key = [intentNames[i], intentNames[j]].sort().join('|')
        this.intentCooccurrences.set(key, (this.intentCooccurrences.get(key) || 0) + 1)
      }
    }
  }

  _isStopWord(word) {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
      'into', 'through', 'during', 'before', 'after', 'above', 'below',
      'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
      'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
      'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such',
      'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'because',
      'but', 'and', 'or', 'if', 'while', 'about', 'up', 'it', 'its',
      'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you',
      'your', 'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their',
      'what', 'which', 'who', 'whom', 'not', 'no', 'nor',
      '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都',
      '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会',
      '着', '没有', '看', '好', '自己', '这'
    ])
    return stopWords.has(word)
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

    const signatures = CODE_BLOCK_SIGNATURES[this.language]
    if (!signatures) {
      return [{ type: 'full', content: this.content, name: path.basename(this.filePath) }]
    }

    this._extractBlocks(signatures)
    
    if (this.blocks.length === 0) {
      return [{ type: 'full', content: this.content, name: path.basename(this.filePath) }]
    }

    return this.blocks
  }

  _extractBlocks(signatures) {
    const isPython = this.language === 'python'

    for (const [type, pattern] of Object.entries(signatures)) {
      const regex = new RegExp(pattern.source, pattern.flags)
      let match
      while ((match = regex.exec(this.content)) !== null) {
        const name = match[1] || 'anonymous'

        let blockEnd
        if (isPython) {
          const lineStart = this._findLineStart(match.index)
          blockEnd = extractIndentBlock(this.content, lineStart)
        } else {
          const openBraceIndex = match.index + match[0].lastIndexOf('{')
          if (openBraceIndex < match.index) continue
          blockEnd = extractBraceBlock(this.content, openBraceIndex)
        }

        if (blockEnd === -1) continue

        const code = this.content.substring(match.index, blockEnd + 1)
        
        if (code.length > 50 && code.length < 5000) {
          this.blocks.push({
            type,
            name,
            content: code,
            startLine: this._getLineNumber(match.index),
            endLine: this._getLineNumber(blockEnd + 1)
          })
        }
      }
    }
  }

  _findLineStart(index) {
    let i = index
    while (i > 0 && this.content[i - 1] !== '\n') {
      i--
    }
    return i
  }

  _getLineNumber(index) {
    return this.content.substring(0, index).split('\n').length
  }
}

class TfIdfScorer {
  constructor() {
    this.documentFrequencies = new Map()
    this.totalDocuments = 0
  }

  buildCorpus(fileContents) {
    this.totalDocuments = fileContents.length
    this.documentFrequencies.clear()

    for (const content of fileContents) {
      const uniqueTerms = this._extractTerms(content)
      for (const term of uniqueTerms) {
        this.documentFrequencies.set(term, (this.documentFrequencies.get(term) || 0) + 1)
      }
    }
  }

  getTermWeight(term, content) {
    const lowerTerm = term.toLowerCase()
    const df = this.documentFrequencies.get(lowerTerm) || 0
    if (df === 0 || this.totalDocuments === 0) return 1.0

    const idf = Math.log((this.totalDocuments + 1) / (df + 1)) + 1

    const tf = this._countTermFrequency(lowerTerm, content)

    return tf * idf
  }

  _extractTerms(content) {
    const tokens = content.toLowerCase().match(/[a-z_]\w*/g) || []
    return new Set(tokens)
  }

  _countTermFrequency(term, content) {
    const lower = content.toLowerCase()
    let count = 0
    let pos = 0
    while ((pos = lower.indexOf(term, pos)) !== -1) {
      count++
      pos += term.length
    }
    return count
  }
}

class CodeStructureAnalyzer {
  constructor() {
    this.fileStructureCache = new Map()
  }

  analyze(filePath, content) {
    if (this.fileStructureCache.has(filePath)) {
      return this.fileStructureCache.get(filePath)
    }

    const structure = {
      imports: this._extractImports(content),
      exports: this._extractExports(content),
      functionCalls: this._extractFunctionCalls(content),
      classReferences: this._extractClassReferences(content)
    }

    this.fileStructureCache.set(filePath, structure)
    return structure
  }

  clearCache() {
    this.fileStructureCache.clear()
  }

  _extractImports(content) {
    const imports = new Set()
    const patterns = [
      /(?:import|from)\s+['"]([^'"]+)['"]/g,
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /from\s+['"]([^'"]+)['"]\s+import/g
    ]

    for (const pattern of patterns) {
      const regex = new RegExp(pattern.source, pattern.flags)
      let match
      while ((match = regex.exec(content)) !== null) {
        imports.add(match[1])
      }
    }

    return imports
  }

  _extractExports(content) {
    const exports = new Set()
    const patterns = [
      /export\s+(?:default\s+)?(?:function|class|const|let|var|async\s+function)\s+(\w+)/g,
      /export\s*\{([^}]+)\}/g,
      /module\.exports\s*=\s*(\w+)/g,
      /exports\.(\w+)\s*=/g
    ]

    for (const pattern of patterns) {
      const regex = new RegExp(pattern.source, pattern.flags)
      let match
      while ((match = regex.exec(content)) !== null) {
        if (match[1].includes(',')) {
          match[1].split(',').forEach(name => {
            const trimmed = name.trim().split(/\s+as\s+/).pop().trim()
            if (trimmed) exports.add(trimmed)
          })
        } else {
          exports.add(match[1])
        }
      }
    }

    return exports
  }

  _extractFunctionCalls(content) {
    const calls = new Set()
    const callPattern = /(?:(\w+)\s*\.\s*)?(\w+)\s*\(/g
    let match
    while ((match = callPattern.exec(content)) !== null) {
      if (match[2] && match[2].length > 1) {
        calls.add(match[2].toLowerCase())
      }
    }
    return calls
  }

  _extractClassReferences(content) {
    const refs = new Set()
    const patterns = [
      /new\s+(\w+)/g,
      /extends\s+(\w+)/g,
      /implements\s+(\w+)/g
    ]

    for (const pattern of patterns) {
      const regex = new RegExp(pattern.source, pattern.flags)
      let match
      while ((match = regex.exec(content)) !== null) {
        refs.add(match[1].toLowerCase())
      }
    }

    return refs
  }

  computeDependencyBoost(filePath, allFileStructures, targetKeywords) {
    const structure = allFileStructures.get(filePath)
    if (!structure) return 0

    let boost = 0
    const lowerTargets = targetKeywords.map(k => k.toLowerCase())

    for (const exp of structure.exports) {
      for (const target of lowerTargets) {
        if (exp.toLowerCase().includes(target)) {
          boost += 15
        }
      }
    }

    for (const [otherPath, otherStructure] of allFileStructures) {
      if (otherPath === filePath) continue
      for (const imp of otherStructure.imports) {
        if (imp.includes(path.basename(filePath, path.extname(filePath)))) {
          let otherExportsMatch = false
          for (const exp of structure.exports) {
            for (const target of lowerTargets) {
              if (exp.toLowerCase().includes(target)) {
                otherExportsMatch = true
                break
              }
            }
            if (otherExportsMatch) break
          }
          if (otherExportsMatch) {
            boost += 10
          }
        }
      }
    }

    return Math.min(boost, 50)
  }
}

class RelevanceScorer {
  constructor(intentExtractor, tfIdfScorer = null, structureAnalyzer = null) {
    this.intentExtractor = intentExtractor
    this.tfIdfScorer = tfIdfScorer
    this.structureAnalyzer = structureAnalyzer
  }

  scoreFile(filePath, content = null, allFileStructures = null) {
    let score = 0
    const keywords = this.intentExtractor.getAllKeywords()
    const lowerPath = filePath.toLowerCase()
    const baseName = path.basename(filePath, path.extname(filePath)).toLowerCase()

    score += this._scoreFileReference(lowerPath, baseName)

    score += this._scoreModuleReference(baseName, lowerPath)

    score += this._scoreIntentFilePatterns(baseName, lowerPath)

    score += this._scoreKeywordPathMatch(baseName, lowerPath, keywords)

    if (content) {
      score += this._scoreContentSemantic(content, keywords)
    }

    score += this._scoreActionTargets(baseName, lowerPath, content)

    score -= this._scoreNegationPenalty(baseName, lowerPath, content)

    score += this._scoreIntentCooccurrence(baseName, lowerPath)

    if (allFileStructures && this.structureAnalyzer) {
      score += this.structureAnalyzer.computeDependencyBoost(filePath, allFileStructures, keywords)
    }

    return Math.max(score, 0)
  }

  _scoreFileReference(lowerPath, baseName) {
    let score = 0
    for (const fileRef of this.intentExtractor.fileReferences) {
      if (this._wordBoundaryMatch(lowerPath, fileRef) || this._wordBoundaryMatch(baseName, fileRef)) {
        score += 100
      }
    }
    return score
  }

  _scoreModuleReference(baseName, lowerPath) {
    let score = 0
    for (const modRef of this.intentExtractor.moduleReferences) {
      if (this._wordBoundaryMatch(baseName, modRef) || this._wordBoundaryMatch(lowerPath, modRef)) {
        score += 50
      }
    }
    return score
  }

  _scoreIntentFilePatterns(baseName, lowerPath) {
    let score = 0
    for (const intent of this.intentExtractor.intents) {
      for (const fp of intent.filePatterns) {
        if (this._wordBoundaryMatch(baseName, fp) || this._wordBoundaryMatch(lowerPath, fp)) {
          score += 30
        }
      }
    }
    return score
  }

  _scoreKeywordPathMatch(baseName, lowerPath, keywords) {
    let score = 0
    for (const kw of keywords) {
      if (this._wordBoundaryMatch(baseName, kw)) {
        score += 20
      }
      if (this._wordBoundaryMatch(lowerPath, kw)) {
        score += 10
      }
    }
    return score
  }

  _scoreContentSemantic(content, keywords) {
    let score = 0
    const lowerContent = content.toLowerCase()

    for (const kw of keywords) {
      if (this.intentExtractor.negatedTerms.has(kw)) continue

      let weight = 2
      if (this.tfIdfScorer) {
        const tfidfWeight = this.tfIdfScorer.getTermWeight(kw, content)
        weight = Math.max(tfidfWeight, 0.5)
      }

      const count = this._countOccurrences(lowerContent, kw)
      if (count > 0) {
        score += Math.min(count * weight, 25)
      }
    }

    return Math.min(score, 100)
  }

  _scoreActionTargets(baseName, lowerPath, content) {
    let score = 0
    for (const { action, target } of this.intentExtractor.actionTargets) {
      const targetMatchesPath = this._wordBoundaryMatch(baseName, target) || this._wordBoundaryMatch(lowerPath, target)
      const targetMatchesContent = content && this._countOccurrences(content.toLowerCase(), target) > 0

      if (targetMatchesPath) {
        const actionBoost = this._getActionBoost(action)
        score += actionBoost
      }
      if (targetMatchesContent) {
        score += 15
      }
    }
    return score
  }

  _scoreNegationPenalty(baseName, lowerPath, content) {
    let penalty = 0
    for (const negTerm of this.intentExtractor.negatedTerms) {
      if (this._wordBoundaryMatch(baseName, negTerm) || this._wordBoundaryMatch(lowerPath, negTerm)) {
        penalty += 80
      }
      if (content && this._countOccurrences(content.toLowerCase(), negTerm) > 0) {
        penalty += 30
      }
    }
    return penalty
  }

  _scoreIntentCooccurrence(baseName, lowerPath) {
    let score = 0
    const matchedIntents = []

    for (const intent of this.intentExtractor.intents) {
      for (const fp of intent.filePatterns) {
        if (this._wordBoundaryMatch(baseName, fp) || this._wordBoundaryMatch(lowerPath, fp)) {
          matchedIntents.push(intent.name)
          break
        }
      }
    }

    for (let i = 0; i < matchedIntents.length; i++) {
      for (let j = i + 1; j < matchedIntents.length; j++) {
        const key = [matchedIntents[i], matchedIntents[j]].sort().join('|')
        if (this.intentExtractor.intentCooccurrences.has(key)) {
          score += 25
        }
      }
    }

    return score
  }

  _getActionBoost(action) {
    const boosts = {
      create: 40,
      modify: 45,
      delete: 35,
      query: 25,
      debug: 50,
      refactor: 40
    }
    return boosts[action] || 30
  }

  _wordBoundaryMatch(text, term) {
    if (text.includes(term)) {
      const idx = text.indexOf(term)
      const beforeOk = idx === 0 || /[-_./\\]/.test(text[idx - 1]) || !/\w/.test(text[idx - 1])
      const afterIdx = idx + term.length
      const afterOk = afterIdx >= text.length || /[-_./\\]/.test(text[afterIdx]) || !/\w/.test(text[afterIdx])
      if (beforeOk && afterOk) return true
    }
    return false
  }

  _countOccurrences(text, term) {
    let count = 0
    let pos = 0
    while ((pos = text.indexOf(term, pos)) !== -1) {
      count++
      pos += term.length
    }
    return count
  }

  scoreCodeBlock(block, keywords) {
    let score = 0
    const lowerContent = block.content.toLowerCase()
    const lowerName = block.name.toLowerCase()

    for (const kw of keywords) {
      if (this.intentExtractor.negatedTerms.has(kw)) continue

      if (this._wordBoundaryMatch(lowerName, kw)) {
        score += 30
      }

      let weight = 3
      if (this.tfIdfScorer) {
        const tfidfWeight = this.tfIdfScorer.getTermWeight(kw, block.content)
        weight = Math.max(tfidfWeight * 1.5, 1)
      }

      const count = this._countOccurrences(lowerContent, kw)
      if (count > 0) {
        score += Math.min(count * weight, 50)
      }
    }

    for (const { target } of this.intentExtractor.actionTargets) {
      if (this._wordBoundaryMatch(lowerName, target)) {
        score += 20
      }
    }

    return score
  }
}

class SmartContextExtractor {
  constructor(rootDir, options = {}) {
    this.rootDir = path.resolve(rootDir)
    this.scanner = new CodeScanner(rootDir)
    this.tfIdfScorer = new TfIdfScorer()
    this.structureAnalyzer = new CodeStructureAnalyzer()
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

  async extract(prompt) {
    const intentExtractor = new IntentExtractor(prompt)
    const scorer = new RelevanceScorer(intentExtractor, this.tfIdfScorer, this.structureAnalyzer)
    const keywords = intentExtractor.getAllKeywords()

    if (keywords.length === 0) {
      return this._fallbackExtraction(prompt)
    }

    const allFiles = await this._getAllFiles()

    const allContents = []
    for (const file of allFiles) {
      const content = await this._getFileContent(file)
      allContents.push(content)
    }
    this.tfIdfScorer.buildCorpus(allContents)

    const allFileStructures = new Map()
    for (const file of allFiles) {
      const content = await this._getFileContent(file)
      allFileStructures.set(file, this.structureAnalyzer.analyze(file, content))
    }

    const scoredFiles = []

    for (const file of allFiles) {
      const content = await this._getFileContent(file)
      const score = scorer.scoreFile(file, content, allFileStructures)
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
      actionTargets: intentExtractor.actionTargets,
      negatedTerms: Array.from(intentExtractor.negatedTerms),
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

  async _fallbackExtraction(prompt) {
    const allFiles = await this._getAllFiles()
    const files = allFiles.slice(0, Math.min(10, this.options.maxFiles))

    const blocks = []
    for (const file of files) {
      blocks.push({
        file,
        type: 'full',
        name: path.basename(file),
        content: await this._getFileContent(file),
        score: 0
      })
    }
    
    return {
      mode: 'fallback',
      keywords: [],
      intents: [],
      fileReferences: [],
      moduleReferences: [],
      blocks,
      totalTokens: 0,
      stats: {
        totalFiles: allFiles.length,
        matchedFiles: files.length,
        extractedBlocks: files.length
      }
    }
  }

  async _getAllFiles() {
    if (this.fileCache.size === 0) {
      const files = await this.scanner.scan()
      for (const file of files) {
        this.fileCache.set(file, true)
      }
      return files
    }
    return Array.from(this.fileCache.keys())
  }

  async _getFileContent(relativePath) {
    if (this.contentCache.has(relativePath)) {
      return this.contentCache.get(relativePath)
    }
    
    const absPath = path.join(this.rootDir, relativePath)
    try {
      const content = await fsp.readFile(absPath, 'utf8')
      this.contentCache.set(relativePath, content)
      return content
    } catch (e) {
      return ''
    }
  }

  async buildContext(prompt, outputPath) {
    const result = await this.extract(prompt)
    const lines = []

    lines.push(`# ContextGate Smart Context`)
    lines.push(`# Generated: ${new Date().toISOString()}`)
    lines.push(`# Mode: ${result.mode}`)
    lines.push(`# Keywords: ${result.keywords.join(', ') || 'none'}`)
    lines.push(`# Intents: ${result.intents.join(', ') || 'none'}`)
    lines.push(`# Files Referenced: ${result.fileReferences.join(', ') || 'none'}`)
    lines.push(`# Modules Referenced: ${result.moduleReferences.join(', ') || 'none'}`)
    if (result.actionTargets && result.actionTargets.length > 0) {
      lines.push(`# Action Targets: ${result.actionTargets.map(at => at.action + ':' + at.target).join(', ')}`)
    }
    if (result.negatedTerms && result.negatedTerms.length > 0) {
      lines.push(`# Excluded: ${result.negatedTerms.join(', ')}`)
    }
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
    await fsp.writeFile(outputPath, content, 'utf8')

    return {
      ...result,
      outputPath,
      contentLength: content.length
    }
  }

  clearCache() {
    this.fileCache.clear()
    this.contentCache.clear()
    this.structureAnalyzer.clearCache()
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

  async _buildFileHashCache() {
    if (this.allFiles) return this.allFiles
    this.allFiles = await this.scanner.scan()
    return this.allFiles
  }

  async extract(prompt, maxFiles = 20) {
    return this.smartExtractor.extract(prompt)
  }

  async buildPartial(prompt, outputPath) {
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

  async _walkDirAsync(dir, concurrency = 8) {
    const files = []
    const queue = [dir]
    let activeCount = 0
    let resolveDrain = null
    let pending = new Promise(r => { resolveDrain = r })

    const processDir = async (currentDir) => {
      activeCount++
      try {
        let entries
        try {
          entries = await fsp.readdir(currentDir, { withFileTypes: true })
        } catch (e) {
          return
        }

        const subDirs = []

        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name)
          const relativePath = path.relative(this.rootDir, fullPath)

          if (entry.isDirectory()) {
            if (EXCLUDE_DIRS.has(entry.name)) continue
            if (entry.name.startsWith('.')) continue
            const relDir = relativePath + '/'
            if (this._ig.ignores(relDir)) continue
            subDirs.push(fullPath)
          } else if (entry.isFile()) {
            if (this._ig.ignores(relativePath)) continue
            if (this._shouldIncludeFile(fullPath)) {
              files.push(relativePath)
            }
          }
        }

        for (const subDir of subDirs) {
          queue.push(subDir)
        }
      } finally {
        activeCount--
        if (activeCount === 0 && queue.length === 0) {
          resolveDrain()
        }
      }
    }

    const runWorkers = async () => {
      while (queue.length > 0 || activeCount > 0) {
        while (queue.length > 0 && activeCount < concurrency) {
          const nextDir = queue.shift()
          processDir(nextDir)
        }
        await new Promise(r => setTimeout(r, 0))
        if (activeCount === 0 && queue.length === 0) break
      }
    }

    await runWorkers()
    return files
  }

  async scan() {
    const files = await this._walkDirAsync(this.rootDir)
    return files.sort()
  }

  async buildContext(outputPath) {
    const files = await this.scan()
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
        const content = await fsp.readFile(absPath, 'utf8')
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
    await fsp.writeFile(outputPath, fullContent, 'utf8')

    const estimatedTokens = Math.ceil(totalChars / 4)

    return {
      fileCount: files.length,
      totalChars,
      estimatedTokens,
      outputPath
    }
  }

  async buildPartialContext(prompt, outputPath) {
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
