class CodeStructureAnalyzer {
  constructor() {
    this.structureCache = new Map()
  }

  analyze(content, language) {
    const cacheKey = `${language}:${content.length}`
    if (this.structureCache.has(cacheKey)) {
      return this.structureCache.get(cacheKey)
    }

    const result = {
      functions: [],
      classes: [],
      imports: [],
      exports: [],
      complexity: 0
    }

    switch (language) {
      case 'javascript':
      case 'typescript':
        this._analyzeJsTs(content, result)
        break
      case 'python':
        this._analyzePython(content, result)
        break
      case 'go':
        this._analyzeGo(content, result)
        break
      case 'java':
        this._analyzeJava(content, result)
        break
    }

    result.complexity = this._computeComplexity(content)
    this.structureCache.set(cacheKey, result)
    return result
  }

  _analyzeJsTs(content, result) {
    const funcPattern = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g
    const arrowPattern = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>/g
    const classPattern = /(?:export\s+)?class\s+(\w+)/g
    const importPattern = /(?:import\s+.*?\s+from\s+['"]([^'"]+)['"])/g
    const exportPattern = /export\s+(?:default\s+)?(?:function|class|const|let|var)\s+(\w+)/g

    let match
    while ((match = funcPattern.exec(content)) !== null) result.functions.push(match[1])
    while ((match = arrowPattern.exec(content)) !== null) result.functions.push(match[1])
    while ((match = classPattern.exec(content)) !== null) result.classes.push(match[1])
    while ((match = importPattern.exec(content)) !== null) result.imports.push(match[1])
    while ((match = exportPattern.exec(content)) !== null) result.exports.push(match[1])
  }

  _analyzePython(content, result) {
    const funcPattern = /(?:async\s+)?def\s+(\w+)/g
    const classPattern = /class\s+(\w+)/g
    const importPattern = /(?:from\s+(\S+)\s+import|import\s+(\S+))/g

    let match
    while ((match = funcPattern.exec(content)) !== null) result.functions.push(match[1])
    while ((match = classPattern.exec(content)) !== null) result.classes.push(match[1])
    while ((match = importPattern.exec(content)) !== null) result.imports.push(match[1] || match[2])
  }

  _analyzeGo(content, result) {
    const funcPattern = /func\s+(?:\([^)]+\)\s+)?(\w+)/g
    const structPattern = /type\s+(\w+)\s+struct/g
    const importPattern = /"([^"]+)"/g

    let match
    while ((match = funcPattern.exec(content)) !== null) result.functions.push(match[1])
    while ((match = structPattern.exec(content)) !== null) result.classes.push(match[1])
    while ((match = importPattern.exec(content)) !== null) result.imports.push(match[1])
  }

  _analyzeJava(content, result) {
    const classPattern = /(?:public|private|protected)?\s*(?:abstract|final)?\s*class\s+(\w+)/g
    const methodPattern = /(?:public|private|protected)?\s*(?:static|final|abstract)?\s*\w+\s+(\w+)\s*\([^)]*\)/g
    const importPattern = /import\s+([\w.]+)\s*;/g

    let match
    while ((match = classPattern.exec(content)) !== null) result.classes.push(match[1])
    while ((match = methodPattern.exec(content)) !== null) {
      const name = match[1]
      if (!['if', 'for', 'while', 'switch', 'catch'].includes(name)) {
        result.functions.push(name)
      }
    }
    while ((match = importPattern.exec(content)) !== null) result.imports.push(match[1])
  }

  _computeComplexity(content) {
    let complexity = 1
    const patterns = [
      /\bif\b/g, /\belse\s+if\b/g, /\bfor\b/g, /\bwhile\b/g,
      /\bswitch\b/g, /\bcase\b/g, /\bcatch\b/g, /\?\?/g,
      /\?\./g, /&&/g, /\|\|/g, /\btry\b/g
    ]
    for (const pattern of patterns) {
      const matches = content.match(pattern)
      if (matches) complexity += matches.length
    }
    return complexity
  }
}

class TfIdfScorer {
  constructor() {
    this.documentFrequencies = new Map()
    this.totalDocuments = 0
    this.termCache = new Map()
  }

  buildIndex(documents) {
    this.documentFrequencies.clear()
    this.totalDocuments = documents.length
    this.termCache.clear()

    for (const doc of documents) {
      const terms = this._tokenize(doc.content)
      const uniqueTerms = new Set(terms)
      for (const term of uniqueTerms) {
        this.documentFrequencies.set(term, (this.documentFrequencies.get(term) || 0) + 1)
      }
    }
  }

  score(documentContent, queryTerms) {
    const docTerms = this._tokenize(documentContent)
    const docTermFreq = new Map()
    for (const term of docTerms) {
      docTermFreq.set(term, (docTermFreq.get(term) || 0) + 1)
    }

    let score = 0
    const maxFreq = Math.max(...docTermFreq.values(), 1)

    for (const queryTerm of queryTerms) {
      const tf = (docTermFreq.get(queryTerm) || 0) / maxFreq
      const df = this.documentFrequencies.get(queryTerm) || 0
      const idf = Math.log((this.totalDocuments + 1) / (df + 1)) + 1
      score += tf * idf
    }

    return score
  }

  _tokenize(text) {
    if (!text) return []
    const cacheKey = text.substring(0, 200)
    if (this.termCache.has(cacheKey)) return this.termCache.get(cacheKey)

    const tokens = text
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1)

    if (this.termCache.size < 10000) {
      this.termCache.set(cacheKey, tokens)
    }
    return tokens
  }
}

module.exports = { CodeStructureAnalyzer, TfIdfScorer }
