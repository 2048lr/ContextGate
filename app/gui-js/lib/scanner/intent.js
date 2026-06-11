const path = require('path')
const { INTENT_PATTERNS } = require('./constants')

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
            patterns: intentConfig.patterns,
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
      function: /函数|方法|def\s|func\s|\bfunction\b|\bmethod\b/gi,
      class: /类|结构体|\bclass\b|\bstruct\b/gi,
      interface: /接口|协议|\binterface\b|\bprotocol\b/gi,
      variable: /变量|常量|\bconst\b|\blet\b|\bvar\b/gi,
      import: /导入|引用|\bimport\b|\brequire\b|\binclude\b/gi,
      error: /错误|异常|\berror|\bexception|\bbug\b/gi,
      test: /测试|单元测试|\btest\b|\bunit\s+test\b/gi
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

module.exports = { IntentExtractor }
