# ContextGate v4.0.7

AI上下文管理工具，帮助开发者在使用AI编程助手时更好地管理代码上下文。

## 组件说明

| 组件 | 文件 | 说明 |
|------|------|------|
| GUI客户端 | ContextGate.Desktop.exe | 图形界面，管理项目和代理服务 |
| CLI工具 | cli/ContextGate.CLI.exe | 命令行工具，支持build/serve/stats/scan命令 |
| 代理服务 | proxy/ContextGate.Proxy.exe | 独立的API代理服务 |

## 快速开始

### 方式一：图形界面
双击 `ContextGate.Desktop.exe` 启动图形界面。

### 方式二：命令行
```bash
# 构建上下文文件
cli.bat build /path/to/project

# 启动代理服务
cli.bat serve /path/to/project

# 查看统计
cli.bat stats

# 扫描项目
cli.bat scan /path/to/project
```

### 方式三：独立代理服务
```bash
proxy.bat
```

## 安装

1. 运行 `install.bat` 可选择将CLI添加到系统PATH
2. 或手动将 `cli` 目录添加到PATH环境变量

## 系统要求

- Windows 10/11 x64
- 无需安装.NET运行时（自包含）

## 配置文件

配置文件位于用户目录：`~/.contextgate/config.yaml`

## 许可证

MIT License
