const path = require('path')
const fs = require('fs')
const { IntentExtractor } = require('./intent')
const { CodeBlockExtractor, FileExtractor } = require('./extractor')
const { CodeStructureAnalyzer, TfIdfScorer } = require('./analyzer')
const { RelevanceScorer } = require('./scorer')
const {
  DEFAULT_EXTENSIONS, EXCLUDE_DIRS, FILE_EXTENSION_MAP
} = require('./constants')

class SmartContextExtractor {
  constructor(projectRoot, options = {}) {
    this.projectRoot = projectRoot
    this.maxFiles = options.maxFiles || 30
    this.maxTokens = options.maxTokens || 8000
    this.minRelevanceScore = options.minRelevanceScore || 0.15
    this.relevanceScorer = new RelevanceScorer(options)
    this.tfIdfScorer = new TfIdfScorer()
    this.structureAnalyzer = new CodeStructureAnalyzer()
    this.extensions = options.extensions || DEFAULT_EXTENSIONS
    this.excludeDirs = new Set([...EXCLUDE_DIRS, ...(options.excludeDirs || [])])
  }

  async extract(prompt) {
    const intentExtractor = new IntentExtractor(prompt)
    const files = this._scanProject()

    const fileInfos = files.map(f => this._getFileInfo(f)).filter(Boolean)

    this.tfIdfScorer.buildIndex(fileInfos.map(f => ({ content: f.content || '' })))

    const scored = fileInfos.map(f => {
      const relevance = this.relevanceScorer.score(f, intentExtractor)
      const tfidf = this.tfIdfScorer.score(f.content || '', intentExtractor.getAllKeywords())
      return {
        ...f,
        relevanceScore: relevance.total,
        relevanceBreakdown: relevance.breakdown,
        tfidfScore: tfidf,
        combinedScore: relevance.total * 0.7 + Math.min(tfidf, 1.0) * 0.3
      }
    })

    const filtered = scored
      .filter(f => f.combinedScore >= this.minRelevanceScore)
      .sort((a, b) => b.combinedScore - a.combinedScore)

    const selected = this._selectWithinBudget(filtered)

    return {
      files: selected.map(f => ({
        path: f.relativePath,
        score: f.combinedScore,
        relevance: f.relevanceBreakdown,
        blocks: f.blocks ? f.blocks.length : 0
      })),
      totalTokens: this._estimateTokens(selected),
      intentSummary: {
        intents: intentExtractor.intents.map(i => i.name),
        fileReferences: intentExtractor.fileReferences,
        moduleReferences: intentExtractor.moduleReferences,
        codeConcepts: intentExtractor.codeConcepts,
        actionTargets: intentExtractor.actionTargets
      }
    }
  }

  _scanProject() {
    const files = []
    this._walkDir(this.projectRoot, files)
    return files
  }

  _walkDir(dir, files) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (this.excludeDirs.has(entry.name)) continue
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          this._walkDir(fullPath, files)
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase()
          if (this.extensions.includes(ext)) {
            files.push(fullPath)
          }
        }
      }
    } catch (e) {
      console.error(`Failed to scan directory ${dir}:`, e.message)
    }
  }

  _getFileInfo(fullPath) {
    try {
      const stat = fs.statSync(fullPath)
      const content = FileExtractor.readFile(fullPath)
      if (content === null) return null

      const ext = path.extname(fullPath).toLowerCase()
      const language = FILE_EXTENSION_MAP[ext] || null
      let blocks = []
      if (language) {
        const extractor = new CodeBlockExtractor(fullPath, content)
        blocks = extractor.extract()
      }

      return {
        fullPath,
        relativePath: path.relative(this.projectRoot, fullPath),
        content,
        language,
        blocks,
        mtime: stat.mtime,
        size: stat.size
      }
    } catch (e) {
      console.error(`Failed to get file info for ${fullPath}:`, e.message)
      return null
    }
  }

  _selectWithinBudget(scoredFiles) {
    const selected = []
    let tokenCount = 0

    for (const file of scoredFiles) {
      if (selected.length >= this.maxFiles) break
      const fileTokens = this._estimateTokens([file])
      if (tokenCount + fileTokens > this.maxTokens) {
        const truncated = this._truncateContent(file)
        if (truncated) {
          selected.push(truncated)
          tokenCount += this._estimateTokens([truncated])
        }
        continue
      }
      selected.push(file)
      tokenCount += fileTokens
    }

    return selected
  }

  _truncateContent(file) {
    if (!file.content) return file
    const maxChars = this.maxTokens * 4
    if (file.content.length <= maxChars) return file

    return {
      ...file,
      content: file.content.substring(0, maxChars) + '\n... (truncated)',
      truncated: true
    }
  }

  _estimateTokens(files) {
    let totalChars = 0
    for (const file of files) {
      totalChars += (file.content || '').length
    }
    return Math.ceil(totalChars / 4)
  }
}

class ContextExtractor {
  constructor(projectRoot, options = {}) {
    this.smartExtractor = new SmartContextExtractor(projectRoot, options)
  }

  async extract(prompt) {
    return this.smartExtractor.extract(prompt)
  }
}

module.exports = { SmartContextExtractor, ContextExtractor }
