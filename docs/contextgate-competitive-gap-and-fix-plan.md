# ContextGate 竞品劣势分析与后期修复计划（Fix Plan）

| 项目 | 内容 |
|------|------|
| 分析对象 | ContextGate `v5.5.0`（源码 `app/gui-js`，Electron 28.3.3 + Express 4.22.1 + sql.js + axios） |
| 分析时间 | 2026-09（基于当前工作区 `C:\Users\Admin\ContextGate`） |
| 分析方法 | ① 全量通读本仓库源码；② 在本机对产物与运行时行为做**实测**；③ 联网检索同类产品公开资料做能力基线比对 |
| 文档用途 | 输入给后续开发，可直接拆成 issue / 迭代 backlog |
| 结论一句话 | ContextGate 当前的“上下文管理 + API 代理”两条主线**都没有形成闭环**：代理层对一个 300KB 请求直接返回 413，上下文文件从未被注入请求，成本/预算/监控在主流流式用法下恒为 0。它现在的真实竞争力是“本地、免部署、桌面托盘 + 一键打包上下文文件”，其余宣称能力相对 2025-2026 年的市场基线存在代差。 |

---

## 0. 摘要（TL;DR）

### 0.1 最致命的 6 个问题（P0）

| # | 问题 | 实测/代码证据 | 后果 |
|---|------|--------------|------|
| **P0-1** | 代理请求体被 `express.json()` 默认 **100KB** 上限截断 | 实测：300KB 请求 → `HTTP 413 PayloadTooLargeError`（返回 HTML 错误页） | 代理对“长上下文”场景**不可用**。ContextGate 自己生成的 `full_context.txt` 就有 492KB，默认配置下连自家上下文都发不出去 |
| **P0-2** | 本地代理**零鉴权**，无 Host/Origin 校验 | 实测：不带任何 `Authorization` 访问 `/stats` 返回 200；`router.js` 全文件无鉴权中间件 | 本机任意进程（以及 DNS rebinding 场景下的浏览器页面）可白嫖用户的 API Key 额度、读取统计、清空缓存 |
| **P0-3** | “上下文管理”与“代理”**没有打通** | `router.js:66` 只用 `contextFile` 做缓存失效判断，从不把上下文注入请求；README「IDE Integration」只教用户改 Base URL | 核心卖点无产品化路径：用户必须自己把 `full_context.txt` 手工喂给工具，软件本身不产生价值 |
| **P0-4** | 上下文构建=**全量无预算拼接**，且会腐烂 | `max_tokens=8000`、`watch_enabled`、`debounce_seconds` 三个配置项在 UI 与 config 中存在，但**全仓库无任何代码读取**；`chokidar` 依赖已安装却从未 `require`；工作区根目录的 `full_context.txt`（未被 git 跟踪，但确实存在于当前工作区）仍在引用早已删除的 `lib/config.js`、`lib/scanner.js` 等文件 | 上下文越用越贵越不准；用户看到的“智能上下文最大 Token”是空转旋钮 |
| **P0-5** | 成本/预算监控在主流用法下**恒为 0**，且预算从未生效 | 实测流式请求：上游收到 `stream_options = undefined`，代理记账 `{"in":0,"out":0,"cost":0}`；定价表硬编码 22 个模型；`budget_limit`/`warning_threshold`/`critical_threshold` 仅被 UI 读写、无任何判定逻辑；UI「今日节省」显示的实际是今日成本（`renderer.js:32,45`） | “省钱 / 预算告警”是宣传口径，不是功能；用户拿不到可信数字 |
| **P0-6** | 缓存 key 漏参数 → **静默返回错误答案** | 实测：先发“带 `tools`”的请求，再发同一段 messages **不带 `tools`** 的请求，第二次 `X-Cache: HIT` 且拿回上一次的答案，上游只被调用 1 次；`cache-manager.js:33` 未纳入 `tools`/`tool_choice`/`response_format`/`seed`/`n`/`stop` 等 | function calling 场景下用户会拿到为另一种上下文生成的回答，无任何提示 |

### 0.2 修复优先级总览

| 阶段 | 主题 | 任务数 | 预估工作量 | 目标 |
|------|------|--------|-----------|------|
| **P0** | 让产品“能用且不骗人”（FIX-01~06，对应 P0-1~P0-6） | 6 | 8–12 人日 | 大请求可通、有鉴权、监控数字可信、上下文/预算真正生效 |
| **P0+** | 安全 Critical，**建议立刻并行**（FIX-S1~S3） | 3 | 4–7 人日 | 恢复沙箱、升级已 EOL 的 Electron、去掉 TLS 降级开关、补安全披露渠道 |
| **P1** | 补齐网关工程能力（FIX-07~13） | 7 | 20–30 人日 | 流式可靠性、持久化缓存、Prompt Caching、协议兼容、数据层、密钥安全 |
| **P2** | 拉近与市场基线的差距（FIX-14~19） | 6 | 25–40 人日 | 安全硬化、签名自动更新、可观测生态、跨平台/无头、CI 与集成测试、生态位收敛 |

> 分类说明：**缺陷清单**为 P0 六项（P0-1~P0-6）、P1 九项（P1-1~P1-9）、P2 十一项（P2-1~P2-11），逐条见第 3 章；**修复计划**在第 5 章，其中安全 Critical 三项（FIX-S1~S3）单列为 P0+ 以便立即并行推进。验收标准同时见第 5 章与第 8 章。

---

## 1. 调研方法与证据等级（重要）

本文所有结论按证据强度分级标注，**请勿把 C 级当作已验证事实**：

| 等级 | 含义 | 本文标注 |
|------|------|----------|
| **A 级（实测）** | 本机对源码/二进制/运行时行为直接验证，命令与结果见附录 B | `[A]` |
| **B 级（源码）** | 通过阅读仓库源码得出，附 `文件:行号` | `[B]` |
| **C 级（外部资料）** | 联网检索定位到的公开资料/官方文档入口 | `[C]` |
| **D 级（工程判断）** | 基于经验的风险推断，未实测也未找到直接来源 | `[D]` |

> ⚠️ **调研过程说明（必须如实记录）**：本会话内置的网页抓取工具（`web_fetch`）对所有外部域均失败（`github.com`、`ai.google.dev`、`platform.claude.com`、`raw.githubusercontent.com` 一律返回 `URL hostname resolves to a non-public IP address`）。因此改用 **Firecrawl 技能与 Node `fetch`** 抓取原文，成功下载并逐段核对了以下一手资料：OpenAI Prompt Caching 指南、Anthropic《Effective context engineering for AI agents》、Chroma《Context Rot》研究报告、aider repo map 文档、Repomix 仓库 README、gitingest、Cursor 语义检索工程博客、Cline/Roo Code/Sourcegraph Cody 上下文文档、LM Studio / Ollama 文档、Microsoft SmartScreen 文档、WICG Private Network Access 说明书、Electron 安全清单与 `safeStorage`、`endoflife.date` 的 Electron 生命周期、GitHub 上的 ContextGate 仓库页/Releases 页/Issues 页/Commits 页。
>
> 未能取得可靠来源的项：具体杀软误报统计数据、OWASP DNS Rebinding 专页（404）、electron-builder 自动更新文档（本次 404）、LM Studio/Ollama 的遥测与许可证官方明确声明（故未作断言）。`api.github.com` 已触发匿名速率限制（403），star/issue 等数字取自页面内嵌 JSON。
>
> 因此：本文 `[A]`（本地实测）、`[B]`（源码）、`[C]`（已抓取原文，除非该条明确写"仅索引定位"）三类证据均可复核；`[D]` 为工程判断。

---

## 2. 产品定位与市场坐标

### 2.1 ContextGate 实际是什么（源码事实）

`[B]` 从代码看，它由三个互相松耦合的部件组成：

1. **CodeScanner**（`lib/scanner/scanner.js`）：递归遍历项目 → 过滤扩展名/体积/`EXCLUDE_DIRS` → 拼接成 `full_context.txt`（文本大文件）。
2. **ProxyServer**（`lib/proxy/proxy-server.js` + `router.js`）：Express 起在 `127.0.0.1:12306`，把 OpenAI 形状的路径转发到各 provider 的 `base_url`，带一层进程内 LRU 响应缓存与 sql.js 用量统计。
3. **Electron GUI**（`main.js` + `index.html` + `renderer.js`）：卡片式界面 + 系统托盘 + 设置弹窗。

关键事实：**①②之间只有一条细线**——`router.js:66` 调用 `cacheManager.invalidateIfNeeded(svc.contextFile, svc.projectRoot)`，也就是“上下文变了就把缓存清空”。上下文内容本身**不参与请求构造**。

### 2.2 市场竞争者分五类（按与 ContextGate 的真实重叠度排序）

| 类别 | 代表产品 | 与 ContextGate 的重叠点 | 关系 |
|------|---------|------------------------|------|
| **A. LLM 网关 / 代理** | LiteLLM Proxy、Portkey AI Gateway、Cloudflare AI Gateway、Kong AI Gateway、Apache APISIX `ai-proxy`、Bifrost | 多 provider 转发、缓存、限流、虚拟 key、成本追踪 | **正面竞争**：ContextGate 的代理部分就是这类产品的极简子集 |
| **B. LLM 可观测 / 成本管理** | Helicone、Langfuse、LangSmith、OpenRouter（自带用量与计费）、ccusage | Token/成本统计、预算、缓存命中率、看板 | 功能重叠：ContextGate 的“监控”是它们的玩具版 |
| **C. 上下文打包（repo → prompt）** | Repomix、gitingest、uithub、aider 的 repo map、Cursor 的 codebase indexing、Continue 的 `@codebase`、Cline | 把代码库变成模型可用上下文 | **真正的定位重叠**：ContextGate 的扫描器是其中最弱的一档 |
| **D. 本地模型/桌面 AI 工具** | LM Studio、Ollama、Jan | 本地端点（OpenAI 兼容）、隐私叙事、桌面体验、自动更新 | 体验与分发生态上的标杆 |
| **E. 中文 API 聚合分发** | One API、New API、uni-api | 多 Key 聚合、分发、计费、多用户 | 在国内用户侧的**直接替代品**，且功能更全 |

### 2.3 竞品能力基线（2025–2026 年“及格线”）

`[C-索引级]` 网关/可观测类产品：以下为**检索定位**到的官方文档入口，本次**未逐页抓取核对原文**，仅用于说明行业能力面（不引用其中任何数字）：

