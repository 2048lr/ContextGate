const fs = require('fs')
const chalk = require('chalk')
const Table = require('cli-table3')
const { TokenMonitor } = require('./monitor')

function formatCost(cost) {
  if (cost === null || cost === undefined) return '$0.00'
  return `$${Number(cost).toFixed(4)}`
}

function formatTokens(tokens) {
  if (!tokens) return '0'
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(2)}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`
  return tokens.toLocaleString()
}

function getPeriodDays(period) {
  const map = { week: 7, month: 30, year: 365, all: 999999 }
  return map[period] || 7
}

async function showStats(period = 'week', dbPath = 'contextgate.db') {
  if (!fs.existsSync(dbPath)) {
    console.log(chalk.yellow('数据库文件不存在，暂无统计数据。'))
    console.log(chalk.dim(`路径: ${dbPath}`))
    return
  }

  const monitor = new TokenMonitor({ dbPath })
  const summary = await monitor.getSummary()
  const days = getPeriodDays(period)
  const dailyStats = await monitor.getDailyStats(days)

  console.log(chalk.cyan.bold(`\nContextGate 使用统计 (${period})\n`))

  // Total overview
  const overviewTable = new Table({
    head: [chalk.white('指标'), chalk.white('数值')],
    colWidths: [25, 25]
  })
  overviewTable.push(
    [chalk.green('总请求数'), summary.total.requestCount.toLocaleString()],
    [chalk.green('总 Token 数'), formatTokens(summary.total.totalTokens)],
    [chalk.green('总费用'), formatCost(summary.total.totalCost)],
    [chalk.green('缓存命中'), summary.total.cacheHits.toLocaleString()],
    [chalk.green('内存缓存条目'), summary.total.memoryCacheSize],
    [chalk.green('今日请求数'), summary.today.requests.toLocaleString()],
    [chalk.green('今日 Token 数'), formatTokens(summary.today.tokens)],
    [chalk.green('今日费用'), formatCost(summary.today.cost)],
    [chalk.green('本月请求数'), summary.month.requests.toLocaleString()],
    [chalk.green('本月 Token 数'), formatTokens(summary.month.tokens)],
    [chalk.green('本月费用'), formatCost(summary.month.cost)]
  )
  console.log(overviewTable.toString())

  // Provider breakdown
  if (summary.byProvider && summary.byProvider.length > 0) {
    console.log(chalk.cyan.bold('\n按提供商统计:\n'))
    const providerTable = new Table({
      head: [chalk.white('提供商'), chalk.white('请求数'), chalk.white('Token 数'), chalk.white('费用')],
      colWidths: [20, 15, 15, 15]
    })
    for (const p of summary.byProvider) {
      providerTable.push([
        p.provider,
        p.requests.toLocaleString(),
        formatTokens(p.tokens),
        formatCost(p.cost)
      ])
    }
    console.log(providerTable.toString())
  }

  // Daily breakdown
  if (dailyStats && dailyStats.length > 0) {
    console.log(chalk.cyan.bold(`\n每日统计 (最近 ${Math.min(days, dailyStats.length)} 天):\n`))
    const dailyTable = new Table({
      head: [chalk.white('日期'), chalk.white('请求数'), chalk.white('Token 数'), chalk.white('费用'), chalk.white('缓存命中')],
      colWidths: [15, 12, 15, 15, 12]
    })
    for (const d of dailyStats) {
      dailyTable.push([
        d.date,
        d.requests.toLocaleString(),
        formatTokens(d.tokens),
        formatCost(d.cost),
        d.cacheHits.toLocaleString()
      ])
    }
    console.log(dailyTable.toString())
  }

  monitor.close()
}

async function showSavings(dbPath = 'contextgate.db') {
  if (!fs.existsSync(dbPath)) {
    return
  }

  const monitor = new TokenMonitor({ dbPath })
  const summary = await monitor.getSummary()

  console.log(chalk.cyan.bold('\n缓存节省统计:\n'))

  const totalRequests = summary.total.requestCount
  const cacheHits = summary.total.cacheHits
  const hitRate = totalRequests > 0 ? ((cacheHits / totalRequests) * 100).toFixed(1) : '0.0'
  const totalCost = summary.total.totalCost || 0
  const estimatedSaved = cacheHits > 0 ? (totalCost * (cacheHits / totalRequests)) : 0

  const savingsTable = new Table({
    head: [chalk.white('指标'), chalk.white('数值')],
    colWidths: [25, 25]
  })
  savingsTable.push(
    [chalk.green('缓存命中率'), `${hitRate}%`],
    [chalk.green('缓存命中次数'), cacheHits.toLocaleString()],
    [chalk.green('估算节省费用'), formatCost(estimatedSaved)],
    [chalk.green('运行时间'), `${Math.floor(summary.uptime / 60)} 分钟`]
  )
  console.log(savingsTable.toString())

  monitor.close()
}

module.exports = { showStats, showSavings }
