const path = require('path')
const fs = require('fs')
const readline = require('readline')
const { VERSION } = require('../core/constants')
const os = require('os')
const { CodeScanner } = require('../scanner/scanner')

// FIX-03（方案 B）：把「构建上下文」暴露成 MCP 工具，
// 让 Cursor / Claude Code / 任何 MCP 客户端可以直接 list_files / search / build_context，
// 而不是要求用户手工把 full_context.txt 贴进对话。

const PROTOCOL_VERSION = '2024-11-05'
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']
const DEFAULT_MAX_FILES = 500
const DEFAULT_MAX_RESULTS = 50

const TOOL_DEFINITIONS = [
  {
    name: 'list_files',
    description: 'List project files that would be packed into the context, with per-file size and estimated token count.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project root (defaults to the configured workspace).' },
        max_files: { type: 'number', description: 'Maximum number of files to return (default 500).' },
      },
    },
  },
  {
    name: 'build_context',
    description: 'Build the ContextGate context artifact for the project and return it as text, honoring the token budget.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project root (defaults to the configured workspace).' },
        max_tokens: { type: 'number', description: 'Token budget (defaults to context.max_tokens).' },
        format: { type: 'string', enum: ['markdown', 'xml'], description: 'Output format (default markdown).' },
        include_content: { type: 'boolean', description: 'Return the artifact text (default true). Set false to only get the manifest.' },
        output: { type: 'string', description: 'Optional path to also write the artifact to. Defaults to a temporary file so the project is not modified.' },
      },
    },
  },
  {
    name: 'search',
    description: 'Search project files for a string or regular expression, returning matching paths with line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or regular expression to search for.' },
        path: { type: 'string', description: 'Project root (defaults to the configured workspace).' },
        regex: { type: 'boolean', description: 'Treat query as a regular expression (default false = literal substring).' },
        max_results: { type: 'number', description: 'Maximum matching lines to return (default 50).' },
      },
      required: ['query'],
    },
  },
]

function textResult(text) { return { content: [{ type: 'text', text }] } }
function errorResult(text) { return { content: [{ type: 'text', text }], isError: true } }

function resolveRoot(args, defaults) {
  const candidate = args && typeof args.path === 'string' && args.path.trim() ? args.path.trim() : defaults.rootDir
  if (!candidate) throw new Error('No project path configured. Pass "path" or set workspace in ContextGate.')
  const resolved = path.resolve(candidate)
  if (!fs.existsSync(resolved)) throw new Error(`Project path does not exist: ${resolved}`)
  return resolved
}

