const ModelsDev = require('./models-dev')

const BUILTIN_PROVIDERS = {
  openai:       { name: 'OpenAI',        base_url: 'https://api.openai.com/v1',                         env: ['OPENAI_API_KEY'],             npm: '@ai-sdk/openai',              format: 'openai' },
  anthropic:    { name: 'Anthropic',     base_url: 'https://api.anthropic.com/v1',                      env: ['ANTHROPIC_API_KEY'],          npm: '@ai-sdk/anthropic',           format: 'openai' },
  google:       { name: 'Google',        base_url: 'https://generativelanguage.googleapis.com/v1beta',  env: ['GOOGLE_GENERATIVE_AI_API_KEY'], npm: '@ai-sdk/google',            format: 'gemini' },
  deepseek:     { name: 'DeepSeek',      base_url: 'https://api.deepseek.com/v1',                      env: ['DEEPSEEK_API_KEY'],           npm: '@ai-sdk/openai-compatible',   format: 'openai' },
  xai:          { name: 'xAI',           base_url: 'https://api.x.ai/v1',                              env: ['XAI_API_KEY'],                npm: '@ai-sdk/xai',                 format: 'openai' },
  mistral:      { name: 'Mistral',       base_url: 'https://api.mistral.ai/v1',                        env: ['MISTRAL_API_KEY'],            npm: '@ai-sdk/mistral',             format: 'openai' },
  groq:         { name: 'Groq',          base_url: 'https://api.groq.com/openai/v1',                   env: ['GROQ_API_KEY'],               npm: '@ai-sdk/groq',                format: 'openai' },
  openrouter:   { name: 'OpenRouter',    base_url: 'https://openrouter.ai/api/v1',                     env: ['OPENROUTER_API_KEY'],         npm: '@openrouter/ai-sdk-provider', format: 'openai' },
  zhipu:        { name: 'Zhipu AI',     base_url: 'https://open.bigmodel.cn/api/paas/v4',             env: ['ZHIPU_API_KEY'],              npm: '@ai-sdk/openai-compatible',   format: 'openai' },
  qwen:         { name: 'Qwen (Alibaba)', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', env: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'], npm: '@ai-sdk/alibaba',   format: 'openai' },
  perplexity:   { name: 'Perplexity',    base_url: 'https://api.perplexity.ai',                        env: ['PERPLEXITY_API_KEY'],         npm: '@ai-sdk/perplexity',          format: 'openai' },
  togetherai:   { name: 'Together AI',   base_url: 'https://api.together.xyz/v1',                      env: ['TOGETHER_AI_API_KEY'],        npm: '@ai-sdk/togetherai',          format: 'openai' },
}

class ProviderRegistry {
  constructor() {
    this._modelsDev = null
  }

  async init(dataDir) {
    this._modelsDev = await ModelsDev.load(dataDir)
  }

  get modelsDevData() { return this._modelsDev || {} }

  resolveProvider(providerId, userConfig = {}) {
    const builtin = BUILTIN_PROVIDERS[providerId]
    const md = (this._modelsDev || {})[providerId]
    const base_url = userConfig.base_url || builtin?.base_url || md?.api || ''
    return {
      id: providerId,
      name: builtin?.name || md?.name || providerId,
      base_url,
      api_key: userConfig.api_key || '',
      models: userConfig.models || [],
      format: userConfig.format || builtin?.format || 'openai',
      timeout: userConfig.timeout,
      tls: userConfig.tls,
      passthrough_auth: userConfig.passthrough_auth || false,
      env: builtin?.env || md?.env || [],
    }
  }

  detectProviderFromPath(backendPath, configManager) {
    const lower = backendPath.toLowerCase()
    const pathMappings = [
      { keywords: ['zhipu', 'bigmodel'], provider: 'zhipu' },
      { keywords: ['deepseek'], provider: 'deepseek' },
      { keywords: ['anthropic', 'claude'], provider: 'anthropic' },
      { keywords: ['google', 'gemini', 'generativelanguage'], provider: 'google' },
      { keywords: ['mistral'], provider: 'mistral' },
      { keywords: ['groq'], provider: 'groq' },
      { keywords: ['xai', 'grok'], provider: 'xai' },
      { keywords: ['openrouter'], provider: 'openrouter' },
      { keywords: ['qwen', 'dashscope', 'alibaba'], provider: 'qwen' },
      { keywords: ['perplexity', 'sonar'], provider: 'perplexity' },
      { keywords: ['together'], provider: 'togetherai' },
      { keywords: ['openai'], provider: 'openai' },
    ]
    for (const m of pathMappings) {
      if (m.keywords.some(kw => lower.includes(kw))) return m.provider
    }
    return configManager.getDefaultProvider() || 'openai'
  }

  getAvailableProviders() {
    const result = []
    const allKeys = new Set([...Object.keys(BUILTIN_PROVIDERS), ...Object.keys(this._modelsDev || {})])
    for (const id of allKeys) {
      const b = BUILTIN_PROVIDERS[id]
      const md = (this._modelsDev || {})[id]
      result.push({
        id,
        name: b?.name || md?.name || id,
        base_url: b?.base_url || md?.api || '',
        format: b?.format || 'openai',
        modelCount: md?.models ? Object.keys(md.models).length : 0,
      })
    }
    return result
  }

  getFormat(providerId) {
    return BUILTIN_PROVIDERS[providerId]?.format || 'openai'
  }

  getModelsFromModelsDev(providerId) {
    const models = (this._modelsDev || {})[providerId]?.models || {}
    return Object.entries(models).map(([id, info]) => ({
      id, name: info.name || id, family: info.family || '',
      cost: info.cost || {}, limit: info.limit || {},
    }))
  }

  enrichProviderWithCost(providerId, modelId) {
    const model = (this._modelsDev || {})[providerId]?.models?.[modelId]
    if (!model) return null
    return {
      input_cost_per_million: model.cost?.input || 0,
      output_cost_per_million: model.cost?.output || 0,
      context_limit: model.limit?.context || 0,
      output_limit: model.limit?.output || 0,
    }
  }
}

module.exports = { ProviderRegistry, BUILTIN_PROVIDERS }
