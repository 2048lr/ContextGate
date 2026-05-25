const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const ignore = require('ignore')
const { IntentExtractor } = require('./scanner/intent')
const { CodeBlockExtractor, FileExtractor } = require('./scanner/extractor')
const { CodeStructureAnalyzer, TfIdfScorer } = require('./scanner/analyzer')
const { RelevanceScorer } = require('./scanner/scorer')
const { SmartContextExtractor, ContextExtractor } = require('./scanner/smart-extractor')
const { DEFAULT_EXTENSIONS, BINARY_EXTENSIONS, EXCLUDE_DIRS } = require('./scanner/constants')

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
      console.error(`Failed to check binary status for ${filePath}:`, e.message)
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
      console.error(`Failed to stat file ${filePath}:`, e.message)
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
          console.error(`Failed to read directory ${currentDir}:`, e.message)
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
