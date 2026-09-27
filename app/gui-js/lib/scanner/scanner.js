const path = require('path')
const fs = require('fs')
const { DEFAULT_EXTENSIONS, BINARY_EXTENSIONS, EXCLUDE_DIRS } = require('./constants')
const { IntentExtractor } = require('./intent')
const { IgnoreRules, detectSecrets } = require('./ignore')

const CHARS_PER_TOKEN = 4
const MANIFEST_SUFFIX = '.manifest.json'
const DEFAULT_SUMMARY_LINES = 12
const DEFAULT_MAX_TOKENS = 8000
const HEADER_RESERVE_CHARS = 240

// ---------------------------------------------------------------------------
// FIX-05：排序与预算
// 原实现按字典序把所有文件全量拼接（实测 492KB），既没有 token 预算，也没有
// 任何优先级。这里用「信号量」排序把高价值文件放进预算内。
// 注意：排序输入只用路径与字节数，不用 mtime —— 保证两次构建字节完全一致。
// ---------------------------------------------------------------------------

const SOURCE_WEIGHTS = {
  '.ts': 22, '.tsx': 20, '.mts': 22, '.js': 20, '.jsx': 18, '.mjs': 20, '.cjs': 20,
  '.py': 22, '.go': 22, '.rs': 22, '.java': 20, '.kt': 18, '.swift': 18, '.cs': 18,
  '.rb': 18, '.php': 18, '.scala': 18, '.c': 14, '.cpp': 14, '.h': 12, '.hpp': 12,
  '.vue': 16, '.svelte': 16, '.sql': 12, '.sh': 10, '.bash': 10,
  '.css': 6, '.scss': 6, '.less': 6, '.html': 6,
  '.yaml': 8, '.yml': 8, '.toml': 8, '.json': 6, '.xml': 4,
  '.md': 5, '.txt': 3, '.csv': 1,
}

const ENTRY_BASENAMES = new Set([
  'readme.md', 'package.json', 'pyproject.toml', 'cargo.toml', 'go.mod',
  'requirements.txt', 'makefile', 'dockerfile', 'index.js', 'index.ts',
  'main.js', 'main.ts', 'app.js', 'app.ts', 'cli.js', 'main.py', 'app.py',
  'manage.py', 'settings.py',
])

const CORE_DIR_RE = /^(?:src|lib|app|packages|core|server|api|internal|cmd)\//
const TEST_DIR_RE = /(?:^|\/)(?:tests?|__tests__|spec)\//
const TEST_FILE_RE = /\.(?:test|spec)\.[a-z]+$/
const DOC_DIR_RE = /(?:^|\/)(?:docs?|examples?|samples?|fixtures?)\//
const LOW_SIGNAL_RE = /(?:^|\/)(?:node_modules|vendor|dist|build|coverage|__snapshots__)\//
const GENERATED_RE = /\.(?:min|bundle)\.(?:js|css)$|\.generated\.|\.g\.d\.ts$/

function estimateTokens(text) { return Math.ceil(String(text || '').length / CHARS_PER_TOKEN) }

// 产物与 manifest 统一使用 POSIX 分隔符，保证跨平台可复现
function toPosix(relPath) { return String(relPath).split(path.sep).join('/') }

function scoreFile(relPath, size, options = {}) {
  const lower = relPath.toLowerCase()
  const ext = path.extname(lower)
  let score = SOURCE_WEIGHTS[ext] !== undefined ? SOURCE_WEIGHTS[ext] : 2
  if (ENTRY_BASENAMES.has(path.basename(lower))) score += 30
  if (CORE_DIR_RE.test(lower)) score += 12
  if (TEST_DIR_RE.test(lower) || TEST_FILE_RE.test(lower)) score -= 6
  if (DOC_DIR_RE.test(lower)) score -= 4
  if (LOW_SIGNAL_RE.test(lower)) score -= 80
  if (GENERATED_RE.test(lower)) score -= 60
  // 体积惩罚：同一个预算里，小文件能放下更多高信号内容。
  // 只依赖字节数（不依赖 mtime），保证两次构建完全一致。
  score -= Math.min(25, Math.round((Number(size) || 0) / 4000))
  // 被其他文件引用得越多，越可能是核心模块
  const refs = options.references && typeof options.references.get === 'function'
    ? options.references.get(relPath) || 0 : 0
  if (refs > 0) score += Math.min(18, refs * 3)
  if (Array.isArray(options.focusTerms)) {
    for (const term of options.focusTerms) {
      if (term && lower.includes(String(term).toLowerCase())) { score += 15; break }
    }
  }
  return score
}

