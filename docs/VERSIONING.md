# 版本管理规范 (Versioning)

ContextGate 采用 [语义化版本 2.0.0 (SemVer)](https://semver.org/lang/zh-CN/) 规范。
本文档定义版本号命名规则、变更日志规范，以及配套的自动化工具链。

> 相关文档：[发布流程 (RELEASE.md)](./RELEASE.md) | [变更日志 (../CHANGELOG.md)](../CHANGELOG.md)

---

## 一、版本号格式

```
MAJOR.MINOR.PATCH[-PRERELEASE]
         │     │      │
         │     │      └─ 向后兼容的 bug 修复
         │     └──────── 向后兼容的新功能
         └────────────── 不兼容的重大变更（API 破坏性改动、架构重写）
```

示例：`5.3.0`、`6.0.0`、`5.3.1-beta.1`

## 二、版本递增判定标准

| 递增位 | 触发条件 | 示例 |
|--------|----------|------|
| **PATCH** (`x.y.Z`) | 修复 bug，完全向后兼容，无新功能、无行为变更 | 修复费用计算 bug、修复 UI 状态不同步 |
| **MINOR** (`x.Y.0`) | 新增向后兼容的功能或机制；非破坏性的改进 | 新增版本管理机制、新增提供商支持、UI 改进 |
| **MAJOR** (`X.0.0`) | 不兼容的重大变更 | 架构重写、删除/重命名公开配置项、最低运行时要求变更 |

### 判定原则
- **有疑问时取更保守的一位**：若改动介于 patch 与 minor 之间，按 minor 处理，便于下游感知。
- **同时包含修复与功能**：取最高位。例如「3 个 bug 修复 + 1 个新功能」应递增 minor。
- **纯重构（无行为变化）**：递增 patch，并在 CHANGELOG 的 `Changed` 区说明。

## 三、预发布版本 (Pre-release)

预发布号附加在版本号后，用 `-` 分隔：

| 标识 | 含义 | 用途 |
|------|------|------|
| `-alpha.N` | 早期内部测试 | 功能未完成，仅供开发者验证 |
| `-beta.N` | 功能完整待验证 | 邀请用户测试，可能有 bug |
| `-rc.N` | 发布候选 | 已冻结功能，若无重大问题将转为正式版 |

**优先级**：`1.0.0-alpha` < `1.0.0-beta` < `1.0.0-rc.1` < `1.0.0`

预发布版本号**不长期保留**，转为正式版后即从 CHANGELOG 顶部合并为一条正式记录。

## 四、版本号存储位置

单一事实来源 (Single Source of Truth) 为 `app/gui-js/package.json` 的 `version` 字段，
由 `version-sync.js` 自动同步到以下文件，**禁止手动分散修改**：

| 文件 | 版本号形式 |
|------|-----------|
| `app/gui-js/package.json` | `"version": "x.y.z"` （权威源） |
| `app/gui-js/package-lock.json` | 顶层 `version` 与 `packages[""].version` |
| `app/gui-js/index.html` | `<meta name="version" content="x.y.z">` |
| `README.md` | 版本徽章 URL `badge/version-x.y.z-blue` |

运行 `npm run version:check`（在 `app/gui-js` 下）可验证所有文件版本一致。

## 五、自动化工具链

所有脚本位于 `scripts/` 目录，通过 `app/gui-js/package.json` 的 npm scripts 调用：

| 命令 | 对应脚本 | 作用 |
|------|---------|------|
| `npm run version:current` | `version-sync.js --current` | 打印当前版本号 |
| `npm run version:check` | `version-sync.js --check` | 检查所有文件版本是否一致（CI 守卫） |
| `npm run version:sync -- x.y.z` | `version-sync.js x.y.z` | 同步所有文件到指定版本号 |
| `npm run version:patch` | `version-bump.js patch` | 递增 patch 位并同步 |
| `npm run version:minor` | `version-bump.js minor` | 递增 minor 位并同步 |
| `npm run version:major` | `version-bump.js major` | 递增 major 位并同步 |
| `npm run release` | `release.js` | 完整发布流程（检查→测试→bump→commit→tag） |

## 六、变更日志规范

遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，`CHANGELOG.md`
按版本倒序排列，每个版本使用以下分类：

- **Added** — 新增的功能
- **Changed** — 对已有功能的变更
- **Deprecated** — 即将移除的功能
- **Removed** — 本版本移除的功能
- **Fixed** — 任何 bug 修复
- **Security** — 安全相关的修复

**要求**：
1. 每个版本条目必须包含发布日期（ISO 8601 格式 `YYYY-MM-DD`）。
2. 仅记录「对使用者有意义」的变更，内部重构若无行为变化可在 `Changed` 简述。
3. 每个版本条目底部附 GitHub Release 比较链接。

## 七、Git 标签

每个正式版本必须打一个带 `v` 前缀的带注释标签：

```bash
git tag -a v5.3.0 -m "Release v5.3.0"
```

标签与版本号严格一一对应，**不允许复用或移动已发布的标签**。
