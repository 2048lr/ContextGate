const ModelsDev = require('./models-dev')

const BUILTIN_PROVIDERS = {
  openai: {
    name: 'OpenAI',
    base_url: 'https://api.openai.com/v1',
    env: ['OPENAI_API_KEY', 'OPENAI_KEY'],
    npm: '@ai-sdk/openai'
  },
  anthropic: {
    name: 'Anthropic',
    base_url: 'https://api.anthropic.com/v1',
    env: ['ANTHROPIC_API_KEY'],
    npm: '@ai-sdk/anthropic'
  },
  google: {
    name: 'Google',
    base_url: 'https://generativelanguage.googleapis.com/v1beta',
    env: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY'],
    npm: '@ai-sdk/google'
  },
  deepseek: {
    name: 'DeepSeek',
    base_url: 'https://api.deepseek.com/v1',
    env: ['DEEPSEEK_API_KEY'],
    npm: '@ai-sdk/openai-compatible'
  },
  xai: {
    name: 'xAI',
    base_url: 'https://api.x.ai/v1',
    env: ['XAI_API_KEY'],
    npm: '@ai-sdk/xai'
  },
  mistral: {
    name: 'Mistral',
    base_url: 'https://api.mistral.ai/v1',
    env: ['MISTRAL_API_KEY'],
    npm: '@ai-sdk/mistral'
  },
  groq: {
    name: 'Groq',
    base_url: 'https://api.groq.com/openai/v1',
    env: ['GROQ_API_KEY'],
    npm: '@ai-sdk/groq'
  },
  openrouter: {
    name: 'OpenRouter',
    base_url: 'https://openrouter.ai/api/v1',
    env: ['OPENROUTER_API_KEY'],
    npm: '@openrouter/ai-sdk-provider'
  },
  zhipu: {
    name: 'Zhipu AI',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    env: ['ZHIPU_API_KEY'],
    npm: '@ai-sdk/openai-compatible'
  },
  qwen: {
    name: 'Qwen (Alibaba)',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    env: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
    npm: '@ai-sdk/alibaba'
  },
  perplexity: {
    name: 'Perplexity',
    base_url: 'https://api.perplexity.ai',
    env: ['PERPLEXITY_API_KEY'],
    npm: '@ai-sdk/perplexity'
  },
  togetherai: {
    name: 'Together AI',
    base_url: 'https://api.together.xyz/v1',
    env: ['TOGETHER_AI_API_KEY'],
    npm: '@ai-sdk/togetherai'
  }
}

class ProviderRegistry {
  constructor() {
    this._modelsDev = null
    this._providers = {}
  }

  async init(dataDir) {
    this._modelsDev = await ModelsDev.load(dataDir)
  }

  get modelsDevData() {
    return this._modelsDev || {}
  }

  getAvailableProviders() {
    const result = []
    const modelsDevProviders = Object.keys(this._modelsDev || {})
    const builtinKeys = Object.keys(BUILTIN_PROVIDERS)

    const allKeys = new Set([...builtinKeys, ...modelsDevProviders])
    for (const id of allKeys) {
      const builtin = BUILTIN_PROVIDERS[id]
      const mdProvider = (this._modelsDev || {})[id]
      result.push({
        id,
        name: builtin?.name || mdProvider?.name || id,
        base_url: builtin?.base_url || mdProvider?.api || '',
        env: builtin?.env || mdProvider?.env || [],
        npm: builtin?.npm || mdProvider?.npm || '',
        doc: mdProvider?.doc || '',
        modelCount: mdProvider?.models ? Object.keys(mdProvider.models).length : 0,
        hasBuiltin: !!builtin,
        hasModelsDev: !!mdProvider
      })
    }

    return result.sort((a, b) => {
      if (a.hasBuiltin && !b.hasBuiltin) return -1
      if (!a.hasBuiltin && b.hasBuiltin) return 1
      return a.name.localeCompare(b.name)
    })
  }

