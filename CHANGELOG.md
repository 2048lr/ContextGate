# Changelog

All notable changes to ContextGate are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).
See [docs/VERSIONING.md](docs/VERSIONING.md) for the versioning policy and
[docs/RELEASE.md](docs/RELEASE.md) for the release procedure.

## [5.3.0] - 2026-06-18

### Added
- 引入规范的版本管理机制：新增 `docs/VERSIONING.md`（版本号命名规则）、`docs/RELEASE.md`（发布流程）、`CHANGELOG.md`（变更日志）。
- 新增 `scripts/version-rollback.js` 版本回滚工具，配合 Git 标签实现可追溯回滚。
- 为本次 bug 修复新增回归测试：`o1-mini` 费用前缀冲突、SSE CRLF 行尾解析、URL 双斜杠拼接等用例。

### Fixed
- **cost-calculator 前缀匹配缺陷（高）**：`calculateCost` 使用按插入序的 `startsWith` 前缀匹配，导致 `o1-mini` 被 `o1` 误匹配，费用算高约 5 倍。改为「精确匹配优先 + 最长前缀匹配降级」。
- **proxy-stopped 事件从未发送（中）**：从主进程侧（托盘菜单、退出流程）停止代理时，渲染进程 UI 状态卡在「运行中」。`stopProxy()` 现在在停止成功后向渲染进程发送 `proxy-stopped` 事件。
- **CSP 阻止 file:// 背景图加载（中）**：`index.html` 的 `img-src` 缺少 `file:`，导致 `file://` 协议的背景图被内容安全策略阻止。`img-src` 现包含 `file: data:`。
- **TokenMonitor 关闭时序竞态（中）**：代理停止后仍有 in-flight 请求触发 `recordRequest`，在 `TokenMonitor` 已关闭时抛出未捕获的 Promise rejection。`recordRequest` 现在在已关闭时静默返回。
- **流式响应 end 回调解析失败时不缓存不统计（中）**：`handleStreamProxy` 的 `end` 回调中 `JSON.parse` 失败会使整个 try 块进入 catch，导致响应不写入缓存、不统计 token。现将 usage 解析、缓存写入、事件统计分离为独立 try/catch，保证即使 usage 解析失败也执行缓存与统计。
- **forwardRequest URL 双斜杠（中）**：`base_url` 带尾斜杠时拼接出 `.../v1//chat/completions`。新增 `joinUrl()` 辅助函数统一处理路径拼接。

### Changed
- `parseSSEChunks` 兼容 CRLF 行尾：每行去除尾部 `\r`，修复 CRLF 格式下事件不分隔导致合并的问题。
- `main.js` 多个 IPC handler（`select-folder`、`window-minimize/maximize/close/show`）增加 `mainWindow` 空指针与销毁状态守卫，避免窗口销毁后调用抛错。

### Removed
- 删除遗留死代码 `scripts/version.js`（已被 `version-sync.js` + `version-bump.js` 取代，无任何引用）。

## [5.2.9] - 2026-06-01

### Changed
- 暂停 Linux 和 macOS 平台开发，专注 Windows 平台。
- 移除 Linux 构建配置及相关脚本文件。

## [5.2.8] - 2026-05-30

### Fixed
- 修复 `proxy` 与 `scanner` 的缓存键、SSE 解析、Python 代码块提取等多个 bug。
- 简化 provider registry 匹配到映射后的返回逻辑。

### Added
- 新增模型目录（models.dev）支持，重构 API 密钥处理与配置管理。

## [5.2.7] - 2026-04-20

### Fixed
- 修复 RPM 和 deb 包依赖项。
- 修复模块重构后的测试失败。
- 为 Chromium 共享内存使用自定义临时目录，修复 Linux 环境崩溃。

## [5.2.6] - 2026-04-10

### Changed
- 迁移 ESLint 配置至 v9 flat config 格式。

## [5.2.5] - 2026-04-05

### Added
- 统一版本管理（version-sync 脚本）、CI/CD 流水线、ESLint、单元测试、代码签名。

## [5.2.4] - 2026-03-28

### Changed
- 重写提供商编辑逻辑，移除 suppress hack。

## [5.2.3] - 2026-03-20

### Added
- TLS 连接池与指数退避重试机制。

## [5.2.2] - 2026-03-15

### Added
- 智能缓存键、流式响应缓存、全方法代理转发。
- 新增 GitLab CI/CD 流水线。

## [5.2.1] - 2026-03-08

### Changed
- 请求日志详细重写。

### Fixed
- 修复新增供应商问题。

## [5.2.0] - 2026-03-01

### Added
- UI 美化、Toast 通知、日志 Pill 标签、模型列表重构、代理路由完善。

## [5.1.0] - 2026-02-20

### Added
- `config-manager` 新增 `getDefaultProvider` 方法。
- 前端界面与代理接口大幅重构，新增模型自动获取功能。

## [4.0.7] - 2026-02-10

### Fixed
- 修复 deb 包在 Linux 桌面环境下无法启动窗口的问题。

## [4.0.6] - 2026-02-05

### Fixed
- 修复 Windows ia32 构建问题，启用 Developer Mode。
- 改进代码扫描器的正则表达式匹配。
- 优化错误处理机制。

## [4.0.5] - 2026-01-28

### Changed
- 升级 electron-builder 25 + actions v5 + Node24 兼容。
- 修复版本号为合法 semver 格式。

### Fixed
- 修复 13 个 bug。
- 修复图形化界面无法加载的问题。
- 修复 Electron 在某些 Linux 环境下的崩溃问题。

## [4.0.0] - 2026-01-15

### Changed
- 完全重写，从 Python/PySide6 迁移到 JavaScript/Electron。
- 新增 GNOME 风格用户界面。

### Added
- 支持多架构 (x64, ARM64)。
- 自动化 CI/CD 构建。

[5.3.0]: https://github.com/2048lr/ContextGate/releases/tag/v5.3.0
[5.2.9]: https://github.com/2048lr/ContextGate/releases/tag/v5.2.9
[5.2.8]: https://github.com/2048lr/ContextGate/releases/tag/v5.2.8
[5.2.7]: https://github.com/2048lr/ContextGate/releases/tag/v5.2.7
[5.2.6]: https://github.com/2048lr/ContextGate/releases/tag/v5.2.6
[5.2.5]: https://github.com/2048lr/ContextGate/releases/tag/v5.2.5
[5.2.4]: https://github.com/2048lr/ContextGate/releases/tag/v5.2.4
[5.2.3]: https://github.com/2048lr/ContextGate/releases/tag/v5.2.3
[5.2.2]: https://github.com/2048lr/ContextGate/releases/tag/v5.2.2
[5.2.1]: https://github.com/2048lr/ContextGate/releases/tag/v5.2.1
[5.2.0]: https://github.com/2048lr/ContextGate/releases/tag/v5.2.0
[5.1.0]: https://github.com/2048lr/ContextGate/releases/tag/v5.1.0
[4.0.7]: https://github.com/2048lr/ContextGate/releases/tag/v4.0.7
[4.0.6]: https://github.com/2048lr/ContextGate/releases/tag/v4.0.6
[4.0.5]: https://github.com/2048lr/ContextGate/releases/tag/v4.0.5
[4.0.0]: https://github.com/2048lr/ContextGate/releases/tag/v4.0.0
