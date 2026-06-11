const fs = require('fs')
const path = require('path')
const { CODE_BLOCK_SIGNATURES, FILE_EXTENSION_MAP, BINARY_EXTENSIONS } = require('./constants')

class CodeBlockExtractor {
  constructor(filePath, content) {
    this.filePath = filePath
    this.content = content
    this.ext = path.extname(filePath).toLowerCase()
    this.language = FILE_EXTENSION_MAP[this.ext] || null
    this.blocks = []
  }

  extract() {
    if (!this.language) return this.blocks
    const signatures = CODE_BLOCK_SIGNATURES[this.language]
    if (!signatures) return this.blocks

    for (const [blockType, pattern] of Object.entries(signatures)) {
      const regex = new RegExp(pattern.source, pattern.flags)
      let match
      while ((match = regex.exec(this.content)) !== null) {
        const name = match[1]
        const startPos = match.index
        const endPos = this.language === 'python'
          ? this._findPythonBlockEnd(match.index + match[0].length)
          : this._findBlockEnd(startPos + match[0].length)
        const body = this.content.substring(startPos, endPos)
        this.blocks.push({
          type: blockType,
          name,
          startLine: this._getLineNumber(startPos),
          endLine: this._getLineNumber(endPos),
          body,
          filePath: this.filePath,
          language: this.language
        })
      }
    }

    this.blocks.sort((a, b) => a.startLine - b.startLine)
    return this.blocks
  }

  _findBlockEnd(startPos) {
    let depth = 1
    let pos = startPos
    const len = this.content.length

    while (pos < len && depth > 0) {
      const ch = this.content[pos]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      else if (ch === '"' || ch === "'" || ch === '`') {
        pos = this._skipString(pos, ch)
        continue
      } else if (ch === '/' && pos + 1 < len) {
        const next = this.content[pos + 1]
        if (next === '/') {
          pos = this._skipLineComment(pos)
          continue
        } else if (next === '*') {
          pos = this._skipBlockComment(pos)
          continue
        }
      }
      pos++
    }

    return pos
  }

  _findPythonBlockEnd(startPos) {
    const lines = this.content.substring(startPos).split('\n')
    const defLineIdx = this.content.substring(0, startPos).split('\n').length - 1
    let baseIndent = null

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim() === '' || line.trim().startsWith('#')) continue

      const indent = line.length - line.trimStart().length
      if (baseIndent === null) {
        baseIndent = indent
        continue
      }
      if (indent <= this._getDefIndent(defLineIdx)) {
        const preceding = lines.slice(0, i).join('\n')
        return startPos + preceding.length
      }
    }
    return this.content.length
  }

  _getDefIndent(defLineIdx) {
    const lines = this.content.split('\n')
    if (defLineIdx >= lines.length) return 0
    const line = lines[defLineIdx]
    return line.length - line.trimStart().length
  }

  _skipString(startPos, quote) {
    let pos = startPos + 1
    while (pos < this.content.length) {
      if (this.content[pos] === '\\') {
        pos += 2
        continue
      }
      if (this.content[pos] === quote) return pos + 1
      pos++
    }
    return pos
  }

  _skipLineComment(startPos) {
    const newlineIdx = this.content.indexOf('\n', startPos)
    return newlineIdx === -1 ? this.content.length : newlineIdx + 1
  }

  _skipBlockComment(startPos) {
    const endIdx = this.content.indexOf('*/', startPos + 2)
    return endIdx === -1 ? this.content.length : endIdx + 2
  }

  _getLineNumber(pos) {
    let line = 1
    for (let i = 0; i < pos && i < this.content.length; i++) {
      if (this.content[i] === '\n') line++
    }
    return line
  }
}

class FileExtractor {
  static readFile(filePath) {
    try {
      const stat = fs.statSync(filePath)
      if (stat.size > 1024 * 1024) return null
      return fs.readFileSync(filePath, 'utf8')
    } catch (e) {
      console.error(`Failed to read file ${filePath}:`, e.message)
      return null
    }
  }

  static isBinary(filePath) {
    const ext = path.extname(filePath).toLowerCase()
    return BINARY_EXTENSIONS.has(ext)
  }

  static extractImports(content, language) {
    const imports = []
    const patterns = {
      javascript: [
        /(?:import\s+.*?\s+from\s+['"]([^'"]+)['"])/g,
        /(?:require\s*\(\s*['"]([^'"]+)['"]\s*\))/g
      ],
      typescript: [
        /(?:import\s+.*?\s+from\s+['"]([^'"]+)['"])/g,
        /(?:require\s*\(\s*['"]([^'"]+)['"]\s*\))/g
      ],
      python: [
        /(?:from\s+(\S+)\s+import)/g,
        /(?:import\s+(\S+))/g
      ],
      go: [
        /(?:"([^"]+)")/g
      ],
      java: [
        /(?:import\s+([\w.]+)\s*;)/g
      ]
    }

    const langPatterns = patterns[language]
    if (!langPatterns) return imports

    for (const pattern of langPatterns) {
      const regex = new RegExp(pattern.source, pattern.flags)
      let match
      while ((match = regex.exec(content)) !== null) {
        imports.push(match[1])
      }
    }

    return [...new Set(imports)]
  }
}

module.exports = { CodeBlockExtractor, FileExtractor }
