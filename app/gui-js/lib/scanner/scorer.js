const path = require('path')
const { KEYWORD_PATTERNS } = require('./constants')

class RelevanceScorer {
  constructor(options = {}) {
    this.weights = {
      filename: options.filenameWeight || 0.25,
      path: options.pathWeight || 0.15,
      content: options.contentWeight || 0.30,
      intent: options.intentWeight || 0.20,
      recency: options.recencyWeight || 0.10
    }
  }

  score(fileInfo, intentExtractor) {
    const filenameScore = this._scoreFilename(fileInfo, intentExtractor)
    const pathScore = this._scorePath(fileInfo, intentExtractor)
    const contentScore = this._scoreContent(fileInfo, intentExtractor)
    const intentScore = this._scoreIntent(fileInfo, intentExtractor)
    const recencyScore = this._scoreRecency(fileInfo)

    const total =
      filenameScore * this.weights.filename +
      pathScore * this.weights.path +
      contentScore * this.weights.content +
      intentScore * this.weights.intent +
      recencyScore * this.weights.recency

    return {
      total: Math.min(total, 1.0),
      breakdown: {
        filename: filenameScore,
        path: pathScore,
        content: contentScore,
        intent: intentScore,
        recency: recencyScore
      }
    }
  }

  _scoreFilename(fileInfo, intentExtractor) {
    const basename = path.basename(fileInfo.relativePath, path.extname(fileInfo.relativePath)).toLowerCase()
    let score = 0

    for (const fileRef of intentExtractor.fileReferences) {
      const refBasename = path.basename(fileRef, path.extname(fileRef)).toLowerCase()
      if (basename === refBasename) {
        score += 1.0
        break
      }
      if (basename.includes(refBasename) || refBasename.includes(basename)) {
        score += 0.7
      }
    }

    for (const mod of intentExtractor.moduleReferences) {
      if (basename.includes(mod)) {
        score += 0.5
      }
    }

    for (const intent of intentExtractor.intents) {
      for (const fp of intent.filePatterns) {
        if (basename.includes(fp)) {
          score += 0.4
        }
      }
    }

    return Math.min(score, 1.0)
  }

  _scorePath(fileInfo, intentExtractor) {
    const dirPath = path.dirname(fileInfo.relativePath).toLowerCase()
    let score = 0

    for (const intent of intentExtractor.intents) {
      for (const fp of intent.filePatterns) {
        if (dirPath.includes(fp)) {
          score += 0.3
        }
      }
    }

    for (const mod of intentExtractor.moduleReferences) {
      if (dirPath.includes(mod)) {
        score += 0.4
      }
    }

    return Math.min(score, 1.0)
  }

  _scoreContent(fileInfo, intentExtractor) {
    if (!fileInfo.content) return 0
    const contentLower = fileInfo.content.toLowerCase()
    let score = 0
    const keywords = intentExtractor.getAllKeywords()

    for (const kw of keywords) {
      const kwLower = kw.toLowerCase()
      const regex = new RegExp(`\\b${this._escapeRegex(kwLower)}\\b`, 'gi')
      const matches = contentLower.match(regex)
      if (matches) {
        score += Math.min(matches.length * 0.1, 0.5)
      }
    }

    return Math.min(score, 1.0)
  }

  _scoreIntent(fileInfo, intentExtractor) {
    if (!fileInfo.content) return 0
    const contentLower = fileInfo.content.toLowerCase()
    let score = 0

    for (const intent of intentExtractor.intents) {
      for (const pattern of intent.patterns) {
        if (pattern.test(contentLower)) {
          score += 0.3
          break
        }
      }
    }

    for (const concept of intentExtractor.codeConcepts) {
      if (contentLower.includes(concept)) {
        score += 0.2
      }
    }

    for (const { action, target } of intentExtractor.actionTargets) {
      if (contentLower.includes(target)) {
        score += 0.3
      }
    }

    return Math.min(score, 1.0)
  }

  _scoreRecency(fileInfo) {
    if (!fileInfo.mtime) return 0.5
    const ageMs = Date.now() - fileInfo.mtime.getTime()
    const ageDays = ageMs / (1000 * 60 * 60 * 24)
    if (ageDays < 1) return 1.0
    if (ageDays < 7) return 0.8
    if (ageDays < 30) return 0.5
    if (ageDays < 90) return 0.3
    return 0.1
  }

  _escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
}

module.exports = { RelevanceScorer }