function rankFiles(entries, options = {}) {
  return entries
    .map(e => ({ ...e, score: scoreFile(e.rel, e.size, options) }))
    .sort((a, b) => (b.score - a.score) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// CDATA 不能包含 ']]>'，按规范拆分
function cdata(text) {
  return '<![CDATA[' + String(text).split(']]>').join(']]]]><![CDATA[>') + ']]>'
}

function markdownSection(relPath, content, opts = {}) {
  const note = opts.note ? ` (${opts.note})` : ''
  return [
    '',
    '# ============================================================',
    `# File: ${relPath}${note}`,
    '# ============================================================',
    content,
  ].join('\n')
}

function xmlSection(relPath, content, opts = {}) {
  const note = opts.note ? ` note="${escapeXml(opts.note)}"` : ''
  return `<file path="${escapeXml(relPath)}" tokens="${estimateTokens(content)}"${note}>${cdata(content)}</file>`
}

class CodeScanner {
  constructor(rootDir, config = {}) {
    this.rootDir = path.resolve(rootDir)
    this.config = config
    this._ignore = this._createIgnore(config)
  }

  _createIgnore(config) {
    const disabled = config.respect_ignore === false
    return new IgnoreRules(this.rootDir, {
      disabled,
      useDefaults: config.use_default_ignore !== false,
      extra: Array.isArray(config.exclude) ? config.exclude : [],
    })
  }

  /** 重建忽略规则（watch 触发重建时使用） */
  reloadIgnoreRules() { this._ignore = this._createIgnore(this.config) }

  _shouldIncludeFile(filePath, relPath) {
    if (relPath && this._ignore.matchesEnvFile(relPath)) return false
    const ext = path.extname(filePath).toLowerCase()
    const includeExts = this.config.include_extensions || DEFAULT_EXTENSIONS
    if (includeExts.length > 0 && !includeExts.includes(ext)) return false
    if (BINARY_EXTENSIONS.has(ext)) return false
    const maxSize = this.config.max_file_size || 1048576
    try { if (fs.statSync(filePath).size > maxSize) return false } catch { return false }
    return true
  }

  async _walkDir(dir) {
    const files = []
    const queue = [dir]
    const concurrency = 8
    let active = 0
    let resolveDrain
    const drain = new Promise(r => { resolveDrain = r })

    const processDir = async (currentDir) => {
      active++
      try {
        // 进入目录时加载该目录的 .gitignore / .contextgateignore（支持嵌套）
        this._ignore.addDirectory(currentDir)
        const entries = await fs.promises.readdir(currentDir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name)
          const rel = path.relative(this.rootDir, fullPath)
          if (entry.isDirectory()) {
            if (EXCLUDE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
            if (this._ignore.ignoresDir(rel)) continue
            queue.push(fullPath)
          } else if (entry.isFile()) {
            if (this._ignore.ignores(rel)) continue
            if (this._shouldIncludeFile(fullPath, rel)) files.push(rel)
          }
        }
      } catch (e) { console.error(`Failed to read ${currentDir}:`, e.message) }
      finally {
        active--
        // 延迟一个微任务，让外层 while 循环有机会先从 queue 取出新目录并递增 active，
        // 避免 drain 在子目录入队但尚未被调度时提前触发
        await Promise.resolve()
        if (active === 0 && queue.length === 0) resolveDrain()
      }
    }

    while (queue.length > 0 || active > 0) {
      while (queue.length > 0 && active < concurrency) processDir(queue.shift())
      await new Promise(r => setTimeout(r, 0))
      if (active === 0 && queue.length === 0) break
    }
    await drain
    return files
  }

  async scan() { return (await this._walkDir(this.rootDir)).sort() }

  /**
   * 统计每个文件被其他文件引用的次数（有界的廉价「重要性」信号）。
   * 只读取不超过 maxFileBytes 的候选文件，且累计读取量有上限，
   * 保证大仓库下不会失控；结果只依赖文件内容，因此是可复现的。
   */
  async buildReferenceIndex(candidates, options = {}) {
    const maxFileBytes = options.maxFileBytes || 131072
    const maxTotalBytes = options.maxTotalBytes || 8 * 1024 * 1024
    const maxBasenames = options.maxBasenames || 600
    const counts = new Map()
    const names = []
    for (const c of candidates) {
      const base = path.basename(c.rel)
      if (base.length < 3 || names.length >= maxBasenames) continue
      names.push(base)
    }
    if (names.length === 0) return counts
    const escaped = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length)
    let pattern
    try { pattern = new RegExp(escaped.join('|'), 'g') } catch { return counts }
    const byBasename = new Map()
    for (const c of candidates) {
      const base = path.basename(c.rel)
      if (!byBasename.has(base)) byBasename.set(base, [])
      byBasename.get(base).push(c.rel)
    }
    let scannedBytes = 0
    for (const c of candidates) {
      if (scannedBytes >= maxTotalBytes) break
      if (c.size > maxFileBytes) continue
      let content
      try { content = await fs.promises.readFile(path.join(this.rootDir, c.rel), 'utf8') } catch { continue }
      scannedBytes += content.length
      const seen = new Set()
      for (const match of content.matchAll(pattern)) {
        const token = match[0]
        if (seen.has(token)) continue
        seen.add(token)
        for (const rel of byBasename.get(token) || []) {
          if (rel === c.rel) continue
          counts.set(rel, (counts.get(rel) || 0) + 1)
        }
      }
    }
    return counts
  }

  /** 返回带字节数的候选文件（用于排序与预算裁剪） */
  async scanEntries() {
    const rels = await this.scan()
    const entries = []
    for (const rel of rels) {
      try { entries.push({ rel, size: fs.statSync(path.join(this.rootDir, rel)).size }) }
      catch { /* 文件可能在扫描后消失 */ }
    }
    return entries
  }

  _renderHeader(format, projectRoot, includedCount) {
    if (format === 'xml') {
      return `<context project="${escapeXml(projectRoot)}" files="${includedCount}">`
    }
    return ['# ContextGate Context', `# Project: ${projectRoot}`, `# Files: ${includedCount}`, ''].join('\n')
  }

  _renderSection(format, rel, content, opts) {
    return format === 'xml' ? xmlSection(rel, content, opts) : markdownSection(rel, content, opts)
  }

  _renderFooter(format) { return format === 'xml' ? '</context>' : '' }

  /**
   * 构建上下文产物。
   *
   * @param {string} [outputPath]
   * @param {{format?:string, maxTokens?:number, enforceBudget?:boolean, summarizeSkipped?:boolean,
   *          summaryLines?:number, secretScan?:boolean, focusTerms?:string[], writeManifest?:boolean}} [options]
   */
  async buildContext(outputPath, options = {}) {
    const cfg = this.config || {}
    const resolvedOutput = outputPath || path.join(this.rootDir, cfg.output_file || 'full_context.txt')
    const manifestPath = resolvedOutput + MANIFEST_SUFFIX
    const format = (options.format || cfg.format || 'markdown').toLowerCase()
    const maxTokens = options.maxTokens !== undefined ? Number(options.maxTokens) : Number(cfg.max_tokens !== undefined ? cfg.max_tokens : DEFAULT_MAX_TOKENS)
    const enforceBudget = (options.enforceBudget !== undefined ? options.enforceBudget : cfg.enforce_budget !== false) && maxTokens > 0
    const summarizeSkipped = options.summarizeSkipped !== undefined ? options.summarizeSkipped : cfg.summarize_skipped !== false
    const summaryLines = Number(options.summaryLines !== undefined ? options.summaryLines : (cfg.summary_lines !== undefined ? cfg.summary_lines : DEFAULT_SUMMARY_LINES))
    const secretScan = options.secretScan !== undefined ? options.secretScan : cfg.secret_scan !== false
    const strict = options.strictBudget === true

    const excludedAbs = new Set([path.resolve(resolvedOutput), path.resolve(manifestPath)])

    const allFiles = await this.scan()
    const candidates = []
    for (const rel of allFiles) {
      const abs = path.join(this.rootDir, rel)
      if (excludedAbs.has(path.resolve(abs))) continue
      try { candidates.push({ rel, size: fs.statSync(abs).size }) }
      catch { /* 忽略消失的文件 */ }
    }

    const references = options.computeReferences === false
      ? new Map()
      : await this.buildReferenceIndex(candidates)
    const ranked = rankFiles(candidates, { focusTerms: options.focusTerms, references })
    const budgetChars = enforceBudget ? maxTokens * CHARS_PER_TOKEN : Infinity

    const included = []
    const summarized = []
    const skipped = []
    let usedChars = this._renderHeader(format, this.rootDir, 0).length + HEADER_RESERVE_CHARS

    for (const entry of ranked) {
      const sectionOverhead = entry.rel.length + 90
      const cost = entry.size + sectionOverhead
      if (usedChars + cost <= budgetChars) {
        included.push(entry)
        usedChars += cost
      }
    }

    if (enforceBudget && summarizeSkipped && summaryLines > 0) {
      const includedSet = new Set(included.map(e => e.rel))
      for (const entry of ranked) {
        if (includedSet.has(entry.rel)) continue
        const summaryBudget = Math.min(entry.size, summaryLines * 120) + entry.rel.length + 120
        if (usedChars + summaryBudget <= budgetChars) {
          summarized.push(entry)
          usedChars += summaryBudget
        } else {
          skipped.push(toPosix(entry.rel))
        }
      }
    } else if (enforceBudget) {
      const includedSet = new Set(included.map(e => e.rel))
      for (const entry of ranked) if (!includedSet.has(entry.rel)) skipped.push(toPosix(entry.rel))
    }

    // 读取实际内容（只读入选文件）
    const secrets = []
    const sections = []
    let totalChars = 0
    const includedRecords = []

    const readContent = async (rel) => {
      try { return await fs.promises.readFile(path.join(this.rootDir, rel), 'utf8') }
      catch { return null }
    }

    for (const entry of included) {
      const rel = toPosix(entry.rel)
      const content = await readContent(entry.rel)
      if (content === null) continue
      if (secretScan) {
        const hits = detectSecrets(content)
        if (hits.length > 0) secrets.push({ path: rel, types: hits })
      }
      const section = this._renderSection(format, rel, content)
      sections.push({ entry, section, chars: section.length + 1 })
      totalChars += section.length + 1
      includedRecords.push({ path: rel, tokens: estimateTokens(content), chars: content.length, truncated: false, score: entry.score })
    }

    for (const entry of summarized) {
      const rel = toPosix(entry.rel)
      const content = await readContent(entry.rel)
      if (content === null) continue
      const lines = content.split('\n')
      const head = lines.slice(0, summaryLines).join('\n')
      const note = lines.length > summaryLines
        ? `summary - ${summaryLines}/${lines.length} lines`
        : 'summary'
      const section = this._renderSection(format, rel, head, { note })
      sections.push({ entry, section, chars: section.length + 1, summary: true, note })
      totalChars += section.length + 1
      includedRecords.push({ path: rel, tokens: estimateTokens(head), chars: head.length, truncated: true, note, score: entry.score })
    }

    // 预算兜底：直接以「产物的估算 token」为准，从尾部逐条回退直到满足预算
    let dropped = []
    const renderAll = (count) => {
      const header = this._renderHeader(format, this.rootDir, count)
      const parts = [header]
      for (let i = 0; i < count; i++) parts.push(sections[i].section)
      const footer = this._renderFooter(format)
      if (footer) parts.push(footer)
      return parts.join('\n')
    }

    let rendered = renderAll(sections.length)
    let guard = 0
    while (enforceBudget && estimateTokens(rendered) > maxTokens && sections.length > 0 && guard < 200) {
      const removed = sections.pop()
      dropped.push(toPosix(removed.entry.rel))
      includedRecords.pop()
      totalChars -= removed.chars
      guard++
      rendered = renderAll(sections.length)
    }
    // 被预算兜底挤出的文件按原顺序归入 skipped
    for (const rel of dropped.slice().reverse()) if (!skipped.includes(rel)) skipped.push(rel)
    dropped = null

    await fs.promises.writeFile(resolvedOutput, rendered, 'utf8')

    const secretWarnings = secrets.length > 0
      ? secrets.map(s => `${s.path}: ${s.types.join(', ')}`) : []
    if (secretWarnings.length > 0) {
      console.warn(`[scanner] 疑似凭据命中 ${secretWarnings.length} 个文件（已记入 manifest，未剔除）:\n  ${secretWarnings.join('\n  ')}`)
    }

    const manifest = {
      generatedAt: new Date().toISOString(),
      projectRoot: this.rootDir,
      outputPath: resolvedOutput,
      format,
      maxTokens: enforceBudget ? maxTokens : null,
      estimatedTokens: estimateTokens(rendered),
      totalChars,
      candidateFiles: candidates.length,
      includedFiles: includedRecords.length,
      included: includedRecords,
      skipped,
      secrets,
    }
    if (options.writeManifest !== false) {
      await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    }

    const result = {
      fileCount: includedRecords.length,
      totalFiles: candidates.length,
      totalChars,
      estimatedTokens: estimateTokens(rendered),
      outputPath: resolvedOutput,
      manifestPath,
      format,
      skippedCount: skipped.length,
      secrets,
      manifest,
    }
    if (strict && enforceBudget && result.estimatedTokens > maxTokens) {
      const err = new Error(`Context exceeded token budget: ${result.estimatedTokens} > ${maxTokens}`)
      err.code = 'BUDGET_EXCEEDED'
      throw err
    }
    return result
  }

  extractIntent(prompt) { return new IntentExtractor(prompt) }
}

module.exports = {
  CodeScanner,
  estimateTokens,
  scoreFile,
  rankFiles,
  DEFAULT_SUMMARY_LINES,
  MANIFEST_SUFFIX,
}