- LiteLLM Proxy：100+ provider、虚拟 Key 与预算、多层缓存（内存/Redis/语义）、OpenTelemetry、负载均衡与 fallback — <https://docs.litellm.ai/docs/proxy/quick_start>、<https://docs.litellm.ai/docs/proxy/virtual_keys>、<https://docs.litellm.ai/docs/proxy/caching>
- Portkey AI Gateway：路由/重试/fallback/缓存/守卫（guardrails）+ 可观测 — <https://portkey.ai/docs/product/ai-gateway>
- Helicone：一行 Base URL 接入的 LLM 可观测与成本分析 — <https://docs.helicone.ai/>
- OpenRouter：统一入口、按模型路由、原生返回 usage/成本 — <https://openrouter.ai/docs/quickstart>
- Cloudflare AI Gateway：缓存、限流、重试、日志与分析 — <https://developers.cloudflare.com/ai-gateway/>
- Kong AI Gateway：企业级 AI 流量治理（语义缓存、Prompt 守卫、PII 脱敏） — <https://developer.konghq.com/ai-gateway/>
- Apache APISIX `ai-proxy`：网关插件化的多模型代理 — <https://apisix.apache.org/docs/apisix/plugins/ai-proxy/>
- Bifrost（Maxim AI）：主打高性能/低开销的 LLM 网关 — <https://github.com/maximhq/bifrost>
- Langfuse：LLM 可观测、成本与评测平台 — <https://langfuse.com/docs>
- One API / New API：国内“聚合 + 分发 + 计费 + 多用户”的成熟实现 — <https://github.com/songquanpeng/one-api>、<https://github.com/Calcium-Ion/new-api>

**规模与定位对比**（star 数为第三方统计站**快照值**，本次未逐站核实，仅供量级参考；new-api 同时命中 `Calcium-Ion/new-api` 与 `QuantumNous/new-api` 两个命名空间，上游归属未核实）：

| 产品 | 量级 | 定位 | 与 ContextGate 的关系 |
|------|------|------|---------------------|
| LiteLLM Proxy | ~57k★ | 开源统一网关 | 功能超集（OpenAI 兼容 + 原生 `/v1/messages`、`/v1/responses` 透传；内存/Redis/S3/GCS/磁盘 + Qdrant 语义缓存；Prometheus/OTel） |
| one-api / new-api | ~37k★ / 官方称 ~49k★ | 中文 API 聚合分发 | 国内用户侧的**直接替代品**（渠道、令牌、额度、多租户计费） |
| Langfuse / LangSmith | ~34k★ / 商业 | 可观测与评测 | **互补**（不做代理），是 ContextGate 缺的“出口” |
| Kong / APISIX | ~44k★ / ~17k★ | 企业网关 | AI Semantic Cache、语义负载均衡、插件体系 |
| Portkey / Helicone / Bifrost | ~13k★ / ~5.8k★ / 官方称 8k★ 量级 | 网关 / 可观测 / 高性能网关 | 能力面覆盖 fallback、guardrails、限流、缓存 |
| OpenRouter / Cloudflare AI Gateway | 商业 SaaS | 托管路由 / 边缘网关 | 不可自托管，但定义了“开箱即用”的体验标准 |

> **2025–2026 年“自称 LLM 网关”的 6 条不合格红线**（缺任一即被专业用户判为不合格）：① 同时支持 OpenAI `/v1/chat/completions` **与** Anthropic `/v1/messages`（新近再加 `/v1/responses`）；② 上游失败自动 fallback / 重试 / 超时控制；③ 流式 SSE 转发 **且流式下能准确计量 token 与费用**；④ 按 key/用户的预算与限流**硬约束**（到额即拒，而非只统计）；⑤ 可导出的指标或日志（Prometheus / OTel / webhook）；⑥ 至少精确匹配缓存与命中率统计。
> **ContextGate 当前触线情况**：⑥ 部分达标（但 key 有正确性缺陷）、① 触线（缺 `/v1/messages` 与 `/v1/responses`）、② 触线、③ 触线（实测流式记账为 0）、④ 触线（预算无任何判定）、⑤ 触线（无任何导出）。
>
> 竞品能力的逐项来源与“未能证实”标注，见同目录支撑文档 [llm-gateway-competitive-research.md](llm-gateway-competitive-research.md)。

`[C]` 上下文侧基线（**以下原文已在本机抓取并逐段核对**，不再是仅凭索引）：

- **aider repo map**：用 tree-sitter 解析代码，再用**图排序算法**挑出最相关符号，使其“fit into the active token budget”，预算由 `--map-tokens` 控制、**默认 1k tokens** — <https://aider.chat/docs/repomap.html>
- **Repomix**：提供逐文件与整库 **token 计数**；`--compress` 用 **tree-sitter** 抽取关键结构（官方称可减少约 70% token）；输出支持 XML/Markdown/JSON/Plain；支持 `--include/--ignore`、远程仓库、`--token-count-tree`；**安全**上用 Secretlint 扫描凭据并把命中文件排除在输出之外；还提供 MCP server 形态 — <https://github.com/yamadashy/repomix>
- **gitingest**：把 Git 仓库转成可粘贴 prompt，带 token 估算与过滤配置 — <https://gitingest.com/>、<https://github.com/cyclotruc/gitingest>
- **Cursor 语义检索**：自训练 embedding 模型 + 索引管线，官方明确说“semantic search significantly improves agent performance, especially over large codebases”，并用 agent 会话轨迹做训练信号 — <https://cursor.com/blog/semsearch>
- **Roo Code / Cursor 等 IDE 侧方案**：Roo Code 用 tree-sitter 语义块 + embedding + Qdrant 向量库做 `codebase_search`，并支持增量更新；Cursor 用 Merkle 树做增量同步、按 chunk 缓存 embedding。详见 §2.4 对比表。来源：<https://roocodeinc.github.io/Roo-Code/features/codebase-indexing/>、<https://cursor.com/blog/secure-codebase-indexing>
- **Anthropic《Effective context engineering for AI agents》**：明确“context rot”——“as the number of tokens in the context window increases, the model's ability to accurately recall information from that context decreases”；并称 LLM 有“attention budget”，好的上下文工程是“finding the smallest possible set of high-signal tokens”；Claude Code 的做法是“CLAUDE.md 靠前放，其余靠 glob/grep 即时检索，**从而绕开 stale indexing**” — <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- **Chroma《Context Rot》研究**：18 个模型（含 GPT-4.1/Claude 4/Gemini 2.5/Qwen3）实测，“model performance consistently degrades with increasing input length”；LongMemEval 上 **~113k token 全量输入 vs ~300 token 聚焦输入**存在显著性能差距；干扰项（distractors）随输入变长影响放大 — <https://research.trychroma.com/context-rot>
- **OpenAI Prompt Caching 官方指南**（原文已抓取）：要求“**Keep the prefix stable**… If developer instructions or shared material contain **timestamps**, user-specific content, or other dynamic content, place those at the end rather than the beginning”；读取按 0.1× 输入价、写入 1.25×（GPT-5.6+），最小可缓存前缀 1,024 token；并提示 compression/compaction 会改变前缀从而重置复用 — <https://platform.openai.com/docs/guides/prompt-caching>
- **Anthropic Prompt Caching** — <https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching>
- **“Lost in the Middle”** — <https://arxiv.org/abs/2307.03172>

`[C]` **竞品生态位与基线补充（原文已抓取）**：

- **LM Studio**：OpenAI 兼容端点含 `/v1/models`、`/v1/chat/completions`、**`/v1/responses`**；自 0.4.0 起提供 **API Token 鉴权**（默认关闭、可按权限签发）；官方强调“entirely offline” — <https://lmstudio.ai/docs/app/api/endpoints/openai>、<https://lmstudio.ai/docs/developer/core/authentication>、<https://lmstudio.ai/docs/app/offline>
- **Ollama**：默认绑定 `127.0.0.1:11434`，`OLLAMA_HOST` 改绑定，`OLLAMA_NO_CLOUD` 提供隐私开关 — <https://docs.ollama.com/faq>、<https://docs.ollama.com/api/openai-compatibility>
- **用量可见性的真实需求**：Claude Code 提供 `/usage`、`/cost`，并以 OpenTelemetry 导出（官方称这是把 per-user token/cost 近实时流入自有可观测栈的方式） — <https://docs.claude.com/en/docs/claude-code/costs>；Cursor 有账号级 Usage 页 — <https://docs.cursor.com/en/account/usage>；第三方 `ccusage` **18,764 stars / 851 forks**、`Sniffly` **1,272 stars / 118 forks** — <https://github.com/ryoppippi/ccusage>、<https://github.com/chiphuyen/sniffly>
- **未签名 + 零声誉的代价**：微软文档称 SmartScreen 会检查“downloaded programs and the digital signature used to sign a file”，且“**If there's no reputation, the item is marked as a higher risk and presents a warning to the user**” — <https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/>
- **本地服务不等于安全**：WICG Private Network Access 说明书指出攻击只用安全列表内的方法/头，**不触发预检**，“the request itself is the CSRF attack”，并点名 loopback 服务“often assumes protections that simply don't exist” — <https://github.com/WICG/private-network-access/blob/master/explainer.md>；DNS rebinding 的服务端缓解是 **Host 头校验**（Jackson et al., CCS'07） — <https://crypto.stanford.edu/dns/>；同类“默认未启用 DNS rebinding 防护”的问题在 MCP 官方 SDK 上已被分配 CVE（`CVE-2026-34742`、`CVE-2025-66416`）— <https://app.opencve.io/cve/CVE-2026-34742>、<https://dependabot.ecosyste.ms/advisories/CVE-2025-66416>
- **Electron 安全与密钥存储基线**：官方 Security Checklist 把“Enable process sandboxing”单列一条，并明确 `--no-sandbox` “will disable the sandbox for **all** processes … never in production” — <https://www.electronjs.org/docs/latest/tutorial/security>、<https://www.electronjs.org/docs/latest/tutorial/sandbox>；`safeStorage`（Windows 走 DPAPI）的边界是“protected from other users on the same machine, **but not from other apps running in the same userspace**” — <https://www.electronjs.org/docs/latest/api/safe-storage>；**keytar 已于 2022-12-15 归档**，不应再选 — <https://github.com/atom/node-keytar>
- **运行时不支持状态**：`package.json` 锁 `electron: ^28.0.0`，而 **Electron 28 于 2024-06-10 EOL**（末版 28.3.3 / Chromium M120）— <https://endoflife.date/electron>；已知“context isolation bypass via `Function.prototype.bind` hijack”（CVE-2026-70601 / GHSA-h7rp-cf8h-j98x，CVSS 7.5）原文写明“**In renderers without a sandbox, or with nodeIntegration enabled, this may escalate to Node.js access**”，修复版本为 39.8.9 / 40.9.2 / 41.2.2 / 42.0.0-beta.5 — <https://github.com/electron/electron/security/advisories/GHSA-h7rp-cf8h-j98x>；另有 contextBridge 原型污染类公告 — <https://github.com/electron/electron/security/advisories/GHSA-ff2p-hmqr-hxm4>。**ContextGate 同时满足“关沙箱 + 远低于修复版本”两个条件。**

`[C]` **ContextGate 自身在市场中的真实位置（外部分析已核实）**：

| 指标 | 核实结果 | 来源 |
|------|---------|------|
| Star / Fork / Watcher | **1 / 0 / 0** | GitHub 仓库页内嵌 JSON（<https://github.com/2048lr/ContextGate>） |
| 最新 Release | **v5.2.9（2026-05-27）**，共 20 个 Release；**全部资产累计下载 31 次** | Releases 页 |
| 版本脱节 | tag 已到 **v5.5.0**、`package.json`=5.5.0，但 **v5.4.0/v5.5.0 无 Release**；v5.2.9 的资产文件名仍是 `ContextGate.5.2.8.exe` | Releases 页 |
| Issues | `totalCount: 0`，且页面显示“**Issue creation is restricted in this repository**” | Issues 页 |
| 贡献者 | 76 次提交**全部**来自 `liurun637@gmail.com`（JerryLiu 60 / Run Liu 10 / 2048lr 8），首提交 2026-03-30 | Commits 页 |
| CI | 无（`bb55d47f` 为“ci: 删除过时的GitHub Actions构建工作流”） | 本地 `git log` |
| 体积 | Setup **144.2MB**、便携版 **76.7MB**（发布资产）；本地 5.3.1 产物安装包 151MB、解包 exe 176MB | Releases 页 + 本地 `dist/` |

