#!/usr/bin/env node

const { program } = require('commander')
const path = require('path')
const fs = require('fs')
const chalk = require('chalk')
const Table = require('cli-table3')
const ora = require('ora')

const { VERSION } = require('./lib/config')
const { CodeScanner } = require('./lib/scanner')
const { AIProxy, ConfigManager } = require('./lib/proxy')
const { showStats, showSavings } = require('./lib/report')
const { TokenMonitor } = require('./lib/monitor')

function formatSize(size) {
  const units = ['B', 'KB', 'MB', 'GB']
  for (const unit of units) {
    if (size < 1024) {
      return `${size.toFixed(2)} ${unit}`
    }
    size /= 1024
  }
  return `${size.toFixed(2)} TB`
}

function checkGoldenStandard(size, tokens) {
  console.log('\n黄金源码包标准检查:')

  const KB = 1024
  const MB = 1024 * KB
  const checks = []

  if (size < 50 * KB) {
    checks.push(['文件大小 < 50KB', true, `${formatSize(size)} ✓`])
  } else if (size < 100 * KB) {
    checks.push(['文件大小 < 100KB', true, `${formatSize(size)} ✓`])
  } else if (size < 500 * KB) {
    checks.push(['文件大小 < 500KB', true, `${formatSize(size)} ✓`])
  } else if (size < 1 * MB) {
    checks.push(['文件大小 < 1MB', true, `${formatSize(size)} ✓`])
  } else {
    checks.push(['文件大小', false, `${formatSize(size)} - 建议精简`])
  }

  if (tokens < 10000) {
    checks.push(['Token数 < 10K', true, `${tokens.toLocaleString()} tokens ✓`])
  } else if (tokens < 50000) {
    checks.push(['Token数 < 50K', true, `${tokens.toLocaleString()} tokens ✓`])
  } else if (tokens < 100000) {
    checks.push(['Token数 < 100K', true, `${tokens.toLocaleString()} tokens ✓`])
  } else if (tokens < 200000) {
    checks.push(['Token数 < 200K', true, `${tokens.toLocaleString()} tokens ⚠️`])
  } else {
    checks.push(['Token数', false, `${tokens.toLocaleString()} tokens - 建议精简`])
  }

  let allPassed = true
  for (const [name, passed, detail] of checks) {
    const status = passed ? chalk.green('✓ PASS') : chalk.red('✗ FAIL')
    console.log(`  [${status}] ${name}: ${detail}`)
    if (!passed) allPassed = false
  }

  if (allPassed) {
    console.log(`\n${chalk.green('结论: 符合黄金源码包标准 ✓')}`)
  } else {
    console.log(`\n${chalk.yellow('结论: 建议进一步精简代码')}`)
  }
}

program
  .name('contextgate')
  .version(VERSION)
  .description('ContextGate - AI Context Management & Proxy System')

program
  .command('build [path]')
  .description('构建完整上下文文件')
  .option('-o, --output <path>', '输出文件路径')
  .option('-c, --config <path>', '配置文件路径', 'config.yaml')
  .action((projectPath, options) => {
    const configManager = new ConfigManager(options.config)

    let targetPath
    if (projectPath) {
      targetPath = path.resolve(projectPath)
    } else {
      const workspace = configManager.getWorkspace()
      if (workspace) {
        targetPath = path.resolve(workspace)
      } else {
        console.log(chalk.yellow('未指定项目路径，使用当前目录'))
        targetPath = process.cwd()
      }
    }

    const outputPath = options.output

    console.log(chalk.cyan.bold('\nContextGate Build\n'))
    console.log(`${chalk.green('扫描目录:')} ${targetPath}`)
    if (outputPath) {
      console.log(`${chalk.green('输出文件:')} ${outputPath}\n`)
    } else {
      console.log(`${chalk.green('输出文件:')} ${path.join(targetPath, 'full_context.txt')}\n`)
    }

    const spinner = ora('正在扫描文件...').start()
    const scanner = new CodeScanner(targetPath)
    const files = scanner.scan()
    spinner.succeed(`发现 ${files.length} 个文件`)

    const buildSpinner = ora('正在构建上下文...').start()
    const { fileCount, totalChars, estimatedTokens, outputPath: actualOutput } = scanner.buildContext(outputPath)
    buildSpinner.succeed('构建完成')

    const outputSize = fs.statSync(actualOutput).size

    console.log()
    const table = new Table({
      title: chalk.bold('构建结果'),
      colWidths: [20, 40]
    })
    table.push(
      [chalk.green('文件数量:'), fileCount],
      [chalk.green('总字符数:'), totalChars.toLocaleString()],
      [chalk.green('预估Token:'), estimatedTokens.toLocaleString()],
      [chalk.green('输出大小:'), formatSize(outputSize)],
      [chalk.green('输出路径:'), actualOutput]
    )
    console.log(table.toString())

    checkGoldenStandard(outputSize, estimatedTokens)
  })

