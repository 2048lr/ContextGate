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
    this._extract()
  }

  _extract() {
    this._extractFileReferences()
    this._extractModuleReferences()
    this._extractIntents()
    this._extractCodeConcepts()
    this._extractActionTargets()
    this._extractNegatedTerms()
  }

  _extractFileReferences() {
    const patterns = [
      /["']([^"']+\.(?:js|ts|jsx|tsx|py|go|java|rs|c|cpp|h|vue|svelte))["']/gi,
      /\b(\w+\.(?:js|ts|jsx|tsx|py|go|java|rs|c|cpp|h|vue|svelte))\b/gi,
    ]
    for (const pattern of patterns) {
      let m
      while ((m = pattern.exec(this.prompt)) !== null) {
        const f = m[1].toLowerCase()
        if (f && !this.fileReferences.includes(f) && f.length > 2) this.fileReferences.push(f)
      }
    }
  }

  _extractModuleReferences() {
    const patterns = [/(\w+)[Mm]odule/g, /(\w+)[Ss]ervice/g, /(\w+)[Cc]ontroller/g, /(\w+)[Mm]odel/g, /(\w+)[Hh]andler/g, /(\w+)[Cc]omponent/g]
    for (const p of patterns) {
      let m
      while ((m = p.exec(this.prompt)) !== null) {
        const mod = m[1].toLowerCase()
        if (mod.length > 1 && !this.moduleReferences.includes(mod)) this.moduleReferences.push(mod)
      }
    }
  }

  _extractIntents() {
    for (const [name, cfg] of Object.entries(INTENT_PATTERNS)) {
      for (const p of cfg.patterns) {
        if (p.test(this.prompt)) {
          this.intents.push({ name, keywords: cfg.keywords, patterns: cfg.patterns, filePatterns: cfg.filePatterns, confidence: 1.0 })
          break
        }
      }
    }
  }

  _extractCodeConcepts() {
    const concepts = {
      function: /函数|方法|\bfunction\b|\bmethod\b/gi,
      class: /类|结构体|\bclass\b|\bstruct\b/gi,
      interface: /接口|\binterface\b/gi,
      error: /错误|异常|\berror|\bexception|\bbug\b/gi,
      test: /测试|\btest\b/gi,
    }
    for (const [c, p] of Object.entries(concepts)) {
      if (p.test(this.prompt)) this.codeConcepts.push(c)
    }
  }

  _extractActionTargets() {
    const actions = [
      { action: 'create', pattern: /(?:创建|新增|添加|create|add|new|implement)\s+(\w+)/gi },
      { action: 'modify', pattern: /(?:修改|更新|modify|update|edit|fix)\s+(\w+)/gi },
      { action: 'delete', pattern: /(?:删除|移除|delete|remove)\s+(\w+)/gi },
      { action: 'query',  pattern: /(?:查找|搜索|查询|find|search|query|get)\s+(\w+)/gi },
      { action: 'debug',  pattern: /(?:调试|修复|debug|fix|resolve)\s+(\w+)/gi },
    ]
    for (const { action, pattern } of actions) {
      const re = new RegExp(pattern.source, pattern.flags)
      let m
      while ((m = re.exec(this.prompt)) !== null) {
        const target = (m[1] || '').toLowerCase()
        if (target.length > 1) this.actionTargets.push({ action, target })
      }
    }
  }

  _extractNegatedTerms() {
    const patterns = [
      /(?:不要|别|skip|ignore|exclude|without|don't)\s+(\w+)/gi,
      /(?:不要|别)([\u4e00-\u9fff]+)/gi,
    ]
    for (const p of patterns) {
      const re = new RegExp(p.source, p.flags)
      let m
      while ((m = re.exec(this.prompt)) !== null) {
        const t = (m[1] || '').toLowerCase()
        if (t.length > 1) this.negatedTerms.add(t)
      }
    }
  }

  getAllKeywords() {
    const kw = new Set()
    for (const f of this.fileReferences) kw.add(path.basename(f, path.extname(f)).toLowerCase())
    for (const m of this.moduleReferences) kw.add(m)
    for (const i of this.intents) {
      for (const k of i.keywords) kw.add(k)
      for (const fp of i.filePatterns) kw.add(fp)
    }
    return Array.from(kw)
  }
}

module.exports = { IntentExtractor }
