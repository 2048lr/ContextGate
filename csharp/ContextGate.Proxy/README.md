# ContextGate.Proxy - AI 代理服务器

ASP.NET Core 实现的 AI 请求代理服务器，支持多提供商、缓存、流式响应和上下文管理。

## 功能特性

### 核心功能
- ✅ **多提供商支持** - OpenAI、DeepSeek、智谱 AI
- ✅ **LRU 缓存** - 自动缓存相同请求，提升响应速度
- ✅ **流式响应** - 支持 Server-Sent Events (SSE) 流式输出
- ✅ **上下文签名** - 自动检测上下文文件变更并清除缓存
- ✅ **Token 监控** - 记录所有请求的 Token 使用和成本
- ✅ **请求转发** - 透明代理 OpenAI 兼容 API

### API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/context` | GET | 获取当前上下文内容 |
| `/context/hash` | GET | 获取上下文哈希信息 |
| `/stats` | GET | 获取代理统计信息 |
| `/cache` | DELETE | 清除所有缓存 |
| `/v1/{path}` | POST | OpenAI 兼容 API 代理 |
| `/proxy/chat` | POST | 简化的聊天接口 |

## 快速开始

### 1. 配置文件

编辑 `config.yaml`：

```yaml
providers:
  openai:
    api_key: sk-your-api-key
    base_url: https://api.openai.com/v1
    models:
      - gpt-4
      - gpt-3.5-turbo

proxy:
  host: 127.0.0.1
  port: 12306
```

### 2. 启动服务器

**Windows:**
```bash
start-proxy.bat
```

**手动启动:**
```bash
cd csharp
dotnet run --project ContextGate.Proxy
```

### 3. 测试请求

**健康检查:**
```bash
curl http://localhost:12306/health
```

**聊天请求:**
```bash
curl -X POST http://localhost:12306/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

**流式请求:**
```bash
curl -X POST http://localhost:12306/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

**查看统计:**
```bash
curl http://localhost:12306/stats
```

## 架构设计

### 项目结构

```
ContextGate.Proxy/
├── Controllers/
│   └── ProxyController.cs      # API 控制器
├── Program.cs                   # 应用入口
├── appsettings.json            # 配置文件
└── ContextGate.Proxy.csproj    # 项目文件

ContextGate.Core/
├── Models/                      # 数据模型
│   ├── ChatRequest.cs
│   ├── ChatResponse.cs
│   ├── ContextSignature.cs
│   └── ...
└── Services/                    # 核心服务
    ├── ProxyService.cs          # 代理服务
    ├── LruCache.cs              # LRU 缓存
    ├── ContextSignatureService.cs
    ├── ConfigManager.cs
    └── TokenMonitor.cs
```

### 核心服务

#### ProxyService
- 请求转发与响应处理
- 缓存管理（LRU 策略）
- 流式响应支持
- Token 使用记录

#### ContextSignatureService
- 计算上下文文件哈希
- 检测文件变更
- 自动触发缓存清除

#### LruCache
- 泛型 LRU 缓存实现
- 线程安全
- 自动淘汰最久未使用项

## 缓存机制

### 缓存键生成
```
{method}:{path}:{contextHash}:{bodyHash}
```

- **method** - HTTP 方法（POST）
- **path** - 请求路径
- **contextHash** - 上下文文件哈希（前 8 位）
- **bodyHash** - 请求体 MD5（前 12 位）

### 缓存失效
- 上下文文件内容变更
- 上下文引用的源文件变更
- 手动调用 `DELETE /cache`

## 配置说明

### appsettings.json

```json
{
  "Proxy": {
    "Host": "127.0.0.1",
    "Port": "12306"
  },
  "ConfigPath": "config.yaml",
  "ContextFile": "context.md",
  "ProjectRoot": null,
  "DatabasePath": "contextgate.db"
}
```

### config.yaml

参考 `config.yaml.example`

## 开发指南

### 编译项目

```bash
cd csharp
dotnet build ContextGate.Proxy
```

### 运行测试

```bash
dotnet test ContextGate.Tests
```

### 添加新提供商

1. 在 `config.yaml` 添加提供商配置
2. 在 `ProxyService.DetectProvider()` 添加检测逻辑
3. 确保提供商 API 兼容 OpenAI 格式

## 性能优化

- **LRU 缓存** - 默认容量 100，可根据内存调整
- **连接复用** - HttpClient 单例模式
- **异步 I/O** - 全异步请求处理
- **流式传输** - 减少内存占用

## 故障排查

### 端口被占用
```bash
# 修改 appsettings.json 中的 Port 配置
"Port": "12307"
```

### 缓存未生效
- 检查上下文文件是否频繁变更
- 查看日志中的 `[Cache HIT]` 和 `[Cache SET]` 消息

### 请求转发失败
- 验证 `config.yaml` 中的 API 密钥
- 检查 `base_url` 是否正确
- 查看日志中的错误详情

## 与 JavaScript 版本对比

| 特性 | JavaScript (Express) | C# (ASP.NET Core) |
|------|---------------------|-------------------|
| 性能 | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| 类型安全 | ❌ | ✅ |
| 异步模型 | Callback/Promise | async/await |
| 缓存实现 | Map | LruCache<TKey, TValue> |
| 依赖注入 | ❌ | ✅ |
| 跨平台 | ✅ | ✅ |

## 下一步计划

- [ ] 添加单元测试
- [ ] 实现请求限流
- [ ] 支持自定义缓存策略
- [ ] 添加 Prometheus 指标导出
- [ ] 实现请求重试机制
- [ ] 支持多个上下文文件

## 许可证

与 ContextGate 主项目相同
