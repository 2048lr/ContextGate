const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { PassThrough } = require('stream')

const { createMcpServer, runStdioServer, PROTOCOL_VERSION } = require('../lib/mcp/server')
const { ContextWatcher } = require('../lib/scanner/watcher')

// ---------------------------------------------------------------------------
// FIX-03（方案 B）验收：MCP 客户端可以列出文件、搜索并读取上下文；
//                       watch_enabled / debounce_seconds 不再是死旋钮。
// ---------------------------------------------------------------------------

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-test-'))
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'main.js'), 'const MARKER_SYMBOL = 1\nconsole.log(MARKER_SYMBOL)\n')
  fs.writeFileSync(path.join(root, 'README.md'), '# demo\n')
  return root
}

describe('FIX-03 MCP server', () => {
  it('initialize 返回 serverInfo 与回显受支持的协议版本', async () => {
    const server = createMcpServer({ rootDir: process.cwd() })
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION } })
    assert.equal(res.result.serverInfo.name, 'contextgate')
    assert.equal(res.result.protocolVersion, PROTOCOL_VERSION)
    assert.ok(res.result.capabilities.tools)
  })

  it('未知协议版本回退到默认版本', async () => {
    const server = createMcpServer({ rootDir: process.cwd() })
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
    assert.equal(res.result.protocolVersion, PROTOCOL_VERSION)
  })

  it('通知类消息不产生响应', async () => {
    const server = createMcpServer({ rootDir: process.cwd() })
    assert.equal(await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
  })

  it('暴露 build_context / list_files / search 三个工具', async () => {
    const server = createMcpServer({ rootDir: process.cwd() })
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    assert.deepEqual(res.result.tools.map(t => t.name).sort(), ['build_context', 'list_files', 'search'])
  })

  it('未知方法返回 -32601', async () => {
    const server = createMcpServer({ rootDir: process.cwd() })
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 3, method: 'nope/nope' })
    assert.equal(res.error.code, -32601)
  })

  it('list_files 返回逐文件 token 估算', async () => {
    const root = fixture()
    try {
      const server = createMcpServer({ rootDir: root })
      const res = await server.handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_files', arguments: {} } })
      const payload = JSON.parse(res.result.content[0].text)
      assert.ok(payload.total_files >= 2)
      assert.ok(payload.files.every(f => typeof f.estimated_tokens === 'number'))
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('search 能定位到具体文件与行号', async () => {
    const root = fixture()
    try {
      const server = createMcpServer({ rootDir: root })
      const res = await server.handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'search', arguments: { query: 'MARKER_SYMBOL' } } })
      const payload = JSON.parse(res.result.content[0].text)
      assert.ok(payload.matches >= 2)
      assert.equal(payload.results[0].path, 'src/main.js')
      assert.equal(payload.results[0].line, 1)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('build_context 遵守 token 预算且不修改用户仓库', async () => {
    const root = fixture()
    try {
      const before = fs.readdirSync(root).sort()
      const server = createMcpServer({ rootDir: root, contextConfig: { max_tokens: 500 } })
      const res = await server.handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'build_context', arguments: { max_tokens: 500 } } })
      const payload = JSON.parse(res.result.content[0].text.split('\n\n--- context')[0])
      assert.ok(payload.estimated_tokens <= 500)
      assert.ok(res.result.content[0].text.includes('src/main.js'))
      assert.deepEqual(fs.readdirSync(root).sort(), before, '不应向项目目录写入文件')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('工具参数错误以 isError 结果返回，而不是崩溃', async () => {
    const server = createMcpServer({ rootDir: process.cwd() })
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'search', arguments: {} } })
    assert.equal(res.result.isError, true)
    assert.match(res.result.content[0].text, /query/)
  })

  it('stdio 传输按行分隔 JSON-RPC，解析错误返回 -32700', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let out = ''
    output.on('data', c => { out += c })
    const done = runStdioServer({ rootDir: process.cwd() }, { input, output })
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'ping' }) + '\n')
    input.write('{not-json}\n')
    input.end()
    await done
    const messages = out.trim().split('\n').map(l => JSON.parse(l))
    assert.equal(messages.length, 2)
    // JSON-RPC 允许响应乱序，按 id 定位
    const pong = messages.find(m => m.id === 'a')
    assert.ok(pong, '应返回 ping 的响应')
    assert.deepEqual(pong.result, {})
    const parseError = messages.find(m => m.error && m.error.code === -32700)
    assert.ok(parseError, '应返回 -32700 解析错误')
  })
})

describe('FIX-05 文件监视（原先 watch_enabled/debounce_seconds 是死旋钮）', () => {
  it('未配置 workspace 时明确返回未启动', async () => {
    const watcher = new ContextWatcher({ rootDir: null })
    const r = await watcher.start()
    assert.equal(r.started, false)
    assert.match(r.error, /workspace/)
  })

  it('忽略隐藏目录、node_modules 与产物自身', () => {
    const root = path.join(os.tmpdir(), 'cg-watch-root')
    const watcher = new ContextWatcher({ rootDir: root })
    assert.ok(watcher.isIgnored(path.join(root, 'node_modules', 'x', 'index.js')))
    assert.ok(watcher.isIgnored(path.join(root, '.git', 'HEAD')))
    assert.ok(watcher.isIgnored(path.join(root, 'full_context.txt')))
    assert.ok(watcher.isIgnored(path.join(root, 'full_context.txt.manifest.json')))
    assert.ok(!watcher.isIgnored(path.join(root, 'src', 'main.js')))
  })

  it('用假 chokidar 验证防抖与重建回调', async () => {
    const handlers = {}
    const fakeChokidar = {
      watch: () => ({
        on(event, cb) { handlers[event] = cb; return this },
        close: async () => {},
      }),
    }
    const root = path.join(os.tmpdir(), 'cg-watch-root')
    let rebuilds = 0
    const watcher = new ContextWatcher({
      rootDir: root, debounceSeconds: 0.1, chokidar: fakeChokidar,
      onRebuild: () => { rebuilds++ },
    })
    const r = await watcher.start()
    assert.equal(r.started, true)
    assert.equal(r.debounceMs, 100)
    // 连续三次事件应被防抖合并为一次重建
    handlers.all('change', path.join(root, 'src', 'a.js'))
    handlers.all('change', path.join(root, 'src', 'b.js'))
    handlers.all('change', path.join(root, 'src', 'c.js'))
    await new Promise(res => setTimeout(res, 300))
    assert.equal(rebuilds, 1)
    await watcher.stop()
  })
})