> 含义：这不只是“功能落后”，而是**一个只有 1 个 star、总下载 31 次、单人维护、无 issue 渠道、无 CI、发布与代码脱节的项目**。任何路线图都必须先解决“可被验证交付”的问题，否则再多功能也无法积累用户。

### 2.4 “把代码库变成上下文”这一档的横向对比（原文已抓取）

| 工具 | 上下文选择策略 | token 预算 | 过滤/忽略 | 增量更新 | 安全设计 |
|------|---------------|-----------|----------|---------|---------|
| **ContextGate**（现状） | 全量拼接（字典序） | 配置项存在但**不生效** | 仅根 `.gitignore` + 扩展名/体积白名单 | **无**（仅启动时重建） | 无 secret 检测；产物含时间戳 |
| **Repomix** | 全量打包 + 可选 `--compress`（tree-sitter 抽取结构，官方称约减 70% token） | 逐文件/整库 token 计数、`--token-count-tree` | `--include/--ignore`、支持远程仓库 | 支持 watch（`-w`） | Secretlint 扫描凭据并把命中文件排除出输出 |
| **gitingest** | 文本 digest（`digest.txt`） | 页面可设“Include files under N kB” | Exclude/Include 面板 | 重新 ingest | 私有仓库 PAT 用后即丢弃、克隆产物处理后删除 |
| **uithub** | 全量 / 子目录 / 按扩展名 | **URL 参数 `?maxTokens=10000`** | `?ext=js,ts`、`?maxFileSize=10000` | — | 托管服务（需注意代码外发） |
| **aider repo map** | tree-sitter 解析 + **图排序**选最相关符号 | `--map-tokens`，**默认 1k** | 依赖 git/ignore 配置 | 随会话重建（repo map 有缓存） | 本地处理 |
| **Cursor** | 自训练 embedding + 索引管线（语义检索） | 按检索结果注入 | 索引忽略规则 | **Merkle 树**增量同步（5 万文件仅约 3.2MB 元数据），embedding 按 chunk 内容缓存 | 路径混淆；客户端只上传必要内容 |
| **Roo Code** | tree-sitter 语义块 → embedding → Qdrant，提供 `codebase_search` | 由 similarity threshold / max results 控制 | 遵循项目 ignore 模式 | **支持增量更新** | 仅 100–1000 字符小片段用于 embedding，解析全在本地 |

来源：Repomix <https://github.com/yamadashy/repomix>；gitingest <https://gitingest.com/> 及其 `src/gitingest/config.py`（已抓取：单文件 ≤10MB、目录深度 ≤20、文件数 ≤10,000、输出 ≤500MB）；uithub <https://uithub.com/>；aider <https://aider.chat/docs/repomap.html>；Cursor <https://cursor.com/blog/secure-codebase-indexing>、<https://cursor.com/blog/semsearch>；Roo Code <https://roocodeinc.github.io/Roo-Code/features/codebase-indexing/>。

> **上表说明的问题**：这一档能力的“及格线”是 **token 预算 + 过滤 + 增量 + 凭据扫描** 四件套；ContextGate 目前四项全缺，且连自己声明的 `max_tokens` 都没接上。因此 P0-4 / FIX-05 属于**定位级**而非“优化级”工作。
> 调研校正：Cline 与 Continue 的上下文文档 URL 本次返回 **404**（<https://docs.cline.bot/prompting/context-management>、<https://docs.continue.dev/customize/context/codebase>），故不引用其具体能力，避免以失效页面为依据。

---

## 3. 劣势与缺陷清单

### 3.1 P0：阻断级 / 承诺与实现不符

#### P0-1 代理对 >100KB 请求直接 413（实测）

- **证据** `[A]`：本地以 `ProxyServer` 起服后 POST 300KB JSON：

  ```
  300KB 请求体 -> HTTP 413 text/html; charset=utf-8
  PayloadTooLargeError: request entity too large
  ```
- **代码** `[B]`：`app/gui-js/lib/proxy/router.js:16` → `app.use(require('express').json())`，未设置 `limit`；Express 4 的 `express.json()` 默认上限 100KB（本机 body-parser 1.20.4）。且 `router.js` 未注册任何错误处理中间件，413 由 Express 默认处理器渲染成 **HTML 页面**，任何 OpenAI SDK 客户端都无法把它解析成结构化错误。
- **放大效应** `[B]`：`README.md:28` 宣称“扫描项目并构建上下文文件”，工作区内实际产物 `full_context.txt` 为 **492,618 字节**（未跟踪但真实存在）；即便客户端只是把该文件贴进一条 user message，也 5 倍超限。
- **对标** `[C]`：生产级网关（LiteLLM / Cloudflare AI Gateway / Portkey）均按需放大或可配置 body 上限，并返回结构化错误。
- **影响**：致命。默认配置下“带上下文的对话”这条路完全走不通，用户只会看到 413 或客户端报错。

#### P0-2 本地代理零鉴权、零来源校验

- **证据** `[A]`：启动代理后，**不带 `Authorization`** 请求 `/stats`：

  ```
  无 Authorization 头访问 /stats -> 200 {"cacheSize":0,"contextHash":"bf21a9e8...","uptime":1.07}
  ```
