// FIX-17：Prometheus 文本格式指标（零依赖）。
//
// P2-4 的现状是「可观测性为零」：没有 /metrics、没有 OpenTelemetry、没有导出。
// 这里先给出投入产出比最高的一步：把已有的统计（token/成本/缓存/预算/大请求闸门）
// 暴露成 Prometheus 的文本 exposition 格式，任何 Grafana/Prometheus/采集器都能直接抓取。

const METRIC_PREFIX = 'contextgate'
const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'
const BACKSLASH = String.fromCharCode(92)

/** Prometheus 标签值转义：反斜杠、换行、双引号 */
function escapeLabelValue (value) {
  return String(value === undefined || value === null ? '' : value)
    .split(BACKSLASH).join(BACKSLASH + BACKSLASH)
    .split('\n').join(BACKSLASH + 'n')
    .split('"').join(BACKSLASH + '"')
}

function renderLabels (labels) {
  const entries = Object.entries(labels || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (entries.length === 0) return ''
  return '{' + entries.map(([k, v]) => k + '="' + escapeLabelValue(v) + '"').join(',') + '}'
}

function formatNumber (value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '0'
  return String(n)
}

/** 小型指标写入器：每个 metric 只写一次 HELP/TYPE，避免重复导致抓取端告警 */
class MetricWriter {
  constructor () { this.lines = [] }
  metric (name, type, help, samples) {
    const points = (samples || []).filter(s => s && s.value !== undefined && s.value !== null)
    if (points.length === 0) return
    this.lines.push('# HELP ' + name + ' ' + help)
    this.lines.push('# TYPE ' + name + ' ' + type)
    for (const point of points) this.lines.push(name + renderLabels(point.labels) + ' ' + formatNumber(point.value))
  }
  text () { return this.lines.join('\n') + '\n' }
}

/**
 * 生成 Prometheus exposition 文本。
 *
 * @param {{
 *   summary?: object, cache?: object, promptCache?: object, budget?: object,
 *   largeBody?: object, resilience?: object, version?: string,
 *   nodeVersion?: string, platform?: string,
 * }} input
 */
function buildMetrics (input = {}) {
  const summary = input.summary || {}
  const total = summary.total || {}
  const today = summary.today || {}
  const cache = input.cache || {}
  const promptCache = input.promptCache || {}
  const budget = input.budget || {}
  const largeBody = input.largeBody || {}
  const w = new MetricWriter()
  const p = name => METRIC_PREFIX + '_' + name

  w.metric(p('build_info'), 'gauge', 'ContextGate build and runtime information', [
    { labels: { version: input.version, node: input.nodeVersion || process.version, platform: input.platform || process.platform }, value: 1 },
  ])
  w.metric(p('uptime_seconds'), 'gauge', 'Seconds since the ContextGate process started', [
    { value: summary.uptime !== undefined ? summary.uptime : process.uptime() },
  ])

  w.metric(p('requests_total'), 'counter', 'Total number of proxied requests recorded', [
    { value: total.requestCount },
  ])
  w.metric(p('requests_today'), 'gauge', 'Proxied requests recorded today', [{ value: today.requests }])
  w.metric(p('tokens_total'), 'counter', 'Total tokens (input + output) attributed to requests', [
    { value: total.totalTokens },
  ])
  w.metric(p('tokens_today'), 'gauge', 'Tokens recorded today', [{ value: today.tokens }])
  w.metric(p('cost_usd_total'), 'counter', 'Total cost in USD', [{ value: total.totalCost }])
  w.metric(p('cost_usd_today'), 'gauge', 'Cost in USD recorded today', [{ value: today.cost }])
  w.metric(p('saved_usd_total'), 'counter', 'Money saved by response caching and prompt caching', [
    { value: total.totalSaved },
  ])
  w.metric(p('unknown_pricing_requests_total'), 'counter', 'Requests whose model price was unknown', [
    { value: total.unknownPricing },
  ])
  w.metric(p('cache_read_tokens_total'), 'counter', 'Prompt-cache read tokens', [{ value: total.cacheReadTokens }])
  w.metric(p('cache_write_tokens_total'), 'counter', 'Prompt-cache write tokens', [{ value: total.cacheWriteTokens }])

  w.metric(p('provider_requests_total'), 'counter', 'Requests per provider', (summary.byProvider || []).map(row => ({
    labels: { provider: row.provider }, value: row.requests,
  })))
  w.metric(p('provider_tokens_total'), 'counter', 'Tokens per provider', (summary.byProvider || []).map(row => ({
    labels: { provider: row.provider }, value: row.tokens,
  })))
  w.metric(p('provider_cost_usd_total'), 'counter', 'Cost in USD per provider', (summary.byProvider || []).map(row => ({
    labels: { provider: row.provider }, value: row.cost,
  })))

  w.metric(p('cache_hits_total'), 'counter', 'Response-cache hits', [{ value: total.cacheHits }])
  w.metric(p('cache_entries'), 'gauge', 'Entries currently held by the response cache', [
    { value: cache.entries !== undefined ? cache.entries : cache.size },
  ])
  w.metric(p('cache_hit_ratio'), 'gauge', 'Response-cache hit ratio (0..1)', [{ value: cache.hitRate }])
  w.metric(p('cache_memory_bytes'), 'gauge', 'Bytes held by the in-memory response cache', [{ value: cache.memoryBytes }])

  w.metric(p('prompt_cache_requests_total'), 'counter', 'Requests evaluated for prompt caching', [
    { value: promptCache.requests },
  ])
  w.metric(p('prompt_cache_hit_ratio'), 'gauge', 'Share of requests that read from the prompt cache (0..1)', [
    { value: promptCache.hitRate },
  ])
  w.metric(p('prompt_cache_prefix_stable_ratio'), 'gauge', 'Share of requests with a byte-stable cacheable prefix (0..1)', [
    { value: promptCache.prefixStableRate },
  ])
  w.metric(p('prompt_cache_saved_usd_total'), 'counter', 'USD saved by prompt-cache reads', [
    { value: promptCache.savedUSD },
  ])
  w.metric(p('prompt_cache_write_premium_usd_total'), 'counter', 'Extra USD paid for prompt-cache writes', [
    { value: promptCache.writePremiumUSD },
  ])

  // 预算：即使未设置 budget_limit（limit=0）也输出，便于看板区分「未配置」与「未超支」
  if (budget && (budget.limit !== undefined || budget.level !== undefined)) {
    w.metric(p('budget_limit_usd'), 'gauge', 'Configured budget limit in USD (0 = unlimited)', [
      { labels: { level: budget.level }, value: budget.limit },
    ])
    w.metric(p('budget_spent_usd'), 'gauge', 'Spend in the current budget period, in USD', [{ value: budget.spent }])
    w.metric(p('budget_ratio'), 'gauge', 'spent / limit (0 when no limit is configured)', [{ value: budget.ratio }])
    w.metric(p('budget_enforced'), 'gauge', '1 when requests are rejected after exceeding the budget', [
      { value: budget.enforce ? 1 : 0 },
    ])
  }

  w.metric(p('large_body_threshold_bytes'), 'gauge', 'Bodies larger than this bypass the JSON parser and stream to the upstream', [
    { value: largeBody.thresholdBytes },
  ])
  w.metric(p('large_body_active'), 'gauge', 'Large requests currently streaming to an upstream', [{ value: largeBody.active }])
  w.metric(p('large_body_queued'), 'gauge', 'Large requests waiting for a slot', [{ value: largeBody.queued }])
  w.metric(p('large_body_rejected_total'), 'counter', 'Large requests rejected because the gate was busy', [
    { value: largeBody.rejected },
  ])

  return w.text()
}

module.exports = { buildMetrics, escapeLabelValue, renderLabels, MetricWriter, METRIC_PREFIX, PROMETHEUS_CONTENT_TYPE }
