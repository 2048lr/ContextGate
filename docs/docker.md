# 无头（Docker）部署（FIX-18）

桌面版是 ContextGate 的默认形态，但代理本身是纯 Node 进程：`cli.js serve` 不依赖
Electron，因此可以直接跑在没有图形会话的 Linux 容器里（CI、NAS、家庭服务器、K8s）。

## 快速开始

```bash
# 1) 准备配置：复制示例并按需填写 provider / 限额
cp config.yaml.example config.yaml

# 2) 构建镜像（仓库根目录）
docker build -t contextgate:latest .

# 3) 运行：把项目只读挂载进来，Key 用环境变量提供，上下文产物写到容器内 /tmp
docker run --rm -p 127.0.0.1:12306:12306 \
  -v "$PWD/config.yaml:/config/config.yaml:ro" \
  -v "$PWD:/workspace:ro" \
  -e OPENAI_API_KEY=sk-... \
  contextgate:latest
```

或者用 `docker-compose.yml`：

```bash
PROJECT_DIR=/path/to/your/project OPENAI_API_KEY=sk-... docker compose up --build
```

## 为什么用 `-o /tmp/full_context.txt`

容器默认把项目挂载为**只读**。命令行支持把上下文产物写到项目目录之外：

```bash
node cli.js serve /workspace --host 0.0.0.0 --port 12306 \
  -c /config/config.yaml -o /tmp/full_context.txt
```

镜像的默认 CMD 已经这么做了。若你希望产物落在项目目录里，去掉 `-o` 并把挂载改成可写即可。

## 数据目录

统计库、持久化缓存与请求日志写在 `CONTEXTGATE_DATA_DIR`（镜像默认 `/data`），
与只读的项目目录解耦；`docker-compose.yml` 用命名卷 `contextgate-data` 持久化它。
因此即使 `/workspace` 与 `/config` 都是只读挂载，`/metrics`、`/requests` 与
`/requests/export` 依然可用。

## 访问与鉴权

- 代理默认监听 `0.0.0.0:12306`（容器内），但只把端口映射到宿主机回环 `127.0.0.1`。
- 首次启动会生成 `proxy.local_token`。由于 `/config/config.yaml` 是只读挂载，令牌无法写回；
  请在宿主机的 `config.yaml` 里预先填好 `proxy.local_token`，或在容器内挂载一个可写的数据目录。
- Host 头校验默认开启：从宿主机通过 `localhost:12306` 访问没问题；如果用容器 IP / 其它主机名访问，
  需要把该主机名加入 `proxy.auth.allowed_hosts`，否则会被 403。
- 所有请求都要带令牌（`X-ContextGate-Token` 或 `Authorization: Bearer`），只有 `/health` 豁免。

## 健康检查

镜像内置：

```dockerfile
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:12306/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
```

## 安全边界

- 镜像以非 root 用户 `node` 运行。
- 只安装运行时依赖（`npm ci --omit=dev`），不打包 Electron，体积远小于桌面产物。
- 不会因为「本地服务」就默认安全：令牌鉴权、Host 校验、Origin 校验与桌面版一致。
- 若绑定到 `0.0.0.0`，同一网络中的任何设备都能尝试访问；请配合令牌与网络策略使用。