function createToolHandlers(defaults = {}) {
  const contextConfig = defaults.contextConfig || {}

  async function listFiles(args = {}) {
    const rootDir = resolveRoot(args, defaults)
    const scanner = new CodeScanner(rootDir, contextConfig)
    const entries = await scanner.scanEntries()
    const maxFiles = Number(args.max_files) > 0 ? Number(args.max_files) : DEFAULT_MAX_FILES
    const files = entries
      .map(e => ({ path: e.rel.split(path.sep).join('/'), bytes: e.size, estimated_tokens: Math.ceil(e.size / 4) }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const shown = files.slice(0, maxFiles)
    return textResult(JSON.stringify({
      root: rootDir,
      total_files: files.length,
      returned: shown.length,
      total_bytes: files.reduce((s, f) => s + f.bytes, 0),
      total_estimated_tokens: files.reduce((s, f) => s + f.estimated_tokens, 0),
      files: shown,
    }, null, 2))
  }

  async function buildContext(args = {}) {
    const rootDir = resolveRoot(args, defaults)
    const scanner = new CodeScanner(rootDir, contextConfig)
    const format = args.format === 'xml' ? 'xml' : 'markdown'
    const maxTokens = Number(args.max_tokens) > 0 ? Number(args.max_tokens) : undefined
    // 默认写到临时目录，避免 MCP 调用悄悄修改用户的仓库
    const defaultOutput = path.join(os.tmpdir(), `contextgate-mcp-${process.pid}.txt`)
    const outputPath = typeof args.output === 'string' && args.output.trim() ? path.resolve(args.output.trim()) : defaultOutput
    const result = await scanner.buildContext(outputPath, {
      format,
      maxTokens,
      writeManifest: false,
    })
    const includeContent = args.include_content !== false
    const summary = JSON.stringify({
      root: rootDir,
      format,
      included_files: result.fileCount,
      candidate_files: result.totalFiles,
      estimated_tokens: result.estimatedTokens,
      skipped_files: result.skippedCount,
      secrets: result.secrets,
      included: result.manifest.included.map(i => ({ path: i.path, tokens: i.tokens, truncated: i.truncated })),
    }, null, 2)
    if (!includeContent) return textResult(summary)
    return textResult(`${summary}\n\n--- context (${format}) ---\n${fs.readFileSync(result.outputPath, 'utf8')}`)
  }

  async function search(args = {}) {
    const rootDir = resolveRoot(args, defaults)
    const query = args.query
    if (typeof query !== 'string' || query.length === 0) throw new Error('"query" is required')
    const maxResults = Number(args.max_results) > 0 ? Number(args.max_results) : DEFAULT_MAX_RESULTS
    const scanner = new CodeScanner(rootDir, contextConfig)
    const rels = await scanner.scan()
    let matcher
    if (args.regex) {
      matcher = new RegExp(query, 'i')
    } else {
      const lowered = query.toLowerCase()
      matcher = { test: (line) => line.toLowerCase().includes(lowered) }
    }
    const results = []
    let truncated = false
    for (const rel of rels) {
      if (results.length >= maxResults) { truncated = true; break }
      let content
      try { content = await fs.promises.readFile(path.join(rootDir, rel), 'utf8') } catch { continue }
      if (content.length > 2 * 1024 * 1024) continue
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (matcher.test(lines[i])) {
          results.push({ path: rel.split(path.sep).join('/'), line: i + 1, text: lines[i].slice(0, 400) })
          if (results.length >= maxResults) { truncated = true; break }
        }
      }
    }
    return textResult(JSON.stringify({ root: rootDir, query, regex: !!args.regex, matches: results.length, truncated, results }, null, 2))
  }

  return { list_files: listFiles, build_context: buildContext, search }
}

function createMcpServer(defaults = {}) {
  const handlers = createToolHandlers(defaults)
  const tools = TOOL_DEFINITIONS

  async function callTool(name, args) {
    const handler = handlers[name]
    if (!handler) throw new Error(`Unknown tool: ${name}`)
    return handler(args || {})
  }

  async function handleMessage(message) {
    if (!message || typeof message !== 'object') return null
    const { id, method, params } = message
    const isNotification = id === undefined || id === null
    try {
      switch (method) {
        case 'initialize': {
          const requested = params?.protocolVersion
          return {
            jsonrpc: '2.0', id,
            result: {
              protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'contextgate', version: VERSION },
            },
          }
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
        case 'initialized':
          return null
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} }
        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools } }
        case 'tools/call': {
          const name = params?.name
          const args = params?.arguments || {}
          try {
            const result = await callTool(name, args)
            return { jsonrpc: '2.0', id, result }
          } catch (err) {
            return { jsonrpc: '2.0', id, result: errorResult(err.message) }
          }
        }
        default:
          if (isNotification) return null
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
      }
    } catch (err) {
      if (isNotification) return null
      return { jsonrpc: '2.0', id, error: { code: -32603, message: err.message } }
    }
  }

  return { handleMessage, tools, handlers }
}

function runStdioServer(defaults = {}, streams = {}) {
  const server = createMcpServer(defaults)
  const input = streams.input || process.stdin
  const output = streams.output || process.stdout
  const rl = readline.createInterface({ input, crlfDelay: Infinity })

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let message
    try { message = JSON.parse(trimmed) } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n')
      return
    }
    Promise.resolve(server.handleMessage(message))
      .then(response => { if (response) output.write(JSON.stringify(response) + '\n') })
      .catch(err => {
        console.error('[mcp] handler failure:', err)
        if (message.id !== undefined && message.id !== null) {
          output.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: err.message } }) + '\n')
        }
      })
  })

  return new Promise(resolve => { rl.on('close', () => resolve()) })
}

module.exports = {
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  TOOL_DEFINITIONS,
  createMcpServer,
  createToolHandlers,
  runStdioServer,
  resolveRoot,
}
