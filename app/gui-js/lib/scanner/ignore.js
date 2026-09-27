const fs = require('fs')
const path = require('path')
const ignore = require('ignore')

// FIX-05：忽略规则
// 原实现只读根目录单个 .gitignore，且默认排除规则很弱（无 .env 特判、无 secret 扫描）。
// 现在覆盖：根/嵌套 .gitignore、.git/info/exclude、.contextgateignore、默认低信号与凭据文件。

const DEFAULT_IGNORE_PATTERNS = [
  // 低信号产物
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json',
  '*.lock', '*.min.js', '*.min.css', '*.map', '*.snap',
  '*.sqlite', '*.sqlite3', '*.db',
  'full_context.txt', 'full_context.txt.manifest.json', '*.manifest.json',
  // 凭据类文件默认不进上下文
  '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.netrc', '.npmrc', '.pypirc',
  'credentials.json', 'service-account*.json',
  // 系统文件
  '.DS_Store', 'Thumbs.db', 'desktop.ini',
]

// .env 系列（含 .env.local / .env.production 这类无扩展名变体）
const ENV_FILE_RE = /^\.env(\..+)?$/i

// 高置信度凭据模式。命中只做告警并记入 manifest —— 不静默剔除源文件。
const SECRET_PATTERNS = [
  { name: 'private_key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'openai_key', re: /\bsk-(?!ant-)[A-Za-z0-9_-]{24,}\b/ },
  { name: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { name: 'generic_secret', re: /(?:api[_-]?key|apikey|secret|passwd|password|access[_-]?token)\s*[:=]\s*['"][^'"\s]{16,}['"]/i },
]

const PLACEHOLDER_VALUE_RE = /^(?:your|xxx+|placeholder|test|dummy|fake|example|sample|changeme|replace|insert|enter|<|\$\{|\{\{|sk-xxx)/i

function isPlaceholderValue(value) {
  return !value || PLACEHOLDER_VALUE_RE.test(value.trim())
}

/** 扫描文本，返回命中的凭据类型（去重） */
function detectSecrets(content) {
  const hits = []
  for (const { name, re } of SECRET_PATTERNS) {
    const m = content.match(re)
    if (!m) continue
    if (name === 'generic_secret') {
      const value = m[0].split(/[:=]/).slice(1).join(':').replace(/['"\s]/g, '')
      if (isPlaceholderValue(value)) continue
    }
    hits.push(name)
  }
  return hits
}

class IgnoreRules {
  /**
   * @param {string} rootDir 项目根目录
   * @param {{ extra?: string[], useDefaults?: boolean, disabled?: boolean }} [options]
   */
  constructor(rootDir, options = {}) {
    this.rootDir = path.resolve(rootDir)
    this.disabled = options.disabled === true
    this.matchers = []
    this._loadedDirs = new Set()
    this.defaults = ignore()
    if (options.useDefaults !== false) this.defaults.add(DEFAULT_IGNORE_PATTERNS)
    if (Array.isArray(options.extra) && options.extra.length > 0) this.defaults.add(options.extra)
  }

  _readIgnoreFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null
      const text = fs.readFileSync(filePath, 'utf8')
      return text.trim() ? ignore().add(text) : null
    } catch { return null }
  }

  /** 进入某个目录时加载该目录的忽略文件（BFS 顺序，天然只加载一次） */
  addDirectory(dirAbs) {
    if (this.disabled) return
    const abs = path.resolve(dirAbs)
    if (this._loadedDirs.has(abs)) return
    this._loadedDirs.add(abs)
    const relBase = path.relative(this.rootDir, abs).split(path.sep).join('/')
    for (const name of ['.gitignore', '.contextgateignore']) {
      const matcher = this._readIgnoreFile(path.join(abs, name))
      if (matcher) this.matchers.push({ base: relBase, matcher })
    }
    if (relBase === '') {
      const excludeMatcher = this._readIgnoreFile(path.join(abs, '.git', 'info', 'exclude'))
      if (excludeMatcher) this.matchers.push({ base: '', matcher: excludeMatcher })
    }
  }

  /** @returns {boolean} 该相对路径是否应被忽略 */
  ignores(relPath) {
    if (this.disabled) return false
    const rel = String(relPath).split(path.sep).join('/').replace(/^\.\//, '')
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false
    if (this.defaults.ignores(rel)) return true
    for (const { base, matcher } of this.matchers) {
      let sub = rel
      if (base) {
        if (!rel.startsWith(base + '/')) continue
        sub = rel.slice(base.length + 1)
      }
      try { if (matcher.ignores(sub)) return true } catch { /* ignore 库对非法路径会抛错 */ }
    }
    return false
  }

  /** 目录判断（尾部补斜杠，让 'node_modules/' 这类模式正确匹配） */
  ignoresDir(relPath) {
    const rel = String(relPath).split(path.sep).join('/')
    return this.ignores(rel) || this.ignores(rel + '/')
  }

  matchesEnvFile(relPath) {
    const base = path.basename(String(relPath))
    return ENV_FILE_RE.test(base)
  }
}

module.exports = {
  IgnoreRules,
  DEFAULT_IGNORE_PATTERNS,
  SECRET_PATTERNS,
  ENV_FILE_RE,
  detectSecrets,
  isPlaceholderValue,
}
