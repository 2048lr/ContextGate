# ContextGate

<div align="center">

**AI Context Management & Proxy System**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python 3.12+](https://img.shields.io/badge/python-3.12+-blue.svg)](https://www.python.org/downloads/)
[![Platform](https://img.shields.io/badge/platform-Linux-orange.svg)](https://www.linux.org/)

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
- 🌐 **Multi-Language** - Auto-detect language based on API provider
- 💰 **Currency Support** - USD, CNY, EUR with auto-detection
- 📦 **System Tray** - Background operation with system tray integration

### Installation

#### From Debian Package (Recommended)

```bash
# Download the latest .deb package
sudo dpkg -i contextgate_3.0.0_amd64.deb

# Or use apt
sudo apt install ./contextgate_3.0.0_amd64.deb
```

#### From Source

```bash
# Clone the repository
git clone https://github.com/2048lr/ContextGate.git
cd ContextGate

# Create virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run
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

### Build from Source

```bash
# Build Debian package
bash build_deb.sh
```

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
- 🌐 **多语言** - 根据 API 提供商自动检测语言
- 💰 **货币支持** - USD、CNY、EUR 自动检测
- 📦 **系统托盘** - 后台运行，系统托盘集成

### 安装

#### Debian 包安装（推荐）

```bash
# 下载最新的 .deb 包
sudo dpkg -i contextgate_3.0.0_amd64.deb

# 或使用 apt
sudo apt install ./contextgate_3.0.0_amd64.deb
```

#### 源码安装

```bash
# 克隆仓库
git clone https://github.com/2048lr/ContextGate.git
cd ContextGate

# 创建虚拟环境
python3 -m venv .venv
source .venv/bin/activate

# 安装依赖
pip install -r requirements.txt

# 运行
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

### 从源码构建

```bash
# 构建 Debian 包
bash build_deb.sh
```

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
