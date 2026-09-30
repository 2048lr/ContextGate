# ContextGate

<p align="center">
  <b>AI Context Management & API Proxy System</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-5.5.0" alt="Version">
  <img src="https://img.shields.io/badge/Electron-44-blue" alt="Electron">
  <img src="https://img.shields.io/badge/platform-Windows-blue" alt="Platform">
  <img src="https://img.shields.io/badge/license-MIT-orange" alt="License">
</p>

<p align="center">
  <a href="#english">English</a> | <a href="#中文">中文</a>
</p>

> **⚠️ Notice:** The desktop GUI is developed **Windows-first**. Linux and macOS
> **build targets are configured again** (AppImage/deb and dmg/zip, see
> [docs/release-and-updates.md](docs/release-and-updates.md)), and the headless gateway
> runs anywhere Node does ([docs/docker.md](docs/docker.md)); the GUI has not been
> re-verified on those platforms yet.

---

## English

### What is ContextGate?

ContextGate is a desktop application that serves as an intelligent API proxy and context manager for AI assistants. It helps you:

- **Manage code context** - Automatically scan your project and build context files for AI tools
- **Proxy API requests** - Intercept and forward requests to AI providers with intelligent caching
- **Monitor usage** - Track token usage, costs, and cache hit rates in real-time
- **Save money** - Reduce API costs through smart caching and context optimization

### Key Features

| Feature | Description |
|---------|-------------|
| **Token-budgeted scanner** | Ranks files by signal and reference count, then trims to `context.max_tokens`; nests `.gitignore`, supports `.contextgateignore`, skips `.env*`/lock files, and flags suspected credentials |
| **API Proxy Server** | High-performance Express proxy with request/response caching, configurable body limit (default 32 MB) and OpenAI-style JSON errors |
| **Local token auth** | Every endpoint requires a locally generated token; `Host` and `Origin` are validated to block DNS rebinding and cross-site access |
| **Accurate metering** | Streams inject `stream_options.include_usage` so token/cost accounting is not zero; pricing comes from the models.dev catalog with a local fallback |
| **Budgets** | `budget_limit` + warning/critical thresholds raise alerts, and optionally reject requests (`enforce_budget`) |
| **MCP server** | Exposes `build_context` / `list_files` / `search` to Cursor, Claude Code and any MCP client |
| **Reliable streaming** | Client disconnects abort the upstream call (no more paying for tokens nobody reads), idle/total timeouts kill half-open connections, and interrupted streams emit an SSE `error` frame instead of a silent truncated 200 |
| **Retry / fallback / circuit breaker** | 429/5xx retried with jittered backoff and `Retry-After`; per-provider fallback chains, circuit breaking and a local concurrency gate. Writes are only replayed when replaying is safe (`Idempotency-Key`, or the upstream said "not handled") |
| **Persistent cache** | Exact-match cache keyed on every output-affecting field, with TTL, disk persistence, LRU/space caps, and *selective* invalidation (a source change no longer nukes the whole table) |
| **Prompt caching** | Injects Anthropic `cache_control` breakpoints, keeps prefixes byte-stable (volatile timestamps are flagged), and reports cache read/write tokens with the money they save |
| **Protocol compatibility** | OpenAI `/v1/chat/completions` + `/v1/responses`, Anthropic-native `/v1/messages`, `/v1/files`, `/v1/batches`, and raw multipart passthrough for audio/images; Google endpoints point at the OpenAI-compatible segment |
| **Encrypted key storage** | API keys live in an Electron `safeStorage` (DPAPI) vault; the renderer only ever sees a mask, and `config.yaml` never contains plaintext |
| **SQLite data layer** | WAL-mode incremental writes with indexes, retention policy, and a redacted request-level log (`GET /requests`) |
| **Prometheus metrics** | Token-protected `GET /metrics` exposes requests, tokens, cost, savings, cache/prompt-cache hit rates, budget state and the large-request gate — no extra dependency |
| **Request export** | Redacted request log at `GET /requests`, exportable as CSV/JSON over HTTP or from **Settings → Monitor**; optional JSONL backend for log shippers ([docs/observability.md](docs/observability.md)) |
| **Large-request streaming** | Bodies above `proxy.large_body.threshold_bytes` bypass the JSON parser and stream straight to the upstream, guarded by a concurrency gate (429 `large_request_busy` when saturated) |
| **Automatic updates** | `electron-updater` with stable/beta channels and delta blockmaps; dev/CLI builds report `unsupported` with an explicit reason instead of failing silently |
| **Headless / Docker** | `node cli.js serve` runs without Electron, and a Dockerfile ships the gateway with a healthcheck ([docs/docker.md](docs/docker.md)) |
| **CI + version guard** | GitHub Actions run lint, unit/integration tests and `npm audit`; `npm run verify:version` keeps package/lock/HTML/README versions identical |
| **Multi-Provider** | Supports OpenAI, Anthropic, Google, Zhipu AI, DeepSeek, and custom providers |
| **Modern GUI** | GNOME-style dark theme with system tray integration |
| **Cross-Platform** | Windows-first GUI; Linux (AppImage/deb) and macOS (dmg/zip) build targets are configured, and the gateway runs headless anywhere |

