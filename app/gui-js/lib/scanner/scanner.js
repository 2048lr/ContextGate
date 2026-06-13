const path = require('path')
const fs = require('fs')
const { DEFAULT_EXTENSIONS, EXCLUDE_DIRS, BINARY_EXTENSIONS } = require('./constants')
const { IntentExtractor } = require('./intent')

class CodeScanner {
  constructor(rootDir, config = {}) {
    this.rootDir = path.resolve(rootDir)
    this.config = config
    this._ig = null
    this._loadGitignore()
  }

  _loadGitignore() {
    this._ig = require('ignore')()
    const gitignorePath = path.join(this.rootDir, '.gitignore')
    if (fs.existsSync(gitignorePath)) this._ig.add(fs.readFileSync(gitignorePath, 'utf8'))
  }

  _shouldIncludeFile(filePath) {
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
        const entries = await fs.promises.readdir(currentDir, { withFileTypes: true })
        const subDirs = []
        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name)
          const rel = path.relative(this.rootDir, fullPath)
          if (entry.isDirectory()) {
            if (EXCLUDE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
            if (this._ig.ignores(rel + '/')) continue
            subDirs.push(fullPath)
          } else if (entry.isFile()) {
            if (this._ig.ignores(rel)) continue
            if (this._shouldIncludeFile(fullPath)) files.push(rel)
          }
        }
        for (const d of subDirs) queue.push(d)
      } catch (e) { console.error(`Failed to read ${currentDir}:`, e.message) }
      finally { active--; if (active === 0 && queue.length === 0) resolveDrain() }
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

  async buildContext(outputPath) {
    const files = await this.scan()
    if (!outputPath) outputPath = path.join(this.rootDir, 'full_context.txt')
    let totalChars = 0
    const lines = [
      '# ContextGate Generated Context File',
      `# Project: ${this.rootDir}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Files: ${files.length}`, '',
    ]
    totalChars += lines.join('\n').length
    for (const relPath of files) {
      try {
        const content = await fs.promises.readFile(path.join(this.rootDir, relPath), 'utf8')
        const header = `\n# ============================================================\n# File: ${relPath}\n# ============================================================\n`
        lines.push(header, content)
        totalChars += header.length + content.length
      } catch (e) {
        const errMsg = `\n# File: ${relPath} (ERROR: ${e.message})\n`
        lines.push(errMsg)
        totalChars += errMsg.length
      }
    }
    await fs.promises.writeFile(outputPath, lines.join('\n'), 'utf8')
    return { fileCount: files.length, totalChars, estimatedTokens: Math.ceil(totalChars / 4), outputPath }
  }

  extractIntent(prompt) { return new IntentExtractor(prompt) }
}

module.exports = { CodeScanner }
