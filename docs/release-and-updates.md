# 分发、签名与自动更新（FIX-16）

P2 的目标是让「下载安装」这件事变得可信、可更新、可验证。本文说明当前的实现与仍需人工完成的步骤。

## 版本一致性

发布脱节的根因是版本号散落在多个文件里，且没有任何校验。现在：

```bash
cd app/gui-js
npm run verify:version
```

会比对 `package.json`、`package-lock.json`、`index.html` 的 `<meta name="version">` 与
`README.md` 的版本徽章，任何一个不一致就以非零码退出（CI 中作为必经步骤）。
`dist/` 里残留的历史产物会以警告形式列出，但不会导致构建失败。

## 构建与发布

```bash
npm run build:win       # Windows x64（nsis + portable）
npm run build:win:arm64 # Windows ARM64
npm run build:linux     # Linux x64/arm64（AppImage + deb）
npm run build:mac       # macOS x64/arm64（dmg + zip）
npm run report:size     # 体积报告：产物、app.asar、最大的若干文件
```

`.github/workflows/release.yml` 会在推送 `v*` 标签时于三个平台并行构建并发布到 GitHub Releases；
`.github/workflows/ci.yml` 负责 lint、单测/集成测试、版本校验与依赖审计。

## 代码签名

electron-builder 会自动读取以下环境变量；**不配置时仍然产出未签名安装包**（用户会看到 SmartScreen 警告）。

| 平台 | 变量 | 说明 |
|------|------|------|
| Windows | `CSC_LINK` | 证书文件路径或 base64（`.pfx`） |
| Windows | `CSC_KEY_PASSWORD` | 证书密码 |
| macOS | `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | 公证所需 |

CI 已把这些变量接到 GitHub Secrets。要消除 SmartScreen 红警告，除了签名还需要积累下载声誉
（EV 证书可立即获得声誉，OV 证书需要时间）。

验证签名（Windows）：

```powershell
Get-AuthenticodeSignature 'dist\win-unpacked\ContextGate.exe'
```

## 自动更新

- 运行时依赖：`electron-updater`；只有 `app.isPackaged === true` 且 `updates.enabled !== false` 时才加载。
- 通道：`updates.channel: stable | beta`。`stable` 只接受正式版，`beta` 同时接受预发布版。
- 默认行为：启动后 15s 检查一次，之后按 `check_interval_hours` 周期检查；发现新版只提示，用户点击下载。
- 开发环境、CLI、缺少依赖或配置关闭时，状态机返回 `unsupported` 并附带明确原因，UI 会原样显示，
  不会静默失败。
- electron-builder 通过 `build.publish` 生成 `latest.yml` / `beta.yml` 与 `.blockmap`，
  `generateUpdatesFilesForAllChannels: true` 保证两个通道都有元数据；`nsis.differentialPackage: true`
  启用差量更新。

GUI：**设置 → 安全 → 软件更新** 提供「检查更新 / 下载更新 / 重启并安装」，托盘菜单也有对应入口。

## 体积优化

- `build.files` 排除 `test/`、`docs/`、`dist/`、`.npm-cache/` 等目录，避免把本地缓存打进 asar。
- `build.compression: maximum`、`asar: true`。
- 用 `npm run report:size` 查看产物与解包体积；若某个依赖异常占空间，再决定是否按需加载。
- 历史产物（`dist/ContextGate*5.2.8.exe` 等）不会被发布，但会占用磁盘，发布前建议清理。

## 仍需人工完成

1. **购买并配置代码签名证书**（EV/OV）。这是唯一无法由代码完成的部分。
2. 在仓库设置里开放 Issue 渠道（当前 GitHub 显示 "Issue creation is restricted"）。
3. 首次发布后确认 Release 资产文件名与 `package.json` 的 `artifactName` 一致
   （Windows 安装包现在固定为 `ContextGate-Setup-<version>-<arch>.exe`）。