- **代码** `[B]`：`router.js:13-191` 无任何鉴权中间件；`proxy-server.js:23-42` 没装 CORS/Host/Origin 校验；`/stats`、`/context/hash`、`DELETE /cache`、`/providers*` 全部裸奔。`resolveApiKey`（`forwarder.js:43-54`）在代理侧配置了真实 Key 时会**无条件使用它**替客户端付费。
- **其他攻击面** `[B]`：`router.js:30-33` 允许客户端用 `X-Target-Base-Url` 头让代理向**任意 URL** 发起请求（SSRF 面）；`/v1/models` 场景下会把客户端传入的 Key 转发给该 URL。此外 `proxy.host` 可被改成 `0.0.0.0`（`config.yaml.example` 与设置项均未禁止），等于把一个**带用户 Key 的转发器**暴露给整个局域网。
- **对标** `[C]`：LiteLLM 强制 master key / virtual key；[LM Studio 自 0.4.0 起提供 API Token 鉴权](https://lmstudio.ai/docs/developer/core/authentication)、[Ollama 默认绑定 127.0.0.1 并提供 `OLLAMA_NO_CLOUD` 隐私开关](https://docs.ollama.com/faq)；[WICG PNA 说明书](https://github.com/WICG/private-network-access/blob/master/explainer.md)明确指出 loopback 服务“often assumes protections that simply don't exist”，[DNS rebinding 的服务端缓解是 Host 头校验](https://crypto.stanford.edu/dns/)，MCP 官方 SDK 因默认未启用该防护已被分配 CVE（`CVE-2026-34742`）。
- **影响**：本机任意进程（含被投毒的其他软件、任意 Electron 应用、带 DNS rebinding 的网页）可消耗用户 API 额度、读取统计信息、清空缓存，且用户毫无感知。

#### P0-3 上下文与代理没有闭环

- **证据** `[B]`：全仓库中 `contextFile` 的用途只有两处——`cache-manager.loadContextSignature`（算 hash）与 `invalidateIfNeeded`（变了就清缓存）。`forwardRequest`/`forwardChatRequest`（`forwarder.js:97-124`）构造请求时**只看 `body` 与 provider 配置**，不注入任何抓取结果。
- **产品含义**：用户在 Cursor/Cline 里把 Base URL 指向 `http://127.0.0.1:12306` 后，得到的只是“一个会缓存响应的转发器”；`full_context.txt` 必须由用户自己想办法喂给模型。README 的「IDE Integration」表（`README.md:107-115`）也只讲了改 Base URL。
- **对标** `[C]`：Repomix/gitingest 的产物本身就是给人粘贴的（定位清晰）；Cursor/Continue/aider 则把检索结果**自动注入**请求（定位也清晰）。ContextGate 卡在中间：既没自动注入，也没把“可粘贴产物”做成顺畅体验（无复制按钮/无 per-file token 报告/无格式选择）。
- **影响**：核心价值主张（`README.md:31` “Reduce API costs through smart caching and context optimization”）缺乏实现支撑。

#### P0-4 上下文构建：无预算、不增量、会腐烂

- **死旋钮** `[B]`：`config.context.max_tokens`（默认 8000）、`watch_enabled`（默认 true）、`debounce_seconds` 存在于 `config-manager.js:73`、`index.html:270-289`、`renderer.js:211-224`，**但没有任何执行代码读取它们**（全仓库 grep 仅命中读写 UI 与默认值）。`chokidar@^3.5.3` 在 `package.json:33` 声明依赖，源码中**从未被 require**——所谓“启用文件监视（自动更新上下文）”不存在。
- **只在启动时构建一次** `[B]`：`main.js:74` 仅在 `startProxy()` 里重建上下文；长会话中项目继续演进，上下文随即过期，且无提示。
- **实测腐烂证据** `[A]`：工作区根目录 `full_context.txt`（492,618 字节，未跟踪）含 31 个文件头，其中 `app\gui-js\lib\config.js`、`lib\proxy.js`、`lib\scanner.js`、`lib\scanner\analyzer.js`、`lib\scanner\scorer.js`、`lib\scanner\smart-extractor.js` 等**在当前源码树里已不存在**（`git ls-files` 可证），而 `package-lock.json`（237KB）等低信号文件被完整收录。
- **无 token 预算裁剪** `[B]`：`scanner.js:77-102` 把所有文件按**字典序**追加，无排序优先级、无裁剪、无摘要、无去重；`estimatedTokens` 只是 `chars/4` 的估算（`scanner.js:101`）。
- **自包含污染** `[B]`：`DEFAULT_EXTENSIONS` 含 `.txt`/`.json`/`.md`（`scanner/constants.js:6-11`），输出文件 `full_context.txt` 落在项目根且不在排除目录内 → 第二次构建会把上一次的产物再拼进去（体积指数增长风险）。
- **忽略规则过弱** `[B]`：`scanner.js:14-18` 只读**根目录单个 `.gitignore`**，不读子目录 `.gitignore`、`.git/info/exclude`、全局 gitignore；也无 `.contextgateignore`、无 secret 检测、无 `.env` 特判。对照 `[C]`：Repomix 用 Secretlint 扫描凭据并将命中文件排除在输出之外（<https://github.com/yamadashy/repomix>）。
- **头部时间戳直接毁掉 Prompt Caching 的可复用前缀** `[B][C]`：`scanner.js:84` 在产物**第一行附近**写入 `# Generated: <ISO 时间>`。而 OpenAI 官方 Prompt Caching 指南明确要求“**Keep the prefix stable**… If developer instructions or shared material contain **timestamps**, user-specific content, or other dynamic content, **place those at the end rather than the beginning**”，并说明前缀任何变化都会导致后续内容无法命中缓存（<https://platform.openai.com/docs/guides/prompt-caching>）。这意味着：即便未来接入 prompt caching，**每次重建上下文都会让整段前缀失效**；而在当前实现里，这个时间戳每次构建都会变，等于把“降本最大杠杆”从设计上关掉。
- **对标** `[C]`（原文已抓取）：aider 的 repo map 用 tree-sitter 解析 + **图排序**挑出最相关符号，并使其“fit into the active token budget”，预算由 `--map-tokens` 控制、**默认仅 1k tokens**（<https://aider.chat/docs/repomap.html>）；Repomix 提供逐文件/整库 **token 计数**、`--compress`（tree-sitter 抽取结构，官方称约减 70% token）、XML/Markdown/JSON 多格式与 `--include/--ignore`（<https://github.com/yamadashy/repomix>）；Cursor 用自训练 embedding + 索引管线，官方称语义检索在大仓库上“significantly improves agent performance”（<https://cursor.com/blog/semsearch>）。
- **影响** `[C]`：上下文成本随仓库线性上涨、命中率下降。Chroma 对 18 个模型（含 GPT-4.1/Claude 4/Gemini 2.5/Qwen3）的实测结论是“model performance consistently degrades with increasing input length”，且在 LongMemEval 上 **~113k token 全量输入 vs ~300 token 聚焦输入**存在显著性能差距（<https://research.trychroma.com/context-rot>）；Anthropic 也把“context rot”与“attention budget”写进官方工程建议，主张只放“smallest possible set of high-signal tokens”（<https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>）。**全量拼接正好是这些结论的反面。**

#### P0-5 成本与预算：数字不可信、预算不生效

- **流式下 token 恒为 0（最常见用法）** `[A]`：用本地假上游（模拟 OpenAI 流式默认行为，不回传 usage）实测：

  ```
  [a] 上游收到的流式请求 stream_options = undefined
  [a] 代理记录的用量 = [{"in":0,"out":0,"cost":0}]
  ```

  代码原因 `[B]`：`router.js:211-228` 只在最后一个 SSE data 行里找 `usage`；而 OpenAI 兼容接口需在请求里带 `stream_options: { include_usage: true }` 才会返回 usage，全仓库无 `stream_options`/`include_usage` 字样（grep 证据，且上测已证明未注入）。DeepSeek/智谱等也不保证回传 usage → 流式请求记为 0 token、$0，而流式是 Cursor/Cline/Claude Code 的默认模式。
- **定价表硬编码且过期** `[B]`：`cost-calculator.js:1-24` 手写 22 个模型的价格；真实 ID 常带中划线后缀（如 `claude-3-5-sonnet-20241022`）→ 前缀匹配失败 → **成本 0**；未知模型一律 0（`cost-calculator.js:42`）。缓存读折扣、推理 token、批处理折扣均未建模。项目已经拉取 models.dev 目录（`models-dev.js`）并有 `enrichProviderWithCost`（`provider-registry.js:98-107`），却**没有把价格接进 `calculateCost`**。
- **预算三件套从未生效** `[B]`：`budget_limit`/`warning_threshold`/`critical_threshold` 仅出现在 `config-manager.js:71` 默认值、`index.html:236-247` 表单、`renderer.js:204-222` 读写。无判定、无告警、无拦截。
- **UI 口径错误** `[B]`：`renderer.js:32` 把 `s.today.cost` 赋给 `todaySavings`，`renderer.js:45` 以「今日节省」渲染；死代码 `lib/ui/app.js:318` 更把缓存命中按 `0.002 × tokens` 的魔法系数计入“节省”。命中率分母把命中同时算进请求数（`renderer.js:46-47`：`cacheHits/(requests+cacheHits)`）→ 系统性低估。
- **对标** `[C]`：Helicone/Langfuse/Portkey/OpenRouter 的成本追踪是核心能力；第三方 ccusage 类工具的存在说明用户对“可信用量”有强需求。
- **影响**：产品对外宣称的“省钱、监控、预算”在主流用法下全部失真，属于**信任级缺陷**。

#### P0-6 缓存正确性风险：key 漏参数 → **会返回错误答案（已实测）**

- **实测复现** `[A]`（本地假上游 + 同一段 messages 连发两次）：

  ```
  [b] 请求1(带 tools)   -> ANSWER_FOR_CALL_2 | X-Cache = null
  [b] 请求2(不带 tools) -> ANSWER_FOR_CALL_2 | X-Cache = HIT
  [b] 上游实际被调用次数 = 1 | 第二次请求命中的是上一次（带 tools）的答案 = true
  ```

  即：**一次带 function calling 的请求，会把答案缓存给后续不带工具的普通请求**，用户拿到的是为另一种上下文生成的回答。
- **代码** `[B]`：`cache-manager.js:33` 只把 `temperature, max_tokens, top_p, frequency_penalty, presence_penalty, stream` 纳入 key，**`tools`/`tool_choice`/`response_format`/`seed`/`logprobs`/`n`/`stop` 全部缺失**。
- 缓存无 TTL、无持久化（进程内 LRU 200 条/100MB，`cache-manager.js:8`），重启即空；任何源文件变化触发 **整表 clear**（`cache-manager.js:68-72`）→ 开发期持续抖动、命中率趋零。
- **影响**：这不是“省钱的 bug”，而是**正确性 bug**——静默给出错误答案比报错更伤用户信任；同时相对竞品（语义缓存/Redis 持久缓存/前缀缓存）在能力上也是代差。

### 3.2 P1：工程能力缺口

| # | 缺陷 | 证据 | 影响 | 对标基线 |
|---|------|------|------|----------|
| **P1-1** | 流式链路无超时/无中断/无客户端断开处理 | `[B]` `router.js:193-249`：无 `AbortController`、无 `req.on('close')`、上游 `error` 时若已发 header 就静默 `res.end()`（客户端看到被截断的 HTTP 200） | 用户取消请求后上游仍继续生成并计费；截断无信号，客户端误判成功 | 网关普遍支持 cancel/超时/半开连接回收 |
| **P1-2** | 重试策略贫弱、无降级 | `[B]` `forwarder.js:72-88`：仅对 `ECONNRESET/ETIMEDOUT/EPIPE/ECONNABORTED` 重试 2 次；**不重试 429/5xx**；无 jitter/无上限退避；无 provider fallback、无熔断、无并发/限流控制；POST 无幂等键（连接级重试可能重复计费） | 上游抖动即失败；429 直接透传给客户端 | LiteLLM/Portkey 的 fallback、路由与限流是标配 |
| **P1-3** | 协议兼容面窄 | `[B]` `router.js:7-11` 白名单仅 8 条 OpenAI 路径，缺 `/v1/responses`（Codex CLI/新 SDK 默认）、`/v1/messages`（Claude Code/Anthropic 原生）、`/v1/files`、`/v1/batches`；`provider-registry.js:6` 声明 Google `format:'gemini'` 但 `router.js` **从不使用 `format`**，且 base_url `.../v1beta` 缺 OpenAI 兼容段（应为 `.../v1beta/openai`）→ Google 实际不可用；Anthropic 走 OpenAI 兼容层（官方为 beta 且字段受限） | 主流客户端（Claude Code、Codex CLI）无法接入；Google 用户直接踩空 | `[C-索引级]` LiteLLM 明确支持原生 `/v1/messages` 与 `/v1/responses` 透传（<https://docs.litellm.ai/docs/anthropic_unified/native_passthrough>），[LM Studio 亦提供 `/v1/responses`](https://lmstudio.ai/docs/app/api/endpoints/openai)。**注意**：LiteLLM 自己在该端点上也有一致性问题（issue #27518、#37508），说明多协议全兼容工程代价高，建议先透传、不要急着做双向转换 |
| **P1-4** | 数据层脆弱 + 并发丢数据 | `[A]` 实测：两个 `TokenMonitor` 先后启动、各自记账，先关闭者写盘的数据被后关闭者的内存快照**整体覆盖**——落盘后只剩 `["provider-B"]`，`provider-A` 的记录消失。`[B]` `token-monitor.js:59-66` 每 5s 把 `db.export()` 全量 `writeFileSync` 重写整库（非原子、崩溃可损坏、库越大越阻塞 Electron 主进程）；`requests` 表无索引、无保留/归档策略；`main.js:187-192` 与 CLI `stats` 都会新建实例 | GUI 与 CLI 同时使用、或重复启动应用时统计丢数据；长期运行卡顿 | 生产网关写入 WAL 模式数据库 + 异步批量写 + 保留策略 |
| **P1-5** | 单实例与并发 | `[B]` 全仓库无 `requestSingleInstanceLock()`（grep 证据）：重复启动会出现两个托盘、两次抢 `12306` 端口、两份 DB 写入 | 数据损坏与用户困惑 | 桌面应用的标准做法 |
| **P1-6** | 密钥明文 + 全量暴露给渲染进程（**严重度：Critical**） | `[B]` `main.js:48-66` 明文 YAML 存 `%APPDATA%`；`preload.js:5` `getConfig()` 把含所有 `api_key` 的完整配置交给渲染进程；`main.js:6-9` 全局关闭 sandbox（`no-sandbox`/`disable-setuid-sandbox`/`disable-gpu-sandbox`） | 任何渲染层代码缺陷都可演化为 Key 泄漏；`[C]` Electron 官方 Security Checklist 把“Enable process sandboxing”单列一条，并明确 `--no-sandbox` “will disable the sandbox for **all** processes … never in production”；`safeStorage`（DPAPI）的边界是“挡得住同机其他用户，**挡不住同一用户空间的其他应用**”，而后者正是关沙箱后的主威胁模型 | 删除三行开关、显式 `sandbox: true`；密钥改 `safeStorage` 或 Windows 凭据管理器（**keytar 已于 2022-12-15 归档，不要采用**） |
| **P1-7** | 无导航守卫 | `[B]` 无 `will-navigate`/`setWindowOpenHandler`（grep 证据）；`index.html:7` CSP `connect-src 'self' https: http:` 允许任意域外连。日志渲染有 `escapeHtml` 转义（`renderer.js:257,269`），**未发现现成 XSS 路径** | 一旦出现可导航/注入点，配合 preload 暴露的 API 即可外传密钥 | Electron 清单要求禁用/收窄导航与 window.open |
| **P1-8** | 可选关闭 TLS 校验（中间人风险开关） | `[B]` `forwarder.js:11-15,56-61` 定义了 `insecureHttpsAgent`（`rejectUnauthorized: false`），只要 provider 配置里写 `tls.reject_unauthorized: false` 即启用，且 UI/文档没有任何安全提示 | 用户（或被篡改的配置）一旦打开，API Key 与全部对话可被中间人截获 | 生产网关不应提供此类开关，或必须强制警告 + 显式二次确认 |
| **P1-9** | 运行时已停止支持（**严重度：Critical**） | `[C]` `package.json` 锁 `electron ^28`，而 **Electron 28 于 2024-06-10 EOL**（末版 28.3.3 / Chromium M120），当前稳定版 44.4.5；已知 “context isolation bypass via `Function.prototype.bind` hijack”（CVE-2026-70601 / GHSA-h7rp-cf8h-j98x，CVSS 7.5）原文写明“**In renderers without a sandbox, or with nodeIntegration enabled, this may escalate to Node.js access**”，修复版本 ≥39.8.9；另有 contextBridge 原型污染公告 GHSA-ff2p-hmqr-hxm4 | ContextGate **同时满足“全局关沙箱 + 版本低于所有已知修复”两个条件**：渲染进程一旦被注入，无需沙箱逃逸即可以用户身份读写文件、外任意网络 | 升级到受支持的大版本（并配合 Electron 官方升级指引处理 breaking changes），这是所有安全修复的前置条件 |

### 3.3 P2：分发、体验、工程卫生与生态位

| # | 缺陷 | 证据 | 说明 |
|---|------|------|------|
| **P2-1** | 产物**未签名**（实测） | `[A]` `Get-AuthenticodeSignature`：`dist\win-unpacked\ContextGate.exe`、`dist\ContextGate Setup 5.3.1.exe`、`dist\ContextGate 5.3.1.exe` 全部 `NotSigned`；`package.json:75-98` 无 `certificateFile`/`cscLink` 配置 | 用户会看到 SmartScreen/杀软告警，直接劝退；企业环境无法落地 |
| **P2-2** | 无自动更新 | `[B]` 无 `electron-updater` 依赖/代码；README 让用户手动下载新 exe（`README.md:48-50`） | LM Studio/Ollama 等竞品均内置更新通道 |
| **P2-3** | 体积/内容不精简 | `[A]` 安装包 151MB、asar 23.8MB、解包 exe 176MB；dist 内并列 5.2.8/5.2.9/5.3.1 三套历史产物 | 体积有优化空间（死代码、去重、`files` 过滤、按架构分包） |
| **P2-4** | 可观测性为零 | `[B]` 无 `/metrics`、无 OpenTelemetry、无 JSONL 请求日志（`requests` 表只存聚合数字，不存 prompt/response）、无 CSV/JSON 导出 | 无法接入 Langfuse/Helicone/Prometheus 生态；出问题无法回溯 |
| **P2-5** | 版本与仓库卫生 | `[A]` `package.json:3` = 5.5.0，而 `dist` 最新产物为 **5.3.1**；`README.md:8` 徽章 5.5.0；`contextgate.db` 仍被 git 跟踪（表为空，`[A]` sql.js 实测）；`.npmrc` 使用已废弃的 `electron_mirror`/`electron_builder_binaries_mirror`（npm 已告警）；工作区存在 `.claude/settings.local.json`（未跟踪，仅被全局 gitignore 忽略，仍建议显式写入 `.gitignore`）；无 `.github/`（CI 曾存在但被删除，见 `git log`: "ci: 删除过时的GitHub Actions构建工作流"） | 版本可信度与自动化缺失 |
| **P2-6** | 死代码 / 双份实现 | `[A]` grep 证明 `lib/ui/app.js`（18.7KB）、`lib/ui/toast.js`、`lib/core/service-container.js` 无人引用；`index.html:344` 只加载 `renderer.js`，与 `lib/ui/app.js` 是两份平行实现（同样的设置面板逻辑各写一遍） | 维护成本翻倍、缺陷容易只修一份 |
| **P2-7** | 测试盲区 | `[A]` 46 个单测全部通过（`node test/*.test.js` 逐个运行：monitor 13、proxy 21、scanner 12），但**全是纯函数级**；无 `router`/`proxy-server`/`token-monitor`/流式的集成测试 | §3.1 的 P0 问题恰好全部落在测试盲区里 |
| **P2-8** | 平台与 i18n | `[B]` 仅 Windows（`README.md:18,42`，Linux/macOS 暂停）；UI 文案硬编码中文（`index.html`/`renderer.js`），虽有 `get-locale` IPC 但无 i18n 实现；README 中英双语而软件界面无英文 | 与竞品的跨平台/容器化部署面差距明显 |
| **P2-9** | 生态位被上下夹击 | `[C]` 中文区 One API/New API 覆盖聚合+分发+计费+多用户；国际上 LiteLLM/Portkey/Cloudflare 覆盖网关能力；上下文侧 Repomix/gitingest/aider/Cursor 覆盖打包与检索 | ContextGate 当前没有一项能力是同类第一，唯一差异是“桌面 + 托盘 + 本地无部署” |
| **P2-10** | 无反馈与安全披露渠道 | `[C]` GitHub Issues `totalCount: 0` 且页面显示 “**Issue creation is restricted in this repository**”，README 却把 Issues 列为报告渠道（`README.md:200`）；无 `SECURITY.md`、无隐私/数据流向说明 | 用户遇到 P0-1 这类问题无处反馈；研究者无法负责任披露；企业采购缺合规材料 |
| **P2-11** | 发布与代码长期脱节 | `[C]` tag 与 `package.json` 已到 **v5.5.0**，但最新 Release 是 **v5.2.9（2026-05-27）**，且 5.2.9 的资产文件名仍是 `ContextGate.5.2.8.exe`；20 个 Release 全部资产**累计下载 31 次**，仓库 **1 star / 0 fork** | 用户拿不到最新代码对应的产物；“下载量 31”说明当前分发完全没形成正循环，任何功能投入都会被这个瓶颈吃掉 |

---

## 4. 差距矩阵（ContextGate vs 市场基线）

| 能力 | ContextGate 现状 | 市场基线（2025–2026） | 差距 |
|------|-----------------|----------------------|------|
| 请求体/长上下文 | **100KB 上限，实测 413** | 可配置、支持大 body 透传 | 🔴 阻断 |
| 本地服务鉴权 | 无（实测 200 匿名可访问） | 虚拟 Key / master key / 本地 token + Host 校验 | 🔴 严重 |
| 上下文注入请求 | 未实现（只算 hash） | 自动检索注入（Cursor/Continue/aider）或明确产出可粘贴文件（Repomix） | 🔴 定位断层 |
| 上下文预算与选择 | 无裁剪、字典序、配置项空转 | token 预算内按相关性排序/符号图/检索 | 🔴 严重 |
| 增量更新 | 仅启动时重建，watch 未实现 | 文件监视/哈希增量/索引增量 | 🔴 严重 |
| 响应缓存 | 进程内 LRU、无 TTL、key 漏参数 | Redis/语义缓存、TTL、前缀缓存 | 🟠 大 |
| Prompt Caching 利用 | 未使用 | Anthropic `cache_control` / OpenAI 自动前缀缓存 | 🟠 大（**这是降本最大杠杆**） |
| 成本追踪准确性 | 流式恒 0、定价表硬编码 | 官方价格目录 + usage 归一化 + 缓存折扣 | 🔴 严重 |
| 预算/告警/拦截 | 无 | 预算 + 阈值告警 + 熔断 | 🟠 大 |
| 协议兼容 | 8 条 OpenAI 路径；Google 不可用；无 responses/messages | OpenAI/Anthropic/Gemini 原生 + 兼容 | 🟠 大 |
| 流式可靠性 | 无取消/超时/错误信号 | cancel、超时、半开回收 | 🟠 大 |
| 重试/降级/限流 | 4 种网络错误重试 | fallback、熔断、限流、幂等 | 🟠 大 |
| 可观测/导出 | 无 | OTel/Prometheus/看板/导出 | 🟠 大 |
| 多用户/多 Key | 无 | 虚拟 Key、团队、配额 | 🟡 中（单机可豁免） |
| 密钥安全 | 明文 + 暴露给渲染层 | safeStorage/DPAPI/系统钥匙串 | 🟠 大 |
| 运行时支持状态 | Electron 28（**2024-06-10 EOL**）+ 全局关沙箱 | 受支持版本 + 沙箱开启 | 🔴 严重（含已知 CVE 未修） |
| 用户反馈/安全披露 | Issue 创建受限、无 `SECURITY.md`、无隐私说明 | 公开 issue + 披露政策 + 数据流向说明 | 🟠 大 |
| 分发 | 未签名、手动更新、150MB | 签名 + 自动更新 | 🟠 大 |
| 跨平台 | Windows only | 多平台 / Docker / K8s | 🟡 中（可选战略） |
| 测试/CI | 纯单测、无 CI | 集成/契约/性能测试 + CI | 🟠 大 |

---

## 5. 后期修复计划（Roadmap）

> 约定：每项含**目标 / 改动点 / 验收标准 / 工作量(人日) / 风险**。工作量按单人熟悉该仓库后估算，仅供参考。

### P0 — 让产品“能用且不骗人”（建议 8–12 人日，1–2 周）

#### FIX-01 解除 100KB 请求体限制，并返回结构化错误
- **目标**：任意合理大小的请求可透传（默认 32MB，可配置），超限时返回 OpenAI 风格 JSON 错误。
- **改动点**：
  - `lib/proxy/router.js:16` 改为 `express.json({ limit: config.proxy.max_body_size || '32mb' })`（或按内容类型分别处理）；
  - 注册统一错误中间件：`PayloadTooLargeError` → `413 {error:{message,type:'invalid_request_error',code:'request_too_large'}}`；其它解析错误 → 400 JSON；
  - 同步放开 `express.json` 之外的路径（`/proxy/chat` 同样受益）；
  - 文档与 `config.yaml.example` 增加该配置项。
- **验收标准**：新增集成测试：1KB/300KB/8MB 请求分别返回预期（前两者到上游或 401，8MB 在 32MB 限额内同样不 413）；超 32MB 返回 **JSON 413** 且能被 OpenAI SDK 解析。
- **工作量**：0.5–1 人日。**风险**：内存放大（需配合流式/临时文件策略，见 FIX-15）。

#### FIX-02 本地代理鉴权 + 来源校验
- **目标**：默认只有知道本地令牌的客户端能用；浏览器/DNS rebinding 拿不到。
- **改动点**：
  - 首次启动生成随机 `local_token`（写入 `config.yaml`，UI 可查看/重置/复制）；
  - 中间件校验 `Authorization: Bearer <local_token>` 或 `X-ContextGate-Token`；`/health` 可豁免；
  - 校验 `Host` 头 ∈ `{127.0.0.1:port, localhost:port, [::1]:port}`（DNS rebinding 防护，`[C]` 该缓解手段见 Jackson et al. CCS'07 <https://crypto.stanford.edu/dns/>）；拒绝带 `Origin`/`Referer` 的跨站请求（`[C]` WICG PNA 明确 CORS 防不住、请求本身就是攻击 <https://github.com/WICG/private-network-access/blob/master/explainer.md>）；
  - 给 `/stats`、`/context/hash`、`DELETE /cache`、`/providers*` 全部加上鉴权；
  - `X-Target-Base-Url` 增加开关（默认关）与 scheme/私网地址校验，或直接改为服务端 provider 白名单；
  - `proxy.host` 默认锁死回环，改成 `0.0.0.0` 时给出“会暴露给局域网”的强提示；
  - README/快捷配置片段（Cursor/Continue/Cline/Claude Code）同步带上令牌。**对标** `[C]` LM Studio 就是“默认关闭、可在设置里按权限签发 API Token”的做法（<https://lmstudio.ai/docs/developer/core/authentication>）。
- **验收标准**：匿名访问全部受保护端点 → 401；`Host: evil.com` → 403；带正确令牌 → 200；新增单测覆盖 Host 校验矩阵。
- **工作量**：1.5–2 人日。**风险**：老用户升级后配置需更新（提供兼容开关 `auth.enabled`，默认开启但给出显著提示）。

#### FIX-03 明确并打通“上下文”的产品路径（二选一，建议 B + 少量 A）
- **方案 A（注入式）**：代理按会话/请求注入选定的上下文片段（稳定前缀 + 排序 + hash），真正实现“代理即上下文网关”。工作量大、语义复杂。
- **方案 B（产物式 + 工具化）**：
  - 强化产物：多格式输出（Markdown/XML）、`--include/--exclude`、per-file token 排序、**剔除输出文件自身**、写入 `.contextgateignore`；
  - 提供 **MCP server**（`[C]` MCP 已是事实标准：<https://modelcontextprotocol.io/>），把 `build_context`、`list_files`、`search` 暴露给任何支持 MCP 的客户端——这是 2025-2026 年“被 AI 工具用起来”的最低成本路径；
  - UI 增加“一键复制上下文”“导出 manifest（含每文件 token/字符）”。
- **验收标准**：Cursor/Claude Code 通过 MCP 能列出并读取上下文；产物可一键复制；二次构建不再包含自身。
- **工作量**：方案 B 3–5 人日（含 MCP server）。**风险**：MCP 协议演进较快，需锁定版本。

#### FIX-04 成本与预算：让数字可信、让阈值生效
- **目标**：流式与非流式请求都能得到正确 usage 与成本；预算达到阈值会告警、可选拦截；缓存读写 token 与“节省”金额可核算。
- **改动点**：
  - 请求侧注入 `stream_options: { include_usage: true }`（仅对 OpenAI 兼容且未显式设置时），并兼容“usage 出现在任意 chunk/`x-ratelimit`/响应头”的解析；
  - 成本改为“**models.dev 价格目录优先 + 本地覆盖表兜底**”，按 provider+model 精确匹配、支持日期后缀归一化；未知模型在 UI 明确标记“价格未知”，**不要静默记 0**；
  - 建模缓存读/写折扣与推理 token。`[C]` 官方口径可作公式依据：OpenAI 缓存读取约 **0.1×** 未缓存输入价、缓存写入 **1.25×**（GPT-5.6+），并建议直接统计 `usage.input_tokens_details.cached_tokens` / `cache_write_tokens`（<https://platform.openai.com/docs/guides/prompt-caching>）；
  - 预算判定接入 `request:complete`（累计今日/本月成本 vs `budget_limit`，`warning_threshold`/`critical_threshold` 触发 UI 通知；critical 可选拒绝新请求返回 402/429）。`[C]` 行业做法是“**到额即拒**”的硬约束而非只统计（LiteLLM 的 budgets/rate limits）；
  - 修正 UI 口径：「今日成本」与「今日节省」分离，节省 = 精确缓存命中 + Prompt Caching 命中带来的差额；命中率分母修正为“总请求数”。
- **验收标准**：流式请求能记录非 0 token/成本；`claude-3-5-sonnet-20241022` 能算出价格；设 `budget_limit=0.01` 后第 N 个请求触发阈值告警（并有测试覆盖）。
- **工作量**：2–3 人日。**风险**：部分上游不支持 `stream_options`（需按 provider 开关 + 失败降级）。

#### FIX-05 上下文预算真正生效 + 前缀稳定性
- **目标**：`context.max_tokens` 生效；上下文可被 Prompt Caching 复用。
- **改动点**：
  - 在 `scanner.buildContext` 中按 token 预算裁剪：先按“相关性/最近修改/大小/被引用次数”排序，超预算时降级为“文件摘要（signature/导出符号）+ 头部若干行”，生成 `manifest` 记录被裁掉的文件。`[C]` 参考 aider：预算用 `--map-tokens` 控制、默认仅 **1k tokens**，选择依据是 tree-sitter + 图排序（<https://aider.chat/docs/repomap.html>）；参考 Repomix：提供逐文件 token 计数、`--compress`（约减 70%）与 Secretlint 凭据扫描（<https://github.com/yamadashy/repomix>）；
  - 去掉 `scanner.js:84` 的 `# Generated: <ISO 时间>`（或移入独立 manifest），**保证前缀字节稳定**。`[C]` 这是官方明文要求：“If developer instructions or shared material contain **timestamps** … place those at the end rather than the beginning”（<https://platform.openai.com/docs/guides/prompt-caching>）；
  - 支持 `.contextgateignore`、嵌套 `.gitignore`、`.env*` 默认排除、简单 secret 正则告警；
  - 明确排除输出文件自身。
- **验收标准**：给定 `max_tokens=8000`，产物的估算 token ≤ 预算；连续两次构建（源码未变）除 manifest 外**字节完全一致**；生成的上下文能命中 prompt cache（`[C]` 用 `cached_tokens` / `cache_write_tokens` 与 cache hit rate 验证，且需注意最小可缓存前缀为 **1,024 token**，见官方指南）。
- **工作量**：2–3 人日。**风险**：相关性排序引入主观性，需保留“全量模式”开关。

#### FIX-06 缓存正确性修补（最小可用版）
- **目标**：不再返回“参数不符”的缓存响应。
- **改动点**：`cache-manager.js:33` 的 `paramKeys` 加入 `tools, tool_choice, response_format, seed, logprobs, n, stop, parallel_tool_calls, reasoning_effort`；改为对“影响输出的全部字段”做规范化 hash（白名单式列出不参与缓存的字段更安全）；加 TTL（默认 0 = 关闭缓存或 1h 可配）；UI 显示当前缓存命中/总请求。
- **验收标准**：新增单测：同 messages 不同 `tools` → 不同 key；不同 `n` → 不同 key。
- **工作量**：0.5–1 人日。**风险**：命中率下降（正确性优先）。

#### P0+（安全 Critical，建议与 P0 并行、不占用 P0 的验收口径）

| 编号 | 任务 | 要点 | 验收 | 人日 |
|------|------|------|------|------|
| **FIX-S1** | **升级 Electron 并恢复沙箱** | 现状是 Electron 28（2024-06-10 EOL，低于所有已知修复版本 ≥39.8.9）+ `main.js:6-8` 全局 `no-sandbox`。动作：① 删除 `no-sandbox`/`disable-setuid-sandbox`（GPU 问题只保留必要的 GPU 相关项）；② 在 `webPreferences` 显式 `sandbox: true`；③ 升级到受支持大版本并处理 breaking changes；④ 加 `will-navigate` / `setWindowOpenHandler` 白名单 | 无 Electron 安全告警；`process.sandboxed === true`；导航白名单测试通过 | 3–5 |
| **FIX-S2** | 移除/强提示 TLS 校验开关 | `forwarder.js` 的 `insecureHttpsAgent` 默认不可达，或在 UI 中给出“这会泄露你的 Key”级别警告并要求二次确认 | 配置项默认关闭且有测试覆盖 | 0.5 |
| **FIX-S3** | 补最小安全与反馈基建 | 增加 `SECURITY.md`（漏洞披露路径）、README 数据流向/隐私说明、开放 Issue 渠道（当前仓库显示 “Issue creation is restricted”）；崩溃上报与遥测默认关闭且明示 | 用户有可用的漏洞上报与问题反馈入口 | 1 |

### P1 — 补齐网关工程能力（建议 20–30 人日，2–6 周）

| 编号 | 任务 | 要点 | 验收 | 人日 |
|------|------|------|------|------|
| **FIX-07** | 流式可靠性 | `AbortController` + `req.on('close')` 中止上游；上游/下游超时；已发 header 后错误以 SSE error 事件或关闭连接表达（不再静默 200）；`X-Accel-Buffering`/keep-alive 语义校准 | 客户端取消后 1s 内上游连接关闭；上游中断时客户端能识别失败 | 3–4 |
| **FIX-08** | 重试/降级/限流 | 429/5xx 指数退避重试（带 jitter、尊重 `Retry-After`）；provider fallback 链；熔断；本地并发上限与队列；幂等键（客户端 `Idempotency-Key` 透传） | 429 场景下自动重试/切换成功；单 Key 并发不超配 | 4–6 |
| **FIX-09** | 持久化缓存 | 落盘（SQLite/文件）+ TTL + LRU 淘汰 + 容量上限；可选语义缓存（embedding 相似度）开关；缓存统计与清理策略；避免“任何文件变化就全清” | 重启后缓存仍可用；TTL 生效；源码变更只失效相关条目 | 4–6 |
| **FIX-10** | Prompt Caching 支持 | Anthropic 自动注入 `cache_control`（system/工具/上下文前缀）；保证前缀稳定；统计 cache 读/写 token 与节省金额；OpenAI 侧保证前缀不变以命中自动缓存 | 长会话第二次请求可观察到 cache_read 命中并计入节省 | 3–5 |
| **FIX-11** | 协议兼容扩展 | 透传 `/v1/responses`、`/v1/messages`（或做 Anthropic↔OpenAI 双向转换）、`/v1/files`、`/v1/batches`；修正 Google（`.../v1beta/openai` 或原生 `generateContent`）；multipart/audio 透传（不走 `express.json`） | Claude Code / Codex CLI / Gemini SDK 各跑通一个真实用例 | 5–8 |
| **FIX-12** | 数据层重做 | 迁移到 `better-sqlite3`/`node:sqlite` + WAL + 增量写入（不再全量 export）；加索引；请求级日志（脱敏）与保留策略/归档；`requestSingleInstanceLock()` | 10 万行下 `getSummary` < 100ms；双开不冲突 | 4–6 |
| **FIX-13** | 密钥与 IPC 安全 | `safeStorage`（Windows DPAPI）加密存储 Key；`get-config` 对渲染进程脱敏（返回掩码 + `has_key`），保存走专用 IPC；渲染层最小权限 | 配置文件中无明文 Key；渲染层拿不到明文 | 3–4 |

### P2 — 拉近市场基线（建议 25–40 人日，6–12 周）

| 编号 | 任务 | 要点 | 验收 | 人日 |
|------|------|------|------|------|
| **FIX-14** | Electron 安全硬化 | 移除 `no-sandbox` 等开关（或至少不再全局关闭）；`will-navigate`/`setWindowOpenHandler` 白名单；CSP 收紧 `connect-src` 到回环+必要域名；依赖审计（npm audit） | Electron 安全检查清单通过；无 sandbox 告警 | 3–5 |
| **FIX-15** | 大 body 与内存策略 | 超过阈值改走流式透传（不整体 buffer）；限制并发大请求 | 8MB 请求内存增量 < 2× 体积 | 2–3 |
| **FIX-16** | 分发与更新 | 代码签名（EV/OV 证书）+ SmartScreen 声誉；`electron-updater` 差量更新 + 更新通道（stable/beta）；体积优化（去死代码、去重、按架构分包） | 安装包无 SmartScreen 红警告；旧版本可收到更新 | 5–8 |
| **FIX-17** | 可观测与导出 | 可选 OpenTelemetry/Prometheus 暴露；JSONL 请求日志（脱敏）；CSV/JSON 导出；与 Langfuse/Helicone 的接入文档 | 能用 Grafana/Langfuse 看到请求与成本 | 5–8 |
| **FIX-18** | 跨平台与无头模式 | 恢复 Linux/macOS 构建；提供 headless CLI/Docker（无 GUI 的纯网关） | Linux 容器内可运行并跑通集成测试 | 5–8 |
| **FIX-19** | 工程基建 | 恢复 CI（lint + 单测 + 集成测试 + 打包）、集成/契约测试（HTTP 层、流式、缓存）、性能基线、发布流程与版本一致性校验、清理死代码（`lib/ui/*`、`renderer.js` 与 `lib/ui/app.js` 二选一）、仓库卫生（移除 `contextgate.db`、把 `.claude/` 显式写入 `.gitignore`、更新 `.npmrc`） | CI 全绿；版本号在 package/README/dist 一致；无未引用模块 | 5–8 |

### 建议的发布节奏

| 版本 | 内容 | 出口标准 |
|------|------|---------|
| v5.6（补丁） | FIX-01/02/04/06 | 大上下文可用、有鉴权、数字可信 |
| v5.7 | FIX-05/03/07 | 上下文预算 + MCP、流式可靠 |
| v6.0 | FIX-08/09/10/11/12/13 | 具备“网关”资格的完整一轮 |
| v6.x | P2 全部 | 可与开源网关在能力表上同台比较 |

---

## 6. 应当保留的优势（修复时不要削掉）

1. **零部署桌面形态**：托盘常驻、双击即用，对不想装 Docker/配 Python 的个人开发者（尤其国内用户）确实是差异化。`[B]`
2. **本地优先的隐私叙事**：请求不经过第三方中转（除用户自己配置的 provider），且 `127.0.0.1` 绑定是正确默认。`[B]`
3. **同时有 GUI 与 CLI**（`cli.js` 提供 build/serve/stats/scan）——竞品里桌面 GUI + CLI 双形态并不常见。`[B]`
4. **models.dev 目录接入**（`models-dev.js`）已经有正确方向：把它从“只用来列模型”升级为“价格与上下文窗口的单一数据源”成本很低、收益很高。`[B]`
5. **已有的正确细节**：`joinUrl` 的斜杠归一化、`isPlaceholderKey` 占位符识别、SSE 的 CRLF 兼容、`escapeHtml` 转义、`resolveApiKey` 的显式错误返回——说明作者有能力写正确的边界处理，问题是覆盖面。`[A][B]`

---

## 7. 不建议做的事（避免资源错配）

1. **不要为了“像 LiteLLM”而去做多租户/团队/计费**：单机桌面软件的护城河不在那儿，投入产出比极低。调研结论同样是：虚拟 key、团队配额、审计日志需要集中式控制面与持久化用户体系，而单机 sql.js 在并发写入与多用户场景上是**结构性短板**。`[D]`（支撑见 [llm-gateway-competitive-research.md](llm-gateway-competitive-research.md)）
2. **不要在未修复 P0-1/P0-2 之前做 UI 美化或新增 provider**：现在是“地基没打好就装修”。`[D]`
3. **不要继续维护两份渲染层实现**（`renderer.js` 与 `lib/ui/app.js`）：先合并再演进。`[A]`
4. **不要用“语义缓存”当第一个缓存方案**：先把精确缓存 key 修对、把 Prompt Caching 打通，收益更大、风险更小；语义缓存需要向量库/嵌入模型与常驻服务，桌面端内存与冷启动都不友好，属于“结构性难满足”项。`[C][D]`
5. **不要承诺 Linux/macOS 的具体时间**：README 已经声明暂停（`README.md:18`），在 CI 与签名体系建立前不要回补，避免再次出现“删 Rust 代码”式的反复（`git log`: 项目曾尝试转 Rust 又移除）。`[A]`
6. **不要做集群/高可用/插件市场**：那是 Kong/APISIX/Bifrost 的赛道；单机进程天然缺失，且会稀释“桌面一键可用”这个唯一优势。`[C][D]`

---

## 8. 验收与回归测试建议（针对上述缺陷）

| 测试 | 类型 | 覆盖的缺陷 |
|------|------|-----------|
| 大 body 透传（1KB/300KB/8MB/超限） | HTTP 集成 | P0-1 |
| 匿名/错误 token/Host 头/Origin 头访问矩阵 | HTTP 集成 | P0-2、FIX-02 |
| 流式请求最终 usage 非 0 且成本 > 0 | HTTP 集成（本地假上游 SSE） | P0-5、FIX-04 |
| 相同 messages + 不同 `tools`/`n` 不共享缓存 | 单元 + 集成 | P0-6、FIX-06 |
| 上下文预算裁剪 + 二次构建字节稳定 | 单元 | P0-4、FIX-05 |
| 客户端取消后上游连接被中止 | 集成（假上游记录连接状态） | P1-1 |
| 429/5xx 重试与 fallback | 集成 | P1-2 |
| 双实例启动 / 双写数据库 | 集成 | P1-4、P1-5 |
| 配置文件中不出现明文 Key | 集成 + 文件断言 | P1-6、FIX-13 |
| 客户端断开后进程内存不增长 | 压测 | P0-1、FIX-15 |

---

## 附录 A：引用来源

**本文档的支撑材料（同目录 / 同工作区）**

- 网关类竞品逐项来源表：[llm-gateway-competitive-research.md](llm-gateway-competitive-research.md)（含 12 个产品能力对比、每条结论的来源链接与“未证实”标注）
- 安全与产品体验调研原始报告（含 24 条外部来源链接与完整证据链，已被本文第 3 章吸收）：[security-and-product-research.md](security-and-product-research.md)

**本次调研直接抓取并逐段核对的一手原文（Firecrawl / Node fetch）**

- OpenAI Prompt Caching 指南：<https://platform.openai.com/docs/guides/prompt-caching>
- Anthropic《Effective context engineering for AI agents》：<https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- Chroma《Context Rot》：<https://research.trychroma.com/context-rot>
- aider repo map：<https://aider.chat/docs/repomap.html>
- Repomix：<https://github.com/yamadashy/repomix>
- gitingest：<https://gitingest.com/>、<https://github.com/cyclotruc/gitingest>
- Cursor 语义检索：<https://cursor.com/blog/semsearch>
- Cline 上下文管理：<https://docs.cline.bot/prompting/context-management>；Roo Code codebase indexing：<https://docs.roocode.com/features/codebase-indexing>；Sourcegraph Cody context：<https://sourcegraph.com/docs/cody/capabilities/context>
- LM Studio：<https://lmstudio.ai/docs/app/api/endpoints/openai>、<https://lmstudio.ai/docs/developer/core/authentication>、<https://lmstudio.ai/docs/app/offline>
- Ollama：<https://docs.ollama.com/faq>、<https://docs.ollama.com/api/openai-compatibility>
- Claude Code 成本与用量：<https://docs.claude.com/en/docs/claude-code/costs>；Cursor Usage：<https://docs.cursor.com/en/account/usage>
- ccusage：<https://github.com/ryoppippi/ccusage>；Sniffly：<https://github.com/chiphuyen/sniffly>
- Microsoft SmartScreen：<https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/>
- WICG Private Network Access：<https://github.com/WICG/private-network-access/blob/master/explainer.md>；DNS rebinding（CCS'07）：<https://crypto.stanford.edu/dns/>
- Electron Security / Sandbox / safeStorage：<https://www.electronjs.org/docs/latest/tutorial/security>、<https://www.electronjs.org/docs/latest/tutorial/sandbox>、<https://www.electronjs.org/docs/latest/api/safe-storage>
- Electron 生命周期（28 已 EOL）：<https://endoflife.date/electron>
- Electron 安全公告：<https://github.com/electron/electron/security/advisories/GHSA-h7rp-cf8h-j98x>、<https://github.com/electron/electron/security/advisories/GHSA-ff2p-hmqr-hxm4>
- keytar 已归档：<https://github.com/atom/node-keytar>
- ContextGate 仓库页 / Releases / Issues / Commits：<https://github.com/2048lr/ContextGate>

**本地实测（A 级）**

- 仓库源码与产物：`C:\Users\Admin\ContextGate`（`git log` 最新提交 `2bd14aef docs: 更新 readme.md文件`）
- 关键文件：`app/gui-js/lib/proxy/router.js`、`app/gui-js/lib/proxy/cache-manager.js`、`app/gui-js/lib/proxy/forwarder.js`、`app/gui-js/lib/proxy/provider-registry.js`、`app/gui-js/lib/monitor/token-monitor.js`、`app/gui-js/lib/monitor/cost-calculator.js`、`app/gui-js/lib/scanner/scanner.js`、`app/gui-js/lib/scanner/constants.js`、`app/gui-js/main.js`、`app/gui-js/preload.js`、`app/gui-js/renderer.js`

**仅索引定位（未逐页核对原文）**

- LiteLLM：<https://docs.litellm.ai/docs/proxy/quick_start>、<https://docs.litellm.ai/docs/proxy/virtual_keys>、<https://docs.litellm.ai/docs/proxy/caching>、<https://docs.litellm.ai/docs/anthropic_unified/native_passthrough>
- Portkey：<https://portkey.ai/docs/product/ai-gateway>；Helicone：<https://docs.helicone.ai/>；OpenRouter：<https://openrouter.ai/docs/quickstart>；Cloudflare AI Gateway：<https://developers.cloudflare.com/ai-gateway/>；Kong AI Gateway：<https://developer.konghq.com/ai-gateway/>；Apache APISIX `ai-proxy`：<https://apisix.apache.org/docs/apisix/plugins/ai-proxy/>；Bifrost：<https://github.com/maximhq/bifrost>；Langfuse：<https://langfuse.com/docs>
- One API：<https://github.com/songquanpeng/one-api>；New API：<https://github.com/Calcium-Ion/new-api>
- Gemini 的 OpenAI 兼容说明（用于核对 `.../v1beta/openai` 这一路径）：<https://ai.google.dev/gemini-api/docs/openai>；Anthropic 的 OpenAI 兼容层（beta）：<https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk>
- “Lost in the Middle”：<https://arxiv.org/abs/2307.03172>；Anthropic Prompt Caching：<https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching>；MCP：<https://modelcontextprotocol.io/>；MCP 相关 CVE：<https://app.opencve.io/cve/CVE-2026-34742>、<https://dependabot.ecosyste.ms/advisories/CVE-2025-66416>

## 附录 B：本次实测命令与结果

> 说明：实测用到的三个临时探针脚本（`.probe/bodylimit.js`、`.probe/usage-and-cache.js`、`.probe/db-clobber.js`）在出具本文档后已删除，避免污染仓库。它们的做法已在下文完整描述，可在 10 分钟内复现：用 `new ProxyServer({...})` / `new TokenMonitor({...})` 直接驱动被测模块，再断言行为。

```powershell
# 1) 请求体上限（结论：300KB → 413 PayloadTooLargeError，返回 HTML）
#    探针做法：起 ProxyServer(127.0.0.1:12399)，provider.base_url 指向 http://127.0.0.1:9/v1（不可达即可，413 早于转发）
#    分别 POST Content-Type: application/json，body 为 1KB 与 300KB 的 {"model":"gpt-4o-mini","messages":[...]}
# 输出：300KB 请求体 -> HTTP 413 text/html; charset=utf-8
#       PayloadTooLargeError: request entity too large

# 2) 匿名访问受保护端点（结论：无鉴权）
# 输出：无 Authorization 头访问 /stats -> 200 {"cacheSize":0,"contextHash":"bf21a9e8...","uptime":1.07}

# 3) 流式用量记账（结论：不注入 stream_options，记账为 0）
#    探针做法：本地假上游 SSE 只发 delta 不发 usage（模拟 OpenAI 默认行为），代理侧监听 EventBus 的 request:complete
# 输出：[a] 上游收到的流式请求 stream_options = undefined
#       [a] 代理记录的用量 = [{"in":0,"out":0,"cost":0}]

# 4) 缓存 key 漏参数（结论：不带 tools 的请求命中带 tools 的缓存，返回错误答案）
#    探针做法：同一段 messages 连发两次——第一次带 tools，第二次不带；假上游每次返回带序号的 marker
# 输出：[b] 请求1(带 tools)   -> ANSWER_FOR_CALL_2 | X-Cache = null
#       [b] 请求2(不带 tools) -> ANSWER_FOR_CALL_2 | X-Cache = HIT
#       [b] 上游实际被调用次数 = 1 | 第二次请求命中的是上一次（带 tools）的答案 = true

# 5) 用量数据库并发写入（结论：后关闭的实例覆盖先关闭实例的数据）
#    探针做法：A、B 两个 TokenMonitor 指向同一 dbPath，各记一笔（provider-A / provider-B），A 先 close、B 后 close，再用第三个实例读取
# 输出：落盘后数据库中的 provider = ["provider-B"]
#       provider-A 的记录是否丢失 = true

# 6) 产物签名（结论：全部未签名）
Get-AuthenticodeSignature 'dist\win-unpacked\ContextGate.exe'      # NotSigned
Get-AuthenticodeSignature 'dist\ContextGate Setup 5.3.1.exe'       # NotSigned
Get-AuthenticodeSignature 'dist\ContextGate 5.3.1.exe'             # NotSigned

# 7) 单测（结论：46 通过，全为纯函数单测）
node test\monitor.test.js   # 13 pass
node test\proxy.test.js     # 21 pass
node test\scanner.test.js   # 12 pass
# 注：npm test 在本沙箱内因 node --test 子进程 spawn EPERM 无法运行（环境限制，非项目缺陷）

# 8) Lint（结论：通过）
npx eslint lib/ cli.js main.js preload.js   # exit 0

# 9) 死代码与关键能力缺失（grep 证据）
#    service-container / ui/app / ui/toast : 无任何引用
#    chokidar / stream_options / include_usage / requestSingleInstanceLock / will-navigate / setWindowOpenHandler / AbortController : 源码中均无命中

# 10) 仓库卫生
git ls-files | Select-String 'contextgate.db'   # 仍被跟踪
Test-Path .github                                # False（无 CI）
Test-Path docs                                   # False（本文档首次创建该目录）

# 11) 上下文腐烂
Select-String -Path full_context.txt -Pattern '^# File: '   # 31 条，含已删除的 lib/scanner.js、lib/config.js 等

# 12) 依赖版本
node -e "console.log(require('express/package.json').version, require('body-parser/package.json').version)"  # 4.22.1 / 1.20.4
```

---

## 附录 C：P0 修复的最小代码草图（可直接作为改动起点）

> 以下为示意实现，用于消除歧义；正式提交请补测试并按项目 ESLint 规则调整。

### C-1 解除 body 限制并返回结构化错误（`lib/proxy/router.js`）

```js
// 替换 router.js:16 的 app.use(require('express').json())
const MAX_BODY = svc.configManager.get('proxy.max_body_size', '32mb')
app.use(express.json({ limit: MAX_BODY }))

// 追加：结构化错误中间件（放在所有路由之后）
app.use((err, req, res, _next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      error: { message: `Request body exceeds limit (${MAX_BODY})`,
               type: 'invalid_request_error', code: 'request_too_large' },
    })
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({
      error: { message: 'Invalid JSON body', type: 'invalid_request_error', code: 'invalid_json' },
    })
  }
  console.error('[router] unhandled error:', err)
  res.status(500).json({ error: { message: 'Internal proxy error', type: 'api_error' } })
})
```

### C-2 本地令牌 + Host/Origin 校验（新增 `lib/proxy/auth.js`）

```js
const crypto = require('crypto')

function ensureLocalToken(configManager) {
  let t = configManager.get('proxy.local_token')
  if (!t) { t = crypto.randomBytes(24).toString('base64url'); configManager.set('proxy.local_token', t); configManager.save() }
  return t
}

function createLocalAuth(configManager) {
  const token = ensureLocalToken(configManager)
  const allowHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])
  return (req, res, next) => {
    // 1) Host 头白名单：防 DNS rebinding
    const host = String(req.headers.host || '').replace(/:\d+$/, '')
    if (!allowHosts.has(host)) return res.status(403).json({ error: { message: 'Invalid Host header', type: 'invalid_request_error' } })
    // 2) 拒绝浏览器跨站发起（带 Origin/Referer）
    if (req.headers.origin || req.headers.referer) {
      return res.status(403).json({ error: { message: 'Cross-site requests are not allowed', type: 'invalid_request_error' } })
    }
    if (req.path === '/health') return next()
    // 3) 令牌校验
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const t = req.headers['x-contextgate-token']
    if (auth !== token && t !== token) {
      return res.status(401).json({ error: { message: 'Missing or invalid local token', type: 'invalid_request_error', code: 'invalid_api_key' } })
    }
    next()
  }
}
module.exports = { createLocalAuth, ensureLocalToken }
```

在 `proxy-server.js` 的 `createRoutes(...)` 之前挂载 `app.use(createLocalAuth(this.configManager))`。

### C-3 缓存 key 规范化（`lib/proxy/cache-manager.js:19-42`）

```js
// 改为“参与缓存的字段白名单”，避免新增参数再次漏掉
const CACHE_KEY_FIELDS = [
  'model', 'messages', 'temperature', 'top_p', 'max_tokens', 'stop',
  'frequency_penalty', 'presence_penalty', 'seed', 'n', 'logprobs', 'top_logprobs',
  'tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'reasoning_effort',
  'stream', 'user',
]
function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}'
  }
  return JSON.stringify(v ?? null)
}
const payload = {}
for (const k of CACHE_KEY_FIELDS) if (body[k] !== undefined) payload[k] = body[k]
const fingerprint = crypto.createHash('sha256').update(stableStringify(payload)).digest('hex').slice(0, 32)
return `${req.method}:${req.path}:${providerKey}:${ctxPart}:${fingerprint}`
```

### C-4 流式 usage 注入与解析（`lib/proxy/router.js:193-249`）

```js
// 注入（仅当上游支持且客户端未显式设置）
const wantsUsage = providerConfig.supports_stream_usage !== false
const upstreamBody = { ...body, model, messages, stream: true }
if (wantsUsage && upstreamBody.stream_options === undefined) {
  upstreamBody.stream_options = { include_usage: true }
}

// 解析：扫描「所有」chunk，取最后一个含 usage 的对象；同时兼容 x-ratelimit 头
let usage = {}
for (const chunk of rawChunks) {
  for (const line of chunk.toString().split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
    try { const j = JSON.parse(line.slice(6)); if (j.usage) usage = j.usage } catch {}
  }
}
const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0
const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0
```

### C-5 预算阈值生效（`lib/monitor/token-monitor.js` + `main.js` 事件订阅）

```js
// token-monitor 增加今日成本查询
async getTodayCost() {
  await this._ensureReady()
  const today = new Date().toISOString().split('T')[0]
  const r = this.db.exec('SELECT total_cost FROM daily_stats WHERE date=?', [today])
  return r.length ? (r[0].values[0][0] || 0) : 0
}

// main.js：request:complete 之后判定
eventBus.on('request:complete', async data => {
  await tokenMonitor.recordRequest(data)
  const cfg = new ConfigManager(cfgPath).getMonitorConfig()
  const spent = await tokenMonitor.getTodayCost()
  const ratio = cfg.budget_limit > 0 ? spent / cfg.budget_limit : 0
  if (ratio >= (cfg.critical_threshold ?? 90) / 100) sendToUI('budget', { level: 'critical', spent, limit: cfg.budget_limit })
  else if (ratio >= (cfg.warning_threshold ?? 75) / 100) sendToUI('budget', { level: 'warning', spent, limit: cfg.budget_limit })
})
// 若要“硬拦截”，在 router.js 入口处读取当前花费，超过 critical 时返回 429/402
```

### C-6 上下文预算与稳定前缀（`lib/scanner/scanner.js:77-102`）

```js
// 1) 头部去掉时间戳，改为写入独立的 manifest 文件（保证前缀字节稳定，配合 Prompt Caching）
const header = ['# ContextGate Context', `# Project: ${this.rootDir}`, `# Files: ${files.length}`, '']
// 2) 按 token 预算裁剪：先按 文件大小升序/最近修改/被引用次数 排序，超预算改用摘要
const budget = this.config.max_tokens || 8000
let used = 0
for (const rel of ranked) {
  const content = await fs.promises.readFile(path.join(this.rootDir, rel), 'utf8')
  const cost = Math.ceil(content.length / 4)
  if (used + cost > budget) { skipped.push(rel); continue }
  used += cost; parts.push(section(rel, content))
}
await fs.promises.writeFile(outputPath, parts.join('\n'), 'utf8')
await fs.promises.writeFile(outputPath + '.manifest.json', JSON.stringify({ generatedAt: new Date().toISOString(), included: included, skipped: skipped, estimatedTokens: used }, null, 2))
// 3) 排除输出文件自身与 manifest
```

---

## 附录 D：结论的置信度自评

| 结论 | 置信度 | 说明 |
|------|--------|------|
| 413 / 无鉴权 / 未签名 / 预算未生效 / 死代码 / 上下文腐烂 | **高** | 均为一手实测或确定性源码证据 |
| 流式 usage 恒 0、cache key 漏参数导致错答、并发写库丢数据 | **高** | 已用本地假上游与双实例探针**实测复现**（附录 B 第 3–5 项） |
| “上下文不参与请求构造”（P0-3） | **高** | 源码可完整推理（`contextFile` 仅用于缓存签名）；尚未用真实 IDE 客户端端到端验证 |
| 上下文策略的行业范式（aider/Repomix/Cursor/Anthropic/Chroma/OpenAI 前缀稳定性） | **高** | 原文已抓取并逐段核对，引用为原文措辞 |
| Electron EOL/CVE、SmartScreen、safeStorage、PNA/DNS rebinding、LM Studio/Ollama 基线 | **中-高** | 原文已抓取；CVE 编号与修复版本来自 Electron 安全公告页面 |
| 仓库现状（1★、31 次下载、Issue 受限、单人 76 提交、无 CI、发布脱节） | **中-高** | 取自 GitHub 页面内嵌 JSON 与本地 git；`api.github.com` 受限，未用 API 交叉验证 |
| 网关类竞品的逐项能力（LiteLLM/Portkey/Kong/…） | **中** | 仅 web_search 索引级来源；star 数为第三方统计站快照，未核实；已写明“未证实”项 |
| 路线图工作量估算 | **低-中** | 单人估算，未做技术设计细化，仅供排期参考 |