### Quick Start

#### Installation

Download the latest release from [GitHub Releases](https://github.com/2048lr/ContextGate/releases):

**Windows:** Download and run `ContextGate-Setup-*.exe`

#### From Source

```bash
git clone https://github.com/2048lr/ContextGate.git
cd ContextGate/app/gui-js
npm install
npm start

# Run the test suite (use test:single-process if node --test cannot spawn child processes)
npm test

# Verify the renderer sandbox on your machine (needs a desktop session)
npm run verify:sandbox

# Package a Windows build
npm run build:win
```

> **Code signing is not configured out of the box.** Released installers are unsigned
> unless the build environment provides `CSC_LINK`/`CSC_KEY_PASSWORD` (Windows) or the
> Apple notarization variables, so Windows SmartScreen will warn on first run.
> Packaged builds do ship an update channel (`electron-updater`) — see
> [docs/release-and-updates.md](docs/release-and-updates.md). Security posture and
> disclosure are described in [SECURITY.md](SECURITY.md).

> **Windows builds are 64-bit only.** Electron dropped 32-bit Windows artifacts in
> v44 (it now publishes `win32-x64` and `win32-arm64` only), so `npm run build:win`
> produces x64; use `npm run build:win:arm64` for ARM64. A preflight check
> (`scripts/preflight-build.js`) fails the build with a clear message if a target
> architecture is not published for the pinned Electron version.

### Usage

#### GUI Mode
Launch the application and use the visual interface to:
- Select your project folder
- Configure API providers
- Start the proxy server
- Monitor usage statistics

#### CLI Mode

```bash
# Build context file for a project (honors the token budget by default)
node cli.js build /path/to/project

# Force a smaller budget / XML output / extra ignore patterns
node cli.js build /path/to/project --max-tokens 20000 --format xml --exclude "fixtures/**,*.generated.ts"

# Start proxy server (prints the local token you must give your client)
node cli.js serve /path/to/project --port 12306

# Run as an MCP server over stdio (Cursor / Claude Code / any MCP client)
node cli.js mcp /path/to/project

# View usage statistics
node cli.js stats

# Export the redacted request log as CSV or JSON
node cli.js export --format csv --output requests.csv

# Render Prometheus metrics offline (same text format as GET /metrics)
node cli.js metrics
```

### Observability & exports

- **Prometheus**: `GET /metrics` (token required) exports requests, tokens, cost, savings,
  cache/prompt-cache hit rates, budget state and the large-request gate. Scrape config and the
  full metric list live in [docs/observability.md](docs/observability.md).
- **Request export**: the redacted request log is readable at `GET /requests` and exportable
  as CSV/JSON at `GET /requests/export?format=csv|json`, from **Settings → Monitor**, or with
  `node cli.js export`. Set `monitor.request_log.format: jsonl` to ship it to a log collector.
- **Langfuse / Helicone**: see the integration notes in
  [docs/observability.md](docs/observability.md); ContextGate never uploads anything itself.

### Updates

Packaged builds self-update through GitHub Releases:

- Channel is `updates.channel: stable | beta`; new versions are advertised in
  **Settings → Security → Software updates** and the tray menu.
- Development builds, the CLI and machines without `electron-updater` report
  `unsupported` **with a reason** rather than failing silently.
- Installers are currently **unsigned** unless `CSC_LINK`/`CSC_KEY_PASSWORD` are set at build
  time — see [docs/release-and-updates.md](docs/release-and-updates.md).

### Configuration

Create `~/.config/contextgate/config.yaml`:

```yaml
providers:
  openai:
    base_url: "https://api.openai.com/v1"
    api_key: "sk-your-api-key"
    models: ["gpt-4", "gpt-4o", "gpt-3.5-turbo"]
  
  zhipu:
    base_url: "https://open.bigmodel.cn/api/paas/v4"
    api_key: "your-api-key"
    models: ["glm-4", "glm-4-flash"]

proxy:
  host: "127.0.0.1"
  port: 12306
  max_body_size: "32mb"          # Express defaults to 100kb and returns an HTML 413
  inject_stream_usage: true      # makes streaming requests report real token usage
  auth:
    enabled: true                # keep this on
    host_check: true             # reject non-loopback Host headers
  local_token: ""                # generated on first launch

  # FIX-07: streaming reliability
  stream:
    idle_timeout_ms: 60000       # abort when the upstream goes quiet for this long
    total_timeout_ms: 0          # hard cap per stream (0 = unlimited)

  # FIX-08: retry / fallback / circuit breaker / concurrency
  resilience:
    max_retries: 2
    retry_statuses: [429, 500, 502, 503, 504]
    base_delay_ms: 500
    max_delay_ms: 8000
    jitter: true
    respect_retry_after: true
    retry_non_idempotent: false  # true = also replay failed writes (may double-bill)
    max_concurrency: 32
    max_queue: 64
    queue_timeout_ms: 30000
    fallback: {}                 # e.g. { openai: ["deepseek"] }
    circuit_breaker:
      enabled: true
      failure_threshold: 5
      cooldown_ms: 30000

  # FIX-10: prompt caching
  prompt_cache:
    enabled: true
    anthropic_cache_control: true   # inject cache_control breakpoints for /v1/messages
    openai_prefix_stability: true   # flag volatile prefixes that defeat prefix caching
    min_prefix_tokens: 1024         # OpenAI's minimum cacheable prefix

  # FIX-11: protocol passthrough
  protocols:
    native_passthrough: true     # /v1/messages, /v1/responses, /v1/files, /v1/batches

cache:
  ttl_seconds: 3600              # 0 = never expire
  persist: true                  # keep the cache across restarts
  max_entries: 200
  max_memory_mb: 100
  max_disk_mb: 256
  context_binding: hash          # "off" = a source-file change stops invalidating entries

monitor:
  budget_limit: 10.00
  warning_threshold: 75
  critical_threshold: 90
  enforce_budget: false          # true = reject requests (402) once over budget
  retention_days: 90             # prune request rows, keep daily/monthly aggregates
  request_log:
    enabled: true                # redacted per-request log, readable at GET /requests
    retention_days: 30

context:
  output_file: "full_context.txt"
  format: "markdown"             # markdown | xml
  max_tokens: 8000               # 0 = no trimming (full dump)
  watch_enabled: true            # rebuild automatically when sources change
  debounce_seconds: 1.0
```

### Privacy & data flow

ContextGate is local-first. There is **no telemetry, no analytics and no crash
reporting** — Electron's `crashReporter` is never started.

What leaves your machine, and when:

| Destination | When | What is sent |
|-------------|------|--------------|
| The provider **you** configure (`providers.*.base_url`) | Only while the proxy is running and you send a request through it | Your prompt/messages, plus your API key in the `Authorization` header |
| `models.dev` (`https://models.dev/api.json`) | On startup, at most once per 24h (result cached on disk) | A plain `GET`; no key, no prompt, no project content |
| `github.com` | Only if you click a link that points there | Whatever the browser sends for that link |

Nothing else. In particular: your project files are only read locally when you build
a context artifact, and the artifact is written to your workspace — it is never
uploaded unless you paste it into a client.

What is stored on disk, in `%APPDATA%\ContextGate\`:

- `config.yaml` — settings only. **No plaintext API keys**: keys added in the GUI go
  into the encrypted vault, and existing plaintext keys are migrated out on first
  launch (`api_key_ref: secret` marks them). Keys can also come from the provider's
  standard environment variable (e.g. `OPENAI_API_KEY`), which is the way to feed the
  headless CLI.
- `secrets.json` — the API key vault. Encrypted with Electron `safeStorage`
  (DPAPI on Windows). If `safeStorage` is unavailable the file is explicitly marked
  `"insecure": true` and the in-app security panel says so.
- `contextgate.db` — SQLite (WAL) with request metadata: provider, model, token
  counts (including cache read/write), cost, latency, cache flag. Request *detail*
  rows are pruned after `monitor.retention_days` (default 90); daily/monthly
  aggregates are kept. **Not** stored: prompts, responses, or API keys.
- `cache/` — the persistent response cache (exact-match only, TTL'd, size-capped).
- `models-dev-cache.json` — the price catalog snapshot.

Security posture (sandbox, navigation allowlist, auth, TLS downgrade, telemetry) is
visible in-app under **Settings → Security**, and the disclosure process is described
in [SECURITY.md](SECURITY.md).

### Authentication

The proxy listens on loopback, but loopback is **not** authentication: any local
process (and any web page via DNS rebinding) can reach `127.0.0.1`. ContextGate
therefore generates a local token on first launch and requires it on every
endpoint except `/health`:

```bash
curl http://127.0.0.1:12306/v1/chat/completions \
  -H "Authorization: Bearer <local_token>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

- The token lives in `proxy.local_token` (Settings → Proxy shows, copies and rotates it).
- `X-ContextGate-Token: <local_token>` is accepted as an alternative — use it when the
  client's `Authorization` header must carry the upstream provider key (`passthrough_auth`).
- Requests whose `Host` header is not loopback are rejected with **403**, and
  cross-site `Origin` headers are rejected as well.
- `proxy.auth.enabled: false` restores anonymous access; do not run that way on a
  machine you do not fully trust.

### MCP integration

ContextGate can run as an [MCP](https://modelcontextprotocol.io/) server so AI
tools can pull the context themselves instead of you pasting a file:

```jsonc
// Cursor (~/.cursor/mcp.json) or Claude Code
{
  "mcpServers": {
    "contextgate": {
      "command": "node",
      "args": ["/absolute/path/to/ContextGate/app/gui-js/cli.js", "mcp", "/absolute/path/to/your/project"]
    }
  }
}
```

Exposed tools: `list_files` (per-file token counts), `build_context`
(token-budgeted artifact) and `search` (path + line matches).

### IDE Integration

ContextGate works with popular AI coding tools. Point the tool at the proxy and
use **the local token as the API key**:

| Tool | Configuration |
|------|---------------|
| **Cursor** | Base URL `http://127.0.0.1:12306/v1`, API key = local token |
| **Continue** | `apiBase: http://127.0.0.1:12306/v1`, `apiKey: <local token>` |
| **Cline** | Custom OpenAI-compatible endpoint, API key = local token |
| **Claude Code** | `ANTHROPIC_BASE_URL=http://127.0.0.1:12306` + `ANTHROPIC_API_KEY` = local token (native `/v1/messages` passthrough) |
| **Codex CLI** | `OPENAI_BASE_URL=http://127.0.0.1:12306/v1` + `OPENAI_API_KEY` = local token (`/v1/responses` passthrough) |
| **MCP clients** | `node cli.js mcp <project>` (see above) |

---

## 中文

### 什么是 ContextGate？

ContextGate 是一款桌面应用程序，为 AI 助手提供智能 API 代理和上下文管理功能。

### 核心功能

- **带 Token 预算的扫描器** - 按信号量与被引用次数排序后裁剪到 `context.max_tokens`；支持嵌套 `.gitignore`、`.contextgateignore`，默认排除 `.env*` 与锁文件，并对疑似凭据告警
- **API 代理服务器** - Express 代理 + 请求/响应缓存；请求体上限可配置（默认 32MB），错误统一返回 OpenAI 风格 JSON
- **本地令牌鉴权** - 所有端点都要求本地令牌，并校验 `Host`/`Origin`，阻断 DNS rebinding 与跨站访问
- **可信计量** - 流式请求自动注入 `stream_options.include_usage`，token/费用不再恒为 0；价格以 models.dev 目录为准、本地表兜底
- **预算告警与拦截** - `budget_limit` + 警告/临界阈值，可选 `enforce_budget` 到额即拒
- **流式可靠性** - 客户端断开即中止上游（不再为空转的 token 付费），空闲/总时长超时会掐断半开连接，中断的流会发出 SSE `error` 帧而不是静默截断的 200
- **重试 / 降级 / 熔断 / 限流** - 429/5xx 带 jitter 退避重试并尊重 `Retry-After`；支持 provider 降级链、熔断与本地并发闸门。写请求只有在「可安全重放」（带 `Idempotency-Key`，或上游明确表示未处理）时才会重试
- **持久化缓存** - 缓存 key 覆盖所有影响输出的字段，带 TTL、落盘、LRU/容量上限，并且**选择性失效**（改一个源文件不再清空整张表）
- **Prompt Caching** - 为 Anthropic 注入 `cache_control` 断点，保证前缀字节稳定（时间戳等动态内容会被检出），并统计缓存读/写 token 与其省下的金额
- **协议兼容** - OpenAI `/v1/chat/completions` + `/v1/responses`、Anthropic 原生 `/v1/messages`、`/v1/files`、`/v1/batches`，以及 audio/images 的 multipart 原样透传；Google 端点指向 OpenAI 兼容段
- **密钥加密存储** - API Key 存进 Electron `safeStorage`（Windows 走 DPAPI）加密库，渲染层只能看到掩码，`config.yaml` 里永远没有明文
- **SQLite 数据层** - WAL 模式增量写入 + 索引 + 保留策略，并提供脱敏的请求级日志（`GET /requests`）
- **MCP server** - 把 `build_context` / `list_files` / `search` 暴露给 Cursor、Claude Code 等 MCP 客户端
- **Prometheus 指标** - 受令牌保护的 `GET /metrics` 暴露请求数、token、费用、节省、缓存/Prompt Caching 命中率、预算状态与大请求闸门，无额外依赖
- **请求日志导出** - `GET /requests` 查询、`GET /requests/export` 导出 CSV/JSON，也可在「设置 → 监控」或 `node cli.js export` 导出；可选 JSONL 后端便于采集器接入
- **大请求流式透传** - 超过 `proxy.large_body.threshold_bytes` 的请求体不解析、直接流式转发，并有大请求并发闸门（饱和返回 429 `large_request_busy`）
- **自动更新** - `electron-updater` 支持 stable/beta 通道与差量更新；开发版/CLI 返回带原因的 `unsupported`，不再静默失效
- **无头 / Docker** - `node cli.js serve` 不依赖 Electron，仓库提供带健康检查的 Dockerfile（[docs/docker.md](docs/docker.md)）
- **CI 与版本守护** - GitHub Actions 跑 lint、单测/集成测试与 `npm audit`；`npm run verify:version` 保证 package/lock/HTML/README 版本一致
- **多提供商支持** - 支持 OpenAI、Anthropic、Google、智谱 AI、DeepSeek 等
- **现代化界面** - GNOME 风格深色主题，系统托盘集成
- **跨平台** - 界面以 Windows 为先；Linux（AppImage/deb）与 macOS（dmg/zip）构建目标已恢复配置，无头网关可在任何有 Node 的环境运行

### 快速开始

#### 安装

从 [GitHub Releases](https://github.com/2048lr/ContextGate/releases) 下载最新版本：

**Windows:** 下载并运行 `ContextGate-Setup-*.exe`

#### 从源码安装

```bash
git clone https://github.com/2048lr/ContextGate.git
cd ContextGate/app/gui-js
npm install
npm start

# 运行测试（若 node --test 无法派生子进程，用 test:single-process）
npm test

# 在本机校验渲染进程沙箱（需要桌面会话）
npm run verify:sandbox

# 打包 Windows 产物
npm run build:win
```

> **默认未配置文件签名。** 除非构建环境提供 `CSC_LINK`/`CSC_KEY_PASSWORD`（Windows）或
> Apple 公证变量，发布产物是未签名的，首次运行会触发 SmartScreen 警告。打包版已接入
> `electron-updater` 更新通道，签名与发布流程见 [docs/release-and-updates.md](docs/release-and-updates.md)；
> 安全状态的验证与披露方式见 [SECURITY.md](SECURITY.md)。

> **Windows 产物只提供 64 位。** Electron 从 v44 起不再发布 32 位 Windows 产物
> （只提供 `win32-x64` 与 `win32-arm64`），因此 `npm run build:win` 产出 x64，
> ARM64 请用 `npm run build:win:arm64`。若目标架构对当前固定的 Electron 版本不可用，
> 前置校验 `scripts/preflight-build.js` 会直接以明确信息终止打包。

### 使用方法

#### GUI 模式
启动应用程序，使用图形界面：
- 选择项目文件夹
- 配置 API 提供商
- 启动代理服务器
- 查看使用统计

#### CLI 模式

```bash
# 构建上下文文件（默认按 Token 预算裁剪）
node cli.js build /项目路径

# 指定更小的预算 / XML 输出 / 额外忽略规则
node cli.js build /项目路径 --max-tokens 20000 --format xml --exclude "fixtures/**,*.generated.ts"

# 启动代理服务器（会打印需要填给客户端的本地令牌）
node cli.js serve /项目路径 --port 12306

# 以 MCP stdio server 运行（Cursor / Claude Code 等 MCP 客户端）
node cli.js mcp /项目路径

# 查看使用统计
node cli.js stats

# 导出脱敏请求日志（CSV/JSON）
node cli.js export --format csv --output requests.csv

# 离线渲染 Prometheus 指标（与 GET /metrics 同一文本格式）
node cli.js metrics
```

### 可观测与导出

- **Prometheus**：`GET /metrics`（需令牌）导出请求数、token、费用、节省、缓存/Prompt Caching
  命中率、预算状态与大请求闸门；抓取配置与完整指标表见 [docs/observability.md](docs/observability.md)。
- **请求日志导出**：脱敏请求日志可通过 `GET /requests` 查询、`GET /requests/export?format=csv|json`
  导出，也可在「设置 → 监控」点击，或用 `node cli.js export`；把
  `monitor.request_log.format` 设为 `jsonl` 可直接喂给日志采集器。
- **Langfuse / Helicone**：接入方式见 [docs/observability.md](docs/observability.md)；
  ContextGate 自身不会把任何数据上传到第三方。

### 自动更新

打包版本通过 GitHub Releases 自更新：

- 通道由 `updates.channel: stable | beta` 控制；新版本会在「设置 → 安全 → 软件更新」与托盘菜单提示。
- 开发版、CLI、缺少 `electron-updater` 的环境返回**带原因的** `unsupported`，不会静默失败。
- 未配置签名时安装包仍是未签名的，详见 [docs/release-and-updates.md](docs/release-and-updates.md)。

### 配置

编辑 `~/.config/contextgate/config.yaml`：

```yaml
providers:
  openai:
    base_url: "https://api.openai.com/v1"
    api_key: "sk-your-api-key"
    models: ["gpt-4", "gpt-4o"]
  
  zhipu:
    base_url: "https://open.bigmodel.cn/api/paas/v4"
    api_key: "your-api-key"
    models: ["glm-4"]

proxy:
  max_body_size: "32mb"      # Express 默认 100KB，会让带上下文的请求直接 413
  inject_stream_usage: true  # 让流式请求回传真实 usage
  auth:
    enabled: true            # 建议保持开启
    host_check: true         # 拒绝非回环 Host 头
  local_token: ""            # 首次启动自动生成
  # FIX-07 流式可靠性
  stream:
    idle_timeout_ms: 60000   # 上游静默超过该时长即判定为半开并中止
    total_timeout_ms: 0      # 单条流的总时长上限（0 = 不限）
  # FIX-08 重试 / 降级 / 熔断 / 限流
  resilience:
    max_retries: 2
    retry_statuses: [429, 500, 502, 503, 504]
    base_delay_ms: 500
    max_delay_ms: 8000
    jitter: true
    respect_retry_after: true
    retry_non_idempotent: false  # true = 失败的写请求也重放（可能重复计费）
    max_concurrency: 32
    max_queue: 64
    queue_timeout_ms: 30000
    fallback: {}                 # 例如 { openai: ["deepseek"] }
    circuit_breaker:
      enabled: true
      failure_threshold: 5
      cooldown_ms: 30000
  # FIX-10 Prompt Caching
  prompt_cache:
    enabled: true
    anthropic_cache_control: true   # 为 /v1/messages 注入 cache_control 断点
    openai_prefix_stability: true   # 检出会破坏前缀缓存的动态内容
    min_prefix_tokens: 1024         # OpenAI 的最小可缓存前缀
  # FIX-11 协议透传
  protocols:
    native_passthrough: true     # /v1/messages、/v1/responses、/v1/files、/v1/batches

cache:
  ttl_seconds: 3600          # 0 表示不过期
  persist: true              # 重启后缓存仍可用
  max_entries: 200
  max_memory_mb: 100
  max_disk_mb: 256
  context_binding: hash      # "off" = 源码变化不再让缓存条目失效

monitor:
  retention_days: 90         # 清理请求明细，保留日/月聚合
  request_log:
    enabled: true            # 脱敏请求级日志，可通过 GET /requests 读取
    retention_days: 30

context:
  format: "markdown"         # markdown | xml
  max_tokens: 8000           # 0 表示不裁剪
  watch_enabled: true        # 源码变化后自动重建
```

### 隐私与数据流向

ContextGate 是本地优先的：**没有遥测、没有埋点、没有崩溃上报**（从不启动 Electron 的
`crashReporter`）。

会离开本机的数据只有三条：

| 目的地 | 触发时机 | 发送内容 |
|--------|---------|---------|
| **你自己配置的** provider（`providers.*.base_url`） | 仅在代理运行且你通过它发起请求时 | 你的 prompt/messages，以及 `Authorization` 头里的 API Key |
| `models.dev`（`https://models.dev/api.json`） | 启动时，最多每 24 小时一次（结果落盘缓存） | 普通 GET；不含 Key、prompt 或项目内容 |
| `github.com` | 仅当你点击指向它的链接时 | 浏览器为该链接发送的内容 |

除此之外没有别的。特别说明：项目文件只在你构建上下文时被本地读取，产物写在你自己的工作区，
除非你把它粘贴给客户端，否则不会被上传。

磁盘上保存的内容（`%APPDATA%\ContextGate\`）：

- `config.yaml` —— 只有设置，**不含明文 API Key**：在 GUI 里填的 Key 会进加密库，历史遗留的明文
  Key 也会在首次启动时被迁走（迁移过的 provider 标记 `api_key_ref: secret`）。也可以用
  provider 的标准环境变量（如 `OPENAI_API_KEY`）提供 Key —— 这是无界面的 CLI 的推荐方式。
- `secrets.json` —— API Key 保险库，用 Electron `safeStorage`（Windows 为 DPAPI）加密。
  若运行环境没有可用的 `safeStorage`，文件里会显式写入 `"insecure": true`，应用内安全面板也会标红。
- `contextgate.db` —— SQLite（WAL），保存请求元数据：provider、模型、token 数（含缓存读/写）、
  费用、耗时、是否命中缓存。请求**明细**按 `monitor.retention_days`（默认 90 天）清理，日/月聚合保留。
  **不保存** prompt、回答或 API Key。
- `cache/` —— 持久化响应缓存（仅精确匹配，带 TTL 与容量上限）。
- `models-dev-cache.json` —— 价格目录快照。

安全状态（沙箱、导航白名单、鉴权、TLS 降级、遥测）可在应用内「设置 → 安全」查看，
漏洞披露流程见 [SECURITY.md](SECURITY.md)。

### 鉴权说明

代理监听在回环地址，但**回环不是鉴权**：本机任意进程、以及 DNS rebinding 下的网页都能访问
`127.0.0.1`。因此 ContextGate 首次启动会生成一个本地令牌，除 `/health` 外所有端点都要求携带它：

```bash
curl http://127.0.0.1:12306/v1/chat/completions \
  -H "Authorization: Bearer <本地令牌>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

- 令牌存放在 `proxy.local_token`，可在「设置 → 代理」中查看、复制与重置。
- 也可以使用 `X-ContextGate-Token: <本地令牌>`；当客户端必须用 `Authorization` 传递上游
  Key（`passthrough_auth`）时请使用该头。
- `Host` 头不是回环地址时返回 **403**；跨站 `Origin` 同样被拒绝。
- `proxy.auth.enabled: false` 可恢复匿名访问，但不要在你不完全信任的机器上这样运行。

### MCP 接入

ContextGate 也能以 [MCP](https://modelcontextprotocol.io/) server 形式运行，让 AI 工具自己拉取上下文：

```jsonc
// Cursor (~/.cursor/mcp.json) 或 Claude Code
{
  "mcpServers": {
    "contextgate": {
      "command": "node",
      "args": ["/绝对路径/ContextGate/app/gui-js/cli.js", "mcp", "/绝对路径/你的项目"]
    }
  }
}
```

暴露的工具：`list_files`（逐文件 token 估算）、`build_context`（按预算裁剪的产物）、
`search`（文件 + 行号匹配）。

### IDE 接入

把工具指向代理，并用**本地令牌作为 API Key**：

| 工具 | 配置 |
|------|------|
| **Cursor** | Base URL `http://127.0.0.1:12306/v1`，API Key 填本地令牌 |
| **Continue** | `apiBase: http://127.0.0.1:12306/v1`，`apiKey: <本地令牌>` |
| **Cline** | 自定义 OpenAI 兼容端点，API Key 填本地令牌 |
| **Claude Code** | `ANTHROPIC_BASE_URL=http://127.0.0.1:12306` + `ANTHROPIC_API_KEY` 填本地令牌（原生 `/v1/messages` 透传） |
| **Codex CLI** | `OPENAI_BASE_URL=http://127.0.0.1:12306/v1` + `OPENAI_API_KEY` 填本地令牌（`/v1/responses` 透传） |
| **MCP 客户端** | `node cli.js mcp <项目路径>`（见上） |

---

## Screenshots

<p align="center">
  <i>GUI Interface with GNOME-style design</i>
</p>

## Bug Reports

- **Issues:** [GitHub Issues](https://github.com/2048lr/ContextGate/issues) — if the
  repository shows "Issue creation is restricted", use email instead (the restriction is
  a repository setting the maintainer must lift).
- **Email:** liurun637@gmail.com
- **Security problems:** do **not** open a public issue — follow
  [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 JerryLiu
