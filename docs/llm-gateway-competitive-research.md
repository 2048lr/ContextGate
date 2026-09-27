# LLM Gateway / API 代理能力现状调研（对比基准：ContextGate）

> 调研方法说明：本次调研仅能使用 `web_search` 检索（沙箱内 `web_fetch` 全部失败——本机 DNS 将所有域名解析到 `198.18.0.67`，属保留网段，被工具判定为「非公网 IP」而拒绝）。因此**每条结论均附检索得到的可点击来源**；凡标题/文档路径未直接证实的数值与功能，均标注「未找到可靠来源」或「未能核实」。star 数来自第三方 star 统计站点，为**快照值**，非实时。

## 一、能力对比总表

| 产品 | 定位 / star 或定价 | 协议兼容 | 缓存 | 流式/重试/限流 | 密钥与多租户 | 成本与预算 | 可观测性 | 部署 | 扩展性 |
|---|---|---|---|---|---|---|---|---|---|
| **LiteLLM Proxy** | 开源统一网关，约 57.3k stars（[star-history](https://www.star-history.com:2087/berriai/litellm/)） | OpenAI SDK 兼容；原生 `/v1/messages`、`/v1/responses` 透传（[官方文档](https://docs.litellm.ai/docs/anthropic_unified/native_passthrough)） | 内存 / Redis / S3 / GCS / 磁盘 / **Redis 与 Qdrant 语义缓存**（[文档](https://docs.litellm.ai/docs/proxy/caching)） | Router 回退与重试、超时、RPM/TPM（[架构文档](https://docs.litellm.ai/docs/proxy/architecture)） | 虚拟 key、团队/用户、预算与限流（[文档](https://docs.litellm.ai/docs/proxy/users)） | max_budget 按 key/团队/用户，成熟 | Prometheus（[源码](https://github.com/BerriAI/litellm/blob/540d8295b7516ce4add4935d715c07d337032726/litellm/integrations/prometheus.py)）、OTel（[base14](http://docs.base14.io/instrument/component/collecting-litellm-telemetry/)） | Docker / K8s / 自托管 | callbacks、路由策略丰富 |
| **Portkey Gateway** | 开源网关 + 商业控制面，13k stars（[star-history](https://www.star-history.com/portkey-ai/gateway/)）；企业版定价页（[Portkey Pricing](https://portkey.ai/pricing)） | 统一 API；提供 Messages API（[Universal API](https://portkey.ai/docs/product/ai-gateway/universal-api)、[Messages](https://portkey-docs.mintlify.dev/docs/product/ai-gateway/messages-api)） | 文档有缓存与守卫能力说明，具体缓存后端未在本次检索中证实 | 重试/回退/负载均衡为官方卖点（[repo 描述](https://github.com/Portkey-AI/gateway)） | 虚拟 key、工作区隔离（[功能对比](https://portkey.ai/docs/product/product-feature-comparison)） | 成本面板与预算告警，成熟 | Docker / 自托管 / 云 | 插件式 guardrails、路由配置 |
| **Helicone** | 开源可观测 + 网关，约 5.8k stars（[ToolScout](https://toolscout.ai/repo/helicone-helicone)），MIT（[来源](https://theneuralbase.com/helicone/learn/beginner/open-source-mit/)） | 代理层兼容 OpenAI；另有独立 AI Gateway（[repo](https://raw.githubusercontent.com/Helicone/ai-gateway/main/README.md)） | 响应缓存 / LLM 缓存（[文档](https://docs.helicone.ai/features/advanced-usage/caching)、[缓存页](https://mintlify.wiki/helicone/helicone/features/caching)） | 自定义速率限制（[文档](https://docs.helicone.ai/features/advanced-usage/custom-rate-limits)、[Rate Limiting](https://mintlify.wiki/helicone/helicone/features/rate-limiting)） | 按 user/custom property 打标与限额 | 成本追踪与节省分析（[来源](https://theneuralbase.com/helicone/learn/intermediate/cost-savings/)、[功能文](https://www.helicone.ai/blog/essential-helicone-features)） | HQL 查询、请求级日志（[文档](https://docs.helicone.ai/features/hql)） | Docker 自托管（[文档](https://docs.helicone.ai/getting-started/self-host/docker)） | 回调/ETL 导出（[ETL](https://docs.helicone.ai/guides/cookbooks/etl)） |
| **OpenRouter** | 商业托管路由服务（**非开源**），按量计费 + BYOK（[Pricing](https://openrouter.ai/pricing)、[BYOK](https://openrouter.ai/docs/guides/overview/auth/byok)） | OpenAI 兼容单一入口，聚合数百模型（[官网描述](https://futureagi.com/blog/what-is-openrouter-2026/)） | 缓存能力：**未找到可靠来源** | 提供商路由与自动回退属核心卖点；具体退避参数未证实 | 平台侧 key 管理；虚拟 key 非其定位 | 用量与花费面板（[Pricing](https://openrouter.ai/pricing)） | 面板级，OTel 导出未证实 | 纯 SaaS | 路由偏好配置为主，无自托管中间件 |
| **Cloudflare AI Gateway** | 商业 SaaS，随 Cloudflare 套餐（[产品页](https://www.cloudflare.com/products/ai-gateway/)） | 统一 LLM API，可由 Workers 调用（[文档](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)） | 官方能力清单含 caching（[features](https://raw.githubusercontent.com/cloudflare/cloudflare-docs/refs/heads/production/src/content/docs/ai-gateway/features/index.mdx)、[llms-full](https://developers.cloudflare.com/ai-gateway/llms-full.txt)） | 官方能力清单含 rate limiting 与 model fallback（同上）；退避细节未证实 | 靠 Cloudflare 账号/Token 体系，虚拟 key 非其强项 | 分析面板与成本视图（同上） | 分析/日志为主，原生 OTel 出口未证实 | 纯 SaaS（边缘） | 通过 Workers 代码扩展，非插件市场 |
| **Kong AI Gateway** | 商业网关 + 开源插件，Kong 本体 44k stars（[star-history](https://www.star-history.com:2087/kong/kong/)） | AI Proxy 插件支持多提供商（[插件生态](https://developer.konghq.com/plugins/)） | **AI Semantic Cache 插件**，官方与 Redis 集成（[插件 changelog](https://developer.konghq.com/plugins/ai-semantic-cache/changelog.md)、[Redis 博客](https://redis.io/blog/kong-ai-gateway-and-redis/)） | 限流/重试为 Kong 成熟网关能力；语义负载均衡有专文（[文档](https://kongdeveloper.netlify.app/ai-gateway/v1/how-to/use-semantic-load-balancing/)） | 消费者/凭证/团队体系成熟 | 成本优化 cookbook（[文档](https://kongdeveloper.netlify.app/cookbooks/llm-cost-optimization/)） | Kong 生态日志/指标插件齐全 | Docker / K8s / 混合 | 插件体系（最强项之一） |
| **Apache APISIX AI Gateway** | 开源网关 + 商业 AISIX，APISIX 17.1k stars（[star-history](https://www.star-history.com:2096/apache/apisix/)）、[AISIX 定价](https://api7.ai/ja/ai-gateway/pricing) | `ai-proxy` 插件统一转换（[插件文档](https://apisix.incubator.apache.org/docs/apisix/3.18/plugins/ai-proxy/)） | 缓存依赖 APISIX 通用插件，AI 语义缓存未在检索中证实 | 限流/重试属网关通用能力；`ai-proxy-multi` 做多上游分发（[文档](https://apisix.incubator.apache.org/zh/docs/apisix/plugins/ai-proxy-multi/)） | 消费者/Key 体系成熟，按 key 限流 | 成本能力弱于 Kong（未证实预算告警） | Prometheus 等通用插件 | Docker / K8s | 插件生态 + 多语言插件 |
| **Bifrost (Maxim AI)** | Go 编写「企业级 AI 网关」，宣称比 LiteLLM 快 50x / 40x，官方称 8k★ 量级（[repo](https://github.com/maximhq/bifrost)、[官方博客](https://www.getmaxim.ai/blog/bifrost-a-drop-in-llm-proxy-40x-faster-than-litellm/)、[skillsllm 8k★](https://skillsllm.com/skill/bifrost)） | 标榜 drop-in LLM proxy、1000+ 模型；`/v1/messages` 与 `/v1/responses` 互转有代码痕迹（[Go schema 文档](https://pkg.go.dev/github.com/maximhq/bifrost/core@v1.5.22/schemas)） | 未在检索中证实体缓存后端 | 自适应负载均衡、集群模式（[repo 描述](https://github.com/supervise-dev/bifrost)） | 虚拟 key/预算/限流见官方文档目录（[docs](https://docs.getbifrost.ai/overview)），细节未证实 | 企业版含治理能力（[changelog](https://docs.getbifrost.ai/changelogs/ent-v1.5.7)） | 未证实 | 单二进制 / 容器（[Red Hat Catalog](https://catalog.redhat.com/en/software/containers/maximhq/bifrost/6a0ab72cd9e5ea214b127692)、[Railway](https://railway.com/deploy/bifrost-gateway-go)） | MCP 与插件（官方文档） |
| **Langfuse** | 开源 LLM 可观测平台，34k stars（[star-history](https://www.star-history.com:2096/langfuse/langfuse/)），自托管定价页（[Pricing](https://langfuse.com/pricing)） | **不做代理**；通过网关集成接入（[Kong 集成](https://langfuse.com/integrations/gateways/kong-ai-plugin)） | 无缓存（非其定位） | 无转发（非其定位） | 项目/组织隔离、API key | 成本追踪 + 自定义模型价格（[changelog](https://langfuse.com/changelog/2024-01-29-custom-model-prices)） | tracing/eval，OTel 可接（行业通用，本次未取到单一官方页，标注**未完全证实**） | Docker Compose / K8s / 云 | SDK + 集成生态 |
| **LangSmith** | 商业 LLMOps/可观测（LangChain），免费档 + 约 $39/人/月起（[官方定价](https://www.langchain.com/pricing)、[costbench](https://costbench.com/software/ai-observability/langsmith/)） | 不做代理 | 无 | 无 | 工作区/席位 | 用量与计费（[文档](https://docs.langchain.com/langsmith/usage-and-billing)） | tracing/eval 深度强 | SaaS / 自托管企业版 | SDK 生态 |
| **one-api** | 中文生态「OpenAI 接口管理与分发」，36.8k stars（[star-history](https://www.star-history.com:2096/songquanpeng/one-api/)） | 统一适配 OpenAI/Azure/Claude/Gemini/DeepSeek/豆包/通义等（[README](https://github.com/songquanpeng/one-api/blob/main/README.md)、[实读来源](https://model-context-protocol.com/clients/one-api)） | 未证实有缓存 | 渠道重试/禁用；流式用量统计未证实 | 令牌（token）分组、额度、渠道管理成熟 | 按额度扣费，预算告警未证实 | 日志页；OTel 未证实 | 单二进制 / Docker | 渠道抽象 + 自定义渠道 |
| **new-api** | one-api 生态演进版，「新一代大模型网关与 AI 资产管理系统」，官方文称 48,699★、v1.0.0-rc.40（[来源](https://aiproducthub.cn/s/57655.html)） | 同上，兼容多格式（[README](https://github.com/QuantumNous/new-api/blob/8c8661d0/README.fr.md?plain=1)） | 未证实 | 渠道优先级/重试；限流属通用能力 | 多租户、令牌、分组更完善 | 计费/额度 | 日志与统计页 | 单二进制 / Docker | 渠道与插件扩展 |
| **uni-api** | Python「统一 LLM API 管理」，多后端转 OpenAI 格式并支持负载均衡（[repo](https://github.com/yym68686/uni-api)）；早期作者自述「200+ star」（[LINUX DO](https://linux.do/t/topic/193688)） | 后端含 OpenAI/Anthropic/Gemini/Vertex/OpenRouter 等，**统一转 OpenAI 格式**（同上） | 未证实 | 负载均衡为核心功能；超时属 ASGI 层（README 描述） | **弱**：无成熟虚拟 key/多租户（未找到） | 未证实 | 未证实 | 单进程 Python | YAML 配置驱动 |

## 二、各产品要点

**LiteLLM**：能力最全的开源对标物。它同时覆盖 OpenAI 兼容与 Anthropic 原生 `/v1/messages`、`/v1/responses` 透传，缓存后端从内存/Redis/S3/GCS 一直到 Redis 与 Qdrant 语义缓存，预算治理落在虚拟 key、团队、用户三级，指标可走 Prometheus 与 OTel。需要注意其 Anthropic 端点仍有已知一致性问题（如 proxy 级 `async_pre_call_hook` 在 `/v1/messages` 上被绕过、`metadata.user_id` 映射问题），见 [issue #27518](https://github.com/BerriAI/litellm/issues/27518)、[issue #37508](https://github.com/BerriAI/litellm/issues/37508)——这说明「多协议全兼容」在工程上代价很高。

**Portkey**：定位「快且带 guardrails 的网关」，repo 描述称路由 1,600+ LLM、50+ guardrails；文档提供 Universal API 与独立 Messages API，另有基础版/生产版/企业版功能对比与专页定价。

**Helicone**：以「一行代码接入的可观测」起家，缓存与自定义限流是付费/进阶功能，MIT 开源可 Docker 自托管，另有独立的 Helicone AI Gateway（Rust）作为代理层。

**OpenRouter**：托管路由集市，靠 API 调用抽成 + BYOK 模式收费（[Pricing](https://openrouter.ai/pricing)）。它不是可自托管网关，缓存、OTel 等企业能力公开资料不足。

**Cloudflare AI Gateway**：SaaS 边缘方案，官方能力清单明确列出 analytics、caching、rate limiting、model fallback；无自托管，不适合纯本地场景。

**Kong AI Gateway**：企业网关路线，AI Semantic Cache 插件 + Redis 是最明确的「语义缓存」商业实现，另有语义负载均衡与成本优化 cookbook；插件生态是最大优势。

**Apache APISIX**：`ai-proxy` / `ai-proxy-multi` 提供多上游统一转换与分发，依托 APISIX 通用限流与可观测插件；AI 专属的语义缓存与预算告警弱于 Kong。

**Bifrost**：性能叙事最强（50x/40x 于 LiteLLM、<100 µs 开销 @5k RPS），Go 单二进制/容器部署，面向企业版做治理与可观测；但本次检索拿到的证据多为官方营销描述，缓存后端与 OTel 细节未证实。

**Langfuse / LangSmith**：二者**不是网关**，而是可观测与评测层，通过网关（如 Kong 插件）或 SDK 接入，成本追踪与自定义价格是其核心，因此与 ContextGate 是互补而非替代关系。

**中文生态**：one-api / new-api 是「API 聚合分发」的绝对主流，以渠道、令牌、额度、多租户计费为核心，规模远大于同类英文开源网关；uni-api 更轻量、YAML 驱动、侧重统一格式与负载均衡，但虚拟 key/多租户与可观测明显缺位。

## 三、对小型桌面网关的启示

**用户实际最看重的 6 项能力（按重要性排序）**

1. **多上游协议兼容与故障切换**：至少 OpenAI 兼容 + Anthropic `/v1/messages`，且上游挂掉能自动 fallback。这是所有商业网关的第一卖点（[Kong](https://developer.konghq.com/plugins/)、[Portkey](https://github.com/Portkey-AI/gateway)、[LiteLLM 架构](https://docs.litellm.ai/docs/proxy/architecture)）。
2. **请求级可观测与成本/用量归属**：按 key、用户、团队、自定义属性归属花费，Helicone 的整套产品几乎就建立在这件事上（[成本分析](https://theneuralbase.com/helicone/learn/intermediate/cost-savings/)）。
3. **预算与配额硬约束（含告警）**：不是「统计」，而是「到额即拒」。LiteLLM 的 [Budgets, Rate Limits](https://docs.litellm.ai/docs/proxy/users) 是社区最常引用的实现。
4. **缓存与成本节省**：精确缓存是及格线，**语义缓存**已成高端能力（Kong [AI Semantic Cache](https://developer.konghq.com/plugins/ai-semantic-cache/changelog.md)、LiteLLM [Qdrant 语义缓存](https://docs.litellm.ai/docs/proxy/caching)）；缓存命中率必须可见。
5. **流式（SSE）下的正确计量**：流式转发还要能准确算 token 与费用，这是自研网关最常出错的地方。
6. **标准可观测出口**：Prometheus / OTel / 日志导出，[LiteLLM 的 Prometheus 集成](https://github.com/BerriAI/litellm/blob/540d8295b7516ce4add4935d715c07d337032726/litellm/integrations/prometheus.py)与 [OTel 监控方案](http://docs.base14.io/instrument/component/collecting-litellm-telemetry/)说明企业采购会直接检查这一项。

**ContextGate 这类单机桌面软件难以满足的**

- **真正的多租户隔离与审计**：虚拟 key、团队/项目配额、审计日志需要集中式控制面与持久化用户体系；单机 sql.js（浏览器内嵌 SQLite）在并发写入与多用户场景上是结构性短板。
- **语义缓存**：需要向量库/嵌入模型与稳定的常驻服务，桌面端内存与冷启动都不友好。
- **集群与高可用**：Bifrost 主打「cluster mode / 自适应负载均衡」（[repo 描述](https://github.com/supervise-dev/bifrost)），单机进程天然缺失。
- **标准化遥测生态**：企业要对接既有 Prometheus/Grafana/OTel 后端，桌面 App 往往没有稳定指标端点。
- **可编程扩展**：Kong/APISIX 靠插件市场，LiteLLM 靠 callbacks，桌面软件通常只能改代码。

**行业基线（2025–2026）**：一个自称 LLM 网关的产品，若缺少以下任一项，会被专业用户直接判为「不合格」——① OpenAI 兼容 `/v1/chat/completions` **且** Anthropic `/v1/messages`（新近再加 `/v1/responses`）；② 上游失败自动 fallback/重试与超时控制；③ 流式（SSE）转发 + 流式下准确的 token/费用计量；④ 按 key/用户的预算与限流硬约束；⑤ 可导出的指标或日志（Prometheus / OTel / webhook）；⑥ 至少精确匹配缓存与命中率统计。**语义缓存、多租户审计、K8s 集群部署**则是 2025–2026 年从「合格」走向「企业级」的分水岭。ContextGate 当前「本地代理 + 缓存 + 费用统计 + 预算 + 托盘 UI + full_context.txt 注入」的组合，恰好压在前四项基线之内，缺口集中在 ② 故障切换、④ 配额硬约束、⑤ 标准遥测出口，以及多租户与语义缓存。
