# ContextGate

<div align="center">

**AI Context Management & Proxy System**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Electron](https://img.shields.io/badge/Electron-28-blue.svg)](https://www.electronjs.org/)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20Windows-orange.svg)](https://github.com/2048lr/ContextGate)
[![Version](https://img.shields.io/badge/version-3.1.0-green.svg)](https://github.com/2048lr/ContextGate/releases)

[English](#english) | [中文](#中文)

</div>

---

## English

### Overview

ContextGate is a powerful AI context management and API proxy system built with Electron. It provides intelligent code scanning, request caching, token monitoring, and cost tracking capabilities with a modern GNOME-style interface.

### Features

- 🔍 **Code Scanner** - Intelligent code scanning with `.gitignore` support
- 🚀 **Express Proxy** - High-performance API proxy with intelligent caching
- 📊 **Token Monitor** - Real-time token usage tracking and cost estimation
- 🔗 **Multi-Backend Support** - OpenAI, Zhipu AI, DeepSeek, and more
- 🖥️ **Modern GUI** - GNOME-style dark theme interface with native window controls
- ⚙️ **Visual Settings** - Graphical configuration with 6 tabs (Providers, Proxy, Monitor, Scanner, Context, Currency)
- 🌐 **Multi-Language** - Auto-detect language based on API provider
- 💰 **Currency Support** - USD, CNY, EUR with auto-detection
- 📦 **System Tray** - Background operation with system tray integration
- 🎨 **Background Image** - Full-screen background with blur effect

### Installation

#### Download from Releases

Download from [GitHub Releases v3.1.0](https://github.com/2048lr/ContextGate/releases/tag/v3.1.0)

##### Debian/Ubuntu (.deb)

```bash
sudo dpkg -i contextgate_3.1.0_amd64.deb
# Or
sudo apt install ./contextgate_3.1.0_amd64.deb
```

##### Fedora/RHEL/CentOS (.rpm)

```bash
sudo dnf install contextgate-3.1.0.x86_64.rpm
# Or
sudo rpm -i contextgate-3.1.0.x86_64.rpm
```

##### AppImage (Universal)

```bash
chmod +x ContextGate-3.1.0-x86_64.AppImage
./ContextGate-3.1.0-x86_64.AppImage
```

##### Windows

Download `ContextGate-Setup-3.1.0.exe` or `ContextGate-3.1.0-Portable.exe` from Releases.

#### From Source

```bash
git clone https://github.com/2048lr/ContextGate.git
cd ContextGate/app/gui-js
npm install
npm start
```

### Usage

```bash
# Launch GUI
contextgate

# CLI mode
node cli.js build /path/to/project
node cli.js serve /path/to/project --port 8000
node cli.js stats
```

### Configuration

Edit `~/.config/contextgate/config.yaml`:

```yaml
providers:
  openai:
    base_url: "https://api.openai.com/v1"
    api_key: "your-api-key"
    models:
      - "gpt-4"
      - "gpt-3.5-turbo"
  
  zhipu:
    base_url: "https://open.bigmodel.cn/api/paas/v4"
    api_key: "your-api-key"
    models:
      - "glm-4"
```

Or use the visual settings dialog: Click ⚙ button in title bar.

### Build from Source

```bash
cd ContextGate/app/gui-js
npm install

# Build for current platform
npm run build

# Build specific format (Linux)
npm run build:deb:x64
npm run build:rpm:x64
npm run build:appimage:x64

# Build Windows (requires Windows or GitHub Actions)
npm run build:win:x64
```

### Build Windows Version without Windows PC

Use GitHub Actions to build Windows packages automatically:

1. Push your code to GitHub
2. Go to **Actions** → **Build and Release** → **Run workflow**
3. Download artifacts from the workflow run

Or create a release tag to trigger automatic build:
```bash
git tag v3.1.0
git push origin v3.1.0
```

### Changelog

#### v3.1.0
- 🔄 **Complete Rewrite** - Migrated from Python/PySide6 to JavaScript/Electron
- 🖥️ **GNOME-style UI** - Native window controls (minimize, maximize, close) in top-right corner
- 🎨 **Chinese Font Support** - Added Noto Sans CJK, WenQuanYi Micro Hei fonts
- 📁 **User Data Directory** - Config saved to `~/.config/contextgate/`
- 🚀 **Performance** - Faster startup, lower memory usage
- 📦 **Multi-Architecture** - Support for x64 and ARM64
- 🌐 **Cross-Platform** - Linux (deb, rpm, AppImage) and Windows (exe, portable)
- 🔧 **GitHub Actions** - Automated CI/CD for all platforms

---

## 中文

### 概述

ContextGate 是一个基于 Electron 构建的 AI 上下文管理和 API 代理系统。提供智能代码扫描、请求缓存、Token 监控和费用追踪功能，采用现代化 GNOME 风格界面。

### 功能特性

- 🔍 **代码扫描器** - 智能代码扫描，支持 `.gitignore` 规则
- 🚀 **Express 代理** - 高性能 API 代理，智能缓存
- 📊 **Token 监控** - 实时 Token 使用量追踪和费用估算
- 🔗 **多后端支持** - OpenAI、智谱 AI、DeepSeek 等
- 🖥️ **现代化 GUI** - GNOME 风格深色主题，原生窗口控制按钮
- ⚙️ **可视化设置** - 图形化配置，6 个选项卡（提供商、代理、监控、扫描器、上下文、货币）
- 🌐 **多语言** - 根据 API 提供商自动检测语言
- 💰 **货币支持** - USD、CNY、EUR 自动检测
- 📦 **系统托盘** - 后台运行，系统托盘集成
- 🎨 **背景图片** - 全屏背景，模糊效果

### 安装

#### 从 Releases 下载

从 [GitHub Releases v3.1.0](https://github.com/2048lr/ContextGate/releases/tag/v3.1.0) 下载

##### Debian/Ubuntu (.deb)

```bash
sudo dpkg -i contextgate_3.1.0_amd64.deb
# 或
sudo apt install ./contextgate_3.1.0_amd64.deb
```

##### Fedora/RHEL/CentOS (.rpm)

```bash
sudo dnf install contextgate-3.1.0.x86_64.rpm
# 或
sudo rpm -i contextgate-3.1.0.x86_64.rpm
```

##### AppImage (通用)

```bash
chmod +x ContextGate-3.1.0-x86_64.AppImage
./ContextGate-3.1.0-x86_64.AppImage
```

##### Windows

从 Releases 下载 `ContextGate-Setup-3.1.0.exe` 或 `ContextGate-3.1.0-Portable.exe`。

#### 源码安装

```bash
git clone https://github.com/2048lr/ContextGate.git
cd ContextGate/app/gui-js
npm install
npm start
```

### 使用方法

```bash
# 启动 GUI
contextgate

# CLI 模式
node cli.js build /path/to/project
node cli.js serve /path/to/project --port 8000
node cli.js stats
```

### 配置

编辑 `~/.config/contextgate/config.yaml`：

```yaml
providers:
  openai:
    base_url: "https://api.openai.com/v1"
    api_key: "your-api-key"
    models:
      - "gpt-4"
      - "gpt-3.5-turbo"
  
  zhipu:
    base_url: "https://open.bigmodel.cn/api/paas/v4"
    api_key: "your-api-key"
    models:
      - "glm-4"
```

或使用可视化设置对话框：点击标题栏 ⚙ 按钮。

### 从源码构建

```bash
cd ContextGate/app/gui-js
npm install

# 构建当前平台
npm run build

# 构建特定格式 (Linux)
npm run build:deb:x64
npm run build:rpm:x64
npm run build:appimage:x64

# 构建 Windows (需要 Windows 环境或 GitHub Actions)
npm run build:win:x64
```

### 无需 Windows 电脑构建 Windows 版本

使用 GitHub Actions 自动构建 Windows 安装包：

1. 将代码推送到 GitHub
2. 进入 **Actions** → **Build and Release** → **Run workflow**
3. 从工作流运行结果中下载构建产物

或创建发布标签触发自动构建：
```bash
git tag v3.1.0
git push origin v3.1.0
```

### 更新日志

#### v3.1.0
- 🔄 **完全重写** - 从 Python/PySide6 迁移到 JavaScript/Electron
- 🖥️ **GNOME 风格界面** - 右上角原生窗口控制按钮（最小化、最大化、关闭）
- 🎨 **中文字体支持** - 添加思源黑体、文泉驿等宽字体
- 📁 **用户数据目录** - 配置保存到 `~/.config/contextgate/`
- 🚀 **性能提升** - 更快启动速度，更低内存占用
- 📦 **多架构支持** - 支持 x64 和 ARM64
- 🌐 **跨平台** - Linux (deb, rpm, AppImage) 和 Windows (exe, portable)
- 🔧 **GitHub Actions** - 自动化 CI/CD 构建所有平台

---

## Bug Report / 问题反馈

- **Email:** liurun637@gmail.com
- **Issues:** [GitHub Issues](https://github.com/2048lr/ContextGate/issues)

---

## License / 许可证

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

本项目采用 MIT 许可证 - 详情请查看 [LICENSE](LICENSE) 文件。

---

<div align="center">

© 2026 JerryLiu

</div>
