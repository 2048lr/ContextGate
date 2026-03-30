# ContextGate

<div align="center">

**AI Context Management & Proxy System**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python 3.12+](https://img.shields.io/badge/python-3.12+-blue.svg)](https://www.python.org/downloads/)
[![Platform](https://img.shields.io/badge/platform-Linux-orange.svg)](https://www.linux.org/)
[![Version](https://img.shields.io/badge/version-3.0.1-green.svg)](https://github.com/2048lr/ContextGate/releases)

[English](#english) | [中文](#中文)

</div>

---

## English

### Overview

ContextGate is a powerful AI context management and API proxy system designed to optimize your AI development workflow. It provides intelligent code scanning, request caching, token monitoring, and cost tracking capabilities.

### Features

- 🔍 **Code Scanner** - Intelligent code scanning with `.gitignore` support
- 🚀 **FastAPI Proxy** - High-performance API proxy with intelligent caching
- 📊 **Token Monitor** - Real-time token usage tracking and cost estimation
- 🔗 **Multi-Backend Support** - OpenAI, Zhipu AI, DeepSeek, and more
- 🖥️ **Native GUI** - Modern dark-themed PySide6 interface
- ⚙️ **Visual Settings** - Graphical configuration dialog with 6 tabs (Providers, Proxy, Monitor, Scanner, Context, Currency)
- 🌐 **Multi-Language** - Auto-detect language based on API provider
- 💰 **Currency Support** - USD, CNY, EUR with auto-detection
- 📦 **System Tray** - Background operation with system tray integration
- 🔧 **Debug/Release Builds** - Support for both debug and optimized release builds

### Installation

#### x86_64 (Recommended)

Download from [GitHub Releases v3.0.1](https://github.com/2048lr/ContextGate/releases/tag/v3.0.1)

##### Debian/Ubuntu (.deb)

```bash
sudo dpkg -i contextgate_3.0.1_amd64.deb
# Or
sudo apt install ./contextgate_3.0.1_amd64.deb
```

##### Fedora/RHEL/CentOS (.rpm)

```bash
sudo dnf install contextgate-3.0.1-2.x86_64.rpm
# Or
sudo rpm -i contextgate-3.0.1-2.x86_64.rpm
```

##### AppImage (Universal)

```bash
chmod +x ContextGate-3.0.1-x86_64.AppImage
./ContextGate-3.0.1-x86_64.AppImage
```

#### ARM64 (Beta)

> ⚠️ **Note**: ARM64 version is in beta testing. Download from [v3.0.1-beta](https://github.com/2048lr/ContextGate/releases/tag/v3.0.1-beta)

##### Debian/Ubuntu (.deb)

```bash
sudo dpkg -i contextgate_3.0.1-beta_arm64.deb
```

##### Fedora/RHEL/CentOS (.rpm)

```bash
sudo dnf install contextgate-3.0.1-1.arm64.rpm
```

#### From Source

```bash
git clone https://github.com/2048lr/ContextGate.git
cd ContextGate
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python main.py gui
```

### Usage

```bash
# Launch GUI
contextgate gui

# Launch with debug mode
contextgate --debug gui

# CLI mode
contextgate scan /path/to/project
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

Or use the visual settings dialog: **Menu → Settings** (菜单 → 打开设置)

### Build from Source

```bash
# Build Debian package
bash build_deb.sh release

# Build AppImage
bash build_appimage.sh

# Build RPM (requires alien)
bash build_rpm.sh
```

### Changelog

#### v3.0.1-beta
- 🖥️ Added ARM64 architecture support (beta)
- 📦 ARM64 packages: deb and rpm formats

#### v3.0.1
- ✨ Added visual settings dialog with 6 configuration tabs
- 🌐 Full Chinese localization for settings interface
- 🔧 Debug/Release build mode support
- 📦 Optimized package size (~60MB)
- 📦 Added AppImage and RPM package formats

#### v3.0.0
- 🎉 Initial release
- 🔍 Code scanner with `.gitignore` support
- 🚀 FastAPI proxy with caching
- 📊 Token monitoring and cost tracking
- 🖥️ PySide6 GUI with dark theme

---

## 中文

### 概述

ContextGate 是一个强大的 AI 上下文管理和 API 代理系统，旨在优化您的 AI 开发工作流程。它提供智能代码扫描、请求缓存、Token 监控和费用追踪功能。

### 功能特性

- 🔍 **代码扫描器** - 智能代码扫描，支持 `.gitignore` 规则
- 🚀 **FastAPI 代理** - 高性能 API 代理，智能缓存
- 📊 **Token 监控** - 实时 Token 使用量追踪和费用估算
- 🔗 **多后端支持** - OpenAI、智谱 AI、DeepSeek 等
- 🖥️ **原生 GUI** - 现代化深色主题 PySide6 界面
- ⚙️ **可视化设置** - 图形化配置对话框，包含 6 个选项卡（提供商、代理、监控、扫描器、上下文、货币）
- 🌐 **多语言** - 根据 API 提供商自动检测语言
- 💰 **货币支持** - USD、CNY、EUR 自动检测
- 📦 **系统托盘** - 后台运行，系统托盘集成
- 🔧 **调试/发布构建** - 支持调试版和优化发布版

### 安装

#### x86_64 架构（推荐）

从 [GitHub Releases v3.0.1](https://github.com/2048lr/ContextGate/releases/tag/v3.0.1) 下载

##### Debian/Ubuntu (.deb)

```bash
sudo dpkg -i contextgate_3.0.1_amd64.deb
# 或
sudo apt install ./contextgate_3.0.1_amd64.deb
```

##### Fedora/RHEL/CentOS (.rpm)

```bash
sudo dnf install contextgate-3.0.1-2.x86_64.rpm
# 或
sudo rpm -i contextgate-3.0.1-2.x86_64.rpm
```

##### AppImage (通用)

```bash
chmod +x ContextGate-3.0.1-x86_64.AppImage
./ContextGate-3.0.1-x86_64.AppImage
```

#### ARM64 架构（测试版）

> ⚠️ **注意**：ARM64 版本为测试版。从 [v3.0.1-beta](https://github.com/2048lr/ContextGate/releases/tag/v3.0.1-beta) 下载

##### Debian/Ubuntu (.deb)

```bash
sudo dpkg -i contextgate_3.0.1-beta_arm64.deb
```

##### Fedora/RHEL/CentOS (.rpm)

```bash
sudo dnf install contextgate-3.0.1-1.arm64.rpm
```

#### 源码安装

```bash
git clone https://github.com/2048lr/ContextGate.git
cd ContextGate
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python main.py gui
```

### 使用方法

```bash
# 启动 GUI
contextgate gui

# 调试模式启动
contextgate --debug gui

# CLI 模式
contextgate scan /path/to/project
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

或使用可视化设置对话框：**菜单 → 打开设置**

### 从源码构建

```bash
# 构建 Debian 包
bash build_deb.sh release

# 构建 AppImage
bash build_appimage.sh

# 构建 RPM (需要 alien)
bash build_rpm.sh
```

### 更新日志

#### v3.0.1-beta
- 🖥️ 新增 ARM64 架构支持（测试版）
- 📦 ARM64 安装包：deb 和 rpm 格式

#### v3.0.1
- ✨ 新增可视化设置对话框，包含 6 个配置选项卡
- 🌐 设置界面完整中文本地化
- 🔧 支持 Debug/Release 构建模式
- 📦 优化安装包体积（约 60MB）
- 📦 新增 AppImage 和 RPM 包格式

#### v3.0.0
- 🎉 初始发布
- 🔍 代码扫描器，支持 `.gitignore`
- 🚀 FastAPI 代理，支持缓存
- 📊 Token 监控和费用追踪
- 🖥️ PySide6 GUI，深色主题

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