  resolveProvider(providerId, userConfig) {
    const builtin = BUILTIN_PROVIDERS[providerId]
    const mdProvider = (this._modelsDev || {})[providerId]

    const base_url = userConfig?.base_url
      || builtin?.base_url
      || mdProvider?.api
      || ''

    const env = builtin?.env || mdProvider?.env || []

    return {
      id: providerId,
      name: builtin?.name || mdProvider?.name || providerId,
      base_url,
      api_key: userConfig?.api_key || '',
      models: userConfig?.models || [],
      timeout: userConfig?.timeout,
      tls: userConfig?.tls,
      passthrough_auth: userConfig?.passthrough_auth || false,
      env,
      npm: builtin?.npm || mdProvider?.npm || '',
      doc: mdProvider?.doc || ''
    }
  }

  getModelsFromModelsDev(providerId) {
    return ModelsDev.listModelsForProvider(providerId, this._modelsDev || {})
  }

  getRecommendedModels(providerId) {
    const models = this.getModelsFromModelsDev(providerId)
    if (models.length === 0) return []
    return models.sort((a, b) => {
      const aScore = (a.cost.input || 0) + (a.cost.output || 0)
      const bScore = (b.cost.input || 0) + (b.cost.output || 0)
      return aScore - bScore
    }).slice(0, 20)
  }

  getModelInfo(providerId, modelId) {
    return ModelsDev.getModel(providerId, modelId, this._modelsDev || {})
  }

  detectProviderFromUrl(url, configManager) {
    if (!url) return configManager.getDefaultProvider() || 'openai'

    const lowerUrl = url.toLowerCase()

    for (const [id, builtin] of Object.entries(BUILTIN_PROVIDERS)) {
      if (builtin.base_url && lowerUrl.includes(new URL(builtin.base_url).host)) {
        return id
      }
    }

    for (const [id, md] of Object.entries(this._modelsDev || {})) {
      if (md.api) {
        try {
          if (lowerUrl.includes(new URL(md.api).host)) return id
        } catch (e) { /* skip invalid URLs */ }
      }
    }

    const allProviders = configManager.getAllProviders()
    for (const [name, config] of Object.entries(allProviders)) {
      if (config.base_url && lowerUrl.includes(config.base_url.toLowerCase())) {
        return name
      }
    }

    return configManager.getDefaultProvider() || 'openai'
  }

  detectProviderFromPath(backendPath, configManager) {
    const lowerPath = backendPath.toLowerCase()

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
      { keywords: ['openai'], provider: 'openai' }
    ]

    for (const mapping of pathMappings) {
      if (mapping.keywords.some(kw => lowerPath.includes(kw))) {
        const allProviders = configManager.getAllProviders()
        if (allProviders[mapping.provider]) return mapping.provider
      }
    }

    const defaultProvider = configManager.getDefaultProvider()
    if (defaultProvider) return defaultProvider

    const allProviders = configManager.getAllProviders()
    const names = Object.keys(allProviders)
    if (names.length === 1) return names[0]

    for (const [name, config] of Object.entries(allProviders)) {
      if (config.base_url && lowerPath.includes(name.toLowerCase())) return name
    }

    return 'openai'
  }

  getBaseUrlForProvider(providerId, userConfig) {
    if (userConfig?.base_url) return userConfig.base_url

    const builtin = BUILTIN_PROVIDERS[providerId]
    if (builtin?.base_url) return builtin.base_url

    const mdProvider = (this._modelsDev || {})[providerId]
    if (mdProvider?.api) return mdProvider.api

    return ''
  }

  enrichProviderWithCost(providerId, modelId) {
    const modelInfo = this.getModelInfo(providerId, modelId)
    if (!modelInfo) return null
    return {
      input_cost_per_million: modelInfo.cost?.input || 0,
      output_cost_per_million: modelInfo.cost?.output || 0,
      cache_read_cost_per_million: modelInfo.cost?.cache_read || 0,
      context_limit: modelInfo.limit?.context || 0,
      output_limit: modelInfo.limit?.output || 0
    }
  }
}

module.exports = { ProviderRegistry, BUILTIN_PROVIDERS }
