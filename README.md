# ContextGate

<p align="center">
  <b>AI Context Management & API Proxy System</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-5.3.0-blue" alt="Version">
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
| **Smart Code Scanner** | Scans your project, respects `.gitignore`, extracts relevant code blocks |
| **API Proxy Server** | High-performance Express proxy with request/response caching |
| **Token Monitor** | Real-time tracking of token usage and cost estimation |
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
```

### Usage

#### GUI Mode
Launch the application and use the visual interface to:
- Select your project folder
- Configure API providers
- Start the proxy server
- Monitor usage statistics

#### CLI Mode

```bash
# Build context file for a project
node cli.js build /path/to/project

# Start proxy server
node cli.js serve /path/to/project --port 12306

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

monitor:
  budget_limit: 10.00
```

### IDE Integration

ContextGate works with popular AI coding tools:

| Tool | Configuration |
|------|---------------|
| **Cursor** | Set API base URL to `http://127.0.0.1:12306` |
| **Continue** | Configure proxy endpoint in settings |
| **Cline** | Use custom API endpoint |

---

## 中文

### 什么是 ContextGate？

ContextGate 是一款桌面应用程序，为 AI 助手提供智能 API 代理和上下文管理功能。

### 核心功能

- **智能代码扫描** - 自动扫描项目，支持 `.gitignore` 规则
- **API 代理服务器** - 高性能 Express 代理，智能请求缓存
- **Token 监控** - 实时追踪 token 使用量和费用估算
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
```

### 使用方法

#### GUI 模式
启动应用程序，使用图形界面：
- 选择项目文件夹
- 配置 API 提供商
- 启动代理服务器
- 查看使用统计

#### CLI 模式

```bash
# 构建上下文文件
node cli.js build /项目路径

# 启动代理服务器
node cli.js serve /项目路径 --port 12306

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
```

---

## Screenshots

<p align="center">
  <i>GUI Interface with GNOME-style design</i>
</p>

## Changelog

### v5.3.0
- **Bug 修复（高严重度）**:
  - 修复 `stopProxy` 不 await `proxyServer.stop()` 导致端口占用和数据库写入丢失
  - 修复 `invalidateIfNeeded` mtime 快速路径遗漏源文件变化（回归问题）
  - 修复流式请求路由到错误端点（`handleStreamProxy` 硬编码 URL）
  - 修复 `IntentExtractor` 正则 `lastIndex` 污染导致概念提取失败
  - 修复 `get-stats` TokenMonitor 资源泄漏
  - 修复缓存键遗漏请求参数（temperature/max_tokens 等）
  - 修复 `resolveApiKey` `passthrough_auth` 逻辑无效
  - 修复 `TokenMonitor` close/getSummary 竞态条件导致崩溃
  - 修复 `proxy-server.stop()` Promise 永久挂起
- **Bug 修复（中严重度）**:
  - 修复流式响应 UI 不显示最终 tokens 和 cost
  - 修复 `/proxy/chat` 缓存键不包含 provider 导致跨 provider 缓存污染
  - 修复 `/v1/models` 不处理 `X-Target-Base-Url` header
  - 修复 `version-sync.js` 遗漏 `package-lock.json` 的 `packages[""].version`
  - 修复 `clearCache` 硬编码 `127.0.0.1`
  - 修复 `fetchModels` CORS 跨域问题
  - 修复 `todaySavings` 硬编码费率
  - 修复 `models-dev.js` 缓存路径混淆
  - 修复 `ALLOWED_V1_PATHS` 不处理尾部斜杠
  - 修复 `computeContextSignature` 不处理文件删除场景
  - 修复 `IntentExtractor` 错误概念提取不支持复数形式
- **Bug 修复（低严重度）**:
  - 修复 `addLogEntry` XSS 漏洞（用户输入未转义）
  - 修复 `/proxy/chat` 路由不记录日志和 cost
  - 修复 `addLogEntry` cost 回退使用硬编码费率
  - 修复 `TokenMonitor` close 静默吞错
- **新功能**:
  - 引入版本管理机制（SemVer 规范、版本同步工具、发布流程、回滚机制）
  - 新增 `version-bump.js` 版本递增工具
  - 新增 `release.js` 发布流程自动化工具

### v5.2.9
- 暂停 Linux 和 macOS 平台开发，专注 Windows 平台
- 移除 Linux 构建配置及相关脚本文件

### v4.0.6-beta
- 修复 Electron 在某些 Linux 环境下的崩溃问题
- 改进代码扫描器的正则表达式匹配
- 优化错误处理机制

### v4.0.0
- 完全重写，从 Python/PySide6 迁移到 JavaScript/Electron
- 新增 GNOME 风格用户界面
- 支持多架构 (x64, ARM64)
- 自动化 CI/CD 构建

## Version Management

### Version Naming Convention

ContextGate follows [Semantic Versioning](https://semver.org/) (SemVer):

```
MAJOR.MINOR.PATCH  (e.g. 5.3.0)
```

| Component | When to bump | Example |
|-----------|-------------|---------|
| **MAJOR** | Incompatible API changes | 5.3.0 → 6.0.0 |
| **MINOR** | New features, backward-compatible | 5.2.9 → 5.3.0 |
| **PATCH** | Bug fixes, backward-compatible | 5.2.9 → 5.2.10 |

### Version Sync

Version numbers are tracked across 4 files, kept in sync by `scripts/version-sync.js`:

| File | Location |
|------|----------|
| `package.json` | `app/gui-js/package.json` → `version` field |
| `package-lock.json` | `app/gui-js/package-lock.json` → `version` + `packages[""].version` |
| `index.html` | `app/gui-js/index.html` → `<meta name="version">` tag |
| `README.md` | `README.md` → version badge |

```bash
# Check version consistency
npm run version:check

# Sync versions after manual edit
npm run version:sync -- <version>

# Get current version
npm run version:current
```

### Release Process

```bash
# 1. Bump version (patch/minor/major)
npm run version:patch    # 5.2.9 → 5.2.10
npm run version:minor    # 5.2.9 → 5.3.0
npm run version:major    # 5.2.9 → 6.0.0

# 2. Update CHANGELOG in README.md

# 3. Run tests
cd app/gui-js && npm test

# 4. Commit and tag
git add -A
git commit -m "release: v5.3.0"
git tag -a v5.3.0 -m "Release v5.3.0"

# 5. Build
npm run build:win

# 6. Push
git push && git push --tags

# Or use the automated release script (steps 1-4):
node scripts/release.js --patch
```

### Rollback Mechanism

If a release has issues, rollback via Git:

```bash
# Rollback to previous version
git tag -d v5.3.0                    # Delete the bad tag
git reset --hard v5.2.9              # Reset to last good version
git push origin :refs/tags/v5.3.0    # Delete remote tag

# Rebuild and redeploy
cd app/gui-js && npm run build:win
```

## Bug Reports

- **Issues:** [GitHub Issues](https://github.com/2048lr/ContextGate/issues)
- **Email:** liurun637@gmail.com

## License

[MIT](LICENSE) © 2026 JerryLiu
