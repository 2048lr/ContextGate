#!/usr/bin/env node

const { program } = require('commander')
const path = require('path')
const fs = require('fs')
const chalk = require('chalk')
const Table = require('cli-table3')
const ora = require('ora')
const { VERSION, DEFAULT_PROXY_PORT } = require('./lib/core/constants')
const { CodeScanner } = require('./lib/scanner/scanner')
const { ProxyServer } = require('./lib/proxy/proxy-server')
const { ConfigManager } = require('./lib/core/config-manager')
const { EventBus } = require('./lib/core/event-bus')
const { showStats, showSavings } = require('./lib/monitor/report')

function formatSize(size) {
  for (const unit of ['B', 'KB', 'MB', 'GB']) { if (size < 1024) return `${size.toFixed(2)} ${unit}`; size /= 1024 }
  return `${size.toFixed(2)} TB`
}

program.name('contextgate').version(VERSION).description('ContextGate - AI Context Management & Proxy System')

program.command('build [path]').description('构建完整上下文文件').option('-o, --output <path>', '输出文件路径').action(async (projectPath, options) => {
  const targetPath = projectPath ? path.resolve(projectPath) : process.cwd()
  console.log(chalk.cyan.bold('\nContextGate Build\n'))
  console.log(`${chalk.green('扫描目录:')} ${targetPath}`)
  const spinner = ora('正在扫描文件...').start()
  const scanner = new CodeScanner(targetPath)
  spinner.succeed(`发现 ${(await scanner.scan()).length} 个文件`)
  const buildSpinner = ora('正在构建上下文...').start()
  const { fileCount, totalChars, estimatedTokens, outputPath } = await scanner.buildContext(options.output)
  buildSpinner.succeed('构建完成')
  const outputSize = fs.statSync(outputPath).size
  const table = new Table({ title: chalk.bold('构建结果'), colWidths: [20, 40] })
  table.push([chalk.green('文件数量:'), fileCount], [chalk.green('总字符数:'), totalChars.toLocaleString()], [chalk.green('预估Token:'), estimatedTokens.toLocaleString()], [chalk.green('输出大小:'), formatSize(outputSize)], [chalk.green('输出路径:'), outputPath])
  console.log(table.toString())
})

program.command('serve [path]').description('启动代理服务器').option('--host <host>', '监听地址', '127.0.0.1').option('--port <port>', '监听端口', v => parseInt(v, 10), DEFAULT_PROXY_PORT).option('-c, --config <path>', '配置文件路径', 'config.yaml').action(async (projectPath, options) => {
  const configManager = new ConfigManager(options.config)
  const targetPath = projectPath ? path.resolve(projectPath) : configManager.getWorkspace() || process.cwd()
  const contextFile = path.join(targetPath, 'full_context.txt')
  console.log(chalk.cyan.bold('\nContextGate Proxy Server'))
  console.log(`${chalk.green('项目路径:')} ${chalk.bold(targetPath)}`)
  const scanner = new CodeScanner(targetPath)
  await scanner.buildContext(contextFile)
  const eventBus = new EventBus()
  eventBus.on('request:log', data => { if (data.type === 'response') console.log(chalk.dim(`[${data.provider}] ${data.model} ${data.tokens?.total || 0} tokens ${data.cached ? '(cached)' : ''}`)) })
  const proxy = new ProxyServer({ contextFile, configPath: options.config, projectRoot: targetPath, eventBus })
  try {
    const result = await proxy.start(options.host, options.port)
    console.log(chalk.green.bold(`\n代理服务器已启动! 端口: ${result.port}`))
    console.log(chalk.dim(`BaseURL: http://${options.host}:${result.port}`))
    console.log(chalk.dim('按 Ctrl+C 停止服务器\n'))
  } catch (e) { console.error(chalk.red(`启动失败: ${e.message}`)); process.exit(1) }
})

program.command('stats').description('显示使用统计').option('--period <period>', '统计周期', 'week').option('--db <path>', '数据库路径', 'contextgate.db').action(async options => {
  await showStats(options.period, options.db)
  console.log()
  await showSavings(options.db)
})

program.command('scan <path>').description('扫描项目代码').option('-o, --output <path>', '输出文件路径').action(async (targetPath, options) => {
  console.log(chalk.cyan(`正在扫描项目: ${targetPath}`))
  const scanner = new CodeScanner(targetPath)
  const files = await scanner.scan()
  console.log(`\n${chalk.green(`扫描完成，找到 ${files.length} 个文件:`)}`)
  for (let i = 0; i < Math.min(files.length, 30); i++) console.log(`  ${i + 1}. ${files[i]}`)
  if (files.length > 30) console.log(`  ... 还有 ${files.length - 30} 个文件`)
  if (options.output) { fs.writeFileSync(options.output, files.join('\n'), 'utf-8'); console.log(`\n${chalk.green(`结果已保存到: ${options.output}`)}`) }
})

program.parse()
