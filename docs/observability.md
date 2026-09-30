# 可观测与导出（FIX-17）

ContextGate 提供三层可观测性，全部围绕**本机、脱敏、零额外依赖**设计：

| 层 | 入口 | 用途 |
|----|------|------|
| 聚合统计 | `GET /stats` | 缓存/预算/降级/大请求闸门的进程内快照 |
| Prometheus 指标 | `GET /metrics` | 接入 Grafana / Prometheus / 任意采集器 |
| 请求级日志 | `GET /requests`、`GET /requests/export` | 回溯单条请求（已脱敏），导出 CSV/JSON |

所有端点都与其他代理 API 一样**要求本地令牌**，并且默认只监听回环地址。

## Prometheus

```bash
curl -H "Authorization: Bearer <local_token>" http://127.0.0.1:12306/metrics
```

`prometheus.yml`：

```yaml
scrape_configs:
  - job_name: contextgate
    scheme: http
    metrics_path: /metrics
    authorization:
      credentials: <local_token>
    static_configs:
      - targets: ['127.0.0.1:12306']
```

主要指标（前缀 `contextgate_`）：

| 指标 | 类型 | 含义 |
|------|------|------|
| `build_info` | gauge | 版本 / Node / 平台（标签） |
| `uptime_seconds` | gauge | 进程运行时长 |
| `requests_total` / `requests_today` | counter/gauge | 请求数 |
| `tokens_total` / `tokens_today` | counter/gauge | token 数 |
| `cost_usd_total` / `cost_usd_today` | counter/gauge | 费用（美元） |
| `saved_usd_total` | counter | 响应缓存 + Prompt Caching 省下的金额 |
| `provider_*_total{provider=...}` | counter | 按 provider 拆分 |
| `cache_hits_total` / `cache_entries` / `cache_hit_ratio` | counter/gauge | 响应缓存 |
| `cache_read_tokens_total` / `cache_write_tokens_total` | counter | Prompt Caching token |
| `prompt_cache_*` | counter/gauge | Prompt Caching 命中率与前缀稳定性 |
| `budget_limit_usd{level=...}` / `budget_spent_usd` / `budget_ratio` / `budget_enforced` | gauge | 预算状态 |
| `large_body_*` | gauge/counter | 大请求闸门（阈值、在途、排队、拒绝数） |
| `unknown_pricing_requests_total` | counter | 价格目录未命中（**不会被静默记为 0**） |

指标内容由 `observability.metrics` 控制；`enabled: false` 时端点返回 404。

## 请求日志与导出

请求日志只保存**可回溯的元数据**：provider、模型、路径、状态码、耗时、token、费用与
**已脱敏且截断**的消息预览。它**不保存**完整 prompt、回答、请求头或 API Key
（脱敏规则见 `lib/monitor/request-log.js`）。

后端可选：

```yaml
monitor:
  request_log:
    enabled: true
    format: sqlite   # 默认；可通过 GET /requests 分页查询，并提供内置导出
    # format: jsonl  # 一行一条 JSON，便于 filebeat/fluent-bit 或 tail 采集
    file: requests.jsonl
    retention_days: 30
```

导出：

```bash
# HTTP（受令牌保护）
curl -H "Authorization: Bearer <local_token>" \
  'http://127.0.0.1:12306/requests/export?format=csv' -o requests.csv
curl -H "Authorization: Bearer <local_token>" \
  'http://127.0.0.1:12306/requests/export?format=json&limit=1000' -o requests.json
```

GUI：**设置 → 监控 → 可观测与导出** 提供「请求日志 CSV / JSON」按钮。

## 接入 Langfuse / Helicone

这两个平台扮演的是「可观测后端」而不是「本地代理」，推荐两种接法：

1. **把 ContextGate 当作它们前面的本地网关**：先让 ContextGate 代理到真实 provider，
   再把 ContextGate 的 `<provider>.base_url` 指向 Helicone 的网关地址。这样 Helicone 收到的是
   已经过 ContextGate 计费与缓存处理的请求。
2. **直接消费 ContextGate 的导出**：把 `requests.jsonl` 交给采集器，或定时拉取
   `/requests/export?format=json` 后写入 Langfuse 的 ingestion API。导出里已包含 provider、
   模型、token（含缓存读/写）、费用与耗时，足够还原成本看板。

无论哪种接法，都请先确认对方的数据留存与合规策略——ContextGate 本身不会把数据发往任何第三方。

## 隐私边界

- 指标与日志都在本机生成，不产生任何出网请求。
- 导出内容不含 prompt/回答/密钥；`messagePreview` 最长 80 字符且已脱敏。
- `retention_days` 到期后明细会被清理，聚合数据保留。