program
  .command('serve [path]')
  .description('启动代理服务器')
  .option('--host <host>', '监听地址', '127.0.0.1')
  .option('--port <port>', '监听端口', parseInt, 12306)
  .option('--base-url <url>', '目标 API Base URL')
  .option('--api-key <key>', 'API Key')
  .option('--context <path>', '上下文文件路径')
  .option('--budget <amount>', '预算上限 (美元)', parseFloat)
  .option('-c, --config <path>', '配置文件路径', 'config.yaml')
  .action(async (projectPath, options) => {
    const configManager = new ConfigManager(options.config)

    let targetPath
    if (projectPath) {
      targetPath = path.resolve(projectPath)
    } else {
      const workspace = configManager.getWorkspace()
      if (workspace) {
        targetPath = path.resolve(workspace)
      } else {
        console.log(chalk.yellow('未指定项目路径，使用当前目录'))
        targetPath = process.cwd()
      }
    }

    let contextFile = options.context
    if (!contextFile) {
      contextFile = path.join(targetPath, 'full_context.txt')
    }

    console.log(chalk.cyan.bold('\nContextGate Proxy Server'))
    console.log(`Version ${VERSION} | ${new Date().toISOString()}`)
    console.log()
    console.log(`${chalk.green('项目路径:')} ${chalk.bold(targetPath)}`)
    console.log(`${chalk.green('上下文文件:')} ${chalk.bold(contextFile)}`)
    console.log(`${chalk.green('配置文件:')} ${chalk.bold(options.config)}`)
    console.log(`${chalk.green('尝试端口:')} ${chalk.bold(options.port)} (若被占用将自动切换)`)
    if (options.budget) {
      console.log(`${chalk.green('预算上限:')} ${chalk.bold('$' + options.budget.toFixed(2))}`)
    }
    console.log()

    const scanner = new CodeScanner(targetPath)
    scanner.buildContext(contextFile)

    const proxy = new AIProxy({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      contextFile,
      configPath: options.config
    })

    try {
      const { port } = await proxy.run(options.host, options.port)
      console.log(chalk.green.bold('\n代理服务器已启动!'))
      console.log(chalk.yellow.bold(`>>> 实际端口: ${port} <<<`))
      console.log(chalk.dim(`Goose BaseURL: http://${options.host}:${port}`))
      console.log(chalk.dim('按 Ctrl+C 停止服务器\n'))
    } catch (err) {
      console.error(chalk.red(`启动失败: ${err.message}`))
      process.exit(1)
    }
  })

program
  .command('stats')
  .description('显示使用统计')
  .option('--period <period>', '统计周期 (week/month/year/all)', 'week')
  .option('--db <path>', '数据库路径', 'contextgate.db')
  .action((options) => {
    showStats(options.period, options.db)
    console.log()
    showSavings(options.db)
  })

program
  .command('scan <path>')
  .description('扫描项目代码')
  .option('-o, --output <path>', '输出文件路径')
  .action((targetPath, options) => {
    console.log(chalk.cyan(`正在扫描项目: ${targetPath}`))

    const scanner = new CodeScanner(targetPath)
    const files = scanner.scan()

    console.log(`\n${chalk.green(`扫描完成，找到 ${files.length} 个文件:`)}`)
    for (let i = 0; i < Math.min(files.length, 30); i++) {
      console.log(`  ${i + 1}. ${files[i]}`)
    }

    if (files.length > 30) {
      console.log(`  ... 还有 ${files.length - 30} 个文件`)
    }

    if (options.output) {
      fs.writeFileSync(options.output, files.join('\n'), 'utf-8')
      console.log(`\n${chalk.green(`结果已保存到: ${options.output}`)}`)
    }
  })

program
  .command('select')
  .description('选择项目目录')
  .option('-c, --config <path>', '配置文件路径', 'config.yaml')
  .action((options) => {
    console.log(chalk.yellow('请使用 GUI 模式选择项目目录'))
    console.log(chalk.dim('运行: npm start'))
  })

program.parse()
