const MODEL_PRICING = {
  'gpt-4o-mini': { input: 0.15 / 1000000, output: 0.6 / 1000000 },
  'gpt-4o': { input: 2.5 / 1000000, output: 10 / 1000000 },
  'gpt-4-turbo': { input: 10 / 1000000, output: 30 / 1000000 },
  'gpt-4': { input: 30 / 1000000, output: 60 / 1000000 },
  'gpt-3.5-turbo': { input: 0.5 / 1000000, output: 1.5 / 1000000 },
  'o1': { input: 15 / 1000000, output: 60 / 1000000 },
  'o1-mini': { input: 3 / 1000000, output: 12 / 1000000 },
  'o3-mini': { input: 1.1 / 1000000, output: 4.4 / 1000000 },
  'claude-3.5-sonnet': { input: 3 / 1000000, output: 15 / 1000000 },
  'claude-3.5-haiku': { input: 0.8 / 1000000, output: 4 / 1000000 },
  'claude-3-opus': { input: 15 / 1000000, output: 75 / 1000000 },
  'claude-3-haiku': { input: 0.25 / 1000000, output: 1.25 / 1000000 },
  'deepseek-chat': { input: 0.27 / 1000000, output: 1.1 / 1000000 },
  'deepseek-reasoner': { input: 0.55 / 1000000, output: 2.19 / 1000000 },
  'glm-4': { input: 0.1 / 1000000, output: 0.1 / 1000000 },
  'glm-4-flash': { input: 0.01 / 1000000, output: 0.01 / 1000000 },
  'qwen-turbo': { input: 0.3 / 1000000, output: 0.6 / 1000000 },
  'qwen-plus': { input: 0.8 / 1000000, output: 2 / 1000000 },
  'qwen-max': { input: 2.4 / 1000000, output: 9.6 / 1000000 },
  'gemini-1.5-pro': { input: 1.25 / 1000000, output: 5 / 1000000 },
  'gemini-1.5-flash': { input: 0.075 / 1000000, output: 0.3 / 1000000 },
  'gemini-2.0-flash': { input: 0.1 / 1000000, output: 0.4 / 1000000 },
}

function calculateCost(model, inputTokens, outputTokens) {
  if (!model) return 0
  const lower = model.toLowerCase()
  for (const [prefix, pricing] of Object.entries(MODEL_PRICING)) {
    if (lower.startsWith(prefix)) return (inputTokens || 0) * pricing.input + (outputTokens || 0) * pricing.output
  }
  return 0
}

module.exports = { calculateCost, MODEL_PRICING }
