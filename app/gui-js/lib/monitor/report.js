const fs = require('fs')
const chalk = require('chalk')
const Table = require('cli-table3')
const { TokenMonitor } = require('./token-monitor')

function formatCost(cost) { return `$${Number(cost || 0).toFixed(4)}` }
function formatTokens(t) { if (!t) return '0'; if (t >= 1000000) return `${(t / 1000000).toFixed(2)}M`; if (t >= 1000) return `${(t / 1000).toFixed(1)}K`; return t.toLocaleString() }
function getPeriodDays(p) { return { week: 7, month: 30, year: 365, all: 999999 }[p] || 7 }

async function showStats(period = 'week', dbPath = 'contextgate.db') {
  if (!fs.existsSync(dbPath)) { console.log(chalk.yellow('No database found.')); return }
  const monitor = new TokenMonitor({ dbPath })
  const summary = await monitor.getSummary()
  const days = getPeriodDays(period)
  const dailyStats = await monitor.getDailyStats(days)

  console.log(chalk.cyan.bold(`\nContextGate Stats (${period})\n`))
  const t = new Table({ head: [chalk.white('Metric'), chalk.white('Value')], colWidths: [25, 25] })
  t.push(
    [chalk.green('Total Requests'), summary.total.requestCount.toLocaleString()],
    [chalk.green('Total Tokens'), formatTokens(summary.total.totalTokens)],
    [chalk.green('Total Cost'), formatCost(summary.total.totalCost)],
    [chalk.green('Cache Hits'), summary.total.cacheHits.toLocaleString()],
    [chalk.green('Today Requests'), summary.today.requests.toLocaleString()],
    [chalk.green('Today Tokens'), formatTokens(summary.today.tokens)],
    [chalk.green('Today Cost'), formatCost(summary.today.cost)],
  )
  console.log(t.toString())

  if (summary.byProvider?.length > 0) {
    console.log(chalk.cyan.bold('\nBy Provider:\n'))
    const pt = new Table({ head: [chalk.white('Provider'), chalk.white('Requests'), chalk.white('Tokens'), chalk.white('Cost')], colWidths: [20, 15, 15, 15] })
    for (const p of summary.byProvider) pt.push([p.provider, p.requests.toLocaleString(), formatTokens(p.tokens), formatCost(p.cost)])
    console.log(pt.toString())
  }

  if (dailyStats?.length > 0) {
    console.log(chalk.cyan.bold(`\nDaily (last ${Math.min(days, dailyStats.length)} days):\n`))
    const dt = new Table({ head: [chalk.white('Date'), chalk.white('Req'), chalk.white('Tokens'), chalk.white('Cost'), chalk.white('Cache')], colWidths: [15, 10, 15, 15, 10] })
    for (const d of dailyStats) dt.push([d.date, d.requests.toLocaleString(), formatTokens(d.tokens), formatCost(d.cost), d.cacheHits.toLocaleString()])
    console.log(dt.toString())
  }
  monitor.close()
}

async function showSavings(dbPath = 'contextgate.db') {
  if (!fs.existsSync(dbPath)) return
  const monitor = new TokenMonitor({ dbPath })
  const s = await monitor.getSummary()
  const hitRate = s.total.requestCount > 0 ? ((s.total.cacheHits / s.total.requestCount) * 100).toFixed(1) : '0.0'
  console.log(chalk.cyan.bold('\nCache Savings:\n'))
  const t = new Table({ head: [chalk.white('Metric'), chalk.white('Value')], colWidths: [25, 25] })
  t.push([chalk.green('Hit Rate'), `${hitRate}%`], [chalk.green('Cache Hits'), s.total.cacheHits.toLocaleString()], [chalk.green('Uptime'), `${Math.floor(s.uptime / 60)} min`])
  console.log(t.toString())
  monitor.close()
}

module.exports = { showStats, showSavings }
