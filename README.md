# ContextGate

<p align="center">
  <b>AI Context Management & API Proxy System</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-5.5.0" alt="Version">
  <img src="https://img.shields.io/badge/Electron-28-blue" alt="Electron">
  <img src="https://img.shields.io/badge/platform-Windows-blue" alt="Platform">
  <img src="https://img.shields.io/badge/license-MIT-orange" alt="License">
</p>

<p align="center">
  <a href="#english">English</a> | <a href="#中文">中文</a>
</p>

> **⚠️ Notice:** Linux and macOS platform development has been **paused**. The project currently focuses on **Windows** only. Linux/macOS support may be revisited in the future.

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
| **Multi-Provider** | Supports OpenAI, Zhipu AI, DeepSeek, and custom providers |
| **Modern GUI** | GNOME-style dark theme with system tray integration |
| **Cross-Platform** | Available for Windows (development on Linux/macOS is paused) |

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

> **Code signing is not configured.** Released installers are unsigned, so Windows
> SmartScreen will warn on first run. See [SECURITY.md](SECURITY.md) for how the
> security posture is verified and disclosed.

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
```

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

cache:
  ttl_seconds: 3600              # 0 = never expire

monitor:
  budget_limit: 10.00
  warning_threshold: 75
  critical_threshold: 90
  enforce_budget: false          # true = reject requests (402) once over budget

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

- `config.yaml` — plain text, **including provider API keys**. See
  [SECURITY.md](SECURITY.md) for the known limitation and the plan to move to
  Electron `safeStorage` (DPAPI).
- `contextgate.db` — request metadata only (provider, model, token counts, cost,
  latency, cache flag). **Not** stored: prompts, responses, or API keys.
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
| **Claude Code / Codex CLI** | `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` + `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` = local token |
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
- **MCP server** - 把 `build_context` / `list_files` / `search` 暴露给 Cursor、Claude Code 等 MCP 客户端
- **多提供商支持** - 支持 OpenAI、智谱 AI、DeepSeek 等
- **现代化界面** - GNOME 风格深色主题，系统托盘集成
- **跨平台** - 当前仅支持 Windows（Linux/macOS 开发已暂停）

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

> **未配置文件签名。** 发布产物是未签名的，首次运行会触发 SmartScreen 警告。
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
```

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

- `config.yaml` —— 明文，**包含 provider API Key**。已知限制与后续改造见 [SECURITY.md](SECURITY.md)。
- `contextgate.db` —— 仅请求元数据（provider、模型、token 数、费用、耗时、是否命中缓存）。
  **不保存** prompt、回答或 API Key。
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
| **Claude Code / Codex CLI** | `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` + 对应 API Key 填本地令牌 |
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
