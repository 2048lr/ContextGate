# 发布流程 (Release)

本文档定义 ContextGate 的标准发布流程、紧急热修复流程，以及版本回滚机制。

> 相关文档：[版本管理规范 (VERSIONING.md)](./VERSIONING.md) | [变更日志 (../CHANGELOG.md)](../CHANGELOG.md)

---

## 一、发布前检查清单

发布前必须逐项确认：

- [ ] **工作区干净**：`git status` 无未提交改动（`release.js` 会自动检查）。
- [ ] **测试通过**：`cd app/gui-js && npm test` 全绿（当前 46 个用例）。
- [ ] **Lint 通过**：`cd app/gui-js && npx eslint lib cli.js main.js preload.js renderer.js` 无错误。
- [ ] **CHANGELOG 已更新**：在 `CHANGELOG.md` 顶部新增本版本条目，分类齐全，附发布日期。
- [ ] **版本一致性**：`npm run version:check` 全部 ✓。
- [ ] **确定递增位**：按 [VERSIONING.md](./VERSIONING.md) 第二节判定 patch/minor/major。

## 二、标准发布流程

### 方式 A：自动化发布（推荐）

在 `app/gui-js` 目录执行：

```bash
# 方式 1：交互式 / 默认 patch
npm run release

# 方式 2：指定递增位
npm run release -- --patch   # 补丁版本
npm run release -- --minor   # 次版本（如本次 5.2.9 → 5.3.0）
npm run release -- --major   # 主版本
```

`release.js` 自动完成 6 步：
1. 检查工作区是否干净
2. 运行测试套件
3. 检查版本一致性
4. 递增版本号并同步所有文件
5. 创建 Git 提交（`release: vX.Y.Z`）和标签（`vX.Y.Z`）
6. 输出构建和推送的后续指令

> ⚠️ **重要**：`release.js` 不会自动 push，也不会自动改 CHANGELOG。请先手动更新 CHANGELOG，再运行 release。

### 方式 B：手动发布

```bash
# 1. 更新 CHANGELOG（手动编辑 CHANGELOG.md，新增版本条目）

# 2. 递增版本号（在 app/gui-js 下）
npm run version:minor        # 或 version:patch / version:major

# 3. 再次验证一致性
npm run version:check

# 4. 提交并打标签
cd ../..
git add -A
git commit -m "release: v5.3.0"
git tag -a v5.3.0 -m "Release v5.3.0"
```

## 三、构建与发布产物

```bash
# 构建 Windows 安装包（x64 + ia32）与便携版
cd app/gui-js
npm run build:win
```

构建产物位于 `app/gui-js/dist/`：
- `ContextGate-Setup-*.exe` — NSIS 安装包
- `ContextGate-*.exe` — 便携版

## 四、推送发布

```bash
git push && git push --tags
```

随后在 [GitHub Releases](https://github.com/2048lr/ContextGate/releases) 创建新发布：
1. 选择刚推送的标签 `vX.Y.Z`
2. 标题填 `vX.Y.Z`
3. 描述复制 `CHANGELOG.md` 对应版本条目
4. 上传 `dist/` 中的安装包作为附件

## 五、紧急热修复流程 (Hotfix)

当已发布版本发现严重 bug 需紧急修复：

```bash
# 1. 从发布标签创建热修复分支
git checkout -b hotfix/v5.3.1 v5.3.0

# 2. 修复 bug，新增回归测试
#    （编辑代码...）

# 3. 运行测试确认修复
cd app/gui-js && npm test

# 4. 递增 patch 版本
npm run version:patch        # 5.3.0 → 5.3.1

# 5. 更新 CHANGELOG，新增 [5.3.1] 条目（标记为 hotfix）

# 6. 提交、打标签、构建、推送（同标准流程）
git add -A
git commit -m "hotfix: v5.3.1 - <修复描述>"
git tag -a v5.3.1 -m "Hotfix v5.3.1"
git push && git push --tags

# 7. 合并回主分支
git checkout main
git merge hotfix/v5.3.1
git push
```

## 六、版本回滚机制

回滚分两种情况，使用 `scripts/version-rollback.js` 工具。

### 6.1 已打标签但未 push（本地回滚）

```bash
# 回滚到上一个版本（删除标签 + 重置提交）
node scripts/version-rollback.js --to 5.2.9
```

工具会：
1. 删除本地 `vX.Y.Z` 标签
2. 将版本号字段回滚到目标版本
3. 提示执行 `git reset --hard HEAD~1` 撤销 release 提交

### 6.2 已 push 发布（创建回滚版本）

**切勿删除已 push 的标签**（会破坏下游依赖）。正确做法是发一个**新的回滚版本**：

```bash
# 例如 5.3.0 引入了回归，回滚到 5.2.9 的行为
npm run version:minor   # 5.3.0 → 5.3.1
# 在 CHANGELOG [5.3.1] 的 Reverted/Changed 区说明回滚内容
# 代码层面 revert 引入问题的提交：
git revert <problem-commit>
npm run release -- --patch
```

### 6.3 回滚脚本用法

```bash
# 查看可回滚的历史版本
node scripts/version-rollback.js --list

# 预览回滚操作（不实际执行）
node scripts/version-rollback.js --to 5.2.9 --dry-run

# 执行回滚（仅本地标签已打、未 push 的情况）
node scripts/version-rollback.js --to 5.2.9
```

> ⚠️ 回滚操作有破坏性，`version-rollback.js` 在执行前会强制检查「目标标签未 push」并要求二次确认。

## 七、预发布版本流程

```bash
# 1. 设置预发布版本号（手动指定，因 version-bump 不处理预发布位）
npm run version:sync -- 5.4.0-beta.1

# 2. 构建并发布为 GitHub Pre-release（勾选 "Set as a pre-release"）

# 3. 转 正式版
npm run version:sync -- 5.4.0
# 在 CHANGELOG 合并 beta 条目为正式条目
npm run release -- --minor
```
