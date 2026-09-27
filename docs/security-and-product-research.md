# ContextGate 安全与产品体验调研报告

> 数据日期 2026-09-27。`web_fetch` 在本环境不可用（域名被解析到非公网 IP 段并遭工具拒绝），改用 Node `fetch` 抓取原始文档与 GitHub 页面；`api.github.com` 已触发匿名速率限制（403），故 star/issue 数据取自页面内嵌 JSON 与本地 git。本工作区即该仓库克隆（HEAD=2bd14aef），代码级结论均核对本地文件。无来源者标注“未找到可靠来源”。

## A. Electron 安全基线

**A1 官方清单 vs 实测。** Electron 官方 Checklist 要求禁用 `nodeIntegration`、启用 `contextIsolation`，并把 “Enable process sandboxing” 单列第 4 条（[Security](https://www.electronjs.org/docs/latest/tutorial/security)）。实测 [main.js](app/gui-js/main.js) 第 6–8 行以 `appendSwitch('no-sandbox')`、`'disable-setuid-sandbox'`、`'disable-gpu-sandbox'` 全局关沙箱；第 118 行 `contextIsolation: true, nodeIntegration: false` 是正确的；[index.html](app/gui-js/index.html) 有 CSP 但 `connect-src 'self' https: http:` 允许任意外联。官方对 `--no-sandbox` 的原话：“will disable the sandbox for **all** processes … never in production”（[Sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox)）。

**A2 CVE 与绕过史。** CVE-2026-70601 / GHSA-h7rp-cf8h-j98x（2026-08-05，CVSS 7.5 HIGH）“Context isolation bypass via Function.prototype.bind hijack”，关键句：“**In renderers without a sandbox, or with nodeIntegration enabled, this may escalate to Node.js access**”，修复于 39.8.9/40.9.2/41.2.2/42.0.0-beta.5（[GHSA](https://github.com/electron/electron/security/advisories/GHSA-h7rp-cf8h-j98x)、[CVE](https://opencve.stars-end.org/cve/CVE-2026-70601)）。GHSA-ff2p-hmqr-hxm4 是 contextBridge 对象复制不校验 prototype setter，可对 preload 做原型污染（[公告](https://github.com/electron/electron/security/advisories/GHSA-ff2p-hmqr-hxm4)）；2026-08-29 又新增两个 High，如“sandboxed document 打开的新窗口不继承沙箱限制”（[advisories](https://github.com/electron/electron/security/advisories)）。**关键**：[package.json](app/gui-js/package.json) 锁 `electron: ^28.0.0`，而 28 已于 **2024-06-10 EOL**，当前稳定版 44.4.5（[endoflife.date](https://endoflife.date/electron)）——28 的最后一个补丁也远低于上述所有修复版本。另见 HackTricks 记录的 preload 共享内建对象 RCE 链条（[链接](https://hacktricks.wiki/en/network-services-pentesting/pentesting-web/electron-desktop-apps/electron-contextisolation-rce-via-preload-code.html)）。

**A3 关沙箱的风险面。** 渲染进程一旦被注入（恶意网页、Markdown 渲染、被污染的模型输出或依赖），无沙箱即**不必逃逸**就能以用户身份读写文件、任意外联；本项目最短链路是注入后 `fetch('http://127.0.0.1:12306/...')`（CSP `connect-src http:` 允许）→ 命中无鉴权代理 → 用用户自己的 Key 转发。

**A4 本地服务被恶意页面访问。** WICG 的 PNA 说明书写得很直白：CORS 防不住，因为攻击只用安全列表内的方法/头，**不触发预检**，“the request itself is the CSRF attack”，并点名 loopback 服务“often assumes protections that simply don't exist”（[PNA explainer](https://github.com/WICG/private-network-access/blob/master/explainer.md)、[Chrome 已要求预检](https://developer.chrome.com/blog/private-network-access-preflight)）。DNS rebinding 用“域名先指向攻击者、再重绑定到 127.0.0.1”绕过同源策略，服务端缓解是 **Host 头校验**（Jackson et al., CCS'07，[Stanford](https://crypto.stanford.edu/dns/)）；OWASP 通用缓解为 token/双提交 Cookie（[Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)）。实测 [router.js](app/gui-js/lib/proxy/router.js)：仅 `express.json()` + 日志，**无鉴权、无 Origin/Host 校验、无 CORS 白名单、无限流**；[forwarder.js](app/gui-js/lib/proxy/forwarder.js) 的 `resolveApiKey` 是“**代理配置的 key 优先**”。即用户一旦填了 Key，**任何能访问 127.0.0.1:12306 的进程或页面无需凭据即可消费其额度**；`/v1/models` 还接受 `X-Target-Base-Url` 转发到任意 base_url（受限 SSRF）；`proxy.host` 可改成 `0.0.0.0`，等于把带 Key 的转发器暴露给局域网。

**A5 Key 存储。** 现状为 `js-yaml` 明文读写 `%APPDATA%/ContextGate/config.yaml`（main.js 48–66 行；[config.yaml.example](config.yaml.example)）。Electron `safeStorage` 在 Windows 走 DPAPI `CryptProtectData`，官方明说边界：“protected from other users on the same machine, **but not from other apps running in the same userspace**”（[safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)）。**keytar 已归档**：`atom/node-keytar` 显示 “archived by the owner on Dec 15, 2022. It is now read-only.”（1,425 stars，[链接](https://github.com/atom/node-keytar)），不应再选。取舍：明文 < safeStorage/DPAPI < Windows 凭据管理器；而 DPAPI 挡不住同用户恶意进程——这正是沙箱关闭后的主威胁模型。

## B. 桌面 AI 工具产品体验基线

**B1 LM Studio / Ollama。** LM Studio 暴露 `/v1/models`、`/v1/chat/completions`、`/v1/responses` 等 OpenAI 兼容端点，官方示例直接把 base URL 换成 `http://localhost:1234/v1`（[OpenAI 兼容](https://lmstudio.ai/docs/app/api/endpoints/openai)）；离线文档称装上模型后“you should be good to go **entirely offline**”（[Offline](https://lmstudio.ai/docs/app/offline)）；自 0.4.0 起支持 **API Token 鉴权**（默认关闭、可在 Server Settings 按权限签发，[Authentication](https://lmstudio.ai/docs/developer/core/authentication)）。Ollama 默认“binds **127.0.0.1:11434**”，用 `OLLAMA_HOST` 改绑定，并提供 `OLLAMA_NO_CLOUD` 隐私开关（[FAQ](https://docs.ollama.com/faq)）。**对标：**同类产品普遍有“默认绑定说明 + 可选鉴权 + 隐私开关”，ContextGate 三项全无。

**B2 用量与成本可见性。** Claude Code 提供 `/usage`、`/cost`，团队侧以 OpenTelemetry 导出（[Manage costs](https://docs.claude.com/en/docs/claude-code/costs)）；Cursor 有账号级 Usage 页（[Usage](https://docs.cursor.com/en/account/usage)）。第三方工具很热：`ccusage` **18,764 stars / 851 forks**（[repo](https://github.com/ryoppippi/ccusage)），`Sniffly` **1,272 stars / 118 forks**，MIT，卖点是 usage stats 与**可分享**（[chiphuyen/sniffly](https://github.com/chiphuyen/sniffly)）。ContextGate 已有 TokenMonitor + sql.js 用量库 + 预算阈值，但**未见** OTel/CSV/分享导出。

**B3 常见差评点（对照实测）。** 体积：Setup **144.2MB**、便携版 76.7MB（GitHub 资产与本地 `dist/` 一致）。更新：代码中**无** autoUpdater/electron-updater 引用、无 `publish` 配置 → 无更新通道，且 Release 停在 5.2.9 而代码已 5.5.0。崩溃上报与隐私说明均缺失。

**B4 未签名 exe 与 SmartScreen。** 微软文档称 SmartScreen 会检查“downloaded programs and **the digital signature used to sign a file**”，且“**If there's no reputation, the item is marked as a higher risk and presents a warning to the user**”（[SmartScreen](https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/)）。实测本地 6 个 exe `Get-AuthenticodeSignature` **全部 `NotSigned`**；`package.json` 的 `win` 段有 `signAndEditExecutable` 与时间戳服务器但**无证书配置**，故产物必然未签名。叠加全部 Release 资产**累计下载仅 31 次**，首次安装几乎必然出现“Windows 已保护你的电脑”。

## C. 项目现状核实

仓库**可访问**（API 200、页面 200）：https://github.com/2048lr/ContextGate ，描述 “AI Context Management & Proxy System”，MIT，默认分支 `main`。

| 项目 | 核实结果 |
|---|---|
| Star / Fork / Watcher | **1 / 0 / 0**（页面 JSON：`stargazerCount:1`、`forksCount:0`、`watcherCount:0`） |
| 最新 Release | **v5.2.9，2026-05-27**；共 20 个 Release，全部资产累计下载 **31 次** |
| Release 质量 | v5.2.9 说明仅“修复了部分bug，并喝了一杯红茶。”；资产文件名仍是 `ContextGate.5.2.8.exe` |
| 发布脱节 | tag 已到 **v5.5.0**、`package.json`=5.5.0，但 v5.4.0/v5.5.0 **无 Release** |
| Issues | `totalCount: 0`，页面显示 “**Issue creation is restricted in this repository**” |
| CI | **无**。本地无 `.github`；提交 `bb55d47f` 为“ci: 删除过时的GitHub Actions构建工作流”；有 3 个 node:test 文件但无自动执行 |
| 贡献者 | 事实上的单人项目：76 次提交**全部**来自 `liurun637@gmail.com`；首提交 2026-03-30 |
| 仓库卫生 | 用量库 **`contextgate.db` 已被 git 追踪并公开**（`git ls-files` 确认） |

## 按严重度排序的风险清单

**Critical**
1. **全局关沙箱 + 用 EOL 且低于所有修复版本的 Electron。** 证据：main.js:6-8、`electron ^28`、28 于 2024-06-10 EOL、CVE-2026-70601 修复版本 ≥39.8.9。影响：渲染进程被注入即可以用户身份读写文件、外联、盗刷 Key，**无需沙箱逃逸**。修复：删除三行开关（GPU 问题只关 GPU 项）、升级到受支持大版本、显式 `sandbox: true`。
2. **本地代理无鉴权且自动注入服务端 Key。** 证据：router.js 无鉴权/Origin 校验/CORS/限流，resolveApiKey 优先用代理 Key，`proxy.host` 可改 `0.0.0.0`；PNA 指出 loopback 服务误以为“天然安全”。影响：本机任意进程或恶意页面静默盗刷额度、窃取对话与 Key。修复：本地虚拟 key（对标 [LM Studio API Token](https://lmstudio.ai/docs/developer/core/authentication)）、校验 Origin/Host、锁死回环、限制 `X-Target-Base-Url`、加限流。

**High**
3. **API Key 明文存于 config.yaml。** 证据：main.js 48–66 行 js-yaml 明文读写。影响：同机任意进程、备份/同步盘、共用电脑即可拿到全部 Key。修复：safeStorage（DPAPI）或 Windows 凭据管理器（**不要** keytar，2022 已归档）。
4. **无 CI、无 Issue 渠道、单人维护、发布脱节。** 证据：无 `.github`；`bb55d47f` 删除 CI；Issues=0 且禁止创建；76 次提交同一邮箱；tag v5.5.0 无 Release。影响：补丁无法验证、漏洞无处上报。修复：恢复最小 CI、开放 Issues 或 `SECURITY.md`、按 tag 发布一致版本。

**Medium**
5. **无自动更新、依赖不升级。** 证据：无 autoUpdater/electron-updater、无 `publish`、Electron 停 ^28。影响：用户长期停留含已知高危漏洞的版本。修复：接入 electron-updater + 分阶段通道。
6. **未签名 + 零声誉 → SmartScreen 拦截。** 证据：6 个 exe 全 `NotSigned`、无证书配置、微软“无声誉即告警”、累计下载 31 次。影响：安装转化率极低、企业无法分发。修复：购 OV/EV 证书签名并累积声誉、走误报申诉。（本项目具体误报数据：**未找到可靠来源**。）
7. **TLS 校验开关与过宽 CSP。** 证据：forwarder.js 14/58 行在 `tls.reject_unauthorized === false` 时启用 `insecureHttpsAgent`；CSP `connect-src 'self' https: http:`。影响：Key 与对话可被截获、注入后可任意外联。修复：移除该开关或强提示、收紧 `connect-src` 白名单。

**Low**
8. **公开仓库提交了 `contextgate.db`**（`git ls-files` 与 GitHub 根目录均可见），用量样本进入公开仓库。修复：`git rm --cached` 并加 `.gitignore`。
9. **缺隐私说明、漏洞披露政策与崩溃上报**（README 未声明数据流向、无 `SECURITY.md`），抬高企业采购与信任门槛。

### 未取得可靠来源
1. OWASP DNS Rebinding 专页（404）；2. electron-builder 自动更新文档（404）；3. 具体杀软误报案例数据；4. LM Studio/Ollama 本体许可证与遥测的官方声明（故未作断言）。
