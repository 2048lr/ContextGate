# ContextGate

<p align="center">
  <b>AI Context Management & API Proxy System</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-5.0.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/.NET-8.0-blue" alt=".NET">
  <img src="https://img.shields.io/badge/Electron-28-blue" alt="Electron">
  <img src="https://img.shields.io/badge/platform-Windows-green" alt="Platform">
  <img src="https://img.shields.io/badge/license-MIT-orange" alt="License">
</p>

<p align="center">
  <a href="#english">English</a> | <a href="#中文">中文</a>
</p>

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
| **API Proxy Server** | High-performance proxy with request/response caching |
| **Token Monitor** | Real-time tracking of token usage and cost estimation |
| **Multi-Provider** | Supports OpenAI, Zhipu AI, DeepSeek, and custom providers |
| **Modern GUI** | Avalonia-based dark theme with Fluent design |
| **Cross-Platform** | Windows (native), Linux/macOS (via Electron) |

### Quick Start

#### Installation

Download the latest release from [GitHub Releases](https://github.com/2048lr/ContextGate/releases):

**Windows:** Download and run `ContextGate-5.0.0-win-x64-setup.exe`

The installer includes:
- **ContextGate Desktop** - GUI application
- **ContextGate CLI** - Command-line tool
- **ContextGate Proxy** - Standalone proxy service

#### From Source

**C#/.NET Version (Recommended for Windows):**
```bash
git clone https://github.com/2048lr/ContextGate.git
cd ContextGate/csharp
dotnet build
dotnet run --project ContextGate.Desktop
```

**JavaScript/Electron Version (For Linux/macOS):**
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
contextgate build /path/to/project

# Start proxy server
contextgate serve /path/to/project --port 12306

# View usage statistics
contextgate stats

# Scan project files
contextgate scan /path/to/project
```

### Configuration

Create `~/.contextgate/config.yaml`:

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
- **API 代理服务器** - 高性能代理，智能请求缓存
- **Token 监控** - 实时追踪 token 使用量和费用估算
- **多提供商支持** - 支持 OpenAI、智谱 AI、DeepSeek 等
- **现代化界面** - Avalonia 框架 Fluent 风格深色主题
- **跨平台** - Windows 原生支持，Linux/macOS 通过 Electron

### 快速开始

#### 安装

从 [GitHub Releases](https://github.com/2048lr/ContextGate/releases) 下载最新版本：

**Windows:** 下载并运行 `ContextGate-5.0.0-win-x64-setup.exe`

安装包包含：
- **ContextGate Desktop** - GUI 图形界面
- **ContextGate CLI** - 命令行工具
- **ContextGate Proxy** - 独立代理服务

#### 从源码安装

**C#/.NET 版本 (Windows 推荐):**
```bash
git clone https://github.com/2048lr/ContextGate.git
cd ContextGate/csharp
dotnet build
dotnet run --project ContextGate.Desktop
```

**JavaScript/Electron 版本 (Linux/macOS):**
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
contextgate build /项目路径

# 启动代理服务器
contextgate serve /项目路径 --port 12306

# 查看使用统计
contextgate stats

# 扫描项目文件
contextgate scan /项目路径
```

### 配置

编辑 `~/.contextgate/config.yaml`：

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

## Changelog

### v5.0.0

**重大更新 - C#/.NET 8.0 原生版本发布**

- 🚀 **全新 C#/.NET 8.0 实现** - 高性能原生 Windows 应用
- 📦 **单文件安装包** - 包含 GUI、CLI、Proxy 三大组件
- 🎨 **Avalonia UI** - 现代化 Fluent 设计风格
- ⚡ **性能优化** - 更快的启动速度和更低的内存占用
- 🔧 **完整功能迁移** - 所有 JS 版本功能已完整迁移

**重要公告**

> ⚠️ **Linux/macOS 版本开发暂缓**
>
> 由于资源限制，我们决定暂时放缓 Linux 和 macOS 原生版本的开发。
>
> - **Windows 用户**: 推荐使用新的 C#/.NET 原生版本
> - **Linux/macOS 用户**: 可继续使用 Electron 版本 (app/gui-js)
>
> Electron 版本将继续维护，确保跨平台用户的使用体验。

### v4.0.0

- 完全重写，从 Python/PySide6 迁移到 JavaScript/Electron
- 新增 GNOME 风格用户界面
- 支持多架构 (x64, ARM64)
- 自动化 CI/CD 构建

## Bug Reports

- **Issues:** [GitHub Issues](https://github.com/2048lr/ContextGate/issues)
- **Email:** liurun637@gmail.com

## License

[MIT](LICENSE) © 2026 JerryLiu
